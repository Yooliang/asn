//! 開 pi 互動視窗（開新夥伴選 pi）：組啟動參數與環境變數。
//! - 要載入 ASN 的 pi 擴充（`-e <index.ts>`），pi 才會登記到名單、收信、回信；已經 `pi install` 過就不再重複載入。
//! - `ASN_PI_NAME` 設成使用者取的名字，名單上的視窗名就等於它。
//! - 第一句話放在最後當 pi 的開場訊息（`pi -- "…"`，互動模式照樣留在畫面上）；含 shell 會吃掉的字元時改寫成暫存檔，用 `@檔案` 帶入。
//! 這裡只有純邏輯與讀檔，不啟動任何程式。
use std::path::{Path, PathBuf};

/// 找不到擴充時的說明（不靜默開一個不會收信的 pi）
pub(crate) const NO_EXTENSION_MSG: &str = "找不到 pi 擴充，開出來的 pi 不會收信。請先執行 pi install <ASN 的 relay/pi-extension 資料夾>，或重新安裝 ASN 後再試";

/// 擴充的取得狀況
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExtState {
    /// 使用者的 pi 已經裝了這個擴充：不加 -e
    Installed,
    /// 找到擴充的 index.ts：用 -e 載入
    Path(PathBuf),
    /// 都找不到
    Missing,
}

pub(crate) struct PiPlan {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn has_index(dir: &Path) -> Option<PathBuf> {
    let p = dir.join("pi-extension").join("index.ts");
    p.is_file().then_some(p)
}

/// 從執行檔所在資料夾往上找：安裝資料夾裡是 `<安裝>/pi-extension/index.ts`（與執行檔同層）；
/// 開發環境（target/debug/…）往上會碰到 repo 的 `relay/pi-extension/index.ts`。
pub(crate) fn find_pi_extension(start: &Path) -> Option<PathBuf> {
    for a in start.ancestors() {
        if let Some(p) = has_index(a) {
            return Some(p);
        }
        if let Some(p) = has_index(&a.join("relay")) {
            return Some(p);
        }
    }
    None
}

/// pi 的設定裡有沒有裝這個擴充：settings.json 提到 pi-extension，或放在 extensions/asn/
pub(crate) fn extension_installed(settings_text: Option<&str>, auto_dir_has_index: bool) -> bool {
    if auto_dir_has_index {
        return true;
    }
    settings_text.is_some_and(|t| t.replace('\\', "/").to_lowercase().contains("pi-extension"))
}

/// 真的去讀本機狀態（settings.json 只讀不印）
pub(crate) fn resolve_ext_state() -> ExtState {
    let agent = crate::identity::home_dir().join(".pi").join("agent");
    let settings = std::fs::read_to_string(agent.join("settings.json")).ok();
    let auto = agent.join("extensions").join("asn").join("index.ts").is_file();
    if extension_installed(settings.as_deref(), auto) {
        return ExtState::Installed;
    }
    let found = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
        .and_then(|d| find_pi_extension(&d));
    match found {
        Some(p) => ExtState::Path(PathBuf::from(super::local::strip_verbatim_prefix(&p.to_string_lossy()))),
        None => ExtState::Missing,
    }
}

/// 第一句話能不能直接當命令列參數（經過 PowerShell 5.1 與 pi.cmd 都不會被吃掉或拆開）
pub(crate) fn message_arg_safe(m: &str) -> bool {
    !m.starts_with('@') && !m.chars().any(|c| c.is_control() || matches!(c, '"' | '%' | '&' | '|' | '<' | '>' | '^' | '!' | '`' | '\0'))
}

/// 第一句話 → 參數。空的不帶；安全就直接帶；否則寫到 `files_dir` 用 `@檔案` 帶入
pub(crate) fn message_args(msg: &str, files_dir: &Path, name: &str, now_ms: u64) -> Result<Vec<String>, String> {
    let m = msg.trim();
    if m.is_empty() {
        return Ok(vec![]);
    }
    if message_arg_safe(m) {
        return Ok(vec!["--".into(), m.to_string()]);
    }
    std::fs::create_dir_all(files_dir).map_err(|e| format!("第一句話暫存資料夾建不起來：{e}"))?;
    let file = files_dir.join(format!("{name}-{now_ms}.md"));
    std::fs::write(&file, m).map_err(|e| format!("第一句話暫存檔寫不進去：{e}"))?;
    Ok(vec!["--".into(), format!("@{}", super::local::strip_verbatim_prefix(&file.to_string_lossy()))])
}

/// 組出 pi 的完整參數與環境。profile_args＝profile 本身帶的參數（預設空）
pub(crate) fn plan(name: &str, profile_args: &[String], ext: ExtState, first_message: &str, files_dir: &Path, now_ms: u64) -> Result<PiPlan, String> {
    let mut args: Vec<String> = Vec::new();
    match ext {
        ExtState::Installed => {}
        ExtState::Path(p) => {
            args.push("-e".into());
            args.push(p.to_string_lossy().into_owned());
        }
        ExtState::Missing => return Err(NO_EXTENSION_MSG.into()),
    }
    args.extend(profile_args.iter().map(|a| a.replace("{name}", name)));
    args.extend(message_args(first_message, files_dir, name, now_ms)?);
    Ok(PiPlan { args, env: vec![("ASN_PI_NAME".into(), name.to_string())] })
}

/// pi 是互動式：不論 UI 傳什麼，一律前台（hidden＝false）
pub(crate) fn hidden_for(engine: &str, display_bg: bool) -> bool {
    engine != "pi" && display_bg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 有擴充路徑_帶_e_與名字環境變數() {
        let d = tempfile::tempdir().unwrap();
        let p = plan("小皮", &[], ExtState::Path(PathBuf::from(r"C:\ASN\pi-extension\index.ts")), "", d.path(), 1).unwrap();
        assert_eq!(p.args, v(&["-e", r"C:\ASN\pi-extension\index.ts"]));
        assert_eq!(p.env, vec![("ASN_PI_NAME".to_string(), "小皮".to_string())]);
    }

    #[test]
    fn 已安裝擴充_不重複載入() {
        let d = tempfile::tempdir().unwrap();
        let p = plan("小皮", &[], ExtState::Installed, "", d.path(), 1).unwrap();
        assert!(p.args.is_empty());
        assert_eq!(p.env[0].1, "小皮", "名字照樣設");
    }

    #[test]
    fn 找不到擴充_明確報錯_不靜默開() {
        let d = tempfile::tempdir().unwrap();
        let e = plan("小皮", &[], ExtState::Missing, "你好", d.path(), 1).err().unwrap();
        assert!(e.contains("找不到 pi 擴充") && e.contains("pi install"), "{e}");
        assert!(!e.contains("尚在擴充"));
    }

    #[test]
    fn 第一句話_安全就直接帶在最後() {
        let d = tempfile::tempdir().unwrap();
        let p = plan("小皮", &[], ExtState::Path("/x/index.ts".into()), "  請先讀 README，然後 -h 看看  ", d.path(), 1).unwrap();
        assert_eq!(p.args, v(&["-e", "/x/index.ts", "--", "請先讀 README，然後 -h 看看"]));
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0, "不寫暫存檔");
    }

    #[test]
    fn 第一句話_含引號換行或以_at_開頭_改用檔案() {
        for m in ["他說\"好\"", "第一行\n第二行", "50% & 更多", "@secret.txt 內容", "a|b"] {
            assert!(!message_arg_safe(m), "{m}");
            let d = tempfile::tempdir().unwrap();
            let p = plan("小皮", &[], ExtState::Installed, m, d.path(), 77).unwrap();
            assert_eq!(p.args[0], "--");
            let f = p.args[1].strip_prefix('@').expect("@檔案");
            assert!(f.ends_with("小皮-77.md"), "{f}");
            assert_eq!(std::fs::read_to_string(f).unwrap(), m.trim(), "檔案內容原文保留");
        }
    }

    #[test]
    fn 第一句話_空白不帶() {
        let d = tempfile::tempdir().unwrap();
        assert!(plan("小皮", &[], ExtState::Installed, "  \n ", d.path(), 1).unwrap().args.is_empty());
    }

    #[test]
    fn profile參數的名字佔位被換掉_順序在擴充之後_訊息之前() {
        let d = tempfile::tempdir().unwrap();
        let p = plan("小皮", &v(&["--name", "{name}"]), ExtState::Path("/x/index.ts".into()), "嗨", d.path(), 1).unwrap();
        assert_eq!(p.args, v(&["-e", "/x/index.ts", "--name", "小皮", "--", "嗨"]));
    }

    #[test]
    fn 找擴充_安裝資料夾與開發環境兩種配置() {
        let t = tempfile::tempdir().unwrap();
        // 安裝：<安裝>/pi-extension/index.ts，執行檔同層
        let inst = t.path().join("ASN");
        std::fs::create_dir_all(inst.join("pi-extension")).unwrap();
        std::fs::write(inst.join("pi-extension").join("index.ts"), "").unwrap();
        assert_eq!(find_pi_extension(&inst), Some(inst.join("pi-extension").join("index.ts")));
        // 開發：repo/relay/pi-extension/index.ts，執行檔在 relay/asn/src-tauri/target/debug
        let repo = t.path().join("repo");
        std::fs::create_dir_all(repo.join("relay").join("pi-extension")).unwrap();
        std::fs::write(repo.join("relay").join("pi-extension").join("index.ts"), "").unwrap();
        let dbg = repo.join("relay").join("asn").join("src-tauri").join("target").join("debug");
        std::fs::create_dir_all(&dbg).unwrap();
        assert_eq!(find_pi_extension(&dbg), Some(repo.join("relay").join("pi-extension").join("index.ts")));
        // 都沒有
        let none = t.path().join("none").join("a");
        std::fs::create_dir_all(&none).unwrap();
        assert_eq!(find_pi_extension(&none), None);
    }

    #[test]
    fn 判斷已安裝_設定檔提到或放在自動目錄() {
        assert!(extension_installed(Some(r#"{"packages":["D:\\Github\\Yooliang\\asn\\relay\\pi-extension"]}"#), false));
        assert!(extension_installed(None, true));
        assert!(!extension_installed(Some(r#"{"packages":["npm:other"]}"#), false));
        assert!(!extension_installed(None, false));
    }

    #[test]
    fn pi一律前台_其他引擎照舊() {
        assert!(!hidden_for("pi", true));
        assert!(hidden_for("claude", true));
        assert!(!hidden_for("claude", false));
    }
}
