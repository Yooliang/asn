//! 由 recv.test.mjs 改寫：只收寄給本視窗名的信、每封一行 JSON、ack、--watch 心跳／單一實例／退避重試／視窗不在就結束
use super::*;
use crate::cli::recv::{iso, parse_args, to_line};
use std::io::Write;
use std::sync::Mutex;

fn mail(n: u32, to_agent: &str) -> Value {
    json!({"id": uid(n), "from_node": "W", "from_agent": "W-政策", "to_node": "T", "to_agent": to_agent, "body": format!("信{n}"), "reply_to": null, "created_at": "2026-10-02T00:00:00Z", "trust": "member", "acked": false})
}

/// 假仲介：filter_agent=true 照新版只回 to_agent＝agent 的信；false 模擬還沒部署新版（忽略 agent，回整個節點信箱）
struct Inbox {
    mails: Arc<Mutex<Vec<Value>>>,
    fail_first: Arc<AtomicUsize>,
}
fn inbox_backend(filter_agent: bool, fail_first_inbox: usize) -> (Fake, Inbox) {
    let mails: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![]));
    let fail_first = Arc::new(AtomicUsize::new(fail_first_inbox));
    let (m2, f2) = (mails.clone(), fail_first.clone());
    let fake = Fake::start(move |req: &Req, _| {
        let agent = req.param("agent");
        match req.action().as_str() {
            "whoami" => Resp::ok(json!({"node": "T", "bell_topic": "bell-test"})),
            "inbox" => {
                if f2.load(Ordering::SeqCst) > 0 {
                    f2.fetch_sub(1, Ordering::SeqCst);
                    return Resp::json(500, json!({"error": "boom"}));
                }
                let v: Vec<Value> = m2.lock().unwrap().iter().filter(|m| m["acked"] == false && (!filter_agent || agent.is_none() || m["to_agent"].as_str() == agent.as_deref())).cloned().collect();
                Resp::ok(json!({"messages": v}))
            }
            "ack" => {
                let ids: Vec<String> = req.json()["ids"].as_array().unwrap().iter().map(|i| i.as_str().unwrap().to_string()).collect();
                let mut n = 0;
                for m in m2.lock().unwrap().iter_mut() {
                    if m["acked"] == false && ids.contains(&m["id"].as_str().unwrap().to_string()) {
                        m["acked"] = json!(true);
                        n += 1;
                    }
                }
                Resp::ok(json!({"acked": n}))
            }
            _ => Resp::json(404, json!({})),
        }
    });
    (fake, Inbox { mails, fail_first })
}

#[test]
fn 參數_once_與_watch_二選一() {
    let p = |a: &[&str]| parse_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert!(p(&["--once"]).unwrap().once && p(&["--watch"]).unwrap().watch);
    for bad in [&[][..], &["--once", "--watch"][..]] {
        let e = p(bad).unwrap_err();
        assert!(e.code == 1 && e.msg.contains("三選一"));
    }
    let both = p(&["--once", "--peek"]).unwrap_err();
    assert!(both.code == 1 && both.msg.contains("三選一"));
    assert!(p(&["--x"]).unwrap_err().msg.contains("不認得的參數 --x"));
    assert!(p(&["--help"]).unwrap().help);
}

#[test]
fn once_只印寄給本視窗的信_一行_json_欄位順序固定_印完_ack_別人的信不印不_ack() {
    let (fake, inb) = inbox_backend(false, 0); // 後端沒過濾：本程式要再擋一次
    let f = fx(&fake.url(), Some("T-視窗甲"));
    *inb.mails.lock().unwrap() = vec![mail(1, "T-視窗甲"), mail(2, "T-視窗乙"), mail(3, "T-視窗甲")];
    let (c, out, err) = go(&f.env, &["recv", "--once"], "");
    assert_eq!(c, 0, "{err}");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "{out}");
    assert!(lines[0].starts_with(&format!("{{\"id\":\"{}\",\"trust\":\"member\",\"from_node\":\"W\",\"from_agent\":\"W-政策\",\"to_agent\":\"T-視窗甲\",\"reply_to\":null,\"created_at\":\"2026-10-02T00:00:00Z\",\"expects_reply\":null,\"body\":\"信1\"}}", uid(1))), "{}", lines[0]);
    let j: Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!((j["id"].as_str(), j["body"].as_str()), (Some(uid(3).as_str()), Some("信3")));
    let acks = fake.of("ack");
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0].json(), json!({"ids": [uid(1), uid(3)]}));
    assert_eq!(acks[0].param("agent").as_deref(), Some("T-視窗甲"));
    let m = inb.mails.lock().unwrap();
    assert_eq!((m[0]["acked"].as_bool(), m[1]["acked"].as_bool(), m[2]["acked"].as_bool()), (Some(true), Some(false), Some(true)));
    // 讀取請求都帶機器金鑰與視窗名
    assert!(fake.of("inbox").iter().all(|r| r.headers.get("x-relay-key").map(String::as_str) == Some(KEY) && r.param("agent").as_deref() == Some("T-視窗甲")));
}

#[test]
fn once_有附件_body_多一行下載指令_另有_attachments_欄位_不含縮圖() {
    let (fake, inb) = inbox_backend(true, 0);
    let f = fx(&fake.url(), Some("T-視窗甲"));
    let mut m = mail(1, "T-視窗甲");
    m["body"] = json!("〔照片〕cat.webp\n看這隻");
    m["expects_reply"] = json!(true);
    m["attachments"] = json!([{"id": uid(50), "kind": "image", "name": "cat.webp", "mime": "image/webp", "bytes": 183422, "width": 1536, "height": 2048, "thumb": "data:image/webp;base64,AAAA", "evil": "x"}]);
    *inb.mails.lock().unwrap() = vec![m];
    let (c, out, _) = go(&f.env, &["recv", "--once"], "");
    assert_eq!(c, 0);
    let j: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(j["expects_reply"], true);
    assert_eq!(j["body"], format!("看這隻\n〔照片〕cat.webp（image/webp，179 KB，1536×2048）下載：/x/asn-cli attach --id {}", uid(50)));
    assert_eq!(j["attachments"], json!([{"id": uid(50), "kind": "image", "name": "cat.webp", "mime": "image/webp", "bytes": 183422, "width": 1536, "height": 2048, "expired": false}]));
    // 沒附件的信完全不變
    assert!(!to_line(&mail(2, "x"), Some("c")).contains("attachments"));
}

#[test]
fn once_後端錯誤_結束碼_4_已印出的信下次不會重複() {
    let (fake, inb) = inbox_backend(true, 1);
    let f = fx(&fake.url(), Some("T-視窗甲"));
    *inb.mails.lock().unwrap() = vec![mail(1, "T-視窗甲")];
    let (c, out, err) = go(&f.env, &["recv", "--once"], "");
    assert_eq!((c, out.as_str()), (4, ""));
    assert!(err.contains("收信失敗：inbox HTTP 500"), "{err}");
    assert_eq!(inb.fail_first.load(Ordering::SeqCst), 0);
    let (c, out, _) = go(&f.env, &["recv", "--once"], "");
    assert_eq!((c, out.lines().count()), (0, 1));
}

/// 假後端（新版）：inbox_peek 回固定內容；inbox／ack 若被呼叫就記下來（peek 絕不該呼叫）
fn peek_backend(status: u16) -> Fake {
    Fake::start(move |req: &Req, _| match req.action().as_str() {
        "inbox_peek" if status == 200 => {
            let long = "長".repeat(120);
            Resp::ok(json!({"count": 7, "messages": [
                {"id": uid(1), "from_node": "W", "from_agent": "W-政策", "created_at": "2026-10-02T00:00:00Z", "body": "第一行\n第二行"},
                {"id": uid(2), "from_node": "W", "from_agent": null, "created_at": "2026-10-02T00:01:00Z", "body": long},
            ]}))
        }
        "inbox_peek" => Resp::json(status, json!({"error": "not_found"})),
        _ => Resp::json(500, json!({"error": "peek 不該呼叫別的動作"})),
    })
}

/// 整個家目錄的檔案清單（含大小），用來證明 peek 沒有寫任何記號／心跳
fn tree(p: &Path, out: &mut Vec<(String, u64)>) {
    for e in std::fs::read_dir(p).unwrap().flatten() {
        let m = e.metadata().unwrap();
        if m.is_dir() {
            tree(&e.path(), out);
        } else {
            out.push((e.path().display().to_string(), m.len()));
        }
    }
    out.sort();
}

#[test]
fn peek_印一行_json_count_與_messages_preview_截_80_字_只呼叫_inbox_peek_不_ack_不寫任何檔() {
    let fake = peek_backend(200);
    let f = fx(&fake.url(), Some("T-視窗甲"));
    let (mut before, mut after) = (vec![], vec![]);
    tree(&f.home, &mut before);
    let (c, out, err) = go(&f.env, &["recv", "--peek"], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(out.lines().count(), 1, "{out}");
    let j: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(j["count"], 7); // 以後端總數為準，不是 messages 長度
    let ms = j["messages"].as_array().unwrap();
    assert_eq!(ms.len(), 2);
    assert_eq!(ms[0], json!({"id": uid(1), "from": "W-政策", "at": "2026-10-02T00:00:00Z", "preview": "第一行 第二行"}));
    assert_eq!(ms[1]["from"], "W"); // 沒有 from_agent 退回 from_node
    assert_eq!(ms[1]["preview"].as_str().unwrap().chars().count(), 80);
    assert!(out.starts_with("{\"count\":7,\"messages\":[{\"id\":\""), "欄位順序固定：{out}");
    // 只打了一次 inbox_peek，帶機器金鑰與視窗名；沒有任何 inbox／ack
    assert_eq!(fake.actions(), vec!["inbox_peek"]);
    let r = &fake.of("inbox_peek")[0];
    assert_eq!((r.method.as_str(), r.param("agent").as_deref(), r.headers.get("x-relay-key").map(String::as_str)), ("GET", Some("T-視窗甲"), Some(KEY)));
    // 不寫心跳、replied／sent 記號：家目錄檔案清單前後完全一樣
    tree(&f.home, &mut after);
    assert_eq!(before, after);
}

#[test]
fn peek_count_only_只印_count() {
    let fake = peek_backend(200);
    let f = fx(&fake.url(), Some("T-視窗甲"));
    let (c, out, _) = go(&f.env, &["recv", "--peek", "--count-only"], "");
    assert_eq!((c, out.as_str()), (0, "{\"count\":7}\n"));
    assert_eq!(fake.actions(), vec!["inbox_peek"]);
    // --count-only 單獨用不行
    let (c, _, err) = go(&f.env, &["recv", "--once", "--count-only"], "");
    assert_eq!(c, 1);
    assert!(err.contains("--count-only 只能和 --peek"), "{err}");
}

#[test]
fn peek_後端還沒部署_404_印清楚的中文錯誤_結束碼_4_stdout_空() {
    let fake = peek_backend(404);
    let f = fx(&fake.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["recv", "--peek"], "");
    assert_eq!((c, out.as_str()), (4, ""));
    assert!(err.contains("後端還沒支援") && err.contains("inbox_peek 回 404"), "{err}");
    assert_eq!(fake.actions(), vec!["inbox_peek"]); // 失敗也不退回去呼叫會 ack 的 inbox
    // 其他錯誤照原樣回報
    let fake = peek_backend(500);
    let f = fx(&fake.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f.env, &["recv", "--peek"], "");
    assert_eq!(c, 4);
    assert!(err.contains("查詢未讀失敗：inbox_peek HTTP 500"), "{err}");
}

#[test]
fn peek_認不出視窗_結束碼_2_沒打任何請求() {
    let fake = peek_backend(200);
    let f = fx(&fake.url(), None);
    let (c, _, _) = go(&f.env, &["recv", "--peek"], "");
    assert_eq!(c, 2);
    assert_eq!(fake.count(), 0);
}

// 守門：--peek 的程式路徑絕不呼叫 inbox／ack／心跳／replied／sent（拿掉這條的保證，例如在 peek 區塊加一個 ack 就會紅）
#[test]
fn 守門_peek_程式路徑只碰_inbox_peek() {
    let src = include_str!("../recv.rs").replace("\r\n", "\n");
    let start = src.find("if a.peek {").expect("找不到 peek 區塊");
    let end = start + src[start..].find("return Ok(0);").expect("peek 區塊沒有 return");
    let block = &src[start..end];
    assert!(block.contains("inbox_peek&agent="));
    for banned in ["\"inbox&", "inbox&agent", "ack&", "\"ack", "write_heartbeat", "replied", "sent", "pull_once", "Some(json!"] {
        assert!(!block.contains(banned), "peek 區塊不可出現 {banned}");
    }
    // 整個 recv.rs 裡 inbox_peek 以外，只有 pull_once 巨集能碰 inbox／ack
    assert_eq!(src.matches("\"inbox&agent=").count(), 1);
    assert_eq!(src.matches("\"ack&agent=").count(), 1);
}

#[test]
fn peek_line_沒有_count_欄位時用信數_壞資料不當掉() {
    use crate::cli::recv::peek_line;
    assert_eq!(peek_line(&json!({"messages": [{"id": uid(1), "from_agent": "a", "created_at": "t", "body": "x"}]}), false), format!("{{\"count\":1,\"messages\":[{{\"id\":\"{}\",\"from\":\"a\",\"at\":\"t\",\"preview\":\"x\"}}]}}", uid(1)));
    assert_eq!(peek_line(&Value::Null, false), "{\"count\":0,\"messages\":[]}");
    assert_eq!(peek_line(&json!({"count": 3}), true), "{\"count\":3}");
}

/// 共用的輸出緩衝，讓主執行緒可以邊跑邊看 watch 印了什麼
#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);
impl Write for Shared {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl Shared {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).to_string()
    }
}
fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let t = std::time::Instant::now();
    while !f() {
        assert!(t.elapsed() < std::time::Duration::from_secs(15), "等不到：{what}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn watch_寫心跳_收信印一行_第一次失敗會退避重試_視窗不在就結束並清掉心跳() {
    let (fake, inb) = inbox_backend(true, 1); // 第一次 inbox 回 500
    let mut f = fx(&fake.url(), Some("T-視窗甲"));
    f.env.poll_ms = 100;
    f.env.heartbeat_ms = 50;
    f.env.window_check_ms = 50;
    *inb.mails.lock().unwrap() = vec![mail(1, "T-視窗甲")];
    let (out, err) = (Shared::default(), Shared::default());
    let env = f.env.clone();
    let (o2, e2) = (out.clone(), err.clone());
    let h = std::thread::spawn(move || {
        let (mut o, mut e, mut i) = (o2, e2, std::io::Cursor::new(Vec::<u8>::new()));
        let mut io = Io { out: &mut o, err: &mut e, stdin: &mut i };
        run(&["recv".to_string(), "--watch".to_string()], &env, &mut io)
    });
    let hb = f.work().join("self-recv").join("T-視窗甲.json");
    wait_for("心跳檔", || hb.exists());
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&hb).unwrap()).unwrap();
    assert_eq!((v["pid"].as_u64(), v["name"].as_str()), (Some(std::process::id() as u64), Some("T-視窗甲")));
    assert!(v["t"].as_u64().unwrap() > 1_700_000_000_000);
    wait_for("第一封信", || out.text().contains("\"body\":\"信1\""));
    assert!(err.text().contains("pull failed (startup): inbox HTTP 500"), "{}", err.text());
    assert!(err.text().contains("watching node=T window=T-視窗甲"));
    // 之後來的信由輪詢收到，不重複印第一封
    inb.mails.lock().unwrap().push(mail(2, "T-視窗甲"));
    wait_for("第二封信", || out.text().contains("\"body\":\"信2\""));
    assert_eq!(out.text().matches("\"body\":\"信1\"").count(), 1);
    // 心跳持續更新
    let t1 = v["t"].as_u64().unwrap();
    wait_for("心跳更新", || serde_json::from_str::<Value>(&std::fs::read_to_string(&hb).unwrap_or_default()).map(|v| v["t"].as_u64().unwrap_or(0) > t1).unwrap_or(false));
    // 視窗本體不在了就自己結束
    f.window_alive.store(false, Ordering::SeqCst);
    assert_eq!(h.join().unwrap(), 0);
    assert!(err.text().contains("window gone: exit"));
    assert!(!hb.exists(), "結束要清掉自己的心跳");
    assert!(inb.mails.lock().unwrap().iter().all(|m| m["acked"] == true));
}

#[test]
fn watch_同一視窗已有另一個在跑_結束碼_3_心跳過期或_pid_已死則接手() {
    let (fake, _inb) = inbox_backend(true, 0);
    let mut f = fx(&fake.url(), Some("T-視窗甲"));
    f.env.window_check_ms = 30;
    let hbdir = f.work().join("self-recv");
    std::fs::create_dir_all(&hbdir).unwrap();
    let hb = hbdir.join("T-視窗甲.json");
    let now = crate::heartbeat::now_ms();
    // 別人的心跳、新的、pid 活著 → 拒絕，不動它的檔案
    std::fs::write(&hb, json!({"pid": 4242, "name": "T-視窗甲", "t": now}).to_string()).unwrap();
    let (c, _, err) = go(&f.env, &["recv", "--watch"], "");
    assert_eq!(c, 3);
    assert!(err.contains("視窗「T-視窗甲」已經有一個 recv --watch 在跑（pid 4242）"), "{err}");
    assert_eq!(serde_json::from_str::<Value>(&std::fs::read_to_string(&hb).unwrap()).unwrap()["pid"], 4242);
    // 心跳過期 → 接手（這裡讓視窗一開始就是死的，接手後立刻結束，並清掉自己的心跳）
    std::fs::write(&hb, json!({"pid": 4242, "name": "T-視窗甲", "t": now - 200_000}).to_string()).unwrap();
    f.window_alive.store(false, Ordering::SeqCst);
    let (c, _, err) = go(&f.env, &["recv", "--watch"], "");
    assert_eq!(c, 0, "{err}");
    assert!(!hb.exists());
    // 心跳新但 pid 已死 → 接手
    let mut dead = f.env.clone();
    dead.alive = Arc::new(|p| p != 4242 && p != CLAUDE_PID);
    std::fs::write(&hb, json!({"pid": 4242, "name": "T-視窗甲", "t": crate::heartbeat::now_ms()}).to_string()).unwrap();
    assert_eq!(go(&dead, &["recv", "--watch"], "").0, 0);
}

#[test]
fn iso_時間格式() {
    assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso(1_792_499_405_123), "2026-10-20T12:30:05.123Z");
}
