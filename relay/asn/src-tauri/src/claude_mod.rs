//! 自動幫 Claude Code 安裝 ASN 外掛（relay/claude-mod，#134）。
//!
//! 外掛檔案隨 ASN 安裝包放在安裝資料夾的 `claude-mod\`（見 tauri.conf.json 的 bundle.resources）。
//! ASN 啟動後在背景做一次：找 `claude` → 查有沒有裝 `asn@asn` → 沒裝就 `marketplace add` + `install --scope user`。
//! 規矩：
//! - 只有「第一次安裝」才預設啟用；之後留下標記檔 `claude-mod.json`，有標記就不再碰 Claude Code，
//!   所以使用者停用（disable）之後不會被重新啟用，也不會重複安裝。
//! - 外掛檔案在安裝資料夾裡，ASN 更新時檔案跟著換新（marketplace 的 source 是 `./`），不必重裝。
//! - 所有子程序：不開視窗、乾淨環境（同 launch/config.rs 的 child_env）、stdin 接空、有逾時；逾時只殺自己啟動的那個子程序。
//! - 找不到 claude、或安裝失敗都不擋 ASN，只記一行 log 並把原因顯示在設定頁。
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
/// 單一 claude 指令的逾時
pub const CMD_TIMEOUT: Duration = Duration::from_secs(60);
const MARKER_FILE: &str = "claude-mod.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Installed,
    NoClaude,
    Failed(String),
}

impl Outcome {
    /// 設定頁那一行（純中文）
    pub fn line(&self) -> String {
        match self {
            Outcome::Installed => "Claude 外掛：已安裝".into(),
            Outcome::NoClaude => "Claude 外掛：未安裝（找不到 Claude Code）".into(),
            Outcome::Failed(why) => format!("Claude 外掛：安裝失敗：{why}"),
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

fn marker_matches(data_dir: &Path, mod_dir: &Path) -> bool {
    let Ok(t) = std::fs::read_to_string(data_dir.join(MARKER_FILE)) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else { return false };
    v.get("installedVersion").and_then(|x| x.as_str()).is_some() && v.get("dir").and_then(|x| x.as_str()).map_or(true, |d| d == mod_dir.to_string_lossy())
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

/// 主流程（可用假的 Runner 測）。`claude` 是已找到的執行檔路徑。
pub fn install_with(runner: &dyn Runner, claude: &Path, mod_dir: &Path, data_dir: &Path, now_secs: u64) -> Outcome {
    // 查「已安裝」：先用 --json，不支援就退回純文字；找字串 asn@asn（不管格式）。已安裝（含被使用者停用）一律不動，只補標記。
    let listed = match runner.run(claude, &["plugin", "list", "--json"]) {
        Ok(r) if r.code == Some(0) => r,
        _ => match runner.run(claude, &["plugin", "list"]) {
            Ok(r) if r.code == Some(0) => r,
            Ok(r) => return Outcome::Failed(fail_text("查詢已安裝外掛", &r)),
            Err(e) => return Outcome::Failed(e),
        },
    };
    if listed.stdout.to_ascii_lowercase().contains(PLUGIN_ID) {
        write_marker(data_dir, mod_dir, now_secs);
        return Outcome::Installed;
    }
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
            Outcome::Installed
        }
        Ok(r) => Outcome::Failed(fail_text("安裝外掛", &r)),
        Err(e) => Outcome::Failed(e),
    }
}

/// 入口：已有標記就直接回「已安裝」（不碰 Claude Code）；否則找 claude、檢查外掛檔案、安裝。
pub fn run(runner: &dyn Runner, path_var: &OsStr, extra: &[PathBuf], mod_dir: &Path, data_dir: &Path, now_secs: u64) -> Outcome {
    if marker_matches(data_dir, mod_dir) {
        return Outcome::Installed;
    }
    let Some(claude) = find_claude(path_var, extra) else {
        eprintln!("[claude-mod] 找不到 claude 指令，略過外掛安裝");
        return Outcome::NoClaude;
    };
    if plugin_version(mod_dir).is_none() {
        eprintln!("[claude-mod] 安裝資料夾裡沒有外掛檔案：{}", mod_dir.display());
        return Outcome::Failed("安裝資料夾裡找不到外掛檔案".into());
    }
    let out = install_with(runner, &claude, mod_dir, data_dir, now_secs);
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
        let r = install_with(&f, Path::new(CLAUDE), &m, &d, 77);
        assert_eq!(r, Outcome::Installed);
        assert_eq!(f.log(), vec!["plugin list --json".to_string(), format!("plugin marketplace add {}", m.display()), "plugin install asn@asn --scope user".to_string()]);
        assert!(!f.log().iter().any(|l| l.contains("disable")));
        let mk = marker(&d).expect("要留標記");
        assert_eq!(mk["installedVersion"], "1.2.3");
        assert_eq!(mk["installedAt"], 77);
    }

    #[test]
    fn 已安裝但被使用者停用_不重新啟用也不重裝_只補標記() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![ok(r#"[{"id":"asn@asn","enabled":false}]"#)]);
        assert_eq!(install_with(&f, Path::new(CLAUDE), &m, &d, 1), Outcome::Installed);
        assert_eq!(f.log(), vec!["plugin list --json".to_string()], "只查詢，不 enable、不 install、不 marketplace add");
        assert!(marker(&d).is_some());
    }

    #[test]
    fn 有標記就完全不碰claude() {
        let (_t, m, d) = dirs();
        write_marker(&d, &m, 5);
        let f = Fake::new(vec![]);
        // PATH 故意是空的：有標記時連找 claude 都不做
        let r = run(&f, OsStr::new(""), &[], &m, &d, 9);
        assert_eq!(r, Outcome::Installed);
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
    fn list不支援json_退回純文字查詢() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![bad("unknown option --json"), ok("  asn@asn  v0.1.0  enabled")]);
        assert_eq!(install_with(&f, Path::new(CLAUDE), &m, &d, 1), Outcome::Installed);
        assert_eq!(f.log(), vec!["plugin list --json".to_string(), "plugin list".to_string()]);
    }

    #[test]
    fn 來源已存在_加入失敗但列表有asn_就繼續安裝() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![ok("[]"), bad("marketplace asn already exists"), ok("asn  (local)")]);
        assert_eq!(install_with(&f, Path::new(CLAUDE), &m, &d, 1), Outcome::Installed);
        assert_eq!(f.log().last().unwrap(), "plugin install asn@asn --scope user");
    }

    #[test]
    fn 安裝失敗_回報原因_不留標記_下次啟動會再試() {
        let (_t, m, d) = dirs();
        let f = Fake::new(vec![ok("[]"), ok(""), bad("\nboom: 需要互動設定\nmore")]);
        let r = install_with(&f, Path::new(CLAUDE), &m, &d, 1);
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
        for o in [Outcome::Installed, Outcome::NoClaude, Outcome::Failed("逾時".into())] {
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
        assert_eq!(r, Outcome::Installed, "{r:?}");
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
        let claude = script(&bin_dir, "ping -n 6 127.0.0.1 >nul", "sleep 6");
        let runner = RealRunner { env: test_env(&[]), timeout: Duration::from_millis(600) };
        let t0 = Instant::now();
        let r = runner.run(&claude, &["plugin", "list"]);
        assert!(t0.elapsed() < Duration::from_secs(5), "逾時要在 600ms 附近就中止");
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
        assert!(calls.len() >= 4);
        assert!(calls.iter().all(|l| !l.contains("\"enable\"") && !l.contains("\"disable\"") && !l.contains("\"update\"")), "不可自動啟用或停用外掛");
    }
}
