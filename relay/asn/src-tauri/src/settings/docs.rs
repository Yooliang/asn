//! 各個設定檔的宣告（一個檔一個型別）：語音、視窗名稱、帳號偏好、安裝偏好、pi 自動安裝、讀額度，其餘由後續的 PR 陸續搬進來。
//! 預設值以這裡的 `Default` 為唯一來源。

use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// 單一欄位型別不符就當沒有（跟舊的逐欄容錯一致），不讓整份設定失效
fn lenient<'de, D: Deserializer<'de>, T: serde::de::DeserializeOwned + Default>(d: D) -> Result<T, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

pub use names_doc::NamesDoc;
#[cfg(desktop)]
pub use prefs::{AcctPrefsDoc, AgentSetupPrefsDoc, PiAutoDoc, QuotaReadersDoc};
#[cfg(desktop)]
pub use voice::VoiceDoc;
#[cfg(desktop)]
pub use launch_bridge::{BridgeDoc, LaunchPrefsDoc};

/// settings.json（data_dir）：視窗名稱與舊名稱。手機也有，所以不掛 cfg(desktop)
mod names_doc {
    use super::lenient;
    use crate::names::OldName;
    use crate::settings::{Doc, Scope};
    use serde::{Deserialize, Serialize};
    use serde_json::{Map, Value};

    /// 不認得的欄位收在 `extra`，改名寫回時原樣保留（以前是整份重寫）
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
    #[serde(default)]
    pub struct NamesDoc {
        /// 本人取過的視窗名；沒有或不合法＝沒取過（`lib::read_settings_name`）
        #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
        pub window_name: Option<String>,
        /// 舊名稱清單：任何一筆壞掉整份當空的（跟舊的 `read_old_names` 一致）
        #[serde(deserialize_with = "lenient")]
        pub old_names: Vec<OldName>,
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    impl Doc for NamesDoc {
        const NAME: &'static str = "settings";
        const SCOPE: Scope = Scope::Data;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
        fn normalize(&mut self) {
            if self.window_name.as_deref().is_some_and(|s| !crate::valid_window_name(s)) {
                self.window_name = None;
            }
        }
    }
}

#[cfg(desktop)]
mod prefs {
    use super::lenient;
    use crate::quota_readers::MAX_MINIMAX;
    use crate::settings::{Doc, Scope};
    use serde::{Deserialize, Serialize};
    use serde_json::{Map, Value};

    /// acct-prefs.json（data_dir）：遠端切換帳號的信任設定。預設值對照舊的 `pref_bool` 呼叫：
    /// remote_trust_own 預設關、remote_trust_signed 預設開、remote_allow_switch 沒存過就是 None（由前兩項換算）
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    #[serde(default)]
    pub struct AcctPrefsDoc {
        #[serde(deserialize_with = "lenient")]
        pub remote_trust_own: bool,
        #[serde(deserialize_with = "lenient_true")]
        pub remote_trust_signed: bool,
        #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
        pub remote_allow_switch: Option<bool>,
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    /// 預設是 true 的布林：不是布林（含 null）就退回 true
    fn lenient_true<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(v.as_bool().unwrap_or(true))
    }

    impl Default for AcctPrefsDoc {
        fn default() -> Self {
            AcctPrefsDoc { remote_trust_own: false, remote_trust_signed: true, remote_allow_switch: None, extra: Map::new() }
        }
    }

    impl Doc for AcctPrefsDoc {
        const NAME: &'static str = "acct-prefs";
        const SCOPE: Scope = Scope::Data;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
    }

    /// agent-setup-prefs.json（data_dir）：允許別台替這台安裝並登入，預設關
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
    #[serde(default)]
    pub struct AgentSetupPrefsDoc {
        #[serde(deserialize_with = "lenient")]
        pub remote_allow_install: bool,
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    impl Doc for AgentSetupPrefsDoc {
        const NAME: &'static str = "agent-setup-prefs";
        const SCOPE: Scope = Scope::Data;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
    }

    /// pi-auto.json（relay_home）：`auto` 是設定（允許自動安裝，預設開），`done` 是狀態（已處理過，預設否），同一個檔
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    #[serde(default)]
    pub struct PiAutoDoc {
        #[serde(deserialize_with = "lenient_true")]
        pub auto: bool,
        #[serde(deserialize_with = "lenient")]
        pub done: bool,
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    impl Default for PiAutoDoc {
        fn default() -> Self {
            PiAutoDoc { auto: true, done: false, extra: Map::new() }
        }
    }

    impl Doc for PiAutoDoc {
        const NAME: &'static str = "pi-auto";
        const SCOPE: Scope = Scope::Home;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
    }

    /// quota-readers.json（relay_home）：額度讀取器的開關，每一項預設關。
    /// 刻意**不用**逐欄容錯：舊的讀法是整份 `from_str::<Settings>().unwrap_or_default()`，任何一欄型別不對整份當全關
    /// （寧可全關，也不要壞一欄卻照樣開著其他讀取器）。所以這裡手寫 `Deserialize`：已知欄位有任何一個型別不對，
    /// 整份回預設（不當壞檔搬走，內容是物件就不產生 `.bad-`），但不認得的欄位仍保留。
    #[derive(Serialize, Clone, Debug, PartialEq, Default)]
    pub struct QuotaReadersDoc {
        pub grok: bool,
        pub agy: bool,
        /// 要讀的 MiniMax 帳號 email；key 在憑證管理員
        pub minimax: Vec<String>,
        pub extra_claude: bool,
        pub extra_claude_refresh: bool,
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    const QUOTA_KEYS: [&str; 5] = ["grok", "agy", "minimax", "extra_claude", "extra_claude_refresh"];

    impl<'de> Deserialize<'de> for QuotaReadersDoc {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct Strict {
                grok: bool,
                agy: bool,
                minimax: Vec<String>,
                extra_claude: bool,
                extra_claude_refresh: bool,
            }
            let Value::Object(mut obj) = Value::deserialize(d)? else {
                return Err(serde::de::Error::custom("最上層不是物件"));
            };
            let mut extra = Map::new();
            for (k, v) in obj.iter() {
                if !QUOTA_KEYS.contains(&k.as_str()) {
                    extra.insert(k.clone(), v.clone());
                }
            }
            obj.retain(|k, _| QUOTA_KEYS.contains(&k.as_str()));
            let s: Strict = serde_json::from_value(Value::Object(obj)).unwrap_or_default();
            Ok(QuotaReadersDoc { grok: s.grok, agy: s.agy, minimax: s.minimax, extra_claude: s.extra_claude, extra_claude_refresh: s.extra_claude_refresh, extra })
        }
    }

    impl Doc for QuotaReadersDoc {
        const NAME: &'static str = "quota-readers";
        const SCOPE: Scope = Scope::Home;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
        /// 原本 `load_settings` 的後處理：email 正規化並丟掉壞的、最多 MAX_MINIMAX 個；只開換新不算（要先開讀取）
        fn normalize(&mut self) {
            self.minimax = self.minimax.iter().filter_map(|e| crate::claude_accounts::normalize_email(e)).take(MAX_MINIMAX).collect();
            self.extra_claude_refresh = self.extra_claude_refresh && self.extra_claude;
        }
    }
}

#[cfg(desktop)]
mod voice {
    use crate::settings::{Doc, Scope};
    use crate::voicecfg::{valid_voice, LANGS, MODEL_IDS};
    use super::lenient;
    use serde::{Deserialize, Serialize};
    use serde_json::{Map, Value};

    /// voice.json。`extra` 收下不認得的欄位（較新版本寫的），寫回時原樣保留。
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    #[serde(default)]
    pub struct VoiceDoc {
        #[serde(deserialize_with = "lenient")]
        pub tts_voice: String,
        #[serde(deserialize_with = "lenient")]
        pub tts_auto: bool,
        #[serde(deserialize_with = "lenient")]
        pub stt_lang: String,
        #[serde(deserialize_with = "lenient")]
        pub stt_model: String,
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    impl Default for VoiceDoc {
        fn default() -> Self {
            VoiceDoc { tts_voice: String::new(), tts_auto: false, stt_lang: "zh".into(), stt_model: "small".into(), extra: Map::new() }
        }
    }

    impl Doc for VoiceDoc {
        const NAME: &'static str = "voice";
        const SCOPE: Scope = Scope::Data;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
        /// 原本 `voicecfg::load` 的逐欄過濾：壞值、舊值各自退回預設
        fn normalize(&mut self) {
            let d = VoiceDoc::default();
            if !valid_voice(&self.tts_voice) {
                self.tts_voice = d.tts_voice;
            }
            if !LANGS.contains(&self.stt_lang.as_str()) {
                self.stt_lang = d.stt_lang;
            }
            if !MODEL_IDS.contains(&self.stt_model.as_str()) {
                self.stt_model = d.stt_model;
            }
        }
    }
}

/// launch-prefs.json 與 bridge.json（#2162 第 5 張）。兩個檔都**只走 `*_in(dir)`**，不走 `Scope`：
/// 無視窗橋（asn-bridge）把 `data_dir` 設成節點工作資料夾，bridge.json 的位置不固定，所以這裡的 `SCOPE` 只是填給 trait 的，沒人用。
#[cfg(desktop)]
mod launch_bridge {
    use super::lenient;
    use crate::bridge::compact::clamp_n;
    use crate::settings::{Doc, Scope};
    use serde::{Deserialize, Serialize};
    use serde_json::{Map, Value};

    /// launch-prefs.json：自由格式的 JSON 物件（`cwdAllow`、`recentCwd`、`launchDisplay`、`maxPerHourSet`…），
    /// 畫面整份讀、整份存，所以每個欄位原樣放在 `extra`，不逐欄宣告（宣告了反而會把畫面新加的欄位吃掉）。
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
    pub struct LaunchPrefsDoc {
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    impl Doc for LaunchPrefsDoc {
        const NAME: &'static str = "launch-prefs";
        const SCOPE: Scope = Scope::Data;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
    }

    /// 壓縮次數：不是整數（含小數、超出範圍、字串）一律當沒存＝預設 3；整數夾在 2～10。跟舊的 `clamp_n(v.get(..).and_then(as_i64))` 一致
    fn lenient_n<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(clamp_n(v.as_i64()))
    }

    fn default_n() -> u32 {
        clamp_n(None)
    }

    /// 文字欄位：不是字串當空字串；前後空白去掉（跟舊的 `as_str().unwrap_or("").trim()` 一致）
    fn lenient_trimmed<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(v.as_str().unwrap_or("").trim().to_string())
    }

    /// bridge.json：收發室設定，14 個布林／字串／數字欄位（逐欄容錯：型別不對就是該欄預設，其餘照讀）。
    /// `enabled` 在檔案裡照存，但讀回給呼叫端一律當 true（內建收發室固定開啟，見 `bridge::read_settings`）。
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    #[serde(default)]
    pub struct BridgeDoc {
        #[serde(deserialize_with = "lenient")]
        pub enabled: bool,
        #[serde(deserialize_with = "lenient")]
        pub allow_takeover: bool,
        #[serde(deserialize_with = "lenient")]
        pub allow_remote_launch: bool,
        #[serde(deserialize_with = "lenient_trimmed")]
        pub unaddressed_to: String,
        #[serde(deserialize_with = "lenient")]
        pub auto_resume_off: bool,
        #[serde(deserialize_with = "lenient")]
        pub term_server_off: bool,
        #[serde(deserialize_with = "lenient")]
        pub term_server_on: bool,
        #[serde(deserialize_with = "lenient")]
        pub screen_watch_off: bool,
        #[serde(deserialize_with = "lenient")]
        pub perm_phone_off: bool,
        #[serde(deserialize_with = "lenient")]
        pub mobile_view_off: bool,
        #[serde(deserialize_with = "lenient")]
        pub remote_input_off: bool,
        #[serde(deserialize_with = "lenient")]
        pub compact_handoff_off: bool,
        #[serde(deserialize_with = "lenient_n")]
        pub compact_handoff_n: u32,
        #[serde(deserialize_with = "lenient")]
        pub gemini_full_access: bool,
        #[serde(flatten)]
        pub extra: Map<String, Value>,
    }

    impl Default for BridgeDoc {
        fn default() -> Self {
            BridgeDoc {
                enabled: false,
                allow_takeover: false,
                allow_remote_launch: false,
                unaddressed_to: String::new(),
                auto_resume_off: false,
                term_server_off: false,
                term_server_on: false,
                screen_watch_off: false,
                perm_phone_off: false,
                mobile_view_off: false,
                remote_input_off: false,
                compact_handoff_off: false,
                compact_handoff_n: default_n(),
                gemini_full_access: false,
                extra: Map::new(),
            }
        }
    }

    impl Doc for BridgeDoc {
        const NAME: &'static str = "bridge";
        const SCOPE: Scope = Scope::Data;
        const VERSION: u32 = 1;

        fn extra(&self) -> &Map<String, Value> {

            &self.extra

        }
        fn normalize(&mut self) {
            self.unaddressed_to = self.unaddressed_to.trim().to_string();
            self.compact_handoff_n = clamp_n(Some(i64::from(self.compact_handoff_n)));
        }
    }
}
