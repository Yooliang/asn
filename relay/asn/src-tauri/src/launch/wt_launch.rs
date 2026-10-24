//! 用 Windows Terminal 開夥伴：一個夥伴一個專屬視窗（不開成分頁），這樣主控台切換才能單獨顯示／隱藏它。
//! 這裡只有純邏輯（參數組裝、視窗名稱規則、預設終端機判斷）；真的去呼叫 wt.exe 的在 [`spawn_wt`]。
//! 預設終端機是傳統主控台（conhost）或沒有 wt.exe 時一律不用，維持原本 PowerShell Start-Process 的行為。
#[cfg(windows)]
use std::path::Path;

/// Windows Terminal 的「讓 Windows 決定」「Windows Terminal」「Windows Terminal Preview」「傳統主控台」代號（HKCU\Console\%%Startup\DelegationTerminal）
const DELEG_LET_WINDOWS_DECIDE: &str = "{00000000-0000-0000-0000-000000000000}";
const DELEG_WT: &str = "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}";
const DELEG_WT_PREVIEW: &str = "{86633F1F-6454-40EC-89CE-DA4EBFC67D1D}";
const DELEG_CONHOST: &str = "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}";
/// Windows 11 22H2：「讓 Windows 決定」起預設就是 Windows Terminal
const WIN11_22H2_BUILD: u32 = 22621;

const NAME_MAX_CHARS: usize = 40;

fn clean(name: &str) -> String {
    let t: String = name.chars().filter(|c| !c.is_control() && *c != ';').collect();
    let t: String = t.trim().chars().take(NAME_MAX_CHARS).collect();
    if t.is_empty() { "partner".to_string() } else { t }
}

/// 專屬視窗名稱（wt 的 `-w`）：asn- 加夥伴名。前綴確保不會被當成視窗編號或 new／last 這類保留字
pub(crate) fn window_name(name: &str) -> String {
    format!("asn-{}", clean(name))
}

/// 專屬視窗標題（wt 的 `--title`）：ASN- 加夥伴名，人看得出是哪個夥伴
pub(crate) fn window_title(name: &str) -> String {
    format!("ASN-{}", clean(name))
}

/// 名字或資料夾含分號就不走 wt（分號是 wt 的命令分隔符，會被拆成另一條命令）
pub(crate) fn wt_usable(name: &str, cwd: &str) -> bool {
    !name.contains(';') && !cwd.contains(';')
}

/// `wt.exe` 的完整參數：開在這個夥伴專屬的新視窗，標題固定（不讓程式自己改標題），裡面跑和原本一樣的 PowerShell 承載腳本
pub(crate) fn wt_args(name: &str, cwd: &str, command: &str, args: &[String]) -> Vec<String> {
    let title = window_title(name);
    let mut v: Vec<String> = vec!["-w".into(), window_name(name), "new-tab".into(), "-d".into(), super::local::strip_verbatim_prefix(cwd), "--title".into(), title.clone(), "--suppressApplicationTitle".into(), "powershell.exe".into()];
    v.extend(super::local::window_launcher_args(&title, command, args).split(' ').map(str::to_string));
    v
}

/// 要不要用 Windows Terminal 開：delegation＝登錄檔 DelegationTerminal 值；build＝Windows 組建號
pub(crate) fn prefers_wt(delegation: Option<&str>, build: Option<u32>, wt_installed: bool) -> bool {
    if !wt_installed {
        return false;
    }
    let d = delegation.map(|d| d.trim().to_uppercase());
    match d.as_deref() {
        Some(x) if x == DELEG_WT || x == DELEG_WT_PREVIEW => true,
        Some(x) if x == DELEG_CONHOST => false,
        None | Some("") => build.is_some_and(|b| b >= WIN11_22H2_BUILD),
        Some(x) if x == DELEG_LET_WINDOWS_DECIDE => build.is_some_and(|b| b >= WIN11_22H2_BUILD),
        Some(_) => false,
    }
}

/// 解析 `reg query <key> /v <value>` 的輸出，取出該值的資料（REG_SZ）
pub(crate) fn parse_reg_value(output: &str, value: &str) -> Option<String> {
    for line in output.lines() {
        let mut it = line.split_whitespace();
        if it.next() == Some(value) && it.next() == Some("REG_SZ") {
            let rest: Vec<&str> = it.collect();
            if !rest.is_empty() {
                return Some(rest.join(" "));
            }
        }
    }
    None
}

#[cfg(windows)]
fn reg_query(key: &str, value: &str) -> Option<String> {
    use crate::nowin::NoWindow;
    let out = std::process::Command::new("reg.exe").no_window().args(["query", key, "/v", value]).stdin(std::process::Stdio::null()).output().ok()?;
    parse_reg_value(&String::from_utf8_lossy(&out.stdout), value)
}

#[cfg(windows)]
fn wt_exe_path() -> Option<std::path::PathBuf> {
    let p = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Microsoft").join("WindowsApps").join("wt.exe");
    p.exists().then_some(p)
}

/// 這台電腦開終端機視窗時，預設用的是不是 Windows Terminal（且有 wt.exe）
#[cfg(windows)]
pub(crate) fn default_is_wt() -> bool {
    if wt_exe_path().is_none() {
        return false;
    }
    let deleg = reg_query(r"HKCU\Console\%%Startup", "DelegationTerminal");
    let build = reg_query(r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber").and_then(|b| b.trim().parse::<u32>().ok());
    prefers_wt(deleg.as_deref(), build, true)
}

/// 真的呼叫 wt.exe 開專屬視窗；wt.exe 只是轉交給 Windows Terminal 就結束，回傳它自己的 pid（只用於記錄）
#[cfg(windows)]
pub(crate) fn spawn_wt(name: &str, cwd: &Path, command: &str, args: &[String]) -> Result<u32, String> {
    use crate::nowin::NoWindow;
    let exe = wt_exe_path().ok_or_else(|| "找不到 wt.exe".to_string())?;
    let cwd_s = cwd.to_string_lossy().to_string();
    let mut c = std::process::Command::new(exe)
        .no_window()
        .env_clear()
        .envs(super::config::child_env())
        .args(wt_args(name, &cwd_s, command, args))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("wt.exe 開不起來：{e}"))?;
    let pid = c.id();
    std::thread::spawn(move || {
        let _ = c.wait();
    });
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 視窗名稱與標題規則() {
        assert_eq!(window_name("小良哥 1"), "asn-小良哥 1");
        assert_eq!(window_title("小良哥 1"), "ASN-小良哥 1");
        assert_eq!(window_name("0"), "asn-0", "純數字名字不會被當成視窗編號");
        assert_eq!(window_name("new"), "asn-new", "保留字也安全");
        assert_eq!(window_name("a;b\nc"), "asn-abc", "分號與控制字元拿掉");
        assert_eq!(window_name(""), "asn-partner", "空名字有預設");
        assert_eq!(window_name(&"長".repeat(100)).chars().count(), 4 + 40, "名字最多 40 字");
        assert_ne!(window_name("甲"), window_name("乙"), "不同夥伴不同視窗");
    }

    #[test]
    fn wt參數_專屬新視窗_固定標題_承載腳本() {
        let a = wt_args("小良哥 1", r"\\?\D:\my proj", r"C:\Program Files\c\claude.exe", &v(&["--model", "opus"]));
        assert_eq!(&a[..9], &["-w", "asn-小良哥 1", "new-tab", "-d", r"D:\my proj", "--title", "ASN-小良哥 1", "--suppressApplicationTitle", "powershell.exe"]);
        assert!(a.contains(&"-NoExit".to_string()) && a.contains(&"-EncodedCommand".to_string()));
        assert!(a.iter().all(|x| !x.contains(';')), "編碼後的參數不含分號");
        assert_ne!(a[1], "0", "不再是『最近使用的視窗』（那會變成別人的分頁）");
        assert!(!a.contains(&"-w".to_string()) || a.iter().filter(|x| *x == "-w").count() == 1);
    }

    #[test]
    fn 分號_名字或資料夾含分號就不走wt() {
        assert!(wt_usable("小良哥", r"D:\proj"));
        assert!(!wt_usable("甲;乙", r"D:\proj"));
        assert!(!wt_usable("甲", r"D:\a;b"));
    }

    #[test]
    fn 預設終端機判斷_舊行為不變() {
        // 明確選傳統主控台：絕不用
        assert!(!prefers_wt(Some("{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}"), Some(26100), true));
        // 明確選 Windows Terminal（含 Preview）：有安裝才用
        assert!(prefers_wt(Some("{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}"), Some(19045), true));
        assert!(prefers_wt(Some("{86633f1f-6454-40ec-89ce-da4ebfc67d1d}"), None, true), "大小寫不拘");
        assert!(!prefers_wt(Some("{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}"), Some(26100), false), "沒裝 wt.exe 就不用");
        // 讓 Windows 決定（或沒設）：Windows 11 22H2 以後才是 Windows Terminal
        assert!(prefers_wt(Some("{00000000-0000-0000-0000-000000000000}"), Some(22621), true));
        assert!(prefers_wt(None, Some(26100), true));
        assert!(!prefers_wt(None, Some(19045), true), "Windows 10 預設是傳統主控台");
        assert!(!prefers_wt(None, None, true), "組建號讀不到就保守不用");
        assert!(!prefers_wt(Some("{未知的代號}"), Some(26100), true), "不認得的終端機不碰");
    }

    #[test]
    fn 解析reg_query輸出() {
        let out = "\r\nHKEY_CURRENT_USER\\Console\\%%Startup\r\n    DelegationTerminal    REG_SZ    {E12CFF52-A866-4C77-9A90-F570A7AA2C6B}\r\n\r\n";
        assert_eq!(parse_reg_value(out, "DelegationTerminal").as_deref(), Some("{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}"));
        assert_eq!(parse_reg_value(out, "Other"), None);
        assert_eq!(parse_reg_value("錯誤：系統找不到指定的登錄機碼或值", "DelegationTerminal"), None);
        let b = "    CurrentBuildNumber    REG_SZ    26100\r\n";
        assert_eq!(parse_reg_value(b, "CurrentBuildNumber").as_deref(), Some("26100"));
    }
}
