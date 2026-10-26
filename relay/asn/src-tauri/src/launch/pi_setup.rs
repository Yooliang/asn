//! 讓使用者自己開的 pi 也能跟 ASN 互通（#240 方案 A）：**經使用者同意**，替他的 pi 安裝 ASN 擴充（`pi install`），
//! 之後他自己開的 pi 一啟動就會登記到名單、能收信與回信；隨時可以移除（`pi remove`），設定檔還原。
//!
//! 守門：
//! - 只在使用者按下同意才做；這裡不會自己跑（沒有開機自動安裝）。
//! - 只用 pi 官方的 `pi install` ／ `pi remove` 改設定，不自己改 pi 的 settings.json；改完重新讀設定確認真的生效。
//! - 移除時只移除「我們裝的那一筆」：安裝時把裝進去的路徑記在 `~/.asn/pi-ext-installed.json`，移除就用這個，不誤刪使用者自己裝的別的套件。
//! - 設定位置照 pi 的規則：環境變數 `PI_CODING_AGENT_DIR`，沒有就是 `~/.pi/agent`（測試也靠它隔離）。
//! - 路徑已不存在的舊安裝（ASN 搬家或解除安裝後留下的）安裝時順手清掉，免得 pi 每次啟動都在找不到的擴充上報錯。
//! 純邏輯＋可注入的執行器；真的執行在最下面（不開黑視窗、有逾時）。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// `pi install` 要下載或複製東西，給比較長的時間
const TIMEOUT_SECS: u64 = 90;
/// 子程序輸出最多留多少位元組（超過的照樣讀掉丟棄，不然子程序會卡在寫管線）
pub(crate) const OUT_CAP: usize = 64 * 1024;
/// 記錄「我們裝了哪一筆」的檔名（放在 ASN 的資料夾）
pub(crate) const MARKER: &str = "pi-ext-installed.json";

/// pi 的設定資料夾：`PI_CODING_AGENT_DIR` 優先，否則 `~/.pi/agent`
pub(crate) fn agent_dir(env_value: Option<&str>, home: &Path) -> PathBuf {
    match env_value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => home.join(".pi").join("agent"),
    }
}

/// 比對用的路徑：去掉 Windows 的 `\\?\` 前綴、反斜線換斜線、去尾端斜線、轉小寫
pub(crate) fn norm(p: &str) -> String {
    let t = p.trim().trim_start_matches(r"\\?\").replace('\\', "/");
    t.trim_end_matches('/').to_lowercase()
}

/// pi 在 settings.json 裡可能存「相對於 pi 設定資料夾」的路徑（例如 `..\\..\\AppData\\Local\\ASN\\pi-extension`）。
/// 以前拿它直接跟絕對路徑比、或直接問檔案存不存在（相對的是 ASN 的工作目錄），會誤判成「沒裝」或「已失效」，
/// 安裝後驗證失敗（「pi 說裝好了，但設定裡找不到這個擴充」）。這裡依 `base`（pi 設定資料夾）解成絕對路徑，只做字串運算、不碰檔案。
/// 只處理以 `.` 開頭的路徑；`npm:`、`git:`、已是絕對路徑的原樣不動。
pub(crate) fn resolve_entry(base: &Path, entry: &str) -> String {
    let t = entry.trim();
    if !(t.starts_with("./") || t.starts_with(".\\") || t.starts_with("../") || t.starts_with("..\\") || t == "." || t == "..") {
        return entry.to_string();
    }
    let mut out = base.to_path_buf();
    for c in Path::new(&t.replace('\\', "/")).components() {
        use std::path::Component::*;
        match c {
            CurDir => {}
            ParentDir => {
                out.pop();
            }
            Normal(x) => out.push(x),
            _ => {}
        }
    }
    out.to_string_lossy().to_string()
}

/// 讀用的副本：把 packages 裡的相對路徑項目解成絕對路徑（字串與 `{ "source": … }` 兩種都處理）。壞檔、沒有 packages 原樣回傳。
/// 這份只拿來判斷狀態，**絕不寫回** pi 的設定檔。
pub(crate) fn resolve_settings(base: &Path, text: String) -> Option<String> {
    let Ok(mut v) = serde_json::from_str::<Value>(&text) else { return Some(text) };
    let Some(arr) = v.get_mut("packages").and_then(Value::as_array_mut) else { return Some(text) };
    for e in arr.iter_mut() {
        if let Some(s) = e.as_str() {
            *e = Value::String(resolve_entry(base, s));
        } else if let Some(src) = e.get("source").and_then(Value::as_str).map(|s| resolve_entry(base, s)) {
            e["source"] = Value::String(src);
        }
    }
    Some(v.to_string())
}

/// settings.json 的 `packages`：每一項是字串，或 `{ "source": "…" }`
pub(crate) fn package_entries(settings_text: Option<&str>) -> Vec<String> {
    let Some(v) = settings_text.and_then(|t| serde_json::from_str::<Value>(t).ok()) else { return vec![] };
    v.get("packages")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| e.as_str().map(String::from).or_else(|| e.get("source").and_then(Value::as_str).map(String::from)))
                .collect()
        })
        .unwrap_or_default()
}

/// 這個路徑指的是不是 ASN 的 pi 擴充資料夾（資料夾名是 pi-extension）
fn looks_like_ext(entry: &str) -> bool {
    norm(entry).rsplit('/').next() == Some("pi-extension")
}

/// 目前狀態（給畫面用）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SetupState {
    /// 這台電腦找得到 pi
    pub pi_found: bool,
    /// 找得到 ASN 自己帶的擴充資料夾
    pub ext_found: bool,
    /// pi 已經載入 ASN 擴充（裝了現在這個資料夾，或放在 pi 的自動載入資料夾，或從別的資料夾裝了 pi-extension）
    pub installed: bool,
    /// 設定裡有路徑已不存在的舊 ASN 擴充（要清）
    pub stale: Vec<String>,
}

impl SetupState {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "pi": self.pi_found, "ext": self.ext_found, "installed": self.installed, "stale": self.stale.len() })
    }
}

/// 純邏輯：從設定文字、擴充資料夾、檔案存在判斷算出狀態。`exists`＝路徑存不存在（測試可注入）
pub(crate) fn compute_state(pi_found: bool, ext_dir: Option<&Path>, settings_text: Option<&str>, auto_dir_has_index: bool, exists: &dyn Fn(&str) -> bool) -> SetupState {
    let cur = ext_dir.map(|d| norm(&d.to_string_lossy()));
    let entries = package_entries(settings_text);
    let mut installed = auto_dir_has_index;
    let mut stale = vec![];
    for e in entries.iter().filter(|e| looks_like_ext(e)) {
        if cur.as_deref() == Some(norm(e).as_str()) || exists(e) {
            installed = true;
        } else {
            stale.push(e.clone());
        }
    }
    SetupState { pi_found, ext_found: ext_dir.is_some(), installed, stale }
}

/// 指令執行器（真的跑或測試用的假的）。回 (結束碼, 輸出文字)；逾時或起不來回 Err
pub(crate) trait Runner {
    fn run(&self, program: &Path, args: &[String]) -> Result<(i32, String), String>;
}

fn tail(s: &str) -> String {
    let t = s.trim();
    let n = t.chars().count();
    if n <= 200 {
        t.to_string()
    } else {
        t.chars().skip(n - 200).collect()
    }
}

/// 讀目前的設定文字（沒有就是 None）
pub(crate) trait Files {
    fn settings(&self) -> Option<String>;
    /// 設定檔原文（remove 失敗時用 pi 存的原樣字串再試一次）；預設同 settings()
    fn raw_settings(&self) -> Option<String> {
        self.settings()
    }
    fn exists(&self, p: &str) -> bool;
    fn read_marker(&self) -> Option<String>;
    fn write_marker(&self, path: &str) -> Result<(), String>;
    fn clear_marker(&self);
}

/// 安裝：先清掉路徑已不存在的舊安裝，再 `pi install <擴充資料夾>`，最後重新讀設定確認；成功就記下裝了哪一筆。
/// 重複安裝是安全的（pi 本身是冪等的）。回 Err(給人看的中文原因)
pub(crate) fn install(pi: &Path, ext_dir: &Path, auto_dir_has_index: bool, runner: &dyn Runner, files: &dyn Files) -> Result<(), String> {
    let ext = ext_dir.to_string_lossy().to_string();
    let st = compute_state(true, Some(ext_dir), files.settings().as_deref(), auto_dir_has_index, &|p| files.exists(p));
    for dead in &st.stale {
        // 清不掉也不影響這次安裝（只是舊的那一筆還在），所以不當成失敗
        let _ = runner.run(pi, &["remove".to_string(), dead.clone()]);
    }
    let (code, out) = runner.run(pi, &["install".to_string(), ext.clone()]).map_err(|e| format!("pi 沒有跑起來：{e}"))?;
    if code != 0 {
        return Err(format!("pi 安裝擴充失敗（結束碼 {code}）：{}", tail(&out)));
    }
    let after = compute_state(true, Some(ext_dir), files.settings().as_deref(), auto_dir_has_index, &|p| files.exists(p));
    if !after.installed {
        let seen = package_entries(files.settings().as_deref());
        let seen = if seen.is_empty() { "（packages 是空的或讀不到）".to_string() } else { seen.join("、") };
        return Err(format!("pi 說裝好了，但設定裡找不到這個擴充（要找 {ext}；pi 設定裡目前有：{seen}），請再試一次或手動執行 pi install"));
    }
    files.write_marker(&ext)
}

/// 移除：只移除「我們裝的那一筆」（記錄檔裡的路徑；沒有記錄就用現在的擴充資料夾）。pi 說找不到（本來就沒裝）也算成功
pub(crate) fn remove(pi: &Path, ext_dir: Option<&Path>, runner: &dyn Runner, files: &dyn Files) -> Result<(), String> {
    let target = files.read_marker().or_else(|| ext_dir.map(|d| d.to_string_lossy().to_string())).ok_or("不知道要移除哪一筆")?;
    let (code, out) = runner.run(pi, &["remove".to_string(), target.clone()]).map_err(|e| format!("pi 沒有跑起來：{e}"))?;
    let still = package_entries(files.settings().as_deref()).iter().any(|e| norm(e) == norm(&target));
    if code != 0 && still {
        return Err(format!("pi 移除擴充失敗（結束碼 {code}）：{}", tail(&out)));
    }
    if still {
        return Err("pi 說移除了，但設定裡還在，請再試一次或手動執行 pi remove".into());
    }
    files.clear_marker();
    Ok(())
}

// ---------------------------------------------------------------- 預設開啟：第一次偵測到 pi 就自動安裝（#305）

pub(crate) const AUTO_PREF: &str = "pi-auto.json";

/// 讀偏好：(auto＝允許自動安裝（預設 true）, done＝自動安裝已經處理過（裝過，或本來就裝了）)。檔案壞掉當預設。
pub(crate) fn auto_read(p: &Path) -> (bool, bool) {
    let v = std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let get = |k: &str, d: bool| v.as_ref().and_then(|v| v.get(k)).and_then(Value::as_bool).unwrap_or(d);
    (get("auto", true), get("done", false))
}
pub(crate) fn auto_write(p: &Path, auto: bool, done: bool) {
    let _ = crate::write_atomic(p, &json!({ "auto": auto, "done": done }).to_string());
}

/// 要不要自動安裝：允許、還沒處理過、找得到 pi 與 ASN 附的擴充、而且還沒裝
pub(crate) fn should_auto(auto: bool, done: bool, st: &SetupState) -> bool {
    auto && !done && st.pi_found && st.ext_found && !st.installed
}

#[derive(Debug, PartialEq)]
pub(crate) enum AutoOutcome {
    Skipped,
    Installed,
    Failed(String),
}

/// 啟動時跑一次。裝好就記 done；本來就裝了也記 done（之後有人手動拿掉，不會又被裝回來）；使用者關掉（auto=false）一律不動。
/// 安裝失敗不記 done（下次啟動再試一次）。`do_install` 由呼叫端注入。
pub(crate) fn auto_step(pref: &Path, st: &SetupState, do_install: impl FnOnce() -> Result<(), String>) -> AutoOutcome {
    let (auto, done) = auto_read(pref);
    if !auto || done {
        return AutoOutcome::Skipped;
    }
    if st.installed {
        auto_write(pref, true, true);
        return AutoOutcome::Skipped;
    }
    if !should_auto(auto, done, st) {
        return AutoOutcome::Skipped;
    }
    match do_install() {
        Ok(()) => {
            auto_write(pref, true, true);
            AutoOutcome::Installed
        }
        Err(e) => AutoOutcome::Failed(e),
    }
}

// ---------------------------------------------------------------- 真實環境

struct RealFiles {
    agent: PathBuf,
    marker: PathBuf,
}

impl Files for RealFiles {
    fn settings(&self) -> Option<String> {
        resolve_settings(&self.agent, self.raw_settings()?)
    }
    fn raw_settings(&self) -> Option<String> {
        std::fs::read_to_string(self.agent.join("settings.json")).ok()
    }
    fn exists(&self, p: &str) -> bool {
        Path::new(p).exists()
    }
    fn read_marker(&self) -> Option<String> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&self.marker).ok()?).ok()?;
        v.get("path").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() < 1024).map(String::from)
    }
    fn write_marker(&self, path: &str) -> Result<(), String> {
        if let Some(d) = self.marker.parent() {
            std::fs::create_dir_all(d).map_err(|e| format!("記錄檔資料夾建不起來：{e}"))?;
        }
        let body = json!({ "path": path, "at": crate::heartbeat::now_ms() }).to_string();
        std::fs::write(&self.marker, body).map_err(|e| format!("記錄檔寫不進去：{e}"))
    }
    fn clear_marker(&self) {
        let _ = std::fs::remove_file(&self.marker);
    }
}

struct RealRunner {
    timeout: std::time::Duration,
}

impl Default for RealRunner {
    fn default() -> Self {
        RealRunner { timeout: std::time::Duration::from_secs(TIMEOUT_SECS) }
    }
}

/// 在另一條執行緒持續讀走一條管線：最多留 OUT_CAP 位元組，超過的照樣讀掉丟棄。
/// 一定要一直讀：子程序寫滿管線緩衝區（Windows 預設只有 4KB）就會卡在寫入，父程序又在等它結束＝死鎖到逾時（#審查 Gemini 指出）
fn drain(mut r: impl std::io::Read + Send + 'static) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = OUT_CAP.saturating_sub(out.len());
                    out.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&out).into_owned());
    });
    rx
}

impl Runner for RealRunner {
    fn run(&self, program: &Path, args: &[String]) -> Result<(i32, String), String> {
        use crate::nowin::NoWindow;
        use std::process::Stdio;
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).no_window();
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        // 兩條管線一開始就各自有人讀，不等程序結束
        let out_rx = child.stdout.take().map(drain);
        let err_rx = child.stderr.take().map(drain);
        let deadline = std::time::Instant::now() + self.timeout;
        // 程序結束後，讀的執行緒通常馬上收尾；若有孫程序還握著管線，最多再等這麼久，拿到多少算多少
        let grace = std::time::Duration::from_secs(2);
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    let mut out = out_rx.and_then(|r| r.recv_timeout(grace).ok()).unwrap_or_default();
                    let err = err_rx.and_then(|r| r.recv_timeout(grace).ok()).unwrap_or_default();
                    out.push_str(&err);
                    return Ok((status.code().unwrap_or(-1), out));
                }
                None if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("超過 {} 秒沒有結束，已停止", self.timeout.as_secs()));
                }
                None => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        }
    }
}

/// ASN 自己帶的擴充資料夾（有 index.ts 的那層）
fn real_ext_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let found = super::pi::find_pi_extension(exe.parent()?)?;
    let dir = found.parent()?.to_string_lossy().to_string();
    Some(PathBuf::from(super::local::strip_verbatim_prefix(&dir)))
}

fn real_env() -> (PathBuf, PathBuf) {
    let home = crate::identity::home_dir();
    let agent = agent_dir(std::env::var("PI_CODING_AGENT_DIR").ok().as_deref(), &home);
    (agent, crate::identity::relay_home().join(MARKER))
}

fn real_pi() -> Option<PathBuf> {
    crate::agent_tools::resolve_binary("pi")
}

fn real_state(files: &RealFiles) -> (SetupState, Option<PathBuf>, bool) {
    let ext = real_ext_dir();
    let auto = files.agent.join("extensions").join("asn").join("index.ts").is_file();
    let st = compute_state(real_pi().is_some(), ext.as_deref(), files.settings().as_deref(), auto, &|p| files.exists(p));
    (st, ext, auto)
}

fn auto_pref_path() -> PathBuf {
    crate::identity::relay_home().join(AUTO_PREF)
}

/// 狀態的 JSON 多帶一個 auto：目前是否允許自動安裝（畫面用來說明「已關閉自動安裝」）
fn with_auto(mut v: Value) -> Value {
    v["auto"] = json!(auto_read(&auto_pref_path()).0);
    v
}

pub fn status_real() -> Value {
    let (agent, marker) = real_env();
    with_auto(real_state(&RealFiles { agent, marker }).0.to_json())
}

/// 啟動後在背景呼叫一次：預設開啟，第一次偵測到 pi 且還沒裝就自動安裝。回 None＝沒做事
pub fn auto_install_real() -> Option<Result<Value, String>> {
    let (agent, marker) = real_env();
    let files = RealFiles { agent, marker };
    let (st, ext, auto_dir) = real_state(&files);
    let pref = auto_pref_path();
    let pi = real_pi();
    let out = auto_step(&pref, &st, || {
        let (pi, ext) = (pi.ok_or("這台電腦找不到 pi")?, ext.ok_or("找不到 ASN 附的 pi 擴充")?);
        install(&pi, &ext, auto_dir, &RealRunner::default(), &files)
    });
    match out {
        AutoOutcome::Skipped => None,
        AutoOutcome::Installed => Some(Ok(with_auto(real_state(&files).0.to_json()))),
        AutoOutcome::Failed(e) => Some(Err(e)),
    }
}

pub fn install_real() -> Result<Value, String> {
    let (agent, marker) = real_env();
    let files = RealFiles { agent, marker };
    let pi = real_pi().ok_or("這台電腦找不到 pi，請先安裝 pi")?;
    let (_, ext, auto) = real_state(&files);
    let ext = ext.ok_or("找不到 ASN 附的 pi 擴充（安裝可能不完整），請重新安裝 ASN")?;
    install(&pi, &ext, auto, &RealRunner::default(), &files)?;
    auto_write(&auto_pref_path(), true, true);   // 使用者自己按了啟用：之後視為允許自動安裝
    Ok(with_auto(real_state(&files).0.to_json()))
}

pub fn remove_real() -> Result<Value, String> {
    let (agent, marker) = real_env();
    let files = RealFiles { agent, marker };
    let pi = real_pi().ok_or("這台電腦找不到 pi，沒辦法執行移除")?;
    let (_, ext, _) = real_state(&files);
    remove(&pi, ext.as_deref(), &RealRunner::default(), &files)?;
    auto_write(&auto_pref_path(), false, true);   // 使用者關掉：不再自動裝回
    Ok(with_auto(real_state(&files).0.to_json()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const EXT: &str = r"C:\ASN\pi-extension";

    /// 假檔案系統：settings.json 的 packages 與記錄檔都在記憶體裡
    struct FakeFiles {
        packages: RefCell<Vec<String>>,
        alive: Vec<String>,
        marker: RefCell<Option<String>>,
        no_settings: bool,
    }
    impl FakeFiles {
        fn new(packages: &[&str], alive: &[&str]) -> Self {
            FakeFiles { packages: RefCell::new(packages.iter().map(|s| s.to_string()).collect()), alive: alive.iter().map(|s| s.to_string()).collect(), marker: RefCell::new(None), no_settings: false }
        }
    }
    impl Files for FakeFiles {
        fn settings(&self) -> Option<String> {
            (!self.no_settings).then(|| json!({ "theme": "dark", "packages": *self.packages.borrow() }).to_string())
        }
        fn exists(&self, p: &str) -> bool {
            self.alive.iter().any(|a| norm(a) == norm(p))
        }
        fn read_marker(&self) -> Option<String> {
            self.marker.borrow().clone()
        }
        fn write_marker(&self, path: &str) -> Result<(), String> {
            *self.marker.borrow_mut() = Some(path.to_string());
            Ok(())
        }
        fn clear_marker(&self) {
            *self.marker.borrow_mut() = None;
        }
    }
    /// 假的 pi：install／remove 直接改 FakeFiles 的 packages；可模擬失敗與「說成功但沒生效」
    struct FakePi<'a> {
        files: &'a FakeFiles,
        calls: RefCell<Vec<Vec<String>>>,
        fail_install: bool,
        lie: bool,
        fail_remove: bool,
    }
    impl<'a> Runner for FakePi<'a> {
        fn run(&self, _p: &Path, args: &[String]) -> Result<(i32, String), String> {
            self.calls.borrow_mut().push(args.to_vec());
            match args[0].as_str() {
                "install" if self.fail_install => Ok((1, "EACCES: permission denied".into())),
                "install" => {
                    if !self.lie {
                        let mut p = self.files.packages.borrow_mut();
                        if !p.iter().any(|e| norm(e) == norm(&args[1])) {
                            p.push(args[1].clone());
                        }
                    }
                    Ok((0, "Installed".into()))
                }
                "remove" if self.fail_remove => Ok((1, "locked".into())),
                "remove" => {
                    self.files.packages.borrow_mut().retain(|e| norm(e) != norm(&args[1]));
                    Ok((0, "Removed".into()))
                }
                _ => Err("不認得的指令".into()),
            }
        }
    }
    fn pi_for(files: &FakeFiles) -> FakePi<'_> {
        FakePi { files, calls: RefCell::new(vec![]), fail_install: false, lie: false, fail_remove: false }
    }
    fn ext() -> &'static Path {
        Path::new(EXT)
    }
    fn exists_none(_: &str) -> bool {
        false
    }

    #[test]
    fn 設定位置_環境變數優先_否則家目錄() {
        assert_eq!(agent_dir(Some("D:/x/agent"), Path::new("C:/h")), PathBuf::from("D:/x/agent"));
        assert_eq!(agent_dir(Some("  "), Path::new("C:/h")), Path::new("C:/h").join(".pi").join("agent"));
        assert_eq!(agent_dir(None, Path::new("C:/h")), Path::new("C:/h").join(".pi").join("agent"));
    }

    #[test]
    fn 路徑比對_斜線_大小寫_尾端斜線_verbatim_前綴() {
        assert_eq!(norm(r"\\?\C:\ASN\pi-extension\"), norm("c:/asn/pi-extension"));
        assert!(looks_like_ext(r"D:\Github\Yooliang\asn\relay\pi-extension"));
        assert!(!looks_like_ext("npm:@foo/pi-extension-tools"));
        assert!(!looks_like_ext("D:/x/other"));
    }

    #[test]
    fn 設定檔的_packages_字串與物件都認_壞檔當沒有() {
        let t = r#"{"packages":["a/pi-extension",{"source":"b/c"},5,{"x":1}]}"#;
        assert_eq!(package_entries(Some(t)), vec!["a/pi-extension", "b/c"]);
        assert!(package_entries(Some("{壞")).is_empty());
        assert!(package_entries(None).is_empty());
        assert!(package_entries(Some(r#"{"packages":"x"}"#)).is_empty());
    }

    #[test]
    fn 狀態_沒裝_裝了現在這個_自動載入資料夾_別處裝的_舊的已不存在() {
        let s = |pkgs: &[&str], auto: bool, ex: &dyn Fn(&str) -> bool| {
            let t = json!({ "packages": pkgs }).to_string();
            compute_state(true, Some(ext()), Some(&t), auto, ex)
        };
        assert!(!s(&[], false, &exists_none).installed);
        assert!(s(&[EXT], false, &exists_none).installed, "裝了現在這個");
        assert!(s(&["c:/asn/PI-EXTENSION/"], false, &exists_none).installed, "大小寫與斜線不同也算");
        assert!(s(&[], true, &exists_none).installed, "放在 pi 的自動載入資料夾");
        let dev = s(&[r"D:\dev\relay\pi-extension"], false, &|p| p.contains("dev"));
        assert!(dev.installed && dev.stale.is_empty(), "別的資料夾裝的、路徑還在＝視為已安裝");
        let dead = s(&[r"D:\old\pi-extension"], false, &exists_none);
        assert!(!dead.installed && dead.stale == vec![r"D:\old\pi-extension"], "路徑已不存在＝舊的，要清");
        assert!(!s(&["npm:other"], false, &exists_none).installed, "別人的套件不算");
        let none = compute_state(false, None, None, false, &exists_none);
        assert_eq!((none.pi_found, none.ext_found, none.installed), (false, false, false));
        assert_eq!(none.to_json(), json!({ "pi": false, "ext": false, "installed": false, "stale": 0 }));
    }

    #[test]
    fn 安裝_成功_改設定_記下裝了哪一筆_重複安裝不會變兩筆() {
        let f = FakeFiles::new(&["npm:other"], &[]);
        let pi = pi_for(&f);
        install(Path::new("pi"), ext(), false, &pi, &f).unwrap();
        assert_eq!(*f.packages.borrow(), vec!["npm:other".to_string(), EXT.to_string()], "別人的套件原封不動");
        assert_eq!(f.read_marker().as_deref(), Some(EXT));
        install(Path::new("pi"), ext(), false, &pi, &f).unwrap();
        assert_eq!(f.packages.borrow().len(), 2, "重複安裝不重複寫入");
        assert_eq!(pi.calls.borrow()[0], vec!["install".to_string(), EXT.to_string()]);
    }

    #[test]
    fn 安裝_先清掉路徑已不存在的舊安裝_清不掉也不影響這次() {
        let f = FakeFiles::new(&[r"D:\old\pi-extension", r"D:\alive\pi-extension"], &[r"D:\alive\pi-extension"]);
        let pi = pi_for(&f);
        install(Path::new("pi"), ext(), false, &pi, &f).unwrap();
        let calls = pi.calls.borrow();
        assert_eq!(calls[0], vec!["remove".to_string(), r"D:\old\pi-extension".to_string()], "先清死掉的");
        assert!(!f.packages.borrow().iter().any(|e| e.contains("old")));
        assert!(f.packages.borrow().iter().any(|e| e.contains("alive")), "路徑還在的別處安裝不動");
        let f2 = FakeFiles::new(&[r"D:\old\pi-extension"], &[]);
        let mut pi2 = pi_for(&f2);
        pi2.fail_remove = true;
        install(Path::new("pi"), ext(), false, &pi2, &f2).unwrap();
        assert!(f2.packages.borrow().iter().any(|e| e == EXT), "舊的清不掉，新的照樣裝上");
    }

    #[test]
    fn 安裝_失敗情形_pi_回錯_說成功但沒生效() {
        let f = FakeFiles::new(&[], &[]);
        let mut pi = pi_for(&f);
        pi.fail_install = true;
        let e = install(Path::new("pi"), ext(), false, &pi, &f).unwrap_err();
        assert!(e.contains("安裝擴充失敗") && e.contains("permission denied"), "{e}");
        assert!(f.read_marker().is_none(), "失敗不留記錄");
        let mut liar = pi_for(&f);
        liar.lie = true;
        assert!(install(Path::new("pi"), ext(), false, &liar, &f).unwrap_err().contains("設定裡找不到"));
        assert!(f.read_marker().is_none());
        let mut f_nosettings = FakeFiles::new(&[], &[]);
        f_nosettings.no_settings = true;
        let pi3 = pi_for(&f_nosettings);
        assert!(install(Path::new("pi"), ext(), false, &pi3, &f_nosettings).is_err(), "讀不到設定就不能確認，不算成功");
    }

    #[test]
    fn 移除_只移除我們裝的那一筆_別人的套件與別處安裝都不動_還原記錄() {
        let f = FakeFiles::new(&["npm:other", r"D:\dev\pi-extension"], &[r"D:\dev\pi-extension"]);
        let pi = pi_for(&f);
        install(Path::new("pi"), ext(), false, &pi, &f).unwrap();
        assert!(f.packages.borrow().iter().any(|e| e == EXT));
        remove(Path::new("pi"), Some(ext()), &pi, &f).unwrap();
        assert_eq!(*f.packages.borrow(), vec!["npm:other".to_string(), r"D:\dev\pi-extension".to_string()], "只拿掉我們裝的");
        assert!(f.read_marker().is_none(), "記錄清掉");
        // 沒有記錄時用現在的擴充資料夾；本來就沒裝，pi 回成功也算成功
        remove(Path::new("pi"), Some(ext()), &pi, &f).unwrap();
        assert!(remove(Path::new("pi"), None, &pi, &f).unwrap_err().contains("不知道要移除哪一筆"));
    }

    #[test]
    fn 相對路徑_依_pi_設定資料夾解成絕對_其餘原樣() {
        let base = Path::new(r"C:\Users\u\.pi\agent");
        assert_eq!(norm(&resolve_entry(base, r"..\..\AppData\Local\ASN\pi-extension")), norm(r"C:\Users\u\AppData\Local\ASN\pi-extension"));
        assert_eq!(norm(&resolve_entry(base, "../x/pi-extension")), norm(r"C:\Users\u\.pi\x\pi-extension"));
        assert_eq!(norm(&resolve_entry(base, r".\local\pi-extension")), norm(r"C:\Users\u\.pi\agent\local\pi-extension"));
        for same in [r"C:\ASN\pi-extension", "npm:some-pkg", "git:github.com/a/b", "/opt/pi-extension"] {
            assert_eq!(resolve_entry(base, same), same, "{same}");
        }
    }

    #[test]
    fn 設定裡存相對路徑_也認得是現在這個擴充_不會誤判沒裝或失效() {
        // 真機上 pi 存的就是這種相對於 pi 設定資料夾的寫法（#305）
        let base = Path::new(r"C:\Users\u\.pi\agent");
        let ext = Path::new(r"C:\Users\u\AppData\Local\ASN\pi-extension");
        let text = r#"{"packages":["..\\..\\AppData\\Local\\ASN\\pi-extension"]}"#.to_string();
        let resolved = resolve_settings(base, text.clone()).unwrap();
        let st = compute_state(true, Some(ext), Some(&resolved), false, &exists_none);
        assert!(st.installed && st.stale.is_empty(), "{st:?}");
        // 沒解的話（舊行為）會被當成失效的舊擴充、而且不算裝了
        let old = compute_state(true, Some(ext), Some(&text), false, &exists_none);
        assert!(!old.installed && old.stale.len() == 1);
        // 物件寫法一樣處理；沒有 packages、壞檔原樣不動
        let obj = resolve_settings(base, r#"{"packages":[{"source":"../../AppData/Local/ASN/pi-extension"}]}"#.into()).unwrap();
        assert!(compute_state(true, Some(ext), Some(&obj), false, &exists_none).installed);
        assert_eq!(resolve_settings(base, "{壞掉".into()).unwrap(), "{壞掉");
        assert_eq!(resolve_settings(base, r#"{"a":1}"#.into()).unwrap(), r#"{"a":1}"#);
    }

    fn st(pi: bool, ext: bool, installed: bool) -> SetupState {
        SetupState { pi_found: pi, ext_found: ext, installed, stale: vec![] }
    }

    #[test]
    fn 自動安裝偏好_預設允許且未處理_壞檔用預設() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(AUTO_PREF);
        assert_eq!(auto_read(&p), (true, false));
        auto_write(&p, false, true);
        assert_eq!(auto_read(&p), (false, true));
        std::fs::write(&p, "{壞掉").unwrap();
        assert_eq!(auto_read(&p), (true, false));
    }

    #[test]
    fn 自動安裝_該裝才裝_找不到_pi_或擴充_已經裝了_都不動() {
        assert!(should_auto(true, false, &st(true, true, false)));
        assert!(!should_auto(true, false, &st(false, true, false)), "沒有 pi");
        assert!(!should_auto(true, false, &st(true, false, false)), "沒有 ASN 的擴充");
        assert!(!should_auto(true, false, &st(true, true, true)), "已經裝了");
        assert!(!should_auto(false, false, &st(true, true, false)), "使用者關掉");
        assert!(!should_auto(true, true, &st(true, true, false)), "處理過了");
    }

    #[test]
    fn 自動安裝_第一次裝並記下_之後使用者關掉就不再裝回() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(AUTO_PREF);
        let mut calls = 0;
        assert_eq!(auto_step(&p, &st(true, true, false), || { calls += 1; Ok(()) }), AutoOutcome::Installed);
        assert_eq!((calls, auto_read(&p)), (1, (true, true)));
        // 再啟動一次（即使現在沒裝）也不會又裝
        assert_eq!(auto_step(&p, &st(true, true, false), || { calls += 1; Ok(()) }), AutoOutcome::Skipped);
        assert_eq!(calls, 1);
        // 使用者關掉
        auto_write(&p, false, true);
        assert_eq!(auto_step(&p, &st(true, true, false), || panic!("不該裝")), AutoOutcome::Skipped);
        // 沒有紀錄檔、使用者一開始就關掉：不裝
        let p2 = d.path().join("other.json");
        auto_write(&p2, false, false);
        assert_eq!(auto_step(&p2, &st(true, true, false), || panic!("不該裝")), AutoOutcome::Skipped);
    }

    #[test]
    fn 自動安裝_本來就裝了記下已處理_失敗不記下次再試_沒有_pi_不動() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(AUTO_PREF);
        assert_eq!(auto_step(&p, &st(false, true, false), || panic!("不該裝")), AutoOutcome::Skipped);
        assert_eq!(auto_read(&p), (true, false), "沒有 pi：不留紀錄，之後裝了 pi 還能自動裝");
        assert_eq!(auto_step(&p, &st(true, true, false), || Err("壞了".into())), AutoOutcome::Failed("壞了".into()));
        assert_eq!(auto_read(&p), (true, false), "失敗不記，下次啟動再試");
        assert_eq!(auto_step(&p, &st(true, true, true), || panic!("不該裝")), AutoOutcome::Skipped);
        assert_eq!(auto_read(&p), (true, true), "本來就裝了：記下，之後被手動拿掉也不裝回");
    }

    #[test]
    fn 移除_用記錄裡的路徑_即使_asn_搬了家() {
        let f = FakeFiles::new(&[r"D:\old\pi-extension"], &[r"D:\old\pi-extension"]);
        f.write_marker(r"D:\old\pi-extension").unwrap();
        let pi = pi_for(&f);
        remove(Path::new("pi"), Some(ext()), &pi, &f).unwrap();
        assert!(f.packages.borrow().is_empty());
        assert_eq!(pi.calls.borrow()[0], vec!["remove".to_string(), r"D:\old\pi-extension".to_string()]);
    }

    #[test]
    fn 移除_失敗情形() {
        let f = FakeFiles::new(&[EXT], &[EXT]);
        f.write_marker(EXT).unwrap();
        let mut pi = pi_for(&f);
        pi.fail_remove = true;
        assert!(remove(Path::new("pi"), Some(ext()), &pi, &f).unwrap_err().contains("移除擴充失敗"));
        assert!(f.read_marker().is_some(), "失敗不清記錄，使用者可以再試");
    }

    // ---- 真的執行器：輸出量與逾時（Gemini 審查指出：只輪詢 try_wait 不讀管線，輸出超過管線緩衝區子程序就卡死）----
    #[cfg(windows)]
    fn ps(script: &str) -> Vec<String> {
        vec!["-NoProfile".into(), "-Command".into(), script.into()]
    }

    #[cfg(windows)]
    #[test]
    fn 真執行器_輸出遠超管線緩衝區也能正常結束_輸出只留上限() {
        // 30000 行 × 50 字 ≈ 1.5MB，遠大於管線緩衝區（Windows 預設只有 4KB）
        let r = RealRunner { timeout: std::time::Duration::from_secs(30) };
        let started = std::time::Instant::now();
        let (code, out) = r.run(Path::new("powershell"), &ps("1..30000 | ForEach-Object { 'x' * 50 }")).expect("大量輸出也要能跑完，不能卡到逾時");
        assert_eq!(code, 0);
        assert!(started.elapsed() < std::time::Duration::from_secs(25), "不該等到逾時：{:?}", started.elapsed());
        assert!(!out.is_empty() && out.len() <= OUT_CAP, "輸出要有內容、而且最多留上限：{}", out.len());
    }

    #[cfg(windows)]
    #[test]
    fn 真執行器_stderr_也一起收_結束碼照實回() {
        let r = RealRunner { timeout: std::time::Duration::from_secs(30) };
        let (code, out) = r.run(Path::new("powershell"), &ps("[Console]::Error.WriteLine('boom-err'); Write-Output 'ok-out'; exit 3")).unwrap();
        assert_eq!(code, 3);
        assert!(out.contains("ok-out") && out.contains("boom-err"), "{out}");
    }

    #[cfg(windows)]
    #[test]
    fn 真執行器_逾時會收掉程序並回原因() {
        let r = RealRunner { timeout: std::time::Duration::from_secs(2) };
        let started = std::time::Instant::now();
        let e = r.run(Path::new("powershell"), &ps("Start-Sleep -Seconds 60")).unwrap_err();
        assert!(e.contains("超過 2 秒"), "{e}");
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "逾時後要馬上回來：{:?}", started.elapsed());
    }

    #[cfg(windows)]
    #[test]
    fn 真執行器_起不來回原因() {
        let r = RealRunner::default();
        assert!(r.run(Path::new("Z:/不存在/pi.exe"), &[]).is_err());
    }

    /// 用真的 pi 與真的執行器端到端跑一次（`cargo test --lib -- --ignored pi_setup_real`）。
    /// 設定資料夾與 ASN 資料夾都指到臨時資料夾，不碰使用者真正的 pi 設定；需要這台電腦的 PATH 找得到 pi
    #[test]
    #[ignore = "需要真的 pi"]
    fn pi_setup_real_安裝與移除_臨時設定資料夾() {
        let d = tempfile::tempdir().unwrap();
        let agent = d.path().join("agent");
        let asn = d.path().join("asn");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::create_dir_all(&asn).unwrap();
        std::env::set_var("PI_CODING_AGENT_DIR", &agent);
        std::env::set_var("ASN_HOME", &asn);
        let settings = || std::fs::read_to_string(agent.join("settings.json")).unwrap_or_default();
        assert_eq!(status_real()["installed"], json!(false));
        let st = install_real().expect("安裝");
        assert_eq!(st["installed"], json!(true), "{st}");
        assert!(norm(&settings()).contains("pi-extension"), "設定裡有擴充：{}", settings());
        assert!(asn.join(MARKER).is_file(), "記下了裝了哪一筆");
        assert_eq!(status_real()["installed"], json!(true));
        install_real().expect("重複安裝");
        assert_eq!(package_entries(Some(&settings())).len(), 1, "不重複");
        let st = remove_real().expect("移除");
        assert_eq!(st["installed"], json!(false), "{st}");
        assert!(package_entries(Some(&settings())).is_empty());
        assert!(!asn.join(MARKER).exists(), "記錄清掉");
    }
}
