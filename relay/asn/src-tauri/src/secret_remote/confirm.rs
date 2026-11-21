//! 確認端（本人的設備：電腦 ASN、手機）：查待確認請求 → 跳窗讓本人看清楚「哪台電腦、哪個程式、要做什麼」→ 本人輸入 →
//! **在本機**用請求公鑰加密 → 把密文送回後台。明文只存在確認窗、這裡的 `Zeroizing` 緩衝與加密函式裡；後台只收到密文。
//!
//! 一定要本人簽章：沒有登入憑證時 [`Backend`] 在送出之前就回錯，一個請求都不會打到後台。
use super::crypto::{fingerprint, seal, MAX_SECRET};
use super::wire::{self, Backend, PendingReq};
// 確認窗型別只在電腦版有（askpass 是電腦版模組）；手機的確認畫面走 list_for_ui／answer_from_ui
#[cfg(desktop)]
use crate::askpass::server::{ConfirmKind, ConfirmRequest, Confirmer, Verdict};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use zeroize::Zeroizing;

/// 遠端請求確認窗編號的標記位元（#2075）。編號會放進視窗網址 `askpass.html?id=…`，前端用 JS 的 Number 解析、而且網址只收最多 16 位數的正整數，
/// 所以編號必須在 2^53 之內（JS 能精確表示）且不超過 16 位數；原本用 1<<62（19 位數、超過 2^53）會讓視窗顯示「這個視窗的網址不正確」。
/// 本機 git／ssh 小幫手的編號是從 1 起算的小流水號，到不了 2^40，兩邊不會撞。
pub const REMOTE_ID_BASE: u64 = 1 << 40;

/// 確認窗最多開多久（也不會超過請求本身剩下的時間）
pub const DIALOG_MAX: Duration = Duration::from_secs(120);

/// 已經處理（或正在處理）過的請求編號。後台的待確認清單在回覆前都還會出現，不記著就會一直重複跳窗
#[derive(Default)]
pub struct Seen {
    ids: Mutex<HashSet<String>>,
    next: AtomicU64,
}

impl Seen {
    /// 第一次見到才回 true
    fn first(&self, id: &str) -> bool {
        self.ids.lock().unwrap().insert(id.to_string())
    }
    /// 後台清單裡已經沒有的編號（過期、別台設備答了）從記錄移除，免得無限長大
    fn retain_only(&self, live: &[PendingReq]) {
        self.ids.lock().unwrap().retain(|i| live.iter().any(|r| &r.id == i));
    }
    fn dialog_id(&self) -> u64 {
        // 與本機小幫手的確認窗編號分開（高位元標記），視窗標籤才不會撞
        REMOTE_ID_BASE | self.next.fetch_add(1, Ordering::SeqCst)
    }
}

/// 一次處理的結果，給呼叫者記 log 用（只有數量，沒有任何內容）
#[derive(Debug, Default, PartialEq)]
pub struct Round {
    pub shown: usize,
    pub sent: usize,
    pub denied: usize,
    pub failed: usize,
}

/// 把一筆請求的答案送回後台（加密在這裡做）。`secret` 為 None＝拒絕。回傳錯誤字串不含密碼或密文
pub async fn answer(be: &dyn Backend, token: Option<&str>, req: &PendingReq, secret: Option<&[u8]>) -> Result<(), String> {
    let cipher = match secret {
        Some(s) => Some(seal(&req.id, &req.pub_b64, s).map_err(|e| e.to_string())?),
        None => None,
    };
    let body = wire::build_reply_body(&req.id, cipher.as_deref())?;
    be.reply(body, token).await.map(|_| ())
}

/// 查一次待確認清單，逐筆跳窗（一次只跳一扇）。已處理過的請求不重複跳窗
#[cfg(desktop)]
pub async fn run_round(be: &dyn Backend, token: Option<&str>, confirmer: &dyn Confirmer, seen: &Seen) -> Result<Round, String> {
    let list = wire::parse_pending(&be.pending(token).await?);
    seen.retain_only(&list);
    let mut round = Round::default();
    for req in list {
        if !seen.first(&req.id) {
            continue;
        }
        round.shown += 1;
        let creq = ConfirmRequest {
            id: seen.dialog_id(),
            kind: ConfirmKind::Secret,
            program: req.program.clone(),
            cwd: String::new(),
            prompt: req.purpose.clone(),
            timeout: Duration::from_secs(req.seconds_left).min(DIALOG_MAX),
            origin: Some(req.node_name.clone()),
            fingerprint: Some(fingerprint(&req.pub_b64)),
        };
        let verdict = tokio::time::timeout(creq.timeout + Duration::from_secs(5), confirmer.ask(creq)).await.unwrap_or(Verdict::TimedOut);
        let res = match verdict {
            Verdict::Secret(s) if !s.is_empty() && s.len() <= MAX_SECRET => {
                let r = answer(be, token, &req, Some(s.as_bytes())).await;
                drop(s);
                round.sent += r.is_ok() as usize;
                r
            }
            // 太長或空的：當成沒有確認，不送出任何東西
            Verdict::Secret(_) => Err("密碼是空的或太長".to_string()),
            Verdict::Cancelled | Verdict::Deny => {
                let r = answer(be, token, &req, None).await;
                round.denied += r.is_ok() as usize;
                r
            }
            // 逾時／沒有回應：不回覆，請求會自己過期
            Verdict::TimedOut | Verdict::Allow => Ok(()),
        };
        if res.is_err() {
            round.failed += 1;
        }
    }
    Ok(round)
}

// ---------- 手機（沒有 Tauri 確認窗）：畫面自己收密碼，Rust 端負責查清單與加密回覆 ----------

/// 給畫面看的待確認清單（全是清理過的文字與指紋，沒有公鑰以外的機密）
pub async fn list_for_ui(be: &dyn Backend, token: Option<&str>) -> Result<serde_json::Value, String> {
    let list = wire::parse_pending(&be.pending(token).await?);
    let items: Vec<_> = list
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id, "node_name": r.node_name, "program": r.program, "purpose": r.purpose,
                "fingerprint": fingerprint(&r.pub_b64), "seconds_left": r.seconds_left,
                // 登入網址：只給通過官方網域檢查的（wire::parse_pending 已驗過）；畫面只顯示網域、用按鈕打開
                "link": r.link, "link_host": r.link.as_deref().and_then(super::link::login_link_host),
            })
        })
        .collect();
    Ok(serde_json::json!({ "requests": items }))
}

/// 畫面按了確定（secret 有值）或取消（None）。公鑰一律重新向後台查，不信畫面傳來的；查不到（已過期或別台答了）回錯
pub async fn answer_from_ui(be: &dyn Backend, token: Option<&str>, id: &str, secret: Option<Zeroizing<String>>) -> Result<(), String> {
    let list = wire::parse_pending(&be.pending(token).await?);
    let req = list.iter().find(|r| r.id == id.to_ascii_lowercase()).ok_or("這筆密碼請求已經結束（過期或已處理）")?;
    match secret {
        Some(s) if !s.is_empty() && s.len() <= MAX_SECRET => answer(be, token, req, Some(s.as_bytes())).await,
        Some(_) => Err("密碼是空的或太長".into()),
        None => answer(be, token, req, None).await,
    }
}

#[cfg(test)]
mod id_tests {
    use super::*;

    /// #2075：遠端請求的確認窗編號要能通過前端 parseId（最多 16 位數的正整數）、JS Number 精確表示（≤ 2^53），而且每次不同
    #[test]
    fn 遠端確認窗編號_前端認得_js_數字精確_彼此不同() {
        let s = Seen::default();
        let a = s.dialog_id();
        let b = s.dialog_id();
        assert_ne!(a, b);
        for id in [a, b] {
            assert!(id.to_string().len() <= 16, "前端 parseId 只收最多 16 位數：{id}");
            assert!(id <= (1u64 << 53), "JS 的 Number 要能精確表示：{id}");
            assert_eq!(id as f64 as u64, id, "經過浮點數來回不變（JS 的 Number 就是 f64）：{id}");
            assert!(id >= REMOTE_ID_BASE, "要與本機小幫手的小流水號分開：{id}");
        }
    }
}
