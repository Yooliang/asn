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
fn 存檔不檢查內容_原文照寫_位元組一模一樣() {
    // 以前的 store_save 從不解析；現在也不能因為解析不了而拒存（含孤立 surrogate 的文字 serde_json 讀不了，但 JSON.stringify 會產出）
    let d = tempfile::tempdir().unwrap();
    let texts = [
        r#"{"friends":[{"id":"a","name":"\ud83d"}],"logs":{"a":[{"t":1,"text":"被截斷的表情 \ud83d"}]}}"#,
        "{
  \"k\" : [1,
2]  }
",
        "[1]",
        "5",
        "{壞掉",
        "",
    ];
    for (name, file) in [(RawName::Me, "asn-me.json"), (RawName::Onboard, "asn-onboard.json"), (RawName::Chats, "asn-chats.json")] {
        for t in texts {
            save_text(d.path(), name, t).unwrap_or_else(|e| panic!("{file} {t:?}：{e}"));
            assert_eq!(std::fs::read(d.path().join(file)).unwrap(), t.as_bytes(), "{file} {t:?}");
            assert_eq!(load_text(d.path(), name).as_deref(), Some(t));
        }
    }
}

#[test]
fn 修補_舊檔含孤立_surrogate_回白話錯誤_原檔不動_也不搬成壞檔() {
    let d = tempfile::tempdir().unwrap();
    let old = r#"{"keep":1,"s":"\ud83d"}"#;
    for (name, file) in [(RawName::Me, "asn-me.json"), (RawName::Onboard, "asn-onboard.json"), (RawName::Chats, "asn-chats.json")] {
        put(d.path(), file, old);
        let e = patch_json(d.path(), name, obj(json!({"a":1}))).unwrap_err();
        assert_eq!(e, "設定檔內容無法合併，這次沒有存", "{file}");
        assert_eq!(read(d.path(), file), old, "{file} 原檔不動");
    }
    assert!(files_with(d.path(), ".bad-").is_empty() && files_with(d.path(), ".tmp").is_empty());
    // 舊檔本來就是壞的 JSON，patch 也一樣不動它（要救得先整份存）
    put(d.path(), "asn-me.json", "{壞掉");
    assert!(patch_json(d.path(), RawName::Me, obj(json!({"a":1}))).is_err());
    assert_eq!(read(d.path(), "asn-me.json"), "{壞掉");
    assert!(files_with(d.path(), ".bad-").is_empty());
}

#[test]
fn 存檔_整份寫入_原文照寫_不補版本() {
    let d = tempfile::tempdir().unwrap();
    let text = r#"{"z":1,"a":{"b":[1,2]},"version":7,"frame":"native"}"#;
    save_text(d.path(), RawName::Me, text).unwrap();
    // 原文照寫（連前端帶來的 version 也一樣，這張不碰版本）
    assert_eq!(read(d.path(), "asn-me.json"), text);
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
fn 整份存檔_舊檔是壞檔也直接蓋過去_不留備份() {
    // 整份存的內容就是畫面的全部狀態，覆蓋就是正確結果；save_text 不讀舊檔、不判斷、不搬檔
    let d = tempfile::tempdir().unwrap();
    for (name, file) in [(RawName::Me, "asn-me.json"), (RawName::Onboard, "asn-onboard.json"), (RawName::Chats, "asn-chats.json")] {
        put(d.path(), file, "{壞掉");
        save_text(d.path(), name, r#"{"ok":1}"#).unwrap();
        assert_eq!(read(d.path(), file), r#"{"ok":1}"#);
    }
    assert!(files_with(d.path(), ".bad-").is_empty());
}

#[test]
fn 整份存檔_舊檔含孤立_surrogate_連續存兩次_不產生備份() {
    let d = tempfile::tempdir().unwrap();
    let old = r#"{"keep":1,"s":"\ud83d"}"#;
    // 舊檔 serde 讀不了（但其實是 JS 寫得出來的合法內容）：save_text 不讀舊檔，所以不會搬走它、也不會每次都記一行 log
    let mut results = vec![];
    for (name, file) in [(RawName::Me, "asn-me.json"), (RawName::Onboard, "asn-onboard.json"), (RawName::Chats, "asn-chats.json")] {
        put(d.path(), file, old);
        for i in 0..2 {
            let text = format!(r#"{{"n":{i},"s":"\ud83d"}}"#);
            results.push((file, save_text(d.path(), name, &text)));
            assert_eq!(read(d.path(), file), text);
        }
    }
    for (file, r) in results {
        assert!(r.is_ok(), "{file}：{r:?}");
    }
    assert!(files_with(d.path(), ".bad-").is_empty());
}

#[test]
fn 整份存檔_寫入失敗時原檔逐字不變_回白話錯誤() {
    let d = tempfile::tempdir().unwrap();
    let old = r#"{"keep": 1,
 "s":"\ud83d"}"#;
    for (name, file) in [(RawName::Me, "asn-me.json"), (RawName::Onboard, "asn-onboard.json"), (RawName::Chats, "asn-chats.json")] {
        put(d.path(), file, old);
        FAIL_WRITE.with(|f| f.set(true));
        let r = save_text(d.path(), name, r#"{"new":1}"#);
        FAIL_WRITE.with(|f| f.set(false));
        let e = r.unwrap_err();
        assert!(!e.contains("os error"), "{e}");
        assert_eq!(std::fs::read(d.path().join(file)).unwrap(), old.as_bytes(), "{file} 原檔逐字不變");
    }
    assert!(files_with(d.path(), ".bad-").is_empty() && files_with(d.path(), ".tmp").is_empty());
}

#[test]
fn 修補_合併後超過上限就不寫_原檔不動() {
    let d = tempfile::tempdir().unwrap();
    // 兩邊各約 5MB：單獨都沒超過，合起來超過 8,000,000
    let old = format!(r#"{{"a":"{}"}}"#, "x".repeat(5_000_000));
    put(d.path(), "asn-chats.json", &old);
    let e = patch_json(d.path(), RawName::Chats, obj(json!({"b": "y".repeat(5_000_000)}))).unwrap_err();
    assert_eq!(e, "存檔太大");
    assert_eq!(read(d.path(), "asn-chats.json"), old);
    // 蓋掉同一欄、合併後沒變大：照常寫
    patch_json(d.path(), RawName::Chats, obj(json!({"a": "z"}))).unwrap();
    assert_eq!(read(d.path(), "asn-chats.json"), r#"{"a":"z"}"#);
    assert!(files_with(d.path(), ".bad-").is_empty() && files_with(d.path(), ".tmp").is_empty());
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

/// 所有 Doc 型別的名單（名稱，檢查函式）。新增 Doc 要加進來，`doc_list_is_complete` 會掃原始碼比對數量
fn all_docs() -> Vec<(&'static str, fn())> {
    let mut v: Vec<(&'static str, fn())> = vec![
        ("NamesDoc", assert_keeps_extra::<NamesDoc>),
        ("MeDoc", assert_keeps_extra::<MeDoc>),
        ("OnboardDoc", assert_keeps_extra::<OnboardDoc>),
        ("ChatsDoc", assert_keeps_extra::<ChatsDoc>),
    ];
    #[cfg(desktop)]
    v.extend([
        ("AcctPrefsDoc", assert_keeps_extra::<AcctPrefsDoc> as fn()),
        ("AgentSetupPrefsDoc", assert_keeps_extra::<AgentSetupPrefsDoc>),
        ("PiAutoDoc", assert_keeps_extra::<PiAutoDoc>),
        ("QuotaReadersDoc", assert_keeps_extra::<QuotaReadersDoc>), // 手寫 Deserialize 的那個：已知欄位全對時一樣有留下
        ("VoiceDoc", assert_keeps_extra::<VoiceDoc>),
        ("LaunchPrefsDoc", assert_keeps_extra::<LaunchPrefsDoc>),
        ("BridgeDoc", assert_keeps_extra::<BridgeDoc>),
    ]);
    v
}

#[test]
fn extra_kept_by_every_doc() {
    for (_, f) in all_docs() {
        f();
    }
}

/// 掃 src 底下所有非測試檔的 `impl Doc for`（`raw.rs` 的巨集一次產三個型別，改數 `raw_doc!(` 的呼叫），
/// 數量要等於上面名單的長度：新增 Doc 型別卻忘了加進名單，這裡就紅
#[test]
fn doc_list_is_complete() {
    fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let mut files = vec![];
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let (mut impls, mut scanned_raw) = (0, false);
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        if name == "tests.rs" || name.ends_with("_tests.rs") {
            continue; // 測試檔裡自己宣告的假 Doc 不算
        }
        let text = std::fs::read_to_string(&f).unwrap();
        if name == "raw.rs" && f.parent().is_some_and(|d| d.ends_with("settings")) {
            // 巨集本體裡有一行 `impl Doc for $name`，實際產生幾個型別看 `raw_doc!(` 呼叫（行首）有幾處
            impls += text.lines().filter(|l| l.starts_with("raw_doc!(")).count();
            scanned_raw = true;
        } else {
            impls += text.matches("impl Doc for ").count() + text.matches("impl crate::settings::Doc for ").count();
        }
    }
    assert!(scanned_raw, "掃不到 settings/raw.rs，掃描規則失效");
    assert_eq!(impls, all_docs().len(), "原始碼裡的 Doc 型別數與 extra_kept_by_every_doc 的名單長度不同：新增的型別要加進 all_docs()");
}
