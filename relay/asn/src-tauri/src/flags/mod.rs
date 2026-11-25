//! 環境變數登記表（#2163 PR-1）：程式裡出現的每一個 `ASN_*` 名字都登記在 [`table::FLAGS`]，
//! 附舊名、沒設時的行為、用途、分類、讀它的檔案，以及「預設值有沒有用測試釘住」。
//!
//! 這一張**只登記與守門，不改任何讀取行為**：讀環境變數的呼叫端照舊（`envc::get`、`env_u64`、`std::env::var`…），
//! 新舊名相容仍由 [`crate::envc::PAIRS`] 負責；登記表與 PAIRS 的一致性由測試保證。
//!
//! 守門（`tests.rs`、`scan.rs`）：
//! - 原始碼（`src/**/*.rs`、`tests/*.rs`）出現的每個 `ASN_` 名字都要登記，沒登記就紅；
//! - 登記了但原始碼已經找不到，也紅（登記表沒跟著清）；
//! - `docs/設定值清單.md` 的「環境變數」一節要和登記表逐列一致。
//!
//! 前端旗標（`ui/` 底下的 `AGENT_INSTALL_UI` 等）不在這裡，留給 #2163 的 PR-4。
#![cfg_attr(not(test), allow(dead_code, unused_imports))]

mod table;
#[cfg(test)]
mod scan;
#[cfg(test)]
mod tests;

pub use table::{DYNAMIC_OK, FLAGS, NOT_ENV};

/// 分類
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// 正式：使用者或部署會設（含調校用的數值）
    Prod,
    /// 內部傳遞：父程序設給子程序，使用者不該設
    Internal,
    /// 測試：只有測試或手動驗證會設
    Test,
    /// CI：發版或 CI 流程會設
    Ci,
    /// 除錯：只有除錯建置才讀
    Debug,
}

impl Kind {
    /// 文件上的分類字樣
    pub const fn label(self) -> &'static str {
        match self {
            Kind::Prod => "正式",
            Kind::Internal => "內部傳遞",
            Kind::Test => "測試",
            Kind::Ci => "CI",
            Kind::Debug => "除錯",
        }
    }
}

/// 預設值有沒有被測試釘住
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pin {
    /// 釘住：測試用讀取函式在沒設定時的回傳值，必須等於這段文字（對照 `tests.rs` 的 `pinned_value`）
    Value(&'static str),
    /// 沒釘：寫明原因（只用在「正式」分類）
    Unpinned(&'static str),
    /// 不適用（非「正式」分類沒有預設值要釘）
    Na,
}

/// 一個環境變數的登記
#[derive(Clone, Copy, Debug)]
pub struct Flag {
    pub name: &'static str,
    /// 舊名（`IRORI_*`），沒有就是 None；要和 [`crate::envc::PAIRS`] 一致
    pub legacy: Option<&'static str>,
    pub kind: Kind,
    /// 機密：不可交給子程序（要和 [`crate::envc::SECRET_NAMES`] 一致）
    pub secret: bool,
    /// 沒設時的行為（文件用的短句，不含直線符號）
    pub default: &'static str,
    /// 一句話用途（不含直線符號）
    pub purpose: &'static str,
    /// 讀（或設）它的檔案，相對 `src/`
    pub readers: &'static [&'static str],
    pub pin: Pin,
}

impl Flag {
    pub const fn new(
        kind: Kind,
        name: &'static str,
        legacy: Option<&'static str>,
        default: &'static str,
        purpose: &'static str,
        readers: &'static [&'static str],
        pin: Pin,
    ) -> Flag {
        Flag { name, legacy, kind, secret: false, default, purpose, readers, pin }
    }

    /// 標成機密
    pub const fn secret(self) -> Flag {
        Flag { secret: true, ..self }
    }

    /// 補上舊名
    pub const fn with_legacy(self, legacy: Option<&'static str>) -> Flag {
        Flag { legacy, ..self }
    }

    /// 文件上的分類字樣：機密加註
    pub fn kind_label(&self) -> String {
        if self.secret {
            format!("{}（機密）", self.kind.label())
        } else {
            self.kind.label().to_string()
        }
    }
}

/// 查登記
pub fn find(name: &str) -> Option<&'static Flag> {
    FLAGS.iter().find(|f| f.name == name)
}
