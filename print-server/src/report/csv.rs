//! 渲染结果 → CSV（RFC 4180）
//!
//! CSV 是「一张表」的格式，没有 sheet、没有合并、没有样式，所以这里刻意做得很薄：
//! 每行按格子顺序写出 `text`，列数不一致也不补（渲染出来的行本来就是锯齿状的）。
//!
//! 为什么不写公式：`GridCell.formula` 是给 Excel 用的，CSV 里等于号开头会被
//! 当成公式文本，语义完全不同 —— 一律写 **`text`**（已算好的值）。
//!
//! 关于 CSV 注入（`=cmd|...` 这类被 Excel 当公式执行）：**这里不做改写**。
//! 加了 `'` 前缀能防住，但会把 `+86...` 这种真实手机号也改掉，属于拿正确性换安全。
//! 本服务的报表数据来自自己配置的库，属于可信输入；真要导不可信数据，应在
//! 消费侧处理。这个取舍写在这里，免得以后有人以为是漏了。

use super::model::RenderedSheet;

/// UTF-8 BOM：没有它 Excel 打开中文全是乱码（会用本地 ANSI 码页猜）
const BOM: &str = "\u{feff}";

/// 需要加引号的字段：含分隔符、引号或换行（RFC 4180）
fn needs_quotes(s: &str) -> bool {
    s.contains([',', '"', '\n', '\r'])
}

/// 单字段转义：整体加引号，内部 `"` 写成 `""`
fn escape_field(s: &str) -> String {
    if needs_quotes(s) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 生成 CSV 字节流（带 BOM，CRLF 换行）
///
/// 多个 sheet 按**顺序拼接** —— CSV 表达不了 sheet 概念，拼起来至少不丢数据。
/// 分页产生的多个 sheet 本来就是同一张表切开的，拼起来正好还原。
pub fn to_csv(sheets: &[RenderedSheet]) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("没有可导出的 sheet".to_string());
    }
    let mut out = String::from(BOM);
    for sheet in sheets {
        for row in &sheet.rows {
            let line: Vec<String> = row.iter().map(|c| escape_field(&c.text)).collect();
            out.push_str(&line.join(","));
            out.push_str("\r\n");
        }
    }
    Ok(out.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::model::GridCell;

    fn cell(text: &str) -> GridCell {
        GridCell {
            text: text.into(),
            pos: "A1".into(),
            rowspan: 1,
            colspan: 1,
            raw_number: None,
            num_format: None,
            formula: None,
            style: None,
        }
    }

    fn sheet(name: &str, rows: Vec<Vec<GridCell>>) -> RenderedSheet {
        RenderedSheet { name: name.into(), rows }
    }

    fn text_of(sheets: &[RenderedSheet]) -> String {
        String::from_utf8(to_csv(sheets).unwrap()).unwrap()
    }

    #[test]
    fn empty_sheets_rejected() {
        assert!(to_csv(&[]).is_err());
    }

    /// BOM 必须在最前面，否则 Excel 开中文乱码
    #[test]
    fn starts_with_bom() {
        let s = text_of(&[sheet("s", vec![vec![cell("地区")]])]);
        assert!(s.starts_with('\u{feff}'), "缺 BOM: {s:?}");
        assert!(s.contains("地区"));
    }

    #[test]
    fn plain_fields_are_not_quoted() {
        let s = text_of(&[sheet("s", vec![vec![cell("华东"), cell("1200")]])]);
        assert!(s.ends_with("华东,1200\r\n"), "不该加引号: {s:?}");
    }

    /// 逗号 / 引号 / 换行三种都必须转义；引号要翻倍
    #[test]
    fn special_chars_are_escaped() {
        let s = text_of(&[sheet(
            "s",
            vec![vec![cell("a,b"), cell("say \"hi\""), cell("l1\nl2")]],
        )]);
        assert!(s.contains("\"a,b\""), "逗号未转义: {s:?}");
        assert!(s.contains("\"say \"\"hi\"\"\""), "引号未翻倍: {s:?}");
        assert!(s.contains("\"l1\nl2\""), "换行未转义: {s:?}");
    }

    /// CRLF 换行（RFC 4180），不是裸 \n
    #[test]
    fn uses_crlf_line_endings() {
        let s = text_of(&[sheet("s", vec![vec![cell("a")], vec![cell("b")]])]);
        assert!(s.contains("a\r\nb\r\n"), "换行应为 CRLF: {s:?}");
    }

    /// 公式格导出的是**值**不是公式 —— CSV 里 "=SUM(...)" 只是文本，语义完全不同
    #[test]
    fn formula_cell_exports_its_text() {
        let mut c = cell("3500");
        c.formula = Some("SUM(D4:D6)".into());
        let s = text_of(&[sheet("s", vec![vec![c]])]);
        assert!(s.contains("3500"), "应导出算好的值: {s:?}");
        assert!(!s.contains("SUM("), "不该把公式写进 CSV: {s:?}");
    }

    /// 多个 sheet 顺序拼接，数据不丢
    #[test]
    fn multiple_sheets_are_concatenated() {
        let s = text_of(&[
            sheet("p1", vec![vec![cell("a")]]),
            sheet("p2", vec![vec![cell("b")]]),
        ]);
        assert!(s.contains("a\r\nb\r\n"), "两个 sheet 应顺序拼起来: {s:?}");
    }

    /// 空行（渲染结果里可能有）也要占一行：整行没格子 → 直接一个 CRLF
    #[test]
    fn empty_row_emits_blank_line() {
        let s = text_of(&[sheet("s", vec![vec![], vec![cell("x")]])]);
        assert_eq!(s, "\u{feff}\r\nx\r\n", "空行应输出一个空行: {s:?}");
    }
}
