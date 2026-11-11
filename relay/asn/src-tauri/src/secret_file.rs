//! 手機上的節點金鑰（`<節點>.key`）與登入資料（`login.bin`）改用系統金鑰庫加密保存（0.2.17）。
//!
//! - 只有安卓建置會拿到金鑰庫（[`platform_aead`]）；電腦版拿到 `None`，兩個檔案的讀寫維持原樣。
//! - 核心邏輯都是「路徑＋`&dyn Aead`」的純函式，測試在任何平台都能用假的金鑰庫跑。
//! - 檔案格式：[`PREFIX`]（`ak1:`，和設備金鑰同一個）＋金鑰庫加密後的位元組；各檔案用自己的 AAD，換成別的檔名或別的節點就解不開。
//! - 讀到沒有前綴的舊檔（舊版存的明文）：照舊讀出，順手改存成加密的（寫成同資料夾的暫存檔、寫完同步、再換名蓋掉原檔，
//!   原檔的明文不會留下）。加密失敗就維持明文、記一行 log，下次啟動再試。
//! - 節點金鑰解不開（金鑰庫裡的包裝金鑰不見了，例如備份還原到別支手機）：回明確的錯誤，畫面走「重新登入／重新配對」；
//!   **不自動刪檔**，重新配對時才會寫新的金鑰檔。
//! - 登入資料解不開：當作沒登入。包裝金鑰確定不見了（[`KEY_LOST`]）時，把檔案改名成 `login.bin.unreadable` 留著診斷；
//!   其他錯誤可能只是金鑰庫暫時忙，檔案原地不動（下次啟動再試，重新登入時才會被蓋掉）。
//! - 節點金鑰與登入資料的內容、金鑰都不進 log。
#![cfg_attr(not(target_os = "android"), allow(dead_code))]
use crate::android_keywrap::{Aead, KEY_LOST, PREFIX};
use crate::auth::{decode_login, encode_login, StoredLogin, TokenStore};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// 登入資料綁定的用途與檔名
pub const LOGIN_AAD: &[u8] = b"asn-login-v1:login.bin";
/// 登入資料解不開時改名留存的檔名後綴
pub const UNREADABLE_SUFFIX: &str = ".unreadable";
/// 登入資料的檔名（放在資料夾裡）
pub const LOGIN_FILE: &str = "login.bin";
/// 節點金鑰解不開時回給畫面的話（走重新登入／重新配對）
pub const NODE_KEY_UNSEAL_MSG: &str = "這支手機上的節點金鑰解不開（系統金鑰庫裡的金鑰可能已重置），請重新登入並重新配對這支手機";
const NODE_KEY_SEAL_FAIL: &str = "[ASN] 節點金鑰沒辦法用系統金鑰庫加密，暫時維持原樣";
const LOGIN_SEAL_FAIL: &str = "[ASN] 登入資料沒辦法用系統金鑰庫加密，暫時維持原樣";

/// 節點金鑰檔綁定的用途與檔名（含節點代號）
pub fn node_key_aad(node: &str) -> Vec<u8> {
    format!("asn-node-key-v1:{node}.key").into_bytes()
}

/// 這個系統的靜態加密後端：安卓＝金鑰庫那把；其他系統沒有（維持原樣）
pub fn platform_aead() -> Option<Box<dyn Aead>> {
    #[cfg(target_os = "android")]
    {
        Some(crate::android_keywrap::android_aead())
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadErr {
    /// 沒有這個檔
    Missing,
    /// 其他讀檔錯誤
    Io(String),
    /// 有前綴、但金鑰庫解不開
    Unseal(String),
}

/// 同一個程序每種失敗只記一行
fn log_once(flag: &AtomicBool, line: &str) {
    if !flag.swap(true, Ordering::SeqCst) {
        elog!("{line}");
    }
}
static NODE_KEY_SEAL_LOGGED: AtomicBool = AtomicBool::new(false);
static LOGIN_SEAL_LOGGED: AtomicBool = AtomicBool::new(false);

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 整個程序共用一把鎖：這幾個機密檔（節點金鑰、登入資料）的「改存成加密」「寫新內容」「明文備援寫入」都要先拿它，
/// 才不會讓舊檔升級把剛寫好的新內容蓋回舊的。持有期間不可以再呼叫會拿鎖的函式（不可重入）
static SECRET_LOCK: Mutex<()> = Mutex::new(());

pub fn lock() -> MutexGuard<'static, ()> {
    SECRET_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// 換檔後把所在資料夾也同步到磁碟（只有 unix 有這個操作；盡力而為，失敗不影響已換好的檔）
fn sync_parent(path: &Path) {
    #[cfg(unix)]
    {
        if let Some(p) = path.parent() {
            if let Ok(d) = std::fs::File::open(p) {
                let _ = d.sync_all();
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// 換檔暫存檔的名字：`<原檔名>.<行程號>.<序號>.tmp`（和 [`leftover_tmp_pid`] 對得上）
fn tmp_path(path: &Path) -> PathBuf {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(format!(".{}.{}.tmp", std::process::id(), TMP_SEQ.fetch_add(1, Ordering::SeqCst)));
    PathBuf::from(name)
}

/// 原子換檔：同資料夾寫暫存檔（建檔就是 0600）、`restrict` 限縮暫存檔權限（回 false＝放棄）、寫完同步、
/// 換名前再問一次 `guard`（回 false＝放棄、保留原檔）、換名蓋過原檔、同步資料夾。
/// 回 Ok(true)＝已換好；Ok(false)＝`guard` 要求放棄；失敗或放棄都只刪暫存檔，原檔不動
fn replace_atomic_with(path: &Path, bytes: &[u8], restrict: &dyn Fn(&Path) -> bool, guard: &dyn Fn() -> bool) -> std::io::Result<bool> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = tmp_path(path);
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let wrote = (|| -> std::io::Result<()> {
        use std::io::Write;
        drop(opts.open(&tmp)?);
        if !restrict(&tmp) {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "限縮權限失敗"));
        }
        let mut f = std::fs::OpenOptions::new().write(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    let done = wrote.and_then(|_| {
        if !guard() {
            return Ok(false);
        }
        std::fs::rename(&tmp, path)?;
        sync_parent(path);
        Ok(true)
    });
    if !matches!(done, Ok(true)) {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

/// 原子換檔（沒有額外條件）
fn replace_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    replace_atomic_with(path, bytes, &|_| true, &|| true).map(|_| ())
}

/// 明文備援寫入（金鑰庫用不了時）：先寫同資料夾的暫存檔、限縮暫存檔權限、同步，再換名蓋掉；
/// 任何一步失敗只刪暫存檔，原本的檔案完全不動（不會先清空）
pub fn write_plain_atomic(path: &Path, bytes: &[u8], restrict: &dyn Fn(&Path) -> bool) -> Result<(), String> {
    let refused = std::cell::Cell::new(false);
    let r = |p: &Path| {
        let ok = restrict(p);
        if !ok {
            refused.set(true);
        }
        ok
    };
    let _g = lock();
    match replace_atomic_with(path, bytes, &r, &|| true) {
        Ok(_) => Ok(()),
        Err(_) if refused.get() => Err("沒辦法把金鑰檔限制成只有你能讀，已放棄寫入".to_string()),
        Err(e) => Err(format!("寫不了金鑰檔：{e}")),
    }
}

/// 啟動時清掉上次當掉留下的換檔暫存檔：只認 `<節點>.key`（節點金鑰）與 `login.bin`（登入資料）的暫存檔，
/// 名字要完全符合 `<檔名>.<行程號>.<序號>.tmp`；這個行程自己的不動（可能正在寫）。回清掉幾個
pub fn cleanup_leftover_tmp(relay_home: &Path, data_dir: &Path) -> usize {
    let mut n = 0;
    let me = std::process::id();
    for (i, dir) in [relay_home, data_dir].into_iter().enumerate() {
        if i == 1 && dir == relay_home {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if matches!(leftover_tmp_pid(&name), Some(pid) if pid != me) && std::fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// 檔名是不是換檔留下的暫存檔：是就回行程號。只認節點金鑰檔與登入資料檔
pub fn leftover_tmp_pid(name: &str) -> Option<u32> {
    let rest = name.strip_suffix(".tmp")?;
    let (rest, seq) = rest.rsplit_once('.')?;
    let (base, pid) = rest.rsplit_once('.')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(seq) || !digits(pid) {
        return None;
    }
    let secret = base == LOGIN_FILE || base.strip_suffix(".key").is_some_and(|stem| !stem.is_empty());
    if secret {
        pid.parse().ok()
    } else {
        None
    }
}

/// 手機的登入資料是不是（照規矩）加密存著：沒有檔、讀不到＝是（沒有東西要提醒）；有檔但不是 `ak1:` 開頭＝否（明文備援中，下次開啟會再試著加密）
pub fn login_is_sealed(data_dir: &Path) -> bool {
    match std::fs::read(data_dir.join(LOGIN_FILE)) {
        Ok(b) => b.starts_with(PREFIX),
        Err(_) => true,
    }
}

/// 加密後原子寫入：檔案內容＝[`PREFIX`]＋金鑰庫加密的位元組
pub fn write_sealed(path: &Path, aad: &[u8], plain: &[u8], aead: &dyn Aead) -> Result<(), String> {
    let mut out = PREFIX.to_vec();
    out.extend(aead.seal(aad, plain)?);
    replace_atomic(path, &out).map_err(|e| format!("寫不進檔案：{e}"))
}

/// 把沒有前綴的舊明文檔改存成加密的（拿全域鎖；換名前再讀一次檔案，和當初讀到的不同＝中途有人寫了新內容，放棄不蓋）。
/// Ok(true)＝已改存；Ok(false)＝放棄（保留較新的檔）；Err＝加密或寫入失敗。`hook` 在「換名前的再讀」之前呼叫（測試用）
fn migrate_plain(path: &Path, aad: &[u8], raw: &[u8], a: &dyn Aead, hook: &dyn Fn()) -> Result<bool, String> {
    let _g = lock();
    let mut out = PREFIX.to_vec();
    out.extend(a.seal(aad, raw)?);
    let guard = || {
        hook();
        std::fs::read(path).map(|cur| cur == raw).unwrap_or(false)
    };
    replace_atomic_with(path, &out, &|_| true, &guard).map_err(|e| format!("寫不進檔案：{e}"))
}

/// 讀一個機密檔。`aead` 為 `None`（電腦版）＝原樣讀出。
/// 有前綴＝請金鑰庫解開（不降級）；沒有前綴＝舊的明文：照舊讀出，並盡力改存成加密的
pub fn read_secret(path: &Path, aad: &[u8], aead: Option<&dyn Aead>, seal_fail_flag: &AtomicBool, seal_fail_line: &str) -> Result<Vec<u8>, ReadErr> {
    read_secret_hooked(path, aad, aead, seal_fail_flag, seal_fail_line, &|| {})
}

fn read_secret_hooked(path: &Path, aad: &[u8], aead: Option<&dyn Aead>, seal_fail_flag: &AtomicBool, seal_fail_line: &str, hook: &dyn Fn()) -> Result<Vec<u8>, ReadErr> {
    let raw = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReadErr::Missing),
        Err(e) => return Err(ReadErr::Io(e.to_string())),
    };
    let Some(a) = aead else { return Ok(raw) };
    if let Some(body) = raw.strip_prefix(PREFIX) {
        return a.open(aad, body).map_err(ReadErr::Unseal);
    }
    if !raw.iter().all(|b| b.is_ascii_whitespace()) {
        match migrate_plain(path, aad, &raw, a, hook) {
            Ok(true) => {}
            // 讀到之後檔案被換成較新的內容：不蓋它，改回傳現在的內容
            Ok(false) => return read_secret_hooked(path, aad, aead, seal_fail_flag, seal_fail_line, &|| {}),
            Err(_) => log_once(seal_fail_flag, seal_fail_line),
        }
    }
    Ok(raw)
}

// ---------- 節點金鑰 ----------

/// 讀 `<節點>.key`（`path` 是那個檔）。回金鑰原文（呼叫端自己 trim）
pub fn read_node_key(path: &Path, node: &str, aead: Option<&dyn Aead>) -> Result<String, ReadErr> {
    let raw = read_secret(path, &node_key_aad(node), aead, &NODE_KEY_SEAL_LOGGED, NODE_KEY_SEAL_FAIL)?;
    String::from_utf8(raw).map_err(|_| ReadErr::Io("金鑰檔不是文字".to_string()))
}

/// 把節點金鑰以加密形式原子寫進 `path`。回 true＝已寫好（呼叫端不必再寫明文）；
/// false＝沒有金鑰庫，或加密／寫入失敗（記一行 log），呼叫端走原本的明文寫法
pub fn write_node_key(path: &Path, node: &str, key: &str, aead: Option<&dyn Aead>) -> bool {
    let Some(a) = aead else { return false };
    let _g = lock();
    match write_sealed(path, &node_key_aad(node), key.as_bytes(), a) {
        Ok(()) => true,
        Err(_) => {
            log_once(&NODE_KEY_SEAL_LOGGED, NODE_KEY_SEAL_FAIL);
            false
        }
    }
}

// ---------- 登入資料 ----------

/// 手機的登入資料存檔（`login.bin`）：內容經金鑰庫加密
pub struct SealedLoginStore {
    pub path: PathBuf,
    pub aead: Box<dyn Aead>,
}

impl SealedLoginStore {
    fn set_aside(&self) {
        let mut name: OsString = self.path.as_os_str().to_owned();
        name.push(UNREADABLE_SUFFIX);
        if let Err(e) = std::fs::rename(&self.path, PathBuf::from(name)) {
            elog!("[ASN] 登入存檔沒辦法改名留存：{e}");
        }
    }
}

impl TokenStore for SealedLoginStore {
    fn load(&self) -> Result<Option<StoredLogin>, String> {
        self.load_hooked(&|| {})
    }

    fn save(&self, login: &StoredLogin) -> Result<(), String> {
        let plain = encode_login(login);
        let _g = lock();
        if write_sealed(&self.path, LOGIN_AAD, &plain, &*self.aead).is_ok() {
            return Ok(());
        }
        // 加密不了：登入還是要能存，維持明文（0600、原子換檔）；明文檔本身就是記號，下次開啟 load 會再試著加密
        log_once(&LOGIN_SEAL_LOGGED, LOGIN_SEAL_FAIL);
        crate::device_id::write_private(&self.path, &plain).map_err(|e| e.to_string())
    }

    fn clear(&self) -> Result<(), String> {
        let _g = lock();
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("刪不掉登入存檔：{e}")),
        }
    }
}

impl SealedLoginStore {
    fn load_hooked(&self, hook: &dyn Fn()) -> Result<Option<StoredLogin>, String> {
        let raw = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("讀不到登入存檔：{e}")),
        };
        if let Some(body) = raw.strip_prefix(PREFIX) {
            return match self.aead.open(LOGIN_AAD, body) {
                Ok(plain) => Ok(decode_login(&plain)),
                Err(e) => {
                    elog!("[ASN] 登入存檔解不開，當作沒登入：{e}");
                    if e == KEY_LOST {
                        self.set_aside();
                    }
                    Ok(None)
                }
            };
        }
        // 舊的明文檔（或上次加密失敗留下的明文）：讀到的同時升級成加密的，失敗就維持原樣、不影響使用、下次啟動再試
        let login = decode_login(&raw);
        if login.is_some() {
            match migrate_plain(&self.path, LOGIN_AAD, &raw, &*self.aead, hook) {
                Ok(true) => {}
                Ok(false) => return self.load_hooked(&|| {}),
                Err(_) => log_once(&LOGIN_SEAL_LOGGED, LOGIN_SEAL_FAIL),
            }
        }
        Ok(login)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// 假的金鑰庫：AAD 的雜湊綁在密文前面（AAD 不同就解不開）；可設成加密失敗／包裝金鑰不見／暫時忙
    #[derive(Clone, Default)]
    struct Strict {
        fail_seal: Arc<AtomicBool>,
        lost: Arc<AtomicBool>,
        busy: Arc<AtomicBool>,
        seals: Arc<AtomicUsize>,
    }
    impl Aead for Strict {
        fn seal(&self, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
            if self.fail_seal.load(Ordering::SeqCst) {
                return Err("金鑰庫忙".into());
            }
            self.seals.fetch_add(1, Ordering::SeqCst);
            let mut out = Sha256::digest(aad)[..8].to_vec();
            out.extend(plain.iter().map(|b| b ^ 0x5a));
            Ok(out)
        }
        fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
            if self.lost.load(Ordering::SeqCst) {
                return Err(KEY_LOST.into());
            }
            if self.busy.load(Ordering::SeqCst) || sealed.len() < 8 || sealed[..8] != Sha256::digest(aad)[..8] {
                return Err("解不開".into());
            }
            Ok(sealed[8..].iter().map(|b| b ^ 0x5a).collect())
        }
    }

    const KEY: &str = "NODE-KEY-PLAINTEXT-value_1";

    fn files(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn 節點金鑰_舊的明文檔_讀出並改存成加密的_不留暫存檔() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("n1.key");
        std::fs::write(&f, KEY).unwrap();
        let ks = Strict::default();
        assert_eq!(read_node_key(&f, "n1", Some(&ks)).unwrap(), KEY);
        let raw = std::fs::read(&f).unwrap();
        assert!(raw.starts_with(PREFIX), "檔案已經是加密的");
        assert!(!String::from_utf8_lossy(&raw).contains(KEY), "明文不在了");
        assert_eq!(ks.open(&node_key_aad("n1"), &raw[PREFIX.len()..]).unwrap(), KEY.as_bytes(), "解開是原本的金鑰");
        assert_eq!(files(d.path()), vec!["n1.key"], "沒有留下暫存檔");
    }

    #[test]
    fn 節點金鑰_已經加密的_讀出來不重寫() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("n1.key");
        let ks = Strict::default();
        assert!(write_node_key(&f, "n1", KEY, Some(&ks)));
        let before = std::fs::read(&f).unwrap();
        let n = ks.seals.load(Ordering::SeqCst);
        assert_eq!(read_node_key(&f, "n1", Some(&ks)).unwrap(), KEY);
        assert_eq!(ks.seals.load(Ordering::SeqCst), n, "沒有再加密一次");
        assert_eq!(std::fs::read(&f).unwrap(), before);
        assert_eq!(files(d.path()), vec!["n1.key"]);
    }

    #[test]
    fn 節點金鑰_加密失敗_維持明文並照樣回傳() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("n1.key");
        std::fs::write(&f, KEY).unwrap();
        let ks = Strict::default();
        ks.fail_seal.store(true, Ordering::SeqCst);
        assert_eq!(read_node_key(&f, "n1", Some(&ks)).unwrap(), KEY);
        assert_eq!(std::fs::read(&f).unwrap(), KEY.as_bytes(), "維持明文");
        assert_eq!(files(d.path()), vec!["n1.key"]);
        assert!(!write_node_key(&d.path().join("n2.key"), "n2", KEY, Some(&ks)), "新寫的加密失敗：回 false 讓呼叫端走明文寫法");
        assert_eq!(files(d.path()), vec!["n1.key"], "也沒有留下半個檔");
    }

    #[test]
    fn 節點金鑰_解不開_回明確錯誤_檔案不動() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("n1.key");
        let ks = Strict::default();
        assert!(write_node_key(&f, "n1", KEY, Some(&ks)));
        let before = std::fs::read(&f).unwrap();
        ks.lost.store(true, Ordering::SeqCst);
        assert_eq!(read_node_key(&f, "n1", Some(&ks)), Err(ReadErr::Unseal(KEY_LOST.to_string())));
        let e = crate::identity::read_key_with(d.path(), "n1", None, Some(&ks)).unwrap_err();
        assert_eq!(e, NODE_KEY_UNSEAL_MSG);
        assert!(e.contains("重新配對"));
        assert_eq!(std::fs::read(&f).unwrap(), before, "不自動刪、不改");
        assert_eq!(read_node_key(&d.path().join("none.key"), "none", Some(&ks)), Err(ReadErr::Missing));
    }

    #[test]
    fn 節點金鑰_檔名或節點代號對不上就解不開() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        assert!(write_node_key(&d.path().join("aa.key"), "aa", KEY, Some(&ks)));
        std::fs::copy(d.path().join("aa.key"), d.path().join("bb.key")).unwrap();
        assert!(matches!(read_node_key(&d.path().join("bb.key"), "bb", Some(&ks)), Err(ReadErr::Unseal(_))), "換成別的節點的檔名");
        assert!(matches!(read_node_key(&d.path().join("aa.key"), "bb", Some(&ks)), Err(ReadErr::Unseal(_))), "節點代號不同");
        assert_eq!(read_node_key(&d.path().join("aa.key"), "aa", Some(&ks)).unwrap(), KEY);
    }

    #[test]
    fn 節點金鑰_沒有金鑰庫_電腦版原樣() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("n1.key");
        std::fs::write(&f, KEY).unwrap();
        assert_eq!(read_node_key(&f, "n1", None).unwrap(), KEY);
        assert_eq!(std::fs::read(&f).unwrap(), KEY.as_bytes(), "不改檔");
        assert!(!write_node_key(&f, "n1", "X", None));
        assert_eq!(std::fs::read(&f).unwrap(), KEY.as_bytes());
        #[cfg(not(target_os = "android"))]
        assert!(platform_aead().is_none(), "電腦版沒有這一層");
    }

    // account 模組只在有畫面的建置裡（headless 沒有）
    #[cfg(feature = "gui")]
    #[test]
    fn 節點金鑰_寫節點檔案走加密() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        crate::account::write_node_files_with(d.path(), "t5-ab12cd34", KEY, |_| false, Some(&ks)).unwrap();
        let raw = std::fs::read(d.path().join("t5-ab12cd34.key")).unwrap();
        assert!(raw.starts_with(PREFIX) && !String::from_utf8_lossy(&raw).contains(KEY));
        assert_eq!(std::fs::read_to_string(d.path().join("node")).unwrap(), "t5-ab12cd34");
        assert_eq!(crate::identity::read_key_with(d.path(), "t5-ab12cd34", None, Some(&ks)).unwrap(), KEY);
        assert_eq!(files(d.path()), vec!["node", "t5-ab12cd34.key"]);
        // 加密失敗：退回原本的明文寫法（restrict 照舊要過）
        let d2 = tempfile::tempdir().unwrap();
        ks.fail_seal.store(true, Ordering::SeqCst);
        crate::account::write_node_files_with(d2.path(), "t5-ab12cd34", KEY, |_| true, Some(&ks)).unwrap();
        assert_eq!(std::fs::read_to_string(d2.path().join("t5-ab12cd34.key")).unwrap(), KEY);
    }

    fn login() -> StoredLogin {
        StoredLogin { refresh_token: "SECRET-REFRESH-TOKEN-123".into(), email: Some("a@b.c".into()) }
    }
    fn store(d: &Path, ks: &Strict) -> SealedLoginStore {
        SealedLoginStore { path: d.join("login.bin"), aead: Box::new(ks.clone()) }
    }

    #[test]
    fn 登入資料_存讀清_檔案裡看不到明文() {
        let d = tempfile::tempdir().unwrap();
        let st = store(d.path(), &Strict::default());
        assert!(st.load().unwrap().is_none());
        st.save(&login()).unwrap();
        let raw = std::fs::read(d.path().join("login.bin")).unwrap();
        assert!(raw.starts_with(PREFIX) && !String::from_utf8_lossy(&raw).contains("SECRET-REFRESH-TOKEN-123"));
        assert!(st.load().unwrap().unwrap() == login());
        st.clear().unwrap();
        st.clear().unwrap();
        assert!(st.load().unwrap().is_none());
        assert!(files(d.path()).is_empty(), "沒有留下暫存檔");
    }

    #[test]
    fn 登入資料_舊的明文檔_讀一次就改存成加密的() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        std::fs::write(d.path().join("login.bin"), encode_login(&login())).unwrap();
        let st = store(d.path(), &ks);
        assert!(st.load().unwrap().unwrap() == login());
        let raw = std::fs::read(d.path().join("login.bin")).unwrap();
        assert!(raw.starts_with(PREFIX) && !String::from_utf8_lossy(&raw).contains("SECRET-REFRESH-TOKEN-123"), "明文不在了");
        assert_eq!(files(d.path()), vec!["login.bin"]);
        let n = ks.seals.load(Ordering::SeqCst);
        assert!(st.load().unwrap().unwrap() == login());
        assert_eq!(ks.seals.load(Ordering::SeqCst), n, "已加密的不重寫");
    }

    #[test]
    fn 登入資料_加密失敗_維持明文照樣登入() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        ks.fail_seal.store(true, Ordering::SeqCst);
        std::fs::write(d.path().join("login.bin"), encode_login(&login())).unwrap();
        let st = store(d.path(), &ks);
        assert!(st.load().unwrap().unwrap() == login());
        assert_eq!(std::fs::read(d.path().join("login.bin")).unwrap(), encode_login(&login()), "維持明文");
        st.clear().unwrap();
        st.save(&login()).unwrap();
        assert!(st.load().unwrap().unwrap() == login(), "存不了加密的就存明文，登入不丟");
        assert_eq!(files(d.path()), vec!["login.bin"]);
    }

    #[test]
    fn 登入資料_包裝金鑰不見_當作沒登入_檔案改名留著() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        let st = store(d.path(), &ks);
        st.save(&login()).unwrap();
        let before = std::fs::read(d.path().join("login.bin")).unwrap();
        ks.lost.store(true, Ordering::SeqCst);
        assert!(st.load().unwrap().is_none());
        assert_eq!(files(d.path()), vec!["login.bin.unreadable"]);
        assert_eq!(std::fs::read(d.path().join("login.bin.unreadable")).unwrap(), before, "內容原封不動");
        assert!(st.load().unwrap().is_none(), "之後就是沒登入的狀態");
    }

    #[test]
    fn 登入資料_其他解不開的錯誤_當作沒登入但檔案原地不動() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        // 用別的用途加密的內容放進 login.bin（AAD 對不上）
        let other = d.path().join("login.bin");
        write_sealed(&other, b"asn-node-key-v1:x.key", b"{}", &ks).unwrap();
        let before = std::fs::read(&other).unwrap();
        let st = store(d.path(), &ks);
        assert!(st.load().unwrap().is_none());
        assert_eq!(std::fs::read(&other).unwrap(), before);
        assert_eq!(files(d.path()), vec!["login.bin"]);
    }

    #[test]
    fn 舊明文改存加密_讀到之後檔案被換成新內容_放棄不蓋() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("n1.key");
        std::fs::write(&f, KEY).unwrap();
        let ks = Strict::default();
        let flag = AtomicBool::new(false);
        // 模擬：讀到明文之後、換名之前，另一邊寫入了新的（加密的）金鑰
        let hook = || write_sealed(&f, &node_key_aad("n1"), b"NEWER-KEY", &ks).unwrap();
        let got = read_secret_hooked(&f, &node_key_aad("n1"), Some(&ks), &flag, "x", &hook).unwrap();
        assert_eq!(got, b"NEWER-KEY", "回傳的是較新的內容，不是舊明文");
        let raw = std::fs::read(&f).unwrap();
        assert!(raw.starts_with(PREFIX));
        assert_eq!(ks.open(&node_key_aad("n1"), &raw[PREFIX.len()..]).unwrap(), b"NEWER-KEY", "較新的檔案完好");
        assert_eq!(files(d.path()), vec!["n1.key"], "暫存檔已刪");
        assert!(!flag.load(Ordering::SeqCst), "放棄不算加密失敗");
    }

    #[test]
    fn 登入資料_舊明文改存加密_中途被換成新內容_放棄不蓋() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        let st = store(d.path(), &ks);
        std::fs::write(d.path().join("login.bin"), encode_login(&login())).unwrap();
        let newer = StoredLogin { refresh_token: "NEWER-TOKEN".into(), email: None };
        let hook = || {
            let mut out = PREFIX.to_vec();
            out.extend(ks.seal(LOGIN_AAD, &encode_login(&newer)).unwrap());
            std::fs::write(d.path().join("login.bin"), out).unwrap();
        };
        assert!(st.load_hooked(&hook).unwrap().unwrap() == newer);
        assert!(st.load().unwrap().unwrap() == newer, "檔案是較新的那份");
        assert_eq!(files(d.path()), vec!["login.bin"]);
    }

    #[test]
    fn 明文備援寫入_失敗不動原檔_成功換新且不留暫存檔() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("n1.key");
        let ks = Strict::default();
        assert!(write_node_key(&f, "n1", KEY, Some(&ks)));
        let before = std::fs::read(&f).unwrap();
        assert!(write_plain_atomic(&f, b"NEW-PLAIN", &|_| false).is_err());
        assert_eq!(std::fs::read(&f).unwrap(), before, "原本的金鑰檔不動");
        assert_eq!(files(d.path()), vec!["n1.key"], "只刪暫存檔");
        let seen = std::cell::Cell::new(usize::MAX);
        write_plain_atomic(&f, b"NEW-PLAIN", &|p| { seen.set(std::fs::metadata(p).unwrap().len() as usize); true }).unwrap();
        assert_eq!(seen.get(), 0, "限縮權限時暫存檔還是空的");
        assert_eq!(std::fs::read(&f).unwrap(), b"NEW-PLAIN");
        assert_eq!(files(d.path()), vec!["n1.key"], "沒有留下暫存檔");
    }

    #[cfg(feature = "gui")]
    #[test]
    fn 節點金鑰_備援寫入失敗_原本的金鑰檔不動() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        crate::account::write_node_files_with(d.path(), "t5-ab12cd34", KEY, |_| false, Some(&ks)).unwrap();
        let before = std::fs::read(d.path().join("t5-ab12cd34.key")).unwrap();
        ks.fail_seal.store(true, Ordering::SeqCst);
        assert!(crate::account::write_node_files_with(d.path(), "t5-ab12cd34", "OTHER-KEY-2", |_| false, Some(&ks)).is_err());
        assert_eq!(std::fs::read(d.path().join("t5-ab12cd34.key")).unwrap(), before);
        assert_eq!(files(d.path()), vec!["node", "t5-ab12cd34.key"]);
        crate::account::write_node_files_with(d.path(), "t5-ab12cd34", "OTHER-KEY-2", |_| true, Some(&ks)).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("t5-ab12cd34.key")).unwrap(), "OTHER-KEY-2");
        assert_eq!(files(d.path()), vec!["node", "t5-ab12cd34.key"]);
    }

    #[test]
    fn 登入資料_加密失敗留明文_之後每次載入都會再試_成功就改成加密() {
        let d = tempfile::tempdir().unwrap();
        let ks = Strict::default();
        let st = store(d.path(), &ks);
        ks.fail_seal.store(true, Ordering::SeqCst);
        st.save(&login()).unwrap();
        assert!(!login_is_sealed(d.path()), "明文備援中");
        assert!(st.load().unwrap().unwrap() == login());
        assert!(!login_is_sealed(d.path()), "還是失敗：維持明文");
        ks.fail_seal.store(false, Ordering::SeqCst);
        assert!(st.load().unwrap().unwrap() == login(), "金鑰庫恢復後下一次載入就改存加密");
        assert!(login_is_sealed(d.path()));
        assert_eq!(files(d.path()), vec!["login.bin"]);
    }

    #[test]
    fn 登入資料_是否加密的判斷() {
        let d = tempfile::tempdir().unwrap();
        assert!(login_is_sealed(d.path()), "沒有檔：沒有東西要提醒");
        std::fs::write(d.path().join("login.bin"), b"plain").unwrap();
        assert!(!login_is_sealed(d.path()));
        std::fs::write(d.path().join("login.bin"), b"ak1:xyz").unwrap();
        assert!(login_is_sealed(d.path()));
    }

    #[test]
    fn 換檔暫存檔的名字比對_只認兩種機密檔() {
        assert_eq!(leftover_tmp_pid("n1.key.123.0.tmp"), Some(123));
        assert_eq!(leftover_tmp_pid("t5-ab12cd34.key.9.17.tmp"), Some(9));
        assert_eq!(leftover_tmp_pid("login.bin.42.3.tmp"), Some(42));
        for no in ["notes.txt.1.2.tmp", "n1.key.tmp", "n1.key.1.tmp", "n1.key.x.2.tmp", "n1.key.1.y.tmp", ".key.1.2.tmp", "n1.key.1.2", "login.bin", "login.bin.unreadable.1.2.tmp", "login.bin.1.tmp", "xlogin.bin.1.2.tmp", "n1.key.1.2.tmp.bak"] {
            assert_eq!(leftover_tmp_pid(no), None, "{no}");
        }
    }

    #[test]
    fn 啟動清理_只刪別的行程留下的機密檔暫存檔() {
        let rh = tempfile::tempdir().unwrap();
        let dd = tempfile::tempdir().unwrap();
        let other = std::process::id().wrapping_add(1);
        let mine = std::process::id();
        let stale_key = format!("n1.key.{other}.0.tmp");
        let stale_login = format!("login.bin.{other}.5.tmp");
        let live = format!("n1.key.{mine}.9.tmp");
        std::fs::write(rh.path().join(&stale_key), "x").unwrap();
        std::fs::write(rh.path().join("n1.key"), "keep").unwrap();
        std::fs::write(rh.path().join("other.txt.1.2.tmp"), "keep").unwrap();
        std::fs::write(rh.path().join(&live), "keep").unwrap();
        std::fs::write(dd.path().join(&stale_login), "x").unwrap();
        std::fs::write(dd.path().join("settings.json.tmp"), "keep").unwrap();
        assert_eq!(cleanup_leftover_tmp(rh.path(), dd.path()), 2);
        assert_eq!(files(rh.path()), vec!["n1.key".to_string(), live.clone(), "other.txt.1.2.tmp".to_string()]);
        assert_eq!(files(dd.path()), vec!["settings.json.tmp"]);
        assert_eq!(cleanup_leftover_tmp(rh.path(), rh.path()), 0);
        assert_eq!(cleanup_leftover_tmp(&rh.path().join("none"), dd.path()), 0, "資料夾不存在不出錯");
    }

    #[test]
    fn 守門_兩個檔案只經這一層讀寫() {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut all = Vec::new();
        walk(&root, &mut all);
        assert!(all.len() > 20, "掃得到原始碼");
        // 允許直接提到節點金鑰檔名的：身分（讀）、帳號（寫）、裝置授權登入（寫）、這個模組
        let key_owners = ["identity.rs", "account.rs", "device_login.rs", "secret_file.rs"];
        // 允許提到 login.bin 的：登入（預設存檔）、金鑰庫偵測（keystore，只看前綴）、這個模組
        let login_owners = ["auth.rs", "keystore.rs", "secret_file.rs"];
        for p in all {
            let rel = p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            if rel.contains("tests") {
                continue;
            }
            let text = std::fs::read_to_string(&p).unwrap();
            let body = text.split("#[cfg(test)]").next().unwrap();
            let name = rel.rsplit('/').next().unwrap();
            let no_anon = body.replace("anon.key", "");
            if !key_owners.contains(&name) {
                assert!(!no_anon.contains(".key\""), "{rel} 不能直接碰節點金鑰檔");
            }
            if !login_owners.contains(&name) {
                assert!(!body.contains("login.bin"), "{rel} 不能直接碰 login.bin");
            }
            if name == "identity.rs" {
                for l in no_anon.lines().filter(|l| l.contains(".key\"")) {
                    assert!(!l.contains("read_to_string") && !l.contains("fs::read("), "身分讀節點金鑰要走 secret_file：{l}");
                }
            }
        }
        let auth = include_str!("auth.rs");
        let ds = auth.split("pub fn default_store(").nth(1).unwrap().split("\n}").next().unwrap();
        assert!(ds.contains("SealedLoginStore"), "手機的登入存檔走金鑰庫");
    }
}
