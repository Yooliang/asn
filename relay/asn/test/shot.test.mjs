// 截圖框選：座標換算、高 DPI、多螢幕、尺寸標籤、檔名。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_SEL, dragRect, monitorAt, monitorInFrame, normRect, physicalToCss, selectionToPhysical, shotFileName, sizeLabelPos, validSelection, virtualBounds } from '../ui/lib/shot.mjs'

test('正規化：任意方向拖曳都得到左上角＋寬高', () => {
  assert.deepEqual(normRect({ x: 50, y: 40 }, { x: 10, y: 90 }), { x: 10, y: 40, w: 40, h: 50 })
  assert.deepEqual(normRect({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5, w: 0, h: 0 })
})

test('拖曳限制在視窗內，壞值當 0', () => {
  const v = { w: 1000, h: 600 }
  assert.deepEqual(dragRect({ x: 900, y: 500 }, { x: 1400, y: 900 }, v), { x: 900, y: 500, w: 100, h: 100 })
  assert.deepEqual(dragRect({ x: 10, y: 10 }, { x: -50, y: -9 }, v), { x: 0, y: 0, w: 10, h: 10 })
  assert.deepEqual(dragRect({ x: NaN, y: 10 }, { x: 20, y: Infinity }, v), { x: 0, y: 0, w: 20, h: 10 })
})

test('太小的框選不算選取（誤點）', () => {
  assert.equal(validSelection({ x: 0, y: 0, w: MIN_SEL, h: MIN_SEL }), true)
  assert.equal(validSelection({ x: 0, y: 0, w: MIN_SEL - 1, h: 200 }), false)
  assert.equal(validSelection({ x: 0, y: 0, w: 200, h: 2 }), false)
  assert.equal(validSelection(null), false)
})

test('DPI：100%、125%、150%、200% 的視窗大小不同，換出的實體像素都對', () => {
  // 螢幕 3840×2160 實體像素；視窗 CSS 大小 = 實體 ÷ 縮放
  const image = { w: 3840, h: 2160 }
  for (const [scale, view] of [[1, { w: 3840, h: 2160 }], [1.25, { w: 3072, h: 1728 }], [1.5, { w: 2560, h: 1440 }], [2, { w: 1920, h: 1080 }]]) {
    const css = { x: 100 / scale, y: 50 / scale, w: 800 / scale, h: 400 / scale }
    assert.deepEqual(selectionToPhysical(css, view, image), { x: 100, y: 50, w: 800, h: 400 }, `縮放 ${scale}`)
  }
})

test('視窗被系統微調成非整數倍（例如少 1 像素）仍按比例換算，且不超出圖片', () => {
  const image = { w: 1920, h: 1080 }
  const view = { w: 1919, h: 1079 }
  const r = selectionToPhysical({ x: 0, y: 0, w: 1919, h: 1079 }, view, image)
  assert.deepEqual(r, { x: 0, y: 0, w: 1920, h: 1080 })
  const edge = selectionToPhysical({ x: 1900, y: 1000, w: 500, h: 500 }, view, image)
  assert.ok(edge.x + edge.w <= 1920 && edge.y + edge.h <= 1080 && edge.w >= 1 && edge.h >= 1)
})

test('換算結果一定是整數、至少 1×1；壞輸入回 null', () => {
  const r = selectionToPhysical({ x: 10.4, y: 10.6, w: 0.1, h: 0.1 }, { w: 1000, h: 1000 }, { w: 1500, h: 1500 })
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isInteger(r[k]), k)
  assert.ok(r.w >= 1 && r.h >= 1)
  assert.equal(selectionToPhysical({ x: 0, y: 0, w: 1, h: 1 }, { w: 0, h: 100 }, { w: 100, h: 100 }), null)
  assert.equal(selectionToPhysical({ x: 0, y: 0, w: 1, h: 1 }, { w: 100, h: 100 }, { w: 0, h: 0 }), null)
})

test('實體 ↔ CSS 互轉（畫選取框用）', () => {
  const view = { w: 1280, h: 720 }, image = { w: 1920, h: 1080 }
  const css = { x: 100, y: 60, w: 400, h: 200 }
  const phys = selectionToPhysical(css, view, image)
  assert.deepEqual(phys, { x: 150, y: 90, w: 600, h: 300 })
  assert.deepEqual(physicalToCss(phys, view, image), css)
})

test('多螢幕：外框、各螢幕在整張圖裡的位置（副螢幕在左邊時座標為負）', () => {
  const mons = [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: -1920, y: 200, w: 1920, h: 1080 }, { x: 2560, y: -300, w: 1920, h: 1080 }]
  const b = virtualBounds(mons)
  assert.deepEqual(b, { x: -1920, y: -300, w: 6400, h: 1740 })
  assert.deepEqual(monitorInFrame(mons[1], b), { x: 0, y: 500, w: 1920, h: 1080 })
  assert.deepEqual(monitorInFrame(mons[0], b), { x: 1920, y: 300, w: 2560, h: 1440 })
  assert.equal(virtualBounds([]), null)
})

test('多螢幕：點落在哪個螢幕（邊界屬於右／下一個螢幕）', () => {
  const mons = [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }]
  assert.equal(monitorAt(mons, 0, 0), 0)
  assert.equal(monitorAt(mons, 1919, 1079), 0)
  assert.equal(monitorAt(mons, 1920, 0), 1)
  assert.equal(monitorAt(mons, 3840, 0), -1)
  assert.equal(monitorAt(mons, -1, 5), -1)
})

test('尺寸標籤：上方放得下放上方，放不下放框內，且不超出右邊', () => {
  const view = { w: 1000, h: 600 }
  assert.deepEqual(sizeLabelPos({ x: 100, y: 100, w: 50, h: 50 }, view), { x: 100, y: 74 })
  assert.deepEqual(sizeLabelPos({ x: 100, y: 10, w: 50, h: 50 }, view), { x: 100, y: 14 })
  assert.equal(sizeLabelPos({ x: 990, y: 100, w: 5, h: 50 }, view).x, 920)
})

test('截圖檔名：本地時間、補零、副檔名 png、不含檔名禁用字元', () => {
  assert.equal(shotFileName(new Date(2026, 9, 5, 3, 4, 9)), '截圖 20261005-030409.png')
  assert.ok(!/[:/\\*?"<>|]/.test(shotFileName()))
})
