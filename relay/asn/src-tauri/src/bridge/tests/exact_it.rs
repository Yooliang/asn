//! 轉交內容和原信逐字相同（ASN_FORWARD_EXACT）：hook 把訊息換成橋存的原文，Sent 要有已套用紀錄才算數。
use super::*;
use crate::bridge::forward_gate;
use serde_json::json;

/// 原文替換開著、也強制生效（沒有自我測試的開發機做法）
fn turn_on(h: &mut H, verified: bool) {
    h.core.cfg.forward_exact = true;
    h.core.cfg.forward_exact_unverified = verified;
    h.core.cfg.forward_hook = true;
}

const BODY: &str = "第一行 😀 \t尾端空白  \r\n第二行：\"引號\" \\反斜線 <tag>\n結尾  ";

/// 模擬 worker：模型只拿到佔位行，把它原樣放進 SendMessage；hook（真的跑 run_hook）決定要不要換成原文；工具成功、輸出 SENT
async fn worker_exact(h: &mut H, id: &str, run_hook: bool, now: u64) -> Option<String> {
    let (to, _) = h.core.fwd_probe(id).unwrap();
    let placeholder = forward_gate::placeholder_line(id);
    let mut sent_body = None;
    if run_hook {
        let input = json!({"tool_name": "SendMessage", "tool_input": {"to": to, "message": placeholder, "summary": "轉交 relay 來信"}}).to_string();
        let (out, _) = forward_gate::run_hook(h.work.path(), &input);
        let v: serde_json::Value = serde_json::from_str(&out.expect("hook 有輸出")).unwrap();
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "allow");
        sent_body = v["hookSpecificOutput"]["updatedInput"]["message"].as_str().map(String::from);
    }
    for l in ok_send_lines(&format!("toolu_{id}"), &to, &placeholder) {
        h.core.on_worker_line(l, now).await;
    }
    h.core.on_worker_line(res(&format!("SENT {id}")), now).await;
    sent_body
}

#[tokio::test]
async fn 旗標開了但還沒通過自我測試_照舊整封交給_worker_沒有內文檔() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on(&mut h, false);
    h.fr.put(mail(1, json!({"body": BODY})));
    h.core.pull("test", T0).await;
    let said = h.said();
    assert!(said[0].contains("<<<MAIL\n") && said[0].contains("第一行"), "{}", said[0]);
    assert!(!h.work.path().join(forward_gate::BODY_DIR).exists());
}

#[tokio::test]
async fn 強制開啟時_log_明寫未驗證_沒開或沒強制就不寫() {
    let build = |exact: bool, forced: bool| {
        let fr = FakeRelay::start();
        let (work, sessions) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let relay = Arc::new(Relay::new(fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
        let mut c = cfg(work.path(), sessions.path());
        c.forward_exact = exact;
        c.forward_exact_unverified = forced;
        let alive: Arc<dyn Fn(u32) -> bool + Send + Sync> = Arc::new(|p| p < 90_000);
        Core::new(c, relay, Arc::new(FakeSink::default()), NONCE, Arc::new(BridgeLog::new(None)), alive, T0)
    };
    assert!(build(true, true).log.has("未驗證"));
    assert!(!build(true, false).log.has("未驗證"));
    assert!(!build(false, true).log.has("未驗證"));
}

#[tokio::test]
async fn 生效時_worker_只拿到佔位行_hook_換上原文_逐字相同_紀錄對上才_ack() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on(&mut h, true);
    h.fr.put(mail(1, json!({"body": BODY})));
    h.core.pull("test", T0).await;
    let said = h.said();
    assert!(said[0].ends_with(&forward_gate::placeholder_line(&uid(1))), "{}", said[0]);
    assert!(!said[0].contains("第一行") && !said[0].contains("<<<MAIL"), "指令裡沒有內文：{}", said[0]);
    let (_, full) = h.core.fwd_probe(&uid(1)).unwrap();
    assert!(full.contains("第一行 😀"), "橋自己存的是全文");
    assert_eq!(forward_gate::read_body(h.work.path(), &uid(1)).as_deref(), Some(full.as_str()), "內文檔就是橋存的全文");
    let sent = worker_exact(&mut h, &uid(1), true, T0 + 10).await.unwrap();
    assert_eq!(sent, full, "hook 換上的和橋存的逐字元相同（含 CRLF、尾端空白、emoji）");
    assert!(h.fr.acked().contains(&uid(1)), "已套用紀錄對上：算送出");
    assert!(!h.work.path().join(forward_gate::BODY_DIR).join(uid(1)).exists(), "結束後內文檔刪掉");
    assert!(!h.work.path().join(forward_gate::APPLIED_DIR).join(uid(1)).exists());
}

#[tokio::test]
async fn hook_沒換上原文就說送出了_不算轉交成功_重送一次_再不行走轉交失敗() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on(&mut h, true);
    h.fr.put(mail(1, json!({"body": BODY})));
    h.core.pull("test", T0).await;
    worker_exact(&mut h, &uid(1), false, T0 + 10).await;   // hook 沒作用（假成功）
    assert!(!h.fr.acked().contains(&uid(1)), "沒有紀錄：不 ack");
    assert!(h.core.log.has("forward-not-applied id="));
    assert_eq!(h.said().len(), 2, "重送一次");
    worker_exact(&mut h, &uid(1), false, T0 + 20).await;   // 又沒作用
    assert!(notice_bodies(&h).iter().any(|b| b.contains("轉交給 T-乙 失敗")), "第二次還是不行：走轉交失敗通知 {:?}", notice_bodies(&h));
    assert!(h.fr.acked().contains(&uid(1)), "失敗通知送出後才 ack");
}

#[tokio::test]
async fn 內文檔被改過或讀不到_hook_擋下_不寫已套用紀錄() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on(&mut h, true);
    h.fr.put(mail(1, json!({"body": BODY})));
    h.core.pull("test", T0).await;
    let input = json!({"tool_name": "SendMessage", "tool_input": {"to": "T-乙", "message": forward_gate::placeholder_line(&uid(1)), "summary": "s"}}).to_string();
    std::fs::write(h.work.path().join(forward_gate::BODY_DIR).join(uid(1)), "被改過的內文").unwrap();
    let (out, log) = forward_gate::run_hook(h.work.path(), &input);
    let v: serde_json::Value = serde_json::from_str(&out.unwrap()).unwrap();
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
    assert!(log.contains("body hash mismatch") && !log.contains("被改過"), "{log}");
    assert!(forward_gate::read_applied(h.work.path(), &uid(1)).is_none());
    std::fs::remove_file(h.work.path().join(forward_gate::BODY_DIR).join(uid(1))).unwrap();
    let (out, log) = forward_gate::run_hook(h.work.path(), &input);
    assert!(out.unwrap().contains("deny") && log.contains("body file unreadable"), "{log}");
    // 收件人不對：照舊擋
    let bad = json!({"tool_name": "SendMessage", "tool_input": {"to": "T-別人", "message": forward_gate::placeholder_line(&uid(1))}}).to_string();
    assert!(forward_gate::run_hook(h.work.path(), &bad).0.unwrap().contains("收件人應為 T-乙"));
}

#[tokio::test]
async fn 沒有裝_hook_不能走原文替換_整封照舊交給_worker() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on(&mut h, true);
    h.core.cfg.forward_hook = false;   // 找不到 asn-cli：worker 沒有 hook
    h.fr.put(mail(1, json!({"body": BODY})));
    h.core.pull("test", T0).await;
    assert!(h.said()[0].contains("<<<MAIL
"), "{}", h.said()[0]);
    assert!(!h.work.path().join(forward_gate::BODY_DIR).exists());
}

#[tokio::test]
async fn 重送時上一次的已套用紀錄作廢_hook_失效不會讀到舊紀錄而假成功() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on(&mut h, true);
    h.fr.put(mail(1, json!({"body": BODY})));
    h.core.pull("test", T0).await;
    worker_exact(&mut h, &uid(1), true, T0 + 10).await;   // 第一次：hook 寫了紀錄，但假設工具結果沒回來
    // 手動放回一份同編號的舊紀錄，再模擬重送
    forward_gate::write_applied(h.work.path(), &uid(1), "舊紀錄").unwrap();
    h.core.test_register_forward(&uid(1), "T-乙", "新的全文");
    assert!(forward_gate::read_applied(h.work.path(), &uid(1)).is_none(), "重新登記就清掉舊紀錄");
}

#[test]
fn 提示文字_旗標開著含_a2_沒開和以前完全一樣() {
    let on = crate::bridge::worker::forward_prompt("T-收發室", NONCE, true);
    let off = crate::bridge::worker::forward_prompt("T-收發室", NONCE, false);
    assert!(on.contains("(A2)") && on.contains("[ASN 轉交未帶入內文]"));
    assert!(!off.contains("(A2)"));
    assert_eq!(off, crate::bridge::worker::system_prompt("T-收發室", NONCE));
    assert!(on.find("(A2)").unwrap() < on.find("(B) 其他 session").unwrap(), "A2 在 B 之前");
}

#[tokio::test]
async fn 轉交逾時沒走到_sent_內文檔與核對紀錄也清掉_不留到重開() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on(&mut h, true);
    h.fr.put(mail(1, json!({"body": BODY})));
    h.core.pull("test", T0).await;
    assert!(h.work.path().join(forward_gate::BODY_DIR).join(uid(1)).exists());
    h.core.tick(T0 + 300_000).await;   // worker 一直沒回：轉交逾時
    assert!(notice_bodies(&h).iter().any(|b| b.contains("轉交") ), "逾時有通知：{:?}", notice_bodies(&h));
    assert!(!h.work.path().join(forward_gate::BODY_DIR).join(uid(1)).exists(), "內文檔清掉");
    assert!(h.core.exact_ids_empty(), "核對表也清掉");
}

// ───────── 啟動自我測試（#780 第二段）：結果決定原文替換生不生效 ─────────

use crate::bridge::forward_selftest::Outcome;
use std::sync::atomic::{AtomicU32, Ordering};

/// 跑一輪 tick：沒在跑就開始跑，等背景工作交回結果、再 tick 一次把結果收下
async fn selftest_round(h: &mut H, now: u64) {
    h.core.tick(now).await;
    for _ in 0..400 {
        if !h.core.test_selftest_busy() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        h.core.tick(now).await;
    }
}

fn fake(outs: Vec<Outcome>) -> (Arc<AtomicU32>, impl Fn(&str, &std::path::Path) -> (Option<String>, Outcome) + Send + Sync + 'static) {
    let n = Arc::new(AtomicU32::new(0));
    let n2 = n.clone();
    (n, move |_: &str, _: &std::path::Path| {
        let i = n2.fetch_add(1, Ordering::SeqCst) as usize;
        (Some("9.9.9".to_string()), outs[i.min(outs.len() - 1)].clone())
    })
}

fn turn_on_selftest(h: &mut H) {
    h.core.cfg.forward_exact = true;
    h.core.cfg.forward_exact_unverified = false;
    h.core.cfg.forward_hook = true;
}

#[tokio::test]
async fn 自我測試通過_原文替換才生效_log_寫明() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on_selftest(&mut h);
    let (n, f) = fake(vec![Outcome::Passed("frame=x".into())]);
    h.core.test_set_selftest(f);
    assert!(!h.core.test_exact_active(), "還沒測過不生效");
    selftest_round(&mut h, T0).await;
    assert!(h.core.test_exact_active());
    assert_eq!(n.load(Ordering::SeqCst), 1);
    assert!(h.core.log.has("selftest passed claude=9.9.9"));
}

#[tokio::test]
async fn 自我測試沒過或測不了_轉交走舊辦法_一小時內不重測_隔了再測() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on_selftest(&mut h);
    let (n, f) = fake(vec![Outcome::Failed("內容不同".into()), Outcome::Unrun("起不來".into()), Outcome::Passed("ok".into())]);
    h.core.test_set_selftest(f);
    selftest_round(&mut h, T0).await;
    assert!(!h.core.test_exact_active() && h.core.log.has("selftest FAILED") && h.core.log.has("內容不同"));
    selftest_round(&mut h, T0 + 1_800_000).await;
    assert_eq!(n.load(Ordering::SeqCst), 1, "一小時內不重測");
    selftest_round(&mut h, T0 + 3_600_000).await;
    assert!(!h.core.test_exact_active() && h.core.log.has("selftest 未驗") && h.core.log.has("起不來"));
    selftest_round(&mut h, T0 + 7_200_000).await;
    assert!(h.core.test_exact_active(), "之後通過就生效");
    assert_eq!(n.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn 通過後每小時重看一次_換版沒過就退回舊辦法() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    turn_on_selftest(&mut h);
    let (n, f) = fake(vec![Outcome::Passed("ok".into()), Outcome::Failed("新版內容不同".into())]);
    h.core.test_set_selftest(f);
    selftest_round(&mut h, T0).await;
    assert!(h.core.test_exact_active());
    selftest_round(&mut h, T0 + 600_000).await;
    assert_eq!(n.load(Ordering::SeqCst), 1);
    selftest_round(&mut h, T0 + 3_600_000).await;
    assert!(!h.core.test_exact_active(), "換版沒過，不再生效");
    assert!(h.core.log.has("新版內容不同"));
}

#[tokio::test]
async fn 沒開旗標_沒有_hook_或開發機強制生效_都不跑自我測試() {
    for (exact, hook, forced) in [(false, true, false), (true, false, false), (true, true, true)] {
        let mut h = harness(&[("T-乙", "idle")]).await;
        h.core.cfg.forward_exact = exact;
        h.core.cfg.forward_hook = hook;
        h.core.cfg.forward_exact_unverified = forced;
        let (n, f) = fake(vec![Outcome::Passed("ok".into())]);
        h.core.test_set_selftest(f);
        selftest_round(&mut h, T0).await;
        assert_eq!(n.load(Ordering::SeqCst), 0, "{exact} {hook} {forced}");
    }
}
