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
    /// 程序建立時間（毫秒）；沒列的查不到
    started: Mutex<HashMap<u32, u64>>,
    /// sleep 時要做的事（模擬外掛在等待期間回報）
    on_sleep: Mutex<Option<Box<dyn Fn() + Send>>>,
    /// 程序的工作資料夾（接手 pi 用）；沒列的查不到
    cwds: Mutex<HashMap<u32, String>>,
    /// 結束時不理（模擬程序關不掉）
    immortal: Mutex<HashSet<u32>>,
}

impl Os for FakeOs {
    fn cmdline(&self, pid: u32) -> Option<String> {
        self.cmd.lock().unwrap().get(&pid).cloned()
    }
    fn cwd(&self, pid: u32) -> Option<String> {
        self.cwds.lock().unwrap().get(&pid).cloned()
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
        if !self.immortal.lock().unwrap().contains(&pid) {
            self.alive.lock().unwrap().remove(&pid);
        }
        Ok(())
    }
    fn own_pid(&self) -> u32 {
        self.own
    }
    fn started_ms(&self, pid: u32) -> Option<u64> {
        self.started.lock().unwrap().get(&pid).copied()
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
    /// 本機啟動設定（喚醒用）
    cfg: Mutex<Result<LaunchConfig, String>>,
    /// 送進視窗的信 (視窗名, 內文)、送信當下已結束的程序數、信裡的交接檔路徑、中途回報的階段
    told: Mutex<Vec<(String, String)>>,
    terminated_at_tell: Mutex<Option<usize>>,
    told_path: Arc<Mutex<Option<String>>>,
    progress: Mutex<Vec<String>>,
    /// 模擬前任收到信就把交接寫好
    write_on_tell: AtomicBool,
    tell_fails: AtomicBool,
    /// pi 視窗的家目錄（登記檔與控制檔）；pi_reply＝假擴充每次被等待時要回的結果（None＝不回，模擬 pi 忙碌）
    pi_home: PathBuf,
    pi_reply: Mutex<Option<Value>>,
    /// 接手開的 pi：(名字, 資料夾, 對話檔)；pi_launch_fail＝開不起來；pi_launch_registers＝開了之後擴充有沒有登記上名單
    pi_launched: Mutex<Vec<(String, String, String)>>,
    pi_launch_fail: AtomicBool,
    pi_launch_registers: AtomicBool,
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
    fn mod_probe_ms(&self) -> u64 {
        40
    }
    fn launch_config(&self) -> Result<LaunchConfig, String> {
        self.cfg.lock().unwrap().clone()
    }
    fn tell(&self, name: &str, text: &str) -> Result<(), String> {
        self.told.lock().unwrap().push((name.to_string(), text.to_string()));
        *self.terminated_at_tell.lock().unwrap() = Some(self.os.terminated.lock().unwrap().len());
        if self.tell_fails.load(Ordering::SeqCst) {
            return Err("投遞失敗".into());
        }
        let path = text.strip_prefix("要換手了：請把交接寫到 ").and_then(|s| s.split("，寫完").next()).unwrap_or("").to_string();
        *self.told_path.lock().unwrap() = Some(path.clone());
        if self.write_on_tell.load(Ordering::SeqCst) {
            std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
            std::fs::write(&path, "# 交接
前任寫的內容").unwrap();
        }
        Ok(())
    }
    fn progress(&self, _op_id: &str, detail: &str) {
        self.progress.lock().unwrap().push(detail.to_string());
    }
    fn handoff_wait_ms(&self) -> u64 {
        50
    }
    fn handoff_poll_ms(&self) -> u64 {
        1
    }
    fn pi_home(&self) -> PathBuf {
        self.pi_home.clone()
    }
    fn pi_wait_ms(&self) -> u64 {
        1000
    }
    fn pi_agent_dir(&self) -> PathBuf {
        self.pi_home.join(".pi").join("agent")
    }
    fn launch_pi_session(&self, _config: &LaunchConfig, name: &str, cwd: &str, session_file: &str) -> Result<u32, String> {
        if self.pi_launch_fail.load(Ordering::SeqCst) {
            return Err("開不起來".into());
        }
        self.pi_launched.lock().unwrap().push((name.into(), cwd.into(), session_file.into()));
        if self.pi_launch_registers.load(Ordering::SeqCst) {
            let d = self.pi_home.join(".asn").join("pi-windows");
            std::fs::create_dir_all(&d).unwrap();
            let v = json!({ "v": 1, "engine": "pi", "ext": 2, "sessionId": "newsid", "name": name, "pid": 4900, "cwd": cwd, "state": "idle", "at": NOW });
            std::fs::write(d.join("newsid.json"), v.to_string()).unwrap();
            self.os.alive.lock().unwrap().insert(4900);
        }
        Ok(4900)
    }
    fn pi_sleep(&self, _ms: u64) {
        let Some(reply) = self.pi_reply.lock().unwrap().clone() else { return };
        let dir = self.pi_home.join(".asn").join("pi-control").join("psid");
        let Ok(rd) = std::fs::read_dir(&dir) else { return };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let Some(id) = n.strip_suffix(".json") else { continue };
            if id.ends_with(".result") {
                continue;
            }
            let mut r = reply.clone();
            r["v"] = json!(1);
            r["id"] = json!(id);
            std::fs::write(dir.join(format!("{id}.result.json")), r.to_string()).unwrap();
        }
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
    projects: PathBuf,
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
        started: Mutex::new(HashMap::new()),
        on_sleep: Mutex::new(None),
        cwds: Mutex::new(HashMap::new()),
        immortal: Mutex::new(HashSet::new()),
    });
    let env = Arc::new(FakeEnv {
        os,
        allow_first: AtomicUsize::new(o.allow_first),
        asked: AtomicUsize::new(0),
        launched: Mutex::new(vec![]),
        appear: Mutex::new(Some((501, "sid-new".into()))),
        sessions: sessions.clone(),
        mod_wait: o.mod_wait,
        cfg: Mutex::new(Ok(launch_cfg(&[&work]))),
        told: Mutex::new(vec![]),
        terminated_at_tell: Mutex::new(None),
        told_path: Arc::new(Mutex::new(None)),
        progress: Mutex::new(vec![]),
        write_on_tell: AtomicBool::new(true),
        tell_fails: AtomicBool::new(false),
        pi_home: tmp.path().join("pihome"),
        pi_reply: Mutex::new(None),
        pi_launched: Mutex::new(vec![]),
        pi_launch_fail: AtomicBool::new(false),
        pi_launch_registers: AtomicBool::new(true),
    });
    let status = tmp.path().join("status");
    let control = tmp.path().join("control");
    let handoff = tmp.path().join("handoff");
    let projects = tmp.path().join("projects");
    let log = Arc::new(BridgeLog::new(None));
    let relay = Arc::new(Relay::new("http://127.0.0.1:1/".into(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync> = Arc::new(|name, pid| name == "T-收發室" || name == "T-ASN" || pid == 777);
    let ops = PartnerOps::new(relay, log.clone(), handoff.clone(), env.clone(), OpsDirs { sessions: sessions.clone(), status: status.clone(), control: control.clone(), projects: projects.clone() }, protect);
    Rig { tmp, ops, env, log, sessions, status, control, work, handoff, projects }
}

/// 本機啟動設定：一個 claude profile（固定參數含 -n {name}），允許的資料夾由呼叫端給
fn launch_cfg(allow: &[&Path]) -> LaunchConfig {
    use crate::launch::profiles::Profile;
    let mut profiles = HashMap::new();
    profiles.insert("zzz".to_string(), Profile { label: "排在後面的".into(), command: "other.exe".into(), args: vec!["{name}".into()], engine: "claude".into(), mode: LaunchMode::Window, disabled: false, disabled_reason: String::new() });
    profiles.insert("claude".to_string(), Profile { label: "Claude".into(), command: r"C:\fake\claude.exe".into(), args: vec!["--dangerously-skip-permissions".into(), "-n".into(), "{name}".into(), "--model".into(), "opus".into()], engine: "claude".into(), mode: LaunchMode::Window, disabled: false, disabled_reason: String::new() });
    LaunchConfig { profiles, cwd_allow: allow.iter().map(|p| canonical_launch_cwd(&p.to_string_lossy()).unwrap()).collect(), max_per_hour: 6 }
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
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW - 1000, "state": "idle", "model": "claude-sonnet-4-5", "context": { "used": 120000, "limit": 200000, "junk": "x" } }));
    let v = r.run("info", json!({})).result.unwrap();
    assert_eq!(v["opened_by"], "asn");
    assert_eq!(v["mod_installed"], true);
    assert_eq!(v["model"], "claude-sonnet-4-5", "外掛有回報就以外掛為準");
    assert_eq!(v["context"], json!({ "used": 120000, "limit": 200000, "percent": 60 }), "只收 used／limit／percent，percent 可由前兩者算出");
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
    assert!(r.os().closed.lock().unwrap().is_empty(), "不送關閉訊息，免得把使用者的終端機一起關掉");
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
fn 改名_外掛等到時間還沒回_視窗還在忙_不重開_回失敗並收掉控制檔() {
    let r = rig(Opt { status: "busy", mod_wait: 30, ..Opt::default() });
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "busy" }));
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!(res.status, "failed", "{}", res.detail);
    assert!(res.detail.contains("還在忙") && res.detail.contains("沒有改名"), "{}", res.detail);
    assert!(r.launched().is_empty() && r.terminated().is_empty(), "外掛還活著就不能硬重開（會打斷忙碌的對話）");
    assert!(!r.control.join("sid-220.json").exists(), "新視窗的外掛不能再執行一次舊指令");
}

#[test]
fn 改名_外掛真的沒回應_狀態檔等待中變無效_才退回重開() {
    let r = rig(Opt { mod_wait: 5000, ..Opt::default() });
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "idle" }));
    let (status, calls) = (r.status.clone(), Arc::new(AtomicUsize::new(0)));
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) == 2 {
            // 外掛結束了：狀態檔寫成「已結束」
            std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "detail": "已結束" }).to_string()).unwrap();
        }
    }));
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(r.launched().len(), 1, "退回重開");
    assert!(!r.control.join("sid-220.json").exists());
}

#[test]
fn 排隊_視窗忙碌時等外掛_回報排隊中_忙完後成功_不重開() {
    for (op, extra) in [("rename", json!({ "new_name": "新名字" })), ("model", json!({ "model": "sonnet" }))] {
        let r = rig(Opt { status: "busy", mod_wait: 60_000, ..Opt::default() });
        r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "busy" }));
        let (status, calls) = (r.status.clone(), Arc::new(AtomicUsize::new(0)));
        *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
            // 等了十幾輪（視窗忙完了）外掛才執行並回報
            if calls.fetch_add(1, Ordering::SeqCst) == 12 {
                std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "op-1", "ok": true, "detail": "已完成" } }).to_string()).unwrap();
            }
        }));
        let res = r.run(op, extra);
        assert_eq!(res.status, "ok", "{op}：{}", res.detail);
        assert_eq!(res.detail, "已完成");
        assert!(r.launched().is_empty() && r.terminated().is_empty(), "{op}：排隊等到了就不重開");
        assert_eq!(*r.env.progress.lock().unwrap(), vec!["stage:queued"], "{op}：只回報一次排隊中");
        assert!(!r.control.join("sid-220.json").exists());
    }
}

#[test]
fn 排隊_立刻就回報的不送排隊中() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "op-1", "ok": true, "detail": "好" } }));
    assert_eq!(r.run("model", json!({ "model": "sonnet" })).status, "ok");
    assert!(r.env.progress.lock().unwrap().is_empty());
}

#[test]
fn 沒有外掛的視窗_維持原本行為_不排隊_改名直接重開() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(r.launched().len(), 1);
    assert!(r.env.progress.lock().unwrap().is_empty());
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
// 接班換手（handover）
// ================================================================================================

/// 前任（sid-220）的對話紀錄：projects/某資料夾/sid-220.jsonl
fn write_old_transcript(r: &Rig) -> PathBuf {
    let dir = r.projects.join("D--Github-工作");
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("sid-220.jsonl");
    std::fs::write(&f, json!({ "type": "user", "cwd": r.work.to_string_lossy() }).to_string()).unwrap();
    f
}

#[test]
fn 接班換手_請前任寫交接_等檔案_關前任_同名開新_不帶_resume_第一句話指向對話紀錄與交接檔() {
    let r = rig(Opt::default());
    let transcript = write_old_transcript(&r);
    let res = r.run("handover", json!({ "note": "先看 PR 12。
再跑測試。" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    // 1. 先請前任寫交接（還沒關任何程序），位置在規範資料夾內
    let told = r.env.told.lock().unwrap().clone();
    assert_eq!(told.len(), 1);
    assert_eq!(told[0].0, "目標");
    let root = r.handoff.join(HANDOFF_SUBDIR).join("目標");
    let path = told[0].1.strip_prefix("要換手了：請把交接寫到 ").and_then(|s| s.strip_suffix("，寫完回覆『交接完成』。")).unwrap().to_string();
    assert!(Path::new(&path).starts_with(&root) && path.ends_with(".md"), "{path}");
    assert_eq!(*r.env.terminated_at_tell.lock().unwrap(), Some(0), "請前任寫交接時還沒關任何程序");
    // 2. 關前任、同名開新對話
    assert!(r.terminated().contains(&220));
    let argv = r.launched().remove(0).2;
    assert!(!argv.iter().any(|a| a == "--resume" || a == "sid-220" || a == "--continue" || a == "--session-id"), "同名開新，不帶 --resume：{argv:?}");
    assert!(argv_has(&argv, &["-n", "目標"]) && argv_has(&argv, &["--model", "opus"]), "{argv:?}");
    // 3. 第一句話：前任對話紀錄完整路徑（從最後往前看）＋交接檔＋補充的話；有寫完就不寫「沒有寫完」
    let want = format!("你是『目標』的下一任，前任的上下文用完了。先讀前任最後一段對話紀錄 {}（從最後往前看）和交接檔 {path}，接著把手上的工作做下去。\n前任交代：先看 PR 12。\n再跑測試。", transcript.display());
    assert_eq!(&argv[argv.len() - 2..], ["--".to_string(), want]);
    let v = res.result.unwrap();
    assert_eq!((v["session_id"].as_str(), v["handoff_path"].as_str(), v["handoff_done"].as_bool()), (Some("sid-new"), Some(path.as_str()), Some(true)));
    // 4. 階段依序回報
    assert_eq!(*r.env.progress.lock().unwrap(), vec!["stage:handoff", "stage:closing", "stage:opening"]);
}

#[test]
fn 接班換手_前任沒寫完_逾時仍會換手_第一句話註明() {
    for tell_fails in [false, true] {
        let r = rig(Opt::default());
        write_old_transcript(&r);
        r.env.write_on_tell.store(false, Ordering::SeqCst);
        r.env.tell_fails.store(tell_fails, Ordering::SeqCst);
        let res = r.run("handover", json!({}));
        assert_eq!(res.status, "ok", "逾時照樣換手：{}", res.detail);
        let argv = r.launched().remove(0).2;
        let prompt = argv.last().unwrap();
        assert!(prompt.contains("前任沒有寫完交接"), "{prompt}");
        assert!(r.terminated().contains(&220));
        assert_eq!(res.result.unwrap()["handoff_done"], false);
    }
}

#[test]
fn 接班換手_交接檔大小還在變_不算寫完_穩定了才算() {
    let r = rig(Opt::default());
    write_old_transcript(&r);
    // 每次輪詢（sleep）都把檔案加長，直到逾時：永遠不穩定
    r.env.write_on_tell.store(false, Ordering::SeqCst);
    let told = r.env.told_path.clone();
    let growing = Arc::new(AtomicUsize::new(0));
    let g2 = growing.clone();
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        if let Some(p) = told.lock().unwrap().clone() {
            let n = g2.fetch_add(1, Ordering::SeqCst) + 1;
            std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
            std::fs::write(&p, "x".repeat(n)).unwrap();
        }
    }));
    let res = r.run("handover", json!({}));
    assert_eq!(res.status, "ok");
    assert_eq!(res.result.unwrap()["handoff_done"], false, "大小一直在變＝還沒寫完");
}

#[test]
fn 接班換手_沒找到前任的對話紀錄_第一句話只指向交接檔() {
    let r = rig(Opt::default());
    let res = r.run("handover", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    let prompt = r.launched().remove(0).2.pop().unwrap();
    assert!(prompt.contains("找不到前任的對話紀錄檔") && prompt.contains("交接檔"), "{prompt}");
}

#[test]
fn 接班換手_新視窗_session_沒換不算成功_仍回交接檔位置() {
    let r = rig(Opt::default());
    *r.env.appear.lock().unwrap() = Some((502, "sid-220".into()));
    let res = r.run("handover", json!({}));
    assert_eq!(res.status, "unconfirmed", "新視窗的 sessionId 和舊的一樣＝不是新對話");
    assert!(res.result.unwrap()["handoff_path"].as_str().is_some());
}

#[test]
fn 接班換手守門_交接檔路徑只在規範資料夾內_檔名只有安全字元_有夥伴_id_用夥伴_id() {
    let base = Path::new("handoff-base");
    let root = base.join(HANDOFF_SUBDIR);
    for key in ["../../evil", "a/b\\c", "..", "", "C:\\x", "名字 空白;rm", "p_0123456789abcdef0123", &"長".repeat(200)] {
        let p = handoff_path(base, key, 1_800_000_000_000).unwrap();
        assert!(p.starts_with(&root), "{key:?} -> {p:?}");
        assert!(p.components().all(|c| !matches!(c, std::path::Component::ParentDir)), "{p:?}");
        assert_eq!(p.parent().unwrap().parent().unwrap(), root, "只有一層夥伴資料夾：{p:?}");
        let dir = p.parent().unwrap().file_name().unwrap().to_string_lossy().to_string();
        assert!(dir.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_'), "{dir}");
        let file = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(file.ends_with(".md") && file[..file.len() - 3].chars().all(|c| c.is_ascii_digit() || c == '-') && file.len() == "20270115-080000.md".len(), "{file}");
    }
    assert_eq!(handoff_path(base, "p_0123456789abcdef0123", 0).unwrap().parent().unwrap().file_name().unwrap(), "p_0123456789abcdef0123");
    // 有夥伴 ID 時資料夾用夥伴 ID，不是視窗名
    let r = rig(Opt::default());
    r.ops.set_partners(std::collections::BTreeMap::from([("目標".to_string(), "p_00000000000000000042".to_string())]));
    let res = r.run("handover", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    let told = r.env.told.lock().unwrap()[0].1.clone();
    assert!(told.contains("p_00000000000000000042") && !told.contains("交接\\目標") && !told.contains("交接/目標"), "{told}");
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
    r.ops = PartnerOps::new(relay, r.log.clone(), r.handoff.clone(), r.env.clone(), OpsDirs { sessions: r.sessions.clone(), status: r.status.clone(), control: r.control.clone(), projects: r.projects.clone() }, protect);
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

// ================================================================================================
// 喚醒（resume）：視窗已關，用同一個 sessionId 在原工作資料夾重開
// ================================================================================================

const SID: &str = "sid-offline-1";

/// 離線夥伴「離線夥伴」：沒有活著的視窗，對話紀錄在 projects/某資料夾/<sid>.jsonl，第三行才有 cwd
fn resume_rig(o: Opt) -> Rig {
    let r = rig(o);
    let dir = r.projects.join("D--Github-工作");
    std::fs::create_dir_all(&dir).unwrap();
    let lines = [json!({ "type": "summary", "summary": "x" }), json!({ "type": "queue-operation" }), json!({ "type": "user", "cwd": r.work.to_string_lossy(), "sessionId": SID })];
    std::fs::write(dir.join(format!("{SID}.jsonl")), lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    *r.env.appear.lock().unwrap() = Some((501, SID.into()));
    r
}

fn resume(r: &Rig, name: &str, sid: &str) -> OpResult {
    r.ops.execute(&mk_op("resume", json!({ "name": name, "session_id": sid })))
}

#[test]
fn 喚醒_成功_原資料夾用第一個_claude_profile_帶_resume_與_n_乾淨環境開_不結束任何程序() {
    let r = resume_rig(Opt::default());
    let res = resume(&r, "離線夥伴", SID);
    assert_eq!(res.status, "ok", "{}", res.detail);
    let l = r.launched();
    assert_eq!(l.len(), 1);
    let (name, cwd, argv) = &l[0];
    assert_eq!(name, "離線夥伴");
    assert_eq!(cwd.to_string_lossy().replace(r"\\?\", ""), r.work.canonicalize().unwrap().to_string_lossy().replace(r"\\?\", ""));
    assert_eq!(argv[0], r"C:\fake\claude.exe", "claude 排第一，不是 zzz");
    assert!(argv_has(argv, &["-n", "離線夥伴"]) && argv_has(argv, &["--resume", SID]), "{argv:?}");
    assert_eq!(argv.iter().filter(|a| *a == "-n").count(), 1, "設定裡已有 -n，不重複：{argv:?}");
    assert!(argv.iter().any(|a| a == "--dangerously-skip-permissions") && argv_has(argv, &["--model", "opus"]), "{argv:?}");
    assert!(!argv.iter().any(|a| a == "--continue" || a == "{name}"));
    assert!(r.terminated().is_empty() && r.os().closed.lock().unwrap().is_empty(), "不動任何程序");
    let v = res.result.unwrap();
    assert_eq!((v["pid"].as_u64(), v["session_id"].as_str()), (Some(501), Some(SID)));
    // 記錄裡看得到「喚醒視窗」
    r.ops.record(&mk_op("resume", json!({ "name": "離線夥伴" })), &ok("視窗已喚醒", None));
    assert!(r.log.recent().join("\n").contains("op=resume"));
    assert_eq!(mk_op("resume", json!({})).what(), "喚醒視窗");
}

#[test]
fn 喚醒_新視窗一直沒出現_回未確認() {
    let r = resume_rig(Opt::default());
    *r.env.appear.lock().unwrap() = None;
    let res = resume(&r, "離線夥伴", SID);
    assert_eq!(res.status, "unconfirmed", "{}", res.detail);
    assert_eq!(r.launched().len(), 1);
}

#[test]
fn 喚醒守門_工作資料夾不在本機啟動設定的允許清單_不開() {
    let r = resume_rig(Opt::default());
    let other = r.tmp.path().join("別的資料夾");
    std::fs::create_dir_all(&other).unwrap();
    *r.env.cfg.lock().unwrap() = Ok(launch_cfg(&[&other]));
    let res = resume(&r, "離線夥伴", SID);
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("不在這台電腦允許的清單內"), "{}", res.detail);
    assert!(r.launched().is_empty(), "資料夾不在白名單就不開");
    // 啟動設定整個讀不到也不開
    *r.env.cfg.lock().unwrap() = Err("這台電腦還沒有可用的啟動設定".into());
    assert_eq!(resume(&r, "離線夥伴", SID).status, "failed");
    assert!(r.launched().is_empty());
    // 上層資料夾在白名單不等於子資料夾在白名單
    *r.env.cfg.lock().unwrap() = Ok(launch_cfg(&[r.tmp.path()]));
    assert_eq!(resume(&r, "離線夥伴", SID).status, "failed", "只認完全相同的資料夾");
    assert!(r.launched().is_empty());
}

#[test]
fn 喚醒守門_已經在線_同名或同_sessionid_都不開() {
    let r = resume_rig(Opt::default());
    // 同名（活著的「目標」視窗）
    let res = resume(&r, "目標", SID);
    assert_eq!((res.status, res.detail.as_str()), ("failed", "這位夥伴已經在線上"));
    // 同 sessionId（活著的 sid-220 被別的名字用著）
    let dir = r.projects.join("D--Github-工作");
    std::fs::write(dir.join("sid-220.jsonl"), json!({ "cwd": r.work.to_string_lossy() }).to_string()).unwrap();
    let res = resume(&r, "離線夥伴", "sid-220");
    assert_eq!((res.status, res.detail.as_str()), ("failed", "這位夥伴已經在線上"));
    assert!(r.launched().is_empty());
    // 死掉的同名記錄不算在線
    write_session(&r.sessions, 900, "sid-dead", "離線夥伴", "idle", r.work.to_str().unwrap());
    assert_eq!(resume(&r, "離線夥伴", SID).status, "ok", "程序已死的殘留記錄不擋");
}

#[test]
fn 喚醒守門_sessionid_格式不合_不碰任何檔案() {
    let r = resume_rig(Opt::default());
    // 誘餌：用路徑穿越能碰到的檔案，裡面有合法的 cwd
    std::fs::write(r.projects.join("escape.jsonl"), json!({ "cwd": r.work.to_string_lossy() }).to_string()).unwrap();
    std::fs::write(r.projects.join("D--Github-工作").join("a b.jsonl"), json!({ "cwd": r.work.to_string_lossy() }).to_string()).unwrap();
    for bad in ["../escape", "..\\escape", "a b", "", "a/b", "x.y", &"a".repeat(129), "與"] {
        let res = resume(&r, "離線夥伴", bad);
        assert_eq!(res.status, "failed", "{bad:?}");
        assert!(r.launched().is_empty(), "{bad:?}");
        assert_eq!(find_transcript_cwd(&r.projects, bad), None, "{bad:?}：連找都不找");
    }
    assert!(find_transcript_cwd(&r.projects, SID).is_some(), "合格的當然找得到");
}

#[test]
fn 喚醒守門_本機開關關著_不開_動手前再驗一次() {
    let r = resume_rig(Opt { allow_first: 0, ..Opt::default() });
    let res = resume(&r, "離線夥伴", SID);
    assert_eq!((res.status, res.detail.as_str()), ("failed", CONSENT_OFF));
    assert!(r.launched().is_empty());
    // execute 開頭的檢查通過、動手前已被關掉
    let r = resume_rig(Opt { allow_first: 1, ..Opt::default() });
    let res = resume(&r, "離線夥伴", SID);
    assert_eq!((res.status, res.detail.as_str()), ("failed", CONSENT_OFF));
    assert!(r.launched().is_empty(), "檢查之後被關掉就不開");
}

#[test]
fn 喚醒守門_對話紀錄只比對檔名_內容寫著同一個_sessionid_的別的檔不算() {
    let r = resume_rig(Opt::default());
    let dir = r.projects.join("D--Github-工作");
    std::fs::remove_file(dir.join(format!("{SID}.jsonl"))).unwrap();
    // 檔名不是 sessionId，但內容寫著它；子資料夾裡的同名檔、projects 根目錄的同名檔也不算（只看 projects 底下一層資料夾）
    std::fs::write(dir.join("別人的對話.jsonl"), json!({ "type": "user", "sessionId": SID, "cwd": r.work.to_string_lossy() }).to_string()).unwrap();
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub").join(format!("{SID}.jsonl")), json!({ "cwd": r.work.to_string_lossy() }).to_string()).unwrap();
    std::fs::write(r.projects.join(format!("{SID}.jsonl")), json!({ "cwd": r.work.to_string_lossy() }).to_string()).unwrap();
    let res = resume(&r, "離線夥伴", SID);
    assert_eq!((res.status, res.detail.as_str()), ("failed", "找不到原本的對話紀錄，只能開新的夥伴"));
    assert!(r.launched().is_empty());
}

#[test]
fn 喚醒_紀錄沒有_cwd_或_cwd_已不存在_收發室名字_都不開() {
    let r = resume_rig(Opt::default());
    let f = r.projects.join("D--Github-工作").join(format!("{SID}.jsonl"));
    std::fs::write(&f, "{\"type\":\"summary\"}\nnot json\n").unwrap();
    assert_eq!(resume(&r, "離線夥伴", SID).detail, "找不到原本的對話紀錄，只能開新的夥伴");
    let gone = r.tmp.path().join("已刪除");
    std::fs::write(&f, json!({ "cwd": gone.to_string_lossy() }).to_string()).unwrap();
    *r.env.cfg.lock().unwrap() = Ok(LaunchConfig { cwd_allow: vec![canonical_launch_cwd(&gone.to_string_lossy()).unwrap()], ..launch_cfg(&[&r.work]) });
    assert!(resume(&r, "離線夥伴", SID).detail.contains("已經不存在"));
    assert_eq!(resume(&r, "T-收發室", SID).detail, PROTECTED);
    assert_eq!(resume(&r, "T-ASN", SID).detail, PROTECTED);
    assert!(r.launched().is_empty());
}

#[test]
fn 喚醒_啟動設定只有非_claude_或背景型_profile_不開() {
    let r = resume_rig(Opt::default());
    let mut cfg = launch_cfg(&[&r.work]);
    for p in cfg.profiles.values_mut() {
        p.engine = "codex".into();
    }
    *r.env.cfg.lock().unwrap() = Ok(cfg);
    assert_eq!(resume(&r, "離線夥伴", SID).status, "failed");
    assert!(r.launched().is_empty());
}

// ================================================================================================
// 信件來的 /指令（slash）
// ================================================================================================

fn job(cmd: &str, args: &str) -> CommandJob {
    CommandJob { mail_id: "mail-1".into(), window: "目標".into(), command: cmd.into(), args: args.into(), from_node: "T".into(), from_agent: "u:3cda66252c34".into(), sender: "小良（本人）".into(), reply_from: "T-收發室".into() }
}

/// 第 n 次輪詢時外掛回報 control
fn reply_at(r: &Rig, n: usize, ok_: bool, detail: &str) {
    let (status, calls, detail) = (r.status.clone(), Arc::new(AtomicUsize::new(0)), detail.to_string());
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) == n {
            std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "mail-1", "ok": ok_, "detail": detail } }).to_string()).unwrap();
        }
    }));
}

fn with_mod(r: &Rig) {
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "busy" }));
}

#[test]
fn 指令_有外掛_控制檔欄位_等閒置後成功_內文直接放外掛的輸出_保留換行() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    with_mod(&r);
    assert_eq!(r.ops.command_target("目標").as_deref(), Some("sid-220"));
    let (control, seen) = (r.control.clone(), Arc::new(Mutex::new(None::<Value>)));
    let (status, calls, seen2) = (r.status.clone(), Arc::new(AtomicUsize::new(0)), seen.clone());
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) == 8 {
            *seen2.lock().unwrap() = serde_json::from_str(&std::fs::read_to_string(control.join("sid-220.json")).unwrap()).ok();
            std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "mail-1", "ok": true, "detail": "第一行\n第二行\r\n第三行" } }).to_string()).unwrap();
        }
    }));
    let (good, text) = r.ops.command_blocking(&job("compact", "全部 重點"), "sid-220");
    assert!(good);
    assert_eq!(text, "第一行\n第二行\n第三行", "內文直接放 detail、保留換行");
    let c = seen.lock().unwrap().clone().expect("等待期間控制檔在");
    assert_eq!(c["id"], "mail-1");
    assert_eq!(c["op"], "command");
    assert_eq!(c["command"], "compact");
    assert_eq!(c["args"], "全部 重點");
    assert_eq!(c["at"], NOW);
    assert!(!r.control.join("sid-220.json").exists(), "結果出來就刪控制檔");
    assert!(r.launched().is_empty() && r.terminated().is_empty());
}

#[test]
fn 指令_外掛沒輸出_回已執行_輸出超過_1500_字截斷() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    with_mod(&r);
    reply_at(&r, 1, true, "");
    assert_eq!(r.ops.command_blocking(&job("clear", ""), "sid-220"), (true, "已執行 /clear".to_string()));
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    with_mod(&r);
    reply_at(&r, 1, true, &"字".repeat(1800));
    let (_, t) = r.ops.command_blocking(&job("cost", ""), "sid-220");
    assert_eq!(t.chars().count(), 1500);
}

#[test]
fn 指令_外掛回失敗_回沒執行加原因() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    with_mod(&r);
    reply_at(&r, 1, false, "不認得這個指令");
    assert_eq!(r.ops.command_blocking(&job("zzz", ""), "sid-220"), (false, "沒執行 /zzz：不認得這個指令".to_string()));
}

#[test]
fn 指令_等到時間視窗還在忙_回逾時說明_並收掉控制檔() {
    let r = rig(Opt { mod_wait: 30, ..Opt::default() });
    with_mod(&r);
    let (good, t) = r.ops.command_blocking(&job("compact", ""), "sid-220");
    assert!(!good);
    assert_eq!(t, "等了 0 秒 視窗還在忙，沒執行 /compact");
    assert!(!r.control.join("sid-220.json").exists(), "逾時後外掛不能再補做");
    assert_eq!(wait_text(600_000), "10 分鐘");
}

#[test]
fn 指令_外掛等待中沒了_回沒執行() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    with_mod(&r);
    let status = r.status.clone();
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "detail": "已結束" }).to_string()).unwrap();
    }));
    let (good, t) = r.ops.command_blocking(&job("compact", ""), "sid-220");
    assert!(!good && t.contains("沒執行 /compact") && t.contains("沒有回應"), "{t}");
}

#[test]
fn 指令_沒有外掛_過期_換成別人_收發室視窗_都不算有外掛() {
    let r = rig(Opt::default());
    assert_eq!(r.ops.command_target("目標"), None, "沒有狀態檔");
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW - 3_600_000, "state": "idle" }));
    assert_eq!(r.ops.command_target("目標").as_deref(), Some("sid-220"), "過期但視窗還活著：外掛只在狀態改變時寫檔，先試外掛");
    r.os().alive.lock().unwrap().remove(&220);
    assert_eq!(r.ops.command_target("目標"), None, "過期而且視窗程序已死");
    r.os().alive.lock().unwrap().insert(220);
    r.status_file("sid-220", json!({ "sessionId": "sid-999", "at": NOW, "state": "idle" }));
    assert_eq!(r.ops.command_target("目標"), None, "sessionId 不符");
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "detail": "已結束" }));
    assert_eq!(r.ops.command_target("目標"), None, "已結束");
    assert_eq!(r.ops.command_target("幽靈"), None);
    write_session(&r.sessions, 240, "sid-240", "T-收發室", "idle", r.work.to_str().unwrap());
    r.os().alive.lock().unwrap().insert(240);
    r.status_file("sid-240", json!({ "sessionId": "sid-240", "at": NOW, "state": "idle" }));
    assert_eq!(r.ops.command_target("T-收發室"), None, "收發室視窗不收");
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": NOW, "state": "idle" }));
    assert_eq!(r.ops.command_target("目標").as_deref(), Some("sid-220"));
}

#[test]
fn 指令_輪到時視窗已換掉_不寫控制檔() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    with_mod(&r);
    let (good, t) = r.ops.command_blocking(&job("compact", ""), "sid-OLD");
    assert!(!good && t.contains("沒執行"), "{t}");
    assert!(!r.control.join("sid-220.json").exists() && !r.control.join("sid-OLD.json").exists());
}

// ================================================================================================
// 狀態檔過期（外掛只在狀態改變時寫檔，閒置超過 30 分鐘就老了）：控制用途不能因此退回重開
// ================================================================================================

const OLD: u64 = NOW - 3 * 3_600_000;

fn stale_status(r: &Rig, state: &str) {
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": OLD, "state": state }));
}

#[test]
fn 過期_閒置視窗的外掛還活著_照樣由外掛切換_不重開() {
    for (op, extra) in [("rename", json!({ "new_name": "新名字" })), ("model", json!({ "model": "sonnet" }))] {
        let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
        stale_status(&r, "idle");
        let (status, calls) = (r.status.clone(), Arc::new(AtomicUsize::new(0)));
        *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
            // 外掛輪詢到控制檔：執行完把結果寫進狀態檔（at 也跟著更新）
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "op-1", "ok": true, "detail": "已切換" } }).to_string()).unwrap();
            }
        }));
        let res = r.run(op, extra);
        assert_eq!(res.status, "ok", "{op}：{}", res.detail);
        assert_eq!(res.detail, "已切換");
        assert!(r.launched().is_empty() && r.terminated().is_empty(), "{op}：不可退回重開");
        assert!(!r.control.join("sid-220.json").exists());
    }
}

#[test]
fn 過期_閒置視窗_外掛完全沒動靜_短逾時就退回重開_不白等() {
    let r = rig(Opt { mod_wait: 600_000, ..Opt::default() });
    stale_status(&r, "idle");
    let t0 = std::time::Instant::now();
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert!(t0.elapsed() < std::time::Duration::from_secs(5), "探測逾時要短，不是等滿 10 分鐘：{:?}", t0.elapsed());
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(r.launched().len(), 1, "外掛不在才退回重開");
    assert!(!r.control.join("sid-220.json").exists(), "退回前收掉控制檔");
}

#[test]
fn 過期_外掛有動靜_狀態檔更新_就解除探測_繼續等到忙完() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    stale_status(&r, "idle");
    let (status, calls) = (r.status.clone(), Arc::new(AtomicUsize::new(0)));
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        std::thread::sleep(std::time::Duration::from_millis(2));
        match calls.fetch_add(1, Ordering::SeqCst) {
            // 外掛接手：開始執行，狀態變忙（at 變了）
            1 => std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "state": "busy" }).to_string()).unwrap(),
            // 超過探測時間（40ms）很久之後才忙完回報
            100 => std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "op-1", "ok": true, "detail": "好了" } }).to_string()).unwrap(),
            _ => {}
        }
    }));
    let res = r.run("model", json!({ "model": "sonnet" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.detail, "好了");
    assert!(r.launched().is_empty() && r.terminated().is_empty());
}

#[test]
fn 過期_最後狀態是忙碌_外掛可能在排隊_不探測_等滿後回失敗_不重開() {
    let r = rig(Opt { mod_wait: 300, ..Opt::default() });
    stale_status(&r, "busy");
    let res = r.run("model", json!({ "model": "sonnet" }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("還在忙"), "{}", res.detail);
    assert!(r.launched().is_empty() && r.terminated().is_empty(), "重開會打斷對話");
}

#[test]
fn 過期_視窗程序已死或標了結束_不寫控制檔_直接退回() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    stale_status(&r, "idle");
    r.status_file("sid-220", json!({ "sessionId": "sid-220", "at": OLD, "detail": "已結束" }));
    let res = r.run("rename", json!({ "new_name": "新名字" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(r.launched().len(), 1);
}

#[test]
fn 過期_指令_外掛還活著就送_沒動靜短逾時回沒有回應() {
    let r = rig(Opt { mod_wait: 60_000, ..Opt::default() });
    stale_status(&r, "idle");
    let (status, calls) = (r.status.clone(), Arc::new(AtomicUsize::new(0)));
    *r.os().on_sleep.lock().unwrap() = Some(Box::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) == 1 {
            std::fs::write(status.join("sid-220.json"), json!({ "sessionId": "sid-220", "at": NOW, "state": "idle", "control": { "id": "mail-1", "ok": true, "detail": "ok了" } }).to_string()).unwrap();
        }
    }));
    assert_eq!(r.ops.command_blocking(&job("compact", ""), "sid-220"), (true, "ok了".to_string()));
    let r = rig(Opt { mod_wait: 600_000, ..Opt::default() });
    stale_status(&r, "idle");
    let t0 = std::time::Instant::now();
    let (good, t) = r.ops.command_blocking(&job("compact", ""), "sid-220");
    assert!(!good && t.contains("沒有回應"), "{t}");
    assert!(t0.elapsed() < std::time::Duration::from_secs(5));
    assert!(!r.control.join("sid-220.json").exists());
}

// ================================================================================================
// ACP 工作者（收發室自己跑的 Gemini、agy 等）：只支援詳情、重開、接班換手
// ================================================================================================

struct FakeAcp {
    names: Vec<String>,
    calls: Mutex<Vec<String>>,
    fail_with: Mutex<Option<String>>,
}

impl AcpAdmin for FakeAcp {
    fn has_worker(&self, name: &str) -> bool {
        self.names.iter().any(|n| n == name)
    }
    fn info(&self, name: &str) -> Option<Value> {
        self.has_worker(name).then(|| json!({ "pid": 4321, "engine": "gemini", "model": null, "cwd": "D:/w", "status": "idle", "permissions": { "read": "allow", "write": "deny", "execute": "deny", "network": "allow" }, "process_running": true, "has_session": true, "load_session": true }))
    }
    fn restart(&self, name: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("restart {name}"));
        match self.fail_with.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(json!({ "kind": "acp", "pid": 4321, "kept_session": true })),
        }
    }
    fn stop(&self, name: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("stop {name}"));
        match self.fail_with.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(json!({ "kind": "acp", "pid": 4321, "stopped": true })),
        }
    }
    fn remove(&self, name: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("remove {name}"));
        if name == "Gemini" {
            return Err("這位寫在這台電腦的 agents.json，不能從這裡移除；請在電腦上改設定檔".into());
        }
        Ok(json!({ "kind": "acp", "pid": 4321, "removed": true }))
    }
    fn set_model(&self, name: &str, model: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("model {name} {model}"));
        if model == "grok-9" {
            return Err("「grok-9」不在這個工作者可選的模型裡。可選：grok-4.7".into());
        }
        Ok(json!({ "kind": "acp", "pid": 4321, "model": model, "restarted": model.starts_with("gemini"), "saved": true }))
    }
    fn handover(&self, name: &str, note: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("handover {name} [{note}]"));
        Ok(json!({ "kind": "acp", "pid": 4321, "handoff_done": false }))
    }
    fn adopt(&self, session_id: &str, cwd: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(format!("adopt {session_id} {cwd}"));
        match self.fail_with.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(json!({ "kind": "adopt", "name": "grok-接手-專案", "already": false })),
        }
    }
}

const GROK_SID: &str = "01a16c6d-6842-71c0-a78d-911586798d88";

/// 假的 ~/.grok：使用中對話登記（pid 7001 對 GROK_SID）與 sessions 底下的對話資料夾；假程序表加上 grok.exe(7001)
fn grok_rig(r: &Rig, active: Value, with_dir: bool) {
    let home = r.tmp.path().join("grokhome");
    std::fs::create_dir_all(home.join("sessions").join("D%3A%5C專案")).unwrap();
    if with_dir {
        std::fs::create_dir_all(home.join("sessions").join("D%3A%5C專案").join(GROK_SID)).unwrap();
    }
    std::fs::write(home.join("active_sessions.json"), active.to_string()).unwrap();
    r.ops.set_grok_home(home);
    r.os().table.lock().unwrap().push(p(7001, 100, "grok.exe"));
    r.os().alive.lock().unwrap().insert(7001);
}
fn grok_active() -> Value {
    json!([{ "session_id": GROK_SID, "pid": 7001, "cwd": "D:\\專案", "opened_at": "2026-10-24T05:41:12.4Z" }])
}
fn adopt_run(r: &Rig, name: &str) -> OpResult {
    r.run("handover", json!({ "name": name }))
}

fn with_acp(r: &Rig, names: &[&str]) -> Arc<FakeAcp> {
    let a = Arc::new(FakeAcp { names: names.iter().map(|s| s.to_string()).collect(), calls: Mutex::new(vec![]), fail_with: Mutex::new(None) });
    r.ops.set_acp(a.clone());
    a
}

#[test]
fn 接手_用_pid_查到唯一的對話_交給工作者入口_絕不碰那個_grok_程序() {
    let r = rig(Opt::default());
    grok_rig(&r, grok_active(), true);
    let a = with_acp(&r, &["Grok"]);
    let res = adopt_run(&r, "grok #7001（前景）");
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(*a.calls.lock().unwrap(), vec![format!("adopt {GROK_SID} D:\\專案")]);
    assert!(res.detail.contains("專屬工作者「grok-接手-專案」") && res.detail.contains("先關掉終端機那個 grok") && res.detail.contains("互相覆蓋"), "{}", res.detail);
    assert_eq!(res.result.unwrap(), json!({ "kind": "adopt", "name": "grok-接手-專案", "already": false }));
    assert!(r.terminated().is_empty() && r.os().closed.lock().unwrap().is_empty() && r.launched().is_empty(), "不結束、不關閉、不開任何視窗");
    assert!(!res.detail.contains(GROK_SID), "結果不顯示對話編號");
}

#[test]
fn 接手_做不到就不接手_回中文原因_工作者入口完全沒被呼叫() {
    let none = |r: &Rig, a: &Arc<FakeAcp>, name: &str, want: &str| {
        let res = adopt_run(r, name);
        assert_eq!(res.status, "failed", "{name}");
        assert!(res.detail.contains(want), "{name}：{}", res.detail);
        assert!(a.calls.lock().unwrap().is_empty() && r.terminated().is_empty(), "{name}");
    };
    // 沒有登記這個 pid
    let r = rig(Opt::default());
    grok_rig(&r, json!([{ "session_id": GROK_SID, "pid": 1, "cwd": "D:\\x", "opened_at": "" }]), true);
    let a = with_acp(&r, &["Grok"]);
    none(&r, &a, "grok #7001（前景）", "找不到這個 grok 正在用的對話");
    // 同一個 pid 對到兩段不同對話
    let r = rig(Opt::default());
    grok_rig(&r, json!([{ "session_id": GROK_SID, "pid": 7001, "cwd": "D:\\x", "opened_at": "" }, { "session_id": "01a16c71-c809-7650-898d-fde24188667f", "pid": 7001, "cwd": "D:\\x", "opened_at": "" }]), true);
    let a = with_acp(&r, &["Grok"]);
    none(&r, &a, "grok #7001（前景）", "同時對得上 2 段");
    // 對話資料夾不在
    let r = rig(Opt::default());
    grok_rig(&r, grok_active(), false);
    let a = with_acp(&r, &["Grok"]);
    none(&r, &a, "grok #7001（前景）", "找不到這段對話的紀錄資料夾");
    // 那個 pid 不是 grok（名單過期、pid 被重用）
    let r = rig(Opt::default());
    grok_rig(&r, grok_active(), true);
    let a = with_acp(&r, &["Grok"]);
    none(&r, &a, "grok #231（前景）", "已經不在執行");
    // 沒有 grok 的資料夾設定、沒有 ACP 引擎
    let r = rig(Opt::default());
    grok_rig(&r, grok_active(), true);
    *r.ops.grok_home.lock().unwrap() = None;
    let a = with_acp(&r, &["Grok"]);
    none(&r, &a, "grok #7001（前景）", "找不到 grok 的資料夾位置");
    let r = rig(Opt::default());
    grok_rig(&r, grok_active(), true);
    assert!(adopt_run(&r, "grok #7001（前景）").detail.contains("沒有載入內建通道功能"));
    // 遠端開關關著
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    grok_rig(&r, grok_active(), true);
    let a = with_acp(&r, &["Grok"]);
    none(&r, &a, "grok #7001（前景）", CONSENT_OFF);
}

#[test]
fn 接手_工作者載入失敗的原因原樣回報_一般名字的接班換手不受影響() {
    let r = rig(Opt::default());
    grok_rig(&r, grok_active(), true);
    let a = with_acp(&r, &["Grok"]);
    *a.fail_with.lock().unwrap() = Some("專屬工作者沒能載入那段對話，已撤掉：載入那段對話失敗：session not found".into());
    let res = adopt_run(&r, "grok #7001（前景）");
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("沒能載入那段對話"));
    // 名字不是 grok 程序條目：維持原本（找不到視窗）
    let res = adopt_run(&r, "pi #7001（前景）");
    assert_eq!(res.status, "failed");
    assert!(!res.detail.contains("grok"), "{}", res.detail);
    assert_eq!(a.calls.lock().unwrap().len(), 1);
}

fn acp_run(r: &Rig, op: &str, extra: Value) -> OpResult {
    let mut v = json!({ "name": "Gemini" });
    for (k, x) in extra.as_object().cloned().unwrap_or_default() {
        v[k] = x;
    }
    r.run(op, v)
}

#[test]
fn acp_詳情_重開_接班換手_交給工作者管理入口_不碰任何程序() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["Gemini"]);
    let v = acp_run(&r, "info", json!({})).result.unwrap();
    assert_eq!((v["pid"].as_u64(), v["engine"].as_str()), (Some(4321), Some("gemini")));
    let res = acp_run(&r, "restart", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.result.unwrap()["kept_session"], true);
    let res = acp_run(&r, "handover", json!({ "note": "別動資料庫" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.result.unwrap()["handoff_done"], false);
    assert_eq!(*a.calls.lock().unwrap(), vec!["restart Gemini".to_string(), "handover Gemini [別動資料庫]".to_string()]);
    assert!(r.terminated().is_empty() && r.launched().is_empty() && r.os().closed.lock().unwrap().is_empty(), "不用名稱找程序、不結束任何程序、不開視窗");
    assert!(r.env.progress.lock().unwrap().iter().any(|s| s == "stage:opening"), "接班換手有回報階段");
}

#[test]
fn acp_切換模型_交給工作者比對清單_結果寫明有沒有重開_被拒照實回() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["Gemini"]);
    let res = acp_run(&r, "model", json!({ "model": "gemini-3.8-flash-high" }));
    assert_eq!((res.status, res.detail.as_str()), ("ok", "已切換模型：工作者帶同一段對話重開了，對話保留"));
    let res = acp_run(&r, "model", json!({ "model": "grok-4.6" }));
    assert_eq!((res.status, res.detail.as_str()), ("ok", "已切換模型：沒有重開，對話保留"));
    let res = acp_run(&r, "model", json!({ "model": "grok-9" }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("不在這個工作者可選的模型裡"), "{}", res.detail);
    assert_eq!(a.calls.lock().unwrap().len(), 3);
    assert!(r.terminated().is_empty() && r.launched().is_empty(), "不用名稱找程序、不開視窗");
}

#[test]
fn acp_移除_交給工作者_被拒照實回_遠端開關關著不做_不是內建通道的回不支援() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["Gemini", "小葛"]);
    let res = acp_run(&r, "remove", json!({}));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("agents.json"), "{}", res.detail);
    let res = r.run("remove", json!({ "name": "小葛" }));
    assert_eq!((res.status, res.detail.as_str()), ("ok", "已移除：結束了工作者的程序，從名冊刪掉；工作資料夾的檔案留著"));
    assert_eq!(*a.calls.lock().unwrap(), vec!["remove Gemini".to_string(), "remove 小葛".to_string()]);
    let res = r.run("remove", json!({}));
    assert_eq!((res.status, res.detail.as_str()), ("failed", UNSUPPORTED), "不是內建通道的工作者不能移除");
    assert!(r.terminated().is_empty() && r.launched().is_empty());
    // 遠端開關：動手前再驗一次（同 close）
    let r2 = rig(Opt { allow_first: 1, ..Opt::default() });
    let a2 = with_acp(&r2, &["小葛"]);
    assert_eq!(r2.run("remove", json!({ "name": "小葛" })).detail, CONSENT_OFF);
    assert!(a2.calls.lock().unwrap().is_empty(), "開關關了就不叫工作者");
}

#[test]
fn acp_改名_喚醒_一律這類夥伴不支援() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["Gemini"]);
    for (op, extra) in [("rename", json!({ "new_name": "新名字" })), ("resume", json!({ "session_id": "sid-zzzzzzzz" }))] {
        let res = acp_run(&r, op, extra);
        assert_eq!((res.status, res.detail.as_str()), ("failed", UNSUPPORTED), "{op}");
    }
    assert!(a.calls.lock().unwrap().is_empty());
    assert!(r.terminated().is_empty() && r.launched().is_empty());
}

#[test]
fn acp_關閉_交給工作者管理入口停止_不碰任何其他程序_本機沒開放就不做() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["Gemini"]);
    let res = acp_run(&r, "close", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.result.unwrap()["stopped"], true);
    assert_eq!(*a.calls.lock().unwrap(), vec!["stop Gemini".to_string()]);
    assert!(r.terminated().is_empty() && r.launched().is_empty() && r.os().closed.lock().unwrap().is_empty(), "不用名稱找程序、不結束任何程序");
    *a.fail_with.lock().unwrap() = Some("工作者正在處理信件，等它做完再試".into());
    let res = acp_run(&r, "close", json!({}));
    assert_eq!((res.status, res.detail.as_str()), ("failed", "工作者正在處理信件，等它做完再試"));
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    let a = with_acp(&r, &["Gemini"]);
    assert_eq!(acp_run(&r, "close", json!({})).detail, CONSENT_OFF);
    assert!(a.calls.lock().unwrap().is_empty());
}

#[test]
fn acp_重開與接班換手要本機開放遠端管理_詳情不用_動手前再驗一次() {
    let r = rig(Opt { allow_first: 0, ..Opt::default() });
    let a = with_acp(&r, &["Gemini"]);
    assert_eq!(acp_run(&r, "info", json!({})).status, "ok");
    for op in ["restart", "handover"] {
        let res = acp_run(&r, op, json!({}));
        assert_eq!((res.status, res.detail.as_str()), ("failed", CONSENT_OFF), "{op}");
    }
    assert!(a.calls.lock().unwrap().is_empty());
    // 第一次驗過、動手前第二次關掉了
    let r = rig(Opt { allow_first: 1, ..Opt::default() });
    let a = with_acp(&r, &["Gemini"]);
    assert_eq!(acp_run(&r, "restart", json!({})).detail, CONSENT_OFF);
    assert!(a.calls.lock().unwrap().is_empty());
}

#[test]
fn acp_名字對不上收發室管理的工作者_restart_不支援_也不會動_claude_視窗() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["Gemini"]);
    // 目標是 Claude 視窗：restart 不支援，程序沒被碰
    let res = r.run("restart", json!({}));
    assert_eq!((res.status, res.detail.as_str()), ("failed", UNSUPPORTED));
    // 沒有這個名字的工作者：照 Claude 的流程找不到視窗
    let res = acp_run(&r, "handover", json!({ "name": "幽靈" }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("找不到"), "{}", res.detail);
    assert!(a.calls.lock().unwrap().is_empty() && r.terminated().is_empty());
}

#[test]
fn acp_同名的_claude_視窗還活著_不猜_收發室名字受保護() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["目標", "T-收發室"]);
    let res = r.run("restart", json!({}));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("同名"), "{}", res.detail);
    let res = acp_run(&r, "restart", json!({ "name": "T-收發室" }));
    assert_eq!(res.detail, PROTECTED);
    assert!(a.calls.lock().unwrap().is_empty() && r.terminated().is_empty(), "兩種情況都沒動手");
}

#[test]
fn acp_工作者忙碌等原因由管理入口回報_原樣當失敗() {
    let r = rig(Opt::default());
    let a = with_acp(&r, &["Gemini"]);
    *a.fail_with.lock().unwrap() = Some("工作者正在處理信件，等它做完再試".into());
    let res = acp_run(&r, "restart", json!({}));
    assert_eq!((res.status, res.detail.as_str()), ("failed", "工作者正在處理信件，等它做完再試"));
}

#[test]
fn 沒接_acp_管理入口_restart_一律不支援() {
    let r = rig(Opt::default());
    let res = acp_run(&r, "restart", json!({}));
    assert_eq!((res.status, res.detail.as_str()), ("failed", UNSUPPORTED));
}

#[test]
fn 保護名單_ASN視窗名改名後跟著換() {
    let d = tempfile::tempdir().unwrap();
    let w = tempfile::tempdir().unwrap();
    let relay = Arc::new(Relay::new("http://127.0.0.1:1/".into(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let r = relay.clone();
    let protect = move |name: &str| is_protected(name, 0, "T-收發室", &r.window_name(), 0);
    assert!(protect("T-ASN") && protect("T-收發室") && !protect("小希"));
    crate::names::rename(&relay, d.path(), w.path(), "小希", NOW).unwrap();
    assert!(protect("小希"), "改名後新的 ASN 視窗名要受保護");
    assert!(!protect("T-ASN"), "舊名不再是 ASN 視窗");
    assert!(is_protected("x", 77, "m", "a", 77) && !is_protected("x", 0, "m", "a", 0));
}

// ================================================================================================
// 關閉／接班換手後不留殘影
// ================================================================================================

/// 把 220 的 session 檔改成真實的毫秒時間戳 startedAt，並設定「程序建立時間」
fn stamp_220(r: &Rig, started_at: u64, created: Option<u64>) {
    let j = json!({ "pid": 220, "sessionId": "sid-220", "name": "目標", "status": "idle", "cwd": r.work.to_str().unwrap(), "kind": "interactive", "startedAt": started_at });
    std::fs::write(r.sessions.join("220.json"), j.to_string()).unwrap();
    match created {
        Some(c) => r.os().started.lock().unwrap().insert(220, c),
        None => r.os().started.lock().unwrap().remove(&220),
    };
}

#[test]
fn 關閉後_剛結束的視窗留下的_sessions_檔要清掉_別人的檔不碰() {
    let r = rig(Opt::default());
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert!(r.terminated().contains(&220));
    assert!(!r.sessions.join("220.json").exists(), "強制結束的 claude 來不及自己刪 session 檔，日後 pid 被重用就會變成幽靈視窗");
    assert!(r.sessions.join("231.json").exists(), "別人的檔不碰");
}

#[test]
fn 關閉後_session_檔的_sessionid_對不上就不刪() {
    let r = rig(Opt::default());
    // 在動手前被別的 claude 蓋成另一個 sessionId、同名：guard 會因為 target 變了而擋下，不會走到清檔；這裡直接驗清檔函式的條件
    let t = switch::Target { pid: 220, session_id: "sid-other".into(), name: "目標".into(), cwd: String::new(), status: None, args: vec![] };
    r.os().alive.lock().unwrap().remove(&220);
    r.ops.forget_session(&t);
    assert!(r.sessions.join("220.json").exists(), "sessionId 不同＝不是剛結束的那個視窗，不刪");
    let t = switch::Target { session_id: "sid-220".into(), ..t };
    r.os().alive.lock().unwrap().insert(220);
    r.ops.forget_session(&t);
    assert!(r.sessions.join("220.json").exists(), "程序還活著就不刪");
}

#[test]
fn 接班換手後_前任的_sessions_檔也清掉_新視窗的檔還在() {
    let r = rig(Opt::default());
    let res = r.run("handover", json!({}));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert!(!r.sessions.join("220.json").exists(), "前任的 session 檔不留，名單上不會同時有新舊兩個「目標」");
    assert!(r.sessions.join("501.json").exists(), "新視窗的檔在");
}

#[test]
fn 規則3_pid_被別的程序重用_不算活視窗_不動手() {
    let r = rig(Opt::default());
    // session 在 NOW-1 小時開始，但現在 pid 220 對到的程序是 NOW 才建立的＝別的程序
    stamp_220(&r, NOW - 3_600_000, Some(NOW));
    let res = r.run("close", json!({}));
    assert_eq!(res.status, "failed", "{}", res.detail);
    assert!(res.detail.contains("找不到"), "{}", res.detail);
    assert!(r.terminated().is_empty(), "絕不能對被重用的 pid 動手");
}

#[test]
fn 規則3_程序比_session_更早建立或查不到時間_照常當活視窗_不誤砍() {
    for created in [Some(NOW - 7_200_000), Some(NOW - 3_600_000 + 30_000), None] {
        let r = rig(Opt::default());
        stamp_220(&r, NOW - 3_600_000, created);
        let res = r.run("close", json!({}));
        assert_eq!(res.status, "ok", "{created:?}: {}", res.detail);
        assert!(r.terminated().contains(&220));
    }
}

// ================================================================================================
// pi 視窗：切換模型（走擴充的控制檔管道）
// ================================================================================================

#[test]
fn pi_改名_新擴充_成功_同名拒絕_名字不合規則_忙時排隊_遠端開關() {
    let r = rig(Opt::default());
    put_pi_window_ext(&r, "小丙", 4001, "idle");
    *r.env.pi_reply.lock().unwrap() = Some(json!({ "ok": true, "name": "小丁", "at": NOW }));
    let res = r.run("rename", json!({ "name": "小丙", "new_name": "小丁" }));
    assert_eq!((res.status, res.detail.as_str()), ("ok", "已改名"), "{}", res.detail);
    assert_eq!(res.result.unwrap()["new_name"], json!("小丁"));
    for (new, why) in [("-x", "英數"), ("小丙", "一樣"), ("", "英數")] {
        let res = r.run("rename", json!({ "name": "小丙", "new_name": new }));
        assert!(res.status == "failed" && res.detail.contains(why), "{new}: {}", res.detail);
    }
    // 這台電腦已經有同名的 Claude 視窗
    write_session(&r.sessions, 5001, "sid-5001", "小甲", "idle", "D:/g/x");
    r.os().alive.lock().unwrap().insert(5001);
    let res = r.run("rename", json!({ "name": "小丙", "new_name": "小甲" }));
    assert!(res.detail.contains("同名"), "{}", res.detail);
    // pi 忙：排隊
    let b = rig(Opt::default());
    put_pi_window_ext(&b, "小丙", 4001, "busy");
    let res = b.run("rename", json!({ "name": "小丙", "new_name": "小丁" }));
    assert_eq!((res.status, res.detail.as_str()), ("ok", "pi 正在忙，已排隊：做完這一輪就會改名"));
    // 遠端開關關著
    let off = rig(Opt { allow_first: 0, ..Opt::default() });
    put_pi_window_ext(&off, "小丙", 4001, "idle");
    assert_eq!(off.run("rename", json!({ "name": "小丙", "new_name": "小丁" })).detail, CONSENT_OFF);
    assert!(r.terminated().is_empty() && r.launched().is_empty(), "改名不關、不開任何程序");
}

fn put_pi_window_ext(r: &Rig, name: &str, pid: u32, state: &str) {
    let d = r.env.pi_home.join(".asn").join("pi-windows");
    std::fs::create_dir_all(&d).unwrap();
    let v = json!({ "v": 1, "engine": "pi", "ext": 2, "sessionId": "psid", "name": name, "pid": pid, "cwd": "D:/g/x", "state": state, "at": NOW });
    std::fs::write(d.join("psid.json"), v.to_string()).unwrap();
    r.os().alive.lock().unwrap().insert(pid);
}

fn put_pi_window(r: &Rig, name: &str, pid: u32) {
    let d = r.env.pi_home.join(".asn").join("pi-windows");
    std::fs::create_dir_all(&d).unwrap();
    let v = json!({ "v": 1, "engine": "pi", "sessionId": "psid", "name": name, "pid": pid, "cwd": "D:/g/x", "state": "idle", "at": NOW });
    std::fs::write(d.join("psid.json"), v.to_string()).unwrap();
    r.os().alive.lock().unwrap().insert(pid);
}

#[test]
fn pi_模型代號_後台格式還原() {
    assert_eq!(pi_model_spec("anthropic[claude-sonnet-5]"), "anthropic/claude-sonnet-5");
    assert_eq!(pi_model_spec("claude-sonnet-5"), "claude-sonnet-5");
    assert_eq!(pi_model_spec("xai/grok-4"), "xai/grok-4");
    assert_eq!(pi_model_spec("a[b[c]]"), "a[b[c]]");
}

#[test]
fn pi_切換模型_成功_請求內容對_回中文結果() {
    let r = rig(Opt::default());
    put_pi_window(&r, "小丙", 4001);
    *r.env.pi_reply.lock().unwrap() = Some(json!({ "ok": true, "model": "claude-sonnet-5", "provider": "anthropic", "at": NOW }));
    let res = r.run("model", json!({ "name": "小丙", "model": "anthropic[claude-sonnet-5]" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.result.unwrap()["provider"], "anthropic");
    let dir = r.env.pi_home.join(".asn").join("pi-control").join("psid");
    let reqs: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| !e.file_name().to_string_lossy().ends_with(".result.json")).collect();
    let req: Value = serde_json::from_str(&std::fs::read_to_string(reqs[0].path()).unwrap()).unwrap();
    assert_eq!((req["op"].as_str(), req["provider"].as_str(), req["model"].as_str()), (Some("set_model"), Some("anthropic"), Some("claude-sonnet-5")));
    assert!(r.terminated().is_empty() && r.launched().is_empty(), "不碰任何程序、不開視窗");
}

#[test]
fn pi_切換模型_錯誤翻成中文_忙碌逾時_不能用的動作_遠端開關() {
    let r = rig(Opt::default());
    put_pi_window(&r, "小丙", 4001);
    for (reply, want) in [
        (json!({ "ok": false, "error": "not_found" }), "找不到這個模型"),
        (json!({ "ok": false, "error": "no_api_key" }), "沒有設定金鑰"),
        (json!({ "ok": false, "error": "ambiguous", "providers": ["a", "b"] }), "a、b"),
    ] {
        *r.env.pi_reply.lock().unwrap() = Some(reply);
        let res = r.run("model", json!({ "name": "小丙", "model": "m" }));
        assert_eq!(res.status, "failed");
        assert!(res.detail.contains(want), "{}", res.detail);
    }
    // 閒著卻沒回（擴充太舊、沒載入控制功能）：失敗，而且把請求刪掉，免得之後悄悄生效（0.2 A3）
    *r.env.pi_reply.lock().unwrap() = None;
    let res = r.run("model", json!({ "name": "小丙", "model": "m" }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("擴充太舊"), "{}", res.detail);
    let ctl = r.env.pi_home.join(".asn").join("pi-control").join("psid");
    let orphans: Vec<String> = std::fs::read_dir(&ctl).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".json") && !n.ends_with(".result.json") && !ctl.join(n.replace(".json", ".result.json")).exists()).collect();
    assert!(orphans.is_empty(), "沒回的請求要刪掉：{orphans:?}");
    for op in ["handover", "resume", "restart", "info"] {
        let res = r.run(op, json!({ "name": "小丙", "new_name": "新名" }));
        assert_eq!(res.status, "failed", "{op}");
        assert!(res.detail.contains("只能切換模型、改名和關閉"), "{op}: {}", res.detail);
    }
    // 改名：舊擴充（登記檔沒有 ext）直接請更新
    let res = r.run("rename", json!({ "name": "小丙", "new_name": "新名" }));
    assert!(res.detail.contains("擴充太舊，不能改名"), "{}", res.detail);
    assert!(r.terminated().is_empty() && r.launched().is_empty());
    let off = rig(Opt { allow_first: 0, ..Opt::default() });
    put_pi_window(&off, "小丙", 4001);
    *off.env.pi_reply.lock().unwrap() = Some(json!({ "ok": true, "model": "m", "provider": "p" }));
    assert_eq!(off.run("model", json!({ "name": "小丙", "model": "m" })).detail, CONSENT_OFF);
}

#[test]
fn pi_同名的_claude_視窗存在時不當成_pi() {
    let r = rig(Opt::default());
    put_pi_window(&r, "目標", 4001);   // Claude 視窗也叫「目標」
    assert!(!r.ops.is_pi_window("目標"));
    assert!(!r.ops.is_pi_window("沒這個"));
}

// ================================================================================================
// pi 視窗：關閉（0.2 A2）——守門同 Claude 視窗：只結束登記的 pi 與子孫，不碰 ASN、不碰同輩、名單過期不動
// ================================================================================================

/// 在程序表放一個 pi：parent→pi(4001, node.exe)→子程序(4002)；asn_host＝父殼是 ASN 開視窗用的承載殼
/// 使用者自己開的 pi（沒有 ASN 擴充、沒登記）：pi 程序 4001（node 跑 pi 的腳本），在 r.work 底下的「專案」資料夾；對話檔放在假的 ~/.pi/agent/sessions
fn put_user_pi(r: &Rig, sessions: &[(&str, u64)]) -> u32 {
    put_pi_proc(r, false);
    let cwd = r.work.join("專案");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = canonical_launch_cwd(&cwd.to_string_lossy()).unwrap().to_string_lossy().to_string();
    let os = r.os();
    os.cmd.lock().unwrap().insert(4001, "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\npm\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js\"".into());
    os.cwds.lock().unwrap().insert(4001, cwd_s.clone());
    let dir = r.env.pi_home.join(".pi").join("agent").join("sessions").join("--proj--");
    std::fs::create_dir_all(&dir).unwrap();
    for (id, mtime) in sessions {
        let f = dir.join(format!("2026-10-28T00-00-00-000Z_{id}.jsonl"));
        std::fs::write(&f, format!("{}\n{{\"type\":\"message\"}}\n", json!({ "type": "session", "id": id, "cwd": cwd_s }))).unwrap();
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(*mtime);
        std::fs::File::options().write(true).open(&f).unwrap().set_modified(t).unwrap();
    }
    4001
}

fn pi_adopt_cfg(r: &Rig) -> LaunchConfig {
    use crate::launch::profiles::Profile;
    let mut c = launch_cfg(&[&r.work.join("專案")]);
    c.profiles.insert("pi".into(), Profile { label: "pi".into(), command: "pi".into(), args: vec![], engine: "pi".into(), mode: LaunchMode::Window, disabled: false, disabled_reason: String::new() });
    c
}

const SID_A: &str = "aaaaaaaa-1111-2222-3333-444444444444";

#[test]
fn pi_接手_先關舊的_確認結束_才帶session開新的_登記上名單才算成功() {
    let r = rig(Opt::default());
    let pid = put_user_pi(&r, &[(SID_A, NOW)]);
    *r.env.cfg.lock().unwrap() = Ok(pi_adopt_cfg(&r));
    let res = r.run("handover", json!({ "name": format!("pi · MiniMax #{pid}（前景）"), "new_name": "Pi妹妹" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert!(res.detail.contains("原本的 pi 已關閉（終端機留著）"), "{}", res.detail);
    assert_eq!(r.terminated(), vec![4002, 4001], "舊的 pi 與子孫先結束，終端機留著");
    let launched = r.env.pi_launched.lock().unwrap().clone();
    assert_eq!(launched.len(), 1);
    assert_eq!(launched[0].0, "Pi妹妹");
    assert!(launched[0].2.ends_with(&format!("{SID_A}.jsonl")), "帶 --session 接回同一段對話：{}", launched[0].2);
    let v = res.result.unwrap();
    assert_eq!((v["kind"].as_str(), v["session_id"].as_str()), (Some("pi_adopt"), Some(SID_A)));
}

#[test]
fn pi_接手_對話不唯一或還沒講話就拒絕_什麼都不關() {
    let r = rig(Opt::default());
    let pid = put_user_pi(&r, &[(SID_A, NOW), ("bbbbbbbb-1111-2222-3333-444444444444", NOW)]);
    *r.env.cfg.lock().unwrap() = Ok(pi_adopt_cfg(&r));
    let res = r.run("handover", json!({ "name": format!("pi #{pid}（前景）") }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("不只一段對話"), "{}", res.detail);
    assert!(r.terminated().is_empty() && r.env.pi_launched.lock().unwrap().is_empty(), "不唯一：不關也不開");
    let r2 = rig(Opt::default());
    let pid2 = put_user_pi(&r2, &[("cccccccc-1111-2222-3333-444444444444", NOW - 600_000)]);
    *r2.env.cfg.lock().unwrap() = Ok(pi_adopt_cfg(&r2));
    let res = r2.run("handover", json!({ "name": format!("pi #{pid2}（前景）") }));
    assert!(res.detail.contains("先在 pi 裡講一句話"), "還沒講話（對話檔早於啟動）：{}", res.detail);
    assert!(r2.terminated().is_empty());
}

#[test]
fn pi_接手_舊程序沒結束就不開新的() {
    let r = rig(Opt::default());
    let pid = put_user_pi(&r, &[(SID_A, NOW)]);
    *r.env.cfg.lock().unwrap() = Ok(pi_adopt_cfg(&r));
    r.os().immortal.lock().unwrap().insert(4001);
    let res = r.run("handover", json!({ "name": format!("pi #{pid}（前景）") }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("沒有開新的") || res.detail.contains("沒能關掉"), "{}", res.detail);
    assert!(r.env.pi_launched.lock().unwrap().is_empty(), "舊的還活著：不開新的");
}

#[test]
fn pi_接手_新的沒開起來或沒登記上_照實回報並附手動接回的指令() {
    for launch_fails in [true, false] {
        let r = rig(Opt::default());
        let pid = put_user_pi(&r, &[(SID_A, NOW)]);
        *r.env.cfg.lock().unwrap() = Ok(pi_adopt_cfg(&r));
        if launch_fails {
            r.env.pi_launch_fail.store(true, Ordering::SeqCst);
        } else {
            r.env.pi_launch_registers.store(false, Ordering::SeqCst);
        }
        let res = r.run("handover", json!({ "name": format!("pi #{pid}（前景）") }));
        assert_eq!(res.status, "failed");
        assert!(res.detail.contains("原本的 pi 已關閉") && res.detail.contains("pi --session") && res.detail.contains(&format!("{SID_A}.jsonl")), "{}", res.detail);
    }
}

#[test]
fn pi_接手_名字不合規則_資料夾不在白名單_遠端開關關著_都不關() {
    let r = rig(Opt::default());
    let pid = put_user_pi(&r, &[(SID_A, NOW)]);
    *r.env.cfg.lock().unwrap() = Ok(pi_adopt_cfg(&r));
    assert!(r.run("handover", json!({ "name": format!("pi #{pid}（前景）"), "new_name": "-壞" })).detail.contains("新名字"));
    let mut c = pi_adopt_cfg(&r);
    c.cwd_allow = vec![canonical_launch_cwd(&r.handoff.to_string_lossy()).unwrap()];
    *r.env.cfg.lock().unwrap() = Ok(c);
    assert_eq!(r.run("handover", json!({ "name": format!("pi #{pid}（前景）") })).status, "failed", "資料夾不在白名單");
    assert!(r.terminated().is_empty());
    let off = rig(Opt { allow_first: 0, ..Opt::default() });
    assert_eq!(off.run("handover", json!({ "name": "pi #4001（前景）" })).detail, CONSENT_OFF);
}

fn put_pi_proc(r: &Rig, asn_host: bool) -> u32 {
    let os = r.os();
    let parent = if asn_host { 4100 } else { 4200 };
    let mut t = os.table.lock().unwrap();
    t.push(p(parent, 100, "powershell.exe"));
    t.push(p(4001, parent, "node.exe"));
    t.push(p(4002, 4001, "node.exe"));
    t.push(p(4003, parent, "notepad.exe")); // 同一個殼底下的別的程式：同輩，不准碰
    drop(t);
    os.cmd.lock().unwrap().insert(parent, if asn_host { asn_host_cmdline() } else { "powershell.exe".into() });
    os.alive.lock().unwrap().extend([parent, 4001, 4002, 4003]);
    // 啟動時間：殼最早、pi 其次、子程序再晚，都早於登記檔的心跳（NOW）
    os.started.lock().unwrap().extend([(parent, NOW - 120_000), (4001, NOW - 60_000), (4002, NOW - 30_000), (4003, NOW - 50_000)]);
    parent
}

#[test]
fn pi_關閉_使用者自己開的_只結束_pi_與子孫_留下終端機與同輩() {
    let r = rig(Opt::default());
    put_pi_window(&r, "小丙", 4001);
    let shell = put_pi_proc(&r, false);
    let res = r.run("close", json!({ "name": "小丙" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert!(res.detail.contains("終端機分頁會留下"), "{}", res.detail);
    assert_eq!(res.result.unwrap()["kept_terminal"], true);
    let killed = r.terminated();
    assert_eq!(killed, vec![4002, 4001], "子先孫後，只有 pi 與子孫");
    assert!(!killed.contains(&shell) && !killed.contains(&4003) && !killed.contains(&300), "終端機、同輩、ASN 都不碰");
    assert!(r.os().closed.lock().unwrap().is_empty(), "使用者自己開的不送關閉訊息（會把整個終端機關掉）");
}

#[test]
fn pi_關閉_asn_開的_連承載殼一起收() {
    let r = rig(Opt::default());
    put_pi_window(&r, "小丙", 4001);
    let host = put_pi_proc(&r, true);
    let res = r.run("close", json!({ "name": "小丙" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert_eq!(res.detail, "已關閉視窗");
    let killed = r.terminated();
    assert!(killed.contains(&4001) && killed.contains(&4002) && killed.contains(&host), "{killed:?}");
    assert!(!killed.contains(&4003) && !killed.contains(&300));
}

#[test]
fn pi_關閉_登記的_pid_跑的不是_pi_就不動_遠端開關關著也不動() {
    let r = rig(Opt::default());
    put_pi_window(&r, "小丙", 4001);
    r.os().table.lock().unwrap().push(p(4001, 100, "notepad.exe")); // pid 被別的程式重用
    let res = r.run("close", json!({ "name": "小丙" }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("不在執行了"), "{}", res.detail);
    assert!(r.terminated().is_empty());
    let res = r.run("close", json!({ "name": "沒這個" }));
    assert_eq!(res.status, "failed");
    let off = rig(Opt { allow_first: 0, ..Opt::default() });
    put_pi_window(&off, "小丙", 4001);
    put_pi_proc(&off, false);
    assert_eq!(off.run("close", json!({ "name": "小丙" })).detail, CONSENT_OFF);
    assert!(off.terminated().is_empty());
}

#[test]
fn pi_關閉_程序啟動時間晚於最後心跳_或查不到_就不結束() {
    // asn真 審 #433：pi 在心跳後當掉、pid 被別的 node 拿去用時，只看程序名分不出來
    let r = rig(Opt::default());
    put_pi_window(&r, "小丙", 4001);
    put_pi_proc(&r, false);
    r.os().started.lock().unwrap().insert(4001, NOW + 5_000);   // 比心跳晚啟動：不是登記的那個 pi
    let res = r.run("close", json!({ "name": "小丙" }));
    assert_eq!(res.status, "failed");
    assert!(res.detail.contains("對不上"), "{}", res.detail);
    assert!(r.terminated().is_empty(), "一個都不結束");
    r.os().started.lock().unwrap().remove(&4001);   // 查不到啟動時間：寧可關不掉
    let res = r.run("close", json!({ "name": "小丙" }));
    assert_eq!(res.status, "failed");
    assert!(r.terminated().is_empty());
    r.os().started.lock().unwrap().insert(4001, NOW);   // 剛好等於心跳：算數
    assert_eq!(r.run("close", json!({ "name": "小丙" })).status, "ok");
}

#[test]
fn pi_切換模型_pi_正在忙_馬上回已排隊_請求留著等它做完() {
    // 0.2 A3：以前等到逾時回「沒有回應」（畫面說失敗），請求卻留著、之後悄悄生效
    let r = rig(Opt::default());
    put_pi_window(&r, "小丙", 4001);
    let d = r.env.pi_home.join(".asn").join("pi-windows");
    let v = json!({ "v": 1, "engine": "pi", "sessionId": "psid", "name": "小丙", "pid": 4001, "cwd": "D:/g/x", "state": "busy", "at": NOW });
    std::fs::write(d.join("psid.json"), v.to_string()).unwrap();
    *r.env.pi_reply.lock().unwrap() = None;
    let res = r.run("model", json!({ "name": "小丙", "model": "anthropic[claude-sonnet-5]" }));
    assert_eq!(res.status, "ok", "{}", res.detail);
    assert!(res.detail.contains("已排隊"), "{}", res.detail);
    let out = res.result.unwrap();
    assert_eq!((out["queued"].as_bool(), out["model"].as_str(), out["provider"].as_str()), (Some(true), Some("claude-sonnet-5"), Some("anthropic")));
    let ctl = r.env.pi_home.join(".asn").join("pi-control").join("psid");
    let reqs: Vec<_> = std::fs::read_dir(&ctl).unwrap().flatten().filter(|e| !e.file_name().to_string_lossy().ends_with(".result.json")).collect();
    assert_eq!(reqs.len(), 1, "請求留著，pi 閒下來擴充就會處理");
    assert!(r.terminated().is_empty() && r.launched().is_empty());
}
