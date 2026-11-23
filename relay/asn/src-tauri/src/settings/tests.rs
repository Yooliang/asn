//! 共用設定層的測試。全部用暫存資料夾，不碰真的資料夾。
use super::*;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
struct TA {
    a: i64,
    b: i64,
    #[serde(flatten)]
    extra: Map<String, Value>,
}
impl Doc for TA {
    const NAME: &'static str = "t-a";
    const SCOPE: Scope = Scope::Data;
    const VERSION: u32 = 1;

    fn extra(&self) -> &Map<String, Value> {

        &self.extra

    }
}

/// 版本 2：0→1 把 old 改名 mid，1→2 把 mid 改名 name（各自冪等：沒有舊欄位就不動）
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
struct TM {
    name: String,
    #[serde(flatten)]
    extra: Map<String, Value>,
}
impl Doc for TM {
    const NAME: &'static str = "t-m";
    const SCOPE: Scope = Scope::Home;
    const VERSION: u32 = 2;

    fn extra(&self) -> &Map<String, Value> {

        &self.extra

    }
    fn migrate(from: u32, raw: &mut Value) -> Result<(), String> {
        let o = raw.as_object_mut().ok_or("不是物件")?;
        let (src, dst) = match from {
            0 => ("old", "mid"),
            1 => ("mid", "name"),
            _ => return Err("沒有這一版".into()),
        };
        if let Some(v) = o.remove(src) {
            o.insert(dst.into(), v);
        }
        Ok(())
    }
}

/// 遷移一定失敗的檔，測「遷移失敗也當壞檔」
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct TF {
    #[serde(flatten)]
    extra: Map<String, Value>,
}
impl Doc for TF {
    const NAME: &'static str = "t-f";
    const SCOPE: Scope = Scope::Work;
    const VERSION: u32 = 1;

    fn extra(&self) -> &Map<String, Value> {

        &self.extra

    }
    fn migrate(_: u32, _: &mut Value) -> Result<(), String> {
        Err("故意失敗".into())
    }
}

fn put(dir: &Path, name: &str, text: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), text).unwrap();
}
fn names(dir: &Path, prefix: &str) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.starts_with(prefix)).collect();
    v.sort();
    v
}
fn disk(dir: &Path, name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap()
}

#[test]
fn 檔案不存在是_fresh_而且不建檔() {
    let d = tempfile::tempdir().unwrap();
    let l = load_in::<TA>(d.path());
    assert_eq!(l.status, LoadStatus::Fresh);
    assert_eq!(l.value, TA::default());
    assert!(!d.path().join("t-a.json").exists());
    assert!(std::fs::read_dir(d.path()).unwrap().next().is_none());
}

#[test]
fn 舊檔沒有版本讀得進來而且讀取不改檔() {
    let d = tempfile::tempdir().unwrap();
    let old = "{\"a\": 3,\n \"b\": 4}";
    put(d.path(), "t-a.json", old);
    let l = load_in::<TA>(d.path());
    assert_eq!(l.status, LoadStatus::Migrated { from: 0 });
    assert_eq!((l.value.a, l.value.b), (3, 4));
    assert_eq!(std::fs::read_to_string(d.path().join("t-a.json")).unwrap(), old, "讀取不能改檔");
    assert!(names(d.path(), "t-a.json.").is_empty(), "讀取不能產生備份");
    // 第一次正常寫入才補上 version，並備份舊內容
    update_in::<TA, _>(d.path(), |t| t.a = 9).unwrap();
    assert_eq!(disk(d.path(), "t-a.json")["version"], 1);
    assert_eq!(std::fs::read_to_string(d.path().join("t-a.json.v0.bak")).unwrap(), old);
    // 備份同名已存在就不覆蓋
    update_in::<TA, _>(d.path(), |t| t.a = 10).unwrap();
    assert_eq!(std::fs::read_to_string(d.path().join("t-a.json.v0.bak")).unwrap(), old);
}

#[test]
fn 版本相同是_ok() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", r#"{"version":1,"a":5}"#);
    let l = load_in::<TA>(d.path());
    assert_eq!(l.status, LoadStatus::Ok);
    assert_eq!(l.value.a, 5);
    assert!(l.value.extra.is_empty(), "version 不能漏進 extra");
}

#[test]
fn 壞檔備份並退回預設_最多留三份() {
    let d = tempfile::tempdir().unwrap();
    for i in 0..5 {
        put(d.path(), "t-a.json", &format!("{{壞掉{i}"));
        let l = load_in::<TA>(d.path());
        assert_eq!(l.status, LoadStatus::Recovered);
        assert_eq!(l.value, TA::default());
        assert!(!d.path().join("t-a.json").exists(), "壞檔要被改名搬走");
    }
    let bad = names(d.path(), "t-a.json.bad-");
    assert_eq!(bad.len(), 3);
    // 留下的是最新的三份
    let contents: Vec<String> = bad.iter().map(|n| std::fs::read_to_string(d.path().join(n)).unwrap()).collect();
    assert_eq!(contents, vec!["{壞掉2", "{壞掉3", "{壞掉4"]);
}

#[test]
fn 型別不符與最上層不是物件也算壞檔() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", r#"{"a":"不是數字"}"#);
    assert_eq!(load_in::<TA>(d.path()).status, LoadStatus::Recovered);
    put(d.path(), "t-a.json", "[1,2]");
    assert_eq!(load_in::<TA>(d.path()).status, LoadStatus::Recovered);
    assert_eq!(names(d.path(), "t-a.json.bad-").len(), 2);
}

#[test]
fn 遷移失敗也當壞檔() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-f.json", r#"{"x":1}"#);
    let l = load_in::<TF>(d.path());
    assert_eq!(l.status, LoadStatus::Recovered);
    assert_eq!(names(d.path(), "t-f.json.bad-").len(), 1);
}

#[test]
fn 新版的檔保留不認得的欄位且版本不降() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", r#"{"version":7,"a":1,"b":2,"future":{"k":[1,2]}}"#);
    let l = load_in::<TA>(d.path());
    assert_eq!(l.status, LoadStatus::Newer { file_version: 7 });
    update_in::<TA, _>(d.path(), |t| t.a = 100).unwrap();
    let v = disk(d.path(), "t-a.json");
    assert_eq!(v["version"], 7, "版本號不降");
    assert_eq!(v["future"], json!({"k":[1,2]}), "不認得的欄位要保留");
    assert_eq!((v["a"].as_i64(), v["b"].as_i64()), (Some(100), Some(2)));
    assert_eq!(names(d.path(), "t-a.json."), vec!["t-a.json.v7.bak".to_string()], "新版檔只備份一份 .v7.bak，不遷移");
}

#[test]
fn 兩條執行緒同時更新不同欄位不會丟() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().to_path_buf();
    let bar = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mk = |first: bool| {
        let (p, bar) = (p.clone(), bar.clone());
        std::thread::spawn(move || {
            bar.wait();
            for _ in 0..25 {
                update_in::<TA, _>(&p, |t| {
                    // 讀完之後停一下，讓另一條有機會在這段空檔插進來（沒鎖就會互蓋）
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    if first {
                        t.a += 1
                    } else {
                        t.b += 1
                    }
                })
                .unwrap();
            }
        })
    };
    let (t1, t2) = (mk(true), mk(false));
    t1.join().unwrap();
    t2.join().unwrap();
    let v = disk(&p, "t-a.json");
    assert_eq!((v["a"].as_i64(), v["b"].as_i64()), (Some(25), Some(25)));
}

#[test]
fn 遷移有冪等性() {
    let text = r#"{"old":"甲","other":1}"#;
    let (a, va) = migrate::parse::<TM>(text).unwrap();
    let (b, vb) = migrate::parse::<TM>(text).unwrap();
    assert_eq!((a.clone(), va), (b, vb));
    assert_eq!(a.name, "甲");
    assert_eq!(a.extra["other"], 1);
    // 已經升好的內容再升一次（版本 0 的檔裡其實已經是新欄位）結果不變
    let (c, _) = migrate::parse::<TM>(r#"{"name":"甲","other":1}"#).unwrap();
    assert_eq!(a, c);
    // 同一份檔經過「讀、寫、再讀」跑兩輪，結果一樣
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-m.json", text);
    let first = load_in::<TM>(d.path());
    assert_eq!(first.status, LoadStatus::Migrated { from: 0 });
    update_in::<TM, _>(d.path(), |_| {}).unwrap();
    let again = load_in::<TM>(d.path());
    assert_eq!(again.status, LoadStatus::Ok);
    assert_eq!(again.value, first.value);
    assert_eq!(disk(d.path(), "t-m.json")["version"], 2);
    assert_eq!(std::fs::read_to_string(d.path().join("t-m.json.v0.bak")).unwrap(), text);
}

#[test]
fn 快取在檔案被外部改掉時會重讀() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", r#"{"version":1,"a":1}"#);
    assert_eq!(load_in::<TA>(d.path()).value.a, 1);
    // 長度不同，修改時間即使同一刻也能分辨
    put(d.path(), "t-a.json", r#"{"version":1,"a":12345}"#);
    assert_eq!(load_in::<TA>(d.path()).value.a, 12345);
}

#[test]
fn 用根資料夾讀寫_三種範圍各自落在對應的資料夾() {
    let d = tempfile::tempdir().unwrap();
    init_for_test(d.path());
    // 資料夾都不存在：讀回預設、不建檔
    assert_eq!(load::<TM>().status, LoadStatus::Fresh);
    assert!(!d.path().join("home").exists());
    save(&TM { name: "乙".into(), ..Default::default() }).unwrap();
    assert!(d.path().join("home").join("t-m.json").is_file());
    assert_eq!(get::<TM>().name, "乙");
    update::<TA, _>(|t| t.a = 2).unwrap();
    assert!(d.path().join("data").join("t-a.json").is_file());
    update::<TF, _>(|_| {}).unwrap();
    assert!(d.path().join("work").join("t-f.json").is_file());
}

#[test]
fn 寫入走原子寫入_不留下_tmp() {
    let d = tempfile::tempdir().unwrap();
    update_in::<TA, _>(d.path(), |t| t.a = 1).unwrap();
    assert!(names(d.path(), "t-a.json.").is_empty());
    assert_eq!(names(d.path(), "").len(), 1);
}

const NEWER_TEXT: &str = r#"{"version":7,"a":1,"b":2,"future":{"k":[1,2]}}"#;

/// 讀不到時的共同斷言：回預設與 Unreadable；存檔、更新都回錯；放開後原內容一字不差、重讀回到正常、extra 與版本還在
fn 暫時讀不到時的斷言(dir: &Path, release: impl FnOnce()) {
    let l = load_in::<TA>(dir);
    assert!(matches!(l.status, LoadStatus::Unreadable { .. }), "{:?}", l.status);
    assert_eq!(l.value, TA::default());
    let e = update_in::<TA, _>(dir, |t| t.a = 99).unwrap_err();
    assert!(e.0.contains("暫時讀不到"), "{e}");
    assert!(save_in::<TA>(dir, &TA::default()).is_err());
    // 不快取：還是讀不到時每次都是 Unreadable
    assert!(matches!(load_in::<TA>(dir).status, LoadStatus::Unreadable { .. }));
    release();
    assert_eq!(std::fs::read_to_string(dir.join("t-a.json")).unwrap(), NEWER_TEXT, "原檔要一字不差");
    assert!(names(dir, "t-a.json.").is_empty(), "不該有 .bad 或 .tmp");
    let l = load_in::<TA>(dir);
    assert_eq!(l.status, LoadStatus::Newer { file_version: 7 });
    assert_eq!(l.value.a, 1);
    update_in::<TA, _>(dir, |t| t.a = 5).unwrap();
    let v = disk(dir, "t-a.json");
    assert_eq!((v["version"].as_u64(), v["future"].clone(), v["a"].as_i64()), (Some(7), json!({"k":[1,2]}), Some(5)));
}

#[cfg(windows)]
#[test]
fn 讀的時候檔案被占用_存檔不覆蓋原檔_windows() {
    use std::os::windows::fs::OpenOptionsExt;
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", NEWER_TEXT);
    let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(d.path().join("t-a.json")).unwrap();
    let mut held = Some(held);
    暫時讀不到時的斷言(d.path(), || drop(held.take()));
}

#[cfg(unix)]
#[test]
fn 讀的時候沒有權限_存檔不覆蓋原檔_unix() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", NEWER_TEXT);
    let p = d.path().join("t-a.json");
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_to_string(&p).is_ok() {
        // 用 root 跑時權限擋不住，這支測不到，略過
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        return;
    }
    暫時讀不到時的斷言(d.path(), || std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap());
}

struct Inject;
impl Inject {
    fn rename() -> Self {
        migrate::FAIL_RENAME.with(|f| f.set(true));
        Inject
    }
}
impl Drop for Inject {
    fn drop(&mut self) {
        migrate::FAIL_RENAME.with(|f| f.set(false));
        migrate::FAIL_COPY.with(|f| f.set(false));
    }
}

#[test]
fn 改名失敗改用複製備份_副本內容等於原壞檔() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", "{壞掉的內容");
    let _g = Inject::rename();
    let l = load_in::<TA>(d.path());
    assert_eq!(l.status, LoadStatus::Recovered);
    let bad = names(d.path(), "t-a.json.bad-");
    assert_eq!(bad.len(), 1);
    assert_eq!(std::fs::read_to_string(d.path().join(&bad[0])).unwrap(), "{壞掉的內容");
    // 副本在，之後存檔才可以寫
    update_in::<TA, _>(d.path(), |t| t.a = 3).unwrap();
    assert_eq!(std::fs::read_to_string(d.path().join(&bad[0])).unwrap(), "{壞掉的內容");
    assert_eq!(disk(d.path(), "t-a.json")["a"], 3);
}

#[test]
fn 改名與複製都失敗_存檔不准覆蓋原壞檔() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", "{壞掉的內容");
    let _g = Inject::rename();
    migrate::FAIL_COPY.with(|f| f.set(true));
    let l = load_in::<TA>(d.path());
    assert!(matches!(l.status, LoadStatus::Unreadable { .. }), "{:?}", l.status);
    assert!(update_in::<TA, _>(d.path(), |t| t.a = 3).is_err());
    assert!(save_in::<TA>(d.path(), &TA::default()).is_err());
    assert_eq!(std::fs::read_to_string(d.path().join("t-a.json")).unwrap(), "{壞掉的內容");
    assert!(names(d.path(), "t-a.json.bad-").is_empty(), "失敗時不留半份副本");
}

/// 真的讓改名失敗：另一個控制代碼以「只准讀、不准改名刪除」開著，改名會被拒，但複製讀得到
#[cfg(windows)]
#[test]
fn 真的改名失敗時副本存在_windows() {
    use std::os::windows::fs::OpenOptionsExt;
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", "{壞掉的內容");
    let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(d.path().join("t-a.json")).unwrap();
    let l = load_in::<TA>(d.path());
    assert_eq!(l.status, LoadStatus::Recovered);
    let bad = names(d.path(), "t-a.json.bad-");
    assert_eq!(bad.len(), 1);
    assert_eq!(std::fs::read_to_string(d.path().join(&bad[0])).unwrap(), "{壞掉的內容");
    drop(held);
}

#[test]
fn 時鐘倒退時剛建的副本不會被刪() {
    let d = tempfile::tempdir().unwrap();
    // 先放五份「未來」時間的舊副本，剛建的那份檔名會排在它們前面
    for i in 0..5 {
        put(d.path(), &format!("t-a.json.bad-9{:014}-{:06}", i, 0), "舊");
    }
    put(d.path(), "t-a.json", "{壞掉的內容");
    assert_eq!(load_in::<TA>(d.path()).status, LoadStatus::Recovered);
    let bad = names(d.path(), "t-a.json.bad-");
    assert_eq!(bad.len(), 3);
    let fresh: Vec<_> = bad.iter().filter(|n| std::fs::read_to_string(d.path().join(n)).unwrap() == "{壞掉的內容").collect();
    assert_eq!(fresh.len(), 1, "剛建的那份必須還在：{bad:?}");
}

#[test]
fn update_每次都重讀檔_外部改了同樣大小的內容也不會被蓋掉() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", r#"{"version":1,"a":1,"b":2}"#);
    assert_eq!(load_in::<TA>(d.path()).value.b, 2);
    // 外部改成同樣長度（快取比對大小與時間可能認不出來）
    std::fs::write(d.path().join("t-a.json"), r#"{"version":1,"a":1,"b":7}"#).unwrap();
    update_in::<TA, _>(d.path(), |t| t.a = 5).unwrap();
    let v = disk(d.path(), "t-a.json");
    assert_eq!((v["a"].as_i64(), v["b"].as_i64()), (Some(5), Some(7)));
}

impl Inject {
    fn copy() -> Self {
        migrate::FAIL_COPY.with(|f| f.set(true));
        Inject
    }
}

#[test]
fn 升版前備份失敗_存檔回錯_原檔一字不差() {
    let d = tempfile::tempdir().unwrap();
    let old = r#"{"a":3,"b":4,"舊欄位":1}"#;
    put(d.path(), "t-a.json", old);
    let _g = Inject::copy();
    let e = update_in::<TA, _>(d.path(), |t| t.a = 9).unwrap_err();
    assert!(e.0.contains("備份存不下來"), "{e}");
    assert!(save_in::<TA>(d.path(), &TA::default()).is_err());
    assert_eq!(std::fs::read_to_string(d.path().join("t-a.json")).unwrap(), old);
    assert!(names(d.path(), "t-a.json.").is_empty());
}

#[test]
fn 讀到較新版本_第一次存檔前備份_第二次不重建() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", NEWER_TEXT);
    update_in::<TA, _>(d.path(), |t| t.a = 50).unwrap();
    let bak = d.path().join("t-a.json.v7.bak");
    assert_eq!(std::fs::read_to_string(&bak).unwrap(), NEWER_TEXT, "備份內容等於原檔");
    let stamp = std::fs::metadata(&bak).unwrap().modified().unwrap();
    update_in::<TA, _>(d.path(), |t| t.a = 51).unwrap();
    assert_eq!(std::fs::read_to_string(&bak).unwrap(), NEWER_TEXT, "第二次不能重建或覆蓋");
    assert_eq!(std::fs::metadata(&bak).unwrap().modified().unwrap(), stamp);
    assert_eq!(disk(d.path(), "t-a.json")["a"], 51);
}

#[test]
fn 較新版本的檔備份失敗_存檔回錯() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", NEWER_TEXT);
    let _g = Inject::copy();
    assert!(update_in::<TA, _>(d.path(), |t| t.a = 50).is_err());
    assert_eq!(std::fs::read_to_string(d.path().join("t-a.json")).unwrap(), NEWER_TEXT);
}

#[test]
fn 帶_bom_的合法_json_讀得出值_不搬成壞檔() {
    let d = tempfile::tempdir().unwrap();
    put(d.path(), "t-a.json", "\u{feff}{\"version\":1,\"a\":8}");
    let l = load_in::<TA>(d.path());
    assert_eq!(l.status, LoadStatus::Ok);
    assert_eq!(l.value.a, 8);
    assert!(names(d.path(), "t-a.json.bad-").is_empty());
    assert!(d.path().join("t-a.json").is_file());
}

#[test]
fn 非物件與空檔照舊搬成壞檔() {
    let d = tempfile::tempdir().unwrap();
    for txt in ["[1]", "5", ""] {
        put(d.path(), "t-a.json", txt);
        assert_eq!(load_in::<TA>(d.path()).status, LoadStatus::Recovered, "{txt:?}");
        assert!(!d.path().join("t-a.json").exists());
    }
}
