//! 命令列模式：`asn send`／`asn recv`／`asn room`／`asn attach`，取代 relay/machine 的 send.mjs／recv.mjs／room.mjs／attach.mjs，
//! 讓 Claude 視窗寄信、收信、翻群組、下載附件都不需要 Node。行為、錯誤碼、輸出格式照 Node 版（見各子模組開頭的對照）。
//!
//! 執行檔：console 子系統的 `asn-cli.exe`（src/bin/asn-cli.rs）是正式入口——cmd／PowerShell／Bash 都會等它結束、拿得到結束碼；
//! `asn.exe`（GUI 子系統）遇到這幾個子命令時改接上父行程的主控台後跑同一份程式（備援，見 [`run_attached`]）。
//! 命令列模式不啟動視窗、不碰單一執行個體鎖，所以和正在跑的 ASN 並存。
//!
//! 金鑰只在記憶體（讀 ~/.irori-relay/<節點>.key 或 IRORI_RELAY_KEY），絕不印出。
mod attach_cmd;
mod caller;
mod env;
mod recv;
mod room;
mod send;
mod upload;
#[cfg(test)]
mod testsupport;
#[cfg(test)]
mod tests;

pub use env::Env;

use std::io::{Read, Write};

/// 命令列錯誤：code 是結束碼（1 用法／內容、2 認不出呼叫者、3 超量／被擋／已有人在跑、4 後端錯誤）
#[derive(Debug, Clone, PartialEq)]
pub struct Fail {
    pub code: i32,
    pub msg: String,
}
impl Fail {
    pub fn new(code: i32, msg: impl Into<String>) -> Fail {
        Fail { code, msg: msg.into() }
    }
}
pub type R<T> = Result<T, Fail>;

/// 輸入輸出：測試時換成記憶體緩衝
pub struct Io<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub stdin: &'a mut dyn Read,
}
impl Io<'_> {
    pub fn outln(&mut self, s: &str) {
        let _ = writeln!(self.out, "{s}");
        let _ = self.out.flush();
    }
    pub fn errln(&mut self, s: &str) {
        let _ = writeln!(self.err, "{s}");
        let _ = self.err.flush();
    }
}

pub const SUBCOMMANDS: [&str; 4] = ["send", "recv", "room", "attach"];

/// 第一個參數是子命令才算命令列呼叫（asn.exe 據此決定要不要跑命令列）
pub fn is_subcommand(args: &[String]) -> bool {
    args.first().map(|a| SUBCOMMANDS.contains(&a.as_str())).unwrap_or(false)
}

const TOP_USAGE: &str = "用法：
  asn send   --to <成員代號 | 節點/視窗名> --body \"<內文>\" (--reply | --no-reply) [--reply-to <信件id>] [--file <路徑> ...]
  asn send   --room <群組id> --body \"<內文>\"
  asn send   --whoami
  asn recv   --once | --watch | --peek [--count-only]
  asn room   --rooms | --room-read <群組id|群組名> [--last N | --since SEQ] [--json]
  asn attach --id <附件編號> [--out <路徑>]
各子命令加 --help 看詳細說明。身分（節點、寄件視窗名）自動判定，不能自填。";

/// 跑一個子命令；回結束碼。不論成功失敗，錯誤都印到 io.err
pub fn run(args: &[String], env: &Env, io: &mut Io) -> i32 {
    let Some(sub) = args.first() else {
        io.errln(TOP_USAGE);
        return 1;
    };
    let rest = &args[1..];
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            io.errln(&format!("錯誤：{e}"));
            return 4;
        }
    };
    let res: R<i32> = rt.block_on(async {
        match sub.as_str() {
            "send" => send::main(rest, env, io).await,
            "recv" => recv::main(rest, env, io).await,
            "room" => room::main(rest, env, io).await,
            "attach" => attach_cmd::main(rest, env, io).await,
            "--help" | "-h" | "help" => {
                io.outln(TOP_USAGE);
                Ok(0)
            }
            other => Err(Fail::new(1, format!("不認得的子命令 {other}\n{TOP_USAGE}"))),
        }
    });
    match res {
        Ok(c) => c,
        Err(f) => {
            io.errln(&f.msg);
            f.code
        }
    }
}

/// 用真的標準輸入輸出跑（asn-cli.exe 的入口）
pub fn run_process(args: &[String]) -> i32 {
    let env = Env::from_process();
    let (mut out, mut err, mut inp) = (std::io::stdout(), std::io::stderr(), std::io::stdin());
    let mut io = Io { out: &mut out, err: &mut err, stdin: &mut inp };
    run(args, &env, &mut io)
}

/// asn.exe（GUI 子系統）的備援入口：先接上父行程的主控台，再跑同一份程式。
/// 接不上（父行程沒有主控台，例如被 Claude 的管線呼叫）就沿用繼承來的標準輸出入，管線照常能用。
pub fn run_attached(args: &[String]) -> i32 {
    attach_parent_console();
    run_process(args)
}

#[cfg(windows)]
fn attach_parent_console() {
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        // GUI 程式沒有被導向時標準代碼是空的：改指向主控台。已被導向（管線、檔案）的不動
        for (which, dev, access) in [(STD_OUTPUT_HANDLE, "CONOUT$", GENERIC_WRITE), (STD_ERROR_HANDLE, "CONOUT$", GENERIC_WRITE), (STD_INPUT_HANDLE, "CONIN$", GENERIC_READ)] {
            let cur = GetStdHandle(which);
            if !cur.is_null() && cur != INVALID_HANDLE_VALUE {
                continue;
            }
            let name: Vec<u16> = dev.encode_utf16().chain(std::iter::once(0)).collect();
            let h = CreateFileW(name.as_ptr(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
            if h != INVALID_HANDLE_VALUE {
                SetStdHandle(which, h);
            }
        }
    }
}
#[cfg(not(windows))]
fn attach_parent_console() {}

// ---- 給橋與設定頁用的「怎麼呼叫我」---------------------------------------------------------------------

/// 命令列執行檔的位置：和目前執行檔同一個資料夾的 asn-cli(.exe)；沒有就退回目前執行檔自己（它也認得子命令）
pub fn cli_exe() -> Option<std::path::PathBuf> {
    let me = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "asn-cli.exe" } else { "asn-cli" };
    let sibling = me.parent()?.join(name);
    Some(if sibling.is_file() { sibling } else { me })
}

/// 路徑寫進指令：反斜線換成斜線（bash 不會吃掉、PowerShell 與 cmd 也能執行）；含空白或 shell 符號才加雙引號
pub fn command_path(p: &std::path::Path) -> String {
    let s = p.display().to_string().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).to_string();
    if s.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | ':' | '.' | '-' | '_' | '+' | '@')) {
        s
    } else {
        format!("\"{s}\"")
    }
}

/// 指令前綴（不含 --id 等參數），例如 `C:/Users/x/AppData/Local/ASN/asn-cli.exe attach`
pub fn cmd_prefix(sub: &str) -> Option<String> {
    let exe = cli_exe()?;
    Some(format!("{} {sub}", command_path(&exe)))
}

/// 給設定頁「複製寄信指令」用的範例（完整路徑）
pub fn send_example() -> Option<String> {
    Some(format!("{} --to <節點/視窗名> --body \"內文\" --no-reply", cmd_prefix("send")?))
}

/// 設定頁「寄信指令」：命令列的完整路徑與寄信範例；找不到執行檔回 null
pub fn info() -> serde_json::Value {
    match (cli_exe(), send_example()) {
        (Some(p), Some(example)) => serde_json::json!({ "path": command_path(&p), "example": example }),
        _ => serde_json::Value::Null,
    }
}
