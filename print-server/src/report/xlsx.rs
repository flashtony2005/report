//! 展开结果 -> xlsx（含合并单元格与列宽自适应）
//!
//! 只依赖 rust_xlsxwriter，不经过 Excel COM，因此服务端/无头环境同样可用。
//! 数值列写 number（保留可计算性），文本写 string；跨行跨列还原为 merge_range。

use crate::report::model::{parse_image_data_uri, CellStyle, GridCell, HAlign, RenderedSheet, VAlign};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Image, Workbook};
use std::collections::{HashMap, HashSet};

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

/// Excel 默认行高（磅）。20px ÷ (4/3) = 15 磅，与 `rust_xlsxwriter` 的
/// `default_row_height: 20`（像素）是同一个值。
const DEFAULT_ROW_PTS: f64 = 15.0;

/// Excel 行高上限（磅）= 546px。
///
/// 撑行高给图片用时必须夹住：超上限的值 Excel 会拒收整个文件，
/// 而失败形态是「导出按钮点了没反应」这类最难查的东西。
/// 夹住之后图片改由 `fit_image` 的高度兜底缩小 —— 缩小的图至少能看，
/// 坏掉的文件什么都看不到。
const MAX_ROW_PTS: f64 = 409.5;

/// Excel 列宽（字符）→ 像素。
///
/// 镜像 `rust_xlsxwriter` 0.99 的 `Worksheet::set_column_width`：
/// `round(字符 × 7) + 5`（7 = Calibri 11 的最大数字宽，5 = 单元格内边距）。
/// 它那个 `column_pixel_width` 是 `pub(crate)`，外面拿不到，只能自己算一遍。
///
/// **本文件只此一处**：列宽和图片定位都用它，不会两边各算一套。
/// 换算对不对由 `scripts/verify-xlsx-export.py` 从产物的 `xdr:ext`（EMU）
/// 反推真实像素宽来实测 —— 单测证不了这个（它只证「我算的是我以为的」）。
///
/// 注：`chars < 1` 时 crate 走的是另一条公式（`chars × (7+5)`）；本文件列宽
/// 下限是 `MIN_COL_WIDTH = 8`，永远走不到那条分支。
const MAX_DIGIT_WIDTH: f64 = 7.0;
const CELL_PADDING: u32 = 5;

fn col_pixels(chars: u16) -> u32 {
    (f64::from(chars) * MAX_DIGIT_WIDTH).round() as u32 + CELL_PADDING
}

/// 能放下 `px` 像素的**最小**列宽（字符）。
///
/// 是 `col_pixels` 的**上取整**逆运算，不是四舍五入逆运算 ——
/// 四舍五入会算出比图片窄的列：120px → round(115/7)=16 字符 → 117px < 120，
/// 图片还是得缩一点。要的是「至少放得下」，所以解
/// `round(c×7)+5 ≥ px`，即 `c ≥ (px-5.5)/7`，再向上取整。
fn chars_for_pixels(px: u32) -> u16 {
    let c = (f64::from(px) - 5.5) / MAX_DIGIT_WIDTH;
    c.ceil().clamp(f64::from(MIN_COL_WIDTH), f64::from(MAX_COL_WIDTH)) as u16
}

/// 行高（磅）→ 像素，镜像 crate 的 `set_row_height`
fn row_pixels(pts: f64) -> u32 {
    (pts * 4.0 / 3.0).round() as u32
}

/// 图片在 Excel 里的**自然显示尺寸**（像素，已按 dpi 折算）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ImageSize {
    w: u32,
    h: u32,
}

/// 解出来的一张图 + 它的自然显示尺寸
struct DecodedImage {
    img: Image,
    size: ImageSize,
}

/// 几何计算只关心尺寸，不关心 `Image` 对象本身 —— 拆出来是为了能单测
/// （造一个真 `Image` 需要一份真 PNG 字节，跟「算偏移」这件事没关系）。
fn sizes_of(imgs: &HashMap<(usize, usize), DecodedImage>) -> HashMap<(usize, usize), ImageSize> {
    imgs.iter().map(|(k, v)| (*k, v.size)).collect()
}

/// 图片在（合并）格里的落位：缩到多大 + 相对锚格左上角的偏移（都是像素）
struct Placement {
    /// 缩放后的显示尺寸 —— **必须真的拿去 `set_scale_to_size`**，
    /// 只算偏移不缩图的话，偏移是按缩完的尺寸算的、图却是原尺寸，
    /// 结果图会盖到右边那一列去（第一版就是这样，真机探针抓到的）。
    w: u32,
    h: u32,
    x_off: u32,
    y_off: u32,
}

/// Excel 按 **96dpi** 显示图片，而 PNG/JPEG 头里可能写着别的 dpi
///（从打印链路导出的图常写 203），此时「像素数」不等于「显示尺寸」。
/// crate 内部换算成 `width × 96 / width_dpi`（见 `image.rs` 的 `scaled_width`），
/// 这里跟着算一遍 —— 它那个方法是 `pub(crate)`，外面拿不到，
/// 而撑行高 / 算居中偏移都必须先知道「缩完到底多大」。
fn display_size(img: &Image) -> (f64, f64) {
    let dw = img.width_dpi();
    let dh = img.height_dpi();
    let dw = if dw <= 0.0 { 96.0 } else { dw };
    let dh = if dh <= 0.0 { 96.0 } else { dh };
    (img.width() * 96.0 / dw, img.height() * 96.0 / dh)
}

/// 把一张图放进 `avail_w × avail_h` 的格子里，返回
/// `(缩放后宽, 缩放后高, x 偏移, y 偏移)`，单位像素。
///
/// 规则就两条：**等比缩到放得下**（宽、高都要满足）、**只缩不放**。
///
/// 「高度那一维平时不会真的卡住」是因为 `grow_rows_for_images` 已经把锚行撑到
/// 按宽度缩完所需的高度了，所以实际生效的是宽度。高度兜底是留给两种情况：
/// 1. 多行合并格里其它行已经占掉高度、锚行撑不动那么多；
/// 2. Excel 行高上限 `MAX_ROW_PTS`（409.5 磅 ≈ 546px），比这更高的图只能缩。
///
/// 只缩不放：小图（logo）被拉大会糊，作者给的尺寸就是他想要的尺寸。
fn fit_image(nat_w: u32, nat_h: u32, avail_w: u32, avail_h: u32) -> (u32, u32, u32, u32) {
    if nat_w == 0 || nat_h == 0 || avail_w == 0 || avail_h == 0 {
        return (nat_w, nat_h, 0, 0);
    }
    let k = if nat_w > avail_w { f64::from(avail_w) / f64::from(nat_w) } else { 1.0 };
    let mut out_w = (f64::from(nat_w) * k).round().max(1.0) as u32;
    let mut out_h = (f64::from(nat_h) * k).round().max(1.0) as u32;
    if out_h > avail_h {
        let k2 = f64::from(avail_h) / f64::from(out_h);
        out_w = (f64::from(out_w) * k2).round().max(1.0) as u32;
        out_h = avail_h;
    }
    (out_w, out_h, (avail_w - out_w) / 2, (avail_h - out_h) / 2)
}

/// 某格横跨 `colspan` 列的总像素宽
fn span_pixels(widths: &[u16], c: usize, colspan: usize) -> u32 {
    widths.iter().skip(c).take(colspan.max(1)).map(|w| col_pixels(*w)).sum()
}

/// 解出本 sheet 所有图片格。解码失败**直接报错并带上格位** ——
/// 和 `with_style` 一个道理：静默丢图 = 作者改半天看不到任何变化。
fn decode_images(rows: &[Vec<GridCell>]) -> Result<HashMap<(usize, usize), DecodedImage>, String> {
    let mut out = HashMap::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let Some(src) = cell.image.as_deref() else { continue };
            let (_, bytes) =
                parse_image_data_uri(src).map_err(|e| format!("格子 {} 的图片: {e}", cell.pos))?;
            let img = Image::new_from_buffer(&bytes)
                .map_err(|e| format!("格子 {} 的图片解不开: {e}", cell.pos))?;
            let (dw, dh) = display_size(&img);
            out.insert(
                (r, c),
                DecodedImage {
                    img,
                    size: ImageSize {
                        w: dw.round().max(1.0) as u32,
                        h: dh.round().max(1.0) as u32,
                    },
                },
            );
        }
    }
    Ok(out)
}

/// 图片格所在列至少要放得下图片的自然宽度。
///
/// 不这么做的话：`column_widths` 只看文本，图片格文本是空的 → 该列被压到
/// `MIN_COL_WIDTH = 8`（≈61px），一张 600px 宽的图表缩成 61px，功能看着就是坏的。
///
/// 缺口**全加在锚列**上：跨列均摊会让每一列都变宽，而作者只关心「图放得下」。
/// 上限仍是 `MAX_COL_WIDTH` —— 理由同文本列：列越宽，打印时缩放越狠。
fn widen_for_images(
    widths: &mut [u16],
    rows: &[Vec<GridCell>],
    sizes: &HashMap<(usize, usize), ImageSize>,
) {
    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let Some(d) = sizes.get(&(r, c)) else { continue };
            if d.w <= span_pixels(widths, c, cell.colspan) {
                continue;
            }
            if let Some(w) = widths.get_mut(c) {
                *w = chars_for_pixels(d.w).max(*w);
            }
        }
    }
}

/// 图片要占的高度，摊到锚行上（撑高，不缩矮）。
///
/// 不撑行高的话，一张 300px 高的图放进默认 20px 的行里，按宽度缩完还会被
/// `fit_image` 的高度兜底压成 20px —— 图上什么都看不见。
fn grow_rows_for_images(
    row_pts: &mut [f64],
    rows: &[Vec<GridCell>],
    sizes: &HashMap<(usize, usize), ImageSize>,
    widths: &[u16],
) {
    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let Some(d) = sizes.get(&(r, c)) else { continue };
            let avail_w = span_pixels(widths, c, cell.colspan);
            // 按宽度缩完要多高
            let k = if d.w > avail_w { f64::from(avail_w) / f64::from(d.w) } else { 1.0 };
            let need_px = (f64::from(d.h) * k).round().max(1.0) as u32;
            // 合并格：下面那几行已经贡献了的高度要减掉，锚行只出剩下的
            let rs = cell.rowspan.max(1);
            let others: u32 = (r + 1..r + rs)
                .filter_map(|rr| row_pts.get(rr))
                .map(|p| row_pixels(*p))
                .sum();
            // 夹在 Excel 的行高上限里：撑过头会把整个文件写坏（见 MAX_ROW_PTS）
            let need_pts = (f64::from(need_px.saturating_sub(others)) * 3.0 / 4.0).min(MAX_ROW_PTS);
            if let Some(p) = row_pts.get_mut(r) {
                if need_pts > *p {
                    *p = need_pts;
                }
            }
        }
    }
}

/// 算每个图片格最终插在哪、缩多大。要等行高定稿（`row_pts` 不再变）才能算。
fn place_images(
    rows: &[Vec<GridCell>],
    sizes: &HashMap<(usize, usize), ImageSize>,
    widths: &[u16],
    row_pts: &[f64],
) -> HashMap<(usize, usize), Placement> {
    let mut out = HashMap::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let Some(d) = sizes.get(&(r, c)) else { continue };
            let avail_w = span_pixels(widths, c, cell.colspan);
            let rs = cell.rowspan.max(1);
            let avail_h: u32 =
                (r..r + rs).filter_map(|rr| row_pts.get(rr)).map(|p| row_pixels(*p)).sum();
            let (w, h, x_off, y_off) = fit_image(d.w, d.h, avail_w, avail_h);
            out.insert((r, c), Placement { w, h, x_off, y_off });
        }
    }
    out
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

        // 图片先解出来：自然尺寸要用来撑列宽 / 撑行高，对象本身要用来插图
        let imgs = decode_images(&sheet.rows)?;
        let sizes = sizes_of(&imgs);

        let mut widths = column_widths(&sheet.rows);
        widen_for_images(&mut widths, &sheet.rows, &sizes);
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

        // 行高先算成一张表再统一写：文本换行和图片都想改同一行的高度，
        // 逐格直接写的话后写的会把先写的**压回去**（图片格会把换行撑出来的高度削掉）。
        let mut row_pts: Vec<f64> = cell_lines
            .iter()
            .map(|lines| {
                let max_lines = lines.iter().copied().max().unwrap_or(1).max(1);
                if max_lines > 1 {
                    max_lines as f64 * LINE_HEIGHT
                } else {
                    DEFAULT_ROW_PTS
                }
            })
            .collect();
        grow_rows_for_images(&mut row_pts, &sheet.rows, &sizes, &widths);

        // 只有真的不是默认高的行才写行高；其余行不写，保持 Excel 的默认高度。
        // 这样「普通报表」导出的行高跟以前一模一样，改动只落在需要的行上。
        for (r, pts) in row_pts.iter().enumerate() {
            if (*pts - DEFAULT_ROW_PTS).abs() > f64::EPSILON {
                ws.set_row_height(r as u32, *pts).map_err(|e| e.to_string())?;
            }
        }

        // 落位要等行高定稿（上面的 row_pts 不再变）才算，否则纵向居中偏移是错的
        let placed = place_images(&sheet.rows, &sizes, &widths, &row_pts);

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
                }
                // 图片格：格子里**不写文本**，只留边框，图浮在上面。
                // 文本降级成 alt（Excel 里鼠标悬停能看），这也正是引擎侧
                // 对 `from: value` 清空 text、对字面图保留 text 的用意。
                if cell.image.is_some() {
                    if merged {
                        ws.merge_range(
                            r0,
                            c0,
                            r0 + rs as u32 - 1,
                            c0 + cs as u16 - 1,
                            "",
                            &fmt,
                        )
                        .map_err(|e| e.to_string())?;
                    } else {
                        ws.write_blank(r0, c0, &fmt).map_err(|e| e.to_string())?;
                    }
                    if let (Some(pl), Some(d)) = (placed.get(&(r, c)), imgs.get(&(r, c))) {
                        let alt = if cell.text.trim().is_empty() {
                            format!("图片 {}", cell.pos)
                        } else {
                            cell.text.clone()
                        };
                        // 先按算好的尺寸缩，再按算好的偏移插 —— 两件事必须成对，
                        // 只做一件的话图会跑到相邻列上去。
                        let img = d
                            .img
                            .clone()
                            .set_alt_text(alt)
                            .set_scale_to_size(f64::from(pl.w), f64::from(pl.h), true);
                        ws.insert_image_with_offset(r0, c0, &img, pl.x_off, pl.y_off)
                            .map_err(|e| e.to_string())?;
                    }
                } else if merged {
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
            image: None,
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

    /* ------------------------------ 图片格 ------------------------------ */

    /// 120×80 的纯色 PNG（无 pHYs → 96dpi）。用真字节而不是构造 `Image`，
    /// 是因为「crate 认不认这份 PNG」本身就是待验的一件事。
    const PNG_120X80: &str = "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAg0lEQVR42u3QQQ0AAAgEoOtkWjsZyhbOBxsJSPVwIApEi0a0aNEWRItGtGjRFkSLRrRo0YgWjWjRohEtGtGiRSNaNKJFi0a0aESLFo1o0YgWLRrRohEtWjSiRSNatGhEi0a0aNGIFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNGI/mMBOOnHdhiXvCIAAAAASUVORK5CYII=";
    /// 同样 120×80，但 IHDR 后带 pHYs = 203dpi。从打印链路导出的图常带这个，
    /// 而 Excel 按物理尺寸显示 → 自然显示尺寸不是 120px 而是 120×96/203 ≈ 57px。
    const PNG_120X80_203DPI: &str = "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAACXBIWXMAAB84AAAfOAGTPyf1AAAAg0lEQVR42u3QQQ0AAAgEoOtkWjsZyhbOBxsJSPVwIApEi0a0aNEWRItGtGjRFkSLRrRo0YgWjWjRohEtGtGiRSNaNKJFi0a0aESLFo1o0YgWLRrRohEtWjSiRSNatGhEi0a0aNGIFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNGI/mMBOOnHdhiXvCIAAAAASUVORK5CYII=";

    fn png_cell(src: &str, pos: &str) -> GridCell {
        GridCell {
            image: Some(format!("data:image/png;base64,{src}")),
            text: String::new(),
            pos: pos.into(),
            rowspan: 1,
            colspan: 1,
            raw_number: None,
            num_format: None,
            formula: None,
            style: None,
        }
    }

    fn sizes(items: &[(usize, usize, u32, u32)]) -> HashMap<(usize, usize), ImageSize> {
        items
            .iter()
            .map(|(r, c, w, h)| ((*r, *c), ImageSize { w: *w, h: *h }))
            .collect()
    }

    /// 列宽换算必须是 Excel 的那条公式，否则图片居中会整体偏。
    /// 8 字符 = 61px、60 字符 = 425px 是两个有名字的值：
    /// 前者是 MIN_COL_WIDTH（「备注」这种两字词的下限），后者是 MAX_COL_WIDTH。
    #[test]
    fn col_pixels_matches_excel_char_width() {
        assert_eq!(col_pixels(MIN_COL_WIDTH), 61, "8 字符 → round(8×7)+5 = 61");
        assert_eq!(col_pixels(MAX_COL_WIDTH), 425, "60 字符 → round(60×7)+5 = 425");
        assert_eq!(col_pixels(10), 75, "10 字符 → 75");
    }

    #[test]
    fn chars_for_pixels_inverts_col_pixels() {
        for c in [MIN_COL_WIDTH, 10, 20, 40, MAX_COL_WIDTH] {
            assert_eq!(chars_for_pixels(col_pixels(c)), c, "字符 {c} 应能原样还原");
        }
        // 夹在上下限里：算出来超界不许把列宽推到合法范围外
        assert_eq!(chars_for_pixels(10), MIN_COL_WIDTH, "太窄 → 抬到下限");
        assert_eq!(chars_for_pixels(99999), MAX_COL_WIDTH, "太宽 → 压到上限");
    }

    /// 必须是**上取整**逆运算。四舍五入会算出比图还窄的列：
    /// 120px → 16 字符 = 117px，图片照样得缩 —— 这是实测出来的（不是推的）。
    #[test]
    fn chars_for_pixels_never_comes_out_too_narrow() {
        for px in [61u32, 100, 117, 118, 120, 200, 425] {
            let c = chars_for_pixels(px);
            let got = col_pixels(c);
            // 上限是硬夹的，超上限的像素放不下是设计如此（MAX_COL_WIDTH 有打印理由）
            if px <= col_pixels(MAX_COL_WIDTH) {
                assert!(got >= px, "{px}px 需要至少 {got}px 的列，实际 {c} 字符 = {got}px");
            }
        }
    }

    #[test]
    fn row_pixels_matches_excel_points() {
        assert_eq!(row_pixels(DEFAULT_ROW_PTS), 20, "15 磅 = 20px（Excel 默认行高）");
        assert_eq!(row_pixels(30.0), 40, "30 磅 = 40px");
    }

    /// 等比缩到放得下：宽不够按宽定、高不够按高定，并且在格子里居中。
    ///
    /// 这两条断言合起来才是**有判别力**的：只按宽度缩的话第一条过、第二条挂；
    /// 只按高度缩的话反过来。（一开始只写了第一条的数值，注入「按宽高两个方向缩」
    /// 竟然还是绿的 —— 因为那两种写法在那一组数值上恰好等价。见 fault-inject 脚本。）
    #[test]
    fn fit_image_scales_down_to_fit_and_centers() {
        // 宽度定：600×400 → 425×283（行高已被 grow_rows_for_images 撑到 283）
        assert_eq!(fit_image(600, 400, 425, 283), (425, 283, 0, 0));
        // 高度定：可用高只有 100 → 150×100，横向居中 (425-150)/2 = 137
        assert_eq!(fit_image(600, 400, 425, 100), (150, 100, 137, 0));
    }

    /// 高度兜底真的会被用到：Excel 行高上限 546px，比这更高的图撑不上去，只能缩 ——
    /// 不缩的话图会盖到下面几行去（Excel 里图片是浮在格子上的，不会被裁）。
    #[test]
    fn very_tall_image_is_shrunk_by_the_height_limit() {
        // 2000px 高的图、宽 200px：列够宽不用按宽度缩，但行高最多 546px
        let (w, h, x, y) = fit_image(200, 2000, 425, row_pixels(MAX_ROW_PTS));
        assert_eq!((w, h), (55, 546), "应按高度缩到 546px 高");
        assert_eq!(y, 0, "撑满可用高时纵向偏移为 0");
        assert_eq!(x, (425 - 55) / 2, "横向居中");
    }

    /// 小图不放大：logo 被拉大会糊，作者给的尺寸就是他想要的尺寸。
    #[test]
    fn fit_image_never_upscales() {
        // 100×50 放进 425×200 → 原尺寸居中：x = (425-100)/2 = 162, y = (200-50)/2 = 75
        assert_eq!(fit_image(100, 50, 425, 200), (100, 50, 162, 75));
        // 正好填满时偏移为 0
        assert_eq!(fit_image(425, 200, 425, 200), (425, 200, 0, 0));
    }

    /// 退化的输入不许除零 / 不许算出 0 尺寸
    #[test]
    fn fit_image_handles_degenerate_sizes() {
        assert_eq!(fit_image(0, 0, 100, 100), (0, 0, 0, 0));
        assert_eq!(fit_image(100, 50, 0, 100), (100, 50, 0, 0));
        assert_eq!(fit_image(100, 50, 100, 0), (100, 50, 0, 0));
        // 极扁的可用区：兜底后宽高都不许是 0
        let (w, h, _, _) = fit_image(1000, 1000, 100, 3);
        assert!(w >= 1 && h >= 1, "兜底后仍有非零尺寸，实际 {w}×{h}");
        assert!(w <= 100 && h <= 3, "兜底后不许超出可用区，实际 {w}×{h}");
    }

    /// 图片格所在列必须放得下图片，否则 `column_widths` 只看文本（图片格文本为空）
    /// 会把列压到 8 字符 ≈ 61px，一张 120px 的图缩成一半 —— 功能看着就是坏的。
    #[test]
    fn image_widens_its_column() {
        let rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        let mut widths = vec![MIN_COL_WIDTH];
        widen_for_images(&mut widths, &rows, &sizes(&[(0, 0, 120, 80)]));
        // 120px → (120-5)/7 ≈ 16.4 → 16 字符 = 117px ≥ 120? 不，117 < 120
        // 所以至少要 17 字符（124px）。这里断言的是「确实放得下了」。
        assert!(
            col_pixels(widths[0]) >= 120,
            "列宽应放得下 120px，实际 {} 字符 = {}px",
            widths[0],
            col_pixels(widths[0])
        );
    }

    /// 缺口全加在锚列上；本来够宽的列不许被改窄
    #[test]
    fn image_widening_only_grows() {
        let rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        let mut widths = vec![MAX_COL_WIDTH];
        widen_for_images(&mut widths, &rows, &sizes(&[(0, 0, 120, 80)]));
        assert_eq!(widths[0], MAX_COL_WIDTH, "够宽就不该动");

        // 上限仍然生效：一张 5000px 的图也不能把列撑到 MAX_COL_WIDTH 之上
        let mut widths = vec![MIN_COL_WIDTH];
        widen_for_images(&mut widths, &rows, &sizes(&[(0, 0, 5000, 100)]));
        assert_eq!(widths[0], MAX_COL_WIDTH, "超宽图夹到上限");
    }

    /// 图片撑高锚行 —— 不撑的话 80px 高的图在默认 20px 行里会被压成 20px 高
    #[test]
    fn image_row_is_grown_to_fit() {
        let rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        let widths = vec![20]; // 145px，比 120px 宽 → 不缩放
        let mut row_pts = vec![DEFAULT_ROW_PTS];
        grow_rows_for_images(&mut row_pts, &rows, &sizes(&[(0, 0, 120, 80)]), &widths);
        assert_eq!(row_pixels(row_pts[0]), 80, "行高应撑到图片高度 80px");
    }

    /// 图片缩窄后，行高按缩完的高度算（不是原图高度）
    #[test]
    fn image_row_height_follows_scaled_height() {
        let rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        let widths = vec![MIN_COL_WIDTH]; // 61px → 缩放比 61/120
        let mut row_pts = vec![DEFAULT_ROW_PTS];
        grow_rows_for_images(&mut row_pts, &rows, &sizes(&[(0, 0, 120, 80)]), &widths);
        let expect_px = (80.0_f64 * 61.0 / 120.0).round() as u32; // 41
        assert_eq!(row_pixels(row_pts[0]), expect_px, "按缩完的高度撑行");
        assert!(row_pts[0] < DEFAULT_ROW_PTS * 3.0, "不该按原图 80px 撑，实际 {} 磅", row_pts[0]);
    }

    /// 行高**只增不减**：换行撑出来的高行不能因为塞了张小图就被压回去
    #[test]
    fn image_never_shrinks_an_already_tall_row() {
        let rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        let widths = vec![MIN_COL_WIDTH];
        let mut row_pts = vec![90.0]; // 换行撑出来的高行（120px）
        grow_rows_for_images(&mut row_pts, &rows, &sizes(&[(0, 0, 120, 80)]), &widths);
        assert_eq!(row_pts[0], 90.0, "本来就够高，不许改");
    }

    /// 合并格：下面那几行已经贡献的高度要减掉，锚行只出剩下的
    #[test]
    fn merged_image_height_is_shared_across_rows() {
        let mut rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        rows[0][0].rowspan = 2;
        rows.push(vec![cell("", 1, 1, None)]);
        let widths = vec![20]; // 145px → 不缩放，图高 80px
        // 第二行已经 40px（30 磅），锚行只需要再出 40px
        let mut row_pts = vec![DEFAULT_ROW_PTS, 30.0];
        grow_rows_for_images(&mut row_pts, &rows, &sizes(&[(0, 0, 120, 80)]), &widths);
        assert_eq!(row_pts[1], 30.0, "下面那行不该被动");
        assert_eq!(row_pixels(row_pts[0]), 40, "锚行只需补 80-40=40px");
    }

    /// 行高夹在 Excel 上限里 —— 超上限的值会让 Excel 拒收整个文件，
    /// 而失败形态是「导出按钮点了没反应」。
    #[test]
    fn row_height_is_capped_at_excels_maximum() {
        let rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        let widths = vec![20]; // 145px，图按宽度不缩
        let mut row_pts = vec![DEFAULT_ROW_PTS];
        // 3000px 高的图：撑完要 2250 磅，远超 409.5
        grow_rows_for_images(&mut row_pts, &rows, &sizes(&[(0, 0, 200, 3000)]), &widths);
        assert_eq!(row_pts[0], MAX_ROW_PTS, "行高应当夹在 Excel 上限");
        assert_eq!(row_pixels(row_pts[0]), 546, "409.5 磅 ≈ 546px");
    }

    /// 居中偏移要按**合并格总高**算，不是按锚行自己的高
    #[test]
    fn merged_image_is_centered_in_the_whole_span() {
        let mut rows = vec![vec![png_cell(PNG_120X80, "A1")]];
        rows[0][0].rowspan = 2;
        rows.push(vec![cell("", 1, 1, None)]);
        let widths = vec![20];
        let row_pts = vec![DEFAULT_ROW_PTS, 30.0]; // 20px + 40px = 60px
        let placed = place_images(&rows, &sizes(&[(0, 0, 120, 80)]), &widths, &row_pts);
        let p = placed.get(&(0, 0)).expect("应有落位");
        // 图 120×80 放进 145×60 → 高度兜底到 60，宽 90；y 偏移 = (60-60)/2 = 0
        assert_eq!(p.y_off, 0, "图撑满总高时纵向偏移为 0");
        assert_eq!(p.x_off, (145 - 90) / 2, "横向在合并宽里居中");
    }

    /// 真字节检查：xlsx 里得真有 media / drawing 条目。
    ///
    /// zip 的**中央目录里文件名是不压缩的**，所以能直接在字节里搜到 ——
    /// 这是「不解包也能验到东西」的那部分。解包细验（EMU 尺寸、alt）交给
    /// `scripts/verify-xlsx-export.py`。
    #[test]
    fn xlsx_embeds_image_bytes_and_drawing() {
        let sheet = RenderedSheet {
            name: "图片".into(),
            rows: vec![vec![png_cell(PNG_120X80, "A1")]],
        };
        let buf = to_xlsx(&[sheet], 1).expect("带图片的导出应当成功");
        let hay = String::from_utf8_lossy(&buf);
        assert!(hay.contains("xl/media/image1.png"), "zip 里应有 media 条目");
        assert!(hay.contains("xl/drawings/drawing1.xml"), "zip 里应有 drawing 条目");
        assert!(
            buf.windows(8).any(|w| w == b"\x89PNG\r\n\x1a\n"),
            "媒体文件应当是原始 PNG 字节"
        );
    }

    /// 解不开的图片**必须报错并带上格位**，不许静默导出一张白表
    #[test]
    fn undecodable_image_errors_with_cell_pos() {
        let mut c = png_cell(PNG_120X80, "C7");
        c.image = Some("data:image/png;base64,%%%not-base64%%%".into());
        let sheet = RenderedSheet { name: "坏图".into(), rows: vec![vec![c]] };
        let err = to_xlsx(&[sheet], 1).unwrap_err();
        assert!(err.contains("C7"), "报错要带格位，实际：{err}");
    }

    /// 图片格不出文本：`text` 只进 alt，不进单元格
    #[test]
    fn image_cell_writes_alt_text_not_cell_text() {
        let mut c = png_cell(PNG_120X80, "A1");
        c.text = "产品图".into();
        let sheet = RenderedSheet { name: "alt".into(), rows: vec![vec![c]] };
        let buf = to_xlsx(&[sheet], 1).expect("应导出成功");
        let hay = String::from_utf8_lossy(&buf);
        // 图不是被丢掉的
        assert!(hay.contains("xl/media/image1.png"), "图应当嵌进去");
        // 而且没有把它当成普通文本格写进 sharedStrings（sharedStrings 是 deflate 的，
        // 搜不到明文，所以这里只能证明「图在」；文本去留由真机拆包脚本验）
        assert!(hay.contains("xl/drawings/drawing1.xml"));
    }

    /// 203dpi 的图自然显示尺寸要按 dpi 折算 —— 不折的话图会大 2.1 倍，
    /// 而它在设计器里看着是好的（设计器用的是像素）。
    #[test]
    fn high_dpi_image_is_measured_by_physical_size() {
        let imgs = decode_images(&[vec![png_cell(PNG_120X80_203DPI, "A1")]]).unwrap();
        let d = imgs.get(&(0, 0)).expect("应解出来");
        assert_eq!(d.size.w, 57, "120px @203dpi → 120×96/203 ≈ 57px");
        assert_eq!(d.size.h, 38, "80px @203dpi → 80×96/203 ≈ 38px");

        let imgs = decode_images(&[vec![png_cell(PNG_120X80, "A1")]]).unwrap();
        let d = imgs.get(&(0, 0)).expect("应解出来");
        assert_eq!((d.size.w, d.size.h), (120, 80), "96dpi 的图就是像素数本身");
    }
}
