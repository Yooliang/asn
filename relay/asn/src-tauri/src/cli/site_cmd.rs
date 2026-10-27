//! `asn-cli site`：團隊節點寫官網內容（#400 第二期；後台動作 site_release_upsert／site_meeting_add／site_item_upsert）。
//! 取代維護者手下 SQL：發版記錄（/log）、小會議記錄（/log）、藍圖與待辦項目（/roadmap）。
//!   asn-cli site release --version 0.1.96 --date 2026-10-28 --commit abc1234 --item "…" [--item …] [--platform 官網 …] [--notes "…"]
//!   asn-cli site meeting --file meeting.json
//!   asn-cli site item --key todo-next-15b [--section todo --lane next] [--title …] [--body … | --body-file <檔>] [--ref 400 …] [--status released] [--version 0.1.96] [--sort N]
//! 能不能寫由後台的名單決定（以帳號為單位，名單外回「不在官網寫入名單」）；節點一律是金鑰所屬的自己，不能自填。
//! 內文只用極小標記（**粗體**、`程式碼`、#123），不收 HTML、電子郵件、本機路徑與金鑰；格式檢查以後台為準，這裡只檢查參數。
//! 成功印一行結果；失敗印後台的中文說明。結束碼：1 用法／內容不對、3 被擋（不在名單、太頻繁）、4 後端錯誤（含後台還沒部署）。
use super::caller::{backend, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use serde_json::{json, Map, Value};

const MAX_MEETINGS: usize = 20;

fn usage() -> String {
    "用法：
  asn-cli site release --version <x.y.z> [--date <YYYY-MM-DD>] [--commit <短碼>] [--item \"<一條更新說明>\" ...] [--platform <官網|Play|家用機…> ...] [--notes \"<補充>\"]
  asn-cli site meeting --file <meeting.json>
  asn-cli site item --key <項目代號> [--section roadmap|todo --lane <欄位>] [--title \"<標題>\"] [--body \"<內文>\" | --body-file <檔>]
                    [--ref <議題編號> ...] [--status released|doing|planned|decide] [--version <x.y.z>] [--sort <數字>]
release 依版本新增或更新一筆發版記錄。新的版本 --date 與至少一個 --item 必填；已有的版本只改有給的欄位
        （--item／--platform 有給就整組換掉，--commit \"\"、--notes \"\" 清掉）。
meeting 從 JSON 檔新增一場小會議記錄（檔案可為單一物件或陣列，最多 20 場）；同一時間已有記錄＝整筆覆寫。
        欄位：time（台北時間 \"YYYY-MM-DD HH:MM\"，或 held_at 帶時區的 ISO 時間）、attendees、progress、decisions、assignments、improvements；
        後五個可寫字串或字串陣列，一行一項，沒內容寫「無」。
item    依項目代號新增或更新藍圖／待辦項目。新項目 --section、--lane、--body、--status 必填；已有的只改有給的欄位
        （--title \"\"、--version \"\" 清掉；換欄位要同時給 --section 與 --lane）。--ref 可重複或用逗號分隔，可寫 #400。
內文只用 **粗體**、`程式碼`、#123，換行開頭的「- 」是子項目；不收 HTML、電子郵件、本機路徑與金鑰（頁面是公開的）。
只有在官網寫入名單上的帳號能寫；節點一律是本機金鑰所屬的節點。"
        .to_string()
}

/// 讀一個帶值的參數
fn take(argv: &[String], i: &mut usize, k: &str) -> R<String> {
    *i += 1;
    argv.get(*i).cloned().ok_or_else(|| Fail::new(1, format!("{k} 缺少參數\n{}", usage())))
}

fn bad(msg: impl Into<String>) -> Fail {
    Fail::new(1, format!("{}\n{}", msg.into(), usage()))
}

/// `asn-cli site release` 的參數 → 送給後台的 JSON（只放有給的欄位）
pub fn parse_release(argv: &[String]) -> R<Option<Value>> {
    let mut o = Map::new();
    let (mut items, mut platforms): (Vec<String>, Vec<String>) = (vec![], vec![]);
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        match k {
            "--version" => {
                o.insert("version".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--date" => {
                o.insert("released_on".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--commit" => {
                o.insert("commit_sha".into(), json!(take(argv, &mut i, k)?.trim().to_lowercase()));
            }
            "--notes" => {
                o.insert("notes".into(), json!(take(argv, &mut i, k)?));
            }
            "--item" => items.push(take(argv, &mut i, k)?),
            "--platform" => platforms.extend(take(argv, &mut i, k)?.split(|c: char| c == '、' || c == ',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty())),
            "--help" | "-h" => return Ok(None),
            _ => return Err(bad(format!("不認得的參數 {k}"))),
        }
        i += 1;
    }
    if !o.contains_key("version") {
        return Err(bad("請用 --version 指定版本（例如 0.1.96）"));
    }
    if !items.is_empty() {
        o.insert("items".into(), json!(items));
    }
    if !platforms.is_empty() {
        o.insert("platforms".into(), json!(platforms));
    }
    if o.len() == 1 {
        return Err(bad("除了 --version 至少還要給一個欄位（新的版本要 --date 與 --item）"));
    }
    Ok(Some(Value::Object(o)))
}

/// 議題編號：可重複、可逗號分隔、可帶 #
fn parse_refs(s: &str, out: &mut Vec<u32>) -> R<()> {
    for p in s.split(|c: char| c == ',' || c == '、' || c == ' ').map(str::trim).filter(|p| !p.is_empty()) {
        let n = p.trim_start_matches('#').parse::<u32>().ok().filter(|n| *n > 0 && *n < 1_000_000_000).ok_or_else(|| bad(format!("--ref 要是議題編號（正整數），收到 {p}")))?;
        if !out.contains(&n) {
            out.push(n);
        }
    }
    Ok(())
}

/// `asn-cli site item` 的參數 → 送給後台的 JSON（只放有給的欄位）
pub fn parse_item(argv: &[String]) -> R<Option<Value>> {
    let mut o = Map::new();
    let mut refs: Option<Vec<u32>> = None;
    let mut body_file: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        match k {
            "--key" => {
                o.insert("item_key".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--section" => {
                o.insert("section".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--lane" => {
                o.insert("lane".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--title" => {
                o.insert("title".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--body" => {
                o.insert("body".into(), json!(take(argv, &mut i, k)?));
            }
            "--body-file" => body_file = Some(take(argv, &mut i, k)?),
            "--status" => {
                o.insert("status".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--version" => {
                o.insert("version".into(), json!(take(argv, &mut i, k)?.trim()));
            }
            "--sort" => {
                let v = take(argv, &mut i, k)?;
                let n = v.trim().parse::<u32>().ok().filter(|n| *n <= 1_000_000).ok_or_else(|| bad("--sort 要是 0～1000000 的整數"))?;
                o.insert("sort_order".into(), json!(n));
            }
            "--ref" => parse_refs(&take(argv, &mut i, k)?, refs.get_or_insert_with(Vec::new))?,
            "--help" | "-h" => return Ok(None),
            _ => return Err(bad(format!("不認得的參數 {k}"))),
        }
        i += 1;
    }
    if !o.contains_key("item_key") {
        return Err(bad("請用 --key 指定項目代號（小寫英數與連字號，例如 todo-next-15b）"));
    }
    if o.contains_key("section") != o.contains_key("lane") {
        return Err(bad("--section 與 --lane 要一起給"));
    }
    if let Some(p) = body_file {
        if o.contains_key("body") {
            return Err(bad("--body 與 --body-file 只能給一個"));
        }
        let text = std::fs::read_to_string(&p).map_err(|e| Fail::new(1, format!("讀不到 {p}：{e}")))?;
        o.insert("body".into(), json!(text.trim_start_matches('\u{feff}').trim_end()));
    }
    if let Some(r) = refs {
        o.insert("refs".into(), json!(r));
    }
    if o.len() == 1 {
        return Err(bad("除了 --key 至少還要給一個欄位（新項目要 --section、--lane、--body、--status）"));
    }
    Ok(Some(Value::Object(o)))
}

/// 一個欄位：字串（一行一項）或字串陣列 → 去掉空白行的字串陣列
fn lines_of(v: Option<&Value>, field: &str, idx: usize) -> R<Vec<String>> {
    let err = || Fail::new(1, format!("第 {} 場：{field} 要是字串或字串陣列", idx + 1));
    let raw: Vec<String> = match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).ok_or_else(err)).collect::<R<_>>()?,
        _ => return Err(err()),
    };
    let out: Vec<String> = raw.iter().flat_map(|s| s.split('\n')).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if out.is_empty() {
        return Err(Fail::new(1, format!("第 {} 場：{field} 沒有內容（沒內容請寫「無」）", idx + 1)));
    }
    Ok(out)
}

/// 「YYYY-MM-DD HH:MM」（台北時間）→ 帶時區的 ISO 時間；已帶時區的 held_at 原樣送
pub fn held_at_of(m: &Map<String, Value>, idx: usize) -> R<String> {
    if let Some(h) = m.get("held_at").and_then(Value::as_str) {
        return Ok(h.trim().to_string());
    }
    let t = m.get("time").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let b = t.as_bytes();
    let ok = b.len() == 16 && b[4] == b'-' && b[7] == b'-' && (b[10] == b' ' || b[10] == b'T') && b[13] == b':'
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15].iter().all(|&j| b[j].is_ascii_digit());
    if !ok {
        return Err(Fail::new(1, format!("第 {} 場：time 要寫台北時間「YYYY-MM-DD HH:MM」（或用 held_at 帶時區的 ISO 時間）", idx + 1)));
    }
    Ok(format!("{}T{}:00+08:00", &t[..10], &t[11..]))
}

/// 會議檔內容 → 送給後台的會議（單一物件或陣列）
pub fn meetings_from_json(text: &str) -> R<Vec<Value>> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| Fail::new(1, format!("檔案不是正確的 JSON：{e}")))?;
    let list = match v {
        Value::Array(a) => a,
        Value::Object(_) => vec![v],
        _ => return Err(Fail::new(1, "檔案要是單一物件或物件陣列")),
    };
    if list.is_empty() || list.len() > MAX_MEETINGS {
        return Err(Fail::new(1, format!("一次要 1～{MAX_MEETINGS} 場，這個檔有 {} 場", list.len())));
    }
    list.iter()
        .enumerate()
        .map(|(i, m)| -> R<Value> {
            let o = m.as_object().ok_or_else(|| Fail::new(1, format!("第 {} 場：要是物件", i + 1)))?;
            let mut out = Map::new();
            out.insert("held_at".into(), json!(held_at_of(o, i)?));
            for f in ["attendees", "progress", "decisions", "assignments", "improvements"] {
                out.insert(f.into(), json!(lines_of(o.get(f), f, i)?));
            }
            Ok(Value::Object(out))
        })
        .collect()
}

/// 後台回應 → 結束碼與訊息（非 2xx 印後台的中文說明）
fn check(action: &str, status: u16, v: &Value) -> R<()> {
    if (200..300).contains(&status) && v.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let code = v.get("error").and_then(Value::as_str).unwrap_or("");
    let detail = v.get("detail").and_then(Value::as_str).map(String::from);
    match status {
        404 => Err(Fail::new(4, format!("錯誤：後台還沒有官網寫入功能（{action} HTTP 404），請等後台更新"))),
        403 | 429 => Err(Fail::new(3, format!("錯誤：{}", detail.unwrap_or_else(|| format!("{action} HTTP {status} {code}"))))),
        400 => Err(Fail::new(1, format!("錯誤：{}", detail.unwrap_or_else(|| format!("{action} HTTP 400 {code}"))))),
        _ => Err(Fail::new(4, format!("錯誤：{action} HTTP {status} {code}").trim().to_string())),
    }
}

fn verb(v: &Value) -> &'static str {
    if v.get("created").and_then(Value::as_bool) == Some(true) {
        "已新增"
    } else {
        "已更新"
    }
}

async fn send(env: &Env, action: &str, body: Value) -> R<Value> {
    let id = identity(env, true)?;
    let r = relay(&id, &id.node);
    let (status, v) = r.api_status(action, body).await.map_err(backend)?;
    check(action, status, &v)?;
    Ok(v)
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let Some((sub, rest)) = argv.split_first() else {
        io.errln(&usage());
        return Ok(1);
    };
    match sub.as_str() {
        "--help" | "-h" | "help" => {
            io.outln(&usage());
            Ok(0)
        }
        "release" => {
            let Some(body) = parse_release(rest)? else {
                io.outln(&usage());
                return Ok(0);
            };
            let v = send(env, "site_release_upsert", body).await?;
            io.outln(&format!("{} {} 發版記錄", verb(&v), v.get("version").and_then(Value::as_str).unwrap_or("")));
            Ok(0)
        }
        "item" => {
            let Some(body) = parse_item(rest)? else {
                io.outln(&usage());
                return Ok(0);
            };
            let v = send(env, "site_item_upsert", body).await?;
            io.outln(&format!("{}項目 {}", verb(&v), v.get("item_key").and_then(Value::as_str).unwrap_or("")));
            Ok(0)
        }
        "meeting" => {
            let mut file: Option<String> = None;
            let mut i = 0;
            while i < rest.len() {
                let k = rest[i].as_str();
                match k {
                    "--file" => file = Some(take(rest, &mut i, k)?),
                    "--help" | "-h" => {
                        io.outln(&usage());
                        return Ok(0);
                    }
                    _ => return Err(bad(format!("不認得的參數 {k}"))),
                }
                i += 1;
            }
            let p = file.ok_or_else(|| bad("請用 --file 指定會議記錄的 JSON 檔"))?;
            let text = std::fs::read_to_string(&p).map_err(|e| Fail::new(1, format!("讀不到 {p}：{e}")))?;
            let list = meetings_from_json(&text)?;
            for m in list {
                let at = m["held_at"].as_str().unwrap_or("").to_string();
                let v = send(env, "site_meeting_add", m).await?;
                io.outln(&format!("{} {at} 會議記錄（編號 {}）", verb(&v), v.get("id").map(Value::to_string).unwrap_or_default()));
            }
            Ok(0)
        }
        other => Err(Fail::new(1, format!("不認得的子命令 site {other}\n{}", usage()))),
    }
}
