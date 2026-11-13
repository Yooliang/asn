//! 使用者明確按下安裝後，才呼叫安裝流程；成功後可選擇開啟「登入用」終端機（不是一般啟動捷徑）。
//!
//! #933：ASN **不執行任何下載來的腳本**（不 `irm 網址 | iex`、不 `curl | sh`、不 `npm install -g`）。
//! 能一鍵安裝的只有清單標 `verified` 的工具，走 `agent_setup` 裡「下載、比對雜湊、驗數位簽章，通過才執行」的流程；
//! 其他一律回「請到官網安裝」，不啟動任何子程序。新增一家要先在 `agent_setup` 寫好驗證式安裝，再把清單改成 `verified`。

use super::catalog::{tool, InstallKind, ToolDef};
use super::detect::binary_on_path;
use super::types::InstallResult;
use std::process::Command;

pub fn install_tool(tool_id: &str, open_login_after: bool) -> InstallResult {
    let Some(def) = tool(tool_id) else {
        return InstallResult {
            ok: false,
            message: "不認得這個工具代號".into(),
            opened_login: false,
        };
    };
    let msg = match run_install(def) {
        Ok(m) => m,
        Err(e) => {
            return InstallResult {
                ok: false,
                message: e,
                opened_login: false,
            };
        }
    };
    let mut opened = false;
    if open_login_after && binary_on_path(&def.binary) && !def.login_argv.is_empty() {
        opened = open_login_terminal(def).is_ok();
    }
    let tail = if opened {
        "已開啟終端機供您登入。"
    } else if !def.login_argv.is_empty() {
        "請手動開啟終端機執行登入指令。"
    } else {
        ""
    };
    InstallResult {
        ok: true,
        message: format!("{msg}{tail}"),
        opened_login: opened,
    }
}

pub fn open_login_terminal(def: &ToolDef) -> Result<(), String> {
    if def.login_argv.is_empty() {
        return Err("此工具請在官方應用程式內登入".into());
    }
    let bin = def.binary.as_str();
    let args: Vec<String> = def.login_argv.clone();
    spawn_interactive_terminal(bin, &args)
}

/// 請使用者到官網安裝時的說明（不啟動任何程式）
pub(super) fn manual_text(def: &ToolDef) -> String {
    format!("ASN 還不能替你安裝 {}，請到官網照說明安裝；裝好後 ASN 會自動偵測。", def.label)
}

fn run_install(def: &ToolDef) -> Result<String, String> {
    match def.install {
        InstallKind::Manual => Err(manual_text(def)),
        InstallKind::Verified => run_verified(def),
    }
}

/// 驗證式安裝的分派：只認寫好流程的工具，其餘就算清單標了 `verified` 也不裝（清單是資料，流程才是把關）
fn run_verified(def: &ToolDef) -> Result<String, String> {
    #[cfg(windows)]
    {
        if def.id == "claude" {
            return crate::agent_setup::claude_install::install_here();
        }
        Err(manual_text(def))
    }
    #[cfg(not(windows))]
    {
        // Linux／macOS 沒有 Authenticode，這一輪不做一鍵安裝（#933 第 5 節第 1 點）
        let _ = def;
        Err("這一版只在 Windows 上由 ASN 安裝；請到官網照說明安裝，裝好後 ASN 會自動偵測。".into())
    }
}

fn spawn_interactive_terminal(program: &str, args: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmdline = program.to_string();
        for a in args {
            cmdline.push(' ');
            if a.contains(' ') {
                cmdline.push('"');
                cmdline.push_str(a);
                cmdline.push('"');
            } else {
                cmdline.push_str(a);
            }
        }
        Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/k", &cmdline])
            .spawn()
            .map_err(|e| format!("無法開啟登入用終端機：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let joined = args.join(" ");
        let inner = format!("{program} {joined}; echo; echo '登入完成後可關閉此視窗。'; exec bash");
        for (term, term_args) in [
            ("x-terminal-emulator", vec!["-e", "bash", "-lc", &inner]),
            ("gnome-terminal", vec!["--", "bash", "-lc", &inner]),
            ("konsole", vec!["-e", "bash", "-lc", &inner]),
            ("xfce4-terminal", vec!["-e", "bash", "-lc", &inner]),
            ("xterm", vec!["-e", "bash", "-lc", &inner]),
        ] {
            if binary_on_path(term) {
                Command::new(term).args(term_args).spawn().map_err(|e| format!("無法開啟登入用終端機：{e}"))?;
                return Ok(());
            }
        }
        Err("找不到圖形終端機；請手動開啟終端機執行登入。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未知工具回錯() {
        let r = install_tool("nope", false);
        assert!(!r.ok);
    }

    #[test]
    fn 請使用者到官網的工具_不安裝也不開登入() {
        for id in ["codex", "agy", "grok", "pi"] {
            let r = install_tool(id, true);
            assert!(!r.ok, "{id} 不能由 ASN 安裝");
            assert!(!r.opened_login, "{id} 沒裝成就不開登入終端機");
            assert!(r.message.contains("請到官網"), "{id}：{}", r.message);
        }
    }

    #[test]
    fn 清單標了_verified_但沒有寫好流程的_也不裝() {
        let fake = ToolDef {
            id: "codex".into(),
            label: "Codex".into(),
            binary: "codex".into(),
            engine: "codex".into(),
            install: InstallKind::Verified,
            login_argv: vec![],
            install_blurb: String::new(),
            login_blurb: String::new(),
        };
        let e = run_install(&fake).unwrap_err();
        assert!(e.contains("請到官網"), "{e}");
    }

    /// 一行程式碼像不像「把下載來的腳本直接執行」或 npm 全域安裝；像的話回原因。
    /// 比對字串用拼接組出來，免得守衛自己被自己抓到；只認真正會執行的寫法，不抓 `confirm `、閉包 `|_| sh` 這類巧合
    fn suspicious(line: &str) -> Option<&'static str> {
        let low = line.to_ascii_lowercase();
        let has = |a: &str, b: &str| low.contains(&[a, b].concat());
        if has("| ", "iex") || has("|", "iex") {
            return Some("管線交給 iex 執行");
        }
        if has("invoke-", "expression") || has("download", "string") {
            return Some("PowerShell 直接執行下載的文字");
        }
        // irm 要是獨立的字（前面不是英數字），才不會抓到 confirm、firm 之類
        let pat = ["ir", "m "].concat();
        if low.match_indices(&pat).any(|(i, _)| i == 0 || !low.as_bytes()[i - 1].is_ascii_alphanumeric()) {
            return Some("PowerShell 下載指令");
        }
        let fetch = has("cur", "l ") || has("wge", "t ");
        if fetch && (has("| ", "bash") || has("|", "bash") || has("| ", "sh") || has("|", "sh ")) {
            return Some("下載後管線交給 shell");
        }
        if has("\"install\", ", "\"-g\"") || has("\"i\", ", "\"-g\"") {
            return Some("npm 全域安裝");
        }
        None
    }

    #[test]
    fn 守衛認得舊的寫法_也不誤抓巧合() {
        // 舊版 install.rs 實際有過的三種（拼接組出，不讓守衛掃到這個測試本身）
        let old_ps = ["\"Set-ExecutionPolicy ...; ", "ir", "m {url} | ", "iex\""].concat();
        let old_sh = ["let script = format!(\"", "curl -fsSL {url} | ", "bash\");"].concat();
        let old_npm = [".args([\"install\", ", "\"-g\", package])"].concat();
        for s in [&old_ps, &old_sh, &old_npm] {
            assert!(suspicious(s).is_some(), "要抓到：{s}");
        }
        for ok in ["if confirm < begin {", "on_activity: Arc::new(move || sh_act.x())", "prepare_with(a, &c, true, |_| short.map(String::from))", "runner.run(pi, &[\"install\".to_string(), ext])"] {
            assert!(suspicious(ok).is_none(), "不該抓：{ok}");
        }
    }

    /// 守衛（#933 PR-1）：整個 Rust 程式碼裡不能再有「把下載來的腳本直接執行」或 npm 全域安裝。只看程式碼行（略過 `//` 開頭的註解行）
    #[test]
    fn 原始碼裡沒有執行下載腳本或_npm_全域安裝() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![root];
        let mut hits = vec![];
        let mut files = 0;
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if p.extension().and_then(|x| x.to_str()) != Some("rs") {
                    continue;
                }
                files += 1;
                // 權限框危險字判斷（#1445）要認得「下載後直接執行」的寫法，檔案裡本來就是這些字樣；它只比對文字、不執行任何東西
                if p.ends_with(std::path::Path::new("launch").join("perm_risk.rs")) {
                    continue;
                }
                let src = std::fs::read_to_string(&p).unwrap();
                for (n, line) in src.lines().enumerate() {
                    if line.trim_start().starts_with("//") {
                        continue;
                    }
                    if let Some(why) = suspicious(line) {
                        hits.push(format!("{}:{}：{why}", p.display(), n + 1));
                    }
                }
            }
        }
        assert!(files > 50, "守衛沒讀到程式碼（{files} 個檔）");
        assert!(hits.is_empty(), "不能執行下載來的腳本或 npm 全域安裝：\n{}", hits.join("\n"));
    }
}
