//! #2475：名字互蓋。正本是 Claude 的 sessions 檔（對話實際的名字），其餘都是副本，只能經 `relabel_partner` 對齊。
//! 這裡驗每一輪重掃正本之後的比對：視窗內自己改、信件改名、同視窗換對話、讀不到、撞名／互換，以及以名字為鍵的各張表。
//! 出口 `relabel_partner` 換成會記錄的假函式，不碰真的終端。
use super::*;
use std::collections::HashMap;

type Calls = Arc<Mutex<Vec<(String, String)>>>;
type Created = Arc<Mutex<HashMap<u32, u64>>>;

struct Rig {
    h: H,
    calls: Calls,
    created: Created,
}

const SID_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SID_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/// (程序編號, 名字, 對話編號)；每個程序的建立時間預設 1000＋編號，出口記在 calls
async fn rig(windows: &[(u32, &str, &str)]) -> Rig {
    let fr = FakeRelay::start();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    for (pid, name, sid) in windows {
        put_session_with_id(sessions.path(), *pid, name, sid);
    }
    let sink = Arc::new(FakeSink::default());
    let mut core = new_core(&fr, work.path(), sessions.path(), sink.clone(), T0);
    let created: Created = Arc::new(Mutex::new(windows.iter().map(|(p, _, _)| (*p, 1000 + *p as u64)).collect()));
    let c2 = created.clone();
    core.set_created(Arc::new(move |p| c2.lock().unwrap().get(&p).copied()));
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let c3 = calls.clone();
    core.set_relabel(Arc::new(move |o, n| {
        c3.lock().unwrap().push((o.to_string(), n.to_string()));
        1
    }));
    core.refresh_roster(T0).await;
    Rig { h: H { core, fr, sink, work, sessions }, calls, created }
}

impl Rig {
    fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
    /// 視窗內自己 /rename、或信件下 /rename 經外掛執行成功：結果都是 Claude 把 sessions 檔的名字改掉
    fn rename_in_file(&self, pid: u32, name: &str, sid: &str) {
        put_session_with_id(self.h.sessions.path(), pid, name, sid);
    }
    fn told(&self) -> Vec<String> {
        self.h.said().into_iter().filter(|t| t.contains("你的名字改成")).collect()
    }
}

fn pair(a: &str, b: &str) -> (String, String) {
    (a.to_string(), b.to_string())
}

/// 視窗內自己改：sessions 先「甲」跑一輪、改「乙」再跑一輪 → 出口被呼叫（甲→乙）；known 無甲有乙、事實保留；
/// 以名字為鍵的記憶體表照決定搬或清（逐張寫在 core/rename.rs 的 move_name_tables）
#[tokio::test]
async fn _2475_視窗內自己改名_下一輪名單出口被呼叫_known_搬到新名_各表搬或清() {
    let mut r = rig(&[(5000, "T-甲", SID_A)]).await;
    let before = r.h.core.known_entry("T-甲").expect("第一輪已記下這個視窗");
    assert_eq!(before.facts.session, SID_A);
    r.h.core.refresh_roster(T0 + 500).await;
    assert!(r.calls().is_empty(), "名字沒變：不動");
    // 在各張以名字為鍵的表裡都種一筆舊名（要在改名那一輪之前種，不然名單更新自己的清理會先把它們清掉）
    r.h.core.plant_name_tables("T-甲", T0);
    r.rename_in_file(5000, "T-乙", SID_A);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert_eq!(r.calls(), vec![pair("T-甲", "T-乙")], "出口被呼叫一次（舊名→新名）");
    assert!(r.h.core.known_entry("T-甲").is_none(), "known 沒有舊名");
    let moved = r.h.core.known_entry("T-乙").expect("known 有新名");
    assert_eq!((moved.facts.session.as_str(), moved.facts.cwd.as_str()), (SID_A, "D:\\x"), "對話編號與資料夾等事實保留");
    assert!(moved.facts.asn_opened, "搬過來的是同一個程序，查過的『ASN 開的』不重查：{moved:?}");
    let t = r.h.core.name_tables();
    // 搬（舊名沒有、新名有）
    assert_eq!(t.known, ["T-乙"]);
    assert_eq!(t.seen_run, ["T-乙"]);
    assert_eq!(t.probed, ["T-乙"]);
    assert_eq!(t.active, ["T-乙"]);
    assert_eq!(t.last_requester, ["T-乙"]);
    assert_eq!(t.pending_targets, ["T-乙:Waiting", "T-甲:Forwarding"], "等回覆的信改收件名；轉交中的不動");
    // 清（舊名沒有、新名也沒有）
    assert!(t.missing.is_empty() && t.awaiting.is_empty(), "{t:?}");
    assert!(t.mux_pending.is_empty() && t.mux_lost.is_empty() && t.mux_exited.is_empty(), "{t:?}");
    assert!(t.partners.is_empty(), "{t:?}");
    // 之後名字不變：不再呼叫
    r.h.core.refresh_roster(T0 + 2_000).await;
    assert_eq!(r.calls().len(), 1);
}

/// 信件改名：本人用信件下 /rename（外掛執行成功）之後，Claude 的 sessions 檔名字變了；ASN 沒有第二份邏輯，下一輪名單就對齊
#[tokio::test]
async fn _2475_信件改名_命令成功後跑一輪名單_出口被呼叫_known_跟著搬() {
    let mut r = rig(&[(5000, "T-甲", SID_A), (5001, "T-丙", SID_B)]).await;
    r.rename_in_file(5000, "T-乙", SID_A);
    r.h.core.pull("test", T0 + 500).await;
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert_eq!(r.calls(), vec![pair("T-甲", "T-乙")]);
    assert!(r.h.core.known_entry("T-甲").is_none());
    assert_eq!(r.h.core.known_entry("T-乙").unwrap().facts.session, SID_A);
    assert!(r.h.core.known_entry("T-丙").is_some(), "別的視窗不受影響");
}

/// 條件 1：同一個視窗（程序編號與建立時間相同）換了對話——名字也變了就當成改名；名字沒變就不動
#[tokio::test]
async fn _2475_條件1_同視窗換對話_名字變了算改名_名字沒變不動() {
    let mut r = rig(&[(5000, "T-甲", SID_A)]).await;
    r.rename_in_file(5000, "T-甲", SID_B);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert!(r.calls().is_empty(), "換對話、名字沒變：不動");
    assert_eq!(r.h.core.known_entry("T-甲").unwrap().facts.session, SID_B, "對話編號由 known 的事實每輪重記");
    r.rename_in_file(5000, "T-乙", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    r.h.core.refresh_roster(T0 + 2_000).await;
    assert_eq!(r.calls(), vec![pair("T-甲", "T-乙")], "換對話又換名字：當成改名");
}

/// 條件 1：程序編號被別的程序重用（建立時間不同）不是同一個視窗，不能當成改名
#[tokio::test]
async fn _2475_條件1_程序編號被重用_建立時間不同_不算改名() {
    let mut r = rig(&[(5000, "T-甲", SID_A)]).await;
    r.created.lock().unwrap().insert(5000, 999_999);
    r.rename_in_file(5000, "T-乙", SID_B);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert!(r.calls().is_empty(), "編號相同、建立時間不同＝別的程序：不算改名");
    assert!(r.h.core.known_entry("T-甲").is_some(), "舊名那列不動（由原本的不見滿 5 分鐘規則處理）");
}

/// 條件 1：建立時間查不到（無法證明是同一個視窗）也不動，記一行 log
#[tokio::test]
async fn _2475_條件1_建立時間查不到_不動副本_記_log() {
    let mut r = rig(&[(5000, "T-甲", SID_A)]).await;
    r.created.lock().unwrap().remove(&5000);
    r.rename_in_file(5000, "T-乙", SID_A);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert!(r.calls().is_empty());
    assert_eq!(r.h.core.log.count("cannot prove it is the same window"), 1);
}

/// 條件 2：這一輪讀不到對話檔、或讀到空名字、或那個視窗這輪不在名單，一律不動副本；回來時才比對
#[tokio::test]
async fn _2475_條件2_讀不到或名字空_不等於改名_不動副本_記_log() {
    let mut r = rig(&[(5000, "T-甲", SID_A)]).await;
    // 檔案讀到一半（壞掉的 JSON）
    std::fs::write(r.h.sessions.path().join("5000.json"), "{\"pid\": 5000, \"na").unwrap();
    r.h.core.refresh_roster(T0 + 1_000).await;
    // 名字讀成空的
    put_session_with_id(r.h.sessions.path(), 5000, "", SID_A);
    r.h.core.refresh_roster(T0 + 2_000).await;
    // 檔案不見
    std::fs::remove_file(r.h.sessions.path().join("5000.json")).unwrap();
    r.h.core.refresh_roster(T0 + 3_000).await;
    assert!(r.calls().is_empty(), "讀失敗、空名字、不在名單都不是改名");
    assert!(r.h.core.known_entry("T-甲").is_some(), "副本沒被動到，也沒被當成名字變空去對齊");
    assert_eq!(r.h.core.log.count("is not in this round's roster"), 1, "只有第一輪不見記一行，不每輪洗版");
    // 回來而且名字沒變：什麼都不做
    r.rename_in_file(5000, "T-甲", SID_A);
    r.h.core.refresh_roster(T0 + 4_000).await;
    assert!(r.calls().is_empty());
    // 再不見一輪、回來名字變了：這時才比出改名
    std::fs::remove_file(r.h.sessions.path().join("5000.json")).unwrap();
    r.h.core.refresh_roster(T0 + 5_000).await;
    r.rename_in_file(5000, "T-乙", SID_A);
    r.h.core.refresh_roster(T0 + 6_000).await;
    assert_eq!(r.calls(), vec![pair("T-甲", "T-乙")]);
}

/// 條件 3：兩個視窗互換名字——兩邊都不對齊（不連鎖覆蓋），各自收到白話說明，原文進 log，只說一次
#[tokio::test]
async fn _2475_條件3_兩個視窗互換名字_不對齊_告訴本人_不連鎖覆蓋() {
    let mut r = rig(&[(5000, "T-甲", SID_A), (5001, "T-乙", SID_B)]).await;
    r.rename_in_file(5000, "T-乙", SID_A);
    r.rename_in_file(5001, "T-甲", SID_B);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert!(r.calls().is_empty(), "互換：不呼叫出口，免得第二次把兩列都改掉");
    let told = r.told();
    assert_eq!(told.len(), 2, "兩個視窗各收到一次：{told:?}");
    assert!(told.iter().any(|t| t.contains("to=T-乙]")) && told.iter().any(|t| t.contains("to=T-甲]")), "各寄給自己現在的名字（那個名字只有它一個視窗）：{told:?}");
    assert!(told.iter().all(|t| t.contains("（收發室）") && t.contains("終端清單先沒有跟著改")), "{told:?}");
    assert!(!told.iter().any(|t| t.contains("pid")), "白話，不放內部編號：{told:?}");
    assert_eq!(r.h.core.log.count("rename blocked"), 2, "原文進 log");
    r.h.core.refresh_roster(T0 + 2_000).await;
    assert_eq!(r.told().len(), 2, "同一組不重複說");
    assert!(r.calls().is_empty());
}

/// 條件 3：新名已被另一個視窗用著（撞名）→ 不對齊、告訴本人；撞名解除後下一輪自動補上
#[tokio::test]
async fn _2475_條件3_撞名被擋下_之後對方改走才跟上() {
    let mut r = rig(&[(5000, "T-甲", SID_A), (5001, "T-乙", SID_B)]).await;
    r.rename_in_file(5000, "T-乙", SID_A);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert!(r.calls().is_empty());
    // 撞名：有兩個視窗叫「T-乙」，轉交指令只能用名字指定，寄過去分不出是誰（橋對來信也擋），所以不寄；改記 log，只記一次
    assert!(r.told().is_empty(), "不寄給重複的名字：{:?}", r.told());
    assert_eq!(r.h.core.log.count("cannot be told to the window by name"), 1, "原文進 log，不是沒反應");
    r.h.core.refresh_roster(T0 + 1_500).await;
    assert_eq!(r.h.core.log.count("cannot be told to the window by name"), 1, "同一組只記一次");
    // 對方改走：乙→丙 照做；甲→乙 這一輪仍被擋（乙剛才還是對方的名字），下一輪跟上
    r.rename_in_file(5001, "T-丙", SID_B);
    r.h.core.refresh_roster(T0 + 2_000).await;
    assert_eq!(r.calls(), vec![pair("T-乙", "T-丙")]);
    r.h.core.refresh_roster(T0 + 3_000).await;
    assert_eq!(r.calls(), vec![pair("T-乙", "T-丙"), pair("T-甲", "T-乙")]);
}

/// 條件 4：已轉交、等回覆的信，改名之後新名回信仍對得上（搬收件名），不會被當成沒人回而退信
#[tokio::test]
async fn _2475_條件4_等回覆的信改名後新名回信仍對得上() {
    let mut r = rig(&[(5000, "T-甲", SID_A)]).await;
    r.h.forward(mail(1, json!({"to_agent": "T-甲"})), T0 + 100).await;
    assert!(r.h.core.pending.iter().any(|p| p.target == "T-甲" && p.state == State::Waiting), "先確認信在等回覆");
    r.rename_in_file(5000, "T-乙", SID_A);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert!(r.h.core.pending.iter().all(|p| p.target != "T-甲"), "沒有信還掛在舊名底下");
    r.h.core.on_reply("T-乙", "收到了", Some(uid(1))).await;
    let sent: Vec<String> = r.h.fr.sent().iter().filter_map(|s| s["body"].as_str().map(String::from)).collect();
    assert!(sent.iter().any(|b| b.contains("收到了")), "新名的回信對上那封信、寄回給原寄件人：{sent:?}");
}

/// 剛關掉的記號跟著搬：關閉這個視窗的意圖不因改名消失
#[tokio::test]
async fn _2475_剛關掉的記號跟著搬到新名() {
    let mut r = rig(&[(5000, "T-甲", SID_A)]).await;
    r.h.core.mark_just_closed("T-甲", T0 + 500);
    r.rename_in_file(5000, "T-乙", SID_A);
    r.h.core.refresh_roster(T0 + 1_000).await;
    assert!(r.h.core.just_closed_has("T-乙"));
    assert!(!r.h.core.just_closed_has("T-甲"));
}
