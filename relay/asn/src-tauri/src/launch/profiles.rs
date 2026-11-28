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

/// Codex 預設的啟動指令與參數。**不帶 `resume`**：要接舊對話還是開新的，由 launch/codex_open.rs 在開窗前決定、
/// 再用對話代號補在最後（寫死 `resume {name}` 時，新名字沒有舊對話，Codex 會直接結束，#2485）
pub(crate) fn codex_command(exe: &str, windows: bool, comspec: &str) -> (String, Vec<String>) {
    if windows {
        let args = ["/c", exe, "-c", "check_for_update_on_startup=false", "-s", "workspace-write", "-a", "on-request"];
        (comspec.to_string(), args.iter().map(|s| s.to_string()).collect())
    } else {
        ("/bin/sh".into(), vec!["-lc".into(), format!("{} -c check_for_update_on_startup=false -s workspace-write -a on-request", shell_quote(exe))])
    }
}

pub(crate) fn shell_quote(s: &str) -> String {
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
                label: "Claude".into(),
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
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let (command, args) = codex_command(&c, cfg!(windows), &comspec);
        profiles.insert(
            "codex".into(),
            Profile {
                label: "Codex".into(),
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
                label: "Gemini".into(),
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
                label: "Grok".into(),
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
        label: "pi".into(),
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
mod claude_command_tests {
    use super::*;

    /// 開視窗實際執行的是偵測到的完整路徑（官方安裝程式的 ~/.local/bin 不在 PATH 時，叫裸名字 claude 會找不到）
    #[test]
    fn claude_的啟動指令是偵測到的完整路徑() {
        let profiles = build_default_profiles(&home_dir());
        match resolve_binary("claude") {
            Some(exe) => {
                let c = &profiles["claude"].command;
                assert_eq!(Path::new(c), exe.as_path());
                assert!(Path::new(c).is_absolute() || exe.is_absolute(), "{c}");
            }
            None => assert!(!profiles.contains_key("claude"), "沒偵測到就不產生 claude 設定"),
        }
    }
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
mod codex_profile_tests {
    use super::*;

    /// #2485：預設啟動方式不能寫死 resume（新名字沒有舊對話，Codex 0.153.4 會直接結束）；Windows 陣列形與非 Windows 字串形都要守
    #[test]
    fn codex_預設啟動方式_兩種形狀都不帶_resume() {
        let (cmd, args) = codex_command(r"C:\npm\codex.cmd", true, "cmd.exe");
        assert_eq!(cmd, "cmd.exe");
        assert_eq!(args, ["/c", r"C:\npm\codex.cmd", "-c", "check_for_update_on_startup=false", "-s", "workspace-write", "-a", "on-request"]);
        assert!(!args.iter().any(|a| a.contains("resume") || a.contains("{name}")), "{args:?}");
        let (cmd, args) = codex_command("/usr/bin/codex", false, "cmd.exe");
        assert_eq!(cmd, "/bin/sh");
        assert_eq!(args, ["-lc", "/usr/bin/codex -c check_for_update_on_startup=false -s workspace-write -a on-request"]);
        assert!(!args[1].contains("resume") && !args[1].contains("{name}"), "{args:?}");
    }

    /// 守門：正式程式的 Codex 設定段不准再寫 resume（只掃非測試區段）
    #[test]
    fn 守門_codex_預設設定的原始碼沒有_resume() {
        let src = crate::settings::src_scan::prod_source(include_str!("profiles.rs")).replace("\r\n", "\n");
        let from = src.find("pub(crate) fn codex_command").unwrap();
        let body = &src[from..from + src[from..].find("\n}\n").unwrap()];
        assert!(!body.contains("resume"), "{body}");
        let build = src.split("pub fn build_default_profiles").nth(1).unwrap().split("fn grok_home_binary").next().unwrap();
        assert!(!build.contains("resume"), "build_default_profiles 裡不准寫 resume");
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
