//! 發起觀看（D）的 Windows Hello 金鑰（#597 別台看畫面 PR 4）。只在 Windows。
//!
//! - 每個 Windows 使用者一把，名稱固定 [`KEY_NAME`]。私鑰在 Windows Hello 裡，ASN 拿不到；每次簽章 Windows 都會要本人輸入 PIN 或指紋。
//! - **只有本人按的入口能呼叫**（守門測試在 `hello_key`）：「配對這台」取得或建立公鑰；「開始觀看」簽章（PR 5 接上）。
//!   背景流程不得建立金鑰或簽章。
//! - 這裡的呼叫都會等本人按，呼叫端要放在 `spawn_blocking`。
//! - 取消、沒設 PIN、被鎖住都回明確的錯誤，不重試、不卡住。
#![cfg(windows)]
#![cfg_attr(not(test), allow(dead_code))]
use crate::view_handshake::ViewSigner;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use windows::core::{Array, HSTRING};
use windows::Security::Credentials::{KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus};
use windows::Security::Cryptography::Core::CryptographicPublicKeyBlobType;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::IBuffer;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

pub const KEY_NAME: &str = "asn-view-v1";
pub const NOT_SET_UP: &str = "這台還沒有設定看畫面用的 Windows Hello，請先重新配對";

/// 等 Windows 的非同步結果需要 COM；每次呼叫都初始化一次（同一執行緒重複呼叫無害）
fn init_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn status_text(s: KeyCredentialStatus) -> String {
    match s {
        KeyCredentialStatus::UserCanceled => "已取消，沒有完成".into(),
        KeyCredentialStatus::UserPrefersPassword => "這台要先設定 Windows Hello 的 PIN 或指紋".into(),
        KeyCredentialStatus::SecurityDeviceLocked => "Windows Hello 暫時被鎖住了，請稍後再試".into(),
        KeyCredentialStatus::NotFound => NOT_SET_UP.into(),
        _ => "Windows Hello 沒有完成".into(),
    }
}

fn win_err(e: windows::core::Error) -> String {
    elog!("[ASN] Windows Hello 呼叫失敗：{e}"); // 錯誤碼進記錄檔，不含金鑰內容
    "Windows Hello 沒有完成".into()
}

fn bytes(buf: &IBuffer) -> Result<Vec<u8>, String> {
    let mut out = Array::<u8>::new();
    CryptographicBuffer::CopyToByteArray(buf, &mut out).map_err(win_err)?;
    Ok(out.to_vec())
}

/// 這台支不支援 Windows Hello。不跳提示、不建金鑰
pub fn supported() -> bool {
    init_com();
    KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false)
}

/// 開已經有的金鑰；沒有回 None。不建立
fn open() -> Result<Option<KeyCredential>, String> {
    init_com();
    let r = KeyCredentialManager::OpenAsync(&HSTRING::from(KEY_NAME)).and_then(|op| op.join()).map_err(win_err)?;
    match r.Status().map_err(win_err)? {
        KeyCredentialStatus::Success => Ok(Some(r.Credential().map_err(win_err)?)),
        KeyCredentialStatus::NotFound => Ok(None),
        s => Err(status_text(s)),
    }
}

/// 建立金鑰：Windows 會要本人輸入 PIN。已經有同名的就不覆蓋（覆蓋會讓已配對的電腦全部對不上）
fn create() -> Result<KeyCredential, String> {
    init_com();
    let r = KeyCredentialManager::RequestCreateAsync(&HSTRING::from(KEY_NAME), KeyCredentialCreationOption::FailIfExists).and_then(|op| op.join()).map_err(win_err)?;
    match r.Status().map_err(win_err)? {
        KeyCredentialStatus::Success => r.Credential().map_err(win_err),
        s => Err(status_text(s)),
    }
}

fn public_b64(c: &KeyCredential) -> Result<String, String> {
    let buf = c.RetrievePublicKeyWithBlobType(CryptographicPublicKeyBlobType::Pkcs1RsaPublicKey).map_err(win_err)?;
    Ok(B64.encode(bytes(&buf)?))
}

/// 「配對這台」的入口：有金鑰就用，沒有才建（這時 Windows 會要本人輸入 PIN）。回公鑰
pub fn pairing_public_key() -> Result<String, String> {
    let c = match open()? {
        Some(c) => c,
        None => create()?,
    };
    public_b64(&c)
}

/// 「開始觀看」用的簽章者。只開不建：沒有金鑰就要本人重新配對
pub struct WinHello;

impl ViewSigner for WinHello {
    fn public_key(&self) -> Result<String, String> {
        public_b64(&open()?.ok_or(NOT_SET_UP)?)
    }
    fn sign(&self, msg: &[u8]) -> Result<String, String> {
        let c = open()?.ok_or(NOT_SET_UP)?;
        let data = CryptographicBuffer::CreateFromByteArray(msg).map_err(win_err)?;
        let r = c.RequestSignAsync(&data).and_then(|op| op.join()).map_err(win_err)?;
        match r.Status().map_err(win_err)? {
            KeyCredentialStatus::Success => Ok(B64.encode(bytes(&r.Result().map_err(win_err)?)?)),
            s => Err(status_text(s)),
        }
    }
}
