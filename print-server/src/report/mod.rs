//! 网格报表（类 Excel 非线性报表）服务端引擎
//!
//! 算法移植自 NopReport（Java）：主格树 -> 递归展开 -> 层次坐标求值。
//! 服务暴露在 print-server 的 18888 端口：
//! - `POST /api/report/render`  提交模板 + 数据集，返回展开后的网格与 HTML
//! - `GET  /api/report/sample`  内置「销售分组汇总」样例（可直接验证链路）
//! - `GET  /api/report/sample-template`  样例模板（前端设计器的初始内容）

pub mod engine;
pub mod expr;
pub mod import;
pub mod model;
pub mod store;
pub mod xlsx;

use axum::extract::{Json, Path, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{Response as HttpResponse, StatusCode};
use axum::response::IntoResponse;
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

/// `POST /api/report/import` 的请求体：xlsx 文件的 base64
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ImportRequest {
    /// xlsx 文件内容的 base64（与 `/print` 的 `pdf` 字段同一套约定）
    pub base64: String,
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
    for sheet in tpl.sheets.iter_mut() {
        let (sheet_datasets, primary, ds_warns) = prepare_dataset(&tpl.datasets, sheet);
        for w in ds_warns {
            warnings.push(format!("[{}] {}", sheet.name, w));
        }
        // 循环变量：一个取值一张表。suffix 为空表示没开循环，仍按单张表走。
        let groups = loop_groups(
            &sheet_datasets,
            &primary,
            sheet.loop_field.as_deref(),
            &sheet.name,
            &mut warnings,
        );
        for (suffix, sub_ds) in groups {
            let sheet_name = if suffix.is_empty() {
                sheet.name.clone()
            } else {
                format!("{} - {}", sheet.name, suffix)
            };
            let mut engine = engine::Engine::new_multi(sub_ds, primary.clone());
            let rows = engine.expand_sheet(sheet);
            for w in engine.warnings() {
                warnings.push(format!("[{}] {}", sheet_name, w));
            }
            if want_dump {
                dumps.push(format!("=== sheet: {} ===\n{}", sheet_name, engine.dump_text()));
            }
            if let Some(cfg) = &sheet.page {
                let grids = paginate(&rows, cfg);
                let n = grids.len();
                // 公式是按**整表**的行列位置生成的，逐页复制后行号就对不上了——
                // 第 2 页的 SUM(C2:C5) 只会算到本页那几行，跟同一格显示的静态值不一致。
                // 半对不对的公式比静态值危险，多页时统一回落写值并告警。
                if n > 1
                    && grids
                        .iter()
                        .any(|g| g.iter().any(|r| r.iter().any(|c| c.formula.is_some())))
                {
                    warnings.push(format!(
                        "[{}] 分页导出时公式坐标按整表生成、与逐页复制后的行号不一致，已回落写值",
                        sheet_name
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
                        name: format!("{} ({}/{})", sheet_name, i + 1, n),
                        rows,
                    });
                }
            }
            sheets.push(RenderedSheet { name: sheet_name, rows });
        }
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

/// 循环变量：按 `field` 的**不同取值**把数据集分组，一个取值渲染出一张 sheet。
///
/// 这是 NopReport「循环变量出 N 个 sheet」那一层，用来做
/// 「一个客户一张表 / 一个部门一张表 / 一个员工一份档案」。
/// 每组只看到属于自己的那几行，所以组内的 `=^ds1.xxx` 只会展开本组的行
/// —— 配合 UNNEST 就是档案式报表：按人循环，表内再摊平他的子表。
///
/// 多数据集时：循环变量在**主数据集**上取值，其余数据集按同名同值跟着筛；
/// 某个数据集里压根没这个字段就不筛它（整份透传），并告警说明。
///
/// 返回 `(分组名, 该组的各数据集)`；**分组名为空串表示没开循环**，调用方照旧出单张表。
/// 分组顺序 = 取值在主数据集里首次出现的顺序（不重排，跟源数据一致）。
fn loop_groups(
    datasets: &BTreeMap<String, DataSet>,
    primary: &str,
    field: Option<&str>,
    sheet_name: &str,
    warnings: &mut Vec<String>,
) -> Vec<(String, BTreeMap<String, DataSet>)> {
    let all = || datasets.clone();
    let field = match field {
        Some(f) if !f.trim().is_empty() => f,
        _ => return vec![(String::new(), all())],
    };
    let ds = match datasets.get(primary) {
        Some(d) => d,
        None => return vec![(String::new(), all())],
    };
    // 空数据集分不出组，但仍出一张空表：xlsx 至少要有一个 worksheet，
    // 整个报表 0 张 sheet 会在导出时直接报错
    if ds.is_empty() {
        return vec![(String::new(), all())];
    }
    // 字段压根不存在 —— 多半是字段名写错了。宁可告警 + 退回单张表，
    // 也不要按「(空)」出一张看起来正常、其实什么都没筛的空表
    if !ds.iter().any(|r| r.contains_key(field)) {
        warnings.push(format!(
            "[{sheet_name}] 循环字段「{field}」在数据集中不存在，已按单张表渲染"
        ));
        return vec![(String::new(), all())];
    }

    // 其它数据集没有这个字段就整份透传 —— 提前说清楚，免得用户以为也筛了
    for (name, other) in datasets.iter() {
        if name == primary || other.is_empty() {
            continue;
        }
        if !other.iter().any(|r| r.contains_key(field)) {
            warnings.push(format!(
                "[{sheet_name}] 循环字段「{field}」在数据集 {name} 里不存在，\
                 该数据集不会被拆分，每张表都会看到它的全部行"
            ));
        }
    }

    let mut order: Vec<String> = Vec::new();
    let mut map: BTreeMap<String, DataSet> = BTreeMap::new();
    let mut vals: BTreeMap<String, JsonValue> = BTreeMap::new();
    for row in ds {
        let key = match row.get(field) {
            Some(JsonValue::Null) | None => "(空)".to_string(),
            Some(JsonValue::String(s)) => s.clone(),
            Some(JsonValue::Number(n)) => {
                if let Some(i) = n.as_i64() {
                    i.to_string()
                } else if let Some(u) = n.as_u64() {
                    u.to_string()
                } else {
                    // 跟格子渲染一个规矩：整数不拖 .0（Rust 的 f64 Display 已经如此）
                    format!("{}", n.as_f64().unwrap_or(0.0))
                }
            }
            Some(JsonValue::Bool(b)) => b.to_string(),
            Some(other) => other.to_string(),
        };
        if !map.contains_key(&key) {
            order.push(key.clone());
        }
        map.entry(key.clone()).or_default().push(row.clone());
        // 记下这一组对应的**原始值**，用来给其它数据集做同名同值的筛选
        vals.entry(key)
            .or_insert_with(|| row.get(field).cloned().unwrap_or(JsonValue::Null));
    }

    let mut out = Vec::with_capacity(order.len());
    for k in order {
        let Some(v) = map.remove(&k) else { continue };
        let val = vals.remove(&k).unwrap_or(JsonValue::Null);
        let mut group: BTreeMap<String, DataSet> = BTreeMap::new();
        group.insert(primary.to_string(), v);
        for (name, other) in datasets.iter() {
            if name == primary {
                continue;
            }
            // 有这个字段才筛；没有就整份透传（上面已经告警过了）
            if other.iter().any(|r| r.contains_key(field)) {
                group.insert(
                    name.clone(),
                    other
                        .iter()
                        .filter(|r| r.get(field) == Some(&val))
                        .cloned()
                        .collect(),
                );
            } else {
                group.insert(name.clone(), other.clone());
            }
        }
        out.push((k, group));
    }
    out
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

/// 把每行 `field` 上的数组摊成多行：父行字段 + 数组元素字段合并成一行。
///
/// 摊平后引擎看到的就是一张普通扁表，展开、层次坐标、行父链全走既有逻辑，
/// 不用给引擎加「实例 ↔ 嵌套路径」这一层。
///
/// - 元素是对象：字段直接并进这一行
/// - 元素是标量：挂到 `field` 这个名字上
/// - 数组为空：**保留父行**（去掉数组字段），否则该实体会整个消失
fn unnest(ds: &DataSet, field: &str) -> DataSet {
    let mut out: DataSet = Vec::with_capacity(ds.len());
    for row in ds {
        match row.get(field) {
            Some(JsonValue::Array(items)) if !items.is_empty() => {
                for it in items {
                    let mut r = row.clone();
                    r.remove(field);
                    match it {
                        JsonValue::Object(o) => {
                            for (k, v) in o {
                                r.insert(k.clone(), v.clone());
                            }
                        }
                        other => {
                            r.insert(field.to_string(), other.clone());
                        }
                    }
                    out.push(r);
                }
            }
            Some(JsonValue::Array(_)) => {
                // 空数组：保留父行，明细格自然出空
                let mut r = row.clone();
                r.remove(field);
                out.push(r);
            }
            _ => out.push(row.clone()),
        }
    }
    out
}

/// 准备本 sheet 的数据集：先挑出本 sheet 用到的那些数据集，再**逐个**按需
/// 把嵌套数组摊平成扁平行。
///
/// 一个 sheet 可以有多个数据集（每个数据源一条 SQL），这是正常的：
/// 父子格跨数据集时用 `CellModel.join_on` 声明关联键即可，不需要在 SQL 侧
/// 先 JOIN。返回 `(数据集表, 主数据集名, 告警)`。`primary` 是格子**没写 ds**
/// 时用的那一份（= 模板里第一个引用到、且真实存在的数据集）。
///
/// 嵌套绑定写成 `数组名.字段名`（如 `educations.school`）—— 跟普通字段名一样是
/// 一个字符串，不用给 CellModel 加字段，模板里也自解释。摊平后前缀会被去掉，
/// 因为元素字段此时已经和父行字段在同一层了。
/// 摊平是**按数据集分别做**的：ds1 摊平 educations、ds2 摊平 items 互不干扰。
fn prepare_dataset(
    datasets: &BTreeMap<String, DataSet>,
    sheet: &mut SheetTpl,
) -> (BTreeMap<String, DataSet>, String, Vec<String>) {
    let (mut picked, primary, mut warns) = pick_datasets(datasets, sheet);

    // 收集模板里写成 `数组名.字段名` 的绑定，按「该格最终用哪个数据集」分组，
    // 组内前缀去重、保序
    let mut by_ds: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in sheet.rows.iter() {
        for cell in row.cells.iter() {
            let Some(m) = cell.model.as_ref() else { continue };
            let name = m.ds.clone().unwrap_or_else(|| primary.clone());
            let Some(f) = m.field.as_deref() else { continue };
            let Some((head, rest)) = f.split_once('.') else { continue };
            if head.is_empty() || rest.is_empty() {
                continue;
            }
            let v = by_ds.entry(name).or_default();
            if !v.iter().any(|p| p == head) {
                v.push(head.to_string());
            }
        }
    }
    if by_ds.is_empty() {
        return (picked, primary, warns);
    }

    for (ds_name, prefixes) in by_ds {
        let Some(ds) = picked.get_mut(&ds_name) else { continue };

        // 一个数据集只能摊平一个数组：多个嵌套集合并进一张扁表会变成笛卡尔积。
        if prefixes.len() > 1 {
            warns.push(format!(
                "数据集 {ds_name} 上引用了多个嵌套数组（{}）；一个数据集只能摊平一个，\
                 多个嵌套集合请拆到多个数据集或多个 sheet。本次不摊平，这些格子会取不到值",
                prefixes.join("、")
            ));
            continue;
        }

        let head = &prefixes[0];
        if !ds.iter().any(|r| matches!(r.get(head), Some(JsonValue::Array(_)))) {
            warns.push(format!(
                "绑定写了 {head}.x 的嵌套形式，但数据集 {ds_name} 里 {head} 不是数组；按普通字段处理"
            ));
            continue;
        }

        let unnested = unnest(ds, head);
        *ds = unnested;
        // 去前缀：摊平后元素字段已经在这一层。只改绑在这个数据集上的格子
        for row in sheet.rows.iter_mut() {
            for cell in row.cells.iter_mut() {
                let Some(m) = cell.model.as_mut() else { continue };
                let name = m.ds.clone().unwrap_or_else(|| primary.clone());
                if name != ds_name {
                    continue;
                }
                if let Some(f) = m.field.as_deref() {
                    if let Some(rest) = f.strip_prefix(head.as_str()).and_then(|s| s.strip_prefix('.')) {
                        m.field = Some(rest.to_string());
                    }
                }
            }
        }
    }
    (picked, primary, warns)
}

/// 挑出本 sheet 引用的数据集。
///
/// 以前这里是「只能挑一个」并告警；现在多数据集是一等公民，**引用几个就给几个**。
/// 只在「引用了不存在的名字」时告警 —— 那才是真会静默出空的错误。
fn pick_datasets(
    datasets: &BTreeMap<String, DataSet>,
    sheet: &SheetTpl,
) -> (BTreeMap<String, DataSet>, String, Vec<String>) {
    let mut referenced: Vec<String> = Vec::new();
    for row in sheet.rows.iter() {
        for cell in row.cells.iter() {
            if let Some(m) = &cell.model {
                if let Some(name) = &m.ds {
                    if !referenced.contains(name) {
                        referenced.push(name.clone());
                    }
                }
            }
        }
    }

    let mut warns = Vec::new();

    // 引用了不存在的名字：这个数据集的行根本拿不到，字段必然取不到
    let available: Vec<String> = datasets.keys().cloned().collect();
    for n in referenced.iter().filter(|n| !datasets.contains_key(*n)) {
        warns.push(format!(
            "单元格引用了数据集 {n}，但提交的数据集里没有它（有：{}）",
            if available.is_empty() {
                "无".to_string()
            } else {
                available.join("、")
            }
        ));
    }

    let mut picked: BTreeMap<String, DataSet> = BTreeMap::new();
    for n in &referenced {
        if let Some(ds) = datasets.get(n) {
            picked.insert(n.clone(), ds.clone());
        }
    }

    // 主数据集：格子没写 ds 时用哪一份。取「第一个引用到且真实存在」的，
    // 没有引用就取名字最小的那个 —— 跟「单数据集时代」的行为一致
    let primary = referenced
        .iter()
        .find(|n| datasets.contains_key(*n))
        .cloned()
        .or_else(|| datasets.keys().next().cloned())
        .unwrap_or_else(|| engine::DEFAULT_DS.to_string());

    // 一个格都没写 ds：把所有数据集都给它，免得老模板（不写 ds）突然只剩一份
    if picked.is_empty() {
        picked = datasets.clone();
    }
    (picked, primary, warns)
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
/// `POST /api/report/import`：上传 xlsx（base64），返回**模板** JSON
///
/// 注意这里返回的是模板（可被设计器直接打开编辑），不是渲染结果——
/// 导入是「拿别人的 Excel 当模板」，下一步才是配数据源、执行。
pub async fn import_handler(
    Json(req): Json<ImportRequest>,
) -> Result<Json<ReportTemplate>, (StatusCode, String)> {
    let bytes = crate::util::decode_base64_lenient(&req.base64)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("base64 解码失败：{e}")))?;
    let tpl = import::import_xlsx(&bytes).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(tpl))
}

pub async fn xlsx_handler(
    State(state): State<AppState>,
    Json(req): Json<RenderRequest>,
) -> Result<HttpResponse<axum::body::Body>, (StatusCode, String)> {
    // 表头行数：模板分页配置里的 `repeat_header_rows`（与分页渲染用的是同一个值），
    // 没配分页就 1。它同时决定「前几行用表头样式」和「打印时表头跨页重复」。
    // 必须在 `render_with_sources` 之前取 —— 它会把 `req` 整个吃掉。
    let head = req
        .template
        .sheets
        .first()
        .and_then(|s| s.page.as_ref())
        .map_or(1, |p| p.repeat_header_rows.max(1));
    let resp = render_with_sources(&state, req).await.map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    // 模板配了分页时按页导出（每页一个 sheet），否则导出整表。
    // 文件名始终取未分页的 sheet 名，避免带上「 (1/3)」这类页码后缀。
    let sheets = resp.pages.as_ref().unwrap_or(&resp.sheets);
    let buf = xlsx::to_xlsx(sheets, head).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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
///
/// 顺带回一个 `x-reports-dir` 响应头：目录是从**配置路径**推出来的，而配置路径
/// 默认是相对路径，所以「从哪个目录启动」会悄悄改变它。列表为空时前端能靠这个
/// 头告诉用户「服务端在哪儿找过」，而不是干瞪眼一个空下拉框。
/// 用 header 而不是塞进 body：body 的形状（`ReportSummary[]`）已经有人在用了。
pub async fn reports_list_handler(
    State(state): State<AppState>,
) -> Result<HttpResponse<axum::body::Body>, (StatusCode, String)> {
    let dir = reports_dir_of(&state);
    let list = store::list(&dir).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let mut resp = Json(list).into_response();
    match axum::http::HeaderValue::from_str(&store::header_safe(
        &crate::config::ServerConfig::abs_display(&dir),
    )) {
        Ok(v) => {
            resp.headers_mut().insert("x-reports-dir", v);
        }
        Err(e) => {
            // 编过了还是进不去，说明 header_safe 漏了字节 —— 说出来，别装没事
            eprintln!("[warn] x-reports-dir 无法编码为响应头（{}）：{e}", dir.display());
        }
    }
    Ok(resp)
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
    // 存盘的模板是**未套分页**的原样，所以先看模板里的分页配置，
    // 再退回 options 里的 repeat_header_rows。
    let head = def
        .template
        .sheets
        .first()
        .and_then(|s| s.page.as_ref())
        .map(|p| p.repeat_header_rows)
        .or_else(|| def.options.repeat_header_rows.map(|v| v as usize))
        .filter(|n| *n > 0)
        .unwrap_or(1);
    let resp = run_def(&state, def, body.map(|b| b.0).unwrap_or_default())
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let sheets = resp.pages.as_ref().unwrap_or(&resp.sheets);
    let buf = xlsx::to_xlsx(sheets, head).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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

/// 命令行 `--params` 的 JSON 解析。
///
/// 宽松一点，两种写法都收：
///   `{"ds1":["华东"]}`  —— 标准写法，值就是参数列表
///   `{"ds1":"华东"}`    —— 单个参数时不必套一层数组
pub fn parse_cli_params(json: &str) -> Result<BTreeMap<String, Vec<JsonValue>>, String> {
    let v: JsonValue =
        serde_json::from_str(json).map_err(|e| format!("--params 不是合法 JSON：{e}"))?;
    let obj = v
        .as_object()
        .ok_or_else(|| "--params 必须是 JSON 对象，形如 {\"ds1\":[\"华东\"]}".to_string())?;
    let mut out = BTreeMap::new();
    for (k, val) in obj.iter() {
        let list = match val {
            JsonValue::Array(a) => a.clone(),
            other => vec![other.clone()],
        };
        out.insert(k.clone(), list);
    }
    Ok(out)
}

/// 命令行 `--param k=v` 的增量写入：v 先按 JSON 解，解不动就当字符串。
pub fn merge_cli_param(
    map: &mut BTreeMap<String, Vec<JsonValue>>,
    key: &str,
    raw: &str,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("--param 的键不能为空，写法是 --param ds1=华东".to_string());
    }
    let val = serde_json::from_str::<JsonValue>(raw).unwrap_or_else(|_| JsonValue::from(raw));
    let list = match val {
        JsonValue::Array(a) => a,
        other => vec![other],
    };
    map.insert(key.to_string(), list);
    Ok(())
}

/**
 * 命令行执行一个已保存的报表：`print-server --run-report <id>`
 *
 * 存在的理由：报表文件不该只有「在设计器里点」这一种用法。
 * 存下来的定义是纯 JSON，可以被 cron / 脚本直接跑，不必起前端。
 */
pub async fn run_report_cli(
    state: &AppState,
    id: &str,
    params: Option<BTreeMap<String, Vec<JsonValue>>>,
    out: Option<&std::path::Path>,
) -> Result<String, String> {
    let dir = store::reports_dir(state.config_path.as_ref());
    let def = store::load(&dir, id)?;
    let head = def
        .template
        .sheets
        .first()
        .and_then(|s| s.page.as_ref())
        .map(|p| p.repeat_header_rows)
        .or_else(|| def.options.repeat_header_rows.map(|v| v as usize))
        .filter(|n| *n > 0)
        .unwrap_or(1);
    let title = if def.name.trim().is_empty() {
        def.id.clone()
    } else {
        def.name.clone()
    };
    let resp = run_def(
        state,
        def,
        RunRequest {
            params,
            dump: None,
        },
    )
    .await?;

    if let Some(path) = out {
        let sheets = resp.pages.as_ref().unwrap_or(&resp.sheets);
        let buf = xlsx::to_xlsx(sheets, head)?;
        std::fs::write(path, buf).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
        return Ok(format!(
            "已导出 {} → {}（{} 字节）",
            title,
            path.display(),
            std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
        ));
    }

    // 没给 --out 就打印成文本表格，方便终端里直接看
    let mut s = String::new();
    if let Some(w) = &resp.warnings {
        if !w.is_empty() {
            s.push_str(&format!("告警：{}\n\n", w.join("；")));
        }
    }
    for sheet in resp.sheets.iter() {
        s.push_str(&format!("[{}]\n", sheet.name));
        for row in sheet.rows.iter() {
            s.push_str(
                &row.iter()
                    .map(|c| c.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" | "),
            );
            s.push('\n')
        }
    }
    Ok(s)
}

/// 执行一个报表定义：应用 options → 合并运行时参数 → 渲染
pub async fn run_def(
    state: &AppState,
    def: store::ReportDef,
    run: RunRequest,
) -> Result<RenderResponse, String> {
    let template = store::apply_options(def.template, &def.options);

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
    let buf = xlsx::to_xlsx(&resp.sheets, 1).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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
            join_on: None,
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
        loop_field: None,
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
            join_on: None,
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
        loop_field: None,
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
            join_on: None,
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
        loop_field: None,
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
            join_on: None,
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
        loop_field: None,
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
            join_on: None,
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
        loop_field: None,
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
            join_on: None,
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
        loop_field: None,
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

    /// 网格原样取成二维字符串：不做 join、不 trim，断言列数/空格靠得住
    fn cell_texts(rows: &[Vec<GridCell>]) -> Vec<Vec<String>> {
        rows.iter().map(|r| r.iter().map(|c| c.text.clone()).collect()).collect()
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
                loop_field: None,
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
                join_on: None,
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
                loop_field: None,
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
                join_on: None,
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
                loop_field: None,
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
                join_on: None,
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
                loop_field: None,
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
                join_on: None,
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
                            cell(None, {
                                // A2 自己是展开格：helper 里的 row_parent 硬编码成 A2，
                                // 就成了「自己声明自己当主格」。原先靠「父格查不到 →
                                // 退回挂根」侥幸跑通，这里显式改成无主格。
                                let mut mm = m(Some("month"), true, None).expect("model");
                                mm.row_parent = None;
                                Some(mm)
                            }),
                            cell(None, m(Some("amount"), false, None)),
                            // 第 1 个月没有上月，给 '--'
                            cell(None, m(None, false, Some("IF(A2.expandIndex > 0, B2 / B2[A2:-1], '--')"))),
                            cell(None, m(None, false, Some("PROPORTION(B2)"))),
                            cell(None, m(None, false, Some("ACCSUM(B2)"))),
                        ],
                    },
                ],
                loop_field: None,
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
                join_on: None,
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
                loop_field: None,
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
                join_on: None,
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
                loop_field: None,
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

    /// 【规则 3】展开范围「影子」下的无父格格子要被顶层展开格收编
    ///
    /// 模板里 B2 向下合并一格（B2:B3），把 A2 的展开范围从「自己那一行」撑到了第 3 行。
    /// 第 3 行的 C3 扫不到任何父格（本行 col0/col1 都是空的），
    /// 没有规则 3 时它会挂根、只渲染一次——表现为分组明细末尾冒出一个总计 37,200。
    #[test]
    fn rule3_adopts_orphan_cell_in_expand_range() {
        let text = lines(&render_rule3_template(None).sheets[0].rows);

        // 收编后 C3 跟着地区展开：华东 12,000+9,900=21,900；华南 15,300
        assert!(text.iter().any(|l| l.contains("21,900")), "{text:#?}");
        assert!(text.iter().any(|l| l.contains("15,300")), "{text:#?}");
        // 关键：不能再出现那个挂根的总计
        assert!(!text.iter().any(|l| l.contains("37,200")), "{text:#?}");
    }

    /// 【规则 3 的边界】显式 `A0` 的格子**不受**规则 3 影响
    ///
    /// 上游的门槛是 `getRowParent() == null`，而 `A0` 在那边是 `CellPosition.NONE`
    /// ——一个**非 null 的哨兵值**。所以「显式声明不要父格」和「什么都没写」必须区别对待，
    /// 否则用户写了 `A0` 反而被收编，等于这个声明没生效。
    ///
    /// 这里把 C3 改成显式 `A0`：它就该老老实实挂根，只渲染一次、给出总计 37,200。
    #[test]
    fn rule3_leaves_explicit_a0_alone() {
        let text = lines(&render_rule3_template(Some("A0")).sheets[0].rows);

        assert!(text.iter().any(|l| l.contains("37,200")), "{text:#?}");
        assert!(!text.iter().any(|l| l.contains("21,900")), "{text:#?}");
        assert!(!text.iter().any(|l| l.contains("15,300")), "{text:#?}");
    }

    /// 【布局步长】一个展开组的子树实际跨 N 行时，布局推进必须走 N。
    ///
    /// 设计要点：每个城市的子格分布在两个模板行（备注在 row 2、数量在 row 3），
    /// 所以每个城市跨 2 行：华东 2 城市 → 4 行，华南 1 城市 → 2 行。
    /// 期望总行数 1（标题）+ 4 + 2 = 7。
    ///
    /// 反例：固定 +1 会把华东压成 2 行、华南压成 1 行 → 总 4 行。
    /// （探针验证过：把 `inner += n` 改成 `inner += 1` → 4 != 7 立刻红。）
    ///
    /// 这是润乾/NopReport 的 ExtendedArea（to−from+1）：展开步长随子树行数变，
    /// 不是固定 +1。本测试守住这条不变式。
    #[test]
    fn layout_step_is_subtree_size_not_fixed_one() {
        let mut datasets = BTreeMap::new();
        datasets.insert(
            "ds1".to_string(),
            vec![
                serde_json::json!({"region":"华东","city":"上海","note":"西溪","qty":100}),
                serde_json::json!({"region":"华东","city":"杭州","note":"西湖","qty":200}),
                serde_json::json!({"region":"华南","city":"广州","note":"珠江","qty":300}),
            ]
            .into_iter()
            .map(|v| {
                v.as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, x)| (k.clone(), x.clone()))
                    .collect::<BTreeMap<String, JsonValue>>()
            })
            .collect::<Vec<BTreeMap<String, JsonValue>>>(),
        );
        let txt = |v: &str| CellTpl {
            pos: None,
            value: Some(JsonValue::from(v)),
            model: None,
            ..Default::default()
        };
        let blank = || CellTpl::default();
        let bind = |field: &str, expand: bool, row_parent: Option<&str>| CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some(field.into()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    RowTpl {
                        cells: vec![txt("区域"), txt("城市"), txt("备注"), txt("数量")],
                    },
                    RowTpl {
                        cells: vec![
                            bind("region", true, None),
                            bind("city", true, Some("A2")),
                            bind("note", false, Some("B2")), // 城市自己的备注，row 2
                            txt(""), // D2 在 row 2 留空
                        ],
                    },
                    RowTpl {
                        cells: vec![
                            blank(),
                            blank(),
                            blank(),
                            bind("qty", false, Some("B2")), // 数量在 row 3
                        ],
                    },
                ],
                loop_field: None,
            }],
            datasets,
        };
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None })
            .unwrap();
        let rows = resp.sheets[0].rows.len();
        // 1 标题 + 华东 4 行（上海 2 + 杭州 2）+ 华南 2 行 = 7
        assert_eq!(rows, 7, "{:#?}", lines(&resp.sheets[0].rows));
    }

    /// 上下堆叠的主从：子格在**更下面的模板行**时，父格自己那一行不能被吃掉。
    ///
    /// 这是「档案式 / 分组报表」最常见的形状：A1 展开出「华东 / 华南」，
    /// A2 挂在 A1 下面展开出城市。A1 和 A2 不在同一模板行，所以 A1 必须
    /// 独占一行，子格从下一行开始排。
    #[test]
    fn stacked_parent_keeps_its_own_row() {
        let mut datasets = BTreeMap::new();
        datasets.insert(
            "ds1".to_string(),
            vec![
                serde_json::json!({"region":"华东","city":"上海"}),
                serde_json::json!({"region":"华南","city":"广州"}),
            ]
            .into_iter()
            .map(|v| {
                v.as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, x)| (k.clone(), x.clone()))
                    .collect::<BTreeMap<String, JsonValue>>()
            })
            .collect::<Vec<BTreeMap<String, JsonValue>>>(),
        );
        let bind = |field: &str, expand: bool, row_parent: Option<&str>| CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some(field.into()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    RowTpl { cells: vec![bind("region", true, None)] },
                    // 子格在下一个模板行，且显式挂到 A1 下面
                    RowTpl { cells: vec![bind("city", true, Some("A1"))] },
                ],
                loop_field: None,
            }],
            datasets,
        };
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None })
            .unwrap();
        // 华东 / 上海 / 华南 / 广州 = 4 行。父格那一行被吃掉就只剩 2 行。
        let rows = &resp.sheets[0].rows;
        assert_eq!(rows.len(), 4, "{:#?}", lines(rows));
        // 父格的值必须真的出现在网格里，不只是实例存在
        let texts: Vec<String> = rows
            .iter()
            .map(|r| r.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join("|"))
            .collect();
        assert!(texts.iter().any(|t| t.contains("华东")), "父格「华东」丢了: {texts:#?}");
        assert!(texts.iter().any(|t| t.contains("华南")), "父格「华南」丢了: {texts:#?}");
    }

    /// 一个 sheet 可以引用多个数据集（每个数据源一条 SQL）。
    /// ds1 只有 `city`、ds2 只有 `name`，两格的字段互不重叠 —— 绑错数据集就必然出空。
    fn multi_ds_template(names: &[&str]) -> ReportTemplate {
        let mut datasets = BTreeMap::new();
        datasets.insert(
            "ds1".to_string(),
            vec![serde_json::json!({"city":"北京"})]
                .into_iter()
                .map(|v| {
                    v.as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, x)| (k.clone(), x.clone()))
                        .collect::<BTreeMap<String, JsonValue>>()
                })
                .collect::<Vec<BTreeMap<String, JsonValue>>>(),
        );
        datasets.insert(
            "ds2".to_string(),
            vec![serde_json::json!({"name":"甲公司"})]
                .into_iter()
                .map(|v| {
                    v.as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, x)| (k.clone(), x.clone()))
                        .collect::<BTreeMap<String, JsonValue>>()
                })
                .collect::<Vec<BTreeMap<String, JsonValue>>>(),
        );
        let bind = |ds: &str, field: &str| CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some(ds.into()),
                field: Some(field.into()),
                agg: None,
                expand_type: None,
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
                join_on: None,
            }),
            ..Default::default()
        };
        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: names
                        .iter()
                        .zip(["city", "name"])
                        .map(|(ds, f)| bind(ds, f))
                        .collect(),
                }],
                loop_field: None,
            }],
            datasets,
        }
    }

    #[test]
    fn multi_dataset_renders_both_without_warning() {
        // 一个 sheet 引用多个数据集是**正常的**（每个数据源一条 SQL），不该再告警。
        // 关键是第二格：以前「一个 sheet 只认一个 ds」会让它静默出空
        let resp = render(RenderRequest {
            template: multi_ds_template(&["ds1", "ds2"]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert!(
            resp.warnings.clone().unwrap_or_default().is_empty(),
            "多数据集不该再告警: {:?}",
            resp.warnings
        );
        let texts: Vec<String> = resp.sheets[0].rows[0]
            .iter()
            .map(|c| c.text.clone())
            .collect();
        assert_eq!(
            texts,
            vec!["北京".to_string(), "甲公司".to_string()],
            "两格应各读各的数据集: {texts:?}"
        );
    }

    /// 跨数据集父子格：ds1 是客户（主格，纵向展开），ds2 是订单（子格，按
    /// `join_on` 的关联键取「与父行同值」的那几行）。
    ///
    /// ds1: 1=甲公司, 2=乙公司
    /// ds2: 1→A001/A002, 2→B001
    fn cross_ds_template(join_on: Option<&str>) -> ReportTemplate {
        let cell = |ds: &str,
                    field: &str,
                    expand: bool,
                    row_parent: Option<&str>,
                    join_on: Option<&str>| {
            CellTpl {
                pos: None,
                value: None,
                model: Some(CellModel {
                    ds: Some(ds.into()),
                    field: Some(field.into()),
                    expand_type: if expand { Some(ExpandType::R) } else { None },
                    row_parent: row_parent.map(|s| s.to_string()),
                    join_on: join_on.map(|s| s.to_string()),
                    ..Default::default()
                }),
                ..Default::default()
            }
        };
        let mut datasets = BTreeMap::new();
        // 注意两个数据集的**行数不同**（2 vs 3）—— 按行号硬凑必然错位
        datasets.insert(
            "ds1".to_string(),
            json_rows(vec![
                serde_json::json!({"cust_id": 1, "name": "甲公司"}),
                serde_json::json!({"cust_id": 2, "name": "乙公司"}),
            ]),
        );
        datasets.insert(
            "ds2".to_string(),
            json_rows(vec![
                serde_json::json!({"cust_id": 1, "order_no": "A001", "amount": 100}),
                serde_json::json!({"cust_id": 1, "order_no": "A002", "amount": 200}),
                serde_json::json!({"cust_id": 2, "order_no": "B001", "amount": 50}),
            ]),
        );
        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "客户订单".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![
                        cell("ds1", "name", true, None, None), // A1 主格，在 ds1
                        cell("ds2", "order_no", true, Some("A1"), join_on), // B1 子格，在 ds2
                        cell("ds2", "amount", false, Some("B1"), None), // C1 跟随 B1
                    ],
                }],
                loop_field: None,
            }],
            datasets,
        }
    }

    #[test]
    fn cross_dataset_child_expands_over_joined_rows_only() {
        // 父格在 ds1、子格在 ds2：子格只展开**关联键同值**的那几行，
        // 不是 ds2 的全部 3 行 —— 每个客户下面只挂自己的订单
        let resp = render(RenderRequest {
            template: cross_ds_template(Some("cust_id")),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert!(
            resp.warnings.clone().unwrap_or_default().is_empty(),
            "写了 join_on 就不该告警: {:?}",
            resp.warnings
        );
        let got = cell_texts(&resp.sheets[0].rows);
        assert_eq!(
            got,
            vec![
                vec!["甲公司", "A001", "100"],
                // 父格值只在组的第一行显示（中国式报表的常规形状），不是每行重复
                vec!["", "A002", "200"],
                vec!["乙公司", "B001", "50"],
            ],
            "{got:#?}"
        );
    }

    #[test]
    fn cross_dataset_without_join_on_warns_and_stays_empty() {
        // 没写 join_on 就是没有关联依据 —— 宁可告警 + 出空，也不按行号硬凑
        let resp = render(RenderRequest {
            template: cross_ds_template(None),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("join_on"), "应提示补 join_on: {w}");
        assert!(w.contains("跨数据集"), "应说明是跨数据集: {w}");
        // 子格为空，但父格照常展开，不能整个表塌成 0 行
        let got = cell_texts(&resp.sheets[0].rows);
        assert_eq!(got.len(), 2, "父格仍应展开 2 行: {got:#?}");
        assert_eq!(
            got.iter().map(|r| r[0].clone()).collect::<Vec<_>>(),
            vec!["甲公司", "乙公司"],
            "父格值要照常出: {got:#?}"
        );
        // 关键：绝不能按行号硬凑出一个订单号来
        let flat = got.concat().join("|");
        assert!(!flat.contains("A00") && !flat.contains("B00"), "子格必须为空: {got:#?}");
    }

    #[test]
    fn cross_dataset_join_key_missing_warns() {
        // 关联键在数据集里压根没有：同样告警 + 出空，不能退回全量
        let resp = render(RenderRequest {
            template: cross_ds_template(Some("no_such_key")),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("no_such_key"), "应点名缺失的关联键: {w}");
        let got = cell_texts(&resp.sheets[0].rows);
        let flat = got.concat().join("|");
        assert!(
            !flat.contains("A00") && !flat.contains("B00"),
            "关联键取不到时子格应为空，而不是退回全量: {got:#?}"
        );
    }

    #[test]
    fn loop_field_filters_every_dataset_by_the_same_key() {
        // 循环变量 + 多数据集：主数据集按字段分组，其它数据集按同名同值跟着筛
        let mut tpl = cross_ds_template(Some("cust_id"));
        tpl.sheets[0].loop_field = Some("cust_id".to_string());
        // 另起一行放一个**不挂父格**的 ds2 合计（A2）。它看到的是「本组那一份 ds2」
        // 的全部行，所以它的值直接暴露了「其它数据集到底有没有跟着筛」——
        // 只靠 B1 是测不出来的，B1 本来就被 join_on 筛过一遍。
        // （放在同一行会被「同行上下文」带偏，变成只合计当前行）
        tpl.sheets[0].rows.push(RowTpl {
            cells: vec![CellTpl {
                pos: None,
                value: None,
                model: Some(CellModel {
                    ds: Some("ds2".into()),
                    field: Some("amount".into()),
                    agg: Some(AggType::Sum),
                    ..Default::default()
                }),
                ..Default::default()
            }],
        });
        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let names: Vec<String> = resp.sheets.iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["客户订单 - 1", "客户订单 - 2"], "{names:?}");
        // 第 2 张表只该看到 cust_id=2：ds1 的乙公司 + ds2 的 B001
        // （ds2 也按 cust_id 跟着筛了，所以不会串进 A001/A002）
        // 合计 50（不是 350）说明 ds2 也被按 cust_id 筛过了
        let second = cell_texts(&resp.sheets[1].rows);
        assert_eq!(
            second,
            vec![vec!["乙公司", "B001", "50"], vec!["50", "", ""]],
            "{second:#?}"
        );
        // 甲公司那组 ds2 有 A001+A002 = 300；没筛的话会是 350（把 B001 也算进来）
        let first = cell_texts(&resp.sheets[0].rows);
        assert_eq!(
            first,
            vec![
                vec!["甲公司", "A001", "100"],
                vec!["", "A002", "200"],
                vec!["300", "", ""],
            ],
            "{first:#?}"
        );
    }

    #[test]
    fn single_dataset_reference_does_not_warn() {
        // 全都绑同一个数据集不该报——否则正常报表会被噪声淹没
        let resp = render(RenderRequest {
            template: multi_ds_template(&["ds1", "ds1"]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert!(
            !resp.warnings.clone().unwrap_or_default().iter().any(|w| w.contains("多个数据集")),
            "单一数据集不该告警: {:?}",
            resp.warnings
        );
    }

    #[test]
    fn unknown_dataset_name_warns() {
        let resp = render(RenderRequest {
            template: multi_ds_template(&["ds3"]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("ds3"), "应点名不存在的数据集 ds3: {w}");
        assert!(w.contains("没有它"), "应说明数据集里没有它: {w}");
    }

    /// 嵌套数组：`数组名.字段名` 的绑定会让引擎先把数组摊平成扁平行再展开。
    fn nested_rows() -> Vec<BTreeMap<String, JsonValue>> {
        vec![serde_json::json!({
            "name": "张三",
            "educations": [
                {"school": "清华", "year": 2000},
                {"school": "北大", "year": 2004},
            ],
        })]
        .into_iter()
        .map(|v| {
            v.as_object()
                .unwrap()
                .iter()
                .map(|(k, x)| (k.clone(), x.clone()))
                .collect::<BTreeMap<String, JsonValue>>()
        })
        .collect()
    }

    fn nested_template(fields: &[&str]) -> ReportTemplate {
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), nested_rows());
        let bind = |field: &str, expand: bool, row_parent: Option<&str>| CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some(field.into()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "档案".into(),
                page: None,
                rows: vec![
                    RowTpl { cells: vec![bind("name", true, None)] },
                    RowTpl {
                        // 第一个字段负责展开（明细行的主键），其余跟随
                        cells: fields
                            .iter()
                            .enumerate()
                            .map(|(i, f)| bind(f, i == 0, Some("A1")))
                            .collect(),
                    },
                ],
                loop_field: None,
            }],
            datasets,
        }
    }

    #[test]
    fn nested_array_is_unnested_before_expand() {
        let resp = render(RenderRequest {
            template: nested_template(&["educations.school", "educations.year"]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let text = lines(&resp.sheets[0].rows);
        // 摊平前 `educations` 是一个数组值，只能分出一组，明细格会打出整段 JSON。
        // 摊平后应该是 张三 / 清华+2000 / 北大+2004 三行。
        assert_eq!(text.len(), 3, "{text:#?}");
        assert!(text.iter().any(|l| l.contains("张三")), "{text:#?}");
        assert!(text.iter().any(|l| l.contains("清华")), "{text:#?}");
        assert!(text.iter().any(|l| l.contains("北大")), "{text:#?}");
        assert!(
            !text.iter().any(|l| l.contains('{')),
            "不该把整个数组当文本打出来: {text:#?}"
        );
    }

    #[test]
    fn two_nested_arrays_warn_instead_of_cartesian() {
        // 两个嵌套集合并进一张扁表会变笛卡尔积，所以不摊平，而是明确告警
        let resp = render(RenderRequest {
            template: nested_template(&["educations.school", "works.company"]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("多个嵌套数组"), "应告警: {w}");
        assert!(w.contains("educations") && w.contains("works"), "要点名两个数组: {w}");
    }

    #[test]
    fn empty_nested_array_keeps_parent_row() {
        // 空数组不能把实体整行吃掉——明细出空，父行仍在
        let mut tpl = nested_template(&["educations.school"]);
        tpl.datasets.insert(
            "ds1".to_string(),
            vec![serde_json::json!({"name": "李四", "educations": []})]
                .into_iter()
                .map(|v| {
                    v.as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, x)| (k.clone(), x.clone()))
                        .collect::<BTreeMap<String, JsonValue>>()
                })
                .collect(),
        );
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None })
            .unwrap();
        let text = lines(&resp.sheets[0].rows);
        assert!(
            text.iter().any(|l| l.contains("李四")),
            "空数组不该把父行吃掉: {text:#?}"
        );
    }

    fn json_rows(rows: Vec<JsonValue>) -> DataSet {
        rows.into_iter()
            .map(|v| {
                v.as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, x)| (k.clone(), x.clone()))
                    .collect::<BTreeMap<String, JsonValue>>()
            })
            .collect()
    }

    /// 循环变量模板：A1 是分组字段本身（不展开，取本组值），A2 展开明细。
    fn loop_template(loop_field: Option<&str>, ds: DataSet) -> ReportTemplate {
        let bind = |field: &str, expand: bool| CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some(field.into()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), ds);
        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "分区".into(),
                page: None,
                rows: vec![
                    RowTpl { cells: vec![bind("region", false)] },
                    RowTpl { cells: vec![bind("city", true)] },
                ],
                loop_field: loop_field.map(|s| s.to_string()),
            }],
            datasets,
        }
    }

    /// 华东出现两次且不相邻 —— 用来验证分组是「按值聚合」而不是「按行切段」
    fn region_rows() -> DataSet {
        json_rows(vec![
            serde_json::json!({"region": "华东", "city": "上海"}),
            serde_json::json!({"region": "华南", "city": "广州"}),
            serde_json::json!({"region": "华东", "city": "杭州"}),
            serde_json::json!({"region": "华北", "city": "北京"}),
        ])
    }

    #[test]
    fn loop_field_splits_one_sheet_into_n() {
        let resp = render(RenderRequest {
            template: loop_template(Some("region"), region_rows()),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();

        // 顺序 = 取值在数据里首次出现的顺序（不是排序后的顺序）
        let names: Vec<String> = resp.sheets.iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["分区 - 华东", "分区 - 华南", "分区 - 华北"], "{names:?}");

        // 每张表只看到自己那几行；华东的两行不相邻也能聚到一起
        let east = lines(&resp.sheets[0].rows).join("\n");
        assert!(east.contains("华东"), "{east}");
        assert!(east.contains("上海") && east.contains("杭州"), "华东应有上海+杭州: {east}");
        assert!(!east.contains("广州"), "华南的广州不该串到华东表: {east}");

        let south = lines(&resp.sheets[1].rows).join("\n");
        assert!(south.contains("广州"), "{south}");
        assert!(!south.contains("上海"), "华东不该串到华南表: {south}");
    }

    #[test]
    fn loop_field_off_keeps_a_single_sheet() {
        let resp = render(RenderRequest {
            template: loop_template(None, region_rows()),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert_eq!(resp.sheets.len(), 1);
        assert_eq!(resp.sheets[0].name, "分区", "没开循环时不该加后缀");
    }

    #[test]
    fn loop_field_missing_warns_and_falls_back_to_one_sheet() {
        let resp = render(RenderRequest {
            template: loop_template(Some("regionn"), region_rows()),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert_eq!(resp.sheets.len(), 1, "字段写错应退回单张表，而不是出一张假空表");
        assert_eq!(resp.sheets[0].name, "分区");
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("regionn"), "告警应点名写错的字段: {w}");
        assert!(w.contains("不存在"), "应说明字段在数据集里不存在: {w}");
    }

    #[test]
    fn loop_field_empty_dataset_still_yields_one_sheet() {
        // 0 张 sheet 会让 xlsx 导出直接失败（至少得有一个 worksheet）
        let resp = render(RenderRequest {
            template: loop_template(Some("region"), vec![]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert_eq!(resp.sheets.len(), 1, "空数据集不能产出 0 张 sheet");
        assert_eq!(resp.sheets[0].name, "分区");
    }

    #[test]
    fn loop_field_composes_with_unnest() {
        // 档案式报表：按人循环出 N 张表，表内再摊平他的 educations
        let bind = |field: &str, expand: bool| CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some(field.into()),
                agg: None,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut datasets = BTreeMap::new();
        datasets.insert(
            "ds1".to_string(),
            json_rows(vec![
                serde_json::json!({"name": "张三", "educations": [
                    {"school": "清华", "year": 2000}, {"school": "北大", "year": 2004}
                ]}),
                serde_json::json!({"name": "李四", "educations": [
                    {"school": "浙大", "year": 2010}
                ]}),
            ]),
        );
        let resp = render(RenderRequest {
            template: ReportTemplate {
                sheets: vec![SheetTpl {
                    name: "档案".into(),
                    page: None,
                    rows: vec![
                        RowTpl { cells: vec![bind("name", false)] },
                        RowTpl { cells: vec![bind("educations.school", true)] },
                    ],
                    loop_field: Some("name".to_string()),
                }],
                datasets,
            },
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();

        let names: Vec<String> = resp.sheets.iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["档案 - 张三", "档案 - 李四"], "{names:?}");
        let zs = lines(&resp.sheets[0].rows).join("\n");
        assert!(zs.contains("张三") && zs.contains("清华") && zs.contains("北大"), "{zs}");
        assert!(!zs.contains("浙大"), "李四的经历不该串到张三表: {zs}");
        let ls = lines(&resp.sheets[1].rows).join("\n");
        assert!(ls.contains("李四") && ls.contains("浙大"), "{ls}");
        assert!(!ls.contains("清华"), "张三的经历不该串到李四表: {ls}");
    }

    /// 规则 3 的验模板：B2 向下合并一格把 A2 的展开范围撑到第 3 行，
    /// 第 3 行只留 C 列一个无父格格子（`c3_row_parent` 可指定它的 `row_parent`）。
    fn render_rule3_template(c3_row_parent: Option<&str>) -> RenderResponse {
        let mut datasets = BTreeMap::new();
        datasets.insert(
            "ds1".to_string(),
            vec![
                serde_json::json!({"region":"华东","city":"上海","salesman":"张三","amount":12000}),
                serde_json::json!({"region":"华东","city":"杭州","salesman":"王五","amount":9900}),
                serde_json::json!({"region":"华南","city":"广州","salesman":"孙七","amount":15300}),
            ]
            .into_iter()
            .map(|v| {
                v.as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, x)| (k.clone(), x.clone()))
                    .collect::<BTreeMap<String, JsonValue>>()
            })
            .collect::<Vec<BTreeMap<String, JsonValue>>>(),
        );
        let txt = |v: &str| CellTpl {
            pos: None,
            value: Some(JsonValue::from(v)),
            model: None,
            ..Default::default()
        };
        let blank = || CellTpl::default();
        let bind = |field: &str, expand: bool, agg: bool, merge_down: usize, row_parent: Option<&str>| CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some(field.into()),
                agg: if agg { Some(AggType::Sum) } else { None },
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: row_parent.map(|s| s.to_string()),
                ..Default::default()
            }),
            merge_down,
            ..Default::default()
        };

        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![
                    RowTpl { cells: vec![txt("地区"), txt("销售员"), txt("小计")] },
                    // B2 向下合并一格（B2:B3）→ 把 A2 的展开范围撑到第 3 行
                    RowTpl {
                        cells: vec![
                            bind("region", true, false, 0, None),
                            bind("salesman", false, false, 1, None),
                            bind("city", false, false, 0, None),
                        ],
                    },
                    // 第 3 行只有 C 列有格，且它扫不到任何父格 → 规则 3 的候选
                    RowTpl {
                        cells: vec![blank(), blank(), bind("amount", false, true, 0, c3_row_parent)],
                    },
                ],
                loop_field: None,
            }],
            datasets,
        };
        render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap()
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
                join_on: None,
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
                    loop_field: None,
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

    /// 【`expandInplaceCount` 的等价性实验】
    ///
    /// NopReport 的 `expandInplaceCount=N`（官方 FAQ「如何支持默认多个空行」）：
    /// 模板里先预留 N 行，展开结果不足 N 条时**复用预留行、不新增行**。
    ///
    /// 本项目没有「预留行」概念——一个模板行就是一行逻辑行，展开靠复制。
    /// 所以不靠读代码下结论：这里把两种写法都渲染一遍，用输出形状做对比。
    /// 三个事实合起来才说明 `expand_min_count` 能不能顶替 `expandInplaceCount`。
    ///
    /// - `min`：明细行上的 `expand_min_count`
    /// - `reserved`：模板里手工多写的「预留行」条数
    /// - `n_data`：数据集条数
    fn bill_template(min: Option<usize>, reserved: usize, n_data: usize) -> RenderResponse {
        let data: Vec<BTreeMap<String, JsonValue>> = (0..n_data)
            .map(|i| {
                let mut m = BTreeMap::new();
                m.insert("name".into(), JsonValue::from(format!("商品{}", i + 1)));
                m.insert("qty".into(), JsonValue::from((i as i64 + 1) * 10));
                m
            })
            .collect();
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), data);

        let txt = |v: &str| CellTpl { pos: None, value: Some(JsonValue::from(v)), model: None, ..Default::default() };
        // 明细行：A 列展开。模板兜底值写成 "—"，用来观察「补出来的行」
        // 到底是**空行**还是**模板行的副本**——这是等价性的关键判据。
        let detail = CellTpl {
            pos: None,
            value: Some(JsonValue::from("—")),
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some("name".into()),
                expand_type: Some(ExpandType::R),
                expand_min_count: min,
                ..Default::default()
            }),
            ..Default::default()
        };
        let qty = CellTpl {
            pos: None,
            value: None,
            model: Some(CellModel {
                ds: Some("ds1".into()),
                field: Some("qty".into()),
                row_parent: Some("A2".into()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let mut rows = vec![RowTpl { cells: vec![txt("品名"), txt("数量")] }];
        rows.push(RowTpl { cells: vec![detail, qty] });
        for i in 0..reserved {
            rows.push(RowTpl { cells: vec![txt(&format!("(预留{})", i + 1)), txt("")] });
        }
        render(RenderRequest {
            template: ReportTemplate { sheets: vec![SheetTpl { name: "t".into(), page: None, rows, loop_field: None }], datasets },
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap()
    }

    /// 事实 1：`expand_min_count` 补出来的是**模板行的副本**，不是空行。
    ///
    /// 明细行的模板兜底值是 "—"，补足的两行应该显示 "—" 而不是空白。
    /// 这正是 NopReport「复用预留行」的输出形状：预留行保留模板内容。
    #[test]
    fn min_count_pads_with_template_row_not_blank_row() {
        let text = lines(&bill_template(Some(4), 0, 2).sheets[0].rows);

        // 表头 1 行 + 明细 4 行（2 条数据 + 2 行补足）
        assert_eq!(text.len(), 5, "{text:#?}");
        assert_eq!(text[1], "商品1 | 10");
        assert_eq!(text[2], "商品2 | 20");
        // 补出来的行：品名回落到模板兜底值，数量没有数据
        assert_eq!(text[3], "— | ", "{text:#?}");
        assert_eq!(text[4], "— | ", "{text:#?}");
    }

    /// 事实 2：`expand_min_count` 是**下限不是上限**——只补不截。
    ///
    /// NopReport 的语义是「不足 N 条才复用预留行，超出就正常新增」，
    /// 所以数据比 N 多时行数必须跟着涨。
    #[test]
    fn min_count_is_a_floor_not_a_cap() {
        // 5 条数据、下限 3 → 5 行明细，一行都不能少
        assert_eq!(lines(&bill_template(Some(3), 0, 5).sheets[0].rows).len(), 6);
        // 2 条数据、下限 3 → 补到 3 行
        assert_eq!(lines(&bill_template(Some(3), 0, 2).sheets[0].rows).len(), 4);
    }

    /// 事实 3：模板里手工写的「预留行」**不是**下限——它不随数据伸缩。
    ///
    /// 静态行没有主格，是根格，永远只渲染一次、且排在展开之后。
    /// 所以「手写预留行」给不出「至少 N 行」：数据多了它不减，数据少了它不增。
    /// 这一条把两种写法区分开，说明它们不可互相替代。
    #[test]
    fn hand_written_reserved_rows_are_not_a_floor() {
        // 2 条数据 + 2 行预留 → 1 + 2 + 2 = 5
        let few = lines(&bill_template(None, 2, 2).sheets[0].rows);
        assert_eq!(few.len(), 5, "{few:#?}");
        assert_eq!(few[3], "(预留1) | ");
        assert_eq!(few[4], "(预留2) | ");

        // 5 条数据 + 2 行预留 → 1 + 5 + 2 = 8：预留行**不会**被数据吃掉
        let many = lines(&bill_template(None, 2, 5).sheets[0].rows);
        assert_eq!(many.len(), 8, "{many:#?}");
        assert_eq!(many[6], "(预留1) | ");
        assert_eq!(many[7], "(预留2) | ");
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
                                    join_on: None,
                                }),
                                merge_across: 0,
                                merge_down: 0,
                                merge_to_end: false,
                            }],
                        },
                    ],
                    loop_field: None,
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
                join_on: None,
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![
                        CellTpl { pos: None, value: None, model: {
                            // 同上：A1 自己是展开格，不能把自己声明成主格
                            let mut mm = m(Some("month"), true, None).expect("model");
                            mm.row_parent = None;
                            Some(mm)
                        }, merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(Some("amount"), false, None), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(None, false, Some("PRODUCT(B1)")), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(None, false, Some("COUNTA(B1)")), merge_across: 0, merge_down: 0, merge_to_end: false },
                        CellTpl { pos: None, value: None, model: m(None, false, Some("RANK(B1)")), merge_across: 0, merge_down: 0, merge_to_end: false },
                    ],
                }],
                loop_field: None,
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
                join_on: None,
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
                loop_field: None,
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

    /// 引擎内部记下的「写法不受支持」告警，必须一路走到 **`render()` 的返回值**。
    ///
    /// 为什么单测这条：告警只有在 `RenderResponse.warnings` 里才算**可见** ——
    /// 前端的网格报表弹窗正是读这个字段（`GridReportModal` 的
    /// `setWarnings(data.warnings)`，渲染在 `data-testid="grid-report-warnings"`）。
    /// 告警只停在 `engine.warnings()`、没进响应，等于白报。
    #[test]
    fn unsupported_combination_warning_reaches_the_response() {
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
        let m = |field: Option<&str>, expand: bool, parent: Option<&str>, expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: parent.map(|s| s.to_string()),
                value_expr: expr.map(|s| s.to_string()),
                ..Default::default()
            })
        };
        let tpl = ReportTemplate {
            sheets: vec![SheetTpl {
                name: "不支持组合".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![
                        cell(Some("地区"), m(Some("region"), true, None, None)),
                        cell(Some("销售员"), m(Some("salesman"), true, Some("A1"), None)),
                        cell(Some("金额"), m(Some("amount"), false, Some("B1"), None)),
                        // ACCSUM 接过滤表达式：不支持，但**必须报出来**而不是给一格空白
                        cell(
                            None,
                            m(None, false, Some("B1"), Some("ACCSUM(C1[A1:+0]{$B1 == B1})")),
                        ),
                    ],
                }],
                loop_field: None,
            }],
            datasets,
        };
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None })
            .expect("渲染不应失败");
        let warnings = resp.warnings.clone().unwrap_or_default();
        assert!(
            warnings.iter().any(|w| w.contains("ACCSUM 不支持过滤表达式")),
            "引擎记下的告警必须进 RenderResponse.warnings。实际：{warnings:#?}"
        );
        assert!(
            warnings.iter().any(|w| w.starts_with("[不支持组合]")),
            "告警要带 sheet 名，便于定位。实际：{warnings:#?}"
        );
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

    /// 一次 `render` 的产物要同时喂给多个输出：网格 JSON、HTML、分页。
    /// 这条守着「多格式同源」这条**结构性质** —— `html` 必须覆盖**全部** sheet。
    /// 哪天有人为了省事只把第一张表发射进 html，单 sheet 的样例照样全绿，
    /// 只有这条会红。
    #[test]
    fn one_render_emits_every_sheet_into_html() {
        let mut tpl = sample_template();
        // 复制出一张同内容、不同名的 sheet：单 sheet 的样例盖不住「漏发射」。
        let mut second = tpl.sheets[0].clone();
        second.name = "第二张表".to_string();
        tpl.sheets.push(second);

        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        assert_eq!(resp.sheets.len(), 2, "样例应展开出 2 张 sheet");

        // to_html 对每张 sheet 恰好写一个 <h3> + 一个 <table>
        assert_eq!(
            resp.html.matches("<table").count(),
            resp.sheets.len(),
            "html 的 <table> 数应等于 sheet 数：一次展开要覆盖全部 sheet，而不是只发第一张"
        );
        assert!(resp.html.contains("第二张表"), "第二张 sheet 的名字必须出现在 html 里");

        // 同一份 IR：html 的正文来自 resp.sheets，不是又独立展开了一遍
        let cell_text = &resp.sheets[0].rows[0][0].text;
        assert!(!cell_text.is_empty(), "防空转：拿来断言的格子文本不能是空串");
        assert!(
            resp.html.contains(&escape(cell_text)),
            "html 应包含 sheets 里的格子文本 {:?}",
            cell_text
        );
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
                join_on: None,
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
            loop_field: None,
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
                loop_field: None,
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
                join_on: None,
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
                loop_field: None,
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
                loop_field: None,
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
        // 该模板配的是 repeat_header_rows: 2，导出时表头行数就按它来
        assert!(crate::report::xlsx::to_xlsx(sheets, 2).is_ok(), "分页结果应能导出 xlsx");

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

    #[test]
    fn cli_params_收标准写法与裸值写法() {
        // 标准写法：值就是参数列表
        let m = parse_cli_params(r#"{"ds1":["华东","华南"]}"#).unwrap();
        assert_eq!(m["ds1"], vec![JsonValue::from("华东"), JsonValue::from("华南")]);

        // 裸值写法：单个参数不必套数组，自动包一层
        let m = parse_cli_params(r#"{"ds1":"华东"}"#).unwrap();
        assert_eq!(m["ds1"], vec![JsonValue::from("华东")]);

        // 数字 / null 这类 JSON 值要按原类型传下去，不能被当成字符串
        let m = parse_cli_params(r#"{"ds1":[2026,null]}"#).unwrap();
        assert_eq!(m["ds1"], vec![JsonValue::from(2026), JsonValue::Null]);
    }

    #[test]
    fn cli_params_非法输入给得出人话() {
        let e = parse_cli_params("{不是 json").unwrap_err();
        assert!(e.contains("不是合法 JSON"), "实际：{e}");

        // 数组 / 标量顶层不是对象，要明确说清楚要对象
        let e = parse_cli_params(r#"["华东"]"#).unwrap_err();
        assert!(e.contains("必须是 JSON 对象"), "实际：{e}");
    }

    #[test]
    fn cli_param_增量合并_能覆盖也能解析类型() {
        let mut m = BTreeMap::new();
        merge_cli_param(&mut m, "ds1", "华东").unwrap();
        assert_eq!(m["ds1"], vec![JsonValue::from("华东")]);

        // 纯数字要变成数字，不是字符串 "2026"
        merge_cli_param(&mut m, "ds2", "2026").unwrap();
        assert_eq!(m["ds2"], vec![JsonValue::from(2026)]);

        // 后写的覆盖先写的（命令行从左到右）
        merge_cli_param(&mut m, "ds1", "华南").unwrap();
        assert_eq!(m["ds1"], vec![JsonValue::from("华南")]);

        // 空键要拦住，不然会生成一个没名字的数据源参数
        let e = merge_cli_param(&mut m, "  ", "x").unwrap_err();
        assert!(e.contains("键不能为空"), "实际：{e}");
    }

    /// `expand_expr`：按**固定字面量列表**展开，而不是按现有数据分组。
    ///
    /// 两件事是 `group_by_field` 做不到的，`expand_expr` 的全部价值就在这：
    /// 1. 顺序由字面量决定 —— 这里故意写成 2月,1月，与数据里的出现顺序**相反**，
    ///    所以如果顺序其实还是跟着数据走，这个断言会立刻红；
    /// 2. 数据里没有的项照样展开出来（3月），值格留空而不是整行消失。
    #[test]
    fn expand_expr_按字面量顺序展开且保留数据里没有的项() {
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), cross_tab_data());

        let cell = |value: Option<&str>, model: Option<CellModel>| CellTpl {
            pos: None,
            value: value.map(|v| JsonValue::from(v)),
            model,
            merge_across: 0,
            merge_down: 0,
            merge_to_end: false,
        };
        let mk = |field: Option<&str>,
                  expand: Option<ExpandType>,
                  row_parent: Option<&str>,
                  expand_expr: Option<&str>,
                  agg: Option<AggType>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg,
                expand_type: expand,
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: None,
                col_after: None,
                value_expr: None,
                expand_expr: expand_expr.map(|s| s.to_string()),
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
                join_on: None,
            })
        };

        let sheet = SheetTpl {
            name: "月份补全".into(),
            page: None,
            rows: vec![
                RowTpl { cells: vec![cell(Some("月份"), None), cell(Some("金额"), None)] },
                RowTpl {
                    cells: vec![
                        // 字面量顺序 = 2月,1月,3月；数据里只有 1月、2月
                        cell(None, mk(Some("month"), Some(ExpandType::R), None, Some(r#"["2月","1月","3月"]"#), None)),
                        cell(None, mk(Some("amount"), None, Some("A2"), None, Some(AggType::Sum))),
                    ],
                },
            ],
            loop_field: None,
        };
        let tpl = ReportTemplate { sheets: vec![sheet], datasets };
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let rows = resp.sheets.into_iter().next().unwrap().rows;
        let got: Vec<String> = rows
            .iter()
            .map(|r| r.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join(" | "))
            .collect();
        assert_eq!(got, vec!["月份 | 金额", "2月 | 450", "1月 | 250", "3月 | "], "{got:#?}");
    }

    /// `expand_expr` 写坏了要**报错**，不能静默当空数组。
    ///
    /// 静默的后果是作者以为自己写的东西生效了（报表少了几行却没有任何提示），
    /// 这比直接报错难查得多。
    #[test]
    fn expand_expr_写错时告警而不是静默() {
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), cross_tab_data());

        let mk = |expand_expr: Option<&str>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: Some("month".to_string()),
                agg: None,
                expand_type: Some(ExpandType::R),
                row_parent: None,
                col_parent: None,
                col_after: None,
                value_expr: None,
                expand_expr: expand_expr.map(|s| s.to_string()),
                expand_min_count: None,
                expand_max_count: None,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
                join_on: None,
            })
        };
        let sheet = SheetTpl {
            name: "t".into(),
            page: None,
            rows: vec![RowTpl {
                cells: vec![CellTpl {
                    pos: None,
                    value: None,
                    model: mk(Some("B9")), // 不是数组字面量：格引用在展开期无意义
                    merge_across: 0,
                    merge_down: 0,
                    merge_to_end: false,
                }],
            }],
            loop_field: None,
        };
        let tpl = ReportTemplate { sheets: vec![sheet], datasets };
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let w = resp.warnings.unwrap_or_default().join("\n");
        assert!(w.contains("expand_expr"), "应当告警 expand_expr，实际告警：{w:?}");
    }




    /// 展开集为空时，子格**不能**退回挂根拿全量数据算合计。
    ///
    /// 以前的坑：父格实例数为 0 → `by_pos` 里查不到 → 与「父格声明写错了」混为一谈
    /// → 退回挂根 → 子格拿到全量数据，算出一张「什么都没筛」的假合计（实测 700）。
    /// 这个数字看着像真的，比直接报错难查得多。
    ///
    /// 触发方式不止一种：`expand_max_count: 0`、数据被筛空、写坏的 `expand_expr`
    /// 都会走到这条路上，所以这里用一个与 `expand_expr` 无关的触发器。
    #[test]
    fn 展开集为空时子格不算全量合计() {
        let mk = |field: Option<&str>,
                  expand: Option<ExpandType>,
                  row_parent: Option<&str>,
                  max: Option<usize>,
                  agg: Option<AggType>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg,
                expand_type: expand,
                row_parent: row_parent.map(|s| s.to_string()),
                col_parent: None,
                col_after: None,
                value_expr: None,
                expand_expr: None,
                expand_min_count: None,
                expand_max_count: max,
                keep_expand_empty: None,
                format: None,
                format_expr: None,
                dict: None,
                row_test_expr: None,
                col_test_expr: None,
                export_formula: None,
                join_on: None,
            })
        };
        let run = |max: Option<usize>| {
            let mut datasets = BTreeMap::new();
            datasets.insert("ds1".to_string(), cross_tab_data());
            let sheet = SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: vec![
                        CellTpl {
                            pos: None,
                            value: None,
                            model: mk(Some("month"), Some(ExpandType::R), None, max, None),
                            merge_across: 0,
                            merge_down: 0,
                            merge_to_end: false,
                        },
                        CellTpl {
                            pos: None,
                            value: None,
                            model: mk(Some("amount"), None, Some("A1"), None, Some(AggType::Sum)),
                            merge_across: 0,
                            merge_down: 0,
                            merge_to_end: false,
                        },
                    ],
                }],
                loop_field: None,
            };
            let resp = render(RenderRequest {
                template: ReportTemplate { sheets: vec![sheet], datasets },
                datasets: None,
                sources: None,
                dump: None,
            })
            .unwrap();
            resp.sheets[0]
                .rows
                .iter()
                .map(|r| r.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join(" | "))
                .collect::<Vec<_>>()
        };
        // 先确认这个模板本身是好的，否则下面那条断言是空转
        assert_eq!(run(None), vec!["1月 | 250", "2月 | 450"]);
        // 展开成 0 条：只剩引擎给空表保底的那一行（`total_rows.max(1)`）。
        // 关键是**不能**出现全量合计 —— 那才是这个坑真正的危害。
        assert_eq!(run(Some(0)), vec![""], "子格退回挂根会算出全量合计（700）");
    }


    /// 列轴的同一个坑：列主格展开成 0 条时，数值格不能退回挂根算出「整行合计」。
    ///
    /// 复用现成的交叉表模板，只把月份列展开格（B2）的条数上限改成 0。
    /// 修好之前，数值格 B3 会挂根拿到华东的全量 300（100+200）；
    /// 修好之后它应该没有列可落，留空。
    #[test]
    fn 列主格展开为空时数值格不算整行合计() {
        let mut tpl = cross_tab_totals_template();
        // B2 = 行 2 的月份列展开格
        let b2 = tpl.sheets[0].rows[1].cells[1].model.as_mut().expect("B2 应有 model");
        b2.expand_max_count = Some(0);
        let resp = render(RenderRequest { template: tpl, datasets: None, sources: None, dump: None }).unwrap();
        let got: Vec<String> = resp.sheets[0]
            .rows
            .iter()
            .map(|r| r.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join(" | "))
            .collect();
        //
        // 探针实测出的回归形态：不是「整行合计 300」，而是数值格挂根后
        // 凭空多出一列 100（华东 1 月的值被当成整行的值）。所以断言整行。
        let huadong_row = got.iter().find(|l| l.starts_with("华东")).expect("应有华东行：{got:?}");
        assert_eq!(huadong_row, "华东 |  | 0", "数值格退回挂根会凭空造出月份列：{got:#?}");
    }


    /// 自己声明自己当主格（自引用）时，仍按「父格查不到」退回挂根，
    /// **不能**走「主格展开成 0 条」那条 —— 后者会让整张表悄悄渲染成空的。
    ///
    /// 现成模板里真有这种写法（测试 helper 把 `row_parent` 硬编码成 A1，
    /// 而 A1 自己就是那个展开格），它原先就是靠「父格查不到 → 退回挂根」跑通的。
    /// 所以引擎里必须显式放过 `p == pos`，这条测试就是守住那个分支。
    #[test]
    fn 自引用主格退回挂根而不是整表变空() {
        let mk = |month: i64, amount: f64| {
            let mut r = DataRow::new();
            r.insert("month".into(), JsonValue::from(month));
            r.insert("amount".into(), JsonValue::from(amount));
            r
        };
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), vec![mk(1, 100.0), mk(2, 200.0), mk(3, 400.0)]);
        let m = |field: Option<&str>, expand: bool, agg: Option<AggType>| {
            Some(CellModel {
                ds: Some("ds1".to_string()),
                field: field.map(|s| s.to_string()),
                agg,
                expand_type: if expand { Some(ExpandType::R) } else { None },
                row_parent: Some("A1".to_string()), // 自引用：A1 把自己当主格
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
                join_on: None,
            })
        };
        let sheet = SheetTpl {
            name: "t".into(),
            page: None,
            rows: vec![RowTpl {
                cells: vec![
                    CellTpl {
                        pos: None,
                        value: None,
                        model: m(Some("month"), true, None),
                        merge_across: 0,
                        merge_down: 0,
                        merge_to_end: false,
                    },
                    CellTpl {
                        pos: None,
                        value: None,
                        model: m(Some("amount"), false, Some(AggType::Sum)),
                        merge_across: 0,
                        merge_down: 0,
                        merge_to_end: false,
                    },
                ],
            }],
            loop_field: None,
        };
        let resp = render(RenderRequest {
            template: ReportTemplate { sheets: vec![sheet], datasets },
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let text = lines(&resp.sheets[0].rows);
        assert_eq!(text, vec!["1 | 100", "2 | 200", "3 | 400"], "{text:#?}");
        // 走的是「父格查不到」那条路，所以必须有告警 —— 自引用是模板问题，不能静默
        let w = resp.warnings.unwrap_or_default().join("\n");
        assert!(w.contains("row_parent"), "自引用应当告警，实际：{w:?}");
    }


    /// 一行 N 格，每格只写 `value_expr`（不绑字段、不展开），用来隔离测表达式本身
    fn expr_row(exprs: &[&str]) -> ReportTemplate {
        let mut datasets = BTreeMap::new();
        datasets.insert("ds1".to_string(), json_rows(vec![serde_json::json!({"a": 1})]));
        ReportTemplate {
            sheets: vec![SheetTpl {
                name: "t".into(),
                page: None,
                rows: vec![RowTpl {
                    cells: exprs
                        .iter()
                        .map(|e| CellTpl {
                            pos: None,
                            value: None,
                            model: Some(CellModel {
                                ds: Some("ds1".into()),
                                value_expr: Some((*e).to_string()),
                                ..Default::default()
                            }),
                            ..Default::default()
                        })
                        .collect(),
                }],
                loop_field: None,
            }],
            datasets,
        }
    }

    #[test]
    fn assign_binds_a_value_the_rest_of_the_sheet_can_read() {
        // 前一格 assign，后一格用裸名字引用 —— 这就是「变量式 assign」的主链路
        let resp = render(RenderRequest {
            template: expr_row(&[r#"assign("rate", 2)"#, "rate * 5"]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert!(
            resp.warnings.clone().unwrap_or_default().is_empty(),
            "不该有告警: {:?}",
            resp.warnings
        );
        let got = cell_texts(&resp.sheets[0].rows);
        assert_eq!(got, vec![vec!["2", "10"]], "{got:#?}");
    }

    #[test]
    fn assign_returns_the_value_so_it_composes() {
        // 返回被赋的值，所以能直接嵌进更大的表达式
        let resp = render(RenderRequest {
            template: expr_row(&[r#"assign("x", 3) + 1"#]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let got = cell_texts(&resp.sheets[0].rows);
        assert_eq!(got, vec![vec!["4"]], "{got:#?}");
    }

    #[test]
    fn unknown_variable_warns_instead_of_silently_being_null() {
        // 变量名写错却静默当 0 用，正是本项目一直在抓的那类静默失败
        let resp = render(RenderRequest {
            template: expr_row(&["nope * 2"]),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("nope"), "告警要点名变量: {w}");
        assert!(w.contains("assign"), "要提示用 assign 赋值: {w}");
    }

    #[test]
    fn names_that_look_like_cells_are_still_cell_refs() {
        // 守住 is_cell_name 的判据：`A1` 必须还是格子引用。
        // 它若被当成变量，这里会变成「告警 + 出空」而不是 10
        let mut tpl = expr_row(&["A1 * 2"]);
        tpl.sheets[0].rows[0].cells.insert(
            0,
            CellTpl {
                pos: None,
                value: Some(JsonValue::from(5)),
                model: None,
                ..Default::default()
            },
        );
        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert!(
            resp.warnings.clone().unwrap_or_default().is_empty(),
            "A1 应仍是格子: {:?}",
            resp.warnings
        );
        let got = cell_texts(&resp.sheets[0].rows);
        assert_eq!(got, vec![vec!["5", "10"]], "{got:#?}");
    }

    #[test]
    fn variables_do_not_leak_between_sheets() {
        // 变量是**本 sheet 作用域**：第二张表不该看到第一张表的赋值
        let mut tpl = expr_row(&[r#"assign("k", 7)"#]);
        tpl.sheets.push(SheetTpl {
            name: "第二张".into(),
            page: None,
            rows: vec![RowTpl {
                cells: vec![CellTpl {
                    pos: None,
                    value: None,
                    model: Some(CellModel {
                        ds: Some("ds1".into()),
                        value_expr: Some("k".to_string()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }],
            }],
            loop_field: None,
        });
        let resp = render(RenderRequest {
            template: tpl,
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("k"), "第二张表引用 k 应告警（没漏过来）: {w}");
        let got = cell_texts(&resp.sheets[1].rows);
        assert_eq!(got, vec![vec![""]], "第二张表不该看到 7: {got:#?}");
    }

    /// NopReport 官方函数名是 `AVERAGE`，我们内部实现叫 `AVG` —— 两个名字必须等价，
    /// 否则照官方文档写的模板在我们这里会**静默出空**。
    ///
    /// 更普遍的问题：`eval_call` 最后是 `_ => Val::Null`，任何认不出的函数名
    /// （拼错、或用了我们没实现的官方函数）都只是「格子空白」，作者只会以为没数据。
    /// 出空可以，但**必须可见** —— 与 `ACCSUM` 的「不支持就记一笔」同一套规矩。
    #[test]
    fn average_aliases_avg_and_unknown_func_warns() {
        let avg = render_yoy("AVG(C1)", None);
        let average = render_yoy("AVERAGE(C1)", None);
        assert_eq!(avg[0][3].text, "177.50", "AVG 基准值");
        assert_eq!(
            average[0][3].text, avg[0][3].text,
            "AVERAGE 是官方名，应与 AVG 等价；实际出空说明它落进了未知函数分支"
        );

        let resp = render(RenderRequest {
            template: yoy_template("BOGUSFUNC(C1)", None),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("BOGUSFUNC"), "认不出的函数名应告警，实际: {w:?}");
    }

    /// 集合函数 + lambda —— 把「怎么遍历」的复杂度从引擎挪到表达式层。
    ///
    /// 明细是 100 / 200 / 150 / 260（合计 710）。三条各走一条不同的路径：
    /// `MAP` 产出**值列表**、`FILTER` 保留**格实例**（所以 `.sum()` 还能用格集口径）、
    /// `REDUCE` 折叠成标量。
    #[test]
    fn collection_funcs_with_lambda() {
        let cell = |expr: &str| render_yoy(expr, None)[0][3].text.clone();
        assert_eq!(cell("REDUCE(C1, (acc, x) => acc + x, 0)"), "710", "求和");
        // 列表要能被聚合函数接着吃，否则 MAP 出来就没法用
        assert_eq!(cell("SUM(MAP(C1, x => x * 2))"), "1,420", "2 倍后求和");
        // >150 的只有 200 与 260
        assert_eq!(cell("SUM(FILTER(C1, x => x > 150))"), "460", "筛选后求和");
    }

    /// `FLATMAP` 与**候选格上下文** —— lambda 深化之后多出来的两件事。
    ///
    /// 候选格上下文这条最容易写错：lambda 体里的裸 `C1` 必须是**当前候选格**的 C1，
    /// 而不是「写这个表达式的那一格」的 C1。写错的表现很隐蔽：不报错，
    /// 只是 4 个元素取到同一个值（下面第一个断言若退化会是 400）。
    #[test]
    fn flatmap_and_candidate_cell_context() {
        let cell = |expr: &str| render_yoy(expr, None)[0][3].text.clone();
        assert_eq!(cell("SUM(MAP(C1, x => C1))"), "710", "候选格上下文");
        // 一个元素产出两个，摊平一层后再聚合
        assert_eq!(cell("SUM(FLATMAP(C1, x => [x, x]))"), "1,420", "flatMap 摊平");
        assert_eq!(cell("COUNT(FLATMAP(C1, x => [x, x]))"), "8", "元素个数 4 → 8");
    }

    /// lambda 单独出现（没有套集合函数）是**表达式写错了**：出空可以，但必须告警，
    /// 否则作者只看到一格空白，不会想到自己漏了 `MAP` / `REDUCE`。
    #[test]
    fn standalone_lambda_warns_instead_of_silently_blank() {
        let resp = render(RenderRequest {
            template: yoy_template("x => x * 2", None),
            datasets: None,
            sources: None,
            dump: None,
        })
        .unwrap();
        assert_eq!(resp.sheets[0].rows[0][3].text, "", "lambda 单独写应出空");
        let w = resp.warnings.clone().unwrap_or_default().join("\n");
        assert!(w.contains("lambda"), "应告警，实际: {w:?}");
    }
}

