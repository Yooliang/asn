//! 遠端管理夥伴視窗的單元測試：作業系統一律用假的（不開視窗、不結束程序），資料夾都是暫存資料夾，
//! 後台只連 127.0.0.1 的假伺服器。六條安全規則各有對應的測試（名稱以「規則N」開頭）。
use super::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use std::sync::atomic::AtomicUsize;

const NOW: u64 = 1_800_000_000_000;

fn p(pid: u32, ppid: u32, name: &str) -> Proc {
    Proc { pid, ppid, name: name.into() }
}

struct FakeOs {
    alive: Mutex<HashSet<u32>>,
    cmd: Mutex<HashMap<u32, String>>,
    table: Mutex<Vec<Proc>>,
    terminated: Mutex<Vec<u32>>,
    closed: Mutex<Vec<u32>>,
    own: u32,
    /// sleep 時要做的事（模擬外掛在等待期間回報）
    on_sleep: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl Os for FakeOs {
    fn cmdline(&self, pid: u32) -> Option<String> {
        self.cmd.lock().unwrap().get(&pid).cloned()
    }
    fn processes(&self) -> Vec<Proc> {
        self.table.lock().unwrap().clone()
    }
    fn alive(&self, pid: u32) -> bool {
        self.alive.lock().unwrap().contains(&pid)
    }
    fn close_window(&self, pid: u32) -> bool {
        self.closed.lock().unwrap().push(pid);
        false
    }
    fn terminate(&self, pid: u32) -> Result<(), String> {
        self.terminated.lock().unwrap().push(pid);
        self.alive.lock().unwrap().remove(&pid);
        Ok(())
    }
    fn own_pid(&self) -> u32 {
        self.own
    }
    fn sleep(&self, _ms: u64) {
        if let Some(f) = self.on_sleep.lock().unwrap().as_ref() {
            f();
        }
    }
}

struct FakeEnv {
    os: Arc<FakeOs>,
    /// 前 N 次問「允許遠端管理嗎」回 true，之後回 false
    allow_first: AtomicUsize,
    asked: AtomicUsize,
    launched: Mutex<Vec<(String, PathBuf, Vec<String>)>>,
    /// 開視窗後要出現的新工作階段 (pid, sessionId)；None＝一直不出現
    appear: Mutex<Option<(u32, String)>>,
    sessions: PathBuf,
    mod_wait: u64,
}

impl OpsEnv for FakeEnv {
    fn os(&self) -> &dyn Os {
        &*self.os
    }
    fn allow_remote(&self) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst) < self.allow_first.load(Ordering::SeqCst)
    }
    fn launch(&self, plan: &Plan) -> Result<(), String> {
        self.launched.lock().unwrap().push((plan.name.clone(), plan.cwd.clone(), plan.argv.clone()));
        if let Some((pid, sid)) = self.appear.lock().unwrap().clone() {
            write_session(&self.sessions, pid, &sid, &plan.name, "idle", &plan.cwd.to_string_lossy());
            self.os.alive.lock().unwrap().insert(pid);
        }
        Ok(())
    }
    fn now_ms(&self) -> u64 {
        NOW
    }
    fn timing(&self) -> Timing {
        Timing { close_grace_ms: 0, gone_wait_ms: 0, appear_wait_ms: 0, poll_ms: 1 }
    }
    fn mod_wait_ms(&self) -> u64 {
        self.mod_wait
    }
}

fn write_session(dir: &Path, pid: u32, sid: &str, name: &str, status: &str, cwd: &str) {
    let j = json!({ "pid": pid, "sessionId": sid, "name": name, "status": status, "cwd": cwd, "kind": "interactive", "startedAt": 1000 + pid });
    std::fs::write(dir.join(format!("{pid}.json")), j.to_string()).unwrap();
}

fn asn_host_cmdline() -> String {
    use base64::Engine;
    let script = "Write-Host '[ASN] 程式已結束'";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    format!("powershell.exe -NoLogo -NoExit -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

struct Rig {
    tmp: tempfile::TempDir,
    ops: Arc<PartnerOps>,
    env: Arc<FakeEnv>,
    log: Arc<BridgeLog>,
    sessions: PathBuf,
    status: PathBuf,
    control: PathBuf,
    work: PathBuf,
    handoff: PathBuf,
}

impl Rig {
    fn os(&self) -> &FakeOs {
        &self.env.os
    }
    fn terminated(&self) -> Vec<u32> {
        self.os().terminated.lock().unwrap().clone()
    }
    fn launched(&self) -> Vec<(String, PathBuf, Vec<String>)> {
        self.env.launched.lock().unwrap().clone()
    }
    fn status_file(&self, sid: &str, v: Value) {
        std::fs::create_dir_all(&self.status).unwrap();
        std::fs::write(self.status.join(format!("{sid}.json")), v.to_string()).unwrap();
    }
    fn run(&self, op: &str, extra: Value) -> OpResult {
        self.ops.execute(&mk_op(op, extra))
    }
}

fn mk_op(op: &str, extra: Value) -> Op {
    let mut v = json!({ "id": "op-1", "name": "目標", "op": op, "requested_by": "U1", "requested_by_label": "小良哥的手機", "created_at": "2026-10-22T10:00:00Z" });
    for (k, x) in extra.as_object().cloned().unwrap_or_default() {
        v[k] = x;
    }
    Op::parse(&v)
}

struct Opt {
    asn_host: bool,
    allow_first: usize,
    status: &'static str,
    mod_wait: u64,
}
impl Default for Opt {
    fn default() -> Self {
        Opt { asn_host: false, allow_first: usize::MAX, status: "idle", mod_wait: 0 }
    }
}

/// 使用者自己開的視窗：WindowsTerminal(100) → powershell(110) → claude(220,「目標」) → node(221)；
/// 另有一個冒牌的 claude(231)，命令列也寫著 `-n 目標`，但它的工作階段名字是「別人」。ASN 本身是 300。
/// asn_host：220 改掛在 ASN 開視窗用的承載殼 210 底下。
fn rig(o: Opt) -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = tmp.path().join("sessions");
    let work = tmp.path().join("工作 資料夾");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    write_session(&sessions, 220, "sid-220", "目標", o.status, work.to_str().unwrap());
    write_session(&sessions, 231, "sid-231", "別人", "idle", work.to_str().unwrap());
    let mut cmd = HashMap::new();
    cmd.insert(220, r#""C:\Program Files\Claude\claude.exe" --dangerously-skip-permissions --model opus -n "目標" --resume sid-220 --add-dir "D:\a b""#.to_string());
    cmd.insert(231, r#"claude.exe -n 目標"#.to_string());
    let mut table = vec![p(1, 0, "explorer.exe"), p(100, 1, "windowsterminal.exe"), p(220, 110, "claude.exe"), p(221, 220, "node.exe"), p(231, 100, "claude.exe"), p(300, 1, "asn.exe")];
    if o.asn_host {
        table.push(p(210, 100, "powershell.exe"));
        cmd.insert(210, asn_host_cmdline());
        table[2] = p(220, 210, "claude.exe");
    } else {
        table.push(p(110, 100, "powershell.exe"));
        cmd.insert(110, "powershell.exe".to_string());
    }
    let os = Arc::new(FakeOs {
        alive: Mutex::new([1, 100, 110, 210, 220, 221, 231, 300].into_iter().collect()),
        cmd: Mutex::new(cmd),
        table: Mutex::new(table),
        terminated: Mutex::new(vec![]),
        closed: Mutex::new(vec![]),
        own: 300,
        on_sleep: Mutex::new(None),
    });
    let env = Arc::new(FakeEnv {
        os,
        allow_first: AtomicUsize::new(o.allow_first),
        asked: AtomicUsize::new(0),
        launched: Mutex::new(vec![]),
        appear: Mutex::new(Some((501, "sid-new".into()))),
        sessions: sessions.clone(),
        mod_wait: o.mod_wait,
    });
    let status = tmp.path().join("status");
    let control = tmp.path().join("control");
    let handoff = tmp.path().join("handoff");
    let log = Arc::new(BridgeLog::new(None));
    let relay = Arc::new(Relay::new("http://127.0.0.1:1/".into(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync> = Arc::new(|name, pid| name == "T-收發室" || name == "T-ASN" || pid == 777);
    let ops = PartnerOps::new(relay, log.clone(), handoff.clone(), env.clone(), OpsDirs { sessions: sessions.clone(), status: status.clone(), control: control.clone() }, protect);
    Rig { tmp, ops, env, log, sessions, status, control, work, handoff }
}

fn argv_has(argv: &[String], pair: &[&str]) -> bool {
    argv.windows(pair.len()).any(|w| w.iter().zip(pair).all(|(a, b)| a == b))
}

// ================================================================================================
// info
// ================================================================================================

#[test]
fn 詳情_唯讀_不需要遠端開關_欄位齊全_外殼鏈只有程式名() {
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    let res = r.run("info", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    let v = res.result.unwrap();
    assert_eq!(v["pid"], 220);
    assert_eq!(v["model"], "opus");
    assert_eq!(v["engine"], "claude");
    assert_eq!(v["status"], "idle");
    assert_eq!(v["opened_by"], "user");
    assert_eq!(v["started_at"], 1220);
    assert_eq!(v["mod_installed"], false);
    assert!(v.get("context").is_none());
    assert_eq!(v["shell_chain"], json!(["explorer.exe", "windowsterminal.exe", "powershell.exe", "claude.exe"]));
    let text = v.to_string();
    assert!(!text.contains("dangerously") && !text.contains("sid-220") && !text.contains("Program Files"), "不列命令列參數：{text}");
    assert!(text.len() <= RESULT_MAX_BYTES);
    assert!(r.terminated().is_empty() && r.launched().is_empty() && r.os().closed.lock().unwrap().is_empty(), "唯讀");
}

#[test]
fn 詳情_asn_開的視窗_與_外掛狀態檔的模型和_context() {
    let r = rig(Opt { asn_host: true, ..Opt::default() });
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW - 1000, "state": "idle", "model": "claude-sonnet-4-5", "context": { "used": 120000, "max": 200000 } }));
    let v = r.run("info", json!({})).result.unwrap();
    assert_eq!(v["opened_by"], "asn");
    assert_eq!(v["mod_installed"], true);
    assert_eq!(v["model"], "claude-sonnet-4-5", "外掛有回報就以外掛為準");
    assert_eq!(v["context"]["used"], 120000);
    // 過期的狀態檔不算有外掛
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW - 3_600_000, "state": "idle" }));
    assert_eq!(r.run("info", json!({})).result.unwrap()["mod_installed"], false);
}

// ================================================================================================
// 規則 1：只依 sessions 對上名字＋sessionId 才動手
// ================================================================================================

#[test]
fn 規則1_找不到工作階段記錄_就算有命令列長得像的程序也不動手() {
    let r = rig(Opt::default());
    // 沒有叫「幽靈」的工作階段記錄；231 的命令列有 -n 目標、220 的命令列有 目標，都不能拿來頂替
    for name in ["幽靈", "claude.exe"] {
        let res = r.ops.execute(&mk_op("close", json!({ "name": name })));
        assert_eq!(res.status, "failed", "{name}");
        assert!(res.detail.contains("找不到"), "{}", res.detail);
    }
    assert!(r.terminated().is_empty());
}

#[test]
fn 規則1_同名不只一個活視窗_不猜() {
    let r = rig(Opt::default());
    write_session(&r.sessions, 232, "sid-232", "目標", "idle", r.work.to_str().unwrap());
    r.os().alive.lock().unwrap().insert(232);
    r.os().cmd.lock().unwrap().insert(232, "claude.exe -n 目標".into());
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("不只一個"), "{}", res.detail);
    assert!(r.terminated().is_empty());
}

#[test]
fn 規則1_記錄沒有_sessionid_或程序已死_不動手() {
    let r = rig(Opt::default());
    write_session(&r.sessions, 220, "", "目標", "idle", r.work.to_str().unwrap());
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("沒有編號"), "{}", res.detail);
    write_session(&r.sessions, 220, "sid-220", "目標", "idle", r.work.to_str().unwrap());
    r.os().alive.lock().unwrap().remove(&220);
    assert_eq!(r.run("close", json!({})).status, "failed");
    assert!(r.terminated().is_empty());
}

#[test]
fn 規則1_絕不用命令列找程序_只結束對上名字的那一棵_冒牌的_231_不碰() {
    let r = rig(Opt::default());
    assert_eq!(r.run("close", json!({})).status, "ok");
    let t = r.terminated();
    assert!(!t.contains(&231), "命令列也寫著 -n 目標的冒牌程序不能被結束：{t:?}");
    assert!(t.iter().all(|p| [220, 221].contains(p)), "{t:?}");
}

// ================================================================================================
// 規則 2：使用者自己開的視窗留下終端機；ASN 開的連承載殼一起收
// ================================================================================================

#[test]
fn 規則2_關閉使用者自己開的視窗_只結束_claude_與子孫_留下終端機_也不送關閉訊息() {
    let r = rig(Opt::default());
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.result.unwrap(), json!({ "pid": 220, "kept_terminal": true }));
    assert_eq!(r.terminated(), vec![221, 220], "子先孫後，只有 claude 這一棵");
    assert!(r.os().closed.lock().unwrap().is_empty(), "關閉訊息會把使用者的終端機一起關掉");
    assert!(r.os().alive(110) && r.os().alive(100), "使用者的殼與 Windows Terminal 還在");
    assert!(res.detail.contains("終端機"));
}

#[test]
fn 規則2_關閉_asn_開的視窗_連承載殼一起收_仍不碰別人() {
    let r = rig(Opt { asn_host: true, ..Opt::default() });
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.result.unwrap()["kept_terminal"], false);
    let t = r.terminated();
    assert!(t.contains(&220) && t.contains(&221) && t.contains(&210), "{t:?}");
    assert!(!t.contains(&100) && !t.contains(&231) && !t.contains(&300), "{t:?}");
}

#[test]
fn 規則2_轉交使用者自己的視窗_同樣留下終端機() {
    let r = rig(Opt::default());
    assert_eq!(r.run("handover", json!({})).status, "ok");
    assert!(!r.terminated().contains(&110) && !r.terminated().contains(&100));
}

// ================================================================================================
// 規則 4：除 info 外要本機開關開著，執行前與動手前各驗一次
// ================================================================================================

#[test]
fn 規則4_開關關著_除了詳情全部拒絕_什麼都不動() {
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    for (op, extra) in [("close", json!({})), ("rename", json!({ "new_name": "新名" })), ("model", json!({ "model": "sonnet" })), ("handover", json!({}))] {
        let res = r.run(op, extra);
        assert_eq!(res.status, "failed", "{op}");
        assert_eq!(res.detail, CONSENT_OFF);
    }
    assert!(r.terminated().is_empty() && r.launched().is_empty());
    assert!(!r.control.exists(), "連控制檔都不寫");
}

#[test]
fn 規則4_檢查之後開關被關掉_動手前再驗一次_不結束任何程序() {
    // 第一次（execute 開頭）通過，第二次（動手前）已經關了
    for op in ["close", "handover", "rename", "model"] {
        let r = rig(Opt { allow_first: 1, ..Opt::default() });
        let res = r.run(op, json!({ "new_name": "新名", "model": "sonnet" }));
        assert_eq!(res.status, "failed", "{op}");
        assert_eq!(res.detail, CONSENT_OFF, "{op}");
        assert!(r.terminated().is_empty() && r.launched().is_empty(), "{op}");
    }
}

// ================================================================================================
// 規則 5：收發室視窗與 ASN 自己的視窗、不是 claude 的程序不能動
// ================================================================================================

#[test]
fn 規則5_收發室與_asn_自己的視窗不能動() {
    let r = rig(Opt::default());
    for name in ["T-收發室", "T-ASN"] {
        write_session(&r.sessions, 240, "sid-240", name, "idle", r.work.to_str().unwrap());
        r.os().alive.lock().unwrap().insert(240);
        r.os().cmd.lock().unwrap().insert(240, "claude.exe".into());
        for op in ["close", "rename", "handover", "model", "info"] {
            let res = r.ops.execute(&mk_op(op, json!({ "name": name, "new_name": "新名", "model": "sonnet" })));
            assert_eq!(res.status, "failed", "{name} {op}");
            assert_eq!(res.detail, PROTECTED);
        }
    }
    // 照 pid 保護（ASN 自己的 worker）：名字再普通也不行
    write_session(&r.sessions, 777, "sid-777", "普通名", "idle", r.work.to_str().unwrap());
    r.os().alive.lock().unwrap().insert(777);
    r.os().cmd.lock().unwrap().insert(777, "claude.exe".into());
    assert_eq!(r.ops.execute(&mk_op("close", json!({ "name": "普通名" }))).detail, PROTECTED);
    assert!(r.terminated().is_empty() && r.launched().is_empty());
}

#[test]
fn 規則5_不是_claude_的程序不動() {
    let r = rig(Opt::default());
    r.os().cmd.lock().unwrap().insert(220, r#"C:\Windows\notepad.exe 目標"#.into());
    for op in ["close", "handover"] {
        let res = r.run(op, json!({}));
        assert_eq!(res.status, "failed", "{op}");
        assert!(res.detail.contains("不是 Claude"), "{}", res.detail);
    }
    assert!(r.terminated().is_empty());
}

#[test]
fn 規則5_目標是_asn_自己或_asn_的祖先_不動() {
    // 目標就是 ASN 本身
    let r = rig(Opt::default());
    write_session(&r.sessions, 300, "sid-300", "目標", "idle", r.work.to_str().unwrap());
    std::fs::remove_file(r.sessions.join("220.json")).unwrap();
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "failed");
    assert!(r.terminated().is_empty());
    // ASN 是目標的子孫（ASN 從 claude 裡開出來）：kill_set 的守門擋下
    let r = rig(Opt::default());
    r.os().table.lock().unwrap().iter_mut().find(|x| x.pid == 300).unwrap().ppid = 221;
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("守門"), "{}", res.detail);
    assert!(r.terminated().is_empty());
}

// ================================================================================================
// 改名／切換模型：外掛優先，沒有外掛或逾時退回重開
// ================================================================================================

#[test]
fn 改名_有外掛_寫控制檔_外掛回報成功就好_不重開() {
    let r = rig(Opt { mod_wait: 5000, ..Opt::default() });
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW - 10, "state": "idle" }));
    let (control, status) = (r.control.join("sid-220.json"), r.status.join("sid-220.json"));
    let seen = Arc::new(Mutex::new(None::<Value>));
    let seen2 = seen.clone();
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        // 外掛看到控制檔，執行完把結果寫回狀態檔
        let c: Value = serde_json::from_str(&std::fs::read_to_string(&control).unwrap()).unwrap();
        *seen2.lock().unwrap() = Some(c.clone());
        std::fs::write(&status, json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": c["id"], "ok": true, "detail": "已改名" } }).to_string()).unwrap();
    }));
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.detail, "已改名");
    let c = seen.lock().unwrap().clone().unwrap();
    assert_eq!(c["id"], "op-1");
    assert_eq!(c["op"], "rename");
    assert_eq!(c["arg"], "新名字");
    assert_eq!(c["at"], NOW);
    assert!(r.terminated().is_empty() && r.launched().is_empty());
    assert!(!r.control.join("sid-220.json").exists(), "做完收掉控制檔");
}

#[test]
fn 改名_外掛明確回失敗_就回失敗_不重開() {
    let r = rig(Opt::default());
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "op-1", "ok": false, "detail": "名字不合" } }));
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!((res.status, res.detail.as_str()), ("failed", "名字不合"));
    assert!(r.terminated().is_empty() && r.launched().is_empty());
}

#[test]
fn 改名_沒有外掛_退回重開_同_session_換名字_模型不變() {
    let r = rig(Opt::default());
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(r.terminated(), vec![221, 220]);
    let (name, cwd, argv) = r.launched().remove(0);
    assert_eq!(name, "新名字");
    assert_eq!(cwd, r.work);
    assert!(argv_has(&argv, &["-n", "新名字"]) && argv_has(&argv, &["--resume", "sid-220"]) && argv_has(&argv, &["--model", "opus"]), "{argv:?}");
    assert!(!argv.iter().any(|a| a == "目標"), "舊名字不帶回：{argv:?}");
    assert!(argv_has(&argv, &["--dangerously-skip-permissions"]) && argv_has(&argv, &["--add-dir", r"D:\a b"]), "其餘參數原樣：{argv:?}");
}

#[test]
fn 改名_外掛逾時_退回重開_並收掉控制檔() {
    let r = rig(Opt::default());
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "idle" }));
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(r.launched().len(), 1);
    assert!(!r.control.join("sid-220.json").exists(), "新視窗的外掛不能再執行一次舊指令");
}

#[test]
fn 改名_新視窗沒出現_回未確認_名字不合或撞名_直接拒絕() {
    let r = rig(Opt::default());
    *r.env.appear.lock().unwrap() = None;
    assert_eq!(r.run("rename", json!({ "new_name": "新名字" })).status, "unconfirmed");
    let r = rig(Opt::default());
    assert_eq!(r.run("rename", json!({ "new_name": "-壞 名字" })).status, "failed");
    assert_eq!(r.run("rename", json!({ "new_name": "別人" })).status, "failed", "撞名");
    assert_eq!(r.run("rename", json!({ "new_name": "目標" })).status, "failed", "沒變");
    assert!(r.terminated().is_empty());
}

#[test]
fn 切換模型_有外掛_控制檔_op_model() {
    let r = rig(Opt::default());
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "op-1", "ok": true, "detail": "已切換" } }));
    let res = r.run("model", json!({ "model": "sonnet" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert!(r.terminated().is_empty() && r.launched().is_empty());
}

#[test]
fn 切換模型_沒有外掛_走既有流程_換模型重開_忙碌時拒絕() {
    let r = rig(Opt::default());
    let res = r.run("model", json!({ "model": "sonnet" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    let argv = r.launched().remove(0).2;
    assert!(argv_has(&argv, &["--model", "sonnet"]) && argv_has(&argv, &["--resume", "sid-220"]) && argv_has(&argv, &["-n", "目標"]), "{argv:?}");
    let r = rig(Opt { status: "busy", ..Opt::default() });
    let res = r.run("model", json!({ "model": "sonnet" }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("進行中"), "{}", res.detail);
    assert!(r.terminated().is_empty());
    assert_eq!(rig(Opt::default()).run("model", json!({ "model": "bad model;" })).status, "failed");
}

// ================================================================================================
// 轉交
// ================================================================================================

#[test]
fn 轉交_開新_session_不帶_resume_名字與模型不變_第一句話是後台給的接班提示() {
    let r = rig(Opt::default());
    let res = r.run("handover", json!({ "note": "你是『目標』的下一任。補充：先看 PR。" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    let argv = r.launched().remove(0).2;
    assert!(!argv.iter().any(|a| a == "--resume" || a == "sid-220" || a == "--continue"), "{argv:?}");
    assert!(argv_has(&argv, &["-n", "目標"]) && argv_has(&argv, &["--model", "opus"]), "{argv:?}");
    assert_eq!(&argv[argv.len() - 2..], ["--".to_string(), "你是『目標』的下一任。補充：先看 PR。".to_string()]);
    assert_eq!(res.result.unwrap()["session_id"], "sid-new");
}

#[test]
fn 轉交_沒給提示就用固定文字_新視窗_session_沒換不算成功() {
    let r = rig(Opt::default());
    *r.env.appear.lock().unwrap() = Some((502, "sid-220".into()));
    let res = r.run("handover", json!({}));
    assert_eq!(res.status, "unconfirmed", "新視窗的 sessionId 和舊的一樣＝不是新對話");
    let argv = r.launched().remove(0).2;
    assert_eq!(argv.last().unwrap(), &default_handover_note("目標"));
    assert!(default_handover_note("目標").starts_with("你是『目標』的下一任，前任的 context 用完了。"));
}

// ================================================================================================
// 規則 6：每個操作都留紀錄
// ================================================================================================

#[test]
fn 規則6_log_與往來記錄_有誰下令_何時_做了什麼_結果() {
    let r = rig(Opt::default());
    let op = mk_op("rename", json!({ "new_name": "新名字" }));
    r.ops.record(&op, &ok("新視窗已出現", None));
    r.ops.record(&mk_op("close", json!({})), &failed("守門：這個程序不允許結束"));
    let lines = r.log.recent().join("\n");
    assert!(lines.contains("partner_op op-1") && lines.contains("op=rename") && lines.contains("小良哥的手機") && lines.contains("-> ok"), "{lines}");
    assert!(lines.contains("-> failed"), "{lines}");
    let files: Vec<_> = std::fs::read_dir(&r.handoff).unwrap().flatten().collect();
    assert_eq!(files.len(), 1);
    let text = std::fs::read_to_string(files[0].path()).unwrap();
    for needle in ["視窗管理", "小良哥的手機", "2026-10-22T10:00:00Z", "改名為「新名字」", "結果：成功", "關閉視窗", "結果：失敗，守門"] {
        assert!(text.contains(needle), "缺 {needle}：{text}");
    }
}

// ================================================================================================
// 輪詢：假後端（127.0.0.1）
// ================================================================================================

#[derive(Default)]
struct Srv {
    pending_calls: usize,
    unsupported: bool,
    ops: Vec<Value>,
    results: Vec<Value>,
}

fn start_srv(st: Arc<Mutex<Srv>>) -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let mut c = c;
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let (head_end, len) = loop {
                let n = c.read(&mut tmp).unwrap_or(0);
                if n == 0 {
                    break (0, 0);
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                    break (i + 4, head.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0));
                }
            };
            while head_end > 0 && buf.len() < head_end + len {
                let n = c.read(&mut tmp).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let body: Value = serde_json::from_slice(&buf[head_end..(head_end + len).min(buf.len())]).unwrap_or(Value::Null);
            let action = head.lines().next().unwrap_or("").split("action=").nth(1).unwrap_or("").split(&['&', ' '][..]).next().unwrap_or("").to_string();
            let mut s = st.lock().unwrap();
            let (code, out) = match action.as_str() {
                "partner_op_pending" => {
                    s.pending_calls += 1;
                    if s.unsupported {
                        (404, json!({ "error": "unknown_action" }))
                    } else {
                        (200, json!({ "ops": std::mem::take(&mut s.ops) }))
                    }
                }
                "partner_op_result" => {
                    s.results.push(body);
                    (200, json!({ "ok": true }))
                }
                _ => (404, json!({})),
            };
            let text = out.to_string();
            let _ = write!(c, "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
        }
    });
    url
}

fn rig_with_server(o: Opt, st: Arc<Mutex<Srv>>) -> Rig {
    let mut r = rig(o);
    let url = start_srv(st);
    let relay = Arc::new(Relay::new(url, "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync> = Arc::new(|name, _| name == "T-收發室");
    r.ops = PartnerOps::new(relay, r.log.clone(), r.handoff.clone(), r.env.clone(), OpsDirs { sessions: r.sessions.clone(), status: r.status.clone(), control: r.control.clone() }, protect);
    r
}

async fn wait_results(st: &Arc<Mutex<Srv>>, n: usize) -> Vec<Value> {
    for _ in 0..200 {
        {
            let s = st.lock().unwrap();
            if s.results.len() >= n {
                return s.results.clone();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    st.lock().unwrap().results.clone()
}

#[tokio::test]
async fn 輪詢_取走待辦_執行_回報結果_並寫紀錄() {
    let st = Arc::new(Mutex::new(Srv::default()));
    st.lock().unwrap().ops = vec![
        json!({ "id": "a1", "name": "目標", "op": "info", "requested_by": "U1", "requested_by_label": "手機甲", "created_at": "t" }),
        json!({ "id": "a2", "name": "目標", "op": "close", "requested_by": "U1", "requested_by_label": "手機甲", "created_at": "t" }),
    ];
    let r = rig_with_server(Opt::default(), st.clone());
    r.ops.pull().await;
    let res = wait_results(&st, 2).await;
    assert_eq!(res.len(), 2, "{res:?}");
    let info = res.iter().find(|x| x["id"] == "a1").unwrap();
    assert_eq!(info["status"], "ok");
    assert_eq!(info["result"]["pid"], 220);
    let close = res.iter().find(|x| x["id"] == "a2").unwrap();
    // 兩筆同一個視窗：第二筆若撞上第一筆還在處理會被擋；兩種結果都合法，但一定有狀態與中文說明
    assert!(["ok", "failed"].contains(&close["status"].as_str().unwrap()), "{close}");
    assert!(close["detail"].as_str().unwrap().chars().count() <= DETAIL_MAX);
    assert!(r.log.recent().iter().any(|l| l.contains("partner_op a1")), "{:?}", r.log.recent());
    assert!(std::fs::read_dir(&r.handoff).unwrap().count() >= 1, "往來記錄");
    // 同一筆不重做
    st.lock().unwrap().ops = vec![json!({ "id": "a1", "name": "目標", "op": "info" })];
    r.ops.pull().await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(st.lock().unwrap().results.len(), 2);
}

#[tokio::test]
async fn 輪詢_後台不認得這個動作_靜默停用_只記一次() {
    let st = Arc::new(Mutex::new(Srv { unsupported: true, ..Default::default() }));
    let r = rig_with_server(Opt::default(), st.clone());
    r.ops.pull().await;
    r.ops.pull().await;
    r.ops.pull().await;
    assert_eq!(st.lock().unwrap().pending_calls, 1, "停用後不再問");
    assert_eq!(r.log.count("partner_op_pending not supported"), 1);
}

#[tokio::test]
async fn 輪詢_不認得的動作與缺名字_回失敗() {
    let st = Arc::new(Mutex::new(Srv::default()));
    st.lock().unwrap().ops = vec![json!({ "id": "b1", "name": "目標", "op": "explode" }), json!({ "id": "b2", "name": "", "op": "close" })];
    let r = rig_with_server(Opt::default(), st.clone());
    r.ops.pull().await;
    let res = wait_results(&st, 2).await;
    assert_eq!(res.len(), 2);
    assert!(res.iter().all(|x| x["status"] == "failed"));
    assert!(r.terminated().is_empty());
}

#[test]
fn 重開用的參數_改寫函式的通用版_與舊版一致() {
    let args: Vec<String> = ["claude.exe", "--model", "opus", "-n", "舊", "--resume", "s0", "--flag", "--", "舊提示"].iter().map(|s| s.to_string()).collect();
    assert_eq!(switch::rewrite_args(&args, "s1", "新", "sonnet"), switch::rewrite_args_opts(&args, Some("s1"), "新", Some("sonnet"), None));
    let h = switch::rewrite_args_opts(&args, None, "新", None, Some("接班"));
    assert_eq!(h, ["claude.exe", "-n", "新", "--flag", "--", "接班"].map(String::from).to_vec());
}
