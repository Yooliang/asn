// 截圖框選的純邏輯（不碰 DOM、不碰 Tauri，node 與瀏覽器都能跑，有單元測試）。
// 流程：Rust 端先把整個桌面凍結成一張圖，再對每個螢幕開一扇置頂全螢幕視窗，視窗裡顯示該螢幕那一塊；
// 使用者在視窗裡拖曳框選。這裡負責把「視窗裡的 CSS 座標」換成「該螢幕圖片的實體像素」——
// 不信任 devicePixelRatio，直接用「視窗實際大小 ÷ 圖片大小」的比例，所以高 DPI、縮放 125%／150%、
// 視窗被系統微調過大小都照樣對得準。

export const MIN_SEL = 6   // 框選小於這個（CSS 像素）視為誤點，不算選取

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = v => (Number.isFinite(v) ? v : 0)

// 兩個角（任意順序）→ 正規化矩形 {x, y, w, h}
export function normRect(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

// 拖曳時把游標限制在視窗內（只能在同一個螢幕上框選）
export function dragRect(start, cur, view) {
  const p = q => ({ x: clamp(num(q.x), 0, view.w), y: clamp(num(q.y), 0, view.h) })
  return normRect(p(start), p(cur))
}

export const validSelection = r => !!r && r.w >= MIN_SEL && r.h >= MIN_SEL

// 視窗裡的 CSS 矩形 → 圖片實體像素矩形（整數、夾在圖片內、至少 1×1）；view＝視窗內部大小，image＝圖片大小
export function selectionToPhysical(css, view, image) {
  if (!(view.w > 0 && view.h > 0 && image.w > 0 && image.h > 0)) return null
  const sx = image.w / view.w, sy = image.h / view.h
  const x0 = clamp(Math.round(css.x * sx), 0, image.w - 1), y0 = clamp(Math.round(css.y * sy), 0, image.h - 1)
  const x1 = clamp(Math.round((css.x + css.w) * sx), x0 + 1, image.w), y1 = clamp(Math.round((css.y + css.h) * sy), y0 + 1, image.h)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// 反向：圖片實體像素矩形 → 視窗 CSS 矩形（畫選取框用）
export function physicalToCss(r, view, image) {
  const sx = view.w / image.w, sy = view.h / image.h
  return { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy }
}

// 多螢幕：各螢幕的實體座標（虛擬桌面座標，可為負）→ 外框；Rust 端用同樣的規則把整個桌面凍成一張圖
export function virtualBounds(mons) {
  if (!mons.length) return null
  const x0 = Math.min(...mons.map(m => m.x)), y0 = Math.min(...mons.map(m => m.y))
  const x1 = Math.max(...mons.map(m => m.x + m.w)), y1 = Math.max(...mons.map(m => m.y + m.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// 某個螢幕在「整個桌面那張圖」裡的位置
export function monitorInFrame(mon, bounds) {
  return { x: mon.x - bounds.x, y: mon.y - bounds.y, w: mon.w, h: mon.h }
}

// 螢幕上的一點（虛擬桌面座標）落在哪個螢幕；都不在就 -1
export function monitorAt(mons, x, y) {
  return mons.findIndex(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h)
}

// 選取框旁邊的尺寸標籤位置：預設在框上方；上方放不下改放框內左上，避免被切掉
export function sizeLabelPos(sel, view, labelH = 22) {
  const y = sel.y - labelH - 4
  return { x: clamp(sel.x, 0, Math.max(0, view.w - 80)), y: y >= 0 ? y : sel.y + 4 }
}

// 存檔名：截圖 YYYYMMDD-HHmmss.png（本地時間；檔名規則會再過一次 cleanPhotoName）
export function shotFileName(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0')
  return `截圖 ${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}
