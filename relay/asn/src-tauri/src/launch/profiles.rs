//! 依 PATH 上的 CLI 產生 bootstrap profile（對齊 relay/shared/launcher-profiles.mjs）。
use crate::agent_tools::resolve_binary;
use crate::identity::home_dir;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchMode {
    Window,
    Background,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub engine: String,
    pub mode: LaunchMode,
    pub disabled: bool,
    pub disabled_reason: String,
}

pub fn default_cwd_allow(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in ["Github", "Projects", "projects", "Documents", "workspace"] {
        out.push(home.join(p));
    }
    out
}

fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '/' || c == '-') {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn build_default_profiles(home: &Path) -> HashMap<String, Profile> {
    let mut profiles = HashMap::new();
    if let Some(cmd) = resolve_binary("claude") {
        let c = cmd.to_string_lossy().into_owned();
        profiles.insert(
            "claude".into(),
            Profile {
                label: "Claude（互動視窗）".into(),
                mode: LaunchMode::Window,
                engine: "claude".into(),
                command: c,
                args: vec![
                    "--dangerously-skip-permissions".into(),
                    "-n".into(),
                    "{name}".into(),
                    "--remote-control".into(),
                    "{name}".into(),
                ],
                disabled: false,
                disabled_reason: String::new(),
            },
        );
    }
    if let Some(cmd) = resolve_binary("codex") {
        let c = cmd.to_string_lossy().into_owned();
        let (command, args) = if cfg!(windows) {
            let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
            (
                comspec,
                vec![
                    "/c".into(),
                    c,
                    "-c".into(),
                    "check_for_update_on_startup=false".into(),
                    "-s".into(),
                    "workspace-write".into(),
                    "-a".into(),
                    "on-request".into(),
                    "resume".into(),
                    "{name}".into(),
                ],
            )
        } else {
            (
                "/bin/sh".into(),
                vec![
                    "-lc".into(),
                    format!("{} -c check_for_update_on_startup=false -s workspace-write -a on-request resume {{name}}", shell_quote(&c)),
                ],
            )
        };
        profiles.insert(
            "codex".into(),
            Profile {
                label: "Codex（互動視窗）".into(),
                mode: LaunchMode::Window,
                engine: "codex".into(),
                command,
                args,
                disabled: false,
                disabled_reason: String::new(),
            },
        );
    }
    if let Some(cmd) = resolve_binary("agy") {
        let c = cmd.to_string_lossy().into_owned();
        profiles.insert(
            "gemini".into(),
            Profile {
                label: "Gemini（背景工作者）".into(),
                mode: LaunchMode::Background,
                engine: "acp".into(),
                command: c,
                args: vec![],
                disabled: false,
                disabled_reason: String::new(),
            },
        );
    }
    if let Some(cmd) = resolve_binary("grok").or_else(|| grok_home_binary(home)) {
        let c = cmd.to_string_lossy().into_owned();
        profiles.insert(
            "grok".into(),
            Profile {
                label: "Grok（背景工作者）".into(),
                mode: LaunchMode::Background,
                engine: "acp".into(),
                command: c,
                args: vec!["agent".into(), "stdio".into()],
                disabled: false,
                disabled_reason: String::new(),
            },
        );
    }
    if let Some(cmd) = resolve_binary("pi") {
        profiles.insert("pi".into(), pi_profile(&cmd.to_string_lossy()));
    }
    profiles
}

/// Grok 官方安裝程式把執行檔放在 ~/.grok/bin，而且不一定加進 PATH：PATH 找不到時看這個固定位置（否則「開新夥伴」永遠沒有 Grok）
fn grok_home_binary(home: &Path) -> Option<std::path::PathBuf> {
    ["grok.exe", "grok"].iter().map(|n| home.join(".grok").join("bin").join(n)).find(|p| p.is_file())
}

/// pi 互動視窗：直接執行 pi；載入收信擴充、名字、第一句話由 launch/pi.rs 在開窗前補上（找不到擴充會報錯）
pub(crate) fn pi_profile(cmd: &str) -> Profile {
    Profile {
        label: "pi（互動視窗）".into(),
        mode: LaunchMode::Window,
        engine: "pi".into(),
        command: cmd.to_string(),
        args: vec![],
        disabled: false,
        disabled_reason: String::new(),
    }
}

pub fn bootstrap_config() -> Option<(HashMap<String, Profile>, Vec<PathBuf>, u32)> {
    let home = home_dir();
    let profiles = build_default_profiles(&home);
    if profiles.is_empty() {
        return None;
    }
    Some((profiles, default_cwd_allow(&home), 6))
}

#[cfg(test)]
mod pi_tests {
    use super::*;

    #[test]
    fn pi_profile_可啟動_互動視窗_不再是停用() {
        let p = pi_profile(r"C:\npm\pi.cmd");
        assert!(!p.disabled && p.disabled_reason.is_empty());
        assert_eq!(p.mode, LaunchMode::Window);
        assert_eq!(p.engine, "pi");
        assert_eq!(p.command, r"C:\npm\pi.cmd");
    }
}

#[cfg(test)]
mod grok_home_tests {
    use super::*;

    #[test]
    fn grok_不在_path_時看_家目錄的_grok_bin() {
        let home = std::env::temp_dir().join(format!("asn-grok-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(grok_home_binary(&home), None, "沒有安裝＝找不到，不能憑空造出路徑");
        let bin = home.join(".grok").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("grok.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(grok_home_binary(&home), Some(exe));
        let _ = std::fs::remove_dir_all(&home);
    }
}
