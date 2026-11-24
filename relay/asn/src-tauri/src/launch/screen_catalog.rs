//! 夥伴卡住的畫面種類清單：全程式只有這一份（#1813）。
//!
//! 以前「畫面種類 → 固定代號」（`claude_screen::status_code`）、名單上的說明（`bridge::roster`）、
//! 電腦版的提醒文字（`ui/lib/partner-notice.mjs`）各寫一份，新增一種畫面要補三處，漏一處就是「卡著沒人知道」（#1792）。
//! 現在三處都從這裡查：
//! - 代號：`code_of(kind)`（`status_code` 直接呼叫它）
//! - 名單上的說明：`label_of(code)`
//! - 提醒與終端畫面上的一行提示：產出 `ui/lib/stuck-screens.mjs`（前端不能呼叫 Rust 的同步函式，
//!   而且網頁與手機版也要能用，所以由本檔的測試產出一份進版控的檔案；內容不一致測試就紅）
//!
//! 新增一種畫面：在 `ClaudeScreenKind` 加變體，再在 `SCREEN_CATALOG` 加一列，然後執行
//! `ASN_REGEN_SCREENS=1 cargo test --lib screen_catalog` 重產前端檔案。其他地方不用、也不准再寫清單。

#![cfg_attr(not(test), allow(dead_code))]

use super::claude_screen::ClaudeScreenKind as K;

/// 一種畫面的完整說明
pub(crate) struct ScreenEntry {
    pub kind: K,
    /// 寫進狀態檔、傳給前端的固定代號（不含畫面文字）
    pub code: &'static str,
    /// 名單上顯示的說明。名單別人也可能看到，所以只能是固定的白話
    pub label: &'static str,
    /// 電腦版的提醒（標題、內文；內文的 `{name}` 換成夥伴名）；沒有就不跳提醒（只寫 ui.log）
    pub notice: Option<(&'static str, &'static str)>,
    /// 終端畫面開著時的一行提示；沒有就不顯示
    pub hint: Option<&'static str>,
}

pub(crate) const SCREEN_CATALOG: [ScreenEntry; 10] = [
    ScreenEntry {
        kind: K::Permission,
        code: "permission",
        label: "等你回答：權限",
        notice: Some(("夥伴在等你回答", "「{name}」在等你同意一項操作，請到它的視窗確認。")),
        hint: Some("它在等你同意一項操作：直接在下面的畫面按數字鍵回答。"),
    },
    ScreenEntry {
        kind: K::TrustFolder,
        code: "trust",
        label: "等你回答：信任資料夾",
        notice: Some(("夥伴在等你回答", "「{name}」在問要不要信任這個資料夾，請到它的視窗確認。")),
        hint: Some("它在問要不要信任這個資料夾：直接在下面的畫面回答。"),
    },
    ScreenEntry {
        kind: K::BypassWarning,
        code: "bypass_warning",
        label: "卡在略過權限警告",
        notice: Some(("夥伴在等你確認", "「{name}」第一次開啟，要你同意它的權限設定，請到它的視窗確認。")),
        hint: Some("它在等你確認權限設定：直接在下面的畫面回答。"),
    },
    ScreenEntry {
        kind: K::Login,
        code: "login",
        label: "需要登入",
        notice: Some(("夥伴需要登入", "「{name}」需要登入才能繼續，請到它的視窗登入。")),
        hint: None,
    },
    ScreenEntry {
        kind: K::UsageLimit,
        code: "usage_limit",
        label: "額度用完",
        notice: Some(("夥伴的額度用完了", "「{name}」的額度用完了，要等額度恢復才能繼續。")),
        hint: None,
    },
    ScreenEntry {
        kind: K::UsageMenu,
        code: "usage_menu",
        label: "額度用完：等你選",
        notice: Some(("夥伴的額度用完了", "「{name}」的額度用完了，在問接下來要怎麼做。手機上可以選「停下來等」或「在這裡等」，付費的選項請到它的視窗選。")),
        hint: Some("它的額度用完了，在問接下來要怎麼做：直接在下面的畫面選。"),
    },
    ScreenEntry {
        kind: K::Question,
        code: "question",
        label: "等你回答：問題",
        notice: Some(("夥伴在問你問題", "「{name}」在等你選一個答案，請到它的視窗回答。")),
        hint: None,
    },
    ScreenEntry {
        kind: K::QuestionView,
        code: "question_view",
        label: "等你回答：問題",
        notice: Some(("夥伴在問你問題", "「{name}」在等你選答案，請到它的視窗回答。")),
        hint: None,
    },
    // 認不得種類的選單（#1799）：名單標「需要人工確認」，但不跳提醒、不給終端提示，只寫 ui.log
    ScreenEntry { kind: K::Attention, code: "attention", label: "需要人工確認", notice: None, hint: None },
    ScreenEntry {
        kind: K::HeldMessage,
        code: "held_message",
        label: "等你確認：外來訊息",
        notice: Some(("夥伴收到外來訊息", "「{name}」收到一則外來訊息，等你決定要不要放行。")),
        hint: Some("它收到一則外來訊息，在等你決定要不要放行：請用跳出的提示框，或到它自己的終端視窗處理；這裡打的字不會送出。"),
    },
];

/// 這個種類的固定代號（每個種類都在清單裡；少一列由 `每個畫面種類都在清單裡` 測試擋住）
pub(crate) fn code_of(kind: K) -> &'static str {
    SCREEN_CATALOG.iter().find(|e| e.kind == kind).map_or("unknown", |e| e.code)
}

/// 代號 → 名單顯示的說明；不認得的代號回 None（檔案裡的其他內容一律不顯示）
pub(crate) fn label_of(code: &str) -> Option<&'static str> {
    SCREEN_CATALOG.iter().find(|e| e.code == code).map(|e| e.label)
}

/// 前端檔案 `ui/lib/stuck-screens.mjs` 應有的內容（由清單產出）
pub(crate) fn render_frontend_module() -> String {
    let q = |s: &str| serde_json::to_string(s).expect("字串可轉 JSON");
    let opt = |s: Option<&str>| s.map_or("null".to_string(), q);
    let mut out = String::from(
        "// 此檔由 src-tauri/src/launch/screen_catalog.rs 產出，不要手改（#1813）。\n\
         // 新增或修改畫面種類：改 Rust 的清單，再執行 ASN_REGEN_SCREENS=1 cargo test --lib screen_catalog 重產；\n\
         // 不一致時 Rust 測試會紅。內文的 {name} 換成夥伴名。\n\
         export const STUCK_SCREENS = [\n",
    );
    for e in &SCREEN_CATALOG {
        let notice = e.notice.map_or("null".to_string(), |(t, b)| format!("{{ title: {}, body: {} }}", q(t), q(b)));
        out.push_str(&format!("  {{ code: {}, label: {}, notice: {}, hint: {} }},\n", q(e.code), q(e.label), notice, opt(e.hint)));
    }
    out.push_str("]\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRONTEND_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../ui/lib/stuck-screens.mjs");

    #[test]
    fn 每個畫面種類都在清單裡_代號不重複() {
        // 不用 enum 窮舉巨集：逐一列出所有變體；新增變體卻沒進清單，這裡的 match 編譯就會失敗
        let all = [K::Permission, K::TrustFolder, K::BypassWarning, K::Login, K::UsageLimit, K::UsageMenu, K::Question, K::QuestionView, K::Attention, K::HeldMessage];
        for k in all {
            match k {
                K::Permission | K::TrustFolder | K::BypassWarning | K::Login | K::UsageLimit | K::UsageMenu | K::Question | K::QuestionView | K::Attention | K::HeldMessage => {}
            }
            assert_eq!(SCREEN_CATALOG.iter().filter(|e| e.kind == k).count(), 1, "{k:?} 要剛好一列");
        }
        assert_eq!(all.len(), SCREEN_CATALOG.len());
        let mut codes: Vec<_> = SCREEN_CATALOG.iter().map(|e| e.code).collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), SCREEN_CATALOG.len(), "代號不能重複");
    }

    #[test]
    fn 給人看的字是白話_不秀內部代號與英文代稱() {
        for e in &SCREEN_CATALOG {
            let mut texts = vec![e.label];
            texts.extend(e.notice.iter().flat_map(|(t, b)| [*t, *b]));
            texts.extend(e.hint);
            for t in texts {
                assert!(t.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)), "{t}");
                assert!(!t.contains('_') && !t.contains("HTTP"), "不能秀內部代號：{t}");
            }
            if let Some((_, body)) = e.notice {
                assert!(body.contains("{name}"), "提醒要說是哪位夥伴：{}", e.code);
            }
        }
    }

    #[test]
    fn 前端清單檔和_rust_清單一致() {
        let want = render_frontend_module();
        if std::env::var("ASN_REGEN_SCREENS").is_ok() {
            std::fs::write(FRONTEND_FILE, &want).expect("寫得出前端清單檔");
        }
        let got = std::fs::read_to_string(FRONTEND_FILE).expect("前端清單檔存在").replace("\r\n", "\n");
        assert_eq!(got, want, "ui/lib/stuck-screens.mjs 和 Rust 清單不一致：執行 ASN_REGEN_SCREENS=1 cargo test --lib screen_catalog 重產");
    }
}
