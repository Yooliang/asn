//! 額度一鍵接上（#228）：把 `asn claude-quota --chain` 接到 Claude Code 的狀態列，讓電腦記得目前帳號的剩餘額度。
//! 這是 ASN 第一次修改別的程式（Claude Code）的設定檔，所以：
//!   - 預設不接，只有使用者在設定頁按「確認接上」才動；
//!   - 只改 `~/.claude/settings.json` 的 `statusLine.command` 這一個欄位，其他鍵與順序原樣保留（serde_json 開了 preserve_order）；
//!   - 原本的狀態列指令存在 `<ASN 資料夾>/statusline-orig.sh`，`--chain` 與「找不到 asn-cli」的退路都執行它；
//!   - 寫入走「暫存檔再改名」，寫完讀回核對，不一致就用 `.asn-bak` 還原；
//!   - 取消接上只在指令還是我們寫的那一條時才還原，使用者或別的工具後來改過就不動它。
//! 純檔案邏輯，路徑都由呼叫端傳入，測試用暫存資料夾。
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use crate::nowin::NoWindow;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 我們寫進 statusLine.command 的指令都含這段，用來認出「是我們接的」
const MARK: &str = "claude-quota --chain";
pub const CHAIN_TIMEOUT: Duration = Duration::from_secs(2);
pub const CHAIN_OUT_MAX: usize = 4096;

pub fn settings_path(claude_home: &Path) -> PathBuf {
    claude_home.join(".claude").join("settings.json")
}
fn bak_path(claude_home: &Path) -> PathBuf {
    claude_home.join(".claude").join("settings.json.asn-bak")
}
pub fn orig_path(asn_home: &Path) -> PathBuf {
    asn_home.join("statusline-orig.sh")
}
fn fwd(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// 寫進 statusLine.command 的指令：asn-cli 在就跑它（它會記額度、再跑原指令）；不在（例如已解除安裝）就直接跑存好的原指令。
/// 路徑一律用正斜線並加雙引號，bash 與 cmd 都認。
pub fn command_for(asn_cli: &Path, asn_home: &Path) -> String {
    let cli = fwd(asn_cli);
    format!(
        "if [ -f \"{cli}\" ]; then \"{cli}\" {MARK}; elif [ -f \"{o}\" ]; then bash \"{o}\"; fi",
        o = fwd(&orig_path(asn_home))
    )
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// off＝沒接；on＝已接且是這一版 asn-cli；stale＝是我們接的但路徑對不上（搬過或更新過）；blocked＝狀態列不是指令型，不敢動
    pub state: String,
    /// 目前的狀態列指令（截短到 160 字，只給畫面看）
    pub current: String,
    /// 有沒有原本的狀態列可以串接／還原
    pub has_original: bool,
}

fn short(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if t.chars().count() > 160 {
        format!("{}…", t.chars().take(160).collect::<String>())
    } else {
        t
    }
}

fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => {
            let v: Value = serde_json::from_str(&t).map_err(|_| "settings.json 不是合法的 JSON，沒有動它".to_string())?;
            if v.is_object() {
                Ok(v)
            } else {
                Err("settings.json 不是物件，沒有動它".into())
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("讀不到 settings.json：{e}")),
    }
}

fn command_of(v: &Value) -> Option<&str> {
    v.get("statusLine")?.get("command")?.as_str()
}

pub fn status(claude_home: &Path, asn_home: &Path, asn_cli: &Path) -> Status {
    let has_original = orig_path(asn_home).is_file();
    let Ok(v) = read_settings(&settings_path(claude_home)) else {
        return Status { state: "blocked".into(), current: String::new(), has_original };
    };
    let sl = v.get("statusLine");
    if let Some(sl) = sl {
        if sl.get("type").and_then(Value::as_str).is_some_and(|t| t != "command") || command_of(&v).is_none() {
            return Status { state: "blocked".into(), current: String::new(), has_original };
        }
    }
    let cur = command_of(&v).unwrap_or("");
    let state = if cur == command_for(asn_cli, asn_home) {
        "on"
    } else if cur.contains(MARK) {
        "stale"
    } else {
        "off"
    };
    Status { state: state.into(), current: short(cur), has_original }
}

fn write_checked(path: &Path, bak: &Path, new: &Value, expect_cmd: Option<&str>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(new).map_err(|e| e.to_string())?;
    crate::claude_json::write_atomic(path, text.as_bytes()).map_err(|e| format!("寫入 settings.json 失敗：{e}"))?;
    // 寫完讀回核對：statusLine.command 要是預期的，其他鍵一個都不能少
    let back = read_settings(path);
    let ok = match &back {
        Ok(b) => {
            command_of(b) == expect_cmd
                && new.as_object().is_some_and(|n| n.keys().filter(|k| *k != "statusLine").all(|k| b.get(k) == new.get(k)))
        }
        Err(_) => false,
    };
    if !ok {
        if let Ok(old) = std::fs::read(bak) {
            let _ = crate::claude_json::write_atomic(path, &old);
        }
        return Err("寫完核對不一致（可能同時有別的程式在改），已還原成原來的內容".into());
    }
    Ok(())
}

/// 使用者按了「確認接上」。回 Ok 表示已接上（或本來就接著）。
pub fn connect(claude_home: &Path, asn_home: &Path, asn_cli: &Path) -> Result<(), String> {
    let path = settings_path(claude_home);
    let mut v = read_settings(&path)?;
    let ours = command_for(asn_cli, asn_home);
    let cur = command_of(&v).map(str::to_string);
    if cur.as_deref() == Some(ours.as_str()) {
        return Ok(());
    }
    if let Some(sl) = v.get("statusLine") {
        if sl.get("type").and_then(Value::as_str).is_some_and(|t| t != "command") || cur.is_none() {
            return Err("目前的狀態列不是『執行指令』型，ASN 不敢改它".into());
        }
    }
    // 備份：原設定檔另存一份；原狀態列指令存成 .sh（我們自己的舊指令＝路徑變了，不覆蓋已存好的原指令）
    if path.exists() {
        std::fs::copy(&path, bak_path(claude_home)).map_err(|e| format!("備份 settings.json 失敗：{e}"))?;
    }
    let was_ours = cur.as_deref().is_some_and(|c| c.contains(MARK));
    if let (Some(c), false) = (cur.as_deref(), was_ours) {
        crate::claude_json::write_atomic(&orig_path(asn_home), c.as_bytes()).map_err(|e| format!("備份原狀態列失敗：{e}"))?;
    } else if !was_ours {
        let _ = std::fs::remove_file(orig_path(asn_home));   // 原本沒有狀態列：不留舊的原指令
    }
    let obj = v.as_object_mut().ok_or("settings.json 不是物件")?;
    match obj.get_mut("statusLine").and_then(Value::as_object_mut) {
        Some(sl) => {
            sl.insert("command".into(), Value::String(ours.clone()));
            sl.entry("type").or_insert_with(|| Value::String("command".into()));
        }
        None => {
            obj.insert("statusLine".into(), json!({ "type": "command", "command": ours }));
        }
    }
    write_checked(&path, &bak_path(claude_home), &v, Some(ours.as_str()))
}

/// 使用者按了「取消接上」。只有指令還是我們寫的才動；有原指令就還原，沒有就把 statusLine 整個拿掉。
pub fn disconnect(claude_home: &Path, asn_home: &Path) -> Result<(), String> {
    let path = settings_path(claude_home);
    let mut v = read_settings(&path)?;
    let Some(cur) = command_of(&v).map(str::to_string) else { return Err("狀態列已經不是 ASN 接的，沒有動它".into()) };
    if !cur.contains(MARK) {
        return Err("狀態列已經不是 ASN 接的（可能被你或別的工具改過），沒有動它".into());
    }
    let orig = std::fs::read_to_string(orig_path(asn_home)).ok();
    if path.exists() {
        std::fs::copy(&path, bak_path(claude_home)).map_err(|e| format!("備份 settings.json 失敗：{e}"))?;
    }
    let obj = v.as_object_mut().ok_or("settings.json 不是物件")?;
    let expect: Option<String> = match orig {
        Some(o) => {
            if let Some(sl) = obj.get_mut("statusLine").and_then(Value::as_object_mut) {
                sl.insert("command".into(), Value::String(o.clone()));
            }
            Some(o)
        }
        None => {
            obj.shift_remove("statusLine");
            None
        }
    };
    write_checked(&path, &bak_path(claude_home), &v, expect.as_deref())?;
    let _ = std::fs::remove_file(orig_path(asn_home));
    Ok(())
}

/// 跑原指令的 shell：先找 Windows 上 Git 的固定位置（PATH 上的 bash 在 Windows 可能是 WSL 的 System32ash.exe，不能先用它），
/// 再看 PATH 上的 bash（從 Claude 的 bash 叫起來時 PATH 上就是 Git 的），最後 sh。
fn shell_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            let git = if var == "LOCALAPPDATA" { base.join("Programs").join("Git") } else { base.join("Git") };
            v.push(git.join("bin").join("bash.exe"));
            v.push(git.join("usr").join("bin").join("bash.exe"));
        }
    }
    v.push(PathBuf::from("bash"));
    v.push(PathBuf::from("sh"));
    v
}

/// `--chain` 的後半：把同一份標準輸入餵給存好的原指令，最多等 CHAIN_TIMEOUT、輸出最多 CHAIN_OUT_MAX。
/// 回 (輸出, 結束碼)；沒有原指令、跑不起來、逾時都回已讀到的部分與 0——絕不讓狀態列壞掉。
pub fn run_original(asn_home: &Path, input: &[u8]) -> (Vec<u8>, i32) {
    let script = orig_path(asn_home);
    if !script.is_file() {
        return (Vec::new(), 0);
    }
    let spawn = |prog: &Path| Command::new(prog).no_window().arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
    let Some(mut child) = shell_candidates().iter().find_map(|p| spawn(p).ok()) else { return (Vec::new(), 0) };
    if let Some(mut si) = child.stdin.take() {
        let data = input.to_vec();
        std::thread::spawn(move || {
            let _ = si.write_all(&data);
        });
    }
    // 輸出邊讀邊放進共用緩衝；逾時砍掉子程序後不等讀取執行緒（孫程序可能還握著管線），直接拿目前讀到的
    let shared = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let mut so = child.stdout.take();
    let sink = shared.clone();
    std::thread::spawn(move || {
        if let Some(s) = so.as_mut() {
            let mut buf = [0u8; 1024];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut g = sink.lock().unwrap_or_else(|e| e.into_inner());
                        let room = CHAIN_OUT_MAX.saturating_sub(g.len());
                        g.extend_from_slice(&buf[..n.min(room)]);
                        if g.len() >= CHAIN_OUT_MAX {
                            break;
                        }
                    }
                }
            }
        }
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(0),
            Ok(None) if start.elapsed() < CHAIN_TIMEOUT => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                break 0;
            }
        }
    };
    std::thread::sleep(Duration::from_millis(20));   // 讓讀取執行緒把管線裡剩下的搬進緩衝
    let out = shared.lock().unwrap_or_else(|e| e.into_inner()).clone();
    (out, code)
}

#[cfg(feature = "gui")]
pub(crate) fn asn_cli_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|d| d.join(if cfg!(windows) { "asn-cli.exe" } else { "asn-cli" })).unwrap_or_default()
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_quota_hook_status() -> Status {
    #[cfg(feature = "gui")]
    {
        status(&crate::claude_accounts::claude_home(), &crate::identity::relay_home(), &asn_cli_path())
    }
    #[cfg(not(feature = "gui"))]
    {
        Status { state: "off".into(), current: String::new(), has_original: false }
    }
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_quota_hook_connect() -> Result<Status, String> {
    #[cfg(feature = "gui")]
    {
        connect(&crate::claude_accounts::claude_home(), &crate::identity::relay_home(), &asn_cli_path())?;
        Ok(claude_quota_hook_status())
    }
    #[cfg(not(feature = "gui"))]
    {
        Err("這個版本沒有這個功能".into())
    }
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_quota_hook_disconnect() -> Result<Status, String> {
    #[cfg(feature = "gui")]
    {
        disconnect(&crate::claude_accounts::claude_home(), &crate::identity::relay_home())?;
        Ok(claude_quota_hook_status())
    }
    #[cfg(not(feature = "gui"))]
    {
        Err("這個版本沒有這個功能".into())
    }
}

#[cfg(test)]
mod tests;
