//! `asn-cli usage`：無頭節點由執行中的代理自己回報每小時用量（後台動作 usage_report／usage_list）。
//! 系統不蒐集、不定時送出，也不解析 claude 的紀錄；要報就由代理自己下一行指令。
//!   asn-cli usage report --file <hourly.json>
//!   asn-cli usage report --input-tokens N --cache-read-tokens N --cache-creation-tokens N --output-tokens N --tasks-ok N --tasks-failed N --rounds N [--hour <ISO整點>]
//!   asn-cli usage list [--since <ISO>]
//! 檔案可為單一物件或陣列（一次最多 48 筆）；欄位 hour／input_tokens／cache_read_tokens／cache_creation_tokens／output_tokens／tasks_ok／tasks_failed／rounds，
//! 檔裡的 node 欄位會被忽略（節點一律是金鑰所屬的自己）。旗標模式沒給的計數算 0，hour 預設為目前 UTC 整點；同一小時重報＝覆寫。
//! 只印後台回的結果（report 印 {"ok":true,"saved":N}、list 印 {"rows":[...]}），絕不印金鑰。
//! 結束碼：1 用法／內容不對、4 後端錯誤。
use super::caller::{backend, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use serde_json::{json, Map, Value};

pub const MAX_ROWS: usize = 48;
pub const FIELDS: [&str; 7] = ["input_tokens", "cache_read_tokens", "cache_creation_tokens", "output_tokens", "tasks_ok", "tasks_failed", "rounds"];
const FLAGS: [(&str, &str); 7] = [
    ("--input-tokens", "input_tokens"),
    ("--cache-read-tokens", "cache_read_tokens"),
    ("--cache-creation-tokens", "cache_creation_tokens"),
    ("--output-tokens", "output_tokens"),
    ("--tasks-ok", "tasks_ok"),
    ("--tasks-failed", "tasks_failed"),
    ("--rounds", "rounds"),
];

fn usage() -> String {
    "用法：
  asn-cli usage report --file <hourly.json>
  asn-cli usage report [--hour <ISO整點>] --input-tokens N --cache-read-tokens N --cache-creation-tokens N --output-tokens N --tasks-ok N --tasks-failed N --rounds N
  asn-cli usage list [--since <ISO時間>]
report 把某個整點的用量送到後台；同一個整點重報＝覆寫。檔案可為單一物件或陣列（最多 48 筆）。
旗標模式：沒給的計數算 0，--hour 省略就用目前 UTC 的整點；--file 與計數旗標不能一起用。
list 列出本節點自己的用量（新的在前，最多 200 筆），--since 只列該時間之後的。"
        .to_string()
}

#[derive(Debug, Default, PartialEq)]
pub struct ReportArgs {
    pub file: Option<String>,
    pub hour: Option<String>,
    pub counts: Vec<(String, u64)>,
    pub help: bool,
}

pub fn parse_report(argv: &[String]) -> R<ReportArgs> {
    let mut a = ReportArgs::default();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        let mut need = || -> R<String> {
            i += 1;
            argv.get(i).cloned().ok_or_else(|| Fail::new(1, format!("{k} 缺少參數\n{}", usage())))
        };
        match k {
            "--file" => a.file = Some(need()?),
            "--hour" => a.hour = Some(need()?),
            "--help" | "-h" => a.help = true,
            _ => match FLAGS.iter().find(|(f, _)| *f == k) {
                Some((_, field)) => {
                    let v = need()?;
                    let n = v.trim().parse::<u64>().ok().filter(|n| *n < 1_000_000_000_000_000).ok_or_else(|| Fail::new(1, format!("{k} 要是 0 以上的整數\n{}", usage())))?;
                    a.counts.retain(|(f, _)| f != field);
                    a.counts.push((field.to_string(), n));
                }
                None => return Err(Fail::new(1, format!("不認得的參數 {k}\n{}", usage()))),
            },
        }
        i += 1;
    }
    if !a.help {
        if a.file.is_some() && (!a.counts.is_empty() || a.hour.is_some()) {
            return Err(Fail::new(1, format!("--file 不能和 --hour 或計數旗標一起用\n{}", usage())));
        }
        if a.file.is_none() && a.counts.is_empty() {
            return Err(Fail::new(1, format!("請用 --file，或至少給一個計數旗標\n{}", usage())));
        }
    }
    Ok(a)
}

/// 毫秒時間 → 該 UTC 整點的 ISO 字串（YYYY-MM-DDTHH:00:00Z）
pub fn hour_floor_iso(ms: u64) -> String {
    let hour_ms = ms / 3_600_000 * 3_600_000;
    let full = super::recv::iso(hour_ms);
    format!("{}:00:00Z", &full[..13])
}

fn is_count(v: &Value) -> bool {
    v.as_u64().map(|n| n < 1_000_000_000_000_000).unwrap_or(false)
}

/// 檢查一筆並只留約定欄位（node 等多餘欄位丟掉）
pub fn clean_row(v: &Value, idx: usize) -> R<Value> {
    let bad = |why: String| Fail::new(1, format!("第 {} 筆：{why}", idx + 1));
    let o = v.as_object().ok_or_else(|| bad("要是物件".into()))?;
    let hour = o.get("hour").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 40).ok_or_else(|| bad("hour 要是 ISO 整點時間字串".into()))?;
    let mut out = Map::new();
    out.insert("hour".into(), json!(hour));
    for f in FIELDS {
        match o.get(f) {
            Some(x) if is_count(x) => {
                out.insert(f.into(), x.clone());
            }
            Some(_) => return Err(bad(format!("{f} 要是 0 以上的整數"))),
            None => return Err(bad(format!("缺少 {f}"))),
        }
    }
    Ok(Value::Object(out))
}

/// 檔案內容 → 資料列（單一物件或陣列）
pub fn rows_from_json(text: &str) -> R<Vec<Value>> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| Fail::new(1, format!("檔案不是正確的 JSON：{e}")))?;
    let list = match v {
        Value::Array(a) => a,
        Value::Object(_) => vec![v],
        _ => return Err(Fail::new(1, "檔案要是單一物件或物件陣列")),
    };
    if list.is_empty() || list.len() > MAX_ROWS {
        return Err(Fail::new(1, format!("一次要 1～{MAX_ROWS} 筆，這個檔有 {} 筆", list.len())));
    }
    list.iter().enumerate().map(|(i, r)| clean_row(r, i)).collect()
}

pub fn row_from_flags(a: &ReportArgs, now_ms: u64) -> Value {
    let mut o = Map::new();
    o.insert("hour".into(), json!(a.hour.clone().unwrap_or_else(|| hour_floor_iso(now_ms))));
    for f in FIELDS {
        o.insert(f.into(), json!(a.counts.iter().find(|(k, _)| k == f).map(|(_, n)| *n).unwrap_or(0)));
    }
    Value::Object(o)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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
        "report" => {
            let a = parse_report(rest)?;
            if a.help {
                io.outln(&usage());
                return Ok(0);
            }
            let rows = match &a.file {
                Some(p) => {
                    let text = std::fs::read_to_string(p).map_err(|e| Fail::new(1, format!("讀不到 {p}：{e}")))?;
                    rows_from_json(&text)?
                }
                None => vec![clean_row(&row_from_flags(&a, now_ms()), 0)?],
            };
            let id = identity(env, true)?;
            let r = relay(&id, &id.node);
            let res = r.api("usage_report", Some(json!({ "rows": rows }))).await.map_err(backend)?;
            io.outln(&res.to_string());
            Ok(0)
        }
        "list" => {
            let mut since: Option<String> = None;
            let mut i = 0;
            while i < rest.len() {
                match rest[i].as_str() {
                    "--since" => {
                        i += 1;
                        since = Some(rest.get(i).cloned().ok_or_else(|| Fail::new(1, format!("--since 缺少參數\n{}", usage())))?);
                    }
                    "--help" | "-h" => {
                        io.outln(&usage());
                        return Ok(0);
                    }
                    k => return Err(Fail::new(1, format!("不認得的參數 {k}\n{}", usage()))),
                }
                i += 1;
            }
            let id = identity(env, true)?;
            let r = relay(&id, &id.node);
            let action = match &since {
                Some(s) => format!("usage_list&since={}", crate::relay::encode_component(s)),
                None => "usage_list".to_string(),
            };
            let res = r.api(&action, None).await.map_err(backend)?;
            io.outln(&res.to_string());
            Ok(0)
        }
        other => Err(Fail::new(1, format!("不認得的子命令 usage {other}\n{}", usage()))),
    }
}
