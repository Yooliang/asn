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
pub const QUEUE: Opts = Opts { fsync: true, private: false, create_dirs: true };
/// 快取與純狀態：掉了可以重建，不付 fsync 的錢
pub const STATE: Opts = Opts { fsync: false, private: false, create_dirs: true };

static SEQ: AtomicU64 = AtomicU64::new(0);
const RENAME_TRIES: u32 = 5;
const RENAME_WAIT_MS: u64 = 200;
const TMP_TRIES: u32 = 8;

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
    // 開檔成功之後的失敗，要清掉自己建的 tmp（開檔失敗時那個檔不是我們的，不能動）
    let r = f.write_all(bytes).and_then(|()| if o.fsync { f.sync_all() } else { Ok(()) });
    if r.is_err() {
        drop(f);
        let _ = std::fs::remove_file(tmp);
    }
    r
}

/// Windows 上目標檔被別的程式開著時，rename 會回 ERROR_ACCESS_DENIED(5)、ERROR_SHARING_VIOLATION(32)、
/// ERROR_LOCK_VIOLATION(33)；這三個是「等一下可能就好」。其他錯誤（含 ErrorKind::Other）重試也不會好，直接回傳，
/// 不白等。目標是資料夾時 Windows 也回 5，但等多久都不會好，所以先排除。
fn transient_rename_error(e: &io::Error, path: &Path) -> bool {
    cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)) && !path.is_dir()
}

fn rename_retry(tmp: &Path, path: &Path) -> io::Result<()> {
    let mut n = 0;
    loop {
        match std::fs::rename(tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                n += 1;
                if n >= RENAME_TRIES || !transient_rename_error(&e, path) {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(RENAME_WAIT_MS));
            }
        }
    }
}

/// 建 tmp：遇到殘留的同名檔（pid 重用、序號剛好相同）就換下一個名字，最多 8 次；不動殘留檔
fn create_tmp(path: &Path, bytes: &[u8], o: Opts, next: &mut dyn FnMut(&Path) -> PathBuf) -> io::Result<PathBuf> {
    let mut n = 0;
    loop {
        let tmp = next(path);
        match write_tmp(&tmp, bytes, o) {
            Ok(()) => return Ok(tmp),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && n + 1 < TMP_TRIES => n += 1,
            Err(e) => return Err(e),
        }
    }
}

pub fn write(path: &Path, bytes: &[u8], o: Opts) -> io::Result<()> {
    write_with(path, bytes, o, &mut tmp_path)
}

fn write_with(path: &Path, bytes: &[u8], o: Opts, next: &mut dyn FnMut(&Path) -> PathBuf) -> io::Result<()> {
    if o.create_dirs {
        if let Some(p) = path.parent() {
            if !p.as_os_str().is_empty() {
                std::fs::create_dir_all(p)?;
            }
        }
    }
    let tmp = create_tmp(path, bytes, o, next)?;
    if let Err(e) = rename_retry(&tmp, path) {
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

    #[test]
    fn 殘留同名tmp時換名重試成功且不動殘留檔() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.json");
        let stale = PathBuf::from(format!("{}.stale.tmp", p.display()));
        std::fs::write(&stale, "殘留").unwrap();
        let mut calls = 0;
        let (s2, p2) = (stale.clone(), PathBuf::from(format!("{}.real.tmp", p.display())));
        let mut next = move |_: &Path| {
            calls += 1;
            if calls <= 2 { s2.clone() } else { p2.clone() }
        };
        write_with(&p, b"new", SETTINGS, &mut next).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&stale).unwrap(), "殘留");
    }

    #[test]
    fn 一直撞名超過8次回原錯誤且不動殘留檔() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.json");
        let stale = PathBuf::from(format!("{}.stale.tmp", p.display()));
        std::fs::write(&stale, "殘留").unwrap();
        let s2 = stale.clone();
        let e = write_with(&p, b"new", SETTINGS, &mut |_: &Path| s2.clone()).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&stale).unwrap(), "殘留");
        assert!(!p.exists());
    }

    #[test]
    fn rename目標是資料夾時不白等() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("target");
        std::fs::create_dir(&p).unwrap();
        let t = std::time::Instant::now();
        assert!(write(&p, b"x", SETTINGS).is_err());
        // 放寬給慢的 CI 機器；重點是確認沒跑滿 5×200 毫秒（約 1 秒）的重試
        assert!(t.elapsed() < std::time::Duration::from_millis(600), "不該重試睡覺");
    }

    // 分類釘住（#2162）：這幾處的資料斷電後要還在，不准退回不 fsync 的 STATE。用原始碼掃描，
    // 每處以「呼叫的開頭」當錨點，檢查同一行用的是哪個 Opts。
    #[test]
    fn 佇列與設定的寫入點用的是會fsync的類別() {
        let sites: [(&str, &str, &str, &str); 8] = [
            ("acct_remote.rs outbox", include_str!("../acct_remote.rs"), "atomic::write(&outbox_path(", "QUEUE"),
            ("acct_remote.rs set_pref", include_str!("../acct_remote.rs"), "atomic::write(&prefs_path(", "SETTINGS"),
            ("bridge/mod.rs write_settings", include_str!("../bridge/mod.rs"), "atomic::write(&settings_path(", "SETTINGS"),
            ("agent_setup/switch.rs", include_str!("../agent_setup/switch.rs"), "atomic::write(&prefs_path(", "SETTINGS"),
            ("account.rs login_skipped", include_str!("../account.rs"), "atomic::write(&f, b\"1\"", "SETTINGS"),
            ("account.rs device_id", include_str!("../account.rs"), "atomic::write(&f, id.as_bytes()", "SETTINGS"),
            ("bridge/engines/partner_queue.rs 名冊", include_str!("../bridge/engines/partner_queue.rs"), "atomic::write(file, json!(", "SETTINGS"),
            ("bridge/pending.rs save_atomic", include_str!("../bridge/pending.rs"), "atomic::write(file,", "QUEUE"),
        ];
        for (name, src, anchor, want) in sites {
            let i = src.find(anchor).unwrap_or_else(|| panic!("{name}：找不到寫入呼叫（{anchor}）"));
            let line = src[i..].lines().next().unwrap();
            assert!(line.contains(&format!("atomic::{want}")), "{name}：要用 {want}，實際：{line}");
            assert!(!line.contains("atomic::STATE"), "{name}：不准用 STATE");
        }
        // 這幾處不准再有舊的 STATE 包裝呼叫（同檔其他處留給 2b，所以只查這幾處的檔案路徑）
        for (src, bad) in [
            (include_str!("../acct_remote.rs"), "crate::write_atomic(&outbox_path("),
            (include_str!("../acct_remote.rs"), "crate::write_atomic(&prefs_path("),
            (include_str!("../agent_setup/switch.rs"), "crate::write_atomic("),
            (include_str!("../account.rs"), "crate::write_atomic("),
            (include_str!("../bridge/mod.rs"), "crate::write_atomic(&settings_path("),
            (include_str!("../bridge/engines/partner_queue.rs"), "crate::write_atomic(file, &json!("),
        ] {
            assert!(!src.contains(bad), "還有走 {bad}（STATE）的呼叫");
        }
        // 帳號憑證 helper：claude_json 設定類；claude_extra 要 fsync 且私有
        assert!(include_str!("../claude_json.rs").contains("atomic::SETTINGS"));
        assert!(include_str!("../claude_extra.rs").contains("fsync: true, private: true"));
        assert!(include_str!("../cli/send_rate.rs").contains("atomic::STATE"));
    }

    // Windows 鎖定重試（#2162 2b）：另一個執行緒以「完全不共用」的方式開著目標檔，約 300 毫秒後放掉；
    // 統一寫入的 rename 會先被擋（共用違規），重試後成功，內容正確、不留 tmp。
    // 把 RENAME_TRIES 暫時改成 1，這支會紅（第一次被擋就直接回錯）。
    #[cfg(windows)]
    #[test]
    fn windows目標檔被獨占開著時重試後成功() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.json");
        std::fs::write(&p, "舊").unwrap();
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
        // 前提：占住期間直接改名一定失敗（否則這支測試什麼都沒驗到）
        let probe = d.path().join("probe.tmp");
        std::fs::write(&probe, "x").unwrap();
        assert!(std::fs::rename(&probe, &p).is_err(), "占住時改名應該失敗");
        std::fs::remove_file(&probe).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            drop(held);
        });
        let t = std::time::Instant::now();
        write(&p, "新".as_bytes(), SETTINGS).unwrap();
        let waited = t.elapsed();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "新");
        assert!(waited >= std::time::Duration::from_millis(150), "確實等過才寫成功：{waited:?}");
        assert!(tmps(d.path()).is_empty(), "不留 tmp");
    }

    // 分類釘住（#2162 2b）：內嵌的「寫 tmp 再 rename」與非原子的 fs::write 都收進統一寫入後，每一處的 Opts。
    // (名稱, 原始碼, 呼叫開頭, 要用的類別, 這個開頭預期出現幾次)；同一個開頭的每一次出現都要用對類別。
    #[test]
    fn 內嵌寫入改走統一寫入後每處的類別() {
        let sites: [(&str, &str, &str, &str, usize); 25] = [
            ("partner_queue 名冊 forget／rename", include_str!("../bridge/engines/partner_queue.rs"), "atomic::write(file, v.to_string()", "SETTINGS", 2),
            ("upstream_retry 補送名單", include_str!("../bridge/core/upstream_retry.rs"), "atomic::write(&file, t.as_bytes()", "QUEUE", 1),
            ("pi.rs 收件匣", include_str!("../bridge/engines/pi.rs"), "atomic::write(&target, body.as_bytes()", "QUEUE", 1),
            ("grok_accounts write_bytes", include_str!("../grok_accounts.rs"), "atomic::write(path, bytes", "SETTINGS", 1),
            ("quota_readers save_settings", include_str!("../quota_readers.rs"), "atomic::write(&path, text.as_bytes()", "SETTINGS", 1),
            ("pi_setup 安裝記錄", include_str!("../launch/pi_setup.rs"), "atomic::write(&self.marker", "SETTINGS", 1),
            ("lastlogin", include_str!("../lastlogin.rs"), "atomic::write(&dir.join(FILE)", "STATE", 1),
            ("heartbeat", include_str!("../heartbeat.rs"), "atomic::write(&file, body.as_bytes()", "STATE", 1),
            ("cli/room.rs room-seen", include_str!("../cli/room.rs"), "atomic::write(&f, serde_json", "STATE", 1),
            ("invite_link 信箱檔", include_str!("../invite_link.rs"), "atomic::write(&dir.join(INBOX_FILE)", "STATE", 1),
            ("mux_round 接回通知", include_str!("../launch/mux_round.rs"), "atomic::write(&work_dir.join(RESUME_NOTICE_FILE)", "STATE", 1),
            ("mux_watch 看不到通知", include_str!("../launch/mux_watch.rs"), "atomic::write(&work_dir.join(BLIND_FILE)", "STATE", 1),
            ("mux_watch 服務停通知", include_str!("../launch/mux_watch.rs"), "atomic::write(&work_dir.join(NOTICE_FILE)", "STATE", 1),
            ("wezterm_fetch 退避紀錄", include_str!("../launch/wezterm_fetch.rs"), "atomic::write(&root.join(STATE_FILE)", "STATE", 1),
            ("pi_control 控制請求", include_str!("../bridge/engines/pi_control.rs"), "atomic::write(&target, v.to_string()", "STATE", 1),
            ("term.rs 畫面判斷", include_str!("../launch/term.rs"), "atomic::write(&path, body.as_bytes()", "STATE", 1),
            ("claude_extra stops", include_str!("../claude_extra.rs"), "atomic::write(&stops_path(home)", "STATE", 1),
            ("launcher launch-history", include_str!("../bridge/launcher.rs"), "atomic::write(&self.history_file()", "STATE", 1),
            ("orphans bridge.last", include_str!("../bridge/orphans.rs"), "atomic::write(&last_file(work_dir)", "STATE", 1),
            ("channel_turns 記號", include_str!("../bridge/channel_turns.rs"), "atomic::write(&p, b\"1\"", "STATE", 1),
            ("auth_notice 日誌截半", include_str!("../auth_notice.rs"), "atomic::write(&p, keep.as_bytes()", "STATE", 1),
            ("acct_remote 日誌截半", include_str!("../acct_remote.rs"), "atomic::write(&p, keep.as_bytes()", "STATE", 1),
            // 2a 已改、這張順手把「名冊與補送」以外的同檔舊呼叫也釘住
            ("partner_queue 名冊 remember", include_str!("../bridge/engines/partner_queue.rs"), "atomic::write(file, json!(", "SETTINGS", 1),
            ("bridge/pending.rs", include_str!("../bridge/pending.rs"), "atomic::write(file,", "QUEUE", 1),
            ("acct_remote outbox", include_str!("../acct_remote.rs"), "atomic::write(&outbox_path(", "QUEUE", 1),
        ];
        for (name, src, anchor, want, times) in sites {
            let hits: Vec<_> = src.match_indices(anchor).map(|(i, _)| i).collect();
            assert_eq!(hits.len(), times, "{name}：寫入呼叫（{anchor}）出現 {} 次，預期 {times} 次", hits.len());
            for i in hits {
                let line = src[i..].lines().next().unwrap();
                assert!(line.contains(&format!("atomic::{want}")), "{name}：要用 {want}，實際：{line}");
            }
        }
        // 這些檔案的正式程式（測試區之前）不准再有自己拼暫存檔的寫法或非原子的 fs::write（其他已經走 write_atomic 的舊呼叫不在這張範圍）
        for (name, src) in [
            ("partner_queue", include_str!("../bridge/engines/partner_queue.rs")),
            ("upstream_retry", include_str!("../bridge/core/upstream_retry.rs")),
            ("pi.rs", include_str!("../bridge/engines/pi.rs")),
            ("pi_control", include_str!("../bridge/engines/pi_control.rs")),
            ("grok_accounts", include_str!("../grok_accounts.rs")),
            ("quota_readers", include_str!("../quota_readers.rs")),
            ("lastlogin", include_str!("../lastlogin.rs")),
            ("heartbeat", include_str!("../heartbeat.rs")),
            ("cli/room.rs", include_str!("../cli/room.rs")),
            ("invite_link", include_str!("../invite_link.rs")),
            ("mux_round", include_str!("../launch/mux_round.rs")),
            ("mux_watch", include_str!("../launch/mux_watch.rs")),
            ("wezterm_fetch", include_str!("../launch/wezterm_fetch.rs")),
            ("pi_setup", include_str!("../launch/pi_setup.rs")),
            ("claude_extra", include_str!("../claude_extra.rs")),
            ("launcher", include_str!("../bridge/launcher.rs")),
            ("orphans", include_str!("../bridge/orphans.rs")),
            ("channel_turns", include_str!("../bridge/channel_turns.rs")),
            ("auth_notice", include_str!("../auth_notice.rs")),
        ] {
            let prod = src.split("#[cfg(test)]").next().unwrap();
            for bad in ["std::fs::write(", "fs::write(", ".tmp\""] {
                assert!(!prod.contains(bad), "{name}：還有 {bad}");
            }
            // 名冊檔的另一處（FAIL_FILE 失敗紀錄，純狀態）本來就走 crate::write_atomic（STATE），不在這張改；名冊本身不准再走它
            if name == "partner_queue" {
                assert_eq!(prod.matches("crate::write_atomic(").count(), 1, "{name}：只剩失敗紀錄那一處走 STATE 包裝");
            }
        }
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
