//! WezTerm 終端的命令層（議題 #285）。
//! ASN 不渲染終端內容。啟停、送字、讀輸出之外，這一輪加上忙閒、改名，以及 ASN 重啟後認領自己開過的視窗。
//! 不接 UI、不進安裝包。
//!
//! 審查約束（沿用 #286，這裡不繞過）：
//! - 對照表是「自己開的編號 → Window」。Window 帶啟動時量到的 started_ms。呼叫端只能給編號，不能給程序編號或通訊路徑；關閉一律走會核對建立時間的 stop。
//! - 每次 cli 都經模組帶 WEZTERM_UNIX_SOCKET；通訊檔不存在時模組直接拒絕，不會執行 cli。認領也先看通訊檔在不在，不在就不呼叫 cli。
//! - profile 只准 agy 與 grok。認領時檔案裡其他 profile 一律不接手、不結束。
//!
//! 忙閒只實作 grok：連續兩次取樣（中間用 Runner::sleep，間隔可注入；假執行器不真的等）畫面與游標都沒變，
//! 且最後一個非空白行全文等於暫定提示符，才是 idle。對不上、agy、或讀取失敗都是 unknown，不把「畫面停住」猜成閒置。
//!
//! 認領不掃整個系統。只讀 data_dir 裡自己寫的對照表，用記下的程序編號重算通訊路徑（檔案裡的路徑一律不理），
//! 建立時間相符且通訊檔存在才 list。workspace 是 `asn-{編號}`，或分頁標題是 `ASN:{編號}`（或後面空一格）才放回對照表。
//! 辨識不出來的不放進表、也不結束那個程序。
//!
//! 作業系統介面沿用 wezterm 的 Runner／Fs，測試注入假實作，不會啟動真的 WezTerm。
#![cfg(desktop)]

use super::config::{canonical_launch_cwd, LaunchConfig};
use super::wezterm::{self, Fs, Runner, WezTerm, WezTermDir, Window};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// 一次最多從畫面底部往回讀幾行（對應 `get-text --start-line=-N`）。超出就拒絕，避免整份捲動區進記憶體。
pub const MAX_READ_LINES: i32 = 500;
/// 讀回文字的字數上限（超出截斷）。與送字的單行上限是兩件事。
pub const MAX_READ_CHARS: usize = 64_000;
/// 忙閒只看畫面底部這幾行。
const STATUS_LINES: i32 = 40;
/// 兩次取樣的正式間隔。測試用 set_status_gap 注入更短的值。
pub const STATUS_GAP: Duration = Duration::from_secs(1);
/// 使用者給的那段標題（不含 ASN 前綴）最長幾個字。WezTerm 自己的上限這份程式沒核過，先用跟夥伴改名一樣的長度。
pub const MAX_TITLE_CHARS: usize = 40;
const STORE_VERSION: u32 = 1;
const TRUNC_MARK: &str = "…（已截斷）";
/// 暫定的 grok 閒置標記。真機提示符還沒在 A5 確認過；最後一個非空白行去掉首尾空白後必須全文等於它，否則回 unknown。
const GROK_IDLE_MARK: &str = "grok>";

/// `term_list` 的一列。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermListed {
    pub id: String,
    pub profile: String,
    pub pid: u32,
    pub started_ms: Option<u64>,
}

/// `term_status` 的結果。state 只會是 busy、idle、unknown。判斷不了就是 unknown，不會猜。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermStatus {
    pub state: String,
    pub profile: String,
    pub cursor_x: Option<i64>,
    pub cursor_y: Option<i64>,
    pub reason: String,
}

struct Session {
    id: String,
    profile: String,
    window: Window,
    pane_id: u64,
    workspace: String,
    /// 設到分頁上的完整標題（含 ASN 前綴）。
    title: String,
}

struct SessionSnap {
    id: String,
    profile: String,
    window: Window,
    pane_id: u64,
}

struct Inner {
    next: u64,
    sessions: Vec<Session>,
    /// 建立時間曾相符、但這次通訊檔不在（或 list 失敗），留在檔案裡下次再試。不放進可操作的對照表，也不對它們下 cli。
    parked: Vec<StoreTerm>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    next: u64,
    terms: Vec<StoreTerm>,
}

/// 寫進 data_dir 的一列。不存通訊路徑：重啟時用 pid 重算，避免檔案被改成別人的 socket 還照用。
#[derive(Clone, Serialize, Deserialize)]
struct StoreTerm {
    id: String,
    profile: String,
    pid: u32,
    #[serde(default)]
    started_ms: Option<u64>,
    pane_id: u64,
    workspace: String,
    title: String,
}

enum Loaded {
    Missing,
    /// 版本不是這份程式認得的：不覆蓋、不認領。
    Foreign,
    Ready(StoreFile),
}

enum Source {
    /// 測試直接給資料夾，不讀環境變數
    Fixed(WezTermDir),
    /// 正式：每次用 ASN_WEZTERM_DIR 找隔離副本
    FromEnv,
    /// 測試：模擬這台機器沒有 WezTerm。認領應直接跳過，不讀清單、不結束任何人。
    #[cfg(test)]
    Absent,
}

/// 自己開過的終端。只認這張表裡的編號，呼叫端給的其他編號一律拒絕。
pub struct TermService<R, F> {
    source: Source,
    config_file: PathBuf,
    /// 對照表檔（data_dir/wezterm-terms.json）。只記自己開過的視窗，不記通訊路徑。
    store: PathBuf,
    home: PathBuf,
    runner: R,
    fs: F,
    status_gap: Duration,
    inner: Mutex<Inner>,
}

impl<R: Runner, F: Fs> TermService<R, F> {
    pub fn fixed(dir: WezTermDir, config_file: PathBuf, store: PathBuf, home: PathBuf, runner: R, fs: F) -> Self {
        Self {
            source: Source::Fixed(dir),
            config_file,
            store,
            home,
            runner,
            fs,
            status_gap: STATUS_GAP,
            inner: Mutex::new(Inner {
                next: 0,
                sessions: Vec::new(),
                parked: Vec::new(),
            }),
        }
    }

    fn from_env(config_file: PathBuf, store: PathBuf, home: PathBuf, runner: R, fs: F) -> Self {
        Self {
            source: Source::FromEnv,
            config_file,
            store,
            home,
            runner,
            fs,
            status_gap: STATUS_GAP,
            inner: Mutex::new(Inner {
                next: 0,
                sessions: Vec::new(),
                parked: Vec::new(),
            }),
        }
    }

    #[cfg(test)]
    fn without_wezterm(store: PathBuf, home: PathBuf, runner: R, fs: F) -> Self {
        Self {
            source: Source::Absent,
            config_file: PathBuf::from("cfg.lua"),
            store,
            home,
            runner,
            fs,
            status_gap: STATUS_GAP,
            inner: Mutex::new(Inner {
                next: 0,
                sessions: Vec::new(),
                parked: Vec::new(),
            }),
        }
    }

    /// 測試注入兩次取樣的間隔。正式路徑用 STATUS_GAP，不呼叫這個。
    #[cfg(test)]
    fn set_status_gap(&mut self, gap: Duration) {
        self.status_gap = gap;
    }

    fn dir(&self) -> Result<WezTermDir, String> {
        match &self.source {
            Source::Fixed(d) => Ok(d.clone()),
            Source::FromEnv => wezterm::locate(&self.fs),
            #[cfg(test)]
            Source::Absent => Err("找不到 WezTerm，請設定 ASN_WEZTERM_DIR（原型階段只用開發機上的隔離副本）".into()),
        }
    }

    fn wez(&self, dir: &WezTermDir) -> WezTerm<'_> {
        WezTerm::new(dir.clone(), self.config_file.clone(), self.home.clone(), &self.runner, &self.fs)
    }

    /// 隔離用的 WezTerm 設定。已存在就不覆蓋（避免改到實驗中途寫過的內容）；沒有才寫一份空的，避免吃到使用者的 `~/.wezterm.lua`。
    #[cfg_attr(not(any(feature = "gui", test)), allow(dead_code))]
    fn ensure_config(&self) -> Result<(), String> {
        if self.config_file.is_file() {
            return Ok(());
        }
        if let Some(parent) = self.config_file.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("無法建立終端設定資料夾：{e}"))?;
            }
        }
        std::fs::write(&self.config_file, "return {}\n").map_err(|e| format!("無法建立隔離的 WezTerm 設定：{e}"))
    }

    /// 開一個終端。profile 只准 agy／grok，執行檔與工作資料夾都來自既有啟動設定，不接受呼叫端指定的指令。
    /// 視窗帶 workspace `asn-{編號}`，分頁標題設成 `ASN:{編號}`。標題設不下去就結束剛開的視窗，不留沒有標記的孤兒。
    pub fn start(&self, profile: &str, cwd: &str, config: &LaunchConfig) -> Result<String, String> {
        let command = resolve_command(profile, config)?;
        let cwd = authorize_cwd(config, cwd)?;
        let dir = self.dir()?;
        let id = self.alloc_id()?;
        let workspace = format!("asn-{id}");
        let title = format!("ASN:{id}");
        let w = self.wez(&dir);
        let win = w.start_in_workspace(&cwd, &workspace, &[command])?;
        let panes = match w.list(&win.sock) {
            Ok(p) if !p.is_empty() => p,
            Ok(_) => return fail_close(&w, &win, "WezTerm 視窗裡沒有可操作的窗格".into()),
            Err(e) => return fail_close(&w, &win, e),
        };
        let pane_id = panes.iter().find(|p| p.is_active).map(|p| p.pane_id).unwrap_or(panes[0].pane_id);
        if let Err(e) = w.set_tab_title(&win.sock, pane_id, &title) {
            return fail_close(&w, &win, format!("無法設定終端標題：{e}"));
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.sessions.push(Session {
                id: id.clone(),
                profile: profile.to_string(),
                window: win.clone(),
                pane_id,
                workspace,
                title,
            });
        }
        if let Err(e) = self.persist() {
            let _ = w.stop(&win);
            {
                let mut g = self.inner.lock().unwrap();
                g.sessions.retain(|s| s.id != id);
            }
            let _ = self.persist();
            return Err(format!("終端已啟動但對照表寫入失敗，已嘗試結束視窗：{e}"));
        }
        Ok(id)
    }

    pub fn send(&self, id: &str, text: &str, enter: bool) -> Result<(), String> {
        let snap = self.snapshot(id)?;
        let dir = self.dir()?;
        let w = self.wez(&dir);
        if enter {
            w.send_line_and_enter(&snap.window.sock, snap.pane_id, text)
        } else {
            w.send_line(&snap.window.sock, snap.pane_id, text)
        }
    }

    /// `lines` 是從畫面底部往回讀的行數，範圍 1..=MAX_READ_LINES。回傳再截到字數上限。
    pub fn read(&self, id: &str, lines: i32) -> Result<String, String> {
        let snap = self.snapshot(id)?;
        if !(1..=MAX_READ_LINES).contains(&lines) {
            return Err(format!("讀取行數必須介於 1 到 {MAX_READ_LINES}"));
        }
        let dir = self.dir()?;
        let w = self.wez(&dir);
        let text = w.get_text(&snap.window.sock, snap.pane_id, Some(-lines))?;
        Ok(cap_output(&text))
    }

    pub fn list(&self) -> Vec<TermListed> {
        let g = self.inner.lock().unwrap();
        g.sessions
            .iter()
            .map(|s| TermListed {
                id: s.id.clone(),
                profile: s.profile.clone(),
                pid: s.window.gui_pid,
                started_ms: s.window.started_ms,
            })
            .collect()
    }

    /// 結束自己開的視窗。只拿對照表裡的 Window 交給 wezterm::stop（裡面核對 started_ms），不接受呼叫端傳入的程序編號。
    /// 成功（含視窗早已不在）才從表上移除；建立時間對不上就保留編號，方便呼叫端知道沒關掉。
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let snap = self.snapshot(id)?;
        let dir = self.dir()?;
        let w = self.wez(&dir);
        w.stop(&snap.window)?;
        {
            let mut g = self.inner.lock().unwrap();
            g.sessions.retain(|s| s.id != id);
        }
        self.persist()?;
        Ok(())
    }

    /// 忙或閒。只認自己的編號。agy 沒有規則，直接 unknown，連畫面都不讀。
    /// grok：取樣、睡一段、再取樣。兩次的畫面與游標都相同，且停在暫定提示符，才是 idle；有變化是 busy；其餘 unknown。
    pub fn status(&self, id: &str) -> Result<TermStatus, String> {
        let snap = self.snapshot(id)?;
        if snap.profile != "grok" {
            return Ok(TermStatus {
                state: "unknown".into(),
                profile: snap.profile,
                cursor_x: None,
                cursor_y: None,
                reason: "只有 grok 有閒置規則".into(),
            });
        }
        let dir = self.dir()?;
        let w = self.wez(&dir);
        let first = match self.sample(&w, &snap) {
            Ok(s) => s,
            Err(e) => return Ok(unknown_status(&snap.profile, &format!("讀不到畫面或游標，無法判斷：{e}"))),
        };
        self.runner.sleep(self.status_gap);
        let second = match self.sample(&w, &snap) {
            Ok(s) => s,
            Err(e) => return Ok(unknown_status(&snap.profile, &format!("讀不到畫面或游標，無法判斷：{e}"))),
        };
        let cursor_x = Some(second.cursor_x);
        let cursor_y = Some(second.cursor_y);
        if first.text != second.text || first.cursor_x != second.cursor_x || first.cursor_y != second.cursor_y {
            return Ok(TermStatus {
                state: "busy".into(),
                profile: snap.profile,
                cursor_x,
                cursor_y,
                reason: "畫面或游標有變化".into(),
            });
        }
        if last_nonempty(&second.text) == GROK_IDLE_MARK {
            return Ok(TermStatus {
                state: "idle".into(),
                profile: snap.profile,
                cursor_x,
                cursor_y,
                reason: "連續兩次畫面相同且停在提示符".into(),
            });
        }
        Ok(TermStatus {
            state: "unknown".into(),
            profile: snap.profile,
            cursor_x,
            cursor_y,
            reason: "畫面沒有變化，但不是已確認的 grok 提示符".into(),
        })
    }

    /// 改自己這個終端的分頁標題。使用者給的字會接在 `ASN:{編號} ` 後面，前綴不拿掉（認領靠它）。
    /// 長度與字元先檢查，不合法就不呼叫 cli。
    pub fn rename(&self, id: &str, title: &str) -> Result<(), String> {
        let snap = self.snapshot(id)?;
        let user = normalize_title(title)?;
        let full = format!("ASN:{} {}", snap.id, user);
        let dir = self.dir()?;
        let w = self.wez(&dir);
        w.set_tab_title(&snap.window.sock, snap.pane_id, &full)?;
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(s) = g.sessions.iter_mut().find(|s| s.id == id) {
                s.title = full;
            }
        }
        self.persist()?;
        Ok(())
    }

    /// ASN 重啟、記憶體對照表是空的時候，用檔案把先前自己開的視窗放回來。
    /// 找不到 WezTerm、沒有檔案、或版本不認得：什麼都不改。這條路徑不呼叫 kill_tree。
    pub fn reclaim(&self) -> Result<(), String> {
        let loaded = self.load_store()?;
        let file = match loaded {
            Loaded::Ready(file) => file,
            Loaded::Missing | Loaded::Foreign => return Ok(()),
        };
        let dir = match self.dir() {
            Ok(d) => d,
            Err(_) => return Ok(()),
        };
        let w = self.wez(&dir);
        let mut restored: Vec<Session> = Vec::new();
        let mut parked: Vec<StoreTerm> = Vec::new();
        for term in file.terms {
            if restored.iter().any(|s| s.id == term.id) || parked.iter().any(|s| s.id == term.id) {
                continue;
            }
            if !reclaim_candidate(&term) {
                continue;
            }
            let Some(saved) = term.started_ms else {
                continue;
            };
            // 建立時間對不上、或程序已經不在：不認領，也不結束（編號可能已經是別人的）。
            match self.runner.started_ms(term.pid) {
                Some(now) if now == saved => {}
                _ => continue,
            }
            let sock = wezterm::sock_path(&self.home, term.pid);
            if !self.fs.exists(&sock) {
                parked.push(term);
                continue;
            }
            let panes = match w.list(&sock) {
                Ok(p) => p,
                Err(_) => {
                    parked.push(term);
                    continue;
                }
            };
            let Some(pane) = pick_pane(&panes, &term.id, term.pane_id) else {
                continue;
            };
            let title = if title_marks(&pane.tab_title, &term.id) { pane.tab_title.clone() } else { format!("ASN:{}", term.id) };
            restored.push(Session {
                id: term.id.clone(),
                profile: term.profile.clone(),
                window: Window {
                    gui_pid: term.pid,
                    sock,
                    started_ms: Some(saved),
                },
                pane_id: pane.pane_id,
                workspace: format!("asn-{}", term.id),
                title,
            });
        }
        let mut next = file.next;
        for id in restored.iter().map(|s| s.id.as_str()).chain(parked.iter().map(|s| s.id.as_str())) {
            if let Ok(n) = id.parse::<u64>() {
                next = next.max(n);
            }
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.next = next;
            g.sessions = restored;
            g.parked = parked;
        }
        self.persist()?;
        Ok(())
    }

    fn snapshot(&self, id: &str) -> Result<SessionSnap, String> {
        let g = self.inner.lock().unwrap();
        g.sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| SessionSnap {
                id: s.id.clone(),
                profile: s.profile.clone(),
                window: s.window.clone(),
                pane_id: s.pane_id,
            })
            .ok_or_else(|| "沒有這個終端（只能操作這次由 ASN 開啟的）".to_string())
    }

    fn sample(&self, w: &WezTerm<'_>, snap: &SessionSnap) -> Result<Sample, String> {
        let text = w.get_text(&snap.window.sock, snap.pane_id, Some(-STATUS_LINES))?;
        let panes = w.list(&snap.window.sock)?;
        let pane = panes.iter().find(|p| p.pane_id == snap.pane_id).ok_or_else(|| "清單裡沒有這個窗格".to_string())?;
        Ok(Sample {
            text,
            cursor_x: pane.cursor_x,
            cursor_y: pane.cursor_y,
        })
    }

    fn alloc_id(&self) -> Result<String, String> {
        let id = {
            let mut g = self.inner.lock().unwrap();
            g.next += 1;
            g.next.to_string()
        };
        if let Err(e) = self.persist() {
            let mut g = self.inner.lock().unwrap();
            g.next = g.next.saturating_sub(1);
            return Err(e);
        }
        Ok(id)
    }

    fn load_store(&self) -> Result<Loaded, String> {
        if !self.store.is_file() {
            return Ok(Loaded::Missing);
        }
        let text = std::fs::read_to_string(&self.store).map_err(|e| format!("終端對照表讀不了：{e}"))?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("終端對照表不是合法的內容：{e}"))?;
        let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
        if version != u64::from(STORE_VERSION) {
            return Ok(Loaded::Foreign);
        }
        let file = serde_json::from_value(value).map_err(|e| format!("終端對照表欄位不符：{e}"))?;
        Ok(Loaded::Ready(file))
    }

    fn persist(&self) -> Result<(), String> {
        let g = self.inner.lock().unwrap();
        let mut terms: Vec<StoreTerm> = g.sessions.iter().map(session_to_store).collect();
        terms.extend(g.parked.iter().cloned());
        let file = StoreFile { version: STORE_VERSION, next: g.next, terms };
        drop(g);
        let text = serde_json::to_string_pretty(&file).map_err(|e| format!("無法寫入終端對照表：{e}"))?;
        atomic_write(&self.store, &text)
    }
}

struct Sample {
    text: String,
    cursor_x: i64,
    cursor_y: i64,
}

/// 啟動設定裡 agy 的編號是 gemini（執行檔才是 agy），grok 的編號就是 grok。
/// 白名單只寫在這一段：其他名稱會對上啟動設定裡的同名項目，所以必須在這裡擋下。
fn resolve_command(profile: &str, config: &LaunchConfig) -> Result<String, String> {
    if profile != "agy" && profile != "grok" {
        return Err("終端只允許 agy 與 grok，不能指定其他指令".into());
    }
    let key = match profile {
        "agy" => "gemini",
        "grok" => "grok",
        other => other,
    };
    let prof = config.profiles.get(key).ok_or_else(|| format!("這台電腦的啟動設定裡沒有 {profile}"))?;
    if prof.disabled {
        return Err(if prof.disabled_reason.is_empty() { format!("{profile} 目前無法啟動") } else { prof.disabled_reason.clone() });
    }
    let command = prof.command.trim();
    if command.is_empty() {
        return Err(format!("啟動設定裡沒有 {profile} 的執行檔"));
    }
    if command.chars().any(|c| c.is_control()) {
        return Err("啟動設定裡的執行檔路徑不合法".into());
    }
    // 檔名必須就是這個 profile（agy.exe／agy.cmd／grok 可以，cmd.exe 不行）。
    // grok 啟動設定的參數是內建通道的 agent stdio，不是終端互動，這裡只拿執行檔、不帶那些參數。
    if binary_stem(command) != profile {
        return Err(format!("啟動設定裡的執行檔不是 {profile}，已拒絕"));
    }
    Ok(command.to_string())
}

/// 檔名主檔（去掉資料夾與副檔名），路徑分隔線兩種都認，測試在 Linux 上也能驗 Windows 路徑。
fn binary_stem(command: &str) -> String {
    let name = command.trim().rsplit(['/', '\\']).next().unwrap_or("");
    name.split('.').next().unwrap_or("").to_ascii_lowercase()
}

/// 與開新夥伴同一套：空白拒絕、必須在 cwd_allow、必須是存在的資料夾。不做「子資料夾也算」的放寬。
fn authorize_cwd(config: &LaunchConfig, cwd: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return Err("工作資料夾不在允許清單裡".into());
    }
    let canon = canonical_launch_cwd(cwd)?;
    if !config.cwd_allow.iter().any(|p| p == &canon) {
        return Err("工作資料夾不在允許清單裡".into());
    }
    if !canon.is_dir() {
        return Err(format!("工作資料夾不存在：{cwd}"));
    }
    Ok(canon)
}

fn cap_output(text: &str) -> String {
    if text.chars().count() <= MAX_READ_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_READ_CHARS).collect();
    out.push_str(TRUNC_MARK);
    out
}

fn fail_close(w: &WezTerm<'_>, win: &Window, why: String) -> Result<String, String> {
    match w.stop(win) {
        Ok(()) => Err(why),
        Err(e) => Err(format!("{why}（結束剛啟動的視窗也失敗：{e}）")),
    }
}

fn session_to_store(s: &Session) -> StoreTerm {
    StoreTerm {
        id: s.id.clone(),
        profile: s.profile.clone(),
        pid: s.window.gui_pid,
        started_ms: s.window.started_ms,
        pane_id: s.pane_id,
        workspace: s.workspace.clone(),
        title: s.title.clone(),
    }
}

/// 檔案裡這一列能不能當認領候選。其他 profile、空編號、程序編號 0 都直接丟掉，不查、不結束。
fn reclaim_candidate(t: &StoreTerm) -> bool {
    profile_reclaimable(&t.profile) && id_ok(&t.id) && t.pid != 0
}

fn profile_reclaimable(profile: &str) -> bool {
    profile == "agy" || profile == "grok"
}

fn id_ok(id: &str) -> bool {
    match id.parse::<u64>() {
        Ok(n) if n > 0 && n.to_string() == id => true,
        _ => false,
    }
}

fn title_marks(title: &str, id: &str) -> bool {
    let prefix = format!("ASN:{id}");
    title == prefix || title.starts_with(&format!("{prefix} "))
}

fn pane_is_ours(id: &str, pane: &wezterm::PaneInfo) -> bool {
    pane.workspace == format!("asn-{id}") || title_marks(&pane.tab_title, id)
}

fn pick_pane<'a>(panes: &'a [wezterm::PaneInfo], id: &str, saved_pane: u64) -> Option<&'a wezterm::PaneInfo> {
    let ours: Vec<&wezterm::PaneInfo> = panes.iter().filter(|p| pane_is_ours(id, p)).collect();
    if ours.is_empty() {
        return None;
    }
    if let Some(p) = ours.iter().copied().find(|p| p.pane_id == saved_pane) {
        return Some(p);
    }
    if let Some(p) = ours.iter().copied().find(|p| p.is_active) {
        return Some(p);
    }
    Some(ours[0])
}

fn last_nonempty(text: &str) -> &str {
    text.lines().rev().find(|l| !l.trim().is_empty()).map(str::trim).unwrap_or("")
}

fn unknown_status(profile: &str, reason: &str) -> TermStatus {
    TermStatus {
        state: "unknown".into(),
        profile: profile.to_string(),
        cursor_x: None,
        cursor_y: None,
        reason: reason.to_string(),
    }
}

/// 使用者給的標題：去掉首尾空白後 1 到 MAX_TITLE_CHARS 個字，不能有控制字元，空白只准普通空格。
fn normalize_title(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("標題不能是空白".into());
    }
    if t.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("標題最多 {MAX_TITLE_CHARS} 個字"));
    }
    if t.chars().any(|c| c.is_control() || (c.is_whitespace() && c != ' ')) {
        return Err("標題含有不允許的字元".into());
    }
    Ok(t.to_string())
}

fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("無法建立終端對照表資料夾：{e}"))?;
        }
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("無法寫入終端對照表：{e}"))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            std::fs::remove_file(path).map_err(|e| format!("無法更新終端對照表：{e}"))?;
            std::fs::rename(&tmp, path).map_err(|e| format!("無法更新終端對照表：{e}"))
        }
        Err(e) => Err(format!("無法更新終端對照表：{e}")),
    }
}

// 下面這段才是 Tauri 指令要的型別與正式進入點。核心邏輯在上面，測試不經過 Tauri。

#[cfg(feature = "gui")]
pub type LiveTerms = TermService<wezterm::RealRunner, wezterm::RealFs>;

#[cfg(feature = "gui")]
pub fn live(data_dir: &Path) -> LiveTerms {
    let svc = TermService::from_env(data_dir.join("wezterm-term.lua"), data_dir.join("wezterm-terms.json"), crate::identity::home_dir(), wezterm::RealRunner, wezterm::RealFs);
    if let Err(e) = svc.reclaim() {
        eprintln!("終端對照表接手失敗（不中斷啟動）：{e}");
    }
    svc
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermStartReq {
    pub profile: String,
    pub cwd: String,
}

#[cfg(feature = "gui")]
#[derive(Debug, Serialize)]
pub struct TermStarted {
    pub id: String,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermSendReq {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub enter: bool,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermReadReq {
    pub id: String,
    pub lines: i32,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermStopReq {
    pub id: String,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermStatusReq {
    pub id: String,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermRenameReq {
    pub id: String,
    pub title: String,
}

/// 正式路徑：讀啟動設定、沿用本機資料夾授權，再交給 TermService。
#[cfg(feature = "gui")]
pub fn start_live(terms: &LiveTerms, profile: &str, cwd: &str, data_dir: &Path) -> Result<TermStarted, String> {
    let mut config = super::config::load_launch_config()?;
    super::cwds::grant_local_cwd(&mut config, cwd, &crate::identity::home_dir(), data_dir)?;
    terms.ensure_config()?;
    let id = terms.start(profile, cwd, &config)?;
    Ok(TermStarted { id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::profiles::{LaunchMode, Profile};
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap, HashSet};
    use std::rc::Rc;
    use std::time::Duration;

    struct FakeFs {
        files: Rc<RefCell<HashSet<PathBuf>>>,
    }
    impl Fs for FakeFs {
        fn exists(&self, p: &Path) -> bool {
            self.files.borrow().contains(p)
        }
    }

    struct FakeInner {
        calls: RefCell<Vec<(Vec<String>, BTreeMap<String, String>)>>,
        started: RefCell<Vec<Option<u64>>>,
        tree_killed: RefCell<Vec<u32>>,
        list_json: RefCell<String>,
        screen: RefCell<String>,
        sleeps: RefCell<Vec<Duration>>,
        /// 依序吐出的畫面；空了就用 screen。
        screens: RefCell<Vec<String>>,
        /// 依序吐出的清單；空了就用 list_json。
        list_jsons: RefCell<Vec<String>>,
        /// 參數裡出現這個子字串時，cli 回失敗。
        fail_substr: RefCell<Option<String>>,
        trace: RefCell<Vec<String>>,
    }

    fn fake_inner(started: Vec<Option<u64>>, list_json: String, screen: String) -> FakeInner {
        FakeInner {
            calls: RefCell::new(Vec::new()),
            started: RefCell::new(started),
            tree_killed: RefCell::new(Vec::new()),
            list_json: RefCell::new(list_json),
            screen: RefCell::new(screen),
            sleeps: RefCell::new(Vec::new()),
            screens: RefCell::new(Vec::new()),
            list_jsons: RefCell::new(Vec::new()),
            fail_substr: RefCell::new(None),
            trace: RefCell::new(Vec::new()),
        }
    }

    #[derive(Clone)]
    struct FakeRunner {
        inner: Rc<FakeInner>,
    }
    impl FakeRunner {
        fn args(&self) -> Vec<Vec<String>> {
            self.inner.calls.borrow().iter().map(|(a, _)| a.clone()).collect()
        }
        fn killed(&self) -> Vec<u32> {
            self.inner.tree_killed.borrow().clone()
        }
    }
    impl Runner for FakeRunner {
        fn run(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>, _timeout: Duration) -> Result<wezterm::RunOutput, String> {
            self.inner.calls.borrow_mut().push((args.to_vec(), env.clone()));
            let kind = args.get(1).cloned().unwrap_or_default();
            self.inner.trace.borrow_mut().push(format!("run:{kind}"));
            if let Some(sub) = self.inner.fail_substr.borrow().clone() {
                if args.iter().any(|a| a.contains(&sub)) {
                    return Err(format!("WezTerm cli 失敗：假的失敗 {sub}"));
                }
            }
            let stdout = if args.iter().any(|a| a == "list") {
                let mut q = self.inner.list_jsons.borrow_mut();
                if q.is_empty() {
                    self.inner.list_json.borrow().clone()
                } else {
                    q.remove(0)
                }
            } else if args.iter().any(|a| a == "get-text") {
                let mut q = self.inner.screens.borrow_mut();
                if q.is_empty() {
                    self.inner.screen.borrow().clone()
                } else {
                    q.remove(0)
                }
            } else {
                String::new()
            };
            Ok(wezterm::RunOutput {
                success: true,
                stdout,
                stderr: String::new(),
            })
        }
        fn spawn(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
            self.inner.calls.borrow_mut().push((args.to_vec(), env.clone()));
            Ok(42)
        }
        fn kill_tree(&self, pid: u32) {
            self.inner.tree_killed.borrow_mut().push(pid);
        }
        fn started_ms(&self, _pid: u32) -> Option<u64> {
            let mut q = self.inner.started.borrow_mut();
            if q.is_empty() {
                Some(1_000)
            } else {
                q.remove(0)
            }
        }
        fn sleep(&self, d: Duration) {
            self.inner.sleeps.borrow_mut().push(d);
            self.inner.trace.borrow_mut().push(format!("sleep:{}", d.as_millis()));
        }
    }

    fn profile(command: &str, args: Vec<String>) -> Profile {
        Profile {
            label: command.into(),
            command: command.into(),
            args,
            engine: String::new(),
            mode: LaunchMode::Window,
            disabled: false,
            disabled_reason: String::new(),
        }
    }

    fn default_profiles() -> HashMap<String, Profile> {
        let mut m = HashMap::new();
        // 陷阱：編號 agy 若被直接拿來用，會開到 cmd。正確對照是 gemini → agy 執行檔。
        m.insert("agy".into(), profile(r"C:\Windows\System32\cmd.exe", vec![]));
        m.insert("gemini".into(), profile("C:/bin/agy.exe", vec![]));
        m.insert("grok".into(), profile("C:/bin/grok.exe", vec!["agent".into(), "stdio".into()]));
        m.insert("claude".into(), profile("C:/bin/claude.exe", vec!["--dangerously-skip-permissions".into()]));
        m
    }

    struct Rig {
        _dir: tempfile::TempDir,
        cwd: String,
        config: LaunchConfig,
        svc: TermService<FakeRunner, FakeFs>,
        runner: FakeRunner,
        files: Rc<RefCell<HashSet<PathBuf>>>,
        store: PathBuf,
    }

    fn sock() -> PathBuf {
        wezterm::sock_path(Path::new("H"), 42)
    }

    fn make(profiles: HashMap<String, Profile>, started: Vec<Option<u64>>) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("wezterm-terms.json");
        let canon = canonical_launch_cwd(&dir.path().to_string_lossy()).unwrap();
        let cwd = canon.to_string_lossy().into_owned();
        let config = LaunchConfig {
            profiles,
            cwd_allow: vec![canon],
            max_per_hour: 6,
        };
        let files = Rc::new(RefCell::new(HashSet::from([sock()])));
        let fs = FakeFs { files: files.clone() };
        let runner = FakeRunner {
            inner: Rc::new(fake_inner(started, r#"[{"pane_id":7,"tab_id":1,"is_active":true,"cursor_x":1,"cursor_y":2}]"#.into(), "畫面一行".into())),
        };
        let view = runner.clone();
        let svc = TermService::fixed(
            WezTermDir {
                gui: "W/wezterm-gui.exe".into(),
                cli: "W/wezterm.exe".into(),
            },
            "cfg.lua".into(),
            store.clone(),
            "H".into(),
            runner,
            fs,
        );
        Rig {
            _dir: dir,
            cwd,
            config,
            svc,
            runner: view,
            files,
            store,
        }
    }

    /// 每條 cli 都要帶上這個視窗的通訊檔。gui 的 start 不是 cli，不在這裡。
    fn assert_cli_uses_socket(r: &FakeRunner) {
        let expect = sock().to_string_lossy().into_owned();
        let calls = r.inner.calls.borrow();
        let cli: Vec<_> = calls.iter().filter(|(a, _)| a.first().map(|s| s == "cli").unwrap_or(false)).collect();
        assert!(!cli.is_empty(), "至少要有一次 cli");
        for (args, env) in cli {
            assert_eq!(env.get("WEZTERM_UNIX_SOCKET").map(String::as_str), Some(expect.as_str()), "cli 未帶通訊檔：{args:?}");
        }
    }

    fn started_args(r: &FakeRunner) -> Vec<Vec<String>> {
        r.args().into_iter().filter(|a| a.first().map(|s| s == "start").unwrap_or(false)).collect()
    }

    #[test]
    fn 執行檔檔名只認_agy_與_grok() {
        assert_eq!(binary_stem("C:/bin/agy.exe"), "agy");
        assert_eq!(binary_stem("agy.cmd"), "agy");
        assert_eq!(binary_stem(r"D:\tools\grok.exe"), "grok");
        assert_eq!(binary_stem("grok"), "grok");
        assert_eq!(binary_stem(r"C:\Windows\System32\cmd.exe"), "cmd");
        assert_ne!(binary_stem("C:/bin/claude.exe"), "agy");
    }

    #[test]
    fn 非白名單拒絕且不啟動() {
        let rig = make(default_profiles(), vec![]);
        for name in ["claude", "gemini", "cmd", "Grok", ""] {
            let err = rig.svc.start(name, &rig.cwd, &rig.config).unwrap_err();
            assert!(err.contains("只允許 agy 與 grok"), "{name}: {err}");
        }
        assert!(started_args(&rig.runner).is_empty(), "白名單被拿掉時，啟動設定裡的 claude 會被執行");
        let mut disabled = default_profiles();
        disabled.get_mut("grok").unwrap().disabled = true;
        disabled.get_mut("grok").unwrap().disabled_reason = "維修中".into();
        let rig = make(disabled, vec![]);
        let err = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap_err();
        assert!(err.contains("維修中"), "{err}");
        assert!(started_args(&rig.runner).is_empty());
    }

    #[test]
    fn 執行檔不是對應程式就拒絕且不啟動() {
        let mut profiles = default_profiles();
        profiles.insert("gemini".into(), profile(r"C:\Windows\System32\cmd.exe", vec!["/c".into(), "calc".into()]));
        let rig = make(profiles, vec![]);
        let err = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap_err();
        assert!(err.contains("不是 agy"), "{err}");
        assert!(started_args(&rig.runner).is_empty(), "檔名核對被拿掉時，cmd.exe 會被啟動");
    }

    #[test]
    fn 工作資料夾不在允許清單就拒絕且不啟動() {
        let rig = make(default_profiles(), vec![]);
        let outside = tempfile::tempdir().unwrap();
        let outside = canonical_launch_cwd(&outside.path().to_string_lossy()).unwrap();
        let err = rig.svc.start("agy", &outside.to_string_lossy(), &rig.config).unwrap_err();
        assert!(err.contains("不在允許清單"), "{err}");
        assert!(rig.svc.start("agy", "  ", &rig.config).unwrap_err().contains("不在允許清單"));
        assert!(started_args(&rig.runner).is_empty(), "資料夾授權被拿掉時，清單外的資料夾也會啟動");
    }

    #[test]
    fn 開啟_agy_與_grok_只用啟動設定找到的執行檔並可列出() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        let id2 = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        assert_ne!(id, id2);
        let starts = started_args(&rig.runner);
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0], vec!["start", "--always-new-process", "--cwd", rig.cwd.as_str(), "--workspace", "asn-1", "--", "C:/bin/agy.exe"]);
        assert_eq!(starts[1], vec!["start", "--always-new-process", "--cwd", rig.cwd.as_str(), "--workspace", "asn-2", "--", "C:/bin/grok.exe"]);
        let titles: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "set-tab-title")).collect();
        assert_eq!(titles[0], vec!["cli", "set-tab-title", "--pane-id", "7", "ASN:1"]);
        assert_eq!(titles[1], vec!["cli", "set-tab-title", "--pane-id", "7", "ASN:2"]);
        let stored = std::fs::read_to_string(&rig.store).unwrap();
        assert!(!stored.contains("\"sock\""), "對照表不存通訊路徑");
        let v: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["terms"][0]["workspace"], "asn-1");
        assert_eq!(v["terms"][0]["title"], "ASN:1");
        assert_eq!(v["terms"][1]["workspace"], "asn-2");
        assert!(!starts.iter().any(|a| a.iter().any(|x| x == "agent" || x == "stdio" || x.contains("cmd.exe"))), "不帶內建通道參數，也不走陷阱編號 agy 的 cmd");
        let calls = rig.runner.inner.calls.borrow();
        assert_eq!(calls[0].1.get("WEZTERM_CONFIG_FILE").map(String::as_str), Some("cfg.lua"));
        let listed = rig.svc.list();
        assert_eq!(
            listed,
            vec![
                TermListed {
                    id: id.clone(),
                    profile: "agy".into(),
                    pid: 42,
                    started_ms: Some(1_000)
                },
                TermListed {
                    id: id2,
                    profile: "grok".into(),
                    pid: 42,
                    started_ms: Some(1_000)
                },
            ]
        );
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(json["id"], id);
        assert_eq!(json["profile"], "agy");
        assert_eq!(json["pid"], 42);
        assert_eq!(json["started_ms"], 1_000);
        assert_cli_uses_socket(&rig.runner);
    }

    #[test]
    fn 通訊檔不見就拒絕送字與讀取且不執行_cli() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        assert_cli_uses_socket(&rig.runner);
        let before = rig.runner.args().len();
        assert!(rig.files.borrow_mut().remove(&sock()));
        let send = rig.svc.send(&id, "不該送出", true).unwrap_err();
        let read = rig.svc.read(&id, 10).unwrap_err();
        assert!(send.contains("通訊檔不存在"), "{send}");
        assert!(read.contains("通訊檔不存在"), "{read}");
        assert_eq!(rig.runner.args().len(), before, "通訊檔不存在時不可執行 cli");
        // 關閉不走 cli，仍用對照表裡的 Window 核對建立時間
        rig.svc.stop(&id).unwrap();
        assert!(rig.svc.list().is_empty());
        assert_eq!(rig.runner.killed(), vec![42]);
    }

    #[test]
    fn 指令只收自己的編號_不能傳程序編號或通訊路徑() {
        let src = include_str!("term.rs");
        let lib = include_str!("../lib.rs");
        for name in ["TermStartReq", "TermSendReq", "TermReadReq", "TermStopReq", "TermStatusReq", "TermRenameReq"] {
            let marker = format!("struct {name}");
            let rest = src.split(&marker).nth(1).unwrap_or_else(|| panic!("找不到 {name}"));
            let body = rest.split('}').next().unwrap();
            assert!(!body.contains("pid") && !body.contains("sock") && !body.contains("gui_pid"), "{name} 不收程序編號或通訊路徑：{body}");
        }
        assert!(lib.contains("terms.stop(&req.id)"), "關閉只把編號交給 stop");
        assert!(lib.contains("terms.status(&req.id)"), "忙閒只把編號交給 status");
        assert!(lib.contains("terms.rename(&req.id, &req.title)"), "改名只把編號與標題交給 rename");
        assert!(!lib.contains("kill_tree"), "命令層不自己結束行程");
    }

    #[test]
    fn 未知編號拒絕且不送不讀不結束() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        let before = rig.runner.args().len();
        for op in [
            rig.svc.send("999", "你好", true).unwrap_err(),
            rig.svc.read("999", 10).unwrap_err(),
            rig.svc.stop("999").unwrap_err(),
            rig.svc.rename("999", "名稱").unwrap_err(),
            rig.svc.status("999").unwrap_err(),
        ] {
            assert!(op.contains("沒有這個終端"), "{op}");
        }
        assert_eq!(rig.runner.args().len(), before, "未知編號不可呼叫 WezTerm");
        assert!(rig.runner.killed().is_empty());
        rig.svc.send(&id, "仍可送自己的", false).unwrap();
    }

    #[test]
    fn 送字可選擇是否另送換行鍵且換行先壓成單行() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.send(&id, "第一行\n第二行", false).unwrap();
        rig.svc.send(&id, "請只回覆 OK", true).unwrap();
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].last().map(String::as_str), Some("第一行 第二行"));
        assert_eq!(sent[1].last().map(String::as_str), Some("請只回覆 OK"));
        assert_eq!(sent[2].last().map(String::as_str), Some("\r"));
        assert_eq!(rig.runner.inner.sleeps.borrow().len(), 1, "有 Enter 才在兩次之間等待");
    }

    #[test]
    fn 讀取行數超出範圍拒絕且不讀() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        let before = rig.runner.args().len();
        for n in [0, -1, MAX_READ_LINES + 1, i32::MAX] {
            let err = rig.svc.read(&id, n).unwrap_err();
            assert!(err.contains("讀取行數"), "{n}: {err}");
        }
        assert_eq!(rig.runner.args().len(), before, "行數上限被拿掉時會去呼叫 get-text");
        assert_eq!(rig.svc.read(&id, 1).unwrap(), "畫面一行");
        assert_eq!(rig.svc.read(&id, MAX_READ_LINES).unwrap(), "畫面一行");
        let gets: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "get-text")).collect();
        assert_eq!(gets[0], vec!["cli", "get-text", "--pane-id", "7", "--start-line=-1"]);
        assert!(gets[1].iter().any(|a| a == &format!("--start-line=-{MAX_READ_LINES}")));
    }

    #[test]
    fn 讀回超過長度上限會截斷() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = "字".repeat(MAX_READ_CHARS + 20);
        let text = rig.svc.read(&id, 3).unwrap();
        assert!(text.ends_with(TRUNC_MARK), "長度上限被拿掉時不會出現截斷註記");
        assert_eq!(text.chars().count(), MAX_READ_CHARS + TRUNC_MARK.chars().count());
        assert!(text.chars().filter(|c| *c == '字').count() == MAX_READ_CHARS);
        *rig.runner.inner.screen.borrow_mut() = "字".repeat(MAX_READ_CHARS);
        let exact = rig.svc.read(&id, 3).unwrap();
        assert_eq!(exact.chars().count(), MAX_READ_CHARS);
        assert!(!exact.contains("已截斷"));
    }

    #[test]
    fn 停止成功後編號移除_失敗則保留且不結束() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.stop(&id).unwrap();
        assert!(rig.svc.list().is_empty(), "停止成功後編號要移除");
        assert!(rig.svc.send(&id, "x", false).unwrap_err().contains("沒有這個終端"));
        assert!(rig.svc.stop(&id).unwrap_err().contains("沒有這個終端"));
        assert_eq!(rig.runner.killed(), vec![42]);
        let gone: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert!(gone["terms"].as_array().unwrap().is_empty(), "停掉之後對照表也不留這筆");

        let rig = make(default_profiles(), vec![Some(1_000), Some(2_000)]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        let err = rig.svc.stop(&id).unwrap_err();
        assert!(err.contains("別的程序"), "{err}");
        assert_eq!(rig.svc.list().len(), 1, "結束被拒絕時編號要留著");
        assert_eq!(rig.svc.list()[0].id, id);
        assert!(rig.runner.killed().is_empty(), "建立時間不同不可結束");
        let kept: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert_eq!(kept["terms"][0]["id"], id, "沒停成的編號要留在對照表");

        let rig = make(default_profiles(), vec![Some(1_000), None]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.stop(&id).unwrap();
        assert!(rig.svc.list().is_empty(), "視窗早已不在也要移除編號");
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn 視窗沒有窗格時不留下編號並結束剛啟動的視窗() {
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = "[]".into();
        let err = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap_err();
        assert!(err.contains("沒有可操作的窗格"), "{err}");
        assert!(rig.svc.list().is_empty());
        assert_eq!(rig.runner.killed(), vec![42]);
    }

    #[test]
    fn 隔離設定檔只在缺少時建立且不覆蓋() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wezterm-term.lua");
        let fs = FakeFs {
            files: Rc::new(RefCell::new(HashSet::new())),
        };
        let runner = FakeRunner {
            inner: Rc::new(fake_inner(vec![], "[]".into(), String::new())),
        };
        let svc = TermService::fixed(
            WezTermDir {
                gui: "W/wezterm-gui.exe".into(),
                cli: "W/wezterm.exe".into(),
            },
            path.clone(),
            dir.path().join("wezterm-terms.json"),
            "H".into(),
            runner,
            fs,
        );
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return {}\n");
        std::fs::write(&path, "return { kept = true }\n").unwrap();
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return { kept = true }\n", "已存在的隔離設定不可覆蓋");
    }

    fn one_pane(workspace: &str, tab: &str, pane: u64, cursor_x: i64) -> String {
        format!(r#"[{{"pane_id":{pane},"tab_id":1,"is_active":true,"cursor_x":{cursor_x},"cursor_y":2,"workspace":"{workspace}","tab_title":"{tab}"}}]"#)
    }

    fn row(id: &str, profile: &str, started: &str, extra: &str) -> String {
        format!(r#"{{"id":"{id}","profile":"{profile}","pid":42,"started_ms":{started},"pane_id":7,"workspace":"asn-{id}","title":"ASN:{id}"{extra}}}"#)
    }

    fn write_store(path: &Path, next: u64, terms: &str) {
        std::fs::write(path, format!(r#"{{"version":1,"next":{next},"terms":[{terms}]}}"#)).unwrap();
    }

    fn count_cmd(r: &FakeRunner, cmd: &str) -> usize {
        r.args().iter().filter(|a| a.iter().any(|x| x == cmd)).count()
    }

    #[test]
    fn agy_穩定停在提示符仍是_unknown() {
        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = "grok>\n".into();
        rig.svc.set_status_gap(Duration::from_millis(5));
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown");
        assert_eq!(st.profile, "agy");
        assert!(st.reason.contains("grok"), "{}", st.reason);
        assert!(st.cursor_x.is_none() && st.cursor_y.is_none());
        assert!(!rig.runner.args().iter().any(|a| a.iter().any(|x| x == "get-text")), "agy 不讀畫面");
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "agy 不取樣");
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn 兩次取樣之間只睡注入的間隔且停在提示符才是_idle() {
        let mut rig = make(default_profiles(), vec![]);
        assert_eq!(rig.svc.status_gap, STATUS_GAP);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = "前面一行\ngrok> \n".into();
        rig.svc.set_status_gap(Duration::from_millis(5));
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "idle");
        assert_eq!(st.profile, "grok");
        assert_eq!((st.cursor_x, st.cursor_y), (Some(1), Some(2)));
        assert!(st.reason.contains("提示符"), "{}", st.reason);
        let gets: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "get-text")).collect();
        assert_eq!(gets.len(), 2);
        assert!(gets.iter().all(|a| a.iter().any(|x| x == &format!("--start-line=-{STATUS_LINES}"))));
        let trace = rig.runner.inner.trace.borrow().clone();
        let i = trace.iter().position(|e| e.starts_with("sleep:")).expect("兩次取樣之間要睡一次");
        assert_eq!(trace.iter().filter(|e| e.starts_with("sleep:")).count(), 1, "只睡一次：{trace:?}");
        assert_eq!(trace[i], "sleep:5");
        assert_eq!(trace[i - 2], "run:get-text");
        assert_eq!(trace[i - 1], "run:list");
        assert_eq!(trace[i + 1], "run:get-text");
        assert_eq!(trace[i + 2], "run:list");
        assert_cli_uses_socket(&rig.runner);
    }

    #[test]
    fn 畫面或游標有變化就是_busy() {
        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        rig.svc.set_status_gap(Duration::from_millis(5));
        *rig.runner.inner.screens.borrow_mut() = vec!["grok>\n".into(), "grok>\n工作中\n".into()];
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "busy", "文字變了仍應是 busy：{}", st.reason);
        assert!(st.reason.contains("變化"), "{}", st.reason);

        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = "grok>\n".into();
        *rig.runner.inner.list_jsons.borrow_mut() = vec![one_pane("default", "", 7, 1), one_pane("default", "", 7, 9)];
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "busy", "游標動了、畫面沒變，不能當成閒置：{}", st.reason);
        assert_eq!((st.cursor_x, st.cursor_y), (Some(9), Some(2)));
    }

    #[test]
    fn 畫面沒變但不是提示符就是_unknown() {
        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        rig.svc.set_status_gap(Duration::from_millis(5));
        *rig.runner.inner.screen.borrow_mut() = "仍在想\n".into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown", "畫面停住但不是已確認的提示符，不能猜成閒置");
        assert!(st.reason.contains("提示符"), "{}", st.reason);
        assert_ne!(st.state, "idle");
    }

    #[test]
    fn 讀取失敗是_unknown且不結束() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.fail_substr.borrow_mut() = Some("get-text".into());
        *rig.runner.inner.screen.borrow_mut() = "grok>\n".into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown");
        assert!(st.reason.contains("無法判斷"), "{}", st.reason);
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "第一次就失敗不必再睡");
        assert!(rig.runner.killed().is_empty());
        assert_eq!(rig.svc.list()[0].id, id, "讀取失敗不影響對照表");
    }

    #[test]
    fn 改名只吃自己的編號並檢查長度與字元() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        let before = count_cmd(&rig.runner, "set-tab-title");
        let long = "好".repeat(41);
        for bad in ["", "   ", "a\nb", "a\tb", long.as_str()] {
            let err = rig.svc.rename(&id, bad).unwrap_err();
            assert!(err.contains("標題"), "{bad:?}: {err}");
        }
        assert_eq!(count_cmd(&rig.runner, "set-tab-title"), before, "不合法標題不可呼叫 set-tab-title");
        rig.svc.rename(&id, "  小良  ").unwrap();
        let titles: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "set-tab-title")).collect();
        assert_eq!(titles.last().unwrap(), &vec!["cli".to_string(), "set-tab-title".into(), "--pane-id".into(), "7".into(), "ASN:1 小良".into()]);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert_eq!(v["terms"][0]["title"], "ASN:1 小良");
        let ok = "名".repeat(40);
        rig.svc.rename(&id, &ok).unwrap();
        let titles: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "set-tab-title")).collect();
        assert!(titles.last().unwrap().last().unwrap().ends_with(&ok));
        assert_cli_uses_socket(&rig.runner);
    }

    #[test]
    fn 設定標題失敗就結束視窗且不留下編號() {
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.fail_substr.borrow_mut() = Some("set-tab-title".into());
        let err = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap_err();
        assert!(err.contains("標題"), "{err}");
        assert!(rig.svc.list().is_empty());
        assert_eq!(rig.runner.killed(), vec![42], "標題沒設上就要結束剛開的視窗");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert!(v["terms"].as_array().unwrap().is_empty());
    }

    #[test]
    fn 對照表寫不了就不啟動() {
        let dir = tempfile::tempdir().unwrap();
        let canon = canonical_launch_cwd(&dir.path().to_string_lossy()).unwrap();
        let cwd = canon.to_string_lossy().into_owned();
        let config = LaunchConfig {
            profiles: default_profiles(),
            cwd_allow: vec![canon],
            max_per_hour: 6,
        };
        let blocker = dir.path().join("not-dir");
        std::fs::write(&blocker, "x").unwrap();
        let files = Rc::new(RefCell::new(HashSet::from([sock()])));
        let runner = FakeRunner {
            inner: Rc::new(fake_inner(vec![], r#"[{"pane_id":7,"tab_id":1,"is_active":true}]"#.into(), String::new())),
        };
        let view = runner.clone();
        let svc = TermService::fixed(
            WezTermDir {
                gui: "W/wezterm-gui.exe".into(),
                cli: "W/wezterm.exe".into(),
            },
            "cfg.lua".into(),
            blocker.join("wezterm-terms.json"),
            "H".into(),
            runner,
            FakeFs { files },
        );
        let err = svc.start("agy", &cwd, &config).unwrap_err();
        assert!(err.contains("對照表"), "{err}");
        assert!(view.args().iter().all(|a| a.first().map(|s| s.as_str() != "start").unwrap_or(true)), "對照表寫不了就不可啟動視窗");
    }

    #[test]
    fn 重啟後標記與建立時間都對才認領且沿用原編號() {
        let rig = make(default_profiles(), vec![Some(1_000), Some(2_000)]);
        let pane7 = one_pane("asn-4", "ASN:4 舊名", 7, 1);
        let pane99 = one_pane("asn-99", "ASN:99", 99, 0);
        let body7 = pane7.trim_start_matches('[').trim_end_matches(']');
        let body99 = pane99.trim_start_matches('[').trim_end_matches(']');
        *rig.runner.inner.list_json.borrow_mut() = format!("[{body7},{body99}]");
        write_store(&rig.store, 7, &row("4", "grok", "1000", ""));
        rig.svc.reclaim().unwrap();
        let listed = rig.svc.list();
        assert_eq!(listed.len(), 1, "檔案沒有的窗格不可認領");
        assert_eq!(listed[0].id, "4");
        assert_eq!(listed[0].profile, "grok");
        assert_eq!(listed[0].pid, 42);
        assert_eq!(listed[0].started_ms, Some(1_000));
        assert!(rig.runner.killed().is_empty(), "認領不結束視窗");
        assert_cli_uses_socket(&rig.runner);
        assert_eq!(rig.svc.read("4", 1).unwrap(), "畫面一行");
        let gets: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "get-text")).collect();
        assert!(gets[0].iter().any(|a| a == "7"), "要沿用對上的窗格");
        assert!(gets.iter().all(|a| !a.iter().any(|x| x == "99")));
        let err = rig.svc.stop("4").unwrap_err();
        assert!(err.contains("別的程序"), "{err}");
        assert!(rig.runner.killed().is_empty(), "認領回來的視窗關閉仍要核對建立時間");
        assert_eq!(rig.svc.list().len(), 1);

        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-4", "ASN:4", 7, 1);
        write_store(&rig.store, 7, &row("4", "agy", "1000", ""));
        rig.svc.reclaim().unwrap();
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        assert_eq!(id, "8", "編號要從對照表的 next 接著編，不可重複");
    }

    #[test]
    fn 建立時間不同或程序已不在就不認領且不結束() {
        let rig = make(default_profiles(), vec![Some(2_000), Some(2_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1", 7, 1);
        write_store(&rig.store, 1, &row("1", "grok", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty(), "建立時間不同不可認領");
        assert!(rig.runner.killed().is_empty(), "建立時間不同不可結束");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert!(v["terms"].as_array().unwrap().is_empty(), "對不上的紀錄要從對照表拿掉，避免以後指到別人的程序");

        let rig = make(default_profiles(), vec![None]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1", 7, 1);
        write_store(&rig.store, 1, &row("1", "agy", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty());
        assert!(rig.runner.killed().is_empty(), "程序已經不在也不可結束");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert!(v["terms"].as_array().unwrap().is_empty());
    }

    #[test]
    fn 通訊檔不見就不認領且不執行_cli() {
        let src = include_str!("term.rs");
        let head = src.split("pub fn reclaim").nth(1).unwrap().split("pub fn ").next().unwrap();
        let exists_at = head.find("self.fs.exists(&sock)").expect("認領要先看通訊檔");
        let list_at = head.find(".list(&sock)").expect("認領要 list");
        assert!(exists_at < list_at, "要先確認通訊檔再 list");

        let rig = make(default_profiles(), vec![]);
        assert!(rig.files.borrow_mut().remove(&sock()));
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1", 7, 1);
        write_store(&rig.store, 3, &row("1", "grok", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty(), "通訊檔不在不可放進對照表");
        assert!(rig.runner.args().is_empty(), "通訊檔不在不可執行 cli");
        assert!(rig.runner.killed().is_empty());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert_eq!(v["terms"][0]["id"], "1", "這次看不到就留著，下次再試");
        assert_eq!(v["next"], 3);
    }

    #[test]
    fn 辨識不出來的一律不認領也不結束() {
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-3", "ASN:3", 7, 1);
        write_store(&rig.store, 3, &row("3", "claude", "1000", r#","sock":"/tmp/not-ours""#));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().iter().all(|s| s.profile != "claude"));
        assert!(rig.svc.list().is_empty());
        assert!(rig.runner.args().is_empty(), "非白名單不可執行 cli");
        assert!(rig.runner.killed().is_empty());

        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "ASN:12", 7, 1);
        write_store(&rig.store, 1, &row("1", "agy", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty(), "ASN:12 不是 ASN:1");
        assert!(rig.runner.killed().is_empty());

        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "ASN:1foo", 7, 1);
        write_store(&rig.store, 1, &row("1", "agy", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty(), "ASN:1foo 不是 ASN:1");
        assert!(rig.runner.killed().is_empty());

        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "cmd.exe", 7, 1);
        write_store(&rig.store, 1, &row("1", "grok", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty(), "workspace 與分頁標題都不是我們的就不可認領");
        assert!(rig.runner.killed().is_empty());

        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "ASN:1 小良", 7, 1);
        write_store(&rig.store, 1, &row("1", "grok", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert_eq!(rig.svc.list().len(), 1, "分頁標題前綴對上就可以認領，不必再猜 workspace");
        assert_eq!(rig.svc.list()[0].id, "1");
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn 認領重算通訊路徑不採用檔案裡的路徑() {
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "", 7, 3);
        write_store(&rig.store, 1, &row("1", "agy", "1000", r#","sock":"/tmp/not-ours""#));
        rig.svc.reclaim().unwrap();
        assert_eq!(rig.svc.list().len(), 1, "只有 workspace 標記也要認領");
        assert_cli_uses_socket(&rig.runner);
        let calls = rig.runner.inner.calls.borrow();
        assert!(calls.iter().all(|(_, env)| env.get("WEZTERM_UNIX_SOCKET").map(String::as_str) != Some("/tmp/not-ours")));
        assert!(calls
            .iter()
            .filter(|(a, _)| a.first().map(|s| s == "cli").unwrap_or(false))
            .all(|(_, env)| { env.get("WEZTERM_UNIX_SOCKET").map(String::as_str) == Some(sock().to_string_lossy().as_ref()) }));
    }

    #[test]
    fn 對照表版本不對或找不到程式就不碰檔案也不結束() {
        let rig = make(default_profiles(), vec![]);
        let foreign = r#"{"version":2,"next":3,"terms":[{"id":"1","profile":"grok","pid":42,"started_ms":1000,"pane_id":7,"workspace":"asn-1","title":"ASN:1"}]}"#;
        std::fs::write(&rig.store, foreign).unwrap();
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1", 7, 1);
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty());
        assert!(rig.runner.killed().is_empty());
        assert!(rig.runner.args().is_empty());
        assert_eq!(std::fs::read_to_string(&rig.store).unwrap(), foreign, "不認得的版本不可覆蓋");

        std::fs::write(&rig.store, "{").unwrap();
        let err = rig.svc.reclaim().unwrap_err();
        assert!(err.contains("對照表"), "{err}");
        assert!(rig.runner.killed().is_empty());
        assert_eq!(std::fs::read_to_string(&rig.store).unwrap(), "{");

        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("wezterm-terms.json");
        let body = format!(r#"{{"version":1,"next":1,"terms":[{}]}}"#, row("1", "grok", "1000", ""));
        std::fs::write(&store, &body).unwrap();
        let runner = FakeRunner {
            inner: Rc::new(fake_inner(vec![Some(1_000)], one_pane("asn-1", "ASN:1", 7, 1), "畫面".into())),
        };
        let view = runner.clone();
        let files = Rc::new(RefCell::new(HashSet::from([sock()])));
        let svc = TermService::without_wezterm(store.clone(), "H".into(), runner, FakeFs { files });
        svc.reclaim().unwrap();
        assert!(svc.list().is_empty());
        assert!(view.killed().is_empty());
        assert!(view.args().is_empty(), "找不到 WezTerm 不可執行 cli");
        assert_eq!(std::fs::read_to_string(&store).unwrap(), body);
    }

    /// 真機實測（預設不跑，會在桌面開一個 grok 視窗；不登入、不送字、不呼叫模型）：
    /// ASN_WEZTERM_DIR=<隔離副本> ASN_LIVE_GROK=<grok.exe 路徑> cargo test --lib launch::term::tests::live -- --ignored --nocapture
    /// 啟動 → list → 改名（再用 wezterm list 看分頁標題與 workspace）→ 讀畫面首行 → status → 模擬 ASN 重啟（新服務用同一份對照表檔 reclaim）→ 用新服務結束視窗。
    #[test]
    #[ignore]
    fn live_start_rename_status_restart_reclaim_stop() {
        let grok = std::env::var("ASN_LIVE_GROK").expect("請設定 ASN_LIVE_GROK");
        let dir = wezterm::locate(&wezterm::RealFs).expect("請設定 ASN_WEZTERM_DIR");
        let tmp = std::env::temp_dir().join(format!("asn-term-live-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = canonical_launch_cwd(&tmp.to_string_lossy()).unwrap();
        let cwd = canon.to_string_lossy().into_owned();
        let mut profiles = HashMap::new();
        profiles.insert("grok".to_string(), profile(&grok, vec!["agent".into(), "stdio".into()]));
        let config = LaunchConfig { profiles, cwd_allow: vec![canon], max_per_hour: 6 };
        let cfg_file = tmp.join("wezterm-term.lua");
        let store = tmp.join("wezterm-terms.json");
        let home = crate::identity::home_dir();
        let mk = || TermService::fixed(dir.clone(), cfg_file.clone(), store.clone(), home.clone(), wezterm::RealRunner, wezterm::RealFs);
        let svc = mk();
        svc.ensure_config().expect("隔離設定");
        let mut stop_with: Option<&TermService<wezterm::RealRunner, wezterm::RealFs>> = Some(&svc);
        let svc2 = mk();
        let result = (|| -> Result<(), String> {
            let id = svc.start("grok", &cwd, &config)?;
            println!("started id={id}");
            std::thread::sleep(Duration::from_millis(2500));
            let listed = svc.list();
            assert_eq!(listed.len(), 1, "list 應該有一個");
            svc.rename(&id, "live 測試")?;
            let w = wezterm::WezTerm::new(dir.clone(), cfg_file.clone(), home.clone(), &wezterm::RealRunner, &wezterm::RealFs);
            let sock = wezterm::sock_path(&home, listed[0].pid);
            let panes = w.list(&sock)?;
            println!("panes: {:?}", panes.iter().map(|p| (p.pane_id, p.tab_title.clone(), p.workspace.clone(), p.title.clone())).collect::<Vec<_>>());
            assert!(panes.iter().any(|p| p.tab_title.starts_with(&format!("ASN:{id} "))), "分頁標題應以 ASN:{id} 開頭");
            let screen = svc.read(&id, 20)?;
            println!("--- grok 畫面（最後 20 行）---
{screen}");
            let st = svc.status(&id)?;
            println!("status: state={} reason={}", st.state, st.reason);
            // 模擬 ASN 重啟：記憶體對照表是空的，靠檔案認領
            assert!(svc2.list().is_empty());
            svc2.reclaim()?;
            let re = svc2.list();
            println!("reclaim 後 list: {:?}", re.iter().map(|t| (t.id.clone(), t.pid)).collect::<Vec<_>>());
            assert_eq!(re.len(), 1, "重啟後應只認回自己的那一個");
            assert_eq!(re[0].id, id);
            assert_eq!(re[0].pid, listed[0].pid);
            stop_with = Some(&svc2);
            svc2.stop(&id)?;
            stop_with = None;
            Ok(())
        })();
        if let Some(s) = stop_with {
            for t in s.list() {
                let _ = s.stop(&t.id);
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        result.expect("實測失敗");
    }
}
