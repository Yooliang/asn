// 平台能力表：網頁版（尚無網頁版，目前沒有人使用）。先寫成保守值：一律沒有，之後真的做網頁殼時再逐項打開。
// 鍵與順序和 caps-desktop.mjs 完全一致；每個能力的意思看 caps-desktop.mjs 的註解。
// 能力名稱 11-26 依調查員審查定案，之後不改（#1763 F1；#1853 第 3 張會直接引用）。
export const capsWeb = Object.freeze({
  tray: false,
  desktopWindow: false,
  autostart: false,
  guard: false,
  bridge: false,
  localSpeech: false,
  hostAgents: false,
  claudeLocalLogs: false,
  push: false,
  shellSelfUpdate: false,
  vibrate: false,
  desktopToast: false,
  quotaReader: false,
  taskManager: false,
})
