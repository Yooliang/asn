//! 開 Claude 夥伴之前，先把這次的工作資料夾標成「已信任」，視窗才不會停在信任確認上等人按。
//! 所有開 Claude 的路都走這裡：本機新增、遠端開窗、開機接回、以及喚醒／交接／改名／換模型的重開（switch::real_launch）。
//! 寫的檔案跟 Claude 實際會讀的一致：有設 CLAUDE_CONFIG_DIR 就是那個資料夾裡的 `.claude.json`，沒設才是家目錄的。
//! 失敗不擋啟動：記一行到 ui.log（只寫原因，不寫帳號或檔案內容）。
use crate::claude_accounts::claude_home;
use crate::claude_json::{claude_json_path, claude_project_key, ensure_project_trusted, TrustErr};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 機器資料夾（ui.log 所在）；啟動時設定一次，沒設就只寫 stderr
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub fn set_log_dir(dir: &Path) {
    let _ = LOG_DIR.set(dir.to_path_buf());
}

/// 沒寫 engine 的自訂 profile 與 Node 橋相同，視為 Claude
pub(crate) fn is_claude_engine(engine: &str) -> bool {
    engine.is_empty() || engine == "claude"
}

/// Claude 實際讀寫 `.claude.json` 的資料夾：環境變數 CLAUDE_CONFIG_DIR（非空）或家目錄
pub(crate) fn trust_dir(home: &Path, cfg_env: Option<OsString>) -> PathBuf {
    match cfg_env {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.to_path_buf(),
    }
}

fn real_dir() -> PathBuf {
    trust_dir(&claude_home(), std::env::var_os("CLAUDE_CONFIG_DIR"))
}

/// 寫完重讀：確認那個資料夾的鍵真的是已信任
fn is_trusted(dir: &Path, key: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(claude_json_path(dir)) else { return false };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return false };
    v.get("projects").and_then(|p| p.get(key)).and_then(|p| p.get("hasTrustDialogAccepted")).and_then(Value::as_bool) == Some(true)
}

/// 標成已信任並重讀確認；寫入或確認失敗（常見是防毒或同步軟體暫時鎖檔）重試一次。已經是 true 不寫檔
pub(crate) fn ensure_in(dir: &Path, cwd: &Path) -> Result<(), String> {
    let key = claude_project_key(cwd);
    let mut why = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        match ensure_project_trusted(dir, &key) {
            Ok(_) if is_trusted(dir, &key) => return Ok(()),
            Ok(_) => why = "寫入後重讀，這個資料夾仍不是已信任".to_string(),
            Err(e @ TrustErr::Corrupt(_)) => return Err(e.to_string()),
            Err(e) => why = e.to_string(),
        }
    }
    Err(why)
}

/// 失敗的記錄行：只有原因
pub(crate) fn failure_line(why: &str) -> String {
    format!("開夥伴前沒能把工作資料夾標成已信任：{why}")
}

/// 標成已信任；失敗只記錄（stderr，有 log 資料夾時也寫 ui.log），不擋啟動
pub(crate) fn run_in(dir: &Path, cwd: &Path, log_dir: Option<&Path>) {
    if let Err(why) = ensure_in(dir, cwd) {
        let line = failure_line(&why);
        elog!("{line}");
        // ui.log 只有有畫面的版本才有（無視窗的橋只寫 stderr）
        #[cfg(feature = "gui")]
        if let Some(d) = log_dir {
            let _ = crate::ui_log::append(d, &[format!("{} info [ASN] {line}", crate::quota_core::iso_secs(crate::heartbeat::now_ms() as i64))]);
        }
        #[cfg(not(feature = "gui"))]
        let _ = log_dir;
    }
}

/// 統一入口（有 engine 的呼叫點）：engine 是 claude 或空字串才動作
pub(crate) fn ensure_claude_cwd_trusted(engine: &str, cwd: &str) {
    if !is_claude_engine(engine) {
        return;
    }
    run_in(&real_dir(), Path::new(cwd), LOG_DIR.get().map(PathBuf::as_path));
}

/// 統一入口（重開用：只有指令，沒有 engine）：指令本身是 claude 才動作
pub(crate) fn ensure_claude_command_cwd_trusted(command: &str, cwd: &Path) {
    if !super::resume::is_claude_command(command) {
        return;
    }
    run_in(&real_dir(), cwd, LOG_DIR.get().map(PathBuf::as_path));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn key_of(cwd: &Path) -> String {
        claude_project_key(cwd)
    }

    fn json_of(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(claude_json_path(dir)).unwrap()).unwrap()
    }

    #[test]
    fn 有設_claude_config_dir_就寫那一份不碰家目錄() {
        let home = tempfile::tempdir().unwrap();
        let cfg = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let dir = trust_dir(home.path(), Some(cfg.path().as_os_str().to_owned()));
        assert_eq!(dir, cfg.path());
        ensure_in(&dir, work.path()).unwrap();
        assert_eq!(json_of(cfg.path())["projects"][key_of(work.path())]["hasTrustDialogAccepted"], true);
        assert!(!claude_json_path(home.path()).exists(), "家目錄那份不能被建出來");
    }

    #[test]
    fn 沒設或設空字串就寫家目錄那份() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        for env in [None, Some(OsString::new())] {
            assert_eq!(trust_dir(home.path(), env), home.path());
        }
        ensure_in(home.path(), work.path()).unwrap();
        assert_eq!(json_of(home.path())["projects"][key_of(work.path())]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn 已是_true_不重寫而且保留其他欄位() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let key = key_of(work.path());
        let src = serde_json::to_string_pretty(&serde_json::json!({
            "numStartups": 7, "oauthAccount": { "accountUuid": "u" },
            "projects": { key.clone(): { "hasTrustDialogAccepted": true, "allowedTools": ["x"] } }
        }))
        .unwrap();
        fs::write(claude_json_path(home.path()), &src).unwrap();
        ensure_in(home.path(), work.path()).unwrap();
        assert_eq!(fs::read_to_string(claude_json_path(home.path())).unwrap(), src, "已是 true：內容一個位元組都不動");
    }

    #[test]
    fn 原本沒信任的補成_true_其他欄位與其他專案都在() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let key = key_of(work.path());
        let src = serde_json::to_string_pretty(&serde_json::json!({
            "numStartups": 7, "oauthAccount": { "accountUuid": "u" },
            "projects": { "/other": { "hasTrustDialogAccepted": true }, key.clone(): { "hasTrustDialogAccepted": false, "allowedTools": ["x"] } }
        }))
        .unwrap();
        fs::write(claude_json_path(home.path()), &src).unwrap();
        ensure_in(home.path(), work.path()).unwrap();
        let v = json_of(home.path());
        assert_eq!(v["projects"][&key]["hasTrustDialogAccepted"], true);
        assert_eq!(v["projects"][&key]["allowedTools"][0], "x");
        assert_eq!(v["projects"]["/other"]["hasTrustDialogAccepted"], true);
        assert_eq!(v["numStartups"], 7);
        assert_eq!(v["oauthAccount"]["accountUuid"], "u");
    }

    #[test]
    fn 空_engine_與_claude_都算_claude_其他不是() {
        assert!(is_claude_engine("") && is_claude_engine("claude"));
        assert!(!is_claude_engine("pi") && !is_claude_engine("codex") && !is_claude_engine("Claude "));
    }

    #[test]
    fn 重開用指令判斷_claude_才動作() {
        assert!(crate::launch::resume::is_claude_command("claude") && crate::launch::resume::is_claude_command(r"C:\x\claude.exe"));
        assert!(!crate::launch::resume::is_claude_command("codex") && !crate::launch::resume::is_claude_command("cmd.exe"));
    }

    #[cfg(feature = "gui")]
    #[test]
    fn 寫不進去時回原因並在_ui_log_留一行() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        // 設定資料夾的位置其實是一個檔案：建不出 .claude.json，兩次都失敗
        let blocker = tmp.path().join("not-a-dir");
        fs::write(&blocker, "x").unwrap();
        assert!(ensure_in(&blocker, work.path()).is_err());
        // 正式的 log 資料夾（機器資料夾）一定存在；ui_log::append 不建父資料夾，測試要先建好
        let logs = tmp.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        run_in(&blocker, work.path(), Some(&logs));
        let text = fs::read_to_string(crate::ui_log::path(&logs)).unwrap();
        assert!(text.contains("開夥伴前沒能把工作資料夾標成已信任："), "{text}");
        assert!(!text.contains(&*work.path().to_string_lossy()), "記錄不寫工作資料夾路徑");
    }

    #[cfg(feature = "gui")]
    #[test]
    fn 成功時不寫_ui_log() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        run_in(home.path(), work.path(), Some(logs.path()));
        assert!(!crate::ui_log::path(logs.path()).exists());
    }

    #[test]
    fn 重讀確認會抓到沒寫進去() {
        let home = tempfile::tempdir().unwrap();
        assert!(!is_trusted(home.path(), "/x"), "檔案不存在");
        fs::write(claude_json_path(home.path()), r#"{"projects":{"/x":{"hasTrustDialogAccepted":false}}}"#).unwrap();
        assert!(!is_trusted(home.path(), "/x"));
        fs::write(claude_json_path(home.path()), r#"{"projects":{"/x":{"hasTrustDialogAccepted":true}}}"#).unwrap();
        assert!(is_trusted(home.path(), "/x"));
    }

    /// 守門：每一條開 Claude 的路都要在開之前呼叫統一入口（舊程式：喚醒／交接／改名／換模型的重開沒有呼叫）
    #[test]
    fn 守門_所有開_claude_的路都先信任() {
        let local = &crate::settings::src_scan::prod_source(include_str!("local.rs"));
        let switch = include_str!("switch.rs");
        let body = |from: &str, to: &str| local.split(from).nth(1).unwrap().split(to).next().unwrap().to_string();
        let new_local = body("pub fn partner_launch_local", "pub(crate) enum ModelPlan");
        assert!(new_local.contains("pretrust::ensure_claude_cwd_trusted(prof.engine.as_str(), &launch_req.cwd)"), "本機新增");
        let remote = body("pub fn start_remote_window", "pub fn start_resumed_window");
        assert!(remote.contains("pretrust::ensure_claude_cwd_trusted(&prof.engine, cwd)"), "遠端開窗（空 engine 也算 claude）");
        let resumed = body("pub fn start_resumed_window", "pub fn start_pi_session");
        assert!(resumed.contains("pretrust::ensure_claude_cwd_trusted(\"claude\", &req.cwd)"), "開機接回");
        let relaunch = body("pub(super) fn start_window_relaunch", "\n}");
        assert!(relaunch.contains("pretrust::ensure_claude_command_cwd_trusted(command, cwd)"), "重開（喚醒、交接、改名、換模型）");
        let real = switch.split("pub(crate) fn real_launch").nth(1).unwrap().split("pub(crate) struct RealOs").next().unwrap();
        assert!(real.contains("local::start_window_relaunch("), "real_launch 要走會先信任的重開開窗點");
        // 順序：信任在開窗之前
        let t = relaunch.find("ensure_claude_command_cwd_trusted").unwrap();
        assert!(t < relaunch.find("start_window").unwrap(), "先信任再開窗");
        // 舊的只認 engine==claude 的做法不能回來
        assert!(!local.contains("fn maybe_trust_claude_cwd"));
    }
}
