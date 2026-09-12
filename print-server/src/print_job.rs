//! POST /print —— 打印任务（对齐前端 PrintJobRequest / PrintJobResponse）
//!
//! 载荷支持：
//! - `pdf` + `base64`：落盘 spool → ShellExecuteW 打印（指定打印机用 printto 动词，缺省用默认打印机）
//! - `html` + `utf8`：注入 @page 纸张 CSS → Edge/Chrome headless 转 PDF → 同上打印（矢量、含文本层）
//! - `esc/tsc/zpl`：画布 JSON → 票据指令的翻译暂未实现，返回 ok:false
//! - `svg`：已废弃（原 Qt 客户端 QSvgRenderer 不支持 foreignObject），返回 ok:false
//!
//! 平台：发送打印在 Windows 走 ShellExecuteW，在 macOS / Linux 走 CUPS `lp`；
//! 渲染 / 导出链路与平台无关。

use crate::util::{decode_base64_lenient, service_error};
#[cfg(target_os = "windows")]
use crate::util::to_wide;
use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrintJobRequest {
    pub job_id: Option<String>,
    pub task_name: String,
    pub printer: String,
    pub format: String,
    pub encoding: String,
    pub content: String,
    pub pages: i64,
    pub width: f64,
    pub height: f64,
    pub unit: Option<String>,
    pub copies: i64,
    pub orientation: String,
    pub duplex: bool,
    pub color: bool,
    pub dpi: Option<i64>,
}

impl Default for PrintJobRequest {
    fn default() -> Self {
        Self {
            job_id: None,
            task_name: String::new(),
            printer: String::new(),
            format: "pdf".into(),
            encoding: "base64".into(),
            content: String::new(),
            pages: 1,
            width: 210.0,
            height: 297.0,
            unit: None,
            copies: 1,
            orientation: "portrait".into(),
            duplex: false,
            color: false,
            dpi: None,
        }
    }
}

pub async fn handle_print(
    State(state): State<AppState>,
    Json(job): Json<PrintJobRequest>,
) -> axum::response::Response {
    let job_id = job
        .job_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(generate_job_id);

    let spool = state.config.read().unwrap().spool_path();
    if let Err(e) = std::fs::create_dir_all(&spool) {
        return service_error(format!("无法创建 spool 目录 {}: {e}", spool.display()));
    }

    match job.format.as_str() {
        "pdf" => print_pdf(&job, &job_id, &spool),
        "html" => print_html(&job, &job_id, &spool).await,
        "svg" => service_error("svg 载荷已废弃：请改用 html（矢量推荐）或 pdf（位图）"),
        "esc" | "tsc" | "zpl" => service_error(format!(
            "Rust 客户端暂不支持 {} 画布 JSON → 票据指令翻译（待实现），任务 {} 未打印",
            job.format.to_uppercase(),
            job_id
        )),
        other => service_error(format!("未知载荷格式: {other}")),
    }
}

/* ------------------------------ pdf ------------------------------ */

fn print_pdf(job: &PrintJobRequest, job_id: &str, spool: &Path) -> axum::response::Response {
    if job.encoding != "base64" {
        return service_error(format!(
            "pdf 载荷要求 encoding=base64，收到 {}",
            job.encoding
        ));
    }
    let bytes = match decode_base64_lenient(&job.content) {
        Ok(b) => b,
        Err(e) => return service_error(e),
    };
    if bytes.len() < 5 || &bytes[..5] != b"%PDF-" {
        return service_error("content 解码后不是合法 PDF（缺少 %PDF- 头）");
    }
    let pdf_path = spool.join(format!("{job_id}.pdf"));
    if let Err(e) = std::fs::write(&pdf_path, &bytes) {
        return service_error(format!("写 PDF 文件失败: {e}"));
    }
    send_to_printer(&pdf_path, &job.printer, &format!("任务 {job_id}（{} 页）", job.pages))
}

/* ------------------------------ html ------------------------------ */

async fn print_html(
    job: &PrintJobRequest,
    job_id: &str,
    spool: &Path,
) -> axum::response::Response {
    if job.encoding != "utf8" {
        return service_error(format!(
            "html 载荷要求 encoding=utf8，收到 {}",
            job.encoding
        ));
    }
    let html_path = spool.join(format!("{job_id}.html"));
    let final_html = inject_page_css(&job.content, job.width, job.height, &job.orientation);
    if let Err(e) = std::fs::write(&html_path, final_html) {
        return service_error(format!("写 HTML 文件失败: {e}"));
    }

    let Some(browser) = find_browser() else {
        return axum::response::IntoResponse::into_response(Json(json!({
            "ok": true,
            "jobId": job_id,
            "message": format!("HTML 已保存至 {}（本机未找到 Edge/Chrome，未转 PDF 打印）", html_path.display()),
        })));
    };

    let pdf_path = spool.join(format!("{job_id}.pdf"));
    let url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));
    let mut cmd = tokio::process::Command::new(&browser);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        &format!("--print-to-pdf={}", pdf_path.display()),
        &url,
    ]);
    let result = tokio::time::timeout(Duration::from_secs(60), cmd.output()).await;
    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return service_error(format!(
                "浏览器转 PDF 启动失败（{}）: {e}；HTML 已保存至 {}",
                browser.display(),
                html_path.display()
            ))
        }
        Err(_) => {
            return service_error(format!(
                "浏览器转 PDF 超时（60s）；HTML 已保存至 {}",
                html_path.display()
            ))
        }
    };
    if !output.status.success() || !pdf_path.exists() {
        return service_error(format!(
            "浏览器转 PDF 失败（exit {:?}）；HTML 已保存至 {}",
            output.status.code(),
            html_path.display()
        ));
    }
    send_to_printer(&pdf_path, &job.printer, &format!("任务 {job_id}（HTML 矢量，{} 页）", job.pages))
}

/// 注入 @page 纸张 CSS（宽高 mm + margin 0），保证纸张尺寸与模板一致、内容不错位
fn inject_page_css(html: &str, width_mm: f64, height_mm: f64, orientation: &str) -> String {
    let (mut w, mut h) = (width_mm, height_mm);
    if orientation.eq_ignore_ascii_case("landscape") && w < h {
        std::mem::swap(&mut w, &mut h);
    }
    let css = format!(
        "<style>@page{{size:{:.3}mm {:.3}mm;margin:0}}html,body{{margin:0}}</style>",
        w, h
    );
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("</head>") {
        let mut out = String::with_capacity(html.len() + css.len());
        out.push_str(&html[..pos]);
        out.push_str(&css);
        out.push_str(&html[pos..]);
        out
    } else if let Some(pos) = lower.find("<body") {
        let mut out = String::with_capacity(html.len() + css.len());
        out.push_str(&html[..pos]);
        out.push_str(&css);
        out.push_str(&html[pos..]);
        out
    } else {
        format!("{css}{html}")
    }
}

/// 按优先级找可用的 headless 浏览器
fn find_browser() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    #[cfg(target_os = "macos")]
    let candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let candidates = ["/usr/bin/chromium", "/usr/bin/google-chrome"];
    candidates.iter().map(PathBuf::from).find(|p| p.exists())
}

/* ------------------------------ 发送打印 ------------------------------ */

/// 优先 printto（指定打印机），失败回落默认打印机 print 动词
fn send_to_printer(pdf_path: &Path, printer: &str, ctx: &str) -> axum::response::Response {
    if !printer.trim().is_empty() {
        match shell_print(pdf_path, "printto", Some(printer)) {
            Ok(()) => {
                return axum::response::IntoResponse::into_response(Json(json!({
                    "ok": true,
                    "message": format!("{ctx} 已发送至打印机「{printer}」"),
                })))
            }
            Err(e) => {
                eprintln!("[warn] printto「{printer}」失败（{e}），回落默认打印机");
            }
        }
    }
    match shell_print(pdf_path, "print", None) {
        Ok(()) => axum::response::IntoResponse::into_response(Json(json!({
            "ok": true,
            "message": format!("{ctx} 已发送至系统默认打印机（PDF: {}）", pdf_path.display()),
        }))),
        Err(e) => service_error(format!(
            "{ctx} 已保存至 {}，但发送打印失败：{e}（请确认本机已安装 PDF 阅读器并设为 .pdf 默认打开方式）",
            pdf_path.display()
        )),
    }
}

/// ShellExecuteW 调用系统 PDF 处理器打印
/// - verb "print"：用默认关联程序打印（走默认打印机）
/// - verb "printto"：参数为打印机名
#[cfg(target_os = "windows")]
fn shell_print(file: &Path, verb: &str, printer: Option<&str>) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let op = to_wide(verb);
    let path = to_wide(&file.to_string_lossy());
    let params = to_wide(printer.unwrap_or(""));
    let h = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            path.as_ptr(),
            if printer.is_some() { params.as_ptr() } else { std::ptr::null() },
            std::ptr::null(),
            0, // SW_HIDE
        )
    };
    let code = h as isize;
    if code > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecuteW({verb}) 返回 {code}"))
    }
}

/// macOS / Linux：走 CUPS `lp`
/// - verb "printto" 且给了打印机名 → `lp -d <printer> <file>`
/// - verb "print"（缺省打印机）→ `lp <file>`
///
/// 这样非 Windows 上报表渲染 / 导出 / 打印链路仍可端到端自测，
/// 不必先装 Windows 才能跑通。副本数沿用 `lp -n`，其余选项（双面/彩色）
/// CUPS 侧由打印机默认策略决定，与 Windows 分支行为一致（都交给驱动）。
#[cfg(not(target_os = "windows"))]
fn shell_print(file: &Path, _verb: &str, printer: Option<&str>) -> Result<(), String> {
    let mut cmd = std::process::Command::new("lp");
    if let Some(p) = printer.map(str::trim).filter(|p| !p.is_empty()) {
        cmd.arg("-d").arg(p);
    }
    cmd.arg(file);
    let out = cmd.output().map_err(|e| format!("调用 lp 失败：{e}（请确认 CUPS 已安装）"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "lp 退出码 {:?}：{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/* ------------------------------ 任务号 ------------------------------ */

/// 与前端 generateJobId 同构：MMDD + 6 位随机，共 10 位
pub fn generate_job_id() -> String {
    let now = chrono::Local::now();
    let mm = now.format("%m");
    let dd = now.format("%d");
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0)
        ^ (std::process::id() as u64);
    let rand = seed % 1_000_000;
    format!("{mm}{dd}{rand:06}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_css_injected_before_head_close() {
        let html = "<html><head><title>x</title></head><body>p</body></html>";
        let out = inject_page_css(html, 210.0, 297.0, "portrait");
        assert!(out.contains("@page{size:210.000mm 297.000mm;margin:0}"));
        assert!(out.find("@page").unwrap() < out.find("</head>").unwrap());
    }

    #[test]
    fn page_css_landscape_swaps() {
        let out = inject_page_css("<body></body>", 210.0, 297.0, "landscape");
        assert!(out.contains("@page{size:297.000mm 210.000mm;margin:0}"));
    }

    #[test]
    fn page_css_without_head_prepends() {
        let out = inject_page_css("<p>hi</p>", 100.0, 150.0, "portrait");
        assert!(out.starts_with("<style>@page"));
    }

    #[test]
    fn job_id_shape() {
        let id = generate_job_id();
        assert_eq!(id.len(), 10);
        assert!(id.chars().all(|c| c.is_ascii_digit()));
    }
}
