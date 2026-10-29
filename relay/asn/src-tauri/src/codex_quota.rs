//! Codex 的剩餘額度（#374 帳號列表）：橋的 Codex 引擎查 `account/read`、`account/rateLimits/read` 時，
//! 把各個額度窗與當下的帳號 email 原子寫進工作資料夾的 `codex-quota.json`（不在 ~/.codex，不碰 Codex 的任何檔案）。
//! 回報時只有「檔裡的帳號＝目前登入的帳號」才帶上額度窗；沒有檔（沒開 Codex 橋接）就不帶，畫面標「開 Codex 後才讀得到」。
//!
//! 對應：`primary`／`secondary` 的 `windowDurationMins` 300＝five_hour、10080＝weekly，其他長度＝`w<分鐘數>`；
//! 沒有長度時 primary 當 five_hour、secondary 當 weekly。`usedPercent` 換成剩餘（100−已用，四捨五入，0～100），
//! `resetsAt`（秒）換成 `2026-10-24T12:00:00Z`。格式跟後台的 parseWindows（account_switch.ts）一致：
//! `{ name, left_pct, resets_at, read_at }`。
//! 檔案只有 email、額度窗、記錄時間；權杖、帳號編號一律不碰（rateLimits 的回應本來就沒有）。
use crate::claude_accounts::normalize_email;
use crate::claude_quota::{iso_secs, parse_iso_secs};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const FILE: &str = "codex-quota.json";
const MAX_WINDOWS: usize = 4;

pub fn path(work_dir: &Path) -> PathBuf {
    work_dir.join(FILE)
}

/// 分鐘數 → 窗名
fn window_name(mins: Option<u64>, slot: &str) -> Option<String> {
    match mins {
        Some(300) => Some("five_hour".into()),
        Some(10080) => Some("weekly".into()),
        Some(m) if (1..=999_999).contains(&m) => Some(format!("w{m}")),
        Some(_) => None,
        None if slot == "primary" => Some("five_hour".into()),
        None => Some("weekly".into()),
    }
}

/// `account/rateLimits/read` 的回應 → 額度窗（只取 primary、secondary）。讀取時間＝now_ms。
pub fn windows_from_rate_limits(rl: &Value, now_ms: i64) -> Vec<Value> {
    let r = rl.get("rateLimits").unwrap_or(rl);
    let mut out: Vec<Value> = vec![];
    for slot in ["primary", "secondary"] {
        let Some(w) = r.get(slot).filter(|w| w.is_object()) else { continue };
        let Some(used) = w.get("usedPercent").and_then(Value::as_f64).filter(|u| u.is_finite() && *u >= 0.0) else { continue };
        let Some(name) = window_name(w.get("windowDurationMins").and_then(Value::as_u64), slot) else { continue };
        if out.iter().any(|o| o["name"] == name.as_str()) {
            continue;
        }
        let left = (100.0 - used).clamp(0.0, 100.0).round() as u8;
        let reset = w.get("resetsAt").and_then(Value::as_i64).filter(|s| *s > 0).map(|s| iso_secs(s * 1000));
        out.push(json!({ "name": name, "left_pct": left, "resets_at": reset, "read_at": iso_secs(now_ms) }));
    }
    out
}

/// `account/read` 的回應裡的帳號 email（正規化）；沒登入、不是 ChatGPT 登入或沒有 email 是 None
pub fn email_from_account(acc: &Value) -> Option<String> {
    let a = acc.get("account")?;
    if a.get("type").and_then(Value::as_str) != Some("chatgpt") {
        return None;
    }
    normalize_email(a.get("email")?.as_str()?)
}

/// 原子寫入：{ email, windows, at }。沒有額度窗就不寫（保留上一份）。
pub fn save(work_dir: &Path, email: &str, windows: &[Value], now_ms: i64) -> Result<(), String> {
    let email = normalize_email(email).ok_or("email 格式不對")?;
    if windows.is_empty() {
        return Ok(());
    }
    let w: Vec<&Value> = windows.iter().take(MAX_WINDOWS).collect();
    let text = json!({ "email": email, "windows": w, "at": iso_secs(now_ms) }).to_string();
    crate::write_atomic(&path(work_dir), &text).map_err(|e| e.to_string())
}

fn clean_window(w: &Value, now_ms: i64) -> Option<Value> {
    let name = w.get("name").and_then(Value::as_str).filter(|n| *n == "five_hour" || *n == "weekly" || (n.len() >= 2 && n.len() <= 7 && n.starts_with('w') && n[1..].bytes().all(|c| c.is_ascii_digit())))?;
    let left = w.get("left_pct").and_then(Value::as_u64).filter(|n| *n <= 100)?;
    let read = w.get("read_at").and_then(Value::as_str).filter(|s| parse_iso_secs(s).is_some())?;
    let reset = match w.get("resets_at") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str().and_then(parse_iso_secs)?),
    };
    // 重置時間已過：那個百分比是重置前的舊值，不送
    if reset.is_some_and(|r| r <= now_ms) {
        return None;
    }
    Some(json!({ "name": name, "left_pct": left, "resets_at": reset.map(iso_secs), "read_at": read }))
}

/// 回報用：檔裡的帳號跟目前登入的 email 對得上才回額度窗；對不上、沒有檔、壞掉都回空的。
pub fn windows_for(work_dir: &Path, login_email: &str, now_ms: i64) -> Vec<Value> {
    let Some(v) = std::fs::read_to_string(path(work_dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return vec![] };
    let (Some(file_email), Some(me)) = (v.get("email").and_then(Value::as_str).and_then(normalize_email), normalize_email(login_email)) else { return vec![] };
    if file_email != me {
        return vec![];
    }
    v.get("windows").and_then(Value::as_array).map(|a| a.iter().take(MAX_WINDOWS).filter_map(|w| clean_window(w, now_ms)).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-24T12:00:00Z
    const NOW: i64 = 1_792_843_200_000;

    fn rl(p_used: f64, p_mins: Option<u64>, s_used: f64, s_mins: Option<u64>) -> Value {
        let w = |u: f64, m: Option<u64>, reset: i64| {
            let mut o = json!({ "usedPercent": u, "resetsAt": reset });
            if let Some(m) = m {
                o["windowDurationMins"] = json!(m);
            }
            o
        };
        json!({ "rateLimits": { "primary": w(p_used, p_mins, 1_792_850_400), "secondary": w(s_used, s_mins, 1_793_000_000), "rateLimitReachedType": null }, "ordinaryUsageAllowed": true })
    }

    #[test]
    fn 三百分鐘是五小時_一萬零八十分鐘是每週_用掉五趴剩九十五_時間換成字串() {
        let w = windows_from_rate_limits(&rl(5.0, Some(300), 37.6, Some(10080)), NOW);
        assert_eq!(
            w,
            vec![
                json!({ "name": "five_hour", "left_pct": 95, "resets_at": "2026-10-24T14:00:00Z", "read_at": "2026-10-24T12:00:00Z" }),
                json!({ "name": "weekly", "left_pct": 62, "resets_at": "2026-10-26T07:33:20Z", "read_at": "2026-10-24T12:00:00Z" }),
            ]
        );
    }

    #[test]
    fn 其他長度叫_w分鐘數_沒有長度照位置_超過一百算零_壞掉的單窗丟掉() {
        let w = windows_from_rate_limits(&rl(120.0, Some(60), 0.0, None), NOW);
        assert_eq!((w[0]["name"].as_str(), w[0]["left_pct"].as_u64()), (Some("w60"), Some(0)));
        assert_eq!((w[1]["name"].as_str(), w[1]["left_pct"].as_u64()), (Some("weekly"), Some(100)));
        let w = windows_from_rate_limits(&rl(10.0, None, 10.0, None), NOW);
        assert_eq!(w[0]["name"], "five_hour");
        let bad = json!({ "rateLimits": { "primary": { "usedPercent": "多" }, "secondary": null } });
        assert!(windows_from_rate_limits(&bad, NOW).is_empty());
        let no_reset = json!({ "rateLimits": { "primary": { "usedPercent": 1, "windowDurationMins": 300 } } });
        assert_eq!(windows_from_rate_limits(&no_reset, NOW)[0]["resets_at"], Value::Null);
    }

    #[test]
    fn 帳號只認_chatgpt_登入的_email() {
        assert_eq!(email_from_account(&json!({ "account": { "type": "chatgpt", "email": " Me@X.test ", "planType": "plus" } })).as_deref(), Some("me@x.test"));
        assert_eq!(email_from_account(&json!({ "account": { "type": "chatgpt", "planType": "plus" } })), None, "沒有 email");
        assert_eq!(email_from_account(&json!({ "account": { "type": "apiKey" } })), None);
        assert_eq!(email_from_account(&json!({ "account": null })), None);
    }

    #[test]
    fn 存檔後_帳號對得上才帶額度窗_對不上或沒檔不帶() {
        let d = tempfile::tempdir().unwrap();
        assert!(windows_for(d.path(), "me@x.test", NOW).is_empty(), "沒有檔");
        let w = windows_from_rate_limits(&rl(5.0, Some(300), 40.0, Some(10080)), NOW);
        save(d.path(), "me@x.test", &w, NOW).unwrap();
        assert_eq!(windows_for(d.path(), "ME@x.test", NOW + 60_000), w);
        assert!(windows_for(d.path(), "other@x.test", NOW).is_empty(), "email 對不上不帶");
        let raw = std::fs::read_to_string(path(d.path())).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let mut keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["at", "email", "windows"], "檔裡只有 email、額度窗、記錄時間");
    }

    #[test]
    fn 重置時間已過的窗不送_檔壞掉當沒有() {
        let d = tempfile::tempdir().unwrap();
        let w = windows_from_rate_limits(&rl(5.0, Some(300), 40.0, Some(10080)), NOW);
        save(d.path(), "me@x.test", &w, NOW).unwrap();
        let later = 1_792_850_400_000 + 1;
        let got = windows_for(d.path(), "me@x.test", later);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["name"], "weekly");
        std::fs::write(path(d.path()), "壞掉{").unwrap();
        assert!(windows_for(d.path(), "me@x.test", NOW).is_empty());
        std::fs::write(path(d.path()), r#"{"email":"me@x.test","windows":[{"name":"x","left_pct":5,"read_at":"2026-10-24T12:00:00Z"},{"name":"weekly","left_pct":500,"read_at":"2026-10-24T12:00:00Z"}]}"#).unwrap();
        assert!(windows_for(d.path(), "me@x.test", NOW).is_empty(), "窗名或百分比不對的丟掉");
    }

    #[test]
    fn 沒有額度窗不寫檔() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), "me@x.test", &[], NOW).unwrap();
        assert!(!path(d.path()).exists());
        assert!(save(d.path(), "壞", &[json!({})], NOW).is_err());
    }
}
