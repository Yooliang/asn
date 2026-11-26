// #2038 PR-3：帳號登入類事件（claude-mod-status、claude-account-auto、grok-account-auto、auth-signed-out、attach-cache-cleared）從事件中心訂閱
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEventHub } from '../ui/lib/event-hub.mjs'
import { watchAccountEvents } from '../ui/lib/account-events.mjs'
import { createReloginWatch, AUTH_LOST_EVENT } from '../ui/lib/relogin-bar.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function fakeTauri() {
  const regs = []
  const listen = (evt, fn) => { const r = { evt, fn, offs: 0 }; regs.push(r); return Promise.resolve(() => { r.offs++ }) }
  const fire = (evt, payload) => { for (const r of regs) if (r.evt === evt && r.offs === 0) r.fn(payload) }
  const live = evt => regs.filter(r => r.evt === evt && r.offs === 0).length
  return { listen, regs, fire, live }
}

test('帳號事件：auto 事件觸發 onAuto 一次、帶同一個 payload；Claude 與 Grok 各自一次', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  const calls = []
  const accounts = { state: { mod: null }, onAuto: async p => { calls.push(p) } }
  watchAccountEvents(hub, accounts)
  await hub.ready()
  const a = { kind: 'added', email: 'a@x.test' }, g = { kind: 'added', email: 'g@x.test', vendor: 'grok' }
  t.fire('claude-account-auto', a)
  assert.equal(calls.length, 1); assert.equal(calls[0], a)
  t.fire('grok-account-auto', g)
  assert.equal(calls.length, 2); assert.equal(calls[1], g)
})

test('帳號事件：claude-mod-status 寫進 state.mod；沒內容就是 null；底層只有一個 listener', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  const accounts = { state: { mod: 'x' }, onAuto: async () => {} }
  watchAccountEvents(hub, accounts)
  await hub.ready()
  assert.equal(t.live('claude-mod-status'), 1)
  const rep = { state: 'installed', version: '1' }
  t.fire('claude-mod-status', rep)
  assert.equal(accounts.state.mod, rep)
  t.fire('claude-mod-status', undefined)
  assert.equal(accounts.state.mod, null)
})

test('帳號事件：退訂後全部取消註冊、不再處理', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  let n = 0
  const off = watchAccountEvents(hub, { state: {}, onAuto: async () => { n++ } })
  await hub.ready()
  off()
  for (const e of ['claude-mod-status', 'claude-account-auto', 'grok-account-auto']) assert.equal(t.live(e), 0, e)
  t.fire('claude-account-auto', {})
  assert.equal(n, 0)
})

test('重新登入提醒：auth-signed-out 事件走 hub；attach 重複呼叫不疊訂閱；沒有通道不丟錯', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  let checks = 0
  const w = createReloginWatch({ status: async () => { checks++; return { signed_in: false } }, canSkipLogin: () => true })
  w.attach(hub); w.attach(hub)
  await hub.ready()
  assert.equal(t.live(AUTH_LOST_EVENT), 1)
  t.fire(AUTH_LOST_EVENT)
  await new Promise(r => setTimeout(r, 5))
  assert.equal(checks, 1, '事件只觸發一次查詢')
  assert.equal(w.st.show, true)
  assert.doesNotThrow(() => w.attach(null))
  assert.equal(t.live(AUTH_LOST_EVENT), 0, 'attach(null) 退訂舊的')
})

test('attach-cache-cleared：tauri.mjs 一載入就註冊，事件來了清掉記著的大圖', async () => {
  const t = fakeTauri()
  const prev = globalThis.__TAURI__
  globalThis.__TAURI__ = { event: { listen: (evt, h) => t.listen(evt, e => h({ payload: e })) } }
  try {
    const { shownPhotos } = await import('../ui/lib/photo.mjs')
    await import(`../ui/lib/tauri.mjs?pr3=${Date.now()}`)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(t.live('attach-cache-cleared'), 1, '載入就註冊，不用等任何呼叫')
    shownPhotos.set('k', 'data')
    assert.equal(shownPhotos.size, 1)
    t.fire('attach-cache-cleared', undefined)
    assert.equal(shownPhotos.size, 0)
  } finally { globalThis.__TAURI__ = prev }
})

test('每個視窗都收得到 attach-cache-cleared：所有視窗進入檔都載入 tauri.mjs（模組載入即註冊），含沒有 AsnCore 的子視窗', () => {
  const entries = ['askpass', 'chat', 'list', 'login', 'm', 'onboard', 'panel', 'setup-progress', 'shot', 'toast']
  for (const e of entries) {
    const src = read(`ui/${e}.js`)
    const direct = /from '\.\/lib\/tauri\.mjs'/.test(src)
    assert.ok(direct, `${e}.js 要載入 lib/tauri.mjs（attach-cache-cleared 靠載入就註冊）`)
  }
  assert.match(read('ui/lib/tauri.mjs'), /^if \(H\(\)\.hasEvent\) createWindowHub\(\)\.subscribe\('attach-cache-cleared'/m)
})

test('畫面接線：帳號登入類事件不再直接 listen', () => {
  const list = read('ui/list.js'), m = read('ui/m.js'), relogin = read('ui/lib/relogin-bar.mjs'), tauri = read('ui/lib/tauri.mjs')
  for (const e of ['claude-mod-status', 'claude-account-auto', 'grok-account-auto']) assert.doesNotMatch(list, new RegExp(`listen\\('${e}'`), e)
  assert.doesNotMatch(relogin, /listen\(AUTH_LOST_EVENT/)
  assert.doesNotMatch(tauri, /listen\('attach-cache-cleared'/)
  assert.match(list, /reloginWatch\.attach\(core\.hub\)/)
  assert.match(m, /reloginWatch\.attach\(core\.hub\)/)
})
