//! 夥伴的主控台視窗：查「這個夥伴現在是不是開著黑視窗」與切換背景／前台。
//! 全程不啟動任何子程序（以前會跑 `claude agents --json`、tasklist、powershell，每個都閃一扇黑視窗）：
//! - 找 pid：讀 `~/.claude/sessions/<pid>.json`（欄位 pid、name、sessionId、status），比對名字；
//! - 確認還活著：Win32 OpenProcess＋GetExitCodeProcess；
//! - 找視窗與顯示／隱藏：Win32 EnumWindows／ShowWindow（必要時用 AttachConsole 取 GetConsoleWindow）。
use super::PartnerConsoleReq;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn partner_console_query(req: PartnerConsoleReq) -> Result<Value, String> {
    Ok(json!(query_console(&req)?))
}

pub fn partner_console_set(req: PartnerConsoleReq) -> Result<Value, String> {
    let vis = req.visible.unwrap_or(true);
    set_console_visible(&req, vis)
}

#[derive(serde::Serialize)]
struct ConsoleQuery {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_toggle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hwnd: Option<i64>,
}

impl ConsoleQuery {
    fn no(reason: &str, pid: Option<u32>) -> Self {
        Self { ok: true, can_toggle: Some(false), visible: None, reason: Some(reason.into()), pid, hwnd: None }
    }
}

/// Claude 放工作階段記錄的資料夾：`CLAUDE_CONFIG_DIR\sessions`，沒設就是 `~/.claude/sessions`
pub(crate) fn sessions_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join("sessions"));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(".claude").join("sessions"))
}

/// 讀資料夾裡每個 `<pid>.json`；壞檔略過。檔名的 pid 補進沒有 pid 欄位的記錄
pub(crate) fn read_sessions(dir: &Path) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x != "json").unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(mut v) = serde_json::from_str::<Value>(&text) else { continue };
        if v.get("pid").and_then(Value::as_u64).is_none() {
            if let Some(n) = p.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u64>().ok()) {
                if let Some(o) = v.as_object_mut() {
                    o.insert("pid".into(), json!(n));
                }
            }
        }
        out.push(v);
    }
    out
}

/// 從工作階段記錄挑出名字相符、互動式、而且程序還活著的 pid；同名多筆取最近啟動的
pub(crate) fn pick_session_pid(sessions: &[Value], name: &str, alive: impl Fn(u32) -> bool) -> Option<u32> {
    sessions
        .iter()
        .filter(|s| s.get("name").and_then(Value::as_str) == Some(name))
        .filter(|s| s.get("kind").and_then(Value::as_str).map(|k| k == "interactive").unwrap_or(true))
        .filter_map(|s| {
            let pid = u32::try_from(s.get("pid").and_then(Value::as_u64)?).ok()?;
            Some((s.get("startedAt").and_then(Value::as_u64).unwrap_or(0), pid))
        })
        .filter(|(_, pid)| alive(*pid))
        .max()
        .map(|(_, pid)| pid)
}

/// 找得到夥伴程序卻找不到傳統主控台視窗時的原因。Windows Terminal 的分頁共用同一個終端機視窗，
/// 夥伴自己沒有視窗可收（隱藏整個終端機會連別的分頁一起消失），所以只說明、不硬切。
pub(crate) fn no_window_reason(in_windows_terminal: bool) -> &'static str {
    if in_windows_terminal {
        super::console_resolve::WT_SHARED_REASON
    } else {
        "找不到這個夥伴的主控台視窗（可能不是用傳統主控台開的）"
    }
}

/// 依請求載入需要的本機資料（只載需要的：Claude 讀 sessions、pi 讀登記檔、其他才掃程序、工作者讀設定）
#[cfg(windows)]
fn load_sources(req: &PartnerConsoleReq) -> super::console_resolve::Sources {
    use super::console_resolve::Sources;
    let engine = req.engine.trim().to_lowercase();
    let is_process = req.kind.as_deref() == Some("process") || req.pid.is_some();
    let mut src = Sources::default();
    let home = crate::identity::home_dir();
    if (engine.is_empty() || engine == "claude") && (!is_process || req.pid.is_some()) {
        if let Some(dir) = sessions_dir() {
            src.sessions = read_sessions(&dir);
        }
    }
    if engine == "pi" || is_process {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let wins = crate::bridge::engines::pi::read_windows(&crate::bridge::engines::pi::windows_dir(&home), now, win::pid_alive);
        src.pi_windows = wins.iter().map(|w| (w.name.clone(), w.pid)).collect();
    }
    if is_process {
        let skip: Vec<u32> = src.pi_windows.iter().map(|(_, p)| *p).collect();
        src.procs = crate::bridge::procscan::scan_system_excluding(&skip);
    }
    if engine != "claude" && !engine.is_empty() && engine != "pi" && !is_process {
        let agents = crate::identity::relay_home().join("agents.json");
        src.workers = crate::bridge::engines::acp_config::load_workers_config(&agents, &crate::identity::relay_home()).workers.iter().map(|w| w.name.clone()).collect();
    }
    src
}

#[cfg(windows)]
struct RealConsoleOs;

#[cfg(windows)]
impl super::console_resolve::ConsoleOs for RealConsoleOs {
    fn find_console(&self, pid: u32) -> Option<super::console_resolve::ConsoleWin> {
        win::find_console(pid).map(|w| super::console_resolve::ConsoleWin { hwnd: w.hwnd, visible: w.visible })
    }
    fn find_wt_windows(&self, wt_pid: u32) -> Vec<super::console_resolve::ConsoleWin> {
        win::find_wt_windows(wt_pid)
    }
    fn table(&self) -> Vec<super::switch::Proc> {
        super::switch::winapi::process_table()
    }
    fn own_pid(&self) -> u32 {
        std::process::id()
    }
}

fn query_console(req: &PartnerConsoleReq) -> Result<ConsoleQuery, String> {
    if req.name.is_empty() {
        return Ok(ConsoleQuery { ok: false, can_toggle: None, visible: None, reason: Some("缺少名字".into()), pid: None, hwnd: None });
    }
    #[cfg(not(windows))]
    {
        return Ok(ConsoleQuery::no("僅 Windows 可切換主控台視窗", None));
    }
    #[cfg(windows)]
    {
        use super::console_resolve::{find_for, resolve_pid, Ask};
        let src = load_sources(req);
        let ask = Ask { engine: &req.engine, name: &req.name, kind: req.kind.as_deref().unwrap_or(""), pid: req.pid };
        let pid = match resolve_pid(&ask, &src, &win::pid_alive) {
            Ok(p) => p,
            Err(reason) => return Ok(ConsoleQuery::no(&reason, None)),
        };
        match find_for(pid, &RealConsoleOs) {
            Ok((owner, w)) => Ok(ConsoleQuery { ok: true, can_toggle: Some(true), visible: Some(w.visible), reason: None, pid: Some(owner), hwnd: Some(w.hwnd) }),
            Err(reason) => Ok(ConsoleQuery::no(&reason, Some(pid))),
        }
    }
}

fn set_console_visible(req: &PartnerConsoleReq, visible: bool) -> Result<Value, String> {
    let q = query_console(req)?;
    if q.can_toggle != Some(true) || q.hwnd.is_none() {
        return Ok(json!({ "ok": false, "reason": q.reason.unwrap_or_else(|| "無法切換".into()) }));
    }
    #[cfg(not(windows))]
    {
        let _ = visible;
        return Ok(json!({ "ok": false, "reason": "僅 Windows 可切換主控台視窗" }));
    }
    #[cfg(windows)]
    {
        let hwnd = q.hwnd.unwrap();
        win::set_visible(hwnd, visible)?;
        Ok(json!({ "ok": true, "visible": win::is_visible(hwnd) }))
    }
}

/// 這台電腦上所有「主控台視窗」：[(擁有視窗的程序編號, 是否可見)]。一次 EnumWindows、不接上任何主控台，給名單判斷 CLI 視窗有沒有隱藏。
/// 非 Windows、測試環境（不碰真的視窗，名單斷言才穩）回空表。
pub fn console_windows() -> Vec<(u32, bool)> {
    #[cfg(all(windows, not(test)))]
    {
        win::console_windows()
    }
    #[cfg(not(all(windows, not(test))))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
pub(crate) mod win {
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Console::{AttachConsole, FreeConsole, GetConsoleWindow};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_HIDE, SW_SHOW};

    pub struct WinConsole {
        pub hwnd: i64,
        pub visible: bool,
    }

    const STILL_ACTIVE: u32 = 259;

    /// 這個 pid 的程序還在不在（不啟動 tasklist）
    pub fn pid_alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            ok && code == STILL_ACTIVE
        }
    }

    fn class_is(hwnd: HWND, want: &str) -> bool {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == want
    }

    fn class_is_console(hwnd: HWND) -> bool {
        class_is(hwnd, "ConsoleWindowClass")
    }

    struct WtSearch {
        pid: u32,
        found: Vec<i64>,
    }

    unsafe extern "system" fn each_wt_window(hwnd: HWND, lp: LPARAM) -> i32 {
        let s = &mut *(lp as *mut WtSearch);
        let mut p = 0u32;
        GetWindowThreadProcessId(hwnd, &mut p);
        if p == s.pid && class_is(hwnd, "CASCADIA_HOSTING_WINDOW_CLASS") {
            s.found.push(hwnd as isize as i64);
        }
        1
    }

    /// 這個 Windows Terminal 程序擁有的頂層視窗（只列出，不動）
    pub fn find_wt_windows(wt_pid: u32) -> Vec<crate::launch::console_resolve::ConsoleWin> {
        let mut s = WtSearch { pid: wt_pid, found: vec![] };
        unsafe {
            EnumWindows(Some(each_wt_window), &mut s as *mut WtSearch as LPARAM);
        }
        s.found.into_iter().map(|h| crate::launch::console_resolve::ConsoleWin { hwnd: h, visible: is_visible(h) }).collect()
    }

    pub fn is_visible(hwnd: i64) -> bool {
        unsafe { IsWindowVisible(hwnd as isize as HWND) != 0 }
    }

    struct Search {
        pid: u32,
        found: HWND,
    }

    unsafe extern "system" fn each_window(hwnd: HWND, lp: LPARAM) -> i32 {
        let s = &mut *(lp as *mut Search);
        let mut p = 0u32;
        GetWindowThreadProcessId(hwnd, &mut p);
        if p == s.pid && class_is_console(hwnd) {
            s.found = hwnd;
            return 0; // 找到了，停止列舉
        }
        1
    }

    /// 方法二：暫時接上該程序的主控台，問 GetConsoleWindow。整個程序同一時間只能接一個主控台，所以上鎖；
    /// 自己已經有主控台（例如開發時從終端機啟動）就不做，免得把自己的主控台卸掉。
    fn via_attach(pid: u32) -> Option<HWND> {
        static LOCK: Mutex<()> = Mutex::new(());
        let _g = LOCK.lock().ok()?;
        unsafe {
            if !GetConsoleWindow().is_null() {
                return None;
            }
            if AttachConsole(pid) == 0 {
                return None;
            }
            let h = GetConsoleWindow();
            FreeConsole();
            if h.is_null() || !class_is_console(h) {
                None
            } else {
                Some(h)
            }
        }
    }

    unsafe extern "system" fn each_console_window(hwnd: HWND, lp: LPARAM) -> i32 {
        let out = &mut *(lp as *mut Vec<(u32, bool)>);
        if class_is_console(hwnd) {
            let mut p = 0u32;
            GetWindowThreadProcessId(hwnd, &mut p);
            if p != 0 {
                out.push((p, IsWindowVisible(hwnd) != 0));
            }
        }
        1
    }

    /// 所有 ConsoleWindowClass 頂層視窗的（擁有者程序編號, 可見）；只列出、不動，不用 AttachConsole
    pub fn console_windows() -> Vec<(u32, bool)> {
        let mut out: Vec<(u32, bool)> = Vec::new();
        unsafe {
            EnumWindows(Some(each_console_window), &mut out as *mut Vec<(u32, bool)> as LPARAM);
        }
        out
    }

    pub fn find_console(pid: u32) -> Option<WinConsole> {
        let mut s = Search { pid, found: std::ptr::null_mut() };
        unsafe {
            EnumWindows(Some(each_window), &mut s as *mut Search as LPARAM);
        }
        let hwnd = if s.found.is_null() { via_attach(pid)? } else { s.found };
        Some(WinConsole { hwnd: hwnd as isize as i64, visible: unsafe { IsWindowVisible(hwnd) } != 0 })
    }

    pub fn set_visible(hwnd: i64, visible: bool) -> Result<(), String> {
        let h = hwnd as isize as HWND;
        unsafe {
            ShowWindow(h, if visible { SW_SHOW } else { SW_HIDE });
            if visible {
                SetForegroundWindow(h);
            }
            if (IsWindowVisible(h) != 0) == visible {
                Ok(())
            } else {
                Err("ShowWindow 失敗".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(pid: u64, name: &str, started: u64, kind: &str) -> Value {
        json!({ "pid": pid, "name": name, "sessionId": "s", "status": "idle", "startedAt": started, "kind": kind })
    }

    #[test]
    fn 依名字挑活著的互動式工作階段_同名取最近啟動() {
        let all = vec![sess(10, "甲", 100, "interactive"), sess(11, "甲", 200, "interactive"), sess(12, "乙", 50, "interactive"), sess(13, "甲", 300, "background")];
        assert_eq!(pick_session_pid(&all, "甲", |_| true), Some(11));
        assert_eq!(pick_session_pid(&all, "甲", |p| p != 11), Some(10), "最近那筆程序已不在就退到次近的");
        assert_eq!(pick_session_pid(&all, "甲", |_| false), None);
        assert_eq!(pick_session_pid(&all, "丙", |_| true), None);
        assert_eq!(pick_session_pid(&all, "乙", |_| true), Some(12));
    }

    #[test]
    fn 沒有kind欄位也算_pid缺欄位時用檔名() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("77.json"), r#"{"name":"丁","status":"idle"}"#).unwrap();
        std::fs::write(d.path().join("88.json"), "壞掉的 json").unwrap();
        std::fs::write(d.path().join("99.txt"), r#"{"pid":99,"name":"丁"}"#).unwrap();
        let s = read_sessions(d.path());
        assert_eq!(s.len(), 1);
        assert_eq!(pick_session_pid(&s, "丁", |_| true), Some(77));
    }

    #[test]
    fn 沒有記錄資料夾_回空() {
        assert!(read_sessions(Path::new("Z:/不存在的資料夾/sessions")).is_empty());
    }

    #[test]
    fn 找不到視窗的原因_Windows_Terminal_要講清楚() {
        let wt = no_window_reason(true);
        assert!(wt.contains("Windows Terminal") && wt.contains("分頁"));
        assert_ne!(wt, no_window_reason(false));
        assert!(!no_window_reason(false).contains("Windows Terminal"));
    }

    #[test]
    fn 空名字_回說明_不當成找不到() {
        let q = query_console(&PartnerConsoleReq { engine: "claude".into(), name: String::new(), visible: None, kind: None, pid: None }).unwrap();
        assert!(!q.ok);
    }

    #[cfg(windows)]
    #[test]
    fn 自己的程序算活著_不存在的pid不算() {
        assert!(win::pid_alive(std::process::id()));
        assert!(!win::pid_alive(0x7fff_fff0));
    }


    /// 真的開一個隱藏的主控台子程序（跟 App 開夥伴同一招：powershell Start-Process -WindowStyle Hidden），
    /// 查詢、顯示一下、再隱藏、結束。只結束自己啟動並記下 PID 的那一個。
    /// 手動跑：cargo test --manifest-path src-tauri/Cargo.toml console_real -- --ignored --nocapture
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn console_real_假主控台子程序查詢與切換() {
        // 會在桌面上冒出主控台視窗（預設終端機是 Windows Terminal 時藏不住），只准人手動跑
        if std::env::var("ASN_MANUAL_TEST").as_deref() != Ok("1") { eprintln!("略過：要手動跑請設 ASN_MANUAL_TEST=1"); return; }
        use crate::nowin::NoWindow;
        let script = "$p = Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)";
        let out = std::process::Command::new("powershell").no_window().args(["-NoProfile", "-NonInteractive", "-Command", script]).output().unwrap();
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().expect("拿到 PID");
        struct Reap(u32);
        impl Drop for Reap {
            fn drop(&mut self) {
                let _ = std::process::Command::new("taskkill").no_window().args(["/PID", &self.0.to_string(), "/F"]).output();
            }
        }
        let reap = Reap(pid);
        std::thread::sleep(std::time::Duration::from_millis(800));
        assert!(win::pid_alive(pid));
        let w = win::find_console(pid).expect("應該找得到主控台視窗");
        eprintln!("pid={pid} hwnd={} 一開始可見={}", w.hwnd, w.visible);
        assert!(!w.visible, "Hidden 啟動的");
        win::set_visible(w.hwnd, true).unwrap();
        assert!(win::find_console(pid).unwrap().visible);
        win::set_visible(w.hwnd, false).unwrap();
        assert!(!win::find_console(pid).unwrap().visible);
        drop(reap);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!win::pid_alive(pid));
    }
}
