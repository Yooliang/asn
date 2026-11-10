//! ASN 意外關閉時自動重開（todo-next-191 B1，asn真 審定設計；只有 Windows）。
//!
//! 起因：11-03 10:07 asn.exe 停止回應被 Windows 關掉，內建的收發室跟著斷，要等人發現才重開。
//!
//! 做法：設定頁勾選後，替使用者建一個使用者層級的工作排程（名字見 task_name，不用系統管理員），
//! 每 5 分鐘執行 `asn.exe --guard`。守護不開畫面，只判斷一次就結束：
//! - ASN 在跑（alive.json 的 pid 還活著、而且確實是 asn.exe）：不動。心跳超過 3 分鐘沒更新（畫面卡住、還沒被關）只記一行 log，
//!   不開新的、也不關它（守護不關任何行程）。
//! - ASN 不在、而且上次是正常結束（使用者按結束、關視窗、更新安裝、登出關機都會走 cleanup 寫 user-quit）：不動。
//! - ASN 不在、上次不是正常結束（當掉、被系統以「停止回應」關掉、被工作管理員結束）：重開（帶 --background，縮在系統匣）。
//! - 一小時內已經重開 3 次：暫停自動重開，設定頁顯示「ASN 最近反覆被關閉，已暫停自動重開」，按「恢復」才再開始。
//! 不會開出兩個：只在確認 ASN 不在時才開；同一時間只有一個守護在跑（guard.lock）；萬一撞上，ASN 本身的
//! 「同一個視窗名只留一個」會讓後開的自己退出。
//! 預設關：公開發佈的程式不替使用者建排程，要使用者自己勾。
//!
//! 檔案都在 `%LOCALAPPDATA%\tw.yooliang.asn\guard\`：alive.json（pid、心跳時間）、user-quit（正常結束的記號）、
//! relaunch.json（最近重開的時間、是否暫停）、guard.log（只記判斷結果，不記任何內容）。
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const GUARD_FLAG: &str = "--guard";
/// 解除安裝時由 NSIS 呼叫（installer-hooks.nsh 的 NSIS_HOOK_PREUNINSTALL）：刪掉這個使用者的排程，找不到不算錯
pub const REMOVE_FLAG: &str = "--guard-remove";
/// ASN 自己多久更新一次心跳
pub const ALIVE_EVERY_MS: u64 = 60_000;
/// 心跳超過這麼久沒更新、程序卻還在：看起來卡住了（只記 log）。
/// 注意：心跳是另一條執行緒在寫，跟畫面那條無關，所以畫面卡住時心跳通常照常更新，這條幾乎不會觸發；
/// 只有整個程序都停住（例如被除錯器暫停、整台電腦卡死）才看得到。留著當紀錄，不靠它判斷畫面卡住
pub const HUNG_AFTER_MS: u64 = 3 * 60_000;
/// 一小時內最多重開幾次，超過就暫停
pub const MAX_RELAUNCH_PER_HOUR: usize = 3;
const HOUR_MS: u64 = 3_600_000;
const LOG_MAX_BYTES: u64 = 64 * 1024;

pub const PAUSED_TEXT: &str = "ASN 最近反覆被關閉，已暫停自動重開。";
pub const SETTING_LABEL: &str = "ASN 意外關閉時自動重新開啟";
pub const SETTING_NOTE: &str = "只在 ASN 意外關閉時重開，你自己按結束不會重開。";
pub const DEV_BUILD_MSG: &str = "開發版不能設定自動重新開啟，請用正式安裝的 ASN";

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Alive {
    pub pid: u32,
    pub t: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct Relaunches {
    #[serde(default)]
    pub times: Vec<u64>,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 在跑、或上次是正常結束、或已暫停
    Nothing,
    /// 程序還在但心跳太久沒更新：只記 log
    LogHung,
    /// 重開
    Relaunch,
    /// 一小時內重開太多次：暫停並記下
    Pause,
}

/// 判斷（純函式，好測）。`running`＝alive.json 的 pid 還活著、而且確實是 asn.exe
pub fn decide(alive: Option<Alive>, running: bool, user_quit: bool, r: &Relaunches, now: u64) -> Action {
    if running {
        return match alive {
            Some(a) if now.saturating_sub(a.t) > HUNG_AFTER_MS => Action::LogHung,
            _ => Action::Nothing,
        };
    }
    if user_quit || r.paused {
        return Action::Nothing;
    }
    if recent(r, now) >= MAX_RELAUNCH_PER_HOUR {
        return Action::Pause;
    }
    Action::Relaunch
}

fn recent(r: &Relaunches, now: u64) -> usize {
    r.times.iter().filter(|&&t| now.saturating_sub(t) < HOUR_MS).count()
}

/// 記下這次重開；只留一小時內的
pub fn with_relaunch(r: &Relaunches, now: u64) -> Relaunches {
    let mut times: Vec<u64> = r.times.iter().copied().filter(|&t| now.saturating_sub(t) < HOUR_MS).collect();
    times.push(now);
    Relaunches { times, paused: r.paused }
}

// ───────── 檔案 ─────────

/// 守護的資料夾（Windows 才有）；`LOCALAPPDATA` 沒設就是沒有
pub fn guard_dir() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let base = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(base).join(crate::datadir::NEW_ID).join("guard"))
}

fn alive_path(dir: &Path) -> PathBuf {
    dir.join("alive.json")
}
fn quit_path(dir: &Path) -> PathBuf {
    dir.join("user-quit")
}
fn relaunch_path(dir: &Path) -> PathBuf {
    dir.join("relaunch.json")
}

pub fn read_alive(dir: &Path) -> Option<Alive> {
    serde_json::from_str(&fs::read_to_string(alive_path(dir)).ok()?).ok()
}
pub fn read_relaunches(dir: &Path) -> Relaunches {
    fs::read_to_string(relaunch_path(dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn write_relaunches(dir: &Path, r: &Relaunches) {
    if let Ok(s) = serde_json::to_string(r) {
        let _ = crate::write_atomic(&relaunch_path(dir), &s);
    }
}
pub fn user_quit(dir: &Path) -> bool {
    quit_path(dir).exists()
}

/// ASN 開起來時：清掉「正常結束」的記號、寫心跳。要在「同一個視窗名只留一個」的檢查之後才呼叫（不然被擋下的那個會蓋掉別人的心跳）。
/// 暫停中、而且最近一小時沒有重開紀錄（＝這次是使用者自己開的，不是在反覆當掉的循環裡）：解除暫停，之後真的當掉照樣會重開
pub fn note_start(dir: &Path, pid: u32, now: u64) {
    let _ = fs::remove_file(quit_path(dir));
    touch_alive(dir, pid, now);
    let r = read_relaunches(dir);
    if r.paused && recent(&r, now) == 0 {
        resume(dir);
    }
}
pub fn touch_alive(dir: &Path, pid: u32, now: u64) {
    if let Ok(s) = serde_json::to_string(&Alive { pid, t: now }) {
        let _ = crate::write_atomic(&alive_path(dir), &s);
    }
}
/// 正常結束（cleanup 會呼叫：結束、關視窗、更新安裝、登出關機）：守護看到就不重開
pub fn note_user_quit(dir: &Path) {
    let _ = crate::write_atomic(&quit_path(dir), "1");
}
/// 設定頁按「恢復自動重開」：清掉暫停與重開紀錄
pub fn resume(dir: &Path) {
    write_relaunches(dir, &Relaunches::default());
}

fn log_line(dir: &Path, now: u64, text: &str) {
    use std::io::Write;
    let p = dir.join("guard.log");
    if fs::metadata(&p).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        let _ = fs::remove_file(&p);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{} {text}", crate::claude_quota::iso_secs(now as i64));
    }
}

// ───────── 守護本體（asn.exe --guard） ─────────

/// 同一時間只有一個守護：建得出 guard.lock 才往下做，做完刪掉；鎖檔超過 2 分鐘算殘留（上一個守護當掉），清掉重來
fn take_lock(dir: &Path) -> bool {
    let p = dir.join("guard.lock");
    let stale = fs::metadata(&p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_millis() > 120_000);
    if stale {
        let _ = fs::remove_file(&p);
    }
    fs::OpenOptions::new().write(true).create_new(true).open(&p).is_ok()
}

/// `asn.exe --guard`：判斷一次就結束。回傳結束碼（0）
pub fn run_guard() -> i32 {
    let Some(dir) = guard_dir() else { return 0 };
    if fs::create_dir_all(&dir).is_err() {
        return 0;
    }
    let now = crate::heartbeat::now_ms();
    if !take_lock(&dir) {
        return 0;
    }
    let alive = read_alive(&dir);
    let running = alive.is_some_and(|a| crate::heartbeat::pid_alive(a.pid) && crate::heartbeat::is_asn_process(a.pid) == Some(true));
    let r = read_relaunches(&dir);
    match decide(alive, running, user_quit(&dir), &r, now) {
        Action::Nothing => {}
        Action::LogHung => log_line(&dir, now, "ASN 還在，但超過 3 分鐘沒有更新心跳（可能卡住）；不開新的、不關它"),
        Action::Pause => {
            write_relaunches(&dir, &Relaunches { paused: true, ..r });
            log_line(&dir, now, "一小時內已重開 3 次，暫停自動重開");
        }
        Action::Relaunch => match relaunch() {
            Ok(()) => {
                write_relaunches(&dir, &with_relaunch(&r, now));
                log_line(&dir, now, "ASN 不在、上次不是正常結束：已重新開啟");
            }
            Err(e) => log_line(&dir, now, &format!("重新開啟失敗：{e}")),
        },
    }
    let _ = fs::remove_file(dir.join("guard.lock"));
    0
}

fn relaunch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    use crate::nowin::NoWindow;
    // ASN 是視窗程式，no_window 只是不另開主控台、標準輸入接 null，不影響它自己的視窗
    std::process::Command::new(exe).no_window().arg(crate::tray::BACKGROUND_FLAG).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ───────── 工作排程 ─────────

/// 排程名（工作排程器的根資料夾是全機共用的，要帶使用者才不會兩個帳號互蓋）：
/// 使用者名全是英數與 - _（最多 40 字）就直接用 `AsnGuard-<使用者名>`；有中文、空白或其他字元（#762 那類）一律改用
/// 使用者名（轉小寫）的雜湊前 8 碼 `AsnGuard-<8 位十六進位>`。排程名永遠只有英數與 - _，/TN 不用煩惱引號與編碼。
/// 解除安裝時由 asn.exe --guard-remove 用同一支函式算名字，NSIS 不用自己算。
pub fn task_name(user: &str) -> String {
    if user.is_empty() {
        return "AsnGuard".into();
    }
    if user.len() <= 40 && user.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return format!("AsnGuard-{user}");
    }
    format!("AsnGuard-{:08x}", fnv1a(user.to_lowercase().as_bytes()) >> 32)
}

/// FNV-1a 64 位元：固定演算法，同一個使用者名在每台電腦、每個版本都算出同一個值（換演算法會讓解除安裝找不到當初建的排程）
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// 排程內容（schtasks /Create /XML）。不用 /SC MINUTE：那樣建的排程預設「只在接電源時啟動、改用電池就停止」，
/// 筆電拔掉電源時守護根本不會跑。這裡明寫：
/// - 兩個觸發：登入後 1 分鐘、以及每 5 分鐘重複（不設結束時間）
/// - 用電池也跑、改用電池不停（DisallowStartIfOnBatteries／StopIfGoingOnBatteries＝false）
/// - 同時只跑一個（MultipleInstancesPolicy＝IgnoreNew）；ExecutionTimeLimit＝PT0S（守護一下就結束，這條是保險）
/// - 以目前使用者、一般權限、只在登入時執行（InteractiveToken／LeastPrivilege），不用系統管理員
/// `user_id`＝`網域\使用者名`；路徑與使用者名做 XML 跳脫（中文照原樣，檔案存 UTF-16）
pub fn task_xml(user_id: &str, exe: &Path) -> String {
    let u = xml_escape(user_id);
    let cmd = xml_escape(&exe.display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>ASN 意外關閉時自動重新開啟</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{u}</UserId>
      <Delay>PT1M</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{cmd}</Command>
      <Arguments>{GUARD_FLAG}</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// schtasks 讀 XML 檔要 UTF-16（小端、開頭帶 BOM）
pub fn utf16_bom(s: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

/// 建排程的參數（讀 XML 檔、已存在就覆寫）
pub fn create_args(name: &str, xml_path: &Path) -> Vec<String> {
    vec!["/Create".into(), "/TN".into(), name.into(), "/XML".into(), xml_path.display().to_string(), "/F".into()]
}
pub fn delete_args(name: &str) -> Vec<String> {
    vec!["/Delete".into(), "/TN".into(), name.into(), "/F".into()]
}
pub fn query_args(name: &str) -> Vec<String> {
    vec!["/Query".into(), "/TN".into(), name.into()]
}

// 使用者的意思（guard\enabled）：勾選時寫、取消時刪。排程以系統上實際的為準，但手動覆蓋安裝時 Tauri 的安裝程式
// 會先跑舊版的解除安裝（會刪排程），所以新版開起來時看到「有勾、排程卻不在」就照意思重建。
// 真的解除安裝不刪這個檔（分不出是升級還是解除安裝）；使用者在解除安裝時勾「刪除應用程式資料」才會一起清掉。
fn intent_path(dir: &Path) -> PathBuf {
    dir.join("enabled")
}
pub fn intended(dir: &Path) -> bool {
    intent_path(dir).exists()
}
fn set_intent(dir: &Path, on: bool) {
    if on {
        let _ = crate::write_atomic(&intent_path(dir), "1");
    } else {
        let _ = fs::remove_file(intent_path(dir));
    }
}

#[cfg(windows)]
mod sys {
    use crate::nowin::NoWindow;
    use std::process::Command;

    fn name() -> String {
        super::task_name(&std::env::var("USERNAME").unwrap_or_default())
    }
    fn user_id() -> String {
        let user = std::env::var("USERNAME").unwrap_or_default();
        match std::env::var("USERDOMAIN") {
            Ok(d) if !d.is_empty() => format!(r"{d}\{user}"),
            _ => user,
        }
    }
    pub fn exists() -> bool {
        Command::new("schtasks").no_window().args(super::query_args(&name())).output().map(|o| o.status.success()).unwrap_or(false)
    }
    pub fn set(on: bool, exe: &std::path::Path) -> Result<(), String> {
        if !on {
            return remove();
        }
        let dir = super::guard_dir().ok_or("找不到 ASN 的資料夾")?;
        std::fs::create_dir_all(&dir).map_err(|_| "建不了工作排程".to_string())?;
        let xml = dir.join("task.xml");
        std::fs::write(&xml, super::utf16_bom(&super::task_xml(&user_id(), exe))).map_err(|_| "建不了工作排程".to_string())?;
        let o = Command::new("schtasks").no_window().args(super::create_args(&name(), &xml)).output();
        let _ = std::fs::remove_file(&xml);
        match o {
            Ok(o) if o.status.success() => Ok(()),
            _ => Err("建不了工作排程".into()),
        }
    }
    /// 刪排程；找不到不算錯
    pub fn remove() -> Result<(), String> {
        let n = name();
        if !exists() {
            return Ok(());
        }
        let o = Command::new("schtasks").no_window().args(super::delete_args(&n)).output().map_err(|e| format!("刪不了工作排程：{e}"))?;
        if o.status.success() || crate::bridge::handoff::schtasks_not_found(&o.stderr) || crate::bridge::handoff::schtasks_not_found(&o.stdout) {
            Ok(())
        } else {
            Err("刪不了工作排程".into())
        }
    }
}
#[cfg(not(windows))]
mod sys {
    pub fn exists() -> bool {
        false
    }
    pub fn set(_on: bool, _exe: &std::path::Path) -> Result<(), String> {
        Err("這個系統還不支援自動重新開啟".into())
    }
    pub fn remove() -> Result<(), String> {
        Ok(())
    }
}

/// `asn.exe --guard-remove`（解除安裝時）：刪掉這個使用者的排程。最多等 10 秒（schtasks 卡住也不能卡住整個解除安裝），
/// 找不到、刪不掉、逾時都回 0
pub fn run_remove() -> i32 {
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = std::thread::Builder::new().name("asn-guard-remove".into()).spawn(move || {
        let _ = tx.send(sys::remove());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_secs(10));
    0
}

/// ASN 開起來時（背景執行緒）：有勾、排程卻不在（手動覆蓋安裝時被舊版的解除安裝刪掉）就照意思重建。開發版不建
pub fn restore_from_intent() {
    let Some(dir) = guard_dir() else { return };
    if !intended(&dir) || sys::exists() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if crate::tray::is_dev_build_path(&exe) {
        return;
    }
    let now = crate::heartbeat::now_ms();
    match sys::set(true, &exe) {
        Ok(()) => log_line(&dir, now, "有勾自動重新開啟、排程卻不在：已照設定重建"),
        Err(e) => log_line(&dir, now, &format!("照設定重建排程失敗：{e}")),
    }
}

// ───────── 設定頁 ─────────

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GuardView {
    pub supported: bool,
    pub on: bool,
    /// 暫停時的提示（使用者看得懂的話）；沒暫停是空字串
    pub paused: String,
    /// 不能開的原因（開發版）；可以開是空字串
    pub blocked: String,
}

pub fn view(on: bool, paused: bool, exe: Option<&Path>) -> GuardView {
    let supported = cfg!(windows);
    GuardView {
        supported,
        on: supported && on,
        paused: if supported && on && paused { PAUSED_TEXT.into() } else { String::new() },
        blocked: if exe.is_some_and(crate::tray::is_dev_build_path) { DEV_BUILD_MSG.into() } else { String::new() },
    }
}

/// 設定頁讀狀態（呼叫 schtasks，在背景執行緒跑）
#[cfg(feature = "gui")]
#[tauri::command]
pub async fn guard_get() -> GuardView {
    tokio::task::spawn_blocking(|| {
        let paused = guard_dir().map(|d| read_relaunches(&d).paused).unwrap_or(false);
        view(sys::exists(), paused, std::env::current_exe().ok().as_deref())
    })
    .await
    .unwrap_or_else(|_| view(false, false, None))
}

/// 設定頁開關：開＝建排程（開發版拒絕），關＝刪排程。關掉時一併清掉暫停狀態
#[cfg(feature = "gui")]
#[tauri::command]
pub async fn guard_set(on: bool) -> Result<GuardView, String> {
    tokio::task::spawn_blocking(move || {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if on && crate::tray::is_dev_build_path(&exe) {
            return Err(DEV_BUILD_MSG.to_string());
        }
        sys::set(on, &exe)?;
        if let Some(d) = guard_dir() {
            let _ = fs::create_dir_all(&d);
            set_intent(&d, on);
            if !on {
                resume(&d);
            }
        }
        let paused = guard_dir().map(|d| read_relaunches(&d).paused).unwrap_or(false);
        Ok(view(sys::exists(), paused, Some(&exe)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 設定頁「恢復自動重開」
#[cfg(feature = "gui")]
#[tauri::command]
pub async fn guard_resume() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        if let Some(d) = guard_dir() {
            resume(&d);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;
    fn a(age_ms: u64) -> Option<Alive> {
        Some(Alive { pid: 42, t: NOW - age_ms })
    }
    fn r(times: &[u64], paused: bool) -> Relaunches {
        Relaunches { times: times.to_vec(), paused }
    }

    #[test]
    fn 在跑就不動_心跳太久沒更新只記_log_不開新的() {
        assert_eq!(decide(a(30_000), true, false, &r(&[], false), NOW), Action::Nothing);
        assert_eq!(decide(a(HUNG_AFTER_MS + 1), true, false, &r(&[], false), NOW), Action::LogHung);
        // 在跑時不管有沒有正常結束記號、有沒有暫停，都不開
        assert_eq!(decide(a(HUNG_AFTER_MS + 1), true, true, &r(&[], true), NOW), Action::LogHung);
    }

    #[test]
    fn 不在_正常結束就不重開_不是正常結束才重開() {
        assert_eq!(decide(a(600_000), false, true, &r(&[], false), NOW), Action::Nothing, "使用者按結束：不重開");
        assert_eq!(decide(a(600_000), false, false, &r(&[], false), NOW), Action::Relaunch, "當掉或被關：重開");
        assert_eq!(decide(None, false, false, &r(&[], false), NOW), Action::Relaunch, "沒有心跳檔也算不在");
    }

    #[test]
    fn 一小時內重開_3_次就暫停_暫停後不再開_超過一小時的不算() {
        let two = r(&[NOW - 10 * 60_000, NOW - 20 * 60_000], false);
        assert_eq!(decide(None, false, false, &two, NOW), Action::Relaunch);
        let three = with_relaunch(&two, NOW);
        assert_eq!(three.times.len(), 3);
        assert_eq!(decide(None, false, false, &three, NOW + 60_000), Action::Pause);
        assert_eq!(decide(None, false, false, &r(&[], true), NOW), Action::Nothing, "暫停後不開");
        let old = r(&[NOW - 2 * HOUR_MS, NOW - 3 * HOUR_MS, NOW - 4 * HOUR_MS], false);
        assert_eq!(decide(None, false, false, &old, NOW), Action::Relaunch, "一小時前的不算");
        assert_eq!(with_relaunch(&old, NOW).times, vec![NOW], "只留一小時內的");
    }

    #[test]
    fn 記號與心跳檔_開起來清掉正常結束記號_恢復清掉暫停() {
        let d = tempfile::tempdir().unwrap();
        note_user_quit(d.path());
        assert!(user_quit(d.path()));
        note_start(d.path(), 7, NOW);
        assert!(!user_quit(d.path()));
        assert_eq!(read_alive(d.path()), Some(Alive { pid: 7, t: NOW }));
        write_relaunches(d.path(), &r(&[NOW], true));
        assert!(read_relaunches(d.path()).paused);
        resume(d.path());
        assert_eq!(read_relaunches(d.path()), Relaunches::default());
        // 壞掉的檔案當沒有
        fs::write(d.path().join("relaunch.json"), "壞").unwrap();
        assert_eq!(read_relaunches(d.path()), Relaunches::default());
    }

    #[test]
    fn 同一時間只有一個守護() {
        let d = tempfile::tempdir().unwrap();
        assert!(take_lock(d.path()));
        assert!(!take_lock(d.path()), "鎖還在就不做");
    }

    #[test]
    fn 排程名與參數() {
        assert_eq!(task_name("cwen0708"), "AsnGuard-cwen0708");
        assert_eq!(task_name("a_b-c"), "AsnGuard-a_b-c");
        assert_eq!(task_name(""), "AsnGuard");
        // 中文、空白、其他字元（#762 那類）、太長：改用雜湊前 8 碼，排程名只有英數
        let hashed = |n: &str| n.strip_prefix("AsnGuard-").is_some_and(|h| h.len() == 8 && h.bytes().all(|b| b.is_ascii_hexdigit()));
        let long = "x".repeat(41);
        for u in ["小良哥", "小良 哥", "John Smith", "user.name", "Ünïcödé", "a\"b", long.as_str()] {
            let n = task_name(u);
            assert!(hashed(&n), "{u} → {n}");
            assert_eq!(n, task_name(u), "同一個名字每次算出一樣的");
        }
        assert_ne!(task_name("小良哥"), task_name("小良 哥"), "不同的使用者名不撞");
        assert_eq!(task_name("John Smith"), task_name("john smith"), "Windows 使用者名不分大小寫");
        // 演算法固定：FNV-1a 64 的標準測試值（換掉會讓解除安裝算出的名字和當初建的不一樣）
        assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(task_name("John Smith"), format!("AsnGuard-{:08x}", fnv1a(b"john smith") >> 32));
        let xml = Path::new(r"C:\Users\小良 哥\AppData\Local\tw.yooliang.asn\guard\task.xml");
        assert_eq!(create_args("AsnGuard-u", xml), ["/Create", "/TN", "AsnGuard-u", "/XML", r"C:\Users\小良 哥\AppData\Local\tw.yooliang.asn\guard\task.xml", "/F"]);
        assert_eq!(delete_args("AsnGuard-u"), ["/Delete", "/TN", "AsnGuard-u", "/F"]);
        assert_eq!(query_args("AsnGuard-u"), ["/Query", "/TN", "AsnGuard-u"]);
    }

    #[test]
    fn 排程_xml_用電池也跑_登入與每_5_分鐘_同時只跑一個_路徑與使用者跳脫() {
        let exe = Path::new(r"C:\Users\小良 & 哥\AppData\Local\ASN\asn.exe");
        let x = task_xml(r"DESKTOP-1\小良 & 哥", exe);
        for want in [
            "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
            "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<LogonTrigger>",
            "<Delay>PT1M</Delay>",
            "<Interval>PT5M</Interval>",
            "<StopAtDurationEnd>false</StopAtDurationEnd>",
            "<LogonType>InteractiveToken</LogonType>",
            "<RunLevel>LeastPrivilege</RunLevel>",
            r"<UserId>DESKTOP-1\小良 &amp; 哥</UserId>",
            r"<Command>C:\Users\小良 &amp; 哥\AppData\Local\ASN\asn.exe</Command>",
            "<Arguments>--guard</Arguments>",
        ] {
            assert!(x.contains(want), "少了 {want}");
        }
        assert_eq!(x.matches("<UserId>").count(), 2, "登入觸發與執行身分都是目前使用者");
        assert!(!x.contains("<Duration>"), "每 5 分鐘重複不設結束時間");
        assert!(x.starts_with(r#"<?xml version="1.0" encoding="UTF-16"?>"#));
        // 存檔是 UTF-16 小端、帶 BOM
        let b = utf16_bom("<中");
        assert_eq!(&b[..2], &[0xFF, 0xFE]);
        assert_eq!(&b[2..], &[0x3C, 0x00, 0x2D, 0x4E]);
        assert_eq!(xml_escape(r#"a&b<c>d"e'f"#), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    }

    #[test]
    fn 使用者自己開_asn_且一小時內沒重開過_就解除暫停_還在循環裡就不解除() {
        let d = tempfile::tempdir().unwrap();
        write_relaunches(d.path(), &r(&[NOW - 2 * HOUR_MS], true));
        note_start(d.path(), 7, NOW);
        assert!(!read_relaunches(d.path()).paused, "一小時內沒有重開紀錄：使用者自己開的，解除暫停");
        write_relaunches(d.path(), &r(&[NOW - 10 * 60_000], true));
        note_start(d.path(), 7, NOW);
        assert!(read_relaunches(d.path()).paused, "一小時內還有重開：可能還在反覆當掉的循環裡，維持暫停");
    }

    #[test]
    fn 勾選的意思另存一份_手動覆蓋安裝被刪排程後可以照它重建() {
        let d = tempfile::tempdir().unwrap();
        assert!(!intended(d.path()));
        set_intent(d.path(), true);
        assert!(intended(d.path()));
        set_intent(d.path(), false);
        assert!(!intended(d.path()));
    }

    #[test]
    fn 設定頁狀態_暫停提示是人話_開發版擋下() {
        let exe = Path::new(r"C:\Users\u\AppData\Local\ASN\asn.exe");
        let v = view(true, true, Some(exe));
        if cfg!(windows) {
            assert_eq!(v.paused, PAUSED_TEXT);
            assert!(!v.paused.contains("pid") && !v.paused.contains("AsnGuard"));
        }
        assert_eq!(view(true, false, Some(exe)).paused, "");
        assert_eq!(view(true, false, Some(Path::new(r"G:\x\target\release\asn.exe"))).blocked, DEV_BUILD_MSG);
        assert_eq!(view(false, true, Some(exe)).paused, "", "沒開就不顯示暫停");
    }
}
