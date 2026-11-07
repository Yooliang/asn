//! 設備金鑰與認得的電腦（#597 別台看畫面，0.2.8 改版：不再手動配對）。之後的電腦互按、別台打字也用這一份。
//!
//! - 每台一把 Ed25519，私鑰經 DPAPI（Windows）或系統金鑰庫（Linux）保護、存在機器資料夾，只在 Rust。
//!   看的那台（D）和被看的那台（T）都用它簽握手；Windows Hello 只用來確認本人在場，不碰金鑰。
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
/// 這台目前不能讓別台看畫面（設定沒開，或金鑰只靠檔案權限保護）
pub const NOT_VIEWABLE_HERE: &str = "這台目前不能讓別台看畫面";
pub const KEY_CHANGED: &str = "這台電腦的設備金鑰變了，已拒絕連線。如果是你重裝了那台，請到設定頁「認得的電腦」按忘記再連一次";

/// 這台的金鑰有沒有保護到可以讓別台看：Windows（DPAPI），或設備私鑰已經由系統金鑰庫保護（Linux）。只靠檔案權限的一律不行
pub fn can_be_viewed_here(dir: &Path) -> bool {
    cfg!(windows) || crate::keystore::device_key_sealed(dir)
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

/// 讀這台的設備金鑰；沒有才新建。**讀到了卻解不開時回錯誤，不蓋掉：** 蓋掉等於換一個身分
pub fn load_or_create(dir: &Path, prot: &dyn crate::auth::Protector) -> Result<DeviceKey, String> {
    let path = dir.join(KEY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let sealed = B64.decode(text.trim()).map_err(|_| "設備金鑰壞了".to_string())?;
            let plain = zeroize::Zeroizing::new(prot.unprotect(&sealed)?);
            let key = DeviceKey::from_pkcs8(&plain)?;
            // 舊的明文檔、這次有系統金鑰庫：順手升級成包過的（失敗就維持原樣）
            if prot.seals() && !crate::keystore::is_sealed(&sealed) {
                if let Err(e) = prot.protect(&plain).and_then(|s| write_private(&path, B64.encode(s).as_bytes()).map_err(|e| e.to_string())) {
                    elog!("設備金鑰升級失敗（照舊可用）：{e}");
                }
            }
            Ok(key)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| "產生設備金鑰失敗".to_string())?;
            let sealed = prot.protect(doc.as_ref())?;
            write_private(&path, B64.encode(sealed).as_bytes()).map_err(|e| format!("存設備金鑰失敗：{e}"))?;
            DeviceKey::from_pkcs8(doc.as_ref())
        }
        Err(e) => Err(format!("讀設備金鑰失敗：{e}")),
    }
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
        let _ = dir;
        Box::new(crate::auth::PlainFile)
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
                self.peers.push(KnownPeer { node: node.to_string(), name: name.to_string(), sign_pub: sign_pub.to_string(), first_seen_ms: now_ms });
                Ok(())
            }
        }
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

    /// 設定頁要的列表：名字、指紋、第一次記住的時間
    pub fn view(dir: &Path) -> Result<Value, String> {
        let k = known(dir)?;
        Ok(json!({ "peers": k.peers.iter().map(|p| json!({ "node": p.node, "name": p.name, "fingerprint": fingerprint(&p.sign_pub), "first_seen_ms": p.first_seen_ms })).collect::<Vec<_>>() }))
    }

    /// 上傳這台的公鑰（沒有金鑰就先建）
    pub async fn publish(relay: &Relay, dir: &Path) -> Result<(), String> {
        let k = key_async(dir).await?;
        relay.api("device_key_publish", Some(json!({ "sign_pub": k.public_b64() }))).await.map(|_| ())
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
        let see = fns("device_id::live::see(");
        assert!(!see.is_empty() && see.iter().all(|f| f == "start_view_poller" || f == "start_remote_view"), "記住只在收到請求（T）或看的那台驗過 T 的簽章時：{see:?}");
        for f in ["bridge/mod.rs", "bridge/launcher.rs", "cli/mod.rs", "android.rs", "headless.rs"] {
            let s = std::fs::read_to_string(root.join(f)).unwrap();
            assert!(!s.contains("live::forget") && !s.contains("live::see"), "{f} 不能改認得的電腦");
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
