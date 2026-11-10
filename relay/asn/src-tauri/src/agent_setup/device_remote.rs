//! #933 PR-5b 電腦端：手機要求替這台登入裝置碼型 CLI（Codex、Grok）。
//! 跑 `login --device-auth`；讀到網址＋代碼時不顯示在這台（本人不在這台前面），改加密交給後台轉給發起的手機。
//! 請求的檢查與加密格式在 crate::device_relay（手機共用）。
use super::device_login::{Codex, DeviceCode, DeviceEngine, Outcome, Show};
use crate::device_id::DeviceKey;
use crate::device_relay::{seal, Request, Sealed};
use std::sync::{Arc, Mutex};

pub fn vendor_name(kind: &str) -> &'static str {
    match kind {
        "codex" => "Codex",
        "grok" => "Grok",
        _ => "CLI",
    }
}

/// 這台用哪個執行檔登入。Codex 用驗證過的安裝；Grok 等驗證過的安裝上線後才支援
pub fn engine_here(kind: &str) -> Result<Box<dyn DeviceEngine + Send>, String> {
    match kind {
        "codex" => super::codex_install::usable_here().map(|exe| Box::new(Codex { exe }) as Box<dyn DeviceEngine + Send>).ok_or_else(|| "這台電腦還沒有安裝 Codex，請先安裝".to_string()),
        "grok" => Err("這台電腦還不支援由手機替你登入 Grok".to_string()),
        _ => Err("不支援的登入種類".to_string()),
    }
}

/// 為什麼停：交不出去或手機那邊已經結束。有值就請登入程序停下
pub type StopWhy = Arc<Mutex<Option<&'static str>>>;

pub fn stop_with(why: &StopWhy, text: &'static str) {
    let mut g = why.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(text);
    }
}

fn stopped(why: &StopWhy) -> Option<&'static str> {
    *why.lock().unwrap_or_else(|e| e.into_inner())
}

pub const STOP_SEAL: &str = "加密登入資料失敗，這台停止登入";
pub const STOP_GONE: &str = "手機那邊的要求已經結束，這台停止登入";
pub const STOP_UNSENT: &str = "登入資料送不到手機，這台停止登入";

/// 讀到網址＋代碼：加密後交給送出的那一頭；加密失敗或交不出去就停止登入。
/// `code_exp`＝這次登入程序會被收掉的時間（代碼過了這時間一定用不了），加密時再壓到不晚於請求的到期
pub struct RemoteShow {
    pub req: Request,
    pub key: DeviceKey,
    pub code_exp: i64,
    pub tx: tokio::sync::mpsc::UnboundedSender<Sealed>,
    pub stop: StopWhy,
    pub cancelled: fn() -> bool,
}

impl Show for RemoteShow {
    fn show(&self, dc: &DeviceCode) {
        match seal(&self.req, dc.url(), dc.code(), self.code_exp, &self.key) {
            Ok(s) => {
                if self.tx.send(s).is_err() {
                    stop_with(&self.stop, STOP_UNSENT);
                }
            }
            Err(_) => stop_with(&self.stop, STOP_SEAL),
        }
    }
    fn cancelled(&self) -> bool {
        stopped(&self.stop).is_some() || (self.cancelled)()
    }
}

/// 處理過的請求編號存在這個檔（和看畫面的 view_seen.json 同一套：存檔、重開也擋得住、最多 64 筆未到期的）
pub const LOGIN_SEEN_FILE: &str = "login_seen.json";

/// 進度小窗的文字（固定句子，不帶網址或代碼）
pub fn step_json(s: super::device_login::Step) -> serde_json::Value {
    use super::device_login::Step;
    let text = match s {
        Step::WaitingCode => "正在取得登入代碼",
        Step::Shown => "登入代碼已加密送到你的手機，請在手機上完成登入",
        Step::Checking => "正在確認登入結果",
    };
    serde_json::json!({ "phase": "login", "text": text })
}

/// 結果回報給手機的（成功與否、固定句子）。不帶網址或代碼
pub fn report_of(o: &Outcome, kind: &str, stop: Option<&'static str>) -> (bool, String) {
    let n = vendor_name(kind);
    match o {
        Outcome::Verified => (true, format!("已替這台登入 {n}")),
        Outcome::Unconfirmed(t) => (true, t.clone()),
        Outcome::NeedTerminal(t) => (false, t.clone()),
        Outcome::TimedOut => (false, "登入逾時，代碼已經失效".to_string()),
        Outcome::Cancelled => (false, stop.unwrap_or("已在這台電腦上取消").to_string()),
        Outcome::Failed(t) => (false, t.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_id::{load_or_create, KnownPeers};
    use crate::device_relay::{new_request, verify_request};

    const NOW: i64 = 1_800_000_000;

    fn keys() -> (Vec<tempfile::TempDir>, DeviceKey, DeviceKey) {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let p = load_or_create(a.path(), &crate::auth::PlainFile).unwrap();
        let t = load_or_create(b.path(), &crate::auth::PlainFile).unwrap();
        (vec![a, b], p, t)
    }

    #[test]
    fn 讀到代碼_加密後交出去_不顯示_手機解得開() {
        let (_d, p, t) = keys();
        let (pending, payload, sig) = new_request(&p, "PC", "PH", "codex", NOW).unwrap();
        let mut known = KnownPeers::default();
        known.remember("PH", "手機", &p.public_b64(), 1).unwrap();
        known.set_login_ok("PH", true, Some(&p.public_b64()));
        let req = verify_request(&payload, &sig, "codex", "PC", "PH", None, &known, NOW).unwrap();
        let t_pub = t.public_b64();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let stop: StopWhy = Arc::default();
        let show = RemoteShow { req, key: t, code_exp: NOW + 300, tx, stop: stop.clone(), cancelled: || false };
        show.show(&DeviceCode::for_test("https://auth.openai.com/codex/device", "ABCD-EFGH1"));
        assert!(!show.cancelled());
        let s = rx.try_recv().unwrap();
        let c = pending.open(&t_pub, &s.t_eph_pub, &s.cipher, &s.t_sig, NOW + 1).unwrap();
        assert_eq!((c.url.as_str(), c.code.as_str(), c.code_exp), ("https://auth.openai.com/codex/device", "ABCD-EFGH1", NOW + 300));
    }

    #[test]
    fn 交不出去或手機已結束_就請登入程序停下_回報用停下的原因() {
        let (_d, p, t) = keys();
        let (pending, _, _) = new_request(&p, "PC", "PH", "codex", NOW).unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx);
        let stop: StopWhy = Arc::default();
        let show = RemoteShow { req: pending.req.clone(), key: t, code_exp: NOW + 300, tx, stop: stop.clone(), cancelled: || false };
        show.show(&DeviceCode::for_test("https://auth.openai.com/x", "ABCD-EFGH1"));
        assert!(show.cancelled());
        stop_with(&stop, STOP_GONE);
        assert_eq!(report_of(&Outcome::Cancelled, "codex", stopped(&stop)), (false, STOP_UNSENT.to_string()), "記第一個原因");
        assert_eq!(report_of(&Outcome::Cancelled, "codex", None), (false, "已在這台電腦上取消".to_string()));
        assert_eq!(report_of(&Outcome::Verified, "codex", None), (true, "已替這台登入 Codex".to_string()));
    }

    #[test]
    fn 這台本機按取消也會停() {
        let (_d, p, t) = keys();
        let (pending, _, _) = new_request(&p, "PC", "PH", "codex", NOW).unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let show = RemoteShow { req: pending.req.clone(), key: t, code_exp: NOW + 300, tx, stop: Arc::default(), cancelled: || true };
        assert!(show.cancelled());
    }

    #[test]
    fn 手機共用的主機清單_和電腦端的完全相同() {
        assert_eq!(crate::device_relay::CODEX_LOGIN_HOSTS, super::super::device_login::CODEX_HOSTS);
        assert_eq!(crate::device_relay::GROK_LOGIN_HOSTS, super::super::device_login::GROK_HOSTS);
    }

    /// 放回重試時的 404 不能誤殺正在授權的登入：只有第一次就 404 才停
    #[test]
    fn 守門_重試才遇到_404_當成已送達() {
        let lib = include_str!("../lib.rs");
        assert!(lib.contains("Err(relay::CodePutErr::Gone) if tries == 1 => {"));
        assert!(lib.contains("Err(relay::CodePutErr::Gone) => break,"));
    }

    #[test]
    fn grok_與不認得的種類_先不跑() {
        assert!(engine_here("grok").is_err());
        assert!(engine_here("claude").is_err());
    }

    /// 接線守門：手機觸發的裝置碼登入，一定先過本機把關、再檢查請求，才找執行檔、開始登入；開關沒有被繞過
    #[test]
    fn 守門_手機觸發的裝置碼登入_先把關再驗請求才開始() {
        let lib = include_str!("../lib.rs").replace("\r\n", "\n");
        let start = lib.find("async fn run_remote_device_login(").unwrap();
        let body = &lib[start..start + lib[start..].find("\n}\n").unwrap()];
        let at = |s: &str| body.find(s).unwrap_or_else(|| panic!("找不到 {s}"));
        assert!(body.contains("agent_setup::switch::remote_allowed(&app.data_dir)"));
        assert!(at("gate(") < at("verify_request(") && at("verify_request(") < at("engine_here(") && at("engine_here(") < at("run_device_login("));
        assert!(at("open_setup_progress(") < at("run_device_login("), "看得到進度、能取消才開始");
        // 同一筆只處理一次：驗章前查存檔的紀錄，驗過後先記下存檔才往下（存不進去就不開始）
        assert!(at("view_seen::check_unseen_in(") < at("verify_request(") && at("verify_request(") < at("view_seen::record_in(") && at("view_seen::record_in(") < at("engine_here("));
        // 驗章用本機記住的手機公鑰（known），後台給的公鑰只用來判斷有沒有變
        assert!(body.contains("device_id::live::known(&app.data_dir)"));
        // 呼叫這條路的只有 run_remote_setup（kind 不是 claude 時）
        assert_eq!(lib.matches("run_remote_device_login(handle, relay, ask)").count(), 1);
    }

    #[test]
    fn 進度文字不帶網址或代碼() {
        use super::super::device_login::Step;
        for s in [Step::WaitingCode, Step::Shown, Step::Checking] {
            let t = step_json(s).to_string();
            assert!(!t.contains("http") && !t.contains("-"), "{t}");
        }
    }

    #[test]
    fn 守門_這個檔不把網址或代碼寫進_log_或事件() {
        let src = include_str!("device_remote.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for bad in ["elog!", "emit(", "println!", "dc.url().to_string", "dc.code().to_string"] {
            assert!(!code.contains(bad), "{bad}");
        }
    }
}
