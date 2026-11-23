//! #2162 ④：搬進共用層的幾組設定檔（視窗名稱 settings.json、帳號偏好 acct-prefs.json、安裝偏好 agent-setup-prefs.json、
//! pi 自動安裝 pi-auto.json、讀額度 quota-readers.json）的對照測試。全部用暫存資料夾。
//! 每一組的 `old_*` 是搬進共用層之前的讀法，原樣複製，當逐項對照的標準答案；每次都「先算舊的、再算新的」，
//! 免得新讀法把壞檔搬走之後，舊讀法讀到不存在的檔而假綠。
use super::*;
use serde_json::json;
use std::path::Path;

fn put(dir: &Path, name: &str, text: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), text).unwrap();
}
fn files_with(dir: &Path, needle: &str) -> Vec<String> {
    std::fs::read_dir(dir).map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.contains(needle)).collect()).unwrap_or_default()
}
fn is_object(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).map(|v| v.is_object()).unwrap_or(false)
}
fn disk(dir: &Path, name: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap()
}

/// 讓「壞檔改名、複製都失敗」：之後的讀取是 Unreadable，寫入一律要回錯、原檔不動
struct FailQuarantine;
impl FailQuarantine {
    fn on() -> Self {
        migrate::FAIL_RENAME.with(|f| f.set(true));
        migrate::FAIL_COPY.with(|f| f.set(true));
        FailQuarantine
    }
}
impl Drop for FailQuarantine {
    fn drop(&mut self) {
        migrate::FAIL_RENAME.with(|f| f.set(false));
        migrate::FAIL_COPY.with(|f| f.set(false));
    }
}

/// 讓寫入一律失敗（io 錯誤，系統原文是「拒絕存取 (os error 5)」）
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
fn plain(e: &str) -> bool {
    !e.contains("os error") && !e.contains("拒絕存取") && !e.is_empty()
}

/// 壞檔與非物件（新讀法會把它們搬成 .bad-，讀出來的值仍與舊讀法相同＝預設）
const NON_OBJECT: &[&str] = &["", "{壞掉", "null", "5", "[1,2]", "\"字串\"", "true"];

// ================================================================ R4 settings.json

fn old_name(dir: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).ok()?).ok()?;
    v.get("window_name")?.as_str().filter(|s| crate::valid_window_name(s)).map(String::from)
}
fn old_olds(dir: &Path) -> Vec<crate::names::OldName> {
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else { return vec![] };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    v.get("old_names").and_then(|o| serde_json::from_value::<Vec<crate::names::OldName>>(o.clone()).ok()).unwrap_or_default()
}

#[test]
fn 視窗名稱_各種舊格式讀出來和搬之前逐項一致() {
    let long61 = format!(r#"{{"window_name":"{}"}}"#, "字".repeat(61));
    let mut cases: Vec<&str> = NON_OBJECT.to_vec();
    cases.extend([
        "{}",
        r#"{"window_name":"我的ASN"}"#,
        r#"{"window_name":" bad"}"#,
        r#"{"window_name":"bad "}"#,
        r#"{"window_name":""}"#,
        r#"{"window_name":5}"#,
        r#"{"window_name":null}"#,
        r#"{"window_name":"a\u0001b"}"#,
        r#"{"window_name":"X","old_names":[{"name":"A","t":5}],"future":{"a":[1]}}"#,
        r#"{"old_names":[{"name":"A","t":5},{"name":"B","t":9}]}"#,
        r#"{"old_names":[{"name":"A","t":5},{"bad":1}]}"#,
        r#"{"old_names":[{"name":"A","t":-1}]}"#,
        r#"{"old_names":"x"}"#,
        r#"{"old_names":null}"#,
        r#"{"old_names":[]}"#,
        r#"{"version":1,"window_name":"Z"}"#,
        r#"{"version":"x","window_name":"Z","old_names":[{"name":"A","t":1}]}"#,
        r#"{"window_name":"Z","version":99,"old_names":[{"name":"A","t":1}]}"#,
    ]);
    cases.push(&long61);
    for (i, c) in cases.iter().enumerate() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "settings.json", c);
        let (want_n, want_o) = (old_name(d.path()), old_olds(d.path())); // 先算舊的
        let got_n = crate::read_settings_name(d.path());
        let got_o = crate::names::read_old_names(d.path());
        assert_eq!((got_n, got_o), (want_n, want_o), "第 {i} 組：{c}");
        if is_object(c) {
            assert!(files_with(d.path(), ".bad-").is_empty(), "第 {i} 組：物件內容不得產生 .bad-：{c}");
        }
    }
    // 檔案不存在
    let d = tempfile::tempdir().unwrap();
    let (want_n, want_o) = (old_name(d.path()), old_olds(d.path()));
    assert_eq!((crate::read_settings_name(d.path()), crate::names::read_old_names(d.path())), (want_n, want_o));
    assert!(!d.path().join("settings.json").exists(), "讀取不建檔");
}

#[test]
fn 視窗名稱_預設值對照() {
    let d = NamesDoc::default();
    assert_eq!((d.window_name, d.old_names.len(), d.extra.len()), (None, 0, 0));
}

#[test]
fn 視窗名稱_帶_bom_的檔照樣讀得出來() {
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "settings.json", "\u{feff}{\"window_name\":\"我的ASN\"}");
    assert_eq!(crate::read_settings_name(dir.path()).as_deref(), Some("我的ASN"));
    assert!(files_with(dir.path(), ".bad-").is_empty());
}

#[test]
fn 視窗名稱_改名只改兩欄_不認得的欄位保留_舊版讀得出同樣的值() {
    let d = tempfile::tempdir().unwrap();
    let w = tempfile::tempdir().unwrap();
    put(d.path(), "settings.json", r#"{"window_name":"舊名","old_names":[],"future":{"a":[1,2]},"speed":1.5}"#);
    let r = crate::relay::Relay::new("http://127.0.0.1:1/relay".into(), "k".into(), "H".into(), "舊名".into());
    assert_eq!(crate::names::rename(&r, d.path(), w.path(), "新名", 1_000).unwrap(), "新名");
    let v = disk(d.path(), "settings.json");
    assert_eq!(v["window_name"], "新名");
    assert_eq!(v["future"], json!({"a": [1, 2]}), "不認得的欄位原樣保留");
    assert_eq!(v["speed"], 1.5);
    assert_eq!(v["version"], 1, "第一次寫入補上 version");
    assert!(d.path().join("settings.json.v0.bak").is_file(), "升版前備份舊內容");
    // 降級：舊版的讀法讀得出同樣的值，多出來的 version 欄位被忽略
    assert_eq!(old_name(d.path()).as_deref(), Some("新名"));
    assert_eq!(old_olds(d.path()), vec![crate::names::OldName { name: "舊名".into(), t: 1_000 }]);
    assert_eq!(crate::read_settings_name(d.path()), old_name(d.path()));
}

#[test]
fn 視窗名稱_讀不到原檔時改名回錯_原檔不動_不改現用名() {
    let d = tempfile::tempdir().unwrap();
    let w = tempfile::tempdir().unwrap();
    put(d.path(), "settings.json", "{壞掉但還救得回來");
    let before = std::fs::read(d.path().join("settings.json")).unwrap();
    let r = crate::relay::Relay::new("http://127.0.0.1:1/relay".into(), "k".into(), "H".into(), "H-ASN".into());
    let _g = FailQuarantine::on();
    let e = crate::names::rename(&r, d.path(), w.path(), "新名", 1).unwrap_err();
    assert!(!e.is_empty(), "回的是原本的錯誤型別（字串）");
    assert_eq!(r.window_name(), "H-ASN", "存檔失敗，視窗名不變");
    assert_eq!(std::fs::read(d.path().join("settings.json")).unwrap(), before, "原檔不准被覆蓋");
    assert_eq!(crate::read_settings_name(d.path()), None, "讀取端照舊回沒有，不 panic");
}

#[test]
fn 視窗名稱_寫入失敗回給畫面的字串不含系統原文() {
    let d = tempfile::tempdir().unwrap();
    let w = tempfile::tempdir().unwrap();
    let r = crate::relay::Relay::new("http://127.0.0.1:1/relay".into(), "k".into(), "H".into(), "H-ASN".into());
    let _g = FailWrite::on();
    let e = crate::names::rename(&r, d.path(), w.path(), "新名", 1).unwrap_err();
    assert!(plain(&e), "不該把系統原文送到畫面：{e}");
    assert_eq!(r.window_name(), "H-ASN");
}

// ================================================================ 其餘四組（電腦版才有）

#[cfg(desktop)]
mod desktop {
    use super::*;
    use crate::acct_remote::{allow_switch, set_allow_switch, set_trust_own, set_trust_signed, trust_own, trust_signed};

    // ---------------------------------------------------------------- R5 acct-prefs.json

    fn old_bool(dir: &Path, key: &str, default: bool) -> bool {
        std::fs::read_to_string(dir.join("acct-prefs.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.get(key).and_then(serde_json::Value::as_bool)).unwrap_or(default)
    }
    fn old_triple(dir: &Path) -> (bool, bool, bool) {
        let own = old_bool(dir, "remote_trust_own", false);
        let signed = old_bool(dir, "remote_trust_signed", true);
        let stored = std::fs::read_to_string(dir.join("acct-prefs.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.get("remote_allow_switch").and_then(serde_json::Value::as_bool));
        (own, signed, stored.unwrap_or(own || signed))
    }
    fn new_triple(dir: &Path) -> (bool, bool, bool) {
        (trust_own(dir), trust_signed(dir), allow_switch(dir))
    }

    #[test]
    fn 帳號偏好_各種舊格式讀出來和搬之前逐項一致() {
        let mut cases: Vec<&str> = NON_OBJECT.to_vec();
        cases.extend([
            "{}",
            r#"{"remote_trust_own":true}"#,
            r#"{"remote_trust_own":false}"#,
            r#"{"remote_trust_signed":false}"#,
            r#"{"remote_trust_signed":true}"#,
            r#"{"remote_allow_switch":false}"#,
            r#"{"remote_allow_switch":true,"remote_trust_signed":false}"#,
            r#"{"remote_allow_switch":false,"remote_trust_own":true}"#,
            r#"{"remote_trust_own":false,"remote_trust_signed":false}"#,
            r#"{"remote_trust_own":"yes","remote_trust_signed":null,"remote_allow_switch":1}"#,
            r#"{"remote_trust_own":1,"remote_trust_signed":0}"#,
            r#"{"remote_trust_own":true,"舊欄位":{"a":1},"remote_allow_switch":null}"#,
            r#"{"version":1,"remote_trust_signed":false}"#,
            r#"{"version":"x","remote_trust_own":true}"#,
            r#"{"version":7,"remote_allow_switch":false,"remote_trust_signed":true}"#,
        ]);
        for (i, c) in cases.iter().enumerate() {
            let d = tempfile::tempdir().unwrap();
            put(d.path(), "acct-prefs.json", c);
            let want = old_triple(d.path()); // 先算舊的
            let got = new_triple(d.path());
            assert_eq!(got, want, "第 {i} 組：{c}");
            if is_object(c) {
                assert!(files_with(d.path(), ".bad-").is_empty(), "第 {i} 組：物件內容不得產生 .bad-：{c}");
            }
        }
        let d = tempfile::tempdir().unwrap();
        let want = old_triple(d.path());
        assert_eq!(new_triple(d.path()), want);
        assert_eq!(want, (false, true, true), "沒有檔案時：不信任自己、信任簽章、允許切換");
        assert!(!d.path().join("acct-prefs.json").exists(), "讀取不建檔");
    }

    #[test]
    fn 預設值對照() {
        let d = AcctPrefsDoc::default();
        assert_eq!((d.remote_trust_own, d.remote_trust_signed, d.remote_allow_switch), (false, true, None));
        let p = PiAutoDoc::default();
        assert_eq!((p.auto, p.done), (true, false));
        assert!(!AgentSetupPrefsDoc::default().remote_allow_install);
        let q = QuotaReadersDoc::default();
        assert_eq!((q.grok, q.agy, q.minimax.len(), q.extra_claude, q.extra_claude_refresh), (false, false, 0, false, false));
    }

    #[test]
    fn 帳號偏好_寫一項保留其他項與不認得的欄位_舊版讀得出同樣的值() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "acct-prefs.json", r#"{"remote_trust_signed":false,"zzz":{"k":[1]},"remote_allow_switch":true}"#);
        set_trust_own(d.path(), true).unwrap();
        let v = disk(d.path(), "acct-prefs.json");
        assert_eq!(v["remote_trust_own"], true);
        assert_eq!(v["remote_trust_signed"], false, "沒動的那項還是原值");
        assert_eq!(v["remote_allow_switch"], true);
        assert_eq!(v["zzz"], json!({"k": [1]}));
        assert_eq!(v["version"], 1);
        assert!(d.path().join("acct-prefs.json.v0.bak").is_file());
        assert_eq!(old_triple(d.path()), new_triple(d.path()));
        assert_eq!(old_triple(d.path()), (true, false, true));
        // 沒存過 allow_switch 的檔：寫別項時不憑空多出 remote_allow_switch（沒存過時要靠前兩項換算）
        let d2 = tempfile::tempdir().unwrap();
        set_trust_signed(d2.path(), false).unwrap();
        assert!(disk(d2.path(), "acct-prefs.json").get("remote_allow_switch").is_none());
        assert_eq!(old_triple(d2.path()), (false, false, false));
        set_allow_switch(d2.path(), true).unwrap();
        assert_eq!(old_triple(d2.path()), (false, false, true));
    }

    #[test]
    fn 帳號偏好_三個寫入同時進來不互相蓋掉() {
        for round in 0..150 {
            let d = tempfile::tempdir().unwrap();
            put(d.path(), "acct-prefs.json", r#"{"zzz":1}"#);
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
            let p = d.path().to_path_buf();
            let hs: Vec<_> = (0..3)
                .map(|i| {
                    let (p, b) = (p.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        b.wait();
                        match i {
                            0 => set_trust_own(&p, true).unwrap(),
                            1 => set_trust_signed(&p, false).unwrap(),
                            _ => set_allow_switch(&p, false).unwrap(),
                        }
                    })
                })
                .collect();
            for h in hs {
                h.join().unwrap();
            }
            let v = disk(d.path(), "acct-prefs.json");
            assert_eq!((v["remote_trust_own"].clone(), v["remote_trust_signed"].clone(), v["remote_allow_switch"].clone(), v["zzz"].clone()), (json!(true), json!(false), json!(false), json!(1)), "第 {round} 輪：有寫入被蓋掉");
        }
    }

    #[test]
    fn 帳號偏好_讀不到原檔時寫入回錯_原檔不動() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "acct-prefs.json", "{壞掉");
        let before = std::fs::read(d.path().join("acct-prefs.json")).unwrap();
        let _g = FailQuarantine::on();
        assert!(set_trust_own(d.path(), true).is_err());
        assert!(set_trust_signed(d.path(), false).is_err());
        assert!(set_allow_switch(d.path(), true).is_err());
        assert_eq!(std::fs::read(d.path().join("acct-prefs.json")).unwrap(), before);
        assert_eq!(new_triple(d.path()), (false, true, true), "讀取端照舊回預設");
    }

    #[test]
    fn 帳號偏好_帶_bom_的合法_json_讀得出值_不產生_bad() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "acct-prefs.json", "\u{feff}{\"remote_trust_own\":true,\"remote_trust_signed\":false,\"remote_allow_switch\":false}");
        assert_eq!(new_triple(d.path()), (true, false, false));
        assert!(files_with(d.path(), ".bad-").is_empty());
    }

    #[test]
    fn 寫入失敗回給畫面的字串不含系統原文() {
        let d = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let _g = FailWrite::on();
        let errs = [
            set_trust_own(d.path(), true),
            set_trust_signed(d.path(), false),
            set_allow_switch(d.path(), true),
            crate::agent_setup::switch::set_remote_allowed(d.path(), true),
            crate::quota_readers::set_source(home.path(), "grok", true),
        ];
        for e in errs {
            let e = e.unwrap_err();
            assert!(plain(&e), "不該把系統原文送到畫面：{e}");
        }
    }

    #[test]
    fn 安裝偏好與pi自動安裝_帶_bom_的合法_json_讀得出值_不產生_bad() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "agent-setup-prefs.json", "\u{feff}{\"remote_allow_install\":true}");
        assert!(crate::agent_setup::switch::remote_allowed(d.path()));
        put(d.path(), "pi-auto.json", "\u{feff}{\"auto\":false,\"done\":true}");
        assert_eq!(crate::launch::pi_setup::auto_read(d.path()), (false, true));
        assert!(files_with(d.path(), ".bad-").is_empty());
    }

    // ---------------------------------------------------------------- agent-setup-prefs.json

    use crate::agent_setup::switch::{remote_allowed, set_remote_allowed};
    fn old_install(dir: &Path) -> bool {
        std::fs::read_to_string(dir.join("agent-setup-prefs.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.get("remote_allow_install").and_then(serde_json::Value::as_bool)).unwrap_or(false)
    }

    #[test]
    fn 安裝偏好_各種舊格式讀出來和搬之前逐項一致() {
        let mut cases: Vec<&str> = NON_OBJECT.to_vec();
        cases.extend([
            "{}",
            r#"{"remote_allow_install":true}"#,
            r#"{"remote_allow_install":false}"#,
            r#"{"remote_allow_install":"yes"}"#,
            r#"{"remote_allow_install":1}"#,
            r#"{"remote_allow_install":null}"#,
            r#"{"remote_allow_install":true,"舊欄位":1}"#,
            r#"{"version":1,"remote_allow_install":true}"#,
            r#"{"version":"x","remote_allow_install":true}"#,
        ]);
        for (i, c) in cases.iter().enumerate() {
            let d = tempfile::tempdir().unwrap();
            put(d.path(), "agent-setup-prefs.json", c);
            let want = old_install(d.path());
            assert_eq!(remote_allowed(d.path()), want, "第 {i} 組：{c}");
            if is_object(c) {
                assert!(files_with(d.path(), ".bad-").is_empty(), "第 {i} 組：物件內容不得產生 .bad-：{c}");
            }
        }
    }

    #[test]
    fn 安裝偏好_寫入保留不認得的欄位_舊版讀得出同樣的值_讀不到時回錯() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "agent-setup-prefs.json", r#"{"remote_allow_install":false,"future":[1,2]}"#);
        set_remote_allowed(d.path(), true).unwrap();
        let v = disk(d.path(), "agent-setup-prefs.json");
        assert_eq!((v["remote_allow_install"].clone(), v["future"].clone(), v["version"].clone()), (json!(true), json!([1, 2]), json!(1)));
        assert!(old_install(d.path()) && remote_allowed(d.path()));
        let d2 = tempfile::tempdir().unwrap();
        put(d2.path(), "agent-setup-prefs.json", "{壞");
        let before = std::fs::read(d2.path().join("agent-setup-prefs.json")).unwrap();
        let _g = FailQuarantine::on();
        assert!(set_remote_allowed(d2.path(), true).is_err());
        assert_eq!(std::fs::read(d2.path().join("agent-setup-prefs.json")).unwrap(), before);
        assert!(!remote_allowed(d2.path()));
    }

    // ---------------------------------------------------------------- R7 pi-auto.json

    use crate::launch::pi_setup::{auto_read, auto_write};
    fn old_pi(dir: &Path) -> (bool, bool) {
        let v = std::fs::read_to_string(dir.join("pi-auto.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let get = |k: &str, d: bool| v.as_ref().and_then(|v| v.get(k)).and_then(serde_json::Value::as_bool).unwrap_or(d);
        (get("auto", true), get("done", false))
    }

    #[test]
    fn pi自動安裝_各種舊格式讀出來和搬之前逐項一致() {
        let mut cases: Vec<&str> = NON_OBJECT.to_vec();
        cases.extend([
            "{}",
            r#"{"auto":false}"#,
            r#"{"auto":true}"#,
            r#"{"done":true}"#,
            r#"{"done":false}"#,
            r#"{"auto":false,"done":true}"#,
            r#"{"auto":"no","done":1}"#,
            r#"{"auto":null,"done":null}"#,
            r#"{"auto":false,"done":true,"舊欄位":{"a":1}}"#,
            r#"{"version":1,"auto":false}"#,
            r#"{"version":"x","done":true}"#,
        ]);
        for (i, c) in cases.iter().enumerate() {
            let d = tempfile::tempdir().unwrap();
            put(d.path(), "pi-auto.json", c);
            let want = old_pi(d.path());
            assert_eq!(auto_read(d.path()), want, "第 {i} 組：{c}");
            if is_object(c) {
                assert!(files_with(d.path(), ".bad-").is_empty(), "第 {i} 組：物件內容不得產生 .bad-：{c}");
            }
        }
        let d = tempfile::tempdir().unwrap();
        assert_eq!((old_pi(d.path()), auto_read(d.path())), ((true, false), (true, false)));
        assert!(!d.path().join("pi-auto.json").exists());
    }

    #[test]
    fn pi自動安裝_寫入保留不認得的欄位_舊版讀得出同樣的值_讀不到時不動原檔也不panic() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "pi-auto.json", r#"{"auto":true,"done":false,"future":"x"}"#);
        auto_write(d.path(), false, true);
        let v = disk(d.path(), "pi-auto.json");
        assert_eq!((v["auto"].clone(), v["done"].clone(), v["future"].clone(), v["version"].clone()), (json!(false), json!(true), json!("x"), json!(1)));
        assert_eq!(old_pi(d.path()), (false, true));
        assert_eq!(auto_read(d.path()), (false, true));
        // 沒有檔：寫出 auto 與 done 兩欄（舊版也是這兩欄）
        let d1 = tempfile::tempdir().unwrap();
        auto_write(d1.path(), true, true);
        assert_eq!(old_pi(d1.path()), (true, true));
        // 讀不到原檔：照舊吞掉（回 ()），原檔不動
        let d2 = tempfile::tempdir().unwrap();
        put(d2.path(), "pi-auto.json", "{壞");
        let before = std::fs::read(d2.path().join("pi-auto.json")).unwrap();
        let _g = FailQuarantine::on();
        auto_write(d2.path(), false, true);
        assert_eq!(std::fs::read(d2.path().join("pi-auto.json")).unwrap(), before);
        assert_eq!(auto_read(d2.path()), (true, false));
    }

    // ---------------------------------------------------------------- R6 quota-readers.json

    use crate::quota_readers::{load_settings, set_source, Settings, MAX_MINIMAX};
    fn old_quota(home: &Path) -> Settings {
        let Ok(text) = std::fs::read_to_string(home.join(".asn").join("quota-readers.json")) else { return Settings::default() };
        let mut s: Settings = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap_or_default();
        s.minimax = s.minimax.iter().filter_map(|e| crate::claude_accounts::normalize_email(e)).take(MAX_MINIMAX).collect();
        s.extra_claude_refresh = s.extra_claude_refresh && s.extra_claude;
        s
    }

    #[test]
    fn 讀額度設定_各種舊格式讀出來和搬之前逐項一致() {
        let mut cases: Vec<&str> = NON_OBJECT.to_vec();
        cases.extend([
            "{}",
            r#"{"grok":true}"#,
            r#"{"grok":"yes"}"#,
            r#"{"grok":true,"agy":"x"}"#,
            r#"{"grok":true,"minimax":"a"}"#,
            r#"{"grok":true,"minimax":[1]}"#,
            r#"{"grok":null}"#,
            r#"{"minimax":["A@x.test","壞","b@x.test","c@x.test"]}"#,
            r#"{"minimax":["A@x.test","a@X.test"]}"#,
            r#"{"extra_claude_refresh":true}"#,
            r#"{"extra_claude":true,"extra_claude_refresh":true}"#,
            r#"{"extra_claude":false,"extra_claude_refresh":true,"grok":true}"#,
            r#"{"grok":true,"agy":true,"minimax":["a@x.test"],"extra_claude":true,"extra_claude_refresh":true,"舊欄位":[1]}"#,
            "\u{feff}{\"grok\":true}",
            "\u{feff}",
            r#"{"version":1,"agy":true}"#,
            r#"{"version":"x","agy":true}"#,
        ]);
        for (i, c) in cases.iter().enumerate() {
            let home = tempfile::tempdir().unwrap();
            put(&home.path().join(".asn"), "quota-readers.json", c);
            let want = old_quota(home.path()); // 先算舊的
            let got = load_settings(home.path());
            assert_eq!(got, want, "第 {i} 組：{c}");
            if is_object(c.trim_start_matches('\u{feff}')) {
                assert!(files_with(&home.path().join(".asn"), ".bad-").is_empty(), "第 {i} 組：物件內容不得產生 .bad-：{c}");
            }
        }
        let home = tempfile::tempdir().unwrap();
        assert_eq!((old_quota(home.path()), load_settings(home.path())), (Settings::default(), Settings::default()));
        assert!(!home.path().join(".asn").join("quota-readers.json").exists());
    }

    #[test]
    fn 讀額度設定_寫入保留不認得的欄位_型別不對整份全關_舊版讀得出同樣的值() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".asn");
        put(&dir, "quota-readers.json", r#"{"grok":false,"minimax":["a@x.test"],"future":{"k":1}}"#);
        set_source(home.path(), "agy", true).unwrap();
        let v = disk(&dir, "quota-readers.json");
        assert_eq!((v["agy"].clone(), v["minimax"].clone(), v["future"].clone(), v["version"].clone()), (json!(true), json!(["a@x.test"]), json!({"k": 1}), json!(1)));
        assert_eq!(old_quota(home.path()), load_settings(home.path()));
        assert!(load_settings(home.path()).agy);
        // 型別不對：全關（跟舊版一致），不產生 .bad-；下一次存檔寫成乾淨的檔，不認得的欄位仍在
        put(&dir, "quota-readers.json", r#"{"grok":"yes","agy":true,"future":1}"#);
        assert_eq!(load_settings(home.path()), Settings::default());
        set_source(home.path(), "grok", true).unwrap();
        let v = disk(&dir, "quota-readers.json");
        assert_eq!((v["grok"].clone(), v["agy"].clone(), v["future"].clone()), (json!(true), json!(false), json!(1)));
        assert!(files_with(&dir, ".bad-").is_empty());
        // 換新要先開讀取（原本的規則）
        assert_eq!(set_source(home.path(), "extra_claude_refresh", true), Err("要先打開讀取".to_string()));
    }

    #[test]
    fn 讀額度設定_讀不到原檔時寫入回錯_原檔不動() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".asn");
        put(&dir, "quota-readers.json", "{壞");
        let before = std::fs::read(dir.join("quota-readers.json")).unwrap();
        let _g = FailQuarantine::on();
        assert!(set_source(home.path(), "grok", true).is_err());
        assert_eq!(std::fs::read(dir.join("quota-readers.json")).unwrap(), before);
        assert_eq!(load_settings(home.path()), Settings::default());
    }
}
