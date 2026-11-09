//! 黃金檔（golden file）比對工具，只在測試編譯。
//!
//! 鎖的是什麼：把純函式在一批固定輸入下的「現況輸出」記成檔案，之後任何行為改動都會讓測試變紅，
//! 逼著改的人看過差異再決定要不要更新黃金檔。黃金檔記的是現況，不是期望。
//!
//! 用法：黃金檔用 `include_str!` 編進測試（比對時不碰檔案系統），所以測試寫成
//! `golden!("term/xxx.json", &actual)`。
//! - 平常：逐位元組比對（兩邊先把 `\r\n` 換成 `\n`），不一致就 panic 並印出前幾個差異行。
//! - `ASN_UPDATE_GOLDEN=1`：改為把實際輸出寫回 `tests/golden/<name>`（LF 換行），寫完要重跑一次才會比對到新內容（因為是編譯期嵌入）。
//! - CI 守門：`ASN_UPDATE_GOLDEN` 與 `CI` 同時存在就直接 panic，CI 只能比對、不能重寫黃金檔。

use std::path::PathBuf;

/// 比對方式
#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    /// 只比對
    Compare,
    /// 重寫黃金檔
    Update,
}

/// 由兩個環境變數的值（None＝沒設）決定模式。抽成純函式好測：update+ci 一律拒絕。
pub fn decide_mode(update_env: Option<&str>, ci_env: Option<&str>) -> Result<Mode, String> {
    match (update_env, ci_env) {
        (Some(_), Some(_)) => Err("CI 環境不准用 ASN_UPDATE_GOLDEN 重寫黃金檔（CI 只能比對）".into()),
        (Some(_), None) => Ok(Mode::Update),
        (None, _) => Ok(Mode::Compare),
    }
}

fn norm(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// 前幾個差異行（行號從 1 起算），最多 `max` 行
pub fn diff_lines(expected: &str, actual: &str, max: usize) -> Vec<String> {
    let e: Vec<&str> = expected.split('\n').collect();
    let a: Vec<&str> = actual.split('\n').collect();
    let mut out = Vec::new();
    for i in 0..e.len().max(a.len()) {
        let (el, al) = (e.get(i), a.get(i));
        if el != al {
            out.push(format!("第 {} 行\n  黃金檔：{:?}\n  實際值：{:?}", i + 1, el, al));
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

/// 黃金檔在原始碼樹裡的位置（更新模式才用到）
fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name)
}

/// 比對（或依環境變數更新）。`expected` 是 `include_str!` 進來的黃金檔內容
pub fn check(name: &str, expected: &str, actual: &str) {
    let update = std::env::var("ASN_UPDATE_GOLDEN").ok();
    let ci = std::env::var("CI").ok();
    match decide_mode(update.as_deref(), ci.as_deref()) {
        Err(why) => panic!("{why}"),
        Ok(Mode::Update) => {
            let path = golden_path(name);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).expect("建立黃金檔資料夾");
            }
            std::fs::write(&path, norm(actual)).expect("寫入黃金檔");
        }
        Ok(Mode::Compare) => {
            if let Err(why) = compare(name, expected, actual) {
                panic!("{why}");
            }
        }
    }
}

/// 純比對（不看環境變數）：兩邊先換行正規化再逐位元組比
pub fn compare(name: &str, expected: &str, actual: &str) -> Result<(), String> {
    let (e, a) = (norm(expected), norm(actual));
    if e == a {
        return Ok(());
    }
    Err(format!("黃金檔 {name} 與實際輸出不一致（要有意更新請用 ASN_UPDATE_GOLDEN=1 重跑並審過 git diff）：\n{}", diff_lines(&e, &a, 5).join("\n")))
}

/// 穩定序列化：呼叫端只傳 struct／BTreeMap／Vec（不要傳 HashMap），結尾補一個換行
pub fn to_golden<T: serde::Serialize>(v: &T) -> String {
    let mut s = serde_json::to_string_pretty(v).expect("序列化黃金檔");
    s.push('\n');
    s
}

/// 比對黃金檔：`golden!("term/xxx.json", &actual_string)`
#[macro_export]
macro_rules! golden {
    ($name:literal, $actual:expr) => {
        $crate::golden_util::check($name, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/", $name)), $actual)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 更新旗標加_ci_一律拒絕() {
        assert!(decide_mode(Some("1"), Some("true")).is_err());
        assert!(decide_mode(Some("1"), Some("")).is_err(), "CI 只要有設（就算是空字串）也算");
        assert!(decide_mode(Some("0"), Some("1")).is_err(), "旗標只要有設就算，不看值");
    }

    #[test]
    fn 模式判斷_只有更新旗標且沒有_ci_才會重寫() {
        assert_eq!(decide_mode(Some("1"), None), Ok(Mode::Update));
        assert_eq!(decide_mode(None, None), Ok(Mode::Compare));
        assert_eq!(decide_mode(None, Some("true")), Ok(Mode::Compare));
    }

    #[test]
    fn 比對前_crlf_與_lf_視為相同() {
        assert_eq!(norm("a\r\nb\r\n"), "a\nb\n");
        assert!(compare("t", "x\r\ny\n", "x\ny\n").is_ok());
    }

    #[test]
    fn 內容不同就回錯誤並指出行號() {
        let e = compare("t", "x\n", "y\n").unwrap_err();
        assert!(e.contains("不一致") && e.contains("第 1 行"));
    }

    #[test]
    fn 差異行最多印指定行數() {
        let d = diff_lines("a\nb\nc\nd", "a\nB\nC\nD", 2);
        assert_eq!(d.len(), 2);
        assert!(d[0].contains("第 2 行"));
    }
}
