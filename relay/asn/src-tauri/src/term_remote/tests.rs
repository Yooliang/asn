use super::*;
use crate::launch::term::TermOption;
use serde_json::json;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

// 這個檔的測試共用同一份全域暫存（OUT／BY_TERM／HANDLED），每個都要先拿這把鎖排隊跑，否則互相 reset
static SERIAL: Mutex<()> = Mutex::new(());

#[test]
fn 預覽脫敏_控制字元與ansi_且最多兩百字() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset_for_test();
    let raw = "a\x1b[31mred\x07b\n第二行";
    let p = preview_text(raw);
    assert!(!p.contains('\x1b') && !p.contains('\x07'));
    let long = "字".repeat(250);
    assert_eq!(preview_text(&long).chars().count(), 200);
}

#[test]
fn 雜湊送字與代答穩定() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset_for_test();
    let h1 = hash_send("你好", true);
    assert_eq!(h1.len(), 64);
    assert_ne!(h1, hash_send("你好", false));
    let opts = vec![TermOption { n: 1, label: "Yes".into() }];
    let h2 = hash_answer("trust_dialog", "信任？", &opts);
    assert_ne!(h2, hash_answer("trust_dialog", "信任?", &opts));
}

#[test]
fn 記錄檔只寫雜湊與長度_不含內容() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset_for_test();
    let d = TempDir::new().unwrap();
    log_event(d.path(), "create_send", "11111111-1111-1111-1111-111111111111", "abcd", 42, "1");
    let t = std::fs::read_to_string(log_path(d.path())).unwrap();
    assert!(t.contains("hash=abcd") && t.contains("len=42"));
    assert!(!t.contains("秘密文字") && !t.contains("token"));
}

#[test]
fn 逾時清掉本機狀態() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset_for_test();
    seed_expired_outgoing();
    assert!(pending_views().is_empty());
}

#[test]
fn 資料夾顯示名只取最後一段() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset_for_test();
    assert_eq!(folder_label("D:/work/order-plus"), "order-plus");
}

#[cfg(feature = "gui")]
#[allow(clippy::await_holding_lock)]   // SERIAL 就是要整個測試期間拿著，讓共用全域暫存的測試排隊跑
mod gui_tests {
    use super::*;
    use crate::launch::term::TermSendReq;
    use crate::relay::Relay;
    use serde_json::Value;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    fn fake_term_server(take_queue: Vec<Vec<Value>>) -> (String, Arc<Mutex<Vec<String>>>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        let q = Arc::new(Mutex::new(VecDeque::from(take_queue)));
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = vec![0u8; 32768];
                let n = c.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if req.contains("action=term_req_create") {
                    json!({ "id": "11111111-1111-1111-1111-111111111111", "expires_at": "2099-01-01T00:00:00Z" }).to_string()
                } else if req.contains("action=term_req_take") {
                    let row = q.lock().unwrap().pop_front().unwrap_or_default();
                    json!({ "requests": Value::Array(row), "closed": [] }).to_string()
                } else {
                    r#"{"ok":true}"#.to_string()
                };
                s2.lock().unwrap().push(req);
                let _ = write!(c, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn 本機先確認則遠端作廢() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let d = TempDir::new().unwrap();
        let (url, seen) = fake_term_server(vec![]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W".into());
        let terms = crate::launch::term::live(d.path());
        register_fake_outgoing("1", "11111111-1111-1111-1111-111111111111", "僅本機", false);
        let req = TermSendReq { id: "1".into(), text: "僅本機".into(), enter: false };
        let _ = local_confirm_send(&relay, &terms, d.path(), &req).await;
        let reqs = seen.lock().unwrap();
        assert!(reqs.iter().any(|r| r.contains("term_req_result") && r.contains("cancelled")));
        assert!(reqs.iter().all(|r| !r.contains("僅本機")));
    }

    #[tokio::test]
    async fn 本機取消則撤回遠端請求_之後不再有東西可確認() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let d = TempDir::new().unwrap();
        let (url, seen) = fake_term_server(vec![]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W".into());
        register_fake_outgoing("1", "11111111-1111-1111-1111-111111111111", "要撤回", false);
        withdraw(&relay, d.path(), "1").await;
        let reqs = seen.lock().unwrap();
        assert!(reqs.iter().any(|r| r.contains("term_req_result") && r.contains("cancelled")));
        drop(reqs);
        assert!(local_by_term("1").is_none(), "本機不再記著這筆");
        withdraw(&relay, d.path(), "1").await;   // 沒有進行中的請求：不報錯、不再打後台
        assert_eq!(seen.lock().unwrap().iter().filter(|r| r.contains("term_req_result")).count(), 1);
    }

    #[tokio::test]
    async fn 有代答進行中時_撤回送字不會動到它() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let d = TempDir::new().unwrap();
        let (url, seen) = fake_term_server(vec![]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W".into());
        register_fake_answer("1", "11111111-1111-1111-1111-111111111111");
        withdraw(&relay, d.path(), "1").await;
        assert!(local_by_term("1").is_some(), "代答那筆還在");
        assert!(seen.lock().unwrap().iter().all(|r| !r.contains("term_req_result")), "沒有通知後台取消");
    }

    #[tokio::test]
    async fn 雜湊不符執行失敗並回報() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let d = TempDir::new().unwrap();
        let row = vec![json!({ "id": "11111111-1111-1111-1111-111111111111", "kind": "send", "term_id": "1", "body_hash": "b".repeat(64), "enter": false })];
        let (url, seen) = fake_term_server(vec![row]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W".into());
        let terms = crate::launch::term::live(d.path());
        register_fake_outgoing("1", "11111111-1111-1111-1111-111111111111", "實際文字", false);
        poll_once(&relay, &terms, d.path()).await;
        let reqs = seen.lock().unwrap();
        assert!(reqs.iter().any(|r| r.contains("term_req_result") && r.contains("failed")));
    }

    #[tokio::test]
    async fn 手機剛處理過同一段字_本機再按確認不會送第二次() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let d = TempDir::new().unwrap();
        let (url, _seen) = fake_term_server(vec![]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W".into());
        let terms = crate::launch::term::live(d.path());
        mark_handled_for_test("1", "同一段", true);
        let same = TermSendReq { id: "1".into(), text: "同一段".into(), enter: true };
        let e = local_confirm_send(&relay, &terms, d.path(), &same).await.unwrap_err();
        assert!(e.contains("手機剛處理過"), "{e}");
        // 不同的字、或同一段字但 Enter 不同：不擋（會走到真正送字，這裡沒有終端所以是別的錯）
        let other = TermSendReq { id: "1".into(), text: "另一段".into(), enter: true };
        let e2 = local_confirm_send(&relay, &terms, d.path(), &other).await.unwrap_err();
        assert!(!e2.contains("手機剛處理過"), "{e2}");
        let no_enter = TermSendReq { id: "1".into(), text: "同一段".into(), enter: false };
        assert!(!local_confirm_send(&relay, &terms, d.path(), &no_enter).await.unwrap_err().contains("手機剛處理過"));
        // 別的終端不受影響
        let other_term = TermSendReq { id: "2".into(), text: "同一段".into(), enter: true };
        assert!(!local_confirm_send(&relay, &terms, d.path(), &other_term).await.unwrap_err().contains("手機剛處理過"));
    }

    #[tokio::test]
    async fn 手機那筆執行失敗_不擋本機自己再送() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let d = TempDir::new().unwrap();
        let rid = "11111111-1111-1111-1111-111111111111";
        let row = vec![json!({ "id": rid, "kind": "send", "term_id": "1", "body_hash": hash_send("要送", false), "enter": false })];
        let (url, seen) = fake_term_server(vec![row]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W".into());
        let terms = crate::launch::term::live(d.path());   // 沒有編號 1 的終端：手機那筆一定執行失敗
        register_fake_outgoing("1", rid, "要送", false);
        poll_once(&relay, &terms, d.path()).await;
        assert!(seen.lock().unwrap().iter().any(|r| r.contains("term_req_result") && r.contains("failed")));
        assert!(local_by_term("1").is_none(), "手機領走後本機不再記著這筆");
        assert!(!handled_for_test("1", "要送", false), "沒送成就不記成已處理");
    }

    #[tokio::test]
    async fn 本機先拿走那筆_手機領到時不執行() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let d = TempDir::new().unwrap();
        let rid = "11111111-1111-1111-1111-111111111111";
        let row = vec![json!({ "id": rid, "kind": "send", "term_id": "1", "body_hash": hash_send("搶先", false), "enter": false })];
        let (url, seen) = fake_term_server(vec![row]);
        let relay = Relay::new(url, "k".into(), "W".into(), "W".into());
        let terms = crate::launch::term::live(d.path());
        register_fake_outgoing("1", rid, "搶先", false);
        let req = TermSendReq { id: "1".into(), text: "搶先".into(), enter: false };
        let _ = local_confirm_send(&relay, &terms, d.path(), &req).await;   // 本機先確認：那筆被拿走並通知後台取消
        poll_once(&relay, &terms, d.path()).await;                          // 之後手機那筆才被領到
        let reqs = seen.lock().unwrap();
        assert!(reqs.iter().any(|r| r.contains("term_req_result") && r.contains("failed")), "手機那筆回報失敗，不執行");
        assert!(!handled_for_test("1", "搶先", false));
    }
}
