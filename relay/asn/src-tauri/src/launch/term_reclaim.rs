//! 重開 ASN 後把先前記下的終端列認回來（`reclaim`），以及暫時接不回的列的定期重試（#2424 A）。
//! 單列的判斷（`reclaim_row`）只有一份：啟動時跑一次，之後背景重試也用同一份，不會兩邊各寫各的。
//! 每一列的結果只有四種：接回、暫時接不回（留著、記原因、之後再試）、有意先不碰（開關關著）、確定不在了（才移除）。
//! 判斷「確定不在」的依據都寫在 `reclaim_row` 裡；拿不準的一律當暫時接不回，絕不因為這一輪看不到就把列刪掉。
#![cfg_attr(not(feature = "gui"), allow(dead_code))]

use super::wezterm::{self, Fs, PaneProbe, Runner, WezTerm, WezTermDir, Window};
use super::{park_companion_row, partner_label, pick_pane, pane_is_ours, reclaim_candidate, title_marks, view_log, Loaded, Session, StoreTerm, TermService};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 第一次重試的等待時間；之後每輪沒有進展就加倍，最長 [`RETRY_MAX`]
pub const RETRY_FIRST: Duration = Duration::from_secs(30);
/// 間隔上限：終端服務真的掛很久時，不要每五分鐘就去敲它一次（又不能長到使用者等不到）
pub const RETRY_MAX: Duration = Duration::from_secs(20 * 60);
/// 一列接不回超過這麼久，就在 ui.log 寫一行醒目的提醒，之後每隔這麼久再寫一次
pub const STALE_NOTICE_EVERY: Duration = Duration::from_secs(3600);

/// 下一輪重試要等多久：上一輪的兩倍，不超過上限
pub fn next_interval(prev: Duration) -> Duration {
    prev.saturating_mul(2).min(RETRY_MAX)
}

/// 一輪結束後下一次要等多久：有接回任何一列＝重新從頭算，否則加倍
pub fn next_wait(prev: Duration, restored: usize) -> Duration {
    if restored > 0 {
        RETRY_FIRST
    } else {
        next_interval(prev)
    }
}

/// 這一列已經接不回多久了、離上次提醒多久：該不該寫醒目的提醒，要的話回「已幾小時」。每列每小時最多一次
pub fn stale_hours(age: Duration, since_last_notice: Option<Duration>) -> Option<u64> {
    let due = age >= STALE_NOTICE_EVERY && since_last_notice.map_or(true, |d| d >= STALE_NOTICE_EVERY);
    due.then(|| age.as_secs() / 3600)
}

/// 暫時接不回的列的記憶體紀錄（原因只放記憶體與 log，不寫進對照表檔）
#[derive(Debug, Clone)]
pub(super) struct ParkInfo {
    /// 已經試過幾次（啟動時那一次算第 1 次）
    pub attempts: u32,
    pub reason: String,
    /// 上一輪清單讀成功、但裡面沒有這個窗格（連續兩輪都沒有才移除；其他原因的接不回會把它清掉）
    pub absent_once: bool,
    /// 從什麼時候開始接不回
    pub since: Instant,
    /// 上次寫「已經很久接不回」提醒的時間
    pub last_notice: Option<Instant>,
}

impl Default for ParkInfo {
    fn default() -> Self {
        ParkInfo { attempts: 0, reason: String::new(), absent_once: false, since: Instant::now(), last_notice: None }
    }
}

impl ParkInfo {
    /// 接不回太久的提醒（有就回一行，並記下提醒時間）
    pub(super) fn stale_note(&mut self, label: &str) -> Option<String> {
        let h = stale_hours(self.since.elapsed(), self.last_notice.map(|t| t.elapsed()))?;
        self.last_notice = Some(Instant::now());
        Some(format!("【注意】終端對照表：{label}已經 {h} 小時接不回，仍保留這一列，請確認終端服務是否正常"))
    }
}

/// 單列嘗試的結果
pub(super) enum Row {
    /// 認回來了。`probed`＝剛讀過它的畫面、確認還活著（監看第一輪不重讀）
    Restored { session: Session, probed: bool },
    /// 暫時接不回：保留這一列，記原因，之後再試
    Waiting(String),
    /// 清單讀成功、但這一輪裡面沒有這個窗格：先留著（仍算暫時接不回），下一輪還沒有才移除
    Absent(String),
    /// 有意先不碰（開關關著、這次沒開終端服務）：留在檔案裡，不重試也不下 cli
    Parked,
    /// 確定不在了（可以從對照表拿掉）。`exited`＝夥伴在 ASN 關著時自己結束了，要通知收發室退信
    Gone { why: String, exited: Option<String> },
}

/// 這一輪的重試結果
#[derive(Debug, PartialEq, Eq, Default)]
pub struct RetryReport {
    pub restored: usize,
    /// 還在等的列數（仍是暫時接不回）
    pub waiting: usize,
}

/// log 裡指這一列的說法：夥伴名（沒有就用終端編號）加窗格編號，不放路徑與畫面
fn row_label(t: &StoreTerm) -> String {
    match partner_label(&t.id, &t.title) {
        Some(name) => format!("夥伴「{name}」（窗格 {}）", t.pane_id),
        None => format!("終端 {}（窗格 {}）", t.id, t.pane_id),
    }
}

impl<R: Runner, F: Fs> TermService<R, F> {
    /// ASN 重啟、記憶體對照表是空的時候，用檔案把先前自己開的視窗放回來。
    /// 找不到 WezTerm、沒有檔案、或版本不認得：什麼都不改。這條路徑不呼叫 kill_tree。
    /// 暫時接不回的列留在 parked，由 [`Self::retry_parked`] 之後再試。
    pub fn reclaim(&self) -> Result<(), String> {
        let loaded = self.load_store()?;
        let file = match loaded {
            Loaded::Ready(file) => file,
            Loaded::Missing | Loaded::Foreign => return Ok(()),
        };
        let dir = match self.dir() {
            Ok(d) => d,
            Err(_) => return Ok(()),
        };
        let w = self.wez(&dir);
        let mut restored: Vec<Session> = Vec::new();
        let mut parked: Vec<StoreTerm> = Vec::new();
        let mut infos: BTreeMap<String, ParkInfo> = BTreeMap::new();
        let mut exited_now: Vec<String> = Vec::new();
        let mut probed_now: BTreeMap<String, Instant> = BTreeMap::new();
        // 這一輪各通訊檔讀到的窗格清單（失敗＝錯誤原因）
        let mut lists: BTreeMap<PathBuf, Result<Vec<wezterm::PaneInfo>, String>> = BTreeMap::new();
        for term in file.terms {
            if restored.iter().any(|s| s.id == term.id) || parked.iter().any(|s| s.id == term.id) {
                continue;
            }
            match self.reclaim_row(&w, &dir, &term, false, &mut lists) {
                Row::Restored { session, probed } => {
                    if probed {
                        probed_now.insert(term.id.clone(), Instant::now());
                    }
                    restored.push(session);
                }
                r @ (Row::Waiting(_) | Row::Absent(_)) => {
                    let (why, absent_once) = match r {
                        Row::Absent(why) => (why, true),
                        Row::Waiting(why) => (why, false),
                        _ => unreachable!(),
                    };
                    view_log(&format!("終端對照表：{}暫時接不回（第 1 次），保留這一列、稍後再試：{why}", row_label(&term)));
                    infos.insert(term.id.clone(), ParkInfo { attempts: 1, reason: why, absent_once, ..ParkInfo::default() });
                    parked.push(term);
                }
                Row::Parked => parked.push(term),
                Row::Gone { why, exited } => {
                    view_log(&format!("終端對照表：{}已不在終端服務裡，從對照表移除：{why}", row_label(&term)));
                    exited_now.extend(exited);
                }
            }
        }
        let mut next = file.next;
        for id in restored.iter().map(|s| s.id.as_str()).chain(parked.iter().map(|s| s.id.as_str())) {
            if let Ok(n) = id.parse::<u64>() {
                next = next.max(n);
            }
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.next = next;
            g.sessions = restored;
            g.parked = parked;
            g.parked_info = infos;
            g.exited.extend(exited_now);
            g.probed = probed_now;
        }
        self.persist()?;
        Ok(())
    }

    /// 還有幾列在等重試（暫時接不回的；有意先不碰的不算）
    pub fn waiting_count(&self) -> usize {
        self.inner.lock().unwrap().parked_info.len()
    }

    /// 把暫時接不回的列再試一次。接回的從 parked 搬進 sessions（和啟動時認回同一個登記方式，前台／後台鈕就會恢復）；
    /// 確定不在的才移除；仍接不回的留著、累計次數、log 一行原因。同一個通訊檔這一輪只讀一次清單
    pub fn retry_parked(&self) -> RetryReport {
        let rows: Vec<(StoreTerm, bool)> = {
            let g = self.inner.lock().unwrap();
            g.parked.iter().filter_map(|t| g.parked_info.get(&t.id).map(|i| (t.clone(), i.absent_once))).collect()
        };
        if rows.is_empty() {
            return RetryReport::default();
        }
        let dir = match self.dir() {
            Ok(d) => d,
            Err(e) => {
                view_log(&format!("終端對照表：{} 列暫時接不回，找不到 WezTerm：{e}", rows.len()));
                return RetryReport { restored: 0, waiting: rows.len() };
            }
        };
        let w = self.wez(&dir);
        let mut lists: BTreeMap<PathBuf, Result<Vec<wezterm::PaneInfo>, String>> = BTreeMap::new();
        let outcomes: Vec<(StoreTerm, Row)> = rows
            .into_iter()
            .map(|(t, absent_once)| {
                let r = self.reclaim_row(&w, &dir, &t, absent_once, &mut lists);
                (t, r)
            })
            .collect();
        let mut report = RetryReport::default();
        let mut lines: Vec<String> = Vec::new();
        {
            let mut g = self.inner.lock().unwrap();
            for (term, row) in outcomes {
                // 這段時間列可能已被別處拿走：不在 parked 裡就不動
                let Some(pos) = g.parked.iter().position(|t| t.id == term.id) else { continue };
                let absent = matches!(row, Row::Absent(_));
                match row {
                    Row::Restored { session, probed } => {
                        g.parked.remove(pos);
                        let tries = g.parked_info.remove(&term.id).map_or(0, |i| i.attempts) + 1;
                        if probed {
                            g.probed.insert(term.id.clone(), Instant::now());
                        }
                        if !g.sessions.iter().any(|s| s.id == session.id) {
                            g.sessions.push(session);
                        }
                        lines.push(format!("終端對照表：{}接回來了（第 {tries} 次）", row_label(&term)));
                        report.restored += 1;
                    }
                    Row::Waiting(why) | Row::Absent(why) => {
                        let info = g.parked_info.entry(term.id.clone()).or_default();
                        info.attempts += 1;
                        info.reason = why.clone();
                        // 連續兩輪都沒有才算；中間有別種接不回（例如讀不到清單）就重新數
                        info.absent_once = absent;
                        lines.push(format!("終端對照表：{}仍接不回（第 {} 次）：{why}", row_label(&term), info.attempts));
                        lines.extend(info.stale_note(&row_label(&term)));
                        report.waiting += 1;
                    }
                    Row::Parked => {
                        g.parked_info.remove(&term.id);
                    }
                    Row::Gone { why, exited } => {
                        g.parked.remove(pos);
                        g.parked_info.remove(&term.id);
                        g.exited.extend(exited);
                        lines.push(format!("終端對照表：{}已不在終端服務裡，從對照表移除：{why}", row_label(&term)));
                    }
                }
            }
        }
        for l in &lines {
            view_log(l);
        }
        if let Err(e) = self.persist() {
            elog!("終端對照表重試後寫不回去：{e}");
        }
        report
    }

    /// 單列嘗試。「確定不在」只有下面這幾種有確切依據：
    /// 1. 這一列本身不合格（不是這份程式寫的、沒有建立時間）：永遠認不了。
    /// 2. 程序的建立時間跟紀錄不同：編號已被別的程序用掉，原來那個程序確定不在。
    ///    查不到建立時間時，程序確定已結束（`alive` 為否）才算不在；程序還在只是查不到＝暫時接不回。
    /// 3. 終端服務（mux）的 pid 檔記的已經是另一個服務，或原來那個服務確定已結束：窗格跟著服務結束了。
    /// 4. 窗格已結束（讀到帶暗號的結束標記）：正面證據，立刻移除。
    /// 5. 清單讀成功、裡面沒有這個窗格：清單是服務自己答的，但剛開的窗格一輪可能還沒出現、清單也可能剛好讀到一半，
    ///    所以照 `sweep_missing` 的做法**連續兩輪**都沒有才移除（`prev_absent`＝上一輪就沒有）；第一輪只回 [`Row::Absent`]。
    ///
    /// 其餘（讀清單失敗或逾時、通訊檔暫時不在、pid 檔讀不到、查不到程序狀態、找不到終端服務的資料夾）都是暫時接不回。
    pub(super) fn reclaim_row(&self, w: &WezTerm<'_>, dir: &WezTermDir, term: &StoreTerm, prev_absent: bool, lists: &mut BTreeMap<PathBuf, Result<Vec<wezterm::PaneInfo>, String>>) -> Row {
        let gone = |why: &str| Row::Gone { why: why.to_string(), exited: None };
        // #611：開關關著（0.1.113 不認夥伴視窗的列）＝kind 不是空的列（第 1 階段留下的）一律 parked：留在檔案裡、不查不碰，等開關打開再認
        if park_companion_row(self.hold_config, term) {
            return Row::Parked;
        }
        if !reclaim_candidate(term) {
            return gone("不是這份程式認得的列");
        }
        let Some(saved) = term.started_ms else {
            return gone("對照表沒有記程序的建立時間，永遠對不上");
        };
        // 建立時間對不上、或程序已經不在：不認領，也不結束（編號可能已經是別人的）。
        match self.runner.started_ms(term.pid) {
            Some(now) if now == saved => {}
            Some(_) => return gone("程序編號已被別的程序使用"),
            None if !self.runner.alive(term.pid) => return gone("程序已經結束"),
            None => return Row::Waiting("暫時查不到程序的建立時間".into()),
        }
        let sock = if term.mux {
            // mux 的列：連線檔是 mux 的，而且 pid 檔記的也要是同一個 mux（建立時間對得上），不然不認。
            // 開關沒開時不碰（也不下 cli）：留在檔案裡，等開關打開再認
            if !self.use_mux {
                return Row::Parked;
            }
            // 找不到終端服務的資料夾（例如讀不到使用者資料夾）是失敗不是「有意不碰」：留著並重試
            let Ok(m) = self.mux_handle(dir, BTreeMap::new()) else {
                return Row::Waiting("找不到終端服務的資料夾，暫時接不回".into());
            };
            if m.live_pid() != Some((term.pid, saved)) {
                return match m.recorded() {
                    Some(rec) if rec != (term.pid, saved) => gone("終端服務已經換成另一個，原來的窗格跟著結束了"),
                    Some(_) if !self.runner.alive(term.pid) => gone("終端服務已經結束"),
                    Some(_) => Row::Waiting("暫時查不出終端服務是否還活著".into()),
                    None => Row::Waiting("讀不到終端服務的程序記錄".into()),
                };
            }
            m.paths.sock.clone()
        } else {
            wezterm::sock_path(&self.home, term.pid)
        };
        if !self.fs.exists(&sock) {
            return Row::Waiting("終端服務的連線檔暫時不在".into());
        }
        // 同一個通訊檔這一輪只讀一次清單（每一列各讀一次會多下好幾次 wezterm cli list）；讀失敗也記下，同檔的列一起暫時接不回
        let listed = lists.entry(sock.clone()).or_insert_with(|| w.list(&sock));
        let panes = match listed {
            Ok(p) => p,
            Err(e) => return Row::Waiting(format!("讀不到終端服務的窗格清單：{e}")),
        };
        // 已結束的窗格（Hold 留著）不認領，順手收掉；讀不到畫面（失敗或被暫停略過）當作還活著，但不算「剛確認過」。
        // 讀畫面是背景的例行工作（標成例行：終端服務剛逾時就略過，不去加重它的負擔）
        let saw_dead = std::cell::Cell::new(false);
        let probes = std::cell::RefCell::new(BTreeMap::<u64, PaneProbe>::new());
        let ended = |p: &wezterm::PaneInfo| {
            let seen = crate::launch::cli_gate::routine(|| w.pane_probe(&sock, p.pane_id, term.exit_nonce.as_deref()));
            probes.borrow_mut().insert(p.pane_id, seen);
            let dead = matches!(seen, PaneProbe::Exited(_));
            if dead && pane_is_ours(&term.id, p) {
                let _ = w.kill_pane(&sock, p.pane_id);
                saw_dead.set(true);
            }
            dead
        };
        let Some(pane) = pick_pane(panes, &term.id, term.pane_id, &ended) else {
            // 窗格已結束是正面證據：ASN 關著時夥伴自己結束了，記下名字，寄給它的信馬上退回，不當成還沒接回
            if saw_dead.get() {
                let exited = if !term.kind.is_empty() { partner_label(&term.id, &term.title).map(str::to_string) } else { None };
                return Row::Gone { why: "窗格已經結束".to_string(), exited };
            }
            // 只是清單裡沒有：連續兩輪才移除，第一輪先留著
            return if prev_absent {
                Row::Gone { why: "連續兩輪終端服務的窗格清單裡都沒有這一個".to_string(), exited: None }
            } else {
                Row::Absent("終端服務的窗格清單裡暫時沒有這一個，下一輪再確認".to_string())
            };
        };
        let probed = probes.borrow().get(&pane.pane_id) == Some(&PaneProbe::Alive);
        // 分頁標題沒帶編號（開窗逾時、標題還沒設就接回的窗格）時，用記下來的標題，夥伴名字才不會掉
        let title = if title_marks(&pane.tab_title, &term.id) {
            pane.tab_title.clone()
        } else if title_marks(&term.title, &term.id) {
            term.title.clone()
        } else {
            format!("ASN:{}", term.id)
        };
        Row::Restored {
            probed,
            session: Session {
                id: term.id.clone(),
                profile: term.profile.clone(),
                window: Window { gui_pid: term.pid, sock, started_ms: Some(saved), mux: term.mux },
                pane_id: pane.pane_id,
                workspace: format!("asn-{}", term.id),
                title,
                cwd: term.cwd.clone(),
                send_granted: term.send_granted,
                kind: term.kind.clone(),
                session_id: term.session_id.clone(),
                exit_nonce: term.exit_nonce.clone(),
            },
        }
    }
}

/// 等終端服務的暫停結束時，最多連續等幾次（每次等到暫停結束），免得暫停一直延長時這條執行緒永遠卡在等
const PAUSE_WAITS_MAX: usize = 12;

/// 重試迴圈的本體（背景執行緒與測試共用，等待與每輪的動作都由呼叫端給）：
/// 先等 [`RETRY_FIRST`]；每輪之前若終端服務還在暫停（剛逾時）就先等暫停結束，**不叫任何指令**，這樣的等待不算一輪、不改間隔；
/// 一輪有接回任何一列就從頭算間隔，否則加倍（最長 [`RETRY_MAX`]）；接回後呼叫 `on_restored`；沒有等待中的列就結束。
/// 每輪的動作 panic 只記 log、下一輪再試，不讓這條執行緒悄悄死掉
///
/// `sleep` 可以被叫醒（見 [`RetryWake`]）；`kicked` 取走「有人叫過」的旗標。睡到一半被叫醒（新列剛放進來）就不等滿，
/// 馬上進下一輪，這一輪之後的間隔也重設成 [`RETRY_FIRST`]，不讓新列等舊的長間隔
pub fn run_retry_loop(
    sleep: &mut dyn FnMut(Duration),
    kicked: &dyn Fn() -> bool,
    pause_left: &dyn Fn() -> Option<Duration>,
    round: &mut dyn FnMut() -> RetryReport,
    on_restored: &mut dyn FnMut(),
    waiting: &dyn Fn() -> usize,
    log: &dyn Fn(&str),
) {
    let mut wait = RETRY_FIRST;
    loop {
        sleep(wait);
        let woken = kicked();
        for _ in 0..PAUSE_WAITS_MAX {
            let Some(left) = pause_left() else { break };
            sleep(left + Duration::from_secs(1));
            // 暫停期間又被叫：旗標清掉，照樣等到暫停結束（不叫任何指令）
            let _ = kicked();
        }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| round())).unwrap_or_else(|_| {
            log("終端對照表：背景重試時發生內部錯誤，這一輪略過，稍後再試");
            RetryReport::default()
        });
        if r.restored > 0 {
            on_restored();
        }
        wait = if woken { RETRY_FIRST } else { next_wait(wait, r.restored) };
        if waiting() == 0 {
            return;
        }
    }
}

/// 啟動後在背景定期重試暫時接不回的列：沒有這種列就馬上結束（不留執行緒）；有就 30 秒後第一次，之後每輪沒有進展就加倍、最長 20 分鐘。
/// 終端服務剛逾時（指令閘門暫停中）就先等，不去敲它。接回任何一列之後掃一次還開著的看畫面視窗（啟動時那一輪若因名單還空著而放棄，這裡接手）。全部處理完就結束
#[cfg(feature = "gui")]
pub fn start_reclaim_retry(terms: std::sync::Arc<super::LiveTerms>) {
    use std::sync::atomic::Ordering;
    if std::env::args().any(|a| a == "--shot") || terms.waiting_count() == 0 {
        return;
    }
    // 同一時間只留一條重試執行緒（開窗逾時後可能再叫一次）
    if RETRY_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("asn-reclaim-retry".into()).spawn(move || {
        loop {
            run_retry_loop(
                &mut |d| RETRY_WAKE.sleep(d),
                &|| RETRY_WAKE.take(),
                &|| crate::launch::cli_gate::global().longest_cooldown(),
                &mut || terms.retry_parked(),
                &mut || {
                    let (_, n) = terms.adopt_viewers();
                    if n > 0 {
                        view_log(&format!("終端對照表：接回後認回 {n} 個還開著的終端畫面"));
                    }
                },
                &|| terms.waiting_count(),
                &|l| view_log(l),
            );
            // 先放掉旗標再看一眼：放掉的空檔裡若又有新列進來（開窗逾時後再叫一次），這裡接手，不留下沒人重試的列
            RETRY_RUNNING.store(false, Ordering::SeqCst);
            if terms.waiting_count() == 0 || RETRY_RUNNING.swap(true, Ordering::SeqCst) {
                return;
            }
        }
    });
    if let Err(e) = spawned {
        RETRY_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        elog!("接回終端列的重試執行緒開不了（不影響啟動）：{e}");
    }
}

#[cfg(feature = "gui")]
static RETRY_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 重試執行緒的睡眠：睡最多一段時間，被 [`Self::kick`] 叫到就提早醒。旗標會留著（叫的時候執行緒不在睡，下一次睡就直接醒）
pub struct RetryWake {
    kicked: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

impl RetryWake {
    pub const fn new() -> Self {
        RetryWake { kicked: std::sync::Mutex::new(false), cv: std::sync::Condvar::new() }
    }

    /// 叫醒（新列剛放進暫時接不回）
    pub fn kick(&self) {
        *self.kicked.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.cv.notify_all();
    }

    /// 睡最多 `d`；有人叫過（旗標已立起）就馬上回來。不清旗標，由 [`Self::take`] 取走
    pub fn sleep(&self, d: Duration) {
        let g = self.kicked.lock().unwrap_or_else(|e| e.into_inner());
        let _ = self.cv.wait_timeout_while(g, d, |k| !*k);
    }

    /// 取走旗標：回「剛才有人叫過」
    pub fn take(&self) -> bool {
        std::mem::take(&mut *self.kicked.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// 全程式唯一的重試叫醒器（同一時間只有一條重試執行緒）
static RETRY_WAKE: RetryWake = RetryWake::new();

#[cfg(test)]
thread_local! {
    /// 測試用：這條測試執行緒叫了幾次 `kick_retry`
    static KICKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// 這條測試執行緒到目前叫了幾次 `kick_retry`
#[cfg(test)]
pub(super) fn kick_count() -> usize {
    KICKS.with(|k| k.get())
}

/// 開窗格逾時、把列記成暫時接不回之後，叫背景重試起來（已經在跑就叫醒它，馬上看一次、間隔重設成 30 秒）。
/// 測試沒有全域的終端服務，只記次數
pub(super) fn kick_retry() {
    #[cfg(test)]
    KICKS.with(|k| k.set(k.get() + 1));
    #[cfg(feature = "gui")]
    if let Some(t) = super::GLOBAL.get() {
        RETRY_WAKE.kick();
        start_reclaim_retry(t.clone());
    }
}
