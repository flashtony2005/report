//! ESC/POS（小票机）
//!
//! ## 编码
//!
//! 票据机内置的是**中文字库**，走 GBK 而不是 UTF-8（GB18030 的打印机也能吃 GBK）。
//! 所以文本一律用 [`encoding_rs::GBK`] 编码；编不出来的字符（emoji、生僻字、
//! 某些全角符号）会**报警告**——不然小票上就是一个空格，谁也看不出少了个字。
//!
//! ## 定位
//!
//! ESC/POS 只有「行」这个概念，没有任意 y 坐标。做法是：
//! - 用 `ESC 3 24` 把行距固定成 24 点（= Font A 的字高，203dpi 下 3mm）
//! - 每个图元的 y(mm) 换算成行号，用 `ESC d n` 前进到那一行
//! - 行内用 `ESC $ nL nH` 设绝对横向位置（点）
//!
//! 代价：**同一行里放不下两个不同 y 的东西**（它们是同一行）。这是票据机的本性，
//! 不是这里的实现缺陷 —— 精确定位要靠 TSPL / ZPL。
//!
//! ## 画不出来的
//!
//! - 旋转：ESC/POS 没有旋转指令，`angle != 0` 会报警告并按 0° 打印
//! - 竖线：按行打印时没有意义，`line` 一律按水平线处理（IR 层已经统一了）
//! - 条码格式只支持 code128 / code39 / ean13（`GS k` 的三个常用型号）

use super::{Align, Item, Ticket};
use encoding_rs::GBK;

/// Font A 的字高（点）。行距与字号缩放都以此为基准。
const BASE_LINE_DOTS: i32 = 24;
/// Font A 的字宽（点）
const BASE_CHAR_DOTS: i32 = 12;

const ESC: u8 = 0x1B;
const GS: u8 = 0x1D;

fn push(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
}

/// `ESC 3 n` —— 设行距为 n 点
fn set_line_spacing(out: &mut Vec<u8>, dots: u8) {
    push(out, &[ESC, b'3', dots]);
}

/// `ESC a n` —— 0 左 / 1 居中 / 2 右
fn set_align(out: &mut Vec<u8>, a: Align) {
    let n = match a {
        Align::Left => 0,
        Align::Center => 1,
        Align::Right => 2,
    };
    push(out, &[ESC, b'a', n]);
}

/// `ESC $ nL nH` —— 设绝对横向位置（点）
fn set_abs_x(out: &mut Vec<u8>, dots: i32) {
    let d = dots.max(0) as u16;
    push(out, &[ESC, b'$', (d & 0xFF) as u8, (d >> 8) as u8]);
}

/// `ESC d n` —— 前进 n 行
fn feed_rows(out: &mut Vec<u8>, n: i32) {
    let mut left = n;
    while left > 0 {
        let step = left.min(255);
        push(out, &[ESC, b'd', step as u8]);
        left -= step;
    }
}

/// `GS ! n` —— 字宽 / 字高倍率（1~8 倍）
fn set_char_size(out: &mut Vec<u8>, w: u8, h: u8) {
    let w = w.clamp(1, 8) - 1;
    let h = h.clamp(1, 8) - 1;
    push(out, &[GS, b'!', (w << 4) | h]);
}

/// GBK 编码；有编不出来的字符就记一条告警
///
/// 告警先攒在 `warns` 里，最后再灌回 `Ticket` —— 边遍历 `t.items` 边写 `t.warnings`
/// 是借用冲突（而且真写成 `unsafe` 也会很难查）。
fn encode_text(warns: &mut Vec<String>, s: &str, where_: &str) -> Vec<u8> {
    let (bytes, _, had_errors) = GBK.encode(s);
    if had_errors {
        let bad: String = s
            .chars()
            .filter(|c| {
                let mut buf = [0u8; 4];
                GBK.encode(c.encode_utf8(&mut buf)).2
            })
            .collect();
        warns.push(format!(
            "{where_} 有字符 GBK 编不出来（{}），打印出来会是空格：请改用 TSPL / ZPL，或换掉这些字",
            bad.escape_debug()
        ));
    }
    bytes.into_owned()
}

/// 一个字符占的宽度（点）—— 中文按双倍宽算
fn text_width_dots(s: &str, scale: u8) -> i32 {
    let mut n = 0;
    for c in s.chars() {
        n += if is_wide(c) { 2 } else { 1 };
    }
    n * BASE_CHAR_DOTS * scale as i32
}

fn is_wide(c: char) -> bool {
    let u = c as u32;
    (0x1100..=0x115F).contains(&u)
        || (0x2E80..=0xA4CF).contains(&u)
        || (0xAC00..=0xD7A3).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0xFE30..=0xFE6F).contains(&u)
        || (0xFF00..=0xFF60).contains(&u)
        || (0xFFE0..=0xFFE6).contains(&u)
}

/// 按 `font_pt` 算字号倍率：目标字高 = pt × dpi / 72，基准 24 点
fn scale_for(font_pt: f64, dpi: u32) -> u8 {
    let target = font_pt * dpi as f64 / 72.0;
    ((target / BASE_LINE_DOTS as f64).round() as i32).clamp(1, 8) as u8
}

/// 打完第 `row` 行之后，下一个可用行是 `row + 1`。
///
/// **不能写成 `cur_row += 1`**：同一行里放两个图元时，第二个会把 `cur_row` 推到
/// `row + 2`，之后所有图元都提前一行 —— 小票整体上移，而且每多一个同行图元就多错一行。
/// 这个是探针发现的：表格第一行两格（品名 / 数量）把方框顶到了上一行。
fn advance(cur_row: &mut i32, row: i32) {
    *cur_row = (*cur_row).max(row + 1);
}

pub fn render(t: &mut Ticket) -> Vec<u8> {
    let mut out = Vec::with_capacity(1024);
    push(&mut out, &[ESC, b'@']); // 初始化
    set_line_spacing(&mut out, BASE_LINE_DOTS as u8);
    set_align(&mut out, Align::Left);
    set_char_size(&mut out, 1, 1);

    // 遍历期间不能再借 `t`（要往告警里写），所以先把用到的量抠出来
    let dpm = t.dots_per_mm();
    let dpi = t.dpi;
    let width_dots = t.width_dots();
    let mut warns: Vec<String> = Vec::new();

    // 行号 = y(mm) → 点 → 行；图元已按 y 排序（见 mod.rs）
    let row_of = |mm: f64| -> i32 {
        let dots = (mm * dpm).round() as i32;
        dots.div_euclid(BASE_LINE_DOTS)
    };

    let mut cur_row = 0_i32;

    for item in &t.items {
        let row = row_of(item.y_mm());
        if row > cur_row {
            feed_rows(&mut out, row - cur_row);
            cur_row = row;
        }

        match item {
            Item::Text { x, text, font_pt, align, angle, .. } => {
                if *angle != 0 {
                    warns.push(format!(
                        "文本「{}」设了 {}° 旋转，ESC/POS 没有旋转指令，已按 0° 打印",
                        truncate(text, 12),
                        angle
                    ));
                }
                let scale = scale_for(*font_pt, dpi);
                set_char_size(&mut out, scale, scale);
                set_align(&mut out, *align);
                // 居中和右对齐交给打印机（它知道纸有多宽）；左对齐才用绝对位置
                if *align == Align::Left {
                    let x_dots = (*x * dpm).round() as i32;
                    set_abs_x(&mut out, x_dots);
                    // 绝对定位 + 超宽 = 右边被裁掉。票据机不会帮你换行，只会切
                    let over = x_dots + text_width_dots(text, scale) - width_dots;
                    if over > 0 {
                        warns.push(format!(
                            "文本「{}」超出纸宽 {} 点（超 {over} 点），右边会被裁掉",
                            truncate(text, 12),
                            width_dots
                        ));
                    }
                }
                let body = encode_text(&mut warns, text, &format!("文本「{}」", truncate(text, 12)));
                push(&mut out, &body);
                push(&mut out, &[b'\n']);
                advance(&mut cur_row, row);
                set_align(&mut out, Align::Left);
                set_char_size(&mut out, 1, 1);
            }
            Item::Barcode { x, h, data, symbology, show_text, .. } => {
                set_align(&mut out, Align::Left);
                set_abs_x(&mut out, (*x * dpm).round() as i32);
                // 条码高度 / 模块宽度 / 可读文字位置
                let hdots = (h * dpm).round().clamp(1.0, 255.0) as u8;
                push(&mut out, &[GS, b'h', hdots]);
                push(&mut out, &[GS, b'w', 2]);
                push(&mut out, &[GS, b'H', if *show_text { 2 } else { 0 }]);
                if let Err(e) = write_barcode(&mut out, data, symbology) {
                    warns.push(format!("条码「{}」未打印：{e}", truncate(data, 16)));
                } else {
                    push(&mut out, &[b'\n']);
                    advance(&mut cur_row, row);
                }
            }
            Item::Qr { x, size, data, .. } => {
                set_align(&mut out, Align::Left);
                set_abs_x(&mut out, (*x * dpm).round() as i32);
                if let Err(e) = write_qr(&mut out, data, *size, dpm) {
                    warns.push(format!("二维码「{}」未打印：{e}", truncate(data, 16)));
                } else {
                    push(&mut out, &[b'\n']);
                    advance(&mut cur_row, row);
                }
            }
            Item::Rule { x, w, .. } => {
                set_align(&mut out, Align::Left);
                let dots = if *w > 0.0 { (*w * dpm).round() as i32 } else { width_dots - (*x * dpm).round() as i32 };
                let n = (dots / BASE_CHAR_DOTS).max(1);
                // 横向细线用「-」铺：票据机没有画线指令，`ESC *` 位图要自己造点阵
                push(&mut out, &vec![b'-'; n as usize]);
                push(&mut out, &[b'\n']);
                advance(&mut cur_row, row);
            }
            Item::Box { x, y, w, h } => {
                let bottom_row = row_of(y + h);
                draw_box(&mut out, *x, *w, dpm, &mut cur_row, row, bottom_row);
            }
        }
    }

    // 切纸（部分机型支持；不支持时被忽略）
    push(&mut out, &[GS, b'V', 0]);
    t.warnings.append(&mut warns);
    out
}

/// 矩形：上下两条横线 + 中间每行左右各一个 `|`
fn draw_box(
    out: &mut Vec<u8>,
    x: f64,
    w: f64,
    dpm: f64,
    cur_row: &mut i32,
    top_row: i32,
    bottom_row: i32,
) {
    let x_dots = (x * dpm).round() as i32;
    let dots = (w * dpm).round() as i32;
    let n = (dots / BASE_CHAR_DOTS).max(2);
    let line: Vec<u8> = vec![b'-'; n as usize];

    set_align(out, Align::Left);
    set_abs_x(out, x_dots);
    push(out, &line);
    push(out, &[b'\n']);
    advance(cur_row, top_row);

    let side_x = (x_dots + dots - BASE_CHAR_DOTS).max(x_dots);
    while *cur_row < bottom_row {
        set_abs_x(out, x_dots);
        push(out, b"|");
        set_abs_x(out, side_x);
        push(out, b"|");
        push(out, &[b'\n']);
        *cur_row += 1;
    }

    if *cur_row == bottom_row {
        set_abs_x(out, x_dots);
        push(out, &line);
        push(out, &[b'\n']);
        *cur_row += 1;
    }
}

/// `GS k` —— 条码。只做三个常用型号，其余在 IR 层就报过警告了。
fn write_barcode(out: &mut Vec<u8>, data: &str, symbology: &str) -> Result<(), String> {
    match symbology {
        // 73 = CODE128，n = 长度 + 2（含一个码集选择符），码集 B = 0x7B 0x42
        "code128" => {
            if data.len() > 253 {
                return Err(format!("CODE128 最长 253 字节，实际 {}", data.len()));
            }
            let n = (data.len() + 2) as u8;
            push(out, &[GS, b'k', 73, n, 0x7B, 0x42]);
            push(out, data.as_bytes());
        }
        // 69 = CODE39，n = 长度
        "code39" => {
            if data.len() > 255 {
                return Err(format!("CODE39 最长 255 字节，实际 {}", data.len()));
            }
            push(out, &[GS, b'k', 69, data.len() as u8]);
            push(out, data.as_bytes());
        }
        // 67 = EAN13，n = 12（校验位由打印机补）
        "ean13" => {
            let digits: String = data.chars().filter(|c| c.is_ascii_digit()).collect();
            if digits.len() != 12 && digits.len() != 13 {
                return Err(format!("EAN13 要 12 或 13 位数字，实际「{data}」"));
            }
            push(out, &[GS, b'k', 67, 12]);
            push(out, digits[..12].as_bytes());
        }
        other => return Err(format!("ESC/POS 不支持的条码格式 {other}")),
    }
    Ok(())
}

/// `GS ( k` —— 二维码（型号 2）。模块大小由控件宽度推：越宽点越大。
fn write_qr(out: &mut Vec<u8>, data: &str, size_mm: f64, dots_per_mm: f64) -> Result<(), String> {
    let bytes = data.as_bytes();
    if bytes.len() > 7089 {
        return Err(format!("二维码数据过长（{} 字节，上限 7089）", bytes.len()));
    }
    // 模块大小 1~16：按「整块占满 size_mm」反推，再夹到合法区间
    let module = ((size_mm * dots_per_mm / 30.0).round() as i32).clamp(1, 16) as u8;

    // 型号 2
    push(out, &[GS, b'(', b'k', 4, 0, 49, 65, 50, 0]);
    // 模块大小
    push(out, &[GS, b'(', b'k', 3, 0, 49, 67, module]);
    // 纠错等级 L（48）—— 票据上的码通常贴在纸面上，不需要高纠错
    push(out, &[GS, b'(', b'k', 3, 0, 49, 69, 48]);
    // 存数据：pL pH = 长度 + 3
    let n = bytes.len() + 3;
    if n > 65535 {
        return Err("二维码数据段过长".into());
    }
    push(out, &[GS, b'(', b'k', (n & 0xFF) as u8, (n >> 8) as u8, 49, 80, 48]);
    push(out, bytes);
    // 打印
    push(out, &[GS, b'(', b'k', 3, 0, 49, 81, 48]);
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ticket::from_canvas;
    use serde_json::json;

    fn ticket(sections: serde_json::Value, data: Option<serde_json::Value>, dpi: Option<u32>) -> Ticket {
        let mut root = json!({
            "version": "1.0",
            "document": {
                "type": "report",
                "page": { "width": 80, "height": 200, "unit": "mm", "orientation": "portrait" },
                "sections": sections
            }
        });
        if let Some(d) = data {
            root["data"] = d;
        }
        from_canvas(&root.to_string(), dpi).unwrap()
    }

    fn one(component: serde_json::Value) -> Ticket {
        ticket(json!([{ "type": "body", "height": 200, "components": [component] }]), None, None)
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    #[test]
    fn starts_with_init_and_ends_with_cut() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5, "value": "hi" }));
        let out = render(&mut t);
        assert_eq!(&out[..2], &[ESC, b'@'], "开头必须是 ESC @ 初始化");
        assert_eq!(&out[out.len() - 3..], &[GS, b'V', 0], "结尾必须是切纸");
    }

    /// 行距必须显式设成 24 点：不设的话 `ESC d n` 前进多少点由机型默认值决定，
    /// 算出来的行号就全是错的（而且是静默错位）
    #[test]
    fn line_spacing_is_pinned_to_base_line_dots() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5, "value": "hi" }));
        let out = render(&mut t);
        assert!(find(&out, &[ESC, b'3', 24]).is_some(), "缺少 ESC 3 24");
    }

    /// y=30mm、203dpi → 240 点 → 第 10 行（每行 24 点）
    #[test]
    fn y_position_becomes_row_advance() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 30, "width": 80, "height": 5, "value": "hi" }));
        let out = render(&mut t);
        assert!(
            find(&out, &[ESC, b'd', 10]).is_some(),
            "期望 ESC d 10（30mm = 240 点 = 10 行），实际 {:?}",
            out
        );
    }

    /// x=20mm → 160 点 → ESC $ 0xA0 0x00
    #[test]
    fn x_position_becomes_absolute_dots() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 20, "top": 0, "width": 40, "height": 5, "value": "hi" }));
        let out = render(&mut t);
        assert!(find(&out, &[ESC, b'$', 160, 0]).is_some(), "期望 ESC $ 160 0，实际 {:?}", out);
    }

    #[test]
    fn align_center_uses_printer_align_not_abs_x() {
        let mut t = one(json!({
            "id": "t", "type": "text", "left": 20, "top": 0, "width": 40, "height": 5,
            "value": "居中", "style": { "textAlign": "center" } }));
        let out = render(&mut t);
        assert!(find(&out, &[ESC, b'a', 1]).is_some(), "缺少居中对齐指令");
        // 居中时不该再设绝对 x（两者同时发，后者会覆盖前者，效果取决于机型）
        let text_at = find(&out, &GBK.encode("居中").0).unwrap();
        let abs_x = find(&out, &[ESC, b'$']);
        assert!(
            abs_x.map(|p| p > text_at).unwrap_or(true),
            "居中时不该在文本前设绝对 x"
        );
    }

    #[test]
    fn chinese_text_is_gbk_encoded() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5, "value": "苹果" }));
        let out = render(&mut t);
        let gbk = GBK.encode("苹果").0;
        assert!(find(&out, &gbk).is_some(), "文本不是 GBK 编码");
        // 顺带证明它确实**不是** UTF-8
        assert!(find(&out, "苹果".as_bytes()).is_none(), "不该是 UTF-8");
    }

    /// 编不出来的字符必须留痕 —— 否则小票上就是个空格，谁也看不出少了个字
    #[test]
    fn unencodable_chars_warn() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5, "value": "苹果🎉" }));
        let _ = render(&mut t);
        assert_eq!(t.warnings.len(), 1, "告警: {:?}", t.warnings);
        assert!(t.warnings[0].contains("GBK"), "要说清是编码问题: {}", t.warnings[0]);
    }

    /// 旋转画不出来，必须留痕
    #[test]
    fn rotation_warns() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5, "value": "竖排", "angle": 90 }));
        let _ = render(&mut t);
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("90"), "{}", t.warnings[0]);
    }

    #[test]
    fn font_size_becomes_char_size_multiplier() {
        // 203dpi 下 24pt → 67.7 点 → 67.7/24 ≈ 2.8 → 3 倍
        let mut t = one(json!({
            "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5,
            "value": "大", "style": { "fontSize": 24 } }));
        let out = render(&mut t);
        assert!(find(&out, &[GS, b'!', 0x22]).is_some(), "期望 3 倍字号 (0x22)，实际 {:?}", out);
    }

    #[test]
    fn code128_barcode_bytes() {
        let mut t = one(json!({
            "id": "b", "type": "barcode", "left": 0, "top": 0, "width": 40, "height": 12,
            "value": "AB12", "format": "code128", "showText": true }));
        let out = render(&mut t);
        // GS k 73 n=6 0x7B 0x42 + "AB12"
        assert!(find(&out, &[GS, b'k', 73, 6, 0x7B, 0x42]).is_some(), "CODE128 头不对: {:?}", out);
        assert!(find(&out, b"AB12").is_some());
        // 可读文字在下（GS H 2）
        assert!(find(&out, &[GS, b'H', 2]).is_some());
    }

    #[test]
    fn ean13_strips_separators_and_sends_12_digits() {
        let mut t = one(json!({
            "id": "b", "type": "barcode", "left": 0, "top": 0, "width": 40, "height": 12,
            "value": "690-1234-56789", "format": "ean13" }));
        let out = render(&mut t);
        assert!(find(&out, &[GS, b'k', 67, 12]).is_some());
        assert!(find(&out, b"690123456789").is_some(), "应只发 12 位数字");
    }

    /// 位数不够的 EAN13 要留痕，不能发个畸形码让打印机乱画
    #[test]
    fn short_ean13_warns_instead_of_printing_garbage() {
        let mut t = one(json!({
            "id": "b", "type": "barcode", "left": 0, "top": 0, "width": 40, "height": 12,
            "value": "123", "format": "ean13" }));
        let out = render(&mut t);
        assert!(find(&out, &[GS, b'k', 67]).is_none(), "不该发出条码指令");
        assert_eq!(t.warnings.len(), 1);
        assert!(t.warnings[0].contains("EAN13"), "{}", t.warnings[0]);
    }

    #[test]
    fn qr_emits_full_gs_paren_k_sequence() {
        let mut t = one(json!({
            "id": "q", "type": "qrcode", "left": 0, "top": 0, "width": 20, "height": 20,
            "value": "https://x" }));
        let out = render(&mut t);
        // 型号 2 / 纠错 L / 打印
        assert!(find(&out, &[GS, b'(', b'k', 4, 0, 49, 65, 50, 0]).is_some(), "型号段缺失");
        assert!(find(&out, &[GS, b'(', b'k', 3, 0, 49, 69, 48]).is_some(), "纠错段缺失");
        assert!(find(&out, &[GS, b'(', b'k', 3, 0, 49, 81, 48]).is_some(), "打印段缺失");
        // 数据段长度 = "https://x"（9 字节）+ 3
        assert!(find(&out, &[GS, b'(', b'k', 12, 0, 49, 80, 48]).is_some(), "数据段长度不对");
        assert!(find(&out, b"https://x").is_some());
    }

    #[test]
    fn rule_becomes_dashes_sized_by_width() {
        let mut t = one(json!({ "id": "l", "type": "line", "left": 0, "top": 0, "width": 24, "height": 1 }));
        let out = render(&mut t);
        // 24mm × 8 点/mm = 192 点 / 12 点每字符 = 16 个 '-'
        assert!(find(&out, &vec![b'-'; 16]).is_some(), "虚线长度不对: {:?}", out);
        assert!(find(&out, &vec![b'-'; 17]).is_none(), "不该多一个");
    }

    #[test]
    fn box_draws_top_bottom_and_sides() {
        let mut t = one(json!({ "id": "r", "type": "rect", "left": 0, "top": 0, "width": 24, "height": 10 }));
        let out = render(&mut t);
        let dashes = find(&out, &vec![b'-'; 16]).is_some();
        assert!(dashes, "缺少上下横线");
        assert!(find(&out, b"|").is_some(), "缺少左右竖线");
    }

    /// 绝对定位 + 超宽 = 右边被裁掉，而且票据机不会帮你换行，只会切
    #[test]
    fn text_wider_than_paper_warns() {
        // 80mm 纸 = 640 点；40 个汉字 × 2 × 12 = 960 点
        let long: String = "果".repeat(40);
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5, "value": long }));
        let _ = render(&mut t);
        assert_eq!(t.warnings.len(), 1, "{:?}", t.warnings);
        assert!(t.warnings[0].contains("超出纸宽"), "{}", t.warnings[0]);
    }

    /// 反过来：放得下的不该有这条噪音告警
    #[test]
    fn text_that_fits_does_not_warn() {
        let mut t = one(json!({ "id": "t", "type": "text", "left": 0, "top": 0, "width": 80, "height": 5, "value": "短" }));
        let _ = render(&mut t);
        assert!(t.warnings.is_empty(), "{:?}", t.warnings);
    }

    /// 同一行放两个图元之后，后面的图元**不能**被推后一行。
    ///
    /// 这一条是探针发现的：表格第一行有两格（品名 / 数量），打完第二格时
    /// `cur_row += 1` 又加了一次，于是整个方框往上跳了一行。
    /// 断言的是**整条喂行序列**：只数次数抓不住「喂多了一行」。
    #[test]
    fn extra_same_row_items_do_not_push_later_rows_up() {
        let mut t = ticket(
            json!([{ "type": "body", "height": 200, "components": [
                { "id": "a", "type": "text", "left": 0, "top": 3, "width": 20, "height": 5, "value": "左" },
                { "id": "b", "type": "text", "left": 30, "top": 3, "width": 20, "height": 5, "value": "右" },
                { "id": "c", "type": "text", "left": 0, "top": 9, "width": 20, "height": 5, "value": "第三行" }
            ] }]),
            None,
            None,
        );
        // 3mm → 第 1 行；9mm → 第 3 行。
        // 正确：喂 [1]（到第 1 行）+ [1]（第 2 行 → 第 3 行）
        // 有 bug：第二格把 cur_row 推到 3，第三行就不用喂了 → [1]
        let out = render(&mut t);
        let mut feeds = Vec::new();
        let mut i = 0;
        while i + 2 < out.len() {
            if out[i] == ESC && out[i + 1] == b'd' {
                feeds.push(out[i + 2]);
                i += 3;
            } else {
                i += 1;
            }
        }
        assert_eq!(feeds, vec![1, 1], "喂行序列不对（多喂/少喂都会让后面的内容整体错位）");
    }

    /// 两个文本叠在同一行时，第二个不该再喂一次行 —— 喂了就会掉到下一行去
    #[test]
    fn same_row_items_do_not_advance_twice() {
        let mut t = ticket(
            json!([{ "type": "body", "height": 200, "components": [
                { "id": "a", "type": "text", "left": 0, "top": 3, "width": 20, "height": 5, "value": "左" },
                { "id": "b", "type": "text", "left": 30, "top": 3, "width": 20, "height": 5, "value": "右" }
            ] }]),
            None,
            None,
        );
        // 3mm = 24 点 = 1 行；第一个图元喂 1 行，第二个不该再喂
        let out = render(&mut t);
        let feeds = out.windows(2).filter(|w| w == &[ESC, b'd']).count();
        assert_eq!(feeds, 1, "只该喂一次行，实际 {feeds} 次");
        let abs_x = out.windows(2).filter(|w| w == &[ESC, b'$']).count();
        assert_eq!(abs_x, 2, "两个文本各要设一次绝对 x，实际 {abs_x} 次");
    }
}
