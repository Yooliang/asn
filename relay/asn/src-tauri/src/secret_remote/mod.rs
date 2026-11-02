//! 遠端一次性密碼傳遞（#26 第二期）。設計與威脅模型見 docs/design/SECRET-REMOTE.md。
//!
//! 別台電腦（或雲端代理）上的程式要密碼時：請求端產生一次性 X25519 鑰匙對 → 只把公鑰與說明送上收發室
//! → 本人的設備（電腦 ASN、手機）跳窗確認 → 輸入的密碼在**本人設備本機**用該公鑰加密 → 密文經後台送回
//! → 請求端取回、解密、直接交給要密碼的程式 → 銷毀私鑰。後台與ASN 的伺服器只轉密文。
//!
//! 密碼與密文永遠不進：log、往來記錄、檔案、指令列參數、環境變數、剪貼簿、信件。
//! 本資料夾除了 `tests.rs` 以外的程式碼受守門測試掃描（見 tests.rs「守門」）。
pub mod confirm;
#[cfg(all(desktop, feature = "gui"))]
pub mod desktop;
pub mod crypto;
pub mod link;
pub mod requester;
pub mod wire;

#[cfg(test)]
mod tests;

pub use wire::Backend;
