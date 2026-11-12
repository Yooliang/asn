//! 別台打字的反向通道（0.2.10）：D＝打字的那台，T＝被打字的那台。這裡只有判斷和密碼學，不碰網路和窗格。
//!
//! - **只送打字：** 每一幅只有兩個欄位，`d`（字）和 `p`（是不是貼上）。沒有指令、沒有視窗編號；視窗在握手時就綁定了。
//! - **另一把金鑰：** 從這次的金鑰再導出（標籤 [`KEY_LABEL`]），和畫面用的那把不同；AAD 帶 session id、方向、序號。
//! - **不掉字、不亂序：** 每幅有序號，T 嚴格依序交出去，最多先收 [`MAX_AHEAD`] 幅等前面的；T 的畫面幀帶「已套用到第幾號」，
//!   D 沒收到確認就補送，T 用序號去重。缺號超過 [`GAP_END_MS`] 就結束這次打字，**不跳過缺的字**。
//! - **上限：** 每幅 [`MAX_DATA_BYTES`]；每秒 [`MAX_PER_SEC`] 幅；一次總量 [`MAX_TOTAL_BYTES`]。超過就結束，不丟字也不截斷。
//! - 閒置 [`IDLE_END_MS`] 沒有新的字，T 結束這次打字。
//! - 字交給窗格之前還會經過 `LiveTerms::view_input`（按鍵規則、貼上清理、接手窗格不給、資料夾授權），和本機看畫面打字同一個入口。
#![cfg_attr(not(test), allow(dead_code))]
use crate::view_handshake::{self, Eph, Session, SessionKey};
use crate::view_frame::DReceiver;
#[cfg(desktop)]
use crate::view_stream::End;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::aead;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

/// 導出打字金鑰的標籤（D→T 方向）
pub const KEY_LABEL: &[u8] = b"asn-view-input-d2t-v1";
/// broadcast 的事件名，內容欄位 `w`
pub const EVENT: &str = "input";
/// 一幅最多幾個位元組的字
pub const MAX_DATA_BYTES: usize = 4 * 1024;
/// 每秒最多幾幅
pub const MAX_PER_SEC: u32 = 50;
/// 一次打字的總量上限
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024;
/// T 最多先收幾幅等前面的
pub const MAX_AHEAD: u64 = 64;
/// 缺號多久就結束（毫秒）
pub const GAP_END_MS: u64 = 5_000;
/// 多久沒有新的字就結束（毫秒）
pub const IDLE_END_MS: u64 = 120_000;
/// D 多久沒收到確認就補送（毫秒）
pub const RESEND_MS: u64 = 1_000;
/// 連續解不開幾幅就結束
pub const BAD_END: u32 = 5;
const NONCE_LEN: usize = 12;
const SEQ_LEN: usize = 8;
/// 一幅密文（base64）最長多少：控制字元在 JSON 裡會變成 6 個字元（例如 ESC），再加序號、nonce、tag、base64 的餘裕
const MAX_WIRE: usize = 40 * 1024;

pub const TOO_FAST: &str = "打太快了，這段沒有送出，請再試一次";
pub const TOO_LONG: &str = "一次貼上的字太多，這段沒有送出，請分段貼上";
/// 看的那台同時只能在幾個畫面打字（和後台每台被打字的上限相同）
pub const MAX_OPEN: usize = 1;
pub const TOO_MANY: &str = "同時只能在一個畫面打字，請先結束另一個";

pub const TOO_MUCH: &str = "這次打字的字數到上限了，這段沒有送出，請結束後再開一次";

/// 一幅打字：字和是不是貼上。**沒有別的欄位**（多的就解不開）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keys {
    pub d: String,
    #[serde(default)]
    pub p: bool,
}

/// 打字用的金鑰：從這次的金鑰導出
pub fn input_key(k: &SessionKey) -> Result<SessionKey, String> {
    k.sub(KEY_LABEL)
}

fn aad(session_id: &str, seq: u64) -> Vec<u8> {
    format!("asn-view-input-v1|{session_id}|d2t|{seq}").into_bytes()
}

fn aead_key(key: &SessionKey) -> Result<aead::LessSafeKey, String> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key.raw()).map(aead::LessSafeKey::new).map_err(|_| "金鑰不對".to_string())
}

/// 加密一幅打字：`seq + nonce + 密文`，再 base64
pub fn seal(key: &SessionKey, session_id: &str, seq: u64, k: &Keys) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "產生亂數失敗".to_string())?;
    let mut buf = serde_json::to_vec(k).map_err(|_| "格式不對".to_string())?;
    aead_key(key)?
        .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad(session_id, seq)), &mut buf)
        .map_err(|_| "加密失敗".to_string())?;
    let mut out = Vec::with_capacity(SEQ_LEN + NONCE_LEN + buf.len());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(B64.encode(out))
}

/// 解開一幅打字。回（序號, 字）。失敗只回籠統原因，不帶內容
pub fn open(key: &SessionKey, session_id: &str, wire: &str) -> Result<(u64, Keys), String> {
    if wire.len() > MAX_WIRE {
        return Err("太長".into());
    }
    let raw = B64.decode(wire).map_err(|_| "格式不對".to_string())?;
    if raw.len() < SEQ_LEN + NONCE_LEN {
        return Err("格式不對".into());
    }
    let (head, rest) = raw.split_at(SEQ_LEN);
    let (nonce, cipher) = rest.split_at(NONCE_LEN);
    let seq = u64::from_be_bytes(head.try_into().map_err(|_| "格式不對".to_string())?);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| "格式不對".to_string())?;
    let mut buf = cipher.to_vec();
    let plain = aead_key(key)?
        .open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad(session_id, seq)), &mut buf)
        .map_err(|_| "解不開".to_string())?;
    let k: Keys = serde_json::from_slice(plain).map_err(|_| "格式不對".to_string())?;
    if k.d.is_empty() || k.d.len() > MAX_DATA_BYTES {
        return Err("格式不對".into());
    }
    Ok((seq, k))
}

/// 收到一則 broadcast：只認 event=input，內容欄位 w。其他一律丟掉
pub fn wire_of(event: &str, payload: &serde_json::Value) -> Option<String> {
    if event != EVENT {
        return None;
    }
    payload.get("w").and_then(serde_json::Value::as_str).map(str::to_string)
}

/// T 為什麼結束打字
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputEnd {
    /// 缺號太久（網路不穩），沒有跳過缺的字
    Gap,
    /// 太久沒打字
    Idle,
    /// 一直解不開
    Bad,
    /// 太快或太多
    TooMuch,
}

impl InputEnd {
    #[cfg(desktop)]
    pub fn end(self) -> End {
        match self {
            InputEnd::Idle => End::InputIdle,
            InputEnd::Gap | InputEnd::Bad | InputEnd::TooMuch => End::InputStopped,
        }
    }
    /// 紀錄用（不含內容）
    pub fn label(self) -> &'static str {
        match self {
            InputEnd::Gap => "input_gap",
            InputEnd::Idle => "input_idle",
            InputEnd::Bad => "input_bad",
            InputEnd::TooMuch => "input_too_much",
        }
    }
}

/// 每秒幾幅的計數
#[derive(Debug, Default)]
struct Rate {
    sec: u64,
    n: u32,
}

impl Rate {
    fn roll(&mut self, now_ms: u64) {
        let sec = now_ms / 1000;
        if sec != self.sec {
            self.sec = sec;
            self.n = 0;
        }
    }
    /// 這一秒還放得下 k 幅嗎（不記帳）
    fn room(&mut self, now_ms: u64, k: u32) -> bool {
        self.roll(now_ms);
        self.n + k <= MAX_PER_SEC
    }
    /// 記 k 幅；放不下就不記、回 false
    fn take(&mut self, now_ms: u64, k: u32) -> bool {
        if !self.room(now_ms, k) {
            return false;
        }
        self.n += k;
        true
    }
    fn hit(&mut self, now_ms: u64) -> bool {
        self.take(now_ms, 1)
    }
}

/// T 收打字：依序交出去、去重、缺號計時、閒置計時、上限
pub struct TInput {
    key: SessionKey,
    session_id: String,
    applied: u64,
    ahead: BTreeMap<u64, Keys>,
    gap_since: Option<u64>,
    last_ms: u64,
    total: u64,
    bad: u32,
    rate: Rate,
    ended: Option<InputEnd>,
}

impl TInput {
    /// key 是打字用的那把（[`input_key`]）
    pub fn new(key: SessionKey, session_id: &str, now_ms: u64) -> Self {
        TInput { key, session_id: session_id.to_string(), applied: 0, ahead: BTreeMap::new(), gap_since: None, last_ms: now_ms, total: 0, bad: 0, rate: Rate::default(), ended: None }
    }

    /// 收到一幅（還沒交出去）。重複的、太前面的丟掉（D 會補送）；解不開的、太快太多的記下來，下一次 [`TInput::take`] 結束
    pub fn push(&mut self, wire: &str, now_ms: u64) {
        if self.ended.is_some() {
            return;
        }
        let (seq, k) = match open(&self.key, &self.session_id, wire) {
            Ok(v) => v,
            Err(_) => {
                self.bad += 1;
                if self.bad >= BAD_END {
                    self.ended = Some(InputEnd::Bad);
                }
                return;
            }
        };
        self.bad = 0;
        if seq <= self.applied || self.ahead.contains_key(&seq) || seq > self.applied + MAX_AHEAD {
            return;
        }
        if !self.rate.hit(now_ms) {
            self.ended = Some(InputEnd::TooMuch);
            return;
        }
        self.total += k.d.len() as u64;
        if self.total > MAX_TOTAL_BYTES {
            self.ended = Some(InputEnd::TooMuch);
            return;
        }
        self.ahead.insert(seq, k);
    }

    /// 依序取出可以交給窗格的字；缺號太久、太久沒打字、之前記下的錯誤都回結束
    pub fn take(&mut self, now_ms: u64) -> Result<Vec<Keys>, InputEnd> {
        if let Some(e) = self.ended {
            return Err(e);
        }
        let mut out = Vec::new();
        while let Some(k) = self.ahead.remove(&(self.applied + 1)) {
            self.applied += 1;
            self.last_ms = now_ms;
            out.push(k);
        }
        if self.ahead.is_empty() {
            self.gap_since = None;
        } else if now_ms.saturating_sub(*self.gap_since.get_or_insert(now_ms)) > GAP_END_MS {
            self.ended = Some(InputEnd::Gap);
            return Err(InputEnd::Gap);
        }
        if out.is_empty() && now_ms.saturating_sub(self.last_ms) > IDLE_END_MS {
            self.ended = Some(InputEnd::Idle);
            return Err(InputEnd::Idle);
        }
        Ok(out)
    }

    /// 已經交出去到第幾號（放進畫面幀給 D 確認）
    pub fn applied(&self) -> u64 {
        self.applied
    }
}

/// 一幅還沒被確認的打字
struct Pending {
    seq: u64,
    wire: String,
    first_ms: u64,
    sent_ms: u64,
}

/// D 送打字：編序號、切段、上限、等確認、補送
pub struct DOutbox {
    key: SessionKey,
    session_id: String,
    next: u64,
    unacked: VecDeque<Pending>,
    total: u64,
    rate: Rate,
}

impl DOutbox {
    /// key 是打字用的那把（[`input_key`]）
    pub fn new(key: SessionKey, session_id: &str) -> Self {
        DOutbox { key, session_id: session_id.to_string(), next: 0, unacked: VecDeque::new(), total: 0, rate: Rate::default() }
    }

    /// 排一段字：太長的切成幾幅（不從字中間切，順序不變）。回要馬上送的密文。
    /// **整段成功或整段不收：** 太快、太長、總量到上限都回錯，序號和等確認的佇列都不動（不會只送前半段，後面靜默丟掉）
    pub fn push(&mut self, data: &str, paste: bool, now_ms: u64) -> Result<Vec<String>, String> {
        let parts = crate::term_frame::split_chunks(data, MAX_DATA_BYTES);
        if parts.is_empty() {
            return Err("沒有要送的字".into());
        }
        if self.total + data.len() as u64 > MAX_TOTAL_BYTES {
            return Err(TOO_MUCH.into());
        }
        if parts.len() > MAX_PER_SEC as usize {
            return Err(TOO_LONG.into());
        }
        if !self.rate.room(now_ms, parts.len() as u32) {
            return Err(TOO_FAST.into());
        }
        // 先全部加密好，任何一幅失敗就整段不收；都好了才記帳
        let mut sealed = Vec::with_capacity(parts.len());
        for (i, part) in parts.iter().enumerate() {
            let seq = self.next + 1 + i as u64;
            sealed.push((seq, seal(&self.key, &self.session_id, seq, &Keys { d: part.to_string(), p: paste })?));
        }
        let taken = self.rate.take(now_ms, parts.len() as u32);
        debug_assert!(taken);
        self.next += parts.len() as u64;
        self.total += data.len() as u64;
        let mut out = Vec::with_capacity(sealed.len());
        for (seq, wire) in sealed {
            self.unacked.push_back(Pending { seq, wire: wire.clone(), first_ms: now_ms, sent_ms: now_ms });
            out.push(wire);
        }
        Ok(out)
    }

    /// 下一幅會用的序號（測試用）
    #[cfg(test)]
    fn next_seq(&self) -> u64 {
        self.next + 1
    }

    /// T 確認套用到第幾號：之前的都不用再補送
    pub fn ack(&mut self, applied: u64) {
        while self.unacked.front().is_some_and(|p| p.seq <= applied) {
            self.unacked.pop_front();
        }
    }

    /// 超過 [`RESEND_MS`] 沒被確認的，再送一次
    pub fn resend(&mut self, now_ms: u64) -> Vec<String> {
        let mut out = Vec::new();
        for p in self.unacked.iter_mut() {
            if now_ms.saturating_sub(p.sent_ms) >= RESEND_MS {
                p.sent_ms = now_ms;
                out.push(p.wire.clone());
            }
        }
        out
    }

    /// 最舊的一幅超過 [`GAP_END_MS`] 還沒被確認：網路不穩，要停下來告訴本人
    pub fn stalled(&self, now_ms: u64) -> bool {
        self.unacked.front().is_some_and(|p| now_ms.saturating_sub(p.first_ms) > GAP_END_MS)
    }

    /// 還沒被確認的幅數
    pub fn waiting(&self) -> usize {
        self.unacked.len()
    }
}

/// D 收到接受：驗 T 的簽章、導出金鑰，回收畫面的和送打字的
pub fn d_finish(t_pub: &str, eph: Eph, s: &Session, t_eph: &str, t_sig: &str, now_s: i64) -> Result<(DReceiver, DOutbox), String> {
    let key = view_handshake::d_finish(t_pub, eph, s, t_eph, t_sig, now_s)?;
    let ik = input_key(&key)?;
    Ok((DReceiver::new(key, &s.id), DOutbox::new(ik, &s.id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view_handshake::test_key;

    const NOW: u64 = 1_800_000_000_000;

    fn keys(d: &str) -> Keys {
        Keys { d: d.into(), p: false }
    }
    fn pair() -> (DOutbox, TInput) {
        (DOutbox::new(test_key(7), "s1"), TInput::new(test_key(7), "s1", NOW))
    }
    fn text(v: &[Keys]) -> String {
        v.iter().map(|k| k.d.as_str()).collect()
    }

    #[test]
    fn 加解密_綁_session_序號_方向_欄位只有兩個() {
        let k = test_key(1);
        let w = seal(&k, "s1", 3, &keys("ls\r")).unwrap();
        assert_eq!(open(&k, "s1", &w).unwrap(), (3, keys("ls\r")));
        assert!(open(&k, "s2", &w).is_err(), "別的 session");
        assert!(open(&test_key(2), "s1", &w).is_err(), "別的金鑰");
        // 看解開 base64 後的原始位元組，比對明文 JSON 的一段（7 個位元組）：
        // 原本看 base64 字串裡有沒有「ls」，隨機 nonce 讓它約 1% 剛好出現而誤判
        let raw_w = B64.decode(&w).unwrap();
        let plain: &[u8] = br#""d":"ls"#;
        assert!(!raw_w.windows(plain.len()).any(|x| x == plain), "密文裡看不到字");
        // 多一個欄位就不收：只送打字
        let mut buf = br#"{"d":"x","p":false,"cmd":"rm"}"#.to_vec();
        let nonce = [0u8; NONCE_LEN];
        aead_key(&k).unwrap().seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad("s1", 1)), &mut buf).unwrap();
        let mut raw = 1u64.to_be_bytes().to_vec();
        raw.extend_from_slice(&nonce);
        raw.extend_from_slice(&buf);
        assert!(open(&k, "s1", &B64.encode(raw)).is_err());
    }

    #[test]
    fn 依序交出_亂序先收著_重複的丟掉() {
        let (mut d, mut t) = pair();
        let w: Vec<String> = ["a", "b", "c"].iter().flat_map(|x| d.push(x, false, NOW).unwrap()).collect();
        t.push(&w[2], NOW);
        t.push(&w[0], NOW);
        assert_eq!(text(&t.take(NOW).unwrap()), "a", "缺 2 號，3 號先等著");
        t.push(&w[0], NOW);
        t.push(&w[1], NOW);
        assert_eq!(text(&t.take(NOW).unwrap()), "bc");
        assert_eq!(t.applied(), 3);
        t.push(&w[1], NOW);
        assert!(t.take(NOW).unwrap().is_empty(), "重放的不再交出");
    }

    #[test]
    fn 缺號超過五秒就結束_不跳過缺的字() {
        let (mut d, mut t) = pair();
        let w: Vec<String> = ["a", "b"].iter().flat_map(|x| d.push(x, false, NOW).unwrap()).collect();
        t.push(&w[1], NOW);
        assert!(t.take(NOW).unwrap().is_empty());
        assert!(t.take(NOW + GAP_END_MS).unwrap().is_empty(), "剛好五秒還等");
        assert_eq!(t.take(NOW + GAP_END_MS + 1), Err(InputEnd::Gap));
        t.push(&w[0], NOW + GAP_END_MS + 2);
        assert_eq!(t.take(NOW + GAP_END_MS + 2), Err(InputEnd::Gap), "結束了就是結束了，補到也不交出");
    }

    #[test]
    fn 兩分鐘沒打字就結束() {
        let (mut d, mut t) = pair();
        t.push(&d.push("a", false, NOW).unwrap()[0], NOW);
        assert_eq!(text(&t.take(NOW).unwrap()), "a");
        assert!(t.take(NOW + IDLE_END_MS).is_ok());
        assert_eq!(t.take(NOW + IDLE_END_MS + 1), Err(InputEnd::Idle));
        assert_eq!(InputEnd::Idle.end(), End::InputIdle);
    }

    #[test]
    fn 連續解不開就結束_太前面的丟掉等補送() {
        let (mut d, mut t) = pair();
        for _ in 0..BAD_END {
            t.push("不是密文", NOW);
        }
        assert_eq!(t.take(NOW), Err(InputEnd::Bad));
        let mut t = TInput::new(test_key(7), "s1", NOW);
        let far = seal(&test_key(7), "s1", MAX_AHEAD + 1, &keys("x")).unwrap();
        t.push(&far, NOW);
        assert!(t.take(NOW).unwrap().is_empty());
        assert!(t.take(NOW + GAP_END_MS + 1).is_ok(), "沒有收著就不算缺號");
        let _ = d.push("a", false, NOW);
    }

    #[test]
    fn 太快或總量超過都停_d_端回錯不收字() {
        let (mut d, _) = pair();
        for _ in 0..MAX_PER_SEC {
            d.push("a", false, NOW).unwrap();
        }
        assert_eq!(d.push("a", false, NOW).unwrap_err(), TOO_FAST);
        assert!(d.push("a", false, NOW + 1000).is_ok(), "下一秒就可以");
        let mut t = TInput::new(test_key(7), "s1", NOW);
        for i in 1..=u64::from(MAX_PER_SEC) + 1 {
            t.push(&seal(&test_key(7), "s1", i, &keys("a")).unwrap(), NOW);
        }
        assert_eq!(t.take(NOW), Err(InputEnd::TooMuch), "T 端也擋");
        let mut d = DOutbox::new(test_key(7), "s1");
        let big = "a".repeat(MAX_TOTAL_BYTES as usize + 1);
        assert_eq!(d.push(&big, true, NOW).unwrap_err(), TOO_MUCH);
    }

    #[test]
    fn 額度不夠整段拒絕_序號不前進_下一段從原序號開始() {
        let (mut d, mut t) = pair();
        for _ in 0..10 {
            d.push("a", false, NOW).unwrap();
        }
        let before = (d.next_seq(), d.waiting());
        let big = "a".repeat(MAX_DATA_BYTES * 45);
        assert_eq!(d.push(&big, true, NOW).unwrap_err(), TOO_FAST, "同一秒已用 10 幅，45 幅放不下：整段不收");
        assert_eq!((d.next_seq(), d.waiting()), before, "序號和等確認的佇列都沒動");
        let w = d.push("b", false, NOW + 1000).unwrap();
        assert_eq!(open(&test_key(7), "s1", &w[0]).unwrap().0, before.0, "下一段從原本的序號開始，T 不會以為缺號");
        let huge = "a".repeat(MAX_DATA_BYTES * 64);
        let before = (d.next_seq(), d.waiting());
        assert_eq!(d.push(&huge, true, NOW + 5000).unwrap_err(), TOO_LONG, "一次 64 幅：永遠放不下，叫本人分段");
        assert_eq!((d.next_seq(), d.waiting()), before);
        // T 收到的照樣連續，沒有半段
        for x in d.resend(NOW + 10_000) {
            t.push(&x, NOW);
        }
        assert_eq!(text(&t.take(NOW).unwrap()), "aaaaaaaaaab");
    }

    #[test]
    fn 額度剛好夠時整段送出() {
        let (mut d, _) = pair();
        for _ in 0..10 {
            d.push("a", false, NOW).unwrap();
        }
        let fit = "a".repeat(MAX_DATA_BYTES * 40);
        assert_eq!(d.push(&fit, true, NOW).unwrap().len(), 40, "10＋40＝50：剛好放得下");
        assert_eq!(d.push("x", false, NOW).unwrap_err(), TOO_FAST, "這一秒滿了");
        let mut d = DOutbox::new(test_key(7), "s1");
        assert_eq!(d.push(&"a".repeat(MAX_DATA_BYTES * MAX_PER_SEC as usize), true, NOW).unwrap().len(), MAX_PER_SEC as usize, "一次 50 幅也可以");
    }

    #[test]
    fn 總量到上限整段拒絕_不吃序號() {
        let mut d = DOutbox::new(test_key(7), "s1");
        let chunk = "a".repeat(MAX_DATA_BYTES * 50);
        let mut t = NOW;
        while d.push(&chunk, true, t).is_ok() {
            t += 1000;
        }
        let before = (d.next_seq(), d.waiting());
        assert_eq!(d.push(&chunk, true, t + 1000).unwrap_err(), TOO_MUCH);
        assert_eq!((d.next_seq(), d.waiting()), before, "總量放不下：整段不收");
        assert!(d.push("a", false, t + 2000).is_ok(), "還放得下的小段照樣能送");
    }

    #[test]
    fn 長的字切成幾幅_順序不變_每幅不超過上限() {
        let (mut d, mut t) = pair();
        let long: String = "字".repeat(MAX_DATA_BYTES);
        let w = d.push(&long, true, NOW).unwrap();
        assert!(w.len() > 1);
        for x in &w {
            t.push(x, NOW);
        }
        let got = t.take(NOW).unwrap();
        assert!(got.iter().all(|k| k.p && k.d.len() <= MAX_DATA_BYTES));
        assert_eq!(text(&got), long);
    }

    #[test]
    fn d_沒確認就補送_確認了就不送_太久沒確認就停() {
        let (mut d, mut t) = pair();
        let w = d.push("a", false, NOW).unwrap();
        assert!(d.resend(NOW + RESEND_MS - 1).is_empty());
        assert_eq!(d.resend(NOW + RESEND_MS), w, "一秒沒確認就補送");
        assert!(!d.stalled(NOW + GAP_END_MS));
        assert!(d.stalled(NOW + GAP_END_MS + 1));
        t.push(&w[0], NOW);
        let _ = t.take(NOW).unwrap();
        d.ack(t.applied());
        assert_eq!(d.waiting(), 0);
        assert!(d.resend(NOW + 10 * RESEND_MS).is_empty());
        assert!(!d.stalled(NOW + 10 * GAP_END_MS));
    }

    #[test]
    fn 只認_input_事件() {
        use serde_json::json;
        assert_eq!(wire_of("input", &json!({ "w": "x" })), Some("x".into()));
        assert_eq!(wire_of("frame", &json!({ "w": "x" })), None);
        assert_eq!(wire_of("input", &json!({ "x": "x" })), None);
    }

    #[test]
    fn 守門_被打字的那台每次把字交給窗格前都看本機還允不允許() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let f = lib.split("    fn input(&mut self, now_ms: u64) -> Result<Option<u64>, view_stream::End> {").nth(1).expect("有 LiveTPort::input").split("\n    }\n").next().unwrap();
        let check = f.find("bridge::read_settings(&self.data_dir).view_allowed(self.mobile)").expect("每次都重讀本機設定，不用快取");
        let apply = f.find("self.terms.view_input(").expect("有交給窗格");
        assert!(check < apply, "先查允不允許，再交字");
        assert!(f.contains("End::NotAllowed"), "關掉就結束");
    }

    #[test]
    fn 守門_這裡不碰窗格_不碰網路_不確認本人() {
        let src = include_str!("view_input.rs");
        let code = src.split("\nmod tests {").next().unwrap();
        for bad in ["send_text", "send_input", "terms.", "Outbound", "send_via", "relay", "presence::", "live::"] {
            assert!(!code.contains(bad), "反向通道的判斷不能有：{bad}");
        }
    }
}
