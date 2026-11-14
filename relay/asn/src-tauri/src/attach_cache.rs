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

pub struct AttachCache {
    dir: PathBuf,
    cap: u64,
    keep: Duration,
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

/// 整個附件快取清空（所有節點）。登出、登入時呼叫；資料夾不存在不算錯
pub fn clear_all(root: &Path) -> Result<(), String> {
    let d = root.join(DIR_NAME);
    match std::fs::remove_dir_all(&d) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清不掉附件快取：{e}")),
    }
}

impl AttachCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, cap: CAP_BYTES, keep: KEEP }
    }

    #[cfg(test)]
    fn with_limits(dir: PathBuf, cap: u64, keep: Duration) -> Self {
        Self { dir, cap, keep }
    }

    /// 編號 → 檔案路徑。編號不是 uuid 回 None（不拿外部字串組路徑）
    fn paths(&self, id: &str) -> Option<(PathBuf, PathBuf)> {
        if !is_uuid(id) {
            return None;
        }
        let id = id.to_ascii_lowercase();
        Some((self.dir.join(format!("{id}.bin")), self.dir.join(format!("{id}.json"))))
    }

    fn drop_entry(bin: &Path, meta: &Path) {
        let _ = std::fs::remove_file(bin);
        let _ = std::fs::remove_file(meta);
    }

    /// 讀快取：沒有、過期、或驗不過都回 None（驗不過的順手刪掉）。讀到就把最後使用時間更新成現在
    pub fn get(&self, id: &str) -> Option<Downloaded> {
        self.get_at(id, SystemTime::now())
    }

    fn get_at(&self, id: &str, now: SystemTime) -> Option<Downloaded> {
        let (bin, meta) = self.paths(id)?;
        let md = std::fs::metadata(&bin).ok()?;
        let stored = std::fs::metadata(&meta).and_then(|m| m.modified()).ok();
        // 存進來的時間看說明檔（讀的時候不更新它）；超過保留天數就丟
        if stored.is_none_or(|t| now.duration_since(t).unwrap_or_default() >= self.keep) {
            Self::drop_entry(&bin, &meta);
            return None;
        }
        let ok = (|| {
            let info: Value = serde_json::from_slice(&std::fs::read(&meta).ok()?).ok()?;
            let mime = info.get("mime")?.as_str()?.to_string();
            let size = info.get("bytes")?.as_u64()?;
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
    pub fn put(&self, id: &str, d: &Downloaded) -> Result<(), String> {
        self.put_at(id, d, SystemTime::now())
    }

    fn put_at(&self, id: &str, d: &Downloaded, now: SystemTime) -> Result<(), String> {
        let (bin, meta) = self.paths(id).ok_or("附件編號格式不對")?;
        if ext_of(&d.mime).is_none() || d.bytes.len() > limit_of(&d.mime) || !content_ok(&d.mime, &d.bytes) {
            return Err("檔案沒通過檢查，不存快取".into());
        }
        if d.bytes.len() as u64 > self.cap {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("建不了快取資料夾：{e}"))?;
        let tmp_bin = bin.with_extension("bin.tmp");
        let tmp_meta = meta.with_extension("json.tmp");
        let info = json!({ "name": d.name, "mime": d.mime, "bytes": d.bytes.len() });
        let write = || -> std::io::Result<()> {
            std::fs::write(&tmp_bin, &d.bytes)?;
            std::fs::write(&tmp_meta, serde_json::to_vec(&info).unwrap_or_default())?;
            std::fs::rename(&tmp_bin, &bin)?;
            std::fs::rename(&tmp_meta, &meta)?;
            for p in [&bin, &meta] {
                std::fs::File::options().write(true).open(p)?.set_modified(now)?;
            }
            Ok(())
        };
        if let Err(e) = write() {
            for p in [&tmp_bin, &tmp_meta, &bin, &meta] {
                let _ = std::fs::remove_file(p);
            }
            return Err(format!("寫不進快取：{e}"));
        }
        self.prune_at(now);
        Ok(())
    }

    /// 清理：刪過期的、沒配對的、暫存檔；總量超過上限時，從最久沒用的開始刪
    fn prune_at(&self, now: SystemTime) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let mut live: Vec<(SystemTime, u64, PathBuf, PathBuf)> = vec![];
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if let Some(id) = name.strip_suffix(".bin") {
                let meta = self.dir.join(format!("{id}.json"));
                let stored = std::fs::metadata(&meta).and_then(|m| m.modified()).ok();
                let fresh = stored.is_some_and(|t| now.duration_since(t).unwrap_or_default() < self.keep);
                match (is_uuid(id), fresh, e.metadata()) {
                    (true, true, Ok(m)) => live.push((m.modified().unwrap_or(now), m.len(), p, meta)),
                    _ => Self::drop_entry(&p, &meta),
                }
            } else if let Some(id) = name.strip_suffix(".json") {
                if !self.dir.join(format!("{id}.bin")).exists() {
                    let _ = std::fs::remove_file(&p);
                }
            } else {
                // 暫存檔或不認得的檔：這個資料夾只有快取自己寫的東西。暫存檔放一陣子才刪，不搶別的正在寫的
                let age = e.metadata().and_then(|m| m.modified()).map(|t| now.duration_since(t).unwrap_or_default()).unwrap_or(TMP_GRACE);
                if !name.ends_with(".tmp") || age >= TMP_GRACE {
                    let _ = std::fs::remove_file(&p);
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
pub async fn fetch(cache: Option<&AttachCache>, relay: &Relay, http: &reqwest::Client, id: &str) -> Result<Downloaded, String> {
    if let Some(d) = cache.and_then(|c| c.get(id)) {
        return Ok(d);
    }
    let d = download(relay, http, id).await?;
    if let Some(c) = cache {
        let _ = c.put(id, &d);
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
        c.put(&ID.to_uppercase(), &d).unwrap();
        assert_eq!(files(&t.path().join("n1")), vec![format!("{ID}.bin"), format!("{ID}.json")]);
        let got = c.get(ID).unwrap();
        assert_eq!((got.mime.as_str(), got.bytes), ("image/webp", webp(64)));
        assert!(!got.name.contains('/') && !got.name.contains('\u{202e}'), "{}", got.name);
        // 編號不是 uuid：不讀不寫
        assert!(c.put("../x", &img(64)).is_err());
        assert!(c.get("../x").is_none());
    }

    #[test]
    fn 讀出來再驗一次_被改過或大小不符就丟掉() {
        let t = tempfile::tempdir().unwrap();
        let c = AttachCache::new(t.path().to_path_buf());
        let bin = t.path().join(format!("{ID}.bin"));
        // 內容被換成別的東西（大小一樣）
        c.put(ID, &img(64)).unwrap();
        let mut b = std::fs::read(&bin).unwrap();
        b[..4].copy_from_slice(b"<htm");
        std::fs::write(&bin, b).unwrap();
        assert!(c.get(ID).is_none());
        assert!(!bin.exists(), "驗不過的要刪掉");
        // 被截斷
        c.put(ID, &img(64)).unwrap();
        std::fs::write(&bin, &webp(64)[..40]).unwrap();
        assert!(c.get(ID).is_none());
        // 說明檔的型別被改成不認得的
        c.put(ID, &img(64)).unwrap();
        std::fs::write(t.path().join(format!("{ID}.json")), br#"{"name":"a","mime":"application/x-msdownload","bytes":64}"#).unwrap();
        assert!(c.get(ID).is_none());
        // 檔頭不對的不收
        let bad = Downloaded { name: "a".into(), mime: "image/webp".into(), bytes: b"<html>..........".to_vec() };
        assert!(c.put(ID2, &bad).is_err());
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
        c.put(ID, &img(64)).unwrap();
        assert_eq!(files(t.path()), vec![format!("{ID}.bin"), format!("{ID}.json"), format!("{ID3}.bin.tmp")], "剛寫的暫存檔不刪");
    }

    #[test]
    fn 依節點分資料夾_登出清空全部() {
        let t = tempfile::tempdir().unwrap();
        let a = AttachCache::new(dir_for(t.path(), "n678feaac"));
        let b = AttachCache::new(dir_for(t.path(), "../../etc"));
        a.put(ID, &img(64)).unwrap();
        b.put(ID, &img(64)).unwrap();
        assert!(t.path().join(DIR_NAME).join("n678feaac").join(format!("{ID}.bin")).exists());
        assert!(t.path().join(DIR_NAME).join("etc").join(format!("{ID}.bin")).exists(), "節點名清掉路徑字元");
        assert_eq!(node_dir_name("///"), "default");
        clear_all(t.path()).unwrap();
        assert!(!t.path().join(DIR_NAME).exists());
        assert!(a.get(ID).is_none() && b.get(ID).is_none());
        clear_all(t.path()).unwrap();   // 沒有資料夾也不算錯
    }
}
