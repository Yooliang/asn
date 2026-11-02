//! 登入流程的手機端：把官方登入網址隨一個「一次性密碼請求」送到本人的設備，等本人在手機上打開登入頁、授權、把授權碼貼回。
//! 全部沿用既有的 `secret_remote`：授權碼在手機上用請求公鑰加密、經後台只轉密文、請求端取走即解（只能取一次），
//! 授權碼不經過群組、信件、往來記錄，也不經過任何 AI。帶網址的請求後台一定要本人簽章（見 20261101230000_secret_link.sql）。

use super::link::LoginLink;
use super::login::{Ask, Phone, Secret};
use crate::secret_remote::requester::{request_secret, Failure, Opts};
use crate::secret_remote::wire::{Backend, TTL_MAX, TTL_MIN};
use std::time::Duration;

/// 手機確認窗上顯示的程式名稱與用途（固定文字，不是 AI 或子程序的輸出）
const PROGRAM: &str = "Claude Code 登入";
const PURPOSE: &str = "在新電腦登入 Claude Code：開啟登入頁授權，再貼上頁面顯示的授權碼";

/// 只有 agent_setup 能建立（asn調查員 #2145）：它收任何字串網址，外面的模組不能拿來推網址
pub(in crate::agent_setup) struct SecretPhone<'a> {
    pub be: &'a dyn Backend,
    /// 取本人簽章（登入憑證）的函式，**在送出請求前才呼叫**：安裝要好幾分鐘，按下去時取好的權杖可能在安裝途中過期。
    /// 來源只有視窗程式的記憶體（由呼叫端建好傳進來）；取得的字串不進 log
    pub token: &'a dyn Fn() -> Option<String>,
    /// 輪詢間隔
    pub poll: Duration,
}

impl Phone for SecretPhone<'_> {
    fn ask_code(&self, url: &str, wait: Duration) -> Ask {
        let link = match LoginLink::parse(url) {
            Ok(l) => l,
            Err(_) => return Ask::Failed("登入網址不是官方登入網域，沒有送到手機".to_string()),
        };
        let Some(sign_token) = (self.token)().filter(|t| !t.is_empty()) else {
            return Ask::Failed("請重新登入你的帳號，才能把登入網址送到手機".to_string());
        };
        // 有效期限要落在後台允許的範圍；不夠最短時間就當逾時（不送一個一定會過期的請求）
        let secs = wait.as_secs();
        if secs < TTL_MIN {
            return Ask::TimedOut;
        }
        let mut opts = Opts::new(PROGRAM, PURPOSE).with_link(&link, sign_token);
        opts.ttl_secs = secs.min(TTL_MAX);
        opts.poll = self.poll;
        let res = crate::rt::block_on(request_secret(self.be, &opts, &mut |_| {}));
        match res {
            Ok(bytes) => {
                // 轉成文字交給登入子程序；暫存的位元組隨 Zeroizing 離開時清零
                let text = match std::str::from_utf8(&bytes) {
                    Ok(t) => t.trim().to_string(),
                    Err(_) => return Ask::Failed("手機傳回的授權碼不是文字".to_string()),
                };
                if text.is_empty() || text.chars().any(|c| c.is_control()) {
                    return Ask::Failed("手機傳回的授權碼是空的或含有控制字元".to_string());
                }
                Ask::Code(Secret::new(text))
            }
            Err(Failure::Denied) => Ask::Declined,
            Err(Failure::Expired) => Ask::TimedOut,
            // 錯誤文字一律用固定句子，不轉述後台或網路的原文
            Err(Failure::Backend(_)) => Ask::Failed("無法把登入網址送到你的手機（網路或後台的問題）".to_string()),
            Err(Failure::DecryptFailed) => Ask::Failed("收到的授權碼解不開，已丟棄".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::askpass::server::BoxFut;
    use crate::secret_remote::crypto::seal;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    const ID: &str = "22222222-2222-2222-2222-222222222222";
    const LINK: &str = "https://claude.ai/oauth/authorize?client_id=C&redirect_uri=R&state=ST4TE&code_challenge=CH4LL";
    const TOKEN: &str = "TOK-SIGN-123";

    #[derive(Default)]
    struct Fake {
        /// fetch 的回答：None＝pending 一次後 answered(密文用 secret 現場加密)；其他照字串
        secret: Option<String>,
        status: Mutex<Vec<&'static str>>,
        backend_err: bool,
        plain_requests: Mutex<u32>,
        signed: Mutex<Vec<(Value, String)>>,
    }
    impl Backend for Fake {
        fn request(&self, _b: Value) -> BoxFut<'_, Result<Value, String>> {
            *self.plain_requests.lock().unwrap() += 1;
            Box::pin(async { Err("不該走沒簽章的請求".to_string()) })
        }
        fn request_signed<'a>(&'a self, body: Value, token: &'a str) -> BoxFut<'a, Result<Value, String>> {
            self.signed.lock().unwrap().push((body, token.to_string()));
            let err = self.backend_err;
            Box::pin(async move {
                if err {
                    Err(format!("secret_request HTTP 500 internal {LINK} {TOKEN}"))
                } else {
                    Ok(json!({ "id": ID, "seconds_left": 120 }))
                }
            })
        }
        fn fetch(&self, _b: Value) -> BoxFut<'_, Result<Value, String>> {
            let next = self.status.lock().unwrap().pop().unwrap_or("answered");
            let pub_b64 = self.signed.lock().unwrap()[0].0["pub"].as_str().unwrap().to_string();
            let secret = self.secret.clone();
            Box::pin(async move {
                Ok(match next {
                    "answered" => json!({ "status": "answered", "cipher": seal(ID, &pub_b64, secret.unwrap_or_default().as_bytes()).unwrap() }),
                    s => json!({ "status": s }),
                })
            })
        }
        fn pending<'a>(&'a self, _t: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
            Box::pin(async { Err("x".to_string()) })
        }
        fn reply<'a>(&'a self, _b: Value, _t: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
            Box::pin(async { Err("x".to_string()) })
        }
    }

    fn tok() -> Option<String> {
        Some(TOKEN.to_string())
    }
    fn phone(f: &Fake) -> SecretPhone<'_> {
        SecretPhone { be: f, token: &tok, poll: Duration::from_millis(5) }
    }
    fn text(a: Ask) -> String {
        match a {
            Ask::Code(s) => String::from_utf8(s.bytes().to_vec()).unwrap(),
            Ask::Declined => "Declined".into(),
            Ask::TimedOut => "TimedOut".into(),
            Ask::Failed(e) => format!("Failed:{e}"),
        }
    }

    #[test]
    fn 成功_網址隨本人簽章的請求送出_授權碼加密傳回_前後空白去掉() {
        let f = Fake { secret: Some("  AUTH-CODE-9  \n".into()), status: Mutex::new(vec!["answered", "pending"]), ..Default::default() };
        let got = text(phone(&f).ask_code(LINK, Duration::from_secs(300)));
        assert_eq!(got, "AUTH-CODE-9");
        let signed = f.signed.lock().unwrap();
        assert_eq!(signed.len(), 1);
        assert_eq!(signed[0].1, TOKEN, "用本人簽章");
        assert_eq!(signed[0].0["link"], LINK);
        assert_eq!(signed[0].0["program"], PROGRAM);
        assert_eq!(*f.plain_requests.lock().unwrap(), 0, "帶網址的請求不能走沒簽章的路");
        assert!(signed[0].0["ttl"].as_u64().unwrap() <= TTL_MAX);
    }

    #[test]
    fn 簽章在送出前才取_用最新的那一份() {
        // 安裝要好幾分鐘：建立 SecretPhone 之後權杖換新了，送出的必須是換新後的
        let cur = std::cell::RefCell::new(Some("OLD-TOKEN".to_string()));
        let get = || cur.borrow().clone();
        let f = Fake { secret: Some("AUTH".into()), status: Mutex::new(vec!["answered"]), ..Default::default() };
        let p = SecretPhone { be: &f, token: &get, poll: Duration::from_millis(5) };
        *cur.borrow_mut() = Some("NEW-TOKEN".to_string());
        assert_eq!(text(p.ask_code(LINK, Duration::from_secs(300))), "AUTH");
        assert_eq!(f.signed.lock().unwrap()[0].1, "NEW-TOKEN");
    }

    #[test]
    fn 取不到簽章_不送出_訊息固定() {
        for none in [None, Some(String::new())] {
            let get = || none.clone();
            let f = Fake::default();
            let p = SecretPhone { be: &f, token: &get, poll: Duration::from_millis(5) };
            let t = text(p.ask_code(LINK, Duration::from_secs(300)));
            assert!(t.starts_with("Failed:") && t.contains("重新登入"), "{t}");
            assert!(f.signed.lock().unwrap().is_empty() && *f.plain_requests.lock().unwrap() == 0, "沒簽章不能送出任何請求");
        }
    }

    #[test]
    fn 網址不是官方網域_不送出任何請求() {
        let f = Fake::default();
        for bad in ["https://evil.example/x", "http://claude.ai/x", "https://claude.ai@evil.com/x"] {
            let t = text(phone(&f).ask_code(bad, Duration::from_secs(300)));
            assert!(t.starts_with("Failed:"), "{t}");
            assert!(!t.contains("evil"), "{t}");
        }
        assert!(f.signed.lock().unwrap().is_empty());
        assert_eq!(*f.plain_requests.lock().unwrap(), 0);
    }

    #[test]
    fn 時間不夠最短有效期限_當逾時_不送() {
        let f = Fake::default();
        assert_eq!(text(phone(&f).ask_code(LINK, Duration::from_secs(29))), "TimedOut");
        assert!(f.signed.lock().unwrap().is_empty());
    }

    #[test]
    fn 本人拒絕_過期_後台錯誤_各有固定結果_訊息不帶網址與簽章() {
        let f = Fake { status: Mutex::new(vec!["denied"]), ..Default::default() };
        assert_eq!(text(phone(&f).ask_code(LINK, Duration::from_secs(300))), "Declined");
        let f = Fake { status: Mutex::new(vec!["expired"]), ..Default::default() };
        assert_eq!(text(phone(&f).ask_code(LINK, Duration::from_secs(300))), "TimedOut");
        let f = Fake { backend_err: true, ..Default::default() };
        let t = text(phone(&f).ask_code(LINK, Duration::from_secs(300)));
        assert!(t.starts_with("Failed:"), "{t}");
        for leak in ["claude.ai", "ST4TE", "CH4LL", TOKEN, "HTTP 500"] {
            assert!(!t.contains(leak), "訊息帶出了 {leak}：{t}");
        }
    }

    #[test]
    fn 傳回空白或含控制字元的授權碼_不當成功() {
        for bad in ["   ", "AB\u{7}CD"] {
            let f = Fake { secret: Some(bad.into()), status: Mutex::new(vec!["answered"]), ..Default::default() };
            let t = text(phone(&f).ask_code(LINK, Duration::from_secs(300)));
            assert!(t.starts_with("Failed:"), "{bad:?} -> {t}");
        }
    }
}
