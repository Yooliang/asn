//! 內建通道工作者「切換模型」後記下來的模型：工作資料夾的 acp-models.json（{"version":1,"models":{名字: 模型}}）。
//! 啟動工作者時蓋過三種來源（agents.json、開新夥伴名冊、接手名冊）的 model；不改寫使用者手寫的 agents.json。
//! 檔案壞了就當沒有（照原設定啟動、記一行 log），工作者不會因此起不來。寫檔一律原子寫入。
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

pub const MODELS_FILE: &str = "acp-models.json";

/// 列 agy 可選模型最多等這麼久
pub const AGY_MODELS_TIMEOUT: Duration = Duration::from_secs(20);

/// 模型代號只收英數與 . _ -，開頭要是英數（不會被當成旗標），最多 60 字
pub fn valid_model(m: &str) -> bool {
    let b = m.as_bytes();
    !b.is_empty() && b.len() <= 60 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// 讀檔：沒有檔案＝空；內容壞了回錯誤原因（呼叫端決定要不要記 log）
pub fn read(file: &Path) -> Result<HashMap<String, String>, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("讀不到 {}：{e}", file.display())),
    };
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{} 不是合法的 JSON：{e}", file.display()))?;
    let models = v.get("models").and_then(Value::as_object).ok_or_else(|| format!("{} 缺少 models", file.display()))?;
    Ok(models.iter().filter_map(|(k, m)| m.as_str().filter(|m| valid_model(m)).map(|m| (k.clone(), m.to_string()))).collect())
}

/// 讀檔給啟動用：壞了就記 log、當沒有
pub fn load(file: &Path, log: &dyn Fn(String)) -> HashMap<String, String> {
    read(file).unwrap_or_else(|e| {
        log(format!("acp: 記下的模型讀不懂，照原設定啟動：{e}"));
        HashMap::new()
    })
}

fn write(file: &Path, models: &HashMap<String, String>) -> Result<(), String> {
    let mut keys: Vec<&String> = models.keys().collect();
    keys.sort();
    let map: Map<String, Value> = keys.into_iter().map(|k| (k.clone(), json!(models[k]))).collect();
    crate::write_atomic(file, &json!({ "version": 1, "models": map }).to_string()).map_err(|e| format!("記不下選好的模型（{}）：{e}", file.display()))
}

/// 記下某個工作者選好的模型（原本的檔案壞了就從空的重寫）
pub fn set(file: &Path, name: &str, model: &str) -> Result<(), String> {
    let mut m = read(file).unwrap_or_default();
    m.insert(name.to_string(), model.to_string());
    write(file, &m)
}

/// 移除夥伴時一併刪掉它記下的模型，免得同名的新夥伴繼承到舊模型
pub fn remove(file: &Path, name: &str) -> Result<(), String> {
    let mut m = read(file).unwrap_or_default();
    if m.remove(name).is_none() {
        return Ok(());
    }
    write(file, &m)
}

/// `agy models` 的輸出（stdout；開頭的「Fetching available models...」在 stderr）：一行一個「模型代號<Tab>顯示名稱」，取第一欄
pub fn parse_agy_models(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for line in stdout.lines() {
        let id = line.split('\t').next().unwrap_or("").trim();
        if valid_model(id) && !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// 跑 `<agy> models` 列出可選的模型（agy 原生通道用）。指令與前置參數照工作者設定，環境照工作者的白名單；逾時就結束它
pub async fn agy_models(cfg: &super::acp_config::WorkerCfg, env: &[(String, String)]) -> Result<Vec<String>, String> {
    use crate::nowin::NoWindow;
    let mut cmd = tokio::process::Command::new(&cfg.command);
    cmd.no_window()
        .args(&cfg.args)
        .arg("models")
        .current_dir(&cfg.cwd)
        .env_clear()
        .envs(super::acp_clean_env(env, &cfg.env_pass))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(AGY_MODELS_TIMEOUT, cmd.output()).await.map_err(|_| "列可選模型太久沒有回應".to_string())?.map_err(|e| format!("列不出可選的模型：{e}"))?;
    if !out.status.success() {
        return Err("列不出可選的模型（可能要先在這台電腦登入 agy）".into());
    }
    let list = parse_agy_models(&String::from_utf8_lossy(&out.stdout));
    if list.is_empty() {
        return Err("這個工作者沒有列出可選的模型".into());
    }
    Ok(list)
}

/// 「不在清單裡」的說明：附上可選的（最多列 20 個）
pub fn not_listed(model: &str, list: &[String]) -> String {
    let shown: Vec<&str> = list.iter().take(20).map(String::as_str).collect();
    let more = if list.len() > shown.len() { format!(" 等 {} 個", list.len()) } else { String::new() };
    format!("「{model}」不在這個工作者可選的模型裡。可選：{}{more}", shown.join("、"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 模型代號_只收英數與點底線連字號_開頭不能是符號() {
        for ok in ["grok-4.7", "gemini-3.8-flash-high", "a", "x_1"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "-x", ".x", "a b", "a/b", "a[b]", "a;rm", &"a".repeat(61)] {
            assert!(!valid_model(bad), "{bad}");
        }
    }

    #[test]
    fn 記下_讀回_移除_原子寫入() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(MODELS_FILE);
        assert!(read(&f).unwrap().is_empty(), "沒有檔案＝空");
        set(&f, "Gemini", "gemini-4-argon-high").unwrap();
        set(&f, "Grok", "grok-4.6").unwrap();
        let m = read(&f).unwrap();
        assert_eq!((m["Gemini"].as_str(), m["Grok"].as_str()), ("gemini-4-argon-high", "grok-4.6"));
        remove(&f, "Gemini").unwrap();
        assert_eq!(read(&f).unwrap().len(), 1);
        remove(&f, "沒有這個").unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(d.path()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "沒有留下暫存檔：{leftovers:?}");
    }

    #[test]
    fn 檔案壞了_讀檔回原因_啟動用的當沒有並記log_再記一筆會重寫成好的() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(MODELS_FILE);
        std::fs::write(&f, "{壞").unwrap();
        assert!(read(&f).is_err());
        let logs = std::sync::Mutex::new(vec![]);
        assert!(load(&f, &|m| logs.lock().unwrap().push(m)).is_empty());
        assert!(logs.lock().unwrap()[0].contains("照原設定啟動"));
        set(&f, "A", "m1").unwrap();
        assert_eq!(read(&f).unwrap()["A"], "m1");
        // 不合法的值被略過
        std::fs::write(&f, r#"{"version":1,"models":{"A":"-x","B":"ok-1","C":3}}"#).unwrap();
        assert_eq!(read(&f).unwrap().into_iter().collect::<Vec<_>>(), vec![("B".to_string(), "ok-1".to_string())]);
    }

    #[test]
    fn agy_models_取第一欄_略過空行與重複() {
        let out = "gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\n\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\ngemini-4-argon-medium\tdup\n";
        assert_eq!(parse_agy_models(out), vec!["gemini-4-argon-medium", "gemini-3.8-flash-high", "claude-opus-5-5-low"]);
        assert!(parse_agy_models("Fetching available models...\n").is_empty(), "說明文字不是模型");
    }
}
