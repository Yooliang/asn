use super::PartnerConsoleReq;
use crate::agent_tools::resolve_binary;
use serde_json::{json, Value};
use std::process::Command;

pub fn partner_console_query(req: PartnerConsoleReq) -> Result<Value, String> {
    Ok(json!(query_console(&req.engine, &req.name)?))
}

pub fn partner_console_set(req: PartnerConsoleReq) -> Result<Value, String> {
    let vis = req.visible.unwrap_or(true);
    set_console_visible(&req.engine, &req.name, vis)
}

#[derive(serde::Serialize)]
struct ConsoleQuery {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_toggle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hwnd: Option<i64>,
}

fn query_console(engine: &str, name: &str) -> Result<ConsoleQuery, String> {
    if name.is_empty() {
        return Ok(ConsoleQuery {
            ok: false,
            can_toggle: None,
            visible: None,
            reason: Some("缺少名字".into()),
            pid: None,
            hwnd: None,
        });
    }
    #[cfg(not(windows))]
    {
        return Ok(ConsoleQuery {
            ok: true,
            can_toggle: Some(false),
            visible: None,
            reason: Some("僅 Windows 可切換主控台視窗".into()),
            pid: None,
            hwnd: None,
        });
    }
    #[cfg(windows)]
    {
        let pid = if engine == "claude" || engine.is_empty() {
            resolve_claude_pid_by_name(name)
        } else {
            None
        };
        let Some(pid) = pid else {
            return Ok(ConsoleQuery {
                ok: true,
                can_toggle: Some(false),
                visible: None,
                reason: Some("找不到這個夥伴的主控台視窗".into()),
                pid: None,
                hwnd: None,
            });
        };
        let Some(w) = find_console_hwnd_win32(pid) else {
            return Ok(ConsoleQuery {
                ok: true,
                can_toggle: Some(false),
                visible: None,
                reason: Some("找不到這個夥伴的主控台視窗".into()),
                pid: Some(pid),
                hwnd: None,
            });
        };
        Ok(ConsoleQuery {
            ok: true,
            can_toggle: Some(true),
            visible: Some(w.visible),
            reason: None,
            pid: Some(pid),
            hwnd: Some(w.hwnd),
        })
    }
}

fn set_console_visible(engine: &str, name: &str, visible: bool) -> Result<Value, String> {
    let q = query_console(engine, name)?;
    if q.can_toggle != Some(true) || q.hwnd.is_none() {
        return Ok(json!({ "ok": false, "reason": q.reason.unwrap_or_else(|| "無法切換".into()) }));
    }
    #[cfg(not(windows))]
    {
        return Ok(json!({ "ok": false, "reason": "僅 Windows 可切換主控台視窗" }));
    }
    #[cfg(windows)]
    {
        let hwnd = q.hwnd.unwrap();
        let pid = q.pid.unwrap();
        set_console_visible_win32(hwnd, visible)?;
        let after = find_console_hwnd_win32(pid);
        Ok(json!({ "ok": true, "visible": after.map(|w| w.visible).unwrap_or(visible) }))
    }
}

#[cfg(windows)]
struct WinConsole {
    hwnd: i64,
    visible: bool,
}

#[cfg(windows)]
fn resolve_claude_pid_by_name(name: &str) -> Option<u32> {
    let bin = resolve_binary("claude")?;
    let out = Command::new(&bin)
        .args(["agents", "--json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let list: Value = serde_json::from_slice(&out.stdout).ok()?;
    let hit = list.as_array()?.iter().find(|a| a.get("name").and_then(Value::as_str) == Some(name) && a.get("kind").and_then(Value::as_str) == Some("interactive"))?;
    let pid = hit.get("pid").and_then(Value::as_u64)? as u32;
    if !pid_alive(pid) {
        return None;
    }
    Some(pid)
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
    }
}

#[cfg(windows)]
fn find_console_hwnd_win32(pid: u32) -> Option<WinConsole> {
    let ps = format!(
        r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Cw {{
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static IntPtr Find(uint target) {{
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {{
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != target) return true;
      var sb = new StringBuilder(64);
      GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "ConsoleWindowClass") {{ found = h; return false; }}
      return true;
    }}, IntPtr.Zero);
    return found;
  }}
  public static bool Vis(IntPtr h) {{ return h != IntPtr.Zero && IsWindowVisible(h); }}
}}
"@
$pid = {pid}
$h = [Cw]::Find([uint32]$pid)
if ($h -eq [IntPtr]::Zero) {{ exit 2 }}
$vis = [Cw]::Vis($h)
Write-Output ("{{0}}|{{1}}" -f $h.ToInt64(), $(if ($vis) {{ '1' }} else {{ '0' }}))
"#
    );
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let ps_exe = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let out = Command::new(&ps_exe)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (hs, vs) = raw.split_once('|')?;
    Some(WinConsole {
        hwnd: hs.parse().ok()?,
        visible: vs == "1",
    })
}

#[cfg(windows)]
fn set_console_visible_win32(hwnd: i64, visible: bool) -> Result<(), String> {
    let show = if visible { 5 } else { 0 };
    let fg = if visible { 1 } else { 0 };
    let ps = format!(
        r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cw {{
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}}
"@
$h = [IntPtr]::new({hwnd})
[Cw]::ShowWindow($h, {show}) | Out-Null
if ({fg} -eq 1) {{ [Cw]::SetForegroundWindow($h) | Out-Null }}
"#
    );
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let ps_exe = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let st = Command::new(&ps_exe)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if st.status.success() {
        Ok(())
    } else {
        Err("ShowWindow 失敗".into())
    }
}
