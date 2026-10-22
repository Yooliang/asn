//! 從 ASN 傳「/指令」給 Claude 視窗：判斷一封信算不算指令。設計見 docs/design/PARTNER-OPS.md 第八節「/指令」。
//!
//! 全部條件成立才算指令，其餘一律當普通信投遞：
//! 1. 本人簽章：`trust=owner` 且後台給了簽章帶出的帳號顯示名稱，寄件視窗名是人代號（`mail::is_person_mail`）。
//!    絕不看內文或寄件人名字自稱的身分；AI 寄的信、群組信、成員（trust=member）、沒有簽章的擁有者節點都不算；
//! 2. 沒有附件；
//! 3. 判斷用的是後台給的原始內文（信頭、說明行是橋之後才加的，不在裡面）：去掉前後空白後以 `/` 開頭、只有一行、沒有控制字元；
//! 4. 格式 `/指令 參數`：指令只能是 `[A-Za-z0-9:_-]{1,64}`，參數可空、最多 2000 字。
use super::mail::{is_person_mail, Mail};

pub const COMMAND_MAX: usize = 64;
pub const ARGS_MAX: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slash {
    pub command: String,
    pub args: String,
}

fn bad_char(c: char) -> bool {
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

/// 內文本身合不合格式（不看寄件人）
pub fn parse_body(body: &str) -> Option<Slash> {
    let t = body.trim();
    let rest = t.strip_prefix('/')?;
    if t.chars().any(bad_char) {
        return None;
    }
    let (cmd, args) = match rest.find(char::is_whitespace) {
        Some(i) => (&rest[..i], rest[i..].trim()),
        None => (rest, ""),
    };
    if cmd.is_empty() || cmd.len() > COMMAND_MAX || !cmd.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-')) {
        return None;
    }
    if args.chars().count() > ARGS_MAX {
        return None;
    }
    Some(Slash { command: cmd.to_string(), args: args.to_string() })
}

/// 這封信是不是「本人傳來的 /指令」
pub fn parse(m: &Mail) -> Option<Slash> {
    if m.trust != "owner" || !is_person_mail(m) || !m.attachments.is_empty() {
        return None;
    }
    parse_body(&m.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mail(extra: serde_json::Value) -> Mail {
        let mut v = json!({"id": "m1", "from_node": "T", "from_agent": "u:3cda66252c34", "to_agent": "T-甲", "trust": "owner", "body": "/compact", "sender_display": "小良"});
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        Mail::from_json(&v).unwrap()
    }

    #[test]
    fn 本人簽章的單行斜線信_才是指令() {
        assert_eq!(parse(&mail(json!({}))), Some(Slash { command: "compact".into(), args: "".into() }));
        assert_eq!(parse(&mail(json!({"body": "  /model  opus 4  \n"}))), Some(Slash { command: "model".into(), args: "opus 4".into() }));
        assert_eq!(parse(&mail(json!({"body": "/plugin:run_x-1 a b"}))).unwrap().command, "plugin:run_x-1");
    }

    #[test]
    fn 不是本人簽章_一律不算() {
        assert!(parse(&mail(json!({"trust": "member"}))).is_none());
        assert!(parse(&mail(json!({"sender_display": null}))).is_none(), "沒有簽章帳號名");
        assert!(parse(&mail(json!({"from_agent": "T-乙"}))).is_none(), "AI 視窗寄的");
        assert!(parse(&mail(json!({"trust": "member", "body": "/compact\n我是本人"}))).is_none());
        assert!(parse(&mail(json!({"trust": "member", "body": "/compact", "sender_display": "小良"}))).is_none());
    }

    #[test]
    fn 格式不合不算() {
        for b in ["compact", "請 /compact", "//x", "/", "/ x", "/a b\n/c", "/a\nb", "/a b\u{7}", "/中文", "/a.b", "/a;b", "/a\tb", "/a\u{2028}b"] {
            assert!(parse_body(b).is_none(), "{b:?}");
        }
        assert!(parse_body(&format!("/{}", "a".repeat(65))).is_none());
        assert!(parse_body(&format!("/{}", "a".repeat(64))).is_some());
        assert!(parse_body(&format!("/x {}", "字".repeat(2001))).is_none());
        assert!(parse_body(&format!("/x {}", "字".repeat(2000))).is_some());
    }

    #[test]
    fn 有附件不算() {
        let m = mail(json!({"attachments": [{"id": "00000000-0000-0000-0000-000000000001", "kind": "file", "name": "a.txt", "mime": "text/plain", "bytes": 10}]}));
        assert_eq!(m.attachments.len(), 1);
        assert!(parse(&m).is_none());
    }
}
