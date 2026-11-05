//! 別台看畫面的握手（#597 工作包 E）。D＝看的那台，T＝被看的那台。這裡只有判斷和密碼學，不碰網路和窗格。
//!
//! - D 用 Windows Hello 的金鑰簽（`ViewSigner`），每次都要本人。**Hello 接上之前這裡一律失敗，** 沒有軟體金鑰的版本：
//!   用軟體金鑰的話，同一台的 AI 不用本人按就能發起，等於沒有這一層。
//! - T 可能沒人在，用設備金鑰簽（`device_id`）。
//! - 兩邊都用本機記的公鑰驗，後台只轉交。權限要對方向：T 查「對方可以看我」，D 查「我可以看對方」。
//! - 簽章涵蓋雙方一次性公鑰、session id、雙方節點、視窗名、範圍、到期時間；T 的簽章包含 D 的一次性公鑰，防重放。
use crate::device_id::{self, DeviceKey, Direction, Trust, Verdict, SCOPE_VIEW};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::{agreement, hkdf};
use zeroize::Zeroizing;

/// 到期最多幾秒（和後台相同，留 30 秒時鐘差）
pub const MAX_LIFETIME_SECS: i64 = 630;
pub const HELLO_NOT_READY: &str = "這台電腦還不能發起觀看";
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

/// 發起觀看的簽章。正式版是 Windows Hello，每次都要本人。簽的可能要等本人按，所以呼叫端要放背景
pub trait ViewSigner {
    fn public_key(&self) -> Result<String, String>;
    fn sign(&self, msg: &[u8]) -> Result<String, String>;
}

/// 驗 D 的簽章（用配對時記下的 Hello 公鑰）
pub trait ViewVerifier {
    fn verify(&self, view_pub: &str, msg: &[u8], sig: &str) -> bool;
}

/// Hello 還沒接上：簽不出來，也不接受任何簽章。實測通過後換成真的實作，協定不用改
pub struct HelloNotReady;

impl ViewSigner for HelloNotReady {
    fn public_key(&self) -> Result<String, String> {
        Err(HELLO_NOT_READY.to_string())
    }
    fn sign(&self, _msg: &[u8]) -> Result<String, String> {
        Err(HELLO_NOT_READY.to_string())
    }
}

impl ViewVerifier for HelloNotReady {
    fn verify(&self, _view_pub: &str, _msg: &[u8], _sig: &str) -> bool {
        false
    }
}

/// 這次觀看的金鑰。兩邊導出來相同，用完就清
pub struct SessionKey(Zeroizing<[u8; 32]>);

impl SessionKey {
    #[cfg(test)]
    fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
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

fn verdict_error(v: Verdict) -> Result<(), String> {
    match v {
        Verdict::Allowed => Ok(()),
        Verdict::KeyChanged => Err(device_id::KEY_CHANGED.to_string()),
        Verdict::Unknown | Verdict::NotGranted => Err("這兩台還沒有配對".to_string()),
    }
}

/// D 發起：查配對、產生一次性金鑰、請本人簽章。回（一次性金鑰, 簽章）
pub fn d_start(trust: &Trust, signer: &dyn ViewSigner, s: &Session, now_s: i64) -> Result<(Eph, String), String> {
    let peer = trust.peer(&s.t_node).ok_or("這兩台還沒有配對")?;
    verdict_error(trust.check(&s.t_node, &peer.sign_pub, Direction::MeToPeer, SCOPE_VIEW))?;
    if !s.live_at(now_s) {
        return Err("到期時間不對".into());
    }
    let eph = Eph::generate()?;
    let sig = signer.sign(&s.d_message(eph.public_b64()))?;
    Ok((eph, sig))
}

/// T 收到請求：全部驗過才接受。回（T 的一次性公鑰, T 的簽章, 這次的金鑰）
pub fn t_accept(trust: &Trust, verifier: &dyn ViewVerifier, key: &DeviceKey, s: &Session, d_eph: &str, d_sig: &str, now_s: i64) -> Result<(String, String, SessionKey), String> {
    if !s.live_at(now_s) {
        return Err("這次觀看已經過期".into());
    }
    let peer = trust.peer(&s.d_node).ok_or("這兩台還沒有配對")?;
    verdict_error(trust.check(&s.d_node, &peer.sign_pub, Direction::PeerToMe, SCOPE_VIEW))?;
    let view_pub = peer.view_pub.as_deref().ok_or("對方還不能發起觀看")?;
    if !verifier.verify(view_pub, &s.d_message(d_eph), d_sig) {
        return Err("對方的簽章對不上".into());
    }
    let eph = Eph::generate()?;
    let t_eph = eph.public_b64().to_string();
    let t_sig = key.sign_b64(&s.t_message(d_eph, &t_eph));
    let session_key = derive(eph, s, d_eph, &t_eph, d_eph)?;
    Ok((t_eph, t_sig, session_key))
}

/// D 收到接受：驗 T 的簽章（用配對時記下的公鑰），導出金鑰
pub fn d_finish(trust: &Trust, eph: Eph, s: &Session, t_eph: &str, t_sig: &str, now_s: i64) -> Result<SessionKey, String> {
    if !s.live_at(now_s) {
        return Err("這次觀看已經過期".into());
    }
    let peer = trust.peer(&s.t_node).ok_or("這兩台還沒有配對")?;
    verdict_error(trust.check(&s.t_node, &peer.sign_pub, Direction::MeToPeer, SCOPE_VIEW))?;
    let d_eph = eph.public_b64().to_string();
    if !device_id::verify(&peer.sign_pub, &s.t_message(&d_eph, t_eph), t_sig) {
        return Err("對方的簽章對不上".into());
    }
    derive(eph, s, &d_eph, t_eph, t_eph)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::PlainFile;

    const NOW: i64 = 1_800_000_000;

    /// 測試用的假 Hello：用另一把設備金鑰當作 Hello。**只在測試裡，** 正式版沒有軟體金鑰的簽章
    struct FakeHello(DeviceKey);
    impl ViewSigner for FakeHello {
        fn public_key(&self) -> Result<String, String> {
            Ok(self.0.public_b64())
        }
        fn sign(&self, msg: &[u8]) -> Result<String, String> {
            Ok(self.0.sign_b64(msg))
        }
    }
    struct FakeVerifier;
    impl ViewVerifier for FakeVerifier {
        fn verify(&self, view_pub: &str, msg: &[u8], sig: &str) -> bool {
            device_id::verify(view_pub, msg, sig)
        }
    }

    fn key() -> DeviceKey {
        let d = tempfile::tempdir().unwrap();
        device_id::load_or_create(d.path(), &PlainFile).unwrap()
    }
    fn session() -> Session {
        Session { id: "11111111-2222-3333-4444-555555555555".into(), d_node: "d".into(), t_node: "t".into(), window: "小乙".into(), expires_s: NOW + 600 }
    }

    struct Rig {
        d_trust: Trust,
        t_trust: Trust,
        hello: FakeHello,
        t_key: DeviceKey,
    }

    /// 兩台已配對：D 可以看 T
    fn rig() -> Rig {
        let (d_key, t_key, hello) = (key(), key(), FakeHello(key()));
        let mut d_trust = Trust::default();
        d_trust.grant("t", "家用機", &t_key.public_b64(), Direction::MeToPeer, SCOPE_VIEW).unwrap();
        let mut t_trust = Trust::default();
        t_trust.grant("d", "工作機", &d_key.public_b64(), Direction::PeerToMe, SCOPE_VIEW).unwrap();
        t_trust.set_view_pub("d", &hello.public_key().unwrap());
        Rig { d_trust, t_trust, hello, t_key }
    }

    #[test]
    fn 握手成功_兩邊金鑰相同() {
        let r = rig();
        let s = session();
        let (eph, d_sig) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        let (t_eph, t_sig, t_key) = t_accept(&r.t_trust, &FakeVerifier, &r.t_key, &s, &d_eph, &d_sig, NOW).unwrap();
        let d_key = d_finish(&r.d_trust, eph, &s, &t_eph, &t_sig, NOW).unwrap();
        assert_eq!(d_key.bytes(), t_key.bytes());
    }

    #[test]
    fn hello_沒接上_發起不了_t_也不接受() {
        let r = rig();
        let s = session();
        assert_eq!(d_start(&r.d_trust, &HelloNotReady, &s, NOW).err().unwrap(), HELLO_NOT_READY);
        let (eph, d_sig) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        assert!(t_accept(&r.t_trust, &HelloNotReady, &r.t_key, &s, eph.public_b64(), &d_sig, NOW).is_err());
    }

    #[test]
    fn 正式程式沒有軟體金鑰的簽章() {
        let src = include_str!("view_handshake.rs");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").or_else(|| src.find("#[cfg(test)]\r\nmod tests")).unwrap()];
        assert_eq!(code.matches("impl ViewSigner for").count(), 1, "只有 HelloNotReady");
        assert!(code.contains("impl ViewSigner for HelloNotReady"));
    }

    #[test]
    fn 內容被改_t_不接受() {
        let r = rig();
        let s = session();
        let (eph, d_sig) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        let changes: [fn(&mut Session); 5] = [
            |s| s.id = "別的".into(),
            |s| s.window = "別的視窗".into(),
            |s| s.expires_s += 1,
            |s| s.t_node = "別台".into(),
            |s| s.d_node = "d2".into(),
        ];
        for change in changes {
            let mut other = session();
            change(&mut other);
            assert!(t_accept(&r.t_trust, &FakeVerifier, &r.t_key, &other, &d_eph, &d_sig, NOW).is_err());
        }
        let other_eph = Eph::generate().unwrap();
        assert!(t_accept(&r.t_trust, &FakeVerifier, &r.t_key, &s, other_eph.public_b64(), &d_sig, NOW).is_err(), "後台換了一次性公鑰");
    }

    #[test]
    fn t_的簽章不能重放到新的請求() {
        let r = rig();
        let s = session();
        let (eph, d_sig) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        let (t_eph, t_sig, _) = t_accept(&r.t_trust, &FakeVerifier, &r.t_key, &s, eph.public_b64(), &d_sig, NOW).unwrap();
        let (eph2, _) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        assert!(d_finish(&r.d_trust, eph2, &s, &t_eph, &t_sig, NOW).is_err(), "D 的一次性公鑰不同");
        let (eph3, _) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        let other = key();
        let forged = other.sign_b64(&s.t_message(eph3.public_b64(), &t_eph));
        assert!(d_finish(&r.d_trust, eph3, &s, &t_eph, &forged, NOW).is_err(), "不是配對時記的那把");
    }

    #[test]
    fn 方向不對_沒配對_金鑰變了_都不行() {
        let r = rig();
        let s = session();
        let (eph, d_sig) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        // T 反過來想看 D：D 那邊只有「我可以看 T」
        let back = Session { d_node: "t".into(), t_node: "d".into(), ..session() };
        assert!(d_start(&r.t_trust, &r.hello, &back, NOW).is_err(), "T 記的是對方可以看我，不是我可以看對方");
        assert!(t_accept(&Trust::default(), &FakeVerifier, &r.t_key, &s, &d_eph, &d_sig, NOW).is_err(), "沒配對");
        assert!(d_start(&Trust::default(), &r.hello, &s, NOW).is_err());
        let mut d_only = Trust::default();
        d_only.grant("d", "工作機", "x", Direction::MeToPeer, SCOPE_VIEW).unwrap();
        assert!(t_accept(&d_only, &FakeVerifier, &r.t_key, &s, &d_eph, &d_sig, NOW).is_err(), "只有反方向");
        let mut no_hello = Trust::default();
        no_hello.grant("d", "工作機", "x", Direction::PeerToMe, SCOPE_VIEW).unwrap();
        assert_eq!(t_accept(&no_hello, &FakeVerifier, &r.t_key, &s, &d_eph, &d_sig, NOW).err().unwrap(), "對方還不能發起觀看");
    }

    #[test]
    fn 到期用本機時鐘查_過期或太長都不行() {
        let r = rig();
        let s = session();
        let (eph, d_sig) = d_start(&r.d_trust, &r.hello, &s, NOW).unwrap();
        let d_eph = eph.public_b64().to_string();
        assert!(t_accept(&r.t_trust, &FakeVerifier, &r.t_key, &s, &d_eph, &d_sig, s.expires_s).is_err(), "到了");
        let long = Session { expires_s: NOW + MAX_LIFETIME_SECS + 1, ..session() };
        assert!(d_start(&r.d_trust, &r.hello, &long, NOW).is_err());
        let (t_eph, t_sig, _) = t_accept(&r.t_trust, &FakeVerifier, &r.t_key, &s, &d_eph, &d_sig, NOW).unwrap();
        assert!(d_finish(&r.d_trust, eph, &s, &t_eph, &t_sig, s.expires_s).is_err());
    }

    #[test]
    fn 兩種簽章不能互換() {
        let s = session();
        assert_ne!(s.d_message("a"), s.t_message("a", ""));
        assert!(String::from_utf8(s.d_message("a")).unwrap().starts_with("asn-view-start-v1\n"));
        assert!(String::from_utf8(s.t_message("a", "b")).unwrap().starts_with("asn-view-accept-v1\n"));
    }
}
