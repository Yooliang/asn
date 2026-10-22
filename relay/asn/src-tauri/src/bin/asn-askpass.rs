//! 密碼小幫手（console 子系統）：設成 GIT_ASKPASS／SSH_ASKPASS 後，git／ssh 要密碼時會呼叫它。
//! 它自己不收密碼：只經本機管道請正在執行的 ASN 跳窗，拿到的密碼印到標準輸出。ASN 沒開就直接失敗。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(asn_lib::askpass::run_process(&args));
}
