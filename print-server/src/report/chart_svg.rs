//! 服务端图表渲染：把 `ResolvedChart` 画成内联 SVG。
//!
//! ## 为什么服务端也要画一遍
//!
//! `RenderResponse.html` 是**自包含**的（`to_html` 直接拼字符串），里面没有 JS，
//! 也没法回头调前端 —— 图表必须在这里就变成静态 SVG。
//! 这也正是图片格当年的做法（data URI 直接进 `<img>`，导出物不散成两半）。
//!
//! ## 与前端 chartkit 同口径
//!
//! 画布尺寸、边距、网格/刻度、图例排布、调色板都与
//! `openprint/src/core/chartkit` 对齐，免得「设计器里看到的」和
//! 「导出 HTML 看到的」长得不一样 —— 本项目在「预览与导出两套口径」上
//! 吃过亏（表头行数那次），不一致还是静默的。
//!
//! 唯一的**有意差异**：chartkit 的数据是 `number[]`（画布控件的数据本来就是密的），
//! 这里的数据是 `Option<f64>[]`（报表里「某地区某月没数据」是常态）。
//! 空值画成**空档**：柱子跳过、折线断开、饼图不计入总量。**不补 0** ——
//! 「空着」和「就是 0」在图上长得一样，在报表里是两回事。

use super::model::ResolvedChart;

/// 与前端 `DEFAULT_PALETTE` 同一个数组（改了要同步改两处）
const PALETTE: [&str; 8] = [
    "#5B8FF9", "#5AD8A6", "#5D7092", "#F6BD16", "#E8684A", "#6DC8EC", "#9270CA", "#FF9D4D",
];

/// 逻辑画布缺省尺寸（与 chartkit 一致）
pub const DEFAULT_WIDTH: f64 = 480.0;
pub const DEFAULT_HEIGHT: f64 = 320.0;

const AXIS_FONT: &str = "'SourceHanSerifCN', 'PingFang SC', 'Microsoft YaHei', sans-serif";

fn series_color(i: usize) -> &'static str {
    PALETTE[i % PALETTE.len()]
}

/// XML 文本转义。类目名来自数据，带 `&`/`<` 会破坏 SVG 结构。
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 数值展示：整数去小数尾巴，小数保留最多 2 位（与 chartkit 的 `fmt` 同口径）
fn fmt_num(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    let r = (n * 100.0).round() / 100.0;
    if r.fract() == 0.0 {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

/// 坐标：一律保留 1 位小数（与 chartkit 的 `toFixed(1)` 一致）
fn xy(v: f64) -> String {
    format!("{v:.1}")
}

/// 「好看」的坐标轴上限：向上取整到 1/2/5×10ⁿ 量级（与 chartkit 同算法）
fn nice_max(max: f64) -> f64 {
    if max <= 0.0 {
        return 1.0;
    }
    let exp = max.log10().floor();
    let base = 10f64.powf(exp);
    let frac = max / base;
    let nice = if frac <= 1.0 {
        1.0
    } else if frac <= 2.0 {
        2.0
    } else if frac <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * base
}

/// 截断过长标签（按**字符**不是字节，中文才不会被切碎）
fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() > max {
        let mut out: String = chars[..max.saturating_sub(1)].iter().collect();
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

/// 画一张图（缺省尺寸）
pub fn render(ch: &ResolvedChart) -> String {
    render_sized(ch, DEFAULT_WIDTH, DEFAULT_HEIGHT)
}

/// 画一张图。`w`/`h` 是逻辑画布尺寸，同时作为 svg 的固有尺寸写出去
/// （配 `max-width:100%` 就能在窄容器里缩，不写死会被撑破表格）。
pub fn render_sized(ch: &ResolvedChart, w: f64, h: f64) -> String {
    if ch.categories.is_empty() || ch.series.is_empty() {
        return placeholder(w, h, "暂无数据");
    }
    match ch.kind.as_str() {
        "pie" => pie(ch, w, h),
        "line" => cartesian(ch, w, h, true),
        _ => cartesian(ch, w, h, false),
    }
}

fn placeholder(w: f64, h: f64, text: &str) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {w} {h}\" \
style=\"max-width:100%;height:auto\"><text x=\"{}\" y=\"{}\" text-anchor=\"middle\" font-size=\"13\" \
fill=\"#bbbbbb\">{}</text></svg>",
        w,
        h,
        xy(w / 2.0),
        xy(h / 2.0),
        esc(text)
    )
}

fn svg_open(w: f64, h: f64) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {w} {h}\" \
preserveAspectRatio=\"xMidYMid meet\" style=\"max-width:100%;height:auto\" font-family=\"{AXIS_FONT}\">",
        w, h
    )
}

/// 标题（画在顶部居中，占 22 逻辑高）
fn title_svg(title: Option<&str>, w: f64) -> String {
    match title {
        Some(t) if !t.is_empty() => format!(
            "<text x=\"{}\" y=\"16\" text-anchor=\"middle\" font-size=\"13\" font-weight=\"600\" fill=\"#1f2329\">{}</text>",
            xy(w / 2.0),
            esc(t)
        ),
        _ => String::new(),
    }
}

/// 图例。返回 `(svg, 占用的高度)`。
///
/// `ly` 起点由调用方给（柱/折线在绘图区下方，饼图在整图底部）。
fn legend_svg(names: &[String], w: f64, start_y: f64, pad_left: f64) -> String {
    if names.is_empty() {
        return String::new();
    }
    let mut total_w = 0.0;
    for n in names {
        total_w += 16.0 + n.chars().count() as f64 * 12.0 + 18.0;
    }
    // 居中（与 chartkit 的缺省 labelAlign=center 一致）
    let start_x = pad_left.max((w - total_w) / 2.0);
    let mut out = String::new();
    let mut lx = start_x;
    let mut ly = start_y;
    for (i, n) in names.iter().enumerate() {
        let item_w = 16.0 + n.chars().count() as f64 * 12.0 + 18.0;
        if lx + item_w > w - 8.0 && lx > start_x {
            lx = start_x;
            ly += 16.0;
        }
        out.push_str(&format!(
            "<rect x=\"{}\" y=\"{}\" width=\"11\" height=\"11\" rx=\"2\" fill=\"{}\"/>",
            xy(lx),
            xy(ly - 9.0),
            series_color(i)
        ));
        out.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" font-size=\"11\" fill=\"#000000\">{}</text>",
            xy(lx + 15.0),
            xy(ly),
            esc(&truncate(n, 10))
        ));
        lx += item_w;
    }
    out
}

/// 柱状图 / 折线图：共用一套坐标轴与边距
fn cartesian(ch: &ResolvedChart, w: f64, h: f64, line: bool) -> String {
    let names: Vec<String> = ch.series.iter().map(|s| s.name.clone()).collect();
    // 与 chartkit 一致：多序列才默认画图例
    let show_legend = ch.series.len() > 1;
    let show_axis = true;
    let title_h = if ch.title.as_deref().is_some_and(|t| !t.is_empty()) { 22.0 } else { 0.0 };
    let legend_h = if show_legend { 22.0 } else { 0.0 };

    let m_top = 10.0 + title_h;
    let m_right = 16.0;
    let m_bottom = (if show_axis { 42.0 } else { 22.0 }) + legend_h;
    let m_left = if show_axis { 44.0 } else { 16.0 };

    let px0 = m_left;
    let py0 = m_top;
    let px1 = w - m_right;
    let py1 = h - m_bottom;
    let plot_w = (px1 - px0).max(1.0);
    let plot_h = (py1 - py0).max(1.0);

    let n = ch.categories.len();
    // 坐标轴上限只看**非空**的值。全空 / 全负时 `nice_max` 给 1，避免除零。
    let max_val = ch
        .series
        .iter()
        .flat_map(|s| s.data.iter())
        .filter_map(|v| v.as_ref())
        .copied()
        .fold(0.0f64, f64::max);
    // 一个有效值都没有 → 退回占位，而不是画一个空坐标系。
    // 判据与 chartkit 的 `allVals.length === 0` 一致：**0 算有效值**，
    // 全 0 照画一条贴地的平线（那是「值就是 0」，不是「没有值」）。
    if !ch.series.iter().any(|s| s.data.iter().any(|v| v.is_some())) {
        return placeholder(w, h, "暂无数据");
    }
    let y_max = nice_max(max_val);
    let band = plot_w / (n as f64).max(1.0);

    let mut out = svg_open(w, h);
    out.push_str(&title_svg(ch.title.as_deref(), w));

    // ---- 网格 + y 轴刻度 + 基线 ----
    if show_axis {
        let ticks = 4;
        for i in 0..=ticks {
            let v = (y_max / ticks as f64) * i as f64;
            let y = py1 - (v / y_max) * plot_h;
            if i > 0 {
                out.push_str(&format!(
                    "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#EEEEEE\" stroke-width=\"1\"/>",
                    xy(px0),
                    xy(y),
                    xy(px1),
                    xy(y)
                ));
            }
            out.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" text-anchor=\"end\" font-size=\"11\" fill=\"#000000\">{}</text>",
                xy(px0 - 6.0),
                xy(y + 3.0),
                fmt_num(v)
            ));
        }
        // 折线图左右都有轴线；柱状图只有基线（与 chartkit 一致）
        if line {
            out.push_str(&format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#cccccc\" stroke-width=\"1\"/>",
                xy(px0),
                xy(py0),
                xy(px0),
                xy(py1)
            ));
        }
        out.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#cccccc\" stroke-width=\"1\"/>",
            xy(px0),
            xy(py1),
            xy(px1),
            xy(py1)
        ));
    }

    // ---- x 轴类目标签 ----
    if show_axis {
        for (c, cat) in ch.categories.iter().enumerate() {
            let cx = px0 + band * (c as f64 + 0.5);
            out.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" font-size=\"10\" fill=\"#5a6068\">{}</text>",
                xy(cx),
                xy(py1 + 18.0),
                esc(&truncate(cat, 12))
            ));
        }
    }

    if line {
        out.push_str(&line_series(ch, px0, px1, py1, band, plot_h, y_max, n));
    } else {
        out.push_str(&bars(ch, px0, py1, band, plot_h, y_max, n));
    }

    if show_legend {
        out.push_str(&legend_svg(&names, w, py1 + if show_axis { 40.0 } else { 16.0 }, px0));
    }

    out.push_str("</svg>");
    out
}

/// 柱体。空值**跳过**（画成零高柱等于撒谎说「这里是 0」）。
fn bars(ch: &ResolvedChart, px0: f64, py1: f64, band: f64, plot_h: f64, y_max: f64, n: usize) -> String {
    let inner = band * 0.74;
    let s_count = ch.series.len().max(1);
    let bar_w = inner / s_count as f64;
    let mut out = String::new();
    for c in 0..n {
        let cx = px0 + band * (c as f64 + 0.5);
        let group_x0 = cx - inner / 2.0;
        for (s, series) in ch.series.iter().enumerate() {
            let Some(Some(val)) = series.data.get(c) else { continue };
            let hgt = (val.max(0.0) / y_max) * plot_h;
            let x = group_x0 + s as f64 * bar_w;
            out.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{}\" rx=\"1.5\"/>",
                xy(x),
                xy(py1 - hgt),
                xy(bar_w * 0.9),
                xy(hgt.max(0.0)),
                series_color(s)
            ));
        }
    }
    out
}

/// 折线。空值处**断开**成多段，不连过去 —— 连过去等于凭空补了一个点。
fn line_series(
    ch: &ResolvedChart,
    px0: f64,
    px1: f64,
    py1: f64,
    band: f64,
    plot_h: f64,
    y_max: f64,
    n: usize,
) -> String {
    let mut out = String::new();
    for (s, series) in ch.series.iter().enumerate() {
        let color = series_color(s);
        // 逐点算坐标，空值处切成一段
        let mut runs: Vec<Vec<(f64, f64)>> = Vec::new();
        let mut cur: Vec<(f64, f64)> = Vec::new();
        for c in 0..n {
            match series.data.get(c) {
                Some(Some(val)) => {
                    // 只有一个点时居中放（与 chartkit 一致），否则落在条带中心
                    let x = if n > 1 { px0 + band * (c as f64 + 0.5) } else { (px0 + px1) / 2.0 };
                    let y = py1 - (val.max(0.0) / y_max) * plot_h;
                    cur.push((x, y));
                }
                _ => {
                    if !cur.is_empty() {
                        runs.push(std::mem::take(&mut cur));
                    }
                }
            }
        }
        if !cur.is_empty() {
            runs.push(cur);
        }

        for run in &runs {
            if run.len() > 1 {
                let d: Vec<String> =
                    run.iter().map(|(x, y)| format!("{} {}", xy(*x), xy(*y))).collect();
                out.push_str(&format!(
                    "<path d=\"M {}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"2\" \
stroke-linejoin=\"round\" stroke-linecap=\"round\"/>",
                    d.join(" L ")
                ));
            }
            // 点：即使孤立点也要画出来，否则断档处会**什么都看不见**
            for (x, y) in run {
                out.push_str(&format!(
                    "<circle cx=\"{}\" cy=\"{}\" r=\"2.5\" fill=\"#ffffff\" stroke=\"{color}\" stroke-width=\"1.6\"/>",
                    xy(*x),
                    xy(*y)
                ));
            }
        }
    }
    out
}

/// 饼图 / 环形图。只用第一条序列（扇区 = 数据点）。
fn pie(ch: &ResolvedChart, w: f64, h: f64) -> String {
    let cats = &ch.categories;
    let Some(first) = ch.series.first() else {
        return placeholder(w, h, "暂无数据");
    };
    let show_legend = true;
    let title_h = if ch.title.as_deref().is_some_and(|t| !t.is_empty()) { 22.0 } else { 0.0 };
    let legend_h = if show_legend { 24.0 } else { 0.0 };

    // 总量只算**有效且为正**的值；空值不计入，也不当成 0 去摊薄别人
    let total: f64 = first.data.iter().filter_map(|v| v.as_ref()).map(|v| v.max(0.0)).sum();
    if total <= 0.0 {
        return placeholder(w, h, "暂无数据");
    }

    let cx = w / 2.0;
    let cy = title_h + (h - title_h - legend_h) / 2.0;
    let r_outer = (w * 0.82f64.min(h - title_h - legend_h) / 2.0) * 0.92;

    let mut out = svg_open(w, h);
    out.push_str(&title_svg(ch.title.as_deref(), w));

    let mut angle = 0.0f64;
    for (i, v) in first.data.iter().enumerate() {
        let Some(v) = v else { continue };
        let v = v.max(0.0);
        if v <= 0.0 {
            continue;
        }
        let sweep = (v / total) * 360.0;
        let (start, end) = (angle, angle + sweep);
        angle = end;
        out.push_str(&format!(
            "<path d=\"{}\" fill=\"{}\" stroke=\"#ffffff\" stroke-width=\"1\"/>",
            arc_path(cx, cy, r_outer, start, end),
            series_color(i)
        ));
        // 百分比标签：扇区太窄就不画（挤在一起反而看不清）
        if sweep > 12.0 {
            let mid = (start + end) / 2.0;
            let p = polar(cx, cy, r_outer * 0.62, mid);
            out.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" font-size=\"11\" fill=\"#ffffff\" font-weight=\"600\">{}%</text>",
                xy(p.0),
                xy(p.1 + 3.0),
                ((v / total) * 100.0).round() as i64
            ));
        }
    }

    let names: Vec<String> = cats.to_vec();
    out.push_str(&legend_svg(&names, w, h - legend_h + 12.0, 12.0));

    out.push_str("</svg>");
    out
}

/// 极坐标 → 笛卡尔。角度以「12 点方向为 0°、顺时针递增」表示。
fn polar(cx: f64, cy: f64, r: f64, angle_deg: f64) -> (f64, f64) {
    let theta = (angle_deg - 90.0).to_radians();
    (cx + r * theta.cos(), cy + r * theta.sin())
}

/// 扇区路径（实心饼）。与 chartkit 的 `arcPath` 同算法，含整圆特例。
///
/// 整圆必须用**两段半圆弧**画：起止点重合时 A 命令会被忽略，整圆画不出来。
fn arc_path(cx: f64, cy: f64, r: f64, start: f64, end: f64) -> String {
    let large = if end - start > 180.0 { 1 } else { 0 };
    if end - start >= 359.999 {
        let top = polar(cx, cy, r, 0.0);
        let bottom = polar(cx, cy, r, 180.0);
        return format!(
            "M {} {} L {} {} A {r} {r} 0 1 1 {} {} A {r} {r} 0 1 1 {} {} Z",
            xy(cx),
            xy(cy),
            xy(top.0),
            xy(top.1),
            xy(bottom.0),
            xy(bottom.1),
            xy(top.0),
            xy(top.1)
        );
    }
    let s = polar(cx, cy, r, start);
    let e = polar(cx, cy, r, end);
    // 圆心 → 外起点 → 弧 → 圆心：必须真的到圆心，否则扇区中间是空的
    format!(
        "M {} {} L {} {} A {r} {r} 0 {large} 1 {} {} Z",
        xy(cx),
        xy(cy),
        xy(s.0),
        xy(s.1),
        xy(e.0),
        xy(e.1)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::model::ResolvedChartSeries;

    fn chart(kind: &str, cats: &[&str], series: Vec<(&str, Vec<Option<f64>>)>) -> ResolvedChart {
        ResolvedChart {
            kind: kind.to_string(),
            categories: cats.iter().map(|s| s.to_string()).collect(),
            series: series
                .into_iter()
                .map(|(name, data)| ResolvedChartSeries { name: name.to_string(), data })
                .collect(),
            title: None,
        }
    }

    fn count(hay: &str, needle: &str) -> usize {
        hay.matches(needle).count()
    }

    #[test]
    fn produces_a_scalable_svg() {
        for kind in ["bar", "line", "pie"] {
            let svg = render(&chart(kind, &["甲", "乙"], vec![("s", vec![Some(1.0), Some(2.0)])]));
            assert!(svg.starts_with("<svg "), "{kind} 应以 <svg 开头：{svg}");
            assert!(svg.ends_with("</svg>"), "{kind} 应以 </svg> 结尾");
            assert!(svg.contains("viewBox=\"0 0 480 320\""), "{kind} 要有 viewBox");
        }
    }

    /// 柱状图：每个 (序列 × 类目) 一根柱子
    #[test]
    fn bar_draws_one_rect_per_point() {
        let svg = render(&chart(
            "bar",
            &["甲", "乙", "丙"],
            vec![("A", vec![Some(1.0), Some(2.0), Some(3.0)]), ("B", vec![Some(4.0), Some(5.0), Some(6.0)])],
        ));
        // 柱子 + 图例色块（2 条序列 → 2 个图例 rect）
        assert_eq!(count(&svg, "<rect "), 6 + 2, "6 根柱 + 2 个图例色块：{svg}");
    }

    /// 空值不画柱子 —— 画成零高柱等于撒谎说「这里是 0」
    #[test]
    fn bar_skips_missing_points() {
        let svg = render(&chart("bar", &["甲", "乙", "丙"], vec![("A", vec![Some(1.0), None, Some(3.0)])]));
        assert_eq!(count(&svg, "<rect "), 2, "空值那根不画：{svg}");
    }

    /// 折线在空值处断开：不许连过去（连过去 = 凭空补了一个点）
    #[test]
    fn line_breaks_at_missing_points() {
        let svg = render(&chart(
            "line",
            &["甲", "乙", "丙", "丁"],
            vec![("A", vec![Some(1.0), Some(2.0), None, Some(4.0)])],
        ));
        // 两段：甲-乙、丁（孤立点只有圆点没有 path）
        assert_eq!(count(&svg, "<path "), 1, "只有一段有 2 个点、能连成线：{svg}");
        // 四个点里空值那个不画圆点 → 3 个
        assert_eq!(count(&svg, "<circle "), 3, "空值处不画点：{svg}");
    }

    /// 饼图：每个正数扇区一个 path；总量为 0 时退占位
    #[test]
    fn pie_draws_a_slice_per_positive_value() {
        let svg = render(&chart("pie", &["甲", "乙", "丙"], vec![("A", vec![Some(1.0), Some(2.0), Some(3.0)])]));
        assert_eq!(count(&svg, "<path "), 3, "{svg}");
        // 空值 / 0 不计入扇区，也不摊薄别人的百分比
        let svg = render(&chart("pie", &["甲", "乙", "丙"], vec![("A", vec![Some(1.0), None, Some(3.0)])]));
        assert_eq!(count(&svg, "<path "), 2, "{svg}");
        assert!(svg.contains(">25%<"), "1/(1+3) 应当是 25%：{svg}");
        assert!(svg.contains(">75%<"), "3/(1+3) 应当是 75%：{svg}");
    }

    /// 总量为 0 / 全空 → 占位，不抛错也不画空饼
    #[test]
    fn all_missing_or_zero_falls_back_to_placeholder() {
        let svg = render(&chart("pie", &["甲"], vec![("A", vec![None])]));
        assert!(svg.contains("暂无数据"), "{svg}");
        let svg = render(&chart("bar", &["甲"], vec![("A", vec![None])]));
        assert!(svg.contains("暂无数据"), "{svg}");
    }

    /// 类目 / 标题里的 `& < >` 必须转义，否则 SVG 结构被破坏
    #[test]
    fn labels_are_xml_escaped() {
        let mut ch = chart("bar", &["<script>&"], vec![("A", vec![Some(1.0)])]);
        ch.title = Some("A & B <x>".to_string());
        let svg = render(&ch);
        assert!(!svg.contains("<script>"), "类目没转义：{svg}");
        assert!(svg.contains("&lt;script&gt;"), "{svg}");
        assert!(svg.contains("A &amp; B &lt;x&gt;"), "{svg}");
    }

    /// 坐标轴上限取「好看」的量级。
    ///
    /// **与 chartkit 的「实现」对齐，不是与它的「注释」对齐**：`core.ts` 里
    /// `niceMax` 的注释写着「max=73 → 80；max=250 → 300」，但那份实现做的是
    /// 「向上取到 1/2/5×10ⁿ 中第一个 ≥ max 的量级」—— 73 → 100、250 → 500。
    /// 注释与实现不符（注释已顺手改正）。服务端必须跟**实际画出来的**一致，
    /// 否则预览和打印是两套刻度。
    #[test]
    fn nice_max_rounds_to_readable_steps() {
        assert_eq!(nice_max(73.0), 100.0);
        assert_eq!(nice_max(250.0), 500.0);
        // 边界：正好落在量级上时不该进位
        assert_eq!(nice_max(2.0), 2.0);
        assert_eq!(nice_max(10.0), 10.0);
        assert_eq!(nice_max(100.0), 100.0);
        assert_eq!(nice_max(0.0), 1.0, "全 0 / 全负要给 1，不能除零");
        assert_eq!(nice_max(-5.0), 1.0);
    }

    /// 数值展示：整数不带小数尾巴，小数最多 2 位
    #[test]
    fn numbers_are_formatted_compactly() {
        assert_eq!(fmt_num(1200.0), "1200");
        assert_eq!(fmt_num(0.0), "0");
        assert_eq!(fmt_num(1.5), "1.5");
        assert_eq!(fmt_num(1.23456), "1.23");
    }

    /// 长标签按**字符**截断（中文一个字算一个，不能按字节切碎）
    #[test]
    fn truncation_is_char_based() {
        assert_eq!(truncate("华东区", 12), "华东区");
        assert_eq!(truncate("一二三四五六七八九十十一十二", 12).chars().count(), 12);
        assert!(truncate("一二三四五六七八九十十一十二十三", 12).ends_with('…'));
    }

    /// 多序列才画图例；单序列不占那条高度
    #[test]
    fn legend_only_for_multiple_series() {
        // 序列名刻意与类目不同名，这样「出现了序列名」就一定是图例画的
        let one = render(&chart("bar", &["甲", "乙"], vec![("序列甲", vec![Some(1.0), Some(2.0)])]));
        assert!(!one.contains("序列甲"), "单序列不该出图例：{one}");
        let two = render(&chart(
            "bar",
            &["甲", "乙"],
            vec![("序列甲", vec![Some(1.0), Some(2.0)]), ("序列乙", vec![Some(3.0), Some(4.0)])],
        ));
        assert!(two.contains("序列甲") && two.contains("序列乙"), "多序列要有图例：{two}");
    }
}
