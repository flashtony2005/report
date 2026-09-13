//! 报表展开引擎：主格树构建 -> 递归展开 -> 层次坐标求值 -> 行布局
//!
//! 对应 NopReport 的 `engine/expand/*` + `ExpandedSheetGenerator` + `coordinate/*`，
//! 关键机制保持一致：
//! 1. 子格实例创建后向其**所有行祖格**逐级注册后代（跨层小计的基础）
//! 2. 展开与求值分离：先 expand_value，再 value_expr
//! 3. 层次坐标 `D3[B3:+0]` 中 `:+0` 表示「当前组」，不可省略（省略会解析为空集）

use crate::report::expr::{self, BinOp, CmpOp, Coord, Expr, Prop};
use crate::report::model::*;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

/// 布局递归深度上限（防御异常模板导致的深递归）
const MAX_LAYOUT_DEPTH: usize = 256;

/// `A0` 是 NopReport 的 `CellPosition.NONE`——**显式**声明「没有父格」
fn is_root_ref(p: &str) -> bool {
    p.trim().eq_ignore_ascii_case("a0")
}

/// 模板里 (r, c) 处的格子
fn tpl_cell(sheet: &SheetTpl, r: usize, c: usize) -> Option<&CellTpl> {
    sheet.rows.get(r).and_then(|row| row.cells.get(c))
}

/// 格子的位置名：优先用显式 `pos`，否则按下标推
fn tpl_pos(cell: &CellTpl, r: usize, c: usize) -> String {
    cell.pos.clone().unwrap_or_else(|| cell_pos(r, c))
}

/// 父格声明的三态
///
/// 关键在 `ExplicitNone` 与 `Unset` 的区别：上游 `getRowParent` 开头就是
/// `if (rowParent == CellPosition.NONE) return null`——声明了 `A0` 就是明确不要父格，
/// **不再套用缺省推断**。（之前我们用一个 `filter(|p| !is_root_ref(p))` 把 `A0`
/// 当成「没写」，结果落进缺省推断，与注释和上游都不符。）
///
/// 这个三态同时也是「跟随」规则要读的东西：上游 `initParentChildren` 会把**推断结果
/// 回写**进 model（`if (xptModel.getRowParent() == null) setRowParent(...)`），
/// 所以后处理的格子往左扫时，读到的是左边格子**解析后**的父格（声明的或推断出来的），
/// 而不只是它显式声明的。
#[derive(Clone, Debug)]
enum ParentDecl {
    Ref(String),
    ExplicitNone,
    Unset,
}

/// 已解析出的父格，按 (row, col) 缓存——等价于上游回写进 model 的那份
type Resolved = BTreeMap<(usize, usize), ParentDecl>;

fn parse_parent(p: Option<&str>) -> ParentDecl {
    match p {
        None => ParentDecl::Unset,
        Some(s) if is_root_ref(s) => ParentDecl::ExplicitNone,
        Some(s) => ParentDecl::Ref(s.trim().to_string()),
    }
}

/// 缺省行父格（对齐 NopReport `XptModelInitializer.getRowParent`）
///
/// 三步，前一步命中就停：
///
/// 1. 向左扫到**纵向扩展格** → 它就是父格
/// 2. 扫到的格子不是扩展格、但它**已经有**父格 → 跟随到那个父格
///    （「有」指解析后的结果，含推断出来的——见 `ParentDecl` 的注释）
/// 3. 都扫不到 → 取本行**最左格**（col 0）的父格
///
/// 第 2 步的自引用保护照抄上游：跟随结果等于本格位置时返回「无父格」而不是自己。
/// 上游 `ExplicitNone`（A0）是「停并返回无父格」，不是继续往左扫。
///
/// 上游 `resolveRowParent` 对不存在的坐标直接抛异常；这里返回坐标字符串，
/// 由调用方统一告警（`expand_sheet` 里那条「声明的 row_parent 不存在」）。
fn default_row_parent(sheet: &SheetTpl, r: usize, c: usize, resolved: &Resolved) -> Option<String> {
    let own = tpl_cell(sheet, r, c)
        .map(|x| tpl_pos(x, r, c))
        .unwrap_or_else(|| cell_pos(r, c));
    if c == 0 {
        return None;
    }
    // 1 + 2：向左扫
    for cc in (0..c).rev() {
        let Some(cell) = tpl_cell(sheet, r, cc) else { continue };
        let Some(m) = cell.model.as_ref() else { continue };
        if m.is_row_expand() {
            return Some(tpl_pos(cell, r, cc));
        }
        match resolved.get(&(r, cc)) {
            Some(ParentDecl::Ref(p)) => {
                return if *p == own { None } else { Some(p.clone()) }
            }
            Some(ParentDecl::ExplicitNone) => return None,
            Some(ParentDecl::Unset) | None => continue,
        }
    }
    // 3：取本行最左格（上游 L277-285）
    match resolved.get(&(r, 0)) {
        Some(ParentDecl::Ref(p)) => Some(p.clone()).filter(|p| p != &own),
        _ => None,
    }
}

/// 缺省列父格（`getColParent` 的镜像）：向上扫 → 扫不到取**第一行**同列的父格
fn default_col_parent(sheet: &SheetTpl, r: usize, c: usize, resolved: &Resolved) -> Option<String> {
    let own = tpl_cell(sheet, r, c)
        .map(|x| tpl_pos(x, r, c))
        .unwrap_or_else(|| cell_pos(r, c));
    if r == 0 {
        return None;
    }
    for rr in (0..r).rev() {
        let Some(cell) = tpl_cell(sheet, rr, c) else { continue };
        let Some(m) = cell.model.as_ref() else { continue };
        if m.is_col_expand() {
            return Some(tpl_pos(cell, rr, c));
        }
        match resolved.get(&(rr, c)) {
            Some(ParentDecl::Ref(p)) => {
                return if *p == own { None } else { Some(p.clone()) }
            }
            Some(ParentDecl::ExplicitNone) => return None,
            Some(ParentDecl::Unset) | None => continue,
        }
    }
    // 扫不到 → 取第一行同列格子（上游 L327-335）
    match resolved.get(&(0, c)) {
        Some(ParentDecl::Ref(p)) => Some(p.clone()).filter(|p| p != &own),
        _ => None,
    }
}

/// 表达式求值结果
///
/// `Set` 是 NopReport 的设计精髓：层次坐标返回的是**格集**，由使用场景决定
/// 当集合遍历（`SUM(D3)`）还是取首格的值（参与四则运算 `C4 / C4[B4:-1]`）。
/// 这样就不必引入润乾那套区分「单值 / 集合」的 `{}` 语法。
#[derive(Debug, Clone)]
enum Val {
    Num(f64),
    Str(String),
    Bool(bool),
    Null,
    /// 层次坐标定位到的一组实例。
    ///
    /// `anchor` 是其中「对当前格可见」的那一个（同一主格下的兄弟格，或主格链上的祖格）。
    /// 折叠成标量时优先取它——这是 NopReport `getNamedCells` 的可见性语义：
    /// 写 `B2 / B2[A2:-1]` 时，裸 `B2` 必须是**当前行**的 B2，而不是全局第一个 B2。
    Set { cells: Vec<usize>, anchor: Option<usize> },
}

impl Val {
    fn from_json(v: JsonValue) -> Self {
        match v {
            JsonValue::Number(n) => Val::Num(n.as_f64().unwrap_or(f64::NAN)),
            JsonValue::String(s) => Val::Str(s),
            JsonValue::Bool(b) => Val::Bool(b),
            _ => Val::Null,
        }
    }

    /// 折叠成标量：格集优先取可见实例（anchor）的值，没有则退回首格
    /// （对齐 NopReport 的 ExpandedCellSet.getValue）
    fn scalar(self, e: &Engine) -> Val {
        match self {
            Val::Set { cells, anchor } => {
                let pick = anchor.filter(|a| cells.contains(a)).or_else(|| cells.first().copied());
                match pick {
                    Some(i) => Val::from_json(e.insts[i].value.clone()),
                    None => Val::Null,
                }
            }
            other => other,
        }
    }

    fn as_num(&self) -> Option<f64> {
        match self {
            Val::Num(n) => Some(*n),
            Val::Str(s) => s.trim().parse::<f64>().ok(),
            Val::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Val::Bool(b) => *b,
            Val::Num(n) => *n != 0.0,
            Val::Str(s) => !s.is_empty(),
            Val::Set { cells, .. } => !cells.is_empty(),
            Val::Null => false,
        }
    }

    /// 比较用的文本。非数值比较走这里：分组标签（"1月" / "华东"）之间比大小、
    /// 数字与数字字符串混比（100 与 "100"）都靠它统一口径。
    fn as_text(&self, e: &Engine) -> String {
        match self.clone().scalar(e) {
            Val::Num(n) => n.to_string(),
            Val::Str(s) => s,
            Val::Bool(b) => b.to_string(),
            Val::Null => String::new(),
            Val::Set { .. } => String::new(),
        }
    }

    /// 落到单元格前先折叠成标量
    fn into_json(self, e: &Engine) -> JsonValue {
        match self.scalar(e) {
            Val::Num(n) => JsonValue::from(n),
            Val::Str(s) => JsonValue::from(s),
            Val::Bool(b) => JsonValue::from(b),
            _ => JsonValue::Null,
        }
    }
}

pub struct Engine {
    insts: Vec<CellInst>,
    ds: DataSet,
    /// 已创建实例按位置名索引
    by_pos: BTreeMap<String, Vec<usize>>,
    roots: Vec<usize>,
    /// 布局递归当前深度（见 MAX_LAYOUT_DEPTH）
    layout_depth: usize,
    /// 可疑但不必中断渲染的情况（父格查不到、表达式解析失败等）
    ///
    /// 这些问题的共同点是**静默产出错误数据**：既不报错也不崩溃，只是结果悄悄变少或变空，
    /// 靠读输出很难发现。收集起来交给调用方，别让它们烂在渲染过程里。
    warnings: Vec<String>,
    /// 展示文本覆盖（与 insts 一一对应）：`formatExpr` / `dict` 的产出。
    /// None 表示没配，按既有 `display()` 口径出文本。
    fmt_text: Vec<Option<String>>,
}

impl Engine {
    pub fn new(ds: DataSet) -> Self {
        Engine {
            insts: Vec::new(),
            ds,
            by_pos: BTreeMap::new(),
            roots: Vec::new(),
            layout_depth: 0,
            warnings: Vec::new(),
            fmt_text: Vec::new(),
        }
    }

    /// 渲染过程中收集到的告警
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// 展开一个 sheet，返回输出网格
    pub fn expand_sheet(&mut self, sheet: &SheetTpl) -> Vec<Vec<GridCell>> {
        self.insts.clear();
        self.by_pos.clear();
        self.roots.clear();
        self.warnings.clear();
        self.layout_depth = 0;

        let all_rows: Vec<usize> = (0..self.ds.len()).collect();

        // 已解析出的父格，按 (row, col) 缓存。等价于上游把推断结果回写进 model；
        // 「向左扫到的相邻格有没有父格」要读它，而且必须是**解析后**的值。
        let mut resolved_row: Resolved = BTreeMap::new();
        let mut resolved_col: Resolved = BTreeMap::new();

        // ---- 阶段 1：按模板顺序（行升序、列升序）展开，父格必然先于子格 ----
        for (r, row) in sheet.rows.iter().enumerate() {
            for (c, cell) in row.cells.iter().enumerate() {
                // 纯占位空单元格（既无值也无模型）不参与展开，否则会多出空行
                if cell.value.is_none() && cell.model.is_none() {
                    continue;
                }
                let pos = cell.pos.clone().unwrap_or_else(|| cell_pos(r, c));
                let model = cell.model.clone().unwrap_or_default();

                // 未显式声明父格时，按 NopReport 的缺省规则推断：
                // 行父格向左查找最近的纵向扩展格，列父格向上查找最近的横向扩展格。
                // `A0`（ExplicitNone）是显式「无父格」，不再套用缺省推断
                let (row_ref, row_decl) = match parse_parent(model.row_parent.as_deref()) {
                    ParentDecl::Ref(p) => (Some(p.clone()), ParentDecl::Ref(p)),
                    ParentDecl::ExplicitNone => (None, ParentDecl::ExplicitNone),
                    ParentDecl::Unset => {
                        let p = default_row_parent(sheet, r, c, &resolved_row);
                        let d = match &p {
                            Some(p) => ParentDecl::Ref(p.clone()),
                            None => ParentDecl::Unset,
                        };
                        (p, d)
                    }
                };
                let (col_ref, col_decl) = match parse_parent(model.col_parent.as_deref()) {
                    ParentDecl::Ref(p) => (Some(p.clone()), ParentDecl::Ref(p)),
                    ParentDecl::ExplicitNone => (None, ParentDecl::ExplicitNone),
                    ParentDecl::Unset => {
                        let p = default_col_parent(sheet, r, c, &resolved_col);
                        let d = match &p {
                            Some(p) => ParentDecl::Ref(p.clone()),
                            None => ParentDecl::Unset,
                        };
                        (p, d)
                    }
                };
                resolved_row.insert((r, c), row_decl);
                resolved_col.insert((r, c), col_decl);

                // 行主格实例列表
                //
                // 注意：`by_pos` 只含**已创建**的实例，所以父格下标必然小于子格——
                // 主格树是按下标严格递减的 DAG，结构上不可能成环，无需环检测。
                // 声明了父格却查不到：一定是模板写错了（父格必须写在子格之前），
                // 退回挂根能保住数据不消失，但展开结果会静默变少，必须告警。
                let row_parents: Vec<Option<usize>> = match &row_ref {
                    Some(p) => match self.by_pos.get(p).cloned() {
                        Some(list) => list.iter().map(|i| Some(*i)).collect(),
                        None => {
                            self.warnings.push(format!(
                                "{pos} 声明的 row_parent \"{p}\" 不存在——父格必须先于子格创建，已退回挂根（该格不会跟随主格展开）"
                            ));
                            vec![None]
                        }
                    },
                    None => vec![None],
                };
                // 列主格实例列表：与行主格做笛卡尔积，取数视图取两者交集（交叉表的本质）
                let col_parents: Vec<Option<usize>> = match &col_ref {
                    Some(p) => match self.by_pos.get(p).cloned() {
                        Some(list) => list.iter().map(|i| Some(*i)).collect(),
                        None => {
                            self.warnings.push(format!(
                                "{pos} 声明的 col_parent \"{p}\" 不存在——父格必须先于子格创建，已退回挂根"
                            ));
                            vec![None]
                        }
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

        // ---- 阶段 2：求值 + 测试表达式（惰性 + 依赖传播，见 ensure_value 注释）----
        //
        // 早期实现是按实例下标 0..n 单遍扫描，问题在于 value_expr 引用另一个
        // value_expr 格时结果取决于创建顺序：被引用格下标更大就会读到 Null。
        // 改为 ensure_value 后，被引用格会先被递归求值到位。
        //
        // 求值必须和 row/col_test 一起迭代到稳定：测试可以引用聚合结果
        // （「小计为 0 的分组不显示」），而聚合又要跳过被测试删掉的格——
        // 两者互相依赖，单遍算完再删就会留下「明细里没有、合计里还在」的脏数。
        let n = self.insts.len();
        self.evaluate_to_fixpoint(n);

        // ---- 阶段 2.5：展示文本（第三值阶段 formatExpr > dict > NumFmt）----
        //
        // 必须在全部 value 求值之后：format_expr 里的 `value` 读的是本格的最终值，
        // 也可能用层次坐标引用别的格，那时坐标必须已经建好。
        let n = self.insts.len();
        self.fmt_text = vec![None; n];
        for i in 0..n {
            self.compute_display(i);
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
        for (i, inst) in self.insts.iter().enumerate() {
            if inst.dropped || inst.row_start >= total_rows || inst.col_start >= ncols {
                continue;
            }
            let (mut text, num) = display(inst.value.clone(), inst.format.as_ref());
            if let Some(Some(t)) = self.fmt_text.get(i) {
                text = t.clone();
            }
            // export_formula：翻得出来就带公式（xlsx 里可继续算），翻不出来回落写值
            let formula = if inst.export_formula { self.excel_formula(i) } else { None };
            if inst.export_formula && formula.is_none() {
                self.warnings.push(format!(
                    "{} 声明了 export_formula，但 value_expr 无法翻译成 Excel 公式，已回落写值",
                    inst.pos
                ));
            }
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
                num_format: inst.format.as_ref().and_then(excel_num_format),
                formula,
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
            let mut groups: Vec<(JsonValue, Vec<usize>)> = match &model.field {
                Some(f) => group_by_field(&self.ds, view, f),
                None => view.iter().map(|r| (JsonValue::Null, vec![*r])).collect(),
            };
            // 上限：只显示前 N 条
            if let Some(max) = model.expand_max_count {
                groups.truncate(max);
            }
            // 展开集为空时是否保留单元格（缺省删除，连带子格一起消失）
            if groups.is_empty() && model.keep_expand_empty.unwrap_or(false) {
                groups.push((JsonValue::Null, Vec::new()));
            }
            // 下限：补足到 N 条，用于「默认留 N 个空行」
            if let Some(min) = model.expand_min_count {
                while groups.len() < min {
                    groups.push((JsonValue::Null, Vec::new()));
                }
            }
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
                inst.format = model.format.clone();
                inst.value_expr = model.value_expr.clone();
                // 展示值与测试表达式：**展开格这条分支同样要拷**。
                // 只拷非展开分支的话，挂在分组格上的字典（编码 → 名称）会静默失效。
                inst.format_expr = model.format_expr.clone();
                inst.dict = model.dict.clone();
                inst.row_test_expr = model.row_test_expr.clone();
                inst.col_test_expr = model.col_test_expr.clone();
                inst.export_formula = model.export_formula.unwrap_or(false);
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
            inst.format = model.format.clone();
            inst.value = match &model.field {
                Some(f) => view.first().and_then(|r| self.ds.get(*r)).and_then(|row| row.get(f)).cloned().unwrap_or(JsonValue::Null),
                None => cell.value.clone().unwrap_or(JsonValue::Null),
            };
            inst.expand_value = inst.value.clone();
            inst.value_expr = model.value_expr.clone();
            inst.format_expr = model.format_expr.clone();
            inst.dict = model.dict.clone();
            inst.row_test_expr = model.row_test_expr.clone();
            inst.col_test_expr = model.col_test_expr.clone();
            inst.export_formula = model.export_formula.unwrap_or(false);
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

    /// rowTestExpr / colTestExpr：返回假则整行 / 整列删除。
    ///
    /// 解析失败按**保留**处理并告警——静默删行比多留一行危险得多：
    /// 前者是丢数据且无从察觉，后者只是排版难看。
    fn test_result(&mut self, i: usize, expr: &Option<String>, kind: &str, warn: bool) -> bool {
        let Some(e) = expr else { return true };
        match expr::parse(e) {
            Err(err) => {
                if warn {
                    let pos = self.insts[i].pos.clone();
                    self.warnings.push(format!("{pos} 的 {kind} 无法解析（{err}），已保留该格"));
                }
                true
            }
            // 求值发生在全部 value 之后，层次坐标此时已建好可用
            Ok(ast) => self.eval_ast(&ast, i, i).truthy(),
        }
    }

    /// `value_expr` → Excel 公式（`export_formula` 用）。
    ///
    /// 思路：表达式里的层次坐标在**布局之后**已经能落成具体的格，
    /// 于是把「求值」翻成「引用这些格」——`C2[A2:+0].sum()` 在 1 月组占 3 行时
    /// 就是 `SUM(C3:C5)`。这样导出后在 Excel 里改明细，小计 / 合计会跟着重算。
    ///
    /// 翻不出来返回 `None`（调用方回落写值并告警）。刻意不做「尽力翻译」：
    /// 半对不对的公式比静态值危险得多——它看起来能算，结果却是错的。
    /// 目前不翻的：`PROPORTION` / `ACCSUM` / `RANK` / `NVL`（Excel 无同名函数，
    /// 硬凑出来的等价式可读性极差）、`{}` 条件（格集过滤没有 Excel 对应物）、
    /// `$` 与 `value`（依赖求值上下文）。
    fn excel_formula(&self, i: usize) -> Option<String> {
        let src = self.insts[i].value_expr.as_deref()?;
        let ast = expr::parse(src).ok()?;
        self.excel_of(&ast, i)
    }

    fn excel_of(&self, e: &Expr, cur: usize) -> Option<String> {
        Some(match e {
            Expr::Num(n) => format!("{n}"),
            // 双引号要转义成两个，否则公式断掉
            Expr::Str(s) => format!("\"{}\"", s.replace('"', "\"\"")),
            Expr::Cell { target, coord, prop } => {
                let cells = self.resolve(target, coord.as_ref(), cur);
                if cells.is_empty() || cells.contains(&cur) {
                    return None; // 解析不到引用目标 / 自引用 → 不翻
                }
                let refs = self.excel_refs(&cells)?;
                match prop {
                    None => refs,
                    Some(Prop::Aggregate(f)) => match *f {
                        "sum" => format!("SUM({refs})"),
                        "count" => format!("COUNT({refs})"),
                        "avg" => format!("AVERAGE({refs})"),
                        "min" => format!("MIN({refs})"),
                        "max" => format!("MAX({refs})"),
                        _ => return None,
                    },
                    Some(Prop::ExpandIndex) => return None,
                }
            }
            Expr::Neg(inner) => format!("-({})", self.excel_of(inner, cur)?),
            Expr::Binary { op, lhs, rhs } => {
                let a = self.excel_of(lhs, cur)?;
                let b = self.excel_of(rhs, cur)?;
                let o = match op {
                    BinOp::Add => "+",
                    BinOp::Sub => "-",
                    BinOp::Mul => "*",
                    BinOp::Div => "/",
                };
                format!("({a}){o}({b})")
            }
            Expr::Cmp { op, lhs, rhs } => {
                let a = self.excel_of(lhs, cur)?;
                let b = self.excel_of(rhs, cur)?;
                let o = match op {
                    CmpOp::Gt => ">",
                    CmpOp::Ge => ">=",
                    CmpOp::Lt => "<",
                    CmpOp::Le => "<=",
                    CmpOp::Eq => "=",
                    CmpOp::Ne => "<>",
                };
                format!("({a}){o}({b})")
            }
            Expr::Call { name, args } => {
                let up = name.to_uppercase();
                if up != "IF" || args.len() != 3 {
                    return None;
                }
                let parts: Option<Vec<String>> =
                    args.iter().map(|a| self.excel_of(a, cur)).collect();
                let parts = parts?;
                format!("IF({},{},{})", parts[0], parts[1], parts[2])
            }
            Expr::SelfValue | Expr::Filter { .. } | Expr::Dollar(_) => return None,
        })
    }

    /// 一组实例 → Excel 引用。连续的同行 / 同列折叠成区间，否则逐个逗号列出
    fn excel_refs(&self, cells: &[usize]) -> Option<String> {
        let mut pts: Vec<(usize, usize)> = cells
            .iter()
            .map(|&i| (self.insts[i].row_start, self.insts[i].col_start))
            .collect();
        pts.sort_unstable();
        pts.dedup();
        if pts.is_empty() {
            return None;
        }
        let a = cell_pos(pts[0].0, pts[0].1);
        if pts.len() == 1 {
            return Some(a);
        }
        // 同列且行连续 → C3:C5；同行且列连续 → C3:E3；否则逐个列出
        let rows_consecutive = pts.windows(2).all(|w| w[1].0 == w[0].0 + 1);
        let cols_consecutive = pts.windows(2).all(|w| w[1].1 == w[0].1 + 1);
        if (pts.iter().all(|p| p.1 == pts[0].1) && rows_consecutive)
            || (pts.iter().all(|p| p.0 == pts[0].0) && cols_consecutive)
        {
            let last = pts[pts.len() - 1];
            return Some(format!("{a}:{}", cell_pos(last.0, last.1)));
        }
        Some(pts.iter().map(|p| cell_pos(p.0, p.1)).collect::<Vec<_>>().join(","))
    }

    /// 求值 ↔ 测试 迭代到稳定（或到达轮次上限）
    ///
    /// 每轮：先按当前 hidden 集合求值，再重算测试。测试翻翻转了就清空
    /// `evaluated` 重来一轮——因为上一轮的聚合里可能还含着刚被删掉的格。
    /// 轮次上限是防御性的：业务上「删掉→合计变小→又有新的格不达标」这种
    /// 级联通常一两轮就收敛，但不排除有人写了个会震荡的条件，不能让它转到底。
    fn evaluate_to_fixpoint(&mut self, n: usize) {
        const MAX_ROUNDS: usize = 4;
        for round in 0..MAX_ROUNDS {
            for i in 0..n {
                self.ensure_value(i);
            }
            // 只在第一轮报解析失败，避免同一条告警重复 N 次
            let changed = self.compute_tests(n, round == 0);
            if !changed {
                break;
            }
            // 第 0 轮的 changed 只是「首次定下谁被删」，属于正常流程；
            // 第 1 轮起还在翻转，才说明条件依赖了会随删除而变化的聚合值
            // （如「小计 < 阈值的分组不显示」），此时结果取决于最后一轮，值得提示。
            if round >= 1 {
                self.warnings.push(format!(
                    "row/col_test 第 {} 轮仍在翻转：测试条件依赖了会随删除变化的聚合值，已按最后一轮结果出表",
                    round + 1
                ));
            }
            if round + 1 == MAX_ROUNDS {
                break;
            }
            for inst in self.insts.iter_mut() {
                inst.evaluated = false;
                inst.evaluating = false;
            }
        }
    }

    /// 重算全部测试表达式，并把结果沿主格链传递成 `hidden`；返回是否有格翻转
    fn compute_tests(&mut self, n: usize, warn: bool) -> bool {
        for i in 0..n {
            let row = self.insts[i].row_test_expr.clone();
            let col = self.insts[i].col_test_expr.clone();
            let row_ok = self.test_result(i, &row, "row_test_expr", warn);
            let col_ok = self.test_result(i, &col, "col_test_expr", warn);
            self.insts[i].row_test_passed = row_ok;
            self.insts[i].col_test_passed = col_ok;
        }
        // 传递：主格被删 → 子格跟着删（整行 / 整列删除的语义）。
        // 父格下标恒小于子格（见阶段 1 注释），单遍升序即可。
        let mut hidden = vec![false; n];
        for i in 0..n {
            let own = !self.insts[i].row_test_passed || !self.insts[i].col_test_passed;
            let inherited = self.insts[i].parent.is_some_and(|p| hidden[p])
                || self.insts[i].col_parent.is_some_and(|p| hidden[p]);
            hidden[i] = own || inherited;
        }
        let changed = self.insts.iter().zip(hidden.iter()).any(|(x, h)| x.hidden != *h);
        for (inst, h) in self.insts.iter_mut().zip(hidden) {
            inst.hidden = h;
        }
        changed
    }

    /// 整列删除时，挂在它下面的列子格要一起带走，否则会以默认列号 0 冒出来
    fn mark_col_dropped(&mut self, i: usize) {
        let kids = self.insts[i].col_children.clone();
        for k in kids {
            self.insts[k].dropped = true;
            self.mark_col_dropped(k);
        }
    }

    /// 递归布局：返回该实例子树占用的物理行数
    fn place(&mut self, idx: usize, offset: usize) -> usize {
        // 落位即视为未被删除（dropped 缺省为 true，见 CellInst::new）
        self.insts[idx].dropped = false;
        self.insts[idx].row_start = offset;
        let children = self.insts[idx].children.clone();
        // 深度上限是纯防御：主格树按下标严格递减、结构上无环，
        // 但异常模板仍可能堆出很深的父子链，别把调用栈打爆。
        if children.is_empty() || self.layout_depth >= MAX_LAYOUT_DEPTH {
            self.insts[idx].row_span = 1;
            return 1;
        }
        self.layout_depth += 1;
        let used = self.layout_group(&children, offset).max(1);
        self.layout_depth -= 1;
        self.insts[idx].row_span = used;
        used
    }

    /// 布局一组实例：
    /// - 不同模板行 → 顺序占行
    /// - 同一模板行内，不同列 → **共享**同一段行（小计行的 B4 与 D4 必须同行）
    /// - 同一模板行同一列 → 顺序占行（B3 展开出的 上海 / 杭州 / 南京）
    fn layout_group(&mut self, items: &[usize], offset: usize) -> usize {
        // rowTestExpr：返回假则整行删除——本格不占位，子树因为不会被 place 到而一并消失。
        // 这里读的是 `hidden`（阶段 2 已算好并沿主格链传递），不重新求值：
        // 求值要用到最终 hidden 集合，布局必须跟它看到同一份结果。
        let items: Vec<usize> = items.iter().copied().filter(|c| !self.insts[*c].hidden).collect();
        if items.is_empty() {
            return 0;
        }

        let mut row_groups: Vec<(usize, Vec<usize>)> = Vec::new();
        for c in &items {
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
                if self.insts[*g].hidden {
                    self.insts[*g].dropped = true;
                    self.mark_col_dropped(*g);
                    continue;
                }
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
                if self.insts[*g].hidden {
                    self.insts[*g].dropped = true;
                    self.mark_col_dropped(*g);
                    continue;
                }
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

    // ---------------- 表达式求值 ----------------

    /// 确保第 i 个实例的 value 已求值。
    ///
    /// 惰性求值 + 依赖传播：先递归求值「本表达式引用到的实例」，再算自己。
    /// 这样 `value_expr` 引用另一个 `value_expr` 格时不再依赖实例创建顺序——
    /// 旧实现按 0..n 单遍扫描，被引用格下标更大时会读到尚未求值的 Null，
    /// 既不报错也不崩溃，只在特定模板下静默算错。
    ///
    /// `evaluating` 同时充当循环引用检测：递归中再次进入同一实例说明成环，
    /// 直接放弃求值（保留 Null），避免无限递归。
    fn ensure_value(&mut self, i: usize) {
        if self.insts[i].evaluated || self.insts[i].evaluating {
            return;
        }
        self.insts[i].evaluating = true;

        if let Some(agg) = self.insts[i].agg {
            if let Some(v) = self.aggregate(i, agg) {
                self.insts[i].value = v;
            }
        } else if let Some(expr) = self.insts[i].value_expr.clone() {
            // 解析失败保留展开值，不因一处坏表达式拖垮整张表——但要告警，
            // 否则用户只看到一个空单元格，无从下手
            match expr::parse(&expr) {
                Err(e) => {
                    let pos = self.insts[i].pos.clone();
                    self.warnings
                        .push(format!("{pos} 的 value_expr 无法解析（{e}），已保留展开值"));
                }
                Ok(ast) => {
                    // 先把依赖格求值到位，再算自己
                    for d in self.expr_deps(&ast, i) {
                        self.ensure_value(d);
                    }
                    let v = self.eval_ast(&ast, i, i).into_json(self);
                    self.insts[i].value = v;
                }
            }
        }

        self.insts[i].evaluating = false;
        self.insts[i].evaluated = true;
    }

    /// 计算展示文本，兜底顺序 `formatExpr` > `dict` > `NumFmt`（后者就是 `display()`）。
    ///
    /// 只覆盖文本，不动 `value`：xlsx 仍导出原始数值和数字格式串。所以字典把 1 显示成
    /// 「是」时，Excel 里那个格子还是数字 1 —— 这是「展示值」语义的固有取舍，
    /// 好处是导出后仍可再做透视/计算。
    fn compute_display(&mut self, i: usize) {
        if let Some(e) = self.insts[i].format_expr.clone() {
            match expr::parse(&e) {
                Err(err) => {
                    let pos = self.insts[i].pos.clone();
                    self.warnings.push(format!(
                        "{pos} 的 format_expr 无法解析（{err}），已回落 dict / 数字格式"
                    ));
                }
                Ok(ast) => {
                    // format_expr 可能引用别的格，先把依赖求值到位
                    for d in self.expr_deps(&ast, i) {
                        self.ensure_value(d);
                    }
                    let v = self.eval_ast(&ast, i, i).into_json(self);
                    let text = match v {
                        JsonValue::Null => String::new(),
                        JsonValue::String(s) => s,
                        other => other.to_string(),
                    };
                    self.fmt_text[i] = Some(text);
                    return;
                }
            }
        }

        if let Some(dict) = self.insts[i].dict.clone() {
            // 键取**未套数字格式**的原始文本：配 {"1": "是"} 时不该被千分位/小数位干扰
            let (base, _) = display(self.insts[i].value.clone(), None);
            if let Some(mapped) = dict.get(&base) {
                self.fmt_text[i] = Some(mapped.clone());
            }
        }
    }

    /// 收集表达式引用到的全部实例下标（依赖传播用）
    fn expr_deps(&self, e: &Expr, cur: usize) -> Vec<usize> {
        let mut out = Vec::new();
        self.collect_deps(e, cur, &mut out);
        out
    }

    fn collect_deps(&self, e: &Expr, cur: usize, out: &mut Vec<usize>) {
        match e {
            Expr::Cell { target, coord, .. } => out.extend(self.resolve(target, coord.as_ref(), cur)),
            Expr::Call { args, .. } => {
                for a in args {
                    self.collect_deps(a, cur, out);
                }
            }
            Expr::Binary { lhs, rhs, .. } | Expr::Cmp { lhs, rhs, .. } => {
                self.collect_deps(lhs, cur, out);
                self.collect_deps(rhs, cur, out);
            }
            Expr::Neg(inner) => self.collect_deps(inner, cur, out),
            // `value` 是本格自身，不构成依赖；若在此递归 ensure_value(cur) 会自己等自己
            Expr::Num(_) | Expr::Str(_) | Expr::SelfValue => {}
            // 过滤条件的依赖按当前格收集（候选格是运行期才知道的，无法在此精确展开）
            Expr::Filter { cell, cond } => {
                self.collect_deps(cell, cur, out);
                self.collect_deps(cond, cur, out);
            }
            Expr::Dollar(inner) => self.collect_deps(inner, cur, out),
        }
    }

    /// 实例的层次坐标：从根主格到自己的 `pos:序号` 链，如 `A2:0,B3:2`
    fn layer_coordinate(&self, i: usize) -> String {
        let mut chain = vec![(self.insts[i].pos.clone(), self.insts[i].expand_index)];
        let mut p = self.insts[i].parent;
        while let Some(pi) = p {
            chain.push((self.insts[pi].pos.clone(), self.insts[pi].expand_index));
            p = self.insts[pi].parent;
        }
        chain.reverse();
        chain.iter().map(|(pos, idx)| format!("{pos}:{idx}")).collect::<Vec<_>>().join(",")
    }

    /// 展开中间结果，用于排查扩展/求值问题（等价 NopReport 的 `dump=true`）
    ///
    /// 每行：`seq | pos | 文本 <- 层次坐标 | 行父 | 列父`
    pub fn dump_text(&self) -> String {
        let mut out = String::from("seq | pos | text <- 层次坐标 | 行父 | 列父\n");
        if !self.warnings.is_empty() {
            out.push_str(&format!("!! 告警 {} 条:\n", self.warnings.len()));
            for w in &self.warnings {
                out.push_str(&format!("!!   {w}\n"));
            }
        }
        let link = |p: Option<usize>| match p {
            Some(i) => format!("{}#{}", self.insts[i].pos, self.insts[i].expand_index),
            None => "-".to_string(),
        };
        for (seq, inst) in self.insts.iter().enumerate() {
            if inst.dropped {
                continue;
            }
            // 与出表一致的展示文本（含 formatExpr / dict 覆盖），否则 dump 和实际结果对不上
            let mut text = display(inst.value.clone(), inst.format.as_ref()).0;
            if let Some(Some(t)) = self.fmt_text.get(seq) {
                text = t.clone();
            }
            out.push_str(&format!(
                "{} | {} | {} <- {} | 行父:{} | 列父:{}\n",
                seq,
                inst.pos,
                if text.is_empty() { "(空)" } else { &text },
                self.layer_coordinate(seq),
                link(inst.parent),
                link(inst.col_parent),
            ));
        }
        out
    }

    /// 找到「对当前格可见」的位置名为 target 的实例：
    /// 1. 自己；2. 沿主格链向上的祖格；3. 同一主格下的兄弟格；4. 列主格链
    ///
    /// 第 3 条是关键：`ACCSUM(B2)` / `B2 / B2[A2:-1]` 写在 C2 上时，
    /// B2 与 C2 是同一父格下的兄弟，不是祖孙关系。
    fn anchor_instance(&self, target: &str, cur: usize) -> Option<usize> {
        if self.insts[cur].pos == target {
            return Some(cur);
        }
        let mut p = self.insts[cur].parent;
        while let Some(pi) = p {
            if self.insts[pi].pos == target {
                return Some(pi);
            }
            p = self.insts[pi].parent;
        }
        // 兄弟格：与 cur 挂在同一父格下的那个 target 实例
        let parent = self.insts[cur].parent;
        if let Some(list) = self.by_pos.get(target) {
            if let Some(hit) = list.iter().find(|i| self.insts[**i].parent == parent) {
                return Some(*hit);
            }
        }
        let mut cp = self.insts[cur].col_parent;
        while let Some(ci) = cp {
            if self.insts[ci].pos == target {
                return Some(ci);
            }
            cp = self.insts[ci].col_parent;
        }
        None
    }

    fn eval_ast(&self, e: &Expr, cur: usize, outer: usize) -> Val {
        match e {
            Expr::Num(n) => Val::Num(*n),
            Expr::Str(s) => Val::Str(s.clone()),
            Expr::Neg(inner) => match self.eval_ast(inner, cur, outer).scalar(self) {
                Val::Num(n) => Val::Num(-n),
                _ => Val::Null,
            },
            Expr::Cell { target, coord, prop } => {
                let cells = self.resolve(target, coord.as_ref(), cur);
                match prop {
                    Some(Prop::Aggregate(f)) => Val::Num(self.aggregate_cells(&cells, f)),
                    // `B4.expandIndex`：等价润乾的 `&B4`
                    Some(Prop::ExpandIndex) => match self.anchor_instance(target, cur) {
                        Some(a) => Val::Num(self.insts[a].expand_index as f64),
                        None => Val::Null,
                    },
                    // 无后缀：返回格集本身，由使用场景决定取可见值（anchor）还是遍历全部
                    None => {
                        let anchor = self.anchor_instance(target, cur);
                        Val::Set { cells, anchor }
                    }
                }
            }
            Expr::Binary { op, lhs, rhs } => self.eval_binary(*op, lhs, rhs, cur, outer),
            Expr::Cmp { op, lhs, rhs } => self.eval_cmp(*op, lhs, rhs, cur, outer),
            Expr::Call { name, args } => self.eval_call(name, args, cur, outer),
            // 本格自身的值。value_expr 里出现会自引用：此时 evaluating=true、
            // value 还是 Null，取出来就是 Null，不会递归下去。
            Expr::SelfValue => Val::from_json(self.insts[cur].value.clone()),

            // 格集过滤：条件以**候选格**为上下文求值（裸 B2 = 候选格的主格），
            // 于是 `outer` 传当前格，`$B2` 才能回到当前格的主格。
            Expr::Filter { cell, cond } => {
                let cells = match self.eval_ast(cell, cur, outer) {
                    Val::Set { cells, .. } => cells,
                    // 过滤只能作用在格集上；单值原样返回
                    other => return other,
                };
                let kept: Vec<usize> = cells
                    .into_iter()
                    .filter(|&cand| self.eval_ast(cond, cand, cur).truthy())
                    .collect();
                Val::Set { cells: kept.clone(), anchor: kept.first().copied() }
            }
            Expr::Dollar(inner) => self.eval_ast(inner, outer, outer),
        }
    }

    fn eval_binary(&self, op: BinOp, lhs: &Expr, rhs: &Expr, cur: usize, outer: usize) -> Val {
        let a = self.eval_ast(lhs, cur, outer).scalar(self);
        let b = self.eval_ast(rhs, cur, outer).scalar(self);
        let (x, y) = match (a.as_num(), b.as_num()) {
            (Some(x), Some(y)) => (x, y),
            _ => return Val::Null,
        };
        Val::Num(match op {
            BinOp::Add => x + y,
            BinOp::Sub => x - y,
            BinOp::Mul => x * y,
            BinOp::Div if y != 0.0 => x / y,
            BinOp::Div => return Val::Null,
        })
    }

    fn eval_cmp(&self, op: CmpOp, lhs: &Expr, rhs: &Expr, cur: usize, outer: usize) -> Val {
        let a = self.eval_ast(lhs, cur, outer).scalar(self);
        let b = self.eval_ast(rhs, cur, outer).scalar(self);
        let r = match (a.as_num(), b.as_num()) {
            (Some(x), Some(y)) => match op {
                CmpOp::Gt => x > y,
                CmpOp::Ge => x >= y,
                CmpOp::Lt => x < y,
                CmpOp::Le => x <= y,
                CmpOp::Eq => x == y,
                CmpOp::Ne => x != y,
            },
            // 至少一方不是数字 → 按文本比。
            // 条件表达式大量用于比对分组标签（"1月" / "华东"），只支持数字等于不可用。
            _ => {
                let (sa, sb) = (a.as_text(self), b.as_text(self));
                match op {
                    CmpOp::Eq => sa == sb,
                    CmpOp::Ne => sa != sb,
                    CmpOp::Gt => sa > sb,
                    CmpOp::Ge => sa >= sb,
                    CmpOp::Lt => sa < sb,
                    CmpOp::Le => sa <= sb,
                }
            }
        };
        Val::Bool(r)
    }

    /// 把参数摊平成数字序列：格集取全部成员，标量取自身
    fn arg_numbers(&self, args: &[Expr], cur: usize, outer: usize) -> Vec<f64> {
        let mut out = Vec::new();
        for a in args {
            match self.eval_ast(a, cur, outer) {
                Val::Set { cells, .. } => {
                    out.extend(cells.iter().filter_map(|i| as_number(self.insts[*i].value.clone())))
                }
                v => {
                    if let Some(n) = v.scalar(self).as_num() {
                        out.push(n)
                    }
                }
            }
        }
        out
    }

    fn aggregate_cells(&self, cells: &[usize], func: &str) -> f64 {
        let nums: Vec<f64> =
            cells.iter().filter_map(|i| as_number(self.insts[*i].value.clone())).collect();
        match func {
            "count" => nums.len() as f64,
            "avg" if !nums.is_empty() => nums.iter().sum::<f64>() / nums.len() as f64,
            "min" => nums.iter().cloned().fold(f64::NAN, f64::min),
            "max" => nums.iter().cloned().fold(f64::NAN, f64::max),
            _ => nums.iter().sum::<f64>(),
        }
    }

    fn eval_call(&self, name: &str, args: &[Expr], cur: usize, outer: usize) -> Val {
        match name {
            "IF" if args.len() == 3 => {
                let c = self.eval_ast(&args[0], cur, outer).scalar(self);
                let branch = if c.truthy() { &args[1] } else { &args[2] };
                self.eval_ast(branch, cur, outer).scalar(self)
            }
            "NVL" if args.len() == 2 => {
                let v = self.eval_ast(&args[0], cur, outer).scalar(self);
                if matches!(v, Val::Null) {
                    self.eval_ast(&args[1], cur, outer).scalar(self)
                } else {
                    v
                }
            }
            "PRODUCT" => Val::Num(self.arg_numbers(args, cur, outer).iter().product::<f64>()),
            // COUNTA 数的是非空单元格，与 COUNT（只数数字）不同
            "COUNTA" => {
                let mut n = 0usize;
                for a in args {
                    match self.eval_ast(a, cur, outer) {
                        Val::Set { cells, .. } => {
                            n += cells.iter().filter(|i| !self.insts[**i].value.is_null()).count()
                        }
                        v => {
                            if !matches!(v.scalar(self), Val::Null) {
                                n += 1
                            }
                        }
                    }
                }
                Val::Num(n as f64)
            }
            // 排名：当前值在一组里的降序名次（1 起）
            "RANK" if args.len() == 1 => {
                let nums = self.arg_numbers(args, cur, outer);
                let v = self.eval_ast(&args[0], cur, outer).scalar(self).as_num();
                match v {
                    Some(x) => Val::Num(1.0 + nums.iter().filter(|n| **n > x).count() as f64),
                    None => Val::Null,
                }
            }
            "SUM" | "COUNT" | "AVG" | "MIN" | "MAX" => {
                let nums = self.arg_numbers(args, cur, outer);
                let f = match name {
                    "COUNT" => "count",
                    "AVG" => "avg",
                    "MIN" => "min",
                    "MAX" => "max",
                    _ => "sum",
                };
                // 复用聚合口径：COUNT 数的是数字个数，MIN/MAX 空集为 NaN
                Val::Num(match f {
                    "count" => nums.len() as f64,
                    "avg" if !nums.is_empty() => nums.iter().sum::<f64>() / nums.len() as f64,
                    "min" => nums.iter().cloned().fold(f64::NAN, f64::min),
                    "max" => nums.iter().cloned().fold(f64::NAN, f64::max),
                    _ => nums.iter().sum::<f64>(),
                })
            }
            // 占比：当前行的值 / 同范围（带层次坐标则为其界定的范围）之和
            "PROPORTION" if args.len() == 1 => {
                let (num, total) = match &args[0] {
                    Expr::Cell { target, coord, .. } => {
                        let cells = self.resolve(target, coord.as_ref(), cur);
                        let anchor = self
                            .anchor_instance(target, cur)
                            .filter(|a| cells.contains(a))
                            .or_else(|| cells.first().copied());
                        let n = anchor.and_then(|i| as_number(self.insts[i].value.clone()));
                        (n, self.aggregate_cells(&cells, "sum"))
                    }
                    _ => {
                        let n = self.eval_ast(&args[0], cur, outer).scalar(self).as_num();
                        (n, self.arg_numbers(args, cur, outer).iter().sum::<f64>())
                    }
                };
                match num {
                    Some(x) if total != 0.0 => Val::Num(x / total),
                    _ => Val::Null,
                }
            }
            // 累计汇总：从第一个实例累加到当前实例所在位置
            "ACCSUM" if args.len() == 1 => match &args[0] {
                Expr::Cell { target, coord, .. } => {
                    let cells = self.resolve(target, coord.as_ref(), cur);
                    let upto = match self.anchor_instance(target, cur) {
                        Some(a) => cells.iter().position(|c| *c == a).map(|p| p + 1),
                        None => None,
                    };
                    let n = upto.unwrap_or(cells.len()).min(cells.len());
                    Val::Num(
                        cells[..n].iter().filter_map(|i| as_number(self.insts[*i].value.clone())).sum(),
                    )
                }
                _ => Val::Null,
            },
            _ => Val::Null,
        }
    }

    /// 层次坐标 → 实例下标集合。
    ///
    /// 被测试表达式删掉的格不出现在结果里：它们既不出表，也不该进合计。
    fn resolve(&self, target: &str, coord: Option<&Coord>, cur: usize) -> Vec<usize> {
        self.resolve_raw(target, coord, cur)
            .into_iter()
            .filter(|&i| !self.insts[i].hidden)
            .collect()
    }

    fn resolve_raw(&self, target: &str, coord: Option<&Coord>, cur: usize) -> Vec<usize> {
        match coord {
            None => self.by_pos.get(target).cloned().unwrap_or_default(),
            Some(cd) => {
                // 找 coord 主格实例：先认自己，再沿行主格链，最后走列主格链。
                //
                // 「先认自己」是后补的：分组格写 `C1[B1:+0] >= 0`（小计为 0 的组不显示）
                // 时，B1 不在**自己**的祖先链上，旧实现一律返回空集，条件恒假、
                // 整行被静默删光。自己就是自己最近的同名主格，认了才说得通。
                let mut anc: Option<usize> = None;
                if self.insts[cur].pos == cd.pos {
                    anc = Some(cur);
                }
                let mut p = if anc.is_some() { None } else { self.insts[cur].parent };
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

fn display(v: JsonValue, fmt: Option<&NumFmt>) -> (String, Option<f64>) {
    match &v {
        JsonValue::Null => (String::new(), None),
        JsonValue::String(s) => (s.clone(), None),
        JsonValue::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            (apply_format(f, fmt), Some(f))
        }
        JsonValue::Bool(b) => (b.to_string(), None),
        other => (other.to_string(), None),
    }
}

/// 按格式渲染数值；`fmt=None` 时退化为全局兜底口径。
fn apply_format(f: f64, fmt: Option<&NumFmt>) -> String {
    let Some(fmt) = fmt else { return format_number(f) };
    let kind = fmt.kind.as_str();
    match kind {
        // 文本：不加任何千分位 / 补零，原样输出（去掉 f64 的 .0 尾巴）
        "text" => plain_number(f),
        "int" => {
            let d = fmt.digits.unwrap_or(0);
            fixed_with_sep(f, d, fmt.thousands.unwrap_or(true))
        }
        "decimal" => {
            let d = fmt.digits.unwrap_or(2);
            fixed_with_sep(f, d, fmt.thousands.unwrap_or(true))
        }
        "currency" => {
            let d = fmt.digits.unwrap_or(2);
            let sym = currency_symbol(fmt.code.as_deref().unwrap_or("CNY"));
            let neg = f < 0.0;
            let body = fixed_with_sep(f.abs(), d, fmt.thousands.unwrap_or(true));
            if neg { format!("-{sym}{body}") } else { format!("{sym}{body}") }
        }
        // 百分比：0.1234 → 12.34%（乘 100 后按位数渲染）
        "percent" => {
            let d = fmt.digits.unwrap_or(2);
            let v = f * 100.0;
            let neg = v < 0.0;
            let body = fixed_with_sep(v.abs(), d, fmt.thousands.unwrap_or(false));
            if neg { format!("-{body}%") } else { format!("{body}%") }
        }
        // 未知 kind：不改变默认口径
        _ => format_number(f),
    }
}

/// 固定小数位 + 可选千分位（负数取绝对值由调用方处理符号）
fn fixed_with_sep(f: f64, digits: usize, thousands: bool) -> String {
    let s = format!("{:.*}", digits.min(10), f.abs());
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, fr)) => (i.to_string(), Some(fr.to_string())),
        None => (s, None),
    };
    let int_part = if thousands { with_sep(&int_part) } else { int_part };
    match frac_part {
        Some(fr) => format!("{int_part}.{fr}"),
        None => int_part,
    }
}

/// f64 → 不带多余小数尾巴的字符串（1.0 → "1"，1.5 → "1.5"）
fn plain_number(f: f64) -> String {
    if (f.fract()).abs() < 1e-9 {
        format!("{}", f.round() as i64)
    } else {
        let s = format!("{f}");
        s
    }
}

/// 货币代码 → 符号（与设计器 expression.ts 的 CURRENCY_SYMBOL 对齐）
fn currency_symbol(code: &str) -> &'static str {
    match code {
        "USD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "HKD" => "HK$",
        "JPY" => "¥",
        _ => "¥",
    }
}

/// NumFmt → Excel 数字格式串（xlsx 导出用；None 表示用 Excel 默认常规格式）
fn excel_num_format(fmt: &NumFmt) -> Option<String> {
    let thr = |b: Option<bool>| if b.unwrap_or(true) { "#,##0" } else { "0" };
    let body = match fmt.kind.as_str() {
        "int" => {
            let d = fmt.digits.unwrap_or(0);
            if d == 0 {
                thr(fmt.thousands).to_string()
            } else {
                format!("{}.{}", thr(fmt.thousands), "0".repeat(d))
            }
        }
        "decimal" => {
            let d = fmt.digits.unwrap_or(2);
            format!("{}.{}", thr(fmt.thousands), "0".repeat(d))
        }
        "currency" => {
            let d = fmt.digits.unwrap_or(2);
            let sym = currency_symbol(fmt.code.as_deref().unwrap_or("CNY"));
            format!("\"{sym}\"{}.{}", thr(fmt.thousands), "0".repeat(d))
        }
        "percent" => {
            let d = fmt.digits.unwrap_or(2);
            format!("0.{}%", "0".repeat(d))
        }
        // 文本 / 未知：不设数字格式
        _ => return None,
    };
    Some(body)
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
    GridCell {
        text: String::new(),
        pos: String::new(),
        rowspan: 1,
        colspan: 1,
        raw_number: None,
        num_format: None,
        formula: None,
    }
}

// ───────── 缺省父格推断的单元测试 ─────────
//
// 直接测 `default_row_parent` / `default_col_parent`：它们的判据是「向左/向上扫到了什么」，
// 而这个结果在最终网格里很难一眼看出（要凑出行数差异），在这里断言最准。
#[cfg(test)]
mod parent_tests {
    use super::*;

    fn cm(expand: Option<ExpandType>, row_parent: Option<&str>, col_parent: Option<&str>) -> Option<CellModel> {
        Some(CellModel {
            ds: Some("ds1".to_string()),
            field: None,
            agg: None,
            expand_type: expand,
            row_parent: row_parent.map(|s| s.to_string()),
            col_parent: col_parent.map(|s| s.to_string()),
            col_after: None,
            value_expr: None,
            expand_expr: None,
            expand_min_count: None,
            expand_max_count: None,
            keep_expand_empty: None,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: None,
        })
    }

    /// `rows[r][c]` 三元组：(是否行扩展, 声明的 row_parent, 声明的 col_parent)
    fn sheet_of(rows: Vec<Vec<(bool, Option<&str>, Option<&str>)>>) -> SheetTpl {
        SheetTpl {
            name: "t".into(),
            page: None,
            rows: rows
                .into_iter()
                .map(|cells| RowTpl {
                    cells: cells
                        .into_iter()
                        .map(|(exp, rp, cp)| CellTpl {
                            pos: None,
                            value: Some(JsonValue::from("x")),
                            model: cm(if exp { Some(ExpandType::R) } else { None }, rp, cp),
                            merge_across: 0,
                            merge_down: 0,
                            merge_to_end: false,
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    /// 复刻 `expand_sheet` 里行序解析的那一遍，返回每格**解析后**的父格
    fn resolve(sheet: &SheetTpl, col: bool) -> Vec<Vec<Option<String>>> {
        let mut resolved: Resolved = BTreeMap::new();
        let mut out = Vec::new();
        for (r, row) in sheet.rows.iter().enumerate() {
            let mut line = Vec::new();
            for (c, cell) in row.cells.iter().enumerate() {
                let model = cell.model.clone().unwrap_or_default();
                let decl = if col {
                    parse_parent(model.col_parent.as_deref())
                } else {
                    parse_parent(model.row_parent.as_deref())
                };
                let d = match decl {
                    ParentDecl::Ref(p) => ParentDecl::Ref(p),
                    ParentDecl::ExplicitNone => ParentDecl::ExplicitNone,
                    ParentDecl::Unset => {
                        let p = if col {
                            default_col_parent(sheet, r, c, &resolved)
                        } else {
                            default_row_parent(sheet, r, c, &resolved)
                        };
                        match p {
                            Some(p) => ParentDecl::Ref(p),
                            None => ParentDecl::Unset,
                        }
                    }
                };
                line.push(match &d {
                    ParentDecl::Ref(p) => Some(p.clone()),
                    _ => None,
                });
                resolved.insert((r, c), d);
            }
            out.push(line);
        }
        out
    }

    #[test]
    fn nearest_left_expand_cell_wins() {
        // A1 行扩展、B1 不是扩展格但声明了父格 A1、C1 什么都不写
        let s = sheet_of(vec![vec![
            (true, None, None),
            (false, Some("A1"), None),
            (false, None, None),
        ]]);
        // C1 往左扫先撞上 B1（非扩展、有父格）→ 跟随到 A1
        assert_eq!(resolve(&s, false)[0][2], Some("A1".to_string()));
    }

    /// 规则 1：左边相邻格不是扩展格、但它有父格 → 跟随（而不是跳过它继续找扩展格）
    #[test]
    fn follows_neighbour_parent_instead_of_scanning_past_it() {
        // 第 2 行往左扫：A2 不是扩展格，本行左边也没有扩展格——
        // 没有「跟随」的话 B2 会挂根；有了就跟到 A2 的父格 A1
        let s = sheet_of(vec![
            vec![(true, None, None)],
            vec![(false, Some("A1"), None), (false, None, None)],
        ]);
        assert_eq!(resolve(&s, false)[1][1], Some("A1".to_string()));
    }

    /// 跟随的是**解析后**的父格（含推断出来的），不是只跟显式声明的
    ///
    /// 上游 `initParentChildren` 会把推断结果回写进 model，所以后处理的格子
    /// 读到的是回写后的值。这里 B1 自己没声明父格，是靠「向左扫」推断出 A1 的，
    /// C1 应当跟到这个推断结果。
    #[test]
    fn follows_inferred_parent_not_just_declared() {
        let s = sheet_of(vec![vec![
            (true, None, None),
            (false, None, None),
            (false, None, None),
        ]]);
        // B1 推断出 A1，C1 跟随 B1 → A1
        assert_eq!(resolve(&s, false)[0][1], Some("A1".to_string()));
        assert_eq!(resolve(&s, false)[0][2], Some("A1".to_string()));
    }

    /// `A0`（CellPosition.NONE）是显式「无父格」：既不套用缺省推断，也会**截断**左邻的扫描
    #[test]
    fn explicit_a0_stops_the_scan_and_disables_inference() {
        let s = sheet_of(vec![vec![
            (true, None, None),
            (false, Some("A0"), None),
            (false, None, None),
        ]]);
        // B1 自己声明 A0 → 没有父格
        assert_eq!(resolve(&s, false)[0][1], None);
        // C1 往左先撞上声明了 A0 的 B1 → 停在这里返回「无父格」，
        // 不会跳过 B1 去找到 A1（这是上游 `resolveRowParent(NONE) → null` 的行为）
        assert_eq!(resolve(&s, false)[0][2], None);
    }

    /// 自引用保护：跟随结果指向自己时返回「无父格」
    #[test]
    fn self_reference_guard() {
        // B1 声明父格就是 C1；C1 往左扫跟到 B1 的父格 == 自己 → 无父格
        let s = sheet_of(vec![vec![
            (false, None, None),
            (false, Some("C1"), None),
            (false, None, None),
        ]]);
        assert_eq!(resolve(&s, false)[0][2], None);
    }

    /// 规则 2 的兜底：最左格没有父格时，整行都不会凭空造出父格
    ///
    /// 顺带说明这条兜底在当前行序下基本不可达——扫描一定会检查到 col 0，
    /// 若 col 0 有父格，规则 1 就已经跟随了；兜底读的是同一个格子。
    /// 只有合并格（上游 `getRealCell()`）那种「扫到的和兜底取到的不是同一个格子」
    /// 的情况才会走到。我们不做合并格语义，所以这里保持返回 None。
    #[test]
    fn leftmost_fallback_does_not_invent_a_parent() {
        let s = sheet_of(vec![vec![(false, None, None), (false, None, None)]]);
        assert_eq!(resolve(&s, false)[0], vec![None, None]);
    }

    /// 列父格是镜像：向上扫，扫到非扩展格就跟它的 col_parent
    #[test]
    fn col_parent_scans_up_and_follows() {
        let s = sheet_of(vec![
            vec![(false, None, Some("Z9"))],
            vec![(false, None, None)],
        ]);
        // A2 向上扫 → A1 非扩展格、有 col_parent Z9 → 跟随
        assert_eq!(resolve(&s, true)[1][0], Some("Z9".to_string()));
    }

    #[test]
    fn col_parent_nearest_up_expand_cell_wins() {
        let s = sheet_of(vec![
            vec![(false, None, None)],
            vec![(false, None, None)],
        ]);
        // 上面没有列扩展格 → 无父格（列扩展是 ExpandType::C，这里没造）
        assert_eq!(resolve(&s, true)[1][0], None);
    }
}
