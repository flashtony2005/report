//! 通用小工具：宽字符转换、宽容 base64 解码、统一业务错误响应

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::json;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

/// String → 0 结尾 UTF-16（Windows W 系列 API 输入）
pub fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// 0 结尾 UTF-16 指针 → String（越界风险由调用方保证指针指向合法缓冲）
pub unsafe fn from_wide(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    String::from_utf16_lossy(slice)
}

/// 宽容 base64 解码：依次尝试 标准带 padding → 标准 no-pad → URL-safe；并剥离空白
pub fn decode_base64_lenient(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let std_e = base64::engine::general_purpose::STANDARD;
    let std_np = base64::engine::general_purpose::STANDARD_NO_PAD;
    let url_e = base64::engine::general_purpose::URL_SAFE;
    let url_np = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    std_e
        .decode(cleaned.as_bytes())
        .or_else(|_| std_np.decode(cleaned.as_bytes()))
        .or_else(|_| url_e.decode(cleaned.as_bytes()))
        .or_else(|_| url_np.decode(cleaned.as_bytes()))
        .map_err(|e| format!("base64 解码失败: {e}"))
}

/// 业务错误：HTTP 200 + {ok:false,message}（前端按 PrintClientError('service') 分类）
pub fn service_error(message: impl Into<String>) -> Response {
    (StatusCode::OK, axum::Json(json!({ "ok": false, "message": message.into() })))
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_roundtrip() {
        let w = to_wide("打印机A");
        assert_eq!(unsafe { from_wide(w.as_ptr()) }, "打印机A");
    }

    #[test]
    fn base64_with_and_without_padding() {
        assert_eq!(decode_base64_lenient("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64_lenient("aGVsbG8").unwrap(), b"hello");
        assert_eq!(decode_base64_lenient("aGVs\nbG8=").unwrap(), b"hello");
        assert!(decode_base64_lenient("!!!").is_err());
    }
}
