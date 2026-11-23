//! 各個設定檔的宣告（一個檔一個型別）。目前只有語音設定一個範例，其餘由後續的 PR 陸續搬進來。
//! 預設值以這裡的 `Default` 為唯一來源。

#[cfg(desktop)]
pub use voice::VoiceDoc;

#[cfg(desktop)]
mod voice {
    use crate::settings::{Doc, Scope};
    use crate::voicecfg::{valid_voice, LANGS, MODEL_IDS};
    use serde::{Deserialize, Deserializer, Serialize};
    use serde_json::{Map, Value};

    /// 單一欄位型別不符就當沒有（跟舊的逐欄容錯一致），不讓整份設定失效
    fn lenient<'de, D: Deserializer<'de>, T: serde::de::DeserializeOwned + Default>(d: D) -> Result<T, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(serde_json::from_value(v).unwrap_or_default())
    }

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
