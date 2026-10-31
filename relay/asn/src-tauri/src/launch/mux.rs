//! 0.2.0 B2a：每個使用者一個 wezterm-mux-server 的生命週期（起、試連、停）。規格見 docs/design/WEZTERM.md 第十一節。
//! 這張只放生命週期，還沒有呼叫點接上（開窗格、讀畫面、送字在 B2b，看畫面的 GUI 在 B2c）。
//!
//! 守則（B0 實測結論）：
//! - 每條 cli 都帶 `--no-auto-start` 並明給 `WEZTERM_UNIX_SOCKET`：cli 連不上時預設會自己起一個 mux，而且同一個 socket
//!   起第二個 mux 會把 socket 搶走，前一個 mux 的窗格就再也連不到。
//! - 起之前先試連；連不上才拿啟動鎖起新的，拿到鎖後再試連一次；pid 檔記著的 mux 還活著（建立時間對得上）就等它，絕不起第二個。
//! - mux 用脫離的方式啟動（新程序群組、盡量脫離 Job Object、標準輸入輸出全接 null），ASN 結束時不會帶走它。
//! - 窗格 0：mux 一啟動就自己開一個窗格 0，繼承 mux 的完整環境。我們讓它跑 `cmd /c exit` 立刻結束：
//!   實測窗格 0 結束後 mux 照樣活著、窗格編號不會重用（之後開的是 1、2…），所以夥伴不可能拿到 0，也不留常駐的 cmd。
//!   開窗格因此一律要帶 `--new-window`（沒有任何窗格時，不帶會報「不知道目前是哪個窗格」）。
//! - 停 mux 只由 ASN 明確呼叫（會把底下所有夥伴窗格一起結束），呼叫前先用 `pane_count` 告訴使用者會中斷幾個。
//!
//! 接受的風險：WezTerm 會把 `WEZTERM_UNIX_SOCKET`、`WEZTERM_PANE` 設進每個窗格，所以夥伴程序知道 socket 在哪，
//! 能讀別的夥伴的畫面、也能送字過去。同一個使用者的程序本來就連得到這個 socket，不是新的邊界；環境白名單擋不住這件事。
//! 我們自己不把 socket 路徑加進任何白名單（`cli_env` 只給下 cli 的那個程序用）。
#![cfg(desktop)]

use super::wezterm::{RunOutput, Runner};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MUX_EXE: &str = "wezterm-mux-server.exe";
/// socket 路徑上限：WezTerm 在 Windows 上也走 AF_UNIX，`sun_path` 是 108 位元組（含結尾）。實測 126 字元起不來
pub const SOCK_MAX: usize = 100;
/// 等新起的 mux 開始接受連線
pub const START_WAIT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(200);
const CLI_TIMEOUT: Duration = Duration::from_secs(10);
/// 啟動鎖超過這麼久沒放掉就當作上一個 ASN 起到一半當掉了
const LOCK_STALE: Duration = Duration::from_secs(60);
/// 窗格 0 跑的程式：立刻結束（見檔頭）
const PANE0: [&str; 3] = ["cmd.exe", "/c", "exit"];

/// mux 的檔案：`<資料夾>\sock`（socket）、`mux.lua`（只設 socket 位置的設定檔）、`mux.pid`、`start.lock`
#[derive(Debug, Clone, PartialEq)]
pub struct MuxPaths {
    pub dir: PathBuf,
    pub sock: PathBuf,
    pub config: PathBuf,
    pub pid: PathBuf,
    pub lock: PathBuf,
}

/// 固定放短路徑：`%LOCALAPPDATA%\ASN\m`。路徑太長就拒絕（WezTerm 起不來，還會留下看不懂的錯）
pub fn paths(local_app_data: &Path) -> Result<MuxPaths, String> {
    let dir = local_app_data.join("ASN").join("m");
    let sock = dir.join("sock");
    if sock.as_os_str().len() >= SOCK_MAX {
        return Err(format!("終端服務的連線檔路徑太長（{} 字元，上限 {}），請把使用者資料夾放到短一點的路徑", sock.as_os_str().len(), SOCK_MAX - 1));
    }
    Ok(MuxPaths { config: dir.join("mux.lua"), pid: dir.join("mux.pid"), lock: dir.join("start.lock"), sock, dir })
}

/// 只設 socket 位置的設定檔。用 Lua 長字串放路徑（不需要跳脫）；路徑裡若剛好有收尾記號就加等號層級避開
pub fn config_text(sock: &Path) -> String {
    let s = sock.to_string_lossy();
    let mut eq = String::new();
    while s.contains(&format!("]{eq}]")) {
        eq.push('=');
    }
    format!("-- ASN 產生的終端服務設定（只設連線檔位置），請勿手改\nreturn {{ unix_domains = {{ {{ name = 'asn', socket_path = [{eq}[{s}]{eq}] }} }} }}\n")
}

/// 下 cli 的程序的環境：只有白名單（`child_env` 的結果）加上 socket 位置
pub fn cli_env(base: &BTreeMap<String, String>, sock: &Path) -> BTreeMap<String, String> {
    let mut env = base.clone();
    env.insert("WEZTERM_UNIX_SOCKET".into(), sock.to_string_lossy().into_owned());
    env
}

/// 每條 cli 的參數：一律 `cli --no-auto-start <子命令…>`
pub fn cli_args(sub: &[&str]) -> Vec<String> {
    ["cli", "--no-auto-start"].iter().chain(sub.iter()).map(|s| s.to_string()).collect()
}

/// 起 mux 的參數：指定只設 socket 的設定檔，窗格 0 跑立刻結束的程式
pub fn server_args(config: &Path) -> Vec<String> {
    let mut a = vec!["--config-file".to_string(), config.to_string_lossy().into_owned(), "--".to_string()];
    a.extend(PANE0.iter().map(|s| s.to_string()));
    a
}

fn tries(d: Duration) -> u32 {
    (d.as_millis() / POLL.as_millis()) as u32
}

/// pid 檔：`<pid> <建立時間毫秒>`
fn read_pid(p: &Path) -> Option<(u32, u64)> {
    let t = std::fs::read_to_string(p).ok()?;
    let mut it = t.split_whitespace();
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

#[derive(Debug, PartialEq)]
pub enum Ensure {
    /// 已經有活著的 mux，沿用
    Reused,
    /// 這次起了新的
    Started { pid: u32 },
}

pub struct Mux<'a> {
    pub runner: &'a dyn Runner,
    /// wezterm.exe（cli）
    pub cli: PathBuf,
    /// wezterm-mux-server.exe
    pub server: PathBuf,
    pub paths: MuxPaths,
    /// 白名單環境（正式＝`child_env`）
    pub base_env: BTreeMap<String, String>,
}

impl Mux<'_> {
    fn cli(&self, sub: &[&str]) -> Result<RunOutput, String> {
        self.runner.run(&self.cli, &cli_args(sub), &cli_env(&self.base_env, &self.paths.sock), CLI_TIMEOUT)
    }

    /// 連得上就是活著（`--no-auto-start`，連不上不會順手起一個）
    pub fn alive(&self) -> bool {
        self.cli(&["list", "--format", "json"]).map(|o| o.success).unwrap_or(false)
    }

    /// 目前有幾個窗格（停 mux 前告訴使用者會中斷幾個夥伴）
    pub fn pane_count(&self) -> Result<usize, String> {
        let o = self.cli(&["list", "--format", "json"])?;
        if !o.success {
            return Err("終端服務沒有在跑".into());
        }
        let v: serde_json::Value = serde_json::from_str(&o.stdout).map_err(|_| "終端服務回的清單看不懂".to_string())?;
        Ok(v.as_array().map(|a| a.len()).unwrap_or(0))
    }

    /// pid 檔記的 mux 還活著（建立時間對得上，防程式編號被回收）
    fn recorded_alive(&self) -> Option<u32> {
        let (pid, at) = read_pid(&self.paths.pid)?;
        (self.runner.started_ms(pid) == Some(at)).then_some(pid)
    }

    /// 每隔 `POLL` 試連一次，最多 `d`（用次數算，等待一律經過 runner.sleep，測試不真的等）
    fn wait_alive(&self, d: Duration) -> bool {
        for _ in 0..tries(d) {
            if self.alive() {
                return true;
            }
            self.runner.sleep(POLL);
        }
        self.alive()
    }

    /// 確保有一個 mux：先試連；連不上才拿啟動鎖、再試連一次、看 pid 檔記的那個是不是還在起，都不是才起新的
    pub fn ensure(&self) -> Result<Ensure, String> {
        if self.alive() {
            return Ok(Ensure::Reused);
        }
        std::fs::create_dir_all(&self.paths.dir).map_err(|e| format!("建立終端服務資料夾失敗：{e}"))?;
        let _lock = StartLock::acquire(&self.paths.lock, self.runner)?;
        if self.alive() {
            return Ok(Ensure::Reused);
        }
        if self.recorded_alive().is_some() {
            // 別的 ASN 剛起、還沒開始接受連線：等它，不起第二個
            return if self.wait_alive(START_WAIT) { Ok(Ensure::Reused) } else { Err("終端服務已經在啟動，但一直連不上；請稍後再試".into()) };
        }
        std::fs::write(&self.paths.config, config_text(&self.paths.sock)).map_err(|e| format!("寫入終端服務設定失敗：{e}"))?;
        let pid = self.runner.spawn_detached(&self.server, &server_args(&self.paths.config), &self.base_env)?;
        let at = self.runner.started_ms(pid);
        if let Some(at) = at {
            let _ = std::fs::write(&self.paths.pid, format!("{pid} {at}"));
        }
        if self.wait_alive(START_WAIT) {
            return Ok(Ensure::Started { pid });
        }
        // 起不來：只清自己剛起的那一個（建立時間對得上才動）
        if at.is_some() && self.runner.started_ms(pid) == at {
            self.runner.kill_tree(pid);
        }
        let _ = std::fs::remove_file(&self.paths.pid);
        Err(format!("終端服務起不來（{} 秒內都連不上）", START_WAIT.as_secs()))
    }

    /// 停 mux：只停 pid 檔記的那一個、建立時間對得上才動。底下所有夥伴窗格會一起結束；呼叫前要先用 `pane_count` 講清楚
    pub fn stop(&self) -> Result<(), String> {
        let Some(pid) = self.recorded_alive() else { return Err("沒有 ASN 起的終端服務在跑".into()) };
        self.runner.kill_tree(pid);
        let _ = std::fs::remove_file(&self.paths.pid);
        Ok(())
    }
}

/// 啟動鎖：`create_new` 拿到才算；檔案超過 `LOCK_STALE` 沒放就當上一個 ASN 起到一半當掉，清掉重拿。離開時刪掉
struct StartLock(PathBuf);
impl StartLock {
    fn acquire(p: &Path, r: &dyn Runner) -> Result<Self, String> {
        let mut left = tries(START_WAIT);
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(p) {
                Ok(_) => return Ok(StartLock(p.to_path_buf())),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age >= LOCK_STALE);
                    if stale {
                        let _ = std::fs::remove_file(p);
                        continue;
                    }
                    if left == 0 {
                        return Err("另一個 ASN 正在啟動終端服務，等太久了；請稍後再試".into());
                    }
                    left -= 1;
                    r.sleep(POLL);
                }
                Err(e) => return Err(format!("拿終端服務啟動鎖失敗：{e}")),
            }
        }
    }
}
impl Drop for StartLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 更新留下的舊執行檔（安裝程式把占用中的檔改名成 `.old`、`.old1`…）：ASN 啟動時試著刪，舊 mux 還在用的刪不掉就留到下次。
/// 只看 wezterm 資料夾本身這一層，只刪檔名含 `.old` 而且原檔名在清單上的。回傳刪掉幾個
pub fn clean_old(wezterm_dir: &Path, known: &[&str]) -> usize {
    let Ok(rd) = std::fs::read_dir(wezterm_dir) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(i) = name.rfind(".old") else { continue };
        let (orig, suffix) = name.split_at(i);
        let rotation_ok = suffix[4..].chars().all(|c| c.is_ascii_digit());
        if rotation_ok && known.contains(&orig) && e.path().is_file() && std::fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests;
