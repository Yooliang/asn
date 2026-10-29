//! Gemini 的剩餘額度（#374 第二張，asn真 #1515／#1519）：ASN 自己開的 agy 視窗帶 `--settings` 接上狀態列指令
//! （`asn gemini-quota`，見 gemini_session.rs），agy 每次把狀態列資料丟進標準輸入，這裡只取額度與帳號：
//! - 帳號是資料裡的 `email`（agy 自己給的，不讀 agy 的登入檔）；方案是 `plan_tier`。
//! - 額度桶只收 `gemini-5h`→five_hour、`gemini-weekly`→weekly，剩餘 ＝ remaining_fraction×100 四捨五入。
//!   其他桶（`3p-*`、分模型的）、`disabled` 的、只有剩餘數量算不出 % 的一律丟掉，寫進 log。
//! - 沒有 `email` 或沒有 `quota` 的整筆略過：agy 啟動前 1～2 秒欄位是陸續補上的，不能當成「沒額度」。
//! - 新舊判斷用 merge.rs 的 Gemini 規則（Codex 規則＋記著 100% 照收）。
//! - 本機檔 `~/.asn/gemini-quota.json`：以 email 為鍵、最多 20 個帳號，只存兩個額度窗（剩餘、重置時間、讀取時間）、方案、記錄時間。
//!   cwd、工作階段／對話編號、token 數、模型一律不留。
//! - 狀態列最快每 300ms 叫一次：值沒變就不寫檔（重置時間差 10 分鐘內算沒變；滿額的窗重置時間會一直往後跑）。
//!   值沒變但上次記錄已超過 5 分鐘才重寫一次，讓「多久前讀的」不會一直停在開窗那一刻。
//! 紅線：函式一律吃家目錄路徑參數；只有命令列入口與 Tauri 指令決定真實家目錄。不讀任何登入憑證、不連網、不執行外部程式。
use crate::claude_accounts::normalize_email;
use crate::claude_quota::merge::{self, Vendor};
use crate::claude_quota::{iso_secs, parse_iso_secs, quota_from_value, Parsed, Quota};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const MAX_ACCOUNTS: usize = 20;
/// 回報時最多帶幾個 Gemini 帳號（最近讀到的優先；回報總數上限 20 見 acct_remote.rs）
pub const MAX_REPORT: usize = 5;
const MAX_INPUT: usize = 1_000_000;
const FILE: &str = "gemini-quota.json";
const LOG_FILE: &str = "gemini-quota.log";
const PLAN_MAX: usize = 30;
const SAME_RESET_MS: i64 = 10 * 60_000;
const REFRESH_MS: i64 = 5 * 60_000;
const BUCKET_FIVE: &str = "gemini-5h";
const BUCKET_WEEK: &str = "gemini-weekly";

pub fn path(home: &Path) -> PathBuf {
    home.join(".asn").join(FILE)
}
pub fn log_path(home: &Path) -> PathBuf {
    home.join(".asn").join(LOG_FILE)
}

/// 一個帳號的紀錄：額度（沿用 Claude 那份 Quota 的欄位，舊的單一 reset_at 不寫）＋方案
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Entry {
    pub quota: Quota,
    pub plan: String,
}

/// 一次狀態列資料讀出來的東西
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub email: String,
    pub plan: String,
    pub parsed: Parsed,
    /// 丟掉的額度桶名（給 log 看）
    pub dropped: Vec<String>,
}

// ---------- 解析 ----------
/// agy 的 reset_time（ISO UTC，例 `2026-10-29T16:37:30Z`，可能帶小數秒）→ 毫秒
fn parse_reset_time(s: &str) -> Option<i64> {
    if let Some(ms) = parse_iso_secs(s) {
        return Some(ms);
    }
    let (head, frac) = s.strip_suffix('Z')?.split_once('.')?;
    if head.len() != 19 || frac.is_empty() || !frac.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    parse_iso_secs(&format!("{head}Z"))
}

/// 一個額度桶 → (剩餘 %, 重置毫秒)。停用的、沒有 remaining_fraction（只有數量）的、比例不在 0～1 的回 None
fn bucket(b: &Value, now_ms: i64) -> Option<(u8, Option<i64>)> {
    if b.get("disabled").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let f = b.get("remaining_fraction")?.as_f64().filter(|f| f.is_finite() && (0.0..=1.0).contains(f))?;
    let pct = (f * 100.0).round().clamp(0.0, 100.0) as u8;
    let reset = b
        .get("reset_time")
        .and_then(Value::as_str)
        .and_then(parse_reset_time)
        .or_else(|| b.get("reset_in_seconds").and_then(Value::as_f64).filter(|s| s.is_finite() && *s > 0.0).map(|s| now_ms + (s * 1000.0) as i64));
    // 重置時間已過：那個比例是重置前的舊值，不採用
    if reset.is_some_and(|r| r <= now_ms) {
        return None;
    }
    Some((pct, reset))
}

/// 給 log 看的桶名：只留可見的 ASCII、最多 40 字
fn safe_name(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_graphic()).take(40).collect()
}

pub fn clean_plan(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(PLAN_MAX).collect()
}

/// 狀態列資料 → 讀到的額度。沒有 email 或沒有 quota 就是 None（啟動前的幾筆，不當成沒額度）。
pub fn parse_statusline(text: &str, now_ms: i64) -> Option<Reading> {
    if text.len() > MAX_INPUT {
        return None;
    }
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()?;
    let email = normalize_email(v.get("email")?.as_str()?)?;
    let quota = v.get("quota")?.as_object()?;
    let mut five = None;
    let mut week = None;
    let mut dropped = vec![];
    for (name, b) in quota.iter().take(64) {
        let slot = match name.as_str() {
            BUCKET_FIVE => &mut five,
            BUCKET_WEEK => &mut week,
            _ => {
                dropped.push(safe_name(name));
                continue;
            }
        };
        match bucket(b, now_ms) {
            Some(x) => *slot = Some(x),
            None => dropped.push(safe_name(name)),
        }
    }
    let plan = v.get("plan_tier").and_then(Value::as_str).map(clean_plan).unwrap_or_default();
    Some(Reading {
        email,
        plan,
        parsed: Parsed {
            five_hour_pct: five.map(|f| f.0),
            weekly_pct: week.map(|w| w.0),
            reset_at: None,
            five_reset_ms: five.and_then(|f| f.1),
            week_reset_ms: week.and_then(|w| w.1),
        },
        dropped,
    })
}

// ---------- 讀寫 ----------
fn entry_to_value(e: &Entry) -> Value {
    let mut v = serde_json::to_value(&e.quota).unwrap_or_else(|_| json!({}));
    if let Some(o) = v.as_object_mut() {
        o.remove("reset_at");
        if !e.plan.is_empty() {
            o.insert("plan_tier".into(), json!(e.plan));
        }
    }
    v
}

/// 讀本機檔：不存在或壞掉是空的；鍵必須是已正規化的 email，每筆逐欄驗證（規則同 Claude 的額度檔）
pub fn load_all(home: &Path) -> HashMap<String, Entry> {
    let Some(Value::Object(m)) = std::fs::read_to_string(path(home)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return HashMap::new() };
    let mut out = HashMap::new();
    for (k, v) in m.into_iter().take(MAX_ACCOUNTS * 2) {
        if normalize_email(&k).as_deref() != Some(k.as_str()) {
            continue;
        }
        let Some(mut quota) = quota_from_value(&v) else { continue };
        quota.reset_at = None;
        let plan = v.get("plan_tier").and_then(Value::as_str).map(clean_plan).unwrap_or_default();
        out.insert(k, Entry { quota, plan });
        if out.len() >= MAX_ACCOUNTS {
            break;
        }
    }
    out
}

fn reset_close(a: &Option<String>, b: &Option<String>) -> bool {
    match (a.as_deref().and_then(parse_iso_secs), b.as_deref().and_then(parse_iso_secs)) {
        (None, None) => true,
        (Some(x), Some(y)) => (x - y).abs() <= SAME_RESET_MS,
        _ => false,
    }
}

/// 兩筆紀錄的「值」一樣嗎（不看讀取時間；重置時間差 10 分鐘內算一樣）
fn same_values(a: &Entry, b: &Entry) -> bool {
    a.plan == b.plan
        && a.quota.five_hour_pct == b.quota.five_hour_pct
        && a.quota.weekly_pct == b.quota.weekly_pct
        && reset_close(&a.quota.five_reset_at, &b.quota.five_reset_at)
        && reset_close(&a.quota.week_reset_at, &b.quota.week_reset_at)
}

/// 記一筆。有寫檔回 Ok(true)；沒有可收的、值沒變（且 5 分鐘內記過）回 Ok(false)，不動檔案。
/// 不收的原因與丟掉的桶寫進 `~/.asn/gemini-quota.log`（跟上一筆一樣就不重複寫）。
pub fn record(home: &Path, r: &Reading, now_ms: i64) -> Result<bool, String> {
    let mut all = load_all(home);
    let old = all.get(&r.email);
    let (merged, skipped) = merge::merge_for(Vendor::Gemini, old.map(|e| &e.quota), &r.parsed, now_ms);
    log_once(home, &r.dropped, &merge::skipped_lines(&skipped, now_ms), now_ms);
    let plan = if r.plan.is_empty() { old.map(|e| e.plan.clone()).unwrap_or_default() } else { r.plan.clone() };
    let new = match (merged, old) {
        (Some(mut q), _) => {
            q.reset_at = None;
            Entry { quota: q, plan }
        }
        // 額度都沒收、只有方案變了：方案照更新，額度留原本的
        (None, Some(o)) if o.plan != plan => Entry { quota: Quota { at: iso_secs(now_ms), ..o.quota.clone() }, plan },
        (None, _) => return Ok(false),
    };
    if let Some(o) = old {
        let fresh = parse_iso_secs(&o.quota.at).is_some_and(|at| now_ms - at < REFRESH_MS);
        if fresh && same_values(o, &new) {
            return Ok(false);
        }
    }
    all.insert(r.email.clone(), new);
    if all.len() > MAX_ACCOUNTS {
        let mut by_age: Vec<(String, String)> = all.iter().map(|(k, e)| (e.quota.at.clone(), k.clone())).collect();
        by_age.sort();
        for (_, k) in by_age.into_iter().take(all.len() - MAX_ACCOUNTS) {
            all.remove(&k);
        }
    }
    let obj: Map<String, Value> = all.iter().map(|(k, e)| (k.clone(), entry_to_value(e))).collect();
    let text = serde_json::to_string(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::claude_json::write_atomic(&path(home), text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// log 一行的內容（不含時間）；跟檔案最後一行一樣就不寫，免得每 300ms 寫一次同樣的話
fn log_once(home: &Path, dropped: &[String], skipped: &str, now_ms: i64) {
    let mut body = String::new();
    if !dropped.is_empty() {
        body.push_str(&format!("丟掉的額度桶：{}", dropped.join(", ")));
    }
    for line in skipped.lines() {
        // skipped_lines 每行開頭是時間，去掉再比
        let rest = line.split_once(' ').map(|(_, r)| r).unwrap_or(line);
        if !body.is_empty() {
            body.push_str("；");
        }
        body.push_str(rest);
    }
    if body.is_empty() {
        return;
    }
    let p = log_path(home);
    let last = std::fs::read_to_string(&p).ok().and_then(|t| t.lines().last().map(|l| l.split_once(' ').map(|(_, r)| r.to_string()).unwrap_or_default()));
    if last.as_deref() == Some(body.as_str()) {
        return;
    }
    merge::append_log(&p, &format!("{} {body}\n", iso_secs(now_ms)));
}

/// 狀態列掛鉤：解析＋記錄，回要印在狀態列的那一行。任何失敗都照樣回一行。
pub fn hook(home: &Path, input: &str, now_ms: i64) -> String {
    let Some(r) = parse_statusline(input, now_ms) else { return status_line(None) };
    let _ = record(home, &r, now_ms);
    status_line(Some(&r))
}

/// 狀態列那一行（只用 ASCII，避免終端編碼問題）：`Gemini 5h 98% | wk 30%`；還沒有額度就只有 `Gemini`
pub fn status_line(r: Option<&Reading>) -> String {
    let mut parts = vec![];
    if let Some(p) = r.map(|r| &r.parsed) {
        if let Some(v) = p.five_hour_pct {
            parts.push(format!("5h {v}%"));
        }
        if let Some(v) = p.weekly_pct {
            parts.push(format!("wk {v}%"));
        }
    }
    if parts.is_empty() {
        "Gemini".into()
    } else {
        format!("Gemini {}", parts.join(" | "))
    }
}

// ---------- 回報 ----------
/// 回報用的列：最近讀到的帳號優先，最多 MAX_REPORT 個；最近那個是「目前帳號」。
/// 額度窗格式同後台 parseWindows；重置時間已過的窗不送（那是重置前的舊值）。
pub fn report_rows(all: &HashMap<String, Entry>, now_ms: i64) -> Vec<Value> {
    let mut list: Vec<(&String, &Entry)> = all.iter().collect();
    list.sort_by(|a, b| b.1.quota.at.cmp(&a.1.quota.at).then_with(|| a.0.cmp(b.0)));
    list.into_iter()
        .take(MAX_REPORT)
        .enumerate()
        .map(|(i, (email, e))| {
            let windows: Vec<Value> = e
                .quota
                .windows()
                .into_iter()
                .filter(|w| w["resets_at"].as_str().and_then(parse_iso_secs).is_none_or(|r| r > now_ms))
                .collect();
            let mut row = json!({ "vendor": "gemini", "email": email, "plan": e.plan, "current": i == 0 });
            if !windows.is_empty() {
                row["windows"] = json!(windows);
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests;
