// 手機看別台電腦夥伴的終端（PR④，只能看）。手機畫面**只能用這一份**，不能直接用電腦版 lib/tauri.mjs 的 remoteViewApi：
// 手機每次發起前都要先過本人確認（生物辨識，沒設就用螢幕鎖；mobile-confirm.mjs 的 confirmViewer，PR③）。
// 守門測試鎖住 m.js、m.html、其他 mobile*.mjs 不准引用 remoteViewApi。
// 指令和電腦版同名同參數（term_view_remote_available／start／set／stop），事件也一樣；差別只在 start 之前的確認。
import { invoke as tauriInvoke, listen, remoteViewApi } from './tauri.mjs'
import { NO_LOCK_TEXT, confirmViewer } from './mobile-confirm.mjs'

/** 本人取消確認：畫面不顯示錯誤，靜默回到訊息（RemoteView 看 code 決定） */
export const CANCELLED = 'cancel'

/**
 * 做一份手機用的介面。confirm、invoke 可以注入（測試用）。
 * start：先 confirm()，'ok' 才發起；'cancel' 丟 { code: 'cancel' }（什麼都不送）；'no_lock' 丟 NO_LOCK_TEXT（也不送）。
 * 每次 start 都重新確認，不記住上一次的結果。
 */
export function makeMobileRemoteViewApi({ confirm = () => confirmViewer(), invoke = tauriInvoke } = {}) {
  return {
    available: node => invoke('term_view_remote_available', { node }),
    start: async (toNode, partner, machine) => {
      const r = await confirm()
      if (r === 'ok') return invoke('term_view_remote_start', { toNode, partner, machine: machine || null })
      if (r === 'no_lock') throw Object.assign(new Error(NO_LOCK_TEXT), { code: 'no_lock' })
      throw Object.assign(new Error(''), { code: CANCELLED })
    },
    pause: remoteViewApi.pause,
    stop: remoteViewApi.stop,
    listen,
  }
}

export const mobileRemoteViewApi = makeMobileRemoteViewApi()
