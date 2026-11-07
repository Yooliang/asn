//! 系統通知的判斷（#848）：不回信、不計時的信。規則與 relay/asn/ui/lib/notice.mjs、relay/machine/system-notice.mjs 一致，改動要一起改。
//! 一律先看信件類別 kind（`notice:` 開頭）；沒有 kind 時才退回舊的寄件名規則（「ASN 通知」或結尾「收發室」）與內文開頭 `[收發室]`，
//! 而且舊規則只對截止時間以前的信有效。

use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
use regex::Regex;
use std::sync::OnceLock;

pub const NOTICE_SENDER: &str = "ASN 通知";
pub const NOTICE_KIND_PREFIX: &str = "notice:";
pub const LEGACY_NOTICE_SUFFIX: &str = "收發室";
pub const LEGACY_BODY_PREFIX: &str = "[收發室]";

/// 舊寄件名／內文標記的相容截止時間（毫秒）。之後會設成 PR-C（後台改用新寄件人與 kind）上線的日期：
/// 寄出時間在這個時間以後、又沒有 notice 類別的信，不再用舊規則當系統通知（這些寄件名是保留給系統通知的）。
/// None＝還沒決定日期，舊規則對所有信都有效（和目前行為一致）。
pub const LEGACY_NOTICE_UNTIL_MS: Option<u64> = None;

/// 舊規則對這封信是否仍有效：沒設截止＝一律有效；設了就要有寄出時間且早於截止（沒有寄出時間＝無效）
pub fn legacy_applies(sent_ms: Option<u64>, until: Option<u64>) -> bool {
    match until {
        None => true,
        Some(cut) => sent_ms.is_some_and(|t| t < cut),
    }
}

/// 寄件名保留字檢查用的正規化（和後台、UI 同一套；共用案例在 supabase/functions/_shared/reserved_sender_cases.json）：
/// NFKD → 去掉控制／格式／空白／組合記號／標點／符號 → 轉小寫 → 長得像的外國字母與日文、簡體字形對照 → NFKC
pub fn fold_name(name: &str) -> String {
    static IGNORED: OnceLock<Regex> = OnceLock::new();
    let re = IGNORED.get_or_init(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{M}\p{P}\p{S}\s]").expect("固定的正規式"));
    let decomposed = DecomposingNormalizerBorrowed::new_nfkd().normalize(name);
    let kept = re.replace_all(&decomposed, "").to_lowercase();
    let mapped: String = kept.chars().map(fold_char).collect();
    ComposingNormalizerBorrowed::new_nfkc().normalize(&mapped).into_owned()
}

/// 長得像的外國字母（小寫後的樣子）與日文、簡體字形的對照，不求全
fn fold_char(c: char) -> char {
    match c {
        'а' | 'ɑ' | 'α' | 'ᴀ' => 'a',
        'ѕ' | 'ꜱ' => 's',
        'ν' | 'ո' | 'ɴ' | 'ᴎ' => 'n',
        '发' | '発' => '發',
        '収' => '收',
        _ => c,
    }
}

/// 這個名字是不是保留給系統通知的（不能當夥伴名／視窗名）：正規化後等於「asn通知」或結尾是「收發室」
pub fn is_reserved_name(name: &str) -> bool {
    let f = fold_name(name);
    f == fold_name(NOTICE_SENDER) || f.ends_with(LEGACY_NOTICE_SUFFIX)
}

/// 只看寄件名的版本（手上只有寄件名、沒有整封信的地方用）：沒有 kind 也沒有寄出時間可看，所以只在沒設截止時間時有效
pub fn is_system_notice_name(from_agent: &str) -> bool {
    legacy_applies(None, LEGACY_NOTICE_UNTIL_MS) && is_reserved_name(from_agent)
}

/// 整封信的判斷：kind 是 `notice:*` 一定算；否則看（截止時間前的）舊寄件名
pub fn is_system_notice(from_agent: &str, kind: Option<&str>, sent_ms: Option<u64>) -> bool {
    is_system_notice_at(from_agent, kind, sent_ms, LEGACY_NOTICE_UNTIL_MS)
}

pub fn is_system_notice_at(from_agent: &str, kind: Option<&str>, sent_ms: Option<u64>, until: Option<u64>) -> bool {
    if kind.is_some_and(|k| k.starts_with(NOTICE_KIND_PREFIX)) {
        return true;
    }
    legacy_applies(sent_ms, until) && is_reserved_name(from_agent)
}

/// 內文開頭的 `[收發室]` 標記（舊版橋寄的通知）：同樣只對截止時間以前的信有效
pub fn has_legacy_body_prefix(body: &str, sent_ms: Option<u64>) -> bool {
    has_legacy_body_prefix_at(body, sent_ms, LEGACY_NOTICE_UNTIL_MS)
}

pub fn has_legacy_body_prefix_at(body: &str, sent_ms: Option<u64>, until: Option<u64>) -> bool {
    legacy_applies(sent_ms, until) && body.trim_start().starts_with(LEGACY_BODY_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 截止時間預設沒設() {
        assert_eq!(LEGACY_NOTICE_UNTIL_MS, None);
        assert!(legacy_applies(None, None) && legacy_applies(Some(5), None));
    }

    #[test]
    fn kind_與舊寄件名() {
        assert!(is_system_notice("小乙", Some("notice:quota"), None));
        assert!(!is_system_notice("小乙", Some("chat"), None));
        assert!(is_system_notice("ASN 通知", None, None));
        assert!(is_system_notice("額度通知收發室", None, None));
        assert!(is_system_notice("W-收发室", None, None));
        assert!(is_system_notice("ＡＳＮ通知", None, None));
        assert!(is_system_notice("asn\u{200b}通知", None, None));
        assert!(!is_system_notice("W-政策", None, None));
        assert!(!is_system_notice("ASN 通知單", None, None));
    }

    #[test]
    fn 設了截止時間_舊規則只對截止前的信有效() {
        let u = Some(1_000);
        assert!(is_system_notice_at("ASN 通知", None, Some(999), u));
        assert!(!is_system_notice_at("ASN 通知", None, Some(1_000), u));
        assert!(!is_system_notice_at("X收發室", None, Some(2_000), u));
        assert!(!is_system_notice_at("ASN 通知", None, None, u), "沒有寄出時間且已設截止＝不算");
        assert!(is_system_notice_at("X", Some("notice:login"), Some(2_000), u), "有 kind 不受截止影響");
        assert!(has_legacy_body_prefix_at("[收發室] 嗨", Some(999), u));
        assert!(!has_legacy_body_prefix_at("[收發室] 嗨", Some(1_000), u));
        assert!(!has_legacy_body_prefix_at("[收發室] 嗨", None, u));
        assert!(has_legacy_body_prefix("  [收發室] 嗨", None));
        assert!(!has_legacy_body_prefix("你好", None));
    }

    /// 共用案例檔（和後台、UI、Node 橋同一份）
    fn cases() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../../../supabase/functions/_shared/reserved_sender_cases.json")).expect("共用案例檔是合法 JSON")
    }

    #[test]
    fn 保留名字_共用案例() {
        let c = cases();
        let reserved = c["reserved"].as_array().unwrap();
        let ordinary = c["ordinary"].as_array().unwrap();
        assert!(reserved.len() > 20 && ordinary.len() > 5);
        for n in reserved {
            assert!(is_reserved_name(n.as_str().unwrap()), "{n}");
        }
        for n in ordinary {
            assert!(!is_reserved_name(n.as_str().unwrap()), "{n}");
        }
    }

    #[test]
    fn 正規化_共用案例() {
        for pair in cases()["fold"].as_array().unwrap() {
            let (input, expected) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
            assert_eq!(fold_name(input), expected, "{input}");
        }
    }
}
