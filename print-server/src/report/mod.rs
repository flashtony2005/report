//! 网格报表（类 Excel 非线性报表）服务端引擎
//!
//! 算法移植自 NopReport（Java）：主格树 -> 递归展开 -> 层次坐标求值。
//! 服务暴露在 print-server 的 18888 端口：
//! - `POST /api/report/render`  提交模板 + 数据集，返回展开后的网格与 HTML
//! - `GET  /api/report/sample`  内置「销售分组汇总」样例（可直接验证链路）
//! - `GET  /api/report/sample-template`  样例模板（前端设计器的初始内容）

pub mod engine;
pub mod model;
pub mod xlsx;

use axum::extract::{Json, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{Response as HttpResponse, StatusCode};
use model::*;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct RenderRequest {
    pub template: ReportTemplate,
    /// 可选：覆盖模板自带的数据集
    #[serde(default)]
    pub datasets: Option<BTreeMap<String, DataSet>>,
    /// 可选：由服务端现查的数据源（走 print-server 已配置的数据库连接，同 /api/data/rows）
    #[serde(default)]
    pub sources: Option<Vec<ReportSource>>,
}

/// 报表数据源声明：字段与 /api/data/rows 的 DataQuery 对齐，另加 name 作为数据集名
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportSource {
    /// 数据集名，需与模板单元格 model.ds 对应
    pub name: String,
    pub conn_id: Option<String>,
    pub engine: Option<String>,
    pub database: Option<String>,
    /// 表或视图名
    pub table: Option<String>,
    /// 逗号分隔字段白名单；缺省取全部列
    pub fields: Option<String>,
    pub limit: Option<i64>,
    /// WHERE 子句（不含 WHERE 关键字），占位符同 /api/data/rows
    pub r#where: Option<String>,
    pub params: Option<Vec<JsonValue>>,
}

impl ReportSource {
    fn to_query(&self) -> crate::db::DataQuery {
        crate::db::DataQuery {
            conn_id: self.conn_id.clone(),
            engine: self.engine.clone(),
            database: self.database.clone(),
            table: self.table.clone(),
            fields: self.fields.clone(),
            limit: self.limit.or(Some(crate::db::REPORT_MAX_ROWS)),
            r#where: self.r#where.clone(),
            params: self.params.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RenderResponse {
    pub sheets: Vec<RenderedSheet>,
    pub html: String,
}

/// 渲染报表：展开 + 求值 + 输出网格/HTML
///
/// `sources` 为空且模板未带 datasets 时，退化为纯内存渲染（样例/单测路径）。
pub fn render(req: RenderRequest) -> Result<RenderResponse, String> {
    let mut tpl = req.template;
    if let Some(ds) = req.datasets {
        tpl.datasets.extend(ds);
    }

    if tpl.sheets.is_empty() {
        return Err("模板中没有 sheet".to_string());
    }

    let mut sheets = Vec::new();
    for sheet in tpl.sheets.iter() {
        let ds = pick_dataset(&tpl.datasets, sheet);
        let mut engine = engine::Engine::new(ds);
        let rows = engine.expand_sheet(sheet);
        sheets.push(RenderedSheet { name: sheet.name.clone(), rows });
    }
    let html = to_html(&sheets);
    Ok(RenderResponse { sheets, html })
}

/// 带数据源的渲染：先按 sources 现查填入 datasets，再走同一套展开逻辑
pub async fn render_with_sources(
    state: &crate::AppState,
    req: RenderRequest,
) -> Result<RenderResponse, String> {
    let mut req = req;
    let sources = req.sources.clone().unwrap_or_default();
    if !sources.is_empty() {
        let mut datasets = req.datasets.clone().unwrap_or_default();
        for s in sources.iter() {
            let name = s.name.clone();
            if name.trim().is_empty() {
                return Err("数据源缺少 name".to_string());
            }
            let q = s.to_query();
            let rows = crate::db::query_rows(state, &q)
                .await
                .map_err(|e| format!("数据集「{name}」取数失败：{e}"))?;
            datasets.insert(name, rows);
        }
        req.datasets = Some(datasets);
    }
    render(req)
}

/// 选择该 sheet 使用的数据集：取单元格里声明的 ds，否则取第一个
fn pick_dataset(datasets: &BTreeMap<String, DataSet>, sheet: &SheetTpl) -> DataSet {
    for row in sheet.rows.iter() {
        for cell in row.cells.iter() {
            if let Some(m) = &cell.model {
                if let Some(name) = &m.ds {
                    if let Some(ds) = datasets.get(name) {
                        return ds.clone();
                    }
                }
            }
        }
    }
    datasets.values().next().cloned().unwrap_or_default()
}

fn to_html(sheets: &[RenderedSheet]) -> String {
    let mut out = String::new();
    for sheet in sheets {
        out.push_str(&format!("<h3>{}</h3>\n", escape(&sheet.name)));
        out.push_str("<table border=\"1\" cellspacing=\"0\" cellpadding=\"6\" style=\"border-collapse:collapse\">\n");
        let nrows = sheet.rows.len();
        let ncols = sheet.rows.iter().map(|r| r.len()).max().unwrap_or(0);
        // 被合并覆盖的格子必须从 HTML 里省略：rowspan/colspan 只写在起始格上，
        // 其余格子若照常输出 <td> 会让每一行的列数偏移（Univer/Excel 用 mergeData 表达，没有这个问题）
        let mut covered = vec![vec![false; ncols]; nrows];
        for (r, row) in sheet.rows.iter().enumerate() {
            out.push_str("  <tr>");
            for (c, cell) in row.iter().enumerate() {
                if covered[r][c] {
                    continue;
                }
                let rs = cell.rowspan.max(1);
                let cs = cell.colspan.max(1);
                for rr in r..(r + rs).min(nrows) {
                    for cc in c..(c + cs).min(ncols) {
                        if rr != r || cc != c {
                            covered[rr][cc] = true;
                        }
                    }
                }
                out.push_str(&format!(
                    "<td rowspan=\"{}\" colspan=\"{}\">{}</td>",
                    rs,
                    cs,
                    escape(&cell.text)
                ));
            }
            out.push_str("</tr>\n");
        }
        out.push_str("</table>\n");
    }
    out
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

// ------------------------------------------------------------------
// HTTP handlers
// ------------------------------------------------------------------

pub async fn render_handler(
    State(state): State<AppState>,
    Json(req): Json<RenderRequest>,
) -> Result<Json<RenderResponse>, (StatusCode, String)> {
    render_with_sources(&state, req)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// `POST /api/report/xlsx`：渲染并直接返回 xlsx 文件
pub async fn xlsx_handler(
    State(state): State<AppState>,
    Json(req): Json<RenderRequest>,
) -> Result<HttpResponse<axum::body::Body>, (StatusCode, String)> {
    let resp = render_with_sources(&state, req).await.map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let buf = xlsx::to_xlsx(&resp.sheets).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let filename = match resp.sheets.first() {
        Some(s) if !s.name.trim().is_empty() => format!("{}.xlsx", s.name),
        _ => "report.xlsx".to_string(),
    };
    HttpResponse::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header(
            CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename.replace('"', "")),
        )
        .body(axum::body::Body::from(buf))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// `GET /api/report/sample.xlsx`：内置样例导出，便于不开前端也能验证
pub async fn sample_xlsx_handler() -> Result<HttpResponse<axum::body::Body>, (StatusCode, String)> {
    let tpl = sample_template();
    let resp = render(RenderRequest { template: tpl, datasets: None, sources: None })
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let buf = xlsx::to_xlsx(&resp.sheets).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    HttpResponse::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header(CONTENT_DISPOSITION, "attachment; filename=\"sample-report.xlsx\"")
        .body(axum::body::Body::from(buf))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub async fn sample_handler() -> Result<Json<RenderResponse>, (StatusCode, String)> {
    let tpl = sample_template();
    render(RenderRequest { template: tpl, datasets: None, sources: None })
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

pub async fn sample_template_handler() -> Json<ReportTemplate> {
    Json(sample_template())
}

/// 交叉表样例模板（列向展开），前端设计器可据此初始化
pub async fn cross_tab_template_handler() -> Json<ReportTemplate> {
    Json(cross_tab_template())
}

/// 带行列合计的交叉表样例模板
pub async fn cross_tab_totals_template_handler() -> Json<ReportTemplate> {
    Json(cross_tab_totals_template())
}

/// 双指标（金额 / 数量）+ 合计的交叉表样例模板
pub async fn cross_tab_two_metrics_totals_handler() -> Json<ReportTemplate> {
    Json(cross_tab_two_metrics_totals_template())
}

/// 双指标交叉表样例模板（不含合计）
pub async fn cross_tab_two_metrics_handler() -> Json<ReportTemplate> {
    Json(cross_tab_two_metrics_template())
}

/// 多级列表头（年 × 月）交叉表样例模板
pub async fn cross_tab_multi_level_handler() -> Json<ReportTemplate> {
    Json(cross_tab_multi_level_template())
}

// ------------------------------------------------------------------
// 内置样例：销售分组汇总（与 NopReport Java 版同一份数据，结果可对照）
// ------------------------------------------------------------------

pub fn sample_data() -> DataSet {
    let rows = vec![
        ("华东", "上海", "张三", 12000.0),
        ("华东", "上海", "李四", 8600.0),
        ("华东", "杭州", "王五", 9900.0),
        ("华东", "南京", "赵六", 7400.0),
        ("华南", "广州", "孙七", 15300.0),
        ("华南", "广州", "周八", 6200.0),
        ("华南", "深圳", "吴九", 18700.0),
        ("华北", "北京", "郑十", 21400.0),
        ("华北", "北京", "冯一", 9800.0),
        ("华北", "天津", "陈二", 7100.0),
    ];
    rows.into_iter()
        .map(|(region, city, salesman, amount)| {
            let mut m = DataRow::new();
            m.insert("region".into(), JsonValue::from(region));
            m.insert("city".into(), JsonValue::from(city));
            m.insert("salesman".into(), JsonValue::from(salesman));
            m.insert("amount".into(), JsonValue::from(amount));
            m
        })
        .collect()
}

/// 三级分组（地区/城市/销售员）+ 城市小计 + 地区合计 + 总计
pub fn sample_template() -> ReportTemplate {
    let mut datasets = BTreeMap::new();
    datasets.insert("ds1".to_string(), sample_data());

    let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
        pos: None,
        value: value.map(|v| JsonValue::from(v)),
        model,
        merge_across: 0,
        merge_down: 0,
        merge_to_end: false,
    };
    let m = |ds: &str, field: Option<&str>, expand: bool, row_parent: Option<&str>, value_expr: Option<&str>| {
        Some(CellModel {
            ds: Some(ds.to_string()),
            field: field.map(|s| s.to_string()),
            agg: None,
            expand_type: if expand { Some(ExpandType::R) } else { None },
            row_parent: row_parent.map(|s| s.to_string()),
            col_parent: None,
            col_after: None,
            value_expr: value_expr.map(|s| s.to_string()),
            expand_expr: None,
            format: None,
        })
    };

    let sheet = SheetTpl {
        name: "销售分组汇总".to_string(),
        rows: vec![
            // 行 1：标题
            RowTpl { cells: vec![CellTpl { pos: None, value: Some(JsonValue::from("2026 年销售分组汇总表")), model: None, merge_across: 0, merge_down: 0, merge_to_end: true }] },
            // 行 2：表头
            RowTpl {
                cells: vec![
                    cell(Some("地区"), None),
                    cell(Some("城市"), None),
                    cell(Some("销售员"), None),
                    cell(Some("销售金额(元)"), None),
                ],
            },
            // 行 3：三级主格 + 金额
            RowTpl {
                cells: vec![
                    cell(None, m("ds1", Some("region"), true, None, None)),
                    cell(None, m("ds1", Some("city"), true, Some("A3"), None)),
                    cell(None, m("ds1", Some("salesman"), true, Some("B3"), None)),
                    cell(None, m("ds1", Some("amount"), false, Some("C3"), None)),
                ],
            },
            // 行 4：城市小计（挂在 B3 之下）
            RowTpl {
                cells: vec![
                    cell(None, None),
                    cell(Some("城市小计"), m("ds1", None, false, Some("B3"), None)),
                    cell(None, None),
                    cell(None, m("ds1", None, false, Some("B3"), Some("D3[B3:+0].sum()"))),
                ],
            },
            // 行 5：地区合计（挂在 A3 之下）
            RowTpl {
                cells: vec![
                    cell(None, m("ds1", None, false, Some("A3"), None)),
                    cell(Some("地区合计"), m("ds1", None, false, Some("A3"), None)),
                    cell(None, None),
                    cell(None, m("ds1", None, false, Some("A3"), Some("D3[A3:+0].sum()"))),
                ],
            },
            // 行 6：总计
            RowTpl {
                cells: vec![
                    cell(None, None),
                    cell(Some("总计"), None),
                    cell(None, None),
                    cell(None, m("ds1", None, false, None, Some("D3.sum()"))),
                ],
            },
        ],
    };

    ReportTemplate { sheets: vec![sheet], datasets }
}

/// 交叉表样例：地区（行展开）× 月份（列展开）
pub fn cross_tab_template() -> ReportTemplate {
    let mut datasets = BTreeMap::new();
    datasets.insert("ds1".to_string(), cross_tab_data());

    let m = |field: Option<&str>, expand: Option<ExpandType>, row_parent: Option<&str>, col_parent: Option<&str>| {
        Some(CellModel {
            ds: Some("ds1".to_string()),
            field: field.map(|s| s.to_string()),
            agg: None,
            expand_type: expand,
            row_parent: row_parent.map(|s| s.to_string()),
            col_parent: col_parent.map(|s| s.to_string()),
            col_after: None,
            value_expr: None,
            expand_expr: None,
            format: None,
        })
    };
    let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
        pos: None,
        value: value.map(|v| JsonValue::from(v)),
        model,
        merge_across: 0,
        merge_down: 0,
        merge_to_end: false,
    };

    let sheet = SheetTpl {
        name: "交叉表".to_string(),
        rows: vec![
            RowTpl { cells: vec![cell(Some("地区 / 月份 销售交叉表"), None)] },
            RowTpl {
                cells: vec![
                    cell(Some("地区"), None),
                    cell(None, m(Some("month"), Some(ExpandType::C), None, None)),
                ],
            },
            RowTpl {
                cells: vec![
                    cell(None, m(Some("region"), Some(ExpandType::R), None, None)),
                    cell(None, m(Some("amount"), None, Some("A3"), Some("B2"))),
                ],
            },
        ],
    };
    ReportTemplate { sheets: vec![sheet], datasets }
}

/// 每个月份下并排两个数值列：金额、数量
pub fn cross_tab_two_metrics_template() -> ReportTemplate {
    let mut datasets = BTreeMap::new();
    datasets.insert("ds1".to_string(), cross_tab_data());

    let m = |field: Option<&str>, expand: Option<ExpandType>, row_parent: Option<&str>, col_parent: Option<&str>| {
        Some(CellModel {
            ds: Some("ds1".to_string()),
            field: field.map(|s| s.to_string()),
            agg: None,
            expand_type: expand,
            row_parent: row_parent.map(|s| s.to_string()),
            col_parent: col_parent.map(|s| s.to_string()),
            col_after: None,
            value_expr: None,
            expand_expr: None,
            format: None,
        })
    };
    let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
        pos: None,
        value: value.map(|v| JsonValue::from(v)),
        model,
        merge_across: 0,
        merge_down: 0,
        merge_to_end: false,
    };

    let sheet = SheetTpl {
        name: "双指标交叉表".to_string(),
        rows: vec![
            RowTpl { cells: vec![cell(Some("双指标交叉表"), None)] },
            RowTpl {
                cells: vec![
                    cell(Some("地区"), None),
                    cell(None, m(Some("month"), Some(ExpandType::C), None, None)),
                ],
            },
            RowTpl {
                cells: vec![
                    cell(None, m(Some("region"), Some(ExpandType::R), None, None)),
                    cell(None, m(Some("amount"), None, Some("A3"), Some("B2"))),
                    cell(None, m(Some("qty"), None, Some("A3"), Some("B2"))),
                ],
            },
        ],
    };
    ReportTemplate { sheets: vec![sheet], datasets }
}

// ------------------------------------------------------------------
// 交叉表 + 行列合计
//
// 布局要点（以 单值字段 为例）：
//   row1  A2 地区  | B2 月份(列展开) | C2 行合计(col_after=B2)
//   row2  A3 地区(行展开) | B3 金额(row_parent=A3, col_parent=B2) | C3 行合计(row_parent=A3, col_after=B2)
//   row3  A4 合计  | B4 列合计(col_parent=B2) | C4 总计(col_after=B2)
//
// - `col_after`：列号不能写死（月数列数随数据变化），由引擎在列布局第二遍推算
// - 横向层次坐标 `B3[B2:+0]`：锚点沿 col_parent 链查找，取该月份下的全部地区值
// ------------------------------------------------------------------

/// 单值字段：地区 × 月份，右侧行合计 + 底部列合计 + 右下角总计
pub fn cross_tab_totals_template() -> ReportTemplate {
    let mut datasets = BTreeMap::new();
    datasets.insert("ds1".to_string(), cross_tab_data());

    let m = |field: Option<&str>,
             expand: Option<ExpandType>,
             row_parent: Option<&str>,
             col_parent: Option<&str>,
             col_after: Option<&str>,
             value_expr: Option<&str>| {
        Some(CellModel {
            ds: Some("ds1".to_string()),
            field: field.map(|s| s.to_string()),
            agg: None,
            expand_type: expand,
            row_parent: row_parent.map(|s| s.to_string()),
            col_parent: col_parent.map(|s| s.to_string()),
            col_after: col_after.map(|s| s.to_string()),
            value_expr: value_expr.map(|s| s.to_string()),
            expand_expr: None,
            format: None,
        })
    };
    let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
        pos: None,
        value: value.map(|v| JsonValue::from(v)),
        model,
        merge_across: 0,
        merge_down: 0,
        merge_to_end: false,
    };

    let sheet = SheetTpl {
        name: "交叉表(含合计)".to_string(),
        rows: vec![
            RowTpl {
                cells: vec![CellTpl {
                    pos: None,
                    value: Some(JsonValue::from("地区 / 月份 销售交叉表")),
                    model: None,
                    merge_across: 0,
                    merge_down: 0,
                    merge_to_end: true,
                }],
            },
            RowTpl {
                cells: vec![
                    cell(Some("地区"), None),
                    cell(None, m(Some("month"), Some(ExpandType::C), None, None, None, None)),
                    cell(Some("行合计"), m(None, None, None, None, Some("B2"), None)),
                ],
            },
            RowTpl {
                cells: vec![
                    cell(None, m(Some("region"), Some(ExpandType::R), None, None, None, None)),
                    cell(None, m(Some("amount"), None, Some("A3"), Some("B2"), None, None)),
                    cell(None, m(None, None, Some("A3"), None, Some("B2"), Some("B3[A3:+0].sum()"))),
                ],
            },
            RowTpl {
                cells: vec![
                    cell(Some("合计"), None),
                    cell(None, m(None, None, None, Some("B2"), None, Some("B3[B2:+0].sum()"))),
                    cell(None, m(None, None, None, None, Some("B2"), Some("B3.sum()"))),
                ],
            },
        ],
    };

    ReportTemplate { sheets: vec![sheet], datasets }
}

/// 双值字段（金额 / 数量）：每个月份下并排两列，合计同样成对出现
pub fn cross_tab_two_metrics_totals_template() -> ReportTemplate {
    let mut datasets = BTreeMap::new();
    datasets.insert("ds1".to_string(), cross_tab_data());

    let m = |field: Option<&str>,
             expand: Option<ExpandType>,
             row_parent: Option<&str>,
             col_parent: Option<&str>,
             col_after: Option<&str>,
             value_expr: Option<&str>| {
        Some(CellModel {
            ds: Some("ds1".to_string()),
            field: field.map(|s| s.to_string()),
            agg: None,
            expand_type: expand,
            row_parent: row_parent.map(|s| s.to_string()),
            col_parent: col_parent.map(|s| s.to_string()),
            col_after: col_after.map(|s| s.to_string()),
            value_expr: value_expr.map(|s| s.to_string()),
            expand_expr: None,
            format: None,
        })
    };
    let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
        pos: None,
        value: value.map(|v| JsonValue::from(v)),
        model,
        merge_across: 0,
        merge_down: 0,
        merge_to_end: false,
    };

    let sheet = SheetTpl {
        name: "双指标交叉表(含合计)".to_string(),
        rows: vec![
            RowTpl {
                cells: vec![CellTpl {
                    pos: None,
                    value: Some(JsonValue::from("金额 / 数量 双指标交叉表")),
                    model: None,
                    merge_across: 0,
                    merge_down: 0,
                    merge_to_end: true,
                }],
            },
            // 表头：月份(列展开) + 金额合计 / 数量合计（col_after 链式跟在月份之后）
            RowTpl {
                cells: vec![
                    cell(Some("地区"), None),
                    cell(None, m(Some("month"), Some(ExpandType::C), None, None, None, None)),
                    cell(Some("金额合计"), m(None, None, None, None, Some("B2"), None)),
                    cell(Some("数量合计"), m(None, None, None, None, Some("C2"), None)),
                ],
            },
            // 明细：金额 / 数量 + 行合计
            RowTpl {
                cells: vec![
                    cell(None, m(Some("region"), Some(ExpandType::R), None, None, None, None)),
                    cell(None, m(Some("amount"), None, Some("A3"), Some("B2"), None, None)),
                    cell(None, m(Some("qty"), None, Some("A3"), Some("B2"), None, None)),
                    cell(None, m(None, None, Some("A3"), None, Some("B2"), Some("B3[A3:+0].sum()"))),
                    cell(None, m(None, None, Some("A3"), None, Some("D3"), Some("C3[A3:+0].sum()"))),
                ],
            },
            // 列合计 + 总计
            RowTpl {
                cells: vec![
                    cell(Some("合计"), None),
                    cell(None, m(None, None, None, Some("B2"), None, Some("B3[B2:+0].sum()"))),
                    cell(None, m(None, None, None, Some("B2"), None, Some("C3[B2:+0].sum()"))),
                    cell(None, m(None, None, None, None, Some("B2"), Some("B3.sum()"))),
                    cell(None, m(None, None, None, None, Some("D3"), Some("C3.sum()"))),
                ],
            },
        ],
    };

    ReportTemplate { sheets: vec![sheet], datasets }
}

/// 多级列表头（年 × 月）+ 行/列合计：
///
/// ```text
/// r1  A2 地区(rowspan=2) | B2 年(列展开) | D2 金额合计(rowspan=2)
/// r2                     | C3 月(列展开, col_parent=B2)
/// r3  A4 地区(行展开)     | C4 金额(agg=sum) | D4 行合计
/// r4  A5 合计            | C5 列合计        | D5 总计
/// ```
///
/// 两个新增的合并原语：
/// - `merge_down`：表头格纵向跨过所有列头行（否则表头块出现半空行）
/// - `merge_to_end`：标题横向铺到行尾（列数随数据变化，无法写死合并宽度）
pub fn cross_tab_multi_level_template() -> ReportTemplate {
    let mut datasets = BTreeMap::new();
    datasets.insert("ds1".to_string(), multi_level_data());

    let m = |field: Option<&str>,
             expand: Option<ExpandType>,
             agg: Option<AggType>,
             row_parent: Option<&str>,
             col_parent: Option<&str>,
             col_after: Option<&str>,
             value_expr: Option<&str>| {
        Some(CellModel {
            ds: Some("ds1".to_string()),
            field: field.map(|s| s.to_string()),
            agg,
            expand_type: expand,
            row_parent: row_parent.map(|s| s.to_string()),
            col_parent: col_parent.map(|s| s.to_string()),
            col_after: col_after.map(|s| s.to_string()),
            value_expr: value_expr.map(|s| s.to_string()),
            expand_expr: None,
            format: None,
        })
    };
    let cell = |value: Option<&str>,
                model: Option<CellModel>,
                merge_down: usize,
                merge_to_end: bool| CellTpl {
        pos: None,
        value: value.map(|v| JsonValue::from(v)),
        model,
        merge_across: 0,
        merge_down,
        merge_to_end,
    };

    let sheet = SheetTpl {
        name: "多级列头交叉表".to_string(),
        rows: vec![
            // 标题：横向铺到行尾
            RowTpl { cells: vec![cell(Some("年 × 月 销售交叉表"), None, 0, true)] },
            // 第 1 行列头：行字段表头（纵向合并 2 行）+ 年（列展开）+ 金额合计（纵向合并 2 行）
            RowTpl {
                cells: vec![
                    cell(Some("地区"), None, 1, false),
                    cell(
                        None,
                        m(Some("year"), Some(ExpandType::C), None, None, None, None, None),
                        0,
                        false,
                    ),
                    cell(None, None, 0, false),
                    cell(Some("金额合计"), m(None, None, None, None, None, Some("C3"), None), 1, false),
                ],
            },
            // 第 2 行列头：月（列展开，挂 B2）
            RowTpl {
                cells: vec![
                    cell(None, None, 0, false),
                    cell(None, None, 0, false),
                    cell(
                        None,
                        m(Some("month"), Some(ExpandType::C), None, None, Some("B2"), None, None),
                        0,
                        false,
                    ),
                ],
            },
            // 明细：地区行展开 + 金额聚合 + 行合计
            RowTpl {
                cells: vec![
                    cell(
                        None,
                        m(Some("region"), Some(ExpandType::R), None, None, None, None, None),
                        0,
                        false,
                    ),
                    cell(None, None, 0, false),
                    cell(
                        None,
                        m(Some("amount"), None, Some(AggType::Sum), Some("A4"), Some("C3"), None, None),
                        0,
                        false,
                    ),
                    cell(
                        None,
                        m(None, None, None, Some("A4"), None, Some("C3"), Some("C4[A4:+0].sum()")),
                        0,
                        false,
                    ),
                ],
            },
            // 列合计 + 总计
            RowTpl {
                cells: vec![
                    cell(Some("合计"), None, 0, false),
                    cell(None, None, 0, false),
                    cell(
                        None,
                        m(None, None, None, None, Some("C3"), None, Some("C4[C3:+0].sum()")),
                        0,
                        false,
                    ),
                    cell(None, m(None, None, None, None, None, Some("C3"), Some("C4.sum()")), 0, false),
                ],
            },
        ],
    };
    ReportTemplate { sheets: vec![sheet], datasets }
}

fn multi_level_data() -> DataSet {
    let rows = vec![
        ("华东", "2024", "1月", 100.0),
        ("华东", "2024", "2月", 200.0),
        ("华东", "2025", "1月", 300.0),
        ("华南", "2024", "1月", 150.0),
        ("华南", "2025", "2月", 250.0),
    ];
    rows.into_iter()
        .map(|(region, year, month, amount)| {
            let mut m = DataRow::new();
            m.insert("region".into(), JsonValue::from(region));
            m.insert("year".into(), JsonValue::from(year));
            m.insert("month".into(), JsonValue::from(month));
            m.insert("amount".into(), JsonValue::from(amount));
            m
        })
        .collect()
}

fn cross_tab_data() -> DataSet {
    let rows = vec![
        ("华东", "1月", 100.0, 10.0),
        ("华东", "2月", 200.0, 20.0),
        ("华南", "1月", 150.0, 15.0),
        ("华南", "2月", 250.0, 25.0),
    ];
    rows.into_iter()
        .map(|(region, month, amount, qty)| {
            let mut m = DataRow::new();
            m.insert("region".into(), JsonValue::from(region));
            m.insert("month".into(), JsonValue::from(month));
            m.insert("amount".into(), JsonValue::from(amount));
            m.insert("qty".into(), JsonValue::from(qty));
            m
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> Vec<Vec<GridCell>> {
        let resp = render(RenderRequest { template: sample_template(), datasets: None, sources: None }).unwrap();
        resp.sheets.into_iter().next().unwrap().rows
    }

    /// 把网格按物理行输出成文本，便于断言
    fn lines(rows: &[Vec<GridCell>]) -> Vec<String> {
        rows.iter().map(|r| r.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join(" | ")).collect()
    }

    /// 只含一个数值格的模板（隔离验证数值格式，不受分组/交叉表干扰）
    fn one_number_template(value: f64, fmt: Option<NumFmt>) -> ReportTemplate {
        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                rows: vec![RowTpl {
                    cells: vec![CellTpl {
                        pos: None,
                        value: Some(serde_json::json!(value)),
                        model: Some(CellModel { format: fmt, ..Default::default() }),
                        merge_across: 0,
                        merge_down: 0,
                        merge_to_end: false,
                    }],
                }],
            }],
            datasets: BTreeMap::new(),
        }
    }

    fn render_one(value: f64, fmt: Option<NumFmt>) -> GridCell {
        let resp = render(RenderRequest {
            template: one_number_template(value, fmt),
            datasets: None,
            sources: None,
        })
        .unwrap();
        resp.sheets.into_iter().next().unwrap().rows[0][0].clone()
    }

    fn fmt_of(kind: &str, digits: Option<usize>, thousands: Option<bool>, code: Option<&str>) -> NumFmt {
        NumFmt {
            kind: kind.to_string(),
            digits,
            thousands,
            code: code.map(|s| s.to_string()),
        }
    }

    /// 数值列格式：文本渲染按 kind/digits/thousands/code 生效
    #[test]
    fn num_format_renders_expected_text() {
        // 未配置 → 全局兜底口径（整数千分位 / 非整数两位小数且无千分位）
        assert_eq!(render_one(1234567.0, None).text, "1,234,567");
        assert_eq!(render_one(1234.5, None).text, "1234.50");

        // 金额：货币符号 + 千分位 + 两位小数
        assert_eq!(
            render_one(1234567.891, Some(fmt_of("currency", None, None, Some("CNY")))).text,
            "¥1,234,567.89"
        );
        assert_eq!(
            render_one(1234.5, Some(fmt_of("currency", None, None, Some("USD")))).text,
            "$1,234.50"
        );
        // 小数：3 位、关千分位
        assert_eq!(
            render_one(1234567.891, Some(fmt_of("decimal", Some(3), Some(false), None))).text,
            "1234567.891"
        );
        // 整数：四舍五入 + 千分位
        assert_eq!(render_one(1234567.6, Some(fmt_of("int", None, None, None))).text, "1,234,568");
        // 百分比：0.1234 → 12.3%
        assert_eq!(render_one(0.1234, Some(fmt_of("percent", Some(1), None, None))).text, "12.3%");
        // 文本：不加千分位、不补零
        assert_eq!(render_one(1234567.0, Some(fmt_of("text", None, None, None))).text, "1234567");
    }

    /// 数值格仍保留原始数字与 Excel 数字格式串（xlsx 导出靠它显示正确位数）
    #[test]
    fn num_format_reaches_xlsx_fields() {
        let plain = render_one(1234.5, None);
        assert_eq!(plain.raw_number, Some(1234.5));
        assert!(plain.num_format.is_none());

        let money = render_one(1234.5, Some(fmt_of("currency", None, None, Some("CNY"))));
        assert_eq!(money.raw_number, Some(1234.5));
        assert_eq!(money.num_format.as_deref(), Some("\"¥\"#,##0.00"));

        // percent / text 的 Excel 格式串
        assert_eq!(
            render_one(0.25, Some(fmt_of("percent", Some(2), None, None))).num_format.as_deref(),
            Some("0.00%")
        );
        assert!(render_one(1.0, Some(fmt_of("text", None, None, None))).num_format.is_none());
    }

    /// 小计 / 合计格沿用数值列的格式（同列口径一致）
    #[test]
    fn num_format_applies_to_group_subtotals() {
        let mut tpl = sample_template();
        let fmt = fmt_of("currency", None, None, Some("CNY"));
        // 给所有带模型的格子挂上同一格式（字符串展开格不受影响，apply_format 只作用于数字）
        for sheet in tpl.sheets.iter_mut() {
            for row in sheet.rows.iter_mut() {
                for c in row.cells.iter_mut() {
                    if let Some(m) = c.model.as_mut() {
                        m.format = Some(fmt.clone());
                    }
                }
            }
        }
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None }).unwrap();
        let text = lines(&resp.sheets[0].rows);
        assert!(
            text.iter().any(|l| l.contains("城市小计") && l.contains("¥20,600.00")),
            "{text:#?}"
        );
        assert!(text.iter().any(|l| l.contains("¥116,400.00")), "{text:#?}");
    }

    #[test]
    fn sample_group_report_totals() {
        let rows = grid();
        let text = lines(&rows);

        // 分组层级正确：首个明细行应为 华东 | 上海 | 张三 | 12,000
        assert!(text.iter().any(|l| l.contains("华东") && l.contains("上海") && l.contains("12,000")), "{text:#?}");

        // 城市小计：上海 12000 + 8600 = 20600
        assert!(text.iter().any(|l| l.contains("城市小计") && l.contains("20,600")), "{text:#?}");
        // 地区合计：华东 20600 + 9900 + 7400 = 37900
        assert!(text.iter().any(|l| l.contains("地区合计") && l.contains("37,900")), "{text:#?}");
        // 总计 116400
        assert!(text.iter().any(|l| l.contains("总计") && l.contains("116,400")), "{text:#?}");
    }

    #[test]
    fn sample_group_report_row_count() {
        let rows = grid();
        // 1 标题 + 1 表头 + 10 明细 + 7 城市小计 + 3 地区合计 + 1 总计 = 23
        assert_eq!(rows.len(), 23, "{:#?}", lines(&rows));
    }

    #[test]
    fn sample_html_contains_table() {
        let resp = render(RenderRequest { template: sample_template(), datasets: None, sources: None }).unwrap();
        assert!(resp.html.contains("<table"));
        assert!(resp.html.contains("116,400"));
    }

    /// 列向展开（expand_type: c）：地区 × 月份 交叉表
    #[test]
    fn cross_tab_col_expand() {
        let rows = render(RenderRequest {
            template: cross_tab_template(),
            datasets: None,
            sources: None,
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows;
        let text = lines(&rows);
        assert_eq!(rows.len(), 4, "{text:#?}");
        assert_eq!(cells(&rows[1]), vec!["地区", "1月", "2月"], "{text:#?}");
        assert_eq!(cells(&rows[2]), vec!["华东", "100", "200"], "{text:#?}");
        assert_eq!(cells(&rows[3]), vec!["华南", "150", "250"], "{text:#?}");
    }

    /// 同一列主格下并排两个数值列（金额 / 数量）
    #[test]
    fn cross_tab_multi_metrics() {
        let rows = render(RenderRequest {
            template: cross_tab_two_metrics_template(),
            datasets: None,
            sources: None,
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows;
        let text = lines(&rows);
        // 表头「1月 / 2月」各跨 2 列（金额 + 数量），合并产生的空位不计
        assert_eq!(non_empty(&rows[1]), vec!["地区", "1月", "2月"], "{text:#?}");
        assert_eq!(
            cells(&rows[2]),
            vec!["华东", "100", "10", "200", "20"],
            "{text:#?}"
        );
        assert_eq!(
            cells(&rows[3]),
            vec!["华南", "150", "15", "250", "25"],
            "{text:#?}"
        );
    }

    /// 交叉表数值格必须聚合：同一 (行分组, 列分组) 交集里往往有多行数据
    #[test]
    fn cross_tab_value_aggregates_intersection() {
        let mut ds = DataSet::new();
        for (region, month, amount) in [
            ("华东", "1月", 100.0),
            ("华东", "1月", 50.0),
            ("华东", "2月", 200.0),
            ("华南", "1月", 150.0),
            ("华南", "2月", 250.0),
            ("华南", "2月", 100.0),
        ] {
            let mut m = DataRow::new();
            m.insert("region".into(), JsonValue::from(region));
            m.insert("month".into(), JsonValue::from(month));
            m.insert("amount".into(), JsonValue::from(amount));
            ds.push(m);
        }
        let cm = |field: Option<&str>,
                  expand: Option<ExpandType>,
                  agg: Option<AggType>,
                  row_parent: Option<&str>,
                  col_parent: Option<&str>,
                  col_after: Option<&str>,
                  value_expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg,
                expand_type: expand,
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: col_parent.map(|s| s.to_string()),
                col_after: col_after.map(|s| s.to_string()),
                value_expr: value_expr.map(|s| s.to_string()),
                expand_expr: None,
                format: None,
            })
        };
        let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
            pos: None,
            value: value.map(|v| JsonValue::from(v)),
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        let sheet = SheetTpl {
            name: "聚合交叉表".to_string(),
            rows: vec![
                RowTpl {
                    cells: vec![
                        cell(Some("地区"), None),
                        cell(None, cm(Some("month"), Some(ExpandType::C), None, None, None, None, None)),
                        cell(Some("行合计"), cm(None, None, None, None, None, Some("B1"), None)),
                    ],
                },
                RowTpl {
                    cells: vec![
                        cell(None, cm(Some("region"), Some(ExpandType::R), None, None, None, None, None)),
                        cell(None, cm(Some("amount"), None, Some(AggType::Sum), Some("A2"), Some("B1"), None, None)),
                        cell(None, cm(None, None, None, Some("A2"), None, Some("B1"), Some("B2[A2:+0].sum()"))),
                    ],
                },
                RowTpl {
                    cells: vec![
                        cell(Some("合计"), None),
                        cell(None, cm(None, None, None, None, Some("B1"), None, Some("B2[B1:+0].sum()"))),
                        cell(None, cm(None, None, None, None, None, Some("B1"), Some("B2.sum()"))),
                    ],
                },
            ],
        };
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), ds);
        let rows = render(RenderRequest {
            template: ReportTemplate { sheets: vec![sheet], datasets },
            datasets: None,
            sources: None,
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows;
        let text = lines(&rows);
        // 华东 1月 = 100+50 = 150；2月 = 200 → 行合计 350
        assert_eq!(cells(&rows[1]), vec!["华东", "150", "200", "350"], "{text:#?}");
        // 华南 1月 = 150；2月 = 250+100 = 350 → 行合计 500
        assert_eq!(cells(&rows[2]), vec!["华南", "150", "350", "500"], "{text:#?}");
        assert_eq!(cells(&rows[3]), vec!["合计", "300", "550", "850"], "{text:#?}");
    }

    fn cells(row: &[GridCell]) -> Vec<String> {
        row.iter().map(|c| c.text.clone()).collect()
    }

    /// 交叉表行列合计：行合计跟随最后一个月之后，列合计沿 col_parent 链汇总
    #[test]
    fn cross_tab_row_and_col_totals() {
        let rows = render(RenderRequest {
            template: cross_tab_totals_template(),
            datasets: None,
            sources: None,
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows;
        let text = lines(&rows);
        assert_eq!(rows.len(), 5, "{text:#?}");
        assert_eq!(cells(&rows[1]), vec!["地区", "1月", "2月", "行合计"], "{text:#?}");
        assert_eq!(cells(&rows[2]), vec!["华东", "100", "200", "300"], "{text:#?}");
        assert_eq!(cells(&rows[3]), vec!["华南", "150", "250", "400"], "{text:#?}");
        assert_eq!(cells(&rows[4]), vec!["合计", "250", "450", "700"], "{text:#?}");
    }

    /// 双指标交叉表：每个月份下金额/数量并排，合计同样成对
    #[test]
    fn cross_tab_two_metrics_with_totals() {
        let rows = render(RenderRequest {
            template: cross_tab_two_metrics_totals_template(),
            datasets: None,
            sources: None,
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows;
        let text = lines(&rows);
        assert_eq!(rows.len(), 5, "{text:#?}");
        assert_eq!(
            non_empty(&rows[1]),
            vec!["地区", "1月", "2月", "金额合计", "数量合计"],
            "{text:#?}"
        );
        assert_eq!(
            cells(&rows[2]),
            vec!["华东", "100", "10", "200", "20", "300", "30"],
            "{text:#?}"
        );
        assert_eq!(
            cells(&rows[3]),
            vec!["华南", "150", "15", "250", "25", "400", "40"],
            "{text:#?}"
        );
        assert_eq!(
            cells(&rows[4]),
            vec!["合计", "250", "25", "450", "45", "700", "70"],
            "{text:#?}"
        );
    }

    /// 跳过被合并覆盖的空位
    fn non_empty(row: &[GridCell]) -> Vec<String> {
        row.iter().filter(|c| !c.text.is_empty()).map(|c| c.text.clone()).collect()
    }

    /// 多级列表头：合并必须正确 —— 标题铺满整行、行字段表头与合计表头纵向跨过所有列头行
    #[test]
    fn cross_tab_multi_level_header_merges() {
        let rows = render(RenderRequest {
            template: cross_tab_multi_level_template(),
            datasets: None,
            sources: None,
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows;
        let text = lines(&rows);
        // 标题 + 2 行列头 + 2 明细 + 合计
        assert_eq!(rows.len(), 6, "{text:#?}");

        // 标题：横向铺到行尾（列数随数据变化，不能写死）
        assert_eq!(rows[0][0].text, "年 × 月 销售交叉表");
        assert_eq!(rows[0][0].colspan, 6, "标题应铺满整行 {text:#?}");

        // 行字段表头：纵向跨过两行列头
        assert_eq!(rows[1][0].text, "地区");
        assert_eq!(rows[1][0].rowspan, 2, "行字段表头应纵向合并 {text:#?}");

        // 年表头跨其下所有月份
        assert_eq!(rows[1][1].text, "2024");
        assert_eq!(rows[1][1].colspan, 2, "{text:#?}");
        assert_eq!(rows[1][3].text, "2025");
        assert_eq!(rows[1][3].colspan, 2, "{text:#?}");

        // 最深一层列头：月份
        assert_eq!(non_empty(&rows[2]), vec!["1月", "2月", "1月", "2月"], "{text:#?}");

        // 合计表头：同样纵向合并，且排在所有月份之后
        let tot = rows[1].iter().find(|c| c.text == "金额合计").expect("应有金额合计表头");
        assert_eq!(tot.rowspan, 2, "合计表头应纵向合并 {text:#?}");
        assert_eq!(rows[1].iter().rposition(|c| !c.text.is_empty()), Some(5), "{text:#?}");

        // 数值：行合计 / 列合计 / 总计
        assert_eq!(cells(&rows[3]), vec!["华东", "100", "200", "300", "", "600"], "{text:#?}");
        assert_eq!(cells(&rows[4]), vec!["华南", "150", "", "", "250", "400"], "{text:#?}");
        assert_eq!(cells(&rows[5]), vec!["合计", "250", "200", "300", "250", "1,000"], "{text:#?}");
    }

    /// HTML 表格必须是矩形：被合并覆盖的格子不能再输出 <td>，
    /// 否则每行的列数偏移（用「所有 td 的 rowspan×colspan 之和 == 行×列」这个不变量来卡）
    #[test]
    fn html_table_is_rectangular() {
        for tpl in [
            sample_template(),
            cross_tab_totals_template(),
            cross_tab_multi_level_template(),
        ] {
            let name = tpl.sheets[0].name.clone();
            let resp = render(RenderRequest { template: tpl, datasets: None, sources: None }).unwrap();
            let grid = &resp.sheets[0].rows;
            let nrows = grid.len();
            let ncols = grid.iter().map(|r| r.len()).max().unwrap_or(0);
            let area: usize = resp
                .html
                .split("<td")
                .skip(1)
                .map(|seg| {
                    let head = seg.split('>').next().unwrap_or("");
                    attr_usize(head, "rowspan") * attr_usize(head, "colspan")
                })
                .sum();
            assert_eq!(area, nrows * ncols, "「{name}」HTML 表格不矩形\n{}", resp.html);
        }
    }

    /// 从 `<td rowspan="2" colspan="3">` 这类片段里取属性值，缺省 1
    fn attr_usize(tag: &str, name: &str) -> usize {
        let key = format!("{name}=\"");
        match tag.find(&key) {
            Some(i) => {
                let rest = &tag[i + key.len()..];
                rest[..rest.find('"').unwrap_or(0)].parse().unwrap_or(1)
            }
            None => 1,
        }
    }
}
