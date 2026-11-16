//! 手機觸發的「安裝並登入」在這台電腦上的把關（#628 第 4b 段，條件 E）。
//! 請求由後台轉來（presence 的回應帶 `setup_requested_by`＝送出請求的使用者代號）；後台只有「登入憑證的本人」建得了請求。
//! 這裡再做三道本機把關，缺一不可：
//!   1. 本機開關「允許從手機安裝並登入」要開著（預設關；設定檔是一般檔案，夥伴 AI 也寫得到，所以開關是第二道，不是唯一防線）
//!   2. 這台電腦的 ASN 要登入著帳號（登入網址要靠本人簽章才送得到手機）
//!   3. 這台登入的帳號要和送出請求的是同一個人（同一個人有多台電腦也只能裝自己的）
//! 把關過了才開始；過程中視窗要跳出看得見的通知（附「取消」），結果回報到手機。

/// JWT 的 `sub`（使用者代號）。只用來比對「我是誰」，不驗簽——權杖是這台自己登入拿到的，真正的驗證在後台：
/// 帶網址的密碼請求後台會再驗簽章者擁有請求端節點
pub fn jwt_sub(token: &str) -> Option<String> {
    use base64::Engine as _;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let sub = v.get("sub")?.as_str()?;
    is_uuid(sub).then(|| sub.to_ascii_lowercase())
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    Go,
    /// 拒絕，附固定句子（回報到手機）
    Refuse(&'static str),
}

pub const REFUSE_SWITCH_OFF: &str = "這台電腦沒有開啟「允許從手機安裝並登入」，沒有動作";
pub const REFUSE_NOT_SIGNED_IN: &str = "這台電腦的 ASN 沒有登入帳號，不能替你登入";
pub const REFUSE_OTHER_ACCOUNT: &str = "這台電腦登入的帳號和送出請求的不是同一個人，已拒絕";
pub const REFUSE_BAD_REQUEST: &str = "請求的格式不對，已拒絕";

/// 三道本機把關。`token` ＝這台電腦現在的本人簽章（視窗程式記憶體裡的），`requested_by` ＝後台說的送出者
pub fn gate(switch_on: bool, token: Option<&str>, requested_by: &str) -> Gate {
    if !switch_on {
        return Gate::Refuse(REFUSE_SWITCH_OFF);
    }
    gate_relogin(token, requested_by)
}

/// 重新登入的本機把關（#1592）：不受「允許從手機安裝並登入」開關限制，改用本人身分確認——
/// 這台登入著 ASN 帳號，而且和送出請求的是同一個人。要安裝或更新任何東西不走這裡（照舊看開關）
pub fn gate_relogin(token: Option<&str>, requested_by: &str) -> Gate {
    if !is_uuid(requested_by) {
        return Gate::Refuse(REFUSE_BAD_REQUEST);
    }
    let Some(me) = token.filter(|t| !t.is_empty()).and_then(jwt_sub) else {
        return Gate::Refuse(REFUSE_NOT_SIGNED_IN);
    };
    if me != requested_by.to_ascii_lowercase() {
        return Gate::Refuse(REFUSE_OTHER_ACCOUNT);
    }
    Gate::Go
}

/// 把關擋下的原因類別，只給 ui.log 用（固定詞，不帶任何帳號資料）
pub fn refuse_tag(why: &str) -> &'static str {
    match why {
        REFUSE_SWITCH_OFF => "安裝開關沒開",
        REFUSE_NOT_SIGNED_IN => "這台電腦沒有登入帳號",
        REFUSE_OTHER_ACCOUNT => "不是同一個帳號",
        REFUSE_BAD_REQUEST => "請求格式不對",
        _ => "其他",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    const U1: &str = "11111111-1111-1111-1111-111111111111";
    const U2: &str = "22222222-2222-2222-2222-222222222222";

    fn token(sub: &str) -> String {
        let e = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        format!("{}.{}.sig", e(r#"{"alg":"ES256"}"#), e(&format!(r#"{{"sub":"{sub}","role":"authenticated"}}"#)))
    }

    #[test]
    fn 讀出_jwt_的使用者代號() {
        assert_eq!(jwt_sub(&token(U1)).as_deref(), Some(U1));
        assert_eq!(jwt_sub(&token("ABCDEFAB-1111-1111-1111-111111111111")).as_deref(), Some("abcdefab-1111-1111-1111-111111111111"), "轉小寫");
        for bad in ["", "abc", "a.b.c", "a..c", &token("not-a-uuid"), "a.e30.c"] {
            assert_eq!(jwt_sub(bad), None, "{bad}");
        }
    }

    #[test]
    fn 三道把關_缺一不可() {
        let t1 = token(U1);
        assert_eq!(gate(true, Some(&t1), U1), Gate::Go);
        assert_eq!(gate(true, Some(&t1), &U1.to_ascii_uppercase()), Gate::Go, "大小寫不影響");
        // 1. 本機開關關著
        assert_eq!(gate(false, Some(&t1), U1), Gate::Refuse(REFUSE_SWITCH_OFF));
        // 2. 沒登入帳號
        assert_eq!(gate(true, None, U1), Gate::Refuse(REFUSE_NOT_SIGNED_IN));
        assert_eq!(gate(true, Some(""), U1), Gate::Refuse(REFUSE_NOT_SIGNED_IN));
        assert_eq!(gate(true, Some("亂寫的權杖"), U1), Gate::Refuse(REFUSE_NOT_SIGNED_IN));
        // 3. 登入的不是送出請求的那個人
        assert_eq!(gate(true, Some(&t1), U2), Gate::Refuse(REFUSE_OTHER_ACCOUNT));
        // 送出者格式不對
        assert_eq!(gate(true, Some(&t1), "evil"), Gate::Refuse(REFUSE_BAD_REQUEST));
        assert_eq!(gate(true, Some(&t1), ""), Gate::Refuse(REFUSE_BAD_REQUEST));
    }

    /// 接線守門：本機按鈕沒確認不開始；手機觸發一定先過把關才開始；`start_claude` 只有這兩處呼叫
    #[test]
    fn 守門_入口的接線() {
        let lib = include_str!("../lib.rs");
        let start = lib.find("async fn agent_setup_start(").unwrap();
        let body = &lib[start..];
        let (confirm, begin) = (body.find("if !confirmed").unwrap(), body.find("start_claude(").unwrap());
        assert!(confirm < begin, "要先檢查本人確認，才能開始");
        let remote = lib.find("async fn run_remote_setup(").unwrap();
        let rbody = &lib[remote..];
        let (g, begin) = (rbody.find("gate(").unwrap(), rbody.find("start_claude(").unwrap());
        assert!(g < begin, "手機觸發要先過本機把關，才能開始");
        assert_eq!(lib.matches("agent_setup::setup::start_claude(").count(), 2, "start_claude 只有桌面按鈕與手機觸發兩處");
        // 沒有任何路徑把手機請求的本機開關繞過去
        assert!(rbody.contains("agent_setup::switch::remote_allowed(&app.data_dir)"));
        // #1512 C：已登入時要不要重新登入只看本機證據。手機觸發的那一條給證據函式（不帶任何請求的內容），桌面按鈕給「沒有」
        // 呼叫的參數：從 start_claude( 到第一個回報用的 move 閉包為止
        let args = |s: &str| -> String {
            let a = &s[s.find("agent_setup::setup::start_claude(").unwrap()..];
            a[..a.find("move |e|").unwrap()].to_string()
        };
        assert!(args(rbody).contains("Arc::new(claude_relogin_evidence)"), "手機觸發：證據函式");
        assert!(args(body).contains("Arc::new(|| None)"), "桌面按鈕：照舊，已登入就不動");
        let lib_lf = lib.replace("\r\n", "\n");
        // 屬性要掛在 run_remote_setup 自己身上（#1563 調查員審查：新加的函式不能插在它的說明與屬性中間）
        assert!(lib_lf.contains("結果回報到手機\n#[cfg(feature = \"gui\")]\n#[cfg(desktop)]\nasync fn run_remote_setup("), "run_remote_setup 的說明與屬性緊貼著它");
        let ev = lib_lf.split("fn claude_relogin_evidence() -> Option<&'static str> {").nth(1).expect("有證據函式").split("\n}\n").next().unwrap();
        assert!(ev.contains("login_watch::failed_recently("), "只看本機對話紀錄的失效判定");
        assert!(!ev.contains("claude_screen") && !ev.contains("partner_notices"), "讀畫面只拿來顯示入口，不當放行的證據");
        assert!(ev.len() < 1200, "只取到證據函式本身");
        for bad in ["ask.", "SetupAsk", "relay.", "payload", "requested_by"] {
            assert!(!ev.contains(bad), "證據不能來自手機的請求：{bad}");
        }
    }

    #[test]
    fn 重新登入的把關_不看安裝開關_要是本人且同一個帳號() {
        let t1 = token(U1);
        assert_eq!(gate_relogin(Some(&t1), U1), Gate::Go);
        assert_eq!(gate_relogin(Some(&t1), &U1.to_ascii_uppercase()), Gate::Go, "大小寫不影響");
        assert_eq!(gate_relogin(None, U1), Gate::Refuse(REFUSE_NOT_SIGNED_IN));
        assert_eq!(gate_relogin(Some(""), U1), Gate::Refuse(REFUSE_NOT_SIGNED_IN));
        assert_eq!(gate_relogin(Some("亂寫的權杖"), U1), Gate::Refuse(REFUSE_NOT_SIGNED_IN));
        assert_eq!(gate_relogin(Some(&t1), U2), Gate::Refuse(REFUSE_OTHER_ACCOUNT));
        assert_eq!(gate_relogin(Some(&t1), "evil"), Gate::Refuse(REFUSE_BAD_REQUEST));
        assert_eq!(gate_relogin(Some(&t1), ""), Gate::Refuse(REFUSE_BAD_REQUEST));
        // 安裝那條仍然先看開關，開著時和重新登入的人身分檢查一致
        for (tok, by) in [(Some(t1.as_str()), U1), (Some(t1.as_str()), U2), (None, U1), (Some(t1.as_str()), "evil")] {
            assert_eq!(gate(true, tok, by), gate_relogin(tok, by));
        }
        assert_eq!(gate(false, Some(&t1), U1), Gate::Refuse(REFUSE_SWITCH_OFF));
        for s in [REFUSE_SWITCH_OFF, REFUSE_NOT_SIGNED_IN, REFUSE_OTHER_ACCOUNT, REFUSE_BAD_REQUEST] {
            assert_ne!(refuse_tag(s), "其他", "{s}");
            assert!(!refuse_tag(s).contains(U1) && !refuse_tag(s).contains('@'));
        }
    }

    /// 接線守門（#1592）：重新登入那條路不讀安裝開關、不呼叫安裝的入口，先過本人把關才開始；安裝那條路維持原樣
    #[test]
    fn 守門_重新登入不看安裝開關_也不呼叫安裝() {
        let lib = include_str!("../lib.rs").replace("\r\n", "\n");
        let start = lib.find("async fn run_remote_relogin(").unwrap();
        let body = &lib[start..start + lib[start..].find("\n}\n").unwrap()];
        assert!(!body.contains("remote_allowed") && !body.contains("gate("), "不看安裝開關");
        assert!(!body.contains("start_claude(") && !body.contains("install"), "不呼叫安裝");
        let (g, begin) = (body.find("gate_relogin(").unwrap(), body.find("start_claude_relogin(").unwrap());
        assert!(g < begin, "先過本人把關才開始");
        assert!(body.contains("ask.kind == \"claude\""), "重新登入只對 Claude");
        // 入口：模式是 relogin 才走這條；不認得的模式一律拒絕，不當成安裝
        let remote = lib.find("async fn run_remote_setup(").unwrap();
        let rbody = &lib[remote..remote + lib[remote..].find("\n}\n").unwrap()];
        assert!(rbody.contains("ask.mode == \"relogin\"") && rbody.contains("ask.mode != \"install\""));
        assert_eq!(lib.matches("run_remote_relogin(handle, relay, ask)").count(), 1, "只有手機請求的入口呼叫");
        // 紀錄只寫固定句型，不帶網址、授權碼、帳號
        for bad in ["ask.by", "requested_by", "token", "url", "code"] {
            let log_lines: Vec<&str> = body.lines().filter(|l| l.contains("remote_setup_log(")).collect();
            assert!(!log_lines.is_empty());
            assert!(log_lines.iter().all(|l| !l.contains(bad)), "ui.log 的行不能帶 {bad}");
        }
    }

    #[test]
    fn 開關關著時優先拒絕_不洩漏帳號資訊() {
        // 開關關著，連帳號比對都不做，回的句子也不帶任何帳號資料
        let t = token(U2);
        assert_eq!(gate(false, Some(&t), U1), Gate::Refuse(REFUSE_SWITCH_OFF));
        for s in [REFUSE_SWITCH_OFF, REFUSE_NOT_SIGNED_IN, REFUSE_OTHER_ACCOUNT, REFUSE_BAD_REQUEST] {
            assert!(!s.contains(U1) && !s.contains(U2) && !s.contains('@'), "{s}");
        }
    }
}
