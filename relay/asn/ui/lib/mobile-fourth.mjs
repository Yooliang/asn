// 手機的內頁（#461、PR-H #895）：設備與帳號、設定的某一項（個人、提醒、更新、關於）、使用指引、開新夥伴。
// 內頁暫時佔用第四格（平時是「通知」），分頁字換成內頁的標題，和其他分頁一樣能左右滑、點分頁切；st.fourth＝null 就是第四格顯示通知。
// 0.2.18 曾改成蓋在進來的那個分頁上，#1429（小良哥 2026-11-13）改回 0.2.17 的做法。
// 同一時間只有一個內頁：進別的內頁就換掉內容。切到別的分頁後留著、內容不卸載，滿 3 分鐘沒回來、或這段時間有新通知進來，就變回「通知」。
// 只放純邏輯（內頁的描述、計時），node 與瀏覽器都能跑，不碰 DOM、不碰瀏覽記錄（瀏覽記錄在 mobile-nav.mjs）。
import { guideByKey } from './guides.mjs'
import { SETTING_SHEET_KEYS } from './mobile-settings.mjs'

export const PAGE_TAB = 'page'   // 第四格是內頁、正在看它時 nav.tab 的值
export const FOURTH_KEEP_MS = 180000   // 離開內頁後保留多久（3 分鐘），用絕對時間判斷：App 在背景時照樣算

// ---------- 內頁的描述：{ kind, ... } ----------
// 設定的某一項：cat＝分類鍵（設備與帳號不算，它有自己的內頁）；沒有這個分類回 null
export const settingPage = key => (SETTING_SHEET_KEYS.includes(key) ? { kind: 'setting', cat: key } : null)
// 使用指引：guide＝正在看哪一篇（空字串＝篇目列表）
export const guidePage = (key = '') => ({ kind: 'guide', guide: guideByKey(key) ? key : '' })
// 設備與帳號：node＝正在看哪一台的細部（空字串＝設備列表）
export const ACCT_NODE_MAX = 200
export const acctPage = (node = '') => ({ kind: 'acct', node: typeof node === 'string' && node.length <= ACCT_NODE_MAX ? node : '' })
// 開新夥伴：step＝第幾步（1＝選電腦，2＝選模型與資料夾、名字、第一句話）；其他值都當第 1 步
export const launchPage = step => ({ kind: 'launch', step: step === 2 ? 2 : 1 })
// 瀏覽記錄裡讀回來的內頁描述可能是任何東西：整理成合法的描述，不合法回 null
export function normalizePage(raw) {
  switch (raw?.kind) {
    case 'setting': return settingPage(raw.cat)
    case 'guide': return guidePage(raw.guide)
    case 'acct': return acctPage(raw.node)
    case 'launch': return launchPage(raw.step)
    default: return null
  }
}
export const samePage = (a, b) => JSON.stringify(normalizePage(a)) === JSON.stringify(normalizePage(b))
// 內頁自己的層（由外往內）：指引單篇的下面是篇目列表、設備細部的下面是設備列表、開新夥伴第 2 步的下面是第 1 步；返回鍵一層一層退，退到頭才收起內頁
export function pageLayers(raw) {
  const p = normalizePage(raw)
  if (!p) return []
  if (p.kind === 'guide' && p.guide) return [guidePage(), p]
  if (p.kind === 'acct' && p.node) return [acctPage(), p]
  if (p.kind === 'launch' && p.step === 2) return [launchPage(), p]
  return [p]
}

// ---------- 內頁的狀態：{ page, from, leftAt } ----------
// from＝從哪個分頁進來的（退到頭回那裡）；leftAt＝切到別的分頁的時間（0＝正在看或還沒離開過）
export const openFourth = (page, from = 'chats') => ({ page: normalizePage(page), from: typeof from === 'string' && from && from !== PAGE_TAB ? from : 'chats', leftAt: 0 })
// 換了大分頁：切到內頁就取消計時；從內頁切走才開始算（已經在算的不重算）
export function fourthOnTab(fourth, tab, now) {
  if (!fourth) return null
  if (tab === PAGE_TAB) return fourth.leftAt ? { ...fourth, leftAt: 0 } : fourth
  return fourth.leftAt ? fourth : { ...fourth, leftAt: now }
}
export const fourthExpired = (fourth, now, keep = FOURTH_KEEP_MS) => !!fourth && fourth.leftAt > 0 && now - fourth.leftAt >= keep
// 還剩多久收起（毫秒）；沒在計時回 Infinity
export const fourthMsLeft = (fourth, now, keep = FOURTH_KEEP_MS) => (fourth?.leftAt > 0 ? Math.max(0, keep - (now - fourth.leftAt)) : Infinity)
// 有新通知進來：已經離開內頁（在計時）就馬上把第四格讓回給通知；正在看內頁時不搶（紅點會亮在第四格）
export const fourthOnNotice = fourth => (fourth?.leftAt > 0 ? null : fourth ?? null)

// ---------- 換內頁前先問一句 ----------
// 開新夥伴正在填第 2 步、還沒送出（draft＝true）時，要換成別的內頁就先問；選離開才換。單純切到別的分頁不問（內容會保留 3 分鐘），再進開新夥伴也不問（接著填）
export const LEAVE_ASK_TEXT = { title: '還沒送出', lead: '開新夥伴還沒送出，要離開嗎？', leave: '離開', stay: '留下' }
export const needsLeaveAsk = (fourth, next, { draft = false } = {}) => !!draft && fourth?.page?.kind === 'launch' && !!normalizePage(next) && normalizePage(next).kind !== 'launch'
