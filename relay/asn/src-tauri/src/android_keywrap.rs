//! 手機的設備金鑰保護：用系統金鑰庫（Android Keystore）裡一把不可匯出的 AES-256-GCM 金鑰，包住 device_key.bin 的內容。
//!
//! - 包裝金鑰留在金鑰庫裡、App 拿不到金鑰本身，只能請金鑰庫加解密；檔案內容前面加 [`PREFIX`]。
//! - 讀到沒有前綴的舊檔（舊版存的）照舊讀出，由 `device_id::load_or_create` 順手包起來寫回。
//! - 包裝金鑰確定不見了（例如金鑰庫被重置）回 [`KEY_LOST`]，呼叫端才會重產設備金鑰；其他錯誤一律當暫時的，不覆蓋。
//! - 手機的設備金鑰不讓別台看畫面：前綴和 Linux 的不同，`keystore::device_key_sealed` 不會把它當成「已包過」。
//! - 加解密本體（[`Aead`]）可以換假的測試；真的那份只在安卓建置裡（JNI 直接呼叫系統的 Java 類別，沒有自己的 Kotlin）。
#![cfg_attr(not(target_os = "android"), allow(dead_code))]
use crate::auth::Protector;

/// 手機包過的檔案開頭（不是 keystore.rs 的 `ss1:`）
pub const PREFIX: &[u8] = b"ak1:";
/// 檔案內容綁定的用途與檔名：換成別的檔案內容就解不開
pub const AAD: &[u8] = b"asn-device-key-v1:device_key.bin";
/// 包裝金鑰在金鑰庫裡的名字
pub const ALIAS: &str = "asn_device_key_wrap";
/// 包裝金鑰確定不在金鑰庫裡了
pub const KEY_LOST: &str = "手機金鑰庫裡找不到這台的包裝金鑰";

/// 金鑰庫的加解密：包裝金鑰不出金鑰庫。輸出自己帶 nonce
pub trait Aead: Send + Sync {
    fn seal(&self, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String>;
    /// 要不要把明文檔改存成加密、新寫的檔要不要加密。false＝只負責「讀得懂已加密的檔」（電腦版 0.2.20 預設，見 secret_file.rs）
    fn sealing(&self) -> bool {
        true
    }
}

pub struct KeyWrap<A: Aead>(pub A);

impl<A: Aead> Protector for KeyWrap<A> {
    fn seals(&self) -> bool {
        true
    }
    fn wrapped(&self, sealed: &[u8]) -> bool {
        sealed.starts_with(PREFIX)
    }
    fn key_lost(&self, err: &str) -> bool {
        err == KEY_LOST
    }
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = PREFIX.to_vec();
        out.extend(self.0.seal(AAD, plain)?);
        Ok(out)
    }
    /// 有前綴：一定要請金鑰庫解開（不降級）。沒有前綴：是舊的明文檔，照舊讀，呼叫端負責升級
    fn unprotect(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        match sealed.strip_prefix(PREFIX) {
            Some(body) => self.0.open(AAD, body),
            None => Ok(sealed.to_vec()),
        }
    }
}

/// 手機用的保護：金鑰庫那把
#[cfg(target_os = "android")]
pub fn android_protector() -> Box<dyn Protector> {
    Box::new(KeyWrap(jni_backend::KeystoreAead))
}

/// 手機用的金鑰庫加解密本體（節點金鑰、登入資料各自帶自己的 AAD，見 secret_file.rs）
#[cfg(target_os = "android")]
pub fn android_aead() -> Box<dyn Aead> {
    Box::new(jni_backend::KeystoreAead)
}

/// 真的金鑰庫：用 JNI 呼叫 java.security.KeyStore／javax.crypto.Cipher（系統類別，任何執行緒都找得到）
#[cfg(target_os = "android")]
mod jni_backend {
    use super::{Aead, ALIAS, KEY_LOST};
    use jni::errors::Result as JResult;
    use jni::objects::{JByteArray, JObject, JValue};
    use jni::{JNIEnv, JavaVM};

    const IV_LEN: usize = 12;
    const TAG_BITS: i32 = 128;
    const ENCRYPT: i32 = 1;
    const DECRYPT: i32 = 2;
    /// KeyProperties.PURPOSE_ENCRYPT | PURPOSE_DECRYPT
    const PURPOSES: i32 = 3;

    pub struct KeystoreAead;

    /// 附掛到 JVM 執行緒跑一段；出了 Java 例外就清掉再回錯誤（不留著例外讓之後的呼叫壞掉）
    fn run<T>(f: impl FnOnce(&mut JNIEnv<'_>) -> JResult<T>) -> Result<T, String> {
        let ctx = ndk_context::android_context();
        if ctx.vm().is_null() {
            return Err("手機金鑰庫還沒準備好".to_string());
        }
        // SAFETY: ndk_context 由應用程式啟動時填入，vm 指標在整個程序存活期間有效
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("手機金鑰庫連不上：{e}"))?;
        let mut env = vm.attach_current_thread().map_err(|e| format!("手機金鑰庫連不上：{e}"))?;
        match f(&mut env) {
            Ok(v) => Ok(v),
            Err(e) => {
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                Err(format!("手機金鑰庫操作失敗：{e}"))
            }
        }
    }

    fn jstr<'a>(env: &mut JNIEnv<'a>, s: &str) -> JResult<JObject<'a>> {
        Ok(env.new_string(s)?.into())
    }

    fn str_array<'a>(env: &mut JNIEnv<'a>, s: &str) -> JResult<JObject<'a>> {
        let item = jstr(env, s)?;
        Ok(env.new_object_array(1, "java/lang/String", &item)?.into())
    }

    fn keystore<'a>(env: &mut JNIEnv<'a>) -> JResult<JObject<'a>> {
        let t = jstr(env, "AndroidKeyStore")?;
        let ks = env.call_static_method("java/security/KeyStore", "getInstance", "(Ljava/lang/String;)Ljava/security/KeyStore;", &[JValue::Object(&t)])?.l()?;
        env.call_method(&ks, "load", "(Ljava/security/KeyStore$LoadStoreParameter;)V", &[JValue::Object(&JObject::null())])?;
        Ok(ks)
    }

    fn has_alias(env: &mut JNIEnv<'_>, ks: &JObject<'_>) -> JResult<bool> {
        let a = jstr(env, ALIAS)?;
        env.call_method(ks, "containsAlias", "(Ljava/lang/String;)Z", &[JValue::Object(&a)])?.z()
    }

    /// 金鑰庫裡建一把不可匯出的 AES-256-GCM（只能加解密、不需要本人驗證）
    fn generate(env: &mut JNIEnv<'_>) -> JResult<()> {
        let alias = jstr(env, ALIAS)?;
        let spec_b = "android/security/keystore/KeyGenParameterSpec$Builder";
        let b = env.new_object(spec_b, "(Ljava/lang/String;I)V", &[JValue::Object(&alias), JValue::Int(PURPOSES)])?;
        let ret = "Landroid/security/keystore/KeyGenParameterSpec$Builder;";
        let modes = str_array(env, "GCM")?;
        let b = env.call_method(&b, "setBlockModes", &format!("([Ljava/lang/String;){ret}"), &[JValue::Object(&modes)])?.l()?;
        let pads = str_array(env, "NoPadding")?;
        let b = env.call_method(&b, "setEncryptionPaddings", &format!("([Ljava/lang/String;){ret}"), &[JValue::Object(&pads)])?.l()?;
        let b = env.call_method(&b, "setKeySize", &format!("(I){ret}"), &[JValue::Int(256)])?.l()?;
        let spec = env.call_method(&b, "build", "()Landroid/security/keystore/KeyGenParameterSpec;", &[])?.l()?;
        let algo = jstr(env, "AES")?;
        let prov = jstr(env, "AndroidKeyStore")?;
        let kg = env.call_static_method("javax/crypto/KeyGenerator", "getInstance", "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;", &[JValue::Object(&algo), JValue::Object(&prov)])?.l()?;
        env.call_method(&kg, "init", "(Ljava/security/spec/AlgorithmParameterSpec;)V", &[JValue::Object(&spec)])?;
        env.call_method(&kg, "generateKey", "()Ljavax/crypto/SecretKey;", &[])?;
        Ok(())
    }

    fn get_key<'a>(env: &mut JNIEnv<'a>, ks: &JObject<'a>) -> JResult<JObject<'a>> {
        let a = jstr(env, ALIAS)?;
        env.call_method(ks, "getKey", "(Ljava/lang/String;[C)Ljava/security/Key;", &[JValue::Object(&a), JValue::Object(&JObject::null())])?.l()
    }

    fn cipher<'a>(env: &mut JNIEnv<'a>) -> JResult<JObject<'a>> {
        let t = jstr(env, "AES/GCM/NoPadding")?;
        env.call_static_method("javax/crypto/Cipher", "getInstance", "(Ljava/lang/String;)Ljavax/crypto/Cipher;", &[JValue::Object(&t)])?.l()
    }

    fn do_final(env: &mut JNIEnv<'_>, c: &JObject<'_>, input: &[u8]) -> JResult<Vec<u8>> {
        let inp = env.byte_array_from_slice(input)?;
        let out = env.call_method(c, "doFinal", "([B)[B", &[JValue::Object(&inp)])?.l()?;
        env.convert_byte_array(JByteArray::from(out))
    }

    impl Aead for KeystoreAead {
        /// 輸出：nonce（12 位元組）＋密文
        fn seal(&self, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
            run(|env| {
                let ks = keystore(env)?;
                if !has_alias(env, &ks)? {
                    generate(env)?;
                }
                let key = get_key(env, &ks)?;
                let c = cipher(env)?;
                env.call_method(&c, "init", "(ILjava/security/Key;)V", &[JValue::Int(ENCRYPT), JValue::Object(&key)])?;
                let a = env.byte_array_from_slice(aad)?;
                env.call_method(&c, "updateAAD", "([B)V", &[JValue::Object(&a)])?;
                let iv_obj = env.call_method(&c, "getIV", "()[B", &[])?.l()?;
                let mut out = env.convert_byte_array(JByteArray::from(iv_obj))?;
                out.extend(do_final(env, &c, plain)?);
                Ok(out)
            })
        }

        fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
            if sealed.len() <= IV_LEN {
                return Err("設備金鑰壞了".to_string());
            }
            let (iv, ct) = sealed.split_at(IV_LEN);
            // 先看包裝金鑰還在不在：不在才是「確定不見了」，其他錯誤（解不開、金鑰庫忙）都不算
            let present = run(|env| {
                let ks = keystore(env)?;
                has_alias(env, &ks)
            })?;
            if !present {
                return Err(KEY_LOST.to_string());
            }
            run(|env| {
                let ks = keystore(env)?;
                let key = get_key(env, &ks)?;
                let c = cipher(env)?;
                let iv_arr = env.byte_array_from_slice(iv)?;
                let spec = env.new_object("javax/crypto/spec/GCMParameterSpec", "(I[B)V", &[JValue::Int(TAG_BITS), JValue::Object(&iv_arr)])?;
                env.call_method(&c, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", &[JValue::Int(DECRYPT), JValue::Object(&key), JValue::Object(&spec)])?;
                let a = env.byte_array_from_slice(aad)?;
                env.call_method(&c, "updateAAD", "([B)V", &[JValue::Object(&a)])?;
                do_final(env, &c, ct)
            })
        }
    }
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// 假的金鑰庫：`lost` 打開＝包裝金鑰不見了；`busy` 打開＝暫時用不了
    #[derive(Clone, Default)]
    pub struct FakeKeystore {
        pub lost: Arc<AtomicBool>,
        pub busy: Arc<AtomicBool>,
    }

    impl Aead for FakeKeystore {
        fn seal(&self, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
            if self.busy.load(Ordering::SeqCst) {
                return Err("金鑰庫忙".into());
            }
            let mut out = vec![aad.len() as u8];
            out.extend(plain.iter().map(|b| b ^ 0xa5));
            Ok(out)
        }
        fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
            if self.lost.load(Ordering::SeqCst) {
                return Err(KEY_LOST.into());
            }
            if self.busy.load(Ordering::SeqCst) {
                return Err("金鑰庫忙".into());
            }
            if sealed.first() != Some(&(aad.len() as u8)) {
                return Err("解不開".into());
            }
            Ok(sealed[1..].iter().map(|b| b ^ 0xa5).collect())
        }
    }
}
