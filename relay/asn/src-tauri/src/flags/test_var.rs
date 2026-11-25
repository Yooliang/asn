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

/// 標記字串（#2163 PR-3b 第三道證明）：只在帶 `test-hooks` feature 的建置才編進執行檔。
/// 發版 CI 對正式 exe 掃不到、對 hooks 版 exe 掃得到（scripts/hooks-marker-scan.mjs）。
/// 這個字面值不准出現在任何別的正式碼，否則正式 exe 也會掃到（掃描腳本與測試在 JS 那邊，不編進執行檔）。
#[cfg(feature = "test-hooks")]
#[used]
pub static TEST_HOOKS_MARKER: &[u8] = b"ASN_TEST_HOOKS_ENABLED_MARKER";

/// 讓標記被實際引用，連結器（LTO、gc-sections）才不會把它丟掉
#[cfg(feature = "test-hooks")]
#[inline(never)]
fn touch_marker() {
    std::hint::black_box(&TEST_HOOKS_MARKER);
}

#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
fn touch_marker() {}

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
    touch_marker();
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
    touch_marker();
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

    // build.rs 用的判斷（同一份檔，include! 進來）
    mod build_guard {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/build_guard.rs"));

        #[test]
        fn 發版建置帶_test_hooks_要拒絕() {
            let msg = shipping_with_hooks_error(Some("1"), true).expect("發版建置帶 test-hooks 必須被拒");
            assert!(msg.contains("test-hooks"), "{msg}");
        }

        #[test]
        fn 其他組合都放行() {
            assert!(shipping_with_hooks_error(Some("1"), false).is_none(), "發版建置沒帶 hooks 要放行");
            assert!(shipping_with_hooks_error(None, true).is_none(), "e2e 專用的 hooks 版（沒設發版變數）要放行");
            assert!(shipping_with_hooks_error(Some("0"), true).is_none());
            assert!(shipping_with_hooks_error(None, false).is_none());
        }
    }

    #[test]
    fn build_rs_真的呼叫了判斷並_panic() {
        // 防「函式有測、build.rs 卻沒接上」：build.rs 必須用這個函式、讀這兩個環境變數、並 panic
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/build.rs")).unwrap();
        for need in ["include!(\"build_guard.rs\")", "shipping_with_hooks_error(", "CARGO_FEATURE_TEST_HOOKS", "ASN_SHIPPING_BUILD", "panic!("] {
            assert!(src.contains(need), "build.rs 少了 {need}");
        }
    }

    #[cfg(feature = "test-hooks")]
    #[test]
    fn hooks_版有標記() {
        assert_eq!(TEST_HOOKS_MARKER, b"ASN_TEST_HOOKS_ENABLED_MARKER");
    }

    #[test]
    #[should_panic(expected = "沒登記成測試")]
    fn 正式分類的名字不能用_test_var() {
        let _ = test_var_from("ASN_RELAY_ID", &table(&[]));
    }
}
