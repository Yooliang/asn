//! 遠端管理 ACP 工作者（Gemini、agy 等收發室自己跑的背景工作者）的入口：給 bridge/partner_ops.rs 用。
//! 管詳情、重開、換班接手、關閉（停止本次執行，不改設定檔）、切換模型、移除、改名七件事；喚醒不支援（由呼叫端回「這類夥伴不支援」）。
//! 移除（0.2 B3）：只移除「開新夥伴」與接手開出來的（名冊裡有的）；寫在 agents.json 的回說明、不改檔。工作資料夾的檔案留著。
//! 改名（B5，#266）：同樣只改名冊裡有的；用新名字重建工作者、帶原本的對話重開（停幾秒），帳本／名冊／記下的模型搬到新名字，
//! 「舊名 → 新名」記 7 天（acp_renames.rs）。任何一步失敗就把改過的檔案改回去、用原名重開。
//! 切換模型：Grok（標準 ACP）用原生 session/set_model；agy 換模型後帶同一個對話重開。選好的記進 acp-models.json（見 acp_models.rs）。
//! 只認收發室記在案的工作者（agents.json 讀進來、已啟動的），而且只結束驅動回報的那個 pid。
use super::acp_config::WorkerCfg;
use super::acp_worker::admin::LoadState;
use super::acp_worker::{Store, WorkerHandle};
use super::{EngineEvent, EventTx};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 接手載入對話最多等這麼久（毫秒）：子程序冷啟動加 session/load
pub const ADOPT_WAIT_MS: u64 = 60_000;

pub trait AcpAdmin: Send + Sync {
    /// 名字對得上收發室管理的工作者嗎
    fn has_worker(&self, name: &str) -> bool;
    /// 詳情（欄位名與 Claude 視窗的詳情一致，另加 permissions、process_running、has_session、load_session）
    fn info(&self, name: &str) -> Option<Value>;
    /// 重開（保留對話）
    fn restart(&self, name: &str) -> Result<Value, String>;
    /// 關閉（停止本次執行）：結束子行程、不再收信、名單上暫時看不到；不改 agents.json。重開或重啟 ASN 恢復
    fn stop(&self, name: &str) -> Result<Value, String>;
    /// 切換模型（模型先比對可選清單；正在處理信件就拒絕，不排隊）
    fn set_model(&self, _name: &str, _model: &str) -> Result<Value, String> {
        Err("這台電腦的 ASN 還不能切換這類工作者的模型".into())
    }
    /// 移除這個夥伴：結束程序，從名冊與記下的模型刪掉；中途失敗就回報做到哪一步
    fn remove(&self, _name: &str) -> Result<Value, String> {
        Err("這台電腦的 ASN 還不能移除這類工作者".into())
    }
    /// 改名：對話與工作資料夾不變，用新名字重開；中途失敗就恢復原名
    fn rename(&self, _name: &str, _new_name: &str) -> Result<Value, String> {
        Err("這台電腦的 ASN 還不能替這類工作者改名".into())
    }
    /// 換班接手（清掉對話後重開，第一則提示是接班說明）
    fn handover(&self, name: &str, note: &str) -> Result<Value, String>;
    /// 接手：另開一個專屬的 Grok 工作者，載入指定的對話（session）。會等到載入成功或失敗才回；只動自己新開的工作者，不碰任何既有程序
    fn adopt(&self, _session_id: &str, _cwd: &str) -> Result<Value, String> {
        Err("沒有可以接手的 Grok 工作者設定".into())
    }
}

pub struct AcpAdminImpl {
    pub workers: Arc<Mutex<Vec<(String, WorkerHandle)>>>,
    /// 接手用：做工作者的函式、存對話編號的帳本、接手名冊檔、通知名單有變的通道、等載入的上限
    pub adopt: Option<AdoptEnv>,
    /// 切換模型後記下來的檔案（acp-models.json）
    pub models_file: PathBuf,
    /// 「開新夥伴」名冊（acp-partners.json）與接手名冊（acp-adopted.json）：移除時從這裡刪
    pub partners_file: PathBuf,
    pub adopted_file: PathBuf,
    /// 改名後的「舊名 → 新名」對照（acp-renames.json）
    pub renames_file: PathBuf,
    /// 名單有變時通知
    pub events: EventTx,
}

#[derive(Clone)]
pub struct AdoptEnv {
    pub make: Arc<dyn Fn(Arc<WorkerCfg>) -> WorkerHandle + Send + Sync>,
    pub store: Arc<Store>,
    pub file: PathBuf,
    pub events: EventTx,
    pub wait_ms: u64,
    /// 沒有現成的 Grok 工作者時，用「開新夥伴」的 grok 啟動設定（授權、白名單、執行檔檢查都照開新夥伴那條路）做接手的底；參數是要接手的資料夾
    pub base: Arc<dyn Fn(&str) -> Result<WorkerCfg, String> + Send + Sync>,
}

/// 接手名冊（重啟後把專屬工作者建回來）：[{name, session_id, cwd}]
pub fn read_adopted(file: &std::path::Path) -> Vec<(String, String, String)> {
    let Ok(t) = std::fs::read_to_string(file) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&t) else { return vec![] };
    v.get("adopted").and_then(Value::as_array).into_iter().flatten().filter_map(|e| {
        let g = |k: &str| e.get(k).and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty());
        Some((g("name")?, g("session_id")?, g("cwd")?))
    }).collect()
}

fn write_adopted(file: &std::path::Path, list: &[(String, String, String)]) -> std::io::Result<()> {
    let arr: Vec<Value> = list.iter().map(|(n, s, c)| json!({ "name": n, "session_id": s, "cwd": c })).collect();
    crate::write_atomic(file, &json!({ "version": 1, "adopted": arr }).to_string())
}

/// 接手名冊裡某一筆改名（對話編號與資料夾不變）
fn rename_adopted(file: &std::path::Path, from: &str, to: &str) -> Result<(), String> {
    let mut list = read_adopted(file);
    let e = list.iter_mut().find(|(n, _, _)| n == from).ok_or("接手名冊裡沒有這一筆")?;
    e.0 = to.to_string();
    write_adopted(file, &list).map_err(|e| format!("接手名冊寫不進去：{e}"))
}

/// 改名時新工作者的名字是從哪一份名冊來的（寫在 agents.json 的不能改名）
#[derive(Clone, Copy, PartialEq)]
enum Roster {
    Partners,
    Adopted,
}

/// 改名的一步做完後留下的「改回去」：(這一步叫什麼, 改回去的動作)。改回去失敗回原因，由 [`roll_back`] 記 log
type Undo = (&'static str, Box<dyn FnOnce() -> Result<(), String>>);

/// 改名的新名字不合格（20 字內；完整規則：英數、連字號、中文，1～40 字，不能以連字號開頭，畫面送出前也會先擋）
pub const BAD_NAME: &str = "名字只能用英數、中文、連字號";
/// 改名失敗、檔案都改回去了（細節在 log）
pub const RENAME_FAILED: &str = "改名失敗，已恢復原名";
/// 改名失敗，而且有檔案沒能改回去（細節在 log）
pub const RENAME_HALF: &str = "改名失敗，有檔案沒改回";

/// 倒著執行「改回去」；任何一步改回去失敗都記一筆（不吞掉），回「全部改回去了沒」
fn roll_back(undo: Vec<Undo>, note: &dyn Fn(String), from: &str, to: &str) -> bool {
    let mut all = true;
    for (what, u) in undo.into_iter().rev() {
        if let Err(e) = u() {
            all = false;
            note(format!("acp: 改名 {from} → {to} 失敗後還原失敗：{what}沒能改回去（{e}）"));
        }
    }
    all
}

impl AcpAdminImpl {
    fn find(&self, name: &str) -> Option<WorkerHandle> {
        self.workers.lock().unwrap().iter().find(|(n, _)| n == name).map(|(_, w)| w.clone())
    }

    /// 改名前的檢查（握著工作者清單時呼叫，什麼都不動）：回 (在清單裡的位置, 從哪份名冊來)
    fn rename_check(&self, ws: &[(String, WorkerHandle)], name: &str, new_name: &str) -> Result<(usize, Roster), String> {
        if !crate::launch::config::valid_partner_name(new_name) {
            return Err(BAD_NAME.into());
        }
        if new_name.eq_ignore_ascii_case(name) {
            return Err("新名字和現在的一樣".into());
        }
        let i = ws.iter().position(|(n, _)| n == name).ok_or("找不到這個工作者")?;
        let partners = super::partner_queue::read_partners(&self.partners_file);
        let adopted = read_adopted(&self.adopted_file);
        // 這台電腦上的內建通道工作者，含名冊裡有但這次沒開起來的，名字不分大小寫都不能撞
        let same = |n: &str| n.eq_ignore_ascii_case(new_name);
        if ws.iter().any(|(n, _)| same(n)) || partners.iter().any(|(n, _, _)| same(n)) || adopted.iter().any(|(n, _, _)| same(n)) {
            return Err("已有同名的夥伴，換個名字".into());
        }
        let roster = if partners.iter().any(|(n, _, _)| n.eq_ignore_ascii_case(name)) {
            Roster::Partners
        } else if adopted.iter().any(|(n, _, _)| n == name) {
            Roster::Adopted
        } else {
            return Err("設定檔裡的名字，請改設定檔".into());
        };
        let w = &ws[i].1;
        if w.admin_stopped() {
            return Err("已停止，請先重開".into());
        }
        // 沒有對話編號的改名，後台會當成新夥伴（夥伴身分接不上），所以先擋
        if !super::acp::roster_session_ok(&w.session_id()) {
            return Err("還沒有對話，請先寄一封信給它".into());
        }
        Ok((i, roster))
    }

    /// 改名的檔案搬移：帳本 → 名冊（或接手名冊）→ 記下的模型 → 舊名對照。每一步成功就記一個「改回去」；
    /// 哪一步失敗就把前面做過的反向改回去，回簡短說明（20 字內，細節記 log）；改回去也失敗的記「還原失敗」，說明改成「有檔案沒改回」
    fn move_files(&self, store: &Arc<Store>, roster: Roster, name: &str, new_name: &str) -> Result<(), String> {
        let mut undo: Vec<Undo> = vec![];
        let (from, to) = (name.to_string(), new_name.to_string());
        let fail = |what: &str, e: String| {
            store.note(format!("acp: 改名 {from} → {to}：{what}（{e}）"));
            what.to_string()
        };
        let r = (|| -> Result<(), String> {
            store.rename(&from, &to).map_err(|e| fail("對話帳本改不了", e))?;
            let (s, a, b) = (store.clone(), to.clone(), from.clone());
            undo.push(("對話帳本", Box::new(move || s.rename(&a, &b))));
            let (file, a, b) = match roster {
                Roster::Partners => {
                    super::partner_queue::rename(&self.partners_file, &from, &to).map_err(|e| fail("名冊寫不進去", e))?;
                    (self.partners_file.clone(), to.clone(), from.clone())
                }
                Roster::Adopted => {
                    rename_adopted(&self.adopted_file, &from, &to).map_err(|e| fail("接手名冊寫不進去", e))?;
                    (self.adopted_file.clone(), to.clone(), from.clone())
                }
            };
            let label = if roster == Roster::Partners { "名冊" } else { "接手名冊" };
            undo.push((label, Box::new(move || if roster == Roster::Partners { super::partner_queue::rename(&file, &a, &b) } else { rename_adopted(&file, &a, &b) })));
            super::acp_models::rename(&self.models_file, &from, &to).map_err(|e| fail("記下的模型寫不進去", e))?;
            let (file, a, b) = (self.models_file.clone(), to.clone(), from.clone());
            undo.push(("記下的模型", Box::new(move || super::acp_models::rename(&file, &a, &b))));
            // 最後一步：寫不進去時檔案原樣（原子寫入），不用另外改回去
            super::acp_renames::record(&self.renames_file, &from, &to, crate::heartbeat::now_ms()).map_err(|e| fail("舊名對照寫不進去", e))?;
            Ok(())
        })();
        match r {
            Ok(()) => Ok(()),
            Err(_) if roll_back(undo, &|m| store.note(m), name, new_name) => Err(RENAME_FAILED.into()),
            Err(_) => Err(RENAME_HALF.into()),
        }
    }
}

impl AcpAdmin for AcpAdminImpl {
    fn has_worker(&self, name: &str) -> bool {
        self.find(name).is_some()
    }

    fn info(&self, name: &str) -> Option<Value> {
        let s = self.find(name)?.snapshot();
        let model = Some(s.model.trim()).filter(|m| !m.is_empty());
        let [r, w, e, n] = s.permissions;
        Some(json!({
            "pid": s.pid,
            "model": model,
            "engine": s.engine_label,
            "cwd": s.cwd,
            "status": s.status,
            "kind": "acp",
            "protocol": s.protocol,
            "permissions": { r.0: r.1, w.0: w.1, e.0: e.1, n.0: n.1 },
            "process_running": s.process_running,
            "has_session": s.has_session,
            "load_session": s.load_session,
        }))
    }

    fn restart(&self, name: &str) -> Result<Value, String> {
        let w = self.find(name).ok_or("找不到這個工作者")?;
        let pid = w.admin_restart()?;
        Ok(json!({ "kind": "acp", "pid": pid, "kept_session": w.snapshot().has_session }))
    }

    fn stop(&self, name: &str) -> Result<Value, String> {
        let w = self.find(name).ok_or("找不到這個工作者")?;
        let pid = w.admin_stop()?;
        Ok(json!({ "kind": "acp", "pid": pid, "stopped": true }))
    }

    fn set_model(&self, name: &str, model: &str) -> Result<Value, String> {
        let w = self.find(name).ok_or("找不到這個工作者")?;
        let (pid, restarted, saved) = w.admin_set_model(model, &self.models_file)?;
        Ok(json!({ "kind": "acp", "pid": pid, "model": model, "restarted": restarted, "saved": saved }))
    }

    fn remove(&self, name: &str) -> Result<Value, String> {
        let w = self.find(name).ok_or("找不到這個工作者")?;
        let in_partners = super::partner_queue::read_partners(&self.partners_file).iter().any(|(n, _, _)| n.eq_ignore_ascii_case(name));
        let adopted = read_adopted(&self.adopted_file);
        let in_adopted = adopted.iter().any(|(n, _, _)| n == name);
        if !in_partners && !in_adopted {
            return Err("這位寫在這台電腦的 agents.json，不能從這裡移除；請在電腦上改設定檔".into());
        }
        // 1. 結束程序（正在處理信件就整個不做）
        let pid = w.admin_remove()?;
        self.workers.lock().unwrap().retain(|(n, _)| n != name);
        let _ = self.events.send(EngineEvent::RosterChanged);
        // 2. 刪名冊；3. 刪記下的模型。哪一步失敗就照實說做到哪裡
        if in_partners {
            super::partner_queue::forget(&self.partners_file, name).map_err(|e| format!("已結束程序，但「開新夥伴」名冊刪不掉（{e}），重啟 ASN 後它會回來"))?;
        }
        if in_adopted {
            let rest: Vec<_> = adopted.into_iter().filter(|(n, _, _)| n != name).collect();
            write_adopted(&self.adopted_file, &rest).map_err(|e| format!("已結束程序，但接手名冊刪不掉（{e}），重啟 ASN 後它會回來"))?;
        }
        super::acp_models::remove(&self.models_file, name).map_err(|e| format!("已結束程序、刪掉名冊，但記下的模型刪不掉（{e}）；同名的新夥伴可能沿用舊模型"))?;
        Ok(json!({ "kind": "acp", "pid": pid, "removed": true }))
    }

    /// 改名：鎖住工作者清單（改名途中進來的信等一下，不會被當成「已關閉」退掉）→ 檢查 → 停掉舊驅動（不清帳本）→ 搬檔案 →
    /// 用新名字建工作者（工作資料夾不變）、下一輪重送開頭說明並告知新名 → 換掉清單裡的那一個、啟動、通知名單有變。
    /// 搬檔案失敗：已改的都改回去，用原名重開
    fn rename(&self, name: &str, new_name: &str) -> Result<Value, String> {
        let env = self.adopt.as_ref().ok_or("工作者管理還沒啟動")?;
        let mut ws = self.workers.lock().unwrap();
        let (i, roster) = self.rename_check(&ws, name, new_name).inspect_err(|e| env.store.note(format!("acp: 工作者 {name} 改名為 {new_name} 擋下：{e}")))?;
        let old = ws[i].1.clone();
        let pid = old.admin_detach()?;
        if let Err(e) = self.move_files(&env.store, roster, name, new_name) {
            old.start();
            return Err(e);
        }
        let w = (env.make)(Arc::new(old.renamed_cfg(new_name)));
        w.mark_renamed(name, old.pending_intro());
        ws[i] = (new_name.to_string(), w.clone());
        drop(ws);
        w.start();
        env.store.note(format!("acp: 工作者 {name} 改名為 {new_name}（結束程序 pid={pid}，帶原本的對話重開）"));
        let _ = self.events.send(EngineEvent::RosterChanged);
        Ok(json!({ "kind": "acp", "pid": pid, "old_name": name, "new_name": new_name }))
    }

    fn handover(&self, name: &str, note: &str) -> Result<Value, String> {
        let w = self.find(name).ok_or("找不到這個工作者")?;
        let pid = w.admin_handover(note)?;
        Ok(json!({ "kind": "acp", "pid": pid, "handoff_done": false }))
    }

    fn adopt(&self, session_id: &str, cwd: &str) -> Result<Value, String> {
        let env = self.adopt.as_ref().ok_or("沒有可以接手的 Grok 工作者設定")?;
        // 已經有工作者在用這一段對話（含接手後改過名的）：不重複開
        let using = self.workers.lock().unwrap().iter().find(|(_, w)| !session_id.is_empty() && env.store.get(w.cfg()) == session_id).map(|(n, _)| n.clone());
        if let Some(name) = using {
            return Ok(json!({ "kind": "adopt", "name": name, "already": true }));
        }
        // 以現有的 Grok 工作者（名單引擎 grok、標準 ACP）的設定為底；沒有就不做，不猜指令
        let existing = self
            .workers
            .lock()
            .unwrap()
            .iter()
            .map(|(_, w)| w.cfg().clone())
            .find(|c| c.roster_engine == "grok" && c.protocol == "acp" && !c.adopted);
        let base = match existing {
            Some(c) => c,
            None => (env.base)(cwd)?,
        };
        let mut name = super::grok_adopt::worker_name(cwd, "");
        if let Some(w) = self.find(&name) {
            if env.store.get(w.cfg()) == session_id {
                return Ok(json!({ "kind": "adopt", "name": name, "already": true }));
            }
            name = super::grok_adopt::worker_name(cwd, session_id);
            if let Some(w) = self.find(&name) {
                if env.store.get(w.cfg()) == session_id {
                    return Ok(json!({ "kind": "adopt", "name": name, "already": true }));
                }
                return Err("已經有同名的專屬工作者在用別的對話，沒辦法再開".into());
            }
        }
        let cfg = Arc::new(super::grok_adopt::adopted_cfg(&base, &name, cwd));
        env.store.set(&cfg, session_id);
        let w = (env.make)(cfg.clone());
        w.mark_adopted();
        self.workers.lock().unwrap().push((name.clone(), w.clone()));
        w.start();
        let t0 = std::time::Instant::now();
        let outcome = loop {
            match w.load_state(session_id) {
                LoadState::Ready => break Ok(()),
                LoadState::Failed(e) => break Err(e),
                LoadState::Loading => {}
            }
            if t0.elapsed().as_millis() as u64 > env.wait_ms {
                break Err("等了太久，對話還沒載入完".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        if let Err(e) = outcome {
            w.stop();
            self.workers.lock().unwrap().retain(|(n, _)| *n != name);
            env.store.clear(&cfg);
            return Err(format!("專屬工作者沒能載入那段對話，已撤掉：{e}"));
        }
        // 成功才寫進接手名冊
        let mut list = read_adopted(&env.file);
        list.retain(|(n, _, _)| *n != name);
        list.push((name.clone(), session_id.to_string(), cwd.to_string()));
        let _ = write_adopted(&env.file, &list);
        let _ = env.events.send(EngineEvent::RosterChanged);
        Ok(json!({ "kind": "adopt", "name": name, "already": false }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 改名還原_倒著做_改回去失敗的每一步都記一筆_不吞掉() {
        let order = Arc::new(Mutex::new(Vec::<&str>::new()));
        let step = |name: &'static str, res: Result<(), String>| -> Undo {
            let o = order.clone();
            (name, Box::new(move || {
                o.lock().unwrap().push(name);
                res
            }))
        };
        let undo = vec![step("對話帳本", Ok(())), step("接手名冊", Err("磁碟滿了".into())), step("記下的模型", Err("檔案被鎖住".into()))];
        let logs = Mutex::new(Vec::<String>::new());
        assert!(!roll_back(undo, &|m| logs.lock().unwrap().push(m), "甲", "乙"), "有一步沒改回去");
        assert_eq!(*order.lock().unwrap(), vec!["記下的模型", "接手名冊", "對話帳本"], "倒著改回去，失敗了也繼續做完");
        let logs = logs.into_inner().unwrap();
        assert_eq!(logs.len(), 2, "{logs:?}");
        assert!(logs[0].contains("還原失敗") && logs[0].contains("記下的模型") && logs[0].contains("檔案被鎖住") && logs[0].contains("甲 → 乙"), "{logs:?}");
        assert!(logs[1].contains("還原失敗") && logs[1].contains("接手名冊") && logs[1].contains("磁碟滿了"), "{logs:?}");
        // 全部改回去：不記
        let logs = Mutex::new(Vec::<String>::new());
        assert!(roll_back(vec![step("對話帳本", Ok(()))], &|m| logs.lock().unwrap().push(m), "甲", "乙"));
        assert!(logs.into_inner().unwrap().is_empty());
    }

    #[test]
    fn 改名的說明都在_20_字內() {
        for m in [BAD_NAME, RENAME_FAILED, RENAME_HALF] {
            assert!(m.chars().count() <= 20, "{m}");
        }
    }
}
