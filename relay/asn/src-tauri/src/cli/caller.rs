//! 本機視窗身分（對應 relay/machine/identity.mjs 與 engines/claude-identity.mjs）：
//! 寄件／收件視窗名不能自填，由「呼叫者所在的 Claude 視窗」決定——
//! 1. 沿父行程鏈往上，第一個在 ~/.claude/sessions/<pid>.json 登記過的程序就是呼叫者所在的 claude 視窗；
//! 2. 鏈上找不到（nohup／背景化後父行程已消失）時，用 Claude Code 對 Bash 指令匯出的 CLAUDE_CODE_MESSAGING_SOCKET
//!    對上某個還活著的 session 的 messagingSocketPath。獨立啟動的程式沒有這個環境變數。
use super::env::{Env, ProcTable};
use super::{Fail, R};
use crate::relay::Relay;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct Caller {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Default, Clone)]
pub struct ChainItem {
    pub pid: u32,
    pub name: String,
    /// 這個程序在 sessions 登記的視窗名（沒名字顯示「(無名)」）；沒登記＝None
    pub session: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Evidence {
    pub chain: Vec<ChainItem>,
    pub table_error: Option<String>,
    pub via_chain: Option<Caller>,
    pub via_env: Option<Caller>,
    pub env_socket: String,
}

/// 一個 session 檔：pid 要和檔名一致
pub fn read_session(dir: &Path, pid: u32) -> Option<Value> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{pid}.json"))).ok()?).ok()?;
    (v.get("pid").and_then(Value::as_u64) == Some(pid as u64)).then_some(v)
}

fn session_name(s: &Value) -> String {
    s.get("name").and_then(Value::as_str).map(|n| n.trim().to_string()).unwrap_or_default()
}

pub fn inspect(env: &Env) -> Evidence {
    let mut ev = Evidence { env_socket: env.socket.clone().unwrap_or_default(), ..Default::default() };
    let table: Option<ProcTable> = match (env.procs)() {
        Ok(t) => Some(t),
        Err(e) => {
            ev.table_error = Some(e);
            None
        }
    };
    if let Some(table) = &table {
        let mut pid = table.get(&env.self_pid).map(|x| x.0).unwrap_or(0);
        let mut hops = 0;
        while pid != 0 && hops < 40 {
            let s = read_session(&env.sessions_dir, pid);
            ev.chain.push(ChainItem {
                pid,
                name: table.get(&pid).map(|x| x.1.clone()).unwrap_or_else(|| "(已結束)".into()),
                session: s.as_ref().map(|s| Some(session_name(s)).filter(|n| !n.is_empty()).unwrap_or_else(|| "(無名)".into())),
            });
            if let Some(s) = s {
                ev.via_chain = Some(Caller { pid, name: session_name(&s) });
                break;
            }
            match table.get(&pid) {
                Some(x) => pid = x.0,
                None => break,
            }
            hops += 1;
        }
    }
    if !ev.env_socket.is_empty() {
        if let Ok(rd) = std::fs::read_dir(&env.sessions_dir) {
            let mut pids: Vec<u32> = rd
                .flatten()
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).and_then(|s| if s.bytes().all(|b| b.is_ascii_digit()) { s.parse().ok() } else { None }))
                .collect();
            pids.sort_unstable();
            for pid in pids {
                if let Some(s) = read_session(&env.sessions_dir, pid) {
                    if s.get("messagingSocketPath").and_then(Value::as_str) == Some(ev.env_socket.as_str()) && (env.alive)(pid) {
                        ev.via_env = Some(Caller { pid, name: session_name(&s) });
                        break;
                    }
                }
            }
        }
    }
    ev
}

/// 認出呼叫者；what＝「寄信」「收信」「查群組」，只影響錯誤訊息的用詞
pub fn find_caller(env: &Env, what: &str) -> R<Caller> {
    let ev = inspect(env);
    if let Some(hit) = ev.via_chain.clone().or(ev.via_env.clone()) {
        if hit.name.is_empty() {
            let role = if what == "收信" { "收件人" } else { "寄件人" };
            return Err(Fail::new(2, format!("找到 claude 視窗（pid {}）但它沒有名字，無法當{role}；請先 /rename", hit.pid)));
        }
        return Ok(hit);
    }
    // 無人值守的收件匣節點（Linux、環境變數與收件匣資料夾皆具備）：寄件視窗＝收件匣名，只准寄信與發言／查群組。
    // 視窗名只取 ASN_INBOX_NAME（沒設＝節點代號），命令列沒有任何參數能改；收信（recv）不開放，免得和橋搶信。
    if env.unattended && matches!(what, "寄信" | "查群組") {
        let name = match env.inbox_name.clone() {
            Some(n) => n,
            None => identity(env, false)?.node,
        };
        return Ok(Caller { pid: env.self_pid, name });
    }
    let why = ev.table_error.map(|e| format!("；讀行程表失敗：{e}")).unwrap_or_default();
    Err(Fail::new(2, format!("拒絕：找不到呼叫者所屬的 Claude 視窗（只有在 Claude 視窗裡執行才能{what}）{why}\n除錯：加 --whoami 看父行程鏈與 session 對照")))
}

/// 機器節點、金鑰、後台網址、門鈴金鑰
pub struct Ident {
    pub node: String,
    pub base_url: String,
    pub key: String,
    pub anon: Option<String>,
    pub work_dir: std::path::PathBuf,
}

pub fn identity(env: &Env, need_key: bool) -> R<Ident> {
    let alive = env.alive.clone();
    let base_url = crate::identity::base_url(env.relay_url.clone());
    // 主要位置找不到的項目回頭找後備位置（遷移被打斷時，Claude 外掛的 asn_send 走這裡，不能因此寄不出信）
    let (node, key, anon) = crate::identity::resolve_parts(
        &env.relay_home,
        env.relay_home_fallback.as_deref(),
        env.relay_id.clone(),
        env.relay_key.clone(),
        env.anon_key.clone(),
        &base_url,
        need_key,
        &move |p| alive(p),
    )
    .map_err(|e| Fail::new(1, e))?;
    let work_dir = crate::identity::work_dir(&env.relay_home, &node);
    Ok(Ident { node, base_url, key, anon, work_dir })
}

/// 後端錯誤字串（形如「send HTTP 404 not_found」）→ 結束碼 4
pub fn backend(e: String) -> Fail {
    if e.contains("連線失敗") {
        Fail::new(4, format!("錯誤：{e}"))
    } else {
        Fail::new(4, e)
    }
}

/// 從「action HTTP 403 forbidden」取狀態碼
pub fn http_status(e: &str) -> Option<u16> {
    let i = e.find("HTTP ")?;
    e[i + 5..].split_whitespace().next()?.parse().ok()
}

pub fn relay(id: &Ident, window: &str) -> Relay {
    Relay::new(id.base_url.clone(), id.key.clone(), id.node.clone(), window.to_string())
}

// ---- 行程表 ---------------------------------------------------------------------------------------------

#[cfg(windows)]
pub fn process_table() -> Result<ProcTable, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    let mut out = ProcTable::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err(format!("CreateToolhelp32Snapshot 失敗：{}", std::io::Error::last_os_error()));
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            out.insert(e.th32ProcessID, (e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    Ok(out)
}

#[cfg(not(windows))]
pub fn process_table() -> Result<ProcTable, String> {
    let mut out = ProcTable::new();
    let rd = std::fs::read_dir("/proc").map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
        // 格式：pid (comm) state ppid …；comm 可能含空白與括號，以第一個「(」與最後一個「)」框住
        let (Some(l), Some(r)) = (stat.find('('), stat.rfind(')')) else { continue };
        if let Some(ppid) = stat[r + 1..].split_whitespace().nth(1).and_then(|s| s.parse::<u32>().ok()) {
            out.insert(pid, (ppid, stat[l + 1..r].to_string()));
        }
    }
    Ok(out)
}

/// --whoami 的輸出
pub fn whoami(env: &Env, io: &mut super::Io) {
    let ev = inspect(env);
    let ppid = (env.procs)().ok().and_then(|t| t.get(&env.self_pid).map(|x| x.0)).unwrap_or(0);
    io.outln(&format!("asn pid={} ppid={ppid} platform={} home={}", env.self_pid, std::env::consts::OS, crate::identity::home_dir().display()));
    io.outln(&format!("CLAUDE_CODE_MESSAGING_SOCKET={}", if ev.env_socket.is_empty() { "(未設)" } else { &ev.env_socket }));
    if let Some(e) = &ev.table_error {
        io.outln(&format!("行程表讀取失敗：{e}"));
    }
    io.outln("父行程鏈（由近到遠）：");
    for c in &ev.chain {
        io.outln(&format!("  pid={} {}{}", c.pid, c.name, c.session.as_ref().map(|s| format!("  <== session「{s}」")).unwrap_or_default()));
    }
    let show = |c: &Option<Caller>| match c {
        Some(c) => format!("pid={} name={}", c.pid, if c.name.is_empty() { "(無名)" } else { &c.name }),
        None => "無".into(),
    };
    io.outln(&format!("判定（行程鏈）：{}", show(&ev.via_chain)));
    io.outln(&format!("判定（環境變數備援）：{}", show(&ev.via_env)));
    io.outln("~/.claude/sessions：");
    if let Ok(rd) = std::fs::read_dir(&env.sessions_dir) {
        let mut pids: Vec<u32> = rd.flatten().filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).and_then(|s| s.parse().ok())).collect();
        pids.sort_unstable();
        for pid in pids {
            if let Some(s) = read_session(&env.sessions_dir, pid) {
                let g = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or("?").to_string();
                io.outln(&format!("  pid={pid} name={} kind={} entrypoint={}", s.get("name").and_then(Value::as_str).unwrap_or("(無名)"), g("kind"), g("entrypoint")));
            }
        }
    }
    match identity(env, false) {
        Ok(i) => io.outln(&format!("機器節點判定：{}", i.node)),
        Err(e) => io.outln(&format!("機器節點判定失敗：{}", e.msg)),
    }
}
