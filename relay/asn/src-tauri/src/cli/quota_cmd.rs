//! `asn claude-quota`：接在 Claude Code 狀態列指令後面，把「目前帳號」的 5 小時與每週剩餘額度記到本機
//! （之後 ASN 會隨帳號回報帶給收發室，讓電腦版與手機版挑有額度的帳號來切換）。
//!   asn claude-quota < 狀態列資料
//! 只取狀態列資料裡的額度數字與目前登入帳號的 email；不讀登入憑證、不連網、不輸出任何東西。
//! 結束碼一律 0：它掛在狀態列上，絕不能因為記不下來而讓狀態列壞掉。
use super::env::Env;
use super::{Io, R};
use std::io::Read;

fn usage() -> &'static str {
    "用法：asn claude-quota < 狀態列資料
把 Claude Code 狀態列資料裡的 5 小時與每週剩餘額度，記在目前登入的帳號底下。
在你的狀態列指令裡把同一份標準輸入也餵給它即可；它不輸出任何東西，結束碼一律 0。"
}

pub async fn main(args: &[String], _env: &Env, io: &mut Io<'_>) -> R<i32> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        io.outln(usage());
        return Ok(0);
    }
    let mut buf = Vec::new();
    // 多讀一個位元組，讓超過上限的輸入被 hook 當成太大而略過
    let _ = io.stdin.take(1_000_001).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let _ = crate::claude_quota::hook(&crate::claude_accounts::claude_home(), &text, now);
    Ok(0)
}
