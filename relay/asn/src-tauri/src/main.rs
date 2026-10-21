#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `asn send …` 之類的命令列呼叫：不開視窗、不碰單一執行個體鎖（備援入口；正式的命令列入口是 asn-cli.exe）
    let args: Vec<String> = std::env::args().skip(1).collect();
    if asn_lib::cli::is_subcommand(&args) {
        std::process::exit(asn_lib::cli::run_attached(&args));
    }
    asn_lib::run()
}
