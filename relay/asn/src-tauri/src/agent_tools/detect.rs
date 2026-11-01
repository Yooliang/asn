//! 僅偵測 PATH 上是否有 CLI 指令；不讀取 ~/.claude、auth.json 等任何憑證檔。

use crate::nowin::NoWindow;
use std::path::PathBuf;

pub fn binary_on_path(name: &str) -> bool {
    resolve_binary(name).is_some()
}

/// npm 的無副檔名殼（給 sh 用，Windows 不能直接執行）常排在 `.cmd` 前面；
/// 優先挑 `.exe`／`.com`／`.cmd`／`.bat`，都沒有才退回第一個。
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_windows_candidate(cands: &[PathBuf]) -> Option<PathBuf> {
    let runnable = |p: &&PathBuf| {
        let low = p.to_string_lossy().to_ascii_lowercase();
        [".exe", ".com", ".cmd", ".bat"].iter().any(|e| low.ends_with(e))
    };
    cands.iter().find(runnable).or_else(|| cands.first()).cloned()
}

/// PATH 每個資料夾依序找 `name` 本身與 `name`＋PATHEXT 各副檔名（同 `where` 的順序），只留真的存在的檔案。
/// 不呼叫 `where`：它的輸出是主控台字碼頁（繁中 Windows 是 Big5），當 UTF-8 解會把中文使用者資料夾解壞，
/// 拿到不存在的路徑（新家用機的使用者資料夾是中文，claude 一開就以 code 1 結束）。
#[cfg_attr(not(windows), allow(dead_code))]
fn path_candidates(path: &std::ffi::OsStr, pathext: &str, name: &str) -> Vec<PathBuf> {
    let exts: Vec<String> = pathext.split(';').map(str::trim).filter(|e| !e.is_empty()).map(str::to_ascii_lowercase).collect();
    std::env::split_paths(path)
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| std::iter::once(d.join(name)).chain(exts.iter().map(|e| d.join(format!("{name}{e}"))).collect::<Vec<_>>()))
        .filter(|p| p.is_file())
        .collect()
}

/// PATH 上第一個可執行檔路徑（與 agent-tools-detect.mjs 的 lookup 對齊）；找不到再看官方安裝程式固定放的位置。
pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    resolve_on_path(name)
        .or_else(|| known_home_binary(&crate::identity::home_dir(), name))
        .or_else(|| package_manager_binary(name))
}

/// 用套件管理員全域安裝、PATH 可能還沒跟上的工具（#394：ASN 開機自動啟動、或比 pi 早開，拿到的 PATH 是舊的）
const PACKAGE_MANAGED: &[&str] = &["pi"];

/// 測試用假的執行檔資料夾時不看真實的安裝位置（不然這台剛好裝了 pi，測試就分不出「沒有 pi」）
fn package_manager_binary(name: &str) -> Option<PathBuf> {
    if crate::envc::get("ASN_MOCK_BIN_DIR").is_some() {
        return None;
    }
    let env_dir = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    find_in_dirs(&package_manager_dirs(&crate::identity::home_dir(), env_dir("APPDATA").as_deref(), env_dir("LOCALAPPDATA").as_deref()), name)
}

/// npm、pnpm、scoop 預設的全域執行檔資料夾（找不到 pi 時的說明也列這幾處）
fn package_manager_dirs(home: &std::path::Path, appdata: Option<&std::path::Path>, local: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(a) = appdata {
        v.push(a.join("npm"));
    }
    if let Some(l) = local {
        v.push(l.join("pnpm"));
    }
    v.push(home.join("scoop").join("shims"));
    v.push(home.join(".npm-global").join("bin"));
    v.push(home.join(".local").join("share").join("pnpm"));
    v.push(home.join(".local").join("bin"));
    v
}

fn find_in_dirs(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    if !PACKAGE_MANAGED.contains(&name) {
        return None;
    }
    let files: Vec<String> = if cfg!(windows) { [".cmd", ".exe", ".bat"].iter().map(|e| format!("{name}{e}")).collect() } else { vec![name.to_string()] };
    dirs.iter().flat_map(|d| files.iter().map(move |f| d.join(f))).find(|p| p.is_file())
}

/// 官方安裝程式把執行檔放在家目錄底下、而且不一定加進 PATH 的工具：Grok 在 ~/.grok/bin（否則偵測與「開新夥伴」永遠說它沒安裝）
fn known_home_binary(home: &std::path::Path, name: &str) -> Option<PathBuf> {
    if name != "grok" {
        return None;
    }
    ["grok.exe", "grok"].iter().map(|n| home.join(".grok").join("bin").join(n)).find(|p| p.is_file())
}

fn resolve_on_path(name: &str) -> Option<PathBuf> {
    if let Some(p) = crate::envc::get("ASN_MOCK_BIN_DIR") {
        let base = PathBuf::from(p);
        let win = base.join(format!("{name}.exe"));
        if win.is_file() {
            return Some(win);
        }
        let nx = base.join(name);
        if nx.is_file() {
            return Some(nx);
        }
    }
    #[cfg(windows)]
    {
        let path = std::env::var_os("PATH")?;
        let pathext = std::env::var("PATHEXT").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
        pick_windows_candidate(&path_candidates(&path, &pathext, name))
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("sh").no_window()
            .arg("-c")
            .arg(format!("command -v {name}"))
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if line.is_empty() {
            None
        } else {
            Some(PathBuf::from(line))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_tools::catalog::tool;

    #[test]
    fn grok_不在_path_時看家目錄的_grok_bin_其他工具不看() {
        let home = std::env::temp_dir().join(format!("asn-detect-home-{}", std::process::id()));
        let bin = home.join(".grok").join("bin");
        assert_eq!(known_home_binary(&home, "grok"), None, "沒裝＝找不到，不能憑空造出路徑");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(if cfg!(windows) { "grok.exe" } else { "grok" });
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(known_home_binary(&home, "grok"), Some(exe));
        assert_eq!(known_home_binary(&home, "claude"), None, "只有 grok 有這個固定位置");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn pi_不在_path_時看_npm_pnpm_scoop_的安裝資料夾_其他工具不看() {
        let root = std::env::temp_dir().join(format!("asn-detect-pm-{}", std::process::id()));
        let (home, appdata, local) = (root.join("home"), root.join("roaming"), root.join("local"));
        let dirs = package_manager_dirs(&home, Some(&appdata), Some(&local));
        assert_eq!(dirs[0], appdata.join("npm"));
        assert_eq!(dirs[1], local.join("pnpm"));
        assert!(dirs.contains(&home.join("scoop").join("shims")));
        assert_eq!(find_in_dirs(&dirs, "pi"), None, "沒裝＝找不到");
        let file = if cfg!(windows) { "pi.cmd" } else { "pi" };
        let pnpm = local.join("pnpm");
        std::fs::create_dir_all(&pnpm).unwrap();
        std::fs::write(pnpm.join(file), b"x").unwrap();
        assert_eq!(find_in_dirs(&dirs, "pi"), Some(pnpm.join(file)));
        let npm = appdata.join("npm");
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::write(npm.join(file), b"x").unwrap();
        assert_eq!(find_in_dirs(&dirs, "pi"), Some(npm.join(file)), "npm 排在 pnpm 前面");
        std::fs::write(npm.join(if cfg!(windows) { "claude.cmd" } else { "claude" }), b"x").unwrap();
        assert_eq!(find_in_dirs(&dirs, "claude"), None, "只替 pi 找；其他工具照舊只看 PATH");
        assert_eq!(package_manager_dirs(&home, None, None)[0], home.join("scoop").join("shims"), "沒有 APPDATA 就跳過");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agy_用_binary_名() {
        assert_eq!(tool("agy").unwrap().binary, "agy");
    }
}

#[cfg(test)]
mod pick_tests {
    use super::{path_candidates, pick_windows_candidate};
    use std::path::PathBuf;

    #[test]
    fn 無副檔名的殼排在前面時改挑可執行的() {
        let p = |v: &[&str]| v.iter().map(PathBuf::from).collect::<Vec<_>>();
        assert_eq!(pick_windows_candidate(&p(&["C:/npm/claude", "C:/npm/claude.cmd"])).unwrap(), PathBuf::from("C:/npm/claude.cmd"));
        assert_eq!(pick_windows_candidate(&p(&["C:/x/claude.exe", "C:/y/claude.cmd"])).unwrap(), PathBuf::from("C:/x/claude.exe"));
        assert_eq!(pick_windows_candidate(&p(&["C:/only/claude"])).unwrap(), PathBuf::from("C:/only/claude"));
        assert!(pick_windows_candidate(&[]).is_none());
    }

    /// 新家用機：使用者資料夾是中文，舊做法經 `where` 拿到亂碼路徑
    #[test]
    fn 中文資料夾的路徑原樣找到_不存在的不收() {
        let tmp = tempfile::tempdir().unwrap();
        let npm = tmp.path().join("牧陽").join("npm");
        let bin = tmp.path().join("牧陽").join(".local").join("bin");
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(npm.join("claude"), b"#!/bin/sh").unwrap();
        std::fs::write(bin.join("claude.exe"), b"MZ").unwrap();
        let missing = tmp.path().join("沒有這個資料夾");
        let path = std::env::join_paths([missing, npm.clone(), bin.clone()]).unwrap();
        let got = path_candidates(&path, ".COM;.EXE;.BAT;.CMD", "claude");
        assert_eq!(got, vec![npm.join("claude"), bin.join("claude.exe")], "依 PATH 順序、只留存在的檔案");
        let pick = pick_windows_candidate(&got).unwrap();
        assert_eq!(pick, bin.join("claude.exe"));
        assert!(pick.is_file(), "挑到的路徑要能直接用");
    }
}
