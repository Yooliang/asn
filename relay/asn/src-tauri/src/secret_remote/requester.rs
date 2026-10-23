//! 請求端：產生一次性鑰匙對 → 送請求（只有公鑰與說明）→ 等本人在自己的設備確認 → 取回密文 → 解密。
//! 回傳的密碼位元組由呼叫者直接交給要密碼的程式（`asn-cli secret request` 印到標準輸出，與第一期小幫手同一種方式）。
//!
//! 私鑰只存在這個函式的區域變數 `key`：它沒有 Clone、不能序列化，`open` 以值接收（解密當下即消耗）。
//! 請求中途失敗、逾時、被拒絕、這個 future 被丟棄時，`key` 隨著離開作用域一起銷毀。
use super::crypto::{fingerprint, CryptoError, RequestKey};
use super::wire::{self, Backend, Fetched};
use std::time::Duration;
use tokio::time::Instant;
use zeroize::Zeroizing;

pub struct Opts {
    /// 請求端自報：哪個程式要密碼
    pub program: String,
    /// 請求端自報：要做什麼
    pub purpose: String,
    pub ttl_secs: u64,
    /// 輪詢間隔
    pub poll: Duration,
}

impl Opts {
    pub fn new(program: &str, purpose: &str) -> Opts {
        Opts { program: program.into(), purpose: purpose.into(), ttl_secs: wire::TTL_DEFAULT, poll: Duration::from_secs(2) }
    }
}

/// 失敗原因。訊息都是固定文字或後台的錯誤代碼，不含任何密文或密碼
#[derive(Debug, PartialEq)]
pub enum Failure {
    /// 本人按了取消
    Denied,
    /// 沒有人在期限內確認
    Expired,
    /// 後台或網路的問題
    Backend(String),
    /// 取回的密文解不開（金鑰不對、被竄改、編號對不上）：**不交付任何東西**
    DecryptFailed,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Denied => f.write_str("你的設備上有人按了取消，沒有取得密碼"),
            Failure::Expired => f.write_str("等不到確認，請求已過期"),
            Failure::Backend(e) => write!(f, "{e}"),
            Failure::DecryptFailed => f.write_str("收到的內容解不開，已丟棄，沒有交付任何東西"),
        }
    }
}

/// 送出請求後、等待前通知呼叫者一次（讓它在標準錯誤印「請去你的設備確認，指紋是…」）。只給請求編號與指紋，不給公鑰以外的東西
pub struct StartInfo<'a> {
    pub id: &'a str,
    pub fingerprint: &'a str,
    pub seconds_left: u64,
}

pub async fn request_secret(be: &dyn Backend, opts: &Opts, on_start: &mut dyn FnMut(&StartInfo)) -> Result<Zeroizing<Vec<u8>>, Failure> {
    let key = RequestKey::generate().map_err(|e| Failure::Backend(e.to_string()))?;
    let pub_b64 = key.public_b64();
    let body = wire::build_request_body(&pub_b64, &opts.program, &opts.purpose, opts.ttl_secs).map_err(Failure::Backend)?;
    let started = wire::parse_started(&be.request(body).await.map_err(Failure::Backend)?).map_err(Failure::Backend)?;
    on_start(&StartInfo { id: &started.id, fingerprint: &fingerprint(&pub_b64), seconds_left: started.seconds_left });
    // 本地也自己算一次期限（後台說過期就會回 expired；這裡多給 10 秒的網路寬限，免得後台不回應時永遠等下去）
    let deadline = Instant::now() + Duration::from_secs(started.seconds_left + 10);
    let fetch_body = wire::build_fetch_body(&started.id).map_err(Failure::Backend)?;
    loop {
        match wire::parse_fetched(&be.fetch(fetch_body.clone()).await.map_err(Failure::Backend)?).map_err(Failure::Backend)? {
            Fetched::Pending => {
                if Instant::now() >= deadline {
                    return Err(Failure::Expired);
                }
                tokio::time::sleep(opts.poll).await;
            }
            Fetched::Denied => return Err(Failure::Denied),
            Fetched::Expired => return Err(Failure::Expired),
            Fetched::Delivered => return Err(Failure::Backend("這筆請求的密文已被取走過".into())),
            Fetched::Answered(cipher) => {
                // key 在這裡被消耗：解密不論成敗，私鑰都沒了
                return key.open(&started.id, &cipher).map_err(|e: CryptoError| {
                    let _ = e;
                    Failure::DecryptFailed
                });
            }
        }
    }
}
