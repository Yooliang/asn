//! 版本紀錄：從後台公開的 `asn_site_releases` 表讀（官網的藍圖與開發日誌讀的是同一份），電腦版與手機版共用。
//! 用 anon 公開金鑰唯讀；介面的內容安全政策不放行 fetch，所以走這個指令。回傳前整理過：版本格式、日期、條列都限長，不信任資料庫給的形狀。
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::identity;

/// 網址用固定常數組：只讀這個專案的這一張公開表，不從設定、環境變數或畫面傳進來
const PROJECT_REF: &str = "etccgmkrosbzpltudlgt";
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
static CACHE: Mutex<Option<(Instant, Vec<Value>)>> = Mutex::new(None);

const MAX_ROWS: usize = 40;
const MAX_ITEMS: usize = 30;
const MAX_ITEM_CHARS: usize = 400;
/// 介面看到的錯誤一律這一句，細節只進 log
pub const UNREADABLE: &str = "暫時讀不到版本紀錄";

/// 版本只收 x.y.z 三段數字
fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()))
}

/// 日期只收 YYYY-MM-DD（資料庫的 date 欄位本來就是這個格式）；其他都當沒有
fn clean_date(v: &str) -> String {
    let ok = v.len() == 10 && v.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if ok { v.to_string() } else { String::new() }
}

/// PostgREST 回的陣列 → [{ version, date, lines }]；壞的列直接略過。順序保留（資料庫已依日期新到舊排好，前端再依版本排一次）
pub fn parse_releases(body: &Value) -> Result<Vec<Value>, String> {
    let rows = body.as_array().ok_or("回應不是陣列")?;
    let mut out = Vec::new();
    for r in rows.iter().take(MAX_ROWS) {
        let Some(version) = r.get("version").and_then(Value::as_str).filter(|v| valid_version(v)) else { continue };
        let date = clean_date(r.get("released_on").and_then(Value::as_str).unwrap_or(""));
        let lines: Vec<String> = r
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().chars().take(MAX_ITEM_CHARS).collect::<String>()).filter(|s| !s.is_empty()).take(MAX_ITEMS).collect())
            .unwrap_or_default();
        out.push(json!({ "version": version, "date": date, "lines": lines }));
    }
    Ok(out)
}

pub fn request_url() -> String {
    format!("https://{PROJECT_REF}.supabase.co/rest/v1/asn_site_releases?select=version,released_on,items&order=released_on.desc,version.desc&limit={MAX_ROWS}")
}

async fn fetch() -> Result<Vec<Value>, String> {
    let anon = identity::BUILTIN_ANON.iter().find(|(r, _)| *r == PROJECT_REF).map(|(_, k)| *k).ok_or("找不到後台的公開金鑰")?;
    let res = reqwest::Client::new()
        .get(request_url())
        .header("apikey", anon)
        .bearer_auth(anon)
        .header("accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("連線失敗：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let body: Value = res.json().await.map_err(|e| format!("回應讀不懂：{e}"))?;
    parse_releases(&body)
}

fn cached(now: Instant) -> Option<Vec<Value>> {
    let g = CACHE.lock().ok()?;
    g.as_ref().filter(|(at, _)| now.duration_since(*at) < CACHE_TTL).map(|(_, v)| v.clone())
}

/// 讀成功的那份在記憶體留 10 分鐘，重開設定頁不重抓；force（按「重試」）略過快取。失敗不進快取
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn site_releases(force: Option<bool>) -> Result<Vec<Value>, String> {
    if force != Some(true) {
        if let Some(v) = cached(Instant::now()) {
            return Ok(v);
        }
    }
    match fetch().await {
        Ok(v) => {
            if let Ok(mut g) = CACHE.lock() {
                *g = Some((Instant::now(), v.clone()));
            }
            Ok(v)
        }
        Err(e) => {
            elog!("[ASN] 版本紀錄讀取失敗：{e}");
            Err(UNREADABLE.to_string())
        }
    }
}

#[cfg(test)]
mod tests;
