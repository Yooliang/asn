// 右鍵選單與二級選單的定位（純函式）。選單一律放在 overflow 容器外面用 position:fixed 定位（見 list.html 分頁右鍵選單的註解），
// 位置由這裡算：右側空間不夠就往左彈、下方不夠就往上對齊，永遠不超出視窗。
const MARGIN = 4

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))

/**
 * 主選單：游標點在 (x, y)，選單大小 size {w, h}，視窗 view {w, h}。
 * 右邊放不下就貼著游標往左展開；下方放不下就往上展開；最後夾在視窗內。
 */
export function placeMenu({ x, y }, size, view, margin = MARGIN) {
  let left = x
  let top = y
  if (left + size.w > view.w - margin) left = x - size.w
  if (top + size.h > view.h - margin) top = y - size.h
  return { x: clamp(left, margin, Math.max(margin, view.w - size.w - margin)), y: clamp(top, margin, Math.max(margin, view.h - size.h - margin)) }
}

/**
 * 二級選單：anchor 是父選單那一項的矩形 {left, top, right, bottom}，size 是子選單大小。
 * 預設貼在那一項的右側、頂端對齊；右側不夠就改貼左側（flipX）；下方不夠就改成底端對齊那一項（flipY）；最後夾在視窗內。
 */
export function placeSubmenu(anchor, size, view, margin = MARGIN) {
  let x = anchor.right
  let flipX = false
  if (x + size.w > view.w - margin) { x = anchor.left - size.w; flipX = true }
  let y = anchor.top
  let flipY = false
  if (y + size.h > view.h - margin) { y = anchor.bottom - size.h; flipY = true }
  return {
    x: clamp(x, margin, Math.max(margin, view.w - size.w - margin)),
    y: clamp(y, margin, Math.max(margin, view.h - size.h - margin)),
    flipX, flipY,
  }
}

/**
 * 二級選單的開關狀態（滑過、點一下、鍵盤右鍵都會開；移開、選完、Esc 收起）。
 * 事件：hover（滑過）、click（點一下，切換）、right（鍵盤右鍵）、leave（移開）、pick（選了一項）、escape（Esc）。
 * 回 { open, consumed }：consumed＝這個事件已經處理，呼叫端不要再往上關主選單（Esc 先收子選單，再按一次才關主選單）。
 * enabled＝false（切不了）時所有開的事件都沒有作用。
 */
export function submenuNext(state, ev, enabled = true) {
  const open = Boolean(state?.open)
  switch (ev) {
    case 'hover': case 'right': return { open: enabled ? true : open, consumed: false }
    case 'click': return { open: enabled ? !open : open, consumed: false }
    case 'leave': case 'pick': return { open: false, consumed: false }
    case 'escape': return open ? { open: false, consumed: true } : { open, consumed: false }
    default: return { open, consumed: false }
  }
}
