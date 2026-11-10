// 看別台終端（RemoteView）：listen 是非同步的，註冊完時那一次發起可能已經作廢（這一格收掉、或重新發起）。
// 作廢的那一次註冊完的監聽要馬上解除，不能留著（asn真 #1069 的意見）。
import test from 'node:test'
import assert from 'node:assert/strict'

// RemoteView 在模組載入時從 globalThis.Vue 取 ref／onMounted／onBeforeUnmount／nextTick：先放假的，再載入
const hooks = { mounted: [], unmount: [] }
globalThis.Vue = {
  ref: v => ({ value: v }),
  computed: fn => ({ get value() { return fn() } }),
  watch: () => {},
  nextTick: async () => {},
  onMounted: fn => hooks.mounted.push(fn),
  onBeforeUnmount: fn => hooks.unmount.push(fn),
}
globalThis.Terminal = class { attachCustomWheelEventHandler() {} open() {} write() {} dispose() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
const { RemoteView, listenWhile, FRAME_EVENT, END_EVENT } = await import('../ui/lib/term-remote.mjs')

const tick = () => new Promise(r => setTimeout(r, 0))

/** 假介面：listen 要等測試放行才註冊完；記下誰還掛著 */
function fakeApi() {
  const live = new Set(), pending = [], calls = []
  const api = {
    listen: (event, fn) => new Promise(resolve => pending.push(() => { const h = { event, fn }; live.add(h); resolve(() => live.delete(h)) })),
    start: async (...a) => { calls.push(['start', ...a]); return { id: 'v1', expires_s: Math.floor(Date.now() / 1000) + 600 } },
    stop: async id => { calls.push(['stop', id]) },
    pause: async () => {},
  }
  const release = async () => { while (pending.length) { pending.shift()(); await tick() } }
  return { api, live, pending, calls, release }
}

function mount(api) {
  hooks.mounted.length = 0; hooks.unmount.length = 0
  const st = RemoteView.setup({ api, node: 'H', name: '小乙', machine: '家用機', active: true }, { emit: () => {} })
  st.host.value = { isConnected: true }
  for (const f of hooks.mounted) f()
  return { st, unmount: () => { for (const f of hooks.unmount) f() } }
}

test('listenWhile：註冊完時還算數就留著；已作廢就馬上解除、回 null', async () => {
  const f = fakeApi()
  let ok = true
  const p = listenWhile(f.api, FRAME_EVENT, () => {}, () => ok)
  ok = false
  await f.release()
  assert.equal(await p, null)
  assert.equal(f.live.size, 0, '作廢的那一次不留監聽')
  const q = listenWhile(f.api, END_EVENT, () => {}, () => true)
  await f.release()
  assert.equal(typeof (await q), 'function')
  assert.equal(f.live.size, 1)
})

test('listen 故意延遲，期間把那一格收掉：之後 frame 與 end 兩個監聽都已經解除，也沒有發起', async () => {
  const f = fakeApi()
  const v = mount(f.api)
  await tick()
  assert.equal(f.pending.length, 1, 'frame 監聽還沒註冊完')
  v.unmount()            // 這一格收掉
  await f.release()      // 之後 listen 才陸續註冊完
  await tick()
  assert.equal(f.live.size, 0, '兩個監聽都要解除，不能留著')
  assert.ok(!f.calls.some(c => c[0] === 'start'), '收掉了就不發起')
})

test('frame 註冊完、end 還在等時收掉：兩個都解除', async () => {
  const f = fakeApi()
  const v = mount(f.api)
  await tick()
  f.pending.shift()()    // frame 註冊完
  await tick()
  assert.equal(f.live.size, 1)
  v.unmount()
  await f.release()      // end 才註冊完
  await tick()
  assert.equal(f.live.size, 0)
  assert.ok(!f.calls.some(c => c[0] === 'start'))
})

test('重新發起時，舊那一次晚註冊完的監聽也解除；新的一次照常留兩個', async () => {
  const f = fakeApi()
  const v = mount(f.api)
  await tick()
  const first = f.pending.shift()   // 舊那一次的 frame 監聽先卡著
  v.st.again()                      // 重新發起
  await tick()
  await f.release()                 // 新的一次註冊完
  await tick()
  first()                           // 舊的這時才註冊完
  await tick()
  assert.equal(f.live.size, 2, '只留新那一次的 frame 與 end')
  assert.deepEqual([...f.live].map(h => h.event).sort(), [END_EVENT, FRAME_EVENT].sort())
  v.unmount()
  assert.equal(f.live.size, 0, '收掉時全部解除')
})
