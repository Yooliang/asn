// #2424 A：重開後暫存的終端列會自己接回。測試用假的 cli 執行器（term.rs 的 FakeRunner），不碰真的 WezTerm。
// 這支檔案由 term.rs 用 include! 放進 mux_mode::reclaim_retry（所以不能有 //! 內層註解）

use super::super::super::reclaim_rows::{next_interval, next_wait, run_retry_loop, stale_hours, RetryReport, RETRY_FIRST, RETRY_MAX};
use super::*;

fn ids_in_store(path: &Path) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v["terms"].as_array().unwrap().iter().filter_map(|t| t["id"].as_str().map(String::from)).collect()
}

/// 認回來的夥伴開在服務裡、名字叫小乙：重啟（新服務物件）時讀清單失敗，再讓它恢復
fn partner_restart(rig: &Rig) -> TermService<FakeRunner, FakeFs> {
    *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1 小乙", 9, 0);
    let mut svc = restarted(rig, true);
    svc.set_hold_config(true); // 開關開著才認領夥伴視窗的列
    svc
}

#[test]
fn 第一次讀清單失敗_列留著_之後恢復就自動接回_夥伴鈕回來() {
    let (rig, _) = mux_rig();
    let id = open_partner(&rig);
    assert!(rig.svc.partner_in_service("小乙"), "開窗當下在服務裡");
    let svc2 = partner_restart(&rig);
    *rig.runner.inner.fail_substr.borrow_mut() = Some("list".into());
    svc2.reclaim().unwrap();
    assert!(!svc2.partner_in_service("小乙"), "終端服務沒回應時還接不回");
    assert_eq!(svc2.waiting_count(), 1);
    assert_eq!(ids_in_store(&rig.store), vec![id.clone()], "暫存的列要留在檔案裡（persist 不能把它洗掉）");

    // 還沒恢復：這輪照樣接不回，列照樣留著
    assert_eq!(svc2.retry_parked(), RetryReport { restored: 0, waiting: 1 });
    assert_eq!(ids_in_store(&rig.store), vec![id.clone()]);
    assert!(!svc2.partner_in_service("小乙"));

    // 恢復：下一輪就接回
    *rig.runner.inner.fail_substr.borrow_mut() = None;
    assert_eq!(svc2.retry_parked(), RetryReport { restored: 1, waiting: 0 });
    assert!(svc2.partner_in_service("小乙"), "接回後前台／後台鈕的依據要恢復");
    assert_eq!(svc2.waiting_count(), 0);
    assert_eq!(ids_in_store(&rig.store), vec![id], "接回後照樣在對照表裡");
    assert_eq!(svc2.retry_parked(), RetryReport::default(), "沒有暫存的列就什麼都不做");
}

#[test]
fn 重試_沒有暫存的列就不下任何_cli() {
    let (rig, _) = mux_rig();
    open_partner(&rig);
    let svc2 = partner_restart(&rig);
    svc2.reclaim().unwrap();
    assert_eq!(svc2.waiting_count(), 0);
    let before = rig.runner.args().len();
    assert_eq!(svc2.retry_parked(), RetryReport::default());
    assert_eq!(rig.runner.args().len(), before);
}

#[test]
fn 重試_同一個通訊檔一輪只讀一次清單() {
    let rig = make(default_profiles(), vec![Some(1_000), Some(1_000)]);
    *rig.runner.inner.fail_substr.borrow_mut() = Some("list".into());
    let r5 = row("5", "pi", "1000", "");
    let r6 = row("6", "pi", "1000", "").replace(r#""pane_id":7"#, r#""pane_id":8"#);
    write_store(&rig.store, 7, &format!("{r5},{r6}"));
    rig.svc.reclaim().unwrap();
    assert_eq!(rig.svc.waiting_count(), 2);
    let before = super::super::list_calls(&rig.runner);
    assert_eq!(rig.svc.retry_parked(), RetryReport { restored: 0, waiting: 2 });
    assert_eq!(super::super::list_calls(&rig.runner) - before, 1, "兩列同一個通訊檔：這一輪只下一次 list");
    *rig.runner.inner.fail_substr.borrow_mut() = None;
    *rig.runner.inner.list_json.borrow_mut() = two_panes();
    assert_eq!(rig.svc.retry_parked(), RetryReport { restored: 2, waiting: 0 });
    assert_eq!(rig.svc.list().len(), 2);
}

#[test]
fn 原本直接丟掉的三種情況_現在保留並記原因_確定不在才移除() {
    // ① 查不到程序的建立時間、但程序還在：暫時接不回，留著；查得到了就接回
    let rig = make(default_profiles(), vec![None]);
    *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1", 7, 1);
    write_store(&rig.store, 1, &row("1", "grok", "1000", ""));
    rig.svc.reclaim().unwrap();
    assert_eq!(rig.svc.waiting_count(), 1);
    assert_eq!(ids_in_store(&rig.store), vec!["1".to_string()], "①留在檔案裡");
    assert_eq!(rig.svc.retry_parked(), RetryReport { restored: 1, waiting: 0 });
    assert_eq!(rig.svc.list().len(), 1);

    // ②終端服務的 pid 檔讀不到：暫時接不回；寫回來就接回
    let (rig, paths) = mux_rig();
    rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
    let pid_text = std::fs::read_to_string(&paths.pid).unwrap();
    std::fs::remove_file(&paths.pid).unwrap();
    let svc2 = restarted(&rig, true);
    svc2.reclaim().unwrap();
    assert_eq!(svc2.waiting_count(), 1, "②讀不到服務的 pid 記錄＝暫時接不回");
    assert_eq!(ids_in_store(&rig.store).len(), 1, "②留在檔案裡");
    std::fs::write(&paths.pid, pid_text).unwrap();
    assert_eq!(svc2.retry_parked(), RetryReport { restored: 1, waiting: 0 });

    // ②'pid 檔記的已經是另一個服務：原來的窗格確定跟著舊服務結束了，才移除
    let (rig, paths) = mux_rig();
    rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
    std::fs::write(&paths.pid, format!("{MUX_PID} 777")).unwrap();
    let svc2 = restarted(&rig, true);
    svc2.reclaim().unwrap();
    assert_eq!(svc2.waiting_count(), 0);
    assert!(ids_in_store(&rig.store).is_empty(), "②'服務換了＝確定不在，才移除");

    // ③清單讀成功、裡面沒有這個窗格：連續兩輪都沒有才移除（第一輪先留著，見下一支測試）
    let rig = make(default_profiles(), vec![Some(1_000)]);
    *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "別人的", 7, 1);
    write_store(&rig.store, 1, &row("1", "grok", "1000", ""));
    rig.svc.reclaim().unwrap();
    assert_eq!(rig.svc.waiting_count(), 1, "③第一輪沒有：先留著");
    assert_eq!(ids_in_store(&rig.store).len(), 1);
    assert_eq!(rig.svc.retry_parked(), RetryReport { restored: 0, waiting: 0 });
    assert_eq!(rig.svc.waiting_count(), 0);
    assert!(ids_in_store(&rig.store).is_empty(), "③連續兩輪清單裡都沒有＝才移除");
}

/// M3：清單讀成功但沒有那個窗格，照 `sweep_missing` 連續兩輪才移除；中間讀不到清單要重新數；中間又出現就接回
#[test]
fn 清單沒有該窗格_連續兩輪才移除_中間讀不到清單重新數_又出現就接回() {
    let rig = make(default_profiles(), vec![Some(1_000)]);
    *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "別人的", 7, 1);
    write_store(&rig.store, 1, &row("1", "grok", "1000", ""));
    rig.svc.reclaim().unwrap(); // 第 1 輪：沒有
    // 第 2 輪讀不到清單：不算「兩輪都沒有」，重新數
    *rig.runner.inner.fail_substr.borrow_mut() = Some("list".into());
    assert_eq!(rig.svc.retry_parked(), RetryReport { restored: 0, waiting: 1 });
    *rig.runner.inner.fail_substr.borrow_mut() = None;
    // 第 3 輪：又是第一次沒有，不能移除
    assert_eq!(rig.svc.retry_parked(), RetryReport { restored: 0, waiting: 1 });
    assert_eq!(ids_in_store(&rig.store).len(), 1, "中間讀不到清單過，不能算連續兩輪");
    // 第 4 輪：窗格出現了：接回
    *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1", 7, 1);
    assert_eq!(rig.svc.retry_parked(), RetryReport { restored: 1, waiting: 0 });
    assert_eq!(rig.svc.list().len(), 1);
}

/// M2：認領時讀不到畫面（失敗或被暫停略過）不能記成「剛確認過還活著」（監看第一輪才會照常重讀）
#[test]
fn 認領時讀不到畫面_不記成剛確認過還活著() {
    let (rig, _) = mux_rig();
    open_partner(&rig);
    let svc2 = partner_restart(&rig);
    *rig.runner.inner.fail_substr.borrow_mut() = Some("get-text".into());
    svc2.reclaim().unwrap();
    assert!(svc2.partner_in_service("小乙"), "讀不到畫面照樣當作還活著、接回");
    assert!(svc2.inner.lock().unwrap().probed.is_empty(), "沒讀到畫面，不能記成剛確認過");
    // 對照：讀得到時要記（拿掉判斷、一律記 probed 時上面那條會紅）
    *rig.runner.inner.fail_substr.borrow_mut() = None;
    let svc3 = partner_restart(&rig);
    svc3.reclaim().unwrap();
    assert!(!svc3.inner.lock().unwrap().probed.is_empty(), "讀到畫面、確認還活著要記");
}

/// M4：找不到終端服務的資料夾（mux_handle 失敗）是失敗，不是有意先不碰：要進重試
#[test]
fn 找不到終端服務的資料夾_進重試_不是有意先不碰() {
    let (rig, _) = mux_rig();
    rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
    let mut svc2 = restarted(&rig, true);
    svc2.mux_base = None; // 找不到使用者的本機資料夾
    svc2.reclaim().unwrap();
    assert_eq!(svc2.waiting_count(), 1, "mux_handle 失敗要算在等的列");
    assert_eq!(svc2.retry_parked(), RetryReport { restored: 0, waiting: 1 });
    assert_eq!(ids_in_store(&rig.store).len(), 1, "列還在檔案裡");
}

#[test]
fn 有意先不碰的列不重試_開關關著不下_cli() {
    // 夥伴視窗的列、開關關著
    let rig = make(default_profiles(), vec![]);
    write_store(&rig.store, 5, &row("5", "claude", "1000", r#","kind":"claude""#));
    rig.svc.reclaim().unwrap();
    assert_eq!(rig.svc.waiting_count(), 0, "有意留著的不算在等");
    assert_eq!(rig.svc.retry_parked(), RetryReport::default());
    assert!(rig.runner.args().is_empty(), "不下 cli");
    assert_eq!(ids_in_store(&rig.store), vec!["5".to_string()], "列還在檔案裡");
    // mux 的列、這次沒開服務
    let (rig, _) = mux_rig();
    rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
    let before = rig.runner.args().len();
    let svc2 = restarted(&rig, false);
    svc2.reclaim().unwrap();
    assert_eq!((svc2.waiting_count(), svc2.retry_parked()), (0, RetryReport::default()));
    assert_eq!(rig.runner.args().len(), before);
    assert_eq!(ids_in_store(&rig.store).len(), 1);
}

#[test]
fn 重試間隔_三十秒起_逐輪加倍_最長二十分鐘() {
    assert_eq!(RETRY_FIRST, Duration::from_secs(30));
    assert_eq!(RETRY_MAX, Duration::from_secs(20 * 60));
    let mut seq = vec![RETRY_FIRST];
    for _ in 0..7 {
        seq.push(next_interval(*seq.last().unwrap()));
    }
    assert_eq!(seq.iter().map(|d| d.as_secs()).collect::<Vec<_>>(), vec![30, 60, 120, 240, 480, 960, 1200, 1200]);
    assert_eq!(next_wait(Duration::from_secs(480), 1), RETRY_FIRST, "有接回就重新從頭算");
    assert_eq!(next_wait(Duration::from_secs(480), 0), Duration::from_secs(960), "沒進展就加倍");
}

/// M4：接不回太久的醒目提醒——滿一小時才寫、每列每小時最多一次
#[test]
fn 接不回太久_滿一小時才提醒_每小時最多一次() {
    let h = Duration::from_secs(3600);
    assert_eq!(stale_hours(h - Duration::from_secs(1), None), None, "不到一小時不提醒");
    assert_eq!(stale_hours(h, None), Some(1));
    assert_eq!(stale_hours(h * 3 + Duration::from_secs(5), None), Some(3));
    assert_eq!(stale_hours(h * 3, Some(Duration::from_secs(600))), None, "十分鐘前才提醒過，這次不再寫");
    assert_eq!(stale_hours(h * 3, Some(h)), Some(3), "上次提醒滿一小時了，再寫一次");
    // 實際接在列上：剛開始接不回的列不會被提醒
    let mut info = super::super::super::reclaim_rows::ParkInfo::default();
    assert!(info.stale_note("夥伴「小乙」").is_none());
    info.since = Instant::now().checked_sub(h * 2 + Duration::from_secs(1)).unwrap();
    let line = info.stale_note("夥伴「小乙」").expect("接不回兩小時了要提醒");
    assert!(line.contains("【注意】") && line.contains("夥伴「小乙」") && line.contains("2 小時"), "{line}");
    assert!(info.stale_note("夥伴「小乙」").is_none(), "剛提醒過，這一小時內不再寫");
}

/// 重試迴圈（M5：抽成純函式做行為測試，不比原始碼字串）：記錄每次睡多久、每輪有沒有真的叫
struct LoopRig {
    sleeps: RefCell<Vec<u64>>,
    rounds: RefCell<usize>,
    restored_calls: RefCell<usize>,
    logs: RefCell<Vec<String>>,
}
impl LoopRig {
    fn new() -> Self {
        LoopRig { sleeps: RefCell::new(vec![]), rounds: RefCell::new(0), restored_calls: RefCell::new(0), logs: RefCell::new(vec![]) }
    }
    /// `results`＝每輪回的（接回幾列）；`waiting_after`＝每輪之後還剩幾列在等；`pauses`＝每次問「還在暫停嗎」依序的答案（問完了就是沒暫停）
    fn run(&self, results: Vec<usize>, waiting_after: Vec<usize>, pauses: Vec<Option<u64>>) {
        let (results, waiting_after, pauses) = (RefCell::new(results), RefCell::new(waiting_after), RefCell::new(pauses));
        run_retry_loop(
            &mut |d| self.sleeps.borrow_mut().push(d.as_secs()),
            &|| {
                let mut p = pauses.borrow_mut();
                if p.is_empty() { None } else { p.remove(0).map(Duration::from_secs) }
            },
            &mut || {
                *self.rounds.borrow_mut() += 1;
                let r = results.borrow_mut().remove(0);
                if r == usize::MAX {
                    panic!("假的當掉");
                }
                RetryReport { restored: r, waiting: 1 }
            },
            &mut || *self.restored_calls.borrow_mut() += 1,
            &|| {
                let mut w = waiting_after.borrow_mut();
                if w.is_empty() { 0 } else { w.remove(0) }
            },
            &|l| self.logs.borrow_mut().push(l.to_string()),
        );
    }
}

#[test]
fn 重試迴圈_沒進展就加倍_有接回就重設_沒有等待的列就結束() {
    let r = LoopRig::new();
    // 四輪：沒進展、沒進展、接回一列（重設）、沒進展；最後一輪之後沒有在等的了
    r.run(vec![0, 0, 1, 0], vec![2, 2, 1, 0], vec![]);
    assert_eq!(*r.sleeps.borrow(), vec![30, 60, 120, 30], "加倍、加倍、接回後重設成 30、再從頭");
    assert_eq!(*r.rounds.borrow(), 4);
    assert_eq!(*r.restored_calls.borrow(), 1, "只有接回那一輪才掃看畫面視窗");
}

#[test]
fn 重試迴圈_間隔到二十分鐘封頂() {
    let r = LoopRig::new();
    r.run(vec![0; 9], vec![1, 1, 1, 1, 1, 1, 1, 1, 0], vec![]);
    assert_eq!(*r.sleeps.borrow(), vec![30, 60, 120, 240, 480, 960, 1200, 1200, 1200]);
}

/// 閘門暫停期間不叫任何指令：只等，等完再試；這樣的等待不算一輪、不讓間隔加倍
#[test]
fn 重試迴圈_閘門暫停期間不叫清單_等暫停結束才試() {
    let r = LoopRig::new();
    r.run(vec![0], vec![0], vec![Some(90), Some(20)]);
    assert_eq!(*r.sleeps.borrow(), vec![30, 91, 21], "先睡 30 秒，之後兩次暫停各等到結束（多等 1 秒）");
    assert_eq!(*r.rounds.borrow(), 1, "暫停結束之後才叫一次");
    // 暫停中一次都沒叫：暫停結束前 round 不能被呼叫（拿掉暫停判斷，rounds 會在睡之前就先加）
    let r2 = LoopRig::new();
    r2.run(vec![0, 0], vec![1, 0], vec![Some(10), None]);
    assert_eq!(*r2.sleeps.borrow(), vec![30, 11, 60], "暫停不算一輪：下一輪的間隔是 60 不是 120");
}

/// LOW：每輪裡 panic 只記 log，這條執行緒不能死
#[test]
fn 重試迴圈_某一輪當掉只記_log_下一輪照試() {
    let r = LoopRig::new();
    r.run(vec![usize::MAX, 1], vec![1, 0], vec![]);
    assert_eq!(*r.rounds.borrow(), 2, "當掉那一輪之後還有下一輪");
    assert_eq!(r.logs.borrow().len(), 1, "{:?}", r.logs.borrow());
    assert_eq!(*r.restored_calls.borrow(), 1);
}

/// X2 的接線：「例行」只標在背景工作（監看讀畫面、掃已結束窗格、認領時讀畫面）；
/// 使用者動作（按允許、代答、看畫面、開窗後的早退偵測）絕不能標
#[test]
fn 例行標記的接線_只在背景工作_使用者動作不標() {
    let term = include_str!("term.rs").replace("\r\n", "\n");
    let prod = term.split("#[cfg(test)]\nmod tests").next().unwrap();
    assert!(prod.contains("cli_gate::routine(|| terms.partner_screen_view(&id))"), "背景監看讀畫面要標例行");
    assert!(prod.contains("cli_gate::routine(|| w.pane_exit(sock, *pane, Some(nonce)))"), "掃已結束窗格要標例行");
    assert_eq!(prod.matches("cli_gate::routine(").count(), 2, "例行標記只有這兩處（認領的在 term_reclaim.rs）");
    // 背景讀畫面被略過：要告訴排程（schedule.skipped，不算讀失敗、不退避）然後 continue，不能往下當成讀到或讀失敗
    let after = prod.split("cli_gate::routine(|| terms.partner_screen_view(&id))").nth(1).unwrap();
    let skip_block = after.split("\n                }\n").next().unwrap();
    let (a, b, c) = (skip_block.find("cli_gate::is_skipped(e)"), skip_block.find("schedule.skipped(&id, now);"), skip_block.find("continue;"));
    assert!(matches!((a, b, c), (Some(a), Some(b), Some(c)) if a < b && b < c), "背景讀畫面被略過要 schedule.skipped 後 continue：{skip_block}");
    for f in ["fn partner_screen_checked", "fn permission_checked", "fn early_exit", "pub fn answer", "pub fn partner_term_id"] {
        let body = prod.split(f).nth(1).unwrap_or_else(|| panic!("找不到 {f}"));
        let body = body.split("\n    }\n").next().unwrap();
        assert!(!body.contains("routine("), "{f} 是使用者動作，不能標例行");
    }
    let rec = include_str!("term_reclaim.rs");
    assert!(rec.contains("cli_gate::routine(|| w.pane_probe("), "認領時讀畫面要標例行");
}

#[test]
fn 重試的接線_啟動要接上_重試與啟動認回用同一份單列判斷() {
    let src = include_str!("term_reclaim.rs").replace("\r\n", "\n");
    let f = src.split("pub fn start_reclaim_retry").nth(1).unwrap();
    assert!(f.contains("terms.retry_parked()") && f.contains("terms.adopt_viewers()") && f.contains("longest_cooldown()"));
    let lib = include_str!("../lib.rs");
    assert!(lib.contains("launch::term::start_reclaim_retry(terms.clone())"), "啟動要接上重試");
    let body = src.split("pub fn retry_parked").nth(1).unwrap().split("/// 單列嘗試").next().unwrap();
    assert!(body.contains("self.reclaim_row("), "重試與啟動認回用同一份單列判斷");
}
