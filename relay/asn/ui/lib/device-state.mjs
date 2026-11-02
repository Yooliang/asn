// 「設備」頁每一台、每一家 AI 的狀態（純邏輯，node 與瀏覽器都能跑；todo-next-174 的 B，#650）。
// 目標是把原本混成一句的幾種情況分開：
//   已登入／登入失效／已安裝但還沒登入／沒有登入／未安裝／還沒收到這台的回報——
// 尤其「沒登入」和「沒回報」：別台每 5 分鐘回報一次帳號，超過 15 分鐘沒收到（或從沒收到、讀取失敗）就是「沒回報」，
// 不能說成「沒登入」；也不知道有沒有裝時不亂說「未安裝」。
// 資料來源都是現有的，沒有新的後台回報：帳號回報（reports[node]）、啟動器回報（launchers[node].profiles）、名單的引擎、本機偵測。
import { loginFailed } from './claude-accounts.mjs'

/** 帳號回報超過這麼久沒更新就當「還沒收到回報」（每 5 分鐘回報一次，夠寬；電腦睡眠醒來不會閃，要實機看一次） */
export const REPORT_FRESH_MS = 15 * 60 * 1000

/** 電腦版與手機版共用的狀態鍵 */
export const STATE = Object.freeze({
  LOGGED_IN: 'logged_in',
  LOGIN_FAILED: 'login_failed',
  INSTALLED_LOGGED_OUT: 'installed_logged_out',
  LOGGED_OUT: 'logged_out',
  NOT_INSTALLED: 'not_installed',
  UNKNOWN_INSTALL: 'unknown_install',
  NO_REPORT: 'no_report',
})

/** 給使用者看的字（沒有內部代號） */
export const STATE_TEXT = Object.freeze({
  [STATE.LOGIN_FAILED]: '登入失效，要重新登入',
  [STATE.INSTALLED_LOGGED_OUT]: '已安裝，還沒登入',
  [STATE.LOGGED_OUT]: '沒有登入',
  [STATE.NOT_INSTALLED]: '未安裝',
  [STATE.UNKNOWN_INSTALL]: '不確定是否安裝',
  [STATE.NO_REPORT]: '還沒收到這台的回報',
})

const PHONE_KINDS = new Set(['phone', 'mobile', 'android'])
const PHONE_PLATFORMS = new Set(['android', 'ios'])
const DESKTOP_PLATFORMS = new Set(['windows', 'macos', 'linux'])

/** 這台是不是手機：後台回報的平台優先（#652），沒有再退回名單的種類（舊版手機的平台是空的） */
export function isPhoneDevice({ platform = '', kinds = [] } = {}) {
  const p = String(platform ?? '').toLowerCase()
  if (PHONE_PLATFORMS.has(p)) return true
  if (DESKTOP_PLATFORMS.has(p)) return false   // 後台說是電腦就是電腦，不管名單的種類寫什麼
  return (kinds ?? []).some(k => PHONE_KINDS.has(String(k ?? '').toLowerCase()))
}

/**
 * 別台帳號回報的新鮮度。rep：acct_remote_list 的結果 { error, asnOnline, reportedAt, accounts }
 * → 'never'（從沒收到）、'error'（讀取失敗）、'stale'（超過 15 分鐘沒更新）、'fresh'
 */
export function reportFreshness(rep, now = Date.now()) {
  if (!rep) return 'never'
  if (rep.error) return 'error'
  const t = Date.parse(rep.reportedAt ?? '')
  if (!Number.isFinite(t)) return 'never'
  return now - t > REPORT_FRESH_MS ? 'stale' : 'fresh'
}

/**
 * 一台設備上一家 AI 的狀態。
 * isSelf：本機（帳號與偵測都是本機的，不看回報）；rep：別台的帳號回報；accounts：這家在這台的帳號（有 current／loginFailed 旗標）；
 * installed：true／false／null（null＝不知道，例如那台沒開放啟動器）
 * → { state, text, reason? }（text 是畫面上整句；已登入時帶帳號）
 */
export function vendorState({ isSelf = false, rep = null, accounts = [], installed = null, now = Date.now() } = {}) {
  if (!isSelf) {
    const fresh = reportFreshness(rep, now)
    if (fresh !== 'fresh') return { state: STATE.NO_REPORT, text: STATE_TEXT[STATE.NO_REPORT], reason: fresh }
  }
  const list = Array.isArray(accounts) ? accounts : []
  if (list.length) {
    const cur = list.find(a => a.current) ?? list[0]
    if (cur.loginFailed === true || loginFailed(cur)) return { state: STATE.LOGIN_FAILED, text: STATE_TEXT[STATE.LOGIN_FAILED] }
    return { state: STATE.LOGGED_IN, text: `已登入 ${cur.email}` }
  }
  if (installed === true) return { state: STATE.INSTALLED_LOGGED_OUT, text: STATE_TEXT[STATE.INSTALLED_LOGGED_OUT] }
  if (installed === false) return { state: STATE.NOT_INSTALLED, text: STATE_TEXT[STATE.NOT_INSTALLED] }
  // 回報是新的、這家沒有帳號、也不知道有沒有裝：只能說沒有登入，不亂說未安裝
  return { state: STATE.LOGGED_OUT, text: STATE_TEXT[STATE.LOGGED_OUT] }
}

/**
 * 這家 AI 在這台設備上有沒有「安裝並登入」可以按（0.2.2 只有 Claude）。
 * → null（沒有）、{ kind: 'local' }（本人在這台電腦前按）、{ kind: 'remote' }（從別台／手機要它自己裝）
 * 手機不能被安裝；別台要在線、帳號回報是新的（確定它是這個狀態）才給；已經登入的不給（要換帳號走切換帳號）
 */
export function installAction({ vendor, isSelf = false, phone = false, online = false, asnOnline = true, state = '' } = {}) {
  if (vendor !== 'claude' || phone) return null
  if (![STATE.NOT_INSTALLED, STATE.INSTALLED_LOGGED_OUT, STATE.LOGGED_OUT, STATE.UNKNOWN_INSTALL].includes(state)) return null
  if (isSelf) return { kind: 'local' }
  if (!online || asnOnline !== true) return null
  return { kind: 'remote' }
}

/** 主要幾家 AI：設備卡上就算這台沒用到也要列出「未安裝／不確定」 */
export const CORE_VENDORS = Object.freeze(['claude', 'codex', 'grok'])
