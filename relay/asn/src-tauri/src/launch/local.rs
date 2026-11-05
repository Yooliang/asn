use super::config::{build_spawn_spec, check_launch, load_launch_config, LaunchReq};
use super::profiles::LaunchMode;
use crate::claude_accounts::claude_home;
use crate::claude_json::{claude_project_key, ensure_project_trusted};
use crate::launch::LocalLaunchReq;
use serde_json::{json, Value};
use std::path::Path;
use crate::nowin::NoWindow;
use std::process::{Command, Stdio};

const NO_WORK_DIR: &str = "這台電腦還沒登入，不能開背景夥伴；請先登入";

pub fn partner_launch_local(_node: &str, work_dir: &Path, data_dir: &Path, req: LocalLaunchReq) -> Result<Value, String> {
    if req.profile.is_empty() || req.name.is_empty() || req.cwd.is_empty() {
        return Err("請填寫模型、名字與工作資料夾".into());
    }
    let mut config = load_launch_config()?;
    super::cwds::grant_local_cwd(&mut config, &req.cwd, &crate::identity::home_dir(), data_dir)?;
    let mut launch_req = LaunchReq {
        profile: &req.profile,
        name: &req.name,
        cwd: req.cwd.clone(),
    };
    check_launch(&config, &mut launch_req, &[], now_ms())?;
    let prof = config.profiles.get(&req.profile).ok_or_else(|| "沒有這個啟動設定".to_string())?;
    // 經 pi 指定提供者與模型：只有 pi 的 profile 收；名稱不合法或只給一個就直接報錯
    let pi_model_args = super::pi_models::model_args(&req.pi_provider, &req.pi_model)?;
    if !pi_model_args.is_empty() && prof.engine != "pi" {
        return Err("只有經 pi 開的夥伴能指定提供者與模型".into());
    }
    let model_plan = launch_model_plan(prof.engine.as_str(), prof.mode == LaunchMode::Background, &req.model)?;
    if model_plan != ModelPlan::None && !pi_model_args.is_empty() {
        return Err("經 pi 開的夥伴請用 pi 的模型，不能另外指定型號".into());
    }
    // 開窗之前先查這台電腦上有沒有同名而且還活著的夥伴：有就沿用、切到前景，不另開第二個（issue #596）
    if prof.mode != LaunchMode::Background {
        let live = super::console::live_partner_pid(prof.engine.as_str(), &req.name);
        if let Some(mut out) = existing_partner_reply(live, || super::console::bring_partner_to_front(prof.engine.as_str(), &req.name)) {
            // 對話框填了開場訊息：夥伴已經在跑，不會再收到開場訊息，明說沒送出
            if !req.first_message.trim().is_empty() {
                out["initial_dropped"] = json!(true);
            }
            return Ok(out);
        }
    }
    maybe_trust_claude_cwd(prof.engine.as_str(), &launch_req.cwd);

    if prof.mode == LaunchMode::Background {
        // 還沒有節點金鑰時工作資料夾是空路徑：佇列檔會寫到目前目錄，而且沒有橋會去讀（#859）
        if work_dir.as_os_str().is_empty() {
            return Err(NO_WORK_DIR.to_string());
        }
        // 選了型號：先記進 acp-models.json，工作者建起來時就套用（重開 ASN 也照這個型號）
        if let ModelPlan::Record(m) = &model_plan {
            crate::bridge::engines::acp_models::set(&work_dir.join(crate::bridge::engines::acp_models::MODELS_FILE), &req.name, m)?;
        }
        enqueue_background(work_dir, &req.profile, &req.name, &launch_req.cwd)?;
        return Ok(json!({ "ok": true, "mode": "background", "queued": true }));
    }

    let display_bg = req.display == "background";
    let (command, mut args, cwd) = build_spawn_spec(&config, &launch_req)?;
    // pi：互動式，一律前台；載入收信擴充、名字環境變數、第一句話都在 pi.rs 組好（找不到擴充就報錯，不開一個不會收信的 pi）
    if prof.engine == "pi" {
        args.extend(pi_model_args);
        let files = crate::identity::relay_home().join("pi-first");
        let plan = super::pi::plan(&req.name, &args, super::pi::resolve_ext_state(), &req.first_message, &files, now_ms())?;
        // 優先開在 ASN 自帶的終端（#475，能切前景／背景）；沒有或開不起來就用原生主控台，note 是給使用者看的說明
        let opened = super::pi_term::open_pi_real(&req.name, &command, &plan.args, &cwd, super::pi::hidden_for("pi", display_bg), &plan.env)?;
        let mut out = json!({ "ok": true, "mode": "window", "pid": opened.pid, "resumed": false, "display": "foreground", "first_message_sent": !req.first_message.trim().is_empty() });
        if let Some(n) = opened.note {
            out["note"] = json!(n);
        }
        return Ok(out);
    }
    if let ModelPlan::Arg(m) = &model_plan {
        args = with_model_arg(&args, m);
    }
    // 預設接續同名夥伴上一段對話（issue #82）；沒有舊對話才新開
    let resumed = if req.fresh { None } else { super::resume::apply_resume_real(&mut args, &command, prof.engine.as_str(), &req.name, &launch_req.cwd) };
    let opened = start_window_noted(&req.name, &command, &args, &cwd, display_bg)?;
    let mut out = json!({
        "ok": true,
        "mode": "window",
        "pid": opened.pid,
        "resumed": resumed.is_some(),
        "display": if display_bg { "background" } else { "foreground" }
    });
    // 自帶終端開不起來、改用一般視窗：只在第一次提示（見 win_term）
    if let Some(n) = opened.note {
        out["note"] = json!(n);
    }
    Ok(out)
}

/// 同名夥伴已在跑時的回覆；沒有（None）就照常開新的。
/// `live`＝同名而且還活著的夥伴 pid；`bring` 把它切到前景，回 `{ok, reason?}`。
/// 切前景失敗仍回 existing:true 並附原因，不另開一個。
pub(crate) fn existing_partner_reply(live: Option<u32>, bring: impl FnOnce() -> Value) -> Option<Value> {
    let pid = live?;
    let r = bring();
    let mut out = json!({ "ok": true, "existing": true, "mode": "window", "pid": pid });
    if r.get("ok").and_then(Value::as_bool) != Some(true) {
        let why = r.get("reason").and_then(Value::as_str).unwrap_or("無法切到前景");
        out["reason"] = json!(why);
    }
    Some(out)
}

/// 開新夥伴選了型號要怎麼帶（#539 之四）
#[derive(Debug, PartialEq)]
pub(crate) enum ModelPlan {
    /// 沒選（照原本的開法）
    None,
    /// Claude 視窗：啟動參數帶 `--model <代號>`
    Arg(String),
    /// 內建通道（背景）工作者：記進 acp-models.json，建工作者時套用
    Record(String),
}

/// 型號要怎麼帶：空＝不指定；代號只收英數與 . _ -（英數開頭、60 字內）；
/// 背景模式（Gemini 等內建通道）記下來；視窗只有 Claude 收 `--model`（Codex 的參數包在 cmd /c 與 resume 子指令裡，先不做）
pub(crate) fn launch_model_plan(engine: &str, background: bool, model: &str) -> Result<ModelPlan, String> {
    let m = model.trim();
    if m.is_empty() {
        return Ok(ModelPlan::None);
    }
    if !crate::bridge::engines::acp_models::valid_model(m) {
        return Err("型號代號格式不對（只能用英數與 . _ -）".into());
    }
    if background {
        return Ok(ModelPlan::Record(m.to_string()));
    }
    match engine {
        // 只認明寫 "claude"：沒寫 engine 的自訂 profile 不知道是什麼程式，不補 --model
        "claude" => Ok(ModelPlan::Arg(m.to_string())),
        _ => Err("這個廠牌開新夥伴時不能指定型號".into()),
    }
}

/// 把啟動參數裡原有的 `--model <值>`／`--model=<值>` 拿掉，最後補上 `--model <代號>`（profile 自己寫了 --model 也以這次選的為準）
pub(crate) fn with_model_arg(args: &[String], model: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len() + 2);
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
            continue;
        }
        if a == "--model" {
            skip = true;
            continue;
        }
        if a.starts_with("--model=") {
            continue;
        }
        out.push(a.clone());
    }
    out.push("--model".into());
    out.push(model.to_string());
    out
}

/// 遠端開視窗（內建收發室橋）用：驗證（profile、名字、白名單、上限）都已在呼叫端做完，
/// 這裡只做「自動信任資料夾 → 依本機設定組命令 → 開視窗」。指令只來自本機的 profile，遠端只決定 profile 名、名字與資料夾。
/// hidden＝背景開（測試用，正式一律 false）。回傳視窗的 PID（自帶終端＝GUI；退路主控台＝承載的 PowerShell）。
/// pi_args＝經 pi 的 --provider／--model（呼叫端已驗過格式與這台 pi 列得出來；只有 pi 的 profile 收）
pub fn start_remote_window(config: &super::config::LaunchConfig, profile: &str, name: &str, cwd: &str, hidden: bool, pi_args: &[String]) -> Result<u32, String> {
    let prof = config.profiles.get(profile).ok_or_else(|| "沒有這個啟動設定".to_string())?;
    if !pi_args.is_empty() && prof.engine != "pi" {
        return Err("只有經 pi 開的夥伴能指定提供者與模型".into());
    }
    // 沒寫 engine 的自訂 profile 與 Node 橋相同，視為 Claude
    maybe_trust_claude_cwd(if prof.engine.is_empty() { "claude" } else { prof.engine.as_str() }, cwd);
    let req = LaunchReq { profile, name, cwd: cwd.to_string() };
    let (command, mut args, cwd) = build_spawn_spec(config, &req)?;
    // pi：同本機開窗，載入收信擴充、帶名字環境變數（找不到擴充就報錯，不開一個不會收信的 pi）。第一句話由橋在視窗出現後經收發室送進去
    if prof.engine == "pi" {
        args.extend(pi_args.iter().cloned());
        let files = crate::identity::relay_home().join("pi-first");
        let plan = super::pi::plan(name, &args, super::pi::resolve_ext_state(), "", &files, now_ms())?;
        return super::pi_term::open_pi_real(name, &command, &plan.args, &cwd, false, &plan.env).map(|o| o.pid);
    }
    // 同本機開窗：預設接續同名夥伴上一段對話；hidden（測試用）不查真實的對話檔
    if !hidden {
        super::resume::apply_resume_real(&mut args, &command, if prof.engine.is_empty() { "claude" } else { prof.engine.as_str() }, name, &cwd.to_string_lossy());
    }
    start_window(name, &command, &args, &cwd, hidden)
}

/// 重開機後自動接回一位 Claude 夥伴（#767）：用本機的 Claude 視窗 profile，換上它原本的權限旗標，指定對話編號接回。
/// 資料夾要在允許清單內；不走開新夥伴的每小時上限（這是本機的開機流程，不是遠端要求，一次要接回的可能超過上限）。回視窗 PID
pub fn start_resumed_window(config: &super::config::LaunchConfig, name: &str, cwd: &str, session: &str, perm: &[String], hidden: bool) -> Result<u32, String> {
    // canonical_launch_cwd 遇到不存在的路徑會原樣交回（不報錯），所以要另外確認資料夾還在
    let canon = super::config::canonical_launch_cwd(cwd).ok().filter(|p| p.is_dir()).ok_or_else(|| format!("原本的工作資料夾（{cwd}）已經不存在或不能用"))?;
    if !config.cwd_allow.contains(&canon) {
        return Err(format!("原本的工作資料夾（{cwd}）不在允許清單內"));
    }
    let profile = super::auto_resume::claude_profile(config).ok_or("這台電腦沒有可用的 Claude 啟動設定")?;
    let req = LaunchReq { profile: &profile, name, cwd: strip_verbatim_prefix(&canon.to_string_lossy()) };
    let (command, args, spawn_cwd) = build_spawn_spec(config, &req)?;
    let args = super::auto_resume::resumed_args(&command, &args, session, perm)?;
    maybe_trust_claude_cwd("claude", &req.cwd);
    start_window(name, &command, &args, &spawn_cwd, hidden)
}

/// 接手使用者自己開的 pi（0.2 A5）：用本機 pi 的啟動設定、載入收信擴充、帶名字，在原本的資料夾用 --session 接回同一段對話。
/// 驗證（名字、白名單、上限）由呼叫端做完；指令只來自本機的 pi profile。回外層視窗的 PID
pub fn start_pi_session(config: &super::config::LaunchConfig, name: &str, cwd: &str, session_file: &str) -> Result<u32, String> {
    let req = LaunchReq { profile: "pi", name, cwd: cwd.to_string() };
    let (command, mut args, cwd) = build_spawn_spec(config, &req)?;
    args.extend(["--session".to_string(), session_file.to_string()]);
    let files = crate::identity::relay_home().join("pi-first");
    let plan = super::pi::plan(name, &args, super::pi::resolve_ext_state(), "", &files, now_ms())?;
    super::pi_term::open_pi_real(name, &command, &plan.args, &cwd, false, &plan.env).map(|o| o.pid)
}

/// Claude 引擎：在啟動前把 cwd_allow 內、本次使用的資料夾標成已信任（失敗只記 log，不擋啟動）。
fn maybe_trust_claude_cwd(engine: &str, cwd: &str) {
    if engine != "claude" {
        return;
    }
    let home = claude_home();
    let key = claude_project_key(Path::new(cwd));
    if let Err(e) = ensure_project_trusted(&home, &key) {
        elog!("開新夥伴前寫入 Claude 資料夾信任失敗（不影響啟動）：{e}");
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn enqueue_background(work_dir: &Path, profile: &str, name: &str, cwd: &str) -> Result<(), String> {
    let file = work_dir.join("partner-queue.jsonl");
    if let Some(p) = file.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(&json!({ "profile": profile, "name": name, "cwd": cwd })).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(windows, allow(dead_code))]
fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c.is_whitespace() || c == '"') {
        return a.to_string();
    }
    format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 開夥伴視窗的唯一入口（0.2.0 第 1 階段，設計 1.1）：開新夥伴（本機／遠端）、接回對話、換模型重開、改名退路、接班換手都經這裡。
/// Windows：先開在 ASN 自帶的 WezTerm（寫進對照表），找不到或開不起來才開原生主控台。參數照呼叫端給的，一個字都不改。
pub(super) fn start_window(title: &str, command: &str, args: &[String], cwd: &Path, hidden: bool) -> Result<u32, String> {
    start_window_noted(title, command, args, cwd, hidden).map(|o| o.pid)
}

/// 同 [`start_window`]，另外帶回「改用一般視窗」的提示（只有第一次有，給開新夥伴的畫面顯示）
pub(super) fn start_window_noted(title: &str, command: &str, args: &[String], cwd: &Path, hidden: bool) -> Result<super::win_term::Opened, String> {
    #[cfg(windows)]
    {
        start_window_windows(title, command, args, cwd, hidden)
    }
    #[cfg(not(windows))]
    {
        let _ = title;
        start_window_unix(command, args, cwd, &[]).map(|pid| super::win_term::Opened { pid, note: None })
    }
}

/// 直接開原生主控台（不試自帶終端），另外在視窗裡先設好額外的環境變數（pi 的 ASN_PI_NAME）。
/// 只給經 pi 的退路用：pi_term 已經先試過自帶終端了（見 pi_term）
pub(super) fn start_console_window_env(title: &str, command: &str, args: &[String], cwd: &Path, hidden: bool, env: &[(String, String)]) -> Result<u32, String> {
    #[cfg(windows)]
    {
        start_console_window_windows(title, command, args, cwd, hidden, env)
    }
    #[cfg(not(windows))]
    {
        let _ = (title, hidden);
        start_window_unix(command, args, cwd, env)
    }
}

/// Windows 開窗點：環境先過 child_env（金鑰類變數、繼承來的 CLAUDE* 都不帶進視窗），交給自帶終端；退路開原生主控台（同樣 env_clear＋child_env）
#[cfg(windows)]
fn start_window_windows(title: &str, command: &str, args: &[String], cwd: &Path, hidden: bool) -> Result<super::win_term::Opened, String> {
    let env = super::win_term::term_env(super::config::child_env(), &[]);
    let spec = super::win_term::spec_for(title, command, args, hidden, env);
    let dir = std::path::PathBuf::from(strip_verbatim_prefix(&cwd.to_string_lossy()));
    super::win_term::open_window_real(&dir, &spec, &|| start_console_window_windows(title, command, args, cwd, hidden, &[]))
}

/// PowerShell 單引號字串（內部單引號加倍），整串都是字面值，不會展開 $ 或反引號。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn ps_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        out.push(c);
        // PowerShell 把彎單引號 U+2018、U+2019、U+201A、U+201B 也當單引號：路徑或訊息裡有它們也要加倍，否則字串會提前結束
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// 去掉 Windows 的長路徑前綴（canonicalize 會加）；不少 CLI 對它處理不一致，工作資料夾也會被當成不同的專案路徑。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn strip_verbatim_prefix(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// 視窗裡實際執行的腳本：設標題、跑指令、指令結束後印出結束碼並停住，讓錯誤訊息看得到而不是視窗一閃就沒。
/// 啟動失敗（找不到檔案等）也會把錯誤原文印在視窗裡。
#[cfg_attr(not(windows), allow(dead_code))]
fn build_window_script(title: &str, command: &str, args: &[String]) -> String {
    build_window_script_env(title, command, args, &[])
}

/// 環境變數名只收大寫英數與底線（不合的丟掉，避免被塞進腳本）
#[cfg_attr(not(windows), allow(dead_code))]
fn env_lines(env: &[(String, String)]) -> String {
    env.iter()
        .filter(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        .map(|(k, v)| format!("$env:{k} = {}\n", ps_quote(v)))
        .collect()
}

/// 程式結束後把終端機的特殊模式關掉：滑鼠追蹤（1000／1002／1003）、滑鼠座標格式（1005／1006／1015）、焦點事件（1004）、
/// 貼上括號（2004），再把游標顯示回來。pi 這類全螢幕程式被「關閉」直接結束時來不及自己還原，
/// 不關的話之後移動滑鼠，PowerShell 會一直印出「[555;102;30M」這種字。
#[cfg_attr(not(windows), allow(dead_code))]
const TERMINAL_RESET_PS: &str = "$esc = [char]27; [Console]::Write((@('?1000l', '?1002l', '?1003l', '?1005l', '?1006l', '?1015l', '?1004l', '?2004l', '?25h') | ForEach-Object { $esc + '[' + $_ }) -join '')";

#[cfg_attr(not(windows), allow(dead_code))]
fn build_window_script_env(title: &str, command: &str, args: &[String], env: &[(String, String)]) -> String {
    let env_set = env_lines(env);
    let mut call = format!("& {}", ps_quote(command));
    for a in args {
        call.push(' ');
        call.push_str(&ps_quote(a));
    }
    format!(
        "try {{ $Host.UI.RawUI.WindowTitle = {title} }} catch {{}}\n\
         {env_set}\
         $code = 0\n\
         try {{\n\
         {call}\n\
         $code = $LASTEXITCODE\n\
         }} catch {{\n\
         Write-Host ('[ASN] 無法啟動：' + $_.Exception.Message) -ForegroundColor Red\n\
         $code = -1\n\
         }}\n\
         {reset}\n\
         Write-Host ''\n\
         Write-Host ('[ASN] 程式已結束（結束碼 ' + $code + '）。上面如果有錯誤訊息請截圖回報；關閉這個視窗即可。') -ForegroundColor Yellow\n",
        title = ps_quote(title),
        env_set = env_set,
        call = call,
        reset = TERMINAL_RESET_PS
    )
}

/// -EncodedCommand 要的格式：UTF-16LE 的 Base64，中文、空白與引號都不必再跳脫。
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_ps_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// mux 窗格裡的結束標記：夥伴程式結束後印這一行（`nonce` 是開窗時隨機產生、記在對照表那一列的）。
/// WezTerm 的 Hold 不會把「程式結束」寫進 mux 的畫面緩衝（實測 get-text 只有程式自己的輸出），所以由 ASN 自己留標記。
pub(crate) fn exit_marker(nonce: &str, code: i32) -> String {
    format!("[asn-exit {nonce} {code}]")
}

/// 照 Windows 的命令列規則（CommandLineToArgvW）組一個參數：空字串 → `""`；不含空白與 `"` 的原樣；
/// 其餘用雙引號包住，`"` 前面的反斜線數量乘 2 再加 1（再接 `"`），結尾的反斜線乘 2，其他反斜線照原樣。
pub(crate) fn win_cmdline_arg(a: &str) -> String {
    if a.is_empty() {
        return "\"\"".into();
    }
    if !a.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '"')) {
        return a.to_string();
    }
    let mut out = String::with_capacity(a.len() + 2);
    out.push('"');
    let mut slashes = 0usize;
    for c in a.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.extend(std::iter::repeat('\\').take(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat('\\').take(slashes * 2));
    out.push('"');
    out
}

/// 多個參數接成一條命令列（不含程式本身）
pub(crate) fn win_cmdline(args: &[String]) -> String {
    args.iter().map(|a| win_cmdline_arg(a)).collect::<Vec<_>>().join(" ")
}

/// 命令列第 0 個是不是 cmd（只看檔名）、第 1 個是不是 /c 或 /k
fn is_cmd_switch(argv: &[String]) -> bool {
    let stem = argv.first().map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p).to_ascii_lowercase());
    matches!(stem.as_deref(), Some("cmd") | Some("cmd.exe")) && argv.get(1).is_some_and(|a| a.eq_ignore_ascii_case("/c") || a.eq_ignore_ascii_case("/k"))
}

/// 要交給 ProcessStartInfo 的命令列（不含程式本身）。
/// 一般程式照 [`win_cmdline`]。`cmd /c <程式> <參數…>` 要特別處理：cmd 對 /c 後面的字串有自己的去引號規則
/// （第一個字元是引號時，除非「剛好兩個引號、中間沒有 &<>()@^| 特殊字元、有空白、而且是個存在的執行檔」，
/// 否則會把第一個和最後一個引號拿掉），路徑含空白或括號（Program Files (x86)）又帶別的引號參數就會被拆錯。
/// 所以整串外面再包一層引號，cmd 拿掉的就是這一層，裡面原樣。
pub(crate) fn mux_cmdline(argv: &[String]) -> String {
    if is_cmd_switch(argv) {
        let inner = win_cmdline(&argv[2..]);
        return if inner.is_empty() { argv[1].clone() } else { format!("{} \"{}\"", argv[1], inner) };
    }
    if argv.len() > 1 { win_cmdline(&argv[1..]) } else { String::new() }
}

/// 交給包裝殼之前先把指令解析好：ProcessStartInfo 不像 `&` 會找 PATHEXT，也不能直接跑 .ps1。
/// 裸名（沒有路徑、沒有副檔名）照 `path`（窗格的 PATH）與 .exe／.cmd／.bat／.ps1 的順序找；找不到就原樣交出去，由包裝殼明確回無法啟動。
/// .ps1 改由 PowerShell 跑。其他照舊
pub(crate) fn resolve_for_wrap(argv: &[String], path: Option<&str>, is_file: &dyn Fn(&Path) -> bool) -> Vec<String> {
    let Some(first) = argv.first() else { return Vec::new() };
    let bare = !first.contains(['\\', '/']) && Path::new(first).extension().is_none();
    let mut prog = first.clone();
    if bare {
        let hit = path.unwrap_or("").split(';').filter(|d| !d.is_empty()).find_map(|d| {
            ["exe", "cmd", "bat", "ps1"].iter().map(|e| Path::new(d.trim_matches('"')).join(format!("{first}.{e}"))).find(|p| is_file(p))
        });
        if let Some(p) = hit {
            prog = p.to_string_lossy().into_owned();
        }
    }
    let rest = argv[1..].iter().cloned();
    if prog.to_ascii_lowercase().ends_with(".ps1") {
        return ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"].iter().map(|s| s.to_string()).chain(std::iter::once(prog)).chain(rest).collect();
    }
    std::iter::once(prog).chain(rest).collect()
}

/// 開在 mux 窗格裡的夥伴：外面包一層 PowerShell，跑完原指令後印 [`exit_marker`]。
/// 全部走 -EncodedCommand（UTF-16LE Base64），中文路徑與引號不必跳脫。
/// 原指令不用 `&` 呼叫：PowerShell 5.1 傳原生參數會壞（雙引號、空字串、結尾反斜線，順序也亂）。
/// 改用 ProcessStartInfo，命令列由這裡照 Windows 規則（[`mux_cmdline`]）組好；程式路徑與命令列都放成單引號字面值。
/// 沒有重導向，子程序沿用窗格的主控台。不用 -NoExit：程式結束、標記印完後承載就結束，窗格靠 exit_behavior=Hold 留著。
///
/// 印標記那段放在 `finally`：夥伴和包裝殼共用同一個主控台，按 Ctrl+C 時 PowerShell 會停掉管線，
/// `WaitForExit()` 之後的語句不會跑，catch 也接不到；`$code` 先設成 STATUS_CONTROL_C_EXIT（-1073741510，被中斷），
/// finally 裡程序已結束拿得到 ExitCode 才覆蓋。
///
/// 環境：包裝殼自己是 `powershell -ExecutionPolicy Bypass`，PowerShell 啟動時會在自己的環境裡加 PSExecutionPolicyPreference 與
/// 擴充 PSModulePath，子程序會繼承到。PSExecutionPolicyPreference 一律移除；PSModulePath 還原成窗格開窗時給的值
/// （`ps_module_path`，沒給就移除），夥伴看到的環境跟沒包裝時一樣。
pub(crate) fn mux_wrapped_argv(argv: &[String], nonce: &str, ps_module_path: Option<&str>) -> Vec<String> {
    let prog = argv.first().map(String::as_str).unwrap_or("");
    let rest = mux_cmdline(argv);
    let module_line = match ps_module_path {
        Some(v) => format!("$psi.EnvironmentVariables['PSModulePath'] = {}", ps_quote(v)),
        None => "$psi.EnvironmentVariables.Remove('PSModulePath')".to_string(),
    };
    let script = format!(
        "$code = -1073741510\n\
         $p = $null\n\
         try {{\n\
         $psi = New-Object Diagnostics.ProcessStartInfo {prog}, {rest}\n\
         $psi.UseShellExecute = $false\n\
         $psi.EnvironmentVariables.Remove('PSExecutionPolicyPreference')\n\
         {module_line}\n\
         $p = [Diagnostics.Process]::Start($psi)\n\
         $p.WaitForExit()\n\
         $code = $p.ExitCode\n\
         }} catch {{\n\
         Write-Host ('[ASN] 無法啟動：' + $_.Exception.Message) -ForegroundColor Red\n\
         $code = -1\n\
         }} finally {{\n\
         try {{ if ($null -ne $p -and $p.HasExited) {{ $code = $p.ExitCode }} }} catch {{}}\n\
         {reset}\n\
         Write-Host ''\n\
         Write-Host ('[ASN] 程式已結束（結束碼 ' + $code + '）') -ForegroundColor DarkGray\n\
         Write-Host ('[asn-exit {nonce} ' + $code + ']') -ForegroundColor Black -BackgroundColor Black\n\
         }}\n",
        prog = ps_quote(prog),
        rest = ps_quote(&rest),
        reset = TERMINAL_RESET_PS
    );
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    vec![format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"), "-NoLogo".into(), "-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-EncodedCommand".into(), encode_ps_command(&script)]
}

/// 外層 PowerShell（承載視窗）的參數字串：-NoExit 讓視窗留著。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn window_launcher_args(title: &str, command: &str, args: &[String]) -> String {
    window_launcher_args_env(title, command, args, &[])
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn window_launcher_args_env(title: &str, command: &str, args: &[String], env: &[(String, String)]) -> String {
    let enc = encode_ps_command(&build_window_script_env(title, command, args, env));
    format!("-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand {enc}")
}

/// 解析啟動器的 stdout／stderr，得到外層視窗的 PID；失敗時把原文帶進錯誤。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_launcher_output(stdout: &str, stderr: &str, success: bool) -> Result<u32, String> {
    if let Ok(pid) = stdout.trim().parse::<u32>() {
        if pid > 0 {
            return Ok(pid);
        }
    }
    let detail = [stderr.trim(), stdout.trim()]
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let detail: String = detail.chars().take(600).collect();
    let head = if success { "Start-Process 沒有回傳 PID" } else { "開不起來" };
    if detail.is_empty() {
        Err(head.to_string())
    } else {
        Err(format!("{head}：{detail}"))
    }
}

/// 退路：原生主控台（#476 的開法；0.2.0 起只在自帶終端找不到或開不起來時用）。
/// 回傳的 PID 是「承載視窗的 PowerShell」，不是 claude 本身（claude 是它的子程序、共用同一個主控台）。
/// 主控台顯示／隱藏另外靠 ~/.claude/sessions 依名字找 claude 的 PID，不依賴這個值。
#[cfg(windows)]
fn start_console_window_windows(title: &str, command: &str, args: &[String], cwd: &Path, hidden: bool, env: &[(String, String)]) -> Result<u32, String> {
    // 退路一律用 Windows 原生主控台開（#476）：明確交給 conhost.exe，不管這台的預設終端機是什麼。
    // Windows Terminal 的所有視窗共用同一個程序，只要使用者開著別的 WT 視窗，ASN 開的夥伴就無法單獨切前景／背景；
    // 原生主控台一個程序一扇視窗，現有的切換本來就支援。
    // 失敗要大聲：舊版 Start-Process 出錯時 PowerShell 仍以結束碼 0 離開、stdout 空白、stderr 被丟掉，
    // 使用者只看到「沒有回傳 PID」。這裡 Stop + catch，錯誤原文走 stderr 並以結束碼 1 回報。
    let script = r#"
$ErrorActionPreference = 'Stop'
$a = $env:ASN_LAUNCH_ARGS; $d = $env:ASN_LAUNCH_DIR; $w = $env:ASN_LAUNCH_STYLE
Remove-Item env:ASN_LAUNCH_ARGS, env:ASN_LAUNCH_DIR, env:ASN_LAUNCH_STYLE, env:IRORI_LAUNCH_ARGS, env:IRORI_LAUNCH_DIR, env:IRORI_LAUNCH_STYLE -ErrorAction SilentlyContinue
if (-not $w) { $w = 'Normal' }
try {
  $c = $env:SystemRoot + '\System32\conhost.exe'
  $ps = $env:SystemRoot + '\System32\WindowsPowerShell\v1.0\powershell.exe'
  $p = Start-Process -FilePath $c -ArgumentList ('"' + $ps + '" ' + $a) -WorkingDirectory $d -WindowStyle $w -PassThru
  # 回傳承載視窗的 PowerShell（conhost 的子程序），跟以前一樣；等不到就回 conhost 自己
  $id = $p.Id
  for ($i = 0; $i -lt 30; $i++) {
    $k = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id) and Name='powershell.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($k) { $id = $k.ProcessId; break }
    Start-Sleep -Milliseconds 100
  }
  if ($id -eq $p.Id) { [Console]::Error.WriteLine('等不到 conhost 底下的 powershell，回傳 conhost 的 PID') }
  [Console]::Out.Write($id)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
"#;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let ps = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let cwd_s = strip_verbatim_prefix(&cwd.to_string_lossy());
    let style = if hidden { "Hidden" } else { "Normal" };
    let mut cmd = Command::new(&ps);
    cmd.no_window()
        .env_clear()
        .envs(super::config::child_env())
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("ASN_LAUNCH_ARGS", window_launcher_args_env(title, command, args, env))
        .env("ASN_LAUNCH_DIR", &cwd_s)
        .env("ASN_LAUNCH_STYLE", style)
        .env("IRORI_LAUNCH_ARGS", window_launcher_args_env(title, command, args, env))
        .env("IRORI_LAUNCH_DIR", &cwd_s)
        .env("IRORI_LAUNCH_STYLE", style)
        .current_dir(&cwd_s)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("開不起來：{e}"))?;
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let r = parse_launcher_output(&stdout, &stderr, out.status.success());
    // 開起來了但有話要說（例如等不到 powershell、回傳的是 conhost 的 PID）：記一行，不當成失敗
    if r.is_ok() && !stderr.trim().is_empty() {
        elog!("開夥伴視窗：{}", stderr.trim());
    }
    r
}

#[cfg(not(windows))]
fn start_window_unix(command: &str, args: &[String], cwd: &Path, env: &[(String, String)]) -> Result<u32, String> {
    let joined = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(quote_arg)
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(term) = pick_linux_terminal() {
        let mut cmd = Command::new(&term.binary);
        cmd.env_clear().envs(super::config::child_env()).envs(env.iter().map(|(k, v)| (k, v)));
        cmd.args(&term.args_prefix)
            .args(&term.args_suffix)
            .arg(&joined)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("開不起來：{e}"))?;
        return Ok(child.id());
    }
    let mut cmd = Command::new(command);
    cmd.env_clear().envs(super::config::child_env()).envs(env.iter().map(|(k, v)| (k, v)));
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("開不起來：{e}"))?;
    Ok(child.id())
}

#[cfg(not(windows))]
struct Term {
    binary: String,
    args_prefix: Vec<String>,
    args_suffix: Vec<String>,
}

#[cfg(not(windows))]
fn pick_linux_terminal() -> Option<Term> {
    let path = std::env::var("PATH").unwrap_or_default();
    let tries: &[(&str, &[&str], &[&str])] = &[
        ("gnome-terminal", &[] as &[&str], &["--", "bash", "-lc"]),
        ("konsole", &[], &["-e", "bash", "-lc"]),
        ("xfce4-terminal", &[], &["-e", "bash", "-lc"]),
        ("xterm", &[], &["-e", "bash", "-lc"]),
    ];
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        for (name, pre, suf) in tries {
            let p = format!("{dir}/{name}");
            if std::path::Path::new(&p).is_file() {
                return Some(Term {
                    binary: p,
                    args_prefix: pre.iter().map(|s| s.to_string()).collect(),
                    args_suffix: suf.iter().map(|s| s.to_string()).collect(),
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 沒有工作資料夾_背景夥伴先擋下_再寫佇列或型號() {
        let src = include_str!("local.rs").replace("\r\n", "\n");
        let bg = src.find("if prof.mode == LaunchMode::Background {").unwrap();
        let (guard, set, queue) = (src[bg..].find("return Err(NO_WORK_DIR").unwrap(), src[bg..].find("acp_models::set(").unwrap(), src[bg..].find("enqueue_background(work_dir").unwrap());
        assert!(guard < set && guard < queue);
    }

    fn sv_wrap(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    // 路徑寫法只有 Windows 對得上（Linux 的 join 用 /）；這段也只有 Windows 開窗用得到
    #[cfg(windows)]
    #[test]
    fn 包裝前解析_裸名照順序找_ps1_交給_powershell_其他不動() {
        let only = |names: &'static [&'static str]| move |p: &Path| names.iter().any(|n| p.to_string_lossy().ends_with(n));
        let path = Some(r"C:\a;C:\b b");
        assert_eq!(resolve_for_wrap(&sv_wrap(&["claude", "-n"]), path, &only(&[r"C:\b b\claude.cmd"])), sv_wrap(&[r"C:\b b\claude.cmd", "-n"]));
        assert_eq!(resolve_for_wrap(&sv_wrap(&["claude"]), path, &only(&[r"C:\a\claude.exe", r"C:\a\claude.cmd"]))[0], r"C:\a\claude.exe", "exe 優先");
        assert_eq!(resolve_for_wrap(&sv_wrap(&["找不到", "x"]), path, &only(&[])), sv_wrap(&["找不到", "x"]), "找不到就原樣，由包裝殼回無法啟動");
        assert_eq!(resolve_for_wrap(&sv_wrap(&[r"C:\x y\a.cmd", "q"]), path, &only(&[])), sv_wrap(&[r"C:\x y\a.cmd", "q"]), "有路徑不找");
        assert_eq!(resolve_for_wrap(&sv_wrap(&["powershell.exe", "-c"]), path, &only(&[r"C:\a\powershell.exe.exe"])), sv_wrap(&["powershell.exe", "-c"]), "有副檔名不找");
        let ps = resolve_for_wrap(&sv_wrap(&["claude", "中文 參數"]), path, &only(&[r"C:\a\claude.ps1"]));
        assert_eq!(ps[0], "powershell.exe");
        assert_eq!(&ps[5..], sv_wrap(&["-File", r"C:\a\claude.ps1", "中文 參數"]).as_slice());
        assert!(resolve_for_wrap(&[], path, &only(&[])).is_empty());
    }

    #[test]
    fn 包裝殼的結束畫面_有中文_標記藏起來但內容還在() {
        let argv = mux_wrapped_argv(&sv_wrap(&["a.exe"]), "abc", None);
        let enc = argv.last().unwrap();
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, enc).unwrap();
        let wide: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let script = String::from_utf16(&wide).unwrap();
        assert!(script.contains("程式已結束"), "{script}");
        assert!(script.contains("[asn-exit abc ' + $code + ']') -ForegroundColor Black -BackgroundColor Black"), "{script}");
    }

    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    const 起點: u64 = 1_700_000_000_000;

    fn 工作階段(pid: u64, name: &str) -> Value {
        json!({ "pid": pid, "name": name, "kind": "interactive", "startedAt": 起點 + pid })
    }

    /// 程序建立時間：和 session 的 startedAt 同一刻（同一個程序）
    fn 同一刻(pid: u32) -> Option<u64> {
        Some(起點 + u64::from(pid) - 2_000)
    }

    /// 開之前的查法：console::resolve_live_partner（partner_console_query 同一個 resolve_pid＋建立時間核對）
    fn 查同名(engine: &str, name: &str, sessions: Vec<Value>, alive: &dyn Fn(u32) -> bool) -> Option<u32> {
        查同名_建立時間(engine, name, sessions, alive, &同一刻)
    }

    fn 查同名_建立時間(engine: &str, name: &str, sessions: Vec<Value>, alive: &dyn Fn(u32) -> bool, created: &dyn Fn(u32) -> Option<u64>) -> Option<u32> {
        let src = super::super::console_resolve::Sources { sessions, ..Default::default() };
        super::super::console::resolve_live_partner(engine, name, &src, alive, created)
    }

    #[test]
    fn pid被重用或查不到建立時間_當作不在_照常開新的() {
        let ss = || vec![工作階段(8936, "B4正式")];
        assert_eq!(查同名_建立時間("claude", "B4正式", ss(), &|_| true, &|p| 同一刻(p)), Some(8936), "名字對、pid 活著、建立時間也對");
        // 程序是 session 之後很久才建立的（pid 被無關程序重用），或早了很多
        assert_eq!(查同名_建立時間("claude", "B4正式", ss(), &|_| true, &|_| Some(起點 + 8936 + 3_600_000)), None);
        assert_eq!(查同名_建立時間("claude", "B4正式", ss(), &|_| true, &|_| Some(起點 - 3_600_000)), None);
        // 不對稱容差：程序比 startedAt 早 30 秒（啟動慢）算同一個，晚 30 秒不算
        assert_eq!(查同名_建立時間("claude", "B4正式", ss(), &|_| true, &|_| Some(起點 + 8936 - 30_000)), Some(8936));
        assert_eq!(查同名_建立時間("claude", "B4正式", ss(), &|_| true, &|_| Some(起點 + 8936 + 30_000)), None);
        // 拿不到建立時間：不確定就當作不在
        assert_eq!(查同名_建立時間("claude", "B4正式", ss(), &|_| true, &|_| None), None);
        assert!(existing_partner_reply(None, || panic!("對不上就不該去切前景")).is_none());
        // 對不上的舊記錄不擋住真正活著的同名夥伴
        let two = vec![工作階段(100, "B4正式"), 工作階段(200, "B4正式")];
        assert_eq!(查同名_建立時間("claude", "B4正式", two, &|_| true, &|p| if p == 100 { 同一刻(p) } else { Some(1) }), Some(100));
    }

    #[test]
    fn 同名夥伴還活著_不開新的_回existing並帶pid() {
        let live = 查同名("claude", "B4正式", vec![工作階段(8936, "B4正式")], &|_| true);
        assert_eq!(live, Some(8936));
        let mut called = false;
        let out = existing_partner_reply(live, || {
            called = true;
            json!({ "ok": true, "visible": true })
        })
        .expect("同名活夥伴要沿用，不能照常開新的");
        assert!(called, "要把它切到前景");
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["existing"], json!(true));
        assert_eq!(out["pid"], json!(8936));
        assert!(out.get("reason").is_none(), "切成功不帶原因");
    }

    #[test]
    fn 切前景失敗仍回existing_附原因_不另開() {
        let out = existing_partner_reply(Some(8936), || json!({ "ok": false, "reason": "找不到這個夥伴的主控台視窗" })).unwrap();
        assert_eq!(out["existing"], json!(true));
        assert_eq!(out["pid"], json!(8936));
        assert_eq!(out["reason"], json!("找不到這個夥伴的主控台視窗"));
    }

    #[test]
    fn 同名但已結束_照常開新的() {
        // 程序不在（舊視窗結束、mux 死窗格的 claude 也一樣不在）：不算活著
        let live = 查同名("claude", "B4正式", vec![工作階段(8936, "B4正式")], &|_| false);
        assert_eq!(live, None);
        assert!(existing_partner_reply(live, || panic!("沒有活的就不該去切前景")).is_none());
    }

    #[test]
    fn 不同名_照常開新的() {
        let live = 查同名("claude", "B5測試", vec![工作階段(8936, "B4正式")], &|_| true);
        assert_eq!(live, None);
        assert!(existing_partner_reply(live, || panic!("不同名不該動別人的視窗")).is_none());
    }

    #[test]
    fn 名稱比對_跟夥伴主控台查詢同一套_逐字相同才算同名() {
        // 沒有另外的正規化：開夥伴的名字本來就限英數、連字號與中文（valid_partner_name，不含空白），查詢也是逐字比對
        let ss = || vec![工作階段(8936, "B4正式")];
        assert_eq!(查同名("claude", "b4正式", ss(), &|_| true), None, "大小寫不同不算同名");
        assert_eq!(查同名("claude", "B4正式 ", ss(), &|_| true), None);
        assert!(!super::super::config::valid_partner_name("B4 正式"), "名字不可能含空白");
        // 同名多筆取最近啟動且活著的
        let two = vec![工作階段(100, "B4正式"), 工作階段(200, "B4正式")];
        assert_eq!(查同名("claude", "B4正式", two, &|p| p == 100), Some(100));
    }

    #[test]
    fn 守門_開窗前先查同名活夥伴() {
        let src = include_str!("local.rs");
        let f = src.split("pub fn partner_launch_local").nth(1).unwrap().split("pub(crate) enum ModelPlan").next().unwrap();
        let check = f.find("existing_partner_reply(").expect("本機開新夥伴要先查同名");
        assert!(f.contains("console::live_partner_pid("), "活著的判斷要用 partner_console_query 同一套");
        assert!(f.contains("initial_dropped"), "同名夥伴已在跑時，填了的開場訊息要標示沒送出");
        for open in ["start_window_noted(", "open_pi_real("] {
            assert!(check < f.find(open).unwrap(), "查同名要在 {open} 之前");
        }
    }

    #[test]
    fn 開新夥伴選型號_claude視窗帶model_內建通道記下_其他廠牌報錯() {
        assert_eq!(launch_model_plan("claude", false, ""), Ok(ModelPlan::None));
        assert_eq!(launch_model_plan("claude", false, "  "), Ok(ModelPlan::None), "空白＝不指定");
        assert_eq!(launch_model_plan("claude", false, "sonnet"), Ok(ModelPlan::Arg("sonnet".into())));
        assert!(launch_model_plan("", false, "opus").is_err(), "沒寫 engine 的自訂 profile 不補 --model");
        assert_eq!(launch_model_plan("gemini", true, "gemini-3.8-flash-high"), Ok(ModelPlan::Record("gemini-3.8-flash-high".into())));
        assert!(launch_model_plan("codex", false, "gpt-5.5").is_err(), "Codex 視窗先不帶型號");
        assert!(launch_model_plan("claude", false, "--dangerously").is_err(), "不能以 - 開頭（會被當成旗標）");
        assert!(launch_model_plan("claude", false, "a b").is_err());
    }

    #[test]
    fn 帶型號_拿掉原有的model_補在最後() {
        let a = sv(&["--dangerously-skip-permissions", "-n", "小乙", "--model", "opus", "--remote-control", "小乙"]);
        assert_eq!(with_model_arg(&a, "haiku"), sv(&["--dangerously-skip-permissions", "-n", "小乙", "--remote-control", "小乙", "--model", "haiku"]));
        assert_eq!(with_model_arg(&sv(&["--model=opus", "-n", "x"]), "sonnet"), sv(&["-n", "x", "--model", "sonnet"]));
        assert_eq!(with_model_arg(&[], "sonnet"), sv(&["--model", "sonnet"]));
    }

    fn decode(enc: &str) -> String {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(enc).unwrap();
        let u: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&u).unwrap()
    }

    #[test]
    fn 彎單引號也加倍_路徑裡有它不會讓字串提前結束() {
        assert_eq!(ps_quote("it\u{2019}s"), "'it\u{2019}\u{2019}s'");
        assert_eq!(ps_quote("\u{2018}\u{201A}\u{201B}"), "'\u{2018}\u{2018}\u{201A}\u{201A}\u{201B}\u{201B}'");
        assert_eq!(ps_quote(r"C:\使用者\牧’陽"), "'C:\\使用者\\牧\u{2019}\u{2019}陽'");
        assert_eq!(ps_quote("a'\u{2019}b"), "'a''\u{2019}\u{2019}b'");
    }

    #[test]
    fn windows_命令列_照_commandlinetoargvw_規則組() {
        let a = win_cmdline_arg;
        assert_eq!(a("plain"), "plain");
        assert_eq!(a(""), r#""""#);
        assert_eq!(a("a b"), r#""a b""#);
        assert_eq!(a("中文 牧陽"), r#""中文 牧陽""#);
        assert_eq!(a("中文"), "中文", "沒有空白與引號就原樣");
        assert_eq!(a(r#"a"b"#), r#""a\"b""#);
        assert_eq!(a(r#"he said "hi""#), r#""he said \"hi\"""#);
        assert_eq!(a(r"x\"), r"x\", "不含空白的結尾反斜線原樣");
        assert_eq!(a(r"C:\Program Files\x\"), r#""C:\Program Files\x\\""#, "結尾反斜線乘 2");
        assert_eq!(a(r"C:\a\b c"), r#""C:\a\b c""#, "路徑中間的反斜線不動");
        assert_eq!(a(r#"a\"b c"#), r#""a\\\"b c""#, "引號前的反斜線乘 2 再加 1");
        let args: Vec<String> = ["a\"b", "", "a b", "中文 牧陽", "x\\", "he said \"hi\"", "C:\\Program Files\\x\\", "it\u{2019}s"].iter().map(|s| s.to_string()).collect();
        // 反過來照規則拆回去要得到原參數
        let parsed = crate::launch::switch::parse_cmdline(&format!("prog {}", win_cmdline(&args)));
        assert_eq!(parsed[1..], args[..]);
    }

    fn decode_script(w: &[String]) -> String {
        let enc = &w[w.iter().position(|a| a == "-EncodedCommand").unwrap() + 1];
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(enc).unwrap();
        let u: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&u).unwrap()
    }

    #[test]
    fn 包裝腳本_標記放在_finally_被中斷時預設結束碼是_ctrl_c() {
        let w = mux_wrapped_argv(&["claude.exe".to_string()], "abc", None);
        let s = decode_script(&w);
        assert!(s.starts_with("$code = -1073741510\n"), "{s}");
        let fin = s.split("} finally {").nth(1).expect("要有 finally 區塊");
        assert!(fin.contains("[asn-exit abc '"), "標記在 finally 裡：{s}");
        assert!(fin.contains("$p.HasExited") && fin.contains("$code = $p.ExitCode"), "{s}");
        let before = s.split("} finally {").next().unwrap();
        assert!(!before.contains("[asn-exit"), "try／catch 裡不印標記：{s}");
    }

    #[test]
    fn 包裝腳本_夥伴環境不帶_powershell_自己加的變數() {
        let s = decode_script(&mux_wrapped_argv(&["claude.exe".to_string()], "abc", Some(r"C:\mods;D:\m’x")));
        assert!(s.contains("$psi.EnvironmentVariables.Remove('PSExecutionPolicyPreference')"), "{s}");
        assert!(s.contains(r"$psi.EnvironmentVariables['PSModulePath'] = 'C:\mods;D:\m’’x'"), "還原成開窗時給的值（彎引號加倍）：{s}");
        let s = decode_script(&mux_wrapped_argv(&["claude.exe".to_string()], "abc", None));
        assert!(s.contains("$psi.EnvironmentVariables.Remove('PSModulePath')"), "沒給就移除：{s}");
    }

    /// cmd /c 對後面字串的去引號規則（`cmd /?`）：第一個字元是引號時，同時符合四點才原樣（剛好兩個引號、中間沒有特殊字元、有空白、是執行檔名），
    /// 否則拿掉第一個與最後一個引號
    fn cmd_c_effective(line: &str) -> String {
        if !line.starts_with('"') {
            return line.to_string();
        }
        let quotes = line.matches('"').count();
        let keep = quotes == 2 && {
            let inner = &line[1..line.find('"').map(|_| line[1..].find('"').unwrap() + 1).unwrap()];
            let low = inner.to_ascii_lowercase();
            !inner.chars().any(|c| "&<>()@^|".contains(c)) && inner.chars().any(char::is_whitespace) && (low.ends_with(".cmd") || low.ends_with(".exe"))
        };
        if keep {
            return line.to_string();
        }
        let last = line.rfind('"').unwrap();
        format!("{}{}", &line[1..last], &line[last + 1..])
    }

    #[test]
    fn codex_cmd_c_命令列_經過_cmd_的去引號規則後沒被拆錯() {
        let codex = |path: &str| -> Vec<String> { ["cmd.exe", "/c", path, "-c", "check_for_update_on_startup=false", "-s", "workspace-write", "-a", "on-request", "resume", "小乙"].iter().map(|s| s.to_string()).collect() };
        for path in [r"C:\Users\牧 陽\AppData\Roaming\npm\codex.cmd", r"C:\Program Files (x86)\nodejs\codex.cmd", r"C:\npm\codex.cmd"] {
            let line = mux_cmdline(&codex(path));
            let after_c = line.strip_prefix("/c ").unwrap();
            let eff = cmd_c_effective(after_c);
            let want = format!("{} -c check_for_update_on_startup=false -s workspace-write -a on-request resume 小乙", win_cmdline_arg(path));
            assert_eq!(eff, want, "cmd 實際執行的字串：{line}");
        }
        // 其他程式不受影響
        assert_eq!(mux_cmdline(&["claude.exe".to_string(), "-n".into(), "a b".into()]), "-n \"a b\"");
        assert_eq!(mux_cmdline(&["cmd.exe".to_string(), "/c".into()]), "/c");
    }

    #[test]
    fn 包裝腳本用_processstartinfo_不用_呼叫運算子() {
        let argv: Vec<String> = ["C:\\Users\\牧’陽\\claude.exe", "-n", "小 乙", ""].iter().map(|s| s.to_string()).collect();
        let w = mux_wrapped_argv(&argv, "abc", None);
        let enc = &w[w.iter().position(|a| a == "-EncodedCommand").unwrap() + 1];
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(enc).unwrap();
        let u: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let script = String::from_utf16(&u).unwrap();
        assert!(script.contains("New-Object Diagnostics.ProcessStartInfo 'C:\\Users\\牧’’陽\\claude.exe', '-n \"小 乙\" \"\"'"), "{script}");
        assert!(script.contains("UseShellExecute = $false") && script.contains("WaitForExit()") && script.contains("$p.ExitCode"));
        assert!(!script.contains("& '"), "不用 & 呼叫：{script}");
        assert!(script.contains("[asn-exit abc '"));
    }

    #[test]
    fn 單引號加倍_其他字元照原樣() {
        assert_eq!(ps_quote("a b"), "'a b'");
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(ps_quote("$x `y \"z\""), "'$x `y \"z\"'");
    }

    #[test]
    fn 長路徑前綴被去掉() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\a b"), r"C:\Users\a b");
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(strip_verbatim_prefix(r"C:\x"), r"C:\x");
    }

    #[test]
    fn 視窗腳本_路徑有空白_名字有中文() {
        let args: Vec<String> = ["--dangerously-skip-permissions", "-n", "小良哥-1", "--remote-control", "小良哥-1"].iter().map(|s| s.to_string()).collect();
        let sc = build_window_script("小良哥-1", r"C:\Program Files\Claude Code\claude.exe", &args);
        assert!(sc.contains(r"& 'C:\Program Files\Claude Code\claude.exe' '--dangerously-skip-permissions' '-n' '小良哥-1' '--remote-control' '小良哥-1'"));
        assert!(sc.contains("WindowTitle = '小良哥-1'"));
        assert!(sc.contains("程式已結束"));
        let reset = sc.find("?1003l").expect("結束後關掉滑鼠追蹤");
        assert!(reset < sc.find("程式已結束").unwrap(), "先還原終端機，再印結束訊息");
        assert!(sc.contains("'?1006l'") && sc.contains("'?1015l'") && sc.contains("'?1004l'"), "滑鼠座標格式與焦點事件也關掉");
    }

    #[test]
    fn 視窗腳本_先設環境變數再跑指令_單引號加倍() {
        let env = vec![("ASN_PI_NAME".to_string(), "小皮's".to_string()), ("bad name".to_string(), "x".to_string())];
        let sc = build_window_script_env("T", "pi", &["-e".to_string(), "C:/a b/index.ts".to_string()], &env);
        let set = sc.find("$env:ASN_PI_NAME = '小皮''s'").expect("有設名字");
        let call = sc.find("& 'pi' '-e' 'C:/a b/index.ts'").expect("有跑指令");
        assert!(set < call, "環境變數要在指令之前");
        assert!(!sc.contains("bad name"), "不合法的變數名丟掉");
        assert_eq!(build_window_script("T", "pi", &[]), build_window_script_env("T", "pi", &[], &[]), "沒有額外環境時和舊行為一樣");
        assert!(!build_window_script("T", "claude", &[]).contains("$env:"), "其他引擎的腳本不含任何環境設定");
    }

    #[test]
    fn 外層參數有_noexit_且編碼可還原() {
        let args = vec!["-n".to_string(), "測 試".to_string()];
        let a = window_launcher_args("測 試", "claude", &args);
        assert!(a.contains("-NoExit"));
        let enc = a.rsplit(' ').next().unwrap();
        assert!(decode(enc).contains("& 'claude' '-n' '測 試'"));
    }

    #[test]
    fn 啟動器輸出解析() {
        assert_eq!(parse_launcher_output("1234", "", true), Ok(1234));
        assert_eq!(parse_launcher_output(" 77\r\n", "", true), Ok(77));
        let e = parse_launcher_output("", "找不到檔案", false).unwrap_err();
        assert!(e.contains("開不起來") && e.contains("找不到檔案"));
        assert_eq!(parse_launcher_output("", "", true).unwrap_err(), "Start-Process 沒有回傳 PID");
        assert!(parse_launcher_output("oops", "", true).unwrap_err().contains("oops"));
    }

    /// 真機手動測試：用 cmd /k 走同一條啟動路徑，確認有回傳 PID、視窗留著（3 秒後仍活著），最後只關自己開的那一棵。
    /// 執行：cargo test --manifest-path src-tauri/Cargo.toml -- --ignored 真機_視窗會留著 --nocapture
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn 真機_視窗會留著() {
        let dir = std::env::temp_dir();
        let pid = start_console_window_windows("ASN 測試", "cmd.exe", &["/c".into(), "echo ASN 測試 & exit 3".into()], &dir, false, &[]).unwrap();
        println!("ASN_TEST_PID={pid}");
        std::thread::sleep(std::time::Duration::from_secs(3));
        let list = Command::new("tasklist").no_window().args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        let alive = String::from_utf8_lossy(&list.stdout).contains(&pid.to_string());
        let _ = Command::new("taskkill").no_window().args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        assert!(alive, "指令結束後外層視窗應該還在（-NoExit）");
    }

    /// 回歸：舊版 Start-Process 失敗時結束碼 0、stdout 空白，錯誤原文被吞掉。現在要回傳帶原文的錯誤。
    #[cfg(windows)]
    #[test]
    fn 啟動失敗_錯誤原文會被帶出來() {
        let bad = Path::new(r"C:\ASN-不存在的資料夾-xyz");
        let e = start_console_window_windows("t", "cmd.exe", &[], bad, true, &[]).unwrap_err();
        assert!(e.starts_with("開不起來"), "{e}");
        assert!(e.len() > "開不起來：".len(), "{e}");
    }
}
