//! 本機「執行中代理」掃描：把正在跑的 claude -p、pi、codex、gemini（agy）、grok 程序列進名單，只供顯示。
//!
//! 名單上的名字同時是收信地址，所以這類條目一律標 `receivable:false`、`kind:"process"`，名字固定是
//! 「引擎 · 供應商 #pid」，不會和視窗名相撞；橋不會把信投給它們。
//! Windows：判斷模型只看命令列的 `--model／-m／--provider`，而且值要符合已知的模型／供應商命名才顯示，其餘一律顯示「其他模型」；
//! 不讀、不印環境變數與金鑰，拿不到就留空。
//! Linux：只看行程名稱與啟動時間（node／bun 這類執行環境才多看命令列開頭的執行檔與腳本路徑），不顯示模型、也不分前景背景。
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
    /// 啟動時間（秒，從 1970 起）；只有 Linux 的精簡讀法會帶
    pub start_secs: Option<u64>,
    /// 精簡條目（Linux）：引擎已由行程名稱或腳本路徑決定，不帶命令列，也不判斷前景背景與模型
    pub light: bool,
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
    /// 主控台視窗是否隱藏（只在確定時有值，見 roster::hidden_of）；名單只在有值時帶 hidden
    pub hidden: Option<bool>,
    /// 名單上的說明（#467：前景 pi 沒登記成可收信視窗的原因）；沒有就不帶
    pub detail: Option<String>,
    /// 不判斷前景或背景（Linux 精簡條目）：名字不帶括號
    pub place_unknown: bool,
}

/// 名單上限，避免失控時灌爆名單
pub const MAX_AGENTS: usize = 50;

impl ProcAgent {
    /// 「pi · MiniMax #1234」；沒有供應商資訊就是「pi #1234」
    pub fn name(&self) -> String {
        let place = if self.place_unknown {
            ""
        } else if self.background {
            "（背景）"
        } else {
            "（前景）"
        };
        match &self.label {
            Some(l) => format!("{} · {} #{}{place}", self.engine, l, self.pid),
            None => format!("{} #{}{place}", self.engine, self.pid),
        }
    }
    pub fn to_json(&self) -> Value {
        let mut o = json!({ "name": self.name(), "status": "running", "cwd_label": "", "engine": self.engine, "kind": "process", "receivable": false });
        if let Some(m) = &self.model {
            o["model"] = json!(m);
        }
        if let Some(h) = self.hidden {
            o["hidden"] = json!(h);
        }
        if let Some(d) = &self.detail {
            o["detail"] = json!(d); // 後台名單本來就收 detail，舊用戶端略過
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

/// 這個程序是不是 pi（直接跑 pi，或 node／bun 跑 pi 的腳本）。exe＝執行檔名；cmdline＝含第 0 項的命令列（0.2 A5 接手用）
pub fn is_pi_process(exe: &str, cmdline: &[String]) -> bool {
    identify(&ProcInfo { pid: 0, ppid: 0, exe: exe.to_string(), cmdline: cmdline.to_vec(), start_secs: None, light: false }).is_some_and(|(e, _)| e == "pi")
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

/// 模型名稱的已知命名：第一組要「整個等於」或「接著分隔字元（- . : / _）」，避免一串亂碼剛好以 o3、gpt 開頭；
/// 第二組是常見的連寫命名（glm4.6、qwen3-coder、kimi-k2、deepseek-v3），用開頭判斷（minimax-m2、MiniMax-Text-01 也是）。
/// 比對前一律轉小寫，並只看最後一個「/」之後（anthropic/claude-opus-4 這種寫法）。
const MODEL_DELIMITED_BASES: &[&str] = &["claude", "opus", "sonnet", "haiku", "gpt", "o3", "o4", "gemini", "grok"];
const MODEL_LOOSE_PREFIXES: &[&str] = &["glm", "deepseek", "qwen", "kimi", "minimax"];
/// 已知的供應商名稱（小寫）；等於它，或接著分隔字元（minimax-cn、google-vertex）才算
const KNOWN_PROVIDERS: &[&str] = &["anthropic", "openai", "google", "gemini", "xai", "minimax", "zhipu", "zai", "deepseek", "moonshot", "mistral", "openrouter", "groq", "ollama", "azure", "bedrock"];
/// 命令列上有給模型或供應商，但不是已知命名時，名單上顯示的簡稱（原值不送、不記錄）
pub const OTHER_MODEL_LABEL: &str = "其他模型";

fn starts_delimited(v: &str, base: &str) -> bool {
    v == base || v.strip_prefix(base).is_some_and(|r| r.starts_with(['-', '.', ':', '/', '_']))
}

fn known_model(v: &str) -> bool {
    let lower = v.to_lowercase();
    let last = lower.rsplit('/').next().unwrap_or(&lower);
    MODEL_DELIMITED_BASES.iter().any(|b| starts_delimited(last, b)) || MODEL_LOOSE_PREFIXES.iter().any(|p| last.starts_with(p))
}

fn known_provider(v: &str) -> bool {
    let lower = v.to_lowercase();
    KNOWN_PROVIDERS.iter().any(|p| starts_delimited(&lower, p))
}

/// 旗標後面的原始值（沒給值、或值是另一個旗標就是 None）。只在本機判斷用，呼叫端不得送出或記錄
fn flag_raw<'a>(args: &'a [String], longs: &[&str], shorts: &[&str]) -> Option<&'a str> {
    let ok = |v: &'a str| Some(v.trim()).filter(|v| !v.is_empty() && !v.starts_with('-'));
    for (i, a) in args.iter().enumerate() {
        for l in longs {
            if let Some(v) = a.strip_prefix(&format!("{l}=")) {
                return ok(v);
            }
            if a == l {
                return args.get(i + 1).and_then(|v| ok(v));
            }
        }
        if shorts.contains(&a.as_str()) {
            return args.get(i + 1).and_then(|v| ok(v));
        }
    }
    None
}

/// 命令列 → (模型, 顯示簡稱)。只有符合已知命名的模型才送出；（已通過白名單的）模型或供應商含 minimax 一律顯示 MiniMax；
/// 否則有（已知的）供應商用供應商、再不然用模型名；有給但不是已知命名就顯示「其他模型」，原值不留
fn model_of(args: &[String]) -> (Option<String>, Option<String>) {
    let raw_model = flag_raw(args, &["--model"], &["-m"]);
    let raw_provider = flag_raw(args, &["--provider"], &[]);
    let model = raw_model.and_then(clean).filter(|m| known_model(m));
    let provider = raw_provider.and_then(clean).filter(|p| known_provider(p));
    let hit_minimax = |s: &Option<String>| s.as_deref().map(|x| x.to_lowercase().contains("minimax")).unwrap_or(false);
    let label = if hit_minimax(&model) || hit_minimax(&provider) {
        Some("MiniMax".to_string())
    } else if let Some(l) = provider.clone().or_else(|| model.clone()) {
        Some(l)
    } else if raw_model.is_some() || raw_provider.is_some() {
        Some(OTHER_MODEL_LABEL.to_string())
    } else {
        None
    };
    (model, label)
}

/// 秒（1970 起）→「月-日 時:分」（UTC）
fn fmt_utc(secs: u64) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // 由天數換算月日（公曆，Howard Hinnant 的 civil_from_days）
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{m:02}-{d:02} {:02}:{:02}", rem / 3600, rem % 3600 / 60)
}

/// 精簡條目的名單說明（Linux）：偵測到、未接管，帶啟動時間
fn detected_detail(start_secs: Option<u64>) -> String {
    match start_secs {
        Some(s) => format!("偵測到，未接管 · 啟動 {} UTC", fmt_utc(s)),
        None => "偵測到，未接管".to_string(),
    }
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
    let ids: HashMap<u32, (&'static str, Vec<String>)> = table.iter().filter_map(|p| identify(p).filter(|(e, a)| p.light || is_run(e, a)).map(|x| (p.pid, x))).collect();
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
        if p.light {
            // 精簡條目（Linux）：沒有參數資訊，不判斷模型與前景背景
            out.push(ProcAgent { pid: p.pid, engine: engine.to_string(), model: None, label: None, background: false, hidden: None, detail: Some(detected_detail(p.start_secs)), place_unknown: true });
            continue;
        }
        let (model, label) = model_of(args);
        out.push(ProcAgent { pid: p.pid, engine: engine.to_string(), model, label, background: is_background(args), hidden: None, detail: None, place_unknown: false });
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
    use super::{engine_of_name, engine_of_script, exe_stem, ProcInfo, RUNTIMES};
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    /// node／bun 這類執行環境才讀命令列，而且只讀開頭這麼多位元組
    const CMDLINE_PREFIX: usize = 512;

    /// uid 讀不到時用的值：沒有程序屬於它，等於一個代理都不列（寧可漏列，不把別人的程序送出去）
    const NO_OWNER: u32 = u32::MAX;

    pub fn table() -> Vec<ProcInfo> {
        let root = Path::new("/proc");
        let me = std::fs::metadata(root.join("self")).map(|m| m.uid()).unwrap_or(NO_OWNER);
        table_owned(root, Some(me))
    }

    /// 不限擁有者（測試用的假 /proc）
    #[cfg(test)]
    pub fn table_at(root: &Path) -> Vec<ProcInfo> {
        table_owned(root, None)
    }

    /// 讀 `root`（真實是 /proc）下的程序。每個程序只讀 comm 與 stat；
    /// comm 是引擎名就直接認定、不讀命令列；comm 是 node／bun 這類執行環境才讀命令列開頭，
    /// 只取執行檔與腳本路徑兩個欄位判斷引擎，其餘丟棄、不留在結果裡。不讀環境變數。
    /// `owner` 有給時，只有屬於這個 uid 的程序會被認成代理；別的使用者的程序照樣留著當親子關係用，但不會上名單
    /// （多人共用的主機上，別人的程序名稱與 PID 不送出去）
    pub fn table_owned(root: &Path, owner: Option<u32>) -> Vec<ProcInfo> {
        let mut out = vec![];
        let Ok(rd) = std::fs::read_dir(root) else { return out };
        let proc_stat = std::fs::read_to_string(root.join("stat")).unwrap_or_default();
        for e in rd.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let dir = e.path();
            let Ok(stat) = std::fs::read_to_string(dir.join("stat")) else { continue };
            let Some(ppid) = stat.rsplit_once(')').and_then(|x| x.1.split_whitespace().nth(1).and_then(|s| s.parse::<u32>().ok())) else { continue };
            let comm = std::fs::read_to_string(dir.join("comm")).unwrap_or_default().trim().to_string();
            let stem = exe_stem(&comm);
            let mine = owner.is_none_or(|u| std::fs::metadata(&dir).is_ok_and(|m| m.uid() == u));
            let engine: Option<String> = if !mine {
                None
            } else if engine_of_name(&stem).is_some() {
                Some(stem)
            } else if RUNTIMES.contains(&stem.as_str()) {
                engine_from_cmdline_prefix(&read_prefix(&dir.join("cmdline"))).map(String::from)
            } else {
                None
            };
            match engine {
                // 引擎名放在 exe：之後的判斷只看這個，命令列不留
                Some(name) => out.push(ProcInfo { pid, ppid, exe: name, cmdline: vec![], start_secs: crate::heartbeat::parse_start_secs(&stat, &proc_stat), light: true }),
                // 別人的程序只留 pid／ppid（親子關係用），名稱清空：之後的判斷不可能把它認成代理，也不會送出
                None => out.push(ProcInfo { pid, ppid, exe: if mine { comm } else { String::new() }, cmdline: vec![], start_secs: None, light: false }),
            }
        }
        out
    }

    /// 讀檔案開頭至多 CMDLINE_PREFIX 位元組；讀不到回空（讀到一半出錯就用已讀到的部分）
    fn read_prefix(path: &Path) -> Vec<u8> {
        let Ok(f) = std::fs::File::open(path) else { return vec![] };
        let mut buf = Vec::with_capacity(CMDLINE_PREFIX);
        let _ = f.take(CMDLINE_PREFIX as u64).read_to_end(&mut buf);
        buf
    }

    /// 命令列開頭（以 NUL 分隔）→ 引擎：只看第 0 欄（執行檔）與第 1 欄（腳本路徑），其餘不碰。
    /// 第 1 欄是旗標（-e／-p／--eval 等內嵌程式碼也在內）就認不出，寧可漏列
    pub(super) fn engine_from_cmdline_prefix(raw: &[u8]) -> Option<&'static str> {
        let mut fields = raw.split(|b| *b == 0);
        let _exe = fields.next()?;
        let script = fields.next()?;
        if script.is_empty() || script[0] == b'-' {
            return None;
        }
        engine_of_script(&String::from_utf8_lossy(script))
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
                out.push(ProcInfo { pid: e.th32ProcessID, ppid: e.th32ParentProcessID, exe, cmdline, start_secs: None, light: false });
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
        ProcInfo { pid, ppid, exe: exe.into(), cmdline: cmd.split_whitespace().map(String::from).collect(), start_secs: None, light: false }
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
        // 有給值但不是已知命名：不送模型、簡稱一律「其他模型」，原值不留
        assert_eq!(model_of(&a("--model sk-ant=secret$value")), (None, Some(OTHER_MODEL_LABEL.into())));
        assert_eq!(model_of(&a("--model")), (None, None));
        assert_eq!(model_of(&a("--model --print")), (None, None));
        assert_eq!(model_of(&a("run")), (None, None));
    }

    #[test]
    fn 已知模型照常顯示_像金鑰的值不送() {
        let a = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        for m in ["claude-opus-4", "gpt-5", "MiniMax-M2", "gemini-2.5-pro", "grok-4", "Sonnet", "o3", "o4-mini", "glm-4.6", "deepseek-v3", "qwen3-coder", "kimi-k2", "anthropic/claude-opus-4"] {
            let (model, label) = model_of(&a(&format!("--model {m}")));
            assert_eq!(model.as_deref(), Some(m), "{m}");
            assert!(label.is_some() && label.as_deref() != Some(OTHER_MODEL_LABEL), "{m}");
        }
        assert_eq!(model_of(&a("--model MiniMax-M2")).1.as_deref(), Some("MiniMax"));
        assert_eq!(model_of(&a("--provider openai --model gpt-5")), (Some("gpt-5".into()), Some("openai".into())));
        assert_eq!(model_of(&a("--provider minimax-cn")).1.as_deref(), Some("MiniMax"));
        for secret in ["abcd1234efgh5678", "sk-abc123def456", "o3abc123def456", "gptabc123", "xxminimaxk3y", "k3y/xxminimax"] {
            for flags in [format!("--model {secret}"), format!("-m {secret}"), format!("--provider {secret}"), format!("--model={secret}")] {
                let (model, label) = model_of(&a(&flags));
                assert_eq!(model, None, "{flags}");
                assert_eq!(label.as_deref(), Some(OTHER_MODEL_LABEL), "{flags}");
            }
            let t = vec![p(7, 1, "pi", &format!("pi --model {secret} --provider {secret}"))];
            let r = scan(&t, 999);
            let all = format!("{:?}{}{}", r, r[0].name(), r[0].to_json());
            assert!(!all.contains(secret), "{all}");
            assert_eq!(r[0].name(), format!("pi · {OTHER_MODEL_LABEL} #7（前景）"));
            assert!(r[0].to_json().get("model").is_none());
        }
        // 供應商未知但模型已知：簡稱用模型；兩個都不認得才是其他模型
        assert_eq!(model_of(&a("--provider abcd1234efgh5678 --model gpt-5")), (Some("gpt-5".into()), Some("gpt-5".into())));
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

#[cfg(test)]
mod hidden_tests {
    use super::*;

    #[test]
    fn 程序條目_hidden_有值才帶() {
        let mut a = ProcAgent { pid: 7, engine: "grok".into(), model: None, label: None, background: false, hidden: None, detail: None, place_unknown: false };
        assert!(a.to_json().get("hidden").is_none());
        a.hidden = Some(true);
        assert_eq!(a.to_json()["hidden"], json!(true));
        a.hidden = Some(false);
        assert_eq!(a.to_json()["hidden"], json!(false));
    }

    #[test]
    fn 程序條目_detail_有值才帶() {
        let mut a = ProcAgent { pid: 7, engine: "pi".into(), model: None, label: None, background: false, hidden: None, detail: None, place_unknown: false };
        assert!(a.to_json().get("detail").is_none());
        a.detail = Some(crate::bridge::engines::PI_DISABLED.into());
        assert_eq!(a.to_json()["detail"], json!(crate::bridge::engines::PI_DISABLED));
    }
}

/// 假的 /proc 目錄：只在非 Windows 跑（Windows 沒有 /proc，table_at 也不存在）
#[cfg(all(test, not(windows)))]
mod fake_proc_tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    const MARK: &str = "SECRET_MARKER_123";
    /// btime 1800000000＋starttime 12345 刻度（123 秒）＝ 2027-01-15 08:02:03 UTC
    const START_TEXT: &str = "01-15 08:02";

    fn base(root: &Path) {
        fs::write(root.join("stat"), "cpu  1 2 3\nbtime 1800000000\nprocesses 9\n").unwrap();
    }

    /// 建一個假程序；cmdline 為 None 就不建檔（用來證明沒去讀）
    fn proc_dir(root: &Path, pid: u32, ppid: u32, comm: &str, cmdline: Option<&[u8]>) {
        let d = root.join(pid.to_string());
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("comm"), format!("{comm}\n")).unwrap();
        fs::write(d.join("stat"), format!("{pid} ({comm}) S {ppid} 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 12345 0 0")).unwrap();
        if let Some(c) = cmdline {
            fs::write(d.join("cmdline"), c).unwrap();
        }
    }

    fn cmd(parts: &[&str]) -> Vec<u8> {
        let mut v = vec![];
        for p in parts {
            v.extend_from_slice(p.as_bytes());
            v.push(0);
        }
        v
    }

    fn names(root: &Path, self_pid: u32) -> Vec<String> {
        scan(&imp::table_at(root), self_pid).iter().map(|a| a.name()).collect()
    }

    #[test]
    fn 只認同一個使用者的程序_別人的不上名單() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        for (pid, comm) in [(10, "claude"), (11, "pi"), (12, "codex"), (13, "node")] {
            proc_dir(root, pid, 1, comm, Some(&cmd(&["node", "/x/node_modules/@openai/codex/bin/codex.js"])));
        }
        let me = fs::metadata(root.join("10")).unwrap().uid();
        assert_eq!(scan(&imp::table_owned(root, Some(me)), 999).len(), 4);
        // 不是自己的 uid：程序還在表裡（親子關係要用），但不會被認成代理
        let other = imp::table_owned(root, Some(me.wrapping_add(1)));
        assert_eq!(other.len(), 4);
        assert!(other.iter().all(|p| p.exe.is_empty() && !p.light), "{other:?}");
        assert!(scan(&other, 999).is_empty());
    }

    #[test]
    fn 行程名是引擎名就直接認定_不讀命令列() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        // 全部沒有 cmdline 檔：若去讀就會讀不到，仍要認得
        for (pid, comm) in [(10, "claude"), (11, "codex"), (12, "pi"), (13, "agy"), (14, "gemini"), (15, "grok"), (16, "bash")] {
            proc_dir(root, pid, 1, comm, None);
        }
        let r = scan(&imp::table_at(root), 999);
        let n: Vec<String> = r.iter().map(|a| a.name()).collect();
        assert_eq!(n, vec!["claude #10", "codex #11", "gemini #13", "gemini #14", "grok #15", "pi #12"]);
        for a in &r {
            assert_eq!((a.model.clone(), a.label.clone(), a.background, a.place_unknown), (None, None, false, true));
            let d = a.detail.clone().unwrap();
            assert!(d.starts_with("偵測到，未接管"), "{d}");
            assert!(d.contains(START_TEXT), "{d}");
            assert!(d.chars().count() <= 80);
            let j = a.to_json();
            assert_eq!(j["kind"], json!("process"));
            assert_eq!(j["receivable"], json!(false));
            assert!(j.get("model").is_none());
        }
    }

    #[test]
    fn node_與_bun_只看腳本路徑_認得各引擎_其餘不認() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        proc_dir(root, 20, 1, "node", Some(&cmd(&["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "exec", "--api-key", MARK])));
        proc_dir(root, 21, 1, "node", Some(&cmd(&["/usr/bin/node", "/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js", "--model", MARK])));
        proc_dir(root, 22, 1, "bun", Some(&cmd(&["bun", "/home/u/.npm/pi-coding-agent/dist/cli.js", "--api-key", MARK])));
        proc_dir(root, 23, 1, "node", Some(&cmd(&["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "-p", MARK])));
        proc_dir(root, 24, 1, "node", Some(&cmd(&["node", "/srv/app/server.js", "--secret", MARK])));
        proc_dir(root, 25, 1, "node", Some(&cmd(&["node", "-e", "require('/x/@openai/codex/y')", MARK])));
        proc_dir(root, 26, 1, "node", Some(&cmd(&["node"])));
        proc_dir(root, 27, 1, "python3", Some(&cmd(&["python3", "/x/tool/a.py"])));
        assert_eq!(names(root, 999), vec!["claude #23", "codex #20", "gemini #21", "pi #22"]);
    }

    #[test]
    fn 命令列的特徵字串不會出現在任何輸出() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        proc_dir(root, 30, 1, "node", Some(&cmd(&["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "--api-key", MARK, "--model", MARK])));
        proc_dir(root, 31, 1, "codex", Some(&cmd(&["codex", "--api-key", MARK])));
        proc_dir(root, 32, 1, "node", Some(&cmd(&["node", "-e", MARK])));
        let table = imp::table_at(root);
        assert!(!format!("{table:?}").contains(MARK), "ProcInfo");
        let agents = scan(&table, 999);
        assert_eq!(agents.len(), 2);
        assert!(!format!("{agents:?}").contains(MARK), "ProcAgent");
        for a in &agents {
            assert!(!a.name().contains(MARK));
            assert!(!a.to_json().to_string().contains(MARK), "to_json");
        }
        assert!(table.iter().all(|t| t.cmdline.is_empty()), "命令列一律不留在 ProcInfo");
    }

    #[test]
    fn 超過前綴長度的內容不影響結果_也不出現() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        let mut raw = cmd(&["node", "/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js"]);
        raw.resize(raw.len() + 600, b'A');
        raw.extend_from_slice(MARK.as_bytes());
        proc_dir(root, 40, 1, "node", Some(&raw));
        let table = imp::table_at(root);
        assert_eq!(scan(&table, 999).iter().map(|a| a.name()).collect::<Vec<_>>(), vec!["gemini #40"]);
        assert!(!format!("{table:?}").contains(MARK));
    }

    #[test]
    fn 命令列讀不到時其他照常() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        proc_dir(root, 50, 1, "node", None);
        proc_dir(root, 51, 1, "node", None);
        fs::create_dir_all(root.join("51").join("cmdline")).unwrap(); // 是資料夾：開得起來但讀不了
        proc_dir(root, 52, 1, "codex", None);
        assert_eq!(names(root, 999), vec!["codex #52"]);
    }

    #[test]
    fn 排除橋自己與後代_同引擎父子不重複() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        proc_dir(root, 60, 1, "asn-bridge", None);
        proc_dir(root, 61, 60, "claude", None); // 橋開的
        proc_dir(root, 62, 61, "codex", None); // 橋後代的後代
        proc_dir(root, 63, 1, "pi", None);
        proc_dir(root, 64, 63, "node", Some(&cmd(&["node", "/a/pi-coding-agent/cli.js"]))); // pi 的包裝子程序
        proc_dir(root, 65, 1, "grok", None);
        assert_eq!(names(root, 60), vec!["grok #65", "pi #63"]);
        proc_dir(root, 66, 60, "asn-bridge", None);
        assert_eq!(names(root, 66), vec!["claude #61", "codex #62", "grok #65", "pi #63"], "換個自己，原本的後代就不再被排除");
    }

    #[test]
    fn 上限_五十() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        for pid in 100..160 {
            proc_dir(root, pid, 1, "pi", None);
        }
        assert_eq!(scan(&imp::table_at(root), 999).len(), MAX_AGENTS);
    }

    #[test]
    fn 程序消失下一輪就不見() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        base(root);
        proc_dir(root, 70, 1, "claude", None);
        proc_dir(root, 71, 1, "codex", None);
        assert_eq!(names(root, 999), vec!["claude #70", "codex #71"]);
        fs::remove_dir_all(root.join("70")).unwrap();
        assert_eq!(names(root, 999), vec!["codex #71"]);
    }

    #[test]
    fn 讀不到開機時間仍列出_只是不帶啟動時間() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        proc_dir(root, 80, 1, "pi", None); // 沒有 root/stat
        let r = scan(&imp::table_at(root), 999);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].detail.as_deref(), Some("偵測到，未接管"));
    }

    #[test]
    fn 啟動時間格式() {
        assert_eq!(fmt_utc(1_800_000_123), "01-15 08:02");
        assert_eq!(fmt_utc(0), "01-01 00:00");
        assert_eq!(fmt_utc(951_782_400 + 59 * 60 + 3600 * 23), "02-29 23:59"); // 2000-02-29
    }
}
