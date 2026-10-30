//! 密碼小幫手的測試。全部使用假密碼字串、假確認窗、測試自己建的管道（名稱前綴 asn-askpass-test-）與暫存資料夾；
//! 不開真的視窗、不連真的 ASN、不碰使用者的任何設定。
use super::client::*;
use super::proto::*;
use super::server::*;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use zeroize::Zeroizing;

const FAKE_SECRET: &str = "假密碼-ZZ-12345!";

// ---- 假確認窗 ----------------------------------------------------------------------------------------

#[derive(Default)]
struct Fake {
    replies: Mutex<VecDeque<Verdict>>,
    seen: Mutex<Vec<ConfirmRequest>>,
    delay: Mutex<Duration>,
    active: AtomicUsize,
    max_active: AtomicUsize,
    dropped: AtomicBool,
    /// true＝永遠不回答（測逾時與斷線）
    hang: AtomicBool,
}

impl Fake {
    fn with(replies: Vec<Verdict>) -> Arc<Fake> {
        let f = Fake::default();
        *f.replies.lock().unwrap() = replies.into();
        Arc::new(f)
    }
    fn seen(&self) -> Vec<ConfirmRequest> {
        self.seen.lock().unwrap().clone()
    }
}

struct DropFlag<'a>(&'a AtomicBool);
impl Drop for DropFlag<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Confirmer for Fake {
    fn ask(&self, req: ConfirmRequest) -> BoxFut<'_, Verdict> {
        Box::pin(async move {
            let _d = DropFlag(&self.dropped);
            self.seen.lock().unwrap().push(req);
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(now, Ordering::SeqCst);
            if self.hang.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            let d = *self.delay.lock().unwrap();
            if !d.is_zero() {
                tokio::time::sleep(d).await;
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            self.replies.lock().unwrap().pop_front().unwrap_or(Verdict::Cancelled)
        })
    }
}

fn procs_with(pid: u32) -> Procs {
    Arc::new(move || {
        let mut t = crate::cli::ProcTable::new();
        t.insert(pid, (200, "asn-askpass.exe".into()));
        t.insert(200, (300, "git-remote-https.exe".into()));
        t.insert(300, (400, "git.exe".into()));
        t.insert(400, (500, "bash.exe".into()));
        t.insert(500, (0, "explorer.exe".into()));
        Some(t)
    })
}

fn broker(f: &Arc<Fake>) -> Arc<Broker> {
    Arc::new(Broker::new(f.clone(), procs_with(100)))
}

fn secret(s: &str) -> Verdict {
    Verdict::Secret(Zeroizing::new(s.to_string()))
}

// ---- 假用戶端（非同步，接在記憶體管道上）---------------------------------------------------------------

async fn send_line(c: &mut DuplexStream, line: &[u8]) {
    c.write_all(line).await.unwrap();
    c.write_all(b"\n").await.unwrap();
}

fn req_json(prompt: &str, cwd: &str) -> Vec<u8> {
    serde_json::to_vec(&Request { v: VERSION, op: OP_SECRET.into(), prompt: prompt.into(), cwd: cwd.into() }).unwrap()
}

async fn read_reply(c: &mut DuplexStream) -> Result<String, String> {
    let mut head = Vec::new();
    loop {
        let mut b = [0u8; 1];
        if c.read(&mut b).await.unwrap_or(0) == 0 {
            return Err("closed".into());
        }
        if b[0] == b'\n' {
            break;
        }
        head.push(b[0]);
    }
    let h: Header = serde_json::from_slice(&head).unwrap();
    if !h.ok {
        return Err(h.reason.unwrap());
    }
    let mut body = vec![0u8; h.len];
    c.read_exact(&mut body).await.unwrap();
    Ok(String::from_utf8(body).unwrap())
}

/// 開一條連線並讓 broker 處理；回傳用戶端那一端與處理工作
fn connect_mem(b: &Arc<Broker>, pid: Option<u32>) -> (DuplexStream, tokio::task::JoinHandle<()>) {
    let (client, server) = tokio::io::duplex(16 * 1024);
    let b = b.clone();
    (client, tokio::spawn(async move { b.handle(server, pid).await }))
}

async fn ask_mem(b: &Arc<Broker>, prompt: &str) -> Result<String, String> {
    let (mut c, h) = connect_mem(b, Some(100));
    send_line(&mut c, &req_json(prompt, "C:/work/repo")).await;
    let r = tokio::time::timeout(Duration::from_secs(5), read_reply(&mut c)).await.expect("等回覆逾時");
    drop(c);
    let _ = tokio::time::timeout(Duration::from_secs(5), h).await;
    r
}

// ---- 協定與顯示清理 ----------------------------------------------------------------------------------

#[test]
fn 顯示文字清掉控制字元與雙向控制碼並截斷() {
    assert_eq!(clean_display("Password for\r\n  'x'\t:\u{0007}", 100), "Password for 'x' :");
    assert_eq!(clean_display("a\u{202E}b\u{2066}c", 100), "abc");
    assert_eq!(clean_display(&"字".repeat(500), 10), format!("{}…", "字".repeat(10)));
    assert_eq!(clean_display("   ", 10), "");
}

#[test]
fn 標頭與請求來回不丟欄位() {
    let r = Request { v: 1, op: "secret".into(), prompt: "p".into(), cwd: "c".into() };
    assert_eq!(serde_json::from_slice::<Request>(&serde_json::to_vec(&r).unwrap()).unwrap(), r);
    let h = Header::fail(REASON_BUSY);
    assert_eq!(serde_json::from_slice::<Header>(h.line().strip_suffix(b"\n").unwrap()).unwrap(), h);
    assert!(Header::secret(3).line().ends_with(b"\n"));
}

#[test]
fn 密碼不會被格式化輸出() {
    let v = secret(FAKE_SECRET);
    assert!(!format!("{v:?}").contains("ZZ-12345"));
    assert!(!format!("{v:#?}").contains("ZZ-12345"));
    assert_eq!(format!("{:?}", Verdict::Cancelled), "Cancelled");
}

// ---- 伺服器端（ASN）----------------------------------------------------------------------------------

#[tokio::test]
async fn 使用者輸入密碼就原樣回給小幫手並帶上程式與提示() {
    let f = Fake::with(vec![secret(FAKE_SECRET)]);
    let r = ask_mem(&broker(&f), "Password for 'https://u@example.test': \n（偽造第二行）").await;
    assert_eq!(r.unwrap(), FAKE_SECRET);
    let seen = f.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].kind, ConfirmKind::Secret);
    // 程式名稱由系統查到的對面行程決定（往上三層），不是小幫手自己報的
    assert_eq!(seen[0].program, "git-remote-https.exe ← git.exe ← bash.exe");
    assert_eq!(seen[0].cwd, "C:/work/repo");
    assert_eq!(seen[0].prompt, "Password for 'https://u@example.test': （偽造第二行）");
    assert_eq!(seen[0].timeout, DIALOG_TIMEOUT);
}

#[tokio::test]
async fn 查不到對面行程時如實顯示無法辨識() {
    let f = Fake::with(vec![secret("x")]);
    let (mut c, _h) = connect_mem(&broker(&f), None);
    send_line(&mut c, &req_json("p", "")).await;
    read_reply(&mut c).await.unwrap();
    assert_eq!(f.seen()[0].program, "（無法辨識）");
}

#[tokio::test]
async fn 使用者取消或拒絕回取消() {
    for v in [Verdict::Cancelled, Verdict::Deny] {
        let f = Fake::with(vec![v]);
        assert_eq!(ask_mem(&broker(&f), "p").await.unwrap_err(), REASON_CANCELLED);
    }
}

#[tokio::test]
async fn 管道這條路不接受只問允許的結果() {
    let f = Fake::with(vec![Verdict::Allow]);
    assert_eq!(ask_mem(&broker(&f), "p").await.unwrap_err(), REASON_UNSUPPORTED);
}

#[tokio::test]
async fn 太長的密碼不送出() {
    let f = Fake::with(vec![secret(&"a".repeat(MAX_SECRET_BYTES + 1))]);
    assert_eq!(ask_mem(&broker(&f), "p").await.unwrap_err(), REASON_BAD);
}

#[tokio::test]
async fn 逾時自動取消並關掉確認窗() {
    let f = Fake::with(vec![]);
    f.hang.store(true, Ordering::SeqCst);
    let b = Arc::new(Broker::new(f.clone(), procs_with(100)).with_timeout(Duration::from_millis(80)));
    assert_eq!(ask_mem(&b, "p").await.unwrap_err(), REASON_TIMEOUT);
    assert!(f.dropped.load(Ordering::SeqCst), "逾時後確認窗的 future 必須被丟棄（視窗才會關）");
}

#[tokio::test]
async fn 同時多個請求排隊一次只問一個() {
    let f = Fake::with(vec![secret("a"), secret("b"), secret("c")]);
    *f.delay.lock().unwrap() = Duration::from_millis(40);
    let b = broker(&f);
    let mut hs = vec![];
    for _ in 0..3 {
        let b = b.clone();
        hs.push(tokio::spawn(async move { ask_mem(&b, "p").await }));
    }
    let mut got = vec![];
    for h in hs {
        got.push(h.await.unwrap().unwrap());
    }
    got.sort();
    assert_eq!(got, vec!["a", "b", "c"]);
    assert_eq!(f.max_active.load(Ordering::SeqCst), 1, "確認窗同時只能有一個");
    let ids: Vec<u64> = f.seen().iter().map(|r| r.id).collect();
    assert_eq!(ids, vec![1, 2, 3]);
}

#[tokio::test]
async fn 排隊太多回忙碌() {
    let f = Fake::with(vec![]);
    f.hang.store(true, Ordering::SeqCst);
    let b = broker(&f);
    let mut keep = vec![];
    for _ in 0..MAX_QUEUE {
        let (mut c, h) = connect_mem(&b, Some(100));
        send_line(&mut c, &req_json("p", "")).await;
        keep.push((c, h));
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut c, _h) = connect_mem(&b, Some(100));
    send_line(&mut c, &req_json("p", "")).await;
    assert_eq!(read_reply(&mut c).await.unwrap_err(), REASON_BUSY);
}

#[tokio::test]
async fn 排隊中對方先放棄就不再問() {
    let f = Fake::with(vec![secret("first")]);
    *f.delay.lock().unwrap() = Duration::from_millis(300);
    let b = broker(&f);
    let (mut c1, _h1) = connect_mem(&b, Some(100));
    send_line(&mut c1, &req_json("one", "")).await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    let (mut c2, h2) = connect_mem(&b, Some(100));
    send_line(&mut c2, &req_json("two", "")).await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    drop(c2);
    tokio::time::timeout(Duration::from_secs(5), h2).await.expect("放棄的請求要立刻結束").unwrap();
    assert_eq!(read_reply(&mut c1).await.unwrap(), "first");
    assert_eq!(f.seen().len(), 1, "放棄的請求不該跳出確認窗");
}

#[tokio::test]
async fn 確認窗開著時對方斷線就關窗() {
    let f = Fake::with(vec![]);
    f.hang.store(true, Ordering::SeqCst);
    let b = broker(&f);
    let (mut c, h) = connect_mem(&b, Some(100));
    send_line(&mut c, &req_json("p", "")).await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(f.seen().len(), 1);
    drop(c);
    tokio::time::timeout(Duration::from_secs(5), h).await.expect("斷線後處理要結束").unwrap();
    assert!(f.dropped.load(Ordering::SeqCst), "對方斷線後確認窗要被丟棄");
}

#[tokio::test]
async fn 壞請求一律不跳確認窗() {
    let f = Fake::with(vec![secret("x")]);
    let b = broker(&f);
    let cases: Vec<Vec<u8>> = vec![
        b"not json".to_vec(),
        serde_json::to_vec(&Request { v: 99, op: "secret".into(), prompt: "p".into(), cwd: "".into() }).unwrap(),
        serde_json::to_vec(&Request { v: 1, op: "run".into(), prompt: "p".into(), cwd: "".into() }).unwrap(),
        vec![b'a'; MAX_REQUEST_BYTES + 10],
    ];
    for c in cases {
        let (mut cl, h) = connect_mem(&b, Some(100));
        send_line(&mut cl, &c).await;
        let r = read_reply(&mut cl).await.unwrap_err();
        assert!(r == REASON_BAD || r == REASON_UNSUPPORTED, "{r}");
        drop(cl);
        let _ = h.await;
    }
    assert!(f.seen().is_empty());
}

// ---- 小幫手端（用記憶體假資料，不連管道）-----------------------------------------------------------------

struct Mem {
    input: std::io::Cursor<Vec<u8>>,
    output: Vec<u8>,
}
impl std::io::Read for Mem {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        std::io::Read::read(&mut self.input, b)
    }
}
impl std::io::Write for Mem {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        std::io::Write::write(&mut self.output, b)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn req() -> Request {
    Request { v: VERSION, op: OP_SECRET.into(), prompt: "p".into(), cwd: "c".into() }
}

#[test]
fn 小幫手讀得懂成功與各種失敗的回覆() {
    let mut ok = Header::secret(FAKE_SECRET.len()).line();
    ok.extend_from_slice(FAKE_SECRET.as_bytes());
    let mut m = Mem { input: std::io::Cursor::new(ok), output: vec![] };
    assert_eq!(&talk(&mut m, &req()).unwrap()[..], FAKE_SECRET.as_bytes());
    // 送出去的是一行 JSON，裡面沒有密碼
    assert!(m.output.ends_with(b"\n") && !String::from_utf8_lossy(&m.output).contains("ZZ-12345"));

    for (input, want) in [
        (Header::fail(REASON_CANCELLED).line(), REASON_CANCELLED),
        (b"garbage\n".to_vec(), "bad_reply"),
        (vec![], "unavailable"),
        (Header::secret(10).line(), "unavailable"), // 說有 10 個位元組卻斷線
        (Header::secret(MAX_SECRET_BYTES + 1).line(), "bad_reply"),
    ] {
        let mut m = Mem { input: std::io::Cursor::new(input), output: vec![] };
        assert_eq!(talk(&mut m, &req()).unwrap_err(), want);
    }
}

fn no_server_env() -> ClientEnv {
    ClientEnv { pipe_name: format!("{}nobody-{}", super::pipe::TEST_PREFIX, std::process::id()), expected_server: None, cwd: "c".into(), ssh_prompt_kind: None }
}

#[test]
fn asn沒開時小幫手直接失敗不自己收密碼() {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run(&["Password: ".into()], &no_server_env(), &mut out, &mut err);
    assert_eq!(code, EXIT_UNAVAILABLE);
    assert!(out.is_empty(), "失敗時標準輸出必須是空的");
    let e = String::from_utf8(err).unwrap();
    assert!(e.contains("ASN 沒有在執行") && e.contains("請先開啟 ASN"), "{e}");
}

#[test]
fn ssh的確認與純訊息提示不處理() {
    for kind in ["confirm", "none"] {
        let mut env = no_server_env();
        env.ssh_prompt_kind = Some(kind.into());
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(run(&["Are you sure (yes/no)?".into()], &env, &mut out, &mut err), EXIT_REFUSED);
        assert!(out.is_empty());
        assert!(String::from_utf8(err).unwrap().contains("不是在要密碼"));
    }
}

// ---- 管道（Windows）----------------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use super::*;
    use crate::askpass::pipe;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT};
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

    static SEQ: AtomicUsize = AtomicUsize::new(0);
    fn test_pipe() -> String {
        format!("{}{}-{}", pipe::TEST_PREFIX, std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst))
    }

    fn env_for(name: &str, expected: Option<std::path::PathBuf>) -> ClientEnv {
        ClientEnv { pipe_name: name.to_string(), expected_server: expected, cwd: "C:/work/repo".into(), ssh_prompt_kind: None }
    }

    /// 在執行緒裡跑小幫手（它是同步的），回傳（結束碼, 標準輸出, 標準錯誤）
    async fn run_helper(env: ClientEnv, prompt: &str) -> (i32, Vec<u8>, String) {
        let p = prompt.to_string();
        tokio::task::spawn_blocking(move || {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run(&[p], &env, &mut out, &mut err);
            (code, out, String::from_utf8(err).unwrap())
        })
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn 整條路走一遍小幫手經真的管道拿到密碼() {
        let name = test_pipe();
        let f = Fake::with(vec![secret(FAKE_SECRET)]);
        // 對面行程 pid 由系統查（就是這個測試程序自己），再對行程表查出程式名稱
        let b = Arc::new(Broker::new(f.clone(), procs_with(std::process::id())));
        let server = serve(&name, b).unwrap();
        let me = std::env::current_exe().unwrap();
        let (code, out, err) = run_helper(env_for(&name, Some(me)), "Password for 'https://u@example.test': ").await;
        server.abort();
        assert_eq!(code, EXIT_OK, "{err}");
        assert_eq!(out, format!("{FAKE_SECRET}\n").into_bytes());
        assert!(err.is_empty(), "成功時標準錯誤必須是空的：{err}");
        assert_eq!(f.seen()[0].program, "git-remote-https.exe ← git.exe ← bash.exe", "對面 pid 要是系統查到的");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn 使用者取消小幫手回取消碼且什麼都不印() {
        let name = test_pipe();
        let f = Fake::with(vec![Verdict::Cancelled]);
        let server = serve(&name, broker(&f)).unwrap();
        let (code, out, err) = run_helper(env_for(&name, Some(std::env::current_exe().unwrap())), "p").await;
        server.abort();
        assert_eq!(code, EXIT_CANCELLED);
        assert!(out.is_empty() && err.contains("你取消了密碼輸入"), "{err}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn 對面不是asn的管道小幫手什麼都不送() {
        let name = test_pipe();
        let f = Fake::with(vec![secret(FAKE_SECRET)]);
        let server = serve(&name, broker(&f)).unwrap();
        // 期望的伺服器是別的程式：管道對面雖然連得上，也不能送出請求
        let other = Path::new(r"C:\Windows\System32\cmd.exe").to_path_buf();
        let (code, out, err) = run_helper(env_for(&name, Some(other)), "p").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        server.abort();
        assert_eq!(code, EXIT_NOT_ASN);
        assert!(out.is_empty() && err.contains("不是這個資料夾裡的 ASN"), "{err}");
        assert!(f.seen().is_empty(), "驗不過身分就不能送出任何請求");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn 管道名稱被別人先佔走時asn建不起來() {
        let name = test_pipe();
        let first = pipe::bind(&name).unwrap();
        assert!(pipe::bind(&name).is_err(), "已有人建了同名管道，第二個必須失敗，不能接手別人先建好的");
        drop(first);
    }

    unsafe fn dacl_sddl_of(h: HANDLE) -> String {
        let mut psd: *mut c_void = std::ptr::null_mut();
        let rc = GetSecurityInfo(h, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), &mut psd);
        assert_eq!(rc, 0, "讀不到管道的存取控制清單");
        let mut w: *mut u16 = std::ptr::null_mut();
        assert_ne!(ConvertSecurityDescriptorToStringSecurityDescriptorW(psd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut w, std::ptr::null_mut()), 0);
        let mut n = 0;
        while *w.add(n) != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(w, n));
        LocalFree(w as *mut c_void);
        LocalFree(psd);
        s
    }

    /// 這個測試沒辦法換成另一個 Windows 使用者去連線（需要第二個帳號），所以改驗「管道上設的存取控制清單」本身：
    /// 受保護（不繼承）、只有一筆允許、對象就是目前使用者的 SID，沒有 Everyone／一般使用者／驗證過的使用者等。
    #[tokio::test(flavor = "multi_thread")]
    async fn 管道的存取控制只允許目前使用者() {
        let name = test_pipe();
        let l = pipe::bind(&name).unwrap();
        let sid = pipe::user_id_string().unwrap();
        let sddl = unsafe { dacl_sddl_of(l.current_handle().unwrap()) };
        assert!(sddl.starts_with("D:P("), "要是受保護的存取控制清單：{sddl}");
        assert_eq!(sddl.matches('(').count(), 1, "只能有一筆：{sddl}");
        assert!(sddl.contains(&format!(";{sid})")), "那一筆必須是目前使用者：{sddl}");
        assert!(sddl.starts_with("D:P(A;"), "必須是允許項：{sddl}");
        for bad in [";WD)", ";BU)", ";AU)", ";AN)", ";IU)", ";NU)", ";BG)"] {
            assert!(!sddl.contains(bad), "不該對 {bad} 開放：{sddl}");
        }
        assert_eq!(pipe::dacl_sddl(&sid), format!("D:P(A;;GA;;;{sid})"));
    }
}

// ---- 守門：密碼的去處 ---------------------------------------------------------------------------------

/// 本資料夾的非測試原始碼（tests.rs 除外）
fn sources() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("askpass");
    let mut v = vec![];
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with(".rs") && name != "tests.rs" {
            v.push((name, std::fs::read_to_string(&p).unwrap().replace("\r\n", "\n")));
        }
    }
    v.sort();
    v
}

/// 去掉註解（// 到行尾），避免說明文字干擾關鍵字掃描
fn code_only(s: &str) -> String {
    s.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

#[test]
fn 守門_掃描器看得到所有檔案() {
    let names: Vec<String> = sources().into_iter().map(|x| x.0).collect();
    for n in ["client.rs", "dialog.rs", "mod.rs", "pipe.rs", "proto.rs", "server.rs"] {
        assert!(names.contains(&n.to_string()), "掃描漏了 {n}");
    }
}

#[test]
fn 守門_密碼不進log不進格式化輸出() {
    // 任何會輸出文字的巨集那一行，都不准提到密碼／內容變數
    let macros = ["println!(", "eprintln!(", "elog!(", "olog!(", "format!(", "writeln!(", "write!(", "print!(", "eprint!(", "dbg!(", "panic!(", "unwrap_or_else(|e| e", "log::", "tracing::"];
    let mut bad = vec![];
    for (name, text) in sources() {
        for (i, line) in code_only(&text).lines().enumerate() {
            if macros.iter().any(|m| line.contains(m)) {
                let l = line.to_lowercase();
                if l.contains("secret") || l.contains("password") || l.contains("verdict") || l.contains("body") {
                    bad.push(format!("{name}:{}: {}", i + 1, line.trim()));
                }
            }
        }
    }
    assert!(bad.is_empty(), "這些輸出可能帶出密碼：\n{}", bad.join("\n"));
}

#[test]
fn 守門_持有密碼的型別不能自動衍生除錯輸出() {
    for (name, text) in sources() {
        let lines: Vec<&str> = text.lines().collect();
        for (i, l) in lines.iter().enumerate() {
            if l.contains("Zeroizing<String>") || l.contains("Zeroizing<Vec<u8>>") {
                // 往上找最近的型別宣告與它上方的 derive
                for j in (i.saturating_sub(8)..=i).rev() {
                    if lines[j].trim_start().starts_with("pub enum") || lines[j].trim_start().starts_with("pub struct") || lines[j].trim_start().starts_with("struct") || lines[j].trim_start().starts_with("enum") {
                        let above = lines[j.saturating_sub(2)..j].join(" ");
                        assert!(!(above.contains("derive(") && above.contains("Debug")), "{name}:{} 持有密碼的型別不能 derive(Debug)", j + 1);
                        break;
                    }
                }
            }
        }
    }
}

#[test]
fn 守門_密碼不寫檔不進環境變數不進指令列不進剪貼簿() {
    let banned = ["fs::write", "File::create", "create_new(", ".append(true)", "write_atomic", "set_var(", "remove_var(", "Command::new", "clipboard", "Clipboard", "localStorage", ".envs(", ".env("];
    let mut bad = vec![];
    for (name, text) in sources() {
        for (i, line) in code_only(&text).lines().enumerate() {
            for b in banned {
                if line.contains(b) {
                    bad.push(format!("{name}:{}: 含「{b}」：{}", i + 1, line.trim()));
                }
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
    // 只讀這兩個環境變數（都不是機密）；測試管道覆寫只在除錯版
    for (name, text) in sources() {
        for l in code_only(&text).lines().filter(|l| l.contains("env::var(")) {
            assert!(l.contains("ASN_ASKPASS_PIPE") || l.contains("SSH_ASKPASS_PROMPT"), "{name}: 讀了不認得的環境變數：{l}");
        }
    }
    let pipe = code_only(&sources().into_iter().find(|x| x.0 == "pipe.rs").unwrap().1);
    let at = pipe.find("ASN_ASKPASS_PIPE").expect("找不到測試管道覆寫");
    assert!(pipe[at.saturating_sub(200)..at].contains("#[cfg(debug_assertions)]"), "測試管道覆寫必須只在除錯版");
}

#[test]
fn 守門_小幫手本身沒有任何收密碼的能力() {
    let client = sources().into_iter().find(|x| x.0 == "client.rs").unwrap().1;
    let code = code_only(&client);
    for banned in ["stdin", "read_line", "rpassword", "tauri", "WebviewWindow", "MessageBox", "Console", "winapi", "CreateWindow", "dialog"] {
        assert!(!code.contains(banned), "小幫手不能有「{banned}」：它不自己收密碼");
    }
    // 連不上就直接失敗：連線失敗的分支只能 return 結束碼，不能往下做別的收集
    let at = code.find("Err(_) => {").expect("找不到連線失敗分支");
    let branch: String = code[at..].lines().take(5).collect::<Vec<_>>().join("\n");
    assert!(branch.contains("EXIT_UNAVAILABLE") && branch.contains("return"), "{branch}");
}

#[test]
fn 守門_小幫手送出請求之前一定先驗對面是asn() {
    let client = sources().into_iter().find(|x| x.0 == "client.rs").unwrap().1;
    let verify = client.find("server_exe(&conn)").expect("沒有驗證對面行程");
    let talk = client.find("talk(&mut conn").expect("找不到送出請求");
    assert!(verify < talk, "必須先驗證再送出");
    let pipe = sources().into_iter().find(|x| x.0 == "pipe.rs").unwrap().1;
    for need in ["first_pipe_instance(first)", "reject_remote_clients(true)", "SECURITY_IDENTIFICATION", "D:P(A;;GA;;;"] {
        assert!(pipe.contains(need), "管道安全設定缺了：{need}");
    }
    assert!(pipe.contains("bind(name: &str)") && pipe.contains("create_instance(name, true)"), "ASN 建第一個執行個體必須要求 first");
}

#[test]
fn 守門_確認窗頁面不留存輸入() {
    let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("ui");
    let js = std::fs::read_to_string(ui.join("askpass.js")).unwrap();
    let html = std::fs::read_to_string(ui.join("askpass.html")).unwrap();
    for banned in ["localStorage", "sessionStorage", "clipboard", "console.", "location.hash", "history.", "indexedDB", "document.cookie"] {
        assert!(!js.contains(banned), "確認窗不能用「{banned}」");
    }
    assert!(html.contains("type=\"password\"") && html.contains("autocomplete=\"off\""));
    assert!(js.contains("secret.value = ''"), "送出後要清空輸入欄");
}
