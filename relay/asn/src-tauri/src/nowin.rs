//! 背景子程序不要閃出黑色主控台視窗：Windows 上 GUI 程式啟動主控台程式（tasklist、powershell、icacls、where…）
//! 若不帶 CREATE_NO_WINDOW，每個都會閃一扇黑視窗。所有非互動、背景用途的 `Command` 一律呼叫 `.no_window()`；
//! 刻意開視窗的（開 Claude／Codex 終端、登入用終端機）才不呼叫，且要列進下面守門測試的白名單。
//! 非 Windows 上 `.no_window()` 什麼都不做，所以呼叫端不用加 cfg。

/// CREATE_NO_WINDOW
pub const NO_WINDOW: u32 = 0x0800_0000;

pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

// 背景子程序的標準輸入預設給 null，不要繼承 ASN 自己的：ASN 是 GUI 程式，標準代號可能是沒有的、或被 AttachConsole／FreeConsole
// 搞成失效的（#596：`taskkill` 因此啟動失敗、錯誤 6「控制代碼無效」，看畫面的 GUI 與空的 mux 都收不掉）。
// 呼叫端之後再 `.stdin(...)` 會覆蓋這個預設（要餵 stdin 的照常用 piped）。
impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(NO_WINDOW);
        }
        self.stdin(std::process::Stdio::null());
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(NO_WINDOW);
        }
        self.stdin(std::process::Stdio::null());
        self
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// 刻意要開視窗的位置（檔案相對 src 的路徑, 該處 Command::new 那一行含有的字串；空字串＝整個檔案）。
    /// 其餘每個 `Command::new` 都必須在同一段陳述式內呼叫 `.no_window()`（或 creation_flags）。
    const INTENDED_WINDOW: &[(&str, &str)] = &[
        ("launch/local.rs", ""),                             // 開 Claude／Codex 的終端機視窗（Start-Process 或 Linux 終端機）
        ("agent_tools/install.rs", "Command::new(\"cmd\")"), // 登入用終端機（cmd /C start）
        ("agent_tools/install.rs", "Command::new(term)"),    // Linux 登入用終端機
        ("lib.rs", "Command::new(\"explorer\")"),            // 使用者要看的資料夾視窗
        ("lib.rs", "Command::new(\"xdg-open\")"),
    ];

    fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                rs_files(&p, out);
            } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                out.push(p);
            }
        }
    }

    /// 回傳每個 `Command::new(` 的（行號, 該行文字, 從這裡到下一個 `Command::new(` 或 500 字內是否有 no_window／creation_flags）
    fn scan(src: &str) -> Vec<(usize, String, bool)> {
        let mut v = Vec::new();
        let mut from = 0;
        while let Some(i) = src[from..].find("Command::new(") {
            let at = from + i;
            let line_no = src[..at].matches('\n').count() + 1;
            let line = src.lines().nth(line_no - 1).unwrap_or("").trim().to_string();
            let tail_start = at + "Command::new(".len();
            let mut end = (tail_start + 500).min(src.len());
            while !src.is_char_boundary(end) {
                end -= 1;
            }
            let mut tail = &src[tail_start..end];
            if let Some(n) = tail.find("Command::new(") {
                tail = &tail[..n];
            }
            let ok = tail.contains(".no_window()") || tail.contains("creation_flags(");
            v.push((line_no, line, ok));
            from = tail_start;
        }
        v
    }

    #[test]
    fn 每個背景子程序都不閃主控台視窗() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rs_files(&src_dir, &mut files);
        let mut bad = Vec::new();
        let mut seen = 0;
        for f in &files {
            let rel = f.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
            // 本檔的測試程式碼字串裡有 "Command::new(" 範例，掃描器不掃自己
            if rel == "nowin.rs" {
                continue;
            }
            let text = std::fs::read_to_string(f).unwrap();
            for (ln, line, ok) in scan(&text) {
                seen += 1;
                let exempt = INTENDED_WINDOW.iter().any(|(file, pat)| *file == rel && (pat.is_empty() || line.contains(pat)));
                if !ok && !exempt {
                    bad.push(format!("{rel}:{ln}: {line}"));
                }
            }
        }
        assert!(seen >= 15, "掃描器壞了：只掃到 {seen} 處 Command::new");
        assert!(bad.is_empty(), "這些子程序沒呼叫 .no_window()，在 Windows 會閃黑視窗：\n{}", bad.join("\n"));
    }

    #[test]
    fn 守門掃描器抓得到漏掉的() {
        let s = "let a = Command::new(\"x\").arg(1).output();\nlet b = Command::new(\"y\").no_window().output();\n";
        let r = scan(s);
        assert_eq!(r.len(), 2);
        assert!(!r[0].2 && r[1].2);
    }

    #[test]
    fn 白名單不能是死項目() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for (file, pat) in INTENDED_WINDOW {
            let text = std::fs::read_to_string(src_dir.join(file)).unwrap();
            assert!(text.contains(if pat.is_empty() { "Command::new(" } else { pat }), "白名單項目對不到程式：{file} {pat}");
        }
    }
}

#[cfg(all(test, windows))]
mod stdin_tests {
    use super::NoWindow;
    use std::io::Write;
    use std::process::{Command, Stdio};

    extern "system" {
        fn CreatePipe(read: *mut isize, write: *mut isize, attrs: *const u8, size: u32) -> i32;
        fn SetStdHandle(n: u32, h: isize) -> i32;
        fn GetStdHandle(n: u32) -> isize;
        fn CloseHandle(h: isize) -> i32;
    }
    const STD_INPUT: u32 = 0xFFFF_FFF6;

    /// 等子程序結束，最多 `secs` 秒；逾時就結束它並回 None
    fn finished_within(child: &mut std::process::Child, secs: u64) -> Option<std::process::ExitStatus> {
        let t = std::time::Instant::now();
        loop {
            if let Some(st) = child.try_wait().unwrap() {
                return Some(st);
            }
            if t.elapsed() > std::time::Duration::from_secs(secs) {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// #596：背景子程序的 stdin 預設是 null，不繼承 ASN 自己的標準輸入（可能是失效的代號，也可能是別人的管線）。
    /// 把這個測試程序的標準輸入換成一條「沒人寫、也不關」的管線：沒設 stdin 的子程序會繼承它、`findstr` 就一直等輸入；
    /// `no_window()` 預設 null 的話 `findstr` 讀到檔尾就結束。標準輸入是整個測試程序共用的，測完就換回去
    #[test]
    fn no_window_預設_stdin_是_null_不繼承程序自己的標準輸入() {
        let (mut r, mut w) = (0isize, 0isize);
        assert_ne!(unsafe { CreatePipe(&mut r, &mut w, std::ptr::null(), 0) }, 0);
        let old = unsafe { GetStdHandle(STD_INPUT) };
        unsafe { SetStdHandle(STD_INPUT, r) };

        // 前提：沒設 stdin 的子程序會繼承這條管線，所以卡住。前提不成立就代表這個測試分不出差別，不能算通過
        let mut bare = Command::new("cmd").args(["/c", "findstr", "x"]).creation_flags_nowin().stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let bare_done = finished_within(&mut bare, 3);
        // no_window()：stdin 是 null，讀到檔尾就結束
        let mut guarded = Command::new("cmd");
        guarded.no_window().args(["/c", "findstr", "x"]).stdout(Stdio::null()).stderr(Stdio::null());
        let mut guarded = guarded.spawn().unwrap();
        let guarded_done = finished_within(&mut guarded, 5);

        unsafe {
            SetStdHandle(STD_INPUT, old);
            CloseHandle(r);
            CloseHandle(w);
        }
        assert!(bare_done.is_none(), "前提：沒設 stdin 會繼承程序的標準輸入而卡住；沒卡住代表這個測試分不出 no_window 有沒有設 null");
        assert!(guarded_done.is_some(), "no_window() 預設 stdin 為 null：不該繼承程序的標準輸入");
    }

    #[test]
    fn 呼叫端之後自己指定_stdin_會覆蓋預設() {
        let mut c = Command::new("cmd");
        c.no_window().args(["/c", "findstr", "hello"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = c.spawn().unwrap();
        child.stdin.take().unwrap().write_all(b"hello world\r\n").unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello world"), "要餵 stdin 的照常能餵");
    }

    /// 只設 CREATE_NO_WINDOW、不動 stdin 的 Command（對照組）
    trait Bare {
        fn creation_flags_nowin(&mut self) -> &mut Self;
    }
    impl Bare for Command {
        fn creation_flags_nowin(&mut self) -> &mut Self {
            use std::os::windows::process::CommandExt;
            self.creation_flags(super::NO_WINDOW)
        }
    }
}
