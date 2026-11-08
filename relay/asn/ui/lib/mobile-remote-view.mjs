// 手機看別台電腦夥伴的終端（PR④，只能看）。手機畫面**只能用這一份**，不能直接用電腦版 lib/tauri.mjs 的 remoteViewApi：
// 手機發起前要先過生物辨識（沒設就用螢幕鎖），那一步在手機專用的發起指令裡（PR③，調查員）。守門測試鎖住 m.js／m.html 不准引用 remoteViewApi。
// available／set／stop／listen 和電腦版同名同參數；start 走手機專用的指令。
// 指令名稱先暫定 android_term_view_remote_start，PR③ 合了以後照它的實際名稱改（在那之前手機沒有這個指令，入口也不會出現）。
import { invoke, listen, remoteViewApi } from './tauri.mjs'

export const MOBILE_START_CMD = 'android_term_view_remote_start'

export const mobileRemoteViewApi = {
  available: remoteViewApi.available,
  // 先過生物辨識／螢幕鎖，驗過才真的發起 → { id, expires_s }；本人取消、沒設螢幕鎖都回錯誤（PR③ 定確切的錯誤）
  start: (toNode, partner, machine) => invoke(MOBILE_START_CMD, { toNode, partner, machine: machine || null }),
  pause: remoteViewApi.pause,
  stop: remoteViewApi.stop,
  listen,
}
