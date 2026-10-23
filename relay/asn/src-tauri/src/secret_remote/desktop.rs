//! 電腦 ASN 的確認端常駐工作：收到門鈴（或每 60 秒保底）就向後台查有沒有待確認的密碼請求，有就用第一期的確認窗讓本人看清楚並輸入。
//! 沒登入就什麼都不做（不打後台）。確認窗沿用 `askpass::dialog::TauriConfirmer`，多顯示「請求設備」與「公鑰指紋」。
use super::confirm::{run_round, Seen};
use crate::askpass::dialog::{DialogState, TauriConfirmer};
use crate::relay::Relay;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

/// 啟動常駐工作；回傳的 `Notify` 是「叫醒」鈕（門鈴響時呼叫）
pub fn start(app: &AppHandle, relay: Arc<Relay>) -> Arc<Notify> {
    let state: Arc<DialogState> = app.state::<Arc<DialogState>>().inner().clone();
    let confirmer = Arc::new(TauriConfirmer { app: app.clone(), state });
    let wake = Arc::new(Notify::new());
    let (app2, wake2, seen) = (app.clone(), wake.clone(), Arc::new(Seen::default()));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let auth = app2.state::<crate::auth::AuthState>();
            if let Some(token) = crate::account::signing_token(&auth).await {
                // 一直問到沒有新的待確認為止（確認窗開著的時候又來了新的請求，下一圈就會撈到）
                loop {
                    match run_round(relay.as_ref(), Some(&token), confirmer.as_ref(), &seen).await {
                        Ok(r) if r.shown > 0 => continue,
                        Ok(_) => break,
                        Err(e) => {
                            // 後台還沒部署這個動作（404）等：只記一行，不含任何內容
                            eprintln!("[ASN] 查密碼請求失敗：{e}");
                            break;
                        }
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                _ = wake2.notified() => {}
            }
        }
    });
    wake
}
