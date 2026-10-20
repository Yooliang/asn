//! Realtime 門鈴（phoenix channels over WebSocket），照 relay/machine/relay-core.mjs 的 connectBell：
//! 加入 `realtime:<bell_topic>`，收到 broadcast event=bell 就通知前端去拉信；斷線指數退避重連（1s→30s）。
//! 沒有 anon 金鑰就沒有門鈴，只剩輪詢。anon 金鑰只在這裡用，不傳前端。
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, PartialEq)]
pub enum Ring {
    Joined,
    Bell,
    Down,
}

pub fn ws_url(base: &str, anon: &str) -> Option<String> {
    let u = base.trim_end_matches('/');
    let (scheme, rest) = if let Some(r) = u.strip_prefix("https://") { ("wss", r) } else if let Some(r) = u.strip_prefix("http://") { ("ws", r) } else { return None };
    let host = rest.split('/').next()?;
    Some(format!("{scheme}://{host}/realtime/v1/websocket?apikey={}&vsn=1.0.0", crate::relay::encode_component(anon)))
}

pub fn join_msg(topic: &str, r: u64) -> String {
    json!({"topic": format!("realtime:{topic}"), "event": "phx_join",
        "payload": {"config": {"broadcast": {"self": false, "ack": false}, "presence": {"key": ""}, "postgres_changes": [], "private": false}},
        "ref": r.to_string(), "join_ref": "1"})
    .to_string()
}
pub fn heartbeat_msg(r: u64) -> String {
    json!({"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": r.to_string(), "join_ref": "1"}).to_string()
}

/// 解析一則伺服器訊息：入群成功／門鈴響／該重連；其他略過
pub fn classify(text: &str, topic: &str) -> Option<Ring> {
    let m: Value = serde_json::from_str(text).ok()?;
    let ev = m.get("event")?.as_str()?;
    let full = format!("realtime:{topic}");
    match ev {
        "phx_reply" if m["topic"] == full.as_str() && m["payload"]["status"] == "ok" => Some(Ring::Joined),
        "broadcast" if m["payload"]["event"] == "bell" => Some(Ring::Bell),
        "phx_error" | "phx_close" => Some(Ring::Down),
        _ => None,
    }
}

/// 長駐：每次門鈴／入群成功呼叫 on_ring。永不返回（由呼叫端放進背景任務）。
pub async fn run(url: String, topic: String, on_ring: impl Fn(&Ring) + Send + 'static) {
    let mut backoff = 1000u64;
    loop {
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url.as_str()).await {
            let mut r = 1u64;
            let _ = ws.send(Message::text(join_msg(&topic, r))).await;
            let mut hb = tokio::time::interval(Duration::from_secs(25));
            hb.tick().await;
            loop {
                tokio::select! {
                    _ = hb.tick() => { r += 1; if ws.send(Message::text(heartbeat_msg(r))).await.is_err() { break } }
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => match classify(t.as_str(), &topic) {
                            Some(Ring::Down) => break,
                            Some(ring) => { if ring == Ring::Joined { backoff = 1000 } on_ring(&ring) }
                            None => {}
                        },
                        Some(Ok(_)) => {}
                        _ => break,
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(backoff)).await;
        backoff = (backoff * 2).min(30_000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 網址_https_換_wss_並帶編碼後的_anon() {
        assert_eq!(ws_url("https://x.supabase.co/functions/v1/relay", "a b").unwrap(), "wss://x.supabase.co/realtime/v1/websocket?apikey=a%20b&vsn=1.0.0");
        assert!(ws_url("http://127.0.0.1:9/relay", "k").unwrap().starts_with("ws://127.0.0.1:9/"));
        assert!(ws_url("ftp://x", "k").is_none());
    }

    #[test]
    fn 入群與心跳訊息格式() {
        let j: Value = serde_json::from_str(&join_msg("relay-bell-abc", 1)).unwrap();
        assert_eq!(j["topic"], "realtime:relay-bell-abc");
        assert_eq!(j["event"], "phx_join");
        assert_eq!(j["payload"]["config"]["broadcast"]["self"], false);
        assert_eq!(j["join_ref"], "1");
        let h: Value = serde_json::from_str(&heartbeat_msg(7)).unwrap();
        assert_eq!((h["topic"].as_str(), h["event"].as_str(), h["ref"].as_str()), (Some("phoenix"), Some("heartbeat"), Some("7")));
    }

    #[test]
    fn 訊息分類() {
        let t = "relay-bell-abc";
        assert_eq!(classify(r#"{"event":"phx_reply","topic":"realtime:relay-bell-abc","payload":{"status":"ok"}}"#, t), Some(Ring::Joined));
        assert_eq!(classify(r#"{"event":"phx_reply","topic":"realtime:other","payload":{"status":"ok"}}"#, t), None);
        assert_eq!(classify(r#"{"event":"phx_reply","topic":"realtime:relay-bell-abc","payload":{"status":"error"}}"#, t), None);
        assert_eq!(classify(r#"{"event":"broadcast","payload":{"event":"bell"}}"#, t), Some(Ring::Bell));
        assert_eq!(classify(r#"{"event":"broadcast","payload":{"event":"other"}}"#, t), None);
        assert_eq!(classify(r#"{"event":"phx_error"}"#, t), Some(Ring::Down));
        assert_eq!(classify("not json", t), None);
    }
}
