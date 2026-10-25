//! 念出訊息：文字經收發室後台（動作 tts）轉給 Edge TTS，拿回 MP3。
//! 金鑰與 HTTP 都在 Rust 端（前端拿不到金鑰）；前端只送要念的文字，拿回 base64 的音檔去播。
//! 後台沒啟用（沒設 ASN_EDGE_TTS_URL／SECRET）時回 503 tts_disabled，這裡轉成白話訊息。
use crate::{relay::Relay, App};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;

/// 與後台 _shared/tts.ts 的 TTS_MAX_CHARS 一致
pub const MAX_CHARS: usize = 1000;
const MAX_AUDIO: usize = 6 * 1024 * 1024;

#[derive(Serialize)]
pub struct Spoken {
    pub mime: String,
    /// base64 的音檔
    pub audio: String,
}

/// 檢查要念的文字：去頭尾空白、控制字元（保留換行）換成空白，空的與過長都拒絕
pub fn prepare_text(raw: &str) -> Result<String, String> {
    let t: String = raw.chars().map(|c| if c.is_control() && c != '\n' && c != '\t' { ' ' } else { c }).collect();
    let t = t.trim().to_string();
    if t.is_empty() {
        return Err("沒有可以念的文字".into());
    }
    if t.chars().count() > MAX_CHARS {
        return Err(format!("一次最多念 {MAX_CHARS} 字"));
    }
    Ok(t)
}

/// 要送給後台的 body。voice 空字串＝不帶（用後台預設）
pub fn build_body(text: &str, voice: &str) -> Value {
    let mut b = json!({ "text": text });
    if !voice.is_empty() {
        b["voice"] = json!(voice);
    }
    b
}

/// 後台的錯誤碼 → 給人看的中文
pub fn friendly_error(e: &str) -> String {
    if e.contains("tts_disabled") || e.contains("HTTP 503") {
        "維護者還沒有在後台啟用念出訊息。".into()
    } else if e.contains("rate_limited") || e.contains("HTTP 429") {
        "念得太頻繁了，請稍後再試。".into()
    } else if e.contains("text_too_long") || e.contains("HTTP 413") {
        format!("一次最多念 {MAX_CHARS} 字。")
    } else if e.contains("tts_failed") || e.contains("HTTP 502") {
        "語音合成暫時失敗，請稍後再試。".into()
    } else if e.contains("連線失敗") {
        "連不上 ASN。".into()
    } else {
        "念出訊息失敗。".into()
    }
}

fn relay_of(app: &App) -> Result<std::sync::Arc<Relay>, String> {
    app.relay.clone().ok_or_else(|| app.init_error.clone().unwrap_or_else(|| "尚未連上 ASN".into()))
}

/// 後台列出的可選聲音與是否啟用（不耗合成額度）
#[tauri::command]
pub async fn tts_voices(app: State<'_, App>) -> Result<Value, String> {
    relay_of(&app)?.api("tts_voices", None).await.map_err(|e| friendly_error(&e))
}

/// 念一段文字；voice 沒給就用設定檔裡選的聲音
#[tauri::command]
pub async fn tts_speak(app: State<'_, App>, text: String, voice: Option<String>) -> Result<Spoken, String> {
    let text = prepare_text(&text)?;
    let voice = match voice {
        Some(v) if crate::voicecfg::valid_voice(&v) => v,
        Some(_) => return Err("聲音代號格式不對".into()),
        None => crate::voicecfg::load(&app.data_dir).tts_voice,
    };
    let (bytes, mime) = relay_of(&app)?.api_bytes("tts", build_body(&text, &voice), MAX_AUDIO, Duration::from_secs(80)).await.map_err(|e| friendly_error(&e))?;
    if bytes.is_empty() {
        return Err(friendly_error("tts_failed"));
    }
    let mime = if mime.starts_with("audio/") { mime } else { "audio/mpeg".into() };
    Ok(Spoken { mime, audio: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 文字整理_空的與過長拒絕() {
        assert_eq!(prepare_text("  你好\u{7} 嗎\n").unwrap(), "你好  嗎");
        assert!(prepare_text("   \n").is_err());
        assert!(prepare_text(&"字".repeat(MAX_CHARS)).is_ok());
        assert!(prepare_text(&"字".repeat(MAX_CHARS + 1)).is_err());
        // 以字元算，不是位元組：1000 個表情符號也算 1000 字
        assert!(prepare_text(&"😀".repeat(MAX_CHARS)).is_ok());
    }

    #[test]
    fn 送給後台的欄位() {
        assert_eq!(build_body("嗨", ""), json!({"text":"嗨"}));
        assert_eq!(build_body("嗨", "zh-TW-YunJheNeural"), json!({"text":"嗨","voice":"zh-TW-YunJheNeural"}));
    }

    #[test]
    fn 錯誤轉白話_不洩漏後台細節() {
        assert!(friendly_error("tts HTTP 503 tts_disabled").contains("還沒有"));
        assert!(friendly_error("tts HTTP 429 rate_limited").contains("頻繁"));
        assert!(friendly_error("tts HTTP 502 tts_failed").contains("暫時失敗"));
        assert!(friendly_error("tts 連線失敗：timeout").contains("連不上"));
        assert_eq!(friendly_error("whatever secret-abc"), "念出訊息失敗。");
    }

    /// 對本機假後台跑一次 api_bytes：成功拿到位元組與 content-type；錯誤只帶狀態碼與代碼
    #[tokio::test]
    async fn 對假後台取音檔() {
        use std::io::{Read, Write};
        let ln = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ln.local_addr().unwrap().port();
        let th = std::thread::spawn(move || {
            for i in 0..2 {
                let (mut s, _) = ln.accept().unwrap();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                assert!(req.contains("x-relay-key: k1") && req.contains("action=tts"), "{req}");
                if i == 0 {
                    s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: audio/mpeg\r\ncontent-length: 3\r\nconnection: close\r\n\r\n\x01\x02\x03").unwrap();
                } else {
                    let body = br#"{"error":"tts_disabled"}"#;
                    write!(s, "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).unwrap();
                    s.write_all(body).unwrap();
                }
            }
        });
        let r = Relay::new(format!("http://127.0.0.1:{port}/relay"), "k1".into(), "T".into(), "T-ASN".into());
        let (b, m) = r.api_bytes("tts", build_body("嗨", ""), 1024, Duration::from_secs(5)).await.unwrap();
        assert_eq!((b, m.as_str()), (vec![1, 2, 3], "audio/mpeg"));
        let e = r.api_bytes("tts", build_body("嗨", ""), 1024, Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(e, "tts HTTP 503 tts_disabled");
        assert!(friendly_error(&e).contains("還沒有"));
        th.join().unwrap();
    }
}
