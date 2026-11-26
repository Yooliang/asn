//! 型號探測共用的子程序執行器：非同步、有逾時、輸出有上限。
//! 守門：`env_clear` 加白名單（呼叫端先過濾好再傳進來）、`kill_on_drop`、`.no_window()`、stdin 給 null。
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

/// **讀取上限**：子程序 stdout 最多收這麼多位元組。Codex 的原始輸出約 262 KB（大半是 base_instructions），所以留 1 MiB。
/// 這只管「讀進來」；解析、精簡後「回報出去」的上限是另一件事，見 `parse::REPORT_MAX_MODELS`／`REPORT_MAX_BYTES`，兩個不能混用
pub const STDOUT_CAP: usize = 1024 * 1024;
/// stderr 只留前這麼多位元組（pi 的表格可能印在 stderr，所以要留；超過的讀掉丟棄）
const STDERR_CAP: usize = 256 * 1024;

pub struct Spawn {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// 已經過濾好的環境（只會帶這些）
    pub env: Vec<(String, String)>,
    /// true＝把 stderr 接在 stdout 後面（pi 舊行為）；false＝stderr 讀掉丟棄（agy 的「Fetching…」在 stderr）
    pub merge_stderr: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub enum RunFail {
    /// 起不來（找不到、沒權限…）
    Spawn(String),
    Timeout,
    TooLarge,
    /// 結束碼不是 0（None＝被訊號結束）
    Exit(Option<i32>),
    /// 讀輸出讀到一半出了 IO 錯誤（不能當成讀完）
    Io(String),
}

/// 手寫：`{:?}` 不印系統回的錯誤原文（常帶路徑），只說有幾個字
impl std::fmt::Debug for RunFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunFail::Spawn(e) => write!(f, "Spawn(<已遮蔽 {} 字>)", e.chars().count()),
            RunFail::Timeout => f.write_str("Timeout"),
            RunFail::TooLarge => f.write_str("TooLarge"),
            RunFail::Exit(c) => write!(f, "Exit({c:?})"),
            RunFail::Io(e) => write!(f, "Io(<已遮蔽 {} 字>)", e.chars().count()),
        }
    }
}

impl RunFail {
    /// 給 log 看的原因
    pub fn reason(&self, what: &str) -> String {
        match self {
            RunFail::Spawn(e) => format!("{what} 起不來：{e}"),
            RunFail::Timeout => format!("{what} 逾時沒有回應"),
            RunFail::TooLarge => format!("{what} 的輸出超過 {} 位元組上限", STDOUT_CAP),
            RunFail::Exit(c) => format!("{what} 結束碼 {}", c.map_or("無".to_string(), |c| c.to_string())),
            RunFail::Io(e) => format!("{what} 的輸出讀到一半出錯：{e}"),
        }
    }
}

/// 讀到 EOF 為止、最多留 `cap` 位元組。`strict`＝超過上限就回 TooLarge（否則讀掉丟棄）；
/// `fail_on_err`＝讀到一半出 IO 錯誤就回 Io（不當成 EOF）。BrokenPipe 是 Windows 管線對端關閉時的正常 EOF
async fn read_capped(r: Option<impl AsyncRead + Unpin>, cap: usize, strict: bool, fail_on_err: bool) -> Result<Vec<u8>, RunFail> {
    let Some(mut r) = r else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match r.read(&mut buf).await {
            Ok(0) => return Ok(out),
            Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe || !fail_on_err => return Ok(out),
            Err(e) => return Err(RunFail::Io(e.to_string())),
            Ok(n) => {
                let room = cap.saturating_sub(out.len());
                if n > room && strict {
                    return Err(RunFail::TooLarge);
                }
                out.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
}

/// 逾時、輸出過大、讀壞了：整棵程序樹都要結束（`orphans::kill_tree`，先收子孫、最後才收根；
/// npm 的 .cmd 殼底下的 node 也一樣），不只殺直接子程序。這時 child 還握著程序代碼（沒被回收），pid 不會被別的程序拿去用
async fn kill_whole_tree(child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = tokio::task::spawn_blocking(move || crate::bridge::orphans::kill_tree(pid)).await;
    }
    let _ = child.start_kill();
}

/// 跑一次指令，成功（結束碼 0）回文字。逾時、輸出過大、讀壞時整棵程序樹被結束（`kill_on_drop` 只是最後一道保險）
pub async fn run(spec: Spawn, timeout: Duration) -> Result<String, RunFail> {
    use crate::nowin::NoWindow;
    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.no_window().args(&spec.args);
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    cmd.env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| RunFail::Spawn(e.to_string()))?;
    let pid = child.id();
    let (so, se) = (child.stdout.take(), child.stderr.take());
    let merge = spec.merge_stderr;
    let result = {
        let work = async {
            // try_join：stdout 超過上限或讀壞了就馬上回，不等 stderr 與子程序
            let (out, err) = tokio::try_join!(read_capped(so, STDOUT_CAP, true, true), read_capped(se, STDERR_CAP, false, merge))?;
            let status = child.wait().await.map_err(|e| RunFail::Spawn(e.to_string()))?;
            Ok::<_, RunFail>((status, out, err))
        };
        tokio::time::timeout(timeout, work).await
    };
    let (status, out, err) = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            kill_whole_tree(&mut child, pid).await;
            return Err(e);
        }
        Err(_) => {
            kill_whole_tree(&mut child, pid).await;
            return Err(RunFail::Timeout);
        }
    };
    if !status.success() {
        return Err(RunFail::Exit(status.code()));
    }
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if spec.merge_stderr {
        text.push_str(&String::from_utf8_lossy(&err));
    }
    Ok(text)
}

/// 同步呼叫端用：把非同步的 `run` 丟到共用的執行環境、在這條執行緒等結果（多等 2 秒的餘裕給收尾）
pub fn run_blocking(spec: Spawn, timeout: Duration) -> Result<String, RunFail> {
    let (tx, rx) = std::sync::mpsc::channel();
    crate::rt::spawn(async move {
        let _ = tx.send(run(spec, timeout).await);
    });
    rx.recv_timeout(timeout + Duration::from_secs(2)).unwrap_or(Err(RunFail::Timeout))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假子程序：用目前這支測試執行檔自己（不執行任何 AI CLI）。環境變數決定它扮演什麼
    fn me(mode: &str) -> Spawn {
        let exe = std::env::current_exe().unwrap();
        Spawn {
            program: exe,
            args: vec!["--exact".into(), "agent_tools::models::run::tests::假子程序".into(), "--nocapture".into(), "--test-threads=1".into()],
            cwd: None,
            env: vec![("FAKE_MODE".into(), mode.into()), ("PATH".into(), std::env::var("PATH").unwrap_or_default()), ("SYSTEMROOT".into(), std::env::var("SYSTEMROOT").unwrap_or_default())],
            merge_stderr: false,
        }
    }

    /// 被上面當子程序叫起來時才有動作；平常（沒有 FAKE_MODE）什麼都不做
    #[test]
    fn 假子程序() {
        use std::io::Write;
        match std::env::var("FAKE_MODE").as_deref() {
            Ok("ok") => {
                println!("HELLO-OUT");
                eprintln!("HELLO-ERR");
            }
            Ok("fail") => std::process::exit(3),
            Ok("hang") => std::thread::sleep(Duration::from_secs(60)),
            Ok("big") => {
                let chunk = vec![b'x'; 64 * 1024];
                let mut o = std::io::stdout();
                for _ in 0..(STDOUT_CAP / chunk.len() + 4) {
                    if o.write_all(&chunk).is_err() {
                        break;
                    }
                }
            }
            // 262 KB 等級的輸出（Codex 原始輸出的大小），要讀得完
            Ok("k262") => {
                let chunk = vec![b'x'; 1024];
                let mut o = std::io::stdout();
                for _ in 0..262 {
                    o.write_all(&chunk).unwrap();
                }
            }
            // agy 的真實行為：stdout 是清單、stderr 只有一行進度，結束碼 0
            Ok("agy") => {
                // 測試框架會先在同一行印「test … ... 」，所以先換行
                print!("\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n");
                eprintln!("Fetching available models...");
            }
            // 再開一個脫離的孫程序（睡 60 秒），把孫程序的 pid 寫進 FAKE_PIDFILE，自己也睡著：模擬 npm 的 .cmd 殼底下還有 node
            Ok("tree") => {
                use crate::nowin::NoWindow;
                let mut c = std::process::Command::new(std::env::current_exe().unwrap());
                c.no_window().args(["--exact", "agent_tools::models::run::tests::假子程序", "--nocapture", "--test-threads=1"])
                    .env("FAKE_MODE", "hang")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    c.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
                }
                let g = c.spawn().unwrap();
                std::fs::write(std::env::var("FAKE_PIDFILE").unwrap(), g.id().to_string()).unwrap();
                std::thread::sleep(Duration::from_secs(60));
            }
            Ok("env") => println!("LEAK={}", std::env::var("SECRET_TOKEN_X").unwrap_or_else(|_| "none".into())),
            _ => {}
        }
    }

    #[tokio::test]
    async fn 成功回_stdout_stderr_依設定決定要不要接() {
        let t = run(me("ok"), Duration::from_secs(20)).await.unwrap();
        assert!(t.contains("HELLO-OUT") && !t.contains("HELLO-ERR"), "{t}");
        let mut s = me("ok");
        s.merge_stderr = true;
        let t = run(s, Duration::from_secs(20)).await.unwrap();
        assert!(t.contains("HELLO-OUT") && t.contains("HELLO-ERR"), "{t}");
    }

    #[tokio::test]
    async fn 結束碼不是零_起不來_逾時_輸出過大_各有各的失敗() {
        assert_eq!(run(me("fail"), Duration::from_secs(20)).await, Err(RunFail::Exit(Some(3))));
        let missing = Spawn { program: PathBuf::from("Z:/不存在/x.exe"), args: vec![], cwd: None, env: vec![], merge_stderr: false };
        assert!(matches!(run(missing, Duration::from_secs(5)).await, Err(RunFail::Spawn(_))));
        let t = std::time::Instant::now();
        assert_eq!(run(me("hang"), Duration::from_millis(1500)).await, Err(RunFail::Timeout));
        assert!(t.elapsed() < Duration::from_secs(10), "逾時要馬上回來，不等子程序睡完");
        assert_eq!(run(me("big"), Duration::from_secs(30)).await, Err(RunFail::TooLarge));
    }

    #[tokio::test]
    async fn 讀取上限放得下_262_kb_的_codex_等級輸出_但不是無限() {
        let t = run(me("k262"), Duration::from_secs(20)).await.unwrap();
        assert!(t.len() >= 262 * 1024, "{}", t.len());
        assert!(STDOUT_CAP > 262 * 1024 * 3, "讀取上限要留足餘裕");
    }

    #[tokio::test]
    async fn agy_stderr_有進度那一行_結束碼零_不算錯誤() {
        let t = run(me("agy"), Duration::from_secs(20)).await.unwrap();
        assert!(!t.contains("Fetching"), "stderr 不接進 stdout");
        assert_eq!(super::super::parse_agy(&t).len(), 2);
        let mut s = me("agy");
        s.merge_stderr = true;
        let merged = run(s, Duration::from_secs(20)).await.unwrap();
        assert!(merged.contains("Fetching available models..."));
        assert_eq!(super::super::parse_agy(&merged).len(), 2, "就算 stderr 被接進來，進度那行也不會變成型號");
    }

    #[tokio::test]
    async fn 逾時_整棵程序樹都結束_脫離的孫程序也不留() {
        let path = std::env::temp_dir().join(format!("asn-2353-tree-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut s = me("tree");
        s.env.push(("FAKE_PIDFILE".into(), path.to_string_lossy().into_owned()));
        assert_eq!(run(s, Duration::from_secs(6)).await, Err(RunFail::Timeout));
        let grand: u32 = std::fs::read_to_string(&path).expect("子程序在逾時前就該寫出孫程序的 pid").trim().parse().unwrap();
        let alive = |p: u32| crate::bridge::orphans::process_table().contains_key(&p);
        let mut gone = false;
        for _ in 0..60 {
            if !alive(grand) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // 收尾：只結束自己記下來的那個 pid（修正被拿掉時才會用到）
        if !gone {
            crate::bridge::orphans::kill_tree(grand);
        }
        let _ = std::fs::remove_file(&path);
        assert!(gone, "逾時後孫程序 {grand} 還活著：只殺了直接子程序");
    }

    /// 先給一段資料、再出 IO 錯誤的讀取端
    struct Boom(bool, std::io::ErrorKind);
    impl AsyncRead for Boom {
        fn poll_read(mut self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
            if !self.0 {
                self.0 = true;
                buf.put_slice(b"partial");
                std::task::Poll::Ready(Ok(()))
            } else {
                std::task::Poll::Ready(Err(std::io::Error::new(self.1, "讀到一半壞了")))
            }
        }
    }

    #[tokio::test]
    async fn stdout_讀到一半_io_錯誤_不算成功() {
        let r = read_capped(Some(Boom(false, std::io::ErrorKind::InvalidData)), STDOUT_CAP, true, true).await;
        assert!(matches!(r, Err(RunFail::Io(ref m)) if m.contains("壞了")), "{r:?}");
        assert!(RunFail::Io("x".into()).reason("agy").contains("出錯"));
        // 不要求失敗的那一路（stderr 不接進輸出時）照舊留已讀到的
        assert_eq!(read_capped(Some(Boom(false, std::io::ErrorKind::InvalidData)), STDERR_CAP, false, false).await.unwrap(), b"partial");
        // 管線對端關閉（BrokenPipe）是正常的 EOF
        assert_eq!(read_capped(Some(Boom(false, std::io::ErrorKind::BrokenPipe)), STDOUT_CAP, true, true).await.unwrap(), b"partial");
    }

    #[tokio::test]
    async fn 環境只帶白名單_測試程序自己的環境不會漏給子程序() {
        std::env::set_var("SECRET_TOKEN_X", "oops");
        let t = run(me("env"), Duration::from_secs(20)).await.unwrap();
        assert!(t.contains("LEAK=none"), "{t}");
    }
}
