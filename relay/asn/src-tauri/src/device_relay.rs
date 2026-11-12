//! #933 PR-5b：手機替電腦登入「裝置碼型」CLI（Codex、Grok）的請求與回傳格式。設計見私有筆記。
//! 電腦和手機共用（手機版沒有 agent_setup），所以放在最上層。
//!
//! 角色：P＝發起的手機，T＝要登入的電腦。全部用 `ring`（Ed25519、X25519、HKDF-SHA256、AES-256-GCM）。
//! - P：[`new_request`] 產生請求本文、設備簽章與一次性鑰匙對；[`Pending::open`] 驗電腦的設備簽章後才解密（私鑰用一次就消耗）。
//! - T：[`verify_request`] 檢查請求（手機要是本機認得的那把公鑰、簽章、欄位、到期、rid 沒用過）；[`seal`] 加密網址＋代碼並簽名。
//! - 簽的內容一律是「鍵排序」的 JSON（[`canon`]）；後台只轉交這些字串。
use crate::device_id::{self, DeviceKey, KnownPeers};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use ring::{aead, agreement, hkdf};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const REQ_V: &str = "asn-device-login-req-v1";
pub const CODE_V: &str = "asn-device-code-v1";
pub const PUT_V: &str = "asn-device-code-put-v1";
/// 請求最長活多久（秒）
pub const MAX_LIFETIME_SECS: i64 = 15 * 60;
/// 兩台的時鐘最多差多少（秒）
pub const CLOCK_SKEW_SECS: i64 = 60;
/// 明文（網址＋代碼＋代碼到期）上限；明文補到固定長度，密文長度不洩漏網址長度
pub const MAX_PLAIN: usize = 1024;
const PLAIN_LEN: usize = 2 + MAX_PLAIN;
const PUB_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const BLOB_V: u8 = 1;
/// 密文：版本(1) + 代碼到期 unix 秒(8，大端) + nonce(12) + 加密後明文 + 驗證標籤(16)
pub const CIPHER_BYTES: usize = 1 + 8 + NONCE_LEN + PLAIN_LEN + TAG_LEN;

/// 各家裝置碼登入網址的主機（手機也要用，所以不放在只有電腦版才有的 agent_setup 裡）。
/// 和 agent_setup::device_login 的同名清單、login_domains.json 的 exact 由一致性測試對齊
pub const CODEX_LOGIN_HOSTS: [&str; 1] = ["auth.openai.com"];
pub const GROK_LOGIN_HOSTS: [&str; 1] = ["accounts.x.ai"];

/// 支援的種類與各自的登入網址主機
pub fn vendor_hosts(vendor: &str) -> Option<&'static [&'static str]> {
    match vendor {
        "codex" => Some(&CODEX_LOGIN_HOSTS),
        "grok" => Some(&GROK_LOGIN_HOSTS),
        _ => None,
    }
}

/// 鍵排序的 JSON（不含空白）。值用 serde_json 輸出（字串會正確跳脫）
pub fn canon(pairs: &[(&str, Value)]) -> String {
    let mut v: Vec<&(&str, Value)> = pairs.iter().collect();
    v.sort_by(|a, b| a.0.cmp(b.0));
    let body: Vec<String> = v.iter().map(|(k, val)| format!("{}:{}", Value::String((*k).to_string()), val)).collect();
    format!("{{{}}}", body.join(","))
}

pub const NOT_ALLOWED_TEXT: &str = "這台電腦沒有允許這支手機替它登入：請在這台電腦的「設定 → 設備」，打開這支手機的「詳情」，勾選「允許替這台登入」";

/// 拒絕的原因（給人看的固定句子；不帶網址、代碼、金鑰）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refuse {
    /// 本機不認得這支手機（從沒互看過）：一律拒絕
    UnknownPhone,
    /// 認得，但本人沒在這台的設定頁允許它替這台登入
    NotAllowed,
    /// 這支手機的設備金鑰和本機記住的不同
    KeyChanged,
    /// 簽章驗不過
    BadSignature,
    /// 內容不對（欄位、格式、對象、種類）
    Bad(&'static str),
    /// 過期或到期時間太遠
    Expired,
    /// 這個請求編號已經處理過
    Replayed,
}

impl Refuse {
    pub fn text(&self) -> &'static str {
        match self {
            // 不認得、金鑰變了、沒允許：回同一句，真正的原因只記在這台的 log
            Refuse::UnknownPhone | Refuse::KeyChanged | Refuse::NotAllowed => NOT_ALLOWED_TEXT,
            Refuse::BadSignature => "要求的簽章驗不過，這台電腦沒有開始登入",
            Refuse::Bad(why) => why,
            Refuse::Expired => "要求已經過期，請在手機上重新發起",
            Refuse::Replayed => "這個要求已經處理過了",
        }
    }
}

/// 一筆請求（雙方簽過、記得的內容）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub rid: String,
    pub t_node: String,
    pub p_node: String,
    pub vendor: String,
    pub p_eph_pub: String,
    pub exp: i64,
}

impl Request {
    /// P 簽的本文
    pub fn payload(&self) -> String {
        canon(&[
            ("v", json!(REQ_V)),
            ("rid", json!(self.rid)),
            ("t_node", json!(self.t_node)),
            ("p_node", json!(self.p_node)),
            ("vendor", json!(self.vendor)),
            ("p_eph_pub", json!(self.p_eph_pub)),
            ("exp", json!(self.exp)),
        ])
    }

    fn aad(&self) -> Vec<u8> {
        canon(&[
            ("v", json!(CODE_V)),
            ("rid", json!(self.rid)),
            ("t_node", json!(self.t_node)),
            ("p_node", json!(self.p_node)),
            ("vendor", json!(self.vendor)),
            ("p_eph_pub", json!(self.p_eph_pub)),
            ("exp", json!(self.exp)),
        ])
        .into_bytes()
    }

    /// T 簽的內容
    fn put_message(&self, code_exp: i64, t_eph_pub: &str, cipher_sha256: &str) -> Vec<u8> {
        canon(&[
            ("v", json!(PUT_V)),
            ("rid", json!(self.rid)),
            ("t_node", json!(self.t_node)),
            ("p_node", json!(self.p_node)),
            ("vendor", json!(self.vendor)),
            ("p_eph_pub", json!(self.p_eph_pub)),
            ("exp", json!(self.exp)),
            ("code_exp", json!(code_exp)),
            ("t_eph_pub", json!(t_eph_pub)),
            ("cipher_sha256", json!(cipher_sha256)),
        ])
        .into_bytes()
    }
}

fn rid_ok(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') && B64.decode(s).map(|v| v.len() == 16).unwrap_or(false)
}

fn node_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn pub_bytes(b64: &str) -> Option<[u8; PUB_LEN]> {
    if b64.len() != 43 {
        return None;
    }
    let a: [u8; PUB_LEN] = B64.decode(b64).ok()?.try_into().ok()?;
    // 全零是低階點，共用秘密會是全零
    (!a.iter().all(|b| *b == 0)).then_some(a)
}

/// T 收到請求：依序檢查，任何一條不過就拒絕。
/// `p_node` 是後台說的發起手機；`p_sign_pub` 是後台這次給的手機公鑰（只用來判斷「變了」，驗章只用本機記住的那把）。
/// rid 有沒有處理過不在這裡查：呼叫端驗章前查、驗過後先記下存檔才開始（見 lib.rs 的 run_remote_device_login）
pub fn verify_request(payload: &str, sig: &str, kind: &str, me: &str, p_node: &str, p_sign_pub: Option<&str>, known: &KnownPeers, now: i64) -> Result<Request, Refuse> {
    if vendor_hosts(kind).is_none() {
        return Err(Refuse::Bad("不支援的登入種類"));
    }
    if payload.len() > 1024 || !node_ok(p_node) {
        return Err(Refuse::Bad("要求的格式不對"));
    }
    let Some(peer) = known.peer(p_node) else { return Err(Refuse::UnknownPhone) };
    if p_sign_pub.is_some_and(|k| k != peer.sign_pub) {
        return Err(Refuse::KeyChanged);
    }
    // 記住公鑰（例如看過畫面）不等於允許登入：要本人在這台的設定頁勾過
    if !peer.login_ok {
        return Err(Refuse::NotAllowed);
    }
    if !device_id::verify(&peer.sign_pub, payload.as_bytes(), sig) {
        return Err(Refuse::BadSignature);
    }
    let v: Value = serde_json::from_str(payload).map_err(|_| Refuse::Bad("要求的格式不對"))?;
    let o = v.as_object().ok_or(Refuse::Bad("要求的格式不對"))?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
    let (Some(ver), Some(rid), Some(t_node), Some(pn), Some(vendor), Some(p_eph_pub), Some(exp)) =
        (s("v"), s("rid"), s("t_node"), s("p_node"), s("vendor"), s("p_eph_pub"), o.get("exp").and_then(Value::as_i64))
    else {
        return Err(Refuse::Bad("要求的格式不對"));
    };
    let req = Request { rid, t_node, p_node: pn, vendor, p_eph_pub, exp };
    // 只認正規化過的本文（同一份內容只有一種寫法），也不收多餘的欄位
    if o.len() != 7 || ver != REQ_V || req.payload() != payload {
        return Err(Refuse::Bad("要求的格式不對"));
    }
    if req.t_node != me {
        return Err(Refuse::Bad("這個要求不是給這台電腦的"));
    }
    if req.p_node != p_node {
        return Err(Refuse::Bad("要求的發起設備對不上"));
    }
    if req.vendor != kind {
        return Err(Refuse::Bad("要求的登入種類對不上"));
    }
    if !rid_ok(&req.rid) || pub_bytes(&req.p_eph_pub).is_none() {
        return Err(Refuse::Bad("要求的格式不對"));
    }
    if req.exp <= now || req.exp > now + MAX_LIFETIME_SECS + CLOCK_SKEW_SECS {
        return Err(Refuse::Expired);
    }
    Ok(req)
}

struct Len32;
impl hkdf::KeyType for Len32 {
    fn len(&self) -> usize {
        32
    }
}

fn derive(ikm: &[u8], rid: &str, p_pub: &[u8], t_pub: &[u8]) -> Result<Zeroizing<[u8; 32]>, ()> {
    if ikm.iter().all(|b| *b == 0) {
        return Err(());
    }
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, rid.as_bytes()).extract(ikm);
    let info = [CODE_V.as_bytes(), rid.as_bytes(), p_pub, t_pub];
    let okm = prk.expand(&info, Len32).map_err(|_| ())?;
    let mut key = Zeroizing::new([0u8; 32]);
    okm.fill(&mut key[..]).map_err(|_| ())?;
    Ok(key)
}

fn aead_key(key: &[u8; 32]) -> Result<aead::LessSafeKey, ()> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key).map(aead::LessSafeKey::new).map_err(|_| ())
}

/// 代碼只收英數與 `-`，最長 64 字（兩端都檢查）
fn code_ok(c: &str) -> bool {
    (1..=64).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// T 送回後台的內容
#[derive(PartialEq, Eq)]
pub struct Sealed {
    pub t_eph_pub: String,
    pub cipher: String,
    pub t_sig: String,
    pub code_exp: i64,
}

impl std::fmt::Debug for Sealed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Sealed(code_exp={})", self.code_exp)
    }
}

/// T：用 P 的一次性公鑰加密網址＋代碼，再用 T 的設備金鑰簽。`code_exp` 不晚於請求的到期
pub fn seal(req: &Request, url: &str, code: &str, code_exp: i64, key: &DeviceKey) -> Result<Sealed, &'static str> {
    const FAIL: &str = "加密登入資料失敗";
    let code_exp = code_exp.min(req.exp);
    let plain_json = Zeroizing::new(canon(&[("url", json!(url)), ("code", json!(code)), ("code_exp", json!(code_exp))]));
    let n = plain_json.len();
    if url.is_empty() || !code_ok(code) || n > MAX_PLAIN {
        return Err("登入資料太長、是空的或格式不對");
    }
    let p_pub = pub_bytes(&req.p_eph_pub).ok_or(FAIL)?;
    let rng = SystemRandom::new();
    let eph = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).map_err(|_| FAIL)?;
    let t_pub = eph.compute_public_key().map_err(|_| FAIL)?.as_ref().to_vec();
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, &p_pub[..]);
    let k = agreement::agree_ephemeral(eph, &peer, |ikm| derive(ikm, &req.rid, &p_pub, &t_pub)).map_err(|_| FAIL)?.map_err(|_| FAIL)?;
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce).map_err(|_| FAIL)?;
    let mut plain = Zeroizing::new(vec![0u8; PLAIN_LEN]);
    plain[..2].copy_from_slice(&(n as u16).to_be_bytes());
    plain[2..2 + n].copy_from_slice(plain_json.as_bytes());
    let tag = aead_key(&k)
        .map_err(|_| FAIL)?
        .seal_in_place_separate_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(req.aad()), &mut plain[..])
        .map_err(|_| FAIL)?;
    let mut blob = Vec::with_capacity(CIPHER_BYTES);
    blob.push(BLOB_V);
    blob.extend_from_slice(&code_exp.to_be_bytes());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&plain[..]);
    blob.extend_from_slice(tag.as_ref());
    debug_assert_eq!(blob.len(), CIPHER_BYTES);
    let t_eph_pub = B64.encode(&t_pub);
    let t_sig = key.sign_b64(&req.put_message(code_exp, &t_eph_pub, &sha256_hex(&blob)));
    Ok(Sealed { t_eph_pub, cipher: B64.encode(&blob), t_sig, code_exp })
}

/// P 這次請求的一次性私鑰與記得的內容。私鑰沒有 Clone、不能序列化，[`Pending::open`] 用一次就消耗
#[cfg_attr(not(test), allow(dead_code))] // 手機端（下一張 PR）才接上
pub struct Pending {
    pub req: Request,
    private: agreement::EphemeralPrivateKey,
}

impl std::fmt::Debug for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Pending(rid={})", self.req.rid)
    }
}

/// P：產生一筆請求。回（記得的內容與私鑰、要送出的本文、設備簽章）
#[cfg_attr(not(test), allow(dead_code))]
pub fn new_request(key: &DeviceKey, t_node: &str, p_node: &str, vendor: &str, now: i64) -> Result<(Pending, String, String), &'static str> {
    if vendor_hosts(vendor).is_none() || !node_ok(t_node) || !node_ok(p_node) {
        return Err("不支援的登入種類");
    }
    let rng = SystemRandom::new();
    let private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).map_err(|_| "產生金鑰失敗")?;
    let p_eph_pub = B64.encode(private.compute_public_key().map_err(|_| "產生金鑰失敗")?.as_ref());
    let mut r = [0u8; 16];
    rng.fill(&mut r).map_err(|_| "產生金鑰失敗")?;
    let req = Request { rid: B64.encode(r), t_node: t_node.into(), p_node: p_node.into(), vendor: vendor.into(), p_eph_pub, exp: now + MAX_LIFETIME_SECS };
    let payload = req.payload();
    let sig = key.sign_b64(payload.as_bytes());
    Ok((Pending { req, private }, payload, sig))
}

/// P 解開後拿到的內容。沒有 Clone／Display，丟掉時清零
#[cfg_attr(not(test), allow(dead_code))]
pub struct Code {
    pub url: Zeroizing<String>,
    pub code: Zeroizing<String>,
    pub code_exp: i64,
}

impl std::fmt::Debug for Code {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Code(code_exp={})", self.code_exp)
    }
}

/// 網址要是這一家的登入主機，而且合乎登入網址的共同規則（https、只有可見 ASCII、沒有帳密、埠只能 443、主機完全等於這一家的登入主機）。
/// 解開時驗一次，手機把網址交給畫面之前（account.rs 的 setup_device_fetch）再驗一次
#[cfg_attr(not(test), allow(dead_code))]
pub fn url_ok(url: &str, vendor: &str) -> bool {
    let Some(hosts) = vendor_hosts(vendor) else { return false };
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    hosts.contains(&host) && crate::secret_remote::link::valid_login_link(url)
}

#[cfg_attr(not(test), allow(dead_code))]
impl Pending {
    /// P：先用本機記住的 T 公鑰驗簽，再解密（私鑰不論成敗都消耗）。任何一步不過整筆丟棄
    pub fn open(self, t_known_pub: &str, t_eph_pub: &str, cipher: &str, t_sig: &str, now: i64) -> Result<Code, &'static str> {
        const BAD: &str = "收到的內容驗不過";
        let blob = Zeroizing::new(B64.decode(cipher).map_err(|_| BAD)?);
        if blob.len() != CIPHER_BYTES || blob[0] != BLOB_V {
            return Err(BAD);
        }
        let code_exp = i64::from_be_bytes(blob[1..9].try_into().map_err(|_| BAD)?);
        if !device_id::verify(t_known_pub, &self.req.put_message(code_exp, t_eph_pub, &sha256_hex(&blob)), t_sig) {
            return Err(BAD);
        }
        if code_exp > self.req.exp || code_exp <= now {
            return Err("登入代碼已經過期");
        }
        let t_pub = pub_bytes(t_eph_pub).ok_or(BAD)?;
        let p_pub = pub_bytes(&self.req.p_eph_pub).ok_or(BAD)?;
        let nonce: [u8; NONCE_LEN] = blob[9..9 + NONCE_LEN].try_into().map_err(|_| BAD)?;
        let mut buf = Zeroizing::new(blob[9 + NONCE_LEN..].to_vec());
        let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, &t_pub[..]);
        let rid = self.req.rid.clone();
        let k = agreement::agree_ephemeral(self.private, &peer, |ikm| derive(ikm, &rid, &p_pub, &t_pub)).map_err(|_| BAD)?.map_err(|_| BAD)?;
        let plain = aead_key(&k)
            .map_err(|_| BAD)?
            .open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(self.req.aad()), &mut buf[..])
            .map_err(|_| BAD)?;
        if plain.len() != PLAIN_LEN {
            return Err(BAD);
        }
        let n = u16::from_be_bytes([plain[0], plain[1]]) as usize;
        if n == 0 || n > MAX_PLAIN || plain[2 + n..].iter().any(|b| *b != 0) {
            return Err(BAD);
        }
        let text = Zeroizing::new(std::str::from_utf8(&plain[2..2 + n]).map_err(|_| BAD)?.to_string());
        let v: Value = serde_json::from_str(&text).map_err(|_| BAD)?;
        let o = v.as_object().ok_or(BAD)?;
        let (Some(url), Some(code), Some(ce)) = (o.get("url").and_then(Value::as_str), o.get("code").and_then(Value::as_str), o.get("code_exp").and_then(Value::as_i64)) else {
            return Err(BAD);
        };
        if o.len() != 3 || ce != code_exp || !url_ok(url, &self.req.vendor) || !code_ok(code) {
            return Err(BAD);
        }
        Ok(Code { url: Zeroizing::new(url.to_string()), code: Zeroizing::new(code.to_string()), code_exp })
    }
}

#[cfg(test)]
mod tests;
