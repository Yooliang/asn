// gui（預設）：照 Tauri 的規矩建置。沒有 gui（--no-default-features，無視窗橋）：不碰 tauri-build，
// 只補上原本由它宣告的 `desktop` 條件，讓電腦端共用的收發室核心照樣編進去。
//
// Windows 安裝檔會附帶 WezTerm（tauri.windows.conf.json 列了 resources/wezterm 底下的檔案，由 scripts/fetch-wezterm.mjs 取得）。
// Tauri 建置時檔案不存在就會報錯，連 cargo test 都過不了；所以沒取過時先放空檔占位（不進 git）。
// 空檔不算就緒——發版腳本會重新取得；占位的空檔若被打進安裝檔，ASN 執行時也會因為檔案是空的而判成找不到。
#[cfg(feature = "gui")]
fn ensure_wezterm_placeholders() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("wezterm");
    let _ = std::fs::create_dir_all(&dir);
    for f in ["wezterm-gui.exe", "wezterm.exe", "conpty.dll", "OpenConsole.exe", "libEGL.dll", "libGLESv2.dll", "LICENSE.md", "SOURCE.txt"] {
        let p = dir.join(f);
        if !p.exists() {
            let _ = std::fs::write(&p, b"");
        }
    }
}

fn main() {
    #[cfg(feature = "gui")]
    {
        ensure_wezterm_placeholders();
        tauri_build::build();
    }
    #[cfg(not(feature = "gui"))]
    {
        println!("cargo:rustc-check-cfg=cfg(desktop)");
        println!("cargo:rustc-check-cfg=cfg(mobile)");
        let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        if target != "android" && target != "ios" {
            println!("cargo:rustc-cfg=desktop");
        } else {
            println!("cargo:rustc-cfg=mobile");
        }
    }
}
