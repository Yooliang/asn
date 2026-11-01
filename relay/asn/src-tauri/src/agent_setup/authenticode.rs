//! 執行檔的數位簽章（Authenticode）檢查。
//! 真的那份用系統的 `WinVerifyTrust` 驗完整個憑證鏈（鏈到系統信任的根憑證、檔案內容沒被改），
//! 通過後才取出簽署者名稱交給呼叫端比對；沒有簽章、簽章壞掉、憑證鏈不受信任都算失敗。
//! 不查憑證撤銷清單（離線的新電腦也要能裝）；完整性靠鏈與雜湊兩層。

use std::path::Path;

pub trait SignatureCheck {
    /// 簽章有效就回簽署者名稱（憑證的通用名稱）；無效回原因
    fn signer(&self, path: &Path) -> Result<String, String>;
}

/// 沒有 Windows 的簽章檢查可用時（其他平台）：一律失敗，不放行未驗證的檔案
#[cfg(not(windows))]
pub struct SystemSignatureCheck;

#[cfg(not(windows))]
impl SignatureCheck for SystemSignatureCheck {
    fn signer(&self, _path: &Path) -> Result<String, String> {
        Err("這個平台沒有可用的數位簽章檢查".to_string())
    }
}

#[cfg(windows)]
pub struct SystemSignatureCheck;

#[cfg(windows)]
impl SignatureCheck for SystemSignatureCheck {
    fn signer(&self, path: &Path) -> Result<String, String> {
        win::signer(path)
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE};
    use windows_sys::Win32::Security::WinTrust::{
        WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
        WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    pub fn signer(path: &Path) -> Result<String, String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: 結構都先清成零再填必要欄位；`wide` 與 `file` 活到收尾那次 WinVerifyTrust 之後；
        // 成功進入驗證狀態後，不論後面怎麼走，離開前一定送一次 CLOSE 釋放狀態。
        unsafe {
            let mut file: WINTRUST_FILE_INFO = std::mem::zeroed();
            file.cbStruct = std::mem::size_of::<WINTRUST_FILE_INFO>() as u32;
            file.pcwszFilePath = wide.as_ptr();
            let mut data: WINTRUST_DATA = std::mem::zeroed();
            data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
            data.dwUIChoice = WTD_UI_NONE;
            data.fdwRevocationChecks = WTD_REVOKE_NONE;
            data.dwUnionChoice = WTD_CHOICE_FILE;
            data.Anonymous = WINTRUST_DATA_0 { pFile: &mut file };
            data.dwStateAction = WTD_STATEACTION_VERIFY;
            let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
            let hwnd = INVALID_HANDLE_VALUE as _;
            let status = WinVerifyTrust(hwnd, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
            let result = if status != 0 {
                Err(format!("數位簽章驗證沒通過（系統代碼 0x{:08X}）", status as u32))
            } else {
                signer_name(data.hWVTStateData)
            };
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            WinVerifyTrust(hwnd, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
            result
        }
    }

    unsafe fn signer_name(state: windows_sys::Win32::Foundation::HANDLE) -> Result<String, String> {
        let prov = WTHelperProvDataFromStateData(state);
        if prov.is_null() {
            return Err("讀不到簽章資料".to_string());
        }
        let sgnr = WTHelperGetProvSignerFromChain(prov, 0, 0, 0);
        if sgnr.is_null() {
            return Err("讀不到簽署者".to_string());
        }
        let cert = WTHelperGetProvCertFromChain(sgnr, 0);
        if cert.is_null() || (*cert).pCert.is_null() {
            return Err("讀不到簽署者憑證".to_string());
        }
        let ctx = (*cert).pCert;
        let len = CertGetNameStringW(ctx, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, std::ptr::null(), std::ptr::null_mut(), 0);
        if len <= 1 {
            return Err("簽署者憑證沒有名稱".to_string());
        }
        let mut buf: Vec<u16> = vec![0; len as usize];
        let n = CertGetNameStringW(ctx, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, std::ptr::null(), buf.as_mut_ptr(), len);
        if n <= 1 {
            return Err("簽署者憑證沒有名稱".to_string());
        }
        buf.truncate(n as usize - 1);
        Ok(String::from_utf16_lossy(&buf))
    }
}

#[cfg(all(test, windows))]
mod real_tests {
    use super::*;

    /// 內嵌簽章的真實檔案：這台電腦上已裝的官方 claude.exe（Windows 內建程式多半是目錄簽章，不適用）。沒裝就回 None
    fn local_signed_exe() -> Option<std::path::PathBuf> {
        let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)?;
        let p = home.join(".local").join("bin").join("claude.exe");
        p.exists().then_some(p)
    }

    #[test]
    fn 官方_claude_的簽章驗得過_簽署者完全相符() {
        let Some(p) = local_signed_exe() else {
            eprintln!("略過：這台電腦沒有裝官方 claude.exe");
            return;
        };
        let who = SystemSignatureCheck.signer(&p).expect("官方 claude.exe 應有有效簽章");
        assert_eq!(who, super::super::claude_install::EXPECTED_SIGNER);
    }

    #[test]
    fn 沒有簽章的檔案不通過() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("fake.exe");
        std::fs::write(&p, b"MZ not really an exe").unwrap();
        assert!(SystemSignatureCheck.signer(&p).is_err());
    }

    #[test]
    fn 簽章驗過後內容被改就不通過() {
        let Some(src) = local_signed_exe() else {
            eprintln!("略過：這台電腦沒有裝官方 claude.exe");
            return;
        };
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("claude.exe");
        let mut bytes = std::fs::read(&src).unwrap();
        std::fs::write(&p, &bytes).unwrap();
        assert!(SystemSignatureCheck.signer(&p).is_ok(), "原檔複本應該通過");
        let mid = bytes.len() / 3;
        bytes[mid] ^= 0xFF;
        std::fs::write(&p, &bytes).unwrap();
        assert!(SystemSignatureCheck.signer(&p).is_err(), "改過一個位元組就該失敗");
    }
}
