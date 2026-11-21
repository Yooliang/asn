//! 終端服務監看的「一輪」與「接回結果通知」（#1818）。
//! 從 `mux_watch::start` 的迴圈抽出來：一輪做的事（寫狀態檔、算事故、寫紀錄、排通知、交給接回）集中在 [`run_round`]，
//! 對外的動作（開程序控制代碼、查事件記錄、寫紀錄、接回）經 [`Sink`]，測試換成假的，才能從「服務被砍」一路驗到「夥伴全部接回、通知排出」。
//! 另外放接回做完後的結果通知檔。
#![cfg(desktop)]

use super::mux::Disposal;
use super::mux_heartbeat::Hb;
use super::mux_watch::{empty_normal_exit, incident_line, queue_notice, Incident, Observed, ProcHandle, Tracker, Watch};
use std::path::Path;

/// 卡死處置取消或失敗之後，這段時間內不再重判同一個終端服務（#1897 ④）
pub const STUCK_COOLDOWN_MS: u64 = 300_000;

/// 接回額度未到、卡死的終端服務這次不結束時，寫進紀錄的白話
pub const STUCK_HELD_TEXT: &str = "終端服務卡住了，10 分鐘內已經接回過一次，這次先不重啟；請稍後再看，或手動重開 ASN";

/// 卡死處置的記憶體狀態（不存檔）：上次取消的時間、已經通知過的終端服務
#[derive(Debug, Default)]
pub struct StuckGuard {
    cancelled: Option<((u32, u64), u64)>,
    notified: Option<(u32, u64)>,
}

impl StuckGuard {
    fn cooling(&self, mux: (u32, u64), now: u64) -> bool {
        self.cancelled.is_some_and(|(m, at)| m == mux && now.saturating_sub(at) < STUCK_COOLDOWN_MS)
    }
}

/// 一輪的對外動作
pub trait Sink {
    /// 開程序控制代碼（讀結束碼用）
    fn open(&self, pid: u32) -> Option<Box<dyn ProcHandle>>;
    /// 事件記錄那一段的白話；沒有就 None
    fn event_text(&self, pid: Option<u32>) -> Option<String>;
    /// 寫一行事故紀錄（程式紀錄與 mux.log）
    fn record(&self, line: &str);
    /// 把夥伴交給自動接回（`resume` 為假＝十分鐘內第二次，只通知）。正式環境丟到另一條執行緒
    fn resume(&self, partners: Vec<String>, resume: bool);
    /// 卡死處置（#1897 ④）：確認後結束記錄的終端服務。預設不處置（不接這個功能的環境、舊的測試用接收端）
    fn dispose_stuck(&self) -> Disposal {
        Disposal::Cancelled("這個環境不處理卡死".to_string())
    }
}

/// 一輪要用的路徑與時間
pub struct Round<'a> {
    pub state_file: &'a Path,
    pub work_dir: &'a Path,
    /// 這台 ASN 已經跑了幾秒（事故紀錄用）
    pub uptime_secs: u64,
}

/// 看一輪：記下確定結束的夥伴、算事故、存狀態檔；有事故就寫紀錄、排通知、交給接回。
/// 回這一輪處理的事故（正常結束的空服務略過，回 None）。不處理卡死（心跳不參與判斷）；正式監看走 [`run_round_stuck`]
pub fn run_round(w: &mut Watch, tracker: &mut Tracker, o: &Observed, exited: &[String], now: u64, ctx: &Round, sink: &dyn Sink) -> Option<Incident> {
    round(w, tracker, o, exited, now, ctx, sink, true)
}

/// 同 [`run_round`]，再加上卡死處置（#1897 ④）。心跳只能把「活著」降級成「卡死」：
/// 程序已死（`live` 是 None）、沒有心跳、心跳還在動，都走舊判斷。
/// 心跳停了而且程序還在：先處置（在 `Watch::tick` 之前）——
/// 成功就經「已確認消失」入口直接成事故；取消、失敗、額度未到、冷卻中，這一輪等同心跳還在動（而且不更新 Tracker：它沒有真的活著）
pub fn run_round_stuck(w: &mut Watch, tracker: &mut Tracker, guard: &mut StuckGuard, o: &Observed, exited: &[String], now: u64, ctx: &Round, sink: &dyn Sink) -> Option<Incident> {
    let (Hb::Stale { secs }, Some(mux)) = (o.hb, o.live) else { return round(w, tracker, o, exited, now, ctx, sink, true) };
    if guard.cooling(mux, now) {
        return round(w, tracker, o, exited, now, ctx, sink, false);
    }
    // 處置一定接著接回：額度未到就不結束，只通知本人一次
    if !w.resume_quota_ok(now) {
        if guard.notified != Some(mux) {
            guard.notified = Some(mux);
            // 走現有的事故通知管道（只帶人數與「沒有接回」，後台文字固定）；白話說明寫進 mux.log 與 ui.log
            let line = format!("{STUCK_HELD_TEXT}（心跳停了超過 {secs} 秒）");
            sink.record(&line);
            let _ = crate::ui_log::append(ctx.work_dir, &[format!("{} info [ASN] {line}", crate::quota_core::iso_secs(now as i64))]);
            queue_notice(ctx.work_dir, o.partners.len(), false, now);
        }
        return round(w, tracker, o, exited, now, ctx, sink, false);
    }
    match sink.dispose_stuck() {
        Disposal::Done => return after_stuck_done(w, tracker, o, mux, secs, exited, now, ctx, sink),
        Disposal::Cancelled(why) => {
            guard.cancelled = Some((mux, now));
            sink.record(&format!("終端服務卡住（心跳停了超過 {secs} 秒）：{why}"));
        }
        Disposal::Busy => {}
    }
    round(w, tracker, o, exited, now, ctx, sink, false)
}

#[allow(clippy::too_many_arguments)]
fn round(w: &mut Watch, tracker: &mut Tracker, o: &Observed, exited: &[String], now: u64, ctx: &Round, sink: &dyn Sink, observe: bool) -> Option<Incident> {
    w.note_exited(exited, now);
    let incident = w.tick(o, now);
    w.save(ctx.state_file);
    // 事故的原因與最後活著的時間要先讀（observe 會換掉控制代碼、更新時間）
    let info = incident.as_ref().map(|_| {
        let pid = tracker.held_pid();
        (tracker.take_reason(), tracker.last_alive_ms, sink.event_text(pid))
    });
    if observe {
        tracker.observe(o, now, &|pid| sink.open(pid));
    }
    let inc = incident?;
    let (reason, last_alive, event) = info.unwrap_or_default();
    // 裡面沒有夥伴、而且是正常結束（結束碼 0）：不是事故，不寫紀錄、不通知
    if empty_normal_exit(&inc, &reason) {
        return None;
    }
    report(&inc, &reason, last_alive, event.as_deref(), now, ctx, sink);
    Some(inc)
}

/// 事故：寫紀錄、排通知、交給接回
fn report(inc: &Incident, reason: &str, last_alive: Option<u64>, event: Option<&str>, now: u64, ctx: &Round, sink: &dyn Sink) {
    sink.record(&incident_line(inc, reason, last_alive, ctx.uptime_secs, event));
    queue_notice(ctx.work_dir, inc.partners.len(), inc.resume, now);
    if !inc.partners.is_empty() {
        sink.resume(inc.partners.clone(), inc.resume);
    }
}

/// 卡死的終端服務已結束、確認消失：經「已確認消失」入口當一輪事故（略過連續兩輪的懷疑）。
/// 原因是帶入的那句，不用 Tracker 讀到的結束碼（那是我們自己殺的）；Tracker 的控制代碼丟掉、最後活著的時間不更新。
/// 這個服務不是監看記著的那個（例如 ASN 剛啟動、狀態檔沒有記錄）：只寫紀錄，不報事故、不接回
#[allow(clippy::too_many_arguments)]
fn after_stuck_done(w: &mut Watch, tracker: &mut Tracker, o: &Observed, mux: (u32, u64), secs: u64, exited: &[String], now: u64, ctx: &Round, sink: &dyn Sink) -> Option<Incident> {
    w.note_exited(exited, now);
    let last_alive = tracker.last_alive_ms;
    let _ = tracker.take_reason();
    if !w.seen_mux_is(mux) {
        w.save(ctx.state_file);
        sink.record(&format!("終端服務卡住（心跳停了超過 {secs} 秒），已結束；ASN 沒有它的記錄，不算事故、沒有接回"));
        return None;
    }
    let gone = Observed { live: None, record: None, stopped: None, ..o.clone() };
    let incident = w.tick_gone(&gone, now);
    w.save(ctx.state_file);
    let inc = incident?;
    report(&inc, &format!("終端服務卡住（心跳停了超過 {secs} 秒），已結束並接回"), last_alive, None, now, ctx, sink);
    Some(inc)
}

// ---- 接回結果通知 ----

/// 接回做完之後的結果通知檔（工作資料夾）：橋接核心下一輪讀走、請後台寄給本人，成功就刪
pub const RESUME_NOTICE_FILE: &str = "mux-resume-notice.json";
/// 通知名單最多帶幾位名字（後台一次最多收這麼多）
pub const RESUME_NOTICE_MAX: usize = 100;

/// 排一則接回結果通知：斷了幾位、接回幾位、哪些沒接回（名字）。名字之外不帶任何原因（技術細節只進 log）
pub fn queue_resume_notice(work_dir: &Path, broke: usize, failed: &[String], now_ms: u64) {
    if work_dir.as_os_str().is_empty() || broke == 0 {
        return;
    }
    let failed: Vec<&String> = failed.iter().take(RESUME_NOTICE_MAX).collect();
    let broke = broke.clamp(failed.len(), RESUME_NOTICE_MAX);
    let body = serde_json::json!({ "count": broke, "resumed": broke - failed.len(), "failed": failed, "at": now_ms });
    let tmp = work_dir.join(format!("{RESUME_NOTICE_FILE}.tmp"));
    if std::fs::write(&tmp, body.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, work_dir.join(RESUME_NOTICE_FILE));
    }
}

/// 排著的接回結果：（斷了幾位, 接回幾位, 沒接回的名字, 完成時間）。沒有或壞掉的檔回 None（壞檔順手刪掉）
pub fn read_resume_notice(work_dir: &Path) -> Option<(usize, usize, Vec<String>, u64)> {
    let f = work_dir.join(RESUME_NOTICE_FILE);
    let text = std::fs::read_to_string(&f).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| {
        let count = usize::try_from(v.get("count")?.as_u64()?).ok()?;
        let resumed = usize::try_from(v.get("resumed")?.as_u64()?).ok()?;
        let failed: Vec<String> = v.get("failed")?.as_array()?.iter().filter_map(|n| n.as_str().map(String::from)).collect();
        Some((count.min(RESUME_NOTICE_MAX), resumed.min(RESUME_NOTICE_MAX), failed, v.get("at").and_then(serde_json::Value::as_u64).unwrap_or(0)))
    });
    if parsed.is_none() {
        let _ = std::fs::remove_file(&f);
    }
    parsed
}

pub fn clear_resume_notice(work_dir: &Path) {
    let _ = std::fs::remove_file(work_dir.join(RESUME_NOTICE_FILE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t1818_接回結果檔_寫了讀得到_人數對得上_壞檔當沒有() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_resume_notice(d.path()), None);
        queue_resume_notice(d.path(), 3, &["丙".to_string()], 42);
        assert_eq!(read_resume_notice(d.path()), Some((3, 2, vec!["丙".to_string()], 42)));
        clear_resume_notice(d.path());
        assert_eq!(read_resume_notice(d.path()), None);
        queue_resume_notice(d.path(), 0, &[], 1);
        assert_eq!(read_resume_notice(d.path()), None, "沒有人斷就不通知");
        std::fs::write(d.path().join(RESUME_NOTICE_FILE), "壞掉").unwrap();
        assert_eq!(read_resume_notice(d.path()), None);
        assert!(!d.path().join(RESUME_NOTICE_FILE).exists());
        queue_resume_notice(Path::new(""), 1, &[], 1);
        assert!(!Path::new(RESUME_NOTICE_FILE).exists(), "沒有工作資料夾不寫到目前目錄");
    }

    // ---- #1897 ④ 判斷切換＋卡死處置 ----

    use super::super::mux_watch::{clear_notice, read_notice, TICK_MS};
    use std::cell::{Cell, RefCell};

    const M1: (u32, u64) = (100, 20_000_000);

    /// 假接收端：處置的結果由測試給，記下呼叫次數
    struct Rig {
        dispose: RefCell<Disposal>,
        disposed: Cell<u32>,
        records: RefCell<Vec<String>>,
        resumes: RefCell<Vec<(Vec<String>, bool)>>,
    }
    impl Rig {
        fn new(d: Disposal) -> Rig {
            Rig { dispose: RefCell::new(d), disposed: Cell::new(0), records: RefCell::new(vec![]), resumes: RefCell::new(vec![]) }
        }
        fn log(&self) -> String {
            self.records.borrow().join("\n")
        }
    }
    impl Sink for Rig {
        fn open(&self, _pid: u32) -> Option<Box<dyn ProcHandle>> {
            None
        }
        fn event_text(&self, _pid: Option<u32>) -> Option<String> {
            None
        }
        fn record(&self, line: &str) {
            self.records.borrow_mut().push(line.to_string());
        }
        fn resume(&self, partners: Vec<String>, resume: bool) {
            self.resumes.borrow_mut().push((partners, resume));
        }
        fn dispose_stuck(&self) -> Disposal {
            self.disposed.set(self.disposed.get() + 1);
            self.dispose.borrow().clone()
        }
    }

    fn obs(live: Option<(u32, u64)>, hb: Hb) -> Observed {
        Observed { live, partners: if live.is_some() { vec!["甲".to_string(), "乙".to_string()] } else { vec![] }, hb, ..Default::default() }
    }

    struct Env {
        dir: tempfile::TempDir,
        w: Watch,
        tr: Tracker,
        guard: StuckGuard,
    }
    impl Env {
        fn new() -> Env {
            Env { dir: tempfile::tempdir().unwrap(), w: Watch::default(), tr: Tracker::new(false), guard: StuckGuard::default() }
        }
        fn round(&mut self, o: &Observed, now: u64, sink: &Rig) -> Option<Incident> {
            let file = self.dir.path().join(crate::launch::mux_watch::STATE_FILE);
            let ctx = Round { state_file: &file, work_dir: self.dir.path(), uptime_secs: 600 };
            run_round_stuck(&mut self.w, &mut self.tr, &mut self.guard, o, &[], now, &ctx, sink)
        }
        /// 活著且心跳正常兩輪（記下 mux 與夥伴）
        fn warm(&mut self, sink: &Rig) {
            for i in 0..2 {
                assert_eq!(self.round(&obs(Some(M1), Hb::Fresh), i * TICK_MS, sink), None);
            }
        }
    }

    const STALE_AT: u64 = 5 * TICK_MS;

    #[test]
    fn t1897_心跳停_程序在_額度可用_處置後一輪就成事故_原因是帶入的那句() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Done));
        e.warm(&rig);
        let inc = e.round(&obs(Some(M1), Hb::Stale { secs: 120 }), STALE_AT, &rig).expect("處置成功，這一輪就是事故（不用等兩輪）");
        assert_eq!((inc.partners.clone(), inc.resume), (vec!["甲".to_string(), "乙".to_string()], true));
        assert_eq!(rig.disposed.get(), 1);
        let line = rig.log();
        assert!(line.contains("終端服務卡住（心跳停了超過 120 秒），已結束並接回"), "{line}");
        assert!(!line.contains("結束碼"), "不用 taskkill 的結束碼：{line}");
        assert_eq!(*rig.resumes.borrow(), vec![(inc.partners, true)], "交給接回");
        assert!(crate::launch::mux_watch::read_notice(e.dir.path()).is_some(), "事故通知排出去了");
        assert_eq!(e.round(&obs(None, Hb::NotSupported), STALE_AT + TICK_MS, &rig), None, "同一次事故不報第二次");
    }

    #[test]
    fn t1897_額度未到_不結束_只通知一次() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Done));
        e.warm(&rig);
        e.w.last_resume_at = Some(STALE_AT - 60_000); // 一分鐘前才接回過
        for i in 0..4 {
            assert_eq!(e.round(&obs(Some(M1), Hb::Stale { secs: 120 }), STALE_AT + i * TICK_MS, &rig), None);
            if i == 0 {
                assert_eq!(read_notice(e.dir.path()).map(|n| (n.0, n.1)), Some((2, false)), "走現有的事故通知：2 位夥伴、沒有接回");
                clear_notice(e.dir.path());
            }
        }
        assert_eq!(rig.disposed.get(), 0, "額度未到不結束程序");
        assert_eq!(read_notice(e.dir.path()), None, "只通知一次");
        assert!(std::fs::read_to_string(e.dir.path().join("ui.log")).unwrap_or_default().contains(STUCK_HELD_TEXT), "白話說明寫進 ui.log");
        assert_eq!(rig.records.borrow().len(), 1, "mux.log 也只寫一行：{}", rig.log());
        assert!(rig.log().contains(STUCK_HELD_TEXT), "{}", rig.log());
    }

    #[test]
    fn t1897_處置取消_這一輪等同_fresh_tracker_不更新_五分鐘內不重判() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Cancelled("心跳停了但連得上，沒有結束".into())));
        e.warm(&rig);
        let before = e.tr.last_alive_ms;
        assert_eq!(e.round(&obs(Some(M1), Hb::Stale { secs: 120 }), STALE_AT, &rig), None, "取消：沒有事故");
        assert_eq!(e.round(&obs(Some(M1), Hb::Stale { secs: 150 }), STALE_AT + TICK_MS, &rig), None);
        assert_eq!(rig.disposed.get(), 1, "取消後五分鐘內不重判同一個 mux");
        assert_eq!(e.tr.last_alive_ms, before, "Stale 的那幾輪不更新 Tracker（它沒有真的活著）");
        assert!(rig.log().contains("連得上，沒有結束"), "取消的原因寫進紀錄：{}", rig.log());
        // 這輪等同 fresh：之後 mux 真的不見了，仍照舊「連續兩輪」才算
        assert_eq!(e.round(&obs(None, Hb::NotSupported), STALE_AT + 2 * TICK_MS, &rig), None);
        assert!(e.round(&obs(None, Hb::NotSupported), STALE_AT + 3 * TICK_MS, &rig).is_some());
        // 五分鐘過了又可以判
        let (mut e2, rig2) = (Env::new(), Rig::new(Disposal::Cancelled("x".into())));
        e2.warm(&rig2);
        e2.round(&obs(Some(M1), Hb::Stale { secs: 120 }), STALE_AT, &rig2);
        e2.round(&obs(Some(M1), Hb::Stale { secs: 120 }), STALE_AT + STUCK_COOLDOWN_MS + 1, &rig2);
        assert_eq!(rig2.disposed.get(), 2);
    }

    #[test]
    fn t1897_鎖被占著_這輪不處理_下一輪再來_不進冷卻() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Busy));
        e.warm(&rig);
        assert_eq!(e.round(&obs(Some(M1), Hb::Stale { secs: 120 }), STALE_AT, &rig), None);
        assert_eq!(e.round(&obs(Some(M1), Hb::Stale { secs: 120 }), STALE_AT + TICK_MS, &rig), None);
        assert_eq!(rig.disposed.get(), 2);
    }

    #[test]
    fn t1897_沒有_seen_處置成功_不報事故_只寫_log() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Done));
        // ASN 剛啟動、沒有任何記錄就看到卡死的 mux
        assert_eq!(e.round(&obs(Some(M1), Hb::Stale { secs: 120 }), 0, &rig), None);
        assert_eq!(rig.disposed.get(), 1, "照樣可以處置");
        assert_eq!(rig.resumes.borrow().len(), 0);
        assert_eq!(crate::launch::mux_watch::read_notice(e.dir.path()), None, "不報事故");
        assert!(rig.log().contains("已結束") && rig.log().contains("不算事故"), "{}", rig.log());
    }

    #[test]
    fn t1897_程序已死_走舊路徑_心跳不讓它活著() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Done));
        e.warm(&rig);
        // live 是 None（程序死了），心跳檔留著舊的、讀起來是停了
        assert_eq!(e.round(&obs(None, Hb::Stale { secs: 300 }), STALE_AT, &rig), None, "舊路徑：第一輪只是懷疑");
        assert!(e.round(&obs(None, Hb::Stale { secs: 330 }), STALE_AT + TICK_MS, &rig).is_some(), "第二輪才算");
        assert_eq!(rig.disposed.get(), 0, "死的不處置");
    }

    #[test]
    fn t1897_沒有心跳或讀不到_卡死照舊不報() {
        for hb in [Hb::NotSupported, Hb::Unreadable, Hb::Fresh] {
            let (mut e, rig) = (Env::new(), Rig::new(Disposal::Done));
            e.warm(&rig);
            for i in 0..10 {
                assert_eq!(e.round(&obs(Some(M1), hb), STALE_AT + i * TICK_MS, &rig), None, "{hb:?}：程序在就是活著，舊版卡死判不出來");
            }
            assert_eq!(rig.disposed.get(), 0, "{hb:?}");
        }
    }

    #[test]
    fn t1897_舊的_stopped_記號不會把卡死處置的事故吃掉() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Done));
        e.warm(&rig);
        let o = Observed { stopped: Some((M1.0, 1)), ..obs(Some(M1), Hb::Stale { secs: 120 }) };
        assert!(e.round(&o, STALE_AT, &rig).is_some());
    }

    #[test]
    fn t1897_空的服務卡死_也報一次_不接回() {
        let (mut e, rig) = (Env::new(), Rig::new(Disposal::Done));
        let empty = |hb| Observed { live: Some(M1), partners: vec![], hb, ..Default::default() };
        e.round(&empty(Hb::Fresh), 0, &rig);
        let inc = e.round(&empty(Hb::Stale { secs: 120 }), STALE_AT, &rig).expect("沒有夥伴也要有訊號");
        assert!(inc.partners.is_empty() && !inc.resume);
        assert_eq!(rig.resumes.borrow().len(), 0);
    }
}
