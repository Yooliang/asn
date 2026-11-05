//! 別台看畫面的傳輸邏輯（#597 工作包 F）。只有判斷和加解密，網路和窗格都經 `TPort`，測試接假的。
//!
//! - **T 一定先通知本人的其他設備，送不出去就不傳第一幅。** 通知由 T 送，D 上的程式沒有機會不送。
//! - **T 查不到就當停：** 控制面的列不見了、查詢連續失敗超過 90 秒、D 太久沒回報、超過本機算的到期時間。
//! - **沒有反向通道：** 這裡只有 T 到 D 的幀，AAD 綁方向。D 的暫停和結束只走控制面的固定狀態值。
//! - **紀錄不能有畫面：** 只記長度和次數，有守門測試。
#![cfg_attr(not(test), allow(dead_code))]
use crate::launch::term_view::filter_frame;
use crate::view_handshake::{Session, SessionKey};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::aead;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

pub const FRAME_EVERY_MS: u64 = 2_000;
pub const CTL_EVERY_MS: u64 = 15_000;
/// 控制面或傳輸連續失敗多久就停
pub const LOST_AFTER_MS: u64 = 90_000;
/// D 連續解不開幾幅就結束
pub const BAD_FRAMES_END: u32 = 5;
/// 一幅明文上限。窗格只有一個畫面，正常遠低於這個數字
pub const MAX_FRAME_BYTES: usize = 128 * 1024;
const NONCE_LEN: usize = 12;
const SEQ_LEN: usize = 8;

/// 一幅的內容
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub text: String,
    pub cursor_x: i64,
    pub cursor_y: i64,
    pub cols: u32,
    pub rows: u32,
}

/// AAD：session id、方向、序號。方向只有 T→D
fn aad(session_id: &str, seq: u64) -> Vec<u8> {
    format!("asn-view-frame-v1|{session_id}|t2d|{seq}").into_bytes()
}

fn aead_key(key: &SessionKey) -> Result<aead::LessSafeKey, String> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key.raw()).map(aead::LessSafeKey::new).map_err(|_| "金鑰不對".to_string())
}

/// 加密一幅：`seq + nonce + 密文`，再 base64
pub fn seal_frame(key: &SessionKey, session_id: &str, seq: u64, plain: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "產生亂數失敗".to_string())?;
    let mut buf = plain.to_vec();
    aead_key(key)?
        .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad(session_id, seq)), &mut buf)
        .map_err(|_| "加密失敗".to_string())?;
    let mut out = Vec::with_capacity(SEQ_LEN + NONCE_LEN + buf.len());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(B64.encode(out))
}

/// 解開一幅。回（序號, 明文）。失敗只回籠統原因，不帶內容
pub fn open_frame(key: &SessionKey, session_id: &str, wire: &str) -> Result<(u64, Vec<u8>), String> {
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
    Ok((seq, plain.to_vec()))
}

/// 控制面查到的狀態
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ctl {
    Active { paused: bool, viewer_stale: bool },
    /// 這筆已經不在（結束了，或被新的取代）
    Gone,
}

/// T 為什麼停。對應後台的固定原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    /// 本人在這台按了結束
    TargetEnded,
    /// D 太久沒回報
    ViewerGone,
    /// 通知送不出去、讀不到窗格、連不上
    Failed,
    /// 到期
    Expired,
    /// 控制面已經沒有這筆，不用再回報
    Gone,
}

impl End {
    /// 後台 `term_view_stop` 的原因；不用回報的是 None
    pub fn reason(self) -> Option<&'static str> {
        match self {
            End::TargetEnded => Some("target_ended"),
            End::ViewerGone => Some("viewer_gone"),
            End::Failed => Some("failed"),
            End::Expired | End::Gone => None,
        }
    }
}

/// T 這邊要的外部動作
pub trait TPort {
    /// 通知本人的其他設備，固定文字。**成功才會傳第一幅**
    fn notify(&mut self) -> Result<(), String>;
    /// 顯示或收掉「正在被看」。開始傳之前就要顯示
    fn set_watching(&mut self, on: bool);
    fn frame(&mut self) -> Result<Frame, String>;
    fn ctl(&mut self) -> Result<Ctl, String>;
    fn send(&mut self, wire: &str) -> Result<(), String>;
    /// 本人按了結束
    fn stop_requested(&mut self) -> bool;
    fn now_ms(&mut self) -> u64;
    fn sleep_ms(&mut self, ms: u64);
    /// 只記長度和次數
    fn log(&mut self, line: &str);
}

/// T 傳畫面，跑到該停為止。金鑰在這裡被消耗，回來就沒了。一定會收掉「正在被看」
pub fn run_t(s: &Session, key: SessionKey, port: &mut impl TPort) -> End {
    if let Err(e) = port.notify() {
        port.log(&format!("view {}: notify failed: {}", s.id, e.chars().count()));
        return End::Failed;
    }
    port.set_watching(true);
    let end = pump(s, &key, port);
    port.set_watching(false);
    end
}

fn pump(s: &Session, key: &SessionKey, port: &mut impl TPort) -> End {
    let started = port.now_ms();
    let expires_ms = u64::try_from(s.expires_s).unwrap_or(0).saturating_mul(1000);
    let (mut last_ctl, mut ctl_ok_at, mut send_ok_at) = (None::<u64>, started, started);
    let (mut ctl_seen, mut paused) = (false, false);
    let (mut seq, mut sent, mut bytes) = (0u64, 0u64, 0u64);
    let mut last: Option<Frame> = None;
    let finish = |port: &mut dyn FnMut(&str), why: &str, sent: u64, bytes: u64| port(&format!("view {}: end {why} frames={sent} bytes={bytes}", s.id));
    loop {
        let now = port.now_ms();
        if port.stop_requested() {
            finish(&mut |l| port.log(l), "target_ended", sent, bytes);
            return End::TargetEnded;
        }
        if now >= expires_ms {
            finish(&mut |l| port.log(l), "expired", sent, bytes);
            return End::Expired;
        }
        if last_ctl.is_none_or(|t| now.saturating_sub(t) >= CTL_EVERY_MS) {
            last_ctl = Some(now);
            match port.ctl() {
                Ok(Ctl::Gone) => {
                    finish(&mut |l| port.log(l), "gone", sent, bytes);
                    return End::Gone;
                }
                Ok(Ctl::Active { viewer_stale: true, .. }) => {
                    finish(&mut |l| port.log(l), "viewer_gone", sent, bytes);
                    return End::ViewerGone;
                }
                Ok(Ctl::Active { paused: p, .. }) => {
                    paused = p;
                    ctl_seen = true;
                    ctl_ok_at = now;
                }
                Err(_) if now.saturating_sub(ctl_ok_at) > LOST_AFTER_MS => {
                    finish(&mut |l| port.log(l), "ctl_lost", sent, bytes);
                    return End::Failed;
                }
                Err(_) => {}
            }
        }
        // 控制面還沒查到過就不傳；暫停時不讀窗格
        if ctl_seen && !paused {
            let frame = match port.frame() {
                Ok(f) => Frame { text: filter_frame(&f.text), ..f },
                Err(_) => {
                    finish(&mut |l| port.log(l), "read_failed", sent, bytes);
                    return End::Failed;
                }
            };
            if last.as_ref() != Some(&frame) {
                let plain = serde_json::to_vec(&frame).unwrap_or_default();
                if plain.is_empty() || plain.len() > MAX_FRAME_BYTES {
                    port.log(&format!("view {}: frame skipped len={}", s.id, plain.len()));
                } else {
                    seq += 1;
                    let wire = match seal_frame(key, &s.id, seq, &plain) {
                        Ok(w) => w,
                        Err(_) => {
                            finish(&mut |l| port.log(l), "seal_failed", sent, bytes);
                            return End::Failed;
                        }
                    };
                    match port.send(&wire) {
                        Ok(()) => {
                            sent += 1;
                            bytes += wire.len() as u64;
                            send_ok_at = now;
                            last = Some(frame);
                        }
                        Err(_) if now.saturating_sub(send_ok_at) > LOST_AFTER_MS => {
                            finish(&mut |l| port.log(l), "send_lost", sent, bytes);
                            return End::Failed;
                        }
                        Err(_) => {}
                    }
                }
            } else {
                send_ok_at = now;
            }
        }
        port.sleep_ms(FRAME_EVERY_MS);
    }
}

/// D 收到一幅的結果
#[derive(Debug, PartialEq)]
pub enum Received {
    Frame(u64, Frame),
    /// 亂序、重放、壞的：丟掉
    Dropped,
    /// 連續解不開太多幅：結束這次觀看
    TooManyBad,
}

/// D 收幀：解密、擋重放、再過濾一次（對方的設備也不能完全信任）
pub struct DReceiver {
    key: SessionKey,
    session_id: String,
    last_seq: u64,
    bad: u32,
}

impl DReceiver {
    pub fn new(key: SessionKey, session_id: &str) -> Self {
        DReceiver { key, session_id: session_id.to_string(), last_seq: 0, bad: 0 }
    }

    pub fn receive(&mut self, wire: &str) -> Received {
        match open_frame(&self.key, &self.session_id, wire).and_then(|(seq, p)| serde_json::from_slice::<Frame>(&p).map(|f| (seq, f)).map_err(|_| "格式不對".to_string())) {
            Ok((seq, _)) if seq <= self.last_seq => Received::Dropped,
            Ok((seq, f)) => {
                self.bad = 0;
                self.last_seq = seq;
                Received::Frame(seq, Frame { text: filter_frame(&f.text), ..f })
            }
            Err(_) => {
                self.bad += 1;
                if self.bad >= BAD_FRAMES_END {
                    Received::TooManyBad
                } else {
                    Received::Dropped
                }
            }
        }
    }
}

/// 後台回的 `active` 清單 → 這一筆的狀態。不在清單裡就是不在了
pub fn ctl_from_active(active: &[serde_json::Value], id: &str) -> Ctl {
    match active.iter().find(|a| a.get("id").and_then(serde_json::Value::as_str) == Some(id)) {
        None => Ctl::Gone,
        Some(a) => Ctl::Active {
            paused: a.get("status").and_then(serde_json::Value::as_str) == Some("paused"),
            viewer_stale: a.get("viewer_stale").and_then(serde_json::Value::as_bool).unwrap_or(false),
        },
    }
}

/// T 收到一筆請求：全部驗過才接受。回（這次的資料, T 的一次性公鑰, T 的簽章, 金鑰）。缺欄位或驗不過回錯誤
pub fn accept_request(row: &serde_json::Value, me_node: &str, trust: &crate::device_id::Trust, verifier: &dyn crate::view_handshake::ViewVerifier, key: &crate::device_id::DeviceKey, now_s: i64) -> Result<(Session, String, String, SessionKey), String> {
    let get = |k: &str| row.get(k).and_then(serde_json::Value::as_str).ok_or("後台回的資料不對");
    let s = Session {
        id: get("id")?.to_string(),
        d_node: get("from_node")?.to_string(),
        t_node: me_node.to_string(),
        window: get("window_name")?.to_string(),
        expires_s: row.get("expires_s").and_then(serde_json::Value::as_i64).ok_or("後台回的資料不對")?,
    };
    let (t_eph, t_sig, session_key) = crate::view_handshake::t_accept(trust, verifier, key, &s, get("d_eph_pub")?, get("d_sig")?, now_s)?;
    Ok((s, t_eph, t_sig, session_key))
}

/// 傳輸還沒接上（要動 bell.rs，排在 0.2.4 之後）：送不出去，T 超過時限就會自己停
pub struct NoTransport;

impl NoTransport {
    pub fn send(&self, _wire: &str) -> Result<(), String> {
        Err("傳輸還沒接上".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view_handshake::test_key;

    const SECRET: &str = "SECRET-PASSWORD-123";
    const START_MS: u64 = 1_800_000_000_000;

    fn session() -> Session {
        Session { id: "s1".into(), d_node: "d".into(), t_node: "t".into(), window: "小乙".into(), expires_s: (START_MS / 1000 + 600) as i64 }
    }
    fn frame(text: &str) -> Frame {
        Frame { text: text.to_string(), cursor_x: 1, cursor_y: 2, cols: 120, rows: 40 }
    }

    #[derive(Default)]
    struct Fake {
        calls: Vec<String>,
        notify_err: bool,
        now: u64,
        frames: Vec<Result<Frame, String>>,
        ctl: Vec<Result<Ctl, String>>,
        sent: Vec<String>,
        send_err: bool,
        stop_at_ms: Option<u64>,
        logs: Vec<String>,
        reads: u32,
    }

    fn fake() -> Fake {
        Fake { now: START_MS, ..Fake::default() }
    }

    impl TPort for Fake {
        fn notify(&mut self) -> Result<(), String> {
            self.calls.push("notify".into());
            if self.notify_err {
                Err("送不出去".into())
            } else {
                Ok(())
            }
        }
        fn set_watching(&mut self, on: bool) {
            self.calls.push(format!("watching={on}"));
        }
        fn frame(&mut self) -> Result<Frame, String> {
            self.reads += 1;
            if self.frames.is_empty() {
                Ok(frame(SECRET))
            } else {
                self.frames.remove(0)
            }
        }
        fn ctl(&mut self) -> Result<Ctl, String> {
            if self.ctl.is_empty() {
                Ok(Ctl::Active { paused: false, viewer_stale: false })
            } else {
                self.ctl.remove(0)
            }
        }
        fn send(&mut self, wire: &str) -> Result<(), String> {
            self.calls.push("send".into());
            if self.send_err {
                return Err("斷線".into());
            }
            self.sent.push(wire.to_string());
            Ok(())
        }
        fn stop_requested(&mut self) -> bool {
            self.stop_at_ms.is_some_and(|t| self.now >= t)
        }
        fn now_ms(&mut self) -> u64 {
            self.now
        }
        fn sleep_ms(&mut self, ms: u64) {
            self.now += ms;
        }
        fn log(&mut self, line: &str) {
            self.logs.push(line.to_string());
        }
    }

    fn pair() -> (SessionKey, SessionKey) {
        (test_key(7), test_key(7))
    }

    #[test]
    fn 加解密_來回_內容綁_session_和序號() {
        let (a, b) = pair();
        let w = seal_frame(&a, "s1", 3, b"hello").unwrap();
        assert_eq!(open_frame(&b, "s1", &w).unwrap(), (3, b"hello".to_vec()));
        assert!(open_frame(&b, "s2", &w).is_err(), "別的 session");
        assert!(open_frame(&test_key(8), "s1", &w).is_err(), "別的金鑰");
        // 把序號改掉：AAD 對不上
        let mut raw = B64.decode(&w).unwrap();
        raw[7] ^= 1;
        assert!(open_frame(&b, "s1", &B64.encode(&raw)).is_err());
        assert!(open_frame(&b, "s1", "壞的").is_err());
        assert!(open_frame(&b, "s1", "AAAA").is_err());
    }

    #[test]
    fn 密文裡看不到明文() {
        let (a, _) = pair();
        let w = seal_frame(&a, "s1", 1, SECRET.as_bytes()).unwrap();
        let raw = B64.decode(&w).unwrap();
        assert!(!raw.windows(SECRET.len()).any(|x| x == SECRET.as_bytes()));
    }

    #[test]
    fn 通知送不出去_不傳第一幅_也不讀窗格() {
        let (a, _) = pair();
        let mut f = Fake { notify_err: true, ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::Failed);
        assert_eq!(f.calls, vec!["notify"]);
        assert_eq!(f.reads, 0);
    }

    #[test]
    fn 順序_先通知_再顯示正在被看_才傳第一幅_結束一定收掉() {
        let (a, _) = pair();
        let mut f = Fake { stop_at_ms: Some(START_MS + 1), ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::TargetEnded);
        assert_eq!(f.calls[0], "notify");
        assert_eq!(f.calls[1], "watching=true");
        assert_eq!(f.calls[2], "send");
        assert_eq!(f.calls.last().unwrap(), "watching=false");
    }

    #[test]
    fn 控制面還沒查到_不傳第一幅() {
        let (a, _) = pair();
        let mut f = Fake { ctl: vec![Err("斷線".into()); 20], ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::Failed, "超過 90 秒就停");
        assert_eq!(f.reads, 0);
        assert!(f.sent.is_empty());
        assert_eq!(f.calls.last().unwrap(), "watching=false");
    }

    #[test]
    fn 控制面連續失敗超過_90_秒就停() {
        let (a, _) = pair();
        let mut ctl = vec![Ok(Ctl::Active { paused: false, viewer_stale: false })];
        ctl.extend(vec![Err("斷線".to_string()); 30]);
        let mut f = Fake { ctl, ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::Failed);
        let used = f.now - START_MS;
        assert!(used > LOST_AFTER_MS && used <= LOST_AFTER_MS + CTL_EVERY_MS + FRAME_EVERY_MS, "{used}");
    }

    #[test]
    fn 這筆不見了_d_太久沒回報_都馬上停() {
        let (a, _) = pair();
        let mut f = Fake { ctl: vec![Ok(Ctl::Gone)], ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::Gone);
        assert!(f.sent.is_empty());
        let (a, _) = pair();
        let mut f = Fake { ctl: vec![Ok(Ctl::Active { paused: false, viewer_stale: true })], ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::ViewerGone);
        assert_eq!(End::ViewerGone.reason(), Some("viewer_gone"));
    }

    #[test]
    fn 到期用本機時鐘_不靠控制面() {
        let (a, _) = pair();
        let mut f = fake();
        assert_eq!(run_t(&session(), a, &mut f), End::Expired);
        assert!(f.now - START_MS >= 600_000);
    }

    #[test]
    fn 傳不出去超過_90_秒就停_不會對空氣送滿十分鐘() {
        let (a, _) = pair();
        let mut f = Fake { send_err: true, ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::Failed);
        assert!(f.now - START_MS <= LOST_AFTER_MS + 2 * FRAME_EVERY_MS);
    }

    #[test]
    fn 暫停時不讀窗格_恢復再傳() {
        let (a, _) = pair();
        let ctl = vec![Ok(Ctl::Active { paused: true, viewer_stale: false }), Ok(Ctl::Active { paused: false, viewer_stale: false })];
        let mut f = Fake { ctl, stop_at_ms: Some(START_MS + CTL_EVERY_MS + FRAME_EVERY_MS + 1), ..fake() };
        run_t(&session(), a, &mut f);
        assert_eq!(f.reads, 1, "暫停那段沒有讀");
    }

    #[test]
    fn 畫面沒變不送_過濾過才送_d_再解得開() {
        let (a, b) = pair();
        let frames = vec![Ok(frame("甲\x1b]52;c;x\x07")), Ok(frame("甲")), Ok(frame("乙"))];
        let mut f = Fake { frames, stop_at_ms: Some(START_MS + 3 * FRAME_EVERY_MS), ..fake() };
        run_t(&session(), a, &mut f);
        assert!(f.sent.len() >= 2);
        let mut r = DReceiver::new(b, "s1");
        match r.receive(&f.sent[0]) {
            Received::Frame(1, got) => assert_eq!(got.text, "甲"),
            other => panic!("{other:?}"),
        }
        match r.receive(&f.sent[1]) {
            Received::Frame(2, got) => assert_eq!(got.text, "乙", "相同的那幅沒有送"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 太大的一幅不送() {
        let (a, _) = pair();
        let frames = vec![Ok(frame(&"x".repeat(MAX_FRAME_BYTES + 1)))];
        let mut f = Fake { frames, stop_at_ms: Some(START_MS + 1), ..fake() };
        run_t(&session(), a, &mut f);
        assert_eq!(f.sent.len(), 0);
        assert!(f.logs.iter().any(|l| l.contains("skipped")));
    }

    #[test]
    fn d_擋重放和亂序_再過濾一次_連續壞太多就結束() {
        let (a, b) = pair();
        let mut r = DReceiver::new(b, "s1");
        let enc = |seq, text: &str| seal_frame(&a, "s1", seq, &serde_json::to_vec(&frame(text)).unwrap()).unwrap();
        let w2 = enc(2, "乙\x1b[6n");
        match r.receive(&w2) {
            Received::Frame(2, got) => assert_eq!(got.text, "乙", "收到也要再過濾"),
            other => panic!("{other:?}"),
        }
        assert_eq!(r.receive(&w2), Received::Dropped, "重放");
        assert_eq!(r.receive(&enc(1, "舊")), Received::Dropped, "亂序");
        for _ in 0..BAD_FRAMES_END - 1 {
            assert_eq!(r.receive("壞的"), Received::Dropped);
        }
        assert!(matches!(r.receive(&enc(3, "好")), Received::Frame(3, _)), "好的一幅會歸零");
        for _ in 0..BAD_FRAMES_END - 1 {
            assert_eq!(r.receive("壞的"), Received::Dropped);
        }
        assert_eq!(r.receive("壞的"), Received::TooManyBad);
    }

    #[test]
    fn 守門_紀錄不能有畫面() {
        let (a, _) = pair();
        let mut f = Fake { frames: vec![Err(SECRET.into())], ..fake() };
        run_t(&session(), a, &mut f);
        let (a2, _) = pair();
        let mut g = Fake { stop_at_ms: Some(START_MS + 3 * FRAME_EVERY_MS), ..fake() };
        run_t(&session(), a2, &mut g);
        let (a3, _) = pair();
        let mut h = Fake { notify_err: true, ..fake() };
        run_t(&session(), a3, &mut h);
        for l in f.logs.iter().chain(&g.logs).chain(&h.logs) {
            assert!(!l.contains(SECRET), "{l}");
            assert!(!l.contains("送不出去"), "錯誤內容也不記：{l}");
        }
        assert!(g.logs.iter().any(|l| l.contains("frames=") && l.contains("bytes=")));
        let src = include_str!("view_stream.rs");
        let code = &src[..src.find("mod tests").unwrap()];
        assert!(!code.contains("elog!") && !code.contains("println!") && !code.contains("eprintln!"), "紀錄只走 port.log");
    }

    #[test]
    fn 守門_沒有反向通道_傳輸只有一個方向() {
        let src = include_str!("view_stream.rs");
        let code = &src[..src.find("mod tests").unwrap()];
        assert!(code.contains("|t2d|"));
        assert!(!code.contains("d2t"), "不留反向");
        assert!(!code.contains("send_text") && !code.contains("send_bytes") && !code.contains("term_view_input"), "這裡碰不到打字");
    }

    #[test]
    fn 控制面清單_不在就是不在了_暫停和太久沒回報() {
        use serde_json::json;
        let a = vec![json!({ "id": "s1", "status": "paused", "viewer_stale": false }), json!({ "id": "s2", "status": "watching", "viewer_stale": true })];
        assert_eq!(ctl_from_active(&a, "s1"), Ctl::Active { paused: true, viewer_stale: false });
        assert_eq!(ctl_from_active(&a, "s2"), Ctl::Active { paused: false, viewer_stale: true });
        assert_eq!(ctl_from_active(&a, "s3"), Ctl::Gone);
        assert_eq!(ctl_from_active(&[], "s1"), Ctl::Gone);
    }

    #[test]
    fn 請求_hello_沒接上就不接受_缺欄位回錯誤() {
        use crate::view_handshake::HelloNotReady;
        use serde_json::json;
        let d = tempfile::tempdir().unwrap();
        let key = crate::device_id::load_or_create(d.path(), &crate::auth::PlainFile).unwrap();
        let mut trust = crate::device_id::Trust::default();
        trust.grant("d", "工作機", "pk", crate::device_id::Direction::PeerToMe, crate::device_id::SCOPE_VIEW).unwrap();
        trust.set_view_pub("d", "hello");
        let now = 1_800_000_000i64;
        let row = json!({ "id": "s1", "from_node": "d", "window_name": "小乙", "expires_s": now + 60, "d_eph_pub": "a".repeat(43), "d_sig": "b".repeat(342) });
        assert!(accept_request(&row, "t", &trust, &HelloNotReady, &key, now).is_err(), "正式版現在一律不接受");
        assert!(accept_request(&json!({ "id": "s1" }), "t", &trust, &HelloNotReady, &key, now).is_err());
    }

    #[test]
    fn 傳輸沒接上就送不出去() {
        assert!(NoTransport.send("x").is_err());
    }
}
