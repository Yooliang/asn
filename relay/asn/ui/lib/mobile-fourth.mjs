// 手機的「第四頁籤」（#461）：設備與帳號、設置的某一項（個人、通知、更新、關於）、使用指引，不再是蓋在分頁上的滿版層，
// 而是平時不顯示、進這些內頁時才出現在頁籤列最右邊的一個分頁（標題就是內頁的標題），跟前三個一樣能左右滑、點頁籤切。
// 同一時間只有一個第四頁籤：進別的內頁就換掉內容。離開（切到前三頁）後留著、內容不卸載，滿 3 分鐘沒回來就收起。
// 只放純邏輯（內頁的描述、計時），node 與瀏覽器都能跑，不碰 DOM、不碰瀏覽記錄（瀏覽記錄在 mobile-nav.mjs）。
import { guideByKey } from './guides.mjs'
import { SETTING_SHEET_KEYS } from './mobile-settings.mjs'

export const PAGE_TAB = 'page'   // 第四頁籤在 nav.tab 裡的值
export const FOURTH_KEEP_MS = 180000   // 離開第四頁籤後保留多久（3 分鐘），用絕對時間判斷：App 在背景時照樣算

// ---------- 內頁的描述：{ kind, ... } ----------
// 設置的某一項：cat＝分類鍵（設備與帳號不算，它有自己的內頁）；沒有這個分類回 null
export const settingPage = key => (SETTING_SHEET_KEYS.includes(key) ? { kind: 'setting', cat: key } : null)
// 使用指引：guide＝正在看哪一篇（空字串＝篇目列表）
export const guidePage = (key = '') => ({ kind: 'guide', guide: guideByKey(key) ? key : '' })
// 設備與帳號：node＝正在看哪一台的細部（空字串＝設備列表）
export const ACCT_NODE_MAX = 200
export const acctPage = (node = '') => ({ kind: 'acct', node: typeof node === 'string' && node.length <= ACCT_NODE_MAX ? node : '' })
// 瀏覽記錄裡讀回來的內頁描述可能是任何東西：整理成合法的描述，不合法回 null
export function normalizePage(raw) {
  switch (raw?.kind) {
    case 'setting': return settingPage(raw.cat)
    case 'guide': return guidePage(raw.guide)
    case 'acct': return acctPage(raw.node)
    default: return null
  }
}
export const samePage = (a, b) => JSON.stringify(normalizePage(a)) === JSON.stringify(normalizePage(b))
// 內頁自己的層（由外往內）：指引單篇的下面是篇目列表、設備細部的下面是設備列表；返回鍵一層一層退，退到頭才收起第四頁籤
export function pageLayers(raw) {
  const p = normalizePage(raw)
  if (!p) return []
  if (p.kind === 'guide' && p.guide) return [guidePage(), p]
  if (p.kind === 'acct' && p.node) return [acctPage(), p]
  return [p]
}

// ---------- 第四頁籤的狀態：{ page, from, leftAt } ----------
// from＝從哪個頁籤進來的（退到頭回那裡）；leftAt＝切到前三頁的時間（0＝正在看或還沒離開過）
export const openFourth = (page, from = 'list') => ({ page: normalizePage(page), from: typeof from === 'string' && from && from !== PAGE_TAB ? from : 'list', leftAt: 0 })
// 換了大分頁：切到第四頁籤就取消計時；從第四頁籤切走才開始算（已經在算的不重算）
export function fourthOnTab(fourth, tab, now) {
  if (!fourth) return null
  if (tab === PAGE_TAB) return fourth.leftAt ? { ...fourth, leftAt: 0 } : fourth
  return fourth.leftAt ? fourth : { ...fourth, leftAt: now }
}
export const fourthExpired = (fourth, now) => !!fourth && fourth.leftAt > 0 && now - fourth.leftAt >= FOURTH_KEEP_MS
// 還剩多久收起（毫秒）；沒在計時回 Infinity
export const fourthMsLeft = (fourth, now) => (fourth?.leftAt > 0 ? Math.max(0, FOURTH_KEEP_MS - (now - fourth.leftAt)) : Infinity)
