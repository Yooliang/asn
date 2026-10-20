// 截圖標註：操作清單（堆疊／復原／重做／清除）、整理規則、幾何、輸出尺寸、畫圖（記錄用假 ctx）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLORS, TEXT_MAX, arrowHead, createMarkup, drawOp, exportSize, fitView, mosaicCell, normalizeOp, renderAll, strokeScale, strokeWidth, textSize, toImagePoint } from '../ui/lib/markup.mjs'

const rect = (x = 0) => ({ type: 'rect', color: '#e53935', width: 4, x, y: 0, w: 50, h: 40 })

test('復原／重做：後進先出，新操作會清掉重做堆疊', () => {
  const m = createMarkup()
  assert.equal(m.canUndo, false); assert.equal(m.canRedo, false)
  assert.equal(m.undo(), false); assert.equal(m.redo(), false)
  m.commit(rect(1)); m.commit(rect(2)); m.commit(rect(3))
  assert.deepEqual(m.visible().map(o => o.x), [1, 2, 3])
  m.undo(); m.undo()
  assert.deepEqual(m.visible().map(o => o.x), [1])
  assert.equal(m.canRedo, true)
  m.redo()
  assert.deepEqual(m.visible().map(o => o.x), [1, 2])
  m.commit(rect(9))
  assert.equal(m.canRedo, false, '畫了新的就不能重做舊的')
  assert.deepEqual(m.visible().map(o => o.x), [1, 2, 9])
})

test('清除：只清畫面上的標註，而且能復原；沒東西時不留記號', () => {
  const m = createMarkup()
  assert.equal(m.clear(), false)
  assert.equal(m.canUndo, false, '空清單清除不產生可復原的動作')
  m.commit(rect(1)); m.commit(rect(2))
  assert.equal(m.clear(), true)
  assert.equal(m.hasMarks, false); assert.deepEqual(m.visible(), [])
  m.commit(rect(5))
  assert.deepEqual(m.visible().map(o => o.x), [5], '清除之後新畫的看得到')
  m.undo()
  assert.deepEqual(m.visible(), [])
  m.undo()   // 復原清除
  assert.deepEqual(m.visible().map(o => o.x), [1, 2])
  m.redo()
  assert.equal(m.hasMarks, false)
  assert.equal(m.clear(), false, '已經是空的')
})

test('整理規則：太小、空白、壞值不入清單', () => {
  const m = createMarkup()
  assert.equal(m.commit({ type: 'rect', x: 0, y: 0, w: 2, h: 90, width: 4, color: '#e53935' }), false)
  assert.equal(m.commit({ type: 'arrow', x1: 0, y1: 0, x2: 3, y2: 3 }), false)
  assert.equal(m.commit({ type: 'text', x: 0, y: 0, text: '   ', size: 20 }), false)
  assert.equal(m.commit({ type: 'mosaic', x: 0, y: 0, w: 2, h: 50 }), false)
  assert.equal(m.commit({ type: 'pen', pts: [] }), false)
  assert.equal(m.commit({ type: 'pen', pts: [[NaN, 1]] }), false)
  assert.equal(m.commit({ type: 'zzz' }), false)
  assert.equal(m.commit(null), false)
  assert.equal(m.canUndo, false)
})

test('整理規則：矩形可反向拖、單點的筆畫變圓點、顏色只收 #rrggbb、文字截長', () => {
  assert.deepEqual(normalizeOp({ type: 'rect', x: 100, y: 80, w: -60, h: -30, width: 4, color: '#1E88E5' }), { type: 'rect', color: '#1e88e5', width: 4, x: 40, y: 50, w: 60, h: 30 })
  assert.deepEqual(normalizeOp({ type: 'pen', color: '#000000', width: 5, pts: [[3, 4]] }).pts, [[3, 4], [3, 4]])
  assert.equal(normalizeOp({ type: 'rect', x: 0, y: 0, w: 9, h: 9, color: 'red; background:url(x)' }).color, COLORS[0])
  assert.equal(normalizeOp({ type: 'rect', x: 0, y: 0, w: 9, h: 9, color: 5 }).color, COLORS[0])
  assert.equal(normalizeOp({ type: 'text', x: 0, y: 0, size: 20, text: 'a'.repeat(TEXT_MAX + 50) }).text.length, TEXT_MAX)
  assert.equal(normalizeOp({ type: 'pen', width: 99999, pts: [[0, 0], [5, 5]] }).width, 200)
})

test('粗細隨圖片大小放大：小圖不縮、4K 圖的線比 1080p 粗', () => {
  assert.equal(strokeScale(800), 1)
  assert.ok(strokeScale(3840) > strokeScale(1920))
  assert.ok(strokeWidth(1, 1200) < strokeWidth(2, 1200) && strokeWidth(2, 1200) < strokeWidth(3, 1200))
  assert.ok(strokeWidth(2, 1200, 'marker') > strokeWidth(2, 1200, 'pen'))
  assert.ok(textSize(3, 1200) > textSize(1, 1200))
  assert.ok(mosaicCell(1920) >= 8 && mosaicCell(3840) > mosaicCell(1920))
})

test('輸出尺寸：不放大；長邊超過上限等比縮小；一定是整數且至少 1', () => {
  assert.deepEqual(exportSize(800, 600), { w: 800, h: 600 })
  assert.deepEqual(exportSize(8192, 4096), { w: 4096, h: 2048 })
  assert.deepEqual(exportSize(3000, 9000, 3000), { w: 1000, h: 3000 })
  assert.deepEqual(exportSize(0, NaN), { w: 1, h: 1 })
  assert.deepEqual(exportSize(10, 5000, 100), { w: 1, h: 100 })
  const r = exportSize(7681, 4321)
  assert.ok(Number.isInteger(r.w) && Number.isInteger(r.h) && Math.max(r.w, r.h) === 4096)
})

test('畫面適配與座標換算：縮小顯示時，游標位置換回圖片像素', () => {
  const v = fitView(2000, 1000, 800, 600)
  assert.deepEqual(v, { w: 800, h: 400, scale: 0.4 })
  assert.equal(fitView(300, 200, 800, 600).scale, 1, '小圖不放大')
  assert.deepEqual(fitView(0, 10, 100, 100), { w: 0, h: 0, scale: 1 })
  assert.deepEqual(toImagePoint(400, 200, v, 2000, 1000), { x: 1000, y: 500 })
  assert.deepEqual(toImagePoint(-20, 9999, v, 2000, 1000), { x: 0, y: 1000 }, '夾在圖片內')
  assert.deepEqual(toImagePoint(5, 5, { w: 0, h: 0 }, 100, 100), { x: 0, y: 0 })
})

test('箭頭頭部：尖端在終點、兩翼對稱且在線的後方', () => {
  const [tip, l, r] = arrowHead(0, 0, 100, 0, 4)
  assert.deepEqual(tip, [100, 0])
  assert.ok(l[0] < 100 && r[0] < 100)
  assert.ok(Math.abs(l[1] + r[1]) < 1e-9 && l[1] !== r[1], '上下對稱')
  assert.ok(Math.hypot(l[0] - 100, l[1]) >= 14 - 1e-9, '頭長至少 14')
  const [, l2, r2] = arrowHead(0, 0, 0, 100, 4)   // 往下畫
  assert.ok(l2[1] < 100 && r2[1] < 100 && Math.abs(l2[0] + r2[0]) < 1e-9)
})

// ---- 畫圖：用記錄用的假 ctx，驗證畫了什麼、狀態有存有還原 ----
function fakeCtx() {
  const calls = [], depth = { n: 0 }
  const ctx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (...a) => { calls.push([k, ...a]); if (k === 'save') depth.n++; if (k === 'restore') depth.n-- }),
    set: (t, k, v) => { t[k] = v; calls.push(['set', k, v]); return true },
  })
  return { ctx, calls, depth }
}
const mkCanvas = () => { const f = fakeCtx(); return { getContext: () => f.ctx, calls: f.calls } }

test('畫圖：每種操作都 save／restore 成對，螢光筆半透明、筆畫用圓順的中點曲線', () => {
  const base = { id: 'base' }
  for (const op of [
    { type: 'pen', color: '#e53935', width: 6, pts: [[0, 0], [10, 10], [20, 5], [30, 30]] },
    { type: 'marker', color: '#fdd835', width: 30, pts: [[0, 0], [50, 0]] },
    rect(), { type: 'arrow', color: '#1e88e5', width: 6, x1: 0, y1: 0, x2: 80, y2: 40 },
    { type: 'text', color: '#ffffff', size: 28, x: 5, y: 5, text: '第一行\n第二行' },
    { type: 'mosaic', x: 10, y: 10, w: 100, h: 60, cell: 12 },
  ]) {
    const { ctx, calls, depth } = fakeCtx()
    drawOp(ctx, op, base, mkCanvas)
    assert.equal(depth.n, 0, `${op.type} 的 save／restore 要成對`)
    assert.ok(calls.length > 2, op.type)
    if (op.type === 'marker') assert.ok(calls.some(c => c[0] === 'set' && c[1] === 'globalAlpha' && c[2] < 1))
    if (op.type === 'pen') assert.ok(calls.some(c => c[0] === 'quadraticCurveTo'))
    if (op.type === 'text') assert.equal(calls.filter(c => c[0] === 'fillText').length, 2, '兩行各畫一次')
    if (op.type === 'mosaic') {
      assert.ok(calls.some(c => c[0] === 'set' && c[1] === 'imageSmoothingEnabled' && c[2] === false), '放大時關閉平滑才有方塊感')
      const big = calls.find(c => c[0] === 'drawImage')
      assert.deepEqual(big.slice(2), [0, 0, 9, 5, 10, 10, 108, 60], '縮成 9×5 小格再放大')
    }
  }
})

test('畫圖：renderAll 先畫底圖，clear 記號之前的操作不畫', () => {
  const { ctx, calls } = fakeCtx()
  renderAll(ctx, { id: 'b' }, [rect(1), { type: 'clear' }, rect(7)], mkCanvas)
  assert.equal(calls[0][0], 'drawImage')
  const rects = calls.filter(c => c[0] === 'strokeRect')
  assert.equal(rects.length, 1)
  assert.equal(rects[0][1], 7)
})
