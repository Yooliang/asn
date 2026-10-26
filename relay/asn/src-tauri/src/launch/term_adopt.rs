//! 接手使用者自己開著的 WezTerm 窗格（議題 #285 定案版）。只存記憶體，不寫檔。
#![cfg(desktop)]

use super::config::{canonical_launch_cwd, LaunchConfig};
use super::cwds;
use super::switch;
use super::wezterm::{self, Fs, PaneInfo, Runner, WezDuration, WezTerm, Window};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 隨安裝檔附帶、真機實測過的 WezTerm 標籤。
pub const VERIFIED_WEZTERM_TAG: &str = "20240203";

/// 代答／代送前：WezTerm 實例距上次使用者輸入須至少這麼久（秒）。
pub const ADOPT_WRITE_MIN_USER_IDLE_SECS: f64 = 5.0;

const USER_BUSY_FOCUS_ON_PANE_MSG: &str = "使用者焦點與輸入都在這個窗格，ASN 不會代送（請先切到別處再試）";
const USER_BUSY_INSTANCE_MSG: &str = "使用者剛操作過 WezTerm，ASN 不會代送（請稍候再試）";

/// 從 list-clients 解析出來、寫入核驗要用的欄位。
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedWezClient {
    pub idle_secs: f64,
    pub focused_pane_id: u64,
}

/// 接手候選／已接手窗格的前景 CLI（WezTerm list 的 title 欄位是行程名）。
const KNOWN_CLI: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("grok", "grok"),
    ("agy", "agy"),
    ("pi", "pi"),
    ("codex", "codex"),
];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermAdoptCandidate {
    pub pid: u32,
    pub pane_id: u64,
    pub started_ms: u64,
    pub profile: String,
    /// 顯示用（不會在接手後存進記憶體）。
    pub tab_title: String,
    pub cwd_raw: String,
    pub cwd_authorized: bool,
    pub version_verified: bool,
    pub version_note: String,
    pub already_adopted: bool,
}

#[derive(Clone, Debug)]
pub struct AdoptedSession {
    pub id: String,
    pub profile: String,
    pub window: Window,
    pub pane_id: u64,
    /// 接手當下、已正規化且在白名單內的工作資料夾。
    pub cwd: String,
    /// 接手當下的前景行程名（小寫 stem）。
    pub foreground: String,
    pub answer_unlocked: bool,
    pub send_unlocked: bool,
    pub version_verified: bool,
}

#[derive(Clone, Debug)]
pub struct AdoptedSnap {
    pub foreground: String,
    pub answer_unlocked: bool,
    pub send_unlocked: bool,
    pub version_verified: bool,
}

pub fn known_profile_from_pane_title(title: &str) -> Option<&'static str> {
    let stem = title.trim().rsplit(['/', '\\']).next().unwrap_or("").split('.').next().unwrap_or("").to_ascii_lowercase();
    KNOWN_CLI.iter().find(|(s, _)| *s == stem).map(|(_, p)| *p)
}

/// 把 WezTerm list 的 cwd 轉成本機路徑；空、WSL、ssh、無法解析的 file:// 一律拒絕。
pub fn pane_cwd_to_local(raw: &str) -> Result<PathBuf, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("工作資料夾是空的".into());
    }
    let low = t.to_ascii_lowercase();
    if low.starts_with("//wsl") || low.starts_with("\\\\wsl") || low.contains("wsl.localhost") {
        return Err("這是 WSL 路徑，不能當成本機資料夾".into());
    }
    if t.contains('@') && t.contains(':') && !low.contains("://") {
        return Err("這是遠端 ssh 路徑，不能當成本機資料夾".into());
    }
    let path_str = if let Some(rest) = t.strip_prefix("file://") {
        if cfg!(windows) {
            rest.trim_start_matches('/').replace('/', "\\")
        } else {
            rest.to_string()
        }
    } else if t.starts_with("file:") {
        return Err("無法把 file 網址轉成本機路徑".into());
    } else {
        t.to_string()
    };
    if path_str.trim().is_empty() {
        return Err("工作資料夾是空的".into());
    }
    let Some(normed) = cwds::norm_path(&path_str) else {
        return Err("工作資料夾是空的".into());
    };
    let stepped = switch::normalize_cwd(&normed);
    canonical_launch_cwd(&stepped).map_err(|_| "無法把路徑轉成本機資料夾".into())
}

pub fn cwd_in_allow(canon: &Path, allow: &[PathBuf]) -> bool {
    allow.iter().any(|p| p == canon)
}

pub fn wezterm_version_verified(w: &WezTerm<'_>) -> (bool, String) {
    match w.version_string() {
        Ok(v) if v.contains(VERIFIED_WEZTERM_TAG) => (true, String::new()),
        Ok(v) => (false, format!("WezTerm 版本未驗證（目前：{}）", v.trim())),
        Err(e) => (false, format!("無法取得 WezTerm 版本：{e}")),
    }
}

pub fn discover_gui_pids(home: &Path, fs: &dyn Fs, runner: &dyn Runner) -> Vec<u32> {
    let dir = home.join(".local").join("share").join("wezterm");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("gui-sock-") else { continue };
        let Ok(pid) = rest.parse::<u32>() else { continue };
        if pid == 0 {
            continue;
        }
        let sock = wezterm::sock_path(home, pid);
        if !fs.exists(&sock) {
            continue;
        }
        if runner.started_ms(pid).is_none() {
            continue;
        }
        out.push(pid);
    }
    out.sort_unstable();
    out.dedup();
    out
}

pub fn scan_candidates(
    home: &Path,
    w: &WezTerm<'_>,
    fs: &dyn Fs,
    runner: &dyn Runner,
    config: &LaunchConfig,
    adopted_keys: &[(u32, u64)],
) -> Vec<TermAdoptCandidate> {
    let (version_verified, version_note) = wezterm_version_verified(w);
    let mut out = Vec::new();
    for pid in discover_gui_pids(home, fs, runner) {
        let Some(started_ms) = runner.started_ms(pid) else { continue };
        let sock = wezterm::sock_path(home, pid);
        let panes = match w.list(&sock) {
            Ok(p) => p,
            Err(e) => {
                out.push(TermAdoptCandidate {
                    pid,
                    pane_id: 0,
                    started_ms,
                    profile: String::new(),
                    tab_title: String::new(),
                    cwd_raw: String::new(),
                    cwd_authorized: false,
                    version_verified,
                    version_note: format!("無法讀取窗格清單：{e}"),
                    already_adopted: false,
                });
                continue;
            }
        };
        for pane in panes {
            let Some(profile) = known_profile_from_pane_title(&pane.title) else {
                continue;
            };
            let cwd_auth = match pane_cwd_to_local(&pane.cwd) {
                Ok(c) => cwd_in_allow(&c, &config.cwd_allow),
                Err(_) => false,
            };
            let already = adopted_keys.iter().any(|(p, id)| *p == pid && *id == pane.pane_id);
            out.push(TermAdoptCandidate {
                pid,
                pane_id: pane.pane_id,
                started_ms,
                profile: profile.to_string(),
                tab_title: pane.tab_title.clone(),
                cwd_raw: pane.cwd.clone(),
                cwd_authorized: cwd_auth,
                version_verified,
                version_note: if version_verified { String::new() } else { version_note.clone() },
                already_adopted: already,
            });
        }
    }
    out
}

pub fn adopt_pane(
    pid: u32,
    pane_id: u64,
    started_ms: u64,
    w: &WezTerm<'_>,
    home: &Path,
    fs: &dyn Fs,
    runner: &dyn Runner,
    config: &LaunchConfig,
) -> Result<AdoptedSession, String> {
    if pid == 0 {
        return Err("程序編號不合法".into());
    }
    let sock = wezterm::sock_path(home, pid);
    if !fs.exists(&sock) {
        return Err("WezTerm 通訊檔不存在（視窗可能已關閉）".into());
    }
    let Some(now) = runner.started_ms(pid) else {
        return Err("這個 WezTerm 視窗已經不在執行".into());
    };
    if now != started_ms {
        return Err("程序建立時間不符（這個編號可能已被別的程式重用）".into());
    }
    let panes = w.list(&sock)?;
    let Some(pane) = panes.iter().find(|p| p.pane_id == pane_id) else {
        return Err("這個窗格已經不存在".into());
    };
    let Some(profile) = known_profile_from_pane_title(&pane.title) else {
        return Err("前景不是已知的 CLI，不能接手".into());
    };
    let canon = pane_cwd_to_local(&pane.cwd)?;
    if !cwd_in_allow(&canon, &config.cwd_allow) {
        return Err("工作資料夾不在允許清單裡".into());
    }
    let (version_verified, note) = wezterm_version_verified(w);
    if !version_verified && !note.is_empty() {
        // 仍可接手唯讀；note 留給清單，這裡不擋接手本身
    }
    Ok(AdoptedSession {
        id: String::new(),
        profile: profile.to_string(),
        window: Window {
            gui_pid: pid,
            sock,
            started_ms: Some(started_ms),
        },
        pane_id,
        cwd: canon.to_string_lossy().into_owned(),
        foreground: profile.to_string(),
        answer_unlocked: false,
        send_unlocked: false,
        version_verified,
    })
}

pub struct LivePane {
    pub pane: PaneInfo,
    pub started_ms: u64,
}

pub fn fetch_live_pane(w: &WezTerm<'_>, win: &Window, pane_id: u64, runner: &dyn Runner) -> Result<LivePane, String> {
    let Some(was) = win.started_ms else {
        return Err("沒有記下視窗程序的建立時間".into());
    };
    let Some(now) = runner.started_ms(win.gui_pid) else {
        return Err("這個 WezTerm 視窗已經不在執行".into());
    };
    if now != was {
        return Err("程序建立時間不符（這個編號可能已被別的程式重用）".into());
    }
    let panes = w.list(&win.sock)?;
    let Some(pane) = panes.iter().find(|p| p.pane_id == pane_id).cloned() else {
        return Err("這個窗格已經不存在（編號可能被重用）".into());
    };
    Ok(LivePane { pane, started_ms: now })
}

pub fn idle_secs_from_duration(d: &WezDuration) -> f64 {
    d.as_secs_f64()
}

/// 解析 WezTerm `idle_time`：Duration 物件、浮點秒或整數秒；真的無法解析才拒絕。
pub fn parse_idle_time_value(idle: &serde_json::Value) -> Result<f64, String> {
    match idle {
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f >= 0.0 {
                    return Ok(f);
                }
            }
            if let Some(u) = n.as_u64() {
                return Ok(u as f64);
            }
            if let Some(i) = n.as_i64() {
                if i >= 0 {
                    return Ok(i as f64);
                }
            }
            Err("WezTerm client 的 idle_time 數字格式不對".into())
        }
        serde_json::Value::Object(obj) => {
            let secs = obj
                .get("secs")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "WezTerm client 的 idle_time 物件缺 secs".to_string())?;
            let nanos = obj.get("nanos").and_then(|v| v.as_u64()).unwrap_or(0);
            Ok(secs as f64 + nanos as f64 / 1_000_000_000.0)
        }
        _ => Err("WezTerm client 的 idle_time 格式不對".into()),
    }
}

pub fn min_user_idle_secs(clients: &[ParsedWezClient]) -> Result<f64, String> {
    if clients.is_empty() {
        return Err("讀不到 WezTerm 的使用者閒置時間（沒有連線的 client）".into());
    }
    clients
        .iter()
        .map(|c| c.idle_secs)
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .ok_or_else(|| "讀不到 WezTerm 的使用者閒置時間".into())
}

pub fn parse_list_clients_json(text: &str) -> Result<Vec<ParsedWezClient>, String> {
    let v: serde_json::Value =
        serde_json::from_str(text.trim()).map_err(|e| format!("無法解析 WezTerm client 清單：{e}"))?;
    let arr = v.as_array().ok_or_else(|| "WezTerm client 清單格式不對（不是陣列）".to_string())?;
    if arr.is_empty() {
        return Err("讀不到 WezTerm 的使用者閒置時間（沒有連線的 client）".into());
    }
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let obj = item.as_object().ok_or_else(|| format!("WezTerm client 清單第 {} 列格式不對", i + 1))?;
        let idle = obj
            .get("idle_time")
            .ok_or_else(|| format!("WezTerm client 清單第 {} 列缺 idle_time", i + 1))?;
        let idle_secs = parse_idle_time_value(idle)?;
        let focused_pane_id = obj.get("focused_pane_id").and_then(|v| v.as_u64()).unwrap_or(0);
        out.push(ParsedWezClient { idle_secs, focused_pane_id });
    }
    Ok(out)
}

/// 實例內最短 idle_time 未達閾值就拒絕；訊息依焦點是否在目標窗格區分。
pub fn check_user_idle_for_write(clients: &[ParsedWezClient], target_pane_id: u64) -> Result<(), String> {
    let min_idle = min_user_idle_secs(clients)?;
    if min_idle >= ADOPT_WRITE_MIN_USER_IDLE_SECS {
        return Ok(());
    }
    let at_min: Vec<&ParsedWezClient> = clients.iter().filter(|c| (c.idle_secs - min_idle).abs() < 1e-6).collect();
    if at_min.iter().any(|c| c.focused_pane_id == target_pane_id) {
        return Err(USER_BUSY_FOCUS_ON_PANE_MSG.into());
    }
    Err(USER_BUSY_INSTANCE_MSG.into())
}

pub fn ensure_user_idle_for_adopt_write(w: &WezTerm<'_>, sock: &std::path::Path, target_pane_id: u64) -> Result<(), String> {
    let text = w.list_clients_text(sock)?;
    let clients = parse_list_clients_json(&text)?;
    check_user_idle_for_write(&clients, target_pane_id)
}

pub fn verify_adopted_for_write(
    live: &LivePane,
    adopted: &AdoptedSnap,
    config: &LaunchConfig,
) -> Result<(), String> {
    let fg = known_profile_from_pane_title(&live.pane.title).unwrap_or("");
    if fg != adopted.foreground {
        return Err(format!("前景行程已變成「{}」，不是接手時的 {}", live.pane.title.trim(), adopted.foreground));
    }
    let canon = pane_cwd_to_local(&live.pane.cwd)?;
    if !cwd_in_allow(&canon, &config.cwd_allow) {
        return Err("工作資料夾已離開允許清單".into());
    }
    Ok(())
}

pub fn foreground_still_known(title: &str) -> bool {
    known_profile_from_pane_title(title).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真機核對過的寫法：WezTerm 20240203 在 Windows 回報 `file:///C:/Users/…/資料夾/`（主機名稱是空的、結尾有斜線）
    #[test]
    fn 工作資料夾_真機寫法轉成本機路徑_且和授權清單用同一個正規化() {
        let d = tempfile::tempdir().unwrap();
        let canon = canonical_launch_cwd(&d.path().to_string_lossy()).unwrap();
        let plain = canon.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
        let url = if plain.starts_with('/') { format!("file://{plain}/") } else { format!("file:///{plain}/") };
        let got = pane_cwd_to_local(&url).unwrap();
        assert_eq!(got, canon, "{url}");
        assert!(cwd_in_allow(&got, &[canon]));
    }

    #[test]
    fn 只認識已知_cli() {
        assert_eq!(known_profile_from_pane_title("grok.exe"), Some("grok"));
        assert_eq!(known_profile_from_pane_title("cmd.exe"), None);
        assert_eq!(known_profile_from_pane_title("python.exe"), None);
    }

    #[test]
    fn 工作資料夾拒絕空_wsl_ssh() {
        assert!(pane_cwd_to_local("").is_err());
        assert!(pane_cwd_to_local("//wsl.localhost/Ubuntu/home").is_err());
        assert!(pane_cwd_to_local("user@host:/tmp").is_err());
    }

    #[test]
    fn idle_time_三種_json_格式都能解析() {
        assert_eq!(parse_idle_time_value(&serde_json::json!({"secs": 3, "nanos": 500_000_000})).unwrap(), 3.5);
        assert_eq!(parse_idle_time_value(&serde_json::json!(4.25)).unwrap(), 4.25);
        assert_eq!(parse_idle_time_value(&serde_json::json!(7)).unwrap(), 7.0);
        assert!(parse_idle_time_value(&serde_json::json!("bad")).is_err());
        assert!(parse_idle_time_value(&serde_json::json!({"nanos": 1})).is_err());
    }

    #[test]
    fn 使用者閒置_4_秒拒絕_5_6_秒放行_訊息依焦點區分() {
        let on_target = vec![ParsedWezClient { idle_secs: 4.0, focused_pane_id: 9 }];
        assert!(check_user_idle_for_write(&on_target, 9).unwrap_err().contains("焦點與輸入都在這個窗格"));
        let elsewhere = vec![ParsedWezClient { idle_secs: 4.0, focused_pane_id: 99 }];
        assert!(check_user_idle_for_write(&elsewhere, 9).unwrap_err().contains("剛操作過 WezTerm"));
        let ok = vec![ParsedWezClient { idle_secs: 5.0, focused_pane_id: 9 }];
        check_user_idle_for_write(&ok, 9).unwrap();
        let ok2 = vec![ParsedWezClient { idle_secs: 6.0, focused_pane_id: 99 }];
        check_user_idle_for_write(&ok2, 9).unwrap();
        // 實例最短 idle 仍算：另一格閒置夠久也不放行
        let mixed = vec![
            ParsedWezClient { idle_secs: 2.0, focused_pane_id: 99 },
            ParsedWezClient { idle_secs: 60.0, focused_pane_id: 9 },
        ];
        assert!(check_user_idle_for_write(&mixed, 9).unwrap_err().contains("剛操作過 WezTerm"));
    }

    #[test]
    fn list_clients_json_空陣列_缺_idle_格式錯誤() {
        assert!(parse_list_clients_json("[]").unwrap_err().contains("client"));
        assert!(parse_list_clients_json(r#"[{"pid":1}]"#).unwrap_err().contains("idle_time"));
        assert!(parse_list_clients_json("not-json").unwrap_err().contains("解析"));
        assert!(parse_list_clients_json("{}").unwrap_err().contains("陣列"));
        let ok = parse_list_clients_json(r#"[{"idle_time":{"secs":5,"nanos":0}}]"#).unwrap();
        assert_eq!(min_user_idle_secs(&ok).unwrap(), 5.0);
        let float_ok = parse_list_clients_json(r#"[{"idle_time":3.5,"focused_pane_id":1}]"#).unwrap();
        assert_eq!(float_ok[0].idle_secs, 3.5);
    }
}
