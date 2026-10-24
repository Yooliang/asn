//! 無人值守寄信（Linux 收件匣節點）：只有明確啟用才放行，視窗名只取 ASN_INBOX_NAME／節點代號，其餘防護不變
use super::*;
use crate::cli::env::unattended_enabled;

/// 沒有任何 Claude 視窗的無頭環境（行程鏈上沒有 session）；on＝已啟用無人值守
fn headless(url: &str, on: bool, name: Option<&str>) -> Fx {
    let mut f = fx(url, Some("不該被用到"));
    f.env.procs = Arc::new(|| Ok([(SELF_PID, (1u32, "asn-cli".to_string()))].into_iter().collect()));
    f.env.unattended = on;
    f.env.inbox_name = name.map(String::from);
    f
}

#[test]
fn 啟用條件_要環境變數加收件匣資料夾且不是_windows() {
    for v in ["1", "true", "YES", " on "] {
        assert!(unattended_enabled(Some(v), true, false), "{v}");
    }
    assert!(!unattended_enabled(None, true, false), "沒設環境變數＝預設關閉");
    for v in ["", "0", "false", "off", "2"] {
        assert!(!unattended_enabled(Some(v), true, false), "{v}");
    }
    assert!(!unattended_enabled(Some("1"), false, false), "沒有收件匣資料夾＝不是收件匣節點");
    assert!(!unattended_enabled(Some("1"), true, true), "Windows 一律不放行");
}

#[test]
fn 預設關閉_沒有視窗照舊拒絕_不打後端() {
    let b = backend(200);
    let f = headless(&b.url(), false, Some("T-收件匣"));
    let (c, _, err) = go(&f.env, &["send", "--to", "PC1", "--body", "x", "--no-reply"], "");
    assert_eq!(c, 2);
    assert!(err.contains("找不到呼叫者所屬的 Claude 視窗"), "{err}");
    let (c, _, err) = go(&f.env, &["send", "--room", "g1", "--body", "x"], "");
    assert_eq!(c, 2, "{err}");
    assert_eq!(b.count(), 0);
}

#[test]
fn 啟用後_寄信與群組發言用收件匣名_沒設名字就用節點代號() {
    let b = backend(200);
    let f = headless(&b.url(), true, Some("T-收件匣"));
    let (c, out, err) = go(&f.env, &["send", "--to", "PC1", "--body", "早安", "--no-reply"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.starts_with(&format!("sent id={NEW_ID} to=PC1 from=T/T-收件匣")), "{out}");
    assert_eq!(b.of("send")[0].json()["from_agent"], "T-收件匣");
    let (c, out, err) = go(&f.env, &["send", "--room", "g1", "--body", "大家好"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.contains("posted room=g1") && out.contains("from=T/T-收件匣"), "{out}");
    assert_eq!(b.of("room_post")[0].json()["from_agent"], "T-收件匣");
    let d = headless(&b.url(), true, None);
    assert_eq!(go(&d.env, &["send", "--to", "PC1", "--body", "x", "--no-reply"], "").0, 0);
    assert_eq!(b.of("send")[1].json()["from_agent"], "T", "沒設 ASN_INBOX_NAME＝節點代號");
}

#[test]
fn 啟用後仍不能自填寄件人_也不開放收信() {
    let b = backend(200);
    let f = headless(&b.url(), true, Some("T-收件匣"));
    let (c, _, err) = go(&f.env, &["send", "--to", "PC1", "--body", "x", "--from-agent", "P-主線-3", "--no-reply"], "");
    assert_eq!(c, 1);
    assert!(err.contains("不認得的參數 --from-agent"), "{err}");
    let (c, _, err) = go(&f.env, &["recv", "--once"], "");
    assert_eq!(c, 2, "{err}");
    assert!(err.contains("找不到呼叫者所屬的 Claude 視窗"), "{err}");
    assert_eq!(b.count(), 0);
}

#[test]
fn 啟用後頻率限制照舊_每視窗每小時上限() {
    let b = backend(200);
    let mut f = headless(&b.url(), true, Some("T-收件匣"));
    f.env.send_per_hour = 1;
    assert_eq!(go(&f.env, &["send", "--to", "PC1", "--body", "一", "--no-reply"], "").0, 0);
    let (c, _, err) = go(&f.env, &["send", "--room", "g1", "--body", "二"], "");
    assert_eq!(c, 3);
    assert!(err.contains("被擋：視窗「T-收件匣」每小時最多寄 1 封"), "{err}");
}

#[test]
fn 啟用後有_claude_視窗時仍以視窗為準() {
    let b = backend(200);
    let mut f = fx(&b.url(), Some("T-視窗甲"));
    f.env.unattended = true;
    f.env.inbox_name = Some("T-收件匣".into());
    assert_eq!(go(&f.env, &["send", "--to", "PC1", "--body", "x", "--no-reply"], "").0, 0);
    assert_eq!(b.of("send")[0].json()["from_agent"], "T-視窗甲");
}
