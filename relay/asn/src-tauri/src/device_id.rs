//! 設備金鑰與認得的電腦（#597 別台看畫面，0.2.8 改版：不再手動配對）。之後的電腦互按、別台打字也用這一份。
//!
//! - 每台一把 Ed25519，私鑰經 DPAPI（Windows）或系統金鑰庫（Linux）保護、存在機器資料夾，只在 Rust。
//!   看的那台（D）和被看的那台（T）都用它簽握手；發起時不再確認本人（11-08 拿掉 Windows Hello）。
//! - **認得的電腦（TOFU，像 SSH 的 known_hosts）：** 兩台第一次連線時各自記住對方的設備公鑰，之後公鑰不同就拒絕並通知本人。
//!   後台只轉交公鑰，**信任只看本機記的**；本人可以在設定頁「忘記這台」重來。
//! - 誰能看誰：兩台都要是同一個本人的（後台擋），T 本機要開「允許其他設備替這台開新視窗」，而且這台的金鑰有保護。
//!
//! 同一個 Windows 使用者的程式仍然讀得到這些檔案，這點 DPAPI 擋不住，見私有設計。
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const KEY_FILE: &str = "device_key.bin";
const KNOWN_FILE: &str = "device_known.json";
pub const SCOPE_VIEW: &str = "view";
/// 別台打字（0.2.10）：和看畫面分開簽、分開開
pub const SCOPE_INPUT: &str = "input";
/// 這台目前不能讓別台看畫面（設定沒開，或金鑰只靠檔案權限保護）
pub const NOT_VIEWABLE_HERE: &str = "這台目前不能讓別台看畫面";
pub const KEY_CHANGED: &str = "這台電腦的設備金鑰變了，已拒絕連線。如果是你重裝了那台，請到設定頁「認得的電腦」按忘記再連一次";

/// 這台的金鑰有沒有保護到可以讓別台看：Windows（DPAPI），或設備私鑰已經由系統金鑰庫保護（Linux）。只靠檔案權限的一律不行
pub fn can_be_viewed_here(dir: &Path) -> bool {
    !cfg!(target_os = "android") && (cfg!(windows) || crate::keystore::device_key_sealed(dir))
}

/// 上傳公鑰的內文：公鑰＋這台是手機還是電腦（後台用來分辨）
pub fn publish_body(sign_pub: &str, platform: &str) -> serde_json::Value {
    serde_json::json!({ "sign_pub": sign_pub, "platform": platform })
}

/// 上報公鑰時一起帶的平台（android／desktop）
pub fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

pub struct DeviceKey {
    pair: Ed25519KeyPair,
}

impl DeviceKey {
    fn from_pkcs8(bytes: &[u8]) -> Result<Self, String> {
        Ed25519KeyPair::from_pkcs8(bytes).map(|pair| DeviceKey { pair }).map_err(|_| "設備金鑰壞了".to_string())
    }

    pub fn public_b64(&self) -> String {
        B64.encode(self.pair.public_key().as_ref())
    }

    pub fn sign_b64(&self, msg: &[u8]) -> String {
        B64.encode(self.pair.sign(msg).as_ref())
    }
}

/// 讀這台的設備金鑰；沒有才新建。**讀到了卻解不開時回錯誤，不蓋掉：** 蓋掉等於換一個身分。
/// 唯一例外：保護層明說包裝金鑰確定不在了（手機金鑰庫被重置）——檔案永遠解不開，重產一把新的（公鑰會換，別台會拒絕並通知本人）
pub fn load_or_create(dir: &Path, prot: &dyn crate::auth::Protector) -> Result<DeviceKey, String> {
    let path = dir.join(KEY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let sealed = B64.decode(text.trim()).map_err(|_| "設備金鑰壞了".to_string())?;
            let plain = match prot.unprotect(&sealed) {
                Ok(p) => zeroize::Zeroizing::new(p),
                Err(e) if prot.key_lost(&e) => {
                    elog!("設備金鑰的包裝金鑰不見了，重產新的設備金鑰：{e}");
                    return create_new(&path, prot, true);
                }
                Err(e) => return Err(e),
            };
            let key = DeviceKey::from_pkcs8(&plain)?;
            // 舊的明文檔、這次有系統金鑰庫：順手升級成包過的，舊檔先覆寫再換掉（失敗就維持原樣）
            if prot.seals() && !prot.wrapped(&sealed) {
                if let Err(e) = prot.protect(&plain).and_then(|s| replace_scrubbed(&path, B64.encode(s).as_bytes()).map_err(|e| e.to_string())) {
                    elog!("設備金鑰升級失敗（照舊可用）：{e}");
                }
            }
            Ok(key)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_new(&path, prot, false),
        Err(e) => Err(format!("讀設備金鑰失敗：{e}")),
    }
}

/// 產一把新的設備金鑰並存檔；`scrub` 為真時原本的檔案先覆寫
fn create_new(path: &Path, prot: &dyn crate::auth::Protector, scrub: bool) -> Result<DeviceKey, String> {
    let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| "產生設備金鑰失敗".to_string())?;
    let sealed = prot.protect(doc.as_ref())?;
    let text = B64.encode(sealed);
    let r = if scrub { replace_scrubbed(path, text.as_bytes()) } else { write_private(path, text.as_bytes()) };
    r.map_err(|e| format!("存設備金鑰失敗：{e}"))?;
    DeviceKey::from_pkcs8(doc.as_ref())
}

/// 換掉金鑰檔：新內容先寫成暫存檔，握住舊檔、換名，再透過握把把舊內容蓋成零（盡力而為）。
/// 順序不能反：任何一步被中斷，金鑰檔不是完整的舊內容就是完整的新內容，不會留下一檔零
fn replace_scrubbed(path: &Path, text: &[u8]) -> std::io::Result<()> {
    let Ok(old) = std::fs::metadata(path) else { return write_private(path, text) };
    let len = old.len() as usize;
    let tmp = PathBuf::from(format!("{}.{}.new", path.display(), std::process::id()));
    write_private(&tmp, text)?;
    let held = std::fs::OpenOptions::new().write(true).open(path);
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Windows：開著的檔不能被換名蓋掉。放掉握把再換一次，這時就不蓋零了
        drop(held);
        if let Err(e2) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e2);
        }
        elog!("舊金鑰檔沒有蓋零（換名時檔案被占用）：{e}");
        return Ok(());
    }
    if let Ok(mut f) = held {
        use std::io::Write;
        if let Err(e) = f.write_all(&vec![0u8; len]).and_then(|_| f.sync_all()) {
            elog!("舊金鑰檔蓋零失敗（已換成新的）：{e}");
        }
    }
    Ok(())
}

/// 寫金鑰檔：非 Windows 先用 0600 建暫存檔、寫完再換名，從頭到尾都只有本人讀得到（和登入憑證的寫法相同）。
/// 不能先寫好再改權限：中間那一刻是預設權限（通常 0644），同一台的其他使用者讀得到
pub(crate) fn write_private(path: &Path, text: &[u8]) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    {
        use std::io::Write;
        let mut f = opts.open(&tmp)?;
        f.write_all(text)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// 這個系統用哪種方式保護金鑰（和登入憑證相同）
pub fn protector(dir: &Path) -> Box<dyn crate::auth::Protector> {
    #[cfg(windows)]
    {
        let _ = dir;
        Box::new(crate::auth::Dpapi)
    }
    #[cfg(not(windows))]
    {
        // Linux：有系統金鑰庫（或用過）就用它包；完全沒有才只靠檔案權限（0.2.9）
        #[cfg(target_os = "linux")]
        if let Some(w) = crate::keystore::wrap_for(dir, crate::keystore::Purpose::DeviceKey, KEY_FILE) {
            return Box::new(w);
        }
        #[cfg(target_os = "android")]
        {
            let _ = dir;
            crate::android_keywrap::android_protector()
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = dir;
            Box::new(crate::auth::PlainFile)
        }
    }
}

pub fn verify(pub_b64: &str, msg: &[u8], sig_b64: &str) -> bool {
    let (Ok(public), Ok(sig)) = (B64.decode(pub_b64), B64.decode(sig_b64)) else { return false };
    UnparsedPublicKey::new(&ED25519, public).verify(msg, &sig).is_ok()
}

/// 指紋：公鑰的 SHA-256 前 8 位元組，16 個小寫十六進位字元（設定頁顯示、通知信裡帶，給本人比對）
pub fn fingerprint(sign_pub: &str) -> String {
    Sha256::digest(format!("asn-device-fp-v1\n{sign_pub}").as_bytes())[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// 認得的一台電腦
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownPeer {
    pub node: String,
    pub name: String,
    pub sign_pub: String,
    /// 第一次記住的時間（毫秒）
    pub first_seen_ms: u64,
    /// 這台要在這裡打字時不用每次問本人（0.2.10）。**只有這台的設定頁能改**（守門測試）；不送後台、不同步。舊檔沒有這欄＝要問
    #[serde(default)]
    pub input_no_ask: bool,
    /// 允許這支手機替這台登入別家 CLI（#933）。**只有這台的設定頁能改**（守門測試）；不送後台、不同步。
    /// 舊檔沒有這欄、第一次記住、忘記後重新記住，一律是不允許：記住了公鑰不等於允許登入
    #[serde(default)]
    pub login_ok: bool,
}

/// 收到對方公鑰時的比對結果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tofu {
    /// 第一次看到這台
    New,
    /// 和記住的一樣
    Same,
    /// 和記住的不一樣：拒絕
    Changed,
}

/// 本機記住的電腦（TOFU）。純資料，不碰網路
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownPeers {
    #[serde(default)]
    pub peers: Vec<KnownPeer>,
}

impl KnownPeers {
    /// 讀不到檔案就是一台都不認得；**檔案壞了回錯誤，不當成空的：** 當成空的就等於全部重新信任
    pub fn load(dir: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(dir.join(KNOWN_FILE)) {
            Ok(t) => serde_json::from_str(&t).map_err(|_| "認得的電腦紀錄壞了".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(KnownPeers::default()),
            Err(e) => Err(format!("讀認得的電腦失敗：{e}")),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write_private(&dir.join(KNOWN_FILE), text.as_bytes()).map_err(|e| format!("存認得的電腦失敗：{e}"))
    }

    pub fn peer(&self, node: &str) -> Option<&KnownPeer> {
        self.peers.iter().find(|p| p.node == node)
    }

    pub fn check(&self, node: &str, sign_pub: &str) -> Tofu {
        match self.peer(node) {
            None => Tofu::New,
            Some(p) if p.sign_pub == sign_pub => Tofu::Same,
            Some(_) => Tofu::Changed,
        }
    }

    /// 記住一台。已經記過同一把就只更新名字；記過不同的一把是錯誤（要本人先忘記）
    pub fn remember(&mut self, node: &str, name: &str, sign_pub: &str, now_ms: u64) -> Result<(), String> {
        match self.check(node, sign_pub) {
            Tofu::Changed => Err(KEY_CHANGED.to_string()),
            Tofu::Same => {
                if let Some(p) = self.peers.iter_mut().find(|p| p.node == node) {
                    p.name = name.to_string();
                }
                Ok(())
            }
            Tofu::New => {
                self.peers.push(KnownPeer { node: node.to_string(), name: name.to_string(), sign_pub: sign_pub.to_string(), first_seen_ms: now_ms, input_no_ask: false, login_ok: false });
                Ok(())
            }
        }
    }

    /// 這台打字要不要每次問（本機設定頁才能改）。回有沒有這台
    pub fn set_input_no_ask(&mut self, node: &str, on: bool) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) => {
                p.input_no_ask = on;
                true
            }
            None => false,
        }
    }

    /// 這台打字可以不問嗎：只有認得、而且本人在這台設定過才不問
    pub fn input_no_ask(&self, node: &str) -> bool {
        self.peer(node).is_some_and(|p| p.input_no_ask)
    }

    /// 允不允許這支手機替這台登入（本機設定頁才能改）。回有沒有這台
    pub fn set_login_ok(&mut self, node: &str, on: bool) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) => {
                p.login_ok = on;
                true
            }
            None => false,
        }
    }

    /// 這支手機能不能替這台登入：只有認得、而且本人在這台勾過才可以
    pub fn login_ok(&self, node: &str) -> bool {
        self.peer(node).is_some_and(|p| p.login_ok)
    }

    /// 忘記一台（本機設定頁才能做）。回有沒有這台
    pub fn forget(&mut self, node: &str) -> bool {
        let before = self.peers.len();
        self.peers.retain(|p| p.node != node);
        before != self.peers.len()
    }
}

#[cfg(feature = "gui")]
pub mod live {
    //! 讀寫本機檔案都在這把鎖裡，不跨 await
    use super::*;
    use crate::relay::Relay;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    /// async 裡用這個：取金鑰可能要問系統金鑰庫（最多等幾秒），不佔用 async 的執行緒
    pub async fn key_async(dir: &Path) -> Result<DeviceKey, String> {
        let d = dir.to_path_buf();
        tokio::task::spawn_blocking(move || key(&d)).await.map_err(|e| e.to_string())?
    }

    pub fn key(dir: &Path) -> Result<DeviceKey, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_or_create(dir, protector(dir).as_ref())
    }

    pub fn known(dir: &Path) -> Result<KnownPeers, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        KnownPeers::load(dir)
    }

    /// 收到對方的公鑰：比對；第一次就記住。回比對結果（Changed 什麼都不寫）
    pub fn see(dir: &Path, node: &str, name: &str, sign_pub: &str, now_ms: u64) -> Result<Tofu, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let t = k.check(node, sign_pub);
        if t != Tofu::Changed {
            k.remember(node, name, sign_pub, now_ms)?;
            k.save(dir)?;
        }
        Ok(t)
    }

    /// 忘記一台：**只有本機設定頁的命令能叫**（守門測試）
    pub fn forget(dir: &Path, node: &str) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let gone = k.forget(node);
        k.save(dir)?;
        Ok(gone)
    }

    /// 這台打字要不要每次問：**只有本機設定頁的命令能叫**（守門測試）
    pub fn set_input_no_ask(dir: &Path, node: &str, on: bool) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let found = k.set_input_no_ask(node, on);
        if found {
            k.save(dir)?;
        }
        Ok(found)
    }

    /// 允不允許這支手機替這台登入：**只有本機設定頁的命令能叫**（守門測試）
    pub fn set_login_ok(dir: &Path, node: &str, on: bool) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let found = k.set_login_ok(node, on);
        if found {
            k.save(dir)?;
        }
        Ok(found)
    }

    /// 設定頁要的列表：名字、指紋、第一次記住的時間、打字要不要每次問、允不允許替這台登入
    pub fn view(dir: &Path) -> Result<Value, String> {
        let k = known(dir)?;
        Ok(json!({ "peers": k.peers.iter().map(|p| json!({ "node": p.node, "name": p.name, "fingerprint": fingerprint(&p.sign_pub), "first_seen_ms": p.first_seen_ms, "input_no_ask": p.input_no_ask, "login_ok": p.login_ok })).collect::<Vec<_>>() }))
    }

    /// 上傳這台的公鑰（沒有金鑰就先建）
    pub async fn publish(relay: &Relay, dir: &Path) -> Result<(), String> {
        let k = key_async(dir).await?;
        relay.api("device_key_publish", Some(publish_body(&k.public_b64(), platform()))).await.map(|_| ())
    }

    /// 通知本人：第一次記住（只有 T 寄）或公鑰換了（兩邊都寄）。送不出去只記 log
    pub async fn alert(relay: &Relay, peer: &str, kind: &str, sign_pub: &str) {
        let body = json!({ "peer": peer, "kind": kind, "fp": fingerprint(sign_pub) });
        if let Err(e) = relay.api("device_key_alert", Some(body)).await {
            elog!("[ASN] 設備金鑰通知送不出去：{e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Protector;

    /// 假的保護層：看得出有沒有經過它
    struct Flip;
    impl Protector for Flip {
        fn protect(&self, p: &[u8]) -> Result<Vec<u8>, String> {
            Ok(p.iter().map(|b| b ^ 0x5a).collect())
        }
        fn unprotect(&self, s: &[u8]) -> Result<Vec<u8>, String> {
            Ok(s.iter().map(|b| b ^ 0x5a).collect())
        }
    }
    struct Broken;
    impl Protector for Broken {
        fn protect(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("不能用".into())
        }
        fn unprotect(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("不能用".into())
        }
    }

    #[test]
    fn 認得的電腦_第一次記住_一樣的照常_不一樣就拒絕_忘記才重來() {
        let mut k = KnownPeers::default();
        assert_eq!(k.check("d", "pk1"), Tofu::New);
        k.remember("d", "工作機", "pk1", 1).unwrap();
        assert_eq!(k.check("d", "pk1"), Tofu::Same);
        assert_eq!(k.check("d", "pk2"), Tofu::Changed);
        assert_eq!(k.remember("d", "工作機", "pk2", 2).unwrap_err(), KEY_CHANGED, "換了就拒絕，不蓋掉");
        assert_eq!(k.peer("d").unwrap().sign_pub, "pk1");
        k.remember("d", "改名了", "pk1", 3).unwrap();
        assert_eq!((k.peer("d").unwrap().name.as_str(), k.peer("d").unwrap().first_seen_ms), ("改名了", 1), "同一把只更新名字");
        assert!(k.forget("d"));
        assert!(!k.forget("d"));
        assert_eq!(k.check("d", "pk2"), Tofu::New, "忘記之後才能重來");
    }

    #[test]
    fn 認得的電腦_存讀一致_沒有檔案是空的_壞了回錯誤不洗掉() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(KnownPeers::load(d.path()).unwrap(), KnownPeers::default());
        let mut k = KnownPeers::default();
        k.remember("d", "工作機", "pk", 5).unwrap();
        k.save(d.path()).unwrap();
        assert_eq!(KnownPeers::load(d.path()).unwrap(), k);
        std::fs::write(d.path().join(KNOWN_FILE), "{壞").unwrap();
        assert!(KnownPeers::load(d.path()).is_err());
    }

    #[test]
    fn 指紋_十六個小寫十六進位_公鑰不同就不同() {
        let f = fingerprint("pk1");
        assert_eq!(f.len(), 16);
        assert!(f.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(f, fingerprint("pk2"));
    }

    #[test]
    fn 打字不用問_預設要問_舊檔沒有這欄也是要問_記住同一把不會蓋掉_忘記就重來() {
        let mut k = KnownPeers::default();
        k.remember("d", "工作機", "pk", 1).unwrap();
        assert!(!k.input_no_ask("d"), "第一次記住：要問");
        assert!(!k.input_no_ask("沒有"), "不認得：要問");
        assert!(k.set_input_no_ask("d", true));
        assert!(!k.set_input_no_ask("沒有", true), "不認得的不能設");
        k.remember("d", "改名", "pk", 2).unwrap();
        assert!(k.input_no_ask("d"), "同一把再看到一次：設定不變");
        k.forget("d");
        k.remember("d", "工作機", "pk", 3).unwrap();
        assert!(!k.input_no_ask("d"), "忘記之後重新記住：又要問");
        let old: KnownPeers = serde_json::from_str(r#"{"peers":[{"node":"d","name":"n","sign_pub":"pk","first_seen_ms":1}]}"#).unwrap();
        assert!(!old.input_no_ask("d"), "0.2.8 的檔：要問");
    }

    #[test]
    fn 允許替這台登入_預設不允許_舊檔也不允許_記住同一把不會蓋掉_忘記就重來() {
        let mut k = KnownPeers::default();
        k.remember("p", "手機", "pk", 1).unwrap();
        assert!(!k.login_ok("p"), "第一次記住（例如看過畫面）：不允許");
        assert!(!k.login_ok("沒有"));
        assert!(k.set_login_ok("p", true));
        assert!(!k.set_login_ok("沒有", true), "不認得的不能設");
        assert!(!k.input_no_ask("p"), "和打字不用問是兩回事");
        k.remember("p", "改名", "pk", 2).unwrap();
        assert!(k.login_ok("p"), "同一把再看到一次：設定不變");
        k.forget("p");
        k.remember("p", "手機", "pk", 3).unwrap();
        assert!(!k.login_ok("p"), "忘記之後重新記住：又不允許");
        let old: KnownPeers = serde_json::from_str(r#"{"peers":[{"node":"p","name":"n","sign_pub":"pk","first_seen_ms":1,"input_no_ask":true}]}"#).unwrap();
        assert!(!old.login_ok("p"), "0.2.13 的檔：不允許");
    }

    #[test]
    fn 守門_忘記只有本機設定頁能叫_記住只有收到請求時() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let lib = std::fs::read_to_string(root.join("lib.rs")).unwrap();
        let lib = lib.split("\nmod tests {").next().unwrap();
        let fns = |pat: &str| -> Vec<String> {
            lib.match_indices(pat)
                .map(|(i, _)| {
                    let before = &lib[..i];
                    let f = before.rfind("\nasync fn ").max(before.rfind("\nfn ")).unwrap();
                    before[f..].trim_start_matches('\n').trim_start_matches("async ").trim_start_matches("fn ").chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect()
                })
                .collect()
        };
        assert!(fns("device_id::live::forget(").iter().all(|f| f == "device_known_forget"), "忘記只能從設定頁的命令");
        let no_ask = fns("device_id::live::set_input_no_ask(");
        assert!(!no_ask.is_empty() && no_ask.iter().all(|f| f == "device_known_input_no_ask"), "打字不用問只能從設定頁的命令：{no_ask:?}");
        let login_ok = fns("device_id::live::set_login_ok(");
        assert!(!login_ok.is_empty() && login_ok.iter().all(|f| f == "device_known_login_ok"), "允許替這台登入只能從設定頁的命令：{login_ok:?}");
        assert_eq!(lib.matches("set_login_ok(").count(), 1, "lib.rs 只有設定頁的命令會改");
        let see = fns("device_id::live::see(");
        assert!(!see.is_empty() && see.iter().all(|f| f == "start_view_poller" || f == "start_remote_view" || f == "view_backend_see"), "記住只在收到請求（T）或看的那台驗過 T 的簽章時：{see:?}");
        for f in ["bridge/mod.rs", "bridge/launcher.rs", "cli/mod.rs", "android.rs", "headless.rs"] {
            let s = std::fs::read_to_string(root.join(f)).unwrap();
            assert!(!s.contains("live::forget") && !s.contains("live::see") && !s.contains("set_input_no_ask") && !s.contains("set_login_ok"), "{f} 不能改認得的電腦");
        }
    }

    #[test]
    fn 金鑰_第一次建_之後讀回同一把_檔案裡不是明文() {
        let d = tempfile::tempdir().unwrap();
        let a = load_or_create(d.path(), &Flip).unwrap();
        let b = load_or_create(d.path(), &Flip).unwrap();
        assert_eq!(a.public_b64(), b.public_b64());
        let raw = B64.decode(std::fs::read_to_string(d.path().join(KEY_FILE)).unwrap()).unwrap();
        assert!(Ed25519KeyPair::from_pkcs8(&raw).is_err(), "存的是包過的");
    }

    #[cfg(unix)]
    #[test]
    fn 金鑰檔_建立後只有本人讀得到_暫存檔建立時就是_0600() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        load_or_create(d.path(), &Flip).unwrap();
        let mode = std::fs::metadata(d.path().join(KEY_FILE)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        // 暫存檔本身就用 0600 建（不是寫完才改）：照同樣的寫法建一個不換名的檔來查
        let p = d.path().join("x");
        write_private(&p, b"secret").unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let src = include_str!("device_id.rs");
        let f = src.split("fn write_private(").nth(1).unwrap().split("\n}").next().unwrap();
        assert!(f.find("opts.mode(0o600)").unwrap() < f.find("opts.open(&tmp)").unwrap(), "先定權限再建檔");
        assert!(!f.contains("set_permissions"), "不是事後改權限");
    }

    #[test]
    fn 金鑰_解不開時回錯誤_不蓋掉() {
        let d = tempfile::tempdir().unwrap();
        load_or_create(d.path(), &Flip).unwrap();
        let before = std::fs::read(d.path().join(KEY_FILE)).unwrap();
        assert!(load_or_create(d.path(), &Broken).is_err());
        assert_eq!(std::fs::read(d.path().join(KEY_FILE)).unwrap(), before);
        std::fs::write(d.path().join(KEY_FILE), "不是 base64!!").unwrap();
        assert!(load_or_create(d.path(), &Flip).is_err());
    }

    // ---- 手機：系統金鑰庫保護（用假的金鑰庫）----
    use crate::android_keywrap::{fake::FakeKeystore, KeyWrap, PREFIX as AK_PREFIX};

    fn raw_file(d: &Path) -> Vec<u8> {
        B64.decode(std::fs::read_to_string(d.join(KEY_FILE)).unwrap().trim()).unwrap()
    }

    #[test]
    fn 手機金鑰_新裝置直接產包過的檔_讀回同一把() {
        let d = tempfile::tempdir().unwrap();
        let ks = FakeKeystore::default();
        let a = load_or_create(d.path(), &KeyWrap(ks.clone())).unwrap();
        assert!(raw_file(d.path()).starts_with(AK_PREFIX), "檔案是包過的");
        let b = load_or_create(d.path(), &KeyWrap(ks)).unwrap();
        assert_eq!(a.public_b64(), b.public_b64());
    }

    #[test]
    fn 手機金鑰_舊明文檔遷移_公鑰不變_舊內容不留() {
        let d = tempfile::tempdir().unwrap();
        // 舊版：明文（PlainFile）存的
        let old = load_or_create(d.path(), &crate::auth::PlainFile).unwrap();
        let plain_bytes = raw_file(d.path());
        assert!(Ed25519KeyPair::from_pkcs8(&plain_bytes).is_ok(), "舊檔是明文");
        let k = load_or_create(d.path(), &KeyWrap(FakeKeystore::default())).unwrap();
        assert_eq!(old.public_b64(), k.public_b64(), "公鑰不變");
        let now = raw_file(d.path());
        assert!(now.starts_with(AK_PREFIX), "已改存包過的");
        assert!(!now.windows(plain_bytes.len()).any(|w| w == plain_bytes.as_slice()), "新檔不含明文");
        let leftovers: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(leftovers, vec![KEY_FILE.to_string()], "沒有留下暫存檔：{leftovers:?}");
        // 再讀一次還是同一把，且不再重寫
        let again = load_or_create(d.path(), &KeyWrap(FakeKeystore::default())).unwrap();
        assert_eq!(again.public_b64(), old.public_b64());
        assert_eq!(raw_file(d.path()), now);
    }

    #[test]
    fn 舊檔覆寫_換掉之前先把舊內容蓋成零() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("k");
        std::fs::write(&p, b"old-secret-old-secret").unwrap();
        let hold = std::fs::File::open(&p).unwrap(); // 抓著舊 inode，換名後還讀得到舊的那份內容
        replace_scrubbed(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        use std::io::Read;
        let mut left = Vec::new();
        let mut h = hold;
        h.read_to_end(&mut left).unwrap();
        assert!(left.iter().all(|b| *b == 0), "舊 inode 的內容已蓋成零");
    }

    #[test]
    fn 舊檔換檔_換名之前失敗_舊檔原樣還讀得到() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("k");
        std::fs::write(&p, b"old-secret-old-secret").unwrap();
        // 暫存檔的位置先被一個資料夾占住：新內容寫不進去、走不到換名
        std::fs::create_dir(format!("{}.{}.new", p.display(), std::process::id())).unwrap();
        assert!(replace_scrubbed(&p, b"new").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"old-secret-old-secret", "沒換成功就不能動到舊檔（不能變成一檔零）");
    }

    #[test]
    fn 手機金鑰_包裝金鑰確定不見了_重產新的設備金鑰() {
        let d = tempfile::tempdir().unwrap();
        let ks = FakeKeystore::default();
        let a = load_or_create(d.path(), &KeyWrap(ks.clone())).unwrap();
        ks.lost.store(true, std::sync::atomic::Ordering::SeqCst);
        let b = load_or_create(d.path(), &KeyWrap(ks.clone())).unwrap();
        assert_ne!(a.public_b64(), b.public_b64(), "身分換了");
        assert!(raw_file(d.path()).starts_with(AK_PREFIX), "新檔是包過的");
        // 金鑰庫恢復後讀回的是新的那把
        ks.lost.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(load_or_create(d.path(), &KeyWrap(ks)).unwrap().public_b64(), b.public_b64());
    }

    #[test]
    fn 手機金鑰_暫時失敗不覆蓋() {
        let d = tempfile::tempdir().unwrap();
        let ks = FakeKeystore::default();
        load_or_create(d.path(), &KeyWrap(ks.clone())).unwrap();
        let before = std::fs::read(d.path().join(KEY_FILE)).unwrap();
        ks.busy.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(load_or_create(d.path(), &KeyWrap(ks)).is_err());
        assert_eq!(std::fs::read(d.path().join(KEY_FILE)).unwrap(), before);
    }

    #[test]
    fn 手機的設備金鑰不能讓別台看() {
        let d = tempfile::tempdir().unwrap();
        load_or_create(d.path(), &KeyWrap(FakeKeystore::default())).unwrap();
        assert!(!crate::keystore::device_key_sealed(d.path()), "手機的前綴不是 Linux 金鑰庫那種");
        if cfg!(target_os = "android") {
            assert!(!can_be_viewed_here(d.path()));
        }
        let src = include_str!("device_id.rs");
        let f = src.split("pub fn can_be_viewed_here(").nth(1).unwrap().split("}").next().unwrap();
        assert!(f.contains("!cfg!(target_os = \"android\")"), "手機寫死不能被看");
    }

    #[test]
    fn 平台值_手機是_android_其他是_desktop() {
        assert_eq!(platform(), if cfg!(target_os = "android") { "android" } else { "desktop" });
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let call = lib.matches("#[cfg(not(desktop))]\n                start_device_key_publish(").count();
        assert_eq!(call, 1, "手機啟動時要叫上傳公鑰");
        assert!(lib.contains("#[cfg(feature = \"gui\")]\nfn start_device_key_publish"), "上傳公鑰不再限定電腦版");
    }

    #[test]
    fn 上傳公鑰帶平台欄() {
        let b = publish_body("pk", "android");
        assert_eq!(b, serde_json::json!({ "sign_pub": "pk", "platform": "android" }));
        assert_eq!(publish_body("pk", platform())["platform"], platform());
        let src = include_str!("device_id.rs");
        let live = src.split("pub async fn publish(").nth(1).unwrap().split("\n    }").next().unwrap();
        assert!(live.contains("publish_body(") && live.contains("platform()"), "上傳時帶這台的平台");
    }

    #[test]
    fn 簽章_驗得過_內容或公鑰不對就不過() {
        let d1 = tempfile::tempdir().unwrap();
        let d2 = tempfile::tempdir().unwrap();
        let k1 = load_or_create(d1.path(), &Flip).unwrap();
        let k2 = load_or_create(d2.path(), &Flip).unwrap();
        let s = k1.sign_b64(b"abc");
        assert!(verify(&k1.public_b64(), b"abc", &s));
        assert!(!verify(&k1.public_b64(), b"abd", &s));
        assert!(!verify(&k2.public_b64(), b"abc", &s));
        assert!(!verify("壞的", b"abc", &s));
        assert!(!verify(&k1.public_b64(), b"abc", "壞的"));
    }

    #[test]
    fn 守門_入口只有畫面的命令_橋_cli_手機都接不到() {
        for src in [include_str!("bridge/mod.rs"), include_str!("bridge/launcher.rs"), include_str!("cli/mod.rs"), include_str!("android.rs")] {
            assert!(!src.contains("device_id::"), "不能從這裡碰設備金鑰");
        }
    }
}
