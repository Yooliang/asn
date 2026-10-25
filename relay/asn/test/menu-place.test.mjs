// 右鍵選單與二級選單的定位與開關狀態（純函式），以及 list.html 裡選單放的位置（不能被 overflow 裁掉）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { placeMenu, placeSubmenu, submenuNext } from '../ui/lib/menu-place.mjs'

const VIEW = { w: 400, h: 600 }
const A = { left: 20, top: 100, right: 160, bottom: 126 }   // 父選單那一項

test('二級選單：預設貼在那一項右側、頂端對齊', () => {
  assert.deepEqual(placeSubmenu(A, { w: 140, h: 120 }, VIEW), { x: 160, y: 100, flipX: false, flipY: false })
})

test('二級選單：右側空間不夠就改貼左側（翻轉）', () => {
  const a = { left: 250, top: 100, right: 390, bottom: 126 }
  assert.deepEqual(placeSubmenu(a, { w: 140, h: 120 }, VIEW), { x: 110, y: 100, flipX: true, flipY: false })
  assert.equal(placeSubmenu(a, { w: 140, h: 120 }, { w: 534, h: 600 }).flipX, false, '剛好放得下就不翻')
})

test('二級選單：下方空間不夠就往上對齊（底端對齊那一項）', () => {
  const a = { left: 20, top: 560, right: 160, bottom: 586 }
  assert.deepEqual(placeSubmenu(a, { w: 140, h: 200 }, VIEW), { x: 160, y: 386, flipX: false, flipY: true })
})

test('二級選單：左右都放不下、上下也放不下，最後夾在視窗內（不會跑出視窗）', () => {
  for (const view of [{ w: 120, h: 90 }, { w: 300, h: 150 }, { w: 400, h: 600 }]) {
    for (const a of [{ left: 0, top: 0, right: 100, bottom: 20 }, { left: 200, top: 500, right: 300, bottom: 520 }, { left: 10, top: 80, right: 110, bottom: 100 }]) {
      const size = { w: 140, h: 200 }
      const p = placeSubmenu(a, size, view)
      assert.ok(p.x >= 4 && p.y >= 4, JSON.stringify([view, a, p]))
      if (view.w >= size.w + 8) assert.ok(p.x + size.w <= view.w - 4, JSON.stringify([view, a, p]))
      if (view.h >= size.h + 8) assert.ok(p.y + size.h <= view.h - 4, JSON.stringify([view, a, p]))
    }
  }
})

test('主選單：右邊不夠往左彈、下面不夠往上彈、夾在視窗內', () => {
  assert.deepEqual(placeMenu({ x: 50, y: 60 }, { w: 150, h: 200 }, VIEW), { x: 50, y: 60 })
  assert.deepEqual(placeMenu({ x: 350, y: 60 }, { w: 150, h: 200 }, VIEW), { x: 200, y: 60 })
  assert.deepEqual(placeMenu({ x: 50, y: 550 }, { w: 150, h: 200 }, VIEW), { x: 50, y: 350 })
  assert.deepEqual(placeMenu({ x: 5, y: 5 }, { w: 150, h: 700 }, VIEW), { x: 5, y: 4 }, '比視窗還高就貼上緣')
})

test('二級選單開關：滑過、點一下（切換）、鍵盤右鍵打開；移開、選完收起；Esc 先收子選單', () => {
  const closed = { open: false }, open = { open: true }
  assert.equal(submenuNext(closed, 'hover').open, true)
  assert.equal(submenuNext(closed, 'right').open, true)
  assert.equal(submenuNext(closed, 'click').open, true)
  assert.equal(submenuNext(open, 'click').open, false, '點第二次收起')
  assert.equal(submenuNext(open, 'hover').open, true, '滑回來維持開著')
  assert.equal(submenuNext(open, 'leave').open, false)
  assert.equal(submenuNext(open, 'pick').open, false)
  assert.deepEqual(submenuNext(open, 'escape'), { open: false, consumed: true }, 'Esc：收子選單並吃掉這次按鍵')
  assert.deepEqual(submenuNext(closed, 'escape'), { open: false, consumed: false }, '子選單沒開：Esc 交給主選單去關')
  for (const ev of ['hover', 'right', 'click']) assert.equal(submenuNext(closed, ev, false).open, false, `切不了：${ev} 不會打開`)
  assert.equal(submenuNext(null, 'hover').open, true)
})

test('list.html：主選單與二級選單都是最外層的 fixed 元素，不放在 .tabbar／可捲動容器裡；二級選單被點到不會關主選單', () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  const sub = /<ul class="av-menu buddy-menu buddy-subpop"[^>]*>/.exec(html)?.[0] ?? ''
  assert.match(sub, /ref="buddySubEl"/); assert.match(sub, /position|left: buddySubPos\.x/)
  assert.match(css, /\.buddy-menu,[^{]*\{position:fixed;z-index:62/, '主選單 fixed')
  assert.match(css, /\.buddy-subpop\{z-index:63/, '二級選單比主選單高一層')
  // 兩個選單與其他最外層的對話框同一層縮排（兩格）：不在 .tabbar 或任何 overflow 容器裡面
  for (const re of [/^  <ul class="av-menu buddy-menu" v-if="buddyMenu"/m, /^  <ul class="av-menu buddy-menu buddy-subpop"/m, /^  <partner-op-dialog /m]) assert.match(html, re, String(re))
  assert.match(html, /<li v-if="it\.key === 'model' && !buddyIsPi" class="model-sub">\s*<button[^>]*@mouseenter="subEvent\('hover'\)"[^>]*@click="subEvent\('click'\)"[^>]*@keydown\.right\.prevent="subEvent\('right'\)"/, '滑過、點一下、鍵盤右鍵都會開')
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /closest\('\.buddy-menu'\)/, '點到二級選單（也有 buddy-menu 樣式類別）不算點外面')
  assert.match(js, /submenuNext\(\{ open: buddyModel\.open \}, 'escape'\)/, 'Esc 先收子選單')
  assert.match(js, /placeSubmenu\(a, \{ w: r\.width, h: r\.height \}, viewSize\(\)\)/); assert.match(js, /placeMenu\(buddyMenuOrigin/)
})
