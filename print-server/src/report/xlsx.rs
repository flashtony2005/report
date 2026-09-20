//! 展开结果 -> xlsx（含合并单元格与列宽自适应）
//!
//! 只依赖 rust_xlsxwriter，不经过 Excel COM，因此服务端/无头环境同样可用。
//! 数值列写 number（保留可计算性），文本写 string；跨行跨列还原为 merge_range。

use crate::report::model::{CellStyle, HAlign, RenderedSheet, VAlign};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use std::collections::HashSet;

/// 只认 `#RRGGBB`。不猜 `rgb()` / 颜色名 / `#RGB` 简写 —— 猜错了是静默的，
/// 作者会以为自己设的颜色生效了。认不出来就报错，让人当场改对。
fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// 在导出器的基础格式（表头 / 正文 / 换行）上叠加**作者定义的**样式
///
/// 为什么这里报错而不是「认不出来就跳过」：静默丢弃样式等于没设，
/// 作者在设计器里改半天看不到任何变化。宁可导出失败并说清是哪一格哪个值。
fn with_style(base: &Format, st: &CellStyle, pos: &str) -> Result<Format, String> {
    let mut f = base.clone();
    if st.bold == Some(true) {
        f = f.set_bold();
    }
    if st.italic == Some(true) {
        f = f.set_italic();
    }
    if let Some(sz) = st.font_size {
        if !(0.0..=409.0).contains(&sz) || sz <= 0.0 {
            return Err(format!(
                "格子 {pos} 的 style.font_size「{sz}」不合法（Excel 允许 0~409 磅，且须大于 0）"
            ));
        }
        f = f.set_font_size(sz);
    }
    if let Some(c) = st.color.as_deref() {
        if !is_hex_color(c) {
            return Err(format!("格子 {pos} 的 style.color「{c}」不是 #RRGGBB"));
        }
        f = f.set_font_color(c);
    }
    if let Some(b) = st.bg.as_deref() {
        if !is_hex_color(b) {
            return Err(format!("格子 {pos} 的 style.bg「{b}」不是 #RRGGBB"));
        }
        f = f.set_background_color(b);
    }
    // 水平 / 垂直分开设：`set_align` 一次只动一个维度，不会互相覆盖
    if let Some(h) = st.h_align {
        f = f.set_align(match h {
            HAlign::Left => FormatAlign::Left,
            HAlign::Center => FormatAlign::Center,
            HAlign::Right => FormatAlign::Right,
        });
    }
    if let Some(v) = st.v_align {
        f = f.set_align(match v {
            VAlign::Top => FormatAlign::Top,
            VAlign::Middle => FormatAlign::VerticalCenter,
            VAlign::Bottom => FormatAlign::Bottom,
        });
    }
    Ok(f)
}

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
    // 装不下的文本改成换行（配行高一起用），否则 Excel 会把它**裁掉**。
    // 只有确实需要换行的格子才用这一套 —— 普通单行格保持原样。
    let header_wrap = header.clone().set_text_wrap();
    let header_center_wrap = header_center.clone().set_text_wrap();
    let body_wrap = body.clone().set_text_wrap();
    let body_center_wrap = body_center.clone().set_text_wrap();

    for (si, sheet) in sheets.iter().enumerate() {
        let ws = wb.add_worksheet();
        let name = safe_sheet_name(&sheet.name, si);
        ws.set_name(&name).map_err(|e| e.to_string())?;

        // 表头行数：至少 1，也不能超过总行数（`set_repeat_rows` 越界会报错）
        let head_n = repeat_rows.clamp(1, sheet.rows.len().max(1));

        let widths = column_widths(&sheet.rows);
        for (c, w) in widths.iter().enumerate() {
            ws.set_column_width(c as u16, f64::from(*w)).map_err(|e| e.to_string())?;
        }

        // 每个格子需要几行 —— 超过列宽的文本在 Excel 里是**被裁掉**而不是溢出，
        // 所以要么放宽列（有上限，见 MAX_COL_WIDTH）、要么换行 + 撑高行高。
        //
        // 先算一遍再写，是因为行高按「整行最高」定，而写格子是逐格进行的。
        let cell_lines: Vec<Vec<usize>> = sheet
            .rows
            .iter()
            .map(|row| {
                row.iter()
                    .enumerate()
                    .map(|(c, cell)| {
                        // 合并格能用上跨过去那几列的宽度，不然长标题会被误判成要换行
                        let avail: u16 = widths
                            .iter()
                            .skip(c)
                            .take(cell.colspan.max(1))
                            .sum::<u16>()
                            .max(MIN_COL_WIDTH);
                        lines_needed(&cell.text, avail)
                    })
                    .collect()
            })
            .collect();

        // 只有真的要多于一行的行才写行高；其余行不写，保持 Excel 的默认高度。
        // 这样「普通报表」导出的行高跟以前一模一样，改动只落在需要的行上。
        for (r, lines) in cell_lines.iter().enumerate() {
            let max_lines = lines.iter().copied().max().unwrap_or(1).max(1);
            if max_lines > 1 {
                ws.set_row_height(r as u32, max_lines as f64 * LINE_HEIGHT)
                    .map_err(|e| e.to_string())?;
            }
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
                // 只有这个格子自己装不下时才换行；同行的其它格子保持原样
                let wrap = cell_lines[r][c] > 1;
                let fmt = match (is_head, merged, wrap) {
                    (true, true, true) => header_center_wrap.clone(),
                    (true, true, false) => header_center.clone(),
                    (true, false, true) => header_wrap.clone(),
                    (true, false, false) => header.clone(),
                    (false, true, true) => body_center_wrap.clone(),
                    (false, true, false) => body_center.clone(),
                    (false, false, true) => body_wrap.clone(),
                    (false, false, false) => body.clone(),
                };
                // 作者定义的样式叠在基础格式**之上**：表头的加粗底色、正文的细边框
                // 都保留，作者只覆盖他显式设了的那几项（没设的字段是 None，不动）。
                let fmt = match &cell.style {
                    Some(st) => with_style(&fmt, st, &cell.pos)?,
                    None => fmt,
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

/// 一行文本的高度（点）。Excel 默认行高就是 15pt，多一行就再加一个 15。
///
/// 用「行数 × 15」而不是更精细的算法，是因为要跟 Excel 自己算自动行高时的
/// 结果保持一致 —— 否则同一张表在「有自动行高」和「我们写死行高」两种状态下
/// 行列对齐会不一样。
const LINE_HEIGHT: f64 = 15.0;

/// 这段文本在 `avail` 宽的列里需要几行。
///
/// `avail` 是**该格实际能用多少宽**：合并格要把跨过的列宽都算进来，
/// 否则一个横跨 5 列的长标题会被误判成要换行。
///
/// 抽成纯函数是为了能单测 —— 行高和 wrap 都写进 zip，从 `to_xlsx` 返回值上看不见。
fn lines_needed(text: &str, avail: u16) -> usize {
    if text.is_empty() || avail == 0 {
        return 1;
    }
    // 每个 \n 段独立算：硬换行是作者**要**断开的地方，不能跟自动换行混在一起取 max
    text.split('\n')
        .map(|part| usize::from(display_width(part)).div_ceil(usize::from(avail)).max(1))
        .sum::<usize>()
        .max(1)
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
            style: None,
        }
    }

    /// `lines_needed` 的边界：整除、多一点点、硬换行。
    /// 注意 `display_width` 末尾有 +2 内边距，所以 14 个汉字正好是 30 宽。
    #[test]
    fn lines_needed_wraps_only_when_text_exceeds_width() {
        let avail = 30;
        assert_eq!(display_width(&"长".repeat(14)), 30, "前提：14 字 = 30 宽");
        assert_eq!(lines_needed(&"长".repeat(14), avail), 1, "正好装下 = 1 行");
        assert_eq!(lines_needed(&"长".repeat(15), avail), 2, "多 2 宽就得多一行");
        assert_eq!(lines_needed(&"长".repeat(29), avail), 2, "60 宽 = 正好 2 行");
        assert_eq!(lines_needed(&"长".repeat(30), avail), 3, "62 宽 = 3 行");
    }

    #[test]
    fn lines_needed_counts_hard_breaks() {
        // `\n` 是作者**要**断开的地方，不能被自动换行覆盖掉
        assert_eq!(lines_needed("一\n二", 60), 2);
        assert_eq!(lines_needed("一\n二\n三", 60), 3);
        assert_eq!(lines_needed("一\n", 60), 2, "尾随换行也算一行");
    }

    #[test]
    fn lines_needed_adds_wrap_and_hard_breaks() {
        // 第一段 15 字（32 宽 / 30）要 2 行，第二段 1 行 → 共 3 行
        let t = format!("{}\n{}", "长".repeat(15), "短");
        assert_eq!(lines_needed(&t, 30), 3);
    }

    #[test]
    fn lines_needed_never_returns_zero() {
        assert_eq!(lines_needed("", 30), 1, "空串也是 1 行");
        assert_eq!(lines_needed("很长的一段文字", 0), 1, "宽度为 0 时不许除零");
    }

    /// 行高 = 行数 × 15pt。15 是 Excel 自己的默认行高 —— 用别的值会让
    /// 「我们写死行高」和「Excel 自动行高」两种状态下行列对不齐。
    #[test]
    fn line_height_matches_excel_default() {
        assert_eq!(LINE_HEIGHT, 15.0);
    }

    /* ------------------------------ 作者定义的样式 ------------------------------ */

    #[test]
    fn hex_color_only_accepts_rrggbb() {
        assert!(is_hex_color("#D9E1F2"));
        assert!(is_hex_color("#000000"));
        assert!(is_hex_color("#ABCDEF"));
        // 简写、rgb()、颜色名一律不认 —— 猜错是静默的
        assert!(!is_hex_color("#abc"));
        assert!(!is_hex_color("D9E1F2"));
        assert!(!is_hex_color("rgb(217,225,242)"));
        assert!(!is_hex_color("red"));
        assert!(!is_hex_color("#GGGGGG"));
        assert!(!is_hex_color(""));
    }

    /// 认不出来的颜色**必须报错**，不能静默跳过 —— 静默等于作者设了没反应
    #[test]
    fn bad_style_color_errors_instead_of_being_dropped() {
        let base = Format::new();
        let bad = CellStyle { color: Some("red".into()), ..Default::default() };
        let err = with_style(&base, &bad, "A3").unwrap_err();
        assert!(err.contains("A3") && err.contains("style.color"), "{err}");

        let bad_bg = CellStyle { bg: Some("#abc".into()), ..Default::default() };
        let err = with_style(&base, &bad_bg, "B3").unwrap_err();
        assert!(err.contains("B3") && err.contains("style.bg"), "{err}");

        let bad_size = CellStyle { font_size: Some(-1.0), ..Default::default() };
        assert!(with_style(&base, &bad_size, "C3").is_err());
    }

    /// 样式是**叠加**在基础格式上的：作者没设的项不能把导出的表头/边框洗掉。
    ///
    /// `Format` 没有公开的属性读取接口，所以验它序列化出来的 Debug 结构。
    /// 注意颜色在里面是 `RGB(十进制)`，不是 `#RRGGBB` 字符串。
    ///
    /// 故障注入：把 `with_style` 改成「直接返回 `base.clone()`」，
    /// 第 1 条断言（字色生效）应当红。
    #[test]
    fn style_layers_on_top_of_base_format() {
        let base = Format::new().set_bold().set_border(FormatBorder::Thin);
        let st = CellStyle { color: Some("#FF0000".into()), ..Default::default() };
        let out = with_style(&base, &st, "A1").unwrap();
        let dbg = format!("{out:?}");
        // #FF0000 = 16711680
        assert!(dbg.contains("RGB(16711680)"), "字色应生效: {dbg}");
        // 只设了字色 → 基础格式的加粗、边框都得还在
        assert!(dbg.contains("bold: true"), "基础格式的加粗不该被洗掉: {dbg}");
        assert!(dbg.contains("bottom_style: Thin"), "基础格式的边框不该被洗掉: {dbg}");
    }

    /// 作者设的每一项都要落到 Format 上
    #[test]
    fn style_applies_every_field() {
        let base = Format::new();
        let st = CellStyle {
            bold: Some(true),
            italic: Some(true),
            font_size: Some(16.0),
            color: Some("#FF0000".into()),
            bg: Some("#D9E1F2".into()),
            h_align: Some(HAlign::Center),
            v_align: Some(VAlign::Middle),
        };
        let dbg = format!("{:?}", with_style(&base, &st, "A1").unwrap());
        assert!(dbg.contains("bold: true"), "{dbg}");
        assert!(dbg.contains("italic: true"), "{dbg}");
        assert!(dbg.contains("size: \"16\""), "字号: {dbg}");
        assert!(dbg.contains("RGB(16711680)"), "字色 #FF0000: {dbg}");
        assert!(
            dbg.contains("background_color: RGB(14279154)"),
            "底色 #D9E1F2 = 14279154: {dbg}"
        );
        assert!(dbg.contains("horizontal: Center"), "水平居中: {dbg}");
        assert!(dbg.contains("vertical: VerticalCenter"), "垂直居中: {dbg}");
    }

    /// 没设的项保持不动（`None` 不等于「关掉」）
    #[test]
    fn style_leaves_unset_fields_alone() {
        let base = Format::new().set_bold();
        let st = CellStyle { italic: Some(true), ..Default::default() };
        let dbg = format!("{:?}", with_style(&base, &st, "A1").unwrap());
        assert!(dbg.contains("italic: true"), "{dbg}");
        assert!(dbg.contains("bold: true"), "没设 bold 就不该动它: {dbg}");
        assert!(dbg.contains("horizontal: General"), "没设对齐就不该动它: {dbg}");
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
