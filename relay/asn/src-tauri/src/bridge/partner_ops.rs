//! 遠端管理夥伴視窗（電腦端執行）：手機對話頁「⋯」選單下令，後台排進 `partner_op_pending`，這裡取走、在本機執行、回報 `partner_op_result`。
//! 設計與安全規則見 docs/design/PARTNER-OPS.md；外掛控制檔格式見該文件「外掛控制檔格式」一節。
//!
//! 動作：info（唯讀）、rename、model、close、handover。作業系統動作（讀命令列、列程序、結束、開視窗）全走
//! `launch/switch.rs` 的 `Os` 介面與 `OpsEnv`，測試用假實作，不會真的開視窗或結束程序。
//!
//! 守門（每條都有單元測試與還原驗證）：
//! 1. 只依 `~/.claude/sessions/<pid>.json` 對上名字與 sessionId 才動手，對不上回錯；
//! 2. 絕不用名稱或命令列字串去找程序（命令列只拿來確認「這個已確認的 pid 看起來是 claude」與讀它的啟動參數）；
//! 3. 使用者自己開的視窗（父殼不是 ASN 開的）只結束 claude 與子孫，留下終端機，不送關閉訊息；
//! 4. 除 info 外，本機設定「允許遠端開視窗」必須開著，執行前與動手前各驗一次；
//! 5. 收發室視窗與 ASN 自己的視窗、不是 claude 的程序一律不動；
//! 6. 每個操作都寫內建收發室 log 與該夥伴的往來記錄。


use super::core::BridgeLog;
use super::corrlog::{CorrLog, Dir, Entry};
use super::roster;
use crate::launch::config::valid_partner_name;
use crate::launch::console;
use crate::launch::switch::{self, Os, Plan, Proc, SwitchRunReq, Timing};
use crate::relay::Relay;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const KNOWN_OPS: [&str; 5] = ["info", "rename", "model", "close", "handover"];
pub(crate) const DETAIL_MAX: usize = 500;
pub(crate) const RESULT_MAX_BYTES: usize = 4096;
pub(crate) const CONSENT_OFF: &str = "這台電腦沒有開啟「允許遠端開視窗與管理視窗」";
const PROTECTED: &str = "收發室與 ASN 自己的視窗不能操作";
const CHAIN_MAX: usize = 12;

/// 轉交的固定第一句話
pub(crate) fn default_handover_note(name: &str) -> String {
    format!("你是『{name}』的下一任，前任的上下文用完了。先讀你與收發室的往來記錄（信尾那行的路徑）和前任留下的交接檔，接著把手上的工作做下去。")
}

/// 轉交的第一句話：固定文字；使用者補了話就換行附上「前任交代：…」
pub(crate) fn handover_prompt(name: &str, note: &str) -> String {
    let note = note.trim();
    if note.is_empty() {
        default_handover_note(name)
    } else {
        format!("{}
前任交代：{}", default_handover_note(name), note.chars().take(1000).collect::<String>())
    }
}

/// 作業系統與本機設定這一側（測試換成假的）
pub(crate) trait OpsEnv: Send + Sync {
    fn os(&self) -> &dyn Os;
    /// 本機設定「允許遠端開視窗與管理視窗」現在是開的嗎（每次現讀，不快取）
    fn allow_remote(&self) -> bool;
    /// 開視窗（乾淨環境）
    fn launch(&self, plan: &Plan) -> Result<(), String>;
    fn now_ms(&self) -> u64;
    fn timing(&self) -> Timing;
    /// 等外掛回報的最長時間
    fn mod_wait_ms(&self) -> u64;
}

pub(crate) struct SystemOpsEnv {
    pub data_dir: PathBuf,
}

impl OpsEnv for SystemOpsEnv {
    fn os(&self) -> &dyn Os {
        &switch::RealOs
    }
    fn allow_remote(&self) -> bool {
        super::read_settings(&self.data_dir).allow_remote_launch
    }
    fn launch(&self, plan: &Plan) -> Result<(), String> {
        switch::real_launch(plan)
    }
    fn now_ms(&self) -> u64 {
        crate::heartbeat::now_ms()
    }
    fn timing(&self) -> Timing {
        Timing::real()
    }
    fn mod_wait_ms(&self) -> u64 {
        30_000
    }
}

pub(crate) struct OpsDirs {
    /// ~/.claude/sessions
    pub sessions: PathBuf,
    /// ~/.asn/status（外掛寫）
    pub status: PathBuf,
    /// ~/.asn/control（橋寫、外掛讀）
    pub control: PathBuf,
}

/// 後台給的一筆待辦
#[derive(Clone, Debug)]
pub(crate) struct Op {
    pub id: String,
    pub name: String,
    pub op: String,
    pub new_name: String,
    pub model: String,
    pub note: String,
    pub by: String,
    pub by_label: String,
    pub created_at: String,
}

impl Op {
    fn parse(v: &Value) -> Op {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        Op { id: s("id"), name: s("name"), op: s("op"), new_name: s("new_name"), model: s("model"), note: s("note"), by: s("requested_by"), by_label: s("requested_by_label"), created_at: s("created_at") }
    }
    fn who(&self) -> String {
        let l = clean(&self.by_label, 40);
        if l.is_empty() { "手機".to_string() } else { l }
    }
    fn what(&self) -> String {
        match self.op.as_str() {
            "info" => "查看詳情".into(),
            "rename" => format!("改名為「{}」", clean(&self.new_name, 40)),
            "model" => format!("切換模型為 {}", clean(&self.model, 60)),
            "close" => "關閉視窗".into(),
            "handover" => "轉交下一任".into(),
            o => format!("不認得的動作 {}", clean(o, 20)),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct OpResult {
    pub status: &'static str,
    pub detail: String,
    pub result: Option<Value>,
}

fn ok(detail: impl Into<String>, result: Option<Value>) -> OpResult {
    OpResult { status: "ok", detail: detail.into(), result }
}
fn failed(detail: impl Into<String>) -> OpResult {
    OpResult { status: "failed", detail: detail.into(), result: None }
}
fn unconfirmed(detail: impl Into<String>) -> OpResult {
    OpResult { status: "unconfirmed", detail: detail.into(), result: None }
}

/// 去掉控制字元、截短（給 log、往來記錄、回報用）
fn clean(s: &str, max: usize) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(max).collect()
}

pub(crate) struct PartnerOps {
    relay: Arc<Relay>,
    log: Arc<BridgeLog>,
    corr: CorrLog,
    env: Arc<dyn OpsEnv>,
    dirs: OpsDirs,
    /// (視窗名, pid) 是收發室視窗或 ASN 自己的視窗就回 true
    protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync>,
    off: AtomicBool,
    warned: AtomicBool,
    seen: Mutex<HashSet<String>>,
    inflight: Mutex<HashSet<String>>,
}

impl PartnerOps {
    pub(crate) fn new(relay: Arc<Relay>, log: Arc<BridgeLog>, handoff_dir: PathBuf, env: Arc<dyn OpsEnv>, dirs: OpsDirs, protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync>) -> Arc<PartnerOps> {
        Arc::new(PartnerOps {
            relay,
            log,
            corr: CorrLog::new(handoff_dir),
            env,
            dirs,
            protect,
            off: AtomicBool::new(false),
            warned: AtomicBool::new(false),
            seen: Mutex::new(HashSet::new()),
            inflight: Mutex::new(HashSet::new()),
        })
    }

    /// 真實環境版：收發室視窗名與 ASN 自己的 worker pid 受保護
    pub(crate) fn system(relay: Arc<Relay>, log: Arc<BridgeLog>, data_dir: PathBuf, handoff_dir: PathBuf, sessions_dir: PathBuf, status_dir: PathBuf, mailbox_name: String, worker_pid: Arc<dyn Fn() -> u32 + Send + Sync>) -> Arc<PartnerOps> {
        let control = status_dir.parent().map(|p| p.join("control")).unwrap_or_else(|| status_dir.join("control"));
        let asn_window = relay.window_name();
        let protect: Arc<dyn Fn(&str, u32) -> bool + Send + Sync> = Arc::new(move |name, pid| name == mailbox_name || name == asn_window || (pid != 0 && pid == worker_pid()));
        PartnerOps::new(relay, log, handoff_dir, Arc::new(SystemOpsEnv { data_dir }), OpsDirs { sessions: sessions_dir, status: status_dir, control }, protect)
    }

    // ---- 輪詢 ------------------------------------------------------------------------------------

    /// 取走待辦並逐筆交給背景執行（不擋住收信）。後台沒有這個動作（404／400）就靜默停用到下次啟動。
    pub(crate) async fn pull(self: &Arc<Self>) {
        if self.off.load(Ordering::Relaxed) {
            return;
        }
        let v = match self.relay.api("partner_op_pending", None).await {
            Ok(v) => v,
            Err(e) => {
                if crate::relay::set_name_unsupported(&e) {
                    self.off.store(true, Ordering::Relaxed);
                    self.log.line("partner_op_pending not supported by backend (remote partner ops off until restart)");
                } else if !self.warned.swap(true, Ordering::Relaxed) {
                    self.log.line(&format!("partner_op_pending failed: {e} (will keep trying quietly)"));
                }
                return;
            }
        };
        self.warned.store(false, Ordering::Relaxed);
        for o in v.get("ops").and_then(Value::as_array).cloned().unwrap_or_default() {
            self.begin(Op::parse(&o));
        }
    }

    fn begin(self: &Arc<Self>, op: Op) {
        if op.id.is_empty() || !self.seen.lock().unwrap().insert(op.id.clone()) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            // 同一個視窗同時只處理一個操作
            let key = op.name.to_lowercase();
            if !me.inflight.lock().unwrap().insert(key.clone()) {
                let r = failed("這個視窗正在處理上一個操作，請稍後再試");
                me.finish(&op, r).await;
                return;
            }
            let (m2, o2) = (me.clone(), op.clone());
            let r = tokio::task::spawn_blocking(move || m2.execute(&o2)).await.unwrap_or_else(|e| failed(format!("背景工作失敗：{e}")));
            me.inflight.lock().unwrap().remove(&key);
            me.finish(&op, r).await;
        });
    }

    /// 寫 log、往來記錄，再回報後台
    async fn finish(&self, op: &Op, r: OpResult) {
        self.record(op, &r);
        let detail: String = r.detail.chars().take(DETAIL_MAX).collect();
        let mut body = json!({ "id": op.id, "status": r.status, "detail": detail });
        if let Some(res) = &r.result {
            body["result"] = res.clone();
        }
        if let Err(e) = self.relay.api("partner_op_result", Some(body)).await {
            self.log.line(&format!("partner_op_result failed id={}: {e}", op.id));
        }
    }

    /// 守門 6：內建收發室 log 與該夥伴的往來記錄（誰下的令、何時、做了什麼、結果）
    fn record(&self, op: &Op, r: &OpResult) {
        let what = op.what();
        let who = op.who();
        self.log.line(&format!("partner_op {} name={} op={} by={} -> {}{}", clean(&op.id, 40), clean(&op.name, 40), clean(&op.op, 20), who, r.status, if r.detail.is_empty() { String::new() } else { format!(" ({})", clean(&r.detail, 120)) }));
        let label = match r.status {
            "ok" => "成功",
            "unconfirmed" => "未確認",
            _ => "失敗",
        };
        let body = format!("下令：{who}（{}）\n動作：{what}\n結果：{label}{}", if op.created_at.is_empty() { "時間不明".to_string() } else { clean(&op.created_at, 40) }, if r.detail.is_empty() { String::new() } else { format!("，{}", clean(&r.detail, 200)) });
        let id = clean(&op.id, 40);
        if let Err(e) = self.corr.append(&op.name, &Entry { ts_ms: self.env.now_ms(), dir: Dir::Op, from: &who, to: &op.name, id: &id, body: &body, attachments: &[] }) {
            self.log.line(&format!("corr log failed window={}: {e}", clean(&op.name, 40)));
        }
    }

    // ---- 執行（會等待，放在背景執行緒）------------------------------------------------------------

    pub(crate) fn execute(&self, op: &Op) -> OpResult {
        if !KNOWN_OPS.contains(&op.op.as_str()) {
            return failed(format!("這個版本的 ASN 不認得「{}」這個動作", clean(&op.op, 20)));
        }
        if op.name.is_empty() {
            return failed("缺少視窗名字");
        }
        if op.op != "info" && !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        let target = match self.find_target(&op.name) {
            Ok(t) => t,
            Err(e) => return failed(e),
        };
        match op.op.as_str() {
            "info" => self.info(&target),
            "close" => self.close(&target),
            "rename" => self.rename(op, target),
            "model" => self.model(op, target),
            _ => self.handover(op, target),
        }
    }

    /// 守門 1、2、5：只靠 sessions/<pid>.json 的名字找出唯一一個活著的互動式視窗，再用「名字＋sessionId＋pid」重新確認。
    /// 命令列只在確認過的 pid 上讀（看是不是 claude、取啟動參數），絕不拿來找程序。
    fn find_target(&self, name: &str) -> Result<switch::Target, String> {
        let os = self.env.os();
        let sessions = console::read_sessions(&self.dirs.sessions);
        let hits: Vec<(u32, String)> = sessions
            .iter()
            .filter(|s| s.get("name").and_then(Value::as_str) == Some(name))
            .filter(|s| s.get("kind").and_then(Value::as_str).map(|k| k == "interactive").unwrap_or(true))
            .filter_map(|s| Some((u32::try_from(s.get("pid").and_then(Value::as_u64)?).ok()?, s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string())))
            .filter(|(p, _)| *p != 0 && os.alive(*p))
            .collect();
        if hits.iter().any(|(p, _)| (self.protect)(name, *p)) || (self.protect)(name, 0) {
            return Err(PROTECTED.into());
        }
        match hits.len() {
            0 => Err("找不到這個夥伴的 Claude 視窗（可能已經關了）".into()),
            1 => switch::resolve(os, &self.dirs.sessions, name, Some((hits[0].0, &hits[0].1))),
            _ => Err("有不只一個同名的視窗，無法確定是哪一個，請先在電腦上處理".into()),
        }
    }

    /// 動手前的共同檢查：重新確認目標還是同一個、還允許遠端管理，回（承載殼、可結束清單、是否在 WT 分頁）
    fn guard(&self, t: &switch::Target) -> Result<(Option<u32>, Vec<u32>, bool), String> {
        let os = self.env.os();
        if !self.env.allow_remote() {
            return Err(CONSENT_OFF.into());
        }
        if (self.protect)(&t.name, t.pid) {
            return Err(PROTECTED.into());
        }
        let table = os.processes();
        let host = switch::asn_host_of(os, &table, t.pid);
        let allowed = switch::kill_set(&table, t.pid, host, os.own_pid());
        if !allowed.contains(&t.pid) {
            return Err("守門：這個程序不允許結束".into());
        }
        Ok((host, allowed, switch::in_windows_terminal(&table, t.pid)))
    }

    fn session_rec(&self, pid: u32) -> Option<Value> {
        console::read_sessions(&self.dirs.sessions).into_iter().find(|s| s.get("pid").and_then(Value::as_u64) == Some(pid as u64))
    }

    // ---- 外掛狀態檔與控制檔 -----------------------------------------------------------------------

    /// 外掛寫的狀態檔（有效才回）：存在、完整 JSON、sessionId 相符、沒過期、不是「已結束」
    fn mod_status(&self, sid: &str) -> Option<Value> {
        if !roster::valid_sid(sid) {
            return None;
        }
        let path = self.dirs.status.join(format!("{sid}.json"));
        if std::fs::metadata(&path).ok()?.len() > 16 * 1024 {
            return None;
        }
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        if v.get("sessionId").and_then(Value::as_str) != Some(sid) {
            return None;
        }
        let at = v.get("at").and_then(Value::as_u64)?;
        if self.env.now_ms().abs_diff(at) > roster::MOD_STATUS_MAX_AGE_MS {
            return None;
        }
        if v.get("detail").and_then(Value::as_str).map(str::trim) == Some(roster::MOD_ENDED_DETAIL) {
            return None;
        }
        Some(v)
    }

    /// 有外掛的視窗：寫控制檔，等外掛在狀態檔回報 control:{id, ok, detail}。
    /// 回 Some＝外掛處理了（成功或明確失敗）；None＝沒外掛或逾時，呼叫端退回重開。
    fn via_mod(&self, op: &Op, t: &switch::Target, arg: &str) -> Option<OpResult> {
        self.mod_status(&t.session_id)?;
        let file = self.dirs.control.join(format!("{}.json", t.session_id));
        let body = json!({ "id": op.id, "op": op.op, "arg": arg, "at": self.env.now_ms() });
        crate::write_atomic(&file, &body.to_string()).ok()?;
        let mut got: Option<(bool, String)> = None;
        let os = self.env.os();
        switch::wait_until(os, self.env.mod_wait_ms(), 500, || {
            let Some(st) = self.mod_status(&t.session_id) else { return false };
            let Some(c) = st.get("control") else { return false };
            if c.get("id").and_then(Value::as_str) != Some(op.id.as_str()) {
                return false;
            }
            got = Some((c.get("ok").and_then(Value::as_bool).unwrap_or(false), clean(c.get("detail").and_then(Value::as_str).unwrap_or(""), 200)));
            true
        });
        // 不論結果都收掉控制檔：逾時退回重開後，新視窗的外掛不能再執行一次舊指令
        let _ = std::fs::remove_file(&file);
        let (good, detail) = got?;
        Some(if good {
            ok(if detail.is_empty() { "已由視窗內的外掛完成".to_string() } else { detail }, Some(json!({ "pid": t.pid, "via": "mod" })))
        } else {
            failed(if detail.is_empty() { "視窗內的外掛回報失敗".to_string() } else { detail })
        })
    }

    // ---- info ------------------------------------------------------------------------------------

    fn info(&self, t: &switch::Target) -> OpResult {
        let os = self.env.os();
        let table = os.processes();
        let host = switch::asn_host_of(os, &table, t.pid);
        let st = self.mod_status(&t.session_id);
        let model = st.as_ref().and_then(|s| s.get("model")).and_then(Value::as_str).filter(|m| switch::valid_model(m)).map(String::from).or_else(|| switch::current_model(&t.args));
        let mut chain: Vec<String> = switch::ancestors(&table, t.pid).into_iter().rev().filter_map(|p| table.iter().find(|x| x.pid == p)).map(|p| clean(&p.name, 60)).collect();
        chain.push(table.iter().find(|p| p.pid == t.pid).map(|p| clean(&p.name, 60)).unwrap_or_else(|| "claude".into()));
        if chain.len() > CHAIN_MAX {
            chain = chain.split_off(chain.len() - CHAIN_MAX);
        }
        let started = self.session_rec(t.pid).and_then(|s| s.get("startedAt").cloned()).unwrap_or(Value::Null);
        let mut r = json!({
            "pid": t.pid,
            "model": model,
            "engine": "claude",
            "cwd": clean(&t.cwd, 300),
            "started_at": started,
            "status": t.status,
            "opened_by": if host.is_some() { "asn" } else { "user" },
            "shell_chain": chain,
            "mod_installed": st.is_some(),
        });
        if let Some(c) = st.as_ref().and_then(|s| s.get("context")).and_then(Value::as_object) {
            // 只收三個數字欄位：used、limit、percent（沒給 percent 且有 limit 就算出來）
            let num = |k: &str| c.get(k).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0);
            let (used, limit) = (num("used"), num("limit"));
            let percent = num("percent").or_else(|| used.zip(limit).filter(|(_, l)| *l > 0.0).map(|(u, l)| (u / l * 100.0).round()));
            let mut ctx = serde_json::Map::new();
            for (k, v) in [("used", used), ("limit", limit), ("percent", percent)] {
                if let Some(v) = v {
                    ctx.insert(k.into(), if v.fract() == 0.0 { json!(v as u64) } else { json!(v) });
                }
            }
            if !ctx.is_empty() {
                r["context"] = Value::Object(ctx);
            }
        }
        if r.to_string().len() > RESULT_MAX_BYTES {
            r["shell_chain"] = json!([]);
            r.as_object_mut().map(|o| o.remove("context"));
        }
        ok("", Some(r))
    }

    // ---- close -----------------------------------------------------------------------------------

    fn close(&self, t: &switch::Target) -> OpResult {
        let (host, allowed, _) = match self.guard(t) {
            Ok(g) => g,
            Err(e) => return failed(e),
        };
        // 守門 3：使用者自己開的視窗（沒有 ASN 承載殼）不送關閉訊息，只結束 claude 與子孫，留下終端機
        if let Err(e) = switch::close_session(self.env.os(), &self.env.timing(), t.pid, &allowed, host, host.is_some()) {
            return failed(e);
        }
        let kept = host.is_none();
        ok(if kept { "已結束 Claude；原本的終端機分頁會留下" } else { "已關閉視窗" }, Some(json!({ "pid": t.pid, "kept_terminal": kept })))
    }

    // ---- 重開（改名退路、轉交）-------------------------------------------------------------------

    /// 關掉目標、照 `argv` 開新視窗、等同名的新視窗出現。new_sid_required＝新視窗的 sessionId 必須和舊的不同（轉交）
    fn reopen(&self, t: &switch::Target, new_name: &str, argv: Vec<String>, new_sid_required: bool) -> OpResult {
        let os = self.env.os();
        let (host, allowed, in_wt) = match self.guard(t) {
            Ok(g) => g,
            Err(e) => return failed(e),
        };
        let plan = match switch::plan_for(t, new_name, argv, in_wt) {
            Ok(p) => p,
            Err(e) => return failed(e),
        };
        let old_pids: HashSet<u32> = console::read_sessions(&self.dirs.sessions)
            .iter()
            .filter(|s| matches!(s.get("name").and_then(Value::as_str), Some(n) if n == t.name || n == new_name))
            .filter_map(|s| s.get("pid").and_then(Value::as_u64).map(|p| p as u32))
            .collect();
        if let Err(e) = switch::close_session(os, &self.env.timing(), t.pid, &allowed, host, host.is_some()) {
            return failed(e);
        }
        if let Err(e) = self.env.launch(&plan) {
            return failed(format!("原視窗已關閉，但重開失敗：{e}"));
        }
        let mut found: Option<(u32, String)> = None;
        let appeared = switch::wait_until(os, self.env.timing().appear_wait_ms, self.env.timing().poll_ms, || {
            for s in console::read_sessions(&self.dirs.sessions) {
                if s.get("name").and_then(Value::as_str) != Some(new_name) || s.get("kind").and_then(Value::as_str).map(|k| k != "interactive").unwrap_or(false) {
                    continue;
                }
                let Some(p) = s.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) else { continue };
                let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                if old_pids.contains(&p) || !os.alive(p) || (new_sid_required && (sid.is_empty() || sid == t.session_id)) {
                    continue;
                }
                found = Some((p, sid));
                return true;
            }
            false
        });
        match (appeared, found) {
            (true, Some((pid, sid))) => ok("新視窗已出現", Some(json!({ "pid": pid, "session_id": sid, "old_pid": t.pid }))),
            _ => unconfirmed("原視窗已關閉、新視窗已送出，但一直沒看到同名的新視窗出現"),
        }
    }

    fn rename(&self, op: &Op, t: switch::Target) -> OpResult {
        let new = op.new_name.as_str();
        if !valid_partner_name(new) {
            return failed("新名字不合規則");
        }
        if new == t.name {
            return failed("新名字和目前的一樣");
        }
        let taken = console::read_sessions(&self.dirs.sessions).iter().any(|s| s.get("name").and_then(Value::as_str) == Some(new) && s.get("pid").and_then(Value::as_u64).map(|p| self.env.os().alive(p as u32)).unwrap_or(false));
        if taken {
            return failed(format!("已經有叫「{}」的視窗", clean(new, 40)));
        }
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        if let Some(r) = self.via_mod(op, &t, new) {
            return r;
        }
        // 退路：重開。等外掛的這段時間視窗可能已經變了，重新確認一次還是同一個
        let t2 = match self.find_target(&t.name) {
            Ok(x) if x.pid == t.pid && x.session_id == t.session_id => x,
            Ok(_) => return failed("這個視窗在等待期間換了，請重新操作"),
            Err(e) => return failed(e),
        };
        let argv = switch::rewrite_args_opts(&t2.args, Some(&t2.session_id), new, switch::current_model(&t2.args).as_deref(), None);
        self.reopen(&t2, new, argv, false)
    }

    fn model(&self, op: &Op, t: switch::Target) -> OpResult {
        if !switch::valid_model(&op.model) {
            return failed("模型名稱不合法");
        }
        if !self.env.allow_remote() {
            return failed(CONSENT_OFF);
        }
        if let Some(r) = self.via_mod(op, &t, &op.model) {
            return r;
        }
        let t2 = match self.find_target(&t.name) {
            Ok(x) if x.pid == t.pid && x.session_id == t.session_id => x,
            Ok(_) => return failed("這個視窗在等待期間換了，請重新操作"),
            Err(e) => return failed(e),
        };
        // 沿用既有的切換流程（它會再確認閒置、守門、關、重開、等新視窗）；動手前先過我們自己的守門
        if let Err(e) = self.guard(&t2) {
            return failed(e);
        }
        let req = SwitchRunReq { name: t2.name.clone(), pid: t2.pid, session_id: t2.session_id.clone(), model: op.model.clone() };
        let env = self.env.clone();
        let v = switch::run_with(self.env.os(), &self.dirs.sessions, &req, &move |plan| env.launch(plan), &self.env.timing());
        if v.get("ok").and_then(Value::as_bool) == Some(true) {
            return ok("已切換模型", Some(json!({ "pid": v.get("newPid"), "session_id": v.get("sessionId"), "model": op.model })));
        }
        let reason = v.get("reason").and_then(Value::as_str).unwrap_or("切換失敗").to_string();
        if v.get("stage").and_then(Value::as_str) == Some("verify") {
            unconfirmed(reason)
        } else {
            failed(reason)
        }
    }

    fn handover(&self, op: &Op, t: switch::Target) -> OpResult {
        let note = handover_prompt(&t.name, &op.note);
        // 照原參數開新對話：不帶 --resume／--continue／--session-id，名字不變，模型不變，第一句話是接班提示
        let argv = switch::rewrite_args_opts(&t.args, None, &t.name, switch::current_model(&t.args).as_deref(), Some(&note));
        self.reopen(&t, &t.name.clone(), argv, true)
    }
}

#[cfg(test)]
mod tests;
