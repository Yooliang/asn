//! 設定頁「已安裝的工具」（#1548 ④）：每家一列的狀態——版本、是不是最新版、登入狀態。只看不裝。
//!
//! - 版本：沿用偵測時 `--version` 的結果。
//! - 最新版：只向安裝流程已在用的官方網址 GET 版本號（Claude stable 頻道、Codex latest 頻道、Gemini 官方 manifest），
//!   不帶任何使用者資料；有逾時（`TimedFetch`，10 秒）、成功的結果記 6 小時；失敗、逾時、看不懂一律「暫時查不到」，絕不當成「過期」。
//!   Grok、pi 沒有官方來源，一律「暫時查不到」。
//! - 登入：只問各 CLI 自己的狀態指令（Claude `auth status`、Codex `login status`、pi `auth check`），絕不讀憑證檔；
//!   Grok、Gemini 沒有可靠方式，一律「查不到」。

use super::catalog::{tools, ToolDef};
use crate::agent_setup::net::{Fetch, TimedFetch};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 查到的最新版記這麼久（只在使用者按「重新檢查」時略過）
pub const LATEST_TTL: Duration = Duration::from_secs(6 * 3600);
/// 查失敗的結果只記這麼短（退避：不讓每次開設定頁都重打一次壞掉的網址；「重新檢查」一樣略過）
pub const LATEST_FAIL_TTL: Duration = Duration::from_secs(60);
/// 問登入狀態最多等這麼久
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ToolStatusRow {
    pub id: String,
    pub installed: bool,
    /// 讀到的版本號；沒裝、讀不到都是空字串
    pub version: String,
    /// "latest"（已是最新版）／"behind"（有新版）／"unknown"（暫時查不到）
    pub version_state: String,
    /// 有新版時才有值
    pub latest: String,
    /// "in"（已登入）／"out"（沒有登入）／"unknown"（查不到）
    pub login: String,
    /// 已登入的家數（只有 pi 可以同時登入好幾家；其他是 0）
    pub login_count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolsStatusSnapshot {
    pub checked_at: String,
    pub tools: Vec<ToolStatusRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionState {
    Latest,
    Behind,
    Unknown,
}

impl VersionState {
    fn as_str(self) -> &'static str {
        match self {
            VersionState::Latest => "latest",
            VersionState::Behind => "behind",
            VersionState::Unknown => "unknown",
        }
    }
}

/// `數字.數字.數字` → 三個數字；其他格式（少一段、多一段、帶字母、空字串）一律 None
fn triple(v: &str) -> Option<[u64; 3]> {
    if !crate::agent_setup::verified_install::valid_version(v) {
        return None;
    }
    let mut it = v.split('.').map(|p| p.parse::<u64>().ok());
    Some([it.next()??, it.next()??, it.next()??])
}

/// 已安裝的版本跟官方最新版比：最新版較大才是「有新版」；相等或安裝的較新（例如測試版）都算「已是最新版」；
/// 任何一邊看不懂就是「暫時查不到」，不猜
pub fn compare_versions(installed: &str, latest: &str) -> VersionState {
    match (triple(installed), triple(latest)) {
        (Some(a), Some(b)) if b > a => VersionState::Behind,
        (Some(_), Some(_)) => VersionState::Latest,
        _ => VersionState::Unknown,
    }
}

/// 最新版的快取：成功記 6 小時、失敗只記 1 分鐘；`force` 略過快取
#[derive(Default)]
pub struct LatestCache {
    map: Mutex<HashMap<String, (Instant, Option<String>)>>,
}

impl LatestCache {
    /// 這家的最新版；快取還新鮮就直接回，否則呼叫 `fetch`（網路只在這裡發生）。失敗回 None 並把原因寫進記錄
    pub fn get(&self, id: &str, now: Instant, force: bool, fetch: impl FnOnce() -> Result<String, String>) -> Option<String> {
        if !force {
            let g = self.map.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, v)) = g.get(id) {
                let ttl = if v.is_some() { LATEST_TTL } else { LATEST_FAIL_TTL };
                if now.saturating_duration_since(*at) < ttl {
                    return v.clone();
                }
            }
        }
        let v = match fetch() {
            Ok(v) => Some(v),
            Err(e) => {
                elog!("[ASN] 查 {id} 最新版失敗（畫面顯示「暫時查不到」）：{e}");
                None
            }
        };
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), (now, v.clone()));
        v
    }
}

static CACHE: std::sync::LazyLock<LatestCache> = std::sync::LazyLock::new(LatestCache::default);

/// 各家官方版本來源；沒有來源的（Grok、pi）回 None
fn latest_from_vendor(id: &str, fetch: &dyn Fetch) -> Option<Result<String, String>> {
    use crate::agent_setup::{agy_install, claude_install, codex_install};
    match id {
        "claude" => Some(claude_install::latest_version(fetch)),
        "codex" => Some(codex_install::latest_version(fetch)),
        "agy" => Some(agy_install::latest_version(fetch)),
        _ => None,
    }
}

/// 這家目前官方最新版；沒有來源、查不到、逾時、看不懂都是 None
pub fn latest_for(cache: &LatestCache, id: &str, now: Instant, force: bool, fetch: &dyn Fetch) -> Option<String> {
    // 先問有沒有來源：沒有來源的家不進快取、不發任何請求
    if !matches!(id, "claude" | "codex" | "agy") {
        return None;
    }
    cache.get(id, now, force, || latest_from_vendor(id, fetch).unwrap_or_else(|| Err("沒有官方來源".into())))
}

/// 版本狀態與要顯示的最新版（只有「有新版」才帶版本號）
pub fn version_view(installed: &str, latest: Option<&str>) -> (VersionState, String) {
    let Some(l) = latest else { return (VersionState::Unknown, String::new()) };
    let s = compare_versions(installed, l);
    (s, if s == VersionState::Behind { l.to_string() } else { String::new() })
}

/// 登入狀態：（"in"／"out"／"unknown"，已登入的家數）
pub type Login = (&'static str, u32);

/// 各 CLI 自己的狀態指令換成統一的三態；Grok、Gemini 沒有可靠方式
pub fn login_for(id: &str, force: bool) -> Login {
    use crate::agent_setup::{claude_login, device_login};
    let Some(exe) = super::resolve_binary(match id {
        "claude" | "codex" | "pi" => id,
        _ => return ("unknown", 0),
    }) else {
        return ("unknown", 0);
    };
    match id {
        "claude" => claude_login_view(claude_login::login_state(&exe, &claude_login::RealCapture)),
        "codex" => codex_login_view(device_login::codex_login_check(&exe, LOGIN_TIMEOUT)),
        _ => pi_login_view(&crate::launch::pi_models::providers_real(force)),
    }
}

pub fn claude_login_view(s: crate::agent_setup::claude_login::LoginState) -> Login {
    use crate::agent_setup::claude_login::LoginState;
    match s {
        LoginState::In => ("in", 0),
        LoginState::Out => ("out", 0),
        LoginState::Unknown(_) => ("unknown", 0),
    }
}

pub fn codex_login_view(c: crate::agent_setup::device_login::Check) -> Login {
    use crate::agent_setup::device_login::Check;
    match c {
        Check::Yes => ("in", 0),
        Check::No => ("out", 0),
        Check::Unknown(_) => ("unknown", 0),
    }
}

/// `providers_real` 的每家提供者：有任何一家 ready 就是已登入（帶家數）；都不是 ready 但有明確回答 not_ready／missing 就是沒登入；其餘查不到
pub fn pi_login_view(providers: &serde_json::Value) -> Login {
    let states: Vec<&str> = providers.as_array().map(|a| a.iter().filter_map(|r| r["state"].as_str()).collect()).unwrap_or_default();
    let ready = states.iter().filter(|s| **s == "ready").count() as u32;
    if ready > 0 {
        ("in", ready)
    } else if states.iter().any(|s| matches!(*s, "not_ready" | "missing")) {
        ("out", 0)
    } else {
        ("unknown", 0)
    }
}

fn row_for(d: &ToolDef, force: bool, fetch: &(dyn Fetch + Sync), cache: &LatestCache) -> ToolStatusRow {
    let det = super::detect_row(d);
    let mut r = ToolStatusRow { id: d.id.clone(), installed: det.binary_found, version: det.version.clone(), version_state: "unknown".into(), latest: String::new(), login: "unknown".into(), login_count: 0 };
    if !det.binary_found {
        return r;
    }
    let (vs, latest) = version_view(&det.version, latest_for(cache, &d.id, Instant::now(), force, fetch).as_deref());
    r.version_state = vs.as_str().into();
    r.latest = latest;
    let (login, n) = login_for(&d.id, force);
    r.login = login.into();
    r.login_count = n;
    r
}

/// 五家同時查（各自的指令與網路請求都有逾時），整份最多等約 10 秒
pub fn status_snapshot(force: bool, fetch: &(dyn Fetch + Sync), cache: &LatestCache) -> ToolsStatusSnapshot {
    let defs = tools();
    let rows = std::thread::scope(|s| {
        let jobs: Vec<_> = defs.iter().map(|d| (d, s.spawn(move || row_for(d, force, fetch, cache)))).collect();
        jobs.into_iter()
            .map(|(d, h)| h.join().unwrap_or_else(|_| ToolStatusRow { id: d.id.clone(), installed: false, version: String::new(), version_state: "unknown".into(), latest: String::new(), login: "unknown".into(), login_count: 0 }))
            .collect()
    });
    ToolsStatusSnapshot { checked_at: super::checked_at(), tools: rows }
}

/// 真的環境的版本與登入狀態；`force`＝使用者按了「重新檢查」，略過最新版與 pi 的快取
pub fn status_here(force: bool) -> ToolsStatusSnapshot {
    status_snapshot(force, &TimedFetch, &CACHE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_setup::claude_login::LoginState;
    use crate::agent_setup::device_login::Check;
    use serde_json::json;
    use std::cell::RefCell;
    use std::io::Write;

    /// 假的官方網站：依網址回固定內容，沒放的網址回錯；記下每次請求（測試不連真網路）
    #[derive(Default)]
    struct FakeFetch {
        pages: HashMap<String, Result<String, String>>,
        log: RefCell<Vec<String>>,
    }
    impl Fetch for FakeFetch {
        fn get_text(&self, url: &str, _max: u64) -> Result<String, String> {
            self.log.borrow_mut().push(url.to_string());
            self.pages.get(url).cloned().unwrap_or_else(|| Err("沒有這一頁".into()))
        }
        fn download(&self, _u: &str, _o: &mut dyn Write, _m: u64) -> Result<u64, String> {
            panic!("查最新版不該下載任何檔案")
        }
    }
    const CLAUDE_URL: &str = "https://downloads.claude.ai/claude-code-releases/stable";
    const CODEX_URL: &str = "https://releases.openai.com/codex/channels/latest";

    fn codex_body(tag: &str) -> String {
        json!({ "tag_name": tag, "assets": [] }).to_string()
    }
    fn fake(claude: Result<&str, &str>, codex: Result<String, &str>) -> FakeFetch {
        let mut f = FakeFetch::default();
        f.pages.insert(CLAUDE_URL.into(), claude.map(String::from).map_err(String::from));
        f.pages.insert(CODEX_URL.into(), codex.map_err(String::from));
        f
    }

    #[test]
    fn 版本比較_相等_較舊_較新_看不懂() {
        assert_eq!(compare_versions("2.0.31", "2.0.31"), VersionState::Latest);
        assert_eq!(compare_versions("0.46.0", "0.48.0"), VersionState::Behind);
        assert_eq!(compare_versions("0.9.0", "0.10.0"), VersionState::Behind, "按數字比、不是按字串比");
        assert_eq!(compare_versions("1.0.0", "0.99.9"), VersionState::Latest, "安裝的比官方新（測試版）不叫有新版");
        for bad in ["", "2.0", "2.0.31.1", "v2.0.31", "2.0.x", "latest", "2.0.31-beta"] {
            assert_eq!(compare_versions(bad, "2.0.31"), VersionState::Unknown, "安裝版 {bad:?}");
            assert_eq!(compare_versions("2.0.31", bad), VersionState::Unknown, "最新版 {bad:?}");
        }
    }

    #[test]
    fn 有新版才帶版本號_查不到絕不說過期() {
        assert_eq!(version_view("0.46.0", Some("0.48.0")), (VersionState::Behind, "0.48.0".into()));
        assert_eq!(version_view("2.0.31", Some("2.0.31")), (VersionState::Latest, String::new()));
        assert_eq!(version_view("0.46.0", None), (VersionState::Unknown, String::new()), "查不到最新版：不是過期、也不是最新");
        assert_eq!(version_view("", Some("0.48.0")), (VersionState::Unknown, String::new()), "讀不到本機版本");
    }

    #[test]
    fn 各家查最新版_用安裝流程同一套解析() {
        let cache = LatestCache::default();
        let f = fake(Ok("2.0.31\n"), Ok(codex_body("rust-v0.48.0")));
        let t = Instant::now();
        assert_eq!(latest_for(&cache, "claude", t, false, &f).as_deref(), Some("2.0.31"));
        assert_eq!(latest_for(&cache, "codex", t, false, &f).as_deref(), Some("0.48.0"));
        // Grok、pi 沒有官方來源：不發任何請求
        let before = f.log.borrow().len();
        assert_eq!(latest_for(&cache, "grok", t, false, &f), None);
        assert_eq!(latest_for(&cache, "pi", t, false, &f), None);
        assert_eq!(f.log.borrow().len(), before);
        // 只連安裝流程已在用的官方網址
        assert!(f.log.borrow().iter().all(|u| u == CLAUDE_URL || u == CODEX_URL), "{:?}", f.log.borrow());
    }

    #[test]
    fn 網路失敗_逾時_亂字串都是查不到() {
        let t = Instant::now();
        for (why, claude, codex) in [
            ("網路失敗", Err("連不上官方下載網站"), Err("連不上官方下載網站")),
            ("逾時", Err("連不上官方下載網站：operation timed out"), Err("下載中斷：timed out")),
            ("亂字串", Ok("<html>oops</html>"), Ok("not json".to_string())),
            ("版本格式不對", Ok("latest"), Ok(codex_body("rust-v1.2"))),
            ("沒有標籤", Ok("2.0"), Ok("{}".to_string())),
        ] {
            let cache = LatestCache::default();
            let f = fake(claude, codex);
            assert_eq!(latest_for(&cache, "claude", t, false, &f), None, "{why}：claude");
            assert_eq!(latest_for(&cache, "codex", t, false, &f), None, "{why}：codex");
            assert_eq!(version_view("2.0.31", latest_for(&cache, "claude", t, true, &f).as_deref()).0, VersionState::Unknown, "{why}：畫面不該說過期");
        }
    }

    #[test]
    fn 快取_六小時內不重抓_重新檢查略過_失敗只記一分鐘() {
        let cache = LatestCache::default();
        let f = fake(Ok("2.0.31"), Ok(codex_body("rust-v0.48.0")));
        let t0 = Instant::now();
        let n = || f.log.borrow().iter().filter(|u| *u == CLAUDE_URL).count();
        assert_eq!(latest_for(&cache, "claude", t0, false, &f).as_deref(), Some("2.0.31"));
        assert_eq!(n(), 1);
        assert_eq!(latest_for(&cache, "claude", t0 + Duration::from_secs(5 * 3600), false, &f).as_deref(), Some("2.0.31"));
        assert_eq!(n(), 1, "6 小時內不重抓");
        assert_eq!(latest_for(&cache, "claude", t0 + Duration::from_secs(5 * 3600), true, &f).as_deref(), Some("2.0.31"));
        assert_eq!(n(), 2, "重新檢查略過快取");
        latest_for(&cache, "claude", t0 + Duration::from_secs(5 * 3600 + 6 * 3600 + 1), false, &f);   // 5 小時那次重新檢查重新記了時間，所以從那時起算 6 小時
        assert_eq!(n(), 3, "過了 6 小時重抓");
        // 失敗：1 分鐘內不狂打，過了就再試；之後恢復就拿得到
        let cache = LatestCache::default();
        let bad = fake(Err("連不上"), Err("連不上"));
        latest_for(&cache, "claude", t0, false, &bad);
        latest_for(&cache, "claude", t0 + Duration::from_secs(30), false, &bad);
        assert_eq!(bad.log.borrow().len(), 1, "失敗 1 分鐘內不重打");
        latest_for(&cache, "claude", t0 + Duration::from_secs(61), false, &bad);
        assert_eq!(bad.log.borrow().len(), 2);
    }

    #[test]
    fn 登入狀態對照() {
        assert_eq!(claude_login_view(LoginState::In), ("in", 0));
        assert_eq!(claude_login_view(LoginState::Out), ("out", 0));
        assert_eq!(claude_login_view(LoginState::Unknown("x".into())), ("unknown", 0));
        assert_eq!(codex_login_view(Check::Yes), ("in", 0));
        assert_eq!(codex_login_view(Check::No), ("out", 0));
        assert_eq!(codex_login_view(Check::Unknown("x".into())), ("unknown", 0));
        // pi：任一家 ready 就是已登入並帶家數；只有 not_ready／missing 是沒登入；全部 unknown 是查不到
        let p = |a: &[&str]| json!(a.iter().map(|s| json!({ "provider": "p", "state": s })).collect::<Vec<_>>());
        assert_eq!(pi_login_view(&p(&["ready", "not_ready", "ready", "missing"])), ("in", 2));
        assert_eq!(pi_login_view(&p(&["not_ready", "missing"])), ("out", 0));
        assert_eq!(pi_login_view(&p(&["unknown", "unknown"])), ("unknown", 0));
        assert_eq!(pi_login_view(&json!([])), ("unknown", 0));
        assert_eq!(pi_login_view(&json!("garbage")), ("unknown", 0));
        // Grok、Gemini：沒有可靠方式，一律查不到（不跑任何指令）
        assert_eq!(login_for("grok", false), ("unknown", 0));
        assert_eq!(login_for("agy", false), ("unknown", 0));
    }

    #[test]
    fn claude_登入狀態用偵測到的執行檔_不只認固定位置() {
        use crate::agent_setup::claude_login::{login_state_of, CaptureRunner};
        use std::path::{Path, PathBuf};
        struct Rec(RefCell<Vec<PathBuf>>);
        impl CaptureRunner for Rec {
            fn run(&self, exe: &Path, _args: &[&str], _t: Duration) -> Result<(i32, String), String> {
                self.0.borrow_mut().push(exe.to_path_buf());
                Ok((0, r#"{"loggedIn":true,"authMethod":"claude.ai"}"#.into()))
            }
        }
        let r = Rec(RefCell::new(vec![]));
        let on_path = PathBuf::from("D:/tools/npm/claude.cmd");
        assert_eq!(login_state_of(Some(on_path.clone()), &r), LoginState::In);
        assert_eq!(*r.0.borrow(), vec![on_path], "問的是偵測到的那支，不是 ~/.local/bin/claude.exe");
        assert_eq!(login_state_of(None, &r), LoginState::Out, "找不到執行檔當作還沒登入，也不跑任何指令");
        assert_eq!(r.0.borrow().len(), 1);
    }

    #[test]
    fn 守門_三個網址都是安裝流程已在用的官方網址() {
        let f = fake(Ok("2.0.31"), Ok(codex_body("rust-v0.48.0")));
        let t = Instant::now();
        let cache = LatestCache::default();
        latest_for(&cache, "claude", t, true, &f);
        latest_for(&cache, "codex", t, true, &f);
        latest_for(&cache, "agy", t, true, &f);
        let log = f.log.borrow();
        assert_eq!(log.len(), 3);
        assert!(log[2].starts_with("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/"), "{}", log[2]);
    }
}
