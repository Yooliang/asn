// 截圖覆蓋視窗（每個螢幕一扇）：顯示 Rust 端凍結的那一塊畫面，拖曳框選；換算在 lib/shot.mjs。
import { dragRect, physicalToCss, selectionToPhysical, sizeLabelPos, validSelection } from './lib/shot.mjs'
import { invoke } from './lib/tauri.mjs'

const index = Number(new URLSearchParams(location.search).get('m') ?? 0)
const cv = document.getElementById('cv'), hint = document.getElementById('hint')
const g = cv.getContext('2d')
let bmp = null, start = null, sel = null, done = false

const view = () => ({ w: window.innerWidth, h: window.innerHeight })
const cancel = () => { if (done) return; done = true; void invoke('shot_cancel').catch(() => {}) }

function draw() {
  g.drawImage(bmp, 0, 0)
  g.fillStyle = 'rgba(0,0,0,.45)'
  g.fillRect(0, 0, cv.width, cv.height)
  if (!sel) return
  const phys = selectionToPhysical(sel, view(), { w: bmp.width, h: bmp.height })
  if (!phys) return
  g.drawImage(bmp, phys.x, phys.y, phys.w, phys.h, phys.x, phys.y, phys.w, phys.h)   // 選取範圍恢復原亮度
  const k = bmp.width / view().w
  g.lineWidth = Math.max(1, Math.round(k)); g.strokeStyle = '#1e88e5'
  g.strokeRect(phys.x + 0.5, phys.y + 0.5, phys.w - 1, phys.h - 1)
  const pos = sizeLabelPos(physicalToCss(phys, view(), { w: bmp.width, h: bmp.height }), view())
  const text = `${phys.w} × ${phys.h}`
  g.font = `${Math.round(13 * k)}px "Segoe UI","Microsoft JhengHei",sans-serif`
  const tw = g.measureText(text).width + 12 * k
  g.fillStyle = 'rgba(10,24,40,.85)'; g.fillRect(pos.x * k, pos.y * k, tw, 22 * k)
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, pos.x * k + 6 * k, pos.y * k + 11 * k)
}

async function boot() {
  const bytes = await invoke('shot_image', { index })
  bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  cv.width = bmp.width; cv.height = bmp.height
  draw()
  await invoke('shot_ready')
}

cv.addEventListener('pointerdown', e => {
  if (e.button !== 0 || done) return
  hint.style.display = 'none'
  cv.setPointerCapture(e.pointerId)
  start = { x: e.clientX, y: e.clientY }; sel = { x: e.clientX, y: e.clientY, w: 0, h: 0 }
  draw()
})
cv.addEventListener('pointermove', e => {
  if (!document.hasFocus()) void invoke('shot_focus').catch(() => {})   // 游標移到這個螢幕就把鍵盤焦點帶過來，Esc 才有用
  if (!start) return
  sel = dragRect(start, { x: e.clientX, y: e.clientY }, view()); draw()
})
cv.addEventListener('pointerup', async e => {
  if (e.button !== 0 || !start || done) return
  const r = dragRect(start, { x: e.clientX, y: e.clientY }, view())
  start = null
  if (!validSelection(r)) { sel = null; draw(); return }   // 只是點一下：重來
  const p = selectionToPhysical(r, view(), { w: bmp.width, h: bmp.height })
  done = true
  try { await invoke('shot_pick', { index, x: p.x, y: p.y, w: p.w, h: p.h }) } catch { done = false; sel = null; draw() }
})
cv.addEventListener('contextmenu', e => { e.preventDefault(); cancel() })
window.addEventListener('keydown', e => { if (e.key === 'Escape') cancel() })
boot().catch(() => cancel())
