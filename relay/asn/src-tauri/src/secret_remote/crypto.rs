//! 遠端密碼傳遞的加解密（#26 第二期）。全部用 `ring`（X25519、HKDF-SHA256、AES-256-GCM），不自己發明任何密碼學。
//! 格式與理由見 docs/design/SECRET-REMOTE.md「密碼學」一節。
//!
//! - 請求端：[`RequestKey::generate`] 產生一次性鑰匙對；私鑰是 ring 的「臨時私鑰」型別，**不能複製、不能序列化**，
//!   [`RequestKey::open`] 以「值」接收 self，解密（不論成敗）當下就被消耗掉＝私鑰用完即毀。
//! - 本人設備：[`seal`] 用請求公鑰加密；每次用一把新的臨時鑰匙對，沒有任何長期私鑰。
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use ring::{aead, agreement, hkdf};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const VERSION: u8 = 1;
/// 密碼上限（位元組）
pub const MAX_SECRET: usize = 1024;
/// 明文固定長度：2 位元組長度 + 密碼 + 補零，密文長度因此不洩漏密碼長度
const PLAIN_LEN: usize = 2 + MAX_SECRET;
const PUB_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// 整包密文位元組數：版本 + 臨時公鑰 + nonce + 加密後明文 + 驗證標籤
pub const CIPHER_BYTES: usize = 1 + PUB_LEN + NONCE_LEN + PLAIN_LEN + TAG_LEN;
const LABEL: &[u8] = b"asn-secret-v1";

/// 只回籠統原因，不帶任何金鑰、密文、明文內容
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CryptoError {
    /// 請求編號、公鑰、密文的格式不對
    BadInput,
    /// 密碼太長或是空的
    BadSecret,
    /// 系統亂數或金鑰協議失敗（含低階點／全零共用秘密）
    Key,
    /// 解不開：金鑰不對、被竄改、編號對不上
    Decrypt,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CryptoError::BadInput => "密文或請求資料的格式不對",
            CryptoError::BadSecret => "密碼是空的或太長",
            CryptoError::Key => "金鑰協議失敗",
            CryptoError::Decrypt => "解密失敗（金鑰不對或內容被改過）",
        })
    }
}

struct Len32;
impl hkdf::KeyType for Len32 {
    fn len(&self) -> usize {
        32
    }
}

fn norm_id(req_id: &str) -> Result<Vec<u8>, CryptoError> {
    if !crate::attach::is_uuid(req_id) {
        return Err(CryptoError::BadInput);
    }
    Ok(req_id.to_ascii_lowercase().into_bytes())
}

fn pub_bytes(b64: &str) -> Result<[u8; PUB_LEN], CryptoError> {
    let v = B64.decode(b64).map_err(|_| CryptoError::BadInput)?;
    let a: [u8; PUB_LEN] = v.try_into().map_err(|_| CryptoError::BadInput)?;
    // 全零公鑰是低階點，共用秘密會是全零；明確擋下（ring 本身也會擋，這裡先擋讓錯誤更明確）
    if a.iter().all(|b| *b == 0) {
        return Err(CryptoError::Key);
    }
    Ok(a)
}

/// 公鑰指紋：公鑰位元組的 SHA-256 前 4 位元組，寫成 `ab12-cd34`。確認窗與請求端各算一次，請人核對
pub fn fingerprint(pub_b64: &str) -> String {
    match B64.decode(pub_b64) {
        Ok(raw) => {
            let h = Sha256::digest(&raw);
            format!("{:02x}{:02x}-{:02x}{:02x}", h[0], h[1], h[2], h[3])
        }
        Err(_) => "????-????".to_string(),
    }
}

/// 金鑰導出＋AAD 的共同輸入
fn derive(ikm: &[u8], id: &[u8], req_pub: &[u8], eph_pub: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if ikm.iter().all(|b| *b == 0) {
        return Err(CryptoError::Key);
    }
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, id).extract(ikm);
    let info = [LABEL, id, req_pub, eph_pub];
    let okm = prk.expand(&info, Len32).map_err(|_| CryptoError::Key)?;
    let mut key = Zeroizing::new([0u8; 32]);
    okm.fill(&mut key[..]).map_err(|_| CryptoError::Key)?;
    Ok(key)
}

fn aad(id: &[u8]) -> aead::Aad<Vec<u8>> {
    let mut a = LABEL.to_vec();
    a.extend_from_slice(id);
    aead::Aad::from(a)
}

fn aead_key(key: &[u8; 32]) -> Result<aead::LessSafeKey, CryptoError> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key).map(aead::LessSafeKey::new).map_err(|_| CryptoError::Key)
}

/// 本人設備端：用請求公鑰加密密碼，回 base64url 密文。`req_id` 是後台給的請求編號
pub fn seal(req_id: &str, req_pub_b64: &str, secret: &[u8]) -> Result<String, CryptoError> {
    if secret.is_empty() || secret.len() > MAX_SECRET {
        return Err(CryptoError::BadSecret);
    }
    let id = norm_id(req_id)?;
    let req_pub = pub_bytes(req_pub_b64)?;
    let rng = SystemRandom::new();
    let eph = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).map_err(|_| CryptoError::Key)?;
    let eph_pub = eph.compute_public_key().map_err(|_| CryptoError::Key)?;
    let eph_pub = eph_pub.as_ref().to_vec();
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, &req_pub[..]);
    let key = agreement::agree_ephemeral(eph, &peer, |ikm| derive(ikm, &id, &req_pub, &eph_pub)).map_err(|_| CryptoError::Key)??;
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce).map_err(|_| CryptoError::Key)?;
    let mut plain = Zeroizing::new(vec![0u8; PLAIN_LEN]);
    plain[..2].copy_from_slice(&(secret.len() as u16).to_be_bytes());
    plain[2..2 + secret.len()].copy_from_slice(secret);
    let sealing = aead_key(&key)?;
    let tag = sealing
        .seal_in_place_separate_tag(aead::Nonce::assume_unique_for_key(nonce), aad(&id), &mut plain[..])
        .map_err(|_| CryptoError::Key)?;
    let mut out = Vec::with_capacity(CIPHER_BYTES);
    out.push(VERSION);
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&plain[..]);
    out.extend_from_slice(tag.as_ref());
    debug_assert_eq!(out.len(), CIPHER_BYTES);
    Ok(B64.encode(out))
}

/// 請求端的一次性鑰匙對。私鑰只存在這個值裡，沒有 Clone、沒有序列化、除錯輸出不印任何東西
pub struct RequestKey {
    private: agreement::EphemeralPrivateKey,
    public: [u8; PUB_LEN],
}

impl std::fmt::Debug for RequestKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestKey(<已隱藏>)")
    }
}

impl RequestKey {
    pub fn generate() -> Result<RequestKey, CryptoError> {
        let rng = SystemRandom::new();
        let private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).map_err(|_| CryptoError::Key)?;
        let p = private.compute_public_key().map_err(|_| CryptoError::Key)?;
        let public: [u8; PUB_LEN] = p.as_ref().try_into().map_err(|_| CryptoError::Key)?;
        Ok(RequestKey { private, public })
    }

    pub fn public_b64(&self) -> String {
        B64.encode(self.public)
    }

    /// 解密並**消耗**這把鑰匙：不論成功失敗，私鑰都在這個函式結束時銷毀，不能再試第二次。
    /// 失敗只回籠統原因；成功回密碼位元組（離開作用域時清零）
    pub fn open(self, req_id: &str, cipher_b64: &str) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let id = norm_id(req_id)?;
        let raw = Zeroizing::new(B64.decode(cipher_b64).map_err(|_| CryptoError::BadInput)?);
        if raw.len() != CIPHER_BYTES || raw[0] != VERSION {
            return Err(CryptoError::BadInput);
        }
        let eph_pub: [u8; PUB_LEN] = raw[1..1 + PUB_LEN].try_into().map_err(|_| CryptoError::BadInput)?;
        if eph_pub.iter().all(|b| *b == 0) {
            return Err(CryptoError::Key);
        }
        let nonce: [u8; NONCE_LEN] = raw[1 + PUB_LEN..1 + PUB_LEN + NONCE_LEN].try_into().map_err(|_| CryptoError::BadInput)?;
        let mut buf = Zeroizing::new(raw[1 + PUB_LEN + NONCE_LEN..].to_vec());
        let my_pub = self.public;
        let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, &eph_pub[..]);
        let key = agreement::agree_ephemeral(self.private, &peer, |ikm| derive(ikm, &id, &my_pub, &eph_pub)).map_err(|_| CryptoError::Key)??;
        let opening = aead_key(&key)?;
        let plain = opening
            .open_in_place(aead::Nonce::assume_unique_for_key(nonce), aad(&id), &mut buf[..])
            .map_err(|_| CryptoError::Decrypt)?;
        if plain.len() != PLAIN_LEN {
            return Err(CryptoError::Decrypt);
        }
        let n = u16::from_be_bytes([plain[0], plain[1]]) as usize;
        if n == 0 || n > MAX_SECRET || plain[2 + n..].iter().any(|b| *b != 0) {
            return Err(CryptoError::Decrypt);
        }
        Ok(Zeroizing::new(plain[2..2 + n].to_vec()))
    }
}
