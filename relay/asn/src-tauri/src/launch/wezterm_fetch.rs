//! Linux：按需取得 WezTerm（#893 第 3 張）。無畫面主機沒有 Windows 那樣的安裝檔可以附帶，本人又未必裝了 wezterm，
//! 所以在「開了夥伴共用終端服務、卻找不到 wezterm」時，從官方 GitHub release 下載固定版本的 tar.xz 到使用者資料夾。
//!
//! 版本與雜湊的唯一來源是 `scripts/wezterm-pins.json`（編譯時讀入；Windows 的 fetch-wezterm.mjs 與 CI 探測腳本也讀同一份）。
//! 流程：判斷發行版 → 檢查磁碟空間 → 下載到私有暫存資料夾（有大小上限與逾時，只跟官方 GitHub 主機往來）→ **核對 SHA-256**
//! → 解 xz（有大小上限）→ 只取兩個固定成員（一般檔案）→ 跑 `--version` 確認能執行 → 原子改名到正式位置。
//! 任何一步失敗都清掉暫存資料夾，不自動重試。優先順序見 `wezterm::locate`：ASN_WEZTERM_DIR → PATH → 這裡取得的。
#![cfg(desktop)]

use crate::nowin::NoWindow;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PINS_JSON: &str = include_str!("../../../scripts/wezterm-pins.json");
/// 下載基底網址（官方正式路徑；`wez/wezterm` 只是轉址）。pins 裡的 `release_base` 必須等於它，網址不接受環境變數覆寫
pub(crate) const DOWNLOAD_BASE: &str = "https://github.com/wezterm/wezterm/releases/download";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const MIB: u64 = 1024 * 1024;
/// 開始前至少要有這麼多可用空間（下載 + 解開的 tar + 取出的兩個檔，留餘裕）
const NEED_FREE: u64 = 512 * MIB;
/// 要取的成員（tar 裡的路徑 → 存成的檔名）。其餘成員一律略過，不展開
const WANTED: [(&str, &str); 2] = [("wezterm/usr/bin/wezterm", "wezterm"), ("wezterm/usr/bin/wezterm-mux-server", "wezterm-mux-server")];

#[derive(Debug, Deserialize)]
pub(crate) struct Pins {
    pub version: String,
    pub release_base: String,
    pub linux: BTreeMap<String, Pin>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Pin {
    pub tarball: String,
    pub sha256: String,
    pub size: u64,
}

fn pins() -> Result<Pins, String> {
    serde_json::from_str(PINS_JSON).map_err(|e| format!("內建的 WezTerm 版本資料壞了：{e}"))
}

/// 各種大小上限。超過就中止（防下載被換成超大檔、解壓炸彈、成員宣稱的大小與實際不符）
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    /// 下載的 tar.xz
    pub max_tarball: u64,
    /// 解壓縮後的 tar
    pub max_tar: u64,
    /// 單一成員
    pub max_member: u64,
    /// 取出的成員總和
    pub max_total: u64,
    /// tar 成員個數
    pub max_entries: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_tarball: 64 * MIB, max_tar: 384 * MIB, max_member: 96 * MIB, max_total: 128 * MIB, max_entries: 20_000 }
    }
}

// ---------- 發行版 ----------

#[derive(Debug, Default, PartialEq)]
pub(crate) struct OsRelease {
    pub id: String,
    pub version_id: String,
    pub pretty: String,
}

/// 讀 /etc/os-release 的 ID、VERSION_ID、PRETTY_NAME（不看 ID_LIKE，免得猜錯版本）
pub(crate) fn parse_os_release(text: &str) -> OsRelease {
    let mut o = OsRelease::default();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
        match k.trim() {
            "ID" => o.id = v.to_ascii_lowercase(),
            "VERSION_ID" => o.version_id = v.to_string(),
            "PRETTY_NAME" => o.pretty = v.to_string(),
            _ => {}
        }
    }
    o
}

const MANUAL_HINT: &str = "請用套件管理員安裝 wezterm，或設定 ASN_WEZTERM_DIR 指到已安裝的資料夾";

/// 發行版 → pins 裡的 key。不支援就回使用者看得懂的話
pub(crate) fn pin_key(os: &OsRelease, arch: &str) -> Result<&'static str, String> {
    if arch != "x86_64" {
        return Err(format!("這台電腦的處理器（{arch}）還沒有支援自動取得終端程式，{MANUAL_HINT}"));
    }
    match (os.id.as_str(), os.version_id.as_str()) {
        // 24.04 用 22.04 的檔（同樣連 libssl3，CI 在 24.04 實測過）
        ("ubuntu", "22.04" | "24.04") => Ok("ubuntu-22.04"),
        ("ubuntu", "20.04") => Ok("ubuntu-20.04"),
        ("debian", "12") => Ok("debian-12"),
        ("debian", "11") => Ok("debian-11"),
        ("debian", "10") => Ok("debian-10"),
        _ => {
            let name = if os.pretty.is_empty() { "不明的發行版" } else { os.pretty.as_str() };
            Err(format!("這台 Linux（{name}）還沒有支援自動取得終端程式，{MANUAL_HINT}"))
        }
    }
}

// ---------- 網址 ----------

/// 下載網址：tarball 檔名只准英數與 `._-`，版本同理，免得資料被改壞時組出奇怪的網址
pub(crate) fn download_url(release_base: &str, version: &str, tarball: &str) -> Result<String, String> {
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if release_base != DOWNLOAD_BASE || !ok(version) || !ok(tarball) {
        return Err("內建的 WezTerm 版本資料不合法".into());
    }
    Ok(format!("{DOWNLOAD_BASE}/{version}/{tarball}"))
}

/// 重新導向只跟 GitHub 自己的主機（release 檔實際放在 githubusercontent.com）
pub(crate) fn allowed_redirect_host(host: &str) -> bool {
    ["github.com", "githubusercontent.com"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

// ---------- 磁碟空間 ----------

/// statvfs 的結果 → 可用位元組（非 root 可用的區塊數 × 區塊大小）
pub(crate) fn avail_bytes(frsize: u64, bsize: u64, bavail: u64) -> u64 {
    let unit = if frsize > 0 { frsize } else { bsize };
    bavail.saturating_mul(unit)
}

/// x86_64 Linux 的 `struct statvfs`（glibc 的 <bits/statvfs.h>、musl 的 <sys/statvfs.h> 欄位順序與大小相同，共 112 位元組）。
/// 前 11 個欄位都是 unsigned long／fsblkcnt_t／fsfilcnt_t＝8 位元組；最後 24 位元組是保留位（glibc 是 int __f_spare[6]，
/// musl 是 unsigned f_type + int __reserved[5]），這裡一律當 6 個 int 的保留位
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[repr(C)]
struct StatVfs {
    f_bsize: u64,
    f_frsize: u64,
    f_blocks: u64,
    f_bfree: u64,
    f_bavail: u64,
    f_files: u64,
    f_ffree: u64,
    f_favail: u64,
    f_fsid: u64,
    f_flag: u64,
    f_namemax: u64,
    f_spare: [i32; 6],
}

/// 該資料夾所在檔案系統的可用位元組；查不到回 None。直接呼叫 libc 的 `statvfs`（和 wezterm.rs 呼叫 setsid 同樣的寫法，
/// 不新增相依、不跑外部指令）。只在 x86_64 Linux 做，其他平台回 None（呼叫端照放行處理）
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    extern "C" {
        fn statvfs(path: *const std::os::raw::c_char, buf: *mut StatVfs) -> i32;
    }
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: path 是以 NUL 結尾的 C 字串；全部欄位都是整數，全 0 是合法值；statvfs 只寫進這個大小正確的結構
    let mut v: StatVfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { statvfs(path.as_ptr(), &mut v) };
    (rc == 0).then(|| avail_bytes(v.f_frsize, v.f_bsize, v.f_bavail))
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
}

/// 查不到就放行（真的不夠時，寫檔失敗會清掉暫存）；查得到而不夠就在下載前擋下
pub(crate) fn check_space(free: Option<u64>, need: u64) -> Result<(), String> {
    match free {
        Some(f) if f < need => Err(format!("磁碟空間不夠：取得終端程式需要約 {} MB，這個位置只剩約 {} MB，請清出空間後再試", need.div_ceil(MIB), f / MIB)),
        _ => Ok(()),
    }
}

// ---------- 暫存資料夾 ----------

/// 離開時（成功、失敗、提早 return 都一樣）整個刪掉
struct TmpDir(PathBuf);
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn make_tmp(root: &Path) -> Result<TmpDir, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = root.join(format!(".tmp-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&path).map_err(|e| format!("建立暫存資料夾失敗：{e}"))?;
    let guard = TmpDir(path);
    set_private(&guard.0)?;
    Ok(guard)
}

#[cfg(unix)]
fn set_private(p: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("設定暫存資料夾權限失敗：{e}"))
}
#[cfg(not(unix))]
fn set_private(_p: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_exec(p: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("設定執行權限失敗：{e}"))
}
#[cfg(not(unix))]
fn set_exec(_p: &Path) -> Result<(), String> {
    Ok(())
}

/// 上次當掉留下超過一小時的暫存資料夾，順手清掉
fn clean_stale(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        if !name.to_string_lossy().starts_with(".tmp-") {
            continue;
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(3600));
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

// ---------- 核對、解壓、取出 ----------

fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| format!("讀不到下載的檔案：{e}"))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("讀下載的檔案失敗：{e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// 寫入量超過上限就報錯（解壓縮炸彈）；底層寫入失敗（多半是磁碟）另外記下，好分辨是檔案問題還是磁碟問題
struct Capped<W: Write> {
    inner: W,
    left: u64,
    write_failed: bool,
}
impl<W: Write> Write for Capped<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() as u64 > self.left {
            return Err(std::io::Error::other("解開後的大小超過上限"));
        }
        match self.inner.write(buf) {
            Ok(n) => {
                self.left -= n as u64;
                Ok(n)
            }
            Err(e) => {
                self.write_failed = true;
                Err(e)
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// tar 成員路徑（略過開頭的 `./`）是不是我們要的；回存成的檔名。有 `..` 或絕對路徑的一律不要
fn wanted_name(path: &Path) -> Option<&'static str> {
    use std::path::Component;
    let mut parts: Vec<String> = vec![];
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    let joined = parts.join("/");
    WANTED.iter().find(|(p, _)| *p == joined).map(|(_, n)| *n)
}

/// 從 tar 取出要的成員到 `out`。成員必須是一般檔案（連結、裝置檔等一律中止）；個數、單檔、總和都有上限；每個要的成員剛好一個
pub(crate) fn extract_members<R: Read>(reader: R, out: &Path, lim: &Limits) -> Result<(), String> {
    let mut ar = tar::Archive::new(reader);
    let entries = ar.entries().map_err(|e| format!("壓縮檔讀不懂：{e}"))?;
    let mut got: Vec<&'static str> = vec![];
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in entries {
        count += 1;
        if count > lim.max_entries {
            return Err("壓縮檔的成員太多，已中止".into());
        }
        let mut e = entry.map_err(|e| format!("壓縮檔讀不懂：{e}"))?;
        let path = e.path().map_err(|e| format!("壓縮檔裡有看不懂的路徑：{e}"))?.into_owned();
        let Some(name) = wanted_name(&path) else { continue };
        if e.header().entry_type() != tar::EntryType::Regular {
            return Err(format!("壓縮檔裡的 {name} 不是一般檔案，已中止"));
        }
        if got.contains(&name) {
            return Err(format!("壓縮檔裡的 {name} 重複出現，已中止"));
        }
        let size = e.header().size().map_err(|e| format!("壓縮檔讀不懂：{e}"))?;
        if size == 0 || size > lim.max_member {
            return Err(format!("壓縮檔裡的 {name} 大小不合理（{size} 位元組），已中止"));
        }
        total += size;
        if total > lim.max_total {
            return Err("壓縮檔要取的檔案總量太大，已中止".into());
        }
        let dest = out.join(name);
        let mut f = open_new(&dest).map_err(|e| format!("寫入 {name} 失敗：{e}"))?;
        let copied = std::io::copy(&mut e.by_ref().take(lim.max_member + 1), &mut f).map_err(|e| format!("寫入 {name} 失敗：{e}"))?;
        f.flush().map_err(|e| format!("寫入 {name} 失敗：{e}"))?;
        drop(f);
        if copied != size {
            return Err(format!("壓縮檔裡的 {name} 實際大小和標示不符，已中止"));
        }
        set_exec(&dest)?;
        got.push(name);
    }
    for (_, name) in WANTED {
        if !got.contains(&name) {
            return Err(format!("壓縮檔裡找不到 {name}"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn open_new(p: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(p)
}
#[cfg(not(unix))]
fn open_new(p: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(p)
}

// ---------- 能不能跑 ----------

/// 缺的函式庫名最長幾個字元（過長的當作看不懂）
const LIB_NAME_MAX: usize = 40;

/// 只留安全的函式庫名：英數開頭，其餘只准英數與 `. _ + -`，長度有上限。路徑、空白、控制字元等一律不要
pub(crate) fn sanitize_lib_name(raw: &str) -> Option<String> {
    let s = raw.trim();
    let first_ok = s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    let all_ok = s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'));
    (first_ok && all_ok && s.len() <= LIB_NAME_MAX).then(|| s.to_string())
}

/// `error while loading shared libraries: libssl.so.3: cannot open…` → `libssl.so.3`（過濾後）。
/// 顯示原本的 soname 而不換算成套件名：soname 是 stderr 裡真實的字，各發行版的套件名不一樣（libssl.so.3 在 Debian 是 libssl3，
/// libz.so.1 卻是 zlib1g），猜錯會誤導；soname 用套件管理員的「搜尋檔案」功能一定找得到。看不懂回 None
pub(crate) fn parse_missing_lib(stderr: &str) -> Option<String> {
    const KEY: &str = "error while loading shared libraries: ";
    let i = stderr.find(KEY)?;
    sanitize_lib_name(stderr[i + KEY.len()..].split(':').next().unwrap_or(""))
}

/// `--version` 失敗時的 stderr → 一句話（缺函式庫要點名）。這句話只進 log；畫面上的字在前端
pub(crate) fn explain_run_failure(stderr: &str) -> String {
    if let Some(lib) = parse_missing_lib(stderr) {
        return format!("缺少系統函式庫 {lib}，請用套件管理員安裝後再試");
    }
    if stderr.contains("libssl") {
        return "缺少系統函式庫 libssl，請用套件管理員安裝後再試".into();
    }
    format!("取得的終端程式在這台電腦跑不起來，{MANUAL_HINT}")
}

/// 取得後的檢查失敗：`log` 給 log 看（可以帶 stderr 的片段）；`lib` 是過濾過的缺少函式庫名，會帶到設定頁
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CheckFail {
    pub log: String,
    pub lib: Option<String>,
}

impl From<String> for CheckFail {
    fn from(log: String) -> Self {
        CheckFail { log, lib: None }
    }
}

pub(crate) type CheckResult = Result<(), CheckFail>;

/// stderr 的片段（給 log）：換行變空白、最多 300 字元
fn stderr_excerpt(stderr: &str) -> String {
    stderr.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect()
}

/// 兩個程式都跑一次 `--version`（核對雜湊之後才會到這裡）。環境清空、有逾時
pub(crate) fn run_version_check(dir: &Path) -> CheckResult {
    for (_, name) in WANTED {
        let mut child = Command::new(dir.join(name)).no_window().arg("--version").env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| CheckFail::from(format!("取得的終端程式在這台電腦跑不起來（{e}），{MANUAL_HINT}")))?;
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if start.elapsed() < VERSION_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CheckFail::from(format!("取得的終端程式在這台電腦跑不起來（等不到回應），{MANUAL_HINT}")));
                }
            }
        };
        if !status.success() {
            let out = child.wait_with_output().map_err(|e| CheckFail::from(format!("讀不到終端程式的輸出：{e}")))?;
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(CheckFail { log: format!("{name}：{}（輸出：{}）", explain_run_failure(&stderr), stderr_excerpt(&stderr)), lib: parse_missing_lib(&stderr) });
        }
    }
    Ok(())
}

// ---------- 失敗的分類與紀錄 ----------

/// 取得失敗的原因分類。畫面上每一類各有一句給使用者看的話（ui/lib/term-server-setting.mjs）；
/// 網址、雜湊、錯誤碼等細節只進 log（`FetchError::detail`），不出現在畫面上
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailKind {
    /// 連不上、逾時、伺服器回錯
    Network,
    /// 磁碟空間不夠、寫不進去
    Disk,
    /// 下載的檔案大小或雜湊不符、解不開、內容不是預期的
    Mismatch,
    /// 這台 Linux（或處理器）還沒有支援自動取得
    Unsupported,
    /// 取得了，但在這台電腦跑不起來（例如缺系統函式庫）
    Unrunnable,
    /// 其他
    Other,
}

impl FailKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            FailKind::Network => "network",
            FailKind::Disk => "disk",
            FailKind::Mismatch => "mismatch",
            FailKind::Unsupported => "unsupported",
            FailKind::Unrunnable => "unrunnable",
            FailKind::Other => "other",
        }
    }
    pub(crate) fn parse(s: &str) -> FailKind {
        match s {
            "network" => FailKind::Network,
            "disk" => FailKind::Disk,
            "mismatch" => FailKind::Mismatch,
            "unsupported" => FailKind::Unsupported,
            "unrunnable" => FailKind::Unrunnable,
            _ => FailKind::Other,
        }
    }
}

#[derive(Debug)]
pub(crate) struct FetchError {
    pub kind: FailKind,
    /// 給 log 看的細節（可以有網址、路徑）；不顯示在畫面上
    pub detail: String,
    /// 因為退避期間而沒有去取（沒有連網、也不記新的失敗）
    pub skipped: bool,
    /// 跑不起來時缺的系統函式庫名（已過濾，短）；會記進失敗紀錄、顯示在設定頁
    pub lib: Option<String>,
}

impl FetchError {
    fn new(kind: FailKind, detail: impl Into<String>) -> Self {
        FetchError { kind, detail: detail.into(), skipped: false, lib: None }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

const STATE_FILE: &str = "fetch-state.json";
/// 同一次失敗之後，這麼久之內不自動重下；本人按「重試」才忽略
pub(crate) const BACKOFF_MS: u64 = 24 * 3600 * 1000;

#[derive(Debug, Serialize, Deserialize)]
struct FailRecord {
    kind: String,
    at_ms: u64,
    /// 缺少的系統函式庫名（只有「跑不起來」才有）；舊版的紀錄沒有這欄
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lib: Option<String>,
}

fn read_fail(root: &Path) -> Option<(FailKind, u64)> {
    let text = std::fs::read_to_string(root.join(STATE_FILE)).ok()?;
    let r: FailRecord = serde_json::from_str(&text).ok()?;
    Some((FailKind::parse(&r.kind), r.at_ms))
}

/// 紀錄裡的缺少函式庫名（讀出來也再過濾一次，檔案被改壞也不會把怪字帶到畫面）
fn read_fail_lib(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join(STATE_FILE)).ok()?;
    let r: FailRecord = serde_json::from_str(&text).ok()?;
    r.lib.as_deref().and_then(sanitize_lib_name)
}

fn write_fail(root: &Path, kind: FailKind, now_ms: u64) {
    write_fail_with(root, kind, now_ms, None);
}

/// 先寫暫存檔再改名，讀的人不會讀到寫一半的
fn write_fail_with(root: &Path, kind: FailKind, now_ms: u64, lib: Option<&str>) {
    let rec = FailRecord { kind: kind.as_str().to_string(), at_ms: now_ms, lib: lib.and_then(sanitize_lib_name) };
    let Ok(text) = serde_json::to_string(&rec) else { return };
    let tmp = root.join(format!("{STATE_FILE}.tmp"));
    if std::fs::create_dir_all(root).is_ok() && std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, root.join(STATE_FILE));
    }
}

fn clear_fail(root: &Path) {
    let _ = std::fs::remove_file(root.join(STATE_FILE));
}

/// 上次失敗到現在還在退避期間嗎（時鐘被調過、紀錄在很久以後的未來，也當作過期）
pub(crate) fn backoff_active(at_ms: u64, now_ms: u64) -> bool {
    let diff = if now_ms >= at_ms { now_ms - at_ms } else { at_ms - now_ms };
    diff < BACKOFF_MS
}

// ---------- 安裝 ----------

/// 已下載的 tar.xz → 核對大小與雜湊 → 解壓 → 取出兩個檔 → `check` → 原子改名成 `final_dir`。
/// `work` 是呼叫端管理的暫存資料夾（失敗時由它清）；大小或雜湊不符會連 tarball 一起刪掉。
pub(crate) fn install_tarball(tarball: &Path, sha256: &str, size: u64, work: &Path, final_dir: &Path, lim: &Limits, check: &dyn Fn(&Path) -> CheckResult) -> Result<(), FetchError> {
    let disk = |what: &str, e: std::io::Error| FetchError::new(FailKind::Disk, format!("{what}：{e}"));
    let have = std::fs::metadata(tarball).map_err(|e| disk("讀不到下載的檔案", e))?.len();
    if have != size {
        let _ = std::fs::remove_file(tarball);
        // 比預期短＝沒下載完整（算網路）；比預期長＝檔案不是我們要的（算不符）
        let kind = if have < size { FailKind::Network } else { FailKind::Mismatch };
        return Err(FetchError::new(kind, format!("下載的檔案大小不符（預期 {size}，實際 {have}），已刪除，沒有安裝")));
    }
    let got = sha256_file(tarball).map_err(|e| FetchError::new(FailKind::Disk, e))?;
    if !got.eq_ignore_ascii_case(sha256) {
        let _ = std::fs::remove_file(tarball);
        return Err(FetchError::new(FailKind::Mismatch, "下載的檔案和預期的不一樣（雜湊不符），已刪除，沒有安裝"));
    }
    let tar_path = work.join("wezterm.tar");
    {
        let mut input = std::io::BufReader::new(std::fs::File::open(tarball).map_err(|e| disk("讀不到下載的檔案", e))?);
        let file = std::fs::File::create(&tar_path).map_err(|e| disk("寫入暫存檔失敗", e))?;
        let mut out = Capped { inner: std::io::BufWriter::new(file), left: lim.max_tar, write_failed: false };
        if let Err(e) = lzma_rs::xz_decompress(&mut input, &mut out) {
            // 寫暫存檔失敗（多半是空間不夠）算磁碟；其餘（壞檔、超過上限）算檔案不符
            let kind = if out.write_failed { FailKind::Disk } else { FailKind::Mismatch };
            return Err(FetchError::new(kind, format!("解壓縮失敗：{e}")));
        }
        out.flush().map_err(|e| disk("寫入暫存檔失敗", e))?;
    }
    let _ = std::fs::remove_file(tarball);
    let staged = work.join("out");
    std::fs::create_dir(&staged).map_err(|e| disk("建立暫存資料夾失敗", e))?;
    let tar_file = std::fs::File::open(&tar_path).map_err(|e| disk("讀不到暫存檔", e))?;
    extract_members(std::io::BufReader::new(tar_file), &staged, lim).map_err(|e| FetchError::new(FailKind::Mismatch, e))?;
    let _ = std::fs::remove_file(&tar_path);
    check(&staged).map_err(|e| FetchError { lib: e.lib, ..FetchError::new(FailKind::Unrunnable, e.log) })?;
    if let Some(parent) = final_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| disk("建立資料夾失敗", e))?;
    }
    if dir_usable(final_dir) {
        return Ok(()); // 別的程序剛裝好同一份
    }
    std::fs::rename(&staged, final_dir).or_else(|e| if dir_usable(final_dir) { Ok(()) } else { Err(disk("放進正式位置失敗", e)) })
}

/// 兩個檔都在而且不是空的
pub(crate) fn dir_usable(dir: &Path) -> bool {
    WANTED.iter().all(|(_, n)| std::fs::metadata(dir.join(n)).is_ok_and(|m| m.is_file() && m.len() > 0))
}

// ---------- 下載 ----------

/// 下載的介面：正式用 `RealHttp`；測試注入假的，驗證退避期間完全不連網
pub(crate) trait Downloader {
    /// 把 `url` 下載到 `dest`；實收位元組數必須剛好等於 `size`（超過 `max` 或不等都算失敗）
    async fn fetch(&self, url: &str, dest: &Path, max: u64, size: u64) -> Result<(), FetchError>;
}

pub(crate) struct RealHttp;

impl Downloader for RealHttp {
    async fn fetch(&self, url: &str, dest: &Path, max: u64, size: u64) -> Result<(), FetchError> {
        download(url, dest, max, size).await
    }
}

async fn download(url: &str, dest: &Path, max: u64, size: u64) -> Result<(), FetchError> {
    let net = |what: &str, e: reqwest::Error| FetchError::new(FailKind::Network, format!("{what}：{e}"));
    let policy = reqwest::redirect::Policy::custom(|a| {
        if a.previous().len() > 5 {
            return a.error("轉址太多次");
        }
        if a.url().scheme() == "https" && a.url().host_str().is_some_and(allowed_redirect_host) {
            a.follow()
        } else {
            a.stop()
        }
    });
    let client = reqwest::Client::builder().redirect(policy).connect_timeout(CONNECT_TIMEOUT).timeout(TOTAL_TIMEOUT).user_agent("asn").build().map_err(|e| net("無法連線", e))?;
    let mut res = client.get(url).send().await.map_err(|e| net("下載失敗（連不上或逾時）", e))?;
    if !res.status().is_success() {
        return Err(FetchError::new(FailKind::Network, format!("下載失敗：伺服器回 {}", res.status().as_u16())));
    }
    if res.content_length().is_some_and(|n| n > max || n != size) {
        return Err(FetchError::new(FailKind::Mismatch, format!("下載的檔案大小和預期的不一樣（預期 {size}，伺服器說 {:?}），已中止", res.content_length())));
    }
    let disk = |e: std::io::Error| FetchError::new(FailKind::Disk, format!("寫入暫存檔失敗：{e}"));
    let mut file = std::fs::File::create(dest).map_err(disk)?;
    let mut total = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| net("下載中斷", e))? {
        total += chunk.len() as u64;
        if total > max || total > size {
            return Err(FetchError::new(FailKind::Mismatch, "下載的檔案比預期大，已中止"));
        }
        file.write_all(&chunk).map_err(disk)?;
    }
    file.flush().map_err(disk)?;
    if total != size {
        // 連線在中途結束、實收比預期短：算網路。（比預期長的前面就以不符中止了）
        return Err(FetchError::new(FailKind::Network, format!("下載中斷，只收到一部分（預期 {size}，實收 {total}）")));
    }
    Ok(())
}

/// 下載 + 安裝。暫存資料夾在任何結果下都會清掉
async fn fetch_into<H: Downloader>(http: &H, root: &Path, url: &str, pin: &Pin, final_dir: &Path, lim: &Limits, check: &dyn Fn(&Path) -> CheckResult) -> Result<(), FetchError> {
    let tmp = make_tmp(root).map_err(|e| FetchError::new(FailKind::Disk, e))?;
    let tarball = tmp.0.join("download.tar.xz");
    http.fetch(url, &tarball, lim.max_tarball, pin.size).await?;
    install_tarball(&tarball, &pin.sha256, pin.size, &tmp.0, final_dir, lim, check)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 取得（已經有就直接回）。成功回正式位置，裡面有 `wezterm`、`wezterm-mux-server`，並清掉失敗紀錄。
/// 失敗會記下原因分類與時間；`force` 為假時，上次失敗在一天內就不連網（`skipped`）。
/// `base` 是 mux 檔案的上層資料夾（`mux::default_base()`）
pub(crate) async fn ensure_with<H: Downloader>(http: &H, base: &Path, force: bool, now_ms: u64, plan: &Plan<'_>) -> Result<PathBuf, FetchError> {
    let root = base.join("ASN").join("wezterm");
    let result = ensure_inner(http, &root, force, now_ms, plan).await;
    match &result {
        Ok(_) => clear_fail(&root),
        Err(e) if e.skipped => elog!("取得 WezTerm 暫不重試（上次失敗，一天內不自動重下）"),
        Err(e) => {
            elog!("取得 WezTerm 失敗：{}", e.detail);
            write_fail_with(&root, e.kind, now_ms, e.lib.as_deref());
        }
    }
    result
}

async fn ensure_inner<H: Downloader>(http: &H, root: &Path, force: bool, now_ms: u64, plan: &Plan<'_>) -> Result<PathBuf, FetchError> {
    let pins = &plan.pins;
    let key = pin_key(&plan.os, &plan.arch).map_err(|e| FetchError::new(FailKind::Unsupported, e))?;
    let pin = pins.linux.get(key).ok_or_else(|| FetchError::new(FailKind::Other, "內建的 WezTerm 版本資料缺這個發行版"))?;
    let final_dir = root.join(format!("{}-{key}", pins.version));
    if dir_usable(&final_dir) {
        return Ok(final_dir);
    }
    if !force {
        if let Some((kind, at)) = read_fail(root) {
            if backoff_active(at, now_ms) {
                return Err(FetchError { kind, detail: "退避期間".into(), skipped: true, lib: None });
            }
        }
    }
    let url = download_url(&pins.release_base, &pins.version, &pin.tarball).map_err(|e| FetchError::new(FailKind::Other, e))?;
    std::fs::create_dir_all(root).map_err(|e| FetchError::new(FailKind::Disk, format!("建立資料夾失敗：{e}")))?;
    clean_stale(root);
    check_space(free_bytes(root), NEED_FREE).map_err(|e| FetchError::new(FailKind::Disk, e))?;
    elog!("取得 WezTerm 開始：{url}");
    fetch_into(http, root, &url, pin, &final_dir, &plan.lim, plan.check).await?;
    elog!("取得 WezTerm 完成");
    Ok(final_dir)
}

/// 取得時用到的環境：版本資料、發行版、處理器、取得後的檢查、大小上限。正式用 `system_plan()`；測試注入
pub(crate) struct Plan<'a> {
    pub pins: Pins,
    pub os: OsRelease,
    pub arch: String,
    pub check: &'a dyn Fn(&Path) -> CheckResult,
    pub lim: Limits,
}

fn system_plan() -> Result<Plan<'static>, FetchError> {
    let pins = pins().map_err(|e| FetchError::new(FailKind::Other, e))?;
    let os = parse_os_release(&std::fs::read_to_string("/etc/os-release").unwrap_or_default());
    Ok(Plan { pins, os, arch: std::env::consts::ARCH.to_string(), check: &run_version_check, lim: Limits::default() })
}

pub(crate) async fn ensure(base: &Path, force: bool) -> Result<PathBuf, FetchError> {
    let plan = system_plan().inspect_err(|e| elog!("取得 WezTerm 失敗：{}", e.detail))?;
    ensure_with(&RealHttp, base, force, now_ms(), &plan).await
}

/// 這台已經取得過的資料夾（版本相符的）。給 `wezterm::locate` 當第三順位
pub(crate) fn fetched_dirs(base: &Path) -> Vec<PathBuf> {
    let Ok(pins) = pins() else { return vec![] };
    let prefix = format!("{}-", pins.version);
    let Ok(rd) = std::fs::read_dir(base.join("ASN").join("wezterm")) else { return vec![] };
    let mut v: Vec<PathBuf> = rd.flatten().filter(|e| e.file_name().to_string_lossy().starts_with(&prefix)).map(|e| e.path()).filter(|p| dir_usable(p)).collect();
    v.sort();
    v
}

/// 要不要去取：本人開了（或環境變數 `=1`）、環境變數沒有明講關、而且目前找不到
pub(crate) fn should_fetch(user_on: bool, env_wez: Option<&str>, env_mux: Option<&str>, found: bool) -> bool {
    !found && env_wez != Some("0") && env_mux != Some("0") && (user_on || env_mux == Some("1") || env_wez == Some("1"))
}

/// 這台能不能自動取得（發行版與處理器在支援表裡）。設定頁據此決定要不要顯示開關
pub(crate) fn can_fetch() -> bool {
    let os = parse_os_release(&std::fs::read_to_string("/etc/os-release").unwrap_or_default());
    pin_key(&os, std::env::consts::ARCH).is_ok()
}

static IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn is_fetching() -> bool {
    IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst)
}

/// 設定頁要顯示的取得狀態
#[derive(Debug, PartialEq)]
pub(crate) struct FetchStatus {
    /// ""（沒事）／"fetching"／"failed"
    pub state: &'static str,
    /// state 是 "failed" 時的原因分類（`FailKind::as_str`），否則空
    pub kind: &'static str,
    /// 失敗時的短細節（目前只有缺少的系統函式庫名，已過濾）；沒有就空字串
    pub detail: String,
}

pub(crate) fn status(base: &Path) -> FetchStatus {
    let root = base.join("ASN").join("wezterm");
    let mut st = status_from(is_fetching(), read_fail(&root).map(|(k, _)| k), !fetched_dirs(base).is_empty());
    if st.state == "failed" {
        st.detail = read_fail_lib(&root).unwrap_or_default();
    }
    st
}

pub(crate) fn status_from(fetching: bool, failed: Option<FailKind>, have: bool) -> FetchStatus {
    match (fetching, failed, have) {
        (true, _, _) => FetchStatus { state: "fetching", kind: "", detail: String::new() },
        (false, Some(k), false) => FetchStatus { state: "failed", kind: k.as_str(), detail: String::new() },
        _ => FetchStatus { state: "", kind: "", detail: String::new() },
    }
}

/// 背景取得（同時只跑一個）。`force`＝本人按了「重試」，忽略退避。完成後要重開 ASN 才會用上；結果只寫 log 與失敗紀錄
pub(crate) fn spawn_background(force: bool) {
    let Some(base) = super::mux::default_base() else { return };
    if IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("asn-wezterm-fetch".into()).spawn(move || {
        match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => {
                let _ = rt.block_on(ensure(&base, force));
            }
            Err(e) => elog!("取得 WezTerm 失敗：{e}"),
        }
        IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    });
    if let Err(e) = spawned {
        IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
        elog!("取得 WezTerm 的背景工作開不了：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &[u8] = include_bytes!("wezterm_fetch_fixtures/good.tar.xz");
    const BADSYM: &[u8] = include_bytes!("wezterm_fetch_fixtures/badsym.tar.xz");
    /// `xz` 壓的 b"hello"（十六進位）
    const HELLO_XZ_HEX: &str = "fd377a585a0000016922de360200210116000000742fe5a301000468656c6c6f0000000086a6103600011905bce8eccb9042990d010000000001595a";

    fn hello_xz() -> Vec<u8> {
        (0..HELLO_XZ_HEX.len()).step_by(2).map(|i| u8::from_str_radix(&HELLO_XZ_HEX[i..i + 2], 16).unwrap()).collect()
    }

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn ok_check(_: &Path) -> CheckResult {
        Ok(())
    }

    fn lim() -> Limits {
        Limits::default()
    }

    #[test]
    fn pins_讀得懂_版本與探測腳本_windows_腳本一致() {
        let p = pins().unwrap();
        assert_eq!(p.version, "20240203-110809-5046fc22");
        for (k, pin) in &p.linux {
            assert!(pin.sha256.len() == 64 && pin.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{k}");
            assert!(pin.tarball.starts_with(&format!("wezterm-{}.", p.version)) && pin.tarball.ends_with(".tar.xz"), "{k}");
            assert!(pin.size > 1_000_000 && pin.size < 64 * MIB, "{k}");
            assert!(download_url(&p.release_base, &p.version, &pin.tarball).is_ok());
        }
        // 探測腳本（CI）用同一組版本與雜湊，不能漂開
        let probe = include_str!("../../../../../.github/scripts/linux-wezterm-probe.sh");
        let u = &p.linux["ubuntu-22.04"];
        assert!(probe.contains(&format!("WEZTERM_VERSION='{}'", p.version)), "探測腳本的版本要等於 pins");
        assert!(probe.contains(&format!("TAR_SHA256='{}'", u.sha256)), "探測腳本的雜湊要等於 pins");
        assert!(probe.contains("github.com/wezterm/wezterm/releases/download"), "探測腳本也用正式路徑");
        // Windows 的腳本讀同一份（版本、網址都不手抄）
        let mjs = include_str!("../../../scripts/fetch-wezterm.mjs");
        assert!(mjs.contains("wezterm-pins.json") && !mjs.contains(&p.version), "fetch-wezterm.mjs 不能再手抄版本");
        assert!(!mjs.contains("github.com/wez/") && !mjs.contains("githubusercontent.com/wez/"), "網址統一用 wezterm/wezterm，且放在 pins 裡");
        // 全部用官方正式路徑（wez/wezterm 只是轉址）
        assert_eq!(p.release_base, DOWNLOAD_BASE);
    }

    #[test]
    fn 網址只組官方_github_前綴_檔名不合法就拒絕() {
        assert_eq!(download_url(DOWNLOAD_BASE, "v1", "a.tar.xz").unwrap(), "https://github.com/wezterm/wezterm/releases/download/v1/a.tar.xz");
        for bad in ["", "../x", "a/b", "a b", "a?b", "a#b", "a%2f"] {
            assert!(download_url(DOWNLOAD_BASE, "v1", bad).is_err(), "{bad}");
            assert!(download_url(DOWNLOAD_BASE, bad, "a.tar.xz").is_err(), "{bad}");
        }
        // pins 裡的基底網址被改成別處也不行
        assert!(download_url("https://example.com/x", "v1", "a.tar.xz").is_err());
        assert!(download_url("https://github.com/wez/wezterm/releases/download", "v1", "a.tar.xz").is_err());
        for ok in ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"] {
            assert!(allowed_redirect_host(ok), "{ok}");
        }
        for bad in ["evilgithub.com", "github.com.evil.com", "example.com", "githubusercontent.com.evil.io", ""] {
            assert!(!allowed_redirect_host(bad), "{bad}");
        }
    }

    #[test]
    fn os_release_讀_id_版本_名稱_對應表() {
        let t = "# c\nNAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n";
        let o = parse_os_release(t);
        assert_eq!((o.id.as_str(), o.version_id.as_str(), o.pretty.as_str()), ("ubuntu", "24.04", "Ubuntu 24.04.1 LTS"));
        let key = |id: &str, v: &str| pin_key(&OsRelease { id: id.into(), version_id: v.into(), pretty: format!("{id} {v}") }, "x86_64");
        assert_eq!(key("ubuntu", "22.04"), Ok("ubuntu-22.04"));
        assert_eq!(key("ubuntu", "24.04"), Ok("ubuntu-22.04"));
        assert_eq!(key("ubuntu", "20.04"), Ok("ubuntu-20.04"));
        assert_eq!(key("debian", "12"), Ok("debian-12"));
        assert_eq!(key("debian", "11"), Ok("debian-11"));
        assert_eq!(key("debian", "10"), Ok("debian-10"));
        let p = pins().unwrap();
        for k in ["ubuntu-22.04", "ubuntu-20.04", "debian-12", "debian-11", "debian-10"] {
            assert!(p.linux.contains_key(k), "{k}");
        }
        let e = key("fedora", "39").unwrap_err();
        assert!(e.contains("fedora 39") && e.contains("套件管理員") && e.contains("ASN_WEZTERM_DIR"), "{e}");
        assert!(key("ubuntu", "18.04").is_err());
        let e = pin_key(&parse_os_release(""), "x86_64").unwrap_err();
        assert!(e.contains("不明的發行版"), "{e}");
        assert!(pin_key(&OsRelease { id: "ubuntu".into(), version_id: "22.04".into(), pretty: String::new() }, "aarch64").unwrap_err().contains("aarch64"));
    }

    #[test]
    fn 磁碟空間_換算_不夠就擋_查不到放行() {
        assert_eq!(avail_bytes(4096, 512, 1000), 4_096_000);
        assert_eq!(avail_bytes(0, 512, 1000), 512_000, "沒有 frsize 用 bsize");
        assert_eq!(avail_bytes(u64::MAX, 1, 2), u64::MAX, "不溢位");
        assert!(check_space(Some(100 * MIB), NEED_FREE).unwrap_err().contains("磁碟空間不夠"));
        assert!(check_space(Some(NEED_FREE), NEED_FREE).is_ok());
        assert!(check_space(None, NEED_FREE).is_ok());
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn 磁碟空間_statvfs_真的讀得到_不存在的路徑是_none() {
        assert_eq!(std::mem::size_of::<StatVfs>(), 112, "和 glibc／musl 的 struct statvfs 一樣大");
        let d = tempfile::tempdir().unwrap();
        let free = free_bytes(d.path()).expect("暫存資料夾所在的檔案系統查得到");
        assert!(free > 0 && free < (1u64 << 60), "{free}");
        assert_eq!(free_bytes(&d.path().join("不存在")), None);
        assert_eq!(free_bytes(Path::new("/proc/self/不存在")), None);
    }

    #[test]
    fn 要不要去取_只在開了_沒明講關_找不到時() {
        assert!(should_fetch(true, None, None, false));
        assert!(should_fetch(false, None, Some("1"), false), "環境變數明講開");
        assert!(!should_fetch(false, None, None, false), "沒開絕不連網");
        assert!(!should_fetch(true, None, None, true), "找得到就不取");
        assert!(!should_fetch(true, None, Some("0"), false));
        assert!(!should_fetch(true, Some("0"), None, false));
    }

    #[test]
    fn 失敗原因_缺函式庫點名() {
        let e = explain_run_failure("./wezterm: error while loading shared libraries: libssl.so.1.1: cannot open shared object file: No such file or directory");
        assert!(e.contains("libssl.so.1.1") && e.contains("套件管理員"), "{e}");
        assert!(explain_run_failure("libssl.so.3 not found").contains("libssl"));
        assert!(explain_run_failure("boom").contains("跑不起來"));
    }

    #[test]
    fn xz_解壓縮_有大小上限() {
        let mut out = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(hello_xz()), &mut Capped { inner: &mut out, left: 5, write_failed: false }).unwrap();
        assert_eq!(out, b"hello");
        let mut out = Vec::new();
        let e = lzma_rs::xz_decompress(&mut std::io::Cursor::new(hello_xz()), &mut Capped { inner: &mut out, left: 4, write_failed: false }).unwrap_err();
        assert!(e.to_string().contains("上限"), "{e}");
    }

    #[test]
    fn 取出成員_只收兩個一般檔案_略過其他_連結被略過() {
        let d = tempfile::tempdir().unwrap();
        let mut raw = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(GOOD), &mut raw).unwrap();
        extract_members(std::io::Cursor::new(raw), d.path(), &lim()).unwrap();
        assert!(dir_usable(d.path()));
        let mut names: Vec<String> = std::fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["wezterm", "wezterm-mux-server"], "不取 gui、不取連結");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.path().join("wezterm")).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn 取出成員_要的成員是連結_缺成員_超過上限都中止() {
        let mut raw = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(BADSYM), &mut raw).unwrap();
        let d = tempfile::tempdir().unwrap();
        let e = extract_members(std::io::Cursor::new(&raw), d.path(), &lim()).unwrap_err();
        assert!(e.contains("不是一般檔案"), "{e}");
        let mut good = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(GOOD), &mut good).unwrap();
        let tiny = Limits { max_member: 8, ..lim() };
        assert!(extract_members(std::io::Cursor::new(&good), tempfile::tempdir().unwrap().path(), &tiny).unwrap_err().contains("大小不合理"));
        let few = Limits { max_entries: 2, ..lim() };
        assert!(extract_members(std::io::Cursor::new(&good), tempfile::tempdir().unwrap().path(), &few).unwrap_err().contains("成員太多"));
        let total = Limits { max_total: 30, ..lim() };
        assert!(extract_members(std::io::Cursor::new(&good), tempfile::tempdir().unwrap().path(), &total).unwrap_err().contains("總量"));
        // 只有一個要的成員 → 缺另一個
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_size(1);
        h.set_cksum();
        b.append_data(&mut h, "wezterm/usr/bin/wezterm", &b"x"[..]).unwrap();
        let e = extract_members(std::io::Cursor::new(b.into_inner().unwrap()), tempfile::tempdir().unwrap().path(), &lim()).unwrap_err();
        assert!(e.contains("找不到 wezterm-mux-server"), "{e}");
        // 路徑穿越不算要的成員
        assert_eq!(wanted_name(Path::new("./wezterm/usr/bin/wezterm")), Some("wezterm"));
        assert_eq!(wanted_name(Path::new("../wezterm/usr/bin/wezterm")), None);
        assert_eq!(wanted_name(Path::new("/wezterm/usr/bin/wezterm")), None);
        assert_eq!(wanted_name(Path::new("wezterm/usr/bin/wezterm-gui")), None);
    }

    #[test]
    fn 安裝_大小與雜湊都對_全程成功_暫存放進正式位置() {
        let root = tempfile::tempdir().unwrap();
        let tmp = make_tmp(root.path()).unwrap();
        let tarball = tmp.0.join("download.tar.xz");
        std::fs::write(&tarball, GOOD).unwrap();
        let fin = root.path().join("v-key");
        install_tarball(&tarball, &hex(GOOD), GOOD.len() as u64, &tmp.0, &fin, &lim(), &ok_check).unwrap();
        assert!(dir_usable(&fin));
        drop(tmp);
        let left: Vec<String> = std::fs::read_dir(root.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["v-key"], "暫存資料夾清掉了");
    }

    #[test]
    fn 安裝_大小不符_當失敗_刪檔_什麼都不執行() {
        let root = tempfile::tempdir().unwrap();
        let fin = root.path().join("v-key");
        {
            let tmp = make_tmp(root.path()).unwrap();
            let tarball = tmp.0.join("download.tar.xz");
            std::fs::write(&tarball, GOOD).unwrap();
            // 雜湊是對的，只有大小不符：也要失敗（和雜湊不符同樣處理）。實際比預期長＝檔案不是我們要的
            let e = install_tarball(&tarball, &hex(GOOD), GOOD.len() as u64 - 1, &tmp.0, &fin, &lim(), &|_: &Path| panic!("大小不符不可以執行任何東西")).unwrap_err();
            assert_eq!(e.kind, FailKind::Mismatch, "大小超過算檔案不符");
            assert!(e.detail.contains("大小不符"), "{}", e.detail);
            assert!(!tarball.exists(), "刪掉下載的檔");
        }
        assert!(!fin.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "暫存資料夾清掉了");
    }

    #[test]
    fn 安裝_雜湊不符_刪檔報錯_什麼都沒裝_暫存清乾淨() {
        let root = tempfile::tempdir().unwrap();
        let fin = root.path().join("v-key");
        {
            let tmp = make_tmp(root.path()).unwrap();
            let tarball = tmp.0.join("download.tar.xz");
            std::fs::write(&tarball, GOOD).unwrap();
            let e = install_tarball(&tarball, &"0".repeat(64), GOOD.len() as u64, &tmp.0, &fin, &lim(), &|_: &Path| panic!("雜湊不符不可以執行任何東西")).unwrap_err();
            assert_eq!(e.kind, FailKind::Mismatch);
            assert!(e.detail.contains("雜湊不符"), "{}", e.detail);
            assert!(!tarball.exists(), "刪掉下載的檔");
        }
        assert!(!fin.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "暫存資料夾清掉了");
    }

    #[test]
    fn 安裝_解壓縮壞掉_檢查失敗_都不留東西_分類正確() {
        let root = tempfile::tempdir().unwrap();
        let fin = root.path().join("v-key");
        let junk = b"not an xz file at all, but with a known hash".to_vec();
        {
            let tmp = make_tmp(root.path()).unwrap();
            let tarball = tmp.0.join("download.tar.xz");
            std::fs::write(&tarball, &junk).unwrap();
            let e = install_tarball(&tarball, &hex(&junk), junk.len() as u64, &tmp.0, &fin, &lim(), &ok_check).unwrap_err();
            assert_eq!(e.kind, FailKind::Mismatch);
            assert!(e.detail.contains("解壓縮失敗"), "{}", e.detail);
        }
        {
            let tmp = make_tmp(root.path()).unwrap();
            let tarball = tmp.0.join("download.tar.xz");
            std::fs::write(&tarball, GOOD).unwrap();
            let e = install_tarball(&tarball, &hex(GOOD), GOOD.len() as u64, &tmp.0, &fin, &lim(), &|_: &Path| Err("缺少系統函式庫 libssl.so.3，請用套件管理員安裝後再試".to_string().into())).unwrap_err();
            assert_eq!(e.kind, FailKind::Unrunnable);
            assert!(e.detail.contains("libssl"), "{}", e.detail);
        }
        assert!(!fin.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "暫存資料夾清掉了");
    }

    #[tokio::test]
    async fn 下載失敗_連不上_暫存資料夾也清掉_分類是網路() {
        let root = tempfile::tempdir().unwrap();
        let fin = root.path().join("v-key");
        let pin = Pin { tarball: "x.tar.xz".into(), sha256: "0".repeat(64), size: 10 };
        let e = fetch_into(&RealHttp, root.path(), "https://127.0.0.1:1/x.tar.xz", &pin, &fin, &lim(), &ok_check).await.unwrap_err();
        assert_eq!(e.kind, FailKind::Network);
        assert!(e.detail.contains("下載失敗"), "{}", e.detail);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "暫存資料夾清掉了");
    }

    #[test]
    fn 過期的暫存資料夾被清_新的不動() {
        let root = tempfile::tempdir().unwrap();
        let fresh = root.path().join(".tmp-1-1");
        std::fs::create_dir(&fresh).unwrap();
        clean_stale(root.path());
        assert!(fresh.exists(), "剛建的不能清（可能有人正在下載）");
    }

    // ---------- 失敗紀錄與退避 ----------

    /// 假的下載：數被呼叫幾次；成功時寫入 GOOD
    struct FakeHttp {
        calls: std::cell::Cell<usize>,
        fail: Option<(FailKind, &'static str)>,
    }
    impl FakeHttp {
        fn ok() -> Self {
            FakeHttp { calls: std::cell::Cell::new(0), fail: None }
        }
        fn failing(kind: FailKind) -> Self {
            FakeHttp { calls: std::cell::Cell::new(0), fail: Some((kind, "假的失敗（含 https://example.invalid/x 與錯誤碼 7）")) }
        }
    }
    impl Downloader for FakeHttp {
        async fn fetch(&self, _url: &str, dest: &Path, _max: u64, _size: u64) -> Result<(), FetchError> {
            self.calls.set(self.calls.get() + 1);
            match self.fail {
                Some((k, d)) => Err(FetchError::new(k, d)),
                None => {
                    std::fs::write(dest, GOOD).unwrap();
                    Ok(())
                }
            }
        }
    }

    const NOW: u64 = 1_800_000_000_000;
    const HOUR: u64 = 3_600_000;

    fn plan(os_id: &str, os_ver: &str, check: &'static dyn Fn(&Path) -> CheckResult) -> Plan<'static> {
        let mut linux = BTreeMap::new();
        linux.insert("ubuntu-22.04".to_string(), Pin { tarball: "wezterm-v1.Ubuntu22.04.tar.xz".into(), sha256: hex(GOOD), size: GOOD.len() as u64 });
        let pins = Pins { version: "v1".into(), release_base: DOWNLOAD_BASE.into(), linux };
        Plan { pins, os: OsRelease { id: os_id.into(), version_id: os_ver.into(), pretty: format!("{os_id} {os_ver}") }, arch: "x86_64".into(), check, lim: lim() }
    }

    fn ubuntu() -> Plan<'static> {
        plan("ubuntu", "22.04", &ok_check)
    }

    fn root_of(base: &Path) -> PathBuf {
        base.join("ASN").join("wezterm")
    }

    #[test]
    fn 失敗紀錄_讀寫清除_看不懂的當沒有() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_fail(d.path()), None);
        write_fail(d.path(), FailKind::Disk, 123);
        assert_eq!(read_fail(d.path()), Some((FailKind::Disk, 123)));
        std::fs::write(d.path().join(STATE_FILE), "壞的").unwrap();
        assert_eq!(read_fail(d.path()), None);
        write_fail(d.path(), FailKind::Network, 5);
        clear_fail(d.path());
        assert_eq!(read_fail(d.path()), None);
        for k in [FailKind::Network, FailKind::Disk, FailKind::Mismatch, FailKind::Unsupported, FailKind::Unrunnable, FailKind::Other] {
            assert_eq!(FailKind::parse(k.as_str()), k);
        }
        assert_eq!(FailKind::parse("不認得"), FailKind::Other);
    }

    #[test]
    fn 退避時間_一天內算在退避_剛好一天就過期_時鐘被調過也會過期() {
        assert!(backoff_active(NOW, NOW));
        assert!(backoff_active(NOW - 23 * HOUR, NOW));
        assert!(!backoff_active(NOW - 24 * HOUR, NOW));
        assert!(!backoff_active(NOW - 48 * HOUR, NOW));
        assert!(backoff_active(NOW + HOUR, NOW), "紀錄在不久的未來：保守當作還在退避");
        assert!(!backoff_active(NOW + 48 * HOUR, NOW), "紀錄在很久以後的未來：時鐘被調過，不能永遠不重下");
    }

    #[tokio::test]
    async fn 退避期間不連網_完全沒有呼叫下載() {
        let base = tempfile::tempdir().unwrap();
        let root = root_of(base.path());
        write_fail(&root, FailKind::Network, NOW - HOUR);
        let http = FakeHttp::ok();
        let e = ensure_with(&http, base.path(), false, NOW, &ubuntu()).await.unwrap_err();
        assert!(e.skipped && e.kind == FailKind::Network, "{e:?}");
        assert_eq!(http.calls.get(), 0, "退避期間不能呼叫下載");
        assert_eq!(read_fail(&root), Some((FailKind::Network, NOW - HOUR)), "沒有連網，就不更新紀錄");
        assert!(!root.join(".tmp-0").exists() && std::fs::read_dir(&root).unwrap().flatten().all(|e| e.file_name() == STATE_FILE), "也沒有建暫存資料夾");
    }

    #[tokio::test]
    async fn 退避過了一天_會再去取() {
        let base = tempfile::tempdir().unwrap();
        write_fail(&root_of(base.path()), FailKind::Network, NOW - 25 * HOUR);
        let http = FakeHttp::ok();
        let dir = ensure_with(&http, base.path(), false, NOW, &ubuntu()).await.unwrap();
        assert_eq!(http.calls.get(), 1);
        assert!(dir_usable(&dir));
    }

    #[tokio::test]
    async fn 按重試_忽略退避馬上連網() {
        let base = tempfile::tempdir().unwrap();
        let root = root_of(base.path());
        write_fail(&root, FailKind::Disk, NOW - HOUR);
        let http = FakeHttp::ok();
        let dir = ensure_with(&http, base.path(), true, NOW, &ubuntu()).await.unwrap();
        assert_eq!(http.calls.get(), 1, "force＝重試：退避期間也連網");
        assert!(dir_usable(&dir));
    }

    #[tokio::test]
    async fn 失敗會記下分類與時間_之後一天內不再連網_重試才再連() {
        let base = tempfile::tempdir().unwrap();
        let root = root_of(base.path());
        let http = FakeHttp::failing(FailKind::Network);
        let e = ensure_with(&http, base.path(), false, NOW, &ubuntu()).await.unwrap_err();
        assert!(!e.skipped && e.kind == FailKind::Network);
        assert_eq!(http.calls.get(), 1);
        assert_eq!(read_fail(&root), Some((FailKind::Network, NOW)), "記下分類與時間");
        // 一天內自動再試：不連網
        let e = ensure_with(&http, base.path(), false, NOW + 2 * HOUR, &ubuntu()).await.unwrap_err();
        assert!(e.skipped);
        assert_eq!(http.calls.get(), 1, "退避期間沒有再連網");
        // 本人按重試：連網（這次還是失敗，紀錄更新成新的時間）
        let e = ensure_with(&http, base.path(), true, NOW + 3 * HOUR, &ubuntu()).await.unwrap_err();
        assert!(!e.skipped);
        assert_eq!(http.calls.get(), 2);
        assert_eq!(read_fail(&root), Some((FailKind::Network, NOW + 3 * HOUR)));
        // 滿一天之後自動再試
        let _ = ensure_with(&http, base.path(), false, NOW + 3 * HOUR + 25 * HOUR, &ubuntu()).await;
        assert_eq!(http.calls.get(), 3);
    }

    #[tokio::test]
    async fn 各種原因都記得下來_不支援的發行版也一樣不連網() {
        // 下載階段的磁碟問題、檔案不符
        for kind in [FailKind::Disk, FailKind::Mismatch, FailKind::Other] {
            let base = tempfile::tempdir().unwrap();
            let http = FakeHttp::failing(kind);
            ensure_with(&http, base.path(), false, NOW, &ubuntu()).await.unwrap_err();
            assert_eq!(read_fail(&root_of(base.path())), Some((kind, NOW)));
        }
        // 取得後跑不起來
        let base = tempfile::tempdir().unwrap();
        static BAD_CHECK: fn(&Path) -> CheckResult = |_| Err(CheckFail { log: "缺少系統函式庫 libssl.so.3（stderr 片段）".to_string(), lib: Some("libssl.so.3".to_string()) });
        let http = FakeHttp::ok();
        let e = ensure_with(&http, base.path(), false, NOW, &plan("ubuntu", "22.04", &BAD_CHECK)).await.unwrap_err();
        assert_eq!(e.kind, FailKind::Unrunnable);
        assert_eq!(read_fail(&root_of(base.path())), Some((FailKind::Unrunnable, NOW)));
        assert!(!root_of(base.path()).join("v1-ubuntu-22.04").exists(), "跑不起來的不留在正式位置");
        // 不支援的發行版：不連網
        let base = tempfile::tempdir().unwrap();
        let http = FakeHttp::ok();
        let e = ensure_with(&http, base.path(), false, NOW, &plan("fedora", "39", &ok_check)).await.unwrap_err();
        assert_eq!(e.kind, FailKind::Unsupported);
        assert_eq!(http.calls.get(), 0);
        assert_eq!(read_fail(&root_of(base.path())), Some((FailKind::Unsupported, NOW)));
    }

    #[tokio::test]
    async fn 成功會清掉失敗紀錄() {
        let base = tempfile::tempdir().unwrap();
        let root = root_of(base.path());
        write_fail(&root, FailKind::Network, NOW - 30 * HOUR);
        let http = FakeHttp::ok();
        ensure_with(&http, base.path(), false, NOW, &ubuntu()).await.unwrap();
        assert_eq!(read_fail(&root), None, "取得成功：失敗紀錄清掉");
        // 已經取得過：直接沿用，也不留舊的失敗紀錄，而且不連網
        write_fail(&root, FailKind::Disk, NOW);
        let http2 = FakeHttp::ok();
        ensure_with(&http2, base.path(), false, NOW + HOUR, &ubuntu()).await.unwrap();
        assert_eq!(http2.calls.get(), 0);
        assert_eq!(read_fail(&root), None);
    }

    #[test]
    fn 設定頁狀態_取得中_失敗_沒事() {
        let st = |state: &'static str, kind: &'static str| FetchStatus { state, kind, detail: String::new() };
        assert_eq!(status_from(true, Some(FailKind::Disk), false), st("fetching", ""));
        assert_eq!(status_from(false, Some(FailKind::Disk), false), st("failed", "disk"));
        assert_eq!(status_from(false, Some(FailKind::Network), true), st("", ""), "已經有可用的：不顯示舊的失敗");
        assert_eq!(status_from(false, None, false), st("", ""));
    }

    #[test]
    fn 安裝_實際比預期短_算網路_不是檔案不符() {
        let root = tempfile::tempdir().unwrap();
        let tmp = make_tmp(root.path()).unwrap();
        let tarball = tmp.0.join("download.tar.xz");
        std::fs::write(&tarball, GOOD).unwrap();
        let e = install_tarball(&tarball, &hex(GOOD), GOOD.len() as u64 + 1, &tmp.0, &root.path().join("v-key"), &lim(), &|_: &Path| panic!("不完整不可以執行任何東西")).unwrap_err();
        assert_eq!(e.kind, FailKind::Network, "沒下載完整：網路");
        assert!(!tarball.exists());
    }

    #[test]
    fn 大小對但雜湊錯_算檔案不符() {
        let root = tempfile::tempdir().unwrap();
        let tmp = make_tmp(root.path()).unwrap();
        let tarball = tmp.0.join("download.tar.xz");
        std::fs::write(&tarball, GOOD).unwrap();
        let e = install_tarball(&tarball, &"f".repeat(64), GOOD.len() as u64, &tmp.0, &root.path().join("v-key"), &lim(), &ok_check).unwrap_err();
        assert_eq!(e.kind, FailKind::Mismatch);
    }

    /// 本機假伺服器：照 `script` 回一段原始 HTTP 回應就關線。回網址
    fn serve_once(script: Vec<u8>) -> String {
        use std::io::Read as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = c.read(&mut buf);
                let _ = c.write_all(&script);
                let _ = c.flush();
            }
        });
        format!("http://127.0.0.1:{port}/x.tar.xz")
    }

    fn http_ok(headers: &str, body: &[u8]) -> Vec<u8> {
        let mut v = format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n").into_bytes();
        v.extend_from_slice(body);
        v
    }

    #[tokio::test]
    async fn 下載_連線中途斷掉_長度不足_算網路() {
        let d = tempfile::tempdir().unwrap();
        // 說有 100 位元組，只送 40 就關線
        let url = serve_once(http_ok("Content-Length: 100\r\n", &[7u8; 40]));
        let e = download(&url, &d.path().join("a"), MIB, 100).await.unwrap_err();
        assert_eq!(e.kind, FailKind::Network, "{}", e.detail);
        // 分段傳輸（沒有 Content-Length）正常結束，但實收只有 30，比預期的 40 短
        let mut chunked = b"1e\r\n".to_vec();
        chunked.extend([7u8; 30]);
        chunked.extend(b"\r\n0\r\n\r\n");
        let url = serve_once(http_ok("Transfer-Encoding: chunked\r\n", &chunked));
        let e = download(&url, &d.path().join("b"), MIB, 40).await.unwrap_err();
        assert_eq!(e.kind, FailKind::Network, "實收比預期短：{}", e.detail);
        assert!(e.detail.contains("下載中斷"), "{}", e.detail);
    }

    #[tokio::test]
    async fn 下載_伺服器宣告的長度不對_或實收超過預期_算檔案不符() {
        let d = tempfile::tempdir().unwrap();
        // 伺服器說 50，預期 40：宣告就不對，還沒下載就中止
        let url = serve_once(http_ok("Content-Length: 50\r\n", &[7u8; 50]));
        let e = download(&url, &d.path().join("a"), MIB, 40).await.unwrap_err();
        assert_eq!(e.kind, FailKind::Mismatch, "{}", e.detail);
        // 沒宣告長度（分段傳輸），實收 60 超過預期 40
        let url = serve_once(http_ok("Transfer-Encoding: chunked\r\n", format!("3c\r\n{}\r\n0\r\n\r\n", "x".repeat(60)).as_bytes()));
        let e = download(&url, &d.path().join("b"), MIB, 40).await.unwrap_err();
        assert_eq!(e.kind, FailKind::Mismatch, "實收比預期長：{}", e.detail);
        // 長度剛好：成功，內容完整
        let url = serve_once(http_ok("Content-Length: 40\r\n", &[9u8; 40]));
        download(&url, &d.path().join("c"), MIB, 40).await.unwrap();
        assert_eq!(std::fs::read(d.path().join("c")).unwrap(), vec![9u8; 40]);
    }

    #[test]
    fn 缺少的函式庫名_從_stderr_解析_過濾_只留安全字元() {
        let e = "/x/wezterm: error while loading shared libraries: libssl.so.3: cannot open shared object file: No such file or directory";
        assert_eq!(parse_missing_lib(e), Some("libssl.so.3".to_string()));
        assert_eq!(parse_missing_lib("error while loading shared libraries: libz.so.1: cannot open"), Some("libz.so.1".to_string()));
        assert_eq!(parse_missing_lib("error while loading shared libraries: libstdc++.so.6: x"), Some("libstdc++.so.6".to_string()));
        assert_eq!(parse_missing_lib("boom"), None, "看不懂就沒有");
        // 怪字元、路徑、空白、控制字元、太長：全部不要
        for bad in ["/usr/lib/libssl.so.3", "libssl.so.3 && rm -rf", "lib<script>.so", "lib\nssl", "../libssl.so.3", "", " ", "-libssl", ".so", "libé.so.1"] {
            assert_eq!(sanitize_lib_name(bad), None, "{bad:?}");
            assert_eq!(parse_missing_lib(&format!("error while loading shared libraries: {bad}: x")), None, "{bad:?}");
        }
        assert_eq!(sanitize_lib_name(&format!("lib{}.so.1", "a".repeat(LIB_NAME_MAX))), None, "太長");
        assert_eq!(sanitize_lib_name(&format!("l{}", "a".repeat(LIB_NAME_MAX - 1))), Some(format!("l{}", "a".repeat(LIB_NAME_MAX - 1))), "剛好上限");
        // 解析不出名字：維持原本那句
        assert!(explain_run_failure("boom").contains("跑不起來"));
        assert!(explain_run_failure("error while loading shared libraries: /bad path: x").contains("跑不起來"));
    }

    #[tokio::test]
    async fn 缺函式庫的名稱會記進失敗紀錄_帶到狀態_stderr_原文不進狀態() {
        let base = tempfile::tempdir().unwrap();
        let root = root_of(base.path());
        static BAD_CHECK: fn(&Path) -> CheckResult = |_| Err(CheckFail { log: "wezterm：缺少系統函式庫 libssl.so.3（輸出：/secret/path/wezterm: error while loading…）".to_string(), lib: Some("libssl.so.3".to_string()) });
        let http = FakeHttp::ok();
        let e = ensure_with(&http, base.path(), false, NOW, &plan("ubuntu", "22.04", &BAD_CHECK)).await.unwrap_err();
        assert_eq!((e.kind, e.lib.as_deref()), (FailKind::Unrunnable, Some("libssl.so.3")));
        assert!(e.detail.contains("/secret/path"), "原文只在 log 的細節裡");
        assert_eq!(read_fail_lib(&root), Some("libssl.so.3".to_string()));
        let record = std::fs::read_to_string(root.join(STATE_FILE)).unwrap();
        assert!(!record.contains("secret"), "紀錄檔不存 stderr 原文：{record}");
        // 檔案被改壞：讀出來再過濾，怪字不會帶到畫面
        std::fs::write(root.join(STATE_FILE), r#"{"kind":"unrunnable","at_ms":1,"lib":"x; rm -rf /"}"#).unwrap();
        assert_eq!(read_fail_lib(&root), None);
        assert_eq!(read_fail(&root), Some((FailKind::Unrunnable, 1)));
        // 舊版沒有 lib 欄的紀錄照讀
        std::fs::write(root.join(STATE_FILE), r#"{"kind":"disk","at_ms":2}"#).unwrap();
        assert_eq!(read_fail(&root), Some((FailKind::Disk, 2)));
        assert_eq!(read_fail_lib(&root), None);
        // 成功就清掉（含 lib）
        write_fail_with(&root, FailKind::Unrunnable, NOW, Some("libssl.so.3"));
        let ok = ensure_with(&FakeHttp::ok(), base.path(), true, NOW, &ubuntu()).await;
        assert!(ok.is_ok());
        assert_eq!(read_fail_lib(&root), None);
    }

    /// 真的連 GitHub 取得固定版本（要網路，預設不跑；CI 的 headless-test 明跑）：
    /// 空的資料夾 → ensure → 兩個檔都在 → 再呼叫一次直接沿用 → locate 找得到（ASN_WEZTERM_DIR 沒設、PATH 沒有 wezterm）。
    /// `XDG_DATA_HOME` 由呼叫端指定好（CI 後面的步驟要用同一個位置）
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore]
    async fn linux_real_fetch_wezterm() {
        let base = PathBuf::from(std::env::var_os("XDG_DATA_HOME").expect("要設 XDG_DATA_HOME 指到空的資料夾"));
        assert!(fetched_dirs(&base).is_empty(), "要從空的開始");
        let dir = ensure(&base, false).await.expect("取得 WezTerm");
        assert!(dir_usable(&dir), "{dir:?}");
        assert_eq!(read_fail(&base.join("ASN").join("wezterm")), None, "成功沒有失敗紀錄");
        assert_eq!(ensure(&base, false).await.unwrap(), dir, "第二次直接沿用");
        let found = super::super::wezterm::locate(&super::super::wezterm::RealFs).expect("locate 要找得到取得的");
        assert!(found.cli.starts_with(&base), "{:?}", found.cli);
        assert_eq!(found.gui, None, "沒有桌面版");
        for name in ["wezterm", "wezterm-mux-server"] {
            let o = std::process::Command::new(dir.join(name)).no_window().arg("--version").env_clear().output().expect("跑 --version");
            assert!(o.status.success(), "{name} --version 失敗");
            println!("--version {name}：{}", String::from_utf8_lossy(&o.stdout).trim());
        }
        println!("取得完成：{}", dir.display());
    }
}
