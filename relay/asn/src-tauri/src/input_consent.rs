//! 別台要在這台打字：紅條上的「誰」（名字＋指紋）與「允許替這台登入」的確認框。
//!
//! 0.2.33 起（#1745）遠端打字不再跳確認框：同一個帳號底下的設備預設直接可以打；要擋，本人在這台設定頁關掉「允許遠端在這台打字」
//! （bridge.json 的 `remote_input_off`），別台一要打字就馬上被拒（結束原因 `input_off`），進行中的打字也會結束。
//! 握手的驗章、公鑰比對（TOFU）、金鑰變了的處理都照舊（見 view_stream.rs 的 accept_request_with）。
//!
//! - 這裡只剩兩樣：紅條與連線紀錄用的「誰」（[`who_of`]、[`bar_label`]），和設定頁勾「允許這支手機替這台登入」之前的確認框（[`ask_login_ok`]）。
//! - **框與紅條上的名字用後台現在給的設備名，並接上本機算出的指紋：** 名字不可信，像指紋的當沒有名字（寫辨認線索，見 [`crate::device_id::unnamed_clue`]），讓本人用指紋核對。
use crate::device_id::{fingerprint, fp_grouped, KnownPeers, Tofu};
use tauri::AppHandle;

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
    /// 完整指紋（16 碼、每 4 碼一組）：名字是空的時候改顯示這個，本人才有東西可以核對
    pub fp_full: String,
    /// 本機還沒記住這台（第一次連線）：名字是後台給的
    pub first: bool,
    /// 節點代號：名字空白時用來寫辨認線索「電腦（代號末 4 碼）」（#1882）
    pub node: String,
}

/// 去掉控制字元與改變文字方向的字元，截長度
fn clean(s: &str, max: usize) -> String {
    let bad = |c: char| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}');
    s.chars().map(|c| if bad(c) { ' ' } else { c }).collect::<String>().trim().chars().take(max).collect()
}

/// 框上要顯示的「誰」：名字一律是後台的設備名（#1388：每台只有一個名字）。這次請求帶的就是後台現在的名字，優先用它；
/// 沒帶才用本機最近一次記下的。和本機記住的公鑰不一樣（第一次）就標示第一次連線。
/// 名字不可信：像指紋或含「指紋」的名字當成沒有名字（顯示「未命名的電腦」＋完整指紋），名字後面一律接指紋
pub fn who_of(known: &KnownPeers, node: &str, backend_name: &str, sign_pub: &str, tofu: Tofu) -> Who {
    let local = if tofu == Tofu::Same { known.peer(node).map(|p| p.name.as_str()) } else { None };
    let raw = if backend_name.trim().is_empty() { local.unwrap_or("") } else { backend_name };
    let name = clean(raw, NAME_MAX);
    Who {
        name: if crate::device_id::display_name_ok(&name) { name } else { String::new() },
        fp8: fingerprint(sign_pub).chars().take(8).collect(),
        fp_full: fp_grouped(sign_pub),
        first: local.is_none(),
        node: node.to_string(),
    }
}

/// 框與紅條上的「名字、指紋」：有名字用名字＋前 8 碼；沒有名字寫辨認線索「電腦（代號末 4 碼）」（和介面同一套，#1882）＋完整分組指紋
fn head_of(who: &Who) -> (String, &str, bool) {
    if who.name.is_empty() {
        (crate::device_id::unnamed_clue(&who.node, false), who.fp_full.as_str(), false)
    } else {
        (who.name.clone(), who.fp8.as_str(), true)
    }
}

/// 紅條（有人在看／在打字）上的「誰」：名字＋指紋前 8 碼，第一次連線另外標示。畫面會在外面加「」
pub fn bar_label(who: &Who) -> String {
    let (name, fp, _) = head_of(who);
    let first = if who.first { "，第一次連線" } else { "" };
    format!("{name}（指紋 {fp}{first}）")
}

/// #933：本人在設定頁勾「允許這支手機替這台登入」之前的確認框文字：名字＋指紋前 8 碼（和紅條同一種），寫清楚勾了能做什麼
pub fn login_ok_text(name: &str, node: &str, sign_pub: &str) -> String {
    let name = clean(name, NAME_MAX);
    // 名字空白寫辨認線索「手機（代號末 4 碼）」，和介面同一套（#1882）
    let name = if name.is_empty() { format!("「{}」", crate::device_id::unnamed_clue(node, true)) } else { format!("「{name}」") };
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
pub async fn ask_login_ok(app: &AppHandle, name: &str, node: &str, sign_pub: &str) -> bool {
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
        .message(login_ok_text(name, node, sign_pub))
        .title("ASN：允許手機替這台登入")
        .kind(MessageDialogKind::Warning)
        .buttons(buttons("先不要"))
        .show_with_result(move |r| {
            let _ = tx.send(allowed(&r));
        });
    matches!(tokio::time::timeout(std::time::Duration::from_secs(ASK_SECS), rx).await, Ok(Ok(true)))
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

    #[test]
    fn 允許替這台登入的確認框_有名字與指紋前八碼_寫清楚能做什麼() {
        let t = login_ok_text("我的手機", "n-q9z8", PUB);
        let fp8: String = fingerprint(PUB).chars().take(8).collect();
        assert!(t.starts_with(&format!("「我的手機」（指紋 {fp8}）")), "{t}");
        assert!(t.contains("可以讓這台電腦登入 Codex 等帳號"));
        assert!(login_ok_text("", "n-q9z8", PUB).starts_with("「手機（Q9Z8）」（指紋 "));
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
    fn 已記住的電腦_框上用後台現在的設備名_沒帶才用本機記下的_像指紋的當未命名() {
        // #1388：每台只有一個名字（後台），本人在任一台改名後這裡就跟著換；辨識靠後面的指紋
        let w = who_of(&known_d(), "d", "改過名的工作機", PUB, Tofu::Same);
        assert_eq!((w.name.as_str(), w.first), ("改過名的工作機", false));
        let t = bar_label(&w);
        assert!(t.starts_with("改過名的工作機（指紋 "), "{t}");
        assert!(!t.contains("第一次連線"));
        assert_eq!(who_of(&known_d(), "d", "  ", PUB, Tofu::Same).name, "家用機", "請求沒帶名字：用本機記下的");
        for fake in ["工作機 a93cc519", "假的指紋", "工作機（a93c c519）"] {
            let w = who_of(&known_d(), "d", fake, PUB, Tofu::Same);
            assert_eq!(w.name, "", "{fake}");
            assert!(bar_label(&w).starts_with("電腦（D）（指紋 "), "{fake}");
        }
    }

    #[test]
    fn 第一次連線_才用後台給的名字並標示() {
        let w = who_of(&KnownPeers::default(), "d", "工作機", PUB, Tofu::New);
        assert_eq!((w.name.as_str(), w.first), ("工作機", true));
        let t = bar_label(&w);
        assert!(t.starts_with("工作機（指紋 "));
        assert!(t.contains("第一次連線"));
        // 本機雖然有紀錄，但比對結果不是 Same（例如呼叫端剛記住）也當第一次，不偷用別的名字
        assert!(who_of(&known_d(), "d", "工作機", PUB, Tofu::New).first);
    }

    #[test]
    fn 框上有設備指紋前8碼_和設定頁對得上() {
        let w = who_of(&known_d(), "d", "", PUB, Tofu::Same);
        assert_eq!(w.fp8, fingerprint(PUB)[..8].to_string());
        assert_eq!(w.fp8.chars().count(), 8);
        assert!(bar_label(&w).contains(&format!("（指紋 {}", w.fp8)));
    }

    #[test]
    fn 名字去掉控制字元_截長度() {
        let w = who_of(&KnownPeers::default(), "d", "壞\u{202e}名\n字", PUB, Tofu::New);
        assert!(!w.name.contains('\u{202e}') && !w.name.contains('\n'), "{:?}", w.name);
        let long = who_of(&KnownPeers::default(), "d", &"長".repeat(100), PUB, Tofu::New);
        assert_eq!(long.name.chars().count(), NAME_MAX);
        for c in ['\u{200b}', '\u{200c}', '\u{200d}', '\u{feff}', '\u{2028}', '\u{2029}'] {
            let n = who_of(&KnownPeers::default(), "d", &format!("家{c}用機"), PUB, Tofu::New).name;
            assert!(!n.contains(c), "{:?} 要去掉：{n:?}", c);
        }
    }

    #[test]
    fn 辨認線索_和介面同一套寫法_末四碼大寫_沒代號只寫種類() {
        use crate::device_id::unnamed_clue;
        assert_eq!(unnamed_clue("xisu7k2m", false), "電腦（7K2M）");
        assert_eq!(unnamed_clue("n-q9z8", true), "手機（Q9Z8）");
        assert_eq!(unnamed_clue("ab", false), "電腦（AB）");
        assert_eq!(unnamed_clue("--", false), "電腦");
    }

    #[test]
    fn 紅條上的誰_設備名和指紋_第一次連線標示() {
        let same = who_of(&known_d(), "d", "工作機", PUB, Tofu::Same);
        let t = bar_label(&same);
        assert_eq!(t, format!("工作機（指紋 {}）", same.fp8));
        let first = bar_label(&who_of(&KnownPeers::default(), "d", "工作機", PUB, Tofu::New));
        assert!(first.starts_with("工作機（指紋 ") && first.ends_with("，第一次連線）"), "{first}");
        assert_eq!(bar_label(&Who { name: String::new(), fp8: "01234567".into(), fp_full: "0123 4567 89ab cdef".into(), first: false, node: "n-x7k2".into() }), "電腦（X7K2）（指紋 0123 4567 89ab cdef）");
    }

    #[test]
    fn 守門_紅條的誰不直接用後台給的名字() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let f = lib.split("fn start_view_poller(").nth(1).expect("有 start_view_poller").split("\n}\n").next().unwrap();
        assert!(!f.contains(concat!("row.get(\"from", "_name\")")), "不能直接從後台的列拿名字");
        let who = f.find("let who = input_consent::bar_label(&asker);").expect("紅條的誰要用 bar_label");
        let asker = f.find("let asker = input_consent::who_of(").expect("要用 who_of 組");
        assert!(asker < who, "先組 who_of 再給紅條");
        assert!(!f.contains("input_consent::ask("), "遠端打字不再有確認框（#1745）");
    }
}
