//! 密碼小幫手（#26 第一期，層級 1：本機一次性傳遞）。設計與威脅模型見 docs/design/SECRETS.md。
//!
//! 流程：git／ssh 呼叫 `asn-askpass.exe`（GIT_ASKPASS／SSH_ASKPASS）→ 小幫手連本機具名管道（只允許同一個 Windows 使用者）
//! → 正在執行的 ASN 跳出確認窗（顯示哪個程式、在哪個資料夾、要什麼）→ 使用者輸入或取消
//! → 密碼直接經管道回給小幫手 → 小幫手印到標準輸出給 git／ssh。
//!
//! 密碼永遠不進：模型、信件、往來記錄、log、檔案、指令列參數、環境變數、剪貼簿。
//! 本資料夾除了 `tests.rs` 以外的程式碼受守門測試掃描（見 tests.rs「守門」），不准出現上述去處。
pub mod client;
#[cfg(feature = "gui")]
pub mod dialog;
pub mod pipe;
pub mod proto;
pub mod server;

#[cfg(test)]
mod tests;

pub use client::run_process;

/// 設定頁「密碼小幫手」：小幫手的完整路徑與設定指令範例；執行檔不在 ASN 旁邊就是 null（不顯示）
pub fn info() -> serde_json::Value {
    match helper_exe() {
        Some(p) => {
            let plain = crate::cli::command_path(&p).trim_matches('"').to_string();
            serde_json::json!({ "path": plain, "example": format!("setx GIT_ASKPASS \"{plain}\"") })
        }
        None => serde_json::Value::Null,
    }
}

/// 小幫手執行檔：和目前執行檔同一個資料夾的 asn-askpass(.exe)；不存在回 None
pub fn helper_exe() -> Option<std::path::PathBuf> {
    let me = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "asn-askpass.exe" } else { "asn-askpass" };
    let p = me.parent()?.join(name);
    p.is_file().then_some(p)
}
