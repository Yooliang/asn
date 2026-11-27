//! #2424 B／C：開窗格逾時後找回窗格、夥伴的終端三種狀態。測試用假的 cli 執行器（term.rs 的 FakeRunner），不碰真的 WezTerm。

use super::super::super::{TermState, TermStateInfo};
use super::*;

const TIMEOUT: &str = "WezTerm 指令逾時（15 秒），已結束該子行程";

fn ids_in_store(path: &Path) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v["terms"].as_array().unwrap().iter().filter_map(|t| t["id"].as_str().map(String::from)).collect()
}

/// 兩個窗格的清單（去掉 JSON 陣列的外括號再接起來）
fn two_listed(a: String, b: String) -> String {
    format!("[{},{}]", &a[1..a.len() - 1], &b[1..b.len() - 1])
}

/// 夥伴視窗的 rig：開關開著才會認領夥伴視窗的列
fn partner_rig() -> Rig {
    let (mut rig, _) = mux_rig();
    rig.svc.set_hold_config(true);
    rig
}

fn state_of(rig: &Rig) -> TermStateInfo {
    rig.svc.partner_term_state("小乙")
}

#[test]
fn 開窗逾時_清單裡剛好一個對得上的窗格_照常登記() {
    let rig = partner_rig();
    *rig.runner.inner.clean_err.borrow_mut() = Some(TIMEOUT.into());
    // 窗格其實已經開了：工作區 asn-1、標題還沒設
    *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "", 9, 0);
    let (id, _) = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("sid-1"))).expect("逾時但窗格在，要當作開成功");
    assert!(rig.svc.partner_in_service("小乙"), "前台／後台鈕的依據要有");
    assert_eq!(state_of(&rig).state, TermState::Ok);
    assert_eq!(ids_in_store(&rig.store), vec![id], "對照表有這一列");
    assert_eq!(count_sub(&rig.runner, "kill-pane"), 0, "沒有關任何窗格");
    assert_eq!(rig.svc.waiting_count(), 0);
}

#[test]
fn 開窗逾時_清單裡有好幾個對得上_不登記錯的() {
    let rig = partner_rig();
    *rig.runner.inner.clean_err.borrow_mut() = Some(TIMEOUT.into());
    *rig.runner.inner.list_json.borrow_mut() = two_listed(one_pane("asn-1", "", 9, 0), one_pane("asn-1", "", 10, 0));
    let e = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("sid-1"))).unwrap_err();
    assert!(matches!(&e, crate::launch::win_term::WinOpenError::Started(m) if m.contains("分不出哪個是剛開的")), "{e:?}");
    assert!(!rig.svc.partner_in_service("小乙"), "不亂認");
    assert_eq!(rig.svc.waiting_count(), 0, "也不留著重試");
    assert!(ids_in_store(&rig.store).is_empty());
    assert_eq!(count_sub(&rig.runner, "kill-pane"), 0, "分不出來就誰都不關");
}

#[test]
fn 開窗逾時_清單裡找不到_回失敗不登記() {
    let rig = partner_rig();
    *rig.runner.inner.clean_err.borrow_mut() = Some(TIMEOUT.into());
    // 只有使用者自己開的窗格（工作區不是 asn-），絕不能被認走
    *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "我自己的", 3, 0);
    let e = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("sid-1"))).unwrap_err();
    assert!(matches!(&e, crate::launch::win_term::WinOpenError::Started(m) if m.contains("沒有開成功")), "{e:?}");
    assert_eq!(state_of(&rig).state, TermState::Gone);
    assert_eq!(rig.svc.waiting_count(), 0);
    assert!(ids_in_store(&rig.store).is_empty());
}

#[test]
fn 開窗逾時_清單也讀不到_記成暫時接不回_恢復後自動認回_期間不叫人重開() {
    let rig = partner_rig();
    *rig.runner.inner.clean_err.borrow_mut() = Some(TIMEOUT.into());
    // 清單讀不到（回的不是清單）；不能用 fail_substr "list"，那會連查終端服務還在不在的 list-clients 一起擋掉
    *rig.runner.inner.list_json.borrow_mut() = "不是 json".into();
    let e = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("sid-1"))).unwrap_err();
    let crate::launch::win_term::WinOpenError::Started(m) = e else { panic!("應該是已啟動的失敗") };
    assert!(m.contains("稍後會自己接回來") && m.contains("不用重開"), "{m}");
    assert!(!m.contains("wezterm") && !m.contains("mux") && !m.contains("窗格"), "白話，不寫系統元件名：{m}");
    // 暫時接不回：留在對照表、記了原因、不是「確定不在」
    assert_eq!(rig.svc.waiting_count(), 1);
    assert_eq!(ids_in_store(&rig.store).len(), 1, "寫進對照表，重開 ASN 也會再認");
    let s = state_of(&rig);
    assert_eq!(s.state, TermState::Waiting, "不叫人重開");
    assert!(!s.reason.is_empty(), "原因要記下來");
    assert!(!rig.svc.partner_in_service("小乙"), "還沒登記，按鈕先不能按");
    // 同一位夥伴不會被開出第二個窗格：開窗只 spawn 一次
    assert_eq!(count_sub(&rig.runner, "spawn"), 1);

    // 終端服務恢復、窗格其實在：重試用工作區認回，夥伴名字不掉
    *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "", 9, 0);
    let r = rig.svc.retry_parked();
    assert_eq!((r.restored, r.waiting), (1, 0), "{:?}", state_of(&rig));
    assert_eq!(state_of(&rig).state, TermState::Ok);
    assert!(rig.svc.partner_in_service("小乙"), "接回後鈕恢復，標題裡的夥伴名字還在");
}

#[test]
fn 暫時接不回的列_重試時只認_asn_自己命名的窗格_使用者自己開的不被認走() {
    let rig = partner_rig();
    *rig.runner.inner.clean_err.borrow_mut() = Some(TIMEOUT.into());
    *rig.runner.inner.list_json.borrow_mut() = "不是 json".into();
    rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("sid-1"))).unwrap_err();
    // 清單讀得到了，但裡面只有使用者自己開的窗格：確定不在，列移除，不認走別人的
    *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "ASN 以外的", 5, 0);
    let r = rig.svc.retry_parked();
    assert_eq!((r.restored, r.waiting), (0, 0));
    assert_eq!(state_of(&rig).state, TermState::Gone);
    assert!(ids_in_store(&rig.store).is_empty());
    assert!(!rig.svc.partner_in_service("小乙"));
}

#[test]
fn 三種狀態_已登記_暫時接不回_確定不在() {
    let rig = partner_rig();
    // 確定不在：什麼都沒有
    assert_eq!(state_of(&rig).state, TermState::Gone, "還沒開");
    assert_eq!(rig.svc.partner_term_state("").state, TermState::Gone, "沒給名字");
    assert_eq!(rig.svc.partner_term_state("agy").state, TermState::Gone, "不合夥伴名規則");
    // 已登記
    open_partner(&rig);
    assert_eq!(state_of(&rig).state, TermState::Ok);
    assert_eq!(rig.svc.partner_term_state("小甲").state, TermState::Gone, "別的名字");
    // 重開 ASN、終端服務讀不到清單：暫時接不回
    *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1 小乙", 9, 0);
    let mut svc2 = restarted(&rig, true);
    svc2.set_hold_config(true);
    *rig.runner.inner.fail_substr.borrow_mut() = Some("list".into());
    svc2.reclaim().unwrap();
    let w = svc2.partner_term_state("小乙");
    assert_eq!(w.state, TermState::Waiting);
    assert!(!w.reason.is_empty());
    // 清單讀成功卻沒有這個窗格：確定不在
    *rig.runner.inner.fail_substr.borrow_mut() = None;
    *rig.runner.inner.list_json.borrow_mut() = "[]".into();
    svc2.retry_parked();
    assert_eq!(svc2.partner_term_state("小乙").state, TermState::Gone);
    // 給畫面的是小寫字串
    assert_eq!(serde_json::to_value(TermStateInfo { state: TermState::Waiting, reason: String::new() }).unwrap()["state"], "waiting");
}

#[test]
fn 夥伴數與還沒接回數_和狀態讀同一份資料() {
    let rig = partner_rig();
    open_partner(&rig);
    assert_eq!(rig.svc.partner_term_counts(), (1, 0));
    *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1 小乙", 9, 0);
    let mut svc2 = restarted(&rig, true);
    svc2.set_hold_config(true);
    *rig.runner.inner.fail_substr.borrow_mut() = Some("list".into());
    svc2.reclaim().unwrap();
    assert_eq!(svc2.partner_term_counts(), (0, 1), "暫時接不回的算在還沒接回裡");
    assert_eq!(svc2.partner_term_state("小乙").state, TermState::Waiting, "跟狀態一致");
    *rig.runner.inner.fail_substr.borrow_mut() = None;
    svc2.retry_parked();
    assert_eq!(svc2.partner_term_counts(), (1, 0));
}

#[test]
fn 接線_開窗逾時用工作區找回_監看啟動紀錄讀終端對照表() {
    let term = include_str!("term.rs").replace("\r\n", "\n");
    let open: String = term.split("fn open_mux(").nth(1).unwrap().chars().take(9000).collect();
    assert!(open.contains("spawn_recover::find_spawned("), "逾時後要去清單找窗格");
    let watch = include_str!("mux_watch.rs").replace("\r\n", "\n");
    assert!(watch.contains("log_startup_state(&w, age, terms.partner_term_counts())"), "啟動紀錄讀終端對照表");
    let lib = include_str!("../lib.rs");
    assert!(lib.contains("term_view_state, "), "新指令要掛上");
}
