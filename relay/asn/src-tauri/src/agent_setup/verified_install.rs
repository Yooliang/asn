//! 「驗過再執行」的共用安裝骨架（#933 PR-2）。各家（Claude、之後的 Codex、agy…）只提供「這一版要下載哪個檔、雜湊多少、多大」
//! 與一份 `Spec`（官方網域、簽署者、檔名），流程一律在這裡：
//!   1. 下載網址必須是 https、而且主機完全等於 `Spec.host`（清單裡的網址也一樣），否則不下載
//!   2. 邊下載邊算雜湊；大小、雜湊任一和清單不符就刪檔
//!   3. 把檔案鎖成「別人不能改、不能刪」，鎖著重算一次雜湊、驗數位簽章（簽署者必須**完全等於** `Spec.signer`）
//!   4. 直接執行同一個被鎖住的檔案（不搬、不重開，驗過的就是跑的）；跑完刪掉下載檔
//!   5. 裝出來的執行檔也要驗：存在、簽章有效且簽署者相符、`--version` 的第一個字等於驗過的版本號
//! 任何一步不過就刪檔、不執行、回給人看的原因。每次安裝（成功或失敗）都產生一筆 `Record`，
//! 由呼叫端寫進安裝記錄（廠商、版本、檔案雜湊、簽署者、來源網域、結果；不含任何憑證）。
//! 不跑任何下載來的腳本；同一時間只允許一個安裝（不分廠商）。

use super::authenticode::SignatureCheck;
use super::net::Fetch;
use sha2::{Digest, Sha256, Sha512};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

/// 官方清單提供的雜湊演算法
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashAlgo {
    Sha256,
    /// agy 的清單用 sha512（#933 PR-4 才會用到）
    #[allow(dead_code)]
    Sha512,
}

impl HashAlgo {
    pub fn name(self) -> &'static str {
        match self {
            HashAlgo::Sha256 => "sha256",
            HashAlgo::Sha512 => "sha512",
        }
    }
    fn hex_len(self) -> usize {
        match self {
            HashAlgo::Sha256 => 64,
            HashAlgo::Sha512 => 128,
        }
    }
    /// 清單裡的雜湊字串格式對不對（小寫十六進位、長度符合演算法）
    pub fn valid_hex(self, s: &str) -> bool {
        s.len() == self.hex_len() && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }
}

enum Hasher {
    S256(Sha256),
    S512(Sha512),
}

impl Hasher {
    fn new(a: HashAlgo) -> Self {
        match a {
            HashAlgo::Sha256 => Hasher::S256(Sha256::new()),
            HashAlgo::Sha512 => Hasher::S512(Sha512::new()),
        }
    }
    fn update(&mut self, b: &[u8]) {
        match self {
            Hasher::S256(h) => h.update(b),
            Hasher::S512(h) => h.update(b),
        }
    }
    fn hex(self) -> String {
        match self {
            Hasher::S256(h) => hex(&h.finalize()),
            Hasher::S512(h) => hex(&h.finalize()),
        }
    }
}

/// 一家的固定資料（寫死在程式裡，不從網路來）
#[derive(Debug, Clone, Copy)]
pub struct Spec {
    /// 給人看的名稱，例如 `Claude Code`
    pub vendor: &'static str,
    /// 下載只連這台主機（完全相等，不收子網域）
    pub host: &'static str,
    /// Authenticode 簽署者，必須完全相等
    pub signer: &'static str,
    /// 裝好的執行檔名稱（只用在訊息），例如 `claude.exe`
    pub exe: &'static str,
    /// 下載暫存檔的前綴，例如 `claude`（清殘檔時只動這個前綴的）
    pub file_prefix: &'static str,
    pub hash: HashAlgo,
}

/// 這一次要裝的版本（由各家從官方清單解析出來）
#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    pub platform: String,
    pub url: String,
    /// 清單上的雜湊（小寫十六進位）
    pub sum: String,
    pub size: u64,
}

/// 執行安裝程式（逾時要殺掉整棵程序樹並回錯）。結束碼 `None` 不會出現：逾時一律回 `Err`
pub trait Exec {
    fn run_installer(&self, exe: &Path, args: &[&str], cwd: &Path, timeout: Duration) -> Result<i32, String>;
    /// 執行 `exe --version` 取標準輸出（逾時殺掉並回錯）
    fn version_output(&self, exe: &Path, timeout: Duration) -> Result<String, String>;
}

pub struct Deps<'a> {
    pub fetch: &'a dyn Fetch,
    pub sig: &'a dyn SignatureCheck,
    pub exec: &'a dyn Exec,
}

pub const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

/// 版本號只收 `數字.數字.數字`：它會被組進下載網址與檔名，不能夾帶其他字元
pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// 網址是不是 https，而且主機完全等於 `host`（不收 `host.evil.com`、`evil.com/host`、帳密、連接埠）
pub fn url_on_host(url: &str, host: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    &rest[..end] == host
}

/// `--version` 的輸出第一個字必須完全等於版本號（例如 `2.1.309 (Claude Code)`）
pub fn version_matches(output: &str, version: &str) -> bool {
    output.split_whitespace().next() == Some(version)
}

/// 邊寫邊算雜湊
struct HashWriter<'a> {
    file: &'a mut File,
    hash: Hasher,
}
impl Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.file.write(buf)?;
        self.hash.update(&buf[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_open_file(mut f: &File, algo: HashAlgo) -> Result<String, String> {
    f.seek(SeekFrom::Start(0)).map_err(|e| format!("讀不了下載的檔案：{e}"))?;
    let mut h = Hasher::new(algo);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("讀不了下載的檔案：{e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.hex())
}

/// 唯讀開啟並禁止別人寫入或刪除（Windows 的共用模式只留「別人可讀」）；握著它直到執行完
pub fn open_locked(path: &Path) -> Result<File, String> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.share_mode(1); // FILE_SHARE_READ
    }
    o.open(path).map_err(|e| format!("鎖不住下載的檔案：{e}"))
}

/// 上次留下的下載殘檔（只動我們自己命名的：`<前綴>-…exe` 或 `.part`）
fn clean_stale(dir: &Path, prefix: &str) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let head = format!("{prefix}-");
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(&head) && (name.ends_with(".exe") || name.ends_with(".part")) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn remove_with_retry(path: &Path) {
    for _ in 0..10 {
        if !path.exists() || std::fs::remove_file(path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 一次安裝的記錄（成功或失敗都有）。不含任何憑證、網址參數；`detail` 是給人看的原因
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub vendor: String,
    pub version: Option<String>,
    pub host: String,
    pub algo: &'static str,
    /// 下載檔的雜湊（算到才有）
    pub sum: Option<String>,
    /// 驗到的簽署者（驗到才有）
    pub signer: Option<String>,
    pub ok: bool,
    pub detail: String,
}

impl Record {
    pub fn start(spec: &Spec) -> Self {
        Record { vendor: spec.vendor.into(), version: None, host: spec.host.into(), algo: spec.hash.name(), sum: None, signer: None, ok: false, detail: String::new() }
    }

    /// 記錄檔的一行（拿掉控制字元、限長）
    pub fn line(&self) -> String {
        let opt = |v: &Option<String>| v.clone().unwrap_or_else(|| "-".into());
        let raw = format!(
            "安裝 廠商={} 版本={} 來源={} {}={} 簽署者=\"{}\" 結果={}",
            self.vendor,
            opt(&self.version),
            self.host,
            self.algo,
            opt(&self.sum),
            opt(&self.signer),
            if self.ok { format!("成功 {}", self.detail) } else { format!("失敗：{}", self.detail) }
        );
        let clean: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
        clean.chars().take(600).collect()
    }
}

/// 記錄檔：`<資料夾>\install.log`。超過上限就只留後半，寫不進去就算了（不影響安裝結果）
pub fn write_record(dir: &Path, rec: &Record) {
    const MAX: usize = 64 * 1024;
    let _ = std::fs::create_dir_all(dir);
    let p = dir.join("install.log");
    let mut old = std::fs::read_to_string(&p).unwrap_or_default();
    if old.len() > MAX {
        let mut cut = old.len() - MAX / 2;
        while !old.is_char_boundary(cut) {
            cut += 1;
        }
        old = old[cut..].to_string();
    }
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let _ = std::fs::write(&p, format!("{old}{at} {}\n", rec.line()));
}

/// 驗證式安裝的核心：下載 `rel` → 驗 → 用 `args` 執行同一個檔 → 驗 `final_exe`。
/// `rel` 必須已經由呼叫端從官方清單解析好；這裡再驗一次網域、版本號、雜湊格式、大小。
pub fn install(d: &Deps, spec: &Spec, rel: &Release, args: &[&str], work: &Path, final_exe: &Path, timeout: Duration) -> (Result<String, String>, Record) {
    let mut rec = Record::start(spec);
    let r = install_inner(d, spec, rel, args, work, final_exe, timeout, &mut rec);
    match &r {
        Ok(m) => {
            rec.ok = true;
            rec.detail = m.clone();
        }
        Err(e) => rec.detail = e.clone(),
    }
    (r, rec)
}

#[allow(clippy::too_many_arguments)]
fn install_inner(d: &Deps, spec: &Spec, rel: &Release, args: &[&str], work: &Path, final_exe: &Path, timeout: Duration, rec: &mut Record) -> Result<String, String> {
    if !valid_version(&rel.version) {
        return Err("官方回的版本號格式不對，已放棄安裝".to_string());
    }
    rec.version = Some(rel.version.clone());
    if !url_on_host(&rel.url, spec.host) {
        return Err("官方清單指向不認得的下載位置，為了安全沒有安裝".to_string());
    }
    if !spec.hash.valid_hex(&rel.sum) {
        return Err("官方清單的雜湊格式不對".to_string());
    }
    if rel.size == 0 {
        return Err("官方清單的檔案大小不合理".to_string());
    }
    std::fs::create_dir_all(work).map_err(|e| format!("無法建立下載資料夾：{e}"))?;
    clean_stale(work, spec.file_prefix);

    let stem = format!("{}-{}-{}", spec.file_prefix, rel.version, rel.platform);
    let part = work.join(format!("{stem}.exe.part"));
    let path = work.join(format!("{stem}.exe"));
    let got_sum = {
        let mut f = File::create(&part).map_err(|e| format!("無法建立下載檔：{e}"))?;
        let mut hw = HashWriter { file: &mut f, hash: Hasher::new(spec.hash) };
        let r = d.fetch.download(&rel.url, &mut hw, rel.size);
        let sum = hw.hash.hex();
        drop(f);
        match r {
            Ok(n) if n == rel.size => sum,
            Ok(_) => {
                let _ = std::fs::remove_file(&part);
                return Err("下載的檔案大小和官方清單不符，已放棄安裝".to_string());
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                return Err(e);
            }
        }
    };
    rec.sum = Some(got_sum.clone());
    if got_sum != rel.sum {
        let _ = std::fs::remove_file(&part);
        return Err("下載的檔案雜湊和官方清單不符，已放棄安裝".to_string());
    }
    std::fs::rename(&part, &path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("無法就位下載的檔案：{e}")
    })?;

    // 從這裡起，驗與跑都是同一個被鎖住的檔案
    let guard = match open_locked(&path) {
        Ok(g) => g,
        Err(e) => {
            remove_with_retry(&path);
            return Err(e);
        }
    };
    let outcome = verify_then_run(d, spec, &guard, &path, &rel.sum, args, work, timeout, rec);
    drop(guard);
    remove_with_retry(&path);
    outcome?;
    verify_installed(d, spec, final_exe, &rel.version)?;
    Ok(format!("已安裝 {} {}。", spec.vendor, rel.version))
}

/// 鎖住後：重算雜湊 → 驗簽署者 → 執行同一個檔
#[allow(clippy::too_many_arguments)]
pub fn verify_then_run(d: &Deps, spec: &Spec, guard: &File, path: &Path, want_sum: &str, args: &[&str], work: &Path, timeout: Duration, rec: &mut Record) -> Result<(), String> {
    // 鎖住之後再算一次：之前到鎖住之間若被換掉，這裡抓得到
    if hash_open_file(guard, spec.hash)? != want_sum {
        return Err("下載的檔案在驗證前被改動，已放棄安裝".to_string());
    }
    let who = d.sig.signer(path).map_err(|e| format!("{} 的數位簽章沒通過，已放棄安裝：{e}", spec.vendor))?;
    rec.signer = Some(who.clone());
    if who != spec.signer {
        return Err(format!("{} 的簽署者不是 {}，已放棄安裝", spec.vendor, spec.signer));
    }
    let code = d.exec.run_installer(path, args, work, timeout)?;
    if code != 0 {
        return Err(format!("官方安裝程式回報失敗（結束碼 {code}）"));
    }
    Ok(())
}

/// 裝出來的執行檔也要驗：存在、簽章有效且簽署者相符、`--version` 的版本等於驗過的那一版
pub fn verify_installed(d: &Deps, spec: &Spec, final_exe: &Path, version: &str) -> Result<(), String> {
    if !final_exe.exists() {
        return Err(format!("安裝程式說完成了，但找不到安裝好的 {}", spec.exe));
    }
    let who = d.sig.signer(final_exe).map_err(|e| format!("裝好的 {} 數位簽章沒通過：{e}", spec.exe))?;
    if who != spec.signer {
        return Err(format!("裝好的 {} 簽署者不是 {}", spec.exe, spec.signer));
    }
    let out = d.exec.version_output(final_exe, VERSION_TIMEOUT).map_err(|e| format!("問不出裝好的 {} 的版本：{e}", spec.exe))?;
    if !version_matches(&out, version) {
        return Err(format!("裝好的 {} 版本和驗證過的 {version} 不一致，沒有算成功", spec.exe));
    }
    Ok(())
}

/// 這台電腦上現有的執行檔狀況（開始安裝之前先看，已經好好的就不動它）
#[derive(Debug, PartialEq, Eq)]
pub enum Existing {
    /// 沒有這個檔案
    Missing,
    /// 簽章有效、簽署者相符、`--version` 跑得出來：帶版本號。不比版本：各家會自己更新，比了反而可能把新版降回頻道版本
    Healthy(String),
    /// 有檔案但不能用：要重裝。`kind` 區分「簽章或簽署者不對（那支程式可能被換過）」和「跑不起來」，本人要看得到；`String` 是細節（寫 log，不上畫面）
    Broken(BrokenKind, String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrokenKind {
    /// 數位簽章沒通過，或簽署者不對
    BadSignature,
    /// 簽章沒問題，但 `--version` 跑不出來或看不懂
    CannotRun,
}

pub fn inspect(d: &Deps, spec: &Spec, final_exe: &Path) -> Existing {
    if !final_exe.exists() {
        return Existing::Missing;
    }
    match d.sig.signer(final_exe) {
        Ok(who) if who == spec.signer => {}
        Ok(_) => return Existing::Broken(BrokenKind::BadSignature, format!("現有的 {} 簽署者不是 {}", spec.exe, spec.signer)),
        Err(e) => return Existing::Broken(BrokenKind::BadSignature, format!("現有的 {} 數位簽章沒通過：{e}", spec.exe)),
    }
    match d.exec.version_output(final_exe, VERSION_TIMEOUT) {
        Ok(out) => match out.split_whitespace().next() {
            Some(v) if valid_version(v) => Existing::Healthy(v.to_string()),
            _ => Existing::Broken(BrokenKind::CannotRun, format!("現有的 {} 的版本輸出看不懂", spec.exe)),
        },
        Err(e) => Existing::Broken(BrokenKind::CannotRun, format!("現有的 {} 跑不起來：{e}", spec.exe)),
    }
}

/// 同一時間只允許一個安裝（不分廠商）：同時下載、同時動使用者的資料夾容易出事
static INSTALL_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct InstallBusy;
impl InstallBusy {
    pub fn take() -> Result<Self, String> {
        take_flag(&INSTALL_BUSY).map(|_| InstallBusy)
    }
}
impl Drop for InstallBusy {
    fn drop(&mut self) {
        INSTALL_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
pub fn take_flag(flag: &std::sync::atomic::AtomicBool) -> Result<(), String> {
    if flag.swap(true, std::sync::atomic::Ordering::SeqCst) {
        Err("已經有一個安裝在進行，請等它結束再試".to_string())
    } else {
        Ok(())
    }
}

pub struct RealExec;

impl Exec for RealExec {
    fn version_output(&self, exe: &Path, timeout: Duration) -> Result<String, String> {
        Self::version_impl(exe, timeout)
    }

    fn run_installer(&self, exe: &Path, args: &[&str], cwd: &Path, timeout: Duration) -> Result<i32, String> {
        use crate::nowin::NoWindow;
        use std::process::{Command, Stdio};
        let mut child = Command::new(exe)
            .no_window()
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("無法啟動官方安裝程式：{e}"))?;
        let pid = child.id();
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(st)) => return Ok(st.code().unwrap_or(-1)),
                Ok(None) => {}
                Err(e) => return Err(format!("等不到官方安裝程式結束：{e}")),
            }
            if start.elapsed() >= timeout {
                // 只結束我們剛啟動、記下編號的這一棵
                let _ = Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).output();
                let _ = child.kill();
                let _ = child.wait();
                return Err("官方安裝程式跑太久，已結束它".to_string());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl RealExec {
    fn version_impl(exe: &Path, timeout: Duration) -> Result<String, String> {
        use crate::nowin::NoWindow;
        use std::process::{Command, Stdio};
        let mut child = Command::new(exe)
            .no_window()
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("無法執行 --version：{e}"))?;
        let pid = child.id();
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(e) => return Err(format!("等不到 --version 結束：{e}")),
            }
            if start.elapsed() >= timeout {
                let _ = Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).output();
                let _ = child.kill();
                let _ = child.wait();
                return Err("--version 跑太久，已結束它".to_string());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut out = String::new();
        if let Some(so) = child.stdout.take() {
            let _ = so.take(4096).read_to_string(&mut out);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    const BIN: &[u8] = b"MZ fake vendor binary";
    const SPEC: Spec = Spec { vendor: "測試廠商", host: "dl.example.test", signer: "Example, Inc.", exe: "tool.exe", file_prefix: "tool", hash: HashAlgo::Sha512 };

    fn sum512(b: &[u8]) -> String {
        hex(&Sha512::digest(b))
    }

    struct OneFile(Vec<u8>, RefCell<Vec<String>>);
    impl Fetch for OneFile {
        fn get_text(&self, _u: &str, _m: u64) -> Result<String, String> {
            panic!("核心不取清單")
        }
        fn download(&self, url: &str, out: &mut dyn Write, _max: u64) -> Result<u64, String> {
            self.1.borrow_mut().push(url.to_string());
            out.write_all(&self.0).map_err(|e| e.to_string())?;
            Ok(self.0.len() as u64)
        }
    }
    struct Sig(&'static str);
    impl SignatureCheck for Sig {
        fn signer(&self, _p: &Path) -> Result<String, String> {
            Ok(self.0.to_string())
        }
    }
    struct Ex(PathBuf, RefCell<u32>);
    impl Exec for Ex {
        fn run_installer(&self, _e: &Path, _a: &[&str], _c: &Path, _t: Duration) -> Result<i32, String> {
            *self.1.borrow_mut() += 1;
            std::fs::write(&self.0, b"installed").unwrap();
            Ok(0)
        }
        fn version_output(&self, _e: &Path, _t: Duration) -> Result<String, String> {
            Ok("1.2.3".into())
        }
    }

    fn rel(url: &str, body: &[u8]) -> Release {
        Release { version: "1.2.3".into(), platform: "win32-x64".into(), url: url.into(), sum: sum512(body), size: body.len() as u64 }
    }

    fn go(url: &str, signer: &'static str) -> (Result<String, String>, Record, u32, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let fin = dir.path().join("bin").join("tool.exe");
        std::fs::create_dir_all(fin.parent().unwrap()).unwrap();
        let f = OneFile(BIN.to_vec(), RefCell::new(vec![]));
        let e = Ex(fin.clone(), RefCell::new(0));
        let (r, rec) = install(&Deps { fetch: &f, sig: &Sig(signer), exec: &e }, &SPEC, &rel(url, BIN), &["install"], &dir.path().join("work"), &fin, Duration::from_secs(5));
        let ran = *e.1.borrow();
        let urls = f.1.borrow().clone();
        (r, rec, ran, urls)
    }

    #[test]
    fn sha512_的家也走得通_記錄帶版本雜湊簽署者來源() {
        let (r, rec, ran, _) = go("https://dl.example.test/1.2.3/tool.exe", "Example, Inc.");
        assert_eq!(r.unwrap(), "已安裝 測試廠商 1.2.3。");
        assert_eq!(ran, 1);
        assert!(rec.ok);
        assert_eq!(rec.version.as_deref(), Some("1.2.3"));
        assert_eq!(rec.sum.as_deref(), Some(sum512(BIN).as_str()));
        assert_eq!(rec.signer.as_deref(), Some("Example, Inc."));
        let line = rec.line();
        for want in ["廠商=測試廠商", "版本=1.2.3", "來源=dl.example.test", &format!("sha512={}", sum512(BIN)), "簽署者=\"Example, Inc.\"", "結果=成功"] {
            assert!(line.contains(want), "{want}：{line}");
        }
    }

    #[test]
    fn 下載網址不在官方主機_不下載不執行_記錄寫失敗() {
        for bad in ["http://dl.example.test/x.exe", "https://dl.example.test.evil.com/x.exe", "https://evil.com/dl.example.test/x.exe", "https://user@dl.example.test/x.exe", "https://dl.example.test:8443/x.exe", "https://sub.dl.example.test/x.exe", "dl.example.test/x.exe"] {
            let (r, rec, ran, urls) = go(bad, "Example, Inc.");
            assert!(r.unwrap_err().contains("不認得的下載位置"), "{bad}");
            assert_eq!(ran, 0, "{bad}");
            assert!(urls.is_empty(), "{bad}：不能連");
            assert!(!rec.ok && rec.line().contains("結果=失敗"), "{bad}");
        }
        assert!(url_on_host("https://dl.example.test", "dl.example.test"));
        assert!(url_on_host("https://dl.example.test/a?b#c", "dl.example.test"));
    }

    #[test]
    fn 簽署者不符_記錄裡看得到驗到的是誰() {
        let (r, rec, ran, _) = go("https://dl.example.test/x.exe", "Someone Else");
        assert!(r.unwrap_err().contains("簽署者"));
        assert_eq!(ran, 0);
        assert_eq!(rec.signer.as_deref(), Some("Someone Else"));
        assert!(rec.sum.is_some(), "雜湊已經算過，要記下來");
    }

    #[test]
    fn 雜湊格式要符合演算法() {
        assert!(HashAlgo::Sha256.valid_hex(&"a".repeat(64)));
        assert!(!HashAlgo::Sha256.valid_hex(&"a".repeat(128)));
        assert!(HashAlgo::Sha512.valid_hex(&"0".repeat(128)));
        assert!(!HashAlgo::Sha512.valid_hex(&"A".repeat(128)), "要小寫");
        let dir = tempfile::tempdir().unwrap();
        let f = OneFile(BIN.to_vec(), RefCell::new(vec![]));
        let e = Ex(dir.path().join("t.exe"), RefCell::new(0));
        let mut r = rel("https://dl.example.test/x.exe", BIN);
        r.sum = "0".repeat(64); // sha256 長度交給 sha512 的家
        let (res, _) = install(&Deps { fetch: &f, sig: &Sig("Example, Inc."), exec: &e }, &SPEC, &r, &[], dir.path(), &dir.path().join("t.exe"), Duration::from_secs(5));
        assert!(res.unwrap_err().contains("雜湊格式"));
        assert!(f.1.borrow().is_empty());
    }

    #[test]
    fn 記錄行拿掉控制字元_限長_寫檔超過上限只留後半() {
        let mut rec = Record::start(&SPEC);
        rec.detail = format!("壞\n掉\r{}", "長".repeat(2000));
        let l = rec.line();
        assert!(!l.contains('\n') && !l.contains('\r'));
        assert!(l.chars().count() <= 600);
        let dir = tempfile::tempdir().unwrap();
        for _ in 0..300 {
            write_record(dir.path(), &rec);
        }
        let text = std::fs::read_to_string(dir.path().join("install.log")).unwrap();
        assert!(text.len() < 64 * 1024 + 4096, "{}", text.len());
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn 安裝的鎖不分廠商() {
        let flag = std::sync::atomic::AtomicBool::new(false);
        assert!(take_flag(&flag).is_ok());
        assert!(take_flag(&flag).unwrap_err().contains("已經有一個安裝"));
    }
}
