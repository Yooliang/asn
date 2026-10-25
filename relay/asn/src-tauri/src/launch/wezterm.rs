//! WezTerm 控制模組（議題 #280 原型）：啟動視窗、用 `wezterm cli` 讀畫面與單行注入。
//! 只有控制邏輯，不接 UI、不進安裝包；不自動下載 WezTerm。
//! 作業系統介面（執行外部程式、檔案檢查）用 trait 注入，測試不會啟動真的 WezTerm。
#![cfg(desktop)]

use crate::nowin::NoWindow;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DIR_ENV: &str = "ASN_WEZTERM_DIR";
pub const CLI_TIMEOUT: Duration = Duration::from_secs(15);
pub const SOCK_WAIT: Duration = Duration::from_secs(15);
pub const ENTER_DELAY: Duration = Duration::from_millis(150);
pub const MAX_LINE_CHARS: usize = 4000;
const TRUNC_MARK: &str = "…（已截斷）";

/// 外部程式的執行結果
#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// 執行外部程式的介面
pub trait Runner {
    /// 執行並等待；逾時要結束子行程並回錯誤
    fn run(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<RunOutput, String>;
    /// 啟動後不等待，回傳行程編號
    fn spawn(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String>;
    fn sleep(&self, d: Duration);
}

/// 檔案檢查介面
pub trait Fs {
    fn exists(&self, p: &Path) -> bool;
}

pub struct RealFs;
impl Fs for RealFs {
    fn exists(&self, p: &Path) -> bool {
        p.exists()
    }
}

pub struct RealRunner;
impl Runner for RealRunner {
    fn run(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<RunOutput, String> {
        let mut cmd = Command::new(program);
        cmd.no_window().args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("無法執行 {}：{e}", program.display()))?;
        let mut out = child.stdout.take();
        let mut err = child.stderr.take();
        let t_out = std::thread::spawn(move || {
            let mut s = Vec::new();
            if let Some(o) = out.as_mut() { let _ = o.read_to_end(&mut s); }
            s
        });
        let t_err = std::thread::spawn(move || {
            let mut s = Vec::new();
            if let Some(o) = err.as_mut() { let _ = o.read_to_end(&mut s); }
            s
        });
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(st)) => {
                    let so = t_out.join().unwrap_or_default();
                    let se = t_err.join().unwrap_or_default();
                    return Ok(RunOutput {
                        success: st.success(),
                        stdout: String::from_utf8_lossy(&so).into_owned(),
                        stderr: String::from_utf8_lossy(&se).into_owned(),
                    });
                }
                Ok(None) => {
                    if start.elapsed() >= timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("WezTerm 指令逾時（{} 秒），已結束該子行程", timeout.as_secs()));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => return Err(format!("等待子行程失敗：{e}")),
            }
        }
    }

    fn spawn(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        let mut cmd = Command::new(program);
        cmd.no_window().args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("無法啟動 {}：{e}", program.display()))?;
        Ok(child.id())
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

/// 找到的 WezTerm 資料夾
#[derive(Debug, Clone)]
pub struct WezTermDir {
    pub gui: PathBuf,
    pub cli: PathBuf,
}

const NOT_FOUND: &str = "找不到 WezTerm，請設定 ASN_WEZTERM_DIR（原型階段只用開發機上的隔離副本）";

/// 依環境變數 ASN_WEZTERM_DIR 找 WezTerm；不自動下載
pub fn locate(fs: &dyn Fs) -> Result<WezTermDir, String> {
    locate_from(std::env::var_os(DIR_ENV).map(PathBuf::from), fs)
}

pub fn locate_from(dir: Option<PathBuf>, fs: &dyn Fs) -> Result<WezTermDir, String> {
    let dir = dir.filter(|d| !d.as_os_str().is_empty()).ok_or_else(|| NOT_FOUND.to_string())?;
    let gui = dir.join("wezterm-gui.exe");
    let cli = dir.join("wezterm.exe");
    if !fs.exists(&gui) || !fs.exists(&cli) {
        return Err(NOT_FOUND.to_string());
    }
    Ok(WezTermDir { gui, cli })
}

/// 啟動後的視窗資訊
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub gui_pid: u32,
    pub sock: PathBuf,
}

pub fn sock_path(home: &Path, gui_pid: u32) -> PathBuf {
    home.join(".local").join("share").join("wezterm").join(format!("gui-sock-{gui_pid}"))
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PaneInfo {
    pub pane_id: u64,
    pub tab_id: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub cursor_x: i64,
    #[serde(default)]
    pub cursor_y: i64,
    #[serde(default)]
    pub is_active: bool,
}

/// 把訊息壓成單行：換行（含 \r\n）換成一個空格，去掉其他控制字元（含 ESC），超過 4000 字截斷
pub fn flatten_line(text: &str) -> String {
    let mut out = String::new();
    let mut prev_nl = false;
    for c in text.chars() {
        if c == '\n' || c == '\r' {
            if !prev_nl {
                out.push(' ');
            }
            prev_nl = true;
        } else if c.is_control() {
            // 丟棄；不影響換行合併狀態
        } else {
            prev_nl = false;
            out.push(c);
        }
    }
    if out.chars().count() > MAX_LINE_CHARS {
        let mut t: String = out.chars().take(MAX_LINE_CHARS).collect();
        t.push_str(TRUNC_MARK);
        t
    } else {
        out
    }
}

/// 控制器：持有注入的 Runner、Fs 與延遲設定
pub struct WezTerm<'a> {
    pub dir: WezTermDir,
    pub config_file: PathBuf,
    pub home: PathBuf,
    pub runner: &'a dyn Runner,
    pub fs: &'a dyn Fs,
    pub cli_timeout: Duration,
    pub sock_wait: Duration,
    pub enter_delay: Duration,
}

impl<'a> WezTerm<'a> {
    pub fn new(dir: WezTermDir, config_file: PathBuf, home: PathBuf, runner: &'a dyn Runner, fs: &'a dyn Fs) -> Self {
        Self { dir, config_file, home, runner, fs, cli_timeout: CLI_TIMEOUT, sock_wait: SOCK_WAIT, enter_delay: ENTER_DELAY }
    }

    /// 家目錄用 identity::home_dir
    pub fn with_default_home(dir: WezTermDir, config_file: PathBuf, runner: &'a dyn Runner, fs: &'a dyn Fs) -> Self {
        Self::new(dir, config_file, crate::identity::home_dir(), runner, fs)
    }

    fn config_env(&self) -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        m.insert("WEZTERM_CONFIG_FILE".to_string(), self.config_file.to_string_lossy().into_owned());
        m
    }

    /// 啟動新視窗並等 socket 檔出現
    pub fn start(&self, cwd: &Path, command: &[String]) -> Result<Window, String> {
        if command.is_empty() {
            return Err("沒有指定要執行的指令".to_string());
        }
        let mut args: Vec<String> = vec![
            "start".into(),
            "--always-new-process".into(),
            "--cwd".into(),
            cwd.to_string_lossy().into_owned(),
            "--".into(),
        ];
        args.extend(command.iter().cloned());
        let gui_pid = self.runner.spawn(&self.dir.gui, &args, &self.config_env())?;
        let sock = sock_path(&self.home, gui_pid);
        let start = Instant::now();
        let step = Duration::from_millis(100);
        loop {
            if self.fs.exists(&sock) {
                return Ok(Window { gui_pid, sock });
            }
            if start.elapsed() >= self.sock_wait {
                return Err(format!("等了 {} 秒，WezTerm 的通訊檔仍未出現：{}", self.sock_wait.as_secs(), sock.display()));
            }
            self.runner.sleep(step);
        }
    }

    /// 執行 `wezterm.exe cli ...`。socket 不存在時絕不執行（否則 cli 會卡住並悄悄啟動 mux-server）
    fn cli(&self, sock: &Path, args: &[String]) -> Result<String, String> {
        if !self.fs.exists(sock) {
            return Err(format!("WezTerm 通訊檔不存在（視窗可能已關閉）：{}", sock.display()));
        }
        let mut env = self.config_env();
        env.insert("WEZTERM_UNIX_SOCKET".to_string(), sock.to_string_lossy().into_owned());
        let mut full: Vec<String> = vec!["cli".into()];
        full.extend(args.iter().cloned());
        let out = self.runner.run(&self.dir.cli, &full, &env, self.cli_timeout)?;
        if !out.success {
            return Err(format!("WezTerm cli 失敗：{}", out.stderr.trim()));
        }
        Ok(out.stdout)
    }

    pub fn list(&self, sock: &Path) -> Result<Vec<PaneInfo>, String> {
        let s = self.cli(sock, &["list".into(), "--format".into(), "json".into()])?;
        serde_json::from_str(&s).map_err(|e| format!("無法解析 WezTerm 清單：{e}"))
    }

    /// 在視窗內開新分頁，回傳新 pane 編號
    pub fn spawn(&self, sock: &Path, cwd: &Path, command: &[String]) -> Result<u64, String> {
        let mut args: Vec<String> = vec!["spawn".into(), "--cwd".into(), cwd.to_string_lossy().into_owned()];
        if !command.is_empty() {
            args.push("--".into());
            args.extend(command.iter().cloned());
        }
        let s = self.cli(sock, &args)?;
        s.trim().parse::<u64>().map_err(|_| format!("無法解析新 pane 編號：{}", s.trim()))
    }

    pub fn get_text(&self, sock: &Path, pane_id: u64, start_line: Option<i32>) -> Result<String, String> {
        let mut args: Vec<String> = vec!["get-text".into(), "--pane-id".into(), pane_id.to_string()];
        if let Some(n) = start_line {
            args.push(format!("--start-line={n}"));
        }
        self.cli(sock, &args)
    }

    /// 送一行文字（不含 Enter）：先壓成單行，用 --no-paste
    pub fn send_line(&self, sock: &Path, pane_id: u64, text: &str) -> Result<(), String> {
        let line = flatten_line(text);
        self.send_raw(sock, pane_id, &line)
    }

    /// Enter 另外單獨送（--no-paste 送 "\r"）
    pub fn send_enter(&self, sock: &Path, pane_id: u64) -> Result<(), String> {
        self.send_raw(sock, pane_id, "\r")
    }

    fn send_raw(&self, sock: &Path, pane_id: u64, text: &str) -> Result<(), String> {
        let args = vec![
            "send-text".to_string(),
            "--pane-id".into(),
            pane_id.to_string(),
            "--no-paste".into(),
            text.to_string(),
        ];
        self.cli(sock, &args).map(|_| ())
    }

    /// 送一行文字，等一下再單獨送 Enter
    pub fn send_line_and_enter(&self, sock: &Path, pane_id: u64, text: &str) -> Result<(), String> {
        self.send_line(sock, pane_id, text)?;
        self.runner.sleep(self.enter_delay);
        self.send_enter(sock, pane_id)
    }

    /// 送「請讀 <路徑> 的內容並照辦」一行提示；路徑不得有換行與控制字元
    pub fn send_file_pointer(&self, sock: &Path, pane_id: u64, file: &Path) -> Result<(), String> {
        let p = file.to_string_lossy();
        if p.is_empty() || p.chars().any(|c| c.is_control()) {
            return Err("檔案路徑含有換行或控制字元，已拒絕".to_string());
        }
        self.send_line(sock, pane_id, &format!("請讀 {p} 的內容並照辦"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashSet;

    #[derive(Default)]
    struct FakeFs {
        files: RefCell<HashSet<PathBuf>>,
    }
    impl Fs for FakeFs {
        fn exists(&self, p: &Path) -> bool {
            self.files.borrow().contains(p)
        }
    }

    #[derive(Default)]
    struct FakeRunner {
        calls: RefCell<Vec<(Vec<String>, BTreeMap<String, String>)>>,
        sleeps: RefCell<Vec<Duration>>,
        stdout: RefCell<String>,
        timeout_err: bool,
        killed: RefCell<bool>,
        spawn_pid: u32,
    }
    impl Runner for FakeRunner {
        fn run(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<RunOutput, String> {
            self.calls.borrow_mut().push((args.to_vec(), env.clone()));
            if self.timeout_err {
                *self.killed.borrow_mut() = true;
                return Err(format!("WezTerm 指令逾時（{} 秒），已結束該子行程", timeout.as_secs()));
            }
            Ok(RunOutput { success: true, stdout: self.stdout.borrow().clone(), stderr: String::new() })
        }
        fn spawn(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
            self.calls.borrow_mut().push((args.to_vec(), env.clone()));
            Ok(self.spawn_pid)
        }
        fn sleep(&self, d: Duration) {
            self.sleeps.borrow_mut().push(d);
        }
    }

    fn dirs() -> WezTermDir {
        WezTermDir { gui: "W/wezterm-gui.exe".into(), cli: "W/wezterm.exe".into() }
    }
    fn sock() -> PathBuf {
        PathBuf::from("H/gui-sock-1")
    }
    fn wez<'a>(r: &'a FakeRunner, fs: &'a FakeFs) -> WezTerm<'a> {
        let mut w = WezTerm::new(dirs(), "cfg.lua".into(), "H".into(), r, fs);
        w.sock_wait = Duration::from_millis(300);
        w
    }
    fn fs_with_sock() -> FakeFs {
        let fs = FakeFs::default();
        fs.files.borrow_mut().insert(sock());
        fs
    }

    #[test]
    fn flatten_multiline_becomes_one_space_each() {
        assert_eq!(flatten_line("第一行\n第二行\r\n第三行"), "第一行 第二行 第三行");
    }

    #[test]
    fn flatten_strips_esc_and_controls() {
        assert_eq!(flatten_line("a\x1b[31mb\x07c\td"), "a[31mbcd");
    }

    #[test]
    fn flatten_keeps_chinese() {
        assert_eq!(flatten_line("你好，世界"), "你好，世界");
    }

    #[test]
    fn flatten_truncates_long() {
        let long = "字".repeat(5000);
        let r = flatten_line(&long);
        assert_eq!(r.chars().count(), MAX_LINE_CHARS + TRUNC_MARK.chars().count());
        assert!(r.ends_with("…（已截斷）"));
        let exact = "a".repeat(4000);
        assert_eq!(flatten_line(&exact), exact);
    }

    #[test]
    fn missing_sock_never_runs_cli() {
        let r = FakeRunner::default();
        let fs = FakeFs::default();
        let w = wez(&r, &fs);
        assert!(w.list(&sock()).is_err());
        assert!(w.send_line(&sock(), 0, "x").is_err());
        assert!(w.send_enter(&sock(), 0).is_err());
        assert!(w.get_text(&sock(), 0, None).is_err());
        assert!(r.calls.borrow().is_empty(), "sock 不存在時不可執行 cli");
    }

    #[test]
    fn timeout_kills_child_and_reports() {
        let r = FakeRunner { timeout_err: true, ..Default::default() };
        let fs = fs_with_sock();
        let w = wez(&r, &fs);
        let e = w.list(&sock()).unwrap_err();
        assert!(e.contains("逾時"));
        assert!(*r.killed.borrow());
    }

    #[test]
    fn list_parses_json() {
        let json = r#"[{"window_id":0,"tab_id":0,"pane_id":0,"workspace":"default","size":{"rows":30,"cols":120,"pixel_width":1200,"pixel_height":600,"dpi":96},"title":"cmd.exe","cwd":"file:///C:/work","cursor_x":5,"cursor_y":3,"cursor_shape":"Default","cursor_visibility":"Visible","left_col":0,"top_row":0,"tab_title":"","window_title":"cmd.exe","is_active":true,"is_zoomed":false,"tty_name":null}]"#;
        let r = FakeRunner::default();
        *r.stdout.borrow_mut() = json.to_string();
        let fs = fs_with_sock();
        let w = wez(&r, &fs);
        let v = w.list(&sock()).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].pane_id, 0);
        assert_eq!(v[0].title, "cmd.exe");
        assert_eq!(v[0].cwd, "file:///C:/work");
        assert_eq!((v[0].cursor_x, v[0].cursor_y), (5, 3));
        assert!(v[0].is_active);
        let calls = r.calls.borrow();
        assert_eq!(calls[0].0, vec!["cli", "list", "--format", "json"]);
        assert_eq!(calls[0].1.get("WEZTERM_UNIX_SOCKET").unwrap(), "H/gui-sock-1");
        assert_eq!(calls[0].1.get("WEZTERM_CONFIG_FILE").unwrap(), "cfg.lua");
    }

    #[test]
    fn enter_sent_separately_and_after_text() {
        let r = FakeRunner::default();
        let fs = fs_with_sock();
        let mut w = wez(&r, &fs);
        w.enter_delay = Duration::from_millis(77);
        w.send_line_and_enter(&sock(), 2, "你好\n世界").unwrap();
        let calls = r.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, vec!["cli", "send-text", "--pane-id", "2", "--no-paste", "你好 世界"]);
        assert_eq!(calls[1].0, vec!["cli", "send-text", "--pane-id", "2", "--no-paste", "\r"]);
        assert_eq!(r.sleeps.borrow().as_slice(), &[Duration::from_millis(77)]);
    }

    #[test]
    fn file_pointer_validates_path() {
        let r = FakeRunner::default();
        let fs = fs_with_sock();
        let w = wez(&r, &fs);
        assert!(w.send_file_pointer(&sock(), 0, Path::new("C:/a\nb.txt")).is_err());
        assert!(w.send_file_pointer(&sock(), 0, Path::new("C:/a\x1b.txt")).is_err());
        assert!(r.calls.borrow().is_empty());
        w.send_file_pointer(&sock(), 0, Path::new("C:/a/task.md")).unwrap();
        assert_eq!(r.calls.borrow()[0].0.last().unwrap(), "請讀 C:/a/task.md 的內容並照辦");
    }

    #[test]
    fn locate_errors_clearly() {
        let fs = FakeFs::default();
        let e = locate_from(None, &fs).unwrap_err();
        assert!(e.contains("找不到 WezTerm") && e.contains("ASN_WEZTERM_DIR"));
        assert!(locate_from(Some("W".into()), &fs).is_err());
        fs.files.borrow_mut().insert("W/wezterm.exe".into());
        assert!(locate_from(Some("W".into()), &fs).is_err());
        fs.files.borrow_mut().insert("W/wezterm-gui.exe".into());
        assert!(locate_from(Some("W".into()), &fs).is_ok());
    }

    #[test]
    fn start_returns_sock_when_present_else_times_out() {
        let r = FakeRunner { spawn_pid: 1, ..Default::default() };
        let fs = FakeFs::default();
        fs.files.borrow_mut().insert(sock_path(Path::new("H"), 1));
        let w = wez(&r, &fs);
        let win = w.start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap();
        assert_eq!(win.gui_pid, 1);
        assert_eq!(win.sock, sock_path(Path::new("H"), 1));
        let calls = r.calls.borrow();
        assert_eq!(calls[0].0, vec!["start", "--always-new-process", "--cwd", "C:/work", "--", "agy.exe"]);
        assert_eq!(calls[0].1.get("WEZTERM_CONFIG_FILE").unwrap(), "cfg.lua");
        drop(calls);

        let fs2 = FakeFs::default();
        let w2 = wez(&r, &fs2);
        let e = w2.start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap_err();
        assert!(e.contains("通訊檔仍未出現"));
    }

    /// 真的 WezTerm 實測（預設不跑，會在桌面開一個視窗）：
    /// ASN_WEZTERM_DIR=<隔離副本資料夾> cargo test --lib wezterm::tests::live -- --ignored --nocapture
    /// 開 cmd.exe 視窗 → list → 單行注入加 Enter → get_text 讀回 → 開第二個 pane → 只結束自己記下的視窗程序。
    #[test]
    #[ignore]
    fn live_start_inject_read_and_cleanup() {
        let fs = RealFs;
        let dir = locate(&fs).expect("請設定 ASN_WEZTERM_DIR");
        let tmp = std::env::temp_dir().join(format!("asn-wez-live-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = tmp.join("wezterm.lua");
        std::fs::write(&cfg, "return {}").unwrap();
        let runner = RealRunner;
        let w = WezTerm::with_default_home(dir, cfg, &runner, &fs);
        let win = w.start(&tmp, &["cmd.exe".to_string()]).expect("啟動");
        let result = (|| -> Result<(), String> {
            std::thread::sleep(Duration::from_millis(1500));
            let panes = w.list(&win.sock)?;
            assert!(!panes.is_empty(), "list 應該有 pane");
            let pid0 = panes[0].pane_id;
            w.send_line_and_enter(&win.sock, pid0, "echo live-ok
第二行")?;
            std::thread::sleep(Duration::from_millis(1200));
            let t = w.get_text(&win.sock, pid0, None)?;
            println!("--- get_text ---
{t}");
            assert!(t.contains("live-ok"), "讀回應該含 live-ok：{t}");
            let p2 = w.spawn(&win.sock, &tmp, &["cmd.exe".to_string()])?;
            assert!(p2 != pid0, "新 pane 編號應不同");
            Ok(())
        })();
        // 只結束自己啟動並記下的視窗程序（含它帶起的子行程樹）
        let _ = std::process::Command::new("taskkill").args(["/PID", &win.gui_pid.to_string(), "/T", "/F"]).output();
        let _ = std::fs::remove_dir_all(&tmp);
        result.expect("實測失敗");
    }
}
