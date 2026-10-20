//! 用量分頁：偵測本機 AI CLI、官方安裝引導、登入引導、額度查詢（token 不離開本機、不寫 log）。
//! 工具清單與 `relay/shared/agent-tools.catalog.json` 共用，供 issue #23 開新視窗重用。

mod catalog;
mod detect;
mod fetch;
mod install;
mod parse;
mod types;

pub use types::{AuthState, InstallResult, ProviderUsage, UsageSnapshot};

use catalog::{tool, InstallKind, UsageKind, tools};
use detect::{auth_state, binary_on_path};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_rfc3339() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

fn base_row(def: &catalog::ToolDef) -> ProviderUsage {
    let auth = auth_state(def);
    let binary_found = binary_on_path(&def.binary);
    let install_available = def.install != InstallKind::None;
    let usage_supported = matches!(
        def.usage,
        UsageKind::ClaudeOAuth | UsageKind::CodexOAuth | UsageKind::AgyCodeAssist | UsageKind::GrokCliBilling
    );
    let login_available = !def.login_argv.is_empty() && binary_found && auth == AuthState::NotLoggedIn;
    let note = match (def.usage, auth) {
        (UsageKind::None, AuthState::LoggedIn) => Some("已登入；pi 未提供可讀的訂閱額度 API，ASN 只顯示登入狀態。".into()),
        (UsageKind::None, AuthState::NotInstalled) => None,
        (UsageKind::None, _) => None,
        (_, AuthState::NotInstalled) => None,
        _ => None,
    };
    ProviderUsage {
        id: def.id.clone(),
        label: def.label.clone(),
        auth,
        plan: None,
        windows: vec![],
        note,
        install_available,
        binary_found,
        usage_supported,
        login_available,
        install_blurb: def.install_blurb.clone(),
        login_blurb: def.login_blurb.clone(),
    }
}

pub async fn snapshot() -> UsageSnapshot {
    let mut providers = Vec::new();
    for def in tools() {
        let row = base_row(def);
        let enriched = fetch::enrich_provider(row, def).await;
        providers.push(enriched);
    }
    UsageSnapshot {
        fetched_at: now_rfc3339(),
        providers,
    }
}

#[tauri::command]
pub async fn ai_usage_snapshot() -> UsageSnapshot {
    snapshot().await
}

#[tauri::command]
pub fn ai_cli_install(tool_id: String) -> Result<InstallResult, String> {
    if tool(&tool_id).is_none() {
        return Err("不認得這個工具。".into());
    }
    Ok(install::install_tool(&tool_id, true))
}

/// 僅開啟登入用終端機（不是「啟動 CLI 工作階段」捷徑）。
#[tauri::command]
pub fn ai_cli_login(tool_id: String) -> Result<(), String> {
    let def = tool(&tool_id).ok_or_else(|| "不認得這個工具。".to_string())?;
    if def.login_argv.is_empty() {
        return Err("請在官方應用程式內登入。".into());
    }
    if !binary_on_path(&def.binary) {
        return Err(format!("尚未安裝 {}，請先按「安裝」。", def.label));
    }
    install::open_login_terminal(def)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 工具清單載入() {
        assert_eq!(tools().len(), 5);
    }
}
