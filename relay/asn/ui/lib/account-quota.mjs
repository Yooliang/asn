// 各 Claude 帳號的剩餘額度顯示（#228）：純邏輯，node 與瀏覽器都能跑。
// 資料來源是各電腦自己記下的「上次看到的額度」（Claude Code 狀態列資料，只記數字），
// 只有用過、且當時有送出額度的帳號才有；沒有紀錄就老實寫「額度未知」，不編數字。
import { agoText } from './cloud-invite.mjs'

export const STALE_MS = 6 * 3600_000
export const QUOTA_NOTE = '額度是那台電腦上次記下的數字，只有用過的帳號才有；沒有紀錄的寫「額度未知」，超過 6 小時的標「資料較舊」。'

const pct = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null)

// 只取四個額度欄位（其他欄位一律丟掉）
export function quotaOf(a) {
  if (!a || typeof a !== 'object') return undefined
  const q = {}
  for (const k of ['five_hour_pct', 'weekly_pct', 'reset_at', 'at']) if (a[k] != null) q[k] = a[k]
  return q
}

function clock(ms, now) {
  const d = new Date(ms), n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export function quotaView(a, now = Date.now()) {
  const five = pct(a?.five_hour_pct), week = pct(a?.weekly_pct)
  const at = Date.parse(a?.at ?? '')
  if ((five == null && week == null) || !Number.isFinite(at)) {
    return { known: false, text: '額度未知', meta: '', resetText: '', stale: true, exhausted: false }
  }
  const parts = []
  if (five != null) parts.push(`5 小時剩 ${five}%`)
  if (week != null) parts.push(`每週剩 ${week}%`)
  const reset = Date.parse(a?.reset_at ?? '')
  const zero = five === 0 || week === 0
  let exhausted = false, resetText = ''
  if (zero) {
    if (!Number.isFinite(reset)) resetText = '重置時間未知'
    else if (reset > now) { exhausted = true; resetText = `${clock(reset, now)} 重置` }
    else resetText = '重置時間已過，可能已恢復'
  }
  const stale = now - at > STALE_MS
  const ago = agoText(a.at, now)
  return { known: true, text: parts.join('、'), meta: stale ? `${ago}・資料較舊` : ago, resetText, stale, exhausted }
}
