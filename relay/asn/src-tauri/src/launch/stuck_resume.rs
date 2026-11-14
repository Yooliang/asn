//! 「卡在接回中的 ASN 夥伴程序」的判斷與停止（工作管理員、手動喚醒共用，兩邊對「哪一個算」的看法才一致）。
//!
//! 情境：ASN 用 `--resume <對話編號>` 開的夥伴視窗卡在啟動中，而且已經沒有活著的 session 檔。
//! 原本的關閉路徑都靠 session 檔找目標，終端面板又不收夥伴視窗，所以使用者看不到、也停不掉它。
//!
//! 四條全成立才算：
//! 1. 終端對照表裡有一列夥伴視窗（claude）記著這個對話編號，而且只有一列（兩列以上不猜）；
//! 2. 有活的 claude／node 程序，命令列帶 `--resume <這個編號>`；
//! 3. 那些程序往上找，都找得到這一列的終端服務（或 ASN 自己的視窗），編號與建立時間和對照表記的一樣；
//! 4. 這個編號目前沒有活的 session 檔（有就是一般夥伴，走原本的關閉）。
//!    對話中途換了新編號（/clear、compact）時，session 檔記的是新編號、命令列仍是舊的；
//!    所以接續程序（含它們的祖先與子孫）只要有任何一個是活 session 檔的程序，也當作一般夥伴。
//!
//! 停止只呼叫終端服務既有的兩支（關共用服務裡的窗格、收自己的視窗），不在這裡另開任何結束程序的路。
//! 動手之前把四條再驗一次。
use super::live_process;
use super::switch::{self, Os, Proc};
use std::collections::HashSet;

/// 終端對照表裡的一列夥伴視窗（claude）：只留判斷與停止要用的欄位
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PartnerRef {
    /// 終端面板編號（對照表的）
    pub id: String,
    /// 夥伴名
    pub name: String,
    /// 開窗時帶的對話編號
    pub session_id: String,
    /// 在共用終端服務裡（`gui_pid` 記的是服務的程序編號）；否則是 ASN 自己的視窗
    pub mux: bool,
    /// 終端服務或自己視窗的程序編號
    pub gui_pid: u32,
    /// 開窗時記下的建立時間（Unix 毫秒）；沒有就一律不認
    pub started_ms: Option<u64>,
    pub cwd: String,
}

/// 一個活的 session 檔：對話編號（讀不到就是 None）與程序編號
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LiveSess {
    pub sid: Option<String>,
    pub pid: u32,
}

/// 判斷成立的結果
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Stuck {
    pub partner: PartnerRef,
    /// 接續這段對話的活程序（至少一個）
    pub pids: Vec<u32>,
    /// 其中程序樹最上層的那一個（工作管理員用它當這一列的程序編號）
    pub root_pid: u32,
    /// 最早的啟動時間；查不到就是 None
    pub started_ms: Option<u64>,
    /// 啟動滿 5 分鐘還在
    pub stuck: bool,
}

/// 不成立的原因（只有「已經在線上」要給使用者看不同的話）
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum NotStuck {
    /// 這個對話編號有活的 session 檔：是一般夥伴
    Online,
    /// 其餘（對照表對不上、同編號兩列、沒有活程序、祖先或建立時間不對）
    Other,
}

/// 動手前驗證不過、或已經在線上時給使用者的固定文案
pub(crate) const ALREADY_ONLINE: &str = "這位夥伴已經在線上，請改用一般的關閉";
pub(crate) const NO_LONGER_STUCK: &str = "這個視窗已經不是卡在接回中的狀態，請重新整理清單";
/// 自己開的視窗裡還有其他分頁或窗格時，不整個關掉
pub(crate) const OTHER_TABS_IN_WINDOW: &str = "這個視窗裡還有其他分頁，請到那個視窗自己關掉";
/// 手動喚醒被擋、而且符合卡住條件時的提示
pub(crate) const STUCK_IN_TASKMGR_HINT: &str = "可能卡住了，到工作管理員停止它";

/// 這個程序是不是這一列的終端服務（或自己視窗）底下：編號與建立時間都要和對照表記的一樣。
/// 限制：共用服務時只證明「在這個服務底下」，不證明「在這一列的窗格裡」（服務底下所有窗格的祖先都是同一個服務）。
/// 可以接受的原因：同一個對話編號有兩列以上的對照表已經先擋掉；要比到窗格層級得另外向服務查窗格的程序，這裡不多開查詢
fn anchored(os: &dyn Os, table: &[Proc], p: &PartnerRef, pid: u32) -> bool {
    let Some(was) = p.started_ms else {
        return false;
    };
    if p.mux {
        switch::mux_ancestor(table, pid, &|x| os.started_ms(x)) == Some((p.gui_pid, was))
    } else {
        switch::asn_wez_of(os, table, pid) == Some(p.gui_pid) && os.started_ms(p.gui_pid) == Some(was)
    }
}

/// 程序樹最上層的那一個：往上找不到同一批程序裡的其他成員
fn top_pid(table: &[Proc], pids: &[u32]) -> u32 {
    pids.iter().copied().find(|p| !switch::ancestors(table, *p).iter().any(|a| pids.contains(a))).unwrap_or(pids[0])
}

/// 接續程序、它們的祖先、它們的子孫裡，有沒有任何一個是活 session 檔的程序（對話換了新編號時靠這條認出來）
fn touches_live_session(os: &dyn Os, table: &[Proc], pids: &[u32], live: &[LiveSess]) -> bool {
    let mut related: HashSet<u32> = HashSet::new();
    for p in pids {
        related.insert(*p);
        related.extend(switch::ancestors(table, *p));
        related.extend(super::taskmgr::tree_pids(table, *p, &|x| os.started_ms(x)));
    }
    live.iter().any(|l| l.pid != 0 && related.contains(&l.pid))
}

/// 四條都驗：成立回 [`Stuck`]。`partners` 是終端對照表裡的夥伴列，`live` 是現在有活 session 檔的（對話編號, 程序編號）
pub(crate) fn identify(os: &dyn Os, partners: &[PartnerRef], live: &[LiveSess], sid: &str, now_ms: u64) -> Result<Stuck, NotStuck> {
    if live.iter().any(|l| l.sid.as_deref() == Some(sid)) {
        return Err(NotStuck::Online);
    }
    let mut rows = partners.iter().filter(|p| p.session_id == sid);
    let partner = rows.next().ok_or(NotStuck::Other)?;
    if rows.next().is_some() {
        return Err(NotStuck::Other);
    }
    let mut pids = live_process::resuming_pids(os, sid).ok_or(NotStuck::Other)?;
    pids.sort_unstable();
    let table = os.processes();
    if touches_live_session(os, &table, &pids, live) {
        return Err(NotStuck::Online);
    }
    if !pids.iter().all(|p| anchored(os, &table, partner, *p)) {
        return Err(NotStuck::Other);
    }
    let started_ms = live_process::earliest_started_ms(os, &pids);
    Ok(Stuck { partner: partner.clone(), root_pid: top_pid(&table, &pids), pids, started_ms, stuck: live_process::is_stuck(now_ms, started_ms) })
}

/// 停止用的兩支既有動作（真的由終端服務做；測試換成會記錄的假的）
pub(crate) trait StopHost {
    /// 關共用終端服務裡的夥伴窗格（連同底下整棵程序樹），並把對照表那一列移除
    fn stop_partner(&self, id: &str) -> Result<(), String>;
    /// 收掉 ASN 自己開的視窗
    fn stop_gui(&self, gui_pid: u32) -> Result<(), String>;
    /// 對照表裡這個終端編號那一列現在記的對話編號；列不見了就是 None
    fn partner_session(&self, id: &str) -> Option<String>;
}

/// 停止「卡住的接回」：先把四條再驗一次，成立才呼叫既有的 stop_partner／stop_gui。
/// `id` 是畫面給的終端編號，必須和驗出來的那一列一致，否則拒絕
pub(crate) fn stop_verified(os: &dyn Os, host: &dyn StopHost, partners: &[PartnerRef], live: &[LiveSess], id: &str, sid: &str, now_ms: u64) -> Result<(), String> {
    let s = match identify(os, partners, live, sid, now_ms) {
        Ok(s) => s,
        Err(NotStuck::Online) => return Err(ALREADY_ONLINE.into()),
        Err(NotStuck::Other) => return Err(NO_LONGER_STUCK.into()),
    };
    if s.partner.id != id {
        return Err(NO_LONGER_STUCK.into());
    }
    if s.partner.mux {
        // 驗證到停止之間對照表可能變動：停之前再核對這一列記的還是這個對話編號
        if host.partner_session(&s.partner.id).as_deref() != Some(sid) {
            return Err(NO_LONGER_STUCK.into());
        }
        host.stop_partner(&s.partner.id)
    } else {
        // 收自己的視窗會連整個視窗一起關：裡面除了這批接續程序（與它們的外層殼）還有別的程序，就不動
        let table = os.processes();
        let mut ended: HashSet<u32> = HashSet::new();
        for p in &s.pids {
            ended.extend(super::taskmgr::tree_pids(&table, *p, &|x| os.started_ms(x)));
            ended.extend(switch::ancestors(&table, *p).into_iter().take_while(|a| *a != s.partner.gui_pid));
        }
        let ended: Vec<u32> = ended.into_iter().collect();
        if switch::wez_has_others(os, s.partner.gui_pid, &ended) {
            return Err(OTHER_TABS_IN_WINDOW.into());
        }
        host.stop_gui(s.partner.gui_pid)
    }
}

/// 手動喚醒被「已有程序在接回」擋下時的提示：滿 5 分鐘而且符合卡住條件 → 指向工作管理員；
/// 滿 5 分鐘但不符合（不是 ASN 開的、對不上）→ 原本的「先關掉那個終端」；未滿 5 分鐘 → 請稍候。
/// `live` 是現在有活 session 檔的（對話編號, 程序編號），判斷與工作管理員一致
pub(crate) fn resume_block_hint(os: &dyn Os, partners: &[PartnerRef], live: &[LiveSess], sid: &str, now_ms: u64) -> &'static str {
    let started = live_process::resuming_pids(os, sid).and_then(|p| live_process::earliest_started_ms(os, &p));
    let base = live_process::resume_block_hint(now_ms, started);
    if base == live_process::STUCK_HINT && identify(os, partners, live, sid, now_ms).is_ok_and(|s| s.stuck) {
        return STUCK_IN_TASKMGR_HINT;
    }
    base
}

/// 本機現在有活 session 檔的 Claude 對話（編號與程序編號）；讀不到名單回 None（呼叫端不能當成「沒有」）
#[cfg(desktop)]
pub(crate) fn live_claude_sessions(now_ms: u64) -> Option<Vec<LiveSess>> {
    use crate::bridge::roster;
    let home = crate::identity::home_dir();
    let wins = roster::read_local_with(&home.join(".claude").join("sessions"), &home.join(".asn").join("status"), crate::heartbeat::session_alive, 0, "", now_ms)?;
    Some(wins.into_iter().map(|w| LiveSess { sid: w.session_id, pid: w.pid }).collect())
}

#[cfg(all(feature = "gui", desktop))]
impl StopHost for super::term::LiveTerms {
    fn stop_partner(&self, id: &str) -> Result<(), String> {
        super::term::LiveTerms::stop_partner(self, id)
    }
    fn stop_gui(&self, gui_pid: u32) -> Result<(), String> {
        super::term::LiveTerms::stop_gui(self, gui_pid)
    }
    fn partner_session(&self, id: &str) -> Option<String> {
        self.partner_refs().into_iter().find(|p| p.id == id).map(|p| p.session_id)
    }
}

/// `term_stop` 帶了「接回中」的對話編號時走這裡：現讀對照表與 session 檔，驗過才停
#[cfg(all(feature = "gui", desktop))]
pub(crate) fn stop_real(terms: &super::term::LiveTerms, id: &str, sid: &str) -> Result<(), String> {
    let now = crate::heartbeat::now_ms();
    let live = live_claude_sessions(now).ok_or_else(|| "讀不到本機視窗清單，請稍後再試".to_string())?;
    let partners: Vec<PartnerRef> = terms.partner_by_session(sid).into_iter().collect();
    stop_verified(&switch::RealOs, terms, &partners, &live, id, sid, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const NOW: u64 = 1_800_000_000_000;
    const SID: &str = "11111111-2222-4333-8444-555555555555";
    const MUX: u32 = 500;
    const MUX_AT: u64 = 1_000;

    fn live(sid: &str, pid: u32) -> LiveSess {
        LiveSess { sid: Some(sid.to_string()), pid }
    }

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

    /// 終端服務 500 ← 包裝殼 501 ← claude 502 ← claude 503（都帶 --resume）；啟動時間：服務 1000、claude 在 `age_ms` 之前
    fn mux_fake(age_ms: u64) -> Fake {
        let cmd = format!(r#""C:\claude.exe" --resume {SID}"#);
        Fake {
            table: vec![p(MUX, 1, switch::MUX_SERVER), p(501, MUX, "powershell.exe"), p(502, 501, "claude.exe"), p(503, 502, "claude.exe")],
            cmd: HashMap::from([(502, cmd.clone()), (503, cmd)]),
            started: HashMap::from([(MUX, MUX_AT), (501, NOW - age_ms), (502, NOW - age_ms), (503, NOW - age_ms + 10)]),
            wez: vec![],
        }
    }

    fn mux_partner() -> PartnerRef {
        PartnerRef { id: "7".into(), name: "小乙".into(), session_id: SID.into(), mux: true, gui_pid: MUX, started_ms: Some(MUX_AT), cwd: "G:/w".into() }
    }

    #[test]
    fn 四條都成立_認得出來_五分鐘前後狀態不同() {
        let young = identify(&mux_fake(60_000), &[mux_partner()], &[], SID, NOW).unwrap();
        assert_eq!((young.partner.id.as_str(), young.root_pid, young.stuck), ("7", 502, false));
        assert_eq!(young.pids, vec![502, 503]);
        assert_eq!(young.started_ms, Some(NOW - 60_000));
        assert!(identify(&mux_fake(live_process::STUCK_AFTER_MS), &[mux_partner()], &[], SID, NOW).unwrap().stuck);
        assert!(!identify(&mux_fake(live_process::STUCK_AFTER_MS - 1), &[mux_partner()], &[], SID, NOW).unwrap().stuck);
    }

    #[test]
    fn 任一條不成立就不算() {
        let os = mux_fake(600_000);
        let ok = [mux_partner()];
        assert_eq!(identify(&os, &[], &[], SID, NOW), Err(NotStuck::Other), "對照表沒有這一列");
        let two = [mux_partner(), PartnerRef { id: "8".into(), ..mux_partner() }];
        assert_eq!(identify(&os, &two, &[], SID, NOW), Err(NotStuck::Other), "同編號兩列不猜");
        assert_eq!(identify(&os, &ok, &[live(SID, 777)], SID, NOW), Err(NotStuck::Online), "session 檔出現");
        let mut none = mux_fake(600_000);
        none.cmd.clear();
        assert_eq!(identify(&none, &ok, &[], SID, NOW), Err(NotStuck::Other), "沒有活的接回程序");
        let mut orphan = mux_fake(600_000);
        orphan.table[2].ppid = 1;
        orphan.table[3].ppid = 1;
        assert_eq!(identify(&orphan, &ok, &[], SID, NOW), Err(NotStuck::Other), "祖先不在終端服務底下");
        let mut one_out = mux_fake(600_000);
        one_out.table[3].ppid = 1;
        assert_eq!(identify(&one_out, &ok, &[], SID, NOW), Err(NotStuck::Other), "有一個程序不在底下就不算（不能只停一半）");
        let wrong_at = [PartnerRef { started_ms: Some(MUX_AT + 1), ..mux_partner() }];
        assert_eq!(identify(&os, &wrong_at, &[], SID, NOW), Err(NotStuck::Other), "建立時間對不上（編號被重用）");
        let unknown_at = [PartnerRef { started_ms: None, ..mux_partner() }];
        assert_eq!(identify(&os, &unknown_at, &[], SID, NOW), Err(NotStuck::Other), "對照表沒記建立時間");
        let other_mux = [PartnerRef { gui_pid: 999, ..mux_partner() }];
        assert_eq!(identify(&os, &other_mux, &[], SID, NOW), Err(NotStuck::Other), "對照表記的是別的服務");
        assert_eq!(identify(&os, &ok, &[], "not a sid", NOW), Err(NotStuck::Other));
    }

    #[test]
    fn 自己的視窗_要在對照表裡的視窗底下() {
        let mut os = mux_fake(600_000);
        os.table = vec![p(600, 1, switch::WEZ_GUI), p(601, 600, "powershell.exe"), p(602, 601, "claude.exe")];
        os.cmd = HashMap::from([(602, format!("claude.exe --resume {SID}"))]);
        os.started = HashMap::from([(600, 2_000), (602, NOW - 600_000)]);
        os.wez = vec![(600, 2_000)];
        let own = PartnerRef { id: "9".into(), name: "小乙".into(), session_id: SID.into(), mux: false, gui_pid: 600, started_ms: Some(2_000), cwd: String::new() };
        assert_eq!(identify(&os, &[own.clone()], &[], SID, NOW).unwrap().root_pid, 602);
        os.wez = vec![(600, 2_001)];
        assert_eq!(identify(&os, &[own.clone()], &[], SID, NOW), Err(NotStuck::Other), "對照表量到的建立時間不同");
        os.wez = vec![];
        assert_eq!(identify(&os, &[own], &[], SID, NOW), Err(NotStuck::Other), "不是 ASN 自己的視窗");
    }

    #[derive(Default)]
    struct Spy {
        calls: RefCell<Vec<String>>,
        /// true＝對照表那一列已經換成別的對話編號
        drifted: bool,
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
            Some(if self.drifted { "別的對話".to_string() } else { SID.to_string() })
        }
    }

    #[test]
    fn 停止前再驗_成立才呼叫既有的停止() {
        let (os, spy) = (mux_fake(600_000), Spy::default());
        stop_verified(&os, &spy, &[mux_partner()], &[], "7", SID, NOW).unwrap();
        assert_eq!(*spy.calls.borrow(), vec!["partner:7".to_string()]);
    }

    #[test]
    fn 停止前再驗_自己的視窗走_stop_gui() {
        let mut os = mux_fake(600_000);
        os.table = vec![p(600, 1, switch::WEZ_GUI), p(602, 600, "claude.exe")];
        os.cmd = HashMap::from([(602, format!("claude.exe --resume {SID}"))]);
        os.started = HashMap::from([(600, 2_000), (602, NOW - 600_000)]);
        os.wez = vec![(600, 2_000)];
        let own = PartnerRef { id: "9".into(), name: "小乙".into(), session_id: SID.into(), mux: false, gui_pid: 600, started_ms: Some(2_000), cwd: String::new() };
        let spy = Spy::default();
        stop_verified(&os, &spy, &[own], &[], "9", SID, NOW).unwrap();
        assert_eq!(*spy.calls.borrow(), vec!["gui:600".to_string()]);
    }

    #[test]
    fn 停止前再驗_不成立一律拒絕_不呼叫任何停止() {
        let spy = Spy::default();
        let os = mux_fake(600_000);
        assert_eq!(stop_verified(&os, &spy, &[mux_partner()], &[live(SID, 777)], "7", SID, NOW), Err(ALREADY_ONLINE.to_string()), "session 檔又出現");
        assert_eq!(stop_verified(&os, &spy, &[], &[], "7", SID, NOW), Err(NO_LONGER_STUCK.to_string()));
        assert_eq!(stop_verified(&os, &spy, &[mux_partner()], &[], "8", SID, NOW), Err(NO_LONGER_STUCK.to_string()), "畫面給的編號和驗出來的不是同一列");
        let mut moved = mux_fake(600_000);
        moved.table[2].ppid = 1;
        assert!(stop_verified(&moved, &spy, &[mux_partner()], &[], "7", SID, NOW).is_err());
        assert!(spy.calls.borrow().is_empty(), "拒絕時不能呼叫 stop_partner／stop_gui");
    }

    #[test]
    fn 喚醒提示_三種情況() {
        let os = mux_fake(600_000);
        assert_eq!(resume_block_hint(&os, &[mux_partner()], SID, NOW), STUCK_IN_TASKMGR_HINT, "滿 5 分鐘＋符合：指向工作管理員");
        assert_eq!(resume_block_hint(&os, &[], SID, NOW), live_process::STUCK_HINT, "滿 5 分鐘但不符合：維持原句");
        assert_eq!(resume_block_hint(&mux_fake(60_000), &[mux_partner()], SID, NOW), live_process::STARTING_HINT, "未滿 5 分鐘：請稍候");
    }

    #[test]
    fn 對話換了新編號_程序是活session檔的程序_一律不算卡住() {
        let os = mux_fake(600_000);
        let ok = [mux_partner()];
        let other = "99999999-2222-4333-8444-555555555555";
        assert_eq!(identify(&os, &ok, &[live(other, 502)], SID, NOW), Err(NotStuck::Online), "同一個程序、session 檔記新編號");
        assert_eq!(identify(&os, &ok, &[live(other, 503)], SID, NOW), Err(NotStuck::Online), "子程序是活 session 檔的程序");
        assert_eq!(identify(&os, &ok, &[live(other, 501)], SID, NOW), Err(NotStuck::Online), "祖先（外層殼）是活 session 檔的程序");
        assert_eq!(identify(&os, &ok, &[LiveSess { sid: None, pid: 502 }], SID, NOW), Err(NotStuck::Online), "session 檔沒有編號也看程序");
        let mut deep = mux_fake(600_000);
        deep.table.push(p(504, 503, "node.exe"));
        assert_eq!(identify(&deep, &ok, &[live(other, 504)], SID, NOW), Err(NotStuck::Online), "後代是活 session 檔的程序");
        assert!(identify(&os, &ok, &[live(other, 999)], SID, NOW).is_ok(), "不相干的活視窗不影響");
        assert!(identify(&os, &ok, &[LiveSess { sid: None, pid: 0 }], SID, NOW).is_ok(), "程序編號 0 不算");
    }

    #[test]
    fn 對話換了新編號_停止被拒絕_不呼叫任何停止() {
        let (os, spy) = (mux_fake(600_000), Spy::default());
        let other = "99999999-2222-4333-8444-555555555555";
        assert_eq!(stop_verified(&os, &spy, &[mux_partner()], &[live(other, 502)], "7", SID, NOW), Err(ALREADY_ONLINE.to_string()));
        assert!(spy.calls.borrow().is_empty());
        assert_ne!(resume_block_hint(&os, &[mux_partner()], &[live(other, 502)], SID, NOW), STUCK_IN_TASKMGR_HINT, "喚醒提示也不指向工作管理員");
    }

    fn own_window_fake() -> (Fake, PartnerRef) {
        let mut os = mux_fake(600_000);
        os.table = vec![p(600, 1, switch::WEZ_GUI), p(601, 600, "powershell.exe"), p(602, 601, "claude.exe")];
        os.cmd = HashMap::from([(602, format!("claude.exe --resume {SID}"))]);
        os.started = HashMap::from([(600, 2_000), (602, NOW - 600_000)]);
        os.wez = vec![(600, 2_000)];
        let own = PartnerRef { id: "9".into(), name: "小乙".into(), session_id: SID.into(), mux: false, gui_pid: 600, started_ms: Some(2_000), cwd: String::new() };
        (os, own)
    }

    #[test]
    fn 自己的視窗裡還有其他分頁_拒絕且不收視窗() {
        let (mut os, own) = own_window_fake();
        os.table.push(p(603, 600, "powershell.exe"));
        let spy = Spy::default();
        assert_eq!(stop_verified(&os, &spy, &[own.clone()], &[], "9", SID, NOW), Err(OTHER_TABS_IN_WINDOW.to_string()));
        assert!(spy.calls.borrow().is_empty(), "有其他分頁時不能呼叫 stop_gui");
        let (os2, _) = own_window_fake();
        stop_verified(&os2, &spy, &[own], &[], "9", SID, NOW).unwrap();
        assert_eq!(*spy.calls.borrow(), vec!["gui:600".to_string()], "只有這個接回的殼與程序時照常收");
    }

    #[test]
    fn 停止前對照表那一列已換成別的對話_拒絕() {
        let (os, spy) = (mux_fake(600_000), Spy { drifted: true, ..Spy::default() });
        assert_eq!(stop_verified(&os, &spy, &[mux_partner()], &[], "7", SID, NOW), Err(NO_LONGER_STUCK.to_string()));
        assert!(spy.calls.borrow().is_empty());
    }
}
