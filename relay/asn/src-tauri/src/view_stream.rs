//! 別台看畫面的傳輸邏輯（#597 工作包 F）。只有判斷和加解密，網路和窗格都經 `TPort`，測試接假的。
//!
//! - **T 先確認視窗認得，再通知本人的其他設備，送不出去就不傳第一幅。** 通知由 T 送，D 上的程式沒有機會不送。
//! - **T 查不到就當停：** 控制面的列不見了、查詢連續失敗超過 90 秒、D 太久沒回報、超過本機算的到期時間。
//! - **沒有反向通道：** 這裡只有 T 到 D 的幀，AAD 綁方向。D 的暫停和結束只走控制面的固定狀態值。
//! - **紀錄不能有畫面：** 只記長度和次數，有守門測試。
#![cfg_attr(not(test), allow(dead_code))]
use crate::term_frame::filter_frame;
pub use crate::view_frame::{open_frame, seal_frame, DReceiver, Frame, Received, BAD_FRAMES_END, MAX_FRAME_BYTES};
use crate::view_handshake::{Session, SessionKey};

pub const FRAME_EVERY_MS: u64 = 2_000;
/// 畫面沒變也隔這麼久補送一次（最新那幅）：看的那台開始收之前送的幅會漏掉（頻道不留訊息），閒著的畫面不補送就一直是空的
pub const RESEND_SAME_MS: u64 = 5_000;
/// 打字時多久看一次窗格（毫秒）：打的字要快一點出現，確認也跟著畫面幀回去
pub const INPUT_FRAME_EVERY_MS: u64 = 300;
pub const CTL_EVERY_MS: u64 = 15_000;
/// 控制面或傳輸連續失敗多久就停
pub const LOST_AFTER_MS: u64 = 90_000;

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
    /// 本人在這台關掉了「允許其他設備替這台開新視窗」
    NotAllowed,
    /// 打字：太久沒有新的字
    InputIdle,
    /// 打字：缺字太久（網路不穩）、太快太多、一直解不開。不跳過缺的字
    InputStopped,
}

impl End {
    /// 後台 `term_view_stop` 的原因；不用回報的是 None
    pub fn reason(self) -> Option<&'static str> {
        match self {
            End::TargetEnded | End::NotAllowed | End::InputIdle => Some("target_ended"),
            End::ViewerGone => Some("viewer_gone"),
            End::Failed | End::InputStopped => Some("failed"),
            End::Expired | End::Gone => None,
        }
    }
}

/// T 這邊要的外部動作
pub trait TPort {
    /// 這個視窗認不認得（不讀畫面內容）。認不得就不通知，免得告訴本人有人在看一個看不到的東西
    fn window_ok(&mut self) -> bool;
    /// 通知本人的其他設備，固定文字。**成功才會傳第一幅**
    fn notify(&mut self) -> Result<(), String>;
    /// 顯示或收掉「正在被看」。開始傳之前就要顯示
    fn set_watching(&mut self, on: bool);
    fn frame(&mut self) -> Result<Frame, String>;
    fn ctl(&mut self) -> Result<Ctl, String>;
    fn send(&mut self, wire: &str) -> Result<(), String>;
    /// 本人按了結束
    fn stop_requested(&mut self) -> bool;
    /// 本機現在還允許別台看嗎（「允許其他設備替這台開新視窗」）。每次查控制面時一起查
    fn allowed(&mut self) -> bool;
    fn now_ms(&mut self) -> u64;
    fn sleep_ms(&mut self, ms: u64);
    /// 只記長度和次數
    fn log(&mut self, line: &str);
    /// 打字的工作階段：把收到、排好順序的字交給窗格，回已經交到第幾號（放進畫面幀給 D 確認）。
    /// 看畫面時沒有打字，回 None。出錯（缺字太久、窗格收不了）回結束原因
    fn input(&mut self, _now_ms: u64) -> Result<Option<u64>, End> {
        Ok(None)
    }
}

/// T 傳畫面，跑到該停為止。金鑰在這裡被消耗，回來就沒了。一定會收掉「正在被看」
pub fn run_t(s: &Session, key: SessionKey, port: &mut impl TPort) -> End {
    if !port.window_ok() {
        port.log(&format!("view {}: unknown window", s.id));
        return End::Failed;
    }
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
    let mut last_sent_at = started;
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
            if !port.allowed() {
                finish(&mut |l| port.log(l), "not_allowed", sent, bytes);
                return End::NotAllowed;
            }
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
        // 打字：控制面查到之後才收；收到的字依序交給窗格，確認跟著下一幅回去
        let ack = if ctl_seen {
            match port.input(now) {
                Ok(a) => a,
                Err(e) => {
                    finish(&mut |l| port.log(l), "input_ended", sent, bytes);
                    return e;
                }
            }
        } else {
            None
        };
        // 控制面還沒查到過就不傳；暫停時不讀窗格
        if ctl_seen && !paused {
            let frame = match port.frame() {
                Ok(f) => Frame { text: filter_frame(&f.text), ack, ..f },
                Err(_) => {
                    finish(&mut |l| port.log(l), "read_failed", sent, bytes);
                    return End::Failed;
                }
            };
            if last.as_ref() != Some(&frame) || now.saturating_sub(last_sent_at) >= RESEND_SAME_MS {
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
                            last_sent_at = now;
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
        port.sleep_ms(if s.scope == crate::view_handshake::Scope::Input { INPUT_FRAME_EVERY_MS } else { FRAME_EVERY_MS });
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

/// T 接受的一筆請求
pub struct Accepted {
    pub session: Session,
    pub t_eph: String,
    pub t_sig: String,
    pub key: SessionKey,
    /// D 的名字和設備公鑰（第一次看到就要記住）
    pub from_name: String,
    pub from_pub: String,
    /// 和本機記住的比：New＝第一次（呼叫端記住並通知本人）、Same＝照常
    pub tofu: crate::device_id::Tofu,
}

/// T 拒絕一筆請求的原因
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// D 的設備公鑰和本機記住的不同：呼叫端通知本人
    KeyChanged { node: String, sign_pub: String },
    Bad(String),
}

/// T 收到一筆請求：D 的公鑰先和本機記住的比（TOFU），對不上就拒絕；再用那把公鑰驗章，全部驗過才接受。
/// **這裡不寫檔：** 第一次看到的公鑰由呼叫端在驗章通過之後才記住
pub fn accept_request(row: &serde_json::Value, me_node: &str, known: &crate::device_id::KnownPeers, key: &crate::device_id::DeviceKey, now_s: i64) -> Result<Accepted, Refused> {
    let bad = || Refused::Bad("後台回的資料不對".into());
    let get = |k: &str| row.get(k).and_then(serde_json::Value::as_str).ok_or_else(bad);
    let s = Session {
        id: get("id")?.to_string(),
        d_node: get("from_node")?.to_string(),
        t_node: me_node.to_string(),
        window: get("window_name")?.to_string(),
        // 沒帶就是看畫面（0.2.8 的後台）；帶了不認得的一律不接受。範圍簽在握手裡，後台改不了
        scope: match row.get("scope") {
            None => crate::view_handshake::Scope::View,
            Some(v) => v.as_str().and_then(crate::view_handshake::Scope::parse).ok_or_else(bad)?,
        },
        expires_s: row.get("expires_s").and_then(serde_json::Value::as_i64).ok_or_else(bad)?,
    };
    let from_pub = get("from_pub")?.to_string();
    let tofu = known.check(&s.d_node, &from_pub);
    if tofu == crate::device_id::Tofu::Changed {
        return Err(Refused::KeyChanged { node: s.d_node.clone(), sign_pub: from_pub });
    }
    let (t_eph, t_sig, session_key) = crate::view_handshake::t_accept(&from_pub, key, &s, get("d_eph_pub")?, get("d_sig")?, now_s).map_err(Refused::Bad)?;
    let from_name = row.get("from_name").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    Ok(Accepted { session: s, t_eph, t_sig, key: session_key, from_name, from_pub, tofu })
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
        Session { id: "s1".into(), d_node: "d".into(), t_node: "t".into(), window: "小乙".into(), scope: crate::view_handshake::Scope::View, expires_s: (START_MS / 1000 + 600) as i64 }
    }
    fn frame(text: &str) -> Frame {
        Frame { text: text.to_string(), cursor_x: 1, cursor_y: 2, cols: 120, rows: 40, ack: None }
    }

    #[derive(Default)]
    struct Fake {
        calls: Vec<String>,
        notify_err: bool,
        unknown_window: bool,
        now: u64,
        frames: Vec<Result<Frame, String>>,
        ctl: Vec<Result<Ctl, String>>,
        sent: Vec<String>,
        send_err: bool,
        stop_at_ms: Option<u64>,
        /// 從這個時間起本機不再允許
        disallow_at_ms: Option<u64>,
        logs: Vec<String>,
        reads: u32,
    }

    fn fake() -> Fake {
        Fake { now: START_MS, ..Fake::default() }
    }

    impl TPort for Fake {
        fn window_ok(&mut self) -> bool {
            self.calls.push("window_ok".into());
            !self.unknown_window
        }
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
        fn allowed(&mut self) -> bool {
            !self.disallow_at_ms.is_some_and(|t| self.now >= t)
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
    fn 通知送不出去_不傳第一幅_也不讀窗格() {
        let (a, _) = pair();
        let mut f = Fake { notify_err: true, ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::Failed);
        assert_eq!(f.calls, vec!["window_ok", "notify"]);
        assert_eq!(f.reads, 0);
    }

    #[test]
    fn 視窗認不得_不通知_不顯示_不傳() {
        let (a, _) = pair();
        let mut f = Fake { unknown_window: true, ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::Failed);
        assert_eq!(f.calls, vec!["window_ok"], "本人不會收到有人在看的通知");
        assert_eq!(f.reads, 0);
    }

    #[test]
    fn 順序_先通知_再顯示正在被看_才傳第一幅_結束一定收掉() {
        let (a, _) = pair();
        let mut f = Fake { stop_at_ms: Some(START_MS + 1), ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::TargetEnded);
        assert_eq!(f.calls[0], "window_ok");
        assert_eq!(f.calls[1], "notify");
        assert_eq!(f.calls[2], "watching=true");
        assert_eq!(f.calls[3], "send");
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
    fn 守門_被看的那台每次查控制面都看本機還允不允許() {
        let lib = include_str!("lib.rs");
        let port = lib.split("impl view_stream::TPort for LiveTPort {").nth(1).expect("有 LiveTPort").split("\n}").next().unwrap();
        let allowed = port.split("fn allowed(").nth(1).expect("有 allowed").split("\n    }").next().unwrap();
        assert!(allowed.contains("bridge::read_settings(") && allowed.contains(".allow_remote_launch"), "每次都重讀設定，不用快取");
    }

    #[test]
    fn 本機關掉允許_進行中的觀看下一次查控制面就結束() {
        let (a, _) = pair();
        let mut f = Fake { disallow_at_ms: Some(START_MS + 1), ..fake() };
        assert_eq!(run_t(&session(), a, &mut f), End::NotAllowed);
        assert_eq!(End::NotAllowed.reason(), Some("target_ended"));
        let sent = f.sent.len();
        assert!(sent >= 1, "關掉之前照常傳");
        assert!(f.now - START_MS <= CTL_EVERY_MS + FRAME_EVERY_MS, "最晚下一次查控制面就停：{}", f.now - START_MS);
        assert!(f.calls.last().is_some_and(|c| c == "watching=false"), "收掉「正在被看」");
        let (b, _) = pair();
        let mut off = Fake { disallow_at_ms: Some(START_MS), ..fake() };
        assert_eq!(run_t(&session(), b, &mut off), End::NotAllowed);
        assert!(off.sent.is_empty(), "一開始就關著：一幅都不送");
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
    fn 畫面一直沒變_隔一陣子補送最新那幅_晚來的那台也看得到() {
        // 看的那台要等下一次回報才開始收，之前送的幅收不到；閒著的畫面不補送，那邊就一直是空的
        let (a, b) = pair();
        let mut f = Fake { stop_at_ms: Some(START_MS + 4 * RESEND_SAME_MS + 1), ..fake() };
        run_t(&session(), a, &mut f);
        let n = f.sent.len();
        assert!((4..=6).contains(&n), "第一幅加上每 {RESEND_SAME_MS} 毫秒補送一次：{n}");
        let mut r = DReceiver::new(b, "s1");
        // 晚來：前面幾幅都沒收到，只收最後一幅也畫得出來
        match r.receive(f.sent.last().unwrap()) {
            Received::Frame(_, got) => assert_eq!(got.text, SECRET),
            other => panic!("{other:?}"),
        }
        assert!(FRAME_EVERY_MS < RESEND_SAME_MS && RESEND_SAME_MS < CTL_EVERY_MS, "比看窗格慢、比回報快");
    }

    #[test]
    fn 補送不增加送的次數上限_暫停或結束就不送() {
        // 補送和換畫面共用同一個「每 FRAME_EVERY_MS 最多一幅」的位置：再怎麼補也不會超過原本的上限
        let (a, _) = pair();
        let span = 60_000;
        let mut f = Fake { stop_at_ms: Some(START_MS + span), ..fake() };
        run_t(&session(), a, &mut f);
        assert!(f.sent.len() as u64 <= span / FRAME_EVERY_MS + 1, "一直沒變：{} 幅", f.sent.len());
        assert!(f.sent.len() as u64 <= span / RESEND_SAME_MS + 2, "沒變的畫面只照補送的間隔送：{} 幅", f.sent.len());
        // 暫停：一幅都不補（也不讀窗格）
        let (b, _) = pair();
        let ctl = vec![Ok(Ctl::Active { paused: true, viewer_stale: false }); 10];
        let mut p = Fake { ctl, stop_at_ms: Some(START_MS + 4 * CTL_EVERY_MS), ..fake() };
        run_t(&session(), b, &mut p);
        assert!(p.sent.is_empty() && p.reads == 0, "暫停時不補送");
        // 結束（控制面沒有這筆）：馬上停，不補送
        let (c, _) = pair();
        let mut g = Fake { ctl: vec![Ok(Ctl::Active { paused: false, viewer_stale: false }), Ok(Ctl::Gone)], ..fake() };
        assert_eq!(run_t(&session(), c, &mut g), End::Gone);
        let max = (CTL_EVERY_MS / RESEND_SAME_MS + 1) as usize;
        assert!(g.sent.len() <= max, "結束之後不再送：{}", g.sent.len());
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
        let frame_src = include_str!("view_frame.rs");
        assert!(frame_src[..frame_src.find("mod tests").unwrap()].contains("|t2d|"));
        assert!(!code.contains("d2t"), "不留反向");
        assert!(!code.contains("send_text") && !code.contains("send_bytes") && !code.contains("view_input"), "這裡碰不到打字（本機看畫面的打字走 view_input，別台看畫面不能呼叫）");
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
    fn 請求_第一次看到要記住_一樣的照常_換了就拒絕_缺欄位回錯誤() {
        use crate::device_id::{KnownPeers, Tofu};
        use serde_json::json;
        let dir = |_: u8| tempfile::tempdir().unwrap();
        let (dd, td) = (dir(0), dir(1));
        let d = crate::device_id::load_or_create(dd.path(), &crate::auth::PlainFile).unwrap();
        let t = crate::device_id::load_or_create(td.path(), &crate::auth::PlainFile).unwrap();
        let now = 1_800_000_000i64;
        let s = Session { id: "s1".into(), d_node: "d".into(), t_node: "t".into(), window: "小乙".into(), scope: crate::view_handshake::Scope::View, expires_s: now + 60 };
        let (eph, sig) = crate::view_handshake::d_start(&d, &s, now).unwrap();
        let row = json!({ "id": "s1", "from_node": "d", "from_name": "工作機", "from_pub": d.public_b64(), "window_name": "小乙", "expires_s": now + 60, "d_eph_pub": eph.public_b64(), "d_sig": sig });
        let mut known = KnownPeers::default();
        let a = accept_request(&row, "t", &known, &t, now).unwrap();
        assert_eq!((a.tofu, a.from_name.as_str()), (Tofu::New, "工作機"), "第一次：呼叫端要記住");
        known.remember("d", "工作機", &d.public_b64(), 1).unwrap();
        assert_eq!(accept_request(&row, "t", &known, &t, now).unwrap().tofu, Tofu::Same);
        let mut other = KnownPeers::default();
        other.remember("d", "工作機", "別的公鑰", 1).unwrap();
        assert!(matches!(accept_request(&row, "t", &other, &t, now), Err(Refused::KeyChanged { .. })), "公鑰換了：拒絕");
        let mut forged = row.clone();
        forged["from_pub"] = json!(t.public_b64());
        assert!(matches!(accept_request(&forged, "t", &KnownPeers::default(), &t, now), Err(Refused::Bad(_))), "公鑰對不上簽章：拒絕");
        assert!(matches!(accept_request(&json!({ "id": "s1" }), "t", &known, &t, now), Err(Refused::Bad(_))));
    }

    #[test]
    fn 請求的範圍_沒帶是看畫面_打字要簽進去_不認得的不接受() {
        use crate::view_handshake::Scope;
        use serde_json::json;
        let (dd, td) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let d = crate::device_id::load_or_create(dd.path(), &crate::auth::PlainFile).unwrap();
        let t = crate::device_id::load_or_create(td.path(), &crate::auth::PlainFile).unwrap();
        let now = 1_800_000_000i64;
        let known = crate::device_id::KnownPeers::default();
        let s = Session { id: "s1".into(), d_node: "d".into(), t_node: "t".into(), window: "小乙".into(), scope: Scope::Input, expires_s: now + 60 };
        let (eph, sig) = crate::view_handshake::d_start(&d, &s, now).unwrap();
        let row = json!({ "id": "s1", "scope": "input", "from_node": "d", "from_name": "工作機", "from_pub": d.public_b64(), "window_name": "小乙", "expires_s": now + 60, "d_eph_pub": eph.public_b64(), "d_sig": sig });
        assert_eq!(accept_request(&row, "t", &known, &t, now).unwrap().session.scope, Scope::Input);
        let mut as_view = row.clone();
        as_view.as_object_mut().unwrap().remove("scope");
        assert!(matches!(accept_request(&as_view, "t", &known, &t, now), Err(Refused::Bad(_))), "打字的簽章不能當看畫面接受");
        let mut odd = row.clone();
        odd["scope"] = json!("admin");
        assert!(matches!(accept_request(&odd, "t", &known, &t, now), Err(Refused::Bad(_))));
    }

    #[test]
    fn 打字_收到的字依序交出_確認放進下一幅_出錯就結束() {
        struct Typing {
            inner: Fake,
            acks: Vec<Result<Option<u64>, End>>,
            sleeps: Vec<u64>,
        }
        impl TPort for Typing {
            fn window_ok(&mut self) -> bool {
                self.inner.window_ok()
            }
            fn notify(&mut self) -> Result<(), String> {
                self.inner.notify()
            }
            fn set_watching(&mut self, on: bool) {
                self.inner.set_watching(on)
            }
            fn frame(&mut self) -> Result<Frame, String> {
                self.inner.frame()
            }
            fn ctl(&mut self) -> Result<Ctl, String> {
                self.inner.ctl()
            }
            fn send(&mut self, wire: &str) -> Result<(), String> {
                self.inner.send(wire)
            }
            fn stop_requested(&mut self) -> bool {
                self.inner.stop_requested()
            }
            fn allowed(&mut self) -> bool {
                self.inner.allowed()
            }
            fn now_ms(&mut self) -> u64 {
                self.inner.now_ms()
            }
            fn sleep_ms(&mut self, ms: u64) {
                self.sleeps.push(ms);
                self.inner.sleep_ms(ms)
            }
            fn log(&mut self, line: &str) {
                self.inner.log(line)
            }
            fn input(&mut self, _now_ms: u64) -> Result<Option<u64>, End> {
                if self.acks.is_empty() {
                    Err(End::InputIdle)
                } else {
                    self.acks.remove(0)
                }
            }
        }
        let (tk, dk) = pair();
        let s = Session { scope: crate::view_handshake::Scope::Input, ..session() };
        let mut p = Typing { inner: fake(), acks: vec![Ok(Some(1)), Ok(Some(2)), Err(End::InputStopped)], sleeps: Vec::new() };
        assert_eq!(run_t(&s, tk, &mut p), End::InputStopped);
        let mut rx = DReceiver::new(dk, &s.id);
        let acks: Vec<Option<u64>> = p.inner.sent.iter().filter_map(|w| match rx.receive(w) {
            Received::Frame(_, f) => Some(f.ack),
            _ => None,
        }).collect();
        assert_eq!(acks.first().copied().flatten(), Some(1), "確認跟著畫面幀：{acks:?}");
        assert!(acks.contains(&Some(2)), "確認變了就算畫面沒變也要再送一幅：{acks:?}");
        assert!(p.sleeps.iter().all(|&ms| ms == INPUT_FRAME_EVERY_MS), "打字時看得比較勤");
        assert_eq!(End::InputStopped.reason(), Some("failed"));
        assert_eq!(End::InputIdle.reason(), Some("target_ended"));
    }

    #[test]
    fn 看畫面的幀沒有確認欄位_和以前一樣() {
        let f = frame("x");
        let j = serde_json::to_string(&f).unwrap();
        assert!(!j.contains("ack"), "{j}");
        let back: Frame = serde_json::from_str(r#"{"text":"x","cursor_x":1,"cursor_y":2,"cols":120,"rows":40}"#).unwrap();
        assert_eq!(back, f, "舊的幀照樣解得開");
    }

    #[test]
    fn 傳輸沒接上就送不出去() {
        assert!(NoTransport.send("x").is_err());
    }

    /// 從一段程式碼找出 get("鍵")／field("鍵")／s("鍵") 讀的鍵
    fn read_keys(code: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = code;
        while let Some(i) = rest.find("(\"") {
            let before = &rest[..i];
            let name: String = before.chars().rev().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect::<Vec<_>>().into_iter().rev().collect();
            let after = &rest[i + 2..];
            if let Some(j) = after.find('"') {
                let key = &after[..j];
                if ["get", "field", "s"].contains(&name.as_str()) && !key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                    out.push(key.to_string());
                }
            }
            rest = after;
        }
        out
    }

    /// 取一個函式的本體：頂層函式到 "\n}"，方法到 "\n    }"
    fn fn_body<'a>(src: &'a str, head: &str, method: bool) -> &'a str {
        let src_from = &src[src.find(head).unwrap_or_else(|| panic!("找不到 {head}"))..];
        let end = if method { "\n    }" } else { "\n}" };
        &src_from[..src_from.find(end).unwrap_or(src_from.len())]
    }

    #[test]
    fn 契約_電腦端讀的後台欄位都在共用清單裡() {
        let contract: serde_json::Value = serde_json::from_str(include_str!("../../../../supabase/functions/_shared/term_view_contract.json")).unwrap();
        let listed = |k: &str| -> Vec<String> { contract[k].as_array().unwrap_or_else(|| panic!("清單少了 {k}")).iter().map(|v| v.as_str().unwrap().to_string()).collect() };
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let me = include_str!("view_stream.rs").replace("\r\n", "\n");
        let remote = include_str!("view_remote.rs").replace("\r\n", "\n");
        let cases: [(&str, String); 6] = [
            ("term_view_start", fn_body(&lib, "async fn term_view_remote_start(", false).to_string()),
            ("term_view_report", fn_body(&remote, "pub fn step_of(", false).to_string()),
            ("term_view_pending.requests[]", fn_body(&me, "pub fn accept_request(", false).to_string()),
            ("term_view_pending.active[]", fn_body(&me, "pub fn ctl_from_active(", false).to_string()),
            ("term_view_notice", fn_body(&lib, "    fn notify(&mut self)", true).to_string()),
            ("term_view_pending", fn_body(&lib, "    fn ctl(&mut self)", true).to_string()),
        ];
        for (action, code) in cases {
            let keys = read_keys(&code);
            assert!(!keys.is_empty(), "{action}：找不到讀欄位的程式，守門失效");
            let ok = listed(action);
            for k in keys {
                assert!(ok.contains(&k), "{action} 讀了 {k}，但共用清單沒有（Edge 不一定會回）");
            }
        }
        // 被看的那台領請求時讀的
        let poll = fn_body(&lib, "fn start_view_poller(", false);
        let mut ok = listed("term_view_pending");
        ok.extend(listed("term_view_pending.requests[]"));
        for k in read_keys(poll) {
            assert!(ok.contains(&k), "start_view_poller 讀了 {k}，但共用清單沒有");
        }
    }
}
