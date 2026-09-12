//! GET /printers —— winspool 枚举本机打印机（对齐前端 PrinterInfo / PrinterListResponse）
//!
//! - 枚举：EnumPrintersW Level 2（名称/驱动/端口/属性/DevMode）
//! - 默认打印机：GetDefaultPrinterW
//! - 分辨率/双面/彩色：DevMode 的 dmFields + dmPrintQuality/dmYResolution/dmColor/dmDuplex
//! - 纸盒：DeviceCapabilitiesW(DC_BINNAMES)
//! - 全部失败时返回空列表（ok:true, count:0），前端有安全默认（defaultDpi 300）
//!
//! 平台：枚举实现依赖 winspool，仅 Windows 有效。macOS / Linux 上 `list_printers()`
//! 返回空列表——`/printers` 仍然 200 且 `count:0`，健康检查照常工作，
//! 这样报表引擎的渲染 / 导出接口可以在非 Windows 上开发调试。
//! （曾因此处未做 cfg 隔离，macOS 链接阶段报 `Undefined symbols: _DeviceCapabilitiesW`；
//!   `cargo test` 测不出来，因为测试 harness 替换了 main，路由不可达导致函数被死代码消除。）

use crate::AppState;
use axum::extract::State;
use axum::Json;
use serde_json::json;

/// 单台打印机（对齐前端 PrinterInfo 字段名）
pub struct PrinterInfo {
    pub name: String,
    pub driver: String,
    pub is_default: bool,
    pub is_online: bool,
    pub kind: &'static str,
    pub status: &'static str,
    pub default_dpi: i64,
    pub max_dpi: i64,
    pub supports_color: bool,
    pub supports_duplex: bool,
    pub trays: Vec<String>,
}

pub async fn list_printers_handler(
    State(_state): State<AppState>,
) -> Json<serde_json::Value> {
    let printers = list_printers().unwrap_or_default();
    let count = printers.len();
    let arr: Vec<serde_json::Value> = printers
        .into_iter()
        .map(|p| {
            json!({
                "name": p.name,
                "driver": p.driver,
                "isDefault": p.is_default,
                "isOnline": p.is_online,
                "kind": p.kind,
                "status": p.status,
                "defaultDpi": p.default_dpi,
                "maxDpi": p.max_dpi,
                "supportsColor": p.supports_color,
                "supportsDuplex": p.supports_duplex,
                "trays": p.trays,
            })
        })
        .collect();
    Json(json!({ "ok": true, "count": count, "printers": arr }))
}

/// 枚举本机打印机；任何 FFI 失败返回 Err（调用方降级为空列表）
#[cfg(target_os = "windows")]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    unsafe { enum_printers_level2() }
}

/// 非 Windows：无 winspool 可调，返回空列表（前端有安全默认 defaultDpi 300）
#[cfg(not(target_os = "windows"))]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    Ok(Vec::new())
}

// ───────── 以下为 winspool 实现，仅 Windows 参与编译 ─────────
// （避免 macOS / Linux 链接阶段找不到 Win32 符号）

#[cfg(target_os = "windows")]
use crate::util::{from_wide, to_wide};

// 手动定义所需常量（不依赖 windows-sys 常量导出面，避免 feature 缺口）
#[cfg(target_os = "windows")]
const PRINTER_ENUM_LOCAL: u32 = 0x2;
#[cfg(target_os = "windows")]
const PRINTER_ENUM_CONNECTIONS: u32 = 0x4;
#[cfg(target_os = "windows")]
const PRINTER_ATTRIBUTE_WORK_OFFLINE: u32 = 0x400;
#[cfg(target_os = "windows")]
const PRINTER_STATUS_ERROR_BITS: u32 = 0x2 | 0x80 | 0x1000; // ERROR | OFFLINE | NOT_AVAILABLE
#[cfg(target_os = "windows")]
const DM_PRINTQUALITY: u32 = 0x400;
#[cfg(target_os = "windows")]
const DM_COLOR: u32 = 0x800;
#[cfg(target_os = "windows")]
const DM_DUPLEX: u32 = 0x1000;
#[cfg(target_os = "windows")]
const DM_YRESOLUTION: u32 = 0x2000;
#[cfg(target_os = "windows")]
const DMCOLOR_COLOR: i16 = 2;
#[cfg(target_os = "windows")]
const DMDUP_SIMPLEX: i16 = 1;
#[cfg(target_os = "windows")]
const DC_BINNAMES: u16 = 12;
#[cfg(target_os = "windows")]
const BIN_NAME_LEN: usize = 24; // 每个 bin 名固定 24 wchar

#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::DEVMODEW;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Printing::{EnumPrintersW, GetDefaultPrinterW, PRINTER_INFO_2W};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::Xps::DeviceCapabilitiesW;

#[cfg(target_os = "windows")]
unsafe fn enum_printers_level2() -> Result<Vec<PrinterInfo>, String> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed: u32 = 0;
    let mut returned: u32 = 0;

    // 第一次调用探缓冲大小
    EnumPrintersW(flags, std::ptr::null(), 2, std::ptr::null_mut(), 0, &mut needed, &mut returned);
    if needed == 0 {
        return Ok(vec![]);
    }

    let mut buf: Vec<u8> = vec![0u8; needed as usize];
    let ok = EnumPrintersW(
        flags,
        std::ptr::null(),
        2,
        buf.as_mut_ptr(),
        needed,
        &mut needed,
        &mut returned,
    );
    if ok == 0 {
        return Err("EnumPrintersW 第二次调用失败".into());
    }

    let default_name = get_default_printer_name();
    let base = buf.as_ptr() as *const PRINTER_INFO_2W;
    let mut out = Vec::with_capacity(returned as usize);
    for i in 0..returned as isize {
        let info = &*base.offset(i);
        let name = from_wide(info.pPrinterName);
        if name.is_empty() {
            continue;
        }
        let driver = from_wide(info.pDriverName);
        let port = from_wide(info.pPortName);

        // 在线/状态
        let offline_flag = info.Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE != 0;
        let status_err = info.Status & PRINTER_STATUS_ERROR_BITS != 0;
        let is_online = !offline_flag;
        let status = if offline_flag || status_err { "error" } else { "idle" };

        // 分辨率 / 彩色 / 双面（来自 DevMode）
        let (default_dpi, max_dpi, color, duplex) = devmode_caps(info.pDevMode);

        // 纸盒
        let trays = bin_names(&name, &port);
        let is_default = default_name.as_deref() == Some(name.as_str());

        out.push(PrinterInfo {
            kind: classify_kind(&name),
            name,
            driver,
            is_default,
            is_online,
            status,
            default_dpi,
            max_dpi,
            supports_color: color,
            supports_duplex: duplex,
            trays,
        });
    }
    Ok(out)
}

#[cfg(target_os = "windows")]
unsafe fn get_default_printer_name() -> Option<String> {
    let mut needed: u32 = 0;
    GetDefaultPrinterW(std::ptr::null_mut(), &mut needed);
    if needed == 0 {
        return None;
    }
    let mut buf: Vec<u16> = vec![0u16; needed as usize];
    let ok = GetDefaultPrinterW(buf.as_mut_ptr(), &mut needed);
    if ok == 0 {
        return None;
    }
    Some(from_wide(buf.as_ptr()))
}

#[cfg(target_os = "windows")]
unsafe fn devmode_caps(dm: *mut DEVMODEW) -> (i64, i64, bool, bool) {
    if dm.is_null() {
        return (300, 0, false, false);
    }
    // windows-sys 0.59：dmPrintQuality 在 Anonymous1.Anonymous1（打印方向分组）；
    // dmColor/dmDuplex/dmYResolution 是 DEVMODEW 顶层字段（i16 新类型别名）
    let dm = &*dm;
    let pq: i16 = dm.Anonymous1.Anonymous1.dmPrintQuality;
    let mut default_dpi: i64 = 300;
    let mut max_dpi: i64 = 0;
    if dm.dmFields & DM_PRINTQUALITY != 0 && pq > 0 {
        default_dpi = pq as i64;
    }
    if dm.dmFields & DM_YRESOLUTION != 0 && dm.dmYResolution > 0 {
        max_dpi = max_dpi.max(dm.dmYResolution as i64);
        if default_dpi == 300 {
            default_dpi = default_dpi.max(dm.dmYResolution as i64);
        }
    }
    let color = dm.dmFields & DM_COLOR != 0 && dm.dmColor == DMCOLOR_COLOR;
    let duplex = dm.dmFields & DM_DUPLEX != 0 && dm.dmDuplex != DMDUP_SIMPLEX;
    (default_dpi, max_dpi, color, duplex)
}

#[cfg(target_os = "windows")]
unsafe fn bin_names(name: &str, port: &str) -> Vec<String> {
    let wname = to_wide(name);
    let wport = to_wide(port);
    let count = DeviceCapabilitiesW(
        wname.as_ptr(),
        wport.as_ptr(),
        DC_BINNAMES,
        std::ptr::null_mut(),
        std::ptr::null(),
    );
    if count <= 0 {
        return vec![];
    }
    let count = count as usize;
    let mut buf: Vec<u16> = vec![0u16; count * BIN_NAME_LEN];
    let got = DeviceCapabilitiesW(
        wname.as_ptr(),
        wport.as_ptr(),
        DC_BINNAMES,
        buf.as_mut_ptr(),
        std::ptr::null(),
    );
    if got <= 0 {
        return vec![];
    }
    let got = got as usize;
    (0..got)
        .filter_map(|i| {
            let start = i * BIN_NAME_LEN;
            let end = start + BIN_NAME_LEN;
            let name: String = buf[start..end]
                .iter()
                .take_while(|&&c| c != 0)
                .map(|&c| char::from_u32(c as u32).unwrap_or('?'))
                .collect();
            let name = name.trim().to_string();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn classify_kind(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if ["pdf", "xps", "onenote", "fax", "传真", "虚拟", "image writer"]
        .iter()
        .any(|k| n.contains(k))
    {
        "virtual"
    } else if ["票据", "标签", "receipt", "pos-", "label", "ticket"]
        .iter()
        .any(|k| n.contains(k))
    {
        "ticket"
    } else {
        "common"
    }
}
