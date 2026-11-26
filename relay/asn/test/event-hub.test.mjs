// #2038：事件中心——訂閱／扇出／退訂、Rust 事件的懶註冊、AsnCore 委派、子視窗收得到 asn:frame
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventHub, createWindowHub } from '../ui/lib/event-hub.mjs'
import { AsnCore } from '../ui/lib/core.mjs'
import { RUST_EVENTS, HUB_MIGRATED, jsEventNames, rustEventNames } from '../ui/lib/rust-events.mjs'

function fakeListen() {
  const recs = []
  const listen = (evt, fn) => { const r = { evt, fn, offs: 0 }; recs.push(r); return Promise.resolve(() => { r.offs++ }) }
  return { listen, recs }
}

test('內部事件：扇出順序＝訂閱順序、payload 同一個物件、不向 Tauri 註冊', async () => {
  const f = fakeListen(), hub = createEventHub({ listen: f.listen })
  const order = [], p = { a: 1 }
  hub.on('state', x => order.push(['1', x])); hub.on('state', x => order.push(['2', x]))
  hub.emit('state', p)
  assert.deepEqual(order.map(o => o[0]), ['1', '2'])
  assert.ok(order.every(o => o[1] === p))
  await hub.ready()
  assert.equal(f.recs.length, 0, '不在事件表的名字不碰橋')
})

test('subscriberCount：只算還沒退訂的；同函式訂兩次算兩個；重複退訂不多扣；別的事件不受影響', () => {
  const hub = createEventHub()
  assert.equal(hub.subscriberCount('term-view-frame'), 0)
  const f = () => {}
  const a = hub.subscribe('term-view-frame', f), b = hub.subscribe('term-view-frame', f), c = hub.subscribe('state', f)
  assert.equal(hub.subscriberCount('term-view-frame'), 2)
  assert.equal(hub.subscriberCount('state'), 1)
  a(); a()
  assert.equal(hub.subscriberCount('term-view-frame'), 1, '重複退訂只扣一次')
  b(); c()
  assert.equal(hub.subscriberCount('term-view-frame'), 0)
  assert.equal(hub.subscriberCount('state'), 0)
})

test('on 回傳 hub 可串接；subscribe 回傳取消函式', () => {
  const hub = createEventHub()
  assert.equal(hub.on('x', () => {}), hub)
  const got = []
  const off = hub.subscribe('y', v => got.push(v))
  hub.emit('y', 1); off(); hub.emit('y', 2); off()
  assert.deepEqual(got, [1], '退訂後不再收到')
})

test('off(evt, fn) 取消那一個函式；同函式訂兩次各算一個', () => {
  const hub = createEventHub(), got = []
  const f = v => got.push(v)
  hub.on('y', f); hub.on('y', f)
  hub.emit('y', 1)
  hub.off('y', f)
  hub.emit('y', 2)
  hub.off('y', f)
  hub.emit('y', 3)
  assert.deepEqual(got, [1, 1, 2])
})

test('處理器丟錯：記一行、不中斷同事件的其他處理器', () => {
  const logs = [], hub = createEventHub({ log: m => logs.push(m) }), got = []
  hub.on('z', () => { throw new Error('bad') }); hub.on('z', v => got.push(v))
  hub.emit('z', 7)
  assert.deepEqual(got, [7])
  assert.deepEqual(logs, ['handler z: bad'])
})

test('扇出到一半有人退訂：被退訂的不再被呼叫', () => {
  const hub = createEventHub(), got = []
  let off2
  hub.on('z', () => { off2() })
  off2 = hub.subscribe('z', () => got.push('second'))
  hub.emit('z', 0)
  assert.deepEqual(got, [])
})

test('Rust 事件：第一個訂閱才註冊、同名只註冊一次、最後一個退訂就 unlisten', async () => {
  const f = fakeListen(), hub = createEventHub({ listen: f.listen })
  const o1 = hub.subscribe('asn:open', () => {}), o2 = hub.subscribe('asn:open', () => {})
  await hub.ready()
  assert.equal(f.recs.length, 1)
  o1()
  assert.equal(f.recs[0].offs, 0)
  o2()
  assert.equal(f.recs[0].offs, 1)
})

test('Rust 事件：底層送來的 payload 扇出給所有訂閱者', async () => {
  const f = fakeListen(), hub = createEventHub({ listen: f.listen }), got = []
  hub.on('agent-setup', p => got.push(['a', p])); hub.on('agent-setup', p => got.push(['b', p]))
  await hub.ready()
  const p = { phase: 'x' }
  f.recs[0].fn(p)
  assert.equal(got.length, 2)
  assert.ok(got.every(g => g[1] === p))
})

test('Rust 事件：還沒註冊完就退訂，不漏 unlisten', async () => {
  const recs = []
  const listen = (evt, fn) => new Promise(res => { const r = { evt, fn, offs: 0, done: () => res(() => { r.offs++ }) }; recs.push(r) })
  const hub = createEventHub({ listen })
  const off = hub.subscribe('asn:frame', () => {})
  off()
  recs[0].done(); await hub.ready(); await new Promise(r => setImmediate(r))
  assert.equal(recs[0].offs, 1)
})

test('dispose：全部取消、訂閱清空', async () => {
  const f = fakeListen(), hub = createEventHub({ listen: f.listen }), got = []
  hub.on('relay-bell', () => got.push(1)); await hub.ready()
  hub.dispose()
  assert.equal(f.recs[0].offs, 1)
  hub.emit('relay-bell')
  assert.deepEqual(got, [])
})

test('broadcast／sendTo：走注入的 emit／emitTo；沒注入就什麼都不做', async () => {
  const sent = []
  const hub = createEventHub({ emit: (e, p) => { sent.push(['emit', e, p]); return Promise.resolve() }, emitTo: (l, e, p) => { sent.push(['to', l, e, p]); return Promise.resolve() } })
  await hub.broadcast('a', 1); await hub.sendTo('chat', 'b', 2)
  assert.deepEqual(sent, [['emit', 'a', 1], ['to', 'chat', 'b', 2]])
  await createEventHub().broadcast('a', 1)
})

test('事件表：Rust 26 種＋JS 12 種、欄位齊、已搬的都在表裡', () => {
  assert.equal(rustEventNames().length, 26)
  assert.equal(jsEventNames().length, 12)
  assert.equal(Object.keys(RUST_EVENTS).length, 38)
  for (const [k, v] of Object.entries(RUST_EVENTS)) {
    assert.ok(['all', 'window'].includes(v.scope), k)
    assert.ok(['desktop', 'mobile', 'both'].includes(v.platform), k)
    assert.equal(typeof v.shape, 'string', k)
  }
  for (const k of HUB_MIGRATED) assert.ok(k in RUST_EVENTS, k)
  // asn:skin 在表裡（事件名的唯一來源），但 skin-boot.js 是 classic script 不經 hub，所以不進已搬清單
  assert.ok('asn:skin' in RUST_EVENTS && !HUB_MIGRATED.includes('asn:skin'))
  assert.deepEqual([...HUB_MIGRATED].sort(), ['agent-setup', 'agent-setup-remote', 'android-update-progress', 'asn:attach-done', 'asn:avatars', 'asn:call', 'asn:cmd', 'asn:fpshow', 'asn:frame', 'asn:invite', 'asn:log', 'asn:now-playing', 'asn:older', 'asn:open', 'asn:panel', 'asn:room', 'asn:set', 'asn:settings', 'asn:state', 'asn:stt-progress', 'attach-cache-cleared', 'auth-signed-out', 'claude-account-auto', 'claude-mod-status', 'grok-account-auto', 'relay-bell', 'term-being-viewed', 'term-view-closed', 'term-view-frame', 'term-view-input-error', 'term-view-remote-end', 'term-view-remote-frame', 'update-progress'].sort())
})

// ---------- AsnCore 委派 ----------
const mkCore = extra => new AsnCore({ transport: { list: async () => [], inbox: async () => [], ack: async () => {}, send: async () => ({}) }, store: { load: async () => null, save: async () => {} }, selfNode: 'n', windowName: 'w', ...extra })

test('AsnCore.on／emit 行為不變：串接、例外記 log、四種內部事件照扇出', () => {
  const logs = []
  const core = mkCore({ log: m => logs.push(m) })
  const got = []
  assert.equal(core.on('state', () => got.push('s')), core, 'on 仍回傳 core 本身')
  core.on('log', id => got.push(`l${id}`)); core.on('notify', n => got.push(n)); core.on('avatars', () => got.push('av'))
  core.on('state', () => { throw new Error('x') })
  core.emit('state'); core.emit('log', 'f1'); core.emit('notify', 'n1'); core.emit('avatars')
  assert.deepEqual(got, ['s', 'lf1', 'n1', 'av'])
  assert.deepEqual(logs, ['handler state: x'])
})

test('AsnCore：core.on 訂閱 Rust 事件，bind 後才向 Tauri 註冊；ready 等註冊完', async () => {
  const f = fakeListen(), core = mkCore(), got = []
  core.on('asn:open', c => got.push(c))
  await core.ready()
  assert.equal(f.recs.length, 0, '還沒接橋')
  core.hub.attachRust(f.listen)
  await core.ready()
  assert.equal(f.recs.length, 1)
  f.recs[0].fn({ cid: 'c1' })
  assert.deepEqual(got, [{ cid: 'c1' }])
})

// ---------- 子視窗（沒有 AsnCore）：asn:frame 仍收得到 ----------
test('子視窗用 createWindowHub 訂 asn:frame，Rust 廣播時收得到（chat、panel 都這樣接）', async () => {
  const prev = { T: globalThis.__TAURI__, d: globalThis.document }
  const classes = new Set()
  const regs = []
  globalThis.document = { documentElement: { classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c) } } } }
  globalThis.__TAURI__ = {
    core: { invoke: async cmd => (cmd === 'frame_native' ? false : null) },
    event: { listen: async (evt, h) => { const r = { evt, h, offs: 0 }; regs.push(r); return () => { r.offs++ } }, emit: async () => {}, emitTo: async () => {} },
  }
  try {
    const { initFrame, createWindowHub: mkWin } = await import(`../ui/lib/tauri.mjs?t=${Date.now()}`)
    // chat、panel 的作法：沒有 AsnCore，initFrame() 自己建 window hub
    await initFrame()
    const frameRegs = regs.filter(r => r.evt === 'asn:frame')
    assert.equal(frameRegs.length, 1, '子視窗向 Tauri 註冊了 asn:frame')
    assert.equal(classes.has('frame-native'), false)
    frameRegs[0].h({ event: 'asn:frame', id: 1, payload: true })   // Tauri 的事件包裝：payload 在 .payload
    assert.equal(classes.has('frame-native'), true, '收到 true 就加 frame-native')
    frameRegs[0].h({ event: 'asn:frame', id: 2, payload: false })
    assert.equal(classes.has('frame-native'), false)
    // 傳進去的 hub 也行（有 AsnCore 的視窗可共用）
    const hub = mkWin()
    await initFrame(hub)
    assert.equal(regs.filter(r => r.evt === 'asn:frame').length, 2)
  } finally {
    globalThis.__TAURI__ = prev.T; globalThis.document = prev.d
  }
})

test('chat／panel／list／login／onboard 都還是呼叫 initFrame()（asn:frame 的接收點沒掉）', async () => {
  const fs = await import('node:fs')
  for (const f of ['chat', 'panel', 'list', 'login', 'onboard']) {
    const src = fs.readFileSync(new URL(`../ui/${f}.js`, import.meta.url), 'utf8')
    assert.match(src, /await initFrame\(\)/, `${f}.js 要呼叫 initFrame`)
  }
})

test('createWindowHub 是輕量 hub：不帶 AsnCore，只有 hub＋橋', async () => {
  const f = fakeListen(), hub = createWindowHub({ listen: f.listen }), got = []
  hub.on('asn:frame', v => got.push(v)); await hub.ready()
  f.recs[0].fn(true)
  assert.deepEqual(got, [true])
})
