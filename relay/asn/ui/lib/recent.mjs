// 手機「夥伴」名單最上面的「最近有活動」分組（純邏輯，node 與瀏覽器共用）。
// 列出最近 8 小時內有往來（收或發）的夥伴與群組，最多 8 個，依最後活動時間新到舊；沒有任何近期活動就回空陣列（畫面不顯示這組）。
// 同一夥伴在下方設備分組照常出現（這裡只是多一份捷徑，不從原分組拿掉）。

export const RECENT_GROUP_KEY = 'recent'
export const RECENT_GROUP_LABEL = '最近有活動'
export const RECENT_WINDOW_MS = 8 * 60 * 60 * 1000   // 跟電腦版「活躍」同一個門檻（#347，activity.mjs 的 ACTIVE_WINDOW_MS）
export const RECENT_MAX = 8

// 一段對話記錄的最後往來時間：只算「收（them）」與「發（me）」，系統提示行不算
export function lastTrafficAt(log) {
  let at = 0
  for (const e of Array.isArray(log) ? log : []) {
    if ((e?.k === 'me' || e?.k === 'them') && Number.isFinite(e.t) && e.t > at) at = e.t
  }
  return at
}

/**
 * friends：名單上的夥伴（已套用搜尋、不含已封存）；logOf(id)：該夥伴的對話記錄；rooms：roomItems 的列（有 at）。
 * 回 [{ kind: 'friend', id, at, friend } | { kind: 'room', id, at, room }]
 */
export function recentActivity({ friends = [], logOf = () => [], rooms = [], now = Date.now(), windowMs = RECENT_WINDOW_MS, max = RECENT_MAX } = {}) {
  const since = now - windowMs
  const rows = []
  const seen = new Set()
  for (const f of Array.isArray(friends) ? friends : []) {
    if (!f || typeof f.id !== 'string' || seen.has(f.id) || f.room) continue
    seen.add(f.id)
    const at = lastTrafficAt(logOf(f.id))
    if (at >= since && at <= now + 60_000) rows.push({ kind: 'friend', id: f.id, at, friend: f })
  }
  for (const r of Array.isArray(rooms) ? rooms : []) {
    if (!r || typeof r.chatId !== 'string') continue
    if (Number.isFinite(r.at) && r.at >= since && r.at <= now + 60_000) rows.push({ kind: 'room', id: r.chatId, at: r.at, room: r })
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, Math.max(0, max))
}
