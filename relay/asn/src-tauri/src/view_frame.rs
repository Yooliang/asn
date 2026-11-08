//! 看別台終端時「收的一方（D）」的幀格式與解密（全平台都編）：加解密、擋重放、再過濾一次。
//! 只有純邏輯，不碰視窗、不碰網路、不碰本機檔案；送的一方（T）與傳輸留在 `view_stream`（電腦版）。
#![cfg_attr(not(test), allow(dead_code))]
use crate::term_frame::filter_frame;
use crate::view_handshake::SessionKey;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::aead;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

/// D 連續解不開幾幅就結束
pub const BAD_FRAMES_END: u32 = 5;
/// 一幅明文上限。窗格只有一個畫面，正常遠低於這個數字
pub const MAX_FRAME_BYTES: usize = 128 * 1024;
const NONCE_LEN: usize = 12;
const SEQ_LEN: usize = 8;

/// 一幅的內容
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub text: String,
    pub cursor_x: i64,
    pub cursor_y: i64,
    pub cols: u32,
    pub rows: u32,
    /// 打字時：已經交給窗格到第幾號（D 用來確認、補送）。看畫面時沒有
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ack: Option<u64>,
}

/// AAD：session id、方向、序號。方向只有 T→D
fn aad(session_id: &str, seq: u64) -> Vec<u8> {
    format!("asn-view-frame-v1|{session_id}|t2d|{seq}").into_bytes()
}

fn aead_key(key: &SessionKey) -> Result<aead::LessSafeKey, String> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key.raw()).map(aead::LessSafeKey::new).map_err(|_| "金鑰不對".to_string())
}

/// 加密一幅：`seq + nonce + 密文`，再 base64
pub fn seal_frame(key: &SessionKey, session_id: &str, seq: u64, plain: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "產生亂數失敗".to_string())?;
    let mut buf = plain.to_vec();
    aead_key(key)?
        .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad(session_id, seq)), &mut buf)
        .map_err(|_| "加密失敗".to_string())?;
    let mut out = Vec::with_capacity(SEQ_LEN + NONCE_LEN + buf.len());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(B64.encode(out))
}

/// 解開一幅。回（序號, 明文）。失敗只回籠統原因，不帶內容
pub fn open_frame(key: &SessionKey, session_id: &str, wire: &str) -> Result<(u64, Vec<u8>), String> {
    let raw = B64.decode(wire).map_err(|_| "格式不對".to_string())?;
    if raw.len() < SEQ_LEN + NONCE_LEN {
        return Err("格式不對".into());
    }
    let (head, rest) = raw.split_at(SEQ_LEN);
    let (nonce, cipher) = rest.split_at(NONCE_LEN);
    let seq = u64::from_be_bytes(head.try_into().map_err(|_| "格式不對".to_string())?);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| "格式不對".to_string())?;
    let mut buf = cipher.to_vec();
    let plain = aead_key(key)?
        .open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad(session_id, seq)), &mut buf)
        .map_err(|_| "解不開".to_string())?;
    Ok((seq, plain.to_vec()))
}

/// D 收到一幅的結果
#[derive(Debug, PartialEq)]
pub enum Received {
    Frame(u64, Frame),
    /// 亂序、重放、壞的：丟掉
    Dropped,
    /// 連續解不開太多幅：結束這次觀看
    TooManyBad,
}

/// D 收幀：解密、擋重放、再過濾一次（對方的設備也不能完全信任）
pub struct DReceiver {
    key: SessionKey,
    session_id: String,
    last_seq: u64,
    bad: u32,
}

impl DReceiver {
    pub fn new(key: SessionKey, session_id: &str) -> Self {
        DReceiver { key, session_id: session_id.to_string(), last_seq: 0, bad: 0 }
    }

    pub fn receive(&mut self, wire: &str) -> Received {
        match open_frame(&self.key, &self.session_id, wire).and_then(|(seq, p)| serde_json::from_slice::<Frame>(&p).map(|f| (seq, f)).map_err(|_| "格式不對".to_string())) {
            Ok((seq, _)) if seq <= self.last_seq => Received::Dropped,
            Ok((seq, f)) => {
                self.bad = 0;
                self.last_seq = seq;
                Received::Frame(seq, Frame { text: filter_frame(&f.text), ..f })
            }
            Err(_) => {
                self.bad += 1;
                if self.bad >= BAD_FRAMES_END {
                    Received::TooManyBad
                } else {
                    Received::Dropped
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view_handshake::test_key;

    const SECRET: &str = "SECRET-PASSWORD-123";

    fn frame(text: &str) -> Frame {
        Frame { text: text.to_string(), cursor_x: 1, cursor_y: 2, cols: 120, rows: 40, ack: None }
    }
    fn pair() -> (SessionKey, SessionKey) {
        (test_key(7), test_key(7))
    }

    #[test]
    fn 加解密_來回_內容綁_session_和序號() {
        let (a, b) = pair();
        let w = seal_frame(&a, "s1", 3, b"hello").unwrap();
        assert_eq!(open_frame(&b, "s1", &w).unwrap(), (3, b"hello".to_vec()));
        assert!(open_frame(&b, "s2", &w).is_err(), "別的 session");
        assert!(open_frame(&test_key(8), "s1", &w).is_err(), "別的金鑰");
        // 把序號改掉：AAD 對不上
        let mut raw = B64.decode(&w).unwrap();
        raw[7] ^= 1;
        assert!(open_frame(&b, "s1", &B64.encode(&raw)).is_err());
        assert!(open_frame(&b, "s1", "壞的").is_err());
        assert!(open_frame(&b, "s1", "AAAA").is_err());
    }

    #[test]
    fn 密文裡看不到明文() {
        let (a, _) = pair();
        let w = seal_frame(&a, "s1", 1, SECRET.as_bytes()).unwrap();
        let raw = B64.decode(&w).unwrap();
        assert!(!raw.windows(SECRET.len()).any(|x| x == SECRET.as_bytes()));
    }

    #[test]
    fn d_擋重放和亂序_再過濾一次_連續壞太多就結束() {
        let (a, b) = pair();
        let mut r = DReceiver::new(b, "s1");
        let enc = |seq, text: &str| seal_frame(&a, "s1", seq, &serde_json::to_vec(&frame(text)).unwrap()).unwrap();
        let w2 = enc(2, "乙\x1b[6n");
        match r.receive(&w2) {
            Received::Frame(2, got) => assert_eq!(got.text, "乙", "收到也要再過濾"),
            other => panic!("{other:?}"),
        }
        assert_eq!(r.receive(&w2), Received::Dropped, "重放");
        assert_eq!(r.receive(&enc(1, "舊")), Received::Dropped, "亂序");
        for _ in 0..BAD_FRAMES_END - 1 {
            assert_eq!(r.receive("壞的"), Received::Dropped);
        }
        assert!(matches!(r.receive(&enc(3, "好")), Received::Frame(3, _)), "好的一幅會歸零");
        for _ in 0..BAD_FRAMES_END - 1 {
            assert_eq!(r.receive("壞的"), Received::Dropped);
        }
        assert_eq!(r.receive("壞的"), Received::TooManyBad);
    }
}
