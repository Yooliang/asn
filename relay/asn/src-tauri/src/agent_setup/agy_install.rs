//! 在 Windows 上安裝官方 agy（Antigravity CLI，Gemini 用）（#933 PR-4）。不跑官方腳本，照它的資料來源自己做：
//!   1. manifest 只連官方腳本寫死的那台主機、固定路徑 `/manifests/windows_amd64.json`（或 arm64）：取 version、url、sha512
//!   2. 執行檔網址必須在 `https://storage.googleapis.com/antigravity-public/antigravity-cli/` 底下（共用網域，主機＋路徑前綴都釘；
//!      路徑只收英數字與 . _ - /，不收 `..`、`?`、`#`、`%`）；兩者都不跟轉址
//!   3. 下載、比對 sha512、鎖檔重算、簽署者要**完全等於** `Google LLC`
//!   4. 從被鎖住的同一個檔複製到 `%LOCALAPPDATA%\ASN\tools\agy\agy.exe.new`，再驗一次（雜湊、簽署者、`--version` 印出驗過的版本），
//!      過了才換成 `agy.exe`。不分版本資料夾：agy 會在背景自己更新同一個檔
//! 不跑 `agy install`、不動 PATH（asn真 定案）。已經有官方的（`%LOCALAPPDATA%\agy\bin\agy.exe` 或 PATH 上的，簽署者是 Google LLC）就直接用。
//! 因為 agy 會自己更新，**每次要啟動 agy 之前都要重驗簽署者**：`usable_here()` 回傳前一定驗過，不能快取它的結果（`check_before_launch`）。
//!
//! 這一張只有流程與測試，還沒有任何入口呼叫它（清單仍是 manual、畫面沒有按鈕）；入口、偵測與開夥伴改用 `usable_here()` 在 PR-7 接上。
#![allow(dead_code)]

use super::authenticode::SignatureCheck;
use super::verified_install::{self as vi, version_in_output, Deps, HashAlgo, Record, Release, Spec};
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// manifest 的主機（官方 install.ps1 寫死的 Cloud Run 網址）
pub const MANIFEST_HOST: &str = "antigravity-cli-auto-updater-974169037036.us-central1.run.app";
pub const BIN_HOST: &str = "storage.googleapis.com";
pub const BIN_PREFIX: &str = "/antigravity-public/antigravity-cli/";
pub const EXPECTED_SIGNER: &str = "Google LLC";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// 實測 1.5.3 約 225 MB
const MAX_BINARY_BYTES: u64 = 600 * 1024 * 1024;
/// 記住裝好的版本（`tools\agy\version`，只寫版本號）。agy 自己更新後這裡會比實際舊，只用來寫記錄與畫面參考
const VERSION_FILE: &str = "version";

pub const SPEC: Spec = Spec { vendor: "agy", host: BIN_HOST, path_prefix: BIN_PREFIX, signer: EXPECTED_SIGNER, exe: "agy.exe", file_prefix: "agy", hash: HashAlgo::Sha512 };

pub fn platform() -> Result<&'static str, String> {
    if !cfg!(windows) {
        return Err("這個平台還沒有驗證式安裝".to_string());
    }
    if cfg!(target_arch = "x86_64") {
        Ok("windows_amd64")
    } else if cfg!(target_arch = "aarch64") {
        Ok("windows_arm64")
    } else {
        Err("agy 不支援這種處理器".to_string())
    }
}

/// manifest 網址：主機與路徑都寫死，平台只能是兩個固定值之一
fn manifest_url(platform: &str) -> Result<String, String> {
    match platform {
        "windows_amd64" | "windows_arm64" => Ok(format!("https://{MANIFEST_HOST}/manifests/{platform}.json")),
        _ => Err("agy 不支援這個平台".to_string()),
    }
}

/// manifest → Release。版本只收 `數字.數字.數字`；網址要在白名單內；sha512 格式要對
fn parse_manifest(text: &str, platform: &str) -> Result<Release, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "官方清單讀不懂".to_string())?;
    let version = v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if !vi::valid_version(&version) {
        return Err("官方回的版本號格式不對，已放棄安裝".to_string());
    }
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if !vi::url_allowed(&url, BIN_HOST, BIN_PREFIX) {
        return Err("官方清單指向不認得的下載位置，為了安全沒有安裝".to_string());
    }
    let sum = v.get("sha512").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
    if !HashAlgo::Sha512.valid_hex(&sum) {
        return Err("官方清單的雜湊格式不對".to_string());
    }
    Ok(Release { version, platform: platform.to_string(), url, sum, size: None, max: MAX_BINARY_BYTES })
}

fn resolve(d: &Deps, platform: &str) -> Result<Release, String> {
    let text = d.fetch.get_text(&manifest_url(platform)?, MAX_MANIFEST_BYTES)?;
    parse_manifest(&text, platform)
}

/// 驗證式安裝。`tools` 是 `%LOCALAPPDATA%\ASN\tools\agy`，`work` 是下載暫存資料夾
pub fn install_with_record(d: &Deps, tools: &Path, work: &Path, platform: &str) -> (Result<String, String>, Record) {
    let mut rec = Record::start(&SPEC);
    let r = install_inner(d, tools, work, platform, &mut rec);
    match &r {
        Ok(m) => {
            rec.ok = true;
            rec.detail = m.clone();
        }
        Err(e) => rec.detail = e.clone(),
    }
    (r, rec)
}

fn install_inner(d: &Deps, tools: &Path, work: &Path, platform: &str, rec: &mut Record) -> Result<String, String> {
    let rel = resolve(d, platform)?;
    rec.version = Some(rel.version.clone());
    let (path, mut guard) = vi::download_locked(d, &SPEC, &rel, work, "exe", rec)?;
    let new = tools.join("agy.exe.new");
    // 鎖住的下載檔：重算雜湊 → 驗簽署者 → 從同一個 handle 複製出去
    let copied = (|| -> Result<(), String> {
        if vi::hash_open_file(&guard, SPEC.hash)? != rel.sum {
            return Err("下載的 agy 在驗證前被改動，已放棄安裝".to_string());
        }
        let who = d.sig.signer(&path).map_err(|e| format!("agy 的數位簽章沒通過，已放棄安裝：{e}"))?;
        rec.signer = Some(who.clone());
        if who != EXPECTED_SIGNER {
            return Err(format!("agy 的簽署者不是 {EXPECTED_SIGNER}，已放棄安裝"));
        }
        std::fs::create_dir_all(tools).map_err(|e| format!("無法建立安裝資料夾：{e}"))?;
        guard.seek(SeekFrom::Start(0)).map_err(|e| format!("讀不了下載的 agy：{e}"))?;
        let mut out = std::fs::File::create(&new).map_err(|e| format!("無法寫入 agy：{e}"))?;
        std::io::copy(&mut &guard, &mut out).map_err(|e| format!("無法寫入 agy：{e}"))?;
        Ok(())
    })();
    vi::discard(&path, guard);
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    // 複製出來的那份再驗一次（鎖著驗雜湊與簽署者、跑 --version），過了才換上
    let checked = (|| -> Result<(), String> {
        let g = vi::open_locked(&new)?;
        if vi::hash_open_file(&g, SPEC.hash)? != rel.sum {
            return Err("複製出來的 agy 和驗過的不一樣，已放棄安裝".to_string());
        }
        check_before_launch(d.sig, &new)?;
        drop(g);
        match d.exec.version_output(&new, vi::VERSION_TIMEOUT) {
            Ok(out) if version_in_output(&out, &rel.version) => Ok(()),
            Ok(_) => Err(format!("裝好的 agy 版本和驗證過的 {} 不一致，沒有算成功", rel.version)),
            Err(e) => Err(format!("問不出裝好的 agy 的版本：{e}")),
        }
    })();
    if let Err(e) = checked {
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    let exe = tools.join("agy.exe");
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::remove_file(&new);
        return Err(format!("無法換上新的 agy（可能正在執行，請先關掉用到 Gemini 的夥伴再試）：{e}"));
    }
    let _ = std::fs::write(tools.join(VERSION_FILE), &rel.version);
    Ok(format!("已安裝 agy {}。", rel.version))
}

/// 啟動 agy 之前一定要呼叫：簽署者必須完全等於 Google LLC。agy 會在背景自己更新，所以不能只信安裝那一次
pub fn check_before_launch(sig: &dyn SignatureCheck, exe: &Path) -> Result<(), String> {
    match sig.signer(exe) {
        Ok(who) if who == EXPECTED_SIGNER => Ok(()),
        Ok(_) => Err(format!("agy 的簽署者不是 {EXPECTED_SIGNER}，可能被換過，已停止啟動。請到設定重新安裝 agy。")),
        Err(e) => Err(format!("agy 的數位簽章沒通過，可能被換過，已停止啟動。請到設定重新安裝 agy。（{e}）")),
    }
}

/// 找得到、而且這一刻驗得過簽章的 agy：先官方的（`<LOCALAPPDATA>\agy\bin\agy.exe`、再 PATH），最後 ASN 裝的。
/// 每次呼叫都重驗，結果不能快取
pub fn usable_in(sig: &dyn SignatureCheck, local_app_data: Option<&Path>, path_dirs: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = vec![];
    if let Some(l) = local_app_data {
        cands.push(l.join("agy").join("bin").join("agy.exe"));
    }
    cands.extend(path_dirs.map(|d| d.join("agy.exe")));
    if let Some(l) = local_app_data {
        cands.push(l.join("ASN").join("tools").join("agy").join("agy.exe"));
    }
    cands.into_iter().find(|p| p.is_file() && check_before_launch(sig, p).is_ok())
}

/// 真正的環境
pub fn usable_here() -> Option<PathBuf> {
    let la = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    usable_in(&super::authenticode::SystemSignatureCheck, la.as_deref(), dirs.into_iter())
}

/// 真正的環境。已有官方的 agy 就直接用、不另外裝（不寫安裝記錄，因為沒有安裝）；其餘每次嘗試都寫記錄
pub fn install_here() -> Result<String, String> {
    let _busy = vi::InstallBusy::take()?;
    let platform = platform()?;
    let la = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or_else(|| "找不到 LOCALAPPDATA 資料夾".to_string())?;
    let sig = super::authenticode::SystemSignatureCheck;
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    // 官方的（不含 ASN 自己裝的那份：那份要能重裝）
    let official = std::iter::once(la.join("agy").join("bin").join("agy.exe")).chain(dirs.into_iter().map(|d| d.join("agy.exe"))).find(|p| p.is_file() && check_before_launch(&sig, p).is_ok());
    if let Some(p) = official {
        return Ok(format!("這台已經有官方裝好的 agy（{}），直接用它，不另外安裝。", p.display()));
    }
    let tools = la.join("ASN").join("tools").join("agy");
    let setup = crate::identity::relay_home().join("setup");
    let fetch = super::net::RealFetch;
    let exec = vi::RealExec;
    let (r, rec) = install_with_record(&Deps { fetch: &fetch, sig: &sig, exec: &exec }, &tools, &setup.join("downloads"), platform);
    vi::write_record(&setup, &rec);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_setup::net::Fetch;
    use crate::agent_setup::verified_install::Exec;
    use sha2::{Digest, Sha512};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::io::Write;
    use std::time::Duration;

    const P: &str = "windows_amd64";
    const V: &str = "1.5.3";
    const BIN: &[u8] = b"MZ fake agy";
    const URL: &str = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.3-6604829099950080/windows-x64/cli_windows_x64.exe";

    fn sum(b: &[u8]) -> String {
        vi::hex(&Sha512::digest(b))
    }
    fn manifest(version: &str, url: &str, s: &str) -> String {
        format!(r#"{{"version":"{version}","url":"{url}","sha512":"{s}"}}"#)
    }

    #[derive(Default)]
    struct FakeFetch {
        texts: HashMap<String, String>,
        bins: HashMap<String, Vec<u8>>,
        log: RefCell<Vec<String>>,
    }
    impl Fetch for FakeFetch {
        fn get_text(&self, url: &str, _m: u64) -> Result<String, String> {
            self.log.borrow_mut().push(url.into());
            self.texts.get(url).cloned().ok_or_else(|| format!("沒有 {url}"))
        }
        fn download(&self, url: &str, out: &mut dyn Write, _m: u64) -> Result<u64, String> {
            self.log.borrow_mut().push(url.into());
            let b = self.bins.get(url).ok_or_else(|| format!("沒有 {url}"))?;
            out.write_all(b).map_err(|e| e.to_string())?;
            Ok(b.len() as u64)
        }
    }
    struct FakeSig(RefCell<Vec<Result<String, String>>>, Result<String, String>);
    impl SignatureCheck for FakeSig {
        /// 依序回 `0` 裡的結果，用完之後都回 `1`
        fn signer(&self, _p: &Path) -> Result<String, String> {
            let mut q = self.0.borrow_mut();
            if q.is_empty() {
                self.1.clone()
            } else {
                q.remove(0)
            }
        }
    }
    fn google() -> FakeSig {
        FakeSig(RefCell::new(vec![]), Ok(EXPECTED_SIGNER.into()))
    }
    struct FakeExec(Result<String, String>);
    impl Exec for FakeExec {
        fn run_installer(&self, _e: &Path, _a: &[&str], _c: &Path, _t: Duration) -> Result<i32, String> {
            panic!("agy 不執行安裝程式（不跑 agy install）")
        }
        fn version_output(&self, _e: &Path, _t: Duration) -> Result<String, String> {
            self.0.clone()
        }
    }

    struct Rig {
        dir: tempfile::TempDir,
        fetch: FakeFetch,
        sig: FakeSig,
        exec: FakeExec,
    }
    fn rig() -> Rig {
        let mut fetch = FakeFetch::default();
        fetch.texts.insert(manifest_url(P).unwrap(), manifest(V, URL, &sum(BIN)));
        fetch.bins.insert(URL.into(), BIN.to_vec());
        Rig { dir: tempfile::tempdir().unwrap(), fetch, sig: google(), exec: FakeExec(Ok(format!("{V}\n"))) }
    }
    fn tools(r: &Rig) -> PathBuf {
        r.dir.path().join("tools")
    }
    fn run(r: &Rig) -> (Result<String, String>, Record) {
        install_with_record(&Deps { fetch: &r.fetch, sig: &r.sig, exec: &r.exec }, &tools(r), &r.dir.path().join("work"), P)
    }

    #[test]
    fn 全部通過_換上_agy_exe_記住版本_記錄帶雜湊簽署者() {
        let r = rig();
        let (res, rec) = run(&r);
        assert_eq!(res.unwrap(), format!("已安裝 agy {V}。"));
        assert_eq!(std::fs::read(tools(&r).join("agy.exe")).unwrap(), BIN, "換上的就是驗過的內容");
        assert!(!tools(&r).join("agy.exe.new").exists());
        assert_eq!(std::fs::read_to_string(tools(&r).join(VERSION_FILE)).unwrap(), V);
        assert!(std::fs::read_dir(r.dir.path().join("work")).unwrap().next().is_none(), "下載檔要刪掉");
        assert!(rec.ok && rec.sum.as_deref() == Some(sum(BIN).as_str()) && rec.signer.as_deref() == Some(EXPECTED_SIGNER));
        assert!(rec.line().contains("sha512=") && rec.line().contains("來源=storage.googleapis.com"));
        let log = r.fetch.log.borrow();
        assert_eq!(*log, vec![manifest_url(P).unwrap(), URL.to_string()]);
    }

    #[test]
    fn manifest_網址主機與路徑寫死() {
        assert_eq!(manifest_url("windows_amd64").unwrap(), "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json");
        assert_eq!(manifest_url("windows_arm64").unwrap(), "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_arm64.json");
        for bad in ["linux_amd64", "../x", "windows_amd64.json", ""] {
            assert!(manifest_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn manifest_的網址版本雜湊不合格就放棄_不下載() {
        let s = sum(BIN);
        for (why, m) in [
            ("別人的 bucket", manifest(V, "https://storage.googleapis.com/evil/antigravity-cli/x.exe", &s)),
            ("百分比編碼", manifest(V, "https://storage.googleapis.com/antigravity-public/antigravity-cli/%2e%2e/x.exe", &s)),
            ("..", manifest(V, "https://storage.googleapis.com/antigravity-public/antigravity-cli/../x.exe", &s)),
            ("查詢字串", manifest(V, &format!("{URL}?alt=media"), &s)),
            ("別的主機", manifest(V, "https://evil.example/antigravity-public/antigravity-cli/x.exe", &s)),
            ("版本", manifest("1.5.3-beta", URL, &s)),
            ("雜湊長度", manifest(V, URL, &"a".repeat(64))),
            ("不是 JSON", "<html>".to_string()),
        ] {
            let mut r = rig();
            r.fetch.texts.insert(manifest_url(P).unwrap(), m);
            assert!(run(&r).0.is_err(), "{why}");
            assert_eq!(r.fetch.log.borrow().len(), 1, "{why}：只取了 manifest，沒下載");
            assert!(!tools(&r).join("agy.exe").exists(), "{why}");
        }
    }

    #[test]
    fn 雜湊不符或簽署者不是_google_就不換上() {
        let mut r = rig();
        r.fetch.bins.insert(URL.into(), b"MZ other".to_vec());
        assert!(run(&r).0.unwrap_err().contains("雜湊"));
        assert!(!tools(&r).join("agy.exe").exists());
        for bad in [Ok("Google LLC (fake)".to_string()), Ok("google llc".to_string()), Err("沒有簽章".to_string())] {
            let mut r = rig();
            r.sig = FakeSig(RefCell::new(vec![bad.clone()]), Ok(EXPECTED_SIGNER.into()));
            let (res, rec) = run(&r);
            assert!(res.is_err(), "{bad:?}");
            assert!(!rec.ok);
            assert!(!tools(&r).join("agy.exe").exists() && !tools(&r).join("agy.exe.new").exists(), "{bad:?}");
        }
        // 下載的那份驗過，但複製出來的那份簽章不對（第二次驗）
        let mut r = rig();
        r.sig = FakeSig(RefCell::new(vec![Ok(EXPECTED_SIGNER.into()), Ok("Someone Else".into())]), Ok(EXPECTED_SIGNER.into()));
        assert!(run(&r).0.is_err());
        assert!(!tools(&r).join("agy.exe").exists() && !tools(&r).join("agy.exe.new").exists());
    }

    #[test]
    fn 版本對不上或問不出來_不換上_舊的留著() {
        for out in [Ok("1.5.2".to_string()), Ok("".to_string()), Err("跑不起來".to_string())] {
            let mut r = rig();
            std::fs::create_dir_all(tools(&r)).unwrap();
            std::fs::write(tools(&r).join("agy.exe"), b"MZ old").unwrap();
            r.exec = FakeExec(out.clone());
            assert!(run(&r).0.is_err(), "{out:?}");
            assert_eq!(std::fs::read(tools(&r).join("agy.exe")).unwrap(), b"MZ old", "{out:?}：舊的不能被動");
            assert!(!tools(&r).join("agy.exe.new").exists());
        }
    }

    #[test]
    fn 啟動前重驗簽署者_要完全等於_google_llc() {
        let p = Path::new("agy.exe");
        assert!(check_before_launch(&google(), p).is_ok());
        for bad in [Ok("Google LLC ".to_string()), Ok("Someone".to_string()), Err("壞了".to_string())] {
            let e = check_before_launch(&FakeSig(RefCell::new(vec![]), bad.clone()), p).unwrap_err();
            assert!(e.contains("已停止啟動") && e.contains("重新安裝"), "{bad:?}：{e}");
        }
    }

    #[test]
    fn 找可用的_agy_官方優先_每個都要當下驗得過() {
        let d = tempfile::tempdir().unwrap();
        let la = d.path().join("la");
        let off = la.join("agy").join("bin");
        let asn = la.join("ASN").join("tools").join("agy");
        let pathdir = d.path().join("p");
        for x in [&off, &asn, &pathdir] {
            std::fs::create_dir_all(x).unwrap();
        }
        assert_eq!(usable_in(&google(), Some(&la), std::iter::empty()), None);
        std::fs::write(asn.join("agy.exe"), b"MZ").unwrap();
        assert_eq!(usable_in(&google(), Some(&la), std::iter::empty()), Some(asn.join("agy.exe")));
        std::fs::write(pathdir.join("agy.exe"), b"MZ").unwrap();
        assert_eq!(usable_in(&google(), Some(&la), [pathdir.clone()].into_iter()), Some(pathdir.join("agy.exe")));
        std::fs::write(off.join("agy.exe"), b"MZ").unwrap();
        assert_eq!(usable_in(&google(), Some(&la), [pathdir.clone()].into_iter()), Some(off.join("agy.exe")), "官方預設位置最優先");
        // 官方那份簽章不對 → 跳過它，用下一個驗得過的
        let s = FakeSig(RefCell::new(vec![Ok("Someone".into())]), Ok(EXPECTED_SIGNER.into()));
        assert_eq!(usable_in(&s, Some(&la), [pathdir.clone()].into_iter()), Some(pathdir.join("agy.exe")));
        // 全部都驗不過 → 沒有
        let none = FakeSig(RefCell::new(vec![]), Err("壞了".into()));
        assert_eq!(usable_in(&none, Some(&la), [pathdir].into_iter()), None);
    }

    #[test]
    fn 不跑_agy_install_也不動_path() {
        let src = include_str!("agy_install.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let code: String = body.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        assert!(!code.contains("run_installer"), "不執行任何安裝程式");
        assert!(!code.contains("set_var") && !code.contains("Environment") && !code.contains("HKEY"), "不改環境變數或登錄檔");
    }

    /// 連官方真的取 manifest（只讀、不下載執行檔、不安裝）
    #[test]
    #[ignore = "需要網路；手動執行：cargo test --lib agy_real_manifest -- --ignored --nocapture"]
    fn agy_real_manifest() {
        let f = super::super::net::RealFetch;
        let s = super::super::authenticode::SystemSignatureCheck;
        let e = vi::RealExec;
        let r = resolve(&Deps { fetch: &f, sig: &s, exec: &e }, P).unwrap();
        println!("version={} url={} sum_len={}", r.version, r.url, r.sum.len());
    }
}
