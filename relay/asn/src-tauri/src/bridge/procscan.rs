//! 本機「執行中代理」掃描：把正在跑的 claude -p、pi、codex、gemini（agy）、grok 程序列進名單，只供顯示。
//!
//! 名單上的名字同時是收信地址，所以這類條目一律標 `receivable:false`、`kind:"process"`，名字固定是
//! 「引擎 · 供應商 #pid」，不會和視窗名相撞；橋不會把信投給它們。
//! 判斷模型只看命令列的 `--model／-m／--provider`：不讀、不印環境變數與金鑰，拿不到就留空。
//! 程序清單由 [`system_table`] 取得（Windows：ToolHelp＋PEB 命令列；Linux：/proc）；判斷邏輯 [`scan`] 是純函式，測試用假清單。
use serde_json::{json, Value};
use std::collections::HashMap;

/// 一個程序的快照
#[derive(Clone, Debug, PartialEq)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    /// 執行檔名（不含路徑）
    pub exe: String,
    /// 命令列（含第 0 項執行檔）；讀不到就是空
    pub cmdline: Vec<String>,
}

/// 掃到的執行中代理
#[derive(Clone, Debug, PartialEq)]
pub struct ProcAgent {
    pub pid: u32,
    pub engine: String,
    /// 命令列上的模型名（已清理）
    pub model: Option<String>,
    /// 名單上顯示的供應商／模型簡稱
    pub label: Option<String>,
    /// 背景執行（無人在前面操作：-p／exec／stdio／headless／rpc 等）；否則是使用者自己在終端機開的前景互動程式
    pub background: bool,
}

/// 名單上限，避免失控時灌爆名單
pub const MAX_AGENTS: usize = 50;

impl ProcAgent {
    /// 「pi · MiniMax #1234」；沒有供應商資訊就是「pi #1234」
    pub fn name(&self) -> String {
        let place = if self.background { "背景" } else { "前景" };
        match &self.label {
            Some(l) => format!("{} · {} #{}（{place}）", self.engine, l, self.pid),
            None => format!("{} #{}（{place}）", self.engine, self.pid),
        }
    }
    pub fn to_json(&self) -> Value {
        let mut o = json!({ "name": self.name(), "status": "running", "cwd_label": "", "engine": self.engine, "kind": "process", "receivable": false });
        if let Some(m) = &self.model {
            o["model"] = json!(m);
        }
        o
    }
}

/// 是否開啟：預設開（後台已保留 kind／receivable／model，這類條目只顯示、不能收信）；`ASN_ROSTER_PROCS=0`／`false`／`off` 才關
pub fn enabled() -> bool {
    let v = crate::envc::get("ASN_ROSTER_PROCS");
    let v = v.as_deref().map(str::trim);
    // 測試裡預設關（不掃測試機器上真的程序，名單斷言才穩）；要測掃描就明寫 ASN_ROSTER_PROCS=1
    if cfg!(test) {
        return matches!(v, Some("1") | Some("true") | Some("on"));
    }
    !matches!(v, Some("0") | Some("false") | Some("off"))
}

fn exe_stem(exe: &str) -> String {
    let base = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_lowercase();
    for suf in [".exe", ".cmd", ".bat", ".js", ".mjs", ".cjs"] {
        if let Some(s) = base.strip_suffix(suf) {
            return s.to_string();
        }
    }
    base
}

const RUNTIMES: &[&str] = &["node", "nodejs", "bun", "deno", "python", "python3", "py"];

/// 要不要去讀這個執行檔的命令列（Windows 讀命令列要開程序，只對候選做）
pub fn is_candidate_exe(exe: &str) -> bool {
    let s = exe_stem(exe);
    engine_of_name(&s).is_some() || RUNTIMES.contains(&s.as_str())
}

fn engine_of_name(stem: &str) -> Option<&'static str> {
    Some(match stem {
        "claude" => "claude",
        "codex" => "codex",
        "pi" => "pi",
        "gemini" => "gemini",
        "agy" => "gemini",
        "grok" => "grok",
        _ => return None,
    })
}

/// 腳本路徑（node／bun 跑的那支）→ 引擎
fn engine_of_script(script: &str) -> Option<&'static str> {
    let p = script.replace('\\', "/").to_lowercase();
    if p.contains("/@anthropic-ai/claude-code/") || p.contains("/claude-code/") {
        return Some("claude");
    }
    if p.contains("/@openai/codex/") {
        return Some("codex");
    }
    if p.contains("/@google/gemini-cli/") {
        return Some("gemini");
    }
    if p.contains("pi-coding-agent") || p.contains("/@mariozechner/pi") {
        return Some("pi");
    }
    let base = p.rsplit('/').next().unwrap_or("");
    let stem = base.rsplit_once('.').map(|x| x.0).unwrap_or(base);
    engine_of_name(stem)
}

/// 這個程序是哪個引擎、後面的參數是什麼（不含執行檔／腳本）
fn identify(p: &ProcInfo) -> Option<(&'static str, Vec<String>)> {
    let stem = exe_stem(&p.exe);
    let rest: &[String] = p.cmdline.get(1..).unwrap_or(&[]);
    if let Some(e) = engine_of_name(&stem) {
        return Some((e, rest.to_vec()));
    }
    if RUNTIMES.contains(&stem.as_str()) {
        let i = rest.iter().position(|a| !a.starts_with('-'))?;
        let e = engine_of_script(&rest[i])?;
        return Some((e, rest[i + 1..].to_vec()));
    }
    None
}

const NON_RUN_SUBCOMMANDS: &[&str] = &["mcp", "login", "logout", "config", "install", "update", "upgrade", "doctor", "auth", "plugin", "plugins", "setup-token", "completion"];

/// 這組參數是不是真的在跑一個代理（排除 --version、--help、子指令；claude 只算 -p／--print 的非互動執行，互動視窗另有 sessions 名單）
fn is_run(engine: &str, args: &[String]) -> bool {
    if args.iter().any(|a| matches!(a.as_str(), "--version" | "-v" | "-V" | "--help" | "-h")) {
        return false;
    }
    if let Some(first) = args.first() {
        if NON_RUN_SUBCOMMANDS.contains(&first.to_lowercase().as_str()) {
            return false;
        }
    }
    if engine == "claude" {
        return args.iter().any(|a| a == "-p" || a == "--print" || a.starts_with("--print="));
    }
    true
}

/// 這組參數是不是背景（無人操作）執行：-p／--print、exec、agent stdio／headless／serve、--mode json／rpc
fn is_background(args: &[String]) -> bool {
    let has = |x: &str| args.iter().any(|a| a == x);
    has("-p")
        || has("--print")
        || args.iter().any(|a| a.starts_with("--print="))
        || matches!(args.first().map(|a| a.to_lowercase()).as_deref(), Some("exec") | Some("run") | Some("serve"))
        || (has("agent") && (has("stdio") || has("headless") || has("serve") || has("leader")))
        || args.windows(2).any(|w| w[0] == "--mode" && matches!(w[1].as_str(), "json" | "rpc" | "print"))
}

fn clean(v: &str) -> Option<String> {
    let v = v.trim();
    if v.is_empty() || v.len() > 40 || v.starts_with('-') || !v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-')) {
        return None;
    }
    Some(v.to_string())
}

fn flag_value(args: &[String], longs: &[&str], shorts: &[&str]) -> Option<String> {
    for (i, a) in args.iter().enumerate() {
        for l in longs {
            if let Some(v) = a.strip_prefix(&format!("{l}=")) {
                return clean(v);
            }
            if a == l {
                return args.get(i + 1).and_then(|v| clean(v));
            }
        }
        if shorts.contains(&a.as_str()) {
            return args.get(i + 1).and_then(|v| clean(v));
        }
    }
    None
}

/// 命令列 → (模型, 顯示簡稱)。模型或供應商含 minimax 一律顯示 MiniMax；否則有 --provider 用供應商、再不然用模型名
fn model_of(args: &[String]) -> (Option<String>, Option<String>) {
    let model = flag_value(args, &["--model"], &["-m"]);
    let provider = flag_value(args, &["--provider"], &[]);
    let hit_minimax = |s: &Option<String>| s.as_deref().map(|x| x.to_lowercase().contains("minimax")).unwrap_or(false);
    let label = if hit_minimax(&model) || hit_minimax(&provider) { Some("MiniMax".to_string()) } else { provider.clone().or_else(|| model.clone()) };
    (model, label)
}

/// 從程序清單找出執行中的代理。排除：本程序的後代（橋自己開的 worker／引擎，已在名單上）、
/// 父程序也是同引擎的子程序（npm 包裝 → node 這種重複）
pub fn scan(table: &[ProcInfo], self_pid: u32) -> Vec<ProcAgent> {
    scan_excluding(table, self_pid, &[])
}

/// 同 [`scan`]，另排除「已登記成可收信視窗」的程序（pi 擴充登記的 pid），免得同一個 pi 在名單上出現兩次：
/// skip 裡的 pid 本身，以及它往上同引擎的包裝程序（pi.cmd → node 這種）都不列
pub fn scan_excluding(table: &[ProcInfo], self_pid: u32, skip: &[u32]) -> Vec<ProcAgent> {
    let by_pid: HashMap<u32, &ProcInfo> = table.iter().map(|p| (p.pid, p)).collect();
    let ids: HashMap<u32, (&'static str, Vec<String>)> = table.iter().filter_map(|p| identify(p).filter(|(e, a)| is_run(e, a)).map(|x| (p.pid, x))).collect();
    let descends_from_self = |pid: u32| {
        let mut cur = pid;
        for _ in 0..64 {
            let Some(p) = by_pid.get(&cur) else { return false };
            if p.ppid == self_pid {
                return true;
            }
            if p.ppid == 0 || p.ppid == cur {
                return false;
            }
            cur = p.ppid;
        }
        false
    };
    let mut skipped: std::collections::HashSet<u32> = skip.iter().copied().collect();
    for s in skip {
        let mut cur = *s;
        for _ in 0..8 {
            let Some(p) = by_pid.get(&cur) else { break };
            let same = ids.get(&p.ppid).zip(ids.get(&cur)).is_some_and(|(a, b)| a.0 == b.0);
            if !same || p.ppid == cur {
                break;
            }
            skipped.insert(p.ppid);
            cur = p.ppid;
        }
    }
    let mut out: Vec<ProcAgent> = vec![];
    for p in table {
        let Some((engine, args)) = ids.get(&p.pid) else { continue };
        if p.pid == self_pid || descends_from_self(p.pid) || skipped.contains(&p.pid) {
            continue;
        }
        if ids.get(&p.ppid).map(|(e, _)| e == engine).unwrap_or(false) {
            continue;
        }
        let (model, label) = model_of(args);
        out.push(ProcAgent { pid: p.pid, engine: engine.to_string(), model, label, background: is_background(args) });
    }
    out.sort_by(|a, b| a.engine.cmp(&b.engine).then(a.pid.cmp(&b.pid)));
    out.truncate(MAX_AGENTS);
    out
}

/// 真實程序清單
pub fn system_table() -> Vec<ProcInfo> {
    imp::table()
}

/// 掃本機（真實程序）；開關沒開回空
pub fn scan_system() -> Vec<ProcAgent> {
    if !enabled() {
        return vec![];
    }
    scan(&system_table(), std::process::id())
}

/// 同 [`scan_system`]，排除已登記成可收信視窗的 pid（見 [`scan_excluding`]）
pub fn scan_system_excluding(skip: &[u32]) -> Vec<ProcAgent> {
    if !enabled() {
        return vec![];
    }
    scan_excluding(&system_table(), std::process::id(), skip)
}

#[cfg(not(windows))]
mod imp {
    use super::ProcInfo;

    pub fn table() -> Vec<ProcInfo> {
        let mut out = vec![];
        let Ok(rd) = std::fs::read_dir("/proc") else { return out };
        for e in rd.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let dir = e.path();
            let Ok(stat) = std::fs::read_to_string(dir.join("stat")) else { continue };
            let Some(ppid) = stat.rsplit_once(')').and_then(|x| x.1.split_whitespace().nth(1).and_then(|s| s.parse::<u32>().ok())) else { continue };
            let comm = std::fs::read_to_string(dir.join("comm")).unwrap_or_default().trim().to_string();
            let raw = std::fs::read(dir.join("cmdline")).unwrap_or_default();
            let cmdline: Vec<String> = raw.split(|b| *b == 0).filter(|s| !s.is_empty()).take(64).map(|s| String::from_utf8_lossy(&s[..s.len().min(4096)]).to_string()).collect();
            // comm 最多 15 字；執行檔名以命令列第 0 項的檔名為準
            let exe = cmdline.first().map(|c| c.rsplit('/').next().unwrap_or(c).to_string()).filter(|s| !s.is_empty()).unwrap_or(comm);
            out.push(ProcInfo { pid, ppid, exe, cmdline });
        }
        out
    }
}

#[cfg(windows)]
mod imp {
    use super::{is_candidate_exe, ProcInfo};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(h: *mut core::ffi::c_void, class: u32, info: *mut core::ffi::c_void, len: u32, ret: *mut u32) -> i32;
    }

    pub fn table() -> Vec<ProcInfo> {
        let mut out = vec![];
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
                let exe = String::from_utf16_lossy(&e.szExeFile[..n]);
                let cmdline = if is_candidate_exe(&exe) { read_cmdline(e.th32ProcessID).map(|c| split_cmdline(&c)).unwrap_or_default() } else { vec![] };
                out.push(ProcInfo { pid: e.th32ProcessID, ppid: e.th32ParentProcessID, exe, cmdline });
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        out
    }

    /// 讀別的程序的命令列（PEB → ProcessParameters → CommandLine）。只支援 64 位元對 64 位元；失敗回 None
    #[cfg(target_pointer_width = "64")]
    pub fn read_cmdline(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h.is_null() {
                return None;
            }
            let r = (|| {
                // PROCESS_BASIC_INFORMATION：第 2 個欄位（offset 8）是 PEB 位址
                let mut pbi = [0usize; 6];
                if NtQueryInformationProcess(h, 0, pbi.as_mut_ptr() as *mut _, std::mem::size_of_val(&pbi) as u32, std::ptr::null_mut()) != 0 || pbi[1] == 0 {
                    return None;
                }
                let rd = |addr: usize, buf: *mut u8, len: usize| ReadProcessMemory(h, addr as *const _, buf as *mut _, len, std::ptr::null_mut()) != 0;
                let mut params: usize = 0;
                if !rd(pbi[1] + 0x20, &mut params as *mut usize as *mut u8, 8) || params == 0 {
                    return None;
                }
                // RTL_USER_PROCESS_PARAMETERS.CommandLine（offset 0x70）：Length u16、MaxLength u16、填充、Buffer 指標（offset +8）
                let mut us = [0u8; 16];
                if !rd(params + 0x70, us.as_mut_ptr(), 16) {
                    return None;
                }
                let len = u16::from_le_bytes([us[0], us[1]]) as usize;
                let buf = usize::from_le_bytes(us[8..16].try_into().ok()?);
                if len == 0 || len > 32_768 || buf == 0 {
                    return None;
                }
                let mut w = vec![0u16; len / 2];
                if !rd(buf, w.as_mut_ptr() as *mut u8, len) {
                    return None;
                }
                Some(String::from_utf16_lossy(&w))
            })();
            CloseHandle(h);
            r
        }
    }
    #[cfg(not(target_pointer_width = "64"))]
    pub fn read_cmdline(_pid: u32) -> Option<String> {
        None
    }

    /// Windows 命令列切字：雙引號包住的算同一項，其餘以空白分隔
    pub fn split_cmdline(s: &str) -> Vec<String> {
        let (mut out, mut cur, mut q, mut any) = (vec![], String::new(), false, false);
        for c in s.chars() {
            match c {
                '"' => {
                    q = !q;
                    any = true;
                }
                c if c.is_whitespace() && !q => {
                    if any {
                        out.push(std::mem::take(&mut cur));
                        any = false;
                    }
                }
                c => {
                    cur.push(c);
                    any = true;
                }
            }
        }
        if any {
            out.push(cur);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: u32, exe: &str, cmd: &str) -> ProcInfo {
        ProcInfo { pid, ppid, exe: exe.into(), cmdline: cmd.split_whitespace().map(String::from).collect() }
    }

    #[test]
    fn 已登記成可收信視窗的_pi_不再列成僅顯示條目_包裝程序也排除_其他照列() {
        let t = vec![
            p(10, 1, "pi.exe", "pi --provider minimax"),
            p(11, 10, "node.exe", "node C:/n/pi-coding-agent/dist/cli.js --provider minimax"),
            p(20, 1, "node.exe", "node C:/n/pi-coding-agent/dist/cli.js -m other"),
            p(30, 1, "codex.exe", "codex exec x"),
        ];
        let base = scan(&t, 999);
        assert_eq!(base.iter().map(|a| a.pid).collect::<Vec<_>>(), vec![30, 10, 20], "沒排除時 pi 都列");
        let out = scan_excluding(&t, 999, &[11]);
        assert_eq!(out.iter().map(|a| a.pid).collect::<Vec<_>>(), vec![30, 20], "登記的 node 子程序與它的 pi 包裝都排除");
        let out = scan_excluding(&t, 999, &[20]);
        assert_eq!(out.iter().map(|a| a.pid).collect::<Vec<_>>(), vec![30, 10]);
        assert_eq!(scan_excluding(&t, 999, &[12345]).len(), 3, "不認得的 pid 不影響");
    }

    #[test]
    fn 找出_claude_p_pi_codex_gemini_含_minimax_的名稱格式() {
        let t = vec![
            p(10, 1, "bash", "bash"),
            p(11, 10, "claude.exe", "claude.exe -p 做事 --model MiniMax-M2"),
            p(12, 10, "node.exe", "node C:/x/node_modules/@mariozechner/pi-coding-agent/dist/cli.js --provider minimax"),
            p(13, 10, "pi", "pi --model glm-4.6"),
            p(14, 10, "codex", "codex exec fix"),
            p(15, 10, "node", "node /usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js"),
            p(16, 10, "agy", "agy"),
        ];
        let r = scan(&t, 999);
        let names: Vec<String> = r.iter().map(|a| a.name()).collect();
        assert_eq!(names, vec!["claude · MiniMax #11（背景）", "codex #14（背景）", "gemini #15（前景）", "gemini #16（前景）", "pi · MiniMax #12（前景）", "pi · glm-4.6 #13（前景）"]);
        assert_eq!(r[0].model.as_deref(), Some("MiniMax-M2"));
        let j = r[0].to_json();
        assert_eq!(j["receivable"], json!(false));
        assert_eq!(j["kind"], json!("process"));
        assert_eq!(j["engine"], json!("claude"));
    }

    #[test]
    fn 排除互動式_claude_版本與子指令_橋自己的後代_同引擎父子重複() {
        let t = vec![
            p(1, 0, "init", "init"),
            p(20, 1, "claude", "claude"),
            p(21, 1, "claude", "claude --version"),
            p(22, 1, "claude", "claude mcp list"),
            p(23, 1, "pi", "pi --help"),
            p(30, 1, "asn-bridge", "asn-bridge run"),
            p(31, 30, "claude", "claude -p hi"),
            p(32, 31, "claude", "claude -p nested"),
            p(40, 1, "pi", "pi"),
            p(41, 40, "node", "node /a/pi-coding-agent/cli.js"),
            p(50, 1, "node", "node server.js"),
        ];
        let r = scan(&t, 30);
        assert_eq!(r.iter().map(|a| a.pid).collect::<Vec<_>>(), vec![40]);
    }

    #[test]
    fn 模型只來自命令列_髒值與金鑰樣式不收() {
        let a = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        assert_eq!(model_of(&a("--model=minimax-m2")).1.as_deref(), Some("MiniMax"));
        assert_eq!(model_of(&a("-m gpt-5")), (Some("gpt-5".into()), Some("gpt-5".into())));
        assert_eq!(model_of(&a("--model sk-ant=secret$value")), (None, None));
        assert_eq!(model_of(&a("--model")), (None, None));
        assert_eq!(model_of(&a("--model --print")), (None, None));
        assert_eq!(model_of(&a("run")), (None, None));
    }

    #[test]
    fn 名單條目不干擾視窗_名字不同且不可收信() {
        let w = crate::bridge::roster::Window::claude("T-甲", Some("idle".into()), "", 1, 0, None);
        let procs = scan(&[p(7, 1, "pi", "pi --provider MiniMax")], 999);
        let b = crate::bridge::roster::roster_body_with_procs(&[w.clone()], None, Value::Null, &procs);
        let agents = b["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0], json!({"name":"T-甲","status":"idle","cwd_label":"","engine":"claude"}));
        assert_eq!(agents[1]["name"], json!("pi · MiniMax #7（前景）"));
        assert_eq!(agents[1]["receivable"], json!(false));
        // 沒有掃描結果時和以前一模一樣
        assert_eq!(crate::bridge::roster::roster_body(&[w], None, Value::Null)["agents"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn 上限() {
        let t: Vec<ProcInfo> = (100..300).map(|i| p(i, 1, "pi", "pi")).collect();
        assert_eq!(scan(&t, 999).len(), MAX_AGENTS);
    }

    #[cfg(windows)]
    #[test]
    fn windows_命令列切字() {
        assert_eq!(imp::split_cmdline("\"C:\\a b\\claude.exe\" -p \"hi there\" --model x"), vec!["C:\\a b\\claude.exe", "-p", "hi there", "--model", "x"]);
    }

    #[cfg(all(windows, target_pointer_width = "64"))]
    #[test]
    fn windows_讀得到自己的命令列() {
        let c = imp::read_cmdline(std::process::id()).expect("應讀得到自己的命令列");
        let first = imp::split_cmdline(&c).into_iter().next().unwrap().to_lowercase();
        let me = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().to_lowercase();
        assert!(first.ends_with(&me) || first.contains(me.trim_end_matches(".exe")), "{first}");
    }

    #[test]
    fn 真實掃描至少讀得到自己() {
        let t = system_table();
        assert!(t.iter().any(|x| x.pid == std::process::id()));
    }
}
