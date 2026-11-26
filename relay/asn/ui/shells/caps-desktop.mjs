// 平台能力表：電腦版（Tauri 電腦外殼）。形狀＝{ 能力名: true／false }，三張表（caps-desktop／caps-android／caps-web）的鍵必須一模一樣。
// 能力名稱定下來就不改（#1763 F1；#1853 第 3 張會直接引用）；要加新能力，三張表一起加，測試的名稱快照一起更新。
// 這張表只回答「這個平台有沒有這個能力」，不放設定值，也不決定畫面怎麼長；誰需要哪些能力見 lib/setting-needs.mjs。
export const capsDesktop = Object.freeze({
  tray: true,           // 系統匣：關閉視窗時可縮到系統匣
  windowFrame: true,    // 視窗外框：可選自訂（Aero 風）或系統原生外框
  autostart: true,      // 登入自動啟動：系統登入時自動開 ASN
  guard: true,          // 自動重開：ASN 意外關閉時由排程重新開啟
  bridge: true,         // 收發信的橋：這台電腦替 AI 夥伴收發信、接受別台遠端開視窗與打字
  voice: true,          // 語音：這台本機的念出訊息與語音辨識引擎（下載模型、選聲音）
  launch: true,         // 開視窗：在這台電腦上開 AI 夥伴視窗與管理工作資料夾白名單
  usage: true,          // 用量：讀這台電腦上的 Claude 記錄估算用量
  push: false,          // 推播：系統推播通知（只有安卓外殼）
  phoneUpdate: false,   // 手機更新：安卓外殼自己下載安裝新版（Play 安裝的版本由商店更新）
  vibrate: false,       // 震動：手機的振動馬達
  toast: true,          // 右下角通知：電腦的桌面通知與提示音
  windowMode: true,     // 視窗模式與版面：分離／整合、頭像模式、工具列位置、文字底色、分頁與分組
  quotaReader: true,    // 讀額度：這台電腦替各帳號讀額度、產生查詢代碼
  taskManager: true,    // 工作管理員：管理這台電腦上 ASN 開的程式與終端服務
})
