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
/// 帳號 auth 這類設定：同設定類（fsync），另外只有本人可讀（Unix 0600；Windows 沿用資料夾權限）
pub const SECRET_SETTINGS: Opts = Opts { fsync: true, private: true, create_dirs: true };
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

/// 殘留暫存檔的保險期：修改時間比這個新的一律不碰（別的 ASN 行程可能正在寫）
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// 嚴格比對 `<任意>.<純數字 pid>.<純數字序號>.tmp`，回傳 pid；不符一律 None
fn stale_pid(name: &str) -> Option<u32> {
    let rest = name.strip_suffix(".tmp")?;
    let (rest, seq) = rest.rsplit_once('.')?;
    let (base, pid) = rest.rsplit_once('.')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if base.is_empty() || !digits(seq) || !digits(pid) {
        return None;
    }
    pid.parse().ok()
}

/// 清掉崩潰或斷電後殘留的暫存檔：只掃傳入資料夾那一層；只刪一般檔案、格式嚴格相符、pid 不是自己、
/// 且修改時間早於 10 分鐘的。不查 pid 是否還活著（pid 會重用、Windows 上也不可靠），
/// 靠 10 分鐘保險避免刪到另一個 ASN 行程（asn-cli、asn-bridge）正在寫的檔。回傳刪掉幾個；失敗跳過。
pub fn sweep_stale(dirs: &[&Path], my_pid: u32) -> usize {
    let (n, hit) = sweep_stale_at(dirs, my_pid, std::time::SystemTime::now());
    if let Some(line) = sweep_summary(n, &hit) {
        elog!("{line}");
    }
    n
}

/// 開執行緒在背景掃，不拖慢啟動、不佔 UI 執行緒
pub fn sweep_stale_in_background(dirs: Vec<PathBuf>) {
    let _ = std::thread::Builder::new().name("sweep-stale-tmp".into()).spawn(move || {
        let refs: Vec<&Path> = dirs.iter().map(|p| p.as_path()).collect();
        sweep_stale(&refs, std::process::id());
    });
}

fn sweep_stale_at(dirs: &[&Path], my_pid: u32, now: std::time::SystemTime) -> (usize, Vec<PathBuf>) {
    let mut total = 0;
    let mut hit = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        let mut n = 0;
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(pid) = name.to_str().and_then(stale_pid) else { continue };
            if pid == my_pid {
                continue;
            }
            let path = e.path();
            let Ok(md) = std::fs::symlink_metadata(&path) else { continue };
            if !md.file_type().is_file() {
                continue;
            }
            let old = md.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|d| d >= STALE_AFTER);
            if old && std::fs::remove_file(&path).is_ok() {
                n += 1;
            }
        }
        if n > 0 {
            total += n;
            hit.push(dir.to_path_buf());
        }
    }
    (total, hit)
}

fn sweep_summary(n: usize, dirs: &[PathBuf]) -> Option<String> {
    if n == 0 {
        return None;
    }
    let list: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
    Some(format!("[ASN] 清掉崩潰後殘留的原子寫入暫存檔 {n} 個（資料夾：{}）", list.join("、")))
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
        let sites: [(&str, &str, &str, &str); 5] = [
            ("acct_remote.rs outbox", include_str!("../acct_remote.rs"), "atomic::write(&outbox_path(", "QUEUE"),
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
        // 共用層 write_locked 的類別由型別宣告：預設是 SETTINGS（視窗名稱、帳號偏好、…都從這裡寫），只有對話快取（asn-chats）改成 STATE
        let m = include_str!("mod.rs");
        assert!(m.contains("const ATOMIC: atomic::Opts = atomic::SETTINGS;"), "Doc 的預設寫入類別要是 SETTINGS");
        assert_eq!(m.matches("atomic::write(path, text.as_bytes(), T::ATOMIC)").count(), 2, "write_locked 要用型別宣告的類別");
        let r = include_str!("raw.rs");
        assert_eq!(r.matches("atomic::STATE").count(), 1, "只有 asn-chats（快取）可以用 STATE");
        assert!(r.contains(r#"ChatsDoc, "asn-chats", 0, true, atomic::STATE, false"#));
        assert!(r.contains(r#"MeDoc, "asn-me", 1, true, atomic::SETTINGS, true"#) && r.contains(r#"OnboardDoc, "asn-onboard", 1, true, atomic::SETTINGS, true"#));
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

    // Windows 鎖定重試（#2162 2b）：另一個執行緒以「完全不共用」的方式開著目標檔，約 300 毫秒後放掉（重試最多睡 4×200＝800 毫秒，留約 500 毫秒餘裕；原本占 500 只剩約 300，慢 CI 會偶爾紅。選縮短占住時間而不加重試次數，因為正式程式的重試不該為了測試變長）；
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
        write(&p, "新".as_bytes(), SETTINGS).unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "新");
        assert!(tmps(d.path()).is_empty(), "不留 tmp");
    }

    // 分類釘住（#2162 2b）：內嵌的「寫 tmp 再 rename」與非原子的 fs::write 都收進統一寫入後，每一處的 Opts。
    // (名稱, 原始碼, 呼叫開頭, 要用的類別, 這個開頭預期出現幾次)；同一個開頭的每一次出現都要用對類別。
    // #2162 ⑤：bridge.json、launch-prefs.json 的寫入只准經共用層（持鎖、搬壞檔、版本、fsync）；這三個檔的正式碼不准自己寫檔
    #[test]
    fn 收發室設定與啟動偏好的正式碼不准自己寫檔() {
        for (name, src) in [
            ("bridge/mod.rs", include_str!("../bridge/mod.rs")),
            ("launch/prefs.rs", include_str!("../launch/prefs.rs")),
            ("launch/cwds.rs", include_str!("../launch/cwds.rs")),
        ] {
            let prod = &crate::settings::src_scan::prod_source(src);
            assert!(prod.len() > 1000, "{name}：切點切錯了，正式碼只剩 {} 位元組", prod.len());
            for bad in ["fs::write", "write_atomic", "atomic::write", "File::create", "OpenOptions"] {
                assert!(!prod.contains(bad), "{name}：正式碼不准出現 {bad}（寫檔一律走 settings 的 update_in／try_update_in）");
            }
        }
        // 切點確實會切掉測試區：cwds.rs 的測試區有 fs::write，掃描不該看到
        assert!(include_str!("../launch/cwds.rs").contains("std::fs::write"));
    }

    #[test]
    fn 內嵌寫入改走統一寫入後每處的類別() {
        let sites: [(&str, &str, &str, &str, usize); 31] = [
            ("partner_queue 名冊 forget／rename", include_str!("../bridge/engines/partner_queue.rs"), "atomic::write(file, v.to_string()", "SETTINGS", 2),
            ("upstream_retry 補送名單", include_str!("../bridge/core/upstream_retry.rs"), "atomic::write(&file, t.as_bytes()", "QUEUE", 1),
            ("pi.rs 收件匣", include_str!("../bridge/engines/pi.rs"), "atomic::write(&target, body.as_bytes()", "QUEUE", 1),
            ("grok_accounts write_bytes（帳號 auth，只有本人可讀）", include_str!("../grok_accounts.rs"), "atomic::write(path, bytes", "SECRET_SETTINGS", 1),
            ("mux_watch 監看狀態", include_str!("../launch/mux_watch.rs"), "atomic::write(file, t.as_bytes()", "STATE", 1),
            ("account 節點代號檔", include_str!("../account.rs"), "atomic::write(&relay_home.join(\"node\")", "SETTINGS", 1),
            ("agy_install 版本記號", include_str!("../agent_setup/agy_install.rs"), "atomic::write(&tools.join(VERSION_FILE)", "STATE", 1),
            ("codex_install 目前版本檔", include_str!("../agent_setup/codex_install.rs"), "atomic::write(&tools.join(CURRENT_FILE)", "SETTINGS", 1),
            ("agent_setup/proc 登入子程序 pid", include_str!("../agent_setup/proc.rs"), "atomic::write(path, body.to_string()", "STATE", 1),
            ("engines/mod PidBook", include_str!("../bridge/engines/mod.rs"), "atomic::write(&self.file, body.as_bytes()", "STATE", 1),
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
            ("quota_core/merge 日誌截半", include_str!("../quota_core/merge.rs"), "atomic::write(p, keep.as_bytes()", "STATE", 1),
            // 2a 已改、這張順手把「名冊與補送」以外的同檔舊呼叫也釘住
            ("partner_queue 名冊 remember", include_str!("../bridge/engines/partner_queue.rs"), "atomic::write(file, json!(", "SETTINGS", 1),
            ("bridge/pending.rs", include_str!("../bridge/pending.rs"), "atomic::write(file,", "QUEUE", 1),
            ("acct_remote outbox", include_str!("../acct_remote.rs"), "atomic::write(&outbox_path(", "QUEUE", 1),
        ];
        for (name, src, anchor, want, times) in sites {
            let prod_src = crate::settings::src_scan::prod_source(src);
            let hits: Vec<_> = prod_src.match_indices(anchor).map(|(i, _)| i).collect();
            assert_eq!(hits.len(), times, "{name}：寫入呼叫（{anchor}）出現 {} 次，預期 {times} 次", hits.len());
            for i in hits {
                let line = prod_src[i..].lines().next().unwrap();
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
            ("acct_remote", include_str!("../acct_remote.rs")),
            ("account", include_str!("../account.rs")),
            ("agy_install", include_str!("../agent_setup/agy_install.rs")),
            ("codex_install", include_str!("../agent_setup/codex_install.rs")),
            ("agent_setup/proc", include_str!("../agent_setup/proc.rs")),
            ("engines/mod", include_str!("../bridge/engines/mod.rs")),
            ("quota_core/merge", include_str!("../quota_core/merge.rs")),
        ] {
            let prod = &crate::settings::src_scan::prod_source(src);
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

    // ---- sweep_stale（#2171）----
    use std::time::{Duration, SystemTime};

    fn later(m: u64) -> SystemTime {
        SystemTime::now() + Duration::from_secs(m * 60)
    }
    fn touch(d: &Path, name: &str) -> PathBuf {
        let p = d.join(name);
        std::fs::write(&p, b"x").unwrap();
        p
    }

    #[test]
    fn 舊的別人pid格式相符的被刪() {
        let d = tempfile::tempdir().unwrap();
        let a = touch(d.path(), "settings.json.4242.7.tmp");
        let b = touch(d.path(), "a.b.c.99.0.tmp");
        let (n, hit) = sweep_stale_at(&[d.path()], 1, later(11));
        assert_eq!(n, 2);
        assert!(!a.exists() && !b.exists());
        assert_eq!(hit, vec![d.path().to_path_buf()]);
    }

    #[test]
    fn 自己pid的不刪() {
        let d = tempfile::tempdir().unwrap();
        let a = touch(d.path(), "x.json.4242.7.tmp");
        assert_eq!(sweep_stale_at(&[d.path()], 4242, later(60)).0, 0);
        assert!(a.exists());
    }

    #[test]
    fn 十分鐘內的不刪() {
        let d = tempfile::tempdir().unwrap();
        let a = touch(d.path(), "x.json.4242.7.tmp");
        assert_eq!(sweep_stale_at(&[d.path()], 1, later(9)).0, 0);
        assert!(a.exists());
        assert_eq!(sweep_stale_at(&[d.path()], 1, later(11)).0, 1);
    }

    #[test]
    fn 格式不符的tmp不刪() {
        let d = tempfile::tempdir().unwrap();
        let names = ["a.tmp", "a.x.1.tmp", "a.1.x.tmp", ".1.2.tmp", "a.1..tmp", "a.1.2.tmp.bak", "a.1.2", "a.99999999999999999999.1.tmp", "a.-1.2.tmp"];
        let ps: Vec<PathBuf> = names.iter().map(|n| touch(d.path(), n)).collect();
        assert_eq!(sweep_stale_at(&[d.path()], 1, later(60)).0, 0);
        assert!(ps.iter().all(|p| p.exists()));
    }

    #[test]
    fn 同名資料夾不刪且不遞迴() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("x.1.2.tmp");
        std::fs::create_dir(&dir).unwrap();
        let inner = touch(&dir, "y.3.4.tmp");
        assert_eq!(sweep_stale_at(&[d.path()], 9, later(60)).0, 0);
        assert!(dir.is_dir() && inner.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink不跟隨() {
        let d = tempfile::tempdir().unwrap();
        let target = touch(d.path(), "real.txt");
        let link = d.path().join("x.1.2.tmp");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(sweep_stale_at(&[d.path()], 9, later(60)).0, 0);
        assert!(link.symlink_metadata().is_ok() && target.exists());
    }

    #[test]
    fn 資料夾不存在不出錯() {
        let d = tempfile::tempdir().unwrap();
        let ghost = d.path().join("nope");
        assert_eq!(sweep_stale_at(&[ghost.as_path()], 1, later(60)).0, 0);
        assert_eq!(sweep_stale(&[ghost.as_path()], 1), 0);
    }

    #[test]
    fn 有刪才有記錄且不含檔名() {
        assert!(sweep_summary(0, &[]).is_none());
        let d = tempfile::tempdir().unwrap();
        touch(d.path(), "secret_name.json.4242.7.tmp");
        let (n, hit) = sweep_stale_at(&[d.path()], 1, later(60));
        let line = sweep_summary(n, &hit).unwrap();
        assert!(line.starts_with("[ASN]") && line.contains("1 個") && !line.contains("secret_name"));
    }
}
