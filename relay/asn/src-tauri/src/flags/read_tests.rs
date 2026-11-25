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

// ---- PR-2b：電腦版的平台預設開關與路徑 ------------------------------------------------------

/// 改之前 `win_term::switches_from` 的內容（抄過來，windows 改成參數）
fn old_switches(windows: bool, wezterm: Option<&str>, mux: Option<&str>) -> (bool, bool) {
    if !windows {
        let wez = wezterm == Some("1");
        return (wez, wez && mux == Some("1"));
    }
    let wez = wezterm != Some("0");
    (wez, wez && mux != Some("0"))
}

/// 改之前 `screen_watch::enabled_on` 的內容
fn old_screen(windows: bool, value: Option<&str>) -> bool {
    if windows {
        value != Some("0")
    } else {
        value == Some("1")
    }
}

fn switch_inputs() -> Vec<Option<String>> {
    let mut v: Vec<Option<String>> = vec![None];
    for s in ["", " ", "0", "1", " 0", "0 ", " 1 ", "true", "false", "TRUE", "False", "off", "on", "yes", "2", "00", "01", "-1", "abc", "０"] {
        v.push(Some(s.to_string()));
    }
    v
}

#[test]
fn 平台開關_原始字串與直接讀環境變數相同() {
    for name in ["ASN_TERM_WEZTERM", "ASN_TERM_MUX", "ASN_SCREEN_WATCH"] {
        for input in switch_inputs() {
            // 沒有 trim、沒有改大小寫：舊讀法就是 std::env::var(名字).ok()
            assert_eq!(switch_raw_from(&|n| if n == name { input.clone() } else { None }, name), input, "{name} 輸入 {input:?}");
        }
    }
}

#[test]
fn 終端兩個開關_兩種平台都與舊讀法逐一相同() {
    use crate::launch::win_term::switches_on;
    for windows in [true, false] {
        for w in switch_inputs() {
            for m in switch_inputs() {
                let lookup = |n: &str| match n {
                    "ASN_TERM_WEZTERM" => w.clone(),
                    "ASN_TERM_MUX" => m.clone(),
                    _ => None,
                };
                let (nw, nm) = (switch_raw_from(&lookup, "ASN_TERM_WEZTERM"), switch_raw_from(&lookup, "ASN_TERM_MUX"));
                assert_eq!(
                    switches_on(windows, nw.as_deref(), nm.as_deref()),
                    old_switches(windows, w.as_deref(), m.as_deref()),
                    "windows={windows} wezterm={w:?} mux={m:?}"
                );
            }
        }
    }
}

#[test]
fn 終端兩個開關_沒設時的平台預設() {
    use crate::launch::win_term::switches_on;
    let none = |n: &str| switch_raw_from(&|_| None, n);
    assert_eq!(switches_on(true, none("ASN_TERM_WEZTERM").as_deref(), none("ASN_TERM_MUX").as_deref()), (true, true), "Windows 預設兩個都開");
    assert_eq!(switches_on(false, none("ASN_TERM_WEZTERM").as_deref(), none("ASN_TERM_MUX").as_deref()), (false, false), "其他平台預設兩個都關");
    // 其他平台 mux 要 wezterm 也開才算
    assert_eq!(switches_on(false, None, Some("1")), (false, false));
    assert_eq!(switches_on(false, Some("1"), Some("1")), (true, true));
    // Windows：wezterm 關著，mux 一定關
    assert_eq!(switches_on(true, Some("0"), Some("1")), (false, false));
}

#[test]
fn 讀畫面開關_兩種平台都與舊讀法逐一相同() {
    use crate::launch::screen_watch::enabled_on;
    for windows in [true, false] {
        for input in switch_inputs() {
            let raw = switch_raw_from(&|n| if n == "ASN_SCREEN_WATCH" { input.clone() } else { None }, "ASN_SCREEN_WATCH");
            assert_eq!(enabled_on(windows, raw.as_deref()), old_screen(windows, input.as_deref()), "windows={windows} 輸入 {input:?}");
        }
    }
    assert!(enabled_on(true, None) && !enabled_on(false, None), "沒設：Windows 開、其他平台關");
}

#[test]
fn 路徑_與舊讀法相同() {
    use std::ffi::OsString;
    use std::path::PathBuf;
    let inputs: Vec<Option<OsString>> = [None, Some(""), Some(" "), Some("C:\\wez"), Some("C:\\Program Files\\wez dir\\"), Some("/opt/wezterm"), Some("rel/dir"), Some(" /x ")]
        .into_iter()
        .map(|o| o.map(OsString::from))
        .collect();
    for input in inputs {
        let old: Option<PathBuf> = input.clone().map(PathBuf::from); // 舊：std::env::var_os(名字).map(PathBuf::from)
        let got = path_from(&|n| if n == "ASN_WEZTERM_DIR" { input.clone() } else { None }, "ASN_WEZTERM_DIR");
        assert_eq!(got, old, "輸入 {input:?}");
    }
    // 空字串：維持「設了但是空」的樣子，由 locate 決定當沒設（unix 分支用 filter 判空）
    assert_eq!(path_from(&|_| Some(OsString::new()), "ASN_WEZTERM_DIR"), Some(PathBuf::new()));
}

#[test]
fn 這四個變數沒有舊名_型別登記對了() {
    for (name, want) in [("ASN_TERM_WEZTERM", Typed::PlatformSwitch), ("ASN_TERM_MUX", Typed::PlatformSwitch), ("ASN_SCREEN_WATCH", Typed::PlatformSwitch), ("ASN_WEZTERM_DIR", Typed::Path)] {
        let f = find(name).unwrap();
        assert_eq!(f.typed, want, "{name}");
        assert!(f.legacy.is_none() && crate::envc::legacy(name).is_none(), "{name} 本來就沒有舊名，不能憑空加");
    }
    // 刻意不動：等 #1470
    assert_eq!(find("ASN_SEAL_NODE_KEY").unwrap().typed, Typed::None);
}

#[test]
fn 正式碼不再直接讀這四個變數() {
    let src = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, needles) in [
        ("launch/term.rs", vec!["std::env::var(super::win_term::ENV_", "std::env::var(super::screen_watch::ENV_SCREEN_WATCH)", "std::env::var(ENV_SCREEN_WATCH)"]),
        ("bridge/mod.rs", vec!["std::env::var(crate::launch::win_term::ENV_"]),
        ("launch/wezterm.rs", vec!["std::env::var_os(DIR_ENV)"]),
    ] {
        let text = std::fs::read_to_string(src.join(file)).unwrap();
        for n in needles {
            assert!(!text.contains(n), "{file} 還在直接讀環境變數：{n}");
        }
    }
}
