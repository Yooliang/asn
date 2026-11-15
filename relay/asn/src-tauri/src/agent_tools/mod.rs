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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 問版本最多等這麼久；超過就殺掉整棵程序樹、當作讀不到（不擋住偵測）
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

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
        version: String::new(),
    }
}

/// 從 `--version` 的輸出取版本號（#1548）：第一個「數字.數字」到「數字.數字.數字.數字」的字，可以 v 開頭。
/// 只收數字與點、每段最多 6 位，其餘一律不要（畫面直接顯示這個字串）；看不懂回 None，不去猜。
/// 實際輸出例：`2.0.31 (Claude Code)`、`codex-cli 0.46.0`
pub fn parse_version(out: &str) -> Option<String> {
    let ok = |t: &str| {
        let parts: Vec<&str> = t.split('.').collect();
        (2..=4).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
    };
    out.split(|c: char| c.is_whitespace() || matches!(c, ',' | '(' | ')' | '[' | ']' | '"'))
        .map(|t| t.strip_prefix(['v', 'V']).unwrap_or(t))
        .find(|t| ok(t))
        .map(String::from)
}

/// 跑偵測到的那個執行檔的 `--version`（不讀任何設定或憑證檔）；結束碼不是 0、逾時、看不懂都回空字串。
/// 測試用假的執行檔資料夾時不跑（假檔不是真的程式）
fn installed_version(binary: &str) -> String {
    if crate::envc::get("ASN_MOCK_BIN_DIR").is_some() {
        return String::new();
    }
    let Some(exe) = resolve_binary(binary) else { return String::new() };
    match crate::agent_setup::proc::run_capture(&exe, &["--version"], VERSION_TIMEOUT) {
        Ok((0, out)) => parse_version(&out).unwrap_or_default(),
        _ => String::new(),
    }
}

/// 五家同時問版本（各自最多 5 秒），整份偵測不會被某一家拖太久
pub fn detect_snapshot() -> ToolsDetectSnapshot {
    let defs = tools();
    let rows = std::thread::scope(|s| {
        let jobs: Vec<_> = defs
            .iter()
            .map(|d| {
                (
                    d,
                    s.spawn(move || {
                        let mut r = row(d);
                        if r.binary_found {
                            r.version = installed_version(&d.binary);
                        }
                        r
                    }),
                )
            })
            .collect();
        jobs.into_iter().map(|(d, h)| h.join().unwrap_or_else(|_| row(d))).collect()
    });
    ToolsDetectSnapshot { checked_at: checked_at(), tools: rows }
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
    fn 版本號只收數字與點_看不懂不猜() {
        assert_eq!(parse_version("2.0.31 (Claude Code)\n").as_deref(), Some("2.0.31"));
        assert_eq!(parse_version("codex-cli 0.46.0").as_deref(), Some("0.46.0"));
        assert_eq!(parse_version("grok v1.4.2").as_deref(), Some("1.4.2"));
        assert_eq!(parse_version("pi 0.9").as_deref(), Some("0.9"));
        assert_eq!(parse_version("version: 1.2.3.4").as_deref(), Some("1.2.3.4"));
        for bad in ["", "unknown", "1", "1.2.3.4.5", "1.2.x", "1..2", "1.2.3-beta", "1234567.1", "<b>1.2</b>"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn 偵測結果每家都帶版本欄位() {
        // row 本身不跑任何指令（版本在 detect_snapshot 才問），欄位一定在、先是空字串；前端讀的就是這個 version
        for def in tools() {
            let v = serde_json::to_value(row(def)).unwrap();
            assert_eq!(v.get("version"), Some(&serde_json::json!("")), "{}", def.id);
        }
    }

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
