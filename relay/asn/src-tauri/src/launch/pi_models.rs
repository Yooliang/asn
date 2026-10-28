//! 開新夥伴「經 pi」要用的資料（#351）：pi 現在能列哪些模型、各提供者有沒有登入。
//! 資料都由 pi 自己回答：`pi --list-models`（只列已設好憑證的提供者）與 `pi auth check --provider X --json`。
//! 絕不加 `--credentials`、不碰 `pi auth print-*`：不讀、不印任何憑證。
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 結果快取多久（登入、改憑證後使用者可以傳 force 立刻重查）
pub const CACHE_TTL: Duration = Duration::from_secs(60);
static MODELS_CACHE: Mutex<Option<(Instant, Vec<PiModel>)>> = Mutex::new(None);
static PROVIDERS_CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

fn fresh<T: Clone>(slot: &Mutex<Option<(Instant, T)>>, now: Instant) -> Option<T> {
    let g = slot.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref().filter(|(at, _)| now.saturating_duration_since(*at) < CACHE_TTL).map(|(_, v)| v.clone())
}
fn store<T>(slot: &Mutex<Option<(Instant, T)>>, v: T) {
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), v));
}

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
pub(crate) fn safe_name(s: &str) -> bool {
    // 第一個字元必須是英數字：「-」開頭的會被 pi 當成旗標（例如 --resume），不能當 --provider／--model 的值
    s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/' | ':' | '+' | '@' | '[' | ']'))
}

/// 開 pi 時帶的 `--provider X --model Y`。兩個都空＝不帶（用 pi 自己的預設）；只給一個、或名稱不合法＝回錯，不悄悄忽略。
pub fn model_args(provider: &str, model: &str) -> Result<Vec<String>, String> {
    let (p, m) = (provider.trim(), model.trim());
    match (p.is_empty(), m.is_empty()) {
        (true, true) => Ok(Vec::new()),
        (false, false) if safe_name(p) && safe_name(m) => Ok(vec!["--provider".into(), p.into(), "--model".into(), m.into()]),
        (false, false) => Err("pi 的提供者或模型名稱含不允許的字元".into()),
        _ => Err("提供者和模型要一起給（只給了一個）".into()),
    }
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

/// force＝true 略過快取（使用者剛登入或剛設好憑證）。查失敗（沒有 pi、逾時）的空結果不進快取，下次再試
/// 名單回報附的模型清單（#443／#444）用的快取：名單每輪都會組摘要，pi --list-models 要開外部程序，所以另外留 10 分鐘
pub const SUMMARY_TTL: Duration = Duration::from_secs(600);
static SUMMARY_CACHE: Mutex<Option<(Instant, Vec<PiModel>)>> = Mutex::new(None);
/// 名單回報最多帶這麼多筆（後台也只收 200 筆）
pub const SUMMARY_MAX: usize = 200;

/// 給啟動設定摘要的 [{ provider, model }]：只有這兩欄、最多 200 筆（不帶憑證、路徑或其他設定）
pub fn summary_models() -> Vec<serde_json::Value> {
    let now = Instant::now();
    let list = {
        let g = SUMMARY_CACHE.lock().unwrap();
        g.as_ref().filter(|(at, _)| now.saturating_duration_since(*at) < SUMMARY_TTL).map(|(_, v)| v.clone())
    };
    let list = list.unwrap_or_else(|| {
        let v = models_real(false);
        *SUMMARY_CACHE.lock().unwrap() = Some((now, v.clone()));
        v
    });
    list.iter().take(SUMMARY_MAX).map(|m| serde_json::json!({ "provider": m.provider, "model": m.model })).collect()
}

pub fn models_real(force: bool) -> Vec<PiModel> {
    if !force {
        if let Some(v) = fresh(&MODELS_CACHE, Instant::now()) {
            return v;
        }
    }
    match super::pi_setup::run_pi(&["--list-models"], LIST_TIMEOUT_SECS) {
        Ok((0, out)) => {
            let v = parse_models(&out);
            store(&MODELS_CACHE, v.clone());
            v
        }
        _ => Vec::new(),
    }
}

fn check_one(p: &'static str) -> Value {
    let state = match super::pi_setup::run_pi(&["auth", "check", "--provider", p, "--json", "--no-refresh"], LIST_TIMEOUT_SECS) {
        Ok((_, out)) => parse_auth(&out),
        Err(_) => "unknown",
    };
    json!({ "provider": p, "state": state })
}

/// 8 個提供者同時查（各自一條執行緒，單一逾時 10 秒，整體最多約 10 秒），順序照 KNOWN_PROVIDERS
pub fn providers_real(force: bool) -> Value {
    if !force {
        if let Some(v) = fresh(&PROVIDERS_CACHE, Instant::now()) {
            return v;
        }
    }
    let rows: Vec<Value> = std::thread::scope(|sc| {
        let hs: Vec<_> = KNOWN_PROVIDERS.iter().map(|p| sc.spawn(move || check_one(p))).collect();
        hs.into_iter().zip(KNOWN_PROVIDERS).map(|(h, p)| h.join().unwrap_or_else(|_| json!({ "provider": p, "state": "unknown" }))).collect()
    });
    let v = json!(rows);
    if rows.iter().any(|r| r["state"] != "unknown") {
        store(&PROVIDERS_CACHE, v.clone());   // 全部 unknown（多半是沒有 pi）不進快取
    }
    v
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
        let m = models_real(true);
        assert!(!m.is_empty(), "這台應該列得出模型");
        let t = Instant::now();
        let p = providers_real(true);
        eprintln!("providers 並行耗時 {:?}", t.elapsed());
        let arr = p.as_array().unwrap();
        assert_eq!(arr.len(), KNOWN_PROVIDERS.len());
        assert!(arr.iter().any(|r| r["provider"] == "qwen" && r["state"] == "missing"), "pi 1.4.0 沒有 qwen：{p}");
        eprintln!("models={} providers={p}", m.len());
    }

    #[test]
    fn 開_pi_的模型參數_兩個都空不帶_只給一個或不合法就報錯() {
        assert_eq!(model_args("", "").unwrap(), Vec::<String>::new());
        assert_eq!(model_args(" ", " ").unwrap(), Vec::<String>::new());
        assert_eq!(model_args("anthropic", "claude-sonnet-5-5").unwrap(), ["--provider", "anthropic", "--model", "claude-sonnet-5-5"]);
        assert_eq!(model_args("minimax", "MiniMax-M3").unwrap().len(), 4);
        assert!(model_args("anthropic", "").is_err());
        assert!(model_args("", "m").is_err());
        assert!(model_args("a;b", "m").is_err());
        assert!(model_args("a", "m --api-key x").is_err(), "不能夾帶別的旗標");
        assert!(model_args("--resume", "m").is_err(), "以 - 開頭會被當成旗標");
        assert!(model_args("a", "--api-key").is_err());
        assert!(model_args("a", "-x").is_err());
        assert!(model_args("a", "_x").is_err(), "第一個字元一定要英數字");
        assert!(parse_models("--resume  m  1M 1K yes yes
ok  -m  1M 1K yes yes
ok  good  1M 1K yes yes
").iter().all(|m| m.model == "good"), "清單裡以 - 開頭的名稱也丟掉");
        assert!(model_args("a", &"x".repeat(101)).is_err());
    }

    #[test]
    fn 快取_六十秒內回同一份_過期或_force_才重查() {
        let slot: Mutex<Option<(Instant, u32)>> = Mutex::new(None);
        let t0 = Instant::now();
        assert_eq!(fresh(&slot, t0), None);
        store(&slot, 7);
        assert_eq!(fresh(&slot, Instant::now()), Some(7));
        assert_eq!(fresh(&slot, t0 + CACHE_TTL + Duration::from_secs(1)), None, "超過 60 秒就不算新鮮");
    }

    #[test]
    fn 提供者並行查_順序照固定清單() {
        // 不真的跑 pi：check_one 在沒有 pi 時回 unknown，順序與數量仍要對得上
        let rows: Vec<Value> = std::thread::scope(|sc| {
            let hs: Vec<_> = KNOWN_PROVIDERS.iter().map(|p| sc.spawn(move || json!({ "provider": p }))).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let names: Vec<&str> = rows.iter().map(|r| r["provider"].as_str().unwrap()).collect();
        assert_eq!(names, KNOWN_PROVIDERS);
    }

    #[test]
    fn 提供者清單是固定的_命令不吃外面的名字() {
        assert!(KNOWN_PROVIDERS.iter().all(|p| safe_name(p)));
        let src = include_str!("pi_models.rs");
        assert!(!src.contains("--credentials\", "), "不能把 --credentials 放進實際執行的參數");
        assert!(!src.contains("print-api-key\"") && !src.contains("print-bearer-token\""), "不碰會印憑證的子命令");
    }
}
