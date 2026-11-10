//! 別台要在這台打字（0.2.10）：問被打字這台的本人。
//!
//! - **同意框是 ASN 的視窗（系統對話框），不在終端裡：** 終端裡的提示可能被當成按鍵答掉。問之前先把 ASN 叫到前面。
//! - [`ASK_SECS`] 秒沒按當不允許；按了「不允許」、關掉框也是不允許。
//! - **結果只在 Rust 裡用，沒有任何畫面命令能回報「允許」**（守門測試）；只有 lib.rs 的 `start_view_poller` 能叫 [`ask`]。
//! - 本人可以在這台的設定頁「認得的電腦」對某一台設「打字不用每次問我」，那台就不跳這個框（判斷在呼叫端，存在本機）。
//! - **框上的名字用本機記住的（[`who_of`]），不用後台這次給的：** 後台給的名字不在簽章裡。只有第一次連線（本機還沒記住）才用後台給的，並在框上標示「第一次連線」；另外附設備指紋前 8 碼讓本人比對設定頁。
use crate::device_id::{fingerprint, KnownPeers, Tofu};
use tauri::{AppHandle, Manager};

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
}

/// 去掉控制字元與改變文字方向的字元，截長度
fn clean(s: &str, max: usize) -> String {
    let bad = |c: char| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}');
    s.chars().map(|c| if bad(c) { ' ' } else { c }).collect::<String>().trim().chars().take(max).collect()
}

/// 框上要顯示的「誰」：和本機記住的一樣（Same）就用本機記住的名字；其他情況（第一次）才用後台給的，並標示第一次連線
pub fn who_of(known: &KnownPeers, node: &str, backend_name: &str, sign_pub: &str, tofu: Tofu) -> Who {
    let local = if tofu == Tofu::Same { known.peer(node).map(|p| p.name.as_str()) } else { None };
    Who { name: clean(local.unwrap_or(backend_name), NAME_MAX), fp8: fingerprint(sign_pub).chars().take(8).collect(), first: local.is_none() }
}

/// 同意框的話：誰（名字＋指紋）、哪個視窗、能做什麼
pub fn ask_text(who: &Who, window: &str) -> String {
    let name = if who.name.is_empty() { "另一台電腦".to_string() } else { format!("「{}」", who.name) };
    let window = clean(window, 64);
    let first = if who.first { "\n\n這台電腦是第一次連線到這裡，請確認是你自己的電腦。" } else { "" };
    format!("{name}（指紋 {}）要在這台的「{window}」打字。{first}\n\n允許之後，對方可以在這個視窗打任何字，包括回答權限框。最多 10 分鐘，2 分鐘沒打字就自動結束；你隨時可以在 ASN 按「結束」。\n\n要允許嗎？", who.fp8)
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

/// 勾「允許替這台登入」前問本人。允許回 true；取消、關掉、逾時都回 false
pub async fn ask_login_ok(app: &AppHandle, name: &str, sign_pub: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(login_ok_text(name, sign_pub))
        .title("ASN：允許手機替這台登入")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("允許".into(), "取消".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    matches!(tokio::time::timeout(std::time::Duration::from_secs(ASK_SECS), rx).await, Ok(Ok(true)))
}

/// 問本人。允許回 true；不允許、關掉、逾時都回 false
pub async fn ask(app: &AppHandle, who: &Who, window: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(ask_text(who, window))
        .title("ASN：別台要在這台打字")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("允許".into(), "不允許".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
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
        let blank = Who { name: String::new(), fp8: "01234567".into(), first: true };
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
        assert!(bar_label(&Who { name: String::new(), fp8: "01234567".into(), first: false }).starts_with("另一台電腦"));
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
