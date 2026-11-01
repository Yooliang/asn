//! 對話中切換模型（含使用者自己開的 Claude 視窗）：
//! 讀 `~/.claude/sessions/<pid>.json`（pid、sessionId、cwd、name、status）＋該 pid 的啟動參數（Win32 直接讀程序記憶體，
//! 不啟動 powershell／wmic），目前模型從 `--model` 判斷；切換＝結束那一個已確認的 pid，照原參數重開
//! （去掉舊的 --model／--resume／--continue／-n，加 --resume <sessionId> --model <新模型> -n <名字>），
//! 再確認舊 pid 已消失、新工作階段出現且名字相同才算成功。
//!
//! 作業系統相關動作（讀命令列、列程序、結束、送關閉訊息）都收在 `Os` 介面後面，
//! 單元測試用假的實作驗證流程與守門，真機手動測試用假主控台程式（見最下面的 #[ignore] 測試）。
use super::{console, local};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- 純邏輯：命令列

/// 依 Windows 的 CommandLineToArgvW 規則切開命令列（引號、反斜線連續字元、`""` 規則）。
pub(crate) fn parse_cmdline(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    // 第一個參數（程式路徑）規則較單純：有引號就取到下一個引號，否則取到空白，反斜線不當跳脫
    while i < n && (chars[i] == ' ' || chars[i] == '\t') {
        i += 1;
    }
    if i >= n {
        return out;
    }
    let mut first = String::new();
    if chars[i] == '"' {
        i += 1;
        while i < n && chars[i] != '"' {
            first.push(chars[i]);
            i += 1;
        }
        if i < n {
            i += 1;
        }
    } else {
        while i < n && chars[i] != ' ' && chars[i] != '\t' {
            first.push(chars[i]);
            i += 1;
        }
    }
    out.push(first);
    loop {
        while i < n && (chars[i] == ' ' || chars[i] == '\t') {
            i += 1;
        }
        if i >= n {
            break;
        }
        let mut arg = String::new();
        let mut in_quote = false;
        while i < n {
            let c = chars[i];
            if c == '\\' {
                let mut bs = 0;
                while i < n && chars[i] == '\\' {
                    bs += 1;
                    i += 1;
                }
                if i < n && chars[i] == '"' {
                    arg.extend(std::iter::repeat('\\').take(bs / 2));
                    if bs % 2 == 1 {
                        arg.push('"');
                        i += 1;
                    }
                    // 偶數個反斜線：引號本身留給下一輪當作開關
                } else {
                    arg.extend(std::iter::repeat('\\').take(bs));
                }
                continue;
            }
            if c == '"' {
                if in_quote && i + 1 < n && chars[i + 1] == '"' {
                    arg.push('"');
                    i += 2;
                    continue;
                }
                in_quote = !in_quote;
                i += 1;
                continue;
            }
            if !in_quote && (c == ' ' || c == '\t') {
                break;
            }
            arg.push(c);
            i += 1;
        }
        out.push(arg);
    }
    out
}

pub(crate) fn exe_stem(p: &str) -> String {
    let base = p.rsplit(['\\', '/']).next().unwrap_or(p).to_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

/// 程式本身佔幾個參數：`claude.exe` 是 1；`node [旗標…] cli.js` 要連腳本一起算。
pub(crate) fn program_len(args: &[String]) -> usize {
    if args.is_empty() {
        return 0;
    }
    let stem = exe_stem(&args[0]);
    if stem == "node" || stem == "bun" {
        let mut i = 1;
        while i < args.len() && args[i].starts_with('-') {
            i += 1;
        }
        return (i + 1).min(args.len());
    }
    1
}

/// 這條命令列看起來是不是 Claude Code 本體（守門：不是就不碰）。
pub(crate) fn looks_like_claude(args: &[String]) -> bool {
    let Some(first) = args.first() else { return false };
    let stem = exe_stem(first);
    if stem == "claude" {
        return true;
    }
    if stem == "node" || stem == "bun" {
        return args[1..program_len(args)].iter().any(|a| a.to_lowercase().contains("claude"));
    }
    false
}

/// 外殼包著的 Claude（#622）：`powershell`／`pwsh` 的 `-Command`（或 `-c`）、`cmd` 的 `/c`（或 `/k`）後面，第一個指令是 claude（或 claude.exe 的完整路徑）。
/// 只用來決定對照表記的種類，不改使用者的啟動設定；守門（要不要碰這個程序）仍用 [`looks_like_claude`]，不放寬。
/// `cd x; claude` 不算：第一個指令不是 claude。
pub(crate) fn wraps_claude(args: &[String]) -> bool {
    let Some(first) = args.first() else { return false };
    let flags: &[&str] = match exe_stem(first).as_str() {
        "powershell" | "pwsh" => &["-command", "-c"],
        "cmd" => &["/c", "/k"],
        _ => return false,
    };
    let Some(at) = args.iter().skip(1).position(|a| flags.contains(&a.to_lowercase().as_str())) else { return false };
    let script = args[at + 2..].join(" ");
    first_command(&script).is_some_and(|c| exe_stem(&c) == "claude")
}

/// 一段指令字串的第一個指令：略過開頭的呼叫符號 `&`，引號包住的整段算一個（路徑可含空白），沒引號的到空白或分號為止
fn first_command(script: &str) -> Option<String> {
    let t = script.trim_start().trim_start_matches('&').trim_start();
    let mut chars = t.chars();
    let first = chars.next()?;
    if first == '"' || first == '\'' {
        let rest: String = chars.collect();
        return rest.find(first).map(|i| rest[..i].to_string()).filter(|c| !c.is_empty());
    }
    let end = t.find(|c: char| c.is_whitespace() || c == ';').unwrap_or(t.len());
    Some(t[..end].to_string()).filter(|c| !c.is_empty())
}

/// 目前模型：最後一個 `--model <值>` 或 `--model=<值>`；沒有就是 None（顯示「預設」）。
pub(crate) fn current_model(args: &[String]) -> Option<String> {
    let rest = &args[program_len(args).min(args.len())..];
    let mut found = None;
    let mut i = 0;
    while i < rest.len() {
        let a = &rest[i];
        if a == "--" {
            break;
        }
        if a == "--model" {
            if let Some(v) = rest.get(i + 1) {
                found = Some(v.clone());
                i += 2;
                continue;
            }
        } else if let Some(v) = a.strip_prefix("--model=") {
            found = Some(v.to_string());
        }
        i += 1;
    }
    found.filter(|m| !m.is_empty())
}

/// 模型名稱可接受的字元（別名如 opus、完整名稱如 claude-opus-4-5、帶 [1m] 之類後綴）。
pub(crate) fn valid_model(m: &str) -> bool {
    !m.is_empty()
        && m.chars().count() <= 64
        && !m.starts_with('-')
        && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '[' | ']' | '-' | '/'))
}

/// 照原參數重開用的新參數（含程式本身）：去掉舊的 --model／--resume／-r／--continue／-c／-n／--name／
/// --session-id／--fork-session，在程式後面插入 `-n <名字> --resume <sessionId> --model <新模型>`；其餘參數原樣保留。
/// 名字是空的就不加 -n（也不把舊的 -n 帶回來，因為舊的 -n 可能已被 /rename 改掉）。
pub(crate) fn rewrite_args(args: &[String], session_id: &str, name: &str, model: &str) -> Vec<String> {
    rewrite_args_opts(args, Some(session_id), name, Some(model), None)
}

/// `rewrite_args` 的通用版（遠端管理夥伴視窗用）：session_id＝None 不接續（開新對話）；model＝None 不指定模型；
/// prompt＝Some 時，原本 `--` 之後的內容丟掉，換成 `-- <prompt>`（第一句話）。其餘行為與 `rewrite_args` 完全相同。
pub(crate) fn rewrite_args_opts(args: &[String], session_id: Option<&str>, name: &str, model: Option<&str>, prompt: Option<&str>) -> Vec<String> {
    let plen = program_len(args).min(args.len());
    let rest = &args[plen..];
    let mut kept: Vec<String> = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let a = rest[i].as_str();
        if a == "--" {
            kept.extend(rest[i..].iter().cloned());
            break;
        }
        match a {
            "--model" | "-n" | "--name" | "--session-id" => {
                i += if i + 1 < rest.len() { 2 } else { 1 };
                continue;
            }
            "--resume" | "-r" => {
                i += 1;
                if i < rest.len() && !rest[i].starts_with('-') {
                    i += 1;
                }
                continue;
            }
            "--continue" | "-c" | "--fork-session" => {
                i += 1;
                continue;
            }
            _ => {}
        }
        if a.starts_with("--model=") || a.starts_with("--name=") || a.starts_with("--resume=") || a.starts_with("--session-id=") {
            i += 1;
            continue;
        }
        kept.push(rest[i].clone());
        i += 1;
    }
    let mut out: Vec<String> = args[..plen].to_vec();
    if !name.is_empty() {
        out.push("-n".into());
        out.push(name.into());
    }
    if let Some(sid) = session_id {
        out.push("--resume".into());
        out.push(sid.into());
    }
    if let Some(m) = model {
        out.push("--model".into());
        out.push(m.into());
    }
    if let Some(p) = prompt {
        if let Some(i) = kept.iter().position(|a| a == "--") {
            kept.truncate(i);
        }
        kept.push("--".into());
        kept.push(p.into());
    }
    out.extend(kept);
    out
}

/// 閒置判斷：只有工作階段記錄的 status 明確是 idle 才算（缺欄位、busy、waiting 一律不算）。
pub(crate) fn is_idle(status: Option<&str>) -> bool {
    status.map(|s| s.trim().eq_ignore_ascii_case("idle")).unwrap_or(false)
}

/// 工作資料夾正規化：去掉 Windows 的 \\?\ 前綴與尾端斜線（磁碟根目錄 C:\ 保留）。比對用，不改大小寫
pub(crate) fn normalize_cwd(p: &str) -> String {
    let t = p.trim().trim_start_matches(r"\\?\");
    let trimmed = t.trim_end_matches(['\\', '/']);
    // 只剩磁碟機代號（C:）＝根目錄，補回一條斜線
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        return format!("{trimmed}\\");
    }
    trimmed.to_string()
}

/// 可複製的手動重開指令（PowerShell）：不依賴我們自己，使用者貼進終端機就能接續對話。
pub(crate) fn manual_command(cwd: &str, argv: &[String]) -> String {
    let call = argv.iter().enumerate().map(|(i, a)| if i == 0 { format!("& {}", local::ps_quote(a)) } else { local::ps_quote(a) }).collect::<Vec<_>>().join(" ");
    format!("Set-Location -LiteralPath {}; {}", local::ps_quote(cwd), call)
}

/// 這條命令列是不是 ASN 自己開視窗時用的承載 PowerShell（-NoExit -EncodedCommand，腳本裡有結束提示）。
pub(crate) fn is_asn_host_cmdline(line: &str) -> bool {
    let args = parse_cmdline(line);
    let Some(i) = args.iter().position(|a| a.eq_ignore_ascii_case("-EncodedCommand")) else { return false };
    let Some(enc) = args.get(i + 1) else { return false };
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(enc) else { return false };
    let u: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16(&u).map(|s| s.contains("[ASN] 程式已結束")).unwrap_or(false)
}

// ---------------------------------------------------------------- 程序表與守門

#[derive(Clone, Debug)]
pub(crate) struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// 小寫的執行檔名，例如 windowsterminal.exe
    pub name: String,
}

pub(crate) fn parent_of(table: &[Proc], pid: u32) -> Option<&Proc> {
    let ppid = table.iter().find(|p| p.pid == pid)?.ppid;
    table.iter().find(|p| p.pid == ppid && p.pid != pid)
}

pub(crate) fn ancestors(table: &[Proc], pid: u32) -> Vec<u32> {
    let mut v = Vec::new();
    let mut cur = pid;
    while let Some(p) = parent_of(table, cur) {
        if v.contains(&p.pid) || v.len() > 32 {
            break;
        }
        v.push(p.pid);
        cur = p.pid;
    }
    v
}

/// 往上最多幾層內有沒有 Windows Terminal（有就代表這個 Claude 在 WT 分頁裡）
pub(crate) fn in_windows_terminal(table: &[Proc], pid: u32) -> bool {
    ancestors(table, pid).iter().take(6).any(|a| table.iter().any(|p| p.pid == *a && p.name == "windowsterminal.exe"))
}

/// 守門：算出「這次允許結束的 pid」。只含已確認的 root、它的後代（子先孫後）、以及（若有）它的直接父殼 `host`。
/// 永遠不含自己（ASN）、自己的祖先、pid 0／4，也不含其他同輩程序。
pub(crate) fn kill_set(table: &[Proc], root: u32, host: Option<u32>, own: u32) -> Vec<u32> {
    kill_set_with(table, root, host, own, &|_| None)
}

/// 同 `kill_set`，多一份建立時間：Windows 的程序表在父程序結束後不會清掉子程序的 ppid，舊 pid 被重用時，
/// 舊父親的孤兒會被誤當成新程序的後代。所以兩邊建立時間都查得到、而子程序比父程序早建立時，就不算後代（連同它底下的）。
/// 任何一邊查不到就維持原樣（只在能確認時才排除，不會因此多殺）。
pub(crate) fn kill_set_with(table: &[Proc], root: u32, host: Option<u32>, own: u32, started: &dyn Fn(u32) -> Option<u64>) -> Vec<u32> {
    let mut forbidden: HashSet<u32> = ancestors(table, own).into_iter().collect();
    forbidden.insert(own);
    forbidden.insert(0);
    forbidden.insert(4);
    if forbidden.contains(&root) {
        return Vec::new();
    }
    // 後代：廣度走訪，之後反過來（葉先）
    let mut order = vec![root];
    let mut idx = 0;
    while idx < order.len() {
        let cur = order[idx];
        for p in table.iter().filter(|p| p.ppid == cur && p.pid != cur) {
            if matches!((started(p.pid), started(cur)), (Some(c), Some(par)) if c < par) {
                continue; // 比父程序還早建立：是舊 pid 的孤兒，不是後代
            }
            if !order.contains(&p.pid) {
                order.push(p.pid);
            }
        }
        idx += 1;
    }
    order.reverse();
    let mut out: Vec<u32> = order.into_iter().filter(|p| !forbidden.contains(p)).collect();
    if let Some(h) = host {
        // 父殼只在真的是 root 的直接父親時才算
        if parent_of(table, root).map(|p| p.pid) == Some(h) && !forbidden.contains(&h) {
            out.push(h);
        }
    }
    out
}

// ---------------------------------------------------------------- 作業系統介面

pub(crate) trait Os {
    fn cmdline(&self, pid: u32) -> Option<String>;
    /// 程序目前的工作資料夾（只讀；讀不到＝None）。預設讀不到，現有的假 Os 不用改
    fn cwd(&self, _pid: u32) -> Option<String> {
        None
    }
    fn processes(&self) -> Vec<Proc>;
    fn alive(&self, pid: u32) -> bool;
    /// 程序的建立時間（Unix 毫秒），拿來分辨 pid 是不是被別的程序重用；查不到＝None（當同一個程序）
    fn started_ms(&self, _pid: u32) -> Option<u64> {
        None
    }
    /// 對該 pid 的主控台視窗送關閉訊息；有送出才回 true
    fn close_window(&self, pid: u32) -> bool;
    /// ASN 自己開的 WezTerm（對照表裡的）：（GUI 程序編號, 開的時候量到的建立時間）。預設沒有，現有的假 Os 不用改
    fn own_wez(&self) -> Vec<(u32, u64)> {
        Vec::new()
    }
    /// 收掉 ASN 自己開的某個 WezTerm GUI（裡面會再核對一次建立時間，對不上就不動）
    fn stop_wez(&self, _gui_pid: u32) -> Result<(), String> {
        Err("這台沒有 ASN 自帶的終端".into())
    }
    /// B2c：這個程序所在的共用終端服務（mux）裡的夥伴窗格，回對照表的終端編號。預設沒有，現有的假 Os 不用改
    fn mux_session_of(&self, _pid: u32) -> Option<String> {
        None
    }
    /// B2c：關共用 mux 裡的夥伴窗格（只關那個窗格＋收掉看它的 GUI，絕不動 mux 程序）
    fn stop_mux_session(&self, _id: &str) -> Result<(), String> {
        Err("這台沒有 ASN 的共用終端服務".into())
    }
    fn terminate(&self, pid: u32) -> Result<(), String>;
    fn own_pid(&self) -> u32 {
        std::process::id()
    }
    fn sleep(&self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Timing {
    pub close_grace_ms: u64,
    pub gone_wait_ms: u64,
    pub appear_wait_ms: u64,
    pub poll_ms: u64,
}

impl Timing {
    pub(crate) fn real() -> Self {
        Timing { close_grace_ms: 4000, gone_wait_ms: 6000, appear_wait_ms: 45000, poll_ms: 300 }
    }
}

pub(crate) fn wait_until(os: &dyn Os, total_ms: u64, poll_ms: u64, mut cond: impl FnMut() -> bool) -> bool {
    let t0 = Instant::now();
    loop {
        if cond() {
            return true;
        }
        if t0.elapsed() >= Duration::from_millis(total_ms) {
            return false;
        }
        os.sleep(poll_ms.max(1));
    }
}

// ---------------------------------------------------------------- 查詢與切換

#[derive(Deserialize)]
pub struct SwitchQueryReq {
    pub name: String,
}

#[derive(Deserialize)]
pub struct SwitchRunReq {
    pub name: String,
    pub pid: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub model: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SwitchQuery {
    pub ok: bool,
    pub can_switch: bool,
    pub idle: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// 啟動參數裡的 --model；None＝沒指定（前端顯示「預設」）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// true＝這是使用者自己開的視窗（不是 ASN 開的承載視窗）：重開會在新視窗／新分頁，原本的終端機分頁會留下空的命令列
    pub own_window: bool,
}

pub(crate) struct Target {
    pub pid: u32,
    pub session_id: String,
    pub name: String,
    pub cwd: String,
    pub status: Option<String>,
    pub args: Vec<String>,
}

/// 把「這個名字（或這個 pid）」對到一個活著的 Claude 工作階段，並讀出它的啟動參數。
pub(crate) fn resolve(os: &dyn Os, dir: &Path, name: &str, want: Option<(u32, &str)>) -> Result<Target, String> {
    let sessions = console::read_sessions(dir);
    let s: &Value = match want {
        Some((pid, sid)) => {
            let s = sessions
                .iter()
                .find(|s| s.get("pid").and_then(Value::as_u64) == Some(pid as u64))
                .ok_or_else(|| "找不到這個視窗的工作階段記錄（可能已經關了）".to_string())?;
            if s.get("sessionId").and_then(Value::as_str) != Some(sid) {
                return Err("這個視窗的對話已經換了（工作階段編號不符），請重新操作".into());
            }
            s
        }
        None => {
            let pid = console::pick_session_pid(&sessions, name, |p| os.alive(p)).ok_or_else(|| "找不到這個夥伴的 Claude 視窗".to_string())?;
            sessions.iter().find(|s| s.get("pid").and_then(Value::as_u64) == Some(pid as u64)).ok_or_else(|| "找不到這個夥伴的 Claude 視窗".to_string())?
        }
    };
    let pid = u32::try_from(s.get("pid").and_then(Value::as_u64).unwrap_or(0)).unwrap_or(0);
    if pid == 0 || pid == os.own_pid() {
        return Err("不能對自己或無效的程序操作".into());
    }
    if s.get("kind").and_then(Value::as_str).map(|k| k != "interactive").unwrap_or(false) {
        return Err("這不是互動式的 Claude 視窗".into());
    }
    if !os.alive(pid) {
        return Err("這個視窗已經關了".into());
    }
    let session_id = s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
    if session_id.is_empty() {
        return Err("工作階段記錄沒有編號，無法接續對話".into());
    }
    let sname = s.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    if want.is_some() && !name.is_empty() && !sname.is_empty() && sname != name {
        return Err("這個視窗的名字已經不同，請重新操作".into());
    }
    let cwd = s.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    let line = os.cmdline(pid).ok_or_else(|| "讀不到這個視窗的啟動參數".to_string())?;
    let args = parse_cmdline(&line);
    if !looks_like_claude(&args) {
        return Err("這個程序看起來不是 Claude，不處理".into());
    }
    Ok(Target {
        pid,
        session_id,
        name: if sname.is_empty() { name.to_string() } else { sname },
        cwd,
        status: s.get("status").and_then(Value::as_str).map(str::to_string),
        args,
    })
}

pub(crate) fn query_with(os: &dyn Os, dir: &Path, req: &SwitchQueryReq) -> SwitchQuery {
    if req.name.trim().is_empty() {
        return SwitchQuery { ok: false, reason: Some("缺少名字".into()), ..Default::default() };
    }
    match resolve(os, dir, &req.name, None) {
        Err(e) => SwitchQuery { ok: true, can_switch: false, reason: Some(e), ..Default::default() },
        Ok(t) => {
            let idle = is_idle(t.status.as_deref());
            SwitchQuery {
                ok: true,
                can_switch: true,
                idle,
                reason: if idle { None } else { Some("對話進行中，等它閒置再切換".into()) },
                pid: Some(t.pid),
                session_id: Some(t.session_id.clone()),
                cwd: Some(t.cwd.clone()),
                status: t.status.clone(),
                model: current_model(&t.args),
                own_window: !opened_by_asn(os, &os.processes(), t.pid),
            }
        }
    }
}

/// ASN 自帶終端的 GUI 程序名
pub(crate) const WEZ_GUI: &str = "wezterm-gui.exe";

/// 0.2.0「ASN 開的」（設計 1.2）：這個程序往上 8 層內找到的 wezterm-gui 在對照表裡、而且現在的建立時間和開的時候量到的一樣，回那個 GUI。
/// 不在表上、查不到建立時間、建立時間不同（編號被別的程序拿去用了）一律 None＝不是 ASN 開的
pub(crate) fn asn_wez_of(os: &dyn Os, table: &[Proc], pid: u32) -> Option<u32> {
    let gui = ancestors(table, pid).into_iter().take(8).find(|a| table.iter().any(|p| p.pid == *a && p.name == WEZ_GUI))?;
    let (_, was) = os.own_wez().into_iter().find(|(g, _)| *g == gui)?;
    (os.started_ms(gui) == Some(was)).then_some(gui)
}

/// 共用終端服務（B2）的程序名
pub(crate) const MUX_SERVER: &str = "wezterm-mux-server.exe";

/// B2c：這個程序往上 8 層內的 wezterm-mux-server（編號, 現在的建立時間）；查不到建立時間＝None。
/// 這只說「它在某個 mux 底下」；是不是 ASN 開窗格時記的那個 mux，由對照表（term::partner_in_mux）核對編號＋建立時間
pub(crate) fn mux_ancestor(table: &[Proc], pid: u32, started: &dyn Fn(u32) -> Option<u64>) -> Option<(u32, u64)> {
    let mux = ancestors(table, pid).into_iter().take(8).find(|a| table.iter().any(|p| p.pid == *a && p.name == MUX_SERVER))?;
    Some((mux, started(mux)?))
}

/// WezTerm 每個窗格的虛擬主控台宿主（不算「別的程序」）
const WEZ_PANE_HOSTS: &[&str] = &["openconsole.exe", "conhost.exe"];

/// 收 GUI 之前的檢查（asn真 審 #573）：這個 GUI 底下除了剛結束的那棵（ended）與窗格宿主之外，還有沒有活著的程序
/// （使用者自己在那扇 WezTerm 多開的分頁、別的殼）。有就不收
pub(crate) fn wez_has_others(os: &dyn Os, gui: u32, ended: &[u32]) -> bool {
    let table = os.processes();
    let mut order = vec![gui];
    let mut idx = 0;
    while idx < order.len() {
        let cur = order[idx];
        for c in table.iter().filter(|p| p.ppid == cur && p.pid != cur) {
            if !order.contains(&c.pid) {
                order.push(c.pid);
            }
        }
        idx += 1;
    }
    table.iter().filter(|p| order[1..].contains(&p.pid)).any(|p| !ended.contains(&p.pid) && !WEZ_PANE_HOSTS.contains(&p.name.as_str()) && os.alive(p.pid))
}

/// 這個視窗是不是 ASN 開的：自帶終端（對照表＋建立時間），或舊式主控台的承載 PowerShell（過渡期保留，第三節）
pub(crate) fn opened_by_asn(os: &dyn Os, table: &[Proc], pid: u32) -> bool {
    asn_wez_of(os, table, pid).is_some() || asn_host_of(os, table, pid).is_some()
}

/// 舊式（0.1.x 原生主控台）：這個 Claude 的直接父殼若是 ASN 自己開視窗用的承載 PowerShell，回傳它的 pid；其他視窗回 None。
/// 0.2.0 起新開的視窗在自帶終端裡（見 asn_wez_of），這個只為了認得升級前開的舊視窗，第 4 階段之後才拿掉
pub(crate) fn asn_host_of(os: &dyn Os, table: &[Proc], pid: u32) -> Option<u32> {
    parent_of(table, pid).filter(|p| (p.name == "powershell.exe" || p.name == "pwsh.exe") && os.cmdline(p.pid).map(|l| is_asn_host_cmdline(&l)).unwrap_or(false)).map(|p| p.pid)
}

/// 照原參數重開所需的資料
pub(crate) struct Plan {
    pub name: String,
    pub cwd: PathBuf,
    /// 含程式本身
    pub argv: Vec<String>,
    /// 原本在 Windows Terminal 分頁裡（只做記錄：重開一律走 local::start_window，0.2.0 起是自帶的 WezTerm）
    #[allow(dead_code)]
    pub in_wt: bool,
}

pub(crate) fn fail(stage: &str, reason: impl Into<String>, manual: &str, closed: bool) -> Value {
    json!({ "ok": false, "stage": stage, "reason": reason.into(), "manual": manual, "closed": closed })
}

/// 關掉一個已確認的視窗：（polite 時）先送關閉訊息等幾秒；沒走就只強制結束 `allowed`（kill_set 算出來的）內的 pid；
/// 承載殼（host）還在才補一刀；最後確認目標 pid 真的消失。回 Err(中文原因)。
/// `polite=false`：不送關閉訊息，直接結束清單內的 pid（使用者自己開的視窗：關閉訊息會把使用者的終端機一起關掉）。
/// ASN 自帶終端裡的視窗（設計 1.3）：沒有承載殼，一律不送關閉訊息；先結束 claude 那棵（allowed），確認消失後再收掉那個 GUI
/// （stop_wez 會核對建立時間，對不上就不動；收不掉只記 log，claude 已經結束，視窗停在最後的畫面）。
pub(crate) fn close_session(os: &dyn Os, t: &Timing, target_pid: u32, allowed: &[u32], host: Option<u32>, polite: bool) -> Result<(), String> {
    // 要在結束之前找：claude 一結束，程序表就找不到它往上的 GUI 了
    let wez = asn_wez_of(os, &os.processes(), target_pid);
    // B2c：開在共用 mux 裡的（沒有自己的 GUI）：結束後改關它的窗格。mux 是 claude 的祖先，kill_set 本來就不會動它
    let mux_sess = if wez.is_none() { os.mux_session_of(target_pid) } else { None };
    let polite = polite && wez.is_none();
    let sent = polite && os.close_window(target_pid);
    if sent && wait_until(os, t.close_grace_ms, t.poll_ms, || !os.alive(target_pid)) {
        // 視窗關了，連同承載的殼一起走；殼若還在才補一刀
    } else {
        for pid in allowed {
            if *pid != target_pid || os.alive(*pid) {
                if let Err(e) = os.terminate(*pid) {
                    if os.alive(*pid) {
                        return Err(format!("結束程序失敗：{e}"));
                    }
                }
            }
        }
    }
    if let Some(h) = host {
        if os.alive(h) && allowed.contains(&h) {
            let _ = os.terminate(h);
        }
    }
    if !wait_until(os, t.gone_wait_ms, t.poll_ms, || !os.alive(target_pid)) {
        return Err("原視窗沒有關掉".into());
    }
    if let Some(gui) = wez {
        if wez_has_others(os, gui, allowed) {
            elog!("關夥伴視窗：程式已結束；自帶終端的視窗（{gui}）裡還有別的程序，不收");
        } else if let Err(e) = os.stop_wez(gui) {
            elog!("關夥伴視窗：程式已結束，但收不掉自帶終端的視窗（{gui}）：{e}");
        }
    }
    if let Some(id) = mux_sess {
        if let Err(e) = os.stop_mux_session(&id) {
            elog!("關夥伴視窗：程式已結束，但關不掉共用終端裡的窗格（{id}）：{e}");
        }
    }
    Ok(())
}

/// 照 `argv` 重開所需的資料：工作資料夾要真的存在。`in_wt`＝原本在 Windows Terminal 分頁裡
pub(crate) fn plan_for(target: &Target, name: &str, argv: Vec<String>, in_wt: bool) -> Result<Plan, String> {
    let cwd = PathBuf::from(local::strip_verbatim_prefix(&target.cwd));
    if target.cwd.is_empty() || !cwd.is_dir() {
        return Err(format!("工作資料夾不存在：{}", target.cwd));
    }
    Ok(Plan { name: name.to_string(), cwd, argv, in_wt })
}

pub(crate) fn run_with(os: &dyn Os, dir: &Path, req: &SwitchRunReq, launch: &dyn Fn(&Plan) -> Result<(), String>, t: &Timing) -> Value {
    if !valid_model(&req.model) {
        return fail("check", "模型名稱不合法", "", false);
    }
    // 1. 重新確認目標（不信任前端、也不信任先前的查詢結果）
    let target = match resolve(os, dir, &req.name, Some((req.pid, &req.session_id))) {
        Ok(t) => t,
        Err(e) => return fail("check", e, "", false),
    };
    if !is_idle(target.status.as_deref()) {
        return fail("check", "對話進行中，等它閒置再切換", "", false);
    }
    let cwd = PathBuf::from(local::strip_verbatim_prefix(&target.cwd));
    if target.cwd.is_empty() || !cwd.is_dir() {
        return fail("check", format!("工作資料夾不存在：{}", target.cwd), "", false);
    }
    let argv = rewrite_args(&target.args, &target.session_id, &target.name, &req.model);
    let manual = manual_command(&cwd.to_string_lossy(), &argv);
    let table = os.processes();
    let in_wt = in_windows_terminal(&table, target.pid);
    let host = asn_host_of(os, &table, target.pid);
    let allowed = kill_set_with(&table, target.pid, host, os.own_pid(), &|p| os.started_ms(p));
    if !allowed.contains(&target.pid) {
        return fail("check", "守門：這個程序不允許結束", &manual, false);
    }
    let old_pids: HashSet<u32> = console::read_sessions(dir).iter().filter(|s| s.get("name").and_then(Value::as_str) == Some(target.name.as_str())).filter_map(|s| s.get("pid").and_then(Value::as_u64).map(|p| p as u32)).collect();

    // 2. 優雅關閉：先送關閉訊息給主控台視窗，等幾秒；沒走就只強制結束允許清單內的 pid
    // 使用者自己開的視窗（沒有 ASN 承載殼）不送關閉訊息，只結束 claude 與子孫，留下他的終端機；ASN 開的才先送（與 partner_ops、codex_ops 一致）
    if let Err(reason) = close_session(os, t, target.pid, &allowed, host, host.is_some()) {
        return fail("close", reason, &manual, false);
    }

    // 3. 重開
    let plan = Plan { name: target.name.clone(), cwd, argv, in_wt };
    if let Err(e) = launch(&plan) {
        return fail("launch", format!("原視窗已關閉，但重開失敗：{e}"), &manual, true);
    }

    // 4. 確認新工作階段出現（名字相同、不是舊 pid、程序活著）
    let mut found: Option<(u32, String)> = None;
    let ok = wait_until(os, t.appear_wait_ms, t.poll_ms, || {
        let sessions = console::read_sessions(dir);
        let key = if target.name.is_empty() { None } else { Some(target.name.as_str()) };
        let pid = match key {
            Some(n) => console::pick_session_pid(&sessions, n, |p| !old_pids.contains(&p) && os.alive(p)),
            None => sessions
                .iter()
                .filter(|s| s.get("cwd").and_then(Value::as_str) == Some(target.cwd.as_str()))
                .filter_map(|s| s.get("pid").and_then(Value::as_u64).map(|p| p as u32))
                .find(|p| !old_pids.contains(p) && os.alive(*p)),
        };
        if let Some(p) = pid {
            let sid = sessions.iter().find(|s| s.get("pid").and_then(Value::as_u64) == Some(p as u64)).and_then(|s| s.get("sessionId").and_then(Value::as_str)).unwrap_or("").to_string();
            found = Some((p, sid));
            true
        } else {
            false
        }
    });
    match (ok, found) {
        (true, Some((pid, sid))) => json!({ "ok": true, "newPid": pid, "sessionId": sid, "model": req.model, "manual": manual }),
        _ => fail("verify", "原視窗已關閉、新視窗已送出，但一直沒看到同名的新對話出現", &manual, true),
    }
}

// ---------------------------------------------------------------- 真實環境

pub fn model_switch_query(req: SwitchQueryReq) -> Result<Value, String> {
    let Some(dir) = console::sessions_dir() else {
        return Ok(json!(SwitchQuery { ok: true, can_switch: false, reason: Some("找不到 Claude 的工作階段資料夾".into()), ..Default::default() }));
    };
    Ok(json!(query_with(&RealOs, &dir, &req)))
}

pub fn model_switch_run(req: SwitchRunReq) -> Result<Value, String> {
    let dir = console::sessions_dir().ok_or_else(|| "找不到 Claude 的工作階段資料夾".to_string())?;
    Ok(run_with(&RealOs, &dir, &req, &real_launch, &Timing::real()))
}

/// 照計畫重開：走開窗點 local::start_window（0.2.0 起先開在 ASN 自帶的 WezTerm，找不到才用原生主控台；原本在 Windows Terminal 分頁裡的也一樣）
pub(crate) fn real_launch(plan: &Plan) -> Result<(), String> {
    local::start_window(&plan.name, &plan.argv[0], &plan.argv[1..], &plan.cwd, false).map(|_| ())
}

pub(crate) struct RealOs;

#[cfg(windows)]
impl Os for RealOs {
    fn cmdline(&self, pid: u32) -> Option<String> {
        winapi::cmdline_of(pid)
    }
    fn cwd(&self, pid: u32) -> Option<String> {
        winapi::cwd_of(pid)
    }
    fn processes(&self) -> Vec<Proc> {
        winapi::process_table()
    }
    fn alive(&self, pid: u32) -> bool {
        console::win::pid_alive(pid)
    }
    fn started_ms(&self, pid: u32) -> Option<u64> {
        crate::heartbeat::process_started_ms(pid)
    }
    fn close_window(&self, pid: u32) -> bool {
        winapi::post_close(pid)
    }
    fn own_wez(&self) -> Vec<(u32, u64)> {
        super::term::own_gui_windows()
    }
    fn stop_wez(&self, gui_pid: u32) -> Result<(), String> {
        super::term::stop_own_gui(gui_pid)
    }
    fn mux_session_of(&self, pid: u32) -> Option<String> {
        // 名字從 Claude 的工作階段記錄來（跟名單切前景／背景找程序是同一份）；程序要真的在 mux 底下、而且是對照表記的那個 mux
        let name = console::session_name_of(&console::read_sessions(&console::sessions_dir()?), pid)?;
        let mux = mux_ancestor(&winapi::process_table(), pid, &|p| crate::heartbeat::process_started_ms(p))?;
        super::term::mux_partner_in(mux, &name)
    }
    fn stop_mux_session(&self, id: &str) -> Result<(), String> {
        super::term::stop_mux_partner(id)
    }
    fn terminate(&self, pid: u32) -> Result<(), String> {
        winapi::terminate(pid)
    }
}

#[cfg(not(windows))]
impl Os for RealOs {
    fn cmdline(&self, _pid: u32) -> Option<String> {
        None
    }
    fn processes(&self) -> Vec<Proc> {
        Vec::new()
    }
    fn alive(&self, _pid: u32) -> bool {
        false
    }
    fn close_window(&self, _pid: u32) -> bool {
        false
    }
    fn terminate(&self, _pid: u32) -> Result<(), String> {
        Err("僅 Windows 支援".into())
    }
}

#[cfg(windows)]
pub(crate) mod winapi {
    use super::{console, Proc};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_QUERY_INFORMATION, PROCESS_TERMINATE, PROCESS_VM_READ};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: isize,
        peb_base: *mut c_void,
        affinity_mask: usize,
        base_priority: isize,
        unique_pid: usize,
        parent_pid: usize,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(h: HANDLE, class: u32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32;
    }

    unsafe fn read<T: Copy + Default>(h: HANDLE, addr: usize) -> Option<T> {
        let mut v = T::default();
        let mut got = 0usize;
        let ok = ReadProcessMemory(h, addr as *const c_void, &mut v as *mut T as *mut c_void, std::mem::size_of::<T>(), &mut got);
        if ok != 0 && got == std::mem::size_of::<T>() {
            Some(v)
        } else {
            None
        }
    }

    /// 讀別的程序的命令列：NtQueryInformationProcess 拿 PEB 位址 → PEB.ProcessParameters → CommandLine（UNICODE_STRING）。
    /// 只支援 64 位元程序（Claude 是）；讀不到、長度不合理都回 None。
    #[cfg(target_pointer_width = "64")]
    pub fn cmdline_of(pid: u32) -> Option<String> {
        const PEB_PROCESS_PARAMETERS: usize = 0x20;
        const PARAMS_COMMAND_LINE: usize = 0x70;
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h.is_null() {
                return None;
            }
            let r = (|| {
                let mut pbi: ProcessBasicInformation = std::mem::zeroed();
                let mut ret = 0u32;
                let st = NtQueryInformationProcess(h, 0, &mut pbi as *mut _ as *mut c_void, std::mem::size_of::<ProcessBasicInformation>() as u32, &mut ret);
                if st < 0 || pbi.peb_base.is_null() {
                    return None;
                }
                let params: usize = read::<usize>(h, pbi.peb_base as usize + PEB_PROCESS_PARAMETERS)?;
                if params == 0 {
                    return None;
                }
                let len: u16 = read::<u16>(h, params + PARAMS_COMMAND_LINE)?;
                let buf_ptr: usize = read::<usize>(h, params + PARAMS_COMMAND_LINE + 8)?;
                if len == 0 || len % 2 != 0 || len > 32_000 || buf_ptr == 0 {
                    return None;
                }
                let mut buf = vec![0u16; (len / 2) as usize];
                let mut got = 0usize;
                let ok = ReadProcessMemory(h, buf_ptr as *const c_void, buf.as_mut_ptr() as *mut c_void, len as usize, &mut got);
                if ok == 0 || got != len as usize {
                    return None;
                }
                String::from_utf16(&buf).ok()
            })();
            CloseHandle(h);
            r
        }
    }

    #[cfg(not(target_pointer_width = "64"))]
    pub fn cmdline_of(_pid: u32) -> Option<String> {
        None
    }

    /// 讀別的程序目前的工作資料夾：同 cmdline_of 的路徑，讀 ProcessParameters.CurrentDirectory.DosPath（UNICODE_STRING，偏移 0x38）。
    /// 只讀、同一個使用者的程序不需要提權；讀不到、長度不合理都回 None。結果已正規化（見 normalize_cwd）
    #[cfg(target_pointer_width = "64")]
    pub fn cwd_of(pid: u32) -> Option<String> {
        const PEB_PROCESS_PARAMETERS: usize = 0x20;
        const PARAMS_CURRENT_DIRECTORY: usize = 0x38;
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h.is_null() {
                return None;
            }
            let r = (|| {
                let mut pbi: ProcessBasicInformation = std::mem::zeroed();
                let mut ret = 0u32;
                let st = NtQueryInformationProcess(h, 0, &mut pbi as *mut _ as *mut c_void, std::mem::size_of::<ProcessBasicInformation>() as u32, &mut ret);
                if st < 0 || pbi.peb_base.is_null() {
                    return None;
                }
                let params: usize = read::<usize>(h, pbi.peb_base as usize + PEB_PROCESS_PARAMETERS)?;
                if params == 0 {
                    return None;
                }
                let len: u16 = read::<u16>(h, params + PARAMS_CURRENT_DIRECTORY)?;
                let buf_ptr: usize = read::<usize>(h, params + PARAMS_CURRENT_DIRECTORY + 8)?;
                if len == 0 || len % 2 != 0 || len > 4096 || buf_ptr == 0 {
                    return None;
                }
                let mut buf = vec![0u16; (len / 2) as usize];
                let mut got = 0usize;
                let ok = ReadProcessMemory(h, buf_ptr as *const c_void, buf.as_mut_ptr() as *mut c_void, len as usize, &mut got);
                if ok == 0 || got != len as usize {
                    return None;
                }
                String::from_utf16(&buf).ok().map(|p| super::normalize_cwd(&p)).filter(|p| !p.is_empty())
            })();
            CloseHandle(h);
            r
        }
    }

    #[cfg(not(target_pointer_width = "64"))]
    pub fn cwd_of(_pid: u32) -> Option<String> {
        None
    }

    pub fn process_table() -> Vec<Proc> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            while ok != 0 {
                let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                out.push(Proc { pid: e.th32ProcessID, ppid: e.th32ParentProcessID, name: String::from_utf16_lossy(&e.szExeFile[..n]).to_lowercase() });
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        out
    }

    /// 結束單一程序（呼叫端負責只傳允許清單內的 pid）
    pub fn terminate(pid: u32) -> Result<(), String> {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                return Err(format!("開不了程序 {pid}"));
            }
            let ok = TerminateProcess(h, 1);
            CloseHandle(h);
            if ok == 0 {
                Err(format!("TerminateProcess 失敗（{pid}）"))
            } else {
                Ok(())
            }
        }
    }

    /// 對該 pid 的傳統主控台視窗（ConsoleWindowClass）送 WM_CLOSE；找不到視窗（例如在 Windows Terminal 裡）回 false
    pub fn post_close(pid: u32) -> bool {
        let Some(w) = console::win::find_console(pid) else { return false };
        unsafe { PostMessageW(w.hwnd as isize as *mut c_void, WM_CLOSE, 0, 0) != 0 }
    }
}

// ---------------------------------------------------------------- 測試

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    // ---- 命令列解析

    #[test]
    fn 命令列_引號與空白路徑() {
        let a = parse_cmdline(r#""C:\Program Files\Claude Code\claude.exe" --model opus -n "小良哥 1""#);
        assert_eq!(a, v(&[r"C:\Program Files\Claude Code\claude.exe", "--model", "opus", "-n", "小良哥 1"]));
    }

    #[test]
    fn 命令列_沒有引號的程式路徑與多餘空白() {
        assert_eq!(parse_cmdline(r"  claude.exe   --continue  "), v(&["claude.exe", "--continue"]));
        assert!(parse_cmdline("   ").is_empty());
        assert_eq!(parse_cmdline(r"C:\x\claude.exe"), v(&[r"C:\x\claude.exe"]));
    }

    #[test]
    fn 命令列_反斜線與跳脫引號() {
        // 引號前奇數個反斜線＝字面引號；偶數個＝反斜線減半、引號當開關
        assert_eq!(parse_cmdline(r#"x "a\"b" c"#), v(&["x", "a\"b", "c"]));
        assert_eq!(parse_cmdline(r#"x "C:\dir with space\\" y"#), v(&["x", r"C:\dir with space\", "y"]));
        assert_eq!(parse_cmdline(r#"x C:\a\b --k"#), v(&["x", r"C:\a\b", "--k"]));
        assert_eq!(parse_cmdline(r#"x "he said ""hi"" ok""#), v(&["x", "he said \"hi\" ok"]));
    }

    #[test]
    fn 命令列_空字串參數保留() {
        assert_eq!(parse_cmdline(r#"x "" y"#), v(&["x", "", "y"]));
    }

    // ---- 判斷是不是 Claude、目前模型

    #[test]
    fn 看起來是不是claude() {
        assert!(looks_like_claude(&v(&[r"C:\Users\a\.local\bin\claude.exe", "--model", "opus"])));
        assert!(looks_like_claude(&v(&["claude"])));
        assert!(looks_like_claude(&v(&["node.exe", r"C:\x\node_modules\@anthropic-ai\claude-code\cli.js", "-n", "a"])));
        assert!(!looks_like_claude(&v(&["node.exe", "server.js", "--claude"])), "旗標裡有 claude 不算");
        assert!(!looks_like_claude(&v(&["notepad.exe"])));
        assert!(!looks_like_claude(&[]));
    }

    #[test]
    fn 外殼包著的_claude_只認第一個指令是_claude() {
        // PowerShell 包裝（工作機 default 啟動設定的樣子）：-Command 後面一整串、或拆成多個參數
        assert!(wraps_claude(&v(&["powershell", "-NoExit", "-Command", "claude --resume abc -n 小乙"])));
        assert!(wraps_claude(&v(&["pwsh.exe", "-NoLogo", "-c", r"& 'C:\Users\a b\.local\bin\claude.exe' --model opus"])));
        assert!(wraps_claude(&v(&["powershell.exe", "-Command", "claude", "--resume", "abc"])));
        // cmd 包裝
        assert!(wraps_claude(&v(&["cmd.exe", "/c", "claude --resume abc"])));
        assert!(wraps_claude(&v(&["CMD", "/K", r#""C:\bin\claude.exe" -n x"#])));
        // 第一個指令不是 claude：不算（cd x; claude、claude 只是參數、其他程式）
        assert!(!wraps_claude(&v(&["powershell", "-NoExit", "-Command", "cd x; claude --resume abc"])));
        assert!(!wraps_claude(&v(&["cmd.exe", "/c", "echo claude"])));
        assert!(!wraps_claude(&v(&["powershell", "-Command", "codex resume t1"])));
        assert!(!wraps_claude(&v(&["powershell", "-Command", "claudette run"])), "名字只是開頭相同不算");
        // 沒有 -Command／/c、不是外殼、空的
        assert!(!wraps_claude(&v(&["powershell", "-NoExit"])));
        assert!(!wraps_claude(&v(&["claude.exe", "-c", "claude"])), "claude 本身的 -c 不是外殼");
        assert!(!wraps_claude(&[]));
        // 守門不放寬：包著的不算 looks_like_claude（切模型等守門仍不碰這種程序）
        assert!(!looks_like_claude(&v(&["powershell", "-Command", "claude"])));
    }

    #[test]
    fn 目前模型_沒指定就是none() {
        assert_eq!(current_model(&v(&["claude.exe"])), None);
        assert_eq!(current_model(&v(&["claude.exe", "--model", "opus"])), Some("opus".into()));
        assert_eq!(current_model(&v(&["claude.exe", "--model=claude-sonnet-4-5", "-n", "a"])), Some("claude-sonnet-4-5".into()));
        assert_eq!(current_model(&v(&["claude.exe", "--model", "haiku", "--model", "opus"])), Some("opus".into()), "取最後一個");
        assert_eq!(current_model(&v(&["claude.exe", "--model"])), None, "缺值");
        assert_eq!(current_model(&v(&["claude.exe", "--", "--model", "x"])), None, "-- 之後不算");
        // 程式路徑本身長得像旗標值也不誤判
        assert_eq!(current_model(&v(&["node.exe", "cli.js", "-n", "--model"])), None);
    }

    #[test]
    fn 模型名稱檢查() {
        for ok in ["opus", "sonnet", "haiku", "claude-opus-4-5", "opus[1m]", "sonnet-4.5"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "-x", "a b", "a;b", "a&b", "$(x)", "a\"b", "中文"] {
            assert!(!valid_model(bad), "{bad}");
        }
    }

    // ---- 參數改寫

    #[test]
    fn 改寫_各種舊參數組合() {
        let sid = "11111111-2222";
        let cases: Vec<(Vec<&str>, Vec<&str>)> = vec![
            // 什麼都沒有
            (vec!["claude.exe"], vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet"]),
            // 舊 --model、--resume、-n 都被換掉，其餘保留順序
            (
                vec!["claude.exe", "--dangerously-skip-permissions", "--model", "opus", "--resume", "old-id", "-n", "舊名", "--remote-control", "甲"],
                vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet", "--dangerously-skip-permissions", "--remote-control", "甲"],
            ),
            // 等號寫法
            (vec!["claude.exe", "--model=haiku", "--resume=abc", "--name=乙"], vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet"]),
            // --continue／-c／--fork-session／--session-id 都拿掉
            (vec!["claude.exe", "--continue", "-c", "--fork-session", "--session-id", "zzz"], vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet"]),
            // -r 不帶值（後面接旗標）
            (vec!["claude.exe", "-r", "--verbose"], vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet", "--verbose"]),
            // -r 帶值
            (vec!["claude.exe", "-r", "abc", "--verbose"], vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet", "--verbose"]),
            // 結尾缺值的 --model
            (vec!["claude.exe", "--verbose", "--model"], vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet", "--verbose"]),
            // -- 之後原樣保留（連同裡面長得像旗標的）
            (vec!["claude.exe", "--model", "opus", "--", "--model", "x"], vec!["claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet", "--", "--model", "x"]),
            // 路徑有空白、中文參數值
            (
                vec![r"C:\Program Files\Claude Code\claude.exe", "--add-dir", r"D:\我的 專案", "--model", "opus"],
                vec![r"C:\Program Files\Claude Code\claude.exe", "-n", "甲", "--resume", sid, "--model", "sonnet", "--add-dir", r"D:\我的 專案"],
            ),
            // node 腳本形式：程式佔兩個參數
            (
                vec!["node.exe", r"C:\x\claude-code\cli.js", "--model", "opus"],
                vec!["node.exe", r"C:\x\claude-code\cli.js", "-n", "甲", "--resume", sid, "--model", "sonnet"],
            ),
        ];
        for (input, want) in cases {
            assert_eq!(rewrite_args(&v(&input), sid, "甲", "sonnet"), v(&want), "輸入：{input:?}");
        }
    }

    #[test]
    fn 改寫_名字是空的就不加n_也不帶回舊的() {
        let out = rewrite_args(&v(&["claude.exe", "-n", "舊"]), "sid", "", "opus");
        assert_eq!(out, v(&["claude.exe", "--resume", "sid", "--model", "opus"]));
    }

    #[test]
    fn 改寫_結果再解析模型是新的() {
        let out = rewrite_args(&v(&["claude.exe", "--model", "opus"]), "sid", "甲", "haiku");
        assert_eq!(current_model(&out), Some("haiku".into()));
        // 冪等：再改一次不會累積重複旗標
        let again = rewrite_args(&out, "sid", "甲", "sonnet");
        assert_eq!(again.iter().filter(|a| *a == "--resume").count(), 1);
        assert_eq!(again.iter().filter(|a| *a == "--model").count(), 1);
        assert_eq!(current_model(&again), Some("sonnet".into()));
    }

    #[test]
    fn 手動指令_路徑空白與單引號() {
        let m = manual_command(r"D:\my proj", &v(&[r"C:\Program Files\c\claude.exe", "-n", "it's", "--model", "opus"]));
        assert_eq!(m, r"Set-Location -LiteralPath 'D:\my proj'; & 'C:\Program Files\c\claude.exe' '-n' 'it''s' '--model' 'opus'");
    }

    // ---- 閒置判斷

    #[test]
    fn 閒置判斷() {
        assert!(is_idle(Some("idle")));
        assert!(is_idle(Some(" Idle ")));
        for s in ["busy", "waiting", "running", ""] {
            assert!(!is_idle(Some(s)), "{s}");
        }
        assert!(!is_idle(None), "沒有 status 欄位不能當閒置");
    }

    // ---- ASN 承載殼辨識

    #[test]
    fn 承載殼辨識() {
        let args = v(&["--dangerously-skip-permissions"]);
        let host = format!("powershell.exe {}", local::window_launcher_args("甲", r"C:\x y\claude.exe", &args));
        assert!(is_asn_host_cmdline(&host));
        assert!(!is_asn_host_cmdline("powershell.exe -NoLogo"));
        assert!(!is_asn_host_cmdline("powershell.exe -EncodedCommand AAAA"));
        assert!(!is_asn_host_cmdline("powershell.exe -EncodedCommand"));
    }

    // ---- 守門：只殺指定 PID

    fn p(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }

    fn table() -> Vec<Proc> {
        vec![
            p(4, 0, "system"),
            p(100, 4, "explorer.exe"),
            p(200, 100, "windowsterminal.exe"),
            p(210, 200, "pwsh.exe"),       // 使用者的殼
            p(220, 210, "claude.exe"),     // 目標
            p(221, 220, "node.exe"),       // 目標底下的 MCP 子程序
            p(222, 221, "cmd.exe"),
            p(230, 200, "pwsh.exe"),       // 同一個 WT 的另一個分頁
            p(231, 230, "claude.exe"),     // 別的 Claude（不能碰）
            p(300, 100, "asn.exe"),        // ASN 自己
            p(310, 300, "powershell.exe"), // ASN 的子程序
        ]
    }

    #[test]
    fn 守門_pid_被重用_比父程序早建立的孤兒不算後代() {
        let t = table();
        // 222（cmd）其實是舊 221 留下的孤兒：建立時間比現在的 221 早
        let st = |pid: u32| match pid {
            220 => Some(1000),
            221 => Some(2000),
            222 => Some(1500),
            _ => None,
        };
        assert_eq!(kill_set_with(&t, 220, None, 300, &st), vec![221, 220]);
        // 查不到建立時間：維持原樣（不多殺也不少殺）
        assert_eq!(kill_set_with(&t, 220, None, 300, &|_| None), vec![222, 221, 220]);
        // 只有一邊查得到：維持原樣
        assert_eq!(kill_set_with(&t, 220, None, 300, &|p| if p == 222 { Some(1) } else { None }), vec![222, 221, 220]);
        // 正常順序（子比父晚）：全部算後代
        assert_eq!(kill_set_with(&t, 220, None, 300, &|p| Some(p as u64)), vec![222, 221, 220]);
        // 被排除的節點底下的孫子也不算
        let st2 = |pid: u32| match pid {
            220 => Some(1000),
            221 => Some(500),
            222 => Some(3000),
            _ => None,
        };
        assert_eq!(kill_set_with(&t, 220, None, 300, &st2), vec![220]);
    }

    #[test]
    fn 守門_只含目標與它的後代_子先孫後() {
        let set = kill_set(&table(), 220, None, 300);
        assert_eq!(set, vec![222, 221, 220]);
        assert!(!set.contains(&231) && !set.contains(&210) && !set.contains(&200));
    }

    #[test]
    fn 守門_父殼只有是直接父親才算() {
        let t = table();
        assert_eq!(kill_set(&t, 220, Some(210), 300), vec![222, 221, 220, 210]);
        assert_eq!(kill_set(&t, 220, Some(230), 300), vec![222, 221, 220], "別人的殼不收");
        assert_eq!(kill_set(&t, 220, Some(200), 300), vec![222, 221, 220], "祖父不收");
    }

    #[test]
    fn 守門_絕不碰自己與自己的祖先() {
        let t = table();
        assert!(kill_set(&t, 300, None, 300).is_empty(), "不能殺自己");
        assert!(kill_set(&t, 100, None, 300).is_empty(), "不能殺自己的祖先 explorer");
        assert!(kill_set(&t, 0, None, 300).is_empty());
        assert!(kill_set(&t, 4, None, 300).is_empty());
        // 目標底下若剛好有 ASN 自己（開發時從目標啟動），也要被排除
        let mut t2 = table();
        t2.push(p(400, 220, "asn.exe"));
        let set = kill_set(&t2, 220, None, 400);
        assert!(set.is_empty(), "自己的祖先是目標：不動");
    }

    #[test]
    fn 在wt分頁判斷() {
        let t = table();
        assert!(in_windows_terminal(&t, 220));
        assert!(!in_windows_terminal(&t, 310));
        assert!(!in_windows_terminal(&t, 99999));
    }

    #[test]
    fn 程序表有環不會無限迴圈() {
        let t = vec![p(1, 2, "a"), p(2, 1, "b")];
        let _ = ancestors(&t, 1);
        assert!(kill_set(&t, 1, None, 9).len() <= 2);
    }

    // ---- 流程（假的作業系統）

    struct Fake {
        alive: RefCell<HashSet<u32>>,
        cmd: RefCell<std::collections::HashMap<u32, String>>,
        table: Vec<Proc>,
        terminated: RefCell<Vec<u32>>,
        closed: RefCell<Vec<u32>>,
        /// 送關閉訊息後視窗是否真的關掉（模擬 conhost 視窗關閉連同殼一起收）
        close_works: bool,
        /// 結束時要連帶消失的（殼）
        close_takes: Vec<u32>,
    }

    impl Os for Fake {
        fn cmdline(&self, pid: u32) -> Option<String> {
            self.cmd.borrow().get(&pid).cloned()
        }
        fn processes(&self) -> Vec<Proc> {
            self.table.clone()
        }
        fn alive(&self, pid: u32) -> bool {
            self.alive.borrow().contains(&pid)
        }
        fn close_window(&self, pid: u32) -> bool {
            self.closed.borrow_mut().push(pid);
            if self.close_works {
                self.alive.borrow_mut().remove(&pid);
                for h in &self.close_takes {
                    self.alive.borrow_mut().remove(h);
                }
            }
            self.close_works
        }
        fn terminate(&self, pid: u32) -> Result<(), String> {
            self.terminated.borrow_mut().push(pid);
            self.alive.borrow_mut().remove(&pid);
            Ok(())
        }
        fn own_pid(&self) -> u32 {
            300
        }
        fn sleep(&self, _ms: u64) {}
    }

    fn quick() -> Timing {
        Timing { close_grace_ms: 0, gone_wait_ms: 0, appear_wait_ms: 0, poll_ms: 1 }
    }

    // ---- 0.2.0：自帶終端裡的視窗（設計 1.2、1.3）

    /// 程序樹：explorer(100) → wezterm-gui(500) → openconsole(501) → claude(502) → node(503)；另有舊式 conhost(600) → powershell(601) → claude(602)
    struct WezFake {
        table: Vec<Proc>,
        alive: RefCell<HashSet<u32>>,
        own: Vec<(u32, u64)>,
        started: std::collections::HashMap<u32, u64>,
        cmd: std::collections::HashMap<u32, String>,
        trace: RefCell<Vec<String>>,
        stop_result: Result<(), String>,
    }
    impl Os for WezFake {
        fn cmdline(&self, pid: u32) -> Option<String> {
            self.cmd.get(&pid).cloned()
        }
        fn processes(&self) -> Vec<Proc> {
            self.table.clone()
        }
        fn alive(&self, pid: u32) -> bool {
            self.alive.borrow().contains(&pid)
        }
        fn started_ms(&self, pid: u32) -> Option<u64> {
            self.started.get(&pid).copied()
        }
        fn close_window(&self, pid: u32) -> bool {
            self.trace.borrow_mut().push(format!("close_window:{pid}"));
            false
        }
        fn own_wez(&self) -> Vec<(u32, u64)> {
            self.own.clone()
        }
        fn stop_wez(&self, gui: u32) -> Result<(), String> {
            self.trace.borrow_mut().push(format!("stop_wez:{gui}"));
            self.stop_result.clone()
        }
        fn terminate(&self, pid: u32) -> Result<(), String> {
            self.trace.borrow_mut().push(format!("terminate:{pid}"));
            self.alive.borrow_mut().remove(&pid);
            Ok(())
        }
        fn own_pid(&self) -> u32 {
            300
        }
        fn sleep(&self, _ms: u64) {}
    }
    fn wez_fake(own: Vec<(u32, u64)>, gui_now: Option<u64>) -> WezFake {
        let table = vec![p(100, 1, "explorer.exe"), p(300, 100, "asn.exe"), p(500, 100, "wezterm-gui.exe"), p(501, 500, "openconsole.exe"), p(502, 501, "claude.exe"), p(503, 502, "node.exe"), p(600, 100, "conhost.exe"), p(601, 600, "powershell.exe"), p(602, 601, "claude.exe")];
        let mut started = std::collections::HashMap::new();
        if let Some(t) = gui_now {
            started.insert(500, t);
        }
        let script = super::local::window_launcher_args("舊", "claude.exe", &[]);
        WezFake {
            table,
            alive: RefCell::new([100, 300, 500, 501, 502, 503, 600, 601, 602].into_iter().collect()),
            own,
            started,
            cmd: [(601, format!("powershell.exe {script}"))].into_iter().collect(),
            trace: RefCell::new(vec![]),
            stop_result: Ok(()),
        }
    }

    #[test]
    fn asn_開的判斷_對照表命中且建立時間相符才算() {
        let f = wez_fake(vec![(500, 1_000)], Some(1_000));
        assert_eq!(asn_wez_of(&f, &f.table, 502), Some(500), "claude 往上找到對照表裡的 GUI（中間隔一層 OpenConsole）");
        assert_eq!(asn_wez_of(&f, &f.table, 503), Some(500), "claude 底下的子程序也一樣");
        assert!(opened_by_asn(&f, &f.table, 502));
        // 建立時間不符：編號被別的程序拿去用了
        let f = wez_fake(vec![(500, 1_000)], Some(2_000));
        assert_eq!(asn_wez_of(&f, &f.table, 502), None);
        assert!(!opened_by_asn(&f, &f.table, 502));
        // 查不到建立時間也不算
        let f = wez_fake(vec![(500, 1_000)], None);
        assert_eq!(asn_wez_of(&f, &f.table, 502), None);
        // 不在對照表：使用者自己開的 WezTerm
        let f = wez_fake(vec![], Some(1_000));
        assert_eq!(asn_wez_of(&f, &f.table, 502), None);
        assert!(!opened_by_asn(&f, &f.table, 502), "不認得的一律當外部");
    }

    #[test]
    fn asn_開的判斷_舊式主控台照舊認得() {
        let f = wez_fake(vec![], None);
        assert_eq!(asn_host_of(&f, &f.table, 602), Some(601), "升級前開的舊視窗：承載 PowerShell");
        assert!(opened_by_asn(&f, &f.table, 602));
        assert_eq!(asn_wez_of(&f, &f.table, 602), None);
    }

    #[test]
    fn 關閉自帶終端裡的視窗_先結束_claude_那棵再收_gui_不送關閉訊息() {
        let f = wez_fake(vec![(500, 1_000)], Some(1_000));
        let host = asn_host_of(&f, &f.table, 502);
        assert_eq!(host, None, "沒有承載殼");
        let allowed = kill_set_with(&f.table, 502, host, 300, &|_| None);
        assert_eq!(allowed, vec![503, 502], "只有 claude 與子程序，不含 GUI 與 OpenConsole");
        // 呼叫端照舊傳 polite=host.is_some()（false）；就算傳 true，自帶終端裡的也不送關閉訊息
        close_session(&f, &quick(), 502, &allowed, host, true).unwrap();
        assert_eq!(*f.trace.borrow(), vec!["terminate:503".to_string(), "terminate:502".into(), "stop_wez:500".into()], "先結束 claude 那棵，再收 GUI");
    }

    #[test]
    fn 關閉時_gui_建立時間不符就不收_也不送關閉訊息() {
        let f = wez_fake(vec![(500, 1_000)], Some(2_000));
        let allowed = kill_set_with(&f.table, 502, None, 300, &|_| None);
        close_session(&f, &quick(), 502, &allowed, None, false).unwrap();
        assert_eq!(*f.trace.borrow(), vec!["terminate:503".to_string(), "terminate:502".into()], "不認得的 GUI 不動");
    }

    #[test]
    fn 收_gui_之前_底下還有別的程序就不收() {
        // 使用者在那扇 WezTerm 多開了一個分頁：openconsole(505) → pwsh(506)
        let mut f = wez_fake(vec![(500, 1_000)], Some(1_000));
        f.table.extend([p(505, 500, "openconsole.exe"), p(506, 505, "pwsh.exe")]);
        f.alive.borrow_mut().extend([505, 506]);
        let allowed = kill_set_with(&f.table, 502, None, 300, &|_| None);
        close_session(&f, &quick(), 502, &allowed, None, false).unwrap();
        assert_eq!(*f.trace.borrow(), vec!["terminate:503".to_string(), "terminate:502".into()], "別的分頁還在：只結束 claude 那棵，不收 GUI");
        // 只剩窗格宿主與已結束的 claude：收
        let f = wez_fake(vec![(500, 1_000)], Some(1_000));
        let allowed = kill_set_with(&f.table, 502, None, 300, &|_| None);
        close_session(&f, &quick(), 502, &allowed, None, false).unwrap();
        assert!(f.trace.borrow().contains(&"stop_wez:500".to_string()));
        assert!(!wez_has_others(&f, 500, &allowed));
        // 底下的程序已經結束（程序表殘留）不算
        let mut f = wez_fake(vec![(500, 1_000)], Some(1_000));
        f.table.push(p(507, 500, "cmd.exe"));
        assert!(!wez_has_others(&f, 500, &[502, 503]), "507 不在活著的清單裡");
        f.alive.borrow_mut().insert(507);
        assert!(wez_has_others(&f, 500, &[502, 503]));
    }

    #[test]
    fn 關閉時_收_gui_失敗不算關閉失敗() {
        let mut f = wez_fake(vec![(500, 1_000)], Some(1_000));
        f.stop_result = Err("這個程式編號現在是別的程序".into());
        let allowed = kill_set_with(&f.table, 502, None, 300, &|_| None);
        assert!(close_session(&f, &quick(), 502, &allowed, None, false).is_ok(), "claude 已經結束，視窗停在最後畫面");
    }

    // ---- B2c：開在共用終端服務（mux）裡的夥伴視窗

    /// 程序樹：explorer(100) → asn(300)；mux(700) → openconsole(701)；mux(700) → claude(702) → node(703)
    struct MuxFake {
        table: Vec<Proc>,
        alive: RefCell<HashSet<u32>>,
        sess: Option<String>,
        stop_result: Result<(), String>,
        trace: RefCell<Vec<String>>,
    }
    impl Os for MuxFake {
        fn cmdline(&self, _pid: u32) -> Option<String> {
            None
        }
        fn processes(&self) -> Vec<Proc> {
            self.table.clone()
        }
        fn alive(&self, pid: u32) -> bool {
            self.alive.borrow().contains(&pid)
        }
        fn close_window(&self, pid: u32) -> bool {
            self.trace.borrow_mut().push(format!("close_window:{pid}"));
            false
        }
        fn stop_wez(&self, gui: u32) -> Result<(), String> {
            self.trace.borrow_mut().push(format!("stop_wez:{gui}"));
            Ok(())
        }
        fn mux_session_of(&self, pid: u32) -> Option<String> {
            if pid == 702 { self.sess.clone() } else { None }
        }
        fn stop_mux_session(&self, id: &str) -> Result<(), String> {
            self.trace.borrow_mut().push(format!("stop_mux:{id}"));
            self.stop_result.clone()
        }
        fn terminate(&self, pid: u32) -> Result<(), String> {
            self.trace.borrow_mut().push(format!("terminate:{pid}"));
            self.alive.borrow_mut().remove(&pid);
            Ok(())
        }
        fn own_pid(&self) -> u32 {
            300
        }
        fn sleep(&self, _ms: u64) {}
    }
    fn mux_fake(sess: Option<&str>) -> MuxFake {
        let table = vec![p(100, 1, "explorer.exe"), p(300, 100, "asn.exe"), p(700, 100, "wezterm-mux-server.exe"), p(701, 700, "openconsole.exe"), p(702, 700, "claude.exe"), p(703, 702, "node.exe")];
        MuxFake { table, alive: RefCell::new([100, 300, 700, 701, 702, 703].into_iter().collect()), sess: sess.map(String::from), stop_result: Ok(()), trace: RefCell::new(vec![]) }
    }

    #[test]
    fn 找_mux_祖先_往上八層內_要查得到建立時間() {
        let f = mux_fake(None);
        assert_eq!(mux_ancestor(&f.table, 702, &|p| Some(u64::from(p) * 10)), Some((700, 7000)));
        assert_eq!(mux_ancestor(&f.table, 703, &|p| Some(u64::from(p) * 10)), Some((700, 7000)), "子程序也一樣");
        assert_eq!(mux_ancestor(&f.table, 702, &|_| None), None, "查不到建立時間就不認");
        assert_eq!(mux_ancestor(&f.table, 300, &|_| Some(1)), None, "ASN 自己不在任何 mux 底下");
    }

    #[test]
    fn 關閉共用終端裡的視窗_先結束_claude_那棵_再關窗格_不碰_mux_與自帶_gui() {
        let f = mux_fake(Some("7"));
        let allowed = kill_set_with(&f.table, 702, None, 300, &|_| None);
        assert_eq!(allowed, vec![703, 702], "mux 是 claude 的祖先，不在可結束的清單裡");
        close_session(&f, &quick(), 702, &allowed, None, false).unwrap();
        assert_eq!(*f.trace.borrow(), vec!["terminate:703".to_string(), "terminate:702".into(), "stop_mux:7".into()], "先結束 claude，再關那一個窗格");
        assert!(f.alive(700), "mux 還活著");
    }

    #[test]
    fn 關閉共用終端裡的視窗_認不出窗格或關窗格失敗_不算關閉失敗() {
        let f = mux_fake(None);
        let allowed = kill_set_with(&f.table, 702, None, 300, &|_| None);
        close_session(&f, &quick(), 702, &allowed, None, false).unwrap();
        assert_eq!(*f.trace.borrow(), vec!["terminate:703".to_string(), "terminate:702".into()], "對照表認不出這個窗格：不下任何關窗格指令");
        let mut f = mux_fake(Some("7"));
        f.stop_result = Err("沒有這個終端".into());
        let allowed = kill_set_with(&f.table, 702, None, 300, &|_| None);
        assert!(close_session(&f, &quick(), 702, &allowed, None, false).is_ok(), "claude 已經結束，窗格停在最後畫面");
    }

    #[test]
    fn 關閉舊式主控台視窗_照舊先送關閉訊息_不碰自帶終端() {
        let f = wez_fake(vec![(500, 1_000)], Some(1_000));
        let host = asn_host_of(&f, &f.table, 602);
        let allowed = kill_set_with(&f.table, 602, host, 300, &|_| None);
        close_session(&f, &quick(), 602, &allowed, host, host.is_some()).unwrap();
        let tr = f.trace.borrow();
        assert_eq!(tr.first().map(String::as_str), Some("close_window:602"), "舊式視窗照舊先送關閉訊息");
        assert!(!tr.iter().any(|x| x.starts_with("stop_wez")));
    }

    fn write_session(dir: &Path, pid: u32, sid: &str, name: &str, status: &str, cwd: &str) {
        let j = json!({ "pid": pid, "sessionId": sid, "name": name, "status": status, "cwd": cwd, "kind": "interactive", "startedAt": 1000 + pid });
        std::fs::write(dir.join(format!("{pid}.json")), serde_json::to_string(&j).unwrap()).unwrap();
    }

    struct Env {
        _tmp: tempfile::TempDir,
        dir: PathBuf,
        work: PathBuf,
    }

    fn env(status: &str) -> (Env, Fake) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let work = tmp.path().join("work dir 中文");
        std::fs::create_dir_all(&work).unwrap();
        write_session(&dir, 220, "sid-220", "小良哥", status, work.to_str().unwrap());
        // 別的視窗，名字不同
        write_session(&dir, 231, "sid-231", "別人", "idle", work.to_str().unwrap());
        let mut cmd = std::collections::HashMap::new();
        cmd.insert(220, r#""C:\Program Files\Claude\claude.exe" --dangerously-skip-permissions --model opus -n "小良哥" --remote-control "小良哥""#.to_string());
        cmd.insert(231, r#"claude.exe --model haiku"#.to_string());
        let fake = Fake {
            alive: RefCell::new([220, 221, 222, 210, 230, 231, 300].into_iter().collect()),
            cmd: RefCell::new(cmd),
            table: table(),
            terminated: RefCell::new(vec![]),
            closed: RefCell::new(vec![]),
            close_works: false,
            close_takes: vec![],
        };
        (Env { _tmp: tmp, dir, work }, fake)
    }

    fn run_req() -> SwitchRunReq {
        SwitchRunReq { name: "小良哥".into(), pid: 220, session_id: "sid-220".into(), model: "sonnet".into() }
    }

    #[test]
    fn 查詢_讀到模型與閒置() {
        let (e, f) = env("idle");
        let q = query_with(&f, &e.dir, &SwitchQueryReq { name: "小良哥".into() });
        assert!(q.ok && q.can_switch && q.idle);
        assert_eq!(q.pid, Some(220));
        assert_eq!(q.session_id.as_deref(), Some("sid-220"));
        assert_eq!(q.model.as_deref(), Some("opus"));
        let j = serde_json::to_value(&q).unwrap();
        assert_eq!(j["canSwitch"], true, "回給前端的是 camelCase");
        assert_eq!(j["sessionId"], "sid-220");
    }

    #[test]
    fn 查詢_使用者自己開的視窗與承載殼開的視窗分得出來() {
        // 預設的程序表：父殼是使用者的 pwsh，不是 ASN 承載殼
        let (e, f) = env("idle");
        let q = query_with(&f, &e.dir, &SwitchQueryReq { name: "小良哥".into() });
        assert!(q.can_switch && q.own_window, "使用者自己開的視窗");
        assert_eq!(serde_json::to_value(&q).unwrap()["ownWindow"], true);
        // 父殼是 ASN 的承載殼
        let (e, mut f) = env("idle");
        f.cmd.borrow_mut().insert(210, format!("powershell.exe {}", local::window_launcher_args("小良哥", "claude.exe", &v(&["--model", "opus"]))));
        f.table = vec![p(4, 0, "system"), p(100, 4, "explorer.exe"), p(210, 100, "powershell.exe"), p(220, 210, "claude.exe"), p(300, 100, "asn.exe")];
        let q = query_with(&f, &e.dir, &SwitchQueryReq { name: "小良哥".into() });
        assert!(q.can_switch && !q.own_window, "ASN 開的視窗");
    }

    /// 使用者自己開的視窗（沒有 ASN 的承載殼）也能切：只結束 claude 那棵，不碰使用者的殼，並照原參數接續重開
    #[test]
    fn 切換_使用者自己開的視窗_不碰使用者的殼() {
        let (e, f) = env("idle");
        let dir = e.dir.clone();
        let work = e.work.clone();
        let r = run_with(&f, &e.dir, &run_req(), &|plan| {
            assert!(plan.argv.windows(2).any(|w| w == ["--resume", "sid-220"]));
            write_session(&dir, 503, "sid-220", &plan.name, "idle", work.to_str().unwrap());
            f.alive.borrow_mut().insert(503);
            Ok(())
        }, &quick());
        assert_eq!(r["ok"], true, "{r}");
        let killed = f.terminated.borrow().clone();
        assert!(killed.contains(&220) && !killed.contains(&210) && !killed.contains(&200), "{killed:?}");
    }

    /// 「Gemini審查」審查指出（我核對過成立）：run_with 把 close_session 的 polite 寫死 true，使用者自己開的視窗（沒有 ASN 承載殼）
    /// 也會被送 WM_CLOSE，而 close_session 的說明與 partner_ops／codex_ops 都是 host.is_some()——那種視窗不送關閉訊息，免得把使用者的終端機一起關掉
    #[test]
    fn 切換_使用者自己開的視窗_不送關閉訊息_只結束_claude_那棵() {
        let (e, f) = env("idle");
        let dir = e.dir.clone();
        let work = e.work.clone();
        let r = run_with(&f, &e.dir, &run_req(), &|plan| {
            write_session(&dir, 503, "sid-220", &plan.name, "idle", work.to_str().unwrap());
            f.alive.borrow_mut().insert(503);
            Ok(())
        }, &quick());
        assert_eq!(r["ok"], true, "{r}");
        assert!(f.closed.borrow().is_empty(), "使用者自己開的視窗不能送關閉訊息（會把他的終端機一起關掉）：{:?}", f.closed.borrow());
        assert!(f.terminated.borrow().contains(&220), "要改成直接結束 claude 那棵");
    }

    #[test]
    fn 切換_asn_開的視窗_才先送關閉訊息() {
        let (e, mut f) = env("idle");
        f.cmd.borrow_mut().insert(210, format!("powershell.exe {}", local::window_launcher_args("小良哥", "claude.exe", &v(&["--model", "opus"]))));
        f.table = vec![p(4, 0, "system"), p(100, 4, "explorer.exe"), p(210, 100, "powershell.exe"), p(220, 210, "claude.exe"), p(300, 100, "asn.exe")];
        let dir = e.dir.clone();
        let work = e.work.clone();
        let r = run_with(&f, &e.dir, &run_req(), &|plan| {
            write_session(&dir, 503, "sid-220", &plan.name, "idle", work.to_str().unwrap());
            f.alive.borrow_mut().insert(503);
            Ok(())
        }, &quick());
        assert_eq!(r["ok"], true, "{r}");
        assert!(f.closed.borrow().contains(&220), "ASN 開的視窗（有承載殼）照舊先送關閉訊息：{:?}", f.closed.borrow());
    }

    #[test]
    fn 查詢_沒指定模型_model欄位不出現() {
        let (e, f) = env("idle");
        f.cmd.borrow_mut().insert(220, "claude.exe -n 小良哥".into());
        let q = query_with(&f, &e.dir, &SwitchQueryReq { name: "小良哥".into() });
        assert!(q.can_switch && q.model.is_none());
        assert!(serde_json::to_value(&q).unwrap().get("model").is_none());
    }

    #[test]
    fn 查詢_忙碌不閒置_有原因() {
        let (e, f) = env("busy");
        let q = query_with(&f, &e.dir, &SwitchQueryReq { name: "小良哥".into() });
        assert!(q.can_switch && !q.idle);
        assert!(q.reason.unwrap().contains("閒置"));
    }

    #[test]
    fn 查詢_找不到_讀不到命令列_不是claude() {
        let (e, f) = env("idle");
        assert!(!query_with(&f, &e.dir, &SwitchQueryReq { name: "沒這個人".into() }).can_switch);
        assert!(!query_with(&f, &e.dir, &SwitchQueryReq { name: "".into() }).ok);
        f.cmd.borrow_mut().remove(&220);
        let q = query_with(&f, &e.dir, &SwitchQueryReq { name: "小良哥".into() });
        assert!(!q.can_switch && q.reason.unwrap().contains("啟動參數"));
        f.cmd.borrow_mut().insert(220, "notepad.exe".into());
        let q = query_with(&f, &e.dir, &SwitchQueryReq { name: "小良哥".into() });
        assert!(!q.can_switch && q.reason.unwrap().contains("不是 Claude"));
    }

    #[test]
    fn 切換_忙碌時拒絕_什麼都不殺() {
        let (e, f) = env("busy");
        let r = run_with(&f, &e.dir, &run_req(), &|_| panic!("不該重開"), &quick());
        assert_eq!(r["ok"], false);
        assert_eq!(r["stage"], "check");
        assert!(f.terminated.borrow().is_empty() && f.closed.borrow().is_empty());
    }

    #[test]
    fn 切換_編號或名字或pid對不上_拒絕() {
        let (e, f) = env("idle");
        let mut r = run_req();
        r.session_id = "別的編號".into();
        assert_eq!(run_with(&f, &e.dir, &r, &|_| panic!(), &quick())["stage"], "check");
        let mut r = run_req();
        r.pid = 999;
        assert_eq!(run_with(&f, &e.dir, &r, &|_| panic!(), &quick())["stage"], "check");
        let mut r = run_req();
        r.name = "別人".into(); // pid 220 的名字是小良哥
        assert_eq!(run_with(&f, &e.dir, &r, &|_| panic!(), &quick())["stage"], "check");
        let mut r = run_req();
        r.model = "opus; rm -rf".into();
        assert_eq!(run_with(&f, &e.dir, &r, &|_| panic!(), &quick())["stage"], "check");
        assert!(f.terminated.borrow().is_empty());
    }

    #[test]
    fn 切換_不碰自己() {
        let (e, f) = env("idle");
        write_session(&e.dir, 300, "sid-300", "ASN", "idle", e.work.to_str().unwrap());
        f.cmd.borrow_mut().insert(300, "claude.exe".into());
        let r = run_with(&f, &e.dir, &SwitchRunReq { name: "ASN".into(), pid: 300, session_id: "sid-300".into(), model: "opus".into() }, &|_| panic!(), &quick());
        assert_eq!(r["ok"], false);
        assert!(f.terminated.borrow().is_empty());
    }

    #[test]
    fn 切換_成功_只殺目標那棵_並照新參數重開() {
        let (e, f) = env("idle");
        let dir = e.dir.clone();
        let launched: RefCell<Option<Vec<String>>> = RefCell::new(None);
        let r = {
            let launch = |plan: &Plan| -> Result<(), String> {
                assert!(plan.in_wt);
                assert_eq!(plan.cwd, e.work);
                *launched.borrow_mut() = Some(plan.argv.clone());
                // 模擬新視窗起來：寫新的工作階段、程序活著
                write_session(&dir, 500, "sid-220", &plan.name, "idle", e.work.to_str().unwrap());
                f.alive.borrow_mut().insert(500);
                Ok(())
            };
            run_with(&f, &e.dir, &run_req(), &launch, &quick())
        };
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["newPid"], 500);
        // 只結束 220 底下那棵（222、221、220），沒有碰 210（使用者的殼）、230、231、200
        assert_eq!(*f.terminated.borrow(), vec![222, 221, 220]);
        for keep in [210u32, 230, 231, 200, 300] {
            assert!(!f.terminated.borrow().contains(&keep), "{keep}");
        }
        let argv = launched.borrow().clone().unwrap();
        assert_eq!(argv[0], r"C:\Program Files\Claude\claude.exe");
        assert_eq!(current_model(&argv), Some("sonnet".into()));
        let pos = argv.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(argv[pos + 1], "sid-220");
        assert!(argv.windows(2).any(|w| w == ["-n", "小良哥"]));
        assert!(argv.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(r["manual"].as_str().unwrap().contains("'--model' 'sonnet'"));
    }

    #[test]
    fn 切換_送關閉訊息後視窗走了_就不再強殺() {
        let (e, mut f) = env("idle");
        f.close_works = true;
        // 不在 WT：目標的父殼是 ASN 承載殼 210（改命令列）
        let args = v(&["--model", "opus"]);
        f.cmd.borrow_mut().insert(210, format!("powershell.exe {}", local::window_launcher_args("小良哥", "claude.exe", &args)));
        f.table = vec![p(4, 0, "system"), p(100, 4, "explorer.exe"), p(210, 100, "powershell.exe"), p(220, 210, "claude.exe"), p(231, 100, "claude.exe"), p(300, 100, "asn.exe")];
        f.close_takes = vec![210];
        let dir = e.dir.clone();
        let work = e.work.clone();
        let r = run_with(
            &f,
            &e.dir,
            &run_req(),
            &|plan| {
                assert!(!plan.in_wt);
                write_session(&dir, 501, "sid-220", &plan.name, "idle", work.to_str().unwrap());
                f.alive.borrow_mut().insert(501);
                Ok(())
            },
            &quick(),
        );
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(*f.closed.borrow(), vec![220]);
        assert!(f.terminated.borrow().is_empty(), "視窗關了就不該再強殺：{:?}", f.terminated.borrow());
    }

    #[test]
    fn 切換_父殼是asn承載殼_一起收() {
        let (e, mut f) = env("idle");
        let args = v(&["--model", "opus"]);
        f.cmd.borrow_mut().insert(210, format!("powershell.exe {}", local::window_launcher_args("小良哥", "claude.exe", &args)));
        f.table = vec![p(4, 0, "system"), p(100, 4, "explorer.exe"), p(210, 100, "powershell.exe"), p(220, 210, "claude.exe"), p(231, 100, "claude.exe"), p(300, 100, "asn.exe")];
        let dir = e.dir.clone();
        let work = e.work.clone();
        let r = run_with(
            &f,
            &e.dir,
            &run_req(),
            &|plan| {
                write_session(&dir, 502, "sid-220", &plan.name, "idle", work.to_str().unwrap());
                f.alive.borrow_mut().insert(502);
                Ok(())
            },
            &quick(),
        );
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(*f.terminated.borrow(), vec![220, 210]);
    }

    #[test]
    fn 切換_一般殼不是asn承載殼_不收() {
        let (e, f) = env("idle");
        f.cmd.borrow_mut().insert(210, "pwsh.exe -NoLogo".into());
        let dir = e.dir.clone();
        let work = e.work.clone();
        let r = run_with(
            &f,
            &e.dir,
            &run_req(),
            &|plan| {
                write_session(&dir, 503, "sid-220", &plan.name, "idle", work.to_str().unwrap());
                f.alive.borrow_mut().insert(503);
                Ok(())
            },
            &quick(),
        );
        assert_eq!(r["ok"], true);
        assert!(!f.terminated.borrow().contains(&210));
    }

    #[test]
    fn 切換_重開失敗_給手動指令_並標示原視窗已關() {
        let (e, f) = env("idle");
        let r = run_with(&f, &e.dir, &run_req(), &|_| Err("wt 壞了".into()), &quick());
        assert_eq!(r["ok"], false);
        assert_eq!(r["stage"], "launch");
        assert_eq!(r["closed"], true);
        assert!(r["manual"].as_str().unwrap().contains("--resume"));
        assert!(r["reason"].as_str().unwrap().contains("wt 壞了"));
    }

    #[test]
    fn 切換_新對話一直沒出現_回報驗證失敗() {
        let (e, f) = env("idle");
        let r = run_with(&f, &e.dir, &run_req(), &|_| Ok(()), &quick());
        assert_eq!(r["ok"], false);
        assert_eq!(r["stage"], "verify");
        assert!(!r["manual"].as_str().unwrap().is_empty());
    }

    #[test]
    fn 切換_名字不同的新對話不算成功() {
        let (e, f) = env("idle");
        let dir = e.dir.clone();
        let work = e.work.clone();
        let r = run_with(
            &f,
            &e.dir,
            &run_req(),
            &|_| {
                write_session(&dir, 504, "sid-220", "另一個名字", "idle", work.to_str().unwrap());
                f.alive.borrow_mut().insert(504);
                Ok(())
            },
            &quick(),
        );
        assert_eq!(r["ok"], false);
        assert_eq!(r["stage"], "verify");
    }

    #[test]
    fn 切換_原程序殺不掉_不重開() {
        struct Stubborn(Fake);
        impl Os for Stubborn {
            fn cmdline(&self, pid: u32) -> Option<String> { self.0.cmdline(pid) }
            fn processes(&self) -> Vec<Proc> { self.0.processes() }
            fn alive(&self, pid: u32) -> bool { pid == 220 || self.0.alive(pid) }
            fn close_window(&self, _pid: u32) -> bool { false }
            fn terminate(&self, _pid: u32) -> Result<(), String> { Ok(()) }
            fn own_pid(&self) -> u32 { 300 }
            fn sleep(&self, _ms: u64) {}
        }
        let (e, f) = env("idle");
        let s = Stubborn(f);
        let r = run_with(&s, &e.dir, &run_req(), &|_| panic!("原程序還在，不能重開"), &quick());
        assert_eq!(r["ok"], false);
        assert_eq!(r["stage"], "close");
        assert_eq!(r["closed"], false);
    }

    #[test]
    fn 工作資料夾不存在_拒絕() {
        let (e, f) = env("idle");
        write_session(&e.dir, 220, "sid-220", "小良哥", "idle", r"Z:\ASN-不存在-xyz");
        let r = run_with(&f, &e.dir, &run_req(), &|_| panic!(), &quick());
        assert_eq!(r["stage"], "check");
        assert!(f.terminated.borrow().is_empty());
    }

    // ---- 真機手動測試（假主控台程式）

    /// 真機手動測試：用 ping.exe 當假的 Claude（命令列長得像 claude 的參數），
    /// 驗證「Win32 讀別的程序命令列 → 解析 → 只結束指定 PID → 照新參數重開 → 確認新舊 pid」整條路。
    /// 全程只結束自己啟動並記下 PID 的程序。
    /// 執行：cargo test --manifest-path src-tauri/Cargo.toml -- --ignored 真機_ --nocapture
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn 真機_讀命令列_結束_重開() {
        // 會在桌面上開出真的視窗，只准人手動跑
        if std::env::var("ASN_MANUAL_TEST").as_deref() != Ok("1") { eprintln!("略過：要手動跑請設 ASN_MANUAL_TEST=1"); return; }
        use crate::nowin::NoWindow;
        use std::process::Command;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let work = tmp.path().join("工作 資料夾");
        std::fs::create_dir_all(&work).unwrap();

        struct Reap(Vec<u32>);
        impl Drop for Reap {
            fn drop(&mut self) {
                for p in &self.0 {
                    let _ = winapi::terminate(*p);
                }
            }
        }
        let mut reap = Reap(vec![]);

        // 假 Claude：一支只會睡 60 秒的 PowerShell 腳本，命令列帶一串像 claude 的參數（含空白與中文的名字）
        let script = tmp.path().join("fake-claude.ps1");
        std::fs::write(&script, "Start-Sleep -Seconds 60\n").unwrap();
        let child = Command::new("powershell.exe")
            .no_window()
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(["--model", "opus", "-n", "假 小良", "--resume", "old-sid"])
            .spawn()
            .expect("開假程式");
        let pid = child.id();
        reap.0.push(pid);
        std::mem::forget(child);
        std::thread::sleep(Duration::from_millis(1500));

        // 1. 讀命令列
        let line = winapi::cmdline_of(pid).expect("讀得到命令列");
        println!("命令列：{line}");
        let args = parse_cmdline(&line);
        assert!(args[0].to_lowercase().ends_with("powershell.exe"), "{args:?}");
        assert_eq!(current_model(&args), Some("opus".into()), "{args:?}");
        assert!(args.contains(&"假 小良".to_string()));

        // 2. 改寫參數（假程式不是 claude，所以直接測改寫、守門、結束、重開，不經 resolve）
        let new_args = rewrite_args(&args, "sid-real", "假 小良", "haiku");
        assert_eq!(current_model(&new_args), Some("haiku".into()));
        assert!(!new_args.contains(&"old-sid".to_string()));

        // 3. 守門：用真的程序表算允許清單，只含這個 pid 與它的後代
        let table = winapi::process_table();
        let own = std::process::id();
        let allowed = kill_set(&table, pid, None, own);
        println!("允許結束：{allowed:?}");
        assert!(allowed.contains(&pid) && !allowed.contains(&own));
        let desc: Vec<u32> = table.iter().filter(|p| p.ppid == pid).map(|p| p.pid).collect();
        for d in &desc {
            assert!(allowed.contains(d), "後代 {d} 要在允許清單");
        }
        for pid_ in &allowed {
            winapi::terminate(*pid_).unwrap();
        }
        std::thread::sleep(Duration::from_millis(500));
        assert!(!console::win::pid_alive(pid), "原程序應該已經消失");
        assert!(console::win::pid_alive(own), "自己不能被殺");

        // 4. 重開：走跟 App 一樣的 powershell -NoExit 承載（程式換成 cmd，帶新參數的 ping 部分）
        let host = local::start_window("假 小良", "cmd.exe", &["/d".into(), "/c".into(), "ping -n 60 127.0.0.1 >nul".into()], &work, true).expect("重開");
        reap.0.push(host);
        std::thread::sleep(Duration::from_millis(800));
        assert!(console::win::pid_alive(host), "新承載殼應該活著");
        let host_line = winapi::cmdline_of(host).expect("讀得到承載殼命令列");
        assert!(is_asn_host_cmdline(&host_line), "{host_line}");
        // 5. 收掉自己開的：承載殼底下的整棵
        let table = winapi::process_table();
        for k in kill_set(&table, host, None, own) {
            let _ = winapi::terminate(k);
        }
        std::thread::sleep(Duration::from_millis(400));
        assert!(!console::win::pid_alive(host));
    }

    // ---- 讀程序的工作資料夾（方案 B：接手使用者自己開的 pi 要靠它找對話）----
    #[test]
    fn 工作資料夾正規化() {
        assert_eq!(normalize_cwd(r"C:\Users\alice"), r"C:\Users\alice");
        assert_eq!(normalize_cwd(r"C:\Users\alice\"), r"C:\Users\alice", "去尾端斜線");
        assert_eq!(normalize_cwd("D:/x/y/"), "D:/x/y", "正斜線也去");
        assert_eq!(normalize_cwd(r"\\?\C:\work"), r"C:\work", "去 verbatim 前綴");
        assert_eq!(normalize_cwd(r"C:\"), r"C:\", "磁碟根目錄保留一條斜線");
        assert_eq!(normalize_cwd("  C:/  "), r"C:\");
        assert_eq!(normalize_cwd(""), "");
        assert_eq!(normalize_cwd("/"), "", "只有斜線＝空（呼叫端當讀不到）");
    }

    #[test]
    fn os_的_cwd_預設讀不到_現有的假_os_不用改() {
        // 只實作必要的方法、沒寫 cwd 的 Os：照樣編得過，cwd 回 None
        struct Bare;
        impl Os for Bare {
            fn cmdline(&self, _pid: u32) -> Option<String> {
                None
            }
            fn processes(&self) -> Vec<Proc> {
                vec![]
            }
            fn alive(&self, _pid: u32) -> bool {
                false
            }
            fn close_window(&self, _pid: u32) -> bool {
                false
            }
            fn terminate(&self, _pid: u32) -> Result<(), String> {
                Ok(())
            }
        }
        assert_eq!(Bare.cwd(1), None);
    }

    /// 真的讀：自己、以及自己開的子程序（指定了工作資料夾）。只動自己啟動的程序
    #[cfg(windows)]
    #[test]
    fn 讀自己與子程序的工作資料夾() {
        use crate::nowin::NoWindow;
        let mine = std::env::current_dir().unwrap();
        let got = winapi::cwd_of(std::process::id()).expect("讀得到自己的");
        assert_eq!(normalize_cwd(&mine.to_string_lossy()).to_lowercase(), got.to_lowercase());
        let d = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("cmd").args(["/c", "ping", "-n", "30", "127.0.0.1"]).current_dir(d.path()).stdout(std::process::Stdio::null()).no_window().spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(600));
        let want = normalize_cwd(&d.path().to_string_lossy()).to_lowercase();
        let child_cwd = winapi::cwd_of(child.id());
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(child_cwd.map(|c| c.to_lowercase()), Some(want), "子程序的工作資料夾");
        assert_eq!(winapi::cwd_of(child.id()), None, "程序結束後讀不到");
        assert_eq!(winapi::cwd_of(0), None);
    }
}
