//! 開新夥伴「經 pi」要用的資料（#351）：pi 現在能列哪些模型、各提供者有沒有登入。
//! 資料都由 pi 自己回答：`pi --list-models`（只列已設好憑證的提供者）與 `pi auth check --provider X --json`。
//! 絕不加 `--credentials`、不碰 `pi auth print-*`：不讀、不印任何憑證。
use serde::Serialize;
use serde_json::{json, Value};

const LIST_TIMEOUT_SECS: u64 = 10;
const MAX_MODELS: usize = 300;
/// 要問登入狀態的提供者：固定清單，不接受外面傳進來的名字（不會把使用者輸入拼進指令）
pub const KNOWN_PROVIDERS: [&str; 8] = ["anthropic", "openai-codex", "openai", "xai", "google", "deepseek", "minimax", "qwen"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PiModel {
    pub provider: String,
    pub model: String,
    pub context: String,
    pub thinking: bool,
    pub images: bool,
}

/// 名稱只收安全的字元與長度（它會顯示在畫面上，也會當 --provider／--model 的參數）
fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/' | ':' | '+' | '@' | '[' | ']'))
}

/// `pi --list-models` 的表格 → 模型列。第一行是標題；「No models matching」或空輸出＝空陣列；欄位不夠或名稱不安全的列丟掉。
pub fn parse_models(text: &str) -> Vec<PiModel> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 || cols[0] == "provider" {
            continue;
        }
        let (provider, model) = (cols[0], cols[1]);
        if !safe_name(provider) || !safe_name(model) {
            continue;
        }
        let yes = |s: &str| s.eq_ignore_ascii_case("yes");
        out.push(PiModel { provider: provider.into(), model: model.into(), context: cols[2].chars().take(12).collect(), thinking: yes(cols[4]), images: yes(cols[5]) });
        if out.len() >= MAX_MODELS {
            break;
        }
    }
    out
}

/// `pi auth check --json` 的一行 → "ready"／"not_ready"／"missing"（pi 沒有這個提供者）／"unknown"
pub fn parse_auth(text: &str) -> &'static str {
    let Some(v) = text.lines().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok()) else { return "unknown" };
    match (v.get("status").and_then(Value::as_str), v.get("reason").and_then(Value::as_str)) {
        (Some("ready"), _) => "ready",
        (Some("not_ready"), Some("provider_not_found")) => "missing",
        (Some("not_ready"), _) => "not_ready",
        _ => "unknown",
    }
}

pub fn models_real() -> Vec<PiModel> {
    match super::pi_setup::run_pi(&["--list-models"], LIST_TIMEOUT_SECS) {
        Ok((0, out)) => parse_models(&out),
        _ => Vec::new(),
    }
}

pub fn providers_real() -> Value {
    let mut rows = Vec::new();
    for p in KNOWN_PROVIDERS {
        let state = match super::pi_setup::run_pi(&["auth", "check", "--provider", p, "--json", "--no-refresh"], LIST_TIMEOUT_SECS) {
            Ok((_, out)) => parse_auth(&out),
            Err(_) => "unknown",
        };
        rows.push(json!({ "provider": p, "state": state }));
    }
    json!(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "provider      model                       context  max-out  thinking  images\n\
aegis         aegis                       131.1K   8.2K     no        no    \n\
anthropic     claude-sonnet-5-5           1M       128K     yes       yes   \n\
minimax       MiniMax-M3                  1M       524.3K   yes       yes   \n\
deepseek      deepseek-v4-pro             1M       384K     yes       no    \n";

    #[test]
    fn 解析模型表格_標題略過_欄位轉布林() {
        let m = parse_models(SAMPLE);
        assert_eq!(m.len(), 4);
        assert_eq!(m[1], PiModel { provider: "anthropic".into(), model: "claude-sonnet-5-5".into(), context: "1M".into(), thinking: true, images: true });
        assert!(!m[0].thinking && !m[0].images);
        assert!(m[3].thinking && !m[3].images);
    }

    #[test]
    fn 沒有結果_空輸出_壞列都不丟錯() {
        assert!(parse_models("").is_empty());
        assert!(parse_models("No models matching \"qwen\"").is_empty());
        assert!(parse_models("provider model\nonly three cols here\n").is_empty());
    }

    #[test]
    fn 不安全的名稱整列丟掉_不會變成參數或畫面文字() {
        let bad = "evil;rm   a b c yes yes\nok  model;x  1M 1K yes yes\nok  <script>  1M 1K yes yes\nfine  good-1  1M 1K no no\n";
        let m = parse_models(bad);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].model, "good-1");
    }

    #[test]
    fn 上限_最多三百筆() {
        let big: String = (0..400).map(|i| format!("p  m{i}  1M 1K yes yes\n")).collect();
        assert_eq!(parse_models(&big).len(), MAX_MODELS);
    }

    #[test]
    fn 登入檢查結果分四種() {
        assert_eq!(parse_auth(r#"{"status":"ready","provider":"anthropic","authType":"oauth"}"#), "ready");
        assert_eq!(parse_auth(r#"{"status":"not_ready","provider":"google","reason":"credentials_not_configured"}"#), "not_ready");
        assert_eq!(parse_auth(r#"{"status":"not_ready","provider":"qwen","reason":"provider_not_found"}"#), "missing");
        assert_eq!(parse_auth("garbage"), "unknown");
        assert_eq!(parse_auth(""), "unknown");
    }

    /// 真的跑這台的 pi（需要有裝 pi）：cargo test -- --ignored 才會跑
    #[test]
    #[ignore]
    fn 真機_models_real_列得出來_providers_real_分得出狀態() {
        let m = models_real();
        assert!(!m.is_empty(), "這台應該列得出模型");
        let p = providers_real();
        let arr = p.as_array().unwrap();
        assert_eq!(arr.len(), KNOWN_PROVIDERS.len());
        assert!(arr.iter().any(|r| r["provider"] == "qwen" && r["state"] == "missing"), "pi 1.4.0 沒有 qwen：{p}");
        eprintln!("models={} providers={p}", m.len());
    }

    #[test]
    fn 提供者清單是固定的_命令不吃外面的名字() {
        assert!(KNOWN_PROVIDERS.iter().all(|p| safe_name(p)));
        let src = include_str!("pi_models.rs");
        assert!(!src.contains("--credentials\", "), "不能把 --credentials 放進實際執行的參數");
        assert!(!src.contains("print-api-key\"") && !src.contains("print-bearer-token\""), "不碰會印憑證的子命令");
    }
}
