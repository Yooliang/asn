// #2038 PR-6：終端畫面的五種 Rust 事件改走事件中心——註冊集合、共用底層 listener、先註冊完才發起（順序守門）、退訂、接線守門
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { rigHub } from './helpers/rig-hub.mjs'
import { HUB_MIGRATED, RUST_EVENTS } from '../ui/lib/rust-events.mjs'

const hooks = { mounted: [], unmount: [] }
globalThis.Vue = {
  ref: v => ({ value: v }),
  computed: fn => ({ get value() { return fn() } }),
  watch: (s, cb, opts) => { const src = typeof s === 'function' ? s : () => s.value; const last = src(); if (opts?.immediate) cb(last) },
  nextTick: () => new Promise(r => setTimeout(r, 2)),
  onMounted: fn => hooks.mounted.push(fn),
  onBeforeUnmount: fn => hooks.unmount.push(fn),
}
globalThis.Terminal = class { attachCustomWheelEventHandler() {} open() {} onData() {} write() {} dispose() {} }
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
const { createTermViewSession } = await import('../ui/lib/term-view.mjs')
const { RemoteView, FRAME_EVENT, END_EVENT } = await import('../ui/lib/term-remote.mjs')
const { RemoteInput } = await import('../ui/lib/term-remote-input.mjs')

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
const until = async (fn, what) => { for (let i = 0; i < 300 && !fn(); i++) await tick(); assert.ok(fn(), what) }
const FIVE = ['term-view-closed', 'term-view-frame', 'term-view-input-error', 'term-view-remote-end', 'term-view-remote-frame']

const sessionDeps = (rh, extra = {}) => ({
  hub: rh.hub, open: async () => 7, close: async () => {},
  createTerm: async () => ({ write() {}, resize() {}, dispose() {} }), onLost() {}, ...extra,
})
const remoteApi = rh => {
  const calls = []
  return {
    calls,
    api: {
      start: async () => { calls.push({ what: 'start', live: rh.liveTotal() }); return { id: 'r1', expires_s: Math.floor(Date.now() / 1000) + 600 } },
      stop: async id => { calls.push({ what: 'stop', id }) }, send: async () => {}, pause: async () => {},
    },
  }
}
function mountComp(Comp, rh, api) {
  hooks.mounted.length = 0; hooks.unmount.length = 0
  const st = Comp.setup({ api, eventHub: rh.hub, node: 'H', name: '小乙', machine: '家用機', active: true, snap: null, barInline: true }, { emit() {} })
  st.host.value = { isConnected: true, addEventListener() {}, removeEventListener() {} }
  for (const f of hooks.mounted) f()
  const unmounts = [...hooks.unmount]   // 這一格自己的：下一格掛上時 hooks 會清掉
  return { st, unmount: () => { for (const f of unmounts) f() } }
}

// ---------- 事件表 ----------
test('事件表：五種終端事件登記為已搬（共 21 種）；remote-input-stalled 沒有接收處、沒登記', () => {
  for (const k of FIVE) assert.ok(HUB_MIGRATED.includes(k), k)
  assert.equal(HUB_MIGRATED.length, 21)
  assert.ok(!HUB_MIGRATED.includes('term-view-remote-input-stalled'))
  assert.equal(RUST_EVENTS['term-view-remote-input-stalled'].listeners, 0)
})

// ---------- 註冊集合、共用底層 listener ----------
test('同視窗開兩個終端畫面、一個看別台、一個別台打字：底層只註冊那五種，每種 1 個，沒有 stalled', async () => {
  const rh = rigHub()
  const s1 = createTermViewSession(sessionDeps(rh)), s2 = createTermViewSession(sessionDeps(rh))
  const ra = remoteApi(rh), rb = remoteApi(rh)
  await Promise.all([s1.start(), s2.start()])
  const v = mountComp(RemoteView, rh, ra.api), i = mountComp(RemoteInput, rh, rb.api)
  await until(() => ra.calls.some(c => c.what === 'start') && rb.calls.some(c => c.what === 'start'), '兩個元件都發起了')
  assert.deepEqual([...rh.registered].sort(), FIVE, '註冊集合（每種剛好 1 次）')
  assert.ok(!rh.registered.includes('term-view-remote-input-stalled'))
  assert.equal(rh.liveTotal(), 5)
  v.unmount(); i.unmount(); s1.stop(); s2.stop()
  assert.equal(rh.liveTotal(), 0, '全部收掉後底層都取消')
  assert.equal(rh.state.offs, 5)
})

test('扇出：一幅畫面，所有訂閱者收到同一個物件、各 1 次、順序＝訂閱順序', async () => {
  const rh = rigHub(), got = []
  for (const n of ['a', 'b', 'c']) rh.hub.subscribe('term-view-frame', f => got.push([n, f]))
  await rh.hub.ready()
  const f = { view_id: 1, seq: 1 }
  rh.fire('term-view-frame', f)
  assert.deepEqual(got.map(g => g[0]), ['a', 'b', 'c'])
  assert.ok(got.every(g => g[1] === f), '同一個物件')
  assert.equal(rh.registered.length, 1, '底層只有 1 個 listener')
})

// ---------- 順序守門：await ready() 被刪就會紅 ----------
test('順序守門：工作階段要等三個底層監聽都註冊完才 open（沒等就會漏掉開好後馬上到的第一幅）', async () => {
  const rh = rigHub({ gated: true })
  let liveAtOpen = null
  const s = createTermViewSession(sessionDeps(rh, { open: async () => { liveAtOpen = rh.liveTotal(); return 7 } }))
  const started = s.start()
  await tick(5)
  assert.equal(rh.pendingGates(), 3, '三個底層註冊都還在等（先確認真的卡住了）')
  assert.equal(liveAtOpen, null, '底層沒註冊完，不能 open')
  await rh.release()
  await started
  assert.equal(liveAtOpen, 3, 'open 被呼叫時三個底層監聽都已經掛上')
  s.stop()
})

test('順序守門：看別台、別台打字都要等底層註冊完才發起', async () => {
  for (const Comp of [RemoteView, RemoteInput]) {
    const rh = rigHub({ gated: true }), r = remoteApi(rh)
    const v = mountComp(Comp, rh, r.api)
    await tick(10)
    assert.equal(rh.pendingGates(), 2, '畫面、結束兩個底層註冊都還在等')
    assert.equal(r.calls.filter(c => c.what === 'start').length, 0, '底層沒註冊完，不能發起')
    await rh.release()
    await until(() => r.calls.some(c => c.what === 'start'), '註冊完才發起')
    assert.equal(r.calls.find(c => c.what === 'start').live, 2, '發起時兩個底層監聽都已經掛上')
    v.unmount()
  }
})

// ---------- 開好前就到、結束後再到、重新發起 ----------
test('開好之前就到的畫面進 early、開好後補畫；結束後再到的畫面丟棄', async () => {
  const rh = rigHub(), written = []
  let release
  const s = createTermViewSession(sessionDeps(rh, {
    open: () => new Promise(res => { release = res }),
    createTerm: async () => ({ write: t => written.push(t), resize() {}, dispose() {} }),
  }))
  const started = s.start()
  await until(() => rh.liveTotal() === 3 && release, '底層註冊完、卡在 open')
  rh.fire('term-view-frame', { view_id: 7, seq: 1, text: '搶先到的', meta: { cols: 80, rows: 24 } })
  release(7)
  await started; await s.flushed()
  assert.equal(written.length, 1, '開好後補畫了搶先到的那一幅')
  s.stop()
  rh.fire('term-view-frame', { view_id: 7, seq: 2, text: '結束後才到', meta: { cols: 80, rows: 24 } })
  await s.flushed()
  assert.equal(written.length, 1, '結束後再到的丟棄')
})

test('重新發起：舊工作階段三個取消函式都被呼叫，新的一個照常掛三個', async () => {
  const rh = rigHub()
  const s1 = createTermViewSession(sessionDeps(rh)); await s1.start()
  assert.equal(rh.liveTotal(), 3)
  s1.stop()
  assert.equal(rh.state.offs, 3, '舊的三個都取消')
  const s2 = createTermViewSession(sessionDeps(rh)); await s2.start()
  assert.equal(rh.liveTotal(), 3, '新的重新掛上')
  s2.stop()
})

test('stop 先於 start：不訂閱、不 open、也不算讀不到', async () => {
  const rh = rigHub(), lost = []
  let opened = 0
  const s = createTermViewSession(sessionDeps(rh, { open: async () => { opened++; return 1 }, onLost: r => lost.push(r) }))
  s.stop()
  await s.start()
  assert.deepEqual(rh.registered, [])
  assert.equal(opened, 0)
  assert.deepEqual(lost, [])
})

// ---------- 接線守門（讀原始碼） ----------
test('接線：三個 api 物件、手機兩個 api 不再帶 listen；終端畫面檔不直接 listen', () => {
  const tauri = read('ui/lib/tauri.mjs')
  for (const name of ['termViewApi', 'remoteViewApi', 'remoteInputApi']) {
    const body = tauri.slice(tauri.indexOf(`export const ${name} = {`)).split('\n}\n')[0]
    assert.ok(body.length > 100 && body.includes('invoke('), `${name} 抓得到內容`)
    assert.ok(!/^\s*listen,?\s*$/m.test(body), `${name} 不再帶 listen`)
  }
  assert.match(tauri, /export const listen = /, 'listen 本身還匯出給別處（asn:* 事件）')
  const mobile = read('ui/lib/mobile-remote-view.mjs')
  assert.ok(!/\blisten\b/.test(mobile.replace(/^\s*\/\/.*$/gm, '')), 'mobile-remote-view 不碰 listen')
  for (const f of ['term-view', 'term-remote', 'term-remote-input']) {
    const code = read(`ui/lib/${f}.mjs`).replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/api\.listen|deps\.listen|listenWhile/.test(code), `${f} 不再走 api.listen`)
    assert.ok(!/eventHub\?\./.test(code), `${f} 不用 ?.（缺 hub 要丟錯，不能靜默）`)
  }
  assert.match(read('ui/lib/term-view.mjs'), /await deps\.hub\.ready\(\)/)
  assert.match(read('ui/lib/term-remote.mjs'), /await props\.eventHub\.ready\(\)/)
  assert.match(read('ui/lib/term-remote-input.mjs'), /await props\.eventHub\.ready\(\)/)
})

test('接線：三個元件的 eventHub 是必填、chat-pane 的是選填並傳給三個標籤；三種視窗都有傳', () => {
  for (const f of ['term-view', 'term-remote', 'term-remote-input']) {
    assert.match(read(`ui/lib/${f}.mjs`), /eventHub: \{ type: Object, required: true \}/, f)
  }
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /eventHub: \{ type: Object, default: null \}/)
  for (const tag of ['term-view v-if', 'remote-view v-if', 'remote-input v-if']) {
    const line = pane.split('\n').find(l => l.includes(`<${tag}`))
    assert.ok(line?.includes(':event-hub="eventHub"'), `chat-pane 的 <${tag}…> 要傳 eventHub`)
  }
  assert.match(read('ui/list.html'), /<chat-pane v-for="t in mergedTabs"[^>]*:event-hub="eventHub"/)
  assert.match(read('ui/list.html'), /<term-view [^>]*:event-hub="eventHub"/)
  assert.match(read('ui/m.html'), /<chat-pane v-if="chatFriend"[^>]*:event-hub="eventHub"/)
  assert.match(read('ui/chat.html'), /<chat-pane [^>]*:event-hub="eventHub"/)
  assert.match(read('ui/list.js'), /eventHub: core\.hub,/)
  assert.match(read('ui/m.js'), /eventHub: core\?\.hub \?\? null,/)
})

test('接線：chat.js 一個視窗只建一座事件中心，語音和終端共用', () => {
  const chat = read('ui/chat.js')
  assert.equal([...chat.matchAll(/createWindowHub\(\)/g)].length, 1)
  assert.match(chat, /const eventHub = createWindowHub\(\)/)
  assert.match(chat, /createVoiceUi\(\{ invoke, hub: eventHub,/)
  assert.match(chat, /termViewApi, eventHub,/)
})
