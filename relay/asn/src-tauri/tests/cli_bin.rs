//! 真的把執行檔跑起來（asn-cli、asn 的備援入口）：連本機假後端，用「這個測試程序」當 Claude 視窗
//! （在假的家目錄登記自己的 pid，執行檔的父行程就是它）。驗證行程鏈身分判定、輸出、結束碼、輸出入走管線。
//! 只連 127.0.0.1，不碰真實後端與金鑰。
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
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

/// 假的家目錄：有機器金鑰與空的 sessions 資料夾。要不要有 Claude 視窗由 [`run_in_window`] 當場登記。
fn home() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".asn")).unwrap();
    std::fs::write(d.path().join(".asn").join("T.key"), "fake-machine-key").unwrap();
    std::fs::create_dir_all(d.path().join(".claude").join("sessions")).unwrap();
    d
}

/// 在 sessions 登記一筆互動中的 Claude 視窗記錄
fn register_window(home: &Path, pid: u32, name: &str) {
    let f = home.join(".claude").join("sessions").join(format!("{pid}.json"));
    std::fs::write(f, format!(r#"{{"pid":{pid},"name":"{name}","kind":"interactive","entrypoint":"cli"}}"#)).unwrap();
}

const WINDOW_NAME: &str = "T-測試視窗";

/// 把子程序要用的環境整理好：envs 以外一律清空，只留跑得動所需的系統變數
fn prepared(prog: &Path, home: &Path, envs: &[(&str, &str)]) -> Command {
    let mut c = Command::new(prog);
    c.env_clear().env("USERPROFILE", home).env("HOME", home);
    for (k, v) in envs {
        c.env(k, v);
    }
    for k in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    c
}

fn summarize(o: std::process::Output) -> (i32, String, String) {
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
}

fn run(exe: &str, home: &Path, url: &str, args: &[&str]) -> (i32, String, String) {
    run_with(exe, home, &[("IRORI_RELAY_ID", "T"), ("IRORI_RELAY_URL", url)], args)
}

/// envs＝要設的環境變數（其他一律清空）。父行程是這個測試程式，它沒有登記成視窗（用來測「不在視窗裡」）。
fn run_with(exe: &str, home: &Path, envs: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
    summarize(prepared(Path::new(exe), home, envs).args(args).stdin(Stdio::null()).output().unwrap())
}

/// 同 [`run`]，但命令列的父行程是一個登記在 sessions 的 Claude 視窗（名字 [`WINDOW_NAME`]）。
fn run_win(exe: &str, home: &Path, url: &str, args: &[&str]) -> (i32, String, String) {
    run_in_window(exe, home, &[("IRORI_RELAY_ID", "T"), ("IRORI_RELAY_URL", url)], args)
}

/// 非 Windows：判斷「是不是 claude 程序」恆為真（只看存活），所以直接把這個測試程式登記成視窗，命令列的父行程就是它。
#[cfg(not(windows))]
fn run_in_window(exe: &str, home: &Path, envs: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
    register_window(home, std::process::id(), WINDOW_NAME);
    run_with(exe, home, envs, args)
}

/// Windows：正式判斷要求視窗程序名是 claude*（或 node／bun 且命令列含 claude），測試程式本身不符。
/// 所以在假家目錄放一份改名成 claude.exe 的 cmd.exe 當視窗，由它啟動命令列：
/// 1. 視窗先 `set /p` 等測試從標準輸入送一行（這時才知道它的 pid，登記好記錄才放行，沒有競態）；
/// 2. 放行後它才跑命令列，命令列的父行程就是這個登記過的 claude.exe；
/// 3. cmd 把子程序的標準輸出入照原樣接過去，結束碼也是子程序的結束碼。
/// 命令列不含 -p／-v／--type= 等獨立參數，執行檔也不在 Claude Desktop 目錄，所以過得了正式的互動視窗判斷。
#[cfg(windows)]
fn run_in_window(exe: &str, home: &Path, envs: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
    use std::os::windows::process::CommandExt;
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude.exe");
    if !claude.exists() {
        let sys = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into());
        std::fs::copy(sys.join("System32").join("cmd.exe"), &claude).unwrap();
    }
    let quoted: String = args.iter().map(|a| format!(" \"{a}\"")).collect();
    // /s：外層第一個與最後一個引號一定去掉，裡面的引號原樣保留
    let line = format!("/d /s /c \"set /p _=& \"{exe}\"{quoted} <nul\"");
    let mut child = prepared(&claude, home, envs).raw_arg(line).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    register_window(home, child.id(), WINDOW_NAME);
    // 記錄寫好才放行；送完就關掉標準輸入
    let mut si = child.stdin.take().unwrap();
    si.write_all(b"go\r\n").unwrap();
    drop(si);
    summarize(child.wait_with_output().unwrap())
}

#[test]
fn asn_cli_寄信_父行程就是視窗_輸出與結束碼走管線() {
    let (url, seen) = fake();
    let h = home();
    let (code, out, err) = run_win(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["send", "--to", "PC1", "--body", "你好", "--no-reply"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(out.trim(), "sent id=aaaaaaaa-0000-0000-0000-000000000009 to=PC1 from=T/T-測試視窗");
    let reqs = seen.lock().unwrap().clone();
    assert_eq!(reqs.len(), 1);
    assert!(reqs[0].starts_with("POST /relay?action=send"), "{}", reqs[0]);
    assert!(reqs[0].to_lowercase().contains("x-relay-key: fake-machine-key"));
    assert!(reqs[0].contains(r#""from_agent":"T-測試視窗""#) && reqs[0].contains(r#""expects_reply":false"#), "{}", reqs[0]);
    // 錯誤碼：沒說要不要回信 = 1；
    let (code, _, err) = run_win(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["send", "--to", "PC1", "--body", "x"]);
    assert_eq!(code, 1);
    assert!(err.contains("請說明要不要回信"));
    // 收信一次
    let (code, out, err) = run_win(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["recv", "--once"]);
    assert_eq!((code, out.as_str()), (0, ""), "{err}");
    assert!(seen.lock().unwrap().iter().any(|r| r.starts_with("GET /relay?action=inbox&agent=T-%E6%B8%AC%E8%A9%A6%E8%A6%96%E7%AA%97")));
}

#[test]
fn asn_cli_不在_claude_視窗裡_結束碼_2_不打後端() {
    let (url, seen) = fake();
    let h = home();
    let (code, _, err) = run(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &url, &["send", "--to", "PC1", "--body", "x", "--no-reply"]);
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
    let h = home();
    let (code, out, err) = run_win(env!("CARGO_BIN_EXE_asn"), h.path(), &url, &["send", "--to", "PC1", "--body", "經由 asn", "--no-reply"]);
    assert_eq!(code, 0, "{err}");
    assert!(out.starts_with("sent id="), "{out}");
    assert_eq!(seen.lock().unwrap().len(), 1);
}

/// 環境變數改名相容：只設舊名（上面的測試）、只設新名、兩個都設（以新名為準）都要能寄信。
#[test]
fn asn_cli_環境變數_只設新名也行_兩個都設以新名為準() {
    let (url, seen) = fake();
    let h = home();
    // 只設新名
    let (code, out, err) = run_in_window(env!("CARGO_BIN_EXE_asn-cli"), h.path(), &[("ASN_RELAY_ID", "T"), ("ASN_RELAY_URL", &url)], &["send", "--to", "PC1", "--body", "x", "--no-reply"]);
    assert_eq!(code, 0, "{err}");
    assert!(out.starts_with("sent id="), "{out}");
    assert_eq!(seen.lock().unwrap().len(), 1);
    // 兩個都設：舊名指向不通的埠、舊代號不存在，仍以新名為準
    let (code, out, err) = run_in_window(
        env!("CARGO_BIN_EXE_asn-cli"),
        h.path(),
        &[("ASN_RELAY_ID", "T"), ("ASN_RELAY_URL", &url), ("IRORI_RELAY_ID", "NOPE"), ("IRORI_RELAY_URL", "http://127.0.0.1:9/relay")],
        &["send", "--to", "PC1", "--body", "y", "--no-reply"],
    );
    assert_eq!(code, 0, "{err}");
    assert!(out.contains("from=T/T-測試視窗"), "{out}");
    assert_eq!(seen.lock().unwrap().len(), 2);
}
