//! 本機視窗名單：讀 `~/.claude/sessions/<pid>.json`（Claude Code 自己維護的 session 檔），不用呼叫 `claude agents`。
//! 對應 engines/claude.mjs 的 listWindows：只留互動式（kind=interactive）、entrypoint=cli、pid 還活著的視窗，
//! 排除收發室 worker 自己。回報格式照 bridge.mjs 的 roster：`{agents:[{name,status,cwd_label,engine}], launcher}`。
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub name: String,
    pub status: Option<String>,
    pub cwd: String,
    pub pid: u32,
    /// 最後活動時間（毫秒）
    pub updated_at: u64,
    /// Claude 的 session 編號（session 檔的 sessionId）；夥伴 ID 用它判斷「同一位夥伴換名或換 session」（#109）
    pub session_id: Option<String>,
    /// 這個視窗由哪個引擎轉交：claude（預設）／acp／codex
    pub engine: String,
    /// 名單上顯示的引擎名（例如 acp 工作者回報 gemini）；路由仍依 engine
    pub engine_label: Option<String>,
    /// 沒指定收件人又找不到預設視窗時，不拿它當代收者（背景工作者）
    pub no_fallback: bool,
    /// 名單上顯示的資料夾標籤（ACP 工作者用設定的 label，不用資料夾名）
    pub cwd_label_override: Option<String>,
    /// Claude Code 外掛狀態檔給的補充說明（背景工作 2 件／等你回答…，最多 80 字）；沒有外掛或檔案無效就是 None，名單不帶這個欄位
    pub detail: Option<String>,
    /// 外掛狀態檔 context.percent（上下文已用百分比，0～100 整數）；沒有或不合格就是 None，名單不帶這個欄位
    pub context_pct: Option<u8>,
    /// 這個視窗有載入 ASN 外掛（外掛狀態檔有效）；名單只在 true 時帶 mod_loaded
    pub mod_loaded: bool,
    /// 這個視窗背後實際用的模型（pi 視窗：「提供者/模型」，最多 60 字）；沒有就是 None，名單不帶這個欄位
    pub model: Option<String>,
    /// 這個 CLI 視窗的主控台視窗是否隱藏（Windows 才有）：只在確定找到那個程序自己的視窗時才有值；找不到、屬別人（Windows Terminal 分頁）、非 Windows、沒有視窗的引擎都是 None，名單不帶
    pub hidden: Option<bool>,
}

impl Window {
    /// 名單與夥伴同步回報的引擎名
    pub fn label(&self) -> &str {
        self.engine_label.as_deref().unwrap_or(&self.engine)
    }
    /// Claude 視窗（由 ~/.claude/sessions 讀出）
    pub fn claude(name: &str, status: Option<String>, cwd: &str, pid: u32, updated_at: u64, session_id: Option<String>) -> Window {
        Window { name: name.into(), status, cwd: cwd.into(), pid, updated_at, session_id, engine: "claude".into(), engine_label: None, no_fallback: false, cwd_label_override: None, detail: None, context_pct: None, mod_loaded: false, model: None, hidden: None }
    }
    pub fn cwd_label(&self) -> String {
        if let Some(l) = &self.cwd_label_override {
            return l.clone();
        }
        self.cwd.split(['\\', '/']).filter(|s| !s.is_empty()).last().unwrap_or("").to_string()
    }
    pub fn is_busy(&self) -> bool {
        is_busy_status(self.status.as_deref())
    }
}

/// 忙碌狀態（Node 橋預設 `^(busy|working|running)$`，不分大小寫）
pub fn is_busy_status(s: Option<&str>) -> bool {
    matches!(s.map(|x| x.to_lowercase()).as_deref(), Some("busy") | Some("working") | Some("running"))
}

/// 外掛狀態檔多久內算有效（毫秒）
pub const MOD_STATUS_MAX_AGE_MS: u64 = 30 * 60 * 1000;
/// 「忙碌類」狀態（busy／background／scheduled）的有效期：外掛每 5 分鐘至少重寫一次 at（心跳），
/// 超過 10 分鐘沒更新就是外掛停了或視窗卡死，不能一直顯示忙碌——不採用，回到 sessions/<pid>.json 給的狀態
pub const MOD_BUSY_MAX_AGE_MS: u64 = 10 * 60 * 1000;
const MOD_STATUS_MAX_BYTES: u64 = 16 * 1024;
const MOD_DETAIL_MAX_CHARS: usize = 80;
/// 外掛在 session 結束時寫的說明（外掛刪不了檔，只能寫 idle＋這句）；看到它就不採用，名單照 sessions/<pid>.json
pub const MOD_ENDED_DETAIL: &str = "已結束";

pub fn valid_sid(sid: &str) -> bool {
    !sid.is_empty() && sid.len() <= 128 && sid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 狀態檔的 state → (名單狀態, 預設說明)。
/// busy→busy、idle→idle、waiting_user→waiting（等人回答，名單上是暫離）、background／scheduled→busy（還有事在跑／排程中）。
/// 投遞語意（is_busy 只有 busy／working／running 算忙碌）：background／scheduled 算忙碌，所以「沒回覆」提醒會先等；
/// waiting_user 不算忙碌：視窗停在等人，不會自己回覆，提醒照常在逾時後送回寄件者（提醒是送給寄件者，不是插進這個視窗，不會打擾提問）。
fn map_mod_state(state: &str) -> Option<(&'static str, Option<&'static str>)> {
    Some(match state {
        "busy" => ("busy", None),
        "idle" => ("idle", None),
        "waiting_user" => ("waiting", Some("等你回答")),
        "background" => ("busy", Some("背景工作中")),
        "scheduled" => ("busy", Some("排程等待中")),
        _ => return None,
    })
}

/// 讀 `<dir>/<sessionId>.json`（Claude Code 外掛寫的狀態檔），合進視窗的狀態與說明。
/// 檔案不存在、讀到半份、JSON 壞、過期、sessionId 不符、state 不認得：整個忽略，維持 sessions/<pid>.json 給的 status。永遠不回錯。
pub fn apply_mod_status(windows: &mut [Window], dir: &Path, now_ms: u64) {
    for w in windows.iter_mut() {
        if w.engine != "claude" {
            continue;
        }
        let Some(sid) = w.session_id.clone() else { continue };
        // sessionId 要當檔名用：只收一般字元，擋掉路徑分隔與 ..
        if !valid_sid(&sid) {
            continue;
        }
        if let Some((status, detail, ctx)) = read_mod_status(&dir.join(format!("{sid}.json")), &sid, now_ms) {
            w.status = Some(status);
            w.detail = detail;
            w.context_pct = ctx;
            w.mod_loaded = true;
        }
    }
}

fn read_mod_status(path: &Path, sid: &str, now_ms: u64) -> Option<(String, Option<String>, Option<u8>)> {
    if std::fs::metadata(path).ok()?.len() > MOD_STATUS_MAX_BYTES {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    if v.get("sessionId").and_then(Value::as_str) != Some(sid) {
        return None;
    }
    let at = v.get("at").and_then(Value::as_u64)?;
    if now_ms.abs_diff(at) > MOD_STATUS_MAX_AGE_MS {
        return None; // 過期（或時間離譜地在未來）
    }
    if v.get("detail").and_then(Value::as_str).map(str::trim) == Some(MOD_ENDED_DETAIL) {
        return None; // session 已結束：不採用
    }
    let (status, default_detail) = map_mod_state(v.get("state").and_then(Value::as_str)?)?;
    if is_busy_status(Some(status)) && now_ms.abs_diff(at) > MOD_BUSY_MAX_AGE_MS {
        return None; // 忙碌太久沒心跳：不信
    }
    let raw: String = v.get("detail").and_then(Value::as_str).unwrap_or("").chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let raw = raw.trim();
    let detail = if raw.is_empty() { default_detail.map(String::from) } else { Some(raw.chars().take(MOD_DETAIL_MAX_CHARS).collect()) };
    Some((status.to_string(), detail, context_pct_of(&v)))
}

/// 狀態檔 context.percent → 0～100 整數（小數四捨五入）；不是數字、負數、超過 100、NaN 一律當沒有
pub fn context_pct_of(v: &Value) -> Option<u8> {
    let p = v.get("context")?.get("percent")?.as_f64()?;
    if p.is_finite() && (0.0..=100.0).contains(&p) { Some(p.round() as u8) } else { None }
}

/// 順手清掉 `<dir>` 底下過時的狀態檔：只刪檔名是合法 sessionId 的 .json、內容是完整 JSON 且 sessionId 與檔名相符、
/// 而且 `at` 已超過有效期，再加上（已結束，或這個 session 已不在現行視窗名單）。讀不了、半份、壞檔一律不動。
/// live_sids＝這一輪 sessions/<pid>.json 讀到的 sessionId；呼叫端讀 sessions 失敗時不要呼叫。回傳刪掉幾個。
pub fn cleanup_mod_status(dir: &Path, live_sids: &[String], now_ms: u64) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".json") else { continue };
        if !valid_sid(stem) {
            continue;
        }
        let path = e.path();
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MOD_STATUS_MAX_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if v.get("sessionId").and_then(Value::as_str) != Some(stem) {
            continue;
        }
        let Some(at) = v.get("at").and_then(Value::as_u64) else { continue };
        if now_ms < at || now_ms - at <= MOD_STATUS_MAX_AGE_MS {
            continue;
        }
        let ended = v.get("detail").and_then(Value::as_str).map(str::trim) == Some(MOD_ENDED_DETAIL);
        if (ended || !live_sids.iter().any(|s| s == stem)) && std::fs::remove_file(&path).is_ok() {
            n += 1;
        }
    }
    n
}

fn parse_session(v: &Value) -> Option<Window> {
    let pid = v.get("pid")?.as_u64()? as u32;
    if v.get("entrypoint").and_then(Value::as_str) != Some("cli") {
        return None;
    }
    if let Some(k) = v.get("kind").and_then(Value::as_str) {
        if k != "interactive" {
            return None;
        }
    }
    let name = v.get("name").and_then(Value::as_str)?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(Window::claude(
        &name,
        v.get("status").and_then(Value::as_str).map(String::from),
        v.get("cwd").and_then(Value::as_str).unwrap_or(""),
        pid,
        v.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
        v.get("sessionId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from),
    ))
}

/// session 檔的 startedAt（毫秒）早於這個值就不是毫秒時間戳（缺欄位、秒、亂值）：不拿來判斷程序身分
const MIN_EPOCH_MS: u64 = 100_000_000_000;
/// 程序建立時間可以比 session 檔的 startedAt 晚多少仍算同一個程序（時鐘與寫檔順序的誤差）
pub const SAME_PROC_TOLERANCE_MS: u64 = 60_000;

/// pid 對到的程序是不是 session 檔當初記錄的那個：程序是在 session 開始之後才建立的，就是 pid 被別的程序重用了。
/// 只在「確定不是」時回 false；查不到建立時間、startedAt 不可信一律當同一個（寧可多列一個，也不誤砍活著的視窗）。
pub fn same_process(started_at_ms: u64, created_ms: Option<u64>) -> bool {
    match created_ms {
        Some(c) if started_at_ms >= MIN_EPOCH_MS => c <= started_at_ms.saturating_add(SAME_PROC_TOLERANCE_MS),
        _ => true,
    }
}

/// 讀取失敗（資料夾存在卻讀不了）回 None，呼叫端沿用舊名單；資料夾不存在＝沒有任何視窗
pub fn read_sessions(dir: &Path, alive: impl Fn(u32) -> bool, exclude_pid: u32, exclude_name: &str) -> Option<Vec<Window>> {
    read_sessions_with(dir, |p, _| alive(p), exclude_pid, exclude_name)
}

/// 同 read_sessions，但 alive 多收 session 檔的 startedAt（毫秒，沒有就是 0），讓呼叫端能分辨「同一個程序」與「pid 被重用」
pub fn read_sessions_with(dir: &Path, alive: impl Fn(u32, u64) -> bool, exclude_pid: u32, exclude_name: &str) -> Option<Vec<Window>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(vec![]),
        Err(_) => return None,
    };
    let mut out: Vec<Window> = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".json") else { continue };
        let Ok(file_pid) = stem.parse::<u32>() else { continue };
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(w) = parse_session(&v) else { continue };
        let started = v.get("startedAt").and_then(Value::as_u64).unwrap_or(0);
        // 檔名的 pid 要和內容一致（identity.mjs 的 readSession 同），而且程序還活著、還是當初那個程序
        if w.pid != file_pid || !alive(w.pid, started) || w.pid == exclude_pid || w.name == exclude_name {
            continue;
        }
        out.push(w);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.pid.cmp(&b.pid)));
    Some(out)
}

/// 名單「有意義的變化」指紋：名字、狀態、說明三項（上下文百分比、at 心跳、pid 不算）。
/// 外掛每 5 分鐘只更新 at 的心跳不會改變指紋，所以不會觸發額外回報。
pub fn local_fingerprint(windows: &[Window]) -> String {
    let mut v: Vec<String> = windows.iter().map(|w| format!("{}\u{1}{}\u{1}{}", w.name, w.status.as_deref().unwrap_or(""), w.detail.as_deref().unwrap_or(""))).collect();
    v.sort();
    v.join("\u{2}")
}

/// 本機視窗狀態變了要不要立刻回報名單：指紋和上次回報時不同，而且距上次回報已過防抖間隔（頭一次變化馬上報，
/// 連續快速變化合併成每 gap 毫秒最多一次，最後一次變化一定會在間隔過後補報）
pub fn push_due(fp: &str, last_fp: Option<&str>, now_ms: u64, last_at: u64, gap_ms: u64) -> bool {
    last_fp.map(|l| l != fp).unwrap_or(false) && now_ms.saturating_sub(last_at) >= gap_ms
}

/// 只讀本機：sessions ＋ 外掛狀態檔組出視窗清單（給即時監看與前端直接讀本機狀態用，不寫檔、不碰後台）
pub fn read_local(sessions_dir: &Path, status_dir: &Path, alive: impl Fn(u32) -> bool, exclude_pid: u32, exclude_name: &str, now_ms: u64) -> Option<Vec<Window>> {
    read_local_with(sessions_dir, status_dir, |p, _| alive(p), exclude_pid, exclude_name, now_ms)
}

/// 同 read_local，alive 多收 startedAt（見 read_sessions_with）
pub fn read_local_with(sessions_dir: &Path, status_dir: &Path, alive: impl Fn(u32, u64) -> bool, exclude_pid: u32, exclude_name: &str, now_ms: u64) -> Option<Vec<Window>> {
    let mut l = read_sessions_with(sessions_dir, alive, exclude_pid, exclude_name)?;
    apply_mod_status(&mut l, status_dir, now_ms);
    Some(l)
}

/// 這個視窗的主控台視窗是否隱藏：沿用「背景／前台切換」找視窗的同一個函式 `console_resolve::find_for`
/// （候選鏈＝自己加往上的包裝殼，例如 ASN 開窗時包著 claude 的 powershell；Windows Terminal 只有單一分頁才算專屬）。
/// 只有確定找到才有值（`!visible`）；找不到、共用的 Windows Terminal 分頁、沒有程序編號（ACP、Codex）一律 None，不猜。
pub(crate) fn hidden_of(os: &dyn crate::launch::console_resolve::ConsoleOs, pid: u32) -> Option<bool> {
    if pid == 0 {
        return None;
    }
    crate::launch::console_resolve::find_for(pid, os).ok().map(|(_, w)| !w.visible)
}

/// 給有程序編號的視窗（Claude、pi）填上 hidden；ACP 工作者與 Codex 沒有程序編號（pid 0）、也沒有視窗，維持 None
pub(crate) fn apply_hidden(windows: &mut [Window], os: &dyn crate::launch::console_resolve::ConsoleOs) {
    for w in windows.iter_mut() {
        w.hidden = if w.engine == "claude" || w.engine == "pi" { hidden_of(os, w.pid) } else { None };
    }
}

/// roster 動作的請求內容。asn_window＝ASN 自己的視窗名（也列進名單，別台看得到這台的 ASN；engine 標 asn）。
/// launcher＝遠端開視窗的摘要（profile 名與標籤、cwd 白名單、上限；不含指令），沒有可用設定送 null，仲介就清掉。
pub fn roster_body(windows: &[Window], asn_window: Option<&str>, launcher: Value) -> Value {
    roster_body_with_procs(windows, asn_window, launcher, &[])
}

/// 同 roster_body，另附本機掃到的執行中代理（僅顯示：`kind:"process"`、`receivable:false`）；名字與既有條目相同的略過，不干擾視窗
pub fn roster_body_with_procs(windows: &[Window], asn_window: Option<&str>, launcher: Value, procs: &[super::procscan::ProcAgent]) -> Value {
    let mut agents: Vec<Value> = windows
        .iter()
        .map(|w| {
            let mut o = json!({ "name": w.name, "status": w.status, "cwd_label": w.cwd_label(), "engine": w.label() });
            if let Some(d) = &w.detail {
                o["detail"] = json!(d); // 可選欄位：舊後台會丟掉，舊用戶端看不到也不壞
            }
            if let Some(p) = w.context_pct {
                o["context_pct"] = json!(p); // 可選欄位：舊後台會丟掉，舊用戶端略過
            }
            if w.mod_loaded {
                o["mod_loaded"] = json!(true); // 可選欄位：這個視窗有載入外掛；舊後台會丟掉，舊用戶端略過
            }
            if let Some(m) = &w.model {
                o["model"] = json!(m); // 可選欄位：背後的模型；後台名單本來就收 model，舊用戶端略過
            }
            if let Some(h) = w.hidden {
                o["hidden"] = json!(h); // 可選欄位：主控台視窗是否隱藏；舊後台會丟掉，舊用戶端略過
            }
            o
        })
        .collect();
    if let Some(n) = asn_window {
        if !windows.iter().any(|w| w.name == n) {
            agents.push(json!({ "name": n, "status": "idle", "cwd_label": "", "engine": "asn" }));
        }
    }
    for p in procs {
        let name = p.name();
        if !agents.iter().any(|a| a["name"] == json!(name)) {
            agents.push(p.to_json());
        }
    }
    json!({ "agents": agents, "launcher": launcher })
}

/// 外掛狀態回報的間隔：沒變化時最久每 30 分鐘補報一次（後台有存，補報只是保險，不高頻）
pub const MOD_REPORT_REFRESH_MS: u64 = 30 * 60 * 1000;

/// 這一輪名單回報要不要附上這台電腦的外掛狀態（`mod` 欄位）。
/// report＝目前狀態（None＝沒在檢查，例如截圖模式，不報）；last＝上次成功回報的（內容, 時間）。
/// 內容有變、或距上次超過 MOD_REPORT_REFRESH_MS 才報，否則回 None（名單照舊不帶這個欄位）。
pub fn mod_report_due(report: Option<Value>, last: Option<&(String, u64)>, now_ms: u64) -> Option<Value> {
    let r = report?;
    let text = r.to_string();
    match last {
        Some((t, at)) if *t == text && now_ms.saturating_sub(*at) < MOD_REPORT_REFRESH_MS => None,
        _ => Some(r),
    }
}

/// partner_sync 的請求內容（#109）：每個視窗的名字、session 編號（沒有就不送）、引擎。節點由後端依金鑰決定，這裡不送。
/// ASN 自己的視窗也列進去（引擎 asn、沒有 session），和 roster 一樣與同名的 Claude 視窗不重複。
pub fn partner_body(windows: &[Window], asn_window: Option<&str>) -> Value {
    let mut ws: Vec<Value> = windows
        .iter()
        .map(|w| {
            let mut o = json!({ "name": w.name, "engine": w.label() });
            if let Some(s) = &w.session_id {
                o["session_id"] = json!(s);
            }
            o
        })
        .collect();
    if let Some(n) = asn_window {
        if !windows.iter().any(|w| w.name == n) {
            ws.push(json!({ "name": n, "engine": "asn" }));
        }
    }
    json!({ "windows": ws })
}

/// 夥伴 ID 的格式（與後端 partners_id_check 同）：p_ 加 20 個小寫十六進位字元
pub fn valid_partner_id(s: &str) -> bool {
    s.len() == 22 && s.starts_with("p_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// partner_sync 的回應 `{ok, partners:[{name, partner_id}]}` → 視窗名對夥伴 ID；格式不對的項目略過
pub fn parse_partners(resp: &Value) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for p in resp.get("partners").and_then(Value::as_array).into_iter().flatten() {
        if let (Some(n), Some(id)) = (p.get("name").and_then(Value::as_str), p.get("partner_id").and_then(Value::as_str)) {
            if !n.is_empty() && valid_partner_id(id) {
                m.insert(n.to_string(), id.to_string());
            }
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(d: &Path, pid: u32, v: Value) {
        std::fs::write(d.join(format!("{pid}.json")), v.to_string()).unwrap();
    }

    #[test]
    fn 只留活著的互動式_cli_視窗_排除收發室與壞檔() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), 101, json!({"pid":101,"name":"T-甲","cwd":"D:\\x\\proj","status":"idle","kind":"interactive","entrypoint":"cli","updatedAt":50}));
        put(d.path(), 102, json!({"pid":102,"name":"T-乙","cwd":"/home/u/work/","status":"busy","entrypoint":"cli"}));
        put(d.path(), 103, json!({"pid":103,"name":"T-死了","entrypoint":"cli"}));
        put(d.path(), 104, json!({"pid":104,"name":"T-背景","kind":"background","entrypoint":"cli"}));
        put(d.path(), 105, json!({"pid":105,"name":"T-sdk","entrypoint":"sdk-cli"}));
        put(d.path(), 106, json!({"pid":106,"name":"","entrypoint":"cli"}));
        put(d.path(), 107, json!({"pid":999,"name":"T-檔名對不上","entrypoint":"cli"}));
        put(d.path(), 108, json!({"pid":108,"name":"T-收發室","entrypoint":"cli"}));
        put(d.path(), 109, json!({"pid":109,"name":"worker","entrypoint":"cli"}));
        std::fs::write(d.path().join("110.json"), "{壞").unwrap();
        std::fs::write(d.path().join("notes.txt"), "x").unwrap();
        let alive = |p: u32| p != 103;
        let ws = read_sessions(d.path(), alive, 109, "T-收發室").unwrap();
        assert_eq!(ws.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["T-乙", "T-甲"]);
        assert_eq!(ws[1].cwd_label(), "proj");
        assert_eq!(ws[0].cwd_label(), "work");
        assert!(ws[0].is_busy() && !ws[1].is_busy());
        assert_eq!(ws[1].updated_at, 50);
    }

    #[test]
    fn 讀得到_session_編號_沒有或空白就是_none() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), 201, json!({"pid":201,"name":"T-有","entrypoint":"cli","sessionId":" 11111111-aaaa "}));
        put(d.path(), 202, json!({"pid":202,"name":"T-無","entrypoint":"cli"}));
        put(d.path(), 203, json!({"pid":203,"name":"T-空","entrypoint":"cli","sessionId":"  "}));
        let ws = read_sessions(d.path(), |_| true, 0, "x").unwrap();
        let by = |n: &str| ws.iter().find(|w| w.name == n).unwrap().session_id.clone();
        assert_eq!(by("T-有").as_deref(), Some("11111111-aaaa"));
        assert_eq!(by("T-無"), None);
        assert_eq!(by("T-空"), None);
    }

    fn put_status(d: &Path, sid: &str, v: Value) {
        std::fs::write(d.join(format!("{sid}.json")), v.to_string()).unwrap();
    }

    fn win(sid: &str, status: &str) -> Window {
        Window::claude("T-甲", Some(status.into()), "", 1, 0, Some(sid.into()))
    }

    // ---- 主控台視窗是否隱藏（hidden）：假的視窗與程序表，沿用 find_for ----
    use crate::launch::console_resolve::{ConsoleOs, ConsoleWin};
    use crate::launch::switch::Proc;

    struct FakeOs {
        console: Vec<(u32, bool)>,
        wt: Vec<(u32, bool)>,
        procs: Vec<Proc>,
    }
    impl ConsoleOs for FakeOs {
        fn find_console(&self, pid: u32) -> Option<ConsoleWin> {
            let v: Vec<_> = self.console.iter().filter(|(p, _)| *p == pid).collect();
            (v.len() == 1).then(|| ConsoleWin { hwnd: 0, visible: v[0].1 })
        }
        fn find_wt_windows(&self, wt_pid: u32) -> Vec<ConsoleWin> {
            self.wt.iter().filter(|(p, _)| *p == wt_pid).map(|(_, v)| ConsoleWin { hwnd: 0, visible: *v }).collect()
        }
        fn table(&self) -> Vec<Proc> {
            self.procs.clone()
        }
        fn own_pid(&self) -> u32 {
            900
        }
    }
    fn pr(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }
    fn base_procs() -> Vec<Proc> {
        vec![
            pr(4, 0, "system"),
            pr(100, 4, "explorer.exe"),
            pr(900, 100, "asn.exe"),
            // 自己擁有視窗：claude.exe(10)；ASN 開窗：powershell.exe(20) 包著 claude.exe(21)，視窗是殼的
            pr(10, 100, "claude.exe"),
            pr(20, 100, "powershell.exe"),
            pr(21, 20, "claude.exe"),
            // Windows Terminal(30)：一個分頁（OpenConsole 40）裡的 claude.exe(31)；另一個 WT(50) 有兩個分頁（OpenConsole 60、61）
            pr(30, 100, "windowsterminal.exe"),
            pr(40, 30, "openconsole.exe"),
            pr(31, 40, "claude.exe"),
            pr(50, 100, "windowsterminal.exe"),
            pr(60, 50, "openconsole.exe"),
            pr(61, 50, "openconsole.exe"),
            pr(51, 60, "claude.exe"),
            pr(52, 61, "claude.exe"),
            pr(70, 100, "claude.exe"),
        ]
    }

    #[test]
    fn hidden_沿用_find_for_自己或往上的殼擁有視窗_隱藏或顯示() {
        let os = FakeOs { console: vec![(10, false), (20, true)], wt: vec![], procs: base_procs() };
        assert_eq!(hidden_of(&os, 10), Some(true), "自己擁有視窗且隱藏");
        assert_eq!(hidden_of(&os, 21), Some(false), "父殼（powershell）擁有視窗：ASN 開的視窗也找得到，顯示中");
        let os2 = FakeOs { console: vec![(20, false)], wt: vec![], procs: base_procs() };
        assert_eq!(hidden_of(&os2, 21), Some(true), "父殼擁有的視窗被隱藏");
    }

    #[test]
    fn hidden_找不到或不確定一律不帶() {
        let os = FakeOs { console: vec![(10, false)], wt: vec![], procs: base_procs() };
        assert_eq!(hidden_of(&os, 70), None, "找不到視窗");
        assert_eq!(hidden_of(&os, 0), None, "沒有程序編號（ACP、Codex）");
        assert_eq!(hidden_of(&os, 900), None, "自己（ASN）與祖先不碰");
        let dup = FakeOs { console: vec![(10, false), (10, true)], wt: vec![], procs: base_procs() };
        assert_eq!(hidden_of(&dup, 10), None, "同一個程序有兩個視窗，不猜");
        // Windows Terminal：整個程序有兩個分頁＝共用，不能單獨隱藏
        let shared = FakeOs { console: vec![], wt: vec![(50, true)], procs: base_procs() };
        assert_eq!(hidden_of(&shared, 51), None);
        assert_eq!(hidden_of(&shared, 52), None);
        // 空快照（非 Windows、測試環境）
        let empty = FakeOs { console: vec![], wt: vec![], procs: vec![] };
        assert_eq!(hidden_of(&empty, 10), None);
    }

    #[test]
    fn hidden_windows_terminal_只有單一分頁才算專屬_和切換功能一致() {
        let one = FakeOs { console: vec![], wt: vec![(30, false)], procs: base_procs() };
        assert_eq!(hidden_of(&one, 31), Some(true), "單一分頁的 Windows Terminal 視窗被隱藏");
        let one_shown = FakeOs { console: vec![], wt: vec![(30, true)], procs: base_procs() };
        assert_eq!(hidden_of(&one_shown, 31), Some(false));
    }

    #[test]
    fn hidden_只填_claude_與_pi_視窗_acp_與_codex_維持沒有() {
        let os = FakeOs { console: vec![(10, false), (20, true)], wt: vec![], procs: base_procs() };
        let mk = |engine: &str, pid: u32| {
            let mut w = Window::claude("名", None, "", pid, 0, None);
            w.engine = engine.into();
            w
        };
        let mut ws = vec![mk("claude", 10), mk("claude", 21), mk("claude", 70), mk("pi", 10), mk("acp", 10), mk("codex", 10)];
        apply_hidden(&mut ws, &os);
        assert_eq!(ws.iter().map(|w| w.hidden).collect::<Vec<_>>(), vec![Some(true), Some(false), None, Some(true), None, None]);
        // 名單 JSON：有值才帶 hidden，沒有就不帶這個欄位（舊後台、舊用戶端不受影響）
        let b = roster_body(&ws, None, Value::Null);
        let a = b["agents"].as_array().unwrap();
        assert_eq!(a[0]["hidden"], json!(true));
        assert_eq!(a[1]["hidden"], json!(false));
        assert!(a[2].get("hidden").is_none() && a[4].get("hidden").is_none() && a[5].get("hidden").is_none(), "{a:?}");
        // 重新套用會洗掉舊值（視窗後來被顯示出來）
        let os2 = FakeOs { console: vec![(10, true), (20, true)], wt: vec![], procs: base_procs() };
        apply_hidden(&mut ws, &os2);
        assert_eq!(ws[0].hidden, Some(false));
    }

    const NOW: u64 = 10_000_000_000;

    #[test]
    fn 外掛狀態檔_有效就以它為準_state_對照與預設說明() {
        let d = tempfile::tempdir().unwrap();
        for (state, want, detail) in [
            ("busy", "busy", None),
            ("idle", "idle", None),
            ("waiting_user", "waiting", Some("等你回答")),
            ("background", "busy", Some("背景工作中")),
            ("scheduled", "busy", Some("排程等待中")),
        ] {
            put_status(d.path(), "s1", json!({"sessionId":"s1","state":state,"at":NOW - 1000}));
            let mut ws = [win("s1", "idle")];
            apply_mod_status(&mut ws, d.path(), NOW);
            assert_eq!(ws[0].status.as_deref(), Some(want), "{state}");
            assert_eq!(ws[0].detail.as_deref(), detail, "{state}");
        }
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"background","detail":"背景工作 2 件\n第二行","at":NOW}));
        let mut ws = [win("s1", "idle")];
        apply_mod_status(&mut ws, d.path(), NOW);
        assert_eq!(ws[0].detail.as_deref(), Some("背景工作 2 件 第二行"));
        assert!(ws[0].is_busy());
        // waiting 不算忙碌（提醒照送）
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"waiting_user","at":NOW}));
        apply_mod_status(&mut ws, d.path(), NOW);
        assert!(!ws[0].is_busy());
    }

    #[test]
    fn 忙碌類狀態超過_10_分鐘沒心跳就不採用_閒置類仍可到_30_分鐘() {
        let d = tempfile::tempdir().unwrap();
        for state in ["busy", "background", "scheduled"] {
            put_status(d.path(), "s1", json!({"sessionId":"s1","state":state,"at":NOW - MOD_BUSY_MAX_AGE_MS - 1}));
            let mut ws = [win("s1", "idle")];
            apply_mod_status(&mut ws, d.path(), NOW);
            assert!(!ws[0].mod_loaded && ws[0].status.as_deref() == Some("idle"), "{state} 過期要回到原狀態");
            put_status(d.path(), "s1", json!({"sessionId":"s1","state":state,"at":NOW - MOD_BUSY_MAX_AGE_MS}));
            let mut ws = [win("s1", "idle")];
            apply_mod_status(&mut ws, d.path(), NOW);
            assert_eq!(ws[0].status.as_deref(), Some("busy"), "{state} 邊界內仍採用");
        }
        for state in ["idle", "waiting_user"] {
            put_status(d.path(), "s1", json!({"sessionId":"s1","state":state,"at":NOW - MOD_BUSY_MAX_AGE_MS - 1}));
            let mut ws = [win("s1", "busy")];
            apply_mod_status(&mut ws, d.path(), NOW);
            assert!(ws[0].mod_loaded, "{state} 不受忙碌期限影響");
        }
    }

    #[test]
    fn 指紋只看名字_狀態_說明_心跳與上下文不算_順序無關() {
        let mk = |st: &str, d: Option<&str>, pct: Option<u8>| { let mut w = win("s1", st); w.detail = d.map(String::from); w.context_pct = pct; w.updated_at = 5; w };
        let a = vec![mk("idle", None, Some(10)), { let mut w = Window::claude("T-乙", Some("busy".into()), "", 2, 0, None); w.detail = None; w }];
        let mut b = a.clone();
        b.reverse();
        b[1].context_pct = Some(90);
        b[1].updated_at = 99;
        assert_eq!(local_fingerprint(&a), local_fingerprint(&b));
        let mut c = a.clone();
        c[0].status = Some("busy".into());
        assert_ne!(local_fingerprint(&a), local_fingerprint(&c));
        let mut e = a.clone();
        e[0].detail = Some("背景工作中".into());
        assert_ne!(local_fingerprint(&a), local_fingerprint(&e));
        assert_ne!(local_fingerprint(&a), local_fingerprint(&a[..1]));
    }

    #[test]
    fn 立即回報時機_沒變不報_變了且過防抖就報_防抖內等到間隔後補報_沒有基準不報() {
        assert!(!push_due("x", Some("x"), 10_000, 0, 1500));
        assert!(push_due("y", Some("x"), 10_000, 0, 1500));
        assert!(!push_due("y", Some("x"), 10_000, 9_000, 1500));
        assert!(push_due("y", Some("x"), 10_500, 9_000, 1500));
        assert!(!push_due("y", None, 10_000, 0, 1500));
    }

    #[test]
    fn 外掛狀態檔_說明截_80_字() {
        let d = tempfile::tempdir().unwrap();
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"waiting_user","detail":"問".repeat(200),"at":NOW}));
        let mut ws = [win("s1", "idle")];
        apply_mod_status(&mut ws, d.path(), NOW);
        assert_eq!(ws[0].detail.as_ref().unwrap().chars().count(), 80);
    }

    #[test]
    fn 外掛狀態檔_不存在_半份_壞_過期_不符_全部忽略並保留原狀態() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        put_status(p, "old", json!({"sessionId":"old","state":"busy","at":NOW - MOD_STATUS_MAX_AGE_MS - 1}));
        put_status(p, "mismatch", json!({"sessionId":"other","state":"busy","at":NOW}));
        put_status(p, "badstate", json!({"sessionId":"badstate","state":"flying","at":NOW}));
        put_status(p, "noat", json!({"sessionId":"noat","state":"busy"}));
        put_status(p, "future", json!({"sessionId":"future","state":"busy","at":NOW + MOD_STATUS_MAX_AGE_MS + 1}));
        std::fs::write(p.join("half.json"), "{\"sessionId\":\"half\",\"sta").unwrap();
        std::fs::write(p.join("junk.json"), "不是 json").unwrap();
        std::fs::write(p.join("big.json"), format!("{{\"sessionId\":\"big\",\"state\":\"busy\",\"at\":{NOW},\"detail\":\"{}\"}}", "x".repeat(20_000))).unwrap();
        for sid in ["gone", "old", "mismatch", "badstate", "noat", "future", "half", "junk", "big", "..", "a/b", "a\\b", ""] {
            let mut ws = [win(sid, "idle")];
            apply_mod_status(&mut ws, p, NOW);
            assert_eq!(ws[0].status.as_deref(), Some("idle"), "{sid}");
            assert_eq!(ws[0].detail, None, "{sid}");
        }
        // 沒有 sessionId：不碰
        let mut ws = [Window::claude("T", Some("idle".into()), "", 1, 0, None)];
        apply_mod_status(&mut ws, p, NOW);
        assert_eq!(ws[0].status.as_deref(), Some("idle"));
        // 狀態資料夾不存在
        let mut ws = [win("s1", "busy")];
        apply_mod_status(&mut ws, &p.join("none"), NOW);
        assert_eq!(ws[0].status.as_deref(), Some("busy"));
    }

    #[test]
    fn 外掛狀態檔_已結束不採用_同輪連寫以最後內容為準() {
        let d = tempfile::tempdir().unwrap();
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"idle","detail":"已結束","at":NOW}));
        let mut ws = [win("s1", "busy")];
        apply_mod_status(&mut ws, d.path(), NOW);
        assert_eq!((ws[0].status.as_deref(), ws[0].detail.as_deref()), (Some("busy"), None));
        // 連寫兩次：後寫的內容就是現況（即使 at 較小，只要仍在有效期內）
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"busy","at":NOW}));
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"waiting_user","at":NOW - 5}));
        apply_mod_status(&mut ws, d.path(), NOW);
        assert_eq!(ws[0].status.as_deref(), Some("waiting"));
    }

    #[test]
    fn 清理過時狀態檔_只刪合法檔名且完整且過期且已結束或_session_不在() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        let old = NOW - MOD_STATUS_MAX_AGE_MS - 1;
        put_status(p, "ended-old", json!({"sessionId":"ended-old","state":"idle","detail":"已結束","at":old}));
        put_status(p, "ended-live", json!({"sessionId":"ended-live","state":"idle","detail":"已結束","at":old}));
        put_status(p, "gone-old", json!({"sessionId":"gone-old","state":"busy","at":old}));
        put_status(p, "live-old", json!({"sessionId":"live-old","state":"busy","at":old}));
        put_status(p, "ended-new", json!({"sessionId":"ended-new","state":"idle","detail":"已結束","at":NOW - 1000}));
        put_status(p, "gone-new", json!({"sessionId":"gone-new","state":"busy","at":NOW - 1000}));
        put_status(p, "mismatch", json!({"sessionId":"other","state":"busy","at":old}));
        std::fs::write(p.join("half.json"), "{\"sessionId\":\"half\",\"sta").unwrap();
        std::fs::write(p.join("bad name.json"), json!({"sessionId":"bad name","at":old}).to_string()).unwrap();
        std::fs::write(p.join("notes.txt"), "x").unwrap();
        let n = cleanup_mod_status(p, &["live-old".to_string(), "ended-live".to_string()], NOW);
        assert_eq!(n, 3);
        let left = |f: &str| p.join(f).exists();
        assert!(!left("ended-old.json") && !left("gone-old.json") && !left("ended-live.json"));
        for f in ["live-old.json", "ended-new.json", "gone-new.json", "mismatch.json", "half.json", "bad name.json", "notes.txt"] {
            assert!(left(f), "{f} 不該被刪");
        }
        assert_eq!(cleanup_mod_status(&p.join("none"), &[], NOW), 0);
    }

    #[test]
    fn 名單回報_有說明才帶_detail_欄位_沒有就和以前一模一樣() {
        let mut w = Window::claude("T-甲", Some("busy".into()), "D:\\a\\b", 1, 0, None);
        assert_eq!(roster_body(&[w.clone()], None, Value::Null)["agents"][0], json!({"name":"T-甲","status":"busy","cwd_label":"b","engine":"claude"}));
        w.detail = Some("背景工作 2 件".into());
        assert_eq!(roster_body(&[w], None, Value::Null)["agents"][0], json!({"name":"T-甲","status":"busy","cwd_label":"b","engine":"claude","detail":"背景工作 2 件"}));
    }

    #[test]
    fn 夥伴同步的請求內容_名字_session_引擎_不含節點_asn_視窗不重複() {
        let a = Window::claude("T-甲", None, "", 1, 0, Some("sess-0001-aaaa".into()));
        let b = Window::claude("T-乙", None, "", 2, 0, None);
        let body = partner_body(&[a.clone(), b.clone()], Some("T-ASN"));
        assert_eq!(body, json!({"windows": [
            {"name":"T-甲","engine":"claude","session_id":"sess-0001-aaaa"},
            {"name":"T-乙","engine":"claude"},
            {"name":"T-ASN","engine":"asn"},
        ]}));
        assert!(body.get("node").is_none());
        assert_eq!(partner_body(&[a, b], Some("T-乙"))["windows"].as_array().unwrap().len(), 2);
        assert_eq!(partner_body(&[], None), json!({"windows": []}));
    }

    #[test]
    fn 夥伴同步的回應_只收格式正確的夥伴_id() {
        let ok = format!("p_{}", "0123456789abcdef0123");
        let r = json!({"ok": true, "partners": [
            {"name":"T-甲","partner_id": ok},
            {"name":"T-壞1","partner_id":"p_XYZ"},
            {"name":"T-壞2","partner_id":"q_0123456789abcdef0123"},
            {"name":"","partner_id": ok},
            {"partner_id": ok},
            "x",
        ]});
        let m = parse_partners(&r);
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("T-甲").map(String::as_str), Some(ok.as_str()));
        assert!(parse_partners(&json!({"ok": true})).is_empty());
        assert!(valid_partner_id(&ok) && !valid_partner_id("p_0123456789ABCDEF0123") && !valid_partner_id("p_0123"));
    }

    #[test]
    fn 資料夾不存在是空名單_讀不了才是_none() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_sessions(&d.path().join("none"), |_| true, 0, "x"), Some(vec![]));
        // 把檔案當資料夾：讀不了
        let f = d.path().join("file");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(read_sessions(&f, |_| true, 0, "x"), None);
    }

    #[test]
    fn 回報內容格式_含_asn_視窗名_launcher_摘要或_null() {
        let w = Window::claude("T-甲", Some("idle".into()), "D:\\a\\b", 1, 0, None);
        let b = roster_body(&[w.clone()], Some("T-ASN"), Value::Null);
        assert_eq!(b["launcher"], Value::Null);
        assert_eq!(roster_body(&[w.clone()], None, json!({"profiles": []}))["launcher"], json!({"profiles": []}));
        assert_eq!(b["agents"][0], json!({"name":"T-甲","status":"idle","cwd_label":"b","engine":"claude"}));
        assert_eq!(b["agents"][1], json!({"name":"T-ASN","status":"idle","cwd_label":"","engine":"asn"}));
        // 不給 ASN 視窗名就只有 Claude 視窗；與視窗同名不重複列
        assert_eq!(roster_body(&[w], None, Value::Null)["agents"].as_array().unwrap().len(), 1);
        let w2 = Window::claude("T-ASN", None, "", 2, 0, None);
        assert_eq!(roster_body(&[w2], Some("T-ASN"), Value::Null)["agents"].as_array().unwrap().len(), 1);
        assert!(is_busy_status(Some("Working")) && !is_busy_status(Some("idle")) && !is_busy_status(None));
    }

    #[test]
    fn 外掛狀態檔_上下文百分比_合格才收_小數四捨五入_其餘當沒有() {
        let d = tempfile::tempdir().unwrap();
        let mut ws = [win("s1", "busy")];
        for (ctx, want) in [
            (json!({"used":1,"limit":2,"percent":85}), Some(85u8)),
            (json!({"percent":92.6}), Some(93)),
            (json!({"percent":0}), Some(0)),
            (json!({"percent":100}), Some(100)),
            (json!({"percent":-1}), None),
            (json!({"percent":101}), None),
            (json!({"percent":"80"}), None),
            (json!({"used":5}), None),
            (json!(7), None),
        ] {
            put_status(d.path(), "s1", json!({"sessionId":"s1","state":"busy","at":NOW,"context":ctx}));
            ws[0].context_pct = Some(1);
            apply_mod_status(&mut ws, d.path(), NOW);
            assert_eq!(ws[0].context_pct, want, "{ctx}");
        }
        // 狀態檔沒有 context 欄位＝None
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"idle","at":NOW}));
        apply_mod_status(&mut ws, d.path(), NOW);
        assert_eq!(ws[0].context_pct, None);
    }

    #[test]
    fn 名單回報_有上下文百分比才帶_context_pct_欄位_沒有就和以前一模一樣() {
        let mut w = Window::claude("T-甲", Some("busy".into()), "/a/b", 1, 0, None);
        assert_eq!(roster_body(&[w.clone()], None, Value::Null)["agents"][0], json!({"name":"T-甲","status":"busy","cwd_label":"b","engine":"claude"}));
        w.context_pct = Some(85);
        assert_eq!(roster_body(&[w], None, Value::Null)["agents"][0], json!({"name":"T-甲","status":"busy","cwd_label":"b","engine":"claude","context_pct":85}));
    }

    #[test]
    fn 外掛狀態檔有效才算視窗有載入外掛_名單只在有載入時帶_mod_loaded() {
        let d = tempfile::tempdir().unwrap();
        put_status(d.path(), "s1", json!({"sessionId":"s1","state":"idle","at":NOW}));
        let mut ws = vec![win("s1", "idle"), win("s2", "idle")];
        apply_mod_status(&mut ws, d.path(), NOW);
        assert_eq!([ws[0].mod_loaded, ws[1].mod_loaded], [true, false], "只有狀態檔有效的那個");
        let b = roster_body(&ws, None, Value::Null);
        assert_eq!(b["agents"][0]["mod_loaded"], json!(true));
        assert!(b["agents"][1].get("mod_loaded").is_none(), "沒外掛不帶欄位，和以前一模一樣");
        // 過期的狀態檔不算
        let mut old = vec![win("s1", "idle")];
        apply_mod_status(&mut old, d.path(), NOW + MOD_STATUS_MAX_AGE_MS + 1);
        assert!(!old[0].mod_loaded);
    }

    #[test]
    fn 外掛狀態回報時機_第一次與有變化才報_沒變化超過_30_分鐘補報_沒有狀態不報() {
        let a = json!({"state":"checking"});
        let b = json!({"state":"installed","version":"0.4.2"});
        assert_eq!(mod_report_due(None, None, 1000), None, "沒有在檢查（截圖模式）不報");
        assert_eq!(mod_report_due(Some(a.clone()), None, 1000), Some(a.clone()), "第一次");
        let last = (a.to_string(), 1000);
        assert_eq!(mod_report_due(Some(a.clone()), Some(&last), 1000 + 60_000), None, "沒變化、一分鐘後不重報");
        assert_eq!(mod_report_due(Some(a.clone()), Some(&last), 1000 + MOD_REPORT_REFRESH_MS - 1), None);
        assert_eq!(mod_report_due(Some(a.clone()), Some(&last), 1000 + MOD_REPORT_REFRESH_MS), Some(a.clone()), "滿 30 分鐘補報");
        assert_eq!(mod_report_due(Some(b.clone()), Some(&last), 2000), Some(b), "有變化立刻報");
    }

    #[test]
    fn 程序身分_建立時間晚於_session_開始就是_pid_被重用_查不到或_startedat_不可信一律當同一個() {
        let st = 1_800_000_000_000u64;
        assert!(same_process(st, Some(st - 5_000)), "程序先建立、session 後開始＝同一個");
        assert!(same_process(st, Some(st + SAME_PROC_TOLERANCE_MS)), "誤差內");
        assert!(!same_process(st, Some(st + SAME_PROC_TOLERANCE_MS + 1)), "session 開始之後才建立的程序＝別的程序");
        assert!(same_process(st, None), "查不到建立時間：不誤砍");
        assert!(same_process(0, Some(st)), "沒有 startedAt：不判斷");
        assert!(same_process(1234, Some(st)), "startedAt 不是毫秒時間戳：不判斷");
    }

    #[test]
    fn 名單_pid_被重用的幽靈_session_檔不列_真的視窗與沒有_startedat_的照列() {
        let d = tempfile::tempdir().unwrap();
        let st = 1_800_000_000_000u64;
        put(d.path(), 301, json!({"pid":301,"name":"T-真的","entrypoint":"cli","startedAt":st}));
        put(d.path(), 302, json!({"pid":302,"name":"T-幽靈","entrypoint":"cli","startedAt":st}));
        put(d.path(), 303, json!({"pid":303,"name":"T-舊檔無時間","entrypoint":"cli"}));
        put(d.path(), 304, json!({"pid":304,"name":"T-查不到","entrypoint":"cli","startedAt":st}));
        let created = |p: u32| match p { 301 => Some(st - 1_000), 302 => Some(st + 3_600_000), 303 => Some(st + 3_600_000), _ => None };
        let ws = read_sessions_with(d.path(), |p, s| same_process(s, created(p)), 0, "x").unwrap();
        assert_eq!(ws.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["T-查不到", "T-真的", "T-舊檔無時間"]);
        // 舊的介面（只給 pid）行為不變
        assert_eq!(read_sessions(d.path(), |_| true, 0, "x").unwrap().len(), 4);
    }
}
