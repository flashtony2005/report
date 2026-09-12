//! 可视化数据库配置（内嵌单页 `admin.html`）
//!
//! | 方法 | 路径 | 说明 |
//! |---|---|---|
//! | GET | `/` `/admin` | 管理页（零依赖、离线可用） |
//! | GET | `/api/config` | 当前配置（密码脱敏，只回 `passwordSet`） |
//! | PUT | `/api/config` | 保存配置：校验 → 备份 → 原子写盘 → 热更新内存 |
//! | POST | `/api/config/test` | 试连（不落盘）：sqlite 只读试打开 / postgres 探针 |
//! | GET | `/api/config/fs` | 目录浏览：给 sqlite 路径、扫描目录提供选择器 |
//!
//! 密码语义：读接口**不回明文**；写接口里「留空 = 沿用原密码」，
//! 需要清空时前端显式传 `clearPassword: true`。
//!
//! 安全说明：写操作与目录浏览要求请求头 `X-OpenPrint-Admin: 1`，可挡掉表单类/简单请求式 CSRF，
//! 但**不是**强安全边界（跨站 fetch 在预检放行后仍可携带该头）。本服务定位本机工具，
//! 默认只监听 `127.0.0.1`；以 `--lan` 暴露到局域网时请自行评估风险（建议改用只读库账号）。

use crate::config::{strip_verbatim, DbConnection, ServerConfig};
use crate::util::service_error;
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 内嵌管理页（离线零依赖）
const ADMIN_HTML: &str = include_str!("admin.html");

const ADMIN_HEADER: &str = "x-openprint-admin";

fn guarded(headers: &HeaderMap) -> bool {
    headers.get(ADMIN_HEADER).is_some()
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        axum::Json(json!({
            "ok": false,
            "message": format!("缺少请求头 {ADMIN_HEADER}，已拒绝（请从管理页操作）"),
        })),
    )
        .into_response()
}

/* ------------------------------ 请求体 ------------------------------ */

/// 连接条目：`clearPassword` 显式表达「清空密码」，与「留空 = 不修改」区分
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnPayload {
    #[serde(flatten)]
    conn: DbConnection,
    clear_password: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigPayload {
    connections: Vec<ConnPayload>,
    scan_dirs: Vec<String>,
    spool_dir: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FsQuery {
    dir: Option<String>,
    /// 显示全部文件（默认只显示 *.db / *.sqlite / *.sqlite3）
    /// 取 String 以兼容 `all=1` / `all=true` 两种写法
    all: Option<String>,
}

/* ------------------------------ 序列化 ------------------------------ */

fn conn_json(c: &DbConnection) -> Value {
    let password_set = c.password.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let mut v = serde_json::to_value(c).unwrap_or_else(|_| json!({}));
    if let Some(o) = v.as_object_mut() {
        o.remove("password"); // 明文密码不出服务端
        o.insert("passwordSet".into(), json!(password_set));
    }
    v
}

fn config_json(cfg: &ServerConfig, path: &Path) -> Value {
    let conns: Vec<Value> = cfg.connections.iter().map(conn_json).collect();
    json!({
        "ok": true,
        "configPath": ServerConfig::abs_display(path),
        "connections": conns,
        "scanDirs": cfg.scan_dirs,
        "spoolDir": cfg.spool_dir,
    })
}

/* ------------------------------ handlers ------------------------------ */

/// GET / 与 GET /admin —— 管理页
pub async fn index() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        ADMIN_HTML,
    )
        .into_response()
}

/// GET /api/config
pub async fn get_config(State(state): State<AppState>) -> Response {
    let cfg = state.config.read().unwrap().clone();
    axum::Json(config_json(&cfg, &state.config_path)).into_response()
}

/// PUT /api/config —— 全量覆盖保存
pub async fn put_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<ConfigPayload>,
) -> Response {
    if !guarded(&headers) {
        return forbidden();
    }

    // 旧配置：用于「密码留空 = 沿用原密码」（按 id 匹配，id 不允许改）
    let old = state.config.read().unwrap().clone();
    let old_pw: std::collections::HashMap<String, Option<String>> = old
        .connections
        .iter()
        .map(|c| (c.id.clone(), c.password.clone()))
        .collect();

    let mut next = ServerConfig {
        connections: Vec::with_capacity(payload.connections.len()),
        scan_dirs: payload.scan_dirs,
        spool_dir: payload.spool_dir,
    };
    for p in payload.connections {
        let mut c = p.conn;
        let typed = c
            .password
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        c.password = if p.clear_password {
            None
        } else if typed {
            c.password.take()
        } else {
            old_pw.get(c.id.trim()).cloned().flatten()
        };
        next.connections.push(c);
    }
    next.normalize();
    if let Err(e) = next.validate() {
        return service_error(format!("配置有误：{e}"));
    }

    let path = state.config_path.as_ref().clone();
    if let Err(e) = next.save(&path) {
        return service_error(format!("保存配置失败：{e}"));
    }
    // spool 目录改了就地建好，避免首次打印才发现目录不存在
    let spool = next.spool_path();
    if let Err(e) = std::fs::create_dir_all(&spool) {
        eprintln!("[admin] spool 目录创建失败 {}: {e}", spool.display());
    }
    // 热更新：databases / tables / rows 立即按新配置生效，无需重启
    *state.config.write().unwrap() = next.clone();
    eprintln!(
        "[admin] 配置已保存：{}（{} 条连接）",
        ServerConfig::abs_display(&path),
        next.connections.len()
    );

    axum::Json(config_json(&next, &path)).into_response()
}

/// POST /api/config/test —— 试连，不落盘
pub async fn test_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<ConnPayload>,
) -> Response {
    if !guarded(&headers) {
        return forbidden();
    }
    let mut tmp = ServerConfig {
        connections: vec![payload.conn],
        ..Default::default()
    };
    // 密码留空：沿用同 id 的已存密码（编辑既有连接时前端拿不到明文）
    if tmp.connections[0]
        .password
        .as_deref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
    {
        let id = tmp.connections[0].id.trim().to_string();
        if let Some(pw) = state
            .config
            .read()
            .unwrap()
            .connections
            .iter()
            .find(|c| c.id == id)
            .and_then(|c| c.password.clone())
        {
            tmp.connections[0].password = Some(pw);
        }
    }
    tmp.normalize();
    if let Err(e) = tmp.validate() {
        return service_error(format!("连接配置不完整：{e}"));
    }
    let c = tmp.connections.pop().unwrap();
    let engine = c.norm_engine().to_string();
    let started = std::time::Instant::now();

    let result = match engine.as_str() {
        "postgres" => crate::db_pg::probe(&c).await,
        "odbc" => Err("ODBC 引擎暂未实现（Rust 版客户端）：可以保存配置，但本服务暂不能连".to_string()),
        _ => probe_sqlite(&c),
    };
    match result {
        Ok(message) => axum::Json(json!({
            "ok": true,
            "engine": engine,
            "elapsedMs": started.elapsed().as_millis(),
            "message": message,
        }))
        .into_response(),
        Err(message) => service_error(message),
    }
}

/// sqlite 试连：只读打开 + 统计表/视图（复用 db.rs 的只读口径）
fn probe_sqlite(c: &DbConnection) -> Result<String, String> {
    let path = c.path.clone().ok_or("缺少数据库文件路径")?;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    let t0 = std::time::Instant::now();
    let conn = rusqlite::Connection::open_with_flags(
        &p,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("打开 sqlite 失败（{path}）：{e}"))?;
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let views: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='view'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let kb = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) as f64 / 1024.0;
    Ok(format!(
        "连接成功（只读）：SQLite {tables} 张表 / {views} 个视图｜{kb:.1} KB｜{} ms",
        t0.elapsed().as_millis()
    ))
}

/// GET /api/config/fs —— 目录浏览（sqlite 文件 / 扫描目录选择器）
pub async fn fs_list(headers: HeaderMap, Query(q): Query<FsQuery>) -> Response {
    if !guarded(&headers) {
        return forbidden();
    }
    let raw = q.dir.unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        return axum::Json(json!({
            "ok": true,
            "dir": "",
            "parent": null,
            "entries": drives(),
        }))
        .into_response();
    }

    let p = PathBuf::from(raw);
    if !p.is_dir() {
        return service_error(format!("目录不存在或不可访问：{}", p.display()));
    }
    let show_all = matches!(
        q.all.as_deref().map(str::trim),
        Some("1") | Some("true") | Some("yes")
    );
    let rd = match std::fs::read_dir(&p) {
        Ok(r) => r,
        Err(e) => return service_error(format!("读取目录失败（{}）：{e}", p.display())),
    };

    let mut dirs: Vec<Value> = vec![];
    let mut files: Vec<Value> = vec![];
    for e in rd.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            dirs.push(json!({ "name": name, "path": norm_path(&path), "kind": "dir" }));
            continue;
        }
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.to_ascii_lowercase())
            .unwrap_or_default();
        let is_db = matches!(ext.as_str(), "db" | "sqlite" | "sqlite3");
        if !show_all && !is_db {
            continue;
        }
        files.push(json!({
            "name": name,
            "path": norm_path(&path),
            "kind": if is_db { "db" } else { "file" },
            "size": e.metadata().map(|m| m.len()).unwrap_or(0),
        }));
    }
    let by_name = |a: &Value, b: &Value| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    };
    dirs.sort_by(by_name);
    files.sort_by(by_name);

    dirs.extend(files);
    axum::Json(json!({
        "ok": true,
        "dir": norm_path(&p),
        "parent": p.parent().map(norm_path),
        "entries": dirs,
    }))
    .into_response()
}

/// 统一成「去 verbatim 前缀 + 平台分隔符」的绝对路径，避免 `F:/a` 与 `F:\a\b` 混用
fn norm_path(p: &Path) -> String {
    let real = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    strip_verbatim(&real)
}

/// 盘符列表（Windows：探测可读的 A:–Z:）
#[cfg(windows)]
fn drives() -> Vec<Value> {
    (b'A'..=b'Z')
        .map(|l| format!("{}:\\", l as char))
        .filter(|root| std::fs::read_dir(root).is_ok())
        .map(|root| json!({ "name": root, "path": root, "kind": "drive" }))
        .collect()
}

#[cfg(not(windows))]
fn drives() -> Vec<Value> {
    vec![json!({ "name": "/", "path": "/", "kind": "drive" })]
}
