//! 接手使用者自己開著的 WezTerm 窗格（議題 #285 定案版）。只存記憶體，不寫檔。
#![cfg(desktop)]

use super::config::{canonical_launch_cwd, LaunchConfig};
use super::cwds;
use super::switch;
use super::wezterm::{self, Fs, PaneInfo, Runner, WezTerm, Window};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 隨安裝檔附帶、真機實測過的 WezTerm 標籤。
pub const VERIFIED_WEZTERM_TAG: &str = "20240203";

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

pub fn verify_adopted_for_write(
    live: &LivePane,
    adopted: &AdoptedSnap,
    config: &LaunchConfig,
) -> Result<(), String> {
    let fg = known_profile_from_pane_title(&live.pane.title).unwrap_or("");
    if fg != adopted.foreground {
        return Err(format!("前景行程已變成「{}」，不是接手時的 {}", live.pane.title.trim(), adopted.foreground));
    }
    if live.pane.is_active {
        return Err("你正在操作這個窗格，ASN 不會代送（請先切到別處再試）".into());
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
}
