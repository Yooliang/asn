//! `asn gemini-quota`：ASN 開的 agy 視窗的狀態列指令（#374，見 gemini_session.rs）。
//!   asn gemini-quota < 狀態列資料
//! 把資料裡目前帳號（email）的 Gemini 5 小時與每週剩餘額度記到 `~/.asn/gemini-quota.json`，再印一行狀態。
//! 一定印一行、結束碼一律 0、不連網也不跑別的程式，很快結束（agy 超過 5 秒會砍掉、連續失敗 30 次整個 session 停用狀態列）。
//! 不讀登入憑證、不連網。
use super::env::Env;
use super::{Io, R};
use std::io::Read;

const MAX_INPUT: u64 = 1_000_001;

fn usage() -> &'static str {
    "用法：asn gemini-quota < 狀態列資料
ASN 開的 agy 視窗會自動帶上這個狀態列指令：記下目前 Gemini 帳號的 5 小時與每週剩餘額度，並印一行狀態。結束碼一律 0。"
}

pub async fn main(args: &[String], _env: &Env, io: &mut Io<'_>) -> R<i32> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        io.outln(usage());
        return Ok(0);
    }
    // agy 寫完狀態列資料就關掉標準輸入（實測樣本都是讀到結尾才記下的），跟 claude-quota 一樣讀到結尾；多讀一個位元組讓太大的輸入被略過
    let mut buf = Vec::new();
    let _ = io.stdin.take(MAX_INPUT).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let line = crate::gemini_quota::hook(&crate::identity::home_dir(), &text, now);
    io.outln(&line);
    Ok(0)
}
