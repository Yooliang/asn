//! WezTerm 終端的命令層（議題 #285）。
//! ASN 不渲染終端內容。啟停、送字、讀輸出之外，這一輪加上忙閒、改名，以及 ASN 重啟後認領自己開過的視窗。
//! 不接 UI、不進安裝包。
//!
//! 審查約束（沿用 #286，這裡不繞過）：
//! - 對照表是「自己開的編號 → Window」。Window 帶啟動時量到的 started_ms。呼叫端只能給編號，不能給程序編號或通訊路徑；關閉一律走會核對建立時間的 stop。
//! - 每次 cli 都經模組帶 WEZTERM_UNIX_SOCKET；通訊檔不存在時模組直接拒絕，不會執行 cli。認領也先看通訊檔在不在，不在就不呼叫 cli。
//! - profile 只准 agy 與 grok。認領時檔案裡其他 profile 一律不接手、不結束。
//! - 0.2.0 第 1 階段：ASN 開的夥伴視窗（claude 等）也記進同一張表（kind "claude"／"window"，見 win_term）。
//!   這一階段只用來「認得是 ASN 開的」、切前景／背景、關閉時收掉 GUI；讀畫面、送字、代答、改名一律不開放（第 4 階段才做）。
//!
//! 忙閒只實作 grok：連續兩次取樣（中間用 Runner::sleep，間隔可注入；假執行器不真的等）畫面與游標都沒變，
//! 且最近 40 行裡有空的輸入框（去掉兩端空白後以「│ ❯」開頭，右邊線與佔位「…」不算字），才是 idle。框裡有別的字、agy、或讀取失敗都是 unknown。
//! 畫面含信任提問、或解析得出選單、或選單模樣但解析不出時是 waiting_user，並附上 prompt。絕不代答。
//! 處理中輸入框仍是空的，但畫面含「[stop]」或「Ctrl+c:cancel」。這在 waiting_user 之後、閒置之前直接 busy，不等第二次取樣。
//! 代答只有 term_answer。這個命令本身證明不了使用者有按確認，UI 的提示框必須是唯一入口，後端其他路徑不得呼叫它。
//! 代送文字只有 confirm_send（命令 term_send）。同樣證明不了使用者有按確認，UI 的確認必須是唯一入口，後端其他路徑不得呼叫它。
//! 送出前該終端的工作資料夾要有授權記錄：在 ASN 選定並通過允許清單而開啟，或使用者在信任提問按了信任。沒有記錄就不送。
//! 按鍵只從固定對照表產生，走專用的送出（ESC [ A、ESC [ B、\r、ESC）。一般送字仍先壓行，那個會丟掉 ESC 的保護不放寬。
//!
//! 認領不掃整個系統。只讀 data_dir 裡自己寫的對照表，用記下的程序編號重算通訊路徑（檔案裡的路徑一律不理），
//! 建立時間相符且通訊檔存在才 list。workspace 是 `asn-{編號}`，或分頁標題是 `ASN:{編號}`（或後面空一格）才放回對照表。
//! 辨識不出來的不放進表、也不結束那個程序。
//!
//! 作業系統介面沿用 wezterm 的 Runner／Fs，測試注入假實作，不會啟動真的 WezTerm。
#![cfg(desktop)]

use super::config::{canonical_launch_cwd, LaunchConfig};
pub use super::term_adopt::TermAdoptCandidate;
use super::term_adopt::{self, AdoptedSession, AdoptedSnap};
use super::wezterm::{self, Fs, Runner, WezTerm, WezTermDir, Window};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// ASN 自己的 WezTerm 設定檔內容（隔離，不讀使用者的 ~/.wezterm.lua）。
/// exit_behavior = "Hold"：程式結束後視窗留著，讓人看得到最後的畫面（取代以前承載 PowerShell 印的「程式已結束」）
pub(crate) const ISOLATED_CONFIG: &str = "return { exit_behavior = \"Hold\" }\n";
/// 0.1.113 寫的隔離設定（開關 ASN_TERM_WEZTERM 關著時照舊寫這份）
pub(crate) const LEGACY_CONFIG: &str = "return {}\n";
/// 建不起視窗時的備援設定（#595）：同一份隔離設定再加 `front_end = "WebGpu"`（OpenGL 與 Software 在桌面斷線時都建不起視窗，只有 WebGpu 起得來）。
/// 從目前那份設定產生，之後隔離設定加什麼，備援設定自動跟著有
pub(crate) fn with_webgpu(cfg: &str) -> String {
    let inner = cfg.find('{').zip(cfg.rfind('}')).map(|(a, b)| cfg[a + 1..b].trim().trim_end_matches(',').trim()).unwrap_or("");
    if inner.is_empty() {
        "return { front_end = \"WebGpu\" }\n".to_string()
    } else {
        format!("return {{ {inner}, front_end = \"WebGpu\" }}\n")
    }
}
/// 舊版寫的空設定：升級時換成 ISOLATED_CONFIG（使用者改過的內容一律不動）
const OLD_DEFAULT_CONFIG: &str = "return {}";

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
/// mux 窗格操作前核對到 mux 已經不是開窗格時那一個
const MUX_GONE: &str = "終端服務重新啟動過，這個窗格已經跟著舊的服務結束了；請重新開";
/// 看畫面的 GUI 剛起就結束（規格 11.2-9）：只影響「看」，夥伴不受影響。給人看的話，一個字都不能改
pub(crate) const VIEW_NO_DESKTOP: &str = "這台電腦的桌面目前沒有人登入，開不了終端畫面；夥伴照常在背景執行";
/// 看畫面的 GUI 起來後，這段時間內就結束算失敗
const VIEW_FAIL_WINDOW: Duration = Duration::from_secs(3);
const VIEW_POLL: Duration = Duration::from_millis(200);
const VIEW_BIRTH_RETRIES: u32 = 5;
/// 看畫面的 GUI 至少要活過這麼久才算開成功：桌面沒人登入時它會先冒出視窗、約 0.3 秒後才崩潰（B4 工作機實測）
const VIEW_MIN_ALIVE: Duration = Duration::from_secs(1);
const TRUNC_MARK: &str = "…（已截斷）";
/// grok 1.0.70 登入後閒置時，輸入框那一行的行首。空框後面可以是佔位「…」，那不算使用者正在打字。
const GROK_INPUT_MARK: &str = "│ ❯";
/// grok 第一次打開資料夾時的信任提問。畫面裡出現這句就回 waiting_user，絕不代送 y 或其他字。
const GROK_TRUST_MARK: &str = "Do you trust the contents of this directory";
/// grok 處理中：右側「22s ⇣25.2k [stop]」，底列換成含「Ctrl+c:cancel」。空輸入框仍在，不能單靠輸入框判閒置。
const GROK_BUSY_STOP: &str = "[stop]";
const GROK_BUSY_CANCEL: &str = "Ctrl+c:cancel";
/// 回給前端的提問原文上限（字，不是位元組）。
const PROMPT_TEXT_CHARS: usize = 500;
/// 解析不出選單時，原文取畫面底部這幾行（與忙閒取樣同一扇窗）。
const PROMPT_TEXT_LINES: usize = 40;
/// 選單從目前游標往下，最多幾步。超過就拒絕，不送鍵。
const MAX_MENU_DOWN: u32 = 20;
/// 一次代答的按鍵數上限（含 Enter）。與往下步數分開算。
const MAX_ANSWER_KEYS: usize = 32;

/// `term_list` 的一列。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermListed {
    pub id: String,
    pub profile: String,
    pub pid: u32,
    pub started_ms: Option<u64>,
    /// 開啟時已通過授權的工作資料夾。記下來的那次，不是事後重查。
    pub cwd: String,
    /// 使用者自己開的窗格、由 ASN 接手（只存記憶體）。
    #[serde(default)]
    pub adopted: bool,
    /// 接手窗格：本機是否已解鎖代答（自己開的終端一律 true）。
    #[serde(default = "default_unlocked")]
    pub answer_unlocked: bool,
    /// 接手窗格：本機是否已解鎖代送（自己開的終端一律 true）。
    #[serde(default = "default_unlocked")]
    pub send_unlocked: bool,
}

fn default_unlocked() -> bool {
    true
}

/// pi 的狀態說明：忙碌與閒置在名單上（pi 的 ASN 擴充回報），終端面板不另外判斷
const PI_STATE_ELSEWHERE: &str = "pi 的忙碌與閒置請看名單";

/// `term_status` 的結果。state 只會是 busy、idle、unknown、waiting_user。判斷不了就是 unknown，不會猜。
/// waiting_user 才有 prompt；其他狀態 prompt 是空的。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermStatus {
    pub state: String,
    pub profile: String,
    pub cursor_x: Option<i64>,
    pub cursor_y: Option<i64>,
    pub reason: String,
    pub prompt: Option<TermPrompt>,
}

/// 畫面上等使用者回答的提問。kind 只會是 trust_dialog、menu、unknown_prompt。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermPrompt {
    pub kind: String,
    pub text: String,
    pub options: Vec<TermOption>,
}

/// 選項編號從 1 起算。label 是畫面上的文字；信任提問的兩項是固定的。
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct TermOption {
    pub n: u32,
    pub label: String,
}

/// `term_answer` 實際送出的按鍵描述，給前端顯示。不是原始控制碼。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TermAnswered {
    pub keys: String,
}

struct Session {
    id: String,
    profile: String,
    window: Window,
    pane_id: u64,
    workspace: String,
    /// 設到分頁上的完整標題（含 ASN 前綴）。
    title: String,
    /// 開啟時已通過授權的工作資料夾。
    cwd: String,
    /// 使用者授權 ASN 把文字送進這個終端。開啟時資料夾通過允許清單，或信任提問按了信任，才是真。
    send_granted: bool,
    /// 經開窗點開的夥伴視窗：「claude」或「window」；終端面板開的（agy／grok／pi）是空字串
    kind: String,
    /// claude 視窗開的時候參數裡的對話編號（新對話還沒有）
    session_id: Option<String>,
}

struct SessionSnap {
    id: String,
    profile: String,
    window: Window,
    pane_id: u64,
    cwd: String,
    send_granted: bool,
    adopted: Option<AdoptedSnap>,
}

struct Inner {
    next: u64,
    sessions: Vec<Session>,
    adopted: Vec<AdoptedSession>,
    /// 建立時間曾相符、但這次通訊檔不在（或 list 失敗），留在檔案裡下次再試。不放進可操作的對照表，也不對它們下 cli。
    parked: Vec<StoreTerm>,
    /// B2c：看 mux 窗格的 GUI（只存記憶體；ASN 重啟後不認，使用者要看再開一個）
    viewers: Vec<Viewer>,
}

/// 看某個 mux 窗格的 GUI（`wezterm-gui connect`）。關它不影響窗格（B0 實測）；只認自己起的這一個程序（編號＋建立時間）
#[derive(Clone)]
struct Viewer {
    id: String,
    pid: u32,
    started_ms: u64,
    /// 正在起（還沒拿到程序編號）：同一個終端這時再要求看，直接當成已在處理
    starting: bool,
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
    /// 舊對照表沒有這欄就當空字串，不猜一個資料夾。
    #[serde(default)]
    cwd: String,
    /// 舊對照表沒有這欄就當沒授權，不能代送文字。
    #[serde(default)]
    send_granted: bool,
    /// 0.2.0：經開窗點開的夥伴視窗（claude／window）。舊對照表沒有這欄＝空字串（終端面板開的）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    kind: String,
    /// 0.2.0：claude 視窗開的時候參數裡的對話編號。舊對照表沒有這欄＝None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    /// B2b：窗格在共用 mux 裡（pid／started_ms 記的是 mux）。舊對照表沒有這欄＝第 1 階段（自己的 GUI），照舊認領
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    mux: bool,
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

/// 產生 agy 額外參數的函式（每次開 agy 終端時叫一次）
pub type AgyArgs = Box<dyn Fn() -> Vec<String> + Send + Sync>;

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
    /// 開 agy 時另外帶的參數（#374：`--settings <檔>` 接上 Gemini 狀態列，見 gemini_session.rs）。
    /// 正式由 live() 設定；沒設（測試、沒有畫面的建置）就照舊只跑執行檔。回空的＝這次不帶。
    agy_args: Option<AgyArgs>,
    /// B2b 開關（預設關＝行為跟第 1 階段完全一樣）。開了就改開在共用的 mux 裡；正式由 live() 讀 ASN_TERM_MUX 設定
    use_mux: bool,
    /// 隔離設定檔要不要帶 exit_behavior = "Hold"（0.2.0 第 1 階段的做法）。預設 false＝跟 0.1.113 一樣只寫空設定；
    /// 正式由 live() 在 ASN_TERM_WEZTERM=1 時設 true（#611）
    hold_config: bool,
    /// mux 的檔案放在這底下的 ASN\m（正式＝%LOCALAPPDATA%；測試注入暫存資料夾）
    mux_base: Option<PathBuf>,
    inner: Mutex<Inner>,
    /// 單元測試注入啟動設定，避免依賴本機 launcher.json。
    #[cfg(test)]
    test_launch_config: Mutex<Option<LaunchConfig>>,
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
            agy_args: None,
            use_mux: false,
            hold_config: false,
            mux_base: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            inner: Mutex::new(Inner {
                next: 0,
                sessions: Vec::new(),
                adopted: Vec::new(),
                parked: Vec::new(),
                viewers: Vec::new(),
            }),
            #[cfg(test)]
            test_launch_config: Mutex::new(None),
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
            agy_args: None,
            use_mux: false,
            hold_config: false,
            mux_base: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            inner: Mutex::new(Inner {
                next: 0,
                sessions: Vec::new(),
                adopted: Vec::new(),
                parked: Vec::new(),
                viewers: Vec::new(),
            }),
            #[cfg(test)]
            test_launch_config: Mutex::new(None),
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
            agy_args: None,
            use_mux: false,
            hold_config: false,
            mux_base: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            inner: Mutex::new(Inner {
                next: 0,
                sessions: Vec::new(),
                adopted: Vec::new(),
                parked: Vec::new(),
                viewers: Vec::new(),
            }),
            #[cfg(test)]
            test_launch_config: Mutex::new(None),
        }
    }

    fn launch_config_for_adopt(&self) -> Result<LaunchConfig, String> {
        #[cfg(test)]
        if let Some(c) = self.test_launch_config.lock().unwrap().clone() {
            return Ok(c);
        }
        super::config::load_launch_config()
    }

    /// 開／關 B2b 的 mux 模式。正式只由 live() 依 ASN_TERM_MUX 設一次
    pub fn set_hold_config(&mut self, on: bool) {
        self.hold_config = on;
    }

    pub fn set_use_mux(&mut self, on: bool) {
        self.use_mux = on;
    }

    /// 測試注入 mux 檔案的位置（不碰真的 %LOCALAPPDATA%）
    #[cfg(test)]
    fn set_mux_base(&mut self, base: PathBuf) {
        self.mux_base = Some(base);
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
        let mut w = WezTerm::new(dir.clone(), self.config_file.clone(), self.home.clone(), &self.runner, &self.fs);
        w.no_auto_start = self.use_mux;
        w
    }

    /// 隔離用的 WezTerm 設定。沒有才寫一份（避免吃到使用者的 `~/.wezterm.lua`）；舊版寫的空設定升級成帶 exit_behavior 的；
    /// 其他已存在的內容不覆蓋（避免改到實驗中途寫過的內容）。
    #[cfg_attr(not(any(feature = "gui", test)), allow(dead_code))]
    fn ensure_config(&self) -> Result<(), String> {
        if self.config_file.is_file() {
            // 開關關著（hold_config=false）＝0.1.113 的空設定：已存在的不升級；
            // 唯一例外（#611）：內容剛好等於第 1 階段寫的 ISOLATED_CONFIG（一個字不差）才改回空設定，其他內容（使用者改過的）一律不動
            let old = std::fs::read_to_string(&self.config_file).unwrap_or_default();
            let ours_to_rewrite = if self.hold_config { old.trim() == OLD_DEFAULT_CONFIG } else { old == ISOLATED_CONFIG };
            if !ours_to_rewrite {
                return Ok(());
            }
        }
        if let Some(parent) = self.config_file.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("無法建立終端設定資料夾：{e}"))?;
            }
        }
        let content = if self.hold_config { ISOLATED_CONFIG } else { LEGACY_CONFIG };
        std::fs::write(&self.config_file, content).map_err(|e| format!("無法建立隔離的 WezTerm 設定：{e}"))
    }

    /// 備援用的設定檔（#595）：跟隔離設定同一份內容再加 `front_end = "WebGpu"`，放在同資料夾、檔名加 `-webgpu`。
    /// 這份是 ASN 自己的備援，每次都照現在的開關重寫；使用者的設定檔不動。回它的路徑
    fn ensure_webgpu_config(&self) -> Result<PathBuf, String> {
        let name = self.config_file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "wezterm".into());
        let path = self.config_file.with_file_name(format!("{name}-webgpu.lua"));
        let content = with_webgpu(if self.hold_config { ISOLATED_CONFIG } else { LEGACY_CONFIG });
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| format!("無法建立終端設定資料夾：{e}"))?;
        }
        std::fs::write(&path, &content).map_err(|e| format!("無法建立備援的 WezTerm 設定：{e}"))?;
        Ok(path)
    }

    /// 開一個終端。profile 只准 agy／grok，執行檔與工作資料夾都來自既有啟動設定，不接受呼叫端指定的指令。
    /// 視窗帶 workspace `asn-{編號}`，分頁標題設成 `ASN:{編號}`。標題設不下去就結束剛開的視窗，不留沒有標記的孤兒。
    pub fn start(&self, profile: &str, cwd: &str, config: &LaunchConfig) -> Result<String, String> {
        let command = resolve_command(profile, config)?;
        let cwd = authorize_cwd(config, cwd)?;
        let argv = self.argv_for(profile, command);
        self.open(profile, cwd, &argv, None, &OpenExtra::default()).map(|(id, _)| id)
    }

    /// 設定開 agy 時另外帶的參數（只對 agy；grok 不帶）
    pub fn set_agy_args(&mut self, f: AgyArgs) {
        self.agy_args = Some(f);
    }

    /// 執行檔＋額外參數。額外參數只認 `--settings <值>` 這一組，其他一律不帶（避免被當成任意指令的入口）。
    fn argv_for(&self, profile: &str, command: String) -> Vec<String> {
        let mut argv = vec![command];
        if profile == "agy" {
            if let Some(f) = &self.agy_args {
                let extra = f();
                if let [flag, value] = extra.as_slice() {
                    if flag == "--settings" && !value.trim().is_empty() && !value.chars().any(|c| c.is_control()) {
                        argv.extend(extra);
                    }
                }
            }
        }
        argv
    }

    /// 經 pi 開在 ASN 自帶的終端（#475）。指令與參數由呼叫端照本機 pi 的啟動設定組好（build_spawn_spec＋pi::plan，跟原生主控台同一份），
    /// 資料夾也由呼叫端照開新夥伴的規則驗過；這裡只再確認「執行的真的是 pi」、資料夾存在。
    /// env＝已照 child_env 濾掉金鑰類變數的環境，GUI 與 pi 只拿到這些（不繼承 ASN 自己的環境）。回（終端編號, GUI 的程序編號）
    pub fn start_pi(&self, cwd: &Path, argv: &[String], env: &BTreeMap<String, String>) -> Result<(String, u32), String> {
        self.start_pi_staged(cwd, argv, env).map_err(|e| match e {
            super::win_term::WinOpenError::NotStarted(m) | super::win_term::WinOpenError::Started(m) => m,
        })
    }

    /// 同 start_pi，失敗時另外說明 GUI 啟動了沒有（pi 的退路也只在還沒啟動時才走，見 pi_term）
    pub(crate) fn start_pi_staged(&self, cwd: &Path, argv: &[String], env: &BTreeMap<String, String>) -> Result<(String, u32), super::win_term::WinOpenError> {
        use super::win_term::WinOpenError::NotStarted;
        let Some(exe) = argv.first() else { return Err(NotStarted("沒有指定要執行的指令".into())) };
        if !crate::bridge::procscan::is_pi_process(exe, argv) {
            return Err(NotStarted("要開的程式不是 pi，已拒絕".into()));
        }
        if !cwd.is_dir() {
            return Err(NotStarted(format!("工作資料夾不存在：{}", cwd.display())));
        }
        self.open_staged("pi", cwd.to_path_buf(), argv, Some(env), &OpenExtra::default())
    }

    /// 開窗點（local::start_window）開夥伴視窗（0.2.0 第 1 階段，設計 1.1～1.2）。指令與參數由呼叫端照本機啟動設定組好，這裡不改一個字；
    /// 只再確認種類、資料夾存在。env＝已照 child_env 濾掉金鑰類變數的環境。寫進對照表（kind、session_id），回（終端編號, GUI 的程序編號）
    /// 失敗分兩種（見 win_term::WinOpenError）：GUI 還沒啟動（NotStarted，上層可改用原生主控台）、已經啟動之後才失敗（Started，上層不能再開一份）
    pub(crate) fn start_window(&self, cwd: &Path, spec: &super::win_term::WinSpec) -> Result<(String, u32), super::win_term::WinOpenError> {
        use super::win_term::WinOpenError::NotStarted;
        if spec.argv.is_empty() {
            return Err(NotStarted("沒有指定要執行的指令".into()));
        }
        if spec.kind != super::win_term::KIND_CLAUDE && spec.kind != super::win_term::KIND_WINDOW {
            return Err(NotStarted("不認得的視窗種類".into()));
        }
        if !cwd.is_dir() {
            return Err(NotStarted(format!("工作資料夾不存在：{}", cwd.display())));
        }
        let extra = OpenExtra { kind: spec.kind.to_string(), session_id: spec.session_id.clone(), label: normalize_title(&spec.title).ok() };
        self.open_staged(spec.kind, cwd.to_path_buf(), &spec.argv, Some(&spec.env), &extra)
    }

    /// ASN 自己開的終端（不含接手的窗格）的（GUI 程序編號, 開的時候量到的建立時間）：判斷「ASN 開的」要兩個都對（設計 1.2）
    pub fn own_gui_windows(&self) -> Vec<(u32, u64)> {
        self.inner.lock().unwrap().sessions.iter().filter(|s| !s.window.mux).filter_map(|s| s.window.started_ms.map(|t| (s.window.gui_pid, t))).collect()
    }

    /// 關夥伴視窗的最後一步（設計 1.3）：claude 那棵已經結束後，收掉承載它的 GUI。
    /// 只動對照表裡的那一個，交給 wezterm::stop 核對建立時間（對不上就不動、留在表上）；不認得的 GUI 一律不關
    pub fn stop_gui(&self, gui_pid: u32) -> Result<(), String> {
        let (id, window) = {
            let g = self.inner.lock().unwrap();
            let s = g.sessions.iter().find(|s| !s.window.mux && s.window.gui_pid == gui_pid).ok_or_else(|| "這個視窗不是 ASN 開的，不關".to_string())?;
            (s.id.clone(), s.window.clone())
        };
        let dir = self.dir()?;
        self.wez(&dir).stop(&window)?;
        {
            let mut g = self.inner.lock().unwrap();
            g.sessions.retain(|s| s.id != id);
        }
        self.persist()
    }

    /// ASN 自己開的終端（不含接手的窗格）各自的 GUI 程序編號：切前景／背景只認這些（#475）
    pub fn own_gui_pids(&self) -> Vec<u32> {
        self.inner.lock().unwrap().sessions.iter().filter(|s| !s.window.mux).map(|s| s.window.gui_pid).collect()
    }

    /// 開一個終端並記進對照表：視窗帶 workspace `asn-{編號}`、分頁標題 `ASN:{編號}`；標題設不下去就結束剛開的視窗，不留沒有標記的孤兒。
    /// env 有給＝GUI 只拿到這些環境變數（經 pi）；沒給＝照舊繼承（agy／grok）
    fn open(&self, profile: &str, cwd: PathBuf, command: &[String], env: Option<&BTreeMap<String, String>>, extra: &OpenExtra) -> Result<(String, u32), String> {
        self.open_staged(profile, cwd, command, env, extra).map_err(|e| match e {
            super::win_term::WinOpenError::NotStarted(m) | super::win_term::WinOpenError::Started(m) => m,
        })
    }

    /// 同 open，失敗時另外說明 GUI 啟動了沒有：spawn 之前（找資料夾、配編號、啟動執行檔）失敗＝NotStarted；
    /// spawn 之後（等通訊檔、list、設標題、寫對照表）失敗＝Started，這時已嘗試結束剛開的視窗（只動建立時間相符的那個），但不保證已經不在
    fn open_staged(&self, profile: &str, cwd: PathBuf, command: &[String], env: Option<&BTreeMap<String, String>>, extra: &OpenExtra) -> Result<(String, u32), super::win_term::WinOpenError> {
        use super::win_term::WinOpenError::{NotStarted, Started};
        let dir = self.dir().map_err(NotStarted)?;
        let id = self.alloc_id().map_err(NotStarted)?;
        let workspace = format!("asn-{id}");
        // 夥伴視窗在編號後面接名字（認領只看前面的 ASN:編號）
        let title = match &extra.label {
            Some(l) => format!("ASN:{id} {l}"),
            None => format!("ASN:{id}"),
        };
        if self.use_mux {
            return self.open_mux(&dir, profile, cwd, command, env, id, workspace, title, extra);
        }
        let w = self.wez(&dir);
        let win = match env {
            Some(e) => {
                let gui = w.spawn_in_workspace_clean(&cwd, &workspace, command, e).map_err(NotStarted)?;
                match w.wait_sock_classified(gui) {
                    Ok(win) => win,
                    Err(wezterm::SockFail::Other(m)) => return Err(Started(m)),
                    // 建不起視窗（#595）：GUI 已退出、沒有視窗。換成 WebGpu 顯示方式再開一次；還是不行就當沒啟動，呼叫端退到原生主控台
                    Err(wezterm::SockFail::NoWindow(_)) => {
                        elog!("WezTerm 建不起視窗，改用 WebGpu 顯示方式再開一次");
                        let alt_cfg = self.ensure_webgpu_config().map_err(NotStarted)?;
                        let w2 = WezTerm::new(dir.clone(), alt_cfg, self.home.clone(), &self.runner, &self.fs);
                        let gui2 = w2.spawn_in_workspace_clean(&cwd, &workspace, command, e).map_err(NotStarted)?;
                        match w2.wait_sock_classified(gui2) {
                            Ok(win) => win,
                            Err(wezterm::SockFail::NoWindow(m)) => return Err(NotStarted(m)),
                            Err(wezterm::SockFail::Other(m)) => return Err(Started(m)),
                        }
                    }
                }
            }
            // agy／grok（終端面板）：不經開窗點、沒有退路，失敗一律當已啟動（保守）
            None => w.start_in_workspace(&cwd, &workspace, command).map_err(Started)?,
        };
        let panes = match w.list(&win.sock) {
            Ok(p) if !p.is_empty() => p,
            Ok(_) => return fail_close(&w, &win, "WezTerm 視窗裡沒有可操作的窗格".into()).map_err(Started),
            Err(e) => return fail_close(&w, &win, e).map_err(Started),
        };
        let pane_id = panes.iter().find(|p| p.is_active).map(|p| p.pane_id).unwrap_or(panes[0].pane_id);
        if let Err(e) = w.set_tab_title(&win.sock, pane_id, &title) {
            return fail_close(&w, &win, format!("無法設定終端標題：{e}")).map_err(Started);
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
                cwd: cwd.to_string_lossy().into_owned(),
                send_granted: true,
                kind: extra.kind.clone(),
                session_id: extra.session_id.clone(),
            });
        }
        if let Err(e) = self.persist() {
            let _ = w.stop(&win);
            {
                let mut g = self.inner.lock().unwrap();
                g.sessions.retain(|s| s.id != id);
            }
            let _ = self.persist();
            return Err(Started(format!("終端已啟動但對照表寫入失敗，已嘗試結束視窗：{e}")));
        }
        Ok((id, win.gui_pid))
    }

    /// 這個使用者的 mux（wezterm.exe 與 wezterm-mux-server.exe 放在同一個資料夾；檔案放在 mux_base\ASN\m）
    fn mux_handle(&self, dir: &WezTermDir, base_env: BTreeMap<String, String>) -> Result<super::mux::Mux<'_>, String> {
        let base = self.mux_base.as_ref().ok_or_else(|| "找不到使用者的本機資料夾（LOCALAPPDATA），無法使用終端服務".to_string())?;
        let paths = super::mux::paths(base)?;
        Ok(super::mux::Mux { runner: &self.runner, cli: dir.cli.clone(), server: dir.cli.with_file_name(super::mux::MUX_EXE), paths, base_env })
    }

    /// B2b：開在共用的 mux 裡（只在 use_mux 時由 open_staged 呼叫）。一條 `cli spawn --new-window` 開出窗格並印出窗格編號，
    /// 沒有 GUI、沒有等通訊檔。失敗分段同 open_staged：窗格還沒建立（找 mux、起 mux、spawn、解析編號）＝NotStarted；
    /// 建立之後（設標題、寫對照表）失敗＝Started，這時只關那一個窗格（kill-pane），絕不結束 mux 程序。
    /// 環境：下 cli 的程序先清空再只放白名單（run_clean，設計 11.2-5）。env 有給（夥伴視窗、pi）＝用給的；沒給（終端面板的 agy／grok）
    /// 在 mux 模式也只拿 child_env 白名單（決定：第 1 階段是繼承 ASN 的環境，mux 的窗格本來就拿不到 ASN 的環境，這裡明確收斂成白名單）
    #[allow(clippy::too_many_arguments)]
    fn open_mux(&self, dir: &WezTermDir, profile: &str, cwd: PathBuf, command: &[String], env: Option<&BTreeMap<String, String>>, id: String, workspace: String, title: String, extra: &OpenExtra) -> Result<(String, u32), super::win_term::WinOpenError> {
        use super::mux;
        use super::win_term::WinOpenError::{NotStarted, Started};
        if command.is_empty() {
            return Err(NotStarted("沒有指定要執行的指令".into()));
        }
        if !wezterm::workspace_name_ok(&workspace) {
            return Err(NotStarted("workspace 名稱不合法".into()));
        }
        let base_env: BTreeMap<String, String> = super::config::child_env().into_iter().collect();
        let m = self.mux_handle(dir, base_env.clone()).map_err(NotStarted)?;
        let paths = m.paths.clone();
        m.ensure().map_err(NotStarted)?;
        let Some((mux_pid, mux_at)) = m.live_pid() else {
            return Err(NotStarted("找不到終端服務的 pid 紀錄（不是 ASN 起的？），不在這個服務裡開窗格".into()));
        };
        let pane_env = env.cloned().unwrap_or_else(|| base_env.clone());
        // 登錄檔使用者變數（11.2-6）：只看名字。登錄檔的值會蓋過下 cli 時給的（B0 實測），所以這個窗格自己的變數（跟共用白名單不同的）
        // 若同名，夥伴會拿到錯的值：寧可不在 mux 裡開（NotStarted，呼叫端可退到原生主控台），也不悄悄給錯的。
        // TODO(B2c-wrapper)：改用包裝指令在窗格裡設定，撞名也能開；先不做（asn真 建議撞名才用包裝指令，我們決定延後）
        let reg = registry_env_names();
        let (_, secret_like) = mux::registry_conflicts(&reg, &pane_env);
        if let Some(n) = mux::pane_collisions(&reg, &pane_env, &base_env).first() {
            elog!("終端服務：使用者環境變數裡有「{n}」，會蓋過這個窗格自己的設定，不在共用終端裡開");
            return Err(NotStarted(format!("使用者環境變數裡已經有「{n}」，會蓋過這個夥伴自己的設定，所以沒有在共用終端裡開；請把它從使用者環境變數移除")));
        }
        // 金鑰類的名字：只提示（夥伴清單上的一句話，見 mux::secret_notice），不改使用者的登錄檔
        for n in &secret_like {
            elog!("終端服務：使用者環境變數裡有「{n}」（金鑰類或會被濾掉的名字），WezTerm 會把它帶進窗格");
        }
        let cwd_s = cwd.to_string_lossy().into_owned();
        let mut sub: Vec<&str> = vec!["spawn", "--new-window", "--workspace", &workspace, "--cwd", &cwd_s, "--"];
        sub.extend(command.iter().map(String::as_str));
        // 連 wezterm.exe 都起不來（RealRunner 回「無法執行…」）＝窗格一定沒開，可以退到原生主控台；
        // 逾時或回的不是窗格編號：窗格可能其實已經開了，當作已啟動（不讓呼叫端再開一份）
        let ran = self.runner.run_clean(&dir.cli, &mux::cli_args(&sub), &mux::cli_env(&pane_env, &paths.sock), wezterm::CLI_TIMEOUT);
        let out = ran.map_err(|e| if e.starts_with(wezterm::CANNOT_RUN) { NotStarted(e) } else { Started(e) })?;
        if !out.success {
            return Err(NotStarted(format!("終端服務開不出窗格：{}", out.stderr.trim())));
        }
        let pane_id: u64 = out.stdout.trim().parse().map_err(|_| Started(format!("無法解析新窗格編號：{}", out.stdout.trim())))?;
        let win = Window { gui_pid: mux_pid, sock: paths.sock, started_ms: Some(mux_at), mux: true };
        let w = self.wez(dir);
        // 窗格已經開了：後面任何一步失敗都只關這一個窗格
        let close_pane = |why: String| -> super::win_term::WinOpenError {
            match w.kill_pane(&win.sock, pane_id) {
                Ok(()) => Started(why),
                Err(e) => Started(format!("{why}（關閉剛開的窗格也失敗：{e}）")),
            }
        };
        if let Err(e) = w.set_tab_title(&win.sock, pane_id, &title) {
            return Err(close_pane(format!("無法設定終端標題：{e}")));
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
                cwd: cwd_s,
                send_granted: true,
                kind: extra.kind.clone(),
                session_id: extra.session_id.clone(),
            });
        }
        if let Err(e) = self.persist() {
            {
                let mut g = self.inner.lock().unwrap();
                g.sessions.retain(|s| s.id != id);
            }
            let _ = self.persist();
            return Err(close_pane(format!("終端已啟動但對照表寫入失敗，已嘗試關閉窗格：{e}")));
        }
        Ok((id, win.gui_pid))
    }

    /// 使用者在 UI 確認後才把文字送進自己開的終端。不收程序編號或通訊路徑。
    /// 工作資料夾沒有授權記錄就不送。文字走會壓行的送字，不走方向鍵那條。
    /// 這個方法證明不了使用者有按確認。UI 的確認必須是唯一入口；後端其他路徑不得呼叫。
    pub fn confirm_send(&self, id: &str, text: &str, enter: bool) -> Result<(), String> {
        let snap = self.snapshot(id)?;
        let dir = self.dir()?;
        let w = self.wez(&dir);
        if let Some(ad) = &snap.adopted {
            let config = self.launch_config_for_adopt()?;
            let live = term_adopt::fetch_live_pane(&w, &snap.window, snap.pane_id, &self.runner)?;
            term_adopt::ensure_user_idle_for_adopt_write(&w, &snap.window.sock, snap.pane_id)?;
            if !ad.version_verified {
                return Err("WezTerm 版本未驗證，不能代送".into());
            }
            if !ad.send_unlocked {
                return Err("這個接手窗格還沒在本機開啟「允許代送文字」".into());
            }
            term_adopt::verify_adopted_for_write(&live, ad, &config)?;
        } else if !snap.send_granted || snap.cwd.trim().is_empty() {
            return Err("這個工作資料夾還沒有使用者的授權，不能代送".into());
        }
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
        if snap.adopted.is_some() {
            let _ = term_adopt::fetch_live_pane(&w, &snap.window, snap.pane_id, &self.runner)?;
        }
        let text = w.get_text(&snap.window.sock, snap.pane_id, Some(-lines))?;
        Ok(cap_output(&text))
    }

    pub fn list(&self) -> Vec<TermListed> {
        let g = self.inner.lock().unwrap();
        // 夥伴視窗（claude／window）這一階段不進終端面板（不能從那裡讀畫面、送字）
        let mut out: Vec<TermListed> = g
            .sessions
            .iter()
            .filter(|s| s.kind.is_empty())
            .map(|s| TermListed {
                id: s.id.clone(),
                profile: s.profile.clone(),
                pid: s.window.gui_pid,
                started_ms: s.window.started_ms,
                cwd: s.cwd.clone(),
                adopted: false,
                answer_unlocked: true,
                send_unlocked: true,
            })
            .collect();
        out.extend(g.adopted.iter().map(|s| TermListed {
            id: s.id.clone(),
            profile: s.profile.clone(),
            pid: s.window.gui_pid,
            started_ms: s.window.started_ms,
            cwd: s.cwd.clone(),
            adopted: true,
            answer_unlocked: s.answer_unlocked,
            send_unlocked: s.send_unlocked,
        }));
        out
    }

    /// 結束自己開的視窗。只拿對照表裡的 Window 交給 wezterm::stop（裡面核對 started_ms），不接受呼叫端傳入的程序編號。
    /// 成功（含視窗早已不在）才從表上移除；建立時間對不上就保留編號，方便呼叫端知道沒關掉。
    pub fn stop(&self, id: &str) -> Result<(), String> {
        self.stop_p(id, false)
    }

    /// B2c：關共用 mux 裡的夥伴視窗（claude／window）：關它的窗格＋收掉看它的 GUI。只動這個窗格，絕不結束 mux。
    /// 不在共用 mux 裡的夥伴視窗（第 1 階段自己的 GUI）不走這裡，仍由 `stop_gui` 收
    pub fn stop_partner(&self, id: &str) -> Result<(), String> {
        let in_mux = self.inner.lock().unwrap().sessions.iter().any(|s| s.id == id && s.window.mux && !s.kind.is_empty());
        if !in_mux {
            return Err("這個視窗不在共用的終端服務裡".into());
        }
        self.stop_p(id, true)
    }

    fn stop_p(&self, id: &str, partner_ok: bool) -> Result<(), String> {
        if self.is_adopted_id(id)? {
            let mut g = self.inner.lock().unwrap();
            g.adopted.retain(|s| s.id != id);
            return Ok(());
        }
        let snap = match self.snapshot_p(id, partner_ok).and_then(|s| if s.adopted.is_some() { Err("沒有這個終端（只能操作這次由 ASN 開啟的）".to_string()) } else { Ok(s) }) {
            // mux 已經換過：窗格跟著舊 mux 沒了，verify_mux 也已經把這一列移除，視為關好（同第 1 階段「視窗早已不在」）
            Err(e) if e == MUX_GONE => {
                let _ = self.unview(id);
                return Ok(());
            }
            r => r?,
        };
        let dir = self.dir()?;
        let w = self.wez(&dir);
        if snap.window.mux {
            // 共用 mux 裡的窗格：只關這個窗格，絕不 kill_tree（snap.window.gui_pid 是 mux 的編號）。
            // mux 的連線檔都不在了＝mux 已經沒了、窗格跟著沒了，視為完成（同第 1 階段「視窗早已不在」）
            if let Err(e) = w.kill_pane(&snap.window.sock, snap.pane_id) {
                if self.fs.exists(&snap.window.sock) {
                    return Err(e);
                }
            }
        } else {
            w.stop(&snap.window)?;
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.sessions.retain(|s| s.id != id);
        }
        // 窗格都沒了，看它的 GUI 也一起收（只收自己起的那一個，見 unview）
        let _ = self.unview(id);
        self.persist()?;
        Ok(())
    }

    /// B2c：要看某個 mux 窗格時才開的 GUI：`wezterm-gui --config-file <mux.lua> connect asn --workspace asn-{編號}`。
    /// 開之前先核對 mux 還是開窗格時那一個（verify_mux）；環境只給白名單（不繼承 ASN 的環境）。
    /// 這個編號已經有一個還活著的 GUI（編號＋建立時間對得上）就不再開第二個，只把它叫到前面。
    /// 剛起就結束（桌面沒人登入、顯示卡不支援…）＝開不了畫面，回 [`VIEW_NO_DESKTOP`]；夥伴照常在背景跑，不受影響。
    /// 只在 mux 模式有用；第 1 階段的視窗本來就有自己的 GUI
    pub fn view(&self, id: &str) -> Result<(), String> {
        if !self.use_mux {
            return Err("終端服務沒有開啟，沒有可以另外開的畫面".into());
        }
        let snap = self.snapshot_p(id, true)?;
        if !snap.window.mux {
            return Err("這個視窗不在共用的終端服務裡，沒有可以另外開的畫面".into());
        }
        // 「有沒有在看」與「登記正在開」在同一次持鎖裡做完：兩個請求同時進來時，只有一個會去開 GUI（#615 審查）
        let front = {
            let mut g = self.inner.lock().unwrap();
            let front = match g.viewers.iter().find(|v| v.id == id).cloned() {
                Some(v) if v.starting => return Ok(()),
                Some(v) if self.runner.started_ms(v.pid) == Some(v.started_ms) => Some(v.pid),
                Some(_) => {
                    // 使用者自己把畫面關了
                    g.viewers.retain(|v| v.id != id);
                    None
                }
                None => None,
            };
            if front.is_none() {
                g.viewers.push(Viewer { id: id.to_string(), pid: 0, started_ms: 0, starting: true });
            }
            front
        };
        if let Some(pid) = front {
            viewer_to_front(pid);
            return Ok(());
        }
        let r = self.start_viewer(id);
        let mut g = self.inner.lock().unwrap();
        g.viewers.retain(|v| v.id != id);
        match r {
            Ok((pid, at)) => {
                g.viewers.push(Viewer { id: id.to_string(), pid, started_ms: at, starting: false });
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    fn start_viewer(&self, id: &str) -> Result<(u32, u64), String> {
        let workspace = format!("asn-{id}");
        if !wezterm::workspace_name_ok(&workspace) {
            return Err("workspace 名稱不合法".into());
        }
        let dir = self.dir()?;
        let m = self.mux_handle(&dir, BTreeMap::new())?;
        // 設定檔是起 mux 時寫的；被刪了或是舊版寫的（沒有 no_serve_automatically）就補成現在的內容，
        // 不然 GUI 會讀到預設設定、找不到 asn 這個連線，或在 mux 掛掉時自己起一個
        if std::fs::read_to_string(&m.paths.config).ok().as_deref() != Some(super::mux::config_text(&m.paths.sock).as_str()) {
            std::fs::write(&m.paths.config, super::mux::config_text(&m.paths.sock)).map_err(|e| format!("寫入終端服務設定失敗：{e}"))?;
        }
        let args = view_args(&m.paths.config, &workspace);
        let env: BTreeMap<String, String> = super::config::child_env().into_iter().collect();
        let pid = self.runner.spawn_clean(&dir.gui, &args, &env).map_err(|e| format!("開不了終端畫面：{e}"))?;
        // 查不到建立時間＝已經結束了（沒辦法確認是同一個，也就不動它）
        let mut at = self.runner.started_ms(pid);
        for _ in 0..VIEW_BIRTH_RETRIES {
            if at.is_some() {
                break;
            }
            self.runner.sleep(VIEW_POLL);
            at = self.runner.started_ms(pid);
        }
        let Some(at) = at else { return Err(VIEW_NO_DESKTOP.into()) };
        // 至少活過 VIEW_MIN_ALIVE（期間每次都核對建立時間）；之後看到視窗就算成功，看不到就等到 VIEW_FAIL_WINDOW 為止還活著也算
        let min_polls = VIEW_MIN_ALIVE.as_millis() / VIEW_POLL.as_millis();
        for i in 0..(VIEW_FAIL_WINDOW.as_millis() / VIEW_POLL.as_millis()) {
            if i >= min_polls && self.runner.window_up(pid) {
                break;
            }
            self.runner.sleep(VIEW_POLL);
            if self.runner.started_ms(pid) != Some(at) {
                return Err(VIEW_NO_DESKTOP.into());
            }
        }
        Ok((pid, at))
    }

    /// 收掉看這個窗格的 GUI（＝「背景」）。窗格照常跑，只結束自己起的那一個程序（編號＋建立時間對得上才動）；絕不碰 mux
    pub fn unview(&self, id: &str) -> Result<(), String> {
        let v = {
            let mut g = self.inner.lock().unwrap();
            let Some(i) = g.viewers.iter().position(|v| v.id == id && !v.starting) else { return Ok(()) };
            g.viewers.remove(i)
        };
        if self.runner.started_ms(v.pid) == Some(v.started_ms) {
            self.runner.kill_tree(v.pid);
        }
        Ok(())
    }

    /// 這個編號現在有沒有一個還活著的看畫面的 GUI
    pub fn viewing(&self, id: &str) -> bool {
        let v = self.inner.lock().unwrap().viewers.iter().find(|v| v.id == id && !v.starting).cloned();
        v.is_some_and(|v| self.runner.started_ms(v.pid) == Some(v.started_ms))
    }

    /// 這個 mux（程序編號＋建立時間）裡、名字是 `name` 的夥伴視窗（claude／window）的終端編號。同名不只一個就不猜；
    /// mux 的編號與建立時間要跟開窗格時記的一樣（防止舊的列對到新的 mux）。沒開 mux 模式＝None
    pub fn partner_in_mux(&self, mux: (u32, u64), name: &str) -> Option<String> {
        if !self.use_mux {
            return None;
        }
        let g = self.inner.lock().unwrap();
        let mut hit = g.sessions.iter().filter(|s| s.window.mux && !s.kind.is_empty() && s.window.gui_pid == mux.0 && s.window.started_ms == Some(mux.1) && partner_label(&s.id, &s.title) == Some(name));
        let first = hit.next()?;
        hit.next().is_none().then(|| first.id.clone())
    }

    /// 夥伴清單的「前台／背景」在 mux 視窗上的查詢：前台＝看畫面的 GUI 開著
    pub fn console_query_mux(&self, id: &str) -> serde_json::Value {
        serde_json::json!({ "ok": true, "can_toggle": true, "visible": self.viewing(id) })
    }

    /// 同上的切換：叫到前台＝開畫面（`view`）、放到背景＝收掉畫面（`unview`）。失敗時 `notify` 要前端把原因顯示給使用者
    pub fn console_set_mux(&self, id: &str, visible: bool) -> serde_json::Value {
        let r = if visible { self.view(id) } else { self.unview(id) };
        match r {
            Ok(()) => serde_json::json!({ "ok": true, "visible": self.viewing(id) }),
            Err(e) => serde_json::json!({ "ok": false, "reason": e, "notify": true }),
        }
    }

    /// 忙或閒。只認自己的編號。agy 沒有規則，直接 unknown，連畫面都不讀。
    /// grok：取樣、睡一段、再取樣。兩次的畫面與游標都相同，且有空的輸入框，才是 idle；有變化是 busy；其餘 unknown。
    /// 任一次畫面是信任提問、選單、或解析不出的選單模樣，就是 waiting_user，優先於閒置。這裡不送字。
    /// 第一次畫面含「[stop]」或「Ctrl+c:cancel」就是處理中，直接 busy，不等第二次。
    pub fn status(&self, id: &str) -> Result<TermStatus, String> {
        let snap = self.snapshot(id)?;
        let dir = self.dir()?;
        let w = self.wez(&dir);
        if snap.adopted.is_some() {
            let live = term_adopt::fetch_live_pane(&w, &snap.window, snap.pane_id, &self.runner);
            if let Ok(l) = &live {
                if !term_adopt::foreground_still_known(&l.pane.title) {
                    return Ok(unknown_status(&snap.profile, "前景不是已知的 CLI"));
                }
            }
        }
        // pi（#483）：忙碌與閒置看名單（pi 的 ASN 擴充會回報），這裡只看畫面上有沒有要使用者選的提問（例如要不要信任資料夾），
        // 有就是 waiting_user 並附上選項（代答照既有的確認流程）；讀一次就好，不做兩次取樣的閒置判斷
        if snap.profile == "pi" {
            return Ok(match self.sample(&w, &snap) {
                Ok(s) => match classify_prompt_for(&snap.profile, &s.text) {
                    Some(p) => waiting_status(&snap.profile, s.cursor_x, s.cursor_y, p),
                    None => unknown_status(&snap.profile, PI_STATE_ELSEWHERE),
                },
                Err(e) => unknown_status(&snap.profile, &format!("讀不到畫面或游標，無法判斷：{e}")),
            });
        }
        if snap.profile != "grok" {
            return Ok(TermStatus {
                state: "unknown".into(),
                profile: snap.profile,
                cursor_x: None,
                cursor_y: None,
                reason: if snap.adopted.is_some() {
                    "這個 CLI 還沒有閒置規則".into()
                } else {
                    "只有 grok 有閒置規則".into()
                },
                prompt: None,
            });
        }
        let first = match self.sample(&w, &snap) {
            Ok(s) => s,
            Err(e) => return Ok(unknown_status(&snap.profile, &format!("讀不到畫面或游標，無法判斷：{e}"))),
        };
        if let Some(p) = classify_prompt(&first.text) {
            return Ok(waiting_status(&snap.profile, first.cursor_x, first.cursor_y, p));
        }
        if grok_processing(&first.text) {
            return Ok(TermStatus {
                state: "busy".into(),
                profile: snap.profile,
                cursor_x: Some(first.cursor_x),
                cursor_y: Some(first.cursor_y),
                reason: "畫面含處理中標記".into(),
                prompt: None,
            });
        }
        self.runner.sleep(self.status_gap);
        let second = match self.sample(&w, &snap) {
            Ok(s) => s,
            Err(e) => return Ok(unknown_status(&snap.profile, &format!("讀不到畫面或游標，無法判斷：{e}"))),
        };
        if let Some(p) = classify_prompt(&second.text) {
            return Ok(waiting_status(&snap.profile, second.cursor_x, second.cursor_y, p));
        }
        let cursor_x = Some(second.cursor_x);
        let cursor_y = Some(second.cursor_y);
        if grok_processing(&second.text) || first.text != second.text || first.cursor_x != second.cursor_x || first.cursor_y != second.cursor_y {
            let reason = if grok_processing(&second.text) { "畫面含處理中標記" } else { "畫面或游標有變化" };
            return Ok(TermStatus {
                state: "busy".into(),
                profile: snap.profile,
                cursor_x,
                cursor_y,
                reason: reason.into(),
                prompt: None,
            });
        }
        let (state, reason) = match grok_input_box(&second.text) {
            InputBox::Empty => ("idle", "連續兩次畫面相同且停在輸入框"),
            InputBox::Typing => ("unknown", "輸入框裡有文字，不當成閒置"),
            InputBox::None => ("unknown", "畫面沒有變化，但不是已確認的 grok 輸入框"),
        };
        Ok(TermStatus {
            state: state.into(),
            profile: snap.profile,
            cursor_x,
            cursor_y,
            reason: reason.into(),
            prompt: None,
        })
    }

    /// 使用者在 UI 提示框按了第 n 個選項才代送。不收原始按鍵。送出前再讀一次畫面：提示還在、種類相符、n 合法才送。
    /// 按鍵只從固定對照表產生，走 send_bytes，不經過會丟掉 ESC 的壓行。
    /// 這個方法證明不了使用者有按確認。UI 的提示框必須是唯一入口；後端其他路徑不得呼叫。
    pub fn answer(&self, id: &str, prompt_kind: &str, n: u32) -> Result<TermAnswered, String> {
        let snap = self.snapshot(id)?;
        if prompt_kind != "trust_dialog" && prompt_kind != "menu" {
            return Err("不認得這個提示，不能代答".into());
        }
        let dir = self.dir()?;
        let w = self.wez(&dir);
        if let Some(ad) = &snap.adopted {
            let config = self.launch_config_for_adopt()?;
            let live = term_adopt::fetch_live_pane(&w, &snap.window, snap.pane_id, &self.runner)?;
            term_adopt::ensure_user_idle_for_adopt_write(&w, &snap.window.sock, snap.pane_id)?;
            if !term_adopt::foreground_still_known(&live.pane.title) {
                return Err("前景不是已知的 CLI，不能代答".into());
            }
            if !ad.version_verified {
                return Err("WezTerm 版本未驗證，不能代答".into());
            }
            if !ad.answer_unlocked {
                return Err("這個接手窗格還沒在本機開啟「允許代答提問」".into());
            }
            term_adopt::verify_adopted_for_write(&live, ad, &config)?;
        }
        let text = w.get_text(&snap.window.sock, snap.pane_id, Some(-STATUS_LINES))?;
        let Some(seen) = classify_prompt_for(&snap.profile, &text) else {
            return Err("這個提示已經不在畫面上，沒有送出".into());
        };
        if seen.kind != prompt_kind {
            return Err("這個提示已經不在畫面上，沒有送出".into());
        }
        if n == 0 || n as usize > seen.options.len() {
            return Err("沒有這個選項，沒有送出".into());
        }
        let keys = match prompt_kind {
            "trust_dialog" => trust_keys(n)?,
            "menu" => menu_keys(seen.cursor, n)?,
            _ => return Err("不認得這個提示，不能代答".into()),
        };
        let bytes = encode_keys(&keys)?;
        w.send_bytes(&snap.window.sock, snap.pane_id, &bytes)?;
        if snap.adopted.is_none() && prompt_kind == "trust_dialog" && n == 1 {
            self.note_send_grant(&snap.id)?;
        }
        Ok(TermAnswered { keys: describe_keys(&keys) })
    }

    /// 信任提問按了信任之後，把這個終端已記下的工作資料夾記成可代送。空的資料夾不記。
    fn note_send_grant(&self, id: &str) -> Result<(), String> {
        let should = {
            let mut g = self.inner.lock().unwrap();
            let Some(s) = g.sessions.iter_mut().find(|s| s.id == id) else {
                return Err("沒有這個終端（只能操作這次由 ASN 開啟的）".into());
            };
            if s.cwd.trim().is_empty() {
                false
            } else {
                s.send_granted = true;
                true
            }
        };
        if should {
            self.persist()?;
        }
        Ok(())
    }

    /// 改自己這個終端的分頁標題。使用者給的字會接在 `ASN:{編號} ` 後面，前綴不拿掉（認領靠它）。
    /// 長度與字元先檢查，不合法就不呼叫 cli。
    pub fn rename(&self, id: &str, title: &str) -> Result<(), String> {
        if self.is_adopted_id(id)? {
            return Err("接手的窗格不能改名".into());
        }
        let snap = self.snapshot_owned(id)?;
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
            // #611：開關關著（0.1.113 不認夥伴視窗的列）＝kind 不是空的列（第 1 階段留下的）一律 parked：留在檔案裡、不查不碰，等開關打開再認
            if park_companion_row(self.hold_config, &term) {
                parked.push(term);
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
            let sock = if term.mux {
                // mux 的列：連線檔是 mux 的，而且 pid 檔記的也要是同一個 mux（建立時間對得上），不然不認。
                // 開關沒開時不碰（也不下 cli）：留在檔案裡，等開關打開再認
                if !self.use_mux {
                    parked.push(term);
                    continue;
                }
                let Ok(m) = self.mux_handle(&dir, BTreeMap::new()) else {
                    parked.push(term);
                    continue;
                };
                if m.live_pid() != Some((term.pid, saved)) {
                    continue;
                }
                m.paths.sock.clone()
            } else {
                wezterm::sock_path(&self.home, term.pid)
            };
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
                    mux: term.mux,
                },
                pane_id: pane.pane_id,
                workspace: format!("asn-{}", term.id),
                title,
                cwd: term.cwd.clone(),
                send_granted: term.send_granted,
                kind: term.kind.clone(),
                session_id: term.session_id.clone(),
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

    fn is_adopted_id(&self, id: &str) -> Result<bool, String> {
        let g = self.inner.lock().unwrap();
        if g.sessions.iter().any(|s| s.id == id) {
            return Ok(false);
        }
        if g.adopted.iter().any(|s| s.id == id) {
            return Ok(true);
        }
        Err("沒有這個終端".into())
    }

    /// 取一份可操作的快照。共用 mux 裡的窗格先核對 mux 還是開窗格時那一個（見 `verify_mux`）
    fn snapshot(&self, id: &str) -> Result<SessionSnap, String> {
        self.snapshot_p(id, false)
    }

    /// `partner_ok`：B2c 的看／關共用 mux 裡的夥伴視窗才給 true（讀畫面、送字等仍一律拒絕夥伴視窗）
    fn snapshot_p(&self, id: &str, partner_ok: bool) -> Result<SessionSnap, String> {
        let snap = self.snapshot_raw_p(id, partner_ok)?;
        self.verify_mux(&snap)?;
        Ok(snap)
    }

    /// mux 當掉後被下一次 `ensure()` 重新起來，新 mux 的窗格編號會從頭算：對照表裡舊的窗格編號可能對到新 mux 裡
    /// 別的夥伴。所以 mux 窗格的每一個操作（讀畫面、送字、代答、改名、關閉）前都核對 pid 檔記的 mux（pid＋建立時間）
    /// 跟開窗格時記下的一樣；對不上就把這一列移除（窗格已經跟著舊 mux 沒了）並回錯，不對新 mux 下任何指令（#607 審查）
    fn verify_mux(&self, snap: &SessionSnap) -> Result<(), String> {
        if !snap.window.mux {
            return Ok(());
        }
        let dir = self.dir()?;
        let live = self.mux_handle(&dir, BTreeMap::new())?.live_pid();
        if live.is_some_and(|(pid, at)| pid == snap.window.gui_pid && Some(at) == snap.window.started_ms) {
            return Ok(());
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.sessions.retain(|s| s.id != snap.id);
        }
        let _ = self.persist();
        Err(MUX_GONE.into())
    }

    fn snapshot_raw_p(&self, id: &str, partner_ok: bool) -> Result<SessionSnap, String> {
        let g = self.inner.lock().unwrap();
        if let Some(s) = g.sessions.iter().find(|s| s.id == id) {
            // 夥伴視窗（claude／window）：讀畫面、送字、代答、改名、從面板關閉都是之後的階段，現在一律拒絕（B2c 的看／關除外）
            if !s.kind.is_empty() && !partner_ok {
                return Err("這個夥伴視窗還不能從終端面板操作".into());
            }
            return Ok(SessionSnap {
                id: s.id.clone(),
                profile: s.profile.clone(),
                window: s.window.clone(),
                pane_id: s.pane_id,
                cwd: s.cwd.clone(),
                send_granted: s.send_granted,
                adopted: None,
            });
        }
        if let Some(s) = g.adopted.iter().find(|s| s.id == id) {
            return Ok(SessionSnap {
                id: s.id.clone(),
                profile: s.profile.clone(),
                window: s.window.clone(),
                pane_id: s.pane_id,
                cwd: s.cwd.clone(),
                send_granted: false,
                adopted: Some(AdoptedSnap {
                    foreground: s.foreground.clone(),
                    answer_unlocked: s.answer_unlocked,
                    send_unlocked: s.send_unlocked,
                    version_verified: s.version_verified,
                }),
            });
        }
        Err("沒有這個終端".into())
    }

    fn snapshot_owned(&self, id: &str) -> Result<SessionSnap, String> {
        let snap = self.snapshot(id)?;
        if snap.adopted.is_some() {
            return Err("沒有這個終端（只能操作這次由 ASN 開啟的）".into());
        }
        Ok(snap)
    }

    /// 列出可接手的 WezTerm 窗格（只列已知 CLI；ASN 絕不自動接手）。
    pub fn adopt_candidates(&self, config: &LaunchConfig) -> Result<Vec<TermAdoptCandidate>, String> {
        let dir = self.dir()?;
        let w = self.wez(&dir);
        let keys = {
            let g = self.inner.lock().unwrap();
            g.adopted.iter().map(|s| (s.window.gui_pid, s.pane_id)).collect::<Vec<_>>()
        };
        Ok(term_adopt::scan_candidates(&self.home, &w, &self.fs, &self.runner, config, &keys))
    }

    /// 使用者在桌面清單按「接手」後呼叫。只存記憶體，不寫對照表檔。
    pub fn adopt(&self, pid: u32, pane_id: u64, started_ms: u64, config: &LaunchConfig) -> Result<String, String> {
        let dir = self.dir()?;
        let w = self.wez(&dir);
        let mut row = term_adopt::adopt_pane(pid, pane_id, started_ms, &w, &self.home, &self.fs, &self.runner, config)?;
        let id = self.alloc_adopt_id();
        row.id = id.clone();
        {
            let mut g = self.inner.lock().unwrap();
            if g.adopted.iter().any(|s| s.window.gui_pid == pid && s.pane_id == pane_id) {
                return Err("這個窗格已經接手過了".into());
            }
            g.adopted.push(row);
        }
        Ok(id)
    }

    /// 解鎖接手窗格的寫入能力。只能由本機桌面命令呼叫，遠端與收信不得觸及。
    pub fn unlock_adopted(&self, id: &str, allow_answer: bool, allow_send: bool) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        let Some(s) = g.adopted.iter_mut().find(|s| s.id == id) else {
            return Err("沒有這個接手終端".into());
        };
        if allow_answer {
            s.answer_unlocked = true;
        }
        if allow_send {
            s.send_unlocked = true;
        }
        Ok(())
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

    /// 接手編號只存記憶體，不寫對照表檔。
    fn alloc_adopt_id(&self) -> String {
        let mut g = self.inner.lock().unwrap();
        g.next += 1;
        g.next.to_string()
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

fn fail_close<T>(w: &WezTerm<'_>, win: &Window, why: String) -> Result<T, String> {
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
        cwd: s.cwd.clone(),
        send_granted: s.send_granted,
        kind: s.kind.clone(),
        session_id: s.session_id.clone(),
        mux: s.window.mux,
    }
}

/// 開關關著時，夥伴視窗的列（kind 非空）不認領、改 parked（#611）
fn park_companion_row(wezterm_on: bool, t: &StoreTerm) -> bool {
    !wezterm_on && !t.kind.is_empty()
}

/// 檔案裡這一列能不能當認領候選。其他 profile、空編號、程序編號 0 都直接丟掉，不查、不結束。
fn reclaim_candidate(t: &StoreTerm) -> bool {
    profile_reclaimable(&t.profile, &t.kind) && id_ok(&t.id) && t.pid != 0
}

/// 終端面板開的（agy／grok／pi）不帶 kind；開窗點開的夥伴視窗 kind 要跟 profile 一致（claude／window）。
/// 只寫了 profile "claude" 卻沒有 kind 的列不認（不是這份程式寫的，不猜）
fn profile_reclaimable(profile: &str, kind: &str) -> bool {
    match kind {
        "" => profile == "agy" || profile == "grok" || profile == "pi",
        super::win_term::KIND_CLAUDE | super::win_term::KIND_WINDOW => profile == kind,
        _ => false,
    }
}

/// 看 mux 窗格的 GUI 的參數：`--config-file <mux.lua> connect asn --workspace asn-{編號}`（設定檔裡有 asn 這個 unix domain）
fn view_args(config: &Path, workspace: &str) -> Vec<String> {
    vec!["--config-file".into(), config.to_string_lossy().into_owned(), "connect".into(), "asn".into(), "--workspace".into(), workspace.to_string()]
}

/// 分頁標題 `ASN:{編號} {名字}` 裡的名字（沒有名字＝None）
fn partner_label<'a>(id: &str, title: &'a str) -> Option<&'a str> {
    title.strip_prefix("ASN:")?.strip_prefix(id)?.strip_prefix(' ').filter(|l| !l.is_empty())
}

/// 已經開著的看畫面 GUI：叫到最前面（找不到視窗就算了）
fn viewer_to_front(pid: u32) {
    #[cfg(all(windows, feature = "gui", not(test)))]
    {
        for w in super::console::win::find_wez_windows(pid) {
            if let Err(e) = super::console::win::set_visible(w.hwnd, true) {
                elog!("叫回終端畫面失敗（{pid}）：{e}");
            }
        }
    }
    #[cfg(not(all(windows, feature = "gui", not(test))))]
    {
        let _ = pid;
    }
}

/// open 的額外資料：夥伴視窗（開窗點開的）才有
#[derive(Default)]
struct OpenExtra {
    kind: String,
    session_id: Option<String>,
    /// 接在分頁標題 ASN:編號 後面的名字（已過 normalize_title）
    label: Option<String>,
}

/// 測試注入「使用者環境變數」的名字（每個測試自己的執行緒各一份）
#[cfg(test)]
thread_local! {
    static TEST_REGISTRY_NAMES: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// 使用者環境變數（HKCU\Environment）的變數名字。測試不讀這台電腦真的登錄檔
fn registry_env_names() -> Vec<String> {
    #[cfg(test)]
    {
        TEST_REGISTRY_NAMES.with(|n| n.borrow().clone())
    }
    #[cfg(not(test))]
    {
        super::mux::user_env_names()
    }
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

enum InputBox {
    /// 最近這段畫面裡沒有輸入框那一行。
    None,
    /// 有輸入框，而且除了行首記號、空白、佔位「…」以外沒有字。
    Empty,
    /// 輸入框裡有使用者打的字。保守不當成閒置。
    Typing,
}

/// 每行先去掉兩端空白（真機行首有兩格）。以「│ ❯」開頭才算輸入框。
/// 去掉開頭後再 trim；結尾剛好是右邊線「│」就拿掉，再 trim。剩下空的或只有「…」才是空框。
fn grok_input_box(text: &str) -> InputBox {
    let mut saw_empty = false;
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(GROK_INPUT_MARK) else { continue };
        let rest = rest.trim();
        let inner = rest.strip_suffix('│').unwrap_or(rest).trim();
        if inner.is_empty() || inner == "…" {
            saw_empty = true;
        } else {
            return InputBox::Typing;
        }
    }
    if saw_empty { InputBox::Empty } else { InputBox::None }
}

fn grok_processing(text: &str) -> bool {
    text.contains(GROK_BUSY_STOP) || text.contains(GROK_BUSY_CANCEL)
}

fn unknown_status(profile: &str, reason: &str) -> TermStatus {
    TermStatus {
        state: "unknown".into(),
        profile: profile.to_string(),
        cursor_x: None,
        cursor_y: None,
        reason: reason.to_string(),
        prompt: None,
    }
}

fn waiting_status(profile: &str, cursor_x: i64, cursor_y: i64, p: ScreenPrompt) -> TermStatus {
    TermStatus {
        state: "waiting_user".into(),
        profile: profile.to_string(),
        cursor_x: Some(cursor_x),
        cursor_y: Some(cursor_y),
        reason: p.kind.to_string(),
        prompt: Some(p.into_public()),
    }
}

/// 畫面上看到的提問。cursor 是選單目前停在第幾項（從 1 起算）；信任提問用不到，是 0。
struct ScreenPrompt {
    kind: &'static str,
    text: String,
    options: Vec<TermOption>,
    cursor: u32,
}

impl ScreenPrompt {
    fn into_public(self) -> TermPrompt {
        TermPrompt { kind: self.kind.to_string(), text: self.text, options: self.options }
    }
}

/// 固定對照表裡的一顆鍵。控制碼只在 encode_key 產生，不接受外面傳進來的字串。
#[derive(Clone, Copy)]
enum AnswerKey {
    Up,
    Down,
    Enter,
    Esc,
    Char(char),
}

fn trust_keys(n: u32) -> Result<Vec<AnswerKey>, String> {
    let c = match n {
        1 => 'y',
        2 => 'n',
        _ => return Err("沒有這個選項，沒有送出".into()),
    };
    Ok(vec![AnswerKey::Char(c)])
}

/// 從畫面上的游標走到第 n 項。往下超過 MAX_MENU_DOWN 就拒絕。總長度另由 encode_keys 把關。
fn menu_keys(cursor: u32, n: u32) -> Result<Vec<AnswerKey>, String> {
    if cursor == 0 || n == 0 {
        return Err("沒有這個選項，沒有送出".into());
    }
    let downs = if n > cursor { n - cursor } else { 0 };
    let ups = if cursor > n { cursor - n } else { 0 };
    if downs > MAX_MENU_DOWN {
        return Err("往下的步數超過上限，沒有送出".into());
    }
    let mut keys = Vec::new();
    for _ in 0..ups {
        keys.push(AnswerKey::Up);
    }
    for _ in 0..downs {
        keys.push(AnswerKey::Down);
    }
    keys.push(AnswerKey::Enter);
    Ok(keys)
}

/// 唯一會產生終端機控制碼的地方。字元鍵只准單一英數字元，其他控制碼字串一律拒絕。
fn encode_key(key: AnswerKey) -> Result<String, String> {
    Ok(match key {
        AnswerKey::Up => "\u{1b}[A".to_string(),
        AnswerKey::Down => "\u{1b}[B".to_string(),
        AnswerKey::Enter => "\r".to_string(),
        AnswerKey::Esc => "\u{1b}".to_string(),
        AnswerKey::Char(c) => {
            if !c.is_ascii_alphanumeric() {
                return Err("按鍵只能是單一英數字元，不能送控制碼".into());
            }
            c.to_string()
        }
    })
}

fn encode_keys(keys: &[AnswerKey]) -> Result<String, String> {
    if keys.is_empty() || keys.len() > MAX_ANSWER_KEYS {
        return Err("按鍵序列太長，沒有送出".into());
    }
    let mut out = String::new();
    for k in keys {
        out.push_str(&encode_key(*k)?);
    }
    Ok(out)
}

fn describe_keys(keys: &[AnswerKey]) -> String {
    match keys {
        [AnswerKey::Char(c)] => c.to_string(),
        [AnswerKey::Enter] => "Enter".to_string(),
        _ => {
            let ups = keys.iter().filter(|k| matches!(k, AnswerKey::Up)).count();
            let downs = keys.iter().filter(|k| matches!(k, AnswerKey::Down)).count();
            let mut parts = Vec::new();
            if ups > 0 {
                parts.push(format!("Up×{ups}"));
            }
            if downs > 0 {
                parts.push(format!("Down×{downs}"));
            }
            if keys.iter().any(|k| matches!(k, AnswerKey::Enter)) {
                parts.push("Enter".into());
            }
            if keys.iter().any(|k| matches!(k, AnswerKey::Esc)) {
                parts.push("Esc".into());
            }
            parts.join(" + ")
        }
    }
}

fn clean_text(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

fn cap_head(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn cap_tail(s: &str, max: usize) -> String {
    let v: Vec<char> = s.chars().collect();
    if v.len() <= max {
        return v.into_iter().collect();
    }
    v[v.len() - max..].iter().collect()
}

fn is_selected_marker(c: char) -> bool {
    matches!(c, '>' | '●' | '▶' | '❯')
}

/// 依終端種類找提問。pi 1.4 的選單用「→ 」當選中記號、其他選項只縮排，跟 grok 的「>」同一種樣式（#483）：
/// 只在 pi 的終端把行首的「→」當成「>」解析；grok、agy 畫面裡的「→」（例如輸出裡的箭頭）一律當一般文字，不會被誤認成選單
fn classify_prompt_for(profile: &str, text: &str) -> Option<ScreenPrompt> {
    if profile != "pi" {
        return classify_prompt(text);
    }
    let t = text
        .lines()
        .map(|l| {
            let ind = l.chars().take_while(|c| *c == ' ').count();
            let rest: String = l.chars().skip(ind).collect();
            match rest.strip_prefix('→') {
                Some(r) => format!("{}>{r}", " ".repeat(ind)),
                None => l.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    classify_prompt(&t)
}

fn is_unselected_marker(c: char) -> bool {
    matches!(c, '○' | '◦' | '·')
}

/// 行首（只認普通空格）的游標或項目符號。回傳縮排字數、符號、標籤起始欄、標籤。
fn split_marker(line: &str) -> Option<(usize, char, usize, String)> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    let after: String = line.chars().skip(indent).collect();
    let mut it = after.chars();
    let marker = it.next()?;
    if !is_selected_marker(marker) && !is_unselected_marker(marker) {
        return None;
    }
    let rest: String = it.collect();
    let gap = rest.chars().take_while(|c| *c == ' ').count();
    if gap == 0 {
        return None;
    }
    let label = clean_text(&rest.chars().skip(gap).collect::<String>());
    if label.is_empty() {
        return None;
    }
    Some((indent, marker, indent + 1 + gap, label))
}

fn plain_sibling(line: &str, label_col: usize) -> Option<String> {
    if split_marker(line).is_some() {
        return None;
    }
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent != label_col {
        return None;
    }
    let label = clean_text(&line.chars().skip(indent).collect::<String>());
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

fn sibling_label(line: &str, indent: usize, label_col: usize, gt_style: bool) -> Option<String> {
    if let Some((ind, marker, _, label)) = split_marker(line) {
        if ind != indent || is_selected_marker(marker) {
            return None;
        }
        if !gt_style && is_unselected_marker(marker) {
            return Some(label);
        }
        return None;
    }
    if gt_style {
        plain_sibling(line, label_col)
    } else {
        None
    }
}

/// 信任提問優先。選單要恰好一個游標、連續至少兩項、縮排一致才算；對不上就不猜。
/// 兩個以上游標，或項目符號清單拼不齊，是 unknown_prompt（options 空的）。
fn classify_prompt(text: &str) -> Option<ScreenPrompt> {
    if text.contains(GROK_TRUST_MARK) {
        let raw = text.lines().filter(|l| l.contains(GROK_TRUST_MARK)).map(clean_text).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
        return Some(ScreenPrompt {
            kind: "trust_dialog",
            text: cap_head(&raw, PROMPT_TEXT_CHARS),
            options: vec![
                TermOption { n: 1, label: "Yes, proceed".into() },
                TermOption { n: 2, label: "No, quit".into() },
            ],
            cursor: 0,
        });
    }
    let lines: Vec<&str> = text.lines().collect();
    let selected: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| match split_marker(l) {
            Some((_, m, _, _)) if is_selected_marker(m) => Some(i),
            _ => None,
        })
        .collect();
    if selected.len() == 1 {
        if let Some(menu) = parse_menu_block(&lines, selected[0]) {
            return Some(menu);
        }
    }
    let bullet_rows = lines.iter().filter(|l| split_marker(l).is_some_and(|(_, m, _, _)| m != '>')).count();
    if selected.len() >= 2 || (bullet_rows >= 2 && selected.len() != 1) {
        let start = lines.len().saturating_sub(PROMPT_TEXT_LINES);
        let body = lines[start..].iter().map(|l| clean_text(l)).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
        return Some(ScreenPrompt {
            kind: "unknown_prompt",
            text: cap_tail(&body, PROMPT_TEXT_CHARS),
            options: Vec::new(),
            cursor: 0,
        });
    }
    None
}

fn parse_menu_block(lines: &[&str], cursor_idx: usize) -> Option<ScreenPrompt> {
    let (indent, marker, label_col, _) = split_marker(lines[cursor_idx])?;
    if !is_selected_marker(marker) {
        return None;
    }
    let gt_style = marker == '>';
    let mut start = cursor_idx;
    let mut end = cursor_idx;
    while start > 0 {
        let prev = lines[start - 1];
        if prev.trim().is_empty() || sibling_label(prev, indent, label_col, gt_style).is_none() {
            break;
        }
        start -= 1;
    }
    while end + 1 < lines.len() {
        let next = lines[end + 1];
        if next.trim().is_empty() || sibling_label(next, indent, label_col, gt_style).is_none() {
            break;
        }
        end += 1;
    }
    if end - start + 1 < 2 {
        return None;
    }
    let mut options = Vec::new();
    let mut cursor = 0u32;
    for (i, line) in lines.iter().enumerate().take(end + 1).skip(start) {
        let label = if i == cursor_idx {
            split_marker(line)?.3
        } else {
            sibling_label(line, indent, label_col, gt_style)?
        };
        let n = options.len() as u32 + 1;
        if i == cursor_idx {
            cursor = n;
        }
        options.push(TermOption { n, label });
    }
    if cursor == 0 || options.len() < 2 {
        return None;
    }
    let mut q = Vec::new();
    let mut i = start;
    while i > 0 {
        i -= 1;
        if lines[i].trim().is_empty() {
            break;
        }
        let line = clean_text(lines[i]);
        if !line.is_empty() {
            q.push(line);
        }
    }
    q.reverse();
    Some(ScreenPrompt {
        kind: "menu",
        text: cap_head(&q.join("\n"), PROMPT_TEXT_CHARS),
        options,
        cursor,
    })
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
    let mut svc = TermService::from_env(data_dir.join("wezterm-term.lua"), data_dir.join("wezterm-terms.json"), crate::identity::home_dir(), wezterm::RealRunner, wezterm::RealFs);
    svc.set_agy_args(Box::new(crate::gemini_session::live_args));
    // B2b 開關：只在 ASN_TERM_MUX=1 才開在共用的 mux 裡，預設關。啟動時讀一次（要在 reclaim 之前，認領 mux 的列要看它）
    // #611：mux 建立在 WezTerm 開窗之上——ASN_TERM_WEZTERM 沒開時 ASN_TERM_MUX=1 無效（關係定義在 win_term::switches_from）
    let (wez, mux) = super::win_term::switches_from(std::env::var(super::win_term::ENV_WEZTERM).ok().as_deref(), std::env::var(super::win_term::ENV_MUX).ok().as_deref());
    super::win_term::set_wezterm_windows(wez);
    svc.set_hold_config(wez);
    svc.set_use_mux(mux);
    if let Err(e) = svc.reclaim() {
        elog!("終端對照表接手失敗（不中斷啟動）：{e}");
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

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermAnswerReq {
    pub id: String,
    pub prompt_kind: String,
    pub n: u32,
    /// 代答雜湊用；前端從 term_status 的 prompt 帶入（遠端確認與本機作廢時要比對）。
    #[serde(default)]
    pub prompt_text: String,
    #[serde(default)]
    pub options: Vec<TermOption>,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermAdoptReq {
    pub pid: u32,
    pub pane_id: u64,
    pub started_ms: u64,
}

#[cfg(feature = "gui")]
#[derive(Debug, serde::Deserialize)]
pub struct TermAdoptUnlockReq {
    pub id: String,
    #[serde(default)]
    pub allow_answer: bool,
    #[serde(default)]
    pub allow_send: bool,
}

#[cfg(feature = "gui")]
pub fn adopt_candidates_live(terms: &LiveTerms, _data_dir: &Path) -> Result<Vec<TermAdoptCandidate>, String> {
    let config = super::config::load_launch_config()?;
    terms.adopt_candidates(&config)
}

#[cfg(feature = "gui")]
pub fn adopt_live(terms: &LiveTerms, req: TermAdoptReq, _data_dir: &Path) -> Result<TermStarted, String> {
    let config = super::config::load_launch_config()?;
    let id = terms.adopt(req.pid, req.pane_id, req.started_ms, &config)?;
    Ok(TermStarted { id })
}

/// 啟動時由畫面那一層交進來的終端服務（#475）：開新夥伴（經 pi）、名單切前景／背景要用同一份對照表。
/// 只設一次；測試不設、也不讀（pi_host／own_gui_pids 在測試一律回空），平行的測試不共用狀態
#[cfg(feature = "gui")]
static GLOBAL: std::sync::OnceLock<std::sync::Arc<LiveTerms>> = std::sync::OnceLock::new();

#[cfg(feature = "gui")]
pub fn set_global(t: std::sync::Arc<LiveTerms>) {
    let _ = GLOBAL.set(t);
}

/// 經 pi 開夥伴用的自帶終端（見 pi_term）；沒有畫面的建置、測試＝None
#[cfg(feature = "gui")]
pub(crate) fn pi_host() -> Option<std::sync::Arc<dyn super::pi_term::PiTermHost>> {
    #[cfg(test)]
    {
        None
    }
    #[cfg(not(test))]
    {
        GLOBAL.get().map(|t| t.clone() as std::sync::Arc<dyn super::pi_term::PiTermHost>)
    }
}

/// 開窗點用的自帶終端（見 win_term）；沒有畫面的建置、測試不編這個（win_term 那邊直接當沒有）
#[cfg(all(feature = "gui", not(test)))]
pub(crate) fn win_host() -> Option<std::sync::Arc<dyn super::win_term::WinTermHost>> {
    GLOBAL.get().map(|t| t.clone() as std::sync::Arc<dyn super::win_term::WinTermHost>)
}

/// ASN 自己開的終端的（GUI 程序編號, 建立時間）：判斷「ASN 開的」用；沒有畫面的建置、測試＝空
pub(crate) fn own_gui_windows() -> Vec<(u32, u64)> {
    #[cfg(all(feature = "gui", not(test)))]
    {
        // 開關關著（#611）＝0.1.113：不認自帶終端裡的夥伴視窗，「ASN 開的」只看舊式承載 PowerShell
        if !super::win_term::wezterm_windows() {
            return Vec::new();
        }
        GLOBAL.get().map(|t| t.own_gui_windows()).unwrap_or_default()
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        Vec::new()
    }
}

/// 收掉 ASN 自己開的某個 GUI（核對建立時間，見 TermService::stop_gui）；沒有畫面的建置、測試一律不動
pub(crate) fn stop_own_gui(gui_pid: u32) -> Result<(), String> {
    #[cfg(all(feature = "gui", not(test)))]
    {
        if !super::win_term::wezterm_windows() {
            return Err("自帶終端開窗沒有開啟".into());
        }
        GLOBAL.get().ok_or_else(|| "終端服務還沒準備好".to_string())?.stop_gui(gui_pid)
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        let _ = gui_pid;
        Err("這個建置沒有自帶的終端".into())
    }
}

/// 背景開（設計 1.4）：WezTerm 沒有隱藏啟動的參數，開完立刻把那個 GUI 的視窗藏起來。
/// 視窗可能比通訊檔晚一點出現，最多等 3 秒；藏不了只記 log、視窗照常顯示（不當成開失敗）
#[cfg(all(windows, feature = "gui"))]
fn hide_gui(gui_pid: u32) {
    for _ in 0..30 {
        let wins = super::console::win::find_wez_windows(gui_pid);
        if !wins.is_empty() {
            for w in wins {
                if let Err(e) = super::console::win::set_visible(w.hwnd, false) {
                    elog!("背景開：隱藏自帶終端的視窗失敗（{gui_pid}）：{e}");
                }
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    elog!("背景開：3 秒內找不到自帶終端的視窗（{gui_pid}），照常顯示");
}

#[cfg(all(not(windows), feature = "gui"))]
fn hide_gui(_gui_pid: u32) {}

#[cfg(feature = "gui")]
impl super::win_term::WinTermHost for LiveTerms {
    fn available(&self) -> bool {
        self.dir().is_ok()
    }
    fn open_window(&self, cwd: &Path, spec: &super::win_term::WinSpec) -> Result<u32, super::win_term::WinOpenError> {
        self.ensure_config().map_err(super::win_term::WinOpenError::NotStarted)?;
        let (_, gui) = TermService::start_window(self, cwd, spec)?;
        // mux 模式沒有自己的 GUI 視窗可藏（gui 是 mux 的程序編號，不能拿去找視窗）
        if spec.hidden && !self.use_mux {
            hide_gui(gui);
        }
        Ok(gui)
    }
}

/// B2c：共用 mux 裡、名字是 `name` 的夥伴視窗的終端編號（mux＝名單上那個程序往上找到的 mux 的編號與建立時間）；沒有畫面的建置、測試＝None
pub(crate) fn mux_partner_in(mux: (u32, u64), name: &str) -> Option<String> {
    #[cfg(all(feature = "gui", not(test)))]
    {
        GLOBAL.get().and_then(|t| t.partner_in_mux(mux, name))
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        let _ = (mux, name);
        None
    }
}

/// B2c：夥伴清單的前台／背景（看畫面的 GUI）查詢、切換
pub(crate) fn mux_console_query(id: &str) -> serde_json::Value {
    #[cfg(all(feature = "gui", not(test)))]
    {
        match GLOBAL.get() {
            Some(t) => t.console_query_mux(id),
            None => serde_json::json!({ "ok": false, "reason": "終端服務還沒準備好" }),
        }
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        let _ = id;
        serde_json::json!({ "ok": false, "reason": "這個建置沒有自帶的終端" })
    }
}

pub(crate) fn mux_console_set(id: &str, visible: bool) -> serde_json::Value {
    #[cfg(all(feature = "gui", not(test)))]
    {
        match GLOBAL.get() {
            Some(t) => t.console_set_mux(id, visible),
            None => serde_json::json!({ "ok": false, "reason": "終端服務還沒準備好" }),
        }
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        let _ = (id, visible);
        serde_json::json!({ "ok": false, "reason": "這個建置沒有自帶的終端" })
    }
}

/// B2c：關共用 mux 裡的夥伴視窗（關窗格、收看畫面的 GUI，不動 mux）；沒有畫面的建置、測試一律不動
pub(crate) fn stop_mux_partner(id: &str) -> Result<(), String> {
    #[cfg(all(feature = "gui", not(test)))]
    {
        GLOBAL.get().ok_or_else(|| "終端服務還沒準備好".to_string())?.stop_partner(id)
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        let _ = id;
        Err("這個建置沒有自帶的終端".into())
    }
}

/// B2c：夥伴清單上「使用者環境變數裡有金鑰類變數」的一句話（只有開了 mux 模式、而且真的有才回）。只讀名字，不改登錄檔
pub(crate) fn mux_env_notice() -> Option<String> {
    #[cfg(all(feature = "gui", not(test)))]
    {
        GLOBAL.get().filter(|t| t.use_mux)?;
        super::mux::secret_notice(&super::mux::user_env_names())
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        None
    }
}

/// ASN 自己開的終端的 GUI 程序編號（切前景／背景只認這些）；沒有畫面的建置、測試＝空
pub(crate) fn own_gui_pids() -> Vec<u32> {
    #[cfg(all(feature = "gui", not(test)))]
    {
        GLOBAL.get().map(|t| t.own_gui_pids()).unwrap_or_default()
    }
    #[cfg(not(all(feature = "gui", not(test))))]
    {
        Vec::new()
    }
}

#[cfg(feature = "gui")]
impl super::pi_term::PiTermHost for LiveTerms {
    fn available(&self) -> bool {
        self.dir().is_ok()
    }
    fn start_pi(&self, cwd: &Path, argv: &[String], env: &BTreeMap<String, String>, hidden: bool) -> Result<u32, super::win_term::WinOpenError> {
        self.ensure_config().map_err(super::win_term::WinOpenError::NotStarted)?;
        let (_, gui) = TermService::start_pi_staged(self, cwd, argv, env)?;
        if hidden && !self.use_mux {
            hide_gui(gui);
        }
        Ok(gui)
    }
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
    thread_local! {
        /// 假的檔案系統裡可讀的文字檔（GUI 的 log）；測試各跑在自己的執行緒，互不影響
        static LOG_TEXTS: RefCell<HashMap<PathBuf, String>> = RefCell::new(HashMap::new());
    }
    impl Fs for FakeFs {
        fn exists(&self, p: &Path) -> bool {
            self.files.borrow().contains(p)
        }
        fn read_text(&self, p: &Path) -> Option<String> {
            LOG_TEXTS.with(|m| m.borrow().get(p).cloned())
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
        /// `wezterm.exe --version` 的假輸出。
        version_out: RefCell<String>,
        /// `wezterm cli list-clients --format json` 的假輸出。
        list_clients_json: RefCell<String>,
        trace: RefCell<Vec<String>>,
        /// 真＝啟動 GUI 本身就失敗（執行檔起不來）
        spawn_fail: RefCell<bool>,
        /// 第一次 list 時先跑一下（模擬開視窗之後才出狀況）
        on_list: RefCell<Option<Box<dyn Fn()>>>,
        /// 走 run_clean 的呼叫（mux 的 cli spawn）：（參數, 環境）
        clean_calls: RefCell<Vec<(Vec<String>, BTreeMap<String, String>)>>,
        /// `cli spawn` 印出的窗格編號
        spawn_out: RefCell<String>,
        /// run_clean 直接回這個錯（模擬 wezterm.exe 起不來或逾時）
        clean_err: RefCell<Option<String>>,
        /// 某個程序編號依序吐出的建立時間（優先於 started 佇列；空了就回預設值）：模擬那個程序結束了或編號被拿去用
        pid_started: RefCell<HashMap<u32, Vec<Option<u64>>>>,
        /// 每次啟動 GUI 後呼叫，參數是這是第幾次啟動（從 1 起）：模擬第 N 次才開得起視窗
        on_spawn: RefCell<Option<Box<dyn Fn(usize)>>>,
        /// 看畫面的 GUI 的視窗已經出現（真＝一問就有）
        window_up: RefCell<bool>,
    }

    fn default_list_clients_json() -> String {
        r#"[{"pid":1,"idle_time":{"secs":60,"nanos":0},"focused_pane_id":0}]"#.into()
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
            version_out: RefCell::new("wezterm 20240203-110809-5046fc22".into()),
            list_clients_json: RefCell::new(default_list_clients_json()),
            trace: RefCell::new(Vec::new()),
            spawn_fail: RefCell::new(false),
            on_list: RefCell::new(None),
            clean_calls: RefCell::new(Vec::new()),
            spawn_out: RefCell::new(String::new()),
            clean_err: RefCell::new(None),
            pid_started: RefCell::new(HashMap::new()),
            on_spawn: RefCell::new(None),
            window_up: RefCell::new(false),
        }
    }

    fn list_clients_json_with_idle(secs: u64, focused_pane_id: u64) -> String {
        format!(r#"[{{"pid":1,"idle_time":{{"secs":{secs},"nanos":0}},"focused_pane_id":{focused_pane_id}}}]"#)
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
            // mux 模式的 cli 在 "cli" 後面多一個 --no-auto-start：比對子命令時先拿掉
            let sub: Vec<String> = args.iter().filter(|a| a.as_str() != "--no-auto-start").cloned().collect();
            let kind = sub.get(1).cloned().unwrap_or_default();
            self.inner.trace.borrow_mut().push(format!("run:{kind}"));
            if let Some(sub) = self.inner.fail_substr.borrow().clone() {
                if args.iter().any(|a| a.contains(&sub)) {
                    return Err(format!("WezTerm cli 失敗：假的失敗 {sub}"));
                }
            }
            let stdout = if args.first().map(|a| a.as_str()) == Some("--version") {
                self.inner.version_out.borrow().clone()
            } else if args.iter().any(|a| a == "list-clients") {
                self.inner.list_clients_json.borrow().clone()
            } else if kind == "spawn" {
                self.inner.spawn_out.borrow().clone()
            } else if kind == "list" {
                if let Some(f) = self.inner.on_list.borrow_mut().take() {
                    f();
                }
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
        fn run_clean(&self, p: &Path, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> Result<wezterm::RunOutput, String> {
            self.inner.clean_calls.borrow_mut().push((args.to_vec(), env.clone()));
            if let Some(e) = self.inner.clean_err.borrow().clone() {
                return Err(e);
            }
            self.run(p, args, env, timeout)
        }
        fn spawn(&self, _p: &Path, args: &[String], env: &BTreeMap<String, String>) -> Result<u32, String> {
            if *self.inner.spawn_fail.borrow() {
                return Err("無法啟動 wezterm-gui.exe：假的失敗".into());
            }
            self.inner.calls.borrow_mut().push((args.to_vec(), env.clone()));
            if let Some(f) = self.inner.on_spawn.borrow().as_ref() {
                let n = self.inner.calls.borrow().iter().filter(|(a, _)| a.first().map(|s| s == "start").unwrap_or(false)).count();
                f(n);
            }
            Ok(42)
        }
        fn kill_tree(&self, pid: u32) {
            self.inner.tree_killed.borrow_mut().push(pid);
        }
        fn window_up(&self, _pid: u32) -> bool {
            *self.inner.window_up.borrow()
        }
        fn started_ms(&self, pid: u32) -> Option<u64> {
            if let Some(q) = self.inner.pid_started.borrow_mut().get_mut(&pid) {
                if !q.is_empty() {
                    return q.remove(0);
                }
            }
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
        home: PathBuf,
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
        let home = PathBuf::from("H");
        let svc = TermService::fixed(
            WezTermDir {
                gui: "W/wezterm-gui.exe".into(),
                cli: "W/wezterm.exe".into(),
            },
            "cfg.lua".into(),
            store.clone(),
            home.clone(),
            runner,
            fs,
        );
        Rig {
            _dir: dir,
            home,
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
        assert_eq!(v["terms"][0]["cwd"], rig.cwd, "對照表記下開啟時已授權的資料夾");
        assert_eq!(v["terms"][0]["send_granted"], true, "在 ASN 選定並通過允許清單，記成可代送");
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
                    started_ms: Some(1_000),
                    cwd: rig.cwd.clone(),
                    adopted: false,
                    answer_unlocked: true,
                    send_unlocked: true,
                },
                TermListed {
                    id: id2,
                    profile: "grok".into(),
                    pid: 42,
                    started_ms: Some(1_000),
                    cwd: rig.cwd.clone(),
                    adopted: false,
                    answer_unlocked: true,
                    send_unlocked: true,
                },
            ]
        );
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(json["id"], id);
        assert_eq!(json["profile"], "agy");
        assert_eq!(json["pid"], 42);
        assert_eq!(json["started_ms"], 1_000);
        assert_eq!(json["cwd"], rig.cwd);
        assert_cli_uses_socket(&rig.runner);
    }

    #[test]
    fn agy_帶上_settings_參數_grok_不帶_其他參數一律不收() {
        let mut rig = make(default_profiles(), vec![]);
        rig.svc.set_agy_args(Box::new(|| vec!["--settings".into(), "C:/asn/gemini-session-settings.json".into()]));
        rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        let starts = started_args(&rig.runner);
        assert_eq!(starts[0], vec!["start", "--always-new-process", "--cwd", rig.cwd.as_str(), "--workspace", "asn-1", "--", "C:/bin/agy.exe", "--settings", "C:/asn/gemini-session-settings.json"]);
        assert_eq!(starts[1], vec!["start", "--always-new-process", "--cwd", rig.cwd.as_str(), "--workspace", "asn-2", "--", "C:/bin/grok.exe"], "grok 不帶");
        // 只認 --settings 這一組：別的旗標、多出來的參數、空值都不帶
        for bad in [vec!["--dangerously-skip-permissions".to_string(), "x".into()], vec!["--settings".into(), "a".into(), "b".into()], vec!["--settings".into(), " ".into()], vec![]] {
            let mut rig = make(default_profiles(), vec![]);
            rig.svc.set_agy_args(Box::new(move || bad.clone()));
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            assert_eq!(started_args(&rig.runner)[0].last().map(String::as_str), Some("C:/bin/agy.exe"));
        }
    }

    #[test]
    fn 通訊檔不見就拒絕送字與讀取且不執行_cli() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        assert_cli_uses_socket(&rig.runner);
        let before = rig.runner.args().len();
        assert!(rig.files.borrow_mut().remove(&sock()));
        let send = rig.svc.confirm_send(&id, "不該送出", true).unwrap_err();
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
        for name in ["TermStartReq", "TermSendReq", "TermReadReq", "TermStopReq", "TermStatusReq", "TermRenameReq", "TermAnswerReq"] {
            let marker = format!("struct {name}");
            let rest = src.split(&marker).nth(1).unwrap_or_else(|| panic!("找不到 {name}"));
            let body = rest.split('}').next().unwrap();
            assert!(!body.contains("pid") && !body.contains("sock") && !body.contains("gui_pid"), "{name} 不收程序編號或通訊路徑：{body}");
        }
        assert!(lib.contains("terms.stop(&req.id)"), "關閉只把編號交給 stop");
        assert!(lib.contains("terms.status(&req.id)"), "忙閒只把編號交給 status");
        assert!(lib.contains("terms.rename(&req.id, &req.title)"), "改名只把編號與標題交給 rename");
        assert!(lib.contains("term_remote::local_confirm_answer"), "代答經遠端確認模組的唯一入口");
        assert!(lib.contains("term_remote::local_confirm_send"), "代送文字經遠端確認模組的唯一入口");
        let head = src.split("mod tests").next().unwrap();
        assert!(!head.contains(".answer("), "後端其他路徑不得呼叫 answer；UI 提示框是唯一入口");
        assert!(!head.contains(".confirm_send("), "後端其他路徑不得呼叫 confirm_send；UI 確認是唯一入口");
        let ans = head.split("pub fn answer(").nth(1).expect("找得到 answer");
        let ans_body = ans.split("pub fn rename").next().unwrap();
        assert!(ans_body.contains("encode_keys(&keys)"), "送出前只能走固定對照表");
        assert!(ans_body.contains("send_bytes"), "代答走 send-text 位元組，不壓行");
        assert!(!ans_body.contains("send(") && !ans_body.contains("send_line"), "代答不把文字交給會丟掉控制碼的壓行送字");
        assert!(ans_body.contains("trust_dialog") && ans_body.contains("note_send_grant"), "信任提問按了信任才記下授權");
        let send_fn = head.split("pub fn confirm_send(").nth(1).expect("有確認後送字").split("pub fn read").next().unwrap();
        assert!(send_fn.contains("send_granted"), "沒有授權記錄不能送");
        assert!(send_fn.contains("send_line"), "確認後的文字仍走會壓行的送字");
        assert!(!send_fn.contains("send_bytes"), "確認後送字不走方向鍵路徑");
        assert!(!send_fn.contains("flatten_line"), "不在這裡放寬或複製壓行");
        let req = src.split("struct TermAnswerReq").nth(1).unwrap().split('}').next().unwrap();
        assert!(!req.contains("choice") && !req.contains("keys") && !req.contains("ansi"), "不收原始按鍵或選擇字串：{req}");
        let wz = include_str!("wezterm.rs");
        let bytes_fn = wz.split("pub fn send_bytes(").nth(1).expect("有專用按鍵路徑").split("fn send_raw").next().unwrap();
        assert!(!bytes_fn.contains("flatten_line"), "方向鍵路徑不得壓行");
        let line_fn = wz.split("pub fn send_line(").nth(1).unwrap().split("pub fn send_enter").next().unwrap();
        assert!(line_fn.contains("flatten_line"), "一般送字仍要壓行，不能放寬");
        assert!(!lib.contains("kill_tree"), "命令層不自己結束行程");
    }

    #[test]
    fn 未知編號拒絕且不送不讀不結束() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        let before = rig.runner.args().len();
        for op in [
            rig.svc.confirm_send("999", "你好", true).unwrap_err(),
            rig.svc.read("999", 10).unwrap_err(),
            rig.svc.stop("999").unwrap_err(),
            rig.svc.rename("999", "名稱").unwrap_err(),
            rig.svc.status("999").unwrap_err(),
            rig.svc.answer("999", "trust_dialog", 1).unwrap_err(),
        ] {
            assert!(op.contains("沒有這個終端"), "{op}");
        }
        assert_eq!(rig.runner.args().len(), before, "未知編號不可呼叫 WezTerm");
        assert!(rig.runner.killed().is_empty());
        rig.svc.confirm_send(&id, "仍可送自己的", false).unwrap();
    }

    #[test]
    fn 送字可選擇是否另送換行鍵且換行先壓成單行() {
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        rig.svc.confirm_send(&id, "第一行\n第二行", false).unwrap();
        rig.svc.confirm_send(&id, "請只回覆 OK", true).unwrap();
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].last().map(String::as_str), Some("第一行 第二行"));
        assert_eq!(sent[1].last().map(String::as_str), Some("請只回覆 OK"));
        assert_eq!(sent[2].last().map(String::as_str), Some("\r"));
        assert_eq!(rig.runner.inner.sleeps.borrow().len(), 1, "有 Enter 才在兩次之間等待");
    }

    #[test]
    fn 沒有授權記錄就不能代送_信任後才可以() {
        let trust = "Do you trust the contents of this directory? (Yes, proceed y / No, quit n)\nGrok Build  1.0.70\n";
        let menu = "Pick one\n  Alpha\n> Beta\n  Gamma\n";
        let rig = make(default_profiles(), vec![Some(1_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-4", "ASN:4", 7, 1);
        write_store(&rig.store, 7, &row("4", "grok", "1000", r#","cwd":"D:/proj""#));
        rig.svc.reclaim().unwrap();
        assert_eq!(rig.svc.list()[0].cwd, "D:/proj");
        let before = count_cmd(&rig.runner, "send-text");
        let err = rig.svc.confirm_send("4", "回答 1\n下一行", true).unwrap_err();
        assert!(err.contains("授權"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "沒有授權記錄不可送字");

        *rig.runner.inner.screen.borrow_mut() = menu.into();
        rig.svc.answer("4", "menu", 2).unwrap();
        let err = rig.svc.confirm_send("4", "回答 1\n下一行", true).unwrap_err();
        assert!(err.contains("授權"), "選單代答不構成資料夾授權：{err}");
        assert!(!rig.runner.args().iter().any(|a| a.iter().any(|x| x.contains("回答 1"))), "還沒授權就不能把那句話送出去");

        *rig.runner.inner.screen.borrow_mut() = trust.into();
        rig.svc.answer("4", "trust_dialog", 2).unwrap();
        let err = rig.svc.confirm_send("4", "回答 1\n下一行", true).unwrap_err();
        assert!(err.contains("授權"), "按了不信任不能代送：{err}");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert_eq!(v["terms"][0]["send_granted"], false, "按了不信任不要記成可代送");

        rig.svc.answer("4", "trust_dialog", 1).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert_eq!(v["terms"][0]["send_granted"], true, "按了信任才記下授權");
        assert_eq!(v["terms"][0]["cwd"], "D:/proj", "授權的是終端自己的資料夾，不是呼叫端傳進來的");
        rig.svc.confirm_send("4", "回答 1\n下一行", true).unwrap();
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.last().unwrap().last().map(String::as_str), Some("\r"));
        assert!(sent.iter().any(|a| a.last().map(String::as_str) == Some("回答 1 下一行")), "換行仍先壓成單行：{sent:?}");
        assert!(!sent.iter().any(|a| a.iter().any(|x| x.contains('\u{1b}')) && a.iter().any(|x| x.contains("回答"))), "這句話不走方向鍵路徑");

        let rig = make(default_profiles(), vec![Some(1_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-4", "ASN:4", 7, 1);
        write_store(&rig.store, 7, &row("4", "grok", "1000", r#","cwd":"","send_granted":true"#));
        rig.svc.reclaim().unwrap();
        let before = count_cmd(&rig.runner, "send-text");
        let err = rig.svc.confirm_send("4", "回答 1", false).unwrap_err();
        assert!(err.contains("授權"), "空的資料夾不能代送：{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before);

        let rig = make(default_profiles(), vec![Some(1_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-4", "ASN:4", 7, 1);
        write_store(&rig.store, 7, &row("4", "grok", "1000", r#","cwd":"D:/proj","send_granted":true"#));
        rig.svc.reclaim().unwrap();
        rig.svc.confirm_send("4", "已授權", false).unwrap();
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.last().unwrap().last().map(String::as_str), Some("已授權"));
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
        assert!(rig.svc.confirm_send(&id, "x", false).unwrap_err().contains("沒有這個終端"));
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
        let mut svc = TermService::fixed(
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
        svc.set_hold_config(true); // 開關開著（ASN_TERM_WEZTERM=1）才帶 exit_behavior
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), ISOLATED_CONFIG);
        assert!(ISOLATED_CONFIG.contains("exit_behavior = \"Hold\""), "程式結束後視窗留著（設計 1.4）");
        // 舊版寫的空設定升級成新的
        std::fs::write(&path, "return {}\n").unwrap();
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), ISOLATED_CONFIG, "舊版的空設定要升級");
        std::fs::write(&path, "return { kept = true }\n").unwrap();
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return { kept = true }\n", "已存在的隔離設定不可覆蓋");
    }

    #[test]
    fn 開關關著_隔離設定檔照_0_1_113_寫空設定_已存在的不動不升級() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wezterm-term.lua");
        let fs = FakeFs { files: Rc::new(RefCell::new(HashSet::new())) };
        let runner = FakeRunner { inner: Rc::new(fake_inner(vec![], "[]".into(), String::new())) };
        let svc = TermService::fixed(WezTermDir { gui: "W/wezterm-gui.exe".into(), cli: "W/wezterm.exe".into() }, path.clone(), dir.path().join("wezterm-terms.json"), "H".into(), runner, fs);
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return {}\n", "0.1.113 寫的內容");
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return {}\n", "關著不升級成 Hold");
        // #611：第 1 階段寫的 Hold 版本（一個字不差）關著時改回空設定
        std::fs::write(&path, ISOLATED_CONFIG).unwrap();
        svc.ensure_config().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "return {}\n", "是我們寫的 Hold 版本要改回");
        // 不是我們寫的（多一個字、使用者改過）一律不動
        for custom in ["return { exit_behavior = \"Hold\", font_size = 12 }\n", "return { exit_behavior = \"Hold\" }\n-- 我的", "return { exit_behavior = \"Hold\" }"] {
            std::fs::write(&path, custom).unwrap();
            svc.ensure_config().unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), custom, "不是我們寫的不動：{custom}");
        }
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

    /// 真機空輸入框：行首兩格，行尾右邊線。中間空白多寡不影響判斷。
    fn real_empty_input_line() -> String {
        format!("  │ ❯{}│", " ".repeat(38))
    }

    fn real_typed_input_line() -> String {
        format!("  │ ❯ 你好{}│", " ".repeat(32))
    }

    #[test]
    fn agy_穩定停在輸入框仍是_unknown() {
        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = format!("{}\nGrok Build  1.0.70\n", real_empty_input_line());
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
    fn 兩次取樣之間只睡注入的間隔且停在輸入框才是_idle() {
        let mut rig = make(default_profiles(), vec![]);
        assert_eq!(rig.svc.status_gap, STATUS_GAP);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        // 向量：空輸入框（行首兩格、行尾右邊線）加底列「Grok Build  1.0.70」，兩次不變 → idle。
        *rig.runner.inner.screen.borrow_mut() = format!("{}\nGrok Build  1.0.70\n", real_empty_input_line());
        rig.svc.set_status_gap(Duration::from_millis(5));
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "idle");
        assert_eq!(st.profile, "grok");
        assert_eq!((st.cursor_x, st.cursor_y), (Some(1), Some(2)));
        assert!(st.reason.contains("輸入框"), "{}", st.reason);
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
        *rig.runner.inner.screens.borrow_mut() = vec![
            format!("{}\nGrok Build  1.0.70\n", real_empty_input_line()),
            format!("{}\n正在想\nGrok Build  1.0.70\n", real_empty_input_line()),
        ];
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
    fn 輸入框那一行的原樣() {
        assert!(matches!(grok_input_box("  │ ❯         │"), InputBox::Empty));
        assert!(matches!(grok_input_box("  │ ❯ …       │"), InputBox::Empty));
        assert!(matches!(grok_input_box("  │ ❯ cargo test │"), InputBox::Typing));
        assert!(matches!(grok_input_box("│ ❯ …"), InputBox::Empty));
        assert!(matches!(grok_input_box("│ ❯ /"), InputBox::Typing));
    }

    #[test]
    fn 空輸入框但含處理中標記直接是_busy() {
        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        rig.svc.set_status_gap(Duration::from_millis(5));
        // 真機處理中：輸入框仍空，右側有 [stop]，底列換成取消快捷鍵。不等第二次。
        *rig.runner.inner.screen.borrow_mut() = format!(
            "{}\nWaiting for response… 22s ⇣25.2k [stop]\nShift+Tab:mode │ Ctrl+c:cancel │ Ctrl+x:shortcuts\n",
            real_empty_input_line()
        );
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "busy", "空輸入框加上 [stop] 仍是處理中：{}", st.reason);
        assert!(st.reason.contains("處理中"), "{}", st.reason);
        assert!(st.prompt.is_none());
        assert_eq!((st.cursor_x, st.cursor_y), (Some(1), Some(2)));
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "第一次就看到處理中標記，不必再睡");
        assert_eq!(count_cmd(&rig.runner, "get-text"), 1, "不等第二次取樣");
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0);

        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        rig.svc.set_status_gap(Duration::from_millis(5));
        *rig.runner.inner.screen.borrow_mut() = format!("{}\nShift+Tab:mode │ Ctrl+c:cancel │ Ctrl+x:shortcuts\n", real_empty_input_line());
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "busy", "只有 Ctrl+c:cancel 也是處理中：{}", st.reason);
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "取消快捷鍵也應立刻 busy");
        assert_eq!(count_cmd(&rig.runner, "get-text"), 1);

        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        rig.svc.set_status_gap(Duration::from_millis(5));
        *rig.runner.inner.screen.borrow_mut() = format!(
            "Do you trust the contents of this directory? (Yes, proceed y / No, quit n)\n{}\n22s [stop]\n",
            real_empty_input_line()
        );
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "waiting_user", "信任提問仍優先於處理中標記：{}", st.reason);
        assert_eq!(st.reason, "trust_dialog");
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "第一次就看到提問，不必再睡");
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0);
    }

    /// pi 1.4 的信任提問（#483，照 #475 驗收時小良哥截圖的畫面）：選中那行是「→ 」，其他選項只縮排
    const PI_TRUST_SCREEN: &str = "────────────────\n\n Trust project folder?\n C:\\Users\\u\\proj\n\n This allows pi to load .pi settings and resources, install missing project\n packages, and execute project extensions.\n\n → Trust\n   Trust parent folder (C:\\Users\\u)\n   Trust (this session only)\n   Do not trust\n   Do not trust (this session only)\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n";

    fn pi_rig() -> (Rig, String) {
        let rig = make(default_profiles(), vec![]);
        let argv: Vec<String> = vec!["pi".into()];
        let (id, _) = rig.svc.start_pi(Path::new(&rig.cwd), &argv, &BTreeMap::new()).unwrap();
        (rig, id)
    }

    #[test]
    fn pi_的信任提問_認得是選單_列出五個選項_游標在第一個_不自動代答() {
        let (rig, id) = pi_rig();
        *rig.runner.inner.screen.borrow_mut() = PI_TRUST_SCREEN.into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "waiting_user", "{}", st.reason);
        let p = st.prompt.expect("附上提問");
        assert_eq!(p.kind, "menu");
        assert_eq!(
            p.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(),
            vec!["Trust", "Trust parent folder (C:\\Users\\u)", "Trust (this session only)", "Do not trust", "Do not trust (this session only)"]
        );
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0, "只看不送");
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "pi 讀一次畫面就好");
    }

    #[test]
    fn pi_的提問經確認代答_送往下與_enter_選到第三個_畫面換了就不送() {
        let (rig, id) = pi_rig();
        *rig.runner.inner.screen.borrow_mut() = PI_TRUST_SCREEN.into();
        let a = rig.svc.answer(&id, "menu", 3).unwrap();
        assert_eq!(a.keys, describe_keys(&[AnswerKey::Down, AnswerKey::Down, AnswerKey::Enter]), "選「只信任這一次」");
        *rig.runner.inner.screen.borrow_mut() = "pi  anthropic/claude-sonnet-5-5\n> \n".into();
        assert!(rig.svc.answer(&id, "menu", 3).unwrap_err().contains("不在畫面上"), "提問已經不在：不送");
    }

    #[test]
    fn 行首的箭頭只在_pi_當成選單記號_grok_畫面裡的箭頭當一般文字() {
        // asn真 審 #490：grok／agy 的輸出剛好有「→ 」開頭的行，不能被誤認成選單
        let arrows = " 變更：\n → a.rs 改了\n   b.rs 沒改\n";
        assert!(classify_prompt_for("grok", arrows).is_none(), "grok 的箭頭是一般文字");
        assert!(classify_prompt_for("agy", arrows).is_none());
        assert_eq!(classify_prompt_for("pi", PI_TRUST_SCREEN).map(|p| p.kind), Some("menu"));
        assert!(classify_prompt_for("grok", PI_TRUST_SCREEN).is_none(), "同一個畫面在 grok 的終端也不當選單");
        // 其他記號照舊：grok 的「>」選單兩邊都認得
        let gt = " Pick one\n > Yes\n   No\n";
        assert_eq!(classify_prompt_for("grok", gt).map(|p| p.kind), Some("menu"));
    }

    #[test]
    fn pi_沒有提問時說忙閒看名單_不猜() {
        let (rig, id) = pi_rig();
        *rig.runner.inner.screen.borrow_mut() = "pi  anthropic/claude-sonnet-5-5\n> \n".into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!((st.state.as_str(), st.reason.as_str()), ("unknown", PI_STATE_ELSEWHERE));
        assert!(st.prompt.is_none());
    }

    #[test]
    fn 信任提問是_waiting_user且不代答() {
        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        rig.svc.set_status_gap(Duration::from_millis(5));
        // 真機：最後一行是版本標題，提問在上面。信任提問優先於輸入框。
        *rig.runner.inner.screen.borrow_mut() = format!("Do you trust the contents of this directory? (Yes, proceed y / No, quit n)\n{}\nGrok Build  1.0.70\n", real_empty_input_line());
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "waiting_user");
        assert_eq!(st.reason, "trust_dialog");
        let p = st.prompt.expect("waiting_user 要附上提問");
        assert_eq!(p.kind, "trust_dialog");
        assert!(p.text.contains("Do you trust the contents of this directory"), "{}", p.text);
        assert!(!p.text.chars().any(|c| c.is_control()), "原文去掉控制字元");
        assert_eq!(p.options.iter().map(|o| (o.n, o.label.as_str())).collect::<Vec<_>>(), vec![(1, "Yes, proceed"), (2, "No, quit")]);
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0, "信任提問不可代答，也不能送任何字");
        assert!(!rig.runner.args().iter().any(|a| a.iter().any(|x| x == "y" || x == "n")));
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "第一次就看到提問，不必再睡");

        *rig.runner.inner.screen.borrow_mut() = "Grok Build  1.0.70\n".into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown", "沒有信任提問、也沒有輸入框時仍是 unknown");
        assert!(st.prompt.is_none());
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0);

        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screens.borrow_mut() = vec![
            "Grok Build  1.0.70\n".into(),
            "Do you trust the contents of this directory?\nGrok Build  1.0.70\n".into(),
        ];
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "waiting_user", "第二次才出現提問也不能當成 busy");
        assert_eq!(st.reason, "trust_dialog");
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0);

        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = "Do you trust the contents of this directory?\n".into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown", "agy 沒有這條規則");
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0);
        assert!(!rig.runner.args().iter().any(|a| a.iter().any(|x| x == "get-text")));
    }

    #[test]
    fn 使用者確認後才代送信任提問的按鍵() {
        let trust = "Do you trust the contents of this directory? (Yes, proceed y / No, quit n)\nGrok Build  1.0.70\n";
        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = trust.into();
        let got = rig.svc.answer(&id, "trust_dialog", 1).unwrap();
        assert_eq!(got.keys, "y");
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent, vec![vec!["cli".to_string(), "send-text".into(), "--pane-id".into(), "7".into(), "--no-paste".into(), "y".into()]]);
        let trace = rig.runner.inner.trace.borrow().clone();
        assert_eq!(trace[trace.len() - 2], "run:get-text", "送出前要先讀畫面：{trace:?}");
        assert_eq!(trace[trace.len() - 1], "run:send-text");
        assert_cli_uses_socket(&rig.runner);
        let got = rig.svc.answer(&id, "trust_dialog", 2).unwrap();
        assert_eq!(got.keys, "n");
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.last().unwrap().last().map(String::as_str), Some("n"));
        assert!(!sent.iter().any(|a| a.iter().any(|x| x == "\r")), "信任提問只送單一字，不另外送 Enter");

        *rig.runner.inner.screen.borrow_mut() = "Grok Build  1.0.70\n".into();
        let before = count_cmd(&rig.runner, "send-text");
        let err = rig.svc.answer(&id, "trust_dialog", 1).unwrap_err();
        assert!(err.contains("不在畫面"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "提示不在就不可送字");

        let before = rig.runner.args().len();
        let err = rig.svc.answer(&id, "\u{1b}[A", 1).unwrap_err();
        assert!(err.contains("不認得"), "{err}");
        assert_eq!(rig.runner.args().len(), before, "控制碼字串不能當成提示種類");
        let err = rig.svc.answer(&id, "something_else", 1).unwrap_err();
        assert!(err.contains("不認得"), "{err}");
        assert_eq!(rig.runner.args().len(), before, "未知提示種類不可呼叫 WezTerm");
        let err = rig.svc.answer(&id, "unknown_prompt", 1).unwrap_err();
        assert!(err.contains("不認得"), "{err}");
        assert_eq!(rig.runner.args().len(), before, "解析不出的提問不能代答");

        *rig.runner.inner.screen.borrow_mut() = trust.into();
        let before = count_cmd(&rig.runner, "send-text");
        let err = rig.svc.answer(&id, "trust_dialog", 3).unwrap_err();
        assert!(err.contains("沒有這個選項"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "編號超出選項不可送字");
        let err = rig.svc.answer(&id, "trust_dialog", 0).unwrap_err();
        assert!(err.contains("沒有這個選項"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before);

        let before = rig.runner.args().len();
        let err = rig.svc.answer("999", "trust_dialog", 1).unwrap_err();
        assert!(err.contains("沒有這個終端"), "{err}");
        assert_eq!(rig.runner.args().len(), before, "未知編號不可送字");
    }

    #[test]
    fn 按鍵只由固定對照表產生且拒絕控制碼() {
        assert_eq!(encode_keys(&[AnswerKey::Up]).unwrap(), "\u{1b}[A");
        assert_eq!(encode_keys(&[AnswerKey::Down]).unwrap(), "\u{1b}[B");
        assert_eq!(encode_keys(&[AnswerKey::Enter]).unwrap(), "\r");
        assert_eq!(encode_keys(&[AnswerKey::Esc]).unwrap(), "\u{1b}");
        assert_eq!(encode_keys(&[AnswerKey::Char('y')]).unwrap(), "y");
        assert_eq!(encode_keys(&[AnswerKey::Char('n')]).unwrap(), "n");
        for bad in ['\u{1b}', '[', ' ', '中', '\r'] {
            let err = encode_keys(&[AnswerKey::Char(bad)]).unwrap_err();
            assert!(err.contains("英數字元"), "{bad:?} {err}");
        }
        let long = vec![AnswerKey::Down; MAX_ANSWER_KEYS + 1];
        assert!(encode_keys(&long).unwrap_err().contains("太長"));
    }

    #[test]
    fn 選單從游標起算且步數與長度有上限() {
        let menu = "Pick one\n  Alpha\n> Beta\n  Gamma\n";
        let parsed = classify_prompt(menu).expect("兩項以上且恰好一個游標");
        assert_eq!(parsed.kind, "menu");
        assert_eq!(parsed.text, "Pick one");
        assert_eq!(parsed.cursor, 2);
        assert_eq!(parsed.options.iter().map(|o| (o.n, o.label.as_str())).collect::<Vec<_>>(), vec![(1, "Alpha"), (2, "Beta"), (3, "Gamma")]);

        let rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        *rig.runner.inner.screen.borrow_mut() = menu.into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "waiting_user");
        assert_eq!(st.reason, "menu");
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0, "看出選單也不代答");
        assert!(rig.runner.inner.sleeps.borrow().is_empty(), "第一次就看到選單，不必再睡");

        let got = rig.svc.answer(&id, "menu", 3).unwrap();
        assert_eq!(got.keys, "Down×1 + Enter", "游標在第 2 項，選第 3 項只往下一格");
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.last().unwrap().last().map(String::as_str), Some("\u{1b}[B\r"));
        assert_ne!(wezterm::flatten_line("\u{1b}[B\r"), "\u{1b}[B\r", "壓行會丟掉方向鍵，代答不能走那條");
        let got = rig.svc.answer(&id, "menu", 1).unwrap();
        assert_eq!(got.keys, "Up×1 + Enter");
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.last().unwrap().last().map(String::as_str), Some("\u{1b}[A\r"));
        let got = rig.svc.answer(&id, "menu", 2).unwrap();
        assert_eq!(got.keys, "Enter");
        let sent: Vec<Vec<String>> = rig.runner.args().into_iter().filter(|a| a.iter().any(|x| x == "send-text")).collect();
        assert_eq!(sent.last().unwrap().last().map(String::as_str), Some("\r"));

        let before = count_cmd(&rig.runner, "send-text");
        let err = rig.svc.answer(&id, "menu", 4).unwrap_err();
        assert!(err.contains("沒有這個選項"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "n 越界不送字");

        *rig.runner.inner.screen.borrow_mut() = "grok>\n".into();
        let err = rig.svc.answer(&id, "menu", 2).unwrap_err();
        assert!(err.contains("不在畫面"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "提示消失不送字");

        let mut far = String::from("> One\n");
        for i in 2..=22 {
            far.push_str(&format!("  Item{i}\n"));
        }
        *rig.runner.inner.screen.borrow_mut() = far;
        let err = rig.svc.answer(&id, "menu", 22).unwrap_err();
        assert!(err.contains("往下"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "往下超過 20 步不送字");
        let got = rig.svc.answer(&id, "menu", 21).unwrap();
        assert_eq!(got.keys, "Down×20 + Enter");

        let mut tall = String::new();
        for i in 1..33 {
            tall.push_str(&format!("  Item{i}\n"));
        }
        tall.push_str("> Last\n");
        *rig.runner.inner.screen.borrow_mut() = tall;
        let before = count_cmd(&rig.runner, "send-text");
        let err = rig.svc.answer(&id, "menu", 1).unwrap_err();
        assert!(err.contains("太長"), "{err}");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "序列超過長度上限不送字");

        let messy = "> Alpha\n> Beta\n";
        assert_eq!(classify_prompt(messy).unwrap().kind, "unknown_prompt");
        assert!(classify_prompt(messy).unwrap().options.is_empty());
        *rig.runner.inner.screen.borrow_mut() = messy.into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "waiting_user");
        assert_eq!(st.prompt.unwrap().kind, "unknown_prompt");
        assert_eq!(count_cmd(&rig.runner, "send-text"), before, "解析不出也不代答");

        let bullets = "● Yes, proceed\n○ No, quit\n";
        let parsed = classify_prompt(bullets).unwrap();
        assert_eq!(parsed.kind, "menu");
        assert_eq!(parsed.cursor, 1);
        assert_eq!(parsed.options[1].label, "No, quit");
    }

    #[test]
    fn 畫面沒變但不是輸入框就是_unknown() {
        let mut rig = make(default_profiles(), vec![]);
        let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
        rig.svc.set_status_gap(Duration::from_millis(5));
        *rig.runner.inner.screen.borrow_mut() = "仍在想\n".into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown", "畫面停住但沒有輸入框，不能猜成閒置");
        assert!(st.reason.contains("輸入框"), "{}", st.reason);
        assert_ne!(st.state, "idle");

        *rig.runner.inner.screen.borrow_mut() = format!("{}\nGrok Build  1.0.70\n", real_typed_input_line());
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown", "輸入框裡有字，保守不當成閒置");
        assert!(st.reason.contains("有文字"), "{}", st.reason);
        assert_eq!(count_cmd(&rig.runner, "send-text"), 0);

        *rig.runner.inner.screen.borrow_mut() = "│ ❯ /\n".into();
        let st = rig.svc.status(&id).unwrap();
        assert_eq!(st.state, "unknown", "選單開著時輸入框是斜線，不是空框");
        assert!(st.reason.contains("有文字"), "{}", st.reason);
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
        write_store(&rig.store, 7, &row("4", "grok", "1000", r#","cwd":"D:/proj""#));
        rig.svc.reclaim().unwrap();
        let listed = rig.svc.list();
        assert_eq!(listed.len(), 1, "檔案沒有的窗格不可認領");
        assert_eq!(listed[0].id, "4");
        assert_eq!(listed[0].profile, "grok");
        assert_eq!(listed[0].pid, 42);
        assert_eq!(listed[0].started_ms, Some(1_000));
        assert_eq!(listed[0].cwd, "D:/proj", "認領沿用開啟時記下的資料夾");
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
    fn 經_pi_開在自帶終端_只帶給的環境_記成_pi_也列進自己開的_gui() {
        let rig = make(default_profiles(), vec![]);
        let env: BTreeMap<String, String> = [("ASN_PI_NAME".to_string(), "小皮".to_string()), ("PATH".to_string(), "C:/bin".to_string())].into();
        let argv: Vec<String> = ["pi", "-e", "ext.ts", "--model", "MiniMax-M3"].iter().map(|s| s.to_string()).collect();
        let (id, gui) = rig.svc.start_pi(Path::new(&rig.cwd), &argv, &env).unwrap();
        assert_eq!(gui, 42);
        let listed = rig.svc.list();
        assert_eq!((listed[0].id.as_str(), listed[0].profile.as_str()), (id.as_str(), "pi"));
        assert_eq!(rig.svc.own_gui_pids(), vec![42], "ASN 自己開的：切前後景認得它");
        let calls = rig.runner.inner.calls.borrow();
        let (args, got_env) = calls.iter().find(|(a, _)| a.first().map(String::as_str) == Some("start")).expect("有開視窗");
        assert!(args.ends_with(&argv), "指令與參數原樣交給 WezTerm：{args:?}");
        assert!(args.windows(2).any(|w| w[0] == "--workspace" && w[1] == format!("asn-{id}")));
        assert_eq!(got_env.get("ASN_PI_NAME").map(String::as_str), Some("小皮"));
        assert_eq!(got_env.get("WEZTERM_CONFIG_FILE").map(String::as_str), Some("cfg.lua"), "照樣用隔離的設定檔");
        assert_eq!(got_env.len(), 3, "只帶給的環境（另加隔離設定檔），不繼承 ASN 自己的：{got_env:?}");
    }

    fn claude_spec(sid: Option<&str>) -> super::super::win_term::WinSpec {
        let mut args: Vec<String> = vec!["-n".into(), "小乙".into()];
        if let Some(s) = sid {
            args.extend(["--resume".to_string(), s.to_string()]);
        }
        let env: BTreeMap<String, String> = [("PATH".to_string(), "C:/bin".to_string())].into();
        super::super::win_term::spec_for("小乙", "C:/bin/claude.exe", &args, false, env)
    }

    #[test]
    fn 開窗點開的_claude_視窗_對照表寫入_kind_與_session_id_參數原樣() {
        let rig = make(default_profiles(), vec![]);
        let spec = claude_spec(Some("sid-123"));
        let (id, gui) = rig.svc.start_window(Path::new(&rig.cwd), &spec).unwrap();
        assert_eq!(gui, 42);
        let text = std::fs::read_to_string(&rig.store).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let row = &v["terms"][0];
        assert_eq!(row["id"], serde_json::json!(id));
        assert_eq!(row["kind"], "claude");
        assert_eq!(row["session_id"], "sid-123");
        assert_eq!(row["profile"], "claude");
        assert_eq!(row["started_ms"], 1000, "GUI 的建立時間照樣記下");
        assert_eq!(row["title"], format!("ASN:{id} 小乙"), "分頁標題是 ASN:編號 接名字");
        let calls = rig.runner.inner.calls.borrow();
        let (args, env) = calls.iter().find(|(a, _)| a.first().map(String::as_str) == Some("start")).expect("有開視窗");
        assert!(args.ends_with(&spec.argv), "指令與參數原樣交給 WezTerm：{args:?}");
        assert_eq!(env.get("PATH").map(String::as_str), Some("C:/bin"));
        assert_eq!(env.len(), 2, "只帶給的環境（另加隔離設定檔）：{env:?}");
        drop(calls);
        // 新對話（參數沒有對話編號）：不寫 session_id
        let (_, _) = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(None)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert!(v["terms"][1].get("session_id").is_none());
    }

    #[test]
    fn 舊對照表沒有_kind_與_session_id_照樣讀得進來() {
        let rig = make(default_profiles(), vec![Some(1_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-5", "ASN:5", 7, 1);
        write_store(&rig.store, 5, &row("5", "pi", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert_eq!(rig.svc.list().len(), 1, "舊檔的 pi 照舊認回來、列在終端面板");
        let text = std::fs::read_to_string(&rig.store).unwrap();
        assert!(!text.contains("\"kind\"") && !text.contains("session_id"), "終端面板開的不多寫新欄位：{text}");
    }

    #[test]
    fn 夥伴視窗算_asn_開的_但不進終端面板_也不能讀畫面送字改名() {
        let rig = make(default_profiles(), vec![]);
        let (id, _) = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("s1"))).unwrap();
        assert_eq!(rig.svc.own_gui_pids(), vec![42], "切前景／背景認得它");
        assert_eq!(rig.svc.own_gui_windows(), vec![(42, 1000)], "判斷 ASN 開的：GUI 與建立時間");
        assert!(rig.svc.list().is_empty(), "這一階段不列進終端面板");
        let before = rig.runner.args().len();
        assert!(rig.svc.read(&id, 10).is_err());
        assert!(rig.svc.confirm_send(&id, "x", true).is_err());
        assert!(rig.svc.status(&id).is_err());
        assert!(rig.svc.rename(&id, "改").is_err());
        assert!(rig.svc.stop(&id).is_err(), "也不能從終端面板關");
        assert_eq!(rig.runner.args().len(), before, "拒絕時不下任何 cli");
        assert!(rig.runner.killed().is_empty());
    }

    fn count_starts(r: &FakeRunner) -> usize {
        r.args().iter().filter(|a| a.first().map(String::as_str) == Some("start")).count()
    }

    #[test]
    fn 開窗點_還沒啟動就失敗是_not_started_可以走退路() {
        use super::super::win_term::WinOpenError;
        // 找不到 WezTerm
        let dir = tempfile::tempdir().unwrap();
        let fs = FakeFs { files: Rc::new(RefCell::new(HashSet::new())) };
        let runner = FakeRunner { inner: Rc::new(fake_inner(vec![], "[]".into(), String::new())) };
        let svc = TermService::without_wezterm(dir.path().join("wezterm-terms.json"), "H".into(), runner.clone(), fs);
        assert!(matches!(svc.start_window(dir.path(), &claude_spec(None)), Err(WinOpenError::NotStarted(_))));
        // 執行檔起不來
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.spawn_fail.borrow_mut() = true;
        assert!(matches!(rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(None)), Err(WinOpenError::NotStarted(_))));
        // 資料夾不存在
        assert!(matches!(rig.svc.start_window(Path::new("Z:/ASN-不存在-xyz"), &claude_spec(None)), Err(WinOpenError::NotStarted(_))));
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn 開窗點_已啟動之後各步驟失敗是_started_不走退路_只開過一次() {
        use super::super::win_term::WinOpenError;
        // 設不了標題，而且收不掉（建立時間不符）
        let rig = make(default_profiles(), vec![Some(1_000), Some(2_000)]);
        *rig.runner.inner.fail_substr.borrow_mut() = Some("set-tab-title".into());
        let e = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("s1"))).unwrap_err();
        assert!(matches!(&e, WinOpenError::Started(m) if m.contains("無法設定終端標題") && m.contains("結束剛啟動的視窗也失敗")), "{e:?}");
        assert!(rig.runner.killed().is_empty(), "建立時間不符就不結束");
        assert_eq!(count_starts(&rig.runner), 1);
        assert!(rig.svc.own_gui_pids().is_empty());
        // 讀不到窗格
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.fail_substr.borrow_mut() = Some("list".into());
        assert!(matches!(rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(None)), Err(WinOpenError::Started(_))));
        assert_eq!(rig.runner.killed(), vec![42], "建立時間相符的才結束");
        // 視窗裡沒有窗格
        let rig = make(default_profiles(), vec![]);
        *rig.runner.inner.list_json.borrow_mut() = "[]".into();
        assert!(matches!(rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(None)), Err(WinOpenError::Started(_))));
        assert_eq!(count_starts(&rig.runner), 1);
    }

    #[test]
    fn 開窗點_已啟動之後對照表寫不進去也是_started() {
        use super::super::win_term::WinOpenError;
        let rig = make(default_profiles(), vec![]);
        // 編號配好之後才把對照表檔換成資料夾：開視窗後的寫入會失敗
        let svc = &rig.svc;
        let store = rig.store.clone();
        *rig.runner.inner.on_list.borrow_mut() = Some(Box::new(move || {
            let _ = std::fs::remove_file(&store);
            let _ = std::fs::create_dir_all(store.join("擋住"));
        }));
        let e = svc.start_window(Path::new(&rig.cwd), &claude_spec(None)).unwrap_err();
        assert!(matches!(&e, WinOpenError::Started(m) if m.contains("對照表寫入失敗")), "{e:?}");
        assert_eq!(count_starts(&rig.runner), 1);
    }

    /// 建不起視窗的組合：log 寫那句、sock 一開始不存在、GUI 每次啟動後都量得到建立時間、之後量不到（已退出）。設定檔放在暫存資料夾
    fn no_window_rig(started: Vec<Option<u64>>) -> (Rig, PathBuf, TermService<FakeRunner, FakeFs>) {
        let rig = make(default_profiles(), vec![]);
        rig.files.borrow_mut().remove(&sock());
        LOG_TEXTS.with(|m| m.borrow_mut().insert(PathBuf::from("H/.local/share/wezterm/wezterm-gui.exe-log-42.txt"), "ERROR  Failed to create window: The OpenGL implementation is too old
".into()));
        rig.runner.inner.pid_started.borrow_mut().insert(42, started);
        let cfg = rig._dir.path().join("cfg.lua");
        let mut svc = TermService::fixed(
            WezTermDir { gui: "W/wezterm-gui.exe".into(), cli: "W/wezterm.exe".into() },
            cfg.clone(),
            rig.store.clone(),
            rig.home.clone(),
            rig.runner.clone(),
            FakeFs { files: rig.files.clone() },
        );
        svc.set_hold_config(true);
        (rig, cfg, svc)
    }

    #[test]
    fn 建不起視窗_換_webgpu_備援設定再開一次_第二次成功就用它() {
        let (rig, cfg, svc) = no_window_rig(vec![Some(1_000), None, Some(1_000)]);
        let files = rig.files.clone();
        *rig.runner.inner.on_spawn.borrow_mut() = Some(Box::new(move |n| {
            if n == 2 {
                files.borrow_mut().insert(sock());
            }
        }));
        let (_, gui) = svc.start_window(Path::new(&rig.cwd), &claude_spec(None)).unwrap();
        assert_eq!(gui, 42);
        assert_eq!(count_starts(&rig.runner), 2, "第一次建不起視窗、第二次換設定");
        let cfgs: Vec<String> = rig.runner.inner.calls.borrow().iter().filter(|(a, _)| a.first().map(|s| s == "start").unwrap_or(false)).map(|(_, e)| e.get("WEZTERM_CONFIG_FILE").cloned().unwrap_or_default()).collect();
        assert_eq!(cfgs[0], cfg.to_string_lossy());
        let alt = cfg.with_file_name("cfg-webgpu.lua");
        assert_eq!(cfgs[1], alt.to_string_lossy(), "第二次用備援設定檔");
        assert_eq!(std::fs::read_to_string(&alt).unwrap(), with_webgpu(ISOLATED_CONFIG));
        assert!(!cfg.exists(), "使用者那份（主設定）不被這條路徑碰");
        assert!(rig.runner.killed().is_empty(), "退出的程序不再結束");
    }

    #[test]
    fn 通訊檔先出現_之後才崩潰_也換_webgpu_備援再開一次() {
        // 工作機實測（#595）：GUI 先建好通訊檔、之後才報 OpenGL 建不起視窗而退出
        wezterm::OBSERVE_TICKS.with(|c| c.set(wezterm::full_observe_ticks()));
        let mut started = vec![Some(1_000), Some(1_000), None]; // 第一次：剛開、第一次核對還在、第二次已退出
        started.push(Some(1_000)); // 第二次：剛開
        started.extend(vec![Some(1_000); 10]); // 活過整段觀察
        let (rig, cfg, svc) = no_window_rig(started);
        let files = rig.files.clone();
        *rig.runner.inner.on_spawn.borrow_mut() = Some(Box::new(move |_| {
            files.borrow_mut().insert(sock());
        }));
        let (_, gui) = svc.start_window(Path::new(&rig.cwd), &claude_spec(None)).unwrap();
        assert_eq!(gui, 42);
        assert_eq!(count_starts(&rig.runner), 2);
        assert!(cfg.with_file_name("cfg-webgpu.lua").exists(), "第二次用備援設定檔");
    }

    #[test]
    fn 備援設定從隔離設定產生_只多一個_front_end() {
        assert_eq!(with_webgpu(ISOLATED_CONFIG), "return { exit_behavior = \"Hold\", front_end = \"WebGpu\" }\n");
        assert_eq!(with_webgpu(LEGACY_CONFIG), "return { front_end = \"WebGpu\" }\n");
        // 隔離設定以後加了別的項目，備援設定要一起有（拿掉 front_end 就等於原本那份）
        let future = "return { exit_behavior = \"Hold\", enable_tab_bar = false }\n";
        assert_eq!(with_webgpu(future).replace(", front_end = \"WebGpu\"", ""), future);
    }

    #[test]
    fn 建不起視窗_備援也不行_是_not_started_可以退到原生主控台() {
        use super::super::win_term::WinOpenError;
        let (rig, _, svc) = no_window_rig(vec![Some(1_000), None, Some(1_000), None]);
        let e = svc.start_window(Path::new(&rig.cwd), &claude_spec(None)).unwrap_err();
        assert!(matches!(&e, WinOpenError::NotStarted(m) if m == wezterm::NO_WINDOW_MSG), "{e:?}");
        assert_eq!(count_starts(&rig.runner), 2, "最多重試一次，不無限重開");
        assert!(rig.svc.own_gui_pids().is_empty() && svc.own_gui_pids().is_empty() && svc.list().is_empty(), "沒有登記任何視窗");
    }

    #[test]
    fn 開窗點只收_claude_與_window_資料夾要存在() {
        let rig = make(default_profiles(), vec![]);
        let mut bad = claude_spec(None);
        bad.kind = "agy";
        assert!(rig.svc.start_window(Path::new(&rig.cwd), &bad).is_err());
        assert!(matches!(rig.svc.start_window(Path::new("Z:/ASN-不存在-xyz"), &claude_spec(None)), Err(super::super::win_term::WinOpenError::NotStarted(m)) if m.contains("不存在")));
        let mut empty = claude_spec(None);
        empty.argv.clear();
        assert!(rig.svc.start_window(Path::new(&rig.cwd), &empty).is_err());
        assert!(rig.runner.args().iter().all(|a| a.first().map(String::as_str) != Some("start")), "沒通過就不開視窗");
    }

    #[test]
    fn 收掉夥伴視窗_建立時間相符才關_不符就不動且留在表上_不認得的不關() {
        // 相符：關掉、從表上拿掉
        let rig = make(default_profiles(), vec![Some(1_000), Some(1_000)]);
        rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("s1"))).unwrap();
        rig.svc.stop_gui(42).unwrap();
        assert_eq!(rig.runner.killed(), vec![42]);
        assert!(rig.svc.own_gui_pids().is_empty());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert!(v["terms"].as_array().unwrap().is_empty(), "對照表也拿掉");
        // 不符：編號已經是別的程序，不關、留在表上
        let rig = make(default_profiles(), vec![Some(1_000), Some(2_000)]);
        rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("s1"))).unwrap();
        assert!(rig.svc.stop_gui(42).unwrap_err().contains("別的程序"));
        assert!(rig.runner.killed().is_empty(), "建立時間不符絕不能關");
        assert_eq!(rig.svc.own_gui_pids(), vec![42]);
        // 不認得的 GUI
        assert!(rig.svc.stop_gui(77).is_err());
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn asn_重開後_claude_視窗_對得上就認回來_帶回_kind_與_session_id() {
        let mut rig = make(default_profiles(), vec![Some(1_000)]);
        rig.svc.set_hold_config(true); // 開關開著才認領夥伴視窗的列
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-6", "ASN:6 小乙", 7, 1);
        write_store(&rig.store, 6, &row("6", "claude", "1000", r#","kind":"claude","session_id":"s9""#));
        rig.svc.reclaim().unwrap();
        assert_eq!(rig.svc.own_gui_windows(), vec![(42, 1000)], "認回來的照樣算 ASN 開的");
        assert!(rig.svc.list().is_empty(), "認回來也不進終端面板");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        assert_eq!((v["terms"][0]["kind"].as_str(), v["terms"][0]["session_id"].as_str()), (Some("claude"), Some("s9")));
        // 建立時間對不上：不認、不關
        let mut rig = make(default_profiles(), vec![Some(2_000)]);
        rig.svc.set_hold_config(true);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-6", "ASN:6", 7, 1);
        write_store(&rig.store, 6, &row("6", "claude", "1000", r#","kind":"claude""#));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.own_gui_windows().is_empty());
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn 開關關著_夥伴視窗的列不認領_留在檔案裡_不下_cli_pi_的列照舊認() {
        let rig = make(default_profiles(), vec![Some(1_000), Some(1_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-6", "ASN:6 小乙", 7, 1);
        let claude = row("5", "claude", "1000", r#","kind":"claude","session_id":"s9""#);
        write_store(&rig.store, 7, &format!("{claude},{}", row("6", "pi", "1000", "")));
        rig.svc.reclaim().unwrap();
        assert_eq!(rig.svc.own_gui_windows().len(), 1, "只有 pi 的列被認回，claude 列不認領");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
        let ids: Vec<&str> = v["terms"].as_array().unwrap().iter().filter_map(|t| t["id"].as_str()).collect();
        assert!(ids.contains(&"5"), "claude 列 parked＝留在檔案裡：{ids:?}");
        assert_eq!(rig.svc.list().len(), 1, "pi 的列照舊認回來（0.1.113 的行為）");
        assert!(rig.runner.killed().is_empty());
    }

    #[test]
    fn 經_pi_只開得了_pi_資料夾要存在() {
        let rig = make(default_profiles(), vec![]);
        let env = BTreeMap::new();
        let not_pi: Vec<String> = ["cmd.exe", "/c", "echo"].iter().map(|s| s.to_string()).collect();
        assert!(rig.svc.start_pi(Path::new(&rig.cwd), &not_pi, &env).unwrap_err().contains("不是 pi"));
        assert!(rig.svc.start_pi(Path::new(&rig.cwd), &[], &env).is_err());
        let pi: Vec<String> = vec!["pi".into()];
        assert!(rig.svc.start_pi(Path::new("Z:/ASN-不存在-xyz"), &pi, &env).unwrap_err().contains("不存在"));
        assert!(rig.svc.list().is_empty());
        assert!(rig.runner.args().iter().all(|a| a.first().map(String::as_str) != Some("start")), "沒通過就不開視窗");
    }

    #[test]
    fn asn_重開後_pi_的自帶終端_對得上就認回來_對不上就不認也不關() {
        // 認回來：標記與建立時間都對
        let rig = make(default_profiles(), vec![Some(1_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-5", "ASN:5", 7, 1);
        write_store(&rig.store, 5, &row("5", "pi", "1000", r#","cwd":"D:/proj""#));
        rig.svc.reclaim().unwrap();
        let listed = rig.svc.list();
        assert_eq!((listed.len(), listed[0].profile.as_str()), (1, "pi"));
        assert_eq!(rig.svc.own_gui_pids(), vec![42], "認回來的照樣能切前後景");
        // 認不回來：建立時間對不上（程序編號可能已經是別人的）
        let rig = make(default_profiles(), vec![Some(2_000)]);
        *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-5", "ASN:5", 7, 1);
        write_store(&rig.store, 5, &row("5", "pi", "1000", ""));
        rig.svc.reclaim().unwrap();
        assert!(rig.svc.list().is_empty());
        assert!(rig.svc.own_gui_pids().is_empty(), "認不回來就不算 ASN 開的：不能切（照實說），也不當成使用者的去動它");
        assert!(rig.runner.killed().is_empty(), "也不能因此關掉它");
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

    fn wezterm_file_url(canon: &Path) -> String {
        // Windows 的 canonicalize 會帶 \\?\ 前綴；WezTerm 實際回報的是 file:///C:/…/（真機核對過），所以先拿掉
        let s = canon.to_string_lossy();
        let p = s.trim_start_matches(r"\\?\").replace('\\', "/");
        if p.starts_with('/') {
            format!("file://{p}")
        } else {
            format!("file:///{p}")
        }
    }

    fn adopt_pane_json(pane_id: u64, title: &str, cwd: &str, active: bool) -> String {
        format!(
            r#"[{{"pane_id":{pane_id},"tab_id":1,"is_active":{active},"title":"{title}","cwd":"{cwd}","cursor_x":1,"cursor_y":2}}]"#,
            active = if active { "true" } else { "false" }
        )
    }

    fn install_gui_sock(home: &Path, pid: u32, files: &Rc<RefCell<HashSet<PathBuf>>>) {
        let guidir = home.join(".local").join("share").join("wezterm");
        std::fs::create_dir_all(&guidir).unwrap();
        std::fs::write(guidir.join(format!("gui-sock-{pid}")), b"").unwrap();
        files.borrow_mut().insert(wezterm::sock_path(home, pid));
    }

    fn make_adopt(pid: u32, pane_id: u64, title: &str, active: bool) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let store = dir.path().join("wezterm-terms.json");
        let canon = canonical_launch_cwd(&dir.path().to_string_lossy()).unwrap();
        let cwd = canon.to_string_lossy().into_owned();
        let cwd_url = wezterm_file_url(&canon);
        let list_json = adopt_pane_json(pane_id, title, &cwd_url, active);
        let config = LaunchConfig {
            profiles: default_profiles(),
            cwd_allow: vec![canon],
            max_per_hour: 6,
        };
        let files = Rc::new(RefCell::new(HashSet::new()));
        install_gui_sock(&home, pid, &files);
        let fs = FakeFs { files: files.clone() };
        let runner = FakeRunner {
            inner: Rc::new(fake_inner(vec![Some(1_000)], list_json, String::new())),
        };
        let wdir = WezTermDir {
            gui: PathBuf::from("W/wezterm-gui.exe"),
            cli: PathBuf::from("W/wezterm.exe"),
        };
        files.borrow_mut().insert(wdir.gui.clone());
        files.borrow_mut().insert(wdir.cli.clone());
        let svc = TermService::fixed(wdir, dir.path().join("wezterm-term.lua"), store.clone(), home.clone(), runner.clone(), fs);
        *svc.test_launch_config.lock().unwrap() = Some(config.clone());
        Rig {
            _dir: dir,
            home,
            cwd,
            config,
            svc,
            runner,
            files,
            store,
        }
    }

    #[test]
    fn 接手_只列已知_cli_建立時間不符_窗格重用_使用者閒置不足_拒絕() {
        let rig = make_adopt(100, 9, "grok.exe", false);
        let cwd_url = wezterm_file_url(Path::new(&rig.cwd));
        assert!(rig.svc.adopt(100, 9, 2_000, &rig.config).unwrap_err().contains("建立時間"));
        let cands = rig.svc.adopt_candidates(&rig.config).unwrap();
        assert!(cands.iter().any(|c| c.profile == "grok" && c.cwd_authorized));
        assert!(!cands.iter().any(|c| c.profile == "cmd"));
        let id = rig.svc.adopt(100, 9, 1_000, &rig.config).unwrap();
        assert!(rig.svc.list()[0].adopted);
        rig.svc.unlock_adopted(&id, false, true).unwrap();
        *rig.runner.inner.list_clients_json.borrow_mut() = list_clients_json_with_idle(4, 9);
        let busy = rig.svc.confirm_send(&id, "x", false).unwrap_err();
        assert!(busy.contains("焦點與輸入都在這個窗格"), "{busy}");
        *rig.runner.inner.list_clients_json.borrow_mut() = list_clients_json_with_idle(4, 99);
        assert!(rig.svc.confirm_send(&id, "x", false).unwrap_err().contains("剛操作過 WezTerm"));
        *rig.runner.inner.list_clients_json.borrow_mut() = list_clients_json_with_idle(6, 99);
        assert!(rig.svc.confirm_send(&id, "x", false).is_ok());
        *rig.runner.inner.list_clients_json.borrow_mut() = list_clients_json_with_idle(5, 9);
        assert!(rig.svc.confirm_send(&id, "y", false).is_ok());
        *rig.runner.inner.list_json.borrow_mut() = adopt_pane_json(99, "grok.exe", &cwd_url, false);
        assert!(rig.svc.read(&id, 5).unwrap_err().contains("窗格"));
    }

    #[test]
    fn 接手_list_clients_失敗或缺欄位_寫入一律拒絕() {
        let rig = make_adopt(100, 9, "grok.exe", false);
        let id = rig.svc.adopt(100, 9, 1_000, &rig.config).unwrap();
        rig.svc.unlock_adopted(&id, true, true).unwrap();
        *rig.runner.inner.fail_substr.borrow_mut() = Some("list-clients".into());
        assert!(rig.svc.confirm_send(&id, "x", false).unwrap_err().contains("list-clients"));
        *rig.runner.inner.fail_substr.borrow_mut() = None;
        *rig.runner.inner.list_clients_json.borrow_mut() = "[]".into();
        assert!(rig.svc.answer(&id, "trust_dialog", 1).unwrap_err().contains("client"));
        *rig.runner.inner.list_clients_json.borrow_mut() = r#"[{"pid":1}]"#.into();
        assert!(rig.svc.confirm_send(&id, "x", false).unwrap_err().contains("idle_time"));
        *rig.runner.inner.list_clients_json.borrow_mut() = "not json".into();
        assert!(rig.svc.confirm_send(&id, "x", false).unwrap_err().contains("解析"));
    }

    #[test]
    fn 接手_解除不殺程序_改名拒絕_重啟清空_解鎖只有本機入口() {
        let rig = make_adopt(100, 9, "grok.exe", false);
        let id = rig.svc.adopt(100, 9, 1_000, &rig.config).unwrap();
        assert!(rig.svc.rename(&id, "x").unwrap_err().contains("改名"));
        rig.svc.stop(&id).unwrap();
        assert!(rig.svc.list().is_empty());
        assert!(rig.runner.killed().is_empty(), "解除接手不得 kill");
        let src = include_str!("term.rs");
        let lib = include_str!("../lib.rs");
        assert!(lib.contains("term_adopt_unlock"));
        assert!(!src.split("mod tests").next().unwrap().contains(".unlock_adopted("));
        assert!(!rig.store.exists(), "接手前不應有對照表檔");
        let id2 = rig.svc.adopt(100, 9, 1_000, &rig.config).unwrap();
        assert!(!rig.store.exists(), "接手不得寫對照表檔");
        rig.svc.unlock_adopted(&id2, true, false).unwrap();
        assert!(rig.svc.confirm_send(&id2, "hi", false).unwrap_err().contains("代送"));
        let svc2 = TermService::without_wezterm(rig.store.clone(), rig.home.clone(), rig.runner.clone(), FakeFs { files: rig.files.clone() });
        assert!(svc2.list().is_empty(), "新服務記憶體清空");
    }

    #[test]
    fn 接手_版本不同與_unknown_行程() {
        let rig = make_adopt(100, 9, "grok.exe", false);
        let cwd_url = wezterm_file_url(Path::new(&rig.cwd));
        *rig.runner.inner.version_out.borrow_mut() = "wezterm 20990101-xxxx".into();
        let c = rig.svc.adopt_candidates(&rig.config).unwrap();
        assert!(!c.is_empty());
        assert!(!c[0].version_verified);
        assert!(!c[0].version_note.is_empty());
        let id = rig.svc.adopt(100, 9, 1_000, &rig.config).unwrap();
        rig.svc.unlock_adopted(&id, true, true).unwrap();
        assert!(rig.svc.answer(&id, "trust_dialog", 1).unwrap_err().contains("版本"));
        *rig.runner.inner.list_json.borrow_mut() = adopt_pane_json(9, "vim.exe", &cwd_url, false);
        assert_eq!(rig.svc.status(&id).unwrap().state, "unknown");
        assert!(rig.svc.answer(&id, "menu", 1).unwrap_err().contains("CLI"));
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

    /// 真機驗收（#313）：隔離 WezTerm ＋ 真的 grok 當「使用者自己開的窗格」。不呼叫模型、不登入。
    /// ASN_WEZTERM_DIR=<WezTerm 資料夾> ASN_LIVE_GROK=<grok.exe> cargo test --lib launch::term::tests::live_adopt -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_adopt_existing_window() {
        use crate::nowin::NoWindow;
        let grok = std::env::var("ASN_LIVE_GROK").expect("請設定 ASN_LIVE_GROK");
        let dir = wezterm::locate(&wezterm::RealFs).expect("請設定 ASN_WEZTERM_DIR");
        let tmp = std::env::temp_dir().join(format!("asn-adopt-live-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = canonical_launch_cwd(&tmp.to_string_lossy()).unwrap();
        let cfg_file = tmp.join("w.lua");
        std::fs::write(&cfg_file, "return {}").unwrap();
        let home = crate::identity::home_dir();
        // 1) 用 WezTerm 自己的命令列開一個「使用者自己開的」視窗（不經過 ASN 的啟動流程）
        let mut gui = std::process::Command::new(&dir.gui).no_window()
            .args(["--config-file", &cfg_file.to_string_lossy(), "start", "--always-new-process", "--cwd", &tmp.to_string_lossy(), "--", &grok])
            .spawn()
            .expect("開使用者視窗");
        let gui_pid = gui.id();
        std::thread::sleep(Duration::from_millis(4000));
        let mut profiles = HashMap::new();
        profiles.insert("grok".to_string(), profile(&grok, vec!["agent".into(), "stdio".into()]));
        let config = LaunchConfig { profiles, cwd_allow: vec![canon.clone()], max_per_hour: 6 };
        let svc = TermService::fixed(dir.clone(), cfg_file.clone(), tmp.join("wezterm-terms.json"), home.clone(), wezterm::RealRunner, wezterm::RealFs);
        *svc.test_launch_config.lock().unwrap() = Some(config.clone());   // 寫入前核驗讀的是服務自己的啟動設定，測試要把允許清單塞進去
        let result = (|| -> Result<(), String> {
            let cands = svc.adopt_candidates(&config)?;
            println!("候選：{cands:#?}");
            let c = cands.iter().find(|c| c.pid == gui_pid).ok_or("清單裡沒有我開的那個視窗")?.clone();
            assert_eq!(c.profile, "grok");
            assert!(c.cwd_authorized, "資料夾在授權清單內應為 true：{}", c.cwd_raw);
            assert!(c.version_verified, "隨安裝檔的 20240203 應判為已驗證：{}", c.version_note);
            assert!(!cands.iter().any(|x| x.profile == "cmd"), "一般命令列不列出");
            // 2) 接手：只存記憶體
            let id = svc.adopt(c.pid, c.pane_id, c.started_ms, &config)?;
            assert!(svc.list().iter().any(|t| t.id == id && t.adopted));
            assert!(!tmp.join("wezterm-terms.json").exists(), "接手不寫對照表檔");
            // 3) 唯讀：能讀、能看狀態；不解鎖就不能代答／代送
            let st = svc.status(&id)?;
            println!("狀態：{} {} prompt={:?}", st.state, st.reason, st.prompt);
            assert_eq!(st.state, "waiting_user", "新資料夾第一次開 grok 應是信任提問");
            let screen = svc.read(&id, 30)?;
            assert!(screen.contains("Do you trust"), "能讀到畫面");
            assert!(svc.answer(&id, "trust_dialog", 1).is_err(), "沒解鎖不能代答");
            assert!(svc.confirm_send(&id, "x", false).is_err(), "沒解鎖不能代送");
            // 4) 本機解鎖代答；剛開 grok 時 list-clients 的 idle_time 通常 < 5 秒 → 必須被擋
            svc.unlock_adopted(&id, true, false)?;
            // 閒置時間從視窗開起來算：剛開不到 5 秒會被擋（畫面完全不變），超過就放行（這時 y 已經送進去、提問會消失）——兩種都是對的，看時間
            let mut answered = false;
            match svc.answer(&id, "trust_dialog", 1) {
                Err(e) => {
                    println!("使用者閒置不足被擋：{e}");
                    assert_eq!(svc.read(&id, 30)?, screen, "被擋時畫面完全沒變");
                }
                Ok(a) => {
                    println!("閒置已超過 5 秒，放行代答：{}", a.keys);
                    answered = true;
                }
            }
            // 5) 探針：另開第二個 WezTerm 視窗搶走焦點（使用者去用別的視窗），再「不經過 ASN 的核驗」直接往 grok 那格送 y，看 grok 處理不處理
            let mut other = std::process::Command::new(&dir.gui).no_window()
                .args(["--config-file", &cfg_file.to_string_lossy(), "start", "--always-new-process", "--cwd", &tmp.to_string_lossy(), "--", "cmd.exe"])
                .spawn()
                .map_err(|e| e.to_string())?;
            let other_pid = other.id();
            std::thread::sleep(Duration::from_millis(3500));
            let sock = wezterm::sock_path(&home, gui_pid);
            let wz = wezterm::WezTerm::with_default_home(dir.clone(), cfg_file.clone(), &wezterm::RealRunner, &wezterm::RealFs);
            let panes = wz.list(&sock)?;
            println!("探針：grok 那格 is_active={}（它所在的視窗現在沒有焦點）", panes.iter().find(|p| p.pane_id == c.pane_id).map(|p| p.is_active).unwrap_or(false));
            for (name, s) in [("第一個視窗", sock.clone()), ("第二個視窗", wezterm::sock_path(&home, other_pid))] {
                let o = std::process::Command::new(&dir.cli).no_window().env("WEZTERM_UNIX_SOCKET", &s).args(["--config-file", &cfg_file.to_string_lossy(), "cli", "list-clients", "--format", "json"]).output().map_err(|e| e.to_string())?;
                println!("探針：{name} list-clients：{}", String::from_utf8_lossy(&o.stdout).split_whitespace().collect::<Vec<_>>().join(" "));
            }
            if answered {
                std::thread::sleep(Duration::from_millis(3000));
            } else {
                wz.send_bytes(&sock, c.pane_id, "y")?;
                std::thread::sleep(Duration::from_millis(3000));
            }
            let still = svc.read(&id, 30)?.contains("Do you trust the contents");
            println!("探針：視窗沒有焦點時送 y（或已代答）之後，提問還在嗎＝{still}");
            let _ = std::process::Command::new("taskkill").no_window().args(["/T", "/F", "/PID", &other_pid.to_string()]).output();
            let _ = other.wait();
            if still {
                return Err("視窗沒有焦點時送鍵 grok 也沒處理".to_string());
            }
            // 6) 結束＝解除接手：視窗與程序都還活著
            svc.stop(&id)?;
            assert!(svc.list().iter().all(|t| t.id != id), "已解除接手");
            assert!(gui.try_wait().map_err(|e| e.to_string())?.is_none(), "解除接手不能關掉使用者的視窗");
            // 7) 重啟（新服務）：接手清空
            let svc2 = TermService::fixed(dir.clone(), cfg_file.clone(), tmp.join("wezterm-terms.json"), home.clone(), wezterm::RealRunner, wezterm::RealFs);
            assert!(svc2.list().is_empty(), "重啟後不認回接手");
            Ok(())
        })();
        // 只結束自己開的那個視窗（記下的程序編號）
        let _ = std::process::Command::new("taskkill").no_window().args(["/T", "/F", "/PID", &gui_pid.to_string()]).output();
        let _ = gui.wait();
        let _ = std::fs::remove_dir_all(&tmp);
        result.expect("真機驗收失敗");
    }

    /// B2b：開在共用 mux 裡的行為。開關預設關（其餘測試全部是關著跑的），這裡才打開
    mod mux_mode {
        use super::*;
        use crate::launch::mux;

        const MUX_PID: u32 = 4000;

        /// 開著 mux 模式的 rig：mux 檔案放在暫存資料夾、pid 檔記著一個建立時間對得上的 mux、連線檔「存在」，
        /// `cli spawn` 印出窗格 9
        fn mux_rig() -> (Rig, mux::MuxPaths) {
            let mut rig = make(default_profiles(), vec![]);
            let base = rig._dir.path().join("lad");
            let paths = mux::paths(&base).unwrap();
            std::fs::create_dir_all(&paths.dir).unwrap();
            std::fs::write(&paths.pid, format!("{MUX_PID} 1000")).unwrap();
            rig.files.borrow_mut().insert(paths.sock.clone());
            rig.svc.set_use_mux(true);
            rig.svc.set_mux_base(base);
            *rig.runner.inner.spawn_out.borrow_mut() = "9\n".into();
            *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-1", "ASN:1", 9, 0);
            (rig, paths)
        }

        fn pi_argv() -> Vec<String> {
            ["pi", "-e", "ext.ts", "--model", "M"].iter().map(|s| s.to_string()).collect()
        }

        /// 所有 cli 呼叫（含 mux 自己的試連），參數開頭是 "cli"
        fn cli_calls(r: &FakeRunner) -> Vec<(Vec<String>, BTreeMap<String, String>)> {
            r.inner.calls.borrow().iter().filter(|(a, _)| a.first().map(String::as_str) == Some("cli")).cloned().collect()
        }

        fn sub_of(args: &[String]) -> Vec<&str> {
            args.iter().map(String::as_str).filter(|a| *a != "--no-auto-start").collect()
        }

        fn count_sub(r: &FakeRunner, sub: &str) -> usize {
            cli_calls(r).iter().filter(|(a, _)| sub_of(a).get(1) == Some(&sub)).count()
        }

        #[test]
        fn 開_pi_只下一條_spawn_走_run_clean_環境只有給的加_socket_不起_gui() {
            let (rig, paths) = mux_rig();
            let env: BTreeMap<String, String> = [("ASN_PI_NAME".to_string(), "小皮".to_string()), ("PATH".to_string(), "C:/bin".to_string())].into();
            let (id, pid) = rig.svc.start_pi(Path::new(&rig.cwd), &pi_argv(), &env).unwrap();
            assert_eq!((id.as_str(), pid), ("1", MUX_PID), "回的是 mux 的編號");
            let clean = rig.runner.inner.clean_calls.borrow();
            assert_eq!(clean.len(), 1, "開窗格只有一條 cli（spawn），而且走 run_clean");
            let mut want: Vec<String> = ["cli", "--no-auto-start", "spawn", "--new-window", "--workspace", "asn-1", "--cwd"].iter().map(|s| s.to_string()).collect();
            want.push(rig.cwd.clone());
            want.push("--".into());
            want.extend(pi_argv());
            assert_eq!(clean[0].0, want);
            let mut want_env = env.clone();
            want_env.insert("WEZTERM_UNIX_SOCKET".into(), paths.sock.to_string_lossy().into_owned());
            assert_eq!(clean[0].1, want_env, "環境＝給的環境加 socket 位置，沒有設定檔路徑或其他東西");
            drop(clean);
            assert_eq!(count_sub(&rig.runner, "spawn"), 1);
            assert!(rig.runner.inner.calls.borrow().iter().all(|(a, _)| a.first().map(String::as_str) == Some("cli")), "沒有 wezterm-gui（start）也沒有別的啟動");
            assert!(started_args(&rig.runner).is_empty());
            let titles: Vec<_> = cli_calls(&rig.runner).into_iter().filter(|(a, _)| a.iter().any(|x| x == "set-tab-title")).collect();
            assert_eq!(titles[0].0, ["cli", "--no-auto-start", "set-tab-title", "--pane-id", "9", "ASN:1"]);
            assert_eq!(titles[0].1.get("WEZTERM_UNIX_SOCKET").map(String::as_str), Some(paths.sock.to_string_lossy().as_ref()));
            assert!(rig.runner.killed().is_empty());
            let listed = rig.svc.list();
            assert_eq!((listed[0].pid, listed[0].started_ms), (MUX_PID, Some(1000)));
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
            assert_eq!(v["terms"][0]["mux"], true);
            assert_eq!((v["terms"][0]["pid"].as_u64(), v["terms"][0]["pane_id"].as_u64()), (Some(u64::from(MUX_PID)), Some(9)));
        }

        #[test]
        fn 終端面板的_agy_在_mux_模式也只拿白名單環境() {
            let (rig, paths) = mux_rig();
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            let clean = rig.runner.inner.clean_calls.borrow();
            assert_eq!(clean.len(), 1);
            let mut want: BTreeMap<String, String> = crate::launch::config::child_env().into_iter().collect();
            want.insert("WEZTERM_UNIX_SOCKET".into(), paths.sock.to_string_lossy().into_owned());
            assert_eq!(clean[0].1, want);
            assert!(clean[0].0.ends_with(&["--".to_string(), "C:/bin/agy.exe".to_string()]));
        }

        #[test]
        fn 每條_cli_都帶_no_auto_start_與_mux_的_socket() {
            let (rig, paths) = mux_rig();
            let id = rig.svc.start("grok", &rig.cwd, &rig.config).unwrap();
            rig.svc.read(&id, 5).unwrap();
            rig.svc.rename(&id, "新名").unwrap();
            rig.svc.confirm_send(&id, "hi", true).unwrap();
            rig.svc.stop(&id).unwrap();
            let calls = cli_calls(&rig.runner);
            assert!(calls.len() >= 6);
            for (a, env) in &calls {
                assert_eq!(&a[..2], ["cli", "--no-auto-start"], "{a:?}");
                assert_eq!(env.get("WEZTERM_UNIX_SOCKET").map(String::as_str), Some(paths.sock.to_string_lossy().as_ref()), "{a:?}");
            }
        }

        #[test]
        fn mux_重新啟動過_舊窗格的操作一律拒絕_不對新_mux_下指令_列也移除() {
            let (rig, paths) = mux_rig();
            let a = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            let b = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            let before = cli_calls(&rig.runner).len();
            // mux 當掉後被重新起來：pid 檔換成另一個（建立時間不同）
            std::fs::write(&paths.pid, "4001 1000").unwrap(); // 新的 mux（另一個編號、活著）
            let e = rig.svc.read(&a, 5).unwrap_err();
            assert!(e.contains("重新啟動過"), "{e}");
            assert!(rig.svc.confirm_send(&b, "hi", true).unwrap_err().contains("重新啟動過"));
            assert_eq!(cli_calls(&rig.runner).len(), before, "不對新 mux 下任何指令（舊的窗格編號可能對到別的夥伴）");
            assert!(rig.svc.list().is_empty(), "兩列都移除了");
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
            assert!(v["terms"].as_array().unwrap().is_empty());
            // 關閉：視為已經關好，不下 kill-pane
            let c = {
                std::fs::write(&paths.pid, format!("{MUX_PID} 1000")).unwrap();
                rig.svc.start("agy", &rig.cwd, &rig.config).unwrap()
            };
            std::fs::write(&paths.pid, "4002 1000").unwrap();
            rig.svc.stop(&c).unwrap();
            assert_eq!(count_sub(&rig.runner, "kill-pane"), 0);
            assert!(rig.runner.killed().is_empty());
        }

        #[test]
        fn 開窗格的指令連起都起不來_是沒啟動_逾時才當已啟動() {
            let (rig, _) = mux_rig();
            *rig.runner.inner.clean_err.borrow_mut() = Some(format!("{} W/wezterm.exe：找不到檔案", wezterm::CANNOT_RUN));
            let e = rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &BTreeMap::new()).unwrap_err();
            assert!(matches!(e, crate::launch::win_term::WinOpenError::NotStarted(_)), "窗格一定沒開：可以退到原生主控台");
            *rig.runner.inner.clean_err.borrow_mut() = Some("WezTerm 指令逾時（15 秒），已結束該子行程".into());
            let e = rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &BTreeMap::new()).unwrap_err();
            assert!(matches!(e, crate::launch::win_term::WinOpenError::Started(_)), "窗格可能已經開了：不退路");
        }

        #[test]
        fn 關閉只關窗格_不結束任何程序_也不列進_gui_清單() {
            let (rig, _) = mux_rig();
            let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            assert!(rig.svc.own_gui_pids().is_empty(), "mux 的編號不是 GUI，不能被切前景／背景或結束");
            assert!(rig.svc.own_gui_windows().is_empty());
            assert!(rig.svc.stop_gui(MUX_PID).unwrap_err().contains("不是 ASN 開的"));
            assert!(rig.runner.killed().is_empty());
            rig.svc.stop(&id).unwrap();
            let kills: Vec<_> = cli_calls(&rig.runner).into_iter().filter(|(a, _)| a.iter().any(|x| x == "kill-pane")).collect();
            assert_eq!(kills.len(), 1);
            assert_eq!(kills[0].0, ["cli", "--no-auto-start", "kill-pane", "--pane-id", "9"]);
            assert!(rig.runner.killed().is_empty(), "絕不 kill_tree（會把所有夥伴一起結束）");
            assert!(rig.svc.list().is_empty());
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
            assert!(v["terms"].as_array().unwrap().is_empty());
        }

        #[test]
        fn wezterm_stop_看到_mux_視窗一律拒絕且不動任何程序() {
            let (rig, paths) = mux_rig();
            let fs = FakeFs { files: rig.files.clone() };
            let dir = WezTermDir { gui: "W/wezterm-gui.exe".into(), cli: "W/wezterm.exe".into() };
            let w = WezTerm::new(dir, "cfg.lua".into(), "H".into(), &rig.runner, &fs);
            let win = Window { gui_pid: MUX_PID, sock: paths.sock, started_ms: Some(1000), mux: true };
            assert!(w.stop(&win).unwrap_err().contains("共用的終端服務"));
            assert!(rig.runner.killed().is_empty());
            // 對照：同樣的內容不是 mux 就會結束（證明拒絕來自 mux 旗標，不是別的條件）
            w.stop(&Window { mux: false, ..win }).unwrap();
            assert_eq!(rig.runner.killed(), vec![MUX_PID]);
        }

        #[test]
        fn 設標題失敗只關那個窗格_回已啟動() {
            let (rig, _) = mux_rig();
            *rig.runner.inner.fail_substr.borrow_mut() = Some("set-tab-title".into());
            let e = rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &BTreeMap::new()).unwrap_err();
            let crate::launch::win_term::WinOpenError::Started(m) = e else { panic!("窗格已經開了，應該是已啟動的失敗") };
            assert!(m.contains("無法設定終端標題"), "{m}");
            let kills: Vec<_> = cli_calls(&rig.runner).into_iter().filter(|(a, _)| a.iter().any(|x| x == "kill-pane")).collect();
            assert_eq!(kills.len(), 1, "只關剛開的那個窗格");
            assert_eq!(kills[0].0, ["cli", "--no-auto-start", "kill-pane", "--pane-id", "9"]);
            assert!(rig.runner.killed().is_empty());
            assert!(rig.svc.list().is_empty() && rig.svc.own_gui_pids().is_empty());
        }

        #[test]
        fn 開窗格回的不是編號_當作已啟動_不退路再開一份_也不關任何東西() {
            let (rig, paths) = mux_rig();
            *rig.runner.inner.spawn_out.borrow_mut() = "不是編號".into();
            let e = rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &BTreeMap::new()).unwrap_err();
            assert!(matches!(e, crate::launch::win_term::WinOpenError::Started(_)), "窗格可能其實開了：不能讓呼叫端退到原生主控台再開一份");
            assert_eq!(count_sub(&rig.runner, "kill-pane"), 0);
            // pid 檔對不上（不是 ASN 起的 mux）：不在裡面開
            std::fs::write(&paths.pid, format!("{MUX_PID} 777")).unwrap();
            *rig.runner.inner.spawn_out.borrow_mut() = "9".into();
            let e = rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &BTreeMap::new()).unwrap_err();
            assert!(matches!(e, crate::launch::win_term::WinOpenError::NotStarted(_)));
            assert_eq!(count_sub(&rig.runner, "spawn"), 1, "第二次沒有再 spawn");
        }

        /// 同一份對照表檔、同一組假執行器，另起一個服務（等於 ASN 重啟）
        fn restarted(rig: &Rig, mux_on: bool) -> TermService<FakeRunner, FakeFs> {
            let mut svc = TermService::fixed(
                WezTermDir { gui: "W/wezterm-gui.exe".into(), cli: "W/wezterm.exe".into() },
                "cfg.lua".into(),
                rig.store.clone(),
                rig.home.clone(),
                rig.runner.clone(),
                FakeFs { files: rig.files.clone() },
            );
            svc.set_use_mux(mux_on);
            svc.set_mux_base(rig.svc.mux_base.clone().unwrap());
            svc
        }

        #[test]
        fn 對照表寫出_mux_欄位_重啟後認回來() {
            let (rig, _) = mux_rig();
            let id = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            let svc2 = restarted(&rig, true);
            svc2.reclaim().unwrap();
            let listed = svc2.list();
            assert_eq!((listed[0].id.as_str(), listed[0].pid, listed[0].started_ms), (id.as_str(), MUX_PID, Some(1000)));
            assert!(svc2.own_gui_pids().is_empty(), "認回來的 mux 窗格照樣不是 GUI");
            svc2.stop(&id).unwrap();
            assert_eq!(count_sub(&rig.runner, "kill-pane"), 1);
            assert!(rig.runner.killed().is_empty());
        }

        #[test]
        fn 重啟認領_pid_檔對不上或窗格沒標記就不認() {
            // pid 檔記的 mux 不是這個建立時間：不認、不結束
            let (rig, paths) = mux_rig();
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            std::fs::write(&paths.pid, format!("{MUX_PID} 777")).unwrap();
            let svc2 = restarted(&rig, true);
            svc2.reclaim().unwrap();
            assert!(svc2.list().is_empty());
            assert!(rig.runner.killed().is_empty());

            // 窗格清單裡沒有 ASN 標記：不認
            let (rig, _) = mux_rig();
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            *rig.runner.inner.list_json.borrow_mut() = one_pane("default", "別人的", 9, 0);
            let svc2 = restarted(&rig, true);
            svc2.reclaim().unwrap();
            assert!(svc2.list().is_empty());
        }

        #[test]
        fn 重啟認領_開關沒開就不碰_列留著_打開後認得() {
            let (rig, _) = mux_rig();
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            let before = rig.runner.args().len();
            let svc2 = restarted(&rig, false);
            svc2.reclaim().unwrap();
            assert!(svc2.list().is_empty());
            assert_eq!(rig.runner.args().len(), before, "不下 cli");
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
            assert_eq!(v["terms"][0]["mux"], true, "列還在檔案裡");
            let svc3 = restarted(&rig, true);
            svc3.reclaim().unwrap();
            assert_eq!(svc3.list().len(), 1);
        }

        #[test]
        fn 舊列沒有_mux_欄_就算開關開著也照第_1_階段認領() {
            let (rig, _) = mux_rig();
            rig.files.borrow_mut().insert(sock());
            *rig.runner.inner.list_json.borrow_mut() = one_pane("asn-4", "ASN:4", 7, 1);
            write_store(&rig.store, 4, &row("4", "grok", "1000", ""));
            let svc2 = restarted(&rig, true);
            svc2.reclaim().unwrap();
            assert_eq!(svc2.list()[0].pid, 42);
            assert_eq!(svc2.own_gui_pids(), vec![42], "第 1 階段的視窗照舊算 GUI");
        }

        // ---- B2c：看畫面的 GUI、前台／背景、關閉、登錄檔

        /// 開一個 claude 夥伴視窗（在 mux 裡），回終端編號
        fn open_partner(rig: &Rig) -> String {
            let (id, pid) = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(Some("sid-1"))).unwrap();
            assert_eq!(pid, MUX_PID);
            id
        }

        /// 看畫面的 GUI 的啟動呼叫（參數開頭是 --config-file）
        fn view_spawns(r: &FakeRunner) -> Vec<(Vec<String>, BTreeMap<String, String>)> {
            r.inner.calls.borrow().iter().filter(|(a, _)| a.first().map(String::as_str) == Some("--config-file")).cloned().collect()
        }

        fn kill_panes(r: &FakeRunner) -> usize {
            count_sub(r, "kill-pane")
        }

        #[test]
        fn 看畫面_只起一個_gui_參數與白名單環境正確() {
            let (rig, paths) = mux_rig();
            let id = open_partner(&rig);
            rig.svc.view(&id).unwrap();
            let spawns = view_spawns(&rig.runner);
            assert_eq!(spawns.len(), 1);
            let want: Vec<String> = ["--config-file", paths.config.to_string_lossy().as_ref(), "connect", "asn", "--workspace", &format!("asn-{id}")].iter().map(|s| s.to_string()).collect();
            assert_eq!(spawns[0].0, want);
            let want_env: BTreeMap<String, String> = crate::launch::config::child_env().into_iter().collect();
            assert_eq!(spawns[0].1, want_env, "只給白名單環境");
            assert!(spawns[0].1.keys().all(|k| !k.to_ascii_uppercase().starts_with("WEZTERM_")), "不帶 WEZTERM_*（含 socket 位置）");
            assert!(paths.config.is_file(), "設定檔在（GUI 靠它找 asn 這個連線）");
            assert!(rig.svc.viewing(&id));
            assert!(rig.runner.killed().is_empty());
            assert_eq!(kill_panes(&rig.runner), 0);
        }

        #[test]
        fn 看畫面_舊版設定檔補成現在的內容_連不上時不自己起_mux() {
            let (rig, paths) = mux_rig();
            let id = open_partner(&rig);
            std::fs::write(&paths.config, "return { unix_domains = { { name = 'asn', socket_path = [[x]] } } }").unwrap();
            rig.svc.view(&id).unwrap();
            let cfg = std::fs::read_to_string(&paths.config).unwrap();
            assert_eq!(cfg, mux::config_text(&paths.sock));
            assert!(cfg.contains("no_serve_automatically = true"), "wezterm connect 不吃 --no-auto-start，要靠設定擋");
        }

        #[test]
        fn 守門_看畫面的檢查與登記正在開在同一次持鎖裡() {
            let src = include_str!("term.rs").replace("\r\n", "\n");
            let body = &src[src.find("    pub fn view(&self, id: &str) -> Result<(), String> {").unwrap()..src.find("    fn start_viewer(&self, id: &str)").unwrap()];
            let locked = &body[body.find("let mut g = self.inner.lock().unwrap();").unwrap()..body.find("if let Some(pid) = front {").unwrap()];
            assert!(locked.contains("starting: true"), "登記正在開要在同一次持鎖裡，不然兩個請求會各開一個 GUI");
            assert_eq!(body.matches("starting: true").count(), 1);
        }

        #[test]
        fn 看畫面_已經開著就不再開第二個() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            rig.svc.view(&id).unwrap();
            rig.svc.view(&id).unwrap();
            assert_eq!(view_spawns(&rig.runner).len(), 1, "還活著的 GUI 不重開");
            // 使用者自己把畫面關了（程序已經不在）：再看就開新的
            rig.runner.inner.pid_started.borrow_mut().insert(42, vec![None]);
            rig.svc.view(&id).unwrap();
            assert_eq!(view_spawns(&rig.runner).len(), 2);
        }

        #[test]
        fn 背景_只收看畫面的_gui_窗格與_mux_都不動() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            rig.svc.view(&id).unwrap();
            rig.svc.unview(&id).unwrap();
            assert_eq!(rig.runner.killed(), vec![42], "只結束看畫面的那個程序");
            assert!(!rig.runner.killed().contains(&MUX_PID));
            assert_eq!(kill_panes(&rig.runner), 0, "窗格照常跑");
            assert!(rig.svc.partner_in_mux((MUX_PID, 1000), "小乙").is_some(), "對照表的列還在");
            assert!(!rig.svc.viewing(&id));
            // 沒有畫面時的背景什麼都不做
            rig.svc.unview(&id).unwrap();
            assert_eq!(rig.runner.killed(), vec![42]);
        }

        #[test]
        fn 背景_程序編號被別的程序拿去用了就不結束() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            rig.svc.view(&id).unwrap();
            rig.runner.inner.pid_started.borrow_mut().insert(42, vec![Some(9_999)]);
            rig.svc.unview(&id).unwrap();
            assert!(rig.runner.killed().is_empty(), "建立時間對不上：不動");
        }

        #[test]
        fn 看畫面_剛起就結束_回固定的一句話_不影響窗格() {
            assert_eq!(VIEW_NO_DESKTOP, "這台電腦的桌面目前沒有人登入，開不了終端畫面；夥伴照常在背景執行");
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            // 第一次問建立時間是起來了（5000），下一次問就沒了
            rig.runner.inner.pid_started.borrow_mut().insert(42, vec![Some(5_000), None]);
            let e = rig.svc.view(&id).unwrap_err();
            assert_eq!(e, VIEW_NO_DESKTOP);
            assert!(!rig.svc.viewing(&id));
            assert!(rig.runner.killed().is_empty(), "已經結束的不用殺，更不碰 mux");
            assert_eq!(kill_panes(&rig.runner), 0, "夥伴照常在背景執行");
            assert!(rig.runner.inner.sleeps.borrow().iter().all(|d| d.as_millis() <= 200), "等待都走 runner.sleep，每次很短");
            // 沒卡在「正在起」：之後再看，起得來就開
            rig.svc.view(&id).unwrap();
            assert!(rig.svc.viewing(&id));
            // 撐過判斷時間就算成功，不會一直等下去（3 秒／0.2 秒＝15 次）
            assert!(rig.runner.inner.sleeps.borrow().len() <= 16);
        }

        #[test]
        fn 看畫面_視窗冒出來但不到一秒就崩潰_回開不了_不算成功() {
            // B4 工作機實測：桌面沒人登入時 GUI 先冒出視窗，約 0.3 秒後崩潰
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            *rig.runner.inner.window_up.borrow_mut() = true;
            rig.runner.inner.pid_started.borrow_mut().insert(42, vec![Some(5_000), Some(5_000), None]);
            assert_eq!(rig.svc.view(&id).unwrap_err(), VIEW_NO_DESKTOP);
            assert!(!rig.svc.viewing(&id));
            assert!(rig.runner.killed().is_empty(), "已經結束的不用殺，更不碰 mux");
            assert_eq!(kill_panes(&rig.runner), 0, "夥伴照常在背景執行");
        }

        #[test]
        fn 看畫面_視窗出現而且活過一秒才算成功_不用等滿判斷時間() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            *rig.runner.inner.window_up.borrow_mut() = true;
            rig.runner.inner.pid_started.borrow_mut().insert(42, vec![Some(5_000); 20]);
            let before = rig.runner.inner.sleeps.borrow().len();
            rig.svc.view(&id).unwrap();
            assert!(rig.svc.viewing(&id));
            let waited: Duration = rig.runner.inner.sleeps.borrow()[before..].iter().sum();
            assert_eq!(waited, VIEW_MIN_ALIVE, "剛好等滿一秒：每次都核對建立時間，視窗早就出現也不提早算成功");
        }

        #[test]
        fn 看畫面_查不到建立時間也當開不了() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            rig.runner.inner.pid_started.borrow_mut().insert(42, vec![None; 6]);
            assert_eq!(rig.svc.view(&id).unwrap_err(), VIEW_NO_DESKTOP);
            assert!(rig.runner.killed().is_empty());
        }

        #[test]
        fn 看畫面_mux_換過就拒絕_不起_gui() {
            let (rig, paths) = mux_rig();
            let id = open_partner(&rig);
            std::fs::write(&paths.pid, "4001 1000").unwrap();
            let e = rig.svc.view(&id).unwrap_err();
            assert!(e.contains("重新啟動過"), "{e}");
            assert!(view_spawns(&rig.runner).is_empty());
            assert!(rig.svc.list().is_empty());
            assert!(rig.svc.partner_in_mux((MUX_PID, 1000), "小乙").is_none(), "舊的列也移除了");
        }

        #[test]
        fn 看畫面_沒開_mux_模式就拒絕() {
            let rig = make(default_profiles(), vec![]);
            let (id, _) = rig.svc.start_window(Path::new(&rig.cwd), &claude_spec(None)).unwrap();
            assert!(rig.svc.view(&id).is_err());
            assert!(view_spawns(&rig.runner).is_empty());
            assert!(rig.svc.partner_in_mux((42, 1000), "小乙").is_none(), "第 1 階段的視窗沒有共用終端可以找");
        }

        #[test]
        fn 關夥伴視窗_關窗格加收畫面_不結束_mux() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            rig.svc.view(&id).unwrap();
            rig.svc.stop_partner(&id).unwrap();
            let kills: Vec<_> = cli_calls(&rig.runner).into_iter().filter(|(a, _)| a.iter().any(|x| x == "kill-pane")).collect();
            assert_eq!(kills.len(), 1);
            assert_eq!(kills[0].0, ["cli", "--no-auto-start", "kill-pane", "--pane-id", "9"]);
            assert_eq!(rig.runner.killed(), vec![42], "只收看畫面的 GUI，絕不 kill_tree mux");
            assert!(rig.svc.partner_in_mux((MUX_PID, 1000), "小乙").is_none(), "對照表的列移除了");
            assert!(!rig.svc.viewing(&id));
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
            assert!(v["terms"].as_array().unwrap().is_empty());
        }

        #[test]
        fn 關夥伴視窗_沒有開畫面時什麼程序都不結束() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            rig.svc.stop_partner(&id).unwrap();
            assert_eq!(kill_panes(&rig.runner), 1);
            assert!(rig.runner.killed().is_empty());
        }

        #[test]
        fn 關夥伴視窗_mux_換過視為關好_畫面也收_不對新_mux_下指令() {
            let (rig, paths) = mux_rig();
            let id = open_partner(&rig);
            rig.svc.view(&id).unwrap();
            std::fs::write(&paths.pid, "4002 1000").unwrap();
            rig.svc.stop_partner(&id).unwrap();
            assert_eq!(kill_panes(&rig.runner), 0);
            assert_eq!(rig.runner.killed(), vec![42], "看舊 mux 的畫面沒有用了，收掉；mux 本身不動");
        }

        #[test]
        fn 關夥伴視窗_只收共用_mux_裡的夥伴視窗() {
            let (rig, _) = mux_rig();
            let panel = rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            assert!(rig.svc.stop_partner(&panel).is_err(), "終端面板開的走 stop，不走這裡");
            assert!(rig.svc.stop_partner("999").is_err());
            let id = open_partner(&rig);
            // 終端面板的讀畫面、關閉等仍然拒絕夥伴視窗
            assert!(rig.svc.stop(&id).unwrap_err().contains("還不能從終端面板操作"));
            assert!(rig.svc.read(&id, 5).is_err());
            assert_eq!(kill_panes(&rig.runner), 0);
        }

        #[test]
        fn 名單前台背景_查詢與切換() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            assert_eq!(rig.svc.console_query_mux(&id), serde_json::json!({ "ok": true, "can_toggle": true, "visible": false }));
            assert_eq!(rig.svc.console_set_mux(&id, true), serde_json::json!({ "ok": true, "visible": true }));
            assert_eq!(rig.svc.console_query_mux(&id)["visible"], true);
            assert_eq!(rig.svc.console_set_mux(&id, false), serde_json::json!({ "ok": true, "visible": false }));
            assert_eq!(rig.runner.killed(), vec![42]);
            // 失敗：原因要給前端顯示
            rig.runner.inner.pid_started.borrow_mut().insert(42, vec![Some(5_000), None]);
            let r = rig.svc.console_set_mux(&id, true);
            assert_eq!(r, serde_json::json!({ "ok": false, "reason": VIEW_NO_DESKTOP, "notify": true }));
        }

        #[test]
        fn 依名字找夥伴窗格_mux_要對得上_同名不猜() {
            let (rig, _) = mux_rig();
            let id = open_partner(&rig);
            assert_eq!(rig.svc.partner_in_mux((MUX_PID, 1000), "小乙"), Some(id.clone()));
            assert_eq!(rig.svc.partner_in_mux((MUX_PID, 1000), "小甲"), None);
            assert_eq!(rig.svc.partner_in_mux((MUX_PID, 777), "小乙"), None, "mux 的建立時間不同＝不是開窗格時那一個");
            assert_eq!(rig.svc.partner_in_mux((4001, 1000), "小乙"), None);
            // 終端面板開的（沒有名字、沒有 kind）不算
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            assert_eq!(rig.svc.partner_in_mux((MUX_PID, 1000), "小乙"), Some(id));
            // 同名兩個：不猜
            open_partner(&rig);
            assert_eq!(rig.svc.partner_in_mux((MUX_PID, 1000), "小乙"), None);
        }

        #[test]
        fn 登錄檔撞名_拒絕在_mux_開_沒啟動_指名變數() {
            let (rig, _) = mux_rig();
            let env: BTreeMap<String, String> = [("ASN_PI_NAME".to_string(), "小皮".to_string()), ("PATH".to_string(), "C:/bin".to_string())].into();
            TEST_REGISTRY_NAMES.with(|n| *n.borrow_mut() = vec!["asn_pi_name".into()]);
            let e = rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &env).unwrap_err();
            let crate::launch::win_term::WinOpenError::NotStarted(m) = e else { panic!("窗格還沒開，應該是沒啟動的失敗（呼叫端可退到原生主控台）") };
            assert!(m.contains("asn_pi_name"), "{m}");
            assert_eq!(count_sub(&rig.runner, "spawn"), 0, "沒有開窗格");
            assert!(rig.svc.list().is_empty());
            // 對照：登錄檔沒有這個名字就開得起來（證明拒絕來自撞名）
            TEST_REGISTRY_NAMES.with(|n| *n.borrow_mut() = vec!["OTHER_VAR".into()]);
            rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &env).unwrap();
            assert_eq!(count_sub(&rig.runner, "spawn"), 1);
        }

        #[test]
        fn 登錄檔有_path_或金鑰類變數_照常開_只記_log() {
            let (rig, _) = mux_rig();
            let env: BTreeMap<String, String> = [("ASN_PI_NAME".to_string(), "小皮".to_string()), ("PATH".to_string(), "C:/bin".to_string())].into();
            TEST_REGISTRY_NAMES.with(|n| *n.borrow_mut() = vec!["Path".into(), "ASN_RELAY_KEY".into()]);
            rig.svc.start_pi_staged(Path::new(&rig.cwd), &pi_argv(), &env).unwrap();
            assert_eq!(count_sub(&rig.runner, "spawn"), 1);
            // 終端面板的 agy（環境＝共用白名單）：沒有逐窗格的變數，登錄檔再怎麼同名也不算撞名
            TEST_REGISTRY_NAMES.with(|n| *n.borrow_mut() = crate::launch::config::child_env().keys().cloned().collect());
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            assert_eq!(count_sub(&rig.runner, "spawn"), 2);
        }

        #[test]
        fn 開關預設關_行為跟以前一樣() {
            let rig = make(default_profiles(), vec![]);
            assert!(!rig.svc.use_mux);
            rig.svc.start("agy", &rig.cwd, &rig.config).unwrap();
            assert_eq!(started_args(&rig.runner).len(), 1);
            assert!(rig.runner.inner.clean_calls.borrow().is_empty());
            assert!(rig.runner.args().iter().all(|a| !a.iter().any(|x| x == "--no-auto-start")));
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rig.store).unwrap()).unwrap();
            assert!(v["terms"][0].get("mux").is_none(), "第 1 階段的列不多寫新欄位");
        }
    }
}
