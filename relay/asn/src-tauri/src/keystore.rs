//! 用系統金鑰庫保護登入資料和設備金鑰（0.2.9，Linux）。Windows 照舊用 DPAPI，不經這裡。
//!
//! - 金鑰庫裡只放一把隨機的 32 位元組「包裝金鑰」；檔案內容用它做 AES-256-GCM，照舊寫檔，前面加 [`PREFIX`]。
//! - 每次寫檔用新的隨機 nonce；AAD 帶用途和檔名，兩個檔案的內容互換也解不開。
//! - **失敗就關，不降級：** 有前綴的檔案拿不到包裝金鑰就回錯誤，絕不改寫成明文。完全沒有金鑰庫才退回明文檔（0600），由呼叫端標示。
//! - **背景不跳解鎖提示：** 讀取、建立都只做不互動的查詢；金鑰庫鎖著就回 [`StoreErr::Locked`]，等本人按的動作再說。
//! - 找包裝金鑰時用完整的屬性比對（[`attrs`]），不會撿到別的 ASN 資料夾的那一筆。
#![cfg_attr(not(test), allow(dead_code))]
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::Zeroizing;

/// 包過的檔案開頭
pub const PREFIX: &[u8] = b"ss1:";
pub const LOCKED: &str = "系統金鑰庫鎖著，請解鎖後再試";
pub const NOT_FOUND: &str = "系統金鑰庫裡找不到這台的金鑰，需要重新登入或重新配對";
pub const BROKEN: &str = "存檔解不開";

/// 檔案的用途（寫進 AAD）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    AuthToken,
    DeviceKey,
}

impl Purpose {
    fn label(self) -> &'static str {
        match self {
            Purpose::AuthToken => "auth-token",
            Purpose::DeviceKey => "device-key",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreErr {
    /// 這台沒有系統金鑰庫（沒跑服務、純主控台）
    Unavailable,
    /// 有，但鎖著；不互動就拿不到
    Locked,
    Other(String),
}

/// 系統金鑰庫的最小介面：用完整屬性找一筆、建一筆。**都不能跳解鎖提示。** 測試接假的
pub trait SecretStore: Send + Sync {
    fn get(&self, attrs: &[(String, String)]) -> Result<Option<Zeroizing<Vec<u8>>>, StoreErr>;
    fn create(&self, attrs: &[(String, String)], secret: &[u8]) -> Result<(), StoreErr>;
}

/// 包裝金鑰的屬性：app、用途、這個資料夾（雜湊，不把路徑寫進金鑰庫）
pub fn attrs(data_dir: &Path) -> Vec<(String, String)> {
    let dir = data_dir.to_string_lossy();
    let h = Sha256::digest(format!("asn-wrap-dir-v1\n{dir}").as_bytes());
    let user_dir: String = h[..16].iter().map(|b| format!("{b:02x}")).collect();
    vec![("app".into(), "asn".into()), ("purpose".into(), "wrap-v1".into()), ("user_dir".into(), user_dir)]
}

fn aad(purpose: Purpose, file: &str) -> Vec<u8> {
    format!("asn-wrap-v1|{}|{file}", purpose.label()).into_bytes()
}

fn key_of(raw: &[u8]) -> Result<LessSafeKey, String> {
    if raw.len() != 32 {
        return Err(BROKEN.to_string());
    }
    UnboundKey::new(&AES_256_GCM, raw).map(LessSafeKey::new).map_err(|_| BROKEN.to_string())
}

/// 包：PREFIX + nonce + 密文（含驗證碼）
pub fn seal(raw_key: &[u8], purpose: Purpose, file: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    let key = key_of(raw_key)?;
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "產生不了亂數".to_string())?;
    let mut buf = plain.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad(purpose, file)), &mut buf).map_err(|_| "加密失敗".to_string())?;
    Ok([PREFIX, &nonce[..], &buf[..]].concat())
}

/// 拆：前綴、nonce、密文；用途或檔名不同、內容被改過都解不開
pub fn open(raw_key: &[u8], purpose: Purpose, file: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let body = sealed.strip_prefix(PREFIX).ok_or_else(|| BROKEN.to_string())?;
    if body.len() < NONCE_LEN {
        return Err(BROKEN.to_string());
    }
    let (n, ct) = body.split_at(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(n).map_err(|_| BROKEN.to_string())?;
    let mut buf = Zeroizing::new(ct.to_vec());
    let plain = key_of(raw_key)?.open_in_place(nonce, Aad::from(aad(purpose, file)), &mut buf).map_err(|_| BROKEN.to_string())?;
    let len = plain.len();
    buf.truncate(len);
    Ok(buf)
}

pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.starts_with(PREFIX)
}

/// 這台的保護方式（給設定頁看、也決定能不能被別台看）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protection {
    /// 系統金鑰庫保護
    Keyring,
    /// 沒有系統金鑰庫：只靠檔案權限
    FileOnly,
}

/// 用金鑰庫的 Protector。可能建立包裝金鑰（不互動），所以「建立」也受「鎖著就不做」限制
pub struct SecretWrap<S: SecretStore> {
    pub store: S,
    pub attrs: Vec<(String, String)>,
    pub purpose: Purpose,
    pub file: String,
}

impl<S: SecretStore> SecretWrap<S> {
    fn wrap_key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
        match self.store.get(&self.attrs) {
            Ok(Some(k)) => Ok(k),
            Ok(None) if create => {
                let mut k = Zeroizing::new(vec![0u8; 32]);
                SystemRandom::new().fill(&mut k).map_err(|_| "產生不了亂數".to_string())?;
                self.store.create(&self.attrs, &k).map_err(store_text)?;
                // 建完再讀一次，用金鑰庫裡實際那一把（兩個程序同時建時以先建的為準）
                self.store.get(&self.attrs).map_err(store_text)?.ok_or_else(|| NOT_FOUND.to_string())
            }
            Ok(None) => Err(NOT_FOUND.to_string()),
            Err(e) => Err(store_text(e)),
        }
    }
}

fn store_text(e: StoreErr) -> String {
    match e {
        StoreErr::Locked => LOCKED.to_string(),
        StoreErr::Unavailable => "這台沒有系統金鑰庫".to_string(),
        StoreErr::Other(s) => {
            elog!("[ASN] 系統金鑰庫錯誤：{s}");
            "系統金鑰庫暫時用不了".to_string()
        }
    }
}

impl<S: SecretStore> crate::auth::Protector for SecretWrap<S> {
    fn seals(&self) -> bool {
        true
    }
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        seal(&self.wrap_key(true)?, self.purpose, &self.file, plain)
    }
    /// 有前綴：一定要用包裝金鑰解開（拿不到就錯，不降級）。沒有前綴：是舊的明文檔，照舊讀，呼叫端負責升級
    fn unprotect(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if !is_sealed(sealed) {
            return Ok(sealed.to_vec());
        }
        let k = self.wrap_key(false)?;
        Ok(open(&k, self.purpose, &self.file, sealed)?.to_vec())
    }
}

/// 啟動時決定這台用哪種保護：金鑰庫在（就算鎖著）＝金鑰庫；完全沒有才是只靠檔案權限
pub fn probe(store: &dyn SecretStore, data_dir: &Path) -> Protection {
    match store.get(&attrs(data_dir)) {
        Err(StoreErr::Unavailable) => Protection::FileOnly,
        _ => Protection::Keyring,
    }
}

/// 這次該用哪種保護。**用過金鑰庫就永不降級：** 兩個檔案任一個已經是包過的，就一定用金鑰庫（拿不到就錯）；
/// 都還沒包過時，金鑰庫完全不在才退回只靠檔案權限
pub fn choose(any_sealed: bool, probed: Protection) -> Protection {
    if any_sealed {
        Protection::Keyring
    } else {
        probed
    }
}

/// 資料夾裡兩個受保護的檔案，有沒有任一個已經包過
pub fn any_sealed(data_dir: &Path) -> bool {
    ["login.bin", "device_key.bin"].iter().any(|f| std::fs::read(data_dir.join(f)).is_ok_and(|b| is_sealed(&b) || is_sealed_text(&b)))
}

/// 設備金鑰檔外面還包一層 base64（device_id 寫的格式），看裡面是不是包過的
fn is_sealed_text(b: &[u8]) -> bool {
    use base64::Engine;
    std::str::from_utf8(b).ok().and_then(|t| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(t.trim()).ok()).is_some_and(|d| is_sealed(&d))
}

/// 這台登入資料和設備金鑰的保護方式（給設定頁）：windows／keyring／file_only
pub fn protection_label(data_dir: &Path) -> &'static str {
    if cfg!(windows) {
        return "windows";
    }
    #[cfg(target_os = "linux")]
    if choose(any_sealed(data_dir), probe(&linux::LinuxStore, data_dir)) == Protection::Keyring {
        return "keyring";
    }
    let _ = data_dir;
    "file_only"
}

/// Linux：這個檔案該用的 Protector。金鑰庫可以用（或用過）＝包裝；完全沒有金鑰庫＝None（呼叫端退回只靠檔案權限）
#[cfg(target_os = "linux")]
pub fn wrap_for(data_dir: &Path, purpose: Purpose, file: &str) -> Option<SecretWrap<linux::LinuxStore>> {
    match choose(any_sealed(data_dir), probe(&linux::LinuxStore, data_dir)) {
        Protection::Keyring => Some(SecretWrap { store: linux::LinuxStore, attrs: attrs(data_dir), purpose, file: file.to_string() }),
        Protection::FileOnly => None,
    }
}

/// 設備金鑰檔是不是包過的（Linux 上「能不能讓別台看這台」看這個）
pub fn device_key_sealed(data_dir: &Path) -> bool {
    std::fs::read(data_dir.join("device_key.bin")).is_ok_and(|b| is_sealed_text(&b))
}

/// Linux：Secret Service（GNOME 金鑰圈、KWallet 等）。**不叫解鎖、不跳提示：** 鎖著就回 Locked
#[cfg(target_os = "linux")]
pub mod linux {
    use super::{SecretStore, StoreErr};
    use secret_service::blocking::SecretService;
    use secret_service::{EncryptionType, Error};
    use std::collections::HashMap;
    use zeroize::Zeroizing;

    const LABEL: &str = "ASN 登入資料保護金鑰";

    pub struct LinuxStore;

    /// 這個程序第一次查到「沒有金鑰庫」就記住，之後不再每次去連（設定頁會常常問）
    static UNAVAILABLE: std::sync::OnceLock<()> = std::sync::OnceLock::new();

    /// 在一條新的執行緒上做：zbus 的同步呼叫在 tokio 的執行緒上會 panic（不能在 runtime 裡再起 runtime），
    /// 而呼叫端（設定頁狀態、配對、啟動）常在 async 裡
    fn off_runtime<T: Send>(f: impl FnOnce() -> Result<T, StoreErr> + Send) -> Result<T, StoreErr> {
        if UNAVAILABLE.get().is_some() {
            return Err(StoreErr::Unavailable);
        }
        let r = std::thread::scope(|sc| sc.spawn(f).join()).unwrap_or_else(|_| Err(StoreErr::Other("金鑰庫查詢中斷".into())));
        if r.as_ref().err() == Some(&StoreErr::Unavailable) {
            let _ = UNAVAILABLE.set(());
        }
        r
    }

    fn map(e: Error) -> StoreErr {
        match e {
            Error::Unavailable => StoreErr::Unavailable,
            Error::Locked | Error::Prompt | Error::PromptDisconnected => StoreErr::Locked,
            // 沒有金鑰庫服務（不直接相依 zbus，看錯誤名稱）
            Error::Zbus(ref z) if { let t = z.to_string(); t.contains("ServiceUnknown") || t.contains("NameHasNoOwner") } => StoreErr::Unavailable,
            e => StoreErr::Other(e.to_string()),
        }
    }

    fn connect<'a>() -> Result<SecretService<'a>, StoreErr> {
        SecretService::connect(EncryptionType::Dh).map_err(map)
    }

    /// 屬性要完全相同（不只是包含查詢的那幾個）
    fn same(found: &HashMap<String, String>, want: &[(String, String)]) -> bool {
        found.len() == want.len() && want.iter().all(|(k, v)| found.get(k) == Some(v))
    }

    impl SecretStore for LinuxStore {
        fn get(&self, attrs: &[(String, String)]) -> Result<Option<Zeroizing<Vec<u8>>>, StoreErr> {
            off_runtime(|| get_now(attrs))
        }
        fn create(&self, attrs: &[(String, String)], secret: &[u8]) -> Result<(), StoreErr> {
            off_runtime(|| create_now(attrs, secret))
        }
    }

    fn get_now(attrs: &[(String, String)]) -> Result<Option<Zeroizing<Vec<u8>>>, StoreErr> {
        {
            let ss = connect()?;
            let q: HashMap<&str, &str> = attrs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let r = ss.search_items(q).map_err(map)?;
            for item in &r.unlocked {
                if same(&item.get_attributes().map_err(map)?, attrs) {
                    return Ok(Some(Zeroizing::new(item.get_secret().map_err(map)?)));
                }
            }
            // 只有鎖著的那一筆：不解鎖、不跳提示
            if r.locked.iter().any(|i| i.get_attributes().is_ok_and(|a| same(&a, attrs))) {
                return Err(StoreErr::Locked);
            }
            Ok(None)
        }
    }

    fn create_now(attrs: &[(String, String)], secret: &[u8]) -> Result<(), StoreErr> {
        {
            let ss = connect()?;
            let c = ss.get_default_collection().map_err(map)?;
            // 鎖著的集合建立時會跳解鎖提示：先查，鎖著就不建
            if c.is_locked().map_err(map)? {
                return Err(StoreErr::Locked);
            }
            let a: HashMap<&str, &str> = attrs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            c.create_item(LABEL, a, secret, false, "application/octet-stream").map(|_| ()).map_err(map)
        }
    }

    #[cfg(test)]
    mod runtime_tests {
        /// 呼叫端在 tokio 的執行緒上也不能 panic（CI 實際踩到過：bridge 的狀態在 async 裡問保護方式）
        #[tokio::test(flavor = "multi_thread")]
        async fn 在_tokio_裡呼叫也不會_panic() {
            let _ = super::super::protection_label(std::path::Path::new("/tmp/asn-ks-test"));
        }
    }

    /// 真的 Secret Service（CI 用 dbus-run-session＋gnome-keyring-daemon 跑；平常略過）
    #[cfg(test)]
    mod tests {
        use super::super::*;
        use super::LinuxStore;
        use crate::auth::Protector;

        #[test]
        #[ignore = "要有 Secret Service：CI 的 Linux build 用 dbus-run-session 起 gnome-keyring-daemon 跑"]
        fn 真的金鑰庫_建立_讀回_別的資料夾找不到() {
            let dir = tempfile::tempdir().unwrap();
            let w = SecretWrap { store: LinuxStore, attrs: attrs(dir.path()), purpose: Purpose::AuthToken, file: "login.bin".into() };
            let sealed = w.protect(b"token").unwrap();
            assert!(is_sealed(&sealed));
            assert_eq!(w.unprotect(&sealed).unwrap(), b"token");
            let other = tempfile::tempdir().unwrap();
            let o = SecretWrap { store: LinuxStore, attrs: attrs(other.path()), purpose: Purpose::AuthToken, file: "login.bin".into() };
            assert_eq!(o.unprotect(&sealed).unwrap_err(), NOT_FOUND);
            assert_eq!(probe(&LinuxStore, dir.path()), Protection::Keyring);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Protector;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeStore {
        items: Mutex<Vec<(Vec<(String, String)>, Vec<u8>)>>,
        state: Mutex<Option<StoreErr>>,
        creates: Mutex<u32>,
    }
    impl SecretStore for &FakeStore {
        fn get(&self, attrs: &[(String, String)]) -> Result<Option<Zeroizing<Vec<u8>>>, StoreErr> {
            if let Some(e) = self.state.lock().unwrap().clone() {
                return Err(e);
            }
            Ok(self.items.lock().unwrap().iter().find(|(a, _)| a.as_slice() == attrs).map(|(_, s)| Zeroizing::new(s.clone())))
        }
        fn create(&self, attrs: &[(String, String)], secret: &[u8]) -> Result<(), StoreErr> {
            if let Some(e) = self.state.lock().unwrap().clone() {
                return Err(e);
            }
            *self.creates.lock().unwrap() += 1;
            self.items.lock().unwrap().push((attrs.to_vec(), secret.to_vec()));
            Ok(())
        }
    }

    fn wrap<'a>(s: &'a FakeStore, dir: &str, purpose: Purpose, file: &str) -> SecretWrap<&'a FakeStore> {
        SecretWrap { store: s, attrs: attrs(Path::new(dir)), purpose, file: file.into() }
    }

    #[test]
    fn 包和拆_每次_nonce_不同_用途或檔名不同就解不開() {
        let k = [7u8; 32];
        let a = seal(&k, Purpose::AuthToken, "login.bin", b"SECRET").unwrap();
        let b = seal(&k, Purpose::AuthToken, "login.bin", b"SECRET").unwrap();
        assert_ne!(a, b, "每次 nonce 不同");
        assert!(is_sealed(&a));
        assert!(!a.windows(6).any(|w| w == b"SECRET"), "檔案裡看不到明文");
        assert_eq!(open(&k, Purpose::AuthToken, "login.bin", &a).unwrap().as_slice(), b"SECRET");
        assert!(open(&k, Purpose::DeviceKey, "login.bin", &a).is_err(), "用途不同：兩個檔案的內容互換也解不開");
        assert!(open(&k, Purpose::AuthToken, "device_key.bin", &a).is_err(), "檔名不同");
        assert!(open(&[8u8; 32], Purpose::AuthToken, "login.bin", &a).is_err(), "別把金鑰");
        let mut bad = a.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(open(&k, Purpose::AuthToken, "login.bin", &bad).is_err(), "改過一個位元");
        assert!(open(&k, Purpose::AuthToken, "login.bin", b"ss1:x").is_err());
    }

    #[test]
    fn 第一次寫檔_建一把包裝金鑰_之後共用() {
        let s = FakeStore::default();
        let t = wrap(&s, "/home/a/.asn", Purpose::AuthToken, "login.bin");
        let d = wrap(&s, "/home/a/.asn", Purpose::DeviceKey, "device_key.bin");
        let sealed = t.protect(b"token").unwrap();
        d.protect(b"key").unwrap();
        assert_eq!(*s.creates.lock().unwrap(), 1, "兩個檔案共用一把");
        assert_eq!(t.unprotect(&sealed).unwrap(), b"token");
    }

    #[test]
    fn 找包裝金鑰用完整屬性_不會撿到別的資料夾那一筆() {
        let s = FakeStore::default();
        let a = wrap(&s, "/home/a/.asn", Purpose::AuthToken, "login.bin");
        let sealed = a.protect(b"token").unwrap();
        let b = wrap(&s, "/home/b/.asn", Purpose::AuthToken, "login.bin");
        assert_eq!(b.unprotect(&sealed).unwrap_err(), NOT_FOUND, "別的資料夾：找不到，不會拿 a 的來用");
        assert_ne!(attrs(Path::new("/home/a/.asn")), attrs(Path::new("/home/b/.asn")));
        assert!(!attrs(Path::new("/home/a/.asn")).iter().any(|(_, v)| v.contains("/home")), "金鑰庫裡不寫路徑");
    }

    #[test]
    fn 鎖著或拿不到_不降級_有前綴的檔案絕不當明文() {
        let s = FakeStore::default();
        let t = wrap(&s, "/d", Purpose::DeviceKey, "device_key.bin");
        let sealed = t.protect(b"key").unwrap();
        *s.state.lock().unwrap() = Some(StoreErr::Locked);
        assert_eq!(t.unprotect(&sealed).unwrap_err(), LOCKED);
        assert_eq!(t.protect(b"new").unwrap_err(), LOCKED, "鎖著也不建、不寫");
        *s.state.lock().unwrap() = None;
        s.items.lock().unwrap().clear();
        assert_eq!(t.unprotect(&sealed).unwrap_err(), NOT_FOUND, "金鑰庫被清掉：錯誤，不是空的也不是明文");
    }

    #[test]
    fn 鎖著時不建立新的包裝金鑰_啟動時也一樣() {
        let s = FakeStore::default();
        *s.state.lock().unwrap() = Some(StoreErr::Locked);
        let t = wrap(&s, "/d", Purpose::DeviceKey, "device_key.bin");
        assert!(t.protect(b"key").is_err());
        assert_eq!(*s.creates.lock().unwrap(), 0);
    }

    #[test]
    fn 舊的明文檔照舊讀得到_由呼叫端升級() {
        let s = FakeStore::default();
        let t = wrap(&s, "/d", Purpose::AuthToken, "login.bin");
        assert_eq!(t.unprotect(b"{\"refresh_token\":\"x\"}").unwrap(), b"{\"refresh_token\":\"x\"}");
        assert_eq!(*s.creates.lock().unwrap(), 0, "只讀不建");
    }

    #[test]
    fn 用過金鑰庫就永不降級() {
        assert_eq!(choose(true, Protection::FileOnly), Protection::Keyring, "已經包過：金鑰庫不見了也不改寫明文");
        assert_eq!(choose(false, Protection::FileOnly), Protection::FileOnly);
        assert_eq!(choose(false, Protection::Keyring), Protection::Keyring);
        let d = tempfile::tempdir().unwrap();
        assert!(!any_sealed(d.path()));
        std::fs::write(d.path().join("login.bin"), b"{}").unwrap();
        assert!(!any_sealed(d.path()), "明文不算");
        std::fs::write(d.path().join("device_key.bin"), {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"ss1:xxxx")
        })
        .unwrap();
        assert!(any_sealed(d.path()), "設備金鑰檔（base64 包著）也認得出來");
    }

    #[test]
    fn 保護方式_完全沒有金鑰庫才是只靠檔案權限() {
        let s = FakeStore::default();
        assert_eq!(probe(&&s, Path::new("/d")), Protection::Keyring);
        *s.state.lock().unwrap() = Some(StoreErr::Locked);
        assert_eq!(probe(&&s, Path::new("/d")), Protection::Keyring, "鎖著仍是金鑰庫：不能因此改寫明文");
        *s.state.lock().unwrap() = Some(StoreErr::Unavailable);
        assert_eq!(probe(&&s, Path::new("/d")), Protection::FileOnly);
    }
}
