//! `asn-cli inbox`：讀 `asn-bridge run --inbox` 存下的信、標記已處理（對應 relay/cloud-agent/inbox.mjs）。
//!   asn-cli inbox [--unread]              列出還沒處理的信（預設）
//!   asn-cli inbox --all                   列出全部（已處理的標 [已處理]）
//!   asn-cli inbox --json                  每封一行 JSON（可搭配 --unread／--all）
//!   asn-cli inbox --done <id> [<id>…]     標成已處理（可給前 8 碼以上、唯一的前綴）
//! 只讀本機檔案（`<ASN_HOME>/inbox/inbox.jsonl`、`done.jsonl`），不連後台、不需要金鑰。
//! 回信：`asn-cli send --to <from_node>/<from_agent> --reply-to <id> --body "…" (--reply|--no-reply)`
use super::env::Env;
use super::{Fail, Io, R};
use crate::bridge::attach::body_with_notes;
use crate::bridge::mail::{escape_body, is_person_mail, sender_line, Mail};
use crate::inbox_mode as im;
use serde_json::{json, Value};

const USAGE: &str = "用法：
  asn-cli inbox [--unread] [--all] [--json]
  asn-cli inbox --done <信件id> [<信件id>…]";

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub unread: bool,
    pub all: bool,
    pub json: bool,
    pub help: bool,
    pub done_mode: bool,
    pub done: Vec<String>,
}

pub fn parse_args(argv: &[String]) -> R<Args> {
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--unread" => a.unread = true,
            "--all" => a.all = true,
            "--json" => a.json = true,
            "--help" | "-h" => a.help = true,
            "--done" => {
                a.done_mode = true;
                while i + 1 < argv.len() && !argv[i + 1].starts_with("--") {
                    i += 1;
                    a.done.push(argv[i].clone());
                }
            }
            k => return Err(Fail::new(1, format!("不認得的參數 {k}\n{USAGE}"))),
        }
        i += 1;
    }
    if a.unread && a.all {
        return Err(Fail::new(1, format!("--unread 與 --all 不能同時給\n{USAGE}")));
    }
    Ok(a)
}

fn fmt(m: &Value, cmd: Option<&str>) -> String {
    let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("");
    let reply = match m.get("expects_reply").and_then(Value::as_bool) {
        Some(true) => "要回信",
        Some(false) => "只是告知",
        None => "未說明",
    };
    let mail = Mail::from_json(m);
    let from = match &mail {
        Some(x) if is_person_mail(x) => s("from_agent").to_string(),
        _ if s("from_agent").is_empty() => s("from_node").to_string(),
        _ => format!("{}/{}", s("from_node"), s("from_agent")),
    };
    let to = if s("to_agent").is_empty() { "（未指定）" } else { s("to_agent") };
    let rt = if s("reply_to").is_empty() { String::new() } else { format!(" reply_to={}", s("reply_to")) };
    let who = mail.as_ref().map(sender_line).unwrap_or_default();
    let voice = if m.get("voice").and_then(Value::as_bool) == Some(true) { "\n（語音通話中寄出，內文是語音辨識的文字）" } else { "" };
    let body = body_with_notes(&escape_body(s("body")), m.get("attachments"), cmd);
    format!("[{}] {} to={to} from={from} ({reply}){rt}\n{who}{voice}\n{body}\n", s("id"), s("created_at"))
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let a = parse_args(argv)?;
    if a.help {
        io.outln(USAGE);
        return Ok(0);
    }
    let dir = im::inbox_dir(&env.relay_home);
    if a.done_mode {
        if a.done.is_empty() {
            return Err(Fail::new(1, format!("--done 後面要給信件 id\n{USAGE}")));
        }
        let mut bad = 0;
        for want in &a.done {
            match im::mark_done(&dir, want, &super::recv::iso(crate::heartbeat::now_ms())) {
                Ok(Some(id)) => io.outln(&format!("done {id}")),
                Ok(None) => io.outln(&format!("早就標過了：{want}")),
                Err(e) => {
                    io.outln(&e);
                    bad += 1;
                }
            }
        }
        return Ok(if bad > 0 { 1 } else { 0 });
    }
    let done = im::done_ids(&dir);
    let list: Vec<Value> = im::all_mails(&dir).into_iter().filter(|m| a.all || !done.contains(m["id"].as_str().unwrap_or(""))).collect();
    if a.json {
        for m in &list {
            let mut o = m.clone();
            o["done"] = json!(done.contains(m["id"].as_str().unwrap_or("")));
            io.outln(&o.to_string());
        }
        return Ok(0);
    }
    if list.is_empty() {
        io.outln(if a.all { "（信箱是空的）" } else { "（沒有未處理的信）" });
        return Ok(0);
    }
    let cmd = env.cmd_prefix.clone().or_else(|| crate::cli::cmd_prefix("attach"));
    for m in &list {
        let tag = if done.contains(m["id"].as_str().unwrap_or("")) { "[已處理] " } else { "" };
        io.outln(&format!("{tag}{}", fmt(m, cmd.as_deref())));
    }
    Ok(0)
}
