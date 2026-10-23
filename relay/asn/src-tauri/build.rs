// gui（預設）：照 Tauri 的規矩建置。沒有 gui（--no-default-features，無視窗橋）：不碰 tauri-build，
// 只補上原本由它宣告的 `desktop` 條件，讓電腦端共用的收發室核心照樣編進去。
fn main() {
    #[cfg(feature = "gui")]
    tauri_build::build();
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
