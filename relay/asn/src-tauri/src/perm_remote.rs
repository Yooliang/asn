//! 手機回答 Claude 夥伴的權限框（#853，0.2.6）。電腦發現權限框就建請求，手機（本人簽章）按一個選項，
//! 電腦領到後全部重查（`partner_phone_answer`），才送那個數字鍵。後台見 supabase/functions/_shared/perm_request.ts。
//!
//! 夥伴畫面原本不離開電腦，這裡是唯一的例外：只有權限框的文字和選項，只有 Claude 夥伴，只有這一個入口。
//! `term_remote` 拒絕夥伴視窗的規則不動。內容經後台、只給本人，沒有端對端加密（小良哥定，設備金鑰放 0.2.7）。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

/// 和後台 migration 的 expires_at 相同：到了就當這筆結束，框還在就重發
const REQ_TTL_MS: u64 = 600_000;
/// 同一個框最多發幾次（10 分鐘一次，共一小時），之後只留本機提示
const MAX_SENDS: u32 = 6;
/// 建立失敗後隔多久再試（後台還沒部署、連不上、這扇視窗還有舊的一筆）
const RETRY_MS: u64 = 60_000;
const TICK_SECS: u64 = 3;

/// 使用者關掉了「權限框傳到手機」（存在 bridge.json 的 perm_phone_off）
static USER_OFF: AtomicBool = AtomicBool::new(false);

pub fn set_user_off(off: bool) {
    USER_OFF.store(off, Ordering::SeqCst);
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Create { name: String, hash: String },
    Cancel { id: String },
}

#[derive(Debug)]
struct Track {
    hash: String,
    id: Option<String>,
    sends: u32,
    next_try_ms: u64,
}

impl Track {
    fn new(hash: &str) -> Self {
        Track { hash: hash.to_string(), id: None, sends: 0, next_try_ms: 0 }
    }
}

/// 每扇視窗的請求狀態。純邏輯，不碰網路
#[derive(Debug, Default)]
pub struct Tracker {
    tracks: HashMap<String, Track>,
}

impl Tracker {
    /// offers＝現在畫面上的權限框（視窗名, 雜湊）。回這一輪要做的事
    pub fn plan(&mut self, offers: &[(String, String)], now_ms: u64) -> Vec<Action> {
        let mut out = Vec::new();
        let gone: Vec<String> = self.tracks.keys().filter(|k| !offers.iter().any(|(n, _)| n == *k)).cloned().collect();
        for name in gone {
            if let Some(id) = self.tracks.remove(&name).and_then(|t| t.id) {
                out.push(Action::Cancel { id });
            }
        }
        for (name, hash) in offers {
            let track = self.tracks.entry(name.clone()).or_insert_with(|| Track::new(hash));
            if track.hash != *hash {
                // 同一扇視窗換了一個框：舊的那筆不能再用
                if let Some(id) = track.id.take() {
                    out.push(Action::Cancel { id });
                }
                *track = Track::new(hash);
            }
            if track.id.is_some() && now_ms >= track.next_try_ms {
                track.id = None; // 到期了，後台那筆已經過期
            }
            if track.id.is_none() && track.sends < MAX_SENDS && now_ms >= track.next_try_ms {
                out.push(Action::Create { name: name.clone(), hash: hash.clone() });
            }
        }
        out
    }

    pub fn created(&mut self, name: &str, id: &str, now_ms: u64) {
        if let Some(t) = self.tracks.get_mut(name) {
            t.id = Some(id.to_string());
            t.sends += 1;
            t.next_try_ms = now_ms + REQ_TTL_MS;
        }
    }

    pub fn create_failed(&mut self, name: &str, now_ms: u64) {
        if let Some(t) = self.tracks.get_mut(name) {
            t.next_try_ms = now_ms + RETRY_MS;
        }
    }

    /// 手機決定了：拿走這筆（只能拿一次），回（視窗名, 雜湊）。同一個框不再發，換框或框不見才重來
    pub fn take(&mut self, id: &str) -> Option<(String, String)> {
        let (name, t) = self.tracks.iter_mut().find(|(_, t)| t.id.as_deref() == Some(id))?;
        t.id = None;
        t.sends = MAX_SENDS;
        Some((name.clone(), t.hash.clone()))
    }

    pub fn has_active(&self) -> bool {
        self.tracks.values().any(|t| t.id.is_some())
    }
}

#[cfg(feature = "gui")]
mod live {
    use super::*;
    use crate::launch::term::{self, LiveTerms, PhoneOffer};
    use crate::relay::Relay;
    use serde_json::{json, Value};
    use std::path::Path;
    use std::sync::Arc;

    /// 現在要傳到手機的權限框。開關關著、讀不到都算沒有，已發的那筆會被撤回
    async fn current_offers(terms: &Arc<LiveTerms>) -> Vec<PhoneOffer> {
        if USER_OFF.load(Ordering::SeqCst) {
            return Vec::new();
        }
        let code = crate::launch::claude_screen::status_code(crate::launch::claude_screen::ClaudeScreenKind::Permission);
        let names: Vec<String> = term::partner_notices().into_iter().filter(|n| n.code == code).map(|n| n.name).collect();
        if names.is_empty() {
            return Vec::new();
        }
        let terms = terms.clone();
        tokio::task::spawn_blocking(move || names.iter().filter_map(|n| term::partner_phone_offer(&terms, n).ok()).collect::<Vec<_>>()).await.unwrap_or_default()
    }

    async fn result(relay: &Relay, data_dir: &Path, id: &str, status: &str, hash: &str, detail: &str) {
        let _ = relay.api("perm_req_result", Some(json!({ "id": id, "status": status, "detail": detail }))).await;
        crate::term_remote::log_event(data_dir, &format!("perm_{status}"), id, hash, 0, detail);
    }

    async fn execute_taken(relay: &Relay, terms: &Arc<LiveTerms>, data_dir: &Path, tracker: &mut Tracker, row: &Value) {
        let Some(id) = row.get("id").and_then(Value::as_str) else { return };
        let Some((name, hash)) = tracker.take(id) else {
            result(relay, data_dir, id, "failed", "-", "電腦上已經沒有這個提示").await;
            return;
        };
        let body_hash = row.get("body_hash").and_then(Value::as_str).unwrap_or("");
        let Some(n) = row.get("choice_n").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()) else {
            result(relay, data_dir, id, "failed", &hash, "缺少選項").await;
            return;
        };
        if body_hash != hash {
            result(relay, data_dir, id, "failed", &hash, "內容已經變了，沒有送出").await;
            return;
        }
        let (terms, n2, name2, hash2) = (terms.clone(), n, name.clone(), hash.clone());
        let sent = tokio::task::spawn_blocking(move || term::partner_phone_answer(&terms, &name2, &hash2, n2)).await.unwrap_or_else(|e| Err(e.to_string()));
        match sent {
            Ok(()) => result(relay, data_dir, id, "done", &hash, "").await,
            Err(e) => result(relay, data_dir, id, "failed", &hash, &e).await,
        }
    }

    async fn tick(relay: &Relay, terms: &Arc<LiveTerms>, data_dir: &Path, tracker: &mut Tracker) {
        let offers = current_offers(terms).await;
        let keys: Vec<(String, String)> = offers.iter().map(|o| (o.name.clone(), o.hash.clone())).collect();
        let now = crate::auth::now_ms();
        for action in tracker.plan(&keys, now) {
            match action {
                Action::Cancel { id } => result(relay, data_dir, &id, "cancelled", "-", "提示已經不在了").await,
                Action::Create { name, hash } => {
                    let Some(o) = offers.iter().find(|o| o.name == name && o.hash == hash) else { continue };
                    let options: Vec<Value> = o.options.iter().map(|x| json!({ "n": x.n, "label": x.label })).collect();
                    let body = json!({ "window_name": o.name, "prompt_text": o.text, "complete": o.complete, "options": options, "hash": o.hash });
                    match relay.api("perm_req_create", Some(body)).await.ok().and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string)) {
                        Some(id) => {
                            tracker.created(&name, &id, now);
                            crate::term_remote::log_event(data_dir, "perm_created", &id, &hash, o.text.len(), "");
                        }
                        None => tracker.create_failed(&name, now),
                    }
                }
            }
        }
        if tracker.has_active() {
            if let Ok(v) = relay.api("perm_req_take", Some(json!({}))).await {
                for row in v.get("requests").and_then(Value::as_array).cloned().unwrap_or_default() {
                    execute_taken(relay, terms, data_dir, tracker, &row).await;
                }
            }
        }
    }

    pub fn start(app: tauri::AppHandle, relay: Arc<Relay>, terms: Arc<LiveTerms>, data_dir: std::path::PathBuf) {
        use tauri::Manager;
        tauri::async_runtime::spawn(async move {
            let mut tracker = Tracker::default();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
                if app.state::<crate::auth::AuthState>().status().signed_in {
                    tick(relay.as_ref(), &terms, &data_dir, &mut tracker).await;
                }
            }
        });
    }
}

#[cfg(feature = "gui")]
pub use live::start;

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000;
    fn offer(name: &str, hash: &str) -> (String, String) {
        (name.to_string(), hash.to_string())
    }
    fn create(name: &str, hash: &str) -> Action {
        Action::Create { name: name.into(), hash: hash.into() }
    }

    #[test]
    fn 新的框建一筆_建好後不重複建() {
        let mut t = Tracker::default();
        let o = [offer("甲", "h1")];
        assert_eq!(t.plan(&o, NOW), vec![create("甲", "h1")]);
        t.created("甲", "r1", NOW);
        assert_eq!(t.plan(&o, NOW + 3000), vec![]);
        assert!(t.has_active());
    }

    #[test]
    fn 框不見了就撤回() {
        let mut t = Tracker::default();
        t.plan(&[offer("甲", "h1")], NOW);
        t.created("甲", "r1", NOW);
        assert_eq!(t.plan(&[], NOW + 3000), vec![Action::Cancel { id: "r1".into() }]);
        assert!(!t.has_active());
        assert_eq!(t.plan(&[], NOW + 6000), vec![]);
    }

    #[test]
    fn 換了一個框_撤回舊的_建新的() {
        let mut t = Tracker::default();
        t.plan(&[offer("甲", "h1")], NOW);
        t.created("甲", "r1", NOW);
        assert_eq!(t.plan(&[offer("甲", "h2")], NOW + 3000), vec![Action::Cancel { id: "r1".into() }, create("甲", "h2")]);
    }

    #[test]
    fn 過期了框還在就重發_最多六次() {
        let mut t = Tracker::default();
        let o = [offer("甲", "h1")];
        let mut now = NOW;
        for i in 0..MAX_SENDS {
            assert_eq!(t.plan(&o, now), vec![create("甲", "h1")], "第 {i} 次");
            t.created("甲", &format!("r{i}"), now);
            assert_eq!(t.plan(&o, now + REQ_TTL_MS - 1), vec![], "到期前不重發");
            now += REQ_TTL_MS;
        }
        assert_eq!(t.plan(&o, now), vec![], "六次之後不再發");
        assert!(!t.has_active());
        // 框結束後再出現同樣的內容，是新的一個框
        assert_eq!(t.plan(&[], now), vec![]);
        assert_eq!(t.plan(&o, now), vec![create("甲", "h1")]);
    }

    #[test]
    fn 建立失敗隔一分鐘再試() {
        let mut t = Tracker::default();
        let o = [offer("甲", "h1")];
        t.plan(&o, NOW);
        t.create_failed("甲", NOW);
        assert_eq!(t.plan(&o, NOW + RETRY_MS - 1), vec![]);
        assert_eq!(t.plan(&o, NOW + RETRY_MS), vec![create("甲", "h1")]);
    }

    #[test]
    fn 決定只能拿一次_拿過後同一個框不再發() {
        let mut t = Tracker::default();
        let o = [offer("甲", "h1")];
        t.plan(&o, NOW);
        t.created("甲", "r1", NOW);
        assert_eq!(t.take("別的"), None);
        assert_eq!(t.take("r1"), Some(("甲".to_string(), "h1".to_string())));
        assert_eq!(t.take("r1"), None, "重放");
        assert_eq!(t.plan(&o, NOW + 3000), vec![], "框還沒消失也不再跳");
        assert_eq!(t.plan(&[offer("甲", "h2")], NOW + 6000), vec![create("甲", "h2")]);
    }

    #[test]
    fn 兩扇視窗各算各的() {
        let mut t = Tracker::default();
        let o = [offer("甲", "h1"), offer("乙", "h1")];
        assert_eq!(t.plan(&o, NOW).len(), 2);
        t.created("甲", "r1", NOW);
        t.created("乙", "r2", NOW);
        assert_eq!(t.plan(&[offer("乙", "h1")], NOW + 3000), vec![Action::Cancel { id: "r1".into() }]);
    }
}
