//! 收發室自己說話的系統通知（from_agent 為 None）在「通知」對話裡會和別台設備的通知收在一起，
//! 所以內文第一行前面加「<這台的設備名>：」，看的人才分得出是哪一台。代夥伴寄的信不加。

/// 沒有設備名時的固定字樣（不露出節點代號）
pub const UNNAMED_DEVICE: &str = "未命名設備";
const MAX_CHARS: usize = 40;

/// 設備名清掉控制字元、去頭尾空白、截到 40 字；清完是空的就用「未命名設備」
pub fn notice_device(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(MAX_CHARS).collect();
    let clean = clean.trim().to_string();
    if clean.is_empty() { UNNAMED_DEVICE.to_string() } else { clean }
}

/// 這台的設備名來源：電腦名稱（Windows COMPUTERNAME，其次 HOSTNAME）；讀不到回空字串（之後會變成「未命名設備」）
pub fn local_device_name(env: impl Fn(&str) -> Option<String>) -> String {
    env("COMPUTERNAME").or_else(|| env("HOSTNAME")).unwrap_or_default()
}

/// 第一行前面的前綴，例如「小良的家用機：」
pub fn notice_prefix(name: &str) -> String {
    format!("{}：", notice_device(name))
}

/// 收發室自己說話才加前綴（from_agent 為 None）；device 為 None＝不加（測試環境）。已經有同樣前綴就不重複加
pub fn with_notice_prefix(body: &str, from_agent: Option<&str>, device: Option<&str>) -> String {
    match (from_agent, device) {
        (None, Some(d)) => {
            let p = notice_prefix(d);
            if body.starts_with(&p) { body.to_string() } else { format!("{p}{body}") }
        }
        _ => body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 設備名清控制字元_截四十字_空的用未命名() {
        assert_eq!(notice_device(" 家用機\n"), "家用機");
        assert_eq!(notice_device("a\u{7}b"), "a b");
        assert_eq!(notice_device(&"字".repeat(50)).chars().count(), 40);
        assert_eq!(notice_device(""), UNNAMED_DEVICE);
        assert_eq!(notice_device(" \n\t"), UNNAMED_DEVICE);
    }

    #[test]
    fn 前綴只加在收發室自己說話的通知() {
        assert_eq!(notice_prefix("家用機"), "家用機：");
        assert_eq!(with_notice_prefix("[收發室] x", None, Some("家用機")), "家用機：[收發室] x");
        assert_eq!(with_notice_prefix("內容", Some("小乙"), Some("家用機")), "內容", "代夥伴寄不加");
        assert_eq!(with_notice_prefix("內容", None, None), "內容", "沒設備名設定（測試）不加");
        assert_eq!(with_notice_prefix("內容", None, Some("")), "未命名設備：內容");
        assert_eq!(with_notice_prefix("家用機：內容", None, Some("家用機")), "家用機：內容", "不重複加");
    }
}
