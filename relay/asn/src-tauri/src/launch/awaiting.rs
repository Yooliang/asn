//! 「ASN 開的、程序還活著、但還沒進到對話」的夥伴視窗判斷（#1635）。
//!
//! 情境：Claude 第一次的確認畫面（信任資料夾、略過權限的同意）還在等本人按，所以還沒寫出 `sessions/<pid>.json`。
//! 名單與工作管理員原本只靠 sessions 檔找視窗，看不到它，寄信只得到「找不到」。
//!
//! 原則：ASN 只「看」與「說明」，不代按任何確認、不寫任何設定。認不出來就照舊（寧可漏報）。
//!
//! 全部成立才算：
//! 1. 終端對照表裡有一列夥伴視窗（claude），名字唯一（同名兩列以上不猜）；
//! 2. 程序表上有活著的互動式 claude，命令列帶 `-n <名字>` 且和那一列的名字相同（讀不到命令列就不認）；
//! 3. 那些程序往上找，都找得到這一列的終端服務（或 ASN 自己的視窗），編號與建立時間和對照表記的一樣；
//! 4. 這些程序（含祖先與子孫）都不是活 sessions 檔的程序；
//! 5. 啟動超過 [`MIN_AGE_MS`]（剛開的視窗還沒來得及寫檔，不算）。
//!
//! 只讀程序表與對照表，判斷用的作業系統介面由外面傳進來，測試用假的。
use super::live_process;
use super::stuck_resume::{self, LiveSess, PartnerRef, StopHost};
use super::switch::{self, Os};
use crate::bridge::procscan::ProcAgent;
use std::collections::HashSet;
use std::sync::Arc;

/// 名單上這類條目的說明（kind＝process、receivable＝false 的「僅顯示」條目帶這句）。
/// 後台只保留 detail 等少數欄位，所以新版畫面靠這句認出它；ui/lib/awaiting.mjs 有同一句，test/awaiting.test.mjs 檢查兩邊一致
pub(crate) const DETAIL: &str = "視窗開著，但在等你按確認";

/// 啟動要超過這麼久才算（剛開的視窗還沒來得及寫出 sessions 檔）
pub(crate) const MIN_AGE_MS: u64 = 30_000;

/// 寄信給它時回給寄件人的原因（只講現況與下一步，不叫人代按）
pub(crate) const MAIL_WHY: &str = "視窗開著，但還沒進到對話（可能在等你按確認）。信沒有送達，請到那台電腦的視窗看清楚後自己選，再寄一次";

/// 停止前驗證不過時的固定文案
pub(crate) const NO_LONGER_AWAITING: &str = "這個視窗已經不是「等你按確認」的狀態，請重新整理清單";

/// 名單條目上用的名字最多取幾個字
const LABEL_MAX: usize = 30;

/// 判斷成立的結果
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Awaiting {
    pub partner: PartnerRef,
    /// 命令列帶這個夥伴名的活程序（至少一個）
    pub pids: Vec<u32>,
    /// 其中程序樹最上層的那一個
    pub root_pid: u32,
    /// 最早的啟動時間
    pub started_ms: u64,
}

/// 現在有哪些夥伴視窗是「還沒進到對話、在等本人按確認」。
/// `live`＝現在有活 sessions 檔的（對話編號, 程序編號），呼叫端必須是真的讀到了才呼叫（讀不到就不要判斷）
pub(crate) fn identify_all(os: &dyn Os, partners: &[PartnerRef], live: &[LiveSess], now_ms: u64) -> Vec<Awaiting> {
    if partners.is_empty() {
        return Vec::new();
    }
    let table = os.processes();
    // 只看 claude／node／bun 的程序（不逐一讀所有程序的命令列）；活著而且是互動式 claude；讀不到命令列就不認
    let named: Vec<(u32, String)> = table
        .iter()
        .filter(|p| p.name.starts_with("claude") || matches!(p.name.as_str(), "node" | "node.exe" | "bun" | "bun.exe"))
        .filter(|p| live_process::live_claude_pid(os, &table, p.pid))
        .filter_map(|p| {
            let cmd = os.cmdline(p.pid)?;
            Some((p.pid, live_process::cmdline_name(&cmd)?))
        })
        .collect();
    let mut out: Vec<Awaiting> = Vec::new();
    for partner in partners {
        let name = partner.name.trim();
        if name.is_empty() || partners.iter().filter(|q| q.name.trim() == name).count() != 1 {
            continue;
        }
        let mut pids: Vec<u32> = named.iter().filter(|(pid, n)| n == name && stuck_resume::anchored(os, &table, partner, *pid)).map(|(pid, _)| *pid).collect();
        if pids.is_empty() {
            continue;
        }
        pids.sort_unstable();
        if stuck_resume::touches_live_session(os, &table, &pids, live) {
            continue;
        }
        let Some(started_ms) = live_process::earliest_started_ms(os, &pids) else { continue };
        if now_ms.saturating_sub(started_ms) < MIN_AGE_MS {
            continue;
        }
        out.push(Awaiting { partner: partner.clone(), root_pid: stuck_resume::top_pid(&table, &pids), pids, started_ms });
    }
    out
}

/// 名單上顯示用的名字（去掉控制字元、最多 30 字）
fn label_of(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).take(LABEL_MAX).collect::<String>().trim().to_string()
}

/// 名單的「僅顯示」條目：名字是「claude · <夥伴名> #<程序編號>」，不和任何視窗名相撞，橋不會把信投給它
pub(crate) fn proc_agent(a: &Awaiting) -> ProcAgent {
    ProcAgent { pid: a.root_pid, engine: "claude".into(), model: None, label: Some(label_of(&a.partner.name)), background: false, hidden: None, detail: Some(DETAIL.into()), place_unknown: true }
}

/// 寄信給這個名字時回給寄件人的整句
pub(crate) fn mail_reply(name: &str) -> String {
    format!("[收發室] 轉交給 {name} 沒有成功：{MAIL_WHY}。")
}

/// 現在的「等你按確認」清單（橋每輪名單與寄信回覆共用；測試換假的）
pub(crate) type AwaitingSource = Arc<dyn Fn(u64) -> Vec<Awaiting> + Send + Sync>;

/// 正式用的來源：現讀 sessions 檔與終端對照表。讀不到 sessions 檔就回空（不判斷）；沒有畫面的建置與測試一律空
pub(crate) fn real_source() -> AwaitingSource {
    Arc::new(real_awaiting)
}

fn real_awaiting(now_ms: u64) -> Vec<Awaiting> {
    #[cfg(all(feature = "gui", not(test)))]
    {
        let Some(live) = stuck_resume::live_claude_sessions(now_ms) else { return Vec::new() };
        identify_all(&switch::RealOs, &super::term::partner_rows(), &live, now_ms)
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        let _ = now_ms;
        Vec::new()
    }
}

/// 停止「等你按確認」的視窗：先把條件再驗一次，成立才呼叫既有的 stop_partner／stop_gui。
/// `id` 是畫面給的終端編號、`name` 是夥伴名，兩者都要和驗出來的那一列一致，否則拒絕
pub(crate) fn stop_verified(os: &dyn Os, host: &dyn StopHost, partners: &[PartnerRef], live: &[LiveSess], id: &str, name: &str, now_ms: u64) -> Result<(), String> {
    let found = identify_all(os, partners, live, now_ms).into_iter().find(|a| a.partner.id == id && a.partner.name.trim() == name.trim()).ok_or_else(|| NO_LONGER_AWAITING.to_string())?;
    if found.partner.mux {
        // 驗證到停止之間對照表可能變動：停之前再核對這一列記的還是這個夥伴
        if host.partner_row_name(&found.partner.id).as_deref().map(str::trim) != Some(name.trim()) {
            return Err(NO_LONGER_AWAITING.into());
        }
        host.stop_partner(&found.partner.id)
    } else {
        // 收自己的視窗會連整個視窗一起關：裡面除了這批程序（與它們的外層殼）還有別的程序，就不動
        let table = os.processes();
        let mut ended: HashSet<u32> = HashSet::new();
        for p in &found.pids {
            ended.extend(super::taskmgr::tree_pids(&table, *p, &|x| os.started_ms(x)));
            ended.extend(switch::ancestors(&table, *p).into_iter().take_while(|a| *a != found.partner.gui_pid));
        }
        let ended: Vec<u32> = ended.into_iter().collect();
        if switch::wez_has_others(os, found.partner.gui_pid, &ended) {
            return Err(stuck_resume::OTHER_TABS_IN_WINDOW.into());
        }
        host.stop_gui(found.partner.gui_pid)
    }
}

/// `term_stop` 帶了夥伴名時走這裡：現讀對照表與 session 檔，驗過才停
#[cfg(all(feature = "gui", desktop))]
pub(crate) fn stop_real(terms: &super::term::LiveTerms, id: &str, name: &str) -> Result<(), String> {
    let now = crate::heartbeat::now_ms();
    let live = stuck_resume::live_claude_sessions(now).ok_or_else(|| "讀不到本機視窗清單，請稍後再試".to_string())?;
    stop_verified(&switch::RealOs, terms, &terms.partner_rows(), &live, id, name, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::switch::Proc;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const NOW: u64 = 1_800_000_000_000;
    const MUX: u32 = 500;
    const MUX_AT: u64 = 1_000;

    fn p(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }

    struct Fake {
        table: Vec<Proc>,
        cmd: HashMap<u32, String>,
        started: HashMap<u32, u64>,
        wez: Vec<(u32, u64)>,
    }

    impl Os for Fake {
        fn cmdline(&self, pid: u32) -> Option<String> {
            self.cmd.get(&pid).cloned()
        }
        fn processes(&self) -> Vec<Proc> {
            self.table.clone()
        }
        fn alive(&self, pid: u32) -> bool {
            self.table.iter().any(|x| x.pid == pid)
        }
        fn started_ms(&self, pid: u32) -> Option<u64> {
            self.started.get(&pid).copied()
        }
        fn own_wez(&self) -> Vec<(u32, u64)> {
            self.wez.clone()
        }
        fn close_window(&self, _pid: u32) -> bool {
            panic!("判斷不能送關閉訊息")
        }
        fn terminate(&self, _pid: u32) -> Result<(), String> {
            panic!("判斷不能結束程序")
        }
    }

    /// 終端服務 500 ← 包裝殼 501 ← claude 502（命令列帶 -n 小乙）；claude 在 `age_ms` 之前啟動
    fn mux_fake(age_ms: u64) -> Fake {
        Fake {
            table: vec![p(MUX, 1, switch::MUX_SERVER), p(501, MUX, "powershell.exe"), p(502, 501, "claude.exe")],
            cmd: HashMap::from([(502, r#""C:\claude.exe" --dangerously-skip-permissions -n 小乙 --remote-control 小乙"#.to_string())]),
            started: HashMap::from([(MUX, MUX_AT), (501, NOW - age_ms), (502, NOW - age_ms)]),
            wez: vec![],
        }
    }

    fn row(id: &str, name: &str) -> PartnerRef {
        PartnerRef { id: id.into(), name: name.into(), session_id: String::new(), mux: true, gui_pid: MUX, started_ms: Some(MUX_AT), cwd: "G:/w".into() }
    }

    fn live(pid: u32) -> LiveSess {
        LiveSess { sid: Some("sid-x".into()), pid }
    }

    #[test]
    fn 條件都成立_認得出來() {
        let a = identify_all(&mux_fake(120_000), &[row("7", "小乙")], &[], NOW);
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].partner.id.as_str(), a[0].root_pid, a[0].pids.clone(), a[0].started_ms), ("7", 502, vec![502], NOW - 120_000));
    }

    #[test]
    fn 啟動不到三十秒不算_剛好三十秒算() {
        assert!(identify_all(&mux_fake(MIN_AGE_MS - 1), &[row("7", "小乙")], &[], NOW).is_empty());
        assert_eq!(identify_all(&mux_fake(MIN_AGE_MS), &[row("7", "小乙")], &[], NOW).len(), 1);
    }

    #[test]
    fn 已經有活的_sessions_檔就不算() {
        let os = mux_fake(600_000);
        assert!(identify_all(&os, &[row("7", "小乙")], &[live(502)], NOW).is_empty(), "同一個程序");
        assert!(identify_all(&os, &[row("7", "小乙")], &[live(501)], NOW).is_empty(), "外層殼");
        assert_eq!(identify_all(&os, &[row("7", "小乙")], &[live(999)], NOW).len(), 1, "不相干的活視窗不影響");
    }

    #[test]
    fn 任一條不成立就不認() {
        let ok = [row("7", "小乙")];
        assert!(identify_all(&mux_fake(600_000), &[], &[], NOW).is_empty(), "對照表沒有這一列");
        let two = [row("7", "小乙"), row("8", "小乙")];
        assert!(identify_all(&mux_fake(600_000), &two, &[], NOW).is_empty(), "同名兩列不猜");
        let other_name = [row("7", "小丙")];
        assert!(identify_all(&mux_fake(600_000), &other_name, &[], NOW).is_empty(), "命令列的名字和那一列不同");
        let mut no_cmd = mux_fake(600_000);
        no_cmd.cmd.clear();
        assert!(identify_all(&no_cmd, &ok, &[], NOW).is_empty(), "讀不到命令列就不認");
        let mut no_n = mux_fake(600_000);
        no_n.cmd.insert(502, r#""C:\claude.exe" --dangerously-skip-permissions"#.into());
        assert!(identify_all(&no_n, &ok, &[], NOW).is_empty(), "手開沒帶 -n 的不管");
        let mut print = mux_fake(600_000);
        print.cmd.insert(502, r#""C:\claude.exe" -p hi -n 小乙"#.into());
        assert!(identify_all(&print, &ok, &[], NOW).is_empty(), "一次性呼叫不算");
        let mut desktop = mux_fake(600_000);
        desktop.cmd.insert(502, r#""C:\Users\u\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe" -n 小乙"#.into());
        assert!(identify_all(&desktop, &ok, &[], NOW).is_empty(), "Claude Desktop 不算");
        let mut orphan = mux_fake(600_000);
        orphan.table[1].ppid = 1;
        orphan.table[2].ppid = 1;
        assert!(identify_all(&orphan, &ok, &[], NOW).is_empty(), "不在那一列的終端服務底下");
        let wrong_at = [PartnerRef { started_ms: Some(MUX_AT + 1), ..row("7", "小乙") }];
        assert!(identify_all(&mux_fake(600_000), &wrong_at, &[], NOW).is_empty(), "建立時間對不上（編號被重用）");
        let unknown_at = [PartnerRef { started_ms: None, ..row("7", "小乙") }];
        assert!(identify_all(&mux_fake(600_000), &unknown_at, &[], NOW).is_empty(), "對照表沒記建立時間");
        let mut no_start = mux_fake(600_000);
        no_start.started.remove(&502);
        assert!(identify_all(&no_start, &ok, &[], NOW).is_empty(), "查不到啟動時間不認");
    }

    #[test]
    fn 名單條目_名字不撞視窗名_說明是固定句() {
        let a = identify_all(&mux_fake(600_000), &[row("7", "小乙")], &[], NOW).remove(0);
        let e = proc_agent(&a);
        assert_eq!(e.name(), "claude · 小乙 #502");
        let j = e.to_json();
        assert_eq!((j["kind"].as_str(), j["receivable"].as_bool(), j["detail"].as_str()), (Some("process"), Some(false), Some(DETAIL)));
        assert_eq!(j["status"].as_str(), Some("running"), "不新增 status 值，舊版畫面照舊當灰點僅顯示");
    }

    #[test]
    fn 寄信回覆的字() {
        assert_eq!(mail_reply("小乙"), "[收發室] 轉交給 小乙 沒有成功：視窗開著，但還沒進到對話（可能在等你按確認）。信沒有送達，請到那台電腦的視窗看清楚後自己選，再寄一次。");
    }

    #[derive(Default)]
    struct Spy {
        calls: RefCell<Vec<String>>,
        renamed: bool,
    }
    impl StopHost for Spy {
        fn stop_partner(&self, id: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("partner:{id}"));
            Ok(())
        }
        fn stop_gui(&self, gui_pid: u32) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("gui:{gui_pid}"));
            Ok(())
        }
        fn partner_session(&self, _id: &str) -> Option<String> {
            None
        }
        fn partner_row_name(&self, _id: &str) -> Option<String> {
            Some(if self.renamed { "別人".to_string() } else { "小乙".to_string() })
        }
    }

    #[test]
    fn 停止前再驗_成立才呼叫既有的停止() {
        let spy = Spy::default();
        stop_verified(&mux_fake(600_000), &spy, &[row("7", "小乙")], &[], "7", "小乙", NOW).unwrap();
        assert_eq!(*spy.calls.borrow(), vec!["partner:7".to_string()]);
    }

    #[test]
    fn 停止前再驗_不成立一律拒絕_不呼叫任何停止() {
        let spy = Spy::default();
        let os = mux_fake(600_000);
        let ok = [row("7", "小乙")];
        assert_eq!(stop_verified(&os, &spy, &ok, &[live(502)], "7", "小乙", NOW), Err(NO_LONGER_AWAITING.to_string()), "sessions 檔出現了");
        assert!(stop_verified(&os, &spy, &ok, &[], "8", "小乙", NOW).is_err(), "編號不是驗出來那一列");
        assert!(stop_verified(&os, &spy, &ok, &[], "7", "小丙", NOW).is_err(), "名字不符");
        let renamed = Spy { renamed: true, ..Spy::default() };
        assert!(stop_verified(&os, &renamed, &ok, &[], "7", "小乙", NOW).is_err(), "對照表那一列換成別人");
        assert!(spy.calls.borrow().is_empty() && renamed.calls.borrow().is_empty());
    }

    #[test]
    fn 停止前再驗_自己的視窗走_stop_gui() {
        let mut os = mux_fake(600_000);
        os.table = vec![p(600, 1, switch::WEZ_GUI), p(601, 600, "powershell.exe"), p(602, 601, "claude.exe")];
        os.cmd = HashMap::from([(602, "claude.exe -n 小乙".to_string())]);
        os.started = HashMap::from([(600, 2_000), (601, NOW - 600_000), (602, NOW - 600_000)]);
        os.wez = vec![(600, 2_000)];
        let own = PartnerRef { mux: false, gui_pid: 600, started_ms: Some(2_000), ..row("9", "小乙") };
        let spy = Spy::default();
        stop_verified(&os, &spy, &[own], &[], "9", "小乙", NOW).unwrap();
        assert_eq!(*spy.calls.borrow(), vec!["gui:600".to_string()]);
    }
}
