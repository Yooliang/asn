//! 別台看畫面的握手（#597，0.2.8 改版）。D＝看的那台，T＝被看的那台。這裡只有判斷和密碼學，不碰網路和窗格。
//!
//! - 兩邊都用自己的設備金鑰（`device_id`，Ed25519）簽；Windows Hello 只用來確認本人在場（在 lib.rs 的入口，不在這裡）。
//! - 驗章用的對方公鑰是**本機記住的那一把**（TOFU，`device_id::KnownPeers`），由呼叫端比對過才傳進來；後台只轉交。
//! - 簽章涵蓋雙方一次性公鑰、session id、雙方節點、視窗名、範圍、到期時間；T 的簽章包含 D 的一次性公鑰，防重放。
#![cfg_attr(not(test), allow(dead_code))]
use crate::device_id::{self, DeviceKey, SCOPE_VIEW};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::{agreement, hkdf};
use zeroize::Zeroizing;

/// 到期最多幾秒（和後台相同，留 30 秒時鐘差）
pub const MAX_LIFETIME_SECS: i64 = 630;
const KDF_LABEL: &[u8] = b"asn-view-key-v1";

/// 這次觀看的固定資料。兩邊要完全相同，簽章才對得上
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub d_node: String,
    pub t_node: String,
    pub window: String,
    pub expires_s: i64,
}

impl Session {
    fn lines(&self) -> String {
        format!("{}\n{}\n{}\n{}\n{}\n{}", self.id, self.d_node, self.t_node, self.window, SCOPE_VIEW, self.expires_s)
    }

    /// D 簽的內容
    pub fn d_message(&self, d_eph: &str) -> Vec<u8> {
        format!("asn-view-start-v1\n{}\n{d_eph}", self.lines()).into_bytes()
    }

    /// T 簽的內容：包含 D 的一次性公鑰，所以舊的簽章不能拿來回應新的請求
    pub fn t_message(&self, d_eph: &str, t_eph: &str) -> Vec<u8> {
        format!("asn-view-accept-v1\n{}\n{d_eph}\n{t_eph}", self.lines()).into_bytes()
    }

    /// 這次觀看是不是還有效：沒過期，也沒有超過上限。用本機時鐘，不信後台
    fn live_at(&self, now_s: i64) -> bool {
        self.expires_s > now_s && self.expires_s <= now_s + MAX_LIFETIME_SECS
    }
}

/// 這次觀看的金鑰。兩邊導出來相同，用完就清
pub struct SessionKey(Zeroizing<[u8; 32]>);

impl SessionKey {
    /// 只給同一包的加解密用
    pub(crate) fn raw(&self) -> &[u8; 32] {
        &self.0
    }
}

/// 測試用的金鑰
#[cfg(test)]
pub(crate) fn test_key(b: u8) -> SessionKey {
    SessionKey(Zeroizing::new([b; 32]))
}

/// 一次性金鑰。私鑰是 ring 的臨時型別，導出金鑰時就被消耗掉
pub struct Eph {
    private: agreement::EphemeralPrivateKey,
    public: String,
}

impl Eph {
    pub fn generate() -> Result<Self, String> {
        let private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &SystemRandom::new()).map_err(|_| "產生金鑰失敗".to_string())?;
        let public = B64.encode(private.compute_public_key().map_err(|_| "產生金鑰失敗".to_string())?.as_ref());
        Ok(Eph { private, public })
    }

    pub fn public_b64(&self) -> &str {
        &self.public
    }
}

struct Len32;
impl hkdf::KeyType for Len32 {
    fn len(&self) -> usize {
        32
    }
}

fn derive(eph: Eph, s: &Session, d_eph: &str, t_eph: &str, peer_eph: &str) -> Result<SessionKey, String> {
    let peer = B64.decode(peer_eph).map_err(|_| "對方的金鑰不對".to_string())?;
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, peer);
    agreement::agree_ephemeral(eph.private, &peer, |ikm| {
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, s.id.as_bytes()).extract(ikm);
        let lines = s.lines();
        let info: [&[u8]; 4] = [KDF_LABEL, lines.as_bytes(), d_eph.as_bytes(), t_eph.as_bytes()];
        let mut out = Zeroizing::new([0u8; 32]);
        prk.expand(&info, Len32).and_then(|o| o.fill(&mut out[..])).map(|_| SessionKey(out)).map_err(|_| "導出金鑰失敗".to_string())
    })
    .map_err(|_| "對方的金鑰不對".to_string())?
}

/// D 發起：產生一次性金鑰、用 D 的設備金鑰簽。回（一次性金鑰, 簽章）
pub fn d_start(key: &DeviceKey, s: &Session, now_s: i64) -> Result<(Eph, String), String> {
    if !s.live_at(now_s) {
        return Err("到期時間不對".into());
    }
    let eph = Eph::generate()?;
    let sig = key.sign_b64(&s.d_message(eph.public_b64()));
    Ok((eph, sig))
}

/// T 收到請求：用本機記住的 D 公鑰（d_pub）驗，全部驗過才接受。回（T 的一次性公鑰, T 的簽章, 這次的金鑰）
pub fn t_accept(d_pub: &str, key: &DeviceKey, s: &Session, d_eph: &str, d_sig: &str, now_s: i64) -> Result<(String, String, SessionKey), String> {
    if !s.live_at(now_s) {
        return Err("這次觀看已經過期".into());
    }
    if !device_id::verify(d_pub, &s.d_message(d_eph), d_sig) {
        return Err("對方的簽章對不上".into());
    }
    let eph = Eph::generate()?;
    let t_eph = eph.public_b64().to_string();
    let t_sig = key.sign_b64(&s.t_message(d_eph, &t_eph));
    let session_key = derive(eph, s, d_eph, &t_eph, d_eph)?;
    Ok((t_eph, t_sig, session_key))
}

/// D 收到接受：用本機記住的 T 公鑰（t_pub）驗 T 的簽章，導出金鑰
pub fn d_finish(t_pub: &str, eph: Eph, s: &Session, t_eph: &str, t_sig: &str, now_s: i64) -> Result<SessionKey, String> {
    if !s.live_at(now_s) {
        return Err("這次觀看已經過期".into());
    }
    let d_eph = eph.public_b64().to_string();
    if !device_id::verify(t_pub, &s.t_message(&d_eph, t_eph), t_sig) {
        return Err("對方的簽章對不上".into());
    }
    derive(eph, s, &d_eph, t_eph, t_eph)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::PlainFile;

    const NOW: i64 = 1_800_000_000;

    fn key() -> DeviceKey {
        let d = tempfile::tempdir().unwrap();
        device_id::load_or_create(d.path(), &PlainFile).unwrap()
    }
    fn session() -> Session {
        Session { id: "11111111-2222-3333-4444-555555555555".into(), d_node: "d".into(), t_node: "t".into(), window: "小乙".into(), expires_s: NOW + 600 }
    }

    #[test]
    fn 握手成功_兩邊金鑰相同() {
        let (d, t) = (key(), key());
        let s = session();
        let (eph, d_sig) = d_start(&d, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        let (t_eph, t_sig, tk) = t_accept(&d.public_b64(), &t, &s, &d_eph, &d_sig, NOW).unwrap();
        let dk = d_finish(&t.public_b64(), eph, &s, &t_eph, &t_sig, NOW).unwrap();
        assert_eq!(tk.raw(), dk.raw());
    }

    #[test]
    fn 公鑰不是記住的那把_都不接受() {
        let (d, t, other) = (key(), key(), key());
        let s = session();
        let (eph, d_sig) = d_start(&d, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        assert!(t_accept(&other.public_b64(), &t, &s, &d_eph, &d_sig, NOW).is_err(), "T 記住的不是這把 D 公鑰");
        let (t_eph, t_sig, _) = t_accept(&d.public_b64(), &t, &s, &d_eph, &d_sig, NOW).unwrap();
        assert!(d_finish(&other.public_b64(), eph, &s, &t_eph, &t_sig, NOW).is_err(), "D 記住的不是這把 T 公鑰");
    }

    #[test]
    fn 內容被改_t_不接受() {
        let (d, t) = (key(), key());
        let s = session();
        let (eph, d_sig) = d_start(&d, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        for change in [
            |s: &mut Session| s.id = "x".into(),
            |s: &mut Session| s.d_node = "x".into(),
            |s: &mut Session| s.t_node = "x".into(),
            |s: &mut Session| s.window = "x".into(),
            |s: &mut Session| s.expires_s += 1,
        ] {
            let mut other = s.clone();
            change(&mut other);
            assert!(t_accept(&d.public_b64(), &t, &other, &d_eph, &d_sig, NOW).is_err());
        }
        let other_eph = Eph::generate().unwrap();
        assert!(t_accept(&d.public_b64(), &t, &s, other_eph.public_b64(), &d_sig, NOW).is_err(), "換掉一次性公鑰");
    }

    #[test]
    fn t_的簽章不能重放到新的請求() {
        let (d, t) = (key(), key());
        let s = session();
        let (eph1, sig1) = d_start(&d, &s, NOW).unwrap();
        let (t_eph, t_sig, _) = t_accept(&d.public_b64(), &t, &s, eph1.public_b64(), &sig1, NOW).unwrap();
        let (eph2, _) = d_start(&d, &s, NOW).unwrap();
        assert!(d_finish(&t.public_b64(), eph2, &s, &t_eph, &t_sig, NOW).is_err(), "T 的簽章綁著 D 的一次性公鑰");
    }

    #[test]
    fn 到期用本機時鐘查_過期或太長都不行() {
        let (d, t) = (key(), key());
        let s = session();
        let (eph, d_sig) = d_start(&d, &s, NOW).unwrap();
        assert!(t_accept(&d.public_b64(), &t, &s, eph.public_b64(), &d_sig, NOW + 601).is_err(), "過期");
        let long = Session { expires_s: NOW + MAX_LIFETIME_SECS + 1, ..session() };
        assert!(d_start(&d, &long, NOW).is_err(), "太長");
    }

    #[test]
    fn 兩種簽章不能互換() {
        let (d, t) = (key(), key());
        let s = session();
        let (eph, d_sig) = d_start(&d, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        let (t_eph, _, _) = t_accept(&d.public_b64(), &t, &s, &d_eph, &d_sig, NOW).unwrap();
        assert!(d_finish(&d.public_b64(), eph, &s, &t_eph, &d_sig, NOW).is_err(), "D 的簽章不能當 T 的用");
    }
}
