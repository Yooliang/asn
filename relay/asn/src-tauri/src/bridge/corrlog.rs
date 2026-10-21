//! 依視窗名的往來記錄（issue #107）：橋每轉交一封信、每收到視窗的一則回覆，就追加到
//! `%USERPROFILE%\.asn\handoff\<視窗名>.md`，同名的新 session 接手時可以先讀。檔案只在本機。
//! - 每筆記錄以「▌」開頭的標頭行起頭；內文裡以「▌」開頭的行會被縮排一格，所以數筆數不會被內文騙。
//! - 單筆內文超過 4 KB 截斷並加「（以下省略）」。
//! - 檔案超過 1 MB 或 200 筆：舊的搬到 `archive/<視窗名>-<yyyymmdd-HHMMSS>.md`，活檔只留最近的（最多 200 筆、不超過 1 MB）。
//! - 寫檔用 write_atomic；行程內用一把互斥鎖串起來（一台電腦只有一個橋）。
use std::collections::BTreeMap;
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

/// 附在每封轉交信最後的那一行（格式固定）
pub fn path_line(dir: &Path, name: &str) -> String {
    format!("你與收發室的往來記錄在：{}（接手前請先讀）", file_of(dir, name).display())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dir {
    /// 收發室轉交給這個視窗
    Received,
    /// 這個視窗的回覆／代寄（經橋轉出）
    Replied,
    /// 視窗自己用命令列回信或寄信，橋只看得到記號（沒有內文）
    Direct,
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
        CorrLog { dir, lock: Mutex::new(()), partners: Mutex::new(BTreeMap::new()) }
    }
    /// 更新視窗名對夥伴 ID 的對照（整份換掉）；下一次追加時寫進檔頭
    pub fn set_partners(&self, m: BTreeMap<String, String>) {
        *self.partners.lock().unwrap_or_else(|p| p.into_inner()) = m;
    }
    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }
    pub fn path_line(&self, name: &str) -> String {
        path_line(&self.dir, name)
    }

    /// 追加一筆。失敗回錯誤字串（呼叫端只記 log，不擋轉交）
    pub fn append(&self, name: &str, e: &Entry) -> Result<(), String> {
        if name.trim().is_empty() {
            return Ok(());
        }
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let file = file_of(&self.dir, name);
        let existing = std::fs::read_to_string(&file).unwrap_or_default();
        // 檔頭行先拆開：輪替只認記錄，不能把檔頭當雜訊丟掉；寫回時用最新的夥伴 ID，沒有就保留原本的
        let (old_head, rest) = split_header(&existing);
        let mut text = rest.trim_start_matches(['\r', '\n']).to_string();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&render(e));
        let text = self.rotate(name, text, e.ts_ms)?;
        let head = self.partners.lock().unwrap_or_else(|p| p.into_inner()).get(name).map(|id| header_line(id, name)).or_else(|| old_head.map(String::from));
        let text = match head {
            Some(h) => format!("{h}\n\n{text}"),
            None => text,
        };
        crate::write_atomic(&file, &text).map_err(|e| format!("存不了往來記錄 {}：{e}", file.display()))
    }

    /// 超過 1 MB 或 200 筆：舊的整段先寫進 archive，活檔只留最近的
    fn rotate(&self, name: &str, text: String, now_ms: u64) -> Result<String, String> {
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
        let arch = self.dir.join("archive").join(format!("{}-{}.md", safe_name(name), stamp_compact(now_ms)));
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
    fn 夥伴_id_寫在檔頭行_檔名仍是視窗名_每次追加只留一行檔頭() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().join("handoff"));
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        c.append("乙", &e(1_700_000_000_000, Dir::Received, "id-1", "你好")).unwrap();
        c.append("乙", &e(1_700_000_001_000, Dir::Replied, "id-1", "好")).unwrap();
        let s = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        assert!(s.starts_with(&format!("{HEADER_PREFIX}{}｜目前名字：乙\n\n{MARK} ", pid(1))), "{s}");
        assert_eq!(s.matches(HEADER_PREFIX).count(), 1);
        assert_eq!(split_entries(&s).len(), 2);
    }

    #[test]
    fn 同一個視窗名換了夥伴_檔頭跟著更新_記錄不掉() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        c.append("乙", &e(1, Dir::Received, "i1", "x")).unwrap();
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(9))]));
        c.append("乙", &e(2, Dir::Received, "i2", "y")).unwrap();
        let s = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        assert!(s.starts_with(&header_line(&pid(9), "乙")));
        assert_eq!(s.matches(HEADER_PREFIX).count(), 1);
        assert_eq!(split_entries(&s).len(), 2);
    }

    #[test]
    fn 沒有夥伴_id_不寫檔頭_已有檔頭的檔保持原樣_後端不支援時照舊() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().to_path_buf());
        c.append("乙", &e(1, Dir::Received, "i1", "x")).unwrap();
        assert!(!std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap().contains(HEADER_PREFIX));
        // 先有 ID 後來查不到（例如後端暫時沒回）：保留原檔頭
        c.set_partners(BTreeMap::from([("丙".to_string(), pid(2))]));
        c.append("丙", &e(2, Dir::Received, "i2", "y")).unwrap();
        c.set_partners(BTreeMap::new());
        c.append("丙", &e(3, Dir::Received, "i3", "z")).unwrap();
        let s = std::fs::read_to_string(file_of(c.dir(), "丙")).unwrap();
        assert!(s.starts_with(&header_line(&pid(2), "丙")));
        assert_eq!(split_entries(&s).len(), 2);
        // 既有的舊檔（沒有檔頭）之後拿到夥伴 ID：補上檔頭，原有記錄不掉
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(3))]));
        c.append("乙", &e(4, Dir::Received, "i4", "w")).unwrap();
        let s = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
        assert!(s.starts_with(&header_line(&pid(3), "乙")));
        assert_eq!(split_entries(&s).len(), 2);
    }

    #[test]
    fn 輪替時檔頭不會被當雜訊丟掉_封存檔不帶檔頭() {
        let t = tempfile::tempdir().unwrap();
        let c = CorrLog::new(t.path().join("handoff"));
        c.set_partners(BTreeMap::from([("乙".to_string(), pid(1))]));
        for i in 0..205u32 {
            c.append("乙", &e(1_700_000_000_000, Dir::Received, &format!("id-{i:03}"), "x")).unwrap();
        }
        let live = std::fs::read_to_string(file_of(c.dir(), "乙")).unwrap();
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
