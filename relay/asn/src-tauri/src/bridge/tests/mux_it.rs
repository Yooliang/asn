//! 共用的終端服務中斷：通知本人（mux_down_notice）的整合測試。電腦端排通知檔、橋接核心下一輪呼叫後台。
use super::*;
use crate::launch::mux_watch;

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

#[tokio::test]
async fn 有排通知就呼叫一次_只帶人數和有沒有接回_寄出後檔案刪掉() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let dir = h.core.cfg.work_dir.clone();
    h.core.mux_notice_tick(T0).await;
    assert!(h.fr.mux_notices().is_empty(), "沒排就不呼叫");
    mux_watch::queue_notice(&dir, 2, true, now());
    h.core.mux_notice_tick(T0).await;
    h.core.mux_notice_tick(T0 + 1_000).await;
    let n = h.fr.mux_notices();
    assert_eq!(n.len(), 1, "一次事故只呼叫一次：{n:?}");
    assert_eq!((n[0]["count"].as_u64(), n[0]["resumed"].as_bool()), (Some(2), Some(true)));
    assert!(n[0].get("name").is_none() && n[0].get("partners").is_none(), "不帶夥伴名字：{}", n[0]);
    assert!(mux_watch::read_notice(&dir).is_none());
    assert!(h.core.log.has("mux-notice count=2 resumed=true notify=sent"));
}

#[tokio::test]
async fn 寄送失敗隔一分鐘再試_成功後停() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let dir = h.core.cfg.work_dir.clone();
    h.fr.st.lock().unwrap().mux_notice_notify = "failed".into();
    mux_watch::queue_notice(&dir, 1, false, now());
    h.core.mux_notice_tick(T0).await;
    h.core.mux_notice_tick(T0 + 30_000).await;
    assert_eq!(h.fr.mux_notices().len(), 1, "一分鐘內不重試");
    assert!(mux_watch::read_notice(&dir).is_some(), "沒寄到，檔要留著");
    h.fr.st.lock().unwrap().mux_notice_notify = "sent".into();
    h.core.mux_notice_tick(T0 + 61_000).await;
    assert_eq!(h.fr.mux_notices().len(), 2);
    assert!(mux_watch::read_notice(&dir).is_none());
}

#[tokio::test]
async fn 舊後台_參數不合_節點停用_只留本機提示_不重試() {
    for status in [404u16, 400, 403] {
        let mut h = harness(&[("T-乙", "idle")]).await;
        let dir = h.core.cfg.work_dir.clone();
        h.fr.st.lock().unwrap().mux_notice_status = status;
        mux_watch::queue_notice(&dir, 1, true, now());
        h.core.mux_notice_tick(T0).await;
        h.core.mux_notice_tick(T0 + 120_000).await;
        assert_eq!(h.fr.mux_notices().len(), 1, "{status} 不重試");
        assert!(mux_watch::read_notice(&dir).is_none());
        assert!(h.core.log.has(&format!("後台回 {status}")));
    }
}

#[tokio::test]
async fn 事故過了十分鐘還沒通知成功就放棄() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let dir = h.core.cfg.work_dir.clone();
    mux_watch::queue_notice(&dir, 1, true, now().saturating_sub(601_000));
    h.core.mux_notice_tick(T0).await;
    assert!(h.fr.mux_notices().is_empty());
    assert!(mux_watch::read_notice(&dir).is_none());
}

use crate::launch::mux_watch::{Observed, Watch, STATE_FILE};

const M1: (u32, u64) = (100, 1_000);
const M2: (u32, u64) = (200, 2_000);

fn obs(live: Option<(u32, u64)>, names: &[&str]) -> Observed {
    Observed { live, partners: names.iter().map(|s| s.to_string()).collect(), stopped: None }
}

#[tokio::test]
async fn 共用終端服務剛掛_監看還沒下結論_信先留著不退回_也不先說服務中斷_夥伴接回來就依序送() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    // 監看最近一輪還看到 T-丙 在共用終端服務裡
    let mut w = Watch::default();
    w.tick(&obs(Some(M1), &["T-丙"]), now());
    w.save(&h.core.cfg.work_dir.join(STATE_FILE));
    // 終端服務掛了：T-丙 的視窗不見
    std::fs::remove_file(h.sessions.path().join("5001.json")).unwrap();
    h.core.refresh_roster(T0 + 5_000).await;
    h.core.mux_notice_tick(T0 + 10_000).await;
    h.fr.put(mail(1, json!({"to_agent": "T-丙"})));
    h.core.pull("test", T0 + 11_000).await;
    assert!(h.said().is_empty(), "它不在：不送");
    assert!(h.fr.acked().is_empty(), "不 ack，信還在後台信箱");
    assert!(notice_bodies(&h).iter().all(|b| !b.contains("找不到")), "不退回：{:?}", notice_bodies(&h));
    assert!(notice_bodies(&h).iter().all(|b| !b.contains("中斷")), "還沒確定就不說服務中斷（也可能是夥伴自己結束了）：{:?}", notice_bodies(&h));
    // 接回來
    put_session(h.sessions.path(), 5009, "T-丙", "idle", 50);
    h.core.refresh_roster(T0 + 60_000).await;
    h.core.pull("test", T0 + 61_000).await;
    assert!(h.said().iter().any(|t| t.contains(&format!("id={}", uid(1)))), "接回來就送出：{:?}", h.said());
}

#[tokio::test]
async fn 確定中斷了才跟寄件人說服務中斷() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    let mut w = Watch::default();
    w.tick(&obs(Some(M1), &["T-丙"]), now());
    assert!(w.tick(&obs(Some(M2), &[]), now() + 30_000).is_some());
    w.save(&h.core.cfg.work_dir.join(STATE_FILE));
    std::fs::remove_file(h.sessions.path().join("5001.json")).unwrap();
    h.core.refresh_roster(T0 + 5_000).await;
    h.core.mux_notice_tick(T0 + 10_000).await;
    h.fr.put(mail(1, json!({"to_agent": "T-丙"})));
    h.core.pull("test", T0 + 11_000).await;
    let note: Vec<String> = notice_bodies(&h).into_iter().filter(|b| b.contains("先留著") && b.contains("T-丙")).collect();
    assert_eq!(note.len(), 1, "寄件人收到一次說明：{:?}", notice_bodies(&h));
    assert!(note[0].contains("共用終端服務中斷了") && note[0].contains("12 小時"), "{}", note[0]);
}

#[tokio::test]
async fn 夥伴自己結束_下一輪監看就不在名單上_信馬上退回找不到_不說服務中斷() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    let file = h.core.cfg.work_dir.join(STATE_FILE);
    let mut w = Watch::default();
    w.tick(&obs(Some(M1), &["T-乙", "T-丙"]), now());
    w.save(&file);
    // T-丙 自己 /exit：視窗不見；寄來的信先留著，但不說服務中斷
    std::fs::remove_file(h.sessions.path().join("5001.json")).unwrap();
    h.core.refresh_roster(T0 + 5_000).await;
    h.core.mux_notice_tick(T0 + 10_000).await;
    h.fr.put(mail(1, json!({"to_agent": "T-丙"})));
    h.core.pull("test", T0 + 11_000).await;
    assert!(h.fr.acked().is_empty());
    assert!(notice_bodies(&h).iter().all(|b| !b.contains("中斷")), "{:?}", notice_bodies(&h));
    // 下一輪監看收掉已結束的窗格：同一個服務、名單上沒有 T-丙
    assert!(w.tick(&obs(Some(M1), &["T-乙"]), now() + 30_000).is_none(), "不是事故");
    w.save(&file);
    h.core.mux_notice_tick(T0 + 40_000).await;
    h.core.pull("test", T0 + 41_000).await;
    assert!(notice_bodies(&h).iter().any(|b| b.contains("T-丙") && b.contains("找不到")), "退回找不到：{:?}", notice_bodies(&h));
    assert!(notice_bodies(&h).iter().all(|b| !b.contains("中斷")));
    assert_eq!(h.fr.acked().len(), 1, "退回後 ack");
}

#[tokio::test]
async fn 事故後還沒接回來的夥伴_消失超過五分鐘也不會被忘掉_信照樣留著() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    let mut w = Watch::default();
    w.tick(&obs(Some(M1), &["T-丙"]), now());
    // 換成新的終端服務、夥伴都不在：事故，記成還沒接回來
    assert!(w.tick(&obs(Some(M2), &[]), now() + 30_000).is_some());
    w.save(&h.core.cfg.work_dir.join(STATE_FILE));
    std::fs::remove_file(h.sessions.path().join("5001.json")).unwrap();
    h.core.refresh_roster(T0 + 5_000).await;
    h.core.mux_notice_tick(T0 + 6_000).await;
    // 超過 FORGET_AFTER_MS（5 分鐘）：本來會當成本人關掉而忘掉、之後信就退回
    h.core.refresh_roster(T0 + 700_000).await;
    h.core.mux_notice_tick(T0 + 701_000).await;
    let saved = crate::bridge::known::Known::load(&h.work.path().join(crate::bridge::known::KNOWN_FILE), T0 + 701_000);
    assert!(saved.contains("T-丙"), "還沒接回來的不能被忘掉");
    h.fr.put(mail(1, json!({"to_agent": "T-丙"})));
    h.core.pull("test", T0 + 702_000).await;
    assert!(h.fr.acked().is_empty() && notice_bodies(&h).iter().all(|b| !b.contains("找不到")), "{:?}", notice_bodies(&h));
}

#[tokio::test]
async fn 本人自己關掉的視窗_不在監看名單裡_照原本的做法退回() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    // 沒有監看狀態檔（或監看沒看過它）
    std::fs::remove_file(h.sessions.path().join("5001.json")).unwrap();
    h.core.refresh_roster(T0 + 5_000).await;
    h.core.mux_notice_tick(T0 + 10_000).await;
    h.fr.put(mail(1, json!({"to_agent": "T-丙"})));
    h.core.pull("test", T0 + 11_000).await;
    assert!(notice_bodies(&h).iter().any(|b| b.contains("T-丙")) && h.fr.acked().len() == 1, "照原本的做法退回並 ack：{:?}", notice_bodies(&h));
}
