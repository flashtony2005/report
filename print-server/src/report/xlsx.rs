//! 展开结果 -> xlsx（含合并单元格与列宽自适应）
//!
//! 只依赖 rust_xlsxwriter，不经过 Excel COM，因此服务端/无头环境同样可用。
//! 数值列写 number（保留可计算性），文本写 string；跨行跨列还原为 merge_range。

use crate::report::model::RenderedSheet;
use rust_xlsxwriter::{Format, Workbook};

/// 生成 xlsx 二进制
pub fn to_xlsx(sheets: &[RenderedSheet]) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("没有可导出的 sheet".to_string());
    }
    let mut wb = Workbook::new();

    let header = Format::new().set_bold().set_background_color("#D9E1F2");
    let center = Format::new().set_align(rust_xlsxwriter::FormatAlign::Center);

    for (si, sheet) in sheets.iter().enumerate() {
        let ws = wb.add_worksheet();
        let name = safe_sheet_name(&sheet.name, si);
        ws.set_name(&name).map_err(|e| e.to_string())?;

        // 列宽：按该列最长文本粗略估算（中文按 2 个字符宽算）
        let ncols = sheet.rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let mut widths = vec![0u16; ncols];
        for row in sheet.rows.iter() {
            for (c, cell) in row.iter().enumerate() {
                if c < widths.len() {
                    widths[c] = widths[c].max(display_width(&cell.text));
                }
            }
        }
        for (c, w) in widths.iter().enumerate() {
            ws.set_column_width(c as u16, f64::from((*w).clamp(8, 40)))
                .map_err(|e| e.to_string())?;
        }

        // 表头样式：第一行非空单元格加粗+底色
        if let Some(first) = sheet.rows.first() {
            for (c, cell) in first.iter().enumerate() {
                if cell.text.trim().is_empty() {
                    continue;
                }
                let fmt = if cell.rowspan.max(1) > 1 || cell.colspan.max(1) > 1 {
                    header.clone().set_align(rust_xlsxwriter::FormatAlign::Center)
                } else {
                    header.clone()
                };
                if cell.rowspan.max(1) > 1 || cell.colspan.max(1) > 1 {
                    ws.merge_range(
                        0u32,
                        c as u16,
                        (cell.rowspan.max(1) - 1) as u32,
                        (c + cell.colspan.max(1) - 1) as u16,
                        &cell.text,
                        &fmt,
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    ws.write_string_with_format(0, c as u16, &cell.text, &fmt)
                        .map_err(|e| e.to_string())?;
                }
            }
        }

        for (r, row) in sheet.rows.iter().enumerate().skip(1) {
            for (c, cell) in row.iter().enumerate() {
                if cell.text.trim().is_empty() {
                    continue;
                }
                let r0 = r as u32;
                let c0 = c as u16;
                let rs = cell.rowspan.max(1);
                let cs = cell.colspan.max(1);
                if rs > 1 || cs > 1 {
                    ws.merge_range(r0, c0, r0 + rs as u32 - 1, c0 + cs as u16 - 1, &cell.text, &center)
                        .map_err(|e| e.to_string())?;
                } else {
                    match cell.raw_number {
                        Some(n) => match &cell.num_format {
                            // 带格式的数值格：Excel 侧套用数字格式（保留可计算性，显示交给格式串）
                            Some(nf) => ws
                                .write_number_with_format(r0, c0, n, &Format::new().set_num_format(nf))
                                .map_err(|e| e.to_string())?,
                            None => ws.write_number(r0, c0, n).map_err(|e| e.to_string())?,
                        },
                        None => ws.write_string(r0, c0, &cell.text).map_err(|e| e.to_string())?,
                    };
                }
            }
        }
    }

    wb.save_to_buffer().map_err(|e| e.to_string())
}

/// Excel 表名：≤31 字符，去掉 []:*?/\ 等非法字符
fn safe_sheet_name(name: &str, idx: usize) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
        .collect();
    let cleaned = cleaned.trim();
    let mut s = if cleaned.is_empty() {
        format!("sheet{}", idx + 1)
    } else {
        cleaned.chars().take(31).collect()
    };
    if s.is_empty() {
        s = format!("sheet{}", idx + 1);
    }
    s
}

/// 显示宽度估算：中日韩全角字符算 2
fn display_width(s: &str) -> u16 {
    s.chars()
        .map(|c| {
            if (c as u32) > 0x2E80 {
                2
            } else {
                1
            }
        })
        .sum::<u16>()
        + 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::model::GridCell;

    fn cell(text: &str, rowspan: usize, colspan: usize, num: Option<f64>) -> GridCell {
        GridCell {
            text: text.into(),
            pos: String::new(),
            rowspan,
            colspan,
            raw_number: num,
            num_format: None,
        }
    }

    #[test]
    fn sheet_name_is_sanitized() {
        assert_eq!(safe_sheet_name("销[售]:表", 0), "销售表");
        assert_eq!(safe_sheet_name("", 2), "sheet3");
        assert!(safe_sheet_name(&"长".repeat(50), 0).chars().count() <= 31);
    }

    #[test]
    fn xlsx_has_valid_zip_signature() {
        let sheet = RenderedSheet {
            name: "测试".into(),
            rows: vec![
                vec![cell("地区", 1, 1, None), cell("金额", 1, 1, None)],
                vec![cell("华东", 1, 1, None), cell("37,900", 1, 1, Some(37900.0))],
            ],
        };
        let buf = to_xlsx(&[sheet]).unwrap();
        // xlsx 本质是 zip：本地文件头 PK\x03\x04
        assert_eq!(&buf[..4], &[0x50, 0x4B, 0x03, 0x04]);
        assert!(buf.len() > 1000, "xlsx 体积异常: {}", buf.len());
    }

    #[test]
    fn empty_sheets_rejected() {
        assert!(to_xlsx(&[]).is_err());
    }
}
