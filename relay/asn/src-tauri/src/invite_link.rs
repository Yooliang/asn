//! 邀請連結：從網址取出邀請碼。支援 asn://invite/<碼>（電腦）與 https://asnmessenger.web.app/i/<碼>（安卓 App Links）。
//! 只取碼，不做別的事；碼長什麼樣由 relay::valid_invite_code 決定。網址裡其他東西（查詢字串、片段、多餘路徑）一律忽略或拒絕。

/// 網址 → 邀請碼；不是邀請連結、碼的格式不對回 None
pub fn invite_code_from_url(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = if let Some(r) = strip_prefix_ci(u, "asn://invite/") {
        r
    } else if let Some(r) = strip_prefix_ci(u, "https://asnmessenger.web.app/i/") {
        r
    } else {
        return None;
    };
    let code = rest.split(['?', '#', '/']).next().unwrap_or("");
    crate::relay::valid_invite_code(code).then(|| code.to_string())
}

fn strip_prefix_ci<'a>(s: &'a str, p: &str) -> Option<&'a str> {
    s.get(..p.len()).filter(|h| h.eq_ignore_ascii_case(p)).map(|_| &s[p.len()..])
}

/// 第二個執行個體（點連結又開了一個 ASN）轉交邀請碼的信箱檔：寫在工作資料夾，正在跑的那個每 2 秒看一次、取走即刪。
/// 檔裡只放通過格式檢查的邀請碼，不放任何網址或憑證
pub const INBOX_FILE: &str = "invite-inbox.txt";
pub fn drop_in_inbox(dir: &std::path::Path, code: &str) -> std::io::Result<()> {
    if !crate::relay::valid_invite_code(code) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad code"));
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{INBOX_FILE}.tmp"));
    std::fs::write(&tmp, code)?;
    std::fs::rename(&tmp, dir.join(INBOX_FILE))
}
/// 取走信箱裡的邀請碼（檔案一律刪掉，內容壞了也刪）
pub fn take_from_inbox(dir: &std::path::Path) -> Option<String> {
    let p = dir.join(INBOX_FILE);
    let text = std::fs::read_to_string(&p).ok()?;
    let _ = std::fs::remove_file(&p);
    let code = text.trim();
    crate::relay::valid_invite_code(code).then(|| code.to_string())
}

/// 命令列參數裡找第一個邀請連結
pub fn invite_code_from_args<S: AsRef<str>>(args: &[S]) -> Option<String> {
    args.iter().find_map(|a| invite_code_from_url(a.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 邀請連結_兩種網址都能取出碼_其他一律不收() {
        let c = "AbCdEf0123456789_-xyz";
        assert_eq!(invite_code_from_url(&format!("asn://invite/{c}")).as_deref(), Some(c));
        assert_eq!(invite_code_from_url(&format!("  ASN://invite/{c}/ ")).as_deref(), Some(c));
        assert_eq!(invite_code_from_url(&format!("https://asnmessenger.web.app/i/{c}?x=1#y")).as_deref(), Some(c));
        for bad in [
            "asn://invite/短", "asn://invite/", "asn://other/AbCdEf0123456789_-xyz", "http://asnmessenger.web.app/i/AbCdEf0123456789_-xyz",
            "https://evil.example/i/AbCdEf0123456789_-xyz", "https://asnmessenger.web.app/i/AbCdEf0123456789%2f", "asn://invite/AbCdEf0123456789;rm", "", "C:\\asn.exe",
        ] {
            assert!(invite_code_from_url(bad).is_none(), "{bad}");
        }
        assert_eq!(invite_code_from_args(&["asn.exe", "--x", "asn://invite/AbCdEf0123456789_-xyz"]).as_deref(), Some("AbCdEf0123456789_-xyz"));
        assert!(invite_code_from_args::<&str>(&[]).is_none());
    }

    #[test]
    fn 信箱檔_只收格式正確的碼_取走即刪() {
        let d = std::env::temp_dir().join(format!("asn-inbox-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(drop_in_inbox(&d, "bad").is_err() && take_from_inbox(&d).is_none());
        drop_in_inbox(&d, "AbCdEf0123456789_-xyz").unwrap();
        assert_eq!(take_from_inbox(&d).as_deref(), Some("AbCdEf0123456789_-xyz"));
        assert!(take_from_inbox(&d).is_none(), "取走即刪");
        std::fs::write(d.join(INBOX_FILE), "asn://不是碼").unwrap();
        assert!(take_from_inbox(&d).is_none() && !d.join(INBOX_FILE).exists(), "壞內容也刪掉");
        let _ = std::fs::remove_dir_all(&d);
    }
}