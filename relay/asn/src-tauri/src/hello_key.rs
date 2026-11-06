//! 發起觀看用的 Hello 公鑰：格式檢查與驗章（#597 別台看畫面 PR 4）。所有平台都有，被看的那台（T）用這裡驗。
//!
//! - 這裡**只驗、不簽**。正式碼沒有軟體 RSA 私鑰；簽章只在 `hello_win`（Windows Hello，每次都要本人）。
//! - 公鑰是 RSA，格式為 PKCS#1 `RSAPublicKey` 的 DER，再 base64url。至少 2048 位元，最多 8192。
//! - 格式檢查（[`valid_view_pub`]）所有平台都有，配對時用；驗章只在電腦版。
//! - 簽章格式只認一種（[`HELLO_SIG_ALG`]），不做兩種都試，免得被降級。
#![cfg_attr(not(test), allow(dead_code))]
#[cfg(desktop)]
use crate::view_handshake::ViewVerifier;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::signature::{self, RsaParameters, UnparsedPublicKey};

/// Hello 簽章的格式。**待實測定案**（PKCS#1 v1.5 或 PSS，見私有設計檔），定案後只留一種
pub static HELLO_SIG_ALG: &RsaParameters = &signature::RSA_PKCS1_2048_8192_SHA256;
pub const MIN_BITS: usize = 2048;
pub const MAX_BITS: usize = 8192;
/// base64 長度範圍（和後台相同）
pub const MIN_B64: usize = 200;
pub const MAX_B64: usize = 1400;
pub const BAD_VIEW_PUB: &str = "那台電腦的 Hello 公鑰不對，不能配對";

/// 讀 DER 的長度欄位，回（長度, 用掉幾個位元組）
fn der_len(b: &[u8]) -> Option<(usize, usize)> {
    let first = *b.first()?;
    if first < 0x80 {
        return Some((first as usize, 1));
    }
    let n = (first & 0x7f) as usize;
    if n == 0 || n > 2 || b.len() < 1 + n {
        return None;
    }
    let len = b[1..=n].iter().fold(0usize, |acc, &x| (acc << 8) | x as usize);
    if len < 0x80 || (n == 2 && len < 0x100) {
        return None; // 不是最短寫法
    }
    Some((len, 1 + n))
}

/// 讀一個正的 INTEGER，回（去掉前導 0 的內容, 用掉幾個位元組）
fn der_uint(b: &[u8]) -> Option<(&[u8], usize)> {
    if *b.first()? != 0x02 {
        return None;
    }
    let (len, used) = der_len(&b[1..])?;
    let start = 1 + used;
    let v = b.get(start..start + len)?;
    if v.is_empty() || v[0] & 0x80 != 0 {
        return None; // 空的或負的
    }
    let v = if v[0] == 0 {
        if v.len() < 2 || v[1] & 0x80 == 0 {
            return None; // 多餘的前導 0
        }
        &v[1..]
    } else {
        v
    };
    Some((v, start + len))
}

/// PKCS#1 `RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }`：回模數的位元數。不是剛好這個結構就回 None
pub fn rsa_modulus_bits(der: &[u8]) -> Option<usize> {
    if *der.first()? != 0x30 {
        return None;
    }
    let (len, used) = der_len(&der[1..])?;
    let body = der.get(1 + used..)?;
    if body.len() != len {
        return None; // 後面有多的或不夠
    }
    let (n, n_used) = der_uint(body)?;
    let (e, e_used) = der_uint(&body[n_used..])?;
    if n_used + e_used != body.len() || e.len() > 4 {
        return None;
    }
    Some((n.len() - 1) * 8 + (8 - n[0].leading_zeros() as usize))
}

/// T 收到配對請求時先驗 D 的 Hello 公鑰：base64url、長度、RSA 結構、2048～8192 位元。不合就拒絕配對
pub fn valid_view_pub(b64: &str) -> bool {
    if !(MIN_B64..=MAX_B64).contains(&b64.len()) {
        return false;
    }
    let Ok(der) = B64.decode(b64) else { return false };
    rsa_modulus_bits(&der).is_some_and(|bits| (MIN_BITS..=MAX_BITS).contains(&bits))
}

/// 用配對時記下的 Hello 公鑰驗 D 的簽章
pub struct HelloVerifier;

#[cfg(desktop)]
impl ViewVerifier for HelloVerifier {
    fn verify(&self, view_pub: &str, msg: &[u8], sig: &str) -> bool {
        if !valid_view_pub(view_pub) {
            return false;
        }
        let (Ok(der), Ok(sig)) = (B64.decode(view_pub), B64.decode(sig)) else { return false };
        UnparsedPublicKey::new(HELLO_SIG_ALG, der).verify(msg, &sig).is_ok()
    }
}

#[cfg(test)]
mod tests {
    //! 測試金鑰只放在 tests/fixtures/hello-rsa（檔名就寫 test-only），正式碼讀不到
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{KeyPair, RsaKeyPair};

    const KEY_A: &[u8] = include_bytes!("../tests/fixtures/hello-rsa/test-only-2048-a.p8");
    const KEY_B: &[u8] = include_bytes!("../tests/fixtures/hello-rsa/test-only-2048-b.p8");
    const PUB_1024: &[u8] = include_bytes!("../tests/fixtures/hello-rsa/test-only-1024.pub");

    fn pair(p8: &[u8]) -> RsaKeyPair {
        RsaKeyPair::from_pkcs8(p8).unwrap()
    }
    fn pub_b64(k: &RsaKeyPair) -> String {
        B64.encode(k.public_key().as_ref())
    }
    fn sign(k: &RsaKeyPair, alg: &'static dyn signature::RsaEncoding, msg: &[u8]) -> String {
        let mut sig = vec![0u8; k.public().modulus_len()];
        k.sign(alg, &SystemRandom::new(), msg, &mut sig).unwrap();
        B64.encode(sig)
    }

    #[test]
    fn 公鑰_2048_位元的_rsa_才收_1024_或亂資料都拒絕() {
        let a = pair(KEY_A);
        assert_eq!(rsa_modulus_bits(a.public_key().as_ref()), Some(2048));
        assert!(valid_view_pub(&pub_b64(&a)));
        assert_eq!(rsa_modulus_bits(PUB_1024), Some(1024));
        assert!(!valid_view_pub(&B64.encode(PUB_1024)), "1024 位元不收");
        assert!(!valid_view_pub(&"A".repeat(360)), "不是 DER");
        assert!(!valid_view_pub(""));
        assert!(!valid_view_pub(&"A".repeat(MAX_B64 + 1)));
        let mut extra = a.public_key().as_ref().to_vec();
        extra.push(0);
        assert!(!valid_view_pub(&B64.encode(&extra)), "後面多東西");
        let der = a.public_key().as_ref();
        assert!(!valid_view_pub(&B64.encode(&der[..der.len() - 1])), "少一個位元組");
        assert!(!valid_view_pub(&format!("{}=", pub_b64(&a))), "不是 base64url 無填充");
    }

    #[test]
    fn 驗章_對的金鑰和內容才過_改一個位元_換金鑰_換格式都不過() {
        let (a, b) = (pair(KEY_A), pair(KEY_B));
        let msg = b"asn-view-start-v1|s1|d|t";
        let good = sign(&a, hello_enc(), msg);
        assert!(HelloVerifier.verify(&pub_b64(&a), msg, &good));
        assert!(!HelloVerifier.verify(&pub_b64(&a), b"asn-view-start-v1|s2|d|t", &good), "內容不同");
        let mut raw = B64.decode(&good).unwrap();
        raw[10] ^= 1;
        assert!(!HelloVerifier.verify(&pub_b64(&a), msg, &B64.encode(&raw)), "改一個位元");
        assert!(!HelloVerifier.verify(&pub_b64(&b), msg, &good), "別把金鑰");
        assert!(!HelloVerifier.verify(&pub_b64(&a), msg, &sign(&a, other_enc(), msg)), "另一種格式不收：只認一種");
        assert!(!HelloVerifier.verify(&B64.encode(PUB_1024), msg, &good), "短金鑰不驗");
        assert!(!HelloVerifier.verify(&pub_b64(&a), msg, ""));
    }

    /// 和 [`HELLO_SIG_ALG`] 對應的簽法，以及另一種（實測定案時兩個一起換）
    fn hello_enc() -> &'static dyn signature::RsaEncoding {
        &signature::RSA_PKCS1_SHA256
    }
    fn other_enc() -> &'static dyn signature::RsaEncoding {
        &signature::RSA_PSS_SHA256
    }

    /// 正式碼＝第一個頂層 `mod tests {` 之前（測試模組都放在檔尾）
    fn production(src: &str) -> &str {
        src.split("
mod tests {").next().unwrap()
    }

    fn sources() -> Vec<(String, String)> {
        fn walk(d: &std::path::Path, out: &mut Vec<(String, String)>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push((p.to_string_lossy().replace('\\', "/"), std::fs::read_to_string(&p).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
        out
    }

    #[test]
    fn 守門_正式碼沒有軟體_rsa_私鑰_viewsigner_只有兩個() {
        let mut signers = Vec::new();
        for (path, src) in sources() {
            let code = production(&src);
            assert!(!code.contains("RsaKeyPair"), "{path}：正式碼不能有軟體 RSA 私鑰");
            assert!(!code.contains("hello-rsa"), "{path}：正式碼不能讀測試金鑰");
            for line in code.lines().filter(|l| l.trim_start().starts_with("impl ViewSigner for")) {
                signers.push(line.trim().to_string());
            }
        }
        signers.sort();
        assert_eq!(signers, ["impl ViewSigner for HelloNotReady {", "impl ViewSigner for WinHello {"], "只有「還沒接上」和 Windows Hello");
    }

    #[test]
    fn 守門_hello_只有本人按的入口能叫_背景流程叫不到() {
        // 本人按的兩個入口：「配對這台」（取得或建立公鑰）、「看畫面」（簽章）
        const ENTRIES: [&str; 2] = ["device_pair_start", "term_view_remote_start"];
        // 不建金鑰、不簽章的：問支不支援、辨認「沒設 PIN」的錯誤，哪裡都能用
        const HARMLESS: [&str; 2] = ["hello_win::supported", "hello_win::NO_PIN"];
        for (path, src) in sources() {
            if path.ends_with("/hello_win.rs") {
                continue;
            }
            let code = production(&src);
            if !path.ends_with("/lib.rs") {
                assert!(!code.contains("hello_win::") && !code.contains("WinHello"), "{path}：只有 lib.rs 的本人入口能用 Hello");
                continue;
            }
            for (i, _) in code.match_indices("hello_win::") {
                if HARMLESS.iter().any(|h| code[i..].starts_with(h)) {
                    continue;
                }
                let before = &code[..i];
                let f = before.rfind("\nasync fn ").max(before.rfind("\nfn ")).expect("在函式裡");
                let name: String = before[f..].trim_start_matches('\n').trim_start_matches("async ").trim_start_matches("fn ").chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                assert!(ENTRIES.contains(&name.as_str()), "lib.rs 的 {name} 不是本人入口，不能叫 Hello");
            }
            assert!(!code.contains("use crate::hello_win") && !code.contains("use hello_win"), "不能整個匯入，入口要看得出來");
        }
    }
}
