//! 渲染结果 → Word（.docx）
//!
//! ## 为什么自研而不引 `docx-rs`
//!
//! 需要的只是「一张表 + 纸张设置」，4 个 XML part。引 crate 会拖进一整棵依赖树，
//! 而**无论谁写，风险都一样**：docx 是 OOXML，**结构错一点 Word 就整个打不开**，
//! 引 crate 只是把这个风险从我的代码挪到别人的代码里，并不消失。自研至少能把
//! 「到底吐了什么」看得清清楚楚，也便于按 ECMA-376 逐条核对。
//!
//! ## 本模块**证明不了**的事（重要）
//!
//! 下面的单测只能证明「写出来的字节符合我对 APPNOTE / ECMA-376 的理解」。
//! **它证明不了 Word 能打开。** 真正读这个文件的是 Word / Pages —— 由
//! `scripts/verify-docx.py` 用 Python 的 `zipfile` + `lxml` 读回来验证，
//! 并且 `scripts/fault-inject-docx.py` 会**故意写坏**来证明那条探针会红。
//! 本机没装 Word / LibreOffice，所以「真 Word 认不认」这一层**没有覆盖**，
//! 不拿「过了 N 条检查」冒充它。
//!
//! ## 表格结构（v1 的取舍）
//!
//! - 一个 sheet → 一张 `<w:tbl>`；多个 sheet 依次排列（分页时 `pages` 每页一张）。
//! - 列宽交给 Word 自适应（`tblW` 用百分比、`tcW` 用 `auto`）—— v1 不做毫米级
//!   列宽换算。**理由**：换算是第 7 节那套「mm ↔ 单位」的另一个端点，容易错，
//!   而自适应在「看内容」这个主要用途上更好用。要精确列宽时再加。
//! - **合并格必须还原**：主格展开出来的就是合并格（`rowspan` / `colspan`），
//!   丢了它报表结构就散了。横向 → `gridSpan`；纵向 → `vMerge` restart/continue。
//! - **不生成 `styles.xml`**：v1 不用命名样式，全部走直接格式化（`w:b` 等）。
//!   少一个 part 就少一处「Content_Types 漏声明」的机会。

use super::model::{GridCell, RenderedSheet};
use super::zip::zip_stored;

/// 1 mm = 56.6929 twips（Word 的长度单位，1 pt = 20 twips）
const TWIPS_PER_MM: f64 = 56.692_913;

/// XML 1.0 允许的字符（Char 产生式）。**超出的必须丢掉** —— 不是「转义」的问题：
/// XML 1.0 **没有**任何写法能表示 0x00、0x0C 这类控制字符（XML 1.1 的 `&#x1;`
/// Word 不认），硬写进去的结果是**整个文件 Word 打不开**。
///
/// 取舍：丢字符会改数据。但另一条路是导出一个打不开的文件 —— 那是更大的静默失败。
/// 实践上这些字符基本是库里的脏数据（0x00 / 0x0C），丢了比留着有用。
fn is_xml_char(c: char) -> bool {
    matches!(c, '\u{9}' | '\u{A}' | '\u{D}')
        || ('\u{20}'..='\u{D7FF}').contains(&c)
        || ('\u{E000}'..='\u{FFFD}').contains(&c)
        || c >= '\u{10000}'
}

/// XML 文本转义，并顺手丢掉 XML 1.0 不允许的字符
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if !is_xml_char(c) {
            continue; // 见 `is_xml_char` 的取舍说明
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

const XML_DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;

/// `[Content_Types].xml`：每个 part 都必须在里有条目，漏一个 Word 就打不开
fn content_types() -> String {
    format!(
        "{XML_DECL}\n\
         <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
         </Types>"
    )
}

/// 包级关系：必须有且指向主文档，否则 Word 找不到正文
fn package_rels() -> String {
    format!(
        "{XML_DECL}\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
         </Relationships>"
    )
}

/// 文档级关系：v1 没有关系可声明，但仍写一个**空的** `Relationships`。
///
/// 不写这个文件也是合法的（OPC 里 `.rels` 可选），但空文件比「缺文件」更不容易
/// 撞上某个读取器的假设 —— 而代价只是多一个 part。
fn document_rels() -> String {
    format!(
        "{XML_DECL}\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>"
    )
}

/// 纵向合并的三种角色
#[derive(Clone, Copy, PartialEq, Debug)]
enum VMerge {
    None,
    /// 合并块的第一格：`w:val="restart"`
    Restart,
    /// 被上面那格盖住的续格：`<w:vMerge/>`（**没有 `w:val`**）
    Continue,
}

/// 一个待输出的格
struct Out<'a> {
    cell: &'a GridCell,
    colspan: usize,
    vmerge: VMerge,
}

/// 一个单元格里的正文：`<w:p>` 可以有多个 run，换行用 `<w:br/>`
fn para_of(text: &str) -> String {
    // 单元格文本里的 \n 在 Word 里**不会**换行（w:t 不认换行符），必须换成 w:br
    let mut body = String::new();
    for (i, line) in text.split('\n').enumerate() {
        let line = line.trim_end_matches('\r'); // CRLF → 只留 LF 的语义
        if i > 0 {
            body.push_str("<w:br/>");
        }
        if !line.is_empty() {
            body.push_str(&format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_escape(line)));
        }
    }
    if body.is_empty() {
        return "<w:p/>".to_string();
    }
    format!("<w:p>{body}</w:p>")
}

fn tc_of(o: &Out) -> String {
    let mut pr = String::new();
    // tcW 放最前（CT_TcPr 的顺序里它排第二，前面只有 cnfStyle，我们不用）
    pr.push_str("<w:tcW w:w=\"0\" w:type=\"auto\"/>");
    if o.colspan > 1 {
        pr.push_str(&format!("<w:gridSpan w:val=\"{}\"/>", o.colspan));
    }
    match o.vmerge {
        VMerge::Restart => pr.push_str("<w:vMerge w:val=\"restart\"/>"),
        VMerge::Continue => pr.push_str("<w:vMerge/>"),
        VMerge::None => {}
    }
    // 续格没有自己的文本（它在视觉上属于上面那格），但 `w:tc` 必须至少有一个块级元素
    let para = if o.vmerge == VMerge::Continue {
        "<w:p/>".to_string()
    } else {
        para_of(&o.cell.text)
    };
    format!("<w:tc><w:tcPr>{pr}</w:tcPr>{para}</w:tc>")
}

/// 把一格一格排成「要输出的格」，处理横纵合并
///
/// 两条规则不一样，别混：
/// - **横向**（colspan）：被盖住的格**不输出**，由 `gridSpan` 吸收掉。
/// - **纵向**（rowspan）：被盖住的格**要输出**一个空的续格（`<w:vMerge/>`），
///   否则 Word 里这一列会整列错位。
fn plan(rows: &[Vec<GridCell>]) -> (Vec<Vec<Out<'_>>>, usize) {
    let n = rows.len();
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut hskip = vec![vec![false; width]; n]; // 被 gridSpan 吸收
    let mut vcont = vec![vec![false; width]; n]; // 纵向合并的续格

    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let cs = cell.colspan.max(1);
            let rs = cell.rowspan.max(1);
            for j in 1..cs {
                if c + j < width {
                    hskip[r][c + j] = true;
                }
            }
            for i in 1..rs {
                if r + i >= n {
                    break;
                }
                for j in 0..cs {
                    if c + j < width {
                        vcont[r + i][c + j] = true;
                        if j > 0 {
                            hskip[r + i][c + j] = true;
                        }
                    }
                }
            }
        }
    }

    let mut out: Vec<Vec<Out>> = Vec::with_capacity(n);
    let mut grid_cols = 0usize;
    for (r, row) in rows.iter().enumerate() {
        let mut line: Vec<Out> = Vec::new();
        let mut span = 0usize;
        for (c, cell) in row.iter().enumerate() {
            if hskip[r][c] {
                continue;
            }
            let cs = cell.colspan.max(1);
            let rs = cell.rowspan.max(1);
            let vmerge = if vcont[r][c] {
                VMerge::Continue
            } else if rs > 1 {
                VMerge::Restart
            } else {
                VMerge::None
            };
            span += cs;
            line.push(Out { cell, colspan: cs, vmerge });
        }
        grid_cols = grid_cols.max(span);
        out.push(line);
    }

    // 补齐在**知道最终列宽之后**做：先算 `grid_cols`，再把窄行补成矩形。
    // （Word 里一行缺格会整行错位，所以宁可补空单元格。）
    for line in out.iter_mut() {
        let span: usize = line.iter().map(|o| o.colspan).sum();
        for _ in span..grid_cols {
            line.push(Out {
                cell: EMPTY_CELL, // 补的格不来自 `rows`，只能用静态空单元格
                colspan: 1,
                vmerge: VMerge::None,
            });
        }
    }

    // 空行（渲染结果里可能有）：给一个空单元格，保住「这里有一行」
    for line in out.iter_mut() {
        if line.is_empty() {
            line.push(Out {
                cell: EMPTY_CELL,
                colspan: 1,
                vmerge: VMerge::None,
            });
        }
    }

    (out, grid_cols.max(1))
}

/// 补空单元格用的静态对象（`plan` 里补的格不来自 `rows`，需要一个 `'static` 引用）
const EMPTY_CELL: &GridCell = &GridCell {
    image: None,
    text: String::new(),
    pos: String::new(),
    rowspan: 1,
    colspan: 1,
    raw_number: None,
    num_format: None,
    formula: None,
    style: None,
    chart: None,
    barcode: None,
};

fn tbl_of(rows: &[Vec<GridCell>]) -> String {
    let (plan, cols) = plan(rows);
    let grid: String = (0..cols).map(|_| "<w:gridCol w:w=\"1000\"/>").collect();
    let body: String = plan
        .iter()
        .map(|line| {
            let tcs: String = line.iter().map(tc_of).collect();
            format!("<w:tr>{tcs}</w:tr>")
        })
        .collect();
    // tblPr 的子元素顺序（CT_TblPr）：tblW → tblBorders。
    // 边框顺序是 CT_TblBorders 定的：top / left / bottom / right / insideH / insideV
    format!(
        "<w:tbl>\
         <w:tblPr>\
         <w:tblW w:w=\"5000\" w:type=\"pct\"/>\
         <w:tblBorders>\
         <w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"000000\"/>\
         <w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"000000\"/>\
         <w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"000000\"/>\
         <w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"000000\"/>\
         <w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"000000\"/>\
         <w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"000000\"/>\
         </w:tblBorders>\
         </w:tblPr>\
         <w:tblGrid>{grid}</w:tblGrid>\
         {body}\
         </w:tbl>"
    )
}

/// 节属性（纸张 / 页边距）。**只吐有信息的部分**：
/// `margin_mm` 是 `None` 时不写 `pgMar` —— 与 HTML / xlsx 同一条「不表态」口径。
fn sect_pr_of(sheet: &RenderedSheet) -> String {
    let Some(ps) = sheet.page_setup.as_ref() else {
        return String::new(); // 没配页面设置 → 不表态，让 Word 用自己的默认
    };
    let w = (ps.width_mm * TWIPS_PER_MM).round() as u32;
    let h = (ps.height_mm * TWIPS_PER_MM).round() as u32;
    let mut s = format!("<w:sectPr><w:pgSz w:w=\"{w}\" w:h=\"{h}\"/>");
    if let Some(m) = ps.margin_mm.as_ref() {
        let t = (m.top * TWIPS_PER_MM).round() as u32;
        let r = (m.right * TWIPS_PER_MM).round() as u32;
        let b = (m.bottom * TWIPS_PER_MM).round() as u32;
        let l = (m.left * TWIPS_PER_MM).round() as u32;
        s.push_str(&format!(
            "<w:pgMar w:top=\"{t}\" w:right=\"{r}\" w:bottom=\"{b}\" w:left=\"{l}\" w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/>"
        ));
    }
    s.push_str("</w:sectPr>");
    s
}

/// 生成 .docx 字节流
pub fn to_docx(sheets: &[RenderedSheet]) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("没有可导出的 sheet".to_string());
    }
    let mut body = String::new();
    for sheet in sheets {
        // 多个 sheet（分页时每页一个）之间插一个空段落隔开；
        // 只有一张表时不加标题段落 —— 别在正文里塞作者没要的东西。
        if sheets.len() > 1 {
            body.push_str(&format!(
                "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                xml_escape(&sheet.name)
            ));
        }
        body.push_str(&tbl_of(&sheet.rows));
        body.push_str("<w:p/>");
    }
    body.push_str(&sect_pr_of(&sheets[0]));

    let doc = format!(
        "{XML_DECL}\n\
         <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
         <w:body>{body}</w:body>\
         </w:document>"
    );

    Ok(zip_stored(&[
        ("[Content_Types].xml", content_types().as_bytes()),
        ("_rels/.rels", package_rels().as_bytes()),
        ("word/_rels/document.xml.rels", document_rels().as_bytes()),
        ("word/document.xml", doc.as_bytes()),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::model::{GridCell, PageMargins, ResolvedPageSetup};

    fn cell(text: &str) -> GridCell {
        GridCell {
            image: None,
            text: text.into(),
            pos: "A1".into(),
            rowspan: 1,
            colspan: 1,
            raw_number: None,
            num_format: None,
            formula: None,
            style: None,
            chart: None,
            barcode: None,
        }
    }

    fn sheet(name: &str, rows: Vec<Vec<GridCell>>) -> RenderedSheet {
        RenderedSheet { name: name.into(), rows, page_setup: None }
    }

    /// 探针（Python）才是真判据，但这里至少能把 XML 拆出来看一眼
    fn document_xml(sheets: &[RenderedSheet]) -> String {
        let bytes = to_docx(sheets).unwrap();
        // 手写一个极小的「找到本地头 + 名字 + 数据」读取，够测试用
        let mut i = 0usize;
        while i + 30 <= bytes.len() {
            let sig = u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            if sig != 0x0403_4b50 {
                break;
            }
            let csize = u32::from_le_bytes([bytes[i + 18], bytes[i + 19], bytes[i + 20], bytes[i + 21]]) as usize;
            let nlen = u16::from_le_bytes([bytes[i + 26], bytes[i + 27]]) as usize;
            let elen = u16::from_le_bytes([bytes[i + 28], bytes[i + 29]]) as usize;
            let name = String::from_utf8(bytes[i + 30..i + 30 + nlen].to_vec()).unwrap();
            let start = i + 30 + nlen + elen;
            if name == "word/document.xml" {
                return String::from_utf8(bytes[start..start + csize].to_vec()).unwrap();
            }
            i = start + csize;
        }
        panic!("没找到 word/document.xml");
    }

    #[test]
    fn empty_sheets_rejected() {
        assert!(to_docx(&[]).is_err());
    }

    /// 五个 part 一个都不能少 —— 漏 Content_Types 是最典型的「Word 打不开」
    #[test]
    fn all_four_parts_are_present() {
        let bytes = to_docx(&[sheet("s", vec![vec![cell("a")]])]).unwrap();
        let s = String::from_utf8_lossy(&bytes).to_string();
        for p in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/_rels/document.xml.rels",
            "word/document.xml",
        ] {
            assert!(s.contains(p), "缺 part: {p}");
        }
    }

    #[test]
    fn content_types_declares_the_main_document() {
        let bytes = to_docx(&[sheet("s", vec![vec![cell("a")]])]).unwrap();
        let s = String::from_utf8_lossy(&bytes).to_string();
        assert!(s.contains("wordprocessingml.document.main+xml"));
    }

    /// 文本必须转义：`&` / `<` / `>` 硬写进去会让 XML 解析失败 → 整个文件打不开
    #[test]
    fn special_chars_are_escaped() {
        let xml = document_xml(&[sheet("s", vec![vec![cell("a & b < c > d")]])]);
        assert!(xml.contains("a &amp; b &lt; c &gt; d"), "未转义: {xml}");
        assert!(!xml.contains("a & b"), "裸 & 会让 XML 解析失败: {xml}");
    }

    /// XML 1.0 不允许的控制字符必须丢掉 —— 留着 Word 直接拒收整个文件
    #[test]
    fn control_chars_are_dropped() {
        let xml = document_xml(&[sheet("s", vec![vec![cell("a\u{0}b\u{c}d")]])]);
        assert!(!xml.contains('\u{0}'), "0x00 必须丢掉");
        assert!(!xml.contains('\u{c}'), "0x0C 必须丢掉");
        assert!(xml.contains("abd"), "可见字符要留着: {xml}");
        // 制表符 / 换行是合法的，要保留
        let xml2 = document_xml(&[sheet("s", vec![vec![cell("a\tb")]])]);
        assert!(xml2.contains('\t'), "\\t 是合法 XML 字符，不该丢");
    }

    /// 换行必须变成 `w:br` —— `w:t` 里的 \n 在 Word 里不会换行
    #[test]
    fn newline_becomes_break() {
        let xml = document_xml(&[sheet("s", vec![vec![cell("l1\nl2")]])]);
        assert!(xml.contains("<w:br/>"), "换行应变成 w:br: {xml}");
        assert!(!xml.contains("l1\nl2"), "不该把裸换行写进 w:t: {xml}");
    }

    /// 横向合并 → gridSpan，且被盖住的格**不输出**
    #[test]
    fn colspan_becomes_grid_span() {
        let mut c = cell("地区");
        c.colspan = 2;
        let xml = document_xml(&[sheet("s", vec![vec![c, cell("被吸收")]])]);
        assert!(xml.contains("<w:gridSpan w:val=\"2\"/>"), "应有 gridSpan: {xml}");
        // 一行里只能有一个 tc
        let tcs = xml.matches("<w:tc>").count();
        assert_eq!(tcs, 1, "被 gridSpan 吸收的格不该再输出一个 tc: {xml}");
    }

    /// 纵向合并：第一格 restart，下面续格要**输出**（空 tc + 无 val 的 vMerge）
    #[test]
    fn rowspan_emits_restart_and_continuation() {
        let mut c = cell("华东");
        c.rowspan = 2;
        let xml = document_xml(&[sheet(
            "s",
            vec![vec![c, cell("100")], vec![cell("济南"), cell("60")]],
        )]);
        assert!(xml.contains("<w:vMerge w:val=\"restart\"/>"), "首格应 restart: {xml}");
        assert!(xml.contains("<w:vMerge/>"), "续格应有空的 vMerge: {xml}");
        // 两行都在，第二行 2 个 tc（一个续格 + 一个自己的格）
        assert_eq!(xml.matches("<w:tr>").count(), 2, "应有两行: {xml}");
    }

    /// 每个 tc 至少有一个块级元素（这里是 w:p），空的 tc 是非法结构
    #[test]
    fn every_tc_has_a_paragraph() {
        let xml = document_xml(&[sheet("s", vec![vec![cell(""), cell("x")]])]);
        for seg in xml.split("<w:tc>").skip(1) {
            let end = seg.find("</w:tc>").unwrap();
            let inner = &seg[..end];
            assert!(inner.contains("<w:p"), "tc 里必须有段落: {inner}");
        }
    }

    /// 列数取最宽的那行，窄行要补齐 —— 否则 Word 里整行错位
    #[test]
    fn rows_are_padded_to_a_rectangle() {
        let mut wide = cell("a");
        wide.colspan = 1;
        let xml = document_xml(&[sheet("s", vec![vec![wide, cell("b"), cell("c")], vec![cell("d")]])]);
        assert!(xml.matches("<w:gridCol").count() == 3, "表宽应取最宽行: {xml}");
        let rows: Vec<&str> = xml.split("<w:tr>").skip(1).collect();
        assert_eq!(rows[1].matches("<w:tc>").count(), 3, "窄行应补齐: {xml}");
    }

    /// 只有一张表时不加标题段落 —— 别往正文里塞作者没要的东西
    #[test]
    fn single_sheet_has_no_heading_paragraph() {
        let xml = document_xml(&[sheet("销售", vec![vec![cell("a")]])]);
        assert!(!xml.contains("销售"), "单表不该出现 sheet 名: {xml}");
    }

    /// 多 sheet（分页）时才加标题
    #[test]
    fn multiple_sheets_get_headings() {
        let xml = document_xml(&[
            sheet("p1", vec![vec![cell("a")]]),
            sheet("p2", vec![vec![cell("b")]]),
        ]);
        assert!(xml.contains("p1") && xml.contains("p2"), "多表应有分节标题: {xml}");
    }

    /// 没配页面设置 → 不吐 sectPr（「不表态」口径，与 HTML / xlsx 一致）
    #[test]
    fn no_page_setup_means_no_sect_pr() {
        let xml = document_xml(&[sheet("s", vec![vec![cell("a")]])]);
        assert!(!xml.contains("sectPr"), "没配就不该表态: {xml}");
    }

    /// 配了纸张 → pgSz 按 twips 写。
    ///
    /// A4 的期望值 **11906 × 16838** 不是我算出来的四舍五入，而是**Word 自己写 A4
    /// 时用的值** —— 拿它当锚点，比「我用 mm×56.69 算了一遍」可靠得多。
    /// （我第一版填的是 11907 × 16840，被这条测试当场打回。）
    #[test]
    fn paper_size_is_written_in_twips() {
        let mut s = sheet("s", vec![vec![cell("a")]]);
        s.page_setup = Some(ResolvedPageSetup {
            paper: Some("A4".into()),
            width_mm: 210.0,
            height_mm: 297.0,
            landscape: false,
            margin_mm: None,
            page_number: None,
            center_horizontally: false,
        });
        let xml = document_xml(&[s]);
        assert!(xml.contains("w:w=\"11906\""), "A4 宽应是 11906 twips（Word 自己的值）: {xml}");
        assert!(xml.contains("w:h=\"16838\""), "A4 高应是 16838 twips（Word 自己的值）: {xml}");
        assert!(!xml.contains("pgMar"), "没写 margin_mm 就不该有 pgMar: {xml}");
    }

    /// 写了 margin_mm 才有 pgMar
    #[test]
    fn margins_are_written_when_authors_set_them() {
        let mut s = sheet("s", vec![vec![cell("a")]]);
        s.page_setup = Some(ResolvedPageSetup {
            paper: Some("A4".into()),
            width_mm: 210.0,
            height_mm: 297.0,
            landscape: false,
            // **四边刻意给四个互不相同的值**：全填 25.4 的话，把 top 写成 left
            // 这种「四边写反」的错会静默通过（都等于 1440）。单位也一样 ——
            // 1 英寸 = 1440 twips，10mm ≈ 567、20mm ≈ 1134，一眼能分辨。
            margin_mm: Some(PageMargins { top: 25.4, right: 10.0, bottom: 20.0, left: 30.0 }),
            page_number: None,
            center_horizontally: false,
        });
        let xml = document_xml(&[s]);
        assert!(xml.contains("pgMar"), "写了 margin_mm 就该有 pgMar: {xml}");
        assert!(xml.contains("w:top=\"1440\""), "25.4mm = 1 英寸 = 1440 twips: {xml}");
        assert!(xml.contains("w:right=\"567\""), "10mm ≈ 567 twips: {xml}");
        assert!(xml.contains("w:bottom=\"1134\""), "20mm ≈ 1134 twips: {xml}");
        assert!(xml.contains("w:left=\"1701\""), "30mm ≈ 1701 twips: {xml}");
    }
}
