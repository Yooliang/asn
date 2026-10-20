//! 偵測本機是否已安裝 CLI、是否已有登入憑證（只檢查檔案是否存在與 JSON 欄位，不記錄 token 值）。

use crate::identity;
use super::catalog::{ToolDef, UsageKind};
use super::types::AuthState;
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    identity::home_dir()
}

pub fn binary_on_path(name: &str) -> bool {
    if let Ok(p) = std::env::var("IRORI_ASN_MOCK_BIN_DIR") {
        let base = PathBuf::from(p);
        if base.join(name).exists() || (cfg!(windows) && base.join(format!("{name}.exe")).exists()) {
            return true;
        }
    }
    which(name)
}

fn which(name: &str) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("where")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {name}"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

pub fn auth_state(tool: &ToolDef) -> AuthState {
    if tool.usage == UsageKind::Unsupported {
        return AuthState::Unavailable;
    }
    let installed = tool.install != super::catalog::InstallKind::None && binary_on_path(&tool.binary);
    let cred = has_credentials(tool);
    match (installed, cred, tool.usage) {
        (false, _, _) if tool.install != super::catalog::InstallKind::None => AuthState::NotInstalled,
        (_, false, UsageKind::None) if installed => AuthState::LoggedIn,
        (_, false, UsageKind::None) => AuthState::NotInstalled,
        (true, false, _) | (false, false, _) => AuthState::NotLoggedIn,
        (_, true, _) => AuthState::LoggedIn,
    }
}

pub fn has_credentials(tool: &ToolDef) -> bool {
    match tool.id.as_str() {
        "claude" => json_has_token(&home().join(".claude/.credentials.json"), &["claudeAiOauth", "accessToken"]),
        "codex" => json_has_token(&codex_auth_path(), &["tokens", "access_token"]),
        "agy" => agy_has_auth(),
        "grok" => grok_has_auth(),
        "pi" => home().join(".pi/agent/auth.json").exists(),
        _ => false,
    }
}

fn codex_auth_path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".codex"))
        .join("auth.json")
}

fn agy_has_auth() -> bool {
    for p in agy_oauth_paths() {
        if json_has_token(&p, &["access_token"]) || json_has_token(&p, &["token"]) {
            return true;
        }
    }
    false
}

pub fn agy_oauth_paths() -> Vec<PathBuf> {
    let h = home();
    vec![
        h.join(".gemini/antigravity-cli/antigravity-oauth-token.json"),
        h.join(".gemini/oauth_creds.json"),
        h.join(".config/gemini/antigravity/oauth_creds.json"),
    ]
}

fn grok_has_auth() -> bool {
    let auth = std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".grok"))
        .join("auth.json");
    if !auth.exists() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(&auth) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    grok_token_present(&v)
}

fn grok_token_present(v: &serde_json::Value) -> bool {
    v.as_object().is_some_and(|obj| {
        obj.values().any(|entry| {
            entry.get("key").and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty())
        })
    })
}

fn json_has_token(path: &Path, path_keys: &[&str]) -> bool {
    if !path.exists() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    for k in path_keys {
        v = match v.get(*k) {
            Some(x) => x.clone(),
            None => return false,
        };
    }
    v.as_str().is_some_and(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_usage::catalog::tool;

    #[test]
    fn claude_憑證路徑判定() {
        let dir = tempfile::tempdir().unwrap();
        let cred = dir.path().join("c.json");
        std::fs::write(&cred, r#"{"claudeAiOauth":{"accessToken":"x"}}"#).unwrap();
        assert!(json_has_token(&cred, &["claudeAiOauth", "accessToken"]));
    }

    #[test]
    fn grok_auth_形狀() {
        let body = r#"{"https://auth.x.ai::user":{"key":"tok"}}"#;
        let v: serde_json::Value = serde_json::from_str(body).unwrap();
        assert!(grok_token_present(&v));
    }

    #[test]
    fn agy_用_binary_名() {
        assert_eq!(tool("agy").unwrap().binary, "agy");
    }
}
