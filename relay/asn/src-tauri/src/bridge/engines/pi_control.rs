//! pi 視窗的遠端控制：切換模型（#235）。
//! 擴充那一半見 relay/pi-extension/control.mjs（檔案約定與這裡一致）：
//!   ~/.asn/pi-control/<sessionId>/<請求編號>.json         請求（橋寫）{ v:1, id, op:"set_model", provider?, model, at }
//!   ~/.asn/pi-control/<sessionId>/<請求編號>.result.json  結果（擴充寫）{ v:1, id, ok, model?, provider?, error?, providers?, at }
//! ASN 開的 pi 是互動視窗加擴充，沒有 RPC 通道；擴充用 pi.setModel() 切換，而且只在 pi 閒置時處理，
//! 所以 pi 忙碌時橋端會等到逾時。這裡只有檔案與純邏輯，不啟動任何程式。
use super::pi::{read_windows, windows_dir};
use crate::bridge::roster::valid_sid;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn control_dir(home: &Path) -> PathBuf {
    home.join(".asn").join("pi-control")
}

/// 請求編號當檔名用：只收一般字元（與視窗代號同規則）
fn valid_request_id(id: &str) -> bool {
    valid_sid(id)
}

/// pi 的模型代號只有英數與 . _ : @ -（與擴充的 MODEL_RE 一致），最長 100
pub fn valid_model(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '@' | '-'))
}

/// 提供者（與擴充的 PROVIDER_RE 一致），最長 50
pub fn valid_provider(s: &str) -> bool {
    !s.is_empty() && s.len() <= 50 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 使用者輸入的模型：`模型` 或 `提供者/模型`（模型代號本身不含斜線，所以只切第一個）。不合法回 None
pub fn parse_model_spec(spec: &str) -> Option<(Option<String>, String)> {
    let t = spec.trim();
    match t.split_once('/') {
        Some((p, m)) if valid_provider(p) && valid_model(m) => Some((Some(p.to_string()), m.to_string())),
        Some(_) => None,
        None => valid_model(t).then(|| (None, t.to_string())),
    }
}

/// 把「切換模型」請求原子寫進該視窗的控制資料夾。請求編號相同＝覆蓋
pub fn write_control_request(home: &Path, sid: &str, id: &str, provider: Option<&str>, model: &str, now_ms: u64) -> Result<(), String> {
    if !valid_sid(sid) || !valid_request_id(id) {
        return Err("視窗或請求編號不合法".into());
    }
    if !valid_model(model) || provider.map(|p| !valid_provider(p)).unwrap_or(false) {
        return Err("模型名稱不合法（只能用英數與 . _ : @ -）".into());
    }
    let dir = control_dir(home).join(sid);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建立控制資料夾失敗：{e}"))?;
    let mut v = json!({ "v": 1, "id": id, "op": "set_model", "model": model, "at": now_ms });
    if let Some(p) = provider {
        v["provider"] = json!(p);
    }
    let target = dir.join(format!("{id}.json"));
    let tmp = dir.join(format!("{id}.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, v.to_string()).map_err(|e| format!("寫入控制請求失敗：{e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("寫入控制請求失敗：{e}")
    })
}

/// 讀擴充寫回的結果；還沒有、太大、壞掉、編號對不上都是 None（當作還沒好）
pub fn read_control_result(home: &Path, sid: &str, id: &str) -> Option<Value> {
    if !valid_sid(sid) || !valid_request_id(id) {
        return None;
    }
    let f = control_dir(home).join(sid).join(format!("{id}.result.json"));
    if std::fs::metadata(&f).ok()?.len() > 4096 {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).ok()?).ok()?;
    (v.get("id").and_then(Value::as_str) == Some(id) && v.get("ok").and_then(Value::as_bool).is_some()).then_some(v)
}

/// 結果轉成給人看的結果：成功回 { model, provider }，失敗回中文原因
pub fn control_outcome(v: &Value) -> Result<Value, String> {
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({ "model": v.get("model").cloned().unwrap_or(Value::Null), "provider": v.get("provider").cloned().unwrap_or(Value::Null) }));
    }
    Err(match v.get("error").and_then(Value::as_str).unwrap_or("") {
        "not_found" => "pi 找不到這個模型（可以用「提供者/模型」指定，例如 anthropic/claude-sonnet-5）".to_string(),
        "no_api_key" => "這個模型在這台電腦的 pi 沒有設定金鑰，不能用".to_string(),
        "ambiguous" => {
            let ps: Vec<&str> = v.get("providers").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            format!("有多個提供者都有這個模型，請用「提供者/模型」指定：{}", ps.join("、"))
        }
        _ => "pi 切換模型失敗".to_string(),
    })
}

/// 依視窗名找出 sessionId（名字重複的後者已被 read_windows 改成「名字-pid」，所以名字對得上就是唯一一個）
pub fn window_session_id(home: &Path, name: &str, now_ms: u64, alive: impl Fn(u32) -> bool) -> Option<String> {
    read_windows(&windows_dir(home), now_ms, alive).into_iter().find(|w| w.name == name).and_then(|w| w.session_id)
}

/// 切換 pi 視窗的模型（0.2 A3：pi 忙時改排隊）。
/// - pi 正在忙（登記檔 state=busy）：寫好請求就回 `{ queued: true }`。擴充只在 pi 閒下來時處理請求，所以這一輪做完就會切換；
///   以前會等到逾時回「沒有回應」，畫面說失敗，但請求還留著、之後悄悄生效。
/// - pi 閒著：等擴充寫回結果（wait_ms 內每 poll_ms 看一次）。等到逾時時 pi 若剛好變忙，照樣算排隊；
///   還是閒著卻沒回（擴充太舊、沒載入控制功能），就把請求刪掉再回失敗，免得之後悄悄生效。
/// now／sleep 可注入（測試用）。成功回 { model, provider }
pub struct SetModelEnv<'a> {
    pub now: &'a dyn Fn() -> u64,
    pub alive: &'a dyn Fn(u32) -> bool,
    pub sleep: &'a dyn Fn(u64),
    pub wait_ms: u64,
    pub poll_ms: u64,
}

/// 這個 pi 視窗現在是不是忙碌中（找不到回 None）
fn window_busy(home: &Path, sid: &str, now_ms: u64, alive: &dyn Fn(u32) -> bool) -> Option<bool> {
    read_windows(&windows_dir(home), now_ms, alive).into_iter().find(|w| w.session_id.as_deref() == Some(sid)).map(|w| w.status.as_deref() == Some("busy"))
}

fn queued(provider: Option<&str>, model: &str) -> Value {
    json!({ "queued": true, "model": model, "provider": provider })
}

pub fn set_model(home: &Path, name: &str, spec: &str, env: &SetModelEnv) -> Result<Value, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let (provider, model) = parse_model_spec(spec).ok_or("模型名稱不合法（只能用英數與 . _ : @ -，可寫成 提供者/模型）")?;
    let start = (env.now)();
    let sid = window_session_id(home, name, start, env.alive).ok_or("找不到這個 pi 視窗（可能已經關了，或沒有裝 ASN 的 pi 擴充）")?;
    let id = format!("m{start}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
    write_control_request(home, &sid, &id, provider.as_deref(), &model, start)?;
    if window_busy(home, &sid, start, env.alive) == Some(true) {
        return Ok(queued(provider.as_deref(), &model));
    }
    let mut waited = 0;
    loop {
        if let Some(r) = read_control_result(home, &sid, &id) {
            return control_outcome(&r);
        }
        if waited >= env.wait_ms {
            if window_busy(home, &sid, (env.now)(), env.alive) == Some(true) {
                return Ok(queued(provider.as_deref(), &model));
            }
            let _ = std::fs::remove_file(control_dir(home).join(&sid).join(format!("{id}.json")));
            return Err("pi 沒有回應（可能是 pi 的 ASN 擴充太舊，請更新擴充後再試）".into());
        }
        (env.sleep)(env.poll_ms);
        waited += env.poll_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn put_window(home: &Path, sid: &str, name: &str, pid: u32) {
        let d = windows_dir(home);
        std::fs::create_dir_all(&d).unwrap();
        let v = json!({ "v": 1, "engine": "pi", "sessionId": sid, "name": name, "pid": pid, "cwd": "D:/g/x", "state": "idle", "at": NOW });
        std::fs::write(d.join(format!("{sid}.json")), v.to_string()).unwrap();
    }
    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn env<'a>(sleep: &'a dyn Fn(u64), wait_ms: u64) -> SetModelEnv<'a> {
        SetModelEnv { now: &|| NOW, alive: &|_| true, sleep, wait_ms, poll_ms: 500 }
    }
    /// 假擴充：把控制資料夾裡還沒有結果的請求都回上指定的結果
    fn fake_extension(home: &Path, sid: &str, reply: Value) {
        let dir = control_dir(home).join(sid);
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let Some(id) = n.strip_suffix(".json") else { continue };
            if id.ends_with(".result") || dir.join(format!("{id}.result.json")).exists() {
                continue;
            }
            let mut r = reply.clone();
            r["v"] = json!(1);
            r["id"] = json!(id);
            std::fs::write(dir.join(format!("{id}.result.json")), r.to_string()).unwrap();
        }
    }

    #[test]
    fn 模型名稱_合法與不合法() {
        for ok in ["claude-sonnet-5", "gpt-6-sol", "MiniMax-M3.1-Flash", "a:b@c_d.e"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "a b", "../x", "x;calc", "a/b", &"x".repeat(101)] {
            assert!(!valid_model(bad), "{bad}");
        }
        assert!(valid_provider("openai-codex") && !valid_provider("a b") && !valid_provider("a/b") && !valid_provider(""));
        assert_eq!(parse_model_spec("claude-sonnet-5"), Some((None, "claude-sonnet-5".into())));
        assert_eq!(parse_model_spec(" xai/grok-4.7 "), Some((Some("xai".into()), "grok-4.7".into())));
        for bad in ["", "a/", "/m", "a/b/c", "x y", "a b/c"] {
            assert_eq!(parse_model_spec(bad), None, "{bad}");
        }
    }

    #[test]
    fn 控制請求_原子寫入_欄位完整_壞值拒絕() {
        let h = home();
        write_control_request(h.path(), "s1", "r1", Some("anthropic"), "claude-sonnet-5", NOW).unwrap();
        write_control_request(h.path(), "s1", "r2", None, "gpt-6-sol", NOW).unwrap();
        let dir = control_dir(h.path()).join("s1");
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["r1.json", "r2.json"], "沒有暫存檔殘留");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("r1.json")).unwrap()).unwrap();
        assert_eq!((v["v"].as_u64(), v["id"].as_str(), v["op"].as_str(), v["model"].as_str(), v["provider"].as_str(), v["at"].as_u64()), (Some(1), Some("r1"), Some("set_model"), Some("claude-sonnet-5"), Some("anthropic"), Some(NOW)));
        let v2: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("r2.json")).unwrap()).unwrap();
        assert!(v2.get("provider").is_none(), "沒給提供者就不寫");
        assert!(write_control_request(h.path(), "../s", "r", None, "m", NOW).is_err());
        assert!(write_control_request(h.path(), "s1", "../r", None, "m", NOW).is_err());
        assert!(write_control_request(h.path(), "s1", "r3", None, "bad model", NOW).is_err());
        assert!(write_control_request(h.path(), "s1", "r3", Some("a/b"), "m", NOW).is_err());
    }

    #[test]
    fn 控制結果_讀取與轉成中文() {
        let h = home();
        let dir = control_dir(h.path()).join("s1");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_control_result(h.path(), "s1", "r1").is_none(), "還沒有");
        std::fs::write(dir.join("r1.result.json"), json!({"v":1,"id":"r1","ok":true,"model":"claude-fable-5","provider":"anthropic","at":NOW}).to_string()).unwrap();
        let r = read_control_result(h.path(), "s1", "r1").unwrap();
        assert_eq!(control_outcome(&r).unwrap(), json!({"model":"claude-fable-5","provider":"anthropic"}));
        std::fs::write(dir.join("r2.result.json"), json!({"v":1,"id":"other","ok":true}).to_string()).unwrap();
        assert!(read_control_result(h.path(), "s1", "r2").is_none(), "編號對不上不採用");
        std::fs::write(dir.join("r3.result.json"), "{壞").unwrap();
        assert!(read_control_result(h.path(), "s1", "r3").is_none());
        std::fs::write(dir.join("r4.result.json"), "x".repeat(5000)).unwrap();
        assert!(read_control_result(h.path(), "s1", "r4").is_none(), "太大不讀");
        let e = |v: Value| control_outcome(&v).unwrap_err();
        assert!(e(json!({"ok":false,"error":"not_found"})).contains("找不到這個模型"));
        assert!(e(json!({"ok":false,"error":"no_api_key"})).contains("沒有設定金鑰"));
        assert!(e(json!({"ok":false,"error":"ambiguous","providers":["a","b"]})).contains("a、b"));
        assert_eq!(e(json!({"ok":false,"error":"failed"})), "pi 切換模型失敗");
        assert_eq!(e(json!({"ok":false})), "pi 切換模型失敗");
    }

    #[test]
    fn 切換模型_找視窗_寫請求_等到結果() {
        let h = home();
        put_window(h.path(), "s1", "pi-a", 100);
        let calls = std::cell::Cell::new(0u32);
        let sleep = |_ms: u64| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                // 擴充收到的請求內容要對
                let dir = control_dir(h.path()).join("s1");
                let reqs: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
                assert_eq!(reqs.len(), 1, "只有一個請求檔");
                let req: Value = serde_json::from_str(&std::fs::read_to_string(reqs[0].path()).unwrap()).unwrap();
                assert_eq!((req["model"].as_str(), req["provider"].as_str()), (Some("claude-sonnet-5"), Some("anthropic")));
                fake_extension(h.path(), "s1", json!({"ok":true,"model":"claude-sonnet-5","provider":"anthropic","at":NOW}));
            }
        };
        let r = set_model(h.path(), "pi-a", "anthropic/claude-sonnet-5", &env(&sleep, 10_000)).unwrap();
        assert_eq!(r, json!({"model":"claude-sonnet-5","provider":"anthropic"}));
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn 切換模型_失敗情形_沒有視窗_壞名稱_逾時_擴充回錯() {
        let h = home();
        put_window(h.path(), "s1", "pi-a", 100);
        let no_sleep = |_ms: u64| {};
        assert!(set_model(h.path(), "沒這個", "m", &env(&no_sleep, 1000)).unwrap_err().contains("找不到這個 pi 視窗"));
        assert!(set_model(h.path(), "pi-a", "bad name", &env(&no_sleep, 1000)).unwrap_err().contains("不合法"));
        let dead = SetModelEnv { now: &|| NOW, alive: &|p| p != 100, sleep: &no_sleep, wait_ms: 1000, poll_ms: 500 };
        assert!(set_model(h.path(), "pi-a", "m", &dead).unwrap_err().contains("找不到這個 pi 視窗"), "pid 已死的視窗不算");
        let n = std::cell::Cell::new(0u32);
        let sl = |_ms: u64| n.set(n.get() + 1);
        assert!(set_model(h.path(), "pi-a", "m", &env(&sl, 1500)).unwrap_err().contains("沒有回應"));
        assert_eq!(n.get(), 3, "等 1500ms、每 500ms 看一次");
        let sleep_err = |_ms: u64| fake_extension(h.path(), "s1", json!({"ok":false,"error":"not_found","at":NOW}));
        assert!(set_model(h.path(), "pi-a", "nope", &env(&sleep_err, 10_000)).unwrap_err().contains("找不到這個模型"));
    }
}
