//! 接手使用者自己在終端機開的 grok：找出那個 grok 程序正在用的對話（session），交給 ASN 的 Grok 工作者載入。
//!
//! 對應關係不用猜：grok 自己把「正在跑的對話」登記在 `~/.grok/active_sessions.json`（陣列，每筆有 session_id、pid、cwd、opened_at），
//! 所以用名單上的程序 pid 直接查。只讀這個登記檔與 `~/.grok/sessions` 的資料夾名稱；絕不讀對話內容、不讀 auth。
//! 不唯一（同一個 pid 對到不同對話）、沒登記、對話資料夾不存在、pid 疑似被重用，一律回中文原因，不接手。
//! 純函式為主，測試用假資料。
use super::acp_config::WorkerCfg;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 找到的那一段對話
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub session_id: String,
    pub cwd: String,
}

/// 名單條目名（「grok #1234（前景）」「grok · 某供應商 #1234（前景）」）→ pid。不是程序條目的名字回 None
pub fn proc_pid(name: &str) -> Option<u32> {
    let n = name.trim();
    if !n.to_lowercase().starts_with("grok") {
        return None;
    }
    let after = n.rsplit_once('#')?.1;
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    let rest = &after[digits.len()..];
    if digits.is_empty() || !(rest.is_empty() || rest.starts_with('（') || rest.starts_with('(')) {
        return None;
    }
    digits.parse::<u32>().ok().filter(|p| *p > 0)
}

fn valid_session_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// "2026-10-24T05:41:12.401307800Z" → Unix 毫秒；格式不對回 None
pub fn parse_utc_ms(s: &str) -> Option<u64> {
    let (date, time) = s.trim().trim_end_matches('Z').split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // 民用曆轉天數（Howard Hinnant 的算法）
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let ms: i64 = frac.chars().take(3).collect::<String>().parse::<i64>().unwrap_or(0) * 10_i64.pow(3 - frac.chars().take(3).count() as u32);
    u64::try_from((days * 86400 + hh * 3600 + mm * 60 + ss) * 1000 + ms).ok()
}

/// 用 pid 在登記檔裡找出唯一的對話。
/// session_exists＝這段對話的資料夾還在 `~/.grok/sessions` 底下；proc_started_ms＝這個 pid 的程序建立時間（查不到＝None）
pub fn resolve(active_json: &str, pid: u32, session_exists: &dyn Fn(&str) -> bool, proc_started_ms: Option<u64>) -> Result<Found, String> {
    let v: Value = serde_json::from_str(active_json.trim_start_matches('\u{feff}')).map_err(|_| "讀不懂 grok 的對話登記檔，無法確定是哪一段對話".to_string())?;
    let list = v.as_array().or_else(|| v.get("sessions").and_then(Value::as_array)).ok_or("grok 的對話登記檔格式和預期不同，無法確定是哪一段對話")?;
    let mine: Vec<&Value> = list.iter().filter(|e| e.get("pid").and_then(Value::as_u64) == Some(pid as u64)).collect();
    if mine.is_empty() {
        return Err("找不到這個 grok 正在用的對話（它沒有登記在 grok 的使用中對話裡，可能剛啟動或版本不同），所以不接手".into());
    }
    let mut ids: Vec<(&str, &str, &str)> = mine
        .iter()
        .map(|e| (e.get("session_id").and_then(Value::as_str).unwrap_or(""), e.get("cwd").and_then(Value::as_str).unwrap_or(""), e.get("opened_at").and_then(Value::as_str).unwrap_or("")))
        .collect();
    ids.sort();
    ids.dedup_by_key(|x| x.0);
    if ids.len() != 1 {
        return Err(format!("這個 grok 同時對得上 {} 段對話，沒辦法確定是哪一段，所以不接手", ids.len()));
    }
    let (sid, cwd, opened) = ids[0];
    if !valid_session_id(sid) {
        return Err("grok 登記的對話編號格式不對，所以不接手".into());
    }
    if cwd.trim().is_empty() {
        return Err("grok 沒有登記這段對話的工作資料夾，所以不接手".into());
    }
    // 登記時間比程序的建立時間還早＝這是前一個用同一個 pid 的程序留下的過期登記
    if let (Some(started), Some(open)) = (proc_started_ms, parse_utc_ms(opened)) {
        if open + 5_000 < started {
            return Err("grok 的對話登記比這個程序還早，是過期的登記（pid 被重用），所以不接手".into());
        }
    }
    if !session_exists(sid) {
        return Err("找不到這段對話的紀錄資料夾（可能已被清掉），所以不接手".into());
    }
    Ok(Found { session_id: sid.to_string(), cwd: cwd.to_string() })
}

/// 家目錄底下的 grok 資料夾
pub fn grok_home_of(home: &Path) -> PathBuf {
    home.join(".grok")
}

/// `<grok_home>/sessions/*/<session_id>` 有沒有這個資料夾（只列目錄名稱，不開任何檔案）
pub fn session_dir_exists(grok_home: &Path, session_id: &str) -> bool {
    if !valid_session_id(session_id) {
        return false;
    }
    let Ok(rd) = std::fs::read_dir(grok_home.join("sessions")) else { return false };
    rd.flatten().any(|d| d.path().join(session_id).is_dir())
}

/// 讀登記檔（只讀這一個檔）
pub fn read_active(grok_home: &Path) -> Result<String, String> {
    std::fs::read_to_string(grok_home.join("active_sessions.json")).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "這台電腦找不到 grok 的使用中對話登記（~/.grok/active_sessions.json），所以不接手".to_string() } else { format!("讀不到 grok 的對話登記：{e}") })
}

/// 專屬工作者的名字：grok-接手-<工作資料夾名>。只留字母數字中文與連字號，最長 40 字；suffix 非空時接在後面（同名但不同對話時用）
pub fn worker_name(cwd: &str, suffix: &str) -> String {
    let folder = cwd.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("");
    let ok = |c: char| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&c);
    let clean: String = folder.chars().map(|c| if ok(c) { c } else { '-' }).collect();
    let clean = clean.trim_matches('-').to_string();
    let clean = if clean.is_empty() { "工作".to_string() } else { clean };
    let tail = if suffix.is_empty() { String::new() } else { format!("-{}", suffix.chars().filter(|c| ok(*c)).take(4).collect::<String>()) };
    let head = "grok-接手-";
    let room = 40usize.saturating_sub(head.chars().count() + tail.chars().count());
    format!("{head}{}{tail}", clean.chars().take(room).collect::<String>().trim_end_matches('-'))
}

/// 以現有的 Grok 工作者設定為底，做出接手專用的設定：同一個指令與登入環境，工作資料夾換成那段對話的資料夾；
/// 寫檔最多「詢問」（工作資料夾可能是使用者的家目錄，不能預設放行），執行指令維持原設定的限制；`adopted`＝載入失敗不准偷偷開新對話
pub fn adopted_cfg(base: &WorkerCfg, name: &str, cwd: &str) -> WorkerCfg {
    use super::acp_policy::Verdict;
    let mut c = base.clone();
    c.name = name.to_string();
    c.cwd = PathBuf::from(cwd);
    c.label = "接手".to_string();
    c.adopted = true;
    c.permissions.allow_dirs = vec![PathBuf::from(cwd)];
    if c.permissions.rule("write") == Verdict::Allow {
        c.permissions.rules.insert("write", Verdict::Ask);
    }
    c
}

/// 接手後第一則提示（接在開場說明後面）
pub fn adopt_prompt(name: &str) -> String {
    format!("你是『{name}』：使用者原本在終端機裡用 grok 進行的這一段對話，現在由 ASN 收發室接手。前面的對話內容都還在，請照原本的脈絡繼續。之後的每一則訊息都是經收發室轉來的信，請先確認寄件人要什麼，再接著做。")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "01a16c6d-6842-71c0-a78d-911586798d88";
    fn active(entries: &[(&str, u32, &str, &str)]) -> String {
        serde_json::to_string(&entries.iter().map(|(s, p, c, o)| serde_json::json!({ "session_id": s, "pid": p, "cwd": c, "opened_at": o })).collect::<Vec<_>>()).unwrap()
    }
    fn yes(_: &str) -> bool {
        true
    }

    #[test]
    fn 名單條目名取出_pid_只認_grok_程序條目() {
        assert_eq!(proc_pid("grok #65324（前景）"), Some(65324));
        assert_eq!(proc_pid("grok · xAI #12（前景）"), Some(12));
        assert_eq!(proc_pid("grok #7"), Some(7));
        assert_eq!(proc_pid("pi #65324（前景）"), None);
        assert_eq!(proc_pid("Grok"), None);
        assert_eq!(proc_pid("grok #0（前景）"), None);
        assert_eq!(proc_pid("grok #12abc（前景）"), None);
        assert_eq!(proc_pid("grok-接手-x"), None);
    }

    #[test]
    fn 唯一對得上_回對話編號與工作資料夾() {
        let j = active(&[(SID, 65324, "C:\\Users\\a", "2026-10-24T05:41:12.401307800Z"), ("01a16c71-c809-7650-898d-fde24188667f", 999, "D:\\x", "2026-10-24T05:41:12Z")]);
        assert_eq!(resolve(&j, 65324, &yes, None).unwrap(), Found { session_id: SID.into(), cwd: "C:\\Users\\a".into() });
    }

    #[test]
    fn 沒登記_不唯一_格式不對_沒資料夾_過期登記_都不接手並說明() {
        let none = active(&[(SID, 1, "C:\\a", "2026-10-24T05:41:12Z")]);
        assert!(resolve(&none, 2, &yes, None).unwrap_err().contains("找不到這個 grok 正在用的對話"));
        let two = active(&[(SID, 5, "C:\\a", "2026-10-24T05:41:12Z"), ("01a16c71-c809-7650-898d-fde24188667f", 5, "C:\\a", "2026-10-24T05:41:13Z")]);
        assert!(resolve(&two, 5, &yes, None).unwrap_err().contains("同時對得上 2 段"));
        let dup = active(&[(SID, 5, "C:\\a", "2026-10-24T05:41:12Z"), (SID, 5, "C:\\a", "2026-10-24T05:41:12Z")]);
        assert!(resolve(&dup, 5, &yes, None).is_ok(), "同一段重複登記不算多段");
        let bad = active(&[("../../etc", 5, "C:\\a", "")]);
        assert!(resolve(&bad, 5, &yes, None).unwrap_err().contains("格式不對"));
        let nocwd = active(&[(SID, 5, " ", "")]);
        assert!(resolve(&nocwd, 5, &yes, None).unwrap_err().contains("工作資料夾"));
        let ok = active(&[(SID, 5, "C:\\a", "2026-10-24T05:41:12Z")]);
        assert!(resolve(&ok, 5, &|_| false, None).unwrap_err().contains("資料夾"));
        assert!(resolve("{壞", 5, &yes, None).unwrap_err().contains("讀不懂"));
        assert!(resolve("{\"x\":1}", 5, &yes, None).unwrap_err().contains("格式和預期不同"));
        // 程序建立時間晚於登記時間（超過 5 秒）＝過期登記；差在 5 秒內或查不到建立時間都放行
        let started = parse_utc_ms("2026-10-24T05:41:12Z").unwrap();
        assert!(resolve(&ok, 5, &yes, Some(started + 60_000)).unwrap_err().contains("過期"));
        assert!(resolve(&ok, 5, &yes, Some(started + 3_000)).is_ok());
        assert!(resolve(&ok, 5, &yes, Some(started - 60_000)).is_ok(), "程序先啟動、之後才開對話是正常的");
    }

    #[test]
    fn 時間解析() {
        assert_eq!(parse_utc_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_utc_ms("2026-10-24T05:41:12.401307800Z"), Some(1_792_820_472_401));
        assert_eq!(parse_utc_ms("2026-10-24T05:41:12.5Z"), Some(1_792_820_472_500));
        assert_eq!(parse_utc_ms("壞"), None);
        assert_eq!(parse_utc_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn 專屬工作者名字_合法_最長四十字_同名時加尾碼() {
        assert_eq!(worker_name("C:\\Users\\cwen0708", ""), "grok-接手-cwen0708");
        assert_eq!(worker_name("D:\\Github\\我的 專案\\", ""), "grok-接手-我的-專案");
        assert_eq!(worker_name("D:\\x\\proj", "01a1-6c"), "grok-接手-proj-01a1");
        assert_eq!(worker_name("C:\\", ""), "grok-接手-C");
        assert_eq!(worker_name("", ""), "grok-接手-工作");
        let long = worker_name(&format!("D:\\{}", "a".repeat(80)), "abcd");
        assert!(long.chars().count() <= 40 && long.ends_with("-abcd"), "{long}");
        let ok = |s: &str| {
            let mut it = s.chars();
            let f = it.next().unwrap();
            (f.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&f)) && it.all(|c| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&c) || c == '-')
        };
        for n in [worker_name("C:\\a b$c", ""), long] {
            assert!(ok(&n), "{n}");
        }
    }

    #[test]
    fn 資料夾存在檢查_只看目錄名_編號格式不對一律否() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("sessions").join("C%3A%5Cx").join(SID)).unwrap();
        assert!(session_dir_exists(d.path(), SID));
        assert!(!session_dir_exists(d.path(), "01a16c71-c809-7650-898d-fde24188667f"));
        assert!(!session_dir_exists(d.path(), "../sessions"));
        assert!(!session_dir_exists(&d.path().join("nope"), SID));
        assert!(read_active(d.path()).unwrap_err().contains("找不到"));
    }
}
