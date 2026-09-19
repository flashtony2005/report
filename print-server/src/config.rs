//! 服务配置 —— 数据库连接、扫描目录、spool 目录
//!
//! 配置文件 `print-server.json`（可用 `--config` 或环境变量 `OPENPRINT_PRINT_SERVER_CONFIG` 覆盖）：
//! ```json
//! {
//!   "connections": [
//!     { "id": "byb", "engine": "sqlite", "label": "业务库", "path": "F:/data/byb.db" },
//!     { "id": "pg", "engine": "postgres", "label": "财政库",
//!       "host": "127.0.0.1", "port": 5432, "user": "readonly",
//!       "password": "***", "dbname": "finance", "schema": "public" },
//!     { "id": "pg2", "engine": "postgres", "url": "postgres://u:p@127.0.0.1:5432/db" },
//!     { "id": "erp", "engine": "odbc", "label": "ERP DSN", "dsn": "erp_dsn" }
//!   ],
//!   "scanDirs": ["F:/data/db"],   // 自动发现 *.db / *.sqlite / *.sqlite3
//!   "spoolDir": "spool"           // 打印任务落盘目录（默认 ./spool）
//! }
//! ```
//!
//! postgres 连接两种写法二选一：`url` 完整连接串，或 `host/port/user/password/dbname` 分项；
//! `schema` 只影响「表名是否带 schema 前缀」与默认检索的 schema（缺省 `public`）。
//! 注意：当前只支持明文连接（未接 TLS 连接器），需要 SSL 的服务端请先用 stunnel 或改用本地只读副本。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 宽容解析端口：`null` / 数字 / `"5432"` / `""` 都能收，非法值一律当未填
fn de_opt_u16<'de, D>(d: D) -> Result<Option<u16>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Number(n)) => n.as_u64().and_then(|x| u16::try_from(x).ok()),
        Some(serde_json::Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                s.parse::<u16>().ok()
            }
        }
        _ => None,
    })
}

/// 单条数据库连接
///
/// 序列化时跳过 `None` 字段：写回 `print-server.json` 只保留实际用到的键，保持文件干净可手改。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbConnection {
    pub id: String,
    /// "sqlite" | "postgres" | "odbc"
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// sqlite 文件路径
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// odbc DSN 名
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dsn: Option<String>,
    /* ---- postgres ---- */
    /// 完整连接串（优先于下面的分项）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// 端口：容忍 `""` / `"5432"` / 数字三种写法（前端表单、手改配置都常见）
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_opt_u16")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbname: Option<String>,
    /// 目标 schema（缺省 public）：决定表名是否带前缀、以及检索范围
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

impl Default for DbConnection {
    fn default() -> Self {
        Self {
            id: String::new(),
            engine: "sqlite".into(),
            label: None,
            path: None,
            dsn: None,
            url: None,
            host: None,
            port: None,
            user: None,
            password: None,
            dbname: None,
            schema: None,
        }
    }
}

/// 已知但**本服务不支持**的引擎 → 供报错用的人话名；支持 / 不认识则返回 None。
///
/// 为什么非得单独拎出来：`norm_engine` 对未知引擎一律回落 sqlite，于是手改配置
/// 写了 `engine: "mysql"` 的人会拿到「sqlite 文件不存在: /x/y.db」——
/// 看着像路径写错，其实是引擎根本不支持。**静默降级比报错危险**，所以这里宁可明确红。
pub fn unsupported_engine_name(engine: &str) -> Option<&'static str> {
    match engine.trim().to_ascii_lowercase().as_str() {
        "mysql" | "mariadb" => Some("MySQL / MariaDB"),
        "mssql" | "sqlserver" => Some("SQL Server"),
        "oracle" => Some("Oracle"),
        _ => None,
    }
}

impl DbConnection {
    /// 归一化引擎名：未知引擎按 sqlite 处理（与历史行为一致）
    ///
    /// 注意调用方若要**建连接**，应先过 `unsupported_engine()` ——
    /// 本函数对 mysql 这类已知但不支持的引擎仍会返回 sqlite。
    pub fn norm_engine(&self) -> &'static str {
        match self.engine.as_str() {
            "odbc" => "odbc",
            "postgres" | "postgresql" | "pgsql" | "pg" => "postgres",
            _ => "sqlite",
        }
    }

    /// 本条连接配的是已知但不支持的引擎吗？（返回人话名便于直接拼进报错）
    pub fn unsupported_engine(&self) -> Option<&'static str> {
        unsupported_engine_name(&self.engine)
    }

    /// 目标 schema（缺省 public）
    pub fn schema_or_public(&self) -> String {
        self.schema
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("public")
            .to_string()
    }

    /// `/api/data/databases` 里对外暴露的库标识；前端选中后会原样回传作 database 参数
    pub fn entry_name(&self) -> String {
        match self.norm_engine() {
            "odbc" => self.dsn.clone().unwrap_or_else(|| self.id.clone()),
            "postgres" => self.id.clone(),
            _ => self.path.clone().unwrap_or_else(|| self.id.clone()),
        }
    }

    /// postgres 连接参数（url 优先，否则由分项拼装；用 tokio-postgres 的 Config 免去手写转义）
    pub fn pg_config(&self) -> Result<tokio_postgres::Config, String> {
        if let Some(u) = self.url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            return u
                .parse::<tokio_postgres::Config>()
                .map_err(|e| format!("postgres 连接「{}」的 url 解析失败：{e}", self.id));
        }
        let missing = |field: &str| {
            format!("postgres 连接「{}」缺少 {field}（或改用 url 连接串）", self.id)
        };
        let host = self.host.as_deref().map(str::trim).filter(|s| !s.is_empty())
            .ok_or_else(|| missing("host"))?;
        let user = self.user.as_deref().map(str::trim).filter(|s| !s.is_empty())
            .ok_or_else(|| missing("user"))?;
        let dbname = self.dbname.as_deref().map(str::trim).filter(|s| !s.is_empty())
            .ok_or_else(|| missing("dbname"))?;
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(host)
            .port(self.port.unwrap_or(5432))
            .user(user)
            .dbname(dbname);
        if let Some(p) = self.password.as_deref().filter(|s| !s.is_empty()) {
            cfg.password(p);
        }
        Ok(cfg)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerConfig {
    pub connections: Vec<DbConnection>,
    pub scan_dirs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spool_dir: Option<String>,
}

/// 数据库列表条目（对齐前端 ClientDatabase）
pub struct DatabaseEntry {
    /// 库标识：sqlite 为文件绝对路径，odbc 为 DSN（前端原样回传作 database 参数）
    pub name: String,
    pub engine: String,
    pub label: Option<String>,
}

impl ServerConfig {
    /// 读取配置；文件缺失/损坏时返回带默认扫描目录的空配置（不写回，避免只读环境报错）
    pub fn load(path: &Path) -> (Self, PathBuf) {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(cfg) = serde_json::from_str::<ServerConfig>(&text) {
                return (cfg, path.to_path_buf());
            }
            eprintln!("[warn] 配置文件 {} 解析失败，使用默认配置", path.display());
        }
        (
            ServerConfig {
                connections: vec![],
                scan_dirs: vec![".".into()],
                spool_dir: None,
            },
            path.to_path_buf(),
        )
    }

    pub fn spool_path(&self) -> PathBuf {
        self.spool_dir
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("spool"))
    }

    /// 配置连接 + 扫描目录发现的 sqlite 文件 → 数据库列表（按 name 去重）
    pub fn list_databases(&self) -> Vec<DatabaseEntry> {
        let mut out: Vec<DatabaseEntry> = vec![];
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for c in &self.connections {
            let name = c.entry_name();
            let engine = c.norm_engine().to_string();
            if seen.insert(name.clone()) {
                out.push(DatabaseEntry { name, engine, label: c.label.clone() });
            }
        }

        for dir in &self.scan_dirs {
            let Ok(rd) = std::fs::read_dir(dir) else { continue };
            for entry in rd.flatten() {
                let p = entry.path();
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .unwrap_or_default();
                if !matches!(ext.as_str(), "db" | "sqlite" | "sqlite3") {
                    continue;
                }
                // 统一为绝对路径名，前端回传后能直接定位；
                // 去掉 canonicalize 的 \\?\ 前缀，库名展示更干净
                let name = strip_verbatim(&p.canonicalize().unwrap_or(p.clone()));
                if seen.insert(name.clone()) {
                    let label = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_string());
                    out.push(DatabaseEntry { name, engine: "sqlite".into(), label });
                }
            }
        }

        out
    }

    /// 按 `/api/data/databases` 暴露的库标识反查配置连接（前端把 name 原样回传作 database）
    pub fn find_by_entry_name(&self, name: &str) -> Option<DbConnection> {
        self.connections
            .iter()
            .find(|c| c.entry_name() == name)
            .cloned()
    }
}

/* --------------------------- 可视化配置：归一化 / 校验 / 落盘 --------------------------- */

/// 单个字符串字段的归一化：去空白；空串视作未填（None）
///
/// `password` 例外（可能有意义的首尾空格），由调用方单独处理。
fn norm_opt(v: &mut Option<String>) {
    let cleaned = v.as_deref().map(str::trim).unwrap_or_default().to_string();
    *v = if cleaned.is_empty() { None } else { Some(cleaned) };
}

impl ServerConfig {
    /// 原地归一化：trim 所有字段、引擎名收敛为 `sqlite | postgres | odbc`、空串转 None
    ///
    /// 未知引擎**原样保留**（不静默降级为 sqlite），交给 `validate()` 报明确错误；
    /// 运行期的 `norm_engine()` 仍按历史行为把未知引擎当 sqlite 处理。
    pub fn normalize(&mut self) {
        for c in &mut self.connections {
            c.id = c.id.trim().to_string();
            c.engine = match c.engine.trim().to_ascii_lowercase().as_str() {
                "postgres" | "postgresql" | "pgsql" | "pg" => "postgres",
                "odbc" => "odbc",
                "sqlite" | "sqlite3" => "sqlite",
                other => other,
            }
            .to_string();
            norm_opt(&mut c.label);
            norm_opt(&mut c.path);
            norm_opt(&mut c.dsn);
            norm_opt(&mut c.url);
            norm_opt(&mut c.host);
            norm_opt(&mut c.user);
            norm_opt(&mut c.dbname);
            norm_opt(&mut c.schema);
            // 路径统一成反斜杠，Windows 下与 sqlite 打开行为一致
            if let Some(p) = c.path.as_mut() {
                if p.contains('/') {
                    *p = p.replace('/', "\\");
                }
            }
        }
        self.scan_dirs = self
            .scan_dirs
            .iter()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect();
        norm_opt(&mut self.spool_dir);
    }

    /// 保存前校验：id 唯一合法、各引擎必填项齐全
    pub fn validate(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for (i, c) in self.connections.iter().enumerate() {
            let no = i + 1;
            let id = c.id.trim();
            if id.is_empty() {
                return Err(format!("第 {no} 条连接缺少「连接 ID」"));
            }
            if !id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
            {
                return Err(format!("连接 ID「{id}」只能包含字母、数字、下划线、短横线、点"));
            }
            if !seen.insert(id.to_ascii_lowercase()) {
                return Err(format!("连接 ID「{id}」重复，请换一个"));
            }
            match c.engine.as_str() {
                "postgres" => {
                    let has_url = c.url.is_some();
                    if !has_url {
                        c.pg_config()?; // 复用分项校验（host / user / dbname 必填）
                    }
                }
                "odbc" => {
                    if c.dsn.is_none() {
                        return Err(format!("连接「{id}」是 ODBC 引擎，需要填写 DSN 名称"));
                    }
                }
                "sqlite" => {
                    if c.path.is_none() {
                        return Err(format!("连接「{id}」是 SQLite 引擎，需要填写数据库文件路径"));
                    }
                }
                other => {
                    return Err(format!(
                        "连接「{id}」的引擎「{other}」不支持（可选 sqlite / postgres / odbc）"
                    ))
                }
            }
        }
        Ok(())
    }

    /// 原子写回配置文件：先备份 `.bak`，再写 `.tmp` 后 rename 覆盖，避免写坏配置
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| format!("序列化配置失败：{e}"))?;
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("创建配置目录 {} 失败：{e}", dir.display()))?;
        }
        if path.exists() {
            let bak = PathBuf::from(format!("{}.bak", path.display()));
            std::fs::copy(path, &bak).map_err(|e| format!("备份原配置失败：{e}"))?;
        }
        let tmp = PathBuf::from(format!("{}.tmp", path.display()));
        std::fs::write(&tmp, text).map_err(|e| format!("写入临时配置失败：{e}"))?;
        std::fs::rename(&tmp, path)
            .map_err(|e| format!("替换配置文件失败：{}：{e}", path.display()))?;
        Ok(())
    }

    /// 配置文件的展示用绝对路径（文件可能尚不存在，canonicalize 失败时用 cwd 拼）
    pub fn abs_display(path: &Path) -> String {
        let p = std::fs::canonicalize(path)
            .or_else(|_| std::env::current_dir().map(|cwd| cwd.join(path)))
            .unwrap_or_else(|_| path.to_path_buf());
        let s = strip_verbatim(&p);
        // 手填的相对路径可能带正斜杠，统一成平台分隔符后再展示
        if cfg!(windows) {
            s.replace('/', "\\")
        } else {
            s
        }
    }
}

/// 去掉 Windows verbatim 路径前缀（\\?\C:\... → C:\...）
pub(crate) fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{stripped}")
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_stripped() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\F:\a\b.db")), r"F:\a\b.db");
        assert_eq!(strip_verbatim(Path::new(r"F:\a\b.db")), r"F:\a\b.db");
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\srv\share")), r"\\srv\share");
    }

    #[test]
    fn default_config_scans_current_dir() {
        let cfg = ServerConfig {
            connections: vec![],
            scan_dirs: vec![".".into()],
            spool_dir: None,
        };
        // 不应 panic；当前目录是否有 db 文件不确定，只验证结构
        let _ = cfg.list_databases();
    }

    #[test]
    fn spool_default() {
        let cfg = ServerConfig::default();
        assert_eq!(cfg.spool_path(), PathBuf::from("spool"));
    }

    #[test]
    fn engine_normalization_and_entry_name() {
        let mut c = DbConnection::default();
        c.id = "pg1".into();
        c.engine = "postgresql".into();
        assert_eq!(c.norm_engine(), "postgres");
        // pg 的库标识用 id（前端回传后可按 entry_name 反查）
        assert_eq!(c.entry_name(), "pg1");

        let mut s = DbConnection::default();
        s.id = "byb".into();
        s.engine = "sqlite".into();
        s.path = Some("F:/data/byb.db".into());
        assert_eq!(s.entry_name(), "F:/data/byb.db");

        let mut u = DbConnection::default();
        u.id = "x".into();
        u.engine = "bogus".into();
        assert_eq!(u.norm_engine(), "sqlite");
    }

    #[test]
    fn pg_config_from_url_and_fields() {
        let mut a = DbConnection::default();
        a.id = "a".into();
        a.engine = "postgres".into();
        a.url = Some("postgres://u:p@127.0.0.1:5433/db".into());
        let cfg = a.pg_config().unwrap();
        assert_eq!(cfg.get_hosts().len(), 1);
        assert_eq!(cfg.get_ports(), &[5433]);

        let mut b = DbConnection::default();
        b.id = "b".into();
        b.engine = "postgres".into();
        b.host = Some("127.0.0.1".into());
        b.user = Some("ro".into());
        b.dbname = Some("finance".into());
        let cfg = b.pg_config().unwrap();
        // 缺省端口 5432
        assert_eq!(cfg.get_ports(), &[5432]);
        assert_eq!(cfg.get_user(), Some("ro"));

        // 缺 host 报错
        let mut c = DbConnection::default();
        c.id = "c".into();
        c.engine = "postgres".into();
        assert!(c.pg_config().is_err());
    }

    #[test]
    fn find_by_entry_name_matches() {
        let cfg = ServerConfig {
            connections: vec![
                DbConnection {
                    id: "pg1".into(),
                    engine: "postgres".into(),
                    ..Default::default()
                },
                DbConnection {
                    id: "byb".into(),
                    engine: "sqlite".into(),
                    path: Some("F:/data/byb.db".into()),
                    ..Default::default()
                },
            ],
            scan_dirs: vec![],
            spool_dir: None,
        };
        assert_eq!(cfg.find_by_entry_name("pg1").map(|c| c.id), Some("pg1".into()));
        assert_eq!(
            cfg.find_by_entry_name("F:/data/byb.db").map(|c| c.id),
            Some("byb".into())
        );
        assert!(cfg.find_by_entry_name("nope").is_none());
        // 列表里 postgres 引擎不被降级
        let entries = cfg.list_databases();
        assert!(entries.iter().any(|e| e.engine == "postgres" && e.name == "pg1"));
    }

    #[test]
    fn normalize_trims_and_canonicalizes() {
        let mut cfg = ServerConfig {
            connections: vec![DbConnection {
                id: "  a  ".into(),
                engine: "PostgreSQL".into(),
                host: Some(" 127.0.0.1 ".into()),
                user: Some(" ro ".into()),
                dbname: Some("db".into()),
                path: Some("   ".into()),
                label: Some("  我的库  ".into()),
                ..Default::default()
            }],
            scan_dirs: vec![" . ".into(), "   ".into()],
            spool_dir: Some("  ".into()),
        };
        cfg.normalize();
        let c = &cfg.connections[0];
        assert_eq!(c.id, "a");
        assert_eq!(c.engine, "postgres");
        assert_eq!(c.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(c.user.as_deref(), Some("ro"));
        assert_eq!(c.label.as_deref(), Some("我的库"));
        assert!(c.path.is_none(), "空白路径应归一为 None");
        assert_eq!(cfg.scan_dirs, vec![".".to_string()]);
        assert!(cfg.spool_dir.is_none());
        // 归一后可通过校验
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn normalize_slashes_in_sqlite_path() {
        let mut cfg = ServerConfig::default();
        cfg.connections.push(DbConnection {
            id: "b".into(),
            engine: "sqlite".into(),
            path: Some("F:/data/db/byb.db".into()),
            ..Default::default()
        });
        cfg.normalize();
        assert_eq!(cfg.connections[0].path.as_deref(), Some(r"F:\data\db\byb.db"));
    }

    #[test]
    fn validate_rejects_bad_input() {
        let sqlite_no_path = ServerConfig {
            connections: vec![DbConnection {
                id: "x".into(),
                engine: "sqlite".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(sqlite_no_path.validate().is_err());

        let dup = ServerConfig {
            connections: vec![
                DbConnection {
                    id: "x".into(),
                    engine: "sqlite".into(),
                    path: Some(r"a.db".into()),
                    ..Default::default()
                },
                DbConnection {
                    id: "X".into(),
                    engine: "sqlite".into(),
                    path: Some(r"b.db".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert!(dup.validate().is_err(), "id 大小写不敏感去重");

        let pg_incomplete = ServerConfig {
            connections: vec![DbConnection {
                id: "p".into(),
                engine: "postgres".into(),
                host: Some("127.0.0.1".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(pg_incomplete.validate().is_err());

        let pg_url_only = ServerConfig {
            connections: vec![DbConnection {
                id: "p".into(),
                engine: "postgres".into(),
                url: Some("postgres://u:p@h:5432/db".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(pg_url_only.validate().is_ok());

        let empty_id = ServerConfig {
            connections: vec![DbConnection {
                id: "  ".into(),
                engine: "sqlite".into(),
                path: Some(r"a.db".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(empty_id.validate().is_err());

        let bad_chars = ServerConfig {
            connections: vec![DbConnection {
                id: "含中文 id".into(),
                engine: "sqlite".into(),
                path: Some(r"a.db".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(bad_chars.validate().is_err());

        // 未知引擎原样保留 → 报「引擎不支持」，而不是被静默当 sqlite 再报缺 path
        let mut unknown = ServerConfig {
            connections: vec![DbConnection {
                id: "m".into(),
                engine: "MySQL".into(),
                host: Some("h".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        unknown.normalize();
        assert_eq!(unknown.connections[0].engine, "mysql");
        let msg = unknown.validate().unwrap_err();
        assert!(msg.contains("不支持"), "错误信息应点明引擎不支持: {msg}");
    }

    #[test]
    fn abs_display_strips_verbatim_and_normalizes_slashes() {
        let s = ServerConfig::abs_display(Path::new("sub/dir/print-server.json"));
        assert!(Path::new(&s).is_absolute(), "{s}");
        assert!(!s.contains("\\\\?\\"), "不应带 verbatim 前缀: {s}");
        if cfg!(windows) {
            assert!(!s.contains('/'), "分隔符应统一为反斜杠: {s}");
        }
    }

    #[test]
    fn port_field_is_lenient() {
        let parse = |j: &str| serde_json::from_str::<DbConnection>(j).map(|c| c.port);
        assert_eq!(parse(r#"{"id":"x","engine":"postgres"}"#).unwrap(), None);
        assert_eq!(parse(r#"{"id":"x","engine":"postgres","port":null}"#).unwrap(), None);
        assert_eq!(parse(r#"{"id":"x","engine":"postgres","port":""}"#).unwrap(), None);
        assert_eq!(parse(r#"{"id":"x","engine":"postgres","port":"abc"}"#).unwrap(), None);
        assert_eq!(parse(r#"{"id":"x","engine":"postgres","port":5432}"#).unwrap(), Some(5432));
        assert_eq!(parse(r#"{"id":"x","engine":"postgres","port":"5433"}"#).unwrap(), Some(5433));
        // 超出 u16 的脏值当未填，不 panic
        assert_eq!(parse(r#"{"id":"x","engine":"postgres","port":99999}"#).unwrap(), None);
    }

    #[test]
    fn save_roundtrip_backup_and_clean_file() {
        let dir = std::env::temp_dir().join(format!("op-cfg-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("print-server.json");
        let cfg = ServerConfig {
            connections: vec![DbConnection {
                id: "byb".into(),
                engine: "sqlite".into(),
                path: Some(r"F:\data\byb.db".into()),
                ..Default::default()
            }],
            scan_dirs: vec!["F:/data/db".into()],
            spool_dir: None,
        };
        cfg.save(&path).unwrap();
        let bak = PathBuf::from(format!("{}.bak", path.display()));
        assert!(!bak.exists(), "首次保存没有原文件，不应产生备份");

        let text = std::fs::read_to_string(&path).unwrap();
        // None 字段不落盘，文件保持干净
        assert!(!text.contains("password"));
        assert!(!text.contains("label"));
        assert!(!text.contains("spoolDir"));

        let back: ServerConfig = serde_json::from_str(&text).unwrap();
        assert_eq!(back.connections.len(), 1);
        assert_eq!(back.connections[0].path.as_deref(), Some(r"F:\data\byb.db"));
        assert_eq!(back.scan_dirs, vec!["F:/data/db".to_string()]);

        // 二次保存：先备份再覆盖
        cfg.save(&path).unwrap();
        assert!(bak.exists(), "覆盖前应生成 .bak 备份");
        // 临时文件不残留
        assert!(!PathBuf::from(format!("{}.tmp", path.display())).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn abs_display_falls_back_to_cwd() {
        let s = ServerConfig::abs_display(Path::new("no-such-file-xyz.json"));
        assert!(s.ends_with("no-such-file-xyz.json"));
        assert!(Path::new(&s).is_absolute(), "展示路径应为绝对路径: {s}");
    }
}
