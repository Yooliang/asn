// 看大圖縮放（#1498）：純計算與接線
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_TAP, clampPan, createZoom, tapZoom, wheelScale, zoomAt, zoomStyle } from '../ui/lib/photo-zoom.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const near = (a, b) => Math.abs(a - b) < 1e-9

test('以某一點縮放：那一點底下的內容不動；倍率限制在 1～8', () => {
  const z0 = { s: 1, x: 0, y: 0 }
  const z = zoomAt(z0, 2, 100, 50)
  // 縮放前在 (100,50) 的圖上點 q = (P - t)/s，縮放後仍在畫面 (100,50)
  const q = [(100 - z0.x) / z0.s, (50 - z0.y) / z0.s]
  assert.ok(near(z.x + z.s * q[0], 100) && near(z.y + z.s * q[1], 50), JSON.stringify(z))
  assert.equal(zoomAt(z0, 100, 0, 0).s, ZOOM_MAX)
  assert.equal(zoomAt(z0, 0.1, 0, 0).s, ZOOM_MIN)
})

test('平移範圍：只能拖到圖邊碰到外框；沒放大就置中', () => {
  // 圖 400×300、外框 400×300，放大 2 倍：寬多出 400，左右各能拖 200
  assert.deepEqual(clampPan({ s: 2, x: 999, y: -999 }, 400, 300, 400, 300), { s: 2, x: 200, y: -150 })
  // 圖比外框窄：放大後還沒超出就不能左右拖
  assert.deepEqual(clampPan({ s: 1.5, x: 50, y: 0 }, 200, 300, 400, 300), { s: 1.5, x: 0, y: 0 })
  assert.deepEqual(clampPan({ s: 1, x: 30, y: 40 }, 400, 300, 400, 300), { s: 1, x: 0, y: 0 })
})

test('滾輪：往前放大、往後縮小；以行計的滾輪也換算；不超出範圍', () => {
  assert.ok(wheelScale(1, -100) > 1.1)
  assert.equal(wheelScale(1, 100), 1)
  assert.ok(wheelScale(2, 100) < 2)
  assert.ok(near(wheelScale(1, -3, 1), wheelScale(1, -99)))
  assert.equal(wheelScale(7.9, -10000), ZOOM_MAX)
})

test('雙擊：沒放大就放大到 2.5 倍、以點的位置為中心；放大後雙擊回到原本大小', () => {
  const z = tapZoom({ s: 1, x: 0, y: 0 }, 80, -40)
  assert.equal(z.s, ZOOM_TAP)
  assert.ok(near(z.x, 80 - ZOOM_TAP * 80) && near(z.y, -40 + ZOOM_TAP * 40))
  assert.deepEqual(tapZoom(z, 0, 0), { s: 1, x: 0, y: 0 })
  assert.equal(zoomStyle({ s: 1, x: 0, y: 0 }), '')
  assert.equal(zoomStyle({ s: 2, x: 3, y: -4 }), 'transform:translate(3px,-4px) scale(2)')
})

// 假的 <img>：外框 400×300 置中在 (200,150)；量到的框跟著目前的倍率與平移
function fakeImg(state) {
  const box = { left: 0, top: 0, width: 400, height: 300 }
  const img = {
    parentElement: { getBoundingClientRect: () => box },
    getBoundingClientRect: () => ({ left: 200 + state.x - 200 * state.s, top: 150 + state.y - 150 * state.s, width: 400 * state.s, height: 300 * state.s }),
    setPointerCapture() {},
  }
  return img
}
const ev = (img, o) => ({ currentTarget: img, preventDefault() {}, button: 0, ...o })

test('接線：滾輪以游標為中心放大；拖曳平移；雙指捏合；觸控雙擊；重設', () => {
  const st = { s: 1, x: 0, y: 0 }
  let t = 0
  const z = createZoom(st, () => t)
  const img = fakeImg(st)
  // 滾輪在圖中心往前：放大、中心不動
  z.onWheel(ev(img, { clientX: 200, clientY: 150, deltaY: -300, deltaMode: 0 }))
  assert.ok(st.s > 1.5 && near(st.x, 0) && near(st.y, 0), JSON.stringify(st))
  // 滑鼠拖曳：跟著移動（在可拖範圍內）
  z.onPointerDown(ev(img, { pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: 150 }))
  z.onPointerMove(ev(img, { pointerId: 1, pointerType: 'mouse', clientX: 230, clientY: 160 }))
  z.onPointerUp(ev(img, { type: 'pointerup', pointerId: 1, pointerType: 'mouse', clientX: 230, clientY: 160 }))
  assert.ok(near(st.x, 30) && near(st.y, 10), JSON.stringify(st))
  // 拖太遠：停在圖邊
  z.onPointerDown(ev(img, { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 }))
  z.onPointerMove(ev(img, { pointerId: 1, pointerType: 'mouse', clientX: 5000, clientY: 0 }))
  z.onPointerUp(ev(img, { type: 'pointerup', pointerId: 1, pointerType: 'mouse' }))
  assert.ok(near(st.x, (400 * st.s - 400) / 2), JSON.stringify(st))
  z.reset()
  assert.deepEqual(st, { s: 1, x: 0, y: 0 })
  // 雙指：距離變兩倍 → 倍率兩倍
  z.onPointerDown(ev(img, { pointerId: 1, pointerType: 'touch', clientX: 150, clientY: 150 }))
  z.onPointerDown(ev(img, { pointerId: 2, pointerType: 'touch', clientX: 250, clientY: 150 }))
  z.onPointerMove(ev(img, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 150 }))
  z.onPointerMove(ev(img, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 150 }))
  assert.ok(near(st.s, 2) && near(st.x, 0), JSON.stringify(st))
  z.onPointerUp(ev(img, { type: 'pointerup', pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 150 }))
  z.onPointerUp(ev(img, { type: 'pointerup', pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 150 }))
  z.reset()
  // 觸控雙擊：放大；隔太久不算
  const tap = (x, y) => { z.onPointerDown(ev(img, { pointerId: 9, pointerType: 'touch', clientX: x, clientY: y })); z.onPointerUp(ev(img, { type: 'pointerup', pointerId: 9, pointerType: 'touch', clientX: x, clientY: y })) }
  tap(200, 150); t += 500; tap(200, 150)
  assert.equal(st.s, 1, '隔太久不算雙擊')
  t += 100; tap(200, 150)
  assert.equal(st.s, ZOOM_TAP)
  t += 1000; tap(200, 150); t += 100; tap(200, 150)
  assert.equal(st.s, 1, '再雙擊還原')
  // 觸控雙擊後瀏覽器補送的 dblclick：不算（不然會放大又馬上還原）
  z.onDblClick(ev(img, { clientX: 200, clientY: 150 }))
  assert.equal(st.s, 1)
  // 滑鼠的 dblclick
  t += 2000
  z.onDblClick(ev(img, { clientX: 200, clientY: 150 }))
  assert.equal(st.s, ZOOM_TAP)
})

test('接線守門：看大圖的圖片綁上縮放、打開與關掉都重設；觸控交給程式處理', () => {
  const pane = read('ui/lib/chatpane.mjs')
  for (const h of ['@wheel="zoomer.onWheel"', '@dblclick="zoomer.onDblClick"', '@pointerdown="zoomer.onPointerDown"', '@pointermove="zoomer.onPointerMove"', '@pointerup="zoomer.onPointerUp"', '@pointercancel="zoomer.onPointerUp"', ':style="pvStyle"']) {
    assert.ok(pane.includes(h), `少了 ${h}`)
  }
  assert.match(pane, /const closeViewer = \(\) => \{ viewer\.value = null; zoomer\.reset\(\) \}/)
  const open = pane.slice(pane.indexOf('async function openPhoto'), pane.indexOf('async function saveViewer'))
  assert.ok(open.includes('zoomer.reset()'))
  assert.match(read('ui/style.css'), /\.pv-body img\.pv-img\{touch-action:none/)
})
