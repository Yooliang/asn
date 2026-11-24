//! 手機要核對這台電腦的指紋時，這台自動跳出 QR Code 視窗（#1863）。後台見 supabase/functions/_shared/fp_show.ts。
//!
//! - 手機送 fp_show_request 之後，後台敲這台的門鈴（kind=fp_show，只叫醒這裡的領取，見 bell.rs）。
//! - 這裡用節點金鑰 fp_show_take 領取：有 pending 的就開一扇 panel 視窗（panel.html?kind=fpshow），開好回報 shown（fp_show_ack）。
//! - closed 裡有它（手機掃完、取消、被新請求取代、過期），或開了滿 5 分鐘，就自己關窗。
//! - 本人在電腦上按「取消核對」或直接關掉視窗：回報 cancelled 並關窗。
//!
//! 指紋與 QR 的內容不經過後台：視窗自己向本機要（device_own_fingerprint_qr）。判斷都在純函式（decide、timed_out），方便測。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;

/// 視窗最多開多久（秒）：和後台請求的壽命一樣 5 分鐘
pub const WINDOW_SECS: u64 = 300;
/// 視窗開著時多久再領一次（秒）：門鈴漏了也能在幾秒內發現手機已經掃完、取消，把視窗收掉。沒開視窗時不輪詢，只等門鈴
pub const OPEN_POLL_SECS: u64 = 5;

/// 一次領取的結果：pending＝還沒顯示的（舊到新），live＝還活著的（pending／shown），closed＝最近被結束的
#[derive(Debug, Default, PartialEq)]
pub struct Take {
    pub pending: Vec<String>,
    pub live: Vec<String>,
    pub closed: Vec<String>,
}

/// 請求編號只收 uuid 的樣子（36 字、十六進位與 -），其他一律丟掉（外部資料，不拿來組網址以外的事）
fn valid_id(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() })
}

/// fp_show_take 的回應 → Take；格式不對的列丟掉
pub fn parse_take(v: &Value) -> Take {
    let rows = |k: &str| v.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let id_of = |r: &Value| r.get("id").and_then(Value::as_str).filter(|s| valid_id(s)).map(str::to_string);
    let mut t = Take::default();
    for r in rows("requests") {
        let Some(id) = id_of(&r) else { continue };
        if r.get("status").and_then(Value::as_str) == Some("pending") {
            t.pending.push(id.clone());
        }
        t.live.push(id);
    }
    t.closed = rows("closed").iter().filter_map(id_of).collect();
    t
}

/// 領取之後要做的事
#[derive(Debug, PartialEq)]
pub enum Act {
    /// 開視窗顯示這筆，開好回報 shown
    Open(String),
    /// 關掉開著的這筆（手機那邊已經結束）
    Close(String),
    /// 換成新的一筆（同一扇視窗，不先關再開）
    Switch { old: String, new: String },
}

/// 依領取結果決定要做什麼。open＝目前視窗顯示的請求；handled＝已經處理過（開過、關過、取消過）的請求，不再重開
pub fn decide(open: Option<&str>, take: &Take, handled: &HashSet<String>) -> Option<Act> {
    let newest = take.pending.iter().rev().find(|id| !handled.contains(*id) && Some(id.as_str()) != open);
    match (open, newest) {
        (Some(o), Some(n)) => Some(Act::Switch { old: o.to_string(), new: n.clone() }),
        (None, Some(n)) => Some(Act::Open(n.clone())),
        (Some(o), None) if take.closed.iter().any(|c| c == o) || !take.live.iter().any(|l| l == o) => Some(Act::Close(o.to_string())),
        _ => None,
    }
}

/// 視窗開了 elapsed 秒，到時間了沒（到了就自己關）
pub fn timed_out(elapsed_secs: u64) -> bool {
    elapsed_secs >= WINDOW_SECS
}

/// 目前的狀態：開著哪一筆（與開窗時刻，秒），處理過哪些
#[derive(Debug, Default)]
pub struct Tracker {
    pub open: Option<(String, u64)>,
    /// 目前開著的那扇視窗的標籤（每扇新視窗一個新標籤）。視窗被關掉的事件帶標籤進來，對不上的（我們自己剛關掉的舊窗）一律不理
    pub win: Option<String>,
    pub handled: HashSet<String>,
}

impl Tracker {
    pub fn open_id(&self) -> Option<&str> {
        self.open.as_ref().map(|(id, _)| id.as_str())
    }
}

/// 對外的動作：後台（領取、回報）與視窗（開、關）。實際的在 [`RealIo`]，測試用假的
pub trait FpIo {
    fn take(&self) -> impl Future<Output = Result<Value, String>> + Send;
    fn ack(&self, id: &str, status: &'static str) -> impl Future<Output = Result<(), String>> + Send;
    /// until_secs＝這扇視窗幾秒後要自己關（視窗算倒數用）。回傳這扇視窗的標籤（正在關的舊窗不會被拿來用）
    fn open_window(&self, id: &str, until_secs: u64) -> Result<String, String>;
    fn close_window(&self);
    fn log(&self, line: &str);
}

/// 開視窗並回報 shown；開不起來或回報失敗就關掉（手機會等到逾時，畫面說沒有回應）
async fn show<I: FpIo>(io: &I, tr: &mut Tracker, id: String, now: u64) {
    tr.handled.insert(id.clone());
    match io.open_window(&id, WINDOW_SECS) {
        Ok(label) => tr.win = Some(label),
        Err(e) => {
            io.log(&format!("指紋 QR Code：開視窗失敗：{e}"));
            tr.open = None;
            tr.win = None;
            return;
        }
    }
    tr.open = Some((id.clone(), now));
    if let Err(e) = io.ack(&id, "shown").await {
        io.log(&format!("指紋 QR Code：回報已顯示失敗，關掉視窗：{e}"));
        io.close_window();
        tr.open = None;
        tr.win = None;
    }
}

/// 視窗被關掉的事件（label＝被關掉的那扇）：只有對得上目前開著的視窗才當成本人關的；
/// 我們自己剛關掉的舊窗，事件晚到時新請求已經開了新窗，不能被它取消（#1863 一審）
pub async fn window_closed<I: FpIo>(io: &I, tr: &mut Tracker, label: &str) {
    if tr.win.as_deref() == Some(label) {
        cancel(io, tr, None).await;
    }
}

fn close<I: FpIo>(io: &I, tr: &mut Tracker, why: &str) {
    tr.win = None;
    if let Some((id, _)) = tr.open.take() {
        io.log(&format!("指紋 QR Code：關掉視窗（{why}）"));
        io.close_window();
        tr.handled.insert(id);
    }
}

/// 時間到就關（不打後台）。now＝單調時鐘的秒數
pub fn check_timeout<I: FpIo>(io: &I, tr: &mut Tracker, now: u64) {
    if tr.open.as_ref().is_some_and(|(_, at)| timed_out(now.saturating_sub(*at))) {
        close(io, tr, "開滿 5 分鐘");
    }
}

/// 領取一次並照結果開、換、關視窗
pub async fn step<I: FpIo>(io: &I, tr: &mut Tracker, now: u64) {
    check_timeout(io, tr, now);
    let v = match io.take().await {
        Ok(v) => v,
        Err(e) => {
            io.log(&format!("指紋 QR Code：領取失敗：{e}"));
            return;
        }
    };
    match decide(tr.open_id(), &parse_take(&v), &tr.handled) {
        Some(Act::Open(id)) => show(io, tr, id, now).await,
        Some(Act::Switch { old, new }) => {
            tr.handled.insert(old);
            tr.open = None;
            show(io, tr, new, now).await;
        }
        Some(Act::Close(_)) => close(io, tr, "手機那邊已經結束"),
        None => {}
    }
}

/// 本人在電腦上按「取消核對」（id＝視窗顯示的那筆）或直接關掉視窗（id＝None）：回報 cancelled 並關窗。
/// 不是目前開著的那筆（例如我們自己剛關掉的視窗觸發的關閉事件）就什麼都不做
pub async fn cancel<I: FpIo>(io: &I, tr: &mut Tracker, id: Option<&str>) {
    let Some(open) = tr.open_id().map(str::to_string) else { return };
    if id.is_some_and(|i| i != open) {
        return;
    }
    close(io, tr, "本人在電腦上取消");
    if let Err(e) = io.ack(&open, "cancelled").await {
        io.log(&format!("指紋 QR Code：回報取消失敗：{e}"));
    }
}

/// 從視窗與命令送進領取迴圈的事
#[derive(Debug)]
pub enum UiEvent {
    /// 按了「取消核對」
    Cancel(String),
    /// 視窗被關掉了（標題列的 X、原生外框的關閉）；帶那扇視窗的標籤
    Closed(String),
}

#[cfg(feature = "gui")]
pub use live::*;

#[cfg(feature = "gui")]
mod live {
    use super::*;
    use crate::relay::Relay;
    use serde_json::json;
    use std::sync::Arc;
    use tauri::{AppHandle, Manager};
    use tokio::sync::{mpsc, Notify};

    /// 視窗與命令把事送進來的入口（app.manage 進去，命令 fp_show_cancel 與視窗關閉事件用）
    pub struct UiTx(pub mpsc::UnboundedSender<UiEvent>);

    pub struct RealIo {
        pub app: AppHandle,
        pub relay: Arc<Relay>,
    }

    impl FpIo for RealIo {
        fn take(&self) -> impl Future<Output = Result<Value, String>> + Send {
            let r = self.relay.clone();
            async move { r.api("fp_show_take", Some(json!({}))).await }
        }
        fn ack(&self, id: &str, status: &'static str) -> impl Future<Output = Result<(), String>> + Send {
            let r = self.relay.clone();
            let body = json!({ "id": id, "status": status });
            async move { r.api("fp_show_ack", Some(body)).await.map(|_| ()) }
        }
        fn open_window(&self, id: &str, until_secs: u64) -> Result<String, String> {
            let until_ms = crate::heartbeat::now_ms() + until_secs * 1000;
            crate::wins::open_fp_show(&self.app, id, until_ms)
        }
        fn close_window(&self) {
            crate::wins::close_fp_show(&self.app);
        }
        fn log(&self, line: &str) {
            elog!("{line}");
        }
    }

    /// 背景的領取迴圈：啟動時領一次；之後門鈴（wake）叫醒就領；視窗開著時每 OPEN_POLL_SECS 秒再領一次並檢查 5 分鐘到了沒。
    /// 沒登入不領（後台本來就只發給本人的電腦，沒登入的電腦不會有人來核對）
    pub fn start(app: AppHandle, relay: Arc<Relay>, wake: Arc<Notify>) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        app.manage(UiTx(tx));
        tauri::async_runtime::spawn(async move {
            let io = RealIo { app: app.clone(), relay };
            let mut tr = Tracker::default();
            let base = std::time::Instant::now();
            let now = move || base.elapsed().as_secs();
            let signed_in = |app: &AppHandle| app.state::<crate::auth::AuthState>().status().signed_in;
            if signed_in(&app) {
                step(&io, &mut tr, now()).await;
            }
            loop {
                let has_open = tr.open.is_some();
                let poll = async move {
                    if has_open {
                        tokio::time::sleep(std::time::Duration::from_secs(OPEN_POLL_SECS)).await
                    } else {
                        std::future::pending::<()>().await
                    }
                };
                tokio::select! {
                    _ = wake.notified() => {
                        if signed_in(&app) { step(&io, &mut tr, now()).await }
                    }
                    _ = poll => {
                        if signed_in(&app) { step(&io, &mut tr, now()).await } else { check_timeout(&io, &mut tr, now()) }
                    }
                    ev = rx.recv() => match ev {
                        Some(UiEvent::Cancel(id)) => cancel(&io, &mut tr, Some(&id)).await,
                        Some(UiEvent::Closed(label)) => window_closed(&io, &mut tr, &label).await,
                        None => return,
                    },
                }
            }
        });
    }

    /// 視窗上按「取消核對」：交給領取迴圈回報 cancelled 並關窗
    #[tauri::command]
    pub fn fp_show_cancel(tx: tauri::State<'_, UiTx>, id: String) -> Result<(), String> {
        if !valid_id(&id) {
            return Err("資料格式不對".into());
        }
        tx.0.send(UiEvent::Cancel(id)).map_err(|_| "現在沒辦法取消，請稍後再試".to_string())
    }

    /// 視窗被關掉（X 或原生外框）：當成本人取消
    pub fn on_window_closed(app: &AppHandle, label: &str) {
        if let Some(tx) = app.try_state::<UiTx>() {
            let _ = tx.0.send(UiEvent::Closed(label.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    #[derive(Default)]
    struct Fake {
        take: Mutex<Vec<Result<Value, String>>>,
        ack_fail: bool,
        calls: Mutex<Vec<String>>,
        /// 目前開著的視窗標籤與已開過幾扇（模擬真的視窗：開著就沿用，關掉後再開是新的一扇、新標籤）
        win: Mutex<(Option<String>, u32)>,
    }
    impl Fake {
        fn with(takes: Vec<Value>) -> Self {
            Fake { take: Mutex::new(takes.into_iter().rev().map(Ok).collect()), ..Default::default() }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn push(&self, s: String) {
            self.calls.lock().unwrap().push(s);
        }
    }
    impl FpIo for Fake {
        fn take(&self) -> impl Future<Output = Result<Value, String>> + Send {
            self.push("take".into());
            let r = self.take.lock().unwrap().pop().unwrap_or(Ok(json!({ "requests": [], "closed": [] })));
            async move { r }
        }
        fn ack(&self, id: &str, status: &'static str) -> impl Future<Output = Result<(), String>> + Send {
            self.push(format!("ack {id} {status}"));
            let fail = self.ack_fail;
            async move { if fail { Err("fp_show_ack HTTP 404 not_found".into()) } else { Ok(()) } }
        }
        fn open_window(&self, id: &str, until: u64) -> Result<String, String> {
            self.push(format!("open {id} {until}"));
            let mut w = self.win.lock().unwrap();
            if w.0.is_none() {
                w.1 += 1;
                w.0 = Some(format!("w{}", w.1));
            }
            Ok(w.0.clone().unwrap())
        }
        fn close_window(&self) {
            self.push("close".into());
            self.win.lock().unwrap().0 = None;
        }
        fn log(&self, _: &str) {}
    }

    fn run<F: Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }
    fn req(id: &str, status: &str) -> Value {
        json!({ "id": id, "status": status, "expires_at": "2026-11-25T00:05:00Z" })
    }

    #[test]
    fn 領取結果_格式不對的列丟掉() {
        let t = parse_take(&json!({ "requests": [req(A, "pending"), req(B, "shown"), { "id": "../x", "status": "pending" }, { "status": "pending" }], "closed": [{ "id": A, "status": "ended" }, { "id": 5 }] }));
        assert_eq!(t.pending, vec![A.to_string()]);
        assert_eq!(t.live, vec![A.to_string(), B.to_string()]);
        assert_eq!(t.closed, vec![A.to_string()]);
        assert_eq!(parse_take(&Value::Null), Take::default());
    }

    #[test]
    fn 決定_有新的就開_換掉舊的_手機結束就關() {
        let none = HashSet::new();
        let t = |p: &[&str], l: &[&str], c: &[&str]| Take { pending: p.iter().map(|s| s.to_string()).collect(), live: l.iter().map(|s| s.to_string()).collect(), closed: c.iter().map(|s| s.to_string()).collect() };
        assert_eq!(decide(None, &t(&[A], &[A], &[]), &none), Some(Act::Open(A.into())));
        assert_eq!(decide(None, &t(&[], &[], &[]), &none), None);
        assert_eq!(decide(Some(A), &t(&[], &[A], &[]), &none), None, "還活著：不動");
        assert_eq!(decide(Some(A), &t(&[], &[], &[A]), &none), Some(Act::Close(A.into())), "closed 裡有它：關");
        assert_eq!(decide(Some(A), &t(&[], &[], &[]), &none), Some(Act::Close(A.into())), "活的清單裡已經沒有它（例如被結束超過 5 分鐘）：關");
        assert_eq!(decide(Some(A), &t(&[B], &[A, B], &[]), &none), Some(Act::Switch { old: A.into(), new: B.into() }));
        let done: HashSet<String> = [A.to_string()].into();
        assert_eq!(decide(None, &t(&[A], &[A], &[]), &done), None, "處理過（取消過）的不再開");
    }

    #[test]
    fn 時間到_滿5分鐘才算() {
        assert!(!timed_out(0) && !timed_out(WINDOW_SECS - 1));
        assert!(timed_out(WINDOW_SECS) && timed_out(WINDOW_SECS + 60));
        assert_eq!(WINDOW_SECS, 300, "和後台請求的壽命一樣");
    }

    #[test]
    fn 領到_pending_會開窗並回報_shown() {
        let io = Fake::with(vec![json!({ "requests": [req(A, "pending")], "closed": [] })]);
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 10));
        assert_eq!(io.calls(), vec!["take".to_string(), format!("open {A} {WINDOW_SECS}"), format!("ack {A} shown")]);
        assert_eq!(tr.open_id(), Some(A));
    }

    #[test]
    fn 回報_shown_失敗就關窗() {
        let io = Fake { ack_fail: true, ..Fake::with(vec![json!({ "requests": [req(A, "pending")], "closed": [] })]) };
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 10));
        assert_eq!(io.calls().last().map(String::as_str), Some("close"));
        assert_eq!(tr.open_id(), None);
    }

    #[test]
    fn closed_裡有它就關窗() {
        let io = Fake::with(vec![json!({ "requests": [req(A, "pending")], "closed": [] }), json!({ "requests": [], "closed": [{ "id": A, "status": "ended" }] })]);
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 10));
        run(step(&io, &mut tr, 15));
        assert_eq!(io.calls().last().map(String::as_str), Some("close"));
        assert_eq!(tr.open_id(), None);
        assert!(!io.calls().iter().any(|c| c.contains("cancelled")), "手機那邊結束的不回報取消");
    }

    #[test]
    fn 開滿5分鐘自動關窗_之後不再開同一筆() {
        let live = json!({ "requests": [req(A, "shown")], "closed": [] });
        let io = Fake::with(vec![json!({ "requests": [req(A, "pending")], "closed": [] }), live.clone(), live]);
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 100));
        run(step(&io, &mut tr, 100 + WINDOW_SECS - 1));
        assert_eq!(tr.open_id(), Some(A), "還沒滿 5 分鐘：開著");
        run(step(&io, &mut tr, 100 + WINDOW_SECS));
        assert_eq!(tr.open_id(), None, "滿 5 分鐘：關");
        assert_eq!(io.calls().iter().filter(|c| *c == "close").count(), 1);
        assert_eq!(io.calls().iter().filter(|c| c.starts_with("open")).count(), 1, "同一筆不重開");
    }

    #[test]
    fn 新請求取代舊的_同一扇視窗換內容() {
        let io = Fake::with(vec![json!({ "requests": [req(A, "pending")], "closed": [] }), json!({ "requests": [req(B, "pending")], "closed": [{ "id": A, "status": "superseded" }] })]);
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 1));
        run(step(&io, &mut tr, 2));
        assert_eq!(tr.open_id(), Some(B));
        assert!(!io.calls().contains(&"close".to_string()), "換內容不先關窗（同一個標籤，關到一半再開會撞名）");
        assert!(io.calls().contains(&format!("ack {B} shown")));
    }

    #[test]
    fn 電腦上取消_回報_cancelled_並關窗_別筆或沒開就不動() {
        let io = Fake::with(vec![json!({ "requests": [req(A, "pending")], "closed": [] })]);
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 1));
        run(cancel(&io, &mut tr, Some(B)));
        assert_eq!(tr.open_id(), Some(A), "不是這筆：不動");
        run(cancel(&io, &mut tr, Some(A)));
        assert_eq!(tr.open_id(), None);
        assert_eq!(io.calls()[io.calls().len() - 2..], ["close".to_string(), format!("ack {A} cancelled")]);
        let n = io.calls().len();
        run(cancel(&io, &mut tr, None));
        assert_eq!(io.calls().len(), n, "我們自己關掉的視窗觸發的關閉事件：不再回報");
    }

    #[test]
    fn 舊窗的關閉事件晚到_新請求已開窗_不能被取消() {
        let io = Fake::with(vec![
            json!({ "requests": [req(A, "pending")], "closed": [] }),
            json!({ "requests": [], "closed": [{ "id": A, "status": "ended" }] }),
            json!({ "requests": [req(B, "pending")], "closed": [] }),
        ]);
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 1)); // 開 A（視窗 w1）
        run(step(&io, &mut tr, 2)); // 手機結束 A：我們關 w1
        run(step(&io, &mut tr, 3)); // B 進來：開新的一扇 w2
        assert_eq!(tr.open_id(), Some(B));
        assert_eq!(tr.win.as_deref(), Some("w2"));
        let n = io.calls().len();
        run(window_closed(&io, &mut tr, "w1")); // w1 的 Destroyed 現在才到
        assert_eq!(tr.open_id(), Some(B), "舊窗的關閉事件不能取消新請求");
        assert_eq!(io.calls().len(), n, "不回報、不關窗");
        assert!(io.calls().contains(&format!("ack {B} shown")), "新請求照常回報 shown");
        run(window_closed(&io, &mut tr, "w2")); // 對得上的才算本人關的
        assert_eq!(tr.open_id(), None);
        assert_eq!(io.calls().last(), Some(&format!("ack {B} cancelled")));
    }

    #[test]
    fn 直接關掉視窗_當成取消() {
        let io = Fake::with(vec![json!({ "requests": [req(A, "pending")], "closed": [] })]);
        let mut tr = Tracker::default();
        run(step(&io, &mut tr, 1));
        run(window_closed(&io, &mut tr, "w1"));
        assert_eq!(io.calls().last(), Some(&format!("ack {A} cancelled")));
    }
}
