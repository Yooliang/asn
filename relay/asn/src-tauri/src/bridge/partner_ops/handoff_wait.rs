//! 換班接手的「等前任寫完交接」（#1908）。
//! 前任手上可能還有子代理在跑：請前任先把它們做完、收好結果，再寫交接；ASN 在交接檔寫完之前不關舊視窗，
//! 也不會因為等太久就自動關。等待期間如果讀得到還有幾個子代理在跑，就回報給畫面（`stage:agents:N`）；
//! 讀不到件數時回報 `stage:agents`（畫面寫「等它把手上的工作做完」，不猜數字）。
//! 件數的來源是外掛寫的狀態檔 `~/.asn/status/<sessionId>.json` 的 tasks（和對話頁「工作項目」同一份，見 launch/tasks.rs）。
use super::*;

/// 請前任寫交接的信，第二段起的要求（先等子代理、排程要寫進交接）。放在信裡才有人照做，所以獨立成常數讓測試鎖住
pub(crate) const HANDOFF_ASK_RULES: &str = "請先等手上還在跑的子代理做完、把它們的結果收好，再開始寫交接；不要中途就寫，也不要把它們丟著不管。\n交接裡要列出還沒做完的事，以及只存在這個視窗裡的排程（CronCreate 這類）：寫明時間與內容，新視窗開好後第一件事就是把它們排回去。";

/// 等不到交接檔時最多連續幾次讀到「沒有子代理」才把畫面從「等子代理」改回「寫交接中」
/// （前任收到請求那一輪是忙碌狀態，狀態檔暫時沒有 tasks，不能一讀到 0 就改口）
const ZERO_READS_TO_REVERT: u32 = 3;

#[derive(Debug, PartialEq)]
pub(crate) enum HandoffWait {
    /// 交接檔出現而且大小穩定
    Written,
    /// 等到上限還沒寫完：不關舊視窗
    TimedOut,
    /// 等的時候舊視窗被關了（本人自己關掉）
    WindowGone,
}

/// 子代理件數 → 要回報的階段代號（不含 `stage:`）。
/// `agents_now`＝這一輪讀到的件數（None＝讀不到）；`zero_reads`＝連續幾次讀到 0；`in_agents_stage`＝目前畫面是不是停在「等子代理」
pub(crate) fn agents_stage(agents_now: Option<usize>, zero_reads: u32, in_agents_stage: bool) -> Option<String> {
    match agents_now {
        Some(n) if n > 0 => Some(format!("agents:{n}")),
        Some(_) if in_agents_stage && zero_reads >= ZERO_READS_TO_REVERT => Some("handoff".to_string()),
        Some(_) => None,
        None => Some("agents".to_string()),
    }
}

/// 外掛狀態查詢（launch/tasks.rs 的結果）→ 還在跑的子代理件數。查不到視窗或狀態（known 不是 true）回 None。
/// 有逐筆清單時只算種類是子代理／teammate 而且在跑的；舊外掛只有總件數、沒有清單時用總件數
pub(crate) fn agents_from_query(v: &Value) -> Option<usize> {
    if v.get("ok").and_then(Value::as_bool) != Some(true) || v.get("known").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let total = usize::try_from(v.get("count").and_then(Value::as_u64)?).ok()?;
    let items = v.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    if items.is_empty() {
        return Some(total);
    }
    Some(
        items
            .iter()
            .filter(|i| i.get("st").and_then(Value::as_str) != Some("idle"))
            .filter(|i| matches!(i.get("kind").and_then(Value::as_str), Some("subagent" | "teammate")))
            .count(),
    )
}

/// 這個名字的視窗進行中的換班：本人在等待期間按「關閉」要放行（不然被「同一視窗一次一件事」擋住，卡死時沒有出口）
pub(crate) struct HandingGuard<'a> {
    set: &'a Mutex<HashSet<String>>,
    key: String,
}

impl<'a> HandingGuard<'a> {
    pub(crate) fn new(set: &'a Mutex<HashSet<String>>, name: &str) -> Self {
        let key = name.to_lowercase();
        set.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone());
        HandingGuard { set, key }
    }
}

impl Drop for HandingGuard<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
    }
}

impl PartnerOps {
    /// 這個視窗正在處理上一個操作時，新來的操作能不能照樣做：只有「換班正在等前任寫交接」＋「本人按關閉」放行（卡死時的出口）。
    /// `key`＝小寫的視窗名
    pub(crate) fn close_allowed_during_handoff(&self, op: &str, key: &str) -> bool {
        op == "close" && self.handing.lock().unwrap_or_else(|e| e.into_inner()).contains(key)    }

    /// 前任視窗現在還有幾個子代理在跑；讀不到回 None
    pub(crate) fn running_agents(&self, name: &str) -> Option<usize> {
        let os = self.env.os();
        let v = crate::launch::tasks::query_with(&self.dirs.sessions, &self.dirs.status, name, |p| os.alive(p), self.env.now_ms());
        agents_from_query(&v)
    }

    /// 等前任把交接寫完（檔案出現且大小連續兩次相同）。不會因為前任還在忙就放棄；等到 `handoff_wait_ms` 才回 TimedOut。
    /// 等待中回報畫面階段：還有子代理就 `agents:N`、讀不到件數就 `agents`
    pub(crate) fn wait_for_handoff(&self, op: &Op, t: &switch::Target, path: &Path) -> HandoffWait {
        let (total, poll) = (self.env.handoff_wait_ms(), self.env.handoff_poll_ms());
        let os = self.env.os();
        let t0 = std::time::Instant::now();
        let mut last_len: Option<u64> = None;
        let mut sent: Option<String> = None;
        let mut zero_reads = 0u32;
        loop {
            if let Ok(m) = std::fs::metadata(path) {
                if m.is_file() && m.len() > 0 {
                    let same = last_len == Some(m.len());
                    last_len = Some(m.len());
                    if same {
                        return HandoffWait::Written;
                    }
                }
            }
            if t.pid != 0 && !os.alive(t.pid) {
                return HandoffWait::WindowGone;
            }
            let now = self.running_agents(&t.name);
            zero_reads = if now == Some(0) { zero_reads + 1 } else { 0 };
            let in_agents = sent.as_deref().map(|s| s.starts_with("agents")).unwrap_or(false);
            if let Some(stage) = agents_stage(now, zero_reads, in_agents) {
                if sent.as_deref() != Some(stage.as_str()) {
                    self.stage(op, &stage);
                    sent = Some(stage);
                }
            }
            if t0.elapsed() >= std::time::Duration::from_millis(total) {
                return HandoffWait::TimedOut;
            }
            os.sleep(poll.max(1));
        }
    }
}
