//! 使用者資料夾（金鑰、節點代號、橋的工作資料夾）：單一解析函式＋合併式遷移（ONBOARDING §5.2、§5.3；#14 R2）。
//!
//! 新位置 `%USERPROFILE%\.asn`，舊位置 `%USERPROFILE%\.irori-relay`。因為 `.asn` 早就被內建收發室與 Claude 外掛使用
//! （`handoff`、`status`、`control`、`updater`、`play`…），金鑰與節點代號卻還在舊資料夾，所以 §5.3 的「整個資料夾改名」
//! 不適用，改做「合併式遷移」：把舊資料夾裡的項目逐項搬進 `.asn`，成功後把舊位置換成指向 `.asn` 的相容連結。
//!
//! 解析順序（與 relay/machine/home.mjs 一致，兩邊各有測試）：
//! 1. `ASN_HOME`（舊名 `IRORI_HOME`）→ 直接用，不遷移。
//! 2. `.asn` 不存在：舊的存在就用舊的，都沒有就用 `.asn`（由寫入的人建立）。
//! 3. `.asn` 存在：舊位置是連結、不存在或是空資料夾 → 用 `.asn`；舊位置是有內容的真資料夾（尚未遷移）→ 用舊的，
//!    新位置當後備。
//!
//! 遷移的守則：任何一步失敗就倒回已搬的項目、不刪任何東西；舊橋（`bridge.pid`／`mailbox.pid`）還活著就不遷移；
//! 只用同磁碟的 rename（保留 Windows 檔案 ACL，金鑰檔不會因為搬家而放寬權限），跨磁碟 rename 會失敗＝放棄。
//! 同名衝突不覆寫：舊的那份搬進 `.asn\irori-relay-conflicts\`，並記進標記檔。
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const NEW_NAME: &str = ".asn";
pub const LEGACY_NAME: &str = ".irori-relay";
/// 遷移完成標記檔（放在新資料夾裡）
pub const MARKER: &str = ".irori-relay-migrated.json";
/// 同名衝突時，舊的那份搬到這裡
pub const CONFLICTS_DIR: &str = "irori-relay-conflicts";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Override,
    Fresh,
    Legacy,
    New,
    Linked,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeInfo {
    pub primary: PathBuf,
    pub fallback: Option<PathBuf>,
    pub state: State,
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    Link,
    Dir,
    Other,
}

fn kind_of(p: &Path) -> Option<Kind> {
    let m = fs::symlink_metadata(p).ok()?;
    if m.file_type().is_symlink() || is_reparse(&m) {
        return Some(Kind::Link);
    }
    Some(if m.is_dir() { Kind::Dir } else { Kind::Other })
}

#[cfg(windows)]
fn is_reparse(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT（目錄接合點、符號連結）
}
#[cfg(not(windows))]
fn is_reparse(_: &fs::Metadata) -> bool {
    false
}

fn non_empty_dir(p: &Path) -> bool {
    fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(false)
}

/// 解析：base＝使用者家目錄，override_＝ASN_HOME 的值（已含舊名 IRORI_HOME 的相容）。可注入，測試不碰真資料夾。
pub fn resolve_at(base: &Path, override_: Option<&str>) -> HomeInfo {
    if let Some(o) = override_.map(str::trim).filter(|s| !s.is_empty()) {
        return HomeInfo { primary: PathBuf::from(o), fallback: None, state: State::Override };
    }
    let fresh = base.join(NEW_NAME);
    let legacy = base.join(LEGACY_NAME);
    let kn = kind_of(&fresh);
    let kl = kind_of(&legacy);
    if kn.is_none() {
        return match kl {
            Some(Kind::Dir) | Some(Kind::Link) => HomeInfo { primary: legacy, fallback: None, state: State::Legacy },
            _ => HomeInfo { primary: fresh, fallback: None, state: State::Fresh },
        };
    }
    if kl == Some(Kind::Dir) && non_empty_dir(&legacy) {
        return HomeInfo { primary: legacy, fallback: Some(fresh), state: State::Pending };
    }
    let state = if kl == Some(Kind::Link) { State::Linked } else { State::New };
    HomeInfo { primary: fresh, fallback: None, state }
}

/// 本行程的解析結果（家目錄與 ASN_HOME 取自環境）
pub fn resolve() -> HomeInfo {
    resolve_at(&crate::identity::home_dir(), crate::envc::get("ASN_HOME").as_deref())
}

// ---------------------------------------------------------------- 遷移

/// 會碰檔案系統與程序的動作，抽成介面讓測試能注入失敗
pub trait Ops {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// 在 `link` 建一個指向 `target` 的目錄連結（Windows 目錄接合點、Linux 符號連結）
    fn make_link(&self, link: &Path, target: &Path) -> io::Result<()>;
    fn pid_alive(&self, pid: u32) -> bool;
}

pub struct RealOps;
impl Ops for RealOps {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }
    #[cfg(windows)]
    fn make_link(&self, link: &Path, target: &Path) -> io::Result<()> {
        use crate::nowin::NoWindow;
        let out = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(link).arg(target).no_window().output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("mklink 失敗（結束碼 {:?}）", out.status.code())))
        }
    }
    #[cfg(not(windows))]
    fn make_link(&self, link: &Path, target: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }
    fn pid_alive(&self, pid: u32) -> bool {
        crate::heartbeat::pid_alive(pid)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 沒有東西要遷移（舊位置不存在、已是連結…）
    Nothing(&'static str),
    /// 這次不遷移（原因給人看）
    Skipped(String),
    Migrated { moved: Vec<String>, conflicts: Vec<String>, whole: bool },
    /// 失敗；已倒回。rollback_errors 非空表示倒回也有項目沒成功（資料都還在，只是位置不同；解析函式會用後備位置找）
    Failed { reason: String, rollback_errors: Vec<String> },
}

fn read_pid(p: &Path) -> Option<u32> {
    fs::read_to_string(p).ok()?.trim().parse().ok()
}

/// 舊資料夾底下記錄的程序有沒有還活著的：根目錄與 machine-*／aegis-* 底下的 `*.pid`（`bridge.pid`、`mailbox.pid`…）。
/// 自己的 pid 也算活著（保守）。
fn live_pid_in(legacy: &Path, ops: &dyn Ops) -> Option<(String, u32)> {
    let me = std::process::id();
    let check_dir = |d: &Path, label: &str| -> Option<(String, u32)> {
        for e in fs::read_dir(d).ok()?.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".pid") || !e.path().is_file() {
                continue;
            }
            if let Some(p) = read_pid(&e.path()) {
                if p != 0 && (p == me || ops.pid_alive(p)) {
                    return Some((format!("{label}{name}"), p));
                }
            }
        }
        None
    };
    if let Some(h) = check_dir(legacy, "") {
        return Some(h);
    }
    for e in fs::read_dir(legacy).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if (name.starts_with("machine-") || name.starts_with("aegis-")) && e.path().is_dir() {
            if let Some(h) = check_dir(&e.path(), &format!("{name}/")) {
                return Some(h);
            }
        }
    }
    None
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    (1..).map(|i| dir.join(format!("{name}.{i}"))).find(|p| !exists(p)).unwrap()
}

/// 把 (原位置, 新位置) 依相反順序搬回去；回傳沒搬成功的說明（只含檔名，不含內容）
fn rollback(ops: &dyn Ops, journal: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errs = Vec::new();
    for (from, to) in journal.iter().rev() {
        if let Err(e) = ops.rename(to, from) {
            errs.push(format!("{}：{e}", from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
        }
    }
    errs
}

fn write_marker(new: &Path, moved: &[String], conflicts: &[String], whole: bool) {
    let list = |v: &[String]| v.iter().map(|s| format!("{s:?}")).collect::<Vec<_>>().join(",");
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let body = format!("{{\"migrated_at_unix\":{secs},\"whole_folder\":{whole},\"moved\":[{}],\"conflicts\":[{}]}}\n", list(moved), list(conflicts));
    let _ = fs::write(new.join(MARKER), body);
}

/// 合併式遷移。base＝家目錄（可注入）。不讀任何檔案內容（只看 pid 檔的數字與檔名）。
pub fn migrate(base: &Path, ops: &dyn Ops) -> Outcome {
    let new = base.join(NEW_NAME);
    let legacy = base.join(LEGACY_NAME);
    match kind_of(&legacy) {
        None => return Outcome::Nothing("沒有舊資料夾"),
        Some(Kind::Link) => return Outcome::Nothing("舊位置已經是連結"),
        Some(Kind::Other) => return Outcome::Skipped("舊位置不是資料夾".into()),
        Some(Kind::Dir) => {}
    }
    if let Some((f, pid)) = live_pid_in(&legacy, ops) {
        return Outcome::Skipped(format!("舊的橋或舊版 ASN 還在跑（{f} 記錄的程序 {pid}），這次不遷移"));
    }
    let kn = kind_of(&new);
    if matches!(kn, Some(Kind::Link) | Some(Kind::Other)) {
        return Outcome::Skipped("新位置不是一般資料夾".into());
    }
    let fail = |reason: String, journal: &[(PathBuf, PathBuf)]| Outcome::Failed { reason, rollback_errors: rollback(ops, journal) };

    // 新位置不存在：整個資料夾改名（§5.3 原做法）
    if kn.is_none() {
        if let Err(e) = ops.rename(&legacy, &new) {
            return Outcome::Failed { reason: format!("改名失敗：{e}"), rollback_errors: vec![] };
        }
        let journal = vec![(legacy.clone(), new.clone())];
        if let Err(e) = ops.make_link(&legacy, &new) {
            return fail(format!("建立相容連結失敗：{e}"), &journal);
        }
        write_marker(&new, &[], &[], true);
        return Outcome::Migrated { moved: vec![], conflicts: vec![], whole: true };
    }

    // 合併：逐項搬
    let mut entries: Vec<String> = match fs::read_dir(&legacy) {
        Ok(rd) => rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect(),
        Err(e) => return Outcome::Failed { reason: format!("讀不了舊資料夾：{e}"), rollback_errors: vec![] },
    };
    entries.sort();
    let mut journal: Vec<(PathBuf, PathBuf)> = Vec::new();
    let (mut moved, mut conflicts) = (Vec::new(), Vec::new());
    let conflicts_dir = new.join(CONFLICTS_DIR);
    let conflicts_existed = exists(&conflicts_dir);
    let cleanup_conflicts = |journal: &[(PathBuf, PathBuf)]| -> Vec<String> {
        let errs = rollback(ops, journal);
        if !conflicts_existed {
            let _ = fs::remove_dir(&conflicts_dir); // 空的才會成功；不是空的就留著，不刪任何東西
        }
        errs
    };
    for name in &entries {
        let src = legacy.join(name);
        let dst = new.join(name);
        let (target, is_conflict) = if exists(&dst) {
            if let Err(e) = fs::create_dir_all(&conflicts_dir) {
                let errs = cleanup_conflicts(&journal);
                return Outcome::Failed { reason: format!("建不了衝突資料夾：{e}"), rollback_errors: errs };
            }
            (free_name(&conflicts_dir, name), true)
        } else {
            (dst, false)
        };
        if let Err(e) = ops.rename(&src, &target) {
            let errs = cleanup_conflicts(&journal);
            return Outcome::Failed { reason: format!("搬「{name}」失敗：{e}"), rollback_errors: errs };
        }
        journal.push((src, target));
        if is_conflict {
            conflicts.push(name.clone());
        } else {
            moved.push(name.clone());
        }
    }
    // 舊資料夾現在是空的：移除（只有空資料夾才刪得掉），換成相容連結
    if let Err(e) = fs::remove_dir(&legacy) {
        let errs = cleanup_conflicts(&journal);
        return Outcome::Failed { reason: format!("舊資料夾清不空：{e}"), rollback_errors: errs };
    }
    if let Err(e) = ops.make_link(&legacy, &new) {
        let _ = fs::create_dir(&legacy);
        let errs = cleanup_conflicts(&journal);
        return Outcome::Failed { reason: format!("建立相容連結失敗：{e}"), rollback_errors: errs };
    }
    write_marker(&new, &moved, &conflicts, false);
    Outcome::Migrated { moved, conflicts, whole: false }
}

/// ASN_HOME 有設（使用者自己指定資料夾）就不遷移；否則照 [`migrate`]
pub fn migrate_unless_override(base: &Path, override_: Option<&str>, ops: &dyn Ops) -> Outcome {
    if override_.map(|s| !s.trim().is_empty()).unwrap_or(false) {
        return Outcome::Skipped("有設定 ASN_HOME，不遷移".into());
    }
    migrate(base, ops)
}

/// 啟動時做一次（桌面版）。結果只印一行說明（檔名清單，不含內容）。
pub fn migrate_at_startup() {
    #[cfg(desktop)]
    {
        let base = crate::identity::home_dir();
        match migrate_unless_override(&base, crate::envc::get("ASN_HOME").as_deref(), &RealOps) {
            Outcome::Nothing(_) => {}
            Outcome::Skipped(r) => eprintln!("[asn] 資料夾遷移略過：{r}"),
            Outcome::Migrated { moved, conflicts, whole } => {
                eprintln!("[asn] 資料夾已遷移到 .asn（整個改名：{whole}；搬 {} 項、衝突 {} 項：{}）", moved.len(), conflicts.len(), conflicts.join("、"))
            }
            Outcome::Failed { reason, rollback_errors } => {
                eprintln!("[asn] 資料夾遷移失敗，已倒回、沿用舊位置：{reason}{}", if rollback_errors.is_empty() { String::new() } else { format!("；倒回有 {} 項沒成功：{}", rollback_errors.len(), rollback_errors.join("、")) })
            }
        }
    }
}

#[cfg(test)]
mod tests;
