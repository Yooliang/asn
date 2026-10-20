//! 向各服務官方／CLI 相容端點查詢額度（逾時、不記錄 token）。

use super::catalog::{ToolDef, UsageKind};
use super::detect::{agy_oauth_paths, home};
use super::parse::{claude_from_usage_json, codex_from_usage_json, gemini_from_buckets, grok_from_billing_json};
use super::types::{AuthState, ProviderUsage, UsageWindow};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

const REQ_TIMEOUT: Duration = Duration::from_secs(8);

pub async fn enrich_provider(mut base: ProviderUsage, tool: &ToolDef) -> ProviderUsage {
    if std::env::var("IRORI_ASN_USAGE_MOCK").ok().as_deref() == Some("1") {
        return mock_provider(base);
    }
    if base.auth != AuthState::LoggedIn {
        return base;
    }
    if !base.usage_supported {
        if base.note.is_none() {
            base.note = Some("尚不支援讀取此工具的訂閱額度。".into());
        }
        return base;
    }
    let client = match reqwest::Client::builder().timeout(REQ_TIMEOUT).build() {
        Ok(c) => c,
        Err(_) => {
            base.note = Some("無法建立網路連線。".into());
            return base;
        }
    };
    let result = match tool.usage {
        UsageKind::ClaudeOAuth => fetch_claude(&client).await,
        UsageKind::CodexOAuth => fetch_codex(&client).await,
        UsageKind::AgyCodeAssist => fetch_agy(&client).await,
        UsageKind::GrokCliBilling => fetch_grok(&client).await,
        UsageKind::None | UsageKind::Unsupported => Err("尚不支援".into()),
    };
    match result {
        Ok((plan, windows, note)) => {
            base.plan = plan;
            base.windows = windows;
            if let Some(n) = note {
                base.note = Some(n);
            }
        }
        Err(e) => {
            base.note = Some(if e.is_empty() { "無法取得額度。".into() } else { e });
        }
    }
    base
}

fn mock_provider(mut base: ProviderUsage) -> ProviderUsage {
    if base.auth == AuthState::LoggedIn && base.usage_supported {
        base.windows = vec![UsageWindow {
            label: "測試".into(),
            used_percent: Some(12.0),
            remaining_percent: Some(88.0),
            reset_at: None,
            detail: None,
        }];
    }
    base
}

async fn fetch_claude(client: &reqwest::Client) -> Result<(Option<String>, Vec<UsageWindow>, Option<String>), String> {
    let token = read_claude_token()?;
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer(&token)?);
    headers.insert("anthropic-beta", HeaderValue::from_static("oauth-2025-04-20"));
    headers.insert(USER_AGENT, HeaderValue::from_static("claude-cli/2.1.0 (external)"));
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .headers(headers)
        .send()
        .await
        .map_err(|_| "連線逾時或失敗".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("登入已過期，請重新登入 Claude Code。".into());
    }
    if !resp.status().is_success() {
        return Err("無法取得 Claude 額度。".into());
    }
    let body = resp.text().await.map_err(|_| "讀取回應失敗".to_string())?;
    Ok((None, claude_from_usage_json(&body)?, None))
}

async fn fetch_codex(client: &reqwest::Client) -> Result<(Option<String>, Vec<UsageWindow>, Option<String>), String> {
    let (token, account) = read_codex_tokens()?;
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer(&token)?);
    headers.insert(USER_AGENT, HeaderValue::from_static("codex-cli"));
    if let Some(a) = account {
        headers.insert("ChatGPT-Account-Id", HeaderValue::from_str(&a).map_err(|_| "帳號代號格式異常".to_string())?);
    }
    let resp = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .headers(headers)
        .send()
        .await
        .map_err(|_| "連線逾時或失敗".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("登入已過期，請重新登入 Codex。".into());
    }
    if !resp.status().is_success() {
        return Err("無法取得 Codex 額度。".into());
    }
    let body = resp.text().await.map_err(|_| "讀取回應失敗".to_string())?;
    let (plan, w) = codex_from_usage_json(&body)?;
    Ok((plan, w, None))
}

async fn fetch_agy(client: &reqwest::Client) -> Result<(Option<String>, Vec<UsageWindow>, Option<String>), String> {
    let token = read_agy_token()?;
    let project = load_code_assist_project(client, &token).await?;
    let buckets = retrieve_user_quota(client, &token, &project).await?;
    let w = gemini_from_buckets(&buckets);
    if w.is_empty() {
        return Err("回應裡沒有配額桶。".into());
    }
    Ok((Some("Google（agy）".into()), w, None))
}

async fn load_code_assist_project(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let mut headers = auth_headers(token)?;
    let body = json!({
        "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" },
        "mode": "HEALTH_CHECK"
    });
    let resp = client
        .post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
        .headers(headers.clone())
        .json(&body)
        .send()
        .await
        .map_err(|_| "連線逾時或失敗".to_string())?;
    if !resp.status().is_success() {
        return Err("無法載入 agy 專案資訊；請在終端機執行 agy 完成 Google 登入。".into());
    }
    let v: Value = resp.json().await.map_err(|_| "回應格式無法解析".to_string())?;
    v.get("cloudaicompanionProject")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| "agy 回應缺少專案代號。".into())
}

async fn retrieve_user_quota(client: &reqwest::Client, token: &str, project: &str) -> Result<Vec<Value>, String> {
    let headers = auth_headers(token)?;
    let body = json!({ "project": project });
    let resp = client
        .post("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|_| "連線逾時或失敗".to_string())?;
    if !resp.status().is_success() {
        return Err("無法取得 agy 配額。".into());
    }
    let v: Value = resp.json().await.map_err(|_| "回應格式無法解析".to_string())?;
    Ok(v.get("buckets").and_then(Value::as_array).cloned().unwrap_or_default())
}

async fn fetch_grok(client: &reqwest::Client) -> Result<(Option<String>, Vec<UsageWindow>, Option<String>), String> {
    let token = read_grok_token()?;
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer(&token)?);
    headers.insert("X-XAI-Token-Auth", HeaderValue::from_static("xai-grok-cli"));
    headers.insert(USER_AGENT, HeaderValue::from_static("grok-cli"));
    let resp = client
        .get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
        .headers(headers.clone())
        .send()
        .await
        .map_err(|_| "連線逾時或失敗".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("登入已過期，請執行 grok login。".into());
    }
    if !resp.status().is_success() {
        return Err("無法取得 Grok 額度（CLI 計費端點可能已變更）。".into());
    }
    let body = resp.text().await.map_err(|_| "讀取回應失敗".to_string())?;
    let plan = fetch_grok_plan(client, &token).await.ok().filter(|s| !s.is_empty());
    let (w, note) = grok_from_billing_json(&body)?;
    Ok((plan, w, note))
}

async fn fetch_grok_plan(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer(token)?);
    headers.insert("X-XAI-Token-Auth", HeaderValue::from_static("xai-grok-cli"));
    let resp = client
        .get("https://cli-chat-proxy.grok.com/v1/settings")
        .headers(headers)
        .send()
        .await
        .map_err(|_| "連線失敗".to_string())?;
    let v: Value = resp.json().await.map_err(|_| "解析失敗".to_string())?;
    Ok(v.get("subscription_tier_display")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

fn bearer(token: &str) -> Result<HeaderValue, String> {
    HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "憑證格式異常".to_string())
}

fn auth_headers(token: &str) -> Result<HeaderMap, String> {
    let mut h = HeaderMap::new();
    h.insert(AUTHORIZATION, bearer(token)?);
    Ok(h)
}

fn read_claude_token() -> Result<String, String> {
    read_json_str(&home().join(".claude/.credentials.json"), &["claudeAiOauth", "accessToken"])
}

fn read_codex_tokens() -> Result<(String, Option<String>), String> {
    let path = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".codex"))
        .join("auth.json");
    let v = read_json_file(&path)?;
    let token = v
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Codex 尚未登入。".to_string())?
        .to_string();
    let account = v.pointer("/tokens/account_id").and_then(Value::as_str).map(String::from);
    Ok((token, account))
}

fn read_agy_token() -> Result<String, String> {
    for p in agy_oauth_paths() {
        if let Ok(t) = read_json_str(&p, &["access_token"]) {
            return Ok(t);
        }
        if let Ok(t) = read_json_str(&p, &["token"]) {
            return Ok(t);
        }
    }
    Err("agy 尚未登入。".into())
}

fn read_grok_token() -> Result<String, String> {
    let path = std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".grok"))
        .join("auth.json");
    let v = read_json_file(&path)?;
    if let Some(obj) = v.as_object() {
        for entry in obj.values() {
            if let Some(key) = entry.get("key").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                return Ok(key.to_string());
            }
        }
    }
    Err("Grok 尚未登入。".into())
}

fn read_json_file(path: &std::path::Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path).map_err(|_| "找不到登入資料。".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "登入資料格式無法解析。".to_string())
}

fn read_json_str(path: &std::path::Path, keys: &[&str]) -> Result<String, String> {
    let mut v = read_json_file(path)?;
    for k in keys {
        v = v.get(*k).cloned().ok_or_else(|| "登入資料不完整。".to_string())?;
    }
    v.as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| "登入資料不完整。".to_string())
}
