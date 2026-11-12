// 手機看別台電腦夥伴的終端（PR④），以及在下方輸入框打字（#1378）。手機畫面**只能用這一份**，
// 不能直接用電腦版 lib/tauri.mjs 的 remoteViewApi／remoteInputApi：
// 手機每次發起前都要先過本人確認（生物辨識，沒設就用螢幕鎖；mobile-confirm.mjs 的 confirmViewer，PR③）。
// 守門測試鎖住 m.js、m.html、其他 mobile*.mjs 不准引用 remoteViewApi、remoteInputApi。
// 指令和電腦版同名同參數（term_view_remote_available／start／input／set／stop），事件也一樣；差別只在 start 之前的確認。
// 打字的那台會照電腦的規則問那邊的人（第一次要允許、允許過可以不再問），送字只送到 Rust 端登記過（那台接受過）的工作階段。
import { invoke as tauriInvoke, listen, remoteInputApi, remoteViewApi } from './tauri.mjs'
import { NO_LOCK_TEXT, confirmViewer } from './mobile-confirm.mjs'

/** 本人取消確認：畫面不顯示錯誤，靜默回到訊息（RemoteView 看 code 決定） */
export const CANCELLED = 'cancel'

/**
 * 做一份手機用的介面。confirm、invoke 可以注入（測試用）。
 * start：先 confirm()，'ok' 才發起；'cancel' 丟 { code: 'cancel' }（什麼都不送）；'no_lock' 丟 NO_LOCK_TEXT（也不送）。
 * 每次 start 都重新確認，不記住上一次的結果。
 * opts.wanted()：畫面那一次發起還算不算數。確認很晚才回來（本人已經切回訊息、或又重新發起）時回 false，
 * 這時就算確認回 ok 也不送 start（不然被看的那台會跳允許框、閃紅條、寄通知信）。
 */
export function makeMobileRemoteViewApi({ confirm = () => confirmViewer(), invoke = tauriInvoke } = {}) {
  return {
    available: node => invoke('term_view_remote_available', { node }),
    start: async (toNode, partner, machine, opts = {}) => {
      const r = await confirm()
      if (typeof opts?.wanted === 'function' && !opts.wanted()) throw Object.assign(new Error(''), { code: CANCELLED })
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

/**
 * 手機打字用的介面（#1378）：和 makeMobileRemoteViewApi 一樣，start 之前一定先 confirm()，'ok' 才發起（scope 帶 input）；
 * opts.wanted() 回 false（確認回來時那一次已作廢）就不送。send／pause／stop 和電腦版的 remoteInputApi 相同（命令同名）。
 */
export function makeMobileRemoteInputApi({ confirm = () => confirmViewer(), invoke = tauriInvoke, send = remoteInputApi.send } = {}) {
  return {
    start: async (toNode, partner, machine, opts = {}) => {
      const r = await confirm()
      if (typeof opts?.wanted === 'function' && !opts.wanted()) throw Object.assign(new Error(''), { code: CANCELLED })
      if (r === 'ok') return invoke('term_view_remote_start', { toNode, partner, machine: machine || null, scope: 'input' })
      if (r === 'no_lock') throw Object.assign(new Error(NO_LOCK_TEXT), { code: 'no_lock' })
      throw Object.assign(new Error(''), { code: CANCELLED })
    },
    send,
    pause: remoteInputApi.pause,
    stop: remoteInputApi.stop,
    listen,
  }
}

export const mobileRemoteInputApi = makeMobileRemoteInputApi()
