// 手機看別台電腦夥伴的終端（PR④），以及在下方輸入框打字（#1378）。手機畫面**只能用這一份**，
// 不能直接用電腦版 lib/tauri.mjs 的 remoteViewApi／remoteInputApi：
// 手機每次發起前都要先過本人確認（生物辨識，沒設就用螢幕鎖；mobile-confirm.mjs 的 confirmViewer，PR③）；
// 打字另外用 Rust 發的一次性憑證（confirmWithToken），Rust 用掉憑證才發起。
// 守門測試鎖住 m.js、m.html、其他 mobile*.mjs 不准引用 remoteViewApi、remoteInputApi。
// 指令和電腦版同名同參數（term_view_remote_available／start／input／set／stop），事件也一樣；差別只在 start 之前的確認。
// 打字的那台會照電腦的規則問那邊的人（第一次要允許、允許過可以不再問），送字只送到 Rust 端登記過（那台接受過）的工作階段。
import { invoke as tauriInvoke, listen, remoteInputApi, remoteViewApi } from './tauri.mjs'
import { NO_LOCK_TEXT, confirmViewer, confirmWithToken } from './mobile-confirm.mjs'
import { normalizeList } from './mobile-known-peers.mjs'

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

/** 那台電腦的指紋還沒在這支手機確認過：和 Rust（view_d.rs 的 INPUT_NEEDS_CONFIRM）同一句（測試鎖住） */
export const INPUT_NEEDS_CONFIRM_TEXT = '先在「設置 → 設備」打開這台電腦的「詳情」，確認它的指紋，才能在它的終端打字'

/**
 * 手機打字用的介面（#1378）。start 的順序：
 * 1. 看認得的電腦列表：那台的指紋還沒確認過就直接丟 INPUT_NEEDS_CONFIRM_TEXT（code 'need_confirm'），不跳本人驗證（列表讀不到就交給 Rust 擋）；
 * 2. 向 Rust 要打字的一次性憑證（android_known_token，action＝input）；
 * 3. 拿憑證請外殼跳本人驗證（confirmWithToken），通過時外殼寫下憑證檔；
 * 4. 'ok' 才發起（scope 帶 input、帶憑證），Rust 用掉憑證才往下走。'cancel' 丟 { code: 'cancel' }、'no_lock' 丟 NO_LOCK_TEXT，都不發起。
 * opts.wanted() 回 false（那一次已作廢）就不再往下。send／pause／stop 和電腦版的 remoteInputApi 相同（命令同名）。
 */
export function makeMobileRemoteInputApi({ confirm = challenge => confirmWithToken(challenge), invoke = tauriInvoke, send = remoteInputApi.send } = {}) {
  const cancelled = () => Object.assign(new Error(''), { code: CANCELLED })
  return {
    start: async (toNode, partner, machine, opts = {}) => {
      const wanted = () => typeof opts?.wanted !== 'function' || opts.wanted()
      let peers = null
      try { peers = normalizeList(await invoke('android_known_list')) } catch (e) { console.info('[ASN] 認得的電腦讀不到', String(e?.message ?? e)) }
      if (peers && !peers.some(p => p.node === toNode && p.confirmed)) throw Object.assign(new Error(INPUT_NEEDS_CONFIRM_TEXT), { code: 'need_confirm' })
      if (!wanted()) throw cancelled()
      const challenge = await invoke('android_known_token', { action: 'input', node: toNode })
      if (typeof challenge !== 'string' || !challenge) throw cancelled()
      const r = await confirm(challenge)
      if (!wanted()) throw cancelled()
      if (r === 'ok') return invoke('term_view_remote_start', { toNode, partner, machine: machine || null, scope: 'input', challenge })
      if (r === 'no_lock') throw Object.assign(new Error(NO_LOCK_TEXT), { code: 'no_lock' })
      throw cancelled()
    },
    send,
    pause: remoteInputApi.pause,
    stop: remoteInputApi.stop,
    listen,
  }
}

export const mobileRemoteInputApi = makeMobileRemoteInputApi()
