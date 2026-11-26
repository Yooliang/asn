//! 模型代號的統一格式（#2353 R3）。放在 crate 根、不加 cfg：電腦、手機、無視窗版都會編進去。
//! `agent_tools::models` 只是 re-export，既有呼叫端不用改。

/// 英數開頭（不會被當成旗標）、其後只收 `. _ : / @ + [ ] -`、最多 100 字。
/// 與前端 `ui/lib/model-id.mjs`、pi 的 SAFE 同一條；向量在 `relay/shared/test-vectors/model-id.json`，兩邊讀同一份。
/// （SQL 與 Edge Function 在第②階段才改。）
///
/// 字元集之外另加一條：以 `/` 切開後，每一段都不能是空字串、`.`、`..`
/// （所以 `a/../x`、`a//b`、`a/`、`./a` 都不合法；`a.b/c.d`、`openrouter/meta/llama-3` 合法）。
/// 前端 `ui/lib/model-id.mjs` 另寫一份同樣的分段檢查，兩邊讀同一份向量。
/// 即使如此，要拿代號組檔案路徑的地方仍應自己再檢查（或編碼）。
pub const MODEL_ID_PATTERN: &str = r"^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$";

pub fn valid_model_id(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.len() <= 100
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '+' | '[' | ']' | '-'))
        && s.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../../shared/test-vectors/model-id.json");

    #[test]
    fn 統一格式_照共用向量_且與_pi_的_safe_name_一致() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(v["pattern"].as_str().unwrap(), MODEL_ID_PATTERN, "向量檔與 Rust 的規則字串要逐字相同");
        for ok in v["valid"].as_array().unwrap() {
            let s = ok.as_str().unwrap();
            assert!(valid_model_id(s), "應該合法：{s:?}");
        }
        for bad in v["invalid"].as_array().unwrap() {
            let s = bad.as_str().unwrap();
            assert!(!valid_model_id(s), "應該不合法：{s:?}");
        }
        // pi 的 safe_name 只有字元集那條、沒有分段檢查：不含「空段／.／..」問題的輸入，兩邊答案一樣；
        // 有路徑段問題的輸入，valid_model_id 一定不合法（safe_name 合法不代表 valid_model_id 合法）
        for s in v["valid"].as_array().unwrap().iter().chain(v["invalid"].as_array().unwrap()) {
            let s = s.as_str().unwrap();
            if s.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
                assert!(!valid_model_id(s), "有空段、. 或 .. 的要不合法：{s:?}");
            } else {
                assert_eq!(valid_model_id(s), crate::launch::pi_models::safe_name(s), "{s:?}");
            }
        }
    }

    #[test]
    fn 前端_pi_的_safe_規則字串與統一規則相同() {
        // pi-models.mjs 的 SAFE 正規式與這裡的規則字串逐字相同（守門：兩邊有一邊改了就紅）
        let mjs = include_str!("../../ui/lib/pi-models.mjs");
        assert!(mjs.contains(&format!("const SAFE = /{MODEL_ID_PATTERN}/")), "pi-models.mjs 的 SAFE 與統一規則不同");
    }
}
