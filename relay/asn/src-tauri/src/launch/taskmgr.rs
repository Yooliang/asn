//! 工作管理員（0.2.21，電腦版）：把「這台電腦上 ASN 管的程式」整理成一份只讀清單給畫面顯示。
//!
//! 這個模組**只讀**：不結束任何程序、不送任何訊息。畫面上的「停止」一律走既有的關閉流程
//! （夥伴管理的 close、`/asn-close-dup <pid>`、終端面板的 term_stop），不在這裡另開殺程序的路。
//!
//! 資料來源各管一塊（和名單同一份）：Claude 視窗讀 `~/.claude/sessions`（活著、而且還是當初那個程序才列，殘檔不算）、
//! pi 視窗讀擴充的登記檔、終端面板讀 ASN 自己的對照表、其餘程序用程序掃描（只能看）。
//! 記憶體＝整棵程序樹的工作集合計（Windows 用 GetProcessMemoryInfo、Linux 讀 /proc），拿不到就是 None，畫面顯示「—」。
//! 作業系統動作全走 `Os` 介面，測試用假的。
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
    /// claude／pi／process（自己開的前景程式，只能看）／terminal（終端面板）／mux（終端服務，只能看）／asn（ASN 本體與它自己的視窗，只能看）
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
    pub pi: Vec<Window>,
    pub procs: Vec<ProcAgent>,
    pub terms: Vec<TermIn>,
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
        };
        listed.push((row, mux_of(w.pid)));
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
        };
        listed.push((row, if is_mux { Some(t.pid) } else { mux_of(t.pid) }));
    }

    for a in &src.procs {
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
        };
        listed.push((row, None));
    }

    let mut rows: Vec<TaskRow> = listed.iter().map(|(r, _)| r.clone()).collect();
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
        });
    }
    rows.truncate(ROWS_MAX);

    let running: HashSet<&str> = src.claude.iter().chain(src.pi.iter()).map(|w| w.name.as_str()).collect();
    let known = src
        .known
        .iter()
        .filter(|k| !k.name.is_empty() && !running.contains(k.name.as_str()))
        .map(|k| KnownRow { name: k.name.clone(), engine: k.engine.clone(), cwd: k.facts.cwd.clone() })
        .take(ROWS_MAX)
        .collect();
    Snapshot { rows, known, now_ms: src.now_ms }
}

/// 讀真實環境：視窗名單、程序掃描、終端面板（呼叫端給）、認得的名字。讀不到視窗名單就回錯（畫面顯示暫時讀不到，不當成沒有程式）
#[cfg(desktop)]
pub(crate) fn collect(work_dir: &std::path::Path, node: &str, asn_window: &str, terms: Vec<TermIn>) -> Result<serde_json::Value, String> {
    use crate::bridge::{engines, known, procscan, roster};
    let home = crate::identity::home_dir();
    let now = crate::heartbeat::now_ms();
    let claude = roster::read_local_with(&home.join(".claude").join("sessions"), &home.join(".asn").join("status"), crate::heartbeat::session_alive, 0, "", now).ok_or_else(|| "讀不到本機視窗清單".to_string())?;
    let pi = engines::pi::read_windows(&engines::pi::windows_dir(&home), now, crate::heartbeat::pid_alive);
    // 已登記成視窗的程序不再列成「自己開的」（同名單的做法）
    let skip: Vec<u32> = claude.iter().chain(pi.iter()).map(|w| w.pid).filter(|p| *p != 0).collect();
    let procs = procscan::scan_system_excluding(&skip);
    let known_entries = known::Known::load(&work_dir.join(known::KNOWN_FILE), now).entries();
    let mailbox = crate::envc::get("ASN_MAILBOX_NAME").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("{node}-收發室"));
    let protected = vec![mailbox, asn_window.to_string()];
    let src = Sources { claude, pi, procs, terms, known: known_entries, protected, own_pid: std::process::id(), now_ms: now };
    serde_json::to_value(build(&switch::RealOs, &src)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::known::WindowFacts;
    use std::collections::HashMap;

    const NOW: u64 = 1_800_000_000_000;

    fn p(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }

    /// 假的作業系統：程序表、記憶體、建立時間都是寫死的；任何「動手」的方法都不該被呼叫
    struct FakeOs {
        table: Vec<Proc>,
        mem: HashMap<u32, u64>,
        started: HashMap<u32, u64>,
    }

    impl Os for FakeOs {
        fn cmdline(&self, _pid: u32) -> Option<String> {
            None
        }
        fn processes(&self) -> Vec<Proc> {
            self.table.clone()
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
        FakeOs { table, mem: mem.iter().copied().collect(), started: started.iter().copied().collect() }
    }

    fn src(claude: Vec<Window>) -> Sources {
        Sources { claude, pi: vec![], procs: vec![], terms: vec![], known: vec![], protected: vec![], own_pid: 0, now_ms: NOW }
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
}
