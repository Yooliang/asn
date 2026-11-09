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
    std::env::temp_dir().join(format!("asn-tm-{}", std::process::id())).join(N.fetch_add(1, Ordering::SeqCst).to_string())
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

    /// 例外清單：(檔案結尾, 禁用字串, 理由)。每一條都要有理由；新增前先想能不能改用假的 Runner
    const ALLOW: &[(&str, &str, &str)] = &[
        // claude_mod／pi_setup 各自有同名但無關的 RealRunner（只跑 claude／pi 的小指令，與 mux 無關）
        ("src/claude_mod.rs", "RealRunner", "claude_mod 自己的 RealRunner：只啟動測試自備的暫存腳本／逾時行為"),
        ("src/launch/pi_setup.rs", "RealRunner", "pi_setup 自己的 RealRunner：#[ignore] 的真機測試，不碰 mux"),
        ("src/launch/config.rs", "RealRunner", "只做原始碼字串檢查（assert 內文），不執行"),
        // wezterm 真機測試：全部 #[ignore] 或在沒有 WezTerm 的機器上直接略過
        ("src/launch/wezterm.rs", "RealRunner", "wezterm 的 Runner 實作與它自己的真程序測試（只啟動測試自備的暫存程式）"),
        ("src/launch/term.rs", "RealRunner", "#[ignore] 的真機測試：用 TermService::fixed 指到暫存資料夾與獨立的 WezTerm，mux 資料夾已注入暫存位置"),
        ("src/launch/term_live_mux.rs", "RealRunner", "#[ignore] 的真 WezTerm 測試：set_mux_base 注入暫存位置"),
        ("src/launch/mux/tests.rs", "RealRunner", "測試自己的暫存 mux（paths 用暫存資料夾）；真 WezTerm 的整合測試 #[ignore]，其餘跑無害的程序"),
    ];

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

    /// 檔案裡屬於測試的那段文字：測試專用檔整份；其他檔從 `#[cfg(test)]` 後面接 `mod` 的那行起到檔尾
    fn test_region(rel: &str, text: &str) -> String {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if rel.starts_with("tests/") || ["tests.rs", "testsupport.rs", "term_live_mux.rs"].contains(&name) {
            return text.to_string();
        }
        let t = text.replace("\r\n", "\n");
        let mut from = None;
        let mut off = 0;
        let lines: Vec<&str> = t.split('\n').collect();
        for (i, l) in lines.iter().enumerate() {
            if l.trim() == "#[cfg(test)]" && lines.get(i + 1).is_some_and(|n| (n.trim_start().starts_with("mod ") || n.trim_start().starts_with("pub mod ")) && n.trim_end().ends_with('{')) {
                from = Some(off);
                break;
            }
            off += l.len() + 1;
        }
        from.map(|f| t[f..].to_string()).unwrap_or_default()
    }

    #[test]
    fn 測試碼不得直接用會碰真環境的入口() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        rs_files(&root.join("src"), &mut files);
        rs_files(&root.join("tests"), &mut files);
        let mut bad = Vec::new();
        let mut used = std::collections::BTreeSet::new();
        for f in files {
            let rel = f.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if rel == "src/test_guard.rs" {
                continue; // 守衛自己要寫出這些字串
            }
            let Ok(text) = std::fs::read_to_string(&f) else { continue };
            let region = test_region(&rel, &text);
            for tok in FORBIDDEN {
                if region.contains(tok) {
                    if let Some(i) = ALLOW.iter().position(|(p, t, _)| rel.ends_with(p) && t == tok) {
                        used.insert(i);
                    } else {
                        bad.push(format!("{rel}：測試碼用了 {tok}"));
                    }
                }
            }
        }
        assert!(bad.is_empty(), "測試碼不得直接用（改用 live_for_test／set_mux_base／假的 Runner，或到 ALLOW 寫理由）：\n{}", bad.join("\n"));
        let stale: Vec<_> = (0..ALLOW.len()).filter(|i| !used.contains(i)).map(|i| ALLOW[i].0).collect();
        assert!(stale.is_empty(), "例外清單有用不到的項目，請刪掉：{stale:?}");
    }
}
