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
        "env_pass": ["FAKE_ACP_STATE", "FAKE_ACP_LOAD", "FAKE_ACP_AUTH", "FAKE_AGY_STATE", "FAKE_X", "FAKE_ACP_MODELS", "FAKE_AGY_MODELS"],
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
async fn agy_重開後還是登入失效_存著的舊對話壞了_丟掉改開新對話再試_寄件人看到正常回覆_帳本換新編號() {
    let state = tempfile::tempdir().unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[("FAKE_AGY_STATE", &st)], "acp", &[]).await;
    // 第一封：把這段對話標成壞掉（當下的行程照常回覆）
    h.put_pull(to_agent(1, "Gemini", "@@POISON")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    let sid = |h: &EH| serde_json::from_str::<Value>(&std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap()).unwrap()["workers"]["Gemini"]["session_id"].as_str().unwrap().to_string();
    let bad = sid(&h);
    // 橋重啟：新行程用同一個編號接回壞掉的對話 → 401；自動重開還是接回同一段 → 仍 401 → 丟掉它改開新對話，同一封信成功
    h.restart().await;
    h.put_pull(to_agent(2, "Gemini", "你好")).await;
    h.wait("換新對話後回覆", |h| h.bodies().iter().any(|b| b.contains("收到：") && b.contains("下一任") && b.contains("第1輪"))).await;   // 新對話：第一則附換手說明、第 1 輪
    assert!(!h.bodies().iter().any(|b| b.contains("需要登入")), "{:?}", h.bodies());
    assert_ne!(sid(&h), bad, "帳本換成新的對話編號");
    assert!(h.log_text().contains(&format!("存著的對話 {bad} 重開後仍然 401")), "日誌寫明丟掉的編號：{}", h.log_text());
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    assert_eq!(h.last_roster()["agents"][0]["status"], "idle");
}

#[tokio::test]
async fn agy_網路暫時斷線_等一下自動再試一次_成功就當沒事_還是斷才回暫時連不上_不當成登入問題() {
    crate::bridge::engines::acp_worker::set_net_retry_ms_for_test(50);
    let dir = tempfile::tempdir().unwrap();
    let m1 = dir.path().join("net1").display().to_string();
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[], "acp", &[]).await;
    // 第一封：第一次連線被中斷，等一下再試就成功；寄件人只看到正常回覆
    h.put_pull(to_agent(1, "Gemini", &format!("@@NET_ONCE {m1}"))).await;
    h.wait("再試後成功", |h| h.bodies().iter().any(|b| b.contains("收到：") && b.contains("NET_ONCE"))).await;
    assert!(!h.bodies().iter().any(|b| b.contains("暫時連不上") || b.contains("需要登入")), "{:?}", h.bodies());
    assert!(h.log_text().contains("網路暫時斷線") && h.log_text().contains("再試一次後恢復正常"), "{}", h.log_text());
    // 第二封：每次都斷，再試一次仍然斷 → 回「Google 暫時連不上，稍後再試」，不是需要登入
    h.put_pull(to_agent(2, "Gemini", "@@NET")).await;
    h.wait("暫時連不上", |h| h.bodies().iter().any(|b| b.contains("Google 暫時連不上，稍後再試"))).await;
    assert!(!h.bodies().iter().any(|b| b.contains("需要登入")), "{:?}", h.bodies());
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    assert_ne!(h.last_roster()["agents"][0]["status"], "login-required");
}

#[tokio::test]
async fn agy_網路斷線前這一輪已經動過手_不整封重送_回可能做了一半_檔案只寫一次() {
    crate::bridge::engines::acp_worker::set_net_retry_ms_for_test(50);
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[], "acp", &[]).await;
    let mark = h.work.path().join("workers").join("Gemini").join("steps.txt");
    // 先有工具步驟（寫了一行）才斷線：不能重送，否則會寫第二次
    h.put_pull(to_agent(1, "Gemini", &format!("@@WRITE_NET {}", mark.display()))).await;
    h.wait("可能做了一半", |h| h.bodies().iter().any(|b| b.contains("網路斷線，這一輪可能做了一半"))).await;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    assert_eq!(std::fs::read_to_string(&mark).unwrap().lines().count(), 1, "只動手一次，沒有被重送");
    assert!(!h.bodies().iter().any(|b| b.contains("暫時連不上") || b.contains("需要登入")), "{:?}", h.bodies());
    assert!(!h.log_text().contains("等 0 秒自動再試") && !h.log_text().contains("網路暫時斷線：等"), "{}", h.log_text());
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
async fn agy_登入失效_自動重開一次把同一封信再試_成功就不報需要登入_一小時內不重複重開() {
    let dir = tempfile::tempdir().unwrap();
    let m1 = dir.path().join("once1").display().to_string();
    let m2 = dir.path().join("once2").display().to_string();
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[], "acp", &[]).await;
    // 第一封：舊驅動回 401，自動重開後同一封信成功；寄件人只看到正常回覆
    h.put_pull(to_agent(1, "Gemini", &format!("@@AUTH_ONCE {m1}"))).await;
    h.wait("重試後成功", |h| h.bodies().iter().any(|b| b.contains("收到：") && b.contains("AUTH_ONCE"))).await;
    assert!(!h.bodies().iter().any(|b| b.contains("需要登入")), "{:?}", h.bodies());
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    assert_eq!(h.last_roster()["agents"][0]["status"], "idle");
    // 第二封又 401：一小時內已經自動重開過，不再重開，照舊回報需要登入
    h.put_pull(to_agent(2, "Gemini", &format!("@@AUTH_ONCE {m2}"))).await;
    h.wait("需要登入", |h| h.bodies().iter().any(|b| b.contains("需要登入"))).await;
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
    // 第一封卡在閘門：假 agy 等到閘門檔出現才回（#498：不靠時間，斷言 busy 與「先不收」時第一輪一定還在進行）
    let gate = h.work.path().join("gate-1");
    h.fr.put(to_agent(1, "Gemini", &format!("甲\n@@GATE {}", gate.display())));
    h.fr.put(to_agent(2, "Gemini", "乙"));
    h.fr.put(to_agent(3, "Gemini", "丙"));
    h.core.pull("test", now()).await;
    h.set.refresh_all().await;
    assert_eq!(h.set.windows()[0].status.as_deref(), Some("busy"));
    assert!(h.bodies().iter().all(|x| !x.contains("收到：")), "放行前不該有回覆：{:?}", h.bodies());
    std::fs::write(&gate, "go").unwrap();
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
    // 在忙的 codex 視窗帶最後活動時間（E4 #397）
    let mut b = agents.iter().find(|a| a["name"] == "視窗乙").cloned().unwrap();
    assert!(b.as_object_mut().unwrap().remove("active_at").is_some_and(|t| t.is_u64()), "{agents:?}");
    assert_eq!(b, json!({"name":"視窗乙","status":"busy","cwd_label":"proj-b","engine":"codex"}));
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
// 遠端管理 ACP 工作者：詳情、重開、換班接手（真的啟動假的工作者程序）
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
async fn acp_遠端管理_詳情_重開只結束記在帳本的程序且對話保留_換班接手開新對話並附接班說明() {
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
    // 換班接手：清掉對話、結束程序、開新的；第一則提示附接班說明（含使用者補的話）
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
async fn acp_遠端管理_關閉只結束帳本上的程序_名單標已停止_不收信_重開恢復() {
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
    let st = |h: &EH| h.set.windows().iter().find(|w| w.name == "Gemini").and_then(|w| w.status.clone());
    assert_eq!(st(&h).as_deref(), Some("stopped"), "關閉後留在名單、狀態是已停止（0.2 B3），才點得到重開");
    assert_eq!(admin.info("Gemini").unwrap()["status"], json!("stopped"));
    assert!(admin.stop("Gemini").unwrap_err().contains("已經關閉"));
    h.put_pull(to_agent(2, "Gemini", "two")).await;
    h.wait("失敗通知", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("已被關閉") && h.bodies()[1].contains("重開") && !h.bodies()[1].contains("[第2輪"), "關閉後不處理信，寄件人收到說明：{}", h.bodies()[1]);
    // 重開恢復
    admin.restart("Gemini").unwrap();
    wait_pid(&admin, "Gemini", |_| true).await;
    h.set.refresh_all().await;
    assert_eq!(st(&h).as_deref(), Some("idle"), "重開後狀態回到正常");
    h.put_pull(to_agent(3, "Gemini", "three")).await;
    h.wait("回覆", |h| h.fr.sent().len() == 3).await;
}

#[tokio::test]
async fn agy_遠端管理_重開保留對話_換班接手換新對話() {
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
// 切換模型（B4 #420）：Grok（標準 ACP）用原生 session/set_model；agy 換模型後帶同一段對話重開。選好的記進 acp-models.json
// ================================================================================================

async fn set_model_blocking(admin: &Arc<dyn engines::acp_admin::AcpAdmin>, name: &str, model: &str) -> Result<Value, String> {
    let (a, n, m) = (admin.clone(), name.to_string(), model.to_string());
    tokio::task::spawn_blocking(move || a.set_model(&n, &m)).await.unwrap()
}

fn recorded_models(h: &EH) -> Value {
    serde_json::from_str(&std::fs::read_to_string(h.work.path().join("acp-models.json")).unwrap_or_default()).unwrap_or(Value::Null)
}

#[tokio::test]
async fn acp_切換模型_原生切換不重開_下一輪用新模型_對話接續_記下來_重開asn照新模型() {
    let grok = worker("Grok", "acp", json!({ "roster_engine": "grok" }));
    let state = tempfile::tempdir().unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([grok])), &[("FAKE_ACP_MODELS", "grok-4.7,grok-4.6"), ("FAKE_ACP_STATE", &st)], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    h.put_pull(to_agent(1, "Grok", "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(h.bodies()[0].contains("模型=grok-4.7"), "{}", h.bodies()[0]);
    assert_eq!(admin.info("Grok").unwrap()["model"], json!("grok-4.7"), "沒指定時顯示 agent 說的目前模型");
    let pid = wait_pid(&admin, "Grok", |_| true).await;
    let r = set_model_blocking(&admin, "Grok", "grok-4.6").await.unwrap();
    assert_eq!((r["pid"].as_u64(), r["restarted"].clone(), r["saved"].clone()), (Some(pid), json!(false), json!(true)));
    assert_eq!(recorded_models(&h)["models"]["Grok"], json!("grok-4.6"));
    assert_eq!(admin.info("Grok").unwrap()["model"], json!("grok-4.6"));
    h.put_pull(to_agent(2, "Grok", "二")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("第2輪") && h.bodies()[1].contains("模型=grok-4.6"), "同一段對話、用新模型：{}", h.bodies()[1]);
    assert_eq!(wait_pid(&admin, "Grok", |_| true).await, pid, "沒有重開");
    // 名單顯示實際生效的模型
    h.set.refresh_all().await;
    assert_eq!(h.set.windows().iter().find(|w| w.name == "Grok").and_then(|w| w.model.clone()).as_deref(), Some("grok-4.6"));
    // 重開 ASN：記下的模型在 session/new 之後補一次 set_model
    h.restart().await;
    h.put_pull(to_agent(3, "Grok", "三")).await;
    h.wait("回覆3", |h| h.fr.sent().len() == 3).await;
    assert!(h.bodies()[2].contains("模型=grok-4.6"), "重開後照新模型：{}", h.bodies()[2]);
    assert!(h.log_text().contains("已套用記下的模型 grok-4.6"), "{}", h.log_text());
}

#[tokio::test]
async fn acp_切換模型_清單外的被拒絕並列出可選的_不合法的代號被拒_沒列模型的不能切() {
    let grok = worker("Grok", "acp", json!({ "roster_engine": "grok" }));
    let mut h = eh(Some(json!([grok])), &[("FAKE_ACP_MODELS", "grok-4.7,grok-4.6")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    wait_pid(&admin, "Grok", |_| true).await;
    let e = set_model_blocking(&admin, "Grok", "grok-9").await.unwrap_err();
    assert!(e.contains("不在這個工作者可選的模型裡") && e.contains("grok-4.7、grok-4.6"), "{e}");
    for bad in ["-x", "a b", "a/b", ""] {
        assert!(set_model_blocking(&admin, "Grok", bad).await.unwrap_err().contains("只能用英數"), "{bad}");
    }
    assert!(!h.work.path().join("acp-models.json").exists(), "被拒絕時不記");
    h.put_pull(to_agent(1, "Grok", "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(h.bodies()[0].contains("模型=grok-4.7"), "模型沒變：{}", h.bodies()[0]);
    // agent 沒列出模型：不能從這裡切
    let h2 = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    let admin2 = h2.set.acp_admin().unwrap();
    wait_pid(&admin2, "Gemini", |_| true).await;
    assert!(set_model_blocking(&admin2, "Gemini", "x1").await.unwrap_err().contains("沒有列出可選的模型"));
}

#[tokio::test]
async fn acp_記下的模型檔壞了_照原設定啟動並記log_記下的模型不在清單裡_跳過照預設跑() {
    let grok = worker("Grok", "acp", json!({ "roster_engine": "grok" }));
    let mut h = eh(Some(json!([grok])), &[("FAKE_ACP_MODELS", "grok-4.7,grok-4.6")], "acp", &[]).await;
    std::fs::write(h.work.path().join("acp-models.json"), "{壞掉").unwrap();
    h.restart().await;
    h.put_pull(to_agent(1, "Grok", "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(h.bodies()[0].contains("模型=grok-4.7"), "照原設定啟動：{}", h.bodies()[0]);
    assert!(h.log_text().contains("記下的模型讀不懂，照原設定啟動"), "{}", h.log_text());
    std::fs::write(h.work.path().join("acp-models.json"), r#"{"version":1,"models":{"Grok":"grok-0"}}"#).unwrap();
    h.restart().await;
    h.put_pull(to_agent(2, "Grok", "二")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("模型=grok-4.7"), "{}", h.bodies()[1]);
    assert!(h.log_text().contains("記下的模型 grok-0 不在這個 agent 列出的可選模型裡，照預設跑"), "{}", h.log_text());
}

#[tokio::test]
async fn agy_切換模型_比對agy_models_帶同一段對話重開_下一輪帶新的_model_清單外拒絕() {
    let mut h = eh(Some(json!([worker("Gemini", "agy-stream", json!({}))])), &[("FAKE_AGY_MODELS", "gemini-4-argon-medium,gemini-3.8-flash-high")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    h.put_pull(to_agent(1, "Gemini", "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(!h.bodies()[0].contains("/gemini"), "一開始沒帶 --model：{}", h.bodies()[0]);
    let e = set_model_blocking(&admin, "Gemini", "gemini-9").await.unwrap_err();
    assert!(e.contains("不在這個工作者可選的模型裡") && e.contains("gemini-4-argon-medium"), "{e}");
    let pid = wait_pid(&admin, "Gemini", |_| true).await;
    let r = set_model_blocking(&admin, "Gemini", "gemini-3.8-flash-high").await.unwrap();
    assert_eq!((r["pid"].as_u64(), r["restarted"].clone(), r["saved"].clone()), (Some(pid), json!(true), json!(true)));
    assert_eq!(recorded_models(&h)["models"]["Gemini"], json!("gemini-3.8-flash-high"));
    h.put_pull(to_agent(2, "Gemini", "二")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[第2輪 full/gemini-3.8-flash-high"), "同一段對話、帶新的 --model：{}", h.bodies()[1]);
    assert_ne!(wait_pid(&admin, "Gemini", |_| true).await, pid, "重開過");
    assert_eq!(admin.info("Gemini").unwrap()["model"], json!("gemini-3.8-flash-high"));
}

#[tokio::test]
async fn acp_切換模型_處理信件中直接拒絕不排隊_不記下來() {
    let grok = worker("Grok", "acp", json!({ "roster_engine": "grok" }));
    let mut h = eh(Some(json!([grok])), &[("FAKE_ACP_MODELS", "grok-4.7,grok-4.6")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    wait_pid(&admin, "Grok", |_| true).await;
    h.put_pull(to_agent(1, "Grok", "@@SLEEP")).await;
    for _ in 0..600 {
        if admin.info("Grok").unwrap()["status"] == json!("busy") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    assert_eq!(admin.info("Grok").unwrap()["status"], json!("busy"));
    assert!(set_model_blocking(&admin, "Grok", "grok-4.6").await.unwrap_err().contains("正在處理信件，等它做完再試"));
    assert!(!h.work.path().join("acp-models.json").exists());
}

// ================================================================================================
// 移除這個夥伴（B3）：只移除「開新夥伴」與接手開出來的；寫在 agents.json 的回說明、不改檔。工作資料夾的檔案留著
// ================================================================================================

async fn remove_blocking(admin: &Arc<dyn engines::acp_admin::AcpAdmin>, name: &str) -> Result<Value, String> {
    let (a, n) = (admin.clone(), name.to_string());
    tokio::task::spawn_blocking(move || a.remove(&n)).await.unwrap()
}

#[tokio::test]
async fn acp_移除_寫在agents_json的拒絕並說明_不改檔_工作者照常() {
    let mut h = eh(Some(json!([worker("Gemini", "acp", json!({}))])), &[], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let pid = wait_pid(&admin, "Gemini", |_| true).await;
    let before = std::fs::read_to_string(h.work.path().join("agents.json")).unwrap();
    let e = remove_blocking(&admin, "Gemini").await.unwrap_err();
    assert!(e.contains("agents.json") && e.contains("請在電腦上改設定檔"), "{e}");
    assert_eq!(std::fs::read_to_string(h.work.path().join("agents.json")).unwrap(), before, "設定檔一個字都沒改");
    assert_eq!(wait_pid(&admin, "Gemini", |_| true).await, pid, "程序沒被結束");
    h.put_pull(to_agent(1, "Gemini", "一")).await;
    h.wait("回覆", |h| h.fr.sent().len() == 1).await;
}

#[tokio::test]
async fn acp_移除_名冊裡的工作者_結束程序_刪名冊與記下的模型_名單看不到_同名新夥伴不繼承模型_工作資料夾留著() {
    let state = tempfile::tempdir().unwrap();
    std::fs::write(state.path().join("sess-grok1.json"), r#"{"turns":2}"#).unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([grok_base()])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1"), ("FAKE_ACP_MODELS", "grok-4.7,grok-4.6")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let cwd = h.work.path().join("專案");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(cwd.join("筆記.md"), "留著").unwrap();
    let name = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap()["name"].as_str().unwrap().to_string();
    let pid = wait_pid(&admin, &name, |_| true).await;
    set_model_blocking(&admin, &name, "grok-4.6").await.unwrap();
    assert_eq!(recorded_models(&h)["models"][&name], json!("grok-4.6"));
    let r = remove_blocking(&admin, &name).await.unwrap();
    assert_eq!((r["pid"].as_u64(), r["removed"].clone()), (Some(pid), json!(true)));
    for _ in 0..100 {
        if !crate::heartbeat::pid_alive(pid as u32) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(!crate::heartbeat::pid_alive(pid as u32), "程序真的結束了");
    assert!(!admin.has_worker(&name), "工作者清單拿掉了");
    h.set.refresh_all().await;
    assert!(h.set.windows().iter().all(|w| w.name != name), "名單上看不到");
    assert!(engines::acp_admin::read_adopted(&h.work.path().join("acp-adopted.json")).is_empty(), "接手名冊刪掉了");
    assert!(recorded_models(&h)["models"].get(&name).is_none(), "記下的模型刪掉了");
    assert_eq!(std::fs::read_to_string(cwd.join("筆記.md")).unwrap(), "留著", "工作資料夾的檔案留著");
    assert!(h.set.windows().iter().any(|w| w.name == "Grok"), "其他工作者不動");
    // 同名的新夥伴（再接手一次同一個資料夾）用預設模型，不繼承舊的
    let again = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap();
    assert_eq!(again["name"].as_str(), Some(name.as_str()));
    wait_pid(&admin, &name, |_| true).await;
    assert_eq!(admin.info(&name).unwrap()["model"], json!("grok-4.7"), "沒有繼承移除前記下的模型");
    // 重開 ASN 後，被移除的不會回來（只回來重新接手的那一個）
    remove_blocking(&admin, &name).await.unwrap();
    h.restart().await;
    let admin = h.set.acp_admin().unwrap();
    assert!(!admin.has_worker(&name), "移除後重開 ASN 也不會回來");
}

#[tokio::test]
async fn acp_移除_處理信件中拒絕_什麼都不動() {
    let state = tempfile::tempdir().unwrap();
    std::fs::write(state.path().join("sess-grok1.json"), r#"{"turns":2}"#).unwrap();
    let st = state.path().display().to_string();
    let mut h = eh(Some(json!([grok_base()])), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let cwd = h.work.path().join("專案");
    std::fs::create_dir_all(&cwd).unwrap();
    let name = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap()["name"].as_str().unwrap().to_string();
    wait_pid(&admin, &name, |_| true).await;
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
    h.put_pull(to_agent(1, &name, "@@SLEEP")).await;
    for _ in 0..600 {
        if admin.info(&name).unwrap()["status"] == json!("busy") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    assert!(remove_blocking(&admin, &name).await.unwrap_err().contains("正在處理信件"));
    assert!(admin.has_worker(&name));
    assert_eq!(engines::acp_admin::read_adopted(&h.work.path().join("acp-adopted.json")).len(), 1, "名冊沒動");
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
    // 沒有現成的 Grok 工作者：改用開新夥伴的 grok 啟動設定做底（照開新夥伴那條路驗授權與白名單）；這裡的測試環境沒有授權，所以是被擋下，而且說明是哪條路擋的
    // 擋下的原因看這台機器：有啟動設定＝白名單擋（沒有授權）；完全沒裝 CLI（例如 GitHub 的 Linux 建置）＝沒有可用的啟動設定。兩種都不能自己猜指令
    assert!(e.contains("改用「開新夥伴」的 grok 設定也開不起來"), "{e}");
    assert!(e.contains("不在允許清單") || e.contains("還沒有可用的啟動設定"), "{e}");
    assert!(!admin.has_worker("grok-接手-專案"));
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

// ================================================================================================
// 改名（B5，#266）：內建通道工作者用新名字重建、帶原本的對話重開（假的 ACP 程式；用接手開出來的專屬工作者，它在名冊裡才能改）
// ================================================================================================

async fn rename_blocking(admin: &Arc<dyn engines::acp_admin::AcpAdmin>, name: &str, new_name: &str) -> Result<Value, String> {
    let (a, n, m) = (admin.clone(), name.to_string(), new_name.to_string());
    tokio::task::spawn_blocking(move || a.rename(&n, &m)).await.unwrap()
}

fn read_json(h: &EH, file: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(h.work.path().join(file)).unwrap_or_default()).unwrap_or(Value::Null)
}

/// 接手一段已有 2 輪的對話（sess-grok1），開出專屬工作者「grok-接手-專案」；extra 是額外的工作者設定
async fn rename_rig(state: &tempfile::TempDir, extra: Vec<Value>) -> (EH, Arc<dyn engines::acp_admin::AcpAdmin>, String) {
    std::fs::write(state.path().join("sess-grok1.json"), r#"{"turns":2}"#).unwrap();
    let st = state.path().display().to_string();
    let mut workers = vec![grok_base()];
    workers.extend(extra);
    let h = eh(Some(json!(workers)), &[("FAKE_ACP_STATE", &st), ("FAKE_ACP_LOAD", "1"), ("FAKE_ACP_MODELS", "grok-4.7,grok-4.6")], "acp", &[]).await;
    let admin = h.set.acp_admin().unwrap();
    let cwd = h.work.path().join("專案");
    std::fs::create_dir_all(&cwd).unwrap();
    let name = adopt_blocking(&admin, "sess-grok1", &cwd.display().to_string()).await.unwrap()["name"].as_str().unwrap().to_string();
    wait_pid(&admin, &name, |_| true).await;
    (h, admin, name)
}

async fn roster_now(h: &mut EH) {
    h.set.refresh_all().await;
    h.core.refresh_roster(now()).await;
}

async fn wait_not_busy(admin: &Arc<dyn engines::acp_admin::AcpAdmin>, name: &str) {
    for _ in 0..600 {
        if admin.info(name).unwrap()["status"] != json!("busy") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    panic!("一直在忙");
}

#[tokio::test]
async fn acp_改名_名單換新名字對話編號不變_下一輪接著原本的對話且說明是新名字_檔案換新key_重啟還在_寄給舊名的信收得到() {
    let state = tempfile::tempdir().unwrap();
    let (mut h, admin, old) = rename_rig(&state, vec![]).await;
    set_model_blocking(&admin, &old, "grok-4.6").await.unwrap();
    roster_now(&mut h).await;
    h.put_pull(to_agent(1, &old, "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert!(h.bodies()[0].contains("[第3輪 含說明"), "{}", h.bodies()[0]);
    wait_not_busy(&admin, &old).await;
    let pid = wait_pid(&admin, &old, |_| true).await;
    let r = rename_blocking(&admin, &old, "小葛").await.unwrap();
    assert_eq!((r["pid"].as_u64(), r["old_name"].as_str(), r["new_name"].as_str()), (Some(pid), Some(old.as_str()), Some("小葛")));
    assert!(admin.has_worker("小葛") && !admin.has_worker(&old), "工作者清單換成新名字");
    let new_pid = wait_pid(&admin, "小葛", |p| p != pid).await;
    assert!(!crate::heartbeat::pid_alive(pid as u32), "舊驅動結束了");
    assert_eq!(admin.info("小葛").unwrap()["cwd"].as_str(), Some(h.work.path().join("專案").display().to_string().as_str()), "工作資料夾不變");
    assert_eq!(admin.info("小葛").unwrap()["model"], json!("grok-4.6"), "選過的模型跟著走");
    // 名單：新名字、同一個對話編號（後台靠它認得是同一位改名）
    roster_now(&mut h).await;
    let ws = h.set.windows();
    assert!(ws.iter().all(|w| w.name != old), "名單上沒有舊名字");
    assert_eq!(ws.iter().find(|w| w.name == "小葛").and_then(|w| w.session_id.clone()).as_deref(), Some("sess-grok1"));
    // 帳本、接手名冊、記下的模型都換成新 key，另記一筆舊名對照
    let workers = read_json(&h, "acp-workers.json");
    assert_eq!(workers["workers"]["小葛"]["session_id"], json!("sess-grok1"));
    assert!(workers["workers"].get(&old).is_none(), "{workers}");
    assert_eq!(engines::acp_admin::read_adopted(&h.work.path().join("acp-adopted.json")).iter().map(|e| e.0.clone()).collect::<Vec<_>>(), vec!["小葛".to_string()]);
    let models = recorded_models(&h);
    assert_eq!((models["models"]["小葛"].clone(), models["models"].get(&old).is_none()), (json!("grok-4.6"), true), "{models}");
    let renamed = read_json(&h, "acp-renames.json");
    assert_eq!((renamed["renamed"][0]["from"].as_str(), renamed["renamed"][0]["to"].as_str()), (Some(old.as_str()), Some("小葛")), "{renamed}");
    // 下一輪：接著原本的對話（第 4 輪），重送開頭說明，裡面是新名字並告知改名
    h.put_pull(to_agent(2, "小葛", "二")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    let b = h.bodies()[1].clone();
    assert!(b.contains("[第4輪 含說明") && b.contains("〈名=小葛〉〈改名〉"), "{b}");
    assert_eq!(h.fr.sent()[1]["from_agent"].as_str(), Some("小葛"));
    assert_eq!(wait_pid(&admin, "小葛", |_| true).await, new_pid);
    // 寄給舊名的信交給新名字；說明只在改名後第一輪
    h.put_pull(to_agent(3, &old, "三")).await;
    h.wait("回覆3", |h| h.fr.sent().len() == 3).await;
    assert!(h.bodies()[2].contains("[第5輪") && !h.bodies()[2].contains("含說明"), "{}", h.bodies()[2]);
    assert_eq!(h.fr.sent()[2]["from_agent"].as_str(), Some("小葛"));
    // 重啟 ASN：還是新名字，接著同一段對話；舊名對照還在
    h.restart().await;
    let admin = h.set.acp_admin().unwrap();
    assert!(admin.has_worker("小葛") && !admin.has_worker(&old), "重啟後還是新名字");
    assert_eq!(h.set.canonical_name(&old), "小葛", "重啟後舊名對照還在");
    h.put_pull(to_agent(4, &old, "四")).await;
    h.wait("回覆4", |h| h.fr.sent().len() == 4).await;
    assert!(h.bodies()[3].contains("[第6輪"), "{}", h.bodies()[3]);
    // 7 天後忘掉：舊名不再換成新名字
    let mut v = read_json(&h, "acp-renames.json");
    v["renamed"][0]["at"] = json!(now() - engines::acp_renames::KEEP_MS - 1);
    std::fs::write(h.work.path().join("acp-renames.json"), v.to_string()).unwrap();
    assert_eq!(h.set.canonical_name(&old), old, "滿 7 天就忘");
}

#[tokio::test]
async fn acp_改名_連續改名串起來_改回原名照常() {
    let state = tempfile::tempdir().unwrap();
    let (mut h, admin, old) = rename_rig(&state, vec![]).await;
    rename_blocking(&admin, &old, "小乙").await.unwrap();
    wait_pid(&admin, "小乙", |_| true).await;
    rename_blocking(&admin, "小乙", "小丙").await.unwrap();
    wait_pid(&admin, "小丙", |_| true).await;
    assert_eq!((h.set.canonical_name(&old), h.set.canonical_name("小乙")), ("小丙".to_string(), "小丙".to_string()), "A→B→C 串起來");
    roster_now(&mut h).await;
    h.put_pull(to_agent(1, &old, "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert_eq!(h.fr.sent()[0]["from_agent"].as_str(), Some("小丙"));
    assert!(h.bodies()[0].contains("[第3輪 含說明") && h.bodies()[0].contains("〈名=小丙〉〈改名〉"), "{}", h.bodies()[0]);
    // 改回原名：原名是活的名字了，不再被轉走
    wait_not_busy(&admin, "小丙").await;
    rename_blocking(&admin, "小丙", &old).await.unwrap();
    assert_eq!(h.set.canonical_name(&old), old);
    assert_eq!(h.set.canonical_name("小乙"), old);
}

#[tokio::test]
async fn acp_改名_處理信件中拒絕且什麼都不動_做完再改就行() {
    let state = tempfile::tempdir().unwrap();
    let (mut h, admin, old) = rename_rig(&state, vec![]).await;
    roster_now(&mut h).await;
    let gate = h.work.path().join("gate-rename");
    h.put_pull(to_agent(1, &old, &format!("一\n@@GATE {}", gate.display()))).await;
    // 第一封卡在閘門（#498：不靠時間）；信一排進去名單就是忙碌，放行前一直是
    assert_eq!(admin.info(&old).unwrap()["status"], json!("busy"), "閘門沒放行前一定是忙碌");
    let pid = wait_pid(&admin, &old, |_| true).await;
    let before = (std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap(), std::fs::read_to_string(h.work.path().join("acp-adopted.json")).unwrap());
    let e = rename_blocking(&admin, &old, "小葛").await.unwrap_err();
    assert!(e.contains("正在處理信件"), "{e}");
    assert!(admin.has_worker(&old) && !admin.has_worker("小葛"));
    assert_eq!(wait_pid(&admin, &old, |_| true).await, pid, "程序沒被碰");
    let after = (std::fs::read_to_string(h.work.path().join("acp-workers.json")).unwrap(), std::fs::read_to_string(h.work.path().join("acp-adopted.json")).unwrap());
    assert_eq!(before, after, "帳本與名冊沒動");
    assert!(!h.work.path().join("acp-renames.json").exists(), "沒記舊名對照");
    std::fs::write(&gate, "go").unwrap();
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    assert_eq!(h.fr.sent()[0]["from_agent"].as_str(), Some(old.as_str()), "那封信照原名做完");
    wait_not_busy(&admin, &old).await;
    rename_blocking(&admin, &old, "小葛").await.unwrap();
    assert!(admin.has_worker("小葛"));
}

#[tokio::test]
async fn acp_改名_設定檔裡的_沒對話的_已停止的_同名的_都擋下且說明簡短() {
    let state = tempfile::tempdir().unwrap();
    let (h, admin, old) = rename_rig(&state, vec![worker("Gemini", "acp", json!({}))]).await;
    // 名冊裡有、這次沒開起來的也算同名
    std::fs::write(h.work.path().join("acp-partners.json"), json!({ "version": 1, "partners": [{ "name": "幽靈", "profile": "grok", "cwd": "C:/x", "at": 1 }] }).to_string()).unwrap();
    let upper = old.to_uppercase();
    for (new, want) in [("grok", "已有同名的夥伴，換個名字"), ("GEMINI", "已有同名的夥伴，換個名字"), ("幽靈", "已有同名的夥伴，換個名字"), (upper.as_str(), "新名字和現在的一樣")] {
        assert_eq!(rename_blocking(&admin, &old, new).await.unwrap_err(), want, "{new}");
    }
    let e = rename_blocking(&admin, "Gemini", "小新").await.unwrap_err();
    assert_eq!(e, "設定檔裡的名字，請改設定檔");
    let bad = rename_blocking(&admin, &old, "-壞").await.unwrap_err();
    assert_eq!(bad, engines::acp_admin::BAD_NAME);
    assert!(h.log_text().contains("擋下：設定檔裡的名字"), "擋下的原因也記 log");
    // 改名的每一句說明（含失敗、處理中）都在 20 字內（小良哥 #1227），細節記 log
    let all = [e.as_str(), bad.as_str(), "還沒有對話，請先寄一封信給它", "已停止，請先重開", "已有同名的夥伴，換個名字", "新名字和現在的一樣", "找不到這個工作者", "工作者正在處理信件，等它做完再試", "工作者正在啟動，稍後再試", "這個工作者正在關閉", "工作者管理還沒啟動", engines::acp_admin::RENAME_FAILED, engines::acp_admin::RENAME_HALF];
    for msg in all {
        assert!(msg.chars().count() <= 20, "給人看的說明 20 字內：{msg}");
    }
    // 已停止：先重開
    let (a2, o2) = (admin.clone(), old.clone());
    tokio::task::spawn_blocking(move || a2.stop(&o2)).await.unwrap().unwrap();
    assert_eq!(rename_blocking(&admin, &old, "小新").await.unwrap_err(), "已停止，請先重開");
    let (a2, o2) = (admin.clone(), old.clone());
    tokio::task::spawn_blocking(move || a2.restart(&o2)).await.unwrap().unwrap();
    wait_pid(&admin, &old, |_| true).await;
    // 換班接手後還沒有對話：後台會當成新夥伴，所以擋
    let (a2, o2) = (admin.clone(), old.clone());
    tokio::task::spawn_blocking(move || a2.handover(&o2, "")).await.unwrap().unwrap();
    assert_eq!(rename_blocking(&admin, &old, "小新").await.unwrap_err(), "還沒有對話，請先寄一封信給它");
    assert!(admin.has_worker(&old) && admin.has_worker("Gemini") && !admin.has_worker("小新"), "都沒動");
    assert!(!h.work.path().join("acp-renames.json").exists());
}

#[tokio::test]
async fn acp_改名_寫檔失敗就把改過的都改回去_用原名重開() {
    let state = tempfile::tempdir().unwrap();
    let (mut h, admin, old) = rename_rig(&state, vec![]).await;
    set_model_blocking(&admin, &old, "grok-4.6").await.unwrap();
    roster_now(&mut h).await;
    h.put_pull(to_agent(1, &old, "一")).await;
    h.wait("回覆1", |h| h.fr.sent().len() == 1).await;
    wait_not_busy(&admin, &old).await;
    // 最後一步（舊名對照）寫不進去：那個位置是一個資料夾
    let blocker = h.work.path().join("acp-renames.json");
    std::fs::create_dir_all(blocker.join("擋住")).unwrap();
    let e = rename_blocking(&admin, &old, "小葛").await.unwrap_err();
    assert_eq!(e, engines::acp_admin::RENAME_FAILED, "說明簡短，原因不放進說明");
    assert!(admin.has_worker(&old) && !admin.has_worker("小葛"), "工作者清單還是原名");
    let workers = read_json(&h, "acp-workers.json");
    assert_eq!(workers["workers"][&old]["session_id"], json!("sess-grok1"), "帳本改回原名：{workers}");
    assert!(workers["workers"].get("小葛").is_none());
    assert_eq!(engines::acp_admin::read_adopted(&h.work.path().join("acp-adopted.json"))[0].0, old, "接手名冊改回原名");
    let models = recorded_models(&h);
    assert_eq!((models["models"][&old].clone(), models["models"].get("小葛").is_none()), (json!("grok-4.6"), true), "{models}");
    assert!(h.log_text().contains("舊名對照寫不進去"), "細節記在 log");
    assert!(!h.log_text().contains("還原失敗"), "全部改回去了，不記還原失敗");
    // 用原名重開，接著原本的對話，不重送說明
    wait_pid(&admin, &old, |_| true).await;
    h.put_pull(to_agent(2, &old, "二")).await;
    h.wait("回覆2", |h| h.fr.sent().len() == 2).await;
    assert!(h.bodies()[1].contains("[第4輪") && !h.bodies()[1].contains("含說明"), "{}", h.bodies()[1]);
    assert_eq!(h.fr.sent()[1]["from_agent"].as_str(), Some(old.as_str()));
}

#[tokio::test]
async fn acp_改名後_有活的同名視窗就照原名送給它_舊名對照不能蓋過_沒有活的才送新名字() {
    let state = tempfile::tempdir().unwrap();
    let (mut h, admin, old) = rename_rig(&state, vec![]).await;
    rename_blocking(&admin, &old, "小葛").await.unwrap();
    wait_pid(&admin, "小葛", |_| true).await;
    // 新開一個叫舊名的 Claude 視窗：寄給舊名的信送到它，不是改名後的工作者
    put_session(h.sessions.path(), 5100, &old, "idle", now());
    roster_now(&mut h).await;
    assert_eq!(h.set.canonical_name(&old), "小葛", "引擎那一層還記得對照");
    h.put_pull(to_agent(1, &old, "給新開的同名視窗")).await;
    let said = h.sink.said.lock().unwrap().join("\n");
    assert!(said.contains("給新開的同名視窗"), "交給同名的 Claude 視窗：{said}");
    assert!(h.fr.sent().is_empty(), "改名後的工作者沒有收到：{:?}", h.fr.sent());
    assert!(h.core.log.recent().join("\n").contains("skipped"), "舊名對照被略過要記 log");
    // 那個視窗關掉了（名單上沒有活的舊名）：才交給新名字
    std::fs::remove_file(h.sessions.path().join("5100.json")).unwrap();
    roster_now(&mut h).await;
    h.put_pull(to_agent(2, &old, "沒有同名視窗了")).await;
    h.wait("回覆", |h| h.fr.sent().len() == 1).await;
    assert_eq!(h.fr.sent()[0]["from_agent"].as_str(), Some("小葛"));
    assert!(!h.sink.said.lock().unwrap().join("\n").contains("沒有同名視窗了"), "沒有交給已關的視窗");
}

#[tokio::test]
async fn acp_改名後再接手同一段對話_回已經接過了_不重複開() {
    let state = tempfile::tempdir().unwrap();
    let (h, admin, old) = rename_rig(&state, vec![]).await;
    rename_blocking(&admin, &old, "小葛").await.unwrap();
    let cwd = h.work.path().join("專案").display().to_string();
    let again = adopt_blocking(&admin, "sess-grok1", &cwd).await.unwrap();
    assert_eq!((again["already"].clone(), again["name"].as_str()), (json!(true), Some("小葛")));
    assert!(!admin.has_worker(&old), "沒有用原本的名字再開一個");
    assert_eq!(engines::acp_admin::read_adopted(&h.work.path().join("acp-adopted.json")).len(), 1);
}
