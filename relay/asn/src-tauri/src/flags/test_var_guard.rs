//! 測試變數守門（#2163 PR-3a，只在測試編譯）：登記為「測試／CI／除錯」分類的環境變數，
//! 1. 只能用 `flags::test_var(…)`／`flags::test_var_from(…)` 讀，而且這兩個函式只能收這三種分類的名字；
//! 2. 在正式碼（非測試編譯的部分）裡，名字（含舊名）的字串字面值只准出現在這兩個函式的第一個參數，
//!    不能被 `std::env::var`、`envc::get`、`flags::ms`… 或任何別的讀法碰到；
//! 3. 例外清單 [`EXEMPT`] 是空的（PR-3b 起），不准再加。
//!
//! 「測試編譯的部分」：整個檔案只在測試編譯（`tests/`、`*/tests.rs`、[`WHOLE_TEST_FILES`]），
//! 或從第一個 `#[cfg(test)] mod …` 往後。測試碼裡直接讀環境變數照舊放行（它們只在測試編譯存在）。
use super::guard::{consts, is_ident};
use super::scan::stripped;
use super::{find, Kind, FLAGS};
use std::collections::BTreeMap;

/// 例外清單：PR-3b 之後是空的（SHOT 兩個變數已改走 test_var，發版 e2e 改用 test-hooks 版 exe）。不准再加。
pub const EXEMPT: &[(&str, &str)] = &[];

/// 整個檔案只在測試編譯才存在（由父模組用 `#[cfg(test)] mod` 宣告、或本身是測試輔助），檔名看不出來的
const WHOLE_TEST_FILES: &[&str] = &["src/golden_util.rs", "src/test_guard.rs", "src/launch/term_live_mux.rs"];

const FNS: [&str; 2] = ["test_var", "test_var_from"];

fn is_test_kind(k: Kind) -> bool {
    matches!(k, Kind::Test | Kind::Ci | Kind::Debug)
}

fn whole_test(rel: &str) -> bool {
    rel.starts_with("tests/") || rel.contains("/tests/") || rel.ends_with("/tests.rs") || WHOLE_TEST_FILES.contains(&rel)
}

/// 第一個 `#[cfg(test)]` 後面接 `mod` 的位置（沒有就是檔尾）
fn test_region_start(text: &str) -> usize {
    let mark = "#[cfg(test)]";
    let mut from = 0;
    while let Some(p) = text[from..].find(mark) {
        let at = from + p;
        let after = text[at + mark.len()..].trim_start();
        if after.starts_with("mod ") || after.starts_with("pub mod ") || after.starts_with("pub(crate) mod ") {
            return at;
        }
        from = at + mark.len();
    }
    text.len()
}

/// 檢查一批（檔名, 原始碼），檔名要像 `src/x.rs`、`tests/y.rs`；回違規清單
pub fn check(files: &[(String, String)]) -> Vec<String> {
    let texts: Vec<(&String, String)> = files.iter().map(|(f, t)| (f, stripped(t))).collect();
    let mut table = BTreeMap::new();
    for (_, t) in &texts {
        consts(t, &mut table);
    }
    let mut bad = vec![];
    for (file, text) in &texts {
        if file.starts_with("src/flags/") {
            continue;
        }
        // 一：test_var 的名字必須是登記過的測試類
        for func in FNS {
            let needle = format!("flags::{func}(");
            let mut from = 0;
            while let Some(p) = text[from..].find(&needle) {
                let at = from + p;
                from = at + needle.len();
                let line = text[..at].matches('\n').count() + 1;
                let arg = text[from..].trim_start();
                let name = if let Some(s) = arg.strip_prefix('"') {
                    s.find('"').map(|e| s[..e].to_string())
                } else {
                    let ident: String = arg.chars().take_while(|c| is_ident(*c) || *c == ':').collect();
                    table.get(ident.rsplit("::").next().unwrap_or("")).cloned()
                };
                match name.as_deref().map(|n| (n, find(n))) {
                    None => bad.push(format!("{file}:{line} flags::{func}(…) 的名字不是字串字面值，也查不到是哪個常數")),
                    Some((n, None)) => bad.push(format!("{file}:{line} flags::{func}({n}) 的名字沒登記在 flags::FLAGS")),
                    Some((n, Some(f))) if !is_test_kind(f.kind) => {
                        bad.push(format!("{file}:{line} flags::{func}({n}) 登記的分類是「{}」，test_var 只收測試／CI／除錯", f.kind.label()))
                    }
                    _ => {}
                }
            }
        }
        // 二：正式碼裡，測試類名字的字面值只准出現在 test_var 的第一個參數
        // envc.rs 的 PAIRS 是新舊名對照表，不是讀取
        if whole_test(file) || file.as_str() == "src/envc.rs" {
            continue;
        }
        let prod = &text[..test_region_start(text)];
        for f in FLAGS.iter().filter(|f| is_test_kind(f.kind) && !EXEMPT.iter().any(|(e, _)| *e == f.name)) {
            for name in std::iter::once(f.name).chain(f.legacy) {
                let lit = format!("\"{name}\"");
                let mut from = 0;
                while let Some(p) = prod[from..].find(&lit) {
                    let at = from + p;
                    from = at + lit.len();
                    let before = prod[..at].trim_end();
                    if FNS.iter().any(|func| before.ends_with(&format!("flags::{func}("))) {
                        continue;
                    }
                    let line = prod[..at].matches('\n').count() + 1;
                    bad.push(format!("{file}:{line} 正式碼直接碰測試變數 {name}：只能用 flags::test_var／test_var_from 讀"));
                }
            }
        }
    }
    bad
}

#[test]
fn 守門_測試變數只能經_test_var_讀() {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![];
    for dir in [manifest.join("src"), manifest.join("tests")] {
        for f in super::scan::rs_files(&dir) {
            let rel = f.strip_prefix(&manifest).unwrap().to_string_lossy().replace('\\', "/");
            files.push((rel, std::fs::read_to_string(&f).unwrap()));
        }
    }
    let bad = check(&files);
    assert!(bad.is_empty(), "測試變數的讀法有問題：\n{}", bad.join("\n"));
    // 守門自己沒瞎：真的看得到 test_var 的呼叫
    let all: String = files.iter().filter(|(f, _)| !f.starts_with("src/flags/")).map(|(_, t)| stripped(t)).collect();
    assert!(all.contains("flags::test_var("), "掃不到任何 flags::test_var( 呼叫，守門可能失效");
    assert!(all.contains("flags::test_var_from("), "掃不到任何 flags::test_var_from( 呼叫，守門可能失效");
}

#[test]
fn 例外清單是空的_兩個_shot_變數也被守門納入() {
    assert!(EXEMPT.is_empty(), "例外清單不准再加；新的測試變數一律走 flags::test_var：{EXEMPT:?}");
    // 兩個 SHOT 變數要在「測試類」之列，才會被第二條規則（正式碼不准直接碰）掃到
    for n in ["ASN_SHOT_LOGIN", "ASN_SHOT_TOAST_LENIENT"] {
        let f = find(n).unwrap_or_else(|| panic!("{n} 沒登記"));
        assert!(is_test_kind(f.kind), "{n} 要登記成測試／CI／除錯分類");
    }
}

#[cfg(test)]
mod selftest {
    use super::*;

    fn run(file: &str, src: &str) -> Vec<String> {
        check(&[(file.to_string(), src.to_string())])
    }

    #[test]
    fn 正確用法不報() {
        let src = "fn a() { crate::flags::test_var(\"ASN_MOCK_BIN_DIR\"); crate::flags::test_var_from(\"ASN_CODEX_SCRIPT\", &|k| None); }";
        assert!(run("src/x.rs", src).is_empty(), "{:?}", run("src/x.rs", src));
    }

    #[test]
    fn 直接用_std_env_var_讀測試變數要報() {
        let r = run("src/x.rs", "fn a() { let _ = std::env::var(\"ASN_MOCK_BIN_DIR\"); }");
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(r[0].contains("ASN_MOCK_BIN_DIR") && r[0].contains("x.rs:1"), "{r:?}");
        // 別的讀取函式、舊名、除錯與 CI 類也一樣
        assert_eq!(run("src/x.rs", "fn a() { crate::envc::get(\"ASN_MOCK_BIN_DIR\"); }").len(), 1);
        assert_eq!(run("src/x.rs", "fn a() { std::env::var(\"IRORI_CODEX_SCRIPT\"); }").len(), 1);
        assert_eq!(run("src/x.rs", "fn a() { std::env::var(\"ASN_ASKPASS_PIPE\"); }").len(), 1);
        assert_eq!(run("src/x.rs", "fn a() { crate::flags::on_exact_1(\"ASN_MOCK_BIN_DIR\"); }").len(), 1);
    }

    #[test]
    fn 測試碼裡直接讀照舊放行() {
        let src = "fn a() {}\n#[cfg(test)]\nmod tests {\n fn t() { std::env::var(\"ASN_MANUAL_TEST\"); }\n}\n";
        assert!(run("src/x.rs", src).is_empty());
        assert!(run("tests/y.rs", "fn t() { std::env::var(\"ASN_MANUAL_TEST\"); }").is_empty());
        assert!(run("src/bridge/tests.rs", "fn t() { std::env::var(\"ASN_FAKE_CLAUDE\"); }").is_empty());
        // 但 mod 前面的正式碼不放行
        assert_eq!(run("src/x.rs", "fn a() { std::env::var(\"ASN_MANUAL_TEST\"); }\n#[cfg(test)]\nmod tests {}\n").len(), 1);
    }

    #[test]
    fn 註解裡的名字不算() {
        assert!(run("src/x.rs", "// std::env::var(\"ASN_MOCK_BIN_DIR\")\nfn a() {}").is_empty());
    }

    #[test]
    fn test_var_收正式分類的名字要報() {
        let r = run("src/x.rs", "fn a() { crate::flags::test_var(\"ASN_RELAY_ID\"); }");
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(r[0].contains("test_var 只收"), "{r:?}");
        assert_eq!(run("src/x.rs", "fn a() { crate::flags::test_var_from(\"ASN_NOT_REGISTERED\", &|_| None); }").len(), 1);
        assert_eq!(run("src/x.rs", "fn a(n: &str) { crate::flags::test_var(n); }").len(), 1);
    }

    #[test]
    fn shot_變數也只能經_test_var_讀() {
        assert_eq!(run("src/x.rs", "fn a() { std::env::var(\"ASN_SHOT_TOAST_LENIENT\"); }").len(), 1);
        assert_eq!(run("src/x.rs", "fn a() { crate::envc::get(\"ASN_SHOT_LOGIN\"); }").len(), 1);
        assert!(run("src/x.rs", "fn a() { crate::flags::test_var(\"ASN_SHOT_LOGIN\"); crate::flags::test_var(\"ASN_SHOT_TOAST_LENIENT\"); }").is_empty());
    }
}
