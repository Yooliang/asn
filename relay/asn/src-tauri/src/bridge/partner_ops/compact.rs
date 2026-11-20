//! 視窗壓縮 N 次自動交接（#1852）的執行端：定時巡檢本機的 Claude 視窗、數壓縮次數、照 `bridge/compact.rs` 的規則決定
//! 自動交接或只提醒；交接重用現有的「換班接手」（`handover`），不另寫一套。
//!
//! 「本機發起」的安全邊界：現有的 `execute` 在動手前會檢查「允許我的其他設備替這台開新視窗」，那個開關管的是別台設備下令。
//! 本機自己按「交接」鈕、或本機設定勾了「壓縮 N 次自動交接」，不算別台設備下令，所以走另一個 `PartnerOps` 副本（`local_twin`），
//! 它的環境只有 `allow_remote` 回 true 這一處不同。**後台佇列（`pull`）只會餵進原本那個、照開關檢查的實例**；
//! `Op` 本身沒有「本機」欄位，佇列送來的任何內容（包括假造的 `local` 欄位）都帶不出這個副本。
//! 其餘安全檢查（受保護視窗、同名、sessionId 重驗、只關那一棵）完全沿用。
use super::*;
use crate::bridge::compact::{self, Act, Input, Progress, Tracker, Win};
use std::collections::HashMap;

/// 巡檢間隔（毫秒）。按「交接」鈕的請求不等這個間隔
pub(crate) const TICK_MS: u64 = 30_000;

#[derive(Default)]
pub(crate) struct CompactState {
    tracker: Tracker,
    progress: HashMap<String, Progress>,
    last_ms: u64,
}

/// 本機發起用的環境：除了「允許其他設備」這一關回 true（本機自己不算別台設備），其餘全部轉給原本的環境；
/// 階段回報是給後台那筆待辦用的，本機發起沒有待辦，不回報
struct LocalEnv(Arc<dyn OpsEnv>);

impl OpsEnv for LocalEnv {
    fn os(&self) -> &dyn Os {
        self.0.os()
    }
    fn allow_remote(&self) -> bool {
        true
    }
    fn launch(&self, plan: &Plan) -> Result<(), String> {
        self.0.launch(plan)
    }
    fn launched_native(&self) -> Option<&'static str> {
        self.0.launched_native()
    }
    fn now_ms(&self) -> u64 {
        self.0.now_ms()
    }
    fn timing(&self) -> Timing {
        self.0.timing()
    }
    fn mod_wait_ms(&self) -> u64 {
        self.0.mod_wait_ms()
    }
    fn mod_probe_ms(&self) -> u64 {
        self.0.mod_probe_ms()
    }
    fn claim_opening(&self, session: &str, name: &str) -> bool {
        self.0.claim_opening(session, name)
    }
    fn release_opening(&self, session: &str, name: &str) {
        self.0.release_opening(session, name)
    }
    fn launch_config(&self) -> Result<LaunchConfig, String> {
        self.0.launch_config()
    }
    fn tell(&self, name: &str, text: &str) -> Result<(), String> {
        self.0.tell(name, text)
    }
    fn progress(&self, _op_id: &str, _detail: &str) {}
    fn handoff_wait_ms(&self) -> u64 {
        self.0.handoff_wait_ms()
    }
    fn handoff_poll_ms(&self) -> u64 {
        self.0.handoff_poll_ms()
    }
    fn pi_home(&self) -> PathBuf {
        self.0.pi_home()
    }
    fn pi_wait_ms(&self) -> u64 {
        self.0.pi_wait_ms()
    }
    fn pi_sleep(&self, ms: u64) {
        self.0.pi_sleep(ms)
    }
    fn pi_agent_dir(&self) -> PathBuf {
        self.0.pi_agent_dir()
    }
    fn launch_pi_session(&self, config: &LaunchConfig, name: &str, cwd: &str, session_file: &str) -> Result<u32, String> {
        self.0.launch_pi_session(config, name, cwd, session_file)
    }
    fn session_partners(&self, session: &str) -> Vec<crate::launch::stuck_resume::PartnerRef> {
        self.0.session_partners(session)
    }
    fn screen_code(&self, name: &str) -> Option<&'static str> {
        self.0.screen_code(name)
    }
}

/// 視窗自己的環境變數（只有 Linux 讀得到：/proc/<pid>/environ；其他平台是 None，改靠 ASN 環境與命令列）
fn window_environ(pid: u32) -> Option<Vec<u8>> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read(format!("/proc/{pid}/environ")).ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

impl PartnerOps {
    /// 本機發起專用的副本（見檔頭）：只有程式內部的壓縮巡檢與工作管理員的「交接」鈕會用，後台佇列碰不到
    pub(crate) fn local_twin(&self) -> Arc<PartnerOps> {
        PartnerOps::new(self.relay.clone(), self.log.clone(), self.handoff_dir.clone(), Arc::new(LocalEnv(self.env.clone())), self.dirs.clone(), self.protect.clone())
    }

    /// 掃本機活著的互動式 Claude 視窗，各自數壓縮次數（讀不到對話紀錄的略過，畫面顯示「—」）
    pub(crate) fn compact_scan(&self) -> Vec<Win> {
        let os = self.env.os();
        let table = os.processes();
        let mut wins = Vec::new();
        let mut st = self.compact.lock().unwrap_or_else(|e| e.into_inner());
        for s in console::read_sessions(&self.dirs.sessions) {
            if s.get("kind").and_then(Value::as_str).map(|k| k != "interactive").unwrap_or(false) {
                continue;
            }
            let (Some(name), Some(sid)) = (s.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()), s.get("sessionId").and_then(Value::as_str)) else { continue };
            let Some(pid) = s.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()).filter(|p| *p != 0) else { continue };
            if !roster::valid_sid(sid) || !self.session_live(&s, &table) || !os.alive(pid) || (self.protect)(name, pid) {
                continue;
            }
            // 「這次開視窗之後」：session 記錄的開始時間與程序建立時間取晚的（接回舊對話的視窗，舊的壓縮不算）
            let since = s.get("startedAt").and_then(Value::as_u64).unwrap_or(0).max(os.started_ms(pid).unwrap_or(0));
            if !st.progress.contains_key(sid) {
                let Some((path, _)) = find_transcript(&self.dirs.projects, sid) else { continue };
                st.progress.insert(sid.to_string(), Progress::new(path));
            }
            let Some(pr) = st.progress.get_mut(sid) else { continue };
            match pr.advance(since) {
                Ok(count) => {
                    // 視窗是不是可能用自訂設定資料夾：ASN 讀不到別的程序在 Windows 上的環境變數，所以保守——任何來源看得到就當讀不到
                    let mut chain = vec![pid];
                    chain.extend(switch::ancestors(&table, pid).into_iter().take(6));
                    let cmds: Vec<String> = chain.iter().filter_map(|p| os.cmdline(*p)).collect();
                    let custom = compact::window_custom_config(compact::custom_config_dir(), &cmds, window_environ(pid).as_deref());
                    wins.push(Win { sid: sid.to_string(), name: name.to_string(), count, custom_config: custom })
                }
                Err(e) => self.log.line(&format!("compact: 讀不到「{}」的對話紀錄：{}", clean(name, 40), clean(&e.to_string(), 80))),
            }
        }
        let live: HashSet<&str> = wins.iter().map(|w| w.sid.as_str()).collect();
        st.progress.retain(|k, _| live.contains(k.as_str()));
        wins
    }

    /// 巡檢一輪（內建收發室每個 tick 叫一次，這裡自己限速）：數次數、判斷、動手。`enabled`／`n` 是這台的設定
    pub(crate) async fn compact_tick(self: &Arc<Self>, enabled: bool, n: u32) {
        let manual = compact::take_manual();
        let now = self.env.now_ms();
        {
            let mut st = self.compact.lock().unwrap_or_else(|e| e.into_inner());
            if manual.is_empty() && now.saturating_sub(st.last_ms) < TICK_MS {
                return;
            }
            st.last_ms = now;
        }
        let me = self.clone();
        let acts = tokio::task::spawn_blocking(move || {
            let wins = me.compact_scan();
            // 額度只在有視窗到次數時才讀（平常什麼都不用查）；讀不到就是 Unknown，只會提醒
            let quota = if wins.iter().any(|w| w.count >= n) { compact::quota_now(now as i64) } else { compact::Quota::Unknown };
            let mut st = me.compact.lock().unwrap_or_else(|e| e.into_inner());
            for m in &manual {
                if !wins.iter().any(|w| w.name == *m) {
                    me.log.line(&format!("compact: 按了「交接」但找不到視窗「{}」", clean(m, 40)));
                }
            }
            let acts = st.tracker.step(&Input { wins: &wins, enabled, n, quota: &quota, manual: &manual });
            compact::publish_view(st.tracker.view());
            acts
        })
        .await
        .unwrap_or_default();
        for a in acts {
            match a {
                Act::Handover { sid, name, count, auto, .. } => {
                    let me = self.clone();
                    tokio::spawn(async move { me.run_handover(sid, name, count, auto).await });
                }
                mail @ Act::Mail { .. } => self.send_compact_mail(&mail).await,
            }
        }
    }

    /// 走現有的換班接手流程（寫交接檔 → 開新視窗 → 關舊視窗），做完回報給狀態機，自動交接再寄信
    async fn run_handover(self: Arc<Self>, sid: String, name: String, count: u32, auto: bool) {
        let who = if auto { format!("本機（壓縮 {count} 次自動交接）") } else { "本機（工作管理員按交接）".to_string() };
        let op = Op { id: format!("compact-{}", clean(&sid, 40)), name: name.clone(), op: "handover".into(), new_name: String::new(), model: String::new(), session_id: String::new(), note: String::new(), by: String::new(), by_label: who, created_at: String::new() };
        self.log.line(&format!("compact: 開始交接「{}」（壓縮 {count} 次，{}）", clean(&name, 40), if auto { "自動" } else { "手動" }));
        let twin = self.local_twin();
        let r = tokio::task::spawn_blocking(move || {
            let r = twin.execute(&op);
            twin.record(&op, &r);
            r
        })
        .await
        .unwrap_or_else(|e| failed(format!("背景工作失敗：{e}")));
        // 新視窗開了但一直沒看到（unconfirmed）時舊視窗已經關了，仍算交接完成
        let ok = r.status != "failed";
        self.log.line(&format!("compact: 交接「{}」{}（{}）", clean(&name, 40), if ok { "完成" } else { "失敗" }, clean(&r.detail, 120)));
        let next = {
            let mut st = self.compact.lock().unwrap_or_else(|e| e.into_inner());
            let next = st.tracker.finish(&sid, ok);
            compact::publish_view(st.tracker.view());
            next
        };
        if let Some(mail) = next {
            self.send_compact_mail(&mail).await;
        }
    }

    /// 寄通知信給本人（後台 compact_notice）。舊後台（404）、參數不合（400）、節點停用（403）、寄送失敗都只記 log，不擋交接
    async fn send_compact_mail(&self, act: &Act) {
        let Act::Mail { name, count, kind, .. } = act else { return };
        let (k, reason, pct) = compact::mail_fields(kind);
        let mut body = json!({ "window": clean(name, 40), "count": count, "kind": k });
        if let Some(r) = reason {
            body["reason"] = json!(r);
        }
        if let Some(p) = pct {
            body["pct"] = json!(p);
        }
        match self.relay.api_status("compact_notice", body).await {
            Ok((200, v)) => self.log.line(&format!("compact-notice window={} kind={k} notify={}", clean(name, 40), v.get("notify").and_then(Value::as_str).unwrap_or(""))),
            Ok((status, _)) => self.log.line(&format!("compact-notice: 後台回 {status}，只記 log window={} kind={k}", clean(name, 40))),
            Err(e) => self.log.line(&format!("compact-notice failed: {}", clean(&e, 120))),
        }
    }
}
