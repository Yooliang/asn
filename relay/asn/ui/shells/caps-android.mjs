// 平台能力表：手機版（Tauri 安卓外殼）。鍵與順序和 caps-desktop.mjs 完全一致；每個能力的意思看 caps-desktop.mjs 的註解。
// 能力名稱 11-26 依調查員審查定案，之後不改（#1763 F1；#1853 第 3 張會直接引用）。
export const capsAndroid = Object.freeze({
  tray: false,             // 手機沒有系統匣
  desktopWindow: false,    // 手機沒有視窗與視窗外框
  autostart: false,        // 手機沒有登入自動啟動
  guard: false,            // 手機沒有自動重開排程
  bridge: false,           // 手機沒有收發信的橋（手機只是看的那一端）
  localSpeech: false,      // 手機的語音輸入用系統辨識，沒有本機語音引擎
  hostAgents: false,       // 手機不在本機開 AI 視窗，只能下指令請電腦開
  claudeLocalLogs: false,  // 手機上沒有 Claude 記錄可讀
  push: true,              // 安卓外殼有推播
  shellSelfUpdate: true,   // 安卓外殼可自己更新（Play 版除外，畫面另判）
  vibrate: true,           // 手機有振動馬達
  desktopToast: false,     // 手機沒有右下角通知；提示改走推播與震動
  quotaReader: false,      // 額度是電腦本機讀的，手機只顯示回報的數字
  taskManager: false,      // 手機沒有可管理的本機程式
})
