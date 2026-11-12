//! 在別台電腦夥伴的畫面打字，打字的那台（D）的共用部分：電腦版與手機版的命令、收幀迴圈都用這裡（#1378）。
//!
//! - [`RemoteInputs`]：進行中的打字工作階段（觀看編號 → 送出端）。**只有握手完成才登記**：對方那台接受了
//!   （那邊的人按過允許，或符合免問的條件）、這台驗過對方的簽章、導出送字的金鑰（`view_input::d_finish`）之後，
//!   收幀迴圈才 [`RemoteInputs::add`]。沒登記的編號一律不收字。
//! - 結束就不收：對方結束、到期、本人按結束、網路不穩停住（[`RemoteInputs::stall`]），收幀迴圈收尾時 [`RemoteInputs::remove`]。
//! - [`send`]：字先過按鍵規則，編序號、加密，送到那台；[`resend_loop`]：那台沒確認的補送，太久沒確認就停住、結束這次打字。
//! - 紀錄只有長度和次數，沒有字的內容。
use crate::bell::{self, Outbound};
use crate::view_input::{self, DOutbox};
use crate::view_remote::{RemoteViews, Want};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::Sender;

/// 這個編號沒有開著的打字（沒開始、對方還沒接受、已經結束或停住）
pub const NOT_OPEN: &str = "這個畫面現在不能打字";
/// 補送太久沒確認、停下來時送給畫面的事件（電腦版與手機版相同）
pub const STALLED_EVENT: &str = "term-view-remote-input-stalled";

type Entry = (Arc<Mutex<DOutbox>>, Sender<Outbound>, bool);

/// 進行中的打字（看的那台）：觀看編號 → 送出端。只在本機
#[derive(Default)]
pub struct RemoteInputs {
    open: Mutex<HashMap<String, Entry>>,
}

impl RemoteInputs {
    /// 握手完成（對方接受、簽章驗過、導出送字的金鑰）之後才登記
    pub fn add(&self, id: &str, ob: Arc<Mutex<DOutbox>>, tx: Sender<Outbound>) {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), (ob, tx, false));
    }
    /// 開著、沒停住的才給
    pub fn get(&self, id: &str) -> Option<(Arc<Mutex<DOutbox>>, Sender<Outbound>)> {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).get(id).filter(|v| !v.2).map(|v| (v.0.clone(), v.1.clone()))
    }
    pub fn count(&self) -> usize {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
    /// 網路不穩：不再收字
    pub fn stall(&self, id: &str) {
        if let Some(v) = self.open.lock().unwrap_or_else(|e| e.into_inner()).get_mut(id) {
            v.2 = true;
        }
    }
    /// 收掉。回是不是因為網路不穩停的
    pub fn remove(&self, id: &str) -> bool {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).remove(id).is_some_and(|v| v.2)
    }
}

/// 本人打的字：先過按鍵規則，只送到開著的打字工作階段（沒登記、停住、收掉的一律回錯，字沒有收）。
/// 太快、太多回錯（整段不收，畫面要告訴本人）；送不出去不用回錯：那台沒確認就會補送，太久沒確認會停下來告訴本人
pub async fn send(inputs: &RemoteInputs, id: &str, data: &str, paste: bool, now_ms: u64) -> Result<(), String> {
    crate::term_frame::check_input(data)?;
    let (ob, tx) = inputs.get(id).ok_or(NOT_OPEN)?;
    let wires = ob.lock().unwrap_or_else(|e| e.into_inner()).push(data, paste, now_ms)?;
    for w in wires {
        let _ = bell::send_via(&tx, view_input::EVENT, serde_json::json!({ "w": w })).await;
    }
    Ok(())
}

/// 打字的補送：每 300 毫秒看一次，那台沒確認的再送；最舊的一幅 5 秒還沒確認就停下（不跳過缺的字），結束這次打字並叫 `on_stalled`
pub async fn resend_loop<F: FnOnce() + Send + 'static>(views: Arc<RemoteViews>, inputs: Arc<RemoteInputs>, id: String, on_stalled: F) {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let Some((ob, tx)) = inputs.get(&id) else { break };
        if views.want(&id) == Want::Ended {
            break;
        }
        let now = crate::auth::now_ms();
        let (again, stalled) = {
            let mut g = ob.lock().unwrap_or_else(|e| e.into_inner());
            (g.resend(now), g.stalled(now))
        };
        if stalled {
            inputs.stall(&id);
            views.set(&id, Want::Ended);
            on_stalled();
            break;
        }
        for w in again {
            let _ = bell::send_via(&tx, view_input::EVENT, serde_json::json!({ "w": w })).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view_handshake::test_key;
    use crate::view_input::TInput;

    const NOW: u64 = 1_800_000_000_000;

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    /// 登記一筆，回收到的密文（假的頻道：每幅都回確認）
    fn open_one(inputs: &RemoteInputs, id: &str) -> Arc<Mutex<Vec<String>>> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Outbound>(16);
        inputs.add(id, Arc::new(Mutex::new(DOutbox::new(view_input::input_key(&test_key(7)).unwrap(), id))), tx);
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        tokio::spawn(async move {
            while let Some(o) = rx.recv().await {
                g.lock().unwrap().push(o.payload["w"].as_str().unwrap_or_default().to_string());
                let _ = o.done.send(Ok(()));
            }
        });
        got
    }

    #[test]
    fn 沒經過對方接受_沒登記的工作階段_一律拒絕送字() {
        let inputs = RemoteInputs::default();
        assert_eq!(run(send(&inputs, "s1", "ls\r", false, NOW)).err().unwrap(), NOT_OPEN);
        assert_eq!(inputs.count(), 0);
    }

    #[test]
    fn 登記後_字加密送到那台_那台解得開() {
        run(async {
            let inputs = RemoteInputs::default();
            let got = open_one(&inputs, "s1");
            send(&inputs, "s1", "ls\r", false, NOW).await.unwrap();
            tokio::task::yield_now().await;
            let wires = got.lock().unwrap().clone();
            assert_eq!(wires.len(), 1);
            assert!(!wires[0].contains("ls"), "送出去的是密文");
            let mut t = TInput::new(view_input::input_key(&test_key(7)).unwrap(), "s1", NOW);
            t.push(&wires[0], NOW);
            assert_eq!(t.take(NOW).unwrap().iter().map(|k| k.d.clone()).collect::<String>(), "ls\r");
            // 別的編號照樣不收
            assert_eq!(send(&inputs, "s2", "x", false, NOW).await.err().unwrap(), NOT_OPEN);
        });
    }

    #[test]
    fn 對方接受後又結束或停住_同一個工作階段一律拒絕送字() {
        run(async {
            let inputs = RemoteInputs::default();
            let _got = open_one(&inputs, "s1");
            send(&inputs, "s1", "a", false, NOW).await.unwrap();
            inputs.stall("s1");
            assert_eq!(send(&inputs, "s1", "b", false, NOW).await.err().unwrap(), NOT_OPEN, "停住就不收");
            assert!(inputs.remove("s1"), "收掉時回是停住的");
            assert_eq!(send(&inputs, "s1", "c", false, NOW).await.err().unwrap(), NOT_OPEN, "收掉就不收");
            let _got = open_one(&inputs, "s2");
            assert!(!inputs.remove("s2"), "正常結束");
            assert_eq!(send(&inputs, "s2", "d", false, NOW).await.err().unwrap(), NOT_OPEN);
        });
    }

    #[test]
    fn 不是按鍵的序列先擋_連工作階段都不看() {
        let inputs = RemoteInputs::default();
        assert_eq!(run(send(&inputs, "s1", "\x1b]52;c;eA==\x07", false, NOW)).err().unwrap(), "這不是按鍵，不送");
        assert_eq!(run(send(&inputs, "s1", "", false, NOW)).err().unwrap(), "沒有要送的字");
    }

    #[test]
    fn 守門_登記一定在驗過對方簽章_導出送字金鑰之後() {
        // 電腦版（lib.rs 的 start_remote_view）與手機版（view_d.rs 的 run_view）：inputs.add 只能在 view_input::d_finish 成功之後
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let desk = lib.split("\nfn start_remote_view(").nth(1).expect("有 start_remote_view").split("\n}\n").next().unwrap();
        let core = include_str!("view_d.rs").replace("\r\n", "\n");
        let phone = core.split("\nasync fn run_view<").nth(1).expect("有 run_view").split("\n}\n").next().unwrap();
        for (name, f) in [("lib.rs", desk), ("view_d.rs", phone)] {
            let fin = f.find("view_input::d_finish(").unwrap_or_else(|| panic!("{name} 要用 d_finish"));
            let add = f.find("inputs.add(").unwrap_or_else(|| panic!("{name} 要登記"));
            assert!(fin < add, "{name}：先驗章導出金鑰，再登記");
            assert_eq!(f.matches("inputs.add(").count(), 1, "{name} 只有一個登記的地方");
            assert!(f.contains("inputs.remove(&id)"), "{name} 收尾時收掉");
        }
        // 其他地方不能登記
        for (name, src) in [("android.rs", include_str!("android.rs")), ("view_d_input.rs", include_str!("view_d_input.rs"))] {
            let code = src.replace("\r\n", "\n");
            let code = code.split("\nmod tests {").next().unwrap();
            assert!(!code.contains("inputs.add("), "{name} 不能登記打字");
        }
    }
}
