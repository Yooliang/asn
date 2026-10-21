// 截圖標註的純邏輯：標註清單（堆疊、復原、重做、清除）、幾何（箭頭、座標換算）、尺寸，以及把清單畫到 2D context 的函式。
// 畫圖函式只用到 ctx 的標準方法，測試用記錄用的假 ctx 驗證；瀏覽器端的元件在 annotator.mjs。
// 所有座標都是「圖片像素」；畫面縮放只在 fitView／toImagePoint 處理。

export const TOOLS = ['pen', 'marker', 'rect', 'arrow', 'text', 'mosaic']
export const TOOL_LABEL = { pen: '畫筆', marker: '螢光筆', rect: '矩形', arrow: '箭頭', text: '文字', mosaic: '馬賽克' }
export const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#000000', '#ffffff']
export const COLOR_LABEL = { '#e53935': '紅', '#fb8c00': '橙', '#fdd835': '黃', '#43a047': '綠', '#1e88e5': '藍', '#8e24aa': '紫', '#000000': '黑', '#ffffff': '白' }
export const SIZES = [1, 2, 3]   // 細／中／粗
export const SIZE_LABEL = { 1: '細', 2: '中', 3: '粗' }
export const TEXT_MAX = 200
export const EXPORT_MAX_EDGE = 4096   // 輸出前長邊上限（超過先縮小，避免畫布過大；之後送出還會再縮到 2048）
export const MARKER_ALPHA = 0.38

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const fin = v => (Number.isFinite(v) ? v : 0)

// 畫面上 1 單位粗細對應的圖片像素：大圖（4K）的線不會細到看不見
export const strokeScale = imgW => Math.max(1, fin(imgW) / 1200)
export function strokeWidth(level, imgW, tool = 'pen') {
  const base = { 1: 3, 2: 6, 3: 10 }[level] ?? 6
  return Math.round(base * (tool === 'marker' ? 3 : 1) * strokeScale(imgW))
}
export const textSize = (level, imgW) => Math.round(({ 1: 18, 2: 28, 3: 44 }[level] ?? 28) * strokeScale(imgW))
export const mosaicCell = imgW => Math.max(8, Math.round(fin(imgW) / 110))

const safeColor = c => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : COLORS[0])

// 長邊超過上限就等比縮小，不放大；回整數
export function exportSize(w, h, max = EXPORT_MAX_EDGE) {
  w = Math.max(1, Math.round(fin(w))); h = Math.max(1, Math.round(fin(h)))
  const long = Math.max(w, h)
  if (long <= max) return { w, h }
  const k = max / long
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

// 圖片放進可用區域（只縮小不放大）的顯示大小與比例
export function fitView(imgW, imgH, boxW, boxH) {
  if (!(imgW > 0 && imgH > 0 && boxW > 0 && boxH > 0)) return { w: 0, h: 0, scale: 1 }
  const scale = Math.min(1, boxW / imgW, boxH / imgH)
  return { w: Math.max(1, Math.round(imgW * scale)), h: Math.max(1, Math.round(imgH * scale)), scale }
}

// 游標位置（相對畫布元素左上角的 CSS 像素）→ 圖片像素，夾在圖片內
export function toImagePoint(px, py, view, imgW, imgH) {
  if (!(view.w > 0 && view.h > 0)) return { x: 0, y: 0 }
  return { x: clamp((px / view.w) * imgW, 0, imgW), y: clamp((py / view.h) * imgH, 0, imgH) }
}

export function rectOf(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

// 箭頭頭部三個點（尖端、左翼、右翼）；頭長隨線粗，至少 14 像素
export function arrowHead(x1, y1, x2, y2, width) {
  const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.max(14, width * 4), spread = Math.PI / 7
  const wing = s => [x2 - len * Math.cos(ang + s), y2 - len * Math.sin(ang + s)]
  return [[x2, y2], wing(spread), wing(-spread)]
}

// 把使用者畫出來的操作整理成可存入清單的樣子；太小、空的、壞的回 null（不入清單）
export function normalizeOp(op) {
  if (!op || typeof op !== 'object') return null
  const color = safeColor(op.color)
  switch (op.type) {
    case 'pen': case 'marker': {
      const pts = (Array.isArray(op.pts) ? op.pts : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]])
      if (!pts.length) return null
      if (pts.length === 1) pts.push([pts[0][0], pts[0][1]])   // 點一下＝一個圓點
      return { type: op.type, color, width: clamp(fin(op.width) || 6, 1, 200), pts }
    }
    case 'rect': {
      const r = rectOf(fin(op.x), fin(op.y), fin(op.x) + fin(op.w), fin(op.y) + fin(op.h))
      return r.w < 3 || r.h < 3 ? null : { type: 'rect', color, width: clamp(fin(op.width) || 6, 1, 200), ...r }
    }
    case 'arrow': {
      const dx = fin(op.x2) - fin(op.x1), dy = fin(op.y2) - fin(op.y1)
      return Math.hypot(dx, dy) < 6 ? null : { type: 'arrow', color, width: clamp(fin(op.width) || 6, 1, 200), x1: fin(op.x1), y1: fin(op.y1), x2: fin(op.x2), y2: fin(op.y2) }
    }
    case 'text': {
      const text = String(op.text ?? '').replace(/[\r\t]/g, ' ').slice(0, TEXT_MAX)
      return text.trim() ? { type: 'text', color, size: clamp(fin(op.size) || 28, 8, 400), x: fin(op.x), y: fin(op.y), text } : null
    }
    case 'mosaic': {
      const r = rectOf(fin(op.x), fin(op.y), fin(op.x) + fin(op.w), fin(op.y) + fin(op.h))
      return r.w < 4 || r.h < 4 ? null : { type: 'mosaic', cell: clamp(Math.round(fin(op.cell)) || 12, 2, 200), ...r }
    }
    default: return null
  }
}

// 標註清單：ops 是依序的操作；'clear' 是一個記號（它之前的都不畫），所以「清除」也能復原
export function createMarkup() {
  const ops = []
  let undone = []
  const lastClear = () => { for (let i = ops.length - 1; i >= 0; i--) if (ops[i].type === 'clear') return i; return -1 }
  const api = {
    commit(op) {
      const n = normalizeOp(op)
      if (!n) return false
      ops.push(n); undone = []
      return true
    },
    undo() { if (!ops.length) return false; undone.push(ops.pop()); return true },
    redo() { if (!undone.length) return false; ops.push(undone.pop()); return true },
    clear() { if (!api.visible().length) return false; ops.push({ type: 'clear' }); undone = []; return true },
    visible() { return ops.slice(lastClear() + 1) },
    get canUndo() { return ops.length > 0 },
    get canRedo() { return undone.length > 0 },
    get hasMarks() { return api.visible().length > 0 },
  }
  return api
}

// ---------- 畫圖（ctx 可以是 CanvasRenderingContext2D 或測試用的假物件） ----------
function strokePath(ctx, pts) {
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  if (pts.length === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return }
  for (let i = 1; i < pts.length - 1; i++) {   // 用中點的二次曲線讓筆跡圓順
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last[0], last[1])
}

// base：底圖（ImageBitmap／canvas）；makeCanvas(w,h)：馬賽克需要暫存畫布
export function drawOp(ctx, op, base, makeCanvas) {
  ctx.save()
  try {
    switch (op.type) {
      case 'pen': case 'marker':
        ctx.lineJoin = 'round'; ctx.lineCap = op.type === 'marker' ? 'butt' : 'round'
        ctx.strokeStyle = op.color; ctx.lineWidth = op.width
        ctx.globalAlpha = op.type === 'marker' ? MARKER_ALPHA : 1
        strokePath(ctx, op.pts); ctx.stroke()
        break
      case 'rect':
        ctx.strokeStyle = op.color; ctx.lineWidth = op.width; ctx.lineJoin = 'round'
        ctx.strokeRect(op.x, op.y, op.w, op.h)
        break
      case 'arrow': {
        ctx.strokeStyle = op.color; ctx.fillStyle = op.color; ctx.lineWidth = op.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        const [tip, l, r] = arrowHead(op.x1, op.y1, op.x2, op.y2, op.width)
        // 線只畫到頭部的底邊，免得粗線把尖端撐鈍
        const bx = (l[0] + r[0]) / 2, by = (l[1] + r[1]) / 2
        ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(bx, by); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(l[0], l[1]); ctx.lineTo(r[0], r[1]); ctx.closePath(); ctx.fill()
        break
      }
      case 'text': {
        ctx.fillStyle = op.color; ctx.font = `600 ${op.size}px "Microsoft JhengHei","PingFang TC","Noto Sans CJK TC",sans-serif`; ctx.textBaseline = 'top'
        // 淺色字加深色描邊、其餘加白色描邊，任何底色都看得清楚
        ctx.lineWidth = Math.max(2, op.size / 8); ctx.lineJoin = 'round'
        ctx.strokeStyle = op.color === '#ffffff' || op.color === '#fdd835' ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.85)'
        op.text.split('\n').forEach((line, i) => { ctx.strokeText(line, op.x, op.y + i * op.size * 1.25); ctx.fillText(line, op.x, op.y + i * op.size * 1.25) })
        break
      }
      case 'mosaic': {
        // 縮成小格再放大且不平滑＝馬賽克
        const sw = Math.max(1, Math.ceil(op.w / op.cell)), sh = Math.max(1, Math.ceil(op.h / op.cell))
        const tmp = makeCanvas(sw, sh), tg = tmp.getContext('2d')
        tg.imageSmoothingEnabled = true
        tg.drawImage(base, op.x, op.y, op.w, op.h, 0, 0, sw, sh)
        ctx.beginPath(); ctx.rect(op.x, op.y, op.w, op.h); ctx.clip()
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(tmp, 0, 0, sw, sh, op.x, op.y, sw * op.cell, sh * op.cell)
        break
      }
    }
  } finally { ctx.restore() }
}

// 底圖＋所有可見標註（clear 之前的不畫）
export function renderAll(ctx, base, ops, makeCanvas) {
  ctx.drawImage(base, 0, 0)
  let from = 0
  ops.forEach((o, i) => { if (o.type === 'clear') from = i + 1 })
  for (const o of ops.slice(from)) drawOp(ctx, o, base, makeCanvas)
}
