//! TSPL / TSPL2（TSC 标签机）
//!
//! 指令是纯文本，一行一条，最后 `PRINT 1,1`。比 ESC/POS 强的地方是**有真正的
//! x/y 定位**（点为单位），所以文本、条码、二维码、方框都能摆在任意位置。
//!
//! 坐标单位：TSPL 默认是**点**（`SIZE 80 mm,100 mm` 这种带单位的写法也可以）。
//! 这里统一按点发，避免机型对单位默认值的理解不一致。
//!
//! 旋转：TSPL 只认 0 / 90 / 180 / 270。别的角度**报警告**并按最近的 90° 倍数打印 ——
//! 悄悄按 0° 打印会让整张标签的排版看起来"对"但其实是错的。
//!
//! 文字编码：TSPL 没有 UTF-8 开关（那是 ZPL 的 `^CI28`），中文靠机型内置字库。
//! 这里按 UTF-8 发字节，并在有非 ASCII 时**提示一句**：能不能打出来取决于机器。

use super::{Align, Item, Ticket};

/// 文本行高基准（点）—— TSPL 内置字体 "1" 是 8×12 点
const FONT1_H: i32 = 12;

/// TSPL 支持的四个角度
fn snap_angle(angle: i32) -> i32 {
    let a = ((angle % 360) + 360) % 360;
    let snapped = ((a as f64 / 90.0).round() as i32 * 90) % 360;
    snapped
}

fn push_line(out: &mut String, s: &str) {
    out.push_str(s);
    out.push_str("\r\n");
}

/// 转义 TSPL 字符串里的双引号（TSPL 用 `\"`）
fn quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn font_scale(font_pt: f64, dpi: u32) -> i32 {
    let target = font_pt * dpi as f64 / 72.0;
    ((target / FONT1_H as f64).round() as i32).clamp(1, 10)
}

pub fn render(t: &mut Ticket) -> Vec<u8> {
    let mut out = String::with_capacity(1024);
    // 遍历期间不能再借 `t`（要往告警里写），所以先把用到的量抠出来
    let dpm = t.dots_per_mm();
    let dpi = t.dpi;
    let width_dots = t.width_dots();
    let mut warns: Vec<String> = Vec::new();

    // 标签尺寸 + 间隙（2mm 是常见标签纸的缝）
    push_line(
        &mut out,
        &format!("SIZE {:.2} mm,{:.2} mm", t.width_mm, t.height_mm),
    );
    push_line(&mut out, "GAP 2 mm,0 mm");
    push_line(&mut out, "DIRECTION 1");
    push_line(&mut out, "CLS");

    let mut warned_non_ascii = false;

    for item in &t.items {
        match item {
            Item::Text { x, y, text, font_pt, align, angle, w } => {
                let dots_x = (x * dpm).round() as i32;
                let dots_y = (y * dpm).round() as i32;
                let scale = font_scale(*font_pt, dpi);
                let rot = snapped(&mut warns, *angle, "文本", text);
                // TSPL 的 TEXT 从锚点向右排，没有"居中"参数 —— 居中只能自己挪 x。
                // 这是 TSPL 的真实约束，不是偷懒：算出来的偏移在 203dpi 下是精确的。
                let x_adj = match align {
                    Align::Left => dots_x,
                    Align::Center => dots_x + (((w * dpm).round() as i32) - text_dots(text, scale)) / 2,
                    Align::Right => dots_x + ((w * dpm).round() as i32) - text_dots(text, scale),
                }
                .max(0);
                if !text.is_ascii() {
                    warned_non_ascii = true;
                }
                push_line(
                    &mut out,
                    &format!(
                        "TEXT {x_adj},{dots_y},\"1\",{rot},{scale},{scale},\"{}\"",
                        quote(text)
                    ),
                );
            }
            Item::Barcode { x, y, h, data, symbology, show_text } => {
                let h_dots = ((h * dpm).round() as i32).clamp(10, 1000);
                let readable = if *show_text { 1 } else { 0 };
                let cmd = match symbology.as_str() {
                    "code128" => "128",
                    "code39" => "39",
                    "ean13" => "EAN13",
                    other => {
                        warns.push(format!("TSPL 不支持的条码格式 {other}，该处留白"));
                        continue;
                    }
                };
                // BARCODE x,y,"码制",高,可读文字,旋转,窄条宽,宽条比,"数据"
                push_line(
                    &mut out,
                    &format!(
                        "BARCODE {},{},\"{cmd}\",{h_dots},{readable},0,2,4,\"{}\"",
                        (x * dpm).round() as i32,
                        (y * dpm).round() as i32,
                        quote(data)
                    ),
                );
            }
            Item::Qr { x, y, size, data } => {
                let cell = (((size * dpm).round() as i32) / 25).clamp(1, 10);
                // QRCODE x,y,纠错等级,单元大小,模式,旋转,"数据"
                push_line(
                    &mut out,
                    &format!(
                        "QRCODE {},{},L,{cell},A,0,\"{}\"",
                        (x * dpm).round() as i32,
                        (y * dpm).round() as i32,
                        quote(data)
                    ),
                );
            }
            Item::Rule { x, y, w } => {
                let width = if *w > 0.0 { (w * dpm).round() as i32 } else { width_dots - (x * dpm).round() as i32 };
                push_line(
                    &mut out,
                    &format!("BAR {},{},{width},2", (x * dpm).round() as i32, (y * dpm).round() as i32),
                );
            }
            Item::Box { x, y, w, h } => {
                let (px, py) = ((x * dpm).round() as i32, (y * dpm).round() as i32);
                let (pw, ph) = ((w * dpm).round() as i32, (h * dpm).round() as i32);
                // TSPL 没有空心矩形，用 4 条 BAR 拼
                push_line(&mut out, &format!("BAR {px},{py},{pw},2"));
                push_line(&mut out, &format!("BAR {px},{},{pw},2", py + ph));
                push_line(&mut out, &format!("BAR {px},{py},2,{ph}"));
                push_line(&mut out, &format!("BAR {},{py},2,{ph}", px + pw));
            }
        }
    }

    if warned_non_ascii {
        warns.push(
            "标签里有非 ASCII 字符：TSPL 没有 UTF-8 开关，能不能打出来取决于机型内置字库；\
             要稳妥请改用 ZPL（带 ^CI28）"
                .to_string(),
        );
    }

    push_line(&mut out, "PRINT 1,1");
    t.warnings.append(&mut warns);
    out.into_bytes()
}

fn snapped(warns: &mut Vec<String>, angle: i32, what: &str, label: &str) -> i32 {
    let a = snap_angle(angle);
    if a != angle {
        warns.push(format!(
            "{what}「{}」的旋转角 {angle}° 不是 90 的倍数，TSPL 只认 0/90/180/270，已按 {a}° 打印",
            label.chars().take(12).collect::<String>()
        ));
    }
    a
}

/// 文本占宽（点）：ASCII 按 1 字宽、非 ASCII 按 2 字宽
fn text_dots(s: &str, scale: i32) -> i32 {
    let mut n = 0;
    for c in s.chars() {
        n += if c.is_ascii() { 1 } else { 2 };
    }
    n * 8 * scale
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
    fn header_and_print_command() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "hi" }]));
        let s = text_of(&render(&mut t));
        assert!(s.starts_with("SIZE 80.00 mm,100.00 mm\r\n"), "实际开头: {s:?}");
        assert!(s.contains("CLS\r\n"));
        assert!(s.ends_with("PRINT 1,1\r\n"));
        // 行尾必须是 CRLF —— 有些机型只认 CRLF
        assert!(!s.contains("\n") || !s.replace("\r\n", "").contains('\n'), "混进了裸 LF");
    }

    /// TSPL 有真定位，所以坐标要**直接**是点，不能像 ESC 那样折算成行
    #[test]
    fn text_uses_dot_coordinates_directly() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 10, "top": 20, "width": 40, "height": 5, "value": "A" }]));
        let s = text_of(&render(&mut t));
        // 10mm→80 点，20mm→160 点
        assert!(s.contains("TEXT 80,160,\"1\",0,"), "实际: {s}");
    }

    /// 居中 / 右对齐：TSPL 没有对齐参数，必须自己挪 x，否则会静默靠左
    #[test]
    fn align_shifts_x_instead_of_being_ignored() {
        let mk = |align: &str| {
            let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0,
                "width": 40, "height": 5, "value": "AB", "style": { "textAlign": align } }]));
            text_of(&render(&mut t))
        };
        let left = mk("left");
        let center = mk("center");
        let right = mk("right");
        // 40mm = 320 点；"AB" 在 scale=2（10pt 默认字号）时占 2×8×2 = 32 点
        assert!(left.contains("TEXT 0,0,"), "左对齐不该挪: {left}");
        assert!(center.contains(&format!("TEXT {},0,", (320 - 32) / 2)), "居中没挪: {center}");
        assert!(right.contains(&format!("TEXT {},0,", 320 - 32)), "右对齐没挪: {right}");
    }

    #[test]
    fn rotation_snaps_to_quarter_turns_and_warns() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "X", "angle": 100 }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("\"1\",90,"), "100° 应snap到 90°: {s}");
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("100"), "{}", t.warnings[0]);
    }

    #[test]
    fn right_angle_rotation_does_not_warn() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "X", "angle": 270 }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("\"1\",270,"), "{s}");
        assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    }

    #[test]
    fn barcode_uses_tspl_symbology_names() {
        let mut t = ticket(json!([
            { "id": "a", "type": "barcode", "left": 0, "top": 0, "width": 40, "height": 10, "value": "AB", "format": "code128" },
            { "id": "b", "type": "barcode", "left": 0, "top": 20, "width": 40, "height": 10, "value": "AB", "format": "code39" },
            { "id": "c", "type": "barcode", "left": 0, "top": 40, "width": 40, "height": 10, "value": "690123456789", "format": "ean13" }
        ]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("\"128\""), "缺 CODE128: {s}");
        assert!(s.contains("\"39\""), "缺 CODE39: {s}");
        assert!(s.contains("\"EAN13\""), "缺 EAN13: {s}");
    }

    #[test]
    fn qr_uses_qrcode_command() {
        let mut t = ticket(json!([{ "id": "q", "type": "qrcode", "left": 10, "top": 10, "width": 20, "height": 20, "value": "X1" }]));
        let s = text_of(&render(&mut t));
        // 10mm → 80 点；20mm → 160 点，160/25 = 6.4 → 单元大小 6
        assert!(s.contains("QRCODE 80,80,L,6,A,0,\"X1\""), "实际: {s}");
    }

    #[test]
    fn rule_and_box_become_bars() {
        let mut t = ticket(json!([
            { "id": "l", "type": "line", "left": 0, "top": 5, "width": 40, "height": 1 },
            { "id": "r", "type": "rect", "left": 0, "top": 10, "width": 40, "height": 20 }
        ]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("BAR 0,40,320,2"), "横线不对: {s}");
        // 方框四条边：上/下/左/右
        assert!(s.contains("BAR 0,80,320,2"), "方框上边: {s}");
        assert!(s.contains("BAR 0,240,320,2"), "方框下边: {s}");
        assert!(s.contains("BAR 0,80,2,160"), "方框左边: {s}");
        assert!(s.contains("BAR 320,80,2,160"), "方框右边: {s}");
    }

    /// 双引号必须转义，否则标签上的内容会把指令结构撑破
    #[test]
    fn quotes_in_data_are_escaped() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "说\"你好\"" }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("\\\"你好\\\""), "引号没转义: {s}");
    }

    #[test]
    fn non_ascii_text_warns_about_font_dependency() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "苹果" }]));
        let s = text_of(&render(&mut t));
        assert!(s.contains("苹果"), "内容还是要发出去");
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("UTF-8"), "{}", t.warnings[0]);
    }

    /// 纯 ASCII 不该有这条噪音告警
    #[test]
    fn ascii_text_does_not_warn() {
        let mut t = ticket(json!([{ "id": "t", "type": "text", "left": 0, "top": 0, "width": 40, "height": 5, "value": "ABC-123" }]));
        let _ = render(&mut t);
        assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    }
}
