// 本機封存：後台名單已經沒有這位、只剩本機好友存檔（有往來記錄的舊好友，沒有夥伴 ID）。
// 封存時後台回 404 not_found → 改在本機標記：進「已封存」、往來記錄不動、重開還在、取消封存回原位、不再說「不用封存」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { activeFriends, archivedFriends, runArchive } from '../ui/lib/archive.mjs'
import { mergeFriends, buildFriends } from '../ui/lib/roster.mjs'
import { memStore } from './helpers.mjs'

const members = () => ({ members: [{ id: 'H', name: '家用機', agents: [{ name: '別位', status: 'idle' }], offline_agents: [], archived_keys: [] }] })
const mk = (store, list = members) => new AsnCore({ transport: { list: async () => list(), inbox: async () => ({ messages: [] }), ack: async () => {} }, store, selfNode: 'ME', windowName: 'ME-ASN', rosterMs: 1e9, pollMs: 1e9, statusPollMs: 1e9 })
const seed = () => memStore({
  friends: [{ id: 'H/claude-07', node: 'H', agent: 'claude-07', nick: 'claude-07', known: true }],
  logs: { 'H/claude-07': [{ k: 'them', text: '嗨', t: 5, id: 'a' }] },
})
const notFound = { partnerArchive: async () => { throw new Error('partner_archive HTTP 404 not_found') } }
const names = fs => fs.map(f => f.agent)

test('沒有夥伴 ID 的舊好友封存（後台 404 not_found）：進已封存、不在一般名單、往來記錄還在、不說「不用封存」', async () => {
  const c = mk(seed())
  await c.start()
  assert.deepEqual(names(activeFriends(c.snapshot().friends)).sort(), ['claude-07', '別位'])
  const f = c.snapshot().friends.find(x => x.agent === 'claude-07')
  const r = await runArchive(notFound, f, true, (fr, a) => c.setLocalArchived(fr, a))
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.text, /不用封存/)
  await c.refreshRoster()   // 下一輪名單
  const all = c.snapshot().friends
  assert.deepEqual(names(activeFriends(all)), ['別位'])
  assert.deepEqual(names(archivedFriends(all)), ['claude-07'])
  assert.ok(c.logs.has('H/claude-07'), '往來記錄不刪')
  assert.ok(c.friends.get('H/claude-07'), '好友存檔不刪')
  await c.stop()
})

test('本機封存要持久：存檔寫入標記，重開（新 core 讀同一份存檔）還在已封存', async () => {
  const store = seed()
  const c = mk(store)
  await c.start()
  await runArchive(notFound, c.snapshot().friends.find(x => x.agent === 'claude-07'), true, (fr, a) => c.setLocalArchived(fr, a))
  await c.stop()
  const saved = await store.load()
  assert.equal(saved.friends.find(f => f.agent === 'claude-07').localArchived, true)
  const c2 = mk(store)
  await c2.start()
  assert.deepEqual(names(archivedFriends(c2.snapshot().friends)), ['claude-07'])
  assert.deepEqual(names(activeFriends(c2.snapshot().friends)), ['別位'])
  await c2.stop()
})

test('取消封存（後台也回 not_found）：只動本機，回到一般名單，標記不再寫進存檔', async () => {
  const store = seed()
  const c = mk(store)
  await c.start()
  const local = (fr, a) => c.setLocalArchived(fr, a)
  await runArchive(notFound, c.snapshot().friends.find(x => x.agent === 'claude-07'), true, local)
  await c.refreshRoster()
  const r = await runArchive(notFound, c.snapshot().friends.find(x => x.agent === 'claude-07'), false, local)
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.text, /不用封存/)
  await c.refreshRoster()
  assert.deepEqual(names(activeFriends(c.snapshot().friends)).sort(), ['claude-07', '別位'])
  assert.deepEqual(archivedFriends(c.snapshot().friends), [])
  await c.stop()
  assert.equal((await store.load()).friends.find(f => f.agent === 'claude-07').localArchived, undefined)
})

test('取消封存時後台回成功：本機標記也一併拿掉', async () => {
  const c = mk(seed())
  await c.start()
  const local = (fr, a) => c.setLocalArchived(fr, a)
  await runArchive(notFound, c.snapshot().friends.find(x => x.agent === 'claude-07'), true, local)
  const r = await runArchive({ partnerArchive: async () => ({ ok: true }) }, c.snapshot().friends.find(x => x.agent === 'claude-07'), false, local)
  assert.equal(r.ok, true)
  assert.deepEqual(names(archivedFriends(c.snapshot().friends)), [])
  await c.stop()
})

test('其他失敗照實說：登入、網路、權限不被本機封存吞掉，也不寫本機標記', async () => {
  const c = mk(seed())
  await c.start()
  const f = c.snapshot().friends.find(x => x.agent === 'claude-07')
  const local = (fr, a) => c.setLocalArchived(fr, a)
  const bad = msg => runArchive({ partnerArchive: async () => { throw new Error(msg) } }, f, true, local)
  assert.match((await bad('尚未登入，無法封存夥伴')).text, /登入/)
  assert.match((await bad('partner_archive 連線失敗：timeout')).text, /網路/)
  assert.equal((await bad('partner_archive HTTP 404')).ok, false)
  assert.deepEqual(names(archivedFriends(c.snapshot().friends)), [])
  await c.stop()
})

test('舊好友之後又在後台名單出現：以後台為準，本機標記丟掉（後台沒封存就回一般名單）', () => {
  const known = [{ id: 'H/claude-07', node: 'H', agent: 'claude-07', nick: 'claude-07', localArchived: true }]
  assert.deepEqual(names(archivedFriends(mergeFriends(known, []))), ['claude-07'])
  const live = buildFriends([{ id: 'H', agents: [{ name: 'claude-07', status: 'idle' }] }])
  const out = mergeFriends(known, live)
  assert.deepEqual(names(activeFriends(out)), ['claude-07'])
  assert.equal(out[0].localArchived, false)
})

test('本機封存的舊好友再寄信來：自動解除，和後台封存一致', async () => {
  let mails = []
  const c = new AsnCore({ transport: { list: async () => members(), inbox: async () => ({ messages: mails }), ack: async () => {} }, store: seed(), selfNode: 'ME', windowName: 'ME-ASN', rosterMs: 1e9, pollMs: 1e9, statusPollMs: 1e9 })
  await c.start()
  await runArchive(notFound, c.snapshot().friends.find(x => x.agent === 'claude-07'), true, (fr, a) => c.setLocalArchived(fr, a))
  assert.deepEqual(names(archivedFriends(c.snapshot().friends)), ['claude-07'])
  mails = [{ id: '11111111-1111-4111-8111-111111111111', from_node: 'H', from_agent: 'claude-07', to_node: 'ME', to_agent: 'ME-ASN', body: '我回來了', created_at: new Date().toISOString() }]
  await c.pull('test')
  assert.deepEqual(names(archivedFriends(c.snapshot().friends)), [])
  assert.ok(names(activeFriends(c.snapshot().friends)).includes('claude-07'))
  await c.stop()
})
