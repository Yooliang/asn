//! `asn recv`：本機 Claude 視窗自己收仲介寄給它的信，不經收發室、不經任何模型（對應 relay/machine/recv.mjs 與 self-recv.mjs）。
//!   asn recv --once     拉一次，每封印一行 JSON 到 stdout、印完 ack，然後結束
//!   asn recv --watch    長駐：Realtime 門鈴＋輪詢；每封一行 JSON 到 stdout（給 Claude Code 的 Monitor 用）
//! 只收「to_agent＝本視窗名」的信（視窗名由父行程鏈／環境變數備援認出，和 asn send 同一套，不能自填）；
//! 寄給整台機器（沒指定視窗）的總機信不在這裡，仍由收發室橋處理。
//! --watch 會寫心跳 ~/.irori-relay/machine-<節點>/self-recv/<視窗名>.json（每 30 秒）；橋看到心跳就不再轉交這個視窗的信（心跳過期就照舊轉）。
//! 每行 JSON：{id, trust, from_node, from_agent, to_agent, reply_to, created_at, expects_reply, body[, attachments]}。診斷訊息只走 stderr。
//!   asn recv --peek     只看不收：印 {"count":N,"messages":[{id,from,at,preview}]} 一行；不 ack、不改任何狀態（後端 inbox_peek 動作，只 select）；加 --count-only 只印 {"count":N}
//! 結束碼：1 用法、2 認不出視窗、3 這個視窗已有另一個 recv --watch 在跑、4 後端錯誤。
use super::caller::{find_caller, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use crate::bridge::attach::{normalize, notes_for, Attachment};
use crate::heartbeat::{clear_heartbeat, now_ms, read_heartbeat, write_heartbeat};
use crate::relay::encode_component;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

const USAGE: &str = "用法：
  asn recv --once    拉一次、印出（每封一行 JSON）、ack 後結束
  asn recv --watch   長駐收信（門鈴＋輪詢，每封一行 JSON 到 stdout；給 Monitor 用）
  asn recv --peek [--count-only]
                     只看不收：印未讀數與每封的 id／寄件人／時間／前 80 字，不 ack、不改任何狀態
                     （給狀態列用；--count-only 只印 {\"count\":N}）
只收寄給本視窗名的信；回信用 asn send --reply-to <id>（再加 --reply 或 --no-reply 二選一）。";

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub once: bool,
    pub watch: bool,
    pub peek: bool,
    pub count_only: bool,
    pub help: bool,
}

pub fn parse_args(argv: &[String]) -> R<Args> {
    let mut a = Args::default();
    for k in argv {
        match k.as_str() {
            "--once" => a.once = true,
            "--watch" => a.watch = true,
            "--peek" => a.peek = true,
            "--count-only" => a.count_only = true,
            "--help" | "-h" => a.help = true,
            _ => return Err(Fail::new(1, format!("不認得的參數 {k}\n{USAGE}"))),
        }
    }
    if !a.help && [a.once, a.watch, a.peek].iter().filter(|b| **b).count() != 1 {
        return Err(Fail::new(1, format!("--once、--watch、--peek 要三選一\n{USAGE}")));
    }
    if !a.help && a.count_only && !a.peek {
        return Err(Fail::new(1, format!("--count-only 只能和 --peek 一起用\n{USAGE}")));
    }
    Ok(a)
}

fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}
fn js_opt(v: Option<&Value>) -> String {
    match v.and_then(Value::as_str) {
        Some(s) => js(s),
        None => "null".into(),
    }
}
fn num_opt(n: Option<u64>) -> String {
    n.map(|n| n.to_string()).unwrap_or_else(|| "null".into())
}

/// 附件欄位（不含縮圖）；欄位順序固定
pub fn attachment_json(a: &Attachment) -> String {
    format!(
        "{{\"id\":{},\"kind\":{},\"name\":{},\"mime\":{},\"bytes\":{},\"width\":{},\"height\":{},\"expired\":{}}}",
        js(&a.id),
        js(&a.kind),
        js(&a.name),
        js(&a.mime),
        num_opt(a.bytes),
        num_opt(a.width),
        num_opt(a.height),
        a.expired
    )
}

/// 有附件時：body 後面多一行「〔照片〕檔名（…）下載：<指令> --id <編號>」（外部資料，同內文），另有 attachments 欄位；沒附件的信完全不變
pub fn to_line(m: &Value, cmd: Option<&str>) -> String {
    let atts = normalize(m.get("attachments"));
    let body0 = m.get("body").and_then(Value::as_str).unwrap_or("");
    let body = if atts.is_empty() { body0.to_string() } else { notes_for(body0, &atts, cmd) };
    let expects = match m.get("expects_reply").and_then(Value::as_bool) {
        Some(b) => b.to_string(),
        None => "null".into(),
    };
    let mut s = format!(
        "{{\"id\":{},\"trust\":{},\"from_node\":{},\"from_agent\":{},\"to_agent\":{},\"reply_to\":{},\"created_at\":{},\"expects_reply\":{},\"body\":{}",
        js_opt(m.get("id")),
        js_opt(m.get("trust")),
        js_opt(m.get("from_node")),
        js_opt(m.get("from_agent")),
        js_opt(m.get("to_agent")),
        js_opt(m.get("reply_to")),
        js_opt(m.get("created_at")),
        expects,
        js(&body)
    );
    if !atts.is_empty() {
        s.push_str(&format!(",\"attachments\":[{}]", atts.iter().map(attachment_json).collect::<Vec<_>>().join(",")));
    }
    s.push('}');
    s
}

/// 只看不收的輸出：{"count":N,"messages":[{"id","from","at","preview"}]}；preview 取內文前 80 字（控制字元壓成空白）。
/// count 以後端回的總數為準（沒給就用信數）；count_only 只印 {"count":N}。
pub fn peek_line(v: &Value, count_only: bool) -> String {
    let msgs = v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let count = v.get("count").and_then(Value::as_u64).unwrap_or(msgs.len() as u64);
    if count_only {
        return format!("{{\"count\":{count}}}");
    }
    let items: Vec<String> = msgs
        .iter()
        .map(|m| {
            let from = m.get("from_agent").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| m.get("from_node").and_then(Value::as_str)).unwrap_or("");
            let body = m.get("body").and_then(Value::as_str).unwrap_or("");
            let flat: String = body.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
            let preview: String = flat.chars().take(80).collect();
            format!("{{\"id\":{},\"from\":{},\"at\":{},\"preview\":{}}}", js_opt(m.get("id")), js(from), js_opt(m.get("created_at")), js(&preview))
        })
        .collect();
    format!("{{\"count\":{count},\"messages\":[{}]}}", items.join(","))
}

/// 毫秒時間 → ISO 8601（UTC，毫秒），給 stderr 的診斷行用
pub fn iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

/// 這個視窗現在有沒有自己在收信（供橋判斷；邏輯同 self-recv.mjs 的 selfRecvAlive）
pub fn hb_alive(hb: &crate::heartbeat::Heartbeat, now: u64, stale: u64, alive: impl Fn(u32) -> bool) -> bool {
    hb.pid != 0 && now.saturating_sub(hb.t) <= stale && hb.t.saturating_sub(now) < stale && alive(hb.pid)
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let a = parse_args(argv)?;
    if a.help {
        io.outln(USAGE);
        return Ok(0);
    }
    let id = identity(env, true)?;
    let me = find_caller(env, "收信")?;
    let rl = relay(&id, &me.name);
    let cmd = env.prefix("attach");
    let q = encode_component(&me.name);

    // --peek：只讀。只呼叫 inbox_peek（後端只 select），絕不呼叫 inbox／ack，也不寫心跳、replied／sent 記號
    if a.peek {
        let v = rl.api(&format!("inbox_peek&agent={q}"), None).await.map_err(|e| {
            if e.contains("HTTP 404") {
                Fail::new(4, "查詢未讀失敗：後端還沒支援「只看不收」（inbox_peek 回 404），請等後端部署新版後再試；這次沒有動到任何信。")
            } else {
                Fail::new(4, format!("查詢未讀失敗：{e}"))
            }
        })?;
        io.outln(&peek_line(&v, a.count_only));
        return Ok(0);
    }
    let mut printed: HashSet<String> = HashSet::new(); // 已印出但（可能）還沒 ack 成功的信：不重印，只重試 ack

    macro_rules! pull_once {
        () => {{
            async {
                let v = rl.api(&format!("inbox&agent={q}"), None).await?;
                let mut ids: Vec<String> = vec![];
                for m in v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default() {
                    if m.get("to_agent").and_then(Value::as_str) != Some(me.name.as_str()) {
                        continue; // 後端已過濾；這裡再擋一次，不是寄給本視窗的絕不印、不 ack
                    }
                    let Some(mid) = m.get("id").and_then(Value::as_str).map(String::from) else { continue };
                    if !printed.contains(&mid) {
                        io.outln(&to_line(&m, cmd.as_deref()));
                        printed.insert(mid.clone());
                    }
                    ids.push(mid);
                }
                if !ids.is_empty() {
                    rl.api(&format!("ack&agent={q}"), Some(json!({ "ids": ids }))).await?;
                    for i in &ids {
                        printed.remove(i);
                    }
                }
                Ok::<usize, String>(ids.len())
            }
        }};
    }

    if a.once {
        pull_once!().await.map_err(|e| Fail::new(4, format!("收信失敗：{e}")))?;
        return Ok(0);
    }

    // --watch：同一視窗只留一個（另一個還活著就退出，避免兩個 Monitor 重複印）
    let me_pid = std::process::id();
    if let Some(hb) = read_heartbeat(&id.work_dir, &me.name) {
        if hb.pid != me_pid && hb_alive(&hb, now_ms(), env.stale_ms, |p| (env.alive)(p)) {
            return Err(Fail::new(3, format!("視窗「{}」已經有一個 recv --watch 在跑（pid {}）", me.name, hb.pid)));
        }
    }
    let log = |io: &mut Io, msg: &str| io.errln(&format!("{} recv[{}] {msg}", iso(now_ms()), me.name));
    let beat = |io: &mut Io| {
        if let Err(e) = write_heartbeat(&id.work_dir, &me.name, me_pid, now_ms()) {
            log(io, &format!("heartbeat failed: {e}"));
        }
    };
    struct Clear<'a>(&'a std::path::Path, &'a str, u32);
    impl Drop for Clear<'_> {
        fn drop(&mut self) {
            clear_heartbeat(self.0, self.1, self.2);
        }
    }
    let _clear = Clear(&id.work_dir, &me.name, me_pid);
    beat(io);

    // 門鈴：取得 bell_topic 後在背景連 Realtime，響了就叫醒主迴圈；沒有 anon 金鑰就只剩輪詢
    let wake = std::sync::Arc::new(tokio::sync::Notify::new());
    let bell_task = match id.anon.as_deref().and_then(|k| crate::bell::ws_url(&id.base_url, k)) {
        Some(url) => {
            let (rl2, w2) = (relay(&id, &me.name), wake.clone());
            Some(tokio::spawn(async move {
                let mut wait = 2000u64;
                let topic = loop {
                    match rl2.api("whoami", None).await {
                        Ok(v) => match v.get("bell_topic").and_then(Value::as_str) {
                            Some(t) => break t.to_string(),
                            None => tokio::time::sleep(Duration::from_secs(10)).await,
                        },
                        Err(_) => {
                            tokio::time::sleep(Duration::from_millis(wait)).await;
                            wait = (wait * 2).min(30_000);
                        }
                    }
                };
                crate::bell::run(url, topic, move |_| w2.notify_one()).await;
            }))
        }
        None => None,
    };
    log(io, &format!("watching node={} window={}", id.node, me.name));

    let every = |ms: u64| {
        let mut i = tokio::time::interval(Duration::from_millis(ms.max(10)));
        i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        i
    };
    let (mut hb_t, mut gone_t, mut poll_t) = (every(env.heartbeat_ms), every(env.window_check_ms), every(env.poll_ms));
    hb_t.tick().await;
    gone_t.tick().await;
    poll_t.tick().await;
    // 收信失敗的短退避重試：5s→10s→20s→40s→60s（上限），成功後重置
    let steps = if env.backoff_ms.is_empty() { super::env::DEFAULT_BACKOFF_MS.to_vec() } else { env.backoff_ms.clone() };
    let mut fail_step = 0usize;
    let mut retry_at: Option<tokio::time::Instant> = None;
    let mut why = "startup";
    let code = loop {
        // 拉一次（why 非空才拉）
        if !why.is_empty() {
            match pull_once!().await {
                Ok(_) => {
                    fail_step = 0;
                    retry_at = None;
                }
                Err(e) => {
                    log(io, &format!("pull failed ({why}): {e}"));
                    let d = steps[fail_step.min(steps.len() - 1)];
                    fail_step = (fail_step + 1).min(steps.len() - 1);
                    retry_at = Some(tokio::time::Instant::now() + Duration::from_millis(d));
                }
            }
            why = "";
        }
        let retry = async {
            match retry_at {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = hb_t.tick() => beat(io),
            _ = gone_t.tick() => {
                if !(env.alive)(me.pid) {
                    log(io, "window gone: exit");
                    break 0;
                }
            }
            _ = poll_t.tick() => why = "poll",
            _ = wake.notified() => why = "bell",
            _ = retry => why = "retry",
            _ = tokio::signal::ctrl_c() => break 0,
        }
    };
    if let Some(t) = bell_task {
        t.abort();
    }
    Ok(code)
}
