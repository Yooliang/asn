//! 型別守門（#2163 PR-2b，只在測試編譯）：原始碼裡每個 `flags::ms(…)`、`flags::on_exact_1(…)`、
//! `flags::switch_raw(…)`、`flags::path(…)` 呼叫，傳進去的名字必須已登記，而且登記的 `typed` 要和呼叫的函式對得上。
//! 否則 `ms()` 碰到型別登記錯時，正式版會悄悄回 0（debug_assert 只在除錯建置才叫）。
//!
//! 名字可以直接寫字串字面值，也可以寫成常數（`ENV_WEZTERM` 這種 `const X: &str = "ASN_…"`，用最後一段識別字去查）；
//! 查不到的寫法（變數、運算式）一律紅，逼呼叫端寫成看得懂的樣子。
use super::scan::stripped;
use super::{find, Typed};
use std::collections::BTreeMap;

const FNS: [&str; 4] = ["on_exact_1", "ms", "switch_raw", "path"];

fn fits(func: &str, typed: Typed) -> bool {
    matches!(
        (func, typed),
        ("on_exact_1", Typed::Exact1) | ("ms", Typed::Ms { .. }) | ("switch_raw", Typed::PlatformSwitch) | ("path", Typed::Path)
    )
}

pub(super) fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// 收集 `const 名字: &str = "字串"`（含 `pub(crate)`、`static`）
pub(super) fn consts(text: &str, out: &mut BTreeMap<String, String>) {
    let mut rest = text;
    while let Some(p) = rest.find(": &str") {
        let before = &rest[..p];
        let after = &rest[p + ": &str".len()..];
        let name: String = before.chars().rev().take_while(|c| is_ident(*c)).collect::<Vec<_>>().into_iter().rev().collect();
        let a = after.trim_start();
        if !name.is_empty() && before.trim_end_matches(is_ident).trim_end().ends_with("const") {
            if let Some(v) = a.strip_prefix('=').map(str::trim_start).and_then(|s| s.strip_prefix('"')) {
                if let Some(end) = v.find('"') {
                    out.insert(name, v[..end].to_string());
                }
            }
        }
        rest = after;
    }
}

/// 檢查一批（檔名, 原始碼），回違規清單。`stripped` 先去掉註解（字串保留）
pub fn check(files: &[(String, String)]) -> Vec<String> {
    let texts: Vec<(&String, String)> = files.iter().map(|(f, t)| (f, stripped(t))).collect();
    let mut table = BTreeMap::new();
    for (_, t) in &texts {
        consts(t, &mut table);
    }
    let mut bad = vec![];
    for (file, text) in &texts {
        if text.contains("use crate::flags::") || text.contains("use super::flags::") {
            bad.push(format!("{file} 用 use 把 flags 的函式引進來，守門看不到呼叫；請寫成 crate::flags::函式名(…)"));
        }
        for func in FNS {
            let needle = format!("flags::{func}(");
            let mut from = 0;
            while let Some(p) = text[from..].find(&needle) {
                let at = from + p;
                from = at + needle.len();
                let line = text[..at].matches('\n').count() + 1;
                let arg_src = text[from..].trim_start();
                let name: Option<String> = if let Some(s) = arg_src.strip_prefix('"') {
                    s.find('"').map(|e| s[..e].to_string())
                } else {
                    let ident: String = arg_src.chars().take_while(|c| is_ident(*c) || *c == ':').collect();
                    let last = ident.rsplit("::").next().unwrap_or("").to_string();
                    table.get(&last).cloned()
                };
                let Some(name) = name else {
                    bad.push(format!("{file}:{line} flags::{func}(…) 的名字不是字串字面值，也查不到是哪個常數（請直接寫名字或用 const X: &str = \"ASN_…\"）"));
                    continue;
                };
                match find(&name) {
                    None => bad.push(format!("{file}:{line} flags::{func}({name}) 的名字沒登記在 flags::FLAGS")),
                    Some(f) if matches!(f.kind, super::Kind::Test | super::Kind::Ci | super::Kind::Debug) => {
                        bad.push(format!("{file}:{line} flags::{func}({name}) 是測試／CI／除錯分類的變數，只能用 flags::test_var 讀"))
                    }
                    Some(f) if !fits(func, f.typed) => bad.push(format!("{file}:{line} flags::{func}({name}) 型別對不上：登記的 typed 是 {:?}", f.typed)),
                    _ => {}
                }
            }
        }
    }
    bad
}

#[test]
fn 守門_型別化讀取的呼叫與登記的型別對得上() {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![];
    for dir in [manifest.join("src"), manifest.join("tests")] {
        for f in super::scan::rs_files(&dir) {
            let rel = f.strip_prefix(&manifest).unwrap().to_string_lossy().replace('\\', "/");
            if rel.starts_with("src/flags/") {
                continue;
            }
            files.push((rel, std::fs::read_to_string(&f).unwrap()));
        }
    }
    let bad = check(&files);
    assert!(bad.is_empty(), "型別化讀取的呼叫有問題：\n{}", bad.join("\n"));
    // 守門自己沒瞎：至少看得到各種讀取函式的真實呼叫
    let all: String = files.iter().map(|(_, t)| stripped(t)).collect();
    for func in FNS {
        assert!(all.contains(&format!("flags::{func}(")), "掃不到任何 flags::{func}( 呼叫，守門可能失效");
    }
}

#[cfg(test)]
mod selftest {
    use super::*;

    fn run(src: &str) -> Vec<String> {
        check(&[("x.rs".to_string(), src.to_string())])
    }

    #[test]
    fn 對的呼叫不報() {
        let src = "const ENV_W: &str = \"ASN_TERM_WEZTERM\";\nfn a() { crate::flags::on_exact_1(\"ASN_WAIT_ALERT\"); crate::flags::ms(\"ASN_MOD_WAIT_MS\"); crate::flags::switch_raw(ENV_W); crate::flags::path(\"ASN_WEZTERM_DIR\"); }\n";
        assert!(run(src).is_empty(), "{:?}", run(src));
    }

    #[test]
    fn 型別不對要報() {
        let r = run("fn a() { crate::flags::ms(\"ASN_WAIT_ALERT\"); }\n");
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(r[0].contains("型別對不上") && r[0].contains("x.rs:1"), "{r:?}");
        // 反過來、以及新的兩種
        assert_eq!(run("fn a() { crate::flags::on_exact_1(\"ASN_MOD_WAIT_MS\"); }").len(), 1);
        assert_eq!(run("fn a() { crate::flags::switch_raw(\"ASN_WEZTERM_DIR\"); }").len(), 1);
        assert_eq!(run("fn a() { crate::flags::path(\"ASN_TERM_MUX\"); }").len(), 1);
    }

    #[test]
    fn 沒登記的名字要報() {
        let r = run("fn a() { crate::flags::ms(\"ASN_NOT_REGISTERED\"); }");
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(r[0].contains("沒登記"), "{r:?}");
    }

    #[test]
    fn 常數名字查得到也要比對型別() {
        let src = "pub const ENV_MUX: &str = \"ASN_TERM_MUX\";\nfn a() { crate::flags::ms(super::win_term::ENV_MUX); }";
        let r = run(src);
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(r[0].contains("ASN_TERM_MUX") && r[0].contains("型別對不上"), "{r:?}");
    }

    #[test]
    fn 看不懂的寫法也要報() {
        let r = run("fn a(n: &str) { crate::flags::on_exact_1(n); crate::flags::ms(&format!(\"x\")); }");
        assert_eq!(r.len(), 2, "{r:?}");
        assert!(r.iter().all(|m| m.contains("不是字串字面值")), "{r:?}");
    }

    #[test]
    fn 註解裡的呼叫不算_use_引進來要報() {
        assert!(run("// crate::flags::ms(\"ASN_WAIT_ALERT\")\n/// flags::ms(\"ASN_WAIT_ALERT\")\nfn a() {}").is_empty());
        let r = run("use crate::flags::ms;\nfn a() { ms(\"ASN_WAIT_ALERT\"); }");
        assert_eq!(r.len(), 1, "{r:?}");
    }

    #[test]
    fn 多行呼叫與行號() {
        let r = run("fn a() {\n    crate::flags::ms(\n        \"ASN_WAIT_ALERT\",\n    );\n}\n");
        assert_eq!(r.len(), 1, "{r:?}");
        assert!(r[0].contains("x.rs:2"), "{r:?}");
    }
}
