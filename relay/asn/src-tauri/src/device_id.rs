//! 設備金鑰與配對（#597 工作包 E）。別台看畫面、之後的電腦互按、別台打字都用這一份。
//!
//! - 每台一把 Ed25519，私鑰經 DPAPI 存在機器資料夾，只在 Rust。被看的那台可能沒人在，所以這把不要求本人。
//!   發起觀看另外用 Windows Hello 的金鑰，不在這張。
//! - 後台只轉交公鑰和簽章，**信任只看本機記的**（`Trust`）。公鑰變了就警告並停止，要本人在那台撤銷才能重新配對。
//! - 權限分方向：D 可以看 T，不代表 T 可以看 D。
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
const TRUST_FILE: &str = "device_trust.json";
/// 指紋長度（位元組）
const FINGERPRINT_BYTES: usize = 10;
pub const SCOPE_VIEW: &str = "view";
pub const KEY_CHANGED: &str = "這台電腦的金鑰變了，可能是重裝過。請先在這裡撤銷，再重新配對";

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
            DeviceKey::from_pkcs8(&plain)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| "產生設備金鑰失敗".to_string())?;
            let sealed = prot.protect(doc.as_ref())?;
            crate::write_atomic(&path, &B64.encode(sealed)).map_err(|e| format!("存設備金鑰失敗：{e}"))?;
            restrict(&path);
            DeviceKey::from_pkcs8(doc.as_ref())
        }
        Err(e) => Err(format!("讀設備金鑰失敗：{e}")),
    }
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        elog!("設備金鑰權限設定失敗：{e}");
    }
}
#[cfg(not(unix))]
fn restrict(_path: &Path) {}

/// 這個系統用哪種方式保護金鑰（和登入憑證相同）
pub fn protector() -> Box<dyn crate::auth::Protector> {
    #[cfg(windows)]
    {
        Box::new(crate::auth::Dpapi)
    }
    #[cfg(not(windows))]
    {
        Box::new(crate::auth::PlainFile)
    }
}

pub fn verify(pub_b64: &str, msg: &[u8], sig_b64: &str) -> bool {
    let (Ok(public), Ok(sig)) = (B64.decode(pub_b64), B64.decode(sig_b64)) else { return false };
    UnparsedPublicKey::new(&ED25519, public).verify(msg, &sig).is_ok()
}

/// 兩邊比對用的指紋：兩台的節點和公鑰，排序後算，所以兩邊算出來相同。10 位元組，每 2 位元組一組
pub fn fingerprint(node_a: &str, pub_a: &str, node_b: &str, pub_b: &str) -> String {
    let ((n1, p1), (n2, p2)) = if node_a <= node_b { ((node_a, pub_a), (node_b, pub_b)) } else { ((node_b, pub_b), (node_a, pub_a)) };
    let h = Sha256::digest(format!("asn-pair-fp-v1\n{n1}\n{p1}\n{n2}\n{p2}").as_bytes());
    h[..FINGERPRINT_BYTES].chunks(2).map(|c| format!("{:02x}{:02x}", c[0], c[1])).collect::<Vec<_>>().join("-")
}

/// T 確認配對時簽的內容：綁請求、雙方節點、雙方公鑰
pub fn confirm_message(id: &str, from_node: &str, to_node: &str, from_pub: &str, to_pub: &str) -> Vec<u8> {
    format!("asn-pair-confirm-v1\n{id}\n{from_node}\n{to_node}\n{from_pub}\n{to_pub}").into_bytes()
}

/// 權限的方向
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// 對方可以對我做（例如對方看我）
    PeerToMe,
    /// 我可以對對方做（例如我看對方）
    MeToPeer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub direction: Direction,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    pub node: String,
    pub name: String,
    pub sign_pub: String,
    /// 對方發起觀看用的 Hello 公鑰。Hello 接上之前都是空的，所以 T 不會接受任何觀看
    #[serde(default)]
    pub view_pub: Option<String>,
    #[serde(default)]
    pub grants: Vec<Grant>,
}

/// 我發起、還在等對方確認的配對。對方的公鑰記在這裡，收到確認時要對得上
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outgoing {
    pub id: String,
    pub to_node: String,
    pub to_name: String,
    pub to_pub: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allowed,
    NotGranted,
    Unknown,
    KeyChanged,
}

/// 本機記的信任。純資料，不碰網路
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trust {
    #[serde(default)]
    pub peers: Vec<Peer>,
    #[serde(default)]
    pub outgoing: Vec<Outgoing>,
}

impl Trust {
    /// 讀不到檔案就是還沒配對過；**檔案壞了回錯誤，不當成空的：** 不然存檔時會把紀錄洗掉
    pub fn load(dir: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(dir.join(TRUST_FILE)) {
            Ok(t) => serde_json::from_str(&t).map_err(|_| "配對紀錄壞了".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Trust::default()),
            Err(e) => Err(format!("讀配對紀錄失敗：{e}")),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let path: PathBuf = dir.join(TRUST_FILE);
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::write_atomic(&path, &text).map_err(|e| format!("存配對紀錄失敗：{e}"))
    }

    pub fn peer(&self, node: &str) -> Option<&Peer> {
        self.peers.iter().find(|p| p.node == node)
    }

    pub fn key_changed(&self, node: &str, sign_pub: &str) -> bool {
        self.peer(node).is_some_and(|p| p.sign_pub != sign_pub)
    }

    /// 這台、這把公鑰、這個方向和範圍，可不可以
    pub fn check(&self, node: &str, sign_pub: &str, direction: Direction, scope: &str) -> Verdict {
        let Some(p) = self.peer(node) else { return Verdict::Unknown };
        if p.sign_pub != sign_pub {
            return Verdict::KeyChanged;
        }
        if p.grants.iter().any(|g| g.direction == direction && g.scope == scope) {
            Verdict::Allowed
        } else {
            Verdict::NotGranted
        }
    }

    /// 記下一個權限。已經認得這台但公鑰不同就拒絕：要本人先撤銷
    pub fn grant(&mut self, node: &str, name: &str, sign_pub: &str, direction: Direction, scope: &str) -> Result<(), String> {
        if self.key_changed(node, sign_pub) {
            return Err(KEY_CHANGED.to_string());
        }
        if self.peer(node).is_none() {
            self.peers.push(Peer { node: node.to_string(), name: name.to_string(), sign_pub: sign_pub.to_string(), view_pub: None, grants: Vec::new() });
        }
        let g = Grant { direction, scope: scope.to_string() };
        if let Some(p) = self.peers.iter_mut().find(|p| p.node == node) {
            p.name = name.to_string();
            if !p.grants.contains(&g) {
                p.grants.push(g);
            }
        }
        Ok(())
    }

    /// 記下對方的 Hello 公鑰。配對接上 Hello 時才會用到
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn set_view_pub(&mut self, node: &str, view_pub: &str) {
        if let Some(p) = self.peers.iter_mut().find(|p| p.node == node) {
            p.view_pub = Some(view_pub.to_string());
        }
    }

    /// 撤銷：整台忘掉，兩個方向都沒了。回有沒有這台
    pub fn revoke(&mut self, node: &str) -> bool {
        let before = self.peers.len();
        self.peers.retain(|p| p.node != node);
        before != self.peers.len()
    }
}

/// 我發起的配對收到確認：公鑰要和發起時記的相同，簽章也要對。對得上才算配對成功
pub fn outgoing_confirmed(o: &Outgoing, me_node: &str, me_pub: &str, row_to_pub: &str, sig: &str) -> bool {
    row_to_pub == o.to_pub && verify(&o.to_pub, &confirm_message(&o.id, me_node, &o.to_node, me_pub, &o.to_pub), sig)
}

/// 後台回的配對清單：（等我確認的, 我發起的）。**缺欄位或不是陣列就是錯誤：** 不能當成空的，
/// 否則本機等待中的配對會被當成已結束收掉
pub fn pair_lists(v: &serde_json::Value) -> Result<(&Vec<serde_json::Value>, &Vec<serde_json::Value>), String> {
    let list = |k: &str| v.get(k).and_then(serde_json::Value::as_array).ok_or_else(|| "後台回的資料不對".to_string());
    Ok((list("incoming")?, list("outgoing")?))
}

#[cfg(feature = "gui")]
pub mod live {
    //! 和後台的往來。讀寫本機檔案都在這把鎖裡，不跨 await
    use super::*;
    use crate::relay::Relay;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    pub fn key(dir: &Path) -> Result<DeviceKey, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_or_create(dir, protector().as_ref())
    }

    fn update<T>(dir: &Path, f: impl FnOnce(&mut Trust) -> Result<T, String>) -> Result<T, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut t = Trust::load(dir)?;
        let out = f(&mut t)?;
        t.save(dir)?;
        Ok(out)
    }

    pub fn read(dir: &Path) -> Result<Trust, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Trust::load(dir)
    }

    /// 上傳這台的公鑰（沒有金鑰就先建）
    pub async fn publish(relay: &Relay, dir: &Path) -> Result<(), String> {
        let k = key(dir)?;
        relay.api("device_key_publish", Some(json!({ "sign_pub": k.public_b64() }))).await.map(|_| ())
    }

    fn peers_view(t: &Trust, me_node: &str, me_pub: &str) -> Vec<Value> {
        let has = |p: &Peer, d: Direction| p.grants.iter().any(|g| g.direction == d && g.scope == SCOPE_VIEW);
        t.peers
            .iter()
            .map(|p| {
                json!({
                    "node": p.node, "name": p.name, "fingerprint": fingerprint(me_node, me_pub, &p.node, &p.sign_pub),
                    "peer_can_view_me": has(p, Direction::PeerToMe), "i_can_view_peer": has(p, Direction::MeToPeer),
                })
            })
            .collect()
    }

    /// 同步配對狀態，回給畫面。收到對方確認就在這裡驗簽章、記下來
    pub async fn sync(relay: &Relay, token: &str, dir: &Path, me_node: &str) -> Result<Value, String> {
        let k = key(dir)?;
        let me_pub = k.public_b64();
        let v = relay.api_signed("device_pair_list", None, Some(token)).await?;
        let (rows_in, rows_out) = pair_lists(&v)?;
        let mut outgoing = Vec::new();
        let mut done: Vec<String> = Vec::new();
        for row in rows_out {
            let (Some(id), Some(status)) = (row.get("id").and_then(Value::as_str), row.get("status").and_then(Value::as_str)) else { continue };
            let Some(o) = read(dir)?.outgoing.iter().find(|o| o.id == id).cloned() else {
                done.push(id.to_string()); // 這台沒有記錄（重裝前發的）：不算數
                continue;
            };
            let fp = fingerprint(me_node, &me_pub, &o.to_node, &o.to_pub);
            let mut shown = status.to_string();
            if status == "confirmed" {
                let sig = row.get("confirm_sig").and_then(Value::as_str).unwrap_or("");
                let to_pub = row.get("to_pub").and_then(Value::as_str).unwrap_or("");
                shown = if !outgoing_confirmed(&o, me_node, &me_pub, to_pub, sig) {
                    "bad_signature".to_string()
                } else {
                    match update(dir, |t| t.grant(&o.to_node, &o.to_name, &o.to_pub, Direction::MeToPeer, SCOPE_VIEW)) {
                        Ok(()) => "paired".to_string(),
                        Err(_) => "key_changed".to_string(),
                    }
                };
                update(dir, |t| {
                    t.outgoing.retain(|x| x.id != o.id);
                    Ok(())
                })?;
                done.push(id.to_string());
            }
            outgoing.push(json!({ "id": id, "to_node": o.to_node, "to_name": o.to_name, "fingerprint": fp, "status": shown }));
        }
        for id in done {
            let _ = relay.api_signed("device_pair_close", Some(json!({ "id": id })), Some(token)).await;
        }
        // 後台已經沒有的（對方 7 天內沒確認、這台太久沒開）：不留著假裝還在等，告訴本人一次
        let on_server: Vec<&str> = rows_out.iter().filter_map(|r| r.get("id").and_then(Value::as_str)).collect();
        let gone = update(dir, |t| {
            let gone: Vec<Outgoing> = t.outgoing.iter().filter(|o| !on_server.contains(&o.id.as_str())).cloned().collect();
            t.outgoing.retain(|o| on_server.contains(&o.id.as_str()));
            Ok(gone)
        })?;
        for o in gone {
            let fp = fingerprint(me_node, &me_pub, &o.to_node, &o.to_pub);
            outgoing.push(json!({ "id": o.id, "to_node": o.to_node, "to_name": o.to_name, "fingerprint": fp, "status": "expired" }));
        }
        let trust = read(dir)?;
        let incoming: Vec<Value> = rows_in
            .iter()
            .filter_map(|row| {
                let (id, from_node, from_pub, to_pub) = (row.get("id")?.as_str()?, row.get("from_node")?.as_str()?, row.get("from_pub")?.as_str()?, row.get("to_pub")?.as_str()?);
                Some(json!({
                    "id": id, "from_node": from_node, "from_name": row.get("from_name").and_then(Value::as_str).unwrap_or(""),
                    "fingerprint": fingerprint(from_node, from_pub, me_node, &me_pub),
                    "key_changed": trust.key_changed(from_node, from_pub),
                    "stale": to_pub != me_pub,
                    "expires_at": row.get("expires_at"),
                }))
            })
            .collect();
        Ok(json!({ "peers": peers_view(&trust, me_node, &me_pub), "incoming": incoming, "outgoing": outgoing }))
    }

    /// 在 D 發起配對。對方公鑰記下來，之後要對得上
    pub async fn start(relay: &Relay, token: &str, dir: &Path, to_node: &str) -> Result<(), String> {
        let k = key(dir)?;
        publish(relay, dir).await?;
        let v = relay.api_signed("device_pair_start", Some(json!({ "to_node": to_node, "from_pub": k.public_b64() })), Some(token)).await?;
        let (Some(id), Some(to_pub)) = (v.get("id").and_then(Value::as_str), v.get("to_pub").and_then(Value::as_str)) else {
            return Err("後台回的資料不對".into());
        };
        let to_name = v.get("to_name").and_then(Value::as_str).unwrap_or("").to_string();
        let row = Outgoing { id: id.to_string(), to_node: to_node.to_string(), to_name, to_pub: to_pub.to_string() };
        update(dir, |t| {
            if t.key_changed(to_node, to_pub) {
                return Err(KEY_CHANGED.to_string());
            }
            t.outgoing.retain(|o| o.to_node != to_node);
            t.outgoing.push(row);
            Ok(())
        })
    }

    /// 在 T 決定。確認才記下「對方可以看我」；後台成功了才記，後台失敗就什麼都不生效
    pub async fn decide(relay: &Relay, token: &str, dir: &Path, me_node: &str, id: &str, confirm: bool) -> Result<(), String> {
        if !confirm {
            relay.api_signed("device_pair_decide", Some(json!({ "id": id, "decision": "reject" })), Some(token)).await?;
            return Ok(());
        }
        let k = key(dir)?;
        let me_pub = k.public_b64();
        let v = relay.api_signed("device_pair_list", None, Some(token)).await?;
        let row = v.get("incoming").and_then(Value::as_array).and_then(|a| a.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id)).cloned()).ok_or("這筆配對已經結束了")?;
        let from_node = row.get("from_node").and_then(Value::as_str).ok_or("後台回的資料不對")?;
        let from_pub = row.get("from_pub").and_then(Value::as_str).ok_or("後台回的資料不對")?;
        let to_pub = row.get("to_pub").and_then(Value::as_str).ok_or("後台回的資料不對")?;
        let from_name = row.get("from_name").and_then(Value::as_str).unwrap_or("");
        if to_pub != me_pub {
            return Err("這筆配對是用這台舊的金鑰發起的，請對方重新發起".into());
        }
        if read(dir)?.key_changed(from_node, from_pub) {
            return Err(KEY_CHANGED.to_string());
        }
        let sig = k.sign_b64(&confirm_message(id, from_node, me_node, from_pub, &me_pub));
        relay.api_signed("device_pair_decide", Some(json!({ "id": id, "decision": "confirm", "sig": sig })), Some(token)).await?;
        update(dir, |t| t.grant(from_node, from_name, from_pub, Direction::PeerToMe, SCOPE_VIEW))
    }

    /// 在 D 撤回或收掉結果
    pub async fn close(relay: &Relay, token: &str, dir: &Path, id: &str) -> Result<(), String> {
        update(dir, |t| {
            t.outgoing.retain(|o| o.id != id);
            Ok(())
        })?;
        match relay.api_signed("device_pair_close", Some(json!({ "id": id })), Some(token)).await {
            Err(e) if !e.contains("not_found") => Err(e),
            _ => Ok(()), // 後台已經沒有這筆，就是收掉了
        }
    }

    /// 撤銷一台：只動本機。信任只看本機記的，所以這裡撤了就生效
    pub fn revoke(dir: &Path, node: &str) -> Result<bool, String> {
        update(dir, |t| Ok(t.revoke(node)))
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
    fn 金鑰_第一次建_之後讀回同一把_檔案裡不是明文() {
        let d = tempfile::tempdir().unwrap();
        let a = load_or_create(d.path(), &Flip).unwrap();
        let b = load_or_create(d.path(), &Flip).unwrap();
        assert_eq!(a.public_b64(), b.public_b64());
        let raw = B64.decode(std::fs::read_to_string(d.path().join(KEY_FILE)).unwrap()).unwrap();
        assert!(Ed25519KeyPair::from_pkcs8(&raw).is_err(), "存的是包過的");
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
    fn 指紋_兩邊算出來相同_十位元組_分組_公鑰或節點不同就不同() {
        let f = fingerprint("aaa", "p1", "bbb", "p2");
        assert_eq!(f, fingerprint("bbb", "p2", "aaa", "p1"));
        assert_eq!(f.len(), 24, "{f}");
        assert_eq!(f.split('-').count(), 5);
        assert_ne!(f, fingerprint("aaa", "p9", "bbb", "p2"));
        assert_ne!(f, fingerprint("aaa", "p2", "bbb", "p1"), "公鑰對調");
        assert_ne!(f, fingerprint("aaa", "p1", "ccc", "p2"));
    }

    #[test]
    fn 權限分方向_我可以看對方_不代表對方可以看我() {
        let mut t = Trust::default();
        t.grant("t", "家用機", "pk", Direction::MeToPeer, SCOPE_VIEW).unwrap();
        assert_eq!(t.check("t", "pk", Direction::MeToPeer, SCOPE_VIEW), Verdict::Allowed);
        assert_eq!(t.check("t", "pk", Direction::PeerToMe, SCOPE_VIEW), Verdict::NotGranted);
        assert_eq!(t.check("t", "pk", Direction::MeToPeer, "input"), Verdict::NotGranted, "範圍也分開");
        assert_eq!(t.check("別台", "pk", Direction::MeToPeer, SCOPE_VIEW), Verdict::Unknown);
    }

    #[test]
    fn 公鑰變了_警告並停止_要撤銷才能重新配對() {
        let mut t = Trust::default();
        t.grant("t", "家用機", "pk", Direction::PeerToMe, SCOPE_VIEW).unwrap();
        assert_eq!(t.check("t", "新", Direction::PeerToMe, SCOPE_VIEW), Verdict::KeyChanged);
        assert_eq!(t.grant("t", "家用機", "新", Direction::PeerToMe, SCOPE_VIEW).unwrap_err(), KEY_CHANGED);
        assert_eq!(t.peer("t").unwrap().sign_pub, "pk", "沒有被蓋掉");
        assert!(t.revoke("t"));
        assert!(!t.revoke("t"));
        t.grant("t", "家用機", "新", Direction::PeerToMe, SCOPE_VIEW).unwrap();
        assert_eq!(t.check("t", "新", Direction::PeerToMe, SCOPE_VIEW), Verdict::Allowed);
    }

    #[test]
    fn 同一個權限記兩次只留一筆() {
        let mut t = Trust::default();
        t.grant("t", "甲", "pk", Direction::PeerToMe, SCOPE_VIEW).unwrap();
        t.grant("t", "乙", "pk", Direction::PeerToMe, SCOPE_VIEW).unwrap();
        assert_eq!(t.peer("t").unwrap().grants.len(), 1);
        assert_eq!(t.peer("t").unwrap().name, "乙");
    }

    #[test]
    fn 確認_公鑰和發起時相同_簽章對_才算() {
        let dt = tempfile::tempdir().unwrap();
        let kt = load_or_create(dt.path(), &Flip).unwrap();
        let o = Outgoing { id: "r1".into(), to_node: "t".into(), to_name: "家用機".into(), to_pub: kt.public_b64() };
        let good = kt.sign_b64(&confirm_message("r1", "d", "t", "dpub", &o.to_pub));
        assert!(outgoing_confirmed(&o, "d", "dpub", &o.to_pub, &good));
        assert!(!outgoing_confirmed(&o, "d", "dpub", "別的公鑰", &good), "後台換了公鑰");
        assert!(!outgoing_confirmed(&o, "d", "別的", &o.to_pub, &good), "簽的是別把公鑰");
        assert!(!outgoing_confirmed(&o, "x", "dpub", &o.to_pub, &good), "簽的是別台");
        assert!(!outgoing_confirmed(&o, "d", "dpub", &o.to_pub, ""), "沒有簽章");
        let other = kt.sign_b64(&confirm_message("r2", "d", "t", "dpub", &o.to_pub));
        assert!(!outgoing_confirmed(&o, "d", "dpub", &o.to_pub, &other), "別筆的簽章");
    }

    #[test]
    fn 後台清單_缺欄位或型別不對就是錯誤_不當成空的() {
        use serde_json::json;
        assert!(pair_lists(&json!({ "incoming": [], "outgoing": [] })).is_ok());
        for bad in [json!({}), json!({ "incoming": [] }), json!({ "outgoing": [] }), json!({ "incoming": [], "outgoing": null }), json!({ "incoming": {}, "outgoing": [] }), json!(null)] {
            assert!(pair_lists(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn 信任檔_存讀一致_沒有檔案是空的_壞了回錯誤不洗掉() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Trust::load(d.path()).unwrap(), Trust::default());
        let mut t = Trust::default();
        t.grant("t", "家用機", "pk", Direction::MeToPeer, SCOPE_VIEW).unwrap();
        t.save(d.path()).unwrap();
        assert_eq!(Trust::load(d.path()).unwrap(), t);
        std::fs::write(d.path().join(TRUST_FILE), "{壞的").unwrap();
        assert!(Trust::load(d.path()).is_err());
    }

    #[test]
    fn 守門_入口只有畫面的命令_橋_cli_手機都接不到() {
        for src in [include_str!("bridge/mod.rs"), include_str!("bridge/launcher.rs"), include_str!("cli/mod.rs"), include_str!("android.rs")] {
            assert!(!src.contains("device_id::"), "不能從這裡碰設備金鑰");
        }
    }
}
