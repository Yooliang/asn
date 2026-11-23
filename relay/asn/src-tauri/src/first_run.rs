//! 新裝電腦的預設值（#1617）：只在「全新安裝的第一次啟動」套用兩項，之後、以及舊電腦一律不動。
//! - bridge.json 的 allow_remote_launch＝true（允許自己的其他設備替這台開新視窗）
//! - launch-prefs.json 的 cwdAllow 加入「文件」資料夾（資料夾存在才加）
//!
//! 怎麼認「全新」：資料資料夾（data_dir）、工作資料夾（work_dir）與家目錄的 ASN 資料夾（~/.asn）都不存在或是空的。
//! 多看 ~/.asn：沒有節點時 work_dir 是空的，舊電腦的 ~/.asn 仍有東西，不能因此被當成新裝。
//! 只看「有沒有東西」，不開、不讀任何檔案（除了我們自己的標記檔）。
//! 決定一次就寫標記檔 `first-run-defaults.json`：先寫標記、再套預設，之後每次啟動看標記就好，
//! 所以使用者之後把開關關掉、或把白名單改掉，都不會被再套一次。
//! 只有一個 ui.log 也算舊電腦（保守：寧可不套，也不要動到舊電腦的設定）。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const MARKER: &str = "first-run-defaults.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Fresh,
    Existing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 標記檔早就寫過：照它的決定，不再套用
    AlreadyDecided(Kind),
    /// 沒有標記、兩個資料夾都沒東西：新裝
    Fresh,
    /// 沒有標記但已有東西，或標記壞掉／看不懂：當舊電腦（不套用）
    Existing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Whitelist {
    Added,
    /// 找不到「文件」資料夾，白名單沒加
    NoDocuments,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 之前已經決定過，這次什麼都沒做
    AlreadyDecided(Kind),
    /// 舊電腦：只寫了標記
    Existing,
    /// 新裝：標記已寫、預設已套（開關結果、白名單結果）
    Fresh { switch: Result<(), String>, whitelist: Whitelist },
    /// 新裝但標記寫不進去：為了不重複套用，什麼預設都沒套
    MarkerFailed(String),
}

/// 資料夾裡有沒有任何東西（檔案或子資料夾）。不存在或空的是 false；
/// 讀不到而且不是「不存在」的原因（權限等），保守當作有東西。
pub fn dir_has_entries(p: &Path) -> bool {
    match std::fs::read_dir(p) {
        Ok(mut it) => it.next().is_some(),
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// None＝沒有標記檔；Some(None)＝有但讀不了／壞掉／看不懂
fn read_marker(data_dir: &Path) -> Option<Option<Kind>> {
    let path = data_dir.join(MARKER);
    if !path.exists() {
        return None;
    }
    let kind = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| match v.get("kind").and_then(Value::as_str) {
        Some("fresh") => Some(Kind::Fresh),
        Some("existing") => Some(Kind::Existing),
        _ => None,
    });
    Some(kind)
}

pub fn decide(data_dir: &Path, others: &[&Path]) -> Decision {
    match read_marker(data_dir) {
        Some(Some(k)) => return Decision::AlreadyDecided(k),
        Some(None) => return Decision::Existing, // 標記壞了：保守，當舊電腦
        None => {}
    }
    if !dir_has_entries(data_dir) && others.iter().all(|w| !dir_has_entries(w)) {
        Decision::Fresh
    } else {
        Decision::Existing
    }
}

fn write_marker(data_dir: &Path, body: &Value) -> Result<(), String> {
    crate::write_atomic(&data_dir.join(MARKER), &body.to_string()).map_err(|e| e.to_string())
}

/// 啟動時呼叫一次（要在任何東西寫進 data_dir／work_dir 之前）。
/// `documents`：「文件」資料夾（沒有就 None）；`now_ms`：現在的毫秒時間，只用來記在標記裡。
pub fn run_at_startup(data_dir: &Path, others: &[&Path], documents: Option<PathBuf>, now_ms: i64) -> Outcome {
    let at = crate::quota_core::iso_secs(now_ms);
    match decide(data_dir, others) {
        Decision::AlreadyDecided(k) => Outcome::AlreadyDecided(k),
        Decision::Existing => {
            let _ = write_marker(data_dir, &json!({ "kind": "existing", "at": at }));
            Outcome::Existing
        }
        Decision::Fresh => {
            // 先寫標記：之後就算套用到一半當掉，下次也不會再套
            let marker = json!({ "kind": "fresh", "at": at, "applied": { "allow_remote_launch": true, "cwd_allow_documents": documents.is_some() } });
            if let Err(e) = write_marker(data_dir, &marker) {
                return Outcome::MarkerFailed(e);
            }
            let switch = {
                crate::bridge::update_settings(data_dir, |s| s.allow_remote_launch = true)
            };
            let whitelist = match documents {
                None => Whitelist::NoDocuments,
                Some(d) => {
                    // 存法跟使用者自己加的一樣：先取正規路徑，再交給 add_to_prefs_allow（去重、去掉 \\?\）
                    let canon = crate::launch::config::canonical_launch_cwd(&d.to_string_lossy());
                    match canon.and_then(|c| crate::launch::cwds::add_to_prefs_allow(data_dir, &c.to_string_lossy())) {
                        Ok(()) => Whitelist::Added,
                        Err(e) => Whitelist::Failed(e),
                    }
                }
            };
            Outcome::Fresh { switch, whitelist }
        }
    }
}

/// 寫進 ui.log 的一行（只有這次真的做了決定才有；以前就決定過的回 None）
pub fn log_line(o: &Outcome) -> Option<String> {
    Some(match o {
        Outcome::AlreadyDecided(_) => return None,
        Outcome::Existing => "舊電腦，不套用新裝預設".into(),
        Outcome::Fresh { switch, whitelist } => match (switch, whitelist) {
            (Ok(()), Whitelist::Added) => "新裝預設已套用（允許其他設備開新視窗、白名單加入文件資料夾）".into(),
            (Ok(()), Whitelist::NoDocuments) => "新裝預設已套用（允許其他設備開新視窗；文件資料夾不存在，白名單沒加）".into(),
            (Ok(()), Whitelist::Failed(e)) => format!("新裝預設已套用（允許其他設備開新視窗；白名單沒加成功：{e}）"),
            (Err(e), _) => format!("新裝預設沒套成功：{e}"),
        },
        Outcome::MarkerFailed(e) => format!("新裝預設沒套用（記號寫不進去：{e}）"),
    })
}

/// 「文件」資料夾：Windows 問系統（使用者可能搬到別的磁碟或雲端同步資料夾）；問不到或其他系統用家目錄下的 Documents。只回真的存在的資料夾
pub fn documents_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(p) = known_documents().filter(|p| p.is_dir()) {
        return Some(p);
    }
    Some(crate::identity::home_dir().join("Documents")).filter(|p| p.is_dir())
}

#[cfg(windows)]
fn known_documents() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Documents, SHGetKnownFolderPath};
    let mut pw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: 成功時 pw 指向系統配置的、以 0 結尾的寬字串，讀完用 CoTaskMemFree 釋放；失敗時指標可能是 null，CoTaskMemFree 接受 null
    unsafe {
        let hr = SHGetKnownFolderPath(&FOLDERID_Documents, 0, std::ptr::null_mut(), &mut pw);
        let out = if hr >= 0 && !pw.is_null() {
            let mut n = 0usize;
            while *pw.add(n) != 0 {
                n += 1;
            }
            Some(PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(pw, n))))
        } else {
            None
        };
        CoTaskMemFree(pw as *const core::ffi::c_void);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NOW: i64 = 1_800_000_000_000;

    fn docs(root: &Path) -> PathBuf {
        let d = root.join("Documents");
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn marker_kind(data: &Path) -> String {
        let v: Value = serde_json::from_str(&fs::read_to_string(data.join(MARKER)).unwrap()).unwrap();
        v["kind"].as_str().unwrap().to_string()
    }
    fn allow_of(data: &Path) -> Vec<String> {
        let v = crate::launch::prefs::launch_prefs_get_sync(data).unwrap();
        v["cwdAllow"].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect()).unwrap_or_default()
    }
    fn expected_doc(d: &Path) -> String {
        let c = crate::launch::config::canonical_launch_cwd(&d.to_string_lossy()).unwrap();
        crate::launch::cwds::norm_path(&c.to_string_lossy()).unwrap()
    }

    #[test]
    fn 新裝_兩個資料夾都不存在_開關與白名單都套() {
        let t = tempfile::tempdir().unwrap();
        let (data, work, d) = (t.path().join("data"), t.path().join("work"), docs(t.path()));
        let o = run_at_startup(&data, &[&work], Some(d.clone()), NOW);
        assert_eq!(o, Outcome::Fresh { switch: Ok(()), whitelist: Whitelist::Added });
        assert!(crate::bridge::read_settings(&data).allow_remote_launch);
        assert_eq!(allow_of(&data), vec![expected_doc(&d)]);
        assert_eq!(marker_kind(&data), "fresh");
        assert!(!work.exists(), "決定本身不能在 work_dir 留任何東西");
        assert!(log_line(&o).unwrap().contains("新裝預設已套用"));
    }

    #[test]
    fn 新裝_資料夾存在但是空的_還是新裝() {
        let t = tempfile::tempdir().unwrap();
        let (data, work) = (t.path().join("data"), t.path().join("work"));
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&work).unwrap();
        let o = run_at_startup(&data, &[&work], Some(docs(t.path())), NOW);
        assert!(matches!(o, Outcome::Fresh { .. }), "{o:?}");
        assert!(crate::bridge::read_settings(&data).allow_remote_launch);
    }

    #[test]
    fn 舊電腦_開關本來關著_原封不動() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let off = crate::bridge::BridgeSettings { enabled: true, allow_remote_launch: false, ..Default::default() };
        crate::bridge::write_settings(&data, off).unwrap();
        let before = fs::read(data.join("bridge.json")).unwrap();
        let o = run_at_startup(&data, &[], Some(docs(t.path())), NOW);
        assert_eq!(o, Outcome::Existing);
        assert_eq!(fs::read(data.join("bridge.json")).unwrap(), before, "bridge.json 要一個位元組都不變");
        assert!(!data.join("launch-prefs.json").exists());
        assert_eq!(marker_kind(&data), "existing");
    }

    #[test]
    fn 舊電腦_開關本來開著_不變() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir_all(&data).unwrap();
        crate::bridge::write_settings(&data, crate::bridge::BridgeSettings { enabled: true, allow_remote_launch: true, ..Default::default() }).unwrap();
        let before = fs::read(data.join("bridge.json")).unwrap();
        assert_eq!(run_at_startup(&data, &[], Some(docs(t.path())), NOW), Outcome::Existing);
        assert_eq!(fs::read(data.join("bridge.json")).unwrap(), before);
        assert!(!data.join("launch-prefs.json").exists());
    }

    #[test]
    fn 舊電腦_沒有_bridge_json_只有別的檔_也不套用_不建_bridge_json() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("asn-me.json"), "{}").unwrap();
        assert_eq!(run_at_startup(&data, &[], Some(docs(t.path())), NOW), Outcome::Existing);
        assert!(!data.join("bridge.json").exists());
        assert!(!data.join("launch-prefs.json").exists());
        assert_eq!(fs::read_to_string(data.join("asn-me.json")).unwrap(), "{}");
    }

    #[test]
    fn 沒有節點時_家目錄的_asn_資料夾有東西_也算舊電腦() {
        // 沒有節點：work_dir 不傳；data_dir 不存在，但舊電腦的 ~/.asn 還有東西
        let t = tempfile::tempdir().unwrap();
        let (data, home) = (t.path().join("data"), t.path().join("dot-asn"));
        fs::create_dir_all(home.join("machine-abc")).unwrap();
        assert_eq!(decide(&data, &[&home]), Decision::Existing);
        assert_eq!(run_at_startup(&data, &[&home], Some(docs(t.path())), NOW), Outcome::Existing);
        assert!(!data.join("bridge.json").exists());
        // ~/.asn 不存在或是空的：照樣當新裝
        let t2 = tempfile::tempdir().unwrap();
        let (data2, home2) = (t2.path().join("data"), t2.path().join("dot-asn"));
        assert_eq!(decide(&data2, &[&home2]), Decision::Fresh);
        fs::create_dir_all(&home2).unwrap();
        assert_eq!(decide(&data2, &[&home2]), Decision::Fresh);
    }

    #[test]
    fn 只有一個_ui_log_也算舊電腦() {
        let t = tempfile::tempdir().unwrap();
        let (data, work) = (t.path().join("data"), t.path().join("work"));
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join("ui.log"), "x\n").unwrap();
        assert_eq!(decide(&data, &[&work]), Decision::Existing);
        assert_eq!(run_at_startup(&data, &[&work], Some(docs(t.path())), NOW), Outcome::Existing);
        assert!(!data.join("bridge.json").exists());
        assert_eq!(marker_kind(&data), "existing");
    }

    #[test]
    fn 標記已有_fresh_第二次不再套用_使用者關掉的開關維持關() {
        let t = tempfile::tempdir().unwrap();
        let (data, d) = (t.path().join("data"), docs(t.path()));
        assert!(matches!(run_at_startup(&data, &[], Some(d.clone()), NOW), Outcome::Fresh { .. }));
        // 使用者關掉開關、清空白名單
        crate::bridge::write_settings(&data, crate::bridge::BridgeSettings { enabled: true, allow_remote_launch: false, ..Default::default() }).unwrap();
        crate::launch::prefs::launch_prefs_set_sync(&data, json!({ "cwdAllow": [] })).unwrap();
        let o = run_at_startup(&data, &[], Some(d), NOW + 1000);
        assert_eq!(o, Outcome::AlreadyDecided(Kind::Fresh));
        assert!(log_line(&o).is_none());
        assert!(!crate::bridge::read_settings(&data).allow_remote_launch);
        assert!(allow_of(&data).is_empty());
    }

    #[test]
    fn 標記壞掉_當舊電腦_不套用() {
        let t = tempfile::tempdir().unwrap();
        for (i, bad) in ["不是 json{{", "{\"kind\":\"???\"}", "{}", ""].iter().enumerate() {
            let data = t.path().join(format!("data{i}"));
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join(MARKER), bad).unwrap();
            assert_eq!(decide(&data, &[]), Decision::Existing, "{bad:?}");
            assert_eq!(run_at_startup(&data, &[], Some(docs(t.path())), NOW), Outcome::Existing);
            assert!(!data.join("bridge.json").exists(), "{bad:?}");
            assert!(!data.join("launch-prefs.json").exists());
            assert_eq!(marker_kind(&data), "existing", "壞標記改寫成 existing");
        }
    }

    #[test]
    fn 找不到文件資料夾_只套開關_白名單不加() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        let o = run_at_startup(&data, &[], None, NOW);
        assert_eq!(o, Outcome::Fresh { switch: Ok(()), whitelist: Whitelist::NoDocuments });
        assert!(crate::bridge::read_settings(&data).allow_remote_launch);
        assert!(!data.join("launch-prefs.json").exists());
        assert!(log_line(&o).unwrap().contains("文件資料夾不存在，白名單沒加"));
    }

    #[test]
    fn 新裝_其他設定維持預設值() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        run_at_startup(&data, &[], None, NOW);
        let got = crate::bridge::read_settings(&data);
        assert_eq!(got, crate::bridge::BridgeSettings { enabled: true, allow_remote_launch: true, ..Default::default() });
    }

    #[test]
    fn 資料夾有沒有東西_缺少與空的是沒有_有檔或子資料夾是有() {
        let t = tempfile::tempdir().unwrap();
        assert!(!dir_has_entries(&t.path().join("沒有")));
        assert!(!dir_has_entries(t.path()));
        fs::create_dir(t.path().join("sub")).unwrap();
        assert!(dir_has_entries(t.path()));
        assert!(!dir_has_entries(&t.path().join("sub")));
        fs::write(t.path().join("sub").join("f"), "").unwrap();
        assert!(dir_has_entries(&t.path().join("sub")));
    }

    #[test]
    fn 守門_lib_rs_在_datadir_startup_之後_第一個寫入者之前呼叫_first_run() {
        let src = include_str!("lib.rs");
        let code = src.split("\nmod tests {").next().unwrap();
        let run = &code[code.find("pub fn run()").expect("有 run()")..];
        let startup = run.find("datadir::startup(").expect("有 datadir::startup");
        let call = run.find("first_run::run_at_startup(").expect("run() 要呼叫 first_run::run_at_startup");
        assert!(call > startup, "first_run 要在取得 data_dir 之後");
        // 會寫進 data_dir／work_dir 的地方（自帶終端服務、同名檢查、守護心跳、自動接回、橋）都要排在後面
        for later in [concat!("launch::term::", "live("), "heartbeat::other_instance(", "guard::note_start(", "launch::auto_resume::start(", "auth::default_store(", "bridge::Manager::new("] {
            let at = run.find(later).unwrap_or_else(|| panic!("找不到 {later}"));
            assert!(call < at, "first_run 要在 {later} 之前");
        }
        // 取得 data_dir 到呼叫之間不准有別的寫入動作
        let between = &run[startup..call];
        for bad in ["write_atomic", "create_dir_all", "ui_log::append", "fs::write"] {
            assert!(!between.contains(bad), "datadir::startup 與 first_run 之間不能有 {bad}");
        }
        // 截圖模式與 ASN_DATA 覆蓋都不跑
        let before_call = &run[startup..call];
        assert!(before_call.contains("is_shot") || before_call.contains("shot.is_none()"), "截圖模式要跳過");
        assert!(before_call.contains("ASN_DATA"), "有 ASN_DATA 覆蓋（開發／測試用）要跳過");
    }
}
