//! 回覆對應表持久化：對應 relay/machine/pending-store.mjs，檔案格式相同（WORK_DIR/pending.json），
//! 所以舊 Node 橋與內建橋換手時，對應表接得上。只存轉回覆需要的最小欄位，不存信件內文。
//! 檔案損毀或欄位怪異時安全忽略（回傳空狀態）。
use serde_json::{json, Map, Value};
use std::path::Path;

pub const VERSION: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    Forwarding,
    /// 收發室 worker 額度用完而扣住：不算轉交逾時、不 ack，重置後重送。存檔只留 id 與收到時間，內文在記憶體（重啟後靠重新拉到的同一封補回）
    Held,
    Waiting,
    Notified,
    Done,
}
impl State {
    fn name(self) -> &'static str {
        match self {
            State::Waiting => "waiting",
            State::Notified => "notified",
            State::Forwarding => "forwarding",
            State::Held => "held",
            State::Done => "done",
        }
    }
}

/// 群組訊息的轉交資訊：回覆要貼回哪個群組（window＝以視窗身分發言；空字串＝以節點本身）
#[derive(Clone, Debug, PartialEq)]
pub struct RoomRef {
    pub id: String,
    pub seq: u64,
    pub window: String,
}

#[derive(Clone, Debug)]
pub struct Pending {
    pub id: String,
    pub from_node: String,
    pub from_agent: String,
    pub target: String,
    pub state: State,
    pub t0: u64,
    pub t: u64,
    pub no_reply: bool,
    pub replied: bool,
    pub notified_at: Option<u64>,
    /// 已提醒過收件視窗（只提醒一次；存檔，重啟不重提醒）
    pub nudged: bool,
    /// 寄件人說明（給收件視窗提醒用；不存檔，沒有時退回寄件視窗名）
    pub sender_desc: String,
    /// 群組訊息（沒有就是一般來信）
    pub room: Option<RoomRef>,
}

impl Pending {
    pub fn new(id: &str, from_node: &str, from_agent: &str, target: &str, now: u64, no_reply: bool) -> Pending {
        Pending {
            id: id.into(), from_node: from_node.into(), from_agent: from_agent.into(), target: target.into(),
            state: State::Forwarding, t0: now, t: now, no_reply, replied: false, notified_at: None, nudged: false, sender_desc: String::new(), room: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LastReq {
    pub from_node: String,
    pub from_agent: String,
    pub mail_id: String,
    pub t: u64,
}

pub fn to_record(p: &Pending) -> Value {
    json!({
        "id": p.id, "from_node": p.from_node, "from_agent": p.from_agent, "target": p.target,
        "state": p.state.name(), "t0": p.t0, "t": p.t, "noReply": p.no_reply, "replied": p.replied,
        "notifiedAt": p.notified_at, "nudged": p.nudged,
        "room": p.room.as_ref().map(|r| json!({ "id": r.id, "seq": r.seq, "window": if r.window.is_empty() { Value::Null } else { json!(r.window) } })),
    })
}

/// 快照：只含 waiting／notified／held（forwarding 重啟後由 inbox 重送；done 不用留）
pub fn snapshot(pending: &[Pending], last: &std::collections::BTreeMap<String, LastReq>) -> Value {
    let items: Vec<Value> = pending.iter().filter(|p| matches!(p.state, State::Waiting | State::Notified | State::Held)).map(to_record).collect();
    let mut lr = Map::new();
    for (k, v) in last {
        lr.insert(k.clone(), json!({ "from_node": v.from_node, "from_agent": v.from_agent, "mail_id": v.mail_id, "t": v.t }));
    }
    json!({ "version": VERSION, "pending": items, "lastRequester": lr })
}

fn num(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64))
}

fn from_record(r: &Value) -> Option<Pending> {
    let s = |k: &str| r.get(k).and_then(Value::as_str);
    let id = s("id")?;
    let target = s("target")?;
    let state = match s("state")? {
        "waiting" => State::Waiting,
        "notified" => State::Notified,
        "held" => State::Held,
        _ => return None,
    };
    let (t0, t) = (num(r.get("t0")?)?, num(r.get("t")?)?);
    let notified_at = r.get("notifiedAt").and_then(num);
    if state == State::Notified && notified_at.is_none() {
        return None;
    }
    let room = r.get("room").filter(|x| x.is_object()).and_then(|x| {
        let id = x.get("id")?.as_str()?;
        let seq = num(x.get("seq")?)?;
        Some(RoomRef { id: id.into(), seq, window: x.get("window").and_then(Value::as_str).unwrap_or("").into() })
    });
    Some(Pending {
        id: id.into(), from_node: s("from_node").unwrap_or("").into(), from_agent: s("from_agent").unwrap_or("").into(), target: target.into(),
        state, t0, t, no_reply: r.get("noReply").and_then(Value::as_bool).unwrap_or(false), replied: r.get("replied").and_then(Value::as_bool).unwrap_or(false),
        notified_at: if state == State::Notified { notified_at } else { None }, nudged: r.get("nudged").and_then(Value::as_bool).unwrap_or(false), sender_desc: String::new(), room,
    })
}

pub struct Loaded {
    pub pending: Vec<Pending>,
    pub last: std::collections::BTreeMap<String, LastReq>,
    pub dropped: usize,
    pub error: Option<String>,
}

/// 讀檔＋清過期
pub fn load_state(file: &Path, now: u64, keep_ms: u64) -> Loaded {
    let mut out = Loaded { pending: vec![], last: Default::default(), dropped: 0, error: None };
    let raw = match std::fs::read_to_string(file) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    };
    let data: Value = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(e) => {
            out.error = Some(format!("JSON 損毀：{e}"));
            return out;
        }
    };
    if !data.is_object() {
        out.error = Some("格式不符".into());
        return out;
    }
    for r in data.get("pending").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        match from_record(r) {
            Some(p) if now.saturating_sub(if p.state == State::Notified { p.notified_at.unwrap_or(0) } else { p.t0 }) <= keep_ms => out.pending.push(p),
            _ => out.dropped += 1,
        }
    }
    if let Some(lr) = data.get("lastRequester").and_then(Value::as_object) {
        for (target, v) in lr {
            let ok = (|| {
                let from_node = v.get("from_node")?.as_str()?;
                let mail_id = v.get("mail_id")?.as_str()?;
                let t = num(v.get("t")?)?;
                if now.saturating_sub(t) > keep_ms {
                    return None;
                }
                Some(LastReq { from_node: from_node.into(), from_agent: v.get("from_agent").and_then(Value::as_str).unwrap_or("").into(), mail_id: mail_id.into(), t })
            })();
            match ok {
                Some(l) => {
                    out.last.insert(target.clone(), l);
                }
                None => out.dropped += 1,
            }
        }
    }
    out
}

/// 原子寫入：先寫暫存檔再 rename
pub fn save_atomic(file: &Path, data: &Value) -> std::io::Result<()> {
    let tmp = format!("{}.{}.tmp", file.display(), std::process::id());
    let r = std::fs::write(&tmp, data.to_string()).and_then(|_| std::fs::rename(&tmp, file));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn p(id: &str, state: State, t0: u64) -> Pending {
        let mut x = Pending::new(id, "W", "W-政策", "T-甲", t0, false);
        x.state = state;
        if state == State::Notified {
            x.notified_at = Some(t0 + 5);
        }
        x
    }

    #[test]
    fn 快照只含_waiting_與_notified_來回一致_不含內文() {
        let list = vec![p("a", State::Forwarding, 10), p("b", State::Waiting, 10), p("c", State::Notified, 10), p("d", State::Done, 10)];
        let mut last = BTreeMap::new();
        last.insert("T-甲".to_string(), LastReq { from_node: "W".into(), from_agent: "W-政策".into(), mail_id: "b".into(), t: 11 });
        let snap = snapshot(&list, &last);
        assert_eq!(snap["pending"].as_array().unwrap().len(), 2);
        assert!(!snap.to_string().contains("body"));
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("pending.json");
        save_atomic(&f, &snap).unwrap();
        assert!(std::fs::read_dir(d.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        let l = load_state(&f, 100, 1000);
        assert_eq!(l.pending.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
        assert_eq!(l.pending[1].notified_at, Some(15));
        assert_eq!(l.last["T-甲"].mail_id, "b");
        assert_eq!((l.dropped, l.error), (0, None));
    }

    #[test]
    fn 群組項目存檔再載回_視窗名與節點本身都對得上() {
        let mut a = p("room-a", State::Waiting, 10);
        a.room = Some(RoomRef { id: "R1".into(), seq: 4, window: "T-視窗甲".into() });
        let mut b = p("room-b", State::Waiting, 10);
        b.room = Some(RoomRef { id: "R1".into(), seq: 5, window: String::new() });
        let snap = snapshot(&[a, b], &BTreeMap::new());
        assert_eq!(snap["pending"][0]["room"], json!({"id": "R1", "seq": 4, "window": "T-視窗甲"}));
        assert_eq!(snap["pending"][1]["room"]["window"], Value::Null, "與 Node 橋相同：節點本身存 null");
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("pending.json");
        save_atomic(&f, &snap).unwrap();
        let l = load_state(&f, 100, 1000);
        assert_eq!(l.pending[0].room.as_ref().unwrap().window, "T-視窗甲");
        assert_eq!(l.pending[1].room, Some(RoomRef { id: "R1".into(), seq: 5, window: String::new() }));
    }

    #[test]
    fn 過期_欄位怪異_損毀檔案都安全忽略() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("pending.json");
        std::fs::write(&f, r#"{"version":1,"pending":[{"id":"old","target":"x","state":"waiting","t0":1,"t":1},{"id":"bad","state":"waiting"},{"id":"n","target":"x","state":"notified","t0":5,"t":5},{"id":"room1","target":"x","state":"waiting","t0":900,"t":900,"room":{"id":"r","seq":1}}],"lastRequester":{"x":{"from_node":"W","mail_id":"m","t":1},"y":{"from_node":"W","mail_id":"m","t":950}}}"#).unwrap();
        let l = load_state(&f, 1000, 500);
        assert_eq!(l.pending.len(), 1, "過期的、欄位不全的、notified 沒有 notifiedAt 的都不載入");
        assert_eq!(l.pending[0].room, Some(RoomRef { id: "r".into(), seq: 1, window: String::new() }), "群組項目載回來（第二段）");
        assert_eq!(l.last.keys().collect::<Vec<_>>(), vec!["y"]);
        assert_eq!(l.dropped, 4);
        std::fs::write(&f, "{壞掉").unwrap();
        assert!(load_state(&f, 1, 1).error.unwrap().contains("損毀"));
        std::fs::write(&f, "[]").unwrap();
        assert!(load_state(&f, 1, 1).error.is_some());
        assert!(load_state(&d.path().join("none.json"), 1, 1).error.is_none());
    }
}
