// 看別台終端（RemoteView）：事件中心的底層監聽註冊是非同步的，註冊完時那一次發起可能已經作廢（這一格收掉、或重新發起）。
// 作廢的那一次註冊完的監聽要解除、也不能發起（asn真 #1069 的意見；#2038 PR-6 起改由事件中心的橋保證，這裡用真的事件中心＋延遲放行的假 listen 驗）
import test from 'node:test'
import assert from 'node:assert/strict'
import { rigHub } from './helpers/rig-hub.mjs'

// RemoteView 在模組載入時從 globalThis.Vue 取 ref／onMounted／onBeforeUnmount／nextTick：先放假的，再載入
const hooks = { mounted: [], unmount: [] }
const watchers = []
const flush = () => { for (const w of watchers) { const v = w.src(); if (v !== w.last) { w.last = v; w.cb() } } }
globalThis.Vue = {
  ref: v => ({ value: v }),
  computed: fn => ({ get value() { return fn() } }),
  // 會追蹤的假 watch：flush() 時比較取值有沒有變，變了才呼叫回呼（immediate 先呼叫一次）
  watch: (src, cb, opts) => { const w = { src, cb, last: src() }; watchers.push(w); if (opts?.immediate) cb() },
  nextTick: async () => {},
  onMounted: fn => hooks.mounted.push(fn),
  onBeforeUnmount: fn => hooks.unmount.push(fn),
}
globalThis.Terminal = class { attachCustomWheelEventHandler() {} open() {} write() {} dispose() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
const { RemoteView, FRAME_EVENT, END_EVENT } = await import('../ui/lib/term-remote.mjs')

const tick = () => new Promise(r => setTimeout(r, 0))

/** 假介面（沒有 listen）＋延遲放行的事件中心：底層監聽要等測試放行才註冊完 */
function fakeApi() {
  const rh = rigHub({ gated: true }), calls = []
  const api = {
    start: async (...a) => { calls.push(['start', ...a]); return { id: 'v1', expires_s: Math.floor(Date.now() / 1000) + 600 } },
    stop: async id => { calls.push(['stop', id]) },
    pause: async () => {},
  }
  const release = async () => { await rh.release(); await tick() }
  return { api, rh, calls, release }
}

function mount(f, extra = {}, emit = () => {}) {
  hooks.mounted.length = 0; hooks.unmount.length = 0; watchers.length = 0
  const st = RemoteView.setup({ api: f.api, eventHub: f.rh.hub, node: 'H', name: '小乙', machine: '家用機', active: true, ...extra }, { emit })
  st.host.value = { isConnected: true }
  for (const fn of hooks.mounted) fn()
  return { st, unmount: () => { for (const fn of hooks.unmount) fn() } }
}

test('listen 故意延遲，期間把那一格收掉：之後 frame 與 end 兩個監聽都已經解除，也沒有發起', async () => {
  const f = fakeApi()
  const v = mount(f)
  await tick()
  assert.equal(f.rh.pendingGates(), 2, 'frame 與 end 兩個底層監聽都還沒註冊完（訂閱是同步的）')
  assert.deepEqual([...f.rh.registered].sort(), [END_EVENT, FRAME_EVENT].sort())
  v.unmount()            // 這一格收掉
  await f.release()      // 之後 listen 才陸續註冊完
  assert.equal(f.rh.liveTotal(), 0, '兩個監聽都要解除，不能留著')
  assert.equal(f.rh.state.offs, 2, '晚到的兩個都被取消（不是根本沒註冊）')
  assert.ok(!f.calls.some(c => c[0] === 'start'), '收掉了就不發起')
})

test('frame 註冊完、end 還在等時收掉：兩個都解除', async () => {
  const f = fakeApi()
  const v = mount(f)
  await tick()
  f.rh.take(1)()         // frame 註冊完
  await tick()
  assert.equal(f.rh.liveTotal(), 1, '先有一個掛著')
  v.unmount()
  await f.release()      // end 才註冊完
  assert.equal(f.rh.liveTotal(), 0)
  assert.equal(f.rh.state.offs, 2)
  assert.ok(!f.calls.some(c => c[0] === 'start'))
})

test('重新發起時，舊那一次晚註冊完的監聽也解除；新的一次照常留兩個', async () => {
  const f = fakeApi()
  const v = mount(f)
  await tick()
  const olds = f.rh.take(2)         // 舊那一次的兩個監聽先卡著
  v.st.again()                      // 重新發起
  await tick()
  assert.equal(f.rh.pendingGates(), 2, '新的一次也訂了 frame 與 end')
  await f.release()                 // 新的一次註冊完
  olds()                            // 舊的這時才註冊完
  await f.rh.hub.ready(); await tick()
  assert.equal(f.rh.liveTotal(), 2, '只留新那一次的 frame 與 end')
  assert.equal(f.rh.liveCount(FRAME_EVENT), 1)
  assert.equal(f.rh.liveCount(END_EVENT), 1)
  v.unmount()
  assert.equal(f.rh.liveTotal(), 0, '收掉時全部解除')
})

/** 開到「正在看」：放行監聽、等發起、推一幅畫面 */
async function watching(f, v) {
  for (let i = 0; i < 40 && v.st.phase.value !== 'watching'; i++) {
    await f.release()
    if (f.rh.liveCount(FRAME_EVENT) > 0 && f.calls.some(c => c[0] === 'start')) f.rh.fire(FRAME_EVENT, { id: 'v1', text: '測試通過', meta: { cols: 120, rows: 40 } })
  }
  assert.equal(v.st.phase.value, 'watching', '收到第一幅後進到正在看')
  flush()
  return v
}

test('電腦版（barInline false）：狀態事件跟著等待→正在看走，卸載後發 null（狀態列不殘留）', async () => {
  const f = fakeApi(), seen = []
  const v = mount(f, { barInline: false }, (name, payload) => { if (name === 'status') seen.push(payload) })
  assert.equal(seen[0]?.level, 'ask', '一開始就是等待')
  await watching(f, v)
  // #1865：正在看（可以送出打字）不再佔狀態列；看的是哪台哪位寫在輸入框提示字
  assert.equal(seen.at(-1), null, '正在看時狀態列沒有東西（沒有藍條）')
  assert.ok(!seen.some(s => s && /只能看|正在看/.test(s.text)), '任何時候都不出現「只能看」「正在看」')
  v.unmount()
  assert.equal(seen.at(-1), null, '卸載後發 null')
})

test('手機（barInline 預設 true）：不發 status 事件，也不在卸載時發', async () => {
  const f = fakeApi(), seen = []
  const v = mount(f, { barInline: true }, name => { seen.push(name) })
  await watching(f, v)
  v.unmount()
  assert.ok(!seen.includes('status'), '手機不該有 status 事件：' + seen.join(','))
})
