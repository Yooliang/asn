//! 各 Claude 帳號上次看到的剩餘額度（#228）。
//!
//! 來源只有一個：Claude Code 在執行時，會把「目前這個帳號」最近一次回應帶回來的 5 小時與每週額度
//! （已用百分比與重置時間）放進狀態列指令的標準輸入。使用者把 `asn claude-quota` 接進自己的狀態列指令，
//! 這裡就只取那幾個數字，記在「當時登入的帳號」底下。所以：
//! - 只有用過、且當時有送出額度的帳號才有紀錄；其他帳號沒有，介面寫「額度未知」，不編數字。
//! - 每筆紀錄附上記錄時間，介面才能標「N 分鐘前」與「資料較舊」。
//! - 不讀任何登入憑證、不連網、不執行外部程式：目前帳號只看 `.claude.json` 裡的 email 欄位。
//!   輸入裡除了額度數字以外的內容（工作階段、路徑、模型…）一律不留。
//! 紅線：函式一律吃家目錄路徑參數；只有 Tauri 指令與命令列入口會決定真實家目錄，測試不得呼叫它們。
use crate::claude_accounts;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const MAX_ACCOUNTS: usize = 20;
const MAX_INPUT: usize = 1_000_000;

/// 一個帳號的額度紀錄。百分比是「剩餘」；`at` 是記錄時間（UTC，秒）。
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Quota {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_hour_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
    pub at: String,
}

/// 從狀態列資料解析出來的額度（還沒有記錄時間）
#[derive(Debug, PartialEq, Clone)]
pub struct Parsed {
    pub five_hour_pct: Option<u8>,
    pub weekly_pct: Option<u8>,
    pub reset_at: Option<String>,
}

pub fn quota_path(home: &Path) -> PathBuf {
    home.join(".asn").join("claude-quota.json")
}

// ---------- 時間 ----------
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
/// 毫秒 → `2026-10-24T12:00:00Z`
pub fn iso_secs(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(s.div_euclid(86400));
    let r = s.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, r % 3600 / 60, r % 60)
}

// ---------- 解析 ----------
fn used_to_left(v: &Value) -> Option<u8> {
    let used = v.as_f64().filter(|u| u.is_finite() && *u >= 0.0)?;
    Some((100.0 - used).clamp(0.0, 100.0).round() as u8)
}
/// 重置時間：秒（或毫秒）為單位的數字；其他格式不採用
fn reset_ms(v: &Value) -> Option<i64> {
    let n = v.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    Some(if n > 1e11 { n as i64 } else { (n * 1000.0) as i64 })
}
/// 一個視窗：(剩餘百分比, 重置毫秒)。重置時間已過代表那個百分比是重置前的舊值，整個視窗不採用。
fn window(rl: &Value, key: &str, now_ms: i64) -> Option<(u8, Option<i64>)> {
    let w = rl.get(key)?;
    let left = used_to_left(w.get("used_percentage")?)?;
    let reset = w.get("resets_at").and_then(reset_ms);
    if reset.is_some_and(|r| r <= now_ms) {
        return None;
    }
    Some((left, reset))
}

/// 狀態列資料 → 額度。只讀 `rate_limits.five_hour／seven_day` 的已用百分比與重置時間；
/// 重置時間給「用完的那個視窗」（兩個都用完給較晚的），都沒用完就給 5 小時視窗的。沒有任何視窗就是 None。
pub fn parse_statusline(text: &str, now_ms: i64) -> Option<Parsed> {
    let v: Value = serde_json::from_str(text).ok()?;
    let rl = v.get("rate_limits")?;
    let five = window(rl, "five_hour", now_ms);
    let week = window(rl, "seven_day", now_ms);
    if five.is_none() && week.is_none() {
        return None;
    }
    let spent: Vec<i64> = [five, week].iter().flatten().filter(|(p, _)| *p == 0).filter_map(|(_, r)| *r).collect();
    let reset = spent.iter().max().copied().or_else(|| five.and_then(|(_, r)| r)).or_else(|| week.and_then(|(_, r)| r));
    Some(Parsed { five_hour_pct: five.map(|f| f.0), weekly_pct: week.map(|w| w.0), reset_at: reset.map(iso_secs) })
}

// ---------- 讀寫 ----------
fn iso_like(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | 'T' | 'Z' | '+' | '.'))
}
fn pct_of(v: Option<&Value>) -> Option<u8> {
    v.and_then(Value::as_u64).filter(|n| *n <= 100).map(|n| n as u8)
}

/// 讀額度檔：檔案不存在或壞掉是空的；每個欄位逐一驗證（超出範圍／格式不對的丟掉），鍵必須是已正規化的 email，
/// 沒有任何百分比或沒有記錄時間的整筆不收。
pub fn load_all(home: &Path) -> HashMap<String, Quota> {
    let Some(Value::Object(m)) = std::fs::read_to_string(quota_path(home)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return HashMap::new() };
    let mut out = HashMap::new();
    for (k, v) in m.into_iter().take(MAX_ACCOUNTS * 2) {
        if claude_accounts::normalize_email(&k).as_deref() != Some(k.as_str()) {
            continue;
        }
        let (five, week) = (pct_of(v.get("five_hour_pct")), pct_of(v.get("weekly_pct")));
        let at = v.get("at").and_then(Value::as_str).filter(|s| iso_like(s));
        let (true, Some(at)) = (five.is_some() || week.is_some(), at) else { continue };
        let reset_at = v.get("reset_at").and_then(Value::as_str).filter(|s| iso_like(s)).map(String::from);
        out.insert(k, Quota { five_hour_pct: five, weekly_pct: week, reset_at, at: at.to_string() });
        if out.len() >= MAX_ACCOUNTS {
            break;
        }
    }
    out
}

fn record(home: &Path, email: &str, p: Parsed, now_ms: i64) -> Result<(), String> {
    let mut all = load_all(home);
    all.insert(email.to_string(), Quota { five_hour_pct: p.five_hour_pct, weekly_pct: p.weekly_pct, reset_at: p.reset_at, at: iso_secs(now_ms) });
    if all.len() > MAX_ACCOUNTS {
        let mut by_age: Vec<(String, String)> = all.iter().map(|(k, q)| (q.at.clone(), k.clone())).collect();
        by_age.sort();
        let drop_n = all.len() - MAX_ACCOUNTS;
        for (_, k) in by_age.into_iter().take(drop_n) {
            all.remove(&k);
        }
    }
    let text = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    crate::claude_json::write_atomic(&quota_path(home), text.as_bytes()).map_err(|e| e.to_string())
}

/// 狀態列掛鉤：把輸入裡的額度記在目前登入的帳號底下。有記下回 true；沒登入、沒額度、輸入太大或寫檔失敗回 false。
pub fn hook(home: &Path, input: &str, now_ms: i64) -> bool {
    if input.len() > MAX_INPUT {
        return false;
    }
    let Some(parsed) = parse_statusline(input, now_ms) else { return false };
    let Some(email) = claude_accounts::current_email(home) else { return false };
    record(home, &email, parsed, now_ms).is_ok()
}

/// 前端讀本機各帳號的額度紀錄（email → 額度）
#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_quota_all() -> HashMap<String, Quota> {
    load_all(&claude_accounts::claude_home())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acct_remote::build_report_with_quota;
    use crate::claude_accounts::AccountInfo;
    use serde_json::json;

    // 2026-10-24T12:00:00Z
    const NOW: i64 = 1_792_843_200_000;

    fn status(five_used: f64, five_reset: i64, week_used: f64, week_reset: i64) -> String {
        json!({
            "session_id": "S-1", "cwd": "D:/x", "model": { "id": "m" },
            "oauth_token": "SECRET-TOKEN",
            "rate_limits": {
                "five_hour": { "used_percentage": five_used, "resets_at": five_reset },
                "seven_day": { "used_percentage": week_used, "resets_at": week_reset }
            }
        })
        .to_string()
    }

    #[test]
    fn 狀態列資料換算成剩餘百分比與重置時間() {
        let p = parse_statusline(&status(38.4, 1_792_850_400, 20.0, 1_793_000_000), NOW).unwrap();
        assert_eq!(p.five_hour_pct, Some(62));
        assert_eq!(p.weekly_pct, Some(80));
        assert_eq!(p.reset_at.as_deref(), Some("2026-10-24T14:00:00Z"), "沒用完時給 5 小時視窗的重置時間");
    }

    #[test]
    fn 某個視窗用完時重置時間給用完的那個_兩個都用完給較晚的() {
        let p = parse_statusline(&status(100.0, 1_792_850_400, 40.0, 1_793_000_000), NOW).unwrap();
        assert_eq!((p.five_hour_pct, p.weekly_pct), (Some(0), Some(60)));
        assert_eq!(p.reset_at.as_deref(), Some("2026-10-24T14:00:00Z"));
        let p = parse_statusline(&status(120.0, 1_792_850_400, 100.0, 1_793_000_000), NOW).unwrap();
        assert_eq!((p.five_hour_pct, p.weekly_pct), (Some(0), Some(0)), "超過 100 也只算 0");
        assert_eq!(p.reset_at.as_deref(), Some("2026-10-26T07:33:20Z"));
    }

    #[test]
    fn 沒有額度欄位_或格式不對_就是沒有紀錄() {
        for t in ["", "不是 json", "{}", r#"{"rate_limits":{}}"#, r#"{"rate_limits":{"five_hour":{"used_percentage":"多"}}}"#, r#"{"rate_limits":{"five_hour":{"used_percentage":-3}}}"#, r#"{"rate_limits":null}"#] {
            assert!(parse_statusline(t, NOW).is_none(), "{t}");
        }
    }

    #[test]
    fn 只有一個視窗也收_另一個留空不編() {
        let p = parse_statusline(r#"{"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":1792850400}}}"#, NOW).unwrap();
        assert_eq!((p.five_hour_pct, p.weekly_pct), (Some(90), None));
    }

    fn tmp_home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn write_cj(home: &std::path::Path, email: &str) {
        std::fs::write(home.join(".claude.json"), json!({ "oauthAccount": { "emailAddress": email, "accountUuid": "11111111-2222-3333-4444-555555555555" } }).to_string()).unwrap();
    }

    #[test]
    fn 掛鉤把額度記在目前登入的帳號底下_不留任何其他內容() {
        let h = tmp_home();
        write_cj(h.path(), "A@X.test");
        assert!(hook(h.path(), &status(38.0, 1_792_850_400, 20.0, 1_793_000_000), NOW));
        let all = load_all(h.path());
        let q = all.get("a@x.test").expect("以正規化 email 為鍵");
        assert_eq!((q.five_hour_pct, q.weekly_pct), (Some(62), Some(80)));
        assert_eq!(q.at, "2026-10-24T12:00:00Z");
        // 守門：檔案只有額度四欄，沒有輸入裡的 token／工作階段／路徑
        let raw = std::fs::read_to_string(quota_path(h.path())).unwrap();
        for bad in ["SECRET", "oauth_token", "session_id", "cwd", "D:/x"] {
            assert!(!raw.contains(bad), "額度檔不該含 {bad}");
        }
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut keys: Vec<&String> = v["a@x.test"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["at", "five_hour_pct", "reset_at", "weekly_pct"]);
    }

    #[test]
    fn 掛鉤沒登入或沒額度就什麼都不寫() {
        let h = tmp_home();
        assert!(!hook(h.path(), &status(1.0, 1_792_850_400, 1.0, 1_793_000_000), NOW), "沒登入");
        assert!(!quota_path(h.path()).exists());
        write_cj(h.path(), "a@x.test");
        assert!(!hook(h.path(), "{}", NOW), "沒額度欄位");
        assert!(!quota_path(h.path()).exists());
    }

    #[test]
    fn 同一帳號覆寫_不同帳號並存_最多留_20_個() {
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        hook(h.path(), &status(10.0, 1_792_850_400, 10.0, 1_793_000_000), NOW);
        hook(h.path(), &status(50.0, 1_792_850_400, 10.0, 1_793_000_000), NOW + 60_000);
        write_cj(h.path(), "b@x.test");
        hook(h.path(), &status(70.0, 1_792_850_400, 10.0, 1_793_000_000), NOW + 120_000);
        let all = load_all(h.path());
        assert_eq!(all["a@x.test"].five_hour_pct, Some(50));
        assert_eq!(all["b@x.test"].five_hour_pct, Some(30));
        for i in 0..25 {
            write_cj(h.path(), &format!("u{i}@x.test"));
            hook(h.path(), &status(5.0, 1_792_850_400, 5.0, 1_793_000_000), NOW + 200_000 + i * 1000);
        }
        let all = load_all(h.path());
        assert_eq!(all.len(), 20);
        assert!(all.contains_key("u24@x.test") && !all.contains_key("a@x.test"), "留最新的");
    }

    #[test]
    fn 額度檔壞掉或被竄改時讀出來是空的_不當機() {
        let h = tmp_home();
        std::fs::create_dir_all(h.path().join(".asn")).unwrap();
        std::fs::write(quota_path(h.path()), "壞掉{").unwrap();
        assert!(load_all(h.path()).is_empty());
        std::fs::write(quota_path(h.path()), r#"{"a@x.test":{"five_hour_pct":999,"weekly_pct":"x","at":"T"},"c@x.test":{"five_hour_pct":999,"weekly_pct":40,"at":"2026-10-24T12:00:00Z"},"壞":{"five_hour_pct":1,"at":"T"}}"#).unwrap();
        let all = load_all(h.path());
        assert!(!all.contains_key("a@x.test"), "兩個百分比都壞掉的整筆不收");
        assert!(!all.contains_key("壞"), "不是 email 的鍵不收");
        assert_eq!((all["c@x.test"].five_hour_pct, all["c@x.test"].weekly_pct), (None, Some(40)), "超出範圍的欄位單獨丟掉");
    }

    fn acct(email: &str, current: bool) -> AccountInfo {
        AccountInfo { email: email.into(), plan: "max".into(), org: "ORG".into(), current, saved: true }
    }

    #[test]
    fn 回報只對有紀錄的_claude_帳號帶額度四欄_其餘維持原樣() {
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        hook(h.path(), &status(38.0, 1_792_850_400, 20.0, 1_793_000_000), NOW);
        let v = build_report_with_quota(&[acct("a@x.test", true), acct("b@x.test", false)], None, &load_all(h.path()));
        assert_eq!(v["accounts"][0], json!({ "vendor": "claude", "email": "a@x.test", "plan": "max", "current": true, "five_hour_pct": 62, "weekly_pct": 80, "reset_at": "2026-10-24T14:00:00Z", "at": "2026-10-24T12:00:00Z" }));
        assert_eq!(v["accounts"][1], json!({ "vendor": "claude", "email": "b@x.test", "plan": "max", "current": false }), "沒有紀錄的帳號不帶任何額度欄位");
        let low = v.to_string().to_lowercase();
        for bad in ["token", "secret", "org", "uuid"] {
            assert!(!low.contains(bad), "回報不該含 {bad}");
        }
    }

    #[test]
    fn 守門_額度模組不碰憑證檔也不連網() {
        // 把會觸發的字串拆開寫，避免這個檢查自己命中自己
        let src = include_str!("claude_quota.rs");
        let body = src.split("#[cfg(test)]").next().unwrap_or("");
        let banned = [
            [".cred", "entials"].concat(),
            ["claude", "AiOauth"].concat(),
            ["read_", "cred"].concat(),
            ["access", "Token"].concat(),
            ["refresh", "Token"].concat(),
            ["http", "://"].concat(),
            ["https", "://"].concat(),
            ["reqw", "est"].concat(),
            ["Comm", "and::new"].concat(),
            ["current_", "login"].concat(),
        ];
        for b in banned {
            assert!(!body.contains(&b), "額度模組不該出現 {b}");
        }
        // 只靠 .claude.json 的 email 欄位判斷目前帳號
        assert!(body.contains("current_email"));
    }

    #[test]
    fn 指令列掛鉤已登記_且吃不下垃圾也不會失敗() {
        let cmd = include_str!("cli/mod.rs");
        assert!(cmd.contains("\"claude-quota\""), "子命令要登記");
        let h = tmp_home();
        write_cj(h.path(), "a@x.test");
        assert!(!hook(h.path(), &"x".repeat(5_000_000), NOW), "太大的輸入直接略過");
        assert!(!hook(h.path(), "\u{0}\u{1}垃圾", NOW));
    }
}
