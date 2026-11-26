//! 各家「列型號」輸出的解析器：全是純函式，輸入文字、輸出 `ModelEntry`；用真實樣本測。
//! 壞列一律丟掉、不整份拒收；筆數有上限。
use super::ModelEntry;
use serde_json::Value;

/// 解析時每家最多留幾筆（讀進來之後的上限；讀取上限在 `run::STDOUT_CAP`，回報上限在下面兩個）
pub const MAX_MODELS: usize = 300;
/// **回報上限**（R9）：精簡後要報出去的，每家最多幾筆
pub const REPORT_MAX_MODELS: usize = 50;
/// **回報上限**（R9）：所有家合計，代號與顯示名的位元組總和最多這麼多（與 pi_models 的 24000 同級，另外計算）
pub const REPORT_MAX_BYTES: usize = 24_000;
/// 顯示名最多幾個字
const NAME_MAX_CHARS: usize = 80;

/// 模型代號的統一格式（#2353 R3）：英數開頭（不會被當成旗標）、其後只收 `. _ : / @ + [ ] -`、最多 100 字。
/// 與前端 `ui/lib/model-id.mjs`、pi 的 SAFE 同一條；向量在 `relay/shared/test-vectors/model-id.json`，兩邊讀同一份。
/// （SQL 與 Edge Function 在第②階段才改。）
pub const MODEL_ID_PATTERN: &str = r"^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$";

pub fn valid_model_id(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '+' | '[' | ']' | '-'))
}

/// 顯示名：拿掉控制字元、頭尾空白、截斷；空的就用代號
fn clean_name(raw: &str, id: &str) -> String {
    let n: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(NAME_MAX_CHARS).collect();
    if n.is_empty() {
        id.to_string()
    } else {
        n
    }
}

fn push_unique(out: &mut Vec<ModelEntry>, id: &str, name: &str) -> bool {
    if out.len() >= MAX_MODELS {
        return false;
    }
    if valid_model_id(id) && !out.iter().any(|m| m.id == id) {
        out.push(ModelEntry { id: id.to_string(), name: clean_name(name, id) });
    }
    true
}

/// `agy models`（stdout）：一行「代號<Tab>顯示名」；空行、沒有 Tab 的行（說明文字）略過；重複的代號只留第一個
pub fn parse_agy(stdout: &str) -> Vec<ModelEntry> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let Some((id, rest)) = line.split_once('\t') else { continue };        // 第二欄之後（若還有 Tab）不要
        let name = rest.split('\t').next().unwrap_or("");
        if !push_unique(&mut out, id.trim(), name) {
            break;
        }
    }
    out
}

/// `pi --list-models` 的表格：代號寫成「提供者/型號」（不同提供者可能有同名型號），顯示名＝型號
pub fn parse_pi(text: &str) -> Vec<ModelEntry> {
    let mut out = Vec::new();
    for m in crate::launch::pi_models::parse_models(text) {
        if !push_unique(&mut out, &format!("{}/{}", m.provider, m.model), &m.model) {
            break;
        }
    }
    out
}

/// `codex debug models` 的 JSON：只收 `visibility == "list"` 的（`hide` 是 CLI 自己不給人選的內部型號，
/// 例如 gpt-reserve、codex-auto-review），照 `priority` 由小到大排（沒有的排最後，同分照原順序）。
/// 不是合法 JSON、或沒有 `models` 陣列＝回錯誤原因（給 log）
pub fn parse_codex(text: &str) -> Result<Vec<ModelEntry>, String> {
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).map_err(|e| format!("輸出不是合法的 JSON：{e}"))?;
    let arr = v.get("models").and_then(Value::as_array).ok_or_else(|| "輸出缺少 models 陣列".to_string())?;
    let mut rows: Vec<(i64, &Value)> = arr.iter().filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list")).map(|m| (m.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX), m)).collect();
    rows.sort_by_key(|(p, _)| *p);
    let mut out = Vec::new();
    for (_, m) in rows {
        let Some(slug) = m.get("slug").and_then(Value::as_str) else { continue };
        if !push_unique(&mut out, slug.trim(), m.get("display_name").and_then(Value::as_str).unwrap_or("")) {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX_REAL: &str = include_str!("../../../tests/fixtures/codex-models/debug-models.json");
    /// 向量與前端 ui/lib/model-id.mjs 的測試讀同一份
    const VECTORS: &str = include_str!("../../../../../shared/test-vectors/model-id.json");

    #[test]
    fn codex_真實輸出_只列_list_的_hide_的不列_依_priority() {
        let m = parse_codex(CODEX_REAL).unwrap();
        let ids: Vec<&str> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"]);
        assert_eq!(m[0].name, "GPT-6-Luna");
        assert!(!ids.contains(&"gpt-reserve") && !ids.contains(&"codex-auto-review"));
    }

    #[test]
    fn codex_兩百多_kb_的原始輸出照樣解析得出來() {
        // 真實原始輸出約 262 KB，大半是每個型號的 base_instructions；用合成的同等大小資料驗解析不受大小影響
        let filler = "x".repeat(5_000);
        let rows: Vec<String> = (0..52).map(|i| format!(r#"{{"slug":"m-{i}","display_name":"M {i}","visibility":"list","priority":{i},"base_instructions":"{filler}"}}"#)).collect();
        let raw = format!(r#"{{"models":[{}]}}"#, rows.join(","));
        assert!(raw.len() > 255 * 1024 && raw.len() < super::super::run::STDOUT_CAP, "{}", raw.len());
        let m = parse_codex(&raw).unwrap();
        assert_eq!(m.len(), 52);
        assert_eq!(m[51].id, "m-51");
    }

    #[test]
    fn codex_壞輸出回原因_不丟例外() {
        assert!(parse_codex("").is_err());
        assert!(parse_codex("not json").unwrap_err().contains("JSON"));
        assert!(parse_codex("{}").unwrap_err().contains("models"));
        assert!(parse_codex(r#"{"models":[]}"#).unwrap().is_empty());
        // BOM、priority 缺的排最後、代號不合法的丟掉、顯示名缺就用代號
        let t = "\u{feff}{\"models\":[{\"slug\":\"b\",\"visibility\":\"list\"},{\"slug\":\"-x\",\"visibility\":\"list\",\"priority\":0},{\"slug\":\"a\",\"visibility\":\"list\",\"priority\":1,\"display_name\":\"A\\u0007\"},{\"visibility\":\"list\"},{\"slug\":\"c\"}]}";
        let m = parse_codex(t).unwrap();
        assert_eq!(m, vec![ModelEntry { id: "a".into(), name: "A".into() }, ModelEntry { id: "b".into(), name: "b".into() }]);
    }

    #[test]
    fn agy_取代號與顯示名_略過空行說明與重複() {
        // 實機樣本（2026-11-26 在 w02 跑 `agy models` 的 stdout，27 行，與原始輸出逐位元組相同）
        let sample = include_str!("../../../tests/fixtures/agy-models/sample.txt");
        let m = parse_agy(sample);
        assert_eq!(m.len(), 27, "27 行都要列");
        assert_eq!(m[0], ModelEntry { id: "gemini-4-neon-high".into(), name: "Gemini 4 Neon (High)".into() });
        assert!(m.iter().any(|x| x.id == "gemini-pro-orchestrator" && x.name == "Orchestrator (Carbon)"));
        // R7：不用前綴過濾，CLI 自己列的 claude-*、gpt-oss-* 都要在
        assert!(m.iter().any(|x| x.id == "claude-opus-5-5-low") && m.iter().any(|x| x.id == "claude-sonnet-5-5-high"));
        assert_eq!(m[26], ModelEntry { id: "gpt-oss-120b-medium".into(), name: "GPT-OSS 120B (Medium)".into() });
        // 換成 CRLF 也一樣
        assert_eq!(parse_agy(&sample.replace('\n', "\r\n")), m);
        let out = "a-1\tName A\r\n\nb-2\tName B\ta-1\tdup\na-1\tdup\nno-tab-line\nbad id\tX\n-x\tY\nc-3\t\n";
        assert_eq!(parse_agy(out), vec![ModelEntry { id: "a-1".into(), name: "Name A".into() }, ModelEntry { id: "b-2".into(), name: "Name B".into() }, ModelEntry { id: "c-3".into(), name: "c-3".into() }]);
        assert!(parse_agy("Fetching available models...\n").is_empty());
    }

    #[test]
    fn pi_表格_代號帶提供者_不同提供者的同名型號不衝突() {
        let t = "provider      model                       context  max-out  thinking  images\n\
aegis         aegis                       131.1K   8.2K     no        no    \n\
anthropic     claude-sonnet-5-5           1M       128K     yes       yes   \n\
aegis         claude-sonnet-5-5           1M       128K     yes       yes   \n";
        let m = parse_pi(t);
        let ids: Vec<&str> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["aegis/aegis", "anthropic/claude-sonnet-5-5", "aegis/claude-sonnet-5-5"]);
        assert_eq!(m[1].name, "claude-sonnet-5-5");
        assert!(parse_pi("").is_empty() && parse_pi("No models matching \"x\"").is_empty());
    }

    #[test]
    fn 筆數有上限() {
        let big: String = (0..500).map(|i| format!("m{i}\tN{i}\n")).collect();
        assert_eq!(parse_agy(&big).len(), MAX_MODELS);
    }

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
        // pi 現有的規則是同一條：兩邊對同一批輸入答案一樣
        for s in v["valid"].as_array().unwrap().iter().chain(v["invalid"].as_array().unwrap()) {
            let s = s.as_str().unwrap();
            assert_eq!(valid_model_id(s), crate::launch::pi_models::safe_name(s), "{s:?}");
        }
    }

    #[test]
    fn 前端_pi_的_safe_規則字串與統一規則相同() {
        // pi-models.mjs 的 SAFE 正規式與這裡的規則字串逐字相同（守門：兩邊有一邊改了就紅）
        let mjs = include_str!("../../../../ui/lib/pi-models.mjs");
        assert!(mjs.contains(&format!("const SAFE = /{MODEL_ID_PATTERN}/")), "pi-models.mjs 的 SAFE 與統一規則不同");
    }
}
