// 門鈴帶種類之後，哪一聲要重抓群組清單（#2161 B1，電腦版與手機版共用）。
//  mail：私信不會動到群組，跳過。
//  roster：名單（忙碌／閒置）變了。群組成員的在線標示來自群組清單，所以不能整個跳過：
//          距上次重抓不到 30 秒就併成一次，期滿補抓（不能丟，否則最後一次變化要等定時重抓才看得到）。
//  其他（沒帶種類的舊門鈴、不認得的種類）：照舊馬上重抓。群組發言、邀請、確認卡片敲的就是沒帶種類的門鈴。
export const ROSTER_BELL_GAP_MS = 30_000

export function createRoomBellGate({ refresh, counter = null, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = t => clearTimeout(t) }) {
  let lastAt = -Infinity
  let pending = null
  const cancel = () => { if (pending !== null) { clearTimer(pending); pending = null } }
  return {
    // 每次重抓群組清單開始時呼叫（不管什麼原因）：這次重抓已涵蓋還在等的名單門鈴
    noteRefresh() { lastAt = now(); cancel() },
    // payload＝relay-bell 事件的內容 {kind}；舊門鈴 kind 是 null
    ring(payload) {
      const kind = typeof payload?.kind === 'string' ? payload.kind : ''
      counter?.hit(`bell:${kind || 'none'}`)
      if (kind === 'mail') return
      if (kind === 'roster') {
        const wait = Math.min(lastAt + ROSTER_BELL_GAP_MS - now(), ROSTER_BELL_GAP_MS)   // 時鐘往回跳也最多等 30 秒
        if (wait > 0) {
          if (pending === null) pending = setTimer(() => { pending = null; refresh() }, wait)
          return
        }
      }
      refresh()
    },
  }
}
