//! 這台電腦「實際登入的 Claude 帳號」（#1880）：只讀 `.claude.json` 的 `oauthAccount.emailAddress`，不碰任何權杖檔。
//!
//! 三件事：
//! 1. **讀**：[`read_login`] 把檔案讀成三種結果（有帳號／沒登入／讀不到），讀不到不會被當成沒登入，也不會沿用舊值。
//! 2. **監看**：[`start`] 用檔案變化通知（不輪詢）盯著那份檔，一變就重讀；帳號跟上次不同、變成沒登入、或變成讀不到，
//!    立刻叫醒帳號回報（[`WAKE`]）並通知額度重查，不等 5 分鐘一輪。
//! 3. **切換驗證**：切換帳號寫完檔之後，用同一個讀法讀回來比對（[`verify_switched`]），對不上就是切換失敗。
//!
//! 讀哪一份：有設 `CLAUDE_CONFIG_DIR` 就是那個資料夾裡的 `.claude.json`（資料夾裡沒有才看家目錄）；沒設就是 `~/.claude.json`。
//! 紅線：函式一律吃路徑參數；只有 [`spawn_watch`] 會決定真實家目錄，測試不得呼叫它。
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 畫面上「讀不到目前登入的帳號」的固定文字（電腦與手機同一份，由 Rust 回給畫面）
pub const UNREADABLE_TEXT: &str = "讀不到目前登入的帳號";
/// 切換後讀回來帳號沒換：畫面上的固定文字
pub const SWITCH_FAILED_TEXT: &str = "切換沒有成功：這台電腦登入的帳號沒有換過去。請再切換一次；還是不行，就到 Claude 視窗用那個帳號重新登入。";

/// 家目錄之外，有設定資料夾環境變數時以那邊為準；沒有 `.claude.json` 才看家目錄
pub fn live_json_path(home: &Path, cfg_env: Option<OsString>) -> PathBuf {
    match cfg_env {
        Some(v) if !v.is_empty() => {
            let p = PathBuf::from(v).join(".claude.json");
            if p.exists() {
                p
            } else {
                home.join(".claude.json")
            }
        }
        _ => home.join(".claude.json"),
    }
}

/// 讀一次的結果
#[derive(Debug, Clone, PartialEq)]
pub enum Login {
    /// 目前登入的帳號（正規化的 email）
    In(String),
    /// 檔案不存在，或沒有 `oauthAccount`：沒登入
    NotLoggedIn,
    /// 檔案在、但讀不出帳號（打不開、壞掉、沒有 email）。內容是給 log 用的固定原因，不含檔案內容
    Unreadable(String),
}

/// 讀 `.claude.json`，只取 `oauthAccount.emailAddress`
pub fn read_login(path: &Path) -> Login {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Login::NotLoggedIn,
        Err(e) => return Login::Unreadable(format!("打不開（{}）", e.kind())),
    };
    let frag = match crate::claude_accounts::extract_fragment(&text) {
        Ok(Some(f)) => f,
        Ok(None) => return Login::NotLoggedIn,
        Err(_) => return Login::Unreadable("檔案格式不對".into()),
    };
    let email = serde_json::from_str::<serde_json::Value>(&frag).ok().and_then(|v| v.get("emailAddress").and_then(|x| x.as_str()).and_then(crate::claude_accounts::normalize_email));
    match email {
        Some(e) => Login::In(e),
        None => Login::Unreadable("帳號資訊裡沒有 email".into()),
    }
}

/// Claude 自己改寫這個檔不是一次寫完的：讀不到時隔一下再讀一次，免得把「寫到一半」當成讀不到
pub fn read_login_retry(path: &Path, wait: std::time::Duration) -> Login {
    match read_login(path) {
        Login::Unreadable(_) => {
            std::thread::sleep(wait);
            read_login(path)
        }
        other => other,
    }
}

/// 兩次讀取之間發生的變化
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// 登入的帳號換了（含從讀不到、沒登入恢復成有帳號）
    Email(String),
    /// 本來有帳號、現在沒登入了
    LoggedOut,
    /// 現在讀不到（同一個原因連續發生只回報第一次）
    Unreadable(String),
}

/// 記著上一次讀到什麼，判斷這一次要不要回報
#[derive(Default)]
pub struct Tracker {
    last: Option<Login>,
}

impl Tracker {
    /// 看這一次的讀取結果。第一次只記下來（有帳號、沒登入不回報；讀不到要回報，免得一開始就讀不到卻沒人知道）
    pub fn observe(&mut self, now: Login) -> Option<Change> {
        let prev = self.last.replace(now.clone());
        match (prev, now) {
            (None, Login::Unreadable(r)) => Some(Change::Unreadable(r)),
            (None, _) => None,
            (Some(a), b) if a == b => None,
            (_, Login::In(e)) => Some(Change::Email(e)),
            (_, Login::NotLoggedIn) => Some(Change::LoggedOut),
            (Some(Login::Unreadable(_)), Login::Unreadable(_)) => None,
            (_, Login::Unreadable(r)) => Some(Change::Unreadable(r)),
        }
    }
}

// ---------- 叫醒帳號回報 ----------
/// 帳號回報迴圈（acct_remote::report_loop）等這個：叫一聲就立刻回報一次，不等下一個 5 分鐘
pub static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub fn wake_report() {
    WAKE.notify_one();
}

// ---------- log ----------
#[cfg_attr(not(all(feature = "gui", desktop)), allow(dead_code))]
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub fn set_log_dir(dir: &Path) {
    let _ = LOG_DIR.set(dir.to_path_buf());
}

/// 寫一行到 ui.log（還沒設資料夾就只寫 stderr）。只放固定句型與 email，不放檔案內容、不放權杖
pub fn log(line: &str) {
    elog!("[claude-login] {line}");
    #[cfg(all(feature = "gui", desktop))]
    if let Some(dir) = LOG_DIR.get() {
        let _ = crate::ui_log::append(dir, &[format!("{} info [ASN] {line}", crate::quota_core::iso_secs(crate::heartbeat::now_ms() as i64))]);
    }
}

// ---------- 切換驗證 ----------
/// 切換之後讀回來對不上的原因
#[derive(Debug, PartialEq)]
pub enum NotSwitched {
    /// 讀回來是另一個帳號（或沒登入）
    Other(Option<String>),
    Unreadable(String),
}

/// 切換寫完後讀回實際登入的帳號，要是 `expected`（已正規化）才算切成功
pub fn verify_switched(path: &Path, expected: &str, wait: std::time::Duration) -> Result<(), NotSwitched> {
    match read_login_retry(path, wait) {
        Login::In(e) if e == expected => Ok(()),
        Login::In(e) => Err(NotSwitched::Other(Some(e))),
        Login::NotLoggedIn => Err(NotSwitched::Other(None)),
        Login::Unreadable(r) => Err(NotSwitched::Unreadable(r)),
    }
}

// ---------- 監看（手機沒有本機 Claude，不編進去） ----------
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod watch {
    use super::*;
    use notify::{RecursiveMode, Watcher};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    /// 監看中的把手：放掉就停
    pub struct Handle {
        _w: notify::RecommendedWatcher,
    }

    /// 開始監看 `path`：盯它所在的資料夾（檔案常是「寫暫存檔再改名」，盯檔案本身會漏），只理會這個檔名的事件。
    /// 事件停下 `debounce` 之後才讀一次，帳號有變就呼叫 `on_change`。開始前先讀一次當基準。
    /// 開不起來（資料夾不存在、系統不給）回錯誤原因，呼叫端要記 log。
    pub fn start(path: PathBuf, debounce: Duration, on_change: impl Fn(Change) + Send + 'static) -> Result<Handle, String> {
        let dir = path.parent().ok_or("沒有所在的資料夾")?.to_path_buf();
        let name = path.file_name().ok_or("沒有檔名")?.to_os_string();
        let tracker = Arc::new(Mutex::new(Tracker::default()));
        let first = tracker.lock().unwrap_or_else(|e| e.into_inner()).observe(read_login_retry(&path, debounce));
        let (tx, rx) = mpsc::channel::<Result<notify::Event, notify::Error>>();
        let mut w = notify::recommended_watcher(move |ev| {
            let _ = tx.send(ev);
        })
        .map_err(|e| format!("建立監看失敗：{e}"))?;
        w.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| format!("監看資料夾失敗：{e}"))?;
        if let Some(c) = first {
            on_change(c);
        }
        std::thread::spawn(move || {
            // 沒有收件端時（Handle 放掉、watcher 跟著結束）recv 回錯誤，執行緒就結束
            while let Ok(ev) = rx.recv() {
                let mut dirty = match &ev {
                    Ok(e) => e.paths.iter().any(|p| p.file_name() == Some(name.as_os_str())),
                    Err(e) => {
                        log(&format!("監看 Claude 登入檔時出錯，重讀一次：{e}"));
                        true
                    }
                };
                // 同一陣子的一串事件合成一次；資料夾裡別的檔案一直在動時也最多等這麼久，不會一直拖著不讀
                let deadline = std::time::Instant::now() + debounce * 8;
                while let Ok(more) = rx.recv_timeout(debounce) {
                    dirty |= match &more {
                        Ok(e) => e.paths.iter().any(|p| p.file_name() == Some(name.as_os_str())),
                        Err(_) => true,
                    };
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                }
                if !dirty {
                    continue;
                }
                let change = tracker.lock().unwrap_or_else(|e| e.into_inner()).observe(read_login_retry(&path, debounce));
                if let Some(c) = change {
                    on_change(c);
                }
            }
        });
        Ok(Handle { _w: w })
    }

    /// 背景監看真實的登入檔：開不起來就記 log、每分鐘再試（只在開不起來時才會再試，平常不輪詢）。
    /// 帳號有變：記 log、叫醒帳號回報、叫額度立刻重查。
    #[cfg_attr(not(feature = "gui"), allow(dead_code))]
    pub fn spawn_watch(home: PathBuf) {
        std::thread::spawn(move || {
            let path = live_json_path(&home, std::env::var_os("CLAUDE_CONFIG_DIR"));
            let mut logged: Option<String> = None;
            loop {
                match start(path.clone(), Duration::from_millis(400), |c| {
                    match &c {
                        Change::Email(e) => log(&format!("Claude 目前登入的帳號換成 {e}，立刻回報")),
                        Change::LoggedOut => log("Claude 目前沒有登入的帳號，立刻回報"),
                        Change::Unreadable(r) => log(&format!("{UNREADABLE_TEXT}：{r}")),
                    }
                    crate::claude_quota::kick();
                    wake_report();
                }) {
                    Ok(_handle) => {
                        if logged.take().is_some() {
                            log("已重新開始監看 Claude 目前登入的帳號");
                        }
                        // 把手要一直留著；這條執行緒沒別的事，停在這裡
                        loop {
                            std::thread::park();
                        }
                    }
                    Err(why) => {
                        if logged.as_deref() != Some(why.as_str()) {
                            log(&format!("{UNREADABLE_TEXT}：沒辦法監看登入檔的變化（{why}）"));
                            logged = Some(why);
                        }
                        std::thread::sleep(Duration::from_secs(60));
                    }
                }
            }
        });
    }
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use watch::{spawn_watch, start, Handle};

#[cfg(test)]
mod tests;
