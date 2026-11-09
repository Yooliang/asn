//! G2 黃金檔與特徵測試（ACP／agy 通道的純函式與固定文字）。
//!
//! 鎖的是「現況」不是「期望」：agy 啟動參數、模型清單解析、工具分類、請求摘要、錯誤分類、固定中文模板、
//! 授權詢問信與回覆字串，在固定輸入下的輸出記成 tests/golden/acp/*.json。看起來像 bug 的結果也如實記著，不在這裡修。
//! 更新方式：ASN_UPDATE_GOLDEN=1 cargo test --lib golden，重跑一次後審 git diff（CI 禁止重寫）。

use super::acp_agy::agy_args;
use super::acp_approvals::{ask_text, Answer, Approvals, Handled, Target};
use super::acp_config::{normalize_worker, WorkerCfg};
use super::acp_models::parse_agy_models;
use super::acp_policy::{category_label, category_of_agy_tool, classify_failure, describe_agy_tool, is_network_error, Req, CATEGORIES};
use super::acp_worker::{preamble_for, redirect_note};
use crate::golden;
use crate::golden_util::to_golden;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

/// 用正式的 normalize_worker 建 WorkerCfg（不改產品程式；cwd 不進任何輸出，避免平台路徑分隔符差異）
fn cfg_of(extra: Value) -> WorkerCfg {
    let mut raw = json!({"name": "Agy", "engine": "acp", "command": "agy"});
    for (k, v) in extra.as_object().unwrap() {
        raw[k] = v.clone();
    }
    normalize_worker(&raw, Path::new("/wd"), 0).expect("建立測試用 WorkerCfg").0
}

// ---- 1. agy_args -------------------------------------------------------------------------------------

#[test]
fn agy_啟動參數_順序與有無() {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for model in ["", "gemini-4-argon-high"] {
        for sid in ["", "sess-123"] {
            for full in [false, true] {
                let cfg = cfg_of(json!({"model": model}));
                out.insert(format!("model={model:?} session={sid:?} full_access={full}"), agy_args(&cfg, sid, full));
            }
        }
    }
    let cfg = cfg_of(json!({"args": ["C:\\fake agy\\script.js", "--flag=a b", "中文旗標", "--x\ty", ""], "model": "m"}));
    out.insert("cfg.args 含空白與特殊字元_全開".into(), agy_args(&cfg, "s 1/中", true));
    let cfg = cfg_of(json!({"args": ["--only-arg"]}));
    out.insert("cfg.args 一個_其餘皆空".into(), agy_args(&cfg, "", false));
    golden!("acp/agy_args.json", &to_golden(&out));
}

// ---- 2. parse_agy_models -----------------------------------------------------------------------------

const MODELS_SAMPLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/agy-models/sample.txt"));

#[test]
fn agy_模型清單解析() {
    let lf = MODELS_SAMPLE.replace("\r\n", "\n");
    let crlf = lf.replace('\n', "\r\n");
    let mut out: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    out.insert("fixture_lf", parse_agy_models(&lf));
    out.insert("fixture_crlf", parse_agy_models(&crlf));
    out.insert("空字串", parse_agy_models(""));
    out.insert("只有說明文字", parse_agy_models("Fetching available models...\n"));
    out.insert("只有換行", parse_agy_models("\n\r\n\n"));
    out.insert("無換行單行", parse_agy_models("one-id\tName"));
    out.insert("兩個Tab只取第一欄", parse_agy_models("a-1\tb\tc\n"));
    out.insert("六十字合法", parse_agy_models(&format!("{}\tx\n", "a".repeat(60))));
    out.insert("六十一字不合法", parse_agy_models(&format!("{}\tx\n", "a".repeat(61))));
    golden!("acp/parse_agy_models.json", &to_golden(&out));
}

// ---- 3. category_of_agy_tool -------------------------------------------------------------------------

/// 從原始碼文字取出常數表的所有名字（常數是私有的，這裡不改可見性，改成讀原始碼；表被改了黃金檔會跟著變）
fn table_names(src: &str, table: &str) -> Vec<String> {
    let start = src.find(&format!("const {table}:")).unwrap_or_else(|| panic!("原始碼找不到常數表 {table}"));
    let body = &src[start..];
    let eq = body.find('=').expect("找不到 =");
    let open = body[eq..].find('[').expect("找不到 [") + eq;
    let close = body[open..].find("];").expect("找不到 ];") + open;
    body[open..close].split('"').skip(1).step_by(2).map(String::from).collect()
}

#[test]
fn agy_工具分類_白名單每個名字與關鍵字順序() {
    let src = include_str!("acp_policy.rs");
    let tables = ["AGY_READ", "AGY_WRITE", "AGY_EXEC", "AGY_NET", "AGY_INTERNAL"];
    let mut out: BTreeMap<String, BTreeMap<String, &'static str>> = BTreeMap::new();
    for t in tables {
        let names = table_names(src, t);
        assert!(names.len() >= 5, "{t} 解析出 {} 個名字，太少了", names.len());
        out.insert(t.to_string(), names.iter().map(|n| (n.clone(), category_of_agy_tool(n))).collect());
    }
    // 表裡的名字大寫也要同一類（函式先轉小寫）
    let upper: BTreeMap<String, &'static str> = tables.iter().flat_map(|t| table_names(src, t)).map(|n| n.to_uppercase()).map(|n| (n.clone(), category_of_agy_tool(&n))).collect();
    out.insert("全部名字轉大寫".into(), upper);
    let cases = [
        "run_patch",
        "webhook_delete",
        "Write_To_File",
        "WRITE_TO_FILE",
        "browser_click",
        "browser_",
        "Browser_Navigate",
        "my_browser_tool",
        "execute_something",
        "patch_exec",
        "fetch_http_and_write",
        "run_http",
        "sed_inplace",
        "terminal_open",
        "bash",
        "shell_run",
        "download_url",
        "create_thing",
        "remove_thing",
        "move_it",
        "unknown_tool",
        "",
        "  ",
        "view_file ",
        "完全未知的中文工具",
    ];
    out.insert("關鍵字與順序衝突案例".into(), cases.iter().map(|c| (c.to_string(), category_of_agy_tool(c))).collect());
    golden!("acp/category_of_agy_tool.json", &to_golden(&out));
}

// ---- 4. describe_agy_tool ----------------------------------------------------------------------------

#[derive(Serialize)]
struct ReqOut {
    category: String,
    paths: Vec<String>,
    summary: String,
}
fn req_out(r: Req) -> ReqOut {
    ReqOut { category: r.category, paths: r.paths, summary: r.summary }
}

#[test]
fn agy_請求摘要_路徑指令截斷與遮蔽() {
    let fake_sk = format!("sk-{}", "FAKE".repeat(6));
    let fake_ghp = format!("ghp_{}", "x".repeat(24));
    let long_cmd = format!("echo {}", "長".repeat(200));
    let long_path = format!("/work/{}", "p".repeat(100));
    let long_tool = "x_tool_".repeat(20);
    let cases: Vec<(&str, &str, Option<Value>)> = vec![
        ("有指令與路徑", "run_command", Some(json!({"CommandLine": "ls -la", "Cwd": "/work/dir", "TargetFile": "/a/b.txt"}))),
        ("指令鍵 command", "run_command", Some(json!({"command": "git status"}))),
        ("兩種指令鍵並存_CommandLine 優先", "run_command", Some(json!({"CommandLine": "first", "command": "second"}))),
        ("指令是空字串_退回路徑", "run_command", Some(json!({"CommandLine": "", "path": "/p"}))),
        ("指令不是字串", "run_command", Some(json!({"CommandLine": 5, "path": "/p"}))),
        ("沒有參數", "list_dir", None),
        ("參數是 null", "list_dir", Some(Value::Null)),
        ("參數是空物件", "view_file", Some(json!({}))),
        ("參數是陣列", "view_file", Some(json!([1, 2]))),
        ("參數是字串", "view_file", Some(json!("path"))),
        ("超長指令_截 160", "run_command", Some(json!({"CommandLine": long_cmd}))),
        ("恰好 160 字指令", "run_command", Some(json!({"CommandLine": "a".repeat(160)}))),
        ("161 字指令", "run_command", Some(json!({"CommandLine": "a".repeat(161)}))),
        ("超長路徑_摘要截 160_路徑本身不截", "view_file", Some(json!({"AbsolutePath": long_path}))),
        ("超長工具名_截 60", long_tool.as_str(), None),
        ("無參數的未知工具名", "think_about_it", None),
        ("path 命名", "view_file", Some(json!({"AbsolutePath": "/w/a.txt"}))),
        ("file 命名", "write_to_file", Some(json!({"TargetFile": "/w/b.txt", "CodeContent": "hello"}))),
        ("dir 命名", "list_dir", Some(json!({"DirectoryPath": "/w/d"}))),
        ("target 命名", "sed_file", Some(json!({"Target": "/w/t"}))),
        ("多個路徑參數_去重", "multi_replace_file_content", Some(json!({"TargetFile": "/w/x", "path": "/w/x", "SearchDir": "/w/y"}))),
        ("路徑參數是空字串或非字串", "view_file", Some(json!({"path": "", "file": 3, "dir": null}))),
        ("鍵名大小寫混合", "view_file", Some(json!({"FILEPATH": "/w/u", "Dir": "/w/v"}))),
        ("機密_sk 金鑰在指令", "run_command", Some(json!({"CommandLine": format!("curl -H x {fake_sk}")}))),
        ("機密_ghp 金鑰在指令", "run_command", Some(json!({"CommandLine": format!("git clone https://{fake_ghp}")}))),
        ("機密_key=value", "run_command", Some(json!({"CommandLine": "export API_KEY=abc123 && run"}))),
        ("機密_Bearer 憑證", "run_command", Some(json!({"CommandLine": "curl -H Authorization: Bearer abcdefghijklmnop url"}))),
        ("機密_token 後接值", "run_command", Some(json!({"CommandLine": "tool --token: hunter2 --other"}))),
        ("機密_password= 空值接下一詞", "run_command", Some(json!({"CommandLine": "login password= secretvalue"}))),
        ("機密在路徑", "view_file", Some(json!({"path": format!("/w/{fake_sk}")}))),
        ("內部工具", "finish", Some(json!({"Summary": "done"}))),
        ("網路工具", "read_url_content", Some(json!({"Url": "https://example.com"}))),
        ("指令前後空白與多空白", "run_command", Some(json!({"CommandLine": "  ls    -la   \n"}))),
    ];
    let out: Vec<(String, ReqOut)> = cases.into_iter().map(|(n, t, p)| (n.to_string(), req_out(describe_agy_tool(t, p.as_ref())))).collect();
    golden!("acp/describe_agy_tool.json", &to_golden(&out));
}

// ---- 5. classify_failure／is_network_error ------------------------------------------------------------

#[derive(Serialize)]
struct FailOut {
    classify: Option<&'static str>,
    network: bool,
}

#[test]
fn 錯誤分類_額度登入網路() {
    let texts = [
        "Quota exceeded for project, check your plan and billing",
        "quota exceeded: please login again",
        "please sign in to continue; quota reached",
        "Error 429",
        "HTTP 429: Too Many Requests",
        "status=429.",
        "error4290",
        "x429",
        "RESOURCE_EXHAUSTED",
        "resource exhausted by upstream",
        "rate limit reached",
        "Rate-Limit hit",
        "ratelimit",
        "rate_limit_error",
        "you have exceeded your daily allowance",
        "usage limit reached",
        "limit exceeded",
        "out of credits",
        "額度已用完",
        "本月額度不足，請改天再試",
        "Please login first",
        "login",
        "not logged in",
        "Not Signed In",
        "請登入",
        "尚未登入",
        "登入失效，請重新登入",
        "OAuth token refresh failed",
        "invalid_grant",
        "Invalid Grant: expired",
        "Unauthorized",
        "authentication failed",
        "credentials missing",
        "credentialsx",
        "loginx page",
        "auth required",
        "authorization required",
        "token expired",
        "the token has expired",
        "HTTP 401",
        "401 Unauthorized",
        "error 4012",
        "x401",
        "401x",
        "(401)",
        "connection reset by peer",
        "read tcp: wsarecv: An existing connection was forcibly closed by the remote host.",
        "dial tcp 1.2.3.4:443: i/o timeout",
        "ECONNRESET",
        "Temporary failure in name resolution",
        "TLS handshake timeout",
        "unexpected EOF",
        "broken   pipe",
        "connection reset, please login",
        "network error 429",
        "no such host",
        "network is unreachable",
        "",
        "   ",
        "something else went wrong",
        "發生未知錯誤",
        "timeout",
        "Quota\nexceeded",
    ];
    let out: Vec<(String, FailOut)> = texts.iter().map(|t| (t.to_string(), FailOut { classify: classify_failure(t), network: is_network_error(t) })).collect();
    golden!("acp/failure_classes.json", &to_golden(&out));
}

// ---- 6. 固定中文模板 ---------------------------------------------------------------------------------

#[test]
fn 固定模板_開場說明與改寫提醒() {
    #[derive(Serialize)]
    struct T {
        preamble: BTreeMap<String, String>,
        redirect_note: Vec<(String, String, String)>,
    }
    let w = |name: &str, p: Value| cfg_of(json!({"name": name, "protocol": "acp", "permissions": p}));
    let mut preamble = BTreeMap::new();
    preamble.insert("全開".to_string(), preamble_for(&w("Gemini", json!({}))));
    preamble.insert("寫入拒絕".into(), preamble_for(&w("Gemini", json!({"write": "deny"}))));
    preamble.insert("執行拒絕".into(), preamble_for(&w("Gemini", json!({"execute": "deny"}))));
    preamble.insert("唯讀".into(), preamble_for(&w("Gemini", json!({"write": "deny", "execute": "deny"}))));
    preamble.insert("寫入問我_執行放行".into(), preamble_for(&w("Gemini", json!({"write": "ask"}))));
    preamble.insert("兩者都問我".into(), preamble_for(&w("夥伴甲-2", json!({"write": "ask", "execute": "ask"}))));
    preamble.insert("agy-stream 寫入 ask 被降成 deny".into(), preamble_for(&cfg_of(json!({"name": "A1", "protocol": "agy-stream", "permissions": {"write": "ask"}}))));
    let rn = |p: &str, c: &str| (p.to_string(), c.to_string(), redirect_note(p, Path::new(c)));
    let redirect_note = vec![
        rn("C:\\Users\\x\\.ssh\\id_rsa", "C:\\ASN\\workers\\A"),
        rn("/home/u/.config/app.toml", "/wd/workers/A"),
        rn("", "/wd"),
        rn("含「引號」與 空白/中文.txt", "/wd/中文 資料夾"),
    ];
    golden!("acp/templates.json", &to_golden(&T { preamble, redirect_note }));
}

// ---- 7. 授權詢問信與回覆 -----------------------------------------------------------------------------

#[test]
fn 授權詢問信_分鐘換算() {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for req in ["", "夥伴甲"] {
        for ms in [0u64, 1, 29_999, 30_000, 59_999, 60_000, 89_999, 90_000, 119_999, 300_000, 3_600_000] {
            out.insert(format!("requester={req:?} timeout_ms={ms}"), ask_text("Gemini", "AB12", "寫入：/w/a.txt", req, ms));
        }
    }
    out.insert("摘要含換行與中文括號".into(), ask_text("工作者-1", "0F3C", "執行指令：ls\n（第二行）", "PC1/視窗", 300_000));
    golden!("acp/ask_text.json", &to_golden(&out));
}

/// 回覆結果轉成可比對的形式；編號是隨機的，輸出前換成固定代號
fn handled_out(h: Handled, ids: &[(&str, &str)]) -> (bool, Option<String>) {
    let fix = |s: String| ids.iter().fold(s, |acc, (id, to)| acc.replace(id, to));
    (h.handled, h.note.map(fix))
}

#[tokio::test]
async fn 授權回覆_現況字串() {
    let ap = Approvals::new();
    let t = |n: &str, a: Option<&str>| Target { node: n.into(), agent: a.map(String::from) };
    let mut rows: Vec<(String, (bool, Option<String>))> = vec![];
    let mut push = |name: &str, h: Handled, ids: &[(&str, &str)]| rows.push((name.to_string(), handled_out(h, ids)));

    // 沒有任何等待中的授權
    push("沒有等待中", ap.handle_reply("G", "PC1", "甲", "允許"), &[]);

    // 單筆：只認被問的人
    let (id, _rx) = ap.ask("G", "寫入：a", vec![t("PC1", None)], 600_000);
    push("不是被問的人", ap.handle_reply("G", "別人", "x", "允許"), &[]);
    push("別的工作者", ap.handle_reply("H", "PC1", "x", "允許"), &[]);
    push("單筆_無法解析的回覆", ap.handle_reply("G", "PC1", "", "今天天氣不錯"), &[]);
    push("單筆_有表態但不單純也沒編號", ap.handle_reply("G", "PC1", "", "好的，我晚點看"), &[]);
    push("單筆_附編號但沒有表態", ap.handle_reply("G", "PC1", "", &format!("{id} 看看")), &[]);
    push("單筆_單純表態 好的", ap.handle_reply("G", "PC1", "甲", "好的"), &[(&id, "<ID>")]);

    for (name, reply) in [("單筆_拒絕附編號", "拒絕 {ID}"), ("單筆_全部允許附編號", "全部允許 {ID}"), ("單筆_允許小寫編號", "允許 {id}"), ("單筆_英文 approve all", "approve all"), ("單筆_No 帶句號", "No."), ("單筆_deny", "deny"), ("單筆_編號夾在句中", "好，{ID}，謝謝")] {
        let (id, _rx) = ap.ask("G", "執行：b", vec![t("PC1", None)], 600_000);
        let text = reply.replace("{ID}", &id).replace("{id}", &id.to_lowercase());
        push(name, ap.handle_reply("G", "PC1", "", &text), &[(&id, "<ID>")]);
    }

    // 指定視窗（agent）：視窗不符不算，符合才算
    let (id, _rx) = ap.ask("G", "寫入：c", vec![t("PC1", Some("夥伴甲"))], 600_000);
    push("指定視窗_視窗不符", ap.handle_reply("G", "PC1", "夥伴乙", "允許"), &[]);
    push("指定視窗_視窗相符", ap.handle_reply("G", "PC1", "夥伴甲", "允許"), &[(&id, "<ID>")]);

    // 多筆：清單依編號由小到大排；為了輸出穩定，重抽到「甲的編號小於乙」才用
    let (id1, id2, _rxs) = loop {
        let (a, ra) = ap.ask("G", "摘要甲", vec![t("PC1", None)], 600_000);
        let (b, rb) = ap.ask("G", "摘要乙", vec![t("PC1", None)], 600_000);
        if a < b {
            break (a, b, (ra, rb));
        }
        ap.finish(&a, Answer::Deny);
        ap.finish(&b, Answer::Deny);
    };
    let ids = [(id1.as_str(), "<ID1>"), (id2.as_str(), "<ID2>")];
    push("多筆_沒編號", ap.handle_reply("G", "PC1", "", "允許"), &ids);
    push("多筆_非單純表態沒編號", ap.handle_reply("G", "PC1", "", "好的我看看"), &ids);
    push("多筆_指定第二筆拒絕", ap.handle_reply("G", "PC1", "", &format!("拒絕 {id2}")), &ids);
    push("多筆_剩一筆時單純表態", ap.handle_reply("G", "PC1", "", "允許"), &ids);

    golden!("acp/handle_reply.json", &to_golden(&rows));
}

// ---- 8. 其他可直接引用的公開常數 ---------------------------------------------------------------------

#[test]
fn 公開常數與類別標籤() {
    #[derive(Serialize)]
    struct C {
        categories: Vec<&'static str>,
        category_labels: BTreeMap<String, String>,
        perm_remote_tick_secs: u64,
    }
    let labels: BTreeMap<String, String> = CATEGORIES.iter().chain(["internal", "未知類別", ""].iter()).map(|c| (c.to_string(), category_label(c).to_string())).collect();
    golden!("acp/constants.json", &to_golden(&C { categories: CATEGORIES.to_vec(), category_labels: labels, perm_remote_tick_secs: crate::perm_remote::TICK_SECS }));
}
