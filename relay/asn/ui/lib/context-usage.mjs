// Claude 視窗的上下文用量：名單上的小字提示與「快要壓縮了」提醒。純函式，可單測。
// 資料來源：外掛狀態檔的 context.percent → 內建收發室回報名單的 context_pct（0～100 整數，沒有就不帶）。

export const CONTEXT_SHOW_PCT = 70   // 達到這個百分比，名單上才顯示小字
export const CONTEXT_WARN_PCT = 90   // 達到這個百分比，小字變紅，並跳一次提醒

/** 後台給的 context_pct → 0～100 整數；不是有限數字、超出範圍一律當沒有（null） */
export function pctOf(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null
}

/** 名單項目旁的小字：{ text, danger }；用量不到 70％或沒有資料＝null */
export function contextLabel(friend) {
  const p = pctOf(friend?.contextPct)
  if (p === null || p < CONTEXT_SHOW_PCT) return null
  return { text: `上下文 ${p}%`, danger: p >= CONTEXT_WARN_PCT }
}

/** 提醒文字 */
export function contextAlertText(nick, pct) {
  return `${String(nick ?? '').trim() || '夥伴'} 的上下文已用 ${pctOf(pct) ?? 0}%，快要壓縮了`
}

/**
 * 升破 90％的偵測（記在記憶體）。每次名單更新呼叫 update(friends)，回傳「這次剛升破」的 [{ id, pct }]。
 * - 同一個視窗一次升破只提醒一次；降回 90％以下再升上去才再提醒。
 * - 第一次呼叫只記下現況不提醒（程式剛開就已經很滿的視窗，不算「剛升破」）。
 * - 這一輪沒有用量資料（null：外掛狀態過期、視窗離線）的視窗，保留原本的記錄，不當成降回去。
 */
export function createContextWatch() {
  const alerted = new Map()   // id → 目前是否已提醒過（處於 ≥90％）
  let seeded = false
  return {
    update(friends) {
      const out = []
      for (const f of Array.isArray(friends) ? friends : []) {
        const id = f?.id
        const p = pctOf(f?.contextPct)
        if (typeof id !== 'string' || p === null) continue
        const high = p >= CONTEXT_WARN_PCT
        if (high && !alerted.get(id) && seeded) out.push({ id, pct: p })
        alerted.set(id, high)
      }
      seeded = true
      return out
    },
  }
}
