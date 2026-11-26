//! 參數裡「看起來是一段 JSON」的字串：能解開的往裡面找路徑，解不開的沒辦法判定，偏向擋。
use serde_json::Value;

/// 字串本身是一段 JSON 物件或陣列（前綴先篩，免得每個字串都去解析）
pub(crate) fn json_container(s: &str) -> Option<Value> {
    let t = s.trim_start();
    if !t.starts_with(['{', '[']) {
        return None;
    }
    serde_json::from_str::<Value>(s).ok().filter(|v| matches!(v, Value::Object(_) | Value::Array(_)))
}

/// 長得像 JSON 容器的字串（不管解不解得開）：去掉開頭的位元組順序記號與空白後，以 `{` 或 `[` 開頭，
/// 或以引號開頭而且裡面有 `{`（多重編碼）。這種字串路徑判定看不透，一律當解析不了
pub(crate) fn container_like(s: &str) -> bool {
    let t = s.trim_start_matches('\u{feff}').trim();
    t.starts_with(['{', '[']) || (t.starts_with('"') && t.contains('{'))
}
