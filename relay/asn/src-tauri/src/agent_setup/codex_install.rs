//! 在 Windows 上安裝官方 Codex CLI（#933 PR-3）。不跑官方腳本，照它的資料來源自己做：
//!   1. 只連 `releases.openai.com`（不跟轉址、不退回 GitHub）：`codex/channels/latest` 取版本與各檔的 sha256
//!   2. 套件 `codex-package-<target>.tar.gz` 的雜湊要和 metadata、`codex-package_SHA256SUMS`、實際算出的三方一致
//!   3. 解到暫存資料夾（只收一般檔案與資料夾；不收連結、絕對路徑、`..`；最多 200 項、600 MB）
//!   4. 包裡每個 exe／dll 的簽署者都要**完全等於** `OpenAI OpCo, LLC`，只有寫死的兩個例外（`EXCEPTIONS`）；
//!      腳本類檔案（ps1、bat…）出現就整包不裝；必須有 `bin\codex.exe`
//!   5. `bin\codex.exe --version` 要看得到驗過的版本號，全部過了才改名就位到 `%LOCALAPPDATA%\ASN\tools\codex\<版本>\`
//! 不動 `~\.codex`、不動使用者的 PATH，ASN 自己記住裝好的位置（asn真 定案）。這台已經有官方裝好的 codex
//! （PATH 上的 codex.exe 簽署者是 OpenAI OpCo, LLC）就直接用它，不另外裝一份。「更新」這版不做。
//! 每次實際嘗試安裝都寫一筆安裝記錄（`verified_install::Record`）。
//!
//! 這一張只有流程與測試，**還沒有任何入口呼叫它**（清單仍是 manual、`agent_tools` 不分派、畫面沒有按鈕）：
//! 入口、偵測與開夥伴改用 `usable_here()` 在 PR-7 接上，所以先關掉「沒用到」的警告。
#![allow(dead_code)]

use super::verified_install::{self as vi, Deps, HashAlgo, Record, Release, Spec};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

pub const HOST: &str = "releases.openai.com";
pub const BASE: &str = "https://releases.openai.com/codex";
pub const EXPECTED_SIGNER: &str = "OpenAI OpCo, LLC";
/// `codex-resources\voice\bin\vcruntime140.dll` 的簽署者（40家用 實測 0.167.0 讀到的字串）
pub const MICROSOFT_SIGNER: &str = "Microsoft Windows";
const SUMS_ASSET: &str = "codex-package_SHA256SUMS";
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_SUMS_BYTES: u64 = 64 * 1024;
/// 實測 0.167.0 的套件約 201 MB
const MAX_ARCHIVE_BYTES: u64 = 400 * 1024 * 1024;
const MAX_ENTRIES: usize = 200;
const MAX_UNPACKED_BYTES: u64 = 600 * 1024 * 1024;

pub const SPEC: Spec = Spec { vendor: "Codex", host: HOST, path_prefix: "/codex/releases/", signer: EXPECTED_SIGNER, exe: "codex.exe", file_prefix: "codex", hash: HashAlgo::Sha256 };

/// 簽章例外：寫死在程式裡，不能從清單或設定檔傳進來（asn真 定案）。路徑以 `/` 分隔、相對於套件根目錄
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exception {
    /// 允許沒有簽章，只靠壓縮檔的雜湊把關
    Unsigned,
    /// 簽署者必須完全等於這個名稱
    Signer(&'static str),
}
pub const EXCEPTIONS: [(&str, Exception); 2] = [("codex-path/rg.exe", Exception::Unsigned), ("codex-resources/voice/bin/vcruntime140.dll", Exception::Signer(MICROSOFT_SIGNER))];

/// 要驗簽章的副檔名
const SIGNED_EXT: [&str; 8] = ["exe", "dll", "sys", "ocx", "cpl", "scr", "node", "com"];
/// 出現就整包不裝的副檔名（套件裡不該有腳本或安裝程式）
const FORBIDDEN_EXT: [&str; 12] = ["ps1", "psm1", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "hta", "msi", "lnk"];

pub fn target() -> Result<&'static str, String> {
    if !cfg!(windows) {
        return Err("這個平台還沒有驗證式安裝".to_string());
    }
    if cfg!(target_arch = "x86_64") {
        Ok("x86_64-pc-windows-msvc")
    } else if cfg!(target_arch = "aarch64") {
        Ok("aarch64-pc-windows-msvc")
    } else {
        Err("Codex 不支援這種處理器".to_string())
    }
}

fn url_latest() -> String {
    format!("{BASE}/channels/latest")
}
fn package_asset(target: &str) -> String {
    format!("codex-package-{target}.tar.gz")
}
fn asset_url(version: &str, asset: &str) -> String {
    format!("{BASE}/releases/{version}/{asset}")
}

/// metadata 裡某個檔的 sha256（`sha256:<64 位十六進位>`）；下載網址必須完全等於我們自己組出來的那個
fn asset_sum(v: &serde_json::Value, name: &str, version: &str) -> Result<String, String> {
    let a = v.get("assets").and_then(|x| x.as_array()).and_then(|arr| arr.iter().find(|a| a.get("name").and_then(|n| n.as_str()) == Some(name))).ok_or_else(|| format!("官方清單裡沒有 {name}"))?;
    let url = a.get("browser_download_url").and_then(|x| x.as_str()).unwrap_or("");
    if url != asset_url(version, name) {
        return Err("官方清單指向不認得的下載位置，為了安全沒有安裝".to_string());
    }
    let d = a.get("digest").and_then(|x| x.as_str()).unwrap_or("");
    let sum = d.strip_prefix("sha256:").unwrap_or("").to_ascii_lowercase();
    if !HashAlgo::Sha256.valid_hex(&sum) {
        return Err("官方清單的雜湊格式不對".to_string());
    }
    Ok(sum)
}

/// `channels/latest` → （版本號, 套件雜湊）。版本取自 `tag_name`（`rust-v<版本>`），只收 `數字.數字.數字`
fn parse_latest(text: &str, target: &str) -> Result<(String, String), String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "官方清單讀不懂".to_string())?;
    let tag = v.get("tag_name").and_then(|x| x.as_str()).unwrap_or("");
    let version = tag.strip_prefix("rust-v").unwrap_or("").to_string();
    if !vi::valid_version(&version) {
        return Err("官方回的版本號格式不對，已放棄安裝".to_string());
    }
    let sum = asset_sum(&v, &package_asset(target), &version)?;
    asset_sum(&v, SUMS_ASSET, &version)?; // SHA256SUMS 也要在清單上、網址也要是官方的
    Ok((version, sum))
}

/// `codex-package_SHA256SUMS` 裡某個檔的雜湊；必須剛好一行
fn parse_sums(text: &str, asset: &str) -> Result<String, String> {
    let mut found = vec![];
    for line in text.lines() {
        let mut it = line.split_whitespace();
        if let (Some(sum), Some(name), None) = (it.next(), it.next(), it.next()) {
            if name == asset {
                found.push(sum.to_ascii_lowercase());
            }
        }
    }
    match found.as_slice() {
        [s] if HashAlgo::Sha256.valid_hex(s) => Ok(s.clone()),
        _ => Err("SHA256SUMS 裡找不到唯一一筆這個套件的雜湊".to_string()),
    }
}

/// 從官方清單與 SHA256SUMS 解析出這一次要裝的版本；兩個來源的雜湊要一致
fn resolve(d: &Deps, target: &str) -> Result<Release, String> {
    let latest = d.fetch.get_text(&url_latest(), MAX_METADATA_BYTES)?;
    let (version, sum) = parse_latest(&latest, target)?;
    let sums = d.fetch.get_text(&asset_url(&version, SUMS_ASSET), MAX_SUMS_BYTES)?;
    if parse_sums(&sums, &package_asset(target))? != sum {
        return Err("官方清單和 SHA256SUMS 的雜湊對不上，為了安全沒有安裝".to_string());
    }
    Ok(Release { url: asset_url(&version, &package_asset(target)), version, platform: target.to_string(), sum, size: None, max: MAX_ARCHIVE_BYTES })
}

/// Windows 的保留裝置名（不分大小寫，帶副檔名也算，例如 `nul.txt`）：開檔不會失敗，但資料會被吞掉
fn reserved_device(seg: &str) -> bool {
    let stem = seg.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'0'..=b'9'))
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && ["¹", "²", "³"].iter().any(|d| stem[3..] == **d))
}

/// tar 成員路徑 → 以 `/` 連接的相對路徑；有 `..`、根目錄、磁碟代號或空的一律不要。
/// 另外擋 Windows 檔名的怪癖（縱深防禦，整包已由官方雜湊把關）：結尾是 `.` 或空白（`evil.dll.` 會被當成 `evil.dll`，
/// 但副檔名判斷會漏掉驗簽章）、保留裝置名、控制字元與 Windows 不允許的字元
fn rel_path(p: &Path) -> Option<String> {
    let mut parts = vec![];
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(s) => {
                let s = s.to_str()?;
                if s.is_empty() || s.contains(['\\', ':', '<', '>', '"', '|', '?', '*']) || s.chars().any(char::is_control) || s.ends_with(['.', ' ']) || reserved_device(s) {
                    return None;
                }
                parts.push(s.to_string());
            }
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// 解開 tar（未壓縮的串流）到 `dest`，回所有一般檔案的相對路徑。只收一般檔案與資料夾；個數、總量有上限
pub(crate) fn extract_all<R: Read>(reader: R, dest: &Path, max_entries: usize, max_total: u64) -> Result<Vec<String>, String> {
    let mut ar = tar::Archive::new(reader);
    let entries = ar.entries().map_err(|e| format!("套件讀不懂：{e}"))?;
    let mut files = vec![];
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in entries {
        count += 1;
        if count > max_entries {
            return Err("套件的項目太多，已中止".into());
        }
        let mut e = entry.map_err(|e| format!("套件讀不懂：{e}"))?;
        let raw = e.path().map_err(|_| "套件裡有看不懂的路徑，已中止".to_string())?.into_owned();
        let rel = rel_path(&raw).ok_or_else(|| "套件裡有不安全的路徑（絕對路徑或 ..），已中止".to_string())?;
        let out = rel.split('/').fold(dest.to_path_buf(), |p, s| p.join(s));
        match e.header().entry_type() {
            tar::EntryType::Directory => {
                std::fs::create_dir_all(&out).map_err(|e| format!("建立資料夾失敗：{e}"))?;
            }
            tar::EntryType::Regular => {
                let size = e.header().size().map_err(|e| format!("套件讀不懂：{e}"))?;
                total += size;
                if total > max_total {
                    return Err("套件解開後太大，已中止".into());
                }
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("建立資料夾失敗：{e}"))?;
                }
                let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&out).map_err(|e| format!("寫入 {rel} 失敗：{e}"))?;
                let copied = std::io::copy(&mut e.by_ref().take(size + 1), &mut f).map_err(|e| format!("寫入 {rel} 失敗：{e}"))?;
                f.flush().map_err(|e| format!("寫入 {rel} 失敗：{e}"))?;
                if copied != size {
                    return Err(format!("套件裡的 {rel} 實際大小和標示不符，已中止"));
                }
                files.push(rel);
            }
            _ => return Err(format!("套件裡的 {rel} 不是一般檔案或資料夾（例如連結），已中止")),
        }
    }
    Ok(files)
}

fn ext_of(rel: &str) -> String {
    rel.rsplit('/').next().and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// 驗包裡每個檔：腳本類出現就不裝；exe／dll 等要是 OpenAI 簽的（例外照 `EXCEPTIONS`）；一定要有 `bin/codex.exe`。
/// 回 `bin/codex.exe` 的簽署者
pub(crate) fn verify_package(sig: &dyn super::authenticode::SignatureCheck, root: &Path, files: &[String]) -> Result<String, String> {
    if !files.iter().any(|f| f == "bin/codex.exe") {
        return Err("套件裡沒有 bin\\codex.exe，已放棄安裝".to_string());
    }
    let mut codex_signer = String::new();
    for rel in files {
        let ext = ext_of(rel);
        if FORBIDDEN_EXT.contains(&ext.as_str()) {
            return Err(format!("套件裡有不該出現的檔案（{rel}），已放棄安裝"));
        }
        if !SIGNED_EXT.contains(&ext.as_str()) {
            continue;
        }
        let path = rel.split('/').fold(root.to_path_buf(), |p, s| p.join(s));
        let rule = EXCEPTIONS.iter().find(|(p, _)| *p == rel).map(|(_, r)| *r);
        match rule {
            Some(Exception::Unsigned) => continue,
            Some(Exception::Signer(want)) => {
                let who = sig.signer(&path).map_err(|e| format!("{rel} 的數位簽章沒通過，已放棄安裝：{e}"))?;
                if who != want {
                    return Err(format!("{rel} 的簽署者不是 {want}，已放棄安裝"));
                }
            }
            None => {
                let who = sig.signer(&path).map_err(|e| format!("{rel} 的數位簽章沒通過，已放棄安裝：{e}"))?;
                if who != EXPECTED_SIGNER {
                    return Err(format!("{rel} 的簽署者不是 {EXPECTED_SIGNER}，已放棄安裝"));
                }
                if rel == "bin/codex.exe" {
                    codex_signer = who;
                }
            }
        }
    }
    Ok(codex_signer)
}

/// Codex 印成 `codex-cli 0.167.0` 這類格式，用共用的比對（輸出裡要有一個字完全等於版本號）
use super::verified_install::version_in_output;

/// 記住裝好的版本的檔名（在 `tools\codex` 底下，只寫版本號）
const CURRENT_FILE: &str = "current";

/// 驗證式安裝。`tools` 是 `%LOCALAPPDATA%\ASN\tools\codex`，`work` 是下載暫存資料夾
pub fn install_with_record(d: &Deps, tools: &Path, work: &Path, target: &str) -> (Result<String, String>, Record) {
    let mut rec = Record::start(&SPEC);
    let r = install_inner(d, tools, work, target, &mut rec);
    match &r {
        Ok(m) => {
            rec.ok = true;
            rec.detail = m.clone();
        }
        Err(e) => rec.detail = e.clone(),
    }
    (r, rec)
}

fn install_inner(d: &Deps, tools: &Path, work: &Path, target: &str, rec: &mut Record) -> Result<String, String> {
    let rel = resolve(d, target)?;
    rec.version = Some(rel.version.clone());
    let (archive, mut guard) = vi::download_locked(d, &SPEC, &rel, work, "tar.gz", rec)?;
    // 鎖住後再算一次，之後直接從同一個被鎖住的檔解開
    let staged = (|| -> Result<(PathBuf, Vec<String>), String> {
        if vi::hash_open_file(&guard, SPEC.hash)? != rel.sum {
            return Err("下載的套件在驗證前被改動，已放棄安裝".to_string());
        }
        guard.seek(SeekFrom::Start(0)).map_err(|e| format!("讀不了下載的套件：{e}"))?;
        std::fs::create_dir_all(tools).map_err(|e| format!("無法建立安裝資料夾：{e}"))?;
        // 上次當掉留下的暫存資料夾（名字帶程序編號，不會被同名覆蓋）先清掉；安裝鎖保證同時只有這一個在跑
        clean_staging(tools);
        let staging = tools.join(format!(".staging-{}-{}", rel.version, std::process::id()));
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|e| format!("清不掉上次的暫存資料夾：{e}"))?;
        }
        std::fs::create_dir_all(&staging).map_err(|e| format!("無法建立暫存資料夾：{e}"))?;
        let gz = flate2::read::GzDecoder::new(&guard);
        match extract_all(gz, &staging, MAX_ENTRIES, MAX_UNPACKED_BYTES) {
            Ok(files) => Ok((staging, files)),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                Err(e)
            }
        }
    })();
    vi::discard(&archive, guard);
    let (staging, files) = staged?;
    // 威脅模型：下載檔在驗證與解開時是鎖住的；解開後的暫存資料夾在驗簽章、跑 --version、改名就位之間沒有鎖。
    // 能在這段時間改它的，只有同一個使用者權限的程式——它本來就能直接改 ASN 自己、改使用者的檔案，
    // 所以這裡不再多做鎖，靠的是「整包雜湊三方一致＋逐檔簽章」擋住網路上被換掉的檔案。
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&staging);
        Err(e)
    };
    let who = match verify_package(d.sig, &staging, &files) {
        Ok(w) => w,
        Err(e) => return fail(e),
    };
    rec.signer = Some(who);
    let exe = staging.join("bin").join("codex.exe");
    match d.exec.version_output(&exe, vi::VERSION_TIMEOUT) {
        Ok(out) if version_in_output(&out, &rel.version) => {}
        Ok(_) => return fail(format!("裝好的 codex.exe 版本和驗證過的 {} 不一致，沒有算成功", rel.version)),
        Err(e) => return fail(format!("問不出裝好的 codex.exe 的版本：{e}")),
    }
    let final_dir = tools.join(&rel.version);
    if final_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&final_dir) {
            return fail(format!("清不掉舊的同版本資料夾：{e}"));
        }
    }
    if let Err(e) = std::fs::rename(&staging, &final_dir) {
        return fail(format!("無法就位安裝好的 Codex：{e}"));
    }
    // 寫不進去就回錯：ASN 是靠這個檔找到裝好的 Codex（installed_in），沒有它等於沒裝；再按一次會重裝同一版並覆蓋
    std::fs::write(tools.join(CURRENT_FILE), &rel.version).map_err(|e| format!("Codex 已解開，但記不住裝好的版本，ASN 會找不到它：{e}。請再按一次安裝"))?;
    Ok(format!("已安裝 Codex {}。", rel.version))
}

/// 清掉 `tools\codex` 底下上次留下的 `.staging-*`（只動這個前綴的資料夾）
fn clean_staging(tools: &Path) {
    let Ok(rd) = std::fs::read_dir(tools) else { return };
    for e in rd.flatten() {
        if e.file_name().to_string_lossy().starts_with(".staging-") && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// ASN 裝的 Codex（`tools\codex\<current>\bin\codex.exe`）；沒裝或記錄看不懂回 None。只看檔案在不在，不執行
pub fn installed_in(tools: &Path) -> Option<PathBuf> {
    let v = std::fs::read_to_string(tools.join(CURRENT_FILE)).ok()?;
    let v = v.trim();
    if !vi::valid_version(v) {
        return None;
    }
    let exe = tools.join(v).join("bin").join("codex.exe");
    exe.is_file().then_some(exe)
}

/// PATH 上官方裝好的 codex.exe（簽署者完全等於 OpenAI OpCo, LLC）；npm 裝的 `codex.cmd` 不算
pub fn official_on_path_in(sig: &dyn super::authenticode::SignatureCheck, dirs: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    for d in dirs {
        let p = d.join("codex.exe");
        if p.is_file() && sig.signer(&p).ok().as_deref() == Some(EXPECTED_SIGNER) {
            return Some(p);
        }
    }
    None
}

fn tools_dir() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).map(|b| b.join("ASN").join("tools").join("codex")).ok_or_else(|| "找不到 LOCALAPPDATA 資料夾".to_string())
}

/// 這台可用的 Codex：先看官方裝好的，再看 ASN 裝的
pub fn usable_here() -> Option<PathBuf> {
    let sig = super::authenticode::SystemSignatureCheck;
    let path = std::env::var_os("PATH")?;
    official_on_path_in(&sig, std::env::split_paths(&path)).or_else(|| tools_dir().ok().and_then(|t| installed_in(&t)))
}

/// 真正的環境。已有官方裝好的 codex 就直接用、不另外裝（不寫安裝記錄，因為沒有安裝）；其餘每次嘗試都寫記錄
pub fn install_here() -> Result<String, String> {
    let _busy = vi::InstallBusy::take()?;
    let target = target()?;
    let sig = super::authenticode::SystemSignatureCheck;
    if let Some(p) = std::env::var_os("PATH").and_then(|path| official_on_path_in(&sig, std::env::split_paths(&path))) {
        return Ok(format!("這台已經有官方裝好的 Codex（{}），直接用它，不另外安裝。", p.display()));
    }
    let tools = tools_dir()?;
    let setup = crate::identity::relay_home().join("setup");
    let fetch = super::net::RealFetch;
    let exec = vi::RealExec;
    let (r, rec) = install_with_record(&Deps { fetch: &fetch, sig: &sig, exec: &exec }, &tools, &setup.join("downloads"), target);
    vi::write_record(&setup, &rec);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_setup::authenticode::SignatureCheck;
    use crate::agent_setup::net::Fetch;
    use crate::agent_setup::verified_install::Exec;
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::time::Duration;

    const T: &str = "x86_64-pc-windows-msvc";
    const V: &str = "0.167.0";

    /// 一個正常的套件：OpenAI 簽的檔、沒簽的 rg、微軟簽的 vcruntime、一般資料檔
    fn good_files() -> Vec<(&'static str, &'static [u8])> {
        vec![
            ("bin/codex.exe", b"MZ codex"),
            ("bin/codex-exec-server.exe", b"MZ exec"),
            ("codex-package.json", b"{}"),
            ("codex-path/rg.exe", b"MZ rg"),
            ("codex-resources/codex-command-runner.exe", b"MZ runner"),
            ("codex-resources/voice/NOTICE.md", b"notice"),
            ("codex-resources/voice/bin/vcruntime140.dll", b"MZ vc"),
            ("codex-resources/voice/bin/opus.dll", b"MZ opus"),
        ]
    }

    fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (p, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            b.append_data(&mut h, p, *data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap()
    }

    /// 繞過 tar 套件的路徑檢查，直接寫原始名稱（造不安全的成員用）
    fn tar_raw(name: &[u8], kind: tar::EntryType, data: &[u8]) -> Vec<u8> {
        let mut h = tar::Header::new_gnu();
        h.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_entry_type(kind);
        if kind == tar::EntryType::Symlink {
            h.set_link_name("C:/Windows").unwrap();
        }
        h.set_cksum();
        let mut b = tar::Builder::new(Vec::new());
        b.append(&h, data).unwrap();
        b.into_inner().unwrap()
    }

    fn sum(b: &[u8]) -> String {
        vi::hex(&Sha256::digest(b))
    }

    fn latest_json(version: &str, pkg_sum: &str, pkg_url: Option<&str>) -> String {
        let pkg = package_asset(T);
        let pu = pkg_url.map(String::from).unwrap_or_else(|| asset_url(version, &pkg));
        format!(
            r#"{{"tag_name":"rust-v{version}","assets":[{{"name":"{pkg}","digest":"sha256:{pkg_sum}","browser_download_url":"{pu}"}},{{"name":"{SUMS_ASSET}","digest":"sha256:{z}","browser_download_url":"{su}"}}]}}"#,
            z = "0".repeat(64),
            su = asset_url(version, SUMS_ASSET)
        )
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
        fn download(&self, url: &str, out: &mut dyn Write, max: u64) -> Result<u64, String> {
            self.log.borrow_mut().push(url.into());
            let b = self.bins.get(url).ok_or_else(|| format!("沒有 {url}"))?;
            if b.len() as u64 > max {
                return Err("太大".into());
            }
            out.write_all(b).map_err(|e| e.to_string())?;
            Ok(b.len() as u64)
        }
    }

    /// 依檔名決定簽署者：rg 沒簽、vcruntime 微軟、其他 OpenAI；`over` 可以改某個檔的結果
    struct FakeSig {
        over: HashMap<&'static str, Result<String, String>>,
        seen: RefCell<Vec<String>>,
    }
    impl SignatureCheck for FakeSig {
        fn signer(&self, p: &Path) -> Result<String, String> {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            self.seen.borrow_mut().push(name.clone());
            if let Some(r) = self.over.get(name.as_str()) {
                return r.clone();
            }
            match name.as_str() {
                "rg.exe" => Err("沒有簽章".into()),
                "vcruntime140.dll" => Ok(MICROSOFT_SIGNER.into()),
                _ => Ok(EXPECTED_SIGNER.into()),
            }
        }
    }
    fn sig() -> FakeSig {
        FakeSig { over: HashMap::new(), seen: RefCell::new(vec![]) }
    }

    struct FakeExec(Result<String, String>);
    impl Exec for FakeExec {
        fn run_installer(&self, _e: &Path, _a: &[&str], _c: &Path, _t: Duration) -> Result<i32, String> {
            panic!("Codex 不執行安裝程式")
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
    fn rig(pkg: Vec<u8>) -> Rig {
        let mut fetch = FakeFetch::default();
        let s = sum(&pkg);
        fetch.texts.insert(url_latest(), latest_json(V, &s, None));
        fetch.texts.insert(asset_url(V, SUMS_ASSET), format!("{}  codex-app-server-package-{T}.tar.gz\n{s}  {}\n", "1".repeat(64), package_asset(T)));
        fetch.bins.insert(asset_url(V, &package_asset(T)), pkg);
        Rig { dir: tempfile::tempdir().unwrap(), fetch, sig: sig(), exec: FakeExec(Ok(format!("codex-cli {V}\n"))) }
    }
    fn tools(r: &Rig) -> PathBuf {
        r.dir.path().join("tools")
    }
    fn run(r: &Rig) -> (Result<String, String>, Record) {
        install_with_record(&Deps { fetch: &r.fetch, sig: &r.sig, exec: &r.exec }, &tools(r), &r.dir.path().join("work"), T)
    }
    fn tools_entries(r: &Rig) -> Vec<String> {
        std::fs::read_dir(tools(r)).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default()
    }

    #[test]
    fn 全部通過_就位到版本資料夾_記住版本_記錄帶雜湊簽署者() {
        let pkg = tar_gz(&good_files());
        let r = rig(pkg.clone());
        let (res, rec) = run(&r);
        assert_eq!(res.unwrap(), format!("已安裝 Codex {V}。"));
        let exe = installed_in(&tools(&r)).unwrap();
        assert_eq!(exe, tools(&r).join(V).join("bin").join("codex.exe"));
        let mut names = tools_entries(&r);
        names.sort();
        assert_eq!(names, vec![V.to_string(), CURRENT_FILE.to_string()], "暫存資料夾要收掉");
        assert!(std::fs::read_dir(r.dir.path().join("work")).unwrap().next().is_none(), "下載的套件要刪掉");
        assert!(rec.ok);
        assert_eq!(rec.sum.as_deref(), Some(sum(&pkg).as_str()));
        assert_eq!(rec.signer.as_deref(), Some(EXPECTED_SIGNER));
        assert!(rec.line().contains("來源=releases.openai.com"));
        // rg 沒簽章不驗；其他執行檔都驗過
        let seen = r.sig.seen.borrow();
        assert!(!seen.contains(&"rg.exe".to_string()));
        for f in ["codex.exe", "codex-exec-server.exe", "codex-command-runner.exe", "vcruntime140.dll", "opus.dll"] {
            assert!(seen.contains(&f.to_string()), "{f} 要驗");
        }
        assert!(!seen.contains(&"NOTICE.md".to_string()) && !seen.contains(&"codex-package.json".to_string()), "資料檔不驗簽章");
    }

    #[test]
    fn 只連官方主機() {
        let r = rig(tar_gz(&good_files()));
        run(&r).0.unwrap();
        assert!(r.fetch.log.borrow().iter().all(|u| u.starts_with("https://releases.openai.com/codex/")), "{:?}", r.fetch.log.borrow());
    }

    #[test]
    fn 例外清單寫死_只有這兩個() {
        assert_eq!(EXCEPTIONS, [("codex-path/rg.exe", Exception::Unsigned), ("codex-resources/voice/bin/vcruntime140.dll", Exception::Signer("Microsoft Windows"))]);
        // 例外只來自常數：程式裡沒有從清單、設定檔或環境變數讀例外的寫法
        let src = include_str!("codex_install.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let code: Vec<&str> = body.lines().filter(|l| !l.trim_start().starts_with("//")).filter(|l| l.contains("EXCEPTIONS")).collect();
        assert_eq!(code.len(), 2, "只有宣告與 verify_package 各用一次：{code:?}");
        assert!(code[0].trim_start().starts_with("pub const EXCEPTIONS: [(&str, Exception); 2] = "), "宣告是常數：{}", code[0]);
        assert!(!body.contains("env::var(\"") && !body.contains("env::var_os(\"CODEX"), "不能讓環境變數影響例外或來源");
    }

    #[test]
    fn 三方雜湊不一致就不下載或不裝() {
        // metadata 和 SHA256SUMS 對不上：不下載
        let mut r = rig(tar_gz(&good_files()));
        r.fetch.texts.insert(asset_url(V, SUMS_ASSET), format!("{}  {}\n", "a".repeat(64), package_asset(T)));
        assert!(run(&r).0.unwrap_err().contains("SHA256SUMS"));
        assert_eq!(r.fetch.log.borrow().len(), 2, "只取了兩份清單，沒下載套件");
        // 兩個來源一致，但實際下載的內容不同
        let mut r = rig(tar_gz(&good_files()));
        r.fetch.bins.insert(asset_url(V, &package_asset(T)), tar_gz(&[("bin/codex.exe", b"MZ other")]));
        assert!(run(&r).0.unwrap_err().contains("雜湊"));
        assert!(installed_in(&tools(&r)).is_none());
        // SHA256SUMS 有兩行同名、或沒有
        assert!(parse_sums(&format!("{s}  x\n{s}  x\n", s = "b".repeat(64)), "x").is_err());
        assert!(parse_sums("", "x").is_err());
    }

    #[test]
    fn 清單的網址或版本不對就放棄() {
        let s = "c".repeat(64);
        assert!(parse_latest(&latest_json(V, &s, Some("https://github.com/openai/codex/releases/download/x")), T).unwrap_err().contains("不認得的下載位置"));
        assert!(parse_latest(&latest_json(V, &s, Some("https://releases.openai.com.evil.com/codex/releases/0.167.0/x")), T).is_err());
        assert!(parse_latest(&latest_json("0.167.0-beta.1", &s, None), T).unwrap_err().contains("版本號"));
        assert!(parse_latest(&latest_json("../x", &s, None), T).is_err());
        assert!(parse_latest(&latest_json(V, "XYZ", None), T).unwrap_err().contains("雜湊格式"));
        assert!(parse_latest(r#"{"tag_name":"v0.167.0","assets":[]}"#, T).is_err(), "tag 要是 rust-v 開頭");
        assert_eq!(parse_latest(&latest_json(V, &s, None), T).unwrap(), (V.to_string(), s));
    }

    #[test]
    fn 簽章不符_或多出沒簽的執行檔_或有腳本_整包不裝() {
        let cases: Vec<(&str, Vec<(&str, &[u8])>, Option<(&str, Result<String, String>)>)> = vec![
            ("OpenAI 的檔換成別人簽", good_files(), Some(("codex-exec-server.exe", Ok("Someone Else".into())))),
            ("OpenAI 的檔沒簽章", good_files(), Some(("opus.dll", Err("沒有簽章".into())))),
            ("vcruntime 是 OpenAI 簽的也不行（要完全等於 Microsoft Windows）", good_files(), Some(("vcruntime140.dll", Ok(EXPECTED_SIGNER.into())))),
            ("多一個沒簽的 exe", [good_files(), vec![("codex-path/fd.exe", b"MZ fd" as &[u8])]].concat(), Some(("fd.exe", Err("沒有簽章".into())))),
            ("別處的 rg.exe 不是例外", [good_files(), vec![("bin/rg.exe", b"MZ rg2" as &[u8])]].concat(), None),
            ("有 ps1", [good_files(), vec![("bin/setup.ps1", b"x" as &[u8])]].concat(), None),
            ("有 cmd", [good_files(), vec![("codex.CMD", b"x" as &[u8])]].concat(), None),
            ("沒有 bin/codex.exe", good_files().into_iter().filter(|(p, _)| *p != "bin/codex.exe").collect(), None),
        ];
        for (why, files, over) in cases {
            let mut r = rig(tar_gz(&files));
            if let Some((name, res)) = over {
                r.sig.over.insert(name, res);
            }
            let (res, rec) = run(&r);
            assert!(res.is_err(), "{why}");
            assert!(!rec.ok, "{why}");
            assert!(installed_in(&tools(&r)).is_none(), "{why}");
            assert!(tools_entries(&r).is_empty(), "{why}：暫存資料夾要清掉：{:?}", tools_entries(&r));
        }
    }

    #[test]
    fn 版本對不上或問不出來_不就位() {
        for out in [Ok("codex-cli 0.166.0".to_string()), Ok("".to_string()), Err("跑不起來".to_string())] {
            let mut r = rig(tar_gz(&good_files()));
            r.exec = FakeExec(out.clone());
            assert!(run(&r).0.is_err(), "{out:?}");
            assert!(installed_in(&tools(&r)).is_none());
            assert!(tools_entries(&r).is_empty());
        }
        assert!(version_in_output("codex-cli 0.167.0\n", "0.167.0"));
        assert!(!version_in_output("codex-cli 0.167.01", "0.167.0"));
    }

    #[test]
    fn 解壓只收一般檔與資料夾_不收連結與跳出去的路徑() {
        let d = tempfile::tempdir().unwrap();
        for (name, kind) in [(&b"../evil.exe"[..], tar::EntryType::Regular), (b"a/../../evil.exe", tar::EntryType::Regular), (b"/abs.exe", tar::EntryType::Regular), (b"C:/abs.exe", tar::EntryType::Regular), (b"bin/link", tar::EntryType::Symlink), (b"bin/hard", tar::EntryType::Link), (b"bin/fifo", tar::EntryType::Fifo)] {
            let out = d.path().join(format!("o{}", name.len()));
            std::fs::create_dir_all(&out).unwrap();
            let bytes = tar_raw(name, kind, if kind == tar::EntryType::Regular { b"MZ" } else { b"" });
            assert!(extract_all(&bytes[..], &out, 200, 1 << 20).is_err(), "{}", String::from_utf8_lossy(name));
            assert!(!d.path().join("evil.exe").exists());
        }
    }

    #[test]
    fn windows_檔名怪癖_結尾點或空白_保留裝置名_特殊字元都不收() {
        for bad in ["bin/evil.dll.", "bin/evil.exe ", "bin/nul", "bin/NUL.txt", "con", "Aux.dll", "bin/com1.exe", "LPT9", "COM¹", "a/b?c", "a*b", "a\"b", "a<b", "a|b", "a\u{1}b", "bin./x.exe", "bin /x.exe"] {
            assert_eq!(rel_path(Path::new(bad)), None, "{bad:?}");
        }
        for ok in ["bin/codex.exe", "codex-resources/voice/bin/gst-1.0.dll", "console.dll", "nullable.txt", "com10.exe", "lpt.exe", "./bin/a.exe"] {
            assert!(rel_path(Path::new(ok)).is_some(), "{ok:?}");
        }
    }

    #[test]
    fn 上次留下的暫存資料夾_開始前會清掉_別的不動() {
        let r = rig(tar_gz(&good_files()));
        let t = tools(&r);
        std::fs::create_dir_all(t.join(".staging-0.1.0-999").join("bin")).unwrap();
        std::fs::write(t.join(".staging-0.1.0-999").join("bin").join("x.exe"), b"old").unwrap();
        std::fs::create_dir_all(t.join("0.100.0")).unwrap();
        run(&r).0.unwrap();
        let mut names = tools_entries(&r);
        names.sort();
        assert_eq!(names, vec!["0.100.0".to_string(), V.to_string(), CURRENT_FILE.to_string()]);
    }

    #[test]
    fn 解壓有項目數與總量上限() {
        let many: Vec<(String, Vec<u8>)> = (0..201).map(|i| (format!("f{i}.txt"), b"x".to_vec())).collect();
        let refs: Vec<(&str, &[u8])> = many.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect();
        let gz = tar_gz(&refs);
        let d = tempfile::tempdir().unwrap();
        let e = extract_all(flate2::read::GzDecoder::new(&gz[..]), d.path(), 200, 1 << 20).unwrap_err();
        assert!(e.contains("太多"), "{e}");
        let big = vec![0u8; 2048];
        let gz = tar_gz(&[("a.bin", &big), ("b.bin", &big)]);
        let d = tempfile::tempdir().unwrap();
        assert!(extract_all(flate2::read::GzDecoder::new(&gz[..]), d.path(), 200, 3000).unwrap_err().contains("太大"));
    }

    #[test]
    fn 官方裝好的才算_npm_的_cmd_不算_簽署者要相符() {
        let d = tempfile::tempdir().unwrap();
        let npm = d.path().join("npm");
        let off = d.path().join("off");
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::create_dir_all(&off).unwrap();
        std::fs::write(npm.join("codex.cmd"), b"@node codex.js").unwrap();
        assert_eq!(official_on_path_in(&sig(), [npm.clone()].into_iter()), None);
        std::fs::write(off.join("codex.exe"), b"MZ").unwrap();
        assert_eq!(official_on_path_in(&sig(), [npm.clone(), off.clone()].into_iter()), Some(off.join("codex.exe")));
        let mut s = sig();
        s.over.insert("codex.exe", Ok("Someone Else".into()));
        assert_eq!(official_on_path_in(&s, [off].into_iter()), None);
    }

    #[test]
    fn 記住的版本看不懂就當沒裝() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(installed_in(d.path()), None);
        std::fs::write(d.path().join(CURRENT_FILE), "../../x").unwrap();
        assert_eq!(installed_in(d.path()), None);
        std::fs::write(d.path().join(CURRENT_FILE), V).unwrap();
        assert_eq!(installed_in(d.path()), None, "版本資料夾不在");
        std::fs::create_dir_all(d.path().join(V).join("bin")).unwrap();
        std::fs::write(d.path().join(V).join("bin").join("codex.exe"), b"MZ").unwrap();
        assert!(installed_in(d.path()).is_some());
    }

    /// 連官方真的取 metadata 與 SHA256SUMS（只讀、不下載套件、不安裝）：確認不跟轉址也取得到、格式讀得懂、兩邊雜湊一致
    #[test]
    #[ignore = "需要網路；手動執行：cargo test --lib codex_real_release_endpoints -- --ignored --nocapture"]
    fn codex_real_release_endpoints() {
        let f = super::super::net::RealFetch;
        let n = super::super::authenticode::SystemSignatureCheck;
        let e = vi::RealExec;
        let r = resolve(&Deps { fetch: &f, sig: &n, exec: &e }, T).unwrap();
        println!("version={} url={} sum={}", r.version, r.url, r.sum);
    }
}
