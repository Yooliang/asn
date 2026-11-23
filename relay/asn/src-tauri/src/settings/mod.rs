//! 共用設定層（#2162）。一種設定檔宣告成一個 [`Doc`] 型別，由這裡統一處理：
//! 位置、版本與遷移、壞檔備份、保留新版欄位、行程內的鎖與讀取快取、原子寫入。
//! 檔名、位置、格式都不變，所以新舊版本讀得到彼此寫的檔（多出來的 `version` 欄位舊版會忽略）。
//! 狀態與佇列類的檔案不走這一層，只共用 [`atomic::write`]。
pub mod atomic;
mod docs;
pub mod migrate;

pub use docs::NamesDoc;
#[cfg(desktop)]
pub use docs::{AcctPrefsDoc, AgentSetupPrefsDoc, BridgeDoc, LaunchPrefsDoc, PiAutoDoc, QuotaReadersDoc, VoiceDoc};

use serde::{de::DeserializeOwned, Serialize};
use std::any::Any;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

/// 檔案放在哪個資料夾底下
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// 應用程式資料資料夾（`data_dir`）
    Data,
    /// 收發室家目錄（`relay_home`，`~/.asn`）
    Home,
    /// 節點工作資料夾（`work_dir`）；沒有節點時不存在
    Work,
}

#[derive(Clone, Debug)]
pub struct Roots {
    pub data: PathBuf,
    pub home: PathBuf,
    pub work: Option<PathBuf>,
}

impl Roots {
    fn dir(&self, s: Scope) -> Option<&Path> {
        match s {
            Scope::Data => Some(&self.data),
            Scope::Home => Some(&self.home),
            Scope::Work => self.work.as_deref(),
        }
    }
}

static ROOTS: OnceLock<Roots> = OnceLock::new();

/// 啟動時呼叫一次（`lib.rs` 取得 data_dir 之後）。重複呼叫以第一次為準。
pub fn init(roots: Roots) {
    let _ = ROOTS.set(roots);
}

#[cfg(test)]
thread_local! {
    static TEST_ROOTS: std::cell::RefCell<Option<&'static Roots>> = const { std::cell::RefCell::new(None) };
}

/// 測試用：把「這個執行緒」的三個根都換到暫存資料夾底下（`data`、`home`、`work`），測試不准碰真的資料夾。
#[cfg(test)]
pub fn init_for_test(tmp: &Path) {
    let r: &'static Roots = Box::leak(Box::new(Roots { data: tmp.join("data"), home: tmp.join("home"), work: Some(tmp.join("work")) }));
    TEST_ROOTS.with(|t| *t.borrow_mut() = Some(r));
}

/// 測試用：讓這個執行緒的寫入一律失敗（模擬磁碟錯誤），用來驗證回給畫面的錯誤不含系統原文
#[cfg(test)]
thread_local! {
    pub static FAIL_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 目前的三個根；還沒 `init` 就是 None（讀取會回預設、寫入會回錯，不 panic）
pub fn roots() -> Option<&'static Roots> {
    #[cfg(test)]
    if let Some(r) = TEST_ROOTS.with(|t| *t.borrow()) {
        return Some(r);
    }
    ROOTS.get()
}

/// 一種設定檔的宣告。型別本身要帶 `#[serde(flatten)] extra: Map<String, Value>`，
/// 這樣較新版本寫的欄位讀進來不會丟，寫回去原樣保留。
pub trait Doc: Serialize + DeserializeOwned + Default + Clone + Send + 'static {
    /// 檔名（不含 .json，與現有檔名完全一致）
    const NAME: &'static str;
    const SCOPE: Scope;
    /// 目前的版本；沒有 `version` 欄位的舊檔視為 0
    const VERSION: u32;
    /// 從 `from` 版升到 `from + 1`，就地改 raw（不含 `version` 欄位）。要冪等。
    fn migrate(from: u32, raw: &mut serde_json::Value) -> Result<(), String> {
        let _ = (from, raw);
        Ok(())
    }
    /// 讀進來之後的最後一道：過濾壞值、套上限
    fn normalize(&mut self) {}
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadStatus {
    /// 檔案不存在（不會因為讀取而建檔）
    Fresh,
    Ok,
    /// 檔案是舊版（含沒有 version 的版本 0），已在記憶體中升版；檔案本身還沒改
    Migrated { from: u32 },
    /// 壞檔，已改名（或複製）保存成 `.bad-`，退回預設。只有確定留下副本才會是這個狀態
    Recovered,
    /// 暫時讀不到（被占用、沒權限），或壞檔連副本都存不下來：回預設讓畫面能用，但不快取、
    /// 寫入一律回錯，絕不覆蓋原檔。`kind` 是系統回報的錯誤種類（只給記錄與除錯看）
    Unreadable { kind: String },
    /// 檔案是更新的版本寫的：照常讀，寫入時保留不認得的欄位且版本號不降
    Newer { file_version: u32 },
    /// 壞檔，但**沒有動它**：只有唯讀讀取（`peek_in`）會回這個狀態，回預設值；
    /// 檔案原地不動，之後有人寫入（`update_in`／`save_in`）時才搬成 `.bad-` 再寫。`reason` 是固定的中文原因（不含檔案內容）
    Corrupt { reason: String },
}

#[derive(Clone, Debug)]
pub struct Loaded<T> {
    pub value: T,
    pub status: LoadStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsError(pub String);

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<std::io::Error> for SettingsError {
    fn from(e: std::io::Error) -> Self {
        SettingsError(e.to_string())
    }
}

// ---------------------------------------------------------------- 每個檔一把鎖＋快取

type Stamp = Option<(SystemTime, u64)>;

struct Cached<T> {
    value: T,
    status: LoadStatus,
    /// 檔案上的版本（沒有＝0）。寫入時用來決定不降版本號與要不要備份
    file_version: u32,
}

#[derive(Default)]
struct Slot {
    stamp: Stamp,
    cached: Option<Box<dyn Any + Send>>,
    /// 唯讀讀取看過的壞檔（修改時間與大小都沒變就不重讀、不重記）與原因；`stamp`／`cached` 不會放壞檔的結果，
    /// 所以之後的 `load_in`／`update_in` 一定會自己重讀、照常把它搬走
    bad: Option<(Stamp, String)>,
    /// 唯讀讀取上一次記 log 的時間：同一個檔 60 秒最多記一行
    last_log: Option<std::time::Instant>,
}

static SLOTS: Mutex<Option<HashMap<PathBuf, Arc<Mutex<Slot>>>>> = Mutex::new(None);

fn slot_of(path: &Path) -> Arc<Mutex<Slot>> {
    let mut g = SLOTS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashMap::new).entry(path.to_path_buf()).or_default().clone()
}

fn stamp_of(path: &Path) -> Stamp {
    std::fs::metadata(path).ok().and_then(|m| Some((m.modified().ok()?, m.len())))
}

fn path_in<T: Doc>(dir: &Path) -> PathBuf {
    let p = dir.join(format!("{}.json", T::NAME));
    #[cfg(test)]
    crate::test_guard::assert_not_real(&p, "settings");
    p
}

fn path_of<T: Doc>() -> Option<PathBuf> {
    roots()?.dir(T::SCOPE).map(path_in::<T>)
}

fn clone_cached<T: Doc>(c: &Cached<T>) -> Cached<T> {
    Cached { value: c.value.clone(), status: c.status.clone(), file_version: c.file_version }
}

/// 已持鎖。讀檔（或用快取：檔案修改時間與大小沒變就不重讀），回出值、狀態與檔案版本
fn read_locked<T: Doc>(slot: &mut Slot, path: &Path) -> Cached<T> {
    let stamp = stamp_of(path);
    if stamp == slot.stamp {
        if let Some(c) = slot.cached.as_ref().and_then(|b| b.downcast_ref::<Cached<T>>()) {
            return clone_cached(c);
        }
    }
    let c = read_and_cache::<T>(slot, path);
    c
}

/// 強制重讀（不看快取）並更新快取。暫時讀不到的結果不進快取，下次照樣重讀
fn read_and_cache<T: Doc>(slot: &mut Slot, path: &Path) -> Cached<T> {
    let c = read_fresh::<T>(path, true);
    slot.bad = None;
    if matches!(c.status, LoadStatus::Unreadable { .. }) {
        slot.stamp = None;
        slot.cached = None;
    } else {
        // 隔離壞檔後檔案已不在，stamp 要重取
        slot.stamp = stamp_of(path);
        slot.cached = Some(Box::new(clone_cached(&c)));
    }
    c
}

/// 壞檔隔離：留下副本才算 Recovered；改名與複製都失敗就是 Unreadable（原檔還在原位，不准被覆蓋）
fn quarantined(path: &Path, reason: &str) -> LoadStatus {
    match migrate::quarantine(path, reason) {
        Ok(()) => LoadStatus::Recovered,
        Err(kind) => LoadStatus::Unreadable { kind },
    }
}

/// `mutate`＝true：壞檔會被搬走（`load`／`update` 用）。false：唯讀，壞檔原地不動、回 `Corrupt`，也不記 log（由呼叫端節流後記）
fn read_fresh<T: Doc>(path: &Path, mutate: bool) -> Cached<T> {
    let fresh = |status| Cached { value: T::default(), status, file_version: 0 };
    let bad = |reason: &str| if mutate { quarantined(path, reason) } else { LoadStatus::Corrupt { reason: reason.to_string() } };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return fresh(LoadStatus::Fresh),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            return fresh(bad("不是合法的文字編碼"));
        }
        Err(e) => {
            // 暫時讀不到（被占用、沒權限）：不動檔案，這次回預設
            if mutate {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                elog!("[ASN] 設定檔 {name} 讀不到（{}），這次用預設，也不會寫入", e.kind());
            }
            return fresh(LoadStatus::Unreadable { kind: format!("{:?}", e.kind()) });
        }
    };
    match migrate::parse::<T>(&text) {
        Ok((value, fv)) => {
            let status = if fv > T::VERSION {
                LoadStatus::Newer { file_version: fv }
            } else if fv < T::VERSION {
                LoadStatus::Migrated { from: fv }
            } else {
                LoadStatus::Ok
            };
            Cached { value, status, file_version: fv }
        }
        Err(reason) => fresh(bad(&reason)),
    }
}

/// 已持鎖。寫入並更新快取
fn write_locked<T: Doc>(slot: &mut Slot, path: &Path, cur: &Cached<T>, v: &T) -> Result<(), SettingsError> {
    // 沒讀到原檔就不准寫：寫下去會把原檔（含新版欄位與較高的版本號）整份蓋掉
    if matches!(cur.status, LoadStatus::Unreadable { .. }) {
        return Err(SettingsError("設定檔暫時讀不到（可能被其他程式占用），這次沒有存，稍後再試".into()));
    }
    let version = T::VERSION.max(cur.file_version);
    // 檔案版本不等於本版（舊版要升、或較新版寫的）：第一次寫入前先備份；較新版的檔會被 normalize 洗掉已知欄位的新值
    if cur.file_version != T::VERSION && !matches!(cur.status, LoadStatus::Fresh | LoadStatus::Recovered) {
        migrate::backup_old(path, cur.file_version).map_err(|_| SettingsError("設定檔寫入前的備份存不下來，這次沒有存，稍後再試".into()))?;
    }
    let text = migrate::render(v, version)?;
    // 給畫面的錯誤固定成白話句，系統原文（例如「拒絕存取 (os error 5)」）只寫進 log（不含檔案內容）
    #[cfg(test)]
    let written = if FAIL_WRITE.with(|f| f.get()) { Err(std::io::Error::from_raw_os_error(5)) } else { atomic::write(path, text.as_bytes(), atomic::SETTINGS) };
    #[cfg(not(test))]
    let written = atomic::write(path, text.as_bytes(), atomic::SETTINGS);
    written.map_err(|e| {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        elog!("[ASN] 設定檔 {name} 寫入失敗（{e}），這次沒有存");
        SettingsError("設定檔寫入失敗，這次沒有存，稍後再試".into())
    })?;
    let mut value = v.clone();
    value.normalize();
    slot.stamp = stamp_of(path);
    slot.cached = Some(Box::new(Cached { value, status: LoadStatus::Ok, file_version: version }));
    Ok(())
}

// ---------------------------------------------------------------- 以資料夾為準的版本（呼叫端自己帶資料夾：測試，以及還沒改成用 Roots 的呼叫端）

/// `dir` 取代 Scope 的根；檔案是 `<dir>/<NAME>.json`
pub fn load_in<T: Doc>(dir: &Path) -> Loaded<T> {
    load_at(&path_in::<T>(dir))
}

pub fn save_in<T: Doc>(dir: &Path, v: &T) -> Result<(), SettingsError> {
    save_at(&path_in::<T>(dir), v)
}

pub fn update_in<T: Doc, R>(dir: &Path, f: impl FnOnce(&mut T) -> R) -> Result<R, SettingsError> {
    update_at(&path_in::<T>(dir), f)
}

/// 唯讀讀取：**不搬檔、不備份、不寫檔**。給「只該讀、不該動檔案」的一側用（例如收發室橋讀 `bridge.json`，
/// 搬檔只准在畫面那一側寫入時發生）。有快取（修改時間與大小沒變就不重讀），熱路徑上不比直接讀檔慢。
/// 壞檔回預設值與 `Corrupt`，同一個壞檔只讀一次、記一行 `[ASN]` log（之後 60 秒內不再記）；讀到更新版本寫的檔照常讀（`Newer`），不備份。
pub fn peek_in<T: Doc>(dir: &Path) -> Loaded<T> {
    peek_at(&path_in::<T>(dir))
}

/// 同 [`update_in`]，但 `f` 回 `Err` 就**不寫檔**（也不建檔、不備份），原樣把 `Err` 交回。
/// 給「先驗證、驗不過就不存」的讀改寫用，免得驗不過也白寫一次
pub fn try_update_in<T: Doc, R, E>(dir: &Path, f: impl FnOnce(&mut T) -> Result<R, E>) -> Result<Result<R, E>, SettingsError> {
    try_update_at(&path_in::<T>(dir), f)
}

#[cfg(test)]
thread_local! {
    /// 測試用：唯讀讀取實際記了幾行 log
    pub static PEEK_LOGS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

const PEEK_LOG_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

fn peek_at<T: Doc>(path: &Path) -> Loaded<T> {
    let slot = slot_of(path);
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    let stamp = stamp_of(path);
    if stamp == g.stamp {
        if let Some(c) = g.cached.as_ref().and_then(|b| b.downcast_ref::<Cached<T>>()) {
            return Loaded { value: c.value.clone(), status: c.status.clone() };
        }
    }
    if let Some((bad_stamp, reason)) = &g.bad {
        if stamp.is_some() && *bad_stamp == stamp {
            return Loaded { value: T::default(), status: LoadStatus::Corrupt { reason: reason.clone() } };
        }
    }
    let c = read_fresh::<T>(path, false);
    g.bad = None;
    match &c.status {
        LoadStatus::Corrupt { .. } | LoadStatus::Unreadable { .. } => {
            // 壞檔與暫時讀不到的結果都不進快取；壞檔記下修改時間，同一份不重讀
            g.stamp = None;
            g.cached = None;
            let what = match &c.status {
                LoadStatus::Corrupt { reason } => {
                    g.bad = Some((stamp, reason.clone()));
                    format!("損毀（{reason}），這次用預設，檔案原地不動")
                }
                LoadStatus::Unreadable { kind } => format!("讀不到（{kind}），這次用預設"),
                _ => String::new(),
            };
            let due = g.last_log.is_none_or(|t| t.elapsed() >= PEEK_LOG_EVERY);
            if due {
                g.last_log = Some(std::time::Instant::now());
                #[cfg(test)]
                PEEK_LOGS.with(|n| n.set(n.get() + 1));
                elog!("[ASN] 設定檔 {} {what}", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            }
        }
        _ => {
            g.stamp = stamp_of(path);
            g.cached = Some(Box::new(clone_cached(&c)));
        }
    }
    Loaded { value: c.value, status: c.status }
}

fn load_at<T: Doc>(path: &Path) -> Loaded<T> {
    let slot = slot_of(path);
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    let c = read_locked::<T>(&mut g, path);
    Loaded { value: c.value, status: c.status }
}

fn save_at<T: Doc>(path: &Path, v: &T) -> Result<(), SettingsError> {
    let slot = slot_of(path);
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    // 寫入前一律在鎖裡重讀原檔，不看快取
    let cur = read_and_cache::<T>(&mut g, path);
    write_locked(&mut g, path, &cur, v)
}

fn update_at<T: Doc, R>(path: &Path, f: impl FnOnce(&mut T) -> R) -> Result<R, SettingsError> {
    let slot = slot_of(path);
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    // 讀、改、寫一律在鎖裡重讀原檔，不看快取
    let cur = read_and_cache::<T>(&mut g, path);
    let mut v = cur.value.clone();
    let r = f(&mut v);
    write_locked(&mut g, path, &cur, &v)?;
    Ok(r)
}

fn try_update_at<T: Doc, R, E>(path: &Path, f: impl FnOnce(&mut T) -> Result<R, E>) -> Result<Result<R, E>, SettingsError> {
    let slot = slot_of(path);
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    let cur = read_and_cache::<T>(&mut g, path);
    let mut v = cur.value.clone();
    match f(&mut v) {
        Ok(r) => {
            write_locked(&mut g, path, &cur, &v)?;
            Ok(Ok(r))
        }
        Err(e) => Ok(Err(e)),
    }
}

// ---------------------------------------------------------------- 以 Roots 為準的正式介面

/// 永遠回得出值：不 panic、不回錯。檔案不存在＝Fresh（不建檔）；壞檔＝留下副本後回預設（Recovered）；
/// 暫時讀不到＝Unreadable（回預設、不快取，寫入會回錯）
pub fn load<T: Doc>() -> Loaded<T> {
    match path_of::<T>() {
        Some(p) => load_at(&p),
        None => Loaded { value: T::default(), status: LoadStatus::Fresh },
    }
}

pub fn get<T: Doc>() -> T {
    load::<T>().value
}

pub fn save<T: Doc>(v: &T) -> Result<(), SettingsError> {
    save_at(&path_of::<T>().ok_or_else(no_root)?, v)
}

/// 持鎖完成「讀、改、寫」（一律重讀原檔），兩個執行緒同時改不同欄位不會互相蓋掉。
///
/// 已知限制：
/// - 鎖只在行程內；另一個行程（別的 ASN 實例、舊橋）同時寫同一個檔仍會 lost update（後寫的贏）。
/// - 鎖不可重入：`f` 裡面不准再呼叫同一個 Doc 的 `load`／`get`／`save`／`update`，否則死鎖。
/// - 鎖的鍵是路徑原樣，`load::<T>()` 與 `load_in(dir)` 混用時要傳同一個資料夾。
/// - 檔案裡較新版寫的已知欄位新值（例如更多的選項）讀進來會被 `normalize` 退回預設，下一次存檔就寫成預設值。
/// - `save` 是整份取代：只有帶著讀進來的 `extra` 才會保留不認得的欄位，要保留請用 `update`。
pub fn update<T: Doc, R>(f: impl FnOnce(&mut T) -> R) -> Result<R, SettingsError> {
    update_at(&path_of::<T>().ok_or_else(no_root)?, f)
}

fn no_root() -> SettingsError {
    SettingsError("設定資料夾還沒決定".into())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod moved_tests;
#[cfg(all(test, desktop))]
mod bridge_prefs_tests;
