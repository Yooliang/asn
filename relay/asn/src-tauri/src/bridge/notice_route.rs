//! 收發室自己的系統通知走後台 bridge_notice 的判斷（純函式，網路部分在 core.rs 的 send_back）。
//! 同帳號收件人收到「ASN 通知」；跨帳號（409 cross_account）或舊後台（404）退回舊寄法。

use serde_json::{json, Value};

#[derive(Debug, PartialEq, Eq)]
pub enum NoticeOutcome {
    /// 後台收下（含限流不寄）：回 true，不退回
    Sent,
    /// 退回舊寄法
    Fallback,
    /// 失敗，不退回，回 false
    Drop,
}

/// 這次要不要先試 bridge_notice：只有收發室自己說話（from_agent 為空）且有原信 id
pub fn use_bridge_notice(from_agent_is_none: bool, origin_id: &str) -> bool {
    from_agent_is_none && !origin_id.is_empty()
}

/// 依 HTTP 狀態碼與回應 JSON 決定下一步；status 為 None＝連線失敗
pub fn classify(status: Option<u16>, resp: &Value) -> NoticeOutcome {
    match status {
        Some(200..=299) => NoticeOutcome::Sent,
        Some(404) => NoticeOutcome::Fallback,
        Some(409) if resp.get("error").and_then(Value::as_str) == Some("cross_account") => NoticeOutcome::Fallback,
        _ => NoticeOutcome::Drop,
    }
}

/// 200 但後台決定不寄（rate_limited／per_mail_limit）時回該原因，給 log 用
pub fn skipped_reason(resp: &Value) -> Option<&str> {
    resp.get("notify").and_then(Value::as_str).filter(|s| *s != "sent")
}

/// 請求內文：只有 reply_to 與 body，收件人由後台從原信推出
pub fn body(origin_id: &str, text: &str) -> Value {
    json!({ "reply_to": origin_id, "body": text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只有收發室自己說話且有原信才走通知() {
        assert!(use_bridge_notice(true, "m1"));
        assert!(!use_bridge_notice(true, ""));
        assert!(!use_bridge_notice(false, "m1"));
    }
    #[test]
    fn 判斷結果() {
        assert_eq!(classify(Some(200), &json!({"ok":true,"notify":"sent"})), NoticeOutcome::Sent);
        assert_eq!(classify(Some(200), &json!({"ok":true,"notify":"rate_limited"})), NoticeOutcome::Sent);
        assert_eq!(classify(Some(409), &json!({"error":"cross_account"})), NoticeOutcome::Fallback);
        assert_eq!(classify(Some(409), &json!({"error":"other"})), NoticeOutcome::Drop);
        assert_eq!(classify(Some(404), &json!({"error":"not_found"})), NoticeOutcome::Fallback);
        assert_eq!(classify(Some(404), &Value::Null), NoticeOutcome::Fallback);
        for s in [400, 422, 500] {
            assert_eq!(classify(Some(s), &json!({})), NoticeOutcome::Drop);
        }
        assert_eq!(classify(None, &Value::Null), NoticeOutcome::Drop);
    }
    #[test]
    fn 限流原因() {
        assert_eq!(skipped_reason(&json!({"notify":"rate_limited"})), Some("rate_limited"));
        assert_eq!(skipped_reason(&json!({"notify":"sent"})), None);
    }
    #[test]
    fn 內文不含收件人與寄件人欄位() {
        let b = body("m1", "hi");
        let o = b.as_object().unwrap();
        assert_eq!(o.len(), 2);
        for k in ["to_node", "to_agent", "from_agent", "expects_reply"] {
            assert!(!o.contains_key(k));
        }
    }
}
