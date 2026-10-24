//! 夥伴主控台切換的「找誰、找哪扇窗」純邏輯（不碰 Win32，作業系統介面由 [`ConsoleOs`] 注入，測試用假的）：
//! - [`resolve_pid`]：名單條目（引擎＋名字＋條目種類＋選填 pid）→ 本機要查視窗的 pid，或「為什麼不行」的原因；
//! - [`find_for`]：由 pid（必要時往上找包裝它的殼）→ 主控台視窗，找不到就依情況給精確原因。
use super::switch::Proc;
use crate::bridge::procscan::ProcAgent;
use serde_json::Value;

pub(crate) const NOT_FOUND: &str = "找不到這個夥伴的主控台視窗";

/// 本機資料來源的快照（呼叫端依需要載入，沒載的留空）
#[derive(Default)]
pub(crate) struct Sources {
    /// ~/.claude/sessions 的記錄
    pub sessions: Vec<Value>,
    /// ~/.asn/pi-windows 登記的 pi 視窗（名單上的名字, pid）
    pub pi_windows: Vec<(String, u32)>,
    /// 程序掃描到的執行中代理
    pub procs: Vec<ProcAgent>,
    /// ~/.asn/agents.json 設定的 ASN 背景工作者名字
    pub workers: Vec<String>,
}

/// 一個名單條目的查詢請求
pub(crate) struct Ask<'a> {
    pub engine: &'a str,
    pub name: &'a str,
    /// 條目種類（名單的 kind）；「process」＝程序掃描列出的本機程式
    pub kind: &'a str,
    pub pid: Option<u32>,
}

/// 找到的主控台視窗
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ConsoleWin {
    pub hwnd: i64,
    pub visible: bool,
}

pub(crate) trait ConsoleOs {
    fn find_console(&self, pid: u32) -> Option<ConsoleWin>;
    /// 這個程序擁有的 Windows Terminal 頂層視窗（CASCADIA_HOSTING_WINDOW_CLASS）
    fn find_wt_windows(&self, wt_pid: u32) -> Vec<ConsoleWin>;
    fn table(&self) -> Vec<Proc>;
    fn own_pid(&self) -> u32;
}

const WORKER_REASON: &str = "這是 ASN 在背景執行的工作者，沒有終端機視窗";
const BACKGROUND_REASON: &str = "這是在背景執行的程式（沒有人在前面操作），沒有自己的終端機視窗";
const GONE_REASON: &str = "這個程式已經結束";
const PROC_MISSING_REASON: &str = "找不到這個程式，可能剛好結束，或不是這台電腦上的程式";
pub(crate) const WT_SHARED_REASON: &str = "這個夥伴開在共用的 Windows Terminal 分頁裡，無法單獨隱藏；之後由 ASN 開的夥伴會各自一個視窗";

/// 名單條目 → 要查視窗的 pid；不行就回原因。
/// 安全：任何 pid（包括請求明確帶的）都必須在本機掃描／登記的結果裡、引擎對得上、程序還活著才採用，
/// 所以這個介面不能被拿來顯示或隱藏任意程式的視窗。
pub(crate) fn resolve_pid(ask: &Ask, src: &Sources, alive: &dyn Fn(u32) -> bool) -> Result<u32, String> {
    let engine = ask.engine.trim().to_lowercase();
    let engine = if engine.is_empty() { "claude" } else { engine.as_str() };
    if engine == "acp" {
        return Err(WORKER_REASON.into());
    }
    if ask.kind == "process" || ask.pid.is_some() {
        return resolve_process(engine, ask, src, alive);
    }
    if engine != "claude" && engine != "pi" && src.workers.iter().any(|w| w == ask.name) {
        return Err(WORKER_REASON.into());
    }
    let found = match engine {
        "claude" => super::console::pick_session_pid(&src.sessions, ask.name, alive),
        "pi" => src.pi_windows.iter().filter(|(n, _)| n == ask.name).map(|(_, p)| *p).find(|p| alive(*p)),
        _ => None,
    };
    found.ok_or_else(|| NOT_FOUND.to_string())
}

fn resolve_process(engine: &str, ask: &Ask, src: &Sources, alive: &dyn Fn(u32) -> bool) -> Result<u32, String> {
    if let Some(pid) = ask.pid {
        // 明確 pid：只認掃描到的代理、claude 工作階段、pi 登記視窗三種來源，而且引擎要對
        let proc = src.procs.iter().find(|a| a.pid == pid);
        if let Some(a) = proc {
            if a.engine != engine {
                return Err(PROC_MISSING_REASON.into());
            }
            return check_proc(a, alive);
        }
        let in_sessions = engine == "claude" && src.sessions.iter().any(|s| s.get("pid").and_then(Value::as_u64) == Some(pid as u64));
        let in_pi = engine == "pi" && src.pi_windows.iter().any(|(_, p)| *p == pid);
        return if (in_sessions || in_pi) && alive(pid) { Ok(pid) } else { Err(PROC_MISSING_REASON.into()) };
    }
    let a = src.procs.iter().find(|a| a.engine == engine && a.name() == ask.name).ok_or_else(|| PROC_MISSING_REASON.to_string())?;
    check_proc(a, alive)
}

fn check_proc(a: &ProcAgent, alive: &dyn Fn(u32) -> bool) -> Result<u32, String> {
    if a.background {
        return Err(BACKGROUND_REASON.into());
    }
    if !alive(a.pid) {
        return Err(GONE_REASON.into());
    }
    Ok(a.pid)
}

/// 往上找殼時可以穿過的程序（它們和代理共用同一個主控台）；遇到其他程序（explorer、IDE…）就停
const WRAPPERS: &[&str] = &["cmd.exe", "powershell.exe", "pwsh.exe", "node.exe", "bun.exe", "python.exe", "pythonw.exe", "py.exe", "npm.exe", "npx.exe"];
const MAX_WRAP_LEVELS: usize = 4;
const WT_NAME: &str = "windowsterminal.exe";
const TAB_HOSTS: &[&str] = &["openconsole.exe", "conhost.exe"];

/// pid → 它的主控台視窗（含往上找殼）；找不到回原因。
/// 傳統主控台：自己或殼擁有 ConsoleWindowClass 視窗就用。
/// Windows Terminal：只有「整個 Windows Terminal 程序只有一個分頁、只擁有一扇頂層視窗」才算專屬，才能單獨隱藏；否則反灰。
pub(crate) fn find_for(pid: u32, os: &dyn ConsoleOs) -> Result<(u32, ConsoleWin), String> {
    let table = os.table();
    let own = os.own_pid();
    let mut forbidden = super::switch::ancestors(&table, own);
    forbidden.push(own);
    if forbidden.contains(&pid) {
        return Err(NOT_FOUND.into());
    }
    let mut cands = vec![pid];
    let mut cur = pid;
    for _ in 0..MAX_WRAP_LEVELS {
        let Some(par) = super::switch::parent_of(&table, cur) else { break };
        if forbidden.contains(&par.pid) || cands.contains(&par.pid) || !WRAPPERS.contains(&par.name.as_str()) {
            break;
        }
        cands.push(par.pid);
        cur = par.pid;
    }
    for c in &cands {
        if let Some(w) = os.find_console(*c) {
            return Ok((*c, w));
        }
    }
    let wt = super::switch::ancestors(&table, pid).into_iter().take(8).find(|a| table.iter().any(|p| p.pid == *a && p.name == WT_NAME));
    let Some(wt) = wt else { return Err(super::console::no_window_reason(false).into()) };
    let tabs = table.iter().filter(|p| p.ppid == wt && TAB_HOSTS.contains(&p.name.as_str())).count();
    if tabs != 1 {
        return Err(WT_SHARED_REASON.into());
    }
    let wins = os.find_wt_windows(wt);
    if wins.len() != 1 {
        return Err(WT_SHARED_REASON.into());
    }
    Ok((wt, wins[0]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    fn proc(pid: u32, engine: &str, label: Option<&str>, background: bool) -> ProcAgent {
        ProcAgent { pid, engine: engine.into(), model: None, label: label.map(String::from), background }
    }
    fn ask<'a>(engine: &'a str, name: &'a str, kind: &'a str, pid: Option<u32>) -> Ask<'a> {
        Ask { engine, name, kind, pid }
    }
    fn all_alive(_: u32) -> bool {
        true
    }

    #[test]
    fn claude_照舊依名字找工作階段() {
        let src = Sources { sessions: vec![json!({ "pid": 10, "name": "甲", "startedAt": 1, "kind": "interactive" })], ..Default::default() };
        assert_eq!(resolve_pid(&ask("claude", "甲", "", None), &src, &all_alive), Ok(10));
        assert_eq!(resolve_pid(&ask("", "甲", "", None), &src, &all_alive), Ok(10), "引擎沒寫當 Claude");
        assert_eq!(resolve_pid(&ask("claude", "乙", "", None), &src, &all_alive), Err(NOT_FOUND.into()));
        assert_eq!(resolve_pid(&ask("claude", "甲", "", None), &src, &|_| false), Err(NOT_FOUND.into()), "程序已不在");
    }

    #[test]
    fn pi_用登記檔的pid() {
        let src = Sources { pi_windows: vec![("小派".into(), 20), ("小派-21".into(), 21)], ..Default::default() };
        assert_eq!(resolve_pid(&ask("pi", "小派", "", None), &src, &all_alive), Ok(20));
        assert_eq!(resolve_pid(&ask("pi", "小派-21", "", None), &src, &all_alive), Ok(21), "重名改成 名字-pid 的也對得上");
        assert!(resolve_pid(&ask("pi", "小派", "", None), &src, &|p| p != 20).is_err(), "登記的程序死了");
        assert_eq!(resolve_pid(&ask("pi", "不存在", "", None), &src, &all_alive), Err(NOT_FOUND.into()));
    }

    #[test]
    fn 掃描條目_Grok_codex_gemini_pi_claude_用條目名對到pid() {
        let procs = vec![proc(30, "grok", None, false), proc(31, "codex", None, false), proc(32, "gemini", None, false), proc(33, "pi", Some("MiniMax"), false), proc(34, "claude", None, false)];
        let src = Sources { procs: procs.clone(), ..Default::default() };
        for p in &procs {
            let name = p.name();
            assert_eq!(resolve_pid(&ask(&p.engine, &name, "process", None), &src, &all_alive), Ok(p.pid), "{name}");
        }
        assert!(resolve_pid(&ask("grok", "grok #99（前景）", "process", None), &src, &all_alive).is_err());
    }

    #[test]
    fn 掃描條目_明確pid優先_但引擎要對得上() {
        let src = Sources { procs: vec![proc(30, "grok", None, false)], ..Default::default() };
        assert_eq!(resolve_pid(&ask("grok", "隨便", "process", Some(30)), &src, &all_alive), Ok(30));
        assert!(resolve_pid(&ask("codex", "隨便", "process", Some(30)), &src, &all_alive).is_err(), "引擎不符不收");
        assert!(resolve_pid(&ask("grok", "隨便", "process", Some(31)), &src, &all_alive).is_err(), "不在掃描結果的 pid 一律不收（不能拿來隱藏任意視窗）");
        assert!(resolve_pid(&ask("grok", "隨便", "", Some(4)), &src, &all_alive).is_err(), "沒寫種類也要過同一道驗證");
    }

    #[test]
    fn 掃描條目_背景執行與已結束_原因各自精確() {
        let src = Sources { procs: vec![proc(40, "claude", None, true), proc(41, "grok", None, false)], ..Default::default() };
        let bg = src.procs[0].name();
        let e = resolve_pid(&ask("claude", &bg, "process", None), &src, &all_alive).unwrap_err();
        assert!(e.contains("背景執行") && e.contains("沒有自己的終端機視窗"), "{e}");
        let fg = src.procs[1].name();
        let e = resolve_pid(&ask("grok", &fg, "process", None), &src, &|p| p != 41).unwrap_err();
        assert!(e.contains("已經結束"), "{e}");
        assert_ne!(resolve_pid(&ask("grok", "無此條目 #1（前景）", "process", None), &src, &all_alive).unwrap_err(), e);
    }

    #[test]
    fn asn自己的背景工作者_反灰並寫明原因() {
        let src = Sources { workers: vec!["Grok工作者".into(), "Gemini".into()], ..Default::default() };
        for (eng, name) in [("grok", "Grok工作者"), ("gemini", "Gemini"), ("acp", "Gemini")] {
            let e = resolve_pid(&ask(eng, name, "", None), &src, &all_alive).unwrap_err();
            assert_eq!(e, "這是 ASN 在背景執行的工作者，沒有終端機視窗", "{eng}/{name}");
        }
        let e = resolve_pid(&ask("acp", "不在設定裡", "", None), &src, &all_alive).unwrap_err();
        assert!(e.contains("工作者"), "引擎是 acp 本身就足以判定：{e}");
    }

    #[test]
    fn 非掃描非登記的其他引擎_回找不到() {
        let src = Sources::default();
        assert_eq!(resolve_pid(&ask("grok", "某人", "", None), &src, &all_alive), Err(NOT_FOUND.into()));
        assert_eq!(resolve_pid(&ask("codex", "某人", "", None), &src, &all_alive), Err(NOT_FOUND.into()));
    }

    // ---- 由 pid 找視窗（假的作業系統，不碰任何真實視窗）----
    struct FakeOs {
        table: Vec<Proc>,
        consoles: Vec<(u32, ConsoleWin)>,
        wt: Vec<(u32, ConsoleWin)>,
        asked: RefCell<Vec<u32>>,
        asked_wt: RefCell<Vec<u32>>,
    }
    impl ConsoleOs for FakeOs {
        fn find_console(&self, pid: u32) -> Option<ConsoleWin> {
            self.asked.borrow_mut().push(pid);
            self.consoles.iter().find(|(p, _)| *p == pid).map(|(_, w)| *w)
        }
        fn find_wt_windows(&self, wt_pid: u32) -> Vec<ConsoleWin> {
            self.asked_wt.borrow_mut().push(wt_pid);
            self.wt.iter().filter(|(p, _)| *p == wt_pid).map(|(_, w)| *w).collect()
        }
        fn table(&self) -> Vec<Proc> {
            self.table.clone()
        }
        fn own_pid(&self) -> u32 {
            1
        }
    }
    fn p(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }
    fn os(table: Vec<Proc>, consoles: Vec<(u32, ConsoleWin)>) -> FakeOs {
        FakeOs { table, consoles, wt: vec![], asked: RefCell::new(vec![]), asked_wt: RefCell::new(vec![]) }
    }
    fn os_wt(table: Vec<Proc>, wt: Vec<(u32, ConsoleWin)>) -> FakeOs {
        FakeOs { wt, ..os(table, vec![]) }
    }
    const W: ConsoleWin = ConsoleWin { hwnd: 777, visible: true };

    #[test]
    fn 自己有主控台視窗_直接用() {
        let o = os(vec![p(1, 0, "asn.exe"), p(50, 9, "node.exe")], vec![(50, W)]);
        assert_eq!(find_for(50, &o), Ok((50, W)));
        assert_eq!(*o.asked.borrow(), vec![50], "找到就不再往上問");
    }

    #[test]
    fn 自己沒有_往上找殼_node_cmd_都行() {
        let o = os(vec![p(1, 0, "asn.exe"), p(60, 59, "node.exe"), p(59, 58, "cmd.exe"), p(58, 8, "powershell.exe")], vec![(59, W)]);
        assert_eq!(find_for(60, &o), Ok((59, W)));
    }

    #[test]
    fn 往上找遇到不是殼的程序就停_不會抓到別人的視窗() {
        let o = os(vec![p(1, 0, "asn.exe"), p(60, 59, "node.exe"), p(59, 8, "explorer.exe"), p(8, 0, "x.exe")], vec![(59, W), (8, W)]);
        let e = find_for(60, &o).unwrap_err();
        assert_eq!(e, super::super::console::no_window_reason(false));
        assert_eq!(*o.asked.borrow(), vec![60], "explorer 不是殼，不往上問");
    }

    #[test]
    fn 不會往上抓到ASN自己或ASN的祖先() {
        let o = os(vec![p(100, 0, "devshell.exe"), p(1, 100, "asn.exe"), p(60, 1, "node.exe")], vec![(1, W), (100, W)]);
        assert!(find_for(60, &o).is_err());
        assert_eq!(*o.asked.borrow(), vec![60]);
    }

    const WT_SHARED: &str = "這個夥伴開在共用的 Windows Terminal 分頁裡，無法單獨隱藏；之後由 ASN 開的夥伴會各自一個視窗";

    #[test]
    fn windows_terminal_獨佔一個視窗_只動那一個視窗() {
        // WT 本體 5 底下只有一個分頁（一個 openconsole），而且只擁有一扇頂層視窗
        let o = os_wt(vec![p(1, 0, "asn.exe"), p(70, 69, "node.exe"), p(69, 68, "pwsh.exe"), p(68, 5, "openconsole.exe"), p(5, 4, "windowsterminal.exe")], vec![(5, W)]);
        assert_eq!(find_for(70, &o), Ok((5, W)));
        assert_eq!(*o.asked_wt.borrow(), vec![5]);
    }

    #[test]
    fn windows_terminal_同視窗多個分頁_反灰_不隱藏連累別人() {
        let o = os_wt(
            vec![p(1, 0, "asn.exe"), p(70, 69, "node.exe"), p(69, 68, "pwsh.exe"), p(68, 5, "openconsole.exe"), p(80, 79, "pwsh.exe"), p(79, 5, "openconsole.exe"), p(5, 4, "windowsterminal.exe")],
            vec![(5, W)],
        );
        assert_eq!(find_for(70, &o), Err(WT_SHARED.into()));
        assert!(o.asked_wt.borrow().is_empty(), "多分頁連視窗都不去查，更不會有人拿它去隱藏");
    }

    #[test]
    fn windows_terminal_一個程序擁有多扇視窗或找不到視窗_反灰() {
        let two = os_wt(vec![p(1, 0, "asn.exe"), p(70, 68, "node.exe"), p(68, 5, "openconsole.exe"), p(5, 4, "windowsterminal.exe")], vec![(5, W), (5, ConsoleWin { hwnd: 888, visible: true })]);
        assert_eq!(find_for(70, &two), Err(WT_SHARED.into()), "分不出是哪一扇，不動");
        let none = os_wt(vec![p(1, 0, "asn.exe"), p(70, 68, "node.exe"), p(68, 5, "openconsole.exe"), p(5, 4, "windowsterminal.exe")], vec![]);
        assert!(find_for(70, &none).is_err());
    }

    #[test]
    fn windows_terminal_沒有任何分頁資訊_不猜() {
        // 一個 openconsole 都數不到＝不確定結構，寧可反灰
        let o = os_wt(vec![p(1, 0, "asn.exe"), p(70, 5, "node.exe"), p(5, 4, "windowsterminal.exe")], vec![(5, W)]);
        assert_eq!(find_for(70, &o), Err(WT_SHARED.into()));
    }

    #[test]
    fn 拿自己asn的pid來查_一律拒絕() {
        let o = os(vec![p(1, 0, "asn.exe")], vec![(1, W)]);
        assert!(find_for(1, &o).is_err());
        assert!(o.asked.borrow().is_empty());
    }
}
