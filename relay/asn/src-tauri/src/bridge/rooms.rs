//! 群組（rooms）轉送的純邏輯：對應 relay/machine/rooms.mjs。
//! 流程：room_list → 對每個 mine 項目用本地游標 room_read(since) → 只處理後端標 for_me=true 的訊息 → 推進游標。
//! 游標存 `<工作資料夾>/rooms-cursor.json`（鍵「房號|成員key」，與 Node 橋同格式），不用 mark、不動後端已讀位置。
//! 取訊息與轉交的流程在 core.rs（需要名單、對應表、worker）；這裡只放格式、游標與確定性編號。
use super::attach::body_with_notes;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const ROOM_HINT: &str = "（群組訊息；只有被點名或主人／希緒發問才需要回，回覆會經收發室貼回群組；不需要回就不要回）";
/// 轉交點名訊息時附的上下文：前面最近幾則
pub const CONTEXT_COUNT: usize = 5;

/// 回覆含「（不需回覆）」或「[no-reply]」（不分大小寫）＝不貼回群組
pub fn is_no_reply(text: &str) -> bool {
    text.contains("（不需回覆）") || text.to_lowercase().contains("[no-reply]")
}

/// 成員 key：節點本身 `H`、視窗 `H~H-主線-3`。回傳視窗名；節點本身是空字串
pub fn member_window(key: &str) -> String {
    match key.find('~') {
        Some(i) => key[i + 1..].to_string(),
        None => String::new(),
    }
}

pub fn display_from(from: &str) -> String {
    if from == "~owner" {
        return "主人".into();
    }
    from.replace('~', "/")
}

fn num_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

pub fn room_header(room_name: &str, msg: &Value) -> String {
    let trust = msg.get("trust").and_then(Value::as_str).unwrap_or("");
    let from = msg.get("from").and_then(Value::as_str).unwrap_or("");
    format!("[群組 {room_name}] trust={trust} from={} #{}", display_from(from), num_text(msg.get("seq")))
}

/// 轉交給視窗的群組訊息文字（標頭、提示、內文＋附件提示行）
pub fn room_text(room_name: &str, msg: &Value, attach_cmd: Option<&str>) -> String {
    let body = msg.get("body").and_then(Value::as_str).unwrap_or("");
    format!("{}\n{}\n{}", room_header(room_name, msg), ROOM_HINT, body_with_notes(body, msg.get("attachments"), attach_cmd))
}

/// 上下文：前面最近幾則（舊→新，每則一行、過長截斷）＋怎麼往回翻（room_cmd＝asn room 的指令前綴，沒有就改成請到 ASN 看）
pub fn context_text(room_id: &str, prev: &[Value], room_cmd: Option<&str>) -> String {
    let line = |m: &Value| {
        let who = m.get("from_name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| display_from(m.get("from").and_then(Value::as_str).unwrap_or("")));
        let body: String = m.get("body").and_then(Value::as_str).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect();
        format!("#{} {}：{}", num_text(m.get("seq")), who, body)
    };
    let head = if prev.is_empty() { String::new() } else { format!("---- 前面 {} 則（舊→新）----\n{}\n", prev.len(), prev.iter().map(line).collect::<Vec<_>>().join("\n")) };
    match room_cmd {
        Some(c) => format!("{head}（要看更多：{c} --room-read {room_id} --last 20）"),
        None => format!("{head}（要看更多：請到 ASN 的群組查看）"),
    }
}

/// 確定性 UUID：sha1('room:房號:seq:成員key') 取前 16 bytes 的十六進位
pub fn room_uuid(room_id: &str, seq: u64, member: &str) -> String {
    let h: String = Sha1::digest(format!("room:{room_id}:{seq}:{member}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

// ---- 游標 ---------------------------------------------------------------------------------------------

pub struct Cursors {
    file: PathBuf,
    map: BTreeMap<String, u64>,
}

impl Cursors {
    pub fn load(work_dir: &Path) -> Cursors {
        let file = work_dir.join("rooms-cursor.json");
        let map = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)).map(|n| (k.clone(), n))).collect()))
            .unwrap_or_default();
        Cursors { file, map }
    }
    pub fn key(room: &str, member: &str) -> String {
        format!("{room}|{member}")
    }
    pub fn get(&self, key: &str) -> Option<u64> {
        self.map.get(key).copied()
    }
    /// 設定並存檔；存檔失敗回錯誤字串（呼叫端記 log）
    pub fn set(&mut self, key: &str, v: u64) -> Result<(), String> {
        self.map.insert(key.to_string(), v);
        let text = serde_json::to_string(&self.map).map_err(|e| e.to_string())?;
        crate::write_atomic(&self.file, &text).map_err(|e| e.to_string())
    }
    #[cfg(test)]
    pub fn all(&self) -> &BTreeMap<String, u64> {
        &self.map
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 成員_key_拆視窗名_顯示名稱() {
        assert_eq!(member_window("T"), "");
        assert_eq!(member_window("T~T-視窗甲"), "T-視窗甲");
        assert_eq!(display_from("~owner"), "主人");
        assert_eq!(display_from("W~W-政策"), "W/W-政策");
    }

    #[test]
    fn 不需回覆標記_不分大小寫() {
        assert!(is_no_reply("好的（不需回覆）") && is_no_reply("ok [No-Reply]"));
        assert!(!is_no_reply("需要回覆"));
    }

    #[test]
    fn 標頭_提示_內文_與_node_橋的文字一致() {
        let msg = json!({"seq": 3, "from": "W~W-政策", "trust": "member", "body": "群組內文-3"});
        assert_eq!(room_text("專案群", &msg, None), format!("[群組 專案群] trust=member from=W/W-政策 #3\n{ROOM_HINT}\n群組內文-3"));
        let owner = json!({"seq": 4, "from": "~owner", "trust": "owner", "body": "x"});
        assert!(room_text("專案群", &owner, None).starts_with("[群組 專案群] trust=owner from=主人 #4\n"));
    }

    #[test]
    fn 上下文_舊到新_截斷_指令前綴() {
        let prev = vec![json!({"seq": 2, "from": "W~W-政策", "from_name": "政策", "body": "群組內文-2"}), json!({"seq": 3, "from": "~owner", "body": format!("a\n  b {}", "字".repeat(400))})];
        let t = context_text("R1", &prev, Some("/x/asn-cli room"));
        let lines: Vec<&str> = t.lines().collect();
        assert_eq!(lines[0], "---- 前面 2 則（舊→新）----");
        assert_eq!(lines[1], "#2 政策：群組內文-2");
        assert!(lines[2].starts_with("#3 主人：a b 字") && lines[2].chars().count() <= "#3 主人：".chars().count() + 300);
        assert_eq!(lines[3], "（要看更多：/x/asn-cli room --room-read R1 --last 20）");
        assert_eq!(context_text("R1", &[], None), "（要看更多：請到 ASN 的群組查看）");
    }

    #[test]
    fn 確定性編號_與_node_的_room_uuid_相同() {
        // 向量由 Node 的 roomUuid 算出（relay/machine/rooms.mjs）
        assert_eq!(room_uuid("R1", 4, "T"), "b9b2ac80-b796-bae6-8b0b-f70b8b3b01e4");
        assert_eq!(room_uuid("R1", 4, "T~T-視窗甲"), "42a79b48-f738-c144-659d-0c7967cbb524");
    }

    #[test]
    fn 游標_讀寫_壞檔當空() {
        let d = tempfile::tempdir().unwrap();
        let mut c = Cursors::load(d.path());
        assert!(c.all().is_empty());
        c.set("R1|T", 4).unwrap();
        assert_eq!(Cursors::load(d.path()).get("R1|T"), Some(4));
        std::fs::write(d.path().join("rooms-cursor.json"), "壞").unwrap();
        assert!(Cursors::load(d.path()).all().is_empty());
        std::fs::write(d.path().join("rooms-cursor.json"), r#"{"R1|T~x":2,"bad":"s"}"#).unwrap();
        assert_eq!(Cursors::load(d.path()).get("R1|T~x"), Some(2));
    }
}
