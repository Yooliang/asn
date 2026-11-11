//! 狀態列額度的帳號身分（#1185）：同一台電腦同時開著好幾個登入不同帳號的 Claude 視窗時，狀態列輸入裡沒有帳號欄位，
//! 只看 `.claude.json` 會把 A 視窗的數字記到 B 底下。Claude Code 會在每個對話紀錄（transcript）裡寫一筆
//! `{"type":"session-owner","accountUuid":…,"organizationUuid":…}`，狀態列輸入又帶了這個視窗的 `transcript_path`，
//! 所以：讀那個檔尾端 256 KB 裡最後一筆 session-owner，就知道這個視窗是誰的。
//!
//! 安全：`transcript_path` 是外面送進來的字串，不能信。
//! 1. 只接受 `<設定資料夾>/projects/` 底下、副檔名 `.jsonl` 的檔案；路徑裡不能有 `..`。
//! 2. 第一道：從 projects 往下每一層都用 `symlink_metadata` 檢查，是符號連結或 junction（Windows 的 reparse point）就不收。
//! 3. 第二道（擋「檢查完到開檔之間被換成連結」）：先開檔，再用「已開啟的檔案」確認真正的位置——Windows 用
//!    `GetFinalPathNameByHandleW`（處理 `\\?\` 前綴）並確認不是 reparse point；Unix 比對檔案 handle 與路徑的 dev／inode。
//!    不一致一律當沒有身分。檢查與開檔之間的替換無法在單元測試裡穩定模擬，所以測試只驗「handle 與預期路徑不符時會被擋」，
//!    真正的擋法就是這一步。
//! 不讀任何憑證檔；只取 accountUuid 與 organizationUuid（長度與字元都驗過）。
use super::owner_store::Cache;
use serde_json::Value;
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

/// 只讀檔尾這麼多位元組
pub const TAIL_BYTES: u64 = 256 * 1024;
const MAX_PATH_CHARS: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Owner {
    pub account_uuid: String,
    pub org_uuid: Option<String>,
}

/// Claude 設定資料夾：環境變數 CLAUDE_CONFIG_DIR（非空）或 `<home>/.claude`
pub fn config_dir(home: &Path, env: Option<OsString>) -> PathBuf {
    match env {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.join(".claude"),
    }
}

/// 狀態列輸入裡的 transcript_path（太長、不是字串、空的都當沒有）
pub fn transcript_of(input: &str) -> Option<PathBuf> {
    let v: Value = serde_json::from_str(input).ok()?;
    let p = v.get("transcript_path")?.as_str()?;
    (!p.is_empty() && p.chars().count() <= MAX_PATH_CHARS && !p.contains('\0')).then(|| PathBuf::from(p))
}

/// 狀態列輸入有沒有帶 transcript_path 這個欄位（不管內容對不對）。舊版 Claude Code 完全不帶；
/// 帶了卻解不出身分，是「這個視窗的身分還不明」，不能退回用目前登入的帳號猜。
pub fn transcript_given(input: &str) -> bool {
    serde_json::from_str::<Value>(input).ok().is_some_and(|v| v.get("transcript_path").is_some_and(|p| !p.is_null()))
}

fn is_link(m: &std::fs::Metadata) -> bool {
    if m.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT：junction、掛載點、符號連結都有
        if m.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// 路徑去掉 root 前綴，回剩下的相對路徑；不在 root 底下回 None。
/// Windows 的檔案系統不分大小寫，transcript_path 的磁碟代號與資料夾名大小寫常和我們算出的 root 不同（例如 c: 和 C:），
/// 所以 Windows 逐層不分大小寫比對；安全不靠這裡的大小寫，靠後面開檔後的 handle 確認與 reparse point 檢查。Unix 分大小寫。
#[cfg(windows)]
fn strip_root(root: &Path, path: &Path) -> Option<PathBuf> {
    let low = |c: Component| c.as_os_str().to_string_lossy().to_lowercase();
    let (mut r, mut p) = (root.components(), path.components());
    loop {
        match (r.next(), p.next()) {
            (None, rest) => {
                let mut out = PathBuf::new();
                for c in rest.into_iter().chain(p) {
                    out.push(c.as_os_str());
                }
                return Some(out);
            }
            (Some(_), None) => return None,
            (Some(a), Some(b)) => {
                if low(a) != low(b) {
                    return None;
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn strip_root(root: &Path, path: &Path) -> Option<PathBuf> {
    path.strip_prefix(root).ok().map(Path::to_path_buf)
}

/// 第一道檢查：路徑要在 `<root>`（= 設定資料夾/projects）底下、副檔名 .jsonl、沒有 `..`，
/// 從 root 往下每一層都不是連結。回 (實際路徑, 相對 root 的部分)。
fn checked_path(root: &Path, path: &Path) -> Option<(PathBuf, PathBuf)> {
    let ext_ok = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("jsonl"));
    if !ext_ok {
        return None;
    }
    let rel = strip_root(root, path)?;
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let rm = std::fs::symlink_metadata(root).ok()?;
    if is_link(&rm) || !rm.is_dir() {
        return None;
    }
    let mut cur = root.to_path_buf();
    let n = rel.components().count();
    for (i, c) in rel.components().enumerate() {
        cur.push(c);
        let m = std::fs::symlink_metadata(&cur).ok()?;
        if is_link(&m) || (i + 1 == n && !m.is_file()) || (i + 1 < n && !m.is_dir()) {
            return None;
        }
    }
    Some((cur, rel.to_path_buf()))
}

#[cfg(windows)]
fn norm_win(s: &str) -> String {
    let t = s.strip_prefix(r"\\?\UNC\").map(|r| format!(r"\\{r}")).unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(s).to_string());
    t.replace('/', "\\").to_lowercase()
}

/// 第二道檢查：已開啟的檔案 `f` 真的就是 `expected` 那個位置的一般檔案（不是 reparse point／換過的檔）
#[cfg(windows)]
pub fn handle_matches(f: &File, expected: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;
    let Ok(m) = f.metadata() else { return false };
    if !m.is_file() || m.file_attributes() & 0x400 != 0 {
        return false;
    }
    let mut buf = vec![0u16; 2048];
    // dwflags 0 ＝ FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
    let n = unsafe { windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW(f.as_raw_handle() as _, buf.as_mut_ptr(), buf.len() as u32, 0) } as usize;
    if n == 0 || n >= buf.len() {
        return false;
    }
    let got = norm_win(&String::from_utf16_lossy(&buf[..n]));
    got == norm_win(&expected.to_string_lossy())
}

#[cfg(unix)]
pub fn handle_matches(f: &File, expected: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(a), Ok(b)) = (f.metadata(), std::fs::symlink_metadata(expected)) else { return false };
    a.is_file() && !b.file_type().is_symlink() && a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(any(unix, windows)))]
pub fn handle_matches(_f: &File, _expected: &Path) -> bool {
    false
}

/// 安全地開啟 transcript：兩道檢查都過才給檔案
pub fn safe_open(root: &Path, path: &Path) -> Option<File> {
    let (full, rel) = checked_path(root, path)?;
    let f = File::open(&full).ok()?;
    let expected = std::fs::canonicalize(root).ok()?.join(rel);
    handle_matches(&f, &expected).then_some(f)
}

fn valid_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

/// 從檔尾的位元組找最後一筆 session-owner。`partial_first`＝這段不是從檔頭開始，第一行可能被截斷要丟掉。
/// 最後一筆格式不對就當沒有（不退回更早的）。
pub fn parse_tail(bytes: &[u8], partial_first: bool) -> Option<Owner> {
    let mut lines = bytes.split(|&b| b == b'\n');
    if partial_first {
        lines.next();
    }
    let all: Vec<&[u8]> = lines.collect();
    for line in all.into_iter().rev() {
        if !line.windows(13).any(|w| w == b"session-owner") {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("session-owner") {
            continue;
        }
        let acc = v.get("accountUuid").and_then(Value::as_str).filter(|s| valid_id(s))?;
        let org = v.get("organizationUuid").and_then(Value::as_str).filter(|s| valid_id(s)).map(String::from);
        return Some(Owner { account_uuid: acc.to_string(), org_uuid: org });
    }
    None
}

/// 從檔尾的位元組找最後一筆 assistant 回應的時間戳（毫秒）。`partial_first` 同 [`parse_tail`]。
/// 沒有 assistant 行、或最後一筆的時間戳格式不對都是 None（不退回更早的）。
pub fn last_assistant_ms(bytes: &[u8], partial_first: bool) -> Option<i64> {
    let mut lines = bytes.split(|&b| b == b'\n');
    if partial_first {
        lines.next();
    }
    let all: Vec<&[u8]> = lines.collect();
    for line in all.into_iter().rev() {
        if !line.windows(9).any(|w| w == b"assistant") {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        return v.get("timestamp").and_then(Value::as_str).and_then(super::parse_iso_ms);
    }
    None
}

/// 讀檔尾（最多 TAIL_BYTES）；回 (位元組, 是不是從中間開始讀)
fn read_tail(f: &mut File) -> Option<(Vec<u8>, bool)> {
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    Some((buf, start > 0))
}

fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 這個視窗的帳號身分：路徑不安全、讀不到、沒有 session-owner 都是 None。
/// 同一個檔、大小與修改時間沒變就用上次的結果、不重讀（快取存在本機一個小檔，因為每次狀態列掛鉤都是新行程）；
/// 但每次都還是會先開檔、做 handle 確認，快取不能繞過安全檢查。
#[cfg_attr(not(test), allow(dead_code))]
pub fn resolve(home: &Path, cfg: &Path, input: &str) -> Option<Owner> {
    resolve_timed(home, cfg, input).map(|(o, _)| o)
}

/// 同 [`resolve`]，另回對話紀錄裡最後一筆 assistant 回應的時間戳（毫秒，額度的資料時間，#1266）；取不到時間戳是 None
pub fn resolve_timed(home: &Path, cfg: &Path, input: &str) -> Option<(Owner, Option<i64>)> {
    let path = transcript_of(input)?;
    let mut f = safe_open(&cfg.join("projects"), &path)?;
    let meta = f.metadata().ok()?;
    let (len, mt) = (meta.len(), mtime_ms(&meta));
    let key = path.to_string_lossy().into_owned();
    let mut cache = Cache::load(home);
    if let Some((owner, t)) = cache.get(&key, len, mt) {
        return owner.map(|o| (o, t));
    }
    let tail = read_tail(&mut f);
    let owner = tail.as_ref().and_then(|(b, p)| parse_tail(b, *p));
    let t = tail.as_ref().and_then(|(b, p)| last_assistant_ms(b, *p));
    cache.put(&key, len, mt, owner.clone(), t);
    cache.save(home);
    owner.map(|o| (o, t))
}

/// `.claude.json` 最大讀這麼多（真實的檔案可能有幾 MB，專案多的時候更大）；超過就當讀不到
const CJ_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 這個視窗自己的登入設定檔：設定資料夾裡有 `.claude.json` 就是它（`CLAUDE_CONFIG_DIR` 指到別處的視窗），沒有才是家目錄的
fn window_cj_path(home: &Path, cfg: &Path) -> PathBuf {
    let p = cfg.join(".claude.json");
    if std::fs::symlink_metadata(&p).is_ok() {
        p
    } else {
        home.join(".claude.json")
    }
}

/// 這個視窗現在登入的帳號 accountUuid（讀 `.claude.json` 的 oauthAccount.accountUuid，只取這一個欄位，不讀任何憑證）。
/// 讀不到（檔案不存在、是連結、太大、壞掉、沒登入、uuid 格式不對）都是 None。
/// 大小與修改時間都沒變就用上次的結果、不重讀（快取存本機一個小檔，因為每次狀態列掛鉤都是新行程）。
pub fn window_account_uuid(home: &Path, cfg: &Path) -> Option<String> {
    let path = window_cj_path(home, cfg);
    let m = std::fs::symlink_metadata(&path).ok()?;
    if is_link(&m) || !m.is_file() || m.len() > CJ_MAX_BYTES {
        return None;
    }
    let mut f = File::open(&path).ok()?;
    // 開檔後確認真的就是這個位置的一般檔案（擋「檢查完到開檔之間被換成連結」）
    if !handle_matches(&f, &std::fs::canonicalize(&path).ok()?) {
        return None;
    }
    let meta = f.metadata().ok()?;
    let (len, mt) = (meta.len(), mtime_ms(&meta));
    let key = path.to_string_lossy().into_owned();
    let mut cache = super::owner_store::AcctCache::load(home);
    if let Some(hit) = cache.get(&key, len, mt) {
        return hit;
    }
    let mut buf = Vec::new();
    (&mut f).take(CJ_MAX_BYTES + 1).read_to_end(&mut buf).ok()?;
    let uuid = if buf.len() as u64 > CJ_MAX_BYTES {
        None
    } else {
        String::from_utf8(buf).ok().and_then(|t| crate::claude_accounts::account_uuid_in_text(t.trim_start_matches('\u{feff}'))).filter(|u| valid_id(u))
    };
    cache.put(&key, len, mt, uuid.clone());
    cache.save(home);
    uuid
}

/// 測試用：把這個視窗自己的登入設定（設定資料夾 `<home>/.claude/.claude.json`）寫成這個 accountUuid。
/// 每次寫出來的長度都不同（快取以大小與修改時間判斷有沒有變，同樣長度的 uuid 在同一毫秒內換掉會讀到舊的）。
#[cfg(test)]
pub(crate) fn test_set_window_account(home: &Path, uuid: &str) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let pad = N.fetch_add(1, Ordering::Relaxed) % 4000;
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude").join(".claude.json"), serde_json::json!({ "oauthAccount": { "accountUuid": uuid }, "pad": "x".repeat(pad) }).to_string()).unwrap();
}

/// log 裡用的短代號：sha256 的前 6 個十六進位字元（原值不寫進 log）
pub fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(s.as_bytes());
    d.iter().take(3).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaa-1111-2222-3333-444444444444";
    const B: &str = "bbbbbbbb-1111-2222-3333-444444444444";
    const ORG: &str = "cccccccc-1111-2222-3333-444444444444";

    fn owner_line(uuid: &str) -> String {
        serde_json::json!({ "type": "session-owner", "accountUuid": uuid, "organizationUuid": ORG }).to_string()
    }

    /// 假的設定資料夾，裡面有 projects/p1/s.jsonl，內容是 lines；回 (暫存, 設定資料夾, 檔案路徑)
    fn setup(lines: &[String]) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().join("cfg");
        let dir = cfg.join("projects").join("p1");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        std::fs::write(&f, lines.join("\n") + "\n").unwrap();
        (t, cfg, f)
    }
    fn input(p: &Path) -> String {
        serde_json::json!({ "transcript_path": p.to_string_lossy() }).to_string()
    }

    #[test]
    fn 檔尾取最後一筆_session_owner() {
        let l = vec![owner_line(A), r#"{"type":"user","text":"hi"}"#.to_string(), owner_line(B), r#"{"type":"assistant"}"#.to_string()];
        let (_t, cfg, f) = setup(&l);
        let home = tempfile::tempdir().unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&f)), Some(Owner { account_uuid: B.into(), org_uuid: Some(ORG.into()) }));
    }

    #[test]
    fn 最後一筆_assistant_的時間戳_就是額度的資料時間() {
        let a = |t: &str| serde_json::json!({ "type": "assistant", "timestamp": t }).to_string();
        let u = serde_json::json!({ "type": "user", "timestamp": "2099-01-01T00:00:00.000Z" }).to_string();
        let text = [a("2026-11-09T12:00:00.100Z"), u.clone(), a("2026-11-09T12:30:00.500Z"), u.clone()].join("\n");
        assert_eq!(last_assistant_ms(text.as_bytes(), false), Some(crate::claude_quota::parse_iso_ms("2026-11-09T12:30:00.500Z").unwrap()), "取最後一筆 assistant，user 行不算");
        // 沒有 assistant 行、時間戳格式不對、沒有時間戳：都是 None（不退回更早的）
        assert_eq!(last_assistant_ms(u.as_bytes(), false), None);
        assert_eq!(last_assistant_ms([a("2026-11-09T12:00:00.100Z"), a("昨天")].join("\n").as_bytes(), false), None);
        assert_eq!(last_assistant_ms(serde_json::json!({ "type": "assistant" }).to_string().as_bytes(), false), None);
        // 只提到 assistant 這個字、type 不是 assistant
        assert_eq!(last_assistant_ms(serde_json::json!({ "type": "user", "text": "assistant", "timestamp": "2026-11-09T12:00:00Z" }).to_string().as_bytes(), false), None);
        // 從中間開始讀時，第一行可能被截斷要丟掉
        let cut = format!("ssistant\",\"timestamp\":\"2026-01-01T00:00:00Z\"}}\n{}", a("2026-11-09T13:00:00Z"));
        assert_eq!(last_assistant_ms(cut.as_bytes(), true), Some(crate::claude_quota::parse_iso_secs("2026-11-09T13:00:00Z").unwrap()));
    }

    #[test]
    fn resolve_timed_身分與資料時間一起回_改了檔就重讀() {
        let ts = |t: &str| serde_json::json!({ "type": "assistant", "timestamp": t }).to_string();
        let (_t, cfg, f) = setup(&[owner_line(A), ts("2026-11-09T12:00:00.000Z")]);
        let home = tempfile::tempdir().unwrap();
        let (o, t) = resolve_timed(home.path(), &cfg, &input(&f)).unwrap();
        assert_eq!((o.account_uuid.as_str(), t), (A, crate::claude_quota::parse_iso_ms("2026-11-09T12:00:00.000Z")));
        // 檔案變長（多一筆 assistant）：大小變了，快取不命中，取新的時間
        std::fs::write(&f, format!("{}\n{}\n{}\n", owner_line(A), ts("2026-11-09T12:00:00.000Z"), ts("2026-11-09T12:45:00.000Z"))).unwrap();
        let (_, t2) = resolve_timed(home.path(), &cfg, &input(&f)).unwrap();
        assert_eq!(t2, crate::claude_quota::parse_iso_ms("2026-11-09T12:45:00.000Z"));
        // 沒有 assistant：身分有、時間是 None
        std::fs::write(&f, format!("{}\n", owner_line(A))).unwrap();
        let (o3, t3) = resolve_timed(home.path(), &cfg, &input(&f)).unwrap();
        assert_eq!((o3.account_uuid.as_str(), t3), (A, None));
    }

    #[test]
    fn 沒有_session_owner_或格式不對_就是沒有身分() {
        assert_eq!(parse_tail(br#"{"type":"user"}"#, false), None);
        assert_eq!(parse_tail(b"", false), None);
        // 最後一筆壞掉：不退回更早的
        let bad = format!("{}\n{}", owner_line(A), r#"{"type":"session-owner","accountUuid":"../../x"}"#);
        assert_eq!(parse_tail(bad.as_bytes(), false), None);
        let long = format!(r#"{{"type":"session-owner","accountUuid":"{}"}}"#, "a".repeat(65));
        assert_eq!(parse_tail(long.as_bytes(), false), None);
        // type 不是 session-owner（只是文字裡提到）
        assert_eq!(parse_tail(br#"{"type":"user","text":"session-owner"}"#, false), None);
    }

    #[test]
    fn 只讀檔尾_被截斷的第一行丟掉() {
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().join("cfg");
        let dir = cfg.join("projects").join("p");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("big.jsonl");
        // 檔頭有 A 的身分，後面塞滿超過 256 KB 的資料：檔尾沒有身分，所以讀不到
        let filler = format!(r#"{{"type":"assistant","text":"{}"}}"#, "x".repeat(1000));
        let mut body = owner_line(A) + "\n";
        for _ in 0..400 {
            body.push_str(&filler);
            body.push('\n');
        }
        std::fs::write(&f, &body).unwrap();
        let home = tempfile::tempdir().unwrap();
        assert!(std::fs::metadata(&f).unwrap().len() > TAIL_BYTES);
        assert_eq!(resolve(home.path(), &cfg, &input(&f)), None, "超過檔尾範圍的身分不讀");
        // 檔尾有身分就讀得到（即使第一行被截斷）
        body.push_str(&owner_line(B));
        body.push('\n');
        std::fs::write(&f, &body).unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&f)).map(|o| o.account_uuid), Some(B.to_string()));
    }

    #[test]
    fn 路徑不在_projects_底下或副檔名不對或有點點_一律拒絕() {
        let (t, cfg, f) = setup(&[owner_line(A)]);
        let home = tempfile::tempdir().unwrap();
        let outside = t.path().join("other.jsonl");
        std::fs::write(&outside, owner_line(A)).unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&outside)), None, "不在 projects 底下");
        let txt = f.with_file_name("s.txt");
        std::fs::write(&txt, owner_line(A)).unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&txt)), None, "副檔名不是 .jsonl");
        let dotdot = cfg.join("projects").join("p1").join("..").join("..").join("..").join("other.jsonl");
        assert_eq!(resolve(home.path(), &cfg, &input(&dotdot)), None, "有 ..");
        assert_eq!(resolve(home.path(), &cfg, r#"{"transcript_path":""}"#), None);
        assert_eq!(resolve(home.path(), &cfg, r#"{"transcript_path":5}"#), None);
        assert_eq!(resolve(home.path(), &cfg, "{}"), None);
        assert!(resolve(home.path(), &cfg, &input(&f)).is_some(), "正常路徑照常");
    }

    #[cfg(unix)]
    #[test]
    fn 符號連結一律拒絕_檔案本身與中間資料夾都是() {
        let (t, cfg, f) = setup(&[owner_line(A)]);
        let home = tempfile::tempdir().unwrap();
        let real = t.path().join("real.jsonl");
        std::fs::write(&real, owner_line(B)).unwrap();
        let link = cfg.join("projects").join("p1").join("l.jsonl");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&link)), None, "檔案是連結");
        let dlink = cfg.join("projects").join("pl");
        std::os::unix::fs::symlink(f.parent().unwrap(), &dlink).unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&dlink.join("s.jsonl"))), None, "中間資料夾是連結");
    }

    #[test]
    fn 已開啟的檔案與預期位置不符就擋掉_檢查完到開檔之間被換掉靠這一步() {
        // 檢查完到開檔之間被換成連結／別的檔，在單元測試裡無法穩定模擬；這裡驗證擋法本身：
        // 開著的檔案 handle 跟「預期位置」對不上時一定被擋，對得上才放行。
        let (t, _cfg, f) = setup(&[owner_line(A)]);
        let other = t.path().join("other.jsonl");
        std::fs::write(&other, owner_line(B)).unwrap();
        let h = File::open(&f).unwrap();
        let canon = std::fs::canonicalize(&f).unwrap();
        assert!(handle_matches(&h, &canon), "位置相符");
        assert!(!handle_matches(&h, &std::fs::canonicalize(&other).unwrap()), "位置不符（檔案被換成別的）");
        assert!(!handle_matches(&h, &t.path().join("missing.jsonl")), "預期位置不存在");
    }

    #[cfg(windows)]
    #[test]
    fn windows_大小寫不同但實際是同一個位置的路徑要收() {
        let (_t, cfg, f) = setup(&[owner_line(A)]);
        let home = tempfile::tempdir().unwrap();
        let upper = PathBuf::from(f.to_string_lossy().to_uppercase());
        assert_ne!(upper, f);
        assert_eq!(resolve(home.path(), &cfg, &input(&upper)).map(|o| o.account_uuid), Some(A.to_string()));
        // 磁碟代號大小寫相反
        let s = f.to_string_lossy().to_string();
        let flipped = if s.as_bytes()[0].is_ascii_lowercase() { s[..1].to_uppercase() + &s[1..] } else { s[..1].to_lowercase() + &s[1..] };
        assert_eq!(resolve(home.path(), &cfg, &input(Path::new(&flipped))).map(|o| o.account_uuid), Some(A.to_string()));
        // 大小寫放寬不等於放行別的位置
        let other = cfg.parent().unwrap().join("o.jsonl");
        std::fs::write(&other, owner_line(A)).unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&PathBuf::from(other.to_string_lossy().to_uppercase()))), None);
    }

    #[cfg(unix)]
    #[test]
    fn unix_大小寫不同的路徑不收() {
        let (_t, cfg, f) = setup(&[owner_line(A)]);
        let home = tempfile::tempdir().unwrap();
        let wrong = PathBuf::from(f.to_string_lossy().replace("projects", "PROJECTS"));
        assert_eq!(resolve(home.path(), &cfg, &input(&wrong)), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_前綴與大小寫不影響比對() {
        assert_eq!(norm_win(r"\\?\C:\Users\X\a.jsonl"), norm_win(r"c:/users/x/a.jsonl"));
        assert_eq!(norm_win(r"\\?\UNC\srv\share\a"), norm_win(r"\\srv\share\a"));
    }

    #[test]
    fn 快取_大小與修改時間沒變才命中_也存沒有身分的結果() {
        let h = tempfile::tempdir().unwrap();
        let mut c = Cache::load(h.path());
        assert_eq!(c.get("k", 10, 5), None);
        c.put("k", 10, 5, Some(Owner { account_uuid: A.into(), org_uuid: None }), Some(1234));
        c.put("n", 3, 3, None, None);
        c.save(h.path());
        let c = Cache::load(h.path());
        assert_eq!(c.get("k", 10, 5), Some((Some(Owner { account_uuid: A.into(), org_uuid: None }), Some(1234))), "身分與最後一筆 assistant 的時間一起快取");
        assert_eq!(c.get("k", 11, 5), None, "大小變了");
        assert_eq!(c.get("k", 10, 6), None, "修改時間變了");
        assert_eq!(c.get("n", 3, 3), Some((None, None)), "沒有身分也快取");
        let mut c = c;
        for i in 0..100 {
            c.put(&format!("f{i:03}"), 1, 1, None, None);
        }
        assert!(c.len() <= 32);
    }

    #[test]
    fn 快取命中時不重讀檔_但仍要過安全檢查() {
        let (_t, cfg, f) = setup(&[owner_line(A)]);
        let home = tempfile::tempdir().unwrap();
        assert_eq!(resolve(home.path(), &cfg, &input(&f)).map(|o| o.account_uuid), Some(A.to_string()));
        // 把快取內容改成 B（模擬「沒重讀」）：同一個檔、大小與時間沒變，就回快取的
        let key = f.to_string_lossy().into_owned();
        let meta = std::fs::metadata(&f).unwrap();
        let mut c = Cache::load(home.path());
        c.put(&key, meta.len(), mtime_ms(&meta), Some(Owner { account_uuid: B.into(), org_uuid: None }), None);
        c.save(home.path());
        assert_eq!(resolve(home.path(), &cfg, &input(&f)).map(|o| o.account_uuid), Some(B.to_string()), "命中就不重讀");
        // 路徑不安全時，即使有快取也不給
        let outside = cfg.parent().unwrap().join("o.jsonl");
        std::fs::write(&outside, owner_line(A)).unwrap();
        let om = std::fs::metadata(&outside).unwrap();
        let mut c = Cache::load(home.path());
        c.put(&outside.to_string_lossy(), om.len(), mtime_ms(&om), Some(Owner { account_uuid: A.into(), org_uuid: None }), None);
        c.save(home.path());
        assert_eq!(resolve(home.path(), &cfg, &input(&outside)), None);
    }

    #[test]
    fn 設定資料夾_環境變數優先_空的不算() {
        let h = Path::new("/h");
        assert_eq!(config_dir(h, Some("/x/c".into())), PathBuf::from("/x/c"));
        assert_eq!(config_dir(h, Some("".into())), h.join(".claude"));
        assert_eq!(config_dir(h, None), h.join(".claude"));
    }
}
