// 帳號設定：群組裡 AI 之間互相叫醒的上限（每次真人發言之後最多幾輪；0＝AI 不能互相叫醒）。
// 純邏輯：電腦版與手機版設定頁共用；後台規則見 supabase/migrations/20261023190000_group_ai_wake_limit.sql。
export const AI_WAKE_LIMIT_DEFAULT = 20
export const AI_WAKE_LIMIT_MAX = 200
export const AI_WAKE_LIMIT_LABEL = 'AI 之間互相叫醒的上限（每次你發言後）'
export const AI_WAKE_LIMIT_NOTE = '你在群組發言後，AI 之間最多可以互相叫醒幾輪。0 表示 AI 不能互相叫醒，你再發言才重新計算。'

/** 輸入檢查：0～200 的整數（數字或文字都收）。回 { ok, value, error } */
export function checkAiWakeLimit(raw) {
  const t = String(raw ?? '').trim()
  if (!/^\d{1,3}$/.test(t)) return { ok: false, value: AI_WAKE_LIMIT_DEFAULT, error: `請輸入 0 到 ${AI_WAKE_LIMIT_MAX} 的整數` }
  const value = Number(t)
  if (value > AI_WAKE_LIMIT_MAX) return { ok: false, value: AI_WAKE_LIMIT_DEFAULT, error: `請輸入 0 到 ${AI_WAKE_LIMIT_MAX} 的整數` }
  return { ok: true, value, error: '' }
}
