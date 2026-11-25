// #2038：Rust 事件橋——每個事件名最多一個底層 listener、退訂要真的取消、非同步競態不漏
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRustBridge } from '../ui/lib/rust-bridge.mjs'

// 假 listen：立刻成功；記每次註冊與取消
function fakeListen() {
  const recs = []
  const listen = (evt, fn) => { const r = { evt, fn, offs: 0 }; recs.push(r); return Promise.resolve(() => { r.offs++ }) }
  return { listen, recs }
}
// 假 listen：註冊要等手動放行（模擬「註冊還沒完成」）
function slowListen() {
  const recs = []
  const listen = (evt, fn) => new Promise(res => { const r = { evt, fn, offs: 0, release: () => res(() => { r.offs++ }) }; recs.push(r) })
  return { listen, recs }
}
const mk = (listen, extra = {}) => { const got = []; const bridge = createRustBridge({ listen, dispatch: (e, p) => got.push([e, p]), log: m => (extra.logs ??= []).push(m), ...extra }); return { bridge, got } }
const tick = () => new Promise(r => setImmediate(r))

test('同一事件多個訂閱者只向底層註冊一次', async () => {
  const f = fakeListen(), { bridge } = mk(f.listen)
  bridge.acquire('relay-bell'); bridge.acquire('relay-bell'); bridge.acquire('relay-bell')
  await bridge.ready()
  assert.equal(f.recs.length, 1)
})

test('不同事件各自註冊；沒人訂閱的事件不註冊', async () => {
  const f = fakeListen(), { bridge } = mk(f.listen)
  bridge.acquire('a'); bridge.acquire('b')
  await bridge.ready()
  assert.deepEqual(f.recs.map(r => r.evt).sort(), ['a', 'b'])
})

test('底層收到的 payload 原樣交給 dispatch（同一個物件）', async () => {
  const f = fakeListen(), { bridge, got } = mk(f.listen)
  bridge.acquire('x'); await bridge.ready()
  const p = { n: 1 }
  f.recs[0].fn(p)
  assert.equal(got.length, 1)
  assert.equal(got[0][0], 'x')
  assert.equal(got[0][1], p)
})

test('最後一個退訂才呼叫 unlisten；中間退訂不取消', async () => {
  const f = fakeListen(), { bridge } = mk(f.listen)
  const r1 = bridge.acquire('x'), r2 = bridge.acquire('x')
  await bridge.ready()
  r1()
  assert.equal(f.recs[0].offs, 0, '還有一個訂閱者，不能取消')
  r2()
  assert.equal(f.recs[0].offs, 1, '最後一個退訂就取消')
})

test('退訂函式重複呼叫只算一次', async () => {
  const f = fakeListen(), { bridge } = mk(f.listen)
  const r1 = bridge.acquire('x'), r2 = bridge.acquire('x')
  await bridge.ready()
  r1(); r1(); r1()
  assert.equal(f.recs[0].offs, 0, '重複呼叫同一個退訂函式不能多扣人數')
  r2()
  assert.equal(f.recs[0].offs, 1)
})

test('退訂後底層回呼不再轉給 dispatch', async () => {
  const f = fakeListen(), { bridge, got } = mk(f.listen)
  const r = bridge.acquire('x'); await bridge.ready()
  const stale = f.recs[0].fn
  r()
  stale('late')
  assert.deepEqual(got, [], '取消之後遲到的事件要丟掉')
})

test('還沒註冊完就退訂：註冊回來後立刻 unlisten，不漏', async () => {
  const s = slowListen(), { bridge, got } = mk(s.listen)
  const r = bridge.acquire('x')
  r()                       // 註冊還沒回來就退訂
  s.recs[0].release()       // 註冊現在才完成
  await tick()
  assert.equal(s.recs[0].offs, 1, '遲到的註冊結果要立刻取消')
  s.recs[0].fn('p')
  assert.deepEqual(got, [], '被丟掉的 listener 不能再送事件')
})

test('退訂後馬上重新訂閱：舊的註冊被取消、只有新的送事件、同一時間只有一個有效', async () => {
  const s = slowListen(), { bridge, got } = mk(s.listen)
  const r1 = bridge.acquire('x')
  r1()
  bridge.acquire('x')       // 重新訂閱：發出第二次註冊
  assert.equal(s.recs.length, 2)
  s.recs[0].release(); s.recs[1].release()
  await bridge.ready(); await tick()
  assert.equal(s.recs[0].offs, 1, '舊世代的註冊要取消')
  assert.equal(s.recs[1].offs, 0, '新世代的註冊要保留')
  s.recs[0].fn('old'); s.recs[1].fn('new')
  assert.deepEqual(got, [['x', 'new']])
})

test('註冊期間又有人加入：不重複註冊', async () => {
  const s = slowListen(), { bridge } = mk(s.listen)
  bridge.acquire('x'); bridge.acquire('x')
  assert.equal(s.recs.length, 1)
  s.recs[0].release(); await bridge.ready()
})

test('後接 listen：先有訂閱、之後 attach 才補註冊；只能接一次', async () => {
  const f = fakeListen(), logs = []
  const { bridge } = mk(null, { logs })
  bridge.acquire('x')
  await bridge.ready()
  assert.equal(f.recs.length, 0)
  bridge.attach(f.listen)
  await bridge.ready()
  assert.equal(f.recs.length, 1)
  bridge.attach(fakeListen().listen)
  assert.ok(logs.some(m => m.includes('already attached')))
  assert.equal(f.recs.length, 1)
})

test('沒有 Tauri（listen 同步丟錯）：不丟出去、記一行、退訂乾淨；全部退訂後可再試', async () => {
  const logs = []
  let n = 0
  const listen = () => { n++; throw new TypeError('no tauri') }
  const { bridge } = mk(listen, { logs })
  const r = bridge.acquire('x')
  await bridge.ready()
  assert.equal(n, 1)
  assert.ok(logs.some(m => m.includes('listen x failed')))
  r()
  bridge.acquire('x'); await bridge.ready()
  assert.equal(n, 2, '全部退訂後重訂才會再試')
})

test('listen 回傳被拒絕：同樣只記一行', async () => {
  const logs = []
  const { bridge } = mk(() => Promise.reject(new Error('boom')), { logs })
  bridge.acquire('x'); await bridge.ready()
  assert.ok(logs.some(m => m.includes('boom')))
})

test('unlisten 自己丟錯：吞掉，不影響其他事件的取消', async () => {
  const offs = []
  const listen = evt => Promise.resolve(() => { offs.push(evt); if (evt === 'a') throw new Error('gone') })
  const { bridge } = mk(listen)
  const ra = bridge.acquire('a'), rb = bridge.acquire('b')
  await bridge.ready()
  assert.doesNotThrow(() => ra())
  rb()
  assert.deepEqual(offs, ['a', 'b'])
})

test('dispose：全部取消；之後 acquire 不再註冊', async () => {
  const f = fakeListen(), { bridge } = mk(f.listen)
  bridge.acquire('a'); bridge.acquire('b'); await bridge.ready()
  bridge.dispose()
  assert.deepEqual(f.recs.map(r => r.offs), [1, 1])
  bridge.acquire('c'); await bridge.ready()
  assert.equal(f.recs.length, 2)
})
