//! Realtime 門鈴（phoenix channels over WebSocket），照 relay/machine/relay-core.mjs 的 connectBell：
//! 加入 `realtime:<bell_topic>`，收到 broadcast event=bell 就通知前端去拉信；斷線指數退避重連（1s→30s）。
//! 沒有 anon 金鑰就沒有門鈴，只剩輪詢。anon 金鑰只在這裡用，不傳前端。
//!
//! 連線、加入、心跳、重連都在 [`run_channel`]：門鈴（[`run`]）用它，別台看畫面的傳輸也用它（#597）。
//! 門鈴的行為不變：只收不送、不要回條、永不返回。
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, PartialEq)]
pub enum Ring {
    Joined,
    Bell(BellKind),
    Down,
}

/// 門鈴的種類：由 broadcast payload 的 kind 判斷。看不懂的一律當 Legacy（照舊叫醒全部，保守）
#[derive(Debug, Clone, PartialEq)]
pub enum BellKind {
    /// 寄信、看畫面要求等舊門鈴（payload 是 {} 或沒有 kind）
    Legacy,
    /// 回報匯流排更新了（只告知哪台哪種，不帶內容）；kind、node 都要有且格式合格
    Report { kind: String, node: String },
    /// 只指名種類、不帶 node 的門鈴（後台對「擁有該請求的那台」敲，例如 perm_req／term_req）；kind 格式要合格
    Scoped(String),
}

/// 門鈴響了要做的事（純資料，方便測；實際動作在 lib.rs）
#[derive(Debug, Clone, PartialEq)]
pub enum BellAction {
    /// emit 'relay-bell'（前端收信、重拉名單等）
    EmitBell,
    /// emit 'relay-report-bell'，payload {kind, node}
    EmitReport { kind: String, node: String },
    WakeSecret,
    /// 叫醒手機決定權限框的領取（perm_req_take）
    WakePerm,
    WakeTerm,
    WakeView,
    /// 叫醒「手機要核對這台指紋」的領取（fp_show_take，#1863）；只有 fp_show 門鈴會叫，舊門鈴不叫（每封信都多打一次後台不划算）
    WakeFpShow,
}

fn valid_kind(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len()) && b[0].is_ascii_lowercase() && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn valid_node(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// 依 broadcast 的 payload 判斷門鈴種類。payload 不是物件、kind 不是字串、格式不合都當 Legacy
pub fn bell_kind(payload: &Value) -> BellKind {
    let Some(kind) = payload.get("kind").and_then(Value::as_str) else { return BellKind::Legacy };
    if !valid_kind(kind) {
        return BellKind::Legacy; // 保守：看不懂就照舊叫醒全部
    }
    match payload.get("node") {
        None => BellKind::Scoped(kind.to_string()),
        Some(n) => match n.as_str() {
            Some(node) if valid_node(node) => BellKind::Report { kind: kind.to_string(), node: node.to_string() },
            _ => BellKind::Legacy, // node 有給但不合格：保守
        },
    }
}

/// 門鈴響了要做哪些事。Legacy＝以前的全部（含 WakePerm）；Report 只通知回報；
/// Scoped 的 perm_req／term_req 只叫醒對應的領取，未知的 Scoped 當 Legacy（保守不漏）
pub fn ring_actions(ring: &Ring) -> Vec<BellAction> {
    let all = || vec![BellAction::EmitBell, BellAction::WakeSecret, BellAction::WakePerm, BellAction::WakeTerm, BellAction::WakeView];
    match ring {
        Ring::Joined | Ring::Bell(BellKind::Legacy) => all(),
        Ring::Bell(BellKind::Scoped(k)) => match k.as_str() {
            "perm_req" => vec![BellAction::WakePerm],
            "term_req" => vec![BellAction::WakeTerm],
            "fp_show" => vec![BellAction::WakeFpShow],
            _ => all(),
        },
        Ring::Bell(BellKind::Report { kind, node }) => vec![BellAction::EmitReport { kind: kind.clone(), node: node.clone() }],
        Ring::Down => vec![],
    }
}

/// 只管收信的門鈴聽眾（桌面內建橋、`asn recv --watch`、inbox 模式）用：這一響要不要叫醒收信。
/// 回報門鈴與 perm_req／term_req 不叫醒（不是信）；其他照舊一律叫醒（含 Joined／Down、未知的 Scoped，與改版前的 `move |_|` 相同）
pub fn wakes_mail(ring: &Ring) -> bool {
    match ring {
        Ring::Bell(BellKind::Report { .. }) => false,
        Ring::Bell(BellKind::Scoped(k)) => !matches!(k.as_str(), "perm_req" | "term_req" | "fp_show"),
        _ => true,
    }
}

/// 頻道收到的事：加入成功、或一則 broadcast（只會是這個 topic 的）
#[derive(Debug, PartialEq)]
pub enum Event<'a> {
    Joined,
    Broadcast { event: &'a str, payload: &'a Value },
}

/// 一則要送出的 broadcast。done 回報結果：要回條時等伺服器回覆，不要回條時寫進連線就算成功
pub struct Outbound {
    pub event: String,
    pub payload: Value,
    pub done: oneshot::Sender<Result<(), String>>,
}

pub const NOT_CONNECTED: &str = "還沒連上";
/// 回條最多等多久，過了就算送失敗（連線還在也一樣）
pub const ACK_WAIT: Duration = Duration::from_secs(10);
const JOIN_REF: &str = "1";

pub fn ws_url(base: &str, anon: &str) -> Option<String> {
    let u = base.trim_end_matches('/');
    let (scheme, rest) = if let Some(r) = u.strip_prefix("https://") { ("wss", r) } else if let Some(r) = u.strip_prefix("http://") { ("ws", r) } else { return None };
    let host = rest.split('/').next()?;
    Some(format!("{scheme}://{host}/realtime/v1/websocket?apikey={}&vsn=1.0.0", crate::relay::encode_component(anon)))
}

/// 門鈴用的加入訊息（不要回條）
pub fn join_msg(topic: &str, r: u64) -> String {
    join_msg_with(topic, r, false)
}

/// ack＝每則 broadcast 要不要伺服器回條
pub fn join_msg_with(topic: &str, r: u64, ack: bool) -> String {
    json!({"topic": format!("realtime:{topic}"), "event": "phx_join",
        "payload": {"config": {"broadcast": {"self": false, "ack": ack}, "presence": {"key": ""}, "postgres_changes": [], "private": false}},
        "ref": r.to_string(), "join_ref": JOIN_REF})
    .to_string()
}
pub fn heartbeat_msg(r: u64) -> String {
    json!({"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": r.to_string(), "join_ref": JOIN_REF}).to_string()
}
pub fn broadcast_msg(topic: &str, event: &str, payload: &Value, r: u64) -> String {
    json!({"topic": format!("realtime:{topic}"), "event": "broadcast",
        "payload": {"type": "broadcast", "event": event, "payload": payload},
        "ref": r.to_string(), "join_ref": JOIN_REF})
    .to_string()
}

/// 解析一則伺服器訊息：入群成功／門鈴響／該重連；其他略過
pub fn classify(text: &str, topic: &str) -> Option<Ring> {
    let m: Value = serde_json::from_str(text).ok()?;
    let ev = m.get("event")?.as_str()?;
    let full = format!("realtime:{topic}");
    match ev {
        "phx_reply" if m["topic"] == full.as_str() && m["payload"]["status"] == "ok" => Some(Ring::Joined),
        "broadcast" if m["payload"]["event"] == "bell" => Some(Ring::Bell(bell_kind(&m["payload"]["payload"]))),
        "phx_error" | "phx_close" => Some(Ring::Down),
        _ => None,
    }
}

/// 伺服器訊息分成：這個 topic 的回覆（ref, 成功與否）、broadcast、該重連、其他
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Reply(u64, bool),
    Broadcast(String, Value),
    Down,
    Other,
}

pub fn parse_incoming(text: &str, topic: &str) -> Incoming {
    let Ok(m) = serde_json::from_str::<Value>(text) else { return Incoming::Other };
    let full = format!("realtime:{topic}");
    match m.get("event").and_then(Value::as_str) {
        Some("phx_reply") if m["topic"] == full.as_str() => match m["ref"].as_str().and_then(|r| r.parse().ok()) {
            Some(r) => Incoming::Reply(r, m["payload"]["status"] == "ok"),
            None => Incoming::Other,
        },
        Some("broadcast") if m["topic"].is_null() || m["topic"] == full.as_str() => match m["payload"]["event"].as_str() {
            Some(ev) => Incoming::Broadcast(ev.to_string(), m["payload"]["payload"].clone()),
            None => Incoming::Other,
        },
        Some("phx_error" | "phx_close") => Incoming::Down,
        _ => Incoming::Other,
    }
}

/// 長駐：每次門鈴／入群成功呼叫 on_ring。永不返回（由呼叫端放進背景任務）。
pub async fn run(url: String, topic: String, on_ring: impl Fn(&Ring) + Send + 'static) {
    run_channel(url, topic, false, None, std::future::pending(), move |e| match e {
        Event::Joined => on_ring(&Ring::Joined),
        Event::Broadcast { event: "bell", payload } => on_ring(&Ring::Bell(bell_kind(payload))),
        Event::Broadcast { .. } => {}
    })
    .await
}

/// 送一則 broadcast，等結果（要回條的頻道等伺服器回覆）。頻道已經收掉或等太久都算失敗
pub async fn send_via(tx: &mpsc::Sender<Outbound>, event: &str, payload: Value) -> Result<(), String> {
    let (done, res) = oneshot::channel();
    tx.send(Outbound { event: event.to_string(), payload, done }).await.map_err(|_| NOT_CONNECTED.to_string())?;
    match tokio::time::timeout(ACK_WAIT, res).await {
        Ok(Ok(r)) => r,
        _ => Err(NOT_CONNECTED.to_string()),
    }
}

/// 等下一則要送的；沒有送出端（門鈴）就永遠等
async fn next_outbound(out: &mut Option<mpsc::Receiver<Outbound>>) -> Option<Outbound> {
    match out {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

fn fail_all(pending: &mut HashMap<u64, (Instant, oneshot::Sender<Result<(), String>>)>, why: &str) {
    for (_, (_, done)) in pending.drain() {
        let _ = done.send(Err(why.to_string()));
    }
}

/// 共用的頻道：連線、加入、心跳、斷線退避重連（1s→30s）。
/// - 收到的事交給 on_event，只會是這個 topic 的。
/// - out：要送的 broadcast（None＝只收不送）。還沒加入、斷線中，送的一律馬上回失敗，不排隊；
///   ack 時等伺服器回條，斷線或超過 [`ACK_WAIT`] 都算失敗。送出端全部丟掉就結束。
/// - stop 完成就結束。門鈴傳 `pending()`，永不返回
pub async fn run_channel(url: String, topic: String, ack: bool, mut out: Option<mpsc::Receiver<Outbound>>, stop: impl Future<Output = ()>, mut on_event: impl FnMut(Event)) {
    tokio::pin!(stop);
    let mut backoff = 1000u64;
    loop {
        let connect = tokio::select! {
            c = tokio_tungstenite::connect_async(url.as_str()) => c,
            _ = &mut stop => return,
        };
        if let Ok((mut ws, _)) = connect {
            let mut r = 1u64;
            let join_ref = r;
            let mut joined = false;
            let mut pending: HashMap<u64, (Instant, oneshot::Sender<Result<(), String>>)> = HashMap::new();
            let _ = ws.send(Message::text(join_msg_with(&topic, r, ack))).await;
            let mut hb = tokio::time::interval(Duration::from_secs(25));
            hb.tick().await;
            loop {
                tokio::select! {
                    _ = &mut stop => { fail_all(&mut pending, NOT_CONNECTED); let _ = ws.close(None).await; return }
                    _ = hb.tick() => {
                        pending.retain(|_, (at, _)| at.elapsed() < ACK_WAIT);
                        r += 1;
                        if ws.send(Message::text(heartbeat_msg(r))).await.is_err() { break }
                    }
                    o = next_outbound(&mut out) => {
                        let Some(o) = o else { fail_all(&mut pending, NOT_CONNECTED); let _ = ws.close(None).await; return };
                        if !joined {
                            let _ = o.done.send(Err(NOT_CONNECTED.to_string()));
                            continue;
                        }
                        r += 1;
                        if ws.send(Message::text(broadcast_msg(&topic, &o.event, &o.payload, r))).await.is_err() {
                            let _ = o.done.send(Err(NOT_CONNECTED.to_string()));
                            break;
                        }
                        if ack { pending.insert(r, (Instant::now(), o.done)); } else { let _ = o.done.send(Ok(())); }
                    }
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => match parse_incoming(t.as_str(), &topic) {
                            Incoming::Down => break,
                            Incoming::Reply(rr, ok) if rr == join_ref => {
                                if ok { joined = true; backoff = 1000; on_event(Event::Joined) }
                            }
                            Incoming::Reply(rr, ok) => {
                                if let Some((_, done)) = pending.remove(&rr) {
                                    let _ = done.send(if ok { Ok(()) } else { Err("伺服器沒有收下".to_string()) });
                                }
                            }
                            Incoming::Broadcast(ev, payload) => on_event(Event::Broadcast { event: &ev, payload: &payload }),
                            Incoming::Other => {}
                        },
                        Some(Ok(_)) => {}
                        _ => break,
                    }
                }
            }
            fail_all(&mut pending, NOT_CONNECTED);
        }
        // 退避中：要送的一律馬上回失敗；送出端全丟掉或 stop 就結束
        let sleep = tokio::time::sleep(Duration::from_millis(backoff));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                _ = &mut stop => return,
                o = next_outbound(&mut out) => match o {
                    Some(o) => { let _ = o.done.send(Err(NOT_CONNECTED.to_string())); }
                    None => return,
                },
            }
        }
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
    fn 門鈴的入群訊息和抽出來之前一字不差() {
        let before = r#"{"topic":"realtime:relay-bell-abc","event":"phx_join","payload":{"config":{"broadcast":{"self":false,"ack":false},"presence":{"key":""},"postgres_changes":[],"private":false}},"ref":"1","join_ref":"1"}"#;
        assert_eq!(join_msg("relay-bell-abc", 1), before);
        let a: Value = serde_json::from_str(&join_msg_with("t", 1, true)).unwrap();
        assert_eq!(a["payload"]["config"]["broadcast"]["ack"], true);
    }

    #[test]
    fn 訊息分類() {
        let t = "relay-bell-abc";
        assert_eq!(classify(r#"{"event":"phx_reply","topic":"realtime:relay-bell-abc","payload":{"status":"ok"}}"#, t), Some(Ring::Joined));
        assert_eq!(classify(r#"{"event":"phx_reply","topic":"realtime:other","payload":{"status":"ok"}}"#, t), None);
        assert_eq!(classify(r#"{"event":"phx_reply","topic":"realtime:relay-bell-abc","payload":{"status":"error"}}"#, t), None);
        assert_eq!(classify(r#"{"event":"broadcast","payload":{"event":"bell"}}"#, t), Some(Ring::Bell(BellKind::Legacy)));
        assert_eq!(classify(r#"{"event":"broadcast","payload":{"event":"other"}}"#, t), None);
        assert_eq!(classify(r#"{"event":"phx_error"}"#, t), Some(Ring::Down));
        assert_eq!(classify("not json", t), None);
    }

    #[test]
    fn 門鈴種類_看不懂的一律當舊門鈴() {
        let rep = |k: &str, n: &str| BellKind::Report { kind: k.into(), node: n.into() };
        assert_eq!(bell_kind(&json!({})), BellKind::Legacy);
        assert_eq!(bell_kind(&Value::Null), BellKind::Legacy, "沒有 payload");
        assert_eq!(bell_kind(&json!("echo")), BellKind::Legacy, "payload 不是物件");
        assert_eq!(bell_kind(&json!({"kind": "echo", "node": "n1"})), rep("echo", "n1"));
        assert_eq!(bell_kind(&json!({"kind": "echo"})), BellKind::Scoped("echo".into()), "node 缺＝只指名種類");
        assert_eq!(bell_kind(&json!({"kind": "echo", "node": null})), BellKind::Legacy, "node 是 null");
        assert_eq!(bell_kind(&json!({"node": "n1"})), BellKind::Legacy, "kind 缺");
        assert_eq!(bell_kind(&json!({"kind": "echo", "node": "a".repeat(33)})), BellKind::Legacy, "node 太長");
        assert_eq!(bell_kind(&json!({"kind": "echo", "node": ""})), BellKind::Legacy, "node 空");
        assert_eq!(bell_kind(&json!({"kind": "Echo!"})), BellKind::Legacy, "kind 格式錯");
        assert_eq!(bell_kind(&json!({"kind": "1echo"})), BellKind::Legacy);
        assert_eq!(bell_kind(&json!({"kind": "a".repeat(33)})), BellKind::Legacy, "kind 太長");
        assert_eq!(bell_kind(&json!({"kind": 5})), BellKind::Legacy, "kind 不是字串");
        assert_eq!(bell_kind(&json!({"kind": "echo", "node": "bad node!"})), BellKind::Legacy, "node 格式錯");
        assert_eq!(bell_kind(&json!({"kind": "echo", "node": 7})), BellKind::Legacy, "node 不是字串");
        assert_eq!(bell_kind(&json!({"kind": "view_req"})), BellKind::Scoped("view_req".into()), "沒有 node＝Scoped，未知的 Scoped 在 ring_actions 當舊門鈴");
    }

    #[test]
    fn 門鈴分流_回報不叫醒收信_舊門鈴叫醒全部() {
        use BellAction::*;
        assert_eq!(ring_actions(&Ring::Bell(BellKind::Legacy)), vec![EmitBell, WakeSecret, WakePerm, WakeTerm, WakeView]);
        assert_eq!(ring_actions(&Ring::Joined), vec![EmitBell, WakeSecret, WakePerm, WakeTerm, WakeView], "入群成功照舊（再加權限框領取）");
        let r = ring_actions(&Ring::Bell(BellKind::Report { kind: "echo".into(), node: "n1".into() }));
        assert_eq!(r, vec![EmitReport { kind: "echo".into(), node: "n1".into() }]);
        assert!(!r.contains(&EmitBell) && !r.contains(&WakeSecret) && !r.contains(&WakeTerm) && !r.contains(&WakeView));
        assert!(ring_actions(&Ring::Down).is_empty());
    }

    #[test]
    fn 門鈴種類_只有_kind_是_scoped_有_node_是_report() {
        assert_eq!(bell_kind(&json!({"kind": "perm_req"})), BellKind::Scoped("perm_req".into()));
        assert_eq!(bell_kind(&json!({"kind": "perm_req", "node": "x"})), BellKind::Report { kind: "perm_req".into(), node: "x".into() });
        assert_eq!(bell_kind(&json!({"kind": "???"})), BellKind::Legacy);
        assert_eq!(bell_kind(&json!({})), BellKind::Legacy);
        assert_eq!(bell_kind(&json!([1, 2])), BellKind::Legacy, "非物件");
        assert_eq!(bell_kind(&json!(7)), BellKind::Legacy, "非物件");
    }

    #[test]
    fn 門鈴分流_scoped_只叫醒對應的領取_未知的當舊門鈴() {
        use BellAction::*;
        let sc = |k: &str| Ring::Bell(BellKind::Scoped(k.into()));
        assert_eq!(ring_actions(&sc("perm_req")), vec![WakePerm]);
        assert_eq!(ring_actions(&sc("term_req")), vec![WakeTerm]);
        assert_eq!(ring_actions(&sc("fp_show")), vec![WakeFpShow], "手機要核對指紋：只叫醒指紋視窗的領取（#1863）");
        assert!(!ring_actions(&Ring::Bell(BellKind::Legacy)).contains(&WakeFpShow), "舊門鈴（每封信）不多打 fp_show_take");
        assert_eq!(bell_kind(&json!({"kind": "fp_show"})), BellKind::Scoped("fp_show".into()), "後台的門鈴只帶 kind");
        assert_eq!(ring_actions(&sc("something_new")), vec![EmitBell, WakeSecret, WakePerm, WakeTerm, WakeView], "未知的 Scoped 全叫醒，不漏");
        assert_eq!(ring_actions(&Ring::Bell(BellKind::Report { kind: "perm_req".into(), node: "x".into() })), vec![EmitReport { kind: "perm_req".into(), node: "x".into() }], "有 node 的仍是回報");
        assert!(ring_actions(&Ring::Down).is_empty());
    }

    #[test]
    fn 守門_主程式的門鈴回呼走分流_不能退回一響就全叫醒() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let cb = lib.split("bell::run(url, topic, move |ring| {").nth(1).expect("有門鈴回呼").split(".await;").next().unwrap();
        assert!(cb.contains("bell::ring_actions(ring)"), "回呼要依門鈴種類分流");
        assert!(cb.contains("\"relay-report-bell\""), "回報門鈴走自己的事件");
        assert!(cb.contains("BellAction::WakePerm =>") && cb.contains("perm_wake_bell"), "權限框領取要被門鈴叫醒");
        assert!(cb.contains("BellAction::WakeFpShow =>") && cb.contains("fp_wake_bell"), "指紋 QR Code 視窗的領取要被門鈴叫醒（#1863）");
        assert!(cb.contains("BellAction::EmitBell =>"), "舊門鈴的 relay-bell 只在 EmitBell 裡 emit");
        assert_eq!(cb.matches("emit(\"relay-bell\"").count(), 1, "relay-bell 不能在回呼裡無條件 emit");
    }

    #[test]
    fn 收信聽眾_回報門鈴不叫醒_其他照舊叫醒() {
        assert!(!wakes_mail(&Ring::Bell(BellKind::Report { kind: "echo".into(), node: "n1".into() })), "回報門鈴不是信，不叫醒收信");
        assert!(!wakes_mail(&Ring::Bell(BellKind::Scoped("perm_req".into()))), "權限框決定不是信");
        assert!(!wakes_mail(&Ring::Bell(BellKind::Scoped("term_req".into()))), "終端確認不是信");
        assert!(!wakes_mail(&Ring::Bell(BellKind::Scoped("fp_show".into()))), "手機要核對指紋不是信");
        assert!(wakes_mail(&Ring::Bell(BellKind::Scoped("something_new".into()))), "未知的 Scoped 保守叫醒");
        assert!(wakes_mail(&Ring::Bell(BellKind::Legacy)), "舊門鈴照舊叫醒");
        assert!(wakes_mail(&Ring::Joined), "連上（含重連）照舊叫醒，補收斷線期間的信");
        assert!(wakes_mail(&Ring::Down), "與改版前 move |_| 相同");
    }

    #[test]
    fn 守門_每個門鈴聽眾都走分流_沒有無條件叫醒的() {
        // 主程式（lib.rs）走 ring_actions；只管收信的三處走 wakes_mail。新增 bell::run 呼叫者要在這裡登記
        let src = |s: &str| s.replace("\r\n", "\n");
        let files = [
            ("bridge/mod.rs", src(include_str!("bridge/mod.rs"))),
            ("cli/recv.rs", src(include_str!("cli/recv.rs"))),
            ("inbox_mode.rs", src(include_str!("inbox_mode.rs"))),
        ];
        for (name, text) in &files {
            let calls: Vec<&str> = text.split("bell::run(url, topic, ").skip(1).collect();
            assert!(!calls.is_empty(), "{name} 應該有門鈴聽眾（掃不到代表路徑或寫法變了）");
            for c in calls {
                let head = c.split(".await").next().unwrap();
                assert!(head.contains("wakes_mail(ring)"), "{name} 的門鈴回呼要先問 wakes_mail，不能無條件叫醒：{head}");
            }
        }
        let lib = src(include_str!("lib.rs"));
        assert_eq!(lib.matches("bell::run(url, topic, ").count(), 1, "lib.rs 只有主程式一個門鈴聽眾（多了要登記並走分流）");
    }

    #[test]
    fn 守門_回報事件的_payload_恰為_kind_與_node() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        assert!(lib.contains("emit(\"relay-report-bell\", serde_json::json!({ \"kind\": kind, \"node\": node }))"));
    }

    #[test]
    fn 實際收到的廣播_有_kind_分成回報_沒有的是舊門鈴() {
        let t = "relay-bell-abc";
        assert_eq!(classify(r#"{"event":"broadcast","payload":{"event":"bell","payload":{"kind":"echo","node":"n1"}}}"#, t), Some(Ring::Bell(BellKind::Report { kind: "echo".into(), node: "n1".into() })));
        assert_eq!(classify(r#"{"event":"broadcast","payload":{"event":"bell","payload":{}}}"#, t), Some(Ring::Bell(BellKind::Legacy)));
    }

    #[test]
    fn 頻道訊息分類_回覆帶_ref_broadcast_只收這個_topic() {
        let t = "tv_x";
        assert_eq!(parse_incoming(r#"{"event":"phx_reply","topic":"realtime:tv_x","ref":"3","payload":{"status":"ok"}}"#, t), Incoming::Reply(3, true));
        assert_eq!(parse_incoming(r#"{"event":"phx_reply","topic":"realtime:tv_x","ref":"4","payload":{"status":"error"}}"#, t), Incoming::Reply(4, false));
        assert_eq!(parse_incoming(r#"{"event":"phx_reply","topic":"phoenix","ref":"5","payload":{"status":"ok"}}"#, t), Incoming::Other, "心跳的回覆");
        assert_eq!(parse_incoming(r#"{"event":"broadcast","topic":"realtime:tv_x","payload":{"event":"frame","payload":{"w":"abc"}}}"#, t), Incoming::Broadcast("frame".into(), json!({"w":"abc"})));
        assert_eq!(parse_incoming(r#"{"event":"broadcast","topic":"realtime:別的","payload":{"event":"frame","payload":{}}}"#, t), Incoming::Other);
        assert_eq!(parse_incoming(r#"{"event":"phx_close"}"#, t), Incoming::Down);
        let b: Value = serde_json::from_str(&broadcast_msg(t, "frame", &json!({"w":"x"}), 9)).unwrap();
        assert_eq!((b["topic"].as_str(), b["event"].as_str(), b["payload"]["event"].as_str(), b["ref"].as_str()), (Some("realtime:tv_x"), Some("broadcast"), Some("frame"), Some("9")));
        assert_eq!(b["payload"]["payload"]["w"], "x");
    }

    /// 本機假的 Realtime 伺服器：記下收到的每則文字，照 reply 回
    async fn fake_server(reply: impl Fn(&Value) -> Vec<String> + Send + Sync + 'static) -> (String, mpsc::UnboundedReceiver<Value>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::unbounded_channel();
        let reply = std::sync::Arc::new(reply);
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let (tx, reply) = (tx.clone(), reply.clone());
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(sock).await else { return };
                    while let Some(Ok(Message::Text(t))) = ws.next().await {
                        let v: Value = serde_json::from_str(t.as_str()).unwrap();
                        let _ = tx.send(v.clone());
                        for out in reply(&v) {
                            if out == "CLOSE" {
                                let _ = ws.close(None).await;
                                return;
                            }
                            let _ = ws.send(Message::text(out)).await;
                        }
                    }
                });
            }
        });
        (url, rx)
    }

    async fn next(rx: &mut mpsc::UnboundedReceiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("5 秒內要收到").unwrap()
    }

    fn ok_reply(v: &Value) -> String {
        json!({"event": "phx_reply", "topic": v["topic"], "ref": v["ref"], "payload": {"status": "ok", "response": {}}}).to_string()
    }

    #[tokio::test]
    async fn 門鈴_加入_響鈴_斷線後重連再加入_行為和以前一樣() {
        let (url, mut seen) = fake_server(|v| match v["event"].as_str() {
            Some("phx_join") => vec![ok_reply(v), json!({"event": "broadcast", "topic": v["topic"], "payload": {"event": "bell"}}).to_string(), "CLOSE".into()],
            _ => vec![],
        })
        .await;
        let (tx, mut rings) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(url, "relay-bell-abc".into(), move |r| {
            let _ = tx.send(format!("{r:?}"));
        }));
        assert_eq!(next(&mut rings).await, "Joined");
        let first = seen.recv().await.unwrap();
        assert_eq!(first, serde_json::from_str::<Value>(&join_msg("relay-bell-abc", 1)).unwrap(), "門鈴的入群訊息不變");
        assert_eq!(next(&mut rings).await, "Bell(Legacy)");
        // 伺服器關掉 → 1 秒後重連、再加入
        assert_eq!(next(&mut rings).await, "Joined");
        assert_eq!(seen.recv().await.unwrap()["event"], "phx_join");
        task.abort();
    }

    #[tokio::test]
    async fn 送出_要回條時等伺服器回覆_沒回或還沒加入都算失敗() {
        let (url, _seen) = fake_server(|v| match (v["event"].as_str(), v["payload"]["payload"]["n"].as_i64()) {
            (Some("phx_join"), _) => vec![ok_reply(v)],
            (Some("broadcast"), Some(1)) => vec![ok_reply(v)],
            _ => vec![], // 第 2 則不回
        })
        .await;
        let (tx, rx) = mpsc::channel(8);
        let (joined_tx, mut joined) = mpsc::unbounded_channel();
        let task = tokio::spawn(run_channel(url, "tv_x".into(), true, Some(rx), std::future::pending(), move |e| {
            if e == Event::Joined {
                let _ = joined_tx.send(());
            }
        }));
        let send = |n: i64| {
            let tx = tx.clone();
            async move {
                let (done, res) = oneshot::channel();
                tx.send(Outbound { event: "frame".into(), payload: json!({ "n": n }), done }).await.unwrap();
                tokio::time::timeout(ACK_WAIT + Duration::from_secs(30), res).await.unwrap().unwrap()
            }
        };
        tokio::time::timeout(Duration::from_secs(5), joined.recv()).await.unwrap();
        assert_eq!(send(1).await, Ok(()));
        // 第 2 則伺服器不回：丟掉送出端，頻道結束，等待回條中的這則回失敗（不會永遠卡著）
        let (done, res) = oneshot::channel();
        tx.send(Outbound { event: "frame".into(), payload: json!({ "n": 2 }), done }).await.unwrap();
        drop(tx);
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), res).await.unwrap().unwrap(), Err(NOT_CONNECTED.to_string()));
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn 連不上時送的馬上回失敗_stop_就結束() {
        let (tx, rx) = mpsc::channel(8);
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let task = tokio::spawn(run_channel("ws://127.0.0.1:9/".into(), "tv_x".into(), true, Some(rx), async move { let _ = stop_rx.await; }, |_| {}));
        let (done, res) = oneshot::channel();
        tx.send(Outbound { event: "frame".into(), payload: json!({}), done }).await.unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), res).await.unwrap().unwrap(), Err(NOT_CONNECTED.to_string()));
        let _ = stop_tx.send(());
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
    }
}
