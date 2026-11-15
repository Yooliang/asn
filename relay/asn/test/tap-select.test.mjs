import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TAP_LONG_MS, TAP_MOVE_TOL, createTapGuard, toggleSelected } from '../ui/lib/tap-select.mjs'

const clock = () => { let t = 1000; return { now: () => t, add: ms => { t += ms } } }
const pe = (x, y, id = 1) => ({ clientX: x, clientY: y, pointerId: id })
const click = (x, y) => ({ clientX: x, clientY: y, detail: 1 })

test('點一下：按下放開幾乎沒動、時間短 → 算點', () => {
  const c = clock(), g = createTapGuard({ now: c.now })
  g.down(pe(100, 100)); g.move(pe(102, 103)); c.add(120)
  assert.equal(g.isTap(click(102, 103)), true)
})

test('捲動或拖拉：移動超過門檻、或瀏覽器送 pointercancel（接手去捲動）→ 不算點', () => {
  const c = clock(), g = createTapGuard({ now: c.now })
  g.down(pe(100, 100)); g.move(pe(100, 100 + TAP_MOVE_TOL + 1)); c.add(100)
  assert.equal(g.isTap(click(100, 100)), false, '中途移動超過門檻，回到原位放開也不算')
  g.down(pe(100, 100)); g.cancel()
  assert.equal(g.isTap(click(100, 100)), false, 'pointercancel 之後的 click 不算')
  g.down(pe(100, 100))
  assert.equal(g.isTap(click(100, 130)), false, '放開的位置離按下太遠')
  g.down(pe(100, 100)); g.move(pe(130, 100, 2))
  assert.equal(g.isTap(click(100, 100)), true, '別根手指的移動不算這一下')
})

test('長按（例如指紋圖示的說明）不算點；鍵盤的 click 一律算點；用過一次就清掉', () => {
  const c = clock(), g = createTapGuard({ now: c.now })
  g.down(pe(10, 10)); c.add(TAP_LONG_MS + 1)
  assert.equal(g.isTap(click(10, 10)), false)
  assert.equal(g.isTap({ detail: 0 }), true, '沒有按下就來的 click（鍵盤）')
  g.down(pe(10, 10)); g.move(pe(60, 10))
  assert.equal(g.isTap({ detail: 0, clientX: 0, clientY: 0 }), true, '鍵盤的 click 不看先前的指標')
  assert.equal(g.isTap(click(10, 10)), true, '上一次的狀態用過就清掉')
})

test('選中：點同一列收起，點別列換過去', () => {
  assert.equal(toggleSelected('', 'A'), 'A')
  assert.equal(toggleSelected('A', 'A'), '')
  assert.equal(toggleSelected('A', 'B'), 'B')
})
