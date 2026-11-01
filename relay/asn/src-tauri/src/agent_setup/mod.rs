//! 新電腦上替使用者裝好 AI 引擎（#628）。這一層只放「驗過再執行」的共用零件與各家的安裝流程；
//! 所有東西都從官方網域下載、比對雜湊、驗數位簽章，通過才執行，不跑網路上抓下來的腳本。
//! 不讀、不寫任何登入資料。

// 接到桌面按鈕、遠端指令與手機的部分在後面幾段 PR，這幾段先不會有人呼叫
#![allow(dead_code)]

pub mod authenticode;
pub mod claude_install;
pub mod claude_login;
pub mod login;
pub mod net;
pub mod proc;
