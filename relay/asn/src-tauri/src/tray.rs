//! 系統匣：關閉視窗時縮到系統匣（可改成結束程式）、系統匣圖示（左鍵叫回、右鍵「開啟」「結束」、提示文字帶未讀數）、
//! 登入系統時自動啟動（Windows 寫 HKCU Run、Linux 寫 XDG autostart；其他系統不支援）。
//! 縮到系統匣時只是把名單視窗藏起來：程序、收信、心跳、門鈴與右下角提示都照常（提示視窗是獨立視窗）。
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

pub const TRAY_ID: &str = "main";
/// 自動啟動時帶的參數：開機啟動只要常駐系統匣，不要一登入就跳出名單
pub const BACKGROUND_FLAG: &str = "--background";

/// 關閉名單視窗時要縮到系統匣（預設 true）還是結束程式
pub struct CloseToTray(pub AtomicBool);
impl Default for CloseToTray {
    fn default() -> Self {
        Self(AtomicBool::new(true))
    }
}

/// 系統匣圖示建立失敗（例如 Linux 沒有 appindicator）：此時關閉一律結束，免得視窗藏起來叫不回來
#[derive(Default)]
pub struct TrayFailed(pub AtomicBool);

/// 存檔文字（asn-me.json）→ 是不是縮到系統匣：只有明確寫 `"closeTo":"quit"` 才是結束；沒這欄位的舊存檔、壞檔、壞值一律縮到系統匣
pub fn close_to_tray_from_saved(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("closeTo")?.as_str().map(|c| c != "quit")).unwrap_or(true)
}

/// 系統匣圖示的提示文字
pub fn tooltip(unread: u32) -> String {
    if unread == 0 { "ASN 即時通".into() } else { format!("ASN 即時通（{unread} 則未讀）") }
}

/// 關閉名單視窗時要不要攔下改成隱藏
pub fn should_hide_on_close(close: &CloseToTray, failed: &TrayFailed) -> bool {
    close.0.load(Ordering::Relaxed) && !failed.0.load(Ordering::Relaxed)
}

/// 開機：照存檔設定關閉行為
pub fn init(app: &AppHandle, to_tray: bool) {
    app.state::<CloseToTray>().0.store(to_tray, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_close_to_tray(state: State<'_, CloseToTray>, tray: bool) {
    state.0.store(tray, Ordering::Relaxed);
}

/// 建系統匣圖示；建不起來不影響主程式，只是少了圖示
pub fn build(app: &AppHandle) {
    let built = (|| -> tauri::Result<()> {
        let open = MenuItem::with_id(app, "open", "開啟", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &quit])?;
        let mut b = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip(tooltip(0))
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, ev| match ev.id().as_ref() {
                "open" => crate::wins::show_main(app.clone()),
                "quit" => crate::quit_app(app.clone()),
                _ => {}
            })
            .on_tray_icon_event(|tray, ev| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                    crate::wins::show_main(tray.app_handle().clone());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            b = b.icon(icon.clone());
        }
        b.build(app)?;
        Ok(())
    })();
    if let Err(e) = built {
        eprintln!("系統匣圖示建立失敗：{e}");
        app.state::<TrayFailed>().0.store(true, Ordering::Relaxed);
    }
}

/// 前端回報目前總未讀數，更新圖示的提示文字
#[tauri::command]
pub fn set_tray_unread(app: AppHandle, n: u32) {
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_tooltip(Some(tooltip(n)));
    }
}

/// 設定頁開機時問：系統匣是不是真的建起來了（沒有的話「縮到系統匣」不會生效）
#[tauri::command]
pub fn tray_available(failed: State<'_, TrayFailed>) -> bool {
    !failed.0.load(Ordering::Relaxed)
}

// ───────── 登入時自動啟動 ─────────

/// 這個系統支不支援（不支援就隱藏開關）
#[tauri::command]
pub fn autostart_supported() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

/// 現在有沒有開自動啟動（以系統上真實的登錄值／.desktop 檔為準，不另存一份）。--shot 測試模式不碰系統。
#[tauri::command]
pub fn autostart_get(app: State<'_, crate::App>) -> bool {
    app.shot.is_none() && sys::get()
}

#[tauri::command]
pub fn autostart_set(app: State<'_, crate::App>, on: bool) -> Result<(), String> {
    if app.shot.is_some() {
        return Err("--shot 模式不改系統設定".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    autostart_check(on, &exe)?;
    sys::set(on, &exe)
}

/// 開發版（cargo 建置資料夾底下的執行檔）不能寫開機啟動：登錄會指到開發資料夾，正式版收不到更新、建置時檔案被占用
pub const DEV_BUILD_AUTOSTART_MSG: &str = "開發版不能設定開機自動啟動，請用正式安裝的 ASN";

/// 執行檔路徑是不是在 cargo 的 target 資料夾底下（路徑含 \target\release\ 或 \target\debug\，大小寫不分，斜線反斜線都算）
pub fn is_dev_build_path(exe: &std::path::Path) -> bool {
    let p = format!("\\{}", exe.display().to_string().replace('/', "\\").to_lowercase());
    p.contains("\\target\\release\\") || p.contains("\\target\\debug\\")
}

/// 這個執行檔不能開機啟動時的中文原因（正式版回 None）。設定頁用它顯示原因、把開關反灰
#[tauri::command]
pub fn autostart_blocked() -> Option<String> {
    std::env::current_exe().ok().filter(|e| is_dev_build_path(e)).map(|_| DEV_BUILD_AUTOSTART_MSG.to_string())
}

/// 寫入前的檢查：開啟時開發版一律拒絕；關閉永遠放行（讓人清掉以前誤寫的項目）
pub fn autostart_check(on: bool, exe: &std::path::Path) -> Result<(), String> {
    if on && is_dev_build_path(exe) {
        return Err(DEV_BUILD_AUTOSTART_MSG.into());
    }
    Ok(())
}

/// Windows Run 登錄值：路徑用雙引號包住，後面接背景參數
pub fn run_value(exe: &std::path::Path) -> String {
    format!("\"{}\" {BACKGROUND_FLAG}", exe.display())
}

/// 判斷 `reg query` 的輸出裡有沒有 ASN 這個值
pub fn reg_query_has_value(out: &str) -> bool {
    out.lines().any(|l| {
        let mut it = l.split_whitespace();
        it.next() == Some("ASN") && it.next() == Some("REG_SZ")
    })
}

/// XDG autostart 的 .desktop 內容（Exec 的路徑加引號並跳脫）
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn desktop_entry(exe: &std::path::Path) -> String {
    let p = exe.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    format!("[Desktop Entry]\nType=Application\nName=ASN\nComment=ASN 即時通\nExec=\"{p}\" {BACKGROUND_FLAG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n")
}

#[cfg(windows)]
mod sys {
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    use crate::nowin::NO_WINDOW;
    pub fn get() -> bool {
        Command::new("reg").args(["query", KEY, "/v", "ASN"]).creation_flags(NO_WINDOW).output().map(|o| o.status.success() && super::reg_query_has_value(&String::from_utf8_lossy(&o.stdout))).unwrap_or(false)
    }
    pub fn set(on: bool, exe: &Path) -> Result<(), String> {
        let mut c = Command::new("reg");
        if on {
            c.args(["add", KEY, "/v", "ASN", "/t", "REG_SZ", "/d"]).arg(super::run_value(exe)).arg("/f");
        } else if !get() {
            return Ok(());
        } else {
            c.args(["delete", KEY, "/v", "ASN", "/f"]);
        }
        let o = c.creation_flags(NO_WINDOW).output().map_err(|e| e.to_string())?;
        if o.status.success() { Ok(()) } else { Err(format!("寫入登錄失敗：{}", String::from_utf8_lossy(&o.stderr).trim())) }
    }
}

#[cfg(target_os = "linux")]
mod sys {
    use std::path::{Path, PathBuf};
    fn file() -> PathBuf {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| crate::identity::home_dir().join(".config"));
        base.join("autostart").join("asn.desktop")
    }
    pub fn get() -> bool {
        file().is_file()
    }
    pub fn set(on: bool, exe: &Path) -> Result<(), String> {
        let f = file();
        if on {
            crate::write_atomic(&f, &super::desktop_entry(exe)).map_err(|e| e.to_string())
        } else {
            match std::fs::remove_file(&f) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod sys {
    pub fn get() -> bool {
        false
    }
    pub fn set(_on: bool, _exe: &std::path::Path) -> Result<(), String> {
        Err("這個系統不支援自動啟動".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn 關閉行為_預設縮到系統匣_只有明確寫_quit_才結束() {
        assert!(!close_to_tray_from_saved(r#"{"closeTo":"quit","sound":true}"#));
        assert!(close_to_tray_from_saved(r#"{"closeTo":"tray"}"#));
        for t in [r#"{"sound":true}"#, r#"{"closeTo":null}"#, r#"{"closeTo":true}"#, r#"{"closeTo":"Quit"}"#, "{壞掉", ""] {
            assert!(close_to_tray_from_saved(t), "{t}");
        }
    }

    #[test]
    fn 攔下關閉的條件_要選了縮到系統匣且圖示真的建起來() {
        let (c, f) = (CloseToTray::default(), TrayFailed::default());
        assert!(should_hide_on_close(&c, &f));
        c.0.store(false, Ordering::Relaxed);
        assert!(!should_hide_on_close(&c, &f));
        c.0.store(true, Ordering::Relaxed);
        f.0.store(true, Ordering::Relaxed);
        assert!(!should_hide_on_close(&c, &f), "沒有系統匣圖示就不能藏視窗");
    }

    #[test]
    fn 提示文字帶未讀數() {
        assert_eq!(tooltip(0), "ASN 即時通");
        assert_eq!(tooltip(3), "ASN 即時通（3 則未讀）");
    }

    #[test]
    fn 登錄值與查詢解析() {
        assert_eq!(run_value(Path::new(r"C:\Users\a b\asn.exe")), "\"C:\\Users\\a b\\asn.exe\" --background");
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ASN    REG_SZ    \"C:\\x\\asn.exe\" --background\r\n\r\n";
        assert!(reg_query_has_value(out));
        assert!(!reg_query_has_value("    OTHER    REG_SZ    x\r\n"));
        assert!(!reg_query_has_value(""));
    }

    #[test]
    fn 開發版路徑判斷_target_release_與_debug_大小寫不分() {
        for p in [r"D:\Github\asn\relay\asn\src-tauri\target\release\asn.exe", r"d:\x\TARGET\Debug\asn.exe", "/home/u/asn/src-tauri/target/release/asn", r"C:\a\Target\RELEASE\deps\asn.exe"] {
            assert!(is_dev_build_path(Path::new(p)), "{p}");
        }
        for p in [r"C:\Program Files\ASN\asn.exe", r"C:\Users\a\AppData\Local\ASN\asn.exe", r"D:\targets\release2\asn.exe", r"D:\x\target\asn.exe", r"D:\x\mytarget\release\asn.exe", "/opt/asn/asn"] {
            assert!(!is_dev_build_path(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn 開發版寫開機啟動被拒絕_關閉放行() {
        let dev = Path::new(r"D:\g\src-tauri\target\release\asn.exe");
        assert_eq!(autostart_check(true, dev).unwrap_err(), "開發版不能設定開機自動啟動，請用正式安裝的 ASN");
        assert!(autostart_check(false, dev).is_ok(), "關閉要放行，才清得掉以前誤寫的項目");
        assert!(autostart_check(true, Path::new(r"C:\Program Files\ASN\asn.exe")).is_ok());
    }

    #[test]
    fn desktop_檔內容() {
        let t = desktop_entry(Path::new("/opt/my asn/asn"));
        assert!(t.starts_with("[Desktop Entry]\n") && t.contains("Exec=\"/opt/my asn/asn\" --background\n") && t.contains("Terminal=false"));
        assert!(desktop_entry(Path::new("/a\"b")).contains("Exec=\"/a\\\"b\""));
    }
}
