//! `asn-cli claude-usage --shape`（#1883 除錯用）：由程式自己讀這台目前登入的憑證，向額度端點查一次，
//! 只印回應的欄位結構（每個鍵與它的型別名；數字、字串、布林的值一律不印）。不印標頭；失敗只印狀態碼。
//! 查詢走的是正式查額度的同一個函式（`claude_quota::HttpNet`），遮罩函式見 `claude_quota::shape_of`。
use super::env::Env;
use super::{Io, R};

fn usage() -> &'static str {
    "用法：asn-cli claude-usage --shape
讀這台目前登入的憑證，向 Claude 的額度端點查一次，只印回應的欄位結構（每個鍵與它的型別；任何值都不印）。
失敗只印狀態碼。供除錯用，結束碼一律 0。"
}

pub async fn main(args: &[String], _env: &Env, io: &mut Io<'_>) -> R<i32> {
    if !args.iter().any(|a| a == "--shape") || args.iter().any(|a| a == "--help" || a == "-h") {
        io.outln(usage());
        return Ok(0);
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let home = crate::claude_accounts::claude_home();
    // 查詢是阻塞的（另開執行緒跑），不佔用非同步執行緒
    let out = tokio::task::spawn_blocking(move || crate::claude_quota::shape_report(&home, now, &crate::claude_quota::HttpNet::real())).await.unwrap_or_else(|_| "查詢沒有完成".into());
    io.outln(&out);
    Ok(0)
}
