// 按住一秒（#1445）：按滿才送、放開或移開就取消、鍵盤自動重複不重算、只送一次
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOLD_MS, createHold } from '../ui/lib/hold-press.mjs'

function rig() {
  const timers = new Map()
  let next = 1
  const done = [], buzz = []
  const h = createHold({ setTimer: (f, ms) => { const id = next++; timers.set(id, { f, ms }); return id }, clearTimer: id => timers.delete(id), onDone: k => done.push(k), vibrate: ms => buzz.push(ms) })
  const fire = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.f() } }
  return { h, timers, fire, done, buzz }
}

test('按滿一秒才送那一顆，送一次、震一下；狀態清掉', () => {
  const r = rig()
  r.h.start(2)
  assert.equal(r.h.state.key, 2); assert.equal([...r.timers.values()][0].ms, HOLD_MS); assert.equal(HOLD_MS, 1000)
  r.fire()
  assert.deepEqual(r.done, [2]); assert.deepEqual(r.buzz, [30]); assert.equal(r.h.state.key, null)
  r.fire(); assert.deepEqual(r.done, [2], '不會送第二次')
})

test('放開、移開、被打斷：取消，什麼都不送', () => {
  const r = rig()
  r.h.start(1); r.h.cancel()
  assert.equal(r.timers.size, 0); assert.equal(r.h.state.key, null)
  r.fire(); assert.deepEqual(r.done, [])
})

test('換按另一顆：前一顆取消重算；同一顆重複的 pointerdown 不重算', () => {
  const r = rig()
  r.h.start(1); r.h.start(1)
  assert.equal(r.timers.size, 1)
  r.h.start(2)
  assert.equal(r.timers.size, 1); assert.equal(r.h.state.key, 2)
  r.fire(); assert.deepEqual(r.done, [2])
})

test('鍵盤：Enter／空白鍵按下開始、自動重複不重算、放開取消；其他鍵不管', () => {
  const r = rig()
  assert.equal(r.h.keyDown(1, { key: 'a' }), false)
  assert.equal(r.h.keyDown(1, { key: 'Enter' }), true)
  assert.equal(r.h.keyDown(1, { key: 'Enter', repeat: true }), true)
  assert.equal(r.timers.size, 1)
  r.h.keyUp({ key: 'Enter' })
  assert.equal(r.timers.size, 0); assert.deepEqual(r.done, [])
  r.h.keyDown(3, { key: ' ' }); r.fire(); assert.deepEqual(r.done, [3])
})

test('沒有震動功能也不會壞', () => {
  const done = []
  const h = createHold({ setTimer: f => { f(); return 1 }, clearTimer: () => {}, onDone: k => done.push(k), vibrate: () => { throw new Error('no') } })
  h.start(1); assert.deepEqual(done, [1])
})
