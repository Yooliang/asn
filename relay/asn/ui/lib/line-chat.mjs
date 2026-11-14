// LINE 外觀的對話區純邏輯（0.2.22，#1449 第二張）：時間文字、已讀文字、日期膠囊、連續訊息。
// 只算文字與旗標；畫面只在外觀是 LINE 時才用（lib/chatpane.mjs），復古 Aero／現代完全不碰這裡。
import { readLabel } from './mobile-rooms.mjs'
import { tierOf } from './sent-status.mjs'

export const CONT_GAP_MS = 3 * 60 * 1000   // 同一個人連發，間隔超過這麼久就重新顯示頭像與名字
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const num = t => (typeof t === 'number' ? t : Date.parse(t))
const dayKey = t => { const d = new Date(num(t)); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() }

/** 「下午 3:52」：中午十二點起算下午，零點是上午 12:00 */
export function clockLabel(t) {
  const d = new Date(num(t))
  if (Number.isNaN(d.getTime())) return ''
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0')
  return `${h < 12 ? '上午' : '下午'} ${h % 12 || 12}:${m}`
}

/** 日期膠囊文字：今天不顯示（回空字串）；昨天「昨天」；更早「2026/11/14（六）」 */
export function dayPillText(t, now = Date.now()) {
  if (!Number.isFinite(num(t))) return ''
  const k = dayKey(t), today = dayKey(now)
  if (k === today) return ''
  const y = new Date(num(now)); y.setDate(y.getDate() - 1)
  if (k === dayKey(y.getTime())) return '昨天'
  const d = new Date(num(t))
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`
}

/**
 * 自己寄出訊息旁的狀態文字（只認後台真的回報過的資料，不拿「已送出」冒充已讀）：
 * 一對一：已送達 ✓；對方讀過或已回覆「已讀」；其餘（只是已送出）不顯示。
 * 群組：沿用既有的「已讀 N」「全部已讀」（資料是後台的 reads）。
 */
export function sentStateText(m, isRoom) {
  if (!m || m.k !== 'me') return ''
  if (isRoom) return readLabel(m.rd)
  const tier = tierOf(m)
  if (tier === 'delivered') return '✓'
  if (tier === 'read' || tier === 'replied') return '已讀'
  return ''
}

const speakerOf = (m, friendNick) => (m.k === 'me' ? '\u0000me' : String(m.who || friendNick || ''))

/**
 * 逐則算 LINE 版面要的旗標（回傳陣列，與 log 一一對應；系統提示那一格是 {}）：
 *  cont：與上一則同一人、同一天、間隔不長 → 省略頭像與名字
 *  pill：這一則是新的一天的第一則時的日期膠囊文字（今天不顯示）
 */
export function lineRows(log, { now = Date.now(), friendNick = '' } = {}) {
  const out = []
  let prev = null
  for (const m of Array.isArray(log) ? log : []) {
    if (!m || m.k === 'sys') { out.push({}); prev = null; continue }
    const sameDay = prev && Number.isFinite(num(m.t)) && dayKey(prev.t) === dayKey(m.t)
    const cont = Boolean(sameDay && prev.k === m.k && speakerOf(prev, friendNick) === speakerOf(m, friendNick)
      && Math.abs(num(m.t) - num(prev.t)) <= CONT_GAP_MS)
    const newDay = !prev || !sameDay
    out.push({ cont, pill: newDay ? dayPillText(m.t, now) : '' })
    prev = m
  }
  return out
}
