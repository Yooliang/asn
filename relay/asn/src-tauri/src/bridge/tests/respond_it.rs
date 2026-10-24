//! 自動回信模式（Linux 無視窗主機，`asn-bridge run --respond`）的整合測試：本機假後端＋假 worker。
//! 重點：worker 自己當一個可收信的視窗（名單回報、私信、沒指定收件人的信、群組叫醒），回答走既有的 pending／ack／逾時／遲到回覆流程。
use super::*;

const ME: &str = "T-linux";

/// 沒有任何互動視窗、設定了自動回信視窗名的核心
async fn respond_harness() -> H {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let sink = Arc::new(FakeSink::default());
    let mut core = new_core(&fr, work.path(), sessions.path(), sink.clone(), T0);
    core.cfg.respond = Some(ME.into());
    core.cfg.default_agent = String::new(); // 沒設預設成員
    core.refresh_roster(T0).await;
    H { core, fr, sink, work, sessions }
}

/// 轉交指令的（信件編號，收件視窗）
fn heads(said: &[String]) -> Vec<(String, String)> {
    said.iter()
        .map(|t| {
            let head = t.lines().next().unwrap();
            (head.split("id=").nth(1).unwrap().split(' ').next().unwrap().to_string(), head.split("to=").nth(1).unwrap().trim_end_matches(']').to_string())
        })
        .collect()
}

fn rmsg(seq: u64, extra: Value) -> Value {
    let mut m = json!({"seq": seq, "from": "W~W-政策", "from_name": "政策", "trust": "member", "body": format!("群組內文-{seq}"), "mentions": [], "at": "t", "forMe": {}});
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    m
}
fn set_room(h: &H, member: &str, msgs: Vec<Value>) {
    let last = msgs.last().unwrap()["seq"].clone();
    h.fr.st.lock().unwrap().rooms = vec![json!({"id": "R1", "name": "專案群", "last_seq": last, "mine": [{"member": member, "read_seq": 1}], "messages": msgs})];
}
fn posts(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().room_posts.clone()
}
fn me_in(roster_body: &Value) -> Value {
    roster_body["agents"].as_array().unwrap().iter().find(|a| a["name"] == ME).cloned().expect("名單上有自動回信視窗")
}

#[tokio::test]
async fn 名單回報_自動回信視窗以_claude_引擎_idle_出現_同名的別的視窗讓位() {
    let h = respond_harness().await;
    let me = me_in(&h.fr.rosters()[0]);
    assert_eq!((me["engine"].as_str(), me["status"].as_str()), (Some("claude"), Some("idle")));
    assert_eq!(h.core.roster.iter().filter(|w| w.name == ME).count(), 1);
    // 本機剛好有同名的互動式視窗：名字只能對應一個收件者，留自動回信的那個
    put_session(h.sessions.path(), 5000, ME, "busy", 7);
    let mut h = h;
    h.core.refresh_roster(T0 + 1000).await;
    assert_eq!(h.core.roster.iter().filter(|w| w.name == ME).count(), 1);
    assert_eq!(me_in(h.fr.rosters().last().unwrap())["status"], "idle");
    // 沒設自動回信的核心，名單上沒有這個名字
    let plain = harness(&[("T-乙", "idle")]).await;
    assert!(!plain.fr.rosters()[0]["agents"].as_array().unwrap().iter().any(|a| a["name"] == ME));
}

#[tokio::test]
async fn 私信寄給自動回信視窗_交給_worker_即_ack_回答照既有信頭規則寄回_from_以設定為準() {
    let mut h = respond_harness().await;
    h.fr.put(mail(1, json!({"to_agent": ME})));
    h.fr.put(mail(2, json!({"to_agent": ME})));
    h.core.pull("test", T0).await;
    let said = h.said();
    assert_eq!(heads(&said), vec![(uid(1), ME.to_string()), (uid(2), ME.to_string())]);
    assert!(said[0].contains("engine=claude reply=yes"));
    assert!(!said[0].contains("【要回信】") && !said[0].contains("往來記錄在"), "回答由橋代寄：不附 asn_send 指示、不附往來記錄路徑\n{}", said[0]);
    assert!(said[0].contains("內文-1"));
    assert_eq!(h.fr.acked(), vec![uid(1), uid(2)], "交給自己的 worker 就算已轉交，沿用既有的 ack 時機");
    assert!(h.core.pending.iter().all(|p| p.state == State::Waiting));
    // worker 同一輪回答兩封：用回覆抬頭指的編號對應（故意倒著答，from 也寫錯——名字以設定為準）
    let txt = format!(
        "{}\n{}",
        reply_block("亂寫的名字", &format!("[回覆 id={} → 對方]\n第二封的答案", uid(2))),
        reply_block("T-linux", &format!("[回覆 id={} → 對方]\n第一封的答案", uid(1)))
    );
    h.core.on_worker_line(res(&txt), T0 + 50).await;
    let s = h.fr.sent();
    assert_eq!(s.len(), 2);
    for (i, body, re) in [(0, "第二封的答案", uid(2)), (1, "第一封的答案", uid(1))] {
        assert_eq!((s[i]["body"].as_str(), s[i]["reply_to"].as_str(), s[i]["to_node"].as_str(), s[i]["to_agent"].as_str(), s[i]["from_agent"].as_str()), (Some(body), Some(re.as_str()), Some("W"), Some("W-政策"), Some(ME)));
    }
}

#[tokio::test]
async fn 沒指定收件人的信_沒設預設成員就交給自動回信視窗_不留給本人() {
    let mut h = respond_harness().await;
    h.fr.put(mail(3, json!({"to_agent": null})));
    h.core.pull("test", T0).await;
    let said = h.said();
    assert_eq!(heads(&said), vec![(uid(3), ME.to_string())]);
    assert!(said[0].contains("[收發室] 這封信沒有指定收件視窗，依設定交給你（T-linux）處理。"));
    assert_eq!(h.fr.acked(), vec![uid(3)]);
    assert!(h.core.relay.unaddressed_ids().is_empty(), "沒有留給本人");
    // 有設預設成員（bridge.json）而且在線時，仍以設定為準
    let fr = FakeRelay::start();
    let (work, sessions, data) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    put_session(sessions.path(), 5001, "T-丙", "idle", 9);
    super::super::write_settings(data.path(), super::super::BridgeSettings { unaddressed_to: "T-丙".into(), ..Default::default() }).unwrap();
    let sink = Arc::new(FakeSink::default());
    let mut core = new_core(&fr, work.path(), sessions.path(), sink.clone(), T0);
    core.cfg.respond = Some(ME.into());
    core.cfg.data_dir = Some(data.path().to_path_buf());
    core.refresh_roster(T0).await;
    fr.put(mail(4, json!({"to_agent": null})));
    core.pull("test", T0).await;
    assert!(sink.said.lock().unwrap()[0].contains("to=T-丙]"));
}

#[tokio::test]
async fn 不要回覆的信_照做但不寄回覆_其他視窗名照舊找不到() {
    let mut h = respond_harness().await;
    h.fr.put(mail(5, json!({"to_agent": ME, "expects_reply": false, "body": "只是告知"})));
    h.core.pull("test", T0).await;
    assert_eq!(h.fr.acked(), vec![uid(5)]);
    assert!(h.core.pending.is_empty(), "告知類信不計時");
    h.core.on_worker_line(res(&reply_block(ME, "收到")), T0 + 10).await;
    assert!(h.fr.sent().is_empty(), "沒人在等的回答不寄出");
    // 寄給不存在的視窗：照舊回找不到
    h.fr.put(mail(6, json!({"to_agent": "T-不存在"})));
    h.core.pull("test", T0 + 20).await;
    assert_eq!(h.fr.sent().len(), 1);
    assert!(h.fr.sent()[0]["body"].as_str().unwrap().contains("找不到名叫「T-不存在」"));
}

#[tokio::test]
async fn 群組叫醒_節點成員與視窗成員都交給它_回覆貼回群組_不需回覆標記不貼() {
    let mut h = respond_harness().await;
    // 視窗成員被叫醒
    set_room(&h, "T~T-linux", vec![rmsg(2, json!({"forMe": {ME: true}})), rmsg(3, json!({"forMe": {ME: true}}))]);
    h.core.pull("test", T0).await;
    let said = h.said();
    let hs = heads(&said);
    assert_eq!(hs.len(), 2);
    assert!(hs.iter().all(|(_, to)| to == ME));
    assert_eq!(hs[0].0, crate::bridge::rooms::room_uuid("R1", 2, "T~T-linux"));
    assert!(said[0].contains("[群組 專案群] trust=member from=W/W-政策 #2"));
    assert!(h.fr.acked().is_empty(), "群組沒有信箱可 ack");
    assert!(h.core.pending.iter().all(|p| p.state == State::Waiting && p.room.is_some()), "已轉交、等回覆");
    let txt = format!(
        "{}\n{}",
        reply_block(ME, &format!("[回覆 id={} → 對方]\n我來回答", hs[0].0)),
        reply_block(ME, &format!("[回覆 id={} → 對方]\n（不需回覆）", hs[1].0))
    );
    h.core.on_worker_line(res(&txt), T0 + 30).await;
    let p = posts(&h);
    assert_eq!(p.len(), 1, "標了不需回覆的不貼");
    assert_eq!((p[0]["room"].as_str(), p[0]["body"].as_str(), p[0]["from_agent"].as_str()), (Some("R1"), Some("我來回答"), Some(ME)));
    assert!(h.fr.sent().is_empty(), "群組回覆不走一般寄信");
    // 節點本身（沒有視窗）的成員被叫醒：沒設預設成員就是自動回信視窗，回覆以節點發言
    let mut g = respond_harness().await;
    set_room(&g, "T", vec![rmsg(2, json!({"forMe": {"": true}}))]);
    g.core.pull("test", T0).await;
    assert_eq!(heads(&g.said())[0].1, ME);
    let id = heads(&g.said())[0].0.clone();
    g.core.on_worker_line(res(&reply_block(ME, &format!("[回覆 id={id} → 對方]\n節點身分回答"))), T0 + 30).await;
    let p = posts(&g);
    assert_eq!(p.len(), 1);
    assert!(p[0]["from_agent"].is_null(), "節點成員不帶 from_agent");
}

#[tokio::test]
async fn 群組_暫不通知與順位延遲照舊遵守() {
    let mut h = respond_harness().await;
    set_room(
        &h,
        "T~T-linux",
        vec![
            rmsg(2, json!({"forMe": {ME: true}, "wake": {"rank": 1, "total": 1, "before": [], "hold": true}})),
            rmsg(3, json!({"forMe": {ME: true}, "wake": {"rank": 2, "total": 2, "before": ["正見（阿明）"]}})),
        ],
    );
    h.core.pull("test", T0).await;
    assert!(h.said().is_empty(), "#2 被標暫不通知、#3 是第二順位要先等");
    h.core.tick(T0 + 59_000).await;
    assert!(h.said().is_empty());
    h.core.tick(T0 + 60_000).await;
    let hs = heads(&h.said());
    assert_eq!(hs, vec![(crate::bridge::rooms::room_uuid("R1", 3, "T~T-linux"), ME.to_string())]);
    assert!(h.said()[0].contains("順位：你是第 2 順位"));
}

#[tokio::test]
async fn 忙碌閒置_交辦時回報_busy_答完回報_idle_不插話提醒自己() {
    let mut h = respond_harness().await;
    h.fr.put(mail(1, json!({"to_agent": ME})));
    h.core.pull("test", T0).await;
    h.core.tick(T0 + 2_000).await; // 超過防抖間隔：狀態變了就立刻重報
    let rs = h.fr.rosters();
    assert_eq!(me_in(rs.last().unwrap())["status"], "busy", "worker 處理中");
    let n = rs.len();
    h.core.tick(T0 + 2_500).await;
    assert_eq!(h.fr.rosters().len(), n, "狀態沒變不重報");
    // 答完（這一輪結束）：idle
    h.core.on_worker_line(res(&reply_block(ME, &format!("[回覆 id={} → 對方]\n好了", uid(1)))), T0 + 3_000).await;
    h.core.tick(T0 + 5_000).await;
    assert_eq!(me_in(h.fr.rosters().last().unwrap())["status"], "idle");
    // 不會叫自己「還沒回覆」：五分鐘沒回也不提醒（提醒是插話給視窗，這個視窗就是 worker 自己）
    h.fr.put(mail(2, json!({"to_agent": ME})));
    h.core.pull("test", T0 + 10_000).await;
    h.core.on_worker_line(res("（worker 這一輪沒有輸出回答區塊）"), T0 + 11_000).await; // 輪結束但沒答：信還在等
    h.core.tick(T0 + 10_000 + 400_000).await;
    assert_eq!(h.said().len(), 2, "只有兩封信本身，沒有提醒");
    assert_eq!(h.core.pending.iter().filter(|p| !p.replied).count(), 1, "第二封確實還在等回覆（提醒條件成立，是自動回信不提醒）");
    assert!(!h.core.log.has("nudged window"));
}

#[tokio::test]
async fn 逾時與遲到回覆_沿用既有流程() {
    let mut h = respond_harness().await;
    h.fr.put(mail(1, json!({"to_agent": ME})));
    h.core.pull("test", T0).await;
    h.core.tick(T0 + 700_000).await; // 超過 10 分鐘還沒回
    assert_eq!(h.core.pending[0].state, State::Notified);
    assert!(h.fr.sent().is_empty(), "逾時不通知寄件人");
    h.core.on_worker_line(res(&reply_block(ME, &format!("[回覆 id={} → 對方]\n遲到的答案", uid(1)))), T0 + 800_000).await;
    let s = h.fr.sent();
    assert_eq!((s.len(), s[0]["body"].as_str(), s[0]["reply_to"].as_str()), (1, Some("遲到的答案"), Some(uid(1).as_str())));
    assert!(h.core.pending.is_empty(), "遲到回覆寄回後清掉");
}

#[tokio::test]
async fn worker_沒起來_信留在信箱_不_ack_不卡在忙碌() {
    let mut h = respond_harness().await;
    h.sink.down.store(true, Ordering::SeqCst);
    h.fr.put(mail(1, json!({"to_agent": ME})));
    h.core.pull("test", T0).await;
    assert!(h.fr.acked().is_empty() && h.core.pending.is_empty());
    h.core.tick(T0 + 2_000).await;
    assert_eq!(me_in(h.fr.rosters().last().unwrap())["status"], "idle", "交不出去不算忙碌");
}
