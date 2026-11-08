//! Linux：按需取得 WezTerm（#893 第 3 張）。無畫面主機沒有 Windows 那樣的安裝檔可以附帶，本人又未必裝了 wezterm，
//! 所以在「開了夥伴共用終端服務、卻找不到 wezterm」時，從官方 GitHub release 下載固定版本的 tar.xz 到使用者資料夾。
//!
//! 版本與雜湊的唯一來源是 `scripts/wezterm-pins.json`（編譯時讀入；Windows 的 fetch-wezterm.mjs 與 CI 探測腳本也讀同一份）。
//! 流程：判斷發行版 → 檢查磁碟空間 → 下載到私有暫存資料夾（有大小上限與逾時，只跟官方 GitHub 主機往來）→ **核對 SHA-256**
//! → 解 xz（有大小上限）→ 只取兩個固定成員（一般檔案）→ 跑 `--version` 確認能執行 → 原子改名到正式位置。
//! 任何一步失敗都清掉暫存資料夾，不自動重試。優先順序見 `wezterm::locate`：ASN_WEZTERM_DIR → PATH → 這裡取得的。
#![cfg(desktop)]

use crate::nowin::NoWindow;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PINS_JSON: &str = include_str!("../../../scripts/wezterm-pins.json");
/// 只往這個前綴下載（網址由 pins 組出，不接受環境變數覆寫）
pub(crate) const DOWNLOAD_PREFIX: &str = "https://github.com/wezterm/wezterm/releases/download/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const MIB: u64 = 1024 * 1024;
/// 開始前至少要有這麼多可用空間（下載 + 解開的 tar + 取出的兩個檔，留餘裕）
const NEED_FREE: u64 = 512 * MIB;
/// 要取的成員（tar 裡的路徑 → 存成的檔名）。其餘成員一律略過，不展開
const WANTED: [(&str, &str); 2] = [("wezterm/usr/bin/wezterm", "wezterm"), ("wezterm/usr/bin/wezterm-mux-server", "wezterm-mux-server")];

#[derive(Debug, Deserialize)]
struct Pins {
    version: String,
    linux: BTreeMap<String, Pin>,
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
pub(crate) fn download_url(version: &str, tarball: &str) -> Result<String, String> {
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok(version) || !ok(tarball) {
        return Err("內建的 WezTerm 版本資料不合法".into());
    }
    Ok(format!("{DOWNLOAD_PREFIX}{version}/{tarball}"))
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

/// 該資料夾所在檔案系統的可用位元組；查不到回 None。直接呼叫 libc 的 statvfs（和 wezterm.rs 呼叫 setsid 同樣的寫法，不新增相依、
/// 不跑外部指令）。只在 64 位元 Linux 做：那裡 glibc 與 musl 的 struct statvfs 前 11 個欄位都是 8 位元組，
/// 這裡用一塊 128 位元組（比實際的 112 大）的緩衝區，只按位置讀要的欄位（1＝f_frsize、0＝f_bsize、4＝f_bavail），不宣告整個結構
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    extern "C" {
        fn statvfs(path: *const std::os::raw::c_char, buf: *mut u64) -> i32;
    }
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut buf = [0u64; 16];
    // SAFETY: path 是以 NUL 結尾的 C 字串；buf 比 struct statvfs 大，statvfs 只會寫進它
    let rc = unsafe { statvfs(path.as_ptr(), buf.as_mut_ptr()) };
    (rc == 0).then(|| avail_bytes(buf[1], buf[0], buf[4]))
}
#[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
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

/// 寫入量超過上限就報錯（解壓縮炸彈）
struct Capped<W: Write> {
    inner: W,
    left: u64,
}
impl<W: Write> Write for Capped<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() as u64 > self.left {
            return Err(std::io::Error::other("解開後的大小超過上限"));
        }
        self.left -= buf.len() as u64;
        self.inner.write(buf)
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

/// `--version` 失敗時的 stderr → 使用者看得懂的話（缺函式庫要點名）
pub(crate) fn explain_run_failure(stderr: &str) -> String {
    const KEY: &str = "error while loading shared libraries: ";
    if let Some(i) = stderr.find(KEY) {
        let lib = stderr[i + KEY.len()..].split(':').next().unwrap_or("").trim();
        if !lib.is_empty() {
            return format!("缺少系統函式庫 {lib}，請用套件管理員安裝後再試");
        }
    }
    if stderr.contains("libssl") {
        return "缺少系統函式庫 libssl，請用套件管理員安裝後再試".into();
    }
    format!("取得的終端程式在這台電腦跑不起來，{MANUAL_HINT}")
}

/// 兩個程式都跑一次 `--version`（核對雜湊之後才會到這裡）。環境清空、有逾時
pub(crate) fn run_version_check(dir: &Path) -> Result<(), String> {
    for (_, name) in WANTED {
        let mut child = Command::new(dir.join(name)).no_window().arg("--version").env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|_| format!("取得的終端程式在這台電腦跑不起來，{MANUAL_HINT}"))?;
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if start.elapsed() < VERSION_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("取得的終端程式在這台電腦跑不起來（等不到回應），{MANUAL_HINT}"));
                }
            }
        };
        if !status.success() {
            let out = child.wait_with_output().map_err(|e| format!("讀不到終端程式的輸出：{e}"))?;
            return Err(explain_run_failure(&String::from_utf8_lossy(&out.stderr)));
        }
    }
    Ok(())
}

// ---------- 安裝 ----------

/// 已下載的 tar.xz → 核對雜湊 → 解壓 → 取出兩個檔 → `check` → 原子改名成 `final_dir`。
/// `work` 是呼叫端管理的暫存資料夾（失敗時由它清）；雜湊不符會連 tarball 一起刪掉。
pub(crate) fn install_tarball(tarball: &Path, sha256: &str, work: &Path, final_dir: &Path, lim: &Limits, check: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let got = sha256_file(tarball)?;
    if !got.eq_ignore_ascii_case(sha256) {
        let _ = std::fs::remove_file(tarball);
        return Err("下載的檔案和預期的不一樣（雜湊不符），已刪除，沒有安裝".into());
    }
    let tar_path = work.join("wezterm.tar");
    {
        let mut input = std::io::BufReader::new(std::fs::File::open(tarball).map_err(|e| format!("讀不到下載的檔案：{e}"))?);
        let file = std::fs::File::create(&tar_path).map_err(|e| format!("寫入暫存檔失敗：{e}"))?;
        let mut out = Capped { inner: std::io::BufWriter::new(file), left: lim.max_tar };
        lzma_rs::xz_decompress(&mut input, &mut out).map_err(|e| format!("解壓縮失敗：{e}"))?;
        out.flush().map_err(|e| format!("寫入暫存檔失敗：{e}"))?;
    }
    let _ = std::fs::remove_file(tarball);
    let staged = work.join("out");
    std::fs::create_dir(&staged).map_err(|e| format!("建立暫存資料夾失敗：{e}"))?;
    let tar_file = std::fs::File::open(&tar_path).map_err(|e| format!("讀不到暫存檔：{e}"))?;
    extract_members(std::io::BufReader::new(tar_file), &staged, lim)?;
    let _ = std::fs::remove_file(&tar_path);
    check(&staged)?;
    if let Some(parent) = final_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    }
    if dir_usable(final_dir) {
        return Ok(()); // 別的程序剛裝好同一份
    }
    std::fs::rename(&staged, final_dir).or_else(|e| if dir_usable(final_dir) { Ok(()) } else { Err(format!("放進正式位置失敗：{e}")) })
}

/// 兩個檔都在而且不是空的
pub(crate) fn dir_usable(dir: &Path) -> bool {
    WANTED.iter().all(|(_, n)| std::fs::metadata(dir.join(n)).is_ok_and(|m| m.is_file() && m.len() > 0))
}

// ---------- 下載 ----------

async fn download(url: &str, dest: &Path, max: u64) -> Result<(), String> {
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
    let client = reqwest::Client::builder().redirect(policy).connect_timeout(CONNECT_TIMEOUT).timeout(TOTAL_TIMEOUT).user_agent("asn").build().map_err(|e| format!("無法連線：{e}"))?;
    let mut res = client.get(url).send().await.map_err(|e| format!("下載失敗（連不上或逾時）：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("下載失敗：伺服器回 {}", res.status().as_u16()));
    }
    if res.content_length().is_some_and(|n| n > max) {
        return Err("下載的檔案比預期大太多，已中止".into());
    }
    let mut file = std::fs::File::create(dest).map_err(|e| format!("寫入暫存檔失敗：{e}"))?;
    let mut total = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("下載中斷：{e}"))? {
        total += chunk.len() as u64;
        if total > max {
            return Err("下載的檔案比預期大太多，已中止".into());
        }
        file.write_all(&chunk).map_err(|e| format!("寫入暫存檔失敗：{e}"))?;
    }
    file.flush().map_err(|e| format!("寫入暫存檔失敗：{e}"))?;
    Ok(())
}

/// 下載 + 安裝。暫存資料夾在任何結果下都會清掉
async fn fetch_into(root: &Path, url: &str, sha256: &str, final_dir: &Path, lim: &Limits, check: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let tmp = make_tmp(root)?;
    let tarball = tmp.0.join("download.tar.xz");
    download(url, &tarball, lim.max_tarball).await?;
    install_tarball(&tarball, sha256, &tmp.0, final_dir, lim, check)
}

/// 取得（已經有就直接回）。成功回正式位置，裡面有 `wezterm`、`wezterm-mux-server`。
/// `base` 是 mux 檔案的上層資料夾（`mux::default_base()`）
pub(crate) async fn ensure(base: &Path) -> Result<PathBuf, String> {
    let root = base.join("ASN").join("wezterm");
    let pins = pins()?;
    let os = parse_os_release(&std::fs::read_to_string("/etc/os-release").unwrap_or_default());
    let key = pin_key(&os, std::env::consts::ARCH)?;
    let pin = pins.linux.get(key).ok_or("內建的 WezTerm 版本資料缺這個發行版")?;
    let final_dir = root.join(format!("{}-{key}", pins.version));
    if dir_usable(&final_dir) {
        return Ok(final_dir);
    }
    let url = download_url(&pins.version, &pin.tarball)?;
    std::fs::create_dir_all(&root).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    clean_stale(&root);
    check_space(free_bytes(&root), NEED_FREE)?;
    elog!("取得 WezTerm 開始：{url}");
    let res = fetch_into(&root, &url, &pin.sha256, &final_dir, &Limits::default(), &run_version_check).await;
    match &res {
        Ok(()) => elog!("取得 WezTerm 完成"),
        Err(e) => elog!("取得 WezTerm 失敗：{e}"),
    }
    res.map(|()| final_dir)
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

static IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 背景取得（同時只跑一個）。完成後要重開 ASN 才會用上；結果只寫 log
pub(crate) fn spawn_background() {
    let Some(base) = super::mux::default_base() else { return };
    if IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("asn-wezterm-fetch".into()).spawn(move || {
        match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => {
                let _ = rt.block_on(ensure(&base));
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

    fn ok_check(_: &Path) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn pins_讀得懂_版本與探測腳本_windows_腳本一致() {
        let p = pins().unwrap();
        assert_eq!(p.version, "20240203-110809-5046fc22");
        for (k, pin) in &p.linux {
            assert!(pin.sha256.len() == 64 && pin.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{k}");
            assert!(pin.tarball.starts_with(&format!("wezterm-{}.", p.version)) && pin.tarball.ends_with(".tar.xz"), "{k}");
            assert!(pin.size > 1_000_000 && pin.size < 64 * MIB, "{k}");
            assert!(download_url(&p.version, &pin.tarball).is_ok());
        }
        // 探測腳本（CI）用同一組版本與雜湊，不能漂開
        let probe = include_str!("../../../../../.github/scripts/linux-wezterm-probe.sh");
        let u = &p.linux["ubuntu-22.04"];
        assert!(probe.contains(&format!("WEZTERM_VERSION='{}'", p.version)), "探測腳本的版本要等於 pins");
        assert!(probe.contains(&format!("TAR_SHA256='{}'", u.sha256)), "探測腳本的雜湊要等於 pins");
        assert!(probe.contains(&u.tarball.replace(&p.version, "${WEZTERM_VERSION}")) || probe.contains("Ubuntu22.04.tar.xz"));
        // Windows 的腳本讀同一份
        let mjs = include_str!("../../../scripts/fetch-wezterm.mjs");
        assert!(mjs.contains("wezterm-pins.json") && !mjs.contains(&p.version), "fetch-wezterm.mjs 不能再手抄版本");
    }

    #[test]
    fn 網址只組官方_github_前綴_檔名不合法就拒絕() {
        assert_eq!(download_url("v1", "a.tar.xz").unwrap(), "https://github.com/wezterm/wezterm/releases/download/v1/a.tar.xz");
        for bad in ["", "../x", "a/b", "a b", "a?b", "a#b", "a%2f"] {
            assert!(download_url("v1", bad).is_err(), "{bad}");
            assert!(download_url(bad, "a.tar.xz").is_err(), "{bad}");
        }
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

    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    #[test]
    fn 磁碟空間_statvfs_真的讀得到_不存在的路徑是_none() {
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
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(hello_xz()), &mut Capped { inner: &mut out, left: 5 }).unwrap();
        assert_eq!(out, b"hello");
        let mut out = Vec::new();
        let e = lzma_rs::xz_decompress(&mut std::io::Cursor::new(hello_xz()), &mut Capped { inner: &mut out, left: 4 }).unwrap_err();
        assert!(e.to_string().contains("上限"), "{e}");
    }

    #[test]
    fn 取出成員_只收兩個一般檔案_略過其他_連結被略過() {
        let d = tempfile::tempdir().unwrap();
        let mut raw = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(GOOD), &mut raw).unwrap();
        extract_members(std::io::Cursor::new(raw), d.path(), &Limits::default()).unwrap();
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
        let e = extract_members(std::io::Cursor::new(&raw), d.path(), &Limits::default()).unwrap_err();
        assert!(e.contains("不是一般檔案"), "{e}");
        let mut good = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(GOOD), &mut good).unwrap();
        let tiny = Limits { max_member: 8, ..Limits::default() };
        assert!(extract_members(std::io::Cursor::new(&good), tempfile::tempdir().unwrap().path(), &tiny).unwrap_err().contains("大小不合理"));
        let few = Limits { max_entries: 2, ..Limits::default() };
        assert!(extract_members(std::io::Cursor::new(&good), tempfile::tempdir().unwrap().path(), &few).unwrap_err().contains("成員太多"));
        let total = Limits { max_total: 30, ..Limits::default() };
        assert!(extract_members(std::io::Cursor::new(&good), tempfile::tempdir().unwrap().path(), &total).unwrap_err().contains("總量"));
        // 只有一個要的成員 → 缺另一個
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_size(1);
        h.set_cksum();
        b.append_data(&mut h, "wezterm/usr/bin/wezterm", &b"x"[..]).unwrap();
        let e = extract_members(std::io::Cursor::new(b.into_inner().unwrap()), tempfile::tempdir().unwrap().path(), &Limits::default()).unwrap_err();
        assert!(e.contains("找不到 wezterm-mux-server"), "{e}");
        // 路徑穿越不算要的成員
        assert_eq!(wanted_name(Path::new("./wezterm/usr/bin/wezterm")), Some("wezterm"));
        assert_eq!(wanted_name(Path::new("../wezterm/usr/bin/wezterm")), None);
        assert_eq!(wanted_name(Path::new("/wezterm/usr/bin/wezterm")), None);
        assert_eq!(wanted_name(Path::new("wezterm/usr/bin/wezterm-gui")), None);
    }

    #[test]
    fn 安裝_雜湊對_全程成功_暫存放進正式位置() {
        let root = tempfile::tempdir().unwrap();
        let tmp = make_tmp(root.path()).unwrap();
        let tarball = tmp.0.join("download.tar.xz");
        std::fs::write(&tarball, GOOD).unwrap();
        let fin = root.path().join("v-key");
        install_tarball(&tarball, &hex(GOOD), &tmp.0, &fin, &Limits::default(), &ok_check).unwrap();
        assert!(dir_usable(&fin));
        drop(tmp);
        let left: Vec<String> = std::fs::read_dir(root.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["v-key"], "暫存資料夾清掉了");
    }

    #[test]
    fn 安裝_雜湊不符_刪檔報錯_什麼都沒裝_暫存清乾淨() {
        let root = tempfile::tempdir().unwrap();
        let fin = root.path().join("v-key");
        {
            let tmp = make_tmp(root.path()).unwrap();
            let tarball = tmp.0.join("download.tar.xz");
            std::fs::write(&tarball, GOOD).unwrap();
            let e = install_tarball(&tarball, &"0".repeat(64), &tmp.0, &fin, &Limits::default(), &|_: &Path| panic!("雜湊不符不可以執行任何東西")).unwrap_err();
            assert!(e.contains("雜湊不符"), "{e}");
            assert!(!tarball.exists(), "刪掉下載的檔");
        }
        assert!(!fin.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "暫存資料夾清掉了");
    }

    #[test]
    fn 安裝_解壓縮壞掉_檢查失敗_都不留東西() {
        let root = tempfile::tempdir().unwrap();
        let fin = root.path().join("v-key");
        let junk = b"not an xz file at all, but with a known hash".to_vec();
        {
            let tmp = make_tmp(root.path()).unwrap();
            let tarball = tmp.0.join("download.tar.xz");
            std::fs::write(&tarball, &junk).unwrap();
            assert!(install_tarball(&tarball, &hex(&junk), &tmp.0, &fin, &Limits::default(), &ok_check).unwrap_err().contains("解壓縮失敗"));
        }
        {
            let tmp = make_tmp(root.path()).unwrap();
            let tarball = tmp.0.join("download.tar.xz");
            std::fs::write(&tarball, GOOD).unwrap();
            let e = install_tarball(&tarball, &hex(GOOD), &tmp.0, &fin, &Limits::default(), &|_: &Path| Err("缺少系統函式庫 libssl.so.3，請用套件管理員安裝後再試".to_string())).unwrap_err();
            assert!(e.contains("libssl"), "{e}");
        }
        assert!(!fin.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "暫存資料夾清掉了");
    }

    #[tokio::test]
    async fn 下載失敗_連不上_暫存資料夾也清掉() {
        let root = tempfile::tempdir().unwrap();
        let fin = root.path().join("v-key");
        let e = fetch_into(root.path(), "https://127.0.0.1:1/x.tar.xz", &"0".repeat(64), &fin, &Limits::default(), &ok_check).await.unwrap_err();
        assert!(e.contains("下載失敗"), "{e}");
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

    /// 真的連 GitHub 取得固定版本（要網路，預設不跑；CI 的 headless-test 明跑）：
    /// 空的資料夾 → ensure → 兩個檔都在 → 再呼叫一次直接沿用 → locate 找得到（ASN_WEZTERM_DIR 沒設、PATH 沒有 wezterm）。
    /// `XDG_DATA_HOME` 由呼叫端指定好（CI 後面的步驟要用同一個位置）
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore]
    async fn linux_real_fetch_wezterm() {
        let base = PathBuf::from(std::env::var_os("XDG_DATA_HOME").expect("要設 XDG_DATA_HOME 指到空的資料夾"));
        assert!(fetched_dirs(&base).is_empty(), "要從空的開始");
        let dir = ensure(&base).await.expect("取得 WezTerm");
        assert!(dir_usable(&dir), "{dir:?}");
        assert_eq!(ensure(&base).await.unwrap(), dir, "第二次直接沿用");
        let found = super::super::wezterm::locate(&super::super::wezterm::RealFs).expect("locate 要找得到取得的");
        assert!(found.cli.starts_with(&base), "{:?}", found.cli);
        assert_eq!(found.gui, None, "沒有桌面版");
        println!("取得完成：{}", dir.display());
    }
}
