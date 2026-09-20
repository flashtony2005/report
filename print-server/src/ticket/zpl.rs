//! ZPL II（Zebra 标签机）
//!
//! 结构是 `^XA … ^XZ`，字段用 `^FO`（起点）定位，`^FS` 结束一个字段。
//!
//! 相比 TSPL 的两个优势，正好补上 TSPL 的短板：
//! - `^CI28` 显式声明 UTF-8，中文不靠机型猜
//! - `^A0N,h,w` 直接给点高和点宽，字号不用按内置字体倍率折算
//!
//! 旋转：ZPL 只认 N（0°）/ R（90°）/ I（180°）/ B（270°）。
//! 别的角度报警告并按最近的 90° 倍数打印。
//!
//! 转义：`^` 和 `~` 是控制字符，字段内容里出现必须转成 `^FH` + 十六进制
//! （`^` = `_5E`，`~` = `_7E`）。不转的话内容里的 `^` 会把指令结构撑破 ——
//! 这是 ZPL 最常见的"打了半张就乱码"的原因。

use super::{Align, Item, Ticket};

fn push_line(out: &mut String, s: &str) {
    out.push_str(s);
    out.push_str("\r\n");
}

/// ZPL 的旋转码
fn rot_code(angle: i32) -> &'static str {
    match (((angle % 360) + 360) % 360 as i32) / 90 {
        1 => "R",
        2 => "I",
        3 => "B",
        _ => "N",
    }
}

fn snap_angle(angle: i32) -> i32 {
    (((angle % 360) + 360) % 360 as i32 / 90) * 90
}

/// ZPL 字段内容转义：`^` / `~` 走 `^FH` 十六进制。
///
/// 只在真的出现这两个字符时才加 `^FH` —— 无脑加会让所有字段都变成十六进制模式，
/// 内容里的 `_` 又得再转一层，得不偿失。
fn field(s: &str) -> String {
    if s.contains('^') || s.contains('~') {
        format!("^FH\\{}", s.replace('^', "_5E").replace('~', "_7E"))
    } else {
        s.to_string()
    }
}

fn font_dots(font_pt: f64, dpi: u32) -> i32 {
    ((font_pt * dpi as f64 / 72.0).round() as i32).clamp(6, 400)
}

pub fn render(t: &mut Ticket) -> Vec<u8> {
    let mut out = String::with_capacity(1024);
    // 遍历期间不能再借 `t`（要往告警里写），所以先把用到的量抠出来
    let dpm = t.dots_per_mm();
    let dpi = t.dpi;
    let width_dots = t.width_dots();
    let mut warns: Vec<String> = Vec::new();
    let dots = |mm: f64| -> i32 { (mm * dpm).round() as i32 };

    push_line(&mut out, "^XA");
    // 纸张宽度 / 标签长度
    push_line(&mut out, &format!("^PW{width_dots}"));
    push_line(&mut out, &format!("^LL{}", dots(t.height_mm)));
    // UTF-8 输入（不打这一条，中文按机型默认代码页解释，必乱）
    push_line(&mut out, "^CI28");

    for item in &t.items {
        match item {
            Item::Text { x, y, text, font_pt, align, angle, w } => {
                let h = font_dots(*font_pt, dpi);
                let wd = ((h as f64 * 0.6).round() as i32).max(1);
                let rot = rot_code(*angle);
                if snap_angle(*angle) != *angle {
                    warns.push(format!(
                        "文本「{}」的旋转角 {}° 不是 90 的倍数，ZPL 只认 N/R/I/B，已按 {}° 打印",
                        text.chars().take(12).collect::<String>(),
                        angle,
                        snap_angle(*angle)
                    ));
                }
                // 居中和右对齐：ZPL 的 ^FO 是左上角锚点，也没有对齐参数，
                // 只能按估宽挪 x（等比宽 0.6 是 ZPL 内置字体的经验值）
                let est = text.chars().count() as i32 * wd;
                let x_adj = match align {
                    Align::Left => dots(*x),
                    Align::Center => dots(*x) + (dots(*w) - est) / 2,
                    Align::Right => dots(*x) + dots(*w) - est,
                }
                .max(0);
                push_line(&mut out, &format!("^FO{x_adj},{}", dots(*y)));
                push_line(&mut out, &format!("^A0{rot},{h},{wd}"));
                push_line(&mut out, &format!("^FD{}^FS", field(text)));
            }
            Item::Barcode { x, y, h, data, symbology, show_text } => {
                let h_dots = dots(*h).clamp(10, 1000);
                // 可读文字：Y = 打印在码下方，N = 不打印
                let human = if *show_text { 'Y' } else { 'N' };
                push_line(&mut out, &format!("^FO{},{}", dots(*x), dots(*y)));
                match symbology.as_str() {
                    // ^BC 方向,高度,可读文字,可读文字上方,校验位
                    "code128" => push_line(&mut out, &format!("^BCN,{h_dots},{human},N,N")),
                    // ^B3 方向,校验位,高度,可读文字,上方
                    "code39" => push_line(&mut out, &format!("^B3N,N,{h_dots},{human},N")),
                    // ^BE 方向,高度,可读文字,上方
                    "ean13" => push_line(&mut out, &format!("^BEN,{h_dots},{human},N")),
                    other => {
                        warns.push(format!("ZPL 不支持的条码格式 {other}，该处留白"));
                        continue;
                    }
                }
                push_line(&mut out, &format!("^FD{}^FS", field(data)));
            }
            Item::Qr { x, y, size, data } => {
                // 放大倍数 1~10：按控件边长反推（每个模块 ≈ 2 点 × 倍数）
                let mag = (dots(*size) / 40).clamp(1, 10);
                push_line(&mut out, &format!("^FO{},{}", dots(*x), dots(*y)));
                // ^BQ 方向,型号,放大倍数,纠错
                push_line(&mut out, &format!("^BQN,2,{mag},M"));
                // QR 的数据段有个固定前缀：纠错等级 + 输入模式（A = 自动）
                push_line(&mut out, &format!("^FDMA,{}^FS", field(data)));
            }
            Item::Rule { x, y, w } => {
                let width = if *w > 0.0 { dots(*w) } else { width_dots - dots(*x) };
                push_line(&mut out, &format!("^FO{},{}", dots(*x), dots(*y)));
                push_line(&mut out, &format!("^GB{width},2,2^FS"));
            }
            Item::Box { x, y, w, h } => {
                push_line(&mut out, &format!("^FO{},{}", dots(*x), dots(*y)));
                // ^GB 宽,高,线宽
                push_line(&mut out, &format!("^GB{},{},2^FS", dots(*w), dots(*h)));
            }
        }
    }

    push_line(&mut out, "^XZ");
    t.warnings.append(&mut warns);
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ticket::from_canvas;
    use serde_json::json;

    fn ticket(components: serde_json::Value) -> Ticket {
        let root = json!({
            "version": "1.0",
            "document": {
                "type": "report",
                "page": { "width": 80, "height": 100, "unit": "mm", "orientation": "portrait" },
                "sections": [{ "type": "body", "height": 100, "components": components }]
            }
        });
        from_canvas(&root.to_string(), None).unwrap()
    }

    fn text_of(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[test]
    fn wraps_in_xa_xz_and_declares_utf8() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "hi" }]));
        let s = text_of(&render(&mut t));
        assert!(s.starts_with("^XA\r\n"), "实际: {s:?}");
        assert!(s.ends_with("^XZ\r\n"));
        // 不打 ^CI28，中文按机型默认代码页解释 —— 必乱，而且是静默乱
        assert!(s.contains("^CI28\r\n"), "缺少 UTF-8 声明");
        // 203dpi 是 7.9921 点/mm：80mm → 639 点、100mm → 799 点（不是整 640/800）
        assert!(s.contains("^PW639\r\n"), "80mm → 639 点: {s}");
        assert!(s.contains("^LL799\r\n"), "100mm → 799 点: {s}");
    }

    #[test]
    fn text_uses_dots_and_font_metrics() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 10, "top": 20, "width": 40, "height": 5, "value": "A", "style": { "fontSize": 9 } }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^FO80,160\r\n"), "定位不对: {s}");
        // 9pt @203dpi = 25.4 点 → 25；宽 = 25 × 0.6 ≈ 15
        assert!(s.contains("^A0N,25,15\r\n"), "字体尺寸不对: {s}");
        assert!(s.contains("^FDA^FS\r\n"), "{s}");
    }

    #[test]
    fn rotation_uses_zpl_letters_and_warns_on_odd_angles() {
        let mk = |a: i32| {
            let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "X", "angle": a }]));
            let s = text_of(&render(&mut t));
            (s, t.warnings.len())
        };
        assert!(mk(0).0.contains("^A0N,"));
        assert!(mk(90).0.contains("^A0R,"));
        assert!(mk(180).0.contains("^A0I,"));
        assert!(mk(270).0.contains("^A0B,"));
        assert_eq!(mk(0).1, 0, "0° 不该告警");
        let (_, warns) = mk(45);
        assert_eq!(warns, 1, "45° 要告警");
    }

    #[test]
    fn barcode_uses_zpl_commands() {
        let mut t = ticket(json!([
            { "id": "a", "type": "barcode", "left": 0, "top": 0, "width": 40, "height": 10, "value": "AB", "format": "code128" },
            { "id": "b", "type": "barcode", "left": 0, "top": 20, "width": 40, "height": 10, "value": "AB", "format": "code39" },
            { "id": "c", "type": "barcode", "left": 0, "top": 40, "width": 40, "height": 10, "value": "690123456789", "format": "ean13" }
        ]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^BCN,80,Y,N,N\r\n"), "CODE128: {s}");
        assert!(s.contains("^B3N,N,80,Y,N\r\n"), "CODE39: {s}");
        assert!(s.contains("^BEN,80,Y,N\r\n"), "EAN13: {s}");
        assert!(s.contains("^FDAB^FS\r\n"));
    }

    #[test]
    fn hide_text_flag_reaches_the_command() {
        let mut t = ticket(json!([{ "id": "a", "type": "barcode", "left": 0, "top": 0, "width": 40, "height": 10, "value": "AB", "format": "code128", "showText": false }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^BCN,80,N,N,N\r\n"), "可读文字应关掉: {s}");
    }

    #[test]
    fn qr_uses_bq_with_fixed_prefix() {
        let mut t = ticket(json!([{ "id": "q", "type": "qrcode", "left": 8, "top": 8, "width": 40, "height": 40, "value": "X1" }]));
        let s = text_of(&render(&mut t));
        // 8mm → 64 点；40mm → 320 点 / 40 = 8 倍
        assert!(s.contains("^FO64,64\r\n"), "{s}");
        assert!(s.contains("^BQN,2,8,M\r\n"), "{s}");
        assert!(s.contains("^FDMA,X1^FS\r\n"), "QR 数据段少了 M 前缀: {s}");
    }

    #[test]
    fn rule_and_box_use_gb() {
        let mut t = ticket(json!([
            { "id": "l", "type": "line", "left": 0, "top": 5, "width": 40, "height": 1 },
            { "id": "r", "type": "rect", "left": 0, "top": 10, "width": 40, "height": 20 }
        ]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^GB320,2,2^FS\r\n"), "横线: {s}");
        assert!(s.contains("^GB320,160,2^FS\r\n"), "方框: {s}");
    }

    /// `^` 是控制字符：内容里的它会把指令结构撑破，必须走 ^FH 十六进制
    #[test]
    fn caret_in_content_is_hex_escaped() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "A^B" }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^FH\\A_5EB^FS"), "未转义: {s}");
        assert!(!s.contains("^FDA^B^FS"), "裸 ^ 会让 ZPL 解析错位");
    }

    #[test]
    fn tilde_in_content_is_hex_escaped() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "A~B" }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^FH\\A_7EB^FS"), "未转义: {s}");
    }

    /// 没有特殊字符时**不该**加 ^FH —— 加了会把内容里的下划线也卷进十六进制解析
    #[test]
    fn plain_content_gets_no_hex_prefix() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "A_B-C" }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^FDA_B-C^FS"), "{s}");
        assert!(!s.contains("^FH"), "不该有 ^FH: {s}");
    }

    #[test]
    fn chinese_text_passes_through_as_utf8() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "苹果" }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("^FD苹果^FS"), "{s}");
        assert!(t.warnings.is_empty(), "ZPL 有 ^CI28，中文不该告警: {:?}", t.warnings);
    }

    /// 右对齐要挪 x；ZPL 没有对齐参数
    #[test]
    fn align_shifts_x() {
        let mk = |align: &str| {
            let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0,
                "width": 40, "height": 5, "value": "AB", "style": { "fontSize": 9, "textAlign": align } }]));
            text_of(&render(&mut t))
        };
        // 40mm = 320 点；2 字 × 15 点 = 30 点
        assert!(mk("left").contains("^FO0,0\r\n"));
        assert!(mk("center").contains(&format!("^FO{},0\r\n", (320 - 30) / 2)), "居中: {}", mk("center"));
        assert!(mk("right").contains(&format!("^FO{},0\r\n", 320 - 30)), "右对齐: {}", mk("right"));
    }
}
