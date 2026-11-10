//! 別台要在這台打字（0.2.10）：問被打字這台的本人。
//!
//! - **同意框是 ASN 的視窗（系統對話框），不在終端裡：** 終端裡的提示可能被當成按鍵答掉。問之前先把 ASN 叫到前面。
//! - [`ASK_SECS`] 秒沒按當不允許（再受這次請求自己的有效期限限制）；按了「不允許」、關掉框也是不允許。系統對話框從外面關不掉：逾時後框還在，那時才按的一律算不允許，並通知本人。
//! - 同一台同一時間只開一個確認框（[`ConsentSlot`]）；前一個還開著（含逾時後沒關的）就不開第二個，直接不允許。
//!   系統對話框一直沒叫回呼時，到了請求期限加 [`SLOT_GRACE_SECS`] 也放開位子（舊框按了也不算允許）。
//! - **結果只在 Rust 裡用，沒有任何畫面命令能回報「允許」**（守門測試）；只有 lib.rs 的 `start_view_poller` 能叫 [`ask`]。
//! - 本人可以在這台的設定頁「認得的電腦」對某一台設「打字不用每次問我」，那台就不跳這個框（判斷在呼叫端，存在本機）。
//! - **框上的名字用本機記住的（[`who_of`]），不用後台這次給的：** 後台給的名字不在簽章裡。只有第一次連線（本機還沒記住）才用後台給的，並在框上標示「第一次連線」；另外附設備指紋前 8 碼讓本人比對設定頁。
use crate::device_id::{fingerprint, KnownPeers, Tofu};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// 同意框等多久（秒）
pub const ASK_SECS: u64 = 60;

/// 名字最多幾個字（和後台、設定頁一致）
const NAME_MAX: usize = 40;

/// 同意框上的「誰」
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Who {
    pub name: String,
    /// 設備指紋前 8 碼（設定頁「認得的電腦」顯示完整指紋）
    pub fp8: String,
    /// 本機還沒記住這台（第一次連線）：名字是後台給的
    pub first: bool,
    /// 本人在這台對這把公鑰按過「允許」打字（0.2.15）
    pub typed_before: bool,
    /// 本人在設定頁把這台設成每次都問
    pub always_ask: bool,
}

/// 去掉控制字元與改變文字方向的字元，截長度
fn clean(s: &str, max: usize) -> String {
    let bad = |c: char| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}');
    s.chars().map(|c| if bad(c) { ' ' } else { c }).collect::<String>().trim().chars().take(max).collect()
}

/// 框上要顯示的「誰」：和本機記住的一樣（Same）就用本機記住的名字；其他情況（第一次）才用後台給的，並標示第一次連線
pub fn who_of(known: &KnownPeers, node: &str, backend_name: &str, sign_pub: &str, tofu: Tofu) -> Who {
    let local = if tofu == Tofu::Same { known.peer(node).map(|p| p.name.as_str()) } else { None };
    let peer = if tofu == Tofu::Same { known.peer(node) } else { None };
    Who {
        name: clean(local.unwrap_or(backend_name), NAME_MAX),
        fp8: fingerprint(sign_pub).chars().take(8).collect(),
        first: local.is_none(),
        typed_before: peer.is_some() && known.input_confirmed(node),
        always_ask: peer.is_some_and(|p| p.input_always_ask),
    }
}

/// 同意框的話：誰（名字＋指紋）、哪個視窗、能做什麼
pub fn ask_text(who: &Who, window: &str) -> String {
    let name = if who.name.is_empty() { "另一台電腦".to_string() } else { format!("「{}」", who.name) };
    let window = clean(window, 64);
    let first = if who.first {
        "\n\n這台電腦是第一次連線到這裡，請確認是你自己的電腦。"
    } else if !who.typed_before {
        "\n\n這台電腦還沒在這裡打過字，名字可能不準，請用指紋確認是你自己的電腦。"
    } else {
        ""
    };
    // 按了允許之後會不會再問（0.2.15）：設成每次都問的就照樣每次問
    let later = if who.always_ask { "" } else { "\n\n按「允許」之後，這台以後要在這裡打字就不會再問你（紅條照樣會出現）；想每次都問，可以到設定 → 認得的電腦取消勾選。" };
    format!("{name}（指紋 {}）要在這台的「{window}」打字。{first}\n\n允許之後，對方可以在這個視窗打任何字，包括回答權限框。最多 10 分鐘，2 分鐘沒打字就自動結束；你隨時可以在 ASN 按「結束」。{later}\n\n要允許嗎？", who.fp8)
}

/// 紅條（有人在看／在打字）上的「誰」：名字＋指紋前 8 碼，第一次連線另外標示。畫面會在外面加「」
pub fn bar_label(who: &Who) -> String {
    let name = if who.name.is_empty() { "另一台電腦" } else { who.name.as_str() };
    let first = if who.first { "，第一次連線" } else { "" };
    format!("{name}（指紋 {}{first}）", who.fp8)
}

/// #933：本人在設定頁勾「允許這支手機替這台登入」之前的確認框文字：名字＋指紋前 8 碼（和紅條同一種），寫清楚勾了能做什麼
pub fn login_ok_text(name: &str, sign_pub: &str) -> String {
    let name = clean(name, NAME_MAX);
    let name = if name.is_empty() { "這支手機".to_string() } else { format!("「{name}」") };
    let fp8: String = fingerprint(sign_pub).chars().take(8).collect();
    format!("{name}（指紋 {fp8}）\n\n勾了以後，這支手機可以讓這台電腦登入 Codex 等帳號：這台會開始登入，登入網址和代碼只會加密送到那支手機。\n\n請先確認指紋和那支手機設定頁顯示的一樣，而且是你自己的手機。要允許嗎？")
}

/// 「允許」按鈕的字：只有按了這一顆才算允許
const ALLOW: &str = "允許";

/// 三顆按鈕：第一顆（預設焦點，按 Enter 就是它）是「不要」，第二顆才是「允許」，第三顆是取消。
/// Windows 的對話框預設焦點一定在第一顆，所以「允許」不能放第一顆；關掉框、按 Esc 在各平台都回取消或第三顆
fn buttons(no: &str) -> tauri_plugin_dialog::MessageDialogButtons {
    tauri_plugin_dialog::MessageDialogButtons::YesNoCancelCustom(no.into(), ALLOW.into(), "取消".into())
}

/// 對話框的結果算不算允許：只有明確按了「允許」那一顆
fn allowed(r: &tauri_plugin_dialog::MessageDialogResult) -> bool {
    matches!(r, tauri_plugin_dialog::MessageDialogResult::Custom(s) if s == ALLOW)
}

/// 勾「允許替這台登入」前問本人。允許回 true；不要、取消、關掉、逾時都回 false。
/// 同一時間只開一個框：已經有框開著就直接回 false
pub async fn ask_login_ok(app: &AppHandle, name: &str, sign_pub: &str) -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    static ASKING: AtomicBool = AtomicBool::new(false);
    if ASKING.swap(true, Ordering::SeqCst) {
        return false;
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            ASKING.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done;
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(login_ok_text(name, sign_pub))
        .title("ASN：允許手機替這台登入")
        .kind(MessageDialogKind::Warning)
        .buttons(buttons("先不要"))
        .show_with_result(move |r| {
            let _ = tx.send(allowed(&r));
        });
    matches!(tokio::time::timeout(std::time::Duration::from_secs(ASK_SECS), rx).await, Ok(Ok(true)))
}

/// 通知桌面畫面：這次請求已逾時、沒有允許（框是逾時以後才被按的）
pub const EV_EXPIRED: &str = "input-consent-expired";
/// 通知桌面畫面：前一個確認框還開著，這次沒有允許
pub const EV_BUSY: &str = "input-consent-busy";

/// 這次結果算不算允許：沒回答（逾時、被撤回）算不允許；只有在期限之前明確按「允許」才算
pub fn consent_outcome(answer: Option<bool>, now_s: i64, expires_s: i64) -> bool {
    answer == Some(true) && now_s < expires_s
}

/// 確認框被按下時怎麼算（純函式）：`pressed_allow` 是不是按了「允許」、`timed_out` 是不是已經不等了、
/// `now_s`／`deadline_s` 是現在與這次的期限。回（算不算允許、要不要告訴本人「已逾時」）。
/// 逾時或過了期限才按：一律不允許；只有那時按的是「允許」才提示（按「不允許」本來就是不允許，不用多一句）
pub fn click_outcome(pressed_allow: bool, timed_out: bool, now_s: i64, deadline_s: i64) -> (bool, bool) {
    let late = timed_out || now_s >= deadline_s;
    if late {
        return (false, pressed_allow);
    }
    (consent_outcome(Some(pressed_allow), now_s, deadline_s), false)
}

/// 最多等幾秒：[`ASK_SECS`] 和這次請求剩下的有效時間取小的；已經過期就是 0
pub fn wait_secs(now_s: i64, expires_s: i64) -> u64 {
    u64::try_from(expires_s.saturating_sub(now_s)).unwrap_or(0).min(ASK_SECS)
}

/// 請求過期之後再等多久（秒），就算系統對話框一直沒叫回呼也把位子放掉。過期後按什麼都不算允許，放掉不會讓舊框變得能用
pub const SLOT_GRACE_SECS: i64 = 120;

/// 一台同一時間只開一個打字確認框。框開著就一直被佔用：框真的被關掉（對話框的回呼）才放開；
/// 回呼一直沒來時，到了「請求期限＋寬限」也自動放開（逾時本身不放）
pub struct ConsentSlot(std::sync::Mutex<Option<(u64, i64)>>, std::sync::atomic::AtomicU64);

impl ConsentSlot {
    pub const fn new() -> Self {
        Self(std::sync::Mutex::new(None), std::sync::atomic::AtomicU64::new(1))
    }

    /// 取得位子；已經被佔用、而且還沒到它的放開時間就回 None。`release_at` 是這次的自動放開時間（秒）
    pub fn try_take(&'static self, now_s: i64, release_at: i64) -> Option<SlotGuard> {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, until)) = *g {
            if now_s < until {
                return None;
            }
        }
        let token = self.1.fetch_add(1, Ordering::SeqCst);
        *g = Some((token, release_at));
        Some(SlotGuard(self, token))
    }
}

/// 佔著位子的憑證；丟掉（drop）就放開。位子已經被後來的請求接手時不動它
pub struct SlotGuard(&'static ConsentSlot, u64);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let mut g = (self.0).0.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_some_and(|(token, _)| token == self.1) {
            *g = None;
        }
    }
}

static SLOT: ConsentSlot = ConsentSlot::new();

fn now_s() -> i64 {
    (crate::auth::now_ms() / 1000) as i64
}

/// 問本人。允許回 true；不允許、取消、關掉、逾時、請求已過期、前一個框還開著都回 false。
/// `expires_s` 是這次請求的有效期限（秒）：超過就不能再算允許
pub async fn ask(app: &AppHandle, who: &Who, window: &str, expires_s: i64) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let Some(slot) = SLOT.try_take(now_s(), expires_s.saturating_add(SLOT_GRACE_SECS)) else {
        let _ = app.emit_to("list", EV_BUSY, serde_json::json!({ "window": clean(window, 64) }));
        return false;
    };
    let start = now_s();
    let wait = wait_secs(start, expires_s);
    if wait == 0 {
        // 收到時就已經過期（多半是這台時鐘比後台快）：不開框、不允許；記一行原因，不記內容
        elog!("[asn] 別台打字的請求收到時已過期，沒有開確認框（現在 {start}，期限 {expires_s}）");
        return false;
    }
    let deadline_s = start + wait as i64;
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let timed_out = Arc::new(AtomicBool::new(false));
    let (cb_app, cb_timed_out, cb_window) = (app.clone(), timed_out.clone(), clean(window, 64));
    app.dialog()
        .message(ask_text(who, window))
        .title("ASN：別台要在這台打字")
        .kind(MessageDialogKind::Warning)
        .buttons(buttons("不允許"))
        .show_with_result(move |r| {
            // 位子在框真的被關掉的這一刻才放開（逾時時框還在畫面上，不能放）
            let _slot = slot;
            let (allow, notify) = click_outcome(allowed(&r), cb_timed_out.load(Ordering::SeqCst), now_s(), deadline_s);
            if notify {
                // 逾時之後才按「允許」：不允許，告訴本人
                let _ = cb_app.emit_to("list", EV_EXPIRED, serde_json::json!({ "window": cb_window }));
            }
            let _ = tx.send(allow);
        });
    let answer = match tokio::time::timeout(std::time::Duration::from_secs(wait), rx).await {
        Ok(Ok(v)) => Some(v),
        _ => {
            timed_out.store(true, Ordering::SeqCst);
            None
        }
    };
    consent_outcome(answer, now_s(), expires_s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUB: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn known_d() -> KnownPeers {
        let mut k = KnownPeers::default();
        k.remember("d", "家用機", PUB, 1).unwrap();
        k
    }

    /// 預設焦點（第一顆）不能是「允許」；只有明確按了「允許」才算，Enter、Esc、關掉、別的按鈕都不算
    #[test]
    fn 確認框_第一顆不是允許_只有按允許才算() {
        use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogResult as R};
        for no in ["先不要", "不允許"] {
            match buttons(no) {
                MessageDialogButtons::YesNoCancelCustom(first, second, third) => {
                    assert_eq!((first.as_str(), second.as_str(), third.as_str()), (no, ALLOW, "取消"));
                }
                _ => panic!("要三顆自訂按鈕"),
            }
        }
        assert!(allowed(&R::Custom(ALLOW.into())));
        for r in [R::Custom("先不要".into()), R::Custom("不允許".into()), R::Custom("取消".into()), R::Cancel, R::Ok, R::Yes, R::No] {
            assert!(!allowed(&r), "{r:?}");
        }
        let src = include_str!("input_consent.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains("OkCancelCustom"), "兩顆按鈕的框第一顆會是預設焦點");
        assert!(!code.contains(".show(move"), "要看按了哪一顆，不能只看 true／false");
    }

    /// 接線守門（0.2.15）：打字免問要同時是記住的那把公鑰（Same）且本人按過允許；沒免問就一定先問，按了允許才記下；
    /// 紅條照樣顯示誰在打字、有「結束」
    #[test]
    fn 守門_自己電腦打字免問的條件與紅條() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let start = lib.find("if a.session.scope == view_handshake::Scope::Input {").expect("打字的分支");
        let f = &lib[start..start + lib[start..].find("let mobile = a.mobile;").expect("打字分支後面的下一句")];
        assert!(f.contains("let no_ask = a.tofu == device_id::Tofu::Same && "), "免問一定要是記住的那把公鑰");
        let (ask, confirm) = (f.find("input_consent::ask(").unwrap(), f.find("device_id::live::confirm_input(").unwrap());
        assert!(ask < confirm, "先問、按了允許才記下");
        assert!(f[ask..confirm].contains("continue;"), "不允許就結束，不記");
        let html = include_str!("../../ui/list.html");
        assert!(html.contains("正在這台的夥伴「{{ v.window }}」打字") && html.contains("@click=\"stopBeingViewed(v.id)\">結束</button>"), "紅條有誰在打字、有結束");
    }

    /// 0.2.15：框上寫清楚按允許之後就不再問；還沒在這裡打過字的要提醒名字可能不準；設成每次都問的不說「不再問」
    #[test]
    fn 打字確認框_寫清楚之後不再問_沒打過字的提醒用指紋確認() {
        let mut k = known_d();
        let w = who_of(&k, "d", "家用機", PUB, Tofu::Same);
        assert!(!w.first && !w.typed_before && !w.always_ask);
        let t = ask_text(&w, "小乙");
        assert!(t.contains("還沒在這裡打過字") && t.contains("請用指紋確認"), "{t}");
        assert!(t.contains("這台以後要在這裡打字就不會再問你") && t.contains("設定 → 認得的電腦"), "{t}");
        k.confirm_input("d", PUB);
        let t = ask_text(&who_of(&k, "d", "家用機", PUB, Tofu::Same), "小乙");
        assert!(!t.contains("還沒在這裡打過字"), "按過允許的不再提醒");
        k.set_input_no_ask("d", false);
        let w = who_of(&k, "d", "家用機", PUB, Tofu::Same);
        assert!(w.always_ask);
        assert!(!ask_text(&w, "小乙").contains("不會再問你"), "設成每次都問的不說不再問");
        // 第一次連線：沿用原本那句，不說「名字可能不準」
        let t = ask_text(&who_of(&KnownPeers::default(), "d", "家用機", PUB, Tofu::New), "小乙");
        assert!(t.contains("第一次連線到這裡") && !t.contains("還沒在這裡打過字"));
    }

    #[test]
    fn 同意結果_只有期限前按允許才算() {
        assert!(consent_outcome(Some(true), 99, 100));
        assert!(!consent_outcome(Some(true), 100, 100), "剛好到期不算");
        assert!(!consent_outcome(Some(true), 101, 100));
        assert!(!consent_outcome(None, 0, 100), "沒回答（逾時、被撤回）不算");
        assert!(!consent_outcome(Some(false), 0, 100));
    }

    #[test]
    fn 確認框被按下_逾時或過期後按允許一律不允許_只有按允許才提示() {
        // 期限內
        assert_eq!(click_outcome(true, false, 99, 100), (true, false), "期限內按允許：允許");
        assert_eq!(click_outcome(false, false, 99, 100), (false, false));
        // 已經不等了（逾時）：按允許也不允許，並提示
        assert_eq!(click_outcome(true, true, 50, 100), (false, true), "逾時後按允許：不允許、提示");
        assert_eq!(click_outcome(false, true, 50, 100), (false, false), "逾時後按不允許：不用提示");
        // 剛好到期、過了期限
        assert_eq!(click_outcome(true, false, 100, 100), (false, true));
        assert_eq!(click_outcome(true, false, 10_000, 100), (false, true));
        for now in [100, 101, 500, i64::MAX] {
            for timed_out in [false, true] {
                assert!(!click_outcome(true, timed_out, now, 100).0, "過期後按允許絕不允許：now={now}");
            }
        }
    }

    #[test]
    fn 最多等幾秒_取六十秒和剩餘時間較小的() {
        assert_eq!(wait_secs(0, 1000), ASK_SECS);
        assert_eq!(wait_secs(0, 60), 60);
        assert_eq!(wait_secs(0, 20), 20);
        assert_eq!(wait_secs(100, 100), 0);
        assert_eq!(wait_secs(200, 100), 0, "已過期不能是負的");
        assert_eq!(wait_secs(i64::MIN, i64::MAX), ASK_SECS, "不溢位");
    }

    #[test]
    fn 同時只能開一個確認框_放開前拿不到第二個() {
        static S: ConsentSlot = ConsentSlot::new();
        let g = S.try_take(0, 100).expect("第一次拿得到");
        assert!(S.try_take(10, 200).is_none(), "框還開著，第二個拿不到");
        assert!(S.try_take(99, 200).is_none());
        drop(g);
        let g2 = S.try_take(10, 200).expect("放開之後又拿得到");
        drop(g2);
    }

    #[test]
    fn 確認框的回呼一直沒來_過期加寬限之後位子自動放開_舊的放開不影響新的() {
        static S: ConsentSlot = ConsentSlot::new();
        let expires = 1_000;
        let old = S.try_take(900, expires + SLOT_GRACE_SECS).expect("第一個框");
        assert!(S.try_take(expires, 5_000).is_none(), "剛過期還在寬限內：不開第二個");
        assert!(S.try_take(expires + SLOT_GRACE_SECS - 1, 5_000).is_none());
        let new = S.try_take(expires + SLOT_GRACE_SECS, 5_000).expect("過了寬限：就算舊框的回呼沒來也放開");
        drop(old);
        assert!(S.try_take(2_000, 9_000).is_none(), "舊框後來才關：不能把新框的位子放掉");
        drop(new);
        assert!(S.try_take(2_000, 9_000).is_some(), "新框關了才放開");
        assert!(SLOT_GRACE_SECS >= 60);
    }

    /// 接線守門：ask 先佔位子、位子在回呼裡才放、逾時後才按會通知；poller 在 accept 之前重查期限與是否還在等
    #[test]
    fn 守門_確認框佔位子_逾時後按會通知_接受之前重查() {
        let me = include_str!("input_consent.rs").replace("\r\n", "\n");
        let code = me.split("#[cfg(test)]").next().unwrap();
        let ask = &code[code.find("pub async fn ask(").expect("有 ask")..];
        let (take, show) = (ask.find("SLOT.try_take(now_s(), expires_s.saturating_add(SLOT_GRACE_SECS))").expect("ask 要先佔位子，放開時間＝期限加寬限"), ask.find("show_with_result(").unwrap());
        assert!(take < show, "先佔位子才開框");
        let cb = &ask[show..ask.find("let answer =").unwrap()];
        assert!(cb.contains("let _slot = slot;"), "位子要在回呼裡才放開");
        assert!(cb.contains("emit_to(\"list\", EV_EXPIRED"), "逾時後才按要通知本人");
        assert!(cb.contains("click_outcome(allowed(&r), cb_timed_out.load(Ordering::SeqCst), now_s(), deadline_s)") && cb.contains("tx.send(allow)"), "回呼的判斷走 click_outcome");
        assert!(ask[..show].contains("emit_to(\"list\", EV_BUSY"), "前一個框還開著要通知本人");
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let f = lib.split("fn start_view_poller(").nth(1).expect("有 start_view_poller").split("\n}\n").next().unwrap();
        let accept = f.find("\"term_view_accept\"").expect("有 accept");
        for needle in ["input_consent::consent_outcome(", "view_still_pending("] {
            let at = f.find(needle).unwrap_or_else(|| panic!("poller 要呼叫 {needle}"));
            assert!(at < accept, "{needle} 要在 term_view_accept 之前");
        }
    }

    #[test]
    fn 允許替這台登入的確認框_有名字與指紋前八碼_寫清楚能做什麼() {
        let t = login_ok_text("我的手機", PUB);
        let fp8: String = fingerprint(PUB).chars().take(8).collect();
        assert!(t.starts_with(&format!("「我的手機」（指紋 {fp8}）")), "{t}");
        assert!(t.contains("可以讓這台電腦登入 Codex 等帳號"));
        assert!(login_ok_text("", PUB).starts_with("這支手機（指紋 "));
    }

    /// 接線守門：打開「允許替這台登入」一定先問本人（確認框），按允許才寫入；關掉不用問
    #[test]
    fn 守門_勾允許替這台登入要先過確認框() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let start = lib.find("async fn device_known_login_ok(").expect("設定頁的命令");
        let f = &lib[start..start + lib[start..].find("\n}\n").unwrap()];
        let (ask, set) = (f.find("input_consent::ask_login_ok(").expect("要先問"), f.find("device_id::live::set_login_ok(").unwrap());
        assert!(ask < set, "先問本人才寫入");
        assert!(f.contains("if on {"), "只有打開時要問");
    }

    #[test]
    fn 同意框的話_寫清楚可以回答權限框() {
        let t = ask_text(&who_of(&known_d(), "d", "家用機", PUB, Tofu::Same), "小乙");
        assert!(t.contains("「家用機」（指紋 "), "{t}");
        assert!(t.contains("要在這台的「小乙」打字"));
        assert!(t.contains("包括回答權限框"));
        let blank = Who { name: String::new(), fp8: "01234567".into(), first: true, typed_before: false, always_ask: false };
        assert!(ask_text(&blank, "小乙").starts_with("另一台電腦"));
    }

    #[test]
    fn 已記住的電腦_框上用本機記住的名字_不用後台這次給的() {
        let w = who_of(&known_d(), "d", "假裝是工作機", PUB, Tofu::Same);
        assert_eq!((w.name.as_str(), w.first), ("家用機", false));
        let t = ask_text(&w, "小乙");
        assert!(t.contains("「家用機」"));
        assert!(!t.contains("假裝是工作機"), "後台給的名字不能出現在框上");
        assert!(!t.contains("第一次連線"));
    }

    #[test]
    fn 第一次連線_才用後台給的名字並標示() {
        let w = who_of(&KnownPeers::default(), "d", "工作機", PUB, Tofu::New);
        assert_eq!((w.name.as_str(), w.first), ("工作機", true));
        let t = ask_text(&w, "小乙");
        assert!(t.contains("「工作機」"));
        assert!(t.contains("第一次連線"));
        // 本機雖然有紀錄，但比對結果不是 Same（例如呼叫端剛記住）也當第一次，不偷用別的名字
        assert!(who_of(&known_d(), "d", "工作機", PUB, Tofu::New).first);
    }

    #[test]
    fn 框上有設備指紋前8碼_和設定頁對得上() {
        let w = who_of(&known_d(), "d", "", PUB, Tofu::Same);
        assert_eq!(w.fp8, fingerprint(PUB)[..8].to_string());
        assert_eq!(w.fp8.chars().count(), 8);
        assert!(ask_text(&w, "小乙").contains(&format!("（指紋 {}）", w.fp8)));
    }

    #[test]
    fn 名字去掉控制字元_截長度() {
        let w = who_of(&KnownPeers::default(), "d", "壞\u{202e}名\n字", PUB, Tofu::New);
        assert!(!w.name.contains('\u{202e}') && !w.name.contains('\n'), "{:?}", w.name);
        let long = who_of(&KnownPeers::default(), "d", &"長".repeat(100), PUB, Tofu::New);
        assert_eq!(long.name.chars().count(), NAME_MAX);
        assert!(!ask_text(&w, "小\u{202e}乙").contains('\u{202e}'), "視窗名也清掉");
        for c in ['\u{200b}', '\u{200c}', '\u{200d}', '\u{feff}', '\u{2028}', '\u{2029}'] {
            let n = who_of(&KnownPeers::default(), "d", &format!("家{c}用機"), PUB, Tofu::New).name;
            assert!(!n.contains(c), "{:?} 要去掉：{n:?}", c);
        }
    }

    #[test]
    fn 紅條上的誰_用本機記住的名字和指紋_第一次連線標示() {
        let same = who_of(&known_d(), "d", "假裝是工作機", PUB, Tofu::Same);
        let t = bar_label(&same);
        assert_eq!(t, format!("家用機（指紋 {}）", same.fp8));
        assert!(!t.contains("假裝是工作機"));
        let first = bar_label(&who_of(&KnownPeers::default(), "d", "工作機", PUB, Tofu::New));
        assert!(first.starts_with("工作機（指紋 ") && first.ends_with("，第一次連線）"), "{first}");
        assert!(bar_label(&Who { name: String::new(), fp8: "01234567".into(), first: false, typed_before: false, always_ask: false }).starts_with("另一台電腦"));
    }

    #[test]
    fn 守門_紅條和同意框的誰都不直接用後台給的名字() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let f = lib.split("fn start_view_poller(").nth(1).expect("有 start_view_poller").split("\n}\n").next().unwrap();
        assert!(!f.contains(concat!("row.get(\"from", "_name\")")), "不能直接從後台的列拿名字");
        let who = f.find("let who = input_consent::bar_label(&asker);").expect("紅條的誰要用 bar_label");
        let asker = f.find("let asker = input_consent::who_of(").expect("要用 who_of 組");
        assert!(asker < who, "先組 who_of 再給紅條");
        assert!(f.contains("input_consent::ask(&app, &asker,"), "同意框也用同一個 who_of");
    }

    #[test]
    fn 守門_只有收到請求時能問_沒有畫面命令能回報允許() {
        let me = include_str!("input_consent.rs");
        let code = me.split("\nmod tests {").next().unwrap();
        assert!(!code.contains(concat!("#[tauri", "::command]")), "這裡不能有畫面命令");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut callers = Vec::new();
        for e in walk(&dir) {
            if e.ends_with("input_consent.rs") {
                continue;
            }
            let src = std::fs::read_to_string(&e).unwrap().replace("\r\n", "\n");
            let code = src.split("\nmod tests {").next().unwrap();
            for (i, _) in code.match_indices(concat!("input_consent", "::ask(")) {
                let before = &code[..i];
                let f = before.rfind("\nasync fn ").max(before.rfind("\nfn ")).expect("在函式裡");
                let name: String = before[f..].trim_start_matches('\n').trim_start_matches("async ").trim_start_matches("fn ").chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                callers.push(name);
            }
        }
        assert_eq!(callers, vec!["start_view_poller".to_string()], "只有收到別台的請求時能問");
    }

    fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
        out
    }
}
