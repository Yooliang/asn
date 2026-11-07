//! 別台要在這台打字（0.2.10）：問被打字這台的本人。
//!
//! - **同意框是 ASN 的視窗（系統對話框），不在終端裡：** 終端裡的提示可能被當成按鍵答掉。問之前先把 ASN 叫到前面。
//! - [`ASK_SECS`] 秒沒按當不允許；按了「不允許」、關掉框也是不允許。
//! - **結果只在 Rust 裡用，沒有任何畫面命令能回報「允許」**（守門測試）；只有 lib.rs 的 `start_view_poller` 能叫 [`ask`]。
//! - 本人可以在這台的設定頁「認得的電腦」對某一台設「打字不用每次問我」，那台就不跳這個框（判斷在呼叫端，存在本機）。
use tauri::{AppHandle, Manager};

/// 同意框等多久（秒）
pub const ASK_SECS: u64 = 60;

/// 同意框的話：誰、哪個視窗、能做什麼
pub fn ask_text(who: &str, window: &str) -> String {
    let who = if who.trim().is_empty() { "另一台電腦".to_string() } else { format!("「{}」", who.trim()) };
    format!("{who}要在這台的「{window}」打字。\n\n允許之後，對方可以在這個視窗打任何字，包括回答權限框。最多 10 分鐘，2 分鐘沒打字就自動結束；你隨時可以在 ASN 按「結束」。\n\n要允許嗎？")
}

/// 問本人。允許回 true；不允許、關掉、逾時都回 false
pub async fn ask(app: &AppHandle, who: &str, window: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(ask_text(who, window))
        .title("ASN：別台要在這台打字")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("允許".into(), "不允許".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    matches!(tokio::time::timeout(std::time::Duration::from_secs(ASK_SECS), rx).await, Ok(Ok(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同意框的話_寫清楚可以回答權限框() {
        let t = ask_text("工作機", "小乙");
        assert!(t.contains("「工作機」要在這台的「小乙」打字"));
        assert!(t.contains("包括回答權限框"));
        assert!(ask_text(" ", "小乙").starts_with("另一台電腦"));
    }

    #[test]
    fn 守門_只有收到請求時能問_沒有畫面命令能回報允許() {
        let me = include_str!("input_consent.rs");
        let code = me.split("\nmod tests {").next().unwrap();
        assert!(!code.contains(concat!("#[tauri", "::command]")), "這裡不能有畫面命令");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut callers = Vec::new();
        for e in walk(&dir) {
            if e.ends_with("input_consent.rs") {
                continue;
            }
            let src = std::fs::read_to_string(&e).unwrap().replace("\r\n", "\n");
            let code = src.split("\nmod tests {").next().unwrap();
            for (i, _) in code.match_indices(concat!("input_consent", "::ask(")) {
                let before = &code[..i];
                let f = before.rfind("\nasync fn ").max(before.rfind("\nfn ")).expect("在函式裡");
                let name: String = before[f..].trim_start_matches('\n').trim_start_matches("async ").trim_start_matches("fn ").chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                callers.push(name);
            }
        }
        assert_eq!(callers, vec!["start_view_poller".to_string()], "只有收到別台的請求時能問");
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
