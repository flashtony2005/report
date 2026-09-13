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
use std::cell::{Ref, RefCell};
use std::rc::Rc;
use std::collections::{BTreeMap, HashMap, HashSet};

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

/// 模板级展开范围：(row, col) -> (offset, span)
///
/// offset 可以为负（子格排到父格上方/左方时），所以是 `isize`。
type Ranges = BTreeMap<(usize, usize), (isize, usize)>;

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

/// 模板级父格解析（Pass 0）：按**行优先**顺序解析每格的父格，不建实例。
///
/// 为什么要把这段从建实例的循环里抽出来：规则 3（`addDefaultRowParents`）要先知道
/// 「谁是谁的子格」才能算展开范围，而展开范围又必须在建实例**之前**就定下来。
/// 原先边建实例边推断，拿不到这个全局视图。
///
/// 抽出来是**语义等价**的，因为：
/// - 解析只读模板和**行优先序更早**的格子（向左扫同行前面的列、向上扫同列前面的行、
///   兜底读本行最左 / 第一行同列），所以一次性预扫出的 map 与逐格边扫边填的结果一致；
/// - 占位空格（既无值也无模型）照旧跳过，不写进 map。
fn resolve_parents(sheet: &SheetTpl) -> (Resolved, Resolved) {
    let mut row: Resolved = BTreeMap::new();
    let mut col: Resolved = BTreeMap::new();
    for (r, line) in sheet.rows.iter().enumerate() {
        for (c, cell) in line.cells.iter().enumerate() {
            if cell.value.is_none() && cell.model.is_none() {
                continue;
            }
            let model = cell.model.clone().unwrap_or_default();
            let rd = match parse_parent(model.row_parent.as_deref()) {
                ParentDecl::Ref(p) => ParentDecl::Ref(p),
                ParentDecl::ExplicitNone => ParentDecl::ExplicitNone,
                ParentDecl::Unset => match default_row_parent(sheet, r, c, &row) {
                    Some(p) => ParentDecl::Ref(p),
                    None => ParentDecl::Unset,
                },
            };
            let cd = match parse_parent(model.col_parent.as_deref()) {
                ParentDecl::Ref(p) => ParentDecl::Ref(p),
                ParentDecl::ExplicitNone => ParentDecl::ExplicitNone,
                ParentDecl::Unset => match default_col_parent(sheet, r, c, &col) {
                    Some(p) => ParentDecl::Ref(p),
                    None => ParentDecl::Unset,
                },
            };
            row.insert((r, c), rd);
            col.insert((r, c), cd);
        }
    }
    (row, col)
}

/* --------------------------- 规则 3：展开范围与认领 --------------------------- */

/// 模板级行跨度 = `merge_down + 1`（对齐上游 `cell.getRowSpan()`）
fn tpl_row_span(cell: &CellTpl) -> usize {
    cell.merge_down + 1
}

/// 模板级列跨度 = `merge_across + 1`。
/// `merge_to_end`（铺到行尾）的宽度在模板期只能按「本行列数 - 起始列」估，
/// 列数随数据变化，所以这里算出来的是个下界——偏窄只会少认领，不会认错。
fn tpl_col_span(sheet: &SheetTpl, r: usize, c: usize, cell: &CellTpl) -> usize {
    if cell.merge_to_end {
        sheet
            .rows
            .get(r)
            .map(|line| line.cells.len().saturating_sub(c))
            .unwrap_or(1)
            .max(1)
    } else {
        cell.merge_across + 1
    }
}

/// 模板层「子格索引」：父格 (r,c) -> 子格列表（行优先序）
///
/// 由 `resolved` 反转而来：谁的 `Ref(p)` 指向 p，谁就是 p 的子格。
/// 指向不存在格子的声明（模板写错）在这里被丢掉——建实例时那条路径会单独告警，
/// 不必在这里重复报一次。
fn children_index(sheet: &SheetTpl, resolved: &Resolved) -> BTreeMap<(usize, usize), Vec<(usize, usize)>> {
    let mut idx: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for &(r, c) in resolved.keys() {
        let pos = tpl_cell(sheet, r, c)
            .map(|x| tpl_pos(x, r, c))
            .unwrap_or_else(|| cell_pos(r, c));
        idx.insert(pos, (r, c));
    }
    let mut out: BTreeMap<(usize, usize), Vec<(usize, usize)>> = BTreeMap::new();
    for (&(r, c), decl) in resolved.iter() {
        if let ParentDecl::Ref(p) = decl {
            if let Some(&parent) = idx.get(p) {
                out.entry(parent).or_default().push((r, c));
            }
        }
    }
    out
}

/// 自底向上算一个格子的展开范围，对齐上游 `collectRowChild` / `collectColChild`。
///
/// 叶子：`offset = 0`，`span = 自身跨度`。
/// 非叶子：`span` 覆盖自身跨度与所有子格 `(子格号 + 子 offset, + 子 span)` 的并集。
///
/// `depth` 是防栈保护：显式父格允许指向任意格子（甚至成环），
/// 上游遇到环会抛异常，我们只求「别把栈打穿」，到顶就退回叶子形态。
fn span_of(
    sheet: &SheetTpl,
    children: &BTreeMap<(usize, usize), Vec<(usize, usize)>>,
    memo: &mut Ranges,
    (r, c): (usize, usize),
    row_axis: bool,
    depth: usize,
) -> (isize, usize) {
    if let Some(&hit) = memo.get(&(r, c)) {
        return hit;
    }
    let own = tpl_cell(sheet, r, c);
    let self_span = match own {
        Some(x) if row_axis => tpl_row_span(x),
        Some(x) => tpl_col_span(sheet, r, c, x),
        None => 1,
    };
    let self_idx = if row_axis { r } else { c };

    let kids = children.get(&(r, c));
    if depth >= MAX_LAYOUT_DEPTH || kids.map_or(true, |k| k.is_empty()) {
        let leaf = (0isize, self_span);
        memo.insert((r, c), leaf);
        return leaf;
    }

    let mut lo = self_idx as isize;
    let mut hi = (self_idx + self_span) as isize;
    for &(kr, kc) in kids.unwrap() {
        let (k_off, k_span) = span_of(sheet, children, memo, (kr, kc), row_axis, depth + 1);
        let k_idx = if row_axis { kr } else { kc };
        let start = k_idx as isize + k_off;
        lo = lo.min(start);
        hi = hi.max(start + k_span as isize);
    }
    let out = (lo - self_idx as isize, (hi - lo).max(1) as usize);
    memo.insert((r, c), out);
    out
}

/// 算出所有格子的展开范围。
///
/// 必须**覆盖全部格子**（含没有子格的叶子），不能只遍历 `children` 的键——
/// 顶层展开格若一个子格都没有，就不在 `children` 里，规则 3 会查不到它的范围。
fn collect_spans(
    sheet: &SheetTpl,
    children: &BTreeMap<(usize, usize), Vec<(usize, usize)>>,
    all: &Resolved,
    row_axis: bool,
) -> Ranges {
    let mut memo: Ranges = BTreeMap::new();
    for &(r, c) in all.keys() {
        span_of(sheet, children, &mut memo, (r, c), row_axis, 0);
    }
    memo
}

/// 规则 3：`addDefaultRowParents` / `addDefaultColParents`（上游 L629-679）
///
/// 顶层展开格把它展开范围内的、**没有父格**且**不与它自己的跨度重叠**的格子收作子格。
///
/// 为什么需要：手写模板里，展开块「影子」下的格子扫不到任何父格，会挂根只渲染一次——
/// 表现就是分组明细里突然冒出一个总计。收编进分组之后才会跟着分组展开。
///
/// 三个容易写错的点：
///
/// 1. 门槛是 `rowParent == null`，即**从未声明、也没推断出**父格。
///    显式写 `A0` 在上游是 `CellPosition.NONE`——一个**非 null 的哨兵值**，
///    所以**不受**规则 3 影响。别把 `ExplicitNone` 一起收编了。
/// 2. 认领要**边认领边生效**：按行优先序处理，前面的格子认领完之后，后面的格子
///    再判断「我有没有父格」时已经是「有」了。所以读的是可变 map，不是快照。
/// 3. `ranges` 只需要算一次。上游虽然是在循环里惰性算的，但认领只作用在**顶层**格上，
///    而顶层格不会成为别人的子格，所以不存在「后面的格子看到前面的认领结果」这回事。
fn add_default_parents(sheet: &SheetTpl, resolved: &mut Resolved, ranges: &Ranges, row_axis: bool) {
    // BTreeMap 的键序就是行优先序，正是上游 `forEachRealCell` 的顺序
    let cells: Vec<(usize, usize)> = resolved.keys().copied().collect();
    for (r, c) in cells {
        // 只处理顶层（解析后仍无父格）的展开格
        if !matches!(resolved.get(&(r, c)), Some(ParentDecl::Unset)) {
            continue;
        }
        let Some(cell) = tpl_cell(sheet, r, c) else { continue };
        let Some(model) = cell.model.as_ref() else { continue };
        let expanding = if row_axis { model.is_row_expand() } else { model.is_col_expand() };
        if !expanding {
            continue;
        }
        let Some(&(offset, span)) = ranges.get(&(r, c)) else { continue };

        let self_idx = if row_axis { r } else { c };
        let self_span = if row_axis {
            tpl_row_span(cell)
        } else {
            tpl_col_span(sheet, r, c, cell)
        };
        let own_start = self_idx as isize;
        let own_end = own_start + self_span as isize;

        let start = (self_idx as isize + offset).max(0) as usize;
        let end = (self_idx as isize + offset + span as isize).max(0) as usize;
        let pos = tpl_pos(cell, r, c);

        for i in start..end {
            // 行轴：第 i 行的所有列；列轴：第 i 列的所有行
            let coords: Vec<(usize, usize)> = if row_axis {
                match sheet.rows.get(i) {
                    Some(line) => (0..line.cells.len()).map(|j| (i, j)).collect(),
                    None => continue,
                }
            } else {
                (0..sheet.rows.len())
                    .filter(|rr| sheet.rows[*rr].cells.get(i).is_some())
                    .map(|rr| (rr, i))
                    .collect()
            };
            for (rr, cc) in coords {
                if (rr, cc) == (r, c) {
                    continue;
                }
                // 只认领「无父格」的；占位空格不在 map 里，自然也在这里被排除
                if !matches!(resolved.get(&(rr, cc)), Some(ParentDecl::Unset)) {
                    continue;
                }
                let Some(other) = tpl_cell(sheet, rr, cc) else { continue };
                // 列轴要放过显式声明了 `col_after` 的格子。
                //
                // `col_after` 是我们对上游 `colExtendForSibling` 的等价物：作者用它
                // 声明「我排在某个列展开格所占列区间**之后**」。而规则 3 收编之后，
                // 该格会变成那个列展开格的子格、被放进它的列区间**里面**——两条声明打架，
                // 结果是「金额合计」这种表头跟着月份重复一遍。
                //
                // 语义上也说得通：规则 3 是给「完全没有任何定位信息」的格子兜底的，
                // 而写了 `col_after` 的格子显然已经自己定好了位置。
                if !row_axis
                    && other
                        .model
                        .as_ref()
                        .and_then(|m| m.col_after.as_ref())
                        .is_some()
                {
                    continue;
                }
                let o_idx = if row_axis { rr } else { cc };
                let o_span = if row_axis {
                    tpl_row_span(other)
                } else {
                    tpl_col_span(sheet, rr, cc, other)
                };
                let o_start = o_idx as isize;
                let o_end = o_start + o_span as isize;
                // 与本格自己的跨度重叠的不收（上游那个 `||` 条件）
                if o_end <= own_start || o_start >= own_end {
                    resolved.insert((rr, cc), ParentDecl::Ref(pos.clone()));
                }
            }
        }
    }
}

/// 阶段 0 的后半段：在缺省推断之上套用规则 3
fn apply_default_parents(sheet: &SheetTpl, row: &mut Resolved, col: &mut Resolved) {
    let row_children = children_index(sheet, row);
    let row_ranges = collect_spans(sheet, &row_children, row, true);
    add_default_parents(sheet, row, &row_ranges, true);

    let col_children = children_index(sheet, col);
    let col_ranges = collect_spans(sheet, &col_children, col, false);
    add_default_parents(sheet, col, &col_ranges, false);
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
    /// `cells` 用引用计数而不是 `Vec`：结果集常常是**整列**，而每条明细行都要解析一次，
    /// 逐行克隆一份 `Vec<usize>` 就是 O(n²)（实测 `B2 * 2` 在 16k 行上 226 ms，
    /// 且规模翻倍耗时翻四倍）。无层次坐标时结果集与当前格无关，共享同一份即可。
    /// `cells` 恒为**升序**（`by_pos` 与 `descendants` 都是按创建顺序 push 的），
    /// 所以成员判断用二分而不是线性扫。
    ///
    /// `pick` 是其中「对当前格可见」的那一个（同一主格下的兄弟格，或主格链上的祖格），
    /// 折叠成标量时取它的值——这是 NopReport `getNamedCells` 的可见性语义：
    /// 写 `B2 / B2[A2:-1]` 时，裸 `B2` 必须是**当前行**的 B2，而不是全局第一个 B2。
    /// 在构造处就算好：留到 `scalar` 里再判成员，等于每行多扫一遍整列。
    Set { cells: Rc<[usize]>, pick: Option<usize> },
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
            Val::Set { pick, .. } => match pick {
                Some(i) => Val::from_json(e.insts[i].value.clone()),
                None => Val::Null,
            },
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

/// 某个位置名在一轮求值内可复用的索引。
///
/// 存在的理由：`ACCSUM(B2)` / `PROPORTION(B2)` 这类**写在每个明细行上**的表达式，
/// 朴素实现每行都要把整列重新数一遍 —— 克隆结果集、线性找兄弟格、线性找自己的位置、
/// 线性求和，四五个 O(n) 叠起来就是 O(n²)：实测 16000 行光累计列就 1.45 s。
/// 这些量对同一个位置名在一轮里只算一次就够。
///
/// 生命周期：值在一轮内只写不改（`evaluated` 只会从 false 变 true），所以缓存只在
/// 「`evaluated` 被清空重算」时作废 —— 见 `evaluate_to_fixpoint` 每轮开头的清理。
struct PosIndex {
    /// 去掉被删格后的结果集（升序），等价于 `resolve(target, None, cur)`。
    /// 源是 `by_pos[target]` 原样（升序、含被删格），建完 `by_parent` 就不需要留了。
    /// 用 `Rc` 是为了让 `resolve` 能直接共享它（见 `Val::Set` 的注释）。
    cells: Rc<[usize]>,
    /// `prefix[k] = cells[..k]` 的数字和。按需向后生长，整轮摊还 O(n)。
    prefix: Vec<f64>,
    /// 主格下标 → 该主格下第一个 target 实例（`anchor_instance` 的兄弟查找）。
    /// 按 `by_pos[target]` 升序插入、只记第一次，与原来的 `iter().find(..)` 口径一致。
    by_parent: HashMap<Option<usize>, usize>,
    /// 结果集的数字列聚合，首次用到时算一次（见 `build_numbers`）。
    /// `SUM(B2)` / `RANK(B2)` 这类写在明细行上的整列聚合，靠它从 O(n²) 降到 O(n)。
    nums: Option<Numbers>,
}

/// 一个结果集的数字列聚合。
///
/// 只留聚合值和有序副本，不留原始序列：用到它的场景（SUM/COUNT/AVG/MIN/MAX/RANK）
/// 都能在这几样上 O(1) / O(log n) 算完。
struct Numbers {
    count: usize,
    sum: f64,
    /// 空集为 NaN，与 `aggregate_cells` 的 `fold(NAN, ..)` 口径一致
    min: f64,
    max: f64,
    /// 升序副本：RANK 的「比我大的有几个」退化成分区点
    sorted: Vec<f64>,
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
    /// 按位置名缓存的实例索引（见 `PosIndex`）
    pos_index: RefCell<HashMap<String, PosIndex>>,
    /// 这一轮里「依赖集已经确保求值到位」的表达式源码。
    ///
    /// `ensure_value` 算一个格之前会先把依赖格求值到位。对写在每个明细行上的表达式，
    /// 依赖集可能是整列（`ACCSUM(B2)`），每行都重新解析一遍就是又一个 O(n²)。
    /// 但**不含层次坐标**时 `resolve` 与当前格无关，同一个表达式在所有行上的依赖集
    /// 完全相同，一轮里真正确保一次就够。有层次坐标的表达式不进这个集合。
    deps_done: RefCell<HashSet<String>>,

    /// `excel_of` 专用 resolve 缓存：`resolve(target, coord, cur)` 在 phase 4
    /// 不会改 hidden，结果只取决于 `(target, coord, anchor_instance)`。
    /// 同一组 N 个明细行共享同一个 anchor → 同一份结果算 N 次 → 缓存命中后
    /// 单次 resolve 缩成「祖链 + HashMap 查表」。
    excel_resolve_cache: RefCell<HashMap<(String, Coord, usize), (Rc<[usize]>, Option<String>)>>,
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
            pos_index: RefCell::new(HashMap::new()),
            deps_done: RefCell::new(HashSet::new()),
            excel_resolve_cache: RefCell::new(HashMap::new()),
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
        self.pos_index.borrow_mut().clear();
        self.deps_done.borrow_mut().clear();

        let all_rows: Vec<usize> = (0..self.ds.len()).collect();

        // ---- 阶段 0：模板级父格解析（含缺省推断 + 规则 3 认领）----
        //
        // 已解析出的父格，按 (row, col) 缓存。等价于上游把推断结果回写进 model；
        // 「向左扫到的相邻格有没有父格」要读它，而且必须是**解析后**的值。
        let (mut resolved_row, mut resolved_col) = resolve_parents(sheet);
        apply_default_parents(sheet, &mut resolved_row, &mut resolved_col);

        // ---- 阶段 1：按模板顺序（行升序、列升序）展开，父格必然先于子格 ----
        for (r, row) in sheet.rows.iter().enumerate() {
            for (c, cell) in row.cells.iter().enumerate() {
                // 纯占位空单元格（既无值也无模型）不参与展开，否则会多出空行
                if cell.value.is_none() && cell.model.is_none() {
                    continue;
                }
                let pos = cell.pos.clone().unwrap_or_else(|| cell_pos(r, c));
                let model = cell.model.clone().unwrap_or_default();

                // 父格在阶段 0 就解析好了（含缺省推断与规则 3 的认领），这里只读结果。
                // `Unset` 与 `ExplicitNone` 都表示「无父格」，但含义不同——
                // 见 `ParentDecl` 的注释，两者的区别只影响阶段 0 的推断。
                let row_ref = match resolved_row.get(&(r, c)) {
                    Some(ParentDecl::Ref(p)) => Some(p.clone()),
                    _ => None,
                };
                let col_ref = match resolved_col.get(&(r, c)) {
                    Some(ParentDecl::Ref(p)) => Some(p.clone()),
                    _ => None,
                };

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

                // 列主格「数据行 → 所属实例」的索引，用来把逐列主格过滤换成一次分桶。
                // 每个模板格建一次，O(总行数)。
                let row_to_cp = self.col_parent_index(&col_parents);

                for parent in &row_parents {
                    let base = match parent {
                        Some(p) => self.insts[*p].rows.clone(),
                        None => all_rows.clone(),
                    };
                    // 按列主格分桶：整个 base 只走一遍，O(|base|)。
                    //
                    // 原来是「每个 (行主格 × 列主格) 组合都克隆一遍 base 再二分过滤」，
                    // 也就是 O(R×M×M)：交叉表 640×320 实测这一项占 705 ms 里的 459 ms
                    // （判别实验：总量固定只变月份数，705→483→362→303 ms，与 M 成正比）。
                    let mut buckets: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
                    if let Some(map) = &row_to_cp {
                        for &r in &base {
                            buckets.entry(map.get(&r).copied()).or_default().push(r);
                        }
                    }
                    for col_parent in &col_parents {
                        let view = match &row_to_cp {
                            Some(_) => buckets.remove(col_parent).unwrap_or_default(),
                            // 没有列主格 / 列主格 rows 有重叠：走原来的求交口径
                            None => {
                                let mut v = base.clone();
                                if let Some(cp) = col_parent {
                                    // 行列主格求交。`rows` 是升序的（见 group_by_field /
                                    // view 的构造），所以用二分而不是 `cv.contains(r)`：
                                    // 线性扫会退化成 (R×M)²。
                                    let cv = &self.insts[*cp].rows;
                                    // 二分的前提：rows 严格升序。将来若有人改成非有序构造，
                                    // 这里会立刻炸，而不是静默少取数（少取数是「合计悄悄
                                    // 变小」，比崩溃难查得多）。
                                    debug_assert!(
                                        cv.windows(2).all(|w| w[0] < w[1]),
                                        "insts[..].rows 必须严格升序，否则二分取交会算错"
                                    );
                                    v.retain(|r| cv.binary_search(r).is_ok());
                                }
                                v
                            }
                        };
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
        // 清空 excel_resolve_cache：phase 4 不会再动 hidden，缓存到这次 pass 结束有效。
        self.excel_resolve_cache.borrow_mut().clear();
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
                // 走带缓存的路径：phase 4 里同一个 (target, coord, anchor) 结果恒定，
                // N 个共享 anchor 的明细行只算一次 resolve + 一次 refs 字符串。
                // 无层次坐标时还是走原 resolve 拿 PosIndex（那份已经是 Rc 共享）。
                let (cells, refs_cached) = match coord.as_ref() {
                    Some(cd) => match self.resolve_for_excel(target, cd, cur) {
                        Some(v) => v,
                        None => return None,
                    },
                    None => {
                        let cells = self.resolve(target, None, cur);
                        let refs = self.excel_refs(&cells);
                        (cells, refs)
                    }
                };
                if cells.is_empty() || cells.binary_search(&cur).is_ok() {
                    return None; // 解析不到引用目标 / 自引用 → 不翻
                }
                let refs = refs_cached?;
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
            // 新一轮要把 `evaluated` 全部清空重算，跨行缓存必须跟着作废：
            // `hidden` 变了结果集就变，值重算了前缀和也不再成立。
            self.pos_index.borrow_mut().clear();
            self.deps_done.borrow_mut().clear();
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
        let mut groups: Vec<Vec<usize>> = Vec::new();
        // 哈希索引代替 `keys.iter().position(..)`：列子格多时那是平方级
        let mut index: HashMap<(usize, Option<usize>), usize> = HashMap::new();
        for k in kids {
            let key = (self.insts[k].tpl_row, self.insts[k].parent);
            match index.get(&key) {
                Some(&p) => groups[p].push(k),
                None => {
                    index.insert(key, groups.len());
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
                    self.ensure_deps(&expr, &ast, i);
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

    /// 把 `src` 这个表达式的依赖格求值到位。
    ///
    /// 与 `expr_deps` + 手动循环的区别只在一点：**不含层次坐标**的表达式，依赖集
    /// 与当前格无关，一轮里真正跑一次就够，之后直接跳过。少了这一步，`ACCSUM(B2)`
    /// 每行都要枚举整列依赖（克隆 + 逐格调用），和表达式本身一样是 O(n²)。
    fn ensure_deps(&mut self, src: &str, ast: &Expr, cur: usize) {
        let cacheable = expr_is_cur_independent(ast);
        if cacheable && self.deps_done.borrow().contains(src) {
            return;
        }
        for d in self.expr_deps(ast, cur) {
            self.ensure_value(d);
        }
        if cacheable {
            self.deps_done.borrow_mut().insert(src.to_string());
        }
    }

    fn collect_deps(&self, e: &Expr, cur: usize, out: &mut Vec<usize>) {
        match e {
            Expr::Cell { target, coord, .. } => {
                out.extend(self.resolve(target, coord.as_ref(), cur).iter().copied())
            }
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

    /// 取 target 的实例索引，没有就现建（见 `PosIndex`）。
    ///
    /// 注意返回的 `Ref` 是**不可变**借用：拿在手上这段时间里不能再去调
    /// `pos_index` / `prefix_sum`（内部要 `borrow_mut`），否则 RefCell 会 panic。
    /// 调用方需要「先算完别的东西，再拿索引」的顺序，见 `ACCSUM` 那一段。
    fn pos_index(&self, target: &str) -> Ref<'_, PosIndex> {
        self.ensure_pos_index(target);
        Ref::map(self.pos_index.borrow(), |m| &m[target])
    }

    fn ensure_pos_index(&self, target: &str) {
        let mut m = self.pos_index.borrow_mut();
        if !m.contains_key(target) {
            let built = self.build_pos_index(target);
            m.insert(target.to_string(), built);
        }
    }

    fn build_pos_index(&self, target: &str) -> PosIndex {
        let all: Vec<usize> = self.by_pos.get(target).cloned().unwrap_or_default();
        debug_assert!(
            all.windows(2).all(|w| w[0] < w[1]),
            "by_pos[{target}] 必须严格升序，否则下面的二分 / 前缀和口径都不成立"
        );
        let cells: Rc<[usize]> = Rc::from(
            all.iter().copied().filter(|&i| !self.insts[i].hidden).collect::<Vec<usize>>(),
        );
        let mut by_parent: HashMap<Option<usize>, usize> = HashMap::new();
        for &i in &all {
            by_parent.entry(self.insts[i].parent).or_insert(i);
        }
        PosIndex { cells, prefix: vec![0.0], by_parent, nums: None }
    }

    /// 单参数、且引用的格**不带层次坐标**时，给出缓存的数字列聚合；否则 None。
    ///
    /// 这两个条件缺一不可：不带坐标才保证结果集与当前格无关（能跨行复用），
    /// 单参数才对得上「整列聚合」这个语义（多参数之和不是任何一列）。
    fn cached_numbers(&self, args: &[Expr]) -> Option<Ref<'_, Numbers>> {
        if args.len() != 1 {
            return None;
        }
        let Expr::Cell { target, coord: None, .. } = &args[0] else {
            return None;
        };
        self.cached_numbers_of(target)
    }

    fn cached_numbers_of(&self, target: &str) -> Option<Ref<'_, Numbers>> {
        self.ensure_pos_index(target);
        if self.pos_index.borrow()[target].nums.is_none() {
            let built = self.build_numbers(target);
            if let Some(idx) = self.pos_index.borrow_mut().get_mut(target) {
                idx.nums = Some(built);
            }
        }
        let idx = self.pos_index(target);
        if idx.nums.is_none() {
            return None;
        }
        Some(Ref::map(idx, |i| i.nums.as_ref().unwrap()))
    }

    /// 无层次坐标时的整列聚合，直接读缓存的聚合值（O(1)）。
    ///
    /// `B2.sum()` 这种**属性写法**和 `SUM(B2)` 走的是两条路（前者在 `eval_ast` 里
    /// 落到 `aggregate_cells`），所以得各自接一次缓存，否则仍是每行扫整列。
    fn cached_col_agg(&self, target: &str, coord: Option<&Coord>, func: &str) -> Option<f64> {
        if coord.is_some() {
            return None;
        }
        let n = self.cached_numbers_of(target)?;
        Some(match func {
            "count" => n.count as f64,
            "avg" if n.count > 0 => n.sum / n.count as f64,
            "min" => n.min,
            "max" => n.max,
            _ => n.sum,
        })
    }

    /// 算结果集的数字列聚合。
    ///
    /// 前提：结果集里的格都已求值。无层次坐标时依赖集就是这个结果集，`ensure_deps`
    /// 会先把它们求值到位，所以这里读到的都是最终值（debug 下断言守住）。
    fn build_numbers(&self, target: &str) -> Numbers {
        let idx = self.pos_index(target);
        debug_assert!(
            idx.cells.iter().all(|&i| {
                // 值只在 `ensure_value` 里写：写过的（evaluated）才是最终值；
                // 既无 value_expr 又无 agg 的格，值在展开时就定好了，也算最终值
                self.insts[i].evaluated
                    || (self.insts[i].value_expr.is_none() && self.insts[i].agg.is_none())
            }),
            "数字列必须在依赖格求值之后才建，否则会把未求值的原始值算进合计"
        );
        let mut sorted = Vec::with_capacity(idx.cells.len());
        let mut sum = 0.0;
        for &i in idx.cells.iter() {
            if let Some(n) = as_number(self.insts[i].value.clone()) {
                sorted.push(n);
                sum += n;
            }
        }
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Numbers {
            count: sorted.len(),
            sum,
            min: sorted.first().copied().unwrap_or(f64::NAN),
            max: sorted.last().copied().unwrap_or(f64::NAN),
            sorted,
        }
    }

    /// 表达式在当前格可见的那个数值 —— `Val::Set` 折叠成标量的快路径。
    ///
    /// 与 `Val::scalar` 口径完全一致（先认 anchor，anchor 不在结果集里就退到第一个），
    /// 只是不再为了取一个数去克隆整列。
    fn anchor_number_of(&self, e: &Expr, cur: usize, outer: usize) -> Option<f64> {
        let Expr::Cell { target, coord: None, .. } = e else {
            return self.eval_ast(e, cur, outer).scalar(self).as_num();
        };
        let anchor = self.anchor_instance(target, cur);
        let pick = {
            let idx = self.pos_index(target);
            match anchor {
                Some(a) if idx.cells.binary_search(&a).is_ok() => Some(a),
                _ => idx.cells.first().copied(),
            }
        };
        match pick {
            Some(i) => Val::from_json(self.insts[i].value.clone()).as_num(),
            None => None,
        }
    }

    /// `ACCSUM` / `PROPORTION` 的前缀和：`cells[..n]` 的数字和。
    ///
    /// 按需向后生长，每个元素只加一次，整轮摊还 O(n)。`n` 回退时直接读已算好的前缀。
    fn prefix_sum(&self, target: &str, want: usize) -> f64 {
        let mut m = self.pos_index.borrow_mut();
        let idx = match m.get_mut(target) {
            Some(i) => i,
            None => return 0.0,
        };
        let n = want.min(idx.cells.len());
        while idx.prefix.len() <= n {
            let k = idx.prefix.len() - 1;
            let add = as_number(self.insts[idx.cells[k]].value.clone()).unwrap_or(0.0);
            idx.prefix.push(idx.prefix[k] + add);
        }
        idx.prefix[n]
    }

    /// 列主格「数据行 → 所属实例」索引，供展开时按列主格分桶（见 `expand_sheet`）。
    ///
    /// 只有列主格的 `rows` **互不相交**时才能用：`group_by_field` 是划分，正常都满足。
    /// 一旦有重叠就返回 None，调用方退回「逐列主格求交」的旧口径 ——
    /// 分桶会把重叠的行只分给一个列主格，**静默少取数**（合计悄悄变小），
    /// 这种错误比慢难查得多，宁可慢也不能错。
    fn col_parent_index(&self, col_parents: &[Option<usize>]) -> Option<HashMap<usize, usize>> {
        // 没有列主格（col_parents == [None]）时谈不上分桶
        if col_parents.len() == 1 && col_parents[0].is_none() {
            return None;
        }
        let mut m: HashMap<usize, usize> = HashMap::new();
        let mut disjoint = true;
        for cp in col_parents.iter().flatten() {
            for r in &self.insts[*cp].rows {
                if m.insert(*r, *cp).is_some() {
                    disjoint = false;
                }
            }
        }
        if disjoint {
            Some(m)
        } else {
            None
        }
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
        // 兄弟格：与 cur 挂在同一父格下的那个 target 实例。
        //
        // 走 `PosIndex::by_parent` 而不是扫整列：这个函数在每个明细行上都会被调用
        // （ACCSUM 找自己排第几、PROPORTION 找自己那格），线性扫就是 O(n²)。
        if let Some(&hit) = self.pos_index(target).by_parent.get(&self.insts[cur].parent) {
            return Some(hit);
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
                    // `B2.sum()`：无层次坐标时结果集是整列且与 cur 无关，
                    // 读缓存的聚合值即可，不必每行再扫一遍
                    Some(Prop::Aggregate(f)) => {
                        match self.cached_col_agg(target, coord.as_ref(), f) {
                            Some(v) => Val::Num(v),
                            None => Val::Num(self.aggregate_cells(&cells, f)),
                        }
                    }
                    // `B4.expandIndex`：等价润乾的 `&B4`
                    Some(Prop::ExpandIndex) => match self.anchor_instance(target, cur) {
                        Some(a) => Val::Num(self.insts[a].expand_index as f64),
                        None => Val::Null,
                    },
                    // 无后缀：返回格集本身，由使用场景决定取可见值（anchor）还是遍历全部
                    None => {
                        let anchor = self.anchor_instance(target, cur);
                        // 成员判断在**这里**做一次（二分）：放到 `scalar` 里做就是
                        // 每个明细行扫一遍整列。anchor 不在结果集里时退回首格，
                        // 与原来 `anchor.filter(contains).or(first)` 的口径一致。
                        let pick = match anchor {
                            Some(a) if cells.binary_search(&a).is_ok() => Some(a),
                            _ => cells.first().copied(),
                        };
                        Val::Set { cells, pick }
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
                    .iter()
                    .copied()
                    .filter(|&cand| self.eval_ast(cond, cand, cur).truthy())
                    .collect();
                let pick = kept.first().copied();
                Val::Set { cells: Rc::from(kept), pick }
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
                // 无层次坐标时整列数字已缓存：「比我大的有几个」退化成一个分区点。
                //
                // 顺序不能反：`cached_numbers` 返回的是活借用，拿在手上再进
                // `anchor_number_of`（内部要借 `pos_index`）会让 RefCell panic。
                let x = match &args[0] {
                    Expr::Cell { coord: None, .. } => self.anchor_number_of(&args[0], cur, outer),
                    _ => None,
                };
                if let Some(x) = x {
                    let greater = self
                        .cached_numbers(args)
                        .map(|n| n.sorted.len() - n.sorted.partition_point(|v| *v <= x));
                    if let Some(g) = greater {
                        return Val::Num(1.0 + g as f64);
                    }
                }
                let nums = self.arg_numbers(args, cur, outer);
                let v = self.eval_ast(&args[0], cur, outer).scalar(self).as_num();
                match v {
                    Some(x) => Val::Num(1.0 + nums.iter().filter(|n| **n > x).count() as f64),
                    None => Val::Null,
                }
            }
            "SUM" | "COUNT" | "AVG" | "MIN" | "MAX" => {
                let f = match name {
                    "COUNT" => "count",
                    "AVG" => "avg",
                    "MIN" => "min",
                    "MAX" => "max",
                    _ => "sum",
                };
                // 无层次坐标的单参数格集：结果集与 cur 无关，直接读缓存的聚合值。
                // 少了这条，写在明细行上的 `SUM(B2)` 每行都要把整列重扫一遍 → O(n²)。
                //
                // 必须排在 `arg_numbers` 之前：后者本身就是那次 O(n) 的整列扫描，
                // 先算它就等于没优化（第一版就踩了这个，1.3 s 只掉到 1.18 s）。
                if let Some(n) = self.cached_numbers(args) {
                    return Val::Num(match f {
                        "count" => n.count as f64,
                        "avg" if n.count > 0 => n.sum / n.count as f64,
                        "min" => n.min,
                        "max" => n.max,
                        _ => n.sum,
                    });
                }
                // 多参数 / 带层次坐标：退回逐格摊平。复用聚合口径：
                // COUNT 数的是数字个数，MIN/MAX 空集为 NaN
                let nums = self.arg_numbers(args, cur, outer);
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
                        let anchor = self.anchor_instance(target, cur);
                        if coord.is_none() {
                            // 无层次坐标：结果集与 cur 无关，复用索引，总和取前缀和末尾
                            let picked = {
                                let idx = self.pos_index(target);
                                match anchor {
                                    Some(a) if idx.cells.binary_search(&a).is_ok() => Some(a),
                                    _ => idx.cells.first().copied(),
                                }
                            };
                            let n = picked.and_then(|i| as_number(self.insts[i].value.clone()));
                            // 分两步写：`pos_index` 的 Ref 活到语句末尾，和 prefix_sum 的
                            // borrow_mut 挤在一条表达式里会让 RefCell panic
                            let len = self.pos_index(target).cells.len();
                            (n, self.prefix_sum(target, len))
                        } else {
                            let cells = self.resolve(target, coord.as_ref(), cur);
                            let picked = anchor
                                .filter(|a| cells.binary_search(a).is_ok())
                                .or_else(|| cells.first().copied());
                            let n = picked.and_then(|i| as_number(self.insts[i].value.clone()));
                            (n, self.aggregate_cells(&cells, "sum"))
                        }
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
                    if coord.is_some() {
                        // 有层次坐标：结果集随 cur 变，索引不成立，退回朴素实现
                        let cells = self.resolve(target, coord.as_ref(), cur);
                        let upto = match self.anchor_instance(target, cur) {
                            Some(a) => cells.iter().position(|c| *c == a).map(|p| p + 1),
                            None => None,
                        };
                        let n = upto.unwrap_or(cells.len()).min(cells.len());
                        return Val::Num(
                            cells[..n]
                                .iter()
                                .filter_map(|i| as_number(self.insts[*i].value.clone()))
                                .sum(),
                        );
                    }
                    // 先算 anchor（内部要借索引），再拿索引求位置，最后取前缀和。
                    // 顺序不能改：`pos_index` 的不可变借用还没放就拿可变借用会 panic。
                    let anchor = self.anchor_instance(target, cur);
                    let n = {
                        let idx = self.pos_index(target);
                        match anchor {
                            Some(a) => match idx.cells.binary_search(&a) {
                                Ok(p) => p + 1,
                                // anchor 被删了不在结果集里 → 与朴素实现一致：算全部
                                Err(_) => idx.cells.len(),
                            },
                            None => idx.cells.len(),
                        }
                    };
                    Val::Num(self.prefix_sum(target, n))
                }
                _ => Val::Null,
            },
            _ => Val::Null,
        }
    }

    /// 层次坐标 → 实例下标集合（升序）。
    ///
    /// 被测试表达式删掉的格不出现在结果里：它们既不出表，也不该进合计。
    ///
    /// 返回 `Rc` 而不是 `Vec`：无层次坐标时结果集就是 `PosIndex::cells`，
    /// 共享一份即可。明细行上的每个表达式都会走这里，逐行克隆整列是 O(n²)。
    fn resolve(&self, target: &str, coord: Option<&Coord>, cur: usize) -> Rc<[usize]> {
        match coord {
            None => self.pos_index(target).cells.clone(),
            Some(cd) => {
                let v: Vec<usize> = self
                    .resolve_raw(target, Some(cd), cur)
                    .into_iter()
                    .filter(|&i| !self.insts[i].hidden)
                    .collect();
                debug_assert!(
                    v.windows(2).all(|w| w[0] < w[1]),
                    "带层次坐标的结果集也必须升序，否则二分成员判断会出错"
                );
                Rc::from(v)
            }
        }
    }

    /// `excel_of` 专用路径：`resolve(target, coord, cur)` 的结果只取决于
    /// `(target, coord, anchor_instance)`，与 `cur` 是哪个**具体**实例无关
    /// （只要它的祖先链能走到同一个 anchor，结果集就一样）。
    ///
    /// 缓存命中后整次 resolve 缩成「沿祖链走一遍 → HashMap 查表」，
    /// 把「同组 N 个明细行各跑一遍完整 resolve」从 O(N × |结果集|) 降到 O(N × depth)。
    ///
    /// 顺便把 `excel_refs` 也一起缓存：cells 命中后还要走一遍 sort+dedup+windows
    /// 才有 `SUM(C1:C8)` 这种引用串，N 个明细行各做一遍就是 O(N² log N)。
    /// 把 (cells, refs) 打包缓存 → 命中后整次降到 O(1)。
    ///
    /// 只在 phase 4（导出公式生成）这一个 pass 里有用；这个 pass 不会改 hidden，
    /// 所以「ancestor chain + descendants.get(target) + hidden filter」三件套
    /// 对同一个 (target, coord, anchor) 始终给出同一份答案。
    fn resolve_for_excel(&self, target: &str, coord: &Coord, cur: usize) -> Option<(Rc<[usize]>, Option<String>)> {
        let anchor = self.find_anchor(coord, cur)?;
        let key = (target.to_string(), coord.clone(), anchor);
        if let Some(cached) = self.excel_resolve_cache.borrow().get(&key) {
            return Some(cached.clone());
        }
        let raw = self.insts[anchor].descendants.get(target).cloned().unwrap_or_default();
        let v: Vec<usize> = raw.into_iter().filter(|&i| !self.insts[i].hidden).collect();
        debug_assert!(
            v.windows(2).all(|w| w[0] < w[1]),
            "带层次坐标的结果集也必须升序，否则二分成员判断会出错"
        );
        let refs = self.excel_refs(&v);
        let rc: Rc<[usize]> = Rc::from(v);
        let val = (rc, refs);
        self.excel_resolve_cache.borrow_mut().insert(key, val.clone());
        Some(val)
    }

    /// 提取 anchor 查找：和 `resolve_raw` 共用同一段祖先链逻辑。
    /// 返回 `None` 表示找不到 coord 指定的同名主格。
    fn find_anchor(&self, cd: &Coord, cur: usize) -> Option<usize> {
        if self.insts[cur].pos == cd.pos {
            return Some(cur);
        }
        let mut p = self.insts[cur].parent;
        while let Some(pi) = p {
            if self.insts[pi].pos == cd.pos {
                return Some(pi);
            }
            p = self.insts[pi].parent;
        }
        let mut cp = self.insts[cur].col_parent;
        while let Some(ci) = cp {
            if self.insts[ci].pos == cd.pos {
                return Some(ci);
            }
            cp = self.insts[ci].col_parent;
        }
        None
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
/// 按字段分组去重，**保持首次出现顺序**。
///
/// 用哈希索引定位已有分组：原来写的是 `out.iter_mut().find(|(k, ..)| *k == key)`，
/// 那是「行数 × 组数」的平方级开销——16000 个唯一值时要跑约 1.3e8 次字符串比较，
/// 而这段又在每个展开格的展开路径上。换成索引后是 O(行数)。
/// 分组顺序不受影响（仍是首次出现顺序），只是查表不再线性扫。
fn group_by_field(ds: &DataSet, view: &[usize], field: &str) -> Vec<(JsonValue, Vec<usize>)> {
    let mut out: Vec<(JsonValue, Vec<usize>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for r in view {
        let val = ds.get(*r).and_then(|row| row.get(field)).cloned().unwrap_or(JsonValue::Null);
        let key = match &val {
            JsonValue::Null => "\u{0}null".to_string(),
            JsonValue::String(s) => format!("s:{s}"),
            other => format!("v:{other}"),
        };
        match index.get(&key) {
            Some(&i) => out[i].1.push(*r),
            None => {
                index.insert(key, out.len());
                out.push((val, vec![*r]));
            }
        }
    }
    out
}

/// 表达式是否「与当前格无关」——只看它引用的格有没有层次坐标。
///
/// 有层次坐标（`B2[A2:-1]`）时 `resolve` 的结果随当前格变，依赖集不能跨行复用；
/// `Filter` 的候选集是运行期才知道的，一律按「有关」保守处理。
fn expr_is_cur_independent(e: &Expr) -> bool {
    match e {
        Expr::Cell { coord, .. } => coord.is_none(),
        Expr::Call { args, .. } => args.iter().all(expr_is_cur_independent),
        Expr::Binary { lhs, rhs, .. } | Expr::Cmp { lhs, rhs, .. } => {
            expr_is_cur_independent(lhs) && expr_is_cur_independent(rhs)
        }
        Expr::Neg(inner) | Expr::Dollar(inner) => expr_is_cur_independent(inner),
        Expr::Num(_) | Expr::Str(_) | Expr::SelfValue => true,
        Expr::Filter { .. } => false,
    }
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

// ───────── 规模相关的测试：大数据量下的正确性 + 性能基准 ─────────
//
// 性能部分的背景：backlog 里挂着「表达式缓存 / 增量重算（纯性能）」。
// 但性能优化得先拿数据证明它值得做，否则就是凭手感往引擎里加复杂度。
// 这里用**真实的**「交叉表 + 行列合计」模板（含 `B3[A3:+0].sum()` 这类
// 层次坐标聚合，正是最可疑的热路径），只把数据量按 R 个地区 × M 个月放大。
//
// 正确性部分：其余测试的数据集都很小（2×2 那种），下标错位之类的问题
// 在小数据上经常刚好抵消掉。这里用 40×20 = 800 个数值格压一遍。
//
// 跑基准（release 才有意义，debug 的常数因子会掩盖真实曲线）：
//   cargo test --release -- --ignored --nocapture --test-threads=1 bench_
#[cfg(test)]
mod scale {
    use super::*;
    use crate::report::cross_tab_totals_template;
    use std::time::Instant;

    /// R 个地区 × M 个月，每个 (地区, 月) 组合唯一——与 `cross_tab_totals_template`
    /// 里数值格 `agg: None` 的语义一致（它要求交集唯一，否则该聚合）。
    fn scaled_data(regions: usize, months: usize) -> DataSet {
        let mut ds = DataSet::new();
        for r in 0..regions {
            for m in 0..months {
                let mut row = DataRow::new();
                row.insert("id".into(), JsonValue::from(format!("R{r:04}M{m:03}")));
                row.insert("region".into(), JsonValue::from(format!("R{r:04}")));
                row.insert("month".into(), JsonValue::from(format!("M{m:03}")));
                row.insert("amount".into(), JsonValue::from((r * months + m + 1) as f64));
                row.insert("qty".into(), JsonValue::from(1.0));
                ds.push(row);
            }
        }
        ds
    }

    /// 表达式密集模板：**每个明细行**都带两个 value_expr 计算列。
    ///
    /// 为什么单列这个场景：场景 A（交叉表合计）只有 R+M+1 个表达式格，
    /// 无论数据多大，表达式求值次数都是 O(R+M)——量不出表达式本身的开销。
    /// 「表达式缓存」这类优化只在这种「表达式格数与数据行数同阶」时才可能见效。
    ///
    /// `with_expr = false` 时把两个计算列换成**普通字段列**：实例数完全一样，
    /// 唯一差别是「有没有表达式要求值」。两次耗时之差就是表达式求值的真实成本。
    fn expr_heavy_sheet(with_expr: bool) -> SheetTpl {
        let m = |field: Option<&str>, expand: Option<ExpandType>, expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                expand_type: expand,
                value_expr: expr.map(|s| s.to_string()),
                ..Default::default()
            })
        };
        // 有表达式 → 用 value_expr；无表达式 → 退回普通字段列，保证实例数不变
        let calc = |expr: &'static str| {
            if with_expr {
                m(None, None, Some(expr))
            } else {
                m(Some("amount"), None, None)
            }
        };
        let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
            pos: None,
            value: value.map(JsonValue::from),
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        SheetTpl {
            name: "表达式密集".to_string(),
            page: None,
            rows: vec![
                RowTpl {
                    cells: vec![
                        cell(Some("序号"), None),
                        cell(Some("金额"), None),
                        cell(Some("翻倍"), None),
                        cell(Some("占比"), None),
                    ],
                },
                RowTpl {
                    cells: vec![
                        cell(None, m(Some("id"), Some(ExpandType::R), None)),
                        cell(None, m(Some("amount"), None, None)),
                        // 每个明细行各算一次：层次坐标 + 聚合 + 四则运算
                        cell(None, calc("B2[A2:+0].sum() * 2")),
                        cell(None, calc("B2[A2:+0].sum() / 100")),
                    ],
                },
            ],
        }
    }

    /// 累计（ACCSUM）模板：每个明细行算一次「从头累计到当前行」。
    ///
    /// 这是「累计」类报表的自然写法，也是最容易踩到平方级的形状：ACCSUM 内部要
    /// `cells.iter().position(|c| *c == anchor)` 找当前行在结果集里的位置，
    /// 而结果集是**全部**明细行——每行都从头扫一遍就是 O(n²)。
    /// `with_expr = false` 时把累计列换成普通字段列，用来隔离出 ACCSUM 的成本。
    fn accsum_sheet(with_expr: bool) -> SheetTpl {
        per_row_agg_sheet(if with_expr { Some("ACCSUM(B2)") } else { None })
    }

    /// `calc = None` 时第三列是普通字段列，用来隔离出聚合函数本身的成本。
    fn per_row_agg_sheet(calc: Option<&str>) -> SheetTpl {
        let m = |field: Option<&str>, expand: Option<ExpandType>, expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                expand_type: expand,
                value_expr: expr.map(|s| s.to_string()),
                ..Default::default()
            })
        };
        let calc = || match calc {
            Some(e) => m(None, None, Some(e)),
            None => m(Some("amount"), None, None),
        };
        let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
            pos: None,
            value: value.map(JsonValue::from),
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        SheetTpl {
            name: "累计".to_string(),
            page: None,
            rows: vec![
                RowTpl {
                    cells: vec![
                        cell(Some("序号"), None),
                        cell(Some("金额"), None),
                        cell(Some("累计"), None),
                    ],
                },
                RowTpl {
                    cells: vec![
                        cell(None, m(Some("id"), Some(ExpandType::R), None)),
                        cell(None, m(Some("amount"), None, None)),
                        cell(None, calc()),
                    ],
                },
            ],
        }
    }

    /// 返回 (物理行数, 非空格数, 耗时 ms, 实例数)
    fn time_sheet(sheet: &SheetTpl, ds: DataSet) -> (usize, usize, f64, usize) {
        let t = Instant::now();
        let mut engine = Engine::new(ds);
        let grid = engine.expand_sheet(sheet);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let cells: usize = grid.iter().map(|r| r.len()).sum();
        (grid.len(), cells, ms, engine.insts.len())
    }

    /// 返回 (物理行数, 非空格数, 耗时 ms, 实例数)
    fn time_one(regions: usize, months: usize) -> (usize, usize, f64, usize) {
        let sheet = cross_tab_totals_template().sheets.into_iter().next().unwrap();
        time_sheet(&sheet, scaled_data(regions, months))
    }

    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_expand_scales() {
        println!("\n   地区 × 月份     物理行    非空格    实例数    耗时(ms)   每实例(µs)");
        // 每次规模都翻倍左右，方便一眼看出是 O(n) 还是 O(n²)：
        // 规模翻倍时，线性 → 耗时翻倍；平方 → 耗时翻四倍。
        for (r, m) in [(10, 5), (20, 10), (40, 20), (80, 40), (160, 80)] {
            let (rows, cells, ms, insts) = time_one(r, m);
            let per = if insts > 0 { ms * 1000.0 / insts as f64 } else { 0.0 };
            println!("  {r:>5} × {m:<5}  {rows:>7}  {cells:>8}  {insts:>8}  {ms:>9.1}  {per:>10.3}");
        }
        println!();
    }

    /// 交叉表的**形状依赖**：总量固定（约 20 万实例），只改「地区数 × 月份数」的比例。
    ///
    /// 存在的理由：交叉表每个数值格都要做「行主格 ∩ 列主格」求交。若实现是
    /// 「每个 (行主格 × 列主格) 组合都把行主格的行集扫一遍」，总成本就是
    /// O(R×M×M) —— 总量固定时**仍与 M 成正比**。这个基准正是用来暴露它的：
    /// 只看「总量 vs 耗时」看不出来，因为总量被钉死了。
    ///
    /// 优化前（分桶前）：705 / 483 / 362 / 303 ms，与 M 同向变化；
    /// 改成「一次分桶」后应当基本持平。
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_cross_tab_shape() {
        println!("\n   地区 × 月份    物理行     实例数    耗时(ms)   每实例(µs)");
        for (r, m) in [(640usize, 320usize), (1280, 160), (2560, 80), (5120, 40)] {
            let (rows, _cells, ms, insts) = time_one(r, m);
            let per = if insts > 0 { ms * 1000.0 / insts as f64 } else { 0.0 };
            println!("  {r:>5} × {m:<5}  {rows:>7}  {insts:>8}  {ms:>9.1}  {per:>10.3}");
        }
        println!();
    }

    /// 只跑最大规模，重复多次，用来对比「优化前 / 优化后」的单一数字
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_expand_single() {
        let (r, m) = (160usize, 80usize);
        let mut best = f64::MAX;
        for _ in 0..5 {
            let (rows, cells, ms, insts) = time_one(r, m);
            if ms < best {
                best = ms;
                println!("  {r}×{m}: {rows} 行 / {cells} 非空格 / {insts} 实例 → {ms:.1} ms");
            }
        }
        println!("  最优 {best:.1} ms\n");
    }

    /// 表达式密集场景的规模曲线：N 个明细行，每行 2 个 value_expr。
    /// 这里如果看到明显的超线性（规模翻倍 → 耗时翻四倍），
    /// 才说明「表达式缓存 / 增量重算」值得做。
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_expr_heavy() {
        let sheet = expr_heavy_sheet(true);
        println!("\n   明细行数    物理行    非空格    实例数    耗时(ms)   每实例(µs)");
        for n in [1000usize, 2000, 4000, 8000, 16000] {
            let (rows, cells, ms, insts) = time_sheet(&sheet, scaled_data(n, 1));
            let per = if insts > 0 { ms * 1000.0 / insts as f64 } else { 0.0 };
            println!("  {n:>8}  {rows:>7}  {cells:>8}  {insts:>8}  {ms:>9.1}  {per:>10.3}");
        }
        println!();
    }

    /// 把「表达式求值」从总耗时里摘出来：同一批数据、同样的实例数，
    /// 只切换计算列「是 value_expr」还是「普通字段」。
    /// 两者之差就是表达式求值的真实成本，也是「表达式缓存」能省下的上限。
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_expr_cost() {
        let with = expr_heavy_sheet(true);
        let without = expr_heavy_sheet(false);
        println!("\n   明细行数   无表达式(ms)  有表达式(ms)   表达式成本(ms)   占总量");
        for n in [1000usize, 4000, 16000] {
            let ds = scaled_data(n, 1);
            // 取 3 次最优，压掉调度抖动
            let mut a = f64::MAX;
            let mut b = f64::MAX;
            for _ in 0..3 {
                a = a.min(time_sheet(&without, ds.clone()).2);
                b = b.min(time_sheet(&with, ds.clone()).2);
            }
            let cost = b - a;
            let pct = if b > 0.0 { cost / b * 100.0 } else { 0.0 };
            println!("  {n:>8}  {a:>11.1}  {b:>11.1}  {cost:>14.1}  {pct:>6.1}%");
        }
        println!();
    }

    /// 累计（ACCSUM）场景的规模曲线。
    ///
    /// 这是上一轮「同一类写法还有没有别处」的收尾：`ACCSUM` 找当前位置用的是
    /// `cells.iter().position(..)`，而 `cells` 是全部明细行——若真是平方级，
    /// 规模翻倍时「累计成本」会翻四倍。先量，再决定改不改。
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_accsum() {
        let with = accsum_sheet(true);
        let without = accsum_sheet(false);
        println!("\n   明细行数   无累计(ms)   有累计(ms)   累计成本(ms)   每行(µs)");
        for n in [1000usize, 2000, 4000, 8000, 16000] {
            let ds = scaled_data(n, 1);
            // 取 3 次最优，压掉调度抖动
            let mut a = f64::MAX;
            let mut b = f64::MAX;
            for _ in 0..3 {
                a = a.min(time_sheet(&without, ds.clone()).2);
                b = b.min(time_sheet(&with, ds.clone()).2);
            }
            let cost = b - a;
            let per = cost * 1000.0 / n as f64;
            println!("  {n:>8}  {a:>10.1}  {b:>11.1}  {cost:>13.1}  {per:>9.3}");
        }
        println!();
    }

    /// 同形状的其余「写在明细行上」的聚合函数：PROPORTION / RANK / SUM。
    ///
    /// ACCSUM 量完自然要问一句：同类的还有没有落下的？PROPORTION 原来有
    /// `cells.contains(..)` 加一遍求和，RANK 要数「比我大的有几个」——
    /// 都是每行 O(n) 的形状。这里一次性量完，别再靠猜。
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_per_row_agg() {
        let kinds = [
            ("ACCSUM(B2)", "累计"),
            ("PROPORTION(B2)", "占比"),
            ("RANK(B2)", "排名"),
            ("SUM(B2)", "整列求和"),
        ];
        let base = per_row_agg_sheet(None);
        println!("\n   明细行数  {}{}", "", "");
        let mut head = format!("  明细行数");
        for (_, label) in &kinds {
            head.push_str(&format!("  {label:>12}"));
        }
        println!("{head}");
        for n in [4000usize, 8000, 16000] {
            let ds = scaled_data(n, 1);
            let mut a = f64::MAX;
            for _ in 0..3 {
                a = a.min(time_sheet(&base, ds.clone()).2);
            }
            let mut line = format!("  {n:>8}");
            for (expr, _) in &kinds {
                let sheet = per_row_agg_sheet(Some(expr));
                let mut b = f64::MAX;
                for _ in 0..3 {
                    b = b.min(time_sheet(&sheet, ds.clone()).2);
                }
                line.push_str(&format!("  {:>11.1}ms", (b - a).max(0.0)));
            }
            println!("{line}");
        }
        println!();
    }

    /// 明细行上**引用兄弟格**的规模曲线。
    ///
    /// 为什么单独量：上一轮的「表达式密集」基准用的是 `B2[A2:+0].sum()`，
    /// 带层次坐标 → 每次只解析出**当前组**那一行，解析结果恒为 1 格。
    /// 也就是说那个基准从来没覆盖过「不带坐标地引用另一个格」—— 而这才是
    /// 明细行表达式最常见的写法（`B2 * 2`、`IF(B2>100, B2, 0)`）。
    /// 不带坐标时 `resolve` 返回的是**整列**，每行克隆一遍 + 线性 `contains`
    /// 找自己，是 O(n²) 的形状。量了才知道是不是真烫。
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_sibling_ref() {
        const KINDS: &[(&str, &str)] = &[
            ("B2 * 2", "兄弟格算术"),
            ("B2 + B2", "引用两遍"),
            ("IF(B2 > 100, B2, 0)", "条件取兄弟格"),
            ("B2.sum()", "整列聚合(无坐标)"),
        ];
        let base = per_row_agg_sheet(None);
        let mut head = String::from("  明细行数");
        for (_, label) in KINDS {
            head.push_str(&format!("  {label:>16}"));
        }
        println!("\n{head}");
        for n in [4000usize, 8000, 16000] {
            let ds = scaled_data(n, 1);
            let mut a = f64::MAX;
            for _ in 0..3 {
                a = a.min(time_sheet(&base, ds.clone()).2);
            }
            let mut line = format!("  {n:>8}");
            for (expr, _) in KINDS {
                let sheet = per_row_agg_sheet(Some(expr));
                let mut b = f64::MAX;
                for _ in 0..3 {
                    b = b.min(time_sheet(&sheet, ds.clone()).2);
                }
                line.push_str(&format!("  {:>15.1}ms", (b - a).max(0.0)));
            }
            println!("{line}");
        }
        println!();
    }

    /// 大数据量下的正确性：40×20 交叉表，800 个数值格。
    ///
    /// 小数据集掩盖得了的错位（行/列下标串了、合计少算一个格），
    /// 在 800 个格子上很难再凑巧对上。同时守住三个口径互相一致：
    /// 所有行合计之和 == 所有列合计之和 == 总计。
    #[test]
    fn cross_tab_totals_are_consistent_at_scale() {
        const R: usize = 40;
        const M: usize = 20;
        let sheet = cross_tab_totals_template().sheets.into_iter().next().unwrap();
        let mut engine = Engine::new(scaled_data(R, M));
        let grid = engine.expand_sheet(&sheet);

        let nums: Vec<f64> = grid
            .iter()
            .flat_map(|row| row.iter().filter_map(|c| c.raw_number))
            .collect();
        // R*M 个交叉格 + R 个行合计 + M 个列合计 + 1 个总计
        assert_eq!(nums.len(), R * M + R + M + 1, "数值格数量不对");

        // 数据是 1..=R*M 的连续整数，总计就是等差数列和
        let total = (R * M * (R * M + 1) / 2) as f64;
        let has = |want: f64| nums.iter().any(|v| (v - want).abs() < 0.5);
        assert!(has(total), "总计 {total} 未出现在网格里");

        // 第 r 个地区的金额是 r*M+1 ..= r*M+M
        let row_totals: Vec<f64> = (0..R)
            .map(|r| ((r * M + 1)..=(r * M + M)).sum::<usize>() as f64)
            .collect();
        for rt in &row_totals {
            assert!(has(*rt), "行合计 {rt} 未出现在网格里");
        }
        // 行合计之和 == 总计（列合计口径由「数值格数量 + 总计」间接守住）
        assert!((row_totals.iter().sum::<f64>() - total).abs() < 0.5);
    }

    /// `ACCSUM` 的累计值必须是「从第 1 行加到当前行」。
    ///
    /// 为什么单独测：这轮优化把每行一次的「扫描找位置 + 从头求和」换成了缓存里的
    /// 前缀和。位置算错一格、前缀和长歪一节，出来的**依然是一串看着很正常的递增
    /// 数列**，只是整体错位——这种错误读报表几乎发现不了，只能把具体数值钉死。
    #[test]
    fn accsum_running_totals_are_exact() {
        const N: usize = 12;
        let sheet = accsum_sheet(true);
        let mut engine = Engine::new(scaled_data(N, 1));
        let grid = engine.expand_sheet(&sheet);

        // 第 0 行是表头（序号 / 金额 / 累计），后面 N 行是明细
        assert_eq!(grid.len(), N + 1, "物理行数不对：{}", grid.len());

        for k in 0..N {
            let nums: Vec<f64> = grid[k + 1].iter().filter_map(|c| c.raw_number).collect();
            assert_eq!(
                nums.len(),
                2,
                "第 {k} 行应有「金额 / 累计」两个数值，实际 {nums:?}"
            );
            let amount = (k + 1) as f64;
            let want = ((k + 1) * (k + 2) / 2) as f64;
            assert!(
                (nums[0] - amount).abs() < 1e-6,
                "第 {k} 行金额 {} != {amount}",
                nums[0]
            );
            assert!(
                (nums[1] - want).abs() < 1e-6,
                "第 {k} 行累计 {} 应为 {want}（前 {} 行之和）",
                nums[1],
                k + 1
            );
        }

        // 最后一个累计值必须等于全部金额之和，否则「错位但递增」照样能骗过上面
        let all: f64 = (1..=N).sum::<usize>() as f64;
        let last: Vec<f64> = grid[N].iter().filter_map(|c| c.raw_number).collect();
        assert!((last[1] - all).abs() < 1e-6, "末行累计 {} != 总额 {all}", last[1]);
    }

    /// 写在明细行上的整列聚合，逐格数值都要和「手算」一致。
    ///
    /// 为什么单独测：这些函数现在走 `PosIndex::nums` 缓存。缓存要是建早了（依赖格
    /// 还没求值）或者聚合口径写错，结果是**每一行都错成同一个数** —— 看着仍是
    /// 「一列整齐的合计」，在真报表里几乎发现不了，只能把具体数值钉死。
    #[test]
    fn per_row_aggregates_match_row_by_row() {
        const N: usize = 12;
        let ds = scaled_data(N, 1);
        // scaled_data(n, 1) 的 amount 就是 1..=n，第 k 行（0 起）的 B2 是 k+1
        let total: f64 = (1..=N).sum::<usize>() as f64;

        let cases: Vec<(&str, Box<dyn Fn(usize) -> f64>)> = vec![
            ("SUM(B2)", Box::new(|_| total)),
            ("COUNT(B2)", Box::new(|_| N as f64)),
            ("AVG(B2)", Box::new(|_| total / N as f64)),
            ("MIN(B2)", Box::new(|_| 1.0)),
            ("MAX(B2)", Box::new(|_| N as f64)),
            // 降序名次：值 k+1 在 1..=N 里排第 N-k（12 排第 1，1 排第 12）
            ("RANK(B2)", Box::new(|k| (N - k) as f64)),
            ("PROPORTION(B2)", Box::new(|k| (k + 1) as f64 / total)),
            // 下面两条是「引用兄弟格」：裸 `B2` 必须是**当前行**的 B2，
            // 不能串成全局第一行的 B2（NopReport 的可见性语义）
            ("B2 * 2", Box::new(|k| (k + 1) as f64 * 2.0)),
            // 属性写法的整列聚合，和 `SUM(B2)` 是两条代码路径
            ("B2.sum()", Box::new(|_| total)),
            ("B2.count()", Box::new(|_| N as f64)),
        ];

        for (expr, want) in &cases {
            let sheet = per_row_agg_sheet(Some(expr));
            let mut engine = Engine::new(ds.clone());
            let grid = engine.expand_sheet(&sheet);
            assert_eq!(grid.len(), N + 1, "{expr}：物理行数不对 {}", grid.len());
            for k in 0..N {
                let nums: Vec<f64> = grid[k + 1].iter().filter_map(|c| c.raw_number).collect();
                assert_eq!(
                    nums.len(),
                    2,
                    "{expr}：第 {k} 行应有「金额 / 聚合」两个数值，实际 {nums:?}"
                );
                let got = nums[1];
                let want = want(k);
                assert!((got - want).abs() < 1e-6, "{expr}：第 {k} 行 {got} != {want}");
            }
        }
    }

    /// `excel_formula` 形状基准：所有明细行同属一个分组，
    /// 每个明细行都开 `export_formula`，表达式是「本组金额求和」。
    ///
    /// 关键：**同一个表达式 (`C1[A1:+0].sum()`) 在 n 个实例上上**。
    /// `excel_of` 在每个实例里都调用 `resolve(C1, [+0], cur)`，
    /// 而 N 个 cur 共享同一个 A1 主格实例 → resolve_raw 返回的 cells 都是同一个 n 元集。
    /// 这意味着同一份答案算了 n 遍 —— 是经典的「按 key 缓存结果集」场景。
    ///
    /// 优化前预测：n² 量级（每次 resolve 是 O(n)，n 个实例各跑一次 → O(n²)）。
    /// 优化后：缓存命中，单次 resolve 缩成「祖链 + 一次 HashMap 查表」+ O(1) 的 refs 字符串，
    /// 总成本 O(n × depth)，常数非常小。
    /// 不开 export_formula 时这个开销根本不存在，所以「with - without」就是
    /// `excel_of` 的真实成本。
    #[test]
    #[ignore = "性能基准，手动跑：见本模块头部注释"]
    fn bench_excel_formula() {
        let with = export_formula_sheet(true);
        let without = export_formula_sheet(false);
        println!("\n   明细行数  无公式(ms)  有公式(ms)  公式成本(ms)  每行(µs)  公式实例数");
        for n in [250usize, 500, 1000, 2000, 4000] {
            let ds = one_group_data(n);
            let mut a = f64::MAX;
            let mut b = f64::MAX;
            for _ in 0..3 {
                a = a.min(time_sheet(&without, ds.clone()).2);
                b = b.min(time_sheet(&with, ds.clone()).2);
            }
            let cost = b - a;
            let per = cost * 1000.0 / n as f64;
            // 公式实例数：每条数据产生 1 个 value_expr 实例（小计格）
            let formula_instances = n;
            println!(
                "  {n:>8}  {a:>10.1}  {b:>10.1}  {cost:>11.1}  {per:>9.3}  {formula_instances:>8}"
            );
        }
        println!();
    }

    /// 一组：1 个分组主格 + N 个明细行（ID/金额/小计）。所有明细行同属一组。
    ///
    /// `value_expr` 配 `export_formula` 时，每个明细行的小计格都要翻成
    /// `SUM(B<首>:B<末>)` —— 同一组里 N 个 cell 的公式**字符串完全一样**，
    /// 因为它们的 anchor（A2 实例）相同。
    ///
    /// 模板分两行模板：第 1 行是分组主格（A2 = g 字段），
    /// 第 2 行是明细行（A3 = id 字段 + row_parent=A2）。
    /// 明细行的「小计」用 `B3[A2:+0].sum()`，跨整组汇总 —— 这是要测的热点路径。
    fn one_group_data(n: usize) -> DataSet {
        let mut ds = DataSet::new();
        for i in 0..n {
            let mut row = DataRow::new();
            row.insert("id".into(), JsonValue::from(format!("R{i:04}")));
            row.insert("g".into(), JsonValue::from("G0"));
            row.insert("amount".into(), JsonValue::from((i + 1) as f64));
            ds.push(row);
        }
        ds
    }

    fn export_formula_sheet(enable: bool) -> SheetTpl {
        // yoy 的单行模板：A1=g（分组主格）、B1=id（明细主格，parent=A1）、
        // C1=amount（parent=B1）、D1=value_expr(parent=B1)。
        // 数据 N 行全部 g=G0 → A1 只展开 1 次，但 B1/C1/D1 各展开 N 次。
        // D1 的 `C1[A1:+0].sum()` 对 N 个明细行都解析到同一组 C1 集合 —— 这是要测的冗余。
        let m = |field: Option<&str>,
                 expand: Option<ExpandType>,
                 parent: Option<&str>,
                 expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                expand_type: expand,
                row_parent: parent.map(|s| s.to_string()),
                value_expr: expr.map(|s| s.to_string()),
                export_formula: if enable && expr.is_some() { Some(true) } else { None },
                ..Default::default()
            })
        };
        let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
            pos: None,
            value: value.map(JsonValue::from),
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        SheetTpl {
            name: "exp".to_string(),
            page: None,
            rows: vec![RowTpl {
                cells: vec![
                    cell(Some("分组"), m(Some("g"), Some(ExpandType::R), None, None)),
                    cell(Some("ID"), m(Some("id"), Some(ExpandType::R), Some("A1"), None)),
                    cell(Some("金额"), m(Some("amount"), None, Some("B1"), None)),
                    cell(
                        Some("小计"),
                        m(None, None, Some("B1"), Some("C1[A1:+0].sum()")),
                    ),
                ],
            }],
        }
    }

    /// 同组 N 个明细行 → 公式字符串必须一致，且覆盖全部 N 个 C1 实例。
    #[test]
    fn excel_formula_per_row_in_one_group_matches() {
        const N: usize = 8;
        let sheet = export_formula_sheet(true);
        let mut engine = Engine::new(one_group_data(N));
        let grid = engine.expand_sheet(&sheet);
        // N 个明细行（每个数据行产生一行，A1=G0 在每行展示）
        assert_eq!(grid.len(), N, "grid 行数：实际 {}", grid.len());
        // C1 列在 col 2，公式 `C1[A1:+0].sum()` 翻成 SUM(C1:C(N))
        let want = format!("SUM(C1:C{N})");
        for k in 0..N {
            let row = &grid[k];
            let formula = row[3].formula.clone();
            assert_eq!(
                formula.as_deref(),
                Some(want.as_str()),
                "第 {k} 行小计公式：实际 {formula:?}，期望 {want:?}"
            );
        }
    }
}
