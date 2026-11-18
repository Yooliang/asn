//! 每個視窗「帶了哪幾條額度窗」的變化記錄（#1730）：只寫 log，不影響任何收或不收的判斷。
//! 形狀從原始讀數直接看（還沒過 `window()` 的篩選），才分得出「沒帶那條」與「帶了但沒有數字」。
//! log 只寫視窗代號（對話紀錄路徑的雜湊前 6 碼，跟其他 log 一樣）與形狀，不寫百分比、重置時間或任何別的內容。
use super::{iso_secs, merge, owner, state};
use serde_json::Value;
use std::path::Path;

/// 最多記幾個視窗的上次形狀
const MAX_WINDOWS: usize = 30;

/// 一條額度窗在這筆讀數裡的形狀
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// 有帶、已用百分比是數字
    Num,
    /// 有帶這條，但已用百分比是 null 或不是數字
    Null,
    /// 這條的鍵不存在
    Missing,
}

impl Shape {
    fn label(self) -> &'static str {
        match self {
            Shape::Num => "num",
            Shape::Null => "null",
            Shape::Missing => "missing",
        }
    }
}

fn shape_of(rl: Option<&Value>, key: &str) -> Shape {
    let Some(w) = rl.and_then(|r| r.get(key)) else { return Shape::Missing };
    if w.get("used_percentage").is_some_and(|u| u.as_f64().is_some()) {
        Shape::Num
    } else {
        Shape::Null
    }
}

/// 原始狀態列資料 → (five_hour, seven_day) 兩條的形狀（鍵名照原始 JSON）
pub fn window_shapes(input: &Value) -> (Shape, Shape) {
    let rl = input.get("rate_limits");
    (shape_of(rl, "five_hour"), shape_of(rl, "seven_day"))
}

/// 形狀組合的文字（也是存進狀態檔拿來比的值）
pub fn combo_text(s: (Shape, Shape)) -> String {
    format!("five_hour={} seven_day={}", s.0.label(), s.1.label())
}

/// 跟上次記過的組合比：不一樣（或沒記過）才回要寫的 log 內容，一樣回 None
pub fn should_log(prev: Option<&str>, id: &str, now: (Shape, Shape)) -> Option<String> {
    let combo = combo_text(now);
    (prev != Some(combo.as_str())).then(|| format!("視窗 {id} 帶的額度窗：{combo}"))
}

/// 掛鉤入口：這個視窗帶的組合跟上次記的不同就寫一行 log、更新狀態檔。沒帶 transcript_path 或不是 JSON 就什麼都不做。
pub(crate) fn note(home: &Path, input: &str, now_ms: i64) {
    let Some(path) = owner::transcript_of(input) else { return };
    let Ok(v) = serde_json::from_str::<Value>(input) else { return };
    let id = owner::short_hash(&path.to_string_lossy());
    let shapes = window_shapes(&v);
    let mut st = state::load(home);
    let Some(line) = should_log(st.window_shapes.get(&id).map(String::as_str), &id, shapes) else { return };
    merge::append_log(&merge::log_path(home), &format!("{} {line}\n", iso_secs(now_ms)));
    st.window_shapes.insert(id.clone(), combo_text(shapes));
    while st.window_shapes.len() > MAX_WINDOWS {
        let Some(drop) = st.window_shapes.keys().find(|k| **k != id).cloned() else { break };
        st.window_shapes.remove(&drop);
    }
    state::save(home, &st);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 形狀分類_數字_null_非數字字串_沒帶() {
        let v = json!({ "rate_limits": {
            "five_hour": { "used_percentage": 12.5, "resets_at": 1 },
            "seven_day": { "used_percentage": null }
        }});
        assert_eq!(window_shapes(&v), (Shape::Num, Shape::Null));
        let v = json!({ "rate_limits": { "five_hour": { "used_percentage": "abc" } } });
        assert_eq!(window_shapes(&v), (Shape::Null, Shape::Missing));
        let v = json!({ "rate_limits": { "seven_day": { "resets_at": 1 } } });
        assert_eq!(window_shapes(&v), (Shape::Missing, Shape::Null));
        assert_eq!(window_shapes(&json!({})), (Shape::Missing, Shape::Missing));
    }

    #[test]
    fn 組合沒變不再記_變了才記() {
        let a = (Shape::Missing, Shape::Num);
        let first = should_log(None, "ab12cd", a).unwrap();
        assert_eq!(first, "視窗 ab12cd 帶的額度窗：five_hour=missing seven_day=num");
        assert!(should_log(Some(&combo_text(a)), "ab12cd", a).is_none());
        let b = (Shape::Num, Shape::Num);
        assert!(should_log(Some(&combo_text(a)), "ab12cd", b).is_some());
    }

    #[test]
    fn 各視窗各自比對() {
        let a = (Shape::Num, Shape::Null);
        let prev_x = combo_text(a);
        // 視窗 x 沒變、視窗 y 第一次出現：只有 y 要記
        assert!(should_log(Some(&prev_x), "x", a).is_none());
        assert!(should_log(None, "y", a).is_some());
    }

    #[test]
    fn log_不含百分比與重置時間() {
        let v = json!({ "rate_limits": {
            "five_hour": { "used_percentage": 87.25, "resets_at": 1792850400 },
            "seven_day": { "used_percentage": 43, "resets_at": 1793000000 }
        }});
        let line = should_log(None, "ab12cd", window_shapes(&v)).unwrap();
        for s in ["87", "43", "1792850400", "1793000000"] {
            assert!(!line.contains(s), "{line}");
        }
    }
}
