//! GET /api/data/* —— 数据库探索与取数（对齐前端 ClientDataListResponse / ClientRowsResponse）
//!
//! - sqlite：rusqlite 只读打开（SQLITE_OPEN_READ_ONLY），绝不写库
//! - postgres：见 `db_pg.rs`（只读会话 + information_schema）
//! - odbc：暂未实现，返回明确 ok:false
//! - 数据库来源：print-server.json connections + scanDirs 自动发现
//! - 标识符安全：表/字段先经 sqlite_master / table_info 白名单校验，再双引号转义拼接
//! - POST /api/data/rows 支持 where + params 参数化筛选（sqlite 占位符 ?；postgres 见 db_pg.rs）

use crate::config::DbConnection;
use crate::report::model::DataRow;
use crate::util::service_error;
use crate::AppState;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

pub const ROWS_DEFAULT_LIMIT: i64 = 100;
pub const ROWS_MAX_LIMIT: i64 = 1000;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DataQuery {
    pub conn_id: Option<String>,
    pub engine: Option<String>,
    pub database: Option<String>,
    pub table: Option<String>,
    pub fields: Option<String>,
    pub limit: Option<i64>,
    /// POST 专用：WHERE 子句（不含 WHERE 关键字，占位符 ?）
    pub r#where: Option<String>,
    /// POST 专用：与 where 占位符按序对应的参数
    pub params: Option<Vec<serde_json::Value>>,
}

/* ------------------------------ 连接解析 ------------------------------ */

/// 解析出的目标连接
enum Target {
    Sqlite(PathBuf),
    Postgres(DbConnection),
}

/// 内联配置（请求里直接给 database + engine）→ 目标
fn finish_engine(engine: &str, database: Option<String>, _dsn: Option<String>) -> Result<Target, String> {
    match engine {
        "sqlite" => {
            let p = database
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| "sqlite 连接缺少 path".to_string())?;
            Ok(Target::Sqlite(PathBuf::from(p)))
        }
        "postgres" | "postgresql" | "pgsql" | "pg" => {
            // 内联用法：database 直接给连接串（postgres://...），无 url 时按分项拼装
            let url = database.filter(|s| !s.trim().is_empty()).ok_or_else(|| {
                "postgres 内联连接缺少连接串（database 参数）".to_string()
            })?;
            let mut c = DbConnection::default();
            c.id = url.clone();
            c.engine = "postgres".into();
            c.url = Some(url);
            Ok(Target::Postgres(c))
        }
        "odbc" => Err(
            "ODBC 引擎暂未实现（Rust 版客户端），请改用 sqlite / postgres，或使用原 Qt 客户端".to_string(),
        ),
        other => Err(format!("未知数据库引擎: {other}")),
    }
}

/// 配置连接 → 目标
fn conn_to_target(c: DbConnection) -> Result<Target, String> {
    match c.norm_engine() {
        "postgres" => Ok(Target::Postgres(c)),
        "odbc" => Err(
            "ODBC 引擎暂未实现（Rust 版客户端），请改用 sqlite / postgres，或使用原 Qt 客户端".to_string(),
        ),
        _ => {
            let p = c
                .path
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("sqlite 连接「{}」缺少 path", c.id))?;
            Ok(Target::Sqlite(PathBuf::from(p)))
        }
    }
}

/// 解析目标连接：connId 精确匹配 → database 按配置条目名反查 → 内联 engine+database → 缺省首条
fn resolve_target(state: &AppState, q: &DataQuery) -> Result<Target, String> {
    // 1. connId 精确匹配配置连接
    if let Some(conn_id) = q.conn_id.as_deref().filter(|s| !s.is_empty()) {
        let conns = state.config.read().unwrap().connections.clone();
        let Some(c) = conns.into_iter().find(|c| c.id == conn_id) else {
            return Err(format!("未找到连接 id「{conn_id}」，请检查 print-server.json"));
        };
        return conn_to_target(c);
    }

    // 2. database 参数：先按配置条目名反查（postgres / odbc / 显式 sqlite 连接都走这里）
    if let Some(db) = q.database.as_deref().filter(|s| !s.is_empty()) {
        let found = state.config.read().unwrap().find_by_entry_name(db);
        if let Some(c) = found {
            return conn_to_target(c);
        }
        // 未命中配置：按内联配置处理（sqlite 文件路径 / postgres 连接串）
        let engine = q.engine.as_deref().unwrap_or("sqlite");
        return finish_engine(engine, Some(db.to_string()), None);
    }

    // 3. 缺省：配置里第一条非 odbc 连接，或扫描发现的第一条 sqlite
    let first = state
        .config
        .read()
        .unwrap()
        .connections
        .iter()
        .find(|c| c.norm_engine() != "odbc")
        .cloned();
    if let Some(c) = first {
        return conn_to_target(c);
    }
    let entries = state.config.read().unwrap().list_databases();
    if let Some(e) = entries.iter().find(|e| e.engine == "sqlite") {
        return Ok(Target::Sqlite(PathBuf::from(&e.name)));
    }
    Err(
        "未配置数据库：请在 print-server.json 的 connections/scanDirs 里配置，\
         或请求时带 database 参数（sqlite 文件绝对路径 / postgres 连接串）"
            .to_string(),
    )
}

fn open_readonly(path: &PathBuf) -> Result<Connection, String> {
    if !path.exists() {
        return Err(format!("sqlite 文件不存在: {}", path.display()));
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开 sqlite 失败（{}）: {e}", path.display()))
}

fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// 表是否存在（table 或 view）
fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1 AND type IN ('table','view')",
        [&table],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| format!("校验表失败: {e}"))
}

/// PRAGMA table_info 白名单字段
fn table_columns(conn: &Connection, table: &str) -> Result<Vec<ColumnMeta>, String> {
    let sql = format!("PRAGMA table_info({})", quote_ident(table));
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取表结构失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ColumnMeta {
                name: row.get::<_, String>(1)?,
                col_type: row.get::<_, String>(2).unwrap_or_default(),
                notnull: row.get::<_, i64>(3).unwrap_or(0) != 0,
                dflt: row.get::<_, rusqlite::types::Value>(4).ok(),
                pk: row.get::<_, i64>(5).unwrap_or(0),
            })
        })
        .map_err(|e| format!("读取表结构失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("{e}"))
}

#[derive(Debug, Clone)]
struct ColumnMeta {
    name: String,
    col_type: String,
    notnull: bool,
    dflt: Option<SqlValue>,
    pk: i64,
}

/// 单列 UNIQUE（origin='u' 自动索引）→ key:"UNI"
fn unique_single_columns(conn: &Connection, table: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let sql = format!("PRAGMA index_list({})", quote_ident(table));
    let Ok(mut stmt) = conn.prepare(&sql) else { return out };
    let Ok(idx_rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, i64>(2).unwrap_or(0),
            row.get::<_, String>(3).unwrap_or_default(),
        ))
    }) else {
        return out;
    };
    let indexes: Vec<(String, i64, String)> =
        idx_rows.filter_map(Result::ok).collect();
    for (iname, unique, _origin) in indexes {
        // unique=1 即标记 UNI；origin 只区分 'u'(UNIQUE 约束) / 'c'(CREATE INDEX)，两者都算
        if unique != 1 {
            continue;
        }
        let Ok(mut si) = conn.prepare(&format!("PRAGMA index_info({})", quote_ident(&iname)))
        else {
            continue;
        };
        let Ok(cols) = si.query_map([], |row| row.get::<_, String>(2)) else {
            continue;
        };
        let cols: Vec<String> = cols.filter_map(Result::ok).collect();
        if cols.len() == 1 {
            out.insert(cols[0].clone());
        }
    }
    out
}

/* ------------------------------ handlers ------------------------------ */

/// GET /api/data/databases
pub async fn databases(State(state): State<AppState>) -> Response {
    let entries = state.config.read().unwrap().list_databases();
    let arr: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|e| json!({ "name": e.name, "engine": e.engine, "label": e.label }))
        .collect();
    (axum::Json(json!({ "ok": true, "databases": arr }))).into_response()
}

/// GET /api/data/tables
pub async fn tables(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let dq = DataQuery {
        conn_id: q.get("connId").cloned(),
        engine: q.get("engine").cloned(),
        database: q.get("database").cloned(),
        ..Default::default()
    };
    match resolve_target(&state, &dq).map_err(service_error) {
        Ok(Target::Sqlite(path)) => run_tables_sqlite(&path),
        Ok(Target::Postgres(conn)) => crate::db_pg::tables(&conn).await,
        Err(resp) => resp,
    }
}

fn run_tables_sqlite(path: &PathBuf) -> Response {
    let conn = match open_readonly(path).map_err(service_error) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let mut stmt = match conn.prepare(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
         ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
    ) {
        Ok(s) => s,
        Err(e) => return service_error(format!("列表失败: {e}")),
    };
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "name": row.get::<_, String>(0).unwrap_or_default(),
            "type": row.get::<_, String>(1).unwrap_or_default(),
        }))
    });
    match rows {
        Ok(iter) => {
            let tables: Vec<serde_json::Value> = iter.filter_map(Result::ok).collect();
            (axum::Json(json!({ "ok": true, "tables": tables }))).into_response()
        }
        Err(e) => service_error(format!("列表失败: {e}")),
    }
}

/// GET /api/data/columns
pub async fn columns(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let dq = DataQuery {
        conn_id: q.get("connId").cloned(),
        engine: q.get("engine").cloned(),
        database: q.get("database").cloned(),
        table: q.get("table").cloned(),
        ..Default::default()
    };
    run_columns(&state, &dq).await.unwrap_or_else(|r| r)
}

async fn run_columns(state: &AppState, dq: &DataQuery) -> Result<Response, Response> {
    let target = resolve_target(state, dq).map_err(service_error)?;
    let table = dq
        .table
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| service_error("缺少 table 参数"))?;
    match target {
        Target::Sqlite(path) => run_columns_sqlite(&path, table),
        Target::Postgres(conn) => Ok(crate::db_pg::columns(&conn, table).await),
    }
}

fn run_columns_sqlite(path: &PathBuf, table: &str) -> Result<Response, Response> {
    let conn = open_readonly(path).map_err(service_error)?;
    if !table_exists(&conn, table).map_err(service_error)? {
        return Err(service_error(format!("表「{table}」不存在")));
    }
    let cols = table_columns(&conn, table).map_err(service_error)?;
    let uni = unique_single_columns(&conn, table);
    let arr: Vec<serde_json::Value> = cols
        .iter()
        .map(|c| {
            let key = if c.pk > 0 {
                "PRI"
            } else if uni.contains(&c.name) {
                "UNI"
            } else {
                ""
            };
            json!({
                "name": c.name,
                "type": if c.col_type.is_empty() { "TEXT".to_string() } else { c.col_type.clone() },
                "nullable": !c.notnull,
                "primary": c.pk > 0,
                "key": key,
                "default": value_to_opt_string(&c.dflt),
            })
        })
        .collect();
    Ok((axum::Json(json!({ "ok": true, "columns": arr }))).into_response())
}

/// GET /api/data/rows
pub async fn rows_get(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let dq = DataQuery {
        conn_id: q.get("connId").cloned(),
        engine: q.get("engine").cloned(),
        database: q.get("database").cloned(),
        table: q.get("table").cloned(),
        fields: q.get("fields").cloned(),
        limit: q.get("limit").and_then(|s| s.parse().ok()),
        ..Default::default()
    };
    run_rows(&state, &dq).await.unwrap_or_else(|r| r)
}

/// POST /api/data/rows（where + params 参数化）
pub async fn rows_post(
    State(state): State<AppState>,
    axum::Json(dq): axum::Json<DataQuery>,
) -> Response {
    run_rows(&state, &dq).await.unwrap_or_else(|r| r)
}

async fn run_rows(state: &AppState, dq: &DataQuery) -> Result<Response, Response> {
    let target = resolve_target(state, dq).map_err(service_error)?;
    let table = dq
        .table
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| service_error("缺少 table 参数"))?;
    match target {
        Target::Sqlite(path) => run_rows_sqlite(&path, dq, table),
        Target::Postgres(conn) => {
            let params = dq.params.as_deref().unwrap_or(&[]);
            Ok(crate::db_pg::rows(
                &conn,
                table,
                dq.fields.as_deref(),
                dq.limit,
                dq.r#where.as_deref(),
                params,
            )
            .await)
        }
    }
}

/// sqlite 取数的内部实现：(行, 总数, 选中列)，错误为 String（供报表引擎复用）
fn fetch_rows_sqlite(
    path: &PathBuf,
    dq: &DataQuery,
    table: &str,
    max_limit: Option<i64>,
) -> Result<(Vec<serde_json::Map<String, serde_json::Value>>, i64, Vec<String>), String> {
    let conn = open_readonly(path)?;
    if !table_exists(&conn, table)? {
        return Err(format!("表「{table}」不存在"));
    }
    let meta = table_columns(&conn, table)?;
    let valid: std::collections::HashSet<&str> =
        meta.iter().map(|c| c.name.as_str()).collect();

    // 字段白名单（fields 缺省取全部列，按表结构顺序）
    let selected: Vec<String> = match dq.fields.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(f) => {
            let names: Vec<String> = f
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            for n in &names {
                if !valid.contains(n.as_str()) {
                    return Err(format!("未知字段「{n}」，已拒绝（防注入）"));
                }
            }
            names
        }
        None => meta.iter().map(|c| c.name.clone()).collect(),
    };

    let limit = dq
        .limit
        .unwrap_or(ROWS_DEFAULT_LIMIT)
        .clamp(1, max_limit.unwrap_or(ROWS_MAX_LIMIT));
    let where_clause = dq.r#where.as_deref().filter(|s| !s.trim().is_empty());
    let sql_params: Vec<SqlValue> = dq
        .params
        .as_ref()
        .map(|v| v.iter().map(json_to_sql).collect())
        .unwrap_or_default();

    // total（含 where）
    let count_sql = match where_clause {
        Some(w) => format!(
            "SELECT COUNT(*) FROM {} WHERE ({})",
            quote_ident(table),
            w
        ),
        None => format!("SELECT COUNT(*) FROM {}", quote_ident(table)),
    };
    let total: i64 = conn
        .query_row(
            &count_sql,
            rusqlite::params_from_iter(sql_params.iter()),
            |r| r.get(0),
        )
        .map_err(|e| format!("统计行数失败: {e}"))?;

    let field_list = selected
        .iter()
        .map(|s| quote_ident(s))
        .collect::<Vec<_>>()
        .join(", ");
    let rows_sql = match where_clause {
        Some(w) => format!(
            "SELECT {} FROM {} WHERE ({}) LIMIT {}",
            field_list,
            quote_ident(table),
            w,
            limit
        ),
        None => format!(
            "SELECT {} FROM {} LIMIT {}",
            field_list,
            quote_ident(table),
            limit
        ),
    };

    let mut stmt = conn.prepare(&rows_sql).map_err(|e| format!("取数失败: {e}"))?;
    let col_names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect();
    let iter = stmt
        .query_map(rusqlite::params_from_iter(sql_params.iter()), |row| {
            let mut m = serde_json::Map::new();
            for (i, name) in col_names.iter().enumerate() {
                let v = row.get_ref(i)?.to_owned();
                m.insert(name.clone(), sql_to_json(&v));
            }
            Ok(m)
        })
        .map_err(|e| format!("取数失败: {e}"))?;

    let rows: Vec<serde_json::Map<String, serde_json::Value>> =
        iter.filter_map(|r| r.ok()).collect();
    Ok((rows, total, selected))
}

fn run_rows_sqlite(path: &PathBuf, dq: &DataQuery, table: &str) -> Result<Response, Response> {
    let (rows, total, selected) =
        fetch_rows_sqlite(path, dq, table, None).map_err(service_error)?;
    let rows: Vec<serde_json::Value> = rows.into_iter().map(serde_json::Value::Object).collect();
    Ok((axum::Json(json!({
        "ok": true,
        "database": path.to_string_lossy(),
        "table": table,
        "total": total,
        "rows": rows,
        "columns": selected,
    })))
    .into_response())
}

/* --------------------- 报表引擎取数（非 HTTP） --------------------- */

/// 报表数据源的取数上限：比 /api/data/rows 的默认上限宽松，避免大表被截断
pub const REPORT_MAX_ROWS: i64 = 100_000;

/// 供报表引擎调用：与 /api/data/rows 同一套连接解析 + 字段白名单校验，直接返回数据行
pub async fn query_rows(state: &AppState, q: &DataQuery) -> Result<Vec<DataRow>, String> {
    let target = resolve_target(state, q)?;
    let table = q
        .table
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少 table 参数".to_string())?;
    let out: Vec<serde_json::Map<String, serde_json::Value>> = match target {
        Target::Sqlite(path) => fetch_rows_sqlite(&path, q, table, Some(REPORT_MAX_ROWS))?.0,
        Target::Postgres(conn) => {
            let params = q.params.as_deref().unwrap_or(&[]);
            let (rows, _total, _display) = crate::db_pg::fetch_rows(
                &conn,
                table,
                q.fields.as_deref(),
                q.limit,
                q.r#where.as_deref(),
                params,
                Some(REPORT_MAX_ROWS),
            )
            .await?;
            rows.into_iter()
                .filter_map(|v| match v {
                    serde_json::Value::Object(m) => Some(m),
                    _ => None,
                })
                .collect()
        }
    };
    Ok(out
        .into_iter()
        .map(|m| m.into_iter().collect::<BTreeMap<String, serde_json::Value>>())
        .collect())
}

/* ------------------------------ 值转换 ------------------------------ */

fn sql_to_json(v: &ValueRef<'_>) -> serde_json::Value {
    match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => {
            use base64::Engine;
            json!(base64::engine::general_purpose::STANDARD.encode(b))
        }
    }
}

fn value_to_opt_string(v: &Option<SqlValue>) -> Option<String> {
    match v {
        None | Some(SqlValue::Null) => None,
        Some(SqlValue::Integer(i)) => Some(i.to_string()),
        Some(SqlValue::Real(f)) => Some(f.to_string()),
        Some(SqlValue::Text(t)) => Some(t.clone()),
        Some(SqlValue::Blob(b)) => Some(String::from_utf8_lossy(b).to_string()),
    }
}

fn json_to_sql(v: &serde_json::Value) -> SqlValue {
    match v {
        serde_json::Value::Null => SqlValue::Null,
        serde_json::Value::Bool(b) => SqlValue::Integer(*b as i64),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL DEFAULT 0);
            CREATE UNIQUE INDEX uq_name ON orders(name);
            INSERT INTO orders(name, amount) VALUES ('甲', 12.5), ('乙', 7.0), ('丙', 99.0);
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn table_columns_and_keys() {
        let conn = demo_conn();
        assert!(table_exists(&conn, "orders").unwrap_or(false));
        let cols = table_columns(&conn, "orders").unwrap_or_default();
        assert_eq!(cols.len(), 3);
        assert_eq!(cols[0].name, "id");
        assert_eq!(cols[0].pk, 1);
        let uni = unique_single_columns(&conn, "orders");
        assert!(uni.contains("name"));
    }

    #[test]
    fn value_conversion_roundtrip() {
        assert_eq!(sql_to_json(&ValueRef::Integer(42)), json!(42));
        assert_eq!(sql_to_json(&ValueRef::Real(1.5)), json!(1.5));
        assert_eq!(sql_to_json(&ValueRef::Text(b"hi")), json!("hi"));
        assert_eq!(sql_to_json(&ValueRef::Null), serde_json::Value::Null);
        assert_eq!(json_to_sql(&json!("x")), SqlValue::Text("x".into()));
        assert_eq!(json_to_sql(&json!(7)), SqlValue::Integer(7));
        assert_eq!(json_to_sql(&json!(true)), SqlValue::Integer(1));
    }

    #[test]
    fn ident_quoting() {
        assert_eq!(quote_ident("or\"der"), "\"or\"\"der\"");
    }
}
