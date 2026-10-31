//! 同名兩個視窗（#584）：橋不交給收發員、跟寄件人講清楚、信留著等剩一個時自動重送；本人按「關掉」只關那一個。
use super::*;

/// rig 的 T-乙（5000，sid-b）之外，再用 /resume 接同一段對話開一個同名視窗 5010
async fn dup_rig() -> H {
    let mut h = rig(10_000).await;
    std::fs::write(h.sessions.path().join("5010.json"), json!({"pid": 5010, "sessionId": "sid-b", "name": "T-乙", "cwd": "D:\\x", "status": "idle", "kind": "interactive", "entrypoint": "cli", "updatedAt": 300}).to_string()).unwrap();
    // 同名的殘檔（程序已不在）不算數
    std::fs::write(h.sessions.path().join("99999.json"), json!({"pid": 99999, "sessionId": "sid-b", "name": "T-丙", "cwd": "D:\\x", "status": "idle", "kind": "interactive", "entrypoint": "cli", "updatedAt": 300}).to_string()).unwrap();
    h.core.refresh_roster(T0).await;
    h
}

fn bodies(h: &H, id: &str) -> Vec<String> {
    replies(h, id).iter().map(|r| r["body"].as_str().unwrap_or("").to_string()).collect()
}

#[tokio::test]
async fn 同名兩個_不轉交_說明一次_信留著_剩一個時自動重送() {
    let mut h = dup_rig().await;
    h.fr.put(owner(1, "幫我看一下", "T-乙"));
    h.core.pull("test", T0).await;
    assert!(h.said().is_empty(), "不交給收發員：{:?}", h.said());
    let b = bodies(&h, &uid(1));
    assert_eq!(b.len(), 1, "{b:?}");
    assert!(b[0].starts_with("「T-乙」同一段對話開了兩個視窗"), "{}", b[0]);
    assert!(b[0].ends_with("〔重複視窗 1=5000 2=5010〕"), "本人寄的附按鈕記號：{}", b[0]);
    assert_eq!(replies(&h, &uid(1))[0]["from_agent"], "T-乙", "用對方視窗的名義回，出現在同一個對話裡");
    assert!(h.fr.acked().is_empty(), "信留在信箱");
    // 再拉：不重複說明、仍不轉交
    h.core.pull("test", T0 + 60_000).await;
    assert_eq!(bodies(&h, &uid(1)).len(), 1);
    assert!(h.said().is_empty());
    // 使用者關掉其中一個：名單剩一個，下一輪自動照常轉交
    std::fs::remove_file(h.sessions.path().join("5010.json")).unwrap();
    h.core.refresh_roster(T0 + 120_000).await;
    h.core.pull("test", T0 + 120_000).await;
    assert!(h.said().iter().any(|t| t.contains("幫我看一下")), "自動重送：{:?}", h.said());
    assert!(h.core.log.has("only one window now"));
}

#[tokio::test]
async fn ai_寄來的_說明不附按鈕_殘檔不算同名() {
    let mut h = dup_rig().await;
    h.fr.put(mail(2, json!({})));
    h.fr.put(mail(3, json!({"to_agent": "T-丙"})));
    h.core.pull("test", T0).await;
    let b = bodies(&h, &uid(2));
    assert!(b.len() == 1 && !b[0].contains("〔重複視窗") && b[0].contains("請這台電腦的主人"), "{b:?}");
    assert!(h.said().iter().any(|t| t.contains("內文-3")), "T-丙 只有一個活的視窗，照常轉交：{:?}", h.said());
}

#[tokio::test]
async fn 等太久還是兩個_說明沒送出_ack() {
    let mut h = dup_rig().await;
    h.fr.put(owner(1, "幫我看一下", "T-乙"));
    h.core.pull("test", T0).await;
    h.core.pull("test", T0 + crate::bridge::dup_session::HOLD_MAX_MS).await;
    assert!(h.fr.acked().contains(&uid(1)));
    let b = bodies(&h, &uid(1));
    assert!(b.len() == 2 && b[1].contains("沒送出，請關掉一個後再寄一次"), "{b:?}");
    assert!(h.said().is_empty());
}

#[tokio::test]
async fn 本人按關掉_交給背景關_做完回信並_ack_不當文字投遞() {
    let mut h = dup_rig().await;
    h.fr.put(owner(4, "/asn-close-dup 5010", "T-乙"));
    h.core.pull("test", T0).await;
    assert!(h.said().is_empty(), "{:?}", h.said());
    assert!(until(|| h.fr.acked().contains(&uid(4))).await, "做完 ack");
    let b = bodies(&h, &uid(4));
    // 測試的作業系統不結束程序：回報沒關掉與原因
    assert!(b.len() == 1 && b[0].starts_with("沒關掉"), "{b:?}");
    assert_eq!(replies(&h, &uid(4))[0]["from_agent"], "T-乙");
    assert!(h.core.log.has("close duplicate window pid=5010"));
}

#[tokio::test]
async fn 關掉指令_不是本人簽章或參數不對_不關() {
    let mut h = dup_rig().await;
    // 不是本人：當普通信，但收件名仍有兩個視窗，所以只拿到說明
    h.fr.put(mail(5, json!({"body": "/asn-close-dup 5010"})));
    h.fr.put(owner(6, "/asn-close-dup abc", "T-乙"));
    h.core.pull("test", T0).await;
    assert!(!h.core.log.has("close duplicate window"));
    assert!(bodies(&h, &uid(5))[0].contains("開了兩個視窗"));
    assert_eq!(bodies(&h, &uid(6)), vec!["沒關掉：不知道要關哪一個".to_string()]);
    assert!(h.fr.acked().contains(&uid(6)) && !h.fr.acked().contains(&uid(5)));
}
