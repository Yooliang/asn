//! 敏感位置裡明確放行的資料夾，和工作者建立時算清單的正式做法。
//! 放行只開在這幾處（每個形式——字面與實際位置——都要各自落在裡面，經捷徑跳出去的照擋）：
//! - 這位工作者自己的資料夾（`<ASN 資料夾>/workers/<自己的名字>` 或 `<機器工作資料夾>/workers/<自己的名字>`，名字要過名字驗證）：
//!   工作資料夾、白名單資料夾、寫入資料夾各自要落在它本身或底下；實際位置也要在同一個預期位置，不能經捷徑落到別處；
//!   它本身是敏感根、或底下含別的敏感根時不放行
//! - 收信附件的下載資料夾（可以整個關掉，見 ATTACHMENTS_READABLE）
//! - agy 的內建說明檔（`.gemini/antigravity-cli/builtin/skills`）
use super::*;

/// 收信附件的下載資料夾（工作資料夾底下的 attachments）要不要開放給背景夥伴讀。領隊還沒裁決，預設開放；要關掉改成 false
pub const ATTACHMENTS_READABLE: bool = true;

/// 要算敏感根的家目錄：工作者環境裡的 USERPROFILE 與 HOME（兩個都算，沒有就不算）＋這台電腦實際的使用者資料夾（real_home，測試傳 None）
pub fn homes_from(env: &[(String, String)], real_home: Option<PathBuf>) -> Vec<PathBuf> {
    let get = |n: &str| env.iter().find(|(k, v)| k.eq_ignore_ascii_case(n) && !v.trim().is_empty()).map(|(_, v)| PathBuf::from(v));
    let mut out: Vec<PathBuf> = vec![];
    for h in [get("USERPROFILE"), get("HOME"), real_home].into_iter().flatten().filter(|h| !h.as_os_str().is_empty()) {
        if !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

/// 工作者建立時算敏感清單的唯一做法（Worker::new 呼叫，測試也走這裡）：
/// 家目錄＝環境裡的 USERPROFILE、HOME 加上 real_home（正式是這台電腦實際的使用者資料夾，測試傳假的）；
/// 環境變數只帶名字不像金鑰的（展開變數與環境變數指定的位置用）；
/// name、own_dirs（工作資料夾、白名單資料夾、寫入資料夾）、work_dir 用來算明確放行的資料夾
pub fn roots_for_worker(env: &[(String, String)], real_home: PathBuf, name: &str, own_dirs: &[&Path], work_dir: &Path) -> SensitiveRoots {
    let safe: Vec<(String, String)> = env
        .iter()
        .filter(|(k, _)| {
            let u = k.to_uppercase();
            !["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"].iter().any(|w| u.contains(w))
        })
        .cloned()
        .collect();
    SensitiveRoots::build(&homes_from(env, Some(real_home)), &safe).with_workdirs(name, own_dirs, work_dir, ATTACHMENTS_READABLE)
}

/// 測試用：目前的環境變數，拿掉所有會指到使用者資料夾與各工具資料夾的變數。
/// 工作者建立時敏感清單會把家目錄算進去（會對那些位置做解析），測試的引擎環境用這個，才不會去碰測試機上真的使用者資料夾
#[cfg(test)]
pub fn env_without_homes() -> Vec<(String, String)> {
    const DROP: [&str; 12] = ["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "PI_CODING_AGENT_DIR", "ASN_HOME", "IRORI_HOME", "ASN_CLAUDE_HOME", "ASN_GROK_HOME"];
    std::env::vars().filter(|(k, _)| !DROP.iter().any(|d| d.eq_ignore_ascii_case(k))).collect()
}

impl SensitiveRoots {
    /// 算明確放行的資料夾（字面與實際位置兩種形式各自判斷）
    pub fn with_workdirs(mut self, name: &str, own_dirs: &[&Path], work_dir: &Path, attachments: bool) -> SensitiveRoots {
        let canon = self.canon;
        let mut asn: Vec<String> = vec![];
        for h in &self.home_paths {
            for n in [crate::home::NEW_NAME, crate::home::LEGACY_NAME] {
                push_forms(&mut asn, &h.join(n), canon);
            }
        }
        for k in ["ASN_HOME", "IRORI_HOME"] {
            if let Some((_, v)) = self.env.iter().find(|(a, b)| a.eq_ignore_ascii_case(k) && !b.trim().is_empty()) {
                push_forms(&mut asn, Path::new(v.trim()), canon);
            }
        }
        if let Some(p) = crate::home::override_dir_in(&self.env) {
            push_forms(&mut asn, &p, canon); // 跟 home 解析同一套：相對值也算進來
        }
        // 容器的位置一律由「上層的各形式＋固定的下一層」組出來，不去解開容器自己：容器自己若是捷徑，它的實際位置就不在預期位置，不放行。
        // 自己的容器有兩個位置（名字要先過名字驗證）：ASN 資料夾底下的 workers/<名字>、機器工作資料夾底下的 workers/<名字>
        let mut work_forms: Vec<String> = vec![];
        push_forms(&mut work_forms, work_dir, canon);
        let mut own: Vec<String> = vec![];
        if crate::bridge::engines::acp_config::valid_name(name) {
            let n = nstr(name);
            for base in asn.iter().chain(work_forms.iter()) {
                let c = format!("{base}/workers/{n}");
                if !own.contains(&c) {
                    own.push(c);
                }
            }
        }
        let strictly_in_asn = |c: &String| asn.iter().any(|a| c.starts_with(&format!("{a}/")));
        own.retain(strictly_in_asn);
        let mut att: Vec<String> = work_forms.iter().map(|w| format!("{w}/attachments")).collect();
        att.retain(strictly_in_asn);
        let mut dirs: Vec<String> = vec![];
        // 每個形式（字面、實際位置）各自要落在指定的容器資料夾裡（容器本身算不算由 or_equal 決定）、而且底下不含別的敏感根才算；捷徑指到別處的那一種形式不收
        let roots = self.roots.clone();
        let mut add = |dir: &Path, containers: &[String], or_equal: bool| {
            let mut forms: Vec<String> = vec![];
            push_forms(&mut forms, dir, canon);
            for f in forms {
                let inside = containers.iter().any(|c| f.starts_with(&format!("{c}/")) || (or_equal && f == *c));
                let holds_a_root = roots.iter().any(|r| *r == f || r.starts_with(&format!("{f}/")));
                if inside && !holds_a_root && !dirs.contains(&f) {
                    dirs.push(f);
                }
            }
        };
        // 工作資料夾與所有寫入／白名單資料夾：同一條規則
        for d in own_dirs {
            add(d, &own, true);
        }
        if attachments {
            add(&work_dir.join("attachments"), &att, true);
        }
        for h in &self.home_paths {
            if let Some(gemini) = agy_brain(h).parent().and_then(Path::parent) {
                let mut cont: Vec<String> = vec![];
                push_forms(&mut cont, gemini, canon);
                add(&agy_brain(h).parent().unwrap().join("builtin").join("skills"), &cont, false);
            }
        }
        self.exempt_dirs = dirs;
        self
    }

    pub(super) fn exempt(&self, f: &str) -> bool {
        self.exempt_dirs.iter().any(|d| f == d || f.starts_with(&format!("{d}/")))
    }
}
