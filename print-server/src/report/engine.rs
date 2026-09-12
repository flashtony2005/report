//! 报表展开引擎：主格树构建 -> 递归展开 -> 层次坐标求值 -> 行布局
//!
//! 对应 NopReport 的 `engine/expand/*` + `ExpandedSheetGenerator` + `coordinate/*`，
//! 关键机制保持一致：
//! 1. 子格实例创建后向其**所有行祖格**逐级注册后代（跨层小计的基础）
//! 2. 展开与求值分离：先 expand_value，再 value_expr
//! 3. 层次坐标 `D3[B3:+0]` 中 `:+0` 表示「当前组」，不可省略（省略会解析为空集）

use crate::report::model::*;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

pub struct Engine {
    insts: Vec<CellInst>,
    ds: DataSet,
    /// 已创建实例按位置名索引
    by_pos: BTreeMap<String, Vec<usize>>,
    roots: Vec<usize>,
}

impl Engine {
    pub fn new(ds: DataSet) -> Self {
        Engine { insts: Vec::new(), ds, by_pos: BTreeMap::new(), roots: Vec::new() }
    }

    /// 展开一个 sheet，返回输出网格
    pub fn expand_sheet(&mut self, sheet: &SheetTpl) -> Vec<Vec<GridCell>> {
        self.insts.clear();
        self.by_pos.clear();
        self.roots.clear();

        let all_rows: Vec<usize> = (0..self.ds.len()).collect();

        // ---- 阶段 1：按模板顺序（行升序、列升序）展开，父格必然先于子格 ----
        for (r, row) in sheet.rows.iter().enumerate() {
            for (c, cell) in row.cells.iter().enumerate() {
                // 纯占位空单元格（既无值也无模型）不参与展开，否则会多出空行
                if cell.value.is_none() && cell.model.is_none() {
                    continue;
                }
                let pos = cell.pos.clone().unwrap_or_else(|| cell_pos(r, c));
                let model = cell.model.clone().unwrap_or_default();

                // 行主格实例列表（无 row_parent 时视为挂在根上）
                let row_parents: Vec<Option<usize>> = match &model.row_parent {
                    Some(p) => match self.by_pos.get(p) {
                        Some(list) => list.iter().map(|i| Some(*i)).collect(),
                        None => Vec::new(),
                    },
                    None => vec![None],
                };
                // 列主格实例列表：与行主格做笛卡尔积，取数视图取两者交集（交叉表的本质）
                let col_parents: Vec<Option<usize>> = match &model.col_parent {
                    Some(p) => match self.by_pos.get(p) {
                        Some(list) => list.iter().map(|i| Some(*i)).collect(),
                        None => Vec::new(),
                    },
                    None => vec![None],
                };

                for parent in &row_parents {
                    for col_parent in &col_parents {
                        let mut view = match parent {
                            Some(p) => self.insts[*p].rows.clone(),
                            None => all_rows.clone(),
                        };
                        if let Some(cp) = col_parent {
                            let cv = self.insts[*cp].rows.clone();
                            view.retain(|r| cv.contains(r));
                        }
                        let created = self.make_insts(&pos, r, c, *parent, *col_parent, &view, cell, &model);
                        for (idx, inst_idx) in created.iter().enumerate() {
                            self.insts[*inst_idx].expand_index = idx;
                        }
                        if created.is_empty() {
                            continue;
                        }
                        for inst_idx in created.iter() {
                            self.register_descendants(*inst_idx);
                            match parent {
                                Some(p) => self.insts[*p].children.push(*inst_idx),
                                None => self.roots.push(*inst_idx),
                            }
                            if let Some(cp) = col_parent {
                                self.insts[*cp].col_children.push(*inst_idx);
                            }
                        }
                        self.by_pos.entry(pos.clone()).or_default().extend(created);
                    }
                }
            }
        }

        // ---- 阶段 2：求值（聚合 -> 层次坐标，后者此时可用）----
        let n = self.insts.len();
        for i in 0..n {
            // 交叉表数值格：对本实例覆盖的全部数据行做聚合
            if let Some(agg) = self.insts[i].agg {
                if let Some(v) = self.aggregate(i, agg) {
                    self.insts[i].value = v;
                    continue;
                }
            }
            let expr = match self.insts[i].value_expr.clone() {
                Some(e) => e,
                None => continue,
            };
            let v = self.eval_expr(&expr, i);
            self.insts[i].value = v;
        }

        // ---- 阶段 3：布局（行）----
        let roots = self.roots.clone();
        let total_rows = self.layout_group(&roots, 0).max(1);

        // ---- 阶段 3.5：布局（列）：列主格树递归分列 ----
        let n = self.insts.len();
        let total_cols = self.layout_columns(n);

        // ---- 阶段 4：填充网格 ----
        let ncols = total_cols.max(1);
        let mut grid: Vec<Vec<Option<GridCell>>> = vec![vec![None; ncols]; total_rows];
        for inst in self.insts.iter() {
            if inst.row_start >= total_rows || inst.col_start >= ncols {
                continue;
            }
            let (text, num) = display(inst.value.clone());
            // 合并规则：横向 = max(列子树跨度, merge_across+1) 或「铺到行尾」；
            // 纵向 = max(行子树跨度, merge_down+1)
            let colspan = if inst.merge_to_end {
                ncols.saturating_sub(inst.col_start).max(1)
            } else {
                (inst.col_span.max(1)).max(inst.merge_across + 1)
            };
            grid[inst.row_start][inst.col_start] = Some(GridCell {
                text,
                pos: inst.pos.clone(),
                rowspan: inst.row_span.max(1).max(inst.merge_down + 1),
                colspan,
                raw_number: num,
            });
        }

        grid.into_iter()
            .map(|row| row.into_iter().map(|c| c.unwrap_or_else(empty_cell)).collect())
            .collect()
    }

    /// 对本实例覆盖的数据行按字段聚合（交叉表数值格的核心）
    fn aggregate(&self, idx: usize, agg: AggType) -> Option<JsonValue> {
        let field = self.insts[idx].field.clone()?;
        // 交集为空（如「华东 × 广州」没有数据）→ 留空，不要显示成 0
        if self.insts[idx].rows.is_empty() {
            return Some(JsonValue::Null);
        }
        let nums: Vec<f64> = self.insts[idx]
            .rows
            .iter()
            .filter_map(|r| self.ds.get(*r))
            .filter_map(|row| row.get(&field))
            .filter_map(|v| as_number(v.clone()))
            .collect();
        Some(match agg {
            AggType::Sum => JsonValue::from(nums.iter().sum::<f64>()),
            AggType::Count => JsonValue::from(self.insts[idx].rows.len() as i64),
            AggType::Avg if !nums.is_empty() => {
                JsonValue::from(nums.iter().sum::<f64>() / nums.len() as f64)
            }
            AggType::Min if !nums.is_empty() => {
                JsonValue::from(nums.iter().cloned().fold(f64::INFINITY, f64::min))
            }
            AggType::Max if !nums.is_empty() => {
                JsonValue::from(nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
            }
            _ => JsonValue::Null,
        })
    }

    /// 为一个单元格模板在某个父实例下创建实例
    fn make_insts(
        &mut self,
        pos: &str,
        tpl_row: usize,
        tpl_col: usize,
        parent: Option<usize>,
        col_parent: Option<usize>,
        view: &[usize],
        cell: &CellTpl,
        model: &CellModel,
    ) -> Vec<usize> {
        let mut out = Vec::new();

        // 行展开与列展开都是「按字段分组去重」，区别只在布局方向
        if model.is_row_expand() || model.is_col_expand() {
            let groups: Vec<(JsonValue, Vec<usize>)> = match &model.field {
                Some(f) => group_by_field(&self.ds, view, f),
                None => view.iter().map(|r| (JsonValue::Null, vec![*r])).collect(),
            };
            for (gval, rows) in groups {
                let mut inst = CellInst::new(pos.to_string(), tpl_row, tpl_col, parent, out.len());
                inst.rows = rows;
                inst.field = model.field.clone();
                inst.agg = model.agg;
                inst.expand_value = gval.clone();
                inst.value = if gval.is_null() { cell.value.clone().unwrap_or(JsonValue::Null) } else { gval };
                inst.merge_across = cell.merge_across;
                inst.merge_down = cell.merge_down;
                inst.merge_to_end = cell.merge_to_end;
                inst.value_expr = model.value_expr.clone();
                inst.col_parent = col_parent;
                inst.col_after = model.col_after.clone();
                inst.col_expand = model.is_col_expand();
                out.push(self.insts.len());
                self.insts.push(inst);
            }
        } else {
            let mut inst = CellInst::new(pos.to_string(), tpl_row, tpl_col, parent, 0);
            inst.rows = view.to_vec();
            inst.field = model.field.clone();
            inst.agg = model.agg;
            inst.merge_across = cell.merge_across;
            inst.merge_down = cell.merge_down;
            inst.merge_to_end = cell.merge_to_end;
            inst.value = match &model.field {
                Some(f) => view.first().and_then(|r| self.ds.get(*r)).and_then(|row| row.get(f)).cloned().unwrap_or(JsonValue::Null),
                None => cell.value.clone().unwrap_or(JsonValue::Null),
            };
            inst.expand_value = inst.value.clone();
            inst.value_expr = model.value_expr.clone();
            inst.col_parent = col_parent;
            inst.col_after = model.col_after.clone();
            out.push(self.insts.len());
            self.insts.push(inst);
        }
        out
    }

    /// 向所有行祖格逐级注册后代（跨层行小计的前提）
    ///
    /// 同时向所有**列祖格**注册（col_parent 链），这是「列合计 / 交叉表列向小计」的前提：
    /// 值单元格既属于某个行分组，也属于某个列分组，只有两条链都登记，
    /// `B3[B2:+0].sum()` 这类横向层次坐标才能取到该列下的全部值。
    fn register_descendants(&mut self, idx: usize) {
        let pos = self.insts[idx].pos.clone();
        let mut p = self.insts[idx].parent;
        while let Some(pi) = p {
            self.insts[pi].descendants.entry(pos.clone()).or_default().push(idx);
            p = self.insts[pi].parent;
        }
        let mut cp = self.insts[idx].col_parent;
        while let Some(ci) = cp {
            self.insts[ci].descendants.entry(pos.clone()).or_default().push(idx);
            cp = self.insts[ci].col_parent;
        }
    }

    /// 递归布局：返回该实例子树占用的物理行数
    fn place(&mut self, idx: usize, offset: usize) -> usize {
        self.insts[idx].row_start = offset;
        let children = self.insts[idx].children.clone();
        if children.is_empty() {
            self.insts[idx].row_span = 1;
            return 1;
        }
        let used = self.layout_group(&children, offset).max(1);
        self.insts[idx].row_span = used;
        used
    }

    /// 布局一组实例：
    /// - 不同模板行 → 顺序占行
    /// - 同一模板行内，不同列 → **共享**同一段行（小计行的 B4 与 D4 必须同行）
    /// - 同一模板行同一列 → 顺序占行（B3 展开出的 上海 / 杭州 / 南京）
    fn layout_group(&mut self, items: &[usize], offset: usize) -> usize {
        let mut row_groups: Vec<(usize, Vec<usize>)> = Vec::new();
        for c in items {
            let tr = self.insts[*c].tpl_row;
            match row_groups.last_mut() {
                Some((last, list)) if *last == tr => list.push(*c),
                _ => row_groups.push((tr, vec![*c])),
            }
        }

        let mut cursor = offset;
        for (_tr, list) in row_groups {
            let mut col_groups: Vec<(usize, Vec<usize>)> = Vec::new();
            for c in list {
                let tc = self.insts[c].tpl_col;
                match col_groups.last_mut() {
                    Some((last, g)) if *last == tc => g.push(c),
                    _ => col_groups.push((tc, vec![c])),
                }
            }
            let mut row_used = 0usize;
            for (_tc, group) in col_groups {
                // 列向展开的兄弟格（或挂在列主格下的交叉值）必须落在同一行，只占 1 行
                let share_row = group.len() > 1
                    && (self.insts[group[0]].col_expand || self.insts[group[0]].col_parent.is_some());
                if share_row {
                    for c in &group {
                        self.place(*c, cursor);
                    }
                    row_used = row_used.max(1);
                } else {
                    let mut inner = cursor;
                    for c in group {
                        let n = self.place(c, inner);
                        inner += n;
                    }
                    row_used = row_used.max(inner - cursor);
                }
            }
            cursor += row_used;
        }
        (cursor - offset).max(1)
    }

    /// 列向布局：以 col_parent 为边递归分列，返回总列数
    ///
    /// - 无 col_parent 的实例：直接落在模板列上；其中列展开格按展开顺序依次占列
    /// - 有 col_parent 的实例：落在主格的列区间内，按 (tpl_row, 行主格) 分组顺序排
    /// - 不同 (tpl_row, 行主格) 的分组共享同一段列（交叉表的多个数值列并排）
    /// - 声明了 `col_after` 的单元格：列号不能写死，统一延后到第二遍，
    ///   落在目标格所占列区间之后（如「行合计」紧跟在最后一个月之后）
    fn layout_columns(&mut self, n: usize) -> usize {
        let mut max_col = 0usize;
        // 根实例：按 pos 稳定分组（同一 pos 的实例在创建时必然连续）
        let roots: Vec<usize> = (0..n).filter(|i| self.insts[*i].col_parent.is_none()).collect();
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut idx = 0usize;
        while idx < roots.len() {
            let pos = self.insts[roots[idx]].pos.clone();
            let mut group = Vec::new();
            while idx < roots.len() && self.insts[roots[idx]].pos == pos {
                group.push(roots[idx]);
                idx += 1;
            }
            groups.push(group);
        }

        let mut deferred: Vec<Vec<usize>> = Vec::new();
        for group in groups {
            if self.insts[group[0]].col_after.is_some() {
                deferred.push(group);
                continue;
            }
            // 列展开格：从模板列起依次占列；其余直接落模板列
            let mut cursor = self.insts[group[0]].tpl_col;
            let col_expand = self.insts[group[0]].col_expand;
            for g in &group {
                self.insts[*g].col_start = cursor;
                self.assign_col(*g);
                let span = self.insts[*g].col_span.max(1);
                max_col = max_col.max(cursor + span);
                if col_expand {
                    cursor += span;
                }
            }
        }

        // 第二遍：col_after。目标格此时已定列，取其列区间末尾作为起点
        for group in deferred {
            let target = self.insts[group[0]].col_after.clone().unwrap_or_default();
            let mut after = self.insts[group[0]].tpl_col;
            for i in 0..n {
                if self.insts[i].pos == target {
                    after = after.max(self.insts[i].col_start + self.insts[i].col_span.max(1));
                }
            }
            for g in &group {
                self.insts[*g].col_start = after;
                self.assign_col(*g);
                let span = self.insts[*g].col_span.max(1);
                max_col = max_col.max(after + span);
            }
        }
        max_col
    }

    /// 递归给子树分配列：子实例按 (tpl_row, 行主格) 分组，组内顺序占列，组间共享
    fn assign_col(&mut self, idx: usize) {
        let kids = self.insts[idx].col_children.clone();
        if kids.is_empty() {
            self.insts[idx].col_span = self.insts[idx].col_span.max(1);
            return;
        }
        // 按 (tpl_row, 行主格) 稳定分组：跨行分支的同列单元格必须落在同一列
        let mut keys: Vec<(usize, Option<usize>)> = Vec::new();
        let mut groups: Vec<Vec<usize>> = Vec::new();
        for k in kids {
            let key = (self.insts[k].tpl_row, self.insts[k].parent);
            match keys.iter().position(|x| *x == key) {
                Some(p) => groups[p].push(k),
                None => {
                    keys.push(key);
                    groups.push(vec![k]);
                }
            }
        }
        let start = self.insts[idx].col_start;
        let mut span = 1usize;
        for group in groups {
            let mut inner = start;
            for k in group {
                self.insts[k].col_start = inner;
                self.assign_col(k);
                inner += self.insts[k].col_span.max(1);
            }
            span = span.max(inner - start);
        }
        self.insts[idx].col_span = span;
    }

    // ---------------- 层次坐标求值 ----------------

    fn eval_expr(&self, expr: &str, cur: usize) -> JsonValue {
        let expr = expr.trim();
        // 形式： POS | POS[COORD] | POS[COORD].func() | POS.func()
        let cut = expr.find('[').or_else(|| expr.find('.')).unwrap_or(expr.len());
        let (head, after) = expr.split_at(cut);
        let target = head.trim().to_string();
        let after = after.trim();

        let mut coords: Option<Coord> = None;
        let mut func = "value";
        if let Some(s) = after.strip_prefix('[') {
            if let Some(end) = s.find(']') {
                let inner = s[..end].trim();
                if !inner.is_empty() {
                    coords = Some(Coord::parse(inner));
                }
                let tail = s[end + 1..].trim().trim_start_matches('.');
                func = func_of(tail);
            }
        } else if let Some(s) = after.strip_prefix('.') {
            func = func_of(s);
        }

        let tail_func = func;

        let cells = self.resolve(&target, coords.as_ref(), cur);
        let nums: Vec<f64> = cells
            .iter()
            .filter_map(|i| as_number(self.insts[*i].value.clone()))
            .collect();

        match tail_func {
            "sum" => JsonValue::from(nums.iter().sum::<f64>()),
            "count" => JsonValue::from(nums.len() as i64),
            "avg" if !nums.is_empty() => JsonValue::from(nums.iter().sum::<f64>() / nums.len() as f64),
            "min" => nums.iter().cloned().fold(f64::NAN, f64::min).into(),
            "max" => nums.iter().cloned().fold(f64::NAN, f64::max).into(),
            _ => cells.first().map(|i| self.insts[*i].value.clone()).unwrap_or(JsonValue::Null),
        }
    }

    fn resolve(&self, target: &str, coord: Option<&Coord>, cur: usize) -> Vec<usize> {
        match coord {
            None => self.by_pos.get(target).cloned().unwrap_or_default(),
            Some(cd) => {
                // 沿父链找到最近的 coord 主格实例：先走行主格链，再走列主格链
                let mut anc: Option<usize> = None;
                let mut p = self.insts[cur].parent;
                while let Some(pi) = p {
                    if self.insts[pi].pos == cd.pos {
                        anc = Some(pi);
                        break;
                    }
                    p = self.insts[pi].parent;
                }
                if anc.is_none() {
                    let mut cp = self.insts[cur].col_parent;
                    while let Some(ci) = cp {
                        if self.insts[ci].pos == cd.pos {
                            anc = Some(ci);
                            break;
                        }
                        cp = self.insts[ci].col_parent;
                    }
                }
                let anchor = match anc {
                    Some(a) => a,
                    None => return Vec::new(),
                };
                if let Some(pos_n) = cd.position {
                    if !cd.relative {
                        // 绝对第 n 个：从该主格的父实例里取同级列表
                        let parent = self.insts[anchor].parent;
                        let siblings: Vec<usize> = match parent {
                            Some(pp) => self.insts[pp].descendants.get(&cd.pos).cloned().unwrap_or_default(),
                            None => self.by_pos.get(&cd.pos).cloned().unwrap_or_default(),
                        };
                        let i = (pos_n - 1) as usize;
                        return match siblings.get(i) {
                            Some(s) => self.insts[*s].descendants.get(target).cloned().unwrap_or_default(),
                            None => Vec::new(),
                        };
                    }
                    if cd.reverse {
                        // 相对偏移：:+0 / :-1
                        let parent = self.insts[anchor].parent;
                        let siblings: Vec<usize> = match parent {
                            Some(pp) => self.insts[pp].descendants.get(&cd.pos).cloned().unwrap_or_default(),
                            None => self.by_pos.get(&cd.pos).cloned().unwrap_or_default(),
                        };
                        let idx = self.insts[anchor].expand_index as i64 + pos_n as i64;
                        return if idx >= 0 {
                            match siblings.get(idx as usize) {
                                Some(s) => self.insts[*s].descendants.get(target).cloned().unwrap_or_default(),
                                None => Vec::new(),
                            }
                        } else {
                            Vec::new()
                        };
                    }
                }
                // 默认（含 :+0）取当前主格的后代
                self.insts[anchor].descendants.get(target).cloned().unwrap_or_default()
            }
        }
    }
}

#[derive(Debug)]
struct Coord {
    pos: String,
    position: Option<i64>,
    relative: bool,
    reverse: bool,
}

impl Coord {
    /// 解析 `B3` / `B3:1` / `B3:+0` / `B3:-1`
    fn parse(s: &str) -> Self {
        let mut parts = s.splitn(2, ':');
        let pos = parts.next().unwrap_or("").trim().to_string();
        let mut c = Coord { pos, position: None, relative: false, reverse: false };
        if let Some(p) = parts.next() {
            let p = p.trim();
            let (rel, body) = if let Some(rest) = p.strip_prefix('+') {
                (true, rest)
            } else {
                (false, p)
            };
            if let Ok(n) = body.parse::<i64>() {
                c.position = Some(n);
                c.relative = rel || n < 0;
                c.reverse = n < 0;
            }
        }
        c
    }
}

/// 从 `.sum()` 这类尾部取出函数名
fn func_of(s: &str) -> &'static str {
    let name: String = s.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    match name.as_str() {
        "sum" => "sum",
        "count" => "count",
        "avg" => "avg",
        "min" => "min",
        "max" => "max",
        _ => "value",
    }
}

/// 按字段分组（保持首次出现顺序，等价于 SQL group by 的分组展开）
fn group_by_field(ds: &DataSet, view: &[usize], field: &str) -> Vec<(JsonValue, Vec<usize>)> {
    let mut out: Vec<(String, JsonValue, Vec<usize>)> = Vec::new();
    for r in view {
        let val = ds.get(*r).and_then(|row| row.get(field)).cloned().unwrap_or(JsonValue::Null);
        let key = match &val {
            JsonValue::Null => "\u{0}null".to_string(),
            JsonValue::String(s) => format!("s:{s}"),
            other => format!("v:{other}"),
        };
        match out.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, _, rows)) => rows.push(*r),
            None => out.push((key, val, vec![*r])),
        }
    }
    out.into_iter().map(|(_, v, rows)| (v, rows)).collect()
}

fn as_number(v: JsonValue) -> Option<f64> {
    match v {
        JsonValue::Number(n) => n.as_f64(),
        JsonValue::String(s) => s.replace(',', "").parse::<f64>().ok(),
        _ => None,
    }
}

fn display(v: JsonValue) -> (String, Option<f64>) {
    match &v {
        JsonValue::Null => (String::new(), None),
        JsonValue::String(s) => (s.clone(), None),
        JsonValue::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            (format_number(f), Some(f))
        }
        JsonValue::Bool(b) => (b.to_string(), None),
        other => (other.to_string(), None),
    }
}

fn format_number(f: f64) -> String {
    if (f.fract()).abs() < 1e-9 {
        let i = f.round() as i64;
        let s = i.to_string();
        with_sep(&s)
    } else {
        format!("{:.*}", 2, f)
    }
}

fn with_sep(s: &str) -> String {
    let neg = s.starts_with('-');
    let body = if neg { &s[1..] } else { s };
    let mut out = String::new();
    for (i, ch) in body.chars().enumerate() {
        if i > 0 && (body.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if neg { format!("-{out}") } else { out }
}

fn empty_cell() -> GridCell {
    GridCell { text: String::new(), pos: String::new(), rowspan: 1, colspan: 1, raw_number: None }
}
