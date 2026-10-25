//! pi 引擎（#135 第二期）：把「裝了 ASN 擴充的互動 pi」變成名單上可收信的視窗。
//! 對應 relay/pi-extension/（inbox.mjs 是另一半，檔案約定兩邊一致）。
//!
//! - 名單：讀 `~/.asn/pi-windows/<sessionId>.json`（擴充每 60 秒寫一次心跳）。只收：檔名＝sessionId、檔案不大、
//!   `at` 在有效期內、pid 還活著；名字重複的後面加 `-pid`，免得一個名字對到兩個收件者。
//! - 投遞：把信（橋已組好的全文，含信頭與內文跳脫）原子寫成 `~/.asn/pi-inbox/<sessionId>/<信件編號>.json`，
//!   寫成功就回報「已轉交」；擴充注入對話後把檔移到 done/。同編號重投是覆蓋，不會變兩封。
//! - 不開任何子程序、不碰金鑰；回信由 pi 自己用 asn_send（reply_to 帶編號）寄，核心照 Claude 視窗的方式認直接回覆。
use super::{BoxFut, Engine, EngineCtx, EngineEvent};
use crate::bridge::roster::{valid_sid, Window};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 視窗登記檔多久內算有效（擴充每 60 秒寫一次；5 分鐘沒更新＝擴充停了或 pi 卡死）
pub const WINDOW_MAX_AGE_MS: u64 = 5 * 60 * 1000;
const WINDOW_MAX_BYTES: u64 = 16 * 1024;
const NAME_MAX_CHARS: usize = 40;
/// 單封信內文上限（超過直接拒收，留在信箱）
pub const MAIL_MAX_BYTES: usize = 256 * 1024;
/// 一個視窗收件匣最多積幾封未處理（pi 沒在處理時不無限堆）
pub const INBOX_MAX_PENDING: usize = 200;
/// 離線視窗的收件匣保留多久（毫秒）
const SPOOL_KEEP_MS: u64 = 7 * 24 * 3600 * 1000;
/// 登記檔的 pid 已死多久後清掉（毫秒）
const DEAD_WINDOW_KEEP_MS: u64 = 24 * 3600 * 1000;

pub fn windows_dir(home: &Path) -> PathBuf {
    home.join(".asn").join("pi-windows")
}
pub fn inbox_dir(home: &Path) -> PathBuf {
    home.join(".asn").join("pi-inbox")
}

fn clean_name(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_control() { ' ' } else if c == '/' || c == '\\' { '-' } else { c }).collect();
    t.trim().chars().take(NAME_MAX_CHARS).collect::<String>().trim().to_string()
}

/// 一個登記檔 → 視窗；不合格回 None
fn parse_window(path: &Path, stem: &str, now_ms: u64, alive: &impl Fn(u32) -> bool) -> Option<Window> {
    if std::fs::metadata(path).ok()?.len() > WINDOW_MAX_BYTES {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    if v.get("sessionId").and_then(Value::as_str) != Some(stem) || v.get("engine").and_then(Value::as_str) != Some("pi") {
        return None;
    }
    let at = v.get("at").and_then(Value::as_u64)?;
    if now_ms.abs_diff(at) > WINDOW_MAX_AGE_MS {
        return None;
    }
    let pid = u32::try_from(v.get("pid").and_then(Value::as_u64)?).ok().filter(|p| *p != 0)?;
    if !alive(pid) {
        return None;
    }
    let name = clean_name(v.get("name").and_then(Value::as_str)?);
    if name.is_empty() {
        return None;
    }
    let status = if v.get("state").and_then(Value::as_str) == Some("busy") { "busy" } else { "idle" };
    let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("");
    Some(Window {
        name,
        status: Some(status.into()),
        cwd: cwd.into(),
        pid,
        updated_at: at,
        session_id: Some(stem.to_string()),
        engine: "pi".into(),
        engine_label: None,
        no_fallback: false,
        cwd_label_override: None,
        detail: None,
        context_pct: None,
        mod_loaded: true,
        model: model_label(&v),
        hidden: None,
    })
}

/// 登記檔的 provider 與 model 合成「提供者/模型」（名單 model 最長 60 字；太長就只留模型）。沒有 model 就是 None
fn model_label(v: &Value) -> Option<String> {
    let clean = |k: &str| v.get(k).and_then(Value::as_str).map(|s| s.trim().chars().filter(|c| !c.is_control()).collect::<String>()).filter(|s| !s.is_empty());
    let model = clean("model")?;
    Some(match clean("provider") {
        Some(p) if p.chars().count() + 1 + model.chars().count() <= 60 => format!("{p}/{model}"),
        _ => model.chars().take(60).collect(),
    })
}

/// 讀所有有效的 pi 視窗。資料夾不存在＝沒有；名字重複的（依 sessionId 排序，先到先得）後者改名「名字-pid」
pub fn read_windows(dir: &Path, now_ms: u64, alive: impl Fn(u32) -> bool) -> Vec<Window> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<Window> = vec![];
    for e in rd.flatten() {
        let fname = e.file_name().to_string_lossy().to_string();
        let Some(stem) = fname.strip_suffix(".json") else { continue };
        if !valid_sid(stem) {
            continue;
        }
        if let Some(w) = parse_window(&e.path(), stem, now_ms, &alive) {
            out.push(w);
        }
    }
    out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    let mut taken: Vec<String> = vec![];
    for w in out.iter_mut() {
        if taken.contains(&w.name) {
            let renamed = clean_name(&format!("{}-{}", w.name, w.pid));
            w.name = renamed;
        }
        taken.push(w.name.clone());
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.pid.cmp(&b.pid)));
    out
}

/// 信件編號當檔名用：只收一般字元
fn valid_mail_id(id: &str) -> bool {
    valid_sid(id)
}

/// 投遞一封信到某個視窗的收件匣（原子寫入）。信件編號相同就覆蓋（去重）；已在 done/ 的視為已處理，直接成功不再寫
pub fn write_inbox(home: &Path, sid: &str, id: &str, to: &str, text: &str, now_ms: u64) -> Result<(), String> {
    if !valid_sid(sid) || !valid_mail_id(id) {
        return Err("視窗或信件編號不合法".into());
    }
    if text.len() > MAIL_MAX_BYTES {
        return Err("信太大，pi 收件匣不收".into());
    }
    let dir = inbox_dir(home).join(sid);
    if dir.join("done").join(format!("{id}.json")).exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("建立收件匣失敗：{e}"))?;
    let pending = std::fs::read_dir(&dir).map(|r| r.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".json")).count()).unwrap_or(0);
    let target = dir.join(format!("{id}.json"));
    if pending >= INBOX_MAX_PENDING && !target.exists() {
        return Err(format!("pi 收件匣已積 {pending} 封未處理"));
    }
    let body = json!({ "v": 1, "id": id, "to": to, "text": text, "at": now_ms }).to_string();
    let tmp = dir.join(format!("{id}.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| format!("寫入收件匣失敗：{e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("寫入收件匣失敗：{e}")
    })
}

/// 順手清理：登記檔 pid 已死且超過一天沒更新的刪掉；沒有對應登記檔、超過 7 天沒動的收件匣整個刪掉。回傳刪了幾項
pub fn cleanup(home: &Path, now_ms: u64, alive: impl Fn(u32) -> bool) -> usize {
    let (wd, ib) = (windows_dir(home), inbox_dir(home));
    let mut n = 0;
    let mut live: Vec<String> = vec![];
    if let Ok(rd) = std::fs::read_dir(&wd) {
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            let Some(stem) = fname.strip_suffix(".json") else { continue };
            if !valid_sid(stem) {
                continue;
            }
            let v: Option<Value> = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok());
            let (at, pid) = v.as_ref().map(|v| (v.get("at").and_then(Value::as_u64).unwrap_or(0), v.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32)).unwrap_or((0, 0));
            if v.is_some() && (alive(pid) || now_ms.saturating_sub(at) <= DEAD_WINDOW_KEEP_MS) {
                live.push(stem.to_string());
            } else if v.is_some() && std::fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(&ib) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !valid_sid(&name) || live.contains(&name) || !e.path().is_dir() {
                continue;
            }
            let age = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            if age > SPOOL_KEEP_MS && std::fs::remove_dir_all(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

pub struct PiEngine {
    ctx: EngineCtx,
    home: PathBuf,
}

impl PiEngine {
    pub fn new(ctx: EngineCtx) -> PiEngine {
        let home = ctx.home.clone();
        PiEngine { ctx, home }
    }
    fn now() -> u64 {
        crate::heartbeat::now_ms()
    }
}

impl Engine for PiEngine {
    fn id(&self) -> &'static str {
        "pi"
    }
    fn start(&self) {}
    fn stop(&self) {}
    fn list(&self) -> BoxFut<'_, Option<Vec<Window>>> {
        let home = self.home.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let now = PiEngine::now();
                cleanup(&home, now, crate::heartbeat::pid_alive);
                read_windows(&windows_dir(&home), now, crate::heartbeat::pid_alive)
            })
            .await
            .ok()
        })
    }
    /// 同步寫進收件匣；寫成功就回報已轉交（核心才 ack 並開始等回信）。窗口不在線或寫入失敗＝信留在信箱
    fn deliver(&self, id: &str, to: &str, text: &str) -> Result<(), String> {
        let now = PiEngine::now();
        let ws = read_windows(&windows_dir(&self.home), now, crate::heartbeat::pid_alive);
        let w = ws.iter().find(|w| w.name == to).ok_or_else(|| format!("pi 視窗「{to}」不在線"))?;
        let sid = w.session_id.clone().ok_or("pi 視窗沒有 session 編號")?;
        write_inbox(&self.home, &sid, id, to, text, now)?;
        self.ctx.log(format!("pi: mail id={id} spooled for {to}"));
        let _ = self.ctx.events.send(EngineEvent::Sent(id.to_string()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn put_window(home: &Path, sid: &str, name: &str, pid: u32, state: &str, at: u64) {
        let d = windows_dir(home);
        std::fs::create_dir_all(&d).unwrap();
        let v = json!({ "v": 1, "engine": "pi", "sessionId": sid, "name": name, "pid": pid, "cwd": "D:/g/x", "state": state, "at": at });
        std::fs::write(d.join(format!("{sid}.json")), v.to_string()).unwrap();
    }
    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    const ID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn 名單_登記檔的_provider_加_model_合成提供者斜線模型_放進_model() {
        let h = home();
        let d = windows_dir(h.path());
        std::fs::create_dir_all(&d).unwrap();
        let w = |sid: &str, extra: serde_json::Value| {
            let mut v = json!({ "v": 1, "engine": "pi", "sessionId": sid, "name": sid, "pid": 7, "cwd": "D:/g/x", "state": "idle", "at": NOW });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            std::fs::write(d.join(format!("{sid}.json")), v.to_string()).unwrap();
        };
        let s = |n: u8| format!("{n:08}-1111-4111-8111-111111111111");
        w(&s(1), json!({ "model": "claude-sonnet-4", "provider": "anthropic" }));
        w(&s(2), json!({ "model": "gpt-5" }));
        w(&s(3), json!({ "model": "m".repeat(70), "provider": "p" }));
        w(&s(4), json!({}));
        let ws = read_windows(&windows_dir(h.path()), NOW, |_| true);
        let by = |sid: String| ws.iter().find(|x| x.session_id.as_deref() == Some(sid.as_str())).unwrap().model.clone();
        assert_eq!(by(s(1)).as_deref(), Some("anthropic/claude-sonnet-4"));
        assert_eq!(by(s(2)).as_deref(), Some("gpt-5"), "沒有提供者就只放模型");
        assert_eq!(by(s(3)).unwrap().chars().count(), 60, "太長就只留模型並截到 60 字");
        assert_eq!(by(s(4)), None, "沒有模型就不帶");
    }

    #[test]
    fn 名單_有效的登記檔變成_pi_視窗_忙碌閒置照狀態() {
        let h = home();
        put_window(h.path(), "s1", "pi-a", 100, "idle", NOW - 1000);
        put_window(h.path(), "s2", "pi-b", 200, "busy", NOW);
        let ws = read_windows(&windows_dir(h.path()), NOW, |_| true);
        assert_eq!(ws.len(), 2);
        assert_eq!((ws[0].name.as_str(), ws[0].engine.as_str(), ws[0].status.as_deref(), ws[0].pid), ("pi-a", "pi", Some("idle"), 100));
        assert_eq!(ws[1].status.as_deref(), Some("busy"));
        assert_eq!(ws[0].session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn 名單_過期_程序已死_壞檔_檔名不符_引擎不符_一律不收() {
        let h = home();
        put_window(h.path(), "old", "pi-old", 1, "idle", NOW - WINDOW_MAX_AGE_MS - 1);
        put_window(h.path(), "dead", "pi-dead", 2, "idle", NOW);
        put_window(h.path(), "ok", "pi-ok", 3, "idle", NOW);
        let d = windows_dir(h.path());
        std::fs::write(d.join("bad.json"), "{壞").unwrap();
        std::fs::write(d.join("liar.json"), json!({"engine":"pi","sessionId":"other","name":"x","pid":3,"at":NOW}).to_string()).unwrap();
        std::fs::write(d.join("claude.json"), json!({"engine":"claude","sessionId":"claude","name":"x","pid":3,"at":NOW}).to_string()).unwrap();
        std::fs::write(d.join("big.json"), "x".repeat(20 * 1024)).unwrap();
        let ws = read_windows(&d, NOW, |p| p != 2);
        assert_eq!(ws.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["pi-ok"]);
        assert!(read_windows(&h.path().join("nope"), NOW, |_| true).is_empty(), "資料夾不存在＝沒有視窗");
    }

    #[test]
    fn 名單_名字重複的後者加_pid_不會一名對兩人() {
        let h = home();
        put_window(h.path(), "a", "同名", 10, "idle", NOW);
        put_window(h.path(), "b", "同名", 20, "idle", NOW);
        put_window(h.path(), "c", "含/斜線\n", 30, "idle", NOW);
        let ws = read_windows(&windows_dir(h.path()), NOW, |_| true);
        let names: Vec<&str> = ws.iter().map(|w| w.name.as_str()).collect();
        assert!(names.contains(&"同名") && names.contains(&"同名-20"), "{names:?}");
        assert!(names.contains(&"含-斜線"), "{names:?}");
    }

    #[test]
    fn 投遞_原子寫入收件檔_內容完整_同編號覆蓋不變兩封() {
        let h = home();
        write_inbox(h.path(), "s1", ID, "pi-a", "[RELAY 來信] id=1\n內文", NOW).unwrap();
        write_inbox(h.path(), "s1", ID, "pi-a", "[RELAY 來信] id=1\n內文v2", NOW + 1).unwrap();
        let dir = inbox_dir(h.path()).join("s1");
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec![format!("{ID}.json")], "沒有暫存檔殘留、沒有重複");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{ID}.json"))).unwrap()).unwrap();
        assert_eq!((v["id"].as_str(), v["to"].as_str(), v["text"].as_str(), v["v"].as_u64()), (Some(ID), Some("pi-a"), Some("[RELAY 來信] id=1\n內文v2"), Some(1)));
    }

    #[test]
    fn 投遞_已處理過done的編號不再寫_壞編號_過大_積壓過多都拒絕() {
        let h = home();
        let done = inbox_dir(h.path()).join("s1").join("done");
        std::fs::create_dir_all(&done).unwrap();
        std::fs::write(done.join(format!("{ID}.json")), "{}").unwrap();
        write_inbox(h.path(), "s1", ID, "pi-a", "x", NOW).unwrap();
        assert!(!inbox_dir(h.path()).join("s1").join(format!("{ID}.json")).exists(), "已處理過的不重寫");
        assert!(write_inbox(h.path(), "../s", ID, "p", "x", NOW).is_err());
        assert!(write_inbox(h.path(), "s1", "../x", "p", "x", NOW).is_err());
        assert!(write_inbox(h.path(), "s1", "a.b", "p", "x", NOW).is_err());
        assert!(write_inbox(h.path(), "s1", "big", "p", &"x".repeat(MAIL_MAX_BYTES + 1), NOW).is_err());
        for i in 0..INBOX_MAX_PENDING {
            write_inbox(h.path(), "s2", &format!("m{i}"), "p", "x", NOW).unwrap();
        }
        assert!(write_inbox(h.path(), "s2", "extra", "p", "x", NOW).is_err(), "積壓過多拒收");
        write_inbox(h.path(), "s2", "m0", "p", "改寫", NOW).unwrap(); // 已存在的編號仍可覆蓋
    }

    #[test]
    fn 清理_死掉超過一天的登記檔與沒人用的舊收件匣被刪_活的不動() {
        let h = home();
        put_window(h.path(), "live", "pi-live", 1, "idle", NOW);
        put_window(h.path(), "deadold", "pi-x", 2, "idle", NOW - DEAD_WINDOW_KEEP_MS - 1);
        put_window(h.path(), "deadnew", "pi-y", 2, "idle", NOW - 1000);
        write_inbox(h.path(), "live", ID, "p", "x", NOW).unwrap();
        write_inbox(h.path(), "orphan", ID, "p", "x", NOW).unwrap();
        // 孤兒收件匣不夠舊：不刪
        assert_eq!(cleanup(h.path(), NOW, |p| p == 1), 1, "只刪 deadold");
        assert!(windows_dir(h.path()).join("live.json").exists() && windows_dir(h.path()).join("deadnew.json").exists());
        assert!(!windows_dir(h.path()).join("deadold.json").exists());
        assert!(inbox_dir(h.path()).join("orphan").exists(), "新的孤兒收件匣先留著");
    }
}
