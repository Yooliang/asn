#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `asn send …` 之類的命令列呼叫：不開視窗、不碰單一執行個體鎖（備援入口；正式的命令列入口是 asn-cli.exe）
    let args: Vec<String> = std::env::args().skip(1).collect();
    if asn_lib::cli::is_subcommand(&args) {
        std::process::exit(asn_lib::cli::run_attached(&args));
    }
    // 工作排程每 5 分鐘叫一次的守護（ASN 意外關閉時自動重開，todo-next-191 B1）：不開視窗、判斷一次就結束
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if args.iter().any(|a| a == asn_lib::guard::GUARD_FLAG) {
        std::process::exit(asn_lib::guard::run_guard());
    }
    // 解除安裝前（installer-hooks.nsh）：刪掉自動重開的排程，不開視窗；找不到不算錯
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if args.iter().any(|a| a == asn_lib::guard::REMOVE_FLAG) {
        std::process::exit(asn_lib::guard::run_remove());
    }
    asn_lib::run()
}
