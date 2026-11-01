//! 互動子程序：持續讀它的輸出、寫它的標準輸入、逾時殺整棵樹（登入流程用，#628）。
//! 和別處「等它結束」的 Runner 不同：登入子程序要先印出網址、等外面把授權碼送回來才會往下走。
//! 啟動時把「編號＋建立時間」記到檔案，ASN 被關掉又重開時，只在建立時間相符才清掉上次留下的子程序。

use crate::nowin::NoWindow;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// 一行輸出最多收這麼多字元（超過就截掉，免得被灌爆）
const MAX_LINE_CHARS: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum ReadLine {
    Line(String),
    Timeout,
    /// 輸出結束（子程序關掉了輸出）
    Eof,
}

pub trait LoginProc {
    /// 最多等 `timeout` 讀一行
    fn read_line(&mut self, timeout: Duration) -> ReadLine;
    /// 寫進子程序的標準輸入。呼叫端負責不把內容寫進 log
    fn write_stdin(&mut self, data: &[u8]) -> Result<(), String>;
    /// 最多等 `timeout` 讓它結束；結束了回結束碼，還沒結束回 None
    fn wait(&mut self, timeout: Duration) -> Option<i32>;
    /// 結束整棵程序樹（只動自己啟動的這一棵）
    fn kill_tree(&mut self);
}

pub trait Spawner {
    fn spawn(&self, exe: &Path, args: &[&str]) -> Result<Box<dyn LoginProc>, String>;
}

/// 去掉終端機控制序列（顏色、游標），只留文字
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                for n in it.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            } else if it.peek() == Some(&']') {
                // OSC：到 BEL 或 ESC \ 為止
                it.next();
                while let Some(n) = it.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        it.next();
                        break;
                    }
                }
            } else {
                it.next();
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

pub struct RealSpawner {
    /// 記錄子程序編號與建立時間的檔案（None＝不記）
    pub pid_file: Option<PathBuf>,
}

impl Spawner for RealSpawner {
    fn spawn(&self, exe: &Path, args: &[&str]) -> Result<Box<dyn LoginProc>, String> {
        let mut child = Command::new(exe)
            .no_window()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("無法啟動登入程序：{e}"))?;
        let (tx, rx) = channel::<String>();
        for pipe in [child.stdout.take().map(Pipe::Out), child.stderr.take().map(Pipe::Err)].into_iter().flatten() {
            let tx = tx.clone();
            std::thread::spawn(move || match pipe {
                Pipe::Out(p) => pump(BufReader::new(p), tx),
                Pipe::Err(p) => pump(BufReader::new(p), tx),
            });
        }
        drop(tx);
        let stdin = child.stdin.take();
        let pid = child.id();
        if let Some(f) = &self.pid_file {
            write_pid_file(f, pid, crate::heartbeat::process_started_ms(pid));
        }
        Ok(Box::new(RealProc { child, stdin, rx, pid, pid_file: self.pid_file.clone(), done: false }))
    }
}

enum Pipe {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

fn pump<R: std::io::Read>(mut r: BufReader<R>, tx: std::sync::mpsc::Sender<String>) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let s = String::from_utf8_lossy(&buf);
                let t: String = s.trim_end_matches(['\n', '\r']).chars().take(MAX_LINE_CHARS).collect();
                if tx.send(t).is_err() {
                    return;
                }
            }
        }
    }
}

struct RealProc {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<String>,
    pid: u32,
    pid_file: Option<PathBuf>,
    done: bool,
}

impl RealProc {
    fn finish(&mut self) {
        if !self.done {
            self.done = true;
            if let Some(f) = &self.pid_file {
                let _ = std::fs::remove_file(f);
            }
        }
    }
}

impl LoginProc for RealProc {
    fn read_line(&mut self, timeout: Duration) -> ReadLine {
        match self.rx.recv_timeout(timeout) {
            Ok(l) => ReadLine::Line(l),
            Err(RecvTimeoutError::Timeout) => ReadLine::Timeout,
            Err(RecvTimeoutError::Disconnected) => ReadLine::Eof,
        }
    }

    fn write_stdin(&mut self, data: &[u8]) -> Result<(), String> {
        let Some(si) = self.stdin.as_mut() else {
            return Err("登入程序的輸入已關閉".to_string());
        };
        si.write_all(data).and_then(|_| si.flush()).map_err(|_| "無法把資料送給登入程序".to_string())
    }

    fn wait(&mut self, timeout: Duration) -> Option<i32> {
        let start = Instant::now();
        loop {
            match self.child.try_wait() {
                Ok(Some(st)) => {
                    self.finish();
                    return Some(st.code().unwrap_or(-1));
                }
                Ok(None) => {}
                Err(_) => return None,
            }
            if start.elapsed() >= timeout {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn kill_tree(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            self.finish();
            return;
        }
        // 只結束自己啟動、記下編號的這一棵
        let _ = Command::new("taskkill").no_window().args(["/PID", &self.pid.to_string(), "/T", "/F"]).output();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.finish();
    }
}

impl Drop for RealProc {
    fn drop(&mut self) {
        // 沒走完就被丟掉（出錯或被取消）也不留孤兒
        self.kill_tree();
    }
}

/// 跑一個短命令、取標準輸出（最多 8 KB）與結束碼；逾時只結束自己啟動的這一棵並回錯
pub fn run_capture(exe: &Path, args: &[&str], timeout: Duration) -> Result<(i32, String), String> {
    use std::io::Read;
    let mut child = Command::new(exe)
        .no_window()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("無法執行指令：{e}"))?;
    let pid = child.id();
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(-1),
            Ok(None) => {}
            Err(e) => return Err(format!("等不到指令結束：{e}")),
        }
        if start.elapsed() >= timeout {
            let _ = Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).output();
            let _ = child.kill();
            let _ = child.wait();
            return Err("指令跑太久，已結束它".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut out = String::new();
    if let Some(so) = child.stdout.take() {
        let _ = so.take(8192).read_to_string(&mut out);
    }
    Ok((code, out))
}

fn write_pid_file(path: &Path, pid: u32, started_ms: Option<u64>) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({ "pid": pid, "started_ms": started_ms });
    let _ = std::fs::write(path, body.to_string());
}

/// 上次留下的登入子程序：檔案裡的編號現在還活著，而且建立時間和當時記的一樣才結束（編號可能已被別的程序用掉）。
/// 回傳有沒有結束了一個程序。檔案一定會刪掉
pub fn reap_stale_at(path: &Path, started_of: &dyn Fn(u32) -> Option<u64>, kill: &dyn Fn(u32)) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let _ = std::fs::remove_file(path);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    let (Some(pid), Some(was)) = (v.get("pid").and_then(|x| x.as_u64()), v.get("started_ms").and_then(|x| x.as_u64())) else {
        return false;
    };
    let pid = pid as u32;
    if started_of(pid) == Some(was) {
        kill(pid);
        true
    } else {
        false
    }
}

/// 真的環境版：ASN 啟動時呼叫一次
pub fn reap_stale(path: &Path) -> bool {
    reap_stale_at(path, &crate::heartbeat::process_started_ms, &|pid| {
        let _ = Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn 控制序列去掉_只留文字() {
        assert_eq!(strip_ansi("\u{1b}[32mhttps://claude.ai/x\u{1b}[0m\r"), "https://claude.ai/x");
        assert_eq!(strip_ansi("a\u{1b}]8;;https://x\u{7}b"), "ab");
        assert_eq!(strip_ansi("平常文字"), "平常文字");
    }

    #[test]
    fn 殘留子程序_編號和建立時間都相符才結束() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("login.pid");
        write_pid_file(&f, 4242, Some(1000));
        let killed = RefCell::new(vec![]);
        assert!(reap_stale_at(&f, &|_| Some(1000), &|p| killed.borrow_mut().push(p)));
        assert_eq!(*killed.borrow(), vec![4242]);
        assert!(!f.exists(), "檔案一定刪掉");
    }

    #[test]
    fn 殘留子程序_編號被別的程序用掉就不動() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("login.pid");
        write_pid_file(&f, 4242, Some(1000));
        let killed = RefCell::new(vec![]);
        assert!(!reap_stale_at(&f, &|_| Some(2000), &|p| killed.borrow_mut().push(p)), "建立時間不同");
        assert!(killed.borrow().is_empty());
        assert!(!f.exists());
        // 量不到建立時間（程序已不在）也不動
        write_pid_file(&f, 4242, Some(1000));
        assert!(!reap_stale_at(&f, &|_| None, &|p| killed.borrow_mut().push(p)));
        // 記錄時就量不到建立時間：不下結論，不動
        write_pid_file(&f, 4242, None);
        assert!(!reap_stale_at(&f, &|_| Some(1000), &|p| killed.borrow_mut().push(p)));
        assert!(killed.borrow().is_empty());
        // 壞檔
        std::fs::write(&f, "not json").unwrap();
        assert!(!reap_stale_at(&f, &|_| Some(1000), &|p| killed.borrow_mut().push(p)));
        assert!(killed.borrow().is_empty());
    }

    /// 真的子程序：印兩行、讀一行標準輸入、再印出來。這條只在 Windows 的 cmd 上跑
    #[cfg(windows)]
    #[test]
    fn 真的子程序能讀輸出_寫輸入_等結束() {
        let sp = RealSpawner { pid_file: None };
        // set /p 讀一行標準輸入
        let mut p = sp.spawn(Path::new("cmd.exe"), &["/V:ON", "/Q", "/C", "echo first& echo second& set /p X=& echo got:!X!"]).unwrap();
        let mut seen = vec![];
        for _ in 0..40 {
            match p.read_line(Duration::from_millis(250)) {
                ReadLine::Line(l) => {
                    let l = strip_ansi(&l);
                    if l.trim() == "second" {
                        seen.push(l);
                        break;
                    }
                    seen.push(l);
                }
                ReadLine::Timeout => {}
                ReadLine::Eof => break,
            }
        }
        assert!(seen.iter().any(|l| l.trim() == "first"), "{seen:?}");
        p.write_stdin(b"hello\r\n").unwrap();
        let mut got = false;
        for _ in 0..40 {
            match p.read_line(Duration::from_millis(250)) {
                ReadLine::Line(l) if l.contains("got:hello") => {
                    got = true;
                    break;
                }
                ReadLine::Eof => break,
                _ => {}
            }
        }
        assert!(got, "輸入沒有送到");
        assert_eq!(p.wait(Duration::from_secs(5)), Some(0));
    }

    #[cfg(windows)]
    #[test]
    fn 真的子程序逾時能殺掉整棵() {
        let d = tempfile::tempdir().unwrap();
        let pidf = d.path().join("login.pid");
        let sp = RealSpawner { pid_file: Some(pidf.clone()) };
        let mut p = sp.spawn(Path::new("cmd.exe"), &["/Q", "/C", "ping -n 30 127.0.0.1 >nul"]).unwrap();
        assert!(pidf.exists(), "啟動時記下編號");
        assert_eq!(p.wait(Duration::from_millis(300)), None, "還在跑");
        p.kill_tree();
        assert!(p.wait(Duration::from_secs(5)).is_some(), "殺掉後已結束");
        assert!(!pidf.exists(), "結束後記錄檔刪掉");
    }
}
