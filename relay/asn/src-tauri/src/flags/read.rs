//! 型別化讀取（#2163 PR-2a）：橋這邊沒有舊名的正式功能開關，經由登記表讀，預設值與範圍也從登記表拿。
//!
//! **解析規則與改之前逐字相同**（對照測試在 `tests.rs`，把舊讀法抄成參考函式逐一比對）：
//! - [`on_exact_1`]：`trim()` 後剛好是 "1" 才開，不是「非 0 即開」；
//! - [`ms`]：`trim()` 後 `parse::<u64>()`，落在登記的範圍內才採用，否則用登記的預設。
//!
//! 這兩個變數都沒有舊名（`IRORI_*`），所以不走 `envc` 的新舊名對照；日後若要加舊名相容，
//! 照 `envc::pick` 的規則（新名優先、空白退回舊名）在這裡加，不要在呼叫端各寫各的。
use super::{find, Typed};

fn process_env(name: &str) -> Option<String> {
    // 與改之前相同：值不是合法 Unicode 時 `.ok()` 當沒設
    std::env::var(name).ok()
}

fn spec(name: &str) -> Typed {
    match find(name) {
        Some(f) => f.typed,
        None => {
            debug_assert!(false, "環境變數 {name} 沒登記在 flags::FLAGS");
            Typed::None
        }
    }
}

/// 開關，語意是「值 trim 之後剛好等於 "1"」。沒設、空字串、"0"、"true"、"2"、" 11 " 一律是關。
pub fn on_exact_1(name: &str) -> bool {
    on_exact_1_from(&process_env, name)
}

/// 同 [`on_exact_1`]，查詢函式可替換（測試用）
pub fn on_exact_1_from(lookup: &dyn Fn(&str) -> Option<String>, name: &str) -> bool {
    debug_assert!(matches!(spec(name), Typed::Exact1), "環境變數 {name} 沒登記成 Typed::Exact1");
    lookup(name).is_some_and(|v| v.trim() == "1")
}

/// 平台預設開關的原始字串（#2163 PR-2b）：與改之前的 `std::env::var(名字).ok()` 完全相同
/// （沒設、值不是合法 Unicode 都回 None；有設就原樣回傳，不 trim、不改大小寫）。
/// 開或關由呼叫端既有的純函式依平台判定（`win_term::switches_from`、`screen_watch::enabled_on`），預設值就在那些函式裡、由測試釘住。
pub fn switch_raw(name: &str) -> Option<String> {
    switch_raw_from(&process_env, name)
}

/// 同 [`switch_raw`]，查詢函式可替換（測試用）
pub fn switch_raw_from(lookup: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    debug_assert!(matches!(spec(name), Typed::PlatformSwitch), "環境變數 {name} 沒登記成 Typed::PlatformSwitch");
    lookup(name)
}

/// 路徑：與改之前的 `std::env::var_os(名字).map(PathBuf::from)` 完全相同（沒設回 None；設成空字串回空路徑，
/// 要不要把空字串當沒設由呼叫端決定）。
pub fn path(name: &str) -> Option<std::path::PathBuf> {
    path_from(&|n| std::env::var_os(n), name)
}

/// 同 [`path`]，查詢函式可替換（測試用）
pub fn path_from(lookup: &dyn Fn(&str) -> Option<std::ffi::OsString>, name: &str) -> Option<std::path::PathBuf> {
    debug_assert!(matches!(spec(name), Typed::Path), "環境變數 {name} 沒登記成 Typed::Path");
    lookup(name).map(std::path::PathBuf::from)
}

/// 毫秒數：`trim()` 後解析成 u64，在登記的 `[min, max]` 內採用，否則（沒設、解析失敗、負數、超出範圍）回登記的預設值。
pub fn ms(name: &str) -> u64 {
    ms_from(&process_env, name)
}

/// 同 [`ms`]，查詢函式可替換（測試用）
pub fn ms_from(lookup: &dyn Fn(&str) -> Option<String>, name: &str) -> u64 {
    match spec(name) {
        Typed::Ms { default, min, max } => lookup(name).and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| (min..=max).contains(v)).unwrap_or(default),
        other => {
            debug_assert!(false, "環境變數 {name} 沒登記成 Typed::Ms（實際 {other:?}）");
            0
        }
    }
}
