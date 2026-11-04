//! ack 失敗：下一輪補上、不再轉交一次；一直失敗有退避；清單有上限；重開後接著補。假後端、假 worker。
use super::*;

fn set_ack(h: &H, status: u16) {
    h.fr.st.lock().unwrap().ack_status = status;
}

fn ack_calls(h: &H) -> usize {
    h.fr.st.lock().unwrap().ack_calls
}

fn forwards(h: &H, id: &str) -> usize {
    h.said().iter().filter(|t| t.starts_with("[BRIDGE-FORWARD") && t.lines().next().unwrap().contains(&format!("id={id} "))).count()
}

/// 轉交一封信，轉交完那次 ack 失敗
async fn forward_ack_fails(h: &mut H, n: u32, extra: Value, now: u64) {
    set_ack(h, 500);
    h.fr.put(mail(n, extra));
    h.core.pull("test", now).await;
    worker_ok(&mut h.core, &uid(n), now + 1).await;
    assert!(h.fr.acked().is_empty(), "這次 ack 失敗");
    assert_eq!(h.core.test_ack_retry(), [uid(n)]);
}

#[tokio::test]
async fn 不用回的信_ack_失敗_之後補上_只轉交一次() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    forward_ack_fails(&mut h, 1, json!({"expects_reply": false}), T0).await;
    h.core.pull("test", T0 + 10).await;
    assert_eq!(forwards(&h, &uid(1)), 1, "ack 失敗不再轉交");
    set_ack(&h, 0);
    h.core.tick(T0 + 1 + 30_000).await;
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    assert!(h.core.test_ack_retry().is_empty());
    h.core.pull("test", T0 + 40_000).await;
    assert_eq!(forwards(&h, &uid(1)), 1);
}

#[tokio::test]
async fn 要回信的信_ack_失敗_之後補上_只轉交一次() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    forward_ack_fails(&mut h, 1, json!({"expects_reply": true}), T0).await;
    h.core.pull("test", T0 + 10).await;
    assert_eq!(forwards(&h, &uid(1)), 1);
    set_ack(&h, 0);
    h.core.tick(T0 + 1 + 30_000).await;
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    h.core.pull("test", T0 + 40_000).await;
    assert_eq!(forwards(&h, &uid(1)), 1);
}

#[tokio::test]
async fn 補_ack_一直失敗_不轉交_間隔加倍_最多十分鐘_恢復後清空() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    forward_ack_fails(&mut h, 1, json!({"expects_reply": false}), T0).await;
    let first = T0 + 1 + 30_000;
    let before = ack_calls(&h);
    h.core.tick(first - 1).await;
    assert_eq!(ack_calls(&h), before, "還沒到時間不打");
    h.core.tick(first).await;
    let tried = ack_calls(&h);
    assert!(tried > before, "到時間補一次");
    h.core.tick(first + 59_999).await;
    assert_eq!(ack_calls(&h), tried, "失敗後間隔加倍成 60 秒");
    h.core.tick(first + 60_000).await;
    assert!(ack_calls(&h) > tried);
    // 再失敗幾輪：間隔不超過十分鐘，這段時間拉信也不再轉交
    let mut now = first + 60_000;
    for _ in 0..8 {
        now += 600_000;
        let c = ack_calls(&h);
        h.core.tick(now).await;
        assert!(ack_calls(&h) > c, "間隔最多十分鐘");
        h.core.pull("test", now).await;
    }
    let c = ack_calls(&h);
    h.core.tick(now + 599_999).await;
    assert_eq!(ack_calls(&h), c, "間隔到十分鐘就不再變長，也沒有變短");
    assert_eq!(forwards(&h, &uid(1)), 1);
    set_ack(&h, 0);
    h.core.tick(now + 600_000).await;
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    let c = ack_calls(&h);
    h.core.tick(now + 1_200_000).await;
    assert_eq!(ack_calls(&h), c, "清空後不再打");
}

#[tokio::test]
async fn 待補清單有上限_超過丟最舊的並記_log_被丟的信會再轉交一次但不會漏() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    forward_ack_fails(&mut h, 1, json!({"expects_reply": false}), T0).await;
    let more: Vec<String> = (2..=501).map(uid).collect();
    h.core.test_note_ack_failed(&more);
    assert_eq!(h.core.test_ack_retry().len(), 500);
    assert!(!h.core.test_ack_retry().contains(&uid(1)), "丟最舊的");
    assert!(h.core.log.has("ack retry list full"));
    h.core.pull("test", T0 + 10).await;
    assert_eq!(forwards(&h, &uid(1)), 2, "被丟的信還在信箱，再轉交一次");
}

#[tokio::test]
async fn 重開後清單讀回來_不再轉交_下一個_tick_就補() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    forward_ack_fails(&mut h, 1, json!({"expects_reply": false}), T0).await;
    let now = T0 + 1000;
    restart_with_known(&mut h, &[], now).await;
    assert_eq!(h.core.test_ack_retry(), [uid(1)]);
    h.core.pull("test", now).await;
    assert_eq!(forwards(&h, &uid(1)), 1, "重開後不再轉交");
    set_ack(&h, 0);
    h.core.tick(now + 1).await;
    assert_eq!(h.fr.acked(), vec![uid(1)]);
}

#[tokio::test]
async fn 清單不見時_要回信的信拉到就補_ack_不用回的信再轉交一次() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    forward_ack_fails(&mut h, 1, json!({"expects_reply": true}), T0).await;
    h.core.test_forget_ack_retry();
    set_ack(&h, 0);
    h.core.pull("test", T0 + 10).await;
    assert_eq!(forwards(&h, &uid(1)), 1, "還在 pending，不再轉交");
    assert_eq!(h.fr.acked(), vec![uid(1)], "拉到就補 ack");

    let mut h = harness(&[("T-乙", "idle")]).await;
    forward_ack_fails(&mut h, 2, json!({"expects_reply": false}), T0).await;
    h.core.test_forget_ack_retry();
    set_ack(&h, 0);
    h.core.pull("test", T0 + 10).await;
    assert_eq!(forwards(&h, &uid(2)), 2, "不在 pending：多一封，不會漏");
}
