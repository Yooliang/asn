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
    /// 本人在這台的打字確認框，對這把公鑰按過「允許」（0.2.15）。看畫面不會設；忘記後重新記住會重來。
    /// 0.2.10 手動勾過 input_no_ask 的，也算按過（本人當時明確同意）
    #[serde(default)]
    pub input_confirmed: bool,
    /// 本人在設定頁把「打字不用每次問我」關掉（0.2.15 起預設是開）
    #[serde(default)]
    pub input_always_ask: bool,
    /// 允許這支手機替這台登入別家 CLI（#933）。**只有這台的設定頁能改**（守門測試）；不送後台、不同步。
    /// 舊檔沒有這欄、第一次記住、忘記後重新記住，一律是不允許：記住了公鑰不等於允許登入
    #[serde(default)]
    pub login_ok: bool,
    /// 本人在手機上對照過這台電腦的指紋、按了「記住這台」的時間（毫秒）。沒有＝還沒確認；舊檔沒有這欄＝還沒確認。
    /// 只記在這支手機，不送後台、不同步；只對記住的那把公鑰有效（公鑰換了會被擋，要忘記才能重來）
    #[serde(default)]
    pub confirmed_at: Option<u64>,
    /// 手機確認指紋用的四個選項與正確的是第幾個：每台電腦（這把公鑰）只出一次、之後每次都是同一組同一個順序；
    /// 忘記再重新記住才會重出。**不進任何給畫面的資料**（守門測試）；舊檔沒有這欄＝第一次出題時才產生
    #[serde(default)]
    pub pick: Option<PickSet>,
    /// 四選一累計答錯幾次（2 次就擋住，只有忘記才清掉；確認成功歸零）。**只有答題、確認、忘記三條路能改**（守門測試）
    #[serde(default)]
    pub pick_wrong: u8,
    /// 第一次答錯、鎖住那一刻的牆上時間（毫秒）。時鐘被往回撥時，比這個還早也算還在鎖
    #[serde(default)]
    pub pick_lock_set_ms: Option<u64>,
    /// 鎖到什麼時候（毫秒）
    #[serde(default)]
    pub pick_lock_until_ms: Option<u64>,
    /// 名字是本人自己改的：之後連線帶來的名字不再蓋掉它。**只有 rename_peer 能設**（守門測試）；舊檔沒有這欄＝不是
    #[serde(default)]
    pub named_by_owner: bool,
}

/// 本人替電腦取的名字最多幾個字
pub const OWNER_NAME_MAX: usize = 32;

/// 整理本人輸入的名字：控制字元、改變文字方向的字元換成空白，去頭尾空白，最多 32 個字。空字串＝沒有名字（畫面顯示「未命名的電腦」）
pub fn clean_owner_name(s: &str) -> String {
    let bad = |c: char| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}');
    s.chars().map(|c| if bad(c) { ' ' } else { c }).collect::<String>().trim().chars().take(OWNER_NAME_MAX).collect::<String>().trim().to_string()
}

/// 答錯一次之後鎖多久（毫秒）：10 分鐘
pub const PICK_LOCK_MS: u64 = 10 * 60 * 1000;
/// 答錯幾次就擋住
pub const PICK_WRONG_LIMIT: u8 = 2;

/// 四選一的固定選項
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PickSet {
    /// 四組分組指紋（含一組正確的）
    pub options: Vec<String>,
    /// 正確的是第幾個（從 0 起）
    pub answer: usize,
}

/// 現在能不能對這台出四選一
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickGate {
    Open,
    /// 鎖住中，還要等幾分鐘（進位到整分鐘）
    Locked { minutes: u64 },
    /// 答錯兩次或回答「都不一樣」：要忘記那台才能重來
    Blocked,
}

impl KnownPeer {
    /// 時鐘被往回撥（現在比鎖住那刻還早）也算還在鎖
    #[allow(dead_code)]
    fn pick_gate(&self, now_ms: u64) -> PickGate {
        if self.pick_wrong >= PICK_WRONG_LIMIT {
            return PickGate::Blocked;
        }
        // 鎖到期前都算鎖住；時鐘倒退到上鎖之前，也一定早於到期時間（到期＝上鎖＋10 分鐘），所以照樣鎖住
        if !self.pick_lock_until_ms.is_some_and(|u| now_ms < u) {
            return PickGate::Open;
        }
        let left = self.pick_lock_until_ms.unwrap_or(now_ms).saturating_sub(now_ms);
        PickGate::Locked { minutes: left.div_ceil(60_000).max(1) }
    }

    /// 選項是這把公鑰的、四個、答案位置對的才算有效（檔案被改壞就重出）
    #[allow(dead_code)]
    fn pick_valid(&self) -> bool {
        let want = fp_grouped(&self.sign_pub);
        self.pick.as_ref().is_some_and(|s| s.options.len() == 4 && s.options.get(s.answer) == Some(&want))
    }
}

/// 手機上要不要讓這台電腦接受打字：只有本人確認過指紋的才行（沒記住、沒確認都不行）
pub fn phone_input_allowed(peer: Option<&KnownPeer>) -> bool {
    peer.is_some_and(|p| p.confirmed_at.is_some())
}

/// 指紋前 8 個字元（畫面上顯示、給本人比對的那一段）
pub fn fp8(sign_pub: &str) -> String {
    fingerprint(sign_pub).chars().take(8).collect()
}

/// 給人核對用的完整指紋：16 個字元，每 4 個一組用空格隔開（例如「a93c c519 1f2e 3b4d」）。前 8 碼只拿來辨認，核對一律用這個
pub fn fp_grouped(sign_pub: &str) -> String {
    let fp: Vec<char> = fingerprint(sign_pub).chars().collect();
    fp.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" ")
}

/// 手機設定頁「認得的電腦」的列表：名字、節點、有沒有確認過；**只有確認過的才帶完整指紋 fp**（沒確認的電腦，畫面不能知道它的指紋，不然四選一就沒意義）。**不含公鑰**
pub fn phone_known_view(k: &KnownPeers) -> serde_json::Value {
    serde_json::json!({ "peers": k.peers.iter().map(|p| {
        let mut v = serde_json::json!({ "node": p.node, "name": p.name, "confirmed": p.confirmed_at.is_some() });
        if p.confirmed_at.is_some() {
            v["fp"] = serde_json::json!(fingerprint(&p.sign_pub));
        }
        v
    }).collect::<Vec<_>>() })
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

    /// 本人替這台改名（只改本機的名字，不動公鑰、確認、四選一的紀錄）。名字先整理過；空字串＝未命名。**只有 rename_peer 的兩個命令能叫**（守門測試）。回有沒有這台
    pub fn rename_peer(&mut self, node: &str, name: &str) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) => {
                p.name = clean_owner_name(name);
                p.named_by_owner = true;
                true
            }
            None => false,
        }
    }

    /// 記住一台。已經記過同一把就只更新名字（本人改過名的除外）；記過不同的一把是錯誤（要本人先忘記）
    pub fn remember(&mut self, node: &str, name: &str, sign_pub: &str, now_ms: u64) -> Result<(), String> {
        match self.check(node, sign_pub) {
            Tofu::Changed => Err(KEY_CHANGED.to_string()),
            Tofu::Same => {
                if let Some(p) = self.peers.iter_mut().find(|p| p.node == node) {
                    // 本人自己取的名字不被後來連線帶的名字蓋掉
                    if !p.named_by_owner {
                        p.name = name.to_string();
                    }
                }
                Ok(())
            }
            Tofu::New => {
                self.peers.push(KnownPeer { node: node.to_string(), name: name.to_string(), sign_pub: sign_pub.to_string(), first_seen_ms: now_ms, input_no_ask: false, input_confirmed: false, input_always_ask: false, login_ok: false, confirmed_at: None, pick: None, pick_wrong: 0, pick_lock_set_ms: None, pick_lock_until_ms: None, named_by_owner: false });
                Ok(())
            }
        }
    }

    /// 設定頁「這台要在這裡打字時，不用每次問我」（本機設定頁才能改）。關掉＝每次都問；打開不等於按過允許。回有沒有這台
    pub fn set_input_no_ask(&mut self, node: &str, on: bool) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) => {
                p.input_always_ask = !on;
                if !on {
                    p.input_no_ask = false;
                }
                true
            }
            None => false,
        }
    }

    /// 本人對這把公鑰按過「允許」打字（0.2.10 手動勾過的也算）
    pub fn input_confirmed(&self, node: &str) -> bool {
        self.peer(node).is_some_and(|p| p.input_confirmed || p.input_no_ask)
    }

    /// 這台打字可以不問嗎：認得、本人對這把公鑰按過允許、而且沒有設成每次都問。
    /// 呼叫端還要確認這次的公鑰就是記住的那把（Tofu::Same）
    pub fn input_no_ask(&self, node: &str) -> bool {
        self.input_confirmed(node) && self.peer(node).is_some_and(|p| !p.input_always_ask)
    }

    /// 本人在打字確認框按了「允許」：記下這把公鑰按過（不是記住的那把就不記）。回有沒有記到
    pub fn confirm_input(&mut self, node: &str, sign_pub: &str) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) if p.sign_pub == sign_pub => {
                p.input_confirmed = true;
                true
            }
            _ => false,
        }
    }

    /// 允不允許這支手機替這台登入（本機設定頁才能改）。回有沒有改到。
    /// 打開時要帶確認框上給本人看的那把公鑰：框開著時這台被忘記、又用別把金鑰重新記住，就不改
    pub fn set_login_ok(&mut self, node: &str, on: bool, shown_pub: Option<&str>) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) if on && shown_pub != Some(p.sign_pub.as_str()) => false,
            Some(p) => {
                p.login_ok = on;
                true
            }
            None => false,
        }
    }

    /// 本人在手機上對照過指紋、按了「記住這台」：只有這台記住的公鑰算出來的指紋（16 個字元）完全一樣才記。回有沒有記到
    /// 還鎖著或已經擋住的不記（答錯之後不能靠之前選對留著的題目繞過去）；記成功就把答錯次數與鎖清掉
    pub fn confirm(&mut self, node: &str, fp16: &str, now_ms: u64) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) if fingerprint(&p.sign_pub) == fp16 && p.pick_gate(now_ms) == PickGate::Open => {
                p.confirmed_at = Some(now_ms);
                p.pick_wrong = 0;
                p.pick_lock_set_ms = None;
                p.pick_lock_until_ms = None;
                true
            }
            _ => false,
        }
    }

    /// 現在能不能對這台出四選一；沒記住這台回 None
    #[allow(dead_code)]
    pub fn pick_gate(&self, node: &str, now_ms: u64) -> Option<PickGate> {
        self.peer(node).map(|p| p.pick_gate(now_ms))
    }

    /// 這台的固定選項：沒有（或壞了）就用 make 產生一次存進紀錄。回（選項、是不是剛產生的＝呼叫端要存檔）；沒記住這台回 None
    #[allow(dead_code)]
    pub fn ensure_pick(&mut self, node: &str, make: impl FnOnce(&str) -> Result<(Vec<String>, usize), String>) -> Result<Option<(PickSet, bool)>, String> {
        let Some(p) = self.peers.iter_mut().find(|p| p.node == node) else { return Ok(None) };
        if p.pick_valid() {
            return Ok(p.pick.clone().map(|s| (s, false)));
        }
        let (options, answer) = make(&fingerprint(&p.sign_pub))?;
        let set = PickSet { options, answer };
        p.pick = Some(set.clone());
        Ok(Some((set, true)))
    }

    /// 答錯一次：第一次鎖 10 分鐘、第二次擋住。**只有 android_known_answer 能叫**（守門測試）。回有沒有這台
    #[allow(dead_code)]
    pub fn pick_record_wrong(&mut self, node: &str, now_ms: u64) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) => {
                p.pick_wrong = p.pick_wrong.saturating_add(1).min(PICK_WRONG_LIMIT);
                if p.pick_wrong < PICK_WRONG_LIMIT {
                    p.pick_lock_set_ms = Some(now_ms);
                    p.pick_lock_until_ms = Some(now_ms.saturating_add(PICK_LOCK_MS));
                }
                true
            }
            None => false,
        }
    }

    /// 回答「都不一樣」：直接擋住。**只有 android_known_answer 能叫**（守門測試）。回有沒有這台
    #[allow(dead_code)]
    pub fn pick_block(&mut self, node: &str) -> bool {
        match self.peers.iter_mut().find(|p| p.node == node) {
            Some(p) => {
                p.pick_wrong = PICK_WRONG_LIMIT;
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

    /// 出題前的準備結果（只在 Rust 內部傳，不序列化給畫面）
    #[allow(dead_code)]
    pub struct PickPrep {
        pub gate: PickGate,
        pub sign_pub: String,
        pub answer: usize,
        pub options: Vec<String>,
    }

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

    /// 本人替這台改名：**只有 device_known_rename、android_known_rename 能叫**（守門測試）
    pub fn rename_peer(dir: &Path, node: &str, name: &str) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let found = k.rename_peer(node, name);
        if found {
            k.save(dir)?;
        }
        Ok(found)
    }

    /// 這台在本機記的名字（可能是空的）；沒記住這台回 None
    pub fn local_name(dir: &Path, node: &str) -> Result<Option<String>, String> {
        Ok(known(dir)?.peer(node).map(|p| p.name.clone()))
    }

    /// 本人在手機上按了「記住這台」：**只有手機的 android_known_confirm 能叫**（守門測試）
    pub fn confirm(dir: &Path, node: &str, fp16: &str, now_ms: u64) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let done = k.confirm(node, fp16, now_ms);
        if done {
            k.save(dir)?;
        }
        Ok(done)
    }

    /// 出題前的準備（手機）：現在能不能出；能的話回這台固定的四個選項與答案位置（沒有就用 make 產生一次、存檔）。
    /// 全程在同一把鎖裡。沒記住這台回 None。**答案只給呼叫的 Rust 命令，不進任何畫面資料**
    #[allow(dead_code)]
    pub fn pick_prepare(dir: &Path, node: &str, now_ms: u64, make: impl FnOnce(&str) -> Result<(Vec<String>, usize), String>) -> Result<Option<PickPrep>, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let Some(gate) = k.pick_gate(node, now_ms) else { return Ok(None) };
        let sign_pub = k.peer(node).map(|p| p.sign_pub.clone()).unwrap_or_default();
        if gate != PickGate::Open {
            return Ok(Some(PickPrep { gate, sign_pub, answer: 0, options: Vec::new() }));
        }
        let Some((set, created)) = k.ensure_pick(node, make)? else { return Ok(None) };
        if created {
            k.save(dir)?;
        }
        Ok(Some(PickPrep { gate, sign_pub, answer: set.answer, options: set.options }))
    }

    /// 現在能不能回答這台的題目；沒記住這台回 None
    #[allow(dead_code)]
    pub fn pick_gate(dir: &Path, node: &str, now_ms: u64) -> Result<Option<PickGate>, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(KnownPeers::load(dir)?.pick_gate(node, now_ms))
    }

    /// 答錯一次（鎖 10 分鐘或擋住）：**只有 android_known_answer 能叫**（守門測試）
    #[allow(dead_code)]
    pub fn pick_record_wrong(dir: &Path, node: &str, now_ms: u64) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let found = k.pick_record_wrong(node, now_ms);
        if found {
            k.save(dir)?;
        }
        Ok(found)
    }

    /// 回答「都不一樣」：直接擋住。**只有 android_known_answer 能叫**（守門測試）
    #[allow(dead_code)]
    pub fn pick_block(dir: &Path, node: &str) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let found = k.pick_block(node);
        if found {
            k.save(dir)?;
        }
        Ok(found)
    }

    /// 手機設定頁的列表（不含完整公鑰）
    pub fn phone_view(dir: &Path) -> Result<Value, String> {
        Ok(phone_known_view(&known(dir)?))
    }

    /// 本人在打字確認框按了「允許」：**只有收到打字請求、本人按了允許的那條路能叫**（守門測試）
    pub fn confirm_input(dir: &Path, node: &str, sign_pub: &str) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let done = k.confirm_input(node, sign_pub);
        if done {
            k.save(dir)?;
        }
        Ok(done)
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
    pub fn set_login_ok(dir: &Path, node: &str, on: bool, shown_pub: Option<&str>) -> Result<bool, String> {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut k = KnownPeers::load(dir)?;
        let found = k.set_login_ok(node, on, shown_pub);
        if found {
            k.save(dir)?;
        }
        Ok(found)
    }

    /// 設定頁要的列表：名字、指紋、第一次記住的時間、打字要不要每次問、允不允許替這台登入
    pub fn view(dir: &Path) -> Result<Value, String> {
        let k = known(dir)?;
        Ok(json!({ "peers": k.peers.iter().map(|p| json!({ "node": p.node, "name": p.name, "fingerprint": fingerprint(&p.sign_pub), "first_seen_ms": p.first_seen_ms, "input_no_ask": !p.input_always_ask, "input_confirmed": p.input_confirmed || p.input_no_ask, "login_ok": p.login_ok })).collect::<Vec<_>>() }))
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
    fn 打字不用問_要本人對這把公鑰按過允許_看畫面記住的不算_關掉就每次問_忘記就重來() {
        let mut k = KnownPeers::default();
        k.remember("d", "工作機", "pk", 1).unwrap();
        assert!(!k.input_no_ask("d"), "只是記住（例如看過畫面）：要問");
        assert!(!k.input_no_ask("沒有"), "不認得：要問");
        assert!(!k.confirm_input("d", "別把"), "不是記住的那把：不記");
        assert!(!k.input_no_ask("d"));
        assert!(k.confirm_input("d", "pk"));
        assert!(k.input_no_ask("d"), "按過允許：預設之後不問");
        k.remember("d", "改名", "pk", 2).unwrap();
        assert!(k.input_no_ask("d"), "同一把再看到一次：不變");
        assert!(k.set_input_no_ask("d", false));
        assert!(!k.input_no_ask("d"), "本人關掉：每次都問");
        assert!(k.set_input_no_ask("d", true));
        assert!(k.input_no_ask("d"), "再打開：按過允許的照樣不問");
        assert!(!k.set_input_no_ask("沒有", true), "不認得的不能設");
        k.forget("d");
        k.remember("d", "工作機", "pk", 3).unwrap();
        assert!(!k.input_no_ask("d"), "忘記之後重新記住：又要問一次");
        let old: KnownPeers = serde_json::from_str(r#"{"peers":[{"node":"d","name":"n","sign_pub":"pk","first_seen_ms":1}]}"#).unwrap();
        assert!(!old.input_no_ask("d"), "0.2.8 的檔：要問");
        let mut v10: KnownPeers = serde_json::from_str(r#"{"peers":[{"node":"d","name":"n","sign_pub":"pk","first_seen_ms":1,"input_no_ask":true}]}"#).unwrap();
        assert!(v10.input_no_ask("d") && v10.input_confirmed("d"), "0.2.10 手動勾過：當成按過允許");
        v10.set_input_no_ask("d", false);
        v10.set_input_no_ask("d", true);
        assert!(!v10.input_no_ask("d"), "0.2.10 的勾關掉過：舊的同意就不算了，要再按一次允許");
    }

    #[test]
    fn 允許替這台登入_預設不允許_舊檔也不允許_記住同一把不會蓋掉_忘記就重來() {
        let mut k = KnownPeers::default();
        k.remember("p", "手機", "pk", 1).unwrap();
        assert!(!k.login_ok("p"), "第一次記住（例如看過畫面）：不允許");
        assert!(!k.login_ok("沒有"));
        assert!(!k.set_login_ok("p", true, None), "打開一定要帶給本人看過的公鑰");
        assert!(!k.set_login_ok("p", true, Some("別把")), "確認框開著時換了金鑰：不改");
        assert!(!k.login_ok("p"));
        assert!(k.set_login_ok("p", true, Some("pk")));
        assert!(!k.set_login_ok("沒有", true, Some("pk")), "不認得的不能設");
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
    fn 手機確認指紋_要完全一樣才記_舊檔是沒確認_第一次記住是沒確認() {
        let mut k = KnownPeers::default();
        k.remember("pc", "工作機", "pk", 1).unwrap();
        assert!(!phone_input_allowed(k.peer("pc")) && !phone_input_allowed(None), "沒確認、沒記住都不能打字");
        let fp = fingerprint("pk");
        assert!(!k.confirm("pc", &fp[..8], 9), "只有前 8 碼不算");
        assert!(!k.confirm("pc", &fingerprint("別把"), 9), "別把公鑰的指紋不算");
        assert!(!k.confirm("zz", &fp, 9), "沒記住的電腦不算");
        assert_eq!(k.peer("pc").unwrap().confirmed_at, None);
        assert!(k.confirm("pc", &fp, 9));
        assert_eq!(k.peer("pc").unwrap().confirmed_at, Some(9));
        assert!(phone_input_allowed(k.peer("pc")));
        // 同一把再記住不會蓋掉確認；忘記之後重來又是沒確認
        k.remember("pc", "新名字", "pk", 20).unwrap();
        assert!(phone_input_allowed(k.peer("pc")));
        assert!(k.forget("pc"));
        k.remember("pc", "工作機", "pk", 30).unwrap();
        assert!(!phone_input_allowed(k.peer("pc")));
        let old: KnownPeers = serde_json::from_str(r#"{"peers":[{"node":"d","name":"n","sign_pub":"pk","first_seen_ms":1}]}"#).unwrap();
        assert_eq!(old.peer("d").unwrap().confirmed_at, None, "舊檔沒有這欄：沒確認");
        let back: KnownPeers = serde_json::from_str(&serde_json::to_string(&k).unwrap()).unwrap();
        assert_eq!(back, k);
    }

    #[test]
    fn 手機的認得的電腦列表_沒確認的不帶指紋_確認過的才帶() {
        let mut k = KnownPeers::default();
        k.remember("pc", "工作機", "pk", 1).unwrap();
        k.remember("pc2", "辦公室", "pk2", 1).unwrap();
        let v = phone_known_view(&k);
        let p = &v["peers"][0];
        assert_eq!((p["name"].as_str(), p["node"].as_str(), p["confirmed"].as_bool()), (Some("工作機"), Some("pc"), Some(false)));
        assert_eq!(p.as_object().unwrap().len(), 3, "沒確認的：只有 node／name／confirmed");
        assert!(p.get("fp").is_none() && p.get("fp8").is_none());
        let fp = fingerprint("pk2");
        assert!(k.confirm("pc2", &fp, 5));
        let v = phone_known_view(&k);
        let q = &v["peers"][1];
        assert_eq!(q["fp"].as_str(), Some(fp.as_str()), "確認過的帶完整指紋");
        assert!(q.get("fp8").is_none());
        assert_eq!(v["peers"][0].get("fp"), None, "沒確認的仍然沒有");
        let text = v.to_string();
        assert!(!text.contains("\"pk\"") && !text.contains("\"pk2\"") && !text.contains(&fingerprint("pk")), "不含公鑰、沒確認那台的指紋：{text}");
        let g = fp_grouped("pk");
        assert_eq!(g.split(' ').count(), 4);
        assert_eq!(g.replace(' ', ""), fingerprint("pk"));
    }

    #[test]
    fn 守門_手機確認與忘記只有兩個命令能叫_橋_收發室不碰() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let rs = std::fs::read_to_string(root.join("android.rs")).unwrap().replace("\r\n", "\n");
        let code = rs.split("\n#[cfg(test)]").next().unwrap();
        let owners = |pat: &str| -> Vec<String> { code.match_indices(pat).map(|(i, _)| owner_at(code, i)).collect() };
        let confirm = owners("live::confirm(");
        assert!(!confirm.is_empty() && confirm.iter().all(|f| f == "android_known_confirm"), "{confirm:?}");
        let forget = owners("live::forget(");
        assert!(!forget.is_empty() && forget.iter().all(|f| f == "android_known_forget"), "{forget:?}");
        for f in ["bridge/mod.rs", "bridge/launcher.rs", "cli/mod.rs", "headless.rs", "view_d.rs", "view_remote.rs", "relay.rs"] {
            if let Ok(s) = std::fs::read_to_string(root.join(f)) {
                let s = s.split("\n#[cfg(test)]").next().unwrap().to_string();
                assert!(!s.contains("live::confirm(") && !s.contains("known.confirm("), "{f} 不能確認指紋");
            }
        }
        let lib = std::fs::read_to_string(root.join("lib.rs")).unwrap();
        let lib = lib.split("\nmod tests {").next().unwrap();
        assert!(!lib.contains("live::confirm("), "lib.rs 不能確認指紋");
    }

    /// 這個位置落在哪個函式裡（往前找最近的 fn 宣告）
    fn owner_at(code: &str, i: usize) -> String {
        let before = &code[..i];
        let start = ["\npub async fn ", "\npub fn ", "\nasync fn ", "\nfn "].iter().filter_map(|p| before.rfind(p).map(|at| (at, p.len()))).max();
        match start {
            Some((at, len)) => before[at + len..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect(),
            None => String::new(),
        }
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
        let confirm = fns("device_id::live::confirm_input(");
        assert!(!confirm.is_empty() && confirm.iter().all(|f| f == "start_view_poller"), "按過允許只在收到打字請求、本人按了允許那裡記：{confirm:?}");
        let no_ask = fns("device_id::live::set_input_no_ask(");
        assert!(!no_ask.is_empty() && no_ask.iter().all(|f| f == "device_known_input_no_ask"), "打字不用問只能從設定頁的命令：{no_ask:?}");
        let login_ok = fns("device_id::live::set_login_ok(");
        assert!(!login_ok.is_empty() && login_ok.iter().all(|f| f == "device_known_login_ok"), "允許替這台登入只能從設定頁的命令：{login_ok:?}");
        assert_eq!(lib.matches("set_login_ok(").count(), 2, "lib.rs 只有設定頁的命令會改（打開、關掉各一處）");
        let see = fns("device_id::live::see(");
        assert!(!see.is_empty() && see.iter().all(|f| f == "start_view_poller" || f == "start_remote_view" || f == "view_backend_see"), "記住只在收到請求（T）或看的那台驗過 T 的簽章時：{see:?}");
        for f in ["bridge/mod.rs", "bridge/launcher.rs", "cli/mod.rs", "headless.rs"] {
            let s = std::fs::read_to_string(root.join(f)).unwrap();
            assert!(!s.contains("live::forget") && !s.contains("live::see") && !s.contains("set_input_no_ask") && !s.contains("set_login_ok"), "{f} 不能改認得的電腦");
        }
    }

    // ---- 手機：四選一的固定選項、答錯的限制 ----

    /// 固定亂數（不同種子給不同序列）
    fn xs(seed: u64) -> impl FnMut(&mut [u8]) {
        let mut s = (seed << 1) | 1;
        move |buf: &mut [u8]| {
            for b in buf.iter_mut() {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                *b = (s >> 24) as u8;
            }
        }
    }

    fn pick_of(k: &mut KnownPeers, node: &str, seed: u64) -> (PickSet, bool) {
        k.ensure_pick(node, |fp| Ok(crate::known_pick::make_options(fp, xs(seed)))).unwrap().unwrap()
    }

    fn one_peer() -> KnownPeers {
        let mut k = KnownPeers::default();
        k.remember("pc", "工作機", "pk", 1).unwrap();
        k
    }

    #[test]
    fn 固定選項_每台只出一次_同一組同一順序_存檔讀回一樣_忘記再記住才重出() {
        let mut k = one_peer();
        assert!(k.peer("pc").unwrap().pick.is_none(), "新記住的：還沒有選項");
        assert_eq!(k.ensure_pick("沒有", |_| Ok((Vec::new(), 0))), Ok(None), "沒記住的不出");
        assert_eq!(k.ensure_pick("pc", |_| Err("系統亂數不可用".to_string())), Err("系統亂數不可用".to_string()), "取不到亂數：回錯誤、不存");
        assert!(k.peer("pc").unwrap().pick.is_none());
        let (a, created) = pick_of(&mut k, "pc", 1);
        assert!(created);
        assert_eq!(a.options.len(), 4);
        assert_eq!(a.options[a.answer], fp_grouped("pk"));
        for seed in 2..30u64 {
            let (b, again) = pick_of(&mut k, "pc", seed);
            assert!(!again, "已經有了就不再產生");
            assert_eq!(b, a, "每次都是同一組、同一個順序");
        }
        let d = tempfile::tempdir().unwrap();
        k.save(d.path()).unwrap();
        let mut back = KnownPeers::load(d.path()).unwrap();
        assert_eq!(back, k);
        assert_eq!(pick_of(&mut back, "pc", 99), (a.clone(), false), "重開 App 讀回的還是同一組");
        k.remember("pc", "改名", "pk", 5).unwrap();
        assert_eq!(k.peer("pc").unwrap().pick, Some(a.clone()), "同一把再看到：選項不變");
        assert!(k.forget("pc"));
        k.remember("pc", "工作機", "pk", 9).unwrap();
        assert!(k.peer("pc").unwrap().pick.is_none(), "忘記再記住：重新來過");
        let (b, created) = pick_of(&mut k, "pc", 77);
        assert!(created && b != a, "重出一組新的");
        // 檔案被改壞（不是四個、或答案位置不是這把公鑰的指紋）就重出
        k.peers[0].pick.as_mut().unwrap().options.truncate(3);
        assert!(pick_of(&mut k, "pc", 5).1);
        let bad_answer = (k.peers[0].pick.as_ref().unwrap().answer + 1) % 4;
        k.peers[0].pick.as_mut().unwrap().answer = bad_answer;
        assert!(pick_of(&mut k, "pc", 6).1);
        let ok = k.peers[0].pick.clone().unwrap();
        assert_eq!(ok.options[ok.answer], fp_grouped("pk"));
    }

    #[test]
    fn 答錯_第一次鎖十分鐘_第二次擋住_只有忘記才重來() {
        let mut k = one_peer();
        let now = 1_000_000u64;
        assert_eq!(k.pick_gate("pc", now), Some(PickGate::Open));
        assert_eq!(k.pick_gate("沒有", now), None);
        assert!(k.pick_record_wrong("pc", now));
        assert_eq!(k.pick_gate("pc", now), Some(PickGate::Locked { minutes: 10 }));
        assert_eq!(k.pick_gate("pc", now + 3 * 60_000), Some(PickGate::Locked { minutes: 7 }));
        assert_eq!(k.pick_gate("pc", now + PICK_LOCK_MS - 1), Some(PickGate::Locked { minutes: 1 }));
        assert_eq!(k.pick_gate("pc", now + PICK_LOCK_MS), Some(PickGate::Open), "十分鐘過了可以再試");
        assert_eq!(k.peer("pc").unwrap().pick_wrong, 1, "答錯的次數還記著");
        let later = now + PICK_LOCK_MS + 5;
        assert!(k.pick_record_wrong("pc", later));
        assert_eq!(k.peer("pc").unwrap().pick_wrong, 2);
        for t in [later, later + PICK_LOCK_MS, later + 365 * 24 * 3_600_000, 0] {
            assert_eq!(k.pick_gate("pc", t), Some(PickGate::Blocked), "第二次錯之後任何時候都擋住");
        }
        assert!(!k.pick_record_wrong("沒有", 1));
        assert!(k.pick_record_wrong("pc", later + 1));
        assert_eq!(k.peer("pc").unwrap().pick_wrong, 2, "不會再往上加");
        assert!(!k.confirm("pc", &fingerprint("pk"), later + 365 * 24 * 3_600_000), "擋住的不能記住");
        assert!(k.forget("pc"));
        k.remember("pc", "工作機", "pk", 3).unwrap();
        let p = k.peer("pc").unwrap();
        assert_eq!((p.pick_wrong, p.pick_lock_set_ms, p.pick_lock_until_ms), (0, None, None), "忘記再記住：全部重來");
        assert_eq!(k.pick_gate("pc", later), Some(PickGate::Open));
    }

    #[test]
    fn 都不一樣_直接擋住_不用等第二次() {
        let mut k = one_peer();
        assert!(k.pick_block("pc"));
        assert_eq!(k.pick_gate("pc", 5), Some(PickGate::Blocked));
        assert_eq!(k.peer("pc").unwrap().pick_wrong, PICK_WRONG_LIMIT);
        assert!(!k.pick_block("沒有"));
        assert!(!k.confirm("pc", &fingerprint("pk"), 9));
        assert_eq!(k.peer("pc").unwrap().confirmed_at, None);
    }

    #[test]
    fn 確認成功清掉答錯紀錄_鎖住中不能確認() {
        let mut k = one_peer();
        let fp = fingerprint("pk");
        assert!(k.pick_record_wrong("pc", 1_000));
        assert!(!k.confirm("pc", &fp, 1_001), "鎖住中，即使有過關的題目也不記");
        assert_eq!(k.peer("pc").unwrap().confirmed_at, None);
        let after = 1_000 + PICK_LOCK_MS;
        assert!(k.confirm("pc", &fp, after));
        let p = k.peer("pc").unwrap();
        assert_eq!((p.pick_wrong, p.pick_lock_set_ms, p.pick_lock_until_ms, p.confirmed_at), (0, None, None, Some(after)));
        assert_eq!(k.pick_gate("pc", after), Some(PickGate::Open));
    }

    #[test]
    fn 手機時鐘被往回撥_鎖還是鎖著() {
        let mut k = one_peer();
        let set = 5_000_000u64;
        assert!(k.pick_record_wrong("pc", set));
        for t in [set - 1, set - 1_000_000, 0] {
            assert!(matches!(k.pick_gate("pc", t), Some(PickGate::Locked { .. })), "時間 {t}：比鎖住那刻還早，還是鎖著");
        }
        assert_eq!(k.pick_gate("pc", set - 1_000_000), Some(PickGate::Locked { minutes: 27 }), "剩餘時間照實算（進位到整分鐘）");
        assert!(!k.confirm("pc", &fingerprint("pk"), set - 5));
        assert_eq!(k.pick_gate("pc", set + PICK_LOCK_MS), Some(PickGate::Open));
    }

    #[test]
    fn 舊檔沒有選項與答錯欄位_照常讀得進來() {
        let old: KnownPeers = serde_json::from_str(r#"{"peers":[{"node":"d","name":"n","sign_pub":"pk","first_seen_ms":1,"confirmed_at":5}]}"#).unwrap();
        let p = old.peer("d").unwrap();
        assert_eq!((p.pick.clone(), p.pick_wrong, p.pick_lock_set_ms, p.pick_lock_until_ms), (None, 0, None, None));
        assert_eq!(old.pick_gate("d", 1), Some(PickGate::Open));
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(KNOWN_FILE), r#"{"peers":[{"node":"d","name":"n","sign_pub":"pk","first_seen_ms":1}]}"#).unwrap();
        assert_eq!(KnownPeers::load(d.path()).unwrap().peers.len(), 1);
    }

    #[test]
    fn 給畫面的列表不帶選項_答案_次數_鎖() {
        let mut k = one_peer();
        k.remember("pc2", "辦公室", "pk2", 1).unwrap();
        let (a, _) = pick_of(&mut k, "pc", 1);
        let (b, _) = pick_of(&mut k, "pc2", 2);
        k.pick_record_wrong("pc", 100);
        k.pick_block("pc2");
        assert!(!k.confirm("pc2", &fingerprint("pk2"), 1), "擋住的不會被確認");
        let text = phone_known_view(&k).to_string();
        for bad in ["options", "answer", "pick", "lock", "wrong"] {
            assert!(!text.contains(bad), "列表不能有 {bad}：{text}");
        }
        for o in a.options.iter().chain(b.options.iter()) {
            assert!(!text.contains(o.as_str()), "列表不能有選項 {o}");
        }
        assert_eq!(phone_known_view(&k)["peers"][0].as_object().unwrap().len(), 3);
    }

    /// 這個位置落在哪個方法裡（縮排四格的 fn）
    fn method_at(code: &str, i: usize) -> String {
        let before = &code[..i];
        let start = ["\n    pub fn ", "\n    fn "].iter().filter_map(|p| before.rfind(p).map(|at| (at, p.len()))).max();
        match start {
            Some((at, len)) => before[at + len..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect(),
            None => String::new(),
        }
    }

    fn rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                rs_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    #[test]
    fn 守門_答錯次數與鎖只有答題_確認_忘記三條路能寫_別的檔案碰不到() {
        let src = include_str!("device_id.rs").replace("\r\n", "\n");
        let code = src.split("\n#[cfg(test)]\nmod tests {").next().unwrap();
        let mut n = 0;
        for field in [".pick_wrong = ", ".pick_lock_set_ms = ", ".pick_lock_until_ms = "] {
            for (i, _) in code.match_indices(field) {
                n += 1;
                let o = method_at(code, i);
                assert!(["confirm", "pick_record_wrong", "pick_block"].contains(&o.as_str()), "{field}被 {o} 寫了");
            }
        }
        assert!(n >= 6, "至少三個欄位各被寫到：{n}");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rs_files(&root, &mut files);
        for f in files {
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            if name == "device_id.rs" {
                continue;
            }
            let s = std::fs::read_to_string(&f).unwrap().replace("\r\n", "\n");
            let s = s.split("\n#[cfg(test)]").next().unwrap();
            assert!(!s.contains(".pick_wrong") && !s.contains(".pick_lock") && !s.contains("pick_wrong:"), "{name} 不能碰答錯次數與鎖");
            if name != "android.rs" {
                assert!(!s.contains("pick_record_wrong(") && !s.contains("pick_block(") && !s.contains("pick_prepare("), "{name} 不能叫四選一的紀錄");
            }
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
        for src in [include_str!("bridge/mod.rs"), include_str!("bridge/launcher.rs"), include_str!("cli/mod.rs")] {
            assert!(!src.contains("device_id::"), "不能從這裡碰設備金鑰");
        }
        // 手機只有「認得的電腦」三個命令碰得到（列表、確認、忘記），其他地方一律不行；那三個命令不碰設備私鑰
        let rs = include_str!("android.rs").replace("\r\n", "\n");
        let code = rs.split("\n#[cfg(test)]").next().unwrap();
        for (i, _) in code.match_indices("device_id::") {
            let f = owner_at(code, i);
            assert!(["android_known_list", "android_known_challenge", "android_known_answer", "android_known_confirm", "android_known_forget", "android_known_rename"].contains(&f.as_str()), "不能從這裡碰設備金鑰：{f}");
        }
        assert!(!code.contains("live::key"), "手機的命令不碰設備私鑰");
    }

    /// 函式本體（從 pub fn 名字到下一個空行加右大括號）
    fn body_of<'a>(code: &'a str, name: &str) -> &'a str {
        let at = code.find(&format!("pub fn {name}(")).unwrap_or_else(|| panic!("找不到 {name}"));
        code[at..].split("\n}\n").next().unwrap()
    }

    #[test]
    fn 守門_四選一_先取走過關的題目才確認_回答不記住_答案不進日誌與事件() {
        let rs = include_str!("android.rs").replace("\r\n", "\n");
        let code = rs.split("\n#[cfg(test)]").next().unwrap();
        let confirm = body_of(code, "android_known_confirm");
        let (t, c) = (confirm.find("take_passed(").expect("要先取走過關的題目"), confirm.find("live::confirm(").expect("要確認"));
        assert!(t < c, "take_passed 在 live::confirm 之前");
        assert!(confirm.contains("fingerprint(&sign_pub)"), "指紋由記住的公鑰在 Rust 重算，不收畫面給的");
        assert!(!confirm.contains("fp:"), "確認不收指紋參數");
        let ans = body_of(code, "android_known_answer");
        for bad in ["confirmed", "confirm(", "remember(", "live::confirm", "live::see", "live::known", "live::pick_prepare", "set_confirmed", "confirmed_at"] {
            assert!(!ans.contains(bad), "回答不能記住任何東西：{bad}");
        }
        // 答錯、都不一樣的紀錄只有回答這條路寫；題目準備只有出題那條路叫
        for (pat, only) in [("live::pick_record_wrong(", "android_known_answer"), ("live::pick_block(", "android_known_answer"), ("live::pick_prepare(", "android_known_challenge")] {
            let o: Vec<String> = code.match_indices(pat).map(|(i, _)| owner_at(code, i)).collect();
            assert!(!o.is_empty() && o.iter().all(|f| f == only), "{pat} 只有 {only} 能叫：{o:?}");
        }
        assert!(ans.contains("pick_record_wrong(") && ans.contains("pick_block("), "回答要把答錯記到檔案");
        assert!(ans.find("pick_gate(").unwrap() < ans.find("known_pick::answer(").unwrap(), "先看有沒有被鎖住、擋住，才判斷答案");
        // 這四個命令：日誌只有「都不一樣」那一行；題目、選項、答案都不進任何日誌、事件、顯示
        let chal = body_of(code, "android_known_challenge");
        for (name, b) in [("challenge", chal), ("answer", ans), ("confirm", confirm)] {
            for bad in ["emit", "ui_log", concat!("print", "ln!"), concat!("db", "g!"), "tracing::", "log::", "olog!", "format!"] {
                assert!(!b.contains(bad), "android_known_{name} 不能有：{bad}");
            }
        }
        assert_eq!(chal.matches("elog!").count() + confirm.matches("elog!").count(), 0);
        assert_eq!(ans.matches("elog!").count(), 1);
        let line = ans.split("elog!(").nth(1).unwrap().split(");").next().unwrap();
        assert_eq!(line, "\"本人表示手機上的指紋選項都和電腦不一樣，沒有記住\"", "只有這一句，不帶任何變數");
        assert!(chal.contains("prep.sign_pub") && !chal.contains("fingerprint"), "正確指紋由 known_pick 用記住的公鑰算");
        // 出題的 JSON 只有狀態、編號、選項、分鐘；答案位置與紀錄上的次數、鎖都不出現
        for bad in ["\"answer\"", "pick_wrong", "pick_lock", "\"pick\""] {
            assert!(!chal.contains(bad), "android_known_challenge 的回傳不能有：{bad}");
        }
        assert!(chal.contains("\"options\": prep.options") && chal.contains("\"minutes\": minutes"));
        // 四選一的模組：不寫日誌、不發事件，而且 known_pick 只被這幾個命令叫
        let kp = include_str!("known_pick.rs").replace("\r\n", "\n");
        let kp = kp.split("\n#[cfg(test)]").next().unwrap();
        for bad in ["elog!", "olog!", concat!("print", "ln!"), concat!("db", "g!"), "log::", "tracing::", "emit", "ui_log"] {
            assert!(!kp.contains(bad), "known_pick.rs 不能有：{bad}");
        }
        for (i, _) in code.match_indices("known_pick::") {
            let f = owner_at(code, i);
            assert!(["android_known_challenge", "android_known_answer", "android_known_confirm", "android_known_forget"].contains(&f.as_str()), "{f}");
        }
    }

    // ---- 改名：本人取的名字、整理規則、不被後來連線蓋掉、只有兩個命令能叫 ----

    #[test]
    fn 整理名字_去控制字元與方向字元_去頭尾空白_最多三十二個字_空的可以() {
        assert_eq!(clean_owner_name("  家用機  "), "家用機");
        assert_eq!(clean_owner_name("家\u{202e}用\n機"), "家 用 機");
        assert_eq!(clean_owner_name("\u{200b}\n\t "), "");
        assert_eq!(clean_owner_name(""), "");
        assert_eq!(clean_owner_name(&"長".repeat(100)).chars().count(), OWNER_NAME_MAX);
        assert_eq!(OWNER_NAME_MAX, 32);
        for c in ['\u{200b}', '\u{200c}', '\u{200d}', '\u{200e}', '\u{200f}', '\u{2028}', '\u{2029}', '\u{2066}', '\u{2069}', '\u{feff}', '\u{0}', '\u{7f}'] {
            assert!(!clean_owner_name(&format!("家{c}用機")).contains(c), "{c:?}");
        }
    }

    #[test]
    fn 改名_只改名字_不動公鑰_確認_四選一_本人改過的名字不被之後連線蓋掉() {
        let mut k = KnownPeers::default();
        k.remember("d", "後台給的", "pk", 1).unwrap();
        assert!(k.confirm("d", &fingerprint("pk"), 5));
        let before = k.peer("d").unwrap().clone();
        assert!(!before.named_by_owner);
        k.remember("d", "後台改名了", "pk", 2).unwrap();
        assert_eq!(k.peer("d").unwrap().name, "後台改名了", "沒改過名：照舊跟著更新");
        assert!(k.rename_peer("d", "  我的工作機\n"));
        let p = k.peer("d").unwrap().clone();
        assert_eq!((p.name.as_str(), p.named_by_owner), ("我的工作機", true));
        assert_eq!((&p.sign_pub, p.confirmed_at, &p.pick, p.pick_wrong, p.first_seen_ms, p.login_ok, p.input_confirmed), (&before.sign_pub, before.confirmed_at, &before.pick, before.pick_wrong, before.first_seen_ms, before.login_ok, before.input_confirmed), "其他欄位不動");
        k.remember("d", "後台又改了", "pk", 3).unwrap();
        assert_eq!(k.peer("d").unwrap().name, "我的工作機", "本人取的名字不被蓋掉");
        assert_eq!(k.remember("d", "x", "pk2", 4).unwrap_err(), KEY_CHANGED);
        assert!(!k.rename_peer("沒有", "x"));
    }

    #[test]
    fn 改名成空的_是未命名_之後連線也不補名字() {
        let mut k = KnownPeers::default();
        k.remember("d", "後台給的", "pk", 1).unwrap();
        assert!(k.rename_peer("d", "  "));
        assert_eq!(k.peer("d").unwrap().name, "");
        k.remember("d", "後台又給", "pk", 2).unwrap();
        assert_eq!(k.peer("d").unwrap().name, "", "不從後台補名字");
    }

    #[test]
    fn 改名_存檔讀回一致_舊檔沒有這欄就是沒改過() {
        let d = tempfile::tempdir().unwrap();
        let mut k = KnownPeers::default();
        k.remember("d", "甲", "pk", 1).unwrap();
        k.rename_peer("d", "乙");
        k.save(d.path()).unwrap();
        let back = KnownPeers::load(d.path()).unwrap();
        assert_eq!(back, k);
        assert!(back.peer("d").unwrap().named_by_owner);
        let old: KnownPeers = serde_json::from_str(r#"{"peers":[{"node":"d","name":"n","sign_pub":"pk","first_seen_ms":1}]}"#).unwrap();
        assert!(!old.peers[0].named_by_owner);
    }

    #[cfg(feature = "gui")]
    #[test]
    fn 改名_存到檔案_沒有這台回_false() {
        let d = tempfile::tempdir().unwrap();
        let mut k = KnownPeers::default();
        k.remember("d", "甲", "pk", 1).unwrap();
        k.save(d.path()).unwrap();
        assert!(live::rename_peer(d.path(), "d", "乙").unwrap());
        assert_eq!(live::local_name(d.path(), "d").unwrap().as_deref(), Some("乙"));
        assert!(!live::rename_peer(d.path(), "x", "乙").unwrap());
        assert_eq!(live::local_name(d.path(), "x").unwrap(), None);
    }

    #[test]
    fn 守門_改名只有電腦版設定頁的命令和手機的改名命令能叫_名字欄位只有改名與記住會寫() {
        let src = include_str!("device_id.rs").replace("\r\n", "\n");
        let code = src.split("\n#[cfg(test)]\nmod tests {").next().unwrap();
        for (i, _) in code.match_indices(".named_by_owner = ") {
            assert_eq!(method_at(code, i), "rename_peer", "named_by_owner 只有改名能設");
        }
        assert_eq!(code.matches(".named_by_owner = ").count(), 1);
        for (i, _) in code.match_indices("p.name = ") {
            assert!(["remember", "rename_peer"].contains(&method_at(code, i).as_str()), "名字只有記住與改名能寫");
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rs_files(&root, &mut files);
        let mut callers = Vec::new();
        for f in files {
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            if name == "device_id.rs" {
                continue;
            }
            let s = std::fs::read_to_string(&f).unwrap().replace("\r\n", "\n");
            let s = s.split("\n#[cfg(test)]").next().unwrap().to_string();
            assert!(!s.contains("named_by_owner"), "{name} 不能碰名字旗標");
            for (i, _) in s.match_indices("rename_peer(") {
                callers.push((name.clone(), owner_at(&s, i)));
            }
        }
        callers.sort();
        assert_eq!(callers, vec![("android.rs".to_string(), "android_known_rename".to_string()), ("lib.rs".to_string(), "device_known_rename".to_string())], "{callers:?}");
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        assert!(lib.contains("#[cfg(feature = \"gui\")]\n#[cfg(desktop)]\n#[tauri::command]\nfn device_known_rename("), "電腦版才有");
        let rs = include_str!("android.rs").replace("\r\n", "\n");
        assert!(rs.contains("android::android_known_rename") || lib.contains("android::android_known_rename"), "手機登記");
    }
}
