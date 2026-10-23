//! `asn room`：本機 Claude 視窗主動查自己所在的群組（只讀，對應 relay/machine/room.mjs）。
//!   asn room --rooms                                    列出我（節點~視窗名）在的群組、新訊息數、最後一則
//!   asn room --room-read <群組id|群組名> [--last 20 | --since <seq>] [--json]
//! 身分跟 asn send／recv 同一套：視窗名由父行程鏈／環境變數備援認出，不能自填；不是成員就被擋（仲介回 403）。
//! 只讀：呼叫 room_read 一律帶 since（不帶 since 仲介會把已讀推進），所以不動後端已讀位置，也不動橋的轉交游標。
//! 「新訊息數」用本機記錄（~/.asn/machine-<節點>/room-seen.json，每次 --room-read 讀到哪記到哪），含自己發的。
//! 結束碼：1 用法、2 認不出視窗、3 不是成員／找不到群組、4 後端錯誤。
use super::caller::{backend, find_caller, http_status, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use crate::bridge::attach::{normalize, notes_for};
use crate::relay::encode_component;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const MAX_LAST: u64 = 200;

fn usage() -> String {
    format!(
        "用法：
  asn room --rooms                                       列出我在的群組與新訊息數
  asn room --room-read <群組id|群組名> [--last N | --since SEQ] [--json]
  asn room confirm-request --room <群組> --kind <類別> --summary \"…\"   危險操作前請主持人確認（見 asn room confirm-request --help）
  asn room confirm-status <id> [--peek]                  查主持人有沒有放行
    --last N     最近 N 則（預設 20，最多 {MAX_LAST}）
    --since SEQ  第 SEQ 則之後的（最多 {MAX_LAST} 則）
    --json       每則一行 JSON（seq/from/from_name/trust/at/mentions/body）
只讀、不改已讀；身分（節點~視窗名）自動判定，不能自填。"
    )
}

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub rooms: bool,
    pub read: Option<String>,
    pub last: Option<u64>,
    pub since: Option<u64>,
    pub json: bool,
    pub help: bool,
}

pub fn parse_args(argv: &[String]) -> R<Args> {
    let mut a = Args::default();
    let mut i = 0;
    let int = |k: &str, v: Option<&String>| -> R<u64> {
        match v {
            Some(s) if !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit()) => Ok(s.parse().unwrap_or(0)),
            _ => Err(Fail::new(1, format!("{k} 要是非負整數\n{}", usage()))),
        }
    };
    while i < argv.len() {
        let k = argv[i].as_str();
        let missing = || Fail::new(1, format!("{k} 缺少參數\n{}", usage()));
        match k {
            "--rooms" => a.rooms = true,
            "--room-read" => {
                i += 1;
                a.read = Some(argv.get(i).cloned().ok_or_else(missing)?);
            }
            "--last" => {
                i += 1;
                a.last = Some(int(k, argv.get(i)).map_err(|e| if argv.get(i).is_none() { missing() } else { e })?);
            }
            "--since" => {
                i += 1;
                a.since = Some(int(k, argv.get(i)).map_err(|e| if argv.get(i).is_none() { missing() } else { e })?);
            }
            "--json" => a.json = true,
            "--help" | "-h" => a.help = true,
            _ => return Err(Fail::new(1, format!("不認得的參數 {k}\n{}", usage()))),
        }
        i += 1;
    }
    if a.help {
        return Ok(a);
    }
    if a.rooms == a.read.is_some() {
        return Err(Fail::new(1, format!("--rooms 與 --room-read 要二選一\n{}", usage())));
    }
    if a.rooms && (a.last.is_some() || a.since.is_some() || a.json) {
        return Err(Fail::new(1, format!("--last／--since／--json 只用在 --room-read\n{}", usage())));
    }
    if a.last.is_some() && a.since.is_some() {
        return Err(Fail::new(1, format!("--last 與 --since 只能擇一\n{}", usage())));
    }
    if let Some(n) = a.last {
        if !(1..=MAX_LAST).contains(&n) {
            return Err(Fail::new(1, format!("--last 要在 1～{MAX_LAST}")));
        }
    }
    Ok(a)
}

/// GET 一個唯讀動作；403／404 換成給人看的訊息（結束碼 3）
async fn call(rl: &crate::relay::Relay, query: &str) -> R<Value> {
    match rl.api(query, None).await {
        Ok(v) => Ok(v),
        Err(e) => match http_status(&e) {
            Some(403) => {
                let why = e.split("HTTP 403").nth(1).map(str::trim).filter(|s| !s.is_empty()).unwrap_or("forbidden");
                Err(Fail::new(3, format!("被擋：不是這個群組的成員（{why}）")))
            }
            Some(404) => Err(Fail::new(3, "找不到這個群組")),
            _ => Err(backend(e)),
        },
    }
}

fn seen_file(work_dir: &Path) -> PathBuf {
    work_dir.join("room-seen.json")
}
fn read_seen(work_dir: &Path) -> Map<String, Value> {
    std::fs::read_to_string(seen_file(work_dir)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
fn write_seen(work_dir: &Path, seen: &Map<String, Value>) {
    let f = seen_file(work_dir);
    let _ = std::fs::create_dir_all(work_dir);
    let tmp = PathBuf::from(format!("{}.{}.tmp", f.display(), std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string(seen).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &f);
    }
}

fn one_line(s: &str, n: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > n { format!("{}…", t.chars().take(n).collect::<String>()) } else { t }
}

fn from_text(m: &Value) -> String {
    if let Some(n) = m.get("from_name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return n.to_string();
    }
    match m.get("from").and_then(Value::as_str) {
        Some("~owner") => "主人".into(),
        Some(f) => f.replace('~', "/"),
        None => String::new(),
    }
}

/// ISO 8601 → 毫秒（失敗 None）。支援 Z 與 ±hh:mm
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let st = i + 1;
        i = st;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &s[st..i];
        ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    }
    let off = match b.get(i) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(&c @ (b'+' | b'-')) => {
            let hh = s.get(i + 1..i + 3)?.parse::<i64>().ok()?;
            let mm = s.get(i + 4..i + 6).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            (hh * 60 + mm) * if c == b'-' { -1 } else { 1 }
        }
        _ => return None,
    };
    // days from civil
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy.rem_euclid(400);
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi - off) * 60_000 + se * 1000 + ms)
}

/// 台北時間（UTC+8）「2026/10/21 18:30:00」（和 zh-TW、hour12:false 的顯示一致）；解析失敗原樣回傳
pub fn taipei(at: &str) -> String {
    let Some(ms) = parse_iso_ms(at) else { return at.to_string() };
    let secs = ms.div_euclid(1000) + 8 * 3600;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y}/{m}/{d} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn body_text(m: &Value, cmd: Option<&str>, crlf_to_lf: bool) -> String {
    let raw = m.get("body").and_then(Value::as_str).unwrap_or("");
    let body = if crlf_to_lf { raw.replace("\r\n", "\n") } else { raw.to_string() };
    notes_for(&body, &normalize(m.get("attachments")), cmd)
}

pub fn format_message(m: &Value, cmd: Option<&str>) -> String {
    let at = m.get("at").and_then(Value::as_str).map(taipei).unwrap_or_default();
    let body = body_text(m, cmd, true).split('\n').collect::<Vec<_>>().join("\n    ");
    format!("#{} {at} {}（{}）：\n    {body}", m.get("seq").and_then(Value::as_i64).unwrap_or(0), from_text(m), m.get("trust").and_then(Value::as_str).unwrap_or(""))
}

fn json_line(m: &Value, cmd: Option<&str>) -> String {
    let atts = normalize(m.get("attachments"));
    let s = |k: &str| serde_json::to_string(m.get(k).and_then(Value::as_str).map(Value::from).as_ref().unwrap_or(&Value::Null)).unwrap_or_default();
    let mut o = format!(
        "{{\"seq\":{},\"from\":{},\"from_name\":{},\"trust\":{},\"at\":{},\"mentions\":{},\"body\":{}",
        m.get("seq").and_then(Value::as_i64).unwrap_or(0),
        s("from"),
        s("from_name"),
        s("trust"),
        s("at"),
        serde_json::to_string(m.get("mentions").filter(|v| v.is_array()).unwrap_or(&json!([]))).unwrap_or_default(),
        serde_json::to_string(&body_text(m, cmd, false)).unwrap_or_default()
    );
    if !atts.is_empty() {
        o.push_str(&format!(",\"attachments\":[{}]", atts.iter().map(super::recv::attachment_json).collect::<Vec<_>>().join(",")));
    }
    o.push('}');
    o
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    // 群組裡被別人點名的 AI 做危險操作前，請主持人確認、查放行（見 confirm.rs）
    if let Some(sub) = argv.first().map(String::as_str).filter(|s| matches!(*s, "confirm-request" | "confirm-status")) {
        return super::confirm::main(sub, &argv[1..], env, io).await;
    }
    let a = parse_args(argv)?;
    if a.help {
        io.outln(&usage());
        return Ok(0);
    }
    let id = identity(env, true)?;
    let me = find_caller(env, "查群組")?;
    let my_key = format!("{}~{}", id.node, me.name);
    let rl = relay(&id, &me.name);
    let cmd = env.prefix("attach");
    let list = call(&rl, "room_list").await?;
    let mine: Vec<&Value> = list
        .get("rooms")
        .and_then(Value::as_array)
        .map(|rs| rs.iter().filter(|r| r.get("mine").and_then(Value::as_array).map(|m| m.iter().any(|x| x.get("member").and_then(Value::as_str) == Some(my_key.as_str()))).unwrap_or(false)).collect())
        .unwrap_or_default();
    let mut seen = read_seen(&id.work_dir);
    let seen_of = |r: &Value, seen: &Map<String, Value>| -> u64 {
        let rid = r.get("id").and_then(Value::as_str).unwrap_or("");
        let local = seen.get(&format!("{rid}|{my_key}")).and_then(Value::as_u64).unwrap_or(0);
        let remote = r.get("mine").and_then(Value::as_array).and_then(|m| m.iter().find(|x| x.get("member").and_then(Value::as_str) == Some(my_key.as_str()))).and_then(|x| x.get("read_seq")).and_then(Value::as_u64).unwrap_or(0);
        local.max(remote)
    };

    if a.rooms {
        if mine.is_empty() {
            io.outln(&format!("（{my_key} 目前不在任何群組）"));
            return Ok(0);
        }
        for r in &mine {
            let last_seq = r.get("last_seq").and_then(Value::as_u64).unwrap_or(0);
            let fresh = last_seq.saturating_sub(seen_of(r, &seen));
            let last = match r.get("last_body").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                Some(b) => format!("　最後：{}：{}", r.get("last_from_name").and_then(Value::as_str).unwrap_or(""), one_line(b, 60)),
                None => String::new(),
            };
            io.outln(&format!("{}　{}　共 {last_seq} 則，新訊息 {fresh} 則{last}", r.get("id").and_then(Value::as_str).unwrap_or(""), r.get("name").and_then(Value::as_str).unwrap_or("")));
        }
        io.outln(&format!("看內容：{} --room-read <群組id> --last 20", env.prefix("room").unwrap_or_else(|| "asn room".into())));
        return Ok(0);
    }

    let want = a.read.clone().unwrap_or_default();
    let want = want.trim();
    let room = mine
        .iter()
        .find(|r| r.get("id").and_then(Value::as_str) == Some(want))
        .or_else(|| mine.iter().find(|r| r.get("name").and_then(Value::as_str).map(|n| n.to_lowercase() == want.to_lowercase()).unwrap_or(false)));
    let Some(room) = room else {
        return Err(Fail::new(3, format!("找不到「{want}」或你（{my_key}）不在這個群組；用 --rooms 看你在的群組")));
    };
    let rid = room.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let rname = room.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let last_seq = room.get("last_seq").and_then(Value::as_u64).unwrap_or(0);
    let n = if a.since.is_some() { MAX_LAST } else { a.last.unwrap_or(20) };
    let since = match a.since {
        Some(s) => s,
        None => last_seq.saturating_sub(n),
    };
    // 一定帶 since：仲介在沒有 since 時會把已讀推進
    let res = call(&rl, &format!("room_read&room={}&as_agent={}&since={since}&limit={n}", encode_component(&rid), encode_component(&me.name))).await?;
    let mut msgs: Vec<&Value> = res.get("messages").and_then(Value::as_array).map(|m| m.iter().filter(|m| m.get("seq").and_then(Value::as_u64).unwrap_or(0) > since).collect()).unwrap_or_default();
    msgs.sort_by_key(|m| m.get("seq").and_then(Value::as_u64).unwrap_or(0));
    let top = msgs.last().and_then(|m| m.get("seq").and_then(Value::as_u64));
    if !a.json {
        io.outln(&format!("[群組 {rname}]（{rid}）第 {}～{} 則，共 {} 則", since + 1, top.unwrap_or(since), res.get("last_seq").and_then(Value::as_u64).unwrap_or(last_seq)));
    }
    for m in &msgs {
        io.outln(&if a.json { json_line(m, cmd.as_deref()) } else { format_message(m, cmd.as_deref()) });
    }
    if !a.json && msgs.is_empty() {
        io.outln("（沒有訊息）");
    }
    if let Some(top) = top {
        let k = format!("{rid}|{my_key}");
        if top > seen.get(&k).and_then(Value::as_u64).unwrap_or(0) {
            seen.insert(k, json!(top));
            write_seen(&id.work_dir, &seen);
        }
    }
    Ok(0)
}
