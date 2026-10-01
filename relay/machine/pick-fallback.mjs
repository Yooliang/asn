// 預設收件視窗不在線時，挑「最近有活動」的互動式 session 代收。純函式，方便測試。
// roster：已過濾（interactive、cli、排除收發室）的名單；activityOf(agent) 回傳最後活動時間（毫秒，未知回 0）。
export function pickFallbackAgent(roster, activityOf = () => 0) {
  let best = null, bestT = -1
  for (const a of roster) {
    if (!a?.name) continue
    const t = Math.max(Number(activityOf(a)) || 0, Number(a.startedAt) || 0)
    if (t > bestT) { best = a; bestT = t }
  }
  return best
}

export const fallbackNote = (wanted, actual) =>
  `[收發室] 這封信原本要給「${wanted}」，但它不在線，請你（${actual}）代收並轉告／處理。`
