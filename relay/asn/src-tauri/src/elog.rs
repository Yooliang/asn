//! 寫不進去就略過的 stderr／stdout 輸出：`elog!`（stderr）、`olog!`（stdout）。
//!
//! 為什麼不能用標準的 eprintln／println 巨集：它們寫失敗時會 panic（訊息是
//! "failed printing to stderr"）。ASN 的 release 建置設了 `panic = "abort"`，一 panic 整個程式就結束。
//! stderr／stdout「有但寫不進去」很常見：ASN 被別的程式（終端、更新程式、Claude 的 Bash…）帶起來，
//! 那個父程式後來結束了，管線另一頭已經關掉，再寫就是錯誤。
//!
//! 實例：0.1.111 家用機閃退 4 次，傾印檔堆疊都是
//! tokio spawn_blocking → `claude_mod::run_real` → `std::io::_eprint` → panic → abort。
//! 只是印一行「[claude-mod] …」的除錯訊息，就把整個 GUI 帶走。
//!
//! 規則：GUI、收發室橋、背景工作會跑到的程式碼一律用 `elog!`／`olog!`；
//! 只有命令列子命令（src/cli/、src/bin/、main.rs 的命令列分支）給人在終端看的輸出才保留標準巨集。
//! 守門測試（本檔 tests）會掃 src 底下的非測試程式碼，出現標準列印巨集就失敗。

use std::io::Write;

/// 把一行（自動補換行）寫進 `w`，任何錯誤都吞掉、絕不 panic。
/// 先組成整行再一次寫出，多執行緒同時寫時比較不會交錯。
pub(crate) fn write_line(w: &mut impl Write, args: std::fmt::Arguments<'_>) {
    let mut line = std::fmt::format(args);
    line.push('\n');
    let _ = w.write_all(line.as_bytes());
    let _ = w.flush();
}

pub(crate) fn stderr_line(args: std::fmt::Arguments<'_>) {
    // 電腦版視窗：同一行也寫進 ui.log（#2104；stderr 常是斷掉的管線或沒人看，事後查不到）。
    // 機器資料夾還沒設定時只寫 stderr
    #[cfg(all(desktop, feature = "gui"))]
    {
        let msg = std::fmt::format(args);
        write_line(&mut std::io::stderr().lock(), format_args!("{msg}"));
        crate::ui_log::elog_to_file(&msg);
    }
    #[cfg(not(all(desktop, feature = "gui")))]
    write_line(&mut std::io::stderr().lock(), args);
}

pub(crate) fn stdout_line(args: std::fmt::Arguments<'_>) {
    write_line(&mut std::io::stdout().lock(), args);
}

/// 印到 stderr，寫不進去就算了（不 panic）。用法同 eprintln。
macro_rules! elog {
    () => {
        $crate::elog::stderr_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        $crate::elog::stderr_line(format_args!($($arg)*))
    };
}

/// 印到 stdout，寫不進去就算了（不 panic）。用法同 println。
#[allow(unused_macros)]
macro_rules! olog {
    () => {
        $crate::elog::stdout_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        $crate::elog::stdout_line(format_args!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::write_line;
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};

    /// 永遠寫不進去的輸出（模擬接到已斷的管線）
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe closed"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe closed"))
        }
    }

    /// 回 Ok(0) 的輸出：write_all 會轉成 WriteZero 錯誤
    struct Zero;
    impl Write for Zero {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Ok(0)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn 寫不進去不會panic() {
        let name = "claude-mod";
        write_line(&mut Broken, format_args!("[{name}] 安裝資料夾裡沒有外掛檔案：{}", 42));
        write_line(&mut Zero, format_args!("[{name}] x"));
    }

    #[test]
    fn 寫得進去就是一整行() {
        let mut buf = Vec::new();
        write_line(&mut buf, format_args!("a={} b={}", 1, "二"));
        write_line(&mut buf, format_args!(""));
        assert_eq!(String::from_utf8(buf).unwrap(), "a=1 b=二\n\n");
    }

    #[test]
    fn 巨集可以照eprintln的寫法用() {
        let e = "x";
        elog!("[asn] {e} {}", 1);
        elog!();
        olog!("{e}");
        olog!();
    }

    // ---- 守門：非測試程式碼不准用標準列印巨集 ----

    /// 用拼接寫，免得這份檔案自己被當成命中
    fn banned() -> Vec<String> {
        vec![["print", "ln!"].concat(), ["eprint", "ln!"].concat(), ["print", "!"].concat(), ["eprint", "!"].concat(), ["db", "g!"].concat()]
    }

    /// 命令列子命令與測試檔：給人在終端看的輸出／測試輸出，不管
    fn exempt(rel: &str) -> bool {
        let parts: Vec<&str> = rel.split('/').collect();
        let file = parts.last().copied().unwrap_or("");
        matches!(parts[0], "cli" | "bin")
            || rel == "main.rs"
            || file == "tests.rs"
            || file.ends_with("_tests.rs")
            || file == "testsupport.rs"
            || parts[..parts.len() - 1].contains(&"tests")
    }

    /// 去掉 `#[cfg(test)]` 標著的項目（整個 mod／fn／區塊），留下（行號, 內容）。
    /// 切法用共用的 `settings::src_scan::prod_source`（真的數大括號；被拿掉的部分換成空行，行號不變）
    fn prod_lines(text: &str) -> Vec<(usize, String)> {
        crate::settings::src_scan::prod_source(text).lines().enumerate().map(|(i, l)| (i + 1, l.to_string())).collect()
    }

    fn uses_banned(line: &str, banned: &[String]) -> bool {
        if line.trim_start().starts_with("//") {
            return false;
        }
        banned.iter().any(|m| line.match_indices(m.as_str()).any(|(at, _)| at == 0 || !line[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_')))
    }

    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    fn offenders(src: &Path) -> (Vec<String>, Vec<String>) {
        let banned = banned();
        let external = crate::settings::src_scan::external_test_files(src);
        let mut files = vec![];
        walk(src, &mut files);
        let (mut scanned, mut bad) = (vec![], vec![]);
        for p in files {
            let rel = p.strip_prefix(src).unwrap().to_string_lossy().replace('\\', "/");
            if exempt(&rel) || external.contains(&rel) {
                continue;
            }
            let text = std::fs::read_to_string(&p).unwrap();
            for (no, line) in prod_lines(&text) {
                if uses_banned(&line, &banned) {
                    bad.push(format!("{rel}:{no}: {}", line.trim()));
                }
            }
            scanned.push(rel);
        }
        (scanned, bad)
    }

    #[test]
    fn 守門_掃描器分得出正式程式碼與測試區塊() {
        let p = ["e", "println!(\"x\");"].concat();
        let text = format!(
            "fn a() {{\n    {p}\n}}\n// {p}\n#[cfg(test)]\nmod tests {{\n    fn b() {{ let c = '{{'; {p} }}\n}}\n#[cfg(test)]\nmod more;\nfn d() {{ my_{p} }}\nfn e() {{ {p} }}\n"
        );
        let hits: Vec<usize> = prod_lines(&text).into_iter().filter(|(_, l)| uses_banned(l, &banned())).map(|(n, _)| n).collect();
        assert_eq!(hits, vec![2, 12], "只該抓到正式程式碼的那兩行");
        assert!(exempt("cli/send.rs") && exempt("bin/asn-cli.rs") && exempt("main.rs") && exempt("bridge/tests.rs") && exempt("cli/tests/send_tests.rs"));
        assert!(!exempt("claude_mod.rs") && !exempt("launch/term.rs") && !exempt("bridge/worker.rs"));
    }

    #[test]
    fn 守門_視窗與背景程式碼不准用會panic的列印巨集() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let (scanned, bad) = offenders(&src);
        for must in ["claude_mod.rs", "lib.rs", "relay.rs", "launch/term.rs", "bridge/worker.rs"] {
            assert!(scanned.iter().any(|s| s == must), "掃描漏了 {must}");
        }
        assert!(
            bad.is_empty(),
            "這些地方用了標準列印巨集，stderr／stdout 寫不進去（管線已斷）時會 panic，release 建置 panic=abort 就整個閃退（0.1.111 家用機實例：claude_mod::run_real）。\n請改用 elog!（stderr）或 olog!（stdout），見 src/elog.rs；只有 src/cli/、src/bin/ 命令列輸出可例外：\n{}",
            bad.join("\n")
        );
    }
}
