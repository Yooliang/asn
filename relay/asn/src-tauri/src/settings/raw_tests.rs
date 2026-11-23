//! #2162 ⑥：畫面整份存取的三個存檔（me／onboard／chats）後端的測試。全部用暫存資料夾。
use super::*;
use serde_json::{json, Map, Value};
use std::path::Path;

fn put(dir: &Path, name: &str, text: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), text).unwrap();
}
fn files_with(dir: &Path, needle: &str) -> Vec<String> {
    std::fs::read_dir(dir).map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.contains(needle)).collect()).unwrap_or_default()
}
fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}
fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => panic!("不是物件"),
    }
}

#[test]
fn 存檔超過上限整筆拒絕_原檔不動() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "asn-me.json", r#"{"keep":1}"#);
    // 剛好上限：收；多一個位元組：拒
    let pad = |n: usize| format!(r#"{{"k":"{}"}}"#, "x".repeat(n - 8));
    let at = pad(MAX_BYTES);
    assert_eq!(at.len(), MAX_BYTES);
    assert!(save_text(d.path(), RawName::Me, &at).is_ok());
    put(d.path(), "asn-me.json", r#"{"keep":1}"#);
    let over = pad(MAX_BYTES + 1);
    assert_eq!(save_text(d.path(), RawName::Me, &over).unwrap_err(), "存檔太大");
    assert_eq!(read(d.path(), "asn-me.json"), r#"{"keep":1}"#, "原檔不動");
    assert!(files_with(d.path(), ".tmp").is_empty() && files_with(d.path(), ".bad-").is_empty());
}

#[test]
fn 白名單外的名稱被拒() {
    for bad in ["", "foo", "ME", "Me", "me.json", "asn-me", "../me", "me/", "settings", "voice", "chats2", " me"] {
        assert_eq!(RawName::parse(bad).unwrap_err(), SettingsError("存檔名稱不合格".into()), "{bad:?}");
    }
    assert_eq!(RawName::parse("me"), Ok(RawName::Me));
    assert_eq!(RawName::parse("onboard"), Ok(RawName::Onboard));
    assert_eq!(RawName::parse("chats"), Ok(RawName::Chats));
}

#[test]
fn 存檔內容不是物件就拒絕() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "asn-onboard.json", r#"{"done":true}"#);
    for t in ["[1]", "5", "null", "\"x\"", "{壞掉", ""] {
        assert!(save_text(d.path(), RawName::Onboard, t).is_err(), "{t}");
    }
    assert_eq!(read(d.path(), "asn-onboard.json"), r#"{"done":true}"#);
}

#[test]
fn 存檔_整份寫入_單行_不加版本_欄位順序不變() {
    let d = tempfile::tempdir().unwrap();
    let text = r#"{"z":1,"a":{"b":[1,2]},"version":7,"frame":"native"}"#;
    save_text(d.path(), RawName::Me, text).unwrap();
    // 前端帶來的 version 不照寫（版本號由共用層管，這張還沒開始用）
    assert_eq!(read(d.path(), "asn-me.json"), r#"{"z":1,"a":{"b":[1,2]},"frame":"native"}"#);
    // 讀出來是原文字串
    assert_eq!(load_text(d.path(), RawName::Me).unwrap(), read(d.path(), "asn-me.json"));
    assert_eq!(load_text(d.path(), RawName::Chats), None, "沒有就是 None，也不建檔");
    assert!(!d.path().join("asn-chats.json").exists());
}

#[test]
fn 修補_不認得的欄位保留_null_刪欄() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "asn-me.json", r#"{"frame":"custom","future":{"x":[1,2]},"closeTo":"quit","drop":1}"#);
    patch_json(d.path(), RawName::Me, obj(json!({"frame":"native","drop":null,"added":true}))).unwrap();
    let now: Value = serde_json::from_str(&read(d.path(), "asn-me.json")).unwrap();
    assert_eq!(now, json!({"frame":"native","future":{"x":[1,2]},"closeTo":"quit","added":true}));
    // 刪掉一個本來就沒有的欄位不出錯
    patch_json(d.path(), RawName::Me, obj(json!({"nothing":null}))).unwrap();
    // 想用 patch 改版本號沒有用
    patch_json(d.path(), RawName::Me, obj(json!({"version":99}))).unwrap();
    assert!(!read(d.path(), "asn-me.json").contains("version"));
    // 檔案不存在也能 patch（等於建檔）
    patch_json(d.path(), RawName::Onboard, obj(json!({"done":true}))).unwrap();
    assert_eq!(read(d.path(), "asn-onboard.json"), r#"{"done":true}"#);
}

#[test]
fn 修補_兩條執行緒同時改不同欄位都不會丟() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "asn-me.json", r#"{"base":1}"#);
    let dir = d.path().to_path_buf();
    let mut hs = vec![];
    for t in 0..2 {
        let dir = dir.clone();
        hs.push(std::thread::spawn(move || {
            for i in 0..40 {
                patch_json(&dir, RawName::Me, obj(json!({ format!("t{t}"): i }))).unwrap();
            }
        }));
    }
    for h in hs {
        h.join().unwrap();
    }
    let now: Value = serde_json::from_str(&read(d.path(), "asn-me.json")).unwrap();
    assert_eq!(now, json!({"base":1,"t0":39,"t1":39}));
}

#[test]
fn 修補_過大的內容整筆拒絕() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "asn-me.json", r#"{"keep":1}"#);
    let big = obj(json!({"k": "x".repeat(MAX_BYTES)}));
    assert_eq!(patch_json(d.path(), RawName::Me, big).unwrap_err(), "存檔太大");
    assert_eq!(read(d.path(), "asn-me.json"), r#"{"keep":1}"#);
}

#[test]
fn 讀取壞檔_回原文_不搬檔不改檔() {
    let d = tempfile::tempdir().unwrap();
    for (name, file) in [(RawName::Me, "asn-me.json"), (RawName::Onboard, "asn-onboard.json"), (RawName::Chats, "asn-chats.json")] {
        put(d.path(), file, "{壞掉");
        assert_eq!(load_text(d.path(), name).as_deref(), Some("{壞掉"));
        assert_eq!(read(d.path(), file), "{壞掉");
    }
    assert!(files_with(d.path(), ".bad-").is_empty());
}

#[test]
fn me_寫入時壞檔先搬走() {
    let d = tempfile::tempdir().unwrap();
    for (name, file) in [(RawName::Me, "asn-me.json"), (RawName::Onboard, "asn-onboard.json")] {
        put(d.path(), file, "{壞掉");
        save_text(d.path(), name, r#"{"ok":1}"#).unwrap();
        assert_eq!(read(d.path(), file), r#"{"ok":1}"#);
        let bad = files_with(d.path(), &format!("{file}.bad-"));
        assert_eq!(bad.len(), 1, "{file}");
        assert_eq!(read(d.path(), &bad[0]), "{壞掉", "備份是原本的壞內容");
    }
    // 用 patch 寫入也一樣
    put(d.path(), "asn-me.json", "[壞");
    patch_json(d.path(), RawName::Me, obj(json!({"a":1}))).unwrap();
    assert_eq!(files_with(d.path(), "asn-me.json.bad-").len(), 2);
}

#[test]
fn chats_壞了退回空的_不產生備份() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "asn-chats.json", "{壞掉");
    // 讀：整份原文照給，畫面自己 parse 失敗就當空的
    assert_eq!(load_text(d.path(), RawName::Chats).as_deref(), Some("{壞掉"));
    // 共用層讀（會搬檔的那種）：退回空的，但不搬
    let l = load_in::<ChatsDoc>(d.path());
    assert!(l.value.extra.is_empty());
    assert!(matches!(l.status, LoadStatus::Corrupt { .. }), "{:?}", l.status);
    assert!(files_with(d.path(), ".bad-").is_empty());
    // 寫：直接覆蓋，不留 .bad-
    save_text(d.path(), RawName::Chats, r#"{"friends":[],"logs":{}}"#).unwrap();
    assert_eq!(read(d.path(), "asn-chats.json"), r#"{"friends":[],"logs":{}}"#);
    assert!(files_with(d.path(), ".bad-").is_empty() && files_with(d.path(), ".bak").is_empty());
    // patch 壞檔也一樣
    put(d.path(), "asn-chats.json", "{壞掉");
    patch_json(d.path(), RawName::Chats, obj(json!({"a":1}))).unwrap();
    assert_eq!(read(d.path(), "asn-chats.json"), r#"{"a":1}"#);
    assert!(files_with(d.path(), ".bad-").is_empty());
}

#[test]
fn 壞檔搬不走時寫入回白話錯誤_原檔不動() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "asn-me.json", "{壞掉");
    migrate::FAIL_RENAME.with(|f| f.set(true));
    migrate::FAIL_COPY.with(|f| f.set(true));
    let r = save_text(d.path(), RawName::Me, r#"{"a":1}"#);
    migrate::FAIL_RENAME.with(|f| f.set(false));
    migrate::FAIL_COPY.with(|f| f.set(false));
    let e = r.unwrap_err();
    assert!(!e.contains("os error"), "{e}");
    assert_eq!(read(d.path(), "asn-me.json"), "{壞掉");
}

/// 每個 Doc 型別都要把不認得的欄位實際留下來（型別層的 `extra()` 擋掉「忘了宣告」，這裡擋掉「宣告了但沒接起來」）
fn assert_keeps_extra<T: Doc>() {
    let text = r#"{"zz_future":{"a":[1,2]},"zz_n":5}"#;
    let (v, _) = migrate::parse::<T>(text).unwrap_or_else(|e| panic!("{} 解析失敗：{e}", T::NAME));
    assert_eq!(v.extra().get("zz_future"), Some(&json!({"a":[1,2]})), "{} 讀進來丟了不認得的欄位", T::NAME);
    let back: Value = serde_json::from_str(&migrate::render(&v, T::VERSION).unwrap()).unwrap();
    assert_eq!(back.get("zz_future"), Some(&json!({"a":[1,2]})), "{} 寫回去丟了不認得的欄位", T::NAME);
    assert_eq!(back.get("zz_n"), Some(&json!(5)), "{}", T::NAME);
}

#[test]
fn extra_kept_by_every_doc() {
    assert_keeps_extra::<NamesDoc>();
    assert_keeps_extra::<MeDoc>();
    assert_keeps_extra::<OnboardDoc>();
    assert_keeps_extra::<ChatsDoc>();
    #[cfg(desktop)]
    {
        assert_keeps_extra::<AcctPrefsDoc>();
        assert_keeps_extra::<AgentSetupPrefsDoc>();
        assert_keeps_extra::<PiAutoDoc>();
        assert_keeps_extra::<QuotaReadersDoc>(); // 手寫 Deserialize 的那個：已知欄位全對時一樣有留下
        assert_keeps_extra::<VoiceDoc>();
        assert_keeps_extra::<LaunchPrefsDoc>();
        assert_keeps_extra::<BridgeDoc>();
    }
}
