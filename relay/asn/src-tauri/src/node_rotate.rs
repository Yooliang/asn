//! 手機換一把新的節點金鑰（0.2.17，只有安卓會跑；電腦版不換）。
//!
//! 為什麼換：手機的節點金鑰檔改存金鑰庫加密之後（secret_file.rs），舊的金鑰（可能曾以明文留在備份或舊檔裡）仍然有效。
//! 手機啟動後自己換一把新的，換完舊的就失效，加密保存才有意義。只做一次（`key_rotated` 記號），換成功後不再換。
//!
//! 流程（每一步都能被中斷，重啟後收斂）：
//! 1. 前提：安卓、節點金鑰檔已是加密的（`ak1:` 開頭）、沒有 `key_rotated` 記號。
//! 2. 產生新金鑰（格式與長度同後台發的：32 位元組的 base64url），加密寫成 `<節點>.key.new`，再寫 `rotation.json`
//!    （換鑰編號、新金鑰的雜湊、已試次數、下次時間；**沒有任何金鑰內容**）。順序固定：先 `.new`、後 `rotation.json`。
//! 3. 用**舊**金鑰呼叫 `node_rotate_key`（帶新雜湊與換鑰編號；後台冪等，同一個編號重送回成功）。
//! 4. 成功：加鎖把 `.key.new` 原子換名蓋過 `<節點>.key`，寫 `key_rotated` 記號，刪 `rotation.json`，
//!    再通知執行中的收發室客戶端換上新金鑰（`Relay::set_key`，不必重啟；之後的請求就帶新的）。
//! 5. 失敗：照舊用舊金鑰；排重試：第 1、2、3 次失敗後分別等 1 分鐘、5 分鐘、30 分鐘（之後每 6 小時）；
//!    24 小時內最多試 3 次，用完就停到視窗結束（後台說太頻繁也是停 24 小時）；下次開 App 再繼續（開 App 那次不等排程）。
//! 6. 啟動時的收斂：
//!    - 有 `.key.new`＋`rotation.json`：照第 3 步重試。舊金鑰被拒（401，例如後台其實已換好、舊金鑰的寬限過了）→ 改用 `.key.new`
//!      打一次輕量的認證呼叫：通過就等於換好了，走第 4 步；兩把都被拒才算壞了，走原本的重新登入／重新配對。
//!    - 只有 `rotation.json`、沒有 `.key.new`：換名已經做完，補寫記號、刪 `rotation.json`。
//!    - 只有 `.key.new`、沒有 `rotation.json`：後台還沒被呼叫過，刪掉重來。
//!
//! 紀錄只有「換節點金鑰：開始／完成／稍後重試」；金鑰與雜湊都不進 log。
#![cfg_attr(not(target_os = "android"), allow(dead_code))]
use crate::android_keywrap::{Aead, PREFIX};
use crate::secret_file::{self, node_key_aad};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::{Path, PathBuf};

/// 換完的記號檔（有它就不再換）
pub const MARKER: &str = "key_rotated";
/// 進行中的換鑰狀態（不含金鑰）
pub const STATE_FILE: &str = "rotation.json";
/// 第 1、2、3 次失敗後的等待（毫秒）：1 分鐘、5 分鐘、30 分鐘
pub const DELAYS_MS: [u64; 3] = [60_000, 300_000, 1_800_000];
/// 之後每次失敗的等待：6 小時
pub const LONG_DELAY_MS: u64 = 6 * 3_600_000;
/// 24 小時內最多試幾次
pub const MAX_ATTEMPTS: u32 = 3;
/// 計次的視窗：24 小時
pub const WINDOW_MS: u64 = 24 * 3_600_000;

/// 一次後台呼叫的結果（只分這幾種）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallOutcome {
    Ok,
    /// 401：這把金鑰後台不認
    Unauthorized,
    /// 429：後台說換太頻繁
    RateLimited,
    /// 連線失敗、逾時、其他錯誤
    Failed,
}

/// 這一輪做完的結果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 不需要或不該換（原因見 [`Skip`]）
    Skipped(Skip),
    /// 換好了
    Done,
    /// 這次沒成功，到這個時間（毫秒）再試
    Retry(u64),
    /// 次數用完（或後台說太頻繁），不再試
    Paused,
    /// 舊金鑰、新金鑰都被後台拒絕：走原本的重新登入／重新配對
    NeedRelogin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    NotAndroid,
    NoKeystore,
    AlreadyDone,
    KeyMissing,
    NotSealed,
}

/// 換鑰要用到的外部東西（時間、亂數、加密、後台呼叫、通知客戶端）；正式版是 [`Live`]，測試換假的
pub trait Deps: Sync {
    fn is_android(&self) -> bool;
    fn now_ms(&self) -> u64;
    /// 新的節點金鑰（和後台發的同一種：32 位元組亂數的 base64url）
    fn new_key(&self) -> String;
    /// 新的換鑰編號（UUID）
    fn new_rotation_id(&self) -> String;
    fn aead(&self) -> Option<&dyn Aead>;
    /// 用 `key` 呼叫 node_rotate_key
    fn call_rotate(&self, key: &str, rotation_id: &str, new_hash: &str) -> impl Future<Output = CallOutcome> + Send;
    /// 用 `key` 打一次輕量的認證呼叫（通過＝Ok、被拒＝Unauthorized）
    fn call_probe(&self, key: &str) -> impl Future<Output = CallOutcome> + Send;
    fn sleep(&self, ms: u64) -> impl Future<Output = ()> + Send;
    /// 通知執行中的客戶端：之後請用這把新金鑰
    fn adopt(&self, new_key: &str);
}

/// 金鑰的雜湊（後台存的就是這個：金鑰字串的 SHA-256，小寫十六進位）
pub fn key_hash(key: &str) -> String {
    Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct RotationState {
    pub rotation_id: String,
    pub new_hash: String,
    pub attempts: u32,
    /// 計次視窗的起點（毫秒）
    pub window_start: u64,
    pub next_at: u64,
}

struct Paths {
    key: PathBuf,
    new_key: PathBuf,
    state: PathBuf,
    marker: PathBuf,
}

fn paths(dir: &Path, node: &str) -> Paths {
    Paths {
        key: dir.join(format!("{node}.key")),
        new_key: dir.join(format!("{node}.key.new")),
        state: dir.join(STATE_FILE),
        marker: dir.join(MARKER),
    }
}

/// 第 `failures` 次失敗後的等待（failures 從 1 起算）
pub fn delay_after(failures: u32) -> u64 {
    match failures {
        0 => 0,
        n if (n as usize) <= DELAYS_MS.len() => DELAYS_MS[n as usize - 1],
        _ => LONG_DELAY_MS,
    }
}

fn read_state(p: &Path) -> Option<RotationState> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn write_state(p: &Path, st: &RotationState) -> Result<(), String> {
    let text = serde_json::to_vec(st).map_err(|e| e.to_string())?;
    crate::device_id::write_private(p, &text).map_err(|e| format!("寫不了換鑰狀態：{e}"))
}

/// 檔案開頭是不是加密前綴（只看開頭，不讀內容）
fn is_sealed_file(p: &Path) -> Option<bool> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).ok()?;
    let mut buf = vec![0u8; PREFIX.len()];
    let n = f.read(&mut buf).ok()?;
    Some(n == PREFIX.len() && buf == PREFIX)
}

/// 跑到結束（含排程等待）：每一輪 [`run_once`]，要重試就睡到時間再來；其餘結果就收工
pub async fn run<D: Deps>(d: &D, dir: &Path, node: &str) -> Outcome {
    loop {
        let out = run_once(d, dir, node).await;
        match out {
            Outcome::Retry(at) => {
                elog!("換節點金鑰：稍後重試");
                d.sleep(at.saturating_sub(d.now_ms())).await;
            }
            Outcome::Done => {
                elog!("換節點金鑰：完成");
                return out;
            }
            _ => return out,
        }
    }
}

/// 做一輪（一次後台呼叫為限）。不睡、不重複
pub async fn run_once<D: Deps>(d: &D, dir: &Path, node: &str) -> Outcome {
    if !d.is_android() {
        return Outcome::Skipped(Skip::NotAndroid);
    }
    let Some(aead) = d.aead() else { return Outcome::Skipped(Skip::NoKeystore) };
    let p = paths(dir, node);
    if p.marker.exists() {
        return Outcome::Skipped(Skip::AlreadyDone);
    }
    match is_sealed_file(&p.key) {
        None => return Outcome::Skipped(Skip::KeyMissing),
        Some(false) => return Outcome::Skipped(Skip::NotSealed),
        Some(true) => {}
    }
    let now = d.now_ms();
    let state = match (read_state(&p.state), p.new_key.exists()) {
        (Some(st), true) => st,
        (Some(_), false) => {
            // 換名已經做完（先換名、才刪狀態）：補完收尾
            return match finish_marker(&p) {
                Ok(()) => Outcome::Done,
                Err(_) => Outcome::Retry(now + delay_after(1)),
            };
        }
        (None, leftover_new) => {
            if leftover_new {
                // 狀態檔是在呼叫後台之前寫的：沒有狀態檔＝後台還沒被呼叫過，這把可以丟
                let _ = std::fs::remove_file(&p.new_key);
            }
            match start_fresh(d, &p, node, aead, now) {
                Ok(st) => st,
                Err(_) => return Outcome::Retry(now + delay_after(1)),
            }
        }
    };
    attempt(d, &p, node, aead, state, now).await
}

/// 產生新金鑰、加密寫 `.key.new`、再寫狀態檔（順序不可對調）
fn start_fresh<D: Deps>(d: &D, p: &Paths, node: &str, aead: &dyn Aead, now: u64) -> Result<RotationState, String> {
    let key = d.new_key();
    {
        let _g = secret_file::lock();
        secret_file::write_sealed(&p.new_key, &node_key_aad(node), key.as_bytes(), aead)?;
    }
    let st = RotationState { rotation_id: d.new_rotation_id(), new_hash: key_hash(&key), attempts: 0, window_start: now, next_at: now };
    if let Err(e) = write_state(&p.state, &st) {
        let _ = std::fs::remove_file(&p.new_key);
        return Err(e);
    }
    Ok(st)
}

fn read_sealed_key(path: &Path, node: &str, aead: &dyn Aead) -> Option<String> {
    let k = secret_file::read_node_key(path, node, Some(aead)).ok()?;
    Some(k.trim().to_string()).filter(|s| !s.is_empty())
}

async fn attempt<D: Deps>(d: &D, p: &Paths, node: &str, aead: &dyn Aead, state: RotationState, now: u64) -> Outcome {
    // 計次視窗過了就重新計
    let state = if now.saturating_sub(state.window_start) >= WINDOW_MS {
        RotationState { attempts: 0, window_start: now, ..state }
    } else {
        state
    };
    // 次數用完：不再打換鑰，只用 .key.new 看一眼（後台可能其實已經換好、只是回應沒收到）
    if state.attempts >= MAX_ATTEMPTS {
        return match probe_new(d, p, node, aead).await {
            Some(true) => complete(d, p, node, aead),
            _ => Outcome::Paused,
        };
    }
    elog!("換節點金鑰：開始");
    // 先記下這次嘗試再呼叫（呼叫到一半被殺掉也算一次）
    let tried = RotationState { attempts: state.attempts + 1, next_at: now + delay_after(state.attempts + 1), ..state };
    if write_state(&p.state, &tried).is_err() {
        return Outcome::Retry(now + delay_after(tried.attempts));
    }
    let Some(old) = read_sealed_key(&p.key, node, aead) else {
        // 舊金鑰讀不出來（金鑰庫的包裝金鑰不見）：沒辦法用舊金鑰換，走重新登入／重新配對
        return Outcome::NeedRelogin;
    };
    let res = d.call_rotate(&old, &tried.rotation_id, &tried.new_hash).await;
    match res {
        CallOutcome::Ok => complete(d, p, node, aead),
        CallOutcome::Unauthorized => match probe_new(d, p, node, aead).await {
            Some(true) => complete(d, p, node, aead),
            Some(false) => Outcome::NeedRelogin,
            None => after_failure(&tried),
        },
        CallOutcome::RateLimited => {
            let paused = RotationState { attempts: MAX_ATTEMPTS, next_at: tried.window_start + WINDOW_MS, ..tried };
            let _ = write_state(&p.state, &paused);
            Outcome::Paused
        }
        CallOutcome::Failed => after_failure(&tried),
    }
}

/// 失敗後：第 3 次（用完次數）就停；其餘排下一次
fn after_failure(tried: &RotationState) -> Outcome {
    if tried.attempts >= MAX_ATTEMPTS {
        Outcome::Paused
    } else {
        Outcome::Retry(tried.next_at)
    }
}

/// 用 `.key.new` 打認證呼叫：Some(true)＝通過、Some(false)＝被拒、None＝沒辦法判斷（連線失敗、讀不出新金鑰）
async fn probe_new<D: Deps>(d: &D, p: &Paths, node: &str, aead: &dyn Aead) -> Option<bool> {
    let key = read_sealed_key(&p.new_key, node, aead)?;
    match d.call_probe(&key).await {
        CallOutcome::Ok => Some(true),
        CallOutcome::Unauthorized => Some(false),
        _ => None,
    }
}

/// 後台已經換好：把新金鑰換名蓋過舊的，寫記號、刪狀態，最後通知客戶端
fn complete<D: Deps>(d: &D, p: &Paths, node: &str, aead: &dyn Aead) -> Outcome {
    // 先確認新金鑰讀得出來（換名之後才發現讀不出來就來不及了）
    let Some(new_key) = read_sealed_key(&p.new_key, node, aead) else { return Outcome::NeedRelogin };
    {
        let _g = secret_file::lock();
        if std::fs::rename(&p.new_key, &p.key).is_err() {
            return Outcome::Retry(d.now_ms() + delay_after(1));
        }
        secret_file::sync_parent(&p.key);
    }
    // 換名之後的收尾失敗也不要緊：重啟時「只有狀態檔、沒有 .key.new」會補完
    let _ = finish_marker(p);
    d.adopt(&new_key);
    Outcome::Done
}

/// 收尾：先寫記號、再刪狀態檔（反過來的話，中間被中斷會再換一次）
fn finish_marker(p: &Paths) -> Result<(), String> {
    crate::device_id::write_private(&p.marker, b"1").map_err(|e| format!("寫不了換鑰記號：{e}"))?;
    let _ = std::fs::remove_file(&p.state);
    Ok(())
}

// ---------- 正式版 ----------

/// 手機上的正式依賴：金鑰庫、系統亂數與時鐘、收發室客戶端
pub struct Live {
    relay: std::sync::Arc<crate::relay::Relay>,
    aead: Option<Box<dyn Aead>>,
}

impl Live {
    pub fn new(relay: std::sync::Arc<crate::relay::Relay>) -> Live {
        Live { relay, aead: secret_file::platform_aead() }
    }
}

impl Deps for Live {
    fn is_android(&self) -> bool {
        cfg!(target_os = "android")
    }
    fn now_ms(&self) -> u64 {
        crate::heartbeat::now_ms()
    }
    fn new_key(&self) -> String {
        use base64::Engine;
        let mut b = [0u8; 32];
        getrandom::fill(&mut b).expect("系統亂數不可用");
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    }
    fn new_rotation_id(&self) -> String {
        crate::relay::new_client_id()
    }
    fn aead(&self) -> Option<&dyn Aead> {
        self.aead.as_deref()
    }
    async fn call_rotate(&self, key: &str, rotation_id: &str, new_hash: &str) -> CallOutcome {
        let body = json!({ "new_hash": new_hash, "rotation_id": rotation_id });
        outcome_of(self.relay.call_with_key(key, "node_rotate_key", Some(body)).await)
    }
    async fn call_probe(&self, key: &str) -> CallOutcome {
        outcome_of(self.relay.call_with_key(key, "whoami", None).await)
    }
    async fn sleep(&self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
    fn adopt(&self, new_key: &str) {
        self.relay.set_key(new_key.to_string());
    }
}

fn outcome_of(r: Result<(u16, Value), String>) -> CallOutcome {
    match r {
        Ok((200..=299, _)) => CallOutcome::Ok,
        Ok((401, _)) => CallOutcome::Unauthorized,
        Ok((429, _)) => CallOutcome::RateLimited,
        _ => CallOutcome::Failed,
    }
}

/// 手機啟動後在背景呼叫一次（lib.rs 只在安卓建置裡呼叫；電腦版連這個函式都不會被叫到，這裡也自己擋一次）
pub async fn run_live(relay: std::sync::Arc<crate::relay::Relay>, dir: PathBuf, node: String) {
    let live = Live::new(relay);
    let _ = run(&live, &dir, &node).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// 假的金鑰庫：AAD 的雜湊綁在密文前面；密文不含明文（XOR）
    struct Fake;
    impl Aead for Fake {
        fn seal(&self, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
            let mut out = Sha256::digest(aad)[..8].to_vec();
            out.extend(plain.iter().map(|b| b ^ 0x5a));
            Ok(out)
        }
        fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
            if sealed.len() < 8 || sealed[..8] != Sha256::digest(aad)[..8] {
                return Err("解不開".into());
            }
            Ok(sealed[8..].iter().map(|b| b ^ 0x5a).collect())
        }
    }

    const NODE: &str = "ph-test01";
    const OLD: &str = "OLD-KEY-plaintext_value-0123456789abcdefghij";

    /// 假的後台＋假的時鐘：照真後台的規則（現用／寬限中的舊雜湊都認、冪等、用新金鑰成功一次就清掉舊的、換鑰次數上限）
    struct Sim {
        android: bool,
        now: AtomicU64,
        seq: AtomicUsize,
        cur: Mutex<String>,
        prev: Mutex<Option<String>>,
        rid: Mutex<Option<String>>,
        rotations: AtomicUsize,
        net_down: AtomicBool,
        /// 後台做了、但回應沒收到
        lose_response: AtomicBool,
        server_rate_limited: AtomicBool,
        rotate_calls: AtomicUsize,
        probe_calls: AtomicUsize,
        adopted: Mutex<Vec<String>>,
        sleeps: Mutex<Vec<u64>>,
        keys_seen_in_calls: Mutex<Vec<String>>,
    }
    impl Sim {
        fn new() -> Sim {
            Sim {
                android: true,
                now: AtomicU64::new(1_000_000),
                seq: AtomicUsize::new(0),
                cur: Mutex::new(key_hash(OLD)),
                prev: Mutex::new(None),
                rid: Mutex::new(None),
                rotations: AtomicUsize::new(0),
                net_down: AtomicBool::new(false),
                lose_response: AtomicBool::new(false),
                server_rate_limited: AtomicBool::new(false),
                rotate_calls: AtomicUsize::new(0),
                probe_calls: AtomicUsize::new(0),
                adopted: Mutex::new(vec![]),
                sleeps: Mutex::new(vec![]),
                keys_seen_in_calls: Mutex::new(vec![]),
            }
        }
        /// 認證：現用的雜湊→過；寬限中的舊雜湊→過；用現用的成功就清掉舊的
        fn auth(&self, key: &str) -> bool {
            let h = key_hash(key);
            if *self.cur.lock().unwrap() == h {
                *self.prev.lock().unwrap() = None;
                return true;
            }
            self.prev.lock().unwrap().as_deref() == Some(h.as_str())
        }
        /// 寬限過了
        fn expire_grace(&self) {
            *self.prev.lock().unwrap() = None;
        }
        fn advance(&self, ms: u64) {
            self.now.fetch_add(ms, Ordering::SeqCst);
        }
    }
    impl Deps for Sim {
        fn is_android(&self) -> bool {
            self.android
        }
        fn now_ms(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }
        fn new_key(&self) -> String {
            format!("NEW-KEY-plaintext_value-{:02}-abcdefghijklmnopqrstuvwxyz", self.seq.fetch_add(1, Ordering::SeqCst))
        }
        fn new_rotation_id(&self) -> String {
            format!("00000000-0000-4000-8000-{:012}", self.seq.fetch_add(1, Ordering::SeqCst))
        }
        fn aead(&self) -> Option<&dyn Aead> {
            Some(&Fake)
        }
        async fn call_rotate(&self, key: &str, rotation_id: &str, new_hash: &str) -> CallOutcome {
            self.rotate_calls.fetch_add(1, Ordering::SeqCst);
            self.keys_seen_in_calls.lock().unwrap().push(key.to_string());
            if self.net_down.load(Ordering::SeqCst) {
                return CallOutcome::Failed;
            }
            if !self.auth(key) {
                return CallOutcome::Unauthorized;
            }
            // 冪等：同一次換鑰重送
            let same = self.rid.lock().unwrap().as_deref() == Some(rotation_id) && *self.cur.lock().unwrap() == new_hash;
            if !same {
                if self.server_rate_limited.load(Ordering::SeqCst) || self.rotations.load(Ordering::SeqCst) >= 3 {
                    return CallOutcome::RateLimited;
                }
                let old = std::mem::replace(&mut *self.cur.lock().unwrap(), new_hash.to_string());
                *self.prev.lock().unwrap() = Some(old);
                *self.rid.lock().unwrap() = Some(rotation_id.to_string());
                self.rotations.fetch_add(1, Ordering::SeqCst);
            }
            if self.lose_response.load(Ordering::SeqCst) {
                return CallOutcome::Failed;
            }
            CallOutcome::Ok
        }
        async fn call_probe(&self, key: &str) -> CallOutcome {
            self.probe_calls.fetch_add(1, Ordering::SeqCst);
            self.keys_seen_in_calls.lock().unwrap().push(key.to_string());
            if self.net_down.load(Ordering::SeqCst) {
                return CallOutcome::Failed;
            }
            if self.auth(key) {
                CallOutcome::Ok
            } else {
                CallOutcome::Unauthorized
            }
        }
        async fn sleep(&self, ms: u64) {
            self.sleeps.lock().unwrap().push(ms);
            self.advance(ms);
        }
        fn adopt(&self, new_key: &str) {
            self.adopted.lock().unwrap().push(new_key.to_string());
        }
    }

    /// 一台已加密存好舊金鑰的手機
    fn phone() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        assert!(secret_file::write_node_key(&d.path().join(format!("{NODE}.key")), NODE, OLD, Some(&Fake)));
        d
    }
    fn key_file(d: &Path) -> String {
        secret_file::read_node_key(&d.join(format!("{NODE}.key")), NODE, Some(&Fake)).unwrap()
    }
    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }
    fn cur_is(s: &Sim, key: &str) -> bool {
        *s.cur.lock().unwrap() == key_hash(key)
    }
    /// 每個檔案都不含任何金鑰明文
    fn no_plaintext(d: &Path) {
        for n in names(d) {
            let b = std::fs::read(d.join(&n)).unwrap();
            let t = String::from_utf8_lossy(&b);
            assert!(!t.contains("plaintext_value"), "{n} 含有金鑰明文");
        }
    }
    fn st_file(d: &Path) -> RotationState {
        read_state(&d.join(STATE_FILE)).unwrap()
    }

    #[tokio::test]
    async fn 一帆風順_換好_新金鑰接手_舊的失效_留記號_沒有殘檔() {
        let d = phone();
        let s = Sim::new();
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        let k = key_file(d.path());
        assert!(k.starts_with("NEW-KEY"), "金鑰檔換成新的");
        assert!(cur_is(&s, &k) && !cur_is(&s, OLD));
        assert_eq!(s.adopted.lock().unwrap().as_slice(), [k.clone()], "客戶端換上新金鑰");
        assert_eq!(names(d.path()), vec![format!("{NODE}.key"), MARKER.to_string()]);
        assert!(s.auth(&k), "新金鑰後台認");
        assert!(!s.auth(OLD), "用過新金鑰後舊的失效");
        no_plaintext(d.path());
        // 之後不再換
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::Skipped(Skip::AlreadyDone));
        assert_eq!(s.rotate_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn 新金鑰格式_和後台發的一樣_三十二位元組_base64url() {
        // 正式版的產生方式
        use base64::Engine;
        let mut b = [0u8; 32];
        getrandom::fill(&mut b).unwrap();
        let k = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
        assert_eq!(k.len(), 43);
        assert!(k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        let h = key_hash(&k);
        assert_eq!(h.len(), 64);
        assert!(h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)), "小寫十六進位");
        assert_eq!(key_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[tokio::test]
    async fn 電腦版不換_沒有加密的金鑰檔不換_有記號不換_沒有金鑰檔不換() {
        let d = phone();
        let mut s = Sim::new();
        s.android = false;
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::Skipped(Skip::NotAndroid));
        assert_eq!(names(d.path()), vec![format!("{NODE}.key")], "什麼都沒寫");
        assert_eq!(s.rotate_calls.load(Ordering::SeqCst) + s.probe_calls.load(Ordering::SeqCst), 0);

        let d2 = tempfile::tempdir().unwrap();
        std::fs::write(d2.path().join(format!("{NODE}.key")), OLD).unwrap();
        let s2 = Sim::new();
        assert_eq!(run_once(&s2, d2.path(), NODE).await, Outcome::Skipped(Skip::NotSealed));
        assert_eq!(names(d2.path()), vec![format!("{NODE}.key")]);

        let d3 = tempfile::tempdir().unwrap();
        assert_eq!(run_once(&s2, d3.path(), NODE).await, Outcome::Skipped(Skip::KeyMissing));

        let d4 = phone();
        std::fs::write(d4.path().join(MARKER), "1").unwrap();
        assert_eq!(run_once(&s2, d4.path(), NODE).await, Outcome::Skipped(Skip::AlreadyDone));
        assert_eq!(s2.rotate_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn 電腦版沒有金鑰庫_也不會換() {
        // 正式版的依賴在非安卓：is_android 為 false
        assert!(!cfg!(target_os = "android"), "這組測試在電腦上跑");
        let src = include_str!("lib.rs").replace("\r\n", "\n");
        // 啟動換鑰的那段只在安卓建置裡
        let at = src.find("node_rotate::run_live").expect("lib.rs 要接上換鑰");
        let before = &src[..at];
        let attr = before.rfind("#[cfg(").map(|i| &before[i..before.len().min(i + 40)]).unwrap_or("");
        assert!(attr.starts_with("#[cfg(target_os = \"android\")]"), "換鑰只在安卓：{attr}");
        assert!(src.contains("#[cfg(any(target_os = \"android\", test))]\n#[cfg_attr(not(target_os = \"android\"), allow(dead_code))]\nmod node_rotate;"));
    }

    #[tokio::test]
    async fn 中斷點一_新金鑰檔寫了之前_重啟就是重來() {
        let d = phone();
        let s = Sim::new();
        // 什麼都還沒寫就被殺：重啟＝全新開始
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        assert!(cur_is(&s, &key_file(d.path())));
    }

    #[tokio::test]
    async fn 中斷點二_新金鑰檔寫了_狀態檔還沒寫_重啟丟掉重來() {
        let d = phone();
        let s = Sim::new();
        let p = paths(d.path(), NODE);
        secret_file::write_sealed(&p.new_key, &node_key_aad(NODE), b"NEW-KEY-leftover_plaintext_value", &Fake).unwrap();
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        let k = key_file(d.path());
        assert!(!k.contains("leftover"), "沒有用到殘留的那把（後台沒被呼叫過）");
        assert!(cur_is(&s, &k));
        no_plaintext(d.path());
    }

    #[tokio::test]
    async fn 中斷點三_兩個檔都寫了_後台還沒被呼叫_重啟就續跑() {
        let d = phone();
        let s = Sim::new();
        let p = paths(d.path(), NODE);
        let st = start_fresh(&s, &p, NODE, &Fake, s.now_ms()).unwrap();
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        assert_eq!(s.rid.lock().unwrap().as_deref(), Some(st.rotation_id.as_str()), "沿用同一個換鑰編號");
        assert!(cur_is(&s, &key_file(d.path())));
        assert_eq!(s.rotations.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn 中斷點四_後台成功但回應沒收到_舊金鑰還在寬限內_重送冪等() {
        let d = phone();
        let s = Sim::new();
        s.lose_response.store(true, Ordering::SeqCst);
        let out = run_once(&s, d.path(), NODE).await;
        assert!(matches!(out, Outcome::Retry(_)));
        assert_eq!(s.rotations.load(Ordering::SeqCst), 1, "後台其實換了");
        assert_eq!(key_file(d.path()), OLD, "本機還沒換");
        assert!(d.path().join(format!("{NODE}.key.new")).exists());
        // 重啟（回應恢復正常）：舊金鑰在寬限內，同一個編號重送回成功
        s.lose_response.store(false, Ordering::SeqCst);
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        assert_eq!(s.rotations.load(Ordering::SeqCst), 1, "沒有再換第二次");
        assert!(cur_is(&s, &key_file(d.path())));
    }

    #[tokio::test]
    async fn 中斷點五_後台成功_寬限過了才重啟_舊金鑰被拒_改用新金鑰認證就收斂() {
        let d = phone();
        let s = Sim::new();
        s.lose_response.store(true, Ordering::SeqCst);
        let _ = run_once(&s, d.path(), NODE).await;
        s.lose_response.store(false, Ordering::SeqCst);
        s.expire_grace();
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        assert_eq!(s.probe_calls.load(Ordering::SeqCst), 1, "用新金鑰認證一次");
        let k = key_file(d.path());
        assert!(cur_is(&s, &k) && k.starts_with("NEW-KEY"));
        assert_eq!(s.adopted.lock().unwrap().len(), 1);
        assert_eq!(names(d.path()), vec![format!("{NODE}.key"), MARKER.to_string()]);
    }

    #[tokio::test]
    async fn 中斷點六_換名做完_狀態檔還在_重啟補寫記號_不會再換一次() {
        let d = phone();
        let s = Sim::new();
        let p = paths(d.path(), NODE);
        let st = start_fresh(&s, &p, NODE, &Fake, s.now_ms()).unwrap();
        // 後台換好了，本機也換了名，之後被殺（記號沒寫、狀態檔還在）
        assert_eq!(s.call_rotate(OLD, &st.rotation_id, &st.new_hash).await, CallOutcome::Ok);
        std::fs::rename(&p.new_key, &p.key).unwrap();
        let k = key_file(d.path());
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::Done);
        assert_eq!(names(d.path()), vec![format!("{NODE}.key"), MARKER.to_string()]);
        assert_eq!(key_file(d.path()), k, "金鑰檔沒動");
        assert_eq!(s.rotations.load(Ordering::SeqCst), 1);
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::Skipped(Skip::AlreadyDone));
    }

    #[tokio::test]
    async fn 中斷點七_記號寫了_狀態檔還沒刪_重啟什麼都不做() {
        let d = phone();
        let s = Sim::new();
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        std::fs::write(d.path().join(STATE_FILE), "{}").unwrap();   // 模擬還沒刪
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::Skipped(Skip::AlreadyDone));
        assert_eq!(s.rotations.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn 兩把金鑰後台都不認_走重新登入_檔案原地不動() {
        let d = phone();
        let s = Sim::new();
        let p = paths(d.path(), NODE);
        let st = start_fresh(&s, &p, NODE, &Fake, s.now_ms()).unwrap();
        // 後台換成了第三把（例如重新配對過）
        *s.cur.lock().unwrap() = key_hash("SOMETHING-ELSE");
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::NeedRelogin);
        assert!(p.new_key.exists() && p.state.exists() && !p.marker.exists());
        assert_eq!(key_file(d.path()), OLD);
        assert_eq!(st_file(d.path()).rotation_id, st.rotation_id);
    }

    #[tokio::test]
    async fn 失敗排程_一分鐘_五分鐘_三十分鐘_然後次數用完就停() {
        let d = phone();
        let s = Sim::new();
        s.net_down.store(true, Ordering::SeqCst);
        let t0 = s.now_ms();
        let out = run(&s, d.path(), NODE).await;
        assert_eq!(out, Outcome::Paused);
        assert_eq!(s.sleeps.lock().unwrap().as_slice(), [60_000, 300_000], "第三次失敗後不再排");
        assert_eq!(s.rotate_calls.load(Ordering::SeqCst), 3);
        assert_eq!(key_file(d.path()), OLD, "一直用舊金鑰");
        assert_eq!(s.now_ms() - t0, 360_000);
        assert_eq!(delay_after(1), 60_000);
        assert_eq!(delay_after(2), 300_000);
        assert_eq!(delay_after(3), 1_800_000);
        assert_eq!(delay_after(4), 6 * 3_600_000);
        assert_eq!(delay_after(9), 6 * 3_600_000);
        // 同一個視窗內重啟：不再打換鑰（只用新金鑰看一眼）
        let rc = s.rotate_calls.load(Ordering::SeqCst);
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Paused);
        assert_eq!(s.rotate_calls.load(Ordering::SeqCst), rc);
        // 24 小時後重啟：重新計次、網路好了就換成功
        s.net_down.store(false, Ordering::SeqCst);
        s.advance(WINDOW_MS);
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        assert!(cur_is(&s, &key_file(d.path())));
    }

    #[tokio::test]
    async fn 每次失敗先排好下次時間_第一次失敗等一分鐘() {
        let d = phone();
        let s = Sim::new();
        s.net_down.store(true, Ordering::SeqCst);
        let t0 = s.now_ms();
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::Retry(t0 + 60_000));
        let st = st_file(d.path());
        assert_eq!((st.attempts, st.next_at), (1, t0 + 60_000));
        s.advance(60_000);
        assert_eq!(run_once(&s, d.path(), NODE).await, Outcome::Retry(t0 + 60_000 + 300_000));
    }

    #[tokio::test]
    async fn 後台說太頻繁_停二十四小時_不再打() {
        let d = phone();
        let s = Sim::new();
        s.server_rate_limited.store(true, Ordering::SeqCst);
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Paused);
        assert_eq!(s.rotate_calls.load(Ordering::SeqCst), 1, "只打一次");
        let st = st_file(d.path());
        assert_eq!(st.attempts, MAX_ATTEMPTS);
        assert!(s.sleeps.lock().unwrap().is_empty(), "沒有排重試");
        // 重啟（還在視窗內）：不再換
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Paused);
        assert_eq!(s.rotate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(key_file(d.path()), OLD);
    }

    #[tokio::test]
    async fn 次數用完之後_後台其實已經換好_重啟用新金鑰看一眼就收斂() {
        let d = phone();
        let s = Sim::new();
        s.lose_response.store(true, Ordering::SeqCst);
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Paused);
        s.lose_response.store(false, Ordering::SeqCst);
        s.expire_grace();
        assert_eq!(run(&s, d.path(), NODE).await, Outcome::Done);
        assert!(cur_is(&s, &key_file(d.path())));
    }

    #[tokio::test]
    async fn 金鑰與雜湊都不寫進檔案明文_也不出現在狀態檔() {
        let d = phone();
        let s = Sim::new();
        s.net_down.store(true, Ordering::SeqCst);
        let _ = run_once(&s, d.path(), NODE).await;
        no_plaintext(d.path());
        let raw = std::fs::read_to_string(d.path().join(STATE_FILE)).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["attempts", "new_hash", "next_at", "rotation_id", "window_start"]);
        let nk = secret_file::read_node_key(&d.path().join(format!("{NODE}.key.new")), NODE, Some(&Fake)).unwrap();
        assert!(!raw.contains(&nk), "狀態檔沒有金鑰");
        let b = std::fs::read(d.path().join(format!("{NODE}.key.new"))).unwrap();
        assert!(b.starts_with(PREFIX), "新金鑰檔是加密的");
    }

    #[test]
    fn 原始碼的紀錄只有三句_不含金鑰與雜湊() {
        let src = include_str!("node_rotate.rs").replace("\r\n", "\n");
        let body = src.split("#[cfg(test)]").next().unwrap();
        let logs: Vec<&str> = body.lines().filter(|l| l.contains("elog!(")).collect();
        assert_eq!(logs.len(), 3, "{logs:?}");
        for l in &logs {
            assert!(l.contains("換節點金鑰："), "{l}");
            assert!(!l.contains('{') && !l.contains("key") && !l.contains("hash"), "{l}");
        }
        for bad in ["log::", "dbg", "trace!", "debug!", "info!", "warn!"] {
            assert!(!body.contains(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn 後台呼叫用的金鑰_換鑰用舊的_備援驗證用新的() {
        let d = phone();
        let s = Sim::new();
        s.lose_response.store(true, Ordering::SeqCst);
        let _ = run_once(&s, d.path(), NODE).await;
        s.lose_response.store(false, Ordering::SeqCst);
        s.expire_grace();
        let _ = run_once(&s, d.path(), NODE).await;
        let seen = s.keys_seen_in_calls.lock().unwrap().clone();
        assert_eq!(seen[0], OLD);
        assert_eq!(seen[1], OLD);
        assert!(seen[2].starts_with("NEW-KEY"));
    }

    #[test]
    fn 回應對照_幾種狀態碼() {
        assert_eq!(outcome_of(Ok((200, Value::Null))), CallOutcome::Ok);
        assert_eq!(outcome_of(Ok((401, Value::Null))), CallOutcome::Unauthorized);
        assert_eq!(outcome_of(Ok((429, Value::Null))), CallOutcome::RateLimited);
        assert_eq!(outcome_of(Ok((404, Value::Null))), CallOutcome::Failed);
        assert_eq!(outcome_of(Ok((500, Value::Null))), CallOutcome::Failed);
        assert_eq!(outcome_of(Err("連線失敗".into())), CallOutcome::Failed);
    }
}
