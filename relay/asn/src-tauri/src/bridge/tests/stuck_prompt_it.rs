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
