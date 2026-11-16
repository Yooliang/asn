//! 程序的完整性層級（Windows）：Claude 視窗若是用系統管理員身分開的（層級比 ASN 高），
//! 收發室 worker 經 Claude Code 的跨視窗訊息（具名管道）連不進去，轉交會失敗；反方向沒問題。
//! 這裡只負責「視窗層級是不是比 ASN 自己高」的判斷。讀不到層級（權限不足、程序已結束、非 Windows）一律當作不知道＝照舊，不標記。
//! 真正查層級的函式由外面傳進來（[`checker`]），測試接假的層級。
use std::sync::Arc;

/// 「這個 pid 的視窗是不是比 ASN 自己高權限」的判斷
pub(crate) type ElevatedCheck = Arc<dyn Fn(u32) -> bool + Send + Sync>;

/// 視窗層級嚴格高於 ASN 自己才算；任何一邊讀不到都不算（照舊）
pub(crate) fn higher_than(window: Option<u32>, own: Option<u32>) -> bool {
    matches!((window, own), (Some(w), Some(o)) if w > o)
}

/// 用給定的「查層級」函式與 ASN 自己的層級組出判斷（自己的層級只查一次，由呼叫端給）
pub(crate) fn checker(level_of: impl Fn(u32) -> Option<u32> + Send + Sync + 'static, own: Option<u32>) -> ElevatedCheck {
    Arc::new(move |pid| higher_than(level_of(pid), own))
}

/// 正式用的判斷：真的去查作業系統（ASN 自己的層級現在查一次）
pub(crate) fn real_checker() -> ElevatedCheck {
    checker(real_integrity, real_integrity(std::process::id()))
}

/// 取程序的完整性層級（SID 最後一個 sub-authority，例如 0x2000＝一般、0x3000＝系統管理員）。任何一步失敗回 None
#[cfg(windows)]
pub(crate) fn real_integrity(pid: u32) -> Option<u32> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return None;
    }
    // SAFETY: 只呼叫 Win32 查詢函式；開出來的程序與權杖代號用完都關掉；緩衝區用 u64 配置以滿足 TOKEN_MANDATORY_LABEL 的對齊，
    // 讀 SID 前先確認緩衝區夠大、子授權數不是 0。
    unsafe {
        let own = pid == std::process::id();
        let proc: HANDLE = if own { GetCurrentProcess() } else { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if proc.is_null() {
            return None;
        }
        let mut tok: HANDLE = std::ptr::null_mut();
        let opened = OpenProcessToken(proc, TOKEN_QUERY, &mut tok) != 0;
        if !own {
            CloseHandle(proc);
        }
        if !opened || tok.is_null() {
            return None;
        }
        let mut len = 0u32;
        GetTokenInformation(tok, TokenIntegrityLevel, std::ptr::null_mut(), 0, &mut len); // 第一次只問需要多大
        let result = if (len as usize) < std::mem::size_of::<TOKEN_MANDATORY_LABEL>() {
            None
        } else {
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            if GetTokenInformation(tok, TokenIntegrityLevel, buf.as_mut_ptr() as *mut c_void, len, &mut len) == 0 {
                None
            } else {
                let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
                let sid = label.Label.Sid;
                if sid.is_null() {
                    None
                } else {
                    let n = *GetSidSubAuthorityCount(sid) as u32;
                    if n == 0 {
                        None
                    } else {
                        Some(*GetSidSubAuthority(sid, n - 1))
                    }
                }
            }
        };
        CloseHandle(tok);
        result
    }
}

/// 非 Windows 沒有這個概念：一律讀不到（照舊）
#[cfg(not(windows))]
pub(crate) fn real_integrity(_pid: u32) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEDIUM: u32 = 0x2000;
    const HIGH: u32 = 0x3000;
    const LOW: u32 = 0x1000;

    #[test]
    fn 視窗層級比自己高才算() {
        assert!(higher_than(Some(HIGH), Some(MEDIUM)));
        assert!(!higher_than(Some(MEDIUM), Some(MEDIUM)), "同層級照舊");
        assert!(!higher_than(Some(LOW), Some(MEDIUM)), "比自己低照舊");
        assert!(!higher_than(Some(MEDIUM), Some(HIGH)), "ASN 自己就是系統管理員：視窗不比它高");
    }

    #[test]
    fn 任何一邊讀不到都照舊() {
        assert!(!higher_than(None, Some(MEDIUM)));
        assert!(!higher_than(Some(HIGH), None));
        assert!(!higher_than(None, None));
    }

    #[test]
    fn checker_依假層級判斷() {
        let c = checker(|pid| match pid {
            10 => Some(HIGH),
            11 => Some(MEDIUM),
            12 => Some(LOW),
            _ => None,
        }, Some(MEDIUM));
        assert!(c(10));
        assert!(!c(11) && !c(12) && !c(13));
        let unknown_self = checker(|_| Some(HIGH), None);
        assert!(!unknown_self(10), "ASN 自己的層級讀不到＝不標");
    }

    #[cfg(windows)]
    #[test]
    fn 自己的層級讀得到且不為零() {
        let own = real_integrity(std::process::id());
        assert!(own.is_some_and(|l| l >= LOW), "{own:?}");
        assert_eq!(real_integrity(0), None);
    }
}
