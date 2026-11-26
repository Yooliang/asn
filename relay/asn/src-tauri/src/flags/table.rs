//! 登記表本體：程式裡出現的每個 `ASN_*` 名字一列。欄位說明見 [`super::Flag`]。
//! 新增環境變數時，在這裡加一列（守門測試會逼）；舊名要登記在 `envc::PAIRS`，兩邊測試會對。
use super::{Flag, Kind, Pin, Typed};

macro_rules! old {
    ($s:literal) => {
        Some(concat!("IRORI_", $s))
    };
}

const fn prod(name: &'static str, legacy: Option<&'static str>, default: &'static str, purpose: &'static str, readers: &'static [&'static str], pin: Pin) -> Flag {
    Flag::new(Kind::Prod, name, legacy, default, purpose, readers, pin)
}
const fn internal(name: &'static str, default: &'static str, purpose: &'static str, readers: &'static [&'static str]) -> Flag {
    Flag::new(Kind::Internal, name, None, default, purpose, readers, Pin::Na)
}
const fn test(name: &'static str, legacy: Option<&'static str>, default: &'static str, purpose: &'static str, readers: &'static [&'static str]) -> Flag {
    Flag::new(Kind::Test, name, legacy, default, purpose, readers, Pin::Na)
}

// 沒釘測試的原因（共用字樣）
const NO_FN: Pin = Pin::Unpinned("預設值寫在需要完整執行環境的運算式裡，沒有可單獨呼叫的讀取函式");
const LOGIC: Pin = Pin::Unpinned("沒設時走一段判定邏輯（不是固定值），沒有單一預設可比對");
const NO_ENGINE: Pin = Pin::Unpinned("預設值寫在引擎建構（CodexEngine::new）的欄位初始化裡，要完整引擎環境才建得出來");
const CFG_TEST: Pin = Pin::Unpinned("測試編譯裡刻意用不同的預設（cfg!(test)），測試讀不到正式預設");
const NEEDS_APP: Pin = Pin::Unpinned("預設值寫在需要完整程式狀態的函式裡，單元測試建不出來");
const BOOL_OFF: Pin = Pin::Unpinned("只在原始碼比對字串，沒有可單獨呼叫的讀取函式");

/// 不是環境變數、但長得像的名字（程式常數名、測試輸出標記）：掃描器看到要放行
pub static NOT_ENV: &[(&str, &str, &str)] = &[
    ("ASN_EXIT_GRACE", "launch/mux_restart.rs", "Rust 常數名（等舊終端服務收尾的秒數），不是環境變數"),
    ("ASN_TEST_PID", "launch/local.rs", "測試子程序印給父測試看的輸出標記（ASN_TEST_PID=…），不是環境變數"),
];

/// 字串裡以 `ASN_` 開頭、但不是完整名字的動態組名（檔名、前綴比較、格式字串）：（檔案, 片段）
pub static DYNAMIC_OK: &[(&str, &str, &str)] = &[
    ("android_update.rs", "ASN_", "安卓更新包檔名 ASN_<版本>_android.apk，不是環境變數"),
    ("android_update.rs", "ASN_0", "安卓更新包檔名範例 ASN_0.1.33_android.apk，不是環境變數"),
    ("envc.rs", "ASN_","envc 內部：新名前綴檢查與測試組名，名字本身都登記在 PAIRS"),
];

pub static FLAGS: &[Flag] = &[
    // ---- 橋與引擎：正式設定 ------------------------------------------------------------
    prod("ASN_RELAY_ID", old!("RELAY_ID"), "沒設走節點判定（identity）", "節點代號", &["cli/env.rs", "identity.rs", "bridge/engines/mod.rs", "launch/config.rs"], LOGIC),
    prod("ASN_RELAY_URL", old!("RELAY_URL"), "內建後台網址", "後台網址", &["cli/env.rs", "identity.rs", "account.rs", "headless.rs", "lib.rs"], LOGIC),
    prod("ASN_RELAY_KEY", old!("RELAY_KEY"), "讀 ~/.asn 底下的節點金鑰檔", "節點金鑰，不可交給子程序", &["cli/env.rs", "identity.rs", "bridge/engines/mod.rs", "claude_mod.rs"], LOGIC).secret(),
    prod("ASN_RELAY_ANON_KEY", old!("RELAY_ANON_KEY"), "讀 ~/.asn/anon.key，再沒有就只輪詢", "後台公開金鑰（訂 Realtime），不可交給子程序", &["cli/env.rs", "identity.rs", "account.rs", "bridge/engines/mod.rs"], LOGIC).secret(),
    prod("ASN_RELAY_DEFAULT_AGENT", old!("RELAY_DEFAULT_AGENT"), "空（交給本人）", "沒指定收件視窗的信交給誰（舊相容，bridge.json 優先）", &["bridge/core.rs"], Pin::Value("")),
    prod("ASN_RELAY_ALLOW", old!("RELAY_ALLOW"), "空", "額外允許的寄件者清單（逗號分隔）", &["bridge/core.rs"], Pin::Value("")),
    prod("ASN_RELAY_POLL_MS", old!("RELAY_POLL_MS"), "120000", "橋輪詢間隔（毫秒）", &["bridge/core.rs"], Pin::Value("120000")),
    prod("ASN_ROSTER_MS", old!("ROSTER_MS"), "60000", "橋名單輪詢（引擎刷新同值，毫秒）", &["bridge/core.rs"], Pin::Value("60000")),
    prod("ASN_BRIDGE_TICK_MS", old!("BRIDGE_TICK_MS"), "5000", "橋主迴圈節拍（毫秒）", &["bridge/core.rs"], Pin::Value("5000")),
    prod("ASN_REPLY_TIMEOUT_MS", old!("REPLY_TIMEOUT_MS"), "600000", "等回覆逾時（毫秒）", &["bridge/core.rs"], Pin::Value("600000")),
    prod("ASN_LATE_KEEP_MS", old!("LATE_KEEP_MS"), "86400000", "晚到回覆保留時間（毫秒）", &["bridge/core.rs"], Pin::Value("86400000")),
    prod("ASN_LATE_MAX", old!("LATE_MAX"), "200", "晚到回覆最多保留幾筆", &["bridge/core.rs"], Pin::Value("200")),
    prod("ASN_NUDGE_MS", old!("NUDGE_MS"), "300000", "催一下的間隔（毫秒）", &["bridge/core.rs"], Pin::Value("300000")),
    prod("ASN_FORWARD_TIMEOUT_MS", old!("FORWARD_TIMEOUT_MS"), "120000", "轉交逾時（毫秒）", &["bridge/core.rs"], Pin::Value("120000")),
    prod("ASN_FORWARD_ONE_PER_TURN", old!("FORWARD_ONE_PER_TURN"), "開（設 0 才關）", "一輪只交一封", &["bridge/core.rs"], Pin::Value("true")),
    prod("ASN_ROOM_STAGGER_MS", old!("ROOM_STAGGER_MS"), "60000（0＝關）", "群組順位延遲（毫秒）", &["bridge/core.rs"], Pin::Value("60000")),
    prod("ASN_MAILBOX_NAME", old!("MAILBOX_NAME"), "<節點>-收發室", "收發室視窗名", &["bridge/core.rs", "launch/taskmgr.rs"], Pin::Value("<節點>-收發室")),
    prod("ASN_MAILBOX_MODEL", old!("MAILBOX_MODEL"), "haiku（自動回信模式用 sonnet）", "收發室用的模型", &["bridge/core.rs", "headless.rs"], Pin::Value("haiku")),
    prod("ASN_ENGINES", old!("ENGINES"), "載入預設引擎（acp、pi 自動載入，aegis 不自動）", "要載入哪些引擎", &["bridge/core.rs", "bridge/mod.rs"], NO_FN),
    prod("ASN_AGENTS_FILE", old!("AGENTS_FILE"), "~/.asn/agents.json（測試編譯放工作資料夾）", "ACP 工作者設定檔位置", &["bridge/core.rs"], CFG_TEST),
    prod("ASN_ROSTER_PROCS", old!("ROSTER_PROCS"), "開（0／false／off 才關；測試編譯預設關）", "名單掃描本機 claude 等程序", &["bridge/procscan.rs"], CFG_TEST),
    prod("ASN_ATTACH_CMD", old!("ATTACH_CMD"), "<asn-cli> attach", "下載附件的指令前綴", &["bridge/attach.rs"], NO_FN),
    prod("ASN_ROOM_CMD", old!("ROOM_CMD"), "<asn-cli> room", "群組「看更多」的指令前綴", &["bridge/attach.rs"], NO_FN),
    prod("ASN_RESPOND_TOOLS", old!("RESPOND_TOOLS"), "worker 內建的工具清單", "自動回信模式開放的工具", &["bridge/mod.rs"], NO_FN),
    prod("ASN_RESPOND", old!("RESPOND"), "關", "自動回信模式（Linux 無頭）開關", &["headless.rs"], BOOL_OFF),
    prod("ASN_BRIDGE_ENGINE_ONLY", old!("BRIDGE_ENGINE_ONLY"), "關", "只跑引擎（對應 --engine-only）", &["headless.rs"], BOOL_OFF),
    prod("ASN_BRIDGE_INBOX", old!("BRIDGE_INBOX"), "關", "收件匣模式（對應 --inbox）", &["headless.rs"], BOOL_OFF),
    prod("ASN_INBOX_NAME", old!("INBOX_NAME"), "節點代號", "收件匣或自動回信視窗名", &["cli/env.rs", "headless.rs", "inbox_mode.rs"], NO_FN),
    prod("ASN_INBOX_ENGINE", old!("INBOX_ENGINE"), "inbox", "收件匣引擎名", &["inbox_mode.rs"], NO_FN),
    prod("ASN_CLI_UNATTENDED", old!("CLI_UNATTENDED"), "關（收件匣資料夾在、且非 Windows 才可開）", "命令列無人值守", &["cli/env.rs"], Pin::Value("false")),
    prod("ASN_AEGIS_URL", old!("AEGIS_URL"), "http://127.0.0.1:8899", "Aegis 後台網址", &["bridge/engines/aegis.rs"], Pin::Value("http://127.0.0.1:8899")),
    prod("ASN_AEGIS_FROM_MEMBER", old!("AEGIS_FROM_MEMBER"), "xi-xu", "以誰的名義送", &["bridge/engines/aegis.rs"], Pin::Value("xi-xu")),
    prod("ASN_AEGIS_ALLOW", old!("AEGIS_ALLOW"), "空", "允許清單（逗號分隔）", &["bridge/engines/aegis.rs"], Pin::Value("")),
    prod("ASN_AEGIS_SELF", old!("AEGIS_SELF"), "xi-xu", "本機對應的 Aegis 成員", &["bridge/engines/aegis.rs"], Pin::Value("xi-xu")),
    prod("ASN_AEGIS_DEFAULT", old!("AEGIS_DEFAULT"), "aegis", "預設收件成員", &["bridge/engines/aegis.rs"], Pin::Value("aegis")),
    prod("ASN_AEGIS_TIMEOUT_MS", old!("AEGIS_TIMEOUT_MS"), "300000", "問答逾時（毫秒）", &["bridge/engines/aegis.rs"], Pin::Value("300000")),
    prod("ASN_AEGIS_RETRY_MS", old!("AEGIS_RETRY_MS"), "60000", "重試間隔（毫秒）", &["bridge/engines/aegis.rs"], Pin::Value("60000")),
    prod("ASN_CODEX_BIN", old!("CODEX_BIN"), "找 PATH 上的 codex", "指定 codex 執行檔", &["bridge/engines/codex.rs"], LOGIC),
    prod("ASN_CODEX_POLL_MS", old!("CODEX_POLL_MS"), "2000", "Codex 輪詢（毫秒）", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_HEALTH_TTL_MS", old!("CODEX_HEALTH_TTL_MS"), "30000", "健康檢查快取（毫秒）", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_OUTSTANDING_MAX_MS", old!("CODEX_OUTSTANDING_MAX_MS"), "3600000", "未回覆上限（毫秒）", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_DRAIN_WARN_MS", old!("CODEX_DRAIN_WARN_MS"), "180000", "排空警告（毫秒）", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_MAX_MAIL_CHARS", old!("CODEX_MAX_MAIL_CHARS"), "12000", "單封信字數上限（Windows 命令列限制）", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_LOCK_MODE", old!("CODEX_LOCK_MODE"), "Windows 預設非 exists；其他平台 exists", "鎖模式", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_ALLOW_FULL_ACCESS", old!("CODEX_ALLOW_FULL_ACCESS"), "關（設 1 才放行）", "放行「完全存取」模式的 Codex 視窗", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_REPLY_NOTE", old!("CODEX_REPLY_NOTE"), "開（設 0 關）", "回信加註", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_CODEX_SKIP_VERSION_CHECK", old!("CODEX_SKIP_VERSION_CHECK"), "關（設 1 略過）", "略過 Codex 最低版本檢查", &["bridge/engines/codex.rs"], NO_ENGINE),
    prod("ASN_WAIT_ALERT", None, "關（設 1 開）", "夥伴卡在輸入框超過兩分鐘就通知本人（實驗）", &["bridge/core.rs"], Pin::Value("false")).typed(Typed::Exact1),
    prod("ASN_FORWARD_EXACT", None, "關（設 1 開）", "轉交內容與原信逐字相同（實驗）", &["bridge/worker.rs"], Pin::Value("false")).typed(Typed::Exact1),
    prod("ASN_FORWARD_EXACT_UNVERIFIED", None, "關（設 1 開）", "沒有自我測試時，開發機強制生效", &["bridge/core.rs"], Pin::Value("false")).typed(Typed::Exact1),
    prod("ASN_MOD_WAIT_MS", None, "600000（限 1 秒到 1 小時）", "外掛等視窗閒置的上限（毫秒）", &["bridge/partner_ops.rs"], Pin::Value("600000")).typed(Typed::Ms { default: 600_000, min: 1_000, max: 3_600_000 }),
    // ---- 電腦版主程式、帳號、資料夾 ----------------------------------------------------
    prod("ASN_HOME", old!("HOME"), "~/.asn（再找舊 ~/.irori-relay）", "使用者資料夾；設了就不做舊資料夾遷移", &["home.rs", "launch/pi_setup.rs"], LOGIC),
    prod("ASN_DATA", old!("ASN_DATA"), "%APPDATA%\\tw.yooliang.asn", "電腦版資料夾；設了就不套新裝預設值（開發或測試覆蓋）", &["lib.rs", "first_run.rs"], LOGIC),
    prod("ASN_POLL_MS", old!("ASN_POLL_MS"), "120000", "電腦版畫面輪詢（毫秒）", &["lib.rs"], NEEDS_APP),
    prod("ASN_APP_ROSTER_MS", old!("ASN_ROSTER_MS"), "60000", "電腦版名單輪詢（毫秒）", &["lib.rs"], NEEDS_APP),
    prod("ASN_WINDOW_FALLBACK_MS", old!("ASN_WINDOW_FALLBACK_MS"), "30000", "視窗名單備援輪詢（毫秒）", &["lib.rs"], NEEDS_APP),
    prod("ASN_WINDOW_STALE_MS", old!("ASN_WINDOW_STALE_MS"), "300000", "視窗名單過期時間（毫秒）", &["lib.rs"], NEEDS_APP),
    prod("ASN_CLAUDE_AUTO_MS", old!("ASN_CLAUDE_AUTO_MS"), "60000", "Claude 帳號自動加入間隔（毫秒）", &["lib.rs"], NEEDS_APP),
    prod("ASN_GROK_AUTO_MS", old!("ASN_GROK_AUTO_MS"), "60000", "Grok 帳號自動換間隔（毫秒）", &["lib.rs"], NEEDS_APP),
    prod("ASN_PRESENCE_MS", old!("ASN_PRESENCE_MS"), "60000", "在線回報間隔（毫秒）", &["lib.rs"], NEEDS_APP),
    prod("ASN_CLAUDE_HOME", old!("ASN_CLAUDE_HOME"), "真實家目錄", "Claude 帳號讀哪個家目錄（也當測試隔離）", &["claude_accounts.rs"], LOGIC),
    prod("ASN_GROK_HOME", old!("ASN_GROK_HOME"), "真實家目錄", "Grok 帳號讀哪個家目錄（也當測試隔離）", &["grok_accounts.rs"], LOGIC),
    prod("ASN_LAUNCHER_FILE", old!("LAUNCHER_FILE"), "~/.asn/launcher.json", "啟動設定檔位置（測試隔離也用）", &["launch/config.rs", "test_guard.rs"], LOGIC),
    prod("ASN_SEND_PER_HOUR", old!("SEND_PER_HOUR"), "30", "每小時寄信上限", &["cli/env.rs"], NEEDS_APP),
    prod("ASN_RECV_POLL_MS", old!("RECV_POLL_MS"), "120000", "收信輪詢（毫秒）", &["cli/env.rs"], NEEDS_APP),
    prod("ASN_RECV_HEARTBEAT_MS", old!("RECV_HEARTBEAT_MS"), "30000", "收信心跳（毫秒）", &["heartbeat.rs"], Pin::Value("30000")),
    prod("ASN_RECV_STALE_MS", old!("RECV_STALE_MS"), "90000", "心跳過期（毫秒）", &["heartbeat.rs"], Pin::Value("90000")),
    prod("ASN_PULL_BACKOFF_MS", old!("PULL_BACKOFF_MS"), "5000,10000,20000,40000,60000", "收信失敗退避（逗號分隔毫秒）", &["cli/env.rs"], Pin::Value("5000,10000,20000,40000,60000")),
    // 等 #1470（節點金鑰預設改加密）合併再動：它會改 secret_file.rs 的同一段讀法，這張先不碰，避免衝突（#2163 PR-2b 刻意略過）
    prod("ASN_SEAL_NODE_KEY", None, "關（設 1 加密、0 不加密）", "Windows 節點金鑰是否加密存放（過渡期開關）", &["secret_file.rs"], Pin::Value("false")),
    prod("ASN_TERM_WEZTERM", None, "Windows 開、其他平台關（設 0 關、1 開）", "是否用自帶 WezTerm 開視窗（名字定義在 win_term.rs 的常數，term.rs、bridge/mod.rs 經常數讀）", &["launch/win_term.rs"], Pin::Value("Windows 開、其他平台關")).typed(Typed::PlatformSwitch),
    prod("ASN_TERM_MUX", None, "Windows 開、其他平台關（設 0 關、1 開）", "共用終端服務（mux）開關（名字定義在 win_term.rs 的常數，term.rs、bridge/mod.rs 經常數讀）", &["launch/win_term.rs"], Pin::Value("Windows 開、其他平台關")).typed(Typed::PlatformSwitch),
    prod("ASN_SCREEN_WATCH", None, "Windows 開、其他平台關（設 0 關、1 開）", "讀夥伴畫面判斷卡在哪（名字定義在 screen_watch.rs 的常數）", &["launch/screen_watch.rs"], Pin::Value("Windows 開、其他平台關")).typed(Typed::PlatformSwitch),
    prod("ASN_WEZTERM_DIR", None, "內建或安裝位置", "指定 WezTerm 資料夾（部署覆蓋，測試也用）", &["launch/wezterm.rs"], LOGIC).typed(Typed::Path),
    // ---- 內部傳遞 -------------------------------------------------------------------
    internal("ASN_LAUNCH_ARGS", "—", "開視窗的參數（父程序設給啟動腳本）", &["launch/local.rs"]).with_legacy(old!("LAUNCH_ARGS")),
    internal("ASN_LAUNCH_DIR", "—", "開視窗的工作目錄（父程序設給啟動腳本）", &["launch/local.rs"]).with_legacy(old!("LAUNCH_DIR")),
    internal("ASN_LAUNCH_STYLE", "—", "視窗樣式（父程序設給啟動腳本）", &["launch/local.rs"]).with_legacy(old!("LAUNCH_STYLE")),
    internal("ASN_PI_NAME", "—", "pi 視窗名（設給 pi 外掛）", &["launch/pi.rs"]),
    internal("ASN_MUX_HEARTBEAT", "—", "心跳檔位置（設給自建 mux-server；舊版會忽略）", &["launch/mux.rs"]),
    internal("ASN_SPECS", "—", "視窗擷取清單（設給內嵌 PowerShell）", &["wins.rs"]),
    internal("ASN_DIR", "—", "視窗擷取輸出資料夾（設給內嵌 PowerShell）", &["wins.rs"]),
    // ---- CI、除錯 -------------------------------------------------------------------
    Flag::new(Kind::Ci, "ASN_SHOT_TOAST_LENIENT", None, "關（設 1 開）", "發版流程設：提示視窗截圖疑似空白只警告（只有 e2e 專用的 test-hooks 建置讀，正式安裝包讀不到）", &["wins.rs"], Pin::Na),
    Flag::new(Kind::Debug, "ASN_ASKPASS_PIPE", None, "正式管道名（只有測試、除錯或 test-hooks 建置讀）", "測試用管道名（要有測試前綴）", &["askpass/pipe.rs"], Pin::Na),
    // ---- 測試與手動驗證 ----------------------------------------------------------------
    test("ASN_CODEX_SCRIPT", old!("CODEX_SCRIPT"), "用 codex", "用一支 node 腳本取代 codex（測試用，Rust 端經 test_var 讀；JS 端 relay/machine 也讀，這一張不改）", &["bridge/engines/codex.rs"]),
    test("ASN_MOCK_BIN_DIR", old!("ASN_MOCK_BIN_DIR"), "走真實 PATH 與家目錄", "假執行檔資料夾；設了就不看真實安裝位置（測試用）", &["agent_tools/detect.rs", "agent_tools/mod.rs"]),
    test("ASN_SHOT_LOGIN", old!("ASN_SHOT_LOGIN"), "不動", "--shot 截圖模式假裝已登入（端到端測試用；只有 e2e 專用的 test-hooks 建置讀，正式安裝包讀不到）", &["lib.rs"]),
    test("ASN_UPDATE_GOLDEN", None, "只比對（CI 禁止重寫）", "重寫黃金檔", &["golden_util.rs"]),
    test("ASN_REGEN_SCREENS", None, "不重產", "重產前端畫面清單檔", &["launch/screen_catalog.rs"]),
    test("ASN_MANUAL_TEST", None, "略過", "手動真機測試放行", &["launch/console.rs", "launch/switch.rs"]),
    test("ASN_LIVE_GROK", None, "真機測試必設", "真機測試的 grok 路徑", &["launch/term.rs"]),
    test("ASN_MUX_REAL", None, "不跑", "真 mux 實測資料夾", &["launch/mux/tests.rs"]),
    test("ASN_MUX_LEAVE", None, "測完清掉", "測完不清", &["launch/mux/tests.rs"]),
    test("ASN_15Q_STATE", None, "見測試檔", "真機驗證參數：狀態", &["launch/term_live_mux.rs"]),
    test("ASN_15Q_CLAUDE_MODE", None, "見測試檔", "真機驗證參數：claude 模式", &["launch/term_live_mux.rs"]),
    test("ASN_15Q_FLAGS", None, "見測試檔", "真機驗證參數：旗標", &["launch/term_live_mux.rs"]),
    test("ASN_15Q_DIRNAME", None, "見測試檔", "真機驗證參數：資料夾名", &["launch/term_live_mux.rs"]),
    test("ASN_15Q_N", None, "見測試檔", "真機驗證參數：數量", &["launch/term_live_mux.rs"]),
    test("ASN_15Q_HIDDEN", None, "見測試檔", "真機驗證參數：隱藏", &["launch/term_live_mux.rs"]),
    test("ASN_FAKE_CLAUDE", None, "什麼都不做", "測試把自己當假 claude 子程序", &["bridge/tests.rs"]),
    test("ASN_FAKE_ORPHAN", None, "什麼都不做", "孤兒程序測試", &["bridge/tests/rooms_launch.rs"]),
    test("ASN_ORPHAN_OUT", None, "什麼都不做", "孤兒程序測試的輸出檔", &["bridge/tests/rooms_launch.rs"]),
    test("ASN_E2E_N", None, "4", "真 claude 端到端（花額度）數量", &["bridge/tests/e2e_real.rs"]),
    test("ASN_E2E_ONE_PER_TURN", None, "關", "真 claude 端到端：一輪一封", &["bridge/tests/e2e_real.rs"]),
    test("ASN_TEST_ACL_PATH", None, "—", "測試傳路徑給 PowerShell", &["claude_accounts.rs"]),
    test("ASN_TEST_LEAVE_GRANDCHILD", None, "—", "測試保留孫程序", &["launch/wezterm.rs"]),
    test("ASN_TEST_SECRET", None, "—", "測試金鑰不外流", &["launch/local.rs"]),
    test("ASN_X", None, "—", "測試佔位名", &["launch/win_term.rs"]),
];
