//! 電腦版資料資料夾與程式識別（#14 R3）：識別由 `tw.irori.asn` 改成 `tw.yooliang.asn`，資料夾跟著換名。
//!
//! 舊資料夾 `%APPDATA%\tw.irori.asn`（設定、聊天記錄、登入存檔、外掛標記…）與 `%LOCALAPPDATA%\tw.irori.asn`
//! （目前只有 WebView2 的 `EBWebView` 快取）。守則：
//! - 新資料夾不存在、舊的存在 → **複製**（不是搬）到新位置；舊資料夾原封不動留著（R9 才清）。
//! - 先複製到同層的暫存資料夾 `tw.yooliang.asn.migrating`，檢查檔案清單與大小都對得上、寫好標記檔，最後一步才改名成
//!   新資料夾：新資料夾要嘛不存在、要嘛完整，不會有複製到一半的狀態。
//! - 任何一步失敗：清掉自己的暫存資料夾、不留標記，這次照用舊資料夾（下次啟動再試），不丟資料。
//! - 舊版 ASN 還在跑（心跳新鮮、程序還活著）時不遷移，這次沿用舊資料夾：兩邊共用同一份資料與視窗名，
//!   後面的「同一個視窗名只留一個 ASN」檢查就會擋掉後來的那個，不會兩份資料各跑一個搶同一把節點金鑰。
//! - WebView2 的 `EBWebView` 不複製：桌面介面沒有用到 localStorage／IndexedDB／cookie（偏好都存在資料夾的 json 檔），
//!   換識別後 WebView2 會建新的空設定檔，使用者看不出差別。
//! - 只有 Windows 有識別資料夾；其他系統（含安卓）維持 `~/.irori-asn`，不遷移。
use crate::heartbeat::{self, Heartbeat};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const OLD_ID: &str = "tw.irori.asn";
pub const NEW_ID: &str = "tw.yooliang.asn";
/// 複製完成的標記檔（放在新資料夾裡；只記來源、時間與數量，不記任何內容）
pub const MARKER: &str = ".migrated-from-tw-irori-asn.json";
/// 複製用的暫存資料夾名尾巴（與新資料夾同層，這樣最後的改名在同一個磁碟、是原子的）
pub const STAGING_SUFFIX: &str = ".migrating";
/// Local 資料夾裡不複製的項目（WebView2 的瀏覽器設定檔）
pub const LOCAL_SKIP: &[&str] = &["EBWebView"];

/// 沒有識別資料夾的系統（Linux 桌面、安卓）沿用的舊位置名稱（相對家目錄）
pub const FALLBACK_NAME: &str = ".irori-asn";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 新資料夾已存在（早就遷移過，或新裝的）：直接用，什麼都不碰
    AlreadyNew,
    /// 新舊都不存在：全新安裝，由寫入的人建立新資料夾
    Fresh,
    /// 舊資料夾沒有東西需要複製（例如 Local 只有 EBWebView）：不建新資料夾
    NothingToCopy,
    /// 複製完成
    Copied { files: usize, bytes: u64 },
    /// 舊版 ASN 還在跑，這次不遷移，沿用舊資料夾
    Blocked(String),
    /// 複製失敗，已清掉暫存、沒有標記，沿用舊資料夾
    Failed(String),
}

/// 這次該用哪個資料夾
pub fn choose(outcome: &Outcome, old: &Path, new: &Path) -> PathBuf {
    match outcome {
        Outcome::Blocked(_) | Outcome::Failed(_) => old.to_path_buf(),
        _ => new.to_path_buf(),
    }
}

/// 暫存資料夾的位置
pub fn staging_of(new: &Path) -> PathBuf {
    let mut n = new.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    n.push(STAGING_SUFFIX);
    new.with_file_name(n)
}

#[derive(Debug, PartialEq, Eq)]
struct Listing {
    /// (相對路徑用「/」分隔, 大小)；只記檔案
    files: Vec<(String, u64)>,
}

fn skipped(rel_first: &str, skip: &[&str]) -> bool {
    skip.iter().any(|s| s.eq_ignore_ascii_case(rel_first))
}

/// 列出 root 底下的所有一般檔案（不跟隨連結；連結與特殊檔略過），頂層名稱在 skip 內的整個略過
fn list_tree(root: &Path, skip: &[&str]) -> io::Result<Listing> {
    let mut files = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        for e in fs::read_dir(&dir)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().to_string();
            if rel.is_empty() && skipped(&name, skip) {
                continue;
            }
            let ft = e.file_type()?;
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if ft.is_symlink() {
                continue;
            } else if ft.is_dir() {
                stack.push((e.path(), r));
            } else if ft.is_file() {
                files.push((r, e.metadata()?.len()));
            }
        }
    }
    files.sort();
    Ok(Listing { files })
}

/// 複製一個檔案（可替換，測試用來模擬失敗與截斷）
pub type Copier<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<u64>;

fn copy_listing(src: &Path, dst: &Path, l: &Listing, copier: Copier) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for (rel, _) in &l.files {
        let from = src.join(rel);
        let to = dst.join(rel);
        if let Some(p) = to.parent() {
            fs::create_dir_all(p)?;
        }
        copier(&from, &to)?;
    }
    Ok(())
}

#[derive(Serialize)]
struct MarkerBody<'a> {
    from: &'a str,
    to: &'a str,
    at: u64,
    files: usize,
    bytes: u64,
}

/// 單一資料夾的遷移。`busy` 回 Some(原因) 表示舊版還在用，這次不遷移。
pub fn migrate_dir(old: &Path, new: &Path, skip: &[&str], busy: &dyn Fn() -> Option<String>, copier: Copier, now_secs: u64) -> Outcome {
    if new.exists() {
        return Outcome::AlreadyNew;
    }
    if !old.is_dir() {
        return Outcome::Fresh;
    }
    let listing = match list_tree(old, skip) {
        Ok(l) => l,
        Err(e) => return Outcome::Failed(format!("讀不了舊資料夾：{e}")),
    };
    if listing.files.is_empty() {
        return Outcome::NothingToCopy;
    }
    if let Some(why) = busy() {
        return Outcome::Blocked(why);
    }
    let staging = staging_of(new);
    // 上次失敗留下的暫存資料夾是我們自己的（名稱專用），清掉重來
    if staging.exists() {
        if let Err(e) = fs::remove_dir_all(&staging) {
            return Outcome::Failed(format!("清不掉上次的暫存資料夾：{e}"));
        }
    }
    let fail = |msg: String| {
        let _ = fs::remove_dir_all(&staging);
        Outcome::Failed(msg)
    };
    if let Err(e) = copy_listing(old, &staging, &listing, copier) {
        return fail(format!("複製失敗：{e}"));
    }
    // 複製後逐檔核對：檔案清單與大小都要一樣，否則視為失敗
    match list_tree(&staging, &[]) {
        Ok(got) if got == listing => {}
        Ok(_) => return fail("複製後的檔案清單或大小與舊資料夾對不上".into()),
        Err(e) => return fail(format!("核對失敗：{e}")),
    }
    let bytes: u64 = listing.files.iter().map(|(_, n)| n).sum();
    let body = MarkerBody { from: &old.to_string_lossy(), to: &new.to_string_lossy(), at: now_secs, files: listing.files.len(), bytes };
    let marker = match serde_json::to_string_pretty(&body) {
        Ok(t) => t,
        Err(e) => return fail(format!("標記檔寫不出來：{e}")),
    };
    if let Err(e) = fs::write(staging.join(MARKER), format!("{marker}\n")) {
        return fail(format!("寫標記檔失敗：{e}"));
    }
    if let Err(e) = fs::rename(&staging, new) {
        return fail(format!("暫存資料夾改名失敗：{e}"));
    }
    Outcome::Copied { files: listing.files.len(), bytes }
}

/// 別的 ASN（不是自己）是不是還在用同一個工作資料夾收信：掃所有心跳檔
pub fn other_asn_alive(work_dir: &Path, my_pid: u32, now: u64, stale: u64, alive: impl Fn(u32) -> bool, is_asn: impl Fn(u32) -> Option<bool>) -> Option<Heartbeat> {
    for e in fs::read_dir(heartbeat::self_recv_dir(work_dir)).ok()?.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(h) = fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Heartbeat>(&t).ok()) else { continue };
        if h.pid != my_pid && heartbeat::alive_fresh(&h, now, stale, &alive) && is_asn(h.pid) != Some(false) {
            return Some(h);
        }
    }
    None
}

fn real_copier(from: &Path, to: &Path) -> io::Result<u64> {
    fs::copy(from, to)
}

fn log(label: &str, o: &Outcome) {
    match o {
        Outcome::Copied { files, bytes } => elog!("[asn] {label}已複製到新識別資料夾（{files} 個檔、{bytes} 位元組）；舊資料夾保留"),
        Outcome::Blocked(w) => elog!("[asn] {label}遷移略過（{w}），這次沿用舊資料夾"),
        Outcome::Failed(w) => elog!("[asn] {label}遷移失敗，這次沿用舊資料夾：{w}"),
        _ => {}
    }
}

/// 啟動時決定資料資料夾（沒設 `ASN_DATA` 時才會呼叫）。`no_migrate`（截圖模式）只回新位置、什麼都不複製。
pub fn startup(work_dir: &Path, no_migrate: bool) -> PathBuf {
    let home = crate::identity::home_dir();
    let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) else {
        return home.join(FALLBACK_NAME);
    };
    let (old, new) = (appdata.join(OLD_ID), appdata.join(NEW_ID));
    if no_migrate {
        return new;
    }
    let now = heartbeat::now_ms();
    let busy = || {
        other_asn_alive(work_dir, std::process::id(), now, heartbeat::stale_ms(), heartbeat::pid_alive, heartbeat::is_asn_process)
            .map(|h| format!("舊版 ASN（pid {}）還在跑", h.pid))
    };
    let secs = now / 1000;
    let o = migrate_dir(&old, &new, &[], &busy, &real_copier, secs);
    log("資料夾", &o);
    // Local（WebView2 快取）：失敗與否都不影響主資料夾
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let lo = migrate_dir(&local.join(OLD_ID), &local.join(NEW_ID), LOCAL_SKIP, &busy, &real_copier, secs);
        log("本機資料夾", &lo);
    }
    choose(&o, &old, &new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use tempfile::tempdir;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }
    fn not_busy() -> Option<String> {
        None
    }
    fn setup(old: &Path) {
        write(old, "settings.json", "{\"a\":1}");
        write(old, "asn-me.json", "{\"b\":2}");
        write(old, "chats/asn-x.json", "[1,2,3]");
        write(old, "chats/deep/er/y.json", "yy");
    }

    #[test]
    fn 複製後新舊一樣且舊的原封不動() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        setup(&old);
        let o = migrate_dir(&old, &new, &[], &not_busy, &real_copier, 1234);
        assert_eq!(o, Outcome::Copied { files: 4, bytes: 7 + 7 + 7 + 2 });
        for (rel, body) in [("settings.json", "{\"a\":1}"), ("asn-me.json", "{\"b\":2}"), ("chats/asn-x.json", "[1,2,3]"), ("chats/deep/er/y.json", "yy")] {
            assert_eq!(fs::read_to_string(new.join(rel)).unwrap(), body, "{rel}");
            assert_eq!(fs::read_to_string(old.join(rel)).unwrap(), body, "舊的 {rel} 不能被動到");
        }
        assert!(new.join(MARKER).is_file());
        assert!(!staging_of(&new).exists());
        assert_eq!(choose(&o, &old, &new), new);
        let m: serde_json::Value = serde_json::from_str(&fs::read_to_string(new.join(MARKER)).unwrap()).unwrap();
        assert_eq!((m["files"].as_u64(), m["at"].as_u64()), (Some(4), Some(1234)));
    }

    #[test]
    fn 新資料夾已存在就完全不碰() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        setup(&old);
        write(&new, "settings.json", "NEW");
        let o = migrate_dir(&old, &new, &[], &not_busy, &real_copier, 1);
        assert_eq!(o, Outcome::AlreadyNew);
        assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), "NEW", "不覆寫新資料夾");
        assert!(!new.join("asn-me.json").exists() && !new.join(MARKER).exists());
    }

    #[test]
    fn 都不存在是全新安裝且不建任何東西() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        let o = migrate_dir(&old, &new, &[], &not_busy, &real_copier, 1);
        assert_eq!(o, Outcome::Fresh);
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 0);
        assert_eq!(choose(&o, &old, &new), new);
    }

    #[test]
    fn 複製中途失敗不留新資料夾也不留標記而且沿用舊的() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        setup(&old);
        let n = Cell::new(0);
        let flaky = |a: &Path, b: &Path| {
            n.set(n.get() + 1);
            if n.get() == 3 { Err(io::Error::new(io::ErrorKind::PermissionDenied, "被鎖住")) } else { fs::copy(a, b) }
        };
        let o = migrate_dir(&old, &new, &[], &not_busy, &flaky, 1);
        assert!(matches!(&o, Outcome::Failed(m) if m.contains("被鎖住")), "{o:?}");
        assert!(!new.exists(), "不能留下半套新資料夾");
        assert!(!staging_of(&new).exists(), "暫存要清掉");
        assert_eq!(choose(&o, &old, &new), old);
        assert_eq!(fs::read_to_string(old.join("chats/asn-x.json")).unwrap(), "[1,2,3]");
        // 下次啟動重試會成功
        let again = migrate_dir(&old, &new, &[], &not_busy, &real_copier, 2);
        assert!(matches!(again, Outcome::Copied { files: 4, .. }));
    }

    #[test]
    fn 複製出來的檔案被截斷要判失敗() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        setup(&old);
        let truncating = |_: &Path, b: &Path| fs::write(b, "").map(|_| 0);
        let o = migrate_dir(&old, &new, &[], &not_busy, &truncating, 1);
        assert!(matches!(&o, Outcome::Failed(m) if m.contains("對不上")), "{o:?}");
        assert!(!new.exists() && !staging_of(&new).exists());
    }

    #[test]
    fn 上次留下的暫存資料夾會被清掉重來() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        setup(&old);
        write(&staging_of(&new), "stale.txt", "上次的殘渣");
        let o = migrate_dir(&old, &new, &[], &not_busy, &real_copier, 1);
        assert!(matches!(o, Outcome::Copied { files: 4, .. }));
        assert!(!new.join("stale.txt").exists());
    }

    #[test]
    fn 舊版還在跑就不遷移而且沿用舊資料夾() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        setup(&old);
        let busy = || Some("舊版 ASN（pid 7）還在跑".to_string());
        let o = migrate_dir(&old, &new, &[], &busy, &real_copier, 1);
        assert!(matches!(&o, Outcome::Blocked(_)));
        assert!(!new.exists() && !staging_of(&new).exists());
        assert_eq!(choose(&o, &old, &new), old);
    }

    #[test]
    fn local只有webview快取就什麼都不建() {
        let d = tempdir().unwrap();
        let (old, new) = (d.path().join(OLD_ID), d.path().join(NEW_ID));
        write(&old, "EBWebView/Default/Local Storage/x", "cache");
        let o = migrate_dir(&old, &new, LOCAL_SKIP, &not_busy, &real_copier, 1);
        assert_eq!(o, Outcome::NothingToCopy);
        assert!(!new.exists() && !staging_of(&new).exists());
        // 有別的東西時：複製別的、不複製 EBWebView
        write(&old, "other/a.txt", "a");
        let o = migrate_dir(&old, &new, LOCAL_SKIP, &not_busy, &real_copier, 1);
        assert!(matches!(o, Outcome::Copied { files: 1, .. }), "{o:?}");
        assert!(new.join("other/a.txt").is_file() && !new.join("EBWebView").exists());
    }

    #[test]
    fn 暫存資料夾與新資料夾同層() {
        let n = Path::new("X").join("Roaming").join(NEW_ID);
        assert_eq!(staging_of(&n), Path::new("X").join("Roaming").join("tw.yooliang.asn.migrating"));
    }

    fn hb(dir: &Path, name: &str, pid: u32, t: u64) {
        fs::create_dir_all(heartbeat::self_recv_dir(dir)).unwrap();
        fs::write(heartbeat::self_recv_dir(dir).join(format!("{name}.json")), serde_json::to_string(&Heartbeat { pid, name: name.into(), t }).unwrap()).unwrap();
    }

    #[test]
    fn 找別的還活著的asn() {
        let d = tempdir().unwrap();
        hb(d.path(), "A", 100, 1_000_000);
        let alive = |p: u32| p == 100;
        // 新鮮、活著、是 asn → 找到
        assert_eq!(other_asn_alive(d.path(), 1, 1_010_000, 90_000, alive, |_| Some(true)).map(|h| h.pid), Some(100));
        // 查不到執行檔（None）也當作可能是
        assert!(other_asn_alive(d.path(), 1, 1_010_000, 90_000, alive, |_| None).is_some());
        // 自己的心跳不算
        assert!(other_asn_alive(d.path(), 100, 1_010_000, 90_000, alive, |_| Some(true)).is_none());
        // 心跳過期不算
        assert!(other_asn_alive(d.path(), 1, 2_000_000, 90_000, alive, |_| Some(true)).is_none());
        // pid 已死不算
        assert!(other_asn_alive(d.path(), 1, 1_010_000, 90_000, |_| false, |_| Some(true)).is_none());
        // pid 被別的程式重用不算
        assert!(other_asn_alive(d.path(), 1, 1_010_000, 90_000, alive, |_| Some(false)).is_none());
        // 沒有心跳資料夾
        assert!(other_asn_alive(&d.path().join("nope"), 1, 1_010_000, 90_000, alive, |_| Some(true)).is_none());
    }
}
