// 名單的「活躍度」（#347，取代原本依忙閒分組）：純邏輯，桌面與手機共用。
// 三級：active＝在線且近 8 小時有收發；idle＝在線但 8 小時沒往來；offline＝離線。忙碌、暫離不再分組，只在名字後面用小字表示。
// 防跳：進活躍立刻生效；離開活躍要再多等 5 分鐘；判成離線要連續 3 分鐘不在名單上。收發時間取本機對話記錄、名單列的 lastAt 與後台的最後活動時間（activeAt，E3 #397：別台設備、在終端裡忙的也看得到）三者最新的；舊後台沒有 activeAt 就跟以前一樣。
import { lastTrafficAt } from './recent.mjs'

export const ACTIVE_WINDOW_MS = 8 * 60 * 60 * 1000
export const LEAVE_GRACE_MS = 5 * 60 * 1000
export const OFFLINE_DEBOUNCE_MS = 3 * 60 * 1000
export const ACTIVITY_LEVELS = Object.freeze([['active', '活躍'], ['idle', '閒置'], ['offline', '離線']])
export const activityRank = level => { const i = ACTIVITY_LEVELS.findIndex(([k]) => k === level); return i < 0 ? 1 : i }

/** 不帶防跳的原始判斷。lastAt＝最後一次收或發的時間（毫秒，0＝沒有） */
export function rawActivity(status, lastAt, now) {
  if (status === 'offline') return 'offline'
  return Number.isFinite(lastAt) && lastAt > 0 && lastAt >= now - ACTIVE_WINDOW_MS ? 'active' : 'idle'
}

/**
 * 帶防跳的下一個狀態。prev＝上一輪的 { level, offSince }（第一次是 undefined）。回新的 { level, offSince }。
 * - 名單說離線：連續 OFFLINE_DEBOUNCE_MS 才算離線，這段時間維持上一輪的級別（第一次見到就離線的直接算離線）。
 * - 原始是閒置但上一輪是活躍：最後往來還在 8 小時＋5 分鐘內就維持活躍。
 */
export function nextActivity(prev, { status, lastAt }, now) {
  const raw = rawActivity(status, lastAt, now)
  if (raw === 'offline') {
    if (!prev || prev.level === 'offline') return { level: 'offline', offSince: prev?.offSince ?? now }
    const offSince = Number.isFinite(prev.offSince) ? prev.offSince : now
    return now - offSince >= OFFLINE_DEBOUNCE_MS ? { level: 'offline', offSince } : { level: prev.level, offSince }
  }
  if (raw === 'idle' && prev?.level === 'active' && Number.isFinite(lastAt) && lastAt >= now - ACTIVE_WINDOW_MS - LEAVE_GRACE_MS) return { level: 'active', offSince: null }
  return { level: raw, offSince: null }
}

/**
 * 整份名單算一輪。friends：名單列（有 id、status，lastAt／activeAt 可選）；logOf(id)：該夥伴的對話記錄；prev：上一輪回傳的 Map。
 * 回新的 Map（id → { level, offSince }）；名單上沒有的不保留。
 */
export function activityRound(friends, { logOf = () => [], prev = new Map(), now = Date.now() } = {}) {
  const out = new Map()
  for (const f of Array.isArray(friends) ? friends : []) {
    if (!f || typeof f.id !== 'string') continue
    const lastAt = Math.max(Number.isFinite(f.lastAt) ? f.lastAt : 0, Number.isFinite(f.activeAt) ? f.activeAt : 0, lastTrafficAt(logOf(f.id)))
    out.set(f.id, nextActivity(prev.get(f.id), { status: f.status, lastAt }, now))
  }
  return out
}

/** 一列的活躍度：有算過就用 activity 欄位；沒算過（手機、測試、剛開）就離線＝offline、其餘先當閒置 */
export const levelOf = f => f?.activity ?? (f?.status === 'offline' ? 'offline' : 'idle')

/** 名單列加上 activity 欄位 */
export const withActivity = (friends, map) => (Array.isArray(friends) ? friends : []).map(f => ({ ...f, activity: map?.get(f.id)?.level ?? levelOf(f) }))
