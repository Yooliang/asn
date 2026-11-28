//! 夥伴改名時，把所有「以名字記的副本」一起對齊（#2475）。
//!
//! 規則：名字的**正本**是對話實際的名字（Claude 的 sessions 檔的 name），其餘（終端對照表標題、分頁標題、
//! known-windows.json、記憶體裡以名字為鍵的各張表）都是副本，**只能由這裡跟著正本對齊**，副本不准往回蓋正本。
//! 視窗內自己打 /rename、信件下 /rename、後台下的改名，結果都是正本變了，所以全在這一個點接：
//! `refresh_roster` 每輪重掃正本之後，跟上一輪比對**同一個視窗**的名字，不同＝改名。
//!
//! 「同一個視窗」＝程序編號和程序建立時間都相同（編號會被別的程序重用，不能只看編號）。
//! 同一個視窗換了對話（/clear、接續別段，sessionId 變了）：只看名字——名字變了就當成改名、名字沒變就不動
//! （終端那一列、known 那一列跟的是視窗，不是對話；對話編號變了由 known 的事實每輪重記，認回查不到舊對話會退回存檔標題）。
use super::*;
use std::collections::BTreeSet;

/// 這一輪沒在名單裡的視窗，最多記住這麼久（毫秒）；期間它回來而且名字變了，仍能比對出改名
pub(super) const ABSENT_KEEP_MS: u64 = 600_000;

/// 一個視窗在某一輪的樣子
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Seen {
    pub pid: u32,
    /// 程序建立時間（毫秒）；查不到＝None（不能證明是同一個視窗）
    pub created: Option<u64>,
    pub session_id: Option<String>,
    pub name: String,
    /// 這一輪名單裡沒有它（讀不到對話檔、名字讀成空的、程序剛結束）：第一次不見的時間；在名單上＝None
    pub absent_since: Option<u64>,
}

/// 一次改名的處理結果
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Verdict {
    /// 照做：呼叫出口、搬 known、搬或清各張表
    Go,
    /// 新名現在有另一個視窗也在用（撞名）：不對齊，告訴本人
    Collision,
    /// 新名是另一個視窗上一輪的名字（互換或接力改名）：兩邊的副本還掛著那個名字，現在對齊會蓋到別人，不對齊，告訴本人
    Chained,
    /// 程序建立時間查不到，無法證明是同一個視窗：不動副本，記 log
    Unsure,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Change {
    pub pid: u32,
    pub old: String,
    pub new: String,
    pub verdict: Verdict,
}

/// 上一輪與這一輪的視窗比對，找出改名的。純函式，可單測。
/// - 同程序編號但建立時間不同＝編號被別的程序重用＝不是同一個視窗，不算改名
/// - 上一輪有、這一輪沒有的視窗（讀不到、名字空）不會出現在 `cur`，所以不會被當成改名；它回來時再比
pub(super) fn detect_renames(prev: &[Seen], cur: &[Seen]) -> Vec<Change> {
    let mut out = Vec::new();
    for c in cur {
        let Some(p) = prev.iter().find(|p| p.pid == c.pid) else { continue };
        if p.name == c.name {
            continue;
        }
        let change = |verdict| Change { pid: c.pid, old: p.name.clone(), new: c.name.clone(), verdict };
        match (p.created, c.created) {
            (Some(a), Some(b)) if a == b => {}
            (Some(_), Some(_)) => continue,
            _ => {
                out.push(change(Verdict::Unsure));
                continue;
            }
        }
        let collision = cur.iter().any(|o| o.pid != c.pid && o.name == c.name);
        let chained = prev.iter().any(|o| o.pid != c.pid && o.absent_since.is_none() && o.name == c.name);
        out.push(change(if collision {
            Verdict::Collision
        } else if chained {
            Verdict::Chained
        } else {
            Verdict::Go
        }));
    }
    out
}

/// 下一輪要拿來比的名單，以及這一輪才第一次不見的視窗。
/// 被擋下的改名（撞名、接力）維持舊名：條件解除後下一輪會再比出來並照做；其餘一律記現在的名字。
/// 不在名單上的視窗留 [`ABSENT_KEEP_MS`]，它們的名字不算「被占用」（見 detect_renames 的 chained）
pub(super) fn next_prev(prev: &[Seen], cur: &[Seen], changes: &[Change], now: u64) -> (Vec<Seen>, Vec<Seen>) {
    let mut next: Vec<Seen> = cur
        .iter()
        .map(|c| {
            let blocked = changes.iter().find(|ch| ch.pid == c.pid && matches!(ch.verdict, Verdict::Collision | Verdict::Chained));
            Seen { name: blocked.map_or_else(|| c.name.clone(), |ch| ch.old.clone()), absent_since: None, ..c.clone() }
        })
        .collect();
    let mut newly_gone = Vec::new();
    for p in prev.iter().filter(|p| !cur.iter().any(|c| c.pid == p.pid)) {
        match p.absent_since {
            None => {
                let gone = Seen { absent_since: Some(now), ..p.clone() };
                newly_gone.push(gone.clone());
                next.push(gone);
            }
            Some(t) if now.saturating_sub(t) < ABSENT_KEEP_MS => next.push(p.clone()),
            Some(_) => {}
        }
    }
    (next, newly_gone)
}

/// 改名被擋下時，用白話告訴那個視窗（不放程序編號、不放內部名稱）
fn blocked_text(old: &str, new: &str, v: Verdict) -> String {
    match v {
        Verdict::Collision => format!("（收發室）你的名字改成「{new}」了，但這台電腦上另一個視窗也叫這個名字，所以終端清單先沒有跟著改，還是顯示「{old}」。請把其中一個改成不同的名字。"),
        _ => format!("（收發室）你的名字改成「{new}」了，但這個名字剛才還是另一個視窗在用，為了不讓兩邊的終端清單對到錯的視窗，終端清單先沒有跟著改，還是顯示「{old}」。另一個視窗換掉名字之後會自動跟上；如果是兩個視窗互換名字，請其中一個先改成別的名字。"),
    }
}

impl Core {
    /// 每輪重掃正本之後呼叫（只有這一輪 sessions 檔讀成功才會呼叫；讀失敗那一輪副本一律不動）
    pub(super) async fn sync_renames(&mut self, now: u64) {
        let created = self.created.clone();
        let cur: Vec<Seen> = self
            .claude_roster
            .iter()
            .filter(|w| w.engine == "claude")
            .map(|w| Seen { pid: w.pid, created: created(w.pid), session_id: w.session_id.clone(), name: w.name.clone(), absent_since: None })
            .collect();
        let changes = detect_renames(&self.rename_prev, &cur);
        for ch in &changes {
            match ch.verdict {
                Verdict::Go => self.apply_rename(&ch.old, &ch.new, ch.pid).await,
                Verdict::Unsure => self.log.line(&format!("rename seen pid={} {} -> {}: process start time unknown, cannot prove it is the same window; copies left alone", ch.pid, ch.old, ch.new)),
                Verdict::Collision | Verdict::Chained => self.rename_blocked(ch),
            }
        }
        // 已經不在被擋狀態的組合忘掉（之後同一組再被擋要再說一次）
        let still: BTreeSet<(String, String)> = changes.iter().filter(|c| matches!(c.verdict, Verdict::Collision | Verdict::Chained)).map(|c| (c.old.clone(), c.new.clone())).collect();
        self.rename_told.retain(|k| still.contains(k));
        let (next, gone) = next_prev(&self.rename_prev, &cur, &changes, now);
        for g in &gone {
            self.log.line(&format!("rename watch: window pid={} ({}) is not in this round's roster (session file unreadable, empty name, or it ended); copies left alone", g.pid, g.name));
        }
        self.rename_prev = next;
    }

    /// 改名照做：出口對齊終端對照表，再搬 known 與各張以名字為鍵的記憶體表。
    /// 注意：這裡沒有持任何鎖呼叫出口（出口自己會拿終端服務的鎖），出口放背景執行緒跑（它會下 wezterm 指令）
    async fn apply_rename(&mut self, old: &str, new: &str, pid: u32) {
        let f = self.relabel.clone();
        let (o, n) = (old.to_string(), new.to_string());
        let rows = tokio::task::spawn_blocking(move || f(&o, &n)).await.unwrap_or(0);
        let moved = self.known.rename(old, new);
        self.move_name_tables(old, new);
        self.log.line(&format!("rename detected pid={pid} {old} -> {new}: terminal rows updated={rows}, known-windows moved={moved}"));
    }

    /// 以名字為鍵的記憶體表：搬還是清（決定與理由見 PR 說明的小表）
    fn move_name_tables(&mut self, old: &str, new: &str) {
        // 搬：看過的視窗名（這次跑著的期間）。舊名留著會讓「不見滿 5 分鐘」的計時白算、也讓舊名被當成「還在等接回」
        if self.seen_run.remove(old) {
            self.seen_run.insert(new.to_string());
        }
        // 清：消失計時只對「不見了」的名字有意義，這個視窗還在
        self.missing.remove(old);
        // 清：先留著等接回的信是記在舊名底下的（寄給舊名的信）。視窗還在、只是換名，舊名已不存在；
        // 這些信還在後台信箱沒 ack，下次拉信時會照規則退回（說找不到舊名），不會被默默吞掉，也不會被送到沒被指名的新名
        self.awaiting.remove(old);
        // 清：終端服務監看的三張名單每幾秒由狀態檔整份重建，狀態檔的名字來自剛對齊過的終端對照表，舊名不再出現
        self.mux_pending.remove(old);
        self.mux_lost.remove(old);
        self.mux_exited.remove(old);
        // 搬：剛關掉的記號（關這個視窗的意圖不因改名消失）
        self.just_closed.rename(old, new);
        // 搬：程序編號沒變，查過的「是不是 ASN 開的、權限旗標」仍有效，搬過去才不用重查
        if let Some(p) = self.probed.remove(old) {
            self.probed.insert(new.to_string(), p);
        }
        // 搬：最後活動時間是這個視窗的，不因改名歸零
        if let Some(a) = self.active.remove(old) {
            let t = self.active.get(new).copied().unwrap_or(0).max(a);
            self.active.insert(new.to_string(), t);
        }
        // 清：名字對夥伴編號的對照每次回報名單向後台重對（本輪回報後就是新名）；舊名鍵不留，免得回報失敗時舊名指著這個視窗
        self.partners.remove(old);
        // 搬：誰最後寄信給這個視窗（回信、催回信要找得到）
        if let Some(r) = self.last_requester.remove(old) {
            self.last_requester.insert(new.to_string(), r);
        }
        // 搬：已轉交、還在等回覆（等待中、已通知沒回、扣住）的信，收件視窗改成新名，之後新名回信才對得上，不會被當成沒人回而退信或催信。
        // 轉交中（Forwarding）的不搬：它幾秒內就會確認或失敗，轉交核對（hook）記的是舊名，硬改會讓核對把它當送錯
        for p in self.pending.iter_mut().filter(|p| p.target == old && p.state != State::Forwarding) {
            p.target = new.to_string();
        }
    }

    fn rename_blocked(&mut self, ch: &Change) {
        if !self.rename_told.insert((ch.old.clone(), ch.new.clone())) {
            return;
        }
        let why = if ch.verdict == Verdict::Collision { "another window already uses the new name" } else { "the new name was another window's name last round (swap or chained rename)" };
        self.log.line(&format!("rename blocked pid={} {} -> {}: {why}; terminal table and known-windows left alone, window told", ch.pid, ch.old, ch.new));
        self.tell_window(&ch.new, &blocked_text(&ch.old, &ch.new, ch.verdict));
    }
}

/// 單元測試要看的記憶體表（只在測試編譯）
#[cfg(test)]
#[derive(Debug, Default, PartialEq)]
pub(in crate::bridge) struct NameTables {
    pub known: Vec<String>,
    pub seen_run: Vec<String>,
    pub missing: Vec<String>,
    pub awaiting: Vec<String>,
    pub mux_pending: Vec<String>,
    pub mux_lost: Vec<String>,
    pub mux_exited: Vec<String>,
    pub probed: Vec<String>,
    pub active: Vec<String>,
    pub partners: Vec<String>,
    pub last_requester: Vec<String>,
    pub pending_targets: Vec<String>,
}

#[cfg(test)]
impl Core {
    pub(in crate::bridge) fn set_relabel(&mut self, f: Arc<dyn Fn(&str, &str) -> usize + Send + Sync>) {
        self.relabel = f;
    }

    /// 在各張以名字為鍵的表裡都種一筆這個名字（測試用，驗改名後各表是搬還是清）
    pub(in crate::bridge) fn plant_name_tables(&mut self, name: &str, now: u64) {
        self.missing.insert(name.to_string(), now);
        self.awaiting.entry(name.to_string()).or_default().insert("00000000-0000-0000-0000-0000000000aa".into());
        self.mux_pending.insert(name.to_string());
        self.mux_lost.insert(name.to_string());
        self.mux_exited.insert(name.to_string());
        self.probed.insert(name.to_string(), (5000, true, vec!["--permission-mode".into()]));
        self.active.insert(name.to_string(), now);
        self.partners.insert(name.to_string(), "p_aaaaaaaaaaaaaaaaaaaa".into());
        self.last_requester.insert(name.to_string(), LastReq { from_node: "W".into(), from_agent: "W-政策".into(), mail_id: "m1".into(), t: now });
        let mut p = Pending::new("00000000-0000-0000-0000-0000000000bb", "W", "W-政策", name, now, false);
        p.state = State::Waiting;
        self.pending.push(p);
        let mut f = Pending::new("00000000-0000-0000-0000-0000000000cc", "W", "W-政策", name, now, false);
        f.state = State::Forwarding;
        self.pending.push(f);
    }

    pub(in crate::bridge) fn mark_just_closed(&mut self, name: &str, now: u64) {
        self.just_closed.mark(name, now);
    }

    pub(in crate::bridge) fn known_entry(&self, name: &str) -> Option<super::super::known::KnownEntry> {
        self.known.entries().into_iter().find(|e| e.name == name)
    }

    pub(in crate::bridge) fn name_tables(&self) -> NameTables {
        let sorted = |v: Vec<String>| {
            let mut v = v;
            v.sort();
            v
        };
        NameTables {
            known: sorted(self.known.entries().into_iter().map(|e| e.name).collect()),
            seen_run: sorted(self.seen_run.iter().cloned().collect()),
            missing: sorted(self.missing.keys().cloned().collect()),
            awaiting: sorted(self.awaiting.keys().cloned().collect()),
            mux_pending: sorted(self.mux_pending.iter().cloned().collect()),
            mux_lost: sorted(self.mux_lost.iter().cloned().collect()),
            mux_exited: sorted(self.mux_exited.iter().cloned().collect()),
            probed: sorted(self.probed.keys().cloned().collect()),
            active: sorted(self.active.keys().cloned().collect()),
            partners: sorted(self.partners.keys().cloned().collect()),
            last_requester: sorted(self.last_requester.keys().cloned().collect()),
            pending_targets: sorted(self.pending.iter().map(|p| format!("{}:{:?}", p.target, p.state)).collect()),
        }
    }

    pub(in crate::bridge) fn just_closed_has(&self, name: &str) -> bool {
        self.just_closed.contains(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(pid: u32, created: Option<u64>, sid: &str, name: &str) -> Seen {
        Seen { pid, created, session_id: Some(sid.into()), name: name.into(), absent_since: None }
    }

    #[test]
    fn 同一個視窗名字變了才算改名_名字沒變或新視窗都不算() {
        let prev = vec![seen(1, Some(10), "s1", "甲"), seen(2, Some(20), "s2", "乙")];
        let cur = vec![seen(1, Some(10), "s1", "丙"), seen(2, Some(20), "s2", "乙"), seen(3, Some(30), "s3", "新")];
        assert_eq!(detect_renames(&prev, &cur), vec![Change { pid: 1, old: "甲".into(), new: "丙".into(), verdict: Verdict::Go }]);
    }

    /// 條件 1：同一個視窗換了對話（/clear、接續別段，sessionId 變了）的決定——
    /// 程序編號與建立時間都一樣＝同一個視窗；名字也變了＝改名（照做），名字沒變＝不動
    #[test]
    fn _2475_條件1_同視窗換了對話_名字變了算改名_名字沒變不動() {
        let prev = vec![seen(1, Some(10), "舊對話", "甲")];
        assert_eq!(detect_renames(&prev, &[seen(1, Some(10), "新對話", "乙")]), vec![Change { pid: 1, old: "甲".into(), new: "乙".into(), verdict: Verdict::Go }], "換對話又換名字：當成改名");
        assert!(detect_renames(&prev, &[seen(1, Some(10), "新對話", "甲")]).is_empty(), "換對話、名字沒變：不動");
    }

    /// 條件 1：程序編號被別的程序重用（建立時間不同）不是同一個視窗，不能當成改名
    #[test]
    fn _2475_條件1_程序編號被重用_建立時間不同_不算改名() {
        let prev = vec![seen(1, Some(10), "s1", "甲")];
        assert!(detect_renames(&prev, &[seen(1, Some(99), "s9", "乙")]).is_empty());
    }

    #[test]
    fn _2475_條件1_建立時間查不到_無法證明是同一個視窗_不動副本() {
        let prev = vec![seen(1, None, "s1", "甲")];
        assert_eq!(detect_renames(&prev, &[seen(1, Some(10), "s1", "乙")])[0].verdict, Verdict::Unsure);
        assert_eq!(detect_renames(&[seen(1, Some(10), "s1", "甲")], &[seen(1, None, "s1", "乙")])[0].verdict, Verdict::Unsure);
    }

    /// 條件 2：這一輪讀不到（不在名單）不等於改名；回來時名字變了才比出改名，名字沒變就什麼都不做
    #[test]
    fn _2475_條件2_這輪不在名單_不算改名_留著等它回來() {
        let prev = vec![seen(1, Some(10), "s1", "甲")];
        let (next, gone) = next_prev(&prev, &[], &[], 1_000);
        assert!(detect_renames(&prev, &[]).is_empty(), "不在名單＝沒有改名");
        assert_eq!(gone.len(), 1);
        assert_eq!(next[0].name, "甲", "名字沒被當成空的、也沒被清掉");
        assert_eq!(next[0].absent_since, Some(1_000));
        // 又缺一輪：不重複記「剛不見」
        let (next2, gone2) = next_prev(&next, &[], &[], 2_000);
        assert!(gone2.is_empty());
        assert_eq!(next2[0].absent_since, Some(1_000));
        // 回來而且名字變了：比得出改名
        let back = vec![seen(1, Some(10), "s1", "乙")];
        assert_eq!(detect_renames(&next2, &back)[0].verdict, Verdict::Go);
        // 回來名字沒變：不動
        assert!(detect_renames(&next2, &[seen(1, Some(10), "s1", "甲")]).is_empty());
        // 不見太久就不留
        let (next3, _) = next_prev(&next2, &[], &[], 1_000 + ABSENT_KEEP_MS);
        assert!(next3.is_empty());
    }

    /// 條件 3：新名已被另一個視窗使用（撞名）→ 擋下
    #[test]
    fn _2475_條件3_撞名被擋下() {
        let prev = vec![seen(1, Some(10), "s1", "甲"), seen(2, Some(20), "s2", "乙")];
        let cur = vec![seen(1, Some(10), "s1", "乙"), seen(2, Some(20), "s2", "乙")];
        let got = detect_renames(&prev, &cur);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].verdict, Verdict::Collision);
        let (next, _) = next_prev(&prev, &cur, &got, 5);
        assert_eq!(next.iter().find(|s| s.pid == 1).unwrap().name, "甲", "被擋下的維持舊名，條件解除後下一輪再比");
    }

    /// 兩個視窗互換名字：兩邊都擋下，不連鎖覆蓋
    #[test]
    fn 兩個視窗互換名字_兩邊都擋下() {
        let prev = vec![seen(1, Some(10), "s1", "甲"), seen(2, Some(20), "s2", "乙")];
        let cur = vec![seen(1, Some(10), "s1", "乙"), seen(2, Some(20), "s2", "甲")];
        let got = detect_renames(&prev, &cur);
        assert_eq!(got.iter().map(|c| c.verdict).collect::<Vec<_>>(), vec![Verdict::Chained, Verdict::Chained]);
    }

    /// 接力改名：乙先改走，甲才能接乙的名字。同一輪甲被擋、乙照做；下一輪甲照做
    #[test]
    fn 接力改名_先走的照做_接名字的下一輪再做() {
        let prev = vec![seen(1, Some(10), "s1", "甲"), seen(2, Some(20), "s2", "乙")];
        let cur = vec![seen(1, Some(10), "s1", "乙"), seen(2, Some(20), "s2", "丙")];
        let got = detect_renames(&prev, &cur);
        assert_eq!(got.iter().find(|c| c.pid == 1).unwrap().verdict, Verdict::Chained);
        assert_eq!(got.iter().find(|c| c.pid == 2).unwrap().verdict, Verdict::Go);
        let (next, _) = next_prev(&prev, &cur, &got, 5);
        assert_eq!(next.iter().find(|s| s.pid == 1).unwrap().name, "甲");
        assert_eq!(next.iter().find(|s| s.pid == 2).unwrap().name, "丙");
        let again = detect_renames(&next, &cur);
        assert_eq!(again, vec![Change { pid: 1, old: "甲".into(), new: "乙".into(), verdict: Verdict::Go }]);
    }

    /// 不在名單上的視窗的名字不算「被占用」：關掉的視窗留下的名字，別的視窗可以改成它
    #[test]
    fn 不在名單上的視窗不占名字() {
        let mut gone = seen(2, Some(20), "s2", "乙");
        gone.absent_since = Some(1);
        let prev = vec![seen(1, Some(10), "s1", "甲"), gone];
        let cur = vec![seen(1, Some(10), "s1", "乙")];
        assert_eq!(detect_renames(&prev, &cur)[0].verdict, Verdict::Go);
    }
}
