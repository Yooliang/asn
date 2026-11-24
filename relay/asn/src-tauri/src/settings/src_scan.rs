//! #2232 A：原始碼掃描類守門共用的切割工具（只在測試編譯）。
//!
//! 各處「掃原始碼找禁用字」的守門，過去各自用 `split("mod tests {")`、`find("#[cfg(test)]")`、
//! 「第 0 欄的 `}`」之類靠排版的切點去掉測試碼；排版一變就會靜默漏掃（切太早，後面的正式碼沒人看）。
//! 這裡改成真的詞法掃描：
//! - `prod_source`：把 `#[cfg(test)]` 標著的項目（mod 區塊、fn、impl、const、`mod x;` 宣告……）整段拿掉，
//!   其餘原樣保留（被拿掉的部分換成同樣數量的換行，行號不變）。數大括號時會跳過字串（含跳脫）、
//!   字元字面值、`'a` 生命週期、`//` 與 `/* */` 註解（可巢狀）、raw string（`r"…"`、`r#"…"#`、`br"…"`）。
//! - `external_test_files`：由 `#[cfg(test)] mod x;`（含 `#[path = "…"]`）的宣告反推出對應的檔，
//!   整個檔（以及它底下的子模組檔）都算測試碼，不靠 `tests.rs`／`*_tests.rs` 這種檔名慣例。
//! - `prod_files`：整個 src 的（相對路徑, 正式碼）清單，已排除外部測試檔。
//!
//! 限制：這是詞法層級的規則，不是完整的 Rust 解析。巨集展開出來的程式、`cfg_attr`、
//! `#[cfg(any(test, …))]` 這種「不只測試才編進來」的寫法一律當正式碼。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// 在 `i` 這個位置若是註解、字串、字元字面值、raw string，回傳它結束後的位置；否則 None。
/// `'a` 這種生命週期（或標籤）不是字面值，回傳 None。
fn lex_skip(text: &str, i: usize) -> Option<usize> {
    let b = text.as_bytes();
    let n = b.len();
    match b[i] {
        b'/' if b.get(i + 1) == Some(&b'/') => Some(text[i..].find('\n').map_or(n, |e| i + e)),
        b'/' if b.get(i + 1) == Some(&b'*') => {
            let (mut depth, mut j) = (1usize, i + 2);
            while j < n && depth > 0 {
                if b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            Some(j)
        }
        b'"' => Some(skip_string(b, i + 1)),
        b'r' | b'b' | b'c' if i == 0 || !is_ident(b[i - 1]) => {
            // r"…"、r#"…"#、br"…"、cr"…"；以及 b"…"／c"…"（一般字串加前綴）；b'x'（位元組字元）
            let mut j = i;
            if b[j] != b'r' {
                j += 1;
                if b.get(j) == Some(&b'"') {
                    return Some(skip_string(b, j + 1));
                }
                if b[i] == b'b' && b.get(j) == Some(&b'\'') {
                    return lex_skip(text, j);
                }
            }
            if b.get(j) != Some(&b'r') {
                return None;
            }
            j += 1;
            let mut hashes = 0;
            while b.get(j) == Some(&b'#') {
                hashes += 1;
                j += 1;
            }
            if b.get(j) != Some(&b'"') {
                return None; // 只是 r 開頭的識別字（例如 `r#type` 的原始識別字或 `ref`）
            }
            j += 1;
            while j < n {
                if b[j] == b'"' && b[j + 1..].iter().take(hashes).filter(|&&c| c == b'#').count() == hashes && j + 1 + hashes <= n {
                    return Some(j + 1 + hashes);
                }
                j += 1;
            }
            Some(n)
        }
        b'\'' => {
            if b.get(i + 1) == Some(&b'\\') {
                // 跳脫的字元字面值：'\n'、'\''、'\u{1F600}'、'\\'
                let mut j = i + 3;
                while j < n && b[j] != b'\'' {
                    j += 1;
                }
                return Some((j + 1).min(n));
            }
            let c = text[i + 1..].chars().next()?;
            let after = i + 1 + c.len_utf8();
            if b.get(after) == Some(&b'\'') {
                Some(after + 1) // 'x'、'{'、'中'
            } else {
                None // 'a、'static 這類生命週期或標籤
            }
        }
        _ => None,
    }
}

/// 一般字串：`from` 是開頭引號之後的位置，回傳結尾引號之後的位置
fn skip_string(b: &[u8], from: usize) -> usize {
    let mut j = from;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' => return j + 1,
            _ => j += 1,
        }
    }
    b.len()
}

/// `i` 是 `open` 字元的位置，回傳對應的結尾字元之後的位置（跳過字串與註解）；找不到回傳檔尾
fn match_close(text: &str, i: usize, open: u8, close: u8) -> usize {
    let b = text.as_bytes();
    let (mut depth, mut j) = (0usize, i);
    while j < b.len() {
        if let Some(e) = lex_skip(text, j) {
            j = e;
            continue;
        }
        if b[j] == open {
            depth += 1;
        } else if b[j] == close {
            depth -= 1;
            if depth == 0 {
                return j + 1;
            }
        }
        j += 1;
    }
    b.len()
}

/// 屬性內容（`#[` 與 `]` 之間）是不是「只有測試編譯才存在」：`cfg(test)`、`cfg(all(test, …))`。
/// `not(test)`、`any(test, …)`、`cfg_attr` 一律不算。
fn is_test_cfg(attr: &str) -> bool {
    let s: String = attr.chars().filter(|c| !c.is_whitespace()).collect();
    if !s.starts_with("cfg(") || s.contains("not(") || s.contains("any(") {
        return false;
    }
    s.match_indices("test").any(|(at, _)| {
        let before = s.as_bytes()[at - 1];
        let after = s.as_bytes().get(at + 4).copied().unwrap_or(b')');
        (before == b'(' || before == b',') && (after == b')' || after == b',')
    })
}

fn skip_blank(text: &str, mut i: usize) -> usize {
    let b = text.as_bytes();
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
        } else if matches!(lex_skip(text, i), Some(e) if text[i..].starts_with("//") || text[i..].starts_with("/*")) {
            i = lex_skip(text, i).unwrap();
        } else {
            break;
        }
    }
    i
}

fn first_word(s: &str) -> &str {
    let e = s.bytes().position(|c| !is_ident(c)).unwrap_or(s.len());
    &s[..e]
}

/// 項目結束位置：`from` 是（可能還有後續屬性的）項目開頭。回傳結束後的位置，以及中途讀到的 `#[path = "…"]`。
fn item_end(text: &str, from: usize) -> (usize, Option<String>) {
    let b = text.as_bytes();
    let mut i = skip_blank(text, from);
    let mut path_attr = None;
    while b.get(i) == Some(&b'#') && b.get(i + 1) == Some(&b'[') {
        let close = match_close(text, i + 1, b'[', b']');
        let inner = &text[i + 2..close - 1];
        if let Some(rest) = inner.trim_start().strip_prefix("path") {
            if let Some(q) = rest.trim_start().strip_prefix('=') {
                let q = q.trim().trim_matches('"');
                path_attr = Some(q.to_string());
            }
        }
        i = skip_blank(text, close);
    }
    // 去掉可見度（pub、pub(crate)）後的第一個字決定項目種類
    let mut head = &text[i..];
    if first_word(head) == "pub" {
        head = head[3..].trim_start();
        if head.starts_with('(') {
            let e = match_close(head, 0, b'(', b')');
            head = head[e..].trim_start();
        }
    }
    let kw = first_word(head);
    let second = first_word(head[kw.len()..].trim_start());
    let is_item = matches!(kw, "fn" | "const" | "static" | "struct" | "enum" | "trait" | "impl" | "mod" | "use" | "type" | "unsafe" | "extern" | "async" | "macro_rules" | "union");
    let only_semicolon = kw == "use" || kw == "static" || (kw == "const" && !matches!(second, "fn" | "unsafe" | "async" | "extern"));
    let (mut paren, mut brack) = (0usize, 0usize);
    let mut j = i;
    while j < b.len() {
        if let Some(e) = lex_skip(text, j) {
            j = e;
            continue;
        }
        match b[j] {
            b'(' => paren += 1,
            b'[' => brack += 1,
            b')' | b']' if paren == 0 && brack == 0 => return (j, path_attr), // 外層的結尾，項目在這之前就結束了
            b')' => paren -= 1,
            b']' => brack -= 1,
            b'}' if paren == 0 && brack == 0 => return (j, path_attr),
            b'{' if paren == 0 && brack == 0 => {
                let e = match_close(text, j, b'{', b'}');
                if is_item && !only_semicolon {
                    return (e, path_attr);
                }
                if !is_item {
                    // 區塊敘述、列舉變體、match 分支：後面緊跟 `;`、`,` 就一起收走
                    let k = skip_blank(text, e);
                    return (if matches!(b.get(k), Some(b';') | Some(b',')) { k + 1 } else { e }, path_attr);
                }
                j = e;
                continue;
            }
            b';' if paren == 0 && brack == 0 => return (j + 1, path_attr),
            b',' if paren == 0 && brack == 0 && !is_item => return (j + 1, path_attr),
            _ => {}
        }
        j += 1;
    }
    (b.len(), path_attr)
}

/// 每個測試項目：(屬性開頭, 項目結束, `#[path]` 的值)
fn test_ranges(text: &str) -> Vec<(usize, usize, Option<String>)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if let Some(e) = lex_skip(text, i) {
            i = e;
            continue;
        }
        if b[i] == b'#' {
            let inner = b.get(i + 1) == Some(&b'!');
            let lb = i + 1 + inner as usize;
            if b.get(lb) == Some(&b'[') {
                let close = match_close(text, lb, b'[', b']');
                if is_test_cfg(&text[lb + 1..close - 1]) {
                    if inner {
                        out.push((i, b.len(), None)); // #![cfg(test)]：整個檔都是測試
                        return out;
                    }
                    let (end, path) = item_end(text, close);
                    out.push((i, end, path));
                    i = end.max(close);
                    continue;
                }
                i = close;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 去掉 `#[cfg(test)]` 標著的項目後的正式碼。被拿掉的部分換成同樣數量的換行（行號不變），其餘原樣保留。
pub(crate) fn prod_source(text: impl AsRef<str>) -> String {
    let text = text.as_ref();
    let mut out = String::with_capacity(text.len());
    let mut keep = 0;
    for (start, end, _) in test_ranges(text) {
        out.push_str(&text[keep..start]);
        out.extend(text[start..end].chars().filter(|&c| c == '\n'));
        keep = end;
    }
    out.push_str(&text[keep..]);
    out
}

/// 把 `//`、`/* */` 註解拿掉（換行保留，行號不變）；字串與字元字面值原樣保留。
/// 給「數字樣出現幾次」的守門用，免得註解裡寫到禁用字也被算進去。
pub(crate) fn strip_comments(text: &str) -> String {
    let b = text.as_bytes();
    let (mut out, mut keep, mut i) = (String::with_capacity(text.len()), 0, 0);
    while i < b.len() {
        if let Some(e) = lex_skip(text, i) {
            if text[i..].starts_with("//") || text[i..].starts_with("/*") {
                out.push_str(&text[keep..i]);
                out.extend(text[i..e].chars().filter(|&c| c == '\n'));
                keep = e;
            }
            i = e;
        } else {
            i += 1;
        }
    }
    out.push_str(&text[keep..]);
    out
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")
}

/// 一個 `#[cfg(test)] mod name;` 宣告（寫在 `file`）對應的檔
fn declared_file(file: &Path, name: &str, path_attr: Option<&str>) -> Vec<PathBuf> {
    let dir = file.parent().unwrap();
    if let Some(p) = path_attr {
        return vec![dir.join(p)];
    }
    let stem = file.file_stem().unwrap().to_string_lossy().to_string();
    let base = if matches!(stem.as_str(), "mod" | "lib" | "main") { dir.to_path_buf() } else { dir.join(&stem) };
    vec![base.join(format!("{name}.rs")), base.join(name).join("mod.rs")]
}

/// 由 `#[cfg(test)] mod x;` 宣告反推出的測試檔（相對 src 的路徑），含它們底下的子模組檔。
pub(crate) fn external_test_files(root: &Path) -> BTreeSet<String> {
    let mut files = Vec::new();
    walk(root, &mut files);
    let mut out: BTreeSet<PathBuf> = BTreeSet::new();
    for f in &files {
        let text = std::fs::read_to_string(f).unwrap().replace("\r\n", "\n");
        for (start, end, path_attr) in test_ranges(&text) {
            let mut body = text[start..end].trim();
            while body.starts_with("#[") {
                body = body[match_close(body, 1, b'[', b']')..].trim_start();
            }
            if body.starts_with("pub") {
                body = body[3..].trim_start();
                if body.starts_with('(') {
                    body = body[match_close(body, 0, b'(', b')')..].trim_start();
                }
            }
            if let Some(name) = body.strip_prefix("mod ").and_then(|r| r.trim().strip_suffix(';')) {
                if let Some(found) = declared_file(f, name.trim(), path_attr.as_deref()).into_iter().find(|p| p.is_file()) {
                    out.insert(found);
                }
            }
        }
    }
    // 測試檔底下的子模組（x.rs → x/、x/mod.rs → x/）也都是測試碼；檔內自己再宣告的 `mod y;` 也在這個範圍
    let mut all: BTreeSet<String> = BTreeSet::new();
    for t in &out {
        all.insert(rel_of(root, t));
        let stem = t.file_stem().unwrap().to_string_lossy().to_string();
        let sub = if stem == "mod" { t.parent().unwrap().to_path_buf() } else { t.parent().unwrap().join(&stem) };
        if sub.is_dir() {
            let mut inner = Vec::new();
            walk(&sub, &mut inner);
            for p in inner {
                all.insert(rel_of(root, &p));
            }
        }
    }
    all
}

/// (相對路徑, 正式碼文字) 的清單：掃整個 src，排除外部測試檔，其餘檔案去掉 `#[cfg(test)]` 項目。
pub(crate) fn prod_files(root: &Path) -> Vec<(String, String)> {
    let skip = external_test_files(root);
    let mut files = Vec::new();
    walk(root, &mut files);
    // 保險：整個目錄沒掃到、或測試檔判斷整批失效，都不能靜默變綠（實際約 330 個 .rs、約 40 個外部測試檔）
    assert!(files.len() >= 300, "掃到的 .rs 太少（{}），路徑不對？", files.len());
    assert!(skip.len() >= 50, "由 #[cfg(test)] mod x; 反推出的測試檔只有 {} 個，反推失效？", skip.len());
    let mut out = Vec::new();
    for f in files {
        let rel = rel_of(root, &f);
        if skip.contains(&rel) {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap().replace("\r\n", "\n");
        out.push((rel, prod_source(&text)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 字串裡的大括號不算() {
        let s = "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn b() { let s = \"}\"; let t = \"{ \\\" }\"; }\n}\nfn after() {}\n";
        let p = prod_source(s);
        assert!(p.contains("fn a()") && p.contains("fn after()") && !p.contains("fn b()"), "{p}");
        // 正式碼的字串裡有 }：後面的程式照常保留（不會被當成區塊結尾）
        let s2 = "fn a() { let s = \"}\"; }\n#[cfg(test)]\nfn t() { x(); }\nfn after() { std::fs::write(\"x.json\", \"\"); }\n";
        let p2 = prod_source(s2);
        assert!(p2.contains("let s = \"}\"") && p2.contains("fn after()") && !p2.contains("fn t()"), "{p2}");
    }

    #[test]
    fn 註解裡的大括號不算() {
        let s = "#[cfg(test)]\nmod tests {\n    // }\n    /* } /* } */ } */\n    fn b() {}\n}\nfn after() {}\n";
        let p = prod_source(s);
        assert!(p.contains("fn after()") && !p.contains("fn b()"), "{p}");
        // 測試區之外的註解原樣保留
        assert!(prod_source("// { 註解\nfn a() {}\n").contains("// { 註解"));
    }

    #[test]
    fn raw_string內的括號與引號不算() {
        let s = "#[cfg(test)]\nmod tests {\n    const A: &str = r\"}\";\n    const B: &str = r#\"} \" } \"#;\n    const C: &[u8] = br##\"}\"# }\"##;\n    fn b() {}\n}\nfn after() {}\n";
        let p = prod_source(s);
        assert!(p.contains("fn after()") && !p.contains("fn b()") && !p.contains("const C"), "{p}");
    }

    #[test]
    fn 字元字面值與生命週期() {
        let s = "#[cfg(test)]\nmod tests {\n    fn b<'a>(x: &'a str) -> &'a str { let c = '}'; let d = '{'; let e = '\\''; let f = '\\u{7d}'; x }\n}\nfn after<'a>(x: &'a str) -> &'a str { x }\n";
        let p = prod_source(s);
        assert!(p.contains("fn after<'a>") && !p.contains("fn b<"), "{p}");
        // 生命週期之後的 { 要照常數：'static 不能被當成字元字面值吞掉後面的括號
        let s2 = "#[cfg(test)]\nfn t() -> &'static str { \"x\" }\nfn after() {}\n";
        let p2 = prod_source(s2);
        assert!(p2.contains("fn after()") && !p2.contains("fn t()"), "{p2}");
        // 中文字元字面值
        let s3 = "#[cfg(test)]\nfn t() { let c = '中'; }\nfn after() {}\n";
        assert!(prod_source(s3).contains("fn after()"));
    }

    #[test]
    fn 測試模組後面還有正式碼_比照account_rs的結構() {
        let s = "fn head() {}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    fn t() {}\n}\n\nfn tail_prod() { std::fs::write(\"x.json\", \"\"); }\n";
        let p = prod_source(s);
        assert!(p.contains("fn head()") && p.contains("tail_prod") && !p.contains("fn t()"), "{p}");
        // 真實檔案：account.rs 測試模組之後（約 828 行之後）的正式碼要掃得到
        let real = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/account.rs")).unwrap().replace("\r\n", "\n");
        let prod = prod_source(&real);
        let test_start = real.find("#[cfg(test)]\nmod tests {").expect("account.rs 的測試模組");
        let tail = &real[test_start..];
        let lines_before = real[..test_start].lines().count();
        assert!(real.lines().count() > 828 && lines_before < 700, "account.rs 的結構變了，這個前提要重新確認");
        // 切點之後的正式碼（測試模組結束後）還在：找測試模組之後第一個頂格 fn
        let after_marker = tail.lines().skip(1).skip_while(|l| *l != "}").skip(1).find(|l| l.starts_with("pub fn ") || l.starts_with("pub async fn ") || l.starts_with("fn ") || l.starts_with("async fn "));
        let after_marker = after_marker.expect("account.rs 測試模組後面應該還有正式碼");
        assert!(prod.contains(after_marker), "測試模組後面的正式碼被切掉了：{after_marker}");
        assert!(!prod.contains("fn 帳號名稱驗證"), "測試碼沒切乾淨");
        assert!(prod.lines().count() == real.lines().count(), "行號要保持不變");
    }

    #[test]
    fn 右大括號後面緊接下一行就是正式碼() {
        let s = "#[cfg(test)]\nmod tests {\n    fn b() {}\n}\nfn after() {}\n";
        assert!(prod_source(s).contains("fn after()"));
        let s2 = "#[cfg(test)]\nmod tests {\n    fn b() {}\n}\nstruct S;\nimpl S { fn z(&self) {} }\n";
        let p = prod_source(s2);
        assert!(p.contains("struct S;") && p.contains("fn z"), "{p}");
        // 沒有結尾空行、檔尾沒換行
        assert_eq!(prod_source("fn a() {}\n#[cfg(test)]\nmod tests {\n}").trim_end_matches('\n'), "fn a() {}");
    }

    #[test]
    fn 巢狀的cfg_test() {
        let s = "fn a() {}\n#[cfg(test)]\nmod outer {\n    #[cfg(test)]\n    mod inner {\n        fn deep() { let s = \"}\"; }\n    }\n    fn mid() {}\n}\nfn after() {}\n";
        let p = prod_source(s);
        assert!(p.contains("fn a()") && p.contains("fn after()") && !p.contains("deep") && !p.contains("mid"), "{p}");
        // 正式碼 mod 裡面的 #[cfg(test)] 項目：只拿掉那一個，同層其他項目保留
        let s2 = "mod m {\n    fn keep1() {}\n    #[cfg(test)]\n    fn only_test() {}\n    #[cfg(test)]\n    mod tests { fn t() {} }\n    fn keep2() {}\n}\n";
        let p2 = prod_source(s2);
        assert!(p2.contains("keep1") && p2.contains("keep2") && !p2.contains("only_test") && !p2.contains("fn t()"), "{p2}");
    }

    #[test]
    fn 其他項目種類與屬性寫法() {
        let s = "#[cfg(test)]\n#[allow(dead_code)]\nconst T: [u8; 2] = [1; 2];\n#[cfg(test)]\nuse a::{b, c};\n#[cfg(test)]\nstruct S(i32);\n#[cfg(test)]\nimpl S { fn x() {} }\n#[cfg(all(test, windows))]\nmod w;\n#[cfg(not(test))]\nfn prod_only() {}\n#[cfg(any(test, feature = \"x\"))]\nfn both() {}\nfn end() {}\n";
        let p = prod_source(s);
        assert!(p.contains("prod_only") && p.contains("both") && p.contains("fn end()"), "{p}");
        for gone in ["const T", "use a::", "struct S", "impl S", "mod w"] {
            assert!(!p.contains(gone), "{gone} 沒被拿掉：{p}");
        }
        // 屬性字串裡剛好有 test 字樣、註解與字串裡的 #[cfg(test)] 都不算
        let s2 = "// #[cfg(test)]\nlet a = \"#[cfg(test)] fn x() {}\";\nfn keep() {}\n";
        assert_eq!(prod_source(s2), s2);
        // 整個檔都是測試：#![cfg(test)]
        assert!(prod_source("#![cfg(test)]\nfn a() {}\n").trim().is_empty());
    }

    #[test]
    fn 由宣告反推外部測試檔() {
        let tmp = std::env::temp_dir().join(format!("asn_src_scan_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("sub/suite")).unwrap();
                let w = |p: &str, t: &str| std::fs::write(tmp.join(p), t).unwrap();
        w("lib.rs", "#[cfg(test)]\nmod boottime;\nmod real;\n#[cfg(test)]\n#[path = \"odd/name.rs\"]\nmod renamed;\n#[cfg(not(test))]\nmod notest;\n");
        std::fs::create_dir_all(tmp.join("odd")).unwrap();
        w("odd/name.rs", "fn x() {}\n");
        w("boottime.rs", "fn t() {}\n");
        w("real.rs", "#[cfg(test)]\nmod checks;\npub(crate) fn r() {}\n");
        std::fs::create_dir_all(tmp.join("real")).unwrap();
        w("real/checks.rs", "mod nested;\n");
        std::fs::create_dir_all(tmp.join("real/checks")).unwrap();
        w("real/checks/nested.rs", "fn n() {}\n");
        w("notest.rs", "fn p() {}\n");
        w("sub/mod.rs", "#[cfg(test)]\nmod suite;\n");
        w("sub/suite/mod.rs", "fn s() {}\n");
        w("sub/suite/more.rs", "fn m() {}\n");
        let got = external_test_files(&tmp);
        let want: BTreeSet<String> = ["boottime.rs", "odd/name.rs", "real/checks.rs", "real/checks/nested.rs", "sub/suite/mod.rs", "sub/suite/more.rs"].iter().map(|s| s.to_string()).collect();
        assert_eq!(got, want);
        // 檔名叫 tests.rs 但沒有任何 #[cfg(test)] 宣告它：不靠檔名慣例，所以不排除
        assert!(!got.contains("real.rs") && !got.contains("notest.rs"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn 去註解但保留字串() {
        let s = "let a = \"// 不是註解\"; // 行尾 .json
/* 多行
.json */ let b = 1;
";
        let p = strip_comments(s);
        assert!(p.contains("\"// 不是註解\"") && !p.contains(".json") && p.contains("let b = 1;"), "{p}");
        assert_eq!(p.lines().count(), s.lines().count());
    }

    #[test]
    fn 真實的src_掃得到外部測試檔() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let ext = external_test_files(&root);
        // 檔名不符慣例（不叫 tests.rs、也不是 *_tests.rs）、只靠宣告反推的測試檔也要在
        for f in ["golden_util.rs", "test_guard.rs", "bridge/engines/golden.rs", "launch/term_live_mux.rs", "settings/guard_tests.rs", "settings/src_scan.rs", "term_remote/tests.rs"] {
            assert!(ext.contains(f), "{f} 沒被反推成測試檔");
        }
        // 沒有 #[cfg(test)] 宣告的檔（只是 cfg_attr 加 allow 的正式模組）不能被當成測試檔
        assert!(!ext.contains("settings/raw.rs") && !ext.contains("account.rs") && !ext.contains("boottime.rs") && !ext.contains("known_pick.rs"));
        eprintln!("外部測試檔共 {} 個", ext.len());
        let all = prod_files(&root);
        assert!(all.iter().any(|(r, p)| r == "settings/raw.rs" && !p.is_empty()));
        assert!(all.iter().all(|(r, _)| !ext.contains(r)));
    }
}
