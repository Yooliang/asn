//! `asn who`：列出同一個帳號底下所有夥伴的完整收件位址（節點/視窗名），寄信前不確定位址就先查（#320）。
//!   asn who [名字片段] [--json]
//! 每行：`H/asn西川  在線  家用機`（本機那台排最前、標「本機」）；離線的標「離線」，收不到信的標「只顯示」，
//! 背景運行（主控台視窗被隱藏，後端標 hidden）的標「背景運行」——照樣列出，跟電腦版名單一致（以前整列跳過，收得到信的夥伴反而查不到）。
//! 只讀後端名單（list），不讀任何信件內容；不需要認出呼叫視窗，所以 pi、無頭夥伴也能用。
use super::caller::{backend, identity, relay};
use super::env::Env;
use super::{Fail, Io, R};
use serde_json::{json, Value};

fn usage() -> &'static str {
    "用法：
  asn who [名字片段] [--json]
  列出所有夥伴的完整收件位址（節點/視窗名）、在不在線、在哪台電腦。寄信時 --to 照第一欄寫。
  名字片段：只列名字或位址含這段字的（不分大小寫）。--json：每位一個物件（address、node、name、online、device、receivable、background、here）。"
}

#[derive(Debug, Clone, PartialEq)]
pub struct WhoRow {
    pub address: String,
    pub node: String,
    pub name: String,
    pub online: bool,
    pub device: String,
    pub receivable: bool,
    pub background: bool,
    pub here: bool,
}

/// 後端 list 的 members → 一位夥伴一列。背景運行（hidden）的照列、另外標出；本機那台排最前，其餘依位址排。
pub fn who_rows(members: &Value, my_node: &str, filter: &str) -> Vec<WhoRow> {
    let want = filter.trim().to_lowercase();
    let mut rows = vec![];
    for m in members.as_array().into_iter().flatten() {
        let Some(node) = m.get("id").and_then(Value::as_str) else { continue };
        let device = m.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or(node).to_string();
        for (key, online) in [("agents", true), ("offline_agents", false)] {
            for ag in m.get(key).and_then(Value::as_array).into_iter().flatten() {
                let Some(name) = ag.get("name").and_then(Value::as_str) else { continue };
                let address = format!("{node}/{name}");
                if !want.is_empty() && !address.to_lowercase().contains(&want) && !device.to_lowercase().contains(&want) {
                    continue;
                }
                let receivable = ag.get("receivable").and_then(Value::as_bool) != Some(false);
                let background = ag.get("hidden").and_then(Value::as_bool) == Some(true);
                rows.push(WhoRow { address, node: node.to_string(), name: name.to_string(), online, device: device.clone(), receivable, background, here: node == my_node });
            }
        }
    }
    rows.sort_by(|a, b| b.here.cmp(&a.here).then_with(|| a.address.to_lowercase().cmp(&b.address.to_lowercase())));
    rows.dedup_by(|a, b| a.address == b.address);
    rows
}

pub fn who_line(r: &WhoRow) -> String {
    let mut tags = vec![if r.online { "在線" } else { "離線" }];
    if !r.receivable {
        tags.push("只顯示");
    }
    if r.background {
        tags.push("背景運行");
    }
    let here = if r.here { "（本機）" } else { "" };
    format!("{}\t{}\t{}{here}", r.address, tags.join("、"), r.device)
}

pub async fn main(argv: &[String], env: &Env, io: &mut Io<'_>) -> R<i32> {
    let (mut json_out, mut filter) = (false, String::new());
    for a in argv {
        match a.as_str() {
            "--help" | "-h" => {
                io.outln(usage());
                return Ok(0);
            }
            "--json" => json_out = true,
            s if s.starts_with("--") => return Err(Fail::new(1, format!("不認得的參數 {s}\n{}", usage()))),
            s if filter.is_empty() => filter = s.to_string(),
            s => return Err(Fail::new(1, format!("名字片段只能給一個（多了 {s}）\n{}", usage()))),
        }
    }
    let id = identity(env, true)?;
    let r = relay(&id, "").list().await.map_err(backend)?;
    let rows = who_rows(r.get("members").unwrap_or(&Value::Null), &id.node, &filter);
    if json_out {
        let v: Vec<Value> = rows
            .iter()
            .map(|r| json!({"address": r.address, "node": r.node, "name": r.name, "online": r.online, "device": r.device, "receivable": r.receivable, "background": r.background, "here": r.here}))
            .collect();
        io.outln(&Value::Array(v).to_string());
    } else if rows.is_empty() {
        io.outln(if filter.is_empty() { "名單是空的" } else { "沒有符合的夥伴" });
    } else {
        for r in &rows {
            io.outln(&who_line(r));
        }
    }
    Ok(0)
}
