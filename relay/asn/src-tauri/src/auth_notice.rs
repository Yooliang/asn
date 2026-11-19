//! 登入失效要看得見（#1764）。
//!
//! 以前 `signing_token` 把所有失敗吞成 None、群組列表悄悄降級成沒簽章的版本、手機清掉登入也不留任何記錄，
//! 使用者只看到「群組不見了」。這裡把原因分清楚、寫一行記錄（只有原因代碼，絕不含任何憑證），
//! 並在登入被清掉時發出同一個事件，讓電腦和手機的畫面都能提醒「需要重新登入」。
//! 呼叫端的行為不變：拿不到憑證就照舊不帶簽章，只是多了原因可以往上報。
use crate::auth::{AuthState, ERR_LOGIN_EXPIRED, ERR_NOT_SIGNED_IN};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 登入被清掉時發給畫面的事件（電腦與手機同一個名字；ui/lib/relogin-bar.mjs 也用這個字串）
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub const AUTH_LOST_EVENT: &str = "auth-signed-out";

/// 拿不到本人簽章憑證的原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigningFail {
    /// 還沒登入（或已登出）
    NotSignedIn,
    /// 換憑證沒成功，多半是網路或登入服務暫時有問題（登入還在，之後會再試）
    RefreshFailed,
    /// 登入服務拒絕了更新憑證，登入已被清掉，要重新登入
    LoginExpired,
    /// 讀不到存在本機的登入檔
    ReadFailed,
    /// 找不到後台設定（公開金鑰），沒辦法換憑證
    NoConfig,
}

impl SigningFail {
    /// 寫進記錄與回給畫面的代碼：英數與底線，不含任何憑證或帳號
    pub fn code(self) -> &'static str {
        match self {
            SigningFail::NotSignedIn => "not_signed_in",
            SigningFail::RefreshFailed => "refresh_failed",
            SigningFail::LoginExpired => "login_expired",
            SigningFail::ReadFailed => "read_failed",
            SigningFail::NoConfig => "no_config",
        }
    }

    /// 登入本身已經不在了（要本人重新登入才會好）；暫時性的失敗不算
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn needs_relogin(self) -> bool {
        matches!(self, SigningFail::NotSignedIn | SigningFail::LoginExpired)
    }
}

/// 把 `access_token` 的失敗訊息分成原因。`store_readable`＝登入檔讀得出來（讀不出來一律是 ReadFailed）
pub fn classify(err: &str, store_readable: bool) -> SigningFail {
    if !store_readable {
        SigningFail::ReadFailed
    } else if err == ERR_NOT_SIGNED_IN {
        SigningFail::NotSignedIn
    } else if err == ERR_LOGIN_EXPIRED {
        SigningFail::LoginExpired
    } else {
        SigningFail::RefreshFailed
    }
}

/// 取本人簽章用的登入憑證，失敗回原因。逾時（`wait`）算換憑證失敗
pub async fn token_or_fail(auth: &AuthState, client: &reqwest::Client, auth_base: &str, anon: &str, wait: Duration) -> Result<String, SigningFail> {
    match tokio::time::timeout(wait, auth.access_token(client, auth_base, anon)).await {
        Ok(Ok(t)) if !t.is_empty() => Ok(t),
        Ok(Ok(_)) => Err(SigningFail::RefreshFailed),
        Ok(Err(e)) => Err(classify(&e, auth.store.load().is_ok())),
        Err(_) => Err(SigningFail::RefreshFailed),
    }
}

/// 群組列表的結果加上 `signed`（有沒有帶本人簽章）；沒帶時再加 `reason`（原因代碼）。
/// 畫面看到 `signed:false` 就要在群組清單原本的位置說一句話，不能安靜地少一半。後台回的不是物件就原樣回
pub fn mark_signed(mut v: Value, why: Option<SigningFail>) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.insert("signed".into(), json!(why.is_none()));
        if let Some(f) = why {
            o.insert("reason".into(), json!(f.code()));
        }
    }
    v
}

// ---------- 記錄 ----------

/// 同一個原因十分鐘內只寫一行：失敗期間每次寄信、讀群組都會經過這裡，不能把記錄檔灌滿
const LOG_AGAIN_MS: i64 = 10 * 60_000;

pub type FailMemo = Mutex<Option<(SigningFail, i64)>>;

/// 要不要寫這一行：第一次、換了原因、或距離上次寫超過十分鐘
pub fn should_log(last: Option<(SigningFail, i64)>, f: SigningFail, now_ms: i64) -> bool {
    match last {
        Some((lf, at)) => lf != f || now_ms - at >= LOG_AGAIN_MS,
        None => true,
    }
}

pub fn fail_line(now_ms: i64, f: SigningFail) -> String {
    format!("{} info [ASN] 登入憑證取不到，這次不帶本人簽章：{}", iso_secs(now_ms), f.code())
}

/// 清掉登入時寫的一行（detail 只有狀態碼與錯誤代碼）。電腦版沿用 ui_log 的同一句話
pub fn signout_line(now_ms: i64, detail: &str) -> String {
    format!("{} info [ASN] 登入服務拒絕更新憑證，已清掉登入：{}", iso_secs(now_ms), detail)
}

/// 把失敗記進 `dir` 的 ui.log（有節流）；資料夾是空路徑（截圖模式、還沒有節點金鑰）就不寫
pub fn report_fail_to(dir: &Path, memo: &FailMemo, f: SigningFail, now_ms: i64) -> bool {
    if dir.as_os_str().is_empty() {
        return false;
    }
    let mut g = memo.lock().unwrap_or_else(|e| e.into_inner());
    if !should_log(*g, f, now_ms) {
        return false;
    }
    *g = Some((f, now_ms));
    append_line(dir, &fail_line(now_ms, f));
    true
}

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static MEMO: FailMemo = Mutex::new(None);

/// 啟動時設一次：記錄放的資料夾（和 ui.log 同一處）
pub fn set_log_dir(dir: &Path) {
    let _ = LOG_DIR.set(dir.to_path_buf());
}

/// `signing_token` 失敗時呼叫：寫一行記錄，不影響呼叫端
pub fn report_fail(f: SigningFail) {
    if let Some(dir) = LOG_DIR.get() {
        report_fail_to(dir, &MEMO, f, crate::heartbeat::now_ms() as i64);
    }
}

#[cfg(all(desktop, feature = "gui"))]
fn append_line(dir: &Path, line: &str) {
    let _ = crate::ui_log::append(dir, &[line.to_string()]);
}

/// 手機（和沒有視窗的版本）沒有 ui_log：直接附加到同一個 ui.log（寫不進去就算了；超過 1 MB 只留後半，和電腦版同一個規矩）
#[cfg(not(all(desktop, feature = "gui")))]
fn append_line(dir: &Path, line: &str) {
    append_plain(dir, line);
}

#[cfg_attr(all(desktop, feature = "gui"), allow(dead_code))]
fn append_plain(dir: &Path, line: &str) {
    use std::io::Write;
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if dir.as_os_str().is_empty() {
        return;
    }
    let p = dir.join("ui.log");
    if std::fs::metadata(&p).map(|m| m.len() > 1024 * 1024).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            let mid = t.len() / 2;
            let keep = t.as_bytes()[mid..].iter().position(|&b| b == b'\n').map(|i| &t[mid + i + 1..]).unwrap_or("");
            let _ = std::fs::write(&p, keep);
        }
    }
    let clean: String = line.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{clean}");
    }
}

/// 手機用的「清掉登入」記錄器（電腦版用 ui_log::signout_logger，同一句話）
#[cfg_attr(desktop, allow(dead_code))]
pub fn file_signout_logger(dir: PathBuf) -> Box<dyn Fn(&str) + Send + Sync> {
    Box::new(move |detail| append_plain(&dir, &signout_line(crate::heartbeat::now_ms() as i64, detail)))
}

/// 清掉登入時要做的事：先記錄，再發事件（電腦與手機共用同一個組合，不各寫一份）
pub fn signout_hook(log: Box<dyn Fn(&str) + Send + Sync>, emit: Box<dyn Fn() + Send + Sync>) -> Box<dyn Fn(&str) + Send + Sync> {
    Box::new(move |detail| {
        log(detail);
        emit();
    })
}

/// 毫秒 → `2026-10-24T12:00:00Z`（手機沒有 claude_quota，自己算）
fn iso_secs(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let (y, m, d) = crate::timeutil::civil_from_days(s.div_euclid(86400));
    let r = s.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, r % 3600 / 60, r % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{StoredLogin, TokenStore};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Default)]
    struct MemStore(Mutex<Option<StoredLogin>>);
    impl TokenStore for MemStore {
        fn load(&self) -> Result<Option<StoredLogin>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, l: &StoredLogin) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(l.clone());
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    /// 讀檔會失敗的儲存層（像登入檔解不開）
    struct BrokenStore;
    impl TokenStore for BrokenStore {
        fn load(&self) -> Result<Option<StoredLogin>, String> {
            Err("解不開".into())
        }
        fn save(&self, _: &StoredLogin) -> Result<(), String> {
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            Ok(())
        }
    }

    fn signed_in(rt: &str) -> AuthState {
        let s = MemStore::default();
        s.save(&StoredLogin { refresh_token: rt.into(), email: None }).unwrap();
        AuthState::new(Box::new(s))
    }

    /// 回一次固定回應的假登入服務
    fn fake_server(status: &'static str, body: &'static str) -> (u16, std::thread::JoinHandle<()>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = vec![0u8; 8192];
            let mut n = 0;
            while n < buf.len() {
                let k = s.read(&mut buf[n..]).unwrap();
                if k == 0 {
                    break;
                }
                n += k;
                let t = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Some(i) = t.find("\r\n\r\n") {
                    let len = t.to_ascii_lowercase().split("content-length:").nth(1).and_then(|r| r.trim().split("\r\n").next().and_then(|x| x.trim().parse::<usize>().ok())).unwrap_or(0);
                    if n >= i + 4 + len {
                        break;
                    }
                }
            }
            let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        });
        (port, h)
    }

    const WAIT: Duration = Duration::from_secs(4);

    #[tokio::test]
    async fn 沒登入回_not_signed_in() {
        let a = AuthState::new(Box::new(MemStore::default()));
        let r = token_or_fail(&a, &reqwest::Client::new(), "http://127.0.0.1:1", "A", WAIT).await;
        assert_eq!(r, Err(SigningFail::NotSignedIn));
        assert!(SigningFail::NotSignedIn.needs_relogin());
    }

    #[tokio::test]
    async fn 登入服務拒絕後回_login_expired_不是暫時失敗() {
        let a = signed_in("RT");
        let (p, h) = fake_server("400 Bad Request", r#"{"error_code":"refresh_token_not_found"}"#);
        let r = token_or_fail(&a, &reqwest::Client::new(), &format!("http://127.0.0.1:{p}"), "A", WAIT).await;
        let _ = h.join();
        assert_eq!(r, Err(SigningFail::LoginExpired));
        assert!(SigningFail::LoginExpired.needs_relogin());
        assert!(!a.status().signed_in, "被拒絕就清掉登入（判斷邏輯沒動）");
    }

    #[tokio::test]
    async fn 連不上登入服務回_refresh_failed_登入還在() {
        let a = signed_in("RT");
        let (p, h) = fake_server("503 Service Unavailable", "{}");
        let r = token_or_fail(&a, &reqwest::Client::new(), &format!("http://127.0.0.1:{p}"), "A", WAIT).await;
        let _ = h.join();
        assert_eq!(r, Err(SigningFail::RefreshFailed));
        assert!(!SigningFail::RefreshFailed.needs_relogin(), "暫時失敗不叫人重新登入");
        assert!(a.status().signed_in);
    }

    #[tokio::test]
    async fn 逾時算換憑證失敗() {
        let a = signed_in("RT");
        // 只接連線不回話
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let p = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let _c = l.accept();
            std::thread::sleep(Duration::from_millis(400));
        });
        let r = token_or_fail(&a, &reqwest::Client::new(), &format!("http://127.0.0.1:{p}"), "A", Duration::from_millis(80)).await;
        let _ = h.join();
        assert_eq!(r, Err(SigningFail::RefreshFailed));
    }

    #[tokio::test]
    async fn 登入檔讀不到回_read_failed() {
        let a = AuthState::new(Box::new(BrokenStore));
        let r = token_or_fail(&a, &reqwest::Client::new(), "http://127.0.0.1:1", "A", WAIT).await;
        assert_eq!(r, Err(SigningFail::ReadFailed));
    }

    #[test]
    fn 原因代碼只有英數與底線_五種各不相同() {
        let all = [SigningFail::NotSignedIn, SigningFail::RefreshFailed, SigningFail::LoginExpired, SigningFail::ReadFailed, SigningFail::NoConfig];
        let mut seen = std::collections::HashSet::new();
        for f in all {
            assert!(f.code().chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{}", f.code());
            assert!(seen.insert(f.code()));
        }
    }

    #[test]
    fn 記錄節流_同原因十分鐘內不重寫_換原因或過了十分鐘才寫() {
        let f = SigningFail::LoginExpired;
        assert!(should_log(None, f, 1_000));
        assert!(!should_log(Some((f, 1_000)), f, 1_000 + 60_000));
        assert!(should_log(Some((f, 1_000)), SigningFail::NotSignedIn, 2_000));
        assert!(should_log(Some((f, 1_000)), f, 1_000 + LOG_AGAIN_MS));
    }

    #[test]
    fn 失敗寫一行記錄_只有原因代碼() {
        let d = tempfile::tempdir().unwrap();
        let memo: FailMemo = Mutex::new(None);
        assert!(report_fail_to(d.path(), &memo, SigningFail::LoginExpired, 1_760_000_000_000));
        assert!(!report_fail_to(d.path(), &memo, SigningFail::LoginExpired, 1_760_000_060_000), "節流");
        let t = std::fs::read_to_string(d.path().join("ui.log")).unwrap();
        assert_eq!(t.lines().count(), 1, "{t}");
        assert!(t.contains("login_expired") && t.contains("[ASN]"), "{t}");
        assert!(!t.to_lowercase().contains("token") && !t.contains("eyJ"), "{t}");
    }

    #[test]
    fn 資料夾是空路徑就不寫() {
        let memo: FailMemo = Mutex::new(None);
        assert!(!report_fail_to(Path::new(""), &memo, SigningFail::NotSignedIn, 5));
    }

    #[test]
    fn 群組列表帶_signed_沒簽章時多一個原因() {
        let ok = mark_signed(json!({ "rooms": [] }), None);
        assert_eq!(ok["signed"], json!(true));
        assert!(ok.get("reason").is_none());
        let bad = mark_signed(json!({ "rooms": [1] }), Some(SigningFail::LoginExpired));
        assert_eq!((bad["signed"].clone(), bad["reason"].clone(), bad["rooms"].clone()), (json!(false), json!("login_expired"), json!([1])));
        assert_eq!(mark_signed(json!(null), Some(SigningFail::NoConfig)), json!(null), "不是物件就原樣回");
    }

    #[test]
    fn 清掉登入的組合_先記錄再發事件_手機也一樣() {
        let logged = Arc::new(Mutex::new(Vec::<String>::new()));
        let emitted = Arc::new(AtomicUsize::new(0));
        let (l2, e2) = (logged.clone(), emitted.clone());
        let hook = signout_hook(Box::new(move |d| l2.lock().unwrap().push(d.to_string())), Box::new(move || {
            e2.fetch_add(1, Ordering::SeqCst);
        }));
        hook("status=400 error_code=session_not_found");
        assert_eq!(logged.lock().unwrap().as_slice(), ["status=400 error_code=session_not_found"]);
        assert_eq!(emitted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn 手機的清掉登入記錄器寫進_ui_log_不含憑證() {
        let d = tempfile::tempdir().unwrap();
        file_signout_logger(d.path().to_path_buf())("status=400 error_code=refresh_token_not_found");
        let t = std::fs::read_to_string(d.path().join("ui.log")).unwrap();
        assert!(t.contains("已清掉登入：status=400 error_code=refresh_token_not_found"), "{t}");
        assert_eq!(signout_line(0, "x"), "1970-01-01T00:00:00Z info [ASN] 登入服務拒絕更新憑證，已清掉登入：x");
    }
}
