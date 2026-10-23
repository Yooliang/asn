//! ASN 這一端：收管道上的請求、排隊、叫確認窗、把結果（或拒絕原因）回給小幫手。
//! 確認窗本身是可注入的（[`Confirmer`]）：正式版是 dialog.rs 的 Tauri 視窗，測試用假的，不開任何真視窗。
//! #23 的權限詢問未來共用同一個確認窗：[`ConfirmKind::Permission`] 與 [`Verdict::Allow`]／[`Verdict::Deny`] 先預留，管道這條路暫不接受。
use super::proto::*;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ConfirmKind {
    /// 輸入一段機密（密碼、通行片語）
    Secret,
    /// 預留給 #23：只問「允許／拒絕」，沒有輸入欄
    Permission,
}

#[derive(Debug, Clone)]
pub struct ConfirmRequest {
    pub id: u64,
    pub kind: ConfirmKind,
    /// 哪個程式（行程鏈名稱，已清理過）
    pub program: String,
    /// 工作資料夾（小幫手自報，已清理過）
    pub cwd: String,
    /// 要什麼（git／ssh 的提示文字，已清理過）
    pub prompt: String,
    pub timeout: Duration,
    /// 遠端密碼請求（#26 第二期）才有：哪台設備在要（後台查出的設備名稱）；本機小幫手的請求是 None
    pub origin: Option<String>,
    /// 遠端密碼請求才有：請求端公鑰指紋，供使用者與請求端核對
    pub fingerprint: Option<String>,
}

/// 確認窗的結果。自訂 Debug：密碼不會被印出來
pub enum Verdict {
    Secret(Zeroizing<String>),
    Allow,
    Deny,
    /// 使用者按取消或關掉視窗
    Cancelled,
    /// 逾時（由 [`Broker`] 判定，確認窗不必自己算）
    TimedOut,
}

impl std::fmt::Debug for Verdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Verdict::Secret(_) => f.write_str("Secret(<已隱藏>)"),
            Verdict::Allow => f.write_str("Allow"),
            Verdict::Deny => f.write_str("Deny"),
            Verdict::Cancelled => f.write_str("Cancelled"),
            Verdict::TimedOut => f.write_str("TimedOut"),
        }
    }
}

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 跳出確認窗並等結果。實作要保證：回傳的 future 被丟棄（逾時、對方斷線）時，視窗要跟著關掉、記憶體中的輸入要清掉
pub trait Confirmer: Send + Sync {
    fn ask(&self, req: ConfirmRequest) -> BoxFut<'_, Verdict>;
}

/// 行程表：pid → (父 pid, 執行檔名)
pub type Procs = Arc<dyn Fn() -> Option<crate::cli::ProcTable> + Send + Sync>;

pub struct Broker {
    confirmer: Arc<dyn Confirmer>,
    gate: Semaphore,
    waiting: AtomicUsize,
    next_id: AtomicU64,
    timeout: Duration,
    procs: Procs,
}

struct WaitGuard<'a>(&'a AtomicUsize);
impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 一直讀到對面關閉（或出錯）才完成；對面多送的內容一律丟掉
async fn peer_closed<R: AsyncRead + Unpin>(r: &mut R) {
    let mut b = [0u8; 64];
    loop {
        match r.read(&mut b).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}

async fn read_request<R: AsyncBufReadExt + Unpin>(r: &mut R) -> Option<Request> {
    let mut buf = Vec::new();
    let mut limited = r.take(MAX_REQUEST_BYTES as u64 + 1);
    limited.read_until(b'\n', &mut buf).await.ok()?;
    if buf.last() != Some(&b'\n') || buf.len() > MAX_REQUEST_BYTES {
        return None;
    }
    serde_json::from_slice(&buf).ok()
}

impl Broker {
    pub fn new(confirmer: Arc<dyn Confirmer>, procs: Procs) -> Broker {
        Broker { confirmer, gate: Semaphore::new(1), waiting: AtomicUsize::new(0), next_id: AtomicU64::new(1), timeout: DIALOG_TIMEOUT, procs }
    }

    /// 測試用：縮短確認窗逾時
    pub fn with_timeout(mut self, t: Duration) -> Broker {
        self.timeout = t;
        self
    }

    /// 程式名稱（行程鏈）：從呼叫者的父行程往上最多三層，例如「git-remote-https.exe ← git.exe ← bash.exe」
    fn describe_program(&self, peer_pid: Option<u32>) -> String {
        let unknown = "（無法辨識）".to_string();
        let (Some(pid), Some(t)) = (peer_pid, (self.procs)()) else { return unknown };
        let mut names = Vec::new();
        let mut cur = t.get(&pid).map(|x| x.0).unwrap_or(0);
        for _ in 0..3 {
            let Some((parent, name)) = t.get(&cur) else { break };
            names.push(clean_display(name, 60));
            cur = *parent;
        }
        if names.is_empty() {
            unknown
        } else {
            names.join(" ← ")
        }
    }

    /// 處理一條連線（讀請求 → 排隊 → 確認窗 → 回覆）。`peer_pid` 是系統查到的對面行程，None＝查不到
    pub async fn handle<S: AsyncRead + AsyncWrite + Send + Unpin>(&self, stream: S, peer_pid: Option<u32>) {
        let (rd, mut wr) = tokio::io::split(stream);
        let mut rd = BufReader::new(rd);
        let req = match tokio::time::timeout(Duration::from_secs(10), read_request(&mut rd)).await {
            Ok(Some(r)) => r,
            _ => return fail(&mut wr, REASON_BAD).await,
        };
        if req.v != VERSION || req.op != OP_SECRET {
            return fail(&mut wr, REASON_UNSUPPORTED).await;
        }
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_QUEUE {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return fail(&mut wr, REASON_BUSY).await;
        }
        let _wait = WaitGuard(&self.waiting);

        // 同時一扇確認窗：排隊等；排隊時對方先放棄（例如 git 被中斷）就不用再問了
        let _permit = tokio::select! {
            p = self.gate.acquire() => match p { Ok(p) => p, Err(_) => return },
            _ = peer_closed(&mut rd) => return,
        };

        let creq = ConfirmRequest {
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            kind: ConfirmKind::Secret,
            program: self.describe_program(peer_pid),
            cwd: clean_display(&req.cwd, 200),
            prompt: clean_display(&req.prompt, 300),
            timeout: self.timeout,
            origin: None,
            fingerprint: None,
        };
        drop(req);
        let verdict = tokio::select! {
            v = tokio::time::timeout(self.timeout, self.confirmer.ask(creq)) => v.unwrap_or(Verdict::TimedOut),
            _ = peer_closed(&mut rd) => return,
        };
        match verdict {
            Verdict::Secret(s) if s.len() <= MAX_SECRET_BYTES => {
                let ok = async {
                    wr.write_all(&Header::secret(s.len()).line()).await?;
                    wr.write_all(s.as_bytes()).await?;
                    wr.flush().await
                }
                .await;
                drop(s);
                if ok.is_ok() {
                    // 等對方讀完關閉，避免我們先關而讓資料來不及被讀走
                    let _ = tokio::time::timeout(Duration::from_secs(5), peer_closed(&mut rd)).await;
                }
            }
            Verdict::Secret(_) => fail(&mut wr, REASON_BAD).await,
            Verdict::TimedOut => fail(&mut wr, REASON_TIMEOUT).await,
            Verdict::Cancelled | Verdict::Deny => fail(&mut wr, REASON_CANCELLED).await,
            // 管道這條路暫不接受只問允許／拒絕的請求（留給 #23）
            Verdict::Allow => fail(&mut wr, REASON_UNSUPPORTED).await,
        }
    }
}

async fn fail<W: AsyncWrite + Unpin>(w: &mut W, reason: &str) {
    let _ = w.write_all(&Header::fail(reason).line()).await;
    let _ = w.flush().await;
}

/// 開始在管道上服務。名字被別人佔走（或其他原因建不起來）就回錯誤，由呼叫端記一行 log（不含任何機密）。要在 tokio 執行環境內呼叫
#[cfg(windows)]
pub fn serve(name: &str, broker: Arc<Broker>) -> std::io::Result<tokio::task::JoinHandle<()>> {
    let mut listener = super::pipe::bind(name)?;
    Ok(tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((conn, pid)) => {
                    let b = broker.clone();
                    tokio::spawn(async move { b.handle(conn, pid).await });
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(300)).await,
            }
        }
    }))
}

#[cfg(not(windows))]
pub fn serve(_name: &str, _broker: Arc<Broker>) -> std::io::Result<tokio::task::JoinHandle<()>> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "這個系統尚未支援密碼小幫手"))
}
