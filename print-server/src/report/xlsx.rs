//! 展开结果 -> xlsx（含合并单元格与列宽自适应）
//!
//! 只依赖 rust_xlsxwriter，不经过 Excel COM，因此服务端/无头环境同样可用。
//! 数值列写 number（保留可计算性），文本写 string；跨行跨列还原为 merge_range。

use crate::report::model::RenderedSheet;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use std::collections::HashSet;

/// 生成 xlsx 二进制
///
/// `repeat_rows`：打印时**每页顶部重复**的表头行数，同时决定前几行用表头样式。
/// 取模板分页配置里的 `repeat_header_rows`（与分页渲染用的是同一个值）；
/// 没配分页时调用方给 1。
///
/// 两件事一起做是因为它们是同一个数：**多行表头**以前只有第一行有样式
///（第二行起是白板），而「打印时表头不跨页重复」又是多页报表的硬伤。
pub fn to_xlsx(sheets: &[RenderedSheet], repeat_rows: usize) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("没有可导出的 sheet".to_string());
    }
    let mut wb = Workbook::new();

    // 细边框：中国式报表的表格几乎都有框线，以前导出是「裸表」——一个边框都不画。
    let thin = FormatBorder::Thin;
    let header = Format::new().set_bold().set_background_color("#D9E1F2").set_border(thin);
    let header_center = header.clone().set_align(FormatAlign::Center);
    let body = Format::new().set_border(thin);
    let body_center = body.clone().set_align(FormatAlign::Center);

    for (si, sheet) in sheets.iter().enumerate() {
        let ws = wb.add_worksheet();
        let name = safe_sheet_name(&sheet.name, si);
        ws.set_name(&name).map_err(|e| e.to_string())?;

        // 表头行数：至少 1，也不能超过总行数（`set_repeat_rows` 越界会报错）
        let head_n = repeat_rows.clamp(1, sheet.rows.len().max(1));

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

        // 已被合并区覆盖的格子：合并区内部**不能**再单独写值，否则会把合并冲掉。
        // 空单元格也要补边框（网格才完整），所以得先知道哪些格子是被覆盖的。
        let mut covered: HashSet<(u32, u16)> = HashSet::new();

        for (r, row) in sheet.rows.iter().enumerate() {
            let is_head = r < head_n;
            for (c, cell) in row.iter().enumerate() {
                let r0 = r as u32;
                let c0 = c as u16;
                if covered.contains(&(r0, c0)) {
                    continue;
                }
                let rs = cell.rowspan.max(1);
                let cs = cell.colspan.max(1);
                let merged = rs > 1 || cs > 1;
                let fmt = match (is_head, merged) {
                    (true, true) => header_center.clone(),
                    (true, false) => header.clone(),
                    (false, true) => body_center.clone(),
                    (false, false) => body.clone(),
                };
                if merged {
                    for rr in r0..r0 + rs as u32 {
                        for cc in c0..c0 + cs as u16 {
                            covered.insert((rr, cc));
                        }
                    }
                    ws.merge_range(r0, c0, r0 + rs as u32 - 1, c0 + cs as u16 - 1, &cell.text, &fmt)
                        .map_err(|e| e.to_string())?;
                } else if cell.text.trim().is_empty() {
                    // 空格子也要有边框，否则网格到处是缺口
                    ws.write_blank(r0, c0, &fmt).map_err(|e| e.to_string())?;
                } else if let Some(f) = &cell.formula {
                    // export_formula：写公式而不是值，导出后在 Excel 里改明细会自动重算
                    let f2 = match &cell.num_format {
                        Some(nf) => fmt.clone().set_num_format(nf),
                        None => fmt,
                    };
                    ws.write_formula_with_format(r0, c0, f.as_str(), &f2)
                        .map_err(|e| e.to_string())?;
                } else if let Some(n) = cell.raw_number {
                    // 写 number 而不是文本，导出后仍可计算；格式串照常套上
                    let f2 = match &cell.num_format {
                        Some(nf) => fmt.clone().set_num_format(nf),
                        None => fmt,
                    };
                    ws.write_number_with_format(r0, c0, n, &f2).map_err(|e| e.to_string())?;
                } else {
                    ws.write_string_with_format(r0, c0, &cell.text, &fmt)
                        .map_err(|e| e.to_string())?;
                }
            }
        }

        // 打印时表头跨页重复 —— 多页报表没它就是「第 2 页起不知道每列是什么」
        ws.set_repeat_rows(0, head_n as u32 - 1).map_err(|e| e.to_string())?;
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
            formula: None,
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
        let buf = to_xlsx(&[sheet], 1).unwrap();
        // xlsx 本质是 zip：本地文件头 PK\x03\x04
        assert_eq!(&buf[..4], &[0x50, 0x4B, 0x03, 0x04]);
        assert!(buf.len() > 1000, "xlsx 体积异常: {}", buf.len());
    }

    #[test]
    fn empty_sheets_rejected() {
        assert!(to_xlsx(&[], 1).is_err());
    }

    /// `repeat_rows` 的越界值必须被夹住，不能让 `set_repeat_rows` 报错把整个导出弄挂。
    ///
    /// 0（有人配了却没填值）和 999（配得比表格还高）都是**现实会发生**的输入，
    /// 而失败形态是「导出按钮点了没反应」，属于最难排查的那类。
    #[test]
    fn repeat_rows_out_of_range_is_clamped() {
        let sheet = || RenderedSheet {
            name: "测试".into(),
            rows: vec![
                vec![cell("地区", 1, 1, None), cell("金额", 1, 1, None)],
                vec![cell("华东", 1, 1, None), cell("37,900", 1, 1, Some(37900.0))],
            ],
        };
        // 0 → 至少 1 行
        assert!(to_xlsx(&[sheet()], 0).is_ok(), "repeat_rows=0 应夹成 1");
        // 999 → 最多就是总行数
        assert!(to_xlsx(&[sheet()], 999).is_ok(), "repeat_rows 超过总行数应夹住");
        assert!(to_xlsx(&[sheet()], 2).is_ok());
        // 只有一行时也不能炸
        let one = RenderedSheet {
            name: "单行".into(),
            rows: vec![vec![cell("标题", 1, 1, None)]],
        };
        assert!(to_xlsx(&[one], 3).is_ok());
    }
}
