//! GET /health —— 服务健康与版本（对齐前端 PrinterHealth）

use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde_json::json;

pub async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    // 打印机枚举即时做一次（本地 winspool，毫秒级）；失败按 0 台上报，不影响 ok
    let printers = crate::printers::list_printers()
        .map(|p| p.len())
        .unwrap_or(0);
    Json(json!({
        "app": "OpenPrint Client",
        "ok": true,
        "printers": printers,
        "time": chrono::Local::now().to_rfc3339(),
        "uptimeSec": state.started.elapsed().as_secs(),
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
