// 平台能力表：電腦版（Tauri 電腦外殼）。形狀＝{ 能力名: true／false }，三張表（caps-desktop／caps-android／caps-web）的鍵必須一模一樣。
// 能力名稱 11-26 依調查員審查定案，之後不改（#1763 F1；#1853 第 3 張會直接引用）；要加新能力，三張表一起加，測試的名稱快照一起更新。
// 原則：只放「平台本來就沒有，或這台設備沒有那個角色」的能力。「我們決定不做」「寫死」這類設計選擇不放這裡，
// #1853 第 3 張會把它們標成「無（未做）」。
// 這張表只回答「這個平台有沒有這個能力」，不放設定值，也不決定畫面怎麼長；誰需要哪些能力見 lib/setting-needs.mjs。
export const capsDesktop = Object.freeze({
  tray: true,             // 系統匣：關閉視窗時可縮到系統匣
  desktopWindow: true,    // 電腦視窗：有可調的視窗外框，也有各自記大小與位置的多扇視窗（手機沒有視窗）
  autostart: true,        // 登入自動啟動：系統登入時自動開 ASN
  guard: true,            // 自動重開：ASN 意外關閉時由排程重新開啟
  bridge: true,           // 收發信的橋：這台電腦替 AI 夥伴收發信、接受別台遠端開視窗與打字
  localSpeech: true,      // 本機語音引擎：下載的語音辨識引擎與模型、念出訊息（手機用系統辨識，不歸這一項）
  hostAgents: true,       // 本機 AI 視窗：在這台電腦上開 AI 視窗、安裝與偵測 AI 工具、工作資料夾白名單
  claudeLocalLogs: true,  // 本機 Claude 記錄：這台電腦上的 Claude 記錄，用量從這裡估算
  push: false,            // 推播：系統推播通知（只有安卓外殼）
  shellSelfUpdate: false, // 外殼自己更新：外殼自己下載安裝包更新（Play 安裝的版本由商店更新）
  vibrate: false,         // 震動：手機的振動馬達
  desktopToast: true,     // 電腦通知：右下角通知和提示音
  quotaReader: true,      // 讀額度：這台電腦替各帳號讀額度、產生查詢代碼
  taskManager: true,      // 工作管理員：管理這台電腦上 ASN 開的程式與終端服務
})
