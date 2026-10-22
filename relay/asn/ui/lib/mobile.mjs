// 手機版（ui/m.html）的純邏輯：單欄導覽、名單分組、提示規則、安卓外殼橋。node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。
// 手機只有一個畫面：名單（和「我」）→ 點進對話 → 返回。沒有多視窗、系統匣、設定分頁。
import { groupItems } from './dims.mjs'
import { friendMatchesQuery, normalizeSearchQuery, sortFriends } from './search.mjs'

// ---------- 單欄導覽 ----------
// 狀態：{ tab: 'list' | 'me', chat: 好友 id | '' }。chat 有值＝正在看那位的對話（蓋在名單上）。
// 每往下一層（名單→對話、名單→我）就在瀏覽記錄推一筆；系統的返回鍵＝瀏覽器上一頁，外殼（WryActivity）已接好，名單層再按才退到背景。
export const initialNav = () => ({ tab: 'list', chat: '' })
export const chatNav = id => ({ tab: 'list', chat: String(id ?? '') })
export const meNav = () => ({ tab: 'me', chat: '' })
// 瀏覽記錄裡讀回來的狀態可能是任何東西（壞資料、別的頁面留下的）：整理成合法的導覽狀態
export function normalizeNav(raw) {
  const chat = typeof raw?.chat === 'string' ? raw.chat : ''
  if (chat) return chatNav(chat)
  return raw?.tab === 'me' ? meNav() : initialNav()
}

// ---------- 名單 ----------
// 單欄名單：所有設備的夥伴放在同一頁，依設備分組（本機那組在最前），有搜尋字就只留符合的。
// 組內線上在前、離線在後。回傳 [{ key, label, node, items }]
export function rosterGroups(friends, { query = '', selfNode = '', selfName = '', plainText = s => s } = {}) {
  const q = normalizeSearchQuery(query)
  const items = sortFriends((friends ?? []).filter(f => friendMatchesQuery(f, q, plainText)))
  return groupItems(items, 'device', { selfNode, selfName })
}
export const totalUnread = friends => (friends ?? []).reduce((n, f) => n + (Number.isInteger(f?.unread) && f.unread > 0 ? f.unread : 0), 0)

// ---------- 提示 ----------
export const DEFAULT_PREFS = { vibrateMsg: false, vibrateNudge: true, autoUpdate: true }
export const normalizePrefs = raw => ({ vibrateMsg: raw?.vibrateMsg === true, vibrateNudge: raw?.vibrateNudge !== false, autoUpdate: raw?.autoUpdate !== false })
export const NUDGE_VIBRATE_MS = 300
export const MSG_VIBRATE_MS = 60

// core 的 notify 事件 → 該怎麼提示。openId＝目前正在看的對話（沒有就是空），foreground＝App 在前景。
//   banner：頂端橫幅（不是正在看的那位、App 在前景才跳）；vibrate：震動毫秒數（0＝不震）；shake：對話畫面抖一下
// 「對方登入」類的提示不打擾手機（不跳、不震）。
export function notifyPlan(n, { openId = '', foreground = true, prefs = DEFAULT_PREFS } = {}) {
  const none = { banner: null, vibrate: 0, shake: false }
  if (!n || (n.kind !== 'msg' && n.kind !== 'nudge')) return none
  const id = n.friend?.id ?? ''
  const watching = foreground && openId !== '' && openId === id
  if (n.kind === 'nudge') {
    return { banner: foreground && !watching ? bannerOf(n) : null, vibrate: prefs.vibrateNudge ? NUDGE_VIBRATE_MS : 0, shake: watching }
  }
  return { banner: foreground && !watching ? bannerOf(n) : null, vibrate: prefs.vibrateMsg && !watching ? MSG_VIBRATE_MS : 0, shake: false }
}
const bannerOf = n => ({ id: n.friend.id, nick: n.friend.nick, line: String(n.line ?? ''), status: n.friend.status, hue: n.friend.hue })
export const BANNER_MS = 4000

// ---------- 安卓外殼橋（MainActivity 掛上的 window.AsnAndroid；沒有就是在一般瀏覽器或測試裡） ----------
export function androidBridge(win) {
  const b = win?.AsnAndroid
  if (!b || typeof b.vibrate !== 'function') return null
  const call = (fn, ...a) => { try { return typeof b[fn] === 'function' ? b[fn](...a) : undefined } catch { return undefined } }
  return {
    vibrate: ms => call('vibrate', ms),
    exportFile: path => String(call('exportFile', path) ?? ''),
    openDownloads: () => call('openDownloads'),
    relaunch: () => call('relaunch'),
    selfUpdateEnabled: () => call('selfUpdateEnabled') === true,   // 自行安裝版才有（Google Play 版是 false）
    installApk: path => String(call('installApk', path) ?? 'error'),   // ok／need_permission／error／unsupported
  }
}

// 收到的檔案另存：Rust 端先存進 App 私有資料夾，外殼再複製到「下載/ASN」。回給畫面的是給人看的位置。
export async function savePhotoOnPhone(path, bridge) {
  if (!path) return null
  const shown = bridge ? bridge.exportFile(path) : ''
  if (!shown) throw new Error('檔案已下載，但沒辦法放進「下載」資料夾')
  return shown
}

// 第一次登入替這支手機建好節點後：要重新啟動才會用新身分。有外殼就請它重開；沒有就請使用者自己重開。
export function afterBind(out, bridge) {
  if (out?.state !== 'created') return { action: 'enter' }
  if (bridge) return { action: 'relaunch' }
  return { action: 'ask', text: '登入完成，請關掉 ASN 再重新打開。' }
}

// ---------- 自動更新（自行安裝版；Google Play 版不啟用，畫面上根本不出現） ----------
export const UPDATE_CHECK_MS = 6 * 3600 * 1000
export const initialUpdate = () => ({ enabled: false, phase: 'idle', version: '', line: '', done: 0, total: 0, error: '', hint: '', checking: false, manual: '' })
// phase：idle（沒有新版）→ available（有新版，等按「更新」）→ downloading → failed（可重試）；下載完交給系統安裝程式
export const withAvailable = (u, found) => (found?.enabled === true && found.available === true
  ? { ...u, enabled: true, phase: 'available', version: String(found.version ?? ''), line: String(found.line ?? ''), error: '', hint: '' }
  : { ...u, enabled: found?.enabled === true, phase: u.phase === 'downloading' ? u.phase : 'idle' })
export const withProgress = (u, p) => ({ ...u, phase: 'downloading', done: Number(p?.done) || 0, total: Number(p?.total) || 0 })
export const withFailure = (u, msg) => ({ ...u, phase: 'failed', error: String(msg ?? '更新失敗') })
export const progressText = (done, total) => (total > 0 ? `下載中 ${Math.min(100, Math.floor((done / total) * 100))}%` : '下載中…')
export const bannerText = u => (u.phase === 'available' ? `有新版本 ${u.version}${u.line ? `：${u.line}` : ''}` : u.phase === 'downloading' ? progressText(u.done, u.total) : u.phase === 'failed' ? `更新失敗：${u.error}` : '')
export const buttonLabel = u => (u.phase === 'failed' ? '重試' : '更新')
// 交給系統安裝程式的結果 → 給人看的提示（ok 時系統會接手，畫面不用多說）
export function installOutcome(result) {
  switch (result) {
    case 'ok': return { ok: true, hint: '' }
    case 'need_permission': return { ok: false, hint: '請在接下來的畫面允許 ASN 安裝應用程式，回來後再按一次「更新」。' }
    case 'unsupported': return { ok: false, hint: '這個版本不提供自動更新。' }
    default: return { ok: false, hint: '沒辦法叫出安裝畫面，請再試一次。' }
  }
}
// 該不該自動檢查：這個版本有更新功能、使用者沒關、不在下載中
export const shouldAutoCheck = (u, prefs) => u.enabled && prefs.autoUpdate !== false && u.phase !== 'downloading'
