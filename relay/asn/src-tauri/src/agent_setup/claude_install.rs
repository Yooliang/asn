//! 在 Windows 上安裝官方 Claude Code：取代過去的「`irm 網址 | iex`」。
//! 做的事和官方安裝腳本一樣（下載版本號與清單、下載執行檔、比對 sha256、執行 `claude.exe install`），
//! 但多三道門：下載完把檔案鎖成「別人不能改、不能刪」，鎖著重算一次雜湊、驗數位簽章、再直接執行同一個檔案
//! （不搬、不重開，驗過的就是跑的）；簽署者必須完全等於 `Anthropic, PBC`。任何一步不通過就刪檔、不執行。
//! 版本從 `stable` 頻道取，執行時把驗過的確切版本號交給安裝程式（不只寫頻道名），裝完再驗裝出來的 `claude.exe`
//! （簽章有效、簽署者相符、`--version` 等於驗過的版本號）才算成功。
//! 全程只連 `downloads.claude.ai`，不跟轉址。

use super::authenticode::SignatureCheck;
use super::net::Fetch;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const RELEASE_BASE: &str = "https://downloads.claude.ai/claude-code-releases";
/// 簽署者必須完全等於這個名稱
pub const EXPECTED_SIGNER: &str = "Anthropic, PBC";
/// 取版本號用 stable；裝完照官方預設，自動更新跟 latest（ASN 只負責裝上驗過的那一版，不改使用者的設定）
const CHANNEL: &str = "stable";
const MAX_VERSION_BYTES: u64 = 64;
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
const MAX_BINARY_BYTES: u64 = 800 * 1024 * 1024;
/// 官方安裝程式自己還會下載一次（新家用機實測 238 秒），要留夠長的餘裕
const INSTALL_TIMEOUT: Duration = Duration::from_secs(900);
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

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

/// 版本號只收 `數字.數字.數字`：它會被組進下載網址與檔名，不能夾帶其他字元
pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn platform() -> Result<&'static str, String> {
    if !cfg!(windows) {
        return Err("這個平台還沒有驗證式安裝".to_string());
    }
    if cfg!(target_arch = "x86_64") {
        Ok("win32-x64")
    } else if cfg!(target_arch = "aarch64") {
        Ok("win32-arm64")
    } else {
        Err("Claude Code 不支援這種處理器".to_string())
    }
}

fn url_channel() -> String {
    format!("{RELEASE_BASE}/{CHANNEL}")
}
fn url_manifest(version: &str) -> String {
    format!("{RELEASE_BASE}/{version}/manifest.json")
}
fn url_binary(version: &str, platform: &str) -> String {
    format!("{RELEASE_BASE}/{version}/{platform}/claude.exe")
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 清單裡這個平台的雜湊與大小
fn parse_manifest(text: &str, version: &str, platform: &str) -> Result<(String, u64), String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "官方清單讀不懂".to_string())?;
    if v.get("version").and_then(|x| x.as_str()) != Some(version) {
        return Err("官方清單的版本和最新版本對不上".to_string());
    }
    let p = v.get("platforms").and_then(|x| x.get(platform)).ok_or_else(|| "官方清單裡沒有這個平台".to_string())?;
    let sum = p.get("checksum").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
    if !is_sha256_hex(&sum) {
        return Err("官方清單的雜湊格式不對".to_string());
    }
    let size = p.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
    if size == 0 || size > MAX_BINARY_BYTES {
        return Err("官方清單的檔案大小不合理".to_string());
    }
    Ok((sum, size))
}

/// 邊寫邊算雜湊
struct HashWriter<'a> {
    file: &'a mut File,
    hash: Sha256,
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_open_file(mut f: &File) -> Result<String, String> {
    f.seek(SeekFrom::Start(0)).map_err(|e| format!("讀不了下載的檔案：{e}"))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("讀不了下載的檔案：{e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// 唯讀開啟並禁止別人寫入或刪除（Windows 的共用模式只留「別人可讀」）；握著它直到執行完
fn open_locked(path: &Path) -> Result<File, String> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.share_mode(1); // FILE_SHARE_READ
    }
    o.open(path).map_err(|e| format!("鎖不住下載的檔案：{e}"))
}

/// 上次留下的下載殘檔（只動我們自己命名的）
fn clean_stale(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("claude-") && (name.ends_with(".exe") || name.ends_with(".part")) {
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

/// 驗證式安裝。`work` 是 ASN 自己的下載資料夾，`final_exe` 是安裝完該出現的 `claude.exe`
pub fn install(d: &Deps, work: &Path, platform: &str, final_exe: &Path) -> Result<String, String> {
    std::fs::create_dir_all(work).map_err(|e| format!("無法建立下載資料夾：{e}"))?;
    clean_stale(work);

    let version = d.fetch.get_text(&url_channel(), MAX_VERSION_BYTES)?.trim().to_string();
    if !valid_version(&version) {
        return Err("官方回的版本號格式不對，已放棄安裝".to_string());
    }
    let manifest = d.fetch.get_text(&url_manifest(&version), MAX_MANIFEST_BYTES)?;
    let (want_sum, size) = parse_manifest(&manifest, &version, platform)?;

    let part = work.join(format!("claude-{version}-{platform}.exe.part"));
    let path = work.join(format!("claude-{version}-{platform}.exe"));
    let got_sum = {
        let mut f = File::create(&part).map_err(|e| format!("無法建立下載檔：{e}"))?;
        let mut hw = HashWriter { file: &mut f, hash: Sha256::new() };
        let r = d.fetch.download(&url_binary(&version, platform), &mut hw, size);
        let sum = hex(&hw.hash.finalize());
        drop(f);
        match r {
            Ok(n) if n == size => sum,
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
    if got_sum != want_sum {
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
    let outcome = verify_then_run(d, &guard, &path, &want_sum, &version, work);
    drop(guard);
    remove_with_retry(&path);
    outcome?;
    verify_installed(d, final_exe, &version)?;
    Ok(format!("已安裝 Claude Code {version}。"))
}

/// 裝出來的 `claude.exe` 也要驗：存在、簽章有效且簽署者相符、`--version` 的版本等於我們驗過的那一版
fn verify_installed(d: &Deps, final_exe: &Path, version: &str) -> Result<(), String> {
    if !final_exe.exists() {
        return Err("安裝程式說完成了，但找不到安裝好的 claude.exe".to_string());
    }
    let who = d.sig.signer(final_exe).map_err(|e| format!("裝好的 claude.exe 數位簽章沒通過：{e}"))?;
    if who != EXPECTED_SIGNER {
        return Err("裝好的 claude.exe 簽署者不是 Anthropic, PBC".to_string());
    }
    let out = d.exec.version_output(final_exe, VERSION_TIMEOUT).map_err(|e| format!("問不出裝好的 claude.exe 的版本：{e}"))?;
    if !version_matches(&out, version) {
        return Err(format!("裝好的 claude.exe 版本和驗證過的 {version} 不一致，沒有算成功"));
    }
    Ok(())
}

/// `--version` 的輸出第一個字必須完全等於版本號（例如 `2.1.309 (Claude Code)`）
fn version_matches(output: &str, version: &str) -> bool {
    output.split_whitespace().next() == Some(version)
}

fn verify_then_run(d: &Deps, guard: &File, path: &Path, want_sum: &str, version: &str, work: &Path) -> Result<(), String> {
    // 鎖住之後再算一次：之前到鎖住之間若被換掉，這裡抓得到
    if hash_open_file(guard)? != want_sum {
        return Err("下載的檔案在驗證前被改動，已放棄安裝".to_string());
    }
    let who = d.sig.signer(path).map_err(|e| format!("Claude Code 的數位簽章沒通過，已放棄安裝：{e}"))?;
    if who != EXPECTED_SIGNER {
        return Err("Claude Code 的簽署者不是 Anthropic, PBC，已放棄安裝".to_string());
    }
    // 把驗過的確切版本號交給安裝程式：取版本號之後頻道剛好更新，裝的也還是驗過的這一版
    let code = d.exec.run_installer(path, &["install", version], work, INSTALL_TIMEOUT)?;
    if code != 0 {
        return Err(format!("官方安裝程式回報失敗（結束碼 {code}）"));
    }
    Ok(())
}

/// 真正的環境：ASN 自己的資料夾放下載檔，裝好的位置是使用者資料夾下的 `.local\bin\claude.exe`
pub fn install_here() -> Result<String, String> {
    let platform = platform()?;
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).ok_or_else(|| "找不到使用者資料夾".to_string())?;
    let final_exe = home.join(".local").join("bin").join("claude.exe");
    let work = crate::identity::relay_home().join("setup").join("downloads");
    let fetch = super::net::RealFetch;
    let sig = super::authenticode::SystemSignatureCheck;
    let exec = RealExec;
    install(&Deps { fetch: &fetch, sig: &sig, exec: &exec }, &work, platform, &final_exe)
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
    use std::collections::HashMap;

    const BIN: &[u8] = b"MZ fake claude binary";

    fn sum_of(b: &[u8]) -> String {
        hex(&Sha256::digest(b))
    }

    fn manifest_for(version: &str, platform: &str, body: &[u8]) -> String {
        format!(r#"{{"version":"{version}","platforms":{{"{platform}":{{"binary":"claude.exe","checksum":"{}","size":{}}}}}}}"#, sum_of(body), body.len())
    }

    #[derive(Default)]
    struct FakeFetch {
        texts: HashMap<String, String>,
        bins: HashMap<String, Vec<u8>>,
        log: RefCell<Vec<String>>,
    }
    impl Fetch for FakeFetch {
        fn get_text(&self, url: &str, _max: u64) -> Result<String, String> {
            self.log.borrow_mut().push(url.to_string());
            self.texts.get(url).cloned().ok_or_else(|| format!("沒有 {url}"))
        }
        fn download(&self, url: &str, out: &mut dyn Write, _max: u64) -> Result<u64, String> {
            self.log.borrow_mut().push(url.to_string());
            let b = self.bins.get(url).ok_or_else(|| format!("沒有 {url}"))?;
            out.write_all(b).map_err(|e| e.to_string())?;
            Ok(b.len() as u64)
        }
    }

    struct FakeSig {
        result: Result<String, String>,
        /// 驗「裝好的 claude.exe」時另外用的結果（None＝跟 result 一樣）
        final_result: Option<Result<String, String>>,
        final_exe: PathBuf,
        seen: RefCell<Vec<PathBuf>>,
    }
    impl SignatureCheck for FakeSig {
        fn signer(&self, path: &Path) -> Result<String, String> {
            self.seen.borrow_mut().push(path.to_path_buf());
            if path == self.final_exe {
                if let Some(r) = &self.final_result {
                    return r.clone();
                }
            }
            self.result.clone()
        }
    }

    struct FakeExec {
        code: Result<i32, String>,
        /// 執行當下檔案內容的雜湊，以及是否真的有被叫到
        ran: RefCell<Vec<(PathBuf, Vec<String>, Option<String>)>>,
        /// 讓「安裝好的 claude.exe」出現
        make: Option<PathBuf>,
        /// 裝好的 claude.exe 的 `--version` 輸出
        version: Result<String, String>,
    }
    impl Exec for FakeExec {
        fn run_installer(&self, exe: &Path, args: &[&str], _cwd: &Path, _t: Duration) -> Result<i32, String> {
            let content = std::fs::read(exe).ok().map(|b| sum_of(&b));
            self.ran.borrow_mut().push((exe.to_path_buf(), args.iter().map(|s| s.to_string()).collect(), content));
            if let Some(p) = &self.make {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, b"installed").unwrap();
            }
            self.code.clone()
        }
        fn version_output(&self, _exe: &Path, _t: Duration) -> Result<String, String> {
            self.version.clone()
        }
    }

    struct Rig {
        dir: tempfile::TempDir,
        fetch: FakeFetch,
        sig: FakeSig,
        exec: FakeExec,
        final_exe: PathBuf,
    }

    fn rig(body: &[u8], manifest_body: &[u8]) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let platform = "win32-x64";
        let mut fetch = FakeFetch::default();
        fetch.texts.insert(url_channel(), "2.1.316\n".into());
        fetch.texts.insert(url_manifest("2.1.316"), manifest_for("2.1.316", platform, manifest_body));
        fetch.bins.insert(url_binary("2.1.316", platform), body.to_vec());
        let final_exe = dir.path().join("home").join("claude.exe");
        Rig {
            fetch,
            sig: FakeSig { result: Ok(EXPECTED_SIGNER.into()), final_result: None, final_exe: final_exe.clone(), seen: RefCell::new(vec![]) },
            exec: FakeExec { code: Ok(0), ran: RefCell::new(vec![]), make: Some(final_exe.clone()), version: Ok("2.1.316 (Claude Code)
".into()) },
            final_exe,
            dir,
        }
    }

    fn run(r: &Rig) -> Result<String, String> {
        let work = r.dir.path().join("work");
        install(&Deps { fetch: &r.fetch, sig: &r.sig, exec: &r.exec }, &work, "win32-x64", &r.final_exe)
    }

    fn leftovers(r: &Rig) -> Vec<String> {
        std::fs::read_dir(r.dir.path().join("work")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()
    }

    #[test]
    fn 全部通過_驗過的就是跑的那個檔案_跑完清掉() {
        let r = rig(BIN, BIN);
        let msg = run(&r).unwrap();
        assert!(msg.contains("2.1.316"), "{msg}");
        let ran = r.exec.ran.borrow();
        assert_eq!(ran.len(), 1, "只執行一次");
        assert_eq!(ran[0].1, vec!["install".to_string(), "2.1.316".to_string()], "交給安裝程式的是驗過的確切版本號，不是頻道名");
        let seen = r.sig.seen.borrow();
        assert_eq!(seen[0], ran[0].0, "驗簽章的路徑就是執行的路徑");
        assert_eq!(seen[1], r.final_exe, "裝完還要驗裝好的 claude.exe");
        assert_eq!(seen.len(), 2);
        assert_eq!(ran[0].2.as_deref(), Some(sum_of(BIN).as_str()), "執行當下檔案內容就是驗過雜湊的那份");
        assert!(leftovers(&r).is_empty(), "跑完下載檔刪掉：{:?}", leftovers(&r));
    }

    #[test]
    fn 雜湊不符_不驗簽章不執行_檔案刪掉() {
        let r = rig(b"MZ fake claude binarX", BIN); // 長度相同、內容不同：下載的內容和清單寫的雜湊對不上
        let e = run(&r).unwrap_err();
        assert!(e.contains("雜湊"), "{e}");
        assert!(r.exec.ran.borrow().is_empty());
        assert!(r.sig.seen.borrow().is_empty());
        assert!(leftovers(&r).is_empty());
    }

    #[test]
    fn 簽署者不是_anthropic_不執行_檔案刪掉() {
        let mut r = rig(BIN, BIN);
        r.sig.result = Ok("Anthropic, PBC (fake)".into());
        let e = run(&r).unwrap_err();
        assert!(e.contains("簽署者"), "{e}");
        assert!(r.exec.ran.borrow().is_empty());
        assert!(leftovers(&r).is_empty());
        // 大小寫不同也不行：要完全相等
        r.sig.result = Ok("anthropic, pbc".into());
        assert!(run(&r).is_err());
        assert!(r.exec.ran.borrow().is_empty());
    }

    #[test]
    fn 簽章無效_不執行_檔案刪掉() {
        let mut r = rig(BIN, BIN);
        r.sig.result = Err("數位簽章驗證沒通過".into());
        let e = run(&r).unwrap_err();
        assert!(e.contains("簽章沒通過"), "{e}");
        assert!(r.exec.ran.borrow().is_empty());
        assert!(leftovers(&r).is_empty());
    }

    #[test]
    fn 安裝程式結束碼非零或逾時_回錯_檔案刪掉() {
        let mut r = rig(BIN, BIN);
        r.exec.code = Ok(3);
        let e = run(&r).unwrap_err();
        assert!(e.contains("結束碼 3"), "{e}");
        assert!(leftovers(&r).is_empty());
        r.exec.code = Err("官方安裝程式跑太久，已結束它".into());
        assert!(run(&r).unwrap_err().contains("跑太久"));
        assert!(leftovers(&r).is_empty());
    }

    #[test]
    fn 裝好的_claude_簽章或簽署者不對_不算成功() {
        let mut r = rig(BIN, BIN);
        r.sig.final_result = Some(Ok("Someone Else".into()));
        assert!(run(&r).unwrap_err().contains("簽署者"));
        r.sig.final_result = Some(Err("數位簽章驗證沒通過".into()));
        assert!(run(&r).unwrap_err().contains("簽章沒通過"));
    }

    #[test]
    fn 裝好的版本和驗過的不同或問不出來_不算成功() {
        let mut r = rig(BIN, BIN);
        r.exec.version = Ok("2.1.309 (Claude Code)".into());
        let e = run(&r).unwrap_err();
        assert!(e.contains("不一致") && e.contains("2.1.316"), "{e}");
        r.exec.version = Err("跑太久".into());
        assert!(run(&r).unwrap_err().contains("問不出"));
        r.exec.version = Ok("".into());
        assert!(run(&r).unwrap_err().contains("不一致"));
    }

    #[test]
    fn 版本輸出只認第一個字完全等於版本號() {
        assert!(version_matches("2.1.316 (Claude Code)
", "2.1.316"));
        assert!(version_matches("2.1.316", "2.1.316"));
        for bad in ["2.1.3160", "12.1.316", "v2.1.316", "x 2.1.316", "", "2.1.31"] {
            assert!(!version_matches(bad, "2.1.316"), "{bad:?}");
        }
    }

    #[test]
    fn 安裝逾時要留夠長_實測要花約_238_秒() {
        assert!(INSTALL_TIMEOUT >= Duration::from_secs(900), "{INSTALL_TIMEOUT:?}");
    }

    #[test]
    fn 取版本號走_stable_頻道() {
        assert_eq!(url_channel(), "https://downloads.claude.ai/claude-code-releases/stable");
    }

    #[test]
    fn 裝完找不到_claude_exe_不算成功() {
        let mut r = rig(BIN, BIN);
        r.exec.make = None;
        assert!(run(&r).unwrap_err().contains("找不到"));
    }

    #[test]
    fn 版本號只收數字點數字點數字() {
        for ok in ["2.1.316", "10.0.0"] {
            assert!(valid_version(ok), "{ok}");
        }
        for bad in ["", "latest", "2.1", "2.1.316-beta", "2.1.316\n", "../2.1.3", "2.1.3/../x", "<html>", "2.1.3.4", "2..3", "a.b.c", "1234567.1.1"] {
            assert!(!valid_version(bad), "{bad:?}");
        }
        let mut r = rig(BIN, BIN);
        r.fetch.texts.insert(url_channel(), "<html>error</html>".into());
        assert!(run(&r).unwrap_err().contains("版本號"));
        assert!(r.exec.ran.borrow().is_empty());
    }

    #[test]
    fn 清單不合格式就放棄() {
        let platform = "win32-x64";
        let ok = manifest_for("2.1.316", platform, BIN);
        assert!(parse_manifest(&ok, "2.1.316", platform).is_ok());
        assert!(parse_manifest(&ok, "2.1.317", platform).is_err(), "版本不符");
        assert!(parse_manifest(&ok, "2.1.316", "win32-arm64").is_err(), "沒有這個平台");
        assert!(parse_manifest("not json", "2.1.316", platform).is_err());
        let bad_sum = ok.replace(&sum_of(BIN), "XYZ");
        assert!(parse_manifest(&bad_sum, "2.1.316", platform).is_err(), "雜湊格式");
        let zero = ok.replace(&format!("\"size\":{}", BIN.len()), "\"size\":0");
        assert!(parse_manifest(&zero, "2.1.316", platform).is_err(), "大小為 0");
    }

    #[test]
    fn 只連官方網域() {
        let r = rig(BIN, BIN);
        run(&r).unwrap();
        let log = r.fetch.log.borrow();
        assert_eq!(log.len(), 3);
        assert!(log.iter().all(|u| u.starts_with("https://downloads.claude.ai/claude-code-releases/")), "{log:?}");
    }

    #[test]
    fn 下載大小和清單不符_放棄() {
        let mut r = rig(BIN, BIN);
        // 清單寫的大小比實際大
        let m = manifest_for("2.1.316", "win32-x64", BIN).replace(&format!("\"size\":{}", BIN.len()), &format!("\"size\":{}", BIN.len() + 5));
        r.fetch.texts.insert(url_manifest("2.1.316"), m);
        assert!(run(&r).unwrap_err().contains("大小"));
        assert!(r.exec.ran.borrow().is_empty());
        assert!(leftovers(&r).is_empty());
    }

    #[test]
    fn 上次留下的下載殘檔會先清掉() {
        let r = rig(BIN, BIN);
        let work = r.dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("claude-2.0.0-win32-x64.exe.part"), b"old").unwrap();
        std::fs::write(work.join("別人的檔案.txt"), b"keep").unwrap();
        run(&r).unwrap();
        assert_eq!(leftovers(&r), vec!["別人的檔案.txt".to_string()], "只清我們命名的");
    }

    #[test]
    fn 鎖住後重算的雜湊和清單不同_不驗簽章不執行() {
        // 模擬下載完到鎖住之間檔案被換成別的內容：此時手上的檔案雜湊對不上清單
        let r = rig(BIN, BIN);
        let work = r.dir.path().to_path_buf();
        let p = work.join("claude-swapped.exe");
        std::fs::write(&p, b"MZ swapped in between").unwrap();
        let guard = open_locked(&p).unwrap();
        let e = verify_then_run(&Deps { fetch: &r.fetch, sig: &r.sig, exec: &r.exec }, &guard, &p, &sum_of(BIN), "2.1.316", &work).unwrap_err();
        assert!(e.contains("被改動"), "{e}");
        assert!(r.sig.seen.borrow().is_empty());
        assert!(r.exec.ran.borrow().is_empty());
    }

    /// 連官方真的取版本號與清單（只讀、不下載執行檔、不安裝）：確認不跟轉址也取得到、格式讀得懂
    #[test]
    #[ignore = "需要網路；手動執行：cargo test --lib real_release_endpoints -- --ignored --nocapture"]
    fn real_release_endpoints() {
        let f = super::super::net::RealFetch;
        let v = f.get_text(&url_channel(), MAX_VERSION_BYTES).unwrap();
        let v = v.trim();
        assert!(valid_version(v), "{v}");
        let m = f.get_text(&url_manifest(v), MAX_MANIFEST_BYTES).unwrap();
        let (sum, size) = parse_manifest(&m, v, platform().unwrap_or("win32-x64")).unwrap();
        println!("version={v} size={size} sum_len={}", sum.len());
    }

    #[cfg(windows)]
    #[test]
    fn 鎖住之後別人改不了也刪不了() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.exe");
        std::fs::write(&p, b"abc").unwrap();
        let g = open_locked(&p).unwrap();
        assert!(std::fs::write(&p, b"evil").is_err(), "鎖住時不能寫");
        assert!(std::fs::remove_file(&p).is_err(), "鎖住時不能刪");
        assert_eq!(hash_open_file(&g).unwrap(), sum_of(b"abc"));
        drop(g);
        assert!(std::fs::remove_file(&p).is_ok());
    }
}
