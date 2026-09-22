//! 服务端条码渲染：把已编码的位矩阵画成内联 SVG。
//!
//! ## 为什么是矢量而不是位图
//!
//! `RenderResponse.html` 是**自包含**的（`to_html` 直接拼字符串），没有 JS，
//! 也没法回头调前端。位矩阵→SVG 是纯几何变换，矢量在缩放 / 打印时都清晰；
//! 而嵌一张 base64 位图会让 HTML 体积翻几倍，放大还会糊 —— 条码糊了就是扫不出来。
//! （xlsx 那条路相反：Excel 只收位图，见 `png.rs`。）
//!
//! ## 颜色**不跟主题走**
//!
//! 这里写死白底黑条，而不是 `currentColor` / `var(--text)`。
//! 扫码枪要的是「深色条 + 浅色底」，深色主题下如果跟着主题走就会变成
//! **浅条深底**，屏幕上看着挺好看，一扫什么都不出来。
//! 同理，底色必须显式铺一块白 —— 报表底色若不是白的，条码会印在灰底上，
//! 对比度不够时也是偶发扫不出（最难查的那类）。

use super::model::ResolvedBarcode;

/// HTML 里每个模块画多少像素（内联尺寸）。
///
/// 窄列由 CSS 的 `max-width:100%` 兜底缩放（与图片格同一条规矩）。
/// 3 是「二维码默认够大能扫」与「一维码别一上来就撑爆版面」之间的取舍。
const PX_PER_MODULE: f64 = 3.0;

/// 画一个条码格。矩阵为空时返回空串（调用方会回落显示文本）。
pub fn render(bc: &ResolvedBarcode) -> String {
    let w = bc.width();
    let h = bc.height();
    if w == 0 || h == 0 {
        return String::new();
    }
    let alt = if bc.text.trim().is_empty() { "条码".to_string() } else { bc.text.clone() };

    let mut out = String::new();
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{pw}\" height=\"{ph}\" \
         viewBox=\"0 0 {w} {h}\" shape-rendering=\"crispEdges\" role=\"img\" \
         aria-label=\"{alt}\" style=\"max-width:100%;height:auto\">",
        pw = (w as f64 * PX_PER_MODULE).round(),
        ph = (h as f64 * PX_PER_MODULE).round(),
        alt = escape(&alt),
    ));
    // 白底必须显式铺：见模块头注释（深色主题 / 灰底报表）
    out.push_str(&format!("<rect width=\"{w}\" height=\"{h}\" fill=\"#fff\"/>"));
    out.push_str("<path d=\"");
    for (r, c, rh, cw) in merge_rects(bc) {
        out.push_str(&format!("M{c} {r}h{cw}v{rh}h-{cw}z"));
    }
    out.push_str("\" fill=\"#000\"/>");
    out.push_str("</svg>");
    out
}

/// 把位矩阵合并成若干个「最大矩形」，返回 `(行, 列, 高, 宽)`。
///
/// 不合并的话，一个 v10 二维码是 57×57 里约 1600 个黑格 —— 1600 多个 `<rect>`，
/// 每行都可能带条码，HTML 体积直接失控。合并后：
/// - 一维码每行都一样，整条符号塌成「每根条一个矩形」（几十个）；
/// - 二维码也能省掉约一半。
///
/// 算法：逐格找「还没用过的黑格」，先向右扩到最长，再整段向下扩到不能扩。
/// 结果是极大矩形（不保证最少个数，够用且好懂）。
fn merge_rects(bc: &ResolvedBarcode) -> Vec<(usize, usize, usize, usize)> {
    let (w, h) = (bc.width(), bc.height());
    let mut used = vec![false; w * h];
    let mut out = Vec::new();
    for r in 0..h {
        for c in 0..w {
            if !bc.is_dark(r, c) || used[r * w + c] {
                continue;
            }
            let mut c2 = c;
            while c2 + 1 < w && bc.is_dark(r, c2 + 1) && !used[r * w + c2 + 1] {
                c2 += 1;
            }
            let mut r2 = r;
            'down: while r2 + 1 < h {
                for cc in c..=c2 {
                    if !bc.is_dark(r2 + 1, cc) || used[(r2 + 1) * w + cc] {
                        break 'down;
                    }
                }
                r2 += 1;
            }
            for rr in r..=r2 {
                for cc in c..=c2 {
                    used[rr * w + cc] = true;
                }
            }
            out.push((r, c, r2 - r + 1, c2 - c + 1));
        }
    }
    out
}

/// XML 属性转义。条码原文可能带 `&` / `"` / `<`（单据号里什么都可能有），
/// 不转义会把 `<svg>` 拼坏 —— 而拼坏的表现是「整块 HTML 排版乱掉」，
/// 看不出跟条码有关。
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::model::ResolvedBarcode;

    fn bc(rows: &[&str], text: &str) -> ResolvedBarcode {
        ResolvedBarcode {
            symbology: "qr".into(),
            rows: rows.iter().map(|r| r.to_string()).collect(),
            text: text.to_string(),
        }
    }

    /// 从 SVG 的 `<path>` 里把矩形**解回来**，重建成位矩阵。
    ///
    /// 这是本模块最关键的检查：只断言「SVG 里有 `#000`」是测不出几何画错的。
    /// 解回来比对是**精确**的 —— 少画一格、偏移一格都会红。
    fn matrix_from_svg(svg: &str, w: usize, h: usize) -> Vec<Vec<bool>> {
        let d = svg
            .split("<path d=\"")
            .nth(1)
            .expect("SVG 里应当有 path")
            .split('"')
            .next()
            .unwrap();
        let mut m = vec![vec![false; w]; h];
        // 语法：M{c} {r}h{cw}v{rh}h-{cw}z。只取 M 后面的前 4 个数（x y cw rh），
        // 后面的 h/v/h 都是相对位移，算矩形用不上
        let mut rest = d;
        while let Some(i) = rest.find('M') {
            rest = &rest[i + 1..];
            let mut nums: Vec<i64> = Vec::new();
            // 取到下一个 M 之前的所有数字
            let end = rest.find('M').unwrap_or(rest.len());
            let seg = &rest[..end];
            let mut buf = String::new();
            for ch in seg.chars() {
                if ch.is_ascii_digit() || ch == '-' {
                    buf.push(ch);
                } else {
                    if !buf.is_empty() {
                        nums.push(buf.parse().unwrap());
                        buf.clear();
                    }
                }
            }
            if !buf.is_empty() {
                nums.push(buf.parse().unwrap());
            }
            // M x y h cw v rh h -cw
            let x = nums[0] as usize;
            let y = nums[1] as usize;
            let cw = nums[2] as usize;
            let rh = nums[3] as usize;
            for rr in y..y + rh {
                for cc in x..x + cw {
                    m[rr][cc] = true;
                }
            }
            rest = &rest[end..];
        }
        m
    }

    #[test]
    fn svg_geometry_round_trips_to_the_original_matrix() {
        // 一条 v1 二维码（21×21，含静区 29×29）的真实形状：定位图案 + 一些数据
        let rows: Vec<String> = (0..29)
            .map(|r| {
                (0..29)
                    .map(|c| {
                        let dark = (r < 7 && c < 7)
                            || (r < 7 && c >= 22)
                            || (r >= 22 && c < 7)
                            || (r == 7 && c < 8)
                            || (r == 14 && c % 3 == 0);
                        if dark {
                            '1'
                        } else {
                            '0'
                        }
                    })
                    .collect()
            })
            .collect();
        let b = bc(&rows.iter().map(|s| s.as_str()).collect::<Vec<_>>(), "TEST");

        let svg = render(&b);
        let got = matrix_from_svg(&svg, 29, 29);
        for r in 0..29 {
            for c in 0..29 {
                assert_eq!(got[r][c], b.is_dark(r, c), "({r},{c}) 画错了");
            }
        }
    }

    #[test]
    fn merge_rects_collapses_identical_rows_into_full_height_bars() {
        // 一维码：三行完全相同 → 每根条应当只出一个矩形
        let b = bc(&["10110", "10110", "10110"], "X");
        let rects = merge_rects(&b);
        assert_eq!(rects, vec![(0, 0, 3, 1), (0, 2, 3, 2)], "应当合并成两根通高的条");
    }

    #[test]
    fn merge_rects_does_not_cross_a_light_gap() {
        // 中间断开时不能一路扩过去（那会把浅格也涂黑 → 条码直接废掉）
        let b = bc(&["11011"], "X");
        let rects = merge_rects(&b);
        assert_eq!(rects, vec![(0, 0, 1, 2), (0, 3, 1, 2)]);
    }

    #[test]
    fn merge_rects_covers_every_dark_cell_exactly_once() {
        // 通用不变量：合并结果必须**不重不漏**地盖住所有黑格
        let rows: Vec<String> = (0..17)
            .map(|r| (0..23).map(|c| if (r * 7 + c * 3) % 5 < 2 { '1' } else { '0' }).collect())
            .collect();
        let b = bc(&rows.iter().map(|s| s.as_str()).collect::<Vec<_>>(), "X");
        let mut cover = vec![0usize; 17 * 23];
        for (r, c, rh, cw) in merge_rects(&b) {
            for rr in r..r + rh {
                for cc in c..c + cw {
                    cover[rr * 23 + cc] += 1;
                }
            }
        }
        for r in 0..17 {
            for c in 0..23 {
                let want = usize::from(b.is_dark(r, c));
                assert_eq!(cover[r * 23 + c], want, "({r},{c}) 覆盖次数不对");
            }
        }
    }

    #[test]
    fn svg_uses_fixed_black_on_white_not_the_theme_colour() {
        // 深色主题下如果条码跟着主题走会变成浅条深底 —— 屏幕上好看，扫不出来。
        // 这条钉住「颜色写死」这个决定
        let svg = render(&bc(&["10"], "X"));
        assert!(svg.contains("fill=\"#fff\""), "必须有白底：{svg}");
        assert!(svg.contains("fill=\"#000\""), "条必须是黑的：{svg}");
        assert!(!svg.contains("currentColor"), "不能跟随主题颜色");
        assert!(!svg.contains("var(--"), "不能跟随主题变量");
    }

    #[test]
    fn svg_disables_antialiasing() {
        // 不关抗锯齿的话，模块边界会被插值成灰格，扫码枪阈值一卡就废
        let svg = render(&bc(&["10"], "X"));
        assert!(svg.contains("shape-rendering=\"crispEdges\""), "{svg}");
    }

    #[test]
    fn svg_escapes_the_payload_in_the_accessible_label() {
        let svg = render(&bc(&["10"], "A&B\"<x>"));
        assert!(svg.contains("A&amp;B&quot;&lt;x&gt;"), "原文没转义：{svg}");
        assert!(!svg.contains("A&B\""), "原文裸着进去了：{svg}");
    }

    #[test]
    fn empty_matrix_renders_nothing() {
        // 空矩阵说明编码失败过（引擎会把原因写进 text），这里不该再吐一个空 SVG
        assert_eq!(render(&bc(&[], "X")), "");
        assert_eq!(render(&bc(&["", ""], "X")), "");
    }

    #[test]
    fn svg_keeps_the_white_background_behind_the_bars() {
        // 白底矩形必须**排在 path 前面**：SVG 是按文档顺序画的，
        // 放到后面会把条盖住 —— 结果是一片白，什么都不出来
        let svg = render(&bc(&["10"], "X"));
        let bg = svg.find("fill=\"#fff\"").expect("有白底");
        let bars = svg.find("fill=\"#000\"").expect("有条");
        assert!(bg < bars, "白底必须画在条之前：{svg}");
    }
}
