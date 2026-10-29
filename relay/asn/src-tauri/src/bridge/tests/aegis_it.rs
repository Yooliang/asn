//! Aegis 引擎的契約測試：接上真的核心，後端是 127.0.0.1 的假伺服器，Aegis 也是 127.0.0.1 的假伺服器（只連本機，不碰真的 Aegis 與任何金鑰）。
//! 對應 relay/machine/test/aegis-vectors.test.mjs（Node 版）：兩邊讀同一份向量 relay/shared/test-vectors/aegis-bridge.json。
use super::*;
use crate::bridge::engines::{self, EngineCtx, EngineEvent, EngineSet, PidBook};
use std::collections::HashMap;
use std::path::Path;
use tokio::sync::mpsc::UnboundedReceiver;

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

fn vectors() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shared/test-vectors/aegis-bridge.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

// ---- 假 Aegis ---------------------------------------------------------------------------------

#[derive(Default)]
struct AState {
    asks: Vec<Value>,
    calls: HashMap<String, usize>,
    /// (內文結尾, 成員, 依序的回應)；內文結尾空字串＝這個成員的所有問題
    scripts: Vec<(String, String, Vec<(u16, Value)>)>,
    members: Value,
    delay_ms: u64,
}

struct FakeAegis {
    url: String,
    st: Arc<Mutex<AState>>,
}

fn aegis_conn(mut c: std::net::TcpStream, st: Arc<Mutex<AState>>) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let (head_end, len) = loop {
        let n = c.read(&mut tmp).unwrap_or(0);
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
            break (i + 4, head.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0));
        }
    };
    while buf.len() < head_end + len {
        let n = c.read(&mut tmp).unwrap_or(0);
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let body: Value = serde_json::from_slice(&buf[head_end..(head_end + len).min(buf.len())]).unwrap_or(Value::Null);
    let path = head.lines().next().unwrap_or("").split(' ').nth(1).unwrap_or("").to_string();
    let delay = st.lock().unwrap().delay_ms;
    let (code, out) = if path.starts_with("/api/v1/members") {
        (200, st.lock().unwrap().members.clone())
    } else if path == "/api/v1/agent-chat/ask" {
        let mut s = st.lock().unwrap();
        s.asks.push(body.clone());
        let (target, q) = (body["target"].as_str().unwrap_or("").to_string(), body["question"].as_str().unwrap_or("").to_string());
        let pick = s.scripts.iter().position(|(suffix, t, _)| *t == target && q.ends_with(suffix.as_str()));
        match pick {
            None => (404, json!({"detail": "member not found"})),
            Some(i) => {
                let key = format!("{i}");
                let n = *s.calls.entry(key).and_modify(|x| *x += 1).or_insert(1);
                let list = &s.scripts[i].2;
                let (h, j) = list[n.min(list.len()) - 1].clone();
                drop(s);
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
                (h, j)
            }
        }
    } else {
        (404, json!({}))
    };
    let text = out.to_string();
    let _ = write!(c, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
}

impl FakeAegis {
    fn start(members: Value) -> FakeAegis {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let st = Arc::new(Mutex::new(AState { members, ..Default::default() }));
        let s2 = st.clone();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(c) = c else { break };
                let s3 = s2.clone();
                std::thread::spawn(move || aegis_conn(c, s3));
            }
        });
        FakeAegis { url, st }
    }
    fn script(&self, suffix: &str, target: &str, resps: Vec<(u16, Value)>) {
        self.st.lock().unwrap().scripts.push((suffix.into(), target.into(), resps));
    }
    fn asks(&self) -> Vec<Value> {
        self.st.lock().unwrap().asks.clone()
    }
}

// ---- 環境 -------------------------------------------------------------------------------------

struct AH {
    core: Core,
    fr: FakeRelay,
    ag: FakeAegis,
    set: Arc<EngineSet>,
    rx: UnboundedReceiver<EngineEvent>,
    logs: Arc<Mutex<Vec<String>>>,
    _work: tempfile::TempDir,
    _sessions: tempfile::TempDir,
}

impl Drop for AH {
    fn drop(&mut self) {
        self.set.stop();
    }
}

async fn aboot(members: Value, env: &[(&str, &str)]) -> AH {
    let fr = FakeRelay::start();
    let ag = FakeAegis::start(members);
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let l2 = logs.clone();
    let mut e: Vec<(String, String)> = vec![("ASN_AEGIS_URL".into(), ag.url.clone())];
    e.extend(env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let ctx = EngineCtx {
        log: Arc::new(move |m| l2.lock().unwrap().push(m)),
        work_dir: work.path().to_path_buf(),
        home: work.path().to_path_buf(),
        agents_file: work.path().join("agents.json"),
        env: Arc::new(e),
        events: tx,
        notify: Arc::new(|_| {}),
        pids: PidBook::new(work.path()),
        data_dir: None,
        handoff_dir: None,
    };
    let set = engines::build(&ctx, Some("aegis")).expect("有載入 aegis 引擎");
    let mut core = new_core(&fr, work.path(), sessions.path(), Arc::new(FakeSink::default()), now());
    core.cfg.engine_only = true; // Aegis 主機的跑法：沒有本人視窗，說明文字由引擎給
    core.cfg.default_agent.clear(); // 測試用設定預設指到 T-甲；Aegis 機沒有設，改由引擎的預設成員接
    core.set_engines(set.clone());
    set.start();
    set.refresh_all().await;
    core.refresh_roster(now()).await;
    AH { core, fr, ag, set, rx, logs, _work: work, _sessions: sessions }
}

impl AH {
    async fn drain(&mut self) {
        while let Ok(ev) = self.rx.try_recv() {
            self.core.on_engine_event(ev, now()).await;
        }
    }
    /// 一直處理引擎事件，直到條件成立（最多 30 秒）
    async fn wait(&mut self, what: &str, f: impl Fn(&AH) -> bool) {
        let t0 = std::time::Instant::now();
        loop {
            self.drain().await;
            if f(self) {
                return;
            }
            if t0.elapsed() > std::time::Duration::from_secs(30) {
                panic!("等不到：{what}\n--- 引擎 log ---\n{}\n--- 橋 log ---\n{}\n--- 寄出 ---\n{:?}\n--- ack ---{:?}", self.logs.lock().unwrap().join("\n"), self.core.log.recent().join("\n"), self.fr.sent(), self.fr.acked());
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
    /// 再處理一小段時間（讓不該發生的事有機會發生）
    async fn settle(&mut self, ms: u64) {
        let t0 = std::time::Instant::now();
        while t0.elapsed() < std::time::Duration::from_millis(ms) {
            self.drain().await;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
    async fn put_pull(&mut self, m: Value) {
        self.fr.put(m);
        self.core.pull("test", now()).await;
    }
    fn aegis_roster(&self) -> Vec<Value> {
        self.fr.rosters().last().map(|r| r["agents"].as_array().cloned().unwrap_or_default().into_iter().filter(|a| a["engine"] == "aegis").collect()).unwrap_or_default()
    }
}

fn vec_cfg() -> (Value, String, String) {
    let v = vectors();
    let c = &v["config"];
    (c["members"].clone(), c["allow"].as_str().unwrap().to_string(), c["retry_ms"].to_string())
}

fn mail_from(v: &Value, n: usize, m: &Value) -> Value {
    let c = &v["config"]["mail"];
    let mut x = json!({"id": uid(n as u32), "from_node": c["from_node"], "from_agent": c["from_agent"], "trust": c["trust"], "expects_reply": m.get("expects_reply").unwrap_or(&c["expects_reply"]), "body": m["body"]});
    if let Some(t) = m["to_agent"].as_str() {
        x["to_agent"] = json!(t);
    }
    x
}

// ================================================================================================

#[test]
fn 向量_震動拆分與_node_版逐字相同() {
    let v = vectors();
    let cases = v["nudge_split"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let got = super::super::engines::aegis::split_nudge_answer(c["answer"].as_str().unwrap(), c["name"].as_str().unwrap());
        let want = c["split"].as_object().map(|o| (o["nudge"].as_str().unwrap().to_string(), o["rest"].as_str().unwrap().to_string()));
        assert_eq!(got, want, "{}", c["answer"]);
    }
}

#[test]
fn 向量_設定讀取_新名優先_舊名照認_與_node_版相同() {
    use super::super::engines::aegis::AegisCfg;
    let v = vectors();
    let cases = v["env_config"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let env: Vec<(String, String)> = c["env"].as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string())).collect();
        let e = &c["expect"];
        let s = |k: &str| e[k].as_str().unwrap().to_string();
        let want = AegisCfg {
            url: s("url"),
            from_member: s("from_member"),
            allow: e["allow"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect(),
            self_member: s("self_member"),
            default_member: s("default_member"),
            ask_timeout_ms: e["ask_timeout_ms"].as_u64().unwrap(),
            retry_ms: e["retry_ms"].as_u64().unwrap(),
        };
        assert_eq!(AegisCfg::from_env(&env), want, "{}", c["case"]);
    }
}

#[tokio::test]
async fn 向量_每封信的問答_回信_ack_名單_與_node_版相同() {
    let v = vectors();
    let (members, allow, retry) = vec_cfg();
    let mails = v["mails"].as_array().unwrap();
    let mut h = aboot(members, &[("ASN_AEGIS_ALLOW", &allow), ("ASN_AEGIS_RETRY_MS", &retry)]).await;
    for m in mails {
        for (target, list) in m["aegis"].as_object().unwrap() {
            h.ag.script(m["body"].as_str().unwrap(), target, list.as_array().unwrap().iter().map(|r| (r["http"].as_u64().unwrap() as u16, r["json"].clone())).collect());
        }
    }
    // 名單：白名單成員（不含轉接橋自己的成員）、中文名、副標空
    let names: Vec<String> = h.aegis_roster().iter().map(|a| a["name"].as_str().unwrap().to_string()).collect();
    let want: Vec<String> = v["config"]["roster_names"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    assert_eq!(names, want);
    assert!(h.aegis_roster().iter().all(|a| a["cwd_label"] == "" && a["status"] == "idle"));
    for (i, m) in mails.iter().enumerate() {
        h.fr.put(mail_from(&v, i + 1, m));
    }
    h.core.pull("test", now()).await;
    h.wait("全部 ack", |h| h.fr.acked().len() >= mails.len()).await;
    h.settle(400).await;
    let (sent, asks) = (h.fr.sent(), h.ag.asks());
    for (i, m) in mails.iter().enumerate() {
        let (id, label) = (uid(i as u32 + 1), format!("{} {}", i + 1, m["name"]));
        let body = m["body"].as_str().unwrap();
        let got_asks: Vec<&Value> = asks.iter().filter(|a| a["question"].as_str().unwrap().ends_with(body)).collect();
        let want_asks = m["asks"].as_array().unwrap();
        assert_eq!(got_asks.len(), want_asks.len(), "{label} 問了幾次");
        for (g, w) in got_asks.iter().zip(want_asks) {
            assert_eq!(*g, w, "{label}");
        }
        let got: Vec<&Value> = sent.iter().filter(|s| s["reply_to"] == id.as_str()).collect();
        let reps = m["replies"].as_array().unwrap();
        assert_eq!(got.len(), reps.len(), "{label} 寄回幾封：{got:?}");
        for (g, e) in got.iter().zip(reps) {
            if let Some(b) = e.get("body") {
                assert_eq!(g["body"], *b, "{label}");
            }
            for k in ["from_agent", "to_node", "to_agent"] {
                if let Some(x) = e.get(k) {
                    assert_eq!(g[k], *x, "{label} {k}");
                }
            }
        }
        assert!(h.fr.acked().contains(&id), "{label} 要 ack");
    }
}

#[tokio::test]
async fn ack_時機_寄回成功才_ack_等答案時不_ack() {
    let (members, allow, retry) = vec_cfg();
    let mut h = aboot(members, &[("ASN_AEGIS_ALLOW", &allow), ("ASN_AEGIS_RETRY_MS", &retry)]).await;
    h.ag.script("", "alpha", vec![(200, json!({"answer": "慢答案", "status": "success"}))]);
    h.ag.st.lock().unwrap().delay_ms = 700;
    h.put_pull(mail(1, json!({"to_agent": "阿爾法"}))).await;
    h.wait("問出去了", |h| h.ag.asks().len() == 1).await;
    h.settle(300).await;
    assert!(h.fr.acked().is_empty() && h.fr.sent().is_empty(), "答案還沒回來：不 ack、沒寄信");
    assert!(h.core.log.has("forwarded id="));
    h.wait("寄回並 ack", |h| !h.fr.acked().is_empty()).await;
    assert_eq!(h.fr.sent().len(), 1);
    assert_eq!(h.fr.acked(), vec![uid(1)]);
    // 核心不對 Aegis 窗口送「還沒回覆」的提醒（引擎自己管等待時間）
    h.core.tick(now() + 400_000).await;
    assert!(!h.core.log.has("nudged window"));
}

#[tokio::test]
async fn ack_時機_寄回失敗不_ack_震動拆分的第二封也不寄_補拉不會重複轉交() {
    let (members, allow, retry) = vec_cfg();
    let mut h = aboot(members, &[("ASN_AEGIS_ALLOW", &allow), ("ASN_AEGIS_RETRY_MS", &retry)]).await;
    h.fr.st.lock().unwrap().send_fail_reply_to.push(uid(1));
    h.ag.script("", "xiao-liang", vec![(200, json!({"answer": "（小良 傳送了一個震動）\n報告", "status": "success"}))]);
    h.put_pull(mail(1, json!({"to_agent": "小良"}))).await;
    h.wait("引擎報完", |h| h.core.log.has("an earlier part failed")).await;
    h.settle(300).await;
    assert!(h.fr.acked().is_empty(), "寄回失敗：留在信箱不 ack");
    assert!(h.fr.sent().is_empty());
    // 補拉：信還在處理中，不會再問一次
    h.core.pull("again", now()).await;
    h.settle(300).await;
    assert_eq!(h.ag.asks().len(), 1);
}

#[tokio::test]
async fn 其他引擎的_ack_時機沒變_aegis_以外的引擎不延後() {
    // 引擎集合只有 aegis：問 acp／codex／claude 是否延後 ack，一律否
    let (members, allow, _) = vec_cfg();
    let h = aboot(members, &[("ASN_AEGIS_ALLOW", &allow)]).await;
    assert!(h.set.ack_after_reply("aegis"));
    for other in ["acp", "codex", "claude"] {
        assert!(!h.set.ack_after_reply(other), "{other}");
    }
}

#[tokio::test]
async fn 名單_成員表讀不到就用代號_讀到了改用中文名() {
    let h = aboot(json!({"oops": 1}), &[("ASN_AEGIS_ALLOW", "alpha,xi-xu,flaky")]).await;
    let names: Vec<String> = h.aegis_roster().iter().map(|a| a["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["alpha", "flaky"], "成員表格式不認得：用代號，不含轉接橋自己的成員");
    let h = aboot(json!({"members": [{"slug": "alpha", "display_name": "阿爾法"}, {"slug": "flaky", "member_name": "不穩"}]}), &[("IRORI_AEGIS_ALLOW", "alpha,flaky")]).await;
    let names: Vec<String> = h.aegis_roster().iter().map(|a| a["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["阿爾法", "不穩"], "舊名 IRORI_AEGIS_ALLOW 也認；成員表可包在 members 裡、名字可叫 display_name／member_name");
}

#[tokio::test]
async fn 白名單預設空_全部擋下_沒有任何問答() {
    let mut h = aboot(json!([{"slug": "alpha", "name": "阿爾法"}]), &[]).await;
    h.ag.script("", "alpha", vec![(200, json!({"answer": "x", "status": "success"}))]);
    assert!(h.aegis_roster().is_empty());
    h.put_pull(mail(1, json!({"to_agent": "alpha"}))).await;
    h.wait("擋下並 ack", |h| !h.fr.acked().is_empty()).await;
    assert!(h.ag.asks().is_empty());
    assert_eq!(h.fr.sent()[0]["body"], "[Aegis] 這位成員沒有開放聯絡（alpha）");
}

// ---- 群組 ------------------------------------------------------------------------------------

fn room_with(window: &str) -> Value {
    json!({"id": "R1", "name": "專案群", "last_seq": 2, "mine": [{"member": format!("T~{window}"), "read_seq": 1}],
        "messages": [{"seq": 2, "from": "W~W-政策", "from_name": "政策", "trust": "member", "body": "群組問題", "mentions": [], "at": "t", "forMe": {window: true}}]})
}

#[tokio::test]
async fn 群組_被點名就問_答案貼回群組_不_ack_失敗不貼回也不重試_白名單外略過() {
    let (members, allow, retry) = vec_cfg();
    let mut h = aboot(members.clone(), &[("ASN_AEGIS_ALLOW", &allow), ("ASN_AEGIS_RETRY_MS", &retry)]).await;
    h.ag.script("", "alpha", vec![(200, json!({"answer": "群組答案", "status": "success"}))]);
    h.fr.st.lock().unwrap().rooms = vec![room_with("阿爾法")];
    h.core.pull("test", now()).await;
    h.wait("貼回群組", |h| !h.fr.st.lock().unwrap().room_posts.is_empty()).await;
    let p = h.fr.st.lock().unwrap().room_posts[0].clone();
    assert_eq!((p["room"].as_str(), p["body"].as_str(), p["from_agent"].as_str()), (Some("R1"), Some("群組答案"), Some("阿爾法")));
    assert!(h.fr.acked().is_empty(), "群組沒有信箱，不 ack");
    // 失敗：問一次、不重試、不貼回
    let mut g = aboot(members.clone(), &[("ASN_AEGIS_ALLOW", &allow), ("ASN_AEGIS_RETRY_MS", &retry)]).await;
    g.ag.script("", "flaky", vec![(200, json!({"answer": "", "status": "error"})), (200, json!({"answer": "不該用到", "status": "success"}))]);
    g.fr.st.lock().unwrap().rooms = vec![room_with("不穩")];
    g.core.pull("test", now()).await;
    g.wait("問了一次", |g| g.ag.asks().len() == 1).await;
    g.settle(500).await;
    assert_eq!(g.ag.asks().len(), 1);
    assert!(g.fr.st.lock().unwrap().room_posts.is_empty());
    // 白名單外的視窗：略過，不問
    let mut k = aboot(members, &[("ASN_AEGIS_ALLOW", &allow)]).await;
    k.fr.st.lock().unwrap().rooms = vec![room_with("路人")];
    k.core.pull("test", now()).await;
    k.settle(300).await;
    assert!(k.ag.asks().is_empty() && k.fr.st.lock().unwrap().room_posts.is_empty());
}

#[tokio::test]
async fn 向量_沒有預設成員時請指定成員_與_node_版相同() {
    let v = vectors();
    let nd = &v["no_default"];
    let members = v["config"]["members"].clone();
    let mut h = aboot(members, &[("ASN_AEGIS_ALLOW", nd["allow"].as_str().unwrap())]).await;
    let c = &v["config"]["mail"];
    h.put_pull(json!({"id": uid(1), "from_node": c["from_node"], "from_agent": c["from_agent"], "trust": c["trust"], "expects_reply": true, "body": nd["mail"]["body"]})).await;
    h.wait("回覆並 ack", |h| !h.fr.acked().is_empty()).await;
    assert!(h.ag.asks().is_empty());
    let sent = h.fr.sent();
    let want = nd["replies"].as_array().unwrap();
    assert_eq!(sent.len(), want.len());
    for (g, e) in sent.iter().zip(want) {
        for k in ["body", "to_node", "to_agent"] {
            assert_eq!(g[k], e[k], "{k}");
        }
    }
}

#[tokio::test]
async fn 向量_群組_視窗寫代號或中文名都問得到_以中文名貼回() {
    let v = vectors();
    let (members, allow, retry) = vec_cfg();
    for rc in v["rooms"].as_array().unwrap() {
        let mut h = aboot(members.clone(), &[("ASN_AEGIS_ALLOW", &allow), ("ASN_AEGIS_RETRY_MS", &retry)]).await;
        h.ag.script("", rc["target"].as_str().unwrap(), vec![(200, json!({"answer": rc["answer"], "status": "success"}))]);
        h.fr.st.lock().unwrap().rooms = vec![room_with(rc["window"].as_str().unwrap())];
        h.core.pull("test", now()).await;
        h.wait("貼回群組", |h| !h.fr.st.lock().unwrap().room_posts.is_empty()).await;
        let p = h.fr.st.lock().unwrap().room_posts[0].clone();
        assert_eq!((p["body"].as_str(), p["from_agent"].as_str()), (rc["answer"].as_str(), rc["post_from_agent"].as_str()), "{}", rc["name"]);
        assert_eq!(h.ag.asks().len(), 1);
        assert_eq!(h.ag.asks()[0]["target"], rc["target"]);
        assert!(h.fr.acked().is_empty());
    }
}
