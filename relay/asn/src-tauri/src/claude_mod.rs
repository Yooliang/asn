//! 自動幫 Claude Code 安裝 ASN 外掛（relay/claude-mod，#134）。
//!
//! 外掛檔案隨 ASN 安裝包放在安裝資料夾的 `claude-mod\`（見 tauri.conf.json 的 bundle.resources）。
//! ASN 啟動後在背景做一次：找 `claude` → 查有沒有裝 `asn@asn`。
//! 規矩：
//! - 第一次（沒有標記檔 `claude-mod.json`）才預設安裝：`marketplace add` + `install --scope user`，裝好就是啟用。
//! - Claude Code 會把外掛複製進自己的快取（~/.claude/plugins/cache/...），不是直接讀 ASN 安裝資料夾，
//!   所以 ASN 更新後要主動讓它更新：標記裡的版本和安裝資料夾的外掛版本不同時，
//!   已安裝（不論啟用或停用）→ `marketplace update asn` 再 `update asn@asn --scope <list 給的>`；
//!   使用者已自行解除安裝 → 不重裝，只更新標記版本。
//! - 絕不 enable／disable：使用者停用的維持停用。
//! - 失敗不更新標記，下次啟動再試。
//! - 所有子程序：不開視窗、乾淨環境（同 launch/config.rs 的 child_env）、stdin 接空、有逾時；逾時只殺自己啟動的那個子程序。
//! - 找不到 claude、或安裝／更新失敗都不擋 ASN，只記一行 log 並把原因顯示在設定頁。
use crate::nowin::NoWindow;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 外掛在 marketplace 裡的識別（外掛名@marketplace 名）
pub const PLUGIN_ID: &str = "asn@asn";
/// marketplace 名（`plugin marketplace update` 用）
pub const MARKETPLACE: &str = "asn";
/// 單一 claude 指令的逾時
pub const CMD_TIMEOUT: Duration = Duration::from_secs(60);
const MARKER_FILE: &str = "claude-mod.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// 已安裝（版本＝標記／外掛資料夾的版本）
    Installed(String),
    /// 使用者自行解除安裝了：不重裝
    Uninstalled,
    NoClaude,
    Failed(String),
    UpdateFailed(String),
}

impl Outcome {
    /// 設定頁那一行（純中文）
    pub fn line(&self) -> String {
        match self {
            Outcome::Installed(v) if v.is_empty() => "Claude 外掛：已安裝".into(),
            Outcome::Installed(v) => format!("Claude 外掛：已安裝（版本 {v}）"),
            Outcome::Uninstalled => "Claude 外掛：未安裝（已由使用者解除安裝，不會自動重裝）".into(),
            Outcome::NoClaude => "Claude 外掛：未安裝（找不到 Claude Code）".into(),
            Outcome::Failed(why) => format!("Claude 外掛：安裝失敗：{why}"),
            Outcome::UpdateFailed(why) => format!("Claude 外掛：更新失敗：{why}"),
        }
    }
}

/// 設定頁讀的狀態文字（還沒跑完時是「檢查中」；--shot 模式不跑，維持空字串）
#[derive(Default)]
pub struct ModState(pub Mutex<String>);

pub struct RunOut {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub trait Runner {
    fn run(&self, claude: &Path, args: &[&str]) -> Result<RunOut, String>;
}

/// 真正跑子程序的實作：不開視窗、env_clear＋乾淨環境、stdin 接空、逾時就殺掉自己啟動的子程序
pub struct RealRunner {
    pub env: HashMap<String, String>,
    pub timeout: Duration,
}

impl Runner for RealRunner {
    fn run(&self, claude: &Path, args: &[&str]) -> Result<RunOut, String> {
        let mut child = std::process::Command::new(claude)
            .args(args)
            .env_clear()
            .envs(&self.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
            .map_err(|e| format!("無法執行 Claude Code（{e}）"))?;
        // 讀管線放到執行緒，避免輸出塞滿卡住；逾時殺掉後不等這些執行緒（孫程序可能還握著管線）
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let err = Arc::new(Mutex::new(Vec::<u8>::new()));
        let pump = |mut r: Box<dyn Read + Send>, sink: Arc<Mutex<Vec<u8>>>| {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    sink.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            })
        };
        let h1 = child.stdout.take().map(|s| pump(Box::new(s), out.clone()));
        let h2 = child.stderr.take().map(|s| pump(Box::new(s), err.clone()));
        let start = Instant::now();
        let code = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st.code(),
                Ok(None) => {}
                Err(e) => return Err(format!("等待 Claude Code 失敗（{e}）")),
            }
            if start.elapsed() >= self.timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Claude Code 超過 {} 秒沒有回應，已中止", self.timeout.as_secs().max(1)));
            }
            std::thread::sleep(Duration::from_millis(30));
        };
        for h in [h1, h2].into_iter().flatten() {
            let _ = h.join();
        }
        let text = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap()).into_owned();
        Ok(RunOut { code, stdout: text(&out), stderr: text(&err) })
    }
}

/// 在 PATH 各資料夾找 claude（Windows 找 .exe／.cmd，其他系統找 claude）；PATH 找不到再看 extra（例如 ~/.local/bin）
pub fn find_claude(path_var: &OsStr, extra: &[PathBuf]) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    std::env::split_paths(path_var)
        .chain(extra.iter().cloned())
        .find_map(|d| names.iter().map(|n| d.join(n)).find(|p| p.is_file()))
}

fn plugin_version(mod_dir: &Path) -> Option<String> {
    let t = std::fs::read_to_string(mod_dir.join(".claude-plugin").join("plugin.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&t).ok()?;
    v.get("version")?.as_str().map(String::from)
}

/// 標記檔裡的 (installedVersion, dir)；沒有或壞掉＝None（視為第一次）
fn read_marker(data_dir: &Path) -> Option<(String, Option<String>)> {
    let t = std::fs::read_to_string(data_dir.join(MARKER_FILE)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&t).ok()?;
    let ver = v.get("installedVersion")?.as_str()?.to_string();
    Some((ver, v.get("dir").and_then(|x| x.as_str()).map(String::from)))
}

fn write_marker(data_dir: &Path, mod_dir: &Path, now_secs: u64) {
    let ver = plugin_version(mod_dir).unwrap_or_default();
    let body = serde_json::json!({ "installedVersion": ver, "installedAt": now_secs, "dir": mod_dir.to_string_lossy() });
    if let Err(e) = crate::write_atomic(&data_dir.join(MARKER_FILE), &format!("{}\n", serde_json::to_string_pretty(&body).unwrap_or_default())) {
        eprintln!("[claude-mod] 寫標記檔失敗：{e}");
    }
}

fn short(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(120).collect()
}

fn fail_text(what: &str, r: &RunOut) -> String {
    let detail = short(if r.stderr.trim().is_empty() { &r.stdout } else { &r.stderr });
    if detail.is_empty() {
        format!("{what}失敗（結束碼 {}）", r.code.map_or("不明".into(), |c| c.to_string()))
    } else {
        format!("{what}失敗：{detail}")
    }
}

/// `claude plugin list` 裡 asn@asn 那一項
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub scope: String,
    pub version: Option<String>,
}

/// 解析 `plugin list` 輸出。`--json`（陣列，每項有 id／enabled／scope／version／installPath）優先；
/// 不是 JSON 才退回純文字（找得到 asn@asn 就算已安裝，scope 當 user）。
fn parse_listing(stdout: &str) -> Option<Listed> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if let Some(arr) = v.as_array() {
            return arr.iter().find(|e| e.get("id").and_then(|x| x.as_str()).is_some_and(|i| i.eq_ignore_ascii_case(PLUGIN_ID))).map(|e| Listed {
                scope: e.get("scope").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or("user").to_string(),
                version: e.get("version").and_then(|x| x.as_str()).map(String::from),
            });
        }
    }
    stdout.to_ascii_lowercase().contains(PLUGIN_ID).then(|| Listed { scope: "user".into(), version: None })
}

fn list_asn(runner: &dyn Runner, claude: &Path) -> Result<Option<Listed>, String> {
    let listed = match runner.run(claude, &["plugin", "list", "--json"]) {
        Ok(r) if r.code == Some(0) => r,
        _ => match runner.run(claude, &["plugin", "list"]) {
            Ok(r) if r.code == Some(0) => r,
            Ok(r) => return Err(fail_text("查詢已安裝外掛", &r)),
            Err(e) => return Err(e),
        },
    };
    Ok(parse_listing(&listed.stdout))
}

/// 已安裝（含使用者停用的）→ 更新到安裝資料夾的版本。只跑 marketplace update 與 update，絕不 enable／disable。
fn update_installed(runner: &dyn Runner, claude: &Path, scope: &str) -> Result<(), String> {
    // 外掛來源是本機資料夾，先讓 Claude Code 重讀來源，update 才看得到新版
    match runner.run(claude, &["plugin", "marketplace", "update", MARKETPLACE]) {
        Ok(r) if r.code == Some(0) => {}
        Ok(r) => return Err(fail_text("重新整理外掛來源", &r)),
        Err(e) => return Err(e),
    }
    match runner.run(claude, &["plugin", "update", PLUGIN_ID, "--scope", scope]) {
        Ok(r) if r.code == Some(0) => Ok(()),
        Ok(r) => Err(fail_text("更新外掛", &r)),
        Err(e) => Err(e),
    }
}

/// 主流程（可用假的 Runner 測）。`claude` 是已找到的執行檔路徑。`first`＝沒有標記檔（第一次）。
pub fn install_with(runner: &dyn Runner, claude: &Path, mod_dir: &Path, data_dir: &Path, now_secs: u64, first: bool) -> Outcome {
    let want = plugin_version(mod_dir).unwrap_or_default();
    let listed = match list_asn(runner, claude) {
        Ok(l) => l,
        Err(e) => return if first { Outcome::Failed(e) } else { Outcome::UpdateFailed(e) },
    };
    match listed {
        Some(p) => {
            // 第一次且版本已經一樣：只補標記
            if first && p.version.as_deref() == Some(want.as_str()) {
                write_marker(data_dir, mod_dir, now_secs);
                return Outcome::Installed(want);
            }
            match update_installed(runner, claude, &p.scope) {
                Ok(()) => {
                    write_marker(data_dir, mod_dir, now_secs);
                    Outcome::Installed(want)
                }
                Err(e) => Outcome::UpdateFailed(e),
            }
        }
        None if !first => {
            // 使用者自己解除安裝了：尊重，不重裝；更新標記版本避免每次啟動都來查
            eprintln!("[claude-mod] 使用者已解除安裝 {PLUGIN_ID}，不重裝，只更新標記版本為 {want}");
            write_marker(data_dir, mod_dir, now_secs);
            Outcome::Uninstalled
        }
        None => first_install(runner, claude, mod_dir, data_dir, now_secs, want),
    }
}

fn first_install(runner: &dyn Runner, claude: &Path, mod_dir: &Path, data_dir: &Path, now_secs: u64, want: String) -> Outcome {
    let dir = mod_dir.to_string_lossy().into_owned();
    match runner.run(claude, &["plugin", "marketplace", "add", &dir]) {
        Ok(r) if r.code == Some(0) => {}
        other => {
            // marketplace 可能早就加過了：列出來有 asn 就繼續，否則回報原因
            let known = matches!(runner.run(claude, &["plugin", "marketplace", "list"]), Ok(l) if l.code == Some(0) && l.stdout.to_ascii_lowercase().contains("asn"));
            if !known {
                return Outcome::Failed(match other {
                    Ok(r) => fail_text("加入外掛來源", &r),
                    Err(e) => e,
                });
            }
        }
    }
    // 不帶 disable／enable：裝好就是預設啟用狀態
    match runner.run(claude, &["plugin", "install", PLUGIN_ID, "--scope", "user"]) {
        Ok(r) if r.code == Some(0) => {
            write_marker(data_dir, mod_dir, now_secs);
            Outcome::Installed(want)
        }
        Ok(r) => Outcome::Failed(fail_text("安裝外掛", &r)),
        Err(e) => Outcome::Failed(e),
    }
}

/// 入口：標記的版本和資料夾一致就不碰 Claude Code；沒標記＝第一次安裝；標記版本不同＝更新（或尊重解除安裝）。
pub fn run(runner: &dyn Runner, path_var: &OsStr, extra: &[PathBuf], mod_dir: &Path, data_dir: &Path, now_secs: u64) -> Outcome {
    let want = plugin_version(mod_dir);
    let marker = read_marker(data_dir);
    if let (Some((mv, md)), Some(w)) = (&marker, &want) {
        if mv == w && md.as_ref().map_or(true, |d| *d == mod_dir.to_string_lossy()) {
            return Outcome::Installed(w.clone());
        }
    }
    let Some(claude) = find_claude(path_var, extra) else {
        eprintln!("[claude-mod] 找不到 claude 指令，略過外掛安裝");
        return Outcome::NoClaude;
    };
    if want.is_none() {
        eprintln!("[claude-mod] 安裝資料夾裡沒有外掛檔案：{}", mod_dir.display());
        return Outcome::Failed("安裝資料夾裡找不到外掛檔案".into());
    }
    let out = install_with(runner, &claude, mod_dir, data_dir, now_secs, marker.is_none());
    eprintln!("[claude-mod] {}", out.line());
    out
}

/// 安裝資料夾裡的外掛資料夾（執行檔旁邊的 claude-mod）
pub fn bundled_dir() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("claude-mod"))
}

/// 背景執行的完整入口（阻塞，呼叫端放進 spawn_blocking）
pub fn run_real(data_dir: &Path) -> Outcome {
    let Some(mod_dir) = bundled_dir() else { return Outcome::Failed("找不到安裝資料夾".into()) };
    let runner = RealRunner { env: crate::launch::config::child_env(), timeout: CMD_TIMEOUT };
    let home = crate::identity::home_dir();
    let extra = [home.join(".local").join("bin")];
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    run(&runner, &std::env::var_os("PATH").unwrap_or_default(), &extra, &mod_dir, data_dir, now)
}

#[tauri::command]
pub fn claude_mod_status(s: tauri::State<'_, ModState>) -> String {
    s.0.lock().map(|g| g.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 假的 Runner：記下每次呼叫的參數，依序回預先排好的結果（排完了就回成功＋空輸出）
    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        replies: RefCell<Vec<Result<RunOut, String>>>,
    }
    fn ok(out: &str) -> Result<RunOut, String> {
        Ok(RunOut { code: Some(0), stdout: out.into(), stderr: String::new() })
    }
    fn bad(err: &str) -> Result<RunOut, String> {
        Ok(RunOut { code: Some(1), stdout: String::new(), stderr: err.into() })
    }
    impl Fake {
        fn new(replies: Vec<Result<RunOut, String>>) -> Self {
            Fake { calls: RefCell::new(vec![]), replies: RefCell::new(replies.into_iter().rev().collect()) }
        }
        fn log(&self) -> Vec<String> {
            self.calls.borrow().iter().map(|c| c.join(" ")).collect()
        }
    }
    impl Runner for Fake {
        fn run(&self, _c: &Path, args: &[&str]) -> Result<RunOut, String> {
            self.calls.borrow_mut().push(args.iter().map(|s| s.to_string()).collect());
            self.replies.borrow_mut().pop().unwrap_or_else(|| ok(""))
        }
    }

    fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let m = t.path().join("claude-mod");
        std::fs::create_dir_all(m.join(".claude-plugin")).unwrap();
        std::fs::write(m.join(".claude-plugin").join("plugin.json"), r#"{"name":"asn","version":"1.2.3"}"#).unwrap();
        let d = t.path().join("data");
        std::fs::create_dir_all(&d).unwrap();
        (t, m, d)
    }
    fn marker(d: &Path) -> Option<serde_json::Value> {
        serde_json::from_str(&std::fs::read_to_string(d.join(MARKER_FILE)).ok()?).ok()
    }
    const CLAUDE: &str = "claude";

    #[test]
    fn 沒裝過_先查再加來源再安裝_參數與順序正確_且不帶disable() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![ok("[]")]);
        let r = install_with(&f, Path::new(CLAUDE), &m, &d, 77, true);
        assert_eq!(r, Outcome::Installed("1.2.3".into()));
        assert_eq!(r.line(), "Claude 外掛：已安裝（版本 1.2.3）");
        assert_eq!(f.log(), vec!["plugin list --json".to_string(), format!("plugin marketplace add {}", m.display()), "plugin install asn@asn --scope user".to_string()]);
        assert!(!f.log().iter().any(|l| l.contains("disable")));
        let mk = marker(&d).expect("要留標記");
        assert_eq!(mk["installedVersion"], "1.2.3");
        assert_eq!(mk["installedAt"], 77);
    }

    /// 一個舊標記（版本 1.0.0）：模擬「ASN 更新了，外掛資料夾是 1.2.3」
    fn old_marker(d: &Path, m: &Path) {
        let body = serde_json::json!({ "installedVersion": "1.0.0", "installedAt": 1, "dir": m.to_string_lossy() });
        std::fs::write(d.join(MARKER_FILE), body.to_string()).unwrap();
    }
    fn no_toggle(f: &Fake) {
        assert!(!f.log().iter().any(|l| l.contains("enable") || l.contains("disable") || l.contains("install ")), "不可 enable／disable／install：{:?}", f.log());
    }

    #[test]
    fn 第一次且已安裝版本相同_只補標記_不動任何東西() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![ok(r#"[{"id":"asn@asn","enabled":false,"scope":"user","version":"1.2.3"}]"#)]);
        assert_eq!(install_with(&f, Path::new(CLAUDE), &m, &d, 1, true), Outcome::Installed("1.2.3".into()));
        assert_eq!(f.log(), vec!["plugin list --json".to_string()]);
        assert!(marker(&d).is_some());
    }

    #[test]
    fn 版本變了_已安裝且被使用者停用_走更新_不enable_scope照list() {
        let (_t, m, d) = dirs();
        old_marker(&d, &m);
        let f = Fake::new(vec![ok(r#"[{"id":"other@x","enabled":true,"scope":"user"},{"id":"asn@asn","enabled":false,"scope":"project","version":"1.0.0","installPath":"x"}]"#)]);
        let r = run_with_claude(&f, &m, &d);
        assert_eq!(r, Outcome::Installed("1.2.3".into()));
        assert_eq!(f.log(), vec!["plugin list --json".to_string(), "plugin marketplace update asn".to_string(), "plugin update asn@asn --scope project".to_string()]);
        no_toggle(&f);
        assert_eq!(marker(&d).unwrap()["installedVersion"], "1.2.3", "成功才更新標記");
    }

    #[test]
    fn 版本變了_已安裝且啟用_同樣走更新() {
        let (_t, m, d) = dirs();
        old_marker(&d, &m);
        let f = Fake::new(vec![ok(r#"[{"id":"asn@asn","enabled":true,"scope":"user","version":"1.0.0"}]"#)]);
        assert_eq!(run_with_claude(&f, &m, &d), Outcome::Installed("1.2.3".into()));
        assert_eq!(f.log().last().unwrap(), "plugin update asn@asn --scope user");
        no_toggle(&f);
    }

    #[test]
    fn 版本變了_使用者已解除安裝_不重裝_只更新標記() {
        let (_t, m, d) = dirs();
        old_marker(&d, &m);
        let f = Fake::new(vec![ok(r#"[{"id":"other@x","enabled":true,"scope":"user"}]"#)]);
        let r = run_with_claude(&f, &m, &d);
        assert_eq!(r, Outcome::Uninstalled);
        assert_eq!(f.log(), vec!["plugin list --json".to_string()], "不 marketplace add、不 install、不 update");
        assert_eq!(marker(&d).unwrap()["installedVersion"], "1.2.3");
        // 下次啟動標記版本一致，就完全不碰 claude
        let f2 = Fake::new(vec![]);
        assert_eq!(run_with_claude(&f2, &m, &d), Outcome::Installed("1.2.3".into()));
        assert!(f2.log().is_empty());
    }

    #[test]
    fn 更新失敗_不更新標記_顯示原因_下次再試() {
        let (_t, m, d) = dirs();
        old_marker(&d, &m);
        let f = Fake::new(vec![ok(r#"[{"id":"asn@asn","enabled":true,"scope":"user","version":"1.0.0"}]"#), ok(""), bad("network down")]);
        let r = run_with_claude(&f, &m, &d);
        assert_eq!(r, Outcome::UpdateFailed("更新外掛失敗：network down".into()));
        assert_eq!(r.line(), "Claude 外掛：更新失敗：更新外掛失敗：network down");
        assert_eq!(marker(&d).unwrap()["installedVersion"], "1.0.0");
        // 下次啟動會再試
        let f2 = Fake::new(vec![ok(r#"[{"id":"asn@asn","enabled":true,"scope":"user","version":"1.0.0"}]"#)]);
        assert_eq!(run_with_claude(&f2, &m, &d), Outcome::Installed("1.2.3".into()));
        assert!(f2.log().iter().any(|l| l.starts_with("plugin update")));
    }

    #[test]
    fn 來源重新整理失敗_就不跑update_也不更新標記() {
        let (_t, m, d) = dirs();
        old_marker(&d, &m);
        let f = Fake::new(vec![ok(r#"[{"id":"asn@asn","enabled":true,"scope":"user","version":"1.0.0"}]"#), bad("no such marketplace")]);
        let r = run_with_claude(&f, &m, &d);
        assert_eq!(r, Outcome::UpdateFailed("重新整理外掛來源失敗：no such marketplace".into()));
        assert_eq!(f.log().len(), 2);
        assert_eq!(marker(&d).unwrap()["installedVersion"], "1.0.0");
    }

    #[test]
    fn 解析list輸出() {
        let j = r#"[{"id":"asn@asn","enabled":false,"scope":"user","version":"0.1.5","installPath":"C:/x"}]"#;
        assert_eq!(parse_listing(j), Some(Listed { scope: "user".into(), version: Some("0.1.5".into()) }));
        assert_eq!(parse_listing("[]"), None);
        assert_eq!(parse_listing(r#"[{"id":"asn@other"}]"#), None, "JSON 要比對 id，不是找子字串");
        assert_eq!(parse_listing("  asn@asn  v0.1.0  enabled"), Some(Listed { scope: "user".into(), version: None }));
        assert_eq!(parse_listing("No plugins installed"), None);
    }

    /// 走入口 run()：用暫存資料夾放一個假的 claude 檔讓 find_claude 找得到（Fake 不會真的執行它）
    fn run_with_claude(f: &Fake, m: &Path, d: &Path) -> Outcome {
        let bin = d.parent().unwrap().join("fakebin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(if cfg!(windows) { "claude.exe" } else { "claude" }), "").unwrap();
        run(f, bin.as_os_str(), &[], m, d, 9)
    }

    #[test]
    fn 有標記就完全不碰claude() {
        let (_t, m, d) = dirs();
        write_marker(&d, &m, 5);
        let f = Fake::new(vec![]);
        // PATH 故意是空的：有標記時連找 claude 都不做
        let r = run(&f, OsStr::new(""), &[], &m, &d, 9);
        assert_eq!(r, Outcome::Installed("1.2.3".into()));
        assert!(f.log().is_empty());
        assert_eq!(marker(&d).unwrap()["installedAt"], 5, "標記不被改寫");
    }

    #[test]
    fn 找不到claude_安靜略過_不留標記() {
        let (t, m, d) = dirs();
        let f = Fake::new(vec![]);
        let r = run(&f, t.path().as_os_str(), &[], &m, &d, 1);
        assert_eq!(r, Outcome::NoClaude);
        assert_eq!(r.line(), "Claude 外掛：未安裝（找不到 Claude Code）");
        assert!(f.log().is_empty() && marker(&d).is_none());
    }

    #[test]
    fn list不支援json_退回純文字查詢_版本不明就走更新() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![bad("unknown option --json"), ok("  asn@asn  v0.1.0  enabled")]);
        assert_eq!(install_with(&f, Path::new(CLAUDE), &m, &d, 1, true), Outcome::Installed("1.2.3".into()));
        assert_eq!(f.log(), vec!["plugin list --json".to_string(), "plugin list".to_string(), "plugin marketplace update asn".to_string(), "plugin update asn@asn --scope user".to_string()]);
        no_toggle(&f);
    }

    #[test]
    fn 來源已存在_加入失敗但列表有asn_就繼續安裝() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![ok("[]"), bad("marketplace asn already exists"), ok("asn  (local)")]);
        assert_eq!(install_with(&f, Path::new(CLAUDE), &m, &d, 1, true), Outcome::Installed("1.2.3".into()));
        assert_eq!(f.log().last().unwrap(), "plugin install asn@asn --scope user");
    }

    #[test]
    fn 安裝失敗_回報原因_不留標記_下次啟動會再試() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![ok("[]"), ok(""), bad("\nboom: 需要互動設定\nmore")]);
        let r = install_with(&f, Path::new(CLAUDE), &m, &d, 1, true);
        assert_eq!(r, Outcome::Failed("安裝外掛失敗：boom: 需要互動設定".into()));
        assert_eq!(r.line(), "Claude 外掛：安裝失敗：安裝外掛失敗：boom: 需要互動設定");
        assert!(marker(&d).is_none());
    }

    #[test]
    fn 沒有外掛檔案_回報失敗_不跑任何指令() {
        let (t, _m, d) = dirs();
        let bin = t.path().join(if cfg!(windows) { "claude.exe" } else { "claude" });
        std::fs::write(&bin, "").unwrap();
        let f = Fake::new(vec![]);
        let r = run(&f, t.path().as_os_str(), &[], &t.path().join("沒有這個"), &d, 1);
        assert_eq!(r, Outcome::Failed("安裝資料夾裡找不到外掛檔案".into()));
        assert!(f.log().is_empty());
    }

    #[test]
    fn 狀態文字都是純中文() {
        for o in [Outcome::Installed("1.0.0".into()), Outcome::Uninstalled, Outcome::NoClaude, Outcome::Failed("逾時".into()), Outcome::UpdateFailed("逾時".into())] {
            assert!(o.line().starts_with("Claude 外掛："));
        }
    }

    // ---- 以下用「假的 claude 執行檔」（腳本）驗證真的子程序：參數、乾淨環境、逾時 ----
    fn script(dir: &Path, body_win: &str, body_unix: &str) -> PathBuf {
        if cfg!(windows) {
            let p = dir.join("claude.cmd");
            std::fs::write(&p, format!("@echo off\r\n{body_win}\r\n")).unwrap();
            p
        } else {
            let p = dir.join("claude");
            std::fs::write(&p, format!("#!/bin/sh\n{body_unix}\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        }
    }
    fn test_env(extra: &[(&str, &str)]) -> HashMap<String, String> {
        // 真的系統變數（cmd 需要 SystemRoot 等）＋幾個一定要被清掉的；再疊上測試用的暫存 home
        let mut vars: Vec<(String, String)> = std::env::vars().collect();
        vars.push(("CLAUDECODE".into(), "1".into()));
        vars.push(("CLAUDE_CODE_ENTRYPOINT".into(), "cli".into()));
        vars.push(("ASN_RELAY_KEY".into(), "secret-test".into()));
        let mut env = crate::launch::config::child_env_from(vars.into_iter());
        for (k, v) in extra {
            env.insert(k.to_string(), v.to_string());
        }
        env
    }

    #[test]
    fn 真子程序_完整流程的參數順序_環境乾淨_用暫存home不碰真的設定() {
        let (t, m, d) = dirs();
        let fake_home = t.path().join("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        let log = t.path().join("calls.log");
        let envlog = t.path().join("env.log");
        let bin_dir = t.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        script(
            &bin_dir,
            &format!("echo %*>> \"{}\"\r\necho CC[%CLAUDECODE%] EP[%CLAUDE_CODE_ENTRYPOINT%] KEY[%ASN_RELAY_KEY%] HOME[%USERPROFILE%]>> \"{}\"\r\nexit /b 0", log.display(), envlog.display()),
            &format!("echo \"$@\" >> '{}'\necho \"CC[$CLAUDECODE] EP[$CLAUDE_CODE_ENTRYPOINT] KEY[$ASN_RELAY_KEY] HOME[$USERPROFILE]\" >> '{}'\nexit 0", log.display(), envlog.display()),
        );
        let home_s = fake_home.to_string_lossy().into_owned();
        let runner = RealRunner { env: test_env(&[("USERPROFILE", &home_s), ("HOME", &home_s)]), timeout: Duration::from_secs(30) };
        let r = run(&runner, bin_dir.as_os_str(), &[], &m, &d, 3);
        assert_eq!(r, Outcome::Installed("1.2.3".into()), "{r:?}");
        let calls: Vec<String> = std::fs::read_to_string(&log).unwrap().lines().map(|l| l.trim().to_string()).collect();
        assert_eq!(calls, vec!["plugin list --json".to_string(), format!("plugin marketplace add {}", m.display()), "plugin install asn@asn --scope user".to_string()]);
        let envs = std::fs::read_to_string(&envlog).unwrap();
        assert_eq!(envs.lines().count(), 3);
        for l in envs.lines() {
            // Windows 沒設的變數會原樣印出 %名稱%，其他系統印空字串；兩者都不可出現我們塞進去的值
            assert!(!l.contains("CC[1]") && !l.contains("EP[cli]") && !l.contains("secret-test"), "環境沒清乾淨：{l}");
            assert!(l.contains(&format!("HOME[{home_s}]")), "子程序看到的 home 要是暫存的：{l}");
        }
        assert!(marker(&d).is_some());
        assert!(!fake_home.join(".claude").exists());
    }

    #[test]
    fn 真子程序_逾時會中止並回報() {
        let (t, _m, _d) = dirs();
        let bin_dir = t.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let claude = script(&bin_dir, "ping -n 41 127.0.0.1 >nul", "sleep 40");
        let runner = RealRunner { env: test_env(&[]), timeout: Duration::from_millis(600) };
        let t0 = Instant::now();
        let r = runner.run(&claude, &["plugin", "list"]);
        // 假程式睡 40 秒、逾時 600ms；上限 25 秒容納機器忙碌時的啟動延遲。逾時機制失效時會跑滿 40 秒而紅
        assert!(t0.elapsed() < Duration::from_secs(25), "逾時要在 600ms 附近就中止：{:?}", t0.elapsed());
        assert!(r.err().unwrap().contains("沒有回應"));
    }

    // ---- 守門：子程序的做法不能被改壞（改了要看到測試紅） ----
    #[test]
    fn 守門_子程序一律不開視窗_乾淨環境_stdin接空() {
        let src = include_str!("claude_mod.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for needle in [".no_window()", ".env_clear()", "Stdio::null()", "child_env()"] {
            assert!(body.contains(needle), "claude_mod.rs 少了 {needle}");
        }
        let pat = format!("{}{}", "Command::", "new("); // 拆開寫，免得被 nowin.rs 的掃描器當成真的呼叫
        assert_eq!(body.matches(pat.as_str()).count(), 1, "所有子程序都要走 RealRunner 這一個入口");
    }

    #[test]
    fn 守門_程式裡沒有任何enable或disable指令() {
        let src = include_str!("claude_mod.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let calls: Vec<&str> = body.lines().filter(|l| l.contains("runner.run(")).collect();
        assert!(calls.len() >= 7, "少看到呼叫：{}", calls.len());
        assert!(calls.iter().all(|l| !l.contains("\"enable\"") && !l.contains("\"disable\"")), "不可自動啟用或停用外掛");
        // 只有更新路徑可以呼叫 update；重裝（install）只准出現在 first_install 一處
        assert_eq!(body.matches("\"install\"").count(), 1);
        assert_eq!(body.matches("fn first_install").count(), 1);
    }
}
