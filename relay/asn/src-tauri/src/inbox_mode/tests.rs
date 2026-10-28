//! 收件匣模式測試：本機假後端（127.0.0.1），不碰真實後端與金鑰。
//! 重點：去重、fsync 後才 ack、寫失敗不 ack、重啟由檔案重建、附件欄位、名單內容、主迴圈端到端、done 標記。
use super::*;
use crate::cli::testsupport::{Fake, Req, Resp};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const A: &str = "aaaaaaaa-0000-0000-0000-000000000001";
const B: &str = "bbbbbbbb-0000-0000-0000-000000000002";
const C: &str = "cccccccc-0000-0000-0000-000000000003";
const ATT: &str = "11111111-2222-3333-4444-555555555555";

fn mail(id: &str, body: &str) -> Value {
    json!({"id": id, "trust": "member", "from_node": "W", "from_agent": "W-甲", "to_node": "T", "to_agent": "T", "body": body, "reply_to": null,
           "created_at": "2026-10-24T00:00:00Z", "expects_reply": true, "acked": false})
}

/// 假仲介：inbox 回未 ack 的信；ack 時呼叫 on_ack（讓測試檢查「ack 當下檔案裡有沒有這封」）；roster 可指定回應狀態
struct Backend {
    fake: Fake,
    mails: Arc<Mutex<Vec<Value>>>,
}
fn backend(on_ack: impl Fn(&[String]) + Send + Sync + 'static, roster_status: u16) -> Backend {
    let mails: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![]));
    let m2 = mails.clone();
    let fake = Fake::start(move |req: &Req, _| match req.action().as_str() {
        "inbox" => Resp::ok(json!({"messages": m2.lock().unwrap().iter().filter(|m| m["acked"] == false).cloned().collect::<Vec<_>>()})),
        "ack" => {
            let ids: Vec<String> = req.json()["ids"].as_array().unwrap().iter().map(|i| i.as_str().unwrap().to_string()).collect();
            on_ack(&ids);
            for m in m2.lock().unwrap().iter_mut() {
                if ids.contains(&m["id"].as_str().unwrap().to_string()) {
                    m["acked"] = json!(true);
                }
            }
            Resp::ok(json!({"acked": ids.len()}))
        }
        "roster" => Resp::json(roster_status, json!({"ok": true})),
        _ => Resp::json(404, json!({})),
    });
    Backend { fake, mails }
}
fn relay(url: &str) -> Arc<Relay> {
    Arc::new(Relay::new(url.to_string(), "fake-key".into(), "T".into(), "T".into()))
}
fn log_sink() -> (Arc<Mutex<Vec<String>>>, impl Fn(&str)) {
    let v = Arc::new(Mutex::new(vec![]));
    let v2 = v.clone();
    (v, move |m: &str| v2.lock().unwrap().push(m.to_string()))
}
fn iso() -> String {
    "2026-10-24T01:00:00.000Z".into()
}
fn lines(dir: &Path) -> Vec<Value> {
    read_jsonl(&dir.join(INBOX_FILE))
}

#[tokio::test]
async fn 新信先寫檔再_ack_且同一封只寫一次() {
    let d = tempfile::tempdir().unwrap();
    let b = backend(|_| {}, 200);
    b.mails.lock().unwrap().extend([mail(A, "第一封"), mail(B, "第二封")]);
    let api = relay(&b.fake.url());
    let mut store = InboxStore::open(d.path()).unwrap();
    let (_l, lg) = log_sink();
    assert_eq!(pull_once(&*api, &mut store, &iso, &lg).await.unwrap(), 2);
    assert_eq!(lines(d.path()).len(), 2);
    assert_eq!(b.fake.of("ack").len(), 1);
    // 後台把兩封都標成已 ack 了，但再送一次同樣的信（模擬 ack 回應遺失）：不重複寫入，仍補 ack
    b.mails.lock().unwrap().iter_mut().for_each(|m| m["acked"] = json!(false));
    assert_eq!(pull_once(&*api, &mut store, &iso, &lg).await.unwrap(), 2);
    assert_eq!(lines(d.path()).len(), 2, "同一封不可重複寫入");
    assert_eq!(b.fake.of("ack").len(), 2);
}

#[tokio::test]
async fn ack_當下信已經在檔案裡_先寫後_ack() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().to_path_buf();
    let seen_at_ack: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(vec![]));
    let s2 = seen_at_ack.clone();
    let b = backend(
        move |ids| {
            let on_disk: HashSet<String> = read_jsonl(&dir.join(INBOX_FILE)).iter().filter_map(|m| m["id"].as_str().map(String::from)).collect();
            s2.lock().unwrap().push(ids.iter().all(|i| on_disk.contains(i)));
        },
        200,
    );
    b.mails.lock().unwrap().extend([mail(A, "x"), mail(B, "y")]);
    let api = relay(&b.fake.url());
    let mut store = InboxStore::open(d.path()).unwrap();
    let (_l, lg) = log_sink();
    pull_once(&*api, &mut store, &iso, &lg).await.unwrap();
    assert_eq!(*seen_at_ack.lock().unwrap(), vec![true]);
}

#[tokio::test]
async fn 寫檔失敗_不_ack_信留在收發室_修好後下一輪補收() {
    let d = tempfile::tempdir().unwrap();
    // 讓 inbox.jsonl 變成資料夾：任何附加都會失敗
    std::fs::create_dir(d.path().join(INBOX_FILE)).unwrap();
    let b = backend(|_| {}, 200);
    b.mails.lock().unwrap().extend([mail(A, "x")]);
    let api = relay(&b.fake.url());
    let mut store = InboxStore {
        dir: d.path().to_path_buf(),
        seen: HashSet::new(),
    };
    let (logs, lg) = log_sink();
    assert_eq!(pull_once(&*api, &mut store, &iso, &lg).await.unwrap(), 0);
    assert!(b.fake.of("ack").is_empty(), "寫失敗不可 ack");
    assert!(!store.has(A));
    assert!(logs.lock().unwrap().iter().any(|l| l.contains("not acked")));
    assert!(!b.mails.lock().unwrap()[0]["acked"].as_bool().unwrap());
    // 修好之後下一輪補收
    std::fs::remove_dir(d.path().join(INBOX_FILE)).unwrap();
    assert_eq!(pull_once(&*api, &mut store, &iso, &lg).await.unwrap(), 1);
    assert_eq!(lines(d.path()).len(), 1);
    assert_eq!(b.fake.of("ack").len(), 1);
}

#[tokio::test]
async fn 重啟後由檔案重建去重_不重複寫入_仍補_ack() {
    let d = tempfile::tempdir().unwrap();
    let b = backend(|_| {}, 200);
    b.mails.lock().unwrap().extend([mail(A, "x")]);
    let api = relay(&b.fake.url());
    {
        let mut s1 = InboxStore::open(d.path()).unwrap();
        let (_l, lg) = log_sink();
        pull_once(&*api, &mut s1, &iso, &lg).await.unwrap();
    }
    // 重啟：ack 沒送達（後台仍是未 ack）
    b.mails.lock().unwrap()[0]["acked"] = json!(false);
    b.mails.lock().unwrap().push(mail(C, "新的"));
    let mut s2 = InboxStore::open(d.path()).unwrap();
    assert!(s2.has(A) && !s2.has(C));
    assert_eq!(s2.len(), 1);
    let (_l, lg) = log_sink();
    assert_eq!(pull_once(&*api, &mut s2, &iso, &lg).await.unwrap(), 2);
    let ids: Vec<String> = lines(d.path()).iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, vec![A.to_string(), C.to_string()]);
}

#[test]
fn 壞行被略過_上次寫一半沒換行不會黏住新的一行() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join(INBOX_FILE), format!("{}\n{{\"id\":\"半", json!({"id": A}))).unwrap();
    let mut s = InboxStore::open(d.path()).unwrap();
    assert!(s.has(A) && s.len() == 1);
    s.append(B, &json!({"id": B})).unwrap();
    let ids: Vec<String> = lines(d.path()).iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, vec![A.to_string(), B.to_string()]);
}

#[test]
fn 紀錄格式_與_cloud_agent_相容_附件只留白名單欄位_沒附件不加欄位() {
    let mut m = mail(A, "看圖");
    m["sender_display"] = json!("小良哥");
    m["sender_engine"] = json!("claude");
    m["voice"] = json!(true);
    m["evil"] = json!("x");
    m["attachments"] = json!([{"id": ATT, "kind": "image", "name": "貓.webp", "mime": "image/webp", "bytes": 100, "width": 10, "height": 20, "thumb": "data:AAAA", "secret": 1}, {"id": "不是uuid"}]);
    let r = record_of(&m, "T0");
    for k in ["id", "trust", "from_node", "from_agent", "to_agent", "reply_to", "created_at", "expects_reply", "body", "received_at"] {
        assert!(r.get(k).is_some(), "缺 {k}");
    }
    assert_eq!(r["received_at"], "T0");
    assert_eq!(r["expects_reply"], true);
    assert_eq!(r["sender_display"], "小良哥");
    assert!(r.get("sender_device").is_none() && r.get("evil").is_none());
    assert_eq!(r["voice"], true);
    let att = r["attachments"].as_array().unwrap();
    assert_eq!(att.len(), 1);
    assert_eq!(att[0], json!({"id": ATT, "kind": "image", "name": "貓.webp", "mime": "image/webp", "bytes": 100, "width": 10, "height": 20}));
    let plain = record_of(&mail(B, "x"), "T0");
    assert!(plain.get("attachments").is_none() && plain.get("voice").is_none());
    // 舊信沒說要不要回：null
    let mut old = mail(B, "x");
    old.as_object_mut().unwrap().remove("expects_reply");
    assert!(record_of(&old, "T0")["expects_reply"].is_null());
}

#[test]
fn 名單_收件匣視窗加本機執行中的_claude_視窗_用傳入的存活檢查() {
    let sessions = tempfile::tempdir().unwrap();
    let status = tempfile::tempdir().unwrap();
    let put = |pid: u32, v: Value| std::fs::write(sessions.path().join(format!("{pid}.json")), v.to_string()).unwrap();
    put(101, json!({"pid": 101, "name": "家-甲", "cwd": "/home/u/proj", "status": "busy", "kind": "interactive", "entrypoint": "cli"}));
    put(102, json!({"pid": 102, "name": "家-乙", "cwd": "/home/u/work", "status": "idle", "kind": "interactive", "entrypoint": "cli"}));
    put(103, json!({"pid": 103, "name": "家-已死", "kind": "interactive", "entrypoint": "cli"}));
    put(104, json!({"pid": 104, "name": "T", "kind": "interactive", "entrypoint": "cli"})); // 與收件匣視窗同名：不重複
    let ws = roster_windows("T", "claude", sessions.path(), status.path(), |p| p != 103, 1000);
    let body = roster_body_of(&ws);
    let agents = body["agents"].as_array().unwrap();
    let names: Vec<&str> = agents.iter().map(|a| a["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["T", "家-乙", "家-甲"]);
    assert_eq!(agents[0], json!({"name": "T", "status": "idle", "cwd_label": "", "engine": "claude"}));
    let jia = agents.iter().find(|a| a["name"] == "家-甲").unwrap();
    assert_eq!((jia["status"].as_str(), jia["engine"].as_str(), jia["cwd_label"].as_str()), (Some("busy"), Some("claude"), Some("proj")));
    // 欄位與電腦版名單同一份函式產生
    assert!(body.get("launcher").is_some());
}

#[test]
fn 名單_sessions_資料夾不存在也有收件匣視窗() {
    let d = tempfile::tempdir().unwrap();
    let ws = roster_windows("T", "grok", &d.path().join("沒有"), &d.path().join("沒有2"), |_| true, 1);
    assert_eq!(ws.len(), 1);
    assert_eq!(roster_body_of(&ws)["agents"][0]["engine"], "grok");
}

fn cfg_for(dir: &Path, name: &str) -> InboxCfg {
    InboxCfg {
        name: name.into(),
        engine: "claude".into(),
        dir: dir.to_path_buf(),
        sessions_dir: dir.join("沒有sessions"),
        status_dir: dir.join("沒有status"),
        poll_ms: 80,
        roster_ms: 10_000,
        backoff_ms: vec![30, 60],
        roster_403_retry_ms: 3_600_000,
        legacy_env: || vec!["IRORI_RELAY_ID".into()],
    }
}

async fn wait_until(mut f: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if f() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    false
}

#[tokio::test]
async fn 主迴圈_啟動就回報名單並收信_補拉收到後來的信_門鈴喚醒_可乾淨結束() {
    let d = tempfile::tempdir().unwrap();
    let b = backend(|_| {}, 200);
    b.mails.lock().unwrap().push(mail(A, "啟動時就有"));
    let api = relay(&b.fake.url());
    let store = InboxStore::open(d.path()).unwrap();
    let log = Arc::new(BridgeLog::new(None));
    let (wake, shutdown) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let h = tokio::spawn(run_loop(api, store, cfg_for(d.path(), "家用-收件匣"), log, wake.clone(), shutdown.clone()));
    assert!(wait_until(|| lines(d.path()).len() == 1).await, "啟動時的信沒收到");
    let roster = b.fake.of("roster");
    assert!(!roster.is_empty());
    assert_eq!(roster[0].json()["agents"][0]["name"], "家用-收件匣");
    assert_eq!(roster[0].json()["used_legacy_env"], json!(["IRORI_RELAY_ID"]), "名單頂層帶 used_legacy_env（來源可換，不受別的測試影響）");
    b.mails.lock().unwrap().push(mail(B, "之後來的"));
    assert!(wait_until(|| lines(d.path()).len() == 2).await, "補拉沒收到後來的信");
    shutdown.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(3), h).await.unwrap().unwrap();
    // 每封只 ack 一次、後台已無未 ack
    assert!(b.mails.lock().unwrap().iter().all(|m| m["acked"] == true));
}

#[tokio::test]
async fn 主迴圈_拉信失敗會退避重試_不會死() {
    let d = tempfile::tempdir().unwrap();
    let fail = Arc::new(AtomicUsize::new(2));
    let (f2, mails) = (fail.clone(), Arc::new(Mutex::new(vec![mail(A, "x")])));
    let m2 = mails.clone();
    let fake = Fake::start(move |req: &Req, _| match req.action().as_str() {
        "inbox" => {
            if f2.load(Ordering::SeqCst) > 0 {
                f2.fetch_sub(1, Ordering::SeqCst);
                return Resp::json(500, json!({"error": "boom"}));
            }
            Resp::ok(json!({"messages": m2.lock().unwrap().clone()}))
        }
        "roster" | "ack" => Resp::ok(json!({"ok": true})),
        _ => Resp::json(404, json!({})),
    });
    let mut cfg = cfg_for(d.path(), "T");
    cfg.poll_ms = 60_000; // 不靠補拉，只靠退避重試
    let store = InboxStore::open(d.path()).unwrap();
    let (wake, shutdown) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let h = tokio::spawn(run_loop(relay(&fake.url()), store, cfg, Arc::new(BridgeLog::new(None)), wake, shutdown.clone()));
    assert!(wait_until(|| lines(d.path()).len() == 1).await, "退避重試後應收到信");
    shutdown.notify_one();
    h.await.unwrap();
}

#[tokio::test]
async fn 名單_403_只試一次_不影響收信() {
    let d = tempfile::tempdir().unwrap();
    let b = backend(|_| {}, 403);
    b.mails.lock().unwrap().push(mail(A, "x"));
    let mut cfg = cfg_for(d.path(), "T");
    cfg.roster_ms = 50;
    let store = InboxStore::open(d.path()).unwrap();
    let log = Arc::new(BridgeLog::new(None));
    let (wake, shutdown) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let h = tokio::spawn(run_loop(relay(&b.fake.url()), store, cfg, log.clone(), wake, shutdown.clone()));
    assert!(wait_until(|| lines(d.path()).len() == 1).await);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    shutdown.notify_one();
    h.await.unwrap();
    assert_eq!(b.fake.of("roster").len(), 1, "403 之後不該一直打 roster");
}

#[test]
fn done_標記_前綴要唯一_重複標記不重複寫() {
    let d = tempfile::tempdir().unwrap();
    let mut s = InboxStore::open(d.path()).unwrap();
    s.append(A, &record_of(&mail(A, "x"), "T0")).unwrap();
    s.append(B, &record_of(&mail(B, "y"), "T0")).unwrap();
    s.append("aaaaaaaa-9999-0000-0000-000000000009", &record_of(&mail("aaaaaaaa-9999-0000-0000-000000000009", "z"), "T0")).unwrap();
    assert_eq!(all_mails(d.path()).len(), 3);
    assert_eq!(mark_done(d.path(), A, "T1").unwrap(), Some(A.to_string()));
    assert_eq!(mark_done(d.path(), A, "T2").unwrap(), None);
    assert_eq!(read_jsonl(&d.path().join(DONE_FILE)).len(), 1);
    assert!(mark_done(d.path(), "aaaaaaaa", "T3").unwrap_err().contains("前綴不唯一"));
    assert!(mark_done(d.path(), "zzzzzzzz", "T3").unwrap_err().contains("找不到"));
    assert_eq!(mark_done(d.path(), "bbbbbbbb", "T3").unwrap(), Some(B.to_string()));
    assert_eq!(done_ids(d.path()).len(), 2);
}
