// 夥伴名單的「背景執行中」與第一次按 X 的說明
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMuxViews, backgroundNames, isMuxBackground, closeNoticeOnce, MUX_CLOSE_NOTICE, MUX_CLOSE_EXPLAINED_KEY } from '../ui/lib/mux-views.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8')
const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m } }

test('取狀態：舊版後端、手機版、丟錯、格式不對，一律當沒有', async () => {
  const v = { name: '小乙', viewing: false, closed: false }
  assert.deepEqual(await loadMuxViews({ termMuxViews: async () => [v, null, { name: '' }, { viewing: true }] }), [v])
  assert.deepEqual(await loadMuxViews({}), [])
  assert.deepEqual(await loadMuxViews(null), [])
  assert.deepEqual(await loadMuxViews({ termMuxViews: async () => ({ a: 1 }) }), [])
  assert.deepEqual(await loadMuxViews({ termMuxViews: async () => { throw new Error('unknown command') } }), [])
})

test('只標沒開畫面、在這台、沒離線、不是還在開的夥伴', () => {
  const names = backgroundNames([{ name: '甲', viewing: false }, { name: '乙', viewing: true }])
  assert.deepEqual([...names], ['甲'])
  const f = { agent: '甲', node: 'H', status: 'online' }
  assert.equal(isMuxBackground(f, 'H', names), true)
  assert.equal(isMuxBackground({ ...f, agent: '乙' }, 'H', names), false, '畫面開著')
  assert.equal(isMuxBackground(f, 'w02', names), false, '別台的同名夥伴')
  assert.equal(isMuxBackground({ ...f, status: 'offline' }, 'H', names), false)
  assert.equal(isMuxBackground({ ...f, pending: true }, 'H', names), false)
  assert.equal(isMuxBackground({ nick: '甲', node: 'H', status: 'online' }, 'H', names), true, '沒有 agent 看暱稱，和切換前台同一套')
  assert.equal(isMuxBackground(null, 'H', names), false)
})

test('按 X 的說明只跳一次；沒按 X 不跳；存不了也不會壞', () => {
  const s = store()
  assert.equal(closeNoticeOnce([{ name: '甲', closed: false }], s), null)
  assert.equal(s.m.size, 0, '沒跳就不算說過')
  assert.equal(closeNoticeOnce([{ name: '甲', closed: true }], s), MUX_CLOSE_NOTICE)
  assert.equal(s.m.get(MUX_CLOSE_EXPLAINED_KEY), '1')
  assert.equal(closeNoticeOnce([{ name: '甲', closed: true }], s), null)
  const bad = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(closeNoticeOnce([{ name: '甲', closed: true }], bad), MUX_CLOSE_NOTICE)
  assert.equal(closeNoticeOnce([{ name: '甲', closed: true }], null), MUX_CLOSE_NOTICE)
})

test('接線：後端命令有註冊、名單有標籤、點標籤不會開聊天', () => {
  assert.match(read('ui/lib/tauri.mjs'), /termMuxViews: \(\) => invoke\('term_mux_views'\)/)
  const lib = read('src-tauri/src/lib.rs')
  const desktop = lib.slice(lib.indexOf('.invoke_handler('), lib.indexOf('.invoke_handler(', lib.indexOf('.invoke_handler(') + 1))
  assert.match(desktop, /[\s,]term_mux_views[\s,]/)
  const html = read('ui/list.html')
  assert.match(html, /v-if="muxBackground\(c\)"/)
  assert.match(html, /@click\.stop="showMuxPartner\(c\)"/)
  assert.match(read('ui/list.js'), /muxBackground, showMuxPartner/)
})
