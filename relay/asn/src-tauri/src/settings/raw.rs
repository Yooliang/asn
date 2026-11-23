//! 畫面整份讀、整份存的三個存檔（`asn-me.json`、`asn-onboard.json`、`asn-chats.json`）的後端（#2162 第 6 張）。
//! 前端經 `store_load`／`store_save` 讀寫整段文字，這裡讓那兩個指令改走共用設定層：
//! 名稱用白名單、上限 8,000,000 位元組、每個檔一把鎖、原子寫入、壞檔先搬走（chats 是快取，壞了直接退回空的）。
//! 另有 `patch_json`（欄位級合併：只動指定的頂層欄位，其餘原樣保留）與 `me_flags`（Rust 端讀 `asn-me.json` 三個欄位的唯讀讀法）。
//! 檔名與位置不變；格式也不變（單行 JSON、**不加 `version`**，見下）。
//!
//! 版本：這三個檔先不加 `version`（`VERSION = 0`，寫檔時不補欄位）。畫面整份存檔時不一定帶著它：
//! chats 是從記憶體整份重組、onboard／me 是 `...saved` 展開，載入前就寫過的檔才有，所以前端存檔可能把它洗掉。
//! 要等畫面改成走 `settings_patch`（#2162 第 7 張）、不再整份覆寫之後一起加。
use super::{atomic, path_in, slot_of, update_in, Doc, Scope, SettingsError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// 存檔文字的位元組上限，超過就整筆拒絕、原檔不動（與前端 `core.mjs` 的 `SAVE_BUDGET` 配套）
pub const MAX_BYTES: usize = 8_000_000;

/// 可以經 `store_*`／`settings_patch` 存取的存檔：白名單，取代以前「任何小寫英文字」的檢查
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawName {
    Me,
    Onboard,
    Chats,
}

impl RawName {
    pub fn parse(s: &str) -> Result<Self, SettingsError> {
        match s {
            "me" => Ok(RawName::Me),
            "onboard" => Ok(RawName::Onboard),
            "chats" => Ok(RawName::Chats),
            _ => Err(SettingsError("存檔名稱不合格".into())),
        }
    }

    fn path(self, dir: &Path) -> PathBuf {
        match self {
            RawName::Me => path_in::<MeDoc>(dir),
            RawName::Onboard => path_in::<OnboardDoc>(dir),
            RawName::Chats => path_in::<ChatsDoc>(dir),
        }
    }
}

/// 三個存檔都是「整個檔案都是 `extra`」：欄位由畫面決定，這裡不宣告任何欄位（宣告了反而會把畫面新加的欄位吃掉）
macro_rules! raw_doc {
    ($(#[$m:meta])* $name:ident, $file:literal, $compact:literal, $atomic:expr, $keep_bad:literal) => {
        $(#[$m])*
        #[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
        pub struct $name {
            #[serde(flatten)]
            pub extra: Map<String, Value>,
        }
        impl Doc for $name {
            const NAME: &'static str = $file;
            const SCOPE: Scope = Scope::Data;
            const VERSION: u32 = 0;
            const COMPACT: bool = $compact;
            const ATOMIC: atomic::Opts = $atomic;
            const KEEP_BAD: bool = $keep_bad;
            fn extra(&self) -> &Map<String, Value> {
                &self.extra
            }
        }
    };
}

raw_doc!(
    /// asn-me.json：個人設定。Rust 端也會讀其中的 `frame`、`closeTo`、`autoAddClaude`（見 [`me_flags`]），所以不拆檔
    MeDoc, "asn-me", true, atomic::SETTINGS, true
);
raw_doc!(
    /// asn-onboard.json：新手引導完成旗標
    OnboardDoc, "asn-onboard", true, atomic::SETTINGS, true
);
raw_doc!(
    /// asn-chats.json：對話快取（可從後台重建）。不 fsync；壞了退回空的、不留 `.bad-`
    ChatsDoc, "asn-chats", true, atomic::STATE, false
);

fn bare(e: SettingsError) -> String {
    e.0
}

/// 讀原文字串給前端（前端自己 parse）。**唯讀**：不搬壞檔、不改檔；沒有或讀不到就是 None（與以前一樣）
pub fn load_text(dir: &Path, name: RawName) -> Option<String> {
    let path = name.path(dir);
    let slot = slot_of(&path);
    // 與寫入共用同一把鎖，不會讀到寫到一半的狀態
    let _g = slot.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::read_to_string(&path).ok()
}

fn object_of(text: &str) -> Result<Map<String, Value>, SettingsError> {
    match serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(text)) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(SettingsError("存檔內容必須是 JSON 物件".into())),
    }
}

fn replace_all<T: Doc>(dir: &Path, mut m: Map<String, Value>) -> Result<(), SettingsError>
where
    T: RawLike,
{
    m.remove("version");
    update_in::<T, _>(dir, |d| *d.extra_mut() = m)
}

fn merge<T: Doc + RawLike>(dir: &Path, patch: Map<String, Value>) -> Result<(), SettingsError> {
    update_in::<T, _>(dir, |d| {
        let e = d.extra_mut();
        for (k, v) in patch {
            if k == "version" {
                continue; // 版本號由共用層管，不讓畫面改
            }
            if v.is_null() {
                e.shift_remove(&k);
            } else {
                e.insert(k, v);
            }
        }
    })
}

/// 內部：讓上面兩個泛型函式拿得到可寫的 `extra`
trait RawLike {
    fn extra_mut(&mut self) -> &mut Map<String, Value>;
}
macro_rules! raw_like {
    ($($t:ty),*) => {$(impl RawLike for $t { fn extra_mut(&mut self) -> &mut Map<String, Value> { &mut self.extra } })*};
}
raw_like!(MeDoc, OnboardDoc, ChatsDoc);

/// 存整份文字（`store_save`）。超過 [`MAX_BYTES`] 或不是 JSON 物件就整筆拒絕、原檔不動。
/// 錯誤是固定的白話句，不含系統原文
pub fn save_text(dir: &Path, name: RawName, text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("存檔太大".into());
    }
    let m = object_of(text).map_err(bare)?;
    match name {
        RawName::Me => replace_all::<MeDoc>(dir, m),
        RawName::Onboard => replace_all::<OnboardDoc>(dir, m),
        RawName::Chats => replace_all::<ChatsDoc>(dir, m),
    }
    .map_err(bare)
}

/// 欄位級合併（`settings_patch`）：對頂層欄位逐一覆蓋，`null` 代表刪除該欄，沒提到的欄位（含不認得的）原樣保留。
/// 持鎖下重讀原檔、改、寫，兩條執行緒同時改不同欄位不會互相蓋掉
pub fn patch_json(dir: &Path, name: RawName, patch: Map<String, Value>) -> Result<(), String> {
    if serde_json::to_string(&patch).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_BYTES {
        return Err("存檔太大".into());
    }
    match name {
        RawName::Me => merge::<MeDoc>(dir, patch),
        RawName::Onboard => merge::<OnboardDoc>(dir, patch),
        RawName::Chats => merge::<ChatsDoc>(dir, patch),
    }
    .map_err(bare)
}

/// Rust 端讀 `asn-me.json` 的三個欄位（原本散在 `lib.rs`、`wins.rs`、`tray.rs`、`claude_accounts.rs` 各自的小函式）
#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeFlags {
    /// 視窗外框：只有 `"frame":"native"` 才是原生；沒這欄位、壞檔、壞值一律是自訂外框（false）
    pub native_frame: bool,
    /// 關閉時縮到系統匣：只有明確寫 `"closeTo":"quit"` 才是結束；沒這欄位、壞檔、壞值一律縮到系統匣（true）
    pub close_to_tray: bool,
    /// Claude 帳號自動加入：固定開啟，寫什麼（含 false）、壞檔都一律是開（擁有者 10-24 決定，不再有開關）
    pub auto_add_claude: bool,
}

/// 唯讀讀取（比照 `peek_in`）：不搬壞檔、不寫檔。壞檔、缺欄位、壞值各欄退回上面註解寫的預設
#[cfg(desktop)]
pub fn me_flags(dir: &Path) -> MeFlags {
    let d = super::peek_in::<MeDoc>(dir).value;
    MeFlags {
        native_frame: d.extra.get("frame").and_then(Value::as_str) == Some("native"),
        close_to_tray: d.extra.get("closeTo").and_then(Value::as_str).map(|c| c != "quit").unwrap_or(true),
        auto_add_claude: true,
    }
}
