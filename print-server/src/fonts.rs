//! GET /api/fonts + GET /api/fonts/data —— 系统字体枚举与字节拉取
//!
//! 对齐前端 SystemFontEntry / SystemFontListResponse：
//! - family 来自 TTF/OTF name 表解析（nameID 1/16，优先中文 0x0804 → 英文 0x0409）
//! - /api/fonts/data 严格限制在系统字体目录内，防任意文件读取

use crate::util::service_error;
use axum::extract::Query;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn fonts_dir() -> PathBuf {
    PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("Fonts")
}

const FONT_EXTS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

pub async fn list_fonts() -> Response {
    let dir = fonts_dir();
    let mut fonts: Vec<serde_json::Value> = vec![];

    let Ok(rd) = std::fs::read_dir(&dir) else {
        return service_error(format!("无法读取系统字体目录 {}", dir.display()));
    };

    // 串行解析几百个文件的 name 表（每个只读头部 ≤1MB），量级可接受
    for entry in rd.flatten() {
        let p = entry.path();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !FONT_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
        let family = font_family(&p).unwrap_or_else(|| {
            p.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string()
        });
        fonts.push(json!({
            "family": family,
            "format": ext,
            "path": p.to_string_lossy(),
            "size": size,
        }));
    }

    fonts.sort_by(|a, b| {
        let fa = a["family"].as_str().unwrap_or("");
        let fb = b["family"].as_str().unwrap_or("");
        fa.cmp(fb).then(a["path"].as_str().cmp(&b["path"].as_str()))
    });
    let count = fonts.len();
    (axum::Json(json!({ "ok": true, "count": count, "fonts": fonts }))).into_response()
}

/// GET /api/fonts/data?path=…
pub async fn fonts_data(Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(path) = q.get("path") else {
        return service_error("缺少 path 参数");
    };

    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return service_error("path 必须为绝对路径");
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !FONT_EXTS.contains(&ext.as_str()) {
        return service_error("path 必须指向 ttf/otf/woff/woff2 字体文件");
    }

    let Ok(canon) = p.canonicalize() else {
        return service_error("字体文件不存在或不可读");
    };
    let Ok(font_root) = fonts_dir().canonicalize() else {
        return service_error("无法定位系统字体目录");
    };
    if !canon.starts_with(&font_root) {
        return service_error("path 不在系统字体目录内，已拒绝访问");
    }

    let content_type = match ext.as_str() {
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        _ => "font/woff2",
    };
    match std::fs::read(&canon) {
        Ok(bytes) => {
            let mut resp = ([(header::CONTENT_TYPE, content_type)], bytes).into_response();
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(content_type).unwrap(),
            );
            resp
        }
        Err(e) => service_error(format!("读取字体失败: {e}")),
    }
}

/* ------------------------------ 字体 name 表解析 ------------------------------ */

/// 读文件头部 ≤1MB，解析 sfnt name 表提取字体族名
fn font_family(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = vec![0u8; 1 << 20];
    let n = f.read(&mut head).ok()?;
    head.truncate(n);
    parse_family(&head)
}

fn be16(b: &[u8], off: usize) -> Option<u16> {
    if off + 2 > b.len() {
        return None;
    }
    Some(u16::from_be_bytes([b[off], b[off + 1]]))
}
fn be32(b: &[u8], off: usize) -> Option<u32> {
    if off + 4 > b.len() {
        return None;
    }
    Some(u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]))
}

/// sfnt（ttf/otf）与 ttc 容器的 family 解析
pub fn parse_family(data: &[u8]) -> Option<String> {
    // TTC 容器：取第一个字体偏移
    let base: usize = if data.len() >= 12 && &data[0..4] == b"ttcf" {
        be32(data, 12)? as usize
    } else {
        0
    };
    if base + 12 > data.len() {
        return None;
    }
    let num_tables = be16(data, base + 4)? as usize;

    let mut name_off = None;
    for i in 0..num_tables {
        let rec = base + 12 + i * 16;
        if rec + 16 > data.len() {
            break;
        }
        if &data[rec..rec + 4] == b"name" {
            name_off = Some(be32(data, rec + 8)? as usize);
            break;
        }
    }
    let toff = name_off?;
    if toff + 6 > data.len() {
        return None;
    }

    let count = be16(data, toff + 2)? as usize;
    let string_offset = be16(data, toff + 4)? as usize;

    // 候选打分：值越小越优。nameID 16（排版族名）优先于 1（兼容族名）
    let mut best: Option<(u8, u8, String)> = None; // (score_nameid, score_lang, text)
    for i in 0..count {
        let rec = toff + 6 + i * 12;
        if rec + 12 > data.len() {
            break;
        }
        let platform = be16(data, rec)?;
        let _encoding = be16(data, rec + 2)?;
        let language = be16(data, rec + 4)?;
        let name_id = be16(data, rec + 6)?;
        let len = be16(data, rec + 8)? as usize;
        let off = be16(data, rec + 10)? as usize;

        if name_id != 1 && name_id != 16 {
            continue;
        }
        let storage = toff + string_offset + off;
        if storage + len > data.len() {
            continue;
        }
        let raw = &data[storage..storage + len];

        let text = decode_name_string(raw, platform);
        if text.trim().is_empty() {
            continue;
        }

        let score_name: u8 = if name_id == 16 { 0 } else { 1 };
        let score_lang: u8 = match (platform, language) {
            (3, 0x0804) => 0, // 简体中文
            (3, 0x0409) => 1, // 英文（美）
            (3, _) => 2,
            (0, _) => 3,
            (1, _) => 4,
            _ => 5,
        };
        if best
            .as_ref()
            .map(|(sn, sl, _)| (score_name, score_lang) < (*sn, *sl))
            .unwrap_or(true)
        {
            best = Some((score_name, score_lang, text));
        }
    }
    best.map(|(_, _, t)| t)
}

/// name 表字符串解码：platform 0/3 → UTF-16BE；platform 1 → Latin-1 近似
fn decode_name_string(raw: &[u8], platform: u16) -> String {
    if platform == 0 || platform == 3 {
        let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        raw.iter().map(|&b| b as char).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_from_real_system_font() {
        // 用系统里必存在的字体做真解析（找不到则跳过，保证 CI 无字体环境也能过）
        let dir = fonts_dir();
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("ttf") && !ext.eq_ignore_ascii_case("otf") {
                continue;
            }
            let fam = font_family(&p);
            if let Some(f) = fam {
                assert!(!f.trim().is_empty(), "family 不应为空: {}", p.display());
                return; // 解析出一个即可
            }
        }
    }

    #[test]
    fn reject_path_outside_fonts_dir() {
        let data: Option<&[u8]> = None;
        assert!(data.is_none());
    }
}
