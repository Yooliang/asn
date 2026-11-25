//! 原始碼掃描器（只在測試編譯）：找出 `.rs` 裡出現的 `ASN_*` 名字。
//!
//! 設計重點（涵蓋 #2232 講的兩個盲點，以及盤點時發現的漏網讀法）：
//! - 不分「測試模組／正式碼」，整個檔案都掃：測試模組後面的正式碼不會被漏掉。
//! - 掃字串字面值與程式碼本身，不管名字是直接丟給 `std::env::var` / `var_os` / `env!` / `option_env!`，
//!   還是先放進 `const X: &str = "ASN_…"` 再拿去讀，字面值只要出現就被抓到。
//! - 先去掉註解（`//`、`///`、`//!`、`/* */`，含巢狀），字串保留；字串裡的 `//` 不當註解。
//! - 處理一般字串、位元組字串、原始字串（`r#"…"#`）與字元字面值（`'"'`），生命週期 `'a` 不當字元。
//! - 左邊要是單字邊界：`CLAUDE_ASN_TEST`、`遷移_ASN_HOME_有設` 這種夾在別的識別字中間的不算。
//! - `ASN_` 後面不是大寫字母或數字開頭的（`ASN_{key}`、`ASN_切換`）不是名字；字串裡「`ASN_` 開頭卻不完整」
//!   （`"ASN_"`、`"ASN_AEGIS_"`、`ASN_{…}`、`ASN_0.1.33_…`）另列為「動態組名候選」，要明確放行，
//!   不然 `concat!`／`format!` 拼名字就能繞過登記。
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Seg {
    Code(String, usize),
    Str(String, usize),
}

/// 名字候選
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Hit {
    /// 完整名字（`ASN_…`）；動態組名候選是它被截斷的樣子（可能只有 `ASN_`）
    pub text: String,
    pub line: usize,
    pub in_string: bool,
    /// 是不是動態組名候選（不是完整名字）
    pub dynamic: bool,
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// 把原始碼切成「程式碼」與「字串」兩種片段，註解整段丟掉；每段帶起始行號（從 1 起）
pub fn lex(src: &str) -> Vec<Seg> {
    let ch: Vec<char> = src.chars().collect();
    let mut segs: Vec<Seg> = vec![];
    let mut code = String::new();
    let mut code_line = 1usize;
    let mut line = 1usize;
    let mut i = 0usize;
    macro_rules! flush_code {
        () => {
            if !code.is_empty() {
                segs.push(Seg::Code(std::mem::take(&mut code), code_line));
            }
        };
    }
    while i < ch.len() {
        let c = ch[i];
        // 行註解
        if c == '/' && ch.get(i + 1) == Some(&'/') {
            while i < ch.len() && ch[i] != '\n' {
                i += 1;
            }
            continue;
        }
        // 區塊註解（可巢狀）
        if c == '/' && ch.get(i + 1) == Some(&'*') {
            let mut depth = 1;
            i += 2;
            while i < ch.len() && depth > 0 {
                if ch[i] == '/' && ch.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if ch[i] == '*' && ch.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    if ch[i] == '\n' {
                        if code.is_empty() {
                            code_line = line;
                        }
                        line += 1;
                        code.push('\n');
                    }
                    i += 1;
                }
            }
            continue;
        }
        // 原始字串 r"…" r#"…"# br"…"
        let raw_start = if c == 'r' || (c == 'b' && ch.get(i + 1) == Some(&'r')) {
            let mut j = i + if c == 'b' { 2 } else { 1 };
            let mut hashes = 0;
            while ch.get(j) == Some(&'#') {
                hashes += 1;
                j += 1;
            }
            let prev_ident = i > 0 && is_ident(ch[i - 1]);
            if ch.get(j) == Some(&'"') && !prev_ident {
                Some((j + 1, hashes))
            } else {
                None
            }
        } else {
            None
        };
        if let Some((body, hashes)) = raw_start {
            flush_code!();
            let start_line = line;
            let mut s = String::new();
            let mut j = body;
            loop {
                if j >= ch.len() {
                    break;
                }
                if ch[j] == '"' && (0..hashes).all(|k| ch.get(j + 1 + k) == Some(&'#')) {
                    j += 1 + hashes;
                    break;
                }
                if ch[j] == '\n' {
                    line += 1;
                }
                s.push(ch[j]);
                j += 1;
            }
            segs.push(Seg::Str(s, start_line));
            i = j;
            code_line = line;
            continue;
        }
        // 一般字串（含 b"…"：b 當程式碼）
        if c == '"' {
            flush_code!();
            let start_line = line;
            let mut s = String::new();
            i += 1;
            while i < ch.len() && ch[i] != '"' {
                if ch[i] == '\\' && i + 1 < ch.len() {
                    s.push(ch[i]);
                    i += 1;
                }
                if ch[i] == '\n' {
                    line += 1;
                }
                s.push(ch[i]);
                i += 1;
            }
            i += 1;
            segs.push(Seg::Str(s, start_line));
            code_line = line;
            continue;
        }
        // 字元字面值與生命週期
        if c == '\'' {
            if ch.get(i + 1) == Some(&'\\') {
                // '\n' '\'' '\u{…}'：跳到下一個沒被跳脫的 '
                // i+1 是反斜線、i+2 是被跳脫的那個字（可能就是 '），從 i+3 找結尾
                let mut j = i + 3;
                while j < ch.len() && ch[j] != '\'' {
                    j += 1;
                }
                i = j + 1;
                continue;
            }
            if ch.get(i + 2) == Some(&'\'') {
                i += 3;
                continue;
            }
        }
        if code.is_empty() {
            code_line = line;
        }
        if c == '\n' {
            line += 1;
        }
        code.push(c);
        i += 1;
    }
    flush_code!();
    segs
}

/// 在一段文字裡找 `ASN_` 名字
fn find_in(text: &str, base_line: usize, in_string: bool, out: &mut Vec<Hit>) {
    let ch: Vec<char> = text.chars().collect();
    let mut line = base_line;
    let mut i = 0;
    while i < ch.len() {
        if ch[i] == '\n' {
            line += 1;
        }
        let at = ch[i] == 'A' && ch.get(i + 1) == Some(&'S') && ch.get(i + 2) == Some(&'N') && ch.get(i + 3) == Some(&'_');
        if !at || (i > 0 && is_ident(ch[i - 1])) {
            i += 1;
            continue;
        }
        let mut j = i + 4;
        while j < ch.len() && (ch[j].is_ascii_uppercase() || ch[j].is_ascii_digit() || ch[j] == '_') {
            j += 1;
        }
        let text_hit: String = ch[i..j].iter().collect();
        let first_ok = ch.get(i + 4).map(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).unwrap_or(false);
        let next = ch.get(j).copied();
        let version_like = next == Some('.') && ch.get(j + 1).map(|c| c.is_ascii_digit()).unwrap_or(false);
        let dynamic = in_string && (!first_ok || text_hit.ends_with('_') || version_like || next == Some('{'));
        if first_ok && !dynamic {
            out.push(Hit { text: text_hit, line, in_string, dynamic: false });
        } else if dynamic {
            out.push(Hit { text: text_hit, line, in_string, dynamic: true });
        }
        // 程式碼裡 ASN_ 後面不是名字（中文函式名等）就略過
        i = j.max(i + 1);
    }
}

/// 掃一份原始碼，回傳所有名字候選（行號從 1 起）
pub fn scan_source(src: &str) -> Vec<Hit> {
    let mut out = vec![];
    for seg in lex(src) {
        match seg {
            Seg::Code(t, l) => find_in(&t, l, false, &mut out),
            Seg::Str(t, l) => find_in(&t, l, true, &mut out),
        }
    }
    out
}

/// 去掉註解後的文字（字串保留），給「檔案裡是不是真的有這個名字」用
pub fn stripped(src: &str) -> String {
    lex(src)
        .into_iter()
        .map(|s| match s {
            Seg::Code(t, _) => t,
            Seg::Str(t, _) => format!("\"{t}\""),
        })
        .collect::<Vec<_>>()
        .join("")
}

/// `dir` 底下所有 `.rs`
pub fn rs_files(dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                out.push(p);
            }
        }
    }
    let mut out = vec![];
    walk(dir, &mut out);
    out.sort();
    out
}

#[cfg(test)]
mod selftest {
    use super::*;

    fn names(src: &str) -> Vec<String> {
        scan_source(src).into_iter().filter(|h| !h.dynamic).map(|h| h.text).collect()
    }
    fn dyns(src: &str) -> Vec<String> {
        scan_source(src).into_iter().filter(|h| h.dynamic).map(|h| h.text).collect()
    }

    #[test]
    fn 抓得到各種讀法() {
        let src = r#"
            let a = std::env::var("ASN_A_ONE");
            let b = std::env::var_os("ASN_B_TWO");
            let c = env!("ASN_C_THREE");
            let d = option_env!("ASN_D_FOUR");
            const NAME: &str = "ASN_E_FIVE";
            let f = envc::get(NAME);
            child.env("ASN_F_SIX", "1");
            let g = lookup("ASN_15Q_STATE");
        "#;
        assert_eq!(names(src), ["ASN_A_ONE", "ASN_B_TWO", "ASN_C_THREE", "ASN_D_FOUR", "ASN_E_FIVE", "ASN_F_SIX", "ASN_15Q_STATE"]);
    }

    #[test]
    fn 測試模組後面的正式碼也掃得到() {
        // #2232 盲點 1：只切到第一個 mod tests 為止的掃法會漏掉這個
        let src = "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() { let _ = \"ASN_IN_TEST\"; }\n}\nfn prod() { let _ = std::env::var(\"ASN_AFTER_TESTS\"); }\n";
        assert_eq!(names(src), ["ASN_IN_TEST", "ASN_AFTER_TESTS"]);
        let hits = scan_source(src);
        assert_eq!(hits[1].line, 6, "行號要對");
    }

    #[test]
    fn 放進常數再讀的也抓得到() {
        // #2232 盲點 2：名字先放進常數
        let src = "pub(crate) const ENV_WEZTERM: &str = \"ASN_TERM_WEZTERM\";\nfn read() { std::env::var(ENV_WEZTERM).ok(); }\n";
        assert_eq!(names(src), ["ASN_TERM_WEZTERM"]);
    }

    #[test]
    fn 註解不算() {
        let src = "// ASN_LINE_COMMENT\n/// ASN_DOC_COMMENT\n//! ASN_INNER_DOC\n/* ASN_BLOCK /* ASN_NESTED */ ASN_STILL_BLOCK */\nfn f() { let _ = \"ASN_REAL\"; } // ASN_TRAILING\n";
        assert_eq!(names(src), ["ASN_REAL"]);
    }

    #[test]
    fn 字串裡的雙斜線不當註解() {
        let src = "let u = \"http://x/y\"; let n = \"ASN_AFTER_URL\";\nlet v = \"a // ASN_INSIDE_STRING\";\n";
        assert_eq!(names(src), ["ASN_AFTER_URL", "ASN_INSIDE_STRING"]);
    }

    #[test]
    fn 原始字串與字元字面值() {
        let src = "let r = r#\"ASN_RAW_ONE \"quoted\" // not comment\"#; let q = '\"'; let n = \"ASN_AFTER_CHAR\"; let l: &'static str = \"ASN_AFTER_LIFETIME\"; let e = '\\''; let m = \"ASN_AFTER_ESC\";\n";
        assert_eq!(names(src), ["ASN_RAW_ONE", "ASN_AFTER_CHAR", "ASN_AFTER_LIFETIME", "ASN_AFTER_ESC"]);
    }

    #[test]
    fn 夾在別的識別字中間或後面不是名字() {
        let src = "has(\"CLAUDE_ASN_TEST\"); has(\"ANTHROPIC_ASN_TEST\"); fn 遷移_ASN_HOME_有設就不遷移() {} fn ASN_切換後() {}\n";
        assert_eq!(names(src), Vec::<String>::new());
        assert!(dyns(src).is_empty(), "程式碼裡的 ASN_ 開頭中文函式名不是動態組名：{:?}", dyns(src));
    }

    #[test]
    fn 動態組名候選要抓出來() {
        let src = "let a = concat!(\"ASN_\", \"X\"); let b = format!(\"ASN_{key}\"); let c = \"ASN_AEGIS_\"; let d = format!(\"ASN_{version}_android.apk\"); let e = \"ASN_0.1.33_android.apk\";\n";
        assert_eq!(dyns(src), ["ASN_", "ASN_", "ASN_AEGIS_", "ASN_", "ASN_0"]);
        assert_eq!(names(src), Vec::<String>::new());
    }

    #[test]
    fn 程式碼裡的識別字名字也抓得到() {
        let src = "pub const ASN_EXIT_GRACE: u64 = 1;\nfn f() { use_it(ASN_EXIT_GRACE); }\n";
        assert_eq!(names(src), ["ASN_EXIT_GRACE", "ASN_EXIT_GRACE"]);
    }

    #[test]
    fn 名字結尾的句點不當版本號() {
        let src = "let _ = \"設 ASN_FOO_BAR. 就好\";\n";
        assert_eq!(names(src), ["ASN_FOO_BAR"]);
    }
}
