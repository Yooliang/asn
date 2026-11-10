use super::*;
use crate::device_id::{load_or_create, KnownPeers};

const NOW: i64 = 1_800_000_000;
const URL: &str = "https://auth.openai.com/codex/device";
const CODE: &str = "ABCD-EFGH1";

fn key() -> (tempfile::TempDir, DeviceKey) {
    let d = tempfile::tempdir().unwrap();
    let k = load_or_create(d.path(), &crate::auth::PlainFile).unwrap();
    (d, k)
}

/// 手機 P、電腦 T，T 認得 P
struct World {
    _d: Vec<tempfile::TempDir>,
    p: DeviceKey,
    t: DeviceKey,
    t_known: KnownPeers,
}

fn world() -> World {
    let (d1, p) = key();
    let (d2, t) = key();
    let mut t_known = KnownPeers::default();
    t_known.remember("PH", "手機", &p.public_b64(), 1).unwrap();
    World { _d: vec![d1, d2], p, t, t_known }
}

fn verify(w: &World, payload: &str, sig: &str, seen: &mut Replay) -> Result<Request, Refuse> {
    verify_request(payload, sig, "codex", "PC", "PH", Some(&w.p.public_b64()), &w.t_known, NOW, seen)
}

#[test]
fn 正規化_鍵排序_沒有空白_字串照規則跳脫() {
    assert_eq!(canon(&[("b", json!(1)), ("a", json!("x\"y")), ("c", json!("中"))]), r#"{"a":"x\"y","b":1,"c":"中"}"#);
}

#[test]
fn 來回_手機發起_電腦驗過加密_手機驗章後解開() {
    let w = world();
    let (pending, payload, sig) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
    assert_eq!(pending.req.exp, NOW + MAX_LIFETIME_SECS);
    let req = verify(&w, &payload, &sig, &mut Replay::default()).unwrap();
    assert_eq!(req, pending.req);
    let s = seal(&req, URL, CODE, NOW + 600, &w.t).unwrap();
    assert_eq!(B64.decode(&s.cipher).unwrap().len(), CIPHER_BYTES, "密文固定長度");
    assert!(s.cipher.len() <= 4096 && s.t_eph_pub.len() == 43 && s.t_sig.len() == 86, "合後台的格式");
    let c = pending.open(&w.t.public_b64(), &s.t_eph_pub, &s.cipher, &s.t_sig, NOW + 1).unwrap();
    assert_eq!((c.url.as_str(), c.code.as_str(), c.code_exp), (URL, CODE, NOW + 600));
}

#[test]
fn 電腦_任何一條不過就拒絕() {
    let w = world();
    let (_, payload, sig) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
    let mut seen = Replay::default();
    // 不認得的手機：一律拒絕（第一次見到也不接受）
    assert_eq!(verify_request(&payload, &sig, "codex", "PC", "PH", None, &KnownPeers::default(), NOW, &mut seen), Err(Refuse::UnknownPhone));
    // 後台給的公鑰和本機記住的不同
    let (_d, other) = key();
    assert_eq!(verify_request(&payload, &sig, "codex", "PC", "PH", Some(&other.public_b64()), &w.t_known, NOW, &mut seen), Err(Refuse::KeyChanged));
    // 別把金鑰簽的
    assert_eq!(verify(&w, &payload, &other.sign_b64(payload.as_bytes()), &mut seen), Err(Refuse::BadSignature));
    // 改過一個字
    assert_eq!(verify(&w, &payload.replace("\"PC\"", "\"PX\""), &sig, &mut seen), Err(Refuse::BadSignature));
    // 種類、對象不對
    assert!(matches!(verify_request(&payload, &sig, "grok", "PC", "PH", None, &w.t_known, NOW, &mut seen), Err(Refuse::Bad(_))));
    assert!(matches!(verify_request(&payload, &sig, "codex", "PC2", "PH", None, &w.t_known, NOW, &mut seen), Err(Refuse::Bad(_))));
    assert!(matches!(verify_request(&payload, &sig, "claude", "PC", "PH", None, &w.t_known, NOW, &mut seen), Err(Refuse::Bad(_))));
    // 過期、到期太遠
    assert_eq!(verify_request(&payload, &sig, "codex", "PC", "PH", None, &w.t_known, NOW + MAX_LIFETIME_SECS, &mut seen), Err(Refuse::Expired));
    assert_eq!(verify_request(&payload, &sig, "codex", "PC", "PH", None, &w.t_known, NOW - 2 * CLOCK_SKEW_SECS, &mut seen), Err(Refuse::Expired));
    // 第一次過、第二次是重送
    assert!(verify(&w, &payload, &sig, &mut seen).is_ok());
    assert_eq!(verify(&w, &payload, &sig, &mut seen), Err(Refuse::Replayed));
}

#[test]
fn 電腦_只認正規化的本文_多欄位或換寫法就算簽了也不收() {
    let w = world();
    let (pending, _, _) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
    let r = &pending.req;
    let spaced = r.payload().replace(",", ", ");
    let extra = r.payload().replacen('{', "{\"x\":1,", 1);
    let bad_rid = Request { rid: "short".into(), ..r.clone() }.payload();
    let zero_pub = Request { p_eph_pub: B64.encode([0u8; 32]), ..r.clone() }.payload();
    for p in [spaced, extra, bad_rid, zero_pub] {
        let sig = w.p.sign_b64(p.as_bytes());
        assert!(matches!(verify(&w, &p, &sig, &mut Replay::default()), Err(Refuse::Bad(_))), "{p}");
    }
}

#[test]
fn 重送表_到期後清掉() {
    let mut r = Replay::default();
    assert!(r.first_time("a", NOW + 10, NOW));
    assert!(!r.first_time("a", NOW + 10, NOW + 5));
    assert!(r.first_time("b", NOW + 100, NOW + 11));
    assert!(!r.0.contains_key("a"), "過期的清掉");
}

#[test]
fn 手機_別人用自己的金鑰加密一組代碼塞進來_驗章不過就丟棄() {
    let w = world();
    let (pending, payload, sig) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
    let req = verify(&w, &payload, &sig, &mut Replay::default()).unwrap();
    // 知道請求內容（後台看得到）的人，用自己的設備金鑰加密自己的網址＋代碼
    let (_d, evil) = key();
    let s = seal(&req, URL, "EVIL-CODE1", NOW + 600, &evil).unwrap();
    assert_eq!(pending.open(&w.t.public_b64(), &s.t_eph_pub, &s.cipher, &s.t_sig, NOW + 1).unwrap_err(), "收到的內容驗不過");
}

#[test]
fn 手機_密文或簽章任何一處被改就丟棄() {
    let w = world();
    let mk = || {
        let (pending, payload, sig) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
        let req = verify(&w, &payload, &sig, &mut Replay::default()).unwrap();
        let s = seal(&req, URL, CODE, NOW + 600, &w.t).unwrap();
        (pending, s)
    };
    // 改密文中間一個位元組
    let (p, s) = mk();
    let mut raw = B64.decode(&s.cipher).unwrap();
    raw[100] ^= 1;
    assert!(p.open(&w.t.public_b64(), &s.t_eph_pub, &B64.encode(&raw), &s.t_sig, NOW + 1).is_err());
    // 改密文開頭的代碼到期時間（想延長）
    let (p, s) = mk();
    let mut raw = B64.decode(&s.cipher).unwrap();
    raw[8] ^= 1;
    assert!(p.open(&w.t.public_b64(), &s.t_eph_pub, &B64.encode(&raw), &s.t_sig, NOW + 1).is_err());
    // 換掉 T 的一次性公鑰
    let (p, s) = mk();
    let (p2, _, _) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
    assert!(p.open(&w.t.public_b64(), &p2.req.p_eph_pub, &s.cipher, &s.t_sig, NOW + 1).is_err());
    // 拿別筆請求的回應
    let (p, _) = mk();
    let (_, s2) = mk();
    assert!(p.open(&w.t.public_b64(), &s2.t_eph_pub, &s2.cipher, &s2.t_sig, NOW + 1).is_err());
    // 代碼已經過期
    let (p, s) = mk();
    assert_eq!(p.open(&w.t.public_b64(), &s.t_eph_pub, &s.cipher, &s.t_sig, NOW + 600).unwrap_err(), "登入代碼已經過期");
}

#[test]
fn 手機_網址不是這一家的登入主機就丟棄() {
    let w = world();
    for url in ["https://accounts.x.ai/device", "https://auth.openai.com.evil.example/x", "http://auth.openai.com/x", "https://auth.openai.com/a b"] {
        let (pending, payload, sig) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
        let req = verify(&w, &payload, &sig, &mut Replay::default()).unwrap();
        let s = seal(&req, url, CODE, NOW + 600, &w.t).unwrap();
        assert!(pending.open(&w.t.public_b64(), &s.t_eph_pub, &s.cipher, &s.t_sig, NOW + 1).is_err(), "{url}");
    }
}

#[test]
fn 電腦_代碼到期不晚於請求到期_太長或空的不加密() {
    let w = world();
    let (pending, payload, sig) = new_request(&w.p, "PC", "PH", "grok", NOW).unwrap();
    let req = verify_request(&payload, &sig, "grok", "PC", "PH", None, &w.t_known, NOW, &mut Replay::default()).unwrap();
    assert!(seal(&req, "https://accounts.x.ai/x", "", NOW + 60, &w.t).is_err());
    assert!(seal(&req, &format!("https://accounts.x.ai/{}", "a".repeat(1100)), CODE, NOW + 60, &w.t).is_err());
    let s = seal(&req, "https://accounts.x.ai/device", "ABCD-EFGH", NOW + 99_999, &w.t).unwrap();
    assert_eq!(s.code_exp, req.exp, "壓到請求到期");
    let c = pending.open(&w.t.public_b64(), &s.t_eph_pub, &s.cipher, &s.t_sig, NOW + 1).unwrap();
    assert_eq!(c.code.as_str(), "ABCD-EFGH");
}

#[test]
fn 除錯輸出不帶網址代碼或金鑰() {
    let w = world();
    let (pending, payload, sig) = new_request(&w.p, "PC", "PH", "codex", NOW).unwrap();
    let req = verify(&w, &payload, &sig, &mut Replay::default()).unwrap();
    let s = seal(&req, URL, CODE, NOW + 600, &w.t).unwrap();
    let dbg = format!("{s:?} {pending:?}");
    assert!(!dbg.contains(&s.cipher) && !dbg.contains(&s.t_sig) && !dbg.contains(&req.p_eph_pub), "{dbg}");
    let c = pending.open(&w.t.public_b64(), &s.t_eph_pub, &s.cipher, &s.t_sig, NOW + 1).unwrap();
    let dbg = format!("{c:?}");
    assert!(!dbg.contains(CODE) && !dbg.contains("openai"), "{dbg}");
}
