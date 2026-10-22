//! 管道上的訊息格式。一條連線一個請求：
//!   小幫手 → ASN：一行 JSON（[`Request`]，以換行結尾，最長 [`MAX_REQUEST_BYTES`]）
//!   ASN → 小幫手：一行 JSON（[`Header`]），若 ok 則緊接 `len` 個位元組的密碼（UTF-8，不是 JSON）
//! 密碼不放在 JSON 裡，是為了讓程式不必把密碼經過任何 JSON 值／格式化字串，也好在用完後立刻清掉。
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const VERSION: u32 = 1;
pub const OP_SECRET: &str = "secret";
pub const MAX_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_SECRET_BYTES: usize = 4 * 1024;
/// 確認窗等多久沒人理就自動取消
pub const DIALOG_TIMEOUT: Duration = Duration::from_secs(120);
/// 同時排隊等確認窗的請求上限（超過直接回「忙碌」）
pub const MAX_QUEUE: usize = 8;

pub const REASON_CANCELLED: &str = "cancelled";
pub const REASON_TIMEOUT: &str = "timeout";
pub const REASON_BUSY: &str = "busy";
pub const REASON_BAD: &str = "bad_request";
pub const REASON_UNSUPPORTED: &str = "unsupported";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub v: u32,
    pub op: String,
    /// git／ssh 給的提示文字（顯示在確認窗，不是密碼）
    pub prompt: String,
    /// 小幫手自己報的工作資料夾（顯示用；同一使用者的程式可以亂報，所以只當參考）
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Header {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub len: usize,
}

impl Header {
    pub fn secret(len: usize) -> Header {
        Header { ok: true, reason: None, len }
    }
    pub fn fail(reason: &str) -> Header {
        Header { ok: false, reason: Some(reason.to_string()), len: 0 }
    }
    pub fn line(&self) -> Vec<u8> {
        let mut v = serde_json::to_vec(self).unwrap_or_default();
        v.push(b'\n');
        v
    }
}

/// 要顯示給人看的文字：控制字元（含換行）換成空白、拿掉雙向文字控制碼（避免把畫面偽裝成別的內容）、壓縮空白、超長截斷
pub fn clean_display(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut prev_space = true;
    for c in s.chars() {
        let bidi = matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}');
        if bidi {
            continue;
        }
        let c = if c.is_control() { ' ' } else { c };
        if c == ' ' {
            if prev_space {
                continue;
            }
            prev_space = true;
        } else {
            prev_space = false;
        }
        out.push(c);
    }
    let out = out.trim().to_string();
    if out.chars().count() > max_chars {
        let mut cut: String = out.chars().take(max_chars).collect();
        cut.push('…');
        cut
    } else {
        out
    }
}
