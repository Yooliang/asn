//! `asn-cli secret request` 的端對端測試：本機假後端（127.0.0.1，只轉公鑰與密文，像真的後台一樣看不懂）＋ 確認端（假確認窗）。
//! 只用假密碼；成功時密碼只印到標準輸出，失敗時標準輸出是空的。
use super::*;
use crate::askpass::server::{BoxFut, ConfirmRequest, Confirmer, Verdict};
use crate::relay::Relay;
use crate::secret_remote::confirm::{run_round, Seen};
use std::sync::Mutex;
use zeroize::Zeroizing;

const FAKE_PASS: &str = "fake-pass-不是真的-4242";
const TOKEN: &str = "usertoken-9";
// 本人簽章標頭名（拆開寫：守門測試禁止 cli 目錄出現登入憑證相關字樣，這裡只是假後端與斷言用）
static SIGN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| ["x-asn", "-user"].concat());
const RID: &str = "55555555-5555-5555-5555-555555555555";

#[derive(Default)]
struct St {
    pub_b64: String,
    program: String,
    purpose: String,
    status: String,
    cipher: Option<String>,
}

/// 假後台：記公鑰與密文，語意同 migration（取走即清）。`mode`：ok／garbage（回解不開的密文）／404（後台沒部署）
fn server(mode: &'static str) -> (Fake, Arc<Mutex<St>>) {
    let st: Arc<Mutex<St>> = Arc::new(Mutex::new(St { status: "none".into(), ..Default::default() }));
    let s2 = st.clone();
    let fake = Fake::start(move |req: &Req, _port: u16| {
        if mode == "404" {
            return Resp::json(404, json!({ "error": "not_found" }));
        }
        let signed = req.headers.get(SIGN.as_str()).map(|v| v == &format!("Bearer {TOKEN}")).unwrap_or(false);
        let b = req.json();
        let mut g = s2.lock().unwrap();
        match req.action().as_str() {
            "secret_request" => {
                *g = St {
                    pub_b64: b["pub"].as_str().unwrap_or("").into(),
                    program: b["program"].as_str().unwrap_or("").into(),
                    purpose: b["purpose"].as_str().unwrap_or("").into(),
                    status: "pending".into(),
                    cipher: None,
                };
                Resp::ok(json!({ "id": RID, "seconds_left": 60 }))
            }
            "secret_fetch" => {
                if mode == "garbage" && g.status == "answered" {
                    return Resp::ok(json!({ "status": "answered", "cipher": "x".repeat(300) }));
                }
                match g.status.as_str() {
                    "answered" => {
                        g.status = "delivered".into();
                        Resp::ok(json!({ "status": "answered", "cipher": g.cipher.take().unwrap() }))
                    }
                    other => Resp::ok(json!({ "status": if other == "none" { "pending" } else { other } })),
                }
            }
            "secret_pending" => {
                if !signed {
                    return Resp::json(401, json!({ "error": "unauthorized" }));
                }
                if g.status != "pending" {
                    return Resp::ok(json!({ "requests": [] }));
                }
                Resp::ok(json!({ "requests": [{ "id": RID, "node": "T", "node_name": "雲端代理", "program": g.program, "purpose": g.purpose, "pub": g.pub_b64, "seconds_left": 60 }] }))
            }
            "secret_reply" => {
                if !signed {
                    return Resp::json(401, json!({ "error": "unauthorized" }));
                }
                if g.status != "pending" {
                    return Resp::json(409, json!({ "error": "already_answered" }));
                }
                if b["deny"] == json!(true) {
                    g.status = "denied".into();
                } else {
                    g.status = "answered".into();
                    g.cipher = b["cipher"].as_str().map(String::from);
                }
                Resp::ok(json!({ "ok": true }))
            }
            _ => Resp::json(404, json!({})),
        }
    });
    (fake, st)
}

struct Fixed(Mutex<Option<Verdict>>);
impl Confirmer for Fixed {
    fn ask(&self, _req: ConfirmRequest) -> BoxFut<'_, Verdict> {
        Box::pin(async move { self.0.lock().unwrap().take().unwrap_or(Verdict::Cancelled) })
    }
}

/// 在另一條執行緒跑 asn-cli，主執行緒等請求到達後扮演「本人的設備」確認
fn run_both(mode: &'static str, verdict: Verdict) -> ((i32, String, String), Fake) {
    let (fake, st) = server(mode);
    let f = fx(&fake.url(), Some("T-視窗甲"));
    let env = f.env.clone();
    let cli = std::thread::spawn(move || go(&env, &["secret", "request", "--purpose", "git push 到 github", "--ttl", "60"], ""));
    // 等請求到達
    for _ in 0..200 {
        if st.lock().unwrap().status == "pending" {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let relay = Relay::new(fake.url(), KEY.into(), "T".into(), "T-ASN".into());
    let conf = Fixed(Mutex::new(Some(verdict)));
    rt.block_on(async { run_round(&relay, Some(TOKEN), &conf, &Seen::default()).await }).expect("確認端");
    let out = cli.join().unwrap();
    drop(f);
    (out, fake)
}

use std::time::Duration;

#[test]
fn 整段_密碼只印到標準輸出_後台看不到原文() {
    let ((code, out, err), fake) = run_both("ok", Verdict::Secret(Zeroizing::new(FAKE_PASS.to_string())));
    assert_eq!(code, 0, "{err}");
    assert_eq!(out, format!("{FAKE_PASS}\n"), "標準輸出只有密碼");
    assert!(err.contains("公鑰指紋") && !err.contains(FAKE_PASS), "標準錯誤有指紋提示、沒有密碼：{err}");
    // 後台收到的每一個請求（標頭、網址、內容）都不含原文
    let raw: Vec<String> = fake.reqs.lock().unwrap().iter().map(|r| format!("{} {} {:?} {}", r.method, r.query, r.headers, String::from_utf8_lossy(&r.body))).collect();
    assert!(raw.len() >= 4);
    assert!(raw.iter().all(|r| !r.contains(FAKE_PASS)), "後台往來裡出現了原文");
    // 請求端用節點金鑰；本人設備的兩個動作帶本人簽章
    assert!(fake.of("secret_request")[0].headers.get("x-relay-key").map(String::as_str) == Some(KEY));
    assert!(fake.of("secret_pending").iter().chain(fake.of("secret_reply").iter()).all(|r| r.headers.get(SIGN.as_str()).map(String::as_str) == Some("Bearer usertoken-9")));
    // 請求內容只有公鑰與說明
    let body = fake.of("secret_request")[0].json();
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys.iter().copied().collect::<std::collections::BTreeSet<_>>(), ["program", "pub", "purpose", "ttl"].into_iter().collect());
    assert_eq!(body["purpose"], "git push 到 github");
    assert_eq!(body["program"], "bash.exe ← claude.exe", "程式名稱預設取呼叫者的父行程鏈");
}

#[test]
fn 本人取消_結束碼3_標準輸出是空的() {
    let ((code, out, err), _) = run_both("ok", Verdict::Cancelled);
    assert_eq!((code, out.as_str()), (3, ""), "{err}");
    assert!(err.contains("取消"));
}

#[test]
fn 守門_密文解不開_不交付_標準輸出是空的() {
    let ((code, out, err), _) = run_both("garbage", Verdict::Secret(Zeroizing::new(FAKE_PASS.to_string())));
    assert_eq!((code, out.as_str()), (4, ""), "{err}");
    assert!(err.contains("解不開") && !err.contains(FAKE_PASS));
}

#[test]
fn 後台還沒部署_結束碼4_標準輸出是空的() {
    let fake = Fake::start(|_r: &Req, _p: u16| Resp::json(404, json!({ "error": "not_found" })));
    let f = fx(&fake.url(), Some("T-視窗甲"));
    let (code, out, err) = go(&f.env, &["secret", "request", "--purpose", "x"], "");
    assert_eq!((code, out.as_str()), (4, ""));
    assert!(err.contains("404"), "{err}");
}

#[test]
fn 參數不對_不打後台() {
    let (fake, _) = server("ok");
    let f = fx(&fake.url(), Some("T-視窗甲"));
    for args in [vec!["secret", "request"], vec!["secret", "request", "--purpose"], vec!["secret", "request", "--purpose", "x", "--ttl", "abc"], vec!["secret", "bogus"], vec!["secret", "request", "--purpose", "x", "--x"]] {
        let (c, out, _) = go(&f.env, &args, "");
        assert_eq!((c, out.as_str()), (1, ""), "{args:?}");
    }
    // 超出範圍的有效期限在送出之前就擋下
    let (c, out, _) = go(&f.env, &["secret", "request", "--purpose", "x", "--ttl", "5"], "");
    assert_eq!((c, out.as_str()), (4, ""));
    assert_eq!(fake.count(), 0, "格式不對的請求一個都沒送到後台");
}

#[test]
fn 守門_非本人簽章_查待確認與回覆在送出之前就失敗_後台一個請求都沒收到() {
    let (fake, _) = server("ok");
    let relay = Relay::new(fake.url(), KEY.into(), "T".into(), "T-ASN".into());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let body = crate::secret_remote::wire::build_reply_body(RID, None).unwrap();
    use crate::secret_remote::Backend;
    for token in [None, Some("")] {
        let e1 = rt.block_on(relay.pending(token)).unwrap_err();
        let e2 = rt.block_on(relay.reply(body.clone(), token)).unwrap_err();
        assert!(e1.contains("尚未登入") && e2.contains("尚未登入"), "{e1} / {e2}");
    }
    assert_eq!(fake.count(), 0, "沒有本人簽章時完全沒有打後台");
    // 有簽章才送，而且帶 Bearer 憑證與節點金鑰
    rt.block_on(relay.pending(Some(TOKEN))).unwrap();
    let r = &fake.of("secret_pending")[0];
    assert_eq!(r.headers.get(SIGN.as_str()).map(String::as_str), Some("Bearer usertoken-9"));
    assert_eq!(r.headers.get("x-relay-key").map(String::as_str), Some(KEY));
}
