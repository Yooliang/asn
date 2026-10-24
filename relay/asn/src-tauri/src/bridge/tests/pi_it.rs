//! pi 視窗（裝了 ASN 擴充的互動 pi，#135 第二期）接上真的核心：名單 → 收信寫進收件匣 → 已轉交才 ack。
//! 後端是 127.0.0.1 假伺服器；家目錄與工作資料夾都是暫存資料夾，不碰使用者真的 ~/.asn；完全不啟動 pi。
use super::*;
use crate::bridge::engines::{self, EngineCtx, EngineEvent, PidBook};

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

#[tokio::test]
async fn pi_視窗_名單可見_收信寫進收件匣_已轉交才_ack_抬頭帶信任與回信說明_不經_claude_worker() {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let sink = Arc::new(FakeSink::default());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
    let ctx = EngineCtx {
        log: Arc::new(|_| {}),
        work_dir: work.path().to_path_buf(),
        home: home.path().to_path_buf(),
        agents_file: work.path().join("agents.json"),
        env: Arc::new(vec![]),
        events: tx,
        notify: Arc::new(|_| {}),
        pids: PidBook::new(work.path()),
    };
    let set = engines::build(&ctx, Some("pi")).expect("有載入 pi 引擎");
    let mut core = new_core(&fr, work.path(), sessions.path(), sink.clone(), now());
    core.set_engines(set.clone());

    let sid = "019aaaaa-bbbb";
    let wd = home.path().join(".asn").join("pi-windows");
    std::fs::create_dir_all(&wd).unwrap();
    let rec = json!({ "v": 1, "engine": "pi", "sessionId": sid, "name": "pi-demo", "pid": std::process::id(), "cwd": "D:/g/demo", "state": "idle", "at": now() });
    std::fs::write(wd.join(format!("{sid}.json")), rec.to_string()).unwrap();
    set.refresh_all().await;
    core.refresh_roster(now()).await;
    let agents = fr.rosters().last().unwrap()["agents"].as_array().unwrap().clone();
    assert!(agents.iter().any(|a| a["name"] == "pi-demo" && a["engine"] == "pi" && a["status"] == "idle" && a.get("receivable").is_none()), "{agents:?}");

    let m = || mail(1, json!({"to_agent": "pi-demo", "expects_reply": true, "body": "幫我看一下"}));
    fr.put(m());
    core.pull("test", now()).await;
    while let Ok(ev) = rx.try_recv() {
        core.on_engine_event(ev, now()).await;
    }
    assert_eq!(fr.acked(), vec![uid(1)], "寫進收件匣（已轉交）才 ack");
    let f = home.path().join(".asn").join("pi-inbox").join(sid).join(format!("{}.json", uid(1)));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
    let t = v["text"].as_str().unwrap();
    assert!(t.starts_with("[RELAY 來信] trust="), "{t}");
    assert!(t.contains("engine=pi") && t.contains("reply=yes") && t.contains("幫我看一下"), "{t}");
    assert!(t.contains("【要回信】") && t.contains("asn_send"), "pi 自己回信，要有回信說明：{t}");
    assert_eq!(v["id"], json!(uid(1)));
    assert!(sink.said.lock().unwrap().is_empty(), "不經 Claude 收發室 worker");

    // 補拉又投一次同一封：收件匣仍只有一份
    fr.put(m());
    core.pull("test", now()).await;
    assert_eq!(std::fs::read_dir(f.parent().unwrap()).unwrap().flatten().count(), 1);

    // 視窗離線（登記檔過期）：名單上不見，新信不寫收件匣
    let old = json!({ "v": 1, "engine": "pi", "sessionId": sid, "name": "pi-demo", "pid": std::process::id(), "cwd": "", "state": "idle", "at": 1 });
    std::fs::write(wd.join(format!("{sid}.json")), old.to_string()).unwrap();
    set.refresh_all().await;
    core.refresh_roster(now()).await;
    assert!(!fr.rosters().last().unwrap()["agents"].as_array().unwrap().iter().any(|a| a["name"] == "pi-demo"));
    set.stop();
}
