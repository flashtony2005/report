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
    // ---- 命令行子命令：不启服务，干完就退出 ----
    // 让报表文件能被 cron / 脚本直接用，而不必起前端设计器。
    let cli = match CliCommand::parse(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[error] {e}");
            eprintln!();
            eprint!("{}", CliCommand::usage());
            std::process::exit(2);
        }
    };
    if let Some(cmd) = cli {
        let code = match cmd {
            CliCommand::Help => {
                print!("{}", CliCommand::usage());
                0
            }
            CliCommand::ListReports => match report::store::list(&report::store::reports_dir(&state.config_path)) {
                Ok(list) => {
                    if list.is_empty() {
                        println!("（还没有保存过报表）目录：{}", report::store::reports_dir(&state.config_path).display());
                    } else {
                        for r in list.iter() {
                            println!(
                                "{} {} {:>2} 数据源 {:>8} 字节  更新 {}",
                                pad_right(&clip_to_width(&r.id, 26), 26),
                                pad_right(&clip_to_width(&r.name, 20), 20),
                                r.source_count,
                                r.bytes,
                                r.updated_at.as_deref().unwrap_or("-")
                            );
                        }
                    }
                    0
                }
                Err(e) => {
                    eprintln!("[error] {e}");
                    1
                }
            },
            CliCommand::RunReport { id, params, param_pairs, out } => {
                // 参数拼装放在这里，而不是 parse 里：这样 --params 的 JSON 报错
                // 和 --param 的格式报错都能给到人话，退出码也统一是 2（用法错误）。
                let mut map = match params.as_deref().map(report::parse_cli_params).transpose() {
                    Ok(m) => m.unwrap_or_default(),
                    Err(e) => {
                        eprintln!("[error] {e}");
                        std::process::exit(2);
                    }
                };
                for (k, v) in param_pairs.iter() {
                    if let Err(e) = report::merge_cli_param(&mut map, k, v) {
                        eprintln!("[error] {e}");
                        std::process::exit(2);
                    }
                }
                // 一个参数都没给 → None，表示「不动定义里的默认参数」，
                // 而不是「把参数清空」。两者语义不同，不能混。
                let params = if params.is_none() && param_pairs.is_empty() {
                    None
                } else {
                    Some(map)
                };
                match report::run_report_cli(&state, &id, params, out.as_deref()).await {
                    Ok(text) => {
                        println!("{text}");
                        0
                    }
                    Err(e) => {
                        eprintln!("[error] {e}");
                        1
                    }
                }
            }
        };
        std::process::exit(code);
    }

    let spool_display = spool
        .canonicalize()
        .unwrap_or(spool.clone())
        .display()
        .to_string();
    let cfg_path_display = state.config_path.display().to_string();
    // 报表目录是从**配置路径**推出来的（见 report::store::reports_dir），而配置路径
    // 默认是相对路径 `print-server.json` —— 也就是「从哪个目录启动」决定了看见哪个
    // `reports/`。从错的目录启动时列表会是空的、且没有任何报错，所以必须打出来。
    let reports_display = ServerConfig::abs_display(&report::store::reports_dir(
        state.config_path.as_ref(),
    ));

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
    println!("  报表目录: {}", reports_display);
    println!("==============================================");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[error] 服务异常退出: {e}");
        std::process::exit(1);
    }
}

/* ------------------------------ 命令行子命令 ------------------------------ */

/// 单个字符在终端里占几格。CJK 全角占 2 格，其余占 1 格。
fn char_width(c: char) -> usize {
    let u = c as u32;
    let wide = matches!(u,
        0x1100..=0x115F        // 韩文字母
        | 0x2E80..=0xA4CF      // CJK 部首 / 假名 / 注音 / 汉字
        | 0xAC00..=0xD7A3      // 韩文音节
        | 0xF900..=0xFAFF      // CJK 兼容汉字
        | 0xFE30..=0xFE6F      // CJK 兼容形式
        | 0xFF00..=0xFF60      // 全角形式
        | 0xFFE0..=0xFFE6
        | 0x20000..=0x3FFFD    // CJK 扩展 B 及以上
    );
    if wide {
        2
    } else {
        1
    }
}

/// 字符串在终端里占几格
fn display_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

/// 按**显示宽度**左对齐补空格。
///
/// 不能用 `{:<20}`：它按字符数补，而「地区销售汇总」只有 6 个字符却占 12 格，
/// 补出来的列在终端里是歪的。列表页靠对齐才能扫读，所以这里自己算宽度。
fn pad_right(s: &str, width: usize) -> String {
    let w = display_width(s);
    let mut out = String::from(s);
    if w < width {
        out.push_str(&" ".repeat(width - w));
    }
    out
}

/// 截断到显示宽度，超出部分用 `…` 收尾。
///
/// 补空格只能救「太窄」的列；名字太长会顶破后面的列，整张表就散了。
/// 这里选择截断而不是放任溢出：id 才是机器可读的键，名字只是给人认的，
/// 而且 `…` 本身就提示「还有内容，去看 id」。
fn clip_to_width(s: &str, width: usize) -> String {
    if display_width(s) <= width {
        return s.to_string();
    }
    let budget = width.saturating_sub(1); // 给 … 留一格
    let mut out = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = char_width(c);
        if w + cw > budget {
            break;
        }
        out.push(c);
        w += cw;
    }
    out.push('…');
    out
}

/// 报表命令行。命中任一子命令就不启 HTTP 服务，跑完即退。
///
/// 为什么要有：存下来的报表定义是纯 JSON，本该能被 cron / 脚本直接跑。
/// 只能「打开设计器点一下执行」等于把报表锁在 UI 里。
///
/// 参数故意**不在这里解析 JSON**：`--params` / `--param` 原样收着，
/// 交给 `report::parse_cli_params` / `report::merge_cli_param` 处理，
/// 这样校验规则只有一份，命令行和 HTTP 接口不会走偏。
#[derive(Debug, PartialEq)]
enum CliCommand {
    Help,
    ListReports,
    RunReport {
        id: String,
        /// `--params` 的原始 JSON 文本
        params: Option<String>,
        /// `--param k=v`，可重复；后写的覆盖先写的
        param_pairs: Vec<(String, String)>,
        /// `--out` 导出路径；不给就打印文本表格
        out: Option<PathBuf>,
    },
}

impl CliCommand {
    /// 解析子命令。返回 `Ok(None)` 表示「没有子命令，正常启服务」；
    /// `Err` 表示用法写错了（调用方应打印 usage 并以 2 退出）。
    fn parse(args: &[String]) -> Result<Option<CliCommand>, String> {
        let mut cmd: Option<CliCommand> = None;
        let mut params: Option<String> = None;
        let mut param_pairs: Vec<(String, String)> = Vec::new();
        let mut out: Option<PathBuf> = None;
        let mut want_help = false;

        let mut i = 1;
        while i < args.len() {
            match args[i].as_str() {
                "-h" | "--help" => want_help = true,
                "--list-reports" | "-l" => {
                    if cmd.is_some() {
                        return Err("--list-reports 和 --run-report 只能给一个".into());
                    }
                    cmd = Some(CliCommand::ListReports);
                }
                "--run-report" | "-r" => {
                    if cmd.is_some() {
                        return Err("--list-reports 和 --run-report 只能给一个".into());
                    }
                    i += 1;
                    let id = args
                        .get(i)
                        .ok_or("--run-report 后面要跟报表 id，例如 --run-report sales-by-region")?
                        .clone();
                    // 少写一个 id 时，下一个 --flag 会被当成 id 吞掉，
                    // 结果就是「找不到报表 xxx」这种莫名其妙的报错。提前拦。
                    if id.starts_with('-') {
                        return Err(format!("--run-report 后面要跟报表 id，但拿到的是参数 {id}"));
                    }
                    cmd = Some(CliCommand::RunReport {
                        id,
                        params: None,
                        param_pairs: Vec::new(),
                        out: None,
                    });
                }
                "--params" => {
                    i += 1;
                    params = Some(
                        args.get(i)
                            .ok_or("--params 后面要跟 JSON，例如 --params '{\"ds1\":[\"华东\"]}'")?
                            .clone(),
                    );
                }
                "--param" => {
                    i += 1;
                    let kv = args.get(i).ok_or("--param 后面要跟 k=v，例如 --param ds1=华东")?;
                    let (k, v) = kv
                        .split_once('=')
                        .ok_or_else(|| format!("--param 的写法是 k=v，拿到的是 {kv}"))?;
                    param_pairs.push((k.to_string(), v.to_string()));
                }
                "--out" | "-o" => {
                    i += 1;
                    out = Some(PathBuf::from(
                        args.get(i).ok_or("--out 后面要跟文件路径，例如 --out 销售.xlsx")?,
                    ));
                }
                _ => {} // --host / --port / --config 等交给上面的主循环
            }
            i += 1;
        }

        if want_help {
            return Ok(Some(CliCommand::Help));
        }

        // 只给参数不给 --run-report：静默忽略的话，用户会以为参数生效了，
        // 报表却按默认参数跑出来 —— 这种「看起来成功」的错误最难查。
        let stray = params.is_some() || !param_pairs.is_empty() || out.is_some();
        match cmd {
            None => {
                if stray {
                    return Err("--params / --param / --out 要跟 --run-report 一起用".into());
                }
                Ok(None)
            }
            Some(CliCommand::ListReports) => {
                if stray {
                    return Err("--list-reports 不接受 --params / --param / --out".into());
                }
                Ok(Some(CliCommand::ListReports))
            }
            Some(CliCommand::RunReport { id, .. }) => Ok(Some(CliCommand::RunReport {
                id,
                params,
                param_pairs,
                out,
            })),
            Some(other) => Ok(Some(other)),
        }
    }

    fn usage() -> &'static str {
        "报表命令行（跑完即退，不起服务）：\n\
         \n\
         \x20 print-server --list-reports\n\
         \x20     列出已保存的报表：id / 名称 / 数据源数 / 大小 / 更新时间\n\
         \n\
         \x20 print-server --run-report <id> [参数] [--out 文件.xlsx]\n\
         \x20     执行报表。不给 --out 就在终端打印文本表格，给了就导出 xlsx。\n\
         \n\
         \x20     参数两种写法，可混用：\n\
         \x20       --param ds1=华东             单个参数，可重复；后写的覆盖先写的\n\
         \x20       --params '{\"ds1\":[\"华东\"]}'  一次给全，值是数组\n\
         \n\
         \x20 例子：\n\
         \x20   print-server --list-reports\n\
         \x20   print-server --run-report sales-by-region\n\
         \x20   print-server --run-report sales-by-region --param ds1=华南\n\
         \x20   print-server --run-report sales-by-region --out /tmp/销售.xlsx\n\
         \n\
         \x20 --config <路径>   指定配置文件；报表默认存在配置文件同级的 reports/ 目录\n\
         \x20 -h, --help        显示本帮助\n"
    }
}

#[cfg(test)]
mod cli_tests {
    use super::CliCommand;
    use std::path::PathBuf;

    fn args(s: &[&str]) -> Vec<String> {
        std::iter::once("print-server".to_string())
            .chain(s.iter().map(|x| x.to_string()))
            .collect()
    }

    #[test]
    fn 没有子命令就返回_none_正常启服务() {
        // 这些是原有参数，不该被当成子命令
        let got = CliCommand::parse(&args(&["--host", "0.0.0.0", "--port", "18888"])).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn 列出报表() {
        assert_eq!(
            CliCommand::parse(&args(&["--list-reports"])).unwrap(),
            Some(CliCommand::ListReports)
        );
        // 短别名
        assert_eq!(CliCommand::parse(&args(&["-l"])).unwrap(), Some(CliCommand::ListReports));
    }

    #[test]
    fn 执行报表_基本形态() {
        assert_eq!(
            CliCommand::parse(&args(&["--run-report", "sales-by-region"])).unwrap(),
            Some(CliCommand::RunReport {
                id: "sales-by-region".into(),
                params: None,
                param_pairs: vec![],
                out: None,
            })
        );
    }

    #[test]
    fn 执行报表_参数与导出路径() {
        let got = CliCommand::parse(&args(&[
            "--run-report",
            "sales-by-region",
            "--param",
            "ds1=华东",
            "--param",
            "ds2=2026",
            "--params",
            r#"{"ds3":["A"]}"#,
            "--out",
            "/tmp/销售.xlsx",
        ]))
        .unwrap();
        assert_eq!(
            got,
            Some(CliCommand::RunReport {
                id: "sales-by-region".into(),
                params: Some(r#"{"ds3":["A"]}"#.into()),
                param_pairs: vec![("ds1".into(), "华东".into()), ("ds2".into(), "2026".into())],
                out: Some(PathBuf::from("/tmp/销售.xlsx")),
            })
        );
    }

    #[test]
    fn 用法写错要给人话() {
        // 少写 id：不能把 --out 当 id 吞掉
        let e = CliCommand::parse(&args(&["--run-report", "--out", "a.xlsx"])).unwrap_err();
        assert!(e.contains("要跟报表 id"), "实际：{e}");

        // 两个子命令互斥
        let e = CliCommand::parse(&args(&["--list-reports", "--run-report", "x"])).unwrap_err();
        assert!(e.contains("只能给一个"), "实际：{e}");

        // 参数没处挂：静默忽略会让用户以为参数生效了
        let e = CliCommand::parse(&args(&["--param", "ds1=华东"])).unwrap_err();
        assert!(e.contains("要跟 --run-report 一起用"), "实际：{e}");

        // --param 缺 =
        let e = CliCommand::parse(&args(&["--run-report", "x", "--param", "ds1"])).unwrap_err();
        assert!(e.contains("k=v"), "实际：{e}");
    }

    #[test]
    fn help_优先且不需要其它子命令() {
        assert_eq!(CliCommand::parse(&args(&["--help"])).unwrap(), Some(CliCommand::Help));
        assert_eq!(CliCommand::parse(&args(&["-h"])).unwrap(), Some(CliCommand::Help));
    }

    #[test]
    fn 列宽按显示宽度算_中文占两格() {
        use super::{char_width, display_width, pad_right};

        assert_eq!(char_width('a'), 1);
        assert_eq!(char_width('中'), 2);
        assert_eq!(char_width('　'), 2); // 全角空格

        // 中文名补到 20 格：6 个汉字 = 12 格，差 8 个空格
        assert_eq!(pad_right("地区销售汇总", 20), "地区销售汇总        ");
        assert_eq!(display_width(&pad_right("地区销售汇总", 20)), 20);

        // 英文 id 不受影响，仍按字符数补
        assert_eq!(pad_right("sales", 10), "sales     ");

        // 刚好等于宽度就不补
        assert_eq!(pad_right("地区销售汇总表", 14), "地区销售汇总表");
    }

    #[test]
    fn 超宽要截断_保住列对齐() {
        use super::{clip_to_width, display_width, pad_right};

        // 放得下就原样返回，不无谓地加 …
        assert_eq!(clip_to_width("地区销售汇总", 20), "地区销售汇总");

        // 超宽：截到 20 格以内，并以 … 收尾
        let long = "一个名字特别长的报表用来验证列对齐";
        let clipped = clip_to_width(long, 20);
        assert!(clipped.ends_with('…'), "实际：{clipped}");
        assert!(display_width(&clipped) <= 20, "实际宽度 {}", display_width(&clipped));

        // 截断后补空格，总宽度恰好等于列宽 —— 后面的列才不会错开
        assert_eq!(display_width(&pad_right(&clipped, 20)), 20);

        // 汉字不能被劈成半个：预算 19 格 → 最多 9 个汉字（18 格）+ …
        assert_eq!(clip_to_width(long, 20), "一个名字特别长的报…");
    }
}
