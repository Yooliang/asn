//! 看別台電腦的畫面：發起觀看的那台（D）這一側（#597 別台看畫面 PR 5）。
//!
//! - 發起只有一個入口：本人按「終端」（lib.rs 的 `term_view_remote_start`），直接用設備金鑰簽。11-08 起不再跳本人確認（Hello 或確認框，`presence` 保留未用）。
//! - 那台的設備公鑰和本機記住的比（TOFU）：換了就不開始並通知本人；第一次看到的，驗過 T 的簽章才記住（first 通知只有 T 寄）。
//! - 之後的回報迴圈**不簽章、不確認本人**：每 [`REPORT_EVERY_S`] 秒回報一次狀態，拿到對方的一次性公鑰就導出金鑰、開始收。
//! - **只收不送：** 這裡只有接收頻道，沒有任何送出端（守門測試）。暫停、結束只走控制面的固定狀態值。
//! - 收到的畫面在 `DReceiver` 解密、擋重放、再過濾一次，才交給畫面；畫面那邊只能看。
//! - 紀錄只有長度和次數，沒有畫面內容。
#![cfg_attr(not(test), allow(dead_code))]
use crate::view_handshake::{self, Session};
use crate::view_frame::{DReceiver, Frame, Received};
use std::collections::HashMap;
use std::sync::Mutex;

/// 回報間隔（秒）。T 那邊超過 90 秒沒回報就停
pub const REPORT_EVERY_S: u64 = 15;
/// 對方還沒接受時，隔幾秒回報一次（越早拿到對方的公鑰，越早開始收畫面；頻道不留訊息，開始收之前送的幅會漏掉）
pub const WAIT_ACCEPT_EVERY_S: u64 = 1;
/// 等對方接受最多這麼久用快的間隔，之後回到 [`REPORT_EVERY_S`]（對方一直沒接受，不要一直每秒打後台）
pub const WAIT_ACCEPT_FOR_S: u64 = 60;

/// 下一次回報前要等幾秒。accepted：已經拿到對方的公鑰；waited_s：從開始到現在幾秒
pub fn report_wait_s(accepted: bool, waited_s: u64) -> u64 {
    if !accepted && waited_s < WAIT_ACCEPT_FOR_S { WAIT_ACCEPT_EVERY_S } else { REPORT_EVERY_S }
}
/// 一次觀看多久（秒），和後台上限相同（後台允許 10 分 30 秒，留 30 秒時鐘差）
pub const VIEW_SECS: i64 = 600;
/// 同時最多看幾個，和後台上限相同
pub const MAX_OPEN: usize = 3;
pub const TOO_MANY: &str = "同時最多看 3 個畫面，請先結束一個";
/// 那台的設備公鑰和這台記住的不同
pub const TARGET_KEY_CHANGED: &str = "那台電腦的設備金鑰變了，沒有開始看。如果是你重裝了那台，請到設定頁「認得的電腦」按「忘記這台」再看一次";

/// 本人在畫面上要的狀態：看、暫停（畫面被藏起來）、結束
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want {
    Watching,
    Paused,
    Ended,
}

impl Want {
    pub fn report_state(self) -> &'static str {
        match self {
            Want::Watching => "watching",
            Want::Paused => "paused",
            Want::Ended => "ended",
        }
    }
}

/// 進行中的觀看：本人要的狀態。回報迴圈每次讀它
#[derive(Default)]
pub struct RemoteViews {
    open: Mutex<HashMap<String, Want>>,
}

impl RemoteViews {
    /// 登記一筆新的。滿了就拒絕
    pub fn add(&self, id: &str) -> Result<(), String> {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if open.len() >= MAX_OPEN {
            return Err(TOO_MANY.to_string());
        }
        open.insert(id.to_string(), Want::Watching);
        Ok(())
    }
    pub fn want(&self, id: &str) -> Want {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).get(id).copied().unwrap_or(Want::Ended)
    }
    /// 本人改狀態。已經結束的不會再打開
    pub fn set(&self, id: &str, w: Want) {
        if let Some(v) = self.open.lock().unwrap_or_else(|e| e.into_inner()).get_mut(id) {
            if *v != Want::Ended {
                *v = w;
            }
        }
    }
    pub fn remove(&self, id: &str) {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
}

/// 新的觀看編號（uuid v4）
pub fn new_session_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| "產生不了觀看編號".to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

/// 這次觀看的資料。到期時間取整秒，T 拿到的也是整秒
pub fn session(id: &str, me_node: &str, to_node: &str, window: &str, scope: view_handshake::Scope, now_s: i64) -> Session {
    Session { id: id.to_string(), d_node: me_node.to_string(), t_node: to_node.to_string(), window: window.to_string(), scope, expires_s: now_s + VIEW_SECS }
}

/// 回報的結果怎麼處理
#[derive(Debug, PartialEq)]
pub enum Step {
    /// 對方還沒接受，繼續等
    Waiting,
    /// 拿到對方的一次性公鑰和簽章，可以導出金鑰
    Accepted { t_eph: String, t_sig: String },
    /// 這次觀看結束了（對方拒絕、到期、任一方結束、這筆不見了）
    Ended(String),
}

/// 看後台回的 report：結束、還在等、已接受
pub fn step_of(report: &serde_json::Value) -> Step {
    let s = |k: &str| report.get(k).and_then(serde_json::Value::as_str);
    match s("status") {
        Some("ended") => Step::Ended(s("end_reason").unwrap_or("ended").to_string()),
        Some("requested") => Step::Waiting,
        Some("accepted" | "watching" | "paused") => match (s("t_eph_pub"), s("t_sig")) {
            (Some(e), Some(g)) => Step::Accepted { t_eph: e.to_string(), t_sig: g.to_string() },
            _ => Step::Waiting,
        },
        _ => Step::Ended("gone".to_string()),
    }
}

/// 結束原因 → 給本人看的話
pub fn end_text(reason: &str) -> &'static str {
    match reason {
        "rejected" => "那台沒有接受，可能是現在沒有這個夥伴的畫面，或是那台沒有允許別台看",
        "mobile_off" => "這台電腦不允許移動設備查看終端",
        "held_prompt" => "對方畫面出現需要本人確認的框，遠端輸入已停止。請在那台電腦的畫面上處理完再重新開始",
        "target_ended" => "那台結束了觀看",
        "expired" => "時間到了，要再看請再按一次",
        "viewer_ended" | "ended" => "已經結束",
        "bad_frames" => "收到的畫面一直解不開，已經結束",
        "input_stalled" => "網路不穩，打字已經停止，最後幾個字可能沒送到",
        _ => "這次觀看結束了",
    }
}

/// 收到一則 broadcast：只認 event=frame，內容欄位 w。其他一律丟掉
pub fn frame_wire(event: &str, payload: &serde_json::Value) -> Option<String> {
    if event != "frame" {
        return None;
    }
    payload.get("w").and_then(serde_json::Value::as_str).map(str::to_string)
}

/// 解出來的畫面交給畫面前要做的事：解密、擋重放、再過濾（DReceiver），回要顯示的畫面或要結束
pub enum Show {
    Frame(Frame),
    Skip,
    End,
}

pub fn receive(rx: &mut DReceiver, wire: &str) -> Show {
    match rx.receive(wire) {
        Received::Frame(_, f) => Show::Frame(f),
        Received::Dropped => Show::Skip,
        Received::TooManyBad => Show::End,
    }
}

/// D 導出金鑰：用 T 的設備公鑰（呼叫端已經和本機記住的比過）驗 T 的簽章
pub fn finish(t_pub: &str, eph: view_handshake::Eph, s: &Session, t_eph: &str, t_sig: &str, now_s: i64) -> Result<DReceiver, String> {
    let key = view_handshake::d_finish(t_pub, eph, s, t_eph, t_sig, now_s)?;
    Ok(DReceiver::new(key, &s.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 觀看編號是_uuid_v4_每次不同() {
        let a = new_session_id().unwrap();
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert!("89ab".contains(&a[19..20]));
        assert_ne!(a, new_session_id().unwrap());
    }

    #[test]
    fn 同時最多三個_結束的不會再打開() {
        let v = RemoteViews::default();
        for i in 0..MAX_OPEN {
            v.add(&format!("s{i}")).unwrap();
        }
        assert_eq!(v.add("多").unwrap_err(), TOO_MANY);
        v.set("s0", Want::Paused);
        assert_eq!(v.want("s0"), Want::Paused);
        v.set("s0", Want::Ended);
        v.set("s0", Want::Watching);
        assert_eq!(v.want("s0"), Want::Ended, "結束了就是結束了");
        assert_eq!(v.want("沒有"), Want::Ended);
        v.remove("s0");
        v.add("新").unwrap();
    }

    #[test]
    fn 回報結果_等待_接受_結束() {
        assert_eq!(step_of(&json!({ "status": "requested" })), Step::Waiting);
        assert_eq!(step_of(&json!({ "status": "accepted" })), Step::Waiting, "還沒有公鑰");
        assert_eq!(step_of(&json!({ "status": "accepted", "t_eph_pub": "e", "t_sig": "g" })), Step::Accepted { t_eph: "e".into(), t_sig: "g".into() });
        assert_eq!(step_of(&json!({ "status": "ended", "end_reason": "rejected" })), Step::Ended("rejected".into()));
        assert_eq!(step_of(&json!({ "error": "not_found" })), Step::Ended("gone".into()), "這筆不見了");
        assert_eq!(end_text("expired"), "時間到了，要再看請再按一次");
        assert_eq!(end_text("mobile_off"), "這台電腦不允許移動設備查看終端");
        assert!(end_text("held_prompt").starts_with("對方畫面出現需要本人確認的框，遠端輸入已停止"));
    }

    #[test]
    fn 只認_frame_事件() {
        assert_eq!(frame_wire("frame", &json!({ "w": "abc" })), Some("abc".into()));
        assert_eq!(frame_wire("frame", &json!({ "x": "abc" })), None);
        assert_eq!(frame_wire("bell", &json!({ "w": "abc" })), None);
        assert_eq!(frame_wire("input", &json!({ "w": "abc" })), None);
    }

    #[test]
    fn 對方還沒接受時每秒回報_接受後或等太久回到_15_秒() {
        assert_eq!(report_wait_s(false, 0), 1, "還沒接受：快一點拿到公鑰、早一點開始收");
        assert_eq!(report_wait_s(false, WAIT_ACCEPT_FOR_S - 1), 1);
        assert_eq!(report_wait_s(false, WAIT_ACCEPT_FOR_S), REPORT_EVERY_S, "一直沒接受：不要一直每秒打後台");
        assert_eq!(report_wait_s(true, 0), REPORT_EVERY_S, "已經在收：照舊 15 秒");
        // 開始收之前送的幅會漏掉：被看的那台補送的間隔要比這邊等接受的間隔長
        #[cfg(desktop)]
        assert!(WAIT_ACCEPT_EVERY_S * 1000 < crate::view_stream::RESEND_SAME_MS);
    }

    #[test]
    fn 守門_回報迴圈不確認本人也不用設備金鑰簽_也不算進發起的次數上限() {
        // 每秒回報只用已經登入的權杖：不跳 Hello、不跳確認框，本人不會被連問
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let body = lib.split("\nfn start_remote_view(").nth(1).expect("有 start_remote_view").split("\n}\n").next().unwrap();
        assert!(body.contains("pair_token("), "回報用登入的權杖");
        for bad in [concat!("presence", "::"), "key_async", "device_id::live::key", ".sign("] {
            assert!(!body.contains(bad), "回報迴圈不能有 {bad}");
        }
        // 後台每小時 30 次的上限只數發起（term_views 新增的列）；回報只更新那一列，不新增、不檢查次數
        let sql = include_str!("../../../../supabase/migrations/20261107110000_term_views.sql").replace("\r\n", "\n");
        let report = sql.split("function public.asn_relay_term_view_report(").nth(1).unwrap().split("$function$;").next().unwrap();
        assert!(!report.to_lowercase().contains("insert into") && !report.contains("rate_limited"), "回報不新增列、沒有次數上限");
        let start = sql.split("function public.asn_relay_term_view_start(").nth(1).unwrap().split("$function$;").next().unwrap();
        assert!(start.contains("interval '1 hour'") && start.contains("rate_limited"), "次數上限在發起");
    }

    #[test]
    fn 守門_這裡只收不送_也不確認本人不簽章() {
        let src = include_str!("view_remote.rs");
        let code = src.split("\nmod tests {").next().unwrap();
        for bad in ["Outbound", "send_via", "broadcast_msg", "presence::", "sign_b64", "live::see", "live::forget"] {
            assert!(!code.contains(bad), "看的那台的背景流程不能有：{bad}");
        }
    }
}
