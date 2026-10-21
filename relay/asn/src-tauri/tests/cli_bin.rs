//! 真的把執行檔跑起來（asn-cli、asn 的備援入口）：連本機假後端，用「這個測試程序」當 Claude 視窗
//! （在假的家目錄登記自己的 pid，執行檔的父行程就是它）。驗證行程鏈身分判定、輸出、結束碼、輸出入走管線。
//! 只連 127.0.0.1，不碰真實後端與金鑰。
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

fn fake() -> (String, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/relay", l.local_addr().unwrap().port());
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let s2 = seen.clone();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(mut c) = c else { break };
            let mut buf = vec![0u8; 16384];
            let mut n = 0;
            // 讀到標頭結束與內容長度夠為止
            loop {
                let k = c.read(&mut buf[n..]).unwrap_or(0);
                if k == 0 {
                    break;
                }
                n += k;
                let t = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Some(p) = t.find("\r\n\r\n") {
                    let len = t[..p].to_lowercase().split("content-length:").nth(1).and_then(|x| x.split("\r\n").next()).and_then(|x| x.trim().parse::<usize>().ok()).unwrap_or(0);
                    if n >= p + 4 + len {
                        break;
                    }
                }
            }
            s2.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
            let body = r#"{"id":"aaaaaaaa-0000-0000-0000-000000000009","messages":[]}"#;
            let _ = write!(c, "HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    (url, seen)
}

fn home(name: Option<&str>) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".irori-relay")).unwrap();
    std::fs::write(d.path().join(".irori-relay").join("T.key"), "fake-machine-key").unwrap();
    let s = d.path().join(".claude").join("sessions");
    std::fs::create_dir_all(&s).unwrap();
    if let Some(n) = name {
        let pid = std::process::id();
        std::fs::write(s.join(format!("{pid}.json")), format!(r#"{{"pid":{pid},"name":"{n}","kind":"interactive","entrypoint":"cli"}}"#)).unwrap();
    }
    d
}

fn run(exe: &str, home: &std::path::Path, url: &str, args: &[&str]) -> (i32, String, String) {
    let mut c = Command::new(exe);
    c.args(args).env_clear().env("USERPROFILE", home).env("HOME", home).env("IRORI_RELAY_ID", "T").env("IRORI_RELAY_URL", url);
    for k in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    let o = c.stdin(Stdio::null()).output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
}

#[test]
fn asn_cli_寄信_父行程就是視窗_輸出與結束碼走管線() {
    let (url, seen) = fake();
    let h = home(Some("T-測試視窗"));
    let (code, out, err) = run(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["send", "--to", "XISU", "--body", "你好", "--no-reply"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(out.trim(), "sent id=aaaaaaaa-0000-0000-0000-000000000009 to=XISU from=T/T-測試視窗");
    let reqs = seen.lock().unwrap().clone();
    assert_eq!(reqs.len(), 1);
    assert!(reqs[0].starts_with("POST /relay?action=send"), "{}", reqs[0]);
    assert!(reqs[0].to_lowercase().contains("x-relay-key: fake-machine-key"));
    assert!(reqs[0].contains(r#""from_agent":"T-測試視窗""#) && reqs[0].contains(r#""expects_reply":false"#), "{}", reqs[0]);
    // 錯誤碼：沒說要不要回信 = 1；
    let (code, _, err) = run(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["send", "--to", "XISU", "--body", "x"]);
    assert_eq!(code, 1);
    assert!(err.contains("請說明要不要回信"));
    // 收信一次
    let (code, out, err) = run(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["recv", "--once"]);
    assert_eq!((code, out.as_str()), (0, ""), "{err}");
    assert!(seen.lock().unwrap().iter().any(|r| r.starts_with("GET /relay?action=inbox&agent=T-%E6%B8%AC%E8%A9%A6%E8%A6%96%E7%AA%97")));
}

#[test]
fn asn_cli_不在_claude_視窗裡_結束碼_2_不打後端() {
    let (url, seen) = fake();
    let h = home(None);
    let (code, _, err) = run(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["send", "--to", "XISU", "--body", "x", "--no-reply"]);
    assert_eq!(code, 2);
    assert!(err.contains("找不到呼叫者所屬的 Claude 視窗"), "{err}");
    assert!(seen.lock().unwrap().is_empty());
    // --whoami 不需要在視窗裡也能跑，印出判定
    let (code, out, _) = run(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["send", "--whoami"]);
    assert_eq!(code, 0);
    assert!(out.contains("判定（行程鏈）：無") && out.contains("機器節點判定：T"), "{out}");
}

#[test]
fn asn_主程式遇到子命令_不開視窗_直接跑命令列() {
    let (url, seen) = fake();
    let h = home(Some("T-測試視窗"));
    let (code, out, err) = run(env!("CARGO_BIN_EXE_asn"), h.path(), &url, &["send", "--to", "XISU", "--body", "經由 asn", "--no-reply"]);
    assert_eq!(code, 0, "{err}");
    assert!(out.starts_with("sent id="), "{out}");
    assert_eq!(seen.lock().unwrap().len(), 1);
}
