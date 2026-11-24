//! #2256 卡在確認框超過 5 分鐘的保底通知：兩份都有送（擁有者、夥伴本人），失敗只重試失敗的那份。
use super::*;
use crate::launch::stuck_prompt::{StuckPrompt, PARTNER_TEXT};

fn prompt() -> StuckPrompt {
    StuckPrompt { name: "T-乙".into(), excerpt: " Do you want to proceed?\n ❯ 1. Yes\n   2. No".into() }
}

fn to_partner(h: &H) -> Vec<Value> {
    h.fr.sent().into_iter().filter(|b| b["body"] == PARTNER_TEXT).collect()
}

#[tokio::test]
async fn 兩份通知都送_擁有者帶畫面片段_夥伴收到白話() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.core.stuck_prompt_enqueue(T0, prompt());
    h.core.stuck_prompt_send(T0).await;
    let owner: Vec<Value> = h.fr.wait_notices().into_iter().filter(|b| b["kind"] == "stuck_prompt").collect();
    assert_eq!(owner.len(), 1, "擁有者那份：{owner:?}");
    assert_eq!(owner[0]["window"], "T-乙");
    assert!(owner[0]["detail"].as_str().unwrap().contains("Do you want to proceed?"), "要附看得到的那一段畫面");
    let p = to_partner(&h);
    assert_eq!(p.len(), 1, "夥伴本人那份：{:?}", h.fr.sent());
    assert_eq!(p[0]["to_agent"], "T-乙", "寄進它自己的視窗");
    assert!(PARTNER_TEXT.contains("超過 5 分鐘") && PARTNER_TEXT.contains("停掉它"));
}

#[tokio::test]
async fn 送完就不再送_同一筆不會重複() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.core.stuck_prompt_enqueue(T0, prompt());
    h.core.stuck_prompt_send(T0).await;
    h.core.stuck_prompt_send(T0 + 120_000).await;
    assert_eq!(h.fr.wait_notices().iter().filter(|b| b["kind"] == "stuck_prompt").count(), 1);
    assert_eq!(to_partner(&h).len(), 1);
}

#[tokio::test]
async fn 擁有者那份失敗_隔一分鐘只重試那一份_夥伴那份不重寄() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.st.lock().unwrap().wait_notice_status = 503;
    h.core.stuck_prompt_enqueue(T0, prompt());
    h.core.stuck_prompt_tick(T0).await;
    assert_eq!(to_partner(&h).len(), 1, "夥伴那份不受擁有者那份失敗影響");
    h.fr.st.lock().unwrap().wait_notice_status = 0;
    h.core.stuck_prompt_tick(T0 + 30_000).await;
    assert!(h.fr.wait_notices().is_empty(), "還沒到重試時間");
    h.core.stuck_prompt_tick(T0 + 60_000).await;
    assert_eq!(h.fr.wait_notices().iter().filter(|b| b["kind"] == "stuck_prompt").count(), 1, "重試送成");
    assert_eq!(to_partner(&h).len(), 1, "夥伴那份不重寄");
}

#[tokio::test]
async fn 被限頻不算寄過_log_寫明_下一輪再試_夥伴那份不重寄() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.st.lock().unwrap().wait_notice_notify = "rate_limited".into();
    h.core.stuck_prompt_enqueue(T0, prompt());
    h.core.stuck_prompt_tick(T0).await;
    assert!(h.core.log.has("被限頻"), "要寫明被限頻：{:?}", h.core.log.recent());
    assert_eq!(to_partner(&h).len(), 1, "夥伴那份照送");
    h.fr.st.lock().unwrap().wait_notice_notify = "sent".into();
    h.core.stuck_prompt_tick(T0 + 30_000).await;
    assert_eq!(h.core.log.count("stuck-prompt owner window"), 2, "還沒到重試時間（只有第一次的兩行 log）");
    h.core.stuck_prompt_tick(T0 + 60_000).await;
    assert!(h.core.log.has("notify=sent"), "第二次寄成：{:?}", h.core.log.recent());
    assert_eq!(to_partner(&h).len(), 1, "夥伴那份不重寄");
    h.core.stuck_prompt_tick(T0 + 180_000).await;
    assert_eq!(h.core.log.count("notify=sent"), 1, "寄成就不再寄");
}

#[tokio::test]
async fn 一直被限頻_過一小時放棄並寫_log() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.st.lock().unwrap().wait_notice_notify = "rate_limited".into();
    h.core.stuck_prompt_enqueue(T0, prompt());
    let mut t = T0;
    while t <= T0 + 3_700_000 {
        h.core.stuck_prompt_tick(t).await;
        t += 60_000;
    }
    assert!(h.core.log.has("過了一小時還沒送成"), "{:?}", h.core.log.recent());
}

/// 給夥伴本人的那份只能寄信（relay send），不能經過任何會把字送進終端的函式：
/// 夥伴這時正停在確認框上，打進去的字和 Enter 可能被當成選了某個選項（#2264 一審 1）
#[test]
fn 夥伴那份只寄信_原始碼不出現任何送鍵函式() {
    let src = crate::settings::src_scan::prod_source(include_str!("../core/stuck_prompt_notice.rs"));
    for f in ["confirm_send", "send_line_and_enter", "send_input", "send_bytes", "send_text", "send_line", "send_enter", "term_send", ".answer("] {
        assert!(!src.contains(f), "stuck_prompt_notice 不得出現送鍵函式 {f}");
    }
    assert!(src.contains(r#"self.relay.api("send""#), "夥伴那份經由寄信（relay send）送出");
}

#[tokio::test]
async fn 後台回_403_和舊後台不認得分開寫_log_都不再重試() {
    for (status, must, must_not) in [(403u16, "被拒絕", "舊後台不認得"), (404, "舊後台不認得", "被拒絕"), (400, "舊後台不認得", "被拒絕")] {
        let mut h = harness(&[("T-乙", "idle")]).await;
        h.fr.st.lock().unwrap().wait_notice_status = status;
        h.core.stuck_prompt_enqueue(T0, prompt());
        h.core.stuck_prompt_send(T0).await;
        let line = h.core.log.recent().into_iter().find(|l| l.contains("stuck-prompt owner") && l.contains(&format!("後台回 {status}"))).unwrap_or_else(|| panic!("{status} 要有一行 log：{:?}", h.core.log.recent()));
        assert!(line.contains(must) && !line.contains(must_not), "{status}：{line}");
        h.core.stuck_prompt_send(T0 + 120_000).await;
        assert_eq!(h.core.log.count("stuck-prompt owner"), 1, "{status} 再試也一樣，不重試");
    }
}
