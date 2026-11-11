//! 「正在開」登記：同一位夥伴的視窗剛被某一條路開起來、還沒上線（session 檔還沒寫出來）的這段空檔，
//! 其他路不能再開第二個。重開機後的自動接回、終端服務中斷的接回、本人手動喚醒或開新夥伴接續同名對話，
//! 開視窗前都要先來登記，登記不成（有人剛登記過）就不開。
//!
//! 鍵：有對話編號用「s:<對話編號>」，另外一律再加「n:<名字>」（沒有對話編號時只有名字）；兩個鍵只要有一個已登記就算有人在開。
//! 時限：登記後 120 秒內有效，過了自動失效（視窗開不起來、也沒人解除時不會永遠擋著）。
//! 解除：開視窗失敗、或開了卻一直沒上線（接回判定「沒看到上線」）時要馬上解除，不然本人之後手動喚醒會被擋。
//! 登記的鎖只在登記與解除的瞬間持有，不跨任何等待，也不在持有時呼叫別的會拿同一把鎖的函式。
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 登記有效多久（毫秒）
pub(crate) const HOLD_MS: u64 = 120_000;
/// 登記不成時的說明（接回流程看到這句就當成「別條路已經在開」，不算失敗）
pub(crate) const BUSY: &str = "這位夥伴的視窗正在開啟中";

#[derive(Debug, Default)]
pub(crate) struct Opening {
    held: HashMap<String, u64>,
}

fn keys(session: &str, name: &str) -> Vec<String> {
    let mut v = Vec::new();
    if !session.is_empty() {
        v.push(format!("s:{session}"));
    }
    if !name.is_empty() {
        v.push(format!("n:{name}"));
    }
    v
}

impl Opening {
    /// 登記要開這一位。有人剛登記過（120 秒內、對話編號或名字任一相同）回 false，什麼都不記；成功回 true。
    /// 對話編號與名字都是空的：沒有東西可以登記，不擋
    pub(crate) fn claim(&mut self, session: &str, name: &str, now: u64) -> bool {
        self.held.retain(|_, at| now.saturating_sub(*at) < HOLD_MS);
        let ks = keys(session, name);
        if ks.iter().any(|k| self.held.contains_key(k)) {
            return false;
        }
        for k in ks {
            self.held.insert(k, now);
        }
        true
    }

    /// 解除登記（開失敗、沒看到上線）
    pub(crate) fn release(&mut self, session: &str, name: &str) {
        for k in keys(session, name) {
            self.held.remove(&k);
        }
    }
}

fn global() -> &'static Mutex<Opening> {
    static G: OnceLock<Mutex<Opening>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(Opening::default()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 全程序共用的登記（現在時間取系統時鐘）
pub(crate) fn claim(session: &str, name: &str) -> bool {
    global()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .claim(session, name, now_ms())
}

pub(crate) fn release(session: &str, name: &str) {
    global()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .release(session, name);
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_000_000;

    #[test]
    fn 同一段對話或同一個名字_一百二十秒內不能再登記() {
        let mut o = Opening::default();
        assert!(o.claim("sid-1", "甲", T0));
        assert!(!o.claim("sid-1", "別名", T0 + 1_000), "同一段對話");
        assert!(!o.claim("", "甲", T0 + 1_000), "沒有對話編號的路，用名字擋");
        assert!(!o.claim("sid-2", "甲", T0 + 1_000), "同名");
        assert!(o.claim("sid-3", "乙", T0 + 1_000), "不相干的夥伴不受影響");
    }

    #[test]
    fn 超過時限自動失效_剛好到時限就算過期() {
        let mut o = Opening::default();
        assert!(o.claim("sid-1", "甲", T0));
        assert!(!o.claim("sid-1", "甲", T0 + HOLD_MS - 1));
        assert!(o.claim("sid-1", "甲", T0 + HOLD_MS), "滿 120 秒就不擋");
    }

    #[test]
    fn 解除後馬上能再登記_只解除自己那兩個鍵() {
        let mut o = Opening::default();
        assert!(o.claim("sid-1", "甲", T0));
        assert!(o.claim("sid-2", "乙", T0));
        o.release("sid-1", "甲");
        assert!(
            o.claim("sid-1", "甲", T0 + 1),
            "開失敗解除之後，本人手動喚醒不會被擋"
        );
        assert!(!o.claim("sid-2", "乙", T0 + 1), "別人的登記還在");
    }

    #[test]
    fn 登記不成不會留下半套鍵() {
        let mut o = Opening::default();
        assert!(o.claim("", "甲", T0));
        assert!(!o.claim("sid-9", "甲", T0 + 1), "名字撞了");
        assert!(
            o.claim("sid-9", "丙", T0 + 2),
            "剛剛失敗的那次沒有把 sid-9 記下來"
        );
    }

    #[test]
    fn 兩個都是空的_不登記也不擋() {
        let mut o = Opening::default();
        assert!(o.claim("", "", T0));
        assert!(o.claim("", "", T0));
    }

    #[test]
    fn 全程序共用的登記_登記與解除() {
        // 用只有這個測試會碰的名字，不干擾別的測試
        assert!(claim("opening-test-sid", "opening-test-名字"));
        assert!(!claim("opening-test-sid", "opening-test-名字"));
        release("opening-test-sid", "opening-test-名字");
        assert!(claim("opening-test-sid", "opening-test-名字"));
        release("opening-test-sid", "opening-test-名字");
    }
}
