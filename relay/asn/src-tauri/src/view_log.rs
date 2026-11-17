//! 看別台畫面／打字的握手紀錄（#1700）：兩端（看的一端、被看的一端）各寫一行，查「為什麼被拒絕、為什麼一直重新問允許」才有證據。
//! 只記：誰（雙方設備公鑰的 sha256 前 6 碼）、TOFU 結果（New／Same／Changed）、看畫面或打字、接受或拒絕與原因代號。
//! **不記**：完整公鑰、暫時金鑰、簽章、畫面與打字內容。原因只用固定的代號（英數與底線），不放任何外來字串。
//! 純函式，全平台都編；寫檔由呼叫端（ui.log）。

use crate::device_id::Tofu;
use crate::view_handshake::Scope;

/// 哪一端寫的
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// 看的那台（D）
    Viewer,
    /// 被看的那台（T）
    Target,
}

impl Side {
    fn as_str(self) -> &'static str {
        match self {
            Side::Viewer => "viewer",
            Side::Target => "target",
        }
    }
}

/// 設備公鑰 → 前 6 碼（sha256 十六進位）；空的寫 `-`。原值不寫進 log
pub fn hash6(pubkey: &str) -> String {
    if pubkey.is_empty() {
        "-".to_string()
    } else {
        crate::claude_quota::owner::short_hash(pubkey)
    }
}

pub fn tofu_text(t: Option<Tofu>) -> &'static str {
    match t {
        Some(Tofu::New) => "New",
        Some(Tofu::Same) => "Same",
        Some(Tofu::Changed) => "Changed",
        None => "?",
    }
}

/// 自己的雜湊前 6 碼：只留英數與橫線（沒有的就是 -）
fn me6_text(s: &str) -> String {
    let c: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(12).collect();
    if c.is_empty() {
        "-".into()
    } else {
        c
    }
}

/// 原因代號只留英數與底線、最長 40 字，其他換成底線（防外來字串進 log）
fn code(s: &str) -> String {
    let c: String = s.chars().take(40).map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    if c.is_empty() {
        "-".into()
    } else {
        c
    }
}

/// 一行握手紀錄（不含時間與 `info [ASN]` 前綴，由呼叫端加）。
/// `id`＝這次觀看的編號（隨機，只取前 8 碼，兩端對得起來）；`result`＝accepted／rejected／started／ended 等；`reason`＝原因代號
pub fn line(side: Side, id: &str, scope: Scope, me_pub: &str, peer_pub: &str, tofu: Option<Tofu>, result: &str, reason: &str) -> String {
    line_with_me(side, id, scope, &hash6(me_pub), peer_pub, tofu, result, reason)
}

/// 同 [`line`]，自己這台已經是雜湊前 6 碼（不再保留公鑰的地方用）
pub fn line_with_me(side: Side, id: &str, scope: Scope, me6: &str, peer_pub: &str, tofu: Option<Tofu>, result: &str, reason: &str) -> String {
    let id8: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    format!(
        "view-handshake side={} id={} scope={} me={} peer={} tofu={} result={} reason={}",
        side.as_str(),
        if id8.is_empty() { "-".to_string() } else { id8 },
        scope.as_str(),
        me6_text(me6),
        hash6(peer_pub),
        tofu_text(tofu),
        code(result),
        code(reason)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "ME_FULL_PUBLIC_KEY_BASE64_aaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
    const PEER: &str = "PEER_FULL_PUBLIC_KEY_BASE64_bbbbbbbbbbbbbbbbbbbbbbbbbb=";

    #[test]
    fn 一行有雙方雜湊前六碼_tofu_範圍_結果_原因_不含完整公鑰() {
        let l = line(Side::Target, "0a1b2c3d-4e5f-6789-abcd-ef0123456789", Scope::Input, ME, PEER, Some(Tofu::Same), "rejected", "consent_denied");
        assert_eq!(
            l,
            format!("view-handshake side=target id=0a1b2c3d scope=input me={} peer={} tofu=Same result=rejected reason=consent_denied", crate::claude_quota::owner::short_hash(ME), crate::claude_quota::owner::short_hash(PEER))
        );
        assert_ne!(hash6(ME), hash6(PEER));
        assert_eq!(hash6(ME).len(), 6);
        for secret in [ME, PEER, "FULL_PUBLIC_KEY"] {
            assert!(!l.contains(secret), "完整公鑰不能進 log：{l}");
        }
    }

    #[test]
    fn 兩端各一行_看畫面與打字_三種_tofu_都寫得出() {
        for (t, s) in [(Some(Tofu::New), "New"), (Some(Tofu::Same), "Same"), (Some(Tofu::Changed), "Changed"), (None, "?")] {
            assert_eq!(tofu_text(t), s);
        }
        let v = line(Side::Viewer, "id", Scope::View, ME, PEER, Some(Tofu::New), "started", "-");
        assert!(v.starts_with("view-handshake side=viewer ") && v.contains("scope=view") && v.contains("tofu=New"), "{v}");
        let t = line(Side::Target, "id", Scope::Input, ME, PEER, Some(Tofu::Changed), "rejected", "key_changed");
        assert!(t.contains("side=target") && t.contains("scope=input") && t.contains("tofu=Changed") && t.contains("reason=key_changed"), "{t}");
    }

    #[test]
    fn 原因與編號只留英數底線_外來字串進不來_空的寫橫線() {
        let l = line(Side::Target, "a/b c\n中文-9", Scope::View, "", "", None, "rejected\nINJECT", "後台回的資料不對 x=1");
        assert!(!l.contains('\n') && l.contains("result=rejected_INJECT ") && !l.contains("後台"), "{l}");
        assert!(l.contains("id=abc9") && l.contains("me=-") && l.contains("peer=-") && l.contains("tofu=?"), "{l}");
        assert!(l.ends_with("reason=_________x_1"), "{l}");
        let long = line(Side::Target, "", Scope::View, ME, PEER, None, &"r".repeat(200), &"x".repeat(200));
        assert!(long.len() < 220, "最長有限制：{}", long.len());
        assert!(long.contains("id=-"));
    }
}
