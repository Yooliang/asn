//! 「問我」模式的授權簿：工作者要做政策標 ask 的動作時，把摘要寄給指定的人，等他回「允許／拒絕／這次全部允許」。
//! 對應 engines/acp-approvals.mjs。回覆走一般信件（寄給工作者本人），由引擎的 deliver 先問這裡認不認得；逾時一律當拒絕。
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Allow,
    AllowAll,
    Deny,
    Timeout,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub node: String,
    pub agent: Option<String>,
}

/// 解析回覆文字。順序很重要：「全部允許」先於「允許」，「不允許」先於「允許」
pub fn parse_verdict(text: &str) -> Option<Answer> {
    let t = text.trim().to_lowercase();
    let squeezed: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    if ["全部允許", "全部同意", "都允許", "都可以", "這次全部", "allowall", "approveall", "yestoall"].iter().any(|k| squeezed.contains(k)) {
        return Some(Answer::AllowAll);
    }
    // 開頭是單字的表態：後面不能緊接英文字母（no 不等於 none）
    let starts = |words: &[&str]| words.iter().any(|w| t.strip_prefix(w).map(|r| !r.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false)).unwrap_or(false));
    if ["不允許", "不同意", "不可以", "不行", "不要", "拒絕", "禁止", "否決", "別做"].iter().any(|k| t.contains(k)) || starts(&["no", "n", "deny", "reject", "否"]) {
        return Some(Answer::Deny);
    }
    if ["允許", "同意", "核可", "批准", "沒問題"].iter().any(|k| t.contains(k)) || starts(&["好的", "好", "可以", "ok", "okay", "yes", "y", "allow", "approve"]) {
        return Some(Answer::Allow);
    }
    None
}

/// 信件全文 → (節點, 視窗, 內文)。橋交給引擎的第一行是 `[RELAY 來信] trust=… from=<節點>/<視窗> to=… id=…`
pub fn parse_mail_text(text: &str) -> (String, String, String) {
    let first = text.lines().next().unwrap_or("");
    let (mut node, mut agent) = (String::new(), String::new());
    if first.starts_with("[RELAY 來信]") {
        let mut from = 0;
        while let Some(i) = first[from..].find("from=") {
            let s = from + i;
            let word_start = s == 0 || !first.as_bytes()[s - 1].is_ascii_alphanumeric() && first.as_bytes()[s - 1] != b'_';
            if word_start {
                let rest = &first[s + 5..];
                let n: String = rest.chars().take_while(|c| !c.is_whitespace() && *c != '/').collect();
                if rest[n.len()..].starts_with('/') {
                    node = n;
                    agent = rest[node.len() + 1..].chars().take_while(|c| !c.is_whitespace()).collect();
                    break;
                }
                if !n.is_empty() {
                    // 本人的位址是不帶節點的 u:xxx：node＝人代號、agent 空（與 Node 橋同）
                    node = n;
                    break;
                }
            }
            from = s + 1;
        }
    }
    let mut body = text.to_string();
    for pre in ["[RELAY 來信]", "寄件人：", "【要回信】", "[收發室]"] {
        if body.starts_with(pre) {
            body = match body.find('\n') {
                Some(i) => body[i + 1..].to_string(),
                None => String::new(),
            };
        }
    }
    (node, agent, body)
}

/// 沒附編號時，整則回覆只能是一個表態（可帶句號驚嘆號），免得「好的，我晚點看」被當成放行
fn is_bare(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    let t = t.trim_end_matches(|c: char| c.is_whitespace() || "。.!！".contains(c));
    let mut words: Vec<String> = ["這次全部允許", "全部允許", "全部同意", "都可以", "不允許", "不同意", "不可以", "不行", "不要", "拒絕", "允許", "同意", "可以", "核可", "批准", "好的", "好", "否", "ok", "okay", "yes", "y", "no", "n", "deny", "reject"].iter().map(|s| s.to_string()).collect();
    words.extend(["allow", "allow all", "allowall", "approve", "approve all", "approveall"].iter().map(|s| s.to_string()));
    words.iter().any(|w| t == w)
}

struct Item {
    worker: String,
    summary: String,
    targets: Vec<Target>,
    tx: Option<oneshot::Sender<Answer>>,
}

#[derive(Default)]
pub struct Approvals {
    items: Mutex<HashMap<String, Item>>,
}

#[derive(Debug, PartialEq)]
pub struct Handled {
    pub handled: bool,
    pub note: Option<String>,
}

fn new_id() -> String {
    let mut b = [0u8; 3];
    getrandom::fill(&mut b).expect("系統亂數不可用");
    b.iter().map(|x| format!("{x:02X}")).collect::<String>().chars().take(4).collect()
}

impl Approvals {
    pub fn new() -> Arc<Approvals> {
        Arc::new(Approvals::default())
    }

    /// targets：只有這些人的回覆算數。回傳（編號, 等待結果）；逾時會自己結案成 Timeout
    pub fn ask(self: &Arc<Self>, worker: &str, summary: &str, targets: Vec<Target>, timeout_ms: u64) -> (String, oneshot::Receiver<Answer>) {
        let (tx, rx) = oneshot::channel();
        let mut g = self.items.lock().unwrap();
        let mut id = new_id();
        while g.contains_key(&id) {
            id = new_id();
        }
        g.insert(id.clone(), Item { worker: worker.into(), summary: summary.into(), targets, tx: Some(tx) });
        drop(g);
        let (me, id2) = (self.clone(), id.clone());
        crate::rt::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
            me.finish(&id2, Answer::Timeout);
        });
        (id, rx)
    }

    pub fn finish(&self, id: &str, a: Answer) -> bool {
        let it = self.items.lock().unwrap().remove(id);
        match it {
            Some(mut it) => {
                if let Some(tx) = it.tx.take() {
                    let _ = tx.send(a);
                }
                true
            }
            None => false,
        }
    }

    fn pending_for(&self, worker: &str) -> Vec<(String, String, Vec<Target>)> {
        let mut v: Vec<_> = self.items.lock().unwrap().iter().filter(|(_, i)| i.worker == worker).map(|(id, i)| (id.clone(), i.summary.clone(), i.targets.clone())).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    /// 一封寄給工作者的信：是不是在回覆授權？
    pub fn handle_reply(&self, worker: &str, from_node: &str, from_agent: &str, text: &str) -> Handled {
        let no = Handled { handled: false, note: None };
        let mine: Vec<_> = self.pending_for(worker).into_iter().filter(|(_, _, ts)| ts.iter().any(|t| t.node == from_node && t.agent.as_deref().map(|a| a == from_agent).unwrap_or(true))).collect();
        if mine.is_empty() {
            return no;
        }
        let Some(verdict) = parse_verdict(text) else { return no };
        // 編號：文字裡剛好 4 碼大寫英數、前後不是 [A-Za-z0-9_] 的單字
        let upper = text.to_uppercase();
        let mut hit: Option<&(String, String, Vec<Target>)> = None;
        let mut run = String::new();
        for c in upper.chars().chain(std::iter::once(' ')) {
            if c.is_ascii_alphanumeric() || c == '_' {
                run.push(c);
            } else {
                if run.len() == 4 && run.chars().all(|x| x.is_ascii_uppercase() || x.is_ascii_digit()) {
                    if let Some(m) = mine.iter().find(|i| i.0 == run) {
                        hit = Some(m);
                        break;
                    }
                }
                run.clear();
            }
        }
        if hit.is_none() && !is_bare(text) {
            return no;
        }
        if hit.is_none() && mine.len() > 1 {
            let list: Vec<String> = mine.iter().map(|i| format!("{}（{}）", i.0, i.1)).collect();
            return Handled { handled: true, note: Some(format!("有 {} 筆授權在等：{}。請附上編號再回一次，例如「允許 {}」。", mine.len(), list.join("；"), mine[0].0)) };
        }
        let it = hit.unwrap_or(&mine[0]);
        self.finish(&it.0, verdict);
        let label = match verdict {
            Answer::Deny => "拒絕",
            Answer::AllowAll => "這次全部允許",
            _ => "允許",
        };
        Handled { handled: true, note: Some(format!("已收到：{label}（{}）", it.0)) }
    }

    pub fn cancel_all(&self, worker: &str) {
        for (id, _, _) in self.pending_for(worker) {
            self.finish(&id, Answer::Deny);
        }
    }
}

/// 寄給人看的授權詢問信
pub fn ask_text(worker: &str, id: &str, summary: &str, requester: &str, timeout_ms: u64) -> String {
    let mins = ((timeout_ms as f64 / 60000.0).round() as u64).max(1);
    format!(
        "［授權詢問 {id}］{worker} 想做這件事，要不要放行？\n{summary}\n{}請回信給「{worker}」，寫「允許 {id}」、「拒絕 {id}」或「全部允許 {id}」（全部允許＝這一輪之後的同類請求都放行）。{mins} 分鐘內沒回覆會自動拒絕。",
        if requester.is_empty() { String::new() } else { format!("起因：{requester} 的來信\n") }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 回覆解析_順序很重要() {
        assert_eq!(parse_verdict("全部允許 AB12"), Some(Answer::AllowAll));
        assert_eq!(parse_verdict("不允許"), Some(Answer::Deny));
        assert_eq!(parse_verdict("允許 AB12"), Some(Answer::Allow));
        assert_eq!(parse_verdict("OK"), Some(Answer::Allow));
        assert_eq!(parse_verdict("none of that"), None, "none 不是 no");
        assert_eq!(parse_verdict("No."), Some(Answer::Deny));
        assert_eq!(parse_verdict("approve all"), Some(Answer::AllowAll));
        assert_eq!(parse_verdict("今天天氣不錯"), None);
    }

    #[test]
    fn 信件標頭解析() {
        let (n, a, b) = parse_mail_text("[RELAY 來信] trust=member from=PC1/夥伴甲 to=Gemini id=1 engine=gemini reply=yes\n內文第一行\n第二行");
        assert_eq!((n.as_str(), a.as_str(), b.as_str()), ("PC1", "夥伴甲", "內文第一行\n第二行"));
        let (n, a, _) = parse_mail_text("[RELAY 來信] trust=x from=W/ to=G id=1");
        assert_eq!((n.as_str(), a.as_str()), ("W", ""));
        assert_eq!(parse_mail_text("沒有標頭").0, "");
    }

    #[tokio::test]
    async fn 只認被問的人_編號_單筆自動對應_多筆要編號_逾時() {
        let ap = Approvals::new();
        let t = vec![Target { node: "PC1".into(), agent: None }];
        let (id, rx) = ap.ask("G", "寫入：a", t.clone(), 60_000);
        assert_eq!(id.len(), 4);
        // 不是被問的人
        assert!(!ap.handle_reply("G", "別人", "x", "允許").handled);
        // 單筆、單純表態：自動對應
        let r = ap.handle_reply("G", "PC1", "夥伴甲", "好的");
        assert!(r.handled && r.note.unwrap().contains("已收到：允許"));
        assert_eq!(rx.await.unwrap(), Answer::Allow);
        // 沒編號又不是單純表態：不算
        let (_id2, _rx2) = ap.ask("G", "執行", t.clone(), 60_000);
        assert!(!ap.handle_reply("G", "PC1", "", "好的，我晚點看").handled);
        // 多筆：要編號
        let (id3, rx3) = ap.ask("G", "執行 b", t.clone(), 60_000);
        let r = ap.handle_reply("G", "PC1", "", "允許");
        assert!(r.handled && r.note.unwrap().contains("請附上編號"));
        let r = ap.handle_reply("G", "PC1", "", &format!("拒絕 {id3}"));
        assert!(r.handled);
        assert_eq!(rx3.await.unwrap(), Answer::Deny);
        // 逾時
        let (_i, rx4) = ap.ask("H", "x", t, 100);
        assert_eq!(rx4.await.unwrap(), Answer::Timeout);
        ap.cancel_all("G");
    }
}
