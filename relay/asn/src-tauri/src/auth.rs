//! 桌面登入（Supabase OAuth，PKCE）：系統瀏覽器登入 → 本機回送位址收授權碼 → 用驗證碼換權杖。
//!
//! 回呼用 `http://127.0.0.1:<埠>/callback`（埠從 49200～49219 挑第一個可用的）：開發與安裝版都能跑、不必改登錄檔、
//! 不被別的程式註冊同名網址協定搶走；伺服器只收一次有效回呼，5 分鐘沒有就關閉。
//! 權杖只在這個模組與 Rust 記憶體：存取憑證只放記憶體，更新憑證存 Windows 的 DPAPI 加密檔（其他系統是 0600 檔）；
//! 不進 log、不傳前端（前端只拿得到「有沒有登入、email」）。
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 回呼埠範圍：要在 Supabase 後台逐個加進 Redirect URLs 白名單（見 docs/AUTH.md）
pub const PORT_FIRST: u16 = 49200;
pub const PORT_LAST: u16 = 49219;
pub const CALLBACK_PATH: &str = "/callback";
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
pub const PROVIDERS: [&str; 2] = ["google", "github"];

// ---------- 亂數、PKCE、state ----------

fn b64u(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64u(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("系統亂數不可用");
    b64u(&buf)
}

/// PKCE 驗證碼：32 位元組亂數 → 43 字元（RFC 7636 要 43～128）
pub fn new_verifier() -> String {
    random_b64u(32)
}
/// S256：BASE64URL(SHA256(驗證碼))
pub fn challenge_of(verifier: &str) -> String {
    b64u(&Sha256::digest(verifier.as_bytes()))
}
/// OAuth state：16 位元組亂數 → 22 字元
pub fn new_state() -> String {
    random_b64u(16)
}
/// 每台電腦自己的亂數識別（同一帳號下用來認出「同一台」）：18 位元組 → 24 字元
pub fn new_device_id() -> String {
    random_b64u(18)
}

pub fn provider_ok(p: &str) -> bool {
    PROVIDERS.contains(&p)
}

/// 後台網址（含 /functions/v1/relay）→ Supabase 專案根網址；不是這個形狀就取到主機為止
pub fn auth_base_from(relay_url: &str) -> String {
    let u = relay_url.trim().trim_end_matches('/');
    match u.strip_suffix("/functions/v1/relay") {
        Some(b) => b.to_string(),
        None => {
            let (scheme, rest) = u.split_once("://").unwrap_or(("https", u));
            format!("{scheme}://{}", rest.split('/').next().unwrap_or(""))
        }
    }
}

pub fn redirect_to(port: u16, state: &str) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}?state={state}")
}

pub fn authorize_url(auth_base: &str, provider: &str, redirect: &str, challenge: &str) -> Result<String, String> {
    if !provider_ok(provider) {
        return Err("不支援這種登入方式".into());
    }
    Ok(format!(
        "{auth_base}/auth/v1/authorize?provider={provider}&redirect_to={}&code_challenge={challenge}&code_challenge_method=s256",
        crate::relay::encode_component(redirect)
    ))
}

// ---------- 回呼解析 ----------

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() && hex_val(b[i + 1]).is_some() && hex_val(b[i + 2]).is_some() => {
                out.push(hex_val(b[i + 1]).unwrap() * 16 + hex_val(b[i + 2]).unwrap());
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect()
}

/// 常數時間比較（state 不要用會提早離開的比較）
pub fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, PartialEq)]
pub enum CallbackKind {
    /// 授權碼（state 已驗過）
    Code(String),
    /// 供應商或後台回報登入失敗（state 已驗過）
    Failed(String),
    /// 不是我們的回呼（路徑不對、不是 GET、Host 不對、state 缺或不符、沒有 code 也沒有 error）：回 4xx，繼續等
    Rejected(u16),
}

/// 解析請求（請求行＋標頭文字）。只認 `GET /callback?...`，Host 要是 127.0.0.1:<埠> 或 localhost:<埠>（擋 DNS 重綁定），state 一定要一致。
pub fn classify_request(head: &str, expect_state: &str, port: u16) -> CallbackKind {
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" {
        return CallbackKind::Rejected(405);
    }
    let host_ok = lines
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
        .all(|(_, v)| {
            let v = v.trim();
            v == format!("127.0.0.1:{port}") || v == format!("localhost:{port}")
        });
    if !host_ok {
        return CallbackKind::Rejected(400);
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return CallbackKind::Rejected(404);
    }
    let q = parse_query(query);
    let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    match get("state") {
        Some(s) if same_secret(s, expect_state) => {}
        _ => return CallbackKind::Rejected(400),
    }
    if let Some(code) = get("code").filter(|c| !c.is_empty() && c.len() <= 2048) {
        return CallbackKind::Code(code.to_string());
    }
    if get("error").is_some() || get("error_description").is_some() {
        let why = get("error_description").or(get("error")).unwrap_or("").chars().take(200).collect::<String>();
        return CallbackKind::Failed(why);
    }
    CallbackKind::Rejected(400)
}

const PAGE_OK: &str = "<!doctype html><meta charset=\"utf-8\"><title>ASN</title><body style=\"font-family:sans-serif;text-align:center;margin-top:20vh\"><h2>登入完成</h2><p>可以回到 ASN 了，這個分頁可以關掉。</p>";
const PAGE_FAIL: &str = "<!doctype html><meta charset=\"utf-8\"><title>ASN</title><body style=\"font-family:sans-serif;text-align:center;margin-top:20vh\"><h2>登入沒有完成</h2><p>請回到 ASN 再試一次。</p>";
const PAGE_BAD: &str = "<!doctype html><meta charset=\"utf-8\"><title>ASN</title><body><p>無效的請求。</p>";

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Bad Request",
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// 在 49200～49219 挑第一個綁得起來的埠（只綁 127.0.0.1）
pub fn bind_loopback() -> Result<(TcpListener, u16), String> {
    for port in PORT_FIRST..=PORT_LAST {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok((l, port));
        }
    }
    Err(format!("本機的 {PORT_FIRST}～{PORT_LAST} 埠都被占用了，沒辦法接登入回呼"))
}

/// 等一次有效回呼。回授權碼；逾時、被取消、登入失敗都回錯誤字串。最多處理 30 條連線（防亂打），整個伺服器隨函式結束關閉。
pub fn wait_for_code(listener: TcpListener, port: u16, expect_state: &str, timeout: Duration, cancel: &AtomicBool) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let mut handled = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消登入".into());
        }
        if Instant::now() >= deadline {
            return Err("登入逾時，請再試一次".into());
        }
        match listener.accept() {
            Ok((mut s, _)) => {
                handled += 1;
                if handled > 30 {
                    return Err("登入回呼收到太多無關的請求，已停止".into());
                }
                let _ = s.set_nonblocking(false);
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 8192];
                let mut n = 0;
                while n < buf.len() {
                    match s.read(&mut buf[n..]) {
                        Ok(0) | Err(_) => break,
                        Ok(k) => {
                            n += k;
                            if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
                let head = String::from_utf8_lossy(&buf[..n]).into_owned();
                match classify_request(&head, expect_state, port) {
                    CallbackKind::Code(c) => {
                        respond(&mut s, 200, PAGE_OK);
                        return Ok(c);
                    }
                    CallbackKind::Failed(why) => {
                        respond(&mut s, 200, PAGE_FAIL);
                        return Err(format!("登入沒有完成：{why}"));
                    }
                    CallbackKind::Rejected(code) => respond(&mut s, code, PAGE_BAD),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("接登入回呼失敗：{e}")),
        }
    }
}

// ---------- 權杖 ----------

/// 一次登入的權杖。刻意不實作 Debug／Display／Serialize，免得不小心印出或傳給前端。
#[derive(Clone)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_ms: u64,
    pub email: Option<String>,
    /// 登入帳號的頭像網址（Supabase 使用者資料的 avatar_url／picture），只用來下載一次存成本機小圖
    pub avatar_url: Option<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Session {
    /// 還有至少 margin_ms 才過期
    pub fn fresh(&self, now: u64, margin_ms: u64) -> bool {
        self.expires_at_ms > now + margin_ms
    }
}

#[derive(Deserialize)]
struct TokenMeta {
    avatar_url: Option<String>,
    picture: Option<String>,
}
#[derive(Deserialize)]
struct TokenUser {
    email: Option<String>,
    user_metadata: Option<TokenMeta>,
}
#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_in: u64,
    user: Option<TokenUser>,
}
#[derive(Deserialize)]
struct TokenErr {
    #[serde(alias = "error_description", alias = "msg", alias = "message")]
    error_description: Option<String>,
}

/// 後台回的權杖 JSON → Session。缺欄位或空值都算失敗
pub fn session_from_json(text: &str, now: u64) -> Result<Session, String> {
    let r: TokenResp = serde_json::from_str(text).map_err(|_| "後台回應的格式不對".to_string())?;
    if r.access_token.is_empty() || r.refresh_token.is_empty() {
        return Err("後台沒有回登入憑證".into());
    }
    let secs = if r.expires_in == 0 { 3600 } else { r.expires_in };
    Ok(Session {
        access_token: r.access_token,
        refresh_token: r.refresh_token,
        expires_at_ms: now + secs * 1000,
        email: r.user.as_ref().and_then(|u| u.email.clone()).filter(|e| !e.is_empty()),
        avatar_url: r.user.and_then(|u| u.user_metadata).and_then(|m| m.avatar_url.or(m.picture)).filter(|e| !e.is_empty()),
    })
}

#[derive(Debug)]
pub enum AuthFail {
    /// 登入憑證被後台拒絕（過期、撤銷、授權碼不對）：需要重新登入
    Rejected(String),
    /// 網路或後台暫時有問題：不必清掉已存的登入
    Transient(String),
}

async fn token_request(client: &reqwest::Client, auth_base: &str, anon: &str, grant: &str, body: serde_json::Value) -> Result<Session, AuthFail> {
    let r = client
        .post(format!("{auth_base}/auth/v1/token?grant_type={grant}"))
        .header("apikey", anon)
        .timeout(Duration::from_secs(20))
        .json(&body)
        .send()
        .await
        .map_err(|_| AuthFail::Transient("連不上登入服務".into()))?;
    let status = r.status();
    let text = r.text().await.map_err(|_| AuthFail::Transient("讀不到登入服務的回應".into()))?;
    if status.is_success() {
        return session_from_json(&text, now_ms()).map_err(AuthFail::Transient);
    }
    let why = serde_json::from_str::<TokenErr>(&text).ok().and_then(|e| e.error_description).unwrap_or_default();
    let why: String = why.chars().take(120).collect();
    if status.is_client_error() {
        Err(AuthFail::Rejected(if why.is_empty() { format!("登入服務拒絕（{}）", status.as_u16()) } else { why }))
    } else {
        Err(AuthFail::Transient(format!("登入服務暫時有問題（{}）", status.as_u16())))
    }
}

pub async fn exchange_code(client: &reqwest::Client, auth_base: &str, anon: &str, code: &str, verifier: &str) -> Result<Session, AuthFail> {
    token_request(client, auth_base, anon, "pkce", serde_json::json!({ "auth_code": code, "code_verifier": verifier })).await
}

pub async fn refresh(client: &reqwest::Client, auth_base: &str, anon: &str, refresh_token: &str) -> Result<Session, AuthFail> {
    token_request(client, auth_base, anon, "refresh_token", serde_json::json!({ "refresh_token": refresh_token })).await
}

// ---------- 儲存層 ----------

/// 存在磁碟上的登入：只有更新憑證與 email（存取憑證不落地）
#[derive(Clone, PartialEq)]
pub struct StoredLogin {
    pub refresh_token: String,
    pub email: Option<String>,
}

pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredLogin>, String>;
    fn save(&self, login: &StoredLogin) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

fn encode_login(l: &StoredLogin) -> Vec<u8> {
    serde_json::json!({ "refresh_token": l.refresh_token, "email": l.email }).to_string().into_bytes()
}
fn decode_login(b: &[u8]) -> Option<StoredLogin> {
    let v: serde_json::Value = serde_json::from_slice(b).ok()?;
    let rt = v.get("refresh_token")?.as_str()?.to_string();
    if rt.is_empty() {
        return None;
    }
    Some(StoredLogin { refresh_token: rt, email: v.get("email").and_then(|e| e.as_str()).map(String::from) })
}

/// 把明文包成只有本人讀得出的位元組（Windows＝DPAPI；其他系統沒有系統層加密，靠 0600 檔案權限）
pub trait Protector: Send + Sync {
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, sealed: &[u8]) -> Result<Vec<u8>, String>;
}

#[cfg(windows)]
pub struct Dpapi;
#[cfg(windows)]
const DPAPI_ENTROPY: &[u8] = b"asn-login-v1";

#[cfg(windows)]
impl Protector for Dpapi {
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let ent = CRYPT_INTEGER_BLOB { cbData: DPAPI_ENTROPY.len() as u32, pbData: DPAPI_ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // CRYPTPROTECT_UI_FORBIDDEN = 1
        let ok = unsafe { CryptProtectData(&input, std::ptr::null(), &ent, std::ptr::null(), std::ptr::null(), 1, &mut out) };
        if ok == 0 || out.pbData.is_null() {
            return Err("Windows 加密失敗".into());
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Ok(v)
    }
    fn unprotect(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB { cbData: sealed.len() as u32, pbData: sealed.as_ptr() as *mut u8 };
        let ent = CRYPT_INTEGER_BLOB { cbData: DPAPI_ENTROPY.len() as u32, pbData: DPAPI_ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), &ent, std::ptr::null(), std::ptr::null(), 1, &mut out) };
        if ok == 0 || out.pbData.is_null() {
            return Err("Windows 解密失敗（可能不是這個使用者存的）".into());
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Ok(v)
    }
}

/// 非 Windows：不加密（沒有統一的系統金鑰庫可用），只靠檔案權限 0600
#[cfg_attr(windows, allow(dead_code))]
pub struct PlainFile;
impl Protector for PlainFile {
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    fn unprotect(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        Ok(sealed.to_vec())
    }
}

/// 資料夾裡的 login.bin；內容經 Protector 包過
pub struct FileStore<P: Protector> {
    pub path: PathBuf,
    pub prot: P,
}

impl<P: Protector> TokenStore for FileStore<P> {
    fn load(&self) -> Result<Option<StoredLogin>, String> {
        let sealed = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("讀不到登入存檔：{e}")),
        };
        // 解不開或格式壞掉＝當作沒登入（不丟內容）
        Ok(self.prot.unprotect(&sealed).ok().and_then(|p| decode_login(&p)))
    }
    fn save(&self, login: &StoredLogin) -> Result<(), String> {
        let sealed = self.prot.protect(&encode_login(login))?;
        if let Some(p) = self.path.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let tmp = PathBuf::from(format!("{}.{}.tmp", self.path.display(), std::process::id()));
        std::fs::write(&tmp, &sealed).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
    fn clear(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("刪不掉登入存檔：{e}")),
        }
    }
}

pub fn default_store(data_dir: &Path) -> Box<dyn TokenStore> {
    let path = data_dir.join("login.bin");
    #[cfg(windows)]
    {
        Box::new(FileStore { path, prot: Dpapi })
    }
    #[cfg(not(windows))]
    {
        Box::new(FileStore { path, prot: PlainFile })
    }
}

// ---------- 登入狀態 ----------

pub struct AuthState {
    pub store: Box<dyn TokenStore>,
    mem: Mutex<Option<Session>>,
    pub cancel: Arc<AtomicBool>,
    busy: AtomicBool,
}

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct AuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
}

/// 登入進行中旗標：離開作用域一定放掉
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl AuthState {
    pub fn new(store: Box<dyn TokenStore>) -> Self {
        Self { store, mem: Mutex::new(None), cancel: Arc::new(AtomicBool::new(false)), busy: AtomicBool::new(false) }
    }

    /// 只給 `--shot` 測試用：假裝已登入（記憶體裡放一組假權杖，不寫存檔），讓端到端測試能走「已登入」的情境。
    /// 呼叫端必須確認在 `--shot` 模式（只連本機假後端）。
    pub fn seed_shot_session(&self, email: &str) {
        let s = Session { access_token: "shot-access".into(), refresh_token: "shot-refresh".into(), expires_at_ms: now_ms() + 24 * 3600 * 1000, email: Some(email.to_string()), avatar_url: None };
        if let Ok(mut g) = self.mem.lock() {
            *g = Some(s);
        }
    }

    /// 目前這次登入帶的帳號頭像網址（不是權杖；給登入後下載頭像用）
    pub fn session_avatar_url(&self) -> Option<String> {
        self.mem.lock().ok().and_then(|g| g.as_ref().and_then(|s| s.avatar_url.clone()))
    }

    pub fn status(&self) -> AuthStatus {
        if let Some(s) = self.mem.lock().ok().and_then(|g| g.clone()) {
            return AuthStatus { signed_in: true, email: s.email };
        }
        match self.store.load() {
            Ok(Some(l)) => AuthStatus { signed_in: true, email: l.email },
            _ => AuthStatus { signed_in: false, email: None },
        }
    }

    fn set_session(&self, s: Session) -> Result<(), String> {
        self.store.save(&StoredLogin { refresh_token: s.refresh_token.clone(), email: s.email.clone() })?;
        if let Ok(mut g) = self.mem.lock() {
            *g = Some(s);
        }
        Ok(())
    }

    /// 登出：清記憶體與存檔（只清登入，不碰節點金鑰）
    pub fn sign_out(&self) -> Result<(), String> {
        if let Ok(mut g) = self.mem.lock() {
            *g = None;
        }
        self.store.clear()
    }

    /// 取一把可用的存取憑證；快過期就用更新憑證換（後台會輪替更新憑證，換到的新值馬上存回去）
    pub async fn access_token(&self, client: &reqwest::Client, auth_base: &str, anon: &str) -> Result<String, String> {
        if let Some(s) = self.mem.lock().ok().and_then(|g| g.clone()) {
            if s.fresh(now_ms(), 60_000) {
                return Ok(s.access_token);
            }
        }
        let stored = self.store.load()?.ok_or("還沒有登入")?;
        match refresh(client, auth_base, anon, &stored.refresh_token).await {
            Ok(mut s) => {
                if s.email.is_none() {
                    s.email = stored.email.clone();
                }
                let t = s.access_token.clone();
                self.set_session(s)?;
                Ok(t)
            }
            Err(AuthFail::Rejected(_)) => {
                let _ = self.sign_out();
                Err("登入已過期，請重新登入".into())
            }
            Err(AuthFail::Transient(m)) => Err(m),
        }
    }

    /// 完整登入流程。open＝開系統瀏覽器（失敗就連同網址一起回報，讓人自己貼）。
    pub async fn login(&self, client: &reqwest::Client, auth_base: &str, anon: &str, provider: &str, open: impl Fn(&str) -> Result<(), String>) -> Result<AuthStatus, String> {
        if !provider_ok(provider) {
            return Err("不支援這種登入方式".into());
        }
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err("已經在等登入了，請先完成或取消".into());
        }
        let _guard = BusyGuard(&self.busy);
        self.cancel.store(false, Ordering::SeqCst);
        let verifier = new_verifier();
        let state = new_state();
        let (listener, port) = bind_loopback()?;
        let url = authorize_url(auth_base, provider, &redirect_to(port, &state), &challenge_of(&verifier))?;
        if open(&url).is_err() {
            return Err(format!("沒辦法自動開啟瀏覽器，請自己開這個網址登入：{url}"));
        }
        let st = state.clone();
        let cancel = self.cancel.clone();
        // 伺服器在背景執行緒等（會阻塞）
        let code = tokio::task::spawn_blocking(move || wait_for_code(listener, port, &st, LOGIN_TIMEOUT, &cancel))
        .await
        .map_err(|e| format!("背景工作失敗：{e}"))??;
        match exchange_code(client, auth_base, anon, &code, &verifier).await {
            Ok(s) => {
                self.set_session(s)?;
                Ok(self.status())
            }
            Err(AuthFail::Rejected(m)) | Err(AuthFail::Transient(m)) => Err(m),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;
    use std::sync::Arc;

    // ----- PKCE、state -----
    #[test]
    fn pkce_挑戰碼符合_rfc7636_範例() {
        // RFC 7636 附錄 B 的範例
        assert_eq!(challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn 驗證碼與_state_長度夠且每次不同() {
        let (v1, v2) = (new_verifier(), new_verifier());
        assert!(v1.len() >= 43 && v1.len() <= 128 && v1 != v2);
        assert!(v1.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        let (s1, s2) = (new_state(), new_state());
        assert!(s1.len() >= 22 && s1 != s2);
        assert!(new_device_id().len() >= 16);
    }

    #[test]
    fn 登入網址帶_pkce_參數且回呼網址被編碼() {
        let u = authorize_url("https://x.supabase.co", "google", &redirect_to(49201, "ST"), "CH").unwrap();
        assert!(u.starts_with("https://x.supabase.co/auth/v1/authorize?provider=google&redirect_to="));
        assert!(u.contains("redirect_to=http%3A%2F%2F127.0.0.1%3A49201%2Fcallback%3Fstate%3DST"));
        assert!(u.ends_with("&code_challenge=CH&code_challenge_method=s256"));
        assert!(authorize_url("https://x.supabase.co", "facebook", "r", "c").is_err());
        assert!(authorize_url("https://x.supabase.co", "google&evil=1", "r", "c").is_err());
    }

    #[test]
    fn 後台網址換成專案根網址() {
        assert_eq!(auth_base_from("https://abc.supabase.co/functions/v1/relay"), "https://abc.supabase.co");
        assert_eq!(auth_base_from("https://abc.supabase.co/functions/v1/relay/"), "https://abc.supabase.co");
        assert_eq!(auth_base_from("http://127.0.0.1:5555/relay"), "http://127.0.0.1:5555");
    }

    // ----- 回呼解析 -----
    fn req(target: &str, host: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: x\r\n\r\n")
    }

    #[test]
    fn 回呼_state_一致才收授權碼() {
        let ok = classify_request(&req("/callback?state=ST&code=abc%20d", "127.0.0.1:49200"), "ST", 49200);
        assert_eq!(ok, CallbackKind::Code("abc d".into()));
        // state 不符、缺 state、少一個字都不收
        for t in ["/callback?state=XX&code=c", "/callback?code=c", "/callback?state=S&code=c", "/callback?state=&code=c"] {
            assert_eq!(classify_request(&req(t, "127.0.0.1:49200"), "ST", 49200), CallbackKind::Rejected(400), "{t}");
        }
    }

    #[test]
    fn 回呼_路徑方法與主機要對() {
        assert_eq!(classify_request(&req("/favicon.ico", "127.0.0.1:49200"), "ST", 49200), CallbackKind::Rejected(404));
        assert_eq!(classify_request(&req("/callback/../x?state=ST&code=c", "127.0.0.1:49200"), "ST", 49200), CallbackKind::Rejected(404));
        assert_eq!(classify_request("POST /callback?state=ST&code=c HTTP/1.1\r\nHost: 127.0.0.1:49200\r\n\r\n", "ST", 49200), CallbackKind::Rejected(405));
        assert_eq!(classify_request(&req("/callback?state=ST&code=c", "evil.example:49200"), "ST", 49200), CallbackKind::Rejected(400));
        assert_eq!(classify_request(&req("/callback?state=ST&code=c", "127.0.0.1:1"), "ST", 49200), CallbackKind::Rejected(400));
        assert_eq!(classify_request(&req("/callback?state=ST&code=c", "localhost:49200"), "ST", 49200), CallbackKind::Code("c".into()));
    }

    #[test]
    fn 回呼_登入失敗要先驗_state() {
        let f = classify_request(&req("/callback?state=ST&error=access_denied&error_description=User+denied", "127.0.0.1:49200"), "ST", 49200);
        assert_eq!(f, CallbackKind::Failed("User denied".into()));
        // 別人亂塞的 error（沒有正確 state）不能中斷登入
        assert_eq!(classify_request(&req("/callback?error=x", "127.0.0.1:49200"), "ST", 49200), CallbackKind::Rejected(400));
        // 有 state 但什麼都沒有
        assert_eq!(classify_request(&req("/callback?state=ST", "127.0.0.1:49200"), "ST", 49200), CallbackKind::Rejected(400));
    }

    #[test]
    fn 百分比解碼() {
        assert_eq!(percent_decode("a%2Fb%3D%E4%B8%AD+x"), "a/b=中 x");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }

    // ----- 本機伺服器：真的連 127.0.0.1 -----
    // 這幾個測試都從 49200 起搶埠；平行跑時，別的測試會在這裡剛放掉的埠上重新監聽（Linux 上立刻就搶得到），
    // 害「收完就關閉」的檢查連到別人的伺服器。所以同一時間只讓一個測試占用回送埠。
    static LOOPBACK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn loopback_guard() -> std::sync::MutexGuard<'static, ()> {
        LOOPBACK_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn get(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn 伺服器只收一次有效回呼_雜訊不會中斷_收完就關閉() {
        let _g = loopback_guard();
        let (l, port) = bind_loopback().unwrap();
        assert!((PORT_FIRST..=PORT_LAST).contains(&port));
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        let h = std::thread::spawn(move || wait_for_code(l, port, "STATE1", Duration::from_secs(10), &c2));
        assert!(get(port, "/favicon.ico").starts_with("HTTP/1.1 404"));
        assert!(get(port, "/callback?state=WRONG&code=evil").starts_with("HTTP/1.1 400"));
        let ok = get(port, "/callback?state=STATE1&code=thecode");
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("登入完成") && ok.contains("Content-Security-Policy"));
        assert!(!ok.contains("thecode"), "回應頁不回顯授權碼");
        assert_eq!(h.join().unwrap().unwrap(), "thecode");
        // 已經收完：伺服器關了，不能再連（或連了也沒人收）
        std::thread::sleep(Duration::from_millis(100));
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn 伺服器逾時與取消() {
        let _g = loopback_guard();
        let (l, port) = bind_loopback().unwrap();
        let cancel = AtomicBool::new(false);
        let e = wait_for_code(l, port, "S", Duration::from_millis(200), &cancel).unwrap_err();
        assert!(e.contains("逾時"));
        let (l, port) = bind_loopback().unwrap();
        cancel.store(true, Ordering::Relaxed);
        assert!(wait_for_code(l, port, "S", Duration::from_secs(5), &cancel).unwrap_err().contains("取消"));
    }

    #[test]
    fn 伺服器收到登入失敗回呼就回報原因() {
        let _g = loopback_guard();
        let (l, port) = bind_loopback().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        let h = std::thread::spawn(move || wait_for_code(l, port, "S", Duration::from_secs(10), &c2));
        let page = get(port, "/callback?state=S&error=access_denied&error_description=nope");
        assert!(page.contains("登入沒有完成"));
        assert!(h.join().unwrap().unwrap_err().contains("nope"));
    }

    // ----- 權杖 JSON -----
    #[test]
    fn 權杖_json_解析() {
        let s = session_from_json(r#"{"access_token":"A","refresh_token":"R","expires_in":3600,"user":{"id":"u","email":"a@b.c"}}"#, 1000).unwrap();
        assert_eq!((s.access_token.as_str(), s.refresh_token.as_str(), s.expires_at_ms), ("A", "R", 1000 + 3_600_000));
        assert_eq!(s.email.as_deref(), Some("a@b.c"));
        assert!(s.fresh(1000, 60_000) && !s.fresh(1000 + 3_600_000 - 59_000, 60_000));
        assert!(session_from_json(r#"{"access_token":"","refresh_token":"R"}"#, 0).is_err());
        assert!(session_from_json("not json", 0).is_err());
    }

    // ----- 儲存層（假的記憶體儲存） -----
    #[derive(Default)]
    struct MemStore(Mutex<Option<StoredLogin>>);
    impl TokenStore for MemStore {
        fn load(&self) -> Result<Option<StoredLogin>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, l: &StoredLogin) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(l.clone());
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    fn sess(rt: &str, exp: u64) -> Session {
        Session { access_token: "AT".into(), refresh_token: rt.into(), expires_at_ms: exp, email: Some("me@x.y".into()), avatar_url: None }
    }

    #[test]
    fn 狀態_登入後有_email_登出清乾淨且只存更新憑證() {
        let a = AuthState::new(Box::new(MemStore::default()));
        assert_eq!(a.status(), AuthStatus { signed_in: false, email: None });
        a.set_session(sess("RT1", now_ms() + 3_600_000)).unwrap();
        assert_eq!(a.status(), AuthStatus { signed_in: true, email: Some("me@x.y".into()) });
        let stored = a.store.load().unwrap().unwrap();
        assert_eq!(stored.refresh_token, "RT1");
        a.sign_out().unwrap();
        assert_eq!(a.status(), AuthStatus { signed_in: false, email: None });
        assert!(a.store.load().unwrap().is_none());
    }

    #[test]
    fn 狀態_重開程式後從存檔得知已登入() {
        let store = MemStore::default();
        store.save(&StoredLogin { refresh_token: "RT".into(), email: Some("a@b.c".into()) }).unwrap();
        let a = AuthState::new(Box::new(store));
        assert_eq!(a.status(), AuthStatus { signed_in: true, email: Some("a@b.c".into()) });
    }

    #[tokio::test]
    async fn 存取憑證還新就直接用_不連網() {
        let a = AuthState::new(Box::new(MemStore::default()));
        a.set_session(sess("RT", now_ms() + 3_600_000)).unwrap();
        // 位址不通：若真的去換會失敗
        let t = a.access_token(&reqwest::Client::new(), "http://127.0.0.1:9", "anon").await.unwrap();
        assert_eq!(t, "AT");
    }

    #[tokio::test]
    async fn 沒登入要憑證會失敗() {
        let a = AuthState::new(Box::new(MemStore::default()));
        assert!(a.access_token(&reqwest::Client::new(), "http://127.0.0.1:9", "anon").await.is_err());
    }

    /// 假的登入服務：回固定的 HTTP 回應（只連 127.0.0.1），並把請求內容記下來
    fn fake_auth_server(status: &str, body: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let status = status.to_string();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = vec![0u8; 8192];
            let mut n = 0;
            let mut want = usize::MAX;
            while n < buf.len() {
                let k = s.read(&mut buf[n..]).unwrap();
                if k == 0 {
                    break;
                }
                n += k;
                let t = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Some(i) = t.find("\r\n\r\n") {
                    if want == usize::MAX {
                        let len = t.to_ascii_lowercase().split("content-length:").nth(1).and_then(|r| r.trim().split("\r\n").next().and_then(|x| x.trim().parse::<usize>().ok())).unwrap_or(0);
                        want = i + 4 + len;
                    }
                    if n >= want {
                        break;
                    }
                }
            }
            write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (port, h)
    }

    #[tokio::test]
    async fn 換取權杖_送驗證碼與授權碼_成功() {
        let (port, h) = fake_auth_server("200 OK", r#"{"access_token":"NEWAT","refresh_token":"NEWRT","expires_in":3600,"user":{"email":"z@z.z"}}"#);
        let s = exchange_code(&reqwest::Client::new(), &format!("http://127.0.0.1:{port}"), "ANON", "CODE1", "VERIF1").await.unwrap();
        assert_eq!((s.access_token.as_str(), s.refresh_token.as_str()), ("NEWAT", "NEWRT"));
        let seen = h.join().unwrap();
        assert!(seen.starts_with("POST /auth/v1/token?grant_type=pkce"));
        assert!(seen.to_ascii_lowercase().contains("apikey: anon"));
        assert!(seen.contains("\"auth_code\":\"CODE1\"") && seen.contains("\"code_verifier\":\"VERIF1\""));
    }

    #[tokio::test]
    async fn 換取權杖_後台拒絕與暫時錯誤要分開() {
        let (p1, h1) = fake_auth_server("400 Bad Request", r#"{"error_description":"invalid flow state"}"#);
        match exchange_code(&reqwest::Client::new(), &format!("http://127.0.0.1:{p1}"), "A", "c", "v").await {
            Err(AuthFail::Rejected(m)) => assert!(m.contains("invalid flow state")),
            _ => panic!("應該是被拒絕"),
        }
        let _ = h1.join();
        let (p2, h2) = fake_auth_server("503 Service Unavailable", "{}");
        assert!(matches!(exchange_code(&reqwest::Client::new(), &format!("http://127.0.0.1:{p2}"), "A", "c", "v").await, Err(AuthFail::Transient(_))));
        let _ = h2.join();
    }

    #[tokio::test]
    async fn 存取憑證過期就用更新憑證換_換到的新更新憑證存回去() {
        let store = MemStore::default();
        store.save(&StoredLogin { refresh_token: "OLDRT".into(), email: Some("keep@x.y".into()) }).unwrap();
        let a = AuthState::new(Box::new(store));
        let (port, h) = fake_auth_server("200 OK", r#"{"access_token":"AT2","refresh_token":"RT2","expires_in":3600}"#);
        let t = a.access_token(&reqwest::Client::new(), &format!("http://127.0.0.1:{port}"), "ANON").await.unwrap();
        assert_eq!(t, "AT2");
        assert!(h.join().unwrap().contains("\"refresh_token\":\"OLDRT\""));
        let s = a.store.load().unwrap().unwrap();
        assert_eq!((s.refresh_token.as_str(), s.email.as_deref()), ("RT2", Some("keep@x.y")), "輪替後的更新憑證存回去、email 保留");
    }

    #[tokio::test]
    async fn 更新憑證被拒絕就登出_暫時錯誤則保留() {
        let store = MemStore::default();
        store.save(&StoredLogin { refresh_token: "RT".into(), email: None }).unwrap();
        let a = AuthState::new(Box::new(store));
        let (p, h) = fake_auth_server("503 Service Unavailable", "{}");
        assert!(a.access_token(&reqwest::Client::new(), &format!("http://127.0.0.1:{p}"), "A").await.is_err());
        let _ = h.join();
        assert!(a.status().signed_in, "暫時錯誤不登出");
        let (p, h) = fake_auth_server("400 Bad Request", r#"{"error_description":"Invalid Refresh Token"}"#);
        let e = a.access_token(&reqwest::Client::new(), &format!("http://127.0.0.1:{p}"), "A").await.unwrap_err();
        let _ = h.join();
        assert!(e.contains("重新登入"));
        assert!(!a.status().signed_in, "被拒絕就清掉");
    }

    // ----- 檔案儲存 -----
    #[test]
    fn 檔案儲存_存讀清_檔案裡看不到明文() {
        let d = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let st = FileStore { path: d.path().join("login.bin"), prot: Dpapi };
        #[cfg(not(windows))]
        let st = FileStore { path: d.path().join("login.bin"), prot: PlainFile };
        assert!(st.load().unwrap().is_none());
        let l = StoredLogin { refresh_token: "SECRET-REFRESH-TOKEN-123".into(), email: Some("a@b.c".into()) };
        st.save(&l).unwrap();
        assert!(st.load().unwrap().unwrap() == l);
        #[cfg(windows)]
        {
            let raw = std::fs::read(d.path().join("login.bin")).unwrap();
            assert!(!String::from_utf8_lossy(&raw).contains("SECRET-REFRESH-TOKEN-123"), "Windows 上存檔是 DPAPI 加密的");
        }
        st.clear().unwrap();
        st.clear().unwrap();
        assert!(st.load().unwrap().is_none());
    }

    #[test]
    fn 檔案儲存_壞檔當作沒登入() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("login.bin"), b"garbage").unwrap();
        #[cfg(windows)]
        let st = FileStore { path: d.path().join("login.bin"), prot: Dpapi };
        #[cfg(not(windows))]
        let st = FileStore { path: d.path().join("login.bin"), prot: PlainFile };
        assert!(st.load().unwrap().is_none());
    }

    #[test]
    fn 後台回應帶帳號頭像網址_avatar_url_優先_沒有就用_picture() {
        let a = session_from_json(r#"{"access_token":"A","refresh_token":"R","user":{"email":"a@b.c","user_metadata":{"avatar_url":"https://x/a.png","picture":"https://x/p.png"}}}"#, 1).unwrap();
        assert_eq!(a.avatar_url.as_deref(), Some("https://x/a.png"));
        let b = session_from_json(r#"{"access_token":"A","refresh_token":"R","user":{"user_metadata":{"picture":"https://x/p.png"}}}"#, 1).unwrap();
        assert_eq!(b.avatar_url.as_deref(), Some("https://x/p.png"));
        let c = session_from_json(r#"{"access_token":"A","refresh_token":"R","user":{"email":"a@b.c"}}"#, 1).unwrap();
        assert_eq!(c.avatar_url, None);
    }

    #[test]
    fn 權杖類型不能被印出或序列化() {
        // 守門：Session、StoredLogin 不准 derive Debug／Serialize（會讓權杖不小心進 log 或傳給前端）
        let src = include_str!("auth.rs");
        for name in ["pub struct Session", "pub struct StoredLogin"] {
            let at = src.find(name).unwrap();
            let before = &src[at.saturating_sub(300)..at];
            let derive = before.lines().rev().find(|l| l.trim_start().starts_with("#[derive")).unwrap_or("");
            assert!(!derive.contains("Debug") && !derive.contains("Serialize"), "{name} 不能 derive Debug／Serialize：{derive}");
        }
    }
}
