//! 背景子程序不要閃出黑色主控台視窗：Windows 上 GUI 程式啟動主控台程式（tasklist、powershell、icacls、where…）
//! 若不帶 CREATE_NO_WINDOW，每個都會閃一扇黑視窗。所有非互動、背景用途的 `Command` 一律呼叫 `.no_window()`；
//! 刻意開視窗的（開 Claude／Codex 終端、登入用終端機）才不呼叫，且要列進下面守門測試的白名單。
//! 非 Windows 上 `.no_window()` 什麼都不做，所以呼叫端不用加 cfg。

/// CREATE_NO_WINDOW
pub const NO_WINDOW: u32 = 0x0800_0000;

pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(NO_WINDOW);
        }
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
        ("lib.rs", "Command::new(\"explorer.exe\")"),        // 用預設瀏覽器開網址
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
