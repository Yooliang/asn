//! #2162 ⑤：launch-prefs.json 與 bridge.json 搬進共用層的對照與守門測試。全部用暫存資料夾。
//! `old_*` 是搬進共用層之前的讀法，原樣複製，當逐項對照的標準答案；每次都「先算舊的、再算新的」，
//! 免得新讀法動了檔案之後，舊讀法讀到不一樣的東西而假綠。
use super::*;
use crate::bridge::{read_settings, settings_path, update_settings, write_settings, BridgeSettings, Manager};
use crate::launch::prefs::{launch_prefs_get_sync, launch_prefs_set_sync};
use serde_json::{json, Value};
use std::path::Path;

fn put(dir: &Path, name: &str, text: &str) {
    put_bytes(dir, name, text.as_bytes());
}
fn put_bytes(dir: &Path, name: &str, b: &[u8]) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), b).unwrap();
}
fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect()).unwrap_or_default();
    v.sort();
    v
}
fn with(dir: &Path, needle: &str) -> Vec<String> {
    names(dir).into_iter().filter(|n| n.contains(needle)).collect()
}
fn disk(dir: &Path, name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap()
}
fn plain(e: &str) -> bool {
    !e.contains("os error") && !e.contains("拒絕存取") && !e.is_empty()
}

struct FailWrite;
impl FailWrite {
    fn on() -> Self {
        FAIL_WRITE.with(|f| f.set(true));
        FailWrite
    }
}
impl Drop for FailWrite {
    fn drop(&mut self) {
        FAIL_WRITE.with(|f| f.set(false));
    }
}

/// 搬進共用層之前的 `read_settings`（原樣複製）
fn old_bridge(dir: &Path) -> BridgeSettings {
    use crate::bridge::compact;
    let dflt = BridgeSettings { enabled: true, ..BridgeSettings::default() };
    let Ok(text) = std::fs::read_to_string(settings_path(dir)) else { return dflt };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return dflt };
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    BridgeSettings { enabled: true, allow_takeover: flag("allow_takeover"), allow_remote_launch: flag("allow_remote_launch"), unaddressed_to: v.get("unaddressed_to").and_then(Value::as_str).unwrap_or("").trim().to_string(), auto_resume_off: flag("auto_resume_off"), term_server_off: flag("term_server_off"), term_server_on: flag("term_server_on"), screen_watch_off: flag("screen_watch_off"), perm_phone_off: flag("perm_phone_off"), mobile_view_off: flag("mobile_view_off"), remote_input_off: flag("remote_input_off"), compact_handoff_off: flag("compact_handoff_off"), compact_handoff_n: compact::clamp_n(v.get("compact_handoff_n").and_then(Value::as_i64)), gemini_full_access: flag("gemini_full_access") }
}

const BAD: &[&str] = &["", "{壞掉", "null", "5", "[1,2]", "\"字串\"", "true"];

fn bridge_cases() -> Vec<String> {
    let mut c: Vec<String> = BAD.iter().map(|s| s.to_string()).collect();
    c.extend(
        [
            "{}",
            r#"{"enabled":false}"#,
            r#"{"enabled":true,"allow_takeover":true,"allow_remote_launch":true,"unaddressed_to":"  T-丙  ","auto_resume_off":true,"term_server_off":true,"term_server_on":true,"screen_watch_off":true,"perm_phone_off":true,"mobile_view_off":true,"remote_input_off":true,"compact_handoff_off":true,"compact_handoff_n":7,"gemini_full_access":true}"#,
            r#"{"allow_remote_launch":"true","allow_takeover":1,"auto_resume_off":null,"term_server_off":[true]}"#,
            r#"{"unaddressed_to":5}"#,
            r#"{"unaddressed_to":null}"#,
            r#"{"unaddressed_to":"   "}"#,
            r#"{"compact_handoff_n":1}"#,
            r#"{"compact_handoff_n":2}"#,
            r#"{"compact_handoff_n":10}"#,
            r#"{"compact_handoff_n":11}"#,
            r#"{"compact_handoff_n":999999999999}"#,
            r#"{"compact_handoff_n":18446744073709551615}"#,
            r#"{"compact_handoff_n":-5}"#,
            r#"{"compact_handoff_n":5.0}"#,
            r#"{"compact_handoff_n":5.7}"#,
            r#"{"compact_handoff_n":"5"}"#,
            r#"{"compact_handoff_n":null}"#,
            r#"{"compact_handoff_n":true}"#,
            r#"{"version":1,"allow_remote_launch":true}"#,
            r#"{"version":"x","allow_remote_launch":true}"#,
            r#"{"version":99,"allow_remote_launch":true,"future":{"a":1}}"#,
            r#"{"allow_remote_launch":true,"allow_remote_launch":false}"#,
            r#"{"沒看過的欄位":1,"mobile_view_off":true}"#,
        ]
        .map(String::from),
    );
    c
}

#[test]
fn bridge_各種舊格式讀出來和搬之前逐項一致() {
    for (i, text) in bridge_cases().iter().enumerate() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "bridge.json", text);
        let old = old_bridge(d.path()); // 先算舊的
        let new = read_settings(d.path());
        assert_eq!(new, old, "第 {i} 組（{text}）");
        assert!(new.enabled, "enabled 讀回一律是 true");
        assert_eq!(read_settings(d.path()), old, "第 {i} 組：讀第二次（走快取）也一樣");
    }
    // 沒有檔
    let d = tempfile::tempdir().unwrap();
    assert_eq!(read_settings(d.path()), BridgeSettings { enabled: true, ..BridgeSettings::default() });
    assert!(names(d.path()).is_empty(), "讀取不建檔");
    // 不合法的 UTF-8
    put_bytes(d.path(), "bridge.json", &[0xff, 0xfe, 0x7b, 0x7d]);
    assert_eq!(read_settings(d.path()), old_bridge(d.path()));
}

#[test]
fn bridge_預設值逐欄對照() {
    let d = BridgeDoc::default();
    let s = BridgeSettings::default();
    // (欄位, 文件預設, 舊預設)
    let rows: Vec<(&str, String, String)> = vec![
        ("enabled", d.enabled.to_string(), s.enabled.to_string()),
        ("allow_takeover", d.allow_takeover.to_string(), s.allow_takeover.to_string()),
        ("allow_remote_launch", d.allow_remote_launch.to_string(), s.allow_remote_launch.to_string()),
        ("unaddressed_to", d.unaddressed_to.clone(), s.unaddressed_to.clone()),
        ("auto_resume_off", d.auto_resume_off.to_string(), s.auto_resume_off.to_string()),
        ("term_server_off", d.term_server_off.to_string(), s.term_server_off.to_string()),
        ("term_server_on", d.term_server_on.to_string(), s.term_server_on.to_string()),
        ("screen_watch_off", d.screen_watch_off.to_string(), s.screen_watch_off.to_string()),
        ("perm_phone_off", d.perm_phone_off.to_string(), s.perm_phone_off.to_string()),
        ("mobile_view_off", d.mobile_view_off.to_string(), s.mobile_view_off.to_string()),
        ("remote_input_off", d.remote_input_off.to_string(), s.remote_input_off.to_string()),
        ("compact_handoff_off", d.compact_handoff_off.to_string(), s.compact_handoff_off.to_string()),
        ("compact_handoff_n", d.compact_handoff_n.to_string(), s.compact_handoff_n.to_string()),
        ("gemini_full_access", d.gemini_full_access.to_string(), s.gemini_full_access.to_string()),
    ];
    assert_eq!(rows.len(), 14);
    for (k, a, b) in rows {
        assert_eq!(a, b, "{k} 的預設值");
    }
    assert_eq!(s.compact_handoff_n, 3);
    // 單一欄位型別不對、整份其餘照讀
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "bridge.json", r#"{"allow_takeover":"是","mobile_view_off":true}"#);
    let r = read_settings(dir.path());
    assert!(!r.allow_takeover && r.mobile_view_off);
}

#[test]
fn bridge_橋讀到壞檔_檔案原地不動_不產生_bad_也不產生_bak() {
    for text in BAD.iter().map(|s| s.as_bytes().to_vec()).chain([vec![0xff, 0xfe, 0xfd]]) {
        let d = tempfile::tempdir().unwrap();
        put_bytes(d.path(), "bridge.json", &text);
        let before = names(d.path());
        for _ in 0..20 {
            // 非物件的合法 JSON（null、5…）舊讀法也是全預設
            let s = read_settings(d.path());
            assert_eq!(s, BridgeSettings { enabled: true, ..BridgeSettings::default() });
        }
        assert_eq!(std::fs::read(d.path().join("bridge.json")).unwrap(), text, "內容要逐字不變");
        assert_eq!(names(d.path()), before, "不准多出任何檔（.bad-、.bak、.tmp）");
        assert!(with(d.path(), ".bad-").is_empty() && with(d.path(), ".bak").is_empty());
    }
}

#[test]
fn bridge_壞檔被反覆讀也不洗版_同一個壞檔只記一行() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", "{壞掉");
    PEEK_LOGS.with(|n| n.set(0));
    for _ in 0..500 {
        read_settings(d.path());
    }
    assert_eq!(PEEK_LOGS.with(|n| n.get()), 1, "500 次讀取只該記一行");
    // 還沒滿 60 秒：再讀也不記
    PEEK_CLOCK_SKEW.with(|s| s.set(std::time::Duration::from_secs(30)));
    read_settings(d.path());
    assert_eq!(PEEK_LOGS.with(|n| n.get()), 1, "30 秒還不該再記");
    // 滿 60 秒（假時鐘）：壞檔還在，再記一行，之後又安靜
    PEEK_CLOCK_SKEW.with(|s| s.set(std::time::Duration::from_secs(61)));
    for _ in 0..100 {
        read_settings(d.path());
    }
    assert_eq!(PEEK_LOGS.with(|n| n.get()), 2, "60 秒後該再記一行，而且只記一行");
    PEEK_CLOCK_SKEW.with(|s| s.set(std::time::Duration::ZERO));
    // 壞檔被修好之後讀得到新值，不卡在「壞」的記憶
    put(d.path(), "bridge.json", r#"{"allow_remote_launch":true}"#);
    assert!(read_settings(d.path()).allow_remote_launch);
}

#[test]
fn bridge_唯讀讀取回_corrupt_狀態_之後寫入才搬檔() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", "{壞掉");
    let l = peek_in::<BridgeDoc>(d.path());
    assert!(matches!(l.status, LoadStatus::Corrupt { .. }), "{:?}", l.status);
    // 之後有人寫入：壞檔照樣先搬再寫（搬檔只在寫入時發生）
    update_settings(d.path(), |s| s.allow_remote_launch = true).unwrap();
    assert_eq!(with(d.path(), "bridge.json.bad-").len(), 1, "寫入時壞檔要先搬走");
    assert!(disk(d.path(), "bridge.json")["allow_remote_launch"].as_bool().unwrap());
    assert!(read_settings(d.path()).allow_remote_launch);
}

#[test]
fn bridge_對照組_會搬檔的讀取仍會搬_唯讀版不搬() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", "{壞掉");
    let _ = peek_in::<BridgeDoc>(d.path());
    assert!(with(d.path(), ".bad-").is_empty());
    let l = load_in::<BridgeDoc>(d.path());
    assert_eq!(l.status, LoadStatus::Recovered);
    assert_eq!(with(d.path(), ".bad-").len(), 1);
}

#[test]
fn bridge_熱路徑_修改時間與大小沒變就不重讀檔() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", r#"{"unaddressed_to":"AAAA"}"#);
    let p = d.path().join("bridge.json");
    let mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
    assert_eq!(read_settings(d.path()).unaddressed_to, "AAAA");
    // 偷偷換掉內容、把修改時間與大小調回原樣：快取命中就不會看到新內容（證明沒有重讀）
    std::fs::write(&p, r#"{"unaddressed_to":"BBBB"}"#).unwrap();
    std::fs::OpenOptions::new().write(true).open(&p).unwrap().set_modified(mtime).unwrap();
    assert_eq!(read_settings(d.path()).unaddressed_to, "AAAA", "stamp 沒變就該走快取");
    // 大小變了就重讀
    std::fs::write(&p, r#"{"unaddressed_to":"CCCCCC"}"#).unwrap();
    assert_eq!(read_settings(d.path()).unaddressed_to, "CCCCCC");
    // 寫入後立刻看得到（寫入端更新快取）
    update_settings(d.path(), |s| s.unaddressed_to = "DD".into()).unwrap();
    assert_eq!(read_settings(d.path()).unaddressed_to, "DD");
}

#[test]
fn bridge_熱路徑_不比直接讀檔重新解析慢() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", r#"{"allow_remote_launch":true,"unaddressed_to":"T-丙","compact_handoff_n":5}"#);
    read_settings(d.path());
    let n = 3000;
    // 只比相對值（同一台機器、同一時段的新舊兩種讀法），各量 3 輪取最快的一輪，忙碌的機器兩邊一起變慢，不會誤判
    let best = |f: &dyn Fn()| (0..3).map(|_| { let t = std::time::Instant::now(); for _ in 0..n { f(); } t.elapsed() }).min().unwrap();
    let new = best(&|| { std::hint::black_box(read_settings(d.path())); });
    let old = best(&|| { std::hint::black_box(old_bridge(d.path())); });
    eprintln!("[bridge 熱路徑] {n} 次：新 {new:?}／舊 {old:?}");
    // 只擋「明顯變慢」：新讀法不超過舊讀法的 5 倍
    assert!(new < old * 5, "新讀法 {new:?} 比舊讀法 {old:?} 慢太多");
}

#[test]
fn bridge_寫入_保留不認得的欄位_舊讀法讀得出同樣的值() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", r#"{"enabled":true,"allow_takeover":true,"future_flag":{"x":[1,2]},"compact_handoff_n":4}"#);
    update_settings(d.path(), |s| {
        s.allow_remote_launch = true;
        s.unaddressed_to = "T-丙".into();
        s.compact_handoff_off = true;
    })
    .unwrap();
    let v = disk(d.path(), "bridge.json");
    assert_eq!(v["future_flag"], json!({"x":[1,2]}), "不認得的欄位原樣保留");
    assert_eq!(v["version"], json!(1));
    // 升級後再降級：舊讀法讀新寫的檔，得到跟新讀法同一組值
    assert_eq!(old_bridge(d.path()), read_settings(d.path()));
    let o = old_bridge(d.path());
    assert!(o.allow_takeover && o.allow_remote_launch && o.compact_handoff_off && o.unaddressed_to == "T-丙" && o.compact_handoff_n == 4);
    // 舊檔（沒有 version）第一次寫入前備份
    assert_eq!(with(d.path(), ".v0.bak").len(), 1);
}

#[test]
fn bridge_write_settings_轉接_簽章不變_只換十三欄() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", r#"{"future":1}"#);
    write_settings(d.path(), BridgeSettings { enabled: false, allow_remote_launch: true, compact_handoff_n: 99, ..Default::default() }).unwrap();
    let v = disk(d.path(), "bridge.json");
    assert_eq!(v["future"], json!(1));
    assert_eq!(v["enabled"], json!(false), "檔裡照存，讀回時才強制 true");
    assert_eq!(v["compact_handoff_n"], json!(10), "次數寫入時也夾在 2～10");
    assert!(read_settings(d.path()).enabled);
}

#[test]
fn bridge_九個設定同時改不同欄位_不互相蓋掉() {
    for round in 0..40 {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        put(data.path(), "bridge.json", r#"{"zzz":1}"#);
        let m = std::sync::Arc::new(Manager::new(None, None, "T".into(), work.path().to_path_buf(), data.path().to_path_buf()));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(9));
        let hs: Vec<_> = (0..9)
            .map(|i| {
                let (m, b) = (m.clone(), barrier.clone());
                std::thread::spawn(move || {
                    b.wait();
                    match i {
                        0 => m.set_remote_launch(true).unwrap(),
                        1 => m.set_auto_resume(false).unwrap(),
                        2 => m.set_compact_handoff(false, 6).unwrap(),
                        3 => m.set_perm_phone(false).unwrap(),
                        4 => m.set_mobile_view(false).unwrap(),
                        5 => m.set_remote_input(false).unwrap(),
                        6 => m.set_screen_watch(false).unwrap(),
                        7 => m.set_unaddressed_to("T-丙").unwrap(),
                        _ => m.set_enabled(true).unwrap(),
                    };
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let v = disk(data.path(), "bridge.json");
        let got = (v["allow_remote_launch"].clone(), v["auto_resume_off"].clone(), v["compact_handoff_off"].clone(), v["compact_handoff_n"].clone(), v["perm_phone_off"].clone(), v["mobile_view_off"].clone(), v["remote_input_off"].clone(), v["screen_watch_off"].clone(), v["unaddressed_to"].clone(), v["zzz"].clone());
        assert_eq!(got, (json!(true), json!(true), json!(true), json!(6), json!(true), json!(true), json!(true), json!(true), json!("T-丙"), json!(1)), "第 {round} 輪：有寫入被蓋掉");
    }
}

#[test]
fn bridge_寫入失敗_畫面只拿到固定白話句() {
    let d = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let m = Manager::new(None, None, "T".into(), work.path().to_path_buf(), d.path().to_path_buf());
    let _g = FailWrite::on();
    for e in [update_settings(d.path(), |s| s.allow_takeover = true).unwrap_err(), write_settings(d.path(), BridgeSettings::default()).unwrap_err(), m.set_remote_launch(true).unwrap_err(), m.set_unaddressed_to("x").unwrap_err()] {
        assert!(plain(&e), "不該把系統原文送到畫面：{e}");
    }
}

#[test]
fn bridge_壞檔搬不走_寫入回錯_原檔不動() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", "{壞掉");
    let before = std::fs::read(d.path().join("bridge.json")).unwrap();
    migrate::FAIL_RENAME.with(|f| f.set(true));
    migrate::FAIL_COPY.with(|f| f.set(true));
    let r = update_settings(d.path(), |s| s.allow_remote_launch = true);
    migrate::FAIL_RENAME.with(|f| f.set(false));
    migrate::FAIL_COPY.with(|f| f.set(false));
    assert!(r.is_err());
    assert_eq!(std::fs::read(d.path().join("bridge.json")).unwrap(), before);
}

#[test]
fn bridge_更新版本寫的檔_唯讀不備份_寫入時保留版本號() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", r#"{"version":9,"allow_remote_launch":true,"future":1}"#);
    let l = peek_in::<BridgeDoc>(d.path());
    assert_eq!(l.status, LoadStatus::Newer { file_version: 9 });
    assert!(with(d.path(), ".bak").is_empty(), "唯讀不備份");
    update_settings(d.path(), |s| s.perm_phone_off = true).unwrap();
    let v = disk(d.path(), "bridge.json");
    assert_eq!((v["version"].clone(), v["future"].clone()), (json!(9), json!(1)));
}

#[test]
fn bridge_帶_bom_的合法_json_讀得出值_與舊讀法的刻意差異() {
    // 舊讀法對 BOM 開頭的檔 serde_json 會失敗而當成全預設；新讀法去掉 BOM 照讀（與 ④ 同一個行為），也不產生 .bad-
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "bridge.json", "\u{feff}{\"allow_remote_launch\":true}");
    assert!(read_settings(d.path()).allow_remote_launch);
    assert!(!old_bridge(d.path()).allow_remote_launch);
    assert!(with(d.path(), ".bad-").is_empty());
}

// ================================================================ launch-prefs.json

fn old_launch_get(dir: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(dir.join("launch-prefs.json")).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
/// 所有呼叫端拿到結果後的共同處理：壞檔／不是物件都當成沒有（`unwrap_or(Null)` 後各自 `is_object` 或 `get`）
fn as_seen_by_callers(r: Result<Value, String>) -> Value {
    match r.unwrap_or(Value::Null) {
        v if v.is_object() => v,
        _ => json!({}),
    }
}

#[test]
fn 啟動偏好_各種舊格式讀出來和搬之前逐項一致() {
    let mut cases: Vec<String> = BAD.iter().map(|s| s.to_string()).collect();
    cases.extend(
        [
            "{}",
            r#"{"cwdAllow":["C:\\a","D:\\b"],"recentCwd":["C:\\a"],"launchDisplay":"background","maxPerHour":6,"maxPerHourSet":3}"#,
            r#"{"cwdAllow":"不是陣列","launchDisplay":5}"#,
            r#"{"沒看過的欄位":{"a":[1,2,3]},"cwdAllow":[]}"#,
            r#"{"version":1,"cwdAllow":["C:\\a"]}"#,
        ]
        .map(String::from),
    );
    for (i, text) in cases.iter().enumerate() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "launch-prefs.json", text);
        let old = as_seen_by_callers(old_launch_get(d.path())); // 先算舊的
        let new = as_seen_by_callers(launch_prefs_get_sync(d.path()));
        let mut want = old.clone();
        if let Some(o) = want.as_object_mut() {
            o.remove("version"); // version 由共用層管，不當成內容
        }
        assert_eq!(new, want, "第 {i} 組（{text}）");
    }
    // 沒有檔
    let d = tempfile::tempdir().unwrap();
    assert_eq!(launch_prefs_get_sync(d.path()).unwrap(), json!({}));
    assert!(names(d.path()).is_empty(), "讀取不建檔");
}

#[test]
fn 啟動偏好_合法但不是物件的_json_維持舊行為_回空物件_設定頁不會收到錯誤() {
    for text in ["null", "5", "[1,2]", "\"字串\"", "true"] {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "launch-prefs.json", text);
        // 舊版：Ok(原值)，設定頁那層（with_effective_max）再換成 {}；新版直接回 {}，經同一層結果相同
        let old = crate::launch::with_effective_max(old_launch_get(d.path()).unwrap(), None);
        let new = crate::launch::with_effective_max(launch_prefs_get_sync(d.path()).unwrap(), None);
        assert_eq!(new, old, "{text}");
        assert_eq!(launch_prefs_get_sync(d.path()).unwrap(), json!({}), "{text}");
    }
    // 不是合法 JSON：舊版也是 Err（設定頁 catch 後用預設值，不會空白或卡住）
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "launch-prefs.json", "{壞掉");
    assert!(old_launch_get(d.path()).is_err() && launch_prefs_get_sync(d.path()).is_err());
}

#[test]
fn 啟動偏好_帶_bom_的合法_json_讀得出值_不產生_bad_非法編碼對照舊行為() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "launch-prefs.json", "\u{feff}{\"launchDisplay\":\"background\"}");
    assert_eq!(launch_prefs_get_sync(d.path()).unwrap()["launchDisplay"], json!("background"));
    assert_eq!(crate::launch::prefs::launch_display_pref(d.path()).as_deref(), Some("background"));
    assert!(with(d.path(), ".bad-").is_empty());
    // 非法 UTF-8：舊版讀不出文字就當 {}，新版同樣回 {}、不搬檔
    let d2 = tempfile::tempdir().unwrap();
    put_bytes(d2.path(), "launch-prefs.json", &[0xff, 0xfe, 0x7b, 0x7d]);
    assert_eq!(old_launch_get(d2.path()).unwrap(), json!({}));
    assert_eq!(launch_prefs_get_sync(d2.path()).unwrap(), json!({}));
    assert!(with(d2.path(), ".bad-").is_empty());
}

#[test]
fn 啟動偏好_壞檔唯讀讀取不搬檔_寫入時才搬() {
    for text in ["{壞掉", "[1,2]", "5"] {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "launch-prefs.json", text);
        assert_eq!(launch_prefs_get_sync(d.path()).is_err(), text == "{壞掉");
        for _ in 0..10 {
            let _ = launch_prefs_get_sync(d.path());
        }
        assert_eq!(std::fs::read_to_string(d.path().join("launch-prefs.json")).unwrap(), text);
        assert_eq!(names(d.path()).len(), 1, "讀取不准產生任何檔");
        launch_prefs_set_sync(d.path(), json!({"cwdAllow": []})).unwrap();
        assert_eq!(with(d.path(), "launch-prefs.json.bad-").len(), 1, "寫入時壞檔先搬");
        assert_eq!(launch_prefs_get_sync(d.path()).unwrap(), json!({"cwdAllow": []}));
    }
}

#[test]
fn 啟動偏好_存檔上限與形狀檢查保留() {
    let d = tempfile::tempdir().unwrap();
    let big = json!({"x": "a".repeat(200_001)});
    assert_eq!(launch_prefs_set_sync(d.path(), big).unwrap_err(), "設定太大");
    assert!(launch_prefs_set_sync(d.path(), json!([1])).is_err());
    assert!(!d.path().join("launch-prefs.json").exists(), "被拒絕不建檔");
    let ok = json!({"x": "a".repeat(199_000)});
    launch_prefs_set_sync(d.path(), ok.clone()).unwrap();
    assert_eq!(launch_prefs_get_sync(d.path()).unwrap(), ok);
}

#[test]
fn 啟動偏好_整份存會取代舊欄位_版本號另外管_舊讀法讀得出同樣的值() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "launch-prefs.json", r#"{"a":1,"cwdAllow":["C:\\x"]}"#);
    launch_prefs_set_sync(d.path(), json!({"cwdAllow": ["C:\\y"], "launchDisplay": "background"})).unwrap();
    let v = disk(d.path(), "launch-prefs.json");
    assert_eq!(v["version"], json!(1));
    assert!(v.get("a").is_none(), "整份存＝取代，跟以前一樣");
    assert_eq!(old_launch_get(d.path()).unwrap().get("cwdAllow"), Some(&json!(["C:\\y"])), "舊讀法讀得出");
    assert_eq!(crate::launch::prefs::launch_display_pref(d.path()).as_deref(), Some("background"));
}

#[test]
fn 啟動偏好_加白名單同時進來_不互相蓋掉_也保留別的欄位() {
    use crate::launch::cwds::add_to_prefs_allow;
    for round in 0..30 {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "launch-prefs.json", r#"{"launchDisplay":"background","zzz":1}"#);
        let dirs: Vec<_> = (0..8)
            .map(|i| {
                let p = d.path().join(format!("proj{i}"));
                std::fs::create_dir_all(&p).unwrap();
                p
            })
            .collect();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(dirs.len()));
        let hs: Vec<_> = dirs
            .iter()
            .cloned()
            .map(|p| {
                let (b, base) = (barrier.clone(), d.path().to_path_buf());
                std::thread::spawn(move || {
                    b.wait();
                    add_to_prefs_allow(&base, &p.to_string_lossy()).unwrap();
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let v = disk(d.path(), "launch-prefs.json");
        assert_eq!(v["cwdAllow"].as_array().unwrap().len(), 8, "第 {round} 輪：有白名單被蓋掉");
        assert_eq!((v["launchDisplay"].clone(), v["zzz"].clone()), (json!("background"), json!(1)));
    }
}

#[test]
fn 啟動偏好_白名單一路新增到超過上限_那一次被拒絕_檔案維持上一次的內容() {
    use crate::launch::cwds::{add_to_prefs_allow, add_validated, remove_from_prefs_allow};
    let d = tempfile::tempdir().unwrap();
    let p3 = d.path().join("z".repeat(200)); // 路徑要夠長，免得不同平台的暫存路徑長短影響是否超過上限
    std::fs::create_dir_all(&p3).unwrap();
    // 先寫到離上限不遠，再用很長的資料夾名一路加白名單，直到被上限擋住
    launch_prefs_set_sync(d.path(), json!({"pad": "a".repeat(198_000)})).unwrap();
    let mut accepted = 0;
    let mut rejected_at = None;
    for i in 0..40 {
        let p = d.path().join(format!("{}{i}", "x".repeat(200)));
        std::fs::create_dir_all(&p).unwrap();
        let before = std::fs::read(d.path().join("launch-prefs.json")).unwrap();
        match add_to_prefs_allow(d.path(), &p.to_string_lossy()) {
            Ok(()) => accepted += 1,
            Err(e) => {
                assert!(plain(&e), "{e}");
                assert_eq!(std::fs::read(d.path().join("launch-prefs.json")).unwrap(), before, "被拒絕那一次檔案不能變");
                rejected_at = Some(i);
                break;
            }
        }
    }
    assert!(accepted > 0, "上限以內的要放得進去");
    assert!(rejected_at.is_some(), "一路加下去一定要有一次被上限擋住");
    assert!(std::fs::read(d.path().join("launch-prefs.json")).unwrap().len() <= 200_000 + 200, "檔案不能長過上限太多（含版本欄位與縮排）");
    // 另外兩個白名單寫入點同一套檢查
    launch_prefs_set_sync(d.path(), json!({"pad": "a".repeat(199_940), "cwdAllow": []})).unwrap();
    let before = std::fs::read(d.path().join("launch-prefs.json")).unwrap();
    let r = add_validated(d.path(), &p3.to_string_lossy());
    assert!(r.is_err(), "{r:?}");
    assert_eq!(std::fs::read(d.path().join("launch-prefs.json")).unwrap(), before);
    let _ = remove_from_prefs_allow(d.path(), &p3.to_string_lossy()); // 清單裡沒有＝驗證沒過，同樣不寫
    assert_eq!(std::fs::read(d.path().join("launch-prefs.json")).unwrap(), before);
}

#[test]
fn 啟動偏好_驗證沒過不寫檔_不建檔() {
    use crate::launch::cwds::add_validated;
    let d = tempfile::tempdir().unwrap();
    let r = add_validated(d.path(), &d.path().join("不存在的資料夾").to_string_lossy());
    assert!(r.is_err(), "{r:?}");
    assert!(!d.path().join("launch-prefs.json").exists());
}

#[test]
fn 啟動偏好_寫入失敗_畫面只拿到固定白話句() {
    let d = tempfile::tempdir().unwrap();
    let proj = d.path().join("p");
    std::fs::create_dir_all(&proj).unwrap();
    let _g = FailWrite::on();
    let e = launch_prefs_set_sync(d.path(), json!({"a":1})).unwrap_err();
    assert!(plain(&e), "{e}");
    let e = crate::launch::cwds::add_to_prefs_allow(d.path(), &proj.to_string_lossy()).unwrap_err();
    assert!(plain(&e), "{e}");
    let e = crate::launch::launch_prefs_set_checked(d.path(), json!({"a":1})).unwrap_err();
    assert!(plain(&e), "{e}");
}
