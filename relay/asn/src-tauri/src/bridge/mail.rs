//! 信件格式（純函式）：對應 relay/machine/mail-format.mjs。
//! 來信抬頭、「要不要回信」判斷、視窗代寄抬頭 `[RELAY 寄信]`、視窗自己加的 `[回覆 id=… → …]` 抬頭。
//! 沒有用規則運算式套件，全部手寫解析，行為逐項照原本的正則。
use serde_json::Value;

/// 舊式內文標記。【過渡期相容】只有欄位是 null 的信才退回看它（與 Node 橋同）
pub fn has_legacy_no_reply_mark(body: &str) -> bool {
    body.contains("（不需回覆）") || body.to_lowercase().contains("[no-reply]")
}

/// 逾時提醒結尾那句
pub const NO_REPLY_TIP: &str = "只是告知的信，寄件時用 --no-reply（代寄寫 reply=no）就不會提醒";

/// 欄位值 → true／false／null。接受布林，也接受字串 yes／no
pub fn to_reply_flag(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) if s == "yes" => Some(true),
        Value::String(s) if s == "no" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
pub fn reply_label(v: &Value) -> &'static str {
    match to_reply_flag(v) {
        Some(true) => "yes",
        Some(false) => "no",
        None => "?",
    }
}

/// 寄件人要不要等回信：欄位有明說就只看欄位；欄位是 null 才退回看內文舊標記
pub fn wants_reply(field: Option<bool>, body: &str) -> bool {
    match field {
        Some(f) => f,
        None => !has_legacy_no_reply_mark(body),
    }
}

/// 一封信（後端 inbox 回的欄位，只取橋用得到的）
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mail {
    pub id: String,
    pub from_node: String,
    pub from_agent: Option<String>,
    pub to_agent: Option<String>,
    pub body: String,
    pub trust: String,
    pub expects_reply: Option<bool>,
    /// 清理過的附件清單（縮圖丟掉、編號必須是 uuid、最多 4 筆）
    pub attachments: Vec<super::attach::Attachment>,
}

impl Mail {
    pub fn from_json(v: &Value) -> Option<Mail> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
        Some(Mail {
            id: s("id").filter(|x| !x.is_empty())?,
            from_node: s("from_node").unwrap_or_default(),
            from_agent: s("from_agent"),
            to_agent: s("to_agent").filter(|x| !x.is_empty()),
            body: s("body").unwrap_or_default(),
            trust: s("trust").unwrap_or_else(|| "member".into()),
            expects_reply: v.get("expects_reply").and_then(to_reply_flag),
            attachments: super::attach::normalize(v.get("attachments")),
        })
    }
}

/// 來信抬頭（第一行）：reply 放最後
pub fn mail_head(m: &Mail, engine: &str) -> String {
    let flag = match m.expects_reply {
        Some(true) => "yes",
        Some(false) => "no",
        None => "?",
    };
    format!(
        "[RELAY 來信] trust={} from={}/{} to={} id={} engine={} reply={}",
        m.trust,
        m.from_node,
        m.from_agent.as_deref().unwrap_or(""),
        m.to_agent.as_deref().unwrap_or(""),
        m.id,
        engine,
        flag
    )
}

/// 視窗代寄抬頭解析結果
#[derive(Debug, PartialEq)]
pub struct SendHead {
    pub to_node: String,
    pub to_agent: Option<String>,
    pub re: Option<String>,
    /// "yes"｜"no"（沒寫就是 None）
    pub reply: Option<String>,
    pub body: String,
}

fn is_hspace(c: char) -> bool {
    c.is_whitespace() && c != '\r' && c != '\n'
}
fn is_uuidish(c: char) -> bool {
    c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-'
}

/// `[RELAY 寄信] to=<節點>[/<視窗>] [re=<信件id>] reply=yes|no`（`[RELAY 回信]` 同義；re 與 reply 順序不拘）。
/// 同一行抬頭後面若還接著別的字，當成內文開頭。對應 mail-format.mjs 的 SEND_HEAD_RE。
pub fn parse_send_head(text: &str) -> Option<SendHead> {
    let mut rest = text.trim_start();
    rest = rest.strip_prefix("[RELAY ")?;
    rest = rest.strip_prefix("寄信").or_else(|| rest.strip_prefix("回信"))?;
    rest = rest.strip_prefix(']')?;
    rest = rest.trim_start();
    rest = rest.strip_prefix("to=")?;
    let n = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len());
    if n == 0 {
        return None;
    }
    let to_node = rest[..n].to_string();
    rest = &rest[n..];
    let mut to_agent = None;
    if let Some(r) = rest.strip_prefix('/') {
        let n = r.find(char::is_whitespace).unwrap_or(r.len());
        if n > 0 {
            to_agent = Some(r[..n].to_string());
            rest = &r[n..];
        }
    }
    let (mut re, mut reply) = (None, None);
    loop {
        // 選項一：\s+re=<36 個 uuid 字元>
        let t = rest.trim_start_matches(char::is_whitespace);
        if t.len() < rest.len() {
            if let Some(r) = t.strip_prefix("re=") {
                let id: String = r.chars().take(36).collect();
                if id.chars().count() == 36 && id.chars().all(is_uuidish) {
                    re = Some(id.clone());
                    rest = &r[id.len()..];
                    continue;
                }
            }
        }
        // 選項二：非換行空白+ reply=yes|no，後面必須接空白或結尾
        let t = rest.trim_start_matches(is_hspace);
        if t.len() < rest.len() {
            if let Some(r) = t.strip_prefix("reply=") {
                let word: String = r.chars().take(3).collect();
                let low = word.to_lowercase();
                let (val, len) = if low.starts_with("yes") && word.chars().count() == 3 { ("yes", 3) } else if low.starts_with("no") { ("no", 2) } else { ("", 0) };
                if len > 0 {
                    let after = &r[r.char_indices().nth(len).map(|(i, _)| i).unwrap_or(r.len())..];
                    if after.is_empty() || after.starts_with(char::is_whitespace) {
                        reply = Some(val.to_string());
                        rest = after;
                        continue;
                    }
                }
            }
        }
        break;
    }
    let mut r = rest.trim_start_matches(is_hspace);
    r = r.strip_prefix("\r\n").or_else(|| r.strip_prefix('\n')).unwrap_or(r);
    Some(SendHead { to_node, to_agent, re, reply, body: r.trim().to_string() })
}

/// 視窗用文字回信時自己加的「[回覆 id=<信件id> → <節點>[/<視窗>]]」抬頭：拆掉，回傳 (編號小寫, 內文)。沒有就是 (None, 原文)
pub fn strip_reply_head(text: &str) -> (Option<String>, String) {
    let t = text.trim_start();
    let none = || (None, text.to_string());
    let Some(r) = t.strip_prefix("[回覆 id=") else { return none() };
    let id: String = r.chars().take(36).collect();
    let parts: Vec<&str> = id.split('-').collect();
    let ok = id.chars().count() == 36 && parts.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()));
    if !ok {
        return none();
    }
    let Some(r) = r[id.len()..].strip_prefix(" → ") else { return none() };
    let Some(end) = r.find(|c| c == ']' || c == '\r' || c == '\n') else { return none() };
    if !r[end..].starts_with(']') {
        return none();
    }
    let mut after = r[end + 1..].trim_start_matches(|c| c == ' ' || c == '\t');
    after = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n')).unwrap_or(after);
    let body = after.trim().to_string();
    (Some(id.to_lowercase()), if body.is_empty() { text.to_string() } else { body })
}

/// 預設收件視窗不在線時代收的說明
pub fn fallback_note(wanted: &str, actual: &str) -> String {
    format!("[收發室] 這封信原本要給「{wanted}」，但它不在線，請你（{actual}）代收並轉告／處理。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn 要不要回信_欄位優先_null_才看舊標記() {
        assert!(!wants_reply(Some(false), "要回喔"));
        assert!(wants_reply(Some(true), "（不需回覆）"), "欄位明說 true 就只看欄位");
        assert!(wants_reply(None, "普通內文"));
        assert!(!wants_reply(None, "好的（不需回覆）"));
        assert!(!wants_reply(None, "好的 [No-Reply]"));
        assert_eq!(to_reply_flag(&json!("yes")), Some(true));
        assert_eq!(to_reply_flag(&json!("maybe")), None);
        assert_eq!(reply_label(&json!(null)), "?");
    }

    #[test]
    fn 來信抬頭格式_reply_在最後() {
        let m = Mail::from_json(&json!({"id": ID, "from_node": "W", "from_agent": "W-政策", "to_agent": "T-甲", "trust": "owner", "expects_reply": true, "body": "x"})).unwrap();
        assert_eq!(mail_head(&m, "claude"), format!("[RELAY 來信] trust=owner from=W/W-政策 to=T-甲 id={ID} engine=claude reply=yes"));
        let old = Mail::from_json(&json!({"id": ID, "from_node": "W", "body": "x"})).unwrap();
        assert!(mail_head(&old, "claude").ends_with("engine=claude reply=?"));
        assert!(Mail::from_json(&json!({"from_node": "W"})).is_none());
    }

    #[test]
    fn 代寄抬頭_各種寫法() {
        let h = parse_send_head("[RELAY 寄信] to=W/W-政策 reply=yes\n你好").unwrap();
        assert_eq!((h.to_node.as_str(), h.to_agent.as_deref(), h.reply.as_deref(), h.re.as_deref(), h.body.as_str()), ("W", Some("W-政策"), Some("yes"), None, "你好"));
        let h = parse_send_head(&format!("[RELAY 回信] to=W re={ID} reply=NO\r\n內文")).unwrap();
        assert_eq!((h.re.as_deref(), h.reply.as_deref(), h.body.as_str()), (Some(ID), Some("no"), "內文"));
        // 順序不拘
        let h = parse_send_head(&format!("[RELAY 寄信] to=W reply=no re={ID}\nx")).unwrap();
        assert_eq!((h.re.as_deref(), h.reply.as_deref()), (Some(ID), Some("no")));
        // 沒寫 reply：解析得出來但 reply 是 None（橋要拒絕）
        let h = parse_send_head("[RELAY 寄信] to=W\n內文").unwrap();
        assert_eq!(h.reply, None);
        // reply 值寫錯：不算 reply，錯字留在內文開頭
        let h = parse_send_head("[RELAY 寄信] to=W reply=maybe\n內文").unwrap();
        assert_eq!(h.reply, None);
        assert!(h.body.starts_with("reply=maybe"));
        // 抬頭後同一行還有字：當內文開頭
        let h = parse_send_head("[RELAY 寄信] to=W reply=no 順便說").unwrap();
        assert_eq!(h.body, "順便說");
        // 不是抬頭
        assert!(parse_send_head("普通回覆").is_none());
        assert!(parse_send_head("[RELAY 寄信] to=").is_none());
        // 前面有空白、換行也可
        assert!(parse_send_head("\n  [RELAY 寄信] to=W reply=yes\nx").is_some());
    }

    #[test]
    fn 回覆抬頭拆除() {
        let (id, body) = strip_reply_head(&format!("[回覆 id={ID} → W/W-政策]\n好的，已處理"));
        assert_eq!(id.as_deref(), Some(ID));
        assert_eq!(body, "好的，已處理");
        let (id, body) = strip_reply_head("沒有抬頭的回覆");
        assert_eq!((id, body.as_str()), (None, "沒有抬頭的回覆"));
        // 只有抬頭沒內文：保留原文
        let only = format!("[回覆 id={ID} → W]");
        let (id, body) = strip_reply_head(&only);
        assert_eq!(id.as_deref(), Some(ID));
        assert_eq!(body, only);
        // 編號不是 uuid
        assert_eq!(strip_reply_head("[回覆 id=zzz → W]\nx").0, None);
        // 大寫編號轉小寫
        assert_eq!(strip_reply_head(&format!("[回覆 id={} → W]\nx", ID.replace('1', "A").replace('2', "B"))).0.as_deref(), Some(ID.replace('1', "a").replace('2', "b").as_str()));
    }
}
