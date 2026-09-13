//! OpenPrint 本地打印客户端服务（Rust 版）
//!
//! 对齐 `openprint/src/core/print-client/types.ts` 协议契约：
//!   GET  /health            服务健康与版本
//!   GET  /printers          打印机列表（winspool 枚举）
//!   POST /print             提交打印任务（pdf base64 / html utf8）
//!   GET  /api/fonts         枚举系统字体（含 TTF name 表解析出字体族名）
//!   GET  /api/fonts/data    拉取字体字节（精确 Content-Type，路径限制在字体目录内）
//!   GET  /api/data/*        数据库探索：databases / tables / columns / rows（sqlite / postgres 只读）
//!   GET  /                  可视化数据库配置页（同 /admin）
//!   */api/config/*          配置读写：查看 / 保存 / 试连 / 目录浏览
//!
//! 启动：`print-server.exe [--host 0.0.0.0] [--port 18888] [--config print-server.json]`

mod admin;
mod config;
mod db;
mod db_pg;
mod fonts;
mod health;
mod print_job;
mod printers;
mod report;
mod util;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post, put};
use axum::Router;
use tower_http::cors::CorsLayer;

use crate::config::ServerConfig;

/// 全局共享状态
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<ServerConfig>>,
    pub config_path: Arc<PathBuf>,
    pub started: Instant,
}

#[tokio::main]
async fn main() {
    // ---- 参数解析 ----
    let args: Vec<String> = std::env::args().collect();
    let mut host = String::from("127.0.0.1");
    let mut port: u16 = 18888;
    let mut config_path = std::env::var("OPENPRINT_PRINT_SERVER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("print-server.json"));
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--host" => {
                i += 1;
                host = args.get(i).cloned().unwrap_or(host);
            }
            "--port" => {
                i += 1;
                port = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(port);
            }
            "--lan" => host = "0.0.0.0".into(),
            "--config" => {
                i += 1;
                if let Some(p) = args.get(i) {
                    config_path = PathBuf::from(p);
                }
            }
            _ => {}
        }
        i += 1;
    }

    // ---- 配置 ----
    let (cfg, cfg_path) = ServerConfig::load(&config_path);
    let spool = cfg.spool_path();
    if let Err(e) = std::fs::create_dir_all(&spool) {
        eprintln!("[warn] 无法创建 spool 目录 {}: {e}", spool.display());
    }

    let state = AppState {
        config: Arc::new(RwLock::new(cfg)),
        config_path: Arc::new(cfg_path),
        started: Instant::now(),
    };
    let spool_display = spool
        .canonicalize()
        .unwrap_or(spool.clone())
        .display()
        .to_string();
    let cfg_path_display = state.config_path.display().to_string();

    let app = Router::new()
        .route("/", get(admin::index))
        .route("/admin", get(admin::index))
        .route("/health", get(health::health))
        .route("/printers", get(printers::list_printers_handler))
        .route("/print", post(print_job::handle_print))
        .route("/api/fonts", get(fonts::list_fonts))
        .route("/api/fonts/data", get(fonts::fonts_data))
        .route("/api/config", get(admin::get_config).put(admin::put_config))
        .route("/api/config/test", post(admin::test_connection))
        .route("/api/config/fs", get(admin::fs_list))
        .route("/api/data/databases", get(db::databases))
        .route("/api/data/tables", get(db::tables))
        .route("/api/data/columns", get(db::columns))
        .route("/api/data/rows", get(db::rows_get).post(db::rows_post))
        // 网格报表（类 Excel 非线性报表）：展开/求值在服务端完成，前端只做 UI
        .route("/api/report/render", post(report::render_handler))
        .route("/api/report/xlsx", post(report::xlsx_handler))
        .route("/api/report/sample", get(report::sample_handler))
        .route("/api/report/sample.xlsx", get(report::sample_xlsx_handler))
        .route("/api/report/sample-template", get(report::sample_template_handler))
        .route("/api/report/cross-tab-template", get(report::cross_tab_template_handler))
        .route(
            "/api/report/cross-tab-totals-template",
            get(report::cross_tab_totals_template_handler),
        )
        .route(
            "/api/report/cross-tab-two-metrics-totals",
            get(report::cross_tab_two_metrics_totals_handler),
        )
        .route("/api/report/cross-tab-two-metrics", get(report::cross_tab_two_metrics_handler))
        .route("/api/report/cross-tab-multi-level", get(report::cross_tab_multi_level_handler))
        // 报表定义文件（模板 + 数据源 + 选项）：存下来，打开就能跑
        .route("/api/reports", get(report::reports_list_handler))
        .route("/api/reports/save", put(report::reports_save_handler))
        .route("/api/reports/:id", get(report::reports_get_handler).delete(report::reports_delete_handler))
        .route("/api/reports/:id/run", post(report::reports_run_handler))
        .route("/api/reports/:id/xlsx", post(report::reports_xlsx_handler))
        .layer(DefaultBodyLimit::max(256 * 1024 * 1024)) // 大文档 base64 传输
        .layer(CorsLayer::permissive()) // 浏览器直连本机客户端，跨域放开
        .with_state(state);

    let addr = format!("{host}:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[error] 端口监听失败 {addr}: {e}");
            std::process::exit(1);
        }
    };

    println!("==============================================");
    println!("  OpenPrint 本地打印客户端（Rust 版）v{}",
             env!("CARGO_PKG_VERSION"));
    println!("  监听: http://{addr}");
    println!("  数据库配置界面: http://127.0.0.1:{port}/");
    println!("  设计器「设置 → 本地打印」填: http://127.0.0.1:{port}");
    println!("  数据库连接配置: {}", cfg_path_display);
    println!("  打印落盘目录: {}", spool_display);
    println!("==============================================");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[error] 服务异常退出: {e}");
        std::process::exit(1);
    }
}
