// 看大圖縮放（#1498）：手機雙指捏合、雙擊放大；電腦滾輪縮放、拖曳平移。關掉看圖就回到原本大小。
// 純計算（zoomAt、clampPan、wheelScale、tapZoom）在 node 測試；createZoom 把它們接到 Pointer Events（觸控與滑鼠同一條路）。
// 座標都以「圖片沒縮放時的中心」為原點：畫面上的點 = 中心 + 平移 + 倍率 × 圖上的點。

export const ZOOM_MIN = 1
export const ZOOM_MAX = 8
export const ZOOM_TAP = 2.5          // 雙擊放大到這個倍率；已經放大時雙擊回到 1
const TAP_MS = 300                   // 兩次點擊算雙擊的間隔
const TAP_PX = 30                    // 兩次點擊的距離上限
const WHEEL_K = 0.0015               // 滾輪一格（約 100）≈ 1.16 倍

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// 以畫面上的點 (px, py)（相對圖片中心）為定點，把倍率改成 s2：那一點底下的內容不動
export function zoomAt(z, s2, px, py) {
  const s = clamp(s2, ZOOM_MIN, ZOOM_MAX)
  const k = s / z.s
  return { s, x: px - k * (px - z.x), y: py - k * (py - z.y) }
}

// 平移的範圍：圖片放大後超出外框的部分才能拖；沒放大就回到正中間。w、h＝圖片沒縮放時的大小，W、H＝外框大小
export function clampPan(z, w, h, W, H) {
  if (z.s <= ZOOM_MIN) return { s: ZOOM_MIN, x: 0, y: 0 }
  const mx = Math.max(0, (w * z.s - W) / 2)
  const my = Math.max(0, (h * z.s - H) / 2)
  return { s: z.s, x: clamp(z.x, -mx, mx), y: clamp(z.y, -my, my) }
}

// 滾輪：往前（deltaY < 0）放大、往後縮小；deltaMode 1＝以行計（Firefox），換成約略的像素
export function wheelScale(s, deltaY, deltaMode = 0) {
  const d = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY
  return clamp(s * Math.exp(-d * WHEEL_K), ZOOM_MIN, ZOOM_MAX)
}

// 雙擊：沒放大就以點的位置放大到 ZOOM_TAP；已經放大就回到原本大小
export function tapZoom(z, px, py) {
  return z.s > ZOOM_MIN + 0.01 ? { s: ZOOM_MIN, x: 0, y: 0 } : zoomAt(z, ZOOM_TAP, px, py)
}

export const zoomStyle = z => (z.s === 1 && z.x === 0 && z.y === 0 ? '' : `transform:translate(${z.x}px,${z.y}px) scale(${z.s})`)

// 把縮放接到圖片元素上。state 是 Vue 的 reactive（{ s, x, y }），畫面用 zoomStyle(state) 畫。
// 回傳的處理函式綁在 <img> 上：@wheel、@pointerdown／move／up／cancel、@dblclick（滑鼠）。
export function createZoom(state, now = () => Date.now()) {
  const pts = new Map()               // 按著的指頭（或滑鼠）：pointerId → { x, y }
  let pinch = null                    // 雙指開始時：{ d, s, mx, my, x, y }
  let lastTap = null                  // 上一次觸控點擊：{ t, x, y }
  let moved = false
  let touchAt = -1e9                  // 最後一次手指按下的時間：瀏覽器在觸控雙擊後也會補送 dblclick，那個要忽略

  const set = z => { state.s = z.s; state.x = z.x; state.y = z.y }
  const reset = () => { pts.clear(); pinch = null; lastTap = null; set({ s: 1, x: 0, y: 0 }) }
  // 圖片沒縮放時的中心與大小（getBoundingClientRect 量到的是縮放後的框：中心 = 原中心 + 平移，寬 = 原寬 × 倍率）
  function geom(img) {
    const r = img.getBoundingClientRect()
    const o = (img.parentElement || img).getBoundingClientRect()
    return { cx: r.left + r.width / 2 - state.x, cy: r.top + r.height / 2 - state.y, w: r.width / state.s, h: r.height / state.s, W: o.width, H: o.height }
  }
  const apply = (img, z) => { const g = geom(img); set(clampPan(z, g.w, g.h, g.W, g.H)) }
  const rel = (img, x, y) => { const g = geom(img); return [x - g.cx, y - g.cy] }
  const cur = () => ({ s: state.s, x: state.x, y: state.y })
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  function onWheel(e) {
    e.preventDefault()
    const img = e.currentTarget
    const [px, py] = rel(img, e.clientX, e.clientY)
    apply(img, zoomAt(cur(), wheelScale(state.s, e.deltaY, e.deltaMode), px, py))
  }
  function onDblClick(e) {
    if (e.pointerType === 'touch' || now() - touchAt < 1000) return   // 觸控的雙擊由 pointerup 自己判斷，補送的 dblclick 不算
    const img = e.currentTarget
    const [px, py] = rel(img, e.clientX, e.clientY)
    apply(img, tapZoom(cur(), px, py))
  }
  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.pointerType === 'touch') touchAt = now()
    e.preventDefault()
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* 不支援就算了 */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved = false
    if (pts.size === 2) {
      const [a, b] = [...pts.values()]
      pinch = { d: Math.max(1, dist(a, b)), s: state.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, x: state.x, y: state.y }
    }
  }
  function onPointerMove(e) {
    const p = pts.get(e.pointerId)
    if (!p) return
    const img = e.currentTarget
    const dx = e.clientX - p.x, dy = e.clientY - p.y
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()]
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      // 先照雙指開始時的狀態，以開始的中點縮放，再跟著中點移動
      const g = geom(img)
      const z = zoomAt({ s: pinch.s, x: pinch.x, y: pinch.y }, pinch.s * dist(a, b) / pinch.d, pinch.mx - g.cx, pinch.my - g.cy)
      apply(img, { s: z.s, x: z.x + (mx - pinch.mx), y: z.y + (my - pinch.my) })
    } else if (pts.size === 1 && state.s > ZOOM_MIN) {
      apply(img, { s: state.s, x: state.x + dx, y: state.y + dy })
    }
  }
  function onPointerUp(e) {
    if (!pts.has(e.pointerId)) return
    pts.delete(e.pointerId)
    if (pts.size < 2) pinch = null
    if (e.type !== 'pointerup' || e.pointerType !== 'touch' || moved || pts.size) return
    // 觸控雙擊：兩次點擊夠近、夠快
    const t = now()
    if (lastTap && t - lastTap.t <= TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= TAP_PX) {
      lastTap = null
      const img = e.currentTarget
      const [px, py] = rel(img, e.clientX, e.clientY)
      apply(img, tapZoom(cur(), px, py))
    } else {
      lastTap = { t, x: e.clientX, y: e.clientY }
    }
  }
  return { reset, onWheel, onDblClick, onPointerDown, onPointerMove, onPointerUp }
}
