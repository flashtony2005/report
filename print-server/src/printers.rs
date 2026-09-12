//! GET /printers —— winspool 枚举本机打印机（对齐前端 PrinterInfo / PrinterListResponse）
//!
//! - 枚举：EnumPrintersW Level 2（名称/驱动/端口/属性/DevMode）
//! - 默认打印机：GetDefaultPrinterW
//! - 分辨率/双面/彩色：DevMode 的 dmFields + dmPrintQuality/dmYResolution/dmColor/dmDuplex
//! - 纸盒：DeviceCapabilitiesW(DC_BINNAMES)
//! - 全部失败时返回空列表（ok:true, count:0），前端有安全默认（defaultDpi 300）
//!
//! 平台：两路实现
//! - Windows：EnumPrintersW / DeviceCapabilitiesW（winspool）
//! - macOS / Linux：CUPS 命令行（`lpstat` / `lpoptions`）
//!
//! 两路都失败时返回空列表（ok:true, count:0），前端有安全默认（defaultDpi 300）。
//! （曾因 winspool 未做 cfg 隔离，macOS 链接阶段报 `Undefined symbols: _DeviceCapabilitiesW`；
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

/// 非 Windows：走 CUPS 命令行枚举
#[cfg(not(target_os = "windows"))]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    cups_list_printers()
}

// ───────── 以下为 CUPS 实现，仅 macOS / Linux 参与编译 ─────────

/// 跑一条 CUPS 命令，取 stdout。
///
/// 不检查退出码：`lpstat -a` 在没有配任何队列时会退出 1 并把提示打到 stderr，
/// 这不是错误，只是「没有打印机」，交给解析函数返回空列表即可。
#[cfg(not(target_os = "windows"))]
fn run_cups(prog: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(prog)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .output()
        .map_err(|e| format!("执行 {} {:?} 失败: {}", prog, args, e))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `lpstat -a` → [(队列名, 是否接受任务)]
///
/// 形如 `HP_LaserJet accepting requests since Thu 01 Jan 2026 10:00:00 AM`，
/// 暂停队列是 `rejecting requests`。其它行（错误提示 / 续行）一律忽略。
#[cfg(not(target_os = "windows"))]
fn parse_lpstat_a(out: &str) -> Vec<(String, bool)> {
    let mut v = Vec::new();
    for line in out.lines() {
        let mut it = line.split_whitespace();
        let name = match it.next() {
            Some(n) => n,
            None => continue,
        };
        match it.next() {
            Some("accepting") => v.push((name.to_string(), true)),
            Some("rejecting") => v.push((name.to_string(), false)),
            _ => {}
        }
    }
    v
}

/// `lpstat -d` → 系统默认队列名；没有默认队列时返回 None
#[cfg(not(target_os = "windows"))]
fn parse_lpstat_d(out: &str) -> Option<String> {
    let line = out.lines().next()?.trim();
    let rest = line.strip_prefix("system default destination:")?;
    let name = rest.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// `lpstat -l -p` → 队列名 → (状态, 描述)
///
/// 状态行形如 `printer Foo is idle.  enabled since ...` / `printer Foo disabled since ...`
/// / `printer Foo now printing Foo-42.  enabled since ...`；
/// 随后的 `Description: xxx` 是缩进续行（可能没有）。
#[cfg(not(target_os = "windows"))]
fn parse_lpstat_l_p(out: &str) -> std::collections::BTreeMap<String, (String, String)> {
    use std::collections::BTreeMap;
    let mut m: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut cur: Option<String> = None;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("printer ") {
            let mut it = rest.split_whitespace();
            let name = it.next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let tail = it.collect::<Vec<_>>().join(" ").to_lowercase();
            let status = if tail.contains("disabled") {
                "error"
            } else if tail.contains("printing") {
                "busy"
            } else {
                "idle"
            };
            m.insert(name.clone(), (status.to_string(), String::new()));
            cur = Some(name);
            continue;
        }
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Description:") {
            let d = rest.trim().to_string();
            if !d.is_empty() {
                if let Some(entry) = cur.as_ref().and_then(|k| m.get_mut(k)) {
                    entry.1 = d;
                }
            }
        }
    }
    m
}

/// `lpoptions -p NAME -l` 解析出的能力
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Default, PartialEq)]
struct CupsCaps {
    supports_color: bool,
    supports_duplex: bool,
    trays: Vec<String>,
    default_dpi: i64,
    max_dpi: i64,
}

/// `lpoptions -p NAME -l` → 能力。
///
/// 每行形如 `Duplex/Double-Sided Printing: *None DuplexNoTumble DuplexTumble`。
/// 列出的选项即打印机支持的值，所以「支持」判断看有没有该项，而不是看默认选中哪个；
/// 默认选中的那个带 `*` 前缀，用来定 default_dpi。
#[cfg(not(target_os = "windows"))]
fn parse_lpoptions_l(out: &str) -> CupsCaps {
    let mut caps = CupsCaps {
        default_dpi: 300,
        ..Default::default()
    };
    for line in out.lines() {
        let (label, choices) = match line.split_once(':') {
            Some((a, b)) => (a, b),
            None => continue,
        };
        let label_l = label.to_lowercase();
        let choices: Vec<&str> = choices.split_whitespace().collect();
        let bare = |c: &&str| c.trim_start_matches('*').to_lowercase();

        if label_l.contains("duplex") {
            caps.supports_duplex = choices
                .iter()
                .map(bare)
                .any(|c| c.contains("duplextumble") || c.contains("duplexnotumble"));
        } else if label_l.contains("colormodel") || label_l.contains("color model") {
            caps.supports_color = choices
                .iter()
                .map(bare)
                .any(|c| c.contains("rgb") || c.contains("cmyk") || c.contains("color"));
        } else if label_l.contains("inputslot")
            || label_l.contains("media source")
            || label_l.contains("mediasource")
        {
            // 纸盒名是给用户看的，保留原始大小写（bare() 只用于比较）
            caps.trays = choices
                .iter()
                .map(|c| c.trim_start_matches('*').to_string())
                .collect();
        } else if label_l.contains("resolution") {
            let nums: Vec<i64> = choices
                .iter()
                .map(bare)
                .filter_map(|c| {
                    c.chars()
                        .take_while(|ch| ch.is_ascii_digit())
                        .collect::<String>()
                        .parse::<i64>()
                        .ok()
                })
                .collect();
            if let Some(&mx) = nums.iter().max() {
                caps.max_dpi = mx;
            }
            // 默认选中的（带 `*`）那条作为 default_dpi
            let starred = choices
                .iter()
                .find(|c| c.starts_with('*'))
                .and_then(|c| {
                    c.trim_start_matches('*')
                        .chars()
                        .take_while(|ch| ch.is_ascii_digit())
                        .collect::<String>()
                        .parse::<i64>()
                        .ok()
                })
                .filter(|&n| n > 0);
            if let Some(n) = starred {
                caps.default_dpi = n;
            }
        }
    }
    caps
}

#[cfg(not(target_os = "windows"))]
fn cups_list_printers() -> Result<Vec<PrinterInfo>, String> {
    // lpstat 不存在（精简容器 / 未装 CUPS）→ Err → 调用方降级为空列表
    let list = parse_lpstat_a(&run_cups("lpstat", &["-a"])?);
    if list.is_empty() {
        return Ok(Vec::new());
    }

    let default_name = run_cups("lpstat", &["-d"])
        .ok()
        .and_then(|s| parse_lpstat_d(&s));
    let statuses = run_cups("lpstat", &["-l", "-p"])
        .ok()
        .map(|s| parse_lpstat_l_p(&s))
        .unwrap_or_default();

    let mut out = Vec::with_capacity(list.len());
    for (name, accepting) in list {
        let (st, desc) = statuses
            .get(&name)
            .cloned()
            .unwrap_or_else(|| (String::from("idle"), String::new()));
        let status: &'static str = if !accepting || st == "error" {
            "error"
        } else if st == "busy" {
            "busy"
        } else {
            "idle"
        };
        let caps = run_cups("lpoptions", &["-p", &name, "-l"])
            .ok()
            .map(|s| parse_lpoptions_l(&s))
            .unwrap_or_default();

        out.push(PrinterInfo {
            kind: classify_kind(&name),
            is_default: default_name.as_deref() == Some(name.as_str()),
            is_online: status != "error",
            status,
            default_dpi: caps.default_dpi,
            max_dpi: caps.max_dpi,
            supports_color: caps.supports_color,
            supports_duplex: caps.supports_duplex,
            trays: caps.trays,
            driver: if desc.is_empty() { "cups".to_string() } else { desc },
            name,
        });
    }
    Ok(out)
}

#[cfg(all(test, not(target_os = "windows")))]
mod cups_tests {
    use super::*;

    #[test]
    fn parses_lpstat_a() {
        let out = "\
HP_LaserJet accepting requests since Thu 01 Jan 2026 10:00:00 AM
Brother_QL rejecting requests since Thu 01 Jan 2026 10:00:00 AM
	Reason: Paused
";
        assert_eq!(
            parse_lpstat_a(out),
            vec![
                ("HP_LaserJet".to_string(), true),
                ("Brother_QL".to_string(), false),
            ]
        );
    }

    #[test]
    fn parses_lpstat_a_empty_when_no_destination() {
        // 没配队列时 lpstat 把提示打到 stderr，stdout 为空
        assert!(parse_lpstat_a("").is_empty());
        // 万一提示混进 stdout，也不能当成一台打印机
        assert!(parse_lpstat_a("lpstat: No destinations added.\n").is_empty());
    }

    #[test]
    fn parses_lpstat_d() {
        assert_eq!(
            parse_lpstat_d("system default destination: HP_LaserJet\n"),
            Some("HP_LaserJet".to_string())
        );
        assert_eq!(parse_lpstat_d("no system default destination\n"), None);
        assert_eq!(parse_lpstat_d(""), None);
    }

    #[test]
    fn parses_lpstat_l_p() {
        let out = "\
printer HP_LaserJet is idle.  enabled since Thu 01 Jan 2026
	Form mounted:
	Content types: any
	Description: HP LaserJet Pro MFP M428
printer Brother_QL disabled since Thu 01 Jan 2026 -
	Reason: offline
printer Kyocera now printing Kyocera-42.  enabled since Thu 01 Jan 2026
";
        let m = parse_lpstat_l_p(out);
        assert_eq!(m["HP_LaserJet"].0, "idle");
        assert_eq!(m["HP_LaserJet"].1, "HP LaserJet Pro MFP M428");
        assert_eq!(m["Brother_QL"].0, "error");
        assert_eq!(m["Brother_QL"].1, "");
        assert_eq!(m["Kyocera"].0, "busy");
    }

    #[test]
    fn parses_lpoptions_l() {
        let out = "\
PageSize/Page Size: *Letter A4 Legal
Duplex/Double-Sided Printing: None DuplexNoTumble *DuplexTumble
ColorModel/Color Mode: Gray *RGB
InputSlot/Media Source: *Auto Tray1 Manual
Resolution/Output Resolution: 300dpi *600dpi 1200dpi
";
        let c = parse_lpoptions_l(out);
        assert!(c.supports_duplex);
        assert!(c.supports_color);
        assert_eq!(c.trays, vec!["Auto", "Tray1", "Manual"]);
        assert_eq!(c.default_dpi, 600);
        assert_eq!(c.max_dpi, 1200);
    }

    #[test]
    fn parses_lpoptions_l_mono_simplex() {
        let out = "\
Duplex/Double-Sided Printing: *None
ColorModel/Color Mode: *Gray
";
        let c = parse_lpoptions_l(out);
        assert!(!c.supports_duplex);
        assert!(!c.supports_color);
        assert_eq!(c.default_dpi, 300); // 没有 Resolution 行时的安全默认
        assert_eq!(c.max_dpi, 0);
    }

    /// 本机没配队列时 /printers 依然是 200 + 空列表，不能 500
    #[test]
    fn list_printers_degrades_to_empty() {
        match list_printers() {
            Ok(v) => assert!(v.is_empty(), "本机未配置 CUPS 队列，应返回空列表"),
            Err(e) => panic!("未配置队列不算错误: {}", e),
        }
    }
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

/// 按队列名猜打印机类型（Windows / CUPS 共用）
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
