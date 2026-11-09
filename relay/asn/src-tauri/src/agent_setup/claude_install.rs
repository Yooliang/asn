//! 在 Windows 上安裝官方 Claude Code：取代過去的「下載官方腳本直接執行」。
//! 做的事和官方安裝腳本一樣（下載版本號與清單、下載執行檔、比對 sha256、執行 `claude.exe install`），
//! 驗證流程在共用的 `verified_install`（#933 PR-2）：鎖檔後重算雜湊、驗數位簽章（簽署者必須完全等於 `Anthropic, PBC`）、
//! 執行同一個檔、裝完再驗裝出來的 `claude.exe`。這裡只放 Claude 自己的部分：頻道、清單格式、網址、平台。
//! 版本從 `stable` 頻道取，執行時把驗過的確切版本號交給安裝程式（不只寫頻道名）。
//! 全程只連 `downloads.claude.ai`，不跟轉址。

#[allow(unused_imports)]
use super::authenticode::SignatureCheck;
#[allow(unused_imports)]
use super::net::Fetch;
pub use super::verified_install::{valid_version, BrokenKind, Deps, Existing, RealExec};
#[allow(unused_imports)]
use super::verified_install::{hex, open_locked, take_flag, version_matches, Exec, HashAlgo, InstallBusy, Record, Release, Spec};
use super::verified_install as vi;
use std::fs::File;
#[allow(unused_imports)]
use std::io::Write;
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

/// Claude Code 的固定資料（網域、簽署者、檔名、雜湊演算法）
pub const SPEC: Spec = Spec { vendor: "Claude Code", host: "downloads.claude.ai", signer: EXPECTED_SIGNER, exe: "claude.exe", file_prefix: "claude", hash: HashAlgo::Sha256 };

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

/// 清單裡這個平台的雜湊與大小
fn parse_manifest(text: &str, version: &str, platform: &str) -> Result<(String, u64), String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "官方清單讀不懂".to_string())?;
    if v.get("version").and_then(|x| x.as_str()) != Some(version) {
        return Err("官方清單的版本和最新版本對不上".to_string());
    }
    let p = v.get("platforms").and_then(|x| x.get(platform)).ok_or_else(|| "官方清單裡沒有這個平台".to_string())?;
    let sum = p.get("checksum").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
    if !SPEC.hash.valid_hex(&sum) {
        return Err("官方清單的雜湊格式不對".to_string());
    }
    let size = p.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
    if size == 0 || size > MAX_BINARY_BYTES {
        return Err("官方清單的檔案大小不合理".to_string());
    }
    Ok((sum, size))
}

#[allow(dead_code)]
fn hash_open_file(f: &File) -> Result<String, String> {
    vi::hash_open_file(f, SPEC.hash)
}

/// 從官方頻道與清單解析出這一次要裝的版本
fn resolve(d: &Deps, platform: &str) -> Result<Release, String> {
    let version = d.fetch.get_text(&url_channel(), MAX_VERSION_BYTES)?.trim().to_string();
    if !valid_version(&version) {
        return Err("官方回的版本號格式不對，已放棄安裝".to_string());
    }
    let manifest = d.fetch.get_text(&url_manifest(&version), MAX_MANIFEST_BYTES)?;
    let (sum, size) = parse_manifest(&manifest, &version, platform)?;
    Ok(Release { url: url_binary(&version, platform), version, platform: platform.to_string(), sum, size })
}

/// 驗證式安裝，連同安裝記錄一起回。`work` 是 ASN 自己的下載資料夾，`final_exe` 是安裝完該出現的 `claude.exe`
pub fn install_with_record(d: &Deps, work: &Path, platform: &str, final_exe: &Path) -> (Result<String, String>, Record) {
    let rel = match resolve(d, platform) {
        Ok(r) => r,
        Err(e) => {
            let mut rec = Record::start(&SPEC);
            rec.detail = e.clone();
            return (Err(e), rec);
        }
    };
    // 把驗過的確切版本號交給安裝程式：取版本號之後頻道剛好更新，裝的也還是驗過的這一版
    let args = ["install", rel.version.as_str()];
    vi::install(d, &SPEC, &rel, &args, work, final_exe, INSTALL_TIMEOUT)
}

/// 驗證式安裝（不需要記錄的呼叫端用；目前只有測試）
#[allow(dead_code)]
pub fn install(d: &Deps, work: &Path, platform: &str, final_exe: &Path) -> Result<String, String> {
    install_with_record(d, work, platform, final_exe).0
}

#[allow(dead_code)]
fn verify_then_run(d: &Deps, guard: &File, path: &Path, want_sum: &str, version: &str, work: &Path) -> Result<(), String> {
    let mut rec = Record::start(&SPEC);
    vi::verify_then_run(d, &SPEC, guard, path, want_sum, &["install", version], work, INSTALL_TIMEOUT, &mut rec)
}

/// 安裝記錄放在 ASN 自己的資料夾（和下載暫存同一層）：`setup\install.log`
fn record_dir() -> PathBuf {
    crate::identity::relay_home().join("setup")
}

/// 真正的環境：ASN 自己的資料夾放下載檔，裝好的位置是使用者資料夾下的 `.local\bin\claude.exe`
pub fn install_here() -> Result<String, String> {
    // 兩條路（設定的一鍵安裝、agent_tools 的安裝鈕）都會到這裡：同一時間只允許一個，不然會同時下載、同時動同一個檔案
    let _busy = InstallBusy::take()?;
    let platform = platform()?;
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).ok_or_else(|| "找不到使用者資料夾".to_string())?;
    let final_exe = home.join(".local").join("bin").join("claude.exe");
    let work = record_dir().join("downloads");
    let fetch = super::net::RealFetch;
    let sig = super::authenticode::SystemSignatureCheck;
    let exec = RealExec;
    let (r, rec) = install_with_record(&Deps { fetch: &fetch, sig: &sig, exec: &exec }, &work, platform, &final_exe);
    vi::write_record(&record_dir(), &rec);
    r
}

pub fn inspect(d: &Deps, final_exe: &Path) -> Existing {
    vi::inspect(d, &SPEC, final_exe)
}

pub fn inspect_here() -> Existing {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from) else {
        return Existing::Broken(BrokenKind::CannotRun, "找不到使用者資料夾".to_string());
    };
    let final_exe = home.join(".local").join("bin").join("claude.exe");
    inspect(&Deps { fetch: &super::net::RealFetch, sig: &super::authenticode::SystemSignatureCheck, exec: &RealExec }, &final_exe)
}

/// 在給定的資料夾裡找 claude 的執行檔或啟動腳本，**只看檔案在不在，不執行任何東西**（npm 等別的方式裝的 claude 會在這裡被找到）
pub fn find_on_path_in(dirs: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    const NAMES: [&str; 5] = ["claude.exe", "claude.cmd", "claude.bat", "claude.ps1", "claude"];
    for d in dirs {
        for n in NAMES {
            let p = d.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub fn find_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    find_on_path_in(std::env::split_paths(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
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

#[cfg(test)]
mod inspect_tests {
    use super::*;
    use std::io::Write as _;

    struct Sig(Result<&'static str, &'static str>);
    impl SignatureCheck for Sig {
        fn signer(&self, _p: &Path) -> Result<String, String> {
            self.0.map(|s| s.to_string()).map_err(|e| e.to_string())
        }
    }
    struct Ver(Result<&'static str, &'static str>);
    impl Exec for Ver {
        fn run_installer(&self, _e: &Path, _a: &[&str], _c: &Path, _t: Duration) -> Result<i32, String> {
            panic!("檢查現況不能執行安裝程式")
        }
        fn version_output(&self, _e: &Path, _t: Duration) -> Result<String, String> {
            self.0.map(|s| s.to_string()).map_err(|e| e.to_string())
        }
    }
    struct NoNet;
    impl Fetch for NoNet {
        fn get_text(&self, _u: &str, _m: u64) -> Result<String, String> {
            panic!("檢查現況不能上網")
        }
        fn download(&self, _u: &str, _o: &mut dyn Write, _m: u64) -> Result<u64, String> {
            panic!("檢查現況不能上網")
        }
    }

    fn run(file: bool, sig: Result<&'static str, &'static str>, ver: Result<&'static str, &'static str>) -> Existing {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("claude.exe");
        if file {
            std::fs::File::create(&exe).unwrap().write_all(b"MZ").unwrap();
        }
        inspect(&Deps { fetch: &NoNet, sig: &Sig(sig), exec: &Ver(ver) }, &exe)
    }

    #[test]
    fn 現況分三種() {
        assert_eq!(run(false, Ok(EXPECTED_SIGNER), Ok("2.1.309 (Claude Code)")), Existing::Missing);
        // 版本不用等於頻道的版本：自動更新過的新版一樣算好
        assert_eq!(run(true, Ok(EXPECTED_SIGNER), Ok("2.1.316 (Claude Code)")), Existing::Healthy("2.1.316".to_string()));
        // 簽章或簽署者不對＝可能被換過；簽章好但跑不出版本＝跑不起來
        assert!(matches!(run(true, Ok("Someone Else"), Ok("2.1.309")), Existing::Broken(BrokenKind::BadSignature, _)));
        assert!(matches!(run(true, Err("簽章無效"), Ok("2.1.309")), Existing::Broken(BrokenKind::BadSignature, _)));
        assert!(matches!(run(true, Ok(EXPECTED_SIGNER), Err("跑不起來")), Existing::Broken(BrokenKind::CannotRun, _)));
        assert!(matches!(run(true, Ok(EXPECTED_SIGNER), Ok("not a version")), Existing::Broken(BrokenKind::CannotRun, _)));
        assert!(matches!(run(true, Ok(EXPECTED_SIGNER), Ok("")), Existing::Broken(BrokenKind::CannotRun, _)));
    }

    #[test]
    fn 掃_path_只找路徑_找得到各種寫法的_claude() {
        let dir = tempfile::tempdir().unwrap();
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(find_on_path_in([empty.path().to_path_buf()].into_iter()), None);
        for name in ["claude.cmd", "claude.ps1", "claude.exe"] {
            let d = tempfile::tempdir().unwrap();
            std::fs::File::create(d.path().join(name)).unwrap().write_all(b"not executed").unwrap();
            assert_eq!(find_on_path_in([empty.path().to_path_buf(), d.path().to_path_buf()].into_iter()), Some(d.path().join(name)), "{name}");
        }
        // 資料夾同名不算
        std::fs::create_dir(dir.path().join("claude.exe")).unwrap();
        assert_eq!(find_on_path_in([dir.path().to_path_buf()].into_iter()), None);
    }

    #[test]
    fn 安裝的鎖_第二個被擋_放掉後可再取() {
        let flag = std::sync::atomic::AtomicBool::new(false);
        assert!(take_flag(&flag).is_ok());
        assert!(take_flag(&flag).unwrap_err().contains("已經有"));
        flag.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(take_flag(&flag).is_ok());
    }

    /// 兩條安裝的路都經過 install_here；鎖要放在 install_here 裡面，不能只放在其中一條路
    #[test]
    fn 守門_鎖在_install_here_裡() {
        let src = include_str!("claude_install.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let at = body.find("pub fn install_here()").unwrap();
        assert!(body[at..].contains("InstallBusy::take()?"), "install_here 一開始就要取鎖");
    }

    /// 每次安裝（成功或失敗）都要寫進安裝記錄（#933 第 5 節第 5 點）：install_here 裡用 install_with_record，結果回去之前先寫
    #[test]
    fn 守門_install_here_每次都寫安裝記錄() {
        let src = include_str!("claude_install.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let at = body.find("pub fn install_here()").unwrap();
        let f = &body[at..at + body[at..].find("\n}\n").or_else(|| body[at..].find("\n}\r\n")).unwrap()];
        let rec = f.find("install_with_record(").expect("要用 install_with_record");
        let write = f.find("vi::write_record(&record_dir(), &rec)").expect("要寫記錄");
        assert!(rec < write);
        assert!(!f[write..].contains('?'), "寫完記錄之後不能再有提早離開的路");
    }

    #[test]
    fn 安裝記錄帶版本雜湊簽署者_取不到版本也有一筆失敗記錄() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("claude.exe");
        struct Down;
        impl Fetch for Down {
            fn get_text(&self, _u: &str, _m: u64) -> Result<String, String> {
                Err("連不上".into())
            }
            fn download(&self, _u: &str, _o: &mut dyn Write, _m: u64) -> Result<u64, String> {
                Err("連不上".into())
            }
        }
        let (r, rec) = install_with_record(&Deps { fetch: &Down, sig: &Sig(Ok(EXPECTED_SIGNER)), exec: &Ver(Ok("2.1.316")) }, dir.path(), "win32-x64", &exe);
        assert!(r.is_err());
        assert!(!rec.ok);
        let line = rec.line();
        assert!(line.contains("廠商=Claude Code") && line.contains("來源=downloads.claude.ai") && line.contains("結果=失敗：連不上"), "{line}");
    }
}
