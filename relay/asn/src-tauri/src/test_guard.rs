//! 測試隔離守衛（只在 cfg(test) 編譯，正式版沒有任何一行）。
//!
//! 目的：單元測試永遠不能碰到本機真正的終端服務（mux）資料夾與使用者資料夾——曾經有測試呼叫 `term::live(暫存資料夾)`，
//! 結果讀寫了真的 `%LOCALAPPDATA%\ASN\m`，甚至在背景把使用中的 mux 收掉。
//! - `mux_base()`：測試用的 mux 上層資料夾（每個行程一個暫存位置、每次呼叫一個新子資料夾），`mux::default_base()` 在測試中回這個。
//! - `assert_not_real()`：路徑落在真的 ASN 資料夾（`...\AppData\Local\ASN`、`~/.local/share/ASN`、`~/.asn` 等）就直接 panic。
//!   判斷只看路徑的形狀與家目錄，不靠環境變數開關，使用者機器上設錯環境變數也不會讓守衛失效。
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// 測試用 mux 上層資料夾：`<暫存>/asn-tm-<pid>/<序號>`（不先建立；要寫的人自己 create_dir_all）。每次呼叫給不同的，測試之間不共用 pid 檔與紀錄
pub fn mux_base() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    static CLEAN: std::sync::Once = std::sync::Once::new();
    // 測試行程結束時刪掉自己這個 pid 的那一個暫存資料夾（只刪自己的，不掃別的；刪不掉就算了）
    CLEAN.call_once(|| {
        extern "C" fn clean_own() {
            let _ = std::fs::remove_dir_all(own_dir());
        }
        extern "C" {
            fn atexit(cb: extern "C" fn()) -> i32;
        }
        // SAFETY：C 執行環境的 atexit，只登記一個不 panic、不碰其他狀態的函式；只在測試編譯
        unsafe {
            atexit(clean_own);
        }
    });
    own_dir().join(N.fetch_add(1, Ordering::SeqCst).to_string())
}

/// 這個測試行程自己的暫存 mux 上層資料夾：`<暫存>/asn-tm-<pid>`
fn own_dir() -> PathBuf {
    std::env::temp_dir().join(format!("asn-tm-{}", std::process::id()))
}

/// 路徑拆成一段一段（小寫）。`/` 和 `\` 都當分隔：Linux 上 `Path` 不認 `\`，Windows 形狀的路徑也要拆得開
fn comps(p: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in p.components() {
        if let Component::Normal(s) = c {
            out.extend(s.to_string_lossy().split(['/', '\\']).filter(|x| !x.is_empty()).map(|x| x.to_lowercase()));
        }
    }
    out
}

fn has_seq(c: &[String], seq: &[&str]) -> bool {
    c.windows(seq.len()).any(|w| w.iter().zip(seq).all(|(a, b)| a == b))
}

/// 是不是真的 ASN 資料夾（不含暫存資料夾底下的東西）
pub fn is_real_asn_path(p: &Path) -> bool {
    if p.starts_with(std::env::temp_dir()) {
        return false;
    }
    let c = comps(p);
    // 真的 mux 與資料夾：...\AppData\Local\ASN、...\AppData\Roaming\tw.yooliang.asn（含舊識別）、~/.local/share/ASN
    if has_seq(&c, &["appdata", "local", "asn"]) || has_seq(&c, &[".local", "share", "asn"]) {
        return true;
    }
    if has_seq(&c, &["appdata", "roaming", "tw.yooliang.asn"]) || has_seq(&c, &["appdata", "roaming", concat!("tw.irori", ".asn")]) {
        return true;
    }
    // Linux 的 mux 上層資料夾也可能是 $XDG_DATA_HOME（mux::default_base 的正式版先看它）。這裡讀環境變數只會讓守衛認得更多、不會讓它放行
    if let Some(x) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|x| x.is_absolute()) {
        if p.starts_with(x.join("ASN")) {
            return true;
        }
    }
    // 真的 ~/.asn、舊的 ~/.irori-relay：必須剛好在目前行程認得的家目錄底下
    let home = crate::identity::home_dir();
    !home.as_os_str().is_empty() && [".asn", concat!(".irori", "-relay"), ".irori-asn"].iter().any(|n| p.starts_with(home.join(n)))
}

/// 把「啟動設定檔」（`ASN_LAUNCHER_FILE`）指到暫存位置（檔案不存在＝用內建預設）。整個測試行程只設一次；
/// 會走 `SystemQueueEnv` 等「讀本機啟動設定」的測試要先呼叫，否則會去讀本機真的 `~/.asn/launcher.json`
pub fn isolate_launcher_file() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("asn-tl-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("ASN_LAUNCHER_FILE", dir.join("launcher.json"));
    });
}

/// 測試中有程式把路徑解析到真的 ASN 資料夾：直接 panic，附上是哪個入口
pub fn assert_not_real(p: &Path, what: &str) {
    if is_real_asn_path(p) {
        panic!("測試隔離：{what} 解析到真的 ASN 資料夾 {}；測試必須改用暫存資料夾（mux 用 TermService::set_mux_base／term::live_for_test）", p.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 暫存資料夾不算真的() {
        assert!(!is_real_asn_path(&mux_base().join("ASN").join("m")));
        assert!(!is_real_asn_path(&std::env::temp_dir().join("AppData").join("Local").join("ASN")));
    }

    #[test]
    fn 真的位置會被認出來() {
        assert!(is_real_asn_path(Path::new(r"C:\Users\x\AppData\Local\ASN\m")));
        assert!(is_real_asn_path(Path::new("/home/x/.local/share/ASN/m")));
        assert!(is_real_asn_path(Path::new(r"C:\Users\x\AppData\Roaming\tw.yooliang.asn")));
        assert!(is_real_asn_path(&crate::identity::home_dir().join(".asn").join("k")));
        // 本機平台的分隔符號寫法（Linux 上是 / 拆段、Windows 上是 \）也認得
        assert!(is_real_asn_path(&Path::new("home").join("x").join(".local").join("share").join("ASN")));
        assert!(is_real_asn_path(&Path::new("C:").join("Users").join("x").join("AppData").join("Local").join("ASN")));
        assert!(!is_real_asn_path(Path::new("/home/x/projects/asn")), "名字裡有 asn 但不是 ASN 資料夾");
    }

    #[test]
    #[should_panic(expected = "測試隔離")]
    fn 碰到真的位置就_panic() {
        assert_not_real(Path::new(r"C:\Users\x\AppData\Local\ASN\m"), "測試");
    }

    #[test]
    fn 測試的預設_mux_資料夾不是真的() {
        let b = crate::launch::mux::default_base().unwrap();
        assert!(!is_real_asn_path(&b));
        assert!(crate::launch::mux::paths(&b).is_ok());
    }
    // ---- 原始碼守衛：測試碼不得直接用會碰真環境的入口 ----

    /// 禁用的字串。測試要用 mux 資料夾請走 `set_mux_base`／`term::live_for_test`／`test_guard::mux_base`
    const FORBIDDEN: &[&str] = &["term::live(", "default_base(", "RealRunner"];

    /// 例外放行的範圍：整個測試區，或只放行出現在 `#[ignore]` 測試函式裡的（理由寫「#[ignore] 的真機測試」就要用後者）
    #[derive(PartialEq)]
    enum Scope {
        File,
        IgnoredFnsOnly,
    }

    /// 例外清單：(檔案結尾, 禁用字串, 放行範圍, 理由)。每一條都要有理由；新增前先想能不能改用假的 Runner
    const ALLOW: &[(&str, &str, Scope, &str)] = &[
        // claude_mod／pi_setup 各自有同名但無關的 RealRunner（只跑 claude／pi 的小指令，與 mux 無關）
        ("src/claude_mod.rs", "RealRunner", Scope::File, "claude_mod 自己的 RealRunner：只啟動測試自備的暫存腳本／逾時行為"),
        ("src/launch/pi_setup.rs", "RealRunner", Scope::File, "pi_setup 自己的 RealRunner（同名、與 wezterm 無關）：不碰 mux"),
        ("src/launch/config.rs", "RealRunner", Scope::File, "只做原始碼字串檢查（assert 內文），不執行"),
        // wezterm 真機測試：全部 #[ignore] 或在沒有 WezTerm 的機器上直接略過
        ("src/launch/wezterm.rs", "RealRunner", Scope::File, "wezterm 的 Runner 實作與它自己的真程序測試（只啟動測試自備的暫存程式）"),
        ("src/launch/term.rs", "RealRunner", Scope::IgnoredFnsOnly, "#[ignore] 的真機測試：用 TermService::fixed 指到暫存資料夾與獨立的 WezTerm，mux 資料夾已注入暫存位置"),
        ("src/launch/term_live_mux.rs", "RealRunner", Scope::File, "整份是 #[ignore] 的真 WezTerm 測試：set_mux_base 注入暫存位置"),
        ("src/launch/mux/tests.rs", "RealRunner", Scope::File, "測試自己的暫存 mux（paths 用暫存資料夾）；真 WezTerm 的整合測試 #[ignore]，其餘跑無害的程序"),
    ];

    /// `tok` 每一次出現都在 `#[ignore]` 的測試函式裡嗎（往回找最近的 `fn `，它上面幾行的屬性要有 `#[ignore`）
    fn only_in_ignored_fns(region: &str, tok: &str) -> bool {
        region.match_indices(tok).all(|(i, _)| {
            let before = &region[..i];
            let Some(f) = before.rfind("fn ") else { return false };
            // fn 那一行（可能前面有 async／pub）整行丟掉，只看它上面的屬性行
            let head = &before[..f];
            let head = &head[..head.rfind('\n').unwrap_or(0)];
            // 函式前面連續的屬性行（#[...]）裡要有 #[ignore
            head.lines().rev().map(str::trim).skip_while(|l| l.is_empty()).take_while(|l| l.starts_with("#[") || l.starts_with("//")).any(|l| l.starts_with("#[ignore"))
        })
    }

    fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                rs_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    /// 用 `#[cfg(test)] mod x;` 宣告的測試模組檔（相對路徑，用 / 分隔）：宣告在 a/b.rs 就是 a/b/x.rs 或 a/b/x/mod.rs；
    /// 宣告在 mod.rs／lib.rs／main.rs 就是同一層的 x.rs 或 x/mod.rs
    fn declared_test_mods(files: &[(String, String)]) -> std::collections::BTreeSet<String> {
        let mut out = std::collections::BTreeSet::new();
        for (rel, text) in files {
            let t = text.replace("\r\n", "\n");
            let lines: Vec<&str> = t.split('\n').collect();
            for (i, l) in lines.iter().enumerate() {
                if l.trim() != "#[cfg(test)]" {
                    continue;
                }
                let Some(n) = lines.get(i + 1).map(|n| n.trim()) else { continue };
                let decl = n.strip_prefix("pub ").unwrap_or(n);
                let Some(name) = decl.strip_prefix("mod ").and_then(|r| r.strip_suffix(';')).map(str::trim) else { continue };
                let (dir, file) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
                let stem = file.trim_end_matches(".rs");
                let base = if ["mod", "lib", "main"].contains(&stem) { dir.to_string() } else { format!("{dir}/{stem}") };
                out.insert(format!("{base}/{name}.rs"));
                out.insert(format!("{base}/{name}/mod.rs"));
            }
        }
        out
    }

    /// 檔案裡屬於測試的那段文字：測試專用檔整份（tests/ 底下、路徑有 /tests/ 的、用 `#[cfg(test)] mod x;` 宣告的、
    /// 名為 tests.rs／testsupport.rs／term_live_mux.rs 的）；其他檔從 `#[cfg(test)]` 後面接 inline `mod` 的那行起到檔尾
    fn test_region(rel: &str, text: &str, test_mods: &std::collections::BTreeSet<String>) -> String {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if rel.starts_with("tests/") || rel.contains("/tests/") || test_mods.contains(rel) || ["tests.rs", "testsupport.rs", "term_live_mux.rs"].contains(&name) {
            return text.to_string();
        }
        // 每一個 `#[cfg(test)]` 接 inline `mod x {` 的區塊，只取到它配對的 `}` 為止（後面的正式程式不算）
        let t = text.replace("\r\n", "\n");
        let mut out = String::new();
        let mut off = 0;
        let lines: Vec<&str> = t.split('\n').collect();
        for (i, l) in lines.iter().enumerate() {
            if l.trim() == "#[cfg(test)]" && lines.get(i + 1).is_some_and(|n| (n.trim_start().starts_with("mod ") || n.trim_start().starts_with("pub mod ")) && n.trim_end().ends_with('{')) {
                let end = block_end(&t, off + l.len() + 1).unwrap_or(t.len());
                out.push_str(&t[off..end]);
                out.push('\n');
            }
            off += l.len() + 1;
        }
        out
    }

    /// 從 `from` 之後第一個 `{` 起，找到配對的 `}`，回它後面的位置。略過字串、原始字串、字元與註解裡的括號
    fn block_end(t: &str, from: usize) -> Option<usize> {
        let b = t.as_bytes();
        let mut i = from + t[from..].find('{')?;
        let mut depth = 0i32;
        while i < b.len() {
            match b[i] {
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    i = t[i..].find('\n').map_or(b.len(), |n| i + n);
                    continue;
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    i = t[i + 2..].find("*/").map_or(b.len(), |n| i + 2 + n + 2);
                    continue;
                }
                b'r' if (b.get(i + 1) == Some(&b'"') || b.get(i + 1) == Some(&b'#')) && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_')) => {
                    let hashes = b[i + 1..].iter().take_while(|&&c| c == b'#').count();
                    if b.get(i + 1 + hashes) == Some(&b'"') {
                        let close = format!("\"{}", "#".repeat(hashes));
                        let start = i + 2 + hashes;
                        i = t[start..].find(&close).map_or(b.len(), |n| start + n + close.len());
                        continue;
                    }
                }
                b'"' => {
                    let mut j = i + 1;
                    while j < b.len() && b[j] != b'"' {
                        j += if b[j] == b'\\' { 2 } else { 1 };
                    }
                    i = j + 1;
                    continue;
                }
                b'\'' if b.get(i + 2) == Some(&b'\'') || (b.get(i + 1) == Some(&b'\\') && b.get(i + 3) == Some(&b'\'')) => {
                    i += if b[i + 1] == b'\\' { 4 } else { 3 };
                    continue;
                }
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    #[test]
    fn 掃描範圍_獨立測試檔與宣告的測試模組都算_ignore_判斷() {
        let files = vec![
            ("src/bridge/mod.rs".to_string(), "#[cfg(test)]\nmod tests;\n".to_string()),
            ("src/launch/term.rs".to_string(), "#[cfg(test)]\npub mod golden;\n".to_string()),
            ("src/quota.rs".to_string(), "#[cfg(test)]\nmod quota_it;\n".to_string()),
        ];
        let m = declared_test_mods(&files);
        for want in ["src/bridge/tests.rs", "src/bridge/tests/mod.rs", "src/launch/term/golden.rs", "src/quota/quota_it.rs"] {
            assert!(m.contains(want), "{want}：{m:?}");
        }
        assert_eq!(test_region("src/bridge/tests/rooms_launch.rs", "全文", &m), "全文", "路徑有 /tests/ 的整份算");
        assert_eq!(test_region("src/launch/term/golden.rs", "全文", &m), "全文", "宣告成測試模組的整份算");
        assert_eq!(test_region("src/other.rs", "正式\n#[cfg(test)]\nmod t {\n測試\n}\nfn 正式二() { let s = \"}\"; }", &m), "#[cfg(test)]\nmod t {\n測試\n}\n", "只取測試區塊，後面的正式程式不算");
        let src = "mod t { let s = \"}\"; let r = r#\"{\"#; let c = '}'; // }\n }";
        assert_eq!(block_end(src, 0), Some(src.len()), "字串、原始字串、字元、註解裡的括號不算：配對到最後那個右括號");
        let ignored = "    #[test]\n    #[ignore]\n    fn 真機() {\n        let r = RealRunner;\n    }\n";
        let plain = "    #[test]\n    fn 一般() {\n        let r = RealRunner;\n    }\n";
        let asyncf = "    #[tokio::test]\n    #[ignore = \"真機\"]\n    async fn 真機2() {\n        RealRunner.go();\n    }\n";
        assert!(only_in_ignored_fns(ignored, "RealRunner"));
        assert!(only_in_ignored_fns(asyncf, "RealRunner"), "async fn、帶理由的 #[ignore] 也認得");
        assert!(!only_in_ignored_fns(plain, "RealRunner"));
        assert!(!only_in_ignored_fns(&format!("{ignored}{plain}"), "RealRunner"), "有一處不在 #[ignore] 裡就不放行");
    }

    #[test]
    fn 暫存資料夾_只用自己_pid_的那一個() {
        let a = mux_base();
        assert!(a.starts_with(own_dir()));
        assert!(own_dir().ends_with(format!("asn-tm-{}", std::process::id())));
    }

    #[test]
    fn 測試碼不得直接用會碰真環境的入口() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        rs_files(&root.join("src"), &mut files);
        rs_files(&root.join("tests"), &mut files);
        let mut bad = Vec::new();
        let mut used = std::collections::BTreeSet::new();
        let texts: Vec<(String, String)> = files
            .iter()
            .filter_map(|f| Some((f.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"), std::fs::read_to_string(f).ok()?)))
            .collect();
        let test_mods = declared_test_mods(&texts);
        for (rel, text) in &texts {
            if rel == "src/test_guard.rs" {
                continue; // 守衛自己要寫出這些字串
            }
            let region = test_region(rel, text, &test_mods);
            for tok in FORBIDDEN {
                if region.contains(tok) {
                    match ALLOW.iter().position(|(p, t, _, _)| rel.ends_with(p) && t == tok) {
                        Some(i) if ALLOW[i].2 == Scope::File || only_in_ignored_fns(&region, tok) => {
                            used.insert(i);
                        }
                        Some(_) => bad.push(format!("{rel}：{tok} 只准出現在 #[ignore] 的測試函式裡")),
                        None => bad.push(format!("{rel}：測試碼用了 {tok}")),
                    }
                }
            }
        }
        assert!(bad.is_empty(), "測試碼不得直接用（改用 live_for_test／set_mux_base／假的 Runner，或到 ALLOW 寫理由）：\n{}", bad.join("\n"));
        let stale: Vec<_> = (0..ALLOW.len()).filter(|i| !used.contains(i)).map(|i| ALLOW[i].0).collect();
        assert!(stale.is_empty(), "例外清單有用不到的項目，請刪掉：{stale:?}");
    }
}
