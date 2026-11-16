//! 視窗開不起來、喚醒或交接逾時的時候，依「讀畫面」讀到的結果把原因講清楚（#1632）。
//!
//! 原則：安全上的同意（信任資料夾、略過權限模式的同意）一律由本人在 Claude 自己的畫面上按。
//! ASN 不代按、不寫設定鍵、不送任何按鍵；只負責告訴本人「它卡在哪、要到 ASN 打開這個夥伴的終端自己選」。
//!
//! 畫面代號來自背景讀畫面（term.rs 的 `partner_notices`，代號定義在 claude_screen.rs 的 `status_code`），
//! 這裡只認 `trust` 與 `bypass_warning`；讀不到畫面、或是別的代號，呼叫端照原本的說法。
//! 前端的小字（ui/lib/term-entry.mjs）與這裡的句子用同一組選項字樣，test/term-entry.test.mjs 有跨語言的一致性測試。

/// 第一次問「是否信任這個資料夾」的畫面代號
pub(crate) const CODE_TRUST: &str = "trust";
/// 第一次問是否同意略過權限模式的畫面代號
pub(crate) const CODE_BYPASS: &str = "bypass_warning";

/// 信任資料夾要選的那一項（Claude 畫面上的字）
pub(crate) const TRUST_YES: &str = "Yes, I trust this folder";
/// 略過權限模式：同意與不同意的兩項
pub(crate) const BYPASS_YES: &str = "Yes, I accept";
pub(crate) const BYPASS_NO: &str = "No, exit";

/// 卡在信任資料夾的說明
pub(crate) fn trust_message(name: &str) -> String {
    format!("「{name}」卡在 Claude 第一次問「是否信任這個資料夾」。請到 ASN 打開這個夥伴的終端，選「{TRUST_YES}」。")
}

/// 卡在略過權限模式同意的說明
pub(crate) fn bypass_message(name: &str) -> String {
    format!("「{name}」卡在 Claude 第一次問是否同意略過權限模式。請到 ASN 打開這個夥伴的終端，看清楚警告後自己選「{BYPASS_YES}」；不同意就選「{BYPASS_NO}」。")
}

/// 依畫面代號回對應的說明；不是這兩種代號（或沒讀到）回 None
pub(crate) fn message_for(name: &str, code: Option<&str>) -> Option<String> {
    match code {
        Some(CODE_TRUST) => Some(trust_message(name)),
        Some(CODE_BYPASS) => Some(bypass_message(name)),
        _ => None,
    }
}

/// 逾時訊息：讀到卡在這兩種畫面就換成對應的說明，其餘維持 `fallback`
pub(crate) fn with_screen(name: &str, code: Option<&str>, fallback: &str) -> String {
    message_for(name, code).unwrap_or_else(|| fallback.to_string())
}

/// 讀畫面目前對這個名字的判斷（只取這兩種代號）。視窗版電腦端才有背景讀畫面；其他版本或沒讀到一律 None。
/// 只讀背景工作已經判斷好的結果（記憶體裡的固定代號），不在這裡讀畫面
pub(crate) fn current_code(name: &str) -> Option<&'static str> {
    #[cfg(all(desktop, feature = "gui"))]
    {
        super::term::partner_notices().into_iter().find(|n| n.name == name && (n.code == CODE_TRUST || n.code == CODE_BYPASS)).map(|n| n.code)
    }
    #[cfg(not(all(desktop, feature = "gui")))]
    {
        let _ = name;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 信任資料夾與略過權限各回對應的句子() {
        let t = message_for("小乙", Some("trust")).unwrap();
        assert_eq!(t, "「小乙」卡在 Claude 第一次問「是否信任這個資料夾」。請到 ASN 打開這個夥伴的終端，選「Yes, I trust this folder」。");
        let b = message_for("小乙", Some("bypass_warning")).unwrap();
        assert_eq!(b, "「小乙」卡在 Claude 第一次問是否同意略過權限模式。請到 ASN 打開這個夥伴的終端，看清楚警告後自己選「Yes, I accept」；不同意就選「No, exit」。");
    }

    #[test]
    fn 讀不到畫面或別的代號維持原本的說法() {
        for code in [None, Some("permission"), Some("login"), Some("")] {
            assert_eq!(message_for("小乙", code), None);
            assert_eq!(with_screen("小乙", code, "原句"), "原句");
        }
        assert_ne!(with_screen("小乙", Some("trust"), "原句"), "原句");
    }

    #[test]
    fn 句子不叫人按_enter_也不說代按() {
        for s in [trust_message("a"), bypass_message("a")] {
            assert!(!s.contains("Enter"), "{s}");
            assert!(s.contains("自己") || s.contains("選「"), "{s}");
        }
    }

    #[test]
    fn 畫面代號跟_claude_screen_的固定代號一致() {
        use crate::launch::claude_screen::{status_code, ClaudeScreenKind as K};
        assert_eq!(status_code(K::TrustFolder), CODE_TRUST);
        assert_eq!(status_code(K::BypassWarning), CODE_BYPASS);
    }
}
