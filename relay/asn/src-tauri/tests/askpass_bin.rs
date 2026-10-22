//! 真的把 asn-askpass 執行檔跑起來：用除錯版才認的測試管道（名稱前綴 asn-askpass-test-），
//! 由這個測試程序自己當「ASN」（假確認窗，不開任何視窗），假密碼字串，不碰真實的 ASN 與使用者設定。
#![cfg(windows)]
use asn_lib::askpass::server::{BoxFut, Broker, ConfirmRequest, Confirmer, Procs, Verdict};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

const FAKE: &str = "假密碼-BIN-98765?";
const PIPE_PREFIX: &str = "asn-askpass-test-";

struct Fake(Mutex<Vec<ConfirmRequest>>, Option<&'static str>);
impl Confirmer for Fake {
    fn ask(&self, req: ConfirmRequest) -> BoxFut<'_, Verdict> {
        Box::pin(async move {
            self.0.lock().unwrap().push(req);
            match self.1 {
                Some(s) => Verdict::Secret(Zeroizing::new(s.to_string())),
                None => Verdict::Cancelled,
            }
        })
    }
}

fn helper(pipe: &str, cwd: &std::path::Path, stdin_text: &str, prompt: &str) -> (i32, Vec<u8>, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_asn-askpass"));
    c.arg(prompt)
        .current_dir(cwd)
        .env("ASN_ASKPASS_PIPE", pipe)
        .env_remove("SSH_ASKPASS_PROMPT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000); // 不閃主控台視窗
    let mut child = c.spawn().unwrap();
    // 給它一個「看得到的密碼」放在標準輸入：小幫手如果偷讀標準輸入，這個字串就會跑到輸出
    let mut si = child.stdin.take().unwrap();
    let _ = si.write_all(stdin_text.as_bytes());
    drop(si);
    let o = child.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), o.stdout, String::from_utf8_lossy(&o.stderr).to_string())
}

#[test]
fn asn沒開時執行檔直接失敗標準輸出空白且不讀標準輸入() {
    let tmp = tempfile::tempdir().unwrap();
    let pipe = format!("{PIPE_PREFIX}bin-none-{}", std::process::id());
    let (code, out, err) = helper(&pipe, tmp.path(), "標準輸入的假密碼\n", "Password for 'https://u@example.test': ");
    assert_eq!(code, 1, "{err}");
    assert!(out.is_empty(), "標準輸出必須是空的：{}", String::from_utf8_lossy(&out));
    assert!(err.contains("ASN 沒有在執行"), "{err}");
    assert!(!err.contains("標準輸入的假密碼"));
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0, "不該在工作資料夾留下任何檔案");
}

#[tokio::test(flavor = "multi_thread")]
async fn 整條路執行檔經真的管道拿到密碼只印在標準輸出() {
    let pipe = format!("{PIPE_PREFIX}bin-ok-{}", std::process::id());
    let f = Arc::new(Fake(Mutex::new(vec![]), Some(FAKE)));
    let procs: Procs = Arc::new(|| asn_lib::cli::process_table().ok());
    let server = asn_lib::askpass::server::serve(&pipe, Arc::new(Broker::new(f.clone(), procs))).unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().to_path_buf();
    let p2 = pipe.clone();
    let (code, out, err) = tokio::task::spawn_blocking(move || helper(&p2, &cwd, "", "Password for 'https://u@example.test': ")).await.unwrap();
    server.abort();
    assert_eq!(code, 0, "{err}");
    assert_eq!(out, format!("{FAKE}\n").into_bytes());
    assert!(err.is_empty(), "{err}");
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    let seen = f.0.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].prompt, "Password for 'https://u@example.test':");
    assert!(seen[0].cwd.to_lowercase().contains(&tmp.path().file_name().unwrap().to_string_lossy().to_lowercase()), "工作資料夾：{}", seen[0].cwd);
    // 對面行程是系統查到的：小幫手的父行程就是這個測試程序
    let me = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().to_string();
    assert!(seen[0].program.to_lowercase().contains(&me.to_lowercase()), "程式：{}", seen[0].program);
}

#[tokio::test(flavor = "multi_thread")]
async fn 使用者取消時執行檔回取消碼() {
    let pipe = format!("{PIPE_PREFIX}bin-cancel-{}", std::process::id());
    let f = Arc::new(Fake(Mutex::new(vec![]), None));
    let procs: Procs = Arc::new(|| asn_lib::cli::process_table().ok());
    let server = asn_lib::askpass::server::serve(&pipe, Arc::new(Broker::new(f, procs))).unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().to_path_buf();
    let (code, out, err) = tokio::task::spawn_blocking(move || helper(&pipe, &cwd, "", "p")).await.unwrap();
    server.abort();
    assert_eq!(code, 2);
    assert!(out.is_empty() && err.contains("你取消了密碼輸入"), "{err}");
}
