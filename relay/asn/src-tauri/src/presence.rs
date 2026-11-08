//! 確認是本人在這台按的（#597，0.2.8 改版）。**只確認在場，不簽章、不產生金鑰**：簽章用的是設備金鑰（device_id）。
//!
//! **11-08 起沒有人呼叫**：小良哥決定看別台畫面、別台打字都不再跳 Windows Hello 或確認框（#1029 續）。
//! 模組保留，之後可能還會用到；守門測試鎖住「發起不跳本人確認」。
//!
//! - Windows 有 Hello：用 UserConsentVerifier 要本人輸入 PIN 或指紋。呼叫前先把 ASN 叫到前面，提示才不會被別的視窗擋住。
//! - 沒有 Hello（沒設、被原則關掉、不是 Windows）：跳一個系統確認框，[`ASK_SECS`] 秒沒按就當取消。
//! - **結果只在 Rust 裡用，沒有任何畫面命令能回報「本人同意」**（守門測試）；只有 lib.rs 的 `term_view_remote_start` 能叫 [`confirm`]。
#![allow(dead_code)]
use tauri::{AppHandle, Manager, WebviewWindow};

/// 確認框等多久（秒）
pub const ASK_SECS: u64 = 60;
pub const CANCELED: &str = "已取消，沒有開始";
pub const TIMED_OUT: &str = "太久沒有確認，沒有開始";
#[cfg_attr(not(windows), allow(dead_code))]
pub const FAILED: &str = "沒辦法確認是你本人，沒有開始";

/// Hello 確認的結果：None＝這台沒有可用的 Hello，改用確認框
#[cfg(windows)]
fn hello(message: &str) -> Result<Option<()>, String> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult as R, UserConsentVerifier, UserConsentVerifierAvailability};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    // 等 Windows 的非同步結果需要 COM（同一執行緒重複初始化無害）
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let avail = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()).map_err(|e| {
        elog!("[ASN] Windows Hello 查不到：{e}");
        FAILED.to_string()
    })?;
    if avail != UserConsentVerifierAvailability::Available {
        return Ok(None);
    }
    let r = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(message)).and_then(|op| op.join()).map_err(|e| {
        elog!("[ASN] Windows Hello 沒有完成：{e}");
        FAILED.to_string()
    })?;
    match r {
        R::Verified => Ok(Some(())),
        R::Canceled => Err(CANCELED.into()),
        _ => Err(FAILED.into()),
    }
}

#[cfg(not(windows))]
fn hello(_message: &str) -> Result<Option<()>, String> {
    Ok(None)
}

/// 沒有 Hello：系統確認框，逾時當取消
async fn ask(app: &AppHandle, message: &str) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(message)
        .title("ASN")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("開始看".into(), "取消".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    match tokio::time::timeout(std::time::Duration::from_secs(ASK_SECS), rx).await {
        Ok(Ok(true)) => Ok(()),
        Ok(_) => Err(CANCELED.into()),
        Err(_) => Err(TIMED_OUT.into()),
    }
}

/// 確認是本人：有 Hello 用 Hello，沒有就跳確認框。成功回 Ok
pub async fn confirm(window: &WebviewWindow, message: &str) -> Result<(), String> {
    let _ = window.unminimize();
    let _ = window.set_focus();
    let m = message.to_string();
    match tokio::task::spawn_blocking(move || hello(&m)).await.map_err(|e| e.to_string())?? {
        Some(()) => Ok(()),
        None => ask(window.app_handle(), message).await,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn 守門_發起看畫面和打字都不跳本人確認_也沒有畫面命令能回報同意() {
        let me = include_str!("presence.rs");
        let code = me.split("\nmod tests {").next().unwrap();
        assert!(!code.contains(concat!("#[tauri", "::command]")), "這裡不能有畫面命令");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut callers = Vec::new();
        for e in walk(&dir) {
            if e.ends_with("presence.rs") {
                continue;
            }
            let src = std::fs::read_to_string(&e).unwrap();
            let code = src.split("\nmod tests {").next().unwrap();
            for (i, _) in code.match_indices(concat!("presence", "::confirm(")) {
                let before = &code[..i];
                let f = before.rfind("\nasync fn ").max(before.rfind("\nfn ")).expect("在函式裡");
                let name: String = before[f..].trim_start_matches('\n').trim_start_matches("async ").trim_start_matches("fn ").chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                callers.push(name);
            }
        }
        // 11-08 小良哥決定拿掉：看畫面、打字的發起（term_view_remote_start）都不跳 Hello 或確認框。要加回來請先改這個測試
        assert!(callers.is_empty(), "沒有任何地方再叫本人確認：{callers:?}");
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let start = lib.split("async fn term_view_remote_start(").nth(1).expect("有發起的命令").split("\n}\n").next().unwrap();
        assert!(!start.contains("presence") && !start.contains("dialog"), "發起不跳本人確認");
        assert!(start.contains("key_async") && start.contains("d_start("), "設備金鑰簽章照留（給對方那台驗身分）");
    }

    fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
        out
    }
}
