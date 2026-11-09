//! 本機 AI CLI 偵測（PATH）、驗證式安裝與登入引導。不執行下載來的安裝腳本（#933），見 `install.rs`。
//! 工具清單與 `relay/shared/agent-tools.catalog.json` 共用，供 issue #23／#48 重用。
//! 不讀取 OAuth 憑證或 auth.json。

mod catalog;
mod detect;

pub use detect::resolve_binary;
mod install;
mod types;

pub use types::{InstallResult, ToolDetectRow, ToolsDetectSnapshot};

use catalog::{tool, InstallKind, tools};
use detect::binary_on_path;
use std::time::{SystemTime, UNIX_EPOCH};

fn checked_at() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn row(def: &catalog::ToolDef) -> ToolDetectRow {
    let binary_found = binary_on_path(&def.binary);
    // 只有寫好「驗過再執行」流程的工具、而且在 Windows 上，才算能由 ASN 安裝（#933：不執行下載來的腳本）
    let install_available = def.install == InstallKind::Verified && cfg!(windows);
    let login_available = binary_found && !def.login_argv.is_empty();
    ToolDetectRow {
        id: def.id.clone(),
        label: def.label.clone(),
        binary_found,
        install_available,
        login_available,
        // 這台不能由 ASN 安裝（例如非 Windows 上的 Claude）就不顯示「ASN 會下載、驗證後安裝」那段，改成請使用者到官網
        install_blurb: if install_available || def.install == InstallKind::Manual { def.install_blurb.clone() } else { install::manual_text(def) },
        login_blurb: def.login_blurb.clone(),
    }
}

pub fn detect_snapshot() -> ToolsDetectSnapshot {
    ToolsDetectSnapshot {
        checked_at: checked_at(),
        tools: tools().iter().map(row).collect(),
    }
}

#[cfg_attr(feature = "gui", tauri::command)]
pub async fn ai_cli_detect() -> ToolsDetectSnapshot {
    tokio::task::spawn_blocking(detect_snapshot)
        .await
        .unwrap_or_else(|_| ToolsDetectSnapshot {
            checked_at: checked_at(),
            tools: vec![],
        })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub async fn ai_cli_install(tool_id: String) -> Result<InstallResult, String> {
    if tool(&tool_id).is_none() {
        return Err("不認得這個工具。".into());
    }
    Ok(tokio::task::spawn_blocking(move || install::install_tool(&tool_id, true))
        .await
        .map_err(|e| e.to_string())?)
}

/// 僅開啟登入用終端機（不是「啟動 CLI 工作階段」捷徑）。
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn ai_cli_login(tool_id: String) -> Result<(), String> {
    let def = tool(&tool_id).ok_or_else(|| "不認得這個工具。".to_string())?.clone();
    if def.login_argv.is_empty() {
        return Err("請在官方應用程式內登入。".into());
    }
    if !binary_on_path(&def.binary) {
        return Err(format!("尚未安裝 {}，請先按「安裝」。", def.label));
    }
    tokio::task::spawn_blocking(move || install::open_login_terminal(&def))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 工具清單載入() {
        assert_eq!(tools().len(), 5);
    }

    #[test]
    fn 能安裝的只有_windows_上的_claude() {
        for def in tools() {
            let want = cfg!(windows) && def.id == "claude";
            assert_eq!(row(def).install_available, want, "{}", def.id);
        }
    }

    #[test]
    fn 不能由_asn_安裝時_說明不提下載驗證_改請使用者到官網() {
        for def in tools() {
            let r = row(def);
            if r.install_available {
                assert!(r.install_blurb.contains("驗過數位簽章"), "{}：{}", def.id, r.install_blurb);
            } else {
                assert!(r.install_blurb.contains("官網"), "{}：{}", def.id, r.install_blurb);
                assert!(!r.install_blurb.contains("將從"), "{}：{}", def.id, r.install_blurb);
            }
        }
        // 清單標 verified、但這台不能裝（模擬非 Windows）時的說明
        let mut c = tool("claude").unwrap().clone();
        c.install = InstallKind::Verified;
        assert!(install::manual_text(&c).contains("請到官網"));
    }
}
