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
/// 執行檔本身起不來時錯誤訊息的開頭（呼叫端靠它分辨「根本沒執行」與「執行了但逾時」）
pub const CANNOT_RUN: &str = "無法執行";
const TRUNC_MARK: &str = "…（已截斷）";
/// WezTerm 建不起視窗時 log 裡的那句（桌面斷線、OpenGL 太舊都是這句；英文原文只用來比對，不給人看）
const NO_WINDOW_MARK: &str = "Failed to create window";
/// 讀 GUI log 的大小上限（超過就不讀）
const LOG_READ_MAX: u64 = 256 * 1024;
/// 建不起視窗時給人看的一句話（#595）
pub const NO_WINDOW_MSG: &str = "這台電腦現在開不了圖形視窗（常見原因：遠端桌面已中斷），請先接回桌面再試";

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
    /// 同 run，但子行程只拿到 env 裡的變數（先清空環境再放白名單；B2b 的 mux cli spawn 用，設計 11.2-5）。
    /// 預設＝run（測試的假 runner 照樣記下 env）
    fn run_clean(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<RunOutput, String> {
        self.run(program, args, env, timeout)
    }
    /// 啟動後不等待，回傳行程編號
    fn spawn(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String>;
    /// 同 spawn，但子行程只拿到 env 裡的變數（不繼承 ASN 自己的環境；#475 經 pi 開在自帶終端用）。
    /// 預設＝spawn（測試的假 runner 照樣記下 env）
    fn spawn_clean(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        self.spawn(program, args, env)
    }
    /// 同 spawn_clean，再加上脫離：新程序群組、盡量脫離 ASN 所在的 Job Object，ASN 結束時不會被帶走（B2 的 mux 用）。
    /// 預設＝spawn_clean（測試的假 runner 照樣記下 env）
    fn spawn_detached(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        self.spawn_clean(program, args, env)
    }
    /// 結束一個自己剛啟動的行程與它的子行程樹（等 socket 逾時要清掉剛開的視窗，不留桌面孤兒）
    fn kill_tree(&self, pid: u32);
    /// 行程的建立時間（毫秒，查不到＝None）：結束行程前用來確認還是當初啟動的那一個，防程式編號被回收後誤殺別人
    fn started_ms(&self, pid: u32) -> Option<u64>;
    fn sleep(&self, d: Duration);
}

/// 檔案檢查介面
pub trait Fs {
    fn exists(&self, p: &Path) -> bool;
    /// 檔案大小（不是檔案或不存在＝None）。找 WezTerm 時大小為 0 的占位檔當找不到（build.rs 沒取過檔時放的空檔）。
    /// 預設：存在就當有內容（測試的假檔案系統不用改）
    fn file_len(&self, p: &Path) -> Option<u64> {
        self.exists(p).then_some(1)
    }
    /// 讀一個小文字檔（讀不到、太大＝None）。只用來看 WezTerm 自己的 log；預設讀不到（測試的假檔案系統不用改）
    fn read_text(&self, _p: &Path) -> Option<String> {
        None
    }
    /// 刪一個檔（只用在清自己剛啟動、已退出的 GUI 留下的通訊檔）；預設不做事
    fn remove_file(&self, _p: &Path) {}
}

pub struct RealFs;
impl Fs for RealFs {
    fn exists(&self, p: &Path) -> bool {
        p.exists()
    }
    fn file_len(&self, p: &Path) -> Option<u64> {
        std::fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len())
    }
    fn read_text(&self, p: &Path) -> Option<String> {
        let m = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
        if m.len() > LOG_READ_MAX {
            return None;
        }
        std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    }
    fn remove_file(&self, p: &Path) {
        let _ = std::fs::remove_file(p);
    }
}

pub struct RealRunner;
impl Runner for RealRunner {
    fn run(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<RunOutput, String> {
        let mut cmd = Command::new(program);
        cmd.no_window().args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        exec_with_timeout(cmd, program, timeout)
    }

    fn run_clean(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<RunOutput, String> {
        let mut cmd = Command::new(program);
        cmd.no_window().env_clear().args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        exec_with_timeout(cmd, program, timeout)
    }

    fn spawn(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        let mut cmd = Command::new(program);
        cmd.no_window().args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("無法啟動 {}：{e}", program.display()))?;
        Ok(child.id())
    }

    fn spawn_clean(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        let mut cmd = Command::new(program);
        cmd.no_window().env_clear().args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("無法啟動 {}：{e}", program.display()))?;
        Ok(child.id())
    }

    fn spawn_detached(&self, program: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        const NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // ASN 若被放在不准脫離的 Job Object 裡，帶 BREAKAWAY 會被拒；退回只開新程序群組，並記下來（這種情況 ASN 結束時 mux 可能被帶走）
        create_detached(program, args, env, NEW_PROCESS_GROUP | BREAKAWAY_FROM_JOB)
            .or_else(|_| {
                elog!("終端服務：無法脫離 ASN 所在的工作群組，改用一般方式啟動（ASN 結束時可能一起結束）");
                create_detached(program, args, env, NEW_PROCESS_GROUP)
            })
            .map_err(|e| format!("無法啟動 {}：{e}", program.display()))
    }

    fn started_ms(&self, pid: u32) -> Option<u64> {
        crate::heartbeat::process_started_ms(pid)
    }

    fn kill_tree(&self, pid: u32) {
        let _ = Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

/// RealRunner::run／run_clean 共用：啟動、讀兩條管道、逾時就連整棵樹結束
fn exec_with_timeout(mut cmd: Command, program: &Path, timeout: Duration) -> Result<RunOutput, String> {
    let mut child = cmd.spawn().map_err(|e| format!("{CANNOT_RUN} {}：{e}", program.display()))?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let t_out = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut s);
        }
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(o) = err.as_mut() {
            let _ = o.read_to_end(&mut s);
        }
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
                    // cli 若在 socket 突然消失時自己拉起了 mux-server，那是它的子行程：連整棵樹一起結束（此刻 child 還活著，編號不會被回收）
                    let _ = Command::new("taskkill").no_window().args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
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

/// Windows 命令列的單一參數引號（照 MSVC 的拆參數規則：引號前的反斜線加倍、結尾反斜線加倍）
pub(crate) fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.contains([' ', '\t', '"']) {
        return a.to_string();
    }
    let mut out = String::from("\"");
    let mut bs = 0usize;
    for c in a.chars() {
        match c {
            '\\' => bs += 1,
            '"' => {
                out.push_str(&"\\".repeat(bs * 2 + 1));
                out.push('"');
                bs = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(bs));
                out.push(c);
                bs = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(bs * 2));
    out.push('"');
    out
}

/// 環境區塊：每個變數一段 `名=值` 以 0 結尾，最後再多一個 0（只有 env 裡的變數）
pub(crate) fn env_block(env: &BTreeMap<String, String>) -> Vec<u16> {
    let mut b: Vec<u16> = vec![];
    for (k, v) in env {
        b.extend(format!("{k}={v}").encode_utf16());
        b.push(0);
    }
    if b.is_empty() {
        b.push(0);
    }
    b.push(0);
    b
}

/// 脫離啟動：直接呼叫 CreateProcessW，**不繼承任何控制代碼**（std 的 Command 一律繼承，會讓長駐的 mux 一直握著
/// ASN 的標準輸出管道；實測從管道下測試時，測試程序結束了讀管道的那端還一直等不到結束）。
/// 環境只有 env；工作資料夾設成執行檔所在的資料夾（不占住 ASN 啟動時的資料夾）；不開視窗
#[cfg(windows)]
fn create_detached(program: &Path, args: &[String], env: &BTreeMap<String, String>, flags: u32) -> std::io::Result<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{CreateProcessW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW};
    let wide = |p: &std::ffi::OsStr| p.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let app = wide(program.as_os_str());
    let line = std::iter::once(quote_arg(&program.to_string_lossy())).chain(args.iter().map(|a| quote_arg(a))).collect::<Vec<_>>().join(" ");
    let mut line: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
    let envb = env_block(env);
    let cwd = program.parent().map(|d| wide(d.as_os_str()));
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            app.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0, // 不繼承控制代碼
            crate::nowin::NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | flags,
            envb.as_ptr() as *const std::ffi::c_void,
            cwd.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            &si,
            &mut pi,
        );
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        Ok(pi.dwProcessId)
    }
}
#[cfg(not(windows))]
fn create_detached(program: &Path, args: &[String], env: &BTreeMap<String, String>, _flags: u32) -> std::io::Result<u32> {
    Command::new(program).no_window().env_clear().args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|c| c.id())
}

/// 找到的 WezTerm 資料夾
#[derive(Debug, Clone)]
pub struct WezTermDir {
    pub gui: PathBuf,
    pub cli: PathBuf,
}

const NOT_FOUND: &str = "找不到 WezTerm（安裝資料夾裡的 wezterm 不見了，請重新安裝 ASN；開發時可用 ASN_WEZTERM_DIR 指到別的副本）";

/// 隨安裝檔附帶的 WezTerm：安裝資料夾（ASN 本體旁）的 wezterm 資料夾
pub fn bundled_dir() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("wezterm"))
}

/// 先看環境變數 ASN_WEZTERM_DIR（開發或測試指到別的副本；設了就只認它），沒設就用安裝檔附帶的；不自動下載
pub fn locate(fs: &dyn Fs) -> Result<WezTermDir, String> {
    locate_with(std::env::var_os(DIR_ENV).map(PathBuf::from), bundled_dir(), fs)
}

pub fn locate_from(dir: Option<PathBuf>, fs: &dyn Fs) -> Result<WezTermDir, String> {
    locate_with(dir, None, fs)
}

/// env＝環境變數指的資料夾（空字串當沒設），bundled＝安裝檔附帶的資料夾。env 有設就只看它，不悄悄換成附帶的。
pub fn locate_with(env: Option<PathBuf>, bundled: Option<PathBuf>, fs: &dyn Fs) -> Result<WezTermDir, String> {
    let env = env.filter(|d| !d.as_os_str().is_empty());
    let dir = env.or(bundled).ok_or_else(|| NOT_FOUND.to_string())?;
    let gui = dir.join("wezterm-gui.exe");
    let cli = dir.join("wezterm.exe");
    // 大小為 0 的檔（build.rs 的占位空檔、被防毒清空的檔）當找不到，免得開到一半才失敗
    let usable = |p: &Path| fs.file_len(p).is_some_and(|n| n > 0);
    if !usable(&gui) || !usable(&cli) {
        return Err(NOT_FOUND.to_string());
    }
    Ok(WezTermDir { gui, cli })
}

/// 啟動後的視窗資訊
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub gui_pid: u32,
    pub sock: PathBuf,
    /// 視窗程序啟動當下量到的建立時間；stop 靠它確認還是同一個程序（量不到＝None，stop 會拒絕動手）
    pub started_ms: Option<u64>,
    /// 窗格在共用的 mux 裡（B2b）：`gui_pid` 是 mux 的程序編號、`sock` 是 mux 的連線檔，絕對不能拿來 kill_tree
    /// （會把所有夥伴一起結束）。`WezTerm::stop` 看到這個就拒絕；關窗格只能走 `kill_pane`
    pub mux: bool,
}

/// 等通訊檔失敗的兩種（#595）
#[derive(Debug, Clone, PartialEq)]
pub enum SockFail {
    /// GUI 已退出、建不起視窗：沒有任何視窗，裡面的程式也不會留在跑，可以換方式再開。內容是給人看的一句話
    NoWindow(String),
    /// 其他（逾時等）：維持原本的處理，視為視窗可能已開
    Other(String),
}

impl SockFail {
    pub fn into_message(self) -> String {
        match self {
            SockFail::NoWindow(m) | SockFail::Other(m) => m,
        }
    }
}

pub fn sock_path(home: &Path, gui_pid: u32) -> PathBuf {
    home.join(".local").join("share").join("wezterm").join(format!("gui-sock-{gui_pid}"))
}

/// `list-clients --format json` 裡的時間長度。
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct WezDuration {
    #[serde(default)]
    pub secs: u64,
    #[serde(default)]
    pub nanos: u64,
}

impl WezDuration {
    pub fn as_secs_f64(&self) -> f64 {
        self.secs as f64 + self.nanos as f64 / 1_000_000_000.0
    }
}

/// `wezterm cli list-clients --format json` 的一列。
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct WezClientInfo {
    #[serde(default)]
    pub pid: u64,
    #[serde(default)]
    pub idle_time: WezDuration,
    #[serde(default)]
    pub focused_pane_id: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PaneInfo {
    pub pane_id: u64,
    pub tab_id: u64,
    #[serde(default)]
    pub title: String,
    /// `wezterm cli list` 的分頁標題。set-tab-title 寫的是這個欄位（與行程標題 `title` 分開）。
    #[serde(default)]
    pub tab_title: String,
    /// `wezterm start --workspace` 設下的工作區名稱。認領時只用它與分頁標題，不看行程標題。
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub cursor_x: i64,
    #[serde(default)]
    pub cursor_y: i64,
    #[serde(default)]
    pub is_active: bool,
}

/// workspace 名稱：非空，且沒有空白與控制字元（要能安全放進一個參數）。
pub(crate) fn workspace_name_ok(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// 把訊息壓成單行：換行（含 \r\n）與製表字元換成一個空格（連續的合併成一個），去掉其他控制字元（含 ESC），超過 4000 字截斷。
/// 方向鍵不得改這裡來放行 ESC。那條走專用的按鍵送出。
pub fn flatten_line(text: &str) -> String {
    let mut out = String::new();
    let mut prev_nl = false;
    for c in text.chars() {
        if c == '\n' || c == '\r' || c == '\t' {
            // 製表字元和換行一樣換成空格，免得 ls\t-la 變 ls-la
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
    /// 連的是共用 mux（B2b）：每條 cli 都插入 `--no-auto-start`，連不上時不准 cli 自己起一個 mux（設計 11.2-2）
    pub no_auto_start: bool,
}

impl<'a> WezTerm<'a> {
    pub fn new(dir: WezTermDir, config_file: PathBuf, home: PathBuf, runner: &'a dyn Runner, fs: &'a dyn Fs) -> Self {
        Self {
            dir,
            config_file,
            home,
            runner,
            fs,
            cli_timeout: CLI_TIMEOUT,
            sock_wait: SOCK_WAIT,
            enter_delay: ENTER_DELAY,
            no_auto_start: false,
        }
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

    /// 啟動新視窗並等 socket 檔出現。不帶 workspace；命令層要做認領標記時用 start_in_workspace。
    pub fn start(&self, cwd: &Path, command: &[String]) -> Result<Window, String> {
        if command.is_empty() {
            return Err("沒有指定要執行的指令".to_string());
        }
        let mut args: Vec<String> = vec!["start".into(), "--always-new-process".into(), "--cwd".into(), cwd.to_string_lossy().into_owned(), "--".into()];
        args.extend(command.iter().cloned());
        self.spawn_gui(args)
    }

    /// 啟動並指定 workspace（`wezterm start --workspace`，20240203 的 gui 就有）。
    /// 名稱在視窗出現前就設好，重啟後認領不必先靠 cli。名稱不得為空、不得含空白或控制字元。
    pub fn start_in_workspace(&self, cwd: &Path, workspace: &str, command: &[String]) -> Result<Window, String> {
        if command.is_empty() {
            return Err("沒有指定要執行的指令".to_string());
        }
        if !workspace_name_ok(workspace) {
            return Err("workspace 名稱不合法".to_string());
        }
        let mut args: Vec<String> = vec![
            "start".into(),
            "--always-new-process".into(),
            "--cwd".into(),
            cwd.to_string_lossy().into_owned(),
            "--workspace".into(),
            workspace.to_string(),
            "--".into(),
        ];
        args.extend(command.iter().cloned());
        self.spawn_gui(args)
    }

    /// 同 start_in_workspace，但 GUI（與裡面的程式）只拿到 env 加上隔離設定檔的路徑，不繼承 ASN 自己的環境（#475 經 pi）。
    /// env 由呼叫端先照 child_env 濾掉金鑰類變數
    pub fn start_in_workspace_clean(&self, cwd: &Path, workspace: &str, command: &[String], env: &BTreeMap<String, String>) -> Result<Window, String> {
        let gui_pid = self.spawn_in_workspace_clean(cwd, workspace, command, env)?;
        self.wait_sock(gui_pid)
    }

    /// start_in_workspace_clean 的前半：只啟動 GUI、回程序編號，不等通訊檔。
    /// 回 Err＝GUI 根本沒啟動（參數不合法、執行檔起不來），呼叫端可以放心改走別的路；回 Ok 之後的失敗就不能再另外開一份
    pub fn spawn_in_workspace_clean(&self, cwd: &Path, workspace: &str, command: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
        if command.is_empty() {
            return Err("沒有指定要執行的指令".to_string());
        }
        if !workspace_name_ok(workspace) {
            return Err("workspace 名稱不合法".to_string());
        }
        let mut args: Vec<String> = vec![
            "start".into(),
            "--always-new-process".into(),
            "--cwd".into(),
            cwd.to_string_lossy().into_owned(),
            "--workspace".into(),
            workspace.to_string(),
            "--".into(),
        ];
        args.extend(command.iter().cloned());
        let mut merged = env.clone();
        merged.extend(self.config_env());
        self.runner.spawn_clean(&self.dir.gui, &args, &merged)
    }

    fn spawn_gui(&self, args: Vec<String>) -> Result<Window, String> {
        let gui_pid = self.runner.spawn(&self.dir.gui, &args, &self.config_env())?;
        self.wait_sock(gui_pid)
    }

    /// 等新開的 GUI 的通訊檔出現；逾時就結束剛開的視窗（只在建立時間跟剛開時量到的相同才結束，量不到或不同就不動、照實說）
    pub fn wait_sock(&self, gui_pid: u32) -> Result<Window, String> {
        self.wait_sock_classified(gui_pid).map_err(SockFail::into_message)
    }

    /// 同 wait_sock，但把「GUI 已經退出、log 寫建不起視窗」獨立出來（#595）：這時沒有視窗，呼叫端可以換方式再試。
    /// 判斷要三件都成立才算：GUI 的 log 有那句、通訊檔從沒出現、GUI 程序已經不在（建立時間量得到才比；量不到就不下結論，照舊等到逾時）
    pub fn wait_sock_classified(&self, gui_pid: u32) -> Result<Window, SockFail> {
        let started_ms = self.runner.started_ms(gui_pid);
        let sock = sock_path(&self.home, gui_pid);
        let start = Instant::now();
        let step = Duration::from_millis(100);
        loop {
            if self.fs.exists(&sock) {
                return Ok(Window { gui_pid, sock, started_ms, mux: false });
            }
            if self.gui_log_says_no_window(gui_pid) && started_ms.is_some() && self.runner.started_ms(gui_pid) != started_ms {
                elog!("WezTerm 建不起視窗（GUI 已退出，log 寫 {NO_WINDOW_MARK}）");
                self.fs.remove_file(&sock);
                return Err(SockFail::NoWindow(NO_WINDOW_MSG.to_string()));
            }
            if start.elapsed() >= self.sock_wait {
                // 剛開的視窗連同子行程一起清掉，不留桌面孤兒視窗；但只動建立時間相符的那個（編號可能已被回收）
                let waited = self.sock_wait.as_secs();
                return match (started_ms, self.runner.started_ms(gui_pid)) {
                    (Some(was), Some(now)) if was == now => {
                        self.runner.kill_tree(gui_pid);
                        Err(SockFail::Other(format!("等了 {waited} 秒，WezTerm 的通訊檔仍未出現：{}（已結束剛啟動的視窗）", sock.display())))
                    }
                    (_, None) => Err(SockFail::Other(format!("等了 {waited} 秒，WezTerm 的通訊檔仍未出現：{}（剛啟動的視窗已經不在）", sock.display()))),
                    _ => Err(SockFail::Other(format!("等了 {waited} 秒，WezTerm 的通訊檔仍未出現：{}（確認不了是同一個程序，沒有結束它）", sock.display()))),
                };
            }
            self.runner.sleep(step);
        }
    }

    /// GUI 的 log 檔路徑：WezTerm 把 log 寫在通訊檔旁邊，檔名是 `wezterm-gui.exe-log-<程序編號>.txt`
    fn gui_log_path(&self, gui_pid: u32) -> PathBuf {
        self.home.join(".local").join("share").join("wezterm").join(format!("wezterm-gui.exe-log-{gui_pid}.txt"))
    }

    fn gui_log_says_no_window(&self, gui_pid: u32) -> bool {
        self.fs.read_text(&self.gui_log_path(gui_pid)).is_some_and(|t| t.contains(NO_WINDOW_MARK))
    }

    /// `wezterm cli set-tab-title --pane-id <id> <標題>`。
    /// 20240203-110809-5046fc22 有這個子命令（20230408-112425-69ae8472 起）。標題是一個參數，不經 shell。
    /// 空字串與控制字元在這裡就拒絕，不會執行 cli。長度由命令層再限制。
    pub fn set_tab_title(&self, sock: &Path, pane_id: u64, title: &str) -> Result<(), String> {
        if title.is_empty() || title.chars().any(|c| c.is_control()) {
            return Err("分頁標題是空的或含有控制字元，已拒絕".to_string());
        }
        let args = vec!["set-tab-title".to_string(), "--pane-id".into(), pane_id.to_string(), title.to_string()];
        self.cli(sock, &args).map(|_| ())
    }

    /// 執行 `wezterm.exe cli ...`。socket 不存在時絕不執行（否則 cli 會卡住並悄悄啟動 mux-server）。
    /// 這裡（list、get-text、send-text、set-tab-title、kill-pane…）用一般的 run、不清空環境：這些指令不開窗格，
    /// 下指令的程序的環境不會進到任何夥伴那邊。只有開窗格的 spawn 才走 run_clean（見 term.rs::open_mux）
    fn cli(&self, sock: &Path, args: &[String]) -> Result<String, String> {
        if !self.fs.exists(sock) {
            return Err(format!("WezTerm 通訊檔不存在（視窗可能已關閉）：{}", sock.display()));
        }
        let mut env = self.config_env();
        env.insert("WEZTERM_UNIX_SOCKET".to_string(), sock.to_string_lossy().into_owned());
        let mut full: Vec<String> = vec!["cli".into()];
        if self.no_auto_start {
            full.push("--no-auto-start".into());
        }
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

    pub fn list_clients_text(&self, sock: &Path) -> Result<String, String> {
        self.cli(sock, &["list-clients".into(), "--format".into(), "json".into()])
    }

    /// 執行 `wezterm.exe --version`（不走 socket）。
    pub fn version_string(&self) -> Result<String, String> {
        let out = self.runner.run(&self.dir.cli, &["--version".to_string()], &self.config_env(), self.cli_timeout)?;
        if !out.success {
            return Err(format!("WezTerm 版本查詢失敗：{}", out.stderr.trim()));
        }
        Ok(out.stdout)
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

    /// 關掉共用 mux 裡的一個窗格（只結束那個窗格，不動 mux 與其他夥伴）
    pub fn kill_pane(&self, sock: &Path, pane_id: u64) -> Result<(), String> {
        self.cli(sock, &["kill-pane".to_string(), "--pane-id".into(), pane_id.to_string()]).map(|_| ())
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

    /// 方向鍵專用送出。只接受固定對照表組好的位元組（ESC [ A、ESC [ B、\r、ESC、單一英數字元），不壓行。
    /// 一般送字會把 ESC 當控制字元丟掉，那個保護留在那裡，這裡不放寬。
    /// 20240203-110809-5046fc22 的 `send-text --no-paste` 把參數位元組原樣寫進窗格，自己不解釋跳脫字元。
    pub fn send_bytes(&self, sock: &Path, pane_id: u64, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Err("沒有要送的按鍵".to_string());
        }
        self.send_raw(sock, pane_id, text)
    }

    fn send_raw(&self, sock: &Path, pane_id: u64, text: &str) -> Result<(), String> {
        let args = vec!["send-text".to_string(), "--pane-id".into(), pane_id.to_string(), "--no-paste".into(), text.to_string()];
        self.cli(sock, &args).map(|_| ())
    }

    /// 送一行文字，等一下再單獨送 Enter
    pub fn send_line_and_enter(&self, sock: &Path, pane_id: u64, text: &str) -> Result<(), String> {
        self.send_line(sock, pane_id, text)?;
        self.runner.sleep(self.enter_delay);
        self.send_enter(sock, pane_id)
    }

    /// 結束自己啟動的視窗（含子行程樹）。程式編號可能在視窗自己關掉後被系統回收給別的程式，所以：
    /// - 啟動當下沒量到建立時間 → 拒絕（不能確認是同一個）；
    /// - 現在查不到這個編號 → 視窗早就沒了，視為完成；
    /// - 現在的建立時間和當初不同 → 編號已被別的程式用了，拒絕且不動它；
    /// - 相同才結束。
    /// 窗格在共用 mux 裡的（`win.mux`）一律拒絕：gui_pid 是 mux 的編號，kill_tree 會把所有夥伴一起結束。
    pub fn stop(&self, win: &Window) -> Result<(), String> {
        if win.mux {
            return Err("這個窗格在共用的終端服務裡，不能用結束程序的方式關（會連其他夥伴一起結束）".to_string());
        }
        let Some(was) = win.started_ms else {
            return Err("沒有記下視窗程序的建立時間，無法確認是同一個程序，不結束它".to_string());
        };
        match self.runner.started_ms(win.gui_pid) {
            None => Ok(()),
            Some(now) if now == was => {
                self.runner.kill_tree(win.gui_pid);
                Ok(())
            }
            Some(_) => Err("這個程式編號現在是別的程序（建立時間不同），不結束它".to_string()),
        }
    }

    /// 送「請讀 <路徑> 的內容並照辦」一行提示；路徑不得有換行與控制字元。**不帶 Enter**（Enter 要另外送，見 send_file_pointer_and_enter）
    pub fn send_file_pointer(&self, sock: &Path, pane_id: u64, file: &Path) -> Result<(), String> {
        let p = file.to_string_lossy();
        if p.is_empty() || p.chars().any(|c| c.is_control()) {
            return Err("檔案路徑含有換行或控制字元，已拒絕".to_string());
        }
        self.send_line(sock, pane_id, &format!("請讀 {p} 的內容並照辦"))
    }

    /// 同 send_file_pointer，之後等一小段再另外送 Enter（送出整個提示）
    pub fn send_file_pointer_and_enter(&self, sock: &Path, pane_id: u64, file: &Path) -> Result<(), String> {
        self.send_file_pointer(sock, pane_id, file)?;
        self.runner.sleep(self.enter_delay);
        self.send_enter(sock, pane_id)
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
        /// 大小為 0 的檔（存在，但只是占位）
        empty: RefCell<HashSet<PathBuf>>,
        /// 可讀的文字檔（GUI 的 log）
        texts: RefCell<BTreeMap<PathBuf, String>>,
        removed: RefCell<Vec<PathBuf>>,
    }
    impl Fs for FakeFs {
        fn read_text(&self, p: &Path) -> Option<String> {
            self.texts.borrow().get(p).cloned()
        }
        fn remove_file(&self, p: &Path) {
            self.removed.borrow_mut().push(p.to_path_buf());
        }
        fn exists(&self, p: &Path) -> bool {
            self.files.borrow().contains(p) || self.empty.borrow().contains(p)
        }
        fn file_len(&self, p: &Path) -> Option<u64> {
            if self.empty.borrow().contains(p) {
                return Some(0);
            }
            self.files.borrow().contains(p).then_some(1)
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
        tree_killed: RefCell<Vec<u32>>,
        started: RefCell<Vec<Option<u64>>>, // 每次 started_ms 依序回傳（用完回 None）
    }
    impl Runner for FakeRunner {
        fn run(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<RunOutput, String> {
            self.calls.borrow_mut().push((args.to_vec(), env.clone()));
            if self.timeout_err {
                *self.killed.borrow_mut() = true;
                return Err(format!("WezTerm 指令逾時（{} 秒），已結束該子行程", timeout.as_secs()));
            }
            Ok(RunOutput {
                success: true,
                stdout: self.stdout.borrow().clone(),
                stderr: String::new(),
            })
        }
        fn spawn(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
            self.calls.borrow_mut().push((args.to_vec(), env.clone()));
            Ok(self.spawn_pid)
        }
        fn kill_tree(&self, pid: u32) {
            self.tree_killed.borrow_mut().push(pid);
        }
        fn started_ms(&self, _pid: u32) -> Option<u64> {
            let mut v = self.started.borrow_mut();
            if v.is_empty() {
                None
            } else {
                v.remove(0)
            }
        }
        fn sleep(&self, d: Duration) {
            self.sleeps.borrow_mut().push(d);
        }
    }

    fn dirs() -> WezTermDir {
        WezTermDir {
            gui: "W/wezterm-gui.exe".into(),
            cli: "W/wezterm.exe".into(),
        }
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
        assert_eq!(flatten_line("a\x1b[31mb\x07c\td"), "a[31mbc d");
        assert_eq!(flatten_line("\u{1b}[A"), "[A", "往上的控制碼仍要丟掉");
        assert_eq!(flatten_line("\u{1b}[B"), "[B", "往下的控制碼仍要丟掉");
        assert_eq!(flatten_line("\r"), " ", "換行鍵仍要換成空格");
        assert_eq!(flatten_line("\u{1b}"), "", "ESC 本身仍要丟掉");
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
        assert!(w.set_tab_title(&sock(), 0, "ASN:1").is_err());
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
        assert_eq!(v[0].tab_title, "");
        assert_eq!(v[0].workspace, "default");
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
        assert_eq!(r.calls.borrow().len(), 1, "send_file_pointer 不帶 Enter");
    }

    #[test]
    fn file_pointer_and_enter_sends_enter_separately_after_delay() {
        let r = FakeRunner::default();
        let fs = fs_with_sock();
        let w = wez(&r, &fs);
        w.send_file_pointer_and_enter(&sock(), 0, Path::new("C:/a/task.md")).unwrap();
        let c = r.calls.borrow();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].0.last().unwrap(), "請讀 C:/a/task.md 的內容並照辦");
        assert_eq!(c[1].0.last().unwrap(), "\r", "Enter 另外單獨送");
        assert_eq!(r.sleeps.borrow().len(), 1, "兩次之間有延遲");
    }

    #[test]
    fn stop_kills_only_when_creation_time_matches() {
        let fs = FakeFs::default();
        fs.files.borrow_mut().insert(sock_path(Path::new("H"), 1));
        // 啟動時量到 1000，結束時還是 1000 → 結束
        let r = FakeRunner {
            spawn_pid: 1,
            started: RefCell::new(vec![Some(1000), Some(1000)]),
            ..Default::default()
        };
        let w = wez(&r, &fs);
        let win = w.start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap();
        assert_eq!(win.started_ms, Some(1000));
        w.stop(&win).unwrap();
        assert_eq!(*r.tree_killed.borrow(), vec![1]);
        // 編號被別的程式回收（建立時間不同）→ 拒絕，且不動它
        let r2 = FakeRunner {
            spawn_pid: 1,
            started: RefCell::new(vec![Some(1000), Some(2000)]),
            ..Default::default()
        };
        let w2 = wez(&r2, &fs);
        let win2 = w2.start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap();
        assert!(w2.stop(&win2).unwrap_err().contains("別的程序"));
        assert!(r2.tree_killed.borrow().is_empty(), "建立時間不同絕不能結束");
        // 視窗早就沒了（查不到）→ 視為完成，不用動手
        let r3 = FakeRunner {
            spawn_pid: 1,
            started: RefCell::new(vec![Some(1000), None]),
            ..Default::default()
        };
        let w3 = wez(&r3, &fs);
        let win3 = w3.start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap();
        w3.stop(&win3).unwrap();
        assert!(r3.tree_killed.borrow().is_empty());
        // 啟動時沒量到建立時間 → 拒絕
        let r4 = FakeRunner { spawn_pid: 1, ..Default::default() };
        let w4 = wez(&r4, &fs);
        let win4 = w4.start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap();
        assert_eq!(win4.started_ms, None);
        assert!(w4.stop(&win4).is_err());
        assert!(r4.tree_killed.borrow().is_empty());
    }

    #[test]
    fn flatten_tab_becomes_space_not_glued() {
        assert_eq!(flatten_line("ls	-la"), "ls -la");
        assert_eq!(
            flatten_line(
                "a		b
	c"
            ),
            "a b c"
        );
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
    fn locate_用安裝檔附帶的_環境變數有設就只認它() {
        let fs = FakeFs::default();
        fs.files.borrow_mut().insert("B/wezterm.exe".into());
        fs.files.borrow_mut().insert("B/wezterm-gui.exe".into());
        assert!(locate_with(None, Some("B".into()), &fs).is_ok(), "沒設環境變數就用附帶的");
        assert!(locate_with(Some("".into()), Some("B".into()), &fs).is_ok(), "空字串當沒設");
        assert!(locate_with(Some("E".into()), Some("B".into()), &fs).is_err(), "環境變數指到沒有的地方不能悄悄換成附帶的");
        fs.files.borrow_mut().insert("E/wezterm.exe".into());
        fs.files.borrow_mut().insert("E/wezterm-gui.exe".into());
        assert_eq!(locate_with(Some("E".into()), Some("B".into()), &fs).unwrap().cli, PathBuf::from("E/wezterm.exe"));
        assert!(locate_with(None, None, &fs).is_err());
        assert!(bundled_dir().is_some_and(|d| d.ends_with("wezterm")), "附帶的在安裝資料夾的 wezterm 底下");
    }

    #[test]
    fn locate_大小為0的占位檔當找不到() {
        let fs = FakeFs::default();
        fs.empty.borrow_mut().insert("B/wezterm.exe".into());
        fs.empty.borrow_mut().insert("B/wezterm-gui.exe".into());
        assert!(locate_with(None, Some("B".into()), &fs).is_err(), "兩個都是空檔");
        fs.empty.borrow_mut().remove(Path::new("B/wezterm.exe"));
        fs.files.borrow_mut().insert("B/wezterm.exe".into());
        assert!(locate_with(None, Some("B".into()), &fs).is_err(), "GUI 是空檔也不行");
        fs.empty.borrow_mut().clear();
        fs.files.borrow_mut().insert("B/wezterm-gui.exe".into());
        assert!(locate_with(None, Some("B".into()), &fs).is_ok(), "都有內容才算找得到");
    }

    #[test]
    fn 真的檔案系統_空檔大小是0_資料夾不算檔案() {
        let d = tempfile::tempdir().unwrap();
        let empty = d.path().join("e.exe");
        std::fs::write(&empty, b"").unwrap();
        let full = d.path().join("f.exe");
        std::fs::write(&full, b"MZ").unwrap();
        assert_eq!(RealFs.file_len(&empty), Some(0));
        assert_eq!(RealFs.file_len(&full), Some(2));
        assert_eq!(RealFs.file_len(d.path()), None);
        assert_eq!(RealFs.file_len(&d.path().join("沒有")), None);
    }

    #[test]
    fn start_in_workspace_puts_name_before_command_and_rejects_bad_names() {
        let r = FakeRunner { spawn_pid: 1, ..Default::default() };
        let fs = FakeFs::default();
        fs.files.borrow_mut().insert(sock_path(Path::new("H"), 1));
        let w = wez(&r, &fs);
        w.start_in_workspace(Path::new("C:/work"), "asn-1", &["agy.exe".to_string()]).unwrap();
        assert_eq!(r.calls.borrow()[0].0, vec!["start", "--always-new-process", "--cwd", "C:/work", "--workspace", "asn-1", "--", "agy.exe"]);
        for bad in ["", "asn 1", "asn\n1", "a\tb"] {
            let err = w.start_in_workspace(Path::new("C:/work"), bad, &["agy.exe".to_string()]).unwrap_err();
            assert!(err.contains("不合法"), "{bad:?}: {err}");
        }
        assert_eq!(r.calls.borrow().len(), 1, "不合法的 workspace 不可啟動");
    }

    #[test]
    fn set_tab_title_uses_pane_and_refuses_without_sock_or_controls() {
        let r = FakeRunner::default();
        let fs = FakeFs::default();
        let w = wez(&r, &fs);
        assert!(w.set_tab_title(&sock(), 7, "ASN:1").is_err());
        assert!(r.calls.borrow().is_empty(), "通訊檔不在就不可執行 cli");
        let fs = fs_with_sock();
        let w = wez(&r, &fs);
        assert!(w.set_tab_title(&sock(), 7, "").is_err());
        assert!(w.set_tab_title(&sock(), 7, "A\nB").is_err());
        assert!(r.calls.borrow().is_empty(), "空標題或控制字元不可執行 cli");
        w.set_tab_title(&sock(), 7, "ASN:1 名稱").unwrap();
        assert_eq!(r.calls.borrow()[0].0, vec!["cli", "set-tab-title", "--pane-id", "7", "ASN:1 名稱"]);
        assert_eq!(r.calls.borrow()[0].1.get("WEZTERM_UNIX_SOCKET").unwrap(), "H/gui-sock-1");
    }

    #[test]
    fn start_returns_sock_when_present_else_times_out() {
        // 第一次 start 量一次；第二次 start 量一次、逾時再量一次（相符才結束）
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![Some(5), Some(5), Some(5)]), ..Default::default() };
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
        assert_eq!(*r.tree_killed.borrow(), vec![1], "逾時要把剛啟動的視窗連子行程一起結束，不留孤兒視窗");
    }

    #[test]
    fn 等不到通訊檔_建立時間不符或量不到就不結束() {
        let fs = FakeFs::default();
        // 剛開時量到 5，逾時時變成 6：編號被別的程序拿去用了
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![Some(5), Some(6)]), ..Default::default() };
        let e = wez(&r, &fs).start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap_err();
        assert!(e.contains("沒有結束它"), "{e}");
        assert!(r.tree_killed.borrow().is_empty());
        // 剛開時就量不到
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![None, Some(5)]), ..Default::default() };
        assert!(wez(&r, &fs).start(Path::new("C:/work"), &["agy.exe".to_string()]).is_err());
        assert!(r.tree_killed.borrow().is_empty());
        // 逾時時已經不在
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![Some(5), None]), ..Default::default() };
        assert!(wez(&r, &fs).start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap_err().contains("已經不在"));
        assert!(r.tree_killed.borrow().is_empty());
    }

    fn gui_log(pid: u32) -> PathBuf {
        PathBuf::from(format!("H/.local/share/wezterm/wezterm-gui.exe-log-{pid}.txt"))
    }

    #[test]
    fn 建不起視窗_gui_退出且_log_有那句_回_no_window_不結束任何程序() {
        let fs = FakeFs::default();
        fs.texts.borrow_mut().insert(gui_log(1), "09:31:12  ERROR  Failed to create window: The OpenGL implementation is too old to work with glium
".into());
        // 剛開時量到 5，之後量不到：GUI 已經退出
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![Some(5), None]), ..Default::default() };
        let e = wez(&r, &fs).start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap_err();
        assert_eq!(e, NO_WINDOW_MSG, "給人看的一句話，不含英文原文");
        assert!(r.tree_killed.borrow().is_empty(), "已經退出的程序不再結束");
        assert_eq!(*fs.removed.borrow(), vec![sock_path(Path::new("H"), 1)], "只清自己這個程序編號的通訊檔");
    }

    #[test]
    fn 建不起視窗的判斷_三件缺一不可() {
        // log 沒有那句：維持逾時處理
        let fs = FakeFs::default();
        fs.texts.borrow_mut().insert(gui_log(1), "別的訊息
".into());
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![Some(5), Some(5), None]), ..Default::default() };
        let e = wez(&r, &fs).start(Path::new("C:/work"), &["agy.exe".to_string()]).unwrap_err();
        assert!(e.contains("通訊檔仍未出現"), "{e}");
        // 剛開時量不到建立時間：無從確認 GUI 退出，不下結論
        let fs = FakeFs::default();
        fs.texts.borrow_mut().insert(gui_log(1), "Failed to create window".into());
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![None, None]), ..Default::default() };
        let e = wez(&r, &fs).wait_sock_classified(1).unwrap_err();
        assert!(matches!(&e, SockFail::Other(m) if m.contains("通訊檔仍未出現")), "{e:?}");
        assert!(fs.removed.borrow().is_empty());
        // 通訊檔有出現：是成功，就算 log 裡有那句
        let fs = FakeFs::default();
        fs.files.borrow_mut().insert(sock_path(Path::new("H"), 1));
        fs.texts.borrow_mut().insert(gui_log(1), "Failed to create window".into());
        let r = FakeRunner { spawn_pid: 1, started: RefCell::new(vec![Some(5), None]), ..Default::default() };
        assert!(wez(&r, &fs).wait_sock_classified(1).is_ok());
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
            w.send_line_and_enter(
                &win.sock,
                pid0,
                "echo live-ok
第二行",
            )?;
            std::thread::sleep(Duration::from_millis(1200));
            let t = w.get_text(&win.sock, pid0, None)?;
            println!(
                "--- get_text ---
{t}"
            );
            assert!(t.contains("live-ok"), "讀回應該含 live-ok：{t}");
            let p2 = w.spawn(&win.sock, &tmp, &["cmd.exe".to_string()])?;
            assert!(p2 != pid0, "新 pane 編號應不同");
            Ok(())
        })();
        // 只結束自己啟動並記下的視窗程序（含它帶起的子行程樹）
        let stopped = w.stop(&win); // 真的走 stop：核對建立時間後才結束
        println!("stop 結果：{stopped:?}");
        let _ = stopped;
        let _ = std::fs::remove_dir_all(&tmp);
        result.expect("實測失敗");
    }
}
