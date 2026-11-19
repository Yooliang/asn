//! `asn claude-quota`（#1883 起只剩串接）：舊版 ASN 把這條接在使用者的 Claude Code 狀態列指令後面，用來記額度。
//! 額度已改成 ASN 直接向 Claude 查，這個命令不再讀、不再記任何東西；只保留把標準輸入餵給原本的狀態列指令並原樣印出，
//! 讓還沒被還原的舊設定（升級後第一次啟動 ASN 之前，見 statusline_restore.rs）狀態列照常顯示。
//! 結束碼一律 0：它掛在狀態列上，絕不能讓狀態列壞掉。
use super::env::Env;
use super::{Io, R};
use std::io::{Read, Write as _};

fn usage() -> &'static str {
    "用法：asn claude-quota --chain < 狀態列資料
舊版接在 Claude Code 狀態列指令後面的串接用命令；額度已改成由 ASN 直接查詢，這個命令只把輸入交給原本的狀態列指令並印出結果。
ASN 啟動時會自動把狀態列還原成原本的，之後就不再經過這裡。結束碼一律 0。"
}

pub async fn main(args: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        io.outln(usage());
        return Ok(0);
    }
    let mut buf = Vec::new();
    let _ = io.stdin.take(1_000_001).read_to_end(&mut buf);
    if args.iter().any(|a| a == "--chain") {
        let (out, code) = crate::statusline_restore::run_original(&env.relay_home, &buf);
        let _ = io.out.write_all(&out);
        let _ = io.out.flush();
        return Ok(code);
    }
    Ok(0)
}
