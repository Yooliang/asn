//! ASN 自己開的 agy 視窗（「ASN 開的終端」）帶上狀態列指令（#374 第二張，asn真 #1515）：
//! 啟動時加 `agy --settings <檔>`，只對這一次 session 套用，**絕不寫** `~/.gemini/antigravity-cli/settings.json`。
//!
//! `--settings` 的語意（agy 1.4.10 `--help`）：「Settings for this session only, never saved: a JSON object of settings.json keys,
//! inline or as a file path」。官方文件（statusline、settings 頁）沒寫它是疊加在使用者設定上還是整份取代。
//! 所以這裡一律「讀使用者的設定（只讀）→ 換掉 statusLine → 整份傳進去」：疊加的話結果等於使用者設定＋我們的狀態列，
//! 取代的話使用者的模型、配色、信任資料夾也還在，兩種語意下這個視窗看到的設定都一樣。使用者檔讀不到或壞掉就只傳 statusLine。
//!
//! 狀態列指令：agy 在 Windows 用 `cmd /c` 執行。路徑有空白時 cmd 的引號規則很容易出錯（實測踩到），
//! 所以寫一支 `<ASN 資料夾>/gemini-statusline.cmd` 包一層，指令只給那支 .cmd 的路徑（加引號）。
//! .cmd 裡 asn-cli 在就跑 `asn-cli gemini-quota`（它一定印一行、結束碼 0），不在（例如已解除安裝）就印 `Gemini`。
//! 其他系統用 `sh -c`，直接給加了單引號的 asn-cli 路徑。
//! 路徑含 `"`、`%`、控制字元時不接（cmd 會把 % 展開），回錯讓呼叫端照舊開 agy、不帶 --settings。
//! 純檔案邏輯，路徑都由呼叫端傳入，測試用暫存資料夾。
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const CMD_FILE: &str = "gemini-statusline.cmd";
const SETTINGS_FILE: &str = "gemini-session-settings.json";
const MAX_USER_SETTINGS: u64 = 1_000_000;

/// 使用者自己的 agy 設定檔（只讀）
pub fn user_settings_path(home: &Path) -> PathBuf {
    home.join(".gemini").join("antigravity-cli").join("settings.json")
}

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

/// 寫進 statusLine.command 的字串。Windows：加引號的 .cmd 路徑；其他：asn-cli 不在就印 Gemini
pub fn statusline_command(asn_cli: &str, cmd_path: &str, windows: bool) -> String {
    if windows {
        format!("\"{cmd_path}\"")
    } else {
        let q = sh_quote(asn_cli);
        format!("if [ -x {q} ]; then {q} gemini-quota; else echo Gemini; fi")
    }
}

/// 使用者設定（只讀的原文，可能沒有）＋我們的狀態列 → 這次 session 的設定。
/// 使用者設定是 JSON 物件就整份保留（順序不變），只換掉 statusLine；不是物件或壞掉就只放 statusLine。
/// 原本的 statusLine 只留 padding（使用者自己的空行設定），其他換成我們的；stack_with_default 讓 agy 內建的那行照樣顯示。
pub fn session_settings(user_text: Option<&str>, command: &str) -> Value {
    let mut obj: Map<String, Value> = user_text
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();
    let padding = obj.get("statusLine").and_then(|s| s.get("padding")).and_then(Value::as_u64).filter(|p| *p <= 10);
    let mut sl = json!({ "type": "command", "command": command, "enabled": true, "stack_with_default": true });
    if let Some(p) = padding {
        sl["padding"] = json!(p);
    }
    obj.insert("statusLine".into(), sl);
    Value::Object(obj)
}

fn read_user_settings(home: &Path) -> Option<String> {
    let p = user_settings_path(home);
    let meta = std::fs::metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > MAX_USER_SETTINGS {
        return None;
    }
    std::fs::read_to_string(&p).ok()
}

fn write_if_changed(p: &Path, text: &str) -> Result<(), String> {
    if std::fs::read_to_string(p).ok().as_deref() == Some(text) {
        return Ok(());
    }
    crate::claude_json::write_atomic(p, text.as_bytes()).map_err(|e| format!("無法寫入 {}：{e}", p.display()))
}

/// 準備這次 session 的設定檔，回 agy 要多帶的參數（`--settings <檔>`）。
/// 只寫 ASN 自己的資料夾（.cmd 與設定檔）；使用者的 agy 設定只讀。
pub fn prepare(home: &Path, asn_home: &Path, asn_cli: &Path, windows: bool) -> Result<Vec<String>, String> {
    let cli = asn_cli.to_string_lossy().into_owned();
    if !path_ok(&cli, windows) {
        return Err("asn-cli 的路徑含有不能放進指令的字元，這次不接 Gemini 狀態列".into());
    }
    let cmd_path = asn_home.join(CMD_FILE);
    let cmd_str = cmd_path.to_string_lossy().into_owned();
    if windows {
        if !path_ok(&cmd_str, true) {
            return Err("ASN 資料夾的路徑含有不能放進指令的字元，這次不接 Gemini 狀態列".into());
        }
        write_if_changed(&cmd_path, &cmd_script(&cli))?;
    }
    let settings = session_settings(read_user_settings(home).as_deref(), &statusline_command(&cli, &cmd_str, windows));
    let out = asn_home.join(SETTINGS_FILE);
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
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
    match prepare(&crate::identity::home_dir(), &crate::identity::relay_home(), &cli, cfg!(windows)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Gemini 狀態列：{e}");
            vec![]
        }
    }
}

#[cfg(test)]
mod tests;
