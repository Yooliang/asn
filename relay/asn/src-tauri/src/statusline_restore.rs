//! 狀態列還原（#1883）：舊版 ASN 為了記額度，在 `~/.claude/settings.json` 的 `statusLine.command` 接了一條
//! `asn-cli claude-quota --chain`。額度改成直接向 Claude 查之後這條不再需要，升級後啟動時把它還原成原本的狀態列。
//! - 只動「指令裡帶 ASN 寫入的記號（`MARK`）」的那一條；使用者或別的工具後來改過的一律不碰。
//! - 還原前先把 settings.json 備份成 `settings.json.asn-bak`；寫完讀回核對，不一致就用備份還原；任何一步失敗都保留原狀並回錯誤（呼叫端寫 log）。
//! - 原本的狀態列指令存在 `<ASN 資料夾>/statusline-orig.sh`：有就寫回，沒有就把 statusLine 整個拿掉。該檔保留一版，下一版再清。
//! - 還沒還原成功之前，`asn-cli claude-quota --chain` 仍要能把原指令串起來（`run_original`），狀態列不能因為升級而壞掉。
//! 純檔案邏輯，路徑都由呼叫端傳入，測試用暫存資料夾，絕不碰真的 `~/.claude/settings.json`。
use crate::nowin::NoWindow;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 舊版寫進 statusLine.command 的指令都含這段，用來認出「是 ASN 接的」
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

/// 還原的結果
#[derive(Debug, PartialEq, Eq)]
pub enum Restored {
    /// 沒有 ASN 接的狀態列，什麼都沒動
    Nothing,
    /// 已還原成原本的狀態列（有原指令）或拿掉（原本就沒有）
    Done,
}

fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(serde_json::json!({})),
        Ok(t) => {
            let v: Value = serde_json::from_str(&t).map_err(|_| "settings.json 不是合法的 JSON，沒有動它".to_string())?;
            if v.is_object() {
                Ok(v)
            } else {
                Err("settings.json 不是物件，沒有動它".into())
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("讀不到 settings.json：{e}")),
    }
}

fn command_of(v: &Value) -> Option<&str> {
    v.get("statusLine")?.get("command")?.as_str()
}

fn write_checked(path: &Path, bak: &Path, new: &Value, expect_cmd: Option<&str>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(new).map_err(|e| e.to_string())?;
    crate::settings::atomic::write(path, text.as_bytes(), crate::settings::atomic::SETTINGS).map_err(|e| format!("寫入 settings.json 失敗：{e}"))?;
    // 寫完讀回核對：statusLine.command 要是預期的，其他鍵一個都不能少
    let ok = match read_settings(path) {
        Ok(b) => command_of(&b) == expect_cmd && new.as_object().is_some_and(|n| n.keys().filter(|k| *k != "statusLine").all(|k| b.get(k) == new.get(k))),
        Err(_) => false,
    };
    if !ok {
        if let Ok(old) = std::fs::read(bak) {
            // 還原備份失敗也只能回錯誤：呼叫端會寫 log，備份檔還在
            let _ = crate::settings::atomic::write(path, &old, crate::settings::atomic::SETTINGS);
        }
        return Err("寫完核對不一致（可能同時有別的程式在改），已還原成原來的內容".into());
    }
    Ok(())
}

/// 升級時還原：只有指令還是 ASN 寫的那一條才動。失敗時 settings.json 保持原狀。
pub fn restore(claude_home: &Path, asn_home: &Path) -> Result<Restored, String> {
    let path = settings_path(claude_home);
    let mut v = read_settings(&path)?;
    let Some(cur) = command_of(&v).map(str::to_string) else { return Ok(Restored::Nothing) };
    if !cur.contains(MARK) {
        return Ok(Restored::Nothing);
    }
    // 先備份，備份不成功就不動
    std::fs::copy(&path, bak_path(claude_home)).map_err(|e| format!("備份 settings.json 失敗，沒有動它：{e}"))?;
    let orig = std::fs::read_to_string(orig_path(asn_home)).ok().filter(|o| !o.trim().is_empty());
    let obj = v.as_object_mut().ok_or("settings.json 不是物件")?;
    match &orig {
        Some(o) => {
            if let Some(sl) = obj.get_mut("statusLine").and_then(Value::as_object_mut) {
                sl.insert("command".into(), Value::String(o.clone()));
            }
        }
        None => {
            obj.shift_remove("statusLine");
        }
    }
    write_checked(&path, &bak_path(claude_home), &v, orig.as_deref())?;
    Ok(Restored::Done)
}

/// 跑原指令的 shell：先找 Windows 上 Git 的固定位置（PATH 上的 bash 在 Windows 可能是 WSL 的 bash.exe，不能先用它），
/// 再看 PATH 上的 bash，最後 sh。
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

/// `asn claude-quota --chain` 的剩下用途：把同一份標準輸入餵給存好的原指令，最多等 CHAIN_TIMEOUT、輸出最多 CHAIN_OUT_MAX。
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
    std::thread::sleep(Duration::from_millis(20)); // 讓讀取執行緒把管線裡剩下的搬進緩衝
    let out = shared.lock().unwrap_or_else(|e| e.into_inner()).clone();
    (out, code)
}

#[cfg(feature = "gui")]
pub(crate) fn asn_cli_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|d| d.join(if cfg!(windows) { "asn-cli.exe" } else { "asn-cli" })).unwrap_or_default()
}

/// 啟動時呼叫一次：用真實的家目錄還原，回要寫進 log 的一行（沒有要還原的回 None）。只有背景啟動流程會呼叫，測試不得呼叫。
#[cfg(feature = "gui")]
pub fn restore_on_start() -> Option<String> {
    match restore(&crate::claude_accounts::claude_home(), &crate::identity::relay_home()) {
        Ok(Restored::Nothing) => None,
        Ok(Restored::Done) => Some("額度回報不再需要接在 Claude 的狀態列上，已把狀態列還原成原本的（備份在 settings.json.asn-bak）".into()),
        Err(e) => Some(format!("狀態列還原失敗，保留原狀：{e}")),
    }
}

#[cfg(test)]
mod tests;
