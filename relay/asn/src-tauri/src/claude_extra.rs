//! Claude 額外帳號（todo-next-193）：讀使用者另外登入在專用資料夾的帳號額度，可選擇快到期時自動換新。兩個開關都預設關閉。
//!
//! 紅線：
//! - 只碰專用資料夾底下的子資料夾。平常使用的登入資料夾永遠不碰；指到別處的連結一律跳過。
//! - 同一個帳號只能有一支程式在換新，否則會互相作廢。這裡不偵測，靠切換順序：先停別的，才開這個開關。
//! - 換新走的是非公開的登入流程，可能隨時失效。失效就顯示要重新登入，不補 0。
//! - 寫回用暫存檔加改名，失敗時舊檔還在。任何換新失敗都停止，記下當時憑證檔的修改時間；重開 ASN 也不再試，
//!   要等憑證檔變了（重新登入）或使用者重新打開開關。
//! - 權杖與對方回應內容不進 log、不進回報，回報只有 email 與數字。
use crate::claude_accounts::normalize_email;
use crate::quota_readers::{client, get_json, iso_or_none, window, Failure};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const ROOT: &str = ".claude-quota";
const CREDENTIALS: &str = ".credentials.json";
const STOPS: &str = "claude-extra-stops.json";
const OAUTH_KEY: &str = "claudeAiOauth";
/// 剩不到這麼久就換新；讀取器每 10 分鐘一輪，要留得下一輪的餘裕
const REFRESH_MARGIN_MS: i64 = 15 * 60_000;
/// 最多讀幾個資料夾（回報總筆數有上限）
pub const MAX_DIRS: usize = 5;
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const BETA: &str = "oauth-2025-04-20";

fn root(home: &Path) -> PathBuf {
    home.join(ROOT)
}

/// 專用資料夾底下有登入資料的子資料夾（依名稱排序）。連結、指到外面的、憑證檔本身是連結的都不算。
pub fn dirs(home: &Path) -> Vec<(String, PathBuf)> {
    let base = root(home);
    let Ok(real_base) = std::fs::canonicalize(&base) else { return vec![] };
    let Ok(rd) = std::fs::read_dir(&base) else { return vec![] };
    let mut out: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let path = e.path();
            if !std::fs::symlink_metadata(&path).ok()?.is_dir() {
                return None;
            }
            if !std::fs::canonicalize(&path).ok()?.starts_with(&real_base) {
                return None;
            }
            std::fs::symlink_metadata(path.join(CREDENTIALS)).ok()?.is_file().then_some((name, path))
        })
        .collect();
    out.sort();
    out.truncate(MAX_DIRS);
    out
}

pub fn modified_ms(dir: &Path) -> Option<i64> {
    let t = std::fs::metadata(dir.join(CREDENTIALS)).ok()?.modified().ok()?;
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

// ---------- 換新失敗的記號：跨重開也算數 ----------
fn stops_path(home: &Path) -> PathBuf {
    home.join(".asn").join(STOPS)
}
fn load_stops(home: &Path) -> HashMap<String, i64> {
    std::fs::read_to_string(stops_path(home)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
pub fn is_stopped(home: &Path, name: &str, mark: Option<i64>) -> bool {
    mark.is_some() && load_stops(home).get(name).copied() == mark
}
fn add_stop(home: &Path, name: &str, mark: Option<i64>) {
    let Some(mark) = mark else { return };
    let mut all = load_stops(home);
    all.insert(name.to_string(), mark);
    if let Some(p) = stops_path(home).parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let _ = std::fs::write(stops_path(home), json!(all).to_string());
}
/// 使用者重新打開開關時清掉，下一輪才會再試
pub fn clear_stops(home: &Path) {
    let _ = std::fs::remove_file(stops_path(home));
}

// ---------- 判斷與解析：純函式 ----------
#[derive(Debug, PartialEq)]
pub enum Step {
    Read,
    Refresh,
    Expired,
}

/// 這一輪要做什麼。換新只在開關開著、又有 refresh token 時才做；到期時間讀不出來當成不能用。
pub fn plan(oauth: &Value, now_ms: i64, may_refresh: bool) -> Step {
    let expires = oauth["expiresAt"].as_i64().unwrap_or(0);
    let has_token = oauth["accessToken"].as_str().is_some_and(|t| !t.is_empty());
    let has_refresh = oauth["refreshToken"].as_str().is_some_and(|t| !t.is_empty());
    if has_token && expires - now_ms >= REFRESH_MARGIN_MS {
        return Step::Read;
    }
    if may_refresh && has_refresh {
        return Step::Refresh;
    }
    if has_token && expires > now_ms {
        Step::Read
    } else {
        Step::Expired
    }
}

/// 換新回應 → 新的憑證檔內容：只換三個欄位，其他欄位原樣留著。回應不齊回 None，舊檔不動。
pub fn merged(raw: &Value, got: &Value, now_ms: i64) -> Option<Value> {
    let access = got["access_token"].as_str().filter(|s| !s.is_empty())?;
    let seconds = got["expires_in"].as_i64().filter(|s| *s > 0)?;
    let old = raw.get(OAUTH_KEY)?;
    let refresh = got["refresh_token"].as_str().filter(|s| !s.is_empty()).or_else(|| old["refreshToken"].as_str())?;
    let mut out = raw.clone();
    let o = out.get_mut(OAUTH_KEY)?.as_object_mut()?;
    o.insert("accessToken".into(), json!(access));
    o.insert("refreshToken".into(), json!(refresh));
    o.insert("expiresAt".into(), json!(now_ms + seconds * 1000));
    Some(out)
}

/// 先寫同資料夾的暫存檔再改名：任何一步失敗，舊檔都還在，暫存檔也清掉。
pub fn write_atomic(path: &Path, value: &Value) -> Result<(), ()> {
    use std::io::Write;
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let done = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(value.to_string().as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(());
    }
    Ok(())
}

/// 重置時間可能帶小數秒與 +00:00；不是 UTC 的不猜
fn reset_iso(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let z = s.strip_suffix("+00:00").map(|h| format!("{h}Z")).unwrap_or_else(|| s.to_string());
    iso_or_none(Some(&z))
}

/// 用量回應 → 窗。回應是已用 %，轉成剩餘；缺值不產生窗。
pub fn parse_usage(v: &Value, now_ms: i64) -> Vec<Value> {
    let mut out = vec![];
    for (key, name) in [("five_hour", "five_hour"), ("seven_day", "weekly")] {
        let block = &v[key];
        let Some(used) = block["utilization"].as_f64() else { continue };
        out.extend(window(name, 100.0 - used, reset_iso(&block["resets_at"]), now_ms));
    }
    out
}

// ---------- 連網 ----------
fn fail(text: &str) -> Failure {
    Failure::Other(text.into())
}

async fn refresh(home: &Path, name: &str, path: &Path, raw: &Value, mark: Option<i64>, now_ms: i64) -> Result<Value, Failure> {
    let stop = |_: ()| {
        add_stop(home, name, mark);
        Failure::Auth
    };
    let token = raw[OAUTH_KEY]["refreshToken"].as_str().unwrap_or_default();
    let body = json!({ "grant_type": "refresh_token", "refresh_token": token, "client_id": CLIENT_ID });
    let req = client()?.post(TOKEN_URL).json(&body).header("user-agent", "asn-quota-reader");
    let got = get_json(req).await.map_err(|_| stop(()))?;
    let new = merged(raw, &got, now_ms).ok_or(()).map_err(stop)?;
    write_atomic(path, &new).map_err(stop)?;
    Ok(new[OAUTH_KEY].clone())
}

/// 讀一個資料夾：回 (email, 窗)。
pub async fn read_dir(home: &Path, name: &str, dir: &Path, may_refresh: bool, now_ms: i64) -> Result<(String, Vec<Value>), Failure> {
    let path = dir.join(CREDENTIALS);
    let raw: Value = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or(Failure::Auth)?;
    let mark = modified_ms(dir);
    let may = may_refresh && !is_stopped(home, name, mark);
    let oauth = match plan(&raw[OAUTH_KEY], now_ms, may) {
        Step::Expired => return Err(Failure::Auth),
        Step::Read => raw[OAUTH_KEY].clone(),
        Step::Refresh => refresh(home, name, &path, &raw, mark, now_ms).await?,
    };
    let token = oauth["accessToken"].as_str().ok_or(Failure::Auth)?;
    let get = |url: &'static str| -> Result<reqwest::RequestBuilder, Failure> { Ok(client()?.get(url).bearer_auth(token).header("anthropic-beta", BETA).header("user-agent", "asn-quota-reader")) };
    let profile = get_json(get(PROFILE_URL)?).await?;
    let email = profile["account"]["email"].as_str().and_then(normalize_email).ok_or(fail("查不到帳號"))?;
    let usage = get_json(get(USAGE_URL)?).await?;
    Ok((email, parse_usage(&usage, now_ms)))
}

#[cfg(test)]
mod tests;
