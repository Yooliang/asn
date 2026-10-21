//! 使用者明確按下安裝後，才呼叫官方安裝流程；成功後可選擇開啟「登入用」終端機（不是一般啟動捷徑）。

use crate::nowin::NoWindow;
use super::catalog::{tool, InstallKind, ToolDef};
use super::detect::binary_on_path;
use super::types::InstallResult;
use std::process::{Command, Stdio};

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

fn run_install(def: &ToolDef) -> Result<String, String> {
    match def.install {
        InstallKind::None => Err("此工具請從官方網站安裝，ASN 不提供一鍵安裝。".into()),
        InstallKind::NativeInstaller => run_native_installer(def),
        InstallKind::NpmGlobal => {
            let pkg = def
                .npm_package
                .clone()
                .ok_or_else(|| "缺少 npm 套件名".to_string())?;
            run_npm_global(&pkg)
        }
    }
}

fn run_native_installer(def: &ToolDef) -> Result<String, String> {
    #[cfg(windows)]
    {
        let url = def
            .install_ps1_url
            .clone()
            .ok_or_else(|| "此平台沒有官方安裝網址".to_string())?;
        let script = format!(
            "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; \
             irm {url} | iex"
        );
        let st = Command::new("powershell").no_window()
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| format!("無法啟動 PowerShell：{e}"))?;
        if !st.success() {
            return Err("官方安裝程式回報失敗；請檢查網路或以系統管理員身分重試。".into());
        }
        Ok(format!("{} 官方安裝程式已執行完成。", def.label.clone()))
    }
    #[cfg(not(windows))]
    {
        let url = def
            .install_sh_url
            .clone()
            .ok_or_else(|| "此平台沒有官方安裝網址".to_string())?;
        let script = format!("curl -fsSL {url} | bash");
        let st = Command::new("bash").no_window()
            .arg("-lc")
            .arg(&script)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| format!("無法執行 bash：{e}"))?;
        if !st.success() {
            return Err("官方安裝程式回報失敗；請檢查 curl、bash 與網路連線。".into());
        }
        Ok(format!("{} 官方安裝程式已執行完成。", def.label.clone()))
    }
}

fn run_npm_global(package: &str) -> Result<String, String> {
    if !binary_on_path("npm") {
        return Err("找不到 npm。請先從 nodejs.org 安裝 Node.js 20 以上，再重試。".into());
    }
    let st = Command::new("npm").no_window()
        .args(["install", "-g", package])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| format!("無法執行 npm：{e}"))?;
    if !st.success() {
        return Err("npm 安裝失敗；請勿使用 sudo，並確認 npm 全域目錄可寫。".into());
    }
    Ok(format!("已用 npm 安裝 {package}。"))
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
}
