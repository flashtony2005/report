//! `POST /api/report/import` —— 把 xlsx 读成报表模板
//!
//! 这是 NopReport「Excel 作设计器」的第 3 层：**.xlsx 本身就是模板载体**。
//!
//! 导入的来源是别人手上的 Excel，里面不会有我们的批注，所以
//! **格内文本就是唯一的语义通道**——展开方向也写在文本里：
//!
//! ```text
//! =^ds1.city          纵向（行）展开，绑 ds1.city
//! =>ds1.city          横向（列）展开
//! =ds1.city           不展开，只取值
//! =ds1.amount.sum()   字段 + 聚合
//! =educations.school  嵌套数组字段（引擎会自动 UNNEST，见 prepare_dataset）
//! =D3[B3:+0].sum()    层次坐标表达式
//! 其它                 字面量（表头、标题、说明文字）
//! ```
//!
//! `^` / `>` 沿用 NopReport 的 `*=^` / `*=>` 记号，老用户不用重新记。
//! 注意**只有导入这一侧需要它**：我们自己存的是 `ReportDef` JSON，
//! `expand_type` 在 model 里好好的，不必挤进文本。

use std::io::Cursor;

use calamine::{open_workbook_from_rs, Data, Dimensions, Reader, Xlsx};
use serde_json::Value as JsonValue;

use crate::report::model::{
    AggType, CellModel, CellTpl, ExpandType, ReportTemplate, RowTpl, SheetTpl,
};

/// 纵向（行）展开
const DIR_ROW: char = '^';
/// 横向（列）展开
const DIR_COL: char = '>';

/// calamine 单元格 → 文本。整数值不写成 `2000.0`（看着像另一个数）。
fn data_text(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                (*f as i64).to_string()
            } else {
                f.to_string()
            }
        }
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e}"),
    }
}

/// `a.b` / `a.b.c` 这种路径里的标识符是否合法
fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 路径的每一段都合法（`educations.school` 这种嵌套路径要允许中间有点）
fn is_dotted(s: &str) -> bool {
    !s.is_empty() && s.split('.').all(is_ident)
}

/// 格文本 → 模板格。认不出绑定就当字面量。
///
/// 只认 `=` 开头的（跟 Univer / Excel 的公式记号一致，也跟前端 `parseCellText` 同源）。
/// `{{}}` 不在这里认：那是旧方言，没人会在 Excel 里写它。
fn cell_of(raw: &str) -> CellTpl {
    let t = raw.trim();
    let mut body = match t.strip_prefix('=') {
        Some(rest) if !rest.is_empty() => rest.trim(),
        _ => {
            return CellTpl {
                chart: None,
                barcode: None,
                image: None,
                pos: None,
                value: if t.is_empty() { None } else { Some(JsonValue::from(t)) },
                model: None,
                merge_across: 0,
                merge_down: 0,
                merge_to_end: false,
            }
        }
    };

    // 方向标记
    let mut expand: Option<ExpandType> = None;
    if let Some(rest) = body.strip_prefix(DIR_ROW) {
        expand = Some(ExpandType::R);
        body = rest.trim();
    } else if let Some(rest) = body.strip_prefix(DIR_COL) {
        expand = Some(ExpandType::C);
        body = rest.trim();
    }

    // `path.sum()` 这类聚合后缀。函数名在 `(` **之前**（括号里是空的），
    // 所以先切掉末尾的 `()`，再按最后一个 `.` 把 `path` 和函数名分开。
    let mut agg: Option<String> = None;
    let mut path = body;
    if body.len() > 3 && body.ends_with("()") {
        let before = &body[..body.len() - 2];
        if let Some(dot) = before.rfind('.') {
            let name = &before[dot + 1..];
            if matches!(name, "sum" | "count" | "avg" | "min" | "max") {
                agg = Some(name.to_string());
                path = &before[..dot];
            }
        }
    }

    let agg = match agg.as_deref() {
        Some("sum") => Some(AggType::Sum),
        Some("count") => Some(AggType::Count),
        Some("avg") => Some(AggType::Avg),
        Some("min") => Some(AggType::Min),
        Some("max") => Some(AggType::Max),
        _ => None,
    };

    let model = match path.split_once('.') {
        Some((ds, field)) if is_ident(ds) && is_dotted(field) => Some(CellModel {
            ds: Some(ds.to_string()),
            field: Some(field.to_string()),
            agg,
            expand_type: expand.clone(),
            ..Default::default()
        }),
        // 不是 `ds.field` 形状：整段（含聚合后缀）当值表达式，
        // 例如 `D3[B3:+0].sum()` —— 层次坐标里没有数据集前缀
        _ => Some(CellModel {
            ds: Some("ds1".to_string()),
            field: None,
            agg: None,
            expand_type: expand.clone(),
            value_expr: Some(body.to_string()),
            ..Default::default()
        }),
    };

    CellTpl {
        chart: None,
        barcode: None,
        image: None,
        pos: None,
        value: None,
        model,
        merge_across: 0,
        merge_down: 0,
        merge_to_end: false,
    }
}

/// 合并区 → 落在锚点格上的 `merge_across` / `merge_down`
fn apply_merges(rows: &mut [Vec<CellTpl>], merges: &[Dimensions]) {
    for m in merges {
        let (r0, c0) = (m.start.0 as usize, m.start.1 as usize);
        let (r1, c1) = (m.end.0 as usize, m.end.1 as usize);
        if r1 < r0 || c1 < c0 {
            continue;
        }
        if let Some(cell) = rows.get_mut(r0).and_then(|r| r.get_mut(c0)) {
            cell.merge_across = c1 - c0;
            cell.merge_down = r1 - r0;
        }
    }
}

/// 读 xlsx 字节 → 报表模板。sheet 名原样保留，空 sheet 跳过。
pub fn import_xlsx(bytes: &[u8]) -> Result<ReportTemplate, String> {
    let mut wb: Xlsx<Cursor<&[u8]>> =
        open_workbook_from_rs(Cursor::new(bytes)).map_err(|e| format!("xlsx 解析失败：{e}"))?;

    let names: Vec<String> = wb.sheet_names().to_vec();
    let mut sheets = Vec::new();
    for name in &names {
        let range = match wb.worksheet_range(name) {
            Ok(r) => r,
            Err(e) => return Err(format!("读取 sheet「{name}」失败：{e}")),
        };
        let (h, w) = range.get_size();
        if h == 0 || w == 0 {
            continue;
        }
        let mut rows: Vec<Vec<CellTpl>> = Vec::with_capacity(h);
        for r in 0..h {
            let mut row = Vec::with_capacity(w);
            for c in 0..w {
                let text = range
                    .get((r, c))
                    .map(data_text)
                    .unwrap_or_default();
                row.push(cell_of(&text));
            }
            rows.push(row);
        }
        // `Option<Result<..>>`：没有合并区 / 读合并区失败都按「无合并」处理，
        // 不值得为此中断整次导入
        let merges: Vec<Dimensions> = wb.merge_cells_by_sheet_name(name).unwrap_or_default();
        apply_merges(&mut rows, &merges);

        sheets.push(SheetTpl {
            name: name.clone(),
            page: None,
            rows: rows.into_iter().map(|cells| RowTpl { cells }).collect(),
            loop_field: None,
        });
    }

    if sheets.is_empty() {
        return Err("xlsx 里没有可用的 sheet".to_string());
    }
    Ok(ReportTemplate { sheets, datasets: Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_text_stays_literal() {
        let c = cell_of("地区");
        assert_eq!(c.value, Some(JsonValue::from("地区")));
        assert!(c.model.is_none());
    }

    #[test]
    fn plain_eq_is_field_binding() {
        let c = cell_of("=ds1.city");
        let m = c.model.expect("应识别为绑定");
        assert_eq!(m.ds.as_deref(), Some("ds1"));
        assert_eq!(m.field.as_deref(), Some("city"));
        assert!(m.expand_type.is_none());
        assert!(m.agg.is_none());
    }

    #[test]
    fn caret_marks_row_expand_and_gt_marks_col_expand() {
        let r = cell_of("=^ds1.city").model.expect("绑定");
        assert!(matches!(r.expand_type, Some(ExpandType::R)), "{r:?}");
        let c = cell_of("=>ds1.city").model.expect("绑定");
        assert!(matches!(c.expand_type, Some(ExpandType::C)), "{c:?}");
    }

    #[test]
    fn agg_suffix_is_parsed() {
        let m = cell_of("=^ds1.amount.sum()").model.expect("绑定");
        assert_eq!(m.field.as_deref(), Some("amount"));
        assert!(matches!(m.agg, Some(AggType::Sum)), "{m:?}");
        assert!(matches!(m.expand_type, Some(ExpandType::R)));
    }

    #[test]
    fn nested_path_needs_the_ds_prefix() {
        // 嵌套数组要写成 `ds1.educations.school`：按**第一个**点切开，
        // ds=ds1、field=educations.school，交给 prepare_dataset 去 UNNEST
        let m = cell_of("=^ds1.educations.school").model.expect("绑定");
        assert_eq!(m.ds.as_deref(), Some("ds1"));
        assert_eq!(m.field.as_deref(), Some("educations.school"));
    }

    #[test]
    fn bare_two_segment_path_reads_as_ds_dot_field() {
        // 只写两段时无法区分「ds.field」和「嵌套路径」，按 ds.field 解——
        // 这是语法的固有歧义，宁可确定也不要猜
        let m = cell_of("=^educations.school").model.expect("绑定");
        assert_eq!(m.ds.as_deref(), Some("educations"));
        assert_eq!(m.field.as_deref(), Some("school"));
    }

    #[test]
    fn hierarchical_coord_becomes_value_expr() {
        let m = cell_of("=D3[B3:+0].sum()").model.expect("绑定");
        assert_eq!(m.value_expr.as_deref(), Some("D3[B3:+0].sum()"));
        assert!(m.field.is_none());
    }

    #[test]
    fn lone_equals_is_literal() {
        // `=` 单独一个字符是字面量，跟 Univer isFormulaString 的 length>1 判定一致
        let c = cell_of("=");
        assert_eq!(c.value, Some(JsonValue::from("=")));
        assert!(c.model.is_none());
    }

    #[test]
    fn integer_float_is_not_rendered_with_decimal() {
        assert_eq!(data_text(&Data::Float(2000.0)), "2000");
        assert_eq!(data_text(&Data::Float(12.5)), "12.5");
        assert_eq!(data_text(&Data::Int(7)), "7");
    }

    /// 真正闭环：**写出 xlsx → 导入成模板 → 渲染出数据**。
    ///
    /// 前面的测试只验「文本怎么解析」，那一段就算全绿也不能证明
    /// 导入的模板能跑——展开/聚合/合并是引擎的事。这里用
    /// `rust_xlsxwriter` 现场写一个 xlsx（本来就该是别人手上的 Excel，
    /// 但我们不能依赖 /tmp 里某个手工文件），再走完整的 render。
    #[test]
    fn roundtrip_write_then_import_then_render() {
        use crate::report::model::{DataRow, GridCell};
        use crate::report::{render, RenderRequest};
        use rust_xlsxwriter::{Format, Workbook};

        let mut wb = Workbook::new();
        let sh = wb.add_worksheet().set_name("订单明细").unwrap();
        let fmt = Format::new();
        sh.merge_range(0, 0, 0, 1, "订单明细报表", &fmt).unwrap();
        sh.write_string(1, 0, "订单号").unwrap();
        sh.write_string(1, 1, "金额").unwrap();
        sh.write_string(2, 0, "=^ds1.order_no").unwrap();
        sh.write_string(2, 1, "=ds1.amount").unwrap();
        sh.write_string(3, 0, "合计").unwrap();
        sh.write_string(3, 1, "=ds1.amount.sum()").unwrap();
        let buf = wb.save_to_buffer().expect("写出 xlsx buffer");

        // —— 导入：文本语义 + 合并 ——
        let mut tpl = import_xlsx(&buf).expect("导入 xlsx");
        assert_eq!(tpl.sheets.len(), 1);
        assert_eq!(tpl.sheets[0].name, "订单明细");

        let rows = &tpl.sheets[0].rows;
        assert_eq!(rows.len(), 4, "应有 4 行，实际 {rows:?}");
        // A1 的合并要带过来（渲染成 colspan=2）
        let val = |r: usize, c: usize| -> Option<&str> {
            rows[r].cells[c].value.as_ref().and_then(|v| v.as_str())
        };
        assert_eq!(val(0, 0), Some("订单明细报表"));
        assert_eq!(rows[0].cells[0].merge_across, 1, "A1:B1 合并应带过来");
        // 表头是字面量
        assert_eq!(val(1, 0), Some("订单号"));
        assert_eq!(val(1, 1), Some("金额"));
        // A3 纵向展开
        let a3 = rows[2].cells[0].model.as_ref().expect("A3 应是绑定");
        assert_eq!(a3.field.as_deref(), Some("order_no"));
        assert!(matches!(a3.expand_type, Some(ExpandType::R)), "{a3:?}");
        // B3 跟着走，不展开
        let b3 = rows[2].cells[1].model.as_ref().expect("B3 应是绑定");
        assert_eq!(b3.field.as_deref(), Some("amount"));
        assert!(b3.expand_type.is_none(), "{b3:?}");
        // B4 聚合
        let b4 = rows[3].cells[1].model.as_ref().expect("B4 应是绑定");
        assert!(matches!(b4.agg, Some(AggType::Sum)), "{b4:?}");

        // —— 渲染：展开 + 跟随 + 合计 ——
        let row = |no: &str, amt: f64| {
            let mut r = DataRow::new();
            r.insert("order_no".into(), JsonValue::from(no));
            r.insert("amount".into(), JsonValue::from(amt));
            r
        };
        tpl.datasets.insert(
            "ds1".into(),
            vec![row("SO001", 1250.5), row("SO002", 88.0), row("SO003", 640.25)],
        );
        let out = render(RenderRequest {
            template: tpl,
            datasets: None,
            dump: Some(true),
            sources: None,
        })
        .expect("渲染");

        let sheet = &out.sheets[0];
        let txt = |r: usize, c: usize| -> String { sheet.rows[r][c].text.clone() };
        assert_eq!(sheet.rows.len(), 6, "4 行模板 -1 展开行 +3 数据 = 6，实际 {:?}", sheet.rows);
        assert_eq!(txt(0, 0), "订单明细报表");
        assert_eq!(sheet.rows[0][0].colspan, 2, "合并应渲染成 colspan=2");
        assert_eq!(txt(1, 0), "订单号");
        assert_eq!(txt(2, 0), "SO001");
        assert_eq!(txt(2, 1), "1250.50");
        assert_eq!(txt(3, 0), "SO002");
        assert_eq!(txt(3, 1), "88");
        assert_eq!(txt(4, 0), "SO003");
        assert_eq!(txt(4, 1), "640.25");
        assert_eq!(txt(5, 0), "合计");
        // 1250.5 + 88 + 640.25
        assert_eq!(txt(5, 1), "1978.75");
        let warns = out.warnings.clone().unwrap_or_default();
        assert!(warns.is_empty(), "不该有告警：{warns:?}");

        // 金额列必须挂在订单号上（不是各算各的）：层次坐标同时含 A3:i 和 B3:0
        let dump = out.dump.clone().unwrap_or_default();
        for i in 0..3 {
            let want = format!("A3:{i},B3:0 | 行父:A3#{i}");
            assert!(dump.contains(&want), "B3 第 {i} 行应挂 A3#{i}，dump:\n{dump}");
        }
        let _: &GridCell = &sheet.rows[0][0];
    }
}
