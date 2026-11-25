//! 測試變數的讀取（#2163 PR-3a）：登記表裡分類為「測試／CI／除錯」的環境變數，只准經由這裡讀。
//!
//! 只有三種建置讀得到：測試編譯（`cfg(test)`）、除錯建置（`debug_assertions`）、帶 `test-hooks` feature 的建置。
//! 其他建置（也就是正式安裝包）一律回 `None`，設了也沒用。守門在 `test_var_guard.rs`：
//! 測試類的名字不准被 `std::env::var`、`envc::get` 等其他讀法直接讀。
//!
//! 名字必須是登記表裡分類為測試／CI／除錯的，否則除錯建置會 panic（正式碼要靠守門測試擋）。
use super::{find, Kind};

/// 這個建置讀不讀測試變數。拆成純函式，是為了在 `cargo test`（一定有 cfg(test)）裡也能驗「三個條件都沒有時要關」
pub const fn hooks_enabled(is_test: bool, debug_assertions: bool, feature_test_hooks: bool) -> bool {
    is_test || debug_assertions || feature_test_hooks
}

/// 目前這個建置的狀態
const fn hooks_on() -> bool {
    hooks_enabled(cfg!(test), cfg!(debug_assertions), cfg!(feature = "test-hooks"))
}

fn check_kind(name: &str) {
    debug_assert!(
        find(name).is_some_and(|f| matches!(f.kind, Kind::Test | Kind::Ci | Kind::Debug)),
        "環境變數 {name} 沒登記成測試／CI／除錯分類，不能用 flags::test_var 讀"
    );
}

/// 讀本行程的測試變數（新名優先，沒有才讀舊名）。這個建置不讀測試變數時回 `None`。
pub fn test_var(name: &str) -> Option<String> {
    check_kind(name);
    if !hooks_on() {
        return None;
    }
    // 有舊名的走 envc（新名優先、退回舊名）；沒有舊名的直接讀（envc::get 只認 PAIRS 裡的名字）
    if crate::envc::legacy(name).is_some() {
        crate::envc::get(name)
    } else {
        std::env::var(name).ok()
    }
}

/// 同 [`test_var`]，查詢函式可替換（讀引擎的環境快照、測試用）。查詢函式只回「這個名字」的值；
/// 有舊名的變數，新名沒有值時退回舊名（規則同 `envc::pick`）
pub fn test_var_from(name: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    test_var_gated(hooks_on(), name, lookup)
}

/// [`test_var_from`] 的本體，建置狀態當參數（測試用它驗「關著時一律回 None」）
pub(super) fn test_var_gated(on: bool, name: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    check_kind(name);
    if !on {
        return None;
    }
    if crate::envc::legacy(name).is_some() {
        crate::envc::pick(lookup, name)
    } else {
        lookup(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn 三個條件只要有一個成立就開_全沒有才關() {
        assert!(!hooks_enabled(false, false, false), "正式建置（沒有 test、debug_assertions、test-hooks）必須關");
        assert!(hooks_enabled(true, false, false));
        assert!(hooks_enabled(false, true, false));
        assert!(hooks_enabled(false, false, true));
    }

    #[test]
    fn 關著的建置_就算環境裡有設也回_none() {
        let lookup = table(&[("ASN_MOCK_BIN_DIR", "/fake"), ("ASN_CODEX_SCRIPT", "x.mjs")]);
        assert_eq!(test_var_gated(false, "ASN_MOCK_BIN_DIR", &lookup), None);
        assert_eq!(test_var_gated(false, "ASN_CODEX_SCRIPT", &lookup), None);
        assert_eq!(test_var_gated(true, "ASN_MOCK_BIN_DIR", &lookup).as_deref(), Some("/fake"));
    }

    #[test]
    fn 有設_沒設_舊名退回() {
        assert_eq!(test_var_from("ASN_MOCK_BIN_DIR", &table(&[("ASN_MOCK_BIN_DIR", "/a")])).as_deref(), Some("/a"));
        assert_eq!(test_var_from("ASN_MOCK_BIN_DIR", &table(&[])), None);
        assert_eq!(test_var_from("ASN_CODEX_SCRIPT", &table(&[("IRORI_CODEX_SCRIPT", "old.mjs")])).as_deref(), Some("old.mjs"));
        assert_eq!(
            test_var_from("ASN_CODEX_SCRIPT", &table(&[("ASN_CODEX_SCRIPT", "new.mjs"), ("IRORI_CODEX_SCRIPT", "old.mjs")])).as_deref(),
            Some("new.mjs"),
            "新名優先"
        );
        // 沒有舊名的變數：只讀新名
        assert_eq!(test_var_from("ASN_ASKPASS_PIPE", &table(&[("ASN_ASKPASS_PIPE", "asn-askpass-test-1")])).as_deref(), Some("asn-askpass-test-1"));
    }

    #[test]
    fn 本行程讀取_測試編譯下有開() {
        assert!(hooks_on(), "cargo test 一定有 cfg(test)");
        // 已登記、平常沒人設的測試變數：回 None（不是 panic）
        assert_eq!(test_var("ASN_15Q_HIDDEN"), None);
    }

    #[test]
    #[should_panic(expected = "沒登記成測試")]
    fn 正式分類的名字不能用_test_var() {
        let _ = test_var_from("ASN_RELAY_ID", &table(&[]));
    }
}
