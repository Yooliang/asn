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
 * 這台是不是「雲端夥伴」（#930，0.2.15）：**沒有電腦版 ASN、只有橋或雲端代理的節點**。
 * 例：Grok 雲端代理、牧陽 Aegis 的轉接橋、日本VM（無畫面 Linux，只有橋＋代理）。手機不算；有電腦版 ASN 的實體電腦不算。
 * 規則若要改（小良哥決定），只改這一個函式；電腦版與手機版的設備分組都呼叫它。
 *
 * 用到的資料（電腦版、手機版都拿得到，不需要新的後台回報）：
 *   - phone：isPhoneDevice 的結果（後台平台優先、再看名單種類）
 *   - asnOnline：這台現在有沒有在線的 ASN 視窗（名單帶的 asn，只有 ASN 應用程式會回報；橋與雲端代理不會）
 *   - rep：這台的帳號回報（acct_list：{ error, reportedAt }）。帳號回報**只有電腦版 ASN 會送**（每 5 分鐘），
 *     後台存最後一次的時間；有 reportedAt＝這台曾經跑過電腦版 ASN，即使現在離線也算數
 *   - engines：這台名單上各視窗的引擎；全部是 'cloud'（雲端代理）就是雲端
 * 平台（platform）不能拿來判斷：機器橋也會回報 linux／windows，日本VM 就是 linux。
 *
 * 回傳 true／false／null。null＝資料還不夠，不要猜：例如手機還沒讀這台的帳號回報、或讀取失敗，而且現在沒有 ASN 在線。
 * 呼叫端拿到 null 一律暫放「電腦」，不猜成雲端；手機版不為了分組多讀帳號回報，讀到之後自然會歸對（asn真 定，#995）。
 * 已接受的情況：新裝的電腦剛好離線、又還沒送過帳號回報時，可能被判成 null 或雲端（asn真 定，#995）。
 */
export function isCloudNode({ phone = false, self = false, asnOnline = false, rep = undefined, engines = [] } = {}) {
  if (phone) return false
  if (self) return false                       // 本機：電腦版自己就是電腦版 ASN；手機版的本機是手機（上一行）
  if (asnOnline) return false                  // 現在就有電腦版 ASN 在線
  if (rep && !rep.error && rep.reportedAt) return false   // 曾經跑過電腦版 ASN（帳號回報只有它會送）
  const list = (engines ?? []).map(e => String(e ?? '').toLowerCase()).filter(Boolean)
  if (list.length && list.every(e => e === 'cloud')) return true   // 只有雲端代理
  if (rep && !rep.error && !rep.reportedAt) return true            // 讀到了：從沒有電腦版 ASN 回報過
  return null                                  // 沒讀到帳號回報（或讀取失敗）、也沒有其他證據
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

/** 「安裝並登入 Claude Code」的畫面入口（電腦版按鈕、允許從手機安裝的勾選、手機版按鈕）。完整真機流程沒跑過前不給一般使用者按；跑過再改成 true */
export const AGENT_INSTALL_UI = false

/**
 * 這家 AI 在這台設備上有沒有「安裝並登入」可以按（0.2.2 只有 Claude）。
 * → null（沒有）、{ kind: 'local' }（本人在這台電腦前按）、{ kind: 'remote' }（從別台／手機要它自己裝）
 * 手機不能被安裝；別台要在線、帳號回報是新的（確定它是這個狀態）才給；已經登入的不給（要換帳號走切換帳號）
 */
export function installAction({ vendor, isSelf = false, phone = false, online = false, asnOnline = true, state = '' } = {}) {
  if (vendor !== 'claude' || phone) return null
  if (![STATE.NOT_INSTALLED, STATE.INSTALLED_LOGGED_OUT, STATE.LOGGED_OUT, STATE.UNKNOWN_INSTALL].includes(state)) return null
  // 本機偵測很快就會有結果：還不確定有沒有裝時先不給，免得偵測還沒跑完就出現按鈕
  if (isSelf) return state === STATE.UNKNOWN_INSTALL ? null : { kind: 'local' }
  if (!online || asnOnline !== true) return null
  return { kind: 'remote' }
}

/** 主要幾家 AI：設備卡上就算這台沒用到也要列出「未安裝／不確定」 */
export const CORE_VENDORS = Object.freeze(['claude', 'codex', 'grok'])

const SHORT_TEXT = Object.freeze({
  [STATE.LOGGED_IN]: '已登入',
  [STATE.LOGIN_FAILED]: '登入失效',
  [STATE.INSTALLED_LOGGED_OUT]: '已安裝未登入',
  [STATE.LOGGED_OUT]: '沒有登入',
  [STATE.NOT_INSTALLED]: '未安裝',
  [STATE.UNKNOWN_INSTALL]: '不確定是否安裝',
})

/**
 * 設備列表每一列的一行摘要，例如「Claude 已登入、Codex 未安裝」。
 * 手機沒有；別台離線看不到狀態；別台回報不是新的就只說一句「還沒收到這台的回報」（不逐家說，免得被讀成沒登入）
 */
export function deviceStateLine({ vendors = [], missing = [], phone = false, online = true, self = false } = {}) {
  if (phone) return ''
  if (!self && !online) return '離線，看不到狀態'
  const all = [...vendors, ...missing]
  if (!all.length) return ''
  if (all.some(v => v.state === STATE.NO_REPORT)) return STATE_TEXT[STATE.NO_REPORT]
  const shown = all.filter(v => SHORT_TEXT[v.state])
  // 全部都不確定有沒有裝：合成一句，不要「Claude 不確定、Codex 不確定、Grok 不確定」重複三次
  if (shown.length && shown.every(v => v.state === STATE.UNKNOWN_INSTALL)) return '不確定這台裝了哪些 AI'
  // 部分不確定：不確定的併成一組（「Codex／Grok 不確定是否安裝」）
  const known = shown.filter(v => v.state !== STATE.UNKNOWN_INSTALL).map(v => `${v.label} ${SHORT_TEXT[v.state]}`)
  const unknown = shown.filter(v => v.state === STATE.UNKNOWN_INSTALL).map(v => v.label)
  return [...known, ...(unknown.length ? [`${unknown.join('／')} ${SHORT_TEXT[STATE.UNKNOWN_INSTALL]}`] : [])].join('、')
}
