//! 小幫手這一端（asn-askpass）：被 git／ssh 當作 GIT_ASKPASS／SSH_ASKPASS 呼叫。
//! 它自己「不收密碼」：沒有任何輸入欄、不讀標準輸入、不開視窗。ASN 沒開就直接失敗。
//! 密碼只存在於：管道收到的緩衝（用完立刻清掉）→ 印到標準輸出。
use super::pipe;
use super::proto::*;
use std::io::{Read, Write};
use zeroize::Zeroizing;

pub const EXIT_OK: i32 = 0;
/// ASN 沒開或連不上
pub const EXIT_UNAVAILABLE: i32 = 1;
/// 使用者按取消
pub const EXIT_CANCELLED: i32 = 2;
/// 確認窗逾時
pub const EXIT_TIMEOUT: i32 = 3;
/// 忙碌、不支援的提示、請求被拒
pub const EXIT_REFUSED: i32 = 4;
/// 管道對面不是 ASN
pub const EXIT_NOT_ASN: i32 = 5;

pub struct ClientEnv {
    pub pipe_name: String,
    /// 管道對面伺服器行程必須是這個執行檔；None＝不檢查（只有除錯版的測試管道允許）
    pub expected_server: Option<std::path::PathBuf>,
    pub cwd: String,
    /// SSH_ASKPASS_PROMPT 的值（ssh 8.4 起會帶：confirm＝要是／否、none＝只是顯示訊息）
    pub ssh_prompt_kind: Option<String>,
}

impl ClientEnv {
    pub fn from_process() -> ClientEnv {
        let name = pipe::pipe_name();
        let is_test = name.starts_with(pipe::TEST_PREFIX);
        let expected = if is_test { None } else { std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(if cfg!(windows) { "asn.exe" } else { "asn" }))) };
        ClientEnv {
            pipe_name: name,
            expected_server: expected,
            cwd: std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default(),
            ssh_prompt_kind: std::env::var("SSH_ASKPASS_PROMPT").ok(),
        }
    }
}

/// 管道上的一問一答（對任何可讀可寫的東西都成立，所以可以用記憶體假資料測）。成功回密碼位元組，失敗回拒絕原因
pub fn talk<S: Read + Write>(s: &mut S, req: &Request) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut line = serde_json::to_vec(req).map_err(|e| e.to_string())?;
    line.push(b'\n');
    s.write_all(&line).and_then(|_| s.flush()).map_err(|_| "unavailable".to_string())?;
    // 標頭逐位元組讀到換行，不多讀（多讀的緩衝可能含密碼）
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    loop {
        match s.read(&mut b) {
            Ok(1) => {
                if b[0] == b'\n' {
                    break;
                }
                head.push(b[0]);
                if head.len() > 1024 {
                    return Err("bad_reply".into());
                }
            }
            _ => return Err("unavailable".into()),
        }
    }
    let h: Header = serde_json::from_slice(&head).map_err(|_| "bad_reply".to_string())?;
    if !h.ok {
        return Err(h.reason.unwrap_or_else(|| "refused".into()));
    }
    if h.len > MAX_SECRET_BYTES {
        return Err("bad_reply".into());
    }
    let mut body = Zeroizing::new(vec![0u8; h.len]);
    s.read_exact(&mut body).map_err(|_| "unavailable".to_string())?;
    Ok(body)
}

fn say(err: &mut dyn Write, msg: &str) {
    let _ = writeln!(err, "ASN 密碼小幫手：{msg}");
}

/// 主流程。成功時把密碼加換行印到 `out`；失敗時中文原因印到 `err`，回非 0 結束碼
pub fn run(args: &[String], env: &ClientEnv, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    if matches!(env.ssh_prompt_kind.as_deref(), Some("confirm") | Some("none")) {
        say(err, "這個提示不是在要密碼（是要你回答是／否，或只是顯示訊息），小幫手不處理，請直接在終端機回答。");
        return EXIT_REFUSED;
    }
    let prompt = args.join(" ");
    let mut conn = match pipe::connect(&env.pipe_name) {
        Ok(c) => c,
        Err(_) => {
            say(err, "ASN 沒有在執行，無法請求密碼。請先開啟 ASN 再重試。");
            return EXIT_UNAVAILABLE;
        }
    };
    if let Some(want) = &env.expected_server {
        match pipe::server_exe(&conn) {
            Ok(got) if pipe::same_path(&got, want) => {}
            _ => {
                say(err, "管道另一端不是這個資料夾裡的 ASN，已中止，沒有送出任何內容。");
                return EXIT_NOT_ASN;
            }
        }
    }
    let req = Request { v: VERSION, op: OP_SECRET.into(), prompt, cwd: env.cwd.clone() };
    match talk(&mut conn, &req) {
        Ok(secret) => {
            let r = out.write_all(&secret).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush());
            drop(secret);
            if r.is_err() {
                say(err, "無法把密碼交給呼叫的程式（標準輸出已關閉）。");
                return EXIT_REFUSED;
            }
            EXIT_OK
        }
        Err(reason) => {
            let (msg, code) = match reason.as_str() {
                REASON_CANCELLED => ("你取消了密碼輸入。", EXIT_CANCELLED),
                REASON_TIMEOUT => ("確認視窗逾時沒有人回應，已自動取消。", EXIT_TIMEOUT),
                REASON_BUSY => ("ASN 目前排隊中的密碼請求太多，請稍後再試。", EXIT_REFUSED),
                REASON_UNSUPPORTED => ("這個 ASN 版本不支援這種請求。", EXIT_REFUSED),
                "unavailable" => ("與 ASN 的連線中斷了（ASN 可能剛關閉）。", EXIT_UNAVAILABLE),
                _ => ("ASN 的回覆無法辨識。", EXIT_REFUSED),
            };
            say(err, msg);
            code
        }
    }
}

/// 給 asn-askpass 執行檔用：真的標準輸出入、真的環境。另開一條計時，十五分鐘還沒結果就放棄（避免卡死 git）
pub fn run_process(args: &[String]) -> i32 {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(15 * 60));
        elog!("ASN 密碼小幫手：等太久了，已放棄。");
        std::process::exit(EXIT_TIMEOUT);
    });
    let env = ClientEnv::from_process();
    run(args, &env, &mut std::io::stdout(), &mut std::io::stderr())
}
