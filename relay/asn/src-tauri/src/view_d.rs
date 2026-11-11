//! 看別台電腦的畫面，看的那台（D）的共用核心：電腦版與手機版的 tauri 命令都呼叫這裡。
//!
//! - [`begin`]：用設備金鑰簽、向後台發起、比對那台的設備公鑰（TOFU，換了就不開始並通知本人）。電腦版與手機版共用。
//! - [`start_view`]：手機用的入口，**只看畫面**，要求打字（scope=input）一律拒絕。
//! - [`spawn_view`]：只看畫面的收幀迴圈（手機用；電腦版因為還有打字，另有自己的迴圈）。每 15 秒回報、不簽章，只收不送。
//! - 後端（權杖、設備金鑰、後台、認得的電腦）與畫面（送畫面、送結束）都用 trait 注入，所以單元測試不用網路也不用視窗。
//! - 紀錄只有長度和次數，沒有畫面內容。
use crate::device_id::{DeviceKey, KnownPeers, Tofu};
use crate::view_frame::Frame;
use crate::view_handshake::{self, Eph, Scope, Session};
use crate::view_remote::{self, RemoteViews, Want};
use serde_json::{json, Value};
use std::future::Future;
use std::sync::Arc;

/// 手機只能看，不能打字
pub const INPUT_NOT_ON_MOBILE: &str = "手機只能看畫面，不能打字";
/// 手機要在那台電腦打字，要先確認過它的指紋
pub const INPUT_NEEDS_CONFIRM: &str = "要先確認這台電腦的指紋，才能在手機上打字";
/// 回報連續失敗超過這麼久就放棄（和電腦版 view_stream 同值，測試鎖住）
pub const LOST_AFTER_MS: u64 = 90_000;
/// 畫面事件名（電腦版與手機版相同，前端 remoteViewApi.listen 聽這兩個）
pub const FRAME_EVENT: &str = "term-view-remote-frame";
pub const END_EVENT: &str = "term-view-remote-end";

/// 發起與回報要用的外部動作
pub trait ViewBackend: Send + Sync + 'static {
    /// 本人簽章的權杖；沒登入回錯
    fn token(&self) -> impl Future<Output = Result<String, String>> + Send;
    /// 這台的設備金鑰
    fn key(&self) -> impl Future<Output = Result<DeviceKey, String>> + Send;
    /// 帶權杖打後台
    fn api(&self, action: &str, body: Value, token: &str) -> impl Future<Output = Result<Value, String>> + Send;
    /// 本機記住的電腦
    fn known(&self) -> Result<KnownPeers, String>;
    /// 驗過 T 的簽章後記住它（第一次看到的才需要）
    fn see(&self, node: &str, name: &str, sign_pub: &str, now_ms: u64) -> Result<Tofu, String>;
    /// 通知本人（公鑰換了）
    fn alert(&self, peer: &str, kind: &str, sign_pub: &str) -> impl Future<Output = ()> + Send;
}

/// 畫面那邊：收到的畫面與結束交給誰
pub trait ViewSink: Send + Sync + 'static {
    fn emit(&self, event: &'static str, payload: Value);
    fn log(&self, line: String);
}

/// 要看的那台：節點、名字、設備公鑰，和本機記住的比過的結果
#[derive(Debug, Clone)]
pub struct Target {
    pub node: String,
    pub name: String,
    pub sign_pub: String,
    pub tofu: Tofu,
    /// 本人在手機上確認過這把公鑰的指紋（只有記住的同一把才算；第一次看到的一律是 false）
    pub confirmed: bool,
}

/// 發起成功後的資料
pub struct Begun {
    pub id: String,
    pub session: Session,
    pub eph: Eph,
    pub topic: String,
    pub target: Target,
}

/// 毫秒 → `2026-10-24T12:00:00Z`（後台要的到期時間格式）
pub fn iso_secs(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let (y, m, d) = crate::timeutil::civil_from_days(s.div_euclid(86400));
    let r = s.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, r % 3600 / 60, r % 60)
}

/// 前端傳來的機器名：去掉控制字元、最多 64 字
pub fn clean_machine(machine: Option<String>) -> String {
    machine.unwrap_or_default().chars().filter(|c| !c.is_control()).take(64).collect()
}

/// 看畫面或打字。沒帶是看畫面；其他字一律不收；`allow_input` 為 false（手機）時要求打字一律拒絕
pub fn parse_scope(raw: Option<&str>, allow_input: bool) -> Result<Scope, String> {
    let scope = match raw {
        None => Scope::View,
        Some(x) => Scope::parse(x).ok_or("不認得的範圍")?,
    };
    if scope == Scope::Input && !allow_input {
        return Err(INPUT_NOT_ON_MOBILE.into());
    }
    Ok(scope)
}

async fn report_ended<B: ViewBackend>(b: &B, id: &str, token: &str) {
    let _ = b.api("term_view_report", json!({ "id": id, "state": "ended" }), token).await;
}

/// 發起一次觀看。失敗時不留下登記的觀看；回（觀看編號、握手資料、頻道名、那台的資料）
#[allow(clippy::too_many_arguments)]
pub async fn begin<B: ViewBackend>(b: &B, views: &RemoteViews, me_node: &str, to_node: String, partner: String, machine: String, scope: Scope, now_ms: u64) -> Result<Begun, String> {
    begin_on(b, views, me_node, to_node, partner, machine, scope, now_ms, false).await
}

/// 電腦版與手機版共用的發起；phone 為 true 時，金鑰變了給手機用的說法（帶新指紋），要打字還得先確認過指紋
#[allow(clippy::too_many_arguments)]
async fn begin_on<B: ViewBackend>(b: &B, views: &RemoteViews, me_node: &str, to_node: String, partner: String, machine: String, scope: Scope, now_ms: u64, phone: bool) -> Result<Begun, String> {
    let token = b.token().await?;
    let key = b.key().await?;
    let id = view_remote::new_session_id()?;
    let now_s = (now_ms / 1000) as i64;
    let s = view_remote::session(&id, me_node, &to_node, &partner, scope, now_s);
    views.add(&id)?;
    let (eph, d_sig) = match view_handshake::d_start(&key, &s, now_s) {
        Ok(v) => v,
        Err(e) => {
            views.remove(&id);
            return Err(e);
        }
    };
    let body = json!({ "id": id, "to_node": to_node, "window_name": partner, "d_eph_pub": eph.public_b64(), "d_sig": d_sig, "expires_at": iso_secs(s.expires_s * 1000), "scope": scope.as_str() });
    let started = b.api("term_view_start", body, &token).await.ok();
    let field = |k: &str| started.as_ref().and_then(|v| v.get(k).and_then(Value::as_str).map(str::to_string));
    let (Some(topic), Some(to_pub)) = (field("topic"), field("to_pub")) else {
        views.remove(&id);
        return Err("沒有發起成功，請稍後再試".into());
    };
    // 那台的設備公鑰先和本機記住的比（TOFU）：換了就不開始、通知本人（兩邊都寄 changed）
    // remembered：這支手機自己記住的名字與那把公鑰（金鑰變了的說明只用這份，不用後台這次給的名字）
    let (tofu, confirmed, remembered) = match b.known() {
        Ok(k) => {
            let t = k.check(&to_node, &to_pub);
            let remembered = k.peer(&to_node).map(|p| (p.name.clone(), p.sign_pub.clone(), p.confirmed_at.is_some()));
            // 確認只算在記住的同一把公鑰上：不是 Same 一律當沒確認
            (t, t == Tofu::Same && crate::device_id::phone_input_allowed(k.peer(&to_node)), remembered)
        }
        Err(e) => {
            views.remove(&id);
            report_ended(b, &id, &token).await;
            return Err(e);
        }
    };
    if tofu == Tofu::Changed {
        views.remove(&id);
        report_ended(b, &id, &token).await;
        b.alert(&to_node, "changed", &to_pub).await;
        let msg = if phone {
            let (local_name, old_pub, was_confirmed) = remembered.unwrap_or_default();
            // 原本那把還沒確認過：不顯示它的指紋（確認時要從選項選出它，不能先給網頁看到）
            let old_fp = was_confirmed.then(|| crate::device_id::fp_grouped(&old_pub));
            view_remote::phone_key_changed_text(&clean_machine(Some(local_name)), old_fp.as_deref(), &crate::device_id::fp_grouped(&to_pub))
        } else {
            view_remote::TARGET_KEY_CHANGED.to_string()
        };
        return Err(msg);
    }
    // 手機要打字得先確認過那台的指紋（現在手機只能看；之後開放打字時這裡照樣擋）
    if phone && scope == Scope::Input && !confirmed {
        views.remove(&id);
        report_ended(b, &id, &token).await;
        return Err(INPUT_NEEDS_CONFIRM.into());
    }
    Ok(Begun { id, session: s, eph, topic, target: Target { node: to_node, name: machine, sign_pub: to_pub, tofu, confirmed } })
}

/// 手機的入口：只看畫面。要求打字（scope=input）在做任何事之前就拒絕
#[allow(clippy::too_many_arguments)]
pub async fn start_view<B: ViewBackend>(b: &B, views: &RemoteViews, me_node: &str, to_node: String, partner: String, machine: Option<String>, scope: Option<&str>, now_ms: u64) -> Result<Begun, String> {
    let scope = parse_scope(scope, false)?;
    begin_on(b, views, me_node, to_node, partner, clean_machine(machine), scope, now_ms, true).await
}

/// 本人把觀看畫面藏起來（暫停）或叫出來（繼續）
pub fn set_paused(views: &RemoteViews, id: &str, paused: bool) {
    views.set(id, if paused { Want::Paused } else { Want::Watching });
}

/// 本人按「結束」
pub fn stop(views: &RemoteViews, id: &str) {
    views.set(id, Want::Ended);
}

/// 前端收到的畫面
pub fn frame_payload(id: &str, f: &Frame) -> Value {
    json!({ "id": id, "text": f.text, "meta": { "cursor_x": f.cursor_x, "cursor_y": f.cursor_y, "cols": f.cols, "rows": f.rows } })
}

/// 開始（回給前端的）資料
pub fn started_json(id: &str, expires_s: i64, scope: Scope) -> Value {
    json!({ "id": id, "expires_s": expires_s, "scope": scope.as_str() })
}

/// 手機看畫面開始後回給畫面的資料：多帶有沒有確認過、那台的節點。**不帶指紋**：
/// 沒確認過的電腦，畫面不能知道它的指紋（確認靠四選一，答案只在 Rust）
pub fn started_view_json(begun: &Begun) -> Value {
    let mut v = started_json(&begun.id, begun.session.expires_s, begun.session.scope);
    v["confirmed"] = json!(begun.target.confirmed);
    v["node"] = json!(begun.target.node);
    v
}

/// 只看畫面的背景：每 15 秒回報一次（不簽章、不確認本人）；拿到對方的公鑰就導出金鑰、開接收頻道；結束就收掉、告訴畫面。
/// 接收頻道只收不送，收到的畫面經 view_remote::receive（解密、擋重放、再過濾）才交給畫面
pub fn spawn_view<B: ViewBackend, S: ViewSink>(b: Arc<B>, sink: Arc<S>, views: Arc<RemoteViews>, url: String, begun: Begun) {
    crate::rt::spawn(run_view(b, sink, views, url, begun));
}

async fn run_view<B: ViewBackend, S: ViewSink>(b: Arc<B>, sink: Arc<S>, views: Arc<RemoteViews>, url: String, begun: Begun) {
    let Begun { id, session: s, eph, topic, target } = begun;
    let mut eph = Some(eph);
    let mut stop_tx: Option<tokio::sync::oneshot::Sender<()>> = None;
    let frames_seen = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut failed_since: Option<u64> = None;
    let began_ms = crate::auth::now_ms();
    let reason = loop {
        let want = views.want(&id);
        let token = b.token().await;
        let rep = match &token {
            Ok(t) => b.api("term_view_report", json!({ "id": id, "state": want.report_state() }), t).await,
            Err(e) => Err(e.clone()),
        };
        if want == Want::Ended {
            break "viewer_ended".to_string();
        }
        let now_ms = crate::auth::now_ms();
        match rep {
            Ok(v) => {
                failed_since = None;
                match view_remote::step_of(&v) {
                    view_remote::Step::Ended(r) => break r,
                    view_remote::Step::Accepted { t_eph, t_sig } if eph.is_some() => {
                        let Some(e) = eph.take() else { break "failed".to_string() };
                        let mut rx = match view_remote::finish(&target.sign_pub, e, &s, &t_eph, &t_sig, (now_ms / 1000) as i64) {
                            Ok(rx) => rx,
                            Err(_) => break "rejected".to_string(),
                        };
                        // 第一次看到這台：T 的簽章驗過才記住（first 通知只有 T 寄）；記不住就不看
                        if target.tofu == Tofu::New && !matches!(b.see(&target.node, &target.name, &target.sign_pub, now_ms), Ok(Tofu::New | Tofu::Same)) {
                            break "failed".to_string();
                        }
                        let (tx, stop) = tokio::sync::oneshot::channel::<()>();
                        stop_tx = Some(tx);
                        let (sink2, views2, id2, seen) = (sink.clone(), views.clone(), id.clone(), frames_seen.clone());
                        crate::rt::spawn(crate::bell::run_channel(url.clone(), topic.clone(), false, None::<tokio::sync::mpsc::Receiver<crate::bell::Outbound>>, async move { let _ = stop.await; }, move |ev| {
                            let crate::bell::Event::Broadcast { event, payload } = ev else { return };
                            let Some(w) = view_remote::frame_wire(event, payload) else { return };
                            match view_remote::receive(&mut rx, &w) {
                                view_remote::Show::Frame(f) => {
                                    seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                    if views2.want(&id2) == Want::Watching {
                                        sink2.emit(FRAME_EVENT, frame_payload(&id2, &f));
                                    }
                                }
                                view_remote::Show::Skip => {}
                                view_remote::Show::End => views2.set(&id2, Want::Ended),
                            }
                        }));
                    }
                    _ => {}
                }
            }
            Err(_) => {
                let since = *failed_since.get_or_insert(now_ms);
                if now_ms.saturating_sub(since) > LOST_AFTER_MS {
                    break "failed".to_string();
                }
            }
        }
        if (now_ms / 1000) as i64 >= s.expires_s {
            break "expired".to_string();
        }
        // 等下一次回報；本人按結束或藏起來時早一點回報
        let before = views.want(&id);
        let wait_s = view_remote::report_wait_s(eph.is_none(), crate::auth::now_ms().saturating_sub(began_ms) / 1000);
        for _ in 0..wait_s {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if views.want(&id) != before {
                break;
            }
        }
    };
    if reason != "viewer_ended" {
        // 對方先結束、到期或出錯：照樣告訴後台這邊結束了（失敗也沒關係，後台到期會清）
        if let Ok(t) = b.token().await {
            report_ended(b.as_ref(), &id, &t).await;
        }
    }
    drop(stop_tx.take());
    let frames = frames_seen.load(std::sync::atomic::Ordering::Relaxed);
    views.remove(&id);
    sink.emit(END_EVENT, json!({ "id": id, "text": view_remote::end_text(&reason) }));
    sink.log(format!("{} info [ASN] remote-view end reason={reason} frames={frames}", iso_secs(crate::auth::now_ms() as i64)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 不加密的保護層（測試用）
    struct Plain;
    impl crate::auth::Protector for Plain {
        fn protect(&self, p: &[u8]) -> Result<Vec<u8>, String> {
            Ok(p.to_vec())
        }
        fn unprotect(&self, s: &[u8]) -> Result<Vec<u8>, String> {
            Ok(s.to_vec())
        }
    }

    /// 假後端：記下打了哪些動作，後台回什麼由測試決定
    struct Fake {
        dir: tempfile::TempDir,
        started: Option<Value>,
        known: KnownPeers,
        calls: Mutex<Vec<(String, Value)>>,
        alerts: Mutex<Vec<(String, String)>>,
    }

    impl Fake {
        fn new(started: Option<Value>, known: KnownPeers) -> Fake {
            Fake { dir: tempfile::tempdir().unwrap(), started, known, calls: Mutex::new(vec![]), alerts: Mutex::new(vec![]) }
        }
        fn actions(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|c| c.0.clone()).collect()
        }
    }

    impl ViewBackend for Fake {
        fn token(&self) -> impl Future<Output = Result<String, String>> + Send {
            async { Ok("tok".to_string()) }
        }
        fn key(&self) -> impl Future<Output = Result<DeviceKey, String>> + Send {
            let r = crate::device_id::load_or_create(self.dir.path(), &Plain);
            async move { r }
        }
        fn api(&self, action: &str, body: Value, _token: &str) -> impl Future<Output = Result<Value, String>> + Send {
            self.calls.lock().unwrap().push((action.to_string(), body));
            let out = if action == "term_view_start" { self.started.clone().ok_or_else(|| "壞了".to_string()) } else { Ok(json!({})) };
            async move { out }
        }
        fn known(&self) -> Result<KnownPeers, String> {
            Ok(self.known.clone())
        }
        fn see(&self, _: &str, _: &str, _: &str, _: u64) -> Result<Tofu, String> {
            Ok(Tofu::New)
        }
        fn alert(&self, peer: &str, kind: &str, _sign_pub: &str) -> impl Future<Output = ()> + Send {
            self.alerts.lock().unwrap().push((peer.to_string(), kind.to_string()));
            async {}
        }
    }

    fn run<F: Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    fn known_with(node: &str, pubk: &str) -> KnownPeers {
        let mut k = KnownPeers::default();
        k.remember(node, "工作機", pubk, 1).unwrap();
        k
    }

    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn 發起成功_登記觀看_回頻道和那台的資料() {
        let b = Fake::new(Some(json!({ "topic": "t1", "to_pub": "pk" })), KnownPeers::default());
        let v = RemoteViews::default();
        let got = run(start_view(&b, &v, "phone", "pc".into(), "夥伴".into(), Some("工作\n機".into()), None, NOW)).unwrap();
        assert_eq!(got.topic, "t1");
        assert_eq!(got.session.scope, Scope::View);
        assert_eq!((got.target.node.as_str(), got.target.name.as_str(), got.target.tofu), ("pc", "工作機", Tofu::New), "控制字元被去掉、第一次看到");
        assert_eq!(v.want(&got.id), Want::Watching);
        assert_eq!(b.actions(), vec!["term_view_start"]);
        let body = b.calls.lock().unwrap()[0].1.clone();
        assert_eq!(body["scope"], "view");
        assert_eq!(body["to_node"], "pc");
    }

    #[test]
    fn 那台換金鑰_不開始_通知本人_回報結束_不留登記() {
        let b = Fake::new(Some(json!({ "topic": "t1", "to_pub": "new-key" })), known_with("pc", "old-key"));
        let v = RemoteViews::default();
        // 後台這次給的名字不能出現在說明裡：只用這支手機自己記住的「工作機」
        let err = run(start_view(&b, &v, "phone", "pc".into(), "夥伴".into(), Some("後台給的名字".into()), None, NOW)).err().unwrap();
        let (old_fp, new_fp) = (crate::device_id::fp_grouped("old-key"), crate::device_id::fp_grouped("new-key"));
        assert!(err.contains(&new_fp), "手機看到的話帶新的完整指紋（分組）：{err}");
        assert!(!err.contains(&old_fp), "原本那把還沒確認過：不顯示它的指紋：{err}");
        assert!(err.contains("設定 → 認得的電腦"), "{err}");
        assert!(err.contains("「工作機」") && !err.contains("後台給的名字"), "名字用本機記住的：{err}");
        assert_eq!(err, view_remote::phone_key_changed_text("工作機", None, &new_fp));
        assert!(view_remote::phone_key_changed_text("", None, &new_fp).starts_with("這台電腦的金鑰"), "本機沒記名字就寫這台電腦");
        // 原本那把確認過：才帶原本的指紋
        let mut k = known_with("pc", "old-key");
        assert!(k.confirm("pc", &crate::device_id::fingerprint("old-key"), NOW));
        let b2 = Fake::new(Some(json!({ "topic": "t1", "to_pub": "new-key" })), k);
        let err2 = run(start_view(&b2, &RemoteViews::default(), "phone", "pc".into(), "夥伴".into(), None, None, NOW)).err().unwrap();
        assert!(err2.contains(&old_fp) && err2.contains(&new_fp), "{err2}");
        assert_eq!(b.alerts.lock().unwrap().clone(), vec![("pc".to_string(), "changed".to_string())]);
        assert_eq!(b.actions(), vec!["term_view_start", "term_view_report"]);
        let sent_id = b.calls.lock().unwrap()[0].1["id"].as_str().unwrap().to_string();
        assert_eq!(v.want(&sent_id), Want::Ended, "登記已經拿掉");
        for _ in 0..view_remote::MAX_OPEN {
            v.add(&format!("x{}", sent_id.len())).ok();
        }
    }

    #[test]
    fn 同一把金鑰照常看() {
        let b = Fake::new(Some(json!({ "topic": "t1", "to_pub": "same" })), known_with("pc", "same"));
        let v = RemoteViews::default();
        let got = run(start_view(&b, &v, "phone", "pc".into(), "夥伴".into(), None, None, NOW)).unwrap();
        assert_eq!(got.target.tofu, Tofu::Same);
        assert!(!got.target.confirmed, "記住了但沒確認過");
    }

    #[test]
    fn 手機的開始資料_帶有沒有確認_不帶指紋_確認只算記住的同一把() {
        let fp = crate::device_id::fingerprint("same");
        let mut k = known_with("pc", "same");
        let b = Fake::new(Some(json!({ "topic": "t1", "to_pub": "same" })), k.clone());
        let got = run(start_view(&b, &RemoteViews::default(), "phone", "pc".into(), "夥伴".into(), Some("工作機".into()), None, NOW)).unwrap();
        let j = started_view_json(&got);
        assert_eq!((j["confirmed"].clone(), j["node"].clone()), (json!(false), json!("pc")));
        assert!(j.get("fp").is_none() && j.get("fp8").is_none(), "不帶指紋：{j}");
        assert!(!j.to_string().contains(&fp));
        assert!(k.confirm("pc", &fp, NOW));
        let b = Fake::new(Some(json!({ "topic": "t1", "to_pub": "same" })), k.clone());
        let got = run(start_view(&b, &RemoteViews::default(), "phone", "pc".into(), "夥伴".into(), None, None, NOW)).unwrap();
        assert!(got.target.confirmed && started_view_json(&got)["confirmed"] == json!(true));
        // 第一次看到的：還沒記住，一定是沒確認
        let b = Fake::new(Some(json!({ "topic": "t1", "to_pub": "same" })), KnownPeers::default());
        let got = run(start_view(&b, &RemoteViews::default(), "phone", "pc".into(), "夥伴".into(), None, None, NOW)).unwrap();
        assert_eq!((got.target.tofu, got.target.confirmed), (Tofu::New, false));
        let j = started_view_json(&got);
        assert!(j.get("fp").is_none() && j.get("fp8").is_none() && !j.to_string().contains(&fp), "{j}");
    }

    #[test]
    fn 第一次看到的電腦_記住是沒確認的() {
        let mut k = KnownPeers::default();
        k.remember("pc", "工作機", "pk", 5).unwrap();
        assert_eq!(k.peer("pc").unwrap().confirmed_at, None);
        assert!(!crate::device_id::phone_input_allowed(k.peer("pc")));
    }

    #[test]
    fn 要求打字一律拒絕_什麼都不做() {
        let b = Fake::new(Some(json!({ "topic": "t1", "to_pub": "pk" })), KnownPeers::default());
        let v = RemoteViews::default();
        let err = run(start_view(&b, &v, "phone", "pc".into(), "夥伴".into(), None, Some("input"), NOW)).err().unwrap();
        assert_eq!(err, INPUT_NOT_ON_MOBILE);
        assert!(b.actions().is_empty(), "連後台都不打");
        assert_eq!(run(start_view(&b, &v, "phone", "pc".into(), "夥伴".into(), None, Some("亂寫"), NOW)).err().unwrap(), "不認得的範圍");
        assert_eq!(parse_scope(Some("view"), false).unwrap(), Scope::View);
        assert_eq!(parse_scope(Some("input"), true).unwrap(), Scope::Input, "電腦版照舊可以打字");
    }

    #[test]
    fn 後台沒回頻道_發起失敗_不留登記() {
        let b = Fake::new(None, KnownPeers::default());
        let v = RemoteViews::default();
        for _ in 0..(view_remote::MAX_OPEN + 1) {
            assert_eq!(run(start_view(&b, &v, "phone", "pc".into(), "夥伴".into(), None, None, NOW)).err().unwrap(), "沒有發起成功，請稍後再試", "失敗不佔名額");
        }
    }

    #[test]
    fn 暫停_繼續_結束() {
        let v = RemoteViews::default();
        v.add("a").unwrap();
        set_paused(&v, "a", true);
        assert_eq!(v.want("a"), Want::Paused);
        set_paused(&v, "a", false);
        assert_eq!(v.want("a"), Want::Watching);
        stop(&v, "a");
        assert_eq!(v.want("a"), Want::Ended);
        set_paused(&v, "a", false);
        assert_eq!(v.want("a"), Want::Ended, "結束了就是結束了");
    }

    #[test]
    fn 到期時間格式和畫面事件() {
        assert_eq!(iso_secs(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_secs(1_800_000_000_000), crate::claude_quota::iso_secs(1_800_000_000_000));
        assert_eq!((FRAME_EVENT, END_EVENT), ("term-view-remote-frame", "term-view-remote-end"));
        let f = Frame { text: "x".into(), cursor_x: 1, cursor_y: 2, cols: 80, rows: 24, ack: None };
        assert_eq!(frame_payload("i", &f), json!({ "id": "i", "text": "x", "meta": { "cursor_x": 1, "cursor_y": 2, "cols": 80, "rows": 24 } }));
        assert_eq!(started_json("i", 5, Scope::View), json!({ "id": "i", "expires_s": 5, "scope": "view" }));
    }

    #[cfg(desktop)]
    #[test]
    fn 放棄時限和電腦版相同() {
        assert_eq!(LOST_AFTER_MS, crate::view_stream::LOST_AFTER_MS);
    }

    #[test]
    fn 守門_這裡只收不送_不確認本人() {
        let src = include_str!("view_d.rs");
        let code = src.split("\n#[cfg(test)]").next().unwrap();
        for bad in ["send_via", "presence::", "sign_b64", "live::forget", "live::confirm"] {
            assert!(!code.contains(bad), "看的那台的背景流程不能有：{bad}");
        }
    }
}
