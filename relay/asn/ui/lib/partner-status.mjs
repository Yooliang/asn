// 夥伴狀態的唯一一份對照表（#2441）。純資料與純函式，瀏覽器與 node 共用。
// 過去名單轉換、對話標題、名牌、名單灰字、群組排序、詳情各寫一份清單，橋多送一種狀態、前端就悄悄當成線上；
// 現在所有地方都從這裡取，test/partner-status-contract.test.mjs 會和 Rust 原始碼雙向比對。

/**
 * 橋或其他來源回報的原始狀態值 → 畫面狀態。
 * origin：bridge＝Rust 橋會送（守門測試要求 Rust 真的有送、而且這裡有登記）；
 *         external＝橋不送，只有舊版或別的工具回報過的別名（Claude 外掛、第三方），保留相容；守門測試要求 Rust 不能送這幾個。
 * text：夥伴詳情「狀態」一列的白話字。
 */
export const RAW_STATUS = Object.freeze({
  idle: { to: 'online', text: '閒置', origin: 'bridge' },
  online: { to: 'online', text: '閒置', origin: 'external' },
  busy: { to: 'busy', text: '忙碌', origin: 'bridge' },
  running: { to: 'busy', text: '忙碌', origin: 'bridge' },   // 程序掃描條目送 running（畫面另有 running 專用處理）；非程序條目當忙碌
  working: { to: 'busy', text: '忙碌', origin: 'external' },
  thinking: { to: 'busy', text: '忙碌', origin: 'external' },
  waiting: { to: 'away', text: '等你回應', origin: 'bridge' },
  away: { to: 'away', text: '等你回應', origin: 'external' },
  blocked: { to: 'away', text: '等你回應', origin: 'external' },
  paused: { to: 'away', text: '暫停', origin: 'external' },
  stopped: { to: 'stopped', text: '已停止', origin: 'bridge' },
  'login-required': { to: 'login-required', text: '要重新登入', origin: 'bridge' },
  quota: { to: 'quota', text: '額度用完', origin: 'bridge' },
  limit: { to: 'quota', text: '額度用完', origin: 'bridge' },   // Codex 的額度用完
  unavailable: { to: 'unavailable', text: '暫時不可用', origin: 'bridge' },
})

/**
 * 畫面狀態的屬性：
 * label＝對話視窗的狀態字；plate＝名牌狀態字；note＝名單上名字後面的灰字（空＝不加）；
 * rank＝挑夥伴進群組時的排序（小的在前，null＝排在最後）；live＝這台設備算不算在線（設備層級用，roster.mjs 由它產生設備在線清單）。
 * usable＝夥伴真的能收信、處理信（「已經登入」通知只在轉成這幾種時發）。
 */
export const SCREEN_STATUS = Object.freeze({
  online: { label: '線上', plate: '在線', note: '', rank: 0, live: true, usable: true },
  busy: { label: '忙碌', plate: '忙碌', note: '忙碌', rank: 1, live: true, usable: true },
  away: { label: '暫離', plate: '暫離', note: '暫離', rank: 2, live: true, usable: true },
  offline: { label: '顯示為離線', plate: '離線', note: '離線', rank: 3, live: false, usable: false },
  stopped: { label: '已停止', plate: '已停止', note: '', rank: null, live: true, usable: false },
  running: { label: '執行中・僅顯示', plate: '執行中', note: '執行中・僅顯示', rank: null, live: true, usable: false },
  awaiting: { label: '等你在那台電腦按確認', plate: '等你按確認', note: '等你按確認', rank: null, live: true, usable: false },
  'login-required': { label: '要重新登入', plate: '要重新登入', note: '要重新登入', rank: null, live: true, usable: false },
  quota: { label: '額度用完', plate: '額度用完', note: '額度用完', rank: null, live: true, usable: false },
  unknown: { label: '狀態不明', plate: '狀態不明', note: '狀態不明', rank: null, live: true, usable: false },
  unavailable: { label: '暫時不可用', plate: '暫時不可用', note: '', rank: null, live: true, usable: false },
})

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const keysWhere =pick => Object.keys(SCREEN_STATUS).filter(k => pick(SCREEN_STATUS[k]))
export const LIVE_SCREEN_STATUSES = Object.freeze(keysWhere(s => s.live))
export const STATUS_LABEL = Object.freeze(Object.fromEntries(Object.entries(SCREEN_STATUS).map(([k, v]) => [k, v.label])))
export const PLATE_LABEL = Object.freeze(Object.fromEntries(Object.entries(SCREEN_STATUS).map(([k, v]) => [k, v.plate])))
export const STATUS_NOTE = Object.freeze(Object.fromEntries(Object.entries(SCREEN_STATUS).filter(([, v]) => v.note).map(([k, v]) => [k, v.note])))
export const STATUS_RANK = Object.freeze(Object.fromEntries(Object.entries(SCREEN_STATUS).filter(([, v]) => v.rank != null).map(([k, v]) => [k, v.rank])))
export const DETAIL_TEXT = Object.freeze(Object.fromEntries(Object.entries(RAW_STATUS).map(([k, v]) => [k, v.text])))

// 對話標題下方提醒條的種類：沒列在這裡的（忙碌、暫離、額度用完、狀態不明…）＝一般的狀態說明；線上＝不顯示（head-tone.mjs 的 warnKind 用）
export const WARN_KIND = Object.freeze({ offline: 'offline', stopped: 'stopped', 'login-required': 'login' })
export const warnKindOf = status => (!status || status === 'online' ? null : has(WARN_KIND, status) ? WARN_KIND[status] : 'status')

// 不認得的原始值只記一次（同一個值每輪名單都會來，不洗版）；最多記 200 個不同的值
const loggedUnknown = new Set()
const UNKNOWN_LOG_MAX = 200
function logUnknownOnce(raw) {
  if (loggedUnknown.has(raw) || loggedUnknown.size >= UNKNOWN_LOG_MAX) return
  loggedUnknown.add(raw)
  console.info(`[夥伴狀態] 名單帶了不認得的狀態值，畫面顯示「狀態不明」：${JSON.stringify(raw.slice(0, 40))}`)
}

/**
 * 原始狀態值 → 畫面狀態。空值（沒帶、空字串）維持原本的意思＝線上；
 * 不認得的值＝'unknown'（狀態不明），不再當成線上，並記一行 log。
 */
export function screenStatusOf(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return 'online'
  if (has(RAW_STATUS, s)) return RAW_STATUS[s].to   // 只認自己的鍵：不讓 constructor 這類原型上的名字被當成已登記
  logUnknownOnce(s)
  return 'unknown'
}

/** 「已經登入」通知：只在從離線或要重新登入，變成真的能用（線上、忙碌、暫離）時才發。 */
export function announcesLogin(prev, next) {
  const before = prev ?? 'offline'
  return (before === 'offline' || before === 'login-required') && has(SCREEN_STATUS, next) && SCREEN_STATUS[next].usable === true
}
