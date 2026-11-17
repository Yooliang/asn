//! 回信寄不出去不能默默丟掉（#1135 A、B1）：引擎視窗的一對一回信被後台明確拒絕、群組回信貼不進去。假後端、假 worker。
//! 引擎視窗用 pi 視窗（只是登記檔，完全不啟動 pi），原信與群組訊息都由橋收進它的收件匣。
use super::rooms_launch::{rmsg, room};
use super::*;
use crate::bridge::engines::{self, EngineCtx, EngineEvent, EngineSet, PidBook};

const SECRET: &str = "好的，已處理-機密內文";

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

struct PR {
    core: Core,
    fr: FakeRelay,
    set: Arc<EngineSet>,
    rx: tokio::sync::mpsc::UnboundedReceiver<EngineEvent>,
    _work: tempfile::TempDir,
    _home: tempfile::TempDir,
    _sessions: tempfile::TempDir,
}

impl Drop for PR {
    fn drop(&mut self) {
        self.set.stop();
    }
}

async fn rig() -> PR {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
    let ctx = EngineCtx {
        log: Arc::new(|_| {}),
        work_dir: work.path().to_path_buf(),
        home: home.path().to_path_buf(),
        agents_file: work.path().join("agents.json"),
        env: Arc::new(vec![]),
        events: tx,
        notify: Arc::new(|_| {}),
        pids: PidBook::new(work.path()),
        data_dir: None,
        handoff_dir: None,
    };
    let set = engines::build(&ctx, Some("pi")).expect("有載入 pi 引擎");
    let mut core = new_core(&fr, work.path(), sessions.path(), Arc::new(FakeSink::default()), now());
    core.set_engines(set.clone());
    let wd = home.path().join(".asn").join("pi-windows");
    std::fs::create_dir_all(&wd).unwrap();
    let rec = json!({ "v": 1, "engine": "pi", "sessionId": "019aaaaa-bbbb", "name": "pi-demo", "pid": std::process::id(), "cwd": "D:/g/demo", "state": "idle", "at": now() });
    std::fs::write(wd.join("019aaaaa-bbbb.json"), rec.to_string()).unwrap();
    set.refresh_all().await;
    core.refresh_roster(now()).await;
    PR { core, fr, set, rx, _work: work, _home: home, _sessions: sessions }
}

impl PR {
    async fn drain(&mut self) {
        while let Ok(ev) = self.rx.try_recv() {
            self.core.on_engine_event(ev, now()).await;
        }
    }
    fn notices(&self) -> Vec<Value> {
        self.fr.st.lock().unwrap().bridge_notices.clone()
    }
    /// 後台對寄信一律回 409 not_receivable、通知收得下
    fn reject_sends(&self) {
        let mut s = self.fr.st.lock().unwrap();
        s.bridge_notice_on = true;
        s.send_fail_n = 50;
        s.send_fail_code = 409;
        s.send_fail_err = "not_receivable".into();
    }
    /// 一封要回信的信寄給 pi-demo，橋收進收件匣並 ack
    async fn mail_in(&mut self) {
        self.fr.put(mail(1, json!({"to_agent": "pi-demo"})));
        self.core.pull("test", now()).await;
        self.drain().await;
        assert_eq!(self.fr.acked(), vec![uid(1)], "寫進收件匣（已轉交）就 ack");
    }
}

#[tokio::test]
async fn 引擎視窗的回信被後台拒絕_通知原寄件人一次_不含回信內文_原信照樣_ack() {
    let mut r = rig().await;
    r.reject_sends();
    r.mail_in().await;
    r.core.on_reply("pi-demo", SECRET, Some(uid(1))).await;
    let n = r.notices();
    assert_eq!(n.len(), 1, "原寄件人收到一則通知：{n:?}");
    assert_eq!(n[0]["reply_to"], uid(1), "掛在原信底下，收件人由後台從原信推出");
    let body = n[0]["body"].as_str().unwrap();
    assert!(body.contains("pi-demo") && body.contains("沒能送出") && body.contains("收件人現在不能收信") && body.contains(&uid(1)), "{body}");
    assert!(!body.contains("機密內文"), "不含回信內文：{body}");
    assert!(r.fr.sent().is_empty(), "回信沒有寄出去");
    assert!(r.core.outbox_ids().is_empty(), "通知送達就從寄件匣移除");
    // 同一封原信再被拒一次：不再通知
    r.core.on_reply("pi-demo", SECRET, Some(uid(1))).await;
    assert_eq!(r.notices().len(), 1, "同一封原信只通知一次");
    assert_eq!(r.fr.acked(), vec![uid(1)], "原信照舊確認收下，沒有重送");
}

#[tokio::test]
async fn 引擎視窗回信被拒_通知寄不出去_留著待通知項_下一輪送達才移除() {
    let mut r = rig().await;
    r.reject_sends();
    r.fr.st.lock().unwrap().notice_fail_n = 1;
    r.mail_in().await;
    let t = now();
    r.core.on_reply("pi-demo", SECRET, Some(uid(1))).await;
    assert!(r.notices().is_empty());
    assert_eq!(r.core.outbox_pending_notices(), 1, "通知沒送達：留在寄件匣（存檔，重開也在）");
    r.core.tick(t + 3_600_000).await;
    assert_eq!(r.notices().len(), 1);
    assert!(r.core.outbox_ids().is_empty());
}

/// 一般視窗在群組回信，後台回 status：回傳橋對那個視窗說的話
async fn room_reply_said(status: u16) -> Vec<String> {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    h.fr.st.lock().unwrap().room_post_status = status;
    h.fr.st.lock().unwrap().rooms = vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))];
    h.core.pull("test", T0).await;
    let id = h.core.pending[0].id.clone();
    worker_ok(&mut h.core, &id, T0 + 1).await;
    let before = h.said().len();
    h.core.on_worker_line(res(&reply_block("T-視窗甲", SECRET)), T0 + 2).await;
    assert_eq!(h.fr.st.lock().unwrap().room_posts.len(), 1, "只貼一次，不自動重貼");
    h.said()[before..].to_vec()
}

#[tokio::test]
async fn 群組回信貼不進去_後台_500_告訴那個視窗_不自動重貼() {
    let said = room_reply_said(500).await;
    let t: Vec<&String> = said.iter().filter(|s| s.contains("你在群組「專案群」的回信沒有送出去")).collect();
    assert_eq!(t.len(), 1, "{said:?}");
    assert!(t[0].contains("連線或後台暫時有問題") && t[0].contains("要重寄請再傳一次") && !t[0].contains("機密內文"), "{}", t[0]);
}

#[tokio::test]
async fn 群組回信貼不進去_429_也算失敗_告訴那個視窗() {
    let said = room_reply_said(429).await;
    let t: Vec<&String> = said.iter().filter(|s| s.contains("你在群組「專案群」的回信沒有送出去")).collect();
    assert_eq!(t.len(), 1, "{said:?}");
    assert!(t[0].contains("發言太頻繁"), "{}", t[0]);
}

#[tokio::test]
async fn 引擎視窗的群組回信貼不進去_通知觸發的人一次_不含回信內文() {
    let mut r = rig().await;
    {
        let mut s = r.fr.st.lock().unwrap();
        s.room_post_status = 500;
        s.rooms = vec![room(vec![rmsg(2, json!({"forMe": {"pi-demo": true}}))], json!([{"member": "T~pi-demo", "read_seq": 1}]))];
    }
    r.core.pull("test", now()).await;
    r.drain().await;
    assert_eq!(r.core.pending.len(), 1, "群組訊息已交給 pi-demo");
    r.core.on_reply("pi-demo", SECRET, None).await;
    let s = r.fr.sent();
    assert_eq!(s.len(), 1, "觸發的人收到一則通知：{s:?}");
    assert_eq!((s[0]["to_node"].as_str(), s[0]["to_agent"].as_str()), (Some("W"), Some("W-政策")));
    let body = s[0]["body"].as_str().unwrap();
    assert!(body.contains("pi-demo") && body.contains("群組「專案群」") && body.contains("沒能貼進去"), "{body}");
    assert!(!body.contains("機密內文"), "不含回信內文：{body}");
    // 同一則群組訊息再失敗一次：不再通知
    r.core.on_reply("pi-demo", SECRET, None).await;
    assert_eq!(r.fr.sent().len(), 1, "每則群組訊息只通知一次");
}
