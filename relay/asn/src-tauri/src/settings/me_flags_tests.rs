//! #2162 ⑥：`me_flags`（Rust 端讀 asn-me.json 的 frame／closeTo／autoAddClaude）與搬家前三個舊讀法的逐項對照，
//! 以及「升級後再降級」：新版寫過的 asn-me.json，用舊的 store_load（整份讀文字）加舊的三個讀法讀，結果要相同。
//! 每次都「先算舊的、再算新的」，免得新讀法有任何副作用（搬檔）之後，舊讀法讀到不存在的檔而假綠。
use super::*;
use serde_json::json;
use std::path::Path;

// ---- 以下三個是搬進共用層之前的原樣複製（標準答案） ----
fn old_native_from_saved(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("frame")?.as_str().map(|f| f == "native")).unwrap_or(false)
}
fn old_close_to_tray_from_saved(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("closeTo")?.as_str().map(|c| c != "quit")).unwrap_or(true)
}
fn old_auto_enabled_from_saved(text: &str) -> bool {
    let _ = text;
    true
}
/// 搬家前三個呼叫處的讀檔法：讀不到檔就是各自的預設
fn old_flags(dir: &Path) -> (bool, bool, bool) {
    let f = dir.join("asn-me.json");
    (
        std::fs::read_to_string(&f).map(|t| old_native_from_saved(&t)).unwrap_or(false),
        std::fs::read_to_string(&f).map(|t| old_close_to_tray_from_saved(&t)).unwrap_or(true),
        std::fs::read_to_string(&f).map(|t| old_auto_enabled_from_saved(&t)).unwrap_or(true),
    )
}
fn new_flags(dir: &Path) -> (bool, bool, bool) {
    let m = me_flags(dir);
    (m.native_frame, m.close_to_tray, m.auto_add_claude)
}

fn files_with(dir: &Path, needle: &str) -> Vec<String> {
    std::fs::read_dir(dir).map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.contains(needle)).collect()).unwrap_or_default()
}

#[test]
fn 三個欄位_新舊讀法逐項對照() {
    let long = format!(r#"{{"frame":"native","pad":"{}"}}"#, "x".repeat(10_000));
    let mut cases: Vec<String> = [
        "", "{}", "{壞掉", "[]", "[1,2]", "null", "5", r#""native""#, "{", r#"{"frame":"native"}"#, r#"{"frame":"native","sound":true}"#,
        r#"{"frame":"custom"}"#, r#"{"frame":"Native"}"#, r#"{"frame":"native "}"#, r#"{"frame":true}"#, r#"{"frame":null}"#, r#"{"frame":5}"#,
        r#"{"frame":["native"]}"#, r#"{"closeTo":"quit"}"#, r#"{"closeTo":"quit","sound":true}"#, r#"{"closeTo":"tray"}"#, r#"{"closeTo":"Quit"}"#,
        r#"{"closeTo":null}"#, r#"{"closeTo":true}"#, r#"{"closeTo":7}"#, r#"{"closeTo":{}}"#, r#"{"autoAddClaude":false}"#,
        r#"{"autoAddClaude":true}"#, r#"{"autoAddClaude":null}"#, r#"{"autoAddClaude":"false"}"#, r#"{"autoAddClaude":false,"closeTo":"tray"}"#,
        r#"{"frame":"native","closeTo":"quit","autoAddClaude":false}"#, r#"{"sound":true}"#, r#"{"version":1,"frame":"native","closeTo":"quit"}"#,
        r#"{"version":"x","frame":"native"}"#, r#"{"version":99,"closeTo":"quit"}"#, r#"{"frame":"native","frame":"custom"}"#,
        r#"{"me":{"frame":"native","closeTo":"quit"}}"#, "{\n  \"frame\": \"native\",\n  \"closeTo\": \"quit\"\n}\n",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    cases.push(long);
    for (i, c) in cases.iter().enumerate() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("asn-me.json"), c).unwrap();
        let want = old_flags(d.path()); // 先算舊的
        let got = new_flags(d.path());
        assert_eq!(got, want, "第 {i} 組：{c}");
        // 唯讀：原檔一個位元組都不能動、不產生 .bad-、不產生暫存檔
        assert_eq!(std::fs::read_to_string(d.path().join("asn-me.json")).unwrap(), *c, "第 {i} 組：檔案被動過");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1, "第 {i} 組：多出檔案");
    }
}

#[test]
fn 三個欄位_檔案不存在與無效編碼_新舊相同_且不建檔() {
    let d = tempfile::tempdir().unwrap();
    let want = old_flags(d.path());
    assert_eq!(new_flags(d.path()), want);
    assert_eq!(want, (false, true, true), "預設：自訂外框、縮到系統匣、自動加入開");
    assert!(!d.path().join("asn-me.json").exists());
    // 不合法的 UTF-8：舊的 read_to_string 失敗＝預設；新的也要是預設，不搬檔
    std::fs::write(d.path().join("asn-me.json"), [0xff, 0xfe, b'{', 0xc3, 0x28]).unwrap();
    let want = old_flags(d.path());
    assert_eq!(new_flags(d.path()), want);
    assert_eq!(want, (false, true, true));
    assert!(files_with(d.path(), ".bad-").is_empty());
}

#[test]
fn 三個欄位_帶_bom_的檔_是唯一有意的差異() {
    // 手改設定的人常帶 UTF-8 BOM。舊讀法 `from_str` 遇到 BOM 整份失敗（回預設），共用層讀檔會先去掉 BOM（與其他設定檔一致）。
    // 這裡把差異釘死：舊的回預設，新的讀得到使用者明明寫了的值；兩邊都不搬檔。
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("asn-me.json"), "\u{feff}{\"frame\":\"native\",\"closeTo\":\"quit\"}").unwrap();
    assert_eq!(old_flags(d.path()), (false, true, true));
    assert_eq!(new_flags(d.path()), (true, false, true));
    assert!(files_with(d.path(), ".bad-").is_empty());
    // 沒有那兩欄的 BOM 檔：兩邊都是預設
    std::fs::write(d.path().join("asn-me.json"), "\u{feff}{\"sound\":true}").unwrap();
    assert_eq!(new_flags(d.path()), old_flags(d.path()));
}

#[test]
fn 升級後再降級_新版改過的檔舊讀法讀得到一樣的值() {
    let d = tempfile::tempdir().unwrap();
    // 舊版（前端整份存）寫的檔
    let before = r#"{"frame":"custom","closeTo":"quit","autoAddClaude":false,"chatPins":["a"],"future":{"x":[1]}}"#;
    std::fs::write(d.path().join("asn-me.json"), before).unwrap();
    let old_before = old_flags(d.path());
    // 新版：先 patch 別的欄位，三個旗標不變
    patch_json(d.path(), RawName::Me, json!({"chatPins":["a","b"],"extra_new":1}).as_object().unwrap().clone()).unwrap();
    let text = load_text(d.path(), RawName::Me).unwrap(); // 舊的 store_load：整份讀文字
    assert_eq!(old_flags(d.path()), old_before, "舊讀法讀到的三個旗標不變");
    assert_eq!(new_flags(d.path()), old_before);
    // 舊版前端 JSON.parse 這份文字，欄位原樣都在（含新版加的與舊版不認得的）
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["future"], json!({"x":[1]}));
    assert_eq!(v["chatPins"], json!(["a", "b"]));
    assert_eq!(v["closeTo"], json!("quit"));
    assert!(v.get("version").is_none(), "這一張不加 version，舊版看到的檔案長相與以前一樣");
    // 新版改三個旗標本身：舊讀法立刻看得到
    patch_json(d.path(), RawName::Me, json!({"frame":"native","closeTo":"tray"}).as_object().unwrap().clone()).unwrap();
    assert_eq!(old_flags(d.path()), (true, true, true));
    assert_eq!(new_flags(d.path()), old_flags(d.path()));
    // 新版整份存（前端 store_save 路徑）：同樣
    save_text(d.path(), RawName::Me, r#"{"frame":"native","closeTo":"quit"}"#).unwrap();
    assert_eq!(old_flags(d.path()), (true, false, true));
    assert_eq!(new_flags(d.path()), old_flags(d.path()));
}
