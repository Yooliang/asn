//! 命令列入口（console 子系統）：asn-cli send／recv／room／attach。
//! 和 asn.exe（GUI 子系統）分開的原因：GUI 子系統的程式從 cmd／PowerShell 執行時，殼層不會等它結束、拿不到結束碼，
//! 也沒有主控台可以輸出；console 子系統的獨立小執行檔沒有這些問題，也不會在 GUI 啟動時閃出黑視窗。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(asn_lib::cli::run_process(&args));
}
