//! `asn secret request`：請求端——向本人要一次性密碼（#26 第二期，設計見 docs/design/SECRET-REMOTE.md）。
//!   asn-cli secret request --purpose "git push 到 github" [--program git] [--ttl 180]
//! 流程：產生一次性鑰匙對 → 送請求（只有公鑰與說明）→ 本人在自己的設備確認 → 取回密文、解密。
//! **成功時只把密碼印到標準輸出**（與第一期 asn-askpass 同一種交付方式，可直接當 GIT_ASKPASS 包裝腳本的輸出）；
//! 失敗時標準輸出一定是空的，原因印到標準錯誤。密碼不寫檔、不進環境變數、不進指令列、不進 log。
//! 結束碼：0 成功、1 用法、3 被拒絕／過期、4 後端錯誤或解不開。
use super::caller::{backend, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use crate::secret_remote::requester::{request_secret, Failure, Opts, StartInfo};
use std::time::Duration;

fn usage() -> String {
    "用法：
  asn secret request --purpose <用途說明> [--program <程式名稱>] [--ttl <秒，30～600，預設 180>]
向你本人的設備（電腦 ASN 或手機）要一次性密碼：你在自己的設備上確認並輸入，密碼端對端加密送回，ASN 的伺服器只轉密文。
成功時只把密碼印到標準輸出；失敗時標準輸出是空的。程式名稱與用途說明是自報，會顯示在你的確認畫面上。
執行時會在標準錯誤印「公鑰指紋」，你的確認畫面上有同一個指紋，高風險情境請核對。"
        .to_string()
}

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub purpose: Option<String>,
    pub program: Option<String>,
    pub ttl: Option<u64>,
    pub help: bool,
}

pub fn parse_args(argv: &[String]) -> R<Args> {
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        let mut need = || -> R<String> {
            i += 1;
            argv.get(i).cloned().ok_or_else(|| Fail::new(1, format!("{k} 缺少參數\n{}", usage())))
        };
        match k {
            "--purpose" => a.purpose = Some(need()?),
            "--program" => a.program = Some(need()?),
            "--ttl" => a.ttl = Some(need()?.trim().parse::<u64>().map_err(|_| Fail::new(1, format!("--ttl 要是整數秒\n{}", usage())))?),
            "--help" | "-h" => a.help = true,
            _ => return Err(Fail::new(1, format!("不認得的參數 {k}\n{}", usage()))),
        }
        i += 1;
    }
    Ok(a)
}

/// 預設的程式名稱：呼叫者的父行程鏈（例如「git.exe ← bash.exe」）；查不到就用 asn-cli
fn default_program(env: &Env) -> String {
    let Ok(t) = (env.procs)() else { return "asn-cli".into() };
    let mut names = vec![];
    let mut cur = t.get(&env.self_pid).map(|x| x.0).unwrap_or(0);
    for _ in 0..3 {
        let Some((parent, name)) = t.get(&cur) else { break };
        names.push(crate::askpass::proto::clean_display(name, 40));
        cur = *parent;
    }
    if names.is_empty() {
        "asn-cli".into()
    } else {
        names.join(" ← ")
    }
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let (sub, rest) = match argv.split_first() {
        Some((s, r)) => (s.as_str(), r),
        None => {
            io.errln(&usage());
            return Ok(1);
        }
    };
    if matches!(sub, "--help" | "-h" | "help") {
        io.outln(&usage());
        return Ok(0);
    }
    if sub != "request" {
        return Err(Fail::new(1, format!("不認得的子命令 secret {sub}\n{}", usage())));
    }
    let a = parse_args(rest)?;
    if a.help {
        io.outln(&usage());
        return Ok(0);
    }
    let purpose = a.purpose.ok_or_else(|| Fail::new(1, format!("請用 --purpose 說明要做什麼（會顯示在你的確認畫面上）\n{}", usage())))?;
    let program = a.program.unwrap_or_else(|| default_program(env));
    let mut opts = Opts::new(&program, &purpose);
    opts.ttl_secs = a.ttl.unwrap_or(opts.ttl_secs);
    opts.poll = Duration::from_millis(env.secret_poll_ms);
    let id = identity(env, true)?;
    let r = relay(&id, &id.node);
    let res = request_secret(&r, &opts, &mut |s: &StartInfo| {
        io.errln(&format!("已向你的設備送出密碼請求（公鑰指紋 {}，{} 秒內有效）。請在你的電腦 ASN 或手機上確認。", s.fingerprint, s.seconds_left));
    })
    .await;
    match res {
        Ok(secret) => {
            // 交付前確認是文字；不是就不交付
            let Ok(text) = std::str::from_utf8(&secret) else { return Err(Fail::new(4, Failure::DecryptFailed.to_string())) };
            let _ = io.out.write_all(text.as_bytes());
            let _ = io.out.write_all(b"\n");
            let _ = io.out.flush();
            drop(secret);
            Ok(0)
        }
        Err(f @ (Failure::Denied | Failure::Expired)) => Err(Fail::new(3, format!("錯誤：{f}"))),
        Err(f) => Err(backend(f.to_string())),
    }
}
