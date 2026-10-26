//! 僅偵測 PATH 上是否有 CLI 指令；不讀取 ~/.claude、auth.json 等任何憑證檔。

use crate::nowin::NoWindow;
use std::path::PathBuf;

pub fn binary_on_path(name: &str) -> bool {
    resolve_binary(name).is_some()
}

/// `where` 的輸出常把 npm 的無副檔名殼（給 sh 用，Windows 不能直接執行）排在 `.cmd` 前面；
/// 優先挑 `.exe`／`.com`／`.cmd`／`.bat`，都沒有才退回第一行。
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_windows_candidate(where_output: &str) -> Option<String> {
    let lines: Vec<&str> = where_output.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let runnable = |l: &&&str| {
        let low = l.to_ascii_lowercase();
        [".exe", ".com", ".cmd", ".bat"].iter().any(|e| low.ends_with(e))
    };
    lines.iter().find(runnable).or_else(|| lines.first()).map(|l| l.to_string())
}

/// PATH 上第一個可執行檔路徑（與 agent-tools-detect.mjs 的 lookup 對齊）；找不到再看官方安裝程式固定放的位置。
pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    resolve_on_path(name).or_else(|| known_home_binary(&crate::identity::home_dir(), name))
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
        let out = std::process::Command::new("where").no_window()
            .arg(name)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        pick_windows_candidate(&text).map(PathBuf::from)
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
    fn agy_用_binary_名() {
        assert_eq!(tool("agy").unwrap().binary, "agy");
    }
}

#[cfg(test)]
mod pick_tests {
    use super::pick_windows_candidate;

    #[test]
    fn 無副檔名的殼排在前面時改挑可執行的() {
        let out = "C:/npm/claude\r\nC:/npm/claude.cmd\r\n";
        assert_eq!(pick_windows_candidate(out).unwrap(), "C:/npm/claude.cmd");
        let exe = "C:/x/claude.exe\r\nC:/y/claude.cmd\r\n";
        assert_eq!(pick_windows_candidate(exe).unwrap(), "C:/x/claude.exe");
        assert_eq!(pick_windows_candidate("C:/only/claude\r\n").unwrap(), "C:/only/claude");
        assert!(pick_windows_candidate("").is_none());
    }
}
