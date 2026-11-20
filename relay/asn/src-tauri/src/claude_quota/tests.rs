//! #1883 的守門測試：一律用暫存家目錄、假憑證（帶有特徵的假 token）、本機假伺服器；不碰真的 ~/.claude、不連外。
use super::*;
use std::sync::{Arc, Mutex as StdMutex};

// 2026-10-24T12:00:00Z
const NOW: i64 = 1_792_843_200_000;
const TOKEN: &str = "FAKE-ACCESS-SENTINEL-7f3a91";
const REFRESH: &str = "FAKE-REFRESH-SENTINEL-9c1d44";
const ERR_BODY: &str = "SECRET-ERROR-BODY-5e5e";

/// 會碰全域狀態（最近一次的讀取狀態）的測試排隊跑
static GUARD: StdMutex<()> = StdMutex::new(());

fn cred_json(expires_at: i64) -> String {
    json!({ "claudeAiOauth": { "accessToken": TOKEN, "refreshToken": REFRESH, "expiresAt": expires_at, "subscriptionType": "max" } }).to_string()
}

fn login(h: &Path, email: &str) {
    std::fs::write(h.join(".claude.json"), json!({ "oauthAccount": { "accountUuid": "u-1", "emailAddress": email } }).to_string()).unwrap();
}

fn home(email: &str, expires_at: i64) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".claude")).unwrap();
    std::fs::write(claude_accounts::cred_path(d.path()), cred_json(expires_at)).unwrap();
    login(d.path(), email);
    d
}

fn http(status: &str, body: &str) -> String {
    format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

struct Fake {
    net: HttpNet,
    hits: Arc<StdMutex<Vec<String>>>,
}

impl Fake {
    fn count(&self) -> usize {
        self.hits.lock().unwrap().len()
    }
    fn requests(&self) -> String {
        self.hits.lock().unwrap().join("\n---\n")
    }
}

/// 本機假伺服器：依路徑回 profile／usage 的假回應，記下收到的請求
fn serve(profile: String, usage: String) -> Fake {
    use std::io::{Read, Write};
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let hits = Arc::new(StdMutex::new(vec![]));
    let h2 = hits.clone();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { break };
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let reply = if req.contains("/profile") { profile.clone() } else { usage.clone() };
            h2.lock().unwrap().push(req);
            let _ = s.write_all(reply.as_bytes());
        }
    });
    Fake { net: HttpNet::at(&format!("{base}/api/oauth/profile"), &format!("{base}/api/oauth/usage")), hits }
}

fn profile_ok(email: &str) -> String {
    http("200 OK", &json!({ "account": { "uuid": "u-1", "email": email }, "organization": { "uuid": "o" } }).to_string())
}

fn usage_ok() -> String {
    http(
        "200 OK",
        &json!({
            "five_hour": { "utilization": 38.0, "resets_at": "2026-10-24T14:00:00.123456+00:00" },
            "seven_day": { "utilization": 20, "resets_at": "2026-10-30T00:00:00Z" },
            "seven_day_opus": { "utilization": 99 },
        })
        .to_string(),
    )
}

fn idle() -> bool {
    false
}

fn round(h: &Path, f: &Fake) -> Result<(State, Option<HttpFail>), Skip> {
    read_round(h, NOW, &f.net, &idle)
}

// ---------- 三步之一：查 ----------
#[test]
fn 查到額度_已用換成剩餘_權杖只在標頭_不送_refresh_token() {
    let h = home("A@x.test", NOW + 3_600_000);
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let (st, fail) = round(h.path(), &f).unwrap();
    assert_eq!(fail, None);
    assert_eq!((st.status, st.email.as_deref(), st.read_at.as_deref()), (Status::Ok, Some("a@x.test"), Some("2026-10-24T12:00:00Z")));
    assert_eq!(
        st.windows,
        vec![
            json!({ "name": "five_hour", "left_pct": 62, "resets_at": "2026-10-24T14:00:00Z", "read_at": "2026-10-24T12:00:00Z" }),
            json!({ "name": "weekly", "left_pct": 80, "resets_at": "2026-10-30T00:00:00Z", "read_at": "2026-10-24T12:00:00Z" }),
        ],
        "回的是「已用」，剩餘＝100−已用"
    );
    assert_eq!(f.count(), 2, "只查帳號與用量各一次");
    let reqs = f.requests().to_lowercase();
    assert!(reqs.contains(&format!("authorization: bearer {}", TOKEN.to_lowercase())));
    assert!(reqs.contains("anthropic-beta: oauth-2025-04-20"));
    assert!(!reqs.contains(&REFRESH.to_lowercase()), "refresh token 不送出去");
    assert!(!reqs.contains("post "), "只有 GET，沒有換新權杖的請求");
}

#[test]
fn 狀態判定表_本地過期_401_429_5xx_逾時_回應看不懂() {
    // 本地看 expiresAt 已過期：不連網
    let h = home("a@x.test", NOW - 1);
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let (st, fail) = round(h.path(), &f).unwrap();
    assert_eq!((st.status, fail), (Status::LoginExpired, Some(HttpFail::Unauthorized)));
    assert_eq!(f.count(), 0, "過期了就不打");
    let cases = [
        (http("401 Unauthorized", ERR_BODY), usage_ok(), Status::LoginExpired),
        (http("429 Too Many Requests", ERR_BODY), usage_ok(), Status::RateLimited),
        (http("503 Unavailable", ERR_BODY), usage_ok(), Status::Unavailable),
        (profile_ok("a@x.test"), http("401 Unauthorized", ""), Status::LoginExpired),
        (profile_ok("a@x.test"), http("429 Too Many Requests", ""), Status::RateLimited),
        (profile_ok("a@x.test"), http("500 Oops", ERR_BODY), Status::Unavailable),
        (profile_ok("a@x.test"), http("200 OK", "{}"), Status::Unavailable),
        (profile_ok("a@x.test"), http("200 OK", r#"{"five_hour":{"utilization":130}}"#), Status::Unavailable),
        (profile_ok("a@x.test"), http("200 OK", "不是 json"), Status::Unavailable),
        (profile_ok("a@x.test"), http("302 Found", ""), Status::Unavailable),
        (http("200 OK", "{}"), usage_ok(), Status::Unavailable),
    ];
    for (i, (p, u, want)) in cases.into_iter().enumerate() {
        let h = home("a@x.test", NOW + 3_600_000);
        let f = serve(p, u);
        let (st, fail) = round(h.path(), &f).unwrap();
        assert_eq!(st.status, want, "案例 {i}");
        assert!(fail.is_some() && st.windows.is_empty() && st.read_at.is_none(), "失敗不帶舊數字、不補 0（案例 {i}）");
    }
}

#[test]
fn 沒有憑證檔或沒有權杖_是登入過期_沒有登入帳號_就沒有狀態() {
    let h = home("a@x.test", NOW + 3_600_000);
    std::fs::remove_file(claude_accounts::cred_path(h.path())).unwrap();
    let f = serve(profile_ok("a@x.test"), usage_ok());
    assert_eq!(round(h.path(), &f).unwrap().0.status, Status::LoginExpired);
    std::fs::write(claude_accounts::cred_path(h.path()), r#"{"claudeAiOauth":{"expiresAt":9999999999999}}"#).unwrap();
    assert_eq!(round(h.path(), &f).unwrap().0.status, Status::LoginExpired);
    let none = tempfile::tempdir().unwrap();
    let (st, fail) = round(none.path(), &f).unwrap();
    assert_eq!((st.status, st.email, fail), (Status::None, None, None));
    assert_eq!(f.count(), 0);
}

#[test]
fn 憑證查出來的帳號跟登入檔對不上_這一輪不查用量_不記到任何帳號() {
    let h = home("a@x.test", NOW + 3_600_000);
    let f = serve(profile_ok("b@x.test"), usage_ok());
    assert_eq!(round(h.path(), &f).unwrap_err(), Skip::Mismatch);
    assert_eq!(f.count(), 1, "只查了帳號，沒查用量");
}

#[test]
fn 正在切換_這一輪完全不查() {
    let h = home("a@x.test", NOW + 3_600_000);
    let f = serve(profile_ok("a@x.test"), usage_ok());
    assert_eq!(read_round(h.path(), NOW, &f.net, &|| true).unwrap_err(), Skip::Switching);
    assert_eq!(f.count(), 0);
}

#[test]
fn 查的過程中切換進行到一半_這輪的數字不記() {
    // 第一次問 busy 是 false、查完再問變 true：模擬查到一半開始切換
    let h = home("a@x.test", NOW + 3_600_000);
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let calls = std::cell::Cell::new(0);
    let busy = || {
        calls.set(calls.get() + 1);
        calls.get() >= 2
    };
    assert_eq!(read_round(h.path(), NOW, &f.net, &busy).unwrap_err(), Skip::Changed);
    // 查完發現登入的帳號換了、或憑證換了，一樣不記
    struct Swap<'a>(&'a Path, HttpNet);
    impl Net for Swap<'_> {
        fn profile(&self, c: &[u8]) -> Result<Value, HttpFail> {
            self.1.profile(c)
        }
        fn usage(&self, c: &[u8]) -> Result<Value, HttpFail> {
            let r = self.1.usage(c);
            login(self.0, "b@x.test");
            r
        }
    }
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let swap = Swap(h.path(), f.net);
    assert_eq!(read_round(h.path(), NOW, &swap, &idle).unwrap_err(), Skip::Changed, "查的當中 .claude.json 換成別的帳號");
    let h2 = home("a@x.test", NOW + 3_600_000);
    let f2 = serve(profile_ok("a@x.test"), usage_ok());
    struct NewToken<'a>(&'a Path, HttpNet);
    impl Net for NewToken<'_> {
        fn profile(&self, c: &[u8]) -> Result<Value, HttpFail> {
            self.1.profile(c)
        }
        fn usage(&self, c: &[u8]) -> Result<Value, HttpFail> {
            let r = self.1.usage(c);
            std::fs::write(claude_accounts::cred_path(self.0), cred_json(NOW + 9).replace(TOKEN, "FAKE-NEWER-TOKEN")).unwrap();
            r
        }
    }
    assert_eq!(read_round(h2.path(), NOW, &NewToken(h2.path(), f2.net), &idle).unwrap_err(), Skip::Changed, "查的當中憑證被換掉");
}

// ---------- 排程：10 分鐘、切換後立刻、失敗退避不加速 ----------
fn lines() -> (Arc<StdMutex<Vec<String>>>, impl Fn(String) + Sync) {
    let v = Arc::new(StdMutex::new(vec![]));
    let w = v.clone();
    (v, move |s: String| w.lock().unwrap().push(s))
}

#[test]
fn 排程_成功後十分鐘才再查_切換叫一聲就立刻查() {
    let _g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("a@x.test", NOW + 86_400_000);
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let (_, log) = lines();
    let mut lp = Loop::default();
    assert!(lp.tick_at(0, h.path(), NOW, &f.net, &idle, &log));
    assert_eq!(state_view(h.path())["status"], "ok");
    assert!(!lp.tick_at(0, h.path(), NOW + 9 * 60_000, &f.net, &idle, &log), "9 分鐘不查");
    assert!(lp.tick_at(0, h.path(), NOW + 10 * 60_000, &f.net, &idle, &log), "10 分鐘查");
    assert!(lp.tick_at(1, h.path(), NOW + 10 * 60_000 + 1, &f.net, &idle, &log), "切換叫過：立刻查");
    assert_eq!(f.count(), 6);
}

#[test]
fn 排程_429_退避加倍_不加速_登入過期要等憑證檔變了才再查() {
    let _g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("a@x.test", NOW + 86_400_000);
    let f = serve(http("429 Too Many Requests", ERR_BODY), usage_ok());
    let (l, log) = lines();
    let mut lp = Loop::default();
    assert!(lp.tick_at(0, h.path(), NOW, &f.net, &idle, &log));
    assert_eq!(state_view(h.path())["status"], "rate_limited");
    assert!(!lp.tick_at(0, h.path(), NOW + 9 * 60_000, &f.net, &idle, &log));
    assert!(lp.tick_at(0, h.path(), NOW + 10 * 60_000, &f.net, &idle, &log));
    assert!(!lp.tick_at(0, h.path(), NOW + 29 * 60_000, &f.net, &idle, &log), "第二次失敗後退避 20 分鐘，不會更頻繁");
    assert!(lp.tick_at(0, h.path(), NOW + 30 * 60_000, &f.net, &idle, &log));
    assert_eq!(l.lock().unwrap().len(), 1, "同一種失敗只記一次 log");
    // 登入過期：憑證檔沒變就一直不再查
    let h2 = home("a@x.test", NOW - 1);
    let mut lp = Loop::default();
    assert!(lp.tick_at(0, h2.path(), NOW, &f.net, &idle, &log));
    assert_eq!(state_view(h2.path())["status"], "login_expired");
    assert!(!lp.tick_at(0, h2.path(), NOW + 3_600_000, &f.net, &idle, &log), "憑證檔沒變，不重打");
    std::fs::write(claude_accounts::cred_path(h2.path()), cred_json(NOW + 86_400_000) + " ").unwrap();
    let f2 = serve(profile_ok("a@x.test"), usage_ok());
    // 檔案修改時間要真的不同：直接把記號改成不同值
    lp.gate = Gate::default();
    assert!(lp.tick_at(0, h2.path(), NOW + 3_600_001, &f2.net, &idle, &log), "Claude 自己換新後憑證檔變了就再查");
    assert_eq!(state_view(h2.path())["status"], "ok");
}

#[test]
fn 畫面狀態只認現在登入的帳號_回報只送剛讀到的那一個() {
    let _g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("a@x.test", NOW + 86_400_000);
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let (_, log) = lines();
    let mut lp = Loop::default();
    lp.tick_at(0, h.path(), NOW, &f.net, &idle, &log);
    let w = report_windows(h.path(), NOW + 60_000);
    assert_eq!(w.keys().collect::<Vec<_>>(), vec!["a@x.test"]);
    assert_eq!(w["a@x.test"].len(), 2);
    assert!(report_windows(h.path(), NOW + KEEP_MS + 1).is_empty(), "放太久不送");
    assert!(report_windows(h.path(), NOW - 10 * 60_000).is_empty(), "時鐘被往前撥過也不送");
    login(h.path(), "b@x.test"); // 換帳號：還沒查之前，不能把 a 的數字當 b 的
    assert!(report_windows(h.path(), NOW + 60_000).is_empty());
    assert_eq!(state_view(h.path()), json!({ "email": "b@x.test", "status": "none", "read_at": null, "windows": [] }));
}

// ---------- 憑證與回應原文不外洩（延伸 acct_remote 的欄位黑名單測試） ----------
#[test]
fn 假權杖跑完整條路_log_畫面狀態_回報內容都不含權杖_標頭_回應原文() {
    let _g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (l, log) = lines();
    let mut seen = String::new();
    for (p, u) in [(profile_ok("a@x.test"), usage_ok()), (http("500 Oops", ERR_BODY), usage_ok()), (http("429 X", ERR_BODY), usage_ok()), (profile_ok("a@x.test"), http("401 U", ERR_BODY)), (profile_ok("b@x.test"), usage_ok())] {
        let h = home("a@x.test", NOW + 86_400_000);
        let f = serve(p, u);
        let mut lp = Loop::default();
        lp.tick_at(0, h.path(), NOW, &f.net, &idle, &log);
        seen += &state_view(h.path()).to_string();
        seen += &serde_json::to_string(&report_windows(h.path(), NOW)).unwrap();
        let report = crate::acct_remote::build_report_with_quota(&[crate::claude_accounts::AccountInfo { email: "a@x.test".into(), ..Default::default() }], None, &report_windows(h.path(), NOW));
        seen += &report.to_string();
    }
    seen += &l.lock().unwrap().join("\n");
    let low = seen.to_lowercase();
    for bad in [TOKEN, REFRESH, ERR_BODY, "authorization", "bearer", "anthropic-beta", "refreshtoken", "accesstoken"] {
        assert!(!low.contains(&bad.to_lowercase()), "log／畫面狀態／回報不得含：{bad}");
    }
    assert!(!l.lock().unwrap().is_empty(), "失敗有留 log（只有固定文字）");
}

// ---------- 靜態斷言：沒有任何 refresh 的路徑 ----------
fn prod(src: &str) -> String {
    let s = src.replace("\r\n", "\n");
    s[..s.find("#[cfg(test)]\nmod tests").unwrap()].to_string()
}

#[test]
fn 程式裡沒有_refresh_的呼叫_只用現成的_access_token() {
    let mine = prod(include_str!("../claude_quota.rs"));
    // 權杖換新相關的字一個都不能出現在查額度的程式（只有說明文字裡的「refresh」二字例外：逐行排除註解）
    let code: String = mine.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    for bad in ["refresh", "grant_type", "oauth/token", "TOKEN_URL", "CLIENT_ID", ".post(", "refreshToken", "refresh_token"] {
        assert!(!code.to_lowercase().contains(&bad.to_lowercase()), "claude_quota.rs 不能有換新的路徑：{bad}");
    }
    // 共用的查詢程式（fetch_json）也只有 GET
    let acc = prod(include_str!("../claude_accounts.rs"));
    let def = &acc[acc.find("pub(crate) fn fetch_json(").unwrap()..acc.find("fn fetch_profile(").unwrap()];
    assert!(def.contains(".get(&url)") && !def.contains(".post(") && !def.to_lowercase().contains("refresh"), "fetch_json 只有 GET");
    // 網址寫死、只走 HTTPS、只連 Anthropic 自己的網域
    assert!(claude_accounts::PROFILE_URL.starts_with("https://api.anthropic.com/"));
    assert!(USAGE_URL.starts_with("https://api.anthropic.com/"));
    assert!(!mine.contains("env::var") && !mine.contains("envc::"), "網址不能從環境變數改");
    // 查額度只能走共用的 fetch_json，不另寫一份連線程式
    assert!(!mine.contains("reqwest"), "不另寫一份連線程式");
}

#[test]
fn 不再讀舊的本機額度檔與狀態列資料() {
    let mine = prod(include_str!("../claude_quota.rs"));
    for gone in ["claude-quota.json", "claude-owner-cache", "transcript", "session-owner", "rate_limits", "statusLine"] {
        let code: String = mine.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        assert!(!code.contains(gone), "{gone}");
    }
}

// ---------- 端到端（#1883）：假憑證＋假查詢回應 → 送後台的回報 → （後台 SQL）→ 兩個頁面 ----------
// 這一段產生「送後台的回報」並與黃金檔逐字比對；後台那段（tests/claude_quota_e2e_sql.test.mjs）與畫面那段
// （relay/asn/test/claude-quota-e2e.test.mjs）讀同一份黃金檔。任何一段改了格式或行為，另一邊的測試就會紅。
#[test]
fn e2e_1_假憑證加假查詢回應_產生送後台的回報_跟黃金檔一致() {
    let _g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("a@x.test", NOW + 3_600_000);
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let (l, log) = lines();
    let mut lp = Loop::default();
    assert!(lp.tick_at(0, h.path(), NOW, &f.net, &idle, &log));
    let acct = crate::claude_accounts::AccountInfo { email: "a@x.test".into(), plan: "max".into(), current: true, saved: true, ..Default::default() };
    let report = crate::acct_remote::build_report_with_quota(&[acct], None, &report_windows(h.path(), NOW));
    let golden: Value = serde_json::from_str(include_str!("../../../../../tests/fixtures/claude-quota-report.golden.json")).unwrap();
    assert_eq!(report, golden, "送後台的回報跟黃金檔不一致：{report}");
    assert!(l.lock().unwrap().is_empty(), "成功時不寫 log");
}

// ---------- 除錯命令 asn-cli claude-usage --shape：只印欄位結構，任何值都不印 ----------
const FAKE_SECRETS: [&str; 6] = ["sk-ant-oat01-FAKEFAKEFAKEFAKE-9z9z", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", "someone.secret@x.test", "3f2b8a1c-9d4e-4c7a-8b1f-0a2b3c4d5e6f", "987654321", "FAKE-VALUE-IN-ARRAY"];

fn secret_body() -> Value {
    json!({
        "five_hour": { "utilization": 38.5, "resets_at": FAKE_SECRETS[4], "note": FAKE_SECRETS[0] },
        "account": { "email": FAKE_SECRETS[2], "uuid": FAKE_SECRETS[3], "blob": FAKE_SECRETS[1], "flag": true, "none": null },
        "list": [FAKE_SECRETS[5], 7, { "inner": FAKE_SECRETS[0] }, [FAKE_SECRETS[2]]],
        "n": 123456789
    })
}

#[test]
fn shape_遮罩_鍵名照印_任何值都不出現_像權杖與_email_與_uuid_與數字的都一樣() {
    let s = shape_of(&secret_body()).to_string();
    for bad in FAKE_SECRETS.iter().chain(["38.5", "123456789", "true"].iter()) {
        assert!(!s.contains(bad), "值不能出現：{bad}（{s}）");
    }
    for key in ["five_hour", "utilization", "resets_at", "account", "email", "uuid", "list", "inner", "flag", "none"] {
        assert!(s.contains(&format!("\"{key}\"")), "鍵名要照印：{key}");
    }
    assert_eq!(shape_of(&json!({ "a": [1, "x", null, true, { "b": 2 }] })), json!({ "a": ["number", "string", "null", "boolean", { "b": "number" }] }));
    assert_eq!(shape_of(&json!("sk-ant-x")), json!("string"));
    assert_eq!(shape_of(&json!((0..9).collect::<Vec<_>>())).as_array().unwrap().len(), 5, "陣列最多展開 5 項");
    // 同樣的字串出現在鍵名以外的任何位置（巢狀物件的值、陣列裡）都被遮掉，只有當鍵名時才照印
    let s2 = shape_of(&json!({ FAKE_SECRETS[5]: FAKE_SECRETS[5] })).to_string();
    assert_eq!(s2.matches(FAKE_SECRETS[5]).count(), 1, "只有鍵名那一次");
}

#[test]
fn shape_命令用假憑證加假伺服器_只印結構_失敗只印狀態碼_過期不連網() {
    let h = home("a@x.test", NOW + 3_600_000);
    let f = serve(profile_ok("a@x.test"), http("200 OK", &secret_body().to_string()));
    let out = shape_report(h.path(), NOW, &f.net);
    for bad in FAKE_SECRETS.iter().chain([TOKEN, REFRESH].iter()) {
        assert!(!out.contains(bad), "輸出不能含值：{bad}");
    }
    assert!(out.contains("\"five_hour\"") && out.contains("\"string\"") && out.contains("\"number\""), "{out}");
    assert_eq!(f.count(), 1, "只打額度端點一次");
    assert!(f.requests().to_lowercase().contains(&format!("authorization: bearer {}", TOKEN.to_lowercase())), "走的是同一個查詢（Bearer 現成的 access token）");
    // 失敗：只印狀態碼，連回應內容也不印
    for (reply, code) in [(http("500 Oops", ERR_BODY), "HTTP 500"), (http("401 U", ERR_BODY), "HTTP 401"), (http("429 T", ERR_BODY), "HTTP 429"), (http("404 N", ERR_BODY), "HTTP 404")] {
        let f = serve(profile_ok("a@x.test"), reply);
        let out = shape_report(h.path(), NOW, &f.net);
        assert_eq!(out, format!("查詢失敗：{code}"));
        assert!(!out.contains(ERR_BODY) && !out.contains(TOKEN));
    }
    let f = serve(profile_ok("a@x.test"), usage_ok());
    let expired = home("a@x.test", NOW - 1);
    assert!(shape_report(expired.path(), NOW, &f.net).contains("過期"));
    let none = tempfile::tempdir().unwrap();
    assert!(shape_report(none.path(), NOW, &f.net).contains("沒有可用的登入"));
    assert_eq!(f.count(), 0, "過期或沒登入都不連網");
}

#[test]
fn 查詢只有一份_額外帳號與命令與正式額度都走_claude_quota_query() {
    let extra = prod(include_str!("../claude_extra.rs"));
    for gone in ["api/oauth/usage", "api/oauth/profile", "anthropic-beta", "USAGE_URL", "PROFILE_URL", "bearer_auth", "client()?.get("] {
        assert!(!extra.contains(gone), "claude_extra.rs 不另寫一份查詢：{gone}");
    }
    assert!(extra.contains("claude_quota::query("));
    let mine = prod(include_str!("../claude_quota.rs"));
    assert_eq!(mine.matches("net.usage(").count(), 2, "只有 query 與 shape_report 兩處呼叫用量查詢（同一個 Net::usage）");
    let cmd = include_str!("../cli/claude_usage_cmd.rs");
    assert!(cmd.contains("claude_quota::shape_report(") && !cmd.contains("reqwest"));
}
