//! 「上次登入」的記憶：ASN 資料夾裡的 last-login.json，只放登入方式與頭像（data URL），不放任何權杖或 email。
//! 登入成功時寫入；登出時保留（它就是「上次登入」的記憶）。登入畫面用它顯示頭像與「上次使用」標籤。
//! 頭像：名單視窗設定的這台大頭貼（custom_avatar）優先，沒有就用登入帳號的頭像（account_avatar，登入時下載存成本機小圖）。
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE: &str = "last-login.json";
/// 頭像圖檔大小上限（位元組）：太大的不存
pub const MAX_AVATAR_BYTES: usize = 150_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastLogin {
    pub provider: String,
    #[serde(default)]
    pub account_avatar: Option<String>,
    #[serde(default)]
    pub custom_avatar: Option<String>,
}

/// 給前端的樣子：只有登入方式與要顯示的頭像
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastLoginView {
    pub provider: String,
    pub avatar: Option<String>,
}

/// 只收 png／jpeg／webp／gif 的 base64 data URL，而且不能太大
pub fn valid_data_url(s: &str) -> bool {
    let ok_head = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"].iter().any(|h| s.starts_with(h));
    ok_head && s.len() <= MAX_AVATAR_BYTES * 4 / 3 + 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b';' | b',' | b'/' | b'+' | b'=' | b'-'))
}

pub fn load(dir: &Path) -> Option<LastLogin> {
    let v: LastLogin = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).ok()?).ok()?;
    if !crate::auth::provider_ok(&v.provider) {
        return None;
    }
    // 檔案被改壞的頭像一律不採用
    Some(LastLogin {
        provider: v.provider,
        account_avatar: v.account_avatar.filter(|a| valid_data_url(a)),
        custom_avatar: v.custom_avatar.filter(|a| valid_data_url(a)),
    })
}

pub fn view(dir: &Path) -> Option<LastLoginView> {
    let l = load(dir)?;
    Some(LastLoginView { provider: l.provider, avatar: l.custom_avatar.or(l.account_avatar) })
}

fn write(dir: &Path, l: &LastLogin) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    let text = serde_json::to_string(l).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("寫入失敗：{e}"))?;
    std::fs::rename(&tmp, dir.join(FILE)).map_err(|e| format!("寫入失敗：{e}"))
}

/// 登入成功：記下登入方式與帳號頭像；之前記的「這台大頭貼」保留
pub fn save_login(dir: &Path, provider: &str, account_avatar: Option<String>) -> Result<(), String> {
    if !crate::auth::provider_ok(provider) {
        return Err("不支援這種登入方式".into());
    }
    let custom = load(dir).and_then(|l| l.custom_avatar);
    write(dir, &LastLogin { provider: provider.to_string(), account_avatar: account_avatar.filter(|a| valid_data_url(a)), custom_avatar: custom })
}

/// 名單視窗的這台大頭貼有變：更新（None＝清掉）。還沒有上次登入的記錄就不動
pub fn set_custom_avatar(dir: &Path, avatar: Option<String>) -> Result<(), String> {
    let Some(mut l) = load(dir) else { return Ok(()) };
    if let Some(a) = &avatar {
        if !valid_data_url(a) {
            return Err("不是有效的圖片".into());
        }
    }
    if l.custom_avatar == avatar {
        return Ok(());
    }
    l.custom_avatar = avatar;
    write(dir, &l)
}

/// 下載帳號頭像存成 data URL（只收 https、5 秒、大小與格式有上限）；任何失敗都回 None，不擋登入
pub async fn fetch_avatar(client: &reqwest::Client, url: &str) -> Option<String> {
    if !url.starts_with("https://") {
        return None;
    }
    let resp = client.get(url).timeout(std::time::Duration::from_secs(5)).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mime = resp.headers().get(reqwest::header::CONTENT_TYPE)?.to_str().ok()?.split(';').next()?.trim().to_ascii_lowercase();
    if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime.as_str()) {
        return None;
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_AVATAR_BYTES) {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIC: &str = "data:image/png;base64,iVBORw0KGgo=";

    #[test]
    fn 沒有檔案或壞檔就是沒有上次登入() {
        let d = tempfile::tempdir().unwrap();
        assert!(view(d.path()).is_none());
        std::fs::write(d.path().join(FILE), "不是 json").unwrap();
        assert!(view(d.path()).is_none());
        std::fs::write(d.path().join(FILE), r#"{"provider":"facebook"}"#).unwrap();
        assert!(view(d.path()).is_none(), "不認得的登入方式不採用");
    }

    #[test]
    fn 存了就讀得到_只有登入方式與頭像() {
        let d = tempfile::tempdir().unwrap();
        save_login(d.path(), "google", Some(PIC.into())).unwrap();
        assert_eq!(view(d.path()), Some(LastLoginView { provider: "google".into(), avatar: Some(PIC.into()) }));
        let text = std::fs::read_to_string(d.path().join(FILE)).unwrap();
        assert!(!text.contains("token") && !text.contains('@'), "檔案裡不放權杖或 email：{text}");
    }

    #[test]
    fn 這台大頭貼優先_換登入方式時保留() {
        let d = tempfile::tempdir().unwrap();
        let mine = "data:image/jpeg;base64,/9j/4AAQ";
        save_login(d.path(), "google", Some(PIC.into())).unwrap();
        set_custom_avatar(d.path(), Some(mine.into())).unwrap();
        assert_eq!(view(d.path()).unwrap().avatar.as_deref(), Some(mine));
        save_login(d.path(), "github", None).unwrap();
        let v = view(d.path()).unwrap();
        assert_eq!((v.provider.as_str(), v.avatar.as_deref()), ("github", Some(mine)));
        set_custom_avatar(d.path(), None).unwrap();
        assert_eq!(view(d.path()).unwrap().avatar, None, "清掉大頭貼後帳號頭像（這次沒有）");
    }

    #[test]
    fn 沒登入過就不建檔_壞圖不收() {
        let d = tempfile::tempdir().unwrap();
        set_custom_avatar(d.path(), Some(PIC.into())).unwrap();
        assert!(!d.path().join(FILE).exists());
        save_login(d.path(), "github", Some("https://evil/x.png".into())).unwrap();
        assert_eq!(view(d.path()).unwrap().avatar, None, "不是 data URL 的頭像不存");
        assert!(set_custom_avatar(d.path(), Some("data:text/html;base64,AAAA".into())).is_err());
        assert!(save_login(d.path(), "facebook", None).is_err());
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_AVATAR_BYTES * 2));
        assert!(!valid_data_url(&huge));
    }

    #[test]
    fn 登出保留這個檔案() {
        // 守門：登出指令與 sign_out 都不碰 last-login
        let acct = include_str!("account.rs");
        let a = acct.find("pub async fn auth_logout").unwrap();
        let body = &acct[a..a + 900];
        assert!(!body.contains("lastlogin") && !body.contains("last-login"));
        let au = include_str!("auth.rs");
        let b = au.find("pub fn sign_out").unwrap();
        assert!(!au[b..b + 300].contains("last-login"));
    }

    #[test]
    fn 下載頭像_只收小的圖片() {
        use std::io::{Read, Write};
        let serve = |ctype: &'static str, body: Vec<u8>| {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let mut buf = [0u8; 1024];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                    let _ = s.write_all(&body);
                }
            });
            port
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let c = reqwest::Client::new();
        // 只收 https：本機 http 假伺服器一律拒絕
        let p = serve("image/png", vec![1, 2, 3]);
        assert!(rt.block_on(fetch_avatar(&c, &format!("http://127.0.0.1:{p}/a.png"))).is_none());
        assert!(rt.block_on(fetch_avatar(&c, "ftp://x/a.png")).is_none());
    }
}
