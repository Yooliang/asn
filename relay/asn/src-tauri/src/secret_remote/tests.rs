//! 遠端密碼傳遞的測試。只用假密碼字串、記憶體假後端與本機 127.0.0.1 假伺服器；不開視窗、不連真實後端。
use super::confirm::{answer_from_ui, list_for_ui, run_round, Seen};
use super::crypto::{fingerprint, seal, CryptoError, RequestKey, CIPHER_BYTES, MAX_SECRET};
use super::requester::{request_secret, Failure, Opts};
use super::wire::{self, Backend};
use crate::askpass::server::{BoxFut, ConfirmRequest, Confirmer, Verdict};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zeroize::Zeroizing;

const FAKE_PASS: &str = "fake-pass-不是真的-0123";
const TOKEN: &str = "usertoken-9";
const ID1: &str = "11111111-1111-1111-1111-111111111111";
const ID2: &str = "33333333-3333-3333-3333-333333333333";

// ---- 記憶體假後端：行為對照 migration 的語意（一次性、取走即清），並記下進出的每一份 JSON ----

#[derive(Default)]
struct Store {
    pub_b64: String,
    program: String,
    purpose: String,
    status: String, // pending | answered | delivered | denied | expired
    cipher: Option<String>,
}

#[derive(Default)]
struct Mem {
    st: Mutex<Option<Store>>,
    /// 每一筆往來：(動作, 方向, 內容文字)
    log: Mutex<Vec<(String, &'static str, String)>>,
    /// 讓下一次取回直接回這個密文（測解不開的情況）
    force_cipher: Mutex<Option<String>>,
    force_status: Mutex<Option<String>>,
}

impl Mem {
    fn rec(&self, action: &str, dir: &'static str, v: &Value) {
        self.log.lock().unwrap().push((action.into(), dir, v.to_string()));
    }
    fn out(&self, action: &str, v: Value) -> Result<Value, String> {
        self.rec(action, "out", &v);
        Ok(v)
    }
    fn texts(&self) -> Vec<(String, &'static str, String)> {
        self.log.lock().unwrap().clone()
    }
}

impl Backend for Mem {
    fn request(&self, body: Value) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async move {
            self.rec("request", "in", &body);
            *self.st.lock().unwrap() = Some(Store {
                pub_b64: body["pub"].as_str().unwrap().into(),
                program: body["program"].as_str().unwrap().into(),
                purpose: body["purpose"].as_str().unwrap().into(),
                status: "pending".into(),
                cipher: None,
            });
            self.out("request", json!({ "id": ID1, "seconds_left": 60 }))
        })
    }
    fn fetch(&self, body: Value) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async move {
            self.rec("fetch", "in", &body);
            if let Some(s) = self.force_status.lock().unwrap().clone() {
                return self.out("fetch", json!({ "status": s }));
            }
            if let Some(c) = self.force_cipher.lock().unwrap().clone() {
                return self.out("fetch", json!({ "status": "answered", "cipher": c }));
            }
            let mut g = self.st.lock().unwrap();
            let st = g.as_mut().ok_or("fetch HTTP 404 not_found")?;
            let v = match st.status.as_str() {
                "answered" => {
                    st.status = "delivered".into();
                    json!({ "status": "answered", "cipher": st.cipher.take().unwrap() })
                }
                other => json!({ "status": other }),
            };
            drop(g);
            self.out("fetch", v)
        })
    }
    fn pending<'a>(&'a self, token: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法確認密碼請求")?;
            let g = self.st.lock().unwrap();
            let list = match g.as_ref().filter(|s| s.status == "pending") {
                Some(s) => json!([{ "id": ID1, "node": "CLOUD", "node_name": "雲端代理", "program": s.program, "purpose": s.purpose, "pub": s.pub_b64, "seconds_left": 60 }]),
                None => json!([]),
            };
            drop(g);
            self.out("pending", json!({ "requests": list }))
        })
    }
    fn reply<'a>(&'a self, body: Value, token: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            token.filter(|t| !t.is_empty()).ok_or("尚未登入，無法確認密碼請求")?;
            self.rec("reply", "in", &body);
            let mut g = self.st.lock().unwrap();
            let st = g.as_mut().ok_or("secret_reply HTTP 404 not_found")?;
            if st.status != "pending" {
                return Err("secret_reply HTTP 409 already_answered".into());
            }
            if body["deny"] == json!(true) {
                st.status = "denied".into();
            } else {
                st.status = "answered".into();
                st.cipher = Some(body["cipher"].as_str().unwrap().into());
            }
            Ok(json!({ "ok": true }))
        })
    }
}

/// 假確認窗：依腳本回答，並記下它被問了幾次與問了什麼（沒有密碼）
struct Script {
    verdict: Mutex<Option<Verdict>>,
    asked: AtomicUsize,
    seen_req: Mutex<Vec<ConfirmRequest>>,
}
impl Script {
    fn new(v: Verdict) -> Script {
        Script { verdict: Mutex::new(Some(v)), asked: AtomicUsize::new(0), seen_req: Mutex::new(vec![]) }
    }
}
impl Confirmer for Script {
    fn ask(&self, req: ConfirmRequest) -> BoxFut<'_, Verdict> {
        Box::pin(async move {
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.seen_req.lock().unwrap().push(req);
            self.verdict.lock().unwrap().take().unwrap_or(Verdict::Cancelled)
        })
    }
}

fn fast(program: &str) -> Opts {
    let mut o = Opts::new(program, "git push 到 github");
    o.poll = Duration::from_millis(10);
    o
}

/// 請求端與確認端同時跑：確認端晚一點才查（請求已建立）
async fn flow(be: &Mem, verdict: Verdict) -> (Result<Zeroizing<Vec<u8>>, Failure>, Arc<Script>, Vec<String>) {
    let conf = Arc::new(Script::new(verdict));
    let seen = Seen::default();
    let mut notes: Vec<String> = vec![];
    let opts = fast("git.exe ← bash.exe");
    let req = async { request_secret(be, &opts, &mut |s| notes.push(format!("{} {} {}", s.id, s.fingerprint, s.seconds_left))).await };
    let conf2 = conf.clone();
    let side = async {
        tokio::time::sleep(Duration::from_millis(40)).await;
        run_round(be, Some(TOKEN), conf2.as_ref(), &seen).await
    };
    let (res, round) = tokio::join!(req, side);
    round.expect("確認端查詢");
    (res, conf, notes)
}

// ---- 加解密 ----

fn key_and_pub() -> (RequestKey, String) {
    let k = RequestKey::generate().unwrap();
    let p = k.public_b64();
    (k, p)
}

#[test]
fn 加密後解得開_密文長度固定不洩漏密碼長度() {
    let (k, p) = key_and_pub();
    let c = seal(ID1, &p, FAKE_PASS.as_bytes()).unwrap();
    assert_eq!(B64.decode(&c).unwrap().len(), CIPHER_BYTES);
    assert!(c.len() <= 2048 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    assert_eq!(&**k.open(ID1, &c).unwrap(), FAKE_PASS.as_bytes());
    let (_, p2) = key_and_pub();
    let long = vec![b'x'; MAX_SECRET];
    assert_eq!(B64.decode(seal(ID1, &p2, &long).unwrap()).unwrap().len(), CIPHER_BYTES, "最長與最短密文一樣長");
    assert_eq!(B64.decode(seal(ID1, &p2, b"a").unwrap()).unwrap().len(), CIPHER_BYTES);
}

#[test]
fn 同一個密碼每次加密的密文都不同() {
    let (_, p) = key_and_pub();
    assert_ne!(seal(ID1, &p, b"abc").unwrap(), seal(ID1, &p, b"abc").unwrap());
}

#[test]
fn 空密碼與太長的密碼不加密() {
    let (_, p) = key_and_pub();
    assert_eq!(seal(ID1, &p, b""), Err(CryptoError::BadSecret));
    assert_eq!(seal(ID1, &p, &vec![b'x'; MAX_SECRET + 1]), Err(CryptoError::BadSecret));
}

#[test]
fn 別把鑰匙解不開() {
    let (_, p) = key_and_pub();
    let c = seal(ID1, &p, FAKE_PASS.as_bytes()).unwrap();
    let (other, _) = key_and_pub();
    assert!(other.open(ID1, &c).is_err());
}

#[test]
fn 綁請求編號_換一個編號解不開() {
    let (k, p) = key_and_pub();
    let c = seal(ID1, &p, FAKE_PASS.as_bytes()).unwrap();
    assert_eq!(k.open("22222222-2222-2222-2222-222222222222", &c), Err(CryptoError::Decrypt));
}

#[test]
fn 綁請求公鑰_為別的請求加的密在這裡解不開() {
    // 重放保護：攻擊者把別的請求的密文塞進這個請求，解密必須失敗
    let (_, pa) = key_and_pub();
    let (kb, _) = key_and_pub();
    let c = seal(ID1, &pa, FAKE_PASS.as_bytes()).unwrap();
    assert!(kb.open(ID1, &c).is_err());
}

#[test]
fn 任何一個位元組被改過都解不開() {
    // 版本、臨時公鑰、nonce、密文本體、驗證標籤各挑幾個位置
    for pos in [0usize, 1, 20, 33, 40, 44, 45, 300, 1000, CIPHER_BYTES - 17, CIPHER_BYTES - 1] {
        let (k, p2) = key_and_pub();
        let c2 = seal(ID1, &p2, FAKE_PASS.as_bytes()).unwrap();
        let mut raw2 = B64.decode(&c2).unwrap();
        raw2[pos] ^= 0x01;
        assert!(k.open(ID1, &B64.encode(raw2)).is_err(), "改了第 {pos} 個位元組還解得開");
    }
}

#[test]
fn 長度不對_格式不對_全零公鑰都被拒絕() {
    let (k, _) = key_and_pub();
    let (k2, p2) = key_and_pub();
    let c = seal(ID1, &p2, b"abc").unwrap();
    let raw = B64.decode(&c).unwrap();
    assert_eq!(k.open(ID1, &B64.encode(&raw[..raw.len() - 1])), Err(CryptoError::BadInput));
    assert!(k2.open(ID1, "!!!不是base64").is_err());
    let (k3, _) = key_and_pub();
    assert!(k3.open("不是uuid", &c).is_err());
    // 低階點：全零公鑰（共用秘密會是全零）不能拿來加密
    assert!(seal(ID1, &B64.encode([0u8; 32]), b"abc").is_err());
    // 密文裡的臨時公鑰是全零也不收
    let (k4, p4) = key_and_pub();
    let mut raw4 = B64.decode(seal(ID1, &p4, b"abc").unwrap()).unwrap();
    raw4[1..33].fill(0);
    assert!(k4.open(ID1, &B64.encode(raw4)).is_err());
    // 公鑰長度不對
    assert_eq!(seal(ID1, "AAAA", b"abc"), Err(CryptoError::BadInput));
}

#[test]
fn 指紋格式固定_同一把公鑰同一個指紋() {
    let (_, p) = key_and_pub();
    let f = fingerprint(&p);
    assert_eq!(f.len(), 9);
    assert!(f.chars().enumerate().all(|(i, c)| if i == 4 { c == '-' } else { c.is_ascii_hexdigit() }), "{f}");
    assert_eq!(f, fingerprint(&p));
    assert_ne!(f, fingerprint(&key_and_pub().1));
}

#[test]
fn 除錯輸出不印鑰匙() {
    let (k, p) = key_and_pub();
    let d = format!("{k:?}");
    assert_eq!(d, "RequestKey(<已隱藏>)");
    assert!(!d.contains(&p));
}

// ---- 整段流程 ----

#[tokio::test]
async fn 整段流程_輸入的密碼原樣交到請求端() {
    let be = Mem::default();
    let (res, conf, notes) = flow(&be, Verdict::Secret(Zeroizing::new(FAKE_PASS.to_string()))).await;
    assert_eq!(&**res.as_ref().unwrap(), FAKE_PASS.as_bytes());
    // 確認窗看到的：設備名稱（後台給的）、程式與用途（自報）、指紋
    let seen = conf.seen_req.lock().unwrap();
    assert_eq!(conf.asked.load(Ordering::SeqCst), 1);
    assert_eq!(seen[0].origin.as_deref(), Some("雲端代理"));
    assert_eq!(seen[0].program, "git.exe ← bash.exe");
    assert_eq!(seen[0].prompt, "git push 到 github");
    let fp = seen[0].fingerprint.clone().unwrap();
    assert!(notes[0].contains(&fp), "請求端印的指紋要和確認窗的一樣：{} / {fp}", notes[0]);
}

#[tokio::test]
async fn 守門_密碼與密文只出現在該出現的地方() {
    let be = Mem::default();
    let (res, _, notes) = flow(&be, Verdict::Secret(Zeroizing::new(FAKE_PASS.to_string()))).await;
    assert!(res.is_ok());
    // 原文的各種常見編碼
    let raw = FAKE_PASS.as_bytes();
    let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let needles = [FAKE_PASS.to_string(), base64::engine::general_purpose::STANDARD.encode(raw), B64.encode(raw), hex];
    let log = be.texts();
    assert!(log.len() >= 5, "應該記到請求、查詢、待確認、回覆、取回：{}", log.len());
    let cipher = log.iter().find(|(a, d, _)| a == "reply" && *d == "in").map(|x| serde_json::from_str::<Value>(&x.2).unwrap()["cipher"].as_str().unwrap().to_string()).unwrap();
    for (action, dir, text) in &log {
        for n in &needles {
            assert!(!text.contains(n.as_str()), "後台往來（{action}/{dir}）出現了原文：{text}");
        }
        // 密文只能出現在「回覆送進去」與「取回送出來」兩處
        let allowed = (action == "reply" && *dir == "in") || (action == "fetch" && *dir == "out");
        assert_eq!(text.contains(&cipher), allowed && text.contains(&cipher), "{action}/{dir}");
        if !allowed {
            assert!(!text.contains(&cipher), "密文出現在不該出現的往來：{action}/{dir}");
        }
    }
    // 請求端對使用者印的訊息也沒有
    for n in notes.iter() {
        assert!(!n.contains(&cipher) && !n.contains(FAKE_PASS));
    }
    // 後台留著的狀態：取走之後密文已清
    assert!(be.st.lock().unwrap().as_ref().unwrap().cipher.is_none());
}

#[tokio::test]
async fn 本人按取消_請求端拿到被拒絕_什麼都不交付() {
    let be = Mem::default();
    let (res, _, _) = flow(&be, Verdict::Cancelled).await;
    assert_eq!(res.unwrap_err(), Failure::Denied);
    assert!(be.texts().iter().any(|(a, d, t)| a == "reply" && *d == "in" && t.contains("\"deny\":true")));
}

#[tokio::test]
async fn 沒有人回應_請求端等到過期() {
    let be = Mem::default();
    *be.force_status.lock().unwrap() = Some("expired".into());
    let mut o = fast("x");
    o.ttl_secs = 30;
    let r = request_secret(&be, &o, &mut |_| {}).await;
    assert_eq!(r.unwrap_err(), Failure::Expired);
}

#[tokio::test]
async fn 守門_解密失敗不交付任何東西() {
    // 後台回了一份解不開的密文（亂碼、被竄改、別的請求的）：一律回 DecryptFailed，沒有任何密碼位元組
    let (_, other_pub) = key_and_pub();
    let foreign = seal(ID1, &other_pub, FAKE_PASS.as_bytes()).unwrap(); // 加密給別人的
    let mut tampered = B64.decode(&foreign).unwrap();
    tampered[100] ^= 1;
    for bad in [foreign, B64.encode(tampered), "x".repeat(200), B64.encode(vec![7u8; CIPHER_BYTES])] {
        let be = Mem::default();
        *be.force_cipher.lock().unwrap() = Some(bad);
        let r = request_secret(&be, &fast("x"), &mut |_| {}).await;
        assert_eq!(r.unwrap_err(), Failure::DecryptFailed);
    }
}

#[tokio::test]
async fn 重複使用被拒_同一筆請求只跳一次窗_回覆過就不能再回覆() {
    let be = Mem::default();
    let (res, conf, _) = flow(&be, Verdict::Secret(Zeroizing::new(FAKE_PASS.to_string()))).await;
    assert!(res.is_ok());
    // 後台已經取走：再取只回「已送達」，請求端把它當錯誤
    assert_eq!(wire::parse_fetched(&be.fetch(json!({ "id": ID1 })).await.unwrap()).unwrap(), wire::Fetched::Delivered);
    // 再回覆一次被後台拒絕
    let (_, p) = key_and_pub();
    let c = seal(ID1, &p, b"abc").unwrap();
    assert!(be.reply(wire::build_reply_body(ID1, Some(&c)).unwrap(), Some(TOKEN)).await.unwrap_err().contains("already_answered"));
    assert_eq!(conf.asked.load(Ordering::SeqCst), 1);
    // 確認端同一批清單看到兩次，也只問一次
    let be2 = Mem::default();
    be2.request(wire::build_request_body(&key_and_pub().1, "p", "u", 60).unwrap()).await.unwrap();
    let conf2 = Script::new(Verdict::TimedOut);
    let seen = Seen::default();
    let r1 = run_round(&be2, Some(TOKEN), &conf2, &seen).await.unwrap();
    let r2 = run_round(&be2, Some(TOKEN), &conf2, &seen).await.unwrap();
    assert_eq!((r1.shown, r2.shown, conf2.asked.load(Ordering::SeqCst)), (1, 0, 1));
}

#[tokio::test]
async fn 守門_沒有本人簽章確認端什麼都不做() {
    let be = Mem::default();
    be.request(wire::build_request_body(&key_and_pub().1, "p", "u", 60).unwrap()).await.unwrap();
    let conf = Script::new(Verdict::Secret(Zeroizing::new(FAKE_PASS.to_string())));
    for token in [None, Some("")] {
        assert!(run_round(&be, token, &conf, &Seen::default()).await.is_err());
        assert!(answer_from_ui(&be, token, ID1, Some(Zeroizing::new(FAKE_PASS.to_string()))).await.is_err());
        assert!(list_for_ui(&be, token).await.is_err());
    }
    assert_eq!(conf.asked.load(Ordering::SeqCst), 0);
    assert!(be.texts().iter().all(|(a, _, _)| a != "reply"), "沒簽章時完全沒有回覆");
}

#[tokio::test]
async fn 手機端_清單只有說明與指紋_回覆時公鑰向後台重查_送出的是密文() {
    let be = Mem::default();
    let (k, p) = key_and_pub();
    be.request(wire::build_request_body(&p, "git.exe", "git push", 60).unwrap()).await.unwrap();
    let list = list_for_ui(&be, Some(TOKEN)).await.unwrap();
    let item = &list["requests"][0];
    assert_eq!(item["fingerprint"], fingerprint(&p));
    assert_eq!(item["node_name"], "雲端代理");
    assert!(item.get("pub").is_none() && !list.to_string().contains(&p), "清單不給畫面公鑰");
    // 畫面亂報別的編號：查不到就失敗，不會對別的請求回覆
    assert!(answer_from_ui(&be, Some(TOKEN), "99999999-9999-9999-9999-999999999999", Some(Zeroizing::new("abc".into()))).await.is_err());
    answer_from_ui(&be, Some(TOKEN), ID1, Some(Zeroizing::new(FAKE_PASS.to_string()))).await.unwrap();
    let sent = be.texts().into_iter().find(|(a, d, _)| a == "reply" && *d == "in").unwrap().2;
    assert!(!sent.contains(FAKE_PASS), "送出的不是原文");
    let cipher = serde_json::from_str::<Value>(&sent).unwrap()["cipher"].as_str().unwrap().to_string();
    assert_eq!(&**k.open(ID1, &cipher).unwrap(), FAKE_PASS.as_bytes());
    // 空的、太長的不送
    let be2 = Mem::default();
    be2.request(wire::build_request_body(&key_and_pub().1, "p", "u", 60).unwrap()).await.unwrap();
    assert!(answer_from_ui(&be2, Some(TOKEN), ID1, Some(Zeroizing::new(String::new()))).await.is_err());
    assert!(answer_from_ui(&be2, Some(TOKEN), ID1, Some(Zeroizing::new("x".repeat(MAX_SECRET + 1)))).await.is_err());
    assert!(be2.texts().iter().all(|(a, _, _)| a != "reply"));
}

// ---- 與後台往來的格式 ----

#[test]
fn 請求內容_格式擋在送出之前() {
    let p = "A".repeat(43);
    assert_eq!(wire::build_request_body(&p, " git ", " 推送 ", 60).unwrap(), json!({ "pub": p, "program": "git", "purpose": "推送", "ttl": 60 }));
    for (a, b, c, d) in [("short", "g", "u", 60u64), (p.as_str(), "", "u", 60), (p.as_str(), "g", "", 60), (p.as_str(), "g\nx", "u", 60), (p.as_str(), "g", "u\u{202e}", 60),
        (p.as_str(), "g", "u", 29), (p.as_str(), "g", "u", 601)] {
        assert!(wire::build_request_body(a, b, c, d).is_err(), "{a} {b:?} {c:?} {d}");
    }
    assert!(wire::build_request_body(&p, &"x".repeat(81), "u", 60).is_err() && wire::build_request_body(&p, "g", &"x".repeat(201), 60).is_err());
    assert!(wire::build_reply_body("不是uuid", None).is_err());
    assert!(wire::build_reply_body(ID1, Some("短")).is_err());
    assert_eq!(wire::build_reply_body(ID1, None).unwrap(), json!({ "id": ID1, "deny": true }));
}

#[test]
fn 待確認清單_壞資料略過_文字清理過() {
    let p = "B".repeat(43);
    let v = json!({ "requests": [
        { "id": ID1, "node": "CLOUD", "node_name": "雲\n端\u{202e}代理", "program": "g\tit", "purpose": "x", "pub": p, "seconds_left": 50 },
        { "id": "壞的", "node": "C", "program": "g", "purpose": "x", "pub": p, "seconds_left": 50 },
        { "id": ID1, "node": "C", "program": "g", "purpose": "x", "pub": "短", "seconds_left": 50 },
        { "id": ID1, "node": "C", "program": "g", "purpose": "x", "pub": p, "seconds_left": 0 },
    ] });
    let l = wire::parse_pending(&v);
    assert_eq!(l.len(), 1);
    assert_eq!((l[0].node_name.as_str(), l[0].program.as_str()), ("雲 端代理", "g it"));
    assert!(wire::parse_pending(&json!({})).is_empty() && wire::parse_pending(&json!("x")).is_empty());
}

// ---- 登入網址（#628 第 3 段）----

const GOOD_LINK: &str = "https://claude.ai/oauth/authorize?client_id=C&redirect_uri=R&state=S&code_challenge=H";

#[test]
fn 帶網址的請求內容_網址格式不對在送出前就擋下() {
    let p = "B".repeat(43);
    let b = wire::build_request_body_link(&p, "Claude Code 登入", "登入", 120, GOOD_LINK).unwrap();
    assert_eq!(b["link"], GOOD_LINK);
    assert_eq!(b["pub"], p);
    for bad in ["http://claude.ai/x", "https://evil.example/x", "https://claude.ai@evil.com/x", "https://claude.ai.evil.com/", ""] {
        assert!(wire::build_request_body_link(&p, "g", "u", 120, bad).is_err(), "{bad}");
    }
    // 沒帶網址的請求內容沒有 link 欄位
    assert!(wire::build_request_body(&p, "g", "u", 120).unwrap().get("link").is_none());
}

#[test]
fn 待確認清單的網址_官方網域留下_沒附是_none_不是官方網域整筆不顯示() {
    let p = "B".repeat(43);
    let mk = |extra: serde_json::Value| {
        let mut r = json!({ "id": ID1, "node": "NEWPC", "node_name": "新電腦", "program": "Claude Code 登入", "purpose": "x", "pub": p, "seconds_left": 50 });
        if let (Some(o), Some(e)) = (r.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        json!({ "requests": [r] })
    };
    let l = wire::parse_pending(&mk(json!({ "link": GOOD_LINK })));
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].link.as_deref(), Some(GOOD_LINK));
    assert_eq!(wire::parse_pending(&mk(json!({ "link": null }))).first().map(|r| r.link.clone()), Some(None));
    assert_eq!(wire::parse_pending(&mk(json!({}))).first().map(|r| r.link.clone()), Some(None), "舊後台沒有 link 欄位");
    for bad in [json!("https://evil.example/x"), json!("http://claude.ai/x"), json!("https://claude.ai@evil.com/"), json!(5), json!({"a":1}), json!("")] {
        assert!(wire::parse_pending(&mk(json!({ "link": bad.clone() }))).is_empty(), "{bad}");
    }
}

struct OnlyPending(Value);
impl Backend for OnlyPending {
    fn request(&self, _b: Value) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async { Err("x".to_string()) })
    }
    fn fetch(&self, _b: Value) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async { Err("x".to_string()) })
    }
    fn pending<'a>(&'a self, _t: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
    fn reply<'a>(&'a self, _b: Value, _t: Option<&'a str>) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async { Err("x".to_string()) })
    }
}

#[tokio::test]
async fn 手機清單帶網址與網域_不官方的不出現() {
    let one = |id: &str, pubk: &str, link: Value| json!({ "id": id, "node": "NEWPC", "node_name": "新電腦", "program": "Claude Code 登入", "purpose": "x", "pub": pubk, "seconds_left": 50, "link": link });
    let be = OnlyPending(json!({ "requests": [one(ID1, &"B".repeat(43), json!(GOOD_LINK)), one(ID2, &"C".repeat(43), json!("https://evil.example/x"))] }));
    let v = list_for_ui(&be, Some("T")).await.unwrap();
    let items = v["requests"].as_array().unwrap();
    assert_eq!(items.len(), 1, "不是官方網域的那筆不顯示");
    assert_eq!((items[0]["link"].as_str(), items[0]["link_host"].as_str()), (Some(GOOD_LINK), Some("claude.ai")));
    // 沒附網址：link 與 link_host 都是 null
    let be = OnlyPending(json!({ "requests": [one(ID1, &"B".repeat(43), Value::Null)] }));
    let v = list_for_ui(&be, Some("T")).await.unwrap();
    assert!(v["requests"][0]["link"].is_null() && v["requests"][0]["link_host"].is_null());
}

// ---- 守門：原始碼掃描 ----

fn sources() -> Vec<(String, String)> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut v = vec![];
    for e in std::fs::read_dir(src.join("secret_remote")).unwrap() {
        let p = e.unwrap().path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with(".rs") && name != "tests.rs" {
            v.push((format!("secret_remote/{name}"), std::fs::read_to_string(&p).unwrap().replace("\r\n", "\n")));
        }
    }
    v.push(("cli/secret.rs".into(), std::fs::read_to_string(src.join("cli").join("secret.rs")).unwrap().replace("\r\n", "\n")));
    v.sort();
    v
}
fn code_only(s: &str) -> String {
    s.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

#[test]
fn 守門_掃描器看得到所有檔案() {
    let names: Vec<String> = sources().into_iter().map(|x| x.0).collect();
    for n in ["secret_remote/confirm.rs", "secret_remote/crypto.rs", "secret_remote/desktop.rs", "secret_remote/mod.rs", "secret_remote/requester.rs", "secret_remote/wire.rs", "cli/secret.rs"] {
        assert!(names.contains(&n.to_string()), "掃描漏了 {n}");
    }
}

#[test]
fn 守門_密碼與密文不進log不進格式化輸出() {
    let macros = ["println!(", "eprintln!(", "elog!(", "olog!(", "format!(", "writeln!(", "write!(", "print!(", "eprint!(", "dbg!(", "panic!(", "log::", "tracing::", "json!("];
    let words = ["secret", "password", "cipher", "plain", "verdict", "body", "pass", "key"];
    let mut bad = vec![];
    for (name, text) in sources() {
        for (i, line) in code_only(&text).lines().enumerate() {
            if macros.iter().any(|m| line.match_indices(m).any(|(at, _)| at == 0 || !line[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_'))) {
                let l = line.to_lowercase();
                if words.iter().any(|w| l.contains(w)) {
                    bad.push(format!("{name}:{}: {}", i + 1, line.trim()));
                }
            }
        }
    }
    // 允許清單：這幾行是寫回後台/畫面的結構化資料或固定錯誤文字，已逐行檢視沒有帶出密碼／密文／私鑰本身
    let allowed = ["json!({ \"id\": id, \"deny\": true })", "json!({ \"id\": id, \"cipher\": c })", "json!({ \"pub\": pub_b64,", "json!({ \"id\": id })", "不認得的子命令 secret", "api_signed(\"secret_pending\"", "api_signed(\"secret_reply\""];
    bad.retain(|b| !allowed.iter().any(|a| b.contains(a)));
    assert!(bad.is_empty(), "這些輸出可能帶出密碼或密文：\n{}", bad.join("\n"));
}

#[test]
fn 守門_密碼不寫檔不進環境變數不進指令列不進剪貼簿() {
    let banned = ["fs::write", "File::create", "create_new(", ".append(true)", "write_atomic", "set_var(", "remove_var(", "Command::new", "clipboard", "Clipboard", "localStorage", ".envs(", ".env(", "std::fs", "OpenOptions", "env::args"];
    let mut bad = vec![];
    for (name, text) in sources() {
        for (i, line) in code_only(&text).lines().enumerate() {
            for b in banned {
                if line.contains(b) {
                    bad.push(format!("{name}:{}: 含「{b}」：{}", i + 1, line.trim()));
                }
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn 守門_私鑰用完即刪_型別上不能複製不能序列化_解密吃掉鑰匙() {
    let crypto = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/secret_remote/crypto.rs")).unwrap().replace("\r\n", "\n");
    let at = crypto.find("pub struct RequestKey").expect("找不到 RequestKey");
    let above = &crypto[at.saturating_sub(300)..at];
    assert!(!above.contains("derive("), "RequestKey 不能 derive 任何東西（Clone／Serialize／Debug 都不行）：{above}");
    assert!(!crypto.contains("impl Clone for RequestKey") && !crypto.contains("Serialize for RequestKey"), "不能複製、不能序列化");
    assert!(crypto.contains("pub fn open(self,"), "open 必須以值接收 self（解密時消耗私鑰）");
    assert!(!crypto.contains("pub private") && !crypto.contains("pub(crate) private"), "私鑰欄位不能公開");
    assert!(crypto.contains("agreement::EphemeralPrivateKey"), "私鑰必須是 ring 的臨時私鑰型別（不能取出位元組）");
    // 別的檔案不能碰私鑰欄位或自己產生長期私鑰
    for (name, text) in sources().into_iter().filter(|x| x.0 != "secret_remote/crypto.rs") {
        let code = code_only(&text);
        assert!(!code.contains(".private") && !code.contains("EphemeralPrivateKey") && !code.contains("static "), "{name} 不能碰私鑰");
    }
    // 請求端：鑰匙只在 request_secret 裡建立一次、解密一次
    let req = code_only(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/secret_remote/requester.rs")).unwrap());
    assert_eq!(req.matches("RequestKey::generate()").count(), 1);
    assert_eq!(req.matches("key.open(").count(), 1);
}

#[test]
fn 守門_本人設備的動作一定經過本人簽章的後端介面() {
    // 確認端只能透過 Backend::pending／reply（它們要 token）跟後台講話；不能直接拿 Relay.api 打 secret_pending／secret_reply
    for name in ["confirm.rs", "desktop.rs"] {
        let t = code_only(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/secret_remote").join(name)).unwrap());
        assert!(!t.contains(".api(") && !t.contains("api_signed("), "{name} 不能繞過 Backend 直接打後台");
    }
    let w = code_only(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/secret_remote/wire.rs")).unwrap());
    assert_eq!(w.matches("api_signed(").count(), 3, "只有 pending、reply 與帶登入網址的 request_signed 三處帶本人簽章");
    assert_eq!(w.matches("filter(|t| !t.is_empty()).ok_or(NOT_SIGNED)?").count(), 2, "pending、reply 兩處都要先驗有憑證");
    // 帶登入網址的請求：憑證是空的就不送（後台也會擋，這裡先擋）
    assert!(w.contains("if token.is_empty() {") && w.contains("api_signed(\"secret_request\""), "request_signed 要先驗有憑證");
}
