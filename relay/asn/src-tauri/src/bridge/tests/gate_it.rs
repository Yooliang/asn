//! 核對轉交對象的整合測試：inflight 檔、hook 判斷、送錯時的重送／Fail／通知／更正。假後端、假 worker，不連真實服務。
use super::*;
use super::rooms_launch::{room, rmsg, set_rooms};
use crate::bridge::forward_gate::{self, Verdict};

/// 假 worker 把這個編號的訊息（原樣）呼叫 SendMessage 送給 actual，工具結果成功，然後這一輪結束
async fn send_to(core: &mut Core, id: &str, actual: &str, tid: &str, now: u64) {
    let (_, text) = core.fwd_probe(id).unwrap_or_else(|| panic!("橋沒有送過編號 {id}"));
    for l in ok_send_lines(tid, actual, &text) {
        core.on_worker_line(l, now).await;
    }
    core.on_worker_line(res(""), now).await;
}

fn forwards_of(said: &[String], id: &str) -> Vec<String> {
    said.iter().filter(|t| t.starts_with("[BRIDGE-FORWARD") && t.lines().next().unwrap().contains(&format!("id={id} "))).cloned().collect()
}

fn notice_to_sender(h: &H) -> Vec<String> {
    h.fr.sent().iter().filter_map(|s| s["body"].as_str()).filter(|b| b.contains("可能已被讀取")).map(String::from).collect()
}

fn held_line(recipient: &str) -> WorkerLine {
    WorkerLine::Line(json!({"type":"system","subtype":"informational","level":"warning","content":format!("Cross-session message held by the receiving session (recipient: @{recipient}). Claude in that session hasn't seen it.")}).to_string())
}

fn held_notices(h: &H) -> Vec<String> {
    h.fr.sent().iter().filter_map(|s| s["body"].as_str()).filter(|b| b.contains("可能卡在")).map(String::from).collect()
}

#[tokio::test]
async fn 對方視窗扣住信_寄件人收到一次_不重送不撤回_別的收件人和太舊的不算() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.put(mail(1, json!({"to_agent": "T-乙"})));
    h.core.pull("test", T0).await;
    send_to(&mut h.core, &uid(1), "T-乙", "toolu_1", T0 + 1).await;
    let said_before = h.said().len();
    // 別的收件人：對不上，不通知
    h.core.on_worker_line(held_line("T-丙"), T0 + 2).await;
    assert!(held_notices(&h).is_empty());
    // 對得上：通知一次，只有固定文字和編號，寄給寄件人
    h.core.on_worker_line(held_line("T-乙"), T0 + 3).await;
    h.core.on_worker_line(held_line("T-乙"), T0 + 4).await;
    let n = held_notices(&h);
    assert_eq!(n.len(), 1, "每封一次：{n:?}");
    assert!(n[0].contains("T-乙") && !n[0].contains(&uid(1)) && !n[0].contains("內文-1"), "通知不放編號和內文：{}", n[0]);
    assert_eq!(h.said().len(), said_before, "不重送");
    // 超過時間窗：不對回舊信
    h.fr.put(mail(2, json!({"to_agent": "T-丙"})));
    h.core.pull("test", T0 + 10).await;
    send_to(&mut h.core, &uid(2), "T-丙", "toolu_2", T0 + 11).await;
    h.core.on_worker_line(held_line("T-丙"), T0 + 11 + 301_000).await;
    assert_eq!(held_notices(&h).len(), 1, "太舊的不算");
    // 後來被拒絕：再通知一次；對方不收也會通知
    h.core.on_worker_line(WorkerLine::Line(json!({"type":"system","subtype":"informational","content":"Cross-session message denied (recipient: @T-乙). The recipient's user declined it; it was not delivered."}).to_string()), T0 + 20).await;
    assert!(h.fr.sent().iter().filter_map(|s| s["body"].as_str()).any(|b| b.contains("可能被對方視窗的使用者拒絕")));
    h.core.on_worker_line(WorkerLine::Line(json!({"type":"system","subtype":"informational","content":"Cross-session message refused (recipient: @T-乙). That session is not accepting cross-session messages; it was not delivered."}).to_string()), T0 + 21).await;
    assert!(h.fr.sent().iter().filter_map(|s| s["body"].as_str()).any(|b| b.contains("不接受其他視窗的信")));
}

#[tokio::test]
async fn 橋送出前先記下編號與目標_hook_讀同一份判斷_相符放行_不符擋下_結束後拿掉() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    let flight = forward_gate::read_inflight(h.work.path()).unwrap();
    assert_eq!(flight.get(&uid(1)).map(|i| i.to.as_str()), Some("T-乙"));
    assert!(flight.get(&uid(1)).unwrap().head.is_some(), "也存了第一行的指紋");
    // worker 實際會呼叫的內容（訊息原樣）：hook 照檔案核對
    let (_, text) = h.core.fwd_probe(&uid(1)).unwrap();
    let call = |to: &str| json!({"tool_name": "SendMessage", "tool_input": {"to": to, "message": text, "recipient": to, "content": text}});
    assert_eq!(forward_gate::check(&call("T-乙"), Some(&flight)).0, Verdict::Allow);
    assert_eq!(forward_gate::check(&call("T-丙"), Some(&flight)).0, Verdict::Deny("收件人應為 T-乙".into()));
    let (out, _) = forward_gate::run_hook(h.work.path(), &call("T-丙").to_string());
    assert!(out.unwrap().contains("收件人應為 T-乙"));
    // 轉交完成後拿掉：同編號再送一律擋
    worker_ok(&mut h.core, &uid(1), T0 + 5).await;
    assert!(forward_gate::read_inflight(h.work.path()).unwrap().is_empty());
    assert!(matches!(forward_gate::check(&call("T-乙"), forward_gate::read_inflight(h.work.path()).as_ref()).0, Verdict::Deny(_)));
}

#[tokio::test]
async fn 橋送的每一則第一行行尾都有自己的編號_提醒_更正_群組都能被_hook_放行() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    worker_ok(&mut h.core, &uid(1), T0 + 5).await;
    // 五分鐘沒回，閒置：收發室提醒（沒有編號的說明也要被補上編號，hook 才放行）
    h.core.tick(T0 + 301_000).await;
    let said = h.said();
    let nudge = said.last().unwrap().clone();
    let body = nudge.split("<<<MAIL\n").nth(1).unwrap().rsplit_once("\nMAIL>>>").unwrap().0.to_string();
    let id = forward_gate::trailing_id(forward_gate::first_line(&body)).expect("提醒的第一行行尾有編號");
    let flight = forward_gate::read_inflight(h.work.path()).unwrap();
    assert_eq!(flight.get(&id).map(|i| i.to.as_str()), Some("T-乙"), "{flight:?} id={id}");
    let c = json!({"tool_name": "SendMessage", "tool_input": {"to": "T-乙", "message": body}});
    assert_eq!(forward_gate::check(&c, Some(&flight)).0, Verdict::Allow);
}

#[tokio::test]
async fn 送錯_不_ack_重送一次給正確的視窗_通知寄件人_固定文字_更正拿錯信的視窗() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.put(mail(1, json!({"body": "機密內文不該出現在通知"})));
    h.core.pull("test", T0).await;
    assert_eq!(h.said().len(), 1);
    send_to(&mut h.core, &uid(1), "T-丙", "toolu_w1", T0 + 10).await;
    assert!(h.fr.acked().is_empty(), "送錯不 ack");
    assert!(h.core.log.has(&format!("misrouted id={} expected=T-乙 actual=T-丙", uid(1))));
    let said = h.said();
    assert_eq!(forwards_of(&said, &uid(1)).len(), 2, "重送一次給正確的視窗");
    assert!(forwards_of(&said, &uid(1))[1].contains("to=T-乙]"));
    assert_eq!(h.core.pending[0].state, State::Forwarding);
    // 寄件人收到固定文字的通知：寫明可能已被讀取，不帶內文
    let n = notice_to_sender(&h);
    assert_eq!(n.len(), 1);
    assert!(n[0].contains("可能已被讀取") && !n[0].contains("機密內文"), "{}", n[0]);
    // 只寫寄件人自己指定的收件人，不寫實際拿到信的視窗名（那可能是這台電腦上別人的）
    assert!(n[0].contains("你寄給 T-乙 的信") && n[0].contains("收發室正在重新轉交給 T-乙") && !n[0].contains("T-丙"), "{}", n[0]);
    let sent = h.fr.sent().into_iter().find(|s| s["body"].as_str().unwrap_or("").contains("可能已被讀取")).unwrap();
    assert_eq!((sent["to_node"].as_str(), sent["expects_reply"].clone()), (Some("W"), json!(false)));
    // 拿錯信的視窗收到更正（有自己的編號，hook 放行）
    let corr = said.iter().find(|t| t.contains("（收發室更正）剛才編號") && t.contains("to=T-丙]")).expect("更正").clone();
    assert!(corr.contains(&format!("剛才編號 {} 那封信不是寄給你的，請不要照做，也不要回覆寄件人。", uid(1))));
    assert!(!corr.contains("機密內文"));
    let body = corr.split("<<<MAIL\n").nth(1).unwrap().rsplit_once("\nMAIL>>>").unwrap().0.to_string();
    let flight = forward_gate::read_inflight(h.work.path()).unwrap();
    let c = json!({"tool_name": "SendMessage", "tool_input": {"to": "T-丙", "message": body}});
    assert_eq!(forward_gate::check(&c, Some(&flight)).0, Verdict::Allow);
    // 重送後 worker 這次送對了：算 Sent，ack
    worker_ok(&mut h.core, &uid(1), T0 + 20).await;
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    assert_eq!(notice_to_sender(&h).len(), 1, "通知只一次");
}

#[tokio::test]
async fn 第二次還是送錯_回_fail_ack_不再重送() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    send_to(&mut h.core, &uid(1), "T-丙", "toolu_w1", T0 + 10).await;
    assert_eq!(forwards_of(&h.said(), &uid(1)).len(), 2);
    send_to(&mut h.core, &uid(1), "T-丙", "toolu_w2", T0 + 20).await;
    assert_eq!(forwards_of(&h.said(), &uid(1)).len(), 2, "不再重送");
    assert_eq!(h.fr.acked(), vec![uid(1)], "Fail：寄回失敗說明並 ack");
    assert!(h.fr.sent().iter().any(|s| s["body"].as_str().unwrap_or("").contains("核對轉交對象失敗")));
    assert!(h.core.pending.is_empty());
    assert_eq!(notice_to_sender(&h).len(), 1, "同一個編號只通知一次");
}

#[tokio::test]
async fn 同一個編號對的錯的呼叫都有_算_sent_照樣通知_不重送() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    let (_, text) = h.core.fwd_probe(&uid(1)).unwrap();
    // 同一輪：先送錯、再送對
    for l in ok_send_lines("toolu_w", "T-丙", &text).into_iter().chain(ok_send_lines("toolu_r", "T-乙", &text)) {
        h.core.on_worker_line(l, T0 + 10).await;
    }
    h.core.on_worker_line(res(""), T0 + 11).await;
    assert_eq!(h.fr.acked(), vec![uid(1)], "有對的呼叫：算 Sent");
    assert_eq!(forwards_of(&h.said(), &uid(1)).len(), 1, "不重送");
    assert_eq!(notice_to_sender(&h).len(), 1, "照樣通知");
    assert!(h.core.log.has("misrouted id="));
}

#[tokio::test]
async fn 只有_sent_文字沒有呼叫佐證_維持轉交中_照原本逾時處理() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    h.core.on_worker_line(res(&format!("SENT {}", uid(1))), T0 + 5).await;
    assert!(h.fr.acked().is_empty());
    assert_eq!(h.core.pending[0].state, State::Forwarding);
    h.core.tick(T0 + 121_000).await;
    assert!(h.fr.sent().iter().any(|s| s["body"].as_str().unwrap_or("").contains("逾時")));
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    // 逾時後編號也從 hook 的檔案拿掉
    assert!(forward_gate::read_inflight(h.work.path()).unwrap().get(&uid(1)).is_none());
}

#[tokio::test]
async fn 送錯也算_worker_有在動_解除額度扣住_但不算轉交() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    let line = WorkerLine::Line(json!({"type":"assistant","message":{"model":"<synthetic>","content":[]},"apiError":"usage_limit_reached"}).to_string());
    h.core.on_worker_line(line, T0 + 1).await;
    assert!(h.core.inbox_hold_until().is_some());
    // 扣住中 Held 的信，只有真的 Sent（有佐證）才當已轉交；送錯不是
    send_to(&mut h.core, &uid(1), "T-丙", "toolu_w", T0 + 2).await;
    assert_eq!(h.core.inbox_hold_until(), None, "worker 有在動");
    assert!(h.fr.acked().is_empty());
}

fn quota_event() -> WorkerLine {
    WorkerLine::Line(json!({"type":"assistant","message":{"model":"<synthetic>","content":[]},"apiError":"usage_limit_reached"}).to_string())
}

#[tokio::test]
async fn 第一行被改過_hook_擋_橋也不算佐證_信維持轉交中() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    let (_, text) = h.core.fwd_probe(&uid(1)).unwrap();
    let altered = text.replacen("trust=", "trust=x", 1);
    let flight = forward_gate::read_inflight(h.work.path());
    let c = json!({"tool_name": "SendMessage", "tool_input": {"to": "T-乙", "message": altered, "recipient": "T-乙", "content": "預覽…"}});
    assert!(matches!(forward_gate::check(&c, flight.as_ref()).0, Verdict::Deny(ref r) if r.contains("抬頭")));
    for l in ok_send_lines("toolu_a", "T-乙", &altered) {
        h.core.on_worker_line(l, T0 + 5).await;
    }
    h.core.on_worker_line(res(""), T0 + 6).await;
    assert!(h.fr.acked().is_empty());
    assert_eq!(h.core.pending[0].state, State::Forwarding);
}

#[tokio::test]
async fn inflight_檔寫不進去_旗標保留_下一個_tick_再試() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    // 檔名被一個資料夾占住：寫入失敗
    std::fs::create_dir(h.work.path().join(forward_gate::INFLIGHT_FILE)).unwrap();
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    assert!(h.core.log.has("inflight file write failed"));
    std::fs::remove_dir(h.work.path().join(forward_gate::INFLIGHT_FILE)).unwrap();
    assert!(forward_gate::read_inflight(h.work.path()).is_none());
    h.core.tick(T0 + 5000).await;
    let flight = forward_gate::read_inflight(h.work.path()).expect("下一個 tick 補寫");
    assert_eq!(flight.get(&uid(1)).map(|i| i.to.as_str()), Some("T-乙"));
}

#[tokio::test]
async fn 額度扣住中的群組訊息_編號留在_inflight_晚到的成功結果仍算_sent_恢復後不再轉交一次() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(T0).await;
    let id = crate::bridge::rooms::room_uuid("R1", 2, "T~T-視窗甲");
    h.core.on_worker_line(quota_event(), T0 + 1000).await;
    assert!(h.core.pending.is_empty(), "已從 pending 移到扣住清單");
    // 下一個 tick 的整理不能把它的編號從 inflight 拿掉
    h.core.tick(T0 + 6000).await;
    assert!(forward_gate::read_inflight(h.work.path()).unwrap().contains_key(&id));
    // 之後才到的成功結果：算 Sent，不會恢復後又轉交一次
    worker_ok(&mut h.core, &id, T0 + 7000).await;
    assert_eq!(h.core.pending.len(), 1);
    h.core.tick(T0 + 8000).await;
    h.core.tick(T0 + 3_700_000).await;
    assert_eq!(h.said().len(), 1, "只轉交一次");
}

#[tokio::test]
async fn 扣住的群組訊息真的放行或放棄後_編號才從_inflight_拿掉() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(T0).await;
    let id = crate::bridge::rooms::room_uuid("R1", 2, "T~T-視窗甲");
    h.core.on_worker_line(quota_event(), T0 + 1000).await;
    h.core.tick(T0 + 6000).await;
    assert!(forward_gate::read_inflight(h.work.path()).unwrap().contains_key(&id));
    // 放棄（清單裡沒有了）：下一個 tick 拿掉
    set_rooms(&h, vec![]);
    for k in 1..=130u64 {
        h.core.on_worker_line(res(&format!("FAIL {} x", uid(900))), T0 + k).await; // worker 有在動，解除扣住
        h.core.tick(T0 + 10_000 + k * 31_000).await;
    }
    assert!(!forward_gate::read_inflight(h.work.path()).unwrap().contains_key(&id));
}

fn owner_requests(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().misroute_notices.clone()
}

#[tokio::test]
async fn 送錯時請後台通知本人一次_只帶信件編號_不帶視窗名與內文() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.put(mail(1, json!({"body": "機密內文不該出現"})));
    h.core.pull("test", T0).await;
    send_to(&mut h.core, &uid(1), "T-丙", "toolu_w1", T0 + 10).await;
    let reqs = owner_requests(&h);
    assert_eq!(reqs, vec![json!({"mail_id": uid(1)})], "只帶信件編號");
    // 第二次送錯（回 Fail）、同一個編號：不再請後台通知
    send_to(&mut h.core, &uid(1), "T-丙", "toolu_w2", T0 + 20).await;
    assert_eq!(owner_requests(&h).len(), 1);
    // 對錯都有的情況也通知（另一封）
    h.fr.put(mail(2, json!({})));
    h.core.pull("test", T0 + 30).await;
    let (_, text) = h.core.fwd_probe(&uid(2)).unwrap();
    for l in ok_send_lines("toolu_a", "T-丙", &text).into_iter().chain(ok_send_lines("toolu_b", "T-乙", &text)) {
        h.core.on_worker_line(l, T0 + 31).await;
    }
    h.core.on_worker_line(res(""), T0 + 32).await;
    assert_eq!(owner_requests(&h).len(), 2);
    assert_eq!(h.fr.acked(), vec![uid(1), uid(2)]);
}

#[tokio::test]
async fn 後台通知失敗_只記_log_重送與寄件人通知照常() {
    let mut h = harness(&[("T-乙", "idle"), ("T-丙", "idle")]).await;
    h.fr.st.lock().unwrap().misroute_status = 404; // 舊後台沒有這個動作
    h.fr.put(mail(1, json!({})));
    h.core.pull("test", T0).await;
    send_to(&mut h.core, &uid(1), "T-丙", "toolu_w1", T0 + 10).await;
    assert!(h.core.log.has("owner notice failed"));
    assert_eq!(forwards_of(&h.said(), &uid(1)).len(), 2, "照常重送一次");
    assert_eq!(notice_to_sender(&h).len(), 1, "寄件人照常通知");
    assert!(h.fr.acked().is_empty());
}

#[tokio::test]
async fn 群組訊息送錯_請後台通知本人_不帶編號() {
    let mut h = harness(&[("T-視窗甲", "idle"), ("T-丙", "idle")]).await;
    let mine = json!([{"member": "T~T-視窗甲", "read_seq": 1}]);
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], mine)]);
    h.core.pull_rooms(T0).await;
    let id = crate::bridge::rooms::room_uuid("R1", 2, "T~T-視窗甲");
    send_to(&mut h.core, &id, "T-丙", "toolu_g1", T0 + 10).await;
    assert_eq!(owner_requests(&h), vec![json!({"mail_id": null})]);
}
