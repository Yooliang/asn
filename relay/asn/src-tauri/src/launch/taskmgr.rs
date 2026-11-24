//! 工作管理員（0.2.21，電腦版）：把「這台電腦上 ASN 管的程式」整理成一份只讀清單給畫面顯示。
//!
//! 這個模組**只讀**：不結束任何程序、不送任何訊息。畫面上的「停止」一律走既有的關閉流程
//! （夥伴管理的 close、`/asn-close-dup <pid>`、終端面板的 term_stop），不在這裡另開殺程序的路。
//!
//! 資料來源各管一塊（和名單同一份）：Claude 視窗讀 `~/.claude/sessions`（活著、而且還是當初那個程序才列，殘檔不算）、
//! pi 視窗讀擴充的登記檔、終端面板讀 ASN 自己的對照表、其餘程序用程序掃描（只能看）。
//! 記憶體＝整棵程序樹的工作集合計（Windows 用 GetProcessMemoryInfo、Linux 讀 /proc），拿不到就是 None，畫面顯示「—」。
//! 作業系統動作全走 `Os` 介面，測試用假的。
use super::awaiting;
use super::stuck_resume::{self, PartnerRef};
use super::switch::{self, Os, Proc};
use crate::bridge::known::KnownEntry;
use crate::bridge::procscan::ProcAgent;
use crate::bridge::roster::Window;
use serde::Serialize;
use std::collections::HashSet;

/// 程序樹最多走幾個程序（防失控）
const TREE_MAX: usize = 512;
/// 清單最多幾列
const ROWS_MAX: usize = 200;

/// 清單的一列。畫面只顯示名字、引擎、程序編號、記憶體、開了多久、狀態、來源；
/// term_id、session_id 只給畫面決定「停止」走哪條路，不顯示
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct TaskRow {
    /// claude／pi／resuming（ASN 開的、卡在接回中的夥伴視窗，沒有 session 檔）／awaiting（ASN 開的、視窗開著但在等你按確認、還沒進到對話）／process（自己開的前景程式，只能看）／terminal（終端面板）／mux（終端服務，只能看）／asn（ASN 本體與它自己的視窗，只能看）
    pub kind: &'static str,
    pub name: String,
    pub engine: String,
    pub pid: u32,
    /// 整棵程序樹的工作集（位元組）；拿不到就是 None
    pub memory_bytes: Option<u64>,
    /// 程序建立時間（Unix 毫秒）；拿不到就是 None
    pub started_ms: Option<u64>,
    pub status: Option<String>,
    pub detail: Option<String>,
    /// 是不是 ASN 開的；不確定（程式掃描到的）就是 None
    pub by_asn: Option<bool>,
    pub cwd: String,
    pub session_id: Option<String>,
    /// 終端面板的編號（只用來呼叫既有的 term_stop，不顯示）
    pub term_id: Option<String>,
    /// 程序活著、而且還是當初那個程序（殘檔、pid 被重用的不會進清單，所以這裡一律 true；畫面判斷重複時只算 live 的）
    pub live: bool,
    /// 終端服務：裡面有幾個視窗
    pub inside: Option<usize>,
    /// 這個視窗開在哪種終端（#1909）：`mux`＝ASN 共用的終端服務、`native`＝系統自己的原生主控台、`unknown`＝看不出來。
    /// 只對夥伴視窗（claude／pi／resuming／awaiting 與 ASN 自己的視窗）判斷；其他列一律 `unknown`（不套用，畫面也不讀）。
    /// `native` 一定要有正面證據（見 `term_of`），找不到絕不當成原生
    pub term: &'static str,
    /// 這一列開在哪個終端服務底下（終端服務的程序編號）；不在任何終端服務底下、或這一列本身是終端服務／ASN／自己開的前景程式，就是 None。
    /// 畫面排成樹時只看這個欄位，不自己猜歸屬；`inside` 就是「mux_pid 等於它、而且不是 process」的列數
    pub mux_pid: Option<u32>,
}

/// `TaskRow.term` 的三個值（序列化後的穩定字串）
pub(crate) const TERM_MUX: &str = "mux";
pub(crate) const TERM_NATIVE: &str = "native";
pub(crate) const TERM_UNKNOWN: &str = "unknown";

/// 往上追到根還算「完整」的系統程序（它們的父程序常已結束，編號懸空）。小寫執行檔名
const CHAIN_ROOTS: &[&str] = &["explorer.exe", "services.exe", "wininit.exe", "winlogon.exe", "svchost.exe", "system"];

/// 判斷視窗開在哪種終端。只用傳進來的程序表與 Os，不呼叫 wezterm、不啟動任何東西。
/// - 程序表空（含非 Windows）、pid 不在表裡 → unknown
/// - 上層鏈裡有終端服務：對照表認得（`mux_session_of`）→ mux；對不上 → unknown
/// - 沒有終端服務，而且鏈完整（追到 ppid 0／自己，或已知系統程序）、至少有一層上層、也不是 ASN 自帶 GUI → native
/// - 其餘（鏈中斷、父程序比子程序晚建立＝pid 被重用、自帶 GUI 等）→ unknown
///
/// 防 pid 重用：每走一層，父程序的建立時間若晚於子程序，視為鏈中斷（兩邊查得到才比；查不到不拒絕，同 `tree_pids`）
pub(crate) fn term_of(os: &dyn Os, table: &[Proc], pid: u32) -> &'static str {
    if !table.iter().any(|p| p.pid == pid) {
        return TERM_UNKNOWN;
    }
    let mut chain: Vec<&Proc> = Vec::new();
    let mut cur = pid;
    let mut complete = false;
    loop {
        let me = match table.iter().find(|p| p.pid == cur) {
            Some(p) => p,
            None => break,
        };
        if me.ppid == 0 || me.ppid == me.pid {
            complete = true;
            break;
        }
        let parent = match table.iter().find(|p| p.pid == me.ppid) {
            Some(p) => p,
            None => {
                // 父程序已不在表裡：自己是已知系統程序才算追到頂，否則是鏈中斷
                complete = !chain.is_empty() && CHAIN_ROOTS.contains(&me.name.as_str());
                break;
            }
        };
        if matches!((os.started_ms(parent.pid), os.started_ms(me.pid)), (Some(par), Some(child)) if par > child) {
            break; // pid 被重用：這個「父程序」其實是後來才出現的別人
        }
        if chain.iter().any(|c| c.pid == parent.pid) || chain.len() >= 32 {
            break; // 有環／太深：不當完整
        }
        chain.push(parent);
        cur = parent.pid;
    }
    if chain.iter().any(|p| p.name == switch::MUX_SERVER) {
        return if os.mux_session_of(pid).is_some() { TERM_MUX } else { TERM_UNKNOWN };
    }
    if !complete || chain.is_empty() || chain.iter().any(|p| p.name == switch::WEZ_GUI) {
        return TERM_UNKNOWN;
    }
    TERM_NATIVE
}

/// 認得但目前沒在跑的名字（折疊區用）
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct KnownRow {
    pub name: String,
    pub engine: String,
    pub cwd: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct Snapshot {
    pub rows: Vec<TaskRow>,
    pub known: Vec<KnownRow>,
    pub now_ms: u64,
}

/// ASN 自己開的終端面板（term_list 的一列，只留要用的欄位）
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TermIn {
    pub id: String,
    pub profile: String,
    pub pid: u32,
    pub started_ms: Option<u64>,
    pub cwd: String,
    /// 使用者自己開的窗格、由 ASN 接手：不是 ASN 開的，畫面只能看
    pub adopted: bool,
}

/// 清單的原料（呼叫端讀好交進來，這裡只整理）
pub(crate) struct Sources {
    pub claude: Vec<Window>,
    /// 本機 Claude session 名單是不是真的讀到了（讀到而且是空的＝true；目錄讀不到＝false）。
    /// false 時 `claude` 空只代表「不知道」，不能拿來證明「沒有 session 檔」，所以一律不列 resuming（避免把健康夥伴誤列成卡住）
    pub claude_ok: bool,
    pub pi: Vec<Window>,
    pub procs: Vec<ProcAgent>,
    pub terms: Vec<TermIn>,
    /// 終端對照表裡的夥伴視窗（claude）；找「卡在接回中」的視窗用
    pub partners: Vec<PartnerRef>,
    /// 本機「所有」sessions 檔（不論程序活不活；見 stuck_resume::all_session_files）。「等你按確認」只在這份讀到、而且這批程序完全沒有檔時才列；
    /// None＝讀不到，一律不判斷 awaiting
    pub all_sessions: Option<Vec<stuck_resume::LiveSess>>,
    pub known: Vec<KnownEntry>,
    /// 受保護的視窗名（收發室、ASN 自己的視窗）：列出來但只能看
    pub protected: Vec<String>,
    pub own_pid: u32,
    pub now_ms: u64,
}

/// 某個程序和它的後代（廣度走訪）。比父程序還早建立的是舊 pid 的孤兒，不算後代（同 switch::kill_set_with）
pub(crate) fn tree_pids(table: &[Proc], root: u32, started: &dyn Fn(u32) -> Option<u64>) -> Vec<u32> {
    let mut order = vec![root];
    let mut idx = 0;
    while idx < order.len() && order.len() < TREE_MAX {
        let cur = order[idx];
        for p in table.iter().filter(|p| p.ppid == cur && p.pid != cur) {
            if matches!((started(p.pid), started(cur)), (Some(c), Some(par)) if c < par) {
                continue;
            }
            if !order.contains(&p.pid) {
                order.push(p.pid);
            }
        }
        idx += 1;
    }
    order
}

/// 整棵程序樹的工作集合計。根程序查不到就是 None（不猜）；底下查不到的程序略過
pub(crate) fn tree_memory(os: &dyn Os, table: &[Proc], root: u32) -> Option<u64> {
    let own = os.memory_bytes(root)?;
    let rest: u64 = tree_pids(table, root, &|p| os.started_ms(p)).into_iter().filter(|p| *p != root).filter_map(|p| os.memory_bytes(p)).sum();
    Some(own.saturating_add(rest))
}

/// 組出清單。每個程序一列，鍵是（種類、程序編號）
pub(crate) fn build(os: &dyn Os, src: &Sources) -> Snapshot {
    let table = os.processes();
    let mux_pids: Vec<u32> = table.iter().filter(|p| p.name == switch::MUX_SERVER).map(|p| p.pid).collect();
    let mux_of = |pid: u32| switch::ancestors(&table, pid).into_iter().take(8).find(|a| mux_pids.contains(a));
    // 每一列附上「它在哪個終端服務底下」，最後用來數終端服務裡有幾個視窗
    let mut listed: Vec<(TaskRow, Option<u32>)> = Vec::new();
    // 卡在接回中的夥伴視窗：四個條件都成立才列（判斷與停止前的再驗證共用 stuck_resume::identify）
    let live: Vec<stuck_resume::LiveSess> = src.claude.iter().map(|w| stuck_resume::LiveSess { sid: w.session_id.clone(), pid: w.pid }).collect();
    let mut seen_sids: HashSet<&str> = HashSet::new();
    // 名單讀不到時不判斷（stop_real 同：讀不到就拒絕）
    let resuming: Vec<stuck_resume::Stuck> = if !src.claude_ok { vec![] } else { src.partners.iter().filter(|p| !p.session_id.is_empty() && seen_sids.insert(p.session_id.as_str())).filter_map(|p| stuck_resume::identify(os, &src.partners, &live, &p.session_id, src.now_ms).ok()).collect() };
    // 這些程序（和它們的子程序）不再列成「自己開的」
    let mut resuming_skip: HashSet<u32> = resuming.iter().flat_map(|s| s.pids.iter().flat_map(|p| tree_pids(&table, *p, &|x| os.started_ms(x)))).collect();
    // 視窗開著、卡在第一次確認畫面還沒進到對話的夥伴（#1635）：已經列成「接回中」的不重複列；名單讀不到時不判斷
    // 判斷用「所有」sessions 檔（有檔但被判不活的視窗不能列成等確認）；讀不到所有檔也不判斷
    let awaiting: Vec<awaiting::Awaiting> = match (&src.all_sessions, src.claude_ok) {
        (Some(all), true) => awaiting::identify_all(os, &src.partners, all, src.now_ms).into_iter().filter(|a| !a.pids.iter().any(|p| resuming_skip.contains(p))).collect(),
        _ => vec![],
    };
    resuming_skip.extend(awaiting.iter().flat_map(|a| a.pids.iter().flat_map(|p| tree_pids(&table, *p, &|x| os.started_ms(x)))));

    for w in src.claude.iter().chain(src.pi.iter()) {
        let protected = src.protected.iter().any(|n| *n == w.name);
        let row = TaskRow {
            kind: if protected { "asn" } else if w.engine == "pi" { "pi" } else { "claude" },
            name: w.name.clone(),
            engine: w.engine.clone(),
            pid: w.pid,
            memory_bytes: tree_memory(os, &table, w.pid),
            started_ms: os.started_ms(w.pid),
            status: w.status.clone(),
            detail: w.detail.clone(),
            by_asn: Some(switch::opened_by_asn(os, &table, w.pid)),
            cwd: w.cwd.clone(),
            session_id: w.session_id.clone(),
            term_id: None,
            live: true,
            inside: None,
            term: term_of(os, &table, w.pid),
            mux_pid: None,
        };
        listed.push((row, mux_of(w.pid)));
    }

    for s in &resuming {
        let row = TaskRow {
            kind: "resuming",
            name: s.partner.name.clone(),
            engine: "claude".into(),
            pid: s.root_pid,
            memory_bytes: tree_memory(os, &table, s.root_pid),
            started_ms: s.started_ms,
            status: Some((if s.stuck { "stuck" } else { "resuming" }).to_string()),
            detail: None,
            by_asn: Some(true),
            cwd: s.partner.cwd.clone(),
            session_id: Some(s.partner.session_id.clone()),
            term_id: Some(s.partner.id.clone()),
            live: true,
            inside: None,
            term: term_of(os, &table, s.root_pid),
            mux_pid: None,
        };
        listed.push((row, mux_of(s.root_pid)));
    }

    for a in &awaiting {
        let row = TaskRow {
            kind: "awaiting",
            name: a.partner.name.clone(),
            engine: "claude".into(),
            pid: a.root_pid,
            memory_bytes: tree_memory(os, &table, a.root_pid),
            started_ms: Some(a.started_ms),
            status: Some("awaiting".into()),
            detail: Some(awaiting::DETAIL.into()),
            by_asn: Some(true),
            cwd: a.partner.cwd.clone(),
            session_id: None,
            term_id: Some(a.partner.id.clone()),
            live: true,
            inside: None,
            term: term_of(os, &table, a.root_pid),
            mux_pid: None,
        };
        listed.push((row, mux_of(a.root_pid)));
    }

    for t in &src.terms {
        let is_mux = mux_pids.contains(&t.pid);
        let row = TaskRow {
            kind: "terminal",
            name: t.profile.clone(),
            engine: t.profile.clone(),
            pid: t.pid,
            // 窗格開在共用終端服務裡時，編號是服務本身的：那一整棵不是這個窗格的記憶體，不顯示
            memory_bytes: if is_mux { None } else { tree_memory(os, &table, t.pid) },
            started_ms: t.started_ms,
            status: None,
            detail: None,
            by_asn: Some(!t.adopted),
            cwd: t.cwd.clone(),
            session_id: None,
            term_id: Some(t.id.clone()),
            live: true,
            inside: None,
            term: TERM_UNKNOWN,
            mux_pid: None,
        };
        listed.push((row, if is_mux { Some(t.pid) } else { mux_of(t.pid) }));
    }

    for a in src.procs.iter().filter(|a| !resuming_skip.contains(&a.pid)) {
        let row = TaskRow {
            kind: "process",
            name: a.name(),
            engine: a.engine.clone(),
            pid: a.pid,
            memory_bytes: tree_memory(os, &table, a.pid),
            started_ms: os.started_ms(a.pid),
            status: Some("running".into()),
            detail: a.detail.clone(),
            by_asn: None,
            cwd: String::new(),
            session_id: None,
            term_id: None,
            live: true,
            inside: None,
            term: TERM_UNKNOWN,
            mux_pid: None,
        };
        listed.push((row, None));
    }

    // 歸屬只在這裡算一次：把「在哪個終端服務底下」寫進每一列，畫面不再自己猜
    let mut rows: Vec<TaskRow> = listed.iter().map(|(r, m)| TaskRow { mux_pid: *m, ..r.clone() }).collect();
    for mux in &mux_pids {
        let inside = listed.iter().filter(|(r, m)| *m == Some(*mux) && r.kind != "process").count();
        rows.push(TaskRow {
            kind: "mux",
            name: "終端服務".into(),
            engine: String::new(),
            pid: *mux,
            memory_bytes: tree_memory(os, &table, *mux),
            started_ms: os.started_ms(*mux),
            status: Some("running".into()),
            detail: None,
            by_asn: Some(true),
            cwd: String::new(),
            session_id: None,
            term_id: None,
            live: true,
            inside: Some(inside),
            term: TERM_UNKNOWN,
            mux_pid: None,
        });
    }
    if src.own_pid != 0 {
        rows.push(TaskRow {
            kind: "asn",
            name: "ASN".into(),
            engine: "asn".into(),
            pid: src.own_pid,
            memory_bytes: tree_memory(os, &table, src.own_pid),
            started_ms: os.started_ms(src.own_pid),
            status: Some("running".into()),
            detail: None,
            by_asn: Some(true),
            cwd: String::new(),
            session_id: None,
            term_id: None,
            live: true,
            inside: None,
            term: TERM_UNKNOWN,
            mux_pid: None,
        });
    }
    rows.truncate(ROWS_MAX);

    let running: HashSet<&str> = src.claude.iter().chain(src.pi.iter()).map(|w| w.name.as_str()).chain(resuming.iter().map(|s| s.partner.name.as_str())).chain(awaiting.iter().map(|a| a.partner.name.as_str())).collect();
    let known = src
        .known
        .iter()
        .filter(|k| !k.name.is_empty() && !running.contains(k.name.as_str()))
        .map(|k| KnownRow { name: k.name.clone(), engine: k.engine.clone(), cwd: k.facts.cwd.clone() })
        .take(ROWS_MAX)
        .collect();
    Snapshot { rows, known, now_ms: src.now_ms }
}

/// 重啟的狀態放進清單：
/// - `mux_restarting`：按了「重啟終端服務」、還沒做完，畫面據此顯示「正在重啟…」，底下的代理標「斷線中」
/// - `restart_pending`：上次重啟起不來、還沒接回的代理數，重啟 ASN 的確認框據此多講一句
/// - `restart_pending_names`：這些代理的名字，畫面重啟後等它們都接回才放掉「重啟中」
/// - `mux_expected`：這台用終端服務、而且有代理等著接回或上次重啟失敗（見 `placeholder_wanted`）。清單上沒有終端服務那一列時，畫面列一個「沒有在運行」的佔位，讓本人有地方再按重啟；
///   只是用終端服務、服務被正常收掉（最後一位夥伴關了）不算，沒開終端服務模式的 Linux 也不算
#[cfg(desktop)]
fn add_restart_state(out: &mut serde_json::Value, restarting: bool, pending: &[String], use_mux: bool, last_failed: bool) {
    out["mux_expected"] = serde_json::Value::Bool(super::mux_restart::placeholder_wanted(use_mux, pending.len(), last_failed));
    out["mux_restarting"] = serde_json::Value::Bool(restarting);
    out["restart_pending"] = serde_json::json!(pending.len());
    out["restart_pending_names"] = serde_json::json!(pending);
}

/// 讀真實環境：視窗名單、程序掃描、終端面板（呼叫端給）、認得的名字。讀不到視窗名單就回錯（畫面顯示暫時讀不到，不當成沒有程式）
#[cfg(desktop)]
pub(crate) fn collect(work_dir: &std::path::Path, node: &str, asn_window: &str, terms: Vec<TermIn>, partners: Vec<PartnerRef>, use_mux: bool) -> Result<serde_json::Value, String> {
    use crate::bridge::{engines, known, procscan, roster};
    let home = crate::identity::home_dir();
    let now = crate::heartbeat::now_ms();
    // 判斷「讀不到」：read_local_with 在 sessions 目錄存在卻讀不開時回 None（目錄不存在＝還沒有任何 session，回空清單）。
    // 這裡 None 直接回錯、整張清單不出；claude_ok 仍照實填，讓 build 不依賴呼叫端的這個處理
    let claude_read = roster::read_local_with(&home.join(".claude").join("sessions"), &home.join(".asn").join("status"), crate::heartbeat::session_alive, 0, "", now);
    let claude_ok = claude_read.is_some();
    let claude = claude_read.ok_or_else(|| "讀不到本機視窗清單".to_string())?;
    let pi = engines::pi::read_windows(&engines::pi::windows_dir(&home), now, crate::heartbeat::pid_alive);
    // 已登記成視窗的程序不再列成「自己開的」（同名單的做法）
    let skip: Vec<u32> = claude.iter().chain(pi.iter()).map(|w| w.pid).filter(|p| *p != 0).collect();
    let procs = procscan::scan_system_excluding(&skip);
    let known_entries = known::Known::load(&work_dir.join(known::KNOWN_FILE), now).entries();
    let mailbox = crate::envc::get("ASN_MAILBOX_NAME").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("{node}-收發室"));
    let protected = vec![mailbox, asn_window.to_string()];
    let all_sessions = stuck_resume::all_session_files();
    let src = Sources { claude, claude_ok, pi, procs, terms, partners, all_sessions, known: known_entries, protected, own_pid: std::process::id(), now_ms: now };
    let mut out = serde_json::to_value(build(&switch::RealOs, &src)).map_err(|e| e.to_string())?;
    add_restart_state(&mut out, super::mux_restart::is_restarting(), &super::mux_restart::STASH.get(), use_mux, super::mux_restart::last_failed());
    // 壓縮次數（#1852）：只有 Claude 視窗有；內建收發室還沒數過的視窗是 null（畫面顯示「—」）
    if let Some(rows) = out.get_mut("rows").and_then(|r| r.as_array_mut()) {
        for r in rows.iter_mut().filter(|r| r.get("kind").and_then(|k| k.as_str()) == Some("claude")) {
            let sid = r.get("session_id").and_then(|k| k.as_str()).unwrap_or("").to_string();
            r["compact"] = crate::bridge::compact::row_json(&sid);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::known::WindowFacts;
    use std::collections::HashMap;
    use crate::launch::live_process;

    const NOW: u64 = 1_800_000_000_000;

    fn p(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }

    /// 假的作業系統：程序表、記憶體、建立時間都是寫死的；任何「動手」的方法都不該被呼叫
    struct FakeOs {
        table: Vec<Proc>,
        mem: HashMap<u32, u64>,
        started: HashMap<u32, u64>,
        cmd: HashMap<u32, String>,
        /// 對照表認得的終端服務窗格（pid）
        mux_known: Vec<u32>,
    }

    impl Os for FakeOs {
        fn cmdline(&self, pid: u32) -> Option<String> {
            self.cmd.get(&pid).cloned()
        }
        fn processes(&self) -> Vec<Proc> {
            self.table.clone()
        }
        fn mux_session_of(&self, pid: u32) -> Option<String> {
            self.mux_known.contains(&pid).then(|| "t-mux".to_string())
        }
        fn alive(&self, pid: u32) -> bool {
            self.table.iter().any(|p| p.pid == pid)
        }
        fn started_ms(&self, pid: u32) -> Option<u64> {
            self.started.get(&pid).copied()
        }
        fn memory_bytes(&self, pid: u32) -> Option<u64> {
            self.mem.get(&pid).copied()
        }
        fn close_window(&self, _pid: u32) -> bool {
            panic!("工作管理員的清單不能送關閉訊息")
        }
        fn terminate(&self, _pid: u32) -> Result<(), String> {
            panic!("工作管理員的清單不能結束程序")
        }
    }

    fn os(table: Vec<Proc>, mem: &[(u32, u64)], started: &[(u32, u64)]) -> FakeOs {
        FakeOs { table, mem: mem.iter().copied().collect(), started: started.iter().copied().collect(), cmd: HashMap::new(), mux_known: vec![] }
    }

    fn src(claude: Vec<Window>) -> Sources {
        Sources { claude, claude_ok: true, pi: vec![], procs: vec![], terms: vec![], partners: vec![], all_sessions: Some(vec![]), known: vec![], protected: vec![], own_pid: 0, now_ms: NOW }
    }

    fn claude(name: &str, pid: u32) -> Window {
        Window::claude(name, Some("idle".into()), "G:/work", pid, NOW, Some(format!("sess-{pid}")))
    }

    #[test]
    fn 記憶體是整棵程序樹的合計() {
        // 100 是 claude，底下 node 子程序 101、孫程序 102；200 是別的程序，不能算進來
        let o = os(vec![p(100, 1, "claude.exe"), p(101, 100, "node.exe"), p(102, 101, "node.exe"), p(200, 1, "other.exe")], &[(100, 400), (101, 300), (102, 30), (200, 9_999)], &[]);
        assert_eq!(tree_memory(&o, &o.table, 100), Some(730));
    }

    #[test]
    fn 根程序拿不到記憶體就是none_不猜() {
        let o = os(vec![p(100, 1, "claude.exe"), p(101, 100, "node.exe")], &[(101, 300)], &[]);
        assert_eq!(tree_memory(&o, &o.table, 100), None, "根拿不到不能拿子程序湊數");
    }

    #[test]
    fn 底下拿不到的子程序略過_不影響合計() {
        let o = os(vec![p(100, 1, "claude.exe"), p(101, 100, "node.exe")], &[(100, 400)], &[]);
        assert_eq!(tree_memory(&o, &o.table, 100), Some(400));
    }

    #[test]
    fn 比父程序更早建立的孤兒不算後代() {
        // 102 的 ppid 指到 100，但它比 100 還早建立：是舊 pid 的孤兒，記憶體不能算給 100
        let o = os(vec![p(100, 1, "claude.exe"), p(101, 100, "node.exe"), p(102, 100, "node.exe")], &[(100, 10), (101, 20), (102, 5_000)], &[(100, 2_000), (101, 2_500), (102, 1_000)]);
        assert_eq!(tree_memory(&o, &o.table, 100), Some(30));
    }

    #[test]
    fn 程序樹有環也不會無限走() {
        let o = os(vec![p(100, 101, "a.exe"), p(101, 100, "b.exe")], &[(100, 1), (101, 2)], &[]);
        assert_eq!(tree_memory(&o, &o.table, 100), Some(3));
    }

    #[test]
    fn 兩個同名的視窗各一列_都標活著() {
        let o = os(vec![p(10, 1, "claude.exe"), p(11, 1, "claude.exe")], &[(10, 1_000), (11, 2_000)], &[(10, NOW - 600_000), (11, NOW - 60_000)]);
        let snap = build(&o, &src(vec![claude("asn真", 10), claude("asn真", 11)]));
        let rows: Vec<&TaskRow> = snap.rows.iter().filter(|r| r.name == "asn真").collect();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.live && r.kind == "claude"));
        assert_eq!(rows[0].memory_bytes, Some(1_000));
        assert_eq!(rows[1].started_ms, Some(NOW - 60_000));
    }

    #[test]
    fn 受保護的視窗列出來但只能看() {
        let o = os(vec![p(10, 1, "claude.exe")], &[], &[]);
        let mut s = src(vec![claude("辦公室-收發室", 10)]);
        s.protected = vec!["辦公室-收發室".into()];
        let snap = build(&o, &s);
        assert_eq!(snap.rows[0].kind, "asn");
    }

    #[test]
    fn 記憶體拿不到時整列照樣出現() {
        let o = os(vec![p(10, 1, "claude.exe")], &[], &[]);
        let snap = build(&o, &src(vec![claude("小東", 10)]));
        assert_eq!(snap.rows.len(), 1);
        assert_eq!(snap.rows[0].memory_bytes, None);
    }

    #[test]
    fn 終端面板開在共用服務裡_不把整個服務的記憶體算給它() {
        let o = os(vec![p(500, 1, switch::MUX_SERVER), p(501, 500, "wezterm.exe")], &[(500, 9_000), (501, 100)], &[]);
        let mut s = src(vec![]);
        s.terms = vec![TermIn { id: "t1".into(), profile: "agy".into(), pid: 500, started_ms: Some(1), cwd: "G:/w".into(), adopted: false }];
        let snap = build(&o, &s);
        let term = snap.rows.iter().find(|r| r.kind == "terminal").unwrap();
        assert_eq!(term.memory_bytes, None);
        assert_eq!(term.term_id.as_deref(), Some("t1"));
        let mux = snap.rows.iter().find(|r| r.kind == "mux").unwrap();
        assert_eq!(mux.inside, Some(1));
        assert_eq!(mux.memory_bytes, Some(9_100));
    }

    #[test]
    fn 接手來的終端窗格標成不是asn開的() {
        let o = os(vec![p(600, 1, "wezterm-gui.exe")], &[], &[]);
        let mut s = src(vec![]);
        s.terms = vec![TermIn { id: "t2".into(), profile: "grok".into(), pid: 600, started_ms: None, cwd: String::new(), adopted: true }];
        let snap = build(&o, &s);
        assert_eq!(snap.rows[0].by_asn, Some(false));
    }

    #[test]
    fn 認得但沒在跑的名字放進折疊區_在跑的不重複列() {
        let o = os(vec![p(10, 1, "claude.exe")], &[], &[]);
        let mut s = src(vec![claude("小東", 10)]);
        s.known = vec![
            KnownEntry { name: "小東".into(), engine: "claude".into(), facts: WindowFacts::default() },
            KnownEntry { name: "西川".into(), engine: "claude".into(), facts: WindowFacts { cwd: "G:/x".into(), ..Default::default() } },
        ];
        let snap = build(&o, &s);
        assert_eq!(snap.known, vec![KnownRow { name: "西川".into(), engine: "claude".into(), cwd: "G:/x".into() }]);
    }

    #[test]
    fn asn本體列出來_程序編號是自己() {
        let o = os(vec![p(77, 1, "asn.exe")], &[(77, 5)], &[]);
        let mut s = src(vec![]);
        s.own_pid = 77;
        let snap = build(&o, &s);
        let me = snap.rows.iter().find(|r| r.kind == "asn").unwrap();
        assert_eq!((me.pid, me.memory_bytes), (77, Some(5)));
    }

    // ---- 卡在接回中的夥伴視窗 ----

    const SID: &str = "11111111-2222-4333-8444-555555555555";

    fn partner(id: &str) -> PartnerRef {
        PartnerRef { id: id.into(), name: "小乙".into(), session_id: SID.into(), mux: true, gui_pid: 500, started_ms: Some(1_000), cwd: "G:/w".into() }
    }

    /// 終端服務 500 ← 包裝殼 501 ← claude 502（帶 --resume）← claude 503；另有一個掃描到的「自己開的」程序就是 502
    fn resuming_os(age_ms: u64) -> FakeOs {
        let mut o = os(
            vec![p(500, 1, switch::MUX_SERVER), p(501, 500, "powershell.exe"), p(502, 501, "claude.exe"), p(503, 502, "claude.exe")],
            &[(500, 9_000), (502, 400), (503, 30)],
            &[(500, 1_000), (501, NOW - age_ms), (502, NOW - age_ms), (503, NOW - age_ms + 5)],
        );
        let cmd = format!("claude.exe --resume {SID}");
        o.cmd = HashMap::from([(502, cmd.clone()), (503, cmd)]);
        o
    }

    fn resuming_src() -> Sources {
        let mut s = src(vec![]);
        s.partners = vec![partner("7")];
        s
    }

    #[test]
    fn 四條都成立_列出卡在接回的視窗() {
        let o = resuming_os(60_000);
        let snap = build(&o, &resuming_src());
        let r = snap.rows.iter().find(|r| r.kind == "resuming").expect("要列出來");
        assert_eq!((r.name.as_str(), r.pid, r.by_asn, r.term_id.as_deref()), ("小乙", 502, Some(true), Some("7")));
        assert_eq!(r.started_ms, Some(NOW - 60_000));
        assert_eq!(r.memory_bytes, Some(430), "整棵程序樹合計");
        assert_eq!(r.session_id.as_deref(), Some(SID));
        let mux = snap.rows.iter().find(|r| r.kind == "mux").unwrap();
        assert_eq!(mux.inside, Some(1), "算在終端服務底下");
    }

    #[test]
    fn 視窗名單讀不到時_四條都成立也不列接回中() {
        let o = resuming_os(600_000);
        let mut s = resuming_src();
        assert!(has_resuming(&o, &s), "名單讀到且為空：照常列");
        s.claude_ok = false;
        assert!(!has_resuming(&o, &s), "名單讀不到：不能當成沒有 session 檔");
    }

    #[test]
    fn 狀態依五分鐘門檻() {
        let status = |age| build(&resuming_os(age), &resuming_src()).rows.into_iter().find(|r| r.kind == "resuming").unwrap().status;
        assert_eq!(status(60_000).as_deref(), Some("resuming"));
        assert_eq!(status(live_process::STUCK_AFTER_MS - 1).as_deref(), Some("resuming"));
        assert_eq!(status(live_process::STUCK_AFTER_MS).as_deref(), Some("stuck"));
    }

    fn has_resuming(o: &FakeOs, s: &Sources) -> bool {
        build(o, s).rows.iter().any(|r| r.kind == "resuming")
    }

    #[test]
    fn 任一條不成立就不列() {
        let o = resuming_os(600_000);
        let mut s = resuming_src();
        assert!(has_resuming(&o, &s));
        s.partners = vec![];
        assert!(!has_resuming(&o, &s), "沒有對照表的列");
        s.partners = vec![partner("7"), partner("8")];
        assert!(!has_resuming(&o, &s), "同一個編號兩列");
        s.partners = vec![PartnerRef { started_ms: Some(999), ..partner("7") }];
        assert!(!has_resuming(&o, &s), "建立時間對不上");
        let mut orphan = resuming_os(600_000);
        orphan.table[2].ppid = 1;
        orphan.table[3].ppid = 1;
        assert!(!has_resuming(&orphan, &resuming_src()), "祖先不是這一列的終端服務");
        let mut s2 = resuming_src();
        s2.claude = vec![Window::claude("小乙", Some("idle".into()), "G:/w", 777, NOW, Some(SID.into()))];
        assert!(!has_resuming(&o, &s2), "session 檔出現：走一般的列");
        let mut none = resuming_os(600_000);
        none.cmd.clear();
        assert!(!has_resuming(&none, &resuming_src()), "沒有帶 --resume 的活程序");
    }

    #[test]
    fn 對話換了新編號_同一個程序不列成接回中() {
        // session 檔記新編號、程序是同一個（命令列仍帶舊編號）：只列成一般視窗
        let o = resuming_os(600_000);
        let mut s = resuming_src();
        s.claude = vec![Window::claude("小乙", Some("idle".into()), "G:/w", 502, NOW, Some("99999999-2222-4333-8444-555555555555".into()))];
        let snap = build(&o, &s);
        assert!(snap.rows.iter().all(|r| r.kind != "resuming"), "不能同一個程序列兩次");
        assert!(snap.rows.iter().any(|r| r.kind == "claude" && r.pid == 502));
    }

    #[test]
    fn 卡住的列不重複_掃描到的程序與折疊區同名都不再出現() {
        let o = resuming_os(600_000);
        let mut s = resuming_src();
        s.procs = vec![ProcAgent { pid: 502, engine: "claude".into(), model: None, label: None, background: false, hidden: None, detail: None, place_unknown: false }];
        s.known = vec![KnownEntry { name: "小乙".into(), engine: "claude".into(), facts: WindowFacts::default() }];
        let snap = build(&o, &s);
        assert!(snap.rows.iter().all(|r| r.kind != "process"), "502 不能再列成自己開的");
        assert!(snap.known.is_empty(), "同名不再放進折疊區");
    }

    #[test]
    fn 殘留的工作階段檔不進清單() {
        // 兩個同名的 session 檔：一個程序活著、一個已經不在（殘檔）。清單只會有活著的那個，所以不會被當成重複
        let dir = tempfile::tempdir().unwrap();
        for (pid, name) in [(10u32, "asn真"), (11u32, "asn真")] {
            let body = format!(r#"{{"pid":{pid},"entrypoint":"cli","kind":"interactive","name":"{name}","sessionId":"s{pid}","cwd":"G:/w","startedAt":{NOW}}}"#);
            std::fs::write(dir.path().join(format!("{pid}.json")), body).unwrap();
        }
        let status = dir.path().join("status");
        let live = crate::bridge::roster::read_local_with(dir.path(), &status, |pid, _| pid == 10, 0, "", NOW).unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].pid, 10);
    }

    // ---- 視窗開著、在等你按確認的夥伴（#1635）----

    fn awaiting_os(age_ms: u64) -> FakeOs {
        let mut o = os(
            vec![p(500, 1, switch::MUX_SERVER), p(501, 500, "powershell.exe"), p(502, 501, "claude.exe")],
            &[(500, 9_000), (502, 400)],
            &[(500, 1_000), (501, NOW - age_ms), (502, NOW - age_ms)],
        );
        o.cmd = HashMap::from([(502, "claude.exe --dangerously-skip-permissions -n 小乙".to_string())]);
        o
    }

    fn awaiting_src() -> Sources {
        let mut s = src(vec![]);
        s.partners = vec![PartnerRef { session_id: String::new(), ..partner("7") }];
        s
    }

    #[test]
    fn 在等確認的夥伴列出一列_附終端編號() {
        let snap = build(&awaiting_os(120_000), &awaiting_src());
        let r = snap.rows.iter().find(|r| r.kind == "awaiting").expect("要列出來");
        assert_eq!((r.name.as_str(), r.pid, r.by_asn, r.term_id.as_deref(), r.session_id.as_deref()), ("小乙", 502, Some(true), Some("7"), None));
        assert_eq!(r.memory_bytes, Some(400));
        assert!(snap.rows.iter().all(|r| r.kind != "resuming"));
        assert_eq!(snap.rows.iter().find(|r| r.kind == "mux").unwrap().inside, Some(1));
    }

    #[test]
    fn 在等確認_名單讀不到_剛開不到三十秒_已有session檔_都不列() {
        let has = |o: &FakeOs, s: &Sources| build(o, s).rows.iter().any(|r| r.kind == "awaiting");
        let mut s = awaiting_src();
        s.claude_ok = false;
        assert!(!has(&awaiting_os(120_000), &s));
        assert!(!has(&awaiting_os(10_000), &awaiting_src()));
        let mut live = awaiting_src();
        live.claude = vec![Window::claude("小乙", Some("idle".into()), "G:/w", 502, NOW, Some("s-1".into()))];
        live.all_sessions = Some(vec![stuck_resume::LiveSess { sid: Some("s-1".into()), pid: 502 }]);
        assert!(!has(&awaiting_os(120_000), &live));
        let mut files = awaiting_src();
        files.all_sessions = Some(vec![stuck_resume::LiveSess { sid: Some("s-1".into()), pid: 502 }]);
        assert!(!has(&awaiting_os(120_000), &files));
    }

    #[test]
    fn 在等確認_有檔但被判不活_或讀不到全部檔_都不列() {
        let has = |s: &Sources| build(&awaiting_os(120_000), s).rows.iter().any(|r| r.kind == "awaiting");
        // 活檔清單（claude）是空的＝這個視窗的檔被判不活；但磁碟上有它的檔。舊邏輯只看活檔清單，會把它列成 awaiting
        let mut dead = awaiting_src();
        dead.claude = vec![];
        dead.all_sessions = Some(vec![stuck_resume::LiveSess { sid: Some("s-1".into()), pid: 502 }]);
        assert!(!has(&dead), "有檔但判不活");
        // 讀不到全部檔：不判斷。舊邏輯不看這個欄位，會列出
        let mut unread = awaiting_src();
        unread.all_sessions = None;
        assert!(!has(&unread), "讀不到全部檔");
        assert!(has(&awaiting_src()), "對照：完全沒有檔才列");
    }

    #[test]
    fn 在等確認的程序不再列成自己開的() {
        let mut s = awaiting_src();
        s.procs = vec![ProcAgent { pid: 502, engine: "claude".into(), model: None, label: None, background: false, hidden: None, detail: None, place_unknown: false }];
        s.known = vec![KnownEntry { name: "小乙".into(), engine: "claude".into(), facts: WindowFacts::default() }];
        let snap = build(&awaiting_os(120_000), &s);
        assert!(snap.rows.iter().all(|r| r.kind != "process"));
        assert!(snap.known.is_empty());
    }

    #[test]
    fn 已經列成接回中的不重複列成等確認() {
        let mut o = resuming_os(600_000);
        let cmd = format!("claude.exe --resume {SID} -n 小乙");
        o.cmd = HashMap::from([(502, cmd.clone()), (503, cmd)]);
        let snap = build(&o, &resuming_src());
        assert_eq!(snap.rows.iter().filter(|r| r.kind == "resuming").count(), 1);
        assert!(snap.rows.iter().all(|r| r.kind != "awaiting"));
    }

    // ---- #1909 term：視窗開在哪種終端（只回報，畫面不讀）

    /// 原生主控台的真實形狀：claude → cmd → conhost 風格殼 → explorer（父程序已結束，ppid 懸空）
    fn native_table() -> Vec<Proc> {
        vec![p(40, 999, "explorer.exe"), p(41, 40, "cmd.exe"), p(42, 41, "claude.exe")]
    }

    fn mux_table() -> Vec<Proc> {
        vec![p(40, 999, "explorer.exe"), p(50, 40, switch::MUX_SERVER), p(51, 50, "openconsole.exe"), p(52, 51, "claude.exe")]
    }

    #[test]
    fn term_終端服務底下而且對照表認得_是mux() {
        let mut o = os(mux_table(), &[], &[]);
        o.mux_known = vec![52];
        assert_eq!(term_of(&o, &o.table, 52), TERM_MUX);
    }

    #[test]
    fn term_終端服務底下但對照表對不上_是不明() {
        let o = os(mux_table(), &[], &[]);
        assert_eq!(term_of(&o, &o.table, 52), TERM_UNKNOWN, "別人開的終端服務、認不回來的，不能算成 mux 也不能算原生");
    }

    #[test]
    fn term_鏈完整而且沒有終端服務_是原生() {
        let o = os(native_table(), &[], &[]);
        assert_eq!(term_of(&o, &o.table, 42), TERM_NATIVE);
    }

    #[test]
    fn term_鏈追到ppid為0也算完整() {
        let o = os(vec![p(10, 0, "init"), p(11, 10, "bash"), p(12, 11, "claude.exe")], &[], &[]);
        assert_eq!(term_of(&o, &o.table, 12), TERM_NATIVE);
    }

    #[test]
    fn term_程序表空_是不明() {
        let o = os(vec![], &[], &[]);
        assert_eq!(term_of(&o, &o.table, 42), TERM_UNKNOWN);
    }

    #[test]
    fn term_pid不在表裡_是不明() {
        let o = os(native_table(), &[], &[]);
        assert_eq!(term_of(&o, &o.table, 4242), TERM_UNKNOWN);
    }

    #[test]
    fn term_鏈中斷_父程序已不在表裡_是不明() {
        // cmd 的父程序消失、而且 cmd 不是已知系統程序：看不出它往上是什麼，不能算原生
        let o = os(vec![p(41, 777, "cmd.exe"), p(42, 41, "claude.exe")], &[], &[]);
        assert_eq!(term_of(&o, &o.table, 42), TERM_UNKNOWN);
    }

    #[test]
    fn term_沒有任何上層_是不明() {
        let o = os(vec![p(42, 777, "claude.exe")], &[], &[]);
        assert_eq!(term_of(&o, &o.table, 42), TERM_UNKNOWN);
    }

    #[test]
    fn term_pid被重用_父程序比子程序晚建立_是不明() {
        // cmd(41) 其實是 claude 之後才用到這個編號的別人：往上的鏈不可信
        let o = os(native_table(), &[], &[(40, 1_000), (41, 9_000), (42, 5_000)]);
        assert_eq!(term_of(&o, &o.table, 42), TERM_UNKNOWN);
        let ok = os(native_table(), &[], &[(40, 1_000), (41, 2_000), (42, 5_000)]);
        assert_eq!(term_of(&ok, &ok.table, 42), TERM_NATIVE, "對照：時間順序正常就是原生");
    }

    #[test]
    fn term_asn自帶的gui底下_不是原生也不是mux_是不明() {
        let o = os(vec![p(40, 999, "explorer.exe"), p(60, 40, switch::WEZ_GUI), p(61, 60, "claude.exe")], &[], &[]);
        assert_eq!(term_of(&o, &o.table, 61), TERM_UNKNOWN);
    }

    #[test]
    fn term_清單每列都帶值_夥伴列照判斷_其他列是不明() {
        let mut o = os(native_table(), &[], &[]);
        o.table.push(p(70, 999, "asn.exe"));
        let mut s = src(vec![claude("小東", 42)]);
        s.own_pid = 70;
        let snap = build(&o, &s);
        assert_eq!(snap.rows.iter().find(|r| r.kind == "claude").unwrap().term, TERM_NATIVE);
        assert_eq!(snap.rows.iter().find(|r| r.kind == "asn").unwrap().term, TERM_UNKNOWN, "非夥伴列不套用");
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["rows"][0]["term"], "native", "序列化的欄位名與值是穩定字串");
    }

    // ---- #1860 mux_pid：每一列在哪個終端服務底下（畫面排樹只看它）

    fn mux_pid_of(snap: &Snapshot, name: &str) -> Option<u32> {
        snap.rows.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("找不到 {name}")).mux_pid
    }

    /// 兩個終端服務：500 底下 502（小東）、512（西川）；600 底下 602（雯）；原生主控台 42（小乙）不在任何服務底下
    fn two_mux_os() -> FakeOs {
        os(
            vec![
                p(40, 999, "explorer.exe"),
                p(41, 40, "cmd.exe"),
                p(42, 41, "claude.exe"),
                p(500, 40, switch::MUX_SERVER),
                p(501, 500, "powershell.exe"),
                p(502, 501, "claude.exe"),
                p(511, 500, "powershell.exe"),
                p(512, 511, "claude.exe"),
                p(600, 40, switch::MUX_SERVER),
                p(601, 600, "powershell.exe"),
                p(602, 601, "claude.exe"),
                p(70, 40, "asn.exe"),
            ],
            &[],
            &[],
        )
    }

    #[test]
    fn mux_pid_夥伴視窗帶它所在終端服務的編號_原生的是空() {
        let o = two_mux_os();
        let mut s = src(vec![claude("小東", 502), claude("西川", 512), claude("雯", 602), claude("小乙", 42)]);
        s.own_pid = 70;
        let snap = build(&o, &s);
        assert_eq!(mux_pid_of(&snap, "小東"), Some(500));
        assert_eq!(mux_pid_of(&snap, "西川"), Some(500));
        assert_eq!(mux_pid_of(&snap, "雯"), Some(600), "多個終端服務：各歸各的");
        assert_eq!(mux_pid_of(&snap, "小乙"), None, "原生主控台不在任何終端服務底下");
        assert_eq!(mux_pid_of(&snap, "ASN"), None, "ASN 本體不歸任何終端服務");
    }

    #[test]
    fn mux_pid_終端服務本身是空_終端面板開在服務裡就帶服務編號() {
        let o = two_mux_os();
        let mut s = src(vec![claude("小東", 502)]);
        s.terms = vec![TermIn { id: "t1".into(), profile: "agy".into(), pid: 600, started_ms: Some(1), cwd: "G:/w".into(), adopted: false }];
        let snap = build(&o, &s);
        for r in snap.rows.iter().filter(|r| r.kind == "mux") {
            assert_eq!(r.mux_pid, None, "終端服務自己不算在誰底下");
        }
        let term = snap.rows.iter().find(|r| r.kind == "terminal").unwrap();
        assert_eq!(term.mux_pid, Some(600), "終端面板的編號就是服務本身");
    }

    #[test]
    fn mux_pid_自己開的前景程式不歸屬任何終端服務() {
        let o = two_mux_os();
        let mut s = src(vec![]);
        s.procs = vec![ProcAgent { pid: 502, engine: "claude".into(), model: None, label: None, background: false, hidden: None, detail: None, place_unknown: false }];
        let snap = build(&o, &s);
        let proc_row = snap.rows.iter().find(|r| r.kind == "process").unwrap();
        assert_eq!(proc_row.mux_pid, None);
    }

    #[test]
    fn mux_pid_與inside一致_終端服務的視窗數就是同編號的非process列數() {
        let o = two_mux_os();
        let mut s = src(vec![claude("小東", 502), claude("西川", 512), claude("雯", 602), claude("小乙", 42)]);
        s.terms = vec![TermIn { id: "t1".into(), profile: "agy".into(), pid: 600, started_ms: Some(1), cwd: "G:/w".into(), adopted: false }];
        let snap = build(&o, &s);
        let muxes: Vec<&TaskRow> = snap.rows.iter().filter(|r| r.kind == "mux").collect();
        assert_eq!(muxes.len(), 2);
        for m in muxes {
            let members = snap.rows.iter().filter(|r| r.mux_pid == Some(m.pid) && r.kind != "process").count();
            assert_eq!(m.inside, Some(members), "終端服務 {} 的 inside 要等於 mux_pid 歸給它的列數", m.pid);
        }
        let json = serde_json::to_value(&snap).unwrap();
        let first = json["rows"].as_array().unwrap().iter().find(|r| r["name"] == "小東").unwrap();
        assert_eq!(first["mux_pid"], 500, "序列化的欄位名是穩定字串");
    }

    /// 一審複看 1：清單帶「重啟中」與「還有幾位沒接回」，欄位名是畫面讀的穩定字串
    #[cfg(desktop)]
    #[test]
    fn _1860f_清單帶重啟狀態_與沒接回的人數() {
        let mut out = serde_json::to_value(build(&two_mux_os(), &src(vec![claude("小東", 502)]))).unwrap();
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        add_restart_state(&mut out, false, &names(&["甲", "乙", "丙"]), true, false);
        assert_eq!(out["restart_pending"], 3);
        assert_eq!(out["restart_pending_names"], serde_json::json!(["甲", "乙", "丙"]), "畫面等這些名字都接回才放掉重啟中");
        assert_eq!(out["mux_restarting"], false);
        assert_eq!(out["mux_expected"], true, "用終端服務、有代理等著接回：列得出佔位");
        add_restart_state(&mut out, true, &[], false, true);
        assert_eq!((out["restart_pending"].clone(), out["mux_restarting"].clone()), (serde_json::json!(0), serde_json::json!(true)));
        assert_eq!(out["mux_expected"], false, "沒開終端服務模式（Linux）不列佔位，即使有失敗記號");
        assert!(out["rows"].is_array(), "原本的欄位不動");
    }

    /// 西川複看 B1：mux_expected 跟 use_mux／存下的名單／失敗記號的關聯。只是用終端服務、沒名單沒失敗（服務被正常收掉）→ 假，不能永遠掛著佔位
    #[cfg(desktop)]
    #[test]
    fn _1860f_佔位旗標_看用不用服務_名單_失敗記號() {
        let mut out = serde_json::to_value(build(&two_mux_os(), &src(vec![claude("小東", 502)]))).unwrap();
        let one = vec!["甲".to_string()];
        let cases: [(bool, &[String], bool, bool); 6] = [
            (true, &[], false, false),
            (true, &one, false, true),
            (true, &[], true, true),
            (true, &one, true, true),
            (false, &one, true, false),
            (false, &[], false, false),
        ];
        for (use_mux, pending, failed, want) in cases {
            add_restart_state(&mut out, false, pending, use_mux, failed);
            assert_eq!(out["mux_expected"], want, "use_mux={use_mux} 名單={} 失敗={failed}", pending.len());
        }
    }

    /// 西川複看：collect 讀的是真正的存下名單與失敗記號（拿掉就永遠只靠 use_mux，佔位會永久掛著）
    #[cfg(desktop)]
    #[test]
    fn _1860f_collect_用存下的名單與失敗記號() {
        let src_text = include_str!("taskmgr.rs");
        let c = src_text.split("pub(crate) fn collect(").nth(1).unwrap().split("\n}\n").next().unwrap();
        assert!(c.contains("STASH.get()") && c.contains("last_failed()"), "佔位旗標要看名單與失敗記號");
    }
}
