//! WezTerm 終端的命令層（議題 #285 第一步）。
//! ASN 不渲染終端內容，只替自己開啟的視窗做啟停、送字、讀輸出。
//! 不改名、不接手既有視窗、不判斷忙閒；那些是後續步驟。不接 UI、不進安裝包。
//!
//! 審查約束（主線已有的 wezterm 模組，這裡不繞過）：
//! - 對照表是「自己開的編號 → Window」。Window 帶啟動時量到的 started_ms。呼叫端只能給編號，不能給程序編號或通訊路徑；關閉一律走會核對建立時間的 stop。
//! - 每次 cli 都經模組帶 WEZTERM_UNIX_SOCKET；通訊檔不存在時模組直接拒絕，不會執行 cli。
//! - profile 只准 agy 與 grok。
//!
//! 作業系統介面沿用 wezterm 的 Runner／Fs，測試注入假實作，不會啟動真的 WezTerm。
#![cfg(desktop)]

use super::config::{canonical_launch_cwd, LaunchConfig};
use super::wezterm::{self, Fs, Runner, WezTerm, WezTermDir, Window};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 一次最多從畫面底部往回讀幾行（對應 `get-text --start-line=-N`）。超出就拒絕，避免整份捲動區進記憶體。
pub const MAX_READ_LINES: i32 = 500;
/// 讀回文字的字數上限（超出截斷）。與送字的單行上限是兩件事。
pub const MAX_READ_CHARS: usize = 64_000;
const TRUNC_MARK: &str = "…（已截斷）";

/// `term_list` 的一列。profile／pid／started_ms 留給之後的改名、接手與忙閒判斷，這一步只回傳、不解釋。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermListed {
    pub id: String,
    pub profile: String,
    pub pid: u32,
    pub started_ms: Option<u64>,
}

struct Session {
    id: String,
    profile: String,
    window: Window,
    pane_id: u64,
}

struct SessionSnap {
    window: Window,
    pane_id: u64,
}

struct Inner {
    next: u64,
    sessions: Vec<Session>,
}

enum Source {
    /// 測試直接給資料夾，不讀環境變數
    Fixed(WezTermDir),
    /// 正式：每次用 ASN_WEZTERM_DIR 找隔離副本
    FromEnv,
}

/// 自己開過的終端。只認這張表裡的編號，呼叫端給的其他編號一律拒絕。
pub struct TermService<R, F> {
    source: Source,
    config_file: PathBuf,
    home: PathBuf,
    runner: R,
    fs: F,
    inner: Mutex<Inner>,
}

impl<R: Runner, F: Fs> TermService<R, F> {
    pub fn fixed(dir: WezTermDir, config_file: PathBuf, home: PathBuf, runner: R, fs: F) -> Self {
        Self {
            source: Source::Fixed(dir),
            config_file,
            home,
            runner,
            fs,
            inner: Mutex::new(Inner { next: 0, sessions: Vec::new() }),
        }
    }

    fn from_env(config_file: PathBuf, home: PathBuf, runner: R, fs: F) -> Self {
        Self {
            source: Source::FromEnv,
            config_file,
            home,
            runner,
            fs,
            inner: Mutex::new(Inner { next: 0, sessions: Vec::new() }),
        }
    }

    fn dir(&self) -> Result<WezTermDir, String> {
        match &self.source {
            Source::Fixed(d) => Ok(d.clone()),
            Source::FromEnv => wezterm::locate(&self.fs),
        }
    }

    fn wez(&self, dir: &WezTermDir) -> WezTerm<'_> {
        WezTerm::new(dir.clone(), self.config_file.clone(), self.home.clone(), &self.runner, &self.fs)
    }

    /// 隔離用的 WezTerm 設定。已存在就不覆蓋（避免改到實驗中途寫過的內容）；沒有才寫一份空的，避免吃到使用者的 `~/.wezterm.lua`。
    #[cfg_attr(not(any(feature = "gui", test)), allow(dead_code))]
    fn ensure_config(&self) -> Result<(), String> {
        if self.config_file.is_file() {
            return Ok(());
        }
        if let Some(parent) = self.config_file.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("無法建立終端設定資料夾：{e}"))?;
            }
        }
        std::fs::write(&self.config_file, "return {}\n").map_err(|e| format!("無法建立隔離的 WezTerm 設定：{e}"))
    }

    /// 開一個終端。profile 只准 agy／grok，執行檔與工作資料夾都來自既有啟動設定，不接受呼叫端指定的指令。
    pub fn start(&self, profile: &str, cwd: &str, config: &LaunchConfig) -> Result<String, String> {
        let command = resolve_command(profile, config)?;
        let cwd = authorize_cwd(config, cwd)?;
        let dir = self.dir()?;
        let w = self.wez(&dir);
        let win = w.start(&cwd, &[command])?;
        let panes = match w.list(&win.sock) {
            Ok(p) if !p.is_empty() => p,
            Ok(_) => return fail_close(&w, &win, "WezTerm 視窗裡沒有可操作的窗格".into()),
            Err(e) => return fail_close(&w, &win, e),
        };
        let pane_id = panes.iter().find(|p| p.is_active).map(|p| p.pane_id).unwrap_or(panes[0].pane_id);
        let mut g = self.inner.lock().unwrap();
        g.next += 1;
        let id = g.next.to_string();
        g.sessions.push(Session { id: id.clone(), profile: profile.to_string(), window: win, pane_id });
        Ok(id)
    }

    pub fn send(&self, id: &str, text: &str, enter: bool) -> Result<(), String> {
        let snap = self.snapshot(id)?;
        let dir = self.dir()?;
        let w = self.wez(&dir);
        if enter {
            w.send_line_and_enter(&snap.window.sock, snap.pane_id, text)
        } else {
            w.send_line(&snap.window.sock, snap.pane_id, text)
        }
    }

    /// `lines` 是從畫面底部往回讀的行數，範圍 1..=MAX_READ_LINES。回傳再截到字數上限。
    pub fn read(&self, id: &str, lines: i32) -> Result<String, String> {
        let snap = self.snapshot(id)?;
        if !(1..=MAX_READ_LINES).contains(&lines) {
            return Err(format!("讀取行數必須介於 1 到 {MAX_READ_LINES}"));
        }
        let dir = self.dir()?;
        let w = self.wez(&dir);
        let text = w.get_text(&snap.window.sock, snap.pane_id, Some(-lines))?;
        Ok(cap_output(&text))
    }

    pub fn list(&self) -> Vec<TermListed> {
        let g = self.inner.lock().unwrap();
        g.sessions
            .iter()
            .map(|s| TermListed {
                id: s.id.clone(),
                profile: s.profile.clone(),
                pid: s.window.gui_pid,
                started_ms: s.window.started_ms,
            })
            .collect()
    }

    /// 結束自己開的視窗。只拿對照表裡的 Window 交給 wezterm::stop（裡面核對 started_ms），不接受呼叫端傳入的程序編號。
    /// 成功（含視窗早已不在）才從表上移除；建立時間對不上就保留編號，方便呼叫端知道沒關掉。
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let snap = self.snapshot(id)?;
        let dir = self.dir()?;
        let w = self.wez(&dir);
        w.stop(&snap.window)?;
        let mut g = self.inner.lock().unwrap();
        g.sessions.retain(|s| s.id != id);
        Ok(())
    }

    fn snapshot(&self, id: &str) -> Result<SessionSnap, String> {
        let g = self.inner.lock().unwrap();
        g.sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| SessionSnap { window: s.window.clone(), pane_id: s.pane_id })
            .ok_or_else(|| "沒有這個終端（只能操作這次由 ASN 開啟的）".to_string())
    }
}

/// 啟動設定裡 agy 的編號是 gemini（執行檔才是 agy），grok 的編號就是 grok。
/// 白名單只寫在這一段：其他名稱會對上啟動設定裡的同名項目，所以必須在這裡擋下。
fn resolve_command(profile: &str, config: &LaunchConfig) -> Result<String, String> {
    if profile != "agy" && profile != "grok" {
        return Err("終端只允許 agy 與 grok，不能指定其他指令".into());
    }
    let key = match profile {
        "agy" => "gemini",
        "grok" => "grok",
        other => other,
    };
    let prof = config.profiles.get(key).ok_or_else(|| format!("這台電腦的啟動設定裡沒有 {profile}"))?;
    if prof.disabled {
        return Err(if prof.disabled_reason.is_empty() { format!("{profile} 目前無法啟動") } else { prof.disabled_reason.clone() });
    }
    let command = prof.command.trim();
    if command.is_empty() {
        return Err(format!("啟動設定裡沒有 {profile} 的執行檔"));
    }
    if command.chars().any(|c| c.is_control()) {
        return Err("啟動設定裡的執行檔路徑不合法".into());
    }
    // 檔名必須就是這個 profile（agy.exe／agy.cmd／grok 可以，cmd.exe 不行）。
    // grok 啟動設定的參數是內建通道的 agent stdio，不是終端互動，這裡只拿執行檔、不帶那些參數。
    if binary_stem(command) != profile {
        return Err(format!("啟動設定裡的執行檔不是 {profile}，已拒絕"));
    }
    Ok(command.to_string())
}

/// 檔名主檔（去掉資料夾與副檔名），路徑分隔線兩種都認，測試在 Linux 上也能驗 Windows 路徑。
fn binary_stem(command: &str) -> String {
    let name = command.trim().rsplit(['/', '\\']).next().unwrap_or("");
    name.split('.').next().unwrap_or("").to_ascii_lowercase()
}

/// 與開新夥伴同一套：空白拒絕、必須在 cwd_allow、必須是存在的資料夾。不做「子資料夾也算」的放寬。
fn authorize_cwd(config: &LaunchConfig, cwd: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return Err("工作資料夾不在允許清單裡".into());
    }
    let canon = canonical_launch_cwd(cwd)?;
    if !config.cwd_allow.iter().any(|p| p == &canon) {
        return Err("工作資料夾不在允許清單裡".into());
    }
    if !canon.is_dir() {
        return Err(format!("工作資料夾不存在：{cwd}"));
    }
    Ok(canon)
}

fn cap_output(text: &str) -> String {
    if text.chars().count() <= MAX_READ_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_READ_CHARS).collect();
    out.push_str(TRUNC_MARK);
    out
}

fn fail_close(w: &WezTerm<'_>, win: &Window, why: String) -> Result<String, String> {
    match w.stop(win) {
        Ok(()) => Err(why),
        Err(e) => Err(format!("{why}（結束剛啟動的視窗也失敗：{e}）")),
    }
}

// 下面這段才是 Tauri 指令要的型別與正式進入點。核心邏輯在上面，測試不經過 Tauri。

#[cfg(feature = "gui")]
pub type LiveTerms = TermService<wezterm::RealRunner, wezterm::RealFs>;

#[cfg(feature = "gui")]
pub fn live(data_dir: &Path) -> LiveTerms {
    TermService::from_env(data_dir.join("wezterm-term.lua"), crate::identity::home_dir(), wezterm::RealRunner, wezterm::RealFs)
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermStartReq {
    pub profile: String,
    pub cwd: String,
}

#[cfg(feature = "gui")]
#[derive(Debug, Serialize)]
pub struct TermStarted {
    pub id: String,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermSendReq {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub enter: bool,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermReadReq {
    pub id: String,
    pub lines: i32,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermStopReq {
    pub id: String,
}

/// 正式路徑：讀啟動設定、沿用本機資料夾授權，再交給 TermService。
#[cfg(feature = "gui")]
pub fn start_live(terms: &LiveTerms, profile: &str, cwd: &str, data_dir: &Path) -> Result<TermStarted, String> {
    let mut config = super::config::load_launch_config()?;
    super::cwds::grant_local_cwd(&mut config, cwd, &crate::identity::home_dir(), data_dir)?;
    terms.ensure_config()?;
    let id = terms.start(profile, cwd, &config)?;
    Ok(TermStarted { id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::profiles::{LaunchMode, Profile};
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap, HashSet};
    use std::rc::Rc;
    use std::time::Duration;

    struct FakeFs {
        files: Rc<RefCell<HashSet<PathBuf>>>,
    }
    impl Fs for FakeFs {
        fn exists(&self, p: &Path) -> bool {
            self.files.borrow().contains(p)
        }
    }

    struct FakeInner {
        calls: RefCell<Vec<(Vec<String>, BTreeMap<String, String>)>>,
        started: RefCell<Vec<Option<u64>>>,
        tree_killed: RefCell<Vec<u32>>,
        list_json: RefCell<String>,
        screen: RefCell<String>,
        sleeps: RefCell<Vec<Duration>>,
    }

    #[derive(Clone)]
    struct FakeRunner {
        inner: Rc<FakeInner>,
    }
    impl FakeRunner {
        fn args(&self) -> Vec<Vec<String>> {
            self.inner.calls.borrow().iter().map(|(a, _)| a.clone()).collect()
        }
        fn killed(&self) -> Vec<u32> {
            self.inner.tree_killed.borrow().clone()
        }
    }
    impl Runner for FakeRunner {
        fn run(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>, _timeout: Duration) -> Result<wezterm::RunOutput, String> {
            self.inner.calls.borrow_mut().push((args.to_vec(), env.clone()));
            let stdout = if args.iter().any(|a| a == "list") {
                self.inner.list_json.borrow().clone()
            } else if args.iter().any(|a| a == "get-text") {
                self.inner.screen.borrow().clone()
            } else {
                String::new()
            };
            Ok(wezterm::RunOutput { success: true, stdout, stderr: String::new() })
        }
        fn spawn(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
            self.inner.calls.borrow_mut().push((args.to_vec(), env.clone()));
            Ok(42)
        }
        fn kill_tree(&self, pid: u32) {
            self.inner.tree_killed.borrow_mut().push(pid);
        }
        fn started_ms(&self, _pid: u32) -> Option<u64> {
            let mut q = self.inner.started.borrow_mut();
            if q.is_empty() { Some(1_000) } else { q.remove(0) }
        }
        fn sleep(&self, d: Duration) {
            self.inner.sleeps.borrow_mut().push(d);
        }
    }

    fn profile(command: &str, args: Vec<String>) -> Profile {
        Profile {
            label: command.into(),
            command: command.into(),
            args,
            engine: String::new(),
            mode: LaunchMode::Window,
            disabled: false,
            disabled_reason: String::new(),
        }
    }

    fn default_profiles() -> HashMap<String, Profile> {
        let mut m = HashMap::new();
        // 陷阱：編號 agy 若被直接拿來用，會開到 cmd。正確對照是 gemini → agy 執行檔。
        m.insert("agy".into(), profile(r"C:\Windows\System32\cmd.exe", vec![]));
        m.insert("gemini".into(), profile("C:/bin/agy.exe", vec![]));
        m.insert("grok".into(), profile("C:/bin/grok.exe", vec!["agent".into(), "stdio".into()]));
        m.insert("claude".into(), profile("C:/bin/claude.exe", vec!["--dangerously-skip-permissions".into()]));
        m
    }

    struct Rig {
        _dir: tempfile::TempDir,
        cwd: String,
        config: LaunchConfig,
        svc: TermService<FakeRunner, FakeFs>,
        runner: FakeRunner,
        files: Rc<RefCell<HashSet<PathBuf>>>,
    }

    fn sock() -> PathBuf {
        wezterm::sock_path(Path::new("H"), 42)
    }

    fn make(profiles: HashMap<String, Profile>, started: Vec<Option<u64>>) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let canon = canonical_launch_cwd(&dir.path().to_string_lossy()).unwrap();
        let cwd = canon.to_string_lossy().into_owned();
        let config = LaunchConfig { profiles, cwd_allow: vec![canon], max_per_hour: 6 };
        let files = Rc::new(RefCell::new(HashSet::from([sock()])));
        let fs = FakeFs { files: files.clone() };
        let runner = FakeRunner {
            inner: Rc::new(FakeInner {
                calls: RefCell::new(Vec::new()),
                started: RefCell::new(started),
                tree_killed: RefCell::new(Vec::new()),
                list_json: RefCell::new(r#"[{"pane_id":7,"tab_id":1,"is_active":true}]"#.to_string()),
                screen: RefCell::new("畫面一行".into()),
                sleeps: RefCell::new(Vec::new()),
            }),
        };
        let view = runner.clone();
        let svc = TermService::fixed(
            WezTermDir { gui: "W/wezterm-gui.exe".into(), cli: "W/wezterm.exe".into() },
            "cfg.lua".into(),
            "H".into(),
            runner,
            fs,
        );
        Rig { _dir: dir, cwd, config, svc, runner: view, files }
    }

    /// 每條 cli 都要帶上這個視窗的通訊檔。gui 的 start 不是 cli，不在這裡。
    fn assert_cli_uses_socket(r: &FakeRunner) {
        let expect = sock().to_string_lossy().into_owned();
        let calls = r.inner.calls.borrow();
        let cli: Vec<_> = calls.iter().filter(|(a, _)| a.first().map(|s| s == "cli").unwrap_or(false)).collect();
        assert!(!cli.is_empty(), "至少要有一次 cli");
        for (args, env) in cli {
            assert_eq!(env.get("WEZTERM_UNIX_SOCKET").map(String::as_str), Some(expect.as_str()), "cli 未帶通訊檔：{args:?}");
        }
    }

    fn started_args(r: &FakeRunner) -> Vec<Vec<String>> {
        r.args().into_iter().filter(|a| a.first().map(|s| s == "start").unwrap_or(false)).collect()
    }

    #[test]
    fn 執行檔檔名只認_agy_與_grok() {
        assert_eq!(binary_stem("C:/bin/agy.exe"), "agy");
        assert_eq!(binary_stem("agy.cmd"), "agy");
        assert_eq!(binary_stem(r"D:\tools\grok.exe"), "grok");
        assert_eq!(binary_stem("grok"), "grok");
        assert_eq!(binary_stem(r"C:\Windows\System32\cmd.exe"), "cmd");
        assert_ne!(binary_stem("C:/bin/claude.exe"), "agy");
    }

    #[test]
    fn 非白名單拒絕且不啟動() {
        let rig = make(default_profiles(), vec![]);
        for name in ["claude", "gemini", "cmd", "Grok", ""] {
            let err = rig.svc.start(name, &rig.cwd, &rig.config).unwrap_err();
            assert!(err.contains("只允許 agy 與 grok"), "{name}: {err}");
        }
        assert!(started_args(&rig.runner).is_empty(), "白名單被拿掉時，啟動設定裡的 claude 會被執行");
        let mut disabled = default_profiles();
        disabled.get_mut("grok").unwrap().disabled = true;
        disabled.get_mut("grok").unwrap().disabled_reason = "維修中".into();
        let rig = make(disabled, vec![]);
        let err = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap_err();
        assert!(err.contains("維修中"), "{err}");
        assert!(started_args(&rig.runner).is_empty());
    }

    #[test]
    fn 執行檔不是對應程式就拒絕且不啟動() {
        let mut profiles = default_profiles();
        profiles.insert("gemini".into(), profile(r"C:\Windows\System32\cmd.exe", vec!["/c".into(), "calc".into()]));
        let rig = make(profiles, vec![]);
        let err = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap_err();
        assert!(err.contains("不是 agy"), "{err}");
        assert!(started_args(&rig.runner).is_empty(), "檔名核對被拿掉時，cmd.exe 會被啟動");
    }

    #[test]
    fn 工作資料夾不在允許清單就拒絕且不啟動() {
        let rig = make(default_profiles(), vec![]);
        let outside = tempfile::tempdir().unwrap();
        let outside = canonical_launch_cwd(&outside.path().to_string_lossy()).unwrap();
        let err = rig.svc.start("agy", &outside.to_string_lossy(), &rig.config).unwrap_err();
        assert!(err.contains("不在允許清單"), "{err}");
        assert!(rig.svc.start("agy", "  ", &rig.config).unwrap_err().contains("不在允許清單"));
        assert!(started_args(&rig.runner).is_empty(), "資料夾授權被拿掉時，清單外的資料夾也會啟動");
    }

    #[test]
    fn 開啟_agy_與_grok_只用啟動設定找到的執行檔並可列出() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        let id2 = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        assert_ne!(id, id2);
        let starts = started_args(&rig.runner);
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0], vec!["start", "--always-new-process", "--cwd", rig.cwd.as_str(), "--", "C:/bin/agy.exe"]);
        assert_eq!(starts[1], vec!["start", "--always-new-process", "--cwd", rig.cwd.as_str(), "--", "C:/bin/grok.exe"]);
        assert!(!starts.iter().any(|a| a.iter().any(|x| x == "agent" || x == "stdio" || x.contains("cmd.exe"))), "不帶內建通道參數，也不走陷阱編號 agy 的 cmd");
        let calls = rig.runner.inner.calls.borrow();
        assert_eq!(calls[0].1.get("WEZTERM_CONFIG_FILE").map(String::as_str), Some("cfg.lua"));
        let listed = rig.svc.list();
        assert_eq!(
            listed,
            vec![
                TermListed { id: id.clone(), profile: "agy".into(), pid: 42, started_ms: Some(1_000) },
                TermListed { id: id2, profile: "grok".into(), pid: 42, started_ms: Some(1_000) },
            ]
        );
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(json["id"], id);
        assert_eq!(json["profile"], "agy");
        assert_eq!(json["pid"], 42);
        assert_eq!(json["started_ms"], 1_000);
        assert_cli_uses_socket(&rig.runner);
    }

    #[test]
    fn 通訊檔不見就拒絕送字與讀取且不執行_cli() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        assert_cli_uses_socket(&rig.runner);
        let before = rig.runner.args().len();
        assert!(rig.files.borrow_mut().remove(&sock()));
        let send = rig.svc.send(&id, "不該送出", true).unwrap_err();
        let read = rig.svc.read(&id, 10).unwrap_err();
        assert!(send.contains("通訊檔不存在"), "{send}");
        assert!(read.contains("通訊檔不存在"), "{read}");
        assert_eq!(rig.runner.args().len(), before, "通訊檔不存在時不可執行 cli");
        // 關閉不走 cli，仍用對照表裡的 Window 核對建立時間
        rig.svc.stop(&id).unwrap();
        assert!(rig.svc.list().is_empty());
        assert_eq!(rig.runner.killed(), vec![42]);
    }

    #[test]
    fn 指令只收自己的編號_不能傳程序編號或通訊路徑() {
        let src = include_str!("term.rs");
        let lib = include_str!("../lib.rs");
        for name in ["TermStartReq", "TermSendReq", "TermReadReq", "TermStopReq"] {
            let marker = format!("struct {name}");
            let rest = src.split(&marker).nth(1).unwrap_or_else(|| panic!("找不到 {name}"));
            let body = rest.split('}').next().unwrap();
            assert!(!body.contains("pid") && !body.contains("sock") && !body.contains("gui_pid"), "{name} 不收程序編號或通訊路徑：{body}");
        }
        assert!(lib.contains("terms.stop(&req.id)"), "關閉只把編號交給 stop");
        assert!(!lib.contains("kill_tree"), "命令層不自己結束行程");
    }

    #[test]
    fn 未知編號拒絕且不送不讀不結束() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        let before = rig.runner.args().len();
        for op in [
            rig.svc.send("999", "你好", true).unwrap_err(),
            rig.svc.read("999", 10).unwrap_err(),
            rig.svc.stop("999").unwrap_err(),
        ] {
            assert!(op.contains("沒有這個終端"), "{op}");
        }
        assert_eq!(rig.runner.args().len(), before, "未知編號不可呼叫 WezTerm");
        assert!(rig.runner.killed().is_empty());
        rig.svc.send(&id, "仍可送自己的", false).unwrap();
    }

    #[test]
    fn 送字可選擇是否另送換行鍵且換行先壓成單行() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.send(&id, "第一行\n第二行", false).unwrap();
        rig.svc.send(&id, "請只回覆 OK", true).unwrap();
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].last().map(String::as_str), Some("第一行 第二行"));
        assert_eq!(sent[1].last().map(String::as_str), Some("請只回覆 OK"));
        assert_eq!(sent[2].last().map(String::as_str), Some("\r"));
        assert_eq!(rig.runner.inner.sleeps.borrow().len(), 1, "有 Enter 才在兩次之間等待");
    }

    #[test]
    fn 讀取行數超出範圍拒絕且不讀() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        let before = rig.runner.args().len();
        for n in [0, -1, MAX_READ_LINES + 1, i32::MAX] {
            let err = rig.svc.read(&id, n).unwrap_err();
            assert!(err.contains("讀取行數"), "{n}: {err}");
        }
        assert_eq!(rig.runner.args().len(), before, "行數上限被拿掉時會去呼叫 get-text");
        assert_eq!(rig.svc.read(&id, 1).unwrap(), "畫面一行");
        assert_eq!(rig.svc.read(&id, MAX_READ_LINES).unwrap(), "畫面一行");
        let gets: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "get-text")).collect();
        assert_eq!(gets[0], vec!["cli", "get-text", "--pane-id", "7", "--start-line=-1"]);
        assert!(gets[1].iter().any(|a| a == &format!("--start-line=-{MAX_READ_LINES}")));
    }

    #[test]
    fn 讀回超過長度上限會截斷() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = "字".repeat(MAX_READ_CHARS + 20);
        let text = rig.svc.read(&id, 3).unwrap();
        assert!(text.ends_with(TRUNC_MARK), "長度上限被拿掉時不會出現截斷註記");
        assert_eq!(text.chars().count(), MAX_READ_CHARS + TRUNC_MARK.chars().count());
        assert!(text.chars().filter(|c| *c == '字').count() == MAX_READ_CHARS);
        *rig.runner.inner.screen.borrow_mut() = "字".repeat(MAX_READ_CHARS);
        let exact = rig.svc.read(&id, 3).unwrap();
        assert_eq!(exact.chars().count(), MAX_READ_CHARS);
        assert!(!exact.contains("已截斷"));
    }

    #[test]
    fn 停止成功後編號移除_失敗則保留且不結束() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.stop(&id).unwrap();
        assert!(rig.svc.list().is_empty(), "停止成功後編號要移除");
        assert!(rig.svc.send(&id, "x", false).unwrap_err().contains("沒有這個終端"));
        assert!(rig.svc.stop(&id).unwrap_err().contains("沒有這個終端"));
        assert_eq!(rig.runner.killed(), vec![42]);

        let rig = make(default_profiles(), vec![Some(1_000), Some(2_000)]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        let err = rig.svc.stop(&id).unwrap_err();
        assert!(err.contains("別的程序"), "{err}");
        assert_eq!(rig.svc.list().len(), 1, "結束被拒絕時編號要留著");
        assert_eq!(rig.svc.list()[0].id, id);
        assert!(rig.runner.killed().is_empty(), "建立時間不同不可結束");

        let rig = make(default_profiles(), vec![Some(1_000), None]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.stop(&id).unwrap();
        assert!(rig.svc.list().is_empty(), "視窗早已不在也要移除編號");
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn 視窗沒有窗格時不留下編號並結束剛啟動的視窗() {
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = "[]".into();
        let err = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap_err();
        assert!(err.contains("沒有可操作的窗格"), "{err}");
        assert!(rig.svc.list().is_empty());
        assert_eq!(rig.runner.killed(), vec![42]);
    }

    #[test]
    fn 隔離設定檔只在缺少時建立且不覆蓋() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wezterm-term.lua");
        let fs = FakeFs { files: Rc::new(RefCell::new(HashSet::new())) };
        let runner = FakeRunner {
            inner: Rc::new(FakeInner {
                calls: RefCell::new(Vec::new()),
                started: RefCell::new(vec![]),
                tree_killed: RefCell::new(Vec::new()),
                list_json: RefCell::new("[]".into()),
                screen: RefCell::new(String::new()),
                sleeps: RefCell::new(Vec::new()),
            }),
        };
        let svc = TermService::fixed(WezTermDir { gui: "W/wezterm-gui.exe".into(), cli: "W/wezterm.exe".into() }, path.clone(), "H".into(), runner, fs);
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return {}\n");
        std::fs::write(&path, "return { kept = true }\n").unwrap();
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return { kept = true }\n", "已存在的隔離設定不可覆蓋");
    }
}
