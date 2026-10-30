//! 邀請雲端代理（issue #13）：設定頁替雲端代理建立節點、列出自己邀請過的雲端代理、撤銷。
//! 三個動作都用登入憑證（Authorization，只在 Rust 端）呼叫後台的 cloud_node_create／cloud_node_list／cloud_node_revoke；
//! 節點金鑰拿不到登入憑證，所以 AI 視窗與雲端代理自己都做不了這幾件事。
//!
//! 金鑰規矩：新金鑰只在 cloud_node_create 的回應裡出現一次，這裡原樣交給前端顯示一次（前端關掉就丟掉）；
//! 本檔不寫檔、不寫 log、不快取（守門測試會檢查）。給代理看的說明文字（invite_text）不含金鑰。
use crate::account::{self, CallErr};
use crate::auth::AuthState;
use crate::App;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

/// 給代理讀的技能說明網址（公開、不含機密；官網 site/public/skill/asn-cloud-agent.md）
pub const SKILL_URL: &str = "https://asnmessenger.web.app/skill/asn-cloud-agent.md";

/// 建立結果。key 只出現這一次；Debug 不印金鑰（避免有人不小心把整個結構印進 log）
#[derive(Serialize)]
pub struct Created {
    pub id: String,
    pub name: String,
    pub key: String,
    /// 要貼給代理的說明（只有公開資訊：技能說明網址、節點代號、後端網址、名字）
    pub invite: String,
}
impl std::fmt::Debug for Created {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Created").field("id", &self.id).field("name", &self.name).field("key", &"<不顯示>").finish()
    }
}

/// 名稱：去掉前後空白，1～40 字、不含控制字元。不合格回 None
pub fn clean_name(raw: &str) -> Option<String> {
    let s = raw.trim();
    let n = s.chars().count();
    if n == 0 || n > 40 || s.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(s.to_string())
}

/// 要貼給代理的說明。**不含金鑰**：金鑰由人另外設成代理平台的秘密環境變數 ASN_RELAY_KEY。
pub fn invite_text(skill_url: &str, id: &str, relay_url: &str, name: &str) -> String {
    format!(
        "請閱讀並照著做：{skill_url}\n你的節點代號：{id}\nASN 後端網址：{relay_url}\n你在好友名單上的名字：{name}\n金鑰是環境變數 ASN_RELAY_KEY，你看不到也不要嘗試印出或寫進任何檔案。\n照說明建立收信、寄信、看門與開機自動啟動，完成後回報我。"
    )
}

/// 後台錯誤碼 → 給人看的話（先看雲端代理專屬的，其餘沿用帳號動作的）
pub fn error_text(code: &str) -> String {
    match code {
        "too_many" => "雲端代理（或電腦）的數量已達上限，請先撤銷用不到的".to_string(),
        "not_found" => "找不到這個雲端代理（可能已經撤銷了）".to_string(),
        _ => crate::device_login::approve_error_text(code).unwrap_or_else(|| account::error_text(code)),
    }
}
fn err(e: CallErr) -> String {
    if e.code.is_empty() { e.text } else { error_text(&e.code) }
}

pub async fn create(client: &reqwest::Client, relay_url: &str, token: &str, raw_name: &str) -> Result<Created, String> {
    let name = clean_name(raw_name).ok_or("請輸入代理的名字（1 到 40 個字）")?;
    let v = account::call(client, relay_url, token, "cloud_node_create", None, json!({ "name": name })).await.map_err(err)?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (id, key) = (s("id"), s("key"));
    if id.is_empty() || key.trim().is_empty() {
        return Err("後台回的資料格式不對".into());
    }
    let shown = if s("name").is_empty() { name } else { s("name") };
    Ok(Created { invite: invite_text(SKILL_URL, &id, relay_url, &shown), id, name: shown, key })
}

/// 已加入的雲端代理 → [{ id, name, last_seen_at, online }]（後台已排除金鑰；這裡再只挑出會顯示的欄位）
pub async fn list(client: &reqwest::Client, relay_url: &str, token: &str) -> Result<Value, String> {
    let v = account::call(client, relay_url, token, "cloud_node_list", None, json!({})).await.map_err(err)?;
    let rows: Vec<Value> = v.get("nodes").and_then(Value::as_array).map(|a| {
        a.iter().filter_map(|n| {
            let id = n.get("id").and_then(Value::as_str)?;
            Some(json!({
                "id": id,
                "name": n.get("name").and_then(Value::as_str).unwrap_or(""),
                "last_seen_at": n.get("last_seen_at").cloned().unwrap_or(Value::Null),
                "online": n.get("online").and_then(Value::as_bool).unwrap_or(false),
            }))
        }).collect()
    }).unwrap_or_default();
    Ok(json!({ "nodes": rows }))
}

pub async fn revoke(client: &reqwest::Client, relay_url: &str, token: &str, node: &str) -> Result<(), String> {
    if node.is_empty() || node.len() > 32 || !node.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("代理資料不對".into());
    }
    account::call(client, relay_url, token, "cloud_node_revoke", None, json!({ "node": node })).await.map(|_| ()).map_err(err)
}

/// 核准無畫面主機的短碼（主機上跑 asn-bridge login 會印出短碼）。用登入憑證呼叫 device_code_approve；
/// 金鑰不經過這裡——主機自己輪詢拿，所以回傳只有節點代號與名字。
pub async fn approve_device(client: &reqwest::Client, relay_url: &str, token: &str, code: &str, name: &str, node_id: &str) -> Result<Value, String> {
    let body = crate::device_login::approve_body(code, name, node_id)?;
    let v = account::call(client, relay_url, token, "device_code_approve", None, body).await.map_err(err)?;
    let id = v.get("id").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() {
        return Err("後台回的資料格式不對".into());
    }
    Ok(json!({ "id": id, "name": v.get("name").and_then(Value::as_str).unwrap_or("") }))
}

// ---------- 指令 ----------

fn no_shot(app: &App) -> Result<(), String> {
    if app.shot.is_some() { Err("--shot 模式不連後台".into()) } else { Ok(()) }
}

/// 建立雲端代理。→ { id, name, key, invite }；key 只這一次
#[tauri::command]
pub async fn cloud_agent_create(app: State<'_, App>, auth: State<'_, AuthState>, name: String) -> Result<Created, String> {
    no_shot(&app)?;
    let c = account::ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    create(&c.client, &c.relay_url, &token, &name).await
}

/// 核准無畫面主機的短碼。→ { id, name }
#[tauri::command]
pub async fn cloud_agent_approve(app: State<'_, App>, auth: State<'_, AuthState>, code: String, name: String, node_id: Option<String>) -> Result<Value, String> {
    no_shot(&app)?;
    let c = account::ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    approve_device(&c.client, &c.relay_url, &token, &code, &name, node_id.as_deref().unwrap_or("")).await
}

/// 已加入的雲端代理。沒登入、--shot 模式回空清單（不報錯）
#[tauri::command]
pub async fn cloud_agent_list(app: State<'_, App>, auth: State<'_, AuthState>) -> Result<Value, String> {
    if app.shot.is_some() || !auth.status().signed_in {
        return Ok(json!({ "nodes": [] }));
    }
    let c = account::ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    list(&c.client, &c.relay_url, &token).await
}

/// 撤銷：金鑰立刻失效、從好友名單消失
#[tauri::command]
pub async fn cloud_agent_revoke(app: State<'_, App>, auth: State<'_, AuthState>, node: String) -> Result<(), String> {
    no_shot(&app)?;
    let c = account::ctx()?;
    let token = auth.access_token(&c.client, &c.auth_base, &c.anon).await?;
    revoke(&c.client, &c.relay_url, &token, &node).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// 本機假後端（只連 127.0.0.1）：記下每個請求，依動作名回罐頭
    fn fake_server(status: u16, body: String) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = vec![0u8; 16384];
                let n = c.read(&mut buf).unwrap_or(0);
                s2.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = write!(c, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }

    #[test]
    fn 名稱清理() {
        assert_eq!(clean_name("  小真 ").as_deref(), Some("小真"));
        assert_eq!(clean_name(""), None);
        assert_eq!(clean_name("   "), None);
        assert_eq!(clean_name("a\nb"), None);
        assert_eq!(clean_name(&"字".repeat(40)).map(|s| s.chars().count()), Some(40));
        assert_eq!(clean_name(&"字".repeat(41)), None);
    }

    #[test]
    fn 給代理的說明只有公開資訊_沒有金鑰() {
        let t = invite_text(SKILL_URL, "t5-abcd1234", "https://x.supabase.co/functions/v1/relay", "小真");
        for w in [SKILL_URL, "t5-abcd1234", "https://x.supabase.co/functions/v1/relay", "小真", "ASN_RELAY_KEY"] {
            assert!(t.contains(w), "少了 {w}");
        }
        assert!(t.contains("看不到也不要嘗試印出"));
        assert!(!t.contains("eyJ"), "不放任何憑證樣子的字串");
    }

    #[tokio::test]
    async fn 建立_用登入憑證呼叫_金鑰只在結果裡_說明不含金鑰() {
        let (url, seen) = fake_server(200, r#"{"id":"t5-abcd1234","name":"小真","key":"SECRETKEY_once_only"}"#.into());
        let c = reqwest::Client::new();
        let r = create(&c, &url, "user-access-token-123", "  小真 ").await.unwrap();
        assert_eq!((r.id.as_str(), r.name.as_str(), r.key.as_str()), ("t5-abcd1234", "小真", "SECRETKEY_once_only"));
        assert!(!r.invite.contains("SECRETKEY_once_only") && r.invite.contains("t5-abcd1234") && r.invite.contains(&url));
        assert!(!format!("{r:?}").contains("SECRETKEY_once_only"), "Debug 不印金鑰");
        let reqs = seen.lock().unwrap().clone();
        assert_eq!(reqs.len(), 1);
        let low = reqs[0].to_lowercase();
        assert!(reqs[0].starts_with("POST /relay?action=cloud_node_create"));
        assert!(low.contains("authorization: bearer user-access-token-123"), "{low}");
        assert!(reqs[0].contains(r#""name":"小真""#));
        assert!(!low.contains("x-relay-key"), "不帶任何節點金鑰");
    }

    #[tokio::test]
    async fn 建立_名稱不合格不連後台_後台缺金鑰或失敗都不回成功() {
        let (url, seen) = fake_server(200, r#"{"id":"t5-abcd1234","name":"a","key":""}"#.into());
        let c = reqwest::Client::new();
        assert!(create(&c, &url, "tok", "  ").await.unwrap_err().contains("名字"));
        assert!(seen.lock().unwrap().is_empty(), "名稱不合格就不送出");
        assert!(create(&c, &url, "tok", "a").await.unwrap_err().contains("格式不對"), "沒給金鑰＝不當成成功");
        let (u401, _) = fake_server(401, r#"{"error":"unauthorized"}"#.into());
        assert!(create(&c, &u401, "tok", "a").await.unwrap_err().contains("重新登入"));
        let (u429, _) = fake_server(429, r#"{"error":"too_many"}"#.into());
        assert!(create(&c, &u429, "tok", "a").await.unwrap_err().contains("上限"));
    }

    #[tokio::test]
    async fn 列出_只留顯示用欄位_撤銷_檢查代號格式() {
        let (url, seen) = fake_server(200, r#"{"nodes":[{"id":"t5-a","name":"小真","last_seen_at":null,"online":false,"key_hash":"LEAK","bell_topic":"LEAK"},{"name":"沒有代號"}]}"#.into());
        let c = reqwest::Client::new();
        let v = list(&c, &url, "tok").await.unwrap();
        assert_eq!(v, json!({ "nodes": [{ "id": "t5-a", "name": "小真", "last_seen_at": null, "online": false }] }));
        assert!(!v.to_string().contains("LEAK"));
        assert!(seen.lock().unwrap()[0].starts_with("POST /relay?action=cloud_node_list"));

        let (url, seen) = fake_server(200, r#"{"ok":true}"#.into());
        revoke(&c, &url, "tok", "t5-a").await.unwrap();
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[0].starts_with("POST /relay?action=cloud_node_revoke") && reqs[0].contains(r#""node":"t5-a""#));
        for bad in ["", "a b", "../x", &"x".repeat(33)] {
            assert!(revoke(&c, &url, "tok", bad).await.is_err(), "{bad}");
        }
        assert_eq!(seen.lock().unwrap().len(), 1, "代號不合格就不送出");
        let (nf, _) = fake_server(404, r#"{"error":"not_found"}"#.into());
        assert!(revoke(&c, &nf, "tok", "t5-a").await.unwrap_err().contains("已經撤銷"));
    }

    #[test]
    fn 守門_金鑰不寫檔不寫log不快取() {
        let src = include_str!("cloud_invite.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap()];
        // 用拼接避免這個檢查把自己的字串當成命中
        for banned in [["std::", "fs"].concat(), ["write", "_atomic"].concat(), ["print", "ln!"].concat(), ["e", "println!"].concat(), ["e", "log!"].concat(), ["o", "log!"].concat(), ["log", "::"].concat(), ["tracing", "::"].concat(), ["static ", "mut"].concat(), ["lazy", "_static"].concat(), ["OnceLock"].concat(), ["store", "_save"].concat()] {
            assert!(!prod.contains(&banned), "cloud_invite.rs 不該出現 {banned}（金鑰不寫檔、不寫 log、不快取）");
        }
        assert!(prod.contains(r#"field("key", &"<不顯示>")"#), "Debug 要遮住金鑰");
    }
}
