//! 服务端图表：把「模板坐标」解析成展开后的真实数据。
//!
//! ## 为什么要有这一层
//!
//! 图表画的是**展开之后**的数据（3 个地区 → 3 根柱子），而作者写模板时只知道
//! 模板坐标（`A3` = 地区列）。`GridCell.pos` 保留了模板坐标，所以
//! 「`A3` 展开成了哪几个输出格」是可以反查的 —— 于是图表能在**服务端**解析出
//! 真实数据，不必让前端把图栅格化成 PNG 再塞回来。
//!
//! ## 为什么是纯函数
//!
//! 输入 = 声明 + 一张「位置名 → 输出格序列」的索引，输出 = `ResolvedChart`
//! 或一句人话错误。不碰 IO、不碰 DOM，单测可以直接喂索引。
//! 和 `csv.rs` / `xlsx.rs` 同一个套路：**算法抽出来才测得了**，
//! 埋在引擎里就只能断言「没报错」。
//!
//! ## 两条硬规矩
//!
//! 1. **类目与每条序列必须等长**，否则整张图不出。不截断也不补零 ——
//!    那两种都是「图看着是对的、数据是错的」。
//! 2. **缺测就是缺测**（`null`），不补 0。「空着」和「就是 0」在图上长得一样，
//!    在报表里是两回事。交叉表里「某地区某月没数据」是常态，所以缺测
//!    必须是一等公民，不能靠报错回避。

use std::collections::{BTreeMap, BTreeSet};

use super::model::{CellChart, GridCell, ResolvedChart, ResolvedChartSeries};

/// 认得的图表类型（与前端 `CellChartKind` 一一对应）
pub const KINDS: [&str; 3] = ["bar", "line", "pie"];

/// 作者没写 `kind` 时的缺省类型
const DEFAULT_KIND: &str = "bar";

/// 索引里的一格：只需要「在哪、文本是什么、数值是多少」。
///
/// 刻意不持有 `GridCell` 的引用 —— 索引要在**可变借用网格**的同时存在，
/// 持有引用就借不动了；而文本/数值都是小拷贝，代价可以接受。
#[derive(Debug, Clone, PartialEq)]
pub struct ChartCellRef {
    pub row: usize,
    pub col: usize,
    pub text: String,
    pub number: Option<f64>,
}

/// 位置名 → 该模板格展开出来的所有输出格（按 `(行, 列)` 升序）
pub type ChartIndex = BTreeMap<String, Vec<ChartCellRef>>;

/// 某个格子作为图表数据源时的数值：`raw_number` 优先，否则把文本解析成数字。
///
/// 为什么 `raw_number` 优先：数值格子的 `text` 是**套过显示格式**的
/// （`1,234.50` / `12.00%`），拿它反解会得到错的数（百分号直接解不出来）。
/// `raw_number` 是格式化之前的原值。
pub fn source_number(cell: &GridCell) -> Option<f64> {
    cell.raw_number.or_else(|| parse_number(&cell.text))
}

/// 文本 → 数字。认不出来返回 `None`（= 缺测），**不猜、不当 0**。
///
/// 只做一件额外的宽容：剥掉千分位逗号（文本型数值列常见 `1,234.5`）。
/// 其余（`12%`、`-`、`暂无`）一律算缺测 —— 猜错是静默的，不猜只是图上有空档。
fn parse_number(text: &str) -> Option<f64> {
    let s = text.trim();
    if s.is_empty() {
        return None;
    }
    let cleaned: String = s.chars().filter(|c| *c != ',').collect();
    cleaned.parse::<f64>().ok()
}

/// 一张图表的声明引用了哪些位置名。
///
/// 引擎据此**只给被引用的位置建索引** —— 大表上把所有格子都克隆一遍文本
/// 是白费力气（而且图表格通常只引用一两列）。
pub fn referenced_positions(decl: &CellChart) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for p in &decl.categories {
        let p = p.trim();
        if !p.is_empty() {
            out.insert(p.to_string());
        }
    }
    for s in &decl.series {
        let p = s.from.trim();
        if !p.is_empty() {
            out.insert(p.to_string());
        }
    }
    out
}

/// 归一化图表类型。缺省 `bar`；**写错就报错**，不悄悄换成柱状图。
fn normalise_kind(kind: Option<&str>) -> Result<String, String> {
    let raw = kind.unwrap_or("").trim().to_ascii_lowercase();
    if raw.is_empty() {
        return Ok(DEFAULT_KIND.to_string());
    }
    if KINDS.contains(&raw.as_str()) {
        Ok(raw)
    } else {
        Err(format!(
            "不认识的图表类型「{}」（只支持 {}）",
            kind.unwrap_or("").trim(),
            KINDS.join(" / ")
        ))
    }
}

/// 按位置名取输出格序列。取不到一律报错，且**把位置名念出来** ——
/// 「图表没出来」而不说哪个坐标写错了，作者只能一行行试。
fn lookup<'a>(
    index: &'a ChartIndex,
    pos: &str,
    self_pos: &str,
) -> Result<&'a [ChartCellRef], String> {
    let key = pos.trim();
    if key.is_empty() {
        return Err("数据来源写了个空的模板位置名".to_string());
    }
    if key == self_pos {
        return Err(format!(
            "图表引用了它自己（{key}）—— 图表格里只有图，没有数据"
        ));
    }
    match index.get(key) {
        Some(v) if !v.is_empty() => Ok(v.as_slice()),
        Some(_) => Err(format!("位置名 {key} 一个格子都没展开出来")),
        None => Err(format!(
            "位置名 {key} 在展开结果里不存在（检查是不是把行列号写错了）"
        )),
    }
}

/// 解析一张图表。`self_pos` 是图表格自己的模板位置名（用于自引用检查）。
///
/// 返回 `Err` 时调用方应当把原因写进该格文本并告警 —— 与图片格同一套约定：
/// **表照常出，但这一格说清楚为什么没图**，不留白（留白看不出是「没配」
/// 还是「配错了」）。
pub fn resolve_chart(
    decl: &CellChart,
    self_pos: &str,
    index: &ChartIndex,
) -> Result<ResolvedChart, String> {
    let kind = normalise_kind(decl.kind.as_deref())?;

    if decl.series.is_empty() {
        return Err("图表没有数据序列（series 是空的）".to_string());
    }
    if kind == "pie" && decl.series.len() > 1 {
        return Err(format!(
            "饼图只能有一条数据序列，实际写了 {} 条",
            decl.series.len()
        ));
    }

    // ---- 类目 ----
    let mut categories: Vec<String> = Vec::new();
    for pos in &decl.categories {
        for c in lookup(index, pos, self_pos)? {
            categories.push(c.text.clone());
        }
    }

    // ---- 序列 ----
    // 先连来源一起收着，报错时才能把「哪条序列、来源是哪个坐标」说清楚。
    let mut resolved: Vec<(String, ResolvedChartSeries)> = Vec::new();
    for s in &decl.series {
        let from = s.from.trim();
        if from.is_empty() {
            return Err("有一条数据序列没写来源（from）".to_string());
        }
        let cells = lookup(index, from, self_pos)?;
        resolved.push((
            from.to_string(),
            ResolvedChartSeries {
                name: s
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .unwrap_or(from)
                    .to_string(),
                data: cells.iter().map(|c| c.number).collect(),
            },
        ));
    }

    // ---- 点数：类目说了算；没写类目就按最长的那条序列 ----
    let n = if categories.is_empty() {
        resolved.iter().map(|(_, s)| s.data.len()).max().unwrap_or(0)
    } else {
        categories.len()
    };
    if n == 0 {
        return Err("图表一个数据点都没有（来源格全是空的）".to_string());
    }
    if categories.is_empty() {
        // 没写类目就用序号 —— 有图总比因为缺标签而不出图强
        categories = (1..=n).map(|i| i.to_string()).collect();
    }

    // ---- 等长检查：不截断、不补零 ----
    for (from, s) in &resolved {
        if s.data.len() != n {
            return Err(format!(
                "类目有 {n} 个，但序列「{}」（来源 {from}）有 {} 个值 —— 类目与数值必须一一对应",
                s.name,
                s.data.len()
            ));
        }
    }

    Ok(ResolvedChart {
        kind,
        categories,
        series: resolved.into_iter().map(|(_, s)| s).collect(),
        title: decl
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一格索引项：`(行, 列, 文本, 数值)`
    fn r(row: usize, col: usize, text: &str, number: Option<f64>) -> ChartCellRef {
        ChartCellRef { row, col, text: text.to_string(), number }
    }

    /// 「地区列 + 金额列」这种最常见的纵向分组：各 3 格
    fn region_index() -> ChartIndex {
        let mut idx = ChartIndex::new();
        idx.insert(
            "A3".to_string(),
            vec![
                r(2, 0, "华东", None),
                r(3, 0, "华北", None),
                r(4, 0, "华南", None),
            ],
        );
        idx.insert(
            "B3".to_string(),
            vec![
                r(2, 1, "1,200", Some(1200.0)),
                r(3, 1, "980", Some(980.0)),
                r(4, 1, "1,530.5", Some(1530.5)),
            ],
        );
        idx
    }

    fn decl(kind: &str, cats: &[&str], series: &[(&str, &str)]) -> CellChart {
        CellChart {
            kind: Some(kind.to_string()),
            categories: cats.iter().map(|s| s.to_string()).collect(),
            series: series
                .iter()
                .map(|(name, from)| super::super::model::CellChartSeries {
                    name: Some(name.to_string()),
                    from: from.to_string(),
                })
                .collect(),
            title: None,
        }
    }

    #[test]
    fn resolves_a_vertical_grouped_report() {
        let ch = resolve_chart(&decl("bar", &["A3"], &[("销售额", "B3")]), "D3", &region_index())
            .expect("应当解析成功");
        assert_eq!(ch.kind, "bar");
        assert_eq!(ch.categories, vec!["华东", "华北", "华南"]);
        assert_eq!(ch.series.len(), 1);
        assert_eq!(ch.series[0].name, "销售额");
        assert_eq!(ch.series[0].data, vec![Some(1200.0), Some(980.0), Some(1530.5)]);
    }

    /// 横向交叉表：类目与数值都在**同一行**上横向铺开，顺序必须是列序
    #[test]
    fn resolves_a_horizontal_crosstab_in_column_order() {
        let mut idx = ChartIndex::new();
        idx.insert(
            "B2".to_string(),
            vec![r(1, 1, "1月", None), r(1, 2, "2月", None), r(1, 3, "3月", None)],
        );
        idx.insert(
            "B3".to_string(),
            vec![
                r(2, 1, "10", Some(10.0)),
                r(2, 2, "20", Some(20.0)),
                r(2, 3, "30", Some(30.0)),
            ],
        );
        let ch = resolve_chart(&decl("line", &["B2"], &[("金额", "B3")]), "F2", &idx)
            .expect("应当解析成功");
        assert_eq!(ch.categories, vec!["1月", "2月", "3月"]);
        assert_eq!(ch.series[0].data, vec![Some(10.0), Some(20.0), Some(30.0)]);
    }

    /// 缺测是 `null`，**不是 0** —— 这是这一层最容易写错的地方
    #[test]
    fn missing_values_stay_null_and_are_not_coerced_to_zero() {
        let mut idx = ChartIndex::new();
        idx.insert("A3".to_string(), vec![r(0, 0, "华东", None), r(1, 0, "华北", None)]);
        idx.insert(
            "B3".to_string(),
            vec![r(0, 1, "1,200", Some(1200.0)), r(1, 1, "", None)],
        );
        let ch = resolve_chart(&decl("bar", &["A3"], &[("额", "B3")]), "D3", &idx).unwrap();
        assert_eq!(ch.series[0].data, vec![Some(1200.0), None], "空格子必须是 null");
    }

    /// 纯文字 / `-` / 百分号都算缺测，不瞎猜
    #[test]
    fn non_numeric_text_is_missing_not_guessed() {
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("   "), None);
        assert_eq!(parse_number("-"), None);
        assert_eq!(parse_number("暂无"), None);
        assert_eq!(parse_number("12%"), None, "百分号解不出来就是缺测，别猜 0.12");
        assert_eq!(parse_number("1,234.5"), Some(1234.5), "千分位要剥掉");
        assert_eq!(parse_number(" -8 "), Some(-8.0));
    }

    /// `raw_number` 优先于文本：文本是套过格式的（`1,234.50`），反解容易错
    #[test]
    fn raw_number_wins_over_formatted_text() {
        let cell = GridCell {
            text: "1,234.50".to_string(),
            pos: "B3".to_string(),
            rowspan: 1,
            colspan: 1,
            raw_number: Some(1234.5),
            num_format: None,
            formula: None,
            style: None,
            image: None,
            chart: None,
        };
        assert_eq!(source_number(&cell), Some(1234.5));

        // 没有 raw_number（文本型数值列）时才回落解文本
        let text_only = GridCell { raw_number: None, text: "1,234.50".to_string(), ..cell };
        assert_eq!(source_number(&text_only), Some(1234.5));
    }

    /// 类目数与数值数对不上 → 整张图不出，且报错要说清「几个 vs 几个、来源是谁」
    #[test]
    fn count_mismatch_fails_and_names_both_counts() {
        let mut idx = region_index();
        // 类目 3 个，这条序列只有 2 个值
        idx.insert("C3".to_string(), vec![r(2, 2, "1", Some(1.0)), r(3, 2, "2", Some(2.0))]);
        let err = resolve_chart(&decl("bar", &["A3"], &[("额", "C3")]), "D3", &idx).unwrap_err();
        assert!(err.contains('3') && err.contains('2'), "要念出两个数：{err}");
        assert!(err.contains("C3"), "要点名来源：{err}");
        assert!(err.contains("一一对应"), "要说清要求：{err}");
    }

    /// 位置名写错（展开结果里压根没有）→ 报错要点名那个坐标
    #[test]
    fn unknown_position_is_named_in_the_error() {
        let err = resolve_chart(&decl("bar", &["Z9"], &[("额", "B3")]), "D3", &region_index())
            .unwrap_err();
        assert!(err.contains("Z9"), "要念出写错的坐标：{err}");
    }

    /// 图表引用自己 → 单独报一条能看懂的话（否则会得到「位置名 D3 不存在」这种误导）
    #[test]
    fn self_reference_has_its_own_message() {
        let err = resolve_chart(&decl("bar", &["D3"], &[("额", "B3")]), "D3", &region_index())
            .unwrap_err();
        assert!(err.contains("自己"), "要指出是自引用：{err}");
    }

    /// 类型写错 → 只坏这一格，报错点名写错的那个词
    #[test]
    fn unknown_kind_is_rejected_and_named() {
        let err = resolve_chart(&decl("area", &["A3"], &[("额", "B3")]), "D3", &region_index())
            .unwrap_err();
        assert!(err.contains("area"), "要点名写错的值：{err}");
        assert!(err.contains("bar") && err.contains("line") && err.contains("pie"), "要列出支持的：{err}");
    }

    /// 没写 kind → 缺省柱状图（不是报错）
    #[test]
    fn missing_kind_defaults_to_bar() {
        let mut d = decl("bar", &["A3"], &[("额", "B3")]);
        d.kind = None;
        assert_eq!(resolve_chart(&d, "D3", &region_index()).unwrap().kind, "bar");
    }

    /// 饼图给了两条序列 → 报错（而不是默默只画第一条）
    #[test]
    fn pie_rejects_multiple_series() {
        let err = resolve_chart(
            &decl("pie", &["A3"], &[("甲", "B3"), ("乙", "B3")]),
            "D3",
            &region_index(),
        )
        .unwrap_err();
        assert!(err.contains("饼图"), "{err}");
    }

    /// 没写类目 → 用序号补上，别因为缺标签就不出图
    #[test]
    fn missing_categories_fall_back_to_ordinals() {
        let ch = resolve_chart(&decl("bar", &[], &[("额", "B3")]), "D3", &region_index()).unwrap();
        assert_eq!(ch.categories, vec!["1", "2", "3"]);
    }

    /// 序列没写名字 → 回落用来源坐标当名字（图例上总得有个字）
    #[test]
    fn unnamed_series_falls_back_to_its_source_position() {
        let mut d = decl("bar", &["A3"], &[("额", "B3")]);
        d.series[0].name = None;
        assert_eq!(resolve_chart(&d, "D3", &region_index()).unwrap().series[0].name, "B3");
        // 只写空格也算没写
        d.series[0].name = Some("   ".to_string());
        assert_eq!(resolve_chart(&d, "D3", &region_index()).unwrap().series[0].name, "B3");
    }

    /// 标题只写空格 = 没写
    #[test]
    fn blank_title_is_dropped() {
        let mut d = decl("bar", &["A3"], &[("额", "B3")]);
        d.title = Some("   ".to_string());
        assert_eq!(resolve_chart(&d, "D3", &region_index()).unwrap().title, None);
        d.title = Some(" 销售 ".to_string());
        assert_eq!(
            resolve_chart(&d, "D3", &region_index()).unwrap().title.as_deref(),
            Some("销售")
        );
    }

    /// 索引只建被引用的位置 —— 别把整张表都克隆一遍
    #[test]
    fn referenced_positions_covers_categories_and_series() {
        let got = referenced_positions(&decl("bar", &["A3", " A4 "], &[("额", "B3")]));
        assert_eq!(got.into_iter().collect::<Vec<_>>(), vec!["A3", "A4", "B3"]);
    }
}
