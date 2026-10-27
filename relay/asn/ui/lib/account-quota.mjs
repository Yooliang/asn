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

// ---- 電腦版設定頁的額度條（#374）：5 小時、每週兩條剩餘百分比，重置時間寫「約 N 小時後」 ----
export const NO_QUOTA_TEXT = '沒有額度資料'   // Codex、Grok 沒有額度回報
export const NOT_CONNECTED_TEXT = '尚未接上，到「啟動設定」的「額度回報」接上'
export const LOW_PCT = 20   // 剩這麼多以下，條改成警示色

/** 重置時間 → 「約 N 小時後重置」（不到 1 小時寫「不到 1 小時後重置」；已過或沒有就空字串） */
export function resetIn(resetAt, now = Date.now()) {
  const t = Date.parse(resetAt ?? '')
  if (!Number.isFinite(t) || t <= now) return ''
  const h = Math.round((t - now) / 3600_000)
  return h < 1 ? '不到 1 小時後重置' : `約 ${h} 小時後重置`
}

/**
 * 一個 Claude 帳號的額度條。hookOn＝這台的「額度回報」有沒有接上（還沒查到給 null）。
 * 回 { bars: [{ key, label, pct, low }], note, reset, meta, stale }；沒有數字時 bars 是空的，note 寫原因（沒接上就提醒去接上），不編數字
 */
export function quotaBars(a, { hookOn = null, now = Date.now() } = {}) {
  const v = quotaView(a, now)
  const bars = [['five', '5 小時', pct(a?.five_hour_pct)], ['week', '每週', pct(a?.weekly_pct)]]
    .filter(([, , p]) => p != null && v.known)
    .map(([key, label, p]) => ({ key, label, pct: p, low: p <= LOW_PCT }))
  if (!bars.length) return { bars, note: hookOn === false ? NOT_CONNECTED_TEXT : v.text, reset: '', meta: '', stale: true }
  return { bars, note: '', reset: resetIn(a?.reset_at, now), meta: v.meta, stale: v.stale }
}
