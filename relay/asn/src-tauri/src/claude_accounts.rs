//! 本機 Claude 帳號庫：把目前登入加入帳號庫、在帳號之間切換、刪除。
//! 全部只在本機搬檔，權杖不離開這台電腦、不進 log、不回給前端（前端只拿得到 email、方案）。
//! 帳號以 email 識別，不再讓使用者取名字。
//!
//! 位置（`home` 是家目錄，測試一律指到暫存資料夾）：
//! - 登入權杖：`<home>\.claude\.credentials.json`
//! - 帳號資訊：`<home>\.claude.json` 的頂層欄位 `oauthAccount`
//! - 帳號庫：`<home>\.asn\claude-accounts\<email 正規化>\{.credentials.json, account.json}`
//!   資料夾名由 email 轉小寫、不安全字元改成 `_xx`（見 `email_dir`）；舊版以名字存的資料夾，
//!   第一次讀到時自動改名成新格式（`migrate_legacy`）。
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
/// 切換到「存的登入不完整」的帳號時回給使用者的話（本機與遠端切換同一句）
pub const INCOMPLETE_LOGIN_MSG: &str = "這個帳號存的登入不完整，請重新登入一次再加入";

/// 權杖檔裡有沒有非空的 `claudeAiOauth.refreshToken`。只回布林：權杖內容不複製、不回傳、不進 log。
/// 不是 JSON、缺欄位、不是字串、空字串（含只有空白）都算沒有。
pub fn has_refresh_token(cred: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(cred)
        .ok()
        .and_then(|v| v.pointer("/claudeAiOauth/refreshToken").and_then(|x| x.as_str()).map(|t| !t.trim().is_empty()))
        .unwrap_or(false)
}

#[derive(Debug, PartialEq)]
pub enum AccErr {
    BadEmail,
    NotFound,
    NoLogin,
    CurrentUnsaved,
    /// 帳號庫裡存的權杖沒有 refreshToken（缺欄位或空字串）：切過去馬上會被撤銷，整台的 Claude 都失效
    IncompleteLogin,
    Corrupt(&'static str),
    Io(String),
}

impl fmt::Display for AccErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AccErr::BadEmail => write!(f, "email 格式不對"),
            AccErr::NotFound => write!(f, "找不到這個帳號"),
            AccErr::NoLogin => write!(f, "這台電腦目前沒有 Claude 登入，請先登入再加入帳號"),
            AccErr::CurrentUnsaved => write!(f, "目前登入的帳號還沒加入帳號庫，切走會遺失；請等 ASN 自動加入（約一分鐘）後再切換"),
            AccErr::IncompleteLogin => write!(f, "{INCOMPLETE_LOGIN_MSG}"),
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
    pub email: String,
    pub plan: String,
    pub org: String,
    pub current: bool,
    /// 已經在帳號庫裡（`list` 一律 true；`current_login` 才可能是 false）
    pub saved: bool,
    /// 存的登入不完整（權杖檔沒有 refreshToken）：不能切換過去。只是布林，不含任何權杖內容
    pub login_incomplete: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SwitchOutcome {
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

/// 真實家目錄（可用 ASN_CLAUDE_HOME（舊名 IRORI_ASN_CLAUDE_HOME） 指到別處）；只有 Tauri 指令會呼叫，測試不碰
pub fn claude_home() -> PathBuf {
    crate::envc::get_os("ASN_CLAUDE_HOME").map(PathBuf::from).unwrap_or_else(crate::identity::home_dir)
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

/// email 正規化：去頭尾空白、轉小寫；必須剛好一個 `@`、兩邊都有字、3～120 字，
/// 不含空白、控制字元或檔名禁用字元。不合格回 None。
pub fn normalize_email(s: &str) -> Option<String> {
    let t = s.trim().to_lowercase();
    let n = t.chars().count();
    let (user, host) = t.split_once('@')?;
    let ok = (3..=120).contains(&n)
        && !user.is_empty()
        && !host.is_empty()
        && !host.contains('@')
        && !t.chars().any(|c| c.is_control() || c.is_whitespace() || "/\\:*?\"<>|".contains(c));
    ok.then_some(t)
}
/// 帳號庫資料夾名：英數與 `@ . - +` 照留，其餘（含 `_` 本身、頭尾的句點）改成 `_` 加 UTF-8 十六進位，
/// 所以不同 email 一定對到不同資料夾，也不可能跳出帳號庫。
pub fn email_dir_name(email: &str) -> String {
    let n = email.chars().count();
    let mut out = String::new();
    for (i, c) in email.chars().enumerate() {
        let edge_dot = c == '.' && (i == 0 || i + 1 == n);
        if (c.is_ascii_alphanumeric() || "@-+".contains(c) || c == '.') && !edge_dot {
            out.push(c);
        } else {
            let mut b = [0u8; 4];
            for x in c.encode_utf8(&mut b).bytes() {
                out.push_str(&format!("_{x:02x}"));
            }
        }
    }
    out
}
fn account_dir(home: &Path, email: &str) -> R<PathBuf> {
    let e = normalize_email(email).ok_or(AccErr::BadEmail)?;
    let root = store_root(home);
    let d = root.join(email_dir_name(&e));
    if d.parent() != Some(root.as_path()) {
        return Err(AccErr::BadEmail);
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
                elog!("claude 帳號庫：無法限縮資料夾權限（沿用家目錄的權限）");
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
    /// 正規化後的 email（帳號的識別）
    email: String,
    dir: PathBuf,
    uuid: String,
    frag: String,
}
fn email_of_fragment(frag: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(frag).ok()?;
    normalize_email(v.get("emailAddress")?.as_str()?)
}

/// 舊版以「名字」當資料夾名：讀到就自動改名成 email 資料夾。目標已存在就不動（列表時會去重）。失敗略過，下次再試。
pub fn migrate_legacy(home: &Path) {
    let root = store_root(home);
    let Ok(rd) = std::fs::read_dir(&root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(frag) = std::fs::read_to_string(e.path().join(FRAG)) else { continue };
        let Some(email) = email_of_fragment(&frag) else { continue };
        let want = email_dir_name(&email);
        if name != want && !root.join(&want).exists() {
            let _ = std::fs::rename(e.path(), root.join(&want));
        }
    }
}

fn saved_accounts(home: &Path) -> Vec<Saved> {
    migrate_legacy(home);
    let mut v: Vec<Saved> = vec![];
    let Ok(rd) = std::fs::read_dir(store_root(home)) else { return v };
    for e in rd.flatten() {
        let Ok(frag) = std::fs::read_to_string(e.path().join(FRAG)) else { continue };
        let (Some(uuid), Some(email)) = (uuid_of_fragment(&frag), email_of_fragment(&frag)) else { continue };
        // 同一個 email 只留資料夾名正確的那份（舊名字資料夾沒搬成時，不重複列出）
        let canonical = e.file_name().to_string_lossy() == email_dir_name(&email).as_str();
        if let Some(i) = v.iter().position(|s| s.email == email) {
            if canonical {
                v[i] = Saved { email, dir: e.path(), uuid, frag };
            }
            continue;
        }
        v.push(Saved { email, dir: e.path(), uuid, frag });
    }
    v.sort_by(|a, b| a.email.cmp(&b.email));
    v
}

/// 目前登入的 email（只看 .claude.json 裡的 oauthAccount.emailAddress，不碰任何權杖檔）；沒登入回 None
pub fn current_email(home: &Path) -> Option<String> {
    let (frag, _) = current_fragment(home).ok().flatten()?;
    email_of_fragment(&frag)
}

/// 目前登入的 email 與方案（方案只取權杖檔的 subscriptionType 這一個字串欄位）；沒登入回 None
pub fn current_login(home: &Path) -> Option<AccountInfo> {
    let (frag, uuid) = current_fragment(home).ok().flatten()?;
    let email = email_of_fragment(&frag)?;
    let saved = saved_accounts(home).into_iter().any(|s| s.uuid == uuid || s.email == email);
    let mut info = info_of(&frag, &email, &cred_path(home), true);
    info.saved = saved;
    Some(info)
}

fn info_of(frag: &str, email: &str, cred_file: &Path, current: bool) -> AccountInfo {
    let a: serde_json::Value = serde_json::from_str(frag).unwrap_or_default();
    let plan = ["subscriptionType", "organizationType", "billingType"].iter().map(|k| field(&a, k)).find(|p| !p.is_empty()).unwrap_or_else(|| {
        // 方案也可能只在權杖檔的 subscriptionType；只取這一個字串欄位，其餘不讀出來
        std::fs::read_to_string(cred_file)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.pointer("/claudeAiOauth/subscriptionType").and_then(|x| x.as_str().map(String::from)))
            .unwrap_or_default()
    });
    let login_incomplete = !std::fs::read(cred_file).map(|b| has_refresh_token(&b)).unwrap_or(false);
    AccountInfo { email: email.to_string(), plan, org: field(&a, "organizationName"), current, saved: true, login_incomplete }
}

pub fn list(home: &Path) -> Vec<AccountInfo> {
    let cur = current_fragment(home).ok().flatten();
    saved_accounts(home)
        .into_iter()
        .map(|s| {
            let is_cur = cur.as_ref().is_some_and(|(f, u)| *u == s.uuid || email_of_fragment(f).as_deref() == Some(s.email.as_str()));
            info_of(&s.frag, &s.email, &s.dir.join(CRED), is_cur)
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

/// 把目前登入加入帳號庫（以 email 識別；已經在庫裡就用最新的權杖更新那一份）
pub fn save_current(home: &Path) -> R<AccountInfo> {
    let cred = read_cred(home)?.ok_or(AccErr::NoLogin)?;
    let (frag, _) = current_fragment(home)?.ok_or(AccErr::NoLogin)?;
    let email = email_of_fragment(&frag).ok_or(AccErr::Corrupt("目前登入的帳號資訊裡沒有 email，無法加入"))?;
    let dir = account_dir(home, &email)?;
    ensure_store(home);
    migrate_legacy(home);
    std::fs::create_dir_all(&dir)?;
    write_atomic(&dir.join(CRED), &cred)?;
    write_atomic(&dir.join(FRAG), frag.as_bytes())?;
    list(home).into_iter().find(|a| a.email == email).ok_or(AccErr::NotFound)
}

pub fn delete(home: &Path, email: &str) -> R<()> {
    let e = normalize_email(email).ok_or(AccErr::BadEmail)?;
    migrate_legacy(home);
    let dir = account_dir(home, &e)?;
    if !dir.is_dir() {
        return Err(AccErr::NotFound);
    }
    std::fs::remove_dir_all(dir)?;
    Ok(())
}

pub fn switch_to(home: &Path, email: &str) -> R<SwitchOutcome> {
    switch_impl(home, email, Fault::None)
}

pub fn switch_impl(home: &Path, email: &str, fault: Fault) -> R<SwitchOutcome> {
    let email = normalize_email(email).ok_or(AccErr::BadEmail)?;
    migrate_legacy(home);
    let dir = account_dir(home, &email)?;
    let tgt_cred = std::fs::read(dir.join(CRED)).map_err(|_| AccErr::NotFound)?;
    let tgt_frag = std::fs::read_to_string(dir.join(FRAG)).map_err(|_| AccErr::NotFound)?;
    serde_json::from_slice::<serde_json::Value>(&tgt_cred).map_err(|_| AccErr::Corrupt("帳號庫裡的權杖檔壞了"))?;
    uuid_of_fragment(&tgt_frag).ok_or(AccErr::Corrupt("帳號庫裡的帳號資訊壞了"))?;
    // 0. 存的登入沒有 refreshToken 就在動到任何檔案（回存、備份、換權杖）之前拒絕：
    //    切過去會立刻被撤銷，整台的 Claude 都會失效（10-30 工作機事故）。本機「切換」與遠端切換都經過這裡。
    if !has_refresh_token(&tgt_cred) {
        return Err(AccErr::IncompleteLogin);
    }

    // 1. 先把目前的權杖回存到它所屬的帳號（權杖會自動換新，庫裡的舊副本可能已失效）
    let old_cred = read_cred(home)?;
    let old_cj = std::fs::read_to_string(cj_path(home)).ok();
    let cur = current_fragment(home)?;
    match (&old_cred, &cur) {
        (Some(c), Some((frag, uuid))) => {
            let cur_email = email_of_fragment(frag);
            let owner = saved_accounts(home).into_iter().find(|s| &s.uuid == uuid || Some(&s.email) == cur_email.as_ref()).ok_or(AccErr::CurrentUnsaved)?;
            write_atomic(&owner.dir.join(CRED), c)?;
            write_atomic(&owner.dir.join(FRAG), frag.as_bytes())?;
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
    Ok(SwitchOutcome { email, notice: "切換好了，開著的 Claude 視窗不用重開。".into() })
}

/// 還原到最近一次切換之前：把切換前的備份（`.asn\\claude-backup`，只留最近一次）寫回去。
/// 沒有備份就什麼都不動。只給本機畫面的「還原」按鈕用，遠端指令碰不到這個入口。
pub fn undo_last_switch(home: &Path) -> R<String> {
    let bk = backup_dir(home);
    let cred = std::fs::read(bk.join("credentials.json")).map_err(|_| AccErr::Corrupt("沒有可以還原的備份（只有切換過才有）"))?;
    write_atomic(&cred_path(home), &cred)?;
    if let Ok(t) = std::fs::read(bk.join("claude.json")) {
        write_atomic(&cj_path(home), &t)?;
    }
    Ok("已還原到切換前的帳號，開著的 Claude 視窗不用重開。".into())
}

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ---------- 自動加入／回存（背景每分鐘一次） ----------
/// 自動同步的結果（前端只拿得到 email，沒有權杖）
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(tag = "kind", content = "email", rename_all = "lowercase")]
pub enum AutoOutcome {
    /// 沒有登入、已是最新、或讀不全：什麼都沒做
    Nothing,
    /// 目前登入的帳號原本不在帳號庫，已加入
    Added(String),
    /// 已在帳號庫，但權杖自動換新過：已回存最新一份
    Updated(String),
}

/// 自動加入固定開啟（原本看 asn-me.json 的 `autoAddClaude`，現在不再有開關，寫什麼都當開）
pub fn auto_enabled_from_saved(text: &str) -> bool {
    let _ = text;   // 固定開啟：舊存檔裡寫 false 也一律忽略（小良哥 10-24）
    true
}

/// 做一次：目前登入不在庫就加入；在庫但權杖檔（或帳號資訊）和庫裡不同就回存；沒登入什麼都不動。
/// 呼叫端要自己持有 `LOCK`（見 `auto_tick`），避免和切換同時寫檔。只比對與寫入檔案，權杖不進 log。
pub fn auto_sync(home: &Path) -> R<AutoOutcome> {
    let Some(cred) = read_cred(home)? else { return Ok(AutoOutcome::Nothing) };
    let Some((frag, uuid)) = current_fragment(home)? else { return Ok(AutoOutcome::Nothing) };
    let Some(email) = email_of_fragment(&frag) else { return Ok(AutoOutcome::Nothing) };
    let owner = saved_accounts(home).into_iter().find(|s| s.uuid == uuid || s.email == email);
    let Some(owner) = owner else {
        save_current(home)?;
        return Ok(AutoOutcome::Added(email));
    };
    let same_cred = std::fs::read(owner.dir.join(CRED)).map(|b| b == cred).unwrap_or(false);
    let same_frag = owner.frag == frag;
    if same_cred && same_frag {
        return Ok(AutoOutcome::Nothing);
    }
    if !same_cred {
        write_atomic(&owner.dir.join(CRED), &cred)?;
    }
    if !same_frag {
        write_atomic(&owner.dir.join(FRAG), frag.as_bytes())?;
    }
    Ok(AutoOutcome::Updated(owner.email))
}

/// 拿著 `lock` 做一次 `auto_sync`（背景工作傳進和切換、加入、刪除共用的那把 `LOCK`）
pub fn auto_tick(lock: &std::sync::Mutex<()>, home: &Path) -> R<AutoOutcome> {
    let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
    auto_sync(home)
}

/// 防「登入到一半」誤存：Claude 登入新帳號時權杖檔和 .claude.json 不是同時寫好的，
/// 只在連續兩次檢查看到完全相同的內容時才動作（指紋只留在記憶體）。
#[derive(Default)]
pub struct Steady(Option<u64>);
impl Steady {
    pub fn settled(&mut self, home: &Path) -> bool {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        std::fs::read(cred_path(home)).ok().hash(&mut h);
        std::fs::read(cj_path(home)).ok().hash(&mut h);
        let now = Some(h.finish());
        let ok = self.0 == now;
        self.0 = now;
        ok
    }
}

/// 背景工作：先等 `first`，之後每 `every` 看一次 asn-me.json 的開關，開著就同步一次；有動作就叫 `on_event`
pub async fn auto_loop(data_dir: PathBuf, first: std::time::Duration, every: std::time::Duration, on_event: impl Fn(&AutoOutcome) + Send + 'static) {
    tokio::time::sleep(first).await;
    let mut steady = Steady::default();
    loop {
        let dd = data_dir.clone();
        let mut steady_in = std::mem::take(&mut steady);
        let r = tokio::task::spawn_blocking(move || {
            let on = std::fs::read_to_string(dd.join("asn-me.json")).map(|t| auto_enabled_from_saved(&t)).unwrap_or(true);
            if !on {
                return (AutoOutcome::Nothing, steady_in);
            }
            let home = claude_home();
            let out = if steady_in.settled(&home) { auto_tick(&LOCK, &home).unwrap_or(AutoOutcome::Nothing) } else { AutoOutcome::Nothing };
            (out, steady_in)
        })
        .await;
        if let Ok((out, st)) = r {
            steady = st;
            match &out {
                AutoOutcome::Added(e) => elog!("已自動加入 {e}"),
                AutoOutcome::Updated(e) => elog!("已更新 {e} 的登入憑證"),
                AutoOutcome::Nothing => {}
            }
            if out != AutoOutcome::Nothing {
                on_event(&out);
            }
        }
        tokio::time::sleep(every).await;
    }
}

// ---------- Tauri 指令（前端只拿得到 AccountInfo） ----------

#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_accounts_list() -> Vec<AccountInfo> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    list(&claude_home())
}
#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_account_current() -> Option<AccountInfo> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    current_login(&claude_home())
}
#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_account_save() -> Result<AccountInfo, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    save_current(&claude_home()).map_err(|e| e.to_string())
}
#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_account_switch(email: String) -> Result<SwitchOutcome, String> {
    local_switch(&email)
}
#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_account_delete(email: String) -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    delete(&claude_home(), &email).map_err(|e| e.to_string())
}
#[cfg_attr(feature = "gui", tauri::command)]
pub fn claude_account_undo() -> Result<String, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    undo_last_switch(&claude_home()).map_err(|e| e.to_string())
}
/// 本機切換（Tauri 指令與遠端切換共用同一個入口，同一把鎖）
pub fn local_switch(email: &str) -> Result<SwitchOutcome, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    switch_to(&claude_home(), email).map_err(|e| e.to_string())
}
/// 帳號庫清單（遠端回報用）
pub fn local_list() -> Vec<AccountInfo> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    list(&claude_home())
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
    fn dir_of(h: &Path, email: &str) -> PathBuf {
        store_root(h).join(email_dir_name(email))
    }
    fn emails(h: &Path) -> Vec<String> {
        list(h).into_iter().map(|a| a.email).collect()
    }

    #[test]
    fn 還原到切換前_權杖與帳號資訊都回到切換前_沒備份就不動() {
        let d = setup();
        let h = d.path();
        assert!(undo_last_switch(h).is_err(), "從沒切換過：沒有備份，不動任何東西");
        assert!(!cred_path(h).exists());
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h).unwrap();
        login(h, "u-a", "a@x.test", "A1");
        let (c0, j0) = (read(cred_path(h)), read(cj_path(h)));
        switch_to(h, "b@x.test").unwrap();
        assert_ne!(read(cred_path(h)), c0);
        undo_last_switch(h).unwrap();
        assert_eq!((read(cred_path(h)), read(cj_path(h))), (c0, j0), "回到切換前");
    }

    #[test]
    fn 加入帳號_以_email_識別_庫裡有權杖與帳號資訊_清單沒有權杖() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "A@x.test", "A1");
        let info = save_current(h).unwrap();
        assert_eq!((info.email.as_str(), info.plan.as_str(), info.current, info.saved), ("a@x.test", "max", true, true));
        assert_eq!(read(dir_of(h, "a@x.test").join(CRED)), cred("A1"));
        assert!(read(dir_of(h, "a@x.test").join(FRAG)).contains("A@x.test"));
        let shown = serde_json::to_string(&list(h)).unwrap();
        assert!(!shown.contains("FAKE-"), "清單不可含權杖");
        // 再加一次同一個登入：不報錯、不重複，並用最新權杖更新
        login(h, "u-a", "a@x.test", "A2");
        save_current(h).unwrap();
        assert_eq!(emails(h), vec!["a@x.test"]);
        assert_eq!(read(dir_of(h, "a@x.test").join(CRED)), cred("A2"));
    }

    #[test]
    fn 沒登入就不能加入() {
        let d = setup();
        assert_eq!(save_current(d.path()), Err(AccErr::NoLogin));
        login(d.path(), "u-a", "a@x.test", "A1");
        fs::remove_file(cred_path(d.path())).unwrap();
        assert_eq!(save_current(d.path()), Err(AccErr::NoLogin));
        // 帳號資訊裡沒有 email：不加入
        login(d.path(), "u-a", "", "A1");
        assert!(matches!(save_current(d.path()), Err(AccErr::Corrupt(_))));
    }

    #[test]
    fn 切換來回_回存最新權杖_且_claude_json_其他欄位一個字不動() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h).unwrap();
        // 甲換新權杖（使用中自動更新）：切走前要回存
        login(h, "u-a", "a@x.test", "A2");
        let before = read(cj_path(h));
        let out = switch_to(h, "B@x.test").unwrap();
        assert_eq!(out.email, "b@x.test");
        assert!(out.notice.contains("不用重開"));
        assert_eq!(read(cred_path(h)), cred("B1"));
        assert_eq!(read(dir_of(h, "a@x.test").join(CRED)), cred("A2"), "甲的最新權杖要回存");
        let after = read(cj_path(h));
        assert!(after.contains("b@x.test") && !after.contains("a@x.test"));
        // 替換範圍之外逐字相同
        let (s, e) = scan_top(&before).unwrap().val.unwrap();
        let (s2, e2) = scan_top(&after).unwrap().val.unwrap();
        assert_eq!(&before[..s], &after[..s2]);
        assert_eq!(&before[e..], &after[e2..]);
        assert!(after.contains("\"projects\": {\"D:\\\\x\": {\"a\": [1, 2,3]}}") && after.contains("\"tail\":   null"));
        // 換回來：甲拿到 A2，乙的權杖回存
        switch_to(h, "a@x.test").unwrap();
        assert_eq!(read(cred_path(h)), cred("A2"));
        assert_eq!(read(dir_of(h, "b@x.test").join(CRED)), cred("B1"));
        assert_eq!(read(cj_path(h)), before, "來回之後 .claude.json 與原本完全相同");
        let cur: Vec<_> = list(h).into_iter().filter(|a| a.current).map(|a| a.email).collect();
        assert_eq!(cur, vec!["a@x.test"]);
    }

    #[test]
    fn 目前登入還沒加入帳號庫_不准切走() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        login(h, "u-c", "c@x.test", "C1");
        let (c0, j0) = (read(cred_path(h)), read(cj_path(h)));
        assert_eq!(switch_to(h, "a@x.test"), Err(AccErr::CurrentUnsaved));
        assert_eq!((read(cred_path(h)), read(cj_path(h))), (c0, j0), "什麼都沒動");
        let cur = current_login(h).unwrap();
        assert_eq!((cur.email.as_str(), cur.saved), ("c@x.test", false));
    }

    #[test]
    fn 寫到一半失敗會還原_兩個檔案都回到原樣() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h).unwrap();
        login(h, "u-a", "a@x.test", "A2");
        let (c0, j0) = (read(cred_path(h)), read(cj_path(h)));
        let r = switch_impl(h, "b@x.test", Fault::AfterCredentials);
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
        save_current(h).unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h).unwrap();
        fs::write(cj_path(h), "{壞掉").unwrap();
        let (c0, j0) = (read(cred_path(h)), read(cj_path(h)));
        assert!(switch_to(h, "a@x.test").is_err());
        assert_eq!((read(cred_path(h)), read(cj_path(h))), (c0, j0));
    }

    // ---------- 存的登入不完整（沒有 refreshToken）：切換前就拒絕（10-30 工作機事故） ----------
    /// 家目錄底下所有檔案（相對路徑 → 內容），用來證明「什麼都沒動」
    fn snapshot(h: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, d: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
            for e in fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    out.insert(p.strip_prefix(root).unwrap().to_string_lossy().to_string(), fs::read(&p).unwrap());
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(h, h, &mut out);
        out
    }
    /// 庫裡有 a（目前登入、權杖已換新過）與 b；b 存的權杖換成 `b_cred`
    fn two_accounts_b_cred(h: &Path, b_cred: &str) {
        login(h, "u-b", "b@x.test", "B1");
        save_current(h).unwrap();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        fs::write(cred_path(h), cred("A2")).unwrap(); // 目前的權杖換新過：正常切換會先回存，這裡不該回存
        fs::write(dir_of(h, "b@x.test").join(CRED), b_cred).unwrap();
    }

    #[test]
    fn 判斷有沒有_refresh_token_只看非空字串() {
        assert!(has_refresh_token(cred("X").as_bytes()));
        assert!(!has_refresh_token(br#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS","expiresAt":1}}"#));
        assert!(!has_refresh_token(br#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS","refreshToken":""}}"#));
        assert!(!has_refresh_token(br#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS","refreshToken":"   "}}"#));
        assert!(!has_refresh_token(br#"{"claudeAiOauth":{"refreshToken":null}}"#));
        assert!(!has_refresh_token(br#"{"claudeAiOauth":{"refreshToken":123}}"#));
        assert!(!has_refresh_token(br#"{"refreshToken":"FAKE-REFRESH"}"#), "要在 claudeAiOauth 底下");
        assert!(!has_refresh_token(b"not json"));
    }

    #[test]
    fn 切到沒有_refresh_token_的帳號_動手前拒絕_所有檔案都沒動() {
        let d = setup();
        let h = d.path();
        two_accounts_b_cred(h, r#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS-B","expiresAt":1,"subscriptionType":"max"}}"#);
        let before = snapshot(h);
        let r = switch_to(h, "b@x.test");
        assert_eq!(r, Err(AccErr::IncompleteLogin));
        assert_eq!(r.unwrap_err().to_string(), "這個帳號存的登入不完整，請重新登入一次再加入");
        assert_eq!(snapshot(h), before, "目前登入、帳號庫、備份一個位元組都沒動");
        assert!(!backup_dir(h).exists(), "連備份都還沒做");
        assert_eq!(current_email(h).as_deref(), Some("a@x.test"));
    }

    #[test]
    fn 切到_refresh_token_是空字串的帳號_動手前拒絕_所有檔案都沒動() {
        let d = setup();
        let h = d.path();
        two_accounts_b_cred(h, r#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS-B","refreshToken":"","expiresAt":1}}"#);
        let before = snapshot(h);
        // 寫入失敗注入點也走不到：在任何寫檔之前就停
        assert_eq!(switch_impl(h, "b@x.test", Fault::AfterCredentials), Err(AccErr::IncompleteLogin));
        assert_eq!(snapshot(h), before);
    }

    #[test]
    fn 切到登入完整的帳號照常切換() {
        let d = setup();
        let h = d.path();
        two_accounts_b_cred(h, &cred("B9"));
        let out = switch_to(h, "b@x.test").unwrap();
        assert_eq!(out.email, "b@x.test");
        assert_eq!(read(cred_path(h)), cred("B9"));
        assert_eq!(read(dir_of(h, "a@x.test").join(CRED)), cred("A2"), "切走前回存目前的權杖");
    }

    #[test]
    fn 清單標出登入不完整_只是布林_不含權杖() {
        let d = setup();
        let h = d.path();
        two_accounts_b_cred(h, r#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS-B","refreshToken":""}}"#);
        let l = list(h);
        let flags: Vec<(&str, bool)> = l.iter().map(|a| (a.email.as_str(), a.login_incomplete)).collect();
        assert_eq!(flags, vec![("a@x.test", false), ("b@x.test", true)]);
        let shown = serde_json::to_string(&l).unwrap();
        assert!(!shown.contains("FAKE-"), "清單不可含權杖：{shown}");
        assert!(shown.contains("\"login_incomplete\":true"));
        assert!(!current_login(h).unwrap().login_incomplete);
    }

    #[test]
    fn 找不到帳號() {
        let d = setup();
        login(d.path(), "u-a", "a@x.test", "A1");
        assert_eq!(switch_to(d.path(), "no@x.test"), Err(AccErr::NotFound));
        assert_eq!(delete(d.path(), "no@x.test"), Err(AccErr::NotFound));
    }

    #[test]
    fn email_不合法_路徑穿越一律擋() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        for bad in ["", "..", "../x", "..\\x@y", "a/b@x", "a@b@c", "@x.test", "a@", "C:\\x@y", "x y@z", "a\nb@c", "a*@b", &format!("{}@x.test", "長".repeat(120))] {
            assert_eq!(switch_to(h, bad), Err(AccErr::BadEmail), "{bad:?}");
            assert_eq!(delete(h, bad), Err(AccErr::BadEmail), "{bad:?}");
        }
        assert!(!store_root(h).exists(), "擋下來的 email 不可建出任何資料夾");
        assert_eq!(normalize_email("  Foo.Bar+x@Example.COM "), Some("foo.bar+x@example.com".into()));
    }

    #[test]
    fn 資料夾名_不同_email_一定不同_且不含路徑字元() {
        let samples = ["a@x.test", "a_b@x.test", "a_5fb@x.test", ".a@x.test", "a@x.", "中文@例.tw", "a+b@x.test"];
        let names: Vec<String> = samples.iter().map(|e| email_dir_name(&normalize_email(e).unwrap())).collect();
        let uniq: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(uniq.len(), names.len(), "{names:?}");
        for n in &names {
            assert!(!n.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) && !n.starts_with('.') && !n.ends_with('.'), "{n}");
        }
        assert_eq!(email_dir_name("a@x.test"), "a@x.test");
        assert_eq!(email_dir_name("a_b@x.test"), "a_5fb@x.test");
        assert_ne!(email_dir_name("a_b@x.test"), email_dir_name("a_5fb@x.test"));
    }

    #[test]
    fn 刪除只刪那個帳號() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h).unwrap();
        delete(h, "A@x.test").unwrap();
        assert_eq!(emails(h), vec!["b@x.test"]);
        assert_eq!(read(cred_path(h)), cred("B1"), "不碰目前登入");
    }

    #[test]
    fn 舊版以名字存的帳號_讀到就自動遷移成_email_資料夾() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        // 舊格式：資料夾名是「工作」「個人」
        for (name, uuid, email, tag) in [("工作", "u-a", "a@x.test", "A1"), ("個人", "u-b", "b@x.test", "B1")] {
            let dir = store_root(h).join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(CRED), cred(tag)).unwrap();
            fs::write(dir.join(FRAG), extract_fragment(&cj(uuid, email)).unwrap().unwrap()).unwrap();
        }
        assert_eq!(emails(h), vec!["a@x.test", "b@x.test"]);
        assert!(!store_root(h).join("工作").exists() && !store_root(h).join("個人").exists(), "舊資料夾已改名");
        assert_eq!(read(dir_of(h, "b@x.test").join(CRED)), cred("B1"));
        // 遷移後切換照常運作，且目前登入（甲）判得出來
        assert_eq!(list(h).into_iter().filter(|a| a.current).map(|a| a.email).collect::<Vec<_>>(), vec!["a@x.test"]);
        switch_to(h, "b@x.test").unwrap();
        assert_eq!(read(cred_path(h)), cred("B1"));
        // 目標已存在：不覆蓋、清單不重複
        let dup = store_root(h).join("甲的複本");
        fs::create_dir_all(&dup).unwrap();
        fs::write(dup.join(CRED), cred("OLD")).unwrap();
        fs::write(dup.join(FRAG), extract_fragment(&cj("u-a", "a@x.test")).unwrap().unwrap()).unwrap();
        assert_eq!(emails(h), vec!["a@x.test", "b@x.test"]);
        assert_ne!(read(dir_of(h, "a@x.test").join(CRED)), cred("OLD"));
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

    #[test]
    fn 自動加入_目前登入不在庫就加入_清單馬上有() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "A@x.test", "A1");
        assert_eq!(auto_sync(h), Ok(AutoOutcome::Added("a@x.test".into())));
        assert_eq!(emails(h), vec!["a@x.test"]);
        assert_eq!(read(dir_of(h, "a@x.test").join(CRED)), cred("A1"));
        // 再跑一次：已經一樣，什麼都不做
        assert_eq!(auto_sync(h), Ok(AutoOutcome::Nothing));
    }

    #[test]
    fn 自動回存_權杖換新就更新庫裡那份_其他帳號不動() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        login(h, "u-b", "b@x.test", "B1");
        save_current(h).unwrap();
        login(h, "u-a", "a@x.test", "A2");
        assert_eq!(auto_sync(h), Ok(AutoOutcome::Updated("a@x.test".into())));
        assert_eq!(read(dir_of(h, "a@x.test").join(CRED)), cred("A2"));
        assert_eq!(read(dir_of(h, "b@x.test").join(CRED)), cred("B1"));
        assert!(fs::read_dir(dir_of(h, "a@x.test")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("asn-tmp")), "不留暫存檔");
    }

    #[test]
    fn 自動同步_內容相同不寫檔() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        let f = dir_of(h, "a@x.test").join(CRED);
        let g = dir_of(h, "a@x.test").join(FRAG);
        let set_ro = |ro: bool| {
            for p in [&f, &g] {
                let mut perm = fs::metadata(p).unwrap().permissions();
                perm.set_readonly(ro);
                fs::set_permissions(p, perm).unwrap();
            }
        };
        // 庫裡兩個檔設成唯讀：若真的去寫（rename 蓋過唯讀檔在 Windows 會失敗）就會變 Err；另外比修改時間
        let (m1, m2) = (fs::metadata(&f).unwrap().modified().unwrap(), fs::metadata(&g).unwrap().modified().unwrap());
        set_ro(true);
        let r = auto_sync(h);
        set_ro(false);
        assert_eq!(r, Ok(AutoOutcome::Nothing));
        assert_eq!((fs::metadata(&f).unwrap().modified().unwrap(), fs::metadata(&g).unwrap().modified().unwrap()), (m1, m2));
    }

    #[test]
    fn 自動同步_沒登入什麼都不動() {
        let d = setup();
        let h = d.path();
        assert_eq!(auto_sync(h), Ok(AutoOutcome::Nothing));
        assert!(!store_root(h).exists(), "沒登入不可建帳號庫");
        // 只有帳號資訊、沒有權杖檔
        login(h, "u-a", "a@x.test", "A1");
        fs::remove_file(cred_path(h)).unwrap();
        assert_eq!(auto_sync(h), Ok(AutoOutcome::Nothing));
        assert!(!store_root(h).exists());
        // 有權杖檔、沒有帳號資訊
        login(h, "u-a", "a@x.test", "A1");
        fs::write(cj_path(h), "{\"numStartups\": 1}").unwrap();
        assert_eq!(auto_sync(h), Ok(AutoOutcome::Nothing));
        assert!(!store_root(h).exists());
        // 權杖檔寫到一半（不是合法 JSON）：不動帳號庫
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        fs::write(cred_path(h), "{半截").unwrap();
        assert!(auto_sync(h).is_err());
        assert_eq!(read(dir_of(h, "a@x.test").join(CRED)), cred("A1"));
    }

    #[test]
    fn 自動同步_與切換互斥_拿著鎖時等切換做完() {
        use std::sync::{mpsc, Arc, Mutex};
        let d = setup();
        let h = d.path().to_path_buf();
        login(&h, "u-a", "a@x.test", "A1");
        save_current(&h).unwrap();
        login(&h, "u-b", "b@x.test", "B1");
        save_current(&h).unwrap();
        login(&h, "u-a", "a@x.test", "A2");
        let lock = Arc::new(Mutex::new(()));
        let guard = lock.lock().unwrap(); // 模擬切換進行中（切換指令拿的是同一把鎖）
        let (tx, rx) = mpsc::channel();
        let (l2, h2) = (lock.clone(), h.clone());
        let t = std::thread::spawn(move || tx.send(auto_tick(&l2, &h2)).unwrap());
        assert!(rx.recv_timeout(std::time::Duration::from_millis(300)).is_err(), "切換還沒做完，自動同步不可動手");
        assert_eq!(read(dir_of(&h, "a@x.test").join(CRED)), cred("A1"), "鎖著的時候庫裡沒被改");
        switch_to(&h, "b@x.test").unwrap(); // 切換做完（先回存甲的 A2）
        drop(guard);
        let out = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        t.join().unwrap();
        // 切換後目前登入是乙、和庫裡一致 → 沒有多餘動作
        assert_eq!(out, Ok(AutoOutcome::Nothing));
        assert_eq!(read(dir_of(&h, "a@x.test").join(CRED)), cred("A2"));
        assert_eq!(read(cred_path(&h)), cred("B1"));
    }

    #[test]
    fn 背景工作與_Tauri_指令用同一把鎖() {
        let src = include_str!("claude_accounts.rs").replace("\r\n", "\n");
        assert!(src.contains("auto_tick(&LOCK, &home)"), "背景工作要用和切換同一把 LOCK");
        assert!(src.contains("pub fn local_switch(email: &str) -> Result<SwitchOutcome, String> {\n    let _g = LOCK.lock()"));
    }

    #[test]
    fn 開關讀法_固定開啟_寫_false_也忽略() {
        assert!(auto_enabled_from_saved(r#"{"autoAddClaude":false,"closeTo":"tray"}"#));
        assert!(auto_enabled_from_saved(r#"{"autoAddClaude":true}"#));
        for t in [r#"{"sound":true}"#, r#"{"autoAddClaude":null}"#, r#"{"autoAddClaude":"false"}"#, "{壞掉", ""] {
            assert!(auto_enabled_from_saved(t), "{t}");
        }
    }

    #[test]
    fn 登入到一半不動作_連續兩次相同才算穩定() {
        let d = setup();
        let h = d.path();
        let mut st = Steady::default();
        login(h, "u-a", "a@x.test", "A1");
        assert!(!st.settled(h), "第一次看到：先不動");
        assert!(st.settled(h));
        login(h, "u-a", "a@x.test", "A2");
        assert!(!st.settled(h), "內容變了：再等一輪");
        assert!(st.settled(h));
    }

    #[cfg(windows)]
    #[test]
    fn windows_帳號庫資料夾不給其他人() {
        let d = setup();
        let h = d.path();
        login(h, "u-a", "a@x.test", "A1");
        save_current(h).unwrap();
        let o = std::process::Command::new("icacls").no_window().arg(store_root(h)).output().unwrap();
        let t = String::from_utf8_lossy(&o.stdout).to_lowercase();
        assert!(!t.contains("everyone") && !t.contains("\\users:") && !t.contains("authenticated users"), "{t}");
        assert!(t.contains(&std::env::var("USERNAME").unwrap().to_lowercase()));
    }
}
