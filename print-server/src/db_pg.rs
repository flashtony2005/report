//! GET/POST /api/data/* 的 postgres 分支
//!
//! - 只读：连接后立即 `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`，本会话内无法写库
//! - 元数据走 `information_schema`（含视图，兼容 `v_export_*` 这类业务视图）
//! - 标识符一律双引号转义（`"schema"."table"` / `"col"`），表名与字段名先过 information_schema 白名单
//! - 取值：原生解码 bool/int2/int4/int8/float4/float8/text 系列；其余类型（numeric/date/timestamp/
//!   uuid/json/bytea/数组…）在 SELECT 里 `::text` 转为字符串，避免引入额外类型依赖
//! - where 占位符：支持 `?`（会自动转成 `$1..$n`）与原生 `$n` 两种写法
//!
//! 连接信息见 `config::DbConnection`（`url` 或 host/port/user/password/dbname 分项）。

use crate::config::DbConnection;
use crate::util::service_error;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, NoTls, Row};

/// 与 db.rs 保持一致的行数上限
const ROWS_MAX_LIMIT: i64 = 1000;

/* ------------------------------ 连接 ------------------------------ */

/// 真正建连（返回 String 错误，便于 admin 试连复用）
pub async fn connect_impl(conn: &DbConnection) -> Result<Client, String> {
    let cfg = conn.pg_config()?;
    let (client, connection) = cfg
        .connect(NoTls)
        .await
        .map_err(|e| format!("连接 postgres 失败（{}）：{e}", conn.id))?;
    // 连接任务需常驻，否则 client 立刻失效
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
        .batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
        .await
        .map_err(|e| format!("设置 postgres 只读会话失败：{e}"))?;
    Ok(client)
}

async fn connect(conn: &DbConnection) -> Result<Client, Response> {
    connect_impl(conn).await.map_err(service_error)
}

/// 试连探针（admin 配置页用）：返回一句人类可读的成功摘要
pub async fn probe(conn: &DbConnection) -> Result<String, String> {
    let t0 = std::time::Instant::now();
    let client = connect_impl(conn).await?;
    let row = client
        .query_one(
            "SELECT current_database()::text, current_user::text, \
             current_setting('server_version')::text",
            &[],
        )
        .await
        .map_err(|e| format!("读取服务端信息失败：{e}"))?;
    let dbname: String = row.get(0);
    let user: String = row.get(1);
    let version: String = row.get(2);

    let schema = conn.schema_or_public();
    let tables: i64 = client
        .query_one(
            "SELECT COUNT(*)::int8 FROM information_schema.tables \
             WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
            &[&schema],
        )
        .await
        .map(|r| r.get(0))
        .unwrap_or(0);
    let views: i64 = client
        .query_one(
            "SELECT COUNT(*)::int8 FROM information_schema.views WHERE table_schema = $1",
            &[&schema],
        )
        .await
        .map(|r| r.get(0))
        .unwrap_or(0);

    Ok(format!(
        "连接成功：PostgreSQL {version}｜库 {dbname}｜账号 {user}｜schema「{schema}」{} 张表 / {} 个视图｜{} ms",
        tables,
        views,
        t0.elapsed().as_millis()
    ))
}

/* ------------------------------ 标识符 ------------------------------ */

fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// `"schema"."table"`
fn quote_qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

/// 表名可能是 `schema.table` 或裸表名（裸表名落到默认 schema）
fn split_table(table: &str, default_schema: &str) -> (String, String) {
    match table.split_once('.') {
        Some((s, t)) if !s.is_empty() && !t.is_empty() => (s.to_string(), t.to_string()),
        _ => (default_schema.to_string(), table.to_string()),
    }
}

/// 默认 schema 下的表不带前缀，其余带 `schema.` 前缀（前端原样回传作 table）
fn display_name(schema: &str, table: &str, default_schema: &str) -> String {
    if schema == default_schema {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    }
}

/* ------------------------------ 列元信息 ------------------------------ */

#[derive(Debug, Clone)]
struct PgCol {
    name: String,
    data_type: String,
    nullable: bool,
    dflt: Option<String>,
    pk: bool,
    uniq: bool,
}

/// 支持原生解码的类型（其余走 `::text`）
fn native_type(data_type: &str) -> bool {
    matches!(
        data_type,
        "boolean"
            | "smallint"
            | "integer"
            | "bigint"
            | "real"
            | "double precision"
            | "text"
            | "character varying"
            | "character"
            | "name"
    )
}

/// 读列元信息（顺带充当「表是否存在」的校验：空结果即不存在）
async fn list_columns(client: &Client, schema: &str, table: &str) -> Result<Vec<PgCol>, String> {
    let rows = client
        .query(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2 \
             ORDER BY ordinal_position",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("读取表结构失败：{e}"))?;

    if rows.is_empty() {
        return Err(format!(
            "表「{}」不存在或当前账号无权限",
            display_name(schema, table, schema)
        ));
    }

    // 主键列
    let pk_rows = client
        .query(
            "SELECT kcu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema = kcu.table_schema \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND tc.table_schema = $1 AND tc.table_name = $2",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("读取主键失败：{e}"))?;
    let pk: std::collections::HashSet<String> =
        pk_rows.iter().map(|r| r.get::<_, String>(0)).collect();

    // 单列 UNIQUE（多列联合唯一不标 UNI，与 sqlite 分支口径一致）
    let uq_rows = client
        .query(
            "SELECT kcu.column_name, tc.constraint_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema = kcu.table_schema \
             WHERE tc.constraint_type = 'UNIQUE' \
               AND tc.table_schema = $1 AND tc.table_name = $2",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("读取唯一约束失败：{e}"))?;
    let mut by_constraint: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &uq_rows {
        by_constraint
            .entry(r.get::<_, String>(1))
            .or_default()
            .push(r.get::<_, String>(0));
    }
    let uniq: std::collections::HashSet<String> = by_constraint
        .into_values()
        .filter(|cols| cols.len() == 1)
        .flatten()
        .collect();

    Ok(rows
        .iter()
        .map(|r| {
            let name: String = r.get(0);
            PgCol {
                pk: pk.contains(&name),
                uniq: uniq.contains(&name),
                name,
                data_type: r.get(1),
                nullable: r.get::<_, String>(2).eq_ignore_ascii_case("YES"),
                dflt: r.get::<_, Option<String>>(3),
            }
        })
        .collect())
}

/* ------------------------------ 取值 ------------------------------ */

/// 原生类型直接解码；其余类型已在 SELECT 里 `::text`
fn decode_cell(row: &Row, i: usize, data_type: &str) -> Value {
    macro_rules! as_val {
        ($t:ty, $conv:expr) => {
            match row.try_get::<_, Option<$t>>(i) {
                Ok(Some(v)) => $conv(v),
                _ => Value::Null,
            }
        };
    }
    match data_type {
        "boolean" => as_val!(bool, |v: bool| json!(v)),
        "smallint" => as_val!(i16, |v: i16| json!(v)),
        "integer" => as_val!(i32, |v: i32| json!(v)),
        "bigint" => as_val!(i64, |v: i64| json!(v)),
        "real" => as_val!(f32, |v: f32| json!(v as f64)),
        "double precision" => as_val!(f64, |v: f64| json!(v)),
        _ => as_val!(String, |v: String| json!(v)),
    }
}

/// `?` → `$1..$n`；已是 `$n` 风格则原样返回
fn to_pg_placeholders(w: &str) -> String {
    if !w.contains('?') {
        return w.to_string();
    }
    let mut n = 0usize;
    let mut out = String::with_capacity(w.len() + 8);
    for ch in w.chars() {
        if ch == '?' {
            n += 1;
            out.push_str(&format!("${n}"));
        } else {
            out.push(ch);
        }
    }
    out
}

/// 把 JSON 参数装箱成 tokio-postgres 可用的参数
///
/// 注意必须带 `Send`：handler 的 future 要满足 axum 的 `Handler`（需 Send），
/// 若这里只写 `dyn ToSql + Sync`，该 trait object 非 Send，future 整条不是 Send，路由注册直接编译不过。
fn boxed_params(params: &[Value]) -> Vec<Box<dyn ToSql + Sync + Send>> {
    params
        .iter()
        .map(|v| -> Box<dyn ToSql + Sync + Send> {
            match v {
                Value::Null => Box::new(Option::<String>::None),
                Value::Bool(b) => Box::new(*b),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        Box::new(i)
                    } else {
                        Box::new(n.as_f64().unwrap_or(0.0))
                    }
                }
                Value::String(s) => Box::new(s.clone()),
                other => Box::new(other.to_string()),
            }
        })
        .collect()
}

/* ------------------------------ handlers ------------------------------ */

/// 表 / 视图列表
pub async fn tables(conn: &DbConnection) -> Response {
    let client = match connect(conn).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    // 显式配了 schema 就只看该 schema；否则列全部非系统 schema
    let explicit: Option<String> = conn
        .schema
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let base = "SELECT table_schema, table_name, table_type \
                FROM information_schema.tables \
                WHERE table_type IN ('BASE TABLE','VIEW') \
                  AND table_schema NOT IN ('pg_catalog','information_schema') \
                  AND table_schema NOT LIKE 'pg\\_%'";
    let sql = match &explicit {
        Some(_) => format!("{base} AND table_schema = $1 ORDER BY table_name"),
        None => format!("{base} ORDER BY table_schema, table_name"),
    };
    // String 实现了 ToSql，故可安全收窄为 &(dyn ToSql + Sync)（借用 explicit，生命周期足够）
    let sql_params: Vec<&(dyn ToSql + Sync)> = match &explicit {
        Some(s) => vec![s as &(dyn ToSql + Sync)],
        None => vec![],
    };

    let rows = match client.query(&sql, &sql_params).await {
        Ok(r) => r,
        Err(e) => return service_error(format!("列表失败：{e}")),
    };
    let default_schema = conn.schema_or_public();
    let tables: Vec<Value> = rows
        .iter()
        .map(|r| {
            let schema: String = r.get(0);
            let name: String = r.get(1);
            let ttype: String = r.get(2);
            json!({
                "name": display_name(&schema, &name, &default_schema),
                "type": if ttype == "VIEW" { "view" } else { "table" },
            })
        })
        .collect();
    (axum::Json(json!({ "ok": true, "tables": tables }))).into_response()
}

/// 字段元信息
pub async fn columns(conn: &DbConnection, table: &str) -> Response {
    let client = match connect(conn).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let (schema, tbl) = split_table(table, &conn.schema_or_public());
    let cols = match list_columns(&client, &schema, &tbl).await.map_err(service_error) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let arr: Vec<Value> = cols
        .iter()
        .map(|c| {
            let key = if c.pk {
                "PRI"
            } else if c.uniq {
                "UNI"
            } else {
                ""
            };
            json!({
                "name": c.name,
                "type": c.data_type,
                "nullable": c.nullable,
                "primary": c.pk,
                "key": key,
                "default": c.dflt,
            })
        })
        .collect();
    (axum::Json(json!({ "ok": true, "columns": arr }))).into_response()
}

/// 取数的内部实现：返回 (行, 总数, 显示名)，错误为 String（供报表引擎等非 HTTP 调用方复用）
#[allow(clippy::too_many_arguments)]
pub async fn fetch_rows(
    conn: &DbConnection,
    table: &str,
    fields: Option<&str>,
    limit: Option<i64>,
    where_clause: Option<&str>,
    params: &[Value],
    max_limit: Option<i64>,
) -> Result<(Vec<Value>, i64, String), String> {
    let client = connect_impl(conn).await?;
    let (schema, tbl) = split_table(table, &conn.schema_or_public());
    let cols = list_columns(&client, &schema, &tbl).await?;

    // 字段白名单（fields 缺省取全部列，按表结构顺序）
    let selected: Vec<String> = match fields.map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) => {
            let names: Vec<String> = f
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            for n in &names {
                if !cols.iter().any(|c| &c.name == n) {
                    return Err(format!("未知字段「{n}」，已拒绝（防注入）"));
                }
            }
            names
        }
        None => cols.iter().map(|c| c.name.clone()).collect(),
    };

    // SELECT 列表：原生类型直取，其余 ::text（列别名回本名）
    let select_list = selected
        .iter()
        .map(|name| {
            let dt = cols
                .iter()
                .find(|c| &c.name == name)
                .map(|c| c.data_type.as_str())
                .unwrap_or("text");
            if native_type(dt) {
                quote_ident(name)
            } else {
                format!("{}::text AS {}", quote_ident(name), quote_ident(name))
            }
        })
        .collect::<Vec<_>>()
        .join(", ");

    let limit = limit
        .unwrap_or(100)
        .clamp(1, max_limit.unwrap_or(ROWS_MAX_LIMIT));
    let where_sql = where_clause.map(to_pg_placeholders);
    let boxed = boxed_params(params);
    // 去掉 Send（tokio-postgres 签名要 `&(dyn ToSql + Sync)`；auto trait 收窄是合法强制转换）
    let refs: Vec<&(dyn ToSql + Sync)> = boxed
        .iter()
        .map(|b| b.as_ref() as &(dyn ToSql + Sync))
        .collect();

    let target = quote_qualified(&schema, &tbl);
    let count_sql = match &where_sql {
        Some(w) => format!("SELECT COUNT(*) FROM {target} WHERE ({w})"),
        None => format!("SELECT COUNT(*) FROM {target}"),
    };
    let total: i64 = match client.query_one(&count_sql, &refs).await {
        Ok(r) => r.get(0),
        Err(e) => return Err(format!("统计行数失败：{e}")),
    };

    let rows_sql = match &where_sql {
        Some(w) => format!("SELECT {select_list} FROM {target} WHERE ({w}) LIMIT {limit}"),
        None => format!("SELECT {select_list} FROM {target} LIMIT {limit}"),
    };
    let pg_rows = match client.query(&rows_sql, &refs).await {
        Ok(r) => r,
        Err(e) => return Err(format!("取数失败：{e}")),
    };

    let out: Vec<Value> = pg_rows
        .iter()
        .map(|row| {
            let mut m = serde_json::Map::new();
            for (i, name) in selected.iter().enumerate() {
                let dt = cols
                    .iter()
                    .find(|c| &c.name == name)
                    .map(|c| c.data_type.as_str())
                    .unwrap_or("text");
                m.insert(name.clone(), decode_cell(row, i, dt));
            }
            Value::Object(m)
        })
        .collect();

    Ok((out, total, display_name(&schema, &tbl, &conn.schema_or_public())))
}

/// 取数（支持 fields / limit / where + params）
pub async fn rows(
    conn: &DbConnection,
    table: &str,
    fields: Option<&str>,
    limit: Option<i64>,
    where_clause: Option<&str>,
    params: &[Value],
) -> Response {
    match fetch_rows(conn, table, fields, limit, where_clause, params, None).await {
        Ok((out, total, display)) => (axum::Json(json!({
            "ok": true,
            "database": conn.id,
            "table": display,
            "total": total,
            "rows": out,
        })))
        .into_response(),
        Err(e) => service_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ident_and_table_split() {
        assert_eq!(quote_ident("or\"der"), "\"or\"\"der\"");
        assert_eq!(quote_qualified("public", "t1"), "\"public\".\"t1\"");
        assert_eq!(split_table("public.v_x", "public"), ("public".into(), "v_x".into()));
        assert_eq!(split_table("v_x", "public"), ("public".into(), "v_x".into()));
        // 缺 schema 前缀时落到默认 schema
        assert_eq!(split_table("v_x", "app"), ("app".into(), "v_x".into()));
    }

    #[test]
    fn display_name_prefixes_non_default_schema() {
        assert_eq!(display_name("public", "t1", "public"), "t1");
        assert_eq!(display_name("app", "t1", "public"), "app.t1");
    }

    #[test]
    fn placeholder_translation() {
        assert_eq!(to_pg_placeholders("a = ? AND b > ?"), "a = $1 AND b > $2");
        assert_eq!(to_pg_placeholders("a = $1"), "a = $1");
    }

    #[test]
    fn native_type_set() {
        assert!(native_type("integer"));
        assert!(native_type("character varying"));
        assert!(!native_type("numeric"));
        assert!(!native_type("timestamp without time zone"));
        assert!(!native_type("uuid"));
        assert!(!native_type("jsonb"));
    }
}
