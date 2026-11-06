//! 本人接進收發室的視窗（各家轉接層第 2 步）：使用者自己開的 agy 等視窗，本人在 ASN 畫面按「接進收發室」，
//! ASN 給名字、寫一筆登記到 `~/.asn/self-windows/`。之後：
//! - 那個視窗裡跑 asn-cli，父行程鏈上某一層的 pid **和程序建立時間** 都對上登記，才用這個名字寄信、收信；
//! - 收發室把它列成名單上「只能自己收信」的視窗：寄給它的信留在後台信箱，不推進去、不退回。
//!
//! 這個資料夾跟 ~/.claude/sessions 一樣，同一個使用者的程序都寫得到；ASN 只在本人按下時寫。
//! 認名字靠的是三件事都要對上：名字是本人在 ASN 上定的（ASN 預設、本人可改，不能和名單上活著的視窗或夥伴紀錄撞名，呼叫端核對）、
//! pid、程序建立時間。程序結束、或 pid 被別的程序用走（建立時間對不上），這筆登記就不算，給它的信回到一般流程。
// 無視窗的橋（沒有 gui）只用到讀登記的部分，登記與預設名字給畫面用
#![cfg_attr(not(feature = "gui"), allow(dead_code))]
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 登記資料夾（在 ~/.asn 底下）
pub const DIR: &str = "self-windows";
/// 名單上的種類：可收信，但只能自己拉（後台收任意小寫種類）
pub const KIND: &str = "selfpull";
/// 能接進來的引擎（程序掃描的引擎名）。目前只有 agy（掃描名 gemini）
pub const ENGINES: [&str; 1] = ["gemini"];

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    /// 程序掃描的引擎名（例如 "gemini"）
    pub engine: String,
    pub pid: u32,
    /// 登記當下查到的程序建立時間（毫秒）
    pub started_ms: u64,
    /// 登記時間（毫秒）
    pub at: u64,
}

impl Entry {
    fn to_json(&self) -> Value {
        json!({ "v": 1, "name": self.name, "engine": self.engine, "pid": self.pid, "started_ms": self.started_ms, "at": self.at })
    }
    fn from_json(v: &Value) -> Option<Entry> {
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return None;
        }
        let name = v.get("name")?.as_str()?.to_string();
        let engine = v.get("engine")?.as_str()?.to_string();
        let pid = u32::try_from(v.get("pid")?.as_u64()?).ok()?;
        let started_ms = v.get("started_ms")?.as_u64()?;
        let at = v.get("at").and_then(Value::as_u64).unwrap_or(0);
        if pid == 0 || started_ms == 0 || !crate::valid_window_name(&name) || !ENGINES.contains(&engine.as_str()) {
            return None;
        }
        Some(Entry { name, engine, pid, started_ms, at })
    }
    /// 登記的程序就是現在這個 pid 的程序：兩個建立時間都要查得到、而且對上（容許的誤差和名單一樣）
    pub fn is_current(&self, started_now: Option<u64>) -> bool {
        match started_now {
            Some(now) => now.abs_diff(self.started_ms) <= crate::bridge::roster::SAME_PROC_TOLERANCE_MS,
            None => false, // 查不到建立時間＝不能確定是同一個程序：不算（這份登記本來就是靠建立時間成立的）
        }
    }
}

pub fn dir_in(relay_home: &Path) -> PathBuf {
    relay_home.join(DIR)
}

fn file_of(dir: &Path, pid: u32, started_ms: u64) -> PathBuf {
    dir.join(format!("{pid}-{started_ms}.json"))
}

/// 讀出全部登記（壞的檔略過）。不過濾程序是否還在，見 [`live`]
pub fn read_all(dir: &Path) -> Vec<Entry> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Entry> = rd
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter_map(|v| Entry::from_json(&v))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 還有效的登記：程序還在、建立時間對得上。started(pid)＝程序建立時間（查不到＝None）
pub fn live(dir: &Path, started: &dyn Fn(u32) -> Option<u64>) -> Vec<Entry> {
    read_all(dir).into_iter().filter(|e| e.is_current(started(e.pid))).collect()
}

/// 父行程鏈上這一層（pid）是不是某一筆有效登記
pub fn find_pid(dir: &Path, pid: u32, started: &dyn Fn(u32) -> Option<u64>) -> Option<Entry> {
    let now = started(pid);
    read_all(dir).into_iter().find(|e| e.pid == pid && e.is_current(now))
}

/// 為什麼不能用這個名字（空＝可以）。taken＝名單上活著的視窗、夥伴紀錄的名字（呼叫端給）；登記裡別的程序的名字也算
pub fn name_problem(dir: &Path, name: &str, pid: u32, taken: &[String], started: &dyn Fn(u32) -> Option<u64>) -> Option<String> {
    if !crate::valid_window_name(name) {
        return Some("名字不能是空的、前後不能有空白，最多 60 個字".into());
    }
    if taken.iter().any(|t| t == name) {
        return Some(format!("名單上已經有「{name}」，換一個名字"));
    }
    if live(dir, started).iter().any(|e| e.name == name && e.pid != pid) {
        return Some(format!("「{name}」已經接給另一個視窗了，換一個名字"));
    }
    None
}

/// 預設名字：agy-1、agy-2…，跳過已被用掉的
pub fn default_name(dir: &Path, taken: &[String], started: &dyn Fn(u32) -> Option<u64>) -> String {
    let used: Vec<String> = live(dir, started).into_iter().map(|e| e.name).chain(taken.iter().cloned()).collect();
    (1..).map(|n| format!("agy-{n}")).find(|n| !used.contains(n)).unwrap_or_else(|| "agy".into())
}

/// 寫一筆登記（同一個程序再接一次＝改名：舊的那筆換掉）。呼叫端先核對程序與名字
pub fn write(dir: &Path, e: &Entry) -> Result<(), String> {
    for old in read_all(dir).into_iter().filter(|o| o.pid == e.pid) {
        let _ = std::fs::remove_file(file_of(dir, old.pid, old.started_ms));
    }
    crate::write_atomic(&file_of(dir, e.pid, e.started_ms), &e.to_json().to_string()).map_err(|err| format!("寫不進登記：{err}"))
}

/// 拿掉一筆（本人「不接了」或程序已結束時清理）
pub fn remove(dir: &Path, pid: u32, started_ms: u64) {
    let _ = std::fs::remove_file(file_of(dir, pid, started_ms));
}

/// 清掉已經失效的登記（程序結束、或 pid 被別的程序用走）。ASN 啟動時跑一次；回清掉幾筆。
/// 只刪這個資料夾裡、ASN 自己認得格式的登記檔（檔名就是 pid-建立時間）
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub fn prune(dir: &Path, started: &dyn Fn(u32) -> Option<u64>) -> usize {
    let stale: Vec<Entry> = read_all(dir).into_iter().filter(|e| !e.is_current(started(e.pid))).collect();
    for e in &stale {
        remove(dir, e.pid, e.started_ms);
    }
    stale.len()
}

/// 本機活著的 Claude 視窗名（撞名檢查用；pi 視窗與夥伴紀錄的名字由畫面一起給）
#[cfg(desktop)]
fn live_claude_names() -> Vec<String> {
    let Some(dir) = crate::launch::console::sessions_dir() else { return Vec::new() };
    crate::bridge::roster::read_sessions(&dir, crate::heartbeat::pid_alive, 0, "").unwrap_or_default().into_iter().map(|w| w.name).collect()
}

/// 這個 pid 是不是這台電腦上、使用者自己在前景開的 agy（程序掃描看得到的那一列）
#[cfg(desktop)]
fn is_local_foreground_agy(pid: u32) -> bool {
    crate::bridge::procscan::scan_system().into_iter().any(|a| a.pid == pid && ENGINES.contains(&a.engine.as_str()) && !a.background)
}

/// 畫面「接進收發室」對話框的預設名字。taken＝畫面名單上這台電腦的名字（視窗、pi、夥伴紀錄）
#[cfg(desktop)]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn self_window_default(taken: Vec<String>) -> Result<String, String> {
    crate::launch::blocking_timeout(move || {
        let all: Vec<String> = taken.into_iter().chain(live_claude_names()).collect();
        Ok(default_name(&dir_in(&crate::identity::relay_home()), &all, &crate::heartbeat::process_started_ms))
    })
    .await
}

/// 本人按「接進收發室」：核對這個 pid 是這台的前景 agy、查得到建立時間、名字合法且不撞名，才寫登記。
/// 回 { name }；不過就回原因（給人看的一句話）
#[cfg(desktop)]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn self_window_register(pid: u32, name: String, taken: Vec<String>) -> Result<Value, String> {
    crate::launch::blocking_timeout(move || {
        let name = name.trim().to_string();
        if !is_local_foreground_agy(pid) {
            return Err("找不到這個 agy 視窗（可能已經關了，或不是這台電腦上開的）".to_string());
        }
        let Some(started_ms) = crate::heartbeat::process_started_ms(pid) else {
            return Err("查不到這個視窗的程序資訊，無法接進收發室".to_string());
        };
        let dir = dir_in(&crate::identity::relay_home());
        let all: Vec<String> = taken.into_iter().chain(live_claude_names()).collect();
        if let Some(why) = name_problem(&dir, &name, pid, &all, &crate::heartbeat::process_started_ms) {
            return Err(why);
        }
        let at = crate::heartbeat::now_ms();
        write(&dir, &Entry { name: name.clone(), engine: "gemini".into(), pid, started_ms, at })?;
        elog!("接進收發室：pid {pid} → {name}");
        Ok(json!({ "name": name }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_762_400_000_000;

    fn entry(name: &str, pid: u32) -> Entry {
        Entry { name: name.into(), engine: "gemini".into(), pid, started_ms: T0, at: T0 + 1 }
    }

    #[test]
    fn 寫進去讀得回來_同一個程序再接一次就是改名() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), &entry("agy-1", 40)).unwrap();
        assert_eq!(read_all(d.path()), vec![entry("agy-1", 40)]);
        write(d.path(), &entry("我的agy", 40)).unwrap();
        assert_eq!(read_all(d.path()).iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["我的agy"], "舊名字那筆換掉");
    }

    #[test]
    fn 程序結束或_pid_被別的程序用走_登記就不算() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), &entry("agy-1", 40)).unwrap();
        let same = |p: u32| (p == 40).then_some(T0 + 500);
        let reused = |p: u32| (p == 40).then_some(T0 + 3_600_000);
        let gone = |_: u32| None;
        assert_eq!(find_pid(d.path(), 40, &same).map(|e| e.name), Some("agy-1".into()));
        assert!(find_pid(d.path(), 40, &reused).is_none(), "建立時間對不上：別的程序");
        assert!(find_pid(d.path(), 40, &gone).is_none(), "查不到建立時間：不算");
        assert!(find_pid(d.path(), 41, &same).is_none(), "別的 pid");
        assert_eq!(live(d.path(), &same).len(), 1);
        assert!(live(d.path(), &reused).is_empty());
    }

    #[test]
    fn 啟動時清掉失效的登記_還有效的留著() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), &entry("agy-1", 40)).unwrap();
        write(d.path(), &entry("agy-2", 41)).unwrap();
        let only_40 = |p: u32| (p == 40).then_some(T0 + 100);
        assert_eq!(prune(d.path(), &only_40), 1);
        assert_eq!(read_all(d.path()).iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["agy-1"]);
        assert_eq!(prune(d.path(), &only_40), 0, "再跑一次沒有可清的");
    }

    #[test]
    fn 壞的檔和不認得的引擎略過() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("x.json"), "{壞掉").unwrap();
        std::fs::write(d.path().join("y.json"), json!({"v": 1, "name": "c", "engine": "claude", "pid": 5, "started_ms": T0}).to_string()).unwrap();
        std::fs::write(d.path().join("z.json"), json!({"v": 1, "name": " 前面空白", "engine": "gemini", "pid": 6, "started_ms": T0}).to_string()).unwrap();
        assert!(read_all(d.path()).is_empty());
    }

    #[test]
    fn 名字撞名就不給過_預設名字跳過用掉的() {
        let d = tempfile::tempdir().unwrap();
        let alive = |p: u32| (p == 40 || p == 41).then_some(T0);
        write(d.path(), &entry("agy-1", 40)).unwrap();
        let taken = vec!["asn真".to_string(), "agy-2".to_string()];
        assert!(name_problem(d.path(), "asn真", 41, &taken, &alive).unwrap().contains("名單上已經有"));
        assert!(name_problem(d.path(), "agy-1", 41, &taken, &alive).unwrap().contains("另一個視窗"));
        assert_eq!(name_problem(d.path(), "agy-1", 40, &taken, &alive), None, "同一個程序重接用原名可以");
        assert!(name_problem(d.path(), "", 41, &taken, &alive).is_some());
        assert_eq!(name_problem(d.path(), "agy-3", 41, &taken, &alive), None);
        assert_eq!(default_name(d.path(), &taken, &alive), "agy-3");
    }
}
