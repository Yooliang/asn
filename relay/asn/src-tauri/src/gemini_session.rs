//! ASN 自己開的 agy 視窗（「ASN 開的終端」）帶上狀態列指令（#374 第二張，asn真 #1515；#374 小 PR 修正）：
//! 啟動時加 `agy --settings <檔>`，只對這一次 session 套用，**絕不讀、絕不寫** `~/.gemini/antigravity-cli/settings.json`。
//!
//! `--settings` 的語意：工作機用真的 agy 實測，是**逐鍵疊加**在使用者的 settings.json 上
//! （session 沒帶 model 時 agy 仍讀到使用者的 model；有帶時讀到 session 的），所以檔案裡只放 statusLine 一個鍵，
//! 使用者其他設定（模型、配色、信任資料夾）由 agy 自己從使用者檔讀，不必也不該複製一份。
//!
//! 狀態列指令（Windows）：agy 交給 cmd 時會把指令裡每個 `"` 變成 `\"`，指令一加引號就壞（實測單層、兩層都壞）。
//! 所以寫一支 `<ASN 資料夾>/gemini-statusline.cmd` 包一層，再用 `GetShortPathNameW` 轉成 8.3 短路徑當指令、不加引號。
//! 短路徑還要檢查：沒有空白、`& ( ) ^ < > | % ! ; , =`、引號與控制字元才用（[`cmd_command`]）。
//! 轉不出來、或磁碟關了 8.3（會回原本的長路徑）而仍含這些字元 → 這次不帶 --settings、照舊開 agy（原因只進 log）。
//! .cmd 裡 asn-cli 在就跑 `"asn-cli 路徑" gemini-quota`（這行在 .cmd 檔裡，引號照留、不轉短路徑），不在就印 `Gemini`。
//! 其他系統用 `sh -c`，直接給加了單引號的 asn-cli 路徑（行為同前）。
//! asn-cli 路徑含 `"`、`%`、控制字元時不接（cmd 會把 % 展開）。
//! 純檔案邏輯，路徑都由呼叫端傳入，測試用暫存資料夾。
use serde_json::{json, Value};
use std::path::Path;

const CMD_FILE: &str = "gemini-statusline.cmd";
const SETTINGS_FILE: &str = "gemini-session-settings.json";

fn path_ok(p: &str, windows: bool) -> bool {
    !p.is_empty() && !p.chars().any(|c| c.is_control() || c == '"' || (windows && c == '%'))
}

/// Windows 的 .cmd 內容（CRLF）。不用括號區塊：路徑裡的「(x86)」放在區塊裡會讓 cmd 解析錯。
pub fn cmd_script(asn_cli: &str) -> String {
    [
        "@echo off".to_string(),
        format!("if not exist \"{asn_cli}\" goto none"),
        format!("\"{asn_cli}\" gemini-quota"),
        "exit /b 0".into(),
        ":none".into(),
        "echo Gemini".into(),
        "exit /b 0".into(),
        String::new(),
    ]
    .join("\r\n")
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 會讓 cmd 拆字、展開或轉義的字元：路徑裡有任何一個就不能不加引號直接當指令
const CMD_UNSAFE: &[char] = &['&', '(', ')', '^', '<', '>', '|', '%', '!', ';', ',', '=', '"', '\''];

/// Windows：.cmd 的（短）路徑能不能不加引號直接當 statusLine.command。能就回那個字串，不能回 None。
/// 不能的情況：空的、有空白（含全形空白）、有 [`CMD_UNSAFE`] 的字元、有控制字元。
pub fn cmd_command(candidate: &str) -> Option<String> {
    let bad = candidate.is_empty() || candidate.chars().any(|c| c.is_whitespace() || c.is_control() || CMD_UNSAFE.contains(&c));
    (!bad).then(|| candidate.to_string())
}

/// 非 Windows 的 statusLine.command：asn-cli 不在就印 Gemini
pub fn sh_command(asn_cli: &str) -> String {
    let q = sh_quote(asn_cli);
    format!("if [ -x {q} ]; then {q} gemini-quota; else echo Gemini; fi")
}

/// 這次 session 的設定：只有 statusLine 一個鍵（agy 逐鍵疊加在使用者設定上）。
/// stack_with_default 讓 agy 內建的那行照樣顯示。
pub fn session_settings(command: &str) -> Value {
    json!({ "statusLine": { "type": "command", "command": command, "enabled": true, "stack_with_default": true } })
}

fn write_if_changed(p: &Path, text: &str) -> Result<(), String> {
    if std::fs::read_to_string(p).ok().as_deref() == Some(text) {
        return Ok(());
    }
    crate::claude_json::write_atomic(p, text.as_bytes()).map_err(|e| format!("無法寫入 {}：{e}", p.display()))
}

/// Windows 的 8.3 短路徑（路徑必須已存在）。失敗回 None；磁碟關了 8.3 時會回原本的長路徑。
#[cfg(windows)]
pub fn short_path(p: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 1024];
    // SAFETY: wide 以 0 結尾；buf 的長度如實傳入，回傳值 >= 長度代表放不下（當失敗）
    let n = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n]))
}
#[cfg(not(windows))]
pub fn short_path(_p: &Path) -> Option<String> {
    None
}

/// 準備這次 session 的設定檔，回 agy 要多帶的參數（`--settings <檔>`）。只寫 ASN 自己的資料夾（.cmd 與設定檔）。
pub fn prepare(asn_home: &Path, asn_cli: &Path, windows: bool) -> Result<Vec<String>, String> {
    prepare_with(asn_home, asn_cli, windows, short_path)
}

/// 同 [`prepare`]，短路徑的轉法由呼叫端給（測試用）
pub fn prepare_with(asn_home: &Path, asn_cli: &Path, windows: bool, shorten: impl Fn(&Path) -> Option<String>) -> Result<Vec<String>, String> {
    let cli = asn_cli.to_string_lossy().into_owned();
    if !path_ok(&cli, windows) {
        return Err("asn-cli 的路徑含有不能放進指令的字元，這次不接 Gemini 狀態列".into());
    }
    let command = if windows {
        let cmd_path = asn_home.join(CMD_FILE);
        write_if_changed(&cmd_path, &cmd_script(&cli))?;
        let Some(short) = shorten(&cmd_path) else {
            return Err("轉不出 .cmd 的短路徑，這次不接 Gemini 狀態列".into());
        };
        cmd_command(&short).ok_or_else(|| format!("短路徑仍含空白或特殊字元（{short}），這次不接 Gemini 狀態列"))?
    } else {
        sh_command(&cli)
    };
    let out = asn_home.join(SETTINGS_FILE);
    let text = serde_json::to_string_pretty(&session_settings(&command)).map_err(|e| e.to_string())?;
    write_if_changed(&out, &text)?;
    Ok(vec!["--settings".into(), out.to_string_lossy().into_owned()])
}

/// 正式：開 agy 終端前呼叫。asn-cli 不在或準備失敗就回空的（照舊開 agy，只是讀不到額度），原因只進 log。
#[cfg(feature = "gui")]
pub fn live_args() -> Vec<String> {
    let cli = crate::statusline_hook::asn_cli_path();
    if !cli.is_file() {
        eprintln!("Gemini 狀態列：找不到 asn-cli，這次不接");
        return vec![];
    }
    match prepare(&crate::identity::relay_home(), &cli, cfg!(windows)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Gemini 狀態列：{e}");
            vec![]
        }
    }
}

#[cfg(test)]
mod tests;
