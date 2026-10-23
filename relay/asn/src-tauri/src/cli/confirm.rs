//! `asn room confirm-request`／`asn room confirm-status`：群組裡被別人點名的 AI，做危險操作之前請主持人確認、查有沒有放行。
//! 規格見 docs/design/HUMANS-AND-GROUPS.md 2.5.1：這是機制，不是提示——後台記一筆待確認，只有主持人本人（簽章）按了同意才算放行，放行只能用一次、24 小時內有效。
//!   asn room confirm-request --room <群組id|群組名> --kind <類別> --summary "<一句話說明要做什麼>"
//!     類別：data_change（修改或刪除既有資料，含既有檔案）、deploy（部署上線）、spend（花錢付款）、external_send（對外寄送）、account_config（動到帳號或設定）、other（其他不可回復的操作）
//!     成功：印「已請主持人確認」與 id（uuid）；確認前一律不要執行
//!   asn room confirm-status <id> [--peek]
//!     查放行狀態並印出：approved（可以做，這次查詢就把放行用掉）、pending、denied、used、expired；--peek 只看不用掉
//! 身分跟 asn send／room 同一套（視窗名自動判定）。
//! 結束碼：0 可以執行（approved）或請求已送出、1 用法、3 不是成員／找不到、4 後端錯誤、10 等待中（pending）、11 被拒絕、12 過期或已用掉。
use super::caller::{backend, find_caller, http_status, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use crate::relay::encode_component;
use serde_json::{json, Value};

pub const KINDS: [&str; 6] = ["data_change", "deploy", "spend", "external_send", "account_config", "other"];
pub const KIND_LABEL: [(&str, &str); 6] = [
    ("data_change", "修改或刪除既有資料"),
    ("deploy", "部署"),
    ("spend", "花錢或付款"),
    ("external_send", "對外寄送"),
    ("account_config", "動到主人的帳號或設定"),
    ("other", "其他不可回復的操作"),
];
const SUMMARY_MAX: usize = 500;

fn usage() -> String {
    "用法：
  asn room confirm-request --room <群組id|群組名> --kind <類別> --summary \"<一句話說明要做什麼>\"
    類別：data_change（修改或刪除既有資料）、deploy（部署）、spend（花錢或付款）、external_send（對外寄送）、account_config（動到帳號或設定）、other（其他不可回復的操作）
    會在群組點名主持人；主持人確認前一律不要執行
  asn room confirm-status <id> [--peek]
    approved＝可以做（放行只能用一次，查詢就會用掉；--peek 只看不用掉）；pending 等待中；denied 被拒絕；used 已用過；expired 過期
結束碼：0 可以執行／請求已送出、10 等待中、11 被拒絕、12 過期或已用掉、3 不是成員、4 後端錯誤。"
        .to_string()
}

#[derive(Debug, Default, PartialEq)]
pub struct Req {
    pub room: Option<String>,
    pub kind: Option<String>,
    pub summary: Option<String>,
    pub id: Option<String>,
    pub peek: bool,
    pub help: bool,
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// 解析子命令後面的參數（sub＝confirm-request 或 confirm-status）
pub fn parse_args(sub: &str, argv: &[String]) -> R<Req> {
    let mut a = Req::default();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        let mut need = || -> R<String> {
            i += 1;
            argv.get(i).cloned().ok_or_else(|| Fail::new(1, format!("{k} 缺少參數\n{}", usage())))
        };
        match k {
            "--room" => a.room = Some(need()?),
            "--kind" => a.kind = Some(need()?),
            "--summary" => a.summary = Some(need()?),
            "--peek" => a.peek = true,
            "--help" | "-h" => a.help = true,
            _ if sub == "confirm-status" && !k.starts_with("--") && a.id.is_none() => a.id = Some(k.to_string()),
            _ => return Err(Fail::new(1, format!("不認得的參數 {k}\n{}", usage()))),
        }
        i += 1;
    }
    if a.help {
        return Ok(a);
    }
    if sub == "confirm-request" {
        if a.peek || a.id.is_some() {
            return Err(Fail::new(1, format!("--peek 與編號只用在 confirm-status\n{}", usage())));
        }
        let room = a.room.as_deref().map(str::trim).unwrap_or("");
        if room.is_empty() {
            return Err(Fail::new(1, format!("請用 --room 指定群組\n{}", usage())));
        }
        let kind = a.kind.as_deref().unwrap_or("");
        if !KINDS.contains(&kind) {
            return Err(Fail::new(1, format!("--kind 要是 {} 其中之一\n{}", KINDS.join("、"), usage())));
        }
        let n = a.summary.as_deref().map(|s| s.trim().chars().count()).unwrap_or(0);
        if n == 0 || n > SUMMARY_MAX {
            return Err(Fail::new(1, format!("--summary 要 1 到 {SUMMARY_MAX} 字，一句話說明要做什麼\n{}", usage())));
        }
    } else {
        if a.room.is_some() || a.kind.is_some() || a.summary.is_some() {
            return Err(Fail::new(1, format!("--room／--kind／--summary 只用在 confirm-request\n{}", usage())));
        }
        if !a.id.as_deref().map(is_uuid).unwrap_or(false) {
            return Err(Fail::new(1, format!("請給請求的編號（confirm-request 印出的 id）\n{}", usage())));
        }
    }
    Ok(a)
}

fn kind_label(k: &str) -> &'static str {
    KIND_LABEL.iter().find(|(c, _)| *c == k).map(|(_, l)| *l).unwrap_or("其他不可回復的操作")
}

/// 後台 room_confirm_status 回的狀態 → （給人看的一行, 結束碼）
pub fn status_line(status: &str, consumed: bool) -> (String, i32) {
    match status {
        "approved" if consumed => ("approved：主持人已同意，可以執行這一次（放行已用掉，不能再用第二次）".into(), 0),
        "approved" => ("approved：主持人已同意（只是查看，放行還沒用掉）".into(), 0),
        "pending" => ("pending：還在等主持人確認，先不要執行；稍後再查".into(), 10),
        "denied" => ("denied：主持人拒絕了，不要執行".into(), 11),
        "used" => ("used：這個放行已經用過了，要再做一次要重新請主持人確認".into(), 12),
        "expired" => ("expired：請求已過期（24 小時），要做的話重新請主持人確認".into(), 12),
        other => (format!("未知的狀態 {other}，不要執行"), 4),
    }
}

pub async fn main(sub: &str, argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let a = parse_args(sub, argv)?;
    if a.help {
        io.outln(&usage());
        return Ok(0);
    }
    let id = identity(env, true)?;
    let me = find_caller(env, "請主持人確認")?;
    let my_key = format!("{}~{}", id.node, me.name);
    let rl = relay(&id, &me.name);

    if sub == "confirm-status" {
        let cid = a.id.clone().unwrap_or_default();
        let body = json!({ "as_agent": me.name, "id": cid, "consume": !a.peek });
        let res = rl.api("room_confirm_status", Some(body)).await.map_err(|e| match http_status(&e) {
            Some(403) => Fail::new(3, "被擋：這個請求不是你（這個視窗）發的"),
            Some(404) => Fail::new(3, "找不到這個請求"),
            _ => backend(e),
        })?;
        let st = res.get("status").and_then(Value::as_str).unwrap_or("");
        let (line, code) = status_line(st, res.get("consumed").and_then(Value::as_bool).unwrap_or(false));
        io.outln(&line);
        return Ok(code);
    }

    // confirm-request：先用 room_list 認出群組（id 或名字，只限我在的群組）
    let want = a.room.clone().unwrap_or_default();
    let want = want.trim();
    let list = rl.api("room_list", None).await.map_err(backend)?;
    let rooms = list.get("rooms").and_then(Value::as_array).cloned().unwrap_or_default();
    let mine = |r: &Value| r.get("mine").and_then(Value::as_array).map(|m| m.iter().any(|x| x.get("member").and_then(Value::as_str) == Some(my_key.as_str()))).unwrap_or(false);
    let room = rooms
        .iter()
        .filter(|r| mine(r))
        .find(|r| r.get("id").and_then(Value::as_str) == Some(want))
        .or_else(|| rooms.iter().filter(|r| mine(r)).find(|r| r.get("name").and_then(Value::as_str).map(|n| n.to_lowercase() == want.to_lowercase()).unwrap_or(false)));
    let Some(room) = room else {
        return Err(Fail::new(3, format!("找不到「{want}」或你（{}）不在這個群組；用 asn room --rooms 看你在的群組", me.name)));
    };
    let rid = room.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let kind = a.kind.clone().unwrap_or_default();
    let summary = a.summary.clone().unwrap_or_default();
    let body = json!({ "room": rid, "as_agent": me.name, "kind": kind, "summary": summary.trim() });
    let res = rl.api(&format!("room_confirm_request&room={}", encode_component(&rid)), Some(body)).await.map_err(|e| match http_status(&e) {
        Some(403) => Fail::new(3, "被擋：不是這個群組的成員"),
        Some(429) => Fail::new(4, "你在這個群組的待確認請求太多了（最多 5 筆），等主持人處理後再送"),
        _ => backend(e),
    })?;
    let cid = res.get("id").and_then(Value::as_str).unwrap_or("");
    let short = res.get("short").and_then(Value::as_str).unwrap_or("");
    io.outln(&format!("已請主持人確認（#{short}，{}）。確認前不要執行；這段時間只回報「已請主持人確認」。", kind_label(&kind)));
    io.outln(&format!("id={cid}"));
    io.outln(&format!("之後用 {} confirm-status {cid} 查有沒有放行（approved 才能做，放行只能用一次、24 小時內有效）", env.prefix("room").unwrap_or_else(|| "asn room".into())));
    Ok(0)
}