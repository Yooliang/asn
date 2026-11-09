//! 核對轉交對象的端對端實跑：真的核心（deliver_raw 寫 inflight、Parser、ack 到假後端）＋真的 `claude -p` 收發室 worker
//! ＋真的 hook（asn-cli forward-gate，settings 就是 worker_settings 實際產生的那一份）＋兩個真的、活著的收件端 claude 工作階段。
//! 後端是 127.0.0.1 的假伺服器，不連任何真實服務。
//!
//! 預設不跑（#[ignore]）。執行方式（要有 claude 且已登入；模型 haiku；總用量約 0.05 美元，超過 0.2 美元會自己停）：
//!   cargo build --bin asn-cli
//!   cargo test --lib e2e_real -- --ignored --nocapture
//! 會做的事：
//! - 起兩個無視窗的收件端 claude -p（名字 T-gate-recv、T-gate-other，工作目錄在暫存資料夾，stdin 保持開著、不給輸入），
//!   跑完依記下的 PID 結束，並刪掉它們在 ~/.claude/sessions 與 ~/.claude/projects 留下的自己的紀錄；不會送信給任何現有視窗
//! - 因為要用 ~/.claude 的登入憑證，執行期間（約 2～3 分鐘）這兩個名字會出現在本機工作階段名單
//! - 為了讓橋找得到 asn-cli，會把 target/debug/asn-cli.exe 複製到測試執行檔旁邊，跑完刪掉
//! 四項：個人信、群組訊息（hook 放行、對方收到、算 Sent、橋 ack）；收件人被換掉、第一行被改過（hook 擋下）。
use super::rooms_launch::{room, rmsg};
use super::*;
use crate::bridge::worker::{ProcWorker, WorkerSpec};
use crate::nowin::NoWindow;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};

const BUDGET_USD: f64 = 0.2;
/// 主迴圈目前停在哪一步（看門狗每 30 秒印一次，卡住時才知道卡在哪）
static STAGE: Mutex<&'static str> = Mutex::new("start");
fn stage(s: &'static str) {
    *STAGE.lock().unwrap() = s;
}

/// 一個活著的收件端：stdin 保持開著，每收到一則訊息會開始處理一輪（received 計次）
struct Recv {
    child: Child,
    _stdin: ChildStdin,
    received: Arc<Mutex<u32>>,
    cost: Arc<Mutex<f64>>,
}

fn start_recv(name: &str, dir: &Path, settings: &Path) -> Recv {
    std::fs::create_dir_all(dir).unwrap();
    let mut child = Command::new("claude")
        .no_window()
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", "haiku", "--strict-mcp-config", "--disable-slash-commands", "--tools", "ListAgents", "--name", name])
        .arg("--settings")
        .arg(settings)
        .args(["--system-prompt", "You are a test receiver. When another session sends you a message, reply with exactly the single word RECEIVED and nothing else."])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("起不了收件端 claude");
    let stdin = child.stdin.take().unwrap();
    let out = child.stdout.take().unwrap();
    let (received, cost) = (Arc::new(Mutex::new(0u32)), Arc::new(Mutex::new(0f64)));
    let (r2, c2) = (received.clone(), cost.clone());
    std::thread::spawn(move || {
        for l in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
            // 收到一則跨工作階段訊息就會開始處理一輪（command_lifecycle started）；ASN 外掛會讓收件端的回覆長得不一樣，所以不看回覆的字
            if v["type"] == "command_lifecycle" && v["state"] == "started" {
                *r2.lock().unwrap() += 1;
            }
            if v["type"] == "result" {
                *c2.lock().unwrap() = v["total_cost_usd"].as_f64().unwrap_or(0.0);
            }
        }
    });
    Recv { child, _stdin: stdin, received, cost }
}

/// 把送進 worker 的橋接指令改掉（模擬 worker 被騙去送錯）：只改帶指定信件編號的那一則
struct Mangle {
    inner: ProcWorker,
    rule: Mutex<Option<(String, Box<dyn Fn(&str) -> String + Send + Sync>)>>,
}
impl WorkerSink for Mangle {
    fn say(&self, text: String) -> Result<(), String> {
        let t = match self.rule.lock().unwrap().as_ref() {
            Some((id, f)) if text.contains(id.as_str()) => f(&text),
            _ => text,
        };
        self.inner.say(t)
    }
    fn kill(&self) {
        self.inner.kill()
    }
    fn pid(&self) -> u32 {
        self.inner.pid()
    }
}

fn get(m: &Arc<Mutex<u32>>) -> u32 {
    *m.lock().unwrap()
}

fn now() -> u64 {
    crate::heartbeat::now_ms()
}

/// 跑橋的主迴圈直到條件成立或逾時；每秒左右拉一次信、跑 tick（名單只在開頭建一次，見測試本體）
async fn drive(core: &mut Core, rx: &mut tokio::sync::mpsc::UnboundedReceiver<WorkerLine>, secs: u64, mut done: impl FnMut(&Core) -> bool) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    let mut shown = std::time::Instant::now();
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(5);
    while std::time::Instant::now() < end {
        stage("recv");
        if let Ok(Some(l)) = tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv()).await {
            stage("on_worker_line");
            core.on_worker_line(l, now()).await;
        }
        if last.elapsed() >= std::time::Duration::from_millis(1500) {
            last = std::time::Instant::now();
            stage("pull");
            if tokio::time::timeout(std::time::Duration::from_secs(15), core.pull("e2e", now())).await.is_err() {
                eprintln!("[e2e] pull 卡住超過 15 秒");
            }
            stage("tick");
            if tokio::time::timeout(std::time::Duration::from_secs(15), core.tick(now())).await.is_err() {
                eprintln!("[e2e] tick 卡住超過 15 秒");
            }
        }
        stage("done");
        if done(core) {
            return true;
        }
        if shown.elapsed() >= std::time::Duration::from_secs(20) {
            shown = std::time::Instant::now();
            eprintln!("[e2e] 還在等…剩 {} 秒", end.saturating_duration_since(std::time::Instant::now()).as_secs());
        }
    }
    false
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

/// hook 的 log 裡含這個編號的行
fn gate_lines(work: &Path, id: &str) -> Vec<String> {
    read(&work.join("forward-gate.log")).lines().filter(|l| l.contains(id)).map(String::from).collect()
}

fn claude_home() -> PathBuf {
    crate::identity::home_dir().join(".claude")
}

#[test]
#[ignore = "要真的 claude、會花用量（約 0.05 美元）；執行方式見檔頭"]
fn e2e_真的_claude_真的_hook_四項() {
    // 讓橋找得到 asn-cli：和測試執行檔放在同一個資料夾
    let exe = std::env::current_exe().unwrap();
    let cli_src = exe.parent().unwrap().parent().unwrap().join(if cfg!(windows) { "asn-cli.exe" } else { "asn-cli" });
    assert!(cli_src.is_file(), "先執行 cargo build --bin asn-cli");
    let cli_dst = exe.parent().unwrap().join(cli_src.file_name().unwrap());
    let copied = !cli_dst.exists() && std::fs::copy(&cli_src, &cli_dst).is_ok();

    let root = tempfile::Builder::new().prefix("gate-e2e-").tempdir().unwrap();
    let settings = root.path().join("recv-settings.json");
    std::fs::write(&settings, r#"{"crossSessionInbound":"accept"}"#).unwrap();
    let mut pids: Vec<u32> = vec![];
    let mut recvs: Vec<Recv> = vec![start_recv("T-gate-recv", &root.path().join("recv"), &settings), start_recv("T-gate-other", &root.path().join("other"), &settings)];
    pids.extend(recvs.iter().map(|r| r.child.id()));
    let recvs_pids = pids.clone();
    let (rcv_n, oth_n) = (recvs[0].received.clone(), recvs[1].received.clone());
    let costs: Vec<Arc<Mutex<f64>>> = recvs.iter().map(|r| r.cost.clone()).collect();

    // 看門狗：整個測試超過 8 分鐘還沒結束，就只結束自己記下的 PID、刪自己留下的紀錄後直接離開，不讓子程序留著
    let worker_sink: Arc<Mutex<Option<Arc<Mangle>>>> = Arc::new(Mutex::new(None));
    {
        let (pids2, ws) = (pids.clone(), worker_sink.clone());
        std::thread::spawn(move || {
            for _ in 0..16 {
                std::thread::sleep(std::time::Duration::from_secs(30));
                eprintln!("[e2e] 心跳：主迴圈在「{}」", STAGE.lock().unwrap());
            }
            eprintln!("[e2e] 看門狗：逾時，結束自己啟動的程序");
            let mut all = pids2;
            if let Some(w) = ws.lock().unwrap().as_ref() {
                all.push(w.pid());
            }
            cleanup_pids(&all);
            std::process::exit(3);
        });
    }
    let fr = FakeRelay::start();
    let work = tempfile::Builder::new().prefix("gate-e2e-work-").tempdir().unwrap();
    let mut c = cfg(work.path(), &claude_home().join("sessions"));
    c.mailbox_name = "T-gate-收發室".into();
    c.claude_bin = "claude".into();
    c.model = "haiku".into();
    c.default_agent = String::new();
    let relay = Arc::new(Relay::new(fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::rt::block_on(async {
            let nonce = crate::bridge::worker::new_nonce();
            let spec = WorkerSpec { bin: c.claude_bin.clone(), pre_args: vec![], mailbox_name: c.mailbox_name.clone(), model: c.model.clone(), work_dir: work.path().to_path_buf(), nonce: nonce.clone(), extra_env: vec![], respond: None };
            let (w, mut rx) = ProcWorker::spawn(spec, |_| {});
            let sink = Arc::new(Mangle { inner: w.clone(), rule: Mutex::new(None) });
            *worker_sink.lock().unwrap() = Some(sink.clone());
            let log = Arc::new(BridgeLog::new(Some(work.path().join("bridge.log"))));
            let alive: Arc<dyn Fn(u32) -> bool + Send + Sync> = Arc::new(crate::heartbeat::pid_alive);
            let mut core = Core::new(c.clone(), relay.clone(), sink.clone(), &nonce, log, alive, now());
            // 橋的名單只收互動式視窗（-p 的工作階段不列），所以名單建一次之後，把兩個收件端直接放進去；
            // 之後不再重建名單。實際送信的是真的 worker 用真的 SendMessage 找這兩個真的工作階段
            core.refresh_roster(now()).await;
            for (i, r) in recvs_pids.iter().enumerate() {
                let name = if i == 0 { "T-gate-recv" } else { "T-gate-other" };
                core.roster.push(crate::bridge::roster::Window::claude(name, Some("idle".into()), "", *r, now(), None));
            }
            let mail_at = |n: u32, to: &str| fr.put(mail(n, json!({"to_agent": to, "expects_reply": false, "body": format!("端對端測試信 {n}，請忽略")})));
            let bridge_log = || read(&work.path().join("bridge.log"));
            let total_cost = || costs.iter().map(|c| *c.lock().unwrap()).sum::<f64>() + bridge_log().lines().filter_map(|l| l.split("cost=$").nth(1)?.split(' ').next()?.parse::<f64>().ok()).sum::<f64>();
            let mut report: Vec<String> = vec![];

            eprintln!("[e2e] 一：個人信");
            let id1 = uid(1);
            mail_at(1, "T-gate-recv");
            let ok = drive(&mut core, &mut rx, 120, |_| {
                stage("done:acked");
                let a = fr.acked().contains(&id1);
                stage("done:rcv");
                let r = get(&rcv_n) >= 1;
                a && r
            })
            .await;
            report.push(format!("一 個人信：hook={} 對方收到={}（recv 回報 {} 次）Sent={} ack={}", gate_lines(work.path(), &id1).iter().map(|l| l.split(' ').nth(1).unwrap_or("?").to_string()).collect::<Vec<_>>().join("/"), get(&rcv_n) >= 1, get(&rcv_n), bridge_log().contains(&format!("forwarded id={id1}")), fr.acked().contains(&id1)));
            assert!(ok, "個人信沒走完\n{}\n{}", report.join("\n"), bridge_log());
            assert!(gate_lines(work.path(), &id1).iter().any(|l| l.contains("allow")));

            eprintln!("[e2e] 二：群組訊息");
            let mine = json!([{"member": "T~T-gate-recv", "read_seq": 1}]);
            fr.st.lock().unwrap().rooms = vec![room(vec![rmsg(2, json!({"forMe": {"T-gate-recv": true}, "body": "端對端測試群組訊息，請忽略"}))], mine)];
            let gid = crate::bridge::rooms::room_uuid("R1", 2, "T~T-gate-recv");
            let ok = drive(&mut core, &mut rx, 120, |_| bridge_log().contains("forwarded room=R1 #2") && get(&rcv_n) >= 2).await;
            report.push(format!("二 群組訊息：hook={} 對方收到={}（recv 回報 {} 次）Sent={} ack=群組訊息不 ack（游標已前進）", gate_lines(work.path(), &gid).iter().map(|l| l.split(' ').nth(1).unwrap_or("?").to_string()).collect::<Vec<_>>().join("/"), get(&rcv_n) >= 2, get(&rcv_n), bridge_log().contains("forwarded room=R1 #2")));
            assert!(ok, "群組訊息沒走完\n{}\n{}", report.join("\n"), bridge_log());
            assert!(gate_lines(work.path(), &gid).iter().any(|l| l.contains("allow")));
            assert!(total_cost() < BUDGET_USD, "用量超過 {BUDGET_USD} 美元，停下來：{}", total_cost());

            eprintln!("[e2e] 三：收件人被換掉");
            // 三：收件人被換掉（橋接指令的 to 被改成 T-gate-other，inflight 記的仍是 T-gate-recv）
            let id3 = uid(3);
            *sink.rule.lock().unwrap() = Some((id3.clone(), Box::new(|t: &str| t.replacen("to=T-gate-recv]", "to=T-gate-other]", 1))));
            mail_at(3, "T-gate-recv");
            let ok = drive(&mut core, &mut rx, 120, |_| fr.acked().contains(&id3) || gate_lines(work.path(), &id3).iter().any(|l| l.contains("deny"))).await;
            drive(&mut core, &mut rx, 15, |_| false).await; // 再等一下，確認 other 沒有收到
            let g3 = gate_lines(work.path(), &id3);
            report.push(format!("三 收件人被換掉：hook={} 對方（T-gate-other）收到={}（{} 次）Sent={} ack={}（{}）", g3.iter().map(|l| l.split(' ').nth(1).unwrap_or("?").to_string()).collect::<Vec<_>>().join("/"), get(&oth_n) > 0, get(&oth_n), bridge_log().contains(&format!("forwarded id={id3}")), fr.acked().contains(&id3), if fr.acked().contains(&id3) { "worker 回 FAIL 後 ack" } else { "沒有 ack" }));
            assert!(ok && g3.iter().any(|l| l.contains("deny") && l.contains("expected=T-gate-recv") && l.contains("actual=T-gate-other")), "{}\n{g3:?}", report.join("\n"));
            assert_eq!(get(&oth_n), 0, "被擋下的信不能到 T-gate-other");

            eprintln!("[e2e] 四：第一行被改過");
            // 四：第一行被改過（收件人、編號都對，第一行多了一個字）
            let id4 = uid(4);
            *sink.rule.lock().unwrap() = Some((id4.clone(), Box::new(|t: &str| t.replacen("trust=member", "trust=xmember", 1))));
            mail_at(4, "T-gate-recv");
            let before = get(&rcv_n);
            let ok = drive(&mut core, &mut rx, 120, |_| fr.acked().contains(&id4) || gate_lines(work.path(), &id4).iter().any(|l| l.contains("deny"))).await;
            drive(&mut core, &mut rx, 15, |_| false).await;
            let g4 = gate_lines(work.path(), &id4);
            report.push(format!("四 第一行被改過：hook={} 對方（T-gate-recv）新收到={}（{} 次）Sent={} ack={}（{}）", g4.iter().map(|l| l.split(' ').nth(1).unwrap_or("?").to_string()).collect::<Vec<_>>().join("/"), get(&rcv_n) > before, get(&rcv_n) - before, bridge_log().contains(&format!("forwarded id={id4}")), fr.acked().contains(&id4), if fr.acked().contains(&id4) { "worker 回 FAIL 後 ack" } else { "沒有 ack" }));
            assert!(ok && g4.iter().any(|l| l.contains("deny") && l.contains("head mismatch")), "{}\n{g4:?}", report.join("\n"));
            assert_eq!(get(&rcv_n), before, "第一行被改過的信不能送達");

            println!("---- 端對端結果 ----");
            for l in &report {
                println!("{l}");
            }
            println!("總用量約 ${:.4}", total_cost());
            assert!(total_cost() < BUDGET_USD);
            pids.push(w.pid());
            w.stop();
        })
    }));
    // 收尾：只結束自己記下的 PID，刪自己留下的紀錄
    for r in recvs.iter_mut() {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
    cleanup_pids(&pids);
    if copied {
        let _ = std::fs::remove_file(&cli_dst);
    }
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

/// 同 drive，另外數 worker 輸出裡出現幾次「沒有轉交」的說法（只看輸出文字，不影響流程）
async fn drive_count(core: &mut Core, rx: &mut tokio::sync::mpsc::UnboundedReceiver<WorkerLine>, secs: u64, refusals: &mut u32, mut done: impl FnMut(&Core) -> bool) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(5);
    while std::time::Instant::now() < end {
        stage("recv");
        if let Ok(Some(l)) = tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv()).await {
            if let WorkerLine::Line(t) = &l {
                if t.contains("未轉交") || t.contains("用戶輪次") || t.contains("not a user turn") || t.contains("did not forward") {
                    *refusals += 1;
                }
            }
            stage("on_worker_line");
            core.on_worker_line(l, now()).await;
        }
        if last.elapsed() >= std::time::Duration::from_millis(1500) {
            last = std::time::Instant::now();
            stage("pull");
            let _ = tokio::time::timeout(std::time::Duration::from_secs(15), core.pull("e2e", now())).await;
            stage("tick");
            let _ = tokio::time::timeout(std::time::Duration::from_secs(15), core.tick(now())).await;
        }
        if core.retry_due(now()) {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(15), core.pull("e2e-retry", now())).await;
        }
        stage("done");
        if done(core) {
            return true;
        }
    }
    false
}

#[test]
#[ignore = "要真的 claude、會花用量（約 0.05～0.1 美元）；環境變數 ASN_E2E_ONE_PER_TURN=0 跑對照（關閉一輪一封），ASN_E2E_N 設總封數（預設 4）"]
fn e2e_一輪只交一封_處理第一封時再來幾封_依序交() {
    let one_per_turn = std::env::var("ASN_E2E_ONE_PER_TURN").map(|v| v != "0").unwrap_or(true);
    let n: u32 = std::env::var("ASN_E2E_N").ok().and_then(|v| v.parse().ok()).unwrap_or(4).clamp(2, 8);
    let exe = std::env::current_exe().unwrap();
    let cli_src = exe.parent().unwrap().parent().unwrap().join(if cfg!(windows) { "asn-cli.exe" } else { "asn-cli" });
    assert!(cli_src.is_file(), "先執行 cargo build --bin asn-cli");
    let cli_dst = exe.parent().unwrap().join(cli_src.file_name().unwrap());
    let copied = !cli_dst.exists() && std::fs::copy(&cli_src, &cli_dst).is_ok();

    let root = tempfile::Builder::new().prefix("gate-e2e-").tempdir().unwrap();
    let settings = root.path().join("recv-settings.json");
    std::fs::write(&settings, r#"{"crossSessionInbound":"accept"}"#).unwrap();
    let mut recvs: Vec<Recv> = vec![start_recv("T-gate-recv", &root.path().join("recv"), &settings)];
    let mut pids: Vec<u32> = recvs.iter().map(|r| r.child.id()).collect();
    let recv_pid = pids[0];
    let (rcv_n, cost) = (recvs[0].received.clone(), recvs[0].cost.clone());

    // 看門狗：整個測試超過 8 分鐘還沒結束，就只結束自己記下的 PID 後離開
    let worker_pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    {
        let (pids2, wp) = (pids.clone(), worker_pid.clone());
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(480));
            eprintln!("[e2e] 看門狗：逾時，結束自己啟動的程序");
            let mut all = pids2;
            if let Some(p) = *wp.lock().unwrap() {
                all.push(p);
            }
            cleanup_pids(&all);
            std::process::exit(3);
        });
    }
    let fr = FakeRelay::start();
    let work = tempfile::Builder::new().prefix("gate-e2e-work-").tempdir().unwrap();
    let mut c = cfg(work.path(), &claude_home().join("sessions"));
    c.mailbox_name = "T-gate-收發室".into();
    c.claude_bin = "claude".into();
    c.model = "haiku".into();
    c.default_agent = String::new();
    c.one_per_turn = one_per_turn;
    let relay = Arc::new(Relay::new(fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::rt::block_on(async {
            let nonce = crate::bridge::worker::new_nonce();
            let spec = WorkerSpec { bin: c.claude_bin.clone(), pre_args: vec![], mailbox_name: c.mailbox_name.clone(), model: c.model.clone(), work_dir: work.path().to_path_buf(), nonce: nonce.clone(), extra_env: vec![], respond: None };
            let (w, mut rx) = ProcWorker::spawn(spec, |_| {});
            *worker_pid.lock().unwrap() = Some(w.pid());
            let log = Arc::new(BridgeLog::new(Some(work.path().join("bridge.log"))));
            let alive: Arc<dyn Fn(u32) -> bool + Send + Sync> = Arc::new(crate::heartbeat::pid_alive);
            let mut core = Core::new(c.clone(), relay.clone(), Arc::new(w.clone()), &nonce, log, alive, now());
            core.refresh_roster(now()).await;
            core.roster.push(crate::bridge::roster::Window::claude("T-gate-recv", Some("idle".into()), "", recv_pid, now(), None));
            let put = |k: u32| fr.put(mail(k, json!({"to_agent": "T-gate-recv", "expects_reply": false, "body": format!("轉交測試信 {k}，請忽略")})));
            let mut refusals = 0u32;
            let t0 = std::time::Instant::now();
            put(1);
            // 第一封交給 worker（這一輪開始）之後，馬上再放後面幾封：模擬處理第一封時又來了信
            let started = drive_count(&mut core, &mut rx, 60, &mut refusals, |c| c.fwd_probe(&uid(1)).is_some()).await;
            assert!(started, "第一封沒交給 worker");
            let t_inject = t0.elapsed().as_secs_f64();
            for k in 2..=n {
                put(k);
            }
            let mut acked_at: Vec<Option<f64>> = vec![None; n as usize];
            let all = drive_count(&mut core, &mut rx, 300, &mut refusals, |_| {
                let a = fr.acked();
                for k in 1..=n {
                    if acked_at[(k - 1) as usize].is_none() && a.contains(&uid(k)) {
                        acked_at[(k - 1) as usize] = Some(t0.elapsed().as_secs_f64());
                    }
                }
                acked_at.iter().all(|x| x.is_some())
            })
            .await;
            drive_count(&mut core, &mut rx, 8, &mut refusals, |_| false).await; // 再等一下，看有沒有晚到的失敗通知
            let notes: Vec<String> = fr.sent().iter().map(|s| s["body"].as_str().unwrap_or("").to_string()).filter(|b| b.starts_with("[收發室]") || b.contains("轉交給")).collect();
            let order: Vec<String> = read(&work.path().join("bridge.log")).lines().filter(|l| l.contains("forwarded id=")).map(|l| l.split("forwarded id=").nth(1).unwrap_or("").split(' ').next().unwrap_or("").to_string()).collect();
            println!("---- 一輪只交一封實跑（one_per_turn={one_per_turn}，共 {n} 封，模型 haiku，標明：不一定代表正式收發室）----");
            println!("第一封交出去 {t_inject:.1} 秒後放入後面 {} 封", n - 1);
            for k in 1..=n {
                println!("信 {k}：{}", acked_at[(k - 1) as usize].map(|t| format!("{t:.1} 秒轉交完成（從放入起算）")).unwrap_or_else(|| "沒有轉交完成".into()));
            }
            println!("轉交順序（bridge.log）：{order:?}");
            println!("收件端收到 {} 次；轉交失敗／逾時通知 {} 則：{notes:?}；worker 輸出裡的『沒轉交』說法 {refusals} 次", get(&rcv_n), notes.len());
            println!("總用量約 ${:.4}", *cost.lock().unwrap());
            if one_per_turn {
                assert!(all, "有信沒轉交完成");
                assert!(notes.is_empty(), "不該有失敗通知：{notes:?}");
                assert_eq!(order, (1..=n).map(uid).collect::<Vec<_>>(), "依序轉交");
                assert_eq!(get(&rcv_n), n, "收件端每封都收到");
            }
            pids.push(w.pid());
            w.stop();
        })
    }));
    for r in recvs.iter_mut() {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
    cleanup_pids(&pids);
    if copied {
        let _ = std::fs::remove_file(&cli_dst);
    }
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

/// 只結束自己記下的 PID，刪自己留下的工作階段紀錄（~/.claude/sessions/<pid>.json）與暫存資料夾對應的 ~/.claude/projects 紀錄
fn cleanup_pids(pids: &[u32]) {
    for p in pids {
        let _ = crate::bridge::handoff::kill_pid(*p);
        let _ = std::fs::remove_file(claude_home().join("sessions").join(format!("{p}.json")));
    }
    if let Ok(rd) = std::fs::read_dir(claude_home().join("projects")) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().contains("gate-e2e") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}
