//! 附件快取（#1493）：看大圖、另存都先讀本機的副本，沒有才向收發室換網址下載。
//! - 只存下載後通過大小、型別、檔頭檢查的檔；讀出來時再驗一次（大小、型別、檔頭），不對就丟掉重抓。
//! - 檔名只用驗過的附件編號（uuid，小寫）；寄件人給的檔名只放在旁邊的說明檔裡，不拿來當路徑。
//! - 依節點分資料夾；登出、登入時整個清空，換人登入看不到上一個帳號的圖。
//! - 上限 200 MB（超過刪最久沒用的）；存超過 30 天的刪掉，和後台的保存期限一致。
//! - 電腦放在 %LOCALAPPDATA%\tw.yooliang.asn\attach-cache；手機放在 App 的 cache 資料夾（系統可以清，清掉就重新下載）。
use crate::attach::{clean_name_or, content_ok, download, ext_of, is_uuid, limit_of, Downloaded};
use crate::relay::Relay;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 快取資料夾名（放在系統的 App 快取資料夾底下）
pub const DIR_NAME: &str = "attach-cache";
/// 總量上限
pub const CAP_BYTES: u64 = 200 * 1024 * 1024;
/// 保留天數（同後台附件保存期限）
pub const KEEP: Duration = Duration::from_secs(30 * 86_400);
/// 暫存檔放超過這麼久才算寫到一半沒寫完的殘骸
const TMP_GRACE: Duration = Duration::from_secs(600);
/// 記錄快取屬於哪個帳號的檔（放在 attach-cache 底下）：帳號對不上就整個清空
const OWNER_FILE: &str = ".owner";

/// 讀、寫、清理、清空都排隊做（整個行程一把鎖）：同一張圖同時開兩次、兩個視窗同時看，不會互相蓋掉或刪掉剛寫好的檔。
/// 鎖只包本機檔案操作，下載不在鎖裡
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 暫存檔的尾碼：行程編號＋計數＋時間，同一個行程內不會重複
fn tmp_suffix() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{}-{n}-{t:08x}", std::process::id())
}

/// 帳號 → 寫進 .owner 的值（雜湊，不留 email 原文）。沒登入算一種
pub fn owner_key(email: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    match email {
        Some(e) => {
            let h = Sha256::digest(format!("asn-attach-cache:{}", e.trim().to_lowercase()).as_bytes());
            h.iter().take(16).map(|b| format!("{b:02x}")).collect()
        }
        None => "signed-out".into(),
    }
}

/// 用快取前先對帳號：.owner 跟現在的帳號不同（換人登入、登入過期被登出、或還沒記過）就整個清空再記新的。
/// 不管是從哪條路換帳號（登入、登出、過期、之後新增的路），下一次看圖前都會清掉
/// 回 true＝剛清空過（帳號換了），呼叫端要通知畫面把記在記憶體裡的圖也丟掉
pub fn ensure_owner(root: &Path, key: &str) -> Result<bool, String> {
    let _g = lock();
    let d = root.join(DIR_NAME);
    let f = d.join(OWNER_FILE);
    if owner_is(&f, key) {
        return Ok(false);
    }
    clear_locked(root)?;
    std::fs::create_dir_all(&d).map_err(|e| format!("建不了快取資料夾：{e}"))?;
    restrict_dir(&d);
    create_new_file(&f, key.as_bytes()).map_err(|e| format!("記不了快取的帳號：{e}"))?;
    Ok(true)
}

fn owner_is(f: &Path, key: &str) -> bool {
    AttachCache::plain_file(f).is_some() && std::fs::read_to_string(f).is_ok_and(|s| s == key)
}

pub struct AttachCache {
    dir: PathBuf,
    cap: u64,
    keep: Duration,
    /// （.owner 的路徑, 建這個快取時的帳號）：寫入前再對一次，下載途中換了帳號就不寫回
    owner: Option<(PathBuf, String)>,
}

/// Linux／macOS：資料夾 0700、檔案 0600，同一台的其他使用者讀不到（同下載腳本的做法）。Windows 的 LOCALAPPDATA 本來就只有本人
#[cfg(unix)]
fn restrict_dir(d: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn restrict_dir(_: &Path) {}

/// 新建一個檔（已存在就失敗，不跟著同名的連結寫出去），Unix 上權限 0600
fn create_new_file(p: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut o = std::fs::File::options();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(p)?.write_all(data)
}

fn now_ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 節點代號 → 資料夾名：只留英數、底線、連字號；清完沒東西用 default
fn node_dir_name(node: &str) -> String {
    let s: String = node.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(64).collect();
    if s.is_empty() { "default".into() } else { s }
}

/// 這台、這個節點的快取資料夾（root＝系統的 App 快取資料夾）
pub fn dir_for(root: &Path, node: &str) -> PathBuf {
    root.join(DIR_NAME).join(node_dir_name(node))
}

/// 整個附件快取清空（所有節點）。登出、登入時呼叫；資料夾不存在不算錯。
/// 只刪 root 底下的 attach-cache；remove_dir_all 不跟著連結、junction 走（遇到只拿掉連結本身），attach-cache 本身是連結時也只拿掉連結
pub fn clear_all(root: &Path) -> Result<(), String> {
    let _g = lock();
    clear_locked(root)
}

/// 依賴 remove_dir_all 不跟著 junction／連結走（Rust 1.58.1 起；CI 與本機發版建置都要用新版 stable，這個 crate 本來就要 1.82 以上）
fn clear_locked(root: &Path) -> Result<(), String> {
    let d = root.join(DIR_NAME);
    match std::fs::remove_dir_all(&d) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清不掉附件快取：{e}")),
    }
}

impl AttachCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, cap: CAP_BYTES, keep: KEEP, owner: None }
    }

    /// 綁上帳號：寫入前 .owner 必須還是這個帳號，不是就不寫（下載途中登出、換人登入）
    pub fn with_owner(mut self, root: &Path, key: &str) -> Self {
        self.owner = Some((root.join(DIR_NAME).join(OWNER_FILE), key.to_string()));
        self
    }

    #[cfg(test)]
    fn with_limits(dir: PathBuf, cap: u64, keep: Duration) -> Self {
        Self { dir, cap, keep, owner: None }
    }

    /// 編號 → 檔案路徑。編號不是 uuid 回 None（不拿外部字串組路徑）
    fn paths(&self, id: &str) -> Option<(PathBuf, PathBuf)> {
        if !is_uuid(id) {
            return None;
        }
        let id = id.to_ascii_lowercase();
        Some((self.dir.join(format!("{id}.bin")), self.dir.join(format!("{id}.json"))))
    }

    /// 快取資料夾與上一層（attach-cache）不能是連結或 junction：是的話不讀不寫，免得寫到別的地方去。
    /// 還沒建出來算正常（put 會建）
    fn dir_ok(&self) -> bool {
        [Some(self.dir.as_path()), self.dir.parent()].into_iter().flatten().all(|d| match std::fs::symlink_metadata(d) {
            Ok(m) => m.is_dir() && !m.file_type().is_symlink(),
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        })
    }

    /// 是真的一般檔（不是連結、junction、資料夾）才回它的資訊；不跟著連結走
    fn plain_file(p: &Path) -> Option<std::fs::Metadata> {
        std::fs::symlink_metadata(p).ok().filter(|m| m.is_file() && !m.file_type().is_symlink())
    }

    /// 刪掉一個項目本身：一般檔、檔案連結用 remove_file；資料夾連結、junction 用 remove_dir（只拿掉連結，不碰它指到的內容）。
    /// 真的資料夾不刪（這個資料夾只放快取自己寫的檔，不會有子資料夾）
    fn remove_entry(p: &Path) {
        let Ok(m) = std::fs::symlink_metadata(p) else { return };
        if m.file_type().is_symlink() {
            if std::fs::remove_file(p).is_err() {
                let _ = std::fs::remove_dir(p);
            }
        } else if m.is_file() {
            let _ = std::fs::remove_file(p);
        }
    }

    fn drop_entry(bin: &Path, meta: &Path) {
        Self::remove_entry(bin);
        Self::remove_entry(meta);
    }

    /// 讀快取：沒有、過期、或驗不過都回 None（驗不過的順手刪掉）。讀到就把最後使用時間更新成現在
    pub fn get(&self, id: &str) -> Option<Downloaded> {
        let _g = lock();
        self.get_at(id, SystemTime::now())
    }

    fn get_at(&self, id: &str, now: SystemTime) -> Option<Downloaded> {
        let (bin, meta) = self.paths(id)?;
        if !self.dir_ok() {
            return None;
        }
        // 不是一般檔（例如被換成連結）就當作沒有並刪掉連結本身，不跟著它去讀別的檔
        let (Some(md), Some(mm)) = (Self::plain_file(&bin), Self::plain_file(&meta)) else {
            Self::drop_entry(&bin, &meta);
            return None;
        };
        let stored = mm.modified().ok();
        // 存進來的時間看說明檔（讀的時候不更新它）；超過保留天數就丟
        if stored.is_none_or(|t| now.duration_since(t).unwrap_or_default() >= self.keep) {
            Self::drop_entry(&bin, &meta);
            return None;
        }
        let ok = (|| {
            let info: Value = serde_json::from_slice(&std::fs::read(&meta).ok()?).ok()?;
            let mime = info.get("mime")?.as_str()?.to_string();
            let size = info.get("bytes")?.as_u64()?;
            // 附件本身的到期時間（畫面給的，寫入時已經壓在 30 天內）：到了就當作沒有
            if info.get("until_ms").and_then(Value::as_u64).is_some_and(|u| now_ms(now) >= u) {
                return None;
            }
            ext_of(&mime)?;
            if md.len() != size || size as usize > limit_of(&mime) {
                return None;
            }
            let bytes = std::fs::read(&bin).ok()?;
            if bytes.len() as u64 != size || !content_ok(&mime, &bytes) {
                return None;
            }
            let name = clean_name_or(info.get("name").and_then(Value::as_str).unwrap_or(""), "file");
            Some(Downloaded { name, mime, bytes })
        })();
        match ok {
            Some(d) => {
                // 最後使用時間記在檔案本身的修改時間上（淘汰時先刪最久沒用的）
                if let Ok(f) = std::fs::File::options().write(true).open(&bin) {
                    let _ = f.set_modified(now);
                }
                Some(d)
            }
            None => {
                Self::drop_entry(&bin, &meta);
                None
            }
        }
    }

    /// 寫快取：只收型別認得、大小與檔頭都對的檔（呼叫端已檢查過，這裡再擋一次）。先寫暫存檔再改名，寫到一半不會留下壞檔
    /// until_ms＝附件的到期時間（畫面從信件欄位帶來；沒有就只看 30 天）。已經過期的不存
    pub fn put(&self, id: &str, d: &Downloaded, until_ms: Option<u64>) -> Result<(), String> {
        let _g = lock();
        if let Some((f, key)) = &self.owner {
            if !owner_is(f, key) {
                return Err("帳號已經換了，不寫回快取".into());
            }
        }
        self.put_until(id, d, SystemTime::now(), until_ms)
    }

    #[cfg(test)]
    fn put_at(&self, id: &str, d: &Downloaded, now: SystemTime) -> Result<(), String> {
        self.put_until(id, d, now, None)
    }

    fn put_until(&self, id: &str, d: &Downloaded, now: SystemTime, until_ms: Option<u64>) -> Result<(), String> {
        let (bin, meta) = self.paths(id).ok_or("附件編號格式不對")?;
        // 到期時間只能縮短，不能比存進來起算 30 天更久
        let cap_ms = now_ms(now).saturating_add(self.keep.as_millis() as u64);
        let until = until_ms.map_or(cap_ms, |u| u.min(cap_ms));
        if until <= now_ms(now) {
            return Ok(());
        }
        if ext_of(&d.mime).is_none() || d.bytes.len() > limit_of(&d.mime) || !content_ok(&d.mime, &d.bytes) {
            return Err("檔案沒通過檢查，不存快取".into());
        }
        if d.bytes.len() as u64 > self.cap {
            return Ok(());
        }
        if !self.dir_ok() {
            return Err("快取資料夾是連結，不寫".into());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("建不了快取資料夾：{e}"))?;
        if !self.dir_ok() {
            return Err("快取資料夾是連結，不寫".into());
        }
        let sfx = tmp_suffix();
        let tmp_bin = bin.with_extension(format!("bin.{sfx}.tmp"));
        let tmp_meta = meta.with_extension(format!("json.{sfx}.tmp"));
        restrict_dir(&self.dir);
        if let Some(p) = self.dir.parent() {
            restrict_dir(p);
        }
        let info = json!({ "name": d.name, "mime": d.mime, "bytes": d.bytes.len(), "until_ms": until });
        // 暫存檔一律新建（create_new）：原本就有同名的東西（可能是連結）先拿掉，不會跟著連結寫到別處
        let fresh = |p: &Path, data: &[u8]| -> std::io::Result<()> {
            Self::remove_entry(p);
            create_new_file(p, data)
        };
        let write = || -> std::io::Result<()> {
            fresh(&tmp_bin, &d.bytes)?;
            fresh(&tmp_meta, &serde_json::to_vec(&info).unwrap_or_default())?;
            std::fs::rename(&tmp_bin, &bin)?;
            std::fs::rename(&tmp_meta, &meta)?;
            for p in [&bin, &meta] {
                std::fs::File::options().write(true).open(p)?.set_modified(now)?;
            }
            Ok(())
        };
        if let Err(e) = write() {
            for p in [&tmp_bin, &tmp_meta, &bin, &meta] {
                Self::remove_entry(p);
            }
            return Err(format!("寫不進快取：{e}"));
        }
        self.prune_at(now);
        Ok(())
    }

    /// 清理：刪過期的、沒配對的、暫存檔；總量超過上限時，從最久沒用的開始刪
    fn prune_at(&self, now: SystemTime) {
        if !self.dir_ok() {
            return;
        }
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let mut live: Vec<(SystemTime, u64, PathBuf, PathBuf)> = vec![];
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            // 連結、junction：只拿掉連結本身；真的資料夾不碰（不往下走、不整個刪）
            let Some(pm) = Self::plain_file(&p) else {
                Self::remove_entry(&p);
                continue;
            };
            if let Some(id) = name.strip_suffix(".bin") {
                let meta = self.dir.join(format!("{id}.json"));
                let stored = Self::plain_file(&meta).and_then(|m| m.modified().ok());
                let fresh = stored.is_some_and(|t| now.duration_since(t).unwrap_or_default() < self.keep);
                if is_uuid(id) && fresh {
                    live.push((pm.modified().unwrap_or(now), pm.len(), p, meta));
                } else {
                    Self::drop_entry(&p, &meta);
                }
            } else if let Some(id) = name.strip_suffix(".json") {
                if Self::plain_file(&self.dir.join(format!("{id}.bin"))).is_none() {
                    Self::remove_entry(&p);
                }
            } else {
                // 暫存檔或不認得的檔：這個資料夾只有快取自己寫的東西。暫存檔放一陣子才刪，不搶別的正在寫的
                let age = pm.modified().map(|t| now.duration_since(t).unwrap_or_default()).unwrap_or(TMP_GRACE);
                if !name.ends_with(".tmp") || age >= TMP_GRACE {
                    Self::remove_entry(&p);
                }
            }
        }
        let mut total: u64 = live.iter().map(|x| x.1).sum();
        live.sort_by_key(|x| x.0);
        for (_, len, bin, meta) in live {
            if total <= self.cap {
                break;
            }
            Self::drop_entry(&bin, &meta);
            total = total.saturating_sub(len);
        }
    }
}

/// 先讀快取，沒有才換網址下載；下載成功（download 已檢查過）就存進快取。快取寫不進去不影響這次的結果
/// until_ms＝附件的到期時間（畫面從信件欄位帶來，可以沒有）
pub async fn fetch(cache: Option<&AttachCache>, relay: &Relay, http: &reqwest::Client, id: &str, until_ms: Option<u64>) -> Result<Downloaded, String> {
    if let Some(d) = cache.and_then(|c| c.get(id)) {
        return Ok(d);
    }
    let d = download(relay, http, id).await?;
    if let Some(c) = cache {
        if let Err(e) = c.put(id, &d, until_ms) {
            elog!("attach-cache put failed id={id}: {e}");
        }
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00000000-0000-0000-0000-000000000042";
    const ID2: &str = "00000000-0000-0000-0000-000000000043";
    const ID3: &str = "00000000-0000-0000-0000-000000000044";

    fn webp(n: usize) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&((n - 8) as u32).to_le_bytes());
        v.extend_from_slice(b"WEBPVP8 ");
        v.resize(n, 0);
        v
    }
    fn img(n: usize) -> Downloaded {
        Downloaded { name: "貓.webp".into(), mime: "image/webp".into(), bytes: webp(n) }
    }
    fn files(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        v.sort();
        v
    }

    #[test]
    fn 存進去讀得回來_檔名只用附件編號() {
        let t = tempfile::tempdir().unwrap();
        let c = AttachCache::new(t.path().join("n1"));
        let mut d = img(64);
        d.name = "../../evil\u{202e}.webp".into();
        c.put(&ID.to_uppercase(), &d, None).unwrap();
        assert_eq!(files(&t.path().join("n1")), vec![format!("{ID}.bin"), format!("{ID}.json")]);
        let got = c.get(ID).unwrap();
        assert_eq!((got.mime.as_str(), got.bytes), ("image/webp", webp(64)));
        assert!(!got.name.contains('/') && !got.name.contains('\u{202e}'), "{}", got.name);
        // 編號不是 uuid：不讀不寫
        assert!(c.put("../x", &img(64), None).is_err());
        assert!(c.get("../x").is_none());
    }

    #[test]
    fn 讀出來再驗一次_被改過或大小不符就丟掉() {
        let t = tempfile::tempdir().unwrap();
        let c = AttachCache::new(t.path().to_path_buf());
        let bin = t.path().join(format!("{ID}.bin"));
        // 內容被換成別的東西（大小一樣）
        c.put(ID, &img(64), None).unwrap();
        let mut b = std::fs::read(&bin).unwrap();
        b[..4].copy_from_slice(b"<htm");
        std::fs::write(&bin, b).unwrap();
        assert!(c.get(ID).is_none());
        assert!(!bin.exists(), "驗不過的要刪掉");
        // 被截斷
        c.put(ID, &img(64), None).unwrap();
        std::fs::write(&bin, &webp(64)[..40]).unwrap();
        assert!(c.get(ID).is_none());
        // 說明檔的型別被改成不認得的
        c.put(ID, &img(64), None).unwrap();
        std::fs::write(t.path().join(format!("{ID}.json")), br#"{"name":"a","mime":"application/x-msdownload","bytes":64}"#).unwrap();
        assert!(c.get(ID).is_none());
        // 檔頭不對的不收
        let bad = Downloaded { name: "a".into(), mime: "image/webp".into(), bytes: b"<html>..........".to_vec() };
        assert!(c.put(ID2, &bad, None).is_err());
        assert!(c.get(ID2).is_none());
    }

    #[test]
    fn 存超過保留天數就刪() {
        let t = tempfile::tempdir().unwrap();
        let keep = Duration::from_secs(100);
        let c = AttachCache::with_limits(t.path().to_path_buf(), CAP_BYTES, keep);
        let t0 = SystemTime::now() - Duration::from_secs(1000);
        c.put_at(ID, &img(64), t0).unwrap();
        // 中途讀過（更新最後使用時間）也不延長保留期限：以存進來的時間算
        assert!(c.get_at(ID, t0 + Duration::from_secs(50)).is_some());
        assert!(c.get_at(ID, t0 + Duration::from_secs(100)).is_none());
        assert!(files(t.path()).is_empty());
        // 清理時也會刪過期的
        c.put_at(ID, &img(64), t0).unwrap();
        c.put_at(ID2, &img(64), t0 + Duration::from_secs(200)).unwrap();
        assert_eq!(files(t.path()), vec![format!("{ID2}.bin"), format!("{ID2}.json")]);
    }

    #[test]
    fn 超過上限先刪最久沒用的() {
        let t = tempfile::tempdir().unwrap();
        let c = AttachCache::with_limits(t.path().to_path_buf(), 200, KEEP);
        let t0 = SystemTime::now() - Duration::from_secs(1000);
        c.put_at(ID, &img(80), t0).unwrap();
        c.put_at(ID2, &img(80), t0 + Duration::from_secs(10)).unwrap();
        // 第一張剛看過，變成最近用的
        assert!(c.get_at(ID, t0 + Duration::from_secs(20)).is_some());
        c.put_at(ID3, &img(80), t0 + Duration::from_secs(30)).unwrap();
        assert!(c.get_at(ID2, t0 + Duration::from_secs(40)).is_none(), "第二張最久沒用，被淘汰");
        assert!(c.get_at(ID, t0 + Duration::from_secs(40)).is_some());
        assert!(c.get_at(ID3, t0 + Duration::from_secs(40)).is_some());
        // 比上限還大的檔不存
        c.put_at(ID2, &img(300), t0 + Duration::from_secs(50)).unwrap();
        assert!(c.get_at(ID2, t0 + Duration::from_secs(60)).is_none());
    }

    #[test]
    fn 清理掉暫存檔與沒配對的說明檔() {
        let t = tempfile::tempdir().unwrap();
        let c = AttachCache::new(t.path().to_path_buf());
        let old = t.path().join(format!("{ID2}.bin.tmp"));
        std::fs::write(&old, b"x").unwrap();
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        let writing = t.path().join(format!("{ID3}.bin.tmp"));
        std::fs::write(&writing, b"x").unwrap();
        std::fs::write(t.path().join(format!("{ID3}.json")), b"{}").unwrap();
        std::fs::write(t.path().join("not-a-uuid.bin"), b"x").unwrap();
        c.put(ID, &img(64), None).unwrap();
        assert_eq!(files(t.path()), vec![format!("{ID}.bin"), format!("{ID}.json"), format!("{ID3}.bin.tmp")], "剛寫的暫存檔不刪");
    }

    #[test]
    fn 依節點分資料夾_登出清空全部() {
        let t = tempfile::tempdir().unwrap();
        let a = AttachCache::new(dir_for(t.path(), "n678feaac"));
        let b = AttachCache::new(dir_for(t.path(), "../../etc"));
        a.put(ID, &img(64), None).unwrap();
        b.put(ID, &img(64), None).unwrap();
        assert!(t.path().join(DIR_NAME).join("n678feaac").join(format!("{ID}.bin")).exists());
        assert!(t.path().join(DIR_NAME).join("etc").join(format!("{ID}.bin")).exists(), "節點名清掉路徑字元");
        assert_eq!(node_dir_name("///"), "default");
        clear_all(t.path()).unwrap();
        assert!(!t.path().join(DIR_NAME).exists());
        assert!(a.get(ID).is_none() && b.get(ID).is_none());
        clear_all(t.path()).unwrap();   // 沒有資料夾也不算錯
    }

    #[test]
    fn 只有_bin_沒有_json_當作沒有並清掉() {
        let t = tempfile::tempdir().unwrap();
        let c = AttachCache::new(t.path().to_path_buf());
        c.put(ID, &img(64), None).unwrap();
        std::fs::remove_file(t.path().join(format!("{ID}.json"))).unwrap();
        assert!(c.get(ID).is_none());
        assert!(files(t.path()).is_empty());
    }

    #[test]
    fn 附件到期時間_到了就當作沒有_只能縮短不能比30天長() {
        let t = tempfile::tempdir().unwrap();
        let c = AttachCache::new(t.path().to_path_buf());
        let now = SystemTime::now();
        let ms = now_ms(now);
        c.put_until(ID, &img(64), now, Some(ms + 1000)).unwrap();
        assert!(c.get_at(ID, now + Duration::from_millis(500)).is_some());
        assert!(c.get_at(ID, now + Duration::from_millis(1000)).is_none());
        // 畫面給一個很久以後的到期時間：仍然只存 30 天
        c.put_until(ID2, &img(64), now, Some(ms + 365 * 86_400_000)).unwrap();
        let info: Value = serde_json::from_slice(&std::fs::read(t.path().join(format!("{ID2}.json"))).unwrap()).unwrap();
        assert_eq!(info["until_ms"].as_u64(), Some(ms + KEEP.as_millis() as u64));
        // 已經過期的不存
        c.put_until(ID3, &img(64), now, Some(ms.saturating_sub(1))).unwrap();
        assert!(!t.path().join(format!("{ID3}.bin")).exists());
    }

    #[test]
    fn 帳號換了就整個清空_下載途中換帳號不寫回() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        let a = owner_key(Some("A@example.com"));
        assert_eq!(a, owner_key(Some(" a@example.com ")), "大小寫、空白不算不同帳號");
        assert!(!a.contains('@') && a.len() == 32, "不留 email 原文：{a}");
        assert!(ensure_owner(root, &a).unwrap(), "第一次：記下帳號");
        let ca = AttachCache::new(dir_for(root, "n1")).with_owner(root, &a);
        ca.put(ID, &img(64), None).unwrap();
        assert!(!ensure_owner(root, &a).unwrap(), "同一個帳號不清");
        assert!(ca.get(ID).is_some());
        // 換成 B（或登入過期變成沒登入）：整個清空
        let b = owner_key(Some("b@example.com"));
        assert!(ensure_owner(root, &b).unwrap());
        assert!(ca.get(ID).is_none());
        // A 那時開始的下載現在才回來：不寫回
        assert!(ca.put(ID2, &img(64), None).is_err());
        assert!(!dir_for(root, "n1").join(format!("{ID2}.bin")).exists());
        assert!(ensure_owner(root, &owner_key(None)).unwrap(), "登出也算換了");
    }

    #[test]
    fn 同一張同時寫和讀_不會互相蓋掉_讀到的一定是完整的() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().to_path_buf();
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let c = AttachCache::new(dir);
                    for _ in 0..30 {
                        if i % 2 == 0 {
                            c.put(ID, &img(4096), None).unwrap();
                        } else if let Some(d) = c.get(ID) {
                            assert_eq!(d.bytes, webp(4096));
                        }
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        assert_eq!(files(t.path()), vec![format!("{ID}.bin"), format!("{ID}.json")], "沒有留下暫存檔");
        assert!(AttachCache::new(dir).get(ID).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn unix_資料夾0700_檔案0600() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let d = dir_for(t.path(), "n1");
        AttachCache::new(d.clone()).put(ID, &img(64), None).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&d), 0o700);
        assert_eq!(mode(d.parent().unwrap()), 0o700);
        assert_eq!(mode(&d.join(format!("{ID}.bin"))), 0o600);
        assert_eq!(mode(&d.join(format!("{ID}.json"))), 0o600);
    }

    #[cfg(windows)]
    #[test]
    fn 連結不跟著走_讀不到連結指的檔_清理只拿掉連結() {
        let t = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("secret.webp");
        std::fs::write(&target, webp(64)).unwrap();
        let c = AttachCache::new(t.path().to_path_buf());
        c.put(ID2, &img(64), None).unwrap();
        // 沒有建立連結的權限（一般使用者、沒開開發人員模式）就跳過
        if std::os::windows::fs::symlink_file(&target, t.path().join(format!("{ID}.bin"))).is_err() {
            return;
        }
        std::fs::write(t.path().join(format!("{ID}.json")), br#"{"name":"a","mime":"image/webp","bytes":64}"#).unwrap();
        assert!(c.get(ID).is_none(), "連結不算快取");
        assert!(target.exists(), "連結指的檔不能被刪");
        assert!(!t.path().join(format!("{ID}.bin")).exists());
    }
}
