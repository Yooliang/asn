//! 本人接進收發室的視窗（只能自己收信，各家轉接層第 2 步）：名單、留信、通知寄件人、太久退回、程序結束回到一般流程
use super::*;

const AGY: u32 = 9600;
const ST: u64 = 1_762_400_000_000;

fn register(h: &H, name: &str) {
    let dir = h.work.path().join(crate::self_windows::DIR);
    crate::self_windows::write(&dir, &crate::self_windows::Entry { name: name.into(), engine: "gemini".into(), pid: AGY, started_ms: ST, at: ST }).unwrap();
}

/// AGY 這個程序還在（建立時間和登記一致）；其他 pid 照原本的假環境
fn agy_alive(h: &mut H) {
    h.core.set_created(Arc::new(|p| if p == AGY { Some(ST + 100) } else { None }));
}
fn agy_gone(h: &mut H) {
    h.core.set_created(Arc::new(|_| None));
}

#[tokio::test]
async fn 名單上列成只能自己收信_可收信() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    register(&h, "agy-1");
    agy_alive(&mut h);
    h.core.refresh_roster(T0 + 1_000).await;
    let r = h.fr.rosters().last().cloned().expect("有上傳名單");
    let a = r["agents"].as_array().unwrap().iter().find(|a| a["name"] == "agy-1").cloned().expect("名單上有 agy-1");
    assert_eq!(a["kind"], "selfpull");
    assert_ne!(a["receivable"], json!(false), "可收信（不是僅顯示）");
    assert_eq!(a["detail"], "只能自己收信");
}

#[tokio::test]
async fn 寄給它的信留在信箱_不推不退回_寄件人只通知一次() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    register(&h, "agy-1");
    agy_alive(&mut h);
    h.core.refresh_roster(T0 + 1_000).await;
    h.fr.put(mail(1, json!({"to_agent": "agy-1"})));
    h.fr.put(mail(2, json!({"to_agent": "agy-1"})));
    h.core.pull("test", T0 + 2_000).await;
    h.core.pull("test", T0 + 3_000).await;
    assert!(h.said().is_empty(), "不推進去：{:?}", h.said());
    assert!(h.fr.acked().is_empty(), "不 ack，信留在信箱讓它自己收");
    let notes: Vec<String> = notice_bodies(&h).into_iter().filter(|b| b.contains("agy-1")).collect();
    assert_eq!(notes.len(), 1, "同一位寄件人只說一次：{notes:?}");
    assert!(notes[0].contains("要自己收信") && notes[0].contains("可能比較晚"), "{}", notes[0]);
    assert!(notes.iter().all(|b| !b.contains("找不到")));
}

#[tokio::test]
async fn 剛接進來_名單還沒重讀就有信_馬上重讀名單並留著_不退回找不到() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    agy_alive(&mut h);
    // 名單是接進來之前讀的（沒有 agy-1）；接著本人按了「接進收發室」
    register(&h, "agy-1");
    let before = h.fr.rosters().len();
    h.fr.put(mail(1, json!({"to_agent": "agy-1"})));
    h.core.pull("test", T0 + 2_000).await;
    assert!(h.fr.acked().is_empty(), "不退回、不 ack：留著讓它自己收");
    assert!(notice_bodies(&h).iter().all(|b| !b.contains("找不到")), "{:?}", notice_bodies(&h));
    assert!(notice_bodies(&h).iter().any(|b| b.contains("agy-1") && b.contains("要自己收信")), "{:?}", notice_bodies(&h));
    assert!(h.fr.rosters().len() > before, "馬上重讀並上傳名單");
    let r = h.fr.rosters().last().cloned().unwrap();
    assert!(r["agents"].as_array().unwrap().iter().any(|a| a["name"] == "agy-1" && a["kind"] == "selfpull"));
}

#[tokio::test]
async fn 名單上有同名的活視窗時_不因為登記而留信() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    agy_alive(&mut h);
    register(&h, "T-乙");
    h.fr.put(mail(1, json!({"to_agent": "T-乙"})));
    h.core.pull("test", T0 + 2_000).await;
    assert!(notice_bodies(&h).iter().all(|b| !b.contains("要自己收信")), "既有的視窗優先：{:?}", notice_bodies(&h));
}

#[tokio::test]
async fn 放太久沒被收走就退回並說明() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    register(&h, "agy-1");
    agy_alive(&mut h);
    h.core.refresh_roster(T0 + 1_000).await;
    h.fr.put(mail(1, json!({"to_agent": "agy-1"})));
    h.core.pull("test", T0 + 2_000).await;
    assert!(h.fr.acked().is_empty());
    h.core.refresh_roster(T0 + 12 * 3_600_000).await;
    h.core.pull("test", T0 + 12 * 3_600_000 + 3_000).await;
    assert!(h.fr.acked().contains(&uid(1)), "超過 12 小時：退回並 ack");
    assert!(notice_bodies(&h).iter().any(|b| b.contains("agy-1") && b.contains("退回")), "{:?}", notice_bodies(&h));
}

#[tokio::test]
async fn 程序結束後_登記失效_信照一般規則退回找不到() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    register(&h, "agy-1");
    agy_alive(&mut h);
    h.core.refresh_roster(T0 + 1_000).await;
    agy_gone(&mut h);
    h.core.refresh_roster(T0 + 5_000).await;
    let r = h.fr.rosters().last().cloned().unwrap();
    assert!(r["agents"].as_array().unwrap().iter().all(|a| a["name"] != "agy-1"), "名單上拿掉");
    h.fr.put(mail(1, json!({"to_agent": "agy-1"})));
    h.core.pull("test", T0 + 6_000).await;
    assert!(notice_bodies(&h).iter().any(|b| b.contains("找不到名叫「agy-1」")), "{:?}", notice_bodies(&h));
    assert_eq!(h.fr.acked(), vec![uid(1)]);
}

#[tokio::test]
async fn 和既有視窗同名的登記不列_信照常送給原本的視窗() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    register(&h, "T-乙");
    agy_alive(&mut h);
    h.core.refresh_roster(T0 + 1_000).await;
    let r = h.fr.rosters().last().cloned().unwrap();
    let same: Vec<&Value> = r["agents"].as_array().unwrap().iter().filter(|a| a["name"] == "T-乙").collect();
    assert_eq!(same.len(), 1);
    assert!(same[0].get("kind").is_none() || same[0]["kind"] != "selfpull", "原本的視窗優先");
}
