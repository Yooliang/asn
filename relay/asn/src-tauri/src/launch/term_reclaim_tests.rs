//! #2424 A：重開後暫存的終端列會自己接回。測試用假的 cli 執行器（term.rs 的 FakeRunner），不碰真的 WezTerm。

use super::super::super::reclaim_rows::{next_interval, RetryReport, RETRY_FIRST, RETRY_MAX};
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

    // ③清單讀成功、裡面沒有這個窗格：服務自己答的，確定不在，才移除
    let rig = make(default_profiles(), vec![Some(1_000)]);
    *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "別人的", 7, 1);
    write_store(&rig.store, 1, &row("1", "grok", "1000", ""));
    rig.svc.reclaim().unwrap();
    assert_eq!(rig.svc.waiting_count(), 0);
    assert!(ids_in_store(&rig.store).is_empty(), "③清單裡沒有＝確定不在，才移除");
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
fn 重試間隔_三十秒起_逐輪加倍_最長五分鐘() {
    assert_eq!(RETRY_FIRST, Duration::from_secs(30));
    assert_eq!(RETRY_MAX, Duration::from_secs(300));
    let mut seq = vec![RETRY_FIRST];
    for _ in 0..6 {
        seq.push(next_interval(*seq.last().unwrap()));
    }
    assert_eq!(seq.iter().map(|d| d.as_secs()).collect::<Vec<_>>(), vec![30, 60, 120, 240, 300, 300, 300]);
}

#[test]
fn 重試的接線_背景執行緒用同一個單列嘗試_沒進展才加倍_接回後掃看畫面視窗() {
    let src = include_str!("term_reclaim.rs").replace("\r\n", "\n");
    let f = src.split("pub fn start_reclaim_retry").nth(1).unwrap();
    assert!(f.contains("terms.retry_parked()") && f.contains("next_interval(wait)") && f.contains("terms.adopt_viewers()"));
    let lib = include_str!("../lib.rs");
    assert!(lib.contains("launch::term::start_reclaim_retry(terms.clone())"), "啟動要接上重試");
    let body = src.split("pub fn retry_parked").nth(1).unwrap().split("/// 單列嘗試").next().unwrap();
    assert!(body.contains("self.reclaim_row("), "重試與啟動認回用同一份單列判斷");
}
