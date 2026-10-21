//! 第二段（群組、附件、孤兒、舊橋退出後接手）與第三段（遠端開視窗）的整合測試。
//! 對應 relay/machine/test 的 rooms.test.mjs、launcher.test.mjs、attach.test.mjs（橋端）、bridges.test.mjs（附件提示）。
//! 同樣只連 127.0.0.1 的假後端、假 worker、假視窗程式；工作資料夾都是暫存資料夾，不碰真的 bridge.pid。
use super::*;
use crate::nowin::NoWindow;
use crate::bridge::launcher::{self, LaunchEnv, Launched, Launcher};
use crate::bridge::rooms::{room_uuid, ROOM_HINT};
use crate::launch::config::{build_spawn_spec, canonical_launch_cwd, LaunchConfig, LaunchReq};
use crate::launch::profiles::{LaunchMode, Profile};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc::UnboundedReceiver;

// ---- 小工具 ----------------------------------------------------------------------------------------

/// 轉交給 worker 的指令拆開：（信件編號，收件視窗，外部資料區塊裡的文字）
fn fwd(said: &[String]) -> Vec<(String, String, String)> {
    said.iter()
        .map(|t| {
            let head = t.lines().next().unwrap();
            let id = head.split("id=").nth(1).unwrap().split(' ').next().unwrap().to_string();
            let to = head.split("to=").nth(1).unwrap().trim_end_matches(']').to_string();
            let body = t.split("<<<MAIL\n").nth(1).unwrap().rsplit_once("\nMAIL>>>").unwrap().0.to_string();
            (id, to, body)
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
fn room(messages: Vec<Value>, mine: Value) -> Value {
    json!({"id": "R1", "name": "專案群", "last_seq": messages.last().unwrap()["seq"], "mine": mine, "messages": messages})
}
fn set_rooms(h: &H, rooms: Vec<Value>) {
    h.fr.st.lock().unwrap().rooms = rooms;
}
fn reads(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().room_reads.clone()
}
fn posts(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().room_posts.clone()
}
fn cursor_file(h: &H) -> Value {
    serde_json::from_str(&std::fs::read_to_string(h.work.path().join("rooms-cursor.json")).unwrap_or_else(|_| "{}".into())).unwrap()
}
/// 重新建一個核心（模擬橋重啟），同一個工作資料夾
async fn restart(h: &mut H, now: u64) {
    h.core = new_core(&h.fr, h.work.path(), h.sessions.path(), h.sink.clone(), now);
    h.core.refresh_roster(now).await;
}

// ================================================================================================
// 附件
// ================================================================================================

#[tokio::test]
async fn 信帶附件_轉給視窗的文字多一行提示_替代文字行不重複_縮圖不轉交_沒附件的信原樣() {
    let mut h = harness(&[("T-乙", "idle")]).await;
    let att = json!({"id": uid(0x50), "kind": "image", "name": "cat.webp", "mime": "image/webp", "bytes": 183422, "width": 1536, "height": 2048, "thumb": "data:image/webp;base64,SECRETTHUMB", "expires_at": "x", "expired": false});
    h.fr.put(mail(1, json!({"body": "〔照片〕cat.webp\n看這隻", "attachments": [att], "expects_reply": false})));
    h.fr.put(mail(2, json!({"expects_reply": false})));
    h.core.pull("test", T0).await;
    let f = fwd(&h.said());
    assert_eq!(f.len(), 2);
    let lines: Vec<&str> = f[0].2.lines().collect();
    assert!(lines[0].starts_with("[RELAY 來信]"));
    assert_eq!(lines[1], "看這隻");
    assert_eq!(lines[2], format!("〔照片〕cat.webp（image/webp，179 KB，1536×2048）下載：/x/asn-cli attach --id {}", uid(0x50)));
    assert_eq!(lines.len(), 3);
    assert!(!h.said().join("\n").contains("SECRETTHUMB"));
    assert_eq!(f[1].2.lines().count(), 2, "沒附件的信：抬頭＋內文，沒有多餘的行");
}

// ================================================================================================
// 群組
// ================================================================================================

#[tokio::test]
async fn 群組_只轉_for_me_點名轉給對的視窗_標頭提示與上下文_回覆以視窗身分貼回_游標不重播() {
    let mut h = harness(&[("T-視窗甲", "idle"), ("T-甲", "idle")]).await;
    set_rooms(
        &h,
        vec![room(
            vec![
                rmsg(2, json!({})),                                                                                                  // 沒人 for_me
                rmsg(3, json!({"forMe": {"T-視窗甲": true}})),                                                                       // 點名視窗甲
                rmsg(4, json!({"from": "~owner", "from_name": "小良哥", "trust": "owner", "forMe": {"": true, "T-視窗甲": true}})),   // owner 發問
            ],
            json!([{"member": "T~T-視窗甲", "read_seq": 1}, {"member": "T", "read_seq": 1}]),
        )],
    );
    h.core.pull("test", T0).await;
    let f = fwd(&h.said());
    // 恰好 3 次轉交（#2 不轉）
    let key = |x: &(String, String, String)| format!("{}#{}", x.1, x.2.split(" #").nth(1).unwrap().split('\n').next().unwrap());
    let mut keys: Vec<String> = f.iter().map(key).collect();
    keys.sort();
    assert_eq!(keys, vec!["T-甲#4", "T-視窗甲#3", "T-視窗甲#4"]);
    // id 是確定性 UUID：節點本身用成員 key「T」，視窗用「T~視窗名」
    let d4 = f.iter().find(|x| key(x) == "T-甲#4").unwrap();
    assert_eq!(d4.0, room_uuid("R1", 4, "T"));
    assert_eq!(f.iter().find(|x| key(x) == "T-視窗甲#4").unwrap().0, room_uuid("R1", 4, "T~T-視窗甲"));
    // 標頭、提示、內文、上下文（前面最近的幾則，舊→新）、往回翻的指令
    let j3 = &f.iter().find(|x| key(x) == "T-視窗甲#3").unwrap().2;
    assert_eq!(j3, &format!("[群組 專案群] trust=member from=W/W-政策 #3\n{ROOM_HINT}\n群組內文-3\n---- 前面 1 則（舊→新）----\n#2 政策：群組內文-2\n（要看更多：/x/asn-cli room --room-read R1 --last 20）"));
    assert!(d4.2.contains("---- 前面 2 則（舊→新）----\n#2 政策：群組內文-2\n#3 政策：群組內文-3\n（要看更多"));
    assert!(d4.2.starts_with("[群組 專案群] trust=owner from=主人 #4\n"));
    // 所有 room_read 都帶 since、不帶 mark（不動後端已讀）；視窗帶 as_agent、節點本身不帶；起算點是 read_seq
    let rs = reads(&h);
    assert!(!rs.is_empty() && rs.iter().all(|r| !r["since"].is_null() && r["mark"].is_null()));
    assert!(rs.iter().any(|r| r["as_agent"] == "T-視窗甲" && r["since"] == 1));
    assert!(rs.iter().any(|r| r["as_agent"].is_null() && r["since"] == 1));
    // 轉交完成（worker 回 SENT）：群組訊息不 ack
    let ids: Vec<String> = f.iter().map(|x| x.0.clone()).collect();
    h.core.on_worker_line(res(&ids.iter().map(|i| format!("SENT {i}")).collect::<Vec<_>>().join("\n")), T0 + 10).await;
    assert!(h.fr.acked().is_empty(), "群組沒有信箱可 ack");
    // 回覆經收發室貼回群組：視窗成員帶視窗名、節點本身（成員 key＝T）不帶 from_agent
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "我來回覆")), T0 + 20).await;
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "我來回覆")), T0 + 21).await;
    h.core.on_worker_line(res(&reply_block("T-甲", "我來回覆")), T0 + 22).await;
    let p = posts(&h);
    assert_eq!(p.len(), 3);
    assert!(p.iter().all(|x| x["room"] == "R1" && x["body"] == "我來回覆"));
    let mut who: Vec<Option<String>> = p.iter().map(|x| x["from_agent"].as_str().map(String::from)).collect();
    who.sort();
    assert_eq!(who, vec![None, Some("T-視窗甲".into()), Some("T-視窗甲".into())]);
    assert!(h.fr.sent().is_empty(), "群組回覆不走一般寄信");
    // 游標推進到 last_seq，之後不再讀、不重播
    let c = cursor_file(&h);
    assert_eq!((c["R1|T~T-視窗甲"].as_u64(), c["R1|T"].as_u64()), (Some(4), Some(4)));
    let n = reads(&h).len();
    h.core.pull("test", T0 + 30).await;
    assert_eq!((fwd(&h.said()).len(), reads(&h).len()), (3, n));
}

#[tokio::test]
async fn 群組_沒有游標且_read_seq_為_0_從最新起算不補播_既有游標檔不重播_視窗不可轉交就略過並推進游標() {
    let mut h = harness(&[("T-視窗甲", "idle"), ("T-甲", "idle")]).await;
    std::fs::write(h.work.path().join("rooms-cursor.json"), json!({"R1|T~T-視窗甲": 2}).to_string()).unwrap();
    restart(&mut h, T0).await;
    set_rooms(
        &h,
        vec![room(
            vec![rmsg(2, json!({"forMe": {"T-視窗甲": true, "": true}})), rmsg(3, json!({"forMe": {"T-視窗甲": true, "": true, "T-不在": true}}))],
            json!([{"member": "T~T-視窗甲", "read_seq": 0}, {"member": "T", "read_seq": 0}, {"member": "T~T-不在", "read_seq": 1}]),
        )],
    );
    h.core.pull("test", T0).await;
    // 視窗甲：既有游標 2 → 只轉 #3；節點本身：無游標＋read_seq=0 → 從 last_seq=3 起算 → 不轉；T-不在：略過
    let f = fwd(&h.said());
    assert_eq!(f.iter().map(|x| x.1.as_str()).collect::<Vec<_>>(), vec!["T-視窗甲"]);
    assert!(f[0].2.starts_with("[群組 專案群] trust=member from=W/W-政策 #3\n"));
    let c = cursor_file(&h);
    assert_eq!((c["R1|T"].as_u64(), c["R1|T~T-不在"].as_u64()), (Some(3), Some(3)));
    assert!(h.core.log.has("window T-不在 not forwardable: skipped"));
}

#[tokio::test]
async fn 群組_回覆含不需回覆不貼回_貼回遇到_429_只記_log_不重試() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    h.core.pull("test", T0).await;
    let id = fwd(&h.said())[0].0.clone();
    h.core.on_worker_line(res(&format!("SENT {id}")), T0 + 1).await;
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "好的（不需回覆）")), T0 + 2).await;
    assert!(posts(&h).is_empty());
    assert!(h.core.log.has("marked no-reply: not posted"));
    // 429：試一次，不重試
    let mut g = harness(&[("T-視窗甲", "idle")]).await;
    g.fr.st.lock().unwrap().room_post_status = 429;
    set_rooms(&g, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    g.core.pull("test", T0).await;
    let id = fwd(&g.said())[0].0.clone();
    g.core.on_worker_line(res(&format!("SENT {id}")), T0 + 1).await;
    g.core.on_worker_line(res(&reply_block("T-視窗甲", "回覆內容")), T0 + 2).await;
    assert_eq!(posts(&g).len(), 1);
    assert!(g.core.log.has("rate-limited"));
    g.core.tick(T0 + 700_000).await;
    assert_eq!(posts(&g).len(), 1, "不會重試");
}

#[tokio::test]
async fn 群組_轉交失敗不回群組不留對應_worker_掛了游標不前進_逾時不寄通知() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    // worker 掛了：轉不出去，游標停在那則前面
    h.sink.down.store(true, Ordering::SeqCst);
    h.core.pull("test", T0).await;
    assert!(h.said().is_empty() && h.core.pending.is_empty());
    assert_eq!(cursor_file(&h)["R1|T~T-視窗甲"].as_u64(), Some(1), "游標不前進");
    assert!(h.core.log.has("cannot hand room=R1 #2"));
    // 好了：下一次拉會補轉
    h.sink.down.store(false, Ordering::SeqCst);
    h.core.pull("test", T0 + 1000).await;
    let id = fwd(&h.said())[0].0.clone();
    assert_eq!(cursor_file(&h)["R1|T~T-視窗甲"].as_u64(), Some(2));
    // FAIL：只記 log，不回群組、不寄信、不留對應
    h.core.on_worker_line(res(&format!("FAIL {id} 找不到視窗")), T0 + 2000).await;
    assert!(h.core.pending.is_empty() && posts(&h).is_empty() && h.fr.sent().is_empty() && h.fr.acked().is_empty());
    // 另一則：SENT 後一直沒人回 → 逾時直接清掉，不通知任何人
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}})), rmsg(3, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    h.core.pull("test", T0 + 3000).await;
    let id3 = fwd(&h.said()).last().unwrap().0.clone();
    h.core.on_worker_line(res(&format!("SENT {id3}")), T0 + 3001).await;
    h.core.tick(T0 + 3001 + 601_000).await;
    assert!(h.core.pending.is_empty() && h.fr.sent().is_empty() && posts(&h).is_empty());
}

#[tokio::test]
async fn 群組_橋重啟後還在等的群組訊息回覆仍貼得回_群組項目寫進_pending_json() {
    let mut h = harness(&[("T-視窗甲", "idle")]).await;
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"T-視窗甲": true}}))], json!([{"member": "T~T-視窗甲", "read_seq": 1}]))]);
    h.core.pull("test", T0).await;
    let id = fwd(&h.said())[0].0.clone();
    h.core.on_worker_line(res(&format!("SENT {id}")), T0 + 1).await;
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(h.work.path().join("pending.json")).unwrap()).unwrap();
    assert_eq!(saved["pending"][0]["room"], json!({"id": "R1", "seq": 2, "window": "T-視窗甲"}), "與 Node 橋同格式");
    restart(&mut h, T0 + 5000).await;
    assert_eq!(h.core.pending.len(), 1);
    h.core.on_worker_line(res(&reply_block("T-視窗甲", "重啟後才回")), T0 + 6000).await;
    let p = posts(&h);
    assert_eq!((p.len(), p[0]["body"].as_str(), p[0]["from_agent"].as_str()), (1, Some("重啟後才回"), Some("T-視窗甲")));
}

#[tokio::test]
async fn 群組_預設收件視窗不在線_節點本身的訊息改交最近有活動的視窗_都沒有就留著不前進() {
    let mut h = harness(&[("T-乙", "idle")]).await; // 預設 T-甲 不在線
    set_rooms(&h, vec![room(vec![rmsg(2, json!({"forMe": {"": true}}))], json!([{"member": "T", "read_seq": 1}]))]);
    h.core.pull("test", T0).await;
    let f = fwd(&h.said());
    assert_eq!(f[0].1, "T-乙");
    assert!(f[0].2.contains("[收發室] 這封信原本要給「T-甲」，但它不在線，請你（T-乙）代收並轉告／處理。"), "有代收說明：{}", f[0].2);
    let mut g = harness(&[]).await;
    set_rooms(&g, vec![room(vec![rmsg(2, json!({"forMe": {"": true}}))], json!([{"member": "T", "read_seq": 1}]))]);
    g.core.pull("test", T0).await;
    assert!(g.said().is_empty());
    assert_eq!(cursor_file(&g)["R1|T"].as_u64(), Some(1));
}

// ================================================================================================
// 孤兒清理（真的程序）
// ================================================================================================

/// 讓測試執行檔扮成「上一個橋」：啟動一個孫子程序（模擬被硬砍後留下的 worker）、印出它的 pid、自己馬上結束。
#[test]
fn fake_orphan_parent() {
    if std::env::var("ASN_FAKE_ORPHAN").ok().as_deref() != Some("1") {
        return;
    }
    let mut c = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.no_window().args(["/c", "ping -n 60 127.0.0.1 >nul"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.no_window().arg("60");
        c
    };
    // 跟父程序的主控台脫鉤（DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP），父程序結束時它才不會跟著走
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0000_0008 | 0x0000_0200);
    let child = c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    // 第一行孫子（孤兒）的 pid、第二行自己（上一個橋）的 pid：Linux 上孤兒會改掛 init，從程序表讀不到原本的父 pid
    std::fs::write(std::env::var("ASN_ORPHAN_OUT").unwrap(), format!("{}
{}", child.id(), std::process::id())).unwrap();
    // 不等孫子：自己結束，孫子就成了孤兒
}

#[test]
fn 孤兒清理_上一個橋被硬砍後留下的_worker_被收掉_別的程序不碰() {
    let work = tempfile::tempdir().unwrap();
    let out_file = work.path().join("orphan-pid.txt");
    let st = std::process::Command::new(std::env::current_exe().unwrap())
        .no_window()
        .args(["--exact", "bridge::tests::rooms_launch::fake_orphan_parent", "--nocapture"])
        .env("ASN_FAKE_ORPHAN", "1")
        .env("ASN_ORPHAN_OUT", &out_file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("啟動假的上一個橋");
    assert!(st.success());
    let written = std::fs::read_to_string(&out_file).expect("假的上一個橋寫出孤兒 pid");
    let mut it = written.lines().map(|l| l.trim().parse::<u32>().unwrap());
    let (orphan, dead_parent) = (it.next().unwrap(), it.next().unwrap());
    let table = super::super::orphans::process_table();
    assert!(table.contains_key(&orphan), "孤兒還活著");
    assert!(!table.contains_key(&dead_parent), "它的父程序（上一個橋）已經結束");
    std::fs::write(super::super::orphans::last_file(work.path()), dead_parent.to_string()).unwrap();
    std::fs::write(super::super::lock::mailbox_pid_file(work.path()), orphan.to_string()).unwrap();
    // 另一個無關的程序（同樣記不到 mailbox.pid）不能被碰：用自己開的一個子程序當對照，記下它的 pid
    let mut bystander = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.no_window().args(["/c", "ping -n 30 127.0.0.1 >nul"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.no_window().arg("30");
        c
    }
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .unwrap();
    let logs = super::super::orphans::cleanup_and_mark(work.path(), std::process::id(), super::super::orphans::process_table, super::super::orphans::kill_tree);
    let mut gone = false;
    for _ in 0..50 {
        if !crate::heartbeat::pid_alive(orphan) {
            gone = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let bystander_alive = bystander.try_wait().unwrap().is_none();
    // 收尾：只結束自己記下的程序
    let _ = bystander.kill();
    let _ = bystander.wait();
    if !gone {
        super::super::orphans::kill_tree(orphan);
    }
    assert!(gone, "孤兒 worker 被收掉。log={logs:?}");
    assert!(logs.iter().any(|l| l.contains(&format!("killed orphan pid={orphan}"))), "{logs:?}");
    assert!(bystander_alive, "沒有記在 mailbox.pid 的程序不碰");
    assert_eq!(std::fs::read_to_string(super::super::orphans::last_file(work.path())).unwrap(), std::process::id().to_string(), "記下自己的 pid");
}

// ================================================================================================
// 遠端開視窗
// ================================================================================================

/// 假的本機設定與假視窗程式：start 之後過 appear_after 毫秒，在 sessions 資料夾寫出新視窗的 session 檔
struct FakeEnv {
    sessions: PathBuf,
    allow: Vec<PathBuf>,
    max_per_hour: u32,
    appear: bool,
    appear_after_ms: u64,
    fail_start: bool,
    config_err: Mutex<Option<String>>,
    started: Mutex<Vec<(String, String, String)>>,
    /// start 時實際會執行的命令（取自本機設定，展開 {name} 後）
    commands: Mutex<Vec<(String, Vec<String>)>>,
}
impl FakeEnv {
    fn new(sessions: &Path, allow: &Path) -> Arc<FakeEnv> {
        Arc::new(FakeEnv {
            sessions: sessions.to_path_buf(),
            allow: vec![canonical_launch_cwd(&allow.to_string_lossy()).unwrap()],
            max_per_hour: 6,
            appear: true,
            appear_after_ms: 0,
            fail_start: false,
            config_err: Mutex::new(None),
            started: Mutex::new(vec![]),
            commands: Mutex::new(vec![]),
        })
    }
    fn with(sessions: &Path, allow: &Path, f: impl FnOnce(&mut FakeEnv)) -> Arc<FakeEnv> {
        let mut e = Arc::try_unwrap(FakeEnv::new(sessions, allow)).ok().unwrap();
        f(&mut e);
        Arc::new(e)
    }
}
impl LaunchEnv for FakeEnv {
    fn config(&self, _fresh: bool) -> Result<LaunchConfig, String> {
        if let Some(e) = self.config_err.lock().unwrap().clone() {
            return Err(e);
        }
        let mut profiles = std::collections::HashMap::new();
        profiles.insert(
            "claude".to_string(),
            Profile { label: "Claude（互動視窗）".into(), command: "C:\\fake\\claude.exe".into(), args: vec!["-n".into(), "{name}".into(), "--remote-control".into(), "{name}".into()], engine: "claude".into(), mode: LaunchMode::Window, disabled: false, disabled_reason: String::new() },
        );
        Ok(LaunchConfig { profiles, cwd_allow: self.allow.clone(), max_per_hour: self.max_per_hour })
    }
    fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str) -> Result<u32, String> {
        let (cmd, args, _) = build_spawn_spec(config, &LaunchReq { profile, name, cwd: cwd.to_string() })?;
        self.commands.lock().unwrap().push((cmd, args));
        self.started.lock().unwrap().push((profile.into(), name.into(), cwd.into()));
        if self.fail_start {
            return Err("找不到執行檔".into());
        }
        if self.appear {
            let (dir, name, ms) = (self.sessions.clone(), name.to_string(), self.appear_after_ms);
            let n = self.started.lock().unwrap().len() as u32;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                put_session(&dir, 6000 + n, &name, "idle", 500);
            });
        }
        Ok(4242)
    }
}

struct LH {
    h: H,
    env: Arc<FakeEnv>,
    rx: UnboundedReceiver<Launched>,
    proj: tempfile::TempDir,
}

async fn lharness(make: impl FnOnce(&Path, &Path) -> Arc<FakeEnv>, timing: (u64, u64, u64)) -> LH {
    let mut h = harness(&[("T-甲", "idle")]).await;
    let proj = tempfile::tempdir().unwrap();
    let env = make(h.sessions.path(), proj.path());
    let relay = Arc::new(Relay::new(h.fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let sessions = h.sessions.path().to_path_buf();
    let names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(move || Some(super::super::roster::read_sessions(&sessions, |p| p < 90_000, 0, "T-收發室")?.into_iter().map(|w| w.name).collect()));
    let (l, rx) = Launcher::new_with(relay, h.core.log.clone(), h.work.path().to_path_buf(), env.clone(), names, timing);
    h.core.set_launcher(l);
    LH { h, env, rx, proj }
}
fn lreq(n: u32, name: &str, cwd: &Path, extra: Value) -> Value {
    let mut v = json!({"id": uid(n), "requested_by": "XISU", "profile": "claude", "name": name, "cwd": cwd.display().to_string(), "first_message": null});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}
fn results(h: &H) -> Vec<Value> {
    h.fr.st.lock().unwrap().launch_results.clone()
}
async fn wait_until(f: impl Fn() -> bool) {
    let t = std::time::Instant::now();
    while !f() && t.elapsed() < std::time::Duration::from_secs(10) {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(f(), "條件在 10 秒內沒達成");
}

#[tokio::test]
async fn 遠端開視窗_取走_開視窗_出現在名單_回報_ok_名單附摘要_第一句話經收發室送進新視窗() {
    let mut l = lharness(|s, p| FakeEnv::new(s, p), (30_000, 60_000, 20)).await;
    // 遠端請求夾帶 command／args／env 欄位：一律不採用，開出來的命令只來自本機設定
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(7, "T-英雄-2", &cwd, json!({"first_message": "先讀交接檔", "command": "calc.exe", "args": ["/c", "evil"], "env": {"X": "1"}})));
    l.h.core.pull("bell", T0).await;
    wait_until(|| !results(&l.h).is_empty()).await;
    assert_eq!(results(&l.h), vec![json!({"id": uid(7), "status": "ok", "detail": "T-英雄-2 已開啟"})]);
    let started = l.env.started.lock().unwrap().clone();
    assert_eq!(started.len(), 1);
    assert_eq!((started[0].0.as_str(), started[0].1.as_str()), ("claude", "T-英雄-2"));
    assert_eq!(l.env.commands.lock().unwrap()[0], ("C:\\fake\\claude.exe".to_string(), ["-n", "T-英雄-2", "--remote-control", "T-英雄-2"].map(String::from).to_vec()), "命令只來自本機設定");
    // 視窗出現後：事件交回核心 → 刷新名單 → 第一句話當成 owner 來信送進新視窗
    let ev = tokio::time::timeout(std::time::Duration::from_secs(5), l.rx.recv()).await.unwrap().unwrap();
    assert_eq!((ev.id.as_str(), ev.name.as_str(), ev.requested_by.as_str(), ev.first_message.as_deref()), (uid(7).as_str(), "T-英雄-2", "XISU", Some("先讀交接檔")));
    l.h.core.on_launched(ev, T0 + 100).await;
    let f = fwd(&l.h.said());
    assert_eq!(f.len(), 1);
    assert_eq!((f[0].0.as_str(), f[0].1.as_str()), (uid(7).as_str(), "T-英雄-2"));
    assert!(f[0].2.starts_with("[RELAY 來信] trust=owner from=XISU/ to=T-英雄-2 id="), "{}", f[0].2);
    assert!(f[0].2.contains("先讀交接檔"));
    // 名單：新視窗在上面；launcher 摘要有 profile／cwd／上限，沒有指令
    let rosters = l.h.fr.rosters();
    let last = rosters.last().unwrap();
    assert!(last["agents"].as_array().unwrap().iter().any(|a| a["name"] == "T-英雄-2"), "新視窗要出現在名單上");
    let cwd_norm = crate::launch::cwds::norm_path(&canonical_launch_cwd(&cwd.to_string_lossy()).unwrap().to_string_lossy()).unwrap();
    assert_eq!(last["launcher"], json!({"profiles": [{"id": "claude", "label": "Claude（互動視窗）"}], "cwd_allow": [cwd_norm], "max_per_hour": 6}));
    assert!(!rosters.iter().any(|r| r.to_string().contains("fake\\\\claude") || r.to_string().contains("remote-control")), "名單不含指令");
    // 紀錄
    let log = std::fs::read_to_string(l.h.work.path().join("launch.log")).unwrap();
    let st: Vec<String> = log.lines().map(|x| serde_json::from_str::<Value>(x).unwrap()["status"].as_str().unwrap().to_string()).collect();
    assert_eq!(st, vec!["spawned", "ok"]);
}

#[tokio::test]
async fn 遠端開視窗_驗不過就不開_cwd不在白名單_重名_沒有這個設定_名字格式_同一筆只處理一次() {
    let mut l = lharness(|s, p| FakeEnv::new(s, p), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    let outside = tempfile::tempdir().unwrap();
    {
        let mut st = l.h.fr.st.lock().unwrap();
        st.launches.push(lreq(1, "T-新1", outside.path(), json!({})));
        st.launches.push(lreq(2, "t-甲", &cwd, json!({})));                    // 與現有視窗 T-甲 重名（不分大小寫）
        st.launches.push(lreq(3, "T-新3", &cwd, json!({"profile": "evil"})));
        st.launches.push(lreq(3, "T-新3", &cwd, json!({"profile": "evil"})));  // 同一筆 id 再來一次
        st.launches.push(lreq(4, "a&calc", &cwd, json!({})));
        st.launches.push(lreq(5, "-rf", &cwd, json!({})));
        st.launches.push(lreq(6, "T-新6", &cwd.join(".."), json!({})));        // 想用 .. 跳出白名單
    }
    l.h.core.pull("bell", T0).await;
    let r = results(&l.h);
    assert_eq!(r.len(), 7 - 1, "每筆 id 只回報一次：{r:?}");
    assert!(r.iter().all(|x| x["status"] == "failed"));
    let detail = |n: u32| r.iter().find(|x| x["id"] == uid(n).as_str()).unwrap()["detail"].as_str().unwrap().to_string();
    assert!(detail(1).contains("不在允許清單"));
    assert!(detail(2).contains("已經有叫「t-甲」的視窗"));
    assert!(detail(3).contains("沒有這個啟動設定"));
    assert!(detail(4).contains("視窗名格式不對") && detail(5).contains("視窗名格式不對"));
    assert!(detail(6).contains("不在允許清單"));
    assert!(l.env.started.lock().unwrap().is_empty(), "一個都不能開");
    assert!(!l.h.work.path().join("launch-history.json").exists(), "沒開就不計入每小時次數");
}

#[tokio::test]
async fn 遠端開視窗_開不起來回報_failed_本機沒有啟動設定回報原因_名單的_launcher_是_null() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.fail_start = true), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "T-新1", &cwd, json!({})));
    l.h.core.pull("bell", T0).await;
    assert_eq!(results(&l.h), vec![json!({"id": uid(1), "status": "failed", "detail": "開不起來：找不到執行檔"})]);
    // 沒有可用設定（沒同意、沒有 launcher.json）
    *l.env.config_err.lock().unwrap() = Some(launcher::NO_CONFIG.into());
    l.h.fr.st.lock().unwrap().launches.push(lreq(2, "T-新2", &cwd, json!({})));
    l.h.core.pull("bell", T0 + 1).await;
    assert_eq!(results(&l.h)[1], json!({"id": uid(2), "status": "failed", "detail": launcher::NO_CONFIG}));
    l.h.core.refresh_roster(T0 + 2).await;
    assert_eq!(l.h.fr.rosters().last().unwrap()["launcher"], Value::Null, "沒有設定就送 null，仲介會清掉，別台不顯示開新夥伴");
}

#[tokio::test]
async fn 遠端開視窗_太久沒出現先回_unconfirmed_之後出現再補_ok() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.appear_after_ms = 400), (150, 5_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    l.h.fr.st.lock().unwrap().launches.push(lreq(1, "T-新1", &cwd, json!({"first_message": "嗨"})));
    l.h.core.pull("bell", T0).await;
    wait_until(|| results(&l.h).len() >= 2).await;
    let r = results(&l.h);
    assert_eq!((r[0]["status"].as_str(), r[0]["detail"].as_str()), (Some("unconfirmed"), Some(launcher::TRUST_HINT)));
    assert_eq!(r[1]["status"], "ok");
    assert_eq!(l.rx.recv().await.unwrap().name, "T-新1");
    // 一直沒出現：放棄，不回 ok
    let mut g = lharness(|s, p| FakeEnv::with(s, p, |e| e.appear = false), (50, 300, 20)).await;
    let cwd = g.proj.path().to_path_buf();
    g.h.fr.st.lock().unwrap().launches.push(lreq(1, "T-新1", &cwd, json!({})));
    g.h.core.pull("bell", T0).await;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    assert_eq!(results(&g.h).iter().map(|x| x["status"].as_str().unwrap()).collect::<Vec<_>>(), vec!["unconfirmed"]);
    assert!(g.h.core.log.has("gave-up") || std::fs::read_to_string(g.h.work.path().join("launch.log")).unwrap().contains("gave-up"));
}

#[tokio::test]
async fn 遠端開視窗_每小時上限_存在_launch_history_json_重啟也算() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.max_per_hour = 2), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    std::fs::write(l.h.work.path().join("launch-history.json"), json!([now - 1000, now - 4_000_000]).to_string()).unwrap();
    {
        let mut st = l.h.fr.st.lock().unwrap();
        st.launches.push(lreq(1, "T-新1", &cwd, json!({})));
        st.launches.push(lreq(2, "T-新2", &cwd, json!({})));
    }
    l.h.core.pull("bell", T0).await;
    wait_until(|| results(&l.h).len() >= 2).await;
    let r = results(&l.h);
    let mut st: Vec<&str> = r.iter().map(|x| x["status"].as_str().unwrap()).collect();
    st.sort();
    assert_eq!(st, vec!["failed", "ok"], "一小時前的不算，剩一個名額");
    assert!(r.iter().find(|x| x["status"] == "failed").unwrap()["detail"].as_str().unwrap().contains("超過上限"));
    assert_eq!(l.env.started.lock().unwrap().len(), 1);
    let h2: Vec<u64> = serde_json::from_str(&std::fs::read_to_string(l.h.work.path().join("launch-history.json")).unwrap()).unwrap();
    assert_eq!(h2.len(), 2, "一小時前的被清掉，新開的記上去");
}

#[tokio::test]
async fn 遠端開視窗_兩個同名請求同時在等時第二個算重名() {
    let mut l = lharness(|s, p| FakeEnv::with(s, p, |e| e.appear = false), (30_000, 60_000, 20)).await;
    let cwd = l.proj.path().to_path_buf();
    {
        let mut st = l.h.fr.st.lock().unwrap();
        st.launches.push(lreq(1, "T-同名", &cwd, json!({})));
        st.launches.push(lreq(2, "t-同名", &cwd, json!({})));
    }
    l.h.core.pull("bell", T0).await;
    let r = results(&l.h);
    assert_eq!(r.len(), 1);
    assert!(r[0]["detail"].as_str().unwrap().contains("已經有叫"));
    assert_eq!(l.env.started.lock().unwrap().len(), 1);
}

/// 守門：遠端請求裡只有 profile／name／cwd（與 first_message 當內容、id 當編號）會被讀；指令、參數、環境一律不從請求拿
#[test]
fn 守門_啟動請求的處理程式不讀任何指令類欄位() {
    let src = include_str!("../launcher.rs");
    let body = src.split("#[cfg(test)]").next().unwrap();
    for field in ["\"command\"", "\"args\"", "\"env\"", "\"cmd\"", "\"script\"", "\"shell\""] {
        for line in body.lines().filter(|l| l.contains(".get(") && !l.trim_start().starts_with("//")) {
            assert!(!line.contains(field), "launcher.rs 不應該從請求讀 {field}：{line}");
        }
    }
    // 開視窗只收這四個值
    assert!(body.contains("env.start(&cfg2, &p2, &n2, &c2)"));
}

// ---- 真的開一個（隱藏的）視窗：假視窗程式是測試執行檔自己 ----------------------------------------------------

/// 假視窗程式：被 `--exact bridge::tests::rooms_launch::fake_window --nocapture asn-fake-window-marker <名字> <sessions 資料夾> <記錄檔>` 啟動時，
/// 把自己登記成一個互動式 session、記下收到的參數與工作資料夾，停幾秒後結束。命令列沒有那個標記（平常跑測試）什麼都不做。
#[test]
fn fake_window() {
    let args: Vec<String> = std::env::args().collect();
    let Some(m) = args.iter().position(|a| a == "asn-fake-window-marker") else { return };
    let (name, sessions, record) = (args[m + 1].clone(), args[m + 2].clone(), args[m + 3].clone());
    let cwd = std::env::current_dir().unwrap().display().to_string();
    std::fs::write(&record, json!({"name": name, "cwd": cwd, "leaked_claude_env": std::env::vars().filter(|(k, _)| k.to_uppercase().starts_with("CLAUDE")).count()}).to_string()).unwrap();
    put_session(Path::new(&sessions), std::process::id(), &name, "idle", 700);
    std::thread::sleep(std::time::Duration::from_secs(4));
}

/// 真的走 Start-Process／隱藏視窗那條路（Windows）：確認參數、工作資料夾都對，視窗出現在名單後回報 ok。結束時只關自己記下的那一棵程序。
#[cfg(windows)]
#[tokio::test]
async fn 遠端開視窗_真的開一個隱藏視窗_假視窗程式登記成_session_後回報_ok() {
    struct RealEnv {
        cfg: LaunchConfig,
        pids: Mutex<Vec<u32>>,
    }
    impl LaunchEnv for RealEnv {
        fn config(&self, _f: bool) -> Result<LaunchConfig, String> {
            Ok(self.cfg.clone())
        }
        fn start(&self, config: &LaunchConfig, profile: &str, name: &str, cwd: &str) -> Result<u32, String> {
            let pid = crate::launch::local::start_remote_window(config, profile, name, cwd, true)?;
            self.pids.lock().unwrap().push(pid);
            Ok(pid)
        }
    }
    let mut h = harness(&[]).await;
    let proj = tempfile::tempdir().unwrap();
    let record = h.work.path().join("window-record.json");
    let exe = std::env::current_exe().unwrap().display().to_string();
    let mut profiles = std::collections::HashMap::new();
    profiles.insert(
        "claude".to_string(),
        Profile {
            label: "假".into(),
            command: exe,
            // engine 不是 claude：不會去改真的 ~/.claude.json
            engine: "fake".into(),
            args: ["--exact", "bridge::tests::rooms_launch::fake_window", "--nocapture", "asn-fake-window-marker", "{name}"].iter().map(|s| s.to_string()).chain([h.sessions.path().display().to_string(), record.display().to_string()]).collect(),
            mode: LaunchMode::Window,
            disabled: false,
            disabled_reason: String::new(),
        },
    );
    let env = Arc::new(RealEnv { cfg: LaunchConfig { profiles, cwd_allow: vec![canonical_launch_cwd(&proj.path().to_string_lossy()).unwrap()], max_per_hour: 3 }, pids: Mutex::new(vec![]) });
    let relay = Arc::new(Relay::new(h.fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let sessions = h.sessions.path().to_path_buf();
    let names: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(move || Some(super::super::roster::read_sessions(&sessions, crate::heartbeat::pid_alive, 0, "T-收發室")?.into_iter().map(|w| w.name).collect()));
    let (l, mut rx) = Launcher::new_with(relay, h.core.log.clone(), h.work.path().to_path_buf(), env.clone(), names, (60_000, 90_000, 100));
    h.core.set_launcher(l);
    h.fr.st.lock().unwrap().launches.push(lreq(1, "T-真窗", proj.path(), json!({"first_message": "你好"})));
    h.core.pull("bell", T0).await;
    let ev = tokio::time::timeout(std::time::Duration::from_secs(60), rx.recv()).await;
    // 先把自己開的視窗收掉（只關記下的 PID），再檢查結果
    let pids = env.pids.lock().unwrap().clone();
    let rec = std::fs::read_to_string(&record).unwrap_or_default();
    for p in &pids {
        super::super::orphans::kill_tree(*p);
    }
    let ev = ev.expect("60 秒內視窗出現在名單上").unwrap();
    assert_eq!((ev.name.as_str(), ev.first_message.as_deref()), ("T-真窗", Some("你好")));
    assert_eq!(results(&h), vec![json!({"id": uid(1), "status": "ok", "detail": "T-真窗 已開啟"})]);
    let rec: Value = serde_json::from_str(&rec).unwrap();
    assert_eq!(rec["name"], "T-真窗");
    let want = crate::launch::cwds::norm_path(&canonical_launch_cwd(&proj.path().to_string_lossy()).unwrap().to_string_lossy()).unwrap();
    assert_eq!(rec["cwd"].as_str().unwrap().to_lowercase(), want.to_lowercase(), "視窗在指定的工作資料夾開");
}

// ================================================================================================
// 設定與舊橋退出後接手
// ================================================================================================

#[test]
fn 設定_允許遠端開視窗預設關_來回一致() {
    let d = tempfile::tempdir().unwrap();
    assert!(!super::super::read_settings(d.path()).allow_remote_launch);
    super::super::write_settings(d.path(), super::super::BridgeSettings { enabled: true, allow_takeover: false, allow_remote_launch: true }).unwrap();
    let s = super::super::read_settings(d.path());
    assert!(s.enabled && s.allow_remote_launch && !s.allow_takeover);
    // 舊版寫的檔（沒有這個欄位）當作關
    std::fs::write(super::super::settings_path(d.path()), r#"{"enabled":true,"allow_takeover":false}"#).unwrap();
    assert!(!super::super::read_settings(d.path()).allow_remote_launch);
}

#[test]
fn 管理器_舊橋退出後自動接手_設定關著或舊橋還在就不動() {
    let fr = FakeRelay::start();
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    let record = work.path().join("record.jsonl");
    let relay = Arc::new(Relay::new(fr.url.clone(), "fake-test-key".into(), "T".into(), "T-ASN".into()));
    let (sess, rec) = (sessions.path().to_path_buf(), record.clone());
    let m = super::super::Manager::new(Some(relay), None, "T".into(), work.path().to_path_buf(), data.path().to_path_buf()).with_test_hooks(
        Some(FakeEnv::new(sessions.path(), data.path())),
        Box::new(move |c| {
            // 假 claude（測試執行檔自己），不碰真的 claude
            c.claude_bin = std::env::current_exe().unwrap().display().to_string();
            c.claude_pre = ["--exact", "bridge::tests::fake_claude_child", "--nocapture", "--"].iter().map(|s| s.to_string()).collect();
            c.extra_env = vec![("ASN_FAKE_CLAUDE".into(), "1".into()), ("FAKE_RECORD".into(), rec.display().to_string())];
            c.sessions_dir = sess.clone();
            c.poll_ms = 100;
            c.roster_ms = 100;
            c.tick_ms = 100;
        }),
    );
    // 假的舊橋：自己開的一個長壽命子程序，pid 寫進 bridge.pid
    let old = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.no_window().args(["/c", "ping -n 60 127.0.0.1 >nul"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.no_window().arg("60");
        c
    }
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .unwrap();
    std::fs::write(super::super::lock::pid_file(work.path()), old.id().to_string()).unwrap();
    let old = Mutex::new(Some(old));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        tauri::async_runtime::block_on(async {
            // 設定關著：什麼都不做，連輪詢接手也不動
            m.start_if_enabled();
            m.poll_handoff();
            assert!(!m.status().running);
            super::super::write_settings(data.path(), super::super::BridgeSettings { enabled: true, ..Default::default() }).unwrap();
            m.start_if_enabled();
            let st = m.status();
            assert!(st.enabled && !st.running && st.legacy, "舊橋在跑：讓步 {st:?}");
            m.poll_handoff();
            assert!(!m.status().running, "舊橋還在：不搶");
            // 舊橋退出（只結束自己開的這個）
            if let Some(mut c) = old.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            } // 放掉子程序的 handle：Windows 上 handle 還在，已結束的程序 pid 還會被當成活著
            for _ in 0..50 {
                m.poll_handoff();
                if m.status().running {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            let st = m.status();
            assert!(st.running && !st.legacy, "舊橋退出後自動接手 {st:?}");
            assert_eq!(super::super::lock::read_pid(&super::super::lock::pid_file(work.path())), Some(std::process::id()));
            m.stop();
            assert!(!super::super::lock::pid_file(work.path()).exists());
            // 關掉設定後不會再自己啟動
            super::super::write_settings(data.path(), super::super::BridgeSettings::default()).unwrap();
            m.poll_handoff();
            assert!(!m.status().running);
        })
    }));
    if let Some(mut c) = old.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    m.stop();
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}
