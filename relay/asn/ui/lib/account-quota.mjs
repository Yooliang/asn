// 額度顯示的共用文字與小工具（#228、#1883）：純邏輯，node 與瀏覽器都能跑。
// 數字的來源只有一條：各電腦的 ASN 直接向 Claude 查「這台目前登入的帳號」，送到後台，畫面讀後台的列表（account-roster.mjs）；
// 這台自己目前登入的帳號另外讀本機的查詢狀態（claude_quota_state）。沒有數字就照實寫原因，不編數字、不沿用舊數字冒充現在的。

export const STALE_MS = 6 * 3600_000
export const QUOTA_NOTE = '額度是各台電腦上次讀到的數字。'   // 手機「設備與帳號」最下面的一句（#374 縮短）

// ---- 一條額度自己的重置時間（#374）----
export const OLD_TEXT = '資料較舊'
export const PLAN_UNKNOWN = '方案未知'   // 帳號卡第二行：沒有回報方案時
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']
const two = n => String(n).padStart(2, '0')

/** 重置時間 → 「約 N 分鐘後重置」「約 N 小時後重置」（一天內）、「週六 14:00 重置」（超過一天，本地時區）；已過、沒有或壞掉回空字串 */
export function resetWhen(resetAt, now = Date.now()) {
  const t = Date.parse(typeof resetAt === 'string' ? resetAt : '')
  if (!Number.isFinite(t)) return ''
  const ms = t - now
  if (ms <= 0) return ''   // 已過：不下結論（不寫「已恢復」之類），那一窗沒有可信的數字
  if (ms < 3600_000) return `約 ${Math.min(59, Math.max(1, Math.round(ms / 60_000)))} 分鐘後重置`
  if (ms <= 24 * 3600_000) return `約 ${Math.round(ms / 3600_000)} 小時後重置`
  const d = new Date(t)
  return `${WEEKDAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())} 重置`
}

/** 一條額度條：{ key, label, pct, low, reset, expired }。reset＝這條自己的重置時間（空＝不寫）；expired＝重置時間已過（畫面不寫舊百分比） */
export function quotaBar(key, label, p, resetAt, now = Date.now()) {
  const reset = resetWhen(resetAt, now)
  const t = Date.parse(typeof resetAt === 'string' ? resetAt : '')
  return { key, label, pct: p, low: p <= LOW_PCT, reset, expired: Number.isFinite(t) && t <= now }
}

/** 方案 → 給人看的名字：claude_max「Max」、pro「Pro」、claude_max_20x「Max 20x」；有空白或大寫的（例如「Google AI Pro」）照舊 */
export function planLabel(plan) {
  const s = typeof plan === 'string' ? plan.trim() : ''
  if (!s || /[\sA-Z]/.test(s) || !/^[a-z0-9_-]+$/.test(s)) return s
  const words = s.replace(/^(claude|chatgpt|openai|anthropic)[_-]/, '').split(/[_-]+/).filter(Boolean)
  return words.map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
}

// ---- 電腦版設定頁的額度條（#374）：5 小時、每週兩條剩餘百分比，重置時間寫「約 N 小時後」 ----
export const NO_QUOTA_TEXT = '沒有額度資料'   // Codex、Grok 沒有額度回報
export const LOW_PCT = 20   // 剩這麼多以下，條改成警示色

/** 重置時間 → 「約 N 小時後重置」（不到 1 小時寫「不到 1 小時後重置」；已過或沒有就空字串）。who＝哪一條的（例如「5 小時額度」），放在最前面 */
export function resetIn(resetAt, now = Date.now(), who = '') {
  const t = Date.parse(resetAt ?? '')
  if (!Number.isFinite(t) || t <= now) return ''
  const h = Math.round((t - now) / 3600_000)
  return `${who}${h < 1 ? '不到 1 小時後重置' : `約 ${h} 小時後重置`}`
}

/** 沒有額度數字時寫什麼（電腦與手機同一份，#1879、#1883）。登入過期＝本機判斷或 Claude 回 401；查詢太頻繁＝429；暫時查不到＝其他連線問題 */
export const QUOTA_LINES = Object.freeze({
  unread: '額度讀不到',
  reading: '讀取中',
  loginExpired: '登入過期，用這個帳號開一次 Claude 就會恢復',
  rateLimited: '查詢太頻繁，稍後再試',
  unavailable: '暫時查不到',
  idle: '目前沒有設備在用',   // 這個 Claude 帳號現在沒有任何一台在登入使用：照樣顯示最後一次讀數與時間
})
