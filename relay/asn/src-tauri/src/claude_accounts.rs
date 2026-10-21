//! 本機 Claude 帳號庫：把目前登入存成帳號、在帳號之間切換、刪除。
//! 全部只在本機搬檔，權杖不離開這台電腦、不進 log、不回給前端（前端只拿得到名稱、email、方案）。
//!
//! 位置（`home` 是家目錄，測試一律指到暫存資料夾）：
//! - 登入權杖：`<home>\.claude\.credentials.json`
//! - 帳號資訊：`<home>\.claude.json` 的頂層欄位 `oauthAccount`
//! - 帳號庫：`<home>\.asn\claude-accounts\<名稱>\{.credentials.json, account.json}`
//! - 切換前備份：`<home>\.asn\claude-backup\`（只留最近一次）
//!
//! 紅線：本模組的函式一律吃 `home` 參數；只有 `claude_home()` 會決定真實家目錄，測試不得呼叫它。
use crate::nowin::NoWindow;
use serde::Serialize;
use std::fmt;
use std::path::{Path, PathBuf};

const CRED: &str = ".credentials.json";
const FRAG: &str = "account.json";
const KEY: &str = "oauthAccount";

#[derive(Debug, PartialEq)]
pub enum AccErr {
    BadName,
    NotFound,
    Exists(String),
    NoLogin,
    CurrentUnsaved,
    Corrupt(&'static str),
    Io(String),
}

impl fmt::Display for AccErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AccErr::BadName => write!(f, "帳號名稱不合格：1～40 字，不可含 / \\ : * ? \" < > | 或控制字元，頭尾不可是空白或句點"),
            AccErr::NotFound => write!(f, "找不到這個帳號"),
            AccErr::Exists(n) => write!(f, "這個登入已經存成帳號「{n}」，或名稱已被別的帳號使用"),
            AccErr::NoLogin => write!(f, "這台電腦目前沒有 Claude 登入，請先登入再存成帳號"),
            AccErr::CurrentUnsaved => write!(f, "目前登入的帳號還沒存成帳號，切走會遺失；請先按「存成帳號」"),
            AccErr::Corrupt(what) => write!(f, "{what}"),
            AccErr::Io(e) => write!(f, "檔案操作失敗：{e}"),
        }
    }
}
impl From<std::io::Error> for AccErr {
    fn from(e: std::io::Error) -> Self {
        AccErr::Io(e.kind().to_string())
    }
}
type R<T> = Result<T, AccErr>;

/// 介面看得到的欄位（沒有任何權杖）
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct AccountInfo {
    pub name: String,
    pub email: String,
    pub plan: String,
    pub org: String,
    pub current: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SwitchOutcome {
    pub name: String,
    pub email: String,
    /// 固定提示：開著的 Claude 視窗還握著舊權杖
    pub notice: String,
}

/// 注入失敗點（測試用）：切換寫完 .credentials.json 之後、寫 .claude.json 之前失敗
#[derive(Clone, Copy, PartialEq)]
pub enum Fault {
    None,
    AfterCredentials,
}

/// 真實家目錄（可用 IRORI_ASN_CLAUDE_HOME 指到別處）；只有 Tauri 指令會呼叫，測試不碰
pub fn claude_home() -> PathBuf {
    std::env::var_os("IRORI_ASN_CLAUDE_HOME").map(PathBuf::from).unwrap_or_else(crate::identity::home_dir)
}

// ---------- 路徑與名稱 ----------
fn cred_path(home: &Path) -> PathBuf {
    home.join(".claude").join(CRED)
}
fn cj_path(home: &Path) -> PathBuf {
    home.join(".claude.json")
}
fn store_root(home: &Path) -> PathBuf {
    home.join(".asn").join("claude-accounts")
}
fn backup_dir(home: &Path) -> PathBuf {
    home.join(".asn").join("claude-backup")
}

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
pub fn valid_name(s: &str) -> bool {
    let n = s.chars().count();
    (1..=40).contains(&n)
        && s.trim() == s
        && !s.starts_with('.')
        && !s.ends_with('.')
        && !s.starts_with('_')
        && !s.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        && !RESERVED.contains(&s.split('.').next().unwrap_or("").to_lowercase().as_str())
}
fn account_dir(home: &Path, name: &str) -> R<PathBuf> {
    if !valid_name(name) {
        return Err(AccErr::BadName);
    }
    let root = store_root(home);
    let d = root.join(name);
    if d.parent() != Some(root.as_path()) {
        return Err(AccErr::BadName);
    }
    Ok(d)
}

// ---------- 檔案：原子寫入、權限 ----------
use crate::claude_json::write_atomic;

/// 資料夾權限只給本人。Windows 用 icacls 拿掉繼承、只授權目前使用者；其他系統用 0700。
/// 盡力而為（失敗只印固定字串，不影響功能；帳號庫本來就在家目錄底下，不是共享位置）。
fn restrict_dir(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(windows)]
    {
        if let Some(user) = std::env::var_os("USERNAME") {
            let who = format!("{}:(OI)(CI)F", user.to_string_lossy());
            let ok = std::process::Command::new("icacls").no_window()
                .arg(dir)
                .args(["/inheritance:r", "/grant:r"])
                .arg(who)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                eprintln!("claude 帳號庫：無法限縮資料夾權限（沿用家目錄的權限）");
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}
fn ensure_store(home: &Path) {
    let root = store_root(home);
    if !root.exists() {
        restrict_dir(&root);
    }
}

// ---------- .claude.json：只動 oauthAccount 這一段文字 ----------
fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && (b[i] as char).is_ascii_whitespace() {
        i += 1;
    }
    i
}
fn skip_string(b: &[u8], mut i: usize) -> Option<usize> {
    // b[i] == '"'；回傳結尾引號之後
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}
fn skip_value(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => skip_string(b, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < b.len() {
                match b[j] {
                    b'"' => {
                        j = skip_string(b, j)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth = depth.checked_sub(1)?;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']') && !(b[j] as char).is_ascii_whitespace() {
                j += 1;
            }
            Some(j)
        }
    }
}

struct Top {
    /// oauthAccount 值的文字範圍
    val: Option<(usize, usize)>,
    /// oauthAccount 鍵（含引號）起點
    key_at: Option<usize>,
    /// 第一個鍵的起點（偵測縮排用）
    first_key: Option<usize>,
    /// 最後一個 `}` 的位置
    close: usize,
    members: usize,
}
fn scan_top(text: &str) -> R<Top> {
    let b = text.as_bytes();
    let bad = || AccErr::Corrupt(".claude.json 不是合法的 JSON 物件，已停止（沒有改任何檔案）");
    let mut i = skip_ws(b, if text.starts_with('\u{feff}') { 3 } else { 0 });
    if b.get(i) != Some(&b'{') {
        return Err(bad());
    }
    i += 1;
    let mut t = Top { val: None, key_at: None, first_key: None, close: 0, members: 0 };
    loop {
        i = skip_ws(b, i);
        match b.get(i) {
            Some(b'}') => {
                t.close = i;
                return Ok(t);
            }
            Some(b'"') => {
                let ks = i;
                let ke = skip_string(b, i).ok_or_else(bad)?;
                i = skip_ws(b, ke);
                if b.get(i) != Some(&b':') {
                    return Err(bad());
                }
                i = skip_ws(b, i + 1);
                let ve = skip_value(b, i).ok_or_else(bad)?;
                t.first_key.get_or_insert(ks);
                t.members += 1;
                if &text[ks + 1..ke - 1] == KEY {
                    t.val = Some((i, ve));
                    t.key_at = Some(ks);
                }
                i = skip_ws(b, ve);
                if b.get(i) == Some(&b',') {
                    i += 1;
                }
            }
            _ => return Err(bad()),
        }
    }
}
fn line_indent(text: &str, at: usize) -> String {
    let ls = text[..at].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let pre = &text[ls..at];
    if pre.chars().all(|c| c == ' ' || c == '\t') {
        pre.to_string()
    } else {
        String::new()
    }
}

/// 取出 oauthAccount 的原文（連同換行與欄位順序），縮排拿掉鍵所在行的縮排
pub fn extract_fragment(cj: &str) -> R<Option<String>> {
    let t = scan_top(cj)?;
    let Some((s, e)) = t.val else { return Ok(None) };
    let ind = line_indent(cj, t.key_at.unwrap_or(s));
    let raw = &cj[s..e];
    let ded: Vec<String> = raw.split('\n').enumerate().map(|(n, l)| if n > 0 { l.strip_prefix(ind.as_str()).unwrap_or(l).to_string() } else { l.to_string() }).collect();
    Ok(Some(ded.join("\n")))
}

/// 只替換（或補上）oauthAccount；其餘文字一個字都不動
pub fn replace_fragment(cj: &str, frag: &str) -> R<String> {
    serde_json::from_str::<serde_json::Value>(frag).map_err(|_| AccErr::Corrupt("帳號庫裡的帳號資訊壞了"))?;
    let t = scan_top(cj)?;
    let reindent = |ind: &str| frag.split('\n').enumerate().map(|(n, l)| if n > 0 { format!("{ind}{l}") } else { l.to_string() }).collect::<Vec<_>>().join("\n");
    let out = if let Some((s, e)) = t.val {
        let ind = line_indent(cj, t.key_at.unwrap_or(s));
        format!("{}{}{}", &cj[..s], reindent(&ind), &cj[e..])
    } else {
        let before = cj[..t.close].trim_end().len();
        let multiline = t.first_key.map(|k| cj[..k].contains('\n')).unwrap_or(false);
        let ind = t.first_key.map(|k| line_indent(cj, k)).unwrap_or_else(|| "  ".into());
        let sep = if t.members > 0 { "," } else { "" };
        if multiline || t.members == 0 {
            format!("{}{}\n{}\"{}\": {}{}", &cj[..before], sep, ind, KEY, reindent(&ind), &cj[before..])
        } else {
            format!("{}{}\"{}\":{}{}", &cj[..before], sep, KEY, frag, &cj[before..])
        }
    };
    serde_json::from_str::<serde_json::Value>(out.trim_start_matches('\u{feff}')).map_err(|_| AccErr::Corrupt("替換後的 .claude.json 不合法，已停止"))?;
    Ok(out)
}

fn field(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn uuid_of_fragment(frag: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(frag).ok()?;
    v.get("accountUuid")?.as_str().filter(|s| !s.is_empty()).map(String::from)
}
/// 目前登入的 oauthAccount 原文與 accountUuid（檔案不存在、沒有這欄就是 None；檔案壞掉是錯誤）
fn current_fragment(home: &Path) -> R<Option<(String, String)>> {
    let Ok(text) = std::fs::read_to_string(cj_path(home)) else { return Ok(None) };
    Ok(extract_fragment(&text)?.and_then(|f| uuid_of_fragment(&f).map(|u| (f, u))))
}

// ---------- 帳號庫 ----------
struct Saved {
    name: String,
    uuid: String,
    frag: String,
}
fn saved_accounts(home: &Path) -> Vec<Saved> {
    let mut v = vec![];
    let Ok(rd) = std::fs::read_dir(store_root(home)) else { return v };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !valid_name(&name) {
            continue;
        }
        let Ok(frag) = std::fs::read_to_string(e.path().join(FRAG)) else { continue };
        if let Some(uuid) = uuid_of_fragment(&frag) {
            v.push(Saved { name, uuid, frag });
        }
    }
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

pub fn list(home: &Path) -> Vec<AccountInfo> {
    let cur = current_fragment(home).ok().flatten().map(|(_, u)| u);
    saved_accounts(home)
        .into_iter()
        .map(|s| {
            let a: serde_json::Value = serde_json::from_str(&s.frag).unwrap_or_default();
            let plan = ["subscriptionType", "organizationType", "billingType"].iter().map(|k| field(&a, k)).find(|p| !p.is_empty()).unwrap_or_else(|| {
                // 方案也可能只在權杖檔的 subscriptionType；只取這一個字串欄位，其餘不讀出來
                std::fs::read_to_string(store_root(home).join(&s.name).join(CRED))
                    .ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                    .and_then(|v| v.pointer("/claudeAiOauth/subscriptionType").and_then(|x| x.as_str().map(String::from)))
                    .unwrap_or_default()
            });
            AccountInfo { name: s.name, email: field(&a, "emailAddress"), plan, org: field(&a, "organizationName"), current: cur.as_deref() == Some(s.uuid.as_str()) }
        })
        .collect()
}

fn read_cred(home: &Path) -> R<Option<Vec<u8>>> {
    match std::fs::read(cred_path(home)) {
        Ok(b) => {
            serde_json::from_slice::<serde_json::Value>(&b).map_err(|_| AccErr::Corrupt("目前的 .credentials.json 不是合法的 JSON"))?;
            Ok(Some(b))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 把目前登入存成帳號
pub fn save_current(home: &Path, name: &str) -> R<AccountInfo> {
    let dir = account_dir(home, name)?;
    let cred = read_cred(home)?.ok_or(AccErr::NoLogin)?;
    let (frag, uuid) = current_fragment(home)?.ok_or(AccErr::NoLogin)?;
    for s in saved_accounts(home) {
        if (s.uuid == uuid && s.name != name) || (s.name == name && s.uuid != uuid) {
            return Err(AccErr::Exists(s.name));
        }
    }
    ensure_store(home);
    std::fs::create_dir_all(&dir)?;
    write_atomic(&dir.join(CRED), &cred)?;
    write_atomic(&dir.join(FRAG), frag.as_bytes())?;
    list(home).into_iter().find(|a| a.name == name).ok_or(AccErr::NotFound)
}

pub fn delete(home: &Path, name: &str) -> R<()> {
    let dir = account_dir(home, name)?;
    if !dir.is_dir() {
        return Err(AccErr::NotFound);
    }
    std::fs::remove_dir_all(dir)?;
    Ok(())
}

pub fn switch_to(home: &Path, name: &str) -> R<SwitchOutcome> {
    switch_impl(home, name, Fault::None)
}

pub fn switch_impl(home: &Path, name: &str, fault: Fault) -> R<SwitchOutcome> {
    let dir = account_dir(home, name)?;
    let tgt_cred = std::fs::read(dir.join(CRED)).map_err(|_| AccErr::NotFound)?;
    let tgt_frag = std::fs::read_to_string(dir.join(FRAG)).map_err(|_| AccErr::NotFound)?;
    serde_json::from_slice::<serde_json::Value>(&tgt_cred).map_err(|_| AccErr::Corrupt("帳號庫裡的權杖檔壞了"))?;
    uuid_of_fragment(&tgt_frag).ok_or(AccErr::Corrupt("帳號庫裡的帳號資訊壞了"))?;

    // 1. 先把目前的權杖回存到它所屬的帳號（權杖會自動換新，庫裡的舊副本可能已失效）
    let old_cred = read_cred(home)?;
    let old_cj = std::fs::read_to_string(cj_path(home)).ok();
    let cur = current_fragment(home)?;
    match (&old_cred, &cur) {
        (Some(c), Some((frag, uuid))) => {
            let owner = saved_accounts(home).into_iter().find(|s| &s.uuid == uuid).ok_or(AccErr::CurrentUnsaved)?;
            let od = account_dir(home, &owner.name)?;
            write_atomic(&od.join(CRED), c)?;
            write_atomic(&od.join(FRAG), frag.as_bytes())?;
        }
        (Some(_), None) => return Err(AccErr::CurrentUnsaved),
        _ => {}
    }

    // 2. 先算好新的 .claude.json（算不出來就在動手前停下）
    let new_cj = match &old_cj {
        Some(t) => replace_fragment(t, &tgt_frag)?,
        None => format!("{{\n  \"{KEY}\": {}\n}}\n", tgt_frag.split('\n').collect::<Vec<_>>().join("\n  ")),
    };

    // 3. 備份（記憶體一份、磁碟一份；磁碟那份在只給本人的資料夾）
    ensure_store(home);
    let bk = backup_dir(home);
    if !bk.exists() {
        restrict_dir(&bk);
    }
    for f in ["credentials.json", "claude.json"] {
        let _ = std::fs::remove_file(bk.join(f));
    }
    if let Some(c) = &old_cred {
        write_atomic(&bk.join("credentials.json"), c)?;
    }
    if let Some(t) = &old_cj {
        write_atomic(&bk.join("claude.json"), t.as_bytes())?;
    }

    // 4. 原子寫入；任何一步失敗就還原
    let apply = || -> std::io::Result<()> {
        write_atomic(&cred_path(home), &tgt_cred)?;
        if fault == Fault::AfterCredentials {
            return Err(std::io::Error::other("injected"));
        }
        write_atomic(&cj_path(home), new_cj.as_bytes())
    };
    if let Err(e) = apply() {
        let gone_ok = |r: std::io::Result<()>| match r {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
        let r1 = match &old_cred {
            Some(c) => write_atomic(&cred_path(home), c),
            None => gone_ok(std::fs::remove_file(cred_path(home))),
        };
        let r2 = match &old_cj {
            Some(t) => write_atomic(&cj_path(home), t.as_bytes()),
            None => gone_ok(std::fs::remove_file(cj_path(home))),
        };
        return Err(if r1.is_err() || r2.is_err() {
            AccErr::Corrupt("切換失敗，而且還原也沒成功；備份在 .asn\\claude-backup 資料夾")
        } else {
            AccErr::from(e)
        });
    }
    let a: serde_json::Value = serde_json::from_str(&tgt_frag).unwrap_or_default();
    Ok(SwitchOutcome { name: name.to_string(), email: field(&a, "emailAddress"), notice: "切換好了。開著的 Claude 視窗要關掉重開，才會用新帳號。".into() })
}

// ---------- Tauri 指令（前端只拿得到 AccountInfo） ----------
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub fn claude_accounts_list() -> Vec<AccountInfo> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    list(&claude_home())
}
#[tauri::command]
pub fn claude_account_save(name: String) -> Result<AccountInfo, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    save_current(&claude_home(), &name).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn claude_account_switch(name: String) -> Result<SwitchOutcome, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    switch_to(&claude_home(), &name).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn claude_account_delete(name: String) -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    delete(&claude_home(), &name).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // 全是假資料；家目錄一律是暫存資料夾
    fn cred(tag: &str) -> String {
        format!(r#"{{"claudeAiOauth":{{"accessToken":"FAKE-ACCESS-{tag}","refreshToken":"FAKE-REFRESH-{tag}","expiresAt":1,"subscriptionType":"max"}}}}"#)
    }
    fn cj(uuid: &str, email: &str) -> String {
        format!(
            "{{\n  \"numStartups\": 7,\n  \"theme\": \"dark\",\n  \"projects\": {{\"D:\\\\x\": {{\"a\": [1, 2,3]}}}},\n  \"oauthAccount\": {{\n    \"accountUuid\": \"{uuid}\",\n    \"emailAddress\": \"{email}\",\n    \"organizationName\": \"Org {uuid}\"\n  }},\n  \"tail\":   null\n}}\n"
        )
    }
    fn login(home: &Path, uuid: &str, email: &str, tag: &str) {
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(cred_path(home), cred(tag)).unwrap();
        fs::write(cj_path(home), cj(uuid, email)).unwrap();
    }
    fn setup() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn read(p: PathBuf) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn 存成帳號_庫裡有權杖與帳號資訊_清單沒有權杖() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        let info = save_current(h, "甲").unwrap();
        assert_eq!((info.name.as_str(), info.email.as_str(), info.plan.as_str(), info.current), ("甲", "a@x.test", "max", true));
        assert_eq!(read(store_root(h).join("甲").join(CRED)), cred("A1"));
        assert!(read(store_root(h).join("甲").join(FRAG)).contains("a@x.test"));
        let shown = serde_json::to_string(&list(h)).unwrap();
        assert!(!shown.contains("FAKE-"), "清單不可含權杖");
        // 同一個登入不能用另一個名字再存；同名不同人也不行
        assert_eq!(save_current(h, "乙"), Err(AccErr::Exists("甲".into())));
        login(h, "u-b", "b@x.test", "B1");
        assert_eq!(save_current(h, "甲"), Err(AccErr::Exists("甲".into())));
    }

    #[test]
    fn 沒登入就不能存() {
        let d = setup();
        assert_eq!(save_current(d.path(), "甲"), Err(AccErr::NoLogin));
        login(d.path(), "u-a", "a@x.test", "A1");
        fs::remove_file(cred_path(d.path())).unwrap();
        assert_eq!(save_current(d.path(), "甲"), Err(AccErr::NoLogin));
    }

    #[test]
    fn 切換來回_回存最新權杖_且_claude_json_其他欄位一個字不動() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h, "甲").unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h, "乙").unwrap();
        // 甲換新權杖（使用中自動更新）：切走前要回存
        login(h, "u-a", "a@x.test", "A2");
        let before = read(cj_path(h));
        let out = switch_to(h, "乙").unwrap();
        assert_eq!(out.email, "b@x.test");
        assert!(out.notice.contains("重開"));
        assert_eq!(read(cred_path(h)), cred("B1"));
        assert_eq!(read(store_root(h).join("甲").join(CRED)), cred("A2"), "甲的最新權杖要回存");
        let after = read(cj_path(h));
        assert!(after.contains("b@x.test") && !after.contains("a@x.test"));
        // 替換範圍之外逐字相同
        let (s, e) = scan_top(&before).unwrap().val.unwrap();
        let (s2, e2) = scan_top(&after).unwrap().val.unwrap();
        assert_eq!(&before[..s], &after[..s2]);
        assert_eq!(&before[e..], &after[e2..]);
        assert!(after.contains("\"projects\": {\"D:\\\\x\": {\"a\": [1, 2,3]}}") && after.contains("\"tail\":   null"));
        // 換回來：甲拿到 A2，乙的權杖回存
        switch_to(h, "甲").unwrap();
        assert_eq!(read(cred_path(h)), cred("A2"));
        assert_eq!(read(store_root(h).join("乙").join(CRED)), cred("B1"));
        assert_eq!(read(cj_path(h)), before, "來回之後 .claude.json 與原本完全相同");
        let cur: Vec<_> = list(h).into_iter().filter(|a| a.current).map(|a| a.name).collect();
        assert_eq!(cur, vec!["甲"]);
    }

    #[test]
    fn 目前登入還沒存成帳號_不准切走() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h, "甲").unwrap();
        login(h, "u-c", "c@x.test", "C1");
        let (c0, j0) = (read(cred_path(h)), read(cj_path(h)));
        assert_eq!(switch_to(h, "甲"), Err(AccErr::CurrentUnsaved));
        assert_eq!((read(cred_path(h)), read(cj_path(h))), (c0, j0), "什麼都沒動");
    }

    #[test]
    fn 寫到一半失敗會還原_兩個檔案都回到原樣() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h, "甲").unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h, "乙").unwrap();
        login(h, "u-a", "a@x.test", "A2");
        let (c0, j0) = (read(cred_path(h)), read(cj_path(h)));
        let r = switch_impl(h, "乙", Fault::AfterCredentials);
        assert!(matches!(r, Err(AccErr::Io(_))), "{r:?}");
        assert_eq!(read(cred_path(h)), c0);
        assert_eq!(read(cj_path(h)), j0);
        // 磁碟備份也在
        assert_eq!(read(backup_dir(h).join("credentials.json")), c0);
        assert!(fs::read_dir(h.join(".claude")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("asn-tmp")), "不留暫存檔");
    }

    #[test]
    fn claude_json_壞掉_動手前就停() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h, "甲").unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h, "乙").unwrap();
        fs::write(cj_path(h), "{壞掉").unwrap();
        let (c0, j0) = (read(cred_path(h)), read(cj_path(h)));
        assert!(switch_to(h, "甲").is_err());
        assert_eq!((read(cred_path(h)), read(cj_path(h))), (c0, j0));
    }

    #[test]
    fn 找不到帳號() {
        let d = setup();
        login(d.path(), "u-a", "a@x.test", "A1");
        assert_eq!(switch_to(d.path(), "沒有這個"), Err(AccErr::NotFound));
        assert_eq!(delete(d.path(), "沒有這個"), Err(AccErr::NotFound));
    }

    #[test]
    fn 名稱不合法_路徑穿越一律擋() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        for bad in ["", "..", ".", "../x", "..\\x", "a/b", "a\\b", "C:\\x", "con", "NUL.txt", " 甲", "甲 ", "甲.", ".hid", "_backup", "a:b", "a*", "x\ny", &"長".repeat(41)] {
            assert_eq!(save_current(h, bad), Err(AccErr::BadName), "{bad:?}");
            assert_eq!(switch_to(h, bad), Err(AccErr::BadName), "{bad:?}");
            assert_eq!(delete(h, bad), Err(AccErr::BadName), "{bad:?}");
        }
        assert!(!store_root(h).exists(), "擋下來的名稱不可建出任何資料夾");
        assert!(valid_name("工作機-甲 2"));
    }

    #[test]
    fn 刪除只刪那個帳號() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h, "甲").unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h, "乙").unwrap();
        delete(h, "甲").unwrap();
        assert_eq!(list(h).iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["乙"]);
        assert_eq!(read(cred_path(h)), cred("B1"), "不碰目前登入");
    }

    #[test]
    fn 缺欄位的_claude_json_補上帳號欄位_且其他不動() {
        let src = "{\n  \"a\": 1,\n  \"b\": [1,2]\n}\n";
        let out = replace_fragment(src, r#"{"accountUuid":"u"}"#).unwrap();
        assert_eq!(out, "{\n  \"a\": 1,\n  \"b\": [1,2],\n  \"oauthAccount\": {\"accountUuid\":\"u\"}\n}\n");
        assert_eq!(replace_fragment("{}", r#"{"accountUuid":"u"}"#).unwrap(), "{\n  \"oauthAccount\": {\"accountUuid\":\"u\"}}");
        let mini = replace_fragment(r#"{"a":1}"#, r#"{"x":2}"#).unwrap();
        assert_eq!(mini, r#"{"a":1,"oauthAccount":{"x":2}}"#);
        assert!(replace_fragment("[1]", "{}").is_err());
    }

    #[test]
    fn 字串裡的括號與逸出不會誤判() {
        let src = "{\"x\": \"} { \\\" oauthAccount\", \"oauthAccount\": {\"k\": \"}\"}, \"z\": 1}";
        let f = extract_fragment(src).unwrap().unwrap();
        assert_eq!(f, "{\"k\": \"}\"}");
        let out = replace_fragment(src, r#"{"k":"new"}"#).unwrap();
        assert_eq!(out, "{\"x\": \"} { \\\" oauthAccount\", \"oauthAccount\": {\"k\":\"new\"}, \"z\": 1}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_帳號庫資料夾不給其他人() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h, "甲").unwrap();
        let o = std::process::Command::new("icacls").no_window().arg(store_root(h)).output().unwrap();
        let t = String::from_utf8_lossy(&o.stdout).to_lowercase();
        assert!(!t.contains("everyone") && !t.contains("\\users:") && !t.contains("authenticated users"), "{t}");
        assert!(t.contains(&std::env::var("USERNAME").unwrap().to_lowercase()));
    }
}
