// 各 Claude 帳號的剩餘額度顯示（#228）：純邏輯，node 與瀏覽器都能跑。
// 資料來源是各電腦自己記下的「上次看到的額度」（Claude Code 狀態列資料，只記數字），
// 只有用過、且當時有送出額度的帳號才有；沒有紀錄就老實寫「額度未知」，不編數字。
import { agoText } from './cloud-invite.mjs'

export const STALE_MS = 6 * 3600_000
export const QUOTA_NOTE = '額度是各台電腦上次讀到的數字。'   // 手機「設備與帳號」最下面的一句（#374 縮短）

const pct = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null)

// 只取額度欄位（舊四欄＋兩條各自的重置時間，#374；其他欄位一律丟掉）
const QUOTA_KEYS = ['five_hour_pct', 'weekly_pct', 'reset_at', 'at', 'five_reset_at', 'week_reset_at']
export function quotaOf(a) {
  if (!a || typeof a !== 'object') return undefined
  return Object.fromEntries(QUOTA_KEYS.filter(k => a[k] != null).map(k => [k, a[k]]))
}

// ---- 一條額度自己的重置時間（#374）----
export const RESET_PASSED = '可能已恢復'   // 重置時間已經過了：記著的百分比不代表現在
export const OLD_TEXT = '資料較舊'
export const PLAN_UNKNOWN = '方案未知'   // 帳號卡第二行：沒有回報方案時
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']
const two = n => String(n).padStart(2, '0')

/** 重置時間 → 「約 N 分鐘後重置」「約 N 小時後重置」（一天內）、「週六 14:00 重置」（超過一天，本地時區）、已過「可能已恢復」；沒有或壞掉回空字串 */
export function resetWhen(resetAt, now = Date.now()) {
  const t = Date.parse(typeof resetAt === 'string' ? resetAt : '')
  if (!Number.isFinite(t)) return ''
  const ms = t - now
  if (ms <= 0) return RESET_PASSED
  if (ms < 3600_000) return `約 ${Math.min(59, Math.max(1, Math.round(ms / 60_000)))} 分鐘後重置`
  if (ms <= 24 * 3600_000) return `約 ${Math.round(ms / 3600_000)} 小時後重置`
  const d = new Date(t)
  return `${WEEKDAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())} 重置`
}

/** 一條額度條：{ key, label, pct, low, reset, expired }。reset＝這條自己的重置時間（空＝不寫）；expired＝重置時間已過（畫面不寫舊百分比） */
export function quotaBar(key, label, p, resetAt, now = Date.now()) {
  const reset = resetWhen(resetAt, now)
  return { key, label, pct: p, low: p <= LOW_PCT, reset, expired: reset === RESET_PASSED }
}

/** 方案 → 給人看的名字：claude_max「Max」、pro「Pro」、claude_max_20x「Max 20x」；有空白或大寫的（例如「Google AI Pro」）照舊 */
export function planLabel(plan) {
  const s = typeof plan === 'string' ? plan.trim() : ''
  if (!s || /[\sA-Z]/.test(s) || !/^[a-z0-9_-]+$/.test(s)) return s
  const words = s.replace(/^(claude|chatgpt|openai|anthropic)[_-]/, '').split(/[_-]+/).filter(Boolean)
  return words.map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
}

// 有沒有兩條各自的重置時間（新版電腦才有；舊版只有一個 reset_at）
const hasSplit = a => typeof a?.five_reset_at === 'string' || typeof a?.week_reset_at === 'string'
// 兩條額度條（5 小時、每週）：新欄位各帶各的重置時間；舊版不帶（整段另寫一句）
function barsOf(a, now) {
  const split = hasSplit(a)
  return [['five', '5 小時', pct(a?.five_hour_pct), a?.five_reset_at], ['week', '每週', pct(a?.weekly_pct), a?.week_reset_at]]
    .filter(([, , p]) => p != null)
    .map(([key, label, p, r]) => quotaBar(key, label, p, split ? r : undefined, now))
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
    return { known: false, text: '額度未知', meta: '', resetText: '', resetLine: '', bars: [], oldText: '', stale: true, exhausted: false }
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
  // bars：兩條額度條（#374）。有新欄位時各條自己寫重置時間，resetLine 空；舊版電腦沒有新欄位，resetLine＝照舊的那一句
  // oldText 空：「資料較舊」已經寫在 meta 裡
  const split = hasSplit(a)
  const zeroBar = split ? barsOf(a, now).find(b => b.pct === 0 && b.reset && !b.expired) : null
  if (split) { exhausted = Boolean(zeroBar); resetText = zeroBar ? zeroBar.reset : resetText }
  return {
    known: true, text: parts.join('、'), meta: stale ? `${ago}・${OLD_TEXT}` : ago, resetText, resetLine: split ? '' : resetText,
    bars: barsOf(a, now), oldText: '', stale, exhausted,
  }
}

// ---- 電腦版設定頁的額度條（#374）：5 小時、每週兩條剩餘百分比，重置時間寫「約 N 小時後」 ----
export const NO_QUOTA_TEXT = '沒有額度資料'   // Codex、Grok 沒有額度回報
export const NOT_CONNECTED_TEXT = '尚未接上，到「啟動設定」的「額度回報」接上'
export const LOW_PCT = 20   // 剩這麼多以下，條改成警示色

/** 重置時間 → 「約 N 小時後重置」（不到 1 小時寫「不到 1 小時後重置」；已過或沒有就空字串）。who＝哪一條的（例如「5 小時額度」），放在最前面 */
export function resetIn(resetAt, now = Date.now(), who = '') {
  const t = Date.parse(resetAt ?? '')
  if (!Number.isFinite(t) || t <= now) return ''
  const h = Math.round((t - now) / 3600_000)
  return `${who}${h < 1 ? '不到 1 小時後重置' : `約 ${h} 小時後重置`}`
}

/**
 * 重置時間是哪一條的：跟電腦端 claude_quota.rs 的規則一致——用完（剩 0%）的那條；兩條都用完是較晚的那個（兩條都要等）；
 * 都沒用完就是 5 小時那條（沒有 5 小時的就是每週的）。那條自己沒有重置時間時，電腦端不存（不拿另一條的來頂），這裡就不會標錯
 */
export function resetOwner(five, week) {
  if (five === 0 && week === 0) return '兩條額度都'
  if (week === 0) return '每週額度'
  if (five === 0 || five != null) return '5 小時額度'
  return week != null ? '每週額度' : ''
}

/**
 * 一個 Claude 帳號的額度條。hookOn＝這台的「額度回報」有沒有接上（還沒查到給 null）。
 * 回 { bars: [{ key, label, pct, low }], note, reset, meta, stale }；沒有數字時 bars 是空的，note 寫原因（沒接上就提醒去接上），不編數字
 */
export function quotaBars(a, { hookOn = null, now = Date.now() } = {}) {
  const v = quotaView(a, now)
  const bars = v.known ? v.bars : []
  if (!bars.length) return { bars, note: hookOn === false ? NOT_CONNECTED_TEXT : v.text, reset: '', meta: '', stale: true }
  // 有兩條各自的重置時間（#374）就各條自己寫，這一句空；舊版紀錄照舊寫一句、標明是哪一條的
  const reset = hasSplit(a) ? '' : resetIn(a?.reset_at, now, resetOwner(pct(a?.five_hour_pct), pct(a?.weekly_pct)))
  return { bars, note: '', reset, meta: v.meta, stale: v.stale }
}
