//! 网格报表（类 Excel 非线性报表）服务端引擎
//!
//! 算法移植自 NopReport（Java）：主格树 -> 递归展开 -> 层次坐标求值。
//! 服务暴露在 print-server 的 18888 端口：
//! - `POST /api/report/render`  提交模板 + 数据集，返回展开后的网格与 HTML
//! - `GET  /api/report/sample`  内置「销售分组汇总」样例（可直接验证链路）
//! - `GET  /api/report/sample-template`  样例模板（前端设计器的初始内容）

pub mod engine;
pub mod expr;
pub mod model;
pub mod store;
pub mod xlsx;

use axum::extract::{Json, Path, State};
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
    /// 可选：输出展开中间结果（调试用，等价于 NopReport 的 `dump=true`）
    #[serde(default)]
    pub dump: Option<bool>,
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
    /// 展开中间结果（仅 `dump=true` 时返回）：`seq | pos | 文本 <- 层次坐标 | 行父 | 列父`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dump: Option<String>,
    /// 分页结果（仅模板配了 `page` 时返回）：每页一个 sheet，名字带 ` (i/n)`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<Vec<RenderedSheet>>,
    /// 逐页 HTML，与 `pages` 一一对应
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages_html: Option<Vec<String>>,
    /// 会静默产出错误数据的可疑情况（父格查不到、表达式解析失败等）。
    /// 不中断渲染，但调用方应当展示给用户。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
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

    let want_dump = req.dump.unwrap_or(false);
    let mut sheets = Vec::new();
    let mut dumps: Vec<String> = Vec::new();
    let mut all_pages: Vec<RenderedSheet> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for sheet in tpl.sheets.iter() {
        let ds = pick_dataset(&tpl.datasets, sheet);
        let mut engine = engine::Engine::new(ds);
        let rows = engine.expand_sheet(sheet);
        for w in engine.warnings() {
            warnings.push(format!("[{}] {}", sheet.name, w));
        }
        if want_dump {
            dumps.push(format!("=== sheet: {} ===\n{}", sheet.name, engine.dump_text()));
        }
        if let Some(cfg) = &sheet.page {
            let grids = paginate(&rows, cfg);
            let n = grids.len();
            // 公式是按**整表**的行列位置生成的，逐页复制后行号就对不上了——
            // 第 2 页的 SUM(C2:C5) 只会算到本页那几行，跟同一格显示的静态值不一致。
            // 半对不对的公式比静态值危险，多页时统一回落写值并告警。
            if n > 1 && grids.iter().any(|g| g.iter().any(|r| r.iter().any(|c| c.formula.is_some()))) {
                warnings.push(format!(
                    "[{}] 分页导出时公式坐标按整表生成、与逐页复制后的行号不一致，已回落写值",
                    sheet.name
                ));
            }
            for (i, grid) in grids.into_iter().enumerate() {
                let rows = if n > 1 {
                    grid.into_iter()
                        .map(|r| {
                            r.into_iter()
                                .map(|mut c| {
                                    c.formula = None;
                                    c
                                })
                                .collect()
                        })
                        .collect()
                } else {
                    grid
                };
                all_pages.push(RenderedSheet {
                    name: format!("{} ({}/{})", sheet.name, i + 1, n),
                    rows,
                });
            }
        }
        sheets.push(RenderedSheet { name: sheet.name.clone(), rows });
    }
    let html = to_html(&sheets);
    let dump = if want_dump { Some(dumps.join("\n")) } else { None };
    let pages_html = if all_pages.is_empty() {
        None
    } else {
        Some(all_pages.iter().map(|p| to_html(std::slice::from_ref(p))).collect())
    };
    let pages = if all_pages.is_empty() { None } else { Some(all_pages) };
    let warnings = if warnings.is_empty() { None } else { Some(warnings) };
    Ok(RenderResponse { sheets, html, dump, pages, pages_html, warnings })
}

/// 页面级分页：把展开后的网格按数据行数切页，表头/表尾每页重复
///
/// 只做「按固定行数切页」这一层，不引入润乾那套 9 类带区模型——
/// 后者需要给模板加带区类型，前后端模型都得改，等真遇到复杂表头需求再说。
///
/// - `repeat_header_rows`：表头行数，出现在每页顶部
/// - `repeat_footer_rows`：表尾行数，出现在每页底部
/// - 中间的部分按 `rows_per_page` 切分
pub fn paginate(rows: &[Vec<GridCell>], cfg: &PageConfig) -> Vec<Vec<Vec<GridCell>>> {
    let total = rows.len();
    if !cfg.is_effective(total) {
        return vec![rows.to_vec()];
    }
    let head_n = cfg.repeat_header_rows.min(total);
    let foot_n = cfg.repeat_footer_rows.min(total - head_n);
    let body = &rows[head_n..total - foot_n];
    if body.is_empty() {
        return vec![rows.to_vec()];
    }
    let head = &rows[..head_n];
    let foot = &rows[total - foot_n..];

    let mut pages = Vec::new();
    for chunk in body.chunks(cfg.rows_per_page) {
        let mut page = Vec::with_capacity(head_n + chunk.len() + foot_n);
        page.extend_from_slice(head);
        page.extend_from_slice(chunk);
        page.extend_from_slice(foot);
        pages.push(page);
    }
    pages
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
    // 模板配了分页时按页导出（每页一个 sheet），否则导出整表。
    // 文件名始终取未分页的 sheet 名，避免带上「 (1/3)」这类页码后缀。
    let sheets = resp.pages.as_ref().unwrap_or(&resp.sheets);
    let buf = xlsx::to_xlsx(sheets).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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

/* ---------------------------- 报表定义文件 ---------------------------- *
 * 存的不是「渲染结果」，是「报表本身」：模板 + 数据源声明 + 渲染选项。
 * 打开（run）时服务端才按 sources 现查、按 options 套到模板上再展开。
 *
 * 目录：配置文件同级的 reports/（见 store::reports_dir）。
 * -------------------------------------------------------------------- */

fn reports_dir_of(state: &AppState) -> std::path::PathBuf {
    store::reports_dir(state.config_path.as_ref())
}

/// `GET /api/reports` —— 报表列表（只回元信息）
pub async fn reports_list_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<store::ReportSummary>>, (StatusCode, String)> {
    let dir = reports_dir_of(&state);
    store::list(&dir)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// `GET /api/reports/:id` —— 读取完整定义
pub async fn reports_get_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<store::ReportDef>, (StatusCode, String)> {
    let dir = reports_dir_of(&state);
    store::load(&dir, &id)
        .map(Json)
        .map_err(|e| (StatusCode::NOT_FOUND, e))
}

/// `PUT /api/reports/:id` —— 保存（新建或覆盖）
pub async fn reports_save_handler(
    State(state): State<AppState>,
    Json(def): Json<store::ReportDef>,
) -> Result<Json<store::ReportDef>, (StatusCode, String)> {
    let dir = reports_dir_of(&state);
    store::save(&dir, def)
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// `DELETE /api/reports/:id`
pub async fn reports_delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let dir = reports_dir_of(&state);
    store::delete(&dir, &id)
        .map(|_| Json(serde_json::json!({ "ok": true })))
        .map_err(|e| (StatusCode::NOT_FOUND, e))
}

/**
 * `POST /api/reports/:id/run` —— **打开报表即执行**。
 *
 * 请求体可选：`{"params": {...}}` 按数据集名覆盖查询参数，
 * 这样「华东的报表」和「华南的报表」可以是同一个文件，只是打开时传参不同。
 * 例：`{"params": {"ds1": ["华东"]}}`
 */
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct RunRequest {
    /// 数据集名 → 参数数组（覆盖定义里的 params）
    pub params: Option<BTreeMap<String, Vec<JsonValue>>>,
    /// 覆盖定义里的 dump 开关
    pub dump: Option<bool>,
}

pub async fn reports_run_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<RunRequest>>,
) -> Result<Json<RenderResponse>, (StatusCode, String)> {
    let dir = reports_dir_of(&state);
    let def = store::load(&dir, &id).map_err(|e| (StatusCode::NOT_FOUND, e))?;
    run_def(&state, def, body.map(|b| b.0).unwrap_or_default())
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// `POST /api/reports/:id/xlsx` —— 执行并导出 xlsx
pub async fn reports_xlsx_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<RunRequest>>,
) -> Result<HttpResponse<axum::body::Body>, (StatusCode, String)> {
    let dir = reports_dir_of(&state);
    let def = store::load(&dir, &id).map_err(|e| (StatusCode::NOT_FOUND, e))?;
    let name = if def.name.trim().is_empty() { def.id.clone() } else { def.name.clone() };
    let resp = run_def(&state, def, body.map(|b| b.0).unwrap_or_default())
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let sheets = resp.pages.as_ref().unwrap_or(&resp.sheets);
    let buf = xlsx::to_xlsx(sheets).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    HttpResponse::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header(
            CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}.xlsx\"", name.replace('"', "")),
        )
        .body(axum::body::Body::from(buf))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// 执行一个报表定义：应用 options → 合并运行时参数 → 渲染
async fn run_def(
    state: &AppState,
    def: store::ReportDef,
    run: RunRequest,
) -> Result<RenderResponse, String> {
    let mut template = store::apply_options(def.template, &def.options);

    // 运行时参数覆盖。key 是数据集名，值直接替换该数据源的 params。
    let mut sources = def.sources;
    if let Some(overrides) = run.params {
        for s in sources.iter_mut() {
            if let Some(p) = overrides.get(&s.name) {
                s.params = Some(p.clone());
            }
        }
    }

    // 传了参数却没写 WHERE：底层的报错是 "Got 1, needed 0"，用户看不懂。
    // 在这里提前拦，说清楚该怎么修。
    for s in sources.iter() {
        let has_params = s.params.as_ref().map(|p| !p.is_empty()).unwrap_or(false);
        let has_where = s.r#where.as_deref().unwrap_or("").trim().is_empty() == false;
        if has_params && !has_where {
            return Err(format!(
                "数据源「{}」传了 {} 个参数，但定义里没写 WHERE 子句，参数无处可填。\
                 请在筛选条件里写占位符（如 region = ?）再传参。",
                s.name,
                s.params.as_ref().map(|p| p.len()).unwrap_or(0)
            ));
        }
    }

    let req = RenderRequest {
        template,
        datasets: None,
        dump: Some(run.dump.or(def.options.dump).unwrap_or(false)),
        sources: Some(sources),
    };
    render_with_sources(state, req).await
}

/// `GET /api/report/sample.xlsx`：内置样例导出，便于不开前端也能验证
pub async fn sample_xlsx_handler() -> Result<HttpResponse<axum::body::Body>, (StatusCode, String)> {
    let tpl = sample_template();
    let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None })
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
    render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None })
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
            expand_min_count: None,
            expand_max_count: None,
            keep_expand_empty: None,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: None,
        })
    };

    let sheet = SheetTpl {
        name: "销售分组汇总".to_string(),
        page: None,
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
            expand_min_count: None,
            expand_max_count: None,
            keep_expand_empty: None,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: None,
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
        page: None,
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
            expand_min_count: None,
            expand_max_count: None,
            keep_expand_empty: None,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: None,
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
        page: None,
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
            expand_min_count: None,
            expand_max_count: None,
            keep_expand_empty: None,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: None,
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
        page: None,
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
            expand_min_count: None,
            expand_max_count: None,
            keep_expand_empty: None,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: None,
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
        page: None,
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
            expand_min_count: None,
            expand_max_count: None,
            keep_expand_empty: None,
            format: None,
            format_expr: None,
            dict: None,
            row_test_expr: None,
            col_test_expr: None,
            export_formula: None,
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
        page: None,
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
        let resp = render(RenderRequest { template: sample_template(), datasets: None, sources: None, dump: None }).unwrap();
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
                page: None,
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
            dump: None,
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
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
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

    /// 前面的单元格引用后面的单元格（典型场景：占比列先要用上最后一行算出的总计）
    ///
    /// 旧实现按实例下标 0..n 单遍求值，被引用的格下标更大时会读到尚未求值的 Null，
    /// 不报错也不崩溃，只在特定模板下静默算错。改为 ensure_value 依赖传播后修复。
    #[test]
    fn value_expr_can_reference_a_later_cell() {
        let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
            pos: None,
            value: value.map(|v| JsonValue::from(v)),
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        let m = |field: Option<&str>, expand: bool, row_parent: Option<&str>, value_expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: None,
                col_after: None,
                value_expr: value_expr.map(|s| s.to_string()),
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), sample_data());

        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    // 行 1：表头
                    RowTpl {
                        cells: vec![
                            cell(Some("地区"), None),
                            cell(Some("城市"), None),
                            cell(Some("销售员"), None),
                            cell(Some("金额"), None),
                            cell(Some("总计参照"), None),
                        ],
                    },
                    // 行 2：三级主格展开；E2 **反向**引用行 3 的 B3（总计）
                    RowTpl {
                        cells: vec![
                            cell(None, m(Some("region"), true, None, None)),
                            cell(None, m(Some("city"), true, Some("A2"), None)),
                            cell(None, m(Some("salesman"), true, Some("B2"), None)),
                            cell(None, m(Some("amount"), false, Some("C2"), None)),
                            cell(None, m(None, false, Some("C2"), Some("B3"))),
                        ],
                    },
                    // 行 3：总计
                    RowTpl {
                        cells: vec![
                            cell(Some("总计"), None),
                            cell(None, m(None, false, None, Some("D2.sum()"))),
                        ],
                    },
                ],
            }],
            datasets,
        };

        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let text = lines(&resp.sheets[0].rows);

        // 总计 116400
        assert!(text.iter().any(|l| l.contains("总计") && l.contains("116,400")), "{text:#?}");
        // 10 条明细的「总计参照」列 + 总计行，共 11 处 116,400
        let refs = text.iter().filter(|l| l.contains("116,400")).count();
        assert_eq!(refs, 11, "每条明细的参照列都应拿到总计：{text:#?}");
    }

    /// 表达式成环时不得无限递归（保留 Null 而不是栈溢出）
    #[test]
    fn value_expr_cycle_terminates() {
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), sample_data());
        let m = |value_expr: &str| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: None,
                agg: None,
                expand_type: None,
                row_parent: None,
                col_parent: None,
                col_after: None,
                value_expr: Some(value_expr.to_string()),
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![RowTpl {
                    // A1 -> B1 -> A1，以及 C1 自引用
                    cells: vec![
                        CellTpl { pos: None, value: None, model: m("B1"), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m("A1"), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m("C1"), merge_across: 0, merge_down: 0, merge_to_end: false },
                    ],
                }],
            }],
            datasets,
        };

        // 能跑完不 panic / 不栈溢出即为通过；成环的格取值为空
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let text = lines(&resp.sheets[0].rows);
        assert_eq!(text.len(), 1);
        assert!(text[0].split('|').all(|c| c.trim().is_empty()), "{text:#?}");
    }

    /// 声明了 row_parent 但目标格尚未创建（指向后面的行）时，不得静默丢弃整格
    ///
    /// 旧实现 by_pos 查不到就返回空列表，外层 for 一次都不执行 -> 单元格凭空消失。
    #[test]
    fn declared_parent_not_yet_created_falls_back_to_root() {
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
        let m = |field: Option<&str>, expand: bool, row_parent: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: None,
                col_after: None,
                value_expr: None,
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    RowTpl { cells: vec![cell(Some("地区"), None), cell(Some("金额"), None)] },
                    RowTpl {
                        cells: vec![
                            cell(None, m(Some("region"), true, None)),
                            // row_parent 指向后面的行，此刻尚未创建
                            cell(None, m(Some("amount"), false, Some("A5"))),
                        ],
                    },
                ],
            }],
            datasets,
        };

        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let text = lines(&resp.sheets[0].rows);
        // 金额格不得凭空消失
        assert!(text.iter().any(|l| l.contains("12,000")), "{text:#?}");
    }

    /// 表达式引擎：四则运算 + IF + PROPORTION + ACCSUM（环比 / 占比 / 累计）
    ///
    /// 这组写法此前完全无法表达，是表达式层最大的缺口。
    #[test]
    fn expression_arithmetic_if_proportion_accsum() {
        let mk = |month: i64, amount: f64| {
            let mut r = DataRow::new();
            r.insert("month".into(), JsonValue::from(month));
            r.insert("amount".into(), JsonValue::from(amount));
            r
        };
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), vec![mk(1, 100.0), mk(2, 200.0), mk(3, 400.0)]);

        let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
            pos: None,
            value: value.map(|v| JsonValue::from(v)),
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        let m = |field: Option<&str>, expand: bool, value_expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: Some("A2".to_string()),
                col_parent: None,
                col_after: None,
                value_expr: value_expr.map(|s| s.to_string()),
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    RowTpl {
                        cells: vec![
                            cell(Some("月份"), None),
                            cell(Some("金额"), None),
                            cell(Some("环比"), None),
                            cell(Some("占比"), None),
                            cell(Some("累计"), None),
                        ],
                    },
                    RowTpl {
                        cells: vec![
                            cell(None, m(Some("month"), true, None)),
                            cell(None, m(Some("amount"), false, None)),
                            // 第 1 个月没有上月，给 '--'
                            cell(None, m(None, false, Some("IF(A2.expandIndex > 0, B2 / B2[A2:-1], '--')"))),
                            cell(None, m(None, false, Some("PROPORTION(B2)"))),
                            cell(None, m(None, false, Some("ACCSUM(B2)"))),
                        ],
                    },
                ],
            }],
            datasets,
        };

        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let text = lines(&resp.sheets[0].rows);
        // 金额 100/200/400，合计 700
        assert!(text.iter().any(|l| l == "1 | 100 | -- | 0.14 | 100"), "{text:#?}");
        assert!(text.iter().any(|l| l == "2 | 200 | 2 | 0.29 | 300"), "{text:#?}");
        assert!(text.iter().any(|l| l == "3 | 400 | 2 | 0.57 | 700"), "{text:#?}");
    }

    /// 未声明 row_parent 时，向左查找最近的纵向扩展格作为行父格（NopReport 缺省规则）
    #[test]
    fn default_row_parent_is_inferred_from_left() {
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
        let m = |field: Option<&str>, expand: bool| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: None,
                col_parent: None,
                col_after: None,
                value_expr: None,
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    RowTpl {
                        cells: vec![
                            cell(Some("地区"), None),
                            cell(Some("城市"), None),
                            cell(Some("金额"), None),
                        ],
                    },
                    // 三个格都不写 row_parent：B2 应自动挂在 A2 下，C2 自动挂在 B2 下
                    RowTpl {
                        cells: vec![
                            cell(None, m(Some("region"), true)),
                            cell(None, m(Some("city"), true)),
                            cell(None, m(Some("amount"), false)),
                        ],
                    },
                ],
            }],
            datasets,
        };

        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let text = lines(&resp.sheets[0].rows);

        // 1 表头 + 7 个城市（华东 3 / 华南 2 / 华北 2）
        assert_eq!(text.len(), 8, "{text:#?}");
        // 城市必须嵌在地区之下：杭州（王五 9900）应出现在华东分支里
        assert!(text.iter().any(|l| l.contains("杭州") && l.contains("9,900")), "{text:#?}");
        assert!(text.iter().any(|l| l.contains("南京") && l.contains("7,400")), "{text:#?}");
        // 首行同时带地区与城市，说明父子关系成立
        assert!(text.iter().any(|l| l.contains("华东") && l.contains("上海")), "{text:#?}");
    }

    /// 规则 1（跟随）：B2 不声明父格，向左扫到 A2——A2 **不是**扩展格但它显式挂了 A1，
    /// 于是 B2 跟到 A1，和 A2 一样按地区分组。
    ///
    /// 没有这条规则时扫描会「跨过」非扩展格继续找，本行左边没有扩展格 → B2 挂根，
    /// 出来的会是一个 116,400 的总计而不是三个地区小计。
    #[test]
    fn default_row_parent_follows_neighbour() {
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), sample_data());
        let cell = |model: Option<CellModel>| CellTpl {
            pos: None,
            value: None,
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        let m = |field: &str, expand: bool, row_parent: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: Some(field.to_string()),
                agg: Some(AggType::Sum),
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: None,
                col_after: None,
                value_expr: None,
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    // 第 1 行：A1 按地区展开
                    RowTpl {
                        cells: vec![cell(m("region", true, None))],
                    },
                    // 第 2 行：col0 留空，A2 显式挂 A1，B2 什么都不写。
                    // B2 往左只扫得到 A2（非扩展格、父格是 A1）——本行没有扩展格，
                    // 最左格也没有父格，所以**只有**「跟随」能救它；
                    // 少了这条规则 B2 就会挂根，吐一个总计出来。
                    RowTpl {
                        cells: vec![
                            cell(None),
                            cell(m("amount", false, Some("A1"))),
                            cell(m("amount", false, None)),
                        ],
                    },
                ],
            }],
            datasets,
        };

        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let text = lines(&resp.sheets[0].rows);

        assert_eq!(text.len(), 3, "{text:#?}");
        // 华东 37900 / 华南 40200 / 华北 38300
        assert!(text.iter().any(|l| l.contains("37,900")), "{text:#?}");
        assert!(text.iter().any(|l| l.contains("40,200")), "{text:#?}");
        assert!(text.iter().any(|l| l.contains("38,300")), "{text:#?}");
        // 关键：不能出现总计 116,400——那说明 B2 挂根了，没有跟随
        assert!(!text.iter().any(|l| l.contains("116,400")), "{text:#?}");
    }

    /// `dump=true` 时返回展开中间结果，便于排查扩展 / 求值问题
    #[test]
    fn dump_returns_expansion_trace() {
        let resp = render(RenderRequest {
            template: sample_template(),
            datasets: None,
            dump: Some(true),
            sources: None,
        })
        .unwrap();
        let dump = resp.dump.expect("dump=true 时应返回展开中间结果");
        // 表头
        assert!(dump.contains("seq | pos | text <- 层次坐标"), "{dump}");
        // 层次坐标形如 A3:0,B3:1,C3:0
        assert!(dump.contains("A3:0"), "{dump}");
        // 行父链：销售员格挂在城市格下
        assert!(dump.contains("行父:B3#"), "{dump}");
        // 实际值也应在里面
        assert!(dump.contains("12,000"), "{dump}");

        // 不开启时不返回，避免每次渲染都多传一大坨
        let plain = render(RenderRequest {
            template: sample_template(),
            datasets: None,
            dump: None,
            sources: None,
        })
        .unwrap();
        assert!(plain.dump.is_none());
    }

    /// 页面级分页：按数据行数切页，表头每页重复
    #[test]
    fn paginate_splits_rows_and_repeats_header() {
        let mut tpl = sample_template();
        tpl.sheets[0].page = Some(PageConfig {
            rows_per_page: 10,
            repeat_header_rows: 2, // 标题 + 表头
            repeat_footer_rows: 0,
        });
        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            dump: None,
            sources: None,
        })
        .unwrap();

        // 原表 23 行 = 1 标题 + 1 表头 + 21 数据；21 行按 10 切分 -> 3 页
        let pages = resp.pages.expect("配了 page 应返回分页结果");
        assert_eq!(pages.len(), 3, "{:#?}", pages.iter().map(|p| p.rows.len()).collect::<Vec<_>>());
        assert_eq!(pages[0].rows.len(), 2 + 10);
        assert_eq!(pages[1].rows.len(), 2 + 10);
        assert_eq!(pages[2].rows.len(), 2 + 1);

        // 每页都带标题和表头
        for p in &pages {
            let text = lines(&p.rows);
            assert!(text[0].contains("2026 年销售分组汇总表"), "{text:#?}");
            assert!(text[1].contains("地区"), "{text:#?}");
        }
        // 数据顺序不乱：首页有华东、末页有总计
        assert!(lines(&pages[0].rows).iter().any(|l| l.contains("华东")));
        assert!(lines(&pages[2].rows).iter().any(|l| l.contains("总计")));

        // 页名带序号
        assert!(pages[0].name.ends_with("(1/3)"), "{}", pages[0].name);
        assert!(pages[2].name.ends_with("(3/3)"), "{}", pages[2].name);

        // 逐页 HTML
        let ph = resp.pages_html.expect("分页时应返回逐页 HTML");
        assert_eq!(ph.len(), 3);
        assert!(ph.iter().all(|h| h.contains("<table")));

        // 未配 page 的模板不应产生分页字段
        let plain = render(RenderRequest {
            template: sample_template(),
            datasets: None,
            dump: None,
            sources: None,
        })
        .unwrap();
        assert!(plain.pages.is_none() && plain.pages_html.is_none());
    }

    /// 表尾也每页重复（如签字栏）
    #[test]
    fn paginate_repeats_footer_on_every_page() {
        let mut tpl = sample_template();
        tpl.sheets[0].page = Some(PageConfig {
            rows_per_page: 10,
            repeat_header_rows: 2,
            repeat_footer_rows: 1, // 总计行
        });
        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            dump: None,
            sources: None,
        })
        .unwrap();
        let pages = resp.pages.unwrap();
        // 23 行扣掉 2 行表头、1 行表尾后剩 20 行数据 -> 2 页
        assert_eq!(pages.len(), 2);
        for p in &pages {
            let text = lines(&p.rows);
            assert!(text.last().unwrap().contains("总计"), "{text:#?}");
        }
        // 行数：2 表头 + 10 数据 + 1 表尾
        assert_eq!(pages[0].rows.len(), 13);
        assert_eq!(pages[1].rows.len(), 13);
    }

    /// 表头 + 表尾吃掉整张表时不分页
    #[test]
    fn paginate_noop_when_header_footer_cover_all() {
        let rows: Vec<Vec<GridCell>> = (0..3)
            .map(|r| {
                vec![GridCell {
                    text: format!("r{r}"),
                    pos: format!("A{}", r + 1),
                    rowspan: 1,
                    colspan: 1,
                    raw_number: None,
                    num_format: None,
                    formula: None,
                }]
            })
            .collect();
        let pages = paginate(
            &rows,
            &PageConfig { rows_per_page: 1, repeat_header_rows: 2, repeat_footer_rows: 1 },
        );
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].len(), 3);
    }

    /// 展开控制属性：expand_max_count（只显示前 N 条）/ expand_min_count（补空行）
    #[test]
    fn expand_count_limits() {
        let mk = |field: Option<&str>, min: Option<usize>, max: Option<usize>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: Some(ExpandType::R),
                row_parent: None,
                col_parent: None,
                col_after: None,
                value_expr: None,
                expand_expr: None,
                expand_min_count: min,
                expand_max_count: max,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let build = |model: Option<CellModel>| {
            let mut datasets = BTreeMap::new();
            datasets.insert("ds1".to_string(), sample_data());
            ReportTemplate {
                sheets: vec![SheetTpl {
                    name: "t".into(),
                    page: None,
                    rows: vec![RowTpl {
                        cells: vec![CellTpl {
                            pos: None,
                            value: None,
                            model,
                            merge_across: 0,
                            merge_down: 0,
                            merge_to_end: false,
                        }],
                    }],
                }],
                datasets,
            }
        };
        let render_rows = |model: Option<CellModel>| {
            let resp = render(RenderRequest {
                template: build(model),
                datasets: None,
                dump: None,
                sources: None,
            })
            .unwrap();
            lines(&resp.sheets[0].rows)
        };

        // 数据里有 3 个地区
        assert_eq!(render_rows(mk(Some("region"), None, None)).len(), 3);
        // 只要前 2 个
        let text = render_rows(mk(Some("region"), None, Some(2)));
        assert_eq!(text.len(), 2, "{text:#?}");
        assert!(text.iter().any(|l| l.contains("华东")) && text.iter().any(|l| l.contains("华南")));
        assert!(!text.iter().any(|l| l.contains("华北")), "{text:#?}");
        // 补到 5 行
        let text = render_rows(mk(Some("region"), Some(5), None));
        assert_eq!(text.len(), 5, "{text:#?}");
    }

    /// 展开集为空时 keep_expand_empty 保留单元格（缺省会整格消失）
    #[test]
    fn keep_expand_empty_keeps_cell() {
        let mk = |keep: Option<bool>| {
            let mut datasets = BTreeMap::new();
            datasets.insert("ds1".to_string(), Vec::new()); // 空数据集
            ReportTemplate {
                sheets: vec![SheetTpl {
                    name: "t".into(),
                    page: None,
                    rows: vec![
                        RowTpl {
                            cells: vec![CellTpl {
                                pos: None,
                                value: Some(JsonValue::from("地区")),
                                model: None,
                                merge_across: 0,
                                merge_down: 0,
                                merge_to_end: false,
                            }],
                        },
                        RowTpl {
                            cells: vec![CellTpl {
                                pos: None,
                                value: None,
                                model: Some(CellModel {
                                    ds: Some("ds1".to_string()),
                                    field: Some("region".to_string()),
                                    agg: None,
                                    expand_type: Some(ExpandType::R),
                                    row_parent: None,
                                    col_parent: None,
                                    col_after: None,
                                    value_expr: None,
                                    expand_expr: None,
                                    expand_min_count: None,
                                    expand_max_count: None,
                                    keep_expand_empty: keep,
                                    format: None,
                                    format_expr: None,
                                    dict: None,
                                    row_test_expr: None,
                                    col_test_expr: None,
                                    export_formula: None,
                                }),
                                merge_across: 0,
                                merge_down: 0,
                                merge_to_end: false,
                            }],
                        },
                    ],
                }],
                datasets,
            }
        };
        let run = |keep: Option<bool>| {
            let resp = render(RenderRequest {
                template: mk(keep),
                datasets: None,
                dump: None,
                sources: None,
            })
            .unwrap();
            lines(&resp.sheets[0].rows)
        };

        // 缺省：展开集为空 -> 单元格被删除，只剩表头
        assert_eq!(run(None).len(), 1);
        // keep_expand_empty：保留一个空值格
        assert_eq!(run(Some(true)).len(), 2);
    }

    /// 函数集补齐：PRODUCT / COUNTA / RANK
    #[test]
    fn functions_product_counta_rank() {
        let mk = |month: i64, amount: f64| {
            let mut r = DataRow::new();
            r.insert("month".into(), JsonValue::from(month));
            r.insert("amount".into(), JsonValue::from(amount));
            r
        };
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), vec![mk(1, 100.0), mk(2, 200.0), mk(3, 400.0)]);

        let m = |field: Option<&str>, expand: bool, value_expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: Some("A1".to_string()),
                col_parent: None,
                col_after: None,
                value_expr: value_expr.map(|s| s.to_string()),
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![
                        CellTpl { pos: None, value: None, model: m(Some("month"), true, None), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(Some("amount"), false, None), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(None, false, Some("PRODUCT(B1)")), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(None, false, Some("COUNTA(B1)")), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(None, false, Some("RANK(B1)")), merge_across: 0, merge_down: 0, merge_to_end: false },
                    ],
                }],
            }],
            datasets,
        };
        let resp = render(RenderRequest { template: tpl, datasets: None, dump: None, sources: None }).unwrap();
        let text = lines(&resp.sheets[0].rows);

        // PRODUCT = 100*200*400 = 8,000,000；COUNTA = 3；RANK 按降序 1 起
        assert!(text.iter().any(|l| l.starts_with("1 | 100 | 8,000,000 | 3 | 3")), "{text:#?}");
        assert!(text.iter().any(|l| l.starts_with("2 | 200 | 8,000,000 | 3 | 2")), "{text:#?}");
        assert!(text.iter().any(|l| l.starts_with("3 | 400 | 8,000,000 | 3 | 1")), "{text:#?}");
    }

    /// 会静默产出错误数据的情况必须告警，不能只靠用户盯输出
    #[test]
    fn warnings_surface_silent_failures() {
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
        let cm = |field: Option<&str>, row_parent: Option<&str>, value_expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: None,
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: None,
                col_after: None,
                value_expr: value_expr.map(|s| s.to_string()),
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "告警用例".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![
                        // row_parent 指向后面的行：查不到，退回挂根 -> 展开结果静默变少
                        cell(None, cm(Some("region"), Some("A9"), None)),
                        // 表达式语法错误：解析失败，保留展开值 -> 用户只看到空单元格
                        cell(None, cm(None, None, Some("D3.sum(("))),
                    ],
                }],
            }],
            datasets,
        };
        let resp = render(RenderRequest { template: tpl, datasets: None, dump: None, sources: None }).unwrap();
        let warnings = resp.warnings.expect("存在可疑情况时应返回告警");
        assert!(
            warnings.iter().any(|w| w.contains("row_parent") && w.contains("A9")),
            "{warnings:#?}"
        );
        assert!(
            warnings.iter().any(|w| w.contains("value_expr") && w.contains("无法解析")),
            "{warnings:#?}"
        );
        // 告警带 sheet 名，便于定位
        assert!(warnings.iter().all(|w| w.starts_with("[告警用例]")), "{warnings:#?}");

        // 正常模板不应产生告警
        let ok = render(RenderRequest {
            template: sample_template(),
            datasets: None,
            dump: None,
            sources: None,
        })
        .unwrap();
        assert!(ok.warnings.is_none(), "{:#?}", ok.warnings);
    }

    #[test]
    fn sample_group_report_row_count() {
        let rows = grid();
        // 1 标题 + 1 表头 + 10 明细 + 7 城市小计 + 3 地区合计 + 1 总计 = 23
        assert_eq!(rows.len(), 23, "{:#?}", lines(&rows));
    }

    #[test]
    fn sample_html_contains_table() {
        let resp = render(RenderRequest { template: sample_template(), datasets: None, sources: None, dump: None }).unwrap();
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
            dump: None,
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
            dump: None,
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
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
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
            page: None,
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
            dump: None,
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
            dump: None,
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
            dump: None,
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
            dump: None,
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
            let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
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

    /// 单格模板，可指定 `format_expr` / `dict`，用于隔离验证「第三值阶段」
    fn display_template(
        value: f64,
        format_expr: Option<&str>,
        dict: Option<Vec<(&str, &str)>>,
    ) -> ReportTemplate {
        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![CellTpl {
                        pos: None,
                        value: Some(serde_json::json!(value)),
                        model: Some(CellModel {
                            format_expr: format_expr.map(|s| s.to_string()),
                            dict: dict.map(|ps| {
                                ps.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
                            }),
                            ..Default::default()
                        }),
                        merge_across: 0,
                        merge_down: 0,
                        merge_to_end: false,
                    }],
                }],
            }],
            datasets: BTreeMap::new(),
        }
    }

    /// 返回 (单元格, 告警)
    fn render_display(
        value: f64,
        fx: Option<&str>,
        dict: Option<Vec<(&str, &str)>>,
    ) -> (GridCell, Vec<String>) {
        let resp = render(RenderRequest {
            template: display_template(value, fx, dict),
            datasets: None,
            sources: None,
            dump: Some(true),
        })
        .unwrap();
        let cell = resp.sheets.into_iter().next().unwrap().rows[0][0].clone();
        (cell, resp.warnings.unwrap_or_default())
    }

    /// 字典翻译只改展示文本，不动 `value` / `raw_number`——导出后仍可计算
    #[test]
    fn dict_translates_display_text_only() {
        let dict = || Some(vec![("1", "是"), ("0", "否")]);

        let (cell, _) = render_display(1.0, None, dict());
        assert_eq!(cell.text, "是");
        assert_eq!(cell.raw_number, Some(1.0), "展示值不该改写导出用的原始数值");

        let (cell, _) = render_display(0.0, None, dict());
        assert_eq!(cell.text, "否");

        // 没命中 → 回落既有兜底口径（整数千分位）
        let (cell, _) = render_display(1.0, None, Some(vec![("9", "九")]));
        assert_eq!(cell.text, "1");
    }

    /// `format_expr` 里 `value` 指代本格的最终值
    #[test]
    fn format_expr_sees_own_value() {
        let fx = Some(r#"IF(value >= 1000, "大额", "小额")"#);
        assert_eq!(render_display(1500.0, fx, None).0.text, "大额");
        assert_eq!(render_display(20.0, fx, None).0.text, "小额");
    }

    /// 兜底顺序：formatExpr > dict > NumFmt
    #[test]
    fn format_expr_wins_over_dict_and_numfmt() {
        let (cell, _) = render_display(1.0, Some(r#""强制""#), Some(vec![("1", "是")]));
        assert_eq!(cell.text, "强制");

        // 只有 dict 时 dict 生效；都没有时走 NumFmt / 全局兜底
        let (cell, _) = render_display(1.0, None, Some(vec![("1", "是")]));
        assert_eq!(cell.text, "是");
        let (cell, _) = render_display(1234567.0, None, None);
        assert_eq!(cell.text, "1,234,567");
    }

    /// format_expr 写坏了要告警，并回落到 dict，而不是静默出空单元格
    #[test]
    fn bad_format_expr_warns_and_falls_back() {
        let (cell, warnings) = render_display(1.0, Some("value ++"), Some(vec![("1", "是")]));
        assert_eq!(cell.text, "是", "解析失败应回落 dict");
        assert!(
            warnings.iter().any(|w| w.contains("format_expr")),
            "应告警，实际: {warnings:?}"
        );
    }

    /// 两年 × 两月的明细：A1 年（展开）、B1 月（展开，父 A1）、C1 金额、D1 用条件表达式取值
    fn yoy_template(value_expr: &str, row_test_expr: Option<&str>) -> ReportTemplate {
        let mut datasets = BTreeMap::new();
        let rows = [
            ("2025", "1月", 100.0),
            ("2025", "2月", 200.0),
            ("2026", "1月", 150.0),
            ("2026", "2月", 260.0),
        ];
        datasets.insert(
            "ds1".to_string(),
            rows.into_iter()
                .map(|(y, m, a)| {
                    let mut r = DataRow::new();
                    r.insert("year".into(), JsonValue::from(y));
                    r.insert("month".into(), JsonValue::from(m));
                    r.insert("amount".into(), JsonValue::from(a));
                    r
                })
                .collect(),
        );

        let cm = |field: Option<&str>,
                  expand: bool,
                  row_parent: Option<&str>,
                  ve: Option<&str>,
                  rte: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: None,
                col_after: None,
                value_expr: ve.map(|s| s.to_string()),
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: rte.map(|s| s.to_string()),
                col_test_expr: None,
                export_formula: None,
            })
        };
        let c = |model| CellTpl {
            pos: None,
            value: None,
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };

        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "yoy".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![
                        c(cm(Some("year"), true, None, None, None)),
                        // 行测试挂在「决定这一行」的月格上：删它才删得掉整行
                        c(cm(Some("month"), true, Some("A1"), None, row_test_expr)),
                        c(cm(Some("amount"), false, Some("B1"), None, None)),
                        c(cm(None, false, Some("B1"), Some(value_expr), None)),
                    ],
                }],
            }],
            datasets,
        }
    }

    fn render_yoy(value_expr: &str, row_test_expr: Option<&str>) -> Vec<Vec<GridCell>> {
        render(RenderRequest {
            template: yoy_template(value_expr, row_test_expr),
            datasets: None,
            sources: None,
            dump: Some(true),
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows
    }

    /// 同比：`C1[A1:-1]` 取上一年的全部金额，再用「月相同」筛出同月那一格。
    /// 条件里裸 `B1` = **候选格**的月，`$B1` = **当前格**的月——这正是 `$` 运算符的用处。
    #[test]
    fn conditional_expr_picks_same_month_from_previous_year() {
        let rows = render_yoy("C1[A1:-1]{$B1 == B1}", None);
        let col = |i: usize| -> Vec<String> { rows.iter().map(|r| r[i].text.clone()).collect() };

        // A1 跨 2 行（rowspan），续行留空是合并语义，不是丢数据
        assert_eq!(col(0), vec!["2025", "", "2026", ""], "年列");
        assert_eq!(col(1), vec!["1月", "2月", "1月", "2月"], "月列");
        assert_eq!(col(2), vec!["100", "200", "150", "260"], "金额列");
        // 首年没有上一年 → 空；2026 年各月拿到 2025 年同月
        assert_eq!(col(3), vec!["", "", "100", "200"], "去年同期列");
    }

    /// 没有 `$` 时条件退化成「候选格自己跟自己比」，筛不掉任何东西——
    /// 这条反向用例守住 `$` 与裸格名的语义差别。
    #[test]
    fn without_dollar_the_condition_compares_candidate_to_itself() {
        // 裸 B1 == B1 两边都是候选格的月，恒真 → 取到上一年第一个月（1月的 100）
        let rows = render_yoy("C1[A1:-1]{B1 == B1}", None);
        let col_d: Vec<String> = rows.iter().map(|r| r[3].text.clone()).collect();
        assert_eq!(col_d, vec!["", "", "100", "100"], "恒真条件应取上一年首格");
    }

    /// rowTestExpr：返回假则**整行删除**（本格连同子树一起不占位）。
    /// 挂在「决定这一行」的月格上——挂在金额格上只会删掉那一格，行还在。
    #[test]
    fn row_test_expr_deletes_whole_row() {
        // 月金额 ≤ 120 的月份整行消失（2025-1月 是 100）
        let rows = render_yoy("C1", Some(r#"value != "1月""#));
        let col = |i: usize| -> Vec<String> { rows.iter().map(|r| r[i].text.clone()).collect() };

        assert_eq!(rows.len(), 2, "两个 1月 行都应消失");
        assert_eq!(col(1), vec!["2月", "2月"], "月列");
        assert_eq!(col(2), vec!["200", "260"], "金额列");
        // 整行删除意味着子树（金额格）也一起走，不是只留空行
        assert!(
            !rows.iter().any(|r| r.iter().any(|c| c.text == "1月")),
            "被删行的格子不该以任何形式残留"
        );
    }

    /// 被 row_test 删掉的行**也不能进合计**。
    ///
    /// 这里踩过一次：删除只在布局阶段生效（不落位），求值却发生在布局之前，
    /// 于是 `C1.sum()` 把藏起来的行也算了进去，出表结果是「明细 460、合计 710」。
    /// 现在 hidden 在求值阶段就生效，两边看到的是同一份数据。
    #[test]
    fn row_test_expr_excludes_dropped_rows_from_totals() {
        let rows = render_yoy("C1.sum()", Some(r#"value != "1月""#));
        let col = |i: usize| -> Vec<String> { rows.iter().map(|r| r[i].text.clone()).collect() };

        assert_eq!(rows.len(), 2, "两个 1月 行都应消失");
        assert_eq!(col(2), vec!["200", "260"], "金额列");
        // 全量是 100+200+150+260=710，扣掉两个 1月（100+150）应为 460
        assert_eq!(col(3), vec!["460", "460"], "合计不该含被删行");
    }

    /// 测试条件本身依赖聚合值时，求值要迭代到稳定（删掉的行不再喂回聚合）。
    #[test]
    fn row_test_based_on_aggregate_converges() {
        // 月金额 >= 200 才保留：1月(100/150) 删掉，2月(200/260) 留下
        let rows = render_yoy("C1[B1:+0].sum()", Some("C1[B1:+0] >= 200"));
        let col = |i: usize| -> Vec<String> { rows.iter().map(|r| r[i].text.clone()).collect() };
        assert_eq!(col(1), vec!["2月", "2月"], "只剩 2月");
        assert_eq!(col(3), vec!["200", "260"], "小计取到本行金额");
    }

    /// exportFormula：`value_expr` 落成 Excel 公式。
    /// 期望 `C1[A1:+0].sum()` 在 1月占两行时变成 `SUM(C1:C2)`，
    /// 这样导出后在 Excel 里改明细，小计 / 合计会跟着重算。
    #[test]
    fn export_formula_writes_excel_formula() {
        let mk_row = |m: &str, r: &str, a: i64| {
            let mut d = DataRow::new();
            d.insert("month".into(), JsonValue::from(m));
            d.insert("region".into(), JsonValue::from(r));
            d.insert("amount".into(), JsonValue::from(a));
            d
        };
        let mut datasets = BTreeMap::new();
        datasets.insert(
            "ds1".to_string(),
            vec![mk_row("1月", "华东", 100), mk_row("1月", "华北", 200), mk_row("2月", "华东", 300)],
        );

        let cm = |field: Option<&str>,
                  expand: bool,
                  parent: Option<&str>,
                  ve: Option<&str>,
                  ef: bool| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg: if field == Some("amount") { Some(AggType::Sum) } else { None },
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: parent.map(|s| s.to_string()),
                value_expr: ve.map(|s| s.to_string()),
                export_formula: if ef { Some(true) } else { None },
                ..Default::default()
            })
        };
        let c = |model| CellTpl { model, ..Default::default() };

        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    RowTpl {
                        cells: vec![
                            c(cm(Some("month"), true, None, None, false)),
                            c(cm(Some("region"), true, Some("A1"), None, false)),
                            c(cm(Some("amount"), false, Some("B1"), None, false)),
                            // 月小计：本月的金额格求和
                            c(cm(None, false, Some("B1"), Some("C1[A1:+0].sum()"), true)),
                        ],
                    },
                    RowTpl {
                        cells: vec![
                            CellTpl::default(),
                            CellTpl::default(),
                            c(cm(None, false, None, Some("C1.sum()"), true)),
                        ],
                    },
                ],
            }],
            datasets,
        };
        let rows = render(RenderRequest {
            template: tpl,
            datasets: None,
            dump: None,
            sources: None,
        })
        .unwrap()
        .sheets
        .into_iter()
        .next()
        .unwrap()
        .rows;

        // 行布局：1月(华东/华北) / 2月(华东) / 合计行
        assert_eq!(rows.len(), 4, "布局行数");
        let f = |r: usize, c: usize| rows[r][c].formula.clone();
        assert_eq!(f(0, 3), Some("SUM(C1:C2)".into()), "1月小计覆盖前两行");
        assert_eq!(f(1, 3), Some("SUM(C1:C2)".into()));
        assert_eq!(f(2, 3), Some("SUM(C3)".into()), "2月只有一行");
        assert_eq!(f(3, 2), Some("SUM(C1:C3)".into()), "总计覆盖全部数据行");
        // 没开 export_formula 的金额格不带公式
        assert_eq!(f(0, 2), None);
        assert_eq!(rows[3][2].text, "600", "静态值仍要正确（公式只是附加）");
    }

    /// 分页导出时公式坐标按整表生成、逐页复制后行号对不上 → 回落写值并告警。
    /// （第 2 页的 SUM(C2:C5) 只会算到本页几行，跟同一格显示的静态值不一致）
    #[test]
    fn paginated_export_drops_formulas() {
        let mut tpl = sample_template();
        tpl.sheets[0].page = Some(PageConfig {
            rows_per_page: 3,
            repeat_header_rows: 2,
            repeat_footer_rows: 0,
        });
        // 给带 value_expr 的格打开 export_formula
        for row in tpl.sheets[0].rows.iter_mut() {
            for cell in row.cells.iter_mut() {
                if let Some(m) = cell.model.as_mut() {
                    if m.value_expr.is_some() {
                        m.export_formula = Some(true);
                    }
                }
            }
        }
        let resp =
            render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let pages = resp.pages.as_ref().expect("应分页");
        assert!(pages.len() > 1, "需要多页才能触发该分支，实际 {} 页", pages.len());

        let any = |rows: &[Vec<GridCell>]| {
            rows.iter().any(|r| r.iter().any(|c| c.formula.is_some()))
        };
        assert!(!pages.iter().any(|p| any(&p.rows)), "分页结果不该带公式");
        // 未分页的 sheets 视图仍然保留公式
        assert!(any(&resp.sheets[0].rows), "未分页视图应保留公式");
        let w = resp.warnings.clone().unwrap_or_default();
        assert!(w.iter().any(|x| x.contains("分页")), "应告警，实际: {w:?}");
    }

    /// 翻不出来的表达式回落写值并告警——半对不对的公式比静态值危险
    #[test]
    fn export_formula_falls_back_to_value_with_warning() {
        // PROPORTION 没有 Excel 同名函数
        let mut tpl = yoy_template("PROPORTION(C1)", None);
        if let Some(cell) = tpl.sheets[0].rows[0].cells.get_mut(3) {
            if let Some(m) = cell.model.as_mut() {
                m.export_formula = Some(true);
            }
        }
        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            dump: None,
            sources: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default();
        assert!(w.iter().any(|x| x.contains("export_formula")), "应告警，实际: {w:?}");
        assert!(
            resp.sheets[0].rows.iter().all(|r| r.iter().all(|c| c.formula.is_none())),
            "翻不出来就不该带公式"
        );
    }

    /// 测试表达式写坏时按「保留」处理并告警——静默丢行是丢数据，比多留一行危险得多
    #[test]
    fn bad_row_test_expr_keeps_row_and_warns() {
        let tpl = yoy_template("C1", Some("C1 >>"));
        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            sources: None,
            dump: Some(true),
        })
        .unwrap();
        assert_eq!(resp.sheets[0].rows.len(), 4, "解析失败应保留全部行");
        let w = resp.warnings.clone().unwrap_or_default();
        assert!(w.iter().any(|x| x.contains("row_test_expr")), "应告警，实际: {w:?}");
    }

    /// 分页模板：返回 `pages`，且 xlsx 导出按页出 sheet。
    /// 覆盖 xlsx_handler 的取数分支（有 pages 用 pages，否则用 sheets）。
    #[test]
    fn paginated_template_exports_pages_as_sheets() {
        let mut tpl = sample_template();
        tpl.sheets[0].page = Some(PageConfig {
            rows_per_page: 3,
            repeat_header_rows: 2,
            repeat_footer_rows: 0,
        });
        let resp =
            render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();

        let pages = resp.pages.as_ref().expect("配了 page 就该返回 pages");
        assert!(pages.len() > 1, "样例表按 3 行/页切分应有多页，实际 {} 页", pages.len());

        // 每页都要带上重复表头，且不留空页
        for p in pages {
            assert!(p.rows.len() > 2, "每页应含表头 + 至少一行数据，实际 {} 行", p.rows.len());
        }

        // 与 xlsx_handler 一致的取数方式：有 pages 时按页导出
        let sheets = resp.pages.as_ref().unwrap_or(&resp.sheets);
        assert_eq!(sheets.len(), pages.len());
        assert!(crate::report::xlsx::to_xlsx(sheets).is_ok(), "分页结果应能导出 xlsx");

        // 未分页模板不返回 pages，导出仍走 sheets
        let plain = render(RenderRequest {
            template: sample_template(),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert!(plain.pages.is_none());
        let sheets = plain.pages.as_ref().unwrap_or(&plain.sheets);
        assert_eq!(sheets.len(), plain.sheets.len());
    }
}

