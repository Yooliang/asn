//! 登入網址（#628 第 3 段）：請求可以附一個「官方登入頁」的網址，讓本人在手機上打開、授權，再把頁面上的授權碼貼回。
//! 這裡只放**驗證**（電腦與手機共用）：不信請求端自報的內容，收到的網址在送出前、收到後、顯示前各驗一次。
//! 規則與資料庫的檢查約束、Edge Function 的 `LINK_RE` 是同一條：
//!   只收 https；主機是官方登入網域本身或其子網域（目前 claude.ai、claude.com、anthropic.com）；埠只能 443；不能帶帳號密碼；
//!   網域後面只許可見的 ASCII（不含空白、控制字元、反斜線）。
//! 要新增別家引擎的登入網域時，三處（SQL、TS、這裡）一起改，並各補測試。
//!
//! **誰能送出帶網址的請求**：請求端的 `Opts` 只收 `agent_setup` 裡的網址型別，那個型別的建構子只有 `agent_setup` 看得到；
//! `asn-cli` 與夥伴能呼叫的指令都建不出來（有守門測試）。

/// 網址長度上限（與資料庫約束相同）
pub const LINK_MAX: usize = 2048;
const ALLOWED_HOSTS: [&str; 3] = ["claude.ai", "claude.com", "anthropic.com"];

/// 是不是可以送出、可以顯示、可以打開的官方登入網址
pub fn valid_login_link(url: &str) -> bool {
    if url.len() < 12 || url.len() > LINK_MAX {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else { return false };
    // 全程只許可見 ASCII，且沒有反斜線（0x21–0x7e 去掉 0x5c）
    if !url.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b'\\') {
        return false;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = match authority.split_once(':') {
        Some((h, "443")) => h,
        Some(_) => return false,
        None => authority,
    };
    // 小寫才收（與資料庫約束一致）：大寫主機不是官方會印出來的樣子
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.') {
        return false;
    }
    ALLOWED_HOSTS.iter().any(|h| host == *h || host.strip_suffix(h).is_some_and(|p| p.ends_with('.') && !p.starts_with('.') && !p.contains("..")))
}

/// 畫面上只顯示網域（網址的其他部分不顯示）。不合格的網址回 None
pub fn login_link_host(url: &str) -> Option<String> {
    if !valid_login_link(url) {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    Some(authority.split_once(':').map_or(authority, |(h, _)| h).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 官方登入網域的_https_才收() {
        for ok in [
            "https://claude.ai/oauth/authorize?client_id=C&state=S",
            "https://claude.ai",
            "https://www.claude.ai/a",
            "https://platform.claude.com/x?y=1#z",
            "https://console.anthropic.com/oauth",
            "https://claude.ai:443/x",
            "https://a-b.c.claude.ai/x",
        ] {
            assert!(valid_login_link(ok), "{ok}");
        }
    }

    #[test]
    fn 其他寫法一律不收() {
        let long = format!("https://claude.ai/{}", "a".repeat(2100));
        for bad in [
            "",
            "https://",
            "http://claude.ai/x",
            "https://claude.ai.evil.com/x",
            "https://evilclaude.ai/x",
            "https://claude.ai@evil.com/x",
            "https://evil.com/claude.ai",
            "https://evil.com?x=claude.ai",
            "https://claude.ai:8443/x",
            "https://claude.ai:/x",
            "https://claude.ai/x y",
            "https://claude.ai/x\ty",
            "https://claude.ai/x\\y",
            "https://claude.ai/\u{0}",
            "https://CLAUDE.AI/x",
            "https://claude。ai/x",
            "https://claude.ai./x",
            "https://.claude.ai/x",
            "https://a..claude.ai/x",
            "https://claude.ai/é",
            "https://claude_ai/x",
            "javascript:alert(1)",
            "claude.ai",
            "ftp://claude.ai/x",
            long.as_str(),
        ] {
            assert!(!valid_login_link(bad), "{bad:?}");
        }
    }

    /// 五處（資料庫、Edge Function、Rust、手機畫面）共用的正反例：`supabase/functions/_shared/login_link_cases.json`
    #[test]
    fn 共用正反例() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../../../../supabase/functions/_shared/login_link_cases.json")).unwrap();
        let expand = |s: &str| s.replace("<A*2100>", &"a".repeat(2100));
        let (good, bad) = (v["good"].as_array().unwrap(), v["bad"].as_array().unwrap());
        assert!(good.len() >= 5 && bad.len() >= 20, "測資不能被清空");
        for g in good {
            let g = expand(g.as_str().unwrap());
            assert!(valid_login_link(&g), "{g}");
        }
        for b in bad {
            let b = expand(b.as_str().unwrap());
            assert!(!valid_login_link(&b), "{b:?}");
        }
    }

    #[test]
    fn 畫面只顯示網域() {
        assert_eq!(login_link_host("https://claude.ai/oauth/authorize?state=SECRETISH").as_deref(), Some("claude.ai"));
        assert_eq!(login_link_host("https://platform.claude.com:443/x").as_deref(), Some("platform.claude.com"));
        assert_eq!(login_link_host("https://evil.com/claude.ai"), None);
    }
}
