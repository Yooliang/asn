//! 接手使用者自己開的 pi（#240 方案 B）：找出那個 pi 正在用的對話，好讓 ASN 用擴充重開同一段對話。
//!
//! pi 沒有「哪個程序在用哪段對話」的登記檔（實測 pi 1.4.0：`~/.pi` 底下沒有 lock／active／pid 檔；對話檔是寫一次就關檔、
//! 閒置時用不共享模式也開得起來，所以不能像 Codex 那樣用鎖判斷），所以只能推論。條件寫死，**不唯一就拒絕**：
//!   1. 命令列有 `--session <路徑或部分編號>`（實測：給完整路徑或前 8 碼都會載入同一個檔）→ 直接用，最可靠。
//!   2. 否則：該程序的工作資料夾（`Os::cwd`）＝對話檔檔頭的 `cwd`，而且對話檔的修改時間晚於程序啟動，剛好一個才採用；
//!      同一個資料夾還有別的 pi 在跑也拒絕。`-c`／`--continue`／`--fork` 不特別處理：它們寫的檔照樣符合第 2 條。
//! **盲區（外面分不出來，一律拒絕並請使用者先講一句話）**：pi 開著、但啟動後還沒有任何一輪對話——
//! 對話檔要等第一輪助理回覆完才會建立，接續舊對話但還沒講話時，舊檔的修改時間早於程序啟動。
//!
//! 隱私：只讀對話檔的「第一行」（id、cwd，最多 8KB），絕不讀對話內容、不讀 auth。檔案只限 pi 的 sessions 資料夾底下。
//! 純函式為主，檔案存取靠傳進來的清單與讀檔函式，測試用假資料。
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 名單條目名（「pi #1234（前景）」「pi · MiniMax #1234（前景）」）→ pid。不是程序條目的名字回 None
pub fn proc_pid(name: &str) -> Option<u32> {
    let n = name.trim();
    let lower = n.to_lowercase();
    let rest = lower.strip_prefix("pi")?;
    // 「pi」後面要是分隔（空白、#、·），不是別的字（pico、pip…）
    if !rest.starts_with(|c: char| c.is_whitespace() || c == '#' || c == '·') {
        return None;
    }
    let after = n.rsplit_once('#')?.1;
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    let tail = &after[digits.len()..];
    if digits.is_empty() || !(tail.is_empty() || tail.starts_with('（') || tail.starts_with('(')) {
        return None;
    }
    digits.parse::<u32>().ok().filter(|p| *p > 0)
}

/// pi 的對話資料夾：`<設定資料夾>/sessions`
pub fn sessions_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("sessions")
}

/// sessions 底下的一個對話檔（只有檔名與修改時間，沒有讀內容）
#[derive(Debug, Clone, PartialEq)]
pub struct SessionFile {
    pub path: PathBuf,
    /// 檔名 `<時間>_<編號>.jsonl` 裡的編號
    pub file_id: String,
    pub mtime_ms: u64,
}

/// 檔頭（第一行）：只取 id 與 cwd
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub id: String,
    pub cwd: String,
}

fn valid_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 列 sessions 底下（一層資料夾）所有 `.jsonl`；資料夾不存在＝空。最多列 20000 個，免得資料夾異常大時卡住
pub fn list_session_files(dir: &Path) -> Vec<SessionFile> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for sub in rd.flatten() {
        if !sub.path().is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(sub.path()) else { continue };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".jsonl") else { continue };
            let Some((_, id)) = stem.rsplit_once('_') else { continue };
            if !valid_id(id) {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let mtime_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            out.push(SessionFile { path: f.path(), file_id: id.to_string(), mtime_ms });
            if out.len() >= 20_000 {
                return out;
            }
        }
    }
    out
}

/// 讀對話檔的第一行（最多 8KB）：`{"type":"session","id":…,"cwd":…}`。壞檔、不是 session、id 不合法、沒有換行都回 None
pub fn read_header(path: &Path) -> Option<Header> {
    let mut buf = vec![0u8; 8192];
    let n = std::fs::File::open(path).ok()?.read(&mut buf).ok()?;
    let line = &buf[..n];
    let end = line.iter().position(|b| *b == b'\n')?;
    let v: Value = serde_json::from_slice(&line[..end]).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let id = v.get("id").and_then(Value::as_str).filter(|s| valid_id(s))?.to_string();
    let cwd = v.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 1024)?.to_string();
    Some(Header { id, cwd })
}

/// 命令列裡的 `--session <值>` 或 `--session=<值>`（最後一個算數）。沒有、或 `--session` 後面沒給值回 None
pub fn session_arg(args: &[String]) -> Option<String> {
    let mut found = None;
    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        if a == "--session" {
            if let Some(v) = args.get(i + 1) {
                found = Some(v.clone());
            }
            i += 2;
            continue;
        }
        if let Some(v) = a.strip_prefix("--session=") {
            found = Some(v.to_string());
        }
        i += 1;
    }
    found.filter(|v| !v.is_empty())
}

/// 比較用的路徑：去 verbatim 前綴與尾端斜線、反斜線換斜線、轉小寫（Windows 路徑不分大小寫）
fn norm(p: &str) -> String {
    crate::launch::switch::normalize_cwd(p).replace('\\', "/").to_lowercase()
}

/// 找到的那一段對話
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub path: PathBuf,
    pub session_id: String,
    /// 對話檔檔頭記的工作資料夾（重開時就用這個資料夾）
    pub cwd: String,
    pub via: Via,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// 命令列的 --session
    Arg,
    /// 工作資料夾＋檔頭 cwd＋修改時間晚於啟動
    Cwd,
}

/// 已知的事實（呼叫端從程序表與作業系統取得）
pub struct Facts<'a> {
    /// 那個 pi 程序的完整命令列（含程式本身）；讀不到給空
    pub args: &'a [String],
    /// 程序的工作資料夾（`Os::cwd`）；讀不到 None
    pub cwd: Option<&'a str>,
    /// 程序的啟動時間（Unix 毫秒）；讀不到 None
    pub started_ms: Option<u64>,
    /// 同一個工作資料夾裡**別的**正在跑的 pi 程序數（不含它自己；呼叫端用 `Os::cwd` 掃出來）
    pub others_same_cwd: usize,
}

/// 命令列給的值 → 對話檔。路徑（含斜線或 .jsonl 結尾）必須是 `files` 清單裡的檔（也就一定在 sessions 底下）；
/// 否則當部分編號，要剛好符合一個檔名裡的編號
fn resolve_arg(v: &str, cwd: Option<&str>, files: &[SessionFile], header: &dyn Fn(&Path) -> Option<Header>) -> Result<Found, String> {
    let looks_path = v.contains('/') || v.contains('\\') || v.ends_with(".jsonl");
    let picked: &SessionFile = if looks_path {
        let p = PathBuf::from(v);
        let full = if p.is_absolute() { p } else { cwd.map(|c| Path::new(c).join(v)).ok_or("這個 pi 的 --session 給的是相對路徑，但讀不到它的工作資料夾")? };
        let want = norm(&full.to_string_lossy());
        files.iter().find(|f| norm(&f.path.to_string_lossy()) == want).ok_or("這個 pi 用的對話檔不在 pi 的對話資料夾裡（或已經不存在），沒有接手")?
    } else {
        let prefix = v.to_lowercase();
        if !valid_id_prefix(&prefix) {
            return Err("這個 pi 的 --session 內容看不懂，沒有接手".into());
        }
        let hits: Vec<&SessionFile> = files.iter().filter(|f| f.file_id.to_lowercase().starts_with(&prefix)).collect();
        match hits.len() {
            0 => return Err("找不到這個 pi 用的對話（--session 給的編號沒有對到任何對話檔）".into()),
            1 => hits[0],
            _ => return Err("有不只一段對話的編號都以這串開頭，無法確定是哪一段".into()),
        }
    };
    let h = header(&picked.path).ok_or("這個對話檔的檔頭讀不懂（不是 pi 的對話檔，或已損壞），沒有接手")?;
    Ok(Found { path: picked.path.clone(), session_id: h.id, cwd: h.cwd, via: Via::Arg })
}

/// 部分編號只收十六進位與連字號，4～64 字
fn valid_id_prefix(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 推論這個 pi 正在用哪一段對話。`files`＝sessions 底下的對話檔清單；`header`＝讀檔頭的函式（測試可換假的）。
/// 不唯一、查不到、讀不到一律回中文原因（不猜）
pub fn resolve(f: &Facts, files: &[SessionFile], header: &dyn Fn(&Path) -> Option<Header>) -> Result<Found, String> {
    if let Some(v) = session_arg(f.args) {
        return resolve_arg(&v, f.cwd, files, header);
    }
    let cwd = f.cwd.ok_or("讀不到這個 pi 的工作資料夾，無法判斷它用的是哪一段對話")?;
    let started = f.started_ms.ok_or("讀不到這個 pi 的啟動時間，無法判斷它用的是哪一段對話")?;
    if f.others_same_cwd > 0 {
        return Err("這個資料夾還有別的 pi 在跑，無法確定哪一段對話是這個 pi 的".into());
    }
    let want = norm(cwd);
    let mut hits: Vec<Found> = vec![];
    for sf in files.iter().filter(|s| s.mtime_ms >= started) {
        let Some(h) = header(&sf.path) else { continue };
        if norm(&h.cwd) == want {
            hits.push(Found { path: sf.path.clone(), session_id: h.id, cwd: h.cwd, via: Via::Cwd });
        }
    }
    match hits.len() {
        1 => Ok(hits.remove(0)),
        0 => Err("這個 pi 啟動後還沒有對話內容可接手（可能還沒講過話），請先在 pi 裡講一句話再按接手".into()),
        _ => Err("這個資料夾在 pi 啟動後有不只一段對話更新過，無法確定是哪一段".into()),
    }
}

/// 重開用的 pi 參數（接在擴充的 `-e`／已安裝之後）：指定同一個對話檔
pub fn reopen_args(found: &Found) -> Vec<String> {
    vec!["--session".to_string(), crate::launch::local::strip_verbatim_prefix(&found.path.to_string_lossy())]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    const ID1: &str = "01a171c3-5056-751a-8c6f-1c725d8daadf";
    const ID2: &str = "01a171c4-1111-7000-8000-aaaaaaaaaaaa";
    const ID3: &str = "01a171c5-2222-7000-8000-bbbbbbbbbbbb";
    const T0: u64 = 1_800_000_000_000; // 程序啟動時間

    fn sf(dir: &str, id: &str, mtime: u64) -> SessionFile {
        SessionFile { path: PathBuf::from(format!("{dir}/2026-10-25T06-33-07-927Z_{id}.jsonl")), file_id: id.to_string(), mtime_ms: mtime }
    }
    /// 假的檔頭：依檔名裡的編號對到 cwd
    fn hdr(map: &'static [(&'static str, &'static str)]) -> impl Fn(&Path) -> Option<Header> {
        move |p: &Path| {
            let name = p.file_name()?.to_string_lossy().to_string();
            map.iter().find(|(id, _)| name.contains(id)).map(|(id, cwd)| Header { id: id.to_string(), cwd: cwd.to_string() })
        }
    }
    fn facts<'a>(args: &'a [String], cwd: Option<&'a str>, started: Option<u64>, others: usize) -> Facts<'a> {
        Facts { args, cwd, started_ms: started, others_same_cwd: others }
    }

    #[test]
    fn 名單條目名_轉_pid() {
        assert_eq!(proc_pid("pi #30784（前景）"), Some(30784));
        assert_eq!(proc_pid("pi · MiniMax #1234（前景）"), Some(1234));
        assert_eq!(proc_pid("PI #5"), Some(5));
        assert_eq!(proc_pid("pi #77(foreground)"), Some(77));
        for bad in ["pico #12（前景）", "pip #3", "pi", "pi #", "pi #0（前景）", "pi #12abc", "grok #12（前景）", "小皮", "pi-資料夾 #5", ""] {
            assert_eq!(proc_pid(bad), None, "{bad}");
        }
    }

    #[test]
    fn 命令列的_session() {
        assert_eq!(session_arg(&v(&["pi", "--session", "abcd1234"])), Some("abcd1234".into()));
        assert_eq!(session_arg(&v(&["pi", "--session=D:/x/y.jsonl", "-c"])), Some("D:/x/y.jsonl".into()));
        assert_eq!(session_arg(&v(&["pi", "--session", "a", "--session", "b"])), Some("b".into()), "最後一個算數");
        assert_eq!(session_arg(&v(&["pi", "--session"])), None, "沒給值");
        assert_eq!(session_arg(&v(&["pi", "--session="])), None, "空值");
        assert_eq!(session_arg(&v(&["pi", "-c", "--continue", "--fork", "x", "--session-id", "y"])), None, "別的旗標不算");
        assert_eq!(session_arg(&v(&["--session", "x"])), None, "第一個字是程式本身，不當旗標");
    }

    // ---- 真的檔案：列清單與讀檔頭 ----
    fn put(dir: &Path, sub: &str, name: &str, body: &str, mtime_ms: Option<u64>) -> PathBuf {
        let d = dir.join(sub);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, body).unwrap();
        if let Some(ms) = mtime_ms {
            let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_modified(UNIX_EPOCH + Duration::from_millis(ms)).unwrap();
        }
        p
    }
    /// 與真的 pi 1.4.0 寫出的檔頭同格式（實測取樣、路徑換成假的）
    fn real_header(id: &str, cwd_json: &str) -> String {
        format!("{{\"type\":\"session\",\"version\":\"3\",\"id\":\"{id}\",\"timestamp\":\"2026-10-25T06:33:07.927Z\",\"cwd\":{cwd_json}}}\n{{\"type\":\"message\",\"x\":1}}\n")
    }

    #[test]
    fn 列對話檔_只收_jsonl_且檔名有編號_資料夾不存在是空() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), "--C--x--", &format!("2026-10-25T06-33-07-927Z_{ID1}.jsonl"), "x\n", None);
        put(d.path(), "--C--y--", &format!("2026-10-24T01-00-00-000Z_{ID2}.jsonl"), "x\n", None);
        put(d.path(), "--C--x--", "notes.txt", "x", None);
        put(d.path(), "--C--x--", "bad_name.jsonl", "x", None);
        put(d.path(), "--C--x--", "nounderscore.jsonl", "x", None);
        std::fs::write(d.path().join("loose.jsonl"), "x").unwrap();
        let mut got = list_session_files(d.path());
        got.sort_by(|a, b| a.file_id.cmp(&b.file_id));
        assert_eq!(got.iter().map(|s| s.file_id.as_str()).collect::<Vec<_>>(), vec![ID1, ID2]);
        assert!(got.iter().all(|s| s.mtime_ms > 0));
        assert!(list_session_files(&d.path().join("nope")).is_empty());
    }

    #[test]
    fn 讀檔頭_真實格式_只讀第一行() {
        let d = tempfile::tempdir().unwrap();
        let p = put(d.path(), "s", "a.jsonl", &real_header(ID1, r#""C:\\Users\\u\\proj""#), None);
        assert_eq!(read_header(&p), Some(Header { id: ID1.into(), cwd: r"C:\Users\u\proj".into() }));
        let no_nl = put(d.path(), "s", "b.jsonl", r#"{"type":"session","id":"01a171c3-5056-751a-8c6f-1c725d8daadf","cwd":"C:/x"}"#, None);
        assert_eq!(read_header(&no_nl), None, "沒有換行＝這一行還沒寫完");
        for (name, body) in [
            ("bad.jsonl", "{壞\n".to_string()),
            ("notsession.jsonl", "{\"type\":\"message\",\"id\":\"01a171c3-5056-751a-8c6f-1c725d8daadf\",\"cwd\":\"C:/x\"}\n".to_string()),
            ("badid.jsonl", "{\"type\":\"session\",\"id\":\"../../etc\",\"cwd\":\"C:/x\"}\n".to_string()),
            ("nocwd.jsonl", "{\"type\":\"session\",\"id\":\"01a171c3-5056-751a-8c6f-1c725d8daadf\"}\n".to_string()),
            ("emptycwd.jsonl", "{\"type\":\"session\",\"id\":\"01a171c3-5056-751a-8c6f-1c725d8daadf\",\"cwd\":\"\"}\n".to_string()),
            ("huge.jsonl", format!("{{\"type\":\"session\",\"id\":\"01a171c3-5056-751a-8c6f-1c725d8daadf\",\"cwd\":\"{}\"}}\n", "x".repeat(9000))),
        ] {
            let p = put(d.path(), "s", name, &body, None);
            assert_eq!(read_header(&p), None, "{name}");
        }
        assert_eq!(read_header(&d.path().join("missing.jsonl")), None);
    }

    #[test]
    fn 命令列指定路徑_要是對話資料夾裡的檔() {
        // 絕對路徑用 temp_dir 組：D:/ 在 Linux 不算絕對路徑，會被當成相對路徑接到工作資料夾後面
        let root = std::env::temp_dir().join("pi").join("sessions");
        let dir = |d: &str| root.join(d).to_string_lossy().replace('\\', "/");
        let files = [sf(&dir("--C--p--"), ID1, T0 - 5000), sf(&dir("--C--q--"), ID2, T0 - 9000)];
        let h = hdr(&[(ID1, "C:/p"), (ID2, "C:/q")]);
        let abs = format!("{}/2026-10-25T06-33-07-927Z_{ID1}.jsonl", dir("--C--p--"));
        let got = resolve(&facts(&v(&["pi", "--session", &abs]), Some("C:/other"), Some(T0), 3), &files, &h).unwrap();
        assert_eq!((got.session_id.as_str(), got.cwd.as_str(), got.via), (ID1, "C:/p", Via::Arg), "指定的就用，不管 cwd、不管別的 pi、不管修改時間");
        // 大小寫與斜線不同也認（只有 Windows 的路徑不分大小寫）
        if cfg!(windows) {
            let upper = abs.replace('/', "\\").to_uppercase();
            assert!(resolve(&facts(&v(&["pi", &format!("--session={upper}")]), None, None, 0), &files, &h).is_ok());
        }
        // 不在對話資料夾裡的檔（例如 /etc/passwd 或別處的檔案）一律不接手，也不去讀它
        let secret = std::env::temp_dir().join("secret").join("auth.json").to_string_lossy().to_string();
        let e = resolve(&facts(&v(&["pi", "--session", &secret]), None, None, 0), &files, &|_: &Path| panic!("不該讀")).unwrap_err();
        assert!(e.contains("不在 pi 的對話資料夾"), "{e}");
    }

    #[test]
    fn 命令列指定相對路徑_要有工作資料夾() {
        let files = [sf("C:/w/sess", ID1, T0)];
        let h = hdr(&[(ID1, "C:/w")]);
        let rel = format!("sess/2026-10-25T06-33-07-927Z_{ID1}.jsonl");
        let ok = resolve(&facts(&v(&["pi", "--session", &rel]), Some("C:/w"), None, 0), &files, &h).unwrap();
        assert_eq!(ok.session_id, ID1);
        assert!(resolve(&facts(&v(&["pi", "--session", &rel]), None, None, 0), &files, &h).unwrap_err().contains("讀不到它的工作資料夾"));
    }

    #[test]
    fn 命令列指定部分編號_剛好一個才算() {
        let files = [sf("C:/s/a", ID1, T0), sf("C:/s/b", ID2, T0), sf("C:/s/c", "01a171c4-9999-7000-8000-cccccccccccc", T0)];
        let h = hdr(&[(ID1, "C:/a"), (ID2, "C:/b"), ("01a171c4-9999-7000-8000-cccccccccccc", "C:/c")]);
        let one = resolve(&facts(&v(&["pi", "--session", "01a171c3"]), None, None, 0), &files, &h).unwrap();
        assert_eq!((one.session_id.as_str(), one.via), (ID1, Via::Arg));
        assert!(resolve(&facts(&v(&["pi", "--session", "01A171C3"]), None, None, 0), &files, &h).is_ok(), "大小寫不分");
        let many = resolve(&facts(&v(&["pi", "--session", "01a171c4"]), None, None, 0), &files, &h).unwrap_err();
        assert!(many.contains("不只一段"), "{many}");
        assert!(resolve(&facts(&v(&["pi", "--session", "ffffffff"]), None, None, 0), &files, &h).unwrap_err().contains("找不到"));
        for bad in ["abc", "zzzzzzzz", "01a171c3;rm"] {
            assert!(resolve(&facts(&v(&["pi", "--session", bad]), None, None, 0), &files, &h).unwrap_err().contains("看不懂"), "{bad}");
        }
    }

    #[test]
    fn 推論_工作資料夾加檔頭加啟動時間_唯一才接手() {
        let files = [
            sf("S/p", ID1, T0 + 5000), // 這個 pi 啟動後更新過、cwd 對
            sf("S/p", ID2, T0 - 60_000), // 同資料夾的舊對話（啟動前就沒動）
            sf("S/q", ID3, T0 + 9000), // 別的資料夾的對話（啟動後也更新過）
        ];
        let h = hdr(&[(ID1, r"C:\Work\Proj"), (ID2, r"C:\Work\Proj"), (ID3, r"C:\Other")]);
        let got = resolve(&facts(&v(&["pi"]), Some("c:/work/proj/"), Some(T0), 0), &files, &h).unwrap();
        assert_eq!((got.session_id.as_str(), got.via), (ID1, Via::Cwd));
        assert_eq!(got.cwd, r"C:\Work\Proj", "重開用檔頭記的資料夾");
        // -c／--continue／--fork 不特別處理，照樣走推論
        assert!(resolve(&facts(&v(&["pi", "-c"]), Some(r"C:\Work\Proj"), Some(T0), 0), &files, &h).is_ok());
        assert!(resolve(&facts(&v(&["pi", "--fork", "x"]), Some(r"C:\Work\Proj"), Some(T0), 0), &files, &h).is_ok());
    }

    #[test]
    fn 推論_盲區與各種拒絕() {
        let files = [sf("S/p", ID1, T0 - 1000), sf("S/p", ID2, T0 + 2000), sf("S/p", ID3, T0 + 3000)];
        let h = hdr(&[(ID1, "C:/p"), (ID2, "C:/p"), (ID3, "C:/p")]);
        // 兩段在啟動後都更新過 → 不唯一
        let two = resolve(&facts(&v(&["pi"]), Some("C:/p"), Some(T0), 0), &files, &h).unwrap_err();
        assert!(two.contains("不只一段"), "{two}");
        // 盲區：只有啟動前的舊檔（接續舊對話但還沒講話，或全新對話）→ 請使用者先講一句話
        let blind = resolve(&facts(&v(&["pi"]), Some("C:/p"), Some(T0 + 10_000), 0), &files, &h).unwrap_err();
        assert!(blind.contains("先在 pi 裡講一句話"), "{blind}");
        // 同資料夾還有別的 pi
        let others = resolve(&facts(&v(&["pi"]), Some("C:/p"), Some(T0 + 2500), 1), &files, &h).unwrap_err();
        assert!(others.contains("還有別的 pi 在跑"), "{others}");
        // 讀不到事實
        assert!(resolve(&facts(&v(&["pi"]), None, Some(T0), 0), &files, &h).unwrap_err().contains("工作資料夾"));
        assert!(resolve(&facts(&v(&["pi"]), Some("C:/p"), None, 0), &files, &h).unwrap_err().contains("啟動時間"));
        // 檔頭讀不懂的檔不當候選；整個清單空也是盲區
        assert!(resolve(&facts(&v(&["pi"]), Some("C:/p"), Some(T0), 0), &files, &|_: &Path| None).unwrap_err().contains("還沒有對話內容"));
        assert!(resolve(&facts(&v(&["pi"]), Some("C:/p"), Some(T0), 0), &[], &h).unwrap_err().contains("還沒有對話內容"));
    }

    #[test]
    fn 推論_只讀修改時間夠新的檔的檔頭() {
        // 效率與隱私：啟動前就沒動過的檔，連檔頭都不讀
        let files = [sf("S/p", ID1, T0 - 1), sf("S/p", ID2, T0 + 1)];
        let seen = std::cell::RefCell::new(vec![]);
        let h = |p: &Path| {
            seen.borrow_mut().push(p.file_name().unwrap().to_string_lossy().to_string());
            Some(Header { id: ID2.into(), cwd: "C:/p".into() })
        };
        resolve(&facts(&v(&["pi"]), Some("C:/p"), Some(T0), 0), &files, &h).unwrap();
        let seen = seen.borrow();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].contains(ID2));
    }

    #[test]
    fn 重開參數_指定同一個對話檔() {
        let f = Found { path: PathBuf::from(r"\\?\D:\pi\sessions\x\a.jsonl"), session_id: ID1.into(), cwd: "C:/p".into(), via: Via::Arg };
        assert_eq!(reopen_args(&f), v(&["--session", r"D:\pi\sessions\x\a.jsonl"]), "去掉 verbatim 前綴");
    }

    #[test]
    fn 用真的檔案端到端_列清單_讀檔頭_推論() {
        let d = tempfile::tempdir().unwrap();
        let start = 1_800_000_000_000u64;
        put(d.path(), "--C--w--", &format!("2026-10-24T01-00-00-000Z_{ID2}.jsonl"), &real_header(ID2, r#""C:\\w""#), Some(start - 3_600_000));
        let live = put(d.path(), "--C--w--", &format!("2026-10-25T06-33-07-927Z_{ID1}.jsonl"), &real_header(ID1, r#""C:\\w""#), Some(start + 4000));
        put(d.path(), "--C--z--", &format!("2026-10-25T07-00-00-000Z_{ID3}.jsonl"), &real_header(ID3, r#""C:\\z""#), Some(start + 5000));
        let files = list_session_files(d.path());
        assert_eq!(files.len(), 3);
        let got = resolve(&facts(&v(&["pi"]), Some(r"C:\w\"), Some(start), 0), &files, &read_header).unwrap();
        assert_eq!((got.session_id.as_str(), got.path.clone()), (ID1, live));
        let blind = resolve(&facts(&v(&["pi"]), Some(r"C:\w"), Some(start + 60_000), 0), &files, &read_header);
        assert!(blind.is_err(), "啟動時間晚於所有檔案＝盲區");
    }
}
