//! `asn send`：本機 Claude 視窗主動寄信給仲介成員／群組，不經收發室、不經任何模型（對應 relay/machine/send.mjs）。
//!   asn send --to XISU --body "內文" --reply|--no-reply [--reply-to <信件id>]
//!   asn send --to W/W-政策 --body-file msg.txt --no-reply
//!   asn send --room <群組id> --body "內文"
//!   asn send --to XISU --file 報告.pdf --file 截圖.webp --body "說明" --no-reply
//! 寄給成員／視窗（含回信）一定要明說要不要回信；結果以 expects_reply 欄位送給後端，不往內文加任何標記。
//! 寄件視窗名不能自填：沿父行程鏈找 ~/.claude/sessions 登記的 claude 程序（備援 CLAUDE_CODE_MESSAGING_SOCKET）。
//! 輸出 `sent id=…`（或 `posted room=… seq=…`）；錯誤印到 stderr，結束碼：1 用法／內容、2 認不出呼叫者、3 超量、4 後端錯誤。
//! 寄成功後在 ~/.asn/machine-<節點>/ 留記號給橋：`replied/<信件id>`（直接回信）、`sent/<sha1>`（曾寄給某節點／視窗）。
use super::caller::{backend, find_caller, identity, relay, whoami};
use super::env::Env;
use super::upload::{attachment_text, prepare_files, upload_items, MAX_FILES};
use super::{Fail, Io, R};
use crate::bridge::core::sent_mark_name;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const MAX_BODY: usize = 20000;

fn usage() -> String {
    format!(
        "用法：
  asn send --to <成員代號 | 節點/視窗名> --body \"<內文>\" (--reply | --no-reply) [--reply-to <信件id>]
  asn send --room <群組id> --body \"<內文>\"
  --reply | --no-reply  寄給成員／視窗（含回信 --reply-to）時二選一、一定要給，兩個不能同時給：
                     --reply＝我在等對方回信（收發室 10 分鐘沒收到回覆會提醒）；--no-reply＝只是告知，不用回、不會提醒。
                     結果以欄位送給後端，不會在內文加標記。--room 群組本來就不計時，給了會忽略（印一行說明）。
  --body-file <檔>   內文從檔案讀；--body -  內文從 stdin 讀
  --file <路徑>      附件，可重複，一封至多 {MAX_FILES} 個（--to、--room 都能用；內文可省略，只有附件時內文就是附件清單）。
                     照片只收已是 webp 的（5 MB；本程式不轉檔，png／jpg 請先轉 webp，或用 ASN 電腦版寄）；
                     一般檔案收 pdf、txt、md、json、csv、zip、docx、xlsx、pptx（25 MB），可執行檔、腳本一律擋。
                     檢查全在本機先做，任何一個不合格或上傳失敗都不寄信。收的人用 asn attach --id <編號> 下載。
  --whoami           不寄信，印出父行程鏈、session 對照、節點判定（除錯用）
同一台機器上的其他視窗（含 ASN）也可以寄（--to <本機節點>/<視窗名>）；不能寄給自己這個視窗。
內文至多 {MAX_BODY} 字。寄件人（視窗名）由本程式自動判定，不能自填；信任一律是 member。"
    )
}

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub to: Option<String>,
    pub room: Option<String>,
    pub body: Option<String>,
    pub body_file: Option<String>,
    pub reply_to: Option<String>,
    pub files: Vec<String>,
    pub reply: bool,
    pub no_reply: bool,
    pub whoami: bool,
    pub help: bool,
}

pub fn parse_args(argv: &[String]) -> R<Args> {
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        let mut need = || -> R<String> {
            i += 1;
            argv.get(i).cloned().ok_or_else(|| Fail::new(1, format!("{k} 缺少參數\n{}", usage())))
        };
        match k {
            "--to" => a.to = Some(need()?),
            "--room" => a.room = Some(need()?),
            "--body" => a.body = Some(need()?),
            "--body-file" => a.body_file = Some(need()?),
            "--reply-to" => a.reply_to = Some(need()?),
            "--file" => a.files.push(need()?),
            "--reply" => a.reply = true,
            "--no-reply" => a.no_reply = true,
            "--whoami" => a.whoami = true,
            "--help" | "-h" => a.help = true,
            _ => return Err(Fail::new(1, format!("不認得的參數 {k}\n{}", usage()))),
        }
        i += 1;
    }
    Ok(a)
}

/// 要不要回信：--to 一定要二選一；回傳（要送給後端的 expects_reply, 要印給呼叫者的一行說明）。
/// 群組（--room）不計時：旗標忽略（None、不送欄位）。兩個旗標互相矛盾一律報錯。
pub fn resolve_reply_flag(reply: bool, no_reply: bool, room: bool) -> R<(Option<bool>, String)> {
    if reply && no_reply {
        return Err(Fail::new(1, format!("--reply 與 --no-reply 不能同時給（一個說要等回信、一個說只是告知）\n{}", usage())));
    }
    if room {
        let note = if reply || no_reply { "群組訊息本來就不計時，--reply／--no-reply 不適用，已忽略" } else { "" };
        return Ok((None, note.to_string()));
    }
    if !reply && !no_reply {
        return Err(Fail::new(1, format!("請說明要不要回信：等對方回就加 --reply，只是告知就加 --no-reply\n{}", usage())));
    }
    Ok((Some(reply), String::new()))
}

fn is_uuid(s: &str) -> bool {
    crate::attach::is_uuid(s)
}

fn valid_id(s: &str) -> bool {
    crate::identity::valid_id(s)
}

/// 每視窗每小時上限，記在 ~/.asn/send-rate.json（暫存檔＋rename，避免寫壞）
fn take_rate(relay_home: &Path, window: &str, limit: usize, now: u64) -> R<()> {
    let file = relay_home.join("send-rate.json");
    let mut all: Map<String, Value> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let hour = 3_600_000u64;
    let mut cleaned = Map::new();
    for (k, v) in all.iter() {
        let kept: Vec<Value> = v.as_array().map(|a| a.iter().filter(|t| t.as_u64().map(|t| now.saturating_sub(t) < hour).unwrap_or(false)).cloned().collect()).unwrap_or_default();
        if !kept.is_empty() {
            cleaned.insert(k.clone(), Value::Array(kept));
        }
    }
    all = cleaned;
    let recent: Vec<u64> = all.get(window).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    if recent.len() >= limit {
        let wait = (recent[0] + hour - now).div_ceil(60_000);
        return Err(Fail::new(3, format!("被擋：視窗「{window}」每小時最多寄 {limit} 封，{wait} 分鐘後再試")));
    }
    let mut next = recent;
    next.push(now);
    all.insert(window.to_string(), json!(next));
    let _ = std::fs::create_dir_all(relay_home);
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string(&all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &file);
    }
    Ok(())
}

/// 視窗直接回信（--reply-to）後在本機留記號：機器橋看到就不再寄「10 分鐘內沒有收到回覆」
pub fn mark_replied(work_dir: &Path, mail_id: &str, now: u64) {
    let d = work_dir.join("replied");
    if std::fs::create_dir_all(&d).is_ok() {
        let _ = std::fs::write(d.join(mail_id), now.to_string());
    }
}

/// 每次寄給某節點／視窗也留記號：橋計時到時，若收件視窗在轉交後曾寄信給原寄件人，就不再寄「沒有回覆」
pub fn mark_sent(work_dir: &Path, from: &str, to_node: &str, to_agent: &str, now: u64) {
    let d = work_dir.join("sent");
    if std::fs::create_dir_all(&d).is_ok() {
        let _ = std::fs::write(d.join(sent_mark_name(from, to_node, to_agent)), now.to_string());
    }
}

fn read_stdin(io: &mut Io) -> String {
    let mut buf = vec![];
    let _ = io.stdin.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let a = parse_args(argv)?;
    if a.help {
        io.outln(&usage());
        return Ok(0);
    }
    if a.whoami {
        whoami(env, io);
        return Ok(0);
    }
    if a.to.is_some() == a.room.is_some() {
        return Err(Fail::new(1, format!("--to 與 --room 要二選一\n{}", usage())));
    }
    // 先檢查旗標，沒說就不讀內文、不寄
    let (expects_reply, note) = resolve_reply_flag(a.reply, a.no_reply, a.room.is_some())?;
    let mut body = match (&a.body_file, &a.body) {
        (Some(f), _) => std::fs::read_to_string(f).map_err(|e| Fail::new(1, format!("讀不到 --body-file {f}：{e}")))?,
        (None, Some(b)) if b == "-" => read_stdin(io),
        (None, Some(b)) => b.clone(),
        (None, None) => String::new(),
    };
    body = body.trim_end().to_string();
    if body.is_empty() && a.files.is_empty() {
        return Err(Fail::new(1, format!("內文是空的\n{}", usage())));
    }
    // 附件先在本機全部檢查完（不碰網路），不合格就不往下
    let items = if a.files.is_empty() { vec![] } else { prepare_files(&a.files)? };
    if !items.is_empty() {
        body = attachment_text(&items, &body);
    }
    let len = body.encode_utf16().count();
    if len > MAX_BODY {
        return Err(Fail::new(1, format!("內文 {len} 字，超過 {MAX_BODY} 字")));
    }
    if let Some(r) = &a.reply_to {
        if !is_uuid(r) {
            return Err(Fail::new(1, "--reply-to 要是信件 id（uuid）"));
        }
    }
    let (mut to_node, mut to_agent) = (String::new(), String::new());
    if let Some(to) = &a.to {
        match to.split_once('/') {
            Some((n, w)) => (to_node, to_agent) = (n.to_string(), w.to_string()),
            None => to_node = to.clone(),
        }
        if !valid_id(&to_node) && !crate::bridge::mail::is_person_alias(&to_node) {
            return Err(Fail::new(1, format!("--to {to} 的成員代號格式不對")));
        }
    }
    let id = identity(env, true)?;
    let me = find_caller(env, "寄信")?; // 先認人，再計次、再寄
    // 同節點可以寄（例如寄給本機的 ASN）：信經後端回到本機橋，照一般信轉交。只擋「寄給自己這個視窗」
    if to_node == id.node && to_agent == me.name {
        return Err(Fail::new(1, format!("收件人就是你自己（{}/{}）；不能寄給自己", id.node, me.name)));
    }
    let now = crate::heartbeat::now_ms();
    take_rate(&env.relay_home, &me.name, env.send_per_hour, now)?;
    let rl = relay(&id, &me.name);
    // 附件先傳完並確認；任何一個失敗就丟錯，下面不會寄信
    let attachment_ids = if items.is_empty() { None } else { Some(upload_items(&rl, &items).await?) };
    if let Some(room) = &a.room {
        let mut b = json!({ "room": room, "body": body, "from_agent": me.name });
        if let Some(ids) = &attachment_ids {
            b["attachment_ids"] = json!(ids);
        }
        let r = rl.api("room_post", Some(b)).await.map_err(backend)?;
        let seq = r.get("seq").and_then(Value::as_i64).map(|s| format!(" seq={s}")).unwrap_or_default();
        io.outln(&format!("posted room={room}{seq} from={}/{}", id.node, me.name));
    } else {
        let mut b = json!({ "to_node": to_node, "body": body, "from_agent": me.name, "expects_reply": expects_reply });
        if !to_agent.is_empty() {
            b["to_agent"] = json!(to_agent);
        }
        if let Some(r) = &a.reply_to {
            b["reply_to"] = json!(r);
        }
        if let Some(ids) = &attachment_ids {
            b["attachment_ids"] = json!(ids);
        }
        let r = rl.api("send", Some(b)).await.map_err(backend)?;
        if let Some(r) = &a.reply_to {
            mark_replied(&id.work_dir, r, now);
        }
        mark_sent(&id.work_dir, &me.name, &to_node, &to_agent, now);
        io.outln(&format!("sent id={} to={} from={}/{}", r.get("id").and_then(Value::as_str).unwrap_or("?"), a.to.as_deref().unwrap_or(""), id.node, me.name));
    }
    if !note.is_empty() {
        io.errln(&note);
    }
    Ok(0)
}
