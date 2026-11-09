//! 收發室自己說話的系統通知（from_agent 為 None）在「通知」對話裡會和別台設備的通知收在一起，
//! 所以內文第一行前面加「<這台的設備名>：」，看的人才分得出是哪一台。代夥伴寄的信不加。
//! 設備名一律用後台的節點名稱（relay.nodes.name，名單 list 的 members[].name），和畫面標頭「通知 · <設備名>」同一個來源；
//! 還沒拿到、或後台這台沒取名字＝不加前綴（畫面標頭已有「未命名設備」，內文不必重複）。不退回電腦名稱。
use serde_json::Value;

const MAX_CHARS: usize = 40;
/// 名單裡查到的設備名多久重查一次（毫秒）；查失敗時同樣隔這麼久才再試，不是每則通知都打後台
pub const REFRESH_MS: u64 = 10 * 60_000;

/// 清掉控制字元、去頭尾空白、截到 40 字；清完是空的＝None（不加前綴）
pub fn clean_device(name: &str) -> Option<String> {
    let s: String = name.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(MAX_CHARS).collect();
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// 從後台名單（`list` 的回應）找自己這個節點的設備名
pub fn own_device_name(list: &Value, node: &str) -> Option<String> {
    list.get("members")?.as_array()?.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(node)).and_then(|m| m.get("name")).and_then(Value::as_str).and_then(clean_device)
}

/// 舊的「[收發室] 」字頭：收發室自己說話的通知不再帶（通知對話的氣泡上方已寫明來源）。
/// 只有代夥伴寄的「轉交失敗」說明還保留它（那是給對方橋認「這封本身是通知」的記號，見 fail_notice.rs）
pub const OLD_HEAD: &str = "[收發室] ";

/// 收發室自己說話（from_agent 為 None）的內文去掉舊字頭；代夥伴寄的不動
pub fn without_old_head<'a>(body: &'a str, from_agent: Option<&str>) -> &'a str {
    match from_agent {
        None => body.strip_prefix(OLD_HEAD).unwrap_or(body),
        Some(_) => body,
    }
}

/// 收發室自己說話才加前綴（from_agent 為 None）；沒有設備名＝不加。已經有同樣前綴就不重複加
pub fn with_notice_prefix(body: &str, from_agent: Option<&str>, device: Option<&str>) -> String {
    match (from_agent, device.and_then(clean_device)) {
        (None, Some(d)) => {
            let p = format!("{d}：");
            if body.starts_with(&p) { body.to_string() } else { format!("{p}{body}") }
        }
        _ => body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 設備名清控制字元_截四十字_空的是none() {
        assert_eq!(clean_device(" 家用機\n").as_deref(), Some("家用機"));
        assert_eq!(clean_device("a\u{7}b").as_deref(), Some("a b"));
        assert_eq!(clean_device(&"字".repeat(50)).unwrap().chars().count(), 40);
        assert_eq!(clean_device(""), None);
        assert_eq!(clean_device(" \n\t"), None);
    }

    #[test]
    fn 從名單找自己節點的名字() {
        let l = json!({"members": [{"id": "H", "name": "40家用"}, {"id": "T", "name": "  辦公室 "}, {"id": "X", "name": null}]});
        assert_eq!(own_device_name(&l, "T").as_deref(), Some("辦公室"));
        assert_eq!(own_device_name(&l, "H").as_deref(), Some("40家用"));
        assert_eq!(own_device_name(&l, "X"), None, "後台沒取名字");
        assert_eq!(own_device_name(&l, "Z"), None, "名單沒有這個節點");
        assert_eq!(own_device_name(&json!({"error": "x"}), "T"), None);
    }

    #[test]
    fn 去舊字頭只對收發室自己說話的通知() {
        assert_eq!(without_old_head("[收發室] 轉交給 X 失敗", None), "轉交給 X 失敗");
        assert_eq!(without_old_head("[收發室] 轉交給 X 失敗", Some("X")), "[收發室] 轉交給 X 失敗", "代夥伴寄的保留");
        assert_eq!(without_old_head("沒有字頭", None), "沒有字頭");
    }

    #[test]
    fn 前綴只加在收發室自己說話的通知() {
        assert_eq!(with_notice_prefix("x", None, Some("家用機")), "家用機：x");
        assert_eq!(with_notice_prefix("內容", Some("小乙"), Some("家用機")), "內容", "代夥伴寄不加");
        assert_eq!(with_notice_prefix("內容", None, None), "內容", "沒拿到設備名不加");
        assert_eq!(with_notice_prefix("內容", None, Some("")), "內容", "設備名為空不加");
        assert_eq!(with_notice_prefix("家用機：內容", None, Some("家用機")), "家用機：內容", "不重複加");
    }
}
