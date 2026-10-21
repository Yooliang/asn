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
    if let Some(cmd) = resolve_binary("grok") {
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
    if resolve_binary("pi").is_some() {
        let comspec = if cfg!(windows) {
            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into())
        } else {
            "/bin/sh".into()
        };
        profiles.insert(
            "pi".into(),
            Profile {
                label: "pi（互動視窗，實驗）".into(),
                mode: LaunchMode::Window,
                engine: "pi".into(),
                command: comspec,
                args: if cfg!(windows) {
                    vec!["/c".into(), "start".into(), "pi".into(), "{name}".into()]
                } else {
                    vec!["-lc".into(), "pi".into()]
                },
                disabled: true,
                disabled_reason: "pi 互動視窗與收發室整合尚在擴充，請先在終端機手動開 pi".into(),
            },
        );
    }
    let _ = home; // cwd templates 由機器橋處理背景工作者
    profiles
}

pub fn bootstrap_config() -> Option<(HashMap<String, Profile>, Vec<PathBuf>, u32)> {
    let home = home_dir();
    let profiles = build_default_profiles(&home);
    if profiles.is_empty() {
        return None;
    }
    Some((profiles, default_cwd_allow(&home), 6))
}
