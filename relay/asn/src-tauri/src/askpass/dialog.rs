//! 正式版的確認窗：開一扇 Tauri 視窗（ui/askpass.html），使用者輸入密碼按確定、或按取消／關窗／逾時。
//! 密碼的路徑：視窗的輸入欄 → `askpass_answer` 命令 → 這裡的 oneshot → 管道。視窗一送出就清空輸入欄並關窗；
//! 這一端的字串用 `Zeroizing`，用完立刻清。盡力而為：網頁引擎與行程間通訊自己持有的暫存沒有辦法清（見 docs/design/SECRETS.md）。
use super::server::{BoxFut, ConfirmKind, ConfirmRequest, Confirmer, Verdict};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

/// 視窗向 Rust 要的顯示內容（不含任何密碼）
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DialogInfo {
    pub id: u64,
    /// "secret"；預留給 #23 的 "permission"
    pub kind: String,
    pub program: String,
    pub cwd: String,
    pub prompt: String,
    pub seconds_left: u64,
}

struct Slot {
    req: ConfirmRequest,
    deadline: Instant,
    tx: Option<oneshot::Sender<Verdict>>,
}

/// 待回答的確認窗登記簿（Tauri 管理的狀態）。也可以不靠視窗直接測：登記、回答、取消
#[derive(Default)]
pub struct DialogState {
    slots: Mutex<HashMap<u64, Slot>>,
}

impl DialogState {
    pub fn register(&self, req: ConfirmRequest) -> oneshot::Receiver<Verdict> {
        let (tx, rx) = oneshot::channel();
        let deadline = Instant::now() + req.timeout;
        self.slots.lock().unwrap().insert(req.id, Slot { req, deadline, tx: Some(tx) });
        rx
    }

    pub fn info(&self, id: u64) -> Option<DialogInfo> {
        let g = self.slots.lock().unwrap();
        let s = g.get(&id)?;
        Some(DialogInfo {
            id,
            kind: match s.req.kind {
                ConfirmKind::Secret => "secret".into(),
                ConfirmKind::Permission => "permission".into(),
            },
            program: s.req.program.clone(),
            cwd: s.req.cwd.clone(),
            prompt: s.req.prompt.clone(),
            seconds_left: s.deadline.saturating_duration_since(Instant::now()).as_secs(),
        })
    }

    /// 回答一次（第二次回答、或已被取消的都回 false）
    pub fn answer(&self, id: u64, v: Verdict) -> bool {
        let tx = self.slots.lock().unwrap().get_mut(&id).and_then(|s| s.tx.take());
        match tx {
            Some(tx) => tx.send(v).is_ok(),
            None => false,
        }
    }

    pub fn remove(&self, id: u64) {
        self.slots.lock().unwrap().remove(&id);
    }

    pub fn pending(&self) -> usize {
        self.slots.lock().unwrap().len()
    }
}

pub fn label(id: u64) -> String {
    format!("askpass-{id}")
}

pub struct TauriConfirmer {
    pub app: AppHandle,
    pub state: Arc<DialogState>,
}

/// 登記簿項目與視窗的清理：future 被丟棄（逾時、對方斷線）或正常結束都會關窗、清登記
struct Cleanup {
    app: AppHandle,
    state: Arc<DialogState>,
    id: u64,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.state.remove(self.id);
        if let Some(w) = self.app.get_webview_window(&label(self.id)) {
            let _ = w.destroy();
        }
    }
}

impl Confirmer for TauriConfirmer {
    fn ask(&self, req: ConfirmRequest) -> BoxFut<'_, Verdict> {
        Box::pin(async move {
            let id = req.id;
            // 預留給 #23；管道這條路只會送 Secret
            if req.kind != ConfirmKind::Secret {
                return Verdict::Cancelled;
            }
            let rx = self.state.register(req);
            let _cleanup = Cleanup { app: self.app.clone(), state: self.state.clone(), id };
            let built = WebviewWindowBuilder::new(&self.app, label(id), WebviewUrl::App(format!("askpass.html?id={id}").into()))
                .title("ASN 密碼請求")
                .inner_size(460.0, 330.0)
                .resizable(false)
                .always_on_top(true)
                .center()
                .focused(true)
                .disable_drag_drop_handler()
                .additional_browser_args(crate::BROWSER_ARGS)
                .build();
            let win = match built {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[ASN] 密碼請求視窗開不起來：{e}");
                    return Verdict::Cancelled;
                }
            };
            // 使用者按視窗的關閉鈕＝取消
            let (st, wid) = (self.state.clone(), id);
            win.on_window_event(move |ev| {
                if matches!(ev, tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }) {
                    st.answer(wid, Verdict::Cancelled);
                }
            });
            rx.await.unwrap_or(Verdict::Cancelled)
        })
    }
}

fn check_label(window: &Window, id: u64) -> Result<(), String> {
    if window.label() == label(id) {
        Ok(())
    } else {
        Err("不是這扇確認視窗".into())
    }
}

/// 確認窗啟動時要顯示的內容
#[tauri::command]
pub fn askpass_info(state: State<'_, Arc<DialogState>>, window: Window, id: u64) -> Result<DialogInfo, String> {
    check_label(&window, id)?;
    state.info(id).ok_or_else(|| "這個請求已經結束".to_string())
}

/// 使用者按確定（帶輸入的字）或取消（secret 為空值）。只接受確認窗自己送來的
#[tauri::command]
pub fn askpass_answer(state: State<'_, Arc<DialogState>>, window: Window, id: u64, secret: Option<String>) -> Result<(), String> {
    check_label(&window, id)?;
    let v = match secret {
        Some(s) => Verdict::Secret(Zeroizing::new(s)),
        None => Verdict::Cancelled,
    };
    if state.answer(id, v) {
        Ok(())
    } else {
        Err("這個請求已經結束".into())
    }
}

/// 設定頁「密碼小幫手」
#[tauri::command]
pub fn askpass_helper_info() -> serde_json::Value {
    super::info()
}

/// 啟動時呼叫：管道服務跑起來。建不起來（名字被佔、系統不支援）只記一行 log，不影響其他功能
pub fn start(app: &AppHandle) {
    let state: Arc<DialogState> = app.state::<Arc<DialogState>>().inner().clone();
    let confirmer = Arc::new(TauriConfirmer { app: app.clone(), state });
    let procs: super::server::Procs = Arc::new(|| crate::cli::process_table().ok());
    let broker = Arc::new(super::server::Broker::new(confirmer, procs));
    let name = super::pipe::pipe_name();
    tauri::async_runtime::spawn(async move {
        match super::server::serve(&name, broker) {
            Ok(h) => {
                let _ = h.await;
            }
            Err(e) => eprintln!("[ASN] 密碼小幫手管道沒有啟動：{e}"),
        }
    });
}
