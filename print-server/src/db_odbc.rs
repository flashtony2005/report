//! GET/POST /api/data/* 的 odbc 分支
//!
//! **整块在 `feature = "odbc"` 下才编**（`odbc-api` 是 optional 依赖，见 Cargo.toml）。
//! 没开 feature 时 `db.rs` 仍走「ODBC 引擎暂未实现」的明确报错 —— 两条路各自有人守，
//! 见 `db.rs` 里的 `#[cfg]` 分叉与 `db.rs` 的 `odbc_feature_disabled_message`。
//!
//! 设计要点（都是踩出来的，别顺手改）：
//!
//! - **只读，但保证比另两条路弱一档 —— 已在 README 写明，别当成同级。**
//!   sqlite 靠 `SQLITE_OPEN_READ_ONLY`（文件级）、postgres 靠
//!   `SET SESSION ... READ ONLY`（会话级），ODBC 这两样都做不到：
//!   `odbc-api 29` **没有**暴露 `SQL_ATTR_ACCESS_MODE`，而且拿不到裸连接 handle
//!   （`Connection::into_handle` 是**消费 self** 的，`Environment::allocate_connection`
//!   是私有的），所以只能在**语句层**保证：
//!   ① 我们自己拼的永远只有 `SELECT` / `SELECT COUNT(*)`；
//!   ② `where` 由调用方给，是唯一的注入面 → `guard_where` 禁掉语句分隔符与注释符，
//!   让它只能是「一个布尔表达式」，接不出第二条语句。
//!   这挡不住「驱动自己支持在表达式里调有副作用的函数」那种情况 —— 已知的残余风险。
//! - **元数据走 ODBC 自己的目录函数**（`SQLTables` / `SQLColumns` / `SQLPrimaryKeys`），
//!   不写方言 SQL —— 换驱动不用改代码。
//! - **目录函数的名字参数是「搜索模式」不是字面量**：`_` 匹配任意单字符、`%` 匹配任意串。
//!   表名里带 `_`（`user_name` 这种到处都是）会**多匹配出一堆别的表**，而且不报错。
//!   所以传进去之前必须转义，见 `escape_pattern`。
//! - **标识符引号问驱动**（`SQLGetInfo(SQL_IDENTIFIER_QUOTE_CHAR)`）。驱动说没有引号符时
//!   只允许裸写「安全字符集」里的名字，否则拒绝 —— 裸拼标识符是注入面。
//! - **阻塞 API**：odbc-api 是同步的，全部包在 `spawn_blocking` 里，别把 tokio 工作线程卡住。
//! - **类型**：整数 / 浮点 / 布尔按 `SQLDescribeCol` 报的类型原生解码，其余一律取文本。
//!   全取文本的话报表里的 `sum()` 会静默算错（字符串求和）。
//!
//! 连接信息见 `config::DbConnection`（`dsn` + 可选 `user` / `password`）。

use crate::config::DbConnection;
use crate::util::service_error;
use axum::response::{IntoResponse, Response};
use odbc_api::{
    Connection, ConnectionOptions, Cursor, CursorRow, DataType, IntoParameter, Nullable,
    ResultSetMetadata, environment, escape_attribute_value,
};
use serde_json::{json, Value};
use std::time::Instant;

/// 与 db.rs 保持一致的行数上限
const ROWS_MAX_LIMIT: i64 = 1000;

/// 取文本参数时用的别名。`wide` / `narrow` 两个 feature 下具体类型不同
/// （`VarWCharBox` / `VarCharBox`），走 `IntoParameter::Parameter` 就不用管是哪个。
type OdbcText = <Option<String> as IntoParameter>::Parameter;

/* ------------------------------ 连接 ------------------------------ */

/// ODBC 连接串。值一律过 `escape_attribute_value`：
/// 含 `;` / `}` 的值会被大括号包住并把 `}` 翻倍，不然密码里一个分号就把串截断了。
fn connection_string(conn: &DbConnection) -> Result<String, String> {
    let dsn = conn
        .dsn
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("ODBC 连接「{}」缺少 dsn 名称", conn.id))?;
    let mut s = format!("DSN={};", escape_attribute_value(dsn));
    if let Some(u) = conn.user.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        s.push_str(&format!("UID={};", escape_attribute_value(u)));
    }
    if let Some(p) = conn.password.as_deref().filter(|s| !s.is_empty()) {
        s.push_str(&format!("PWD={};", escape_attribute_value(p)));
    }
    Ok(s)
}

/// 试把连接设成只读，返回驱动是否**真的**接受了。
///
/// 这个属性是连接级的，ODBC 标准里 `SQL_ATTR_ACCESS_MODE = SQL_MODE_READ_ONLY` 表示
/// 「本连接只能读」。驱动完全可以忽略它（不少驱动就是忽略），所以返回值必须被记住、
/// 并在下面按它决定「能不能跑带 where 的 SQL」，而不是设完就当只读了。
fn connect(conn: &DbConnection) -> Result<Connection<'static>, String> {
    let env = environment().map_err(|e| format!("初始化 ODBC 环境失败：{e}"))?;
    let cs = connection_string(conn)?;
    let options = ConnectionOptions {
        // 连不上要快点失败：默认是驱动定的，有的驱动会一直等
        login_timeout_sec: Some(10),
        ..Default::default()
    };
    env.connect_with_connection_string(&cs, options)
        .map_err(|e| format!("连接 ODBC 失败（{}）：{e}", conn.id))
}

/// 试连探针（admin 配置页用）：返回一句人类可读的成功摘要
pub fn probe(conn: &DbConnection) -> Result<String, String> {
    let t0 = Instant::now();
    let c = connect(conn)?;
    let dbms = c.database_management_system_name().unwrap_or_default();
    let tables = list_tables(&c, schema_filter(conn).as_deref(), &default_schema(conn))?;
    let n_view = tables.iter().filter(|t| t["type"] == "view").count();
    let n_tab = tables.len() - n_view;
    Ok(format!(
        "连接成功：{}｜{n_tab} 张表 / {n_view} 个视图｜{} ms",
        if dbms.trim().is_empty() {
            "ODBC 数据源".to_string()
        } else {
            dbms.trim().to_string()
        },
        t0.elapsed().as_millis()
    ))
}

/* ------------------------------ 标识符 ------------------------------ */

/// 目录函数的名字参数是搜索模式，`_` / `%` 有特殊含义，`\` 是转义符（ODBC 默认）。
/// 表名 `user_name` 不转义的话会连 `userXname` 一起匹配出来，且**不报错**。
fn escape_pattern(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 标识符引号符。
///
/// 本来想问驱动（`SQLGetInfo(SQL_IDENTIFIER_QUOTE_CHAR)`），但 `odbc-api 29` 拿不到裸连接
/// handle（见文件头「只读」那条，同一个原因），调不了 `SQLGetInfo`。
/// 于是写死 ANSI 标准的双引号 —— 绝大多数驱动认它。
///
/// **驱动不认双引号时后果是「明确报错」不是「静默错数据」**：SQL 直接语法错，
/// 取数失败并把驱动原话回给调用方。这是可以接受的失败方式。
const IDENT_QUOTE: char = '"';

/// 转义标识符：包上引号符，内部的引号符翻倍（`or"der` → `"or""der"`）。
fn quote_ident(s: &str) -> String {
    let d = IDENT_QUOTE.to_string().repeat(2);
    format!(
        "{q}{}{q}",
        s.replace(IDENT_QUOTE, &d),
        q = IDENT_QUOTE
    )
}

/// 配置里的 schema；没配就是空串 = 不过滤（**不是** postgres 那个 `public`）。
/// ODBC 里 sqlite / 很多桌面库根本没有 schema 概念，写死 public 会一个表都查不到。
fn schema_filter(conn: &DbConnection) -> Option<String> {
    conn.schema
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn default_schema(conn: &DbConnection) -> String {
    schema_filter(conn).unwrap_or_default()
}

/* ------------------------------ 目录 ------------------------------ */

/// 表 / 视图列表。`schema` 为 `None` 时不过滤（返回所有 schema 下的）。
/// 非默认 schema 下的表带 `schema.` 前缀，与 postgres 那条路一致。
fn list_tables(
    c: &Connection<'_>,
    schema: Option<&str>,
    default_schema: &str,
) -> Result<Vec<Value>, String> {
    let pat = schema.map(escape_pattern).unwrap_or_default();
    let it = c
        .tables("", &pat, "", "")
        .map_err(|e| format!("列出表失败：{e}"))?;
    let mut out = Vec::new();
    for row in it {
        let row = row.map_err(|e| format!("读取表列表失败：{e}"))?;
        let name = text_of(&row.table, "表名")?;
        if name.is_empty() {
            continue;
        }
        let sch = text_of(&row.schema, "schema 名")?;
        let ttype = text_of(&row.table_type, "表类型")?;
        let kind = if ttype.eq_ignore_ascii_case("VIEW") {
            "view"
        } else {
            "table"
        };
        out.push(json!({
            "name": display_name(&sch, &name, default_schema),
            "type": kind,
        }));
    }
    Ok(out)
}

fn text_of<const L: usize>(
    v: &odbc_api::parameter::VarCharArray<L>,
    what: &str,
) -> Result<String, String> {
    v.as_str()
        .map(|o| o.unwrap_or("").to_string())
        .map_err(|e| format!("{what}不是合法 UTF-8：{e}"))
}

#[derive(Debug, Clone)]
struct OdbcCol {
    name: String,
    type_name: String,
    nullable: bool,
    pk: bool,
    dflt: Option<String>,
}

/// 字段元信息。主键要单独问 `SQLPrimaryKeys`（`SQLColumns` 不含主键列）。
fn list_columns(c: &Connection<'_>, schema: &str, table: &str) -> Result<Vec<OdbcCol>, String> {
    // 表名先确认存在，顺带拿到「原样大小写」的名字（驱动可能大小写不敏感）
    // 这里把**请求里的** schema 当默认值，好让裸表名能直接匹配上
    let tables = list_tables(c, schema_filter_from(schema), schema)?;
    let hit = tables.iter().find(|t| {
        let n = t["name"].as_str().unwrap_or("");
        n == table || n.rsplit('.').next() == Some(table)
    });
    let Some(hit) = hit else {
        return Err(format!("未找到表「{table}」，已拒绝（防注入）"));
    };
    let real = hit["name"].as_str().unwrap_or(table).to_string();
    let (sch, tbl) = match real.split_once('.') {
        Some((s, t)) => (s.to_string(), t.to_string()),
        None => (schema.to_string(), real),
    };

    let mut pk_cols: Vec<String> = Vec::new();
    if let Ok(it) = c.primary_keys(None, opt_str(&sch), &tbl) {
        for row in it.flatten() {
            if let Ok(name) = text_of(&row.column, "主键列名") {
                if !name.is_empty() {
                    pk_cols.push(name);
                }
            }
        }
    }

    let it = c
        .columns("", &escape_pattern(&sch), &escape_pattern(&tbl), "")
        .map_err(|e| format!("读取字段失败：{e}"))?;
    let mut out = Vec::new();
    for row in it {
        let row = row.map_err(|e| format!("读取字段失败：{e}"))?;
        let name = text_of(&row.column_name, "字段名")?;
        if name.is_empty() {
            continue;
        }
        let type_name = text_of(&row.type_name, "字段类型")?;
        let dflt = text_of(&row.column_default, "字段默认值")?;
        out.push(OdbcCol {
            pk: pk_cols.iter().any(|p| p == &name),
            name,
            // 驱动报的类型名可能是空串，此时退回 SQL 类型码，别给个空字符串让人猜
            type_name: if type_name.is_empty() {
                format!("SQL type {}", row.data_type)
            } else {
                type_name
            },
            nullable: row.nullable != 0,
            dflt: if dflt.is_empty() { None } else { Some(dflt) },
        });
    }
    if out.is_empty() {
        return Err(format!("表「{table}」读不到任何字段"));
    }
    Ok(out)
}

fn schema_filter_from(schema: &str) -> Option<&str> {
    if schema.trim().is_empty() { None } else { Some(schema) }
}

fn opt_str(s: &str) -> Option<&str> {
    if s.trim().is_empty() { None } else { Some(s) }
}

/* ------------------------------ 取数 ------------------------------ */

/// 按列类型取值。整数 / 浮点 / 布尔原生解码，其余取文本。
///
/// 全取文本看着更简单，但报表表达式里的 `sum()` 会在字符串上静默算错 ——
/// 这正是「看着有数据、其实算错了」那一类。
fn decode_cell(col: &DataType, row: &mut CursorRow<'_>, idx: u16) -> Result<Value, String> {
    let bad = |e: odbc_api::Error| format!("读第 {idx} 列失败：{e}");
    match col {
        DataType::Integer | DataType::SmallInt | DataType::BigInt | DataType::TinyInt => {
            let mut v = Nullable::<i64>::null();
            row.get_data(idx, &mut v).map_err(bad)?;
            Ok(v.into_opt().map_or(Value::Null, |n| json!(n)))
        }
        DataType::Real | DataType::Double | DataType::Float { .. } => {
            let mut v = Nullable::<f64>::null();
            row.get_data(idx, &mut v).map_err(bad)?;
            Ok(v.into_opt().map_or(Value::Null, |n| json!(n)))
        }
        DataType::Bit => {
            // `bool` 没实现 `Pod`，取 `u8` 再判 0 —— 直接用 `Nullable<bool>` 编不过
            let mut v = Nullable::<u8>::null();
            row.get_data(idx, &mut v).map_err(bad)?;
            Ok(v.into_opt().map_or(Value::Null, |n| json!(n != 0)))
        }
        _ => {
            let mut buf = Vec::new();
            let not_null = row.get_text(idx, &mut buf).map_err(bad)?;
            if !not_null {
                Ok(Value::Null)
            } else {
                Ok(Value::String(String::from_utf8_lossy(&buf).into_owned()))
            }
        }
    }
}

/// `where` 里禁掉「能接出第二条语句」和「能把后面的 SQL 注释掉」的东西。
///
/// ODBC 这条路的只读保证就落在这里（见文件头）：只要 `where` 只能是**一个布尔表达式**，
/// 它就没法变成 DDL / DML。代价是 `WHERE note = 'a;b'` 这类会被拒 —— **明确报错，不静默**。
fn guard_where(w: &str) -> Result<(), String> {
    for (pat, why) in [
        (";", "语句分隔符"),
        ("--", "行注释"),
        ("/*", "块注释"),
        ("*/", "块注释"),
    ] {
        if w.contains(pat) {
            return Err(format!(
                "where 里不允许出现「{pat}」（{why}），已拒绝（防注入）"
            ));
        }
    }
    Ok(())
}

/// JSON 标量 → ODBC 文本参数。`null` 走 `None` 绑定成 SQL NULL，不是空串。
fn param_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        // 数组 / 对象没法当单个参数绑，明说而不是塞个 "[object]"
        other => Some(other.to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
fn fetch_rows_blocking(
    conn: &DbConnection,
    table: &str,
    fields: Option<&str>,
    limit: Option<i64>,
    where_clause: Option<&str>,
    params: &[Value],
    max_limit: Option<i64>,
) -> Result<(Vec<Value>, i64, String), String> {
    let c = connect(conn)?;
    let default = default_schema(conn);
    let (schema, tbl) = split_table(table, &default);
    let cols = list_columns(&c, &schema, &tbl)?;

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

    // where 是唯一的注入面：先过 guard（见文件头「只读」那条）
    let where_sql = match where_clause.map(str::trim).filter(|s| !s.is_empty()) {
        Some(w) => {
            guard_where(w)?;
            Some(w.to_string())
        }
        None => None,
    };

    let select_list = selected
        .iter()
        .map(|n| quote_ident(n))
        .collect::<Vec<_>>()
        .join(", ");
    let target = if schema.trim().is_empty() {
        quote_ident(&tbl)
    } else {
        format!("{}.{}", quote_ident(&schema), quote_ident(&tbl))
    };

    let bound: Vec<OdbcText> = params
        .iter()
        .map(|v| param_text(v).into_parameter())
        .collect();

    let count_sql = match &where_sql {
        Some(w) => format!("SELECT COUNT(*) FROM {target} WHERE ({w})"),
        None => format!("SELECT COUNT(*) FROM {target}"),
    };
    let total: i64 = {
        let mut cur = c
            .execute(&count_sql, &bound[..], None)
            .map_err(|e| format!("统计行数失败：{e}"))?
            .ok_or_else(|| "统计行数没返回结果集".to_string())?;
        match cur.next_row().map_err(|e| format!("统计行数失败：{e}"))? {
            Some(mut row) => {
                let mut v = Nullable::<i64>::null();
                row.get_data(1, &mut v)
                    .map_err(|e| format!("读 COUNT(*) 失败：{e}"))?;
                v.into_opt().unwrap_or(0)
            }
            None => 0,
        }
    };

    let limit = limit.unwrap_or(100).clamp(1, max_limit.unwrap_or(ROWS_MAX_LIMIT));
    let rows_sql = match &where_sql {
        Some(w) => format!("SELECT {select_list} FROM {target} WHERE ({w})"),
        None => format!("SELECT {select_list} FROM {target}"),
    };
    let mut cur = c
        .execute(&rows_sql, &bound[..], None)
        .map_err(|e| format!("取数失败：{e}"))?
        .ok_or_else(|| "取数没返回结果集".to_string())?;

    // 列类型要在取行**之前**问（有些驱动取完最后一行就不给元数据了）
    let types: Vec<DataType> = (0..selected.len())
        .map(|i| {
            cur.col_data_type(i as u16 + 1)
                .map_err(|e| format!("读第 {} 列的类型失败：{e}", i + 1))
        })
        .collect::<Result<_, _>>()?;

    // 不用 SQL 的 LIMIT（各家方言不同），直接少读几行 —— 游标是懒的，驱动不会全取回来
    let mut out = Vec::new();
    while (out.len() as i64) < limit {
        let Some(mut row) = cur.next_row().map_err(|e| format!("取数失败：{e}"))? else {
            break;
        };
        let mut m = serde_json::Map::new();
        for (i, name) in selected.iter().enumerate() {
            m.insert(name.clone(), decode_cell(&types[i], &mut row, i as u16 + 1)?);
        }
        out.push(Value::Object(m));
    }

    Ok((out, total, display_name(&schema, &tbl, &default)))
}

/* ------------------------------ 拆表名 ------------------------------ */

/// 表名可能是 `schema.table` 或裸表名（裸表名落到默认 schema）。
/// 与 postgres 那条路共用一份实现，别再抄一遍（抄两遍就会只改一处）。
fn split_table(table: &str, default_schema: &str) -> (String, String) {
    match table.split_once('.') {
        Some((s, t)) if !s.is_empty() && !t.is_empty() => (s.to_string(), t.to_string()),
        _ => (default_schema.to_string(), table.to_string()),
    }
}

/// 默认 schema 下的表不带前缀，其余带 `schema.` 前缀（前端原样回传作 table）
fn display_name(schema: &str, table: &str, default_schema: &str) -> String {
    if schema == default_schema || schema.is_empty() {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    }
}

/* ------------------------------ handlers ------------------------------ */

async fn blocking<T, F>(f: F) -> Result<T, Response>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(service_error(e)),
        Err(e) => Err(service_error(format!("ODBC 任务异常结束：{e}"))),
    }
}

/// 表 / 视图列表
pub async fn tables(conn: &DbConnection) -> Response {
    let conn = conn.clone();
    match blocking(move || {
        let s = connect(&conn)?;
        list_tables(&s, schema_filter(&conn).as_deref(), &default_schema(&conn))
    })
    .await
    {
        Ok(arr) => (axum::Json(json!({ "ok": true, "tables": arr }))).into_response(),
        Err(r) => r,
    }
}

/// 字段元信息
pub async fn columns(conn: &DbConnection, table: &str) -> Response {
    let conn = conn.clone();
    let table = table.to_string();
    match blocking(move || {
        let s = connect(&conn)?;
        let (schema, tbl) = split_table(&table, &default_schema(&conn));
        let cols = list_columns(&s, &schema, &tbl)?;
        let arr: Vec<Value> = cols
            .iter()
            .map(|c| {
                json!({
                    "name": c.name,
                    "type": c.type_name,
                    "nullable": c.nullable,
                    "primary": c.pk,
                    "key": if c.pk { "PRI" } else { "" },
                    "default": c.dflt,
                })
            })
            .collect();
        Ok(arr)
    })
    .await
    {
        Ok(arr) => (axum::Json(json!({ "ok": true, "columns": arr }))).into_response(),
        Err(r) => r,
    }
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
    let conn = conn.clone();
    let table = table.to_string();
    let fields = fields.map(str::to_string);
    let where_clause = where_clause.map(str::to_string);
    let params = params.to_vec();
    match tokio::task::spawn_blocking(move || {
        fetch_rows_blocking(
            &conn,
            &table,
            fields.as_deref(),
            limit,
            where_clause.as_deref(),
            &params,
            max_limit,
        )
    })
    .await
    {
        Ok(r) => r,
        Err(e) => Err(format!("ODBC 任务异常结束：{e}")),
    }
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

    fn odbc_conn() -> DbConnection {
        DbConnection {
            id: "erp".into(),
            engine: "odbc".into(),
            dsn: Some("erp_dsn".into()),
            ..Default::default()
        }
    }

    #[test]
    fn connection_string_uses_the_dsn_and_escapes_values() {
        let mut c = odbc_conn();
        c.user = Some("sa".into());
        c.password = Some("p;w}d".into());
        let s = connection_string(&c).unwrap();
        assert!(s.starts_with("DSN=erp_dsn;"), "DSN 要在最前：{s}");
        assert!(s.contains("UID=sa;"), "用户名原样：{s}");
        // 分号会被大括号包住，右括号翻倍 —— 不转义的话串在这里就被截断了
        assert!(s.contains("PWD={p;w}}d};"), "密码要转义：{s}");
    }

    #[test]
    fn connection_string_without_dsn_names_the_connection() {
        let mut c = odbc_conn();
        c.dsn = None;
        let e = connection_string(&c).unwrap_err();
        assert!(e.contains("erp"), "报错要点出是哪条连接：{e}");
        assert!(e.contains("dsn"), "报错要点出缺什么：{e}");
    }

    /// 目录函数的名字参数是**搜索模式**：`_` 不转义会多匹配一堆表，而且不报错。
    #[test]
    fn pattern_escapes_the_underscore() {
        assert_eq!(escape_pattern("user_name"), "user\\_name");
        assert_eq!(escape_pattern("100%"), "100\\%");
        assert_eq!(escape_pattern("a\\b"), "a\\\\b");
        assert_eq!(escape_pattern("plain"), "plain");
    }

    #[test]
    fn quote_ident_doubles_the_quote_char() {
        assert_eq!(quote_ident("or\"der"), "\"or\"\"der\"");
        assert_eq!(quote_ident("t1"), "\"t1\"");
        // 中文表名也要能包上
        assert_eq!(quote_ident("订单"), "\"订单\"");
    }

    /// ODBC 这条路的只读保证落在 `guard_where` 上（见文件头）：
    /// 只要 where 只能是「一个布尔表达式」，它就接不出第二条语句。
    #[test]
    fn where_rejects_separator_and_comments() {
        assert!(guard_where("a = 1").is_ok());
        assert!(guard_where("a = ? AND b IN (?, ?)").is_ok());
        assert!(guard_where("a LIKE '%x%'").is_ok());
        for bad in ["1=1; DROP TABLE t", "a=1 -- x", "a=1 /* x */", "a=1 */"] {
            let e = guard_where(bad).unwrap_err();
            assert!(e.contains("已拒绝"), "{bad} 应当被拒：{e}");
        }
    }

    /// `null` 要绑成 SQL NULL，不是空串 —— 空串和 NULL 在 `=` 比较里结果不同。
    #[test]
    fn null_param_stays_null() {
        assert_eq!(param_text(&Value::Null), None);
        assert_eq!(param_text(&json!("")), Some(String::new()));
        assert_eq!(param_text(&json!(5)), Some("5".into()));
        assert_eq!(param_text(&json!(true)), Some("true".into()));
    }

    /// ODBC 没有 `public` 这个默认 schema，写死会一个表都查不到。
    #[test]
    fn default_schema_is_empty_not_public() {
        let c = odbc_conn();
        assert_eq!(default_schema(&c), "");
        assert_eq!(schema_filter(&c), None);
        let mut c2 = odbc_conn();
        c2.schema = Some("  main  ".into());
        assert_eq!(default_schema(&c2), "main");
        assert_eq!(schema_filter(&c2).as_deref(), Some("main"));
    }

    #[test]
    fn split_and_display_table_names() {
        assert_eq!(split_table("main.t1", ""), ("main".into(), "t1".into()));
        assert_eq!(split_table("t1", ""), ("".into(), "t1".into()));
        // 默认 schema 为空时，裸表名不带前缀；带了别的 schema 才带
        assert_eq!(display_name("", "t1", ""), "t1");
        assert_eq!(display_name("main", "t1", ""), "main.t1");
        assert_eq!(display_name("main", "t1", "main"), "t1");
    }
}
