//! 本機 OpenAI（Codex）目前登入的帳號：只讀出 email 與方案，其他一律不讀、不留、不記 log。
//!
//! Codex CLI 的登入檔是 `<CODEX_HOME 或 ~/.codex>\auth.json`，結構（只列欄位名）：
//! `OPENAI_API_KEY`、`tokens.{id_token, access_token, refresh_token, account_id}`、`last_refresh`。
//! email 沒有獨立欄位，只存在 `tokens.id_token`（JWT）的公開聲明 `email` 裡；這裡只把 JWT 的第二段解開、
//! 取出 `email` 與 `https://api.openai.com/auth.chatgpt_plan_type` 兩個字串，其餘（含所有權杖）讀完即丟，
//! 不簽章驗證（只是顯示用）、不回給前端、不寫檔。
//!
//! 切換帳號尚未支援：Codex 會在使用中自動換新權杖並回寫 auth.json，要安全搬檔得像 Claude 一樣先回存再換、
//! 並確認 Codex 沒有同時在跑；這部分還沒做，所以目前只顯示現在登入的 email。
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct CodexLogin {
    /// 帳號 email；用 API 金鑰登入或讀不到時是空字串
    pub email: String,
    pub plan: String,
    /// "chatgpt"（用 ChatGPT 帳號登入）／"api_key"（只有 API 金鑰，沒有帳號 email）
    pub mode: String,
}

/// 真實的 Codex 家目錄（CODEX_HOME 優先）；只有 Tauri 指令會呼叫，測試不碰
pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| crate::identity::home_dir().join(".codex"))
}

fn str_at<'a>(v: &'a serde_json::Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr).and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

/// 讀 `<dir>\auth.json`；沒有檔案＝沒登入（Ok(None)）。dir 一律由呼叫端傳入（測試指到暫存資料夾）。
pub fn current(dir: &Path) -> Result<Option<CodexLogin>, String> {
    let text = match std::fs::read_to_string(dir.join("auth.json")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("讀不到 Codex 登入檔：{}", e.kind())),
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "Codex 登入檔格式不對".to_string())?;
    drop(text);
    if let Some(jwt) = str_at(&v, "/tokens/id_token") {
        let payload = jwt.split('.').nth(1).and_then(|p| URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok()).and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
        let Some(c) = payload else { return Err("Codex 登入檔裡的身分資料壞了".into()) };
        let email = str_at(&c, "/email").unwrap_or("").to_string();
        let plan = str_at(&c, "/https:~1~1api.openai.com~1auth/chatgpt_plan_type").unwrap_or("").to_string();
        return Ok(Some(CodexLogin { email, plan, mode: "chatgpt".into() }));
    }
    // 只看有沒有 API 金鑰（不取值）
    if str_at(&v, "/OPENAI_API_KEY").is_some() {
        return Ok(Some(CodexLogin { email: String::new(), plan: String::new(), mode: "api_key".into() }));
    }
    Ok(None)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn codex_account_current() -> Result<Option<CodexLogin>, String> {
    current(&codex_home())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(payload: &str) -> String {
        format!("{}.{}.{}", URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#), URL_SAFE_NO_PAD.encode(payload), "FAKE-SIGNATURE")
    }
    fn write_auth(dir: &Path, body: &str) {
        std::fs::write(dir.join("auth.json"), body).unwrap();
    }

    #[test]
    fn 讀出_email_與方案_其他欄位不外流() {
        let d = tempfile::tempdir().unwrap();
        let id = jwt(r#"{"email":"me@x.test","sub":"FAKE-SUB","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_account_id":"FAKE-ACC"}}"#);
        write_auth(d.path(), &format!(r#"{{"OPENAI_API_KEY":null,"tokens":{{"id_token":"{id}","access_token":"FAKE-ACCESS","refresh_token":"FAKE-REFRESH","account_id":"FAKE-ACC"}},"last_refresh":"2026-10-21T00:00:00Z"}}"#));
        let c = current(d.path()).unwrap().unwrap();
        assert_eq!((c.email.as_str(), c.plan.as_str(), c.mode.as_str()), ("me@x.test", "plus", "chatgpt"));
        let shown = serde_json::to_string(&c).unwrap();
        assert!(!shown.contains("FAKE-"), "{shown}");
    }

    #[test]
    fn 沒登入_只有_api_金鑰_壞掉的檔案() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(current(d.path()), Ok(None));
        write_auth(d.path(), r#"{"OPENAI_API_KEY":"sk-FAKE","tokens":null}"#);
        let c = current(d.path()).unwrap().unwrap();
        assert_eq!((c.email.as_str(), c.mode.as_str()), ("", "api_key"));
        assert!(!serde_json::to_string(&c).unwrap().contains("FAKE"));
        write_auth(d.path(), r#"{"OPENAI_API_KEY":null}"#);
        assert_eq!(current(d.path()), Ok(None));
        write_auth(d.path(), "{壞掉");
        assert!(current(d.path()).is_err());
        write_auth(d.path(), r#"{"tokens":{"id_token":"not-a-jwt"}}"#);
        let e = current(d.path()).unwrap_err();
        assert!(!e.contains("not-a-jwt"), "錯誤訊息不帶檔案內容");
    }

    #[test]
    fn 方案缺少時只有_email() {
        let d = tempfile::tempdir().unwrap();
        write_auth(d.path(), &format!(r#"{{"tokens":{{"id_token":"{}"}}}}"#, jwt(r#"{"email":"a@b.test"}"#)));
        let c = current(d.path()).unwrap().unwrap();
        assert_eq!((c.email.as_str(), c.plan.as_str()), ("a@b.test", ""));
    }
}
