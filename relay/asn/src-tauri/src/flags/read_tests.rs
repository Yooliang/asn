//! 型別化讀取的對照測試（#2163 PR-2a）：把改之前各呼叫端的讀法原封不動抄成參考函式，
//! 用同一批輸入比對新讀法，結果必須完全相同。
use super::*;

/// 改之前 core.rs／worker.rs 的讀法（抄過來，邏輯一字不改，只是把 std::env::var 換成查詢結果）
fn old_on(v: Option<String>) -> bool {
    v.is_some_and(|v| v.trim() == "1")
}

/// 改之前 partner_ops.rs 的讀法
fn old_ms(v: Option<String>) -> u64 {
    v.and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| (1_000..=3_600_000).contains(v)).unwrap_or(600_000)
}

fn inputs() -> Vec<Option<String>> {
    let mut v: Vec<Option<String>> = vec![None];
    for s in [
        "", " ", "1", " 1 ", "\t1\n", "0", "true", "TRUE", "yes", "on", "2", "11", "01", "+1", "1.0", "-1", "abc", "１", "999", "1000", "999999", "1001", "600000", " 600000 ", "3600000", "3600001", "-5000", "+5000",
        "5000.5", "1e4", "0x10", "99999999999999999999", "18446744073709551615", "18446744073709551616", "5 000",
    ] {
        v.push(Some(s.to_string()));
    }
    v
}

#[test]
fn 開關_新讀法與舊讀法逐一相同() {
    for name in ["ASN_WAIT_ALERT", "ASN_FORWARD_EXACT", "ASN_FORWARD_EXACT_UNVERIFIED"] {
        for input in inputs() {
            let got = on_exact_1_from(&|n| if n == name { input.clone() } else { None }, name);
            assert_eq!(got, old_on(input.clone()), "{name} 輸入 {input:?}");
        }
    }
}

#[test]
fn 開關_語意是剛好等於_1_不是非_0_即開() {
    let t = |s: &str| on_exact_1_from(&|_| Some(s.to_string()), "ASN_WAIT_ALERT");
    assert!(t("1") && t(" 1 "));
    for s in ["", "0", "true", "2", "yes", "11", "01"] {
        assert!(!t(s), "{s:?} 不該算開");
    }
    assert!(!on_exact_1_from(&|_| None, "ASN_WAIT_ALERT"));
}

#[test]
fn 毫秒_新讀法與舊讀法逐一相同() {
    for input in inputs() {
        let got = ms_from(&|n| if n == "ASN_MOD_WAIT_MS" { input.clone() } else { None }, "ASN_MOD_WAIT_MS");
        assert_eq!(got, old_ms(input.clone()), "ASN_MOD_WAIT_MS 輸入 {input:?}");
    }
}

#[test]
fn 毫秒_邊界與預設() {
    let t = |s: Option<&str>| ms_from(&|_| s.map(|x| x.to_string()), "ASN_MOD_WAIT_MS");
    assert_eq!(t(None), 600_000);
    assert_eq!(t(Some("999")), 600_000);
    assert_eq!(t(Some("1000")), 1_000);
    assert_eq!(t(Some("3600000")), 3_600_000);
    assert_eq!(t(Some("3600001")), 600_000);
    assert_eq!(t(Some("-5000")), 600_000);
    assert_eq!(t(Some("abc")), 600_000);
    assert_eq!(t(Some(" 5000 ")), 5_000);
}

#[test]
fn 這四個變數沒有舊名_登記表也沒寫舊名() {
    for name in ["ASN_WAIT_ALERT", "ASN_FORWARD_EXACT", "ASN_FORWARD_EXACT_UNVERIFIED", "ASN_MOD_WAIT_MS"] {
        let f = find(name).unwrap();
        assert!(f.legacy.is_none(), "{name} 本來就沒有舊名，不能憑空加");
        assert!(crate::envc::legacy(name).is_none(), "{name} 不在 PAIRS");
        assert_ne!(f.typed, Typed::None, "{name} 要登記型別化讀取規格");
    }
}

#[test]
fn 呼叫端不再直接讀這四個變數() {
    // 讀者檔仍寫著名字（傳給型別化讀取函式），但不能再出現 std::env::var(這四個名字)
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/bridge");
    for (file, name) in [("core.rs", "ASN_WAIT_ALERT"), ("core.rs", "ASN_FORWARD_EXACT_UNVERIFIED"), ("worker.rs", "ASN_FORWARD_EXACT"), ("partner_ops.rs", "ASN_MOD_WAIT_MS")] {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        assert!(!text.contains(&format!("std::env::var(\"{name}\")")), "{file} 還在直接讀 {name}");
    }
}
