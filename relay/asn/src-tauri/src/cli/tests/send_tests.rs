//! 由 send.test.mjs／send-attach.test.mjs 改寫
use super::*;
use crate::cli::send::{parse_args, resolve_reply_flag};

const NEED_FLAG: &str = "請說明要不要回信：等對方回就加 --reply，只是告知就加 --no-reply";
// 與 Node 的 sentMarkName 對照（node -e 算出來的值）：橋讀的記號檔名兩邊必須一致
const MARK_XISU: &str = "49eac4b735e797e48f68ae3904fc00943ce9278f";
const MARK_W_POLICY: &str = "1abddf9b1ffc0ef4839ba1b077fca66d976ce29c";

#[test]
fn 寄給成員_from_agent_取自視窗_帶機器金鑰與_reply_to_輸出_sent_id_並留_replied_sent_記號() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let rid = "bbbbbbbb-1111-2222-3333-444444444444";
    let (c, out, err) = go(&f.env, &["send", "--to", "XISU", "--body", "回報：測試都過了", "--reply-to", rid, "--no-reply"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.starts_with(&format!("sent id={NEW_ID} to=XISU from=T/T-視窗甲")), "{out}");
    let reqs = b.of("send");
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].headers.get("x-relay-key").map(String::as_str), Some(KEY));
    assert_eq!(reqs[0].json(), json!({"to_node": "XISU", "body": "回報：測試都過了", "reply_to": rid, "from_agent": "T-視窗甲", "expects_reply": false}));
    let (c2, _, _) = go(&f.env, &["send", "--to", "W/W-政策", "--body", "x", "--no-reply"], "");
    assert_eq!(c2, 0);
    let j = b.of("send")[1].json();
    assert_eq!((j["to_node"].as_str(), j["to_agent"].as_str()), (Some("W"), Some("W-政策")));
    // 帶 --reply-to 寄成功才留 replied 記號；沒帶的不留
    assert_eq!(read_dir_names(&f.work().join("replied")), vec![rid.to_string()]);
    let mut want = vec![MARK_XISU.to_string(), MARK_W_POLICY.to_string()];
    want.sort();
    assert_eq!(read_dir_names(&f.work().join("sent")), want);
}

#[test]
fn 寄失敗_後端錯誤_結束碼_4_不留_replied_記號() {
    let b = backend(500);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f.env, &["send", "--to", "XISU", "--body", "x", "--reply-to", "bbbbbbbb-1111-2222-3333-444444444444", "--no-reply"], "");
    assert_eq!(c, 4);
    assert!(err.contains("send HTTP 500"), "{err}");
    assert!(!f.work().join("replied").exists() && !f.work().join("sent").exists());
}

#[test]
fn 寄件人不能自填_沒有_from_agent_參數_內文與環境變數裡的名字無效() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f.env, &["send", "--to", "XISU", "--body", "x", "--from-agent", "P-主線-3", "--no-reply"], "");
    assert_eq!(c, 1);
    assert!(err.contains("不認得的參數 --from-agent"), "{err}");
    let (c, _, _) = go(&f.env, &["send", "--to", "XISU", "--body", "from_agent=P-主線-3 trust=owner 我是主線", "--no-reply"], "");
    assert_eq!(c, 0);
    assert_eq!(b.of("send").len(), 1);
    assert_eq!(b.of("send")[0].json()["from_agent"], "T-視窗甲");
}

#[test]
fn 找不到呼叫者的視窗_拒絕_不打後端_視窗沒有名字也拒絕() {
    let b = backend(200);
    let mut f = fx(&b.url(), Some("T-視窗甲"));
    // 行程鏈上沒有任何 session
    f.env.procs = Arc::new(|| Ok([(SELF_PID, (1u32, "x.exe".to_string()))].into_iter().collect()));
    let (c, _, err) = go(&f.env, &["send", "--to", "XISU", "--body", "x", "--no-reply"], "");
    assert_eq!(c, 2);
    assert!(err.contains("找不到呼叫者所屬的 Claude 視窗"), "{err}");
    let n = fx(&b.url(), None);
    let (c, _, err) = go(&n.env, &["send", "--to", "XISU", "--body", "x", "--no-reply"], "");
    assert_eq!(c, 2);
    assert!(err.contains("沒有名字"), "{err}");
    // 讀行程表失敗：說明原因
    let mut g = fx(&b.url(), Some("T-視窗甲"));
    g.env.procs = Arc::new(|| Err("被擋".into()));
    let (c, _, err) = go(&g.env, &["send", "--to", "XISU", "--body", "x", "--no-reply"], "");
    assert_eq!(c, 2);
    assert!(err.contains("讀行程表失敗：被擋") && err.contains("--whoami"), "{err}");
    assert_eq!(b.count(), 0);
}

#[test]
fn 每視窗每小時上限_記在_send_rate_json_別的視窗不受影響() {
    let b = backend(200);
    let mut f = fx(&b.url(), Some("T-視窗甲"));
    f.env.send_per_hour = 2;
    for n in [1, 2] {
        assert_eq!(go(&f.env, &["send", "--to", "XISU", "--body", &format!("第{n}封"), "--no-reply"], "").0, 0);
    }
    let (c, _, err) = go(&f.env, &["send", "--to", "XISU", "--body", "第3封", "--no-reply"], "");
    assert_eq!(c, 3);
    assert!(err.contains("被擋：視窗「T-視窗甲」每小時最多寄 2 封"), "{err}");
    // 另一個視窗（同一台機器、同一個 send-rate.json）
    let other = fx(&b.url(), Some("T-視窗乙"));
    std::fs::copy(f.rh().join("send-rate.json"), other.rh().join("send-rate.json")).unwrap();
    let mut o = other.env.clone();
    o.send_per_hour = 2;
    assert_eq!(go(&o, &["send", "--to", "XISU", "--body", "別的視窗", "--no-reply"], "").0, 0);
    let bodies: Vec<String> = b.of("send").iter().map(|r| r.json()["body"].as_str().unwrap().to_string()).collect();
    assert_eq!(bodies, vec!["第1封", "第2封", "別的視窗"]);
    let rate: Value = serde_json::from_str(&std::fs::read_to_string(f.rh().join("send-rate.json")).unwrap()).unwrap();
    assert_eq!(rate["T-視窗甲"].as_array().unwrap().len(), 2);
}

#[test]
fn 同節點寄信_可寄給本機其他視窗_寄給自己這個視窗被擋_不打後端() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["send", "--to", "T/H-ASN", "--body", "給本機 ASN", "--reply"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.starts_with(&format!("sent id={NEW_ID} to=T/H-ASN from=T/T-視窗甲")));
    assert_eq!(b.of("send")[0].json(), json!({"to_node": "T", "to_agent": "H-ASN", "body": "給本機 ASN", "from_agent": "T-視窗甲", "expects_reply": true}));
    assert_eq!(go(&f.env, &["send", "--to", "T", "--body", "給本機預設", "--no-reply"], "").0, 0);
    assert_eq!(b.count(), 2);
    let (c, _, err) = go(&f.env, &["send", "--to", "T/T-視窗甲", "--body", "自言自語", "--no-reply"], "");
    assert_eq!(c, 1);
    assert!(err.contains("收件人就是你自己（T/T-視窗甲）"), "{err}");
    assert_eq!(b.count(), 2);
}

#[test]
fn 格式與內容檢查_全部結束碼_1_不打後端_超過_20000_字被擋_剛好_20000_可以() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let long = "x".repeat(20001);
    let bads: Vec<(Vec<&str>, &str)> = vec![
        (vec!["send"], "二選一"),
        (vec!["send", "--to", "XISU", "--room", "g1", "--body", "x", "--no-reply"], "二選一"),
        (vec!["send", "--to", "XISU", "--body", "   ", "--no-reply"], "內文是空的"),
        (vec!["send", "--to", "XISU", "--body", "x", "--reply-to", "不是uuid", "--no-reply"], "reply-to"),
        (vec!["send", "--to", "bad!id", "--body", "x", "--no-reply"], "成員代號格式不對"),
        (vec!["send", "--to", "T/T-視窗甲", "--body", "x", "--no-reply"], "就是你自己"),
        (vec!["send", "--to", "XISU", "--body", &long, "--no-reply"], "超過 20000 字"),
        (vec!["send", "--to", "XISU", "--body"], "缺少參數"),
    ];
    for (args, re) in bads {
        let (c, _, err) = go(&f.env, &args, "");
        assert_eq!(c, 1, "{args:?}");
        assert!(err.contains(re), "{args:?} → {err}");
    }
    assert_eq!(b.count(), 0);
    assert_eq!(go(&f.env, &["send", "--to", "XISU", "--body", &"x".repeat(20000), "--no-reply"], "").0, 0);
}

#[test]
fn 群組_stdin_body_file_後端錯誤_節點自動判定() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, _) = go(&f.env, &["send", "--room", "g36", "--body", "群組回報"], "");
    assert_eq!(c, 0);
    assert!(out.starts_with("posted room=g36 seq=12 from=T/T-視窗甲"), "{out}");
    assert_eq!(b.of("room_post")[0].json(), json!({"room": "g36", "body": "群組回報", "from_agent": "T-視窗甲"}));
    let (c, _, _) = go(&f.env, &["send", "--to", "XISU", "--body", "-", "--no-reply"], "從 stdin 來的內文\n");
    assert_eq!(c, 0);
    assert_eq!(b.of("send")[0].json()["body"], "從 stdin 來的內文");
    let file = f.home.join("m.txt");
    std::fs::write(&file, "檔案內文\n\n").unwrap();
    assert_eq!(go(&f.env, &["send", "--to", "XISU", "--body-file", file.to_str().unwrap(), "--no-reply"], "").0, 0);
    assert_eq!(b.of("send")[1].json()["body"], "檔案內文");
    // 不給 IRORI_RELAY_ID：唯一有金鑰檔的節點決定
    let mut auto = f.env.clone();
    auto.relay_id = None;
    let (c, out, err) = go(&auto, &["send", "--to", "XISU", "--body", "自動判定節點", "--no-reply"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.contains("from=T/T-視窗甲"));
    // 後端 404
    let b2 = backend(404);
    let f2 = fx(&b2.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f2.env, &["send", "--to", "NOBODY", "--body", "x", "--no-reply"], "");
    assert_eq!(c, 4);
    assert!(err.contains("send HTTP 404 not_found"), "{err}");
}

#[test]
fn 環境變數備援_孤兒行程帶著視窗專屬的_socket_認得_socket_不符或_session_已死_拒絕() {
    let b = backend(200);
    let mut f = fx(&b.url(), Some("不會用到"));
    // 行程鏈斷掉（沒有任何祖先登記過）
    f.env.procs = Arc::new(|| Ok([(SELF_PID, (1u32, "x.exe".to_string()))].into_iter().collect()));
    let put = |pid: u32, sock: &str, name: &str| std::fs::write(f.env.sessions_dir.join(format!("{pid}.json")), json!({"pid": pid, "name": name, "kind": "interactive", "entrypoint": "cli", "messagingSocketPath": sock}).to_string()).unwrap();
    put(7001, r"\\.\pipe\LOCAL\cc-msg-fake", "T-備援視窗");
    put(999_999, r"\\.\pipe\LOCAL\cc-msg-dead", "T-死掉的視窗");
    let mut ok = f.env.clone();
    ok.socket = Some(r"\\.\pipe\LOCAL\cc-msg-fake".into());
    let (c, _, err) = go(&ok, &["send", "--to", "XISU", "--body", "x", "--no-reply"], "");
    assert_eq!(c, 0, "{err}");
    assert_eq!(b.of("send")[0].json()["from_agent"], "T-備援視窗");
    let mut wrong = f.env.clone();
    wrong.socket = Some(r"\\.\pipe\LOCAL\cc-msg-other".into());
    assert_eq!(go(&wrong, &["send", "--to", "XISU", "--body", "x", "--no-reply"], "").0, 2);
    let mut dead = f.env.clone();
    dead.socket = Some(r"\\.\pipe\LOCAL\cc-msg-dead".into());
    let (c, _, err) = go(&dead, &["send", "--to", "XISU", "--body", "x", "--no-reply"], "");
    assert_eq!(c, 2);
    assert!(err.contains("--whoami"));
    assert_eq!(b.of("send").len(), 1);
}

#[test]
fn whoami_不寄信_印出父行程鏈裡的視窗與節點判定() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["send", "--whoami"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.contains("<== session「T-視窗甲」"), "{out}");
    assert!(out.contains(&format!("判定（行程鏈）：pid={CLAUDE_PID} name=T-視窗甲")), "{out}");
    assert!(out.contains("機器節點判定：T"), "{out}");
    assert!(!out.contains(KEY), "金鑰不能印出");
    assert_eq!(b.count(), 0);
}

// ------------------------------------------------------------------ 要不要回信（--reply／--no-reply，送 expects_reply 欄位）

#[test]
fn parse_args_reply_與_no_reply_是不帶值的開關_和_reply_to_不會搞混() {
    let p = |a: &[&str]| parse_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
    let a = p(&["--to", "X", "--body", "b", "--reply"]);
    assert!(a.reply && !a.no_reply && a.to.as_deref() == Some("X"));
    let a = p(&["--no-reply", "--to", "X", "--body", "b"]); // 放哪裡都行，不吃掉後面的參數
    assert!(a.no_reply && a.body.as_deref() == Some("b"));
    let a = p(&["--to", "X", "--body", "b", "--reply-to", "ID", "--reply"]);
    assert!(a.reply && a.reply_to.as_deref() == Some("ID"));
    let a = p(&["--to", "X", "--file", "a.pdf", "--file", "b.webp"]);
    assert_eq!(a.files, vec!["a.pdf", "b.webp"]);
}

#[test]
fn resolve_reply_flag_to_一定要二選一_群組忽略() {
    assert_eq!(resolve_reply_flag(true, false, false).unwrap(), (Some(true), String::new()));
    assert_eq!(resolve_reply_flag(false, true, false).unwrap(), (Some(false), String::new()));
    let e = resolve_reply_flag(false, false, false).unwrap_err();
    assert!(e.code == 1 && e.msg.contains(NEED_FLAG));
    let e = resolve_reply_flag(true, true, false).unwrap_err();
    assert!(e.code == 1 && e.msg.contains("不能同時"));
    assert_eq!(resolve_reply_flag(false, false, true).unwrap(), (None, String::new()));
    for (r, n) in [(true, false), (false, true)] {
        let (x, note) = resolve_reply_flag(r, n, true).unwrap();
        assert!(x.is_none() && note.contains("群組") && note.contains("忽略"));
    }
    assert_eq!(resolve_reply_flag(true, true, true).unwrap_err().code, 1);
}

#[test]
fn reply_與_no_reply_送欄位_內文一字不動_沒有任何提醒() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["send", "--to", "W/W-政策", "--body", "請回報結果", "--reply"], "");
    assert_eq!((c, err.as_str()), (0, ""));
    assert!(out.starts_with("sent id="));
    let j = b.of("send")[0].json();
    assert_eq!((j["body"].as_str(), j["expects_reply"].as_bool()), (Some("請回報結果"), Some(true)));
    let (c, _, err) = go(&f.env, &["send", "--to", "W/W-政策", "--body", "進度：A 做完了", "--no-reply"], "");
    assert_eq!((c, err.as_str()), (0, ""));
    let j = b.of("send")[1].json();
    assert_eq!((j["body"].as_str(), j["expects_reply"].as_bool()), (Some("進度：A 做完了"), Some(false)));
    let rid = "bbbbbbbb-1111-2222-3333-444444444444";
    assert_eq!(go(&f.env, &["send", "--to", "XISU", "--body", "你覺得呢", "--reply-to", rid, "--reply"], "").0, 0);
    assert_eq!(b.of("send")[2].json()["expects_reply"], true);
}

#[test]
fn 沒說要不要回信_結束碼_1_說明怎麼加_不打後端_不留記號_內文寫不需回覆不算數() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    for args in [
        vec!["send", "--to", "XISU", "--body", "沒說要不要回"],
        vec!["send", "--to", "XISU", "--body", "（不需回覆）內文自己標了不算"],
        vec!["send", "--to", "XISU", "--body", "這是回信", "--reply-to", "bbbbbbbb-1111-2222-3333-444444444444"],
    ] {
        let (c, out, err) = go(&f.env, &args, "");
        assert_eq!(c, 1, "{args:?}");
        assert!(err.contains(NEED_FLAG), "{err}");
        assert_eq!(out, "");
    }
    assert_eq!(b.count(), 0);
    assert!(!f.work().join("sent").exists() && !f.work().join("replied").exists() && !f.rh().join("send-rate.json").exists());
    let (c, _, err) = go(&f.env, &["send", "--to", "XISU", "--body", "x", "--reply", "--no-reply"], "");
    assert_eq!(c, 1);
    assert!(err.contains("不能同時"));
    assert_eq!(b.count(), 0);
}

#[test]
fn room_群組不計時_旗標忽略_不送欄位_印一行說明() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, err) = go(&f.env, &["send", "--room", "g36", "--body", "群組回報"], "");
    assert_eq!((c, err.as_str()), (0, ""));
    assert!(out.starts_with("posted room=g36 seq=12"));
    for flag in ["--no-reply", "--reply"] {
        let (c, out, err) = go(&f.env, &["send", "--room", "g36", "--body", "群組", flag], "");
        assert_eq!(c, 0);
        assert!(err.contains("群組") && err.contains("忽略"), "{err}");
        assert!(out.starts_with("posted room=g36"));
    }
    for r in b.of("room_post") {
        assert!(r.json().get("expects_reply").is_none());
    }
}

#[test]
fn help_用法寫明二選一_不加內文標記_群組不適用() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, out, _) = go(&f.env, &["send", "--help"], "");
    assert_eq!(c, 0);
    for re in ["--reply", "--no-reply", "二選一", "群組", "忽略"] {
        assert!(out.contains(re), "{re}");
    }
}

// ------------------------------------------------------------------ 附件（--file）：attach_init／PUT／attach_commit／send

fn webp(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    b[0..4].copy_from_slice(b"RIFF");
    b[4..8].copy_from_slice(&((n - 8) as u32).to_le_bytes());
    b[8..16].copy_from_slice(b"WEBPVP8 ");
    b
}
fn pdf(n: usize) -> Vec<u8> {
    let mut b = b"%PDF-1.4\n".to_vec();
    b.resize(n, b' ');
    b
}
fn put_file(d: &Path, name: &str, b: &[u8]) -> String {
    let p = d.join(name);
    std::fs::write(&p, b).unwrap();
    p.to_string_lossy().to_string()
}
fn id1(n: u32) -> String {
    format!("11111111-0000-0000-0000-{n:012}")
}

#[test]
fn 寄一個_pdf_與一張_webp_順序為_init_put_commit_再_send_帶_attachment_ids_內文是附件清單加說明() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (p, w) = (put_file(&f.home, "報告(最終).PDF", &pdf(100)), put_file(&f.home, "cat.webp", &webp(64)));
    let (c, out, err) = go(&f.env, &["send", "--to", "XISU", "--body", "說明文字", "--file", &p, "--file", &w, "--no-reply"], "");
    assert_eq!(c, 0, "{err}");
    assert!(out.starts_with("sent id="));
    assert_eq!(b.actions(), vec!["attach_init", "attach_commit", "attach_init", "attach_commit", "send"]);
    let inits = b.of("attach_init");
    assert_eq!(inits[0].json(), json!({"kind": "file", "mime": "application/pdf", "name": "報告 最終.pdf", "bytes": 100}));
    assert_eq!(inits[1].json(), json!({"kind": "image", "mime": "image/webp", "name": "cat.webp", "bytes": 64}));
    let puts: Vec<Req> = b.reqs.lock().unwrap().iter().filter(|r| r.method == "PUT").cloned().collect();
    assert_eq!(puts.len(), 2);
    assert_eq!(puts[0].body, pdf(100));
    assert_eq!(puts[0].headers.get("content-type").map(String::as_str), Some("application/pdf"));
    assert_eq!(puts[1].body, webp(64));
    let s = b.of("send")[0].json();
    assert_eq!(s["attachment_ids"], json!([id1(1), id1(2)]));
    assert_eq!(s["body"], "〔檔案〕報告 最終.pdf\n〔照片〕cat.webp\n說明文字");
    assert!(!out.contains("SECRET-SIGNED") && !err.contains("SECRET-SIGNED"), "一次性簽名網址不外流");
}

#[test]
fn 只有附件沒有內文_內文就是附件清單_群組也能附() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let p = put_file(&f.home, "a.txt", b"hello");
    assert_eq!(go(&f.env, &["send", "--room", "g1", "--file", &p], "").0, 0);
    let r = b.of("room_post")[0].json();
    assert_eq!((r["body"].as_str(), r["attachment_ids"].clone()), (Some("〔檔案〕a.txt"), json!([id1(1)])));
}

#[test]
fn 不合格的附件全在本機擋下_不打後端_不寄信() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let exe = put_file(&f.home, "run.exe", b"MZ....");
    let png = put_file(&f.home, "a.png", b"\x89PNG....");
    let fake = put_file(&f.home, "fake.pdf", b"not a pdf at all");
    let empty = put_file(&f.home, "empty.txt", b"");
    let big = put_file(&f.home, "big.webp", &webp(5 * 1024 * 1024 + 1));
    let nul = put_file(&f.home, "bin.txt", b"abc\0def");
    let cases: Vec<(Vec<String>, &str)> = vec![
        (vec![exe], "這種檔案不能寄"),
        (vec![png], "照片只收 webp"),
        (vec![fake], "對不上"),
        (vec![empty], "檔案是空的"),
        (vec![big], "超過上限（照片至多 5 MB）"),
        (vec![nul], "對不上"),
        (vec![f.home.join("nope.pdf").to_string_lossy().to_string()], "找不到檔案"),
        (vec![f.home.to_string_lossy().to_string()], "不是檔案"),
        ((0..5).map(|i| put_file(&f.home, &format!("f{i}.txt"), b"x")).collect(), "最多 4 個附件"),
    ];
    for (files, re) in cases {
        let mut args: Vec<&str> = vec!["send", "--to", "XISU", "--body", "x", "--no-reply"];
        for x in &files {
            args.push("--file");
            args.push(x);
        }
        let (c, _, err) = go(&f.env, &args, "");
        assert_eq!(c, 1, "{files:?}");
        assert!(err.contains(re), "{files:?} → {err}");
    }
    assert_eq!(b.count(), 0);
    assert!(!f.rh().join("send-rate.json").exists(), "沒寄就不計次");
}

#[test]
fn 上傳失敗或後端拒收_不寄信_錯誤是白話() {
    // PUT 回 500
    let b = Fake::start(|req: &Req, port: u16| {
        if req.method == "PUT" {
            return Resp::bytes(500, vec![]);
        }
        match req.action().as_str() {
            "attach_init" => Resp::ok(json!({"id": id1(1), "upload_url": format!("http://127.0.0.1:{port}/upload/x?token=SECRET-SIGNED")})),
            _ => Resp::ok(json!({"id": NEW_ID})),
        }
    });
    let f = fx(&b.url(), Some("T-視窗甲"));
    let p = put_file(&f.home, "a.txt", b"hello");
    let (c, _, err) = go(&f.env, &["send", "--to", "XISU", "--body", "x", "--file", &p, "--no-reply"], "");
    assert_eq!(c, 4);
    assert!(err.contains("a.txt：上傳失敗（HTTP 500）") && !err.contains("SECRET-SIGNED"), "{err}");
    assert!(!b.actions().contains(&"send".to_string()) && !b.actions().contains(&"attach_commit".to_string()));
    // attach_init 回配額已滿
    let q = Fake::start(|_: &Req, _| Resp::json(413, json!({"error": "quota_exceeded"})));
    let f2 = fx(&q.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f2.env, &["send", "--to", "XISU", "--body", "x", "--file", &p, "--no-reply"], "");
    assert_eq!(c, 4);
    assert!(err.contains("a.txt：這台設備的附件空間滿了"), "{err}");
    // 上傳網址指到別的主機：擋下，不上傳
    let h = Fake::start(|_: &Req, _| Resp::ok(json!({"id": id1(1), "upload_url": "http://evil.example/upload/x"})));
    let f3 = fx(&h.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f3.env, &["send", "--to", "XISU", "--body", "x", "--file", &p, "--no-reply"], "");
    assert_eq!(c, 4);
    assert!(err.contains("上傳網址不在收發室的主機上"), "{err}");
    assert_eq!(h.count(), 1);
    // 後端不認得 attach_init（舊收發室）
    let o = Fake::start(|_: &Req, _| Resp::json(404, json!({"error": "not_found"})));
    let f4 = fx(&o.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f4.env, &["send", "--to", "XISU", "--body", "x", "--file", &p, "--no-reply"], "");
    assert_eq!(c, 4);
    assert!(err.contains("這個收發室還不支援傳附件"), "{err}");
}
