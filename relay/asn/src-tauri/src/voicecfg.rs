//! 語音設定（念出訊息的聲音與自動念、語音輸入的語言與模型），存在資料夾的 voice.json。
//! 放在 Rust 端是因為對話視窗與名單視窗都要用同一份，而且念出訊息時聲音由這裡決定、前端不用管。
//! 讀回來時每個欄位各自驗證：壞值、舊值一律退回預設，不會讓整份設定失效。
use crate::settings::VoiceDoc;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VoiceCfg {
    /// 念出訊息的聲音（空字串＝用後台預設）；格式 xx-XX-NameNeural，真正的白名單在後台
    pub tts_voice: String,
    /// 收到新訊息自動念出來（預設關）
    pub tts_auto: bool,
    /// 語音輸入的語言：zh（中文，預設）、auto（自動判斷）、en（英文）
    pub stt_lang: String,
    /// 語音輸入用的模型：small（較準，約 190 MB）、base（較快，約 60 MB）
    pub stt_model: String,
}

impl Default for VoiceCfg {
    fn default() -> Self {
        VoiceCfg { tts_voice: String::new(), tts_auto: false, stt_lang: "zh".into(), stt_model: "small".into() }
    }
}

pub const LANGS: [&str; 3] = ["zh", "auto", "en"];
pub const MODEL_IDS: [&str; 2] = ["small", "base"];

/// 聲音代號格式（同 cloudflare/edge-tts/worker.js 的 VOICE_RE），空字串也算合法（＝預設）
pub fn valid_voice(v: &str) -> bool {
    if v.is_empty() {
        return true;
    }
    let p: Vec<&str> = v.split('-').collect();
    p.len() == 3
        && (2..=3).contains(&p[0].len())
        && p[0].chars().all(|c| c.is_ascii_lowercase())
        && p[1].len() == 2
        && p[1].chars().all(|c| c.is_ascii_uppercase())
        && p[2].len() <= 40
        && p[2].ends_with("Neural")
        && p[2].chars().all(|c| c.is_ascii_alphabetic())
}

/// 整份驗證（寫入前用）：有一項不合格就回中文原因
pub fn validate(c: &VoiceCfg) -> Result<(), String> {
    if !valid_voice(&c.tts_voice) {
        return Err("聲音代號格式不對".into());
    }
    if !LANGS.contains(&c.stt_lang.as_str()) {
        return Err("語音輸入的語言不認得".into());
    }
    if !MODEL_IDS.contains(&c.stt_model.as_str()) {
        return Err("語音輸入的模型不認得".into());
    }
    Ok(())
}

/// 讀取：走共用設定層（#2162）。`dir` 是資料資料夾（與 `settings::Roots::data` 同一個）；
/// 呼叫端（stt、tts、指令）仍傳資料夾進來，所以簽章不變。逐欄過濾在 `VoiceDoc::normalize`。
pub fn load(dir: &Path) -> VoiceCfg {
    let d = crate::settings::load_in::<VoiceDoc>(dir).value;
    VoiceCfg { tts_voice: d.tts_voice, tts_auto: d.tts_auto, stt_lang: d.stt_lang, stt_model: d.stt_model }
}

/// 寫入：先驗證，再用 `update` 只改這四個欄位，檔裡其他（新版寫的）欄位與版本號原樣保留
pub fn save(dir: &Path, c: &VoiceCfg) -> Result<(), String> {
    validate(c)?;
    crate::settings::update_in::<VoiceDoc, _>(dir, |d| {
        d.tts_voice = c.tts_voice.clone();
        d.tts_auto = c.tts_auto;
        d.stt_lang = c.stt_lang.clone();
        d.stt_model = c.stt_model.clone();
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 預設值_念出訊息自動念是關的() {
        let d = VoiceCfg::default();
        assert!(!d.tts_auto);
        assert_eq!((d.stt_lang.as_str(), d.stt_model.as_str(), d.tts_voice.as_str()), ("zh", "small", ""));
    }

    #[test]
    fn 聲音代號格式() {
        for ok in ["", "zh-TW-HsiaoChenNeural", "en-US-AriaNeural", "zh-CN-XiaoxiaoNeural"] {
            assert!(valid_voice(ok), "{ok}");
        }
        for bad in ["zh-TW-Hsiao", "zh-TW-X'><Neural", "ZH-TW-AriaNeural", "zh-tw-AriaNeural", "../x", "zh-TW-Aria Neural", "zh-TW-AriaNeural\n", "a-TW-AriaNeural"] {
            assert!(!valid_voice(bad), "{bad}");
        }
    }

    #[test]
    fn 存檔再讀回來() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(load(d.path()), VoiceCfg::default());
        let c = VoiceCfg { tts_voice: "zh-TW-YunJheNeural".into(), tts_auto: true, stt_lang: "auto".into(), stt_model: "base".into() };
        save(d.path(), &c).unwrap();
        assert_eq!(load(d.path()), c);
    }

    #[test]
    fn 不合格的設定不寫入() {
        let d = tempfile::tempdir().unwrap();
        for c in [
            VoiceCfg { tts_voice: "bad".into(), ..Default::default() },
            VoiceCfg { stt_lang: "klingon".into(), ..Default::default() },
            VoiceCfg { stt_model: "../../x".into(), ..Default::default() },
        ] {
            assert!(save(d.path(), &c).is_err());
        }
        assert!(!d.path().join("voice.json").exists());
    }

    #[test]
    fn 壞檔與壞欄位各自退回預設() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("voice.json"), "{壞掉").unwrap();
        assert_eq!(load(d.path()), VoiceCfg::default());
        std::fs::write(d.path().join("voice.json"), r#"{"tts_voice":"x y","tts_auto":true,"stt_lang":"en","stt_model":5}"#).unwrap();
        let c = load(d.path());
        assert_eq!((c.tts_voice.as_str(), c.tts_auto, c.stt_lang.as_str(), c.stt_model.as_str()), ("", true, "en", "small"));
    }

    /// 改接共用層之前的 `load`，原樣複製，當逐項對照的標準答案
    fn old_load(dir: &Path) -> VoiceCfg {
        let d = VoiceCfg::default();
        let Some(v) = std::fs::read_to_string(dir.join("voice.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
            return d;
        };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        VoiceCfg {
            tts_voice: s("tts_voice").filter(|x| valid_voice(x)).unwrap_or(d.tts_voice),
            tts_auto: v.get("tts_auto").and_then(|x| x.as_bool()).unwrap_or(d.tts_auto),
            stt_lang: s("stt_lang").filter(|x| LANGS.contains(&x.as_str())).unwrap_or(d.stt_lang),
            stt_model: s("stt_model").filter(|x| MODEL_IDS.contains(&x.as_str())).unwrap_or(d.stt_model),
        }
    }

    #[test]
    fn 各種舊格式檔讀出來和改接之前逐項一致() {
        let cases: &[&str] = &[
            "",
            "{}",
            "{壞掉",
            "null",
            "5",
            "[1,2]",
            "\"字串\"",
            r#"{"tts_voice":"zh-TW-YunJheNeural"}"#,
            r#"{"tts_auto":true}"#,
            r#"{"stt_lang":"en"}"#,
            r#"{"stt_model":"base"}"#,
            r#"{"tts_voice":"x y","tts_auto":true,"stt_lang":"en","stt_model":5}"#,
            r#"{"tts_voice":5,"tts_auto":"true","stt_lang":null,"stt_model":["small"]}"#,
            r#"{"tts_voice":"ZH-TW-AriaNeural","stt_lang":"klingon","stt_model":"../../x"}"#,
            r#"{"tts_voice":"","tts_auto":false,"stt_lang":"auto","stt_model":"base"}"#,
            r#"{"tts_voice":"en-US-AriaNeural","tts_auto":true,"stt_lang":"zh","stt_model":"small","舊欄位":1}"#,
            r#"{"tts_auto":null,"tts_voice":null}"#,
            r#"{"version":1,"tts_voice":"zh-CN-XiaoxiaoNeural"}"#,
            r#"{"version":"x","tts_auto":true}"#,
        ];
        for (i, c) in cases.iter().enumerate() {
            let d = tempfile::tempdir().unwrap();
            std::fs::write(d.path().join("voice.json"), c).unwrap();
            assert_eq!(load(d.path()), old_load(d.path()), "第 {i} 組：{c}");
        }
        // 檔案不存在
        let d = tempfile::tempdir().unwrap();
        assert_eq!(load(d.path()), old_load(d.path()));
        assert!(!d.path().join("voice.json").exists(), "讀取不建檔");
    }

    #[test]
    fn 升級後再降級_新版寫的檔舊版讀得出同樣的值() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("voice.json"), r#"{"tts_voice":"en-US-AriaNeural","tts_auto":true,"stt_lang":"en","stt_model":"base"}"#).unwrap();
        // 新版第一次寫入：補上 version，舊內容備份
        let c = VoiceCfg { tts_voice: "zh-TW-YunJheNeural".into(), tts_auto: false, stt_lang: "auto".into(), stt_model: "small".into() };
        save(d.path(), &c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("voice.json")).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert!(d.path().join("voice.json.v0.bak").is_file());
        // 舊版（上面複製的舊 load）讀得出同樣的值，多出來的 version 被忽略
        assert_eq!(old_load(d.path()), c);
        assert_eq!(load(d.path()), c);
    }

    #[test]
    fn 新版寫的語音檔保留不認得的欄位且版本不降() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("voice.json"), r#"{"version":9,"tts_voice":"","tts_auto":false,"stt_lang":"zh","stt_model":"small","speed":1.5,"nested":{"a":[1]}}"#).unwrap();
        let c = VoiceCfg { tts_auto: true, ..Default::default() };
        save(d.path(), &c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("voice.json")).unwrap()).unwrap();
        assert_eq!(v["version"], 9);
        assert_eq!(v["speed"], 1.5);
        assert_eq!(v["nested"], serde_json::json!({"a":[1]}));
        assert_eq!(v["tts_auto"], true);
        assert_eq!(load(d.path()), c);
    }

    #[test]
    fn 壞的語音檔退回預設並備份() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("voice.json"), "{壞掉").unwrap();
        assert_eq!(load(d.path()), VoiceCfg::default());
        assert!(!d.path().join("voice.json").exists());
        assert_eq!(std::fs::read_dir(d.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("voice.json.bad-")).count(), 1);
    }
}
