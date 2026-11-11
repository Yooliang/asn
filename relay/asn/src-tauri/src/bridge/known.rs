//! 認得的夥伴（todo-next-202、#766）：收發室每次更新名單時，把目前看得到的視窗名存檔（known-windows.json）。
//! 重開機或重開 ASN 後，夥伴視窗要過一陣子才會陸續接回來；這段時間寄給「存檔裡有、名單裡還沒有」的名字的信，
//! 不退回、不 ack（留在後台信箱），群組點名的游標不前進，等它接回來再依序送；等太久才照原本的做法退回並講明。
//! 本人在收發室跑著的時候關掉的視窗（從名單消失）立刻從存檔拿掉，照原本的做法退回。
//! 檔案壞了就當沒有（不影響收信）；寫檔一律原子寫入；只留最近 7 天看過、最多 200 個名字。
//! 本人關掉、或在帳號層封存的夥伴不留在存檔裡（重開機後不接回）：封存名單記在同一個檔案的 archived，見 [`Known::set_archived`]。
//! #767 共用這份檔案：多記對話編號、資料夾、是不是 ASN 開的、原本的權限與開機時間，重開機後自動接回要用（見 launch::auto_resume）。
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const KNOWN_FILE: &str = "known-windows.json";
const KEEP_MS: u64 = 7 * 24 * 3_600_000;
const MAX_NAMES: usize = 200;
/// 名單沒有變動時，「最後看到的時間」至少隔這麼久寫回檔案一次（不然名單連續 7 天不變，重開後全部被當成過期）
const REFRESH_SAVE_MS: u64 = 3_600_000;

/// 重開機後接回要用的資料（#767）。只有 Claude 視窗有。不含對話內容
#[derive(Clone, Default, Debug, PartialEq)]
pub struct WindowFacts {
    pub session: String,
    pub cwd: String,
    /// ASN 開的視窗才接回；使用者自己開的不動
    pub asn_opened: bool,
    /// 原本的權限旗標（只留認得的，見 launch::auto_resume）
    pub perm: Vec<String>,
    pub hidden: bool,
}

/// 接回要用的一筆（名字、引擎＋資料）
#[derive(Clone, Debug, PartialEq)]
pub struct KnownEntry {
    pub name: String,
    pub engine: String,
    pub facts: WindowFacts,
}

/// 開機時間容許的誤差：開機時間是用「現在－開機至今」算的，校時會讓它飄。
/// 取 1 分鐘：太寬會把「開機後幾分鐘內又重開」算成同一次開機（30家用 11-04 09:48、09:50 連續重開兩次，
/// 第一次開機就登入的話第二次就不接回）；校時造成的誤判最多多接一次，已開著的視窗會跳過，所以寧可窄
pub const BOOT_TOLERANCE_MS: u64 = 60_000;

#[derive(Default, Debug)]
pub struct Known {
    /// 名字 → （引擎, 最後看到的時間）
    names: BTreeMap<String, (String, u64)>,
    dirty: bool,
    /// 上次寫檔（或讀檔）的時間
    saved_at: u64,
    facts: BTreeMap<String, WindowFacts>,
    /// 這份名單是哪一次開機記的（毫秒時間）。舊檔沒有
    boot_ms: Option<u64>,
    /// 後台記的「已封存」名字（只含我們認得或看得到的名字）。封存的視窗可能還開著、每輪名單都看得到，
    /// 所以光 forget 不夠：touch／set_facts 看到這裡有的名字一律不記，重開機後接回也要排除（見 launch::auto_resume::pick）
    archived: BTreeSet<String>,
}

impl Known {
    pub fn load(file: &Path, now: u64) -> Known {
        let mut k = Known { saved_at: now, ..Default::default() };
        let Ok(t) = std::fs::read_to_string(file) else { return k };
        let Ok(v) = serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')) else { return k };
        for (name, e) in v.get("names").and_then(Value::as_object).into_iter().flatten() {
            let seen = e.get("seen").and_then(Value::as_u64).unwrap_or(0);
            if name.is_empty() || now.saturating_sub(seen) >= KEEP_MS {
                continue;
            }
            let engine = e.get("engine").and_then(Value::as_str).unwrap_or("").to_string();
            k.names.insert(name.clone(), (engine, seen));
            let text = |key: &str| e.get(key).and_then(Value::as_str).unwrap_or("").to_string();
            let perm: Vec<String> = e.get("perm").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
            let facts = WindowFacts { session: text("session"), cwd: text("cwd"), asn_opened: e.get("asn_opened").and_then(Value::as_bool).unwrap_or(false), perm, hidden: e.get("hidden").and_then(Value::as_bool).unwrap_or(false) };
            if facts != WindowFacts::default() {
                k.facts.insert(name.clone(), facts);
            }
        }
        k.boot_ms = v.get("boot_ms").and_then(Value::as_u64);
        k.archived = v.get("archived").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|s| !s.is_empty()).take(MAX_NAMES).map(String::from).collect();
        k
    }

    pub fn contains(&self, name: &str) -> bool {
        self.names.contains_key(name)
    }

    /// 看到這個視窗（時間更新不算要存檔：只有新名字、或引擎變了才存，避免每次更新名單都寫檔）
    pub fn touch(&mut self, name: &str, engine: &str, now: u64) {
        if self.archived.contains(name) {
            return;
        }
        match self.names.get_mut(name) {
            Some(e) if e.0 == engine => e.1 = now,
            Some(e) => {
                *e = (engine.to_string(), now);
                self.dirty = true;
            }
            None => {
                self.names.insert(name.to_string(), (engine.to_string(), now));
                self.dirty = true;
            }
        }
    }

    pub fn forget(&mut self, name: &str) {
        self.facts.remove(name);
        if self.names.remove(name).is_some() {
            self.dirty = true;
        }
    }

    /// 記下接回要用的資料；有變才存檔
    pub fn set_facts(&mut self, name: &str, facts: WindowFacts) {
        if self.archived.contains(name) {
            return;
        }
        if self.facts.get(name) != Some(&facts) {
            self.facts.insert(name.to_string(), facts);
            self.dirty = true;
        }
    }

    /// 後台說「已封存」的名字（整份換掉，不是累加：取消封存的名字要拿掉，之後看到它才會重新記）。
    /// 已封存的名字立刻從認得的清單拿掉；有變才存檔
    pub fn set_archived(&mut self, now_archived: BTreeSet<String>) {
        if self.archived != now_archived {
            self.archived = now_archived;
            self.dirty = true;
        }
        for n in self.archived.clone() {
            self.forget(&n);
        }
    }

    pub fn archived_names(&self) -> &BTreeSet<String> {
        &self.archived
    }

    pub fn boot_ms(&self) -> Option<u64> {
        self.boot_ms
    }

    /// 記下現在這次開機。誤差內不算換了，不寫檔
    pub fn set_boot(&mut self, boot: Option<u64>) {
        let Some(boot) = boot else { return };
        if !self.boot_ms.is_some_and(|b| same_boot(b, boot)) {
            self.boot_ms = Some(boot);
            self.dirty = true;
        }
    }

    /// 所有認得的名字與接回資料（沒有資料的是空的）
    pub fn entries(&self) -> Vec<KnownEntry> {
        self.names.iter().map(|(n, (e, _))| KnownEntry { name: n.clone(), engine: e.clone(), facts: self.facts.get(n).cloned().unwrap_or_default() }).collect()
    }

    /// 有變動才寫檔；寫不進去只回錯誤文字（呼叫端記 log），名單照常用記憶體裡的
    pub fn save_if_dirty(&mut self, file: &Path, now: u64) -> Result<(), String> {
        if !self.dirty && (self.names.is_empty() || now.saturating_sub(self.saved_at) < REFRESH_SAVE_MS) {
            return Ok(());
        }
        self.names.retain(|_, (_, seen)| now.saturating_sub(*seen) < KEEP_MS);
        while self.names.len() > MAX_NAMES {
            let oldest = self.names.iter().min_by_key(|(_, (_, s))| *s).map(|(n, _)| n.clone());
            match oldest {
                Some(n) => {
                    self.names.remove(&n);
                }
                None => break,
            }
        }
        let kept = &self.names;
        self.facts.retain(|n, _| kept.contains_key(n));
        let names: serde_json::Map<String, Value> = self
            .names
            .iter()
            .map(|(n, (eng, seen))| {
                let mut e = json!({ "engine": eng, "seen": seen });
                if let Some(f) = self.facts.get(n) {
                    e["session"] = json!(f.session);
                    e["cwd"] = json!(f.cwd);
                    e["asn_opened"] = json!(f.asn_opened);
                    e["perm"] = json!(f.perm);
                    e["hidden"] = json!(f.hidden);
                }
                (n.clone(), e)
            })
            .collect();
        let mut body = json!({ "version": 1, "names": names });
        if let Some(b) = self.boot_ms {
            body["boot_ms"] = json!(b);
        }
        if !self.archived.is_empty() {
            body["archived"] = json!(self.archived.iter().take(MAX_NAMES).collect::<Vec<_>>());
        }
        crate::write_atomic(file, &body.to_string()).map_err(|e| format!("{}：{e}", file.display()))?;
        self.dirty = false;
        self.saved_at = now;
        Ok(())
    }
}

pub fn same_boot(a: u64, b: u64) -> bool {
    a.abs_diff(b) <= BOOT_TOLERANCE_MS
}

/// 後台名單（`list` 的回應）裡，這台電腦的「已封存的鍵」命中的名字。鍵是夥伴 ID，或 `n:<節點>/<名字>`（還沒有夥伴 ID 時）。
/// 回 None＝看不出來（舊後台沒有 archived_keys、名單沒有這台）：呼叫端不要改動現有的封存名單
pub fn archived_among(list: &Value, node: &str, partners: &BTreeMap<String, String>, names: &[String]) -> Option<BTreeSet<String>> {
    let member = list.get("members")?.as_array()?.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(node))?;
    let keys: BTreeSet<String> = member.get("archived_keys")?.as_array()?.iter().filter_map(Value::as_str).map(String::from).collect();
    let hit = |n: &String| partners.get(n.as_str()).is_some_and(|id| keys.contains(id.as_str())) || keys.contains(format!("n:{node}/{n}").as_str());
    Some(names.iter().filter(|n| hit(n)).cloned().collect())
}

/// 本人在別處（本機名單右鍵）封存／取消封存之後，請收發室馬上重查封存名單，不等下一輪定時查。
/// 全程序共用一個旗標：只是提早查一次，多餘的觸發無害
static ARCHIVE_REFRESH: AtomicBool = AtomicBool::new(false);

pub fn request_archive_refresh() {
    ARCHIVE_REFRESH.store(true, Ordering::Relaxed);
}

/// 取走旗標（有人要求過回 true，並清掉）
pub fn take_archive_refresh() -> bool {
    ARCHIVE_REFRESH.swap(false, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 接回資料與開機時間存得回來_舊檔沒有也讀得起來_忘記就一起拿掉() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(KNOWN_FILE);
        std::fs::write(&f, r#"{"version":1,"names":{"舊":{"engine":"claude","seen":1000}}}"#).unwrap();
        let mut k = Known::load(&f, 1000);
        assert!(k.contains("舊") && k.boot_ms().is_none());
        assert_eq!(k.entries()[0].facts, WindowFacts::default(), "舊檔沒有接回資料");
        let facts = WindowFacts { session: "s1".into(), cwd: "D:/w".into(), asn_opened: true, perm: vec!["--permission-mode".into(), "auto".into()], hidden: true };
        k.set_facts("舊", facts.clone());
        k.set_boot(Some(500));
        k.save_if_dirty(&f, 1000).unwrap();
        let mut back = Known::load(&f, 1000);
        assert_eq!(back.entries()[0].facts, facts);
        assert_eq!(back.boot_ms(), Some(500));
        back.forget("舊");
        back.save_if_dirty(&f, 1000).unwrap();
        assert!(Known::load(&f, 1000).entries().is_empty());
    }

    #[test]
    fn 同一次開機的誤差約一分鐘_開機後幾分鐘內又重開算換了() {
        assert_eq!(BOOT_TOLERANCE_MS, 60_000);
        assert!(same_boot(1_000_000, 1_000_000 + 59_000), "校時的小誤差還是同一次開機");
        assert!(!same_boot(1_000_000, 1_000_000 + 2 * 60_000), "兩分鐘後又重開（30家用 09:48、09:50 那種）要算換了");
    }

    #[test]
    fn 開機時間在誤差內不算換了_不寫檔() {
        let mut k = Known { boot_ms: Some(1_000_000), ..Default::default() };
        k.set_boot(Some(1_000_000 + BOOT_TOLERANCE_MS));
        assert!(!k.dirty);
        assert_eq!(k.boot_ms(), Some(1_000_000));
        k.set_boot(None);
        assert!(!k.dirty, "讀不到開機時間就不動");
        k.set_boot(Some(1_000_000 + BOOT_TOLERANCE_MS + 1));
        assert!(k.dirty);
    }

    #[test]
    fn 資料沒變不寫檔() {
        let mut k = Known::default();
        let facts = WindowFacts { session: "s".into(), ..Default::default() };
        k.set_facts("甲", facts.clone());
        assert!(k.dirty);
        k.dirty = false;
        k.set_facts("甲", facts);
        assert!(!k.dirty);
    }

    #[test]
    fn 存檔讀回來_壞檔當沒有_過期的不留() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(KNOWN_FILE);
        let now = 10 * KEEP_MS;
        assert!(!Known::load(&f, now).contains("甲"), "沒有檔案");
        std::fs::write(&f, "不是 json").unwrap();
        assert!(!Known::load(&f, now).contains("甲"), "壞檔當沒有");
        let mut k = Known::default();
        k.touch("甲", "claude", now - 1000);
        k.touch("乙", "gemini", now - KEEP_MS - 1);
        k.save_if_dirty(&f, now - 1000).unwrap();
        let back = Known::load(&f, now);
        assert!(back.contains("甲") && !back.contains("乙"), "超過 7 天沒看到的不留");
    }

    #[test]
    fn 只有新名字或引擎變了才要存檔_忘記一個名字也要存() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(KNOWN_FILE);
        let mut k = Known::default();
        k.touch("甲", "claude", 1000);
        assert!(k.dirty);
        k.save_if_dirty(&f, 1000).unwrap();
        k.touch("甲", "claude", 2000);
        assert!(!k.dirty, "只是看到的時間更新：不存");
        k.touch("甲", "codex", 3000);
        assert!(k.dirty);
        k.save_if_dirty(&f, 3000).unwrap();
        k.forget("甲");
        assert!(k.dirty);
        k.save_if_dirty(&f, 4000).unwrap();
        assert!(!Known::load(&f, 4000).contains("甲"));
    }

    #[test]
    fn 名單沒變動也要定時把最後看到的時間寫回_不然連續七天不變重開後全不認得() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(KNOWN_FILE);
        let mut k = Known::default();
        k.touch("甲", "claude", 1000);
        k.save_if_dirty(&f, 1000).unwrap();
        // 之後每分鐘看到一次（名單沒變）：不到 1 小時不寫
        for m in 1..=59u64 {
            k.touch("甲", "claude", 1000 + m * 60_000);
            k.save_if_dirty(&f, 1000 + m * 60_000).unwrap();
        }
        assert_eq!(Known::load(&f, 1000).names["甲"].1, 1000, "還沒到 1 小時：檔案裡仍是第一次看到的時間");
        k.touch("甲", "claude", 1000 + 3_600_000);
        k.save_if_dirty(&f, 1000 + 3_600_000).unwrap();
        assert_eq!(Known::load(&f, 1000 + 3_600_000).names["甲"].1, 1000 + 3_600_000, "滿 1 小時寫回最後看到的時間");
        // 連續很久都在：檔案裡的時間跟著更新，超過 7 天後重開仍認得
        let mut t = 1000 + 3_600_000;
        for _ in 0..(8 * 24) {
            t += 3_600_000;
            k.touch("甲", "claude", t);
            k.save_if_dirty(&f, t).unwrap();
        }
        assert!(Known::load(&f, t + 1000).contains("甲"), "名單連續 8 天沒變動，重開後還認得");
    }

    #[test]
    fn 最多留_200_個_留最近看到的() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(KNOWN_FILE);
        let mut k = Known::default();
        for i in 0..210u64 {
            k.touch(&format!("夥伴{i}"), "claude", 1000 + i);
        }
        k.save_if_dirty(&f, 2000).unwrap();
        let back = Known::load(&f, 2000);
        assert_eq!(back.names.len(), MAX_NAMES);
        assert!(!back.contains("夥伴0") && back.contains("夥伴209"));
    }

    #[test]
    fn 封存的名字不再被記_存檔讀得回來_取消封存後才會重新記() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(KNOWN_FILE);
        let mut k = Known::default();
        k.touch("甲", "claude", 1000);
        k.touch("乙", "claude", 1000);
        k.set_facts("乙", WindowFacts { session: "s".into(), asn_opened: true, ..Default::default() });
        k.set_archived(["乙".to_string()].into_iter().collect());
        assert!(k.contains("甲") && !k.contains("乙"), "封存的立刻從認得的清單拿掉");
        assert!(k.entries().iter().all(|e| e.name != "乙"));
        // 封存的視窗還開著：每輪名單都看得到它，不能又被記回來
        k.touch("乙", "claude", 2000);
        k.set_facts("乙", WindowFacts { session: "s".into(), asn_opened: true, ..Default::default() });
        assert!(!k.contains("乙"));
        k.save_if_dirty(&f, 2000).unwrap();
        let mut back = Known::load(&f, 2000);
        assert!(back.archived_names().contains("乙") && back.contains("甲") && !back.contains("乙"));
        // 取消封存：名單換掉之後，再看到它才重新記
        back.set_archived(BTreeSet::new());
        back.touch("乙", "claude", 3000);
        assert!(back.contains("乙"));
    }

    #[test]
    fn 後台名單的封存鍵對得上夥伴_id_或節點加名字_看不出來就回_none() {
        let list = json!({ "members": [
            { "id": "H", "archived_keys": ["p_aaaaaaaaaaaaaaaaaaaa", "n:H/沒有編號"] },
            { "id": "X", "archived_keys": ["n:X/別台"] },
            { "id": "舊後台" }
        ]});
        let partners: BTreeMap<String, String> = [("有編號".to_string(), "p_aaaaaaaaaaaaaaaaaaaa".to_string())].into_iter().collect();
        let names: Vec<String> = ["有編號", "沒有編號", "沒封存", "別台"].iter().map(|s| s.to_string()).collect();
        let got = archived_among(&list, "H", &partners, &names).unwrap();
        assert_eq!(got.into_iter().collect::<Vec<_>>(), vec!["有編號".to_string(), "沒有編號".to_string()], "別台的封存不算在這台");
        assert!(archived_among(&list, "舊後台", &partners, &names).is_none(), "舊後台沒有 archived_keys：不改動");
        assert!(archived_among(&list, "Z", &partners, &names).is_none(), "名單裡沒有這台");
        assert!(archived_among(&json!({ "error": "x" }), "H", &partners, &names).is_none());
    }

    #[test]
    fn 要求重查的旗標取走就清掉() {
        let _ = take_archive_refresh();
        request_archive_refresh();
        assert!(take_archive_refresh());
        assert!(!take_archive_refresh());
    }
}
