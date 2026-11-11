//! 手機確認電腦的指紋：從四個選項裡選出電腦上顯示的那一組（只在手機建置使用）。
//! 四個選項與正確答案的位置每台電腦只出一次、存在 device_id 的 KnownPeer 上（這裡只負責出選項的算法）；
//! 這裡的記憶體只放「目前開著的題目」：每台電腦同時只有一題，過期用單調時鐘（Instant）算，不受手機改時間影響。
//! 畫面只拿到選項文字，答案由 Rust 判斷，畫面永遠不知道哪個是對的。
//! 這個檔案不寫任何日誌、不發事件（守門測試鎖住）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 題目的有效時間
pub const CHALLENGE_TTL: Duration = Duration::from_secs(120);
/// 選對之後，到真正記住之前的有效時間
pub const PASSED_TTL: Duration = Duration::from_secs(60);
/// 同時最多留幾個題目；滿了只丟還沒選的，選對等著記住的絕不丟
pub const MAX_PENDING: usize = 16;
/// 畫面回「都不一樣」的數字
pub const PICK_NONE: i64 = -1;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Asked,
    Passed,
}

#[derive(Clone)]
pub struct Pending {
    pub node: String,
    /// 出題當時這支手機記住的公鑰
    pub sign_pub: String,
    pub answer: usize,
    pub issued: Instant,
    pub expires: Instant,
    pub stage: Stage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Right,
    Wrong,
    NoneMatch,
    Expired,
}

impl Outcome {
    /// 給畫面的字
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Right => "right",
            Outcome::Wrong => "wrong",
            Outcome::NoneMatch => "none",
            Outcome::Expired => "expired",
        }
    }
}

/// 題目都被「選對、等著記住」的占滿了，這次不出新題
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Busy;

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().flat_map(|b| [HEX[(b >> 4) as usize] as char, HEX[(b & 15) as usize] as char]).collect()
}

/// 每 4 個字元一組、空格隔開（和 device_id::fp_grouped 同一種寫法）
fn grouped(fp16: &str) -> String {
    fp16.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

fn rand_below(rng: &mut impl FnMut(&mut [u8]), n: usize) -> usize {
    let mut b = [0u8; 4];
    rng(&mut b);
    (u32::from_le_bytes(b) as usize) % n
}

/// 出四個選項：正確的一個、三個亂數湊的（前 4 個字元與正確的、彼此都不同），洗牌後回（四個分組字串、正確的是第幾個）
pub fn make_options(correct_fp16: &str, mut rng: impl FnMut(&mut [u8])) -> (Vec<String>, usize) {
    // 誘餌和正確那組共用第一組 4 碼，從第二組起各自不同（第二組彼此也不同）：只比第一組分不出來，要比完整 16 碼
    let head: String = correct_fp16.chars().take(4).collect();
    let mut used: Vec<String> = vec![correct_fp16.chars().skip(4).take(4).collect()];
    let mut items: Vec<(String, bool)> = vec![(grouped(correct_fp16), true)];
    for _ in 0..3 {
        let mut fp = String::new();
        for _ in 0..64 {
            let mut b = [0u8; 6];
            rng(&mut b);
            let tail = hex_of(&b);
            if !used.contains(&tail[..4].to_string()) {
                fp = format!("{head}{tail}");
                break;
            }
        }
        if fp.is_empty() {
            // 亂數一直撞（不該發生）：照順序找一個沒用過的第二組
            let second = (0..=0xffffu32).map(|n| format!("{n:04x}")).find(|h| !used.contains(h)).unwrap_or_default();
            fp = format!("{head}{second}000000{:02x}", items.len());
        }
        used.push(fp[4..8].to_string());
        items.push((grouped(&fp), false));
    }
    for i in (1..items.len()).rev() {
        let j = rand_below(&mut rng, i + 1);
        items.swap(i, j);
    }
    let answer = items.iter().position(|(_, ok)| *ok).unwrap_or(0);
    (items.into_iter().map(|(s, _)| s).collect(), answer)
}

#[derive(Default)]
pub struct Store {
    map: HashMap<String, Pending>,
}

impl Store {
    fn prune(&mut self, now: Instant) {
        self.map.retain(|_, p| now < p.expires);
    }

    /// 出題：這台電腦已經有一題開著（還沒選）就回同一個編號；沒有才新開。
    /// 滿了只丟最舊的「還沒選」的；全都是選對等著記住的就不出新題（回 Busy）
    pub fn issue(&mut self, node: &str, sign_pub: &str, answer: usize, now: Instant, mut rng: impl FnMut(&mut [u8])) -> Result<String, Busy> {
        self.prune(now);
        if let Some((id, _)) = self.map.iter().find(|(_, p)| p.node == node && p.stage == Stage::Asked) {
            return Ok(id.clone());
        }
        while self.map.len() >= MAX_PENDING {
            let oldest = self.map.iter().filter(|(_, p)| p.stage == Stage::Asked).min_by_key(|(_, p)| p.issued).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.map.remove(&k);
                }
                None => return Err(Busy),
            }
        }
        let mut idb = [0u8; 16];
        rng(&mut idb);
        let id = hex_of(&idb);
        self.map.insert(id.clone(), Pending { node: node.to_string(), sign_pub: sign_pub.to_string(), answer, issued: now, expires: now + CHALLENGE_TTL, stage: Stage::Asked });
        Ok(id)
    }

    /// 這個題目編號是哪台電腦的（只有還沒選的題目才查得到）
    pub fn node_of(&mut self, id: &str, now: Instant) -> Option<String> {
        self.prune(now);
        self.map.get(id).filter(|p| p.stage == Stage::Asked).map(|p| p.node.clone())
    }

    /// 回答：pick 是第幾個（從 0 起），-1 是「都不一樣」。錯、都不一樣、過期都把題目收掉（不能重選）；選對就換成「過關」，再給 60 秒記住
    pub fn answer(&mut self, id: &str, pick: i64, now: Instant) -> Outcome {
        self.prune(now);
        let (stage, correct) = match self.map.get(id) {
            Some(p) => (p.stage, p.answer as i64),
            None => return Outcome::Expired,
        };
        if stage != Stage::Asked {
            self.map.remove(id);
            return Outcome::Expired;
        }
        if pick == correct {
            if let Some(p) = self.map.get_mut(id) {
                p.stage = Stage::Passed;
                p.expires = now + PASSED_TTL;
            }
            return Outcome::Right;
        }
        self.map.remove(id);
        if pick == PICK_NONE {
            Outcome::NoneMatch
        } else {
            Outcome::Wrong
        }
    }

    /// 記住之前取走過關的題目（只能取一次）；沒過關、過期、沒有這題都回 None
    pub fn take_passed(&mut self, id: &str, now: Instant) -> Option<(String, String)> {
        self.prune(now);
        if self.map.get(id).is_some_and(|p| p.stage == Stage::Passed) {
            self.map.remove(id).map(|p| (p.node, p.sign_pub))
        } else {
            None
        }
    }

    /// 這台電腦被忘記：它所有的題目都作廢
    pub fn drop_node(&mut self, node: &str) {
        self.map.retain(|_, p| p.node != node);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

/// 系統亂數取不到時回錯誤（不 panic）
pub const NO_RANDOM: &str = "系統亂數不可用";

/// 用系統亂數跑 f；途中取不到亂數就整個作廢、回錯誤
fn with_os_rng<T>(f: impl FnOnce(&mut dyn FnMut(&mut [u8])) -> T) -> Result<T, String> {
    let mut failed = false;
    let out = f(&mut |b: &mut [u8]| {
        if getrandom::fill(b).is_err() {
            failed = true;
            b.fill(0);
        }
    });
    if failed {
        Err(NO_RANDOM.to_string())
    } else {
        Ok(out)
    }
}

/// 用系統亂數出四個選項（每台電腦只在第一次出題時叫一次，結果存在那台的紀錄上）
pub fn options_for(fp16: &str) -> Result<(Vec<String>, usize), String> {
    with_os_rng(|rng| make_options(fp16, rng))
}

/// 出題（或回這台已經開著的那題）：答案由呼叫端從記住的紀錄帶進來，只留在記憶體
/// 同時開著的題目太多（而且都已過關、在等確認）
pub const BUSY: &str = "busy";

pub fn issue(node: &str, sign_pub: &str, answer: usize) -> Result<String, String> {
    let mut g = store().lock().unwrap_or_else(|e| e.into_inner());
    match with_os_rng(|rng| g.issue(node, sign_pub, answer, Instant::now(), rng)) {
        Ok(r) => r.map_err(|_| BUSY.to_string()),
        Err(e) => Err(e),
    }
}

pub fn node_of(id: &str) -> Option<String> {
    store().lock().unwrap_or_else(|e| e.into_inner()).node_of(id, Instant::now())
}

pub fn answer(id: &str, pick: i64) -> Outcome {
    store().lock().unwrap_or_else(|e| e.into_inner()).answer(id, pick, Instant::now())
}

pub fn take_passed(id: &str) -> Option<(String, String)> {
    store().lock().unwrap_or_else(|e| e.into_inner()).take_passed(id, Instant::now())
}

pub fn drop_node(node: &str) {
    store().lock().unwrap_or_else(|e| e.into_inner()).drop_node(node)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "a93cc5191f2e3b4d";

    /// 固定的亂數：xorshift，種子相同結果相同
    fn rng(seed: u64) -> impl FnMut(&mut [u8]) {
        // 不同的種子一定給不同的序列（不能用 seed | 1：20 和 21 會變成同一個）
        let mut s = (seed << 1) | 1;
        move |buf: &mut [u8]| {
            for b in buf.iter_mut() {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                *b = (s >> 24) as u8;
            }
        }
    }

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn 四個選項_只有一個是正確的_第一組都一樣_第二組都不同_答案位置對() {
        for seed in 1..200u64 {
            let (opts, ans) = make_options(FP, rng(seed));
            assert_eq!(opts.len(), 4);
            assert_eq!(opts[ans], "a93c c519 1f2e 3b4d");
            assert_eq!(opts.iter().filter(|o| o.replace(' ', "") == FP).count(), 1);
            assert!(opts.iter().all(|o| &o[..4] == "a93c"), "只比第一組分不出來：{opts:?}");
            let mut seconds: Vec<&str> = opts.iter().map(|o| &o[5..9]).collect();
            seconds.sort();
            seconds.dedup();
            assert_eq!(seconds.len(), 4, "第二組彼此不同：{opts:?}");
            for o in &opts {
                assert_eq!(o.len(), 19);
                assert_eq!(o.split(' ').count(), 4);
                assert!(o.replace(' ', "").chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "{o}");
            }
        }
    }

    #[test]
    fn 洗牌會隨亂數變_答案不固定在同一格() {
        let ans: std::collections::HashSet<usize> = (1..100u64).map(|s| make_options(FP, rng(s)).1).collect();
        assert_eq!(ans.len(), 4, "四個位置都會出現：{ans:?}");
        assert_ne!(make_options(FP, rng(1)).0, make_options(FP, rng(2)).0);
        assert_eq!(make_options(FP, rng(7)), make_options(FP, rng(7)), "同樣的亂數同樣的結果");
    }

    #[test]
    fn 亂數一直撞也不卡住_第一組一樣_第二組還是四個不同() {
        let (opts, ans) = make_options(FP, |b: &mut [u8]| b.fill(0xc5));
        assert_eq!(opts.len(), 4);
        assert_eq!(opts[ans], "a93c c519 1f2e 3b4d");
        assert!(opts.iter().all(|o| &o[..4] == "a93c"), "{opts:?}");
        let mut seconds: Vec<&str> = opts.iter().map(|o| &o[5..9]).collect();
        seconds.sort();
        seconds.dedup();
        assert_eq!(seconds.len(), 4, "{opts:?}");
        assert!(opts.iter().all(|o| o.len() == 19), "{opts:?}");
    }

    #[test]
    fn 系統亂數_取得到就出題_取不到回錯誤不當掉() {
        let (opts, _) = options_for(FP).expect("一般情況取得到");
        assert_eq!(opts.len(), 4);
        assert_eq!(with_os_rng(|_| 1), Ok(1));
        let src = include_str!("known_pick.rs").replace("\r\n", "\n");
        let prod = src.split("\n#[cfg(test)]").next().unwrap();
        assert!(!prod.contains(".expect(") && !prod.contains(".unwrap()"), "正式程式碼不 panic");
    }

    /// 為某台電腦出題，答案固定是 2
    fn issued(s: &mut Store, node: &str, now: Instant, seed: u64) -> String {
        s.issue(node, "pk", 2, now, rng(seed)).unwrap()
    }

    #[test]
    fn 選對_錯_都不一樣_過期_各自的結果() {
        let t = Instant::now();
        let mut s = Store::default();
        let id = issued(&mut s, "a", t, 3);
        assert_eq!(s.answer(&id, 2, at(t, 500)), Outcome::Right);
        let id = issued(&mut s, "b", t, 4);
        assert_eq!(s.answer(&id, 3, at(t, 500)), Outcome::Wrong);
        let id = issued(&mut s, "c", t, 5);
        assert_eq!(s.answer(&id, PICK_NONE, at(t, 500)), Outcome::NoneMatch);
        let id = issued(&mut s, "d", t, 6);
        assert_eq!(s.answer(&id, 2, t + CHALLENGE_TTL), Outcome::Expired, "剛好到期就算過期");
        assert_eq!(s.answer("沒有這題", 0, at(t, 500)), Outcome::Expired);
        let id = issued(&mut s, "e", t, 7);
        assert_eq!(s.answer(&id, 4, at(t, 500)), Outcome::Wrong, "超出範圍算選錯");
        let id = issued(&mut s, "f", t, 8);
        assert_eq!(s.answer(&id, -2, at(t, 500)), Outcome::Wrong);
    }

    #[test]
    fn 選錯就收掉_不能重選_再回答是過期() {
        let t = Instant::now();
        let mut s = Store::default();
        let id = issued(&mut s, "a", t, 9);
        assert_eq!(s.answer(&id, 0, at(t, 10)), Outcome::Wrong);
        assert_eq!(s.answer(&id, 2, at(t, 20)), Outcome::Expired, "選對的那個也不行");
        assert_eq!(s.len(), 0);
        let id = issued(&mut s, "a", t, 10);
        assert_eq!(s.answer(&id, PICK_NONE, at(t, 10)), Outcome::NoneMatch);
        assert_eq!(s.answer(&id, PICK_NONE, at(t, 20)), Outcome::Expired);
    }

    #[test]
    fn 每台電腦同時只有一題_再出題回同一個編號_別台不受影響() {
        let t = Instant::now();
        let mut s = Store::default();
        let a = issued(&mut s, "pc", t, 1);
        assert_eq!(issued(&mut s, "pc", at(t, 5), 2), a, "不論亂數，同一台回同一題");
        assert_eq!(s.len(), 1);
        let b = issued(&mut s, "pc2", at(t, 5), 3);
        assert_ne!(a, b);
        assert_eq!(s.len(), 2);
        assert_eq!(s.node_of(&a, at(t, 6)), Some("pc".to_string()));
        assert_eq!(s.node_of("沒有", at(t, 6)), None);
        // 題目收掉（選錯）之後才會出新的
        assert_eq!(s.answer(&a, 0, at(t, 7)), Outcome::Wrong);
        assert_ne!(issued(&mut s, "pc", at(t, 8), 4), a);
        // 這台被忘記：它的題目都作廢
        s.drop_node("pc");
        assert_eq!(s.len(), 1);
        assert_eq!(s.node_of(&b, at(t, 9)), Some("pc2".to_string()));
    }

    #[test]
    fn 過關才取得走_只能一次_六十秒內_用單調時間算() {
        let t = Instant::now();
        let mut s = Store::default();
        let id = issued(&mut s, "pc", t, 11);
        assert_eq!(s.take_passed(&id, at(t, 5)), None, "沒選過不能取");
        assert_eq!(s.answer(&id, 2, at(t, 100_000)), Outcome::Right, "選的時候還在 120 秒內");
        assert_eq!(s.node_of(&id, at(t, 100_001)), None, "選對的不再算開著的題目");
        let got = s.take_passed(&id, at(t, 100_000 + 59_999));
        assert_eq!(got, Some(("pc".to_string(), "pk".to_string())));
        assert_eq!(s.take_passed(&id, at(t, 100_000 + 59_999)), None, "只能取一次");
        let id = issued(&mut s, "pc", t, 12);
        assert_eq!(s.answer(&id, 2, at(t, 10)), Outcome::Right);
        assert_eq!(s.take_passed(&id, at(t, 10) + PASSED_TTL), None, "過了 60 秒");
        assert_eq!(s.len(), 0);
        let id = issued(&mut s, "pc", t, 13);
        assert_eq!(s.answer(&id, 2, at(t, 10)), Outcome::Right);
        assert_eq!(s.answer(&id, 2, at(t, 11)), Outcome::Expired, "過關後再答不算數");
        assert_eq!(s.take_passed(&id, at(t, 12)), None);
    }

    #[test]
    fn 過期的每次呼叫都清掉_數量有上限丟最舊的還沒選的() {
        let t = Instant::now();
        let mut s = Store::default();
        let old = issued(&mut s, "x", t, 20);
        issued(&mut s, "y", at(t, 5) + CHALLENGE_TTL, 21);
        assert!(s.node_of(&old, at(t, 6) + CHALLENGE_TTL).is_none() && s.len() == 1, "出新題時舊的過期題被清掉");
        let mut s = Store::default();
        let first = issued(&mut s, "n0", t, 30);
        for i in 1..(MAX_PENDING as u64 + 5) {
            issued(&mut s, &format!("n{i}"), at(t, i), 30 + i);
        }
        assert_eq!(s.len(), MAX_PENDING);
        assert!(s.node_of(&first, at(t, 100)).is_none(), "最舊的被丟掉");
        let last = issued(&mut s, "新的", at(t, 100), 99);
        assert!(s.node_of(&last, at(t, 101)).is_some() && s.len() == MAX_PENDING);
    }

    #[test]
    fn 滿了也絕不丟選對等著記住的_全是選對的就不出新題() {
        let t = Instant::now();
        let mut s = Store::default();
        let mut ids = Vec::new();
        for i in 0..MAX_PENDING as u64 {
            let id = issued(&mut s, &format!("n{i}"), at(t, i), 40 + i);
            assert_eq!(s.answer(&id, 2, at(t, 50)), Outcome::Right);
            ids.push(id);
        }
        assert_eq!(s.len(), MAX_PENDING);
        assert_eq!(s.issue("新的", "pk", 1, at(t, 60), rng(99)), Err(Busy), "全是選對的：拒絕，不丟任何一個");
        assert_eq!(s.len(), MAX_PENDING);
        for id in &ids {
            assert!(s.map.contains_key(id), "選對的都還在");
        }
        // 混著還沒選的：只丟還沒選的，選對的都留著
        let mut s = Store::default();
        let asked = issued(&mut s, "a0", t, 1);
        let mut passed = Vec::new();
        for i in 1..MAX_PENDING as u64 {
            let id = issued(&mut s, &format!("p{i}"), at(t, i), 100 + i);
            assert_eq!(s.answer(&id, 2, at(t, 50)), Outcome::Right);
            passed.push(id);
        }
        let fresh = s.issue("新的", "pk", 1, at(t, 60), rng(98)).unwrap();
        assert!(!s.map.contains_key(&asked) && s.map.contains_key(&fresh));
        assert!(passed.iter().all(|id| s.map.contains_key(id)));
        assert_eq!(s.len(), MAX_PENDING);
    }

    #[test]
    fn 守門_這裡不寫日誌_不發事件() {
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("known_pick.rs")).unwrap().replace("\r\n", "\n");
        let code = src.split("\n#[cfg(test)]").next().unwrap();
        for bad in ["elog!", "olog!", concat!("print", "ln!"), concat!("db", "g!"), "log::", "tracing::", "emit(", "emit_to(", "ui_log"] {
            assert!(!code.contains(bad), "known_pick.rs 不能有：{bad}");
        }
        assert!(!code.contains("now_ms"), "題目的有效期用單調時間，不用牆上時間");
    }
}
