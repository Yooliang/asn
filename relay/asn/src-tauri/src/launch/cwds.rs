//! 開新夥伴對話框的「工作資料夾」候選：白名單＋自動建議（開著的 Claude 視窗、信任過的資料夾、最近用過）。
//! 使用者從下拉或「瀏覽…」選了＝明確同意，才會加進本機啟動設定（launch-prefs.json）的 cwdAllow；
//! 本機啟動直接用這份候選。內建收發室橋（bridge/launcher.rs）在使用者於設定打開「允許我的其他設備替這台開新視窗」之後，
//! 也把這份候選併進回報給別台設備的工作資料夾白名單；沒打開時遠端來的啟動仍只看 launcher.json。
use super::config::{canonical_launch_cwd, LaunchConfig};
use super::prefs::{launch_prefs_get_sync, launch_prefs_set_sync};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const MAX_CANDIDATES: usize = 15;

/// 正規化成「看起來一致」的路徑字串：去 \\?\ 前綴、Windows 上 / 換成 \、去尾端分隔線（磁碟根目錄除外）。
pub fn norm_path(s: &str) -> Option<String> {
    let mut t = s.trim().to_string();
    if let Some(r) = t.strip_prefix("\\\\?\\") {
        t = r.to_string();
    }
    if t.is_empty() {
        return None;
    }
    if cfg!(windows) {
        t = t.replace('/', "\\");
    }
    let is_root = |x: &str| x == "/" || (x.len() == 3 && x.ends_with(":\\")) || (x.len() == 2 && x.ends_with(':'));
    while t.len() > 1 && (t.ends_with('\\') || t.ends_with('/')) && !is_root(&t) {
        t.pop();
    }
    if cfg!(windows) && t.len() == 2 && t.ends_with(':') {
        t.push('\\');
    }
    Some(t)
}

fn dedupe_key(p: &str) -> String {
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

/// 依來源先後合併：正規化、去重、略過不存在的資料夾、最多 limit 筆。
pub fn merge_sources(sources: &[Vec<String>], is_dir: &dyn Fn(&str) -> bool, limit: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for list in sources {
        for raw in list {
            let Some(p) = norm_path(raw) else { continue };
            if !seen.insert(dedupe_key(&p)) {
                continue;
            }
            if !is_dir(&p) {
                continue;
            }
            out.push(p);
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}

/// 開著的 Claude 視窗的 cwd：~/.claude/sessions/*.json 只讀 cwd 欄位，新的在前。
pub fn read_session_cwds(home: &Path) -> Vec<String> {
    let dir = home.join(".claude").join("sessions");
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let mut rows: Vec<(std::time::SystemTime, String)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            let v: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            let cwd = v.get("cwd")?.as_str()?.to_string();
            Some((mtime, cwd))
        })
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|r| r.1).collect()
}

/// ~/.claude.json 的 projects：只看鍵與 hasTrustDialogAccepted，其餘內容不碰。
pub fn read_trusted_dirs(home: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return vec![] };
    let Some(projects) = v.get("projects").and_then(Value::as_object) else { return vec![] };
    projects
        .iter()
        .filter(|(_, p)| p.get("hasTrustDialogAccepted").and_then(Value::as_bool) == Some(true))
        .map(|(k, _)| k.clone())
        .collect()
}

fn str_list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn paths_to_strings(v: &[PathBuf]) -> Vec<String> {
    v.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// 候選清單：最近用過 → 開著的視窗 → 信任過的 → 本機同意過的白名單 → 啟動設定白名單。
pub fn candidates(home: &Path, data_dir: &Path, launcher_allow: &[PathBuf]) -> Vec<String> {
    let prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    let sources = vec![
        str_list(&prefs, "recentCwd"),
        read_session_cwds(home),
        read_trusted_dirs(home),
        str_list(&prefs, "cwdAllow"),
        paths_to_strings(launcher_allow),
    ];
    merge_sources(&sources, &|p| Path::new(p).is_dir(), MAX_CANDIDATES)
}

fn same_dir(a: &str, b: &Path) -> bool {
    canonical_launch_cwd(a).map(|x| x == b).unwrap_or(false)
}

/// 本機白名單（launch-prefs.json 的 cwdAllow）最多幾個資料夾；跟遠端開窗那邊（bridge/launcher.rs 的 MAX_CWD）同一個數字。
pub const MAX_ALLOW: usize = 50;

/// 資料夾放進白名單時被拒絕的原因（只擋「加入」；使用時的檢查在 config::check_launch、term::authorize_cwd、bridge/launcher.rs，照舊）。
#[derive(Debug, PartialEq, Eq)]
pub enum CwdReject {
    Empty,
    NotFound(String),
    NotDir(String),
    Duplicate(String),
    TooMany,
    /// 存檔寫不進去（磁碟、權限）；原文已進 log
    SaveFailed,
}

impl CwdReject {
    /// 給畫面看的白話原因
    pub fn text(&self) -> String {
        match self {
            CwdReject::Empty => "資料夾是空的".into(),
            CwdReject::NotFound(p) => format!("資料夾不存在：{p}"),
            CwdReject::NotDir(p) => format!("這不是資料夾：{p}"),
            CwdReject::Duplicate(p) => format!("這個資料夾已經在清單裡：{p}"),
            CwdReject::TooMany => format!("最多只能加入 {MAX_ALLOW} 個資料夾"),
            CwdReject::SaveFailed => "設定存不進去，請稍後再試".into(),
        }
    }
}

/// 加入白名單的單一驗證函式：空白拒、解析後要存在且是資料夾、不能跟清單裡的重複（Windows 大小寫與斜線視為同一個）、總數不超過上限。
/// 通過回傳正規化後要存的路徑。規則與使用時的檢查一致，不新增根目錄或網路路徑的限制。
pub fn validate_cwd(existing: &[String], cwd: &str) -> Result<String, CwdReject> {
    let p = norm_path(cwd).ok_or(CwdReject::Empty)?;
    let canon = canonical_launch_cwd(&p).map_err(|_| CwdReject::NotFound(p.clone()))?;
    if !canon.exists() {
        return Err(CwdReject::NotFound(p));
    }
    if !canon.is_dir() {
        return Err(CwdReject::NotDir(p));
    }
    let key = dedupe_key(&p);
    if existing.iter().any(|x| norm_path(x).map(|y| dedupe_key(&y) == key).unwrap_or(false)) {
        return Err(CwdReject::Duplicate(p));
    }
    if existing.len() >= MAX_ALLOW {
        return Err(CwdReject::TooMany);
    }
    Ok(p)
}

/// 驗證後加進本機白名單，回傳存下的路徑。已經在清單裡的回 Err(Duplicate)，由呼叫端決定要不要當成功。
pub fn add_validated(data_dir: &Path, cwd: &str) -> Result<String, CwdReject> {
    let mut prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    if !prefs.is_object() {
        prefs = json!({});
    }
    let mut allow = str_list(&prefs, "cwdAllow");
    let p = validate_cwd(&allow, cwd)?;
    allow.push(p.clone());
    prefs["cwdAllow"] = json!(allow);
    launch_prefs_set_sync(data_dir, prefs).map_err(|e| {
        elog!("[launch] 寫入白名單失敗：{e}");
        CwdReject::SaveFailed
    })?;
    Ok(p)
}

/// 從本機白名單移除一筆（依 dedupe_key 比對，Windows 大小寫與斜線不同也算同一個），回傳移除後的清單。清單裡沒有就回錯誤。
pub fn remove_from_prefs_allow(data_dir: &Path, cwd: &str) -> Result<Vec<String>, String> {
    let Some(p) = norm_path(cwd) else { return Err("資料夾是空的".into()) };
    let key = dedupe_key(&p);
    let mut prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    if !prefs.is_object() {
        prefs = json!({});
    }
    let allow = str_list(&prefs, "cwdAllow");
    let keep: Vec<String> = allow
        .iter()
        .filter(|x| norm_path(x).map(|y| dedupe_key(&y) != key).unwrap_or(true))
        .cloned()
        .collect();
    if keep.len() == allow.len() {
        return Err("清單裡找不到這個資料夾".into());
    }
    prefs["cwdAllow"] = json!(keep);
    launch_prefs_set_sync(data_dir, prefs).map_err(|e| {
        elog!("[launch] 移除白名單項目失敗：{e}");
        CwdReject::SaveFailed.text()
    })?;
    Ok(keep)
}

/// 整份存檔前的檢查：只驗「新加入」的 cwdAllow 項目，存檔裡原本就有的（含已不存在的舊資料夾）原樣保留、不驗不清；
/// 移除永遠放行。新項目逐一走 [`validate_cwd`]，有一個不合格就整份拒絕並回白話原因。沒帶 cwdAllow 的存檔（只改別的欄位）不檢查。
pub fn check_prefs_write(current: &Value, incoming: &Value) -> Result<(), String> {
    let Some(raw) = incoming.get("cwdAllow") else { return Ok(()) };
    let Some(arr) = raw.as_array() else { return Err("工作資料夾清單格式不對".into()) };
    let known: std::collections::HashSet<String> =
        str_list(current, "cwdAllow").iter().filter_map(|x| norm_path(x)).map(|y| dedupe_key(&y)).collect();
    let mut accepted: Vec<String> = Vec::new();
    for item in arr {
        let Some(s) = item.as_str() else { return Err("工作資料夾清單格式不對".into()) };
        let is_known = norm_path(s).map(|y| known.contains(&dedupe_key(&y))).unwrap_or(false);
        if is_known {
            // 舊項目：不驗證；同一份裡重複出現的舊項目也不當錯
            accepted.push(s.to_string());
            continue;
        }
        let ok = validate_cwd(&accepted, s).map_err(|e| e.text())?;
        accepted.push(ok);
    }
    Ok(())
}

/// 使用者同意的資料夾寫進本機白名單（去重）。
pub fn add_to_prefs_allow(data_dir: &Path, cwd: &str) -> Result<(), String> {
    let Some(p) = norm_path(cwd) else { return Err("資料夾是空的".into()) };
    let mut prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    if !prefs.is_object() {
        prefs = json!({});
    }
    let mut allow = str_list(&prefs, "cwdAllow");
    if allow.iter().any(|x| norm_path(x).map(|y| dedupe_key(&y) == dedupe_key(&p)).unwrap_or(false)) {
        return Ok(());
    }
    allow.push(p);
    prefs["cwdAllow"] = json!(allow);
    launch_prefs_set_sync(data_dir, prefs)
}

/// 重開自動接回用（#767）：原本的資料夾若是使用者在本機同意過的（launch-prefs.json 的 cwdAllow：從畫面選過、按「瀏覽…」加過），
/// 就併進這次的白名單。**只認同意過的**：候選（最近用過、開著的視窗、信任過的）不算同意，這裡不併；
/// 比對用正規路徑（含中文、空白、斜線與大小寫差異）；資料夾已不存在就不併，由開窗那一步回「已經不存在」。
/// 呼叫端只會是開機流程、對象只會是 ASN 自己開過、存檔裡記著的視窗，不會是遠端或任意路徑。
pub fn allow_consented(config: &mut LaunchConfig, cwd: &str, data_dir: &Path) {
    let Ok(canon) = canonical_launch_cwd(cwd) else { return };
    // 不存在的路徑 canonical_launch_cwd 會原樣交回，所以另外確認資料夾還在
    if !canon.is_dir() || config.cwd_allow.contains(&canon) {
        return;
    }
    let prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    if str_list(&prefs, "cwdAllow").iter().any(|s| same_dir(s, &canon)) {
        config.cwd_allow.push(canon);
    }
}

/// 本機啟動前：cwd 已在白名單就放行；否則只有它是候選（自己的建議／本機同意過）才視為使用者同意，
/// 加進本機白名單並放行。其他來源的任意路徑一律不放行。
pub fn grant_local_cwd(config: &mut LaunchConfig, cwd: &str, home: &Path, data_dir: &Path) -> Result<(), String> {
    let canon = canonical_launch_cwd(cwd)?;
    if config.cwd_allow.contains(&canon) {
        return Ok(());
    }
    let prefs = launch_prefs_get_sync(data_dir).unwrap_or(Value::Null);
    let in_prefs = str_list(&prefs, "cwdAllow").iter().any(|s| same_dir(s, &canon));
    if !in_prefs {
        let cands = candidates(home, data_dir, &config.cwd_allow);
        if !cands.iter().any(|s| same_dir(s, &canon)) {
            return Ok(()); // 不放行：交給 check_launch 回「不在允許清單裡」
        }
        let _ = add_to_prefs_allow(data_dir, cwd);
    }
    config.cwd_allow.push(canon);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::config::LaunchConfig;
    use std::collections::HashMap;

    fn cfg(allow: Vec<PathBuf>) -> LaunchConfig {
        LaunchConfig { profiles: HashMap::new(), cwd_allow: allow, max_per_hour: 6 }
    }

    fn w(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn 正規化去尾端分隔線與前綴() {
        assert_eq!(norm_path("  "), None);
        let d = tempfile::tempdir().unwrap();
        let base = d.path().to_string_lossy().into_owned();
        assert_eq!(norm_path(&format!("{base}/")).unwrap(), norm_path(&base).unwrap());
        #[cfg(windows)]
        {
            assert_eq!(norm_path("D:/x/y/").unwrap(), "D:\\x\\y");
            assert_eq!(norm_path("\\\\?\\D:\\x").unwrap(), "D:\\x");
            assert_eq!(norm_path("D:\\").unwrap(), "D:\\");
        }
    }

    #[test]
    fn 合併去重略過不存在並限量() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        let b = d.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let sa = a.to_string_lossy().into_owned();
        let sb = b.to_string_lossy().into_owned();
        let gone = d.path().join("gone").to_string_lossy().into_owned();
        let out = merge_sources(&[vec![sa.clone(), gone.clone()], vec![format!("{sa}/"), sb.clone()]], &|p| Path::new(p).is_dir(), 15);
        assert_eq!(out, vec![norm_path(&sa).unwrap(), norm_path(&sb).unwrap()]);
        let out = merge_sources(&[vec![sa, sb]], &|p| Path::new(p).is_dir(), 1);
        assert_eq!(out.len(), 1);
        let many: Vec<String> = (0..40).map(|i| format!("/m{i}")).collect();
        assert_eq!(merge_sources(&[many], &|_| true, MAX_CANDIDATES).len(), 15);
    }

    #[cfg(windows)]
    #[test]
    fn 兩種斜線寫法與大小寫視為同一個() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("Proj");
        std::fs::create_dir_all(&a).unwrap();
        let back = a.to_string_lossy().into_owned();
        let fwd = back.replace('\\', "/").to_lowercase();
        let out = merge_sources(&[vec![back.clone()], vec![fwd]], &|p| Path::new(p).is_dir(), 15);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn 讀開著的視窗與信任過的資料夾() {
        let home = tempfile::tempdir().unwrap();
        let proj = home.path().join("proj");
        let trusted = home.path().join("trusted");
        let untrusted = home.path().join("untrusted");
        for p in [&proj, &trusted, &untrusted] {
            std::fs::create_dir_all(p).unwrap();
        }
        w(&home.path().join(".claude/sessions/1.json"), &json!({ "cwd": proj.to_string_lossy(), "other": "x" }).to_string());
        w(&home.path().join(".claude/sessions/bad.json"), "not json");
        w(&home.path().join(".claude/sessions/nocwd.json"), "{}");
        let t = trusted.to_string_lossy().into_owned();
        let projects = json!({
            t.clone(): { "hasTrustDialogAccepted": true },
            t.replace('\\', "/"): { "hasTrustDialogAccepted": true },
            untrusted.to_string_lossy(): { "hasTrustDialogAccepted": false },
            home.path().join("missing").to_string_lossy(): { "hasTrustDialogAccepted": true },
        });
        w(&home.path().join(".claude.json"), &json!({ "projects": projects, "oauthAccount": { "secret": 1 } }).to_string());
        assert_eq!(read_session_cwds(home.path()), vec![proj.to_string_lossy().into_owned()]);
        let data = tempfile::tempdir().unwrap();
        let c = candidates(home.path(), data.path(), &[]);
        assert!(c.contains(&norm_path(&proj.to_string_lossy()).unwrap()));
        assert_eq!(c.iter().filter(|x| dedupe_key(x) == dedupe_key(&norm_path(&t).unwrap())).count(), 1);
        assert!(!c.iter().any(|x| x.ends_with("untrusted") || x.ends_with("missing")));
    }

    #[test]
    fn 沒有任何來源時是空的() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        assert!(candidates(home.path(), data.path(), &[]).is_empty());
    }

    #[test]
    fn 候選順序_最近用過在前() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let (r, s) = (home.path().join("r"), home.path().join("s"));
        std::fs::create_dir_all(&r).unwrap();
        std::fs::create_dir_all(&s).unwrap();
        w(&home.path().join(".claude/sessions/1.json"), &json!({ "cwd": s.to_string_lossy() }).to_string());
        w(&data.path().join("launch-prefs.json"), &json!({ "recentCwd": [r.to_string_lossy()] }).to_string());
        let c = candidates(home.path(), data.path(), &[]);
        assert_eq!(c, vec![norm_path(&r.to_string_lossy()).unwrap(), norm_path(&s.to_string_lossy()).unwrap()]);
    }

    #[test]
    fn 瀏覽加入白名單_去重且遠端設定不動() {
        let data = tempfile::tempdir().unwrap();
        let d = tempfile::tempdir().unwrap();
        let p = d.path().to_string_lossy().into_owned();
        add_to_prefs_allow(data.path(), &p).unwrap();
        add_to_prefs_allow(data.path(), &format!("{p}/")).unwrap();
        let prefs = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&prefs, "cwdAllow").len(), 1);
        assert!(add_to_prefs_allow(data.path(), "  ").is_err());
        // 只寫 launch-prefs.json，不碰 launcher.json
        assert!(!data.path().join("launcher.json").exists());
    }

    /// 重開自動接回（#767）併白名單：只認本機同意過的（launch-prefs.json 的 cwdAllow）
    #[test]
    fn 自動接回_本機同意過的資料夾併進白名單_含中文加空白() {
        let base = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let zh = base.path().join("續接 乙");
        std::fs::create_dir_all(&zh).unwrap();
        let canon = canonical_launch_cwd(&zh.to_string_lossy()).unwrap();
        // 同意清單裡用「斜線、尾端分隔線」的寫法，比對仍走同一個正規路徑
        add_to_prefs_allow(data.path(), &format!("{}/", zh.to_string_lossy().replace('\\', "/"))).unwrap();
        let mut c = cfg(vec![]);
        allow_consented(&mut c, &zh.to_string_lossy(), data.path());
        assert_eq!(c.cwd_allow, vec![canon.clone()]);
        // 原本就在白名單：不重複加
        allow_consented(&mut c, &zh.to_string_lossy(), data.path());
        assert_eq!(c.cwd_allow.len(), 1);
    }

    #[test]
    fn 自動接回_只是候選沒同意過的不併_也不寫進同意清單() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let proj = home.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        // 開著的視窗、最近用過都只是候選
        w(&home.path().join(".claude/sessions/1.json"), &json!({ "cwd": proj.to_string_lossy() }).to_string());
        crate::launch::prefs::launch_prefs_set_sync(data.path(), json!({ "recentCwd": [proj.to_string_lossy()] })).unwrap();
        assert!(candidates(home.path(), data.path(), &[]).iter().any(|s| same_dir(s, &canonical_launch_cwd(&proj.to_string_lossy()).unwrap())));
        let mut c = cfg(vec![]);
        allow_consented(&mut c, &proj.to_string_lossy(), data.path());
        assert!(c.cwd_allow.is_empty(), "候選不算同意");
        let prefs = launch_prefs_get_sync(data.path()).unwrap();
        assert!(str_list(&prefs, "cwdAllow").is_empty(), "接回不會替人加同意");
    }

    #[test]
    fn 自動接回_同意過但資料夾已刪除的不併_開窗那步回不存在() {
        let base = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let gone = base.path().join("已刪除 資料夾");
        std::fs::create_dir_all(&gone).unwrap();
        add_to_prefs_allow(data.path(), &gone.to_string_lossy()).unwrap();
        std::fs::remove_dir_all(&gone).unwrap();
        let mut c = cfg(vec![]);
        allow_consented(&mut c, &gone.to_string_lossy(), data.path());
        assert!(c.cwd_allow.is_empty());
        let err = crate::launch::local::start_resumed_window(&c, "T-乙", &gone.to_string_lossy(), "76c44a7f-d488-49f0-9d6c-d089a427b5ed", &[], false).unwrap_err();
        assert!(err.contains("已經不存在"), "{err}");
    }

    #[test]
    fn 自動接回_同意過的資料夾過得了白名單那一關_沒同意的被擋() {
        let base = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let ok = base.path().join("甲 資料夾");
        let no = base.path().join("乙 資料夾");
        std::fs::create_dir_all(&ok).unwrap();
        std::fs::create_dir_all(&no).unwrap();
        add_to_prefs_allow(data.path(), &ok.to_string_lossy()).unwrap();
        let sid = "76c44a7f-d488-49f0-9d6c-d089a427b5ed";
        // 沒有 Claude 啟動設定的測試設定：過了白名單才會走到「沒有可用的啟動設定」，被擋的是「不在允許清單內」
        let mut c1 = cfg(vec![]);
        allow_consented(&mut c1, &ok.to_string_lossy(), data.path());
        let e1 = crate::launch::local::start_resumed_window(&c1, "T-甲", &ok.to_string_lossy(), sid, &[], false).unwrap_err();
        assert!(!e1.contains("不在允許清單內"), "{e1}");
        let mut c2 = cfg(vec![]);
        allow_consented(&mut c2, &no.to_string_lossy(), data.path());
        let e2 = crate::launch::local::start_resumed_window(&c2, "T-乙", &no.to_string_lossy(), sid, &[], false).unwrap_err();
        assert!(e2.contains("不在允許清單內"), "{e2}");
    }

    #[test]
    fn 啟動前同意_建議的資料夾放行並記住_陌生路徑不放行() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let proj = home.path().join("proj");
        let stranger = home.path().join("stranger");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&stranger).unwrap();
        w(&home.path().join(".claude/sessions/1.json"), &json!({ "cwd": proj.to_string_lossy() }).to_string());

        let mut c = cfg(vec![]);
        grant_local_cwd(&mut c, &stranger.to_string_lossy(), home.path(), data.path()).unwrap();
        assert!(c.cwd_allow.is_empty());

        grant_local_cwd(&mut c, &proj.to_string_lossy(), home.path(), data.path()).unwrap();
        assert_eq!(c.cwd_allow, vec![canonical_launch_cwd(&proj.to_string_lossy()).unwrap()]);
        let prefs = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&prefs, "cwdAllow").len(), 1);

        // 之後視窗關了、建議消失，本機同意過的仍然放行
        std::fs::remove_dir_all(home.path().join(".claude")).unwrap();
        let mut c2 = cfg(vec![]);
        grant_local_cwd(&mut c2, &proj.to_string_lossy(), home.path(), data.path()).unwrap();
        assert_eq!(c2.cwd_allow.len(), 1);
    }

    #[test]
    fn 已在啟動設定白名單的直接放行() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let p = home.path().join("ok");
        std::fs::create_dir_all(&p).unwrap();
        let canon = canonical_launch_cwd(&p.to_string_lossy()).unwrap();
        let mut c = cfg(vec![canon.clone()]);
        grant_local_cwd(&mut c, &p.to_string_lossy(), home.path(), data.path()).unwrap();
        assert_eq!(c.cwd_allow, vec![canon]);
        assert!(!data.path().join("launch-prefs.json").exists());
    }

    // ---- #1548 ③：加入白名單的單一驗證函式、移除、整份存檔 ----

    /// 真實 launch-prefs.json 的格式（前端 launchPrefsToSave 寫出來的那種）
    fn real_prefs(allow: &[String], recent: &[String]) -> Value {
        json!({ "recentCwd": recent, "cwdAllow": allow, "maxPerHourSet": 3, "showAdvanced": false, "launchDisplay": "background" })
    }

    #[test]
    fn 驗證_空白拒() {
        assert_eq!(validate_cwd(&[], "   "), Err(CwdReject::Empty));
        assert_eq!(validate_cwd(&[], ""), Err(CwdReject::Empty));
    }

    #[test]
    fn 驗證_不存在拒() {
        let d = tempfile::tempdir().unwrap();
        let gone = d.path().join("gone").to_string_lossy().into_owned();
        let r = validate_cwd(&[], &gone);
        assert!(matches!(r, Err(CwdReject::NotFound(_))), "{r:?}");
        assert!(r.unwrap_err().text().starts_with("資料夾不存在"));
    }

    #[test]
    fn 驗證_是檔案不是資料夾拒() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let r = validate_cwd(&[], &f.to_string_lossy());
        assert!(matches!(r, Err(CwdReject::NotDir(_))), "{r:?}");
    }

    #[test]
    fn 驗證_正常回正規化路徑() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().to_string_lossy().into_owned();
        assert_eq!(validate_cwd(&[], &format!("{base}/")).unwrap(), norm_path(&base).unwrap());
    }

    #[test]
    fn 驗證_重複拒_尾端斜線一樣算() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().to_string_lossy().into_owned();
        let existing = vec![norm_path(&base).unwrap()];
        assert!(matches!(validate_cwd(&existing, &base), Err(CwdReject::Duplicate(_))));
        assert!(matches!(validate_cwd(&existing, &format!("{base}/")), Err(CwdReject::Duplicate(_))));
    }

    #[cfg(windows)]
    #[test]
    fn 驗證_重複拒_大小寫與斜線差異() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("Proj");
        std::fs::create_dir_all(&a).unwrap();
        let back = a.to_string_lossy().into_owned();
        let fwd = back.replace('\\', "/").to_lowercase();
        assert!(matches!(validate_cwd(&[back], &fwd), Err(CwdReject::Duplicate(_))));
    }

    #[test]
    fn 驗證_超過上限拒() {
        let d = tempfile::tempdir().unwrap();
        let full: Vec<String> = (0..MAX_ALLOW).map(|i| format!("/m{i}")).collect();
        assert_eq!(validate_cwd(&full, &d.path().to_string_lossy()), Err(CwdReject::TooMany));
        let almost = &full[..MAX_ALLOW - 1];
        assert!(validate_cwd(almost, &d.path().to_string_lossy()).is_ok());
        assert!(CwdReject::TooMany.text().contains("50"));
    }

    #[test]
    fn 加入_存進真實格式的存檔並保留其他欄位() {
        let data = tempfile::tempdir().unwrap();
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let pa = norm_path(&a.path().to_string_lossy()).unwrap();
        w(&data.path().join("launch-prefs.json"), &real_prefs(&[pa.clone()], &[pa.clone()]).to_string());
        let added = add_validated(data.path(), &b.path().to_string_lossy()).unwrap();
        let prefs = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&prefs, "cwdAllow"), vec![pa.clone(), added]);
        assert_eq!(prefs["maxPerHourSet"], 3);
        assert_eq!(prefs["launchDisplay"], "background");
        assert!(matches!(add_validated(data.path(), &pa), Err(CwdReject::Duplicate(_))));
        assert!(matches!(add_validated(data.path(), "  "), Err(CwdReject::Empty)));
    }

    #[test]
    fn 移除_依正規路徑比對一筆_其他不動() {
        let data = tempfile::tempdir().unwrap();
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (pa, pb) = (norm_path(&a.path().to_string_lossy()).unwrap(), norm_path(&b.path().to_string_lossy()).unwrap());
        w(&data.path().join("launch-prefs.json"), &real_prefs(&[pa.clone(), pb.clone()], &[]).to_string());
        // 尾端斜線的寫法也移得掉
        let left = remove_from_prefs_allow(data.path(), &format!("{pa}/")).unwrap();
        assert_eq!(left, vec![pb.clone()]);
        let prefs = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&prefs, "cwdAllow"), vec![pb]);
        assert_eq!(prefs["maxPerHourSet"], 3);
        // 不在清單裡：白話錯誤、存檔不變
        assert_eq!(remove_from_prefs_allow(data.path(), &pa).unwrap_err(), "清單裡找不到這個資料夾");
        assert!(remove_from_prefs_allow(data.path(), " ").is_err());
    }

    #[test]
    fn 整份存檔_不合格的新項目整份拒絕() {
        let (a, d) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let pa = norm_path(&a.path().to_string_lossy()).unwrap();
        let current = real_prefs(&[pa.clone()], &[]);
        let gone = d.path().join("gone").to_string_lossy().into_owned();
        let err = check_prefs_write(&current, &real_prefs(&[pa.clone(), gone], &[])).unwrap_err();
        assert!(err.starts_with("資料夾不存在"), "{err}");
        // 新項目重複（同一份裡出現兩次）也拒
        let b = tempfile::tempdir().unwrap();
        let pb = b.path().to_string_lossy().into_owned();
        assert!(check_prefs_write(&current, &real_prefs(&[pa.clone(), pb.clone(), format!("{pb}/")], &[])).unwrap_err().contains("已經在清單裡"));
        // 格式不對
        assert!(check_prefs_write(&current, &json!({ "cwdAllow": "D:/a" })).is_err());
        assert!(check_prefs_write(&current, &json!({ "cwdAllow": [1] })).is_err());
        // 合格的新項目通過
        assert!(check_prefs_write(&current, &real_prefs(&[pa, pb], &[])).is_ok());
    }

    #[test]
    fn 整份存檔_舊清單裡已不存在的資料夾保留_不被拒也不被清() {
        let data = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let pa = norm_path(&a.path().to_string_lossy()).unwrap();
        let old_gone = data.path().join("已刪掉的舊專案").to_string_lossy().into_owned();
        let current = real_prefs(&[old_gone.clone(), pa.clone()], &[]);
        // 只是改別的欄位（上限）、或沒帶 cwdAllow：放行
        assert!(check_prefs_write(&current, &real_prefs(&[old_gone.clone(), pa.clone()], &[pa.clone()])).is_ok());
        assert!(check_prefs_write(&current, &json!({ "maxPerHourSet": 5 })).is_ok());
        // 用斜線不同的寫法帶舊項目（Windows）也算舊的
        #[cfg(windows)]
        assert!(check_prefs_write(&current, &real_prefs(&[old_gone.replace('\\', "/").to_uppercase(), pa.clone()], &[])).is_ok());
        // 移除舊的不存在項目：放行
        assert!(check_prefs_write(&current, &real_prefs(&[pa.clone()], &[])).is_ok());
        // 舊的留著、同時加不合格的新項目：整份拒絕
        let bad = data.path().join("nope").to_string_lossy().into_owned();
        assert!(check_prefs_write(&current, &real_prefs(&[old_gone, pa, bad], &[])).is_err());
    }

    #[test]
    fn 使用時的三道檢查仍擋_白名單裡存在的才放行() {
        // 舊清單裡不存在的資料夾：存檔可以保留，但開窗時 check_launch 照舊拒絕（這張沒有拿掉任何使用時的檢查）
        let d = tempfile::tempdir().unwrap();
        let gone = d.path().join("gone");
        let mut c = cfg(vec![canonical_launch_cwd(&gone.to_string_lossy()).unwrap()]);
        c.profiles.insert(
            "p".into(),
            crate::launch::profiles::Profile {
                label: "p".into(),
                command: "x".into(),
                args: vec![],
                engine: String::new(),
                mode: crate::launch::profiles::LaunchMode::Window,
                disabled: false,
                disabled_reason: String::new(),
            },
        );
        let mut req = crate::launch::config::LaunchReq { profile: "p", name: "w1", cwd: gone.to_string_lossy().into_owned() };
        let r = crate::launch::config::check_launch(&c, &mut req, &[], 0);
        assert!(r.is_err(), "{r:?}");
    }

    #[test]
    fn 存檔命令_不合格新項目被拒_舊的不存在項目保留() {
        let data = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let pa = norm_path(&a.path().to_string_lossy()).unwrap();
        let old_gone = data.path().join("已刪掉的舊專案").to_string_lossy().into_owned();
        // 舊存檔：直接寫檔（模擬升級前存下的，含已不存在的資料夾）
        w(&data.path().join("launch-prefs.json"), &real_prefs(&[old_gone.clone(), pa.clone()], &[]).to_string());
        // 新增不存在的資料夾：整份拒絕，檔案不變
        let bad = data.path().join("nope").to_string_lossy().into_owned();
        let err = crate::launch::launch_prefs_set_checked(data.path(), real_prefs(&[old_gone.clone(), pa.clone(), bad], &[])).unwrap_err();
        assert!(err.starts_with("資料夾不存在"), "{err}");
        let after = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&after, "cwdAllow"), vec![old_gone.clone(), pa.clone()], "被拒時存檔不變");
        // 改上限、帶著舊清單存：通過，舊項目還在
        let mut keep = real_prefs(&[old_gone.clone(), pa.clone()], &[]);
        keep["maxPerHourSet"] = json!(5);
        crate::launch::launch_prefs_set_checked(data.path(), keep).unwrap();
        let after = launch_prefs_get_sync(data.path()).unwrap();
        assert_eq!(str_list(&after, "cwdAllow"), vec![old_gone, pa]);
        assert_eq!(after["maxPerHourSet"], 5);
    }
}
