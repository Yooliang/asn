// 分辨「點一下」和「捲動／拖拉／長按」（#1539：手機設備頁點一列才展開它的按鈕，捲動時不能誤觸）。
// 用法：在那一列掛 pointerdown／pointermove／pointercancel，click 時問 isTap(e)：
//   - 手指（或滑鼠）從按下到放開移動超過 moveTol px＝捲動或拖拉，不算點
//   - 瀏覽器接手去捲動時會送 pointercancel，之後的 click 不算點
//   - 按住超過 longMs 毫秒＝長按（例如指紋圖示的長按說明），不算點
//   - 沒有 pointerdown 就來的 click（鍵盤 Enter／空白鍵，detail 是 0）一律算點
// 不碰 DOM 以外的東西，時間由 now() 給（測試可注入）。
export const TAP_MOVE_TOL = 8
export const TAP_LONG_MS = 500

export function createTapGuard({ moveTol = TAP_MOVE_TOL, longMs = TAP_LONG_MS, now = () => Date.now() } = {}) {
  let start = null   // { x, y, t, id, moved, cancelled }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  return {
    down(e) { start = { x: e.clientX, y: e.clientY, t: now(), id: e.pointerId, moved: false, cancelled: false } },
    move(e) { if (start && e.pointerId === start.id && dist(start, { x: e.clientX, y: e.clientY }) > moveTol) start.moved = true },
    cancel() { if (start) start.cancelled = true },
    isTap(e) {
      if (!start || (e && e.detail === 0)) { start = null; return true }   // 鍵盤
      const s = start
      start = null
      if (s.moved || s.cancelled) return false
      if (e && Number.isFinite(e.clientX) && dist(s, { x: e.clientX, y: e.clientY }) > moveTol) return false
      return now() - s.t <= longMs
    },
  }
}

// 點同一列＝收起；點別列＝換成那一列
export const toggleSelected = (cur, key) => (cur === key ? '' : key)
