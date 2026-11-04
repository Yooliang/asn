//! `asn forward-gate --dir <worker 資料夾>`：收發室 worker 的 PreToolUse hook（只掛在 SendMessage 上）。
//! 從標準輸入讀 Claude Code 給 hook 的 JSON，核對這次轉交的收件人是不是橋當初指定的那個（見 bridge/forward_gate.rs）。
//! 符合：什麼都不印、結束碼 0（放行）；不符：印出 permissionDecision=deny 的 JSON、結束碼 0。
//! 這封走原文替換（橋存了內文檔）：核對內文雜湊、寫下已套用紀錄後，印出 permissionDecision=allow 加 updatedInput（訊息換成橋存的原文），結束碼 0。
//! 每次都在 worker 資料夾的 forward-gate.log 記一行放行或擋下（編號與理由，不記信件內文）。
//! 這支程式自己執行不了時（找不到、當掉）Claude Code 會放行：一般轉交由橋收到 SENT 時的比對兜底；原文替換的那封，橋收到 SENT 還要有這裡寫的已套用紀錄，沒有就不算送出、重送。
use super::env::Env;
use super::{Fail, Io, R};
use std::io::Read;

fn usage() -> &'static str {
    "用法：asn forward-gate --dir <worker 資料夾> < hook 輸入
收發室 worker 的 PreToolUse hook：核對 SendMessage 的收件人是不是橋指定的。符合就放行（不印東西），不符印出 deny 的 JSON。
結束碼一律 0。"
}

pub async fn main(args: &[String], _env: &Env, io: &mut Io<'_>) -> R<i32> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        io.outln(usage());
        return Ok(0);
    }
    let dir = args.iter().position(|a| a == "--dir").and_then(|i| args.get(i + 1)).ok_or_else(|| Fail::new(1, usage()))?;
    let dir = std::path::Path::new(dir);
    let mut buf = Vec::new();
    let _ = io.stdin.take(1_000_001).read_to_end(&mut buf);
    let (out, log) = crate::bridge::forward_gate::run_hook(dir, &String::from_utf8_lossy(&buf));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    crate::bridge::forward_gate::append_gate_log(dir, now, &log);
    if let Some(o) = out {
        io.outln(&o);
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::forward_gate;
    use serde_json::json;

    const A: &str = "00000000-0000-0000-0000-00000000000a";

    fn run_gate(args: &[&str], stdin: &str) -> (i32, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut inp = std::io::Cursor::new(stdin.as_bytes().to_vec());
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let code = {
            let mut io = Io { out: &mut out, err: &mut err, stdin: &mut inp };
            super::super::run(&args, &Env::from_process(), &mut io)
        };
        (code, String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned())
    }

    #[test]
    fn 放行什麼都不印_不符印_deny_每次都記_log_不記內文() {
        let d = tempfile::tempdir().unwrap();
        forward_gate::write_inflight(d.path(), &[(A.to_string(), "T-甲".to_string(), None)]).unwrap();
        let dir = d.path().display().to_string();
        let call = |to: &str| json!({"tool_name": "SendMessage", "tool_input": {"to": to, "message": format!("機密內文 id={A}")}}).to_string();
        let (code, out, _) = run_gate(&["forward-gate", "--dir", &dir], &call("T-甲"));
        assert_eq!((code, out.as_str()), (0, ""));
        let (code, out, _) = run_gate(&["forward-gate", "--dir", &dir], &call("T-乙"));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(v["hookSpecificOutput"]["permissionDecisionReason"], "收件人應為 T-甲");
        let log = std::fs::read_to_string(d.path().join(forward_gate::GATE_LOG_FILE)).unwrap();
        assert_eq!(log.lines().count(), 2);
        assert!(log.contains("allow") && log.contains("deny") && !log.contains("機密內文"), "{log}");
        // 沒給 --dir：用法錯誤
        let (code, _, err) = run_gate(&["forward-gate"], "");
        assert_eq!(code, 1);
        assert!(err.contains("--dir"));
    }

    #[test]
    fn 是認得的子命令_hook_指令用_asn_cli_完整路徑加_dir() {
        assert!(crate::cli::is_subcommand(&["forward-gate".to_string()]));
        let c = crate::bridge::worker::gate_command(std::path::Path::new("w x")).unwrap();
        assert!(c.ends_with(" forward-gate --dir \"w x\""), "{c}");
    }
}
