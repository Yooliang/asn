//! 裝置授權登入（用戶端）：沒有畫面的主機跑 `asn-bridge login`，拿短碼，等人在已登入的 ASN 輸入短碼核准，
//! 然後把後台發的節點金鑰存進 `<ASN_HOME>/<代號>.key`（權限 600，寫完讀回比對）。後端見 supabase/functions/_shared/device_code.ts。
//!
//! 規矩：金鑰只在 [`Poll::Approved`] 裡出現一次，直接寫檔；不進 log、不印出（Debug 一律遮住金鑰與裝置碼）。
//! 本檔是核心模組（無視窗橋也要用），不得碰 tauri。
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

/// start 的結果。裝置碼是輪詢用的憑證，Debug 不印
#[derive(Clone, PartialEq, Eq)]
pub struct Started {
    pub user_code: String,
    pub device_code: String,
    /// 輪詢間隔（秒）
    pub interval: u64,
    /// 幾秒後到期
    pub expires_in: u64,
}
impl std::fmt::Debug for Started {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Started").field("user_code", &self.user_code).field("device_code", &"<不顯示>").field("interval", &self.interval).finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum Poll {
    Pending,
    Approved { id: String, key: String, bell_topic: String },
    Expired,
}
impl std::fmt::Debug for Poll {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Poll::Pending => write!(f, "Pending"),
            Poll::Expired => write!(f, "Expired"),
            Poll::Approved { id, .. } => f.debug_struct("Approved").field("id", id).field("key", &"<不顯示>").finish(),
        }
    }
}

/// 後端錯誤碼 → 給人看的話
pub fn error_text(code: &str) -> String {
    match code {
        "rate_limited" => "這個網路位址申請得太頻繁了，請一小時後再試".to_string(),
        "expired" => "短碼已經過期，請重新執行 asn-bridge login".to_string(),
        "invalid_device_code" => "後台不認得這次申請，請重新執行 asn-bridge login".to_string(),
        "internal" => "伺服器暫時有問題，請稍後再試".to_string(),
        _ => "申請沒有成功，請稍後再試".to_string(),
    }
}

/// 核准端（已登入的 ASN）的錯誤碼 → 給人看的話
pub fn approve_error_text(code: &str) -> Option<String> {
    Some(match code {
        "invalid_code" => "短碼不對，或已經過期（15 分鐘有效）。請看主機上顯示的短碼再輸入一次",
        "rate_limited" => "輸錯太多次了，請 15 分鐘後再試",
        "id_taken" => "這個節點代號已經有人用了，請換一個",
        "bad_id_prefix" => "節點代號的開頭不符合這個帳號的規則，請留空讓系統自動取，或改用帳號指定的開頭",
        "too_many" => "節點（電腦、雲端代理、無畫面主機）已達上限，請先撤銷用不到的",
        _ => return None,
    }
    .to_string())
}

/// 核准的輸入整理成要送後台的內容：短碼 8 碼（容忍小寫、空白、連字號）、名字 1～40 字不含控制字元、代號（可留空）英數 -_ 1～32 字。不合格回說明
pub fn approve_body(raw_code: &str, raw_name: &str, raw_id: &str) -> Result<Value, String> {
    let code: String = raw_code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase();
    if code.chars().count() != 8 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("請輸入主機上顯示的 8 碼短碼（例如 ABCD-2345）".into());
    }
    let name = raw_name.trim();
    let n = name.chars().count();
    if n == 0 || n > 40 || name.chars().any(|c| c.is_control()) {
        return Err("請輸入這台主機的名字（1 到 40 個字）".into());
    }
    let id = raw_id.trim();
    if !id.is_empty() && !crate::identity::valid_id(id) {
        return Err("節點代號只能用英文、數字、-、_，最多 32 個字".into());
    }
    let mut body = json!({ "user_code": format!("{}-{}", &code[..4], &code[4..]), "name": name });
    if !id.is_empty() {
        body["node_id"] = json!(id);
    }
    Ok(body)
}

async fn post(client: &reqwest::Client, url: &str, action: &str, body: Value) -> Result<(u16, Value), String> {
    let r = client
        .post(format!("{}?action={action}", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|_| "連不上後台，請檢查網路".to_string())?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|_| "讀不到後台的回應".to_string())?;
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

fn code_of(v: &Value) -> &str {
    v.get("error").and_then(Value::as_str).unwrap_or("")
}

pub async fn start(client: &reqwest::Client, url: &str) -> Result<Started, String> {
    let (status, v) = post(client, url, "device_code_start", json!({})).await?;
    if status != 200 {
        return Err(error_text(code_of(&v)));
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str, d: u64| v.get(k).and_then(Value::as_u64).unwrap_or(d);
    let st = Started { user_code: s("user_code"), device_code: s("device_code"), interval: n("interval", 5).min(30), expires_in: n("expires_in", 900) };
    if st.user_code.is_empty() || st.device_code.is_empty() {
        return Err("後台回的資料格式不對".into());
    }
    Ok(st)
}

/// 輪詢一次。太快（slow_down）當作還在等
pub async fn poll(client: &reqwest::Client, url: &str, device_code: &str) -> Result<Poll, String> {
    let (status, v) = post(client, url, "device_code_poll", json!({ "device_code": device_code })).await?;
    match status {
        200 => match v.get("status").and_then(Value::as_str) {
            Some("approved") => {
                let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let (id, key) = (s("id"), s("key"));
                if !crate::identity::valid_id(&id) || key.trim().is_empty() {
                    return Err("後台回的資料格式不對".into());
                }
                Ok(Poll::Approved { id, key, bell_topic: s("bell_topic") })
            }
            _ => Ok(Poll::Pending),
        },
        410 => Ok(Poll::Expired),
        429 if code_of(&v) == "slow_down" => Ok(Poll::Pending),
        _ => Err(error_text(code_of(&v))),
    }
}

/// 把金鑰寫到 `<dir>/<id>.key`：建檔時就是 600（不會有一瞬間別人讀得到），寫完讀回比對。
pub fn save_key(dir: &Path, id: &str, key: &str) -> Result<(), String> {
    if !crate::identity::valid_id(id) {
        return Err("節點代號格式不對".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了資料夾：{e}"))?;
    let f = dir.join(format!("{id}.key"));
    write_private(&f, key).map_err(|e| format!("金鑰存不進這台電腦：{e}"))?;
    let back = std::fs::read_to_string(&f).map_err(|e| format!("金鑰存完讀不回來：{e}"))?;
    if back.trim() != key {
        return Err("金鑰存到這台電腦後讀回不一致，請帳號擁有者重新核准一次".into());
    }
    // 這台電腦自己的節點代號：還沒有才寫（已經有就不動，同 register.mjs）
    let node_file = dir.join("node");
    if !node_file.exists() {
        std::fs::write(&node_file, id).map_err(|e| format!("存不了節點代號：{e}"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    // 檔案若已存在，mode 不會變：明確改成 600
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(text.as_bytes())?;
    f.sync_all()
}
#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    std::fs::write(path, text)
}

/// 整個流程：start → 說明 → 輪詢 → 存金鑰。成功回節點代號。`say` 輸出給人看的話（不含金鑰）。
pub async fn login(client: &reqwest::Client, url: &str, dir: &Path, say: &dyn Fn(&str)) -> Result<String, String> {
    let st = start(client, url).await?;
    say("請在已登入的 ASN（電腦版或手機版）打開「設定 → 新增無畫面主機」，輸入下面的短碼，並為這台主機取名。");
    say(&format!("短碼：{}", st.user_code));
    say(&format!("（{} 分鐘內有效；等待核准中，按 Ctrl+C 可取消）", (st.expires_in / 60).max(1)));
    let started = Instant::now();
    let deadline = Duration::from_secs(st.expires_in);
    loop {
        tokio::time::sleep(Duration::from_secs(st.interval)).await;
        if started.elapsed() > deadline + Duration::from_secs(st.interval) {
            return Err(error_text("expired"));
        }
        match poll(client, url, &st.device_code).await {
            Ok(Poll::Pending) => {}
            Ok(Poll::Expired) => return Err(error_text("expired")),
            Ok(Poll::Approved { id, key, .. }) => {
                save_key(dir, &id, &key)?;
                say(&format!("已核准：節點代號 {id}，金鑰已存進 {}（沒有顯示）。接著執行 asn-bridge run。", dir.join(format!("{id}.key")).display()));
                return Ok(id);
            }
            // 暫時連不上就繼續等，直到到期
            Err(e) if e.contains("連不上") || e.contains("讀不到") => {}
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// 本機假後端（只連 127.0.0.1）：依序回罐頭（用完後重複最後一個），記下每個請求
    fn fake_server(script: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            let mut i = 0;
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = vec![0u8; 16384];
                let n = c.read(&mut buf).unwrap_or(0);
                s2.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                let (status, body) = script[i.min(script.len() - 1)].clone();
                i += 1;
                let _ = write!(c, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }

    const START_OK: &str = r#"{"user_code":"ABCD-2345","device_code":"DEVICECODE_secret","expires_in":900,"interval":0}"#;
    const APPROVED: &str = r#"{"status":"approved","id":"t1-box","key":"SECRETKEY_once_only","bell_topic":"bell-x"}"#;

    #[tokio::test]
    async fn 開始_回短碼和裝置碼_不帶任何金鑰() {
        let (url, seen) = fake_server(vec![(200, START_OK.into())]);
        let st = start(&reqwest::Client::new(), &url).await.unwrap();
        assert_eq!((st.user_code.as_str(), st.interval, st.expires_in), ("ABCD-2345", 0, 900));
        assert!(!format!("{st:?}").contains("DEVICECODE_secret"), "Debug 不印裝置碼");
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[0].starts_with("POST /relay?action=device_code_start"));
        let low = reqs[0].to_lowercase();
        assert!(!low.contains("x-relay-key") && !low.contains("authorization"), "開始時沒有任何憑證");
    }

    #[tokio::test]
    async fn 開始_頻率限制與格式錯誤() {
        let (u, _) = fake_server(vec![(429, r#"{"error":"rate_limited"}"#.into())]);
        assert!(start(&reqwest::Client::new(), &u).await.unwrap_err().contains("頻繁"));
        let (u, _) = fake_server(vec![(200, r#"{"user_code":""}"#.into())]);
        assert!(start(&reqwest::Client::new(), &u).await.unwrap_err().contains("格式不對"));
    }

    #[tokio::test]
    async fn 輪詢_各種狀態() {
        let c = reqwest::Client::new();
        let (u, seen) = fake_server(vec![(200, r#"{"status":"pending","interval":5}"#.into())]);
        assert_eq!(poll(&c, &u, "DEVICECODE_secret").await.unwrap(), Poll::Pending);
        assert!(seen.lock().unwrap()[0].contains(r#""device_code":"DEVICECODE_secret""#));
        let (u, _) = fake_server(vec![(429, r#"{"error":"slow_down"}"#.into())]);
        assert_eq!(poll(&c, &u, "x").await.unwrap(), Poll::Pending, "太快當作還在等");
        let (u, _) = fake_server(vec![(410, r#"{"error":"expired"}"#.into())]);
        assert_eq!(poll(&c, &u, "x").await.unwrap(), Poll::Expired);
        let (u, _) = fake_server(vec![(404, r#"{"error":"invalid_device_code"}"#.into())]);
        assert!(poll(&c, &u, "x").await.unwrap_err().contains("不認得"));
        let (u, _) = fake_server(vec![(200, APPROVED.into())]);
        let p = poll(&c, &u, "x").await.unwrap();
        assert_eq!(p, Poll::Approved { id: "t1-box".into(), key: "SECRETKEY_once_only".into(), bell_topic: "bell-x".into() });
        assert!(!format!("{p:?}").contains("SECRETKEY_once_only"), "Debug 不印金鑰");
        // 代號格式不對或沒金鑰＝不當成成功
        let (u, _) = fake_server(vec![(200, r#"{"status":"approved","id":"../x","key":"K"}"#.into())]);
        assert!(poll(&c, &u, "x").await.is_err());
        let (u, _) = fake_server(vec![(200, r#"{"status":"approved","id":"ok","key":" "}"#.into())]);
        assert!(poll(&c, &u, "x").await.is_err());
    }

    #[test]
    fn 存金鑰_讀回一致_權限_600_並寫節點代號() {
        let d = tempfile::tempdir().unwrap();
        save_key(d.path(), "t1-box", "SECRETKEY_once_only").unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("t1-box.key")).unwrap(), "SECRETKEY_once_only");
        assert_eq!(std::fs::read_to_string(d.path().join("node")).unwrap(), "t1-box");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.path().join("t1-box.key")).unwrap().permissions().mode() & 0o777, 0o600);
            // 檔案已存在且權限寬鬆：寫完仍是 600
            std::fs::set_permissions(d.path().join("t1-box.key"), std::fs::Permissions::from_mode(0o644)).unwrap();
            save_key(d.path(), "t1-box", "SECRETKEY_two").unwrap();
            assert_eq!(std::fs::metadata(d.path().join("t1-box.key")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // 已有節點代號就不動
        save_key(d.path(), "other", "K2").unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("node")).unwrap(), "t1-box");
        assert!(save_key(d.path(), "../evil", "K").is_err());
        assert!(!d.path().join("../evil.key").exists());
    }

    #[tokio::test]
    async fn 整個流程_等待後核准_金鑰只進檔案不進輸出() {
        let (url, seen) = fake_server(vec![
            (200, START_OK.into()),
            (200, r#"{"status":"pending","interval":5}"#.into()),
            (200, r#"{"status":"pending","interval":5}"#.into()),
            (200, APPROVED.into()),
        ]);
        let d = tempfile::tempdir().unwrap();
        let said = Mutex::new(String::new());
        let id = login(&reqwest::Client::new(), &url, d.path(), &|m| said.lock().unwrap().push_str(&format!("{m}\n"))).await.unwrap();
        assert_eq!(id, "t1-box");
        assert_eq!(std::fs::read_to_string(d.path().join("t1-box.key")).unwrap(), "SECRETKEY_once_only");
        let out = said.lock().unwrap().clone();
        assert!(out.contains("ABCD-2345") && out.contains("t1-box"), "{out}");
        assert!(!out.contains("SECRETKEY_once_only") && !out.contains("DEVICECODE_secret"), "輸出不含金鑰與裝置碼");
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn 整個流程_過期不寫任何檔() {
        let (url, _) = fake_server(vec![(200, START_OK.into()), (410, r#"{"error":"expired"}"#.into())]);
        let d = tempfile::tempdir().unwrap();
        let e = login(&reqwest::Client::new(), &url, d.path(), &|_| {}).await.unwrap_err();
        assert!(e.contains("過期"), "{e}");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    }

    #[test]
    fn 核准輸入整理() {
        let b = approve_body(" abcd 2345 ", " 盒子 ", "").unwrap();
        assert_eq!(b, json!({ "user_code": "ABCD-2345", "name": "盒子" }), "代號留空就不送 node_id");
        assert_eq!(approve_body("abcd-2345", "x", " t1-box ").unwrap()["node_id"], "t1-box");
        assert!(approve_body("ABC", "x", "").unwrap_err().contains("8 碼"));
        assert!(approve_body("ABCD-23!5", "x", "").is_err());
        assert!(approve_body("ABCD-2345", "  ", "").unwrap_err().contains("名字"));
        assert!(approve_body("ABCD-2345", &"字".repeat(41), "").is_err());
        assert!(approve_body("ABCD-2345", "x", "bad id").unwrap_err().contains("節點代號"));
        for c in ["invalid_code", "rate_limited", "id_taken", "bad_id_prefix", "too_many"] {
            assert!(approve_error_text(c).is_some(), "{c}");
        }
        assert!(approve_error_text("unauthorized").is_none(), "其餘沿用帳號動作的說法");
    }

    #[test]
    fn 守門_不印金鑰() {
        let src = include_str!("device_login.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap()];
        for banned in [["print", "ln!"].concat(), ["e", "println!"].concat(), ["log", "::"].concat(), ["tracing", "::"].concat()] {
            assert!(!prod.contains(&banned), "device_login.rs 不該出現 {banned}（輸出一律走傳進來的 say，且不含金鑰）");
        }
        assert!(prod.contains(r#"field("key", &"<不顯示>")"#));
    }
}
