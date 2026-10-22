//! 往來記錄（issue #107）：橋每轉交一封信、每收到視窗的一則回覆，就追加到
//! `%USERPROFILE%\.asn\handoff\<檔名>.md`，同名的新 session 接手時可以先讀。檔案只在本機。
//! - 檔名（#153）：後台認得這個視窗是哪位夥伴（有夥伴 ID）就用 `<夥伴ID>.md`，視窗改名、換 session 都續寫同一份；
//!   後台沒有夥伴 ID（舊後台、尚未回報）就維持 `<視窗名>.md`。舊檔以檔頭的夥伴 ID 對回、併進去，不丟資料（見 `reconcile`）。
//! - 每筆記錄以「▌」開頭的標頭行起頭；內文裡以「▌」開頭的行會被縮排一格，所以數筆數不會被內文騙。
//! - 單筆內文超過 4 KB 截斷並加「（以下省略）」。
//! - 檔案超過 1 MB 或 200 筆：舊的搬到 `archive/<視窗名>-<yyyymmdd-HHMMSS>.md`，活檔只留最近的（最多 200 筆、不超過 1 MB）。
//! - 寫檔用 write_atomic；行程內用一把互斥鎖串起來（一台電腦只有一個橋）。
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_BODY_BYTES: usize = 4096;
pub const MAX_ENTRIES: usize = 200;
pub const MAX_FILE_BYTES: usize = 1024 * 1024;
pub const TRUNC_MARK: &str = "（以下省略）";
const MARK: char = '▌';
/// 檔頭行（#109）：記這個視窗名目前對應的夥伴 ID，之後記錄改以夥伴 ID 為鍵時（#108）可以接上；檔名仍用視窗名
pub const HEADER_PREFIX: &str = "# 夥伴 ID：";

/// 檔頭行內容：`# 夥伴 ID：p_xxx｜目前名字：甲`
pub fn header_line(partner_id: &str, name: &str) -> String {
    format!("{HEADER_PREFIX}{partner_id}｜目前名字：{name}")
}

/// 檔頭行裡的夥伴 ID（格式不對回 None）
fn header_pid(line: &str) -> Option<&str> {
    let rest = line.strip_prefix(HEADER_PREFIX)?;
    let id = rest.split('｜').next()?.trim();
    (id.len() == 22 && id.starts_with("p_") && id[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(id)
}

/// 讀檔案最前面一行的夥伴 ID（只讀前 256 位元組，掃資料夾時不必整檔讀進來）
fn file_header_pid(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = [0u8; 256];
    let n = std::fs::File::open(path).ok()?.read(&mut buf).ok()?;
    let head = String::from_utf8_lossy(&buf[..n]);
    let line = head.lines().next()?;
    header_pid(line).map(String::from)
}

/// 切出檔頭行（有的話）與其餘內容
fn split_header(text: &str) -> (Option<&str>, &str) {
    if !text.starts_with(HEADER_PREFIX) {
        return (None, text);
    }
    match text.find('\n') {
        Some(i) => (Some(text[..i].trim_end_matches('\r')), &text[i + 1..]),
        None => (Some(text.trim_end_matches('\r')), ""),
    }
}

/// `%USERPROFILE%\.asn\handoff`（沿用身分模組的家目錄，測試用同一個覆蓋方式）
pub fn default_dir() -> PathBuf {
    crate::identity::home_dir().join(".asn").join("handoff")
}

/// 視窗名 → 檔名：和心跳檔同一套非法字元替換
pub fn safe_name(name: &str) -> String {
    name.chars().map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 { '_' } else { c }).collect()
}

pub fn file_of(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{}.md", safe_name(name)))
}

/// 以夥伴 ID 為鍵的檔案（#153）
pub fn pid_file_of(dir: &Path, partner_id: &str) -> PathBuf {
    dir.join(format!("{}.md", safe_name(partner_id)))
}

/// 附在每封轉交信最後的那一行（格式固定）；`file` 是實際要寫的檔
pub fn path_line_of(file: &Path) -> String {
    format!("你與收發室的往來記錄在：{}（接手前請先讀）", file.display())
}

/// 沒有夥伴 ID 時（舊後台）的路徑行：檔名是視窗名
pub fn path_line(dir: &Path, name: &str) -> String {
    path_line_of(&file_of(dir, name))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dir {
    /// 收發室轉交給這個視窗
    Received,
    /// 這個視窗的回覆／代寄（經橋轉出）
    Replied,
    /// 視窗自己用命令列回信或寄信，橋只看得到記號（沒有內文）
    Direct,
    /// 手機下令的視窗管理操作（詳情、改名、切換模型、關閉、轉交）：誰下的令、做了什麼、結果
    Op,
}

pub struct Entry<'a> {
    pub ts_ms: u64,
    pub dir: Dir,
    pub from: &'a str,
    pub to: &'a str,
    pub id: &'a str,
    pub body: &'a str,
    pub attachments: &'a [String],
}

pub struct CorrLog {
    dir: PathBuf,
    lock: Mutex<()>,
    /// 視窗名 → 夥伴 ID（橋回報名單時由後端回傳；沒有就不寫檔頭，已有的檔頭保持原樣）
    partners: Mutex<BTreeMap<String, String>>,
    /// 這次執行已經把舊檔對回過的夥伴 ID（每位夥伴每次執行只掃一次資料夾）
    reconciled: Mutex<HashSet<String>>,
}

/// 本地時間 (年,月,日,時,分,秒)。Windows 用系統時區；其他平台退回 UTC
fn local_fields(ms: u64) -> (u64, u64, u64, u64, u64, u64) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
        let ticks = (ms as u128 + 11_644_473_600_000) * 10_000;
        let ft = FILETIME { dwLowDateTime: (ticks & 0xffff_ffff) as u32, dwHighDateTime: (ticks >> 32) as u32 };
        let mut utc: SYSTEMTIME = unsafe { std::mem::zeroed() };
        let mut loc: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe {
            if FileTimeToSystemTime(&ft, &mut utc) != 0 && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut loc) != 0 {
                return (loc.wYear as u64, loc.wMonth as u64, loc.wDay as u64, loc.wHour as u64, loc.wMinute as u64, loc.wSecond as u64);
            }
        }
    }
    utc_fields(ms)
}

fn utc_fields(ms: u64) -> (u64, u64, u64, u64, u64, u64) {
    let secs = ms / 1000;
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    // civil_from_days（Howard Hinnant）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as u64, m as u64, d as u64, rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn stamp(ms: u64) -> String {
    let (y, mo, d, h, mi, s) = local_fields(ms);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}
fn stamp_compact(ms: u64) -> String {
    let (y, mo, d, h, mi, s) = local_fields(ms);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// 內文截到 4 KB（不切斷字元），並把「▌」開頭的行縮排一格
fn clip_body(body: &str) -> String {
    let body = body.replace("\r\n", "\n");
    let body = body.trim_end();
    let (cut, over) = if body.len() > MAX_BODY_BYTES {
        let mut n = MAX_BODY_BYTES;
        while !body.is_char_boundary(n) {
            n -= 1;
        }
        (&body[..n], true)
    } else {
        (body, false)
    };
    let mut out: Vec<String> = cut.lines().map(|l| if l.starts_with(MARK) { format!(" {l}") } else { l.to_string() }).collect();
    if over {
        out.push(TRUNC_MARK.to_string());
    }
    out.join("\n")
}

fn render(e: &Entry) -> String {
    let label = match e.dir {
        Dir::Received => "收到",
        Dir::Replied => "回覆",
        Dir::Direct => "自行回信",
        Dir::Op => "視窗管理",
    };
    let mut s = format!("{MARK} {} {label}｜{} → {}｜id={}\n", stamp(e.ts_ms), e.from, e.to, e.id);
    if !e.attachments.is_empty() {
        s.push_str(&format!("附件：{}\n", e.attachments.join("、")));
    }
    let b = clip_body(e.body);
    if !b.is_empty() {
        s.push_str(&b);
        s.push('\n');
    }
    s.push('\n');
    s
}

/// 把整份文字切成一筆一筆（第一個標頭之前的雜訊丟掉）
fn split_entries(text: &str) -> Vec<&str> {
    let mut starts: Vec<usize> = vec![];
    let mut pos = 0;
    for line in text.split_inclusive('\n') {
        if line.starts_with(MARK) {
            starts.push(pos);
        }
        pos += line.len();
    }
    let mut out = vec![];
    for (i, s) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(text.len());
        out.push(&text[*s..end]);
    }
    out
}

impl CorrLog {
    pub fn new(dir: PathBuf) -> CorrLog {
        CorrLog { dir, lock: Mutex::new(()), partners: Mutex::new(BTreeMap::new()), reconciled: Mutex::new(HashSet::new()) }
    }
    /// 更新視窗名對夥伴 ID 的對照（整份換掉）；下一次追加時寫進檔頭
    pub fn set_partners(&self, m: BTreeMap<String, String>) {
        *self.partners.lock().unwrap_or_else(|p| p.into_inner()) = m;
    }
    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }
    /// 附在轉交信最後的路徑行：指向這個視窗現在實際寫的那個檔（有夥伴 ID 就是 `<夥伴ID>.md`，並先把舊檔對回來）
    pub fn path_line(&self, name: &str) -> String {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        path_line_of(&self.file_for(name))
    }

    /// 這個視窗名現在對應的夥伴 ID：後台回報的優先；後台暫時沒回，就看視窗名舊檔的檔頭
    fn pid_of(&self, name: &str) -> Option<String> {
        if let Some(id) = self.partners.lock().unwrap_or_else(|p| p.into_inner()).get(name) {
            return Some(id.clone());
        }
        file_header_pid(&file_of(&self.dir, name))
    }

    /// 這個視窗的往來記錄檔（呼叫端要持有 `self.lock`）。有夥伴 ID → `<夥伴ID>.md`（第一次先 `reconcile`）；沒有 → `<視窗名>.md`
    fn file_for(&self, name: &str) -> PathBuf {
        match self.pid_of(name) {
            Some(pid) => {
                self.reconcile(&pid, name);
                pid_file_of(&self.dir, &pid)
            }
            None => file_of(&self.dir, name),
        }
    }

    /// 舊檔對回夥伴 ID（#153）：資料夾裡檔頭夥伴 ID 等於 `pid` 的舊檔（改名前的視窗名檔）、以及這個視窗名底下沒有檔頭的舊檔
    /// （第一期以前寫的），依修改時間由舊到新併到 `<pid>.md` 前面（記錄原樣、不重排、不去重），併完才刪舊檔；
    /// 寫不進去就留著舊檔，下次再試。每位夥伴每次執行只掃一次（寫了沒有夥伴 ID 的檔會重新開放）。
    fn reconcile(&self, pid: &str, name: &str) {
        if self.reconciled.lock().unwrap_or_else(|p| p.into_inner()).contains(pid) {
            return;
        }
        let target = pid_file_of(&self.dir, pid);
        let own = file_of(&self.dir, name);
        let mut srcs: Vec<(std::time::SystemTime, PathBuf)> = vec![];
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for f in rd.flatten() {
                let p = f.path();
                if p == target || !p.is_file() || p.extension().map_or(true, |x| x != "md") {
                    continue;
                }
                let hp = file_header_pid(&p);
                if hp.as_deref() == Some(pid) || (p == own && hp.is_none()) {
                    let t = f.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    srcs.push((t, p));
                }
            }
        }
        if !srcs.is_empty() {
            srcs.sort();
            // 舊檔（依修改時間由舊到新）加上現有的 <pid>.md，記錄原樣，再依標頭行的時間穩定排序（同一秒維持原順序）
            let mut texts: Vec<String> = srcs.iter().map(|(_, p)| std::fs::read_to_string(p).unwrap_or_default()).collect();
            texts.push(std::fs::read_to_string(&target).unwrap_or_default());
            let bodies: Vec<String> = texts.iter().map(|t| {
                let b = split_header(t).1.trim_start_matches(['\r', '\n']).to_string();
                if !b.is_empty() && !b.ends_with('\n') { format!("{b}\n") } else { b }
            }).collect();
            let mut chunks: Vec<&str> = bodies.iter().flat_map(|b| split_entries(b)).collect();
            chunks.sort_by_key(|c| c.chars().skip(2).take(19).collect::<String>());
            let text: String = chunks.concat();
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let Ok(merged) = self.rotate(pid, text, ms) else { return };
            let out = format!("{}\n\n{}", header_line(pid, name), merged);
            if crate::write_atomic(&target, &out).is_err() {
                return;
            }
            for (_, p) in &srcs {
                let _ = std::fs::remove_file(p);
            }
        }
        self.reconciled.lock().unwrap_or_else(|p| p.into_inner()).insert(pid.to_string());
    }

    /// 追加一筆。失敗回錯誤字串（呼叫端只記 log，不擋轉交）
    pub fn append(&self, name: &str, e: &Entry) -> Result<(), String> {
        if name.trim().is_empty() {
            return Ok(());
        }
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let file = self.file_for(name);
        let existing = std::fs::read_to_string(&file).unwrap_or_default();
        // 檔頭行先拆開：輪替只認記錄，不能把檔頭當雜訊丟掉；寫回時用最新的夥伴 ID，沒有就保留原本的
        let (old_head, rest) = split_header(&existing);
        let mut text = rest.trim_start_matches(['\r', '\n']).to_string();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&render(e));
        let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| safe_name(name));
        let text = self.rotate(&stem, text, e.ts_ms)?;
        // 檔頭：用最新的夥伴 ID 與目前名字（視窗改名後續寫同一份，檔頭名字跟著更新）；沒有夥伴 ID 就保留原本的
        let head = self.partners.lock().unwrap_or_else(|p| p.into_inner()).get(name).map(|id| header_line(id, name)).or_else(|| old_head.map(String::from));
        if head.is_none() {
            // 寫了一份沒有夥伴 ID 的檔：之後拿到夥伴 ID 時要能重新對回來
            self.reconciled.lock().unwrap_or_else(|p| p.into_inner()).clear();
        }
        let text = match head {
            Some(h) => format!("{h}\n\n{text}"),
            None => text,
        };
        crate::write_atomic(&file, &text).map_err(|e| format!("存不了往來記錄 {}：{e}", file.display()))
    }

    /// 超過 1 MB 或 200 筆：舊的整段先寫進 archive，活檔只留最近的
    fn rotate(&self, stem: &str, text: String, now_ms: u64) -> Result<String, String> {
        let entries = split_entries(&text);
        if text.len() <= MAX_FILE_BYTES && entries.len() <= MAX_ENTRIES {
            return Ok(text);
        }
        let mut keep_from = entries.len().saturating_sub(MAX_ENTRIES);
        let mut size: usize = entries[keep_from..].iter().map(|s| s.len()).sum();
        while size > MAX_FILE_BYTES && keep_from + 1 < entries.len() {
            size -= entries[keep_from].len();
            keep_from += 1;
        }
        if keep_from == 0 {
            return Ok(text);
        }
        let old: String = entries[..keep_from].concat();
        let live: String = entries[keep_from..].concat();
        // 同一秒內再次輪替就接在同一個封存檔後面（不另開檔）
        let arch = self.dir.join("archive").join(format!("{}-{}.md", safe_name(stem), stamp_compact(now_ms)));
        let old = match std::fs::read_to_string(&arch) {
            Ok(prev) => format!("{prev}{old}"),
            Err(_) => old,
        };
        crate::write_atomic(&arch, &old).map_err(|e| format!("存不了往來記錄封存 {}：{e}", arch.display()))?;
        Ok(live)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e<'a>(ts: u64, dir: Dir, id: &'a str, body: &'a str) -> Entry<'a> {
        Entry { ts_ms: ts, dir, from: "H/甲", to: "乙", id, body, attachments: &[] }
    }

    #[test]
    fn 檔名替換非法字元_和心跳檔一致() {
        assert_eq!(safe_name("a/b\\c:d*e?f\"g<h>i|j\u{1}k"), "a_b_c_d_e_f_g_h_i_j_k");
        assert_eq!(safe_name("x/y"), crate::heartbeat::heartbeat_file(Path::new("w"), "x/y").file_stem().unwrap().to_string_lossy());
        let t = tempfile::tempdir().unwrap();
        assert_eq!(file_of(t.path(), "家用/ASN").file_name().unwrap().to_string_lossy(), "家用_ASN.md");
    }

    #[test]
    fn 路徑行格式固定() {
        let l = path_line(Path::new("/h"), "乙");
        assert!(l.starts_with("你與收發室的往來記錄在："));
        assert!(l.ends_with("乙.md（接手前請先讀）"));
    }

    #[test]
    fn 追加一筆_含方向_時間_編號_附件_內文() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().join("handoff"));
        let att = vec!["a.png".to_string(), "b.pdf".to_string()];
        c.append("乙", &Entry { ts_ms: 1_700_000_000_000, dir: Dir::Received, from: "H/甲", to: "乙", id: "id-1", body: "你好\n第二行", attachments: &att }).unwrap();
        c.append("乙", &e(1_700_000_060_000, Dir::Replied, "id-1", "好的")).unwrap();
        let s = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        assert!(s.contains("收到｜H/甲 → 乙｜id=id-1"));
        assert!(s.contains("附件：a.png、b.pdf"));
        assert!(s.contains("你好\n第二行"));
        assert!(s.contains("回覆｜H/甲 → 乙｜id=id-1"));
        assert_eq!(split_entries(&s).len(), 2);
        assert!(!std::fs::read_dir(c.dir()).unwrap().flatten().any(|f| f.file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn 內文過長截斷並標示_不切斷中文() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        c.append("乙", &e(1, Dir::Received, "i", &"字".repeat(5000))).unwrap();
        let s = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        assert!(s.contains(TRUNC_MARK));
        assert!(s.len() < MAX_BODY_BYTES + 400);
        let c2 = CorrLog::new(t.path().join("b"));
        c2.append("乙", &e(1, Dir::Received, "i", "短")).unwrap();
        assert!(!std::fs::read_to_string(file_of(c2.dir(), "乙")).unwrap().contains(TRUNC_MARK));
    }

    #[test]
    fn 內文裡的標頭符號不會被當成新的一筆() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        c.append("乙", &e(1, Dir::Received, "i", "▌ 假的標頭\n正文")).unwrap();
        let s = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        assert_eq!(split_entries(&s).len(), 1);
    }

    #[test]
    fn 超過兩百筆輪替_舊的進_archive_活檔留最近兩百筆() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().join("handoff"));
        for i in 0..205u32 {
            c.append("乙", &e(1_700_000_000_000, Dir::Received, &format!("id-{i:03}"), "x")).unwrap();
        }
        let live = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        let n = split_entries(&live).len();
        assert!(n <= MAX_ENTRIES && n >= MAX_ENTRIES - 5, "n={n}");
        assert!(live.contains("id=id-204") && !live.contains("id=id-000"));
        let arch: Vec<_> = std::fs::read_dir(c.dir().join("archive")).unwrap().flatten().collect();
        assert_eq!(arch.len(), 1);
        let name = arch[0].file_name().to_string_lossy().to_string();
        assert!(name.starts_with("乙-") && name.ends_with(".md"), "{name}");
        let a = std::fs::read_to_string(arch[0].path()).unwrap();
        assert!(a.contains("id=id-000"));
        // 封存＋活檔＝全部，沒有掉也沒有重複
        assert_eq!(split_entries(&a).len() + n, 205);
    }

    #[test]
    fn 超過_1mb_輪替() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        let body = "字".repeat(1300); // 約 3.9 KB／筆
        for i in 0..300u32 {
            c.append("乙", &e(1_700_000_000_000 + i as u64, Dir::Received, &format!("id-{i:03}"), &body)).unwrap();
        }
        let live = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        assert!(live.len() <= MAX_FILE_BYTES + 5000);
        assert!(live.contains("id=id-299"));
        assert!(c.dir().join("archive").exists());
    }

    fn pid(n: u8) -> String {
        format!("p_{}", format!("{n:02x}").repeat(10))
    }

    #[test]
    fn 夥伴_id_寫在檔頭行_檔名是夥伴_id_每次追加只留一行檔頭() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().join("handoff"));
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        c.append("乙", &e(1_700_000_000_000, Dir::Received, "id-1", "你好")).unwrap();
        c.append("乙", &e(1_700_000_001_000, Dir::Replied, "id-1", "好")).unwrap();
        let f = pid_file_of(c.dir(), &pid(1));
        assert_eq!(f.file_name().unwrap().to_string_lossy(), format!("{}.md", pid(1)));
        assert!(!file_of(c.dir(), "乙").exists(), "有夥伴 ID 就不再寫視窗名檔");
        let s = std::fs::read_to_string(f).unwrap();
        assert!(s.starts_with(&format!("{HEADER_PREFIX}{}｜目前名字：乙

{MARK} ", pid(1))), "{s}");
        assert_eq!(s.matches(HEADER_PREFIX).count(), 1);
        assert_eq!(split_entries(&s).len(), 2);
    }

    #[test]
    fn 視窗改名後續寫同一份_檔頭名字跟著更新_舊名檔不會冒出來() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().join("handoff"));
        c.set_partners(BTreeMap::from([("甲".to_string(), pid(1))]));
        c.append("甲", &e(1, Dir::Received, "i1", "x")).unwrap();
        c.append("甲", &e(2, Dir::Replied, "i1", "y")).unwrap();
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        assert_eq!(c.path_line("乙"), path_line_of(&pid_file_of(c.dir(), &pid(1))), "路徑行指向夥伴 ID 檔");
        c.append("乙", &e(3, Dir::Received, "i2", "z")).unwrap();
        let s = std::fs::read_to_string(pid_file_of(c.dir(), &pid(1))).unwrap();
        assert!(s.starts_with(&header_line(&pid(1), "乙")));
        assert_eq!(split_entries(&s).len(), 3);
        let md: Vec<_> = std::fs::read_dir(c.dir()).unwrap().flatten().filter(|f| f.path().extension().map_or(false, |x| x == "md")).collect();
        assert_eq!(md.len(), 1, "資料夾裡只有一份記錄");
    }

    #[test]
    fn 舊的視窗名檔以檔頭夥伴_id_對回_併進夥伴_id_檔_不丟資料_順序依時間() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("handoff");
        // 第一期寫的舊檔：檔名是舊的視窗名，檔頭記夥伴 ID
        let old = CorrLog::new(dir.clone());
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |name: &str, ids: &[(u64, &str)], head: Option<String>| {
            let mut body = String::new();
            for (ts, id) in ids {
                body.push_str(&render(&e(*ts, Dir::Received, id, "舊")));
            }
            let text = match head {
                Some(h) => format!("{h}

{body}"),
                None => body,
            };
            std::fs::write(file_of(&dir, name), text).unwrap();
        };
        mk("甲", &[(1_700_000_000_000, "a1"), (1_700_000_100_000, "a2")], Some(header_line(&pid(1), "甲")));
        // 別位夥伴的檔不能被動到
        mk("丙", &[(1_700_000_050_000, "c1")], Some(header_line(&pid(7), "丙")));
        // 已經有夥伴 ID 檔（改名後新寫的）
        let tgt = pid_file_of(&dir, &pid(1));
        std::fs::write(&tgt, format!("{}\n\n{}", header_line(&pid(1), "乙"), render(&e(1_700_000_200_000, Dir::Received, "a3", "新")))).unwrap();
        old.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        old.append("乙", &e(1_700_000_300_000, Dir::Replied, "a4", "更新")).unwrap();
        let s = std::fs::read_to_string(&tgt).unwrap();
        let ids: Vec<&str> = split_entries(&s).iter().map(|c| c.split("id=").nth(1).unwrap().lines().next().unwrap()).collect();
        assert_eq!(ids, vec!["a1", "a2", "a3", "a4"], "{s}");
        assert!(s.starts_with(&header_line(&pid(1), "乙")) && s.matches(HEADER_PREFIX).count() == 1);
        assert!(!file_of(&dir, "甲").exists(), "舊檔併完就刪");
        assert!(file_of(&dir, "丙").exists(), "別位夥伴的檔不動");
        assert!(std::fs::read_to_string(file_of(&dir, "丙")).unwrap().contains("id=c1"));
    }

    #[test]
    fn 第一期以前沒有檔頭的舊檔_視窗名對上夥伴_id_就併過去() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        c.append("乙", &e(1_700_000_000_000, Dir::Received, "i1", "舊")).unwrap();
        assert!(file_of(c.dir(), "乙").exists());
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(3))]));
        c.append("乙", &e(1_700_000_100_000, Dir::Received, "i2", "新")).unwrap();
        let s = std::fs::read_to_string(pid_file_of(c.dir(), &pid(3))).unwrap();
        assert!(s.starts_with(&header_line(&pid(3), "乙")));
        assert_eq!(split_entries(&s).len(), 2);
        assert!(!file_of(c.dir(), "乙").exists());
    }

    #[test]
    fn 同一個視窗名換了夥伴_各有各的檔_舊夥伴的記錄原封不動() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        c.append("乙", &e(1, Dir::Received, "i1", "x")).unwrap();
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(9))]));
        c.append("乙", &e(2, Dir::Received, "i2", "y")).unwrap();
        let s1 = std::fs::read_to_string(pid_file_of(c.dir(), &pid(1))).unwrap();
        let s9 = std::fs::read_to_string(pid_file_of(c.dir(), &pid(9))).unwrap();
        assert!(s1.contains("id=i1") && !s1.contains("id=i2"));
        assert!(s9.contains("id=i2") && !s9.contains("id=i1"));
        assert!(s9.starts_with(&header_line(&pid(9), "乙")));
    }

    #[test]
    fn 沒有夥伴_id_不寫檔頭_後台暫時沒回照寫視窗名檔_回來後併回夥伴檔() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        c.append("乙", &e(1_700_000_000_000, Dir::Received, "i1", "x")).unwrap();
        assert!(!std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap().contains(HEADER_PREFIX));
        // 先有 ID：寫夥伴檔
        c.set_partners(BTreeMap::from([("丙".to_string(), pid(2))]));
        c.append("丙", &e(1_700_000_100_000, Dir::Received, "i2", "y")).unwrap();
        // 暫時沒對照（例如重啟後第一輪名單還沒回）：記錄照寫，不擋、不掉
        c.set_partners(BTreeMap::new());
        c.append("丙", &e(1_700_000_200_000, Dir::Received, "i3", "z")).unwrap();
        assert!(file_of(c.dir(), "丙").exists());
        // 對照回來：視窗名檔併回夥伴檔，依時間排好
        c.set_partners(BTreeMap::from([("丙".to_string(), pid(2))]));
        c.append("丙", &e(1_700_000_300_000, Dir::Received, "i4", "w")).unwrap();
        let s = std::fs::read_to_string(pid_file_of(c.dir(), &pid(2))).unwrap();
        let ids: Vec<&str> = split_entries(&s).iter().map(|c| c.split("id=").nth(1).unwrap().lines().next().unwrap()).collect();
        assert_eq!(ids, vec!["i2", "i3", "i4"], "{s}");
        assert!(!file_of(c.dir(), "丙").exists());
        assert!(s.starts_with(&header_line(&pid(2), "丙")));
    }

    #[test]
    fn 輪替時檔頭不會被當雜訊丟掉_封存檔不帶檔頭() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().join("handoff"));
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        for i in 0..205u32 {
            c.append("乙", &e(1_700_000_000_000, Dir::Received, &format!("id-{i:03}"), "x")).unwrap();
        }
        let live = std::fs::read_to_string(pid_file_of(c.dir(), &pid(1))).unwrap();
        assert!(live.starts_with(&header_line(&pid(1), "乙")));
        assert_eq!(live.matches(HEADER_PREFIX).count(), 1);
        let arch: Vec<_> = std::fs::read_dir(c.dir().join("archive")).unwrap().flatten().collect();
        assert_eq!(arch.len(), 1);
        assert!(!std::fs::read_to_string(arch[0].path()).unwrap().contains(HEADER_PREFIX));
        assert_eq!(split_entries(&live).len() + split_entries(&std::fs::read_to_string(arch[0].path()).unwrap()).len(), 205);
    }

    #[test]
    fn 時間格式() {
        assert_eq!(utc_fields(1_700_000_000_000), (2023, 11, 14, 22, 13, 20));
        assert_eq!(stamp(1_700_000_000_000).len(), 19);
    }
}
