//! 本機具名管道（Windows）。
//! - 管道名稱含目前使用者的 SID 雜湊，避免不同使用者互相撞名。
//! - 管道的存取控制清單只有一筆：目前使用者（`D:P(A;;GA;;;<SID>)`），別的使用者連線一律被系統拒絕；拒絕遠端連線。
//! - ASN 建管道時要求「第一個執行個體」：名字已被別人先佔走就建失敗（不聽別人搶先建好的管道）。
//! - 小幫手連上後先查「對面伺服器行程」的執行檔路徑，必須是自己旁邊的 asn.exe，才會送出任何內容。
//! - 小幫手開管道時帶 SECURITY_IDENTIFICATION，伺服器端不能冒用小幫手的身分。
//! 非 Windows 目前不支援（回「尚未支援」）。
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io;
use std::path::PathBuf;

/// 測試用管道名稱的前綴。只有除錯版（含 cargo test）才認 `ASN_ASKPASS_PIPE` 這個覆寫，且名稱必須以此開頭
pub const TEST_PREFIX: &str = "asn-askpass-test-";

/// 管道名稱（不含 `\\.\pipe\`）
pub fn pipe_name() -> String {
    #[cfg(debug_assertions)]
    {
        if let Ok(n) = std::env::var("ASN_ASKPASS_PIPE") {
            if n.starts_with(TEST_PREFIX) && n.len() < 100 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return n;
            }
        }
    }
    let sid = user_id_string().unwrap_or_default();
    let h = Sha256::digest(sid.as_bytes());
    let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("asn-askpass-{hex}")
}

pub fn pipe_path(name: &str) -> String {
    format!(r"\\.\pipe\{name}")
}

/// 管道上只准這個使用者存取的 SDDL
pub fn dacl_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};

    const ERROR_PIPE_BUSY: i32 = 231;
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

    /// 目前使用者的 SID 字串（S-1-5-21-…）
    pub fn user_id_string() -> io::Result<String> {
        unsafe {
            let mut tok: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0u32;
            GetTokenInformation(tok, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u8; len.max(1) as usize];
            let ok = GetTokenInformation(tok, TokenUser, buf.as_mut_ptr() as *mut c_void, len, &mut len);
            let err = io::Error::last_os_error();
            CloseHandle(tok);
            if ok == 0 {
                return Err(err);
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut w: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut w) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut n = 0;
            while *w.add(n) != 0 {
                n += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(w, n));
            LocalFree(w as *mut c_void);
            Ok(s)
        }
    }

    fn create_instance(name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let sid = user_id_string()?;
        let sddl: Vec<u16> = dacl_sddl(&sid).encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut psd: *mut c_void = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut psd, std::ptr::null_mut()) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: psd, bInheritHandle: 0 };
            let r = ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(pipe_path(name), &mut sa as *mut SECURITY_ATTRIBUTES as *mut c_void);
            LocalFree(psd);
            r
        }
    }

    /// 伺服器端：持續提供下一個等待連線的管道執行個體
    pub struct Listener {
        name: String,
        cur: Option<NamedPipeServer>,
    }

    /// 建第一個執行個體；名字已被佔用（可能是別的程式搶先建的）就失敗。要在 tokio 執行環境內呼叫
    pub fn bind(name: &str) -> io::Result<Listener> {
        Ok(Listener { name: name.to_string(), cur: Some(create_instance(name, true)?) })
    }

    impl Listener {
        /// 目前等待連線的那個管道執行個體的控制代碼（測試讀存取控制清單用）
        pub fn current_handle(&self) -> Option<HANDLE> {
            self.cur.as_ref().map(|s| s.as_raw_handle() as HANDLE)
        }

        /// 等下一個連線；回傳連線與對面行程的 pid（系統查的，不是對方自己報的）
        pub async fn accept(&mut self) -> io::Result<(NamedPipeServer, Option<u32>)> {
            let srv = match self.cur.take() {
                Some(s) => s,
                None => create_instance(&self.name, false)?,
            };
            srv.connect().await?;
            self.cur = create_instance(&self.name, false).ok();
            let pid = client_pid(&srv);
            Ok((srv, pid))
        }
    }

    fn client_pid(s: &NamedPipeServer) -> Option<u32> {
        let mut pid = 0u32;
        let ok = unsafe { GetNamedPipeClientProcessId(s.as_raw_handle() as HANDLE, &mut pid) };
        (ok != 0 && pid != 0).then_some(pid)
    }

    /// 小幫手端：連上管道（管道全忙時最多等約 3 秒）
    pub fn connect(name: &str) -> io::Result<File> {
        let path = pipe_path(name);
        let mut last = io::Error::new(io::ErrorKind::TimedOut, "管道忙碌");
        for _ in 0..30 {
            match std::fs::OpenOptions::new().read(true).write(true).security_qos_flags(SECURITY_IDENTIFICATION).open(&path) {
                Ok(f) => return Ok(f),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    last = e;
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(e),
            }
        }
        Err(last)
    }

    /// 管道對面伺服器行程的執行檔完整路徑
    pub fn server_exe(f: &File) -> io::Result<PathBuf> {
        let mut pid = 0u32;
        if unsafe { GetNamedPipeServerProcessId(f.as_raw_handle() as HANDLE, &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut buf = vec![0u16; 1024];
            let mut n = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut n);
            let err = io::Error::last_os_error();
            CloseHandle(h);
            if ok == 0 {
                return Err(err);
            }
            Ok(PathBuf::from(String::from_utf16_lossy(&buf[..n as usize])))
        }
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn user_id_string() -> io::Result<String> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "尚未支援"))
    }
    pub fn connect(_name: &str) -> io::Result<File> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "這個系統尚未支援密碼小幫手"))
    }
    pub fn server_exe(_f: &File) -> io::Result<PathBuf> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "這個系統尚未支援密碼小幫手"))
    }
}

#[cfg(not(windows))]
pub use imp::*;

/// 兩個路徑是否指向同一個檔案（Windows 路徑不分大小寫、斜線反斜線視為相同；先正規化再比）
pub fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
    let norm = |p: &std::path::Path| {
        let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let s = c.display().to_string().replace('/', "\\");
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}
