//! asn-bridge：無視窗橋（Linux 伺服器用）。不編進 Tauri，只跑內建收發室核心。用法見 `asn-bridge --help`。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(asn_lib::headless::main_with(&args));
}
