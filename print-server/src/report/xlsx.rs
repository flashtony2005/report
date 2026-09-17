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

        for (c, w) in column_widths(&sheet.rows).iter().enumerate() {
            ws.set_column_width(c as u16, f64::from(*w)).map_err(|e| e.to_string())?;
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
        // 缩放到「一页宽」：列多的时候否则会溢出到右侧多出半页，
        // 那半页既没有表头、也看不出属于哪一行。
        // 高度给 0 = 不限页数，纵向该几页就几页。
        // 这个调用会把 print_scale 固定成 100，所以**只会缩小、不会放大**。
        //
        // 纸张大小与方向**刻意不设**：用什么纸取决于现场打印机
        //（A4 / 241 连续纸 / 标签纸都可能），写死反而可能不对。
        ws.set_print_fit_to_pages(1, 0);
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

/// 列宽下限：短列（「备注」「编码」这类两字词）也留一点余量，别挤成一条缝
const MIN_COL_WIDTH: u16 = 8;
/// 列宽上限。**刻意保留的取舍**，不是随手写的数：
///
/// - 不设上限时，一列长备注能把整表撑到几百字符宽；而导出同时开了
///   `set_print_fit_to_pages(1, 0)`（缩放到一页宽），越宽 → 缩放越狠 →
///   **打印出来字越小**，等于为了不截断而牺牲了整张表的可读性。
/// - 40 又太紧：实测 23 个汉字的备注是 46 宽，被截掉一截（相邻列有内容时
///   Excel 是裁掉而不是溢出）。
/// - 60 ≈ 30 个汉字 / 60 个英文字符，覆盖常见的备注、地址、品名列，
///   而典型报表总宽仍在一页之内，不会触发额外缩小。
///
/// 超过上限的仍然会截断 —— 真要完整显示长文本，应该走「换行 + 设行高」，
/// 那是另一件事（会改变行高，属于产品取舍）。
const MAX_COL_WIDTH: u16 = 60;

/// 每列的宽度（字符数）。抽成纯函数是为了能单测 —— 列宽写进 zip 里，
/// 从 `to_xlsx` 的返回值上看不出来，只能靠 `scripts/verify-xlsx-export.py` 拆包验。
fn column_widths(rows: &[Vec<crate::report::model::GridCell>]) -> Vec<u16> {
    let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut widths = vec![0u16; ncols];
    for row in rows.iter() {
        for (c, cell) in row.iter().enumerate() {
            if c < widths.len() {
                widths[c] = widths[c].max(display_width(&cell.text));
            }
        }
    }
    for w in widths.iter_mut() {
        *w = (*w).clamp(MIN_COL_WIDTH, MAX_COL_WIDTH);
    }
    widths
}

/// 显示宽度估算：中日韩全角字符算 2，**末尾另加 2 的内边距**。
///
/// 那 +2 不是随手写的：估算本身就粗（同一个字符在不同字体里宽度不同），
/// 少了会贴边、看着像截断；而且 `write_blank` 补出来的空格子也需要这点余量。
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
    fn column_width_uses_longest_text_in_the_column() {
        let rows = vec![
            vec![cell("备注", 1, 1, None), cell("编码", 1, 1, None)],
            vec![cell("华东", 1, 1, None), cell("A-001", 1, 1, None)],
        ];
        // 「备注」= 4、「华东」= 4 → 4，低于下限被抬到 8；「A-001」= 5 → 同样抬到 8
        assert_eq!(column_widths(&rows), vec![MIN_COL_WIDTH, MIN_COL_WIDTH]);
    }

    /// 上限 60：**23 个汉字的备注是 46 宽**，40 那版会把它截断。
    /// 这条是「抬高上限」那次改动的钉子 —— 数字写死在这里，改了就会红。
    #[test]
    fn column_width_caps_at_60_not_40() {
        // 23 字 × 2 + 2 内边距 = 48 宽
        let note = "这是一段比较长的备注文字用来观察列宽上限的表现";
        let rows = vec![vec![cell(note, 1, 1, None)]];
        assert_eq!(display_width(note), 48, "前提：这段文本是 48 宽");
        assert_eq!(column_widths(&rows), vec![48], "48 在 40~60 之间：旧上限会夹、新上限不该夹");

        let longer = "长".repeat(40); // 80 宽
        let rows = vec![vec![cell(&longer, 1, 1, None)]];
        assert_eq!(column_widths(&rows), vec![MAX_COL_WIDTH], "超过上限要夹到 60");
        assert_eq!(MAX_COL_WIDTH, 60, "上限就是 60，改这个值要同步改注释里的理由");
    }

    #[test]
    fn column_width_counts_cjk_as_two() {
        // 都含 +2 的内边距
        assert_eq!(display_width("abc"), 5, "3 + 2");
        assert_eq!(display_width("中国"), 6, "2×2 + 2");
        assert_eq!(display_width("金额(元)"), 10, "4 全角 + 2 半角括号 + 2");
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
