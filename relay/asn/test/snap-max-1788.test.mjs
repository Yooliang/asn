// #1788 放大鈕的分割版面：回報位置給 Rust、接收 Rust 的滑過／按下通知
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSnapMax, snapArgs, snapClasses } from '../ui/lib/snap-max.mjs'

const rect = { x: 600, y: 0, width: 46, height: 36 }

test('snapArgs：量得到才回報，壞數字與看不見的鈕回 null', () => {
  assert.deepEqual(snapArgs(rect, 1.5), { x: 600, y: 0, w: 46, h: 36, dpr: 1.5 })
  assert.equal(snapArgs(null, 1), null)
  assert.equal(snapArgs({ ...rect, width: 0 }, 1), null, '被藏起來（原生外框）寬高為 0')
  assert.equal(snapArgs({ ...rect, x: NaN }, 1), null)
  assert.equal(snapArgs(rect, 0), null)
})

test('snapClasses：滑過、按下、離開對應的樣式', () => {
  assert.deepEqual(snapClasses('hover'), ['snap-hover'])
  assert.deepEqual(snapClasses('down'), ['snap-hover', 'snap-down'])
  assert.deepEqual(snapClasses('leave'), [])
  assert.deepEqual(snapClasses('???'), [], '不認得的當作離開，不會卡在按下')
})

function fake(initialRect) {
  const classes = new Set()
  const btn = { classList: { add: c => classes.add(c), remove: (...cs) => cs.forEach(c => classes.delete(c)) }, getBoundingClientRect: () => btn.r, r: initialRect }
  const calls = []
  const doc = { querySelector: () => btn.present === false ? null : btn }
  const win = { devicePixelRatio: 1.25 }
  const sm = makeSnapMax({ call: async (c, a) => { calls.push([c, a]) }, listen: async () => {}, doc, win, raf: f => f() })
  return { btn, classes, calls, sm }
}

test('push：位置回報一次，沒變就不重複呼叫；變了才再報', async () => {
  const { btn, calls, sm } = fake(rect)
  await sm.push(); await sm.push()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['snap_max_set', { x: 600, y: 0, w: 46, h: 36, dpr: 1.25 }])
  btn.r = { ...rect, x: 500 }
  await sm.push()
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1].x, 500)
})

test('push：鈕消失（切原生外框）要清掉，且清掉滑過樣式；從沒回報過就不呼叫', async () => {
  const { btn, classes, calls, sm } = fake(rect)
  btn.r = { ...rect, width: 0, height: 0 }
  await sm.push()
  assert.equal(calls.length, 0, '從沒報過不用清')
  btn.r = rect
  await sm.push()
  sm.paint('down')
  assert.ok(classes.has('snap-down'))
  btn.r = { ...rect, width: 0, height: 0 }
  await sm.push()
  assert.equal(calls.at(-1)[0], 'snap_max_clear')
  assert.equal(classes.size, 0)
})

test('paint：按下→滑過→離開，樣式跟著換、不殘留', () => {
  const { classes, sm } = fake(rect)
  sm.paint('down')
  assert.deepEqual([...classes].sort(), ['snap-down', 'snap-hover'])
  sm.paint('hover')
  assert.deepEqual([...classes], ['snap-hover'])
  sm.paint('leave')
  assert.equal(classes.size, 0)
})

test('push：Rust 呼叫失敗後下次會重試（不會以為已經報過）', async () => {
  let fail = true
  const calls = []
  const btn = { classList: { add() {}, remove() {} }, getBoundingClientRect: () => rect }
  const sm = makeSnapMax({ call: async c => { calls.push(c); if (fail) throw new Error('x') }, listen: async () => {}, doc: { querySelector: () => btn }, win: { devicePixelRatio: 1 }, raf: f => f() })
  await sm.push()
  fail = false
  await sm.push()
  assert.equal(calls.length, 2)
})
