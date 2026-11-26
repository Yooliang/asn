// 主機接縫守門（#1763 F3）：前端讀主機物件（__TAURI__）只准在 ui/lib/host.mjs 一處。
// 例外只有 ui/skin-boot.js：它是不經打包的純腳本（classic script，要早於 Vue 套好外觀），不能 import host.mjs，只聽 asn:skin。
// 註解裡出現這個字也算違規（改寫成「不碰主機物件」之類的說法），這樣守門不必去判斷註解。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHost, host, setHost } from '../ui/lib/host.mjs'
import * as tauri from '../ui/lib/tauri.mjs'

const UI = fileURLToPath(new URL('../ui', import.meta.url))
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const rel = f => path.relative(UI, f).split(path.sep).join('/')
const all = walk(UI).filter(f => /\.(m?js|html)$/.test(f))
const src = f => fs.readFileSync(f, 'utf8')
const ALLOW = { 'lib/host.mjs': '主機接縫本身', 'skin-boot.js': '不經打包的純腳本，不能 import' }

test('守門前提：掃得到足夠多的檔案，且 host.mjs 與 skin-boot.js 確實含 __TAURI__（不然守門是空跑）', () => {
  assert.ok(all.length > 50, `只掃到 ${all.length} 個檔`)
  const names = all.map(rel)
  for (const n of Object.keys(ALLOW)) assert.ok(names.includes(n), `找不到 ${n}`)
  assert.ok(src(path.join(UI, 'lib/host.mjs')).includes('__TAURI__'), 'host.mjs 應該含 __TAURI__')
  assert.ok(src(path.join(UI, 'skin-boot.js')).includes('__TAURI__'), 'skin-boot.js 應該含 __TAURI__')
})

test('除了 lib/host.mjs 與 skin-boot.js，ui/ 底下（含註解）都不准出現 __TAURI__', () => {
  const bad = all.filter(f => !(rel(f) in ALLOW)).filter(f => src(f).includes('__TAURI__')).map(rel)
  assert.deepEqual(bad, [], `這些檔直接碰了主機物件：${bad.join('、')}（改走 lib/tauri.mjs，底層是 lib/host.mjs）`)
})

test('tauri.mjs 只 import photo.mjs、event-hub.mjs、host.mjs，不准多', () => {
  const s = src(path.join(UI, 'lib/tauri.mjs'))
  const froms = [...s.matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)].map(m => m[1])
  const bare = [...s.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.deepEqual(bare, [])
  assert.deepEqual(froms.sort(), ['./event-hub.mjs', './host.mjs', './photo.mjs'])
  assert.ok(!/\bimport\s*\(/.test(s), '不准動態 import')
})

// ---- host 的純函式行為（假的 raw 物件） ----
const fakeRaw = () => {
  const calls = []
  return {
    calls,
    raw: {
      core: { invoke: async (cmd, args) => { calls.push(['invoke', cmd, args]); return { cmd } } },
      event: {
        listen: async (evt, h) => { calls.push(['listen', evt]); h({ event: evt, id: 7, payload: { n: 1 } }); return () => calls.push(['unlisten', evt]) },
        emit: async (evt, payload) => { calls.push(['emit', evt, payload]) },
        emitTo: async (target, evt, payload) => { calls.push(['emitTo', target, evt, payload]) },
      },
      window: { getCurrentWindow: () => ({ startResizeDragging: dir => { calls.push(['resize', dir]); return 'ok' } }) },
    },
  }
}

test('makeHost：invoke 轉送、錯誤原樣丟', async () => {
  const { raw, calls } = fakeRaw()
  const h = makeHost(raw)
  assert.equal(h.available, true)
  assert.deepEqual(await h.invoke('a', { x: 1 }), { cmd: 'a' })
  assert.deepEqual(calls, [['invoke', 'a', { x: 1 }]])
  const boom = makeHost({ core: { invoke: async () => { throw 'denied' } } })
  await assert.rejects(boom.invoke('b'), e => e === 'denied')
})

test('makeHost：listen 的 fn 收到 payload（不是事件物件），回 Promise<unlisten>', async () => {
  const { raw, calls } = fakeRaw()
  const h = makeHost(raw)
  const got = []
  const p = h.listen('evt-a', v => got.push(v))
  assert.ok(p instanceof Promise)
  const off = await p
  assert.deepEqual(got, [{ n: 1 }])
  assert.equal(typeof off, 'function')
  off()
  assert.deepEqual(calls.at(-1), ['unlisten', 'evt-a'])
})

test('makeHost：emit、emitTo 照 Tauri 簽名轉送；window 有就轉 startResizeDragging', async () => {
  const { raw, calls } = fakeRaw()
  const h = makeHost(raw)
  await h.emit('e1', { a: 1 })
  await h.emitTo('chat-1', 'e2', 5)
  assert.deepEqual(calls, [['emit', 'e1', { a: 1 }], ['emitTo', 'chat-1', 'e2', 5]])
  assert.equal(h.window.startResizeDragging('North'), 'ok')
  assert.deepEqual(calls.at(-1), ['resize', 'North'])
  assert.equal(h.hasEvent, true)
})

test('makeHost：沒有主機物件時 available 是 false、window 是 null、hasEvent 是 false', () => {
  for (const h of [makeHost(undefined), makeHost({})]) {
    assert.equal(h.available, false)
    assert.equal(h.window, null)
    assert.equal(h.hasEvent, false)
  }
  assert.equal(makeHost({ event: {} }).available, false, '只有事件、沒有 core.invoke 不算有後端')
  assert.equal(makeHost({ event: {} }).hasEvent, true)
})

test('setHost 換掉之後，tauri.mjs 的對外函式走新的 host；換回去就恢復', async () => {
  const calls = []
  const spy = {
    available: true, hasEvent: true, window: { startResizeDragging: d => { calls.push(['resize', d]); return 'r' } },
    invoke: async (c, a) => { calls.push(['invoke', c, a]); return 'v' },
    listen: async (e, f) => { calls.push(['listen', e]); f('P'); return () => {} },
    emit: async (e, p) => { calls.push(['emit', e, p]) },
    emitTo: async (t, e, p) => { calls.push(['emitTo', t, e, p]) },
  }
  const orig = host
  setHost(spy)
  try {
    assert.equal(await tauri.invoke('c1', { k: 1 }), 'v')
    const got = []
    await tauri.listen('ev', v => got.push(v))
    await tauri.emit('e2', 3)
    assert.equal(tauri.resizeFrom('n'), 'r')
    await tauri.openLink('https://x.test')
    assert.deepEqual(got, ['P'])
    assert.deepEqual(calls, [['invoke', 'c1', { k: 1 }], ['listen', 'ev'], ['emit', 'e2', 3], ['resize', 'North'], ['invoke', 'open_link', { url: 'https://x.test' }]])
  } finally { setHost(orig) }
  assert.equal(tauri.openLink('https://x.test'), undefined, '換回去之後（測試環境沒有主機物件）openLink 什麼都不做')
})
