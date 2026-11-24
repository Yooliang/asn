// 群組輪詢的本機計數（#2161 F3 第一步）：只記「哪一條條件打了後台幾次」，不改任何行為。
// 超過 everyMs 後在下一次 hit 時用 sink 輸出一行並歸零；roomId 只留前 8 碼，不輸出任何訊息內容。
// sink 預設 console.info，開頭是 [ASN]，主視窗會被 ui-log 寫進 ui.log。
export function createRoomPollCounter({ now = () => Date.now(), sink = (...a) => console.info(...a), everyMs = 60_000 } = {}) {
  let total = {}
  let rooms = {}
  let since = now()
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1 }
  const nonZero = () => Object.keys(total).length > 0

  function snapshot() {
    const 各群組 = {}
    for (const [id, c] of Object.entries(rooms)) 各群組[id] = { ...c }
    return { 秒數: Math.round((now() - since) / 1000), 總計: { ...total }, 各群組 }
  }
  function reset() { total = {}; rooms = {}; since = now() }
  function flush() {
    if (!nonZero()) { since = now(); return false }
    const snap = snapshot()
    try { globalThis.__roomPollCounts = snap } catch { /* 沒有 globalThis 就略過 */ }
    reset()
    try { sink('[ASN] 群組輪詢計數', JSON.stringify(snap)) } catch { /* 輸出失敗不影響群組本身 */ }
    return true
  }
  function hit(key, roomId) {
    bump(total, key)
    if (roomId) {
      const id = String(roomId).slice(0, 8)
      bump(rooms[id] ??= {}, key)
    }
    if (now() - since >= everyMs) flush()
  }
  return { hit, snapshot, flush, reset }
}
