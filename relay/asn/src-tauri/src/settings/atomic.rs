//! 統一的原子寫入：寫到序號 tmp、依類別 fsync、rename 覆蓋；Windows 上 rename 被占用時重試。
//! 絕不先刪目標檔；任何一步失敗都清掉 tmp 並回傳原始錯誤。
//! 不改檔名、位置、格式，只改「怎麼寫進去」，所以舊版寫的檔新版讀得到、新版寫的檔舊版也讀得到。

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug)]
pub struct Opts {
    pub fsync: bool,
    pub private: bool,
    pub create_dirs: bool,
}

/// 設定類：斷電後要還在
pub const SETTINGS: Opts = Opts { fsync: true, private: false, create_dirs: true };
/// 裝著還沒送達信件的佇列、pending：斷電後要還在
#[allow(dead_code)]
pub const QUEUE: Opts = Opts { fsync: true, private: false, create_dirs: true };
/// 快取與純狀態：掉了可以重建，不付 fsync 的錢
pub const STATE: Opts = Opts { fsync: false, private: false, create_dirs: true };

static SEQ: AtomicU64 = AtomicU64::new(0);
const RENAME_TRIES: u32 = 5;
const RENAME_WAIT_MS: u64 = 200;

/// `<檔>.<pid>.<行程內遞增序號>.tmp`，與目標同資料夾
pub(crate) fn tmp_path(path: &Path) -> PathBuf {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!("{}.{}.{}.tmp", path.display(), std::process::id(), seq))
}

fn write_tmp(tmp: &Path, bytes: &[u8], o: Opts) -> io::Result<()> {
    let mut oo = std::fs::OpenOptions::new();
    oo.write(true).create_new(true);
    #[cfg(unix)]
    if o.private {
        use std::os::unix::fs::OpenOptionsExt;
        oo.mode(0o600);
    }
    let mut f = oo.open(tmp)?;
    f.write_all(bytes)?;
    if o.fsync {
        f.sync_all()?;
    }
    Ok(())
}

fn rename_retry(tmp: &Path, path: &Path) -> io::Result<()> {
    let mut n = 0;
    loop {
        match std::fs::rename(tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                n += 1;
                let retry = cfg!(windows)
                    && n < RENAME_TRIES
                    && matches!(e.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::Other);
                if !retry {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(RENAME_WAIT_MS));
            }
        }
    }
}

pub fn write(path: &Path, bytes: &[u8], o: Opts) -> io::Result<()> {
    if o.create_dirs {
        if let Some(p) = path.parent() {
            if !p.as_os_str().is_empty() {
                std::fs::create_dir_all(p)?;
            }
        }
    }
    let tmp = tmp_path(path);
    let r = write_tmp(&tmp, bytes, o).and_then(|()| rename_retry(&tmp, path));
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    #[cfg(not(windows))]
    if o.fsync {
        if let Some(p) = path.parent() {
            let p = if p.as_os_str().is_empty() { Path::new(".") } else { p };
            if let Ok(d) = std::fs::File::open(p) {
                let _ = d.sync_all();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmps(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn 一般寫入內容正確不留tmp() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a").join("x.json");
        write(&p, b"{\"a\":1}", SETTINGS).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"a\":1}");
        write(&p, b"{\"a\":2}", STATE).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"a\":2}");
        assert!(tmps(p.parent().unwrap()).is_empty());
    }

    #[test]
    fn tmp檔名每次不同() {
        let p = Path::new("x.json");
        assert_ne!(tmp_path(p), tmp_path(p));
    }

    #[test]
    fn 兩執行緒同寫一檔結果是完整其中一份不留tmp() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.json");
        let a = "A".repeat(300_000);
        let b = "B".repeat(300_000);
        for _ in 0..20 {
            let (p1, a1) = (p.clone(), a.clone());
            let (p2, b2) = (p.clone(), b.clone());
            let t1 = std::thread::spawn(move || {
                (0..10).for_each(|_| {
                    let _ = write(&p1, a1.as_bytes(), STATE);
                })
            });
            let t2 = std::thread::spawn(move || {
                (0..10).for_each(|_| {
                    let _ = write(&p2, b2.as_bytes(), STATE);
                })
            });
            t1.join().unwrap();
            t2.join().unwrap();
            let s = std::fs::read_to_string(&p).unwrap();
            assert!(s == a || s == b, "內容不是完整的其中一份");
        }
        assert!(tmps(d.path()).is_empty());
    }

    #[test]
    fn rename失敗清tmp且目標不變() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("target");
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("keep.txt"), "舊").unwrap();
        let r = write(&p, b"new", SETTINGS);
        assert!(r.is_err());
        assert!(tmps(d.path()).is_empty(), "失敗後 tmp 要清掉");
        assert_eq!(std::fs::read_to_string(p.join("keep.txt")).unwrap(), "舊");
    }

    // 舊版 H1 寫法：直接寫 tmp 再 rename
    fn h1_old(path: &Path, text: &str) {
        let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
        std::fs::write(&tmp, text).unwrap();
        std::fs::rename(&tmp, path).unwrap();
    }

    #[test]
    fn 升降級舊寫法的檔新寫法讀寫正常且新檔可被一般方式讀() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("asn-me.json");
        h1_old(&p, r#"{"name":"舊","n":1}"#);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["name"], "舊");
        write(&p, r#"{"name":"新","n":2}"#.as_bytes(), SETTINGS).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["name"], "新");
        h1_old(&p, r#"{"name":"又舊"}"#);
        assert!(std::fs::read_to_string(&p).unwrap().contains("又舊"));
        assert!(tmps(d.path()).is_empty());
    }

    #[test]
    #[ignore]
    fn 基準_fsync與不fsync() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("bench.json");
        for (label, size) in [("6MB", 6_000_000usize), ("2KB", 2048)] {
            let buf = vec![b'x'; size];
            for (name, o) in [("fsync", SETTINGS), ("不fsync", STATE)] {
                let t = std::time::Instant::now();
                for _ in 0..50 {
                    write(&p, &buf, o).unwrap();
                }
                let el = t.elapsed();
                println!(
                    "BENCH {label} {name} 50次共 {:.0} ms，平均 {:.2} ms",
                    el.as_secs_f64() * 1000.0,
                    el.as_secs_f64() * 20.0
                );
            }
        }
    }
}
