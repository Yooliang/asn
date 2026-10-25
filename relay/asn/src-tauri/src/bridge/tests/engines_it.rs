//! 第五段（其他引擎）的整合測試：ACP 背景工作者（標準 ACP 與 agy 原生）、Codex 視窗，接上真的核心。
//! 對應 relay/machine/test 的 acp-engine／acp-bridge／codex-engine 測試。引擎的子程序是 node 寫的假程式
//! （relay/machine/test/fake-acp-worker.mjs、fake-agy.mjs、fake-codex.mjs），完全不啟動真的 claude／gemini／agy／codex；
//! 後端是 127.0.0.1 的假伺服器；家目錄、Codex 資料夾、工作資料夾都是暫存資料夾，不碰使用者真的 .claude／.codex／.gemini／.asn。
use super::*;
use crate::bridge::engines::{self, EngineCtx, EngineEvent, EngineSet, Notice, PidBook};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc::UnboundedReceiver;

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

fn fake(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../machine/test").join(name).display().to_string()
}

/// 引擎子程序環境的來源：目前的環境變數（要有 PATH 才找得到 node）加上測試指定的；同名的以測試指定為準
fn eenv(extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = std::env::vars().filter(|(k, _)| !extra.iter().any(|(e, _)| e.eq_ignore_ascii_case(k)) && !k.to_uppercase().starts_with("FAKE_") && !k.to_uppercase().starts_with("IRORI_CODEX")).collect();
    v.extend(extra.iter().map(|(k, val)| (k.to_string(), val.to_string())));
    v
}

fn worker(name: &str, protocol: &str, extra: Value) -> Value {
    let script = if protocol == "agy-stream" { fake("fake-agy.mjs") } else { fake("fake-acp-worker.mjs") };
    let mut w = json!({
        "name": name, "engine": "acp", "roster_engine": "gemini", "protocol": protocol, "command": "node", "args": [script], "label": "工作者",
        "env_pass": ["FAKE_ACP_STATE", "FAKE_ACP_LOAD", "FAKE_ACP_AUTH", "FAKE_AGY_STATE", "FAKE_X"],
    });
    for (k, v) in extra.as_object().unwrap() {
        w[k] = v.clone();
    }
    w
}

struct EH {
    core: Core,
    fr: FakeRelay,
    work: tempfile::TempDir,
    home: tempfile::TempDir,
    sessions: tempfile::TempDir,
    sink: Arc<FakeSink>,
    set: Arc<EngineSet>,
    rx: UnboundedReceiver<EngineEvent>,
    notices: Arc<Mutex<Vec<Notice>>>,
    logs: Arc<Mutex<Vec<String>>>,
    spec: String,
    env: Vec<(String, String)>,
}

impl Drop for EH {
    fn drop(&mut self) {
        self.set.stop();
    }
}

type Booted = (Core, Arc<EngineSet>, UnboundedReceiver<EngineEvent>, Arc<Mutex<Vec<Notice>>>, Arc<Mutex<Vec<String>>>);

async fn boot(fr: &FakeRelay, work: &Path, home: &Path, sessions: &Path, sink: Arc<FakeSink>, spec: &str, env: &[(String, String)]) -> Booted {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let notices: Arc<Mutex<Vec<Notice>>> = Arc::new(Mutex::new(vec![]));
    let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let (n2, l2) = (notices.clone(), logs.clone());
    let ctx = EngineCtx {
        log: Arc::new(move |m| l2.lock().unwrap().push(m)),
        work_dir: work.to_path_buf(),
        home: home.to_path_buf(),
        agents_file: work.join("agents.json"),
        env: Arc::new(env.to_vec()),
        events: tx,
        notify: Arc::new(move |n| n2.lock().unwrap().push(n)),
        pids: PidBook::new(work),
        data_dir: None,
    };
    let set = engines::build(&ctx, Some(spec)).expect("有載入的引擎");
    let mut core = new_core(fr, work, sessions, sink, now());
    core.set_engines(set.clone());
    set.start();
    set.refresh_all().await;
    core.refresh_roster(now()).await;
    (core, set, rx, notices, logs)
}

async fn eh(agents: Option<Value>, env: &[(&str, &str)], spec: &str, claude: &[(&str, &str)]) -> EH {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    for (i, (n, st)) in claude.iter().enumerate() {
        put_session(sessions.path(), 5000 + i as u32, n, st, 100 + i as u64);
    }
    if let Some(a) = agents {
        std::fs::write(work.path().join("agents.json"), json!({ "workers": a }).to_string()).unwrap();
    }
    // agy 的 conversation 紀錄放暫存資料夾（模擬 --conversation 可恢復）；測試自己指定就用它的
    let agy_state = home.path().join("agy-state");
    std::fs::create_dir_all(&agy_state).unwrap();
    let agy_state = agy_state.display().to_string();
    let mut with_default: Vec<(&str, &str)> = env.to_vec();
    if !env.iter().any(|(k, _)| *k == "FAKE_AGY_STATE") {
        with_default.push(("FAKE_AGY_STATE", &agy_state));
    }
    let env = eenv(&with_default);
    let sink = Arc::new(FakeSink::default());
    let (core, set, rx, notices, logs) = boot(&fr, work.path(), home.path(), sessions.path(), sink.clone(), spec, &env).await;
    EH { core, fr, work, home, sessions, sink, set, rx, notices, logs, spec: spec.into(), env }
}

impl EH {
    /// 橋重啟：同一個工作資料夾，引擎與核心重建
    async fn restart(&mut self) {
        self.set.stop();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let (core, set, rx, notices, logs) = boot(&self.fr, self.work.path(), self.home.path(), self.sessions.path(), self.sink.clone(), &self.spec, &self.env).await;
        self.core = core;
        self.set = set;
        self.rx = rx;
        self.notices = notices;
        self.logs = logs;
    }
    fn log_text(&self) -> String {
        self.logs.lock().unwrap().join("\n")
    }
    /// 一直處理引擎事件，直到條件成立（最多 90 秒；機器同時在編譯時子程序啟動會慢很多，條件一成立就立刻返回）
    async fn wait(&mut self, what: &str, f: impl Fn(&EH) -> bool) {
        let t0 = std::time::Instant::now();
        loop {
            while let Ok(ev) = self.rx.try_recv() {
                self.core.on_engine_event(ev, now()).await;
            }
            if f(self) {
                return;
            }
            if t0.elapsed() > std::time::Duration::from_secs(90) {
                panic!("等不到：{what}\n--- 引擎 log ---\n{}\n--- 橋 log ---\n{}\n--- 寄出 ---\n{:?}", self.log_text(), self.core.log.recent().join("\n"), self.fr.sent());
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    }
    async fn put_pull(&mut self, m: Value) {
        self.fr.put(m);
        self.core.pull("test", now()).await;
    }
    fn bodies(&self) -> Vec<String> {
        self.fr.sent().iter().map(|s| s["body"].as_str().unwrap_or("").to_string()).collect()
    }
    fn last_roster(&self) -> Value {
        self.fr.rosters().last().cloned().unwrap_or(Value::Null)
    }
}

fn to_agent(n: u32, who: &str, body: &str) -> Value {
    mail(n, json!({"to_agent": who, "body": body}))
}

// ================================================================================================
// ACP（標準協定，Gemini CLI 的 --experimental-acp 同一類）
// ================================================================================================

#[tokio::test]
async fn acp_名單帶工作者名與引擎名_收信回覆寄回_第二封不再附說明() {
    let state = tempfile::tempdir().unwrap();
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[("FAKE_ACP_STATE", &state.path().display().to_string())], "acp", &[("T-甲", "idle")]).await;
    assert!(h.last_roster()["agents"].as_array().unwrap().contains(&json!({"name":"Gemini","status":"idle","cwd_label":"工作者","engine":"gemini"})), "{}", h.last_roster());
    assert!(h.last_roster()["agents"].as_array().unwrap().iter().any(|a| a["name"] == "T-甲" && a["engine"] == "claude"), "Claude 視窗照舊");
    h.put_pull(to_agent(1, "Gemini", "你好")).await;
    h.wait("第一封回覆", |h| !h.fr.sent().is_empty()).await;
    let s = h.fr.sent();
    assert_eq!((s[0]["reply_to"].as_str(), s[0]["from_agent"].as_str(), s[0]["to_node"].as_str()), (Some(uid(1).as_str()), Some("Gemini"), Some("W")));
    assert!(s[0]["body"].as_str().unwrap().contains("收到：你好 [第1輪 含說明]"), "{}", s[0]["body"]);
    assert_eq!(h.fr.acked(), vec![uid(1)], "已轉交才 ack");
    assert!(h.sink.said.lock().unwrap().is_empty(), "不經 Claude 收發室 worker");
    h.put_pull(to_agent(2, "Gemini", "再問一個")).await;
    h.wait("第二封回覆", |h| h.fr.sent().len() == 2).await;
    let b = h.bodies();
    assert!(b[1].contains("收到：再問一個 [第2輪]"), "同一段對話、不重複附說明：{}", b[1]);
    // 抬頭 engine= 用名單上的名稱
    let head = h.core.log.recent().join("\n");
    assert!(head.contains("handed id=") && head.contains("to=Gemini"));
}

#[tokio::test]
async fn acp_子程序的_pid_記在帳本_關掉引擎後行程真的結束() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "x")).await;
    h.wait("回覆", |h| !h.fr.sent().is_empty()).await;
    let pids: Vec<u32> = std::fs::read_to_string(h.work.path().join("engine.pids")).unwrap().lines().filter_map(|l| l.parse().ok()).collect();
    assert_eq!(pids.len(), 1, "帳本記著唯一的 ACP 子程序");
    assert!(crate::heartbeat::pid_alive(pids[0]));
    h.set.stop();
    for _ in 0..80 {
        if !crate::heartbeat::pid_alive(pids[0]) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(!crate::heartbeat::pid_alive(pids[0]), "只關記下的 PID，而且真的關掉了");
    let left = std::fs::read_to_string(h.work.path().join("engine.pids")).unwrap_or_default();
    assert!(left.trim().is_empty(), "結束後帳本劃掉：{left}");
}

#[tokio::test]
async fn acp_write_明寫_deny_資料夾內的寫入被拒_讀資料夾內放行_回信附被拒動作的備註() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({"permissions": {"write": "deny"}}))])), &[], "acp", &[]).await;
    let cwd = h.work.path().join("workers").join("Gemini");
    let outside = h.work.path().join("outside.txt");
    h.put_pull(to_agent(1, "Gemini", &format!("@@EDIT {}\n@@READ {}", outside.display(), cwd.join("a.txt").display()))).await;
    h.wait("回覆", |h| !h.fr.sent().is_empty()).await;
    let b = h.bodies().remove(0);
    assert!(b.contains("edit:denied") && b.contains("read:allowed"), "{b}");
    assert!(b.contains("依這個工作者的政策被拒絕了") && b.contains("寫入"), "{b}");
}

#[tokio::test]
async fn acp_write_allow_白名單內放行_白名單外仍拒_fetch_預設放行_network_deny_時拒_execute_明寫_deny_拒() {
    let perms = json!({"write": "allow", "execute": "deny"});
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({"permissions": perms}))])), &[], "acp", &[]).await;
    let cwd = h.work.path().join("workers").join("Gemini");
    let outside = h.work.path().join("o.txt");
    h.put_pull(to_agent(1, "Gemini", &format!("@@EDIT {}\n@@FETCH http://x\n@@EXEC ls", cwd.join("in.txt").display()))).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    let b = h.bodies().remove(0);
    assert!(b.contains("edit:allowed") && b.contains("fetch:allowed") && b.contains("execute:denied"), "{b}");
    h.put_pull(to_agent(2, "Gemini", &format!("@@EDIT {}", outside.display()))).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("edit:denied"), "{}", h.bodies()[1]);
    let mut h2 = eh(Some(json!([worker("Gemini", "acp", json!({"permissions": {"network": "deny"}}))])), &[], "acp", &[]).await;
    h2.put_pull(to_agent(1, "Gemini", "@@FETCH http://x")).await;
    h2.wait("回覆", |h| !h.fr.sent().is_empty()).await;
    assert!(h2.bodies()[0].contains("fetch:denied"));
}

#[tokio::test]
async fn acp_ask_寄給原寄件人_回_允許_編號_放行_確認信與最後回覆各自寄對地方() {
    let ask = json!({"notify": ["sender"], "timeout_ms": 20000});
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({"permissions": {"execute": "ask"}, "ask": ask}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@EXEC ls -la")).await;
    h.wait("授權詢問寄出", |h| !h.notices.lock().unwrap().is_empty()).await;
    let n = h.notices.lock().unwrap()[0].clone();
    assert_eq!((n.to_node.as_str(), n.to_agent.as_deref(), n.from_agent.as_str()), ("W", Some("W-政策"), "Gemini"));
    assert!(n.body.contains("授權詢問") && n.body.contains("指令：ls -la") && n.body.contains("W/W-政策"), "{}", n.body);
    let id: String = n.body.split("［授權詢問 ").nth(1).unwrap().chars().take(4).collect();
    // 被問的人用一般信回覆給工作者：引擎攔下，不送進模型
    h.put_pull(mail(2, json!({"to_agent": "Gemini", "body": format!("允許 {id}"), "expects_reply": true}))).await;
    h.wait("最後回覆", |h| h.bodies().iter().any(|b| b.contains("execute:allowed"))).await;
    let b = h.bodies();
    assert!(b.iter().any(|x| x.contains("已收到：允許")), "給批准人的確認：{b:?}");
    let s = h.fr.sent();
    assert!(s.iter().any(|m| m["reply_to"] == uid(1).as_str() && m["body"].as_str().unwrap().contains("execute:allowed")), "最後回覆回給原寄件人（回的是第一封）");
    assert!(s.iter().any(|m| m["reply_to"] == uid(2).as_str() && m["body"].as_str().unwrap().contains("已收到")), "確認信回給批准人（回的是第二封）");
}

#[tokio::test]
async fn acp_ask_逾時一律拒絕_並通知已自動拒絕_沒有人可問直接拒絕() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({"permissions": {"execute": "ask"}, "ask": {"notify": ["sender"], "timeout_ms": 300}}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@EXEC rm -rf x")).await;
    h.wait("回覆", |h| !h.fr.sent().is_empty()).await;
    assert!(h.bodies()[0].contains("execute:denied"));
    let bodies: Vec<String> = h.notices.lock().unwrap().iter().map(|n| n.body.clone()).collect();
    assert!(bodies.iter().any(|b| b.contains("逾時，已自動拒絕")), "{bodies:?}");
    // 信不是從節點來的（沒有寄件人）、也沒設 notify 節點：沒有人可問，直接拒絕且不寄任何詢問
    let mut h2 = eh(Some(json!([worker("Gemini", "acp", json!({"permissions": {"execute": "ask"}}))])), &[], "acp", &[]).await;
    h2.put_pull(mail(1, json!({"to_agent": "Gemini", "from_node": "", "from_agent": null, "body": "@@EXEC ls", "trust": "owner"}))).await;
    h2.wait("回覆", |h| h.core.log.has("forwarded id=")).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(h2.notices.lock().unwrap().is_empty());
}

#[tokio::test]
async fn acp_全部允許只放行這一輪的同類請求_一次詢問三個指令都放行() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({"permissions": {"execute": "ask"}, "ask": {"notify": ["sender"], "timeout_ms": 20000}}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@MULTI")).await;
    h.wait("詢問", |h| !h.notices.lock().unwrap().is_empty()).await;
    let body = h.notices.lock().unwrap()[0].body.clone();
    let id: String = body.split("［授權詢問 ").nth(1).unwrap().chars().take(4).collect();
    h.put_pull(mail(2, json!({"to_agent": "Gemini", "body": format!("全部允許 {id}")}))).await;
    h.wait("回覆", |h| h.bodies().iter().any(|b| b.contains("execute:allowed,execute:allowed,execute:allowed"))).await;
    assert_eq!(h.notices.lock().unwrap().iter().filter(|n| n.body.contains("授權詢問")).count(), 1, "只問一次");
}

#[tokio::test]
async fn acp_agent_宣告_loadsession_重啟後接續同一段對話_沒宣告就開新的並重附說明() {
    let state = tempfile::tempdir().unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1")], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "one")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    h.restart().await;
    h.put_pull(to_agent(2, "Gemini", "two")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[第2輪]"), "接續同一段對話、不再附說明：{}", h.bodies()[1]);
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap()).unwrap();
    assert!(saved["workers"]["Gemini"]["session_id"].as_str().unwrap().starts_with("sess-"));
    // 沒宣告 loadSession：重啟後開新 session，並重新附說明
    let state2 = tempfile::tempdir().unwrap();
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[("FAKE_ACP_STATE", &state2.path().display().to_string())], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "one")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    h.restart().await;
    h.put_pull(to_agent(2, "Gemini", "two")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[第1輪 含說明]"), "{}", h.bodies()[1]);
}

#[tokio::test]
async fn acp_啟動時要求登入_名單標_login_required_寄信得到說明_不吞信() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[("FAKE_ACP_AUTH", "1")], "acp", &[]).await;
    for _ in 0..100 {
        if h.last_roster()["agents"][0]["status"] == "login-required" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        h.set.refresh_all().await;
        h.core.refresh_roster(now()).await;
    }
    assert_eq!(h.last_roster()["agents"][0]["status"], "login-required", "{}", h.last_roster());
    h.put_pull(to_agent(1, "Gemini", "在嗎")).await;
    h.wait("失敗說明", |h| h.bodies().iter().any(|b| b.contains("需要登入"))).await;
    let b = h.bodies().into_iter().find(|b| b.contains("需要登入")).unwrap();
    assert!(b.starts_with("[收發室] 轉交給 Gemini 失敗：") && b.contains("請到這台電腦前登入 node"), "{b}");
    assert!(h.fr.acked().contains(&uid(1)), "信沒有被吞：已通知寄件人並 ack");
}

#[tokio::test]
async fn acp_太久沒動靜_取消並中止_回報_之後仍可用() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({"turn_timeout_ms": 1500}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@SLEEP")).await;
    h.wait("逾時說明", |h| h.bodies().iter().any(|b| b.contains("太久沒有動靜"))).await;
    h.put_pull(to_agent(2, "Gemini", "還在嗎")).await;
    h.wait("之後仍可用", |h| h.bodies().iter().any(|b| b.contains("收到：還在嗎"))).await;
}

#[tokio::test]
async fn acp_沒指定收件人且預設視窗不在線_背景工作者不代收_信留在_inbox() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    h.put_pull(mail(1, json!({"to_agent": null}))).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(h.fr.acked().is_empty());
    assert!(h.core.log.has("kept in inbox for the owner"));
}

#[tokio::test]
async fn acp_不需回覆的信照樣處理但不寄回_抬頭_reply_no_內文沒標記也不寄回() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    h.put_pull(mail(1, json!({"to_agent": "Gemini", "expects_reply": false, "body": "只是告知"}))).await;
    h.wait("已轉交", |h| h.fr.acked() == vec![uid(1)]).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(h.fr.sent().is_empty(), "不需回覆：不寄回");
    // 寄件人是收發室的系統信也不寄回
    h.put_pull(mail(2, json!({"to_agent": "Gemini", "from_agent": "W-收發室", "body": "系統通知"}))).await;
    h.wait("已轉交2", |h| h.fr.acked().contains(&uid(2))).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(h.fr.sent().is_empty());
}

#[tokio::test]
async fn acp_指令不存在_名單上不出現_寄信得到明確說明() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({"command": "irori-no-such-command-xyz", "args": []}))])), &[], "acp", &[]).await;
    for _ in 0..60 {
        h.set.refresh_all().await;
        h.core.refresh_roster(now()).await;
        if h.core.roster.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(h.core.roster.is_empty(), "起不來的工作者不列入名單：{}", h.log_text());
    h.put_pull(to_agent(1, "Gemini", "在嗎")).await;
    assert!(h.bodies().iter().any(|b| b.contains("找不到名叫「Gemini」的 session")), "{:?}", h.bodies());
}

// ================================================================================================
// agy 原生 stream-json
// ================================================================================================

#[tokio::test]
async fn agy_收信回覆_同一段對話_重啟後_resume() {
    let state = tempfile::tempdir().unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[("FAKE_AGY_STATE", &st)], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "你好")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(h.bodies()[0].contains("收到：你好 [第1輪 full 含說明 cwd=Gemini]"), "{}", h.bodies()[0]);
    h.put_pull(to_agent(2, "Gemini", "再問")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("收到：再問 [第2輪 full cwd=Gemini]"), "{}", h.bodies()[1]);
    h.restart().await;
    h.put_pull(to_agent(3, "Gemini", "三")).await;
    h.wait("回覆3", |h| h.fr.sent().len() == 3).await;
    assert!(h.bodies()[2].contains("[第3輪 full cwd=Gemini]"), "{}", h.bodies()[2]);
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap()).unwrap();
    assert!(saved["workers"]["Gemini"]["session_id"].as_str().unwrap().starts_with("conv-"));
}

#[tokio::test]
async fn agy_子行程環境是白名單_金鑰不外洩_env_pass_才帶() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[("OPENAI_API_KEY", "sk-should-not-leak"), ("FAKE_X", "1")], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@ENV OPENAI_API_KEY")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(h.bodies()[0].contains("[env OPENAI_API_KEY=absent]"), "{}", h.bodies()[0]);
    h.put_pull(to_agent(2, "Gemini", "@@ENV FAKE_X")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[env FAKE_X=present]"), "{}", h.bodies()[1]);
    h.put_pull(to_agent(3, "Gemini", "@@ENV PATH")).await;
    h.wait("回覆3", |h| h.fr.sent().len() == 3).await;
    assert!(h.bodies()[2].contains("[env PATH=present]"), "白名單內的 PATH 要有：{}", h.bodies()[2]);
}

#[tokio::test]
async fn agy_預設開放_資料夾外寫檔被絆線中止並明確回報_檔案沒寫成_下一封仍可用() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[], "acp", &[]).await;
    let target = h.work.path().join("outside.txt");
    h.put_pull(to_agent(1, "Gemini", &format!("@@WRITE {}", target.display()))).await;
    h.wait("寫檔被中止", |h| h.bodies().iter().any(|b| b.contains("想做不被允許的事"))).await;
    let b = h.bodies().remove(0);
    assert!(b.contains("寫入：檔案：") && b.contains("outside.txt") && b.contains("檔案可能已經被寫入"), "{b}");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(!target.exists());
    h.put_pull(to_agent(2, "Gemini", "還在嗎")).await;
    h.wait("下一封", |h| h.bodies().iter().any(|b| b.contains("還在嗎 [第2輪"))).await;
}

#[tokio::test]
async fn agy_write_allow_資料夾內可寫_資料夾外仍被擋() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({"permissions": {"write": "allow"}}))])), &[], "acp", &[]).await;
    let inside = h.work.path().join("workers").join("Gemini").join("ok.txt");
    h.put_pull(to_agent(1, "Gemini", &format!("@@WRITE {}", inside.display()))).await;
    h.wait("寫入完成", |h| h.bodies().iter().any(|b| b.contains("已寫入"))).await;
    assert!(inside.exists());
    let outside = h.work.path().join("no.txt");
    h.put_pull(to_agent(2, "Gemini", &format!("@@WRITE {}", outside.display()))).await;
    h.wait("被擋", |h| h.bodies().iter().any(|b| b.contains("想做不被允許的事"))).await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(!outside.exists());
}

#[tokio::test]
async fn agy_指令明寫_deny_被拒_回報沒有回覆內容加被政策拒絕的動作_預設_execute_allow_用放行旗標() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({"permissions": {"execute": "deny"}}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@RUN dir")).await;
    h.wait("失敗說明", |h| h.bodies().iter().any(|b| b.contains("沒有產出回覆文字"))).await;
    let b = h.bodies().remove(0);
    assert!(b.contains("被政策拒絕") && b.contains("指令：dir"), "{b}");
    let mut h2 = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[], "acp", &[]).await;
    h2.put_pull(to_agent(1, "Gemini", "@@RUN dir")).await;
    h2.wait("放行", |h| h.bodies().iter().any(|b| b.contains("ran: dir (full)"))).await;
}

#[tokio::test]
async fn agy_讀不到檔案這類工具錯誤不算被政策拒絕() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@MISSING")).await;
    h.wait("回覆", |h| !h.fr.sent().is_empty()).await;
    let b = h.bodies().remove(0);
    assert!(b.contains("找不到那個檔案") && !b.contains("被拒絕"), "{b}");
}

#[tokio::test]
async fn agy_execute_ask_指令被拒後事後問人_同意就用放行模式重跑_之後回到一般模式() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({"permissions": {"execute": "ask"}, "ask": {"notify": ["sender"], "timeout_ms": 20000}}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@RUN make")).await;
    h.wait("詢問", |h| !h.notices.lock().unwrap().is_empty()).await;
    let body = h.notices.lock().unwrap()[0].body.clone();
    assert!(body.contains("指令：make"), "{body}");
    let id: String = body.split("［授權詢問 ").nth(1).unwrap().chars().take(4).collect();
    h.put_pull(mail(2, json!({"to_agent": "Gemini", "body": format!("允許 {id}")}))).await;
    h.wait("重跑", |h| h.bodies().iter().any(|b| b.contains("ran-after-grant (full)"))).await;
    h.put_pull(to_agent(3, "Gemini", "之後")).await;
    h.wait("回到一般模式", |h| h.bodies().iter().any(|b| b.contains("之後") && b.contains("normal"))).await;
}

#[tokio::test]
async fn agy_沒登入_額度用完_回報並標示狀態_通知指定的人() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({"ask": {"notify": [{"node": "PC1"}]}}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@AUTH")).await;
    h.wait("需要登入", |h| h.bodies().iter().any(|b| b.contains("需要登入"))).await;
    let b = h.bodies().into_iter().find(|b| b.contains("需要登入")).unwrap();
    assert!(b.contains("請到這台電腦前在終端機執行 agy"), "{b}");
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    assert_eq!(h.last_roster()["agents"][0]["status"], "login-required");
    let n = h.notices.lock().unwrap().clone();
    assert!(n.iter().any(|x| x.to_node == "PC1" && x.body.starts_with("［工作者狀態］")), "{n:?}");
    // 好了之後下一封成功並恢復 idle（agy 重新啟動；@@AUTH 只會讓那一封失敗）
    h.put_pull(to_agent(2, "Gemini", "好了")).await;
    h.wait("成功", |h| h.bodies().iter().any(|b| b.contains("收到：好了"))).await;
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    assert_eq!(h.last_roster()["agents"][0]["status"], "idle");
    h.put_pull(to_agent(3, "Gemini", "@@QUOTA")).await;
    h.wait("額度", |h| h.bodies().iter().any(|b| b.contains("額度用完了"))).await;
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    assert_eq!(h.last_roster()["agents"][0]["status"], "quota");
}

#[tokio::test]
async fn agy_太久沒動靜_中止並回報_行程崩潰_回報_之後仍可用() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({"turn_timeout_ms": 1500}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "@@SLEEP")).await;
    h.wait("逾時", |h| h.bodies().iter().any(|b| b.contains("太久沒有動靜"))).await;
    h.put_pull(to_agent(2, "Gemini", "@@CRASH")).await;
    h.wait("崩潰", |h| h.bodies().iter().any(|b| b.contains("中途結束了"))).await;
    h.put_pull(to_agent(3, "Gemini", "好了")).await;
    h.wait("仍可用", |h| h.bodies().iter().any(|b| b.contains("收到：好了"))).await;
}

#[tokio::test]
async fn agy_佇列_一次一輪_依序回覆_忙碌時名單是_busy_超過上限先不收() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({"queue_max": 2}))])), &[], "acp", &[]).await;
    h.fr.put(to_agent(1, "Gemini", "甲"));
    h.fr.put(to_agent(2, "Gemini", "乙"));
    h.fr.put(to_agent(3, "Gemini", "丙"));
    h.core.pull("test", now()).await;
    h.set.refresh_all().await;
    assert_eq!(h.set.windows()[0].status.as_deref(), Some("busy"));
    h.wait("兩封回覆", |h| h.bodies().iter().filter(|b| b.contains("收到：")).count() == 2).await;
    let b = h.bodies();
    assert!(b.iter().any(|x| x.contains("前面還排著 2 封信，這封先不收")), "{b:?}");
    let order: Vec<&String> = b.iter().filter(|x| x.contains("收到：")).collect();
    assert!(order[0].contains("甲") && order[1].contains("乙"), "依序：{order:?}");
}

// ================================================================================================
// Codex
// ================================================================================================

const CA: &str = "00000000-0000-7000-8000-000000000001";
const CB: &str = "00000000-0000-7000-8000-000000000002";
const CC: &str = "00000000-0000-7000-8000-000000000003";

struct Cx {
    env: Vec<(String, String)>,
    dir: PathBuf,
    state: PathBuf,
    calls: PathBuf,
}

/// 假的 Codex 家目錄：state（執行緒）、session_index.jsonl（名字）、thread-writer-locks（誰開著）
fn codex_fx(base: &Path, threads: Vec<Value>, open: &[&str], login: bool, limit: bool, extra: &[(&str, &str)]) -> Cx {
    let home = base.join("codex-home");
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
    let (state, calls) = (base.join("state.json"), base.join("calls.jsonl"));
    let full: Vec<Value> = threads
        .into_iter()
        .map(|mut t| {
            let id = t["id"].as_str().unwrap().to_string();
            if t.get("path").is_none() {
                let f = base.join(format!("rollout-{id}.jsonl"));
                std::fs::write(&f, "{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"on-request\",\"sandbox_policy\":{\"type\":\"workspace-write\"}}}\n").unwrap();
                t["path"] = json!(f.display().to_string());
            }
            if t.get("cwd").is_none() {
                t["cwd"] = json!(format!("C:\\proj\\{}", t.get("cwdName").and_then(Value::as_str).unwrap_or("demo")));
            }
            if t.get("updatedAt").is_none() {
                t["updatedAt"] = json!(1000);
            }
            if t.get("turns").is_none() {
                t["turns"] = json!([]);
            }
            t
        })
        .collect();
    std::fs::write(&state, json!({"login": login, "limit": limit, "threads": full}).to_string()).unwrap();
    let idx: String = full.iter().filter(|t| t["name"].is_string()).map(|t| json!({"id": t["id"], "thread_name": t["name"], "updated_at": "x"}).to_string() + "\n").collect();
    std::fs::write(home.join("session_index.jsonl"), idx).unwrap();
    for id in open {
        std::fs::write(home.join("thread-writer-locks").join(format!("{id}.lock")), "").unwrap();
    }
    let mut pairs: Vec<(&str, String)> = vec![
        ("CODEX_HOME", home.display().to_string()),
        ("IRORI_CODEX_SCRIPT", fake("fake-codex.mjs")),
        ("FAKE_CODEX_STATE", state.display().to_string()),
        ("FAKE_CODEX_CALLS", calls.display().to_string()),
        ("IRORI_CODEX_LOCK_MODE", "exists".into()),
        ("IRORI_CODEX_POLL_MS", "50".into()),
        ("IRORI_CODEX_HEALTH_TTL_MS", "10".into()),
        ("FAKE_CODEX_REPLY_MS", "50".into()),
    ];
    pairs.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Cx { env: eenv(&refs), dir: base.to_path_buf(), state, calls }
}

impl Cx {
    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.calls).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }
    fn queues(&self) -> Vec<Value> {
        self.calls().into_iter().filter(|c| c["cmd"] == "queue").collect()
    }
    fn message(q: &Value) -> String {
        q["argv"].as_array().unwrap().iter().filter_map(Value::as_str).find(|a| a.starts_with("--message=")).unwrap()["--message=".len()..].to_string()
    }
    fn set_state(&self, f: impl FnOnce(&mut Value)) {
        let mut s: Value = serde_json::from_str(&std::fs::read_to_string(&self.state).unwrap()).unwrap();
        f(&mut s);
        std::fs::write(&self.state, s.to_string()).unwrap();
    }
}

async fn codex_eh(cx: &Cx, claude: &[(&str, &str)]) -> EH {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    for (i, (n, st)) in claude.iter().enumerate() {
        put_session(sessions.path(), 5000 + i as u32, n, st, 100 + i as u64);
    }
    let sink = Arc::new(FakeSink::default());
    let (core, set, rx, notices, logs) = boot(&fr, work.path(), home.path(), sessions.path(), sink.clone(), "codex", &cx.env).await;
    EH { core, fr, work, home, sessions, sink, set, rx, notices, logs, spec: "codex".into(), env: cx.env.clone() }
}

fn threads() -> Vec<Value> {
    vec![
        json!({"id": CA, "name": "視窗甲", "cwdName": "proj-a", "updatedAt": 3000}),
        json!({"id": CB, "name": "視窗乙", "cwdName": "proj-b", "updatedAt": 2000, "turns": [{"id": "old", "status": "inProgress", "completedAt": null, "items": [{"type": "userMessage", "content": [{"type": "text", "text": "忙著"}]}]}]}),
        json!({"id": CC, "name": null, "updatedAt": 1000}),
        json!({"id": "00000000-0000-7000-8000-000000000004", "name": "子代理", "parentThreadId": CA, "updatedAt": 500}),
        json!({"id": "00000000-0000-7000-8000-000000000005", "name": "已關閉", "updatedAt": 100}),
    ]
}
const OPEN: [&str; 4] = [CA, CB, CC, "00000000-0000-7000-8000-000000000004"];

#[tokio::test]
async fn codex_名單_有名字且正被開著的視窗_忙碌是最後一個_turn_沒結束_排除沒名字_子代理_已關閉() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[]);
    let h = codex_eh(&cx, &[]).await;
    let agents = h.last_roster()["agents"].as_array().unwrap().clone();
    let names: std::collections::BTreeSet<String> = agents.iter().filter(|a| a["engine"] == "codex").map(|a| a["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, ["視窗乙".to_string(), "視窗甲".to_string()].into_iter().collect());
    assert!(agents.contains(&json!({"name":"視窗甲","status":"idle","cwd_label":"proj-a","engine":"codex"})), "{agents:?}");
    assert!(agents.contains(&json!({"name":"視窗乙","status":"busy","cwd_label":"proj-b","engine":"codex"})), "{agents:?}");
    // 全程不 resume thread（resume 會讓收發室變成持有者，搶走使用者視窗的佇列）
    assert!(cx.calls().iter().all(|c| c["method"] != "thread/resume"));
    // 夥伴同步帶 thread id 當 session 編號
    let ps = h.fr.st.lock().unwrap().partner_posts.clone();
    assert!(ps.last().unwrap()["windows"].as_array().unwrap().contains(&json!({"name":"視窗甲","engine":"codex","session_id":CA})), "{ps:?}");
}

#[tokio::test]
async fn codex_轉交_先_sent_再回覆_佇列收到原信全文加編號標記_抬頭_engine_codex_回覆原樣寄回() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_REPLY", "好的，已處理完畢")]);
    let mut h = codex_eh(&cx, &[]).await;
    h.put_pull(to_agent(1, "視窗甲", "請看一下 -- 這個")).await;
    h.wait("回覆", |h| !h.fr.sent().is_empty()).await;
    let q = cx.queues();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0]["argv"][2], CA, "對準 thread id");
    let m = Cx::message(&q[0]);
    assert!(m.starts_with("[RELAY 來信] trust=member from=W/W-政策 to=視窗甲 "), "{m}");
    assert!(m.contains("engine=codex reply=yes") && m.contains("請看一下 -- 這個"), "{m}");
    assert!(m.contains(&format!("asn-mail:{}", uid(1))) && m.contains("最終回覆會由收發室自動寄回"), "{m}");
    assert!(m.contains("你與收發室的往來記錄在"), "Codex 視窗讀得到檔案：附往來記錄路徑");
    let s = h.fr.sent();
    assert_eq!((s[0]["body"].as_str(), s[0]["reply_to"].as_str(), s[0]["from_agent"].as_str()), (Some("好的，已處理完畢"), Some(uid(1).as_str()), Some("視窗甲")));
    assert_eq!(h.fr.acked(), vec![uid(1)]);
}

#[tokio::test]
async fn codex_兩封連續送進同一個視窗_各自對應各自的回覆_不串不重複() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_REPLY", "ok")]);
    let mut h = codex_eh(&cx, &[]).await;
    h.fr.put(to_agent(1, "視窗甲", "甲"));
    h.fr.put(to_agent(2, "視窗甲", "乙"));
    h.core.pull("test", now()).await;
    h.wait("兩封回覆", |h| h.fr.sent().len() == 2).await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let s = h.fr.sent();
    assert_eq!(s.len(), 2, "不重複");
    let mut ids: Vec<&str> = s.iter().map(|x| x["reply_to"].as_str().unwrap()).collect();
    ids.sort();
    assert_eq!(ids, vec![uid(1), uid(2)]);
}

#[tokio::test]
async fn codex_回覆時機_turn_沒結束就一直沒有回覆_結束後才回() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_TURN", "never")]);
    let mut h = codex_eh(&cx, &[]).await;
    h.put_pull(to_agent(1, "視窗甲", "x")).await;
    h.wait("已轉交", |h| h.fr.acked() == vec![uid(1)]).await;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    while let Ok(ev) = h.rx.try_recv() {
        h.core.on_engine_event(ev, now()).await;
    }
    assert!(h.fr.sent().is_empty(), "還在忙：沒有回覆");
    cx.set_state(|s| {
        let t = s["threads"][0]["turns"].as_array_mut().unwrap().last_mut().unwrap();
        t["status"] = json!("completed");
        t["completedAt"] = json!(9);
        t["items"].as_array_mut().unwrap().push(json!({"type": "agentMessage", "text": "完成了", "phase": "final_answer"}));
    });
    h.wait("回覆", |h| !h.fr.sent().is_empty()).await;
    assert_eq!(h.fr.sent()[0]["body"], "完成了");
}

#[tokio::test]
async fn codex_轉交失敗_找不到視窗_佇列指令失敗_信太長_都有明確原因_不會無聲() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_QUEUE_FAIL", "boom queue"), ("IRORI_CODEX_MAX_MAIL_CHARS", "300")]);
    let mut h = codex_eh(&cx, &[]).await;
    h.put_pull(to_agent(1, "視窗甲", "x")).await;
    h.wait("佇列失敗", |h| h.bodies().iter().any(|b| b.contains("排進 Codex 佇列失敗：boom queue"))).await;
    h.put_pull(to_agent(2, "視窗甲", &"長".repeat(400))).await;
    h.wait("太長", |h| h.bodies().iter().any(|b| b.contains("信太長"))).await;
    // 視窗關閉：鎖檔不見
    std::fs::remove_file(std::path::Path::new(&cx.env.iter().find(|(k, _)| k == "CODEX_HOME").unwrap().1).join("thread-writer-locks").join(format!("{CA}.lock"))).unwrap();
    h.put_pull(to_agent(3, "視窗甲", "y")).await;
    h.wait("已關閉", |h| h.bodies().iter().any(|b| b.contains("已關閉") || b.contains("找不到開著的 Codex 視窗"))).await;
    assert_eq!(cx.queues().len(), 1, "只有第一封（佇列指令失敗那封）試過進佇列；太長與已關閉的信根本沒送出");
}

#[tokio::test]
async fn codex_沒登入_額度用完_名單標示_轉交明確失敗() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, false, false, &[]);
    let mut h = codex_eh(&cx, &[]).await;
    let a = h.last_roster()["agents"].as_array().unwrap().clone();
    assert!(a.iter().any(|x| x["name"] == "視窗甲" && x["status"] == "login-required"), "{a:?}");
    h.put_pull(to_agent(1, "視窗甲", "x")).await;
    h.wait("登入失敗說明", |h| h.bodies().iter().any(|b| b.contains("還沒登入 ChatGPT"))).await;
    assert!(cx.queues().is_empty());
    cx.set_state(|s| {
        s["login"] = json!(true);
        s["limit"] = json!(true);
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    let a = h.last_roster()["agents"].as_array().unwrap().clone();
    assert!(a.iter().any(|x| x["name"] == "視窗甲" && x["status"] == "limit"), "{a:?}");
    h.put_pull(to_agent(2, "視窗甲", "x")).await;
    h.wait("額度失敗說明", |h| h.bodies().iter().any(|b| b.contains("Codex 額度用完了"))).await;
    // 恢復後名單回到 idle
    cx.set_state(|s| s["limit"] = json!(false));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    let a = h.last_roster()["agents"].as_array().unwrap().clone();
    assert!(a.iter().any(|x| x["name"] == "視窗甲" && x["status"] == "idle"), "{a:?}");
}

#[tokio::test]
async fn codex_turn_失敗_額度在處理中用完_回報原因() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_TURN", "fail")]);
    let mut h = codex_eh(&cx, &[]).await;
    h.put_pull(to_agent(1, "視窗甲", "x")).await;
    h.wait("失敗原因", |h| h.bodies().iter().any(|b| b.contains("轉交給 視窗甲 失敗：Codex 額度用完了"))).await;
}

#[tokio::test]
async fn codex_安全閘門_完全存取沙盒不轉外部來信_讀不到權限也不轉_env_放行才轉() {
    let d = tempfile::tempdir().unwrap();
    let full = d.path().join("full.jsonl");
    std::fs::write(&full, "{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"on-request\",\"sandbox_policy\":{\"type\":\"read-only\"}}}\n{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"never\",\"sandbox_policy\":{\"type\":\"danger-full-access\"}}}\n").unwrap();
    let th = vec![json!({"id": CA, "name": "視窗甲", "path": full.display().to_string()}), json!({"id": CB, "name": "視窗乙", "path": d.path().join("nope.jsonl").display().to_string()})];
    let cx = codex_fx(d.path(), th.clone(), &[CA, CB], true, false, &[]);
    let mut h = codex_eh(&cx, &[]).await;
    h.put_pull(to_agent(1, "視窗甲", "x")).await;
    h.wait("完全存取", |h| h.bodies().iter().any(|b| b.contains("完全存取"))).await;
    h.put_pull(to_agent(2, "視窗乙", "x")).await;
    h.wait("讀不到權限", |h| h.bodies().iter().any(|b| b.contains("讀不到 Codex 視窗「視窗乙」的權限設定"))).await;
    assert!(cx.queues().is_empty(), "fail-closed：都沒有進佇列");
    let d2 = tempfile::tempdir().unwrap();
    std::fs::write(d2.path().join("full.jsonl"), std::fs::read(&full).unwrap()).unwrap();
    let th2 = vec![json!({"id": CA, "name": "視窗甲", "path": d2.path().join("full.jsonl").display().to_string()})];
    let cx2 = codex_fx(d2.path(), th2, &[CA], true, false, &[("IRORI_CODEX_ALLOW_FULL_ACCESS", "1")]);
    let mut h2 = codex_eh(&cx2, &[]).await;
    h2.put_pull(to_agent(1, "視窗甲", "x")).await;
    h2.wait("放行後回覆", |h| !h.fr.sent().is_empty()).await;
    assert_eq!(cx2.queues().len(), 1);
}

#[tokio::test]
async fn codex_不可用_版本太舊_名單不列_deliver_同步失敗() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_VERSION", "0.100.0")]);
    let h = codex_eh(&cx, &[]).await;
    assert!(h.last_roster()["agents"].as_array().unwrap().iter().all(|a| a["engine"] != "codex"));
    assert!(h.log_text().contains("比已驗證的最低版本"), "{}", h.log_text());
    // 引擎本身：deliver 同步 throw（橋把信留在 inbox）
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let ctx = EngineCtx { log: Arc::new(|_| {}), work_dir: d.path().to_path_buf(), home: d.path().to_path_buf(), agents_file: d.path().join("a.json"), env: Arc::new(cx.env.clone()), events: tx, notify: Arc::new(|_| {}), pids: PidBook::new(d.path()), data_dir: None };
    let e = engines::codex::CodexEngine::new(ctx);
    e.probe().await;
    assert!(!e.usable());
    assert!(engines::Engine::deliver(&e, "id", "視窗甲", "x").unwrap_err().contains("codex 不可用"));
    assert_eq!(cx.dir, d.path());
}

// ================================================================================================
// 三種引擎共存、整條路徑
// ================================================================================================

#[tokio::test]
async fn 共存_名單同時有_claude_gemini_codex_各走各的路_抬頭_engine_用名單上的名稱() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_REPLY", "codex 說好")]);
    // Gemini 設定放進同一組環境（兩個引擎同時載入）
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    put_session(sessions.path(), 5001, "T-甲", "idle", 1);
    std::fs::write(work.path().join("agents.json"), json!({"workers": [worker("Gemini", "acp", json!({}))]}).to_string()).unwrap();
    let sink = Arc::new(FakeSink::default());
    let (core, set, rx, notices, logs) = boot(&fr, work.path(), home.path(), sessions.path(), sink.clone(), "acp,codex", &cx.env).await;
    let mut h = EH { core, fr, work, home, sessions, sink, set, rx, notices, logs, spec: "acp,codex".into(), env: cx.env.clone() };
    let a = h.last_roster()["agents"].as_array().unwrap().clone();
    let eng = |n: &str| a.iter().find(|x| x["name"] == n).map(|x| x["engine"].as_str().unwrap().to_string());
    assert_eq!((eng("T-甲"), eng("Gemini"), eng("視窗甲")), (Some("claude".into()), Some("gemini".into()), Some("codex".into())));
    h.fr.put(to_agent(1, "T-甲", "給 Claude"));
    h.fr.put(to_agent(2, "Gemini", "給 Gemini"));
    h.fr.put(to_agent(3, "視窗甲", "給 Codex"));
    h.core.pull("test", now()).await;
    let said = h.sink.said.lock().unwrap().clone();
    assert_eq!(said.len(), 1, "只有給 Claude 的信走收發室 worker");
    assert!(said[0].contains("engine=claude") && said[0].contains("給 Claude"));
    h.wait("Gemini 與 Codex 回覆", |h| h.fr.sent().len() == 2).await;
    let s = h.fr.sent();
    assert!(s.iter().any(|m| m["from_agent"] == "Gemini" && m["body"].as_str().unwrap().contains("收到：給 Gemini")), "{s:?}");
    assert!(s.iter().any(|m| m["from_agent"] == "視窗甲" && m["body"] == "codex 說好"), "{s:?}");
    assert!(Cx::message(&cx.queues()[0]).contains("engine=codex"));
    // Claude 的信仍在等 SENT；回報後照舊 ack
    h.core.on_worker_line(res(&format!("SENT {}", uid(1))), now()).await;
    assert!(h.fr.acked().contains(&uid(1)));
}

#[tokio::test]
async fn 共存_沒指定收件人的信不丟給最近有動作的_codex_視窗_也不給_gemini() {
    let d = tempfile::tempdir().unwrap();
    let cx = codex_fx(d.path(), threads(), &OPEN, true, false, &[("FAKE_CODEX_REPLY", "代收了")]);
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("agents.json"), json!({"workers": [worker("Gemini", "acp", json!({}))]}).to_string()).unwrap();
    let sink = Arc::new(FakeSink::default());
    let (core, set, rx, notices, logs) = boot(&fr, work.path(), home.path(), sessions.path(), sink.clone(), "acp,codex", &cx.env).await;
    let mut h = EH { core, fr, work, home, sessions, sink, set, rx, notices, logs, spec: "acp,codex".into(), env: cx.env.clone() };
    h.put_pull(mail(1, json!({"to_agent": null}))).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(cx.queues().is_empty(), "沒指定收件人：不能丟給最近有動作的 Codex 視窗");
    assert!(h.core.relay.unaddressed_ids().contains(&uid(1)) && !h.fr.acked().contains(&uid(1)), "交給本人、不 ack");
}

#[test]
fn 整條路徑_start_接上引擎_信送進_gemini_回覆寄回_結束時只關記下的子程序() {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("agents.json"), json!({"workers": [worker("Gemini", "acp", json!({}))]}).to_string()).unwrap();
    put_session(sessions.path(), std::process::id(), "T-乙", "idle", 1);
    fr.put(to_agent(1, "Gemini", "整條路徑"));
    let record = work.path().join("record.jsonl");
    let mut c = cfg(work.path(), sessions.path());
    c.claude_bin = std::env::current_exe().unwrap().display().to_string();
    c.claude_pre = ["--exact", "bridge::tests::fake_claude_child", "--nocapture", "--"].iter().map(|s| s.to_string()).collect();
    c.extra_env = vec![("ASN_FAKE_CLAUDE".into(), "1".into()), ("FAKE_RECORD".into(), record.display().to_string())];
    c.poll_ms = 100;
    c.roster_ms = 100;
    c.tick_ms = 100;
    c.engines = Some("acp".into());
    c.agents_file = work.path().join("agents.json");
    c.home = home.path().to_path_buf();
    c.engine_env = eenv(&[]);
    c.engine_refresh_ms = 200;
    let relay = Arc::new(Relay::new(fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    crate::rt::block_on(async {
        let run = super::super::start(c, relay, None).expect("內建橋啟動");
        let t0 = std::time::Instant::now();
        while fr.sent().is_empty() && t0.elapsed() < std::time::Duration::from_secs(60) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let log = run.log.recent().join("\n");
        let s = fr.sent();
        assert!(!s.is_empty(), "沒有回覆\n{log}");
        assert_eq!((s[0]["from_agent"].as_str(), s[0]["reply_to"].as_str()), (Some("Gemini"), Some(uid(1).as_str())), "{log}");
        assert!(s[0]["body"].as_str().unwrap().contains("收到：整條路徑"));
        assert_eq!(fr.acked(), vec![uid(1)]);
        assert!(fr.rosters().iter().any(|r| r["agents"].as_array().unwrap().iter().any(|a| a["name"] == "Gemini" && a["engine"] == "gemini")), "名單回報帶 Gemini");
        let pids: Vec<u32> = std::fs::read_to_string(work.path().join("engine.pids")).unwrap().lines().filter_map(|l| l.parse().ok()).collect();
        assert_eq!(pids.len(), 1);
        run.stop();
        for _ in 0..80 {
            if !crate::heartbeat::pid_alive(pids[0]) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(!crate::heartbeat::pid_alive(pids[0]), "結束時 Gemini 子程序被關掉");
    });
}

// ================================================================================================
// 遠端管理 ACP 工作者：詳情、重開、接班換手（真的啟動假的工作者程序）
// ================================================================================================

async fn wait_pid(admin: &Arc<dyn engines::acp_admin::AcpAdmin>, name: &str, f: impl Fn(u64) -> bool) -> u64 {
    for _ in 0..600 {
        if let Some(i) = admin.info(name) {
            let pid = i["pid"].as_u64().unwrap_or(0);
            if i["process_running"] == true && f(pid) {
                return pid;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("等不到工作者程序");
}

#[tokio::test]
async fn acp_遠端管理_詳情_重開只結束記在帳本的程序且對話保留_接班換手開新對話並附接班說明() {
    let state = tempfile::tempdir().unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({ "model": "gemini-2.5-pro" }))])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1")], "acp", &[("T-甲", "idle")]).await;
    let admin = h.set.acp_admin().expect("有載入 ACP 引擎");
    assert!(admin.has_worker("Gemini") && !admin.has_worker("T-甲"), "只認收發室管理的工作者");
    h.put_pull(to_agent(1, "Gemini", "one")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    let pid1 = wait_pid(&admin, "Gemini", |_| true).await;
    let info = admin.info("Gemini").unwrap();
    assert_eq!((info["engine"].as_str(), info["model"].as_str(), info["kind"].as_str()), (Some("gemini"), Some("gemini-2.5-pro"), Some("acp")));
    assert_eq!((info["has_session"].clone(), info["load_session"].clone(), info["process_running"].clone()), (json!(true), json!(true), json!(true)));
    assert_eq!(info["permissions"], json!({ "read": "allow", "write": "allow", "execute": "allow", "network": "allow" }), "預設開放讀寫執行（限工作資料夾）");
    assert_eq!(info["cwd"].as_str().map(|c| c.ends_with("Gemini")), Some(true), "{info}");
    let before = std::fs::read_to_string(h.work.path().join("engine.pids")).unwrap();
    assert!(before.lines().any(|l| l.trim() == pid1.to_string()), "帳本記著這個 pid");
    // 重開：結束的就是帳本上的那個 pid，之後起新的，對話接續
    let r = admin.restart("Gemini").unwrap();
    assert_eq!(r["pid"].as_u64(), Some(pid1));
    let pid2 = wait_pid(&admin, "Gemini", |p| p != pid1).await;
    assert!(!crate::heartbeat::pid_alive(pid1 as u32), "舊程序真的結束了");
    h.put_pull(to_agent(2, "Gemini", "two")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[第2輪]") && !h.bodies()[1].contains("含說明"), "重開後接續同一段對話：{}", h.bodies()[1]);
    let sid1 = serde_json::from_str::<Value>(&std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap()).unwrap()["workers"]["Gemini"]["session_id"].as_str().unwrap().to_string();
    // 接班換手：清掉對話、結束程序、開新的；第一則提示附接班說明（含使用者補的話）
    let r = admin.handover("Gemini", "別動資料庫").unwrap();
    assert_eq!((r["pid"].as_u64(), r["handoff_done"].clone()), (Some(pid2), json!(false)));
    wait_pid(&admin, "Gemini", |p| p != pid2).await;
    assert!(!crate::heartbeat::pid_alive(pid2 as u32));
    h.put_pull(to_agent(3, "Gemini", "three")).await;
    h.wait("回覆3", |h| h.fr.sent().len() == 3).await;
    assert!(h.bodies()[2].contains("[第1輪 含說明 接班]"), "新對話、第一則是接班說明：{}", h.bodies()[2]);
    let sid2 = serde_json::from_str::<Value>(&std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap()).unwrap()["workers"]["Gemini"]["session_id"].as_str().unwrap().to_string();
    assert_ne!(sid1, sid2, "對話編號換了");
    // 接班說明只在新對話的第一輪：第二輪不再附
    h.put_pull(to_agent(4, "Gemini", "four")).await;
    h.wait("回覆4", |h| h.fr.sent().len() == 4).await;
    assert!(h.bodies()[3].contains("[第2輪]") && !h.bodies()[3].contains("接班"), "{}", h.bodies()[3]);
    // Claude 視窗名字不是工作者
    assert!(admin.restart("T-甲").is_err() && admin.handover("T-甲", "").is_err() && admin.info("T-甲").is_none());
}

#[tokio::test]
async fn acp_遠端管理_正在處理信件時不重開_不換手_程序沒被碰() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    h.put_pull(to_agent(1, "Gemini", "@@SLEEP")).await;
    h.wait("已轉交", |h| h.fr.acked().len() == 1).await;
    let pid = wait_pid(&admin, "Gemini", |_| true).await;
    for _ in 0..100 {
        if admin.info("Gemini").unwrap()["status"] == "busy" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    let e = admin.restart("Gemini").unwrap_err();
    assert!(e.contains("處理信件"), "{e}");
    assert!(admin.handover("Gemini", "").unwrap_err().contains("處理信件"));
    assert!(crate::heartbeat::pid_alive(pid as u32), "程序沒被結束");
}

#[tokio::test]
async fn acp_遠端管理_關閉只結束帳本上的程序_名單看不到_不收信_重開恢復() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    h.put_pull(to_agent(1, "Gemini", "one")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    let pid = wait_pid(&admin, "Gemini", |_| true).await;
    let r = admin.stop("Gemini").unwrap();
    assert_eq!((r["pid"].as_u64(), r["stopped"].clone()), (Some(pid), json!(true)));
    for _ in 0..100 {
        if !crate::heartbeat::pid_alive(pid as u32) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(!crate::heartbeat::pid_alive(pid as u32), "程序真的結束了");
    h.set.refresh_all().await;
    assert!(h.set.windows().iter().all(|w| w.name != "Gemini"), "關閉後名單上看不到");
    assert!(admin.stop("Gemini").unwrap_err().contains("已經關閉"));
    h.put_pull(to_agent(2, "Gemini", "two")).await;
    h.wait("失敗通知", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("已被關閉") && !h.bodies()[1].contains("[第2輪"), "關閉後不處理信，寄件人收到說明：{}", h.bodies()[1]);
    // 重開恢復
    admin.restart("Gemini").unwrap();
    wait_pid(&admin, "Gemini", |_| true).await;
    h.set.refresh_all().await;
    assert!(h.set.windows().iter().any(|w| w.name == "Gemini"), "重開後回到名單");
    h.put_pull(to_agent(3, "Gemini", "three")).await;
    h.wait("回覆", |h| h.fr.sent().len() == 3).await;
}

#[tokio::test]
async fn agy_遠端管理_重開保留對話_接班換手換新對話() {
    let state = tempfile::tempdir().unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[("FAKE_AGY_STATE", &st)], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    h.put_pull(to_agent(1, "Gemini", "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    let info = admin.info("Gemini").unwrap();
    assert_eq!((info["has_session"].clone(), info["load_session"].clone()), (json!(true), json!(true)));
    admin.restart("Gemini").unwrap();
    h.put_pull(to_agent(2, "Gemini", "二")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[第2輪 full"), "{}", h.bodies()[1]);
    admin.handover("Gemini", "").unwrap();
    h.put_pull(to_agent(3, "Gemini", "三")).await;
    h.wait("回覆3", |h| h.fr.sent().len() == 3).await;
    assert!(h.bodies()[2].contains("[第1輪 full 含說明"), "{}", h.bodies()[2]);
}

// ================================================================================================
// 接手使用者自己在終端機開的 grok：專屬工作者用 session/load 載入同一段對話（假的 ACP 程式，不啟動真的 grok）
// ================================================================================================

fn grok_base() -> Value {
    worker("Grok", "acp", json!({ "roster_engine": "grok", "permissions": { "write": "allow", "execute": "deny" } }))
}

async fn adopt_blocking(admin: &Arc<dyn engines::acp_admin::AcpAdmin>, sid: &str, cwd: &str) -> Result<Value, String> {
    let (a, sid, cwd) = (admin.clone(), sid.to_string(), cwd.to_string());
    tokio::task::spawn_blocking(move || a.adopt(&sid, &cwd)).await.unwrap()
}

#[tokio::test]
async fn acp_接手_專屬工作者載入既有對話_信接在同一段後面_名單有名字_重啟後建回來() {
    let state = tempfile::tempdir().unwrap();
    std::fs::write(state.path().join("sess-grok1.json"), r#"{"turns":2}"#).unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([grok_base()])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1")], "acp", &[]).await;
    let admin = h.set.acp_admin().expect("有載入 ACP 引擎");
    let cwd = h.work.path().join("專案");
    std::fs::create_dir_all(&cwd).unwrap();
    let r = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap();
    assert_eq!((r["kind"].as_str(), r["name"].as_str(), r["already"].clone()), (Some("adopt"), Some("grok-接手-專案"), json!(false)));
    // 名單：新工作者以名字出現，引擎標 grok；既有的 Grok 工作者不動
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    let agents = h.last_roster()["agents"].as_array().unwrap().clone();
    assert!(agents.iter().any(|a| a["name"] == "grok-接手-專案" && a["engine"] == "grok"), "{agents:?}");
    assert!(agents.iter().any(|a| a["name"] == "Grok"), "{agents:?}");
    // 信接在同一段對話後面：假 agent 的輪數從 2 繼續，是第 3 輪（沒有開新對話）；第一輪附開場說明與接手說明
    h.put_pull(to_agent(1, "grok-接手-專案", "你好")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(h.bodies()[0].contains("[第3輪 含說明]"), "{}", h.bodies()[0]);
    assert_eq!(h.fr.sent()[0]["from_agent"].as_str(), Some("grok-接手-專案"), "回覆照一般工作者寄回");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap()).unwrap();
    assert_eq!(saved["workers"]["grok-接手-專案"]["session_id"], "sess-grok1", "帳本記著那一段對話");
    assert!(std::fs::read_to_string(h.work.path().join("acp-adopted.json")).unwrap().contains("grok-接手-專案"));
    // 再接手同一段：不重複開
    let again = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap();
    assert_eq!(again["already"], json!(true));
    // 橋重啟：專屬工作者自己建回來，繼續同一段（第 4 輪、不再附說明）
    h.restart().await;
    h.put_pull(to_agent(2, "grok-接手-專案", "再來")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[第4輪]"), "{}", h.bodies()[1]);
}

#[tokio::test]
async fn acp_接手_載不進來就失敗_不偷偷開新對話_不留工作者_也不留紀錄() {
    let state = tempfile::tempdir().unwrap();
    let st = state.path().display().to_string();
    // 1. 對話不存在（session/load 失敗）
    let mut h = eh(Some(json!([grok_base()])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let cwd = h.work.path().join("專案");
    std::fs::create_dir_all(&cwd).unwrap();
    let e = adopt_blocking(&admin, "sess-none", &cwd.display().to_string()).await.unwrap_err();
    assert!(e.contains("沒能載入那段對話") && e.contains("session not found"), "{e}");
    assert!(!admin.has_worker("grok-接手-專案"));
    h.core.refresh_roster(now()).await;
    assert!(!h.last_roster()["agents"].to_string().contains("grok-接手"));
    let saved = std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap_or_default();
    assert!(!saved.contains("sess-none"), "帳本沒留下：{saved}");
    assert!(!h.work.path().join("acp-adopted.json").exists(), "接手名冊沒寫");
    assert!(h.fr.sent().is_empty());
    h.set.stop();
    // 2. agent 沒宣告 loadSession
    std::fs::write(state.path().join("sess-grok1.json"), r#"{"turns":2}"#).unwrap();
    let h = eh(Some(json!([grok_base()])), &[("FAKE_ACP_STATE", &st)], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let e = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap_err();
    assert!(e.contains("沒有宣告能載入既有的對話"), "{e}");
    assert!(!admin.has_worker("grok-接手-專案"));
    // 3. 沒有設定 Grok 工作者：不猜指令
    let h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let e = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap_err();
    assert!(e.contains("沒有設定 Grok 工作者"), "{e}");
}

#[tokio::test]
async fn acp_接手_寫檔最多詢問_工作資料夾白名單換成那段對話的資料夾() {
    let state = tempfile::tempdir().unwrap();
    std::fs::write(state.path().join("sess-grok1.json"), r#"{"turns":0}"#).unwrap();
    let st = state.path().display().to_string();
    let h = eh(Some(json!([grok_base()])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let cwd = h.work.path().join("專案");
    std::fs::create_dir_all(&cwd).unwrap();
    adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap();
    let info = admin.info("grok-接手-專案").unwrap();
    assert_eq!(info["permissions"]["write"], "ask", "底下的 Grok 設定是 write=allow，接手的專屬工作者降成詢問");
    assert_eq!(info["permissions"]["execute"], "deny");
    assert_eq!(info["cwd"].as_str(), Some(cwd.display().to_string().as_str()));
    assert_eq!(admin.info("Grok").unwrap()["permissions"]["write"], "allow", "既有的 Grok 工作者設定沒被動到");
}

#[tokio::test]
async fn 開新夥伴的請求由核心的定時檢查消化_失敗有中文原因記進引擎_log() {
    let mut h = eh(None, &[], "acp", &[]).await;
    std::fs::write(h.work.path().join("partner-queue.jsonl"), "{\"profile\":\"不存在的模型\",\"name\":\"小格\",\"cwd\":\"C:/\"}\n").unwrap();
    h.core.tick(now()).await;
    let t = h.log_text();
    assert!(t.contains("partner-queue: 沒能開出工作者「小格」") && t.contains("不存在的模型"), "{t}");
    assert!(!h.work.path().join("partner-queue.jsonl").exists(), "請求被認領");
}

#[tokio::test]
async fn acp_名單帶對話編號_後台靠它認得同一位夥伴() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    h.put_pull(to_agent(1, "Gemini", "one")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    h.set.refresh_all().await;
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap()).unwrap();
    let sid = saved["workers"]["Gemini"]["session_id"].as_str().unwrap().to_string();
    assert_eq!(h.set.windows()[0].session_id.as_deref(), Some(sid.as_str()), "名單帶的是工作者目前的對話編號");
}
