// 遠端打字元件的三個潛在缺陷（#1760）：重新發起沒重算「進過打字沒有」、xterm 建好前的畫面被丟掉、沒監看 active。
// 用真的 RemoteInput.setup，假 Vue、假 xterm、假 invoke（api）。
import test from 'node:test'
import assert from 'node:assert/strict'

const hooks = { mounted: [], unmount: [] }
const watchers = []
const flush = () => { for (const w of watchers) { const v = w.src(); if (v !== w.last) { const old = w.last; w.last = v; w.cb(v, old) } } }
globalThis.Vue = {
  ref: v => ({ value: v }),
  computed: fn => ({ get value() { return fn() } }),
  watch: (s, cb, opts) => { const src = typeof s === 'function' ? s : () => s.value; const w = { src, cb, last: src() }; watchers.push(w); if (opts?.immediate) cb(w.last) },
  nextTick: () => new Promise(r => setTimeout(r, 2)),
  onMounted: fn => hooks.mounted.push(fn),
  onBeforeUnmount: fn => hooks.unmount.push(fn),
}
const terms = []
globalThis.Terminal = class {
  constructor() { this.writes = []; terms.push(this) }
  attachCustomWheelEventHandler() {}
  open() {}
  onData() {}
  write(s) { this.writes.push(s) }
  dispose() { this.disposed = true }
}
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
const { RemoteInput, INPUT_TEXT } = await import('../ui/lib/term-remote-input.mjs')
const { FRAME_EVENT, END_EVENT } = await import('../ui/lib/term-remote.mjs')

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
const until = async (fn, what) => { for (let i = 0; i < 200 && !fn(); i++) await tick(); assert.ok(fn(), what) }

/** 假介面：每次 start 回 i1、i2…；listen 立刻註冊完 */
function fakeApi() {
  const handlers = {}, calls = []
  let n = 0
  const api = {
    listen: async (event, fn) => { handlers[event] = fn; return () => { if (handlers[event] === fn) delete handlers[event] } },
    start: async () => { calls.push('start'); return { id: 'i' + ++n, expires_s: Math.floor(Date.now() / 1000) + 600 } },
    stop: async id => { calls.push('stop:' + id) },
    send: async () => {},
    pause: async () => {},
  }
  return { api, handlers, calls }
}

const allUnmounts = []
test.after(() => { for (const f of allUnmounts) f() })   // 收掉每一格，不留 600 秒的到期計時器卡住程序

function mount(api, props = {}) {
  hooks.mounted.length = 0; hooks.unmount.length = 0; watchers.length = 0; terms.length = 0
  const events = []
  const p = { api, node: 'H', name: '小乙', machine: '家用機', active: true, snap: null, barInline: true, ...props }
  const st = RemoteInput.setup(p, { emit: (name, payload) => events.push([name, payload]) })
  st.host.value = { isConnected: true, addEventListener() {}, removeEventListener() {} }
  for (const f of hooks.mounted) f()
  allUnmounts.push(...hooks.unmount)
  return { st, p, events, unmount: () => { for (const f of hooks.unmount) f() } }
}
const frame = (id, text = '畫面一') => ({ id, text, meta: { cols: 80, rows: 24 } })

test('#1760-1：第一次進過打字，重新發起後被拒，要回到只能看、字放回輸入框', async () => {
  const f = fakeApi()
  const v = mount(f.api)
  await until(() => f.handlers[END_EVENT] && v.st.phase.value === 'waiting', '第一次連上')
  f.handlers[FRAME_EVENT](frame('i1'))
  assert.equal(v.st.phase.value, 'typing')
  v.st.again()                                   // 重新發起
  await until(() => v.st.phase.value === 'waiting', '第二次連上')
  v.st.sendLine('還沒送出的一句')                // 還沒開始打字，排著
  v.events.length = 0
  f.handlers[END_EVENT]({ id: 'i2', text: '對方不允許' })
  assert.equal(v.st.phase.value, 'ended')
  assert.deepEqual(v.events.find(e => e[0] === 'refused'), ['refused', '對方不允許'], '這一次沒進過打字：要回報被拒，外層回到只能看')
  assert.deepEqual(v.events.find(e => e[0] === 'unsent'), ['unsent', '還沒送出的一句'], '字放回輸入框')
})

test('#1760-1：這一次真的進過打字再結束，不算被拒（不會誤報）', async () => {
  const f = fakeApi()
  const v = mount(f.api)
  await until(() => f.handlers[END_EVENT] && v.st.phase.value === 'waiting', '連上')
  f.handlers[FRAME_EVENT](frame('i1'))
  f.handlers[END_EVENT]({ id: 'i1', text: '逾時' })
  assert.ok(!v.events.some(e => e[0] === 'refused'))
})

test('#1760-2：xterm 還沒建好時收到的畫面不丟，建好立刻補畫；只留最新一幅', async () => {
  const f = fakeApi()
  const v = mount(f.api)
  v.st.host.value = null                          // 框還沒掛上，xterm 建不起來
  await until(() => v.st.phase.value === 'waiting' && f.handlers[FRAME_EVENT], '連上了、xterm 還在等框')
  assert.equal(terms.length, 0, '此時 xterm 還沒建')
  f.handlers[FRAME_EVENT](frame('i1', '舊的一幅'))
  f.handlers[FRAME_EVENT](frame('i1', '最新的一幅'))
  v.st.host.value = { isConnected: true, addEventListener() {}, removeEventListener() {} }
  await until(() => terms.length === 1, 'xterm 建好')
  assert.equal(terms[0].writes.length, 1, '只補畫一幅，不排隊')
  assert.match(terms[0].writes[0], /最新的一幅/)
  assert.equal(v.st.phase.value, 'typing', '補畫後進到打字')
  assert.ok(v.events.some(e => e[0] === 'screen' && e[1].text === '最新的一幅'))
})

test('#1760-2：start 還沒回來（還不知道 id）就收到的畫面不丟，回來後是這一次的就補畫、別的丟掉', async () => {
  const f = fakeApi()
  let release
  const gate = new Promise(r => { release = r })
  const origStart = f.api.start
  f.api.start = async (...a) => { await gate; return origStart(...a) }
  const v = mount(f.api)
  await until(() => f.handlers[END_EVENT], '已註冊監聽、卡在發起')
  f.handlers[FRAME_EVENT](frame('i1', '搶先到的一幅'))
  release()
  await until(() => v.st.phase.value === 'typing', '補畫後進到打字')
  assert.match(terms.at(-1).writes.join(''), /搶先到的一幅/)

  const g = fakeApi()
  let rel2
  const gate2 = new Promise(r => { rel2 = r })
  const o2 = g.api.start
  g.api.start = async (...a) => { await gate2; return o2(...a) }
  const w = mount(g.api)
  await until(() => g.handlers[END_EVENT], '第二格卡在發起')
  g.handlers[FRAME_EVENT](frame('別台的', '不是這一次的'))
  rel2()
  await until(() => w.st.phase.value === 'waiting', '連上、等畫面')
  await tick(10)
  assert.equal(w.st.phase.value, 'waiting', 'id 對不上的那一幅不畫')
})

test('#1760-3：掛上時 active 是 false：不啟動、不顯示等待；變 true 才啟動', async () => {
  const f = fakeApi()
  const v = mount(f.api, { active: false })
  await tick(10)
  assert.equal(f.calls.length, 0, '不啟動')
  assert.ok(!['starting', 'waiting'].includes(v.st.phase.value), '不能停在等待：' + v.st.phase.value)
  v.p.active = true; flush()
  await until(() => v.st.phase.value === 'waiting', 'active 變 true 後啟動')
  assert.deepEqual(f.calls, ['start'])
})

test('#1760-3：active 變 false 時照結束流程收掉（通知那台結束、字放回、監聽解除）', async () => {
  const f = fakeApi()
  const v = mount(f.api)
  await until(() => v.st.phase.value === 'waiting', '連上')
  v.st.sendLine('排著的一句')
  v.events.length = 0
  v.p.active = false; flush()
  assert.equal(v.st.phase.value, 'ended')
  assert.ok(f.calls.includes('stop:i1'), '通知那台結束')
  assert.deepEqual(v.events.find(e => e[0] === 'unsent'), ['unsent', '排著的一句'])
  assert.equal(f.handlers[FRAME_EVENT], undefined, '監聽解除')
  assert.equal(v.st.warn.value, '')
})

test('#1760-3：發起到一半 active 變 false，晚到的那一次要結束、不留在等待', async () => {
  const f = fakeApi()
  let release
  const gate = new Promise(r => { release = r })
  const origStart = f.api.start
  f.api.start = async (...a) => { await gate; return origStart(...a) }
  const v = mount(f.api)
  await until(() => f.handlers[END_EVENT], '已註冊監聽、卡在發起')
  v.p.active = false; flush()
  release()
  await tick(10)
  assert.ok(f.calls.includes('stop:i1'), '晚到的那一次要通知那台結束')
  assert.equal(v.st.phase.value, 'ended')
  assert.equal(INPUT_TEXT.waiting, '正在連到那台電腦……', '沒有新增文案')
})
