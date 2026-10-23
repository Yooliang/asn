// 封存後仍留在名單的修正：名單上已經沒有它、但本機存檔記得它（有往來記錄的舊好友）時，用後台帶的 archived_keys 判斷封存；
// 夥伴 ID 與「n:節點/名字」兩種鍵都能命中；取消封存（鍵消失）立刻回來；舊後台沒有 archived_keys＝照舊。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { archivedKeysOf, buildFriends, isKeyArchived, mergeFriends } from '../ui/lib/roster.mjs'
import { activeFriends, archivedFriends } from '../ui/lib/archive.mjs'
import { memStore } from './helpers.mjs'

const PID = 'p_fdddfe7beb8947ba8643'
const mk = (list, store) => new AsnCore({ transport: { list: async () => list(), inbox: async () => ({ messages: [] }), ack: async () => {} }, store, selfNode: 'ME', windowName: 'ME-ASN', rosterMs: 1e9, pollMs: 1e9, statusPollMs: 1e9 })
const saved = (o = {}) => memStore({
  friends: [{ id: 'H/asn', node: 'H', agent: 'asn', nick: 'asn', known: true, ...o }],
  logs: { 'H/asn': [{ k: 'them', text: '嗨', t: 5, id: 'a' }] },
})

test('archivedKeysOf：收各台電腦的鍵；舊後台沒有、格式不對＝空', () => {
  assert.deepEqual([...archivedKeysOf([{ id: 'H', archived_keys: [PID, 'n:H/x', '', 5] }, { id: 'W' }, null, { id: 'Z', archived_keys: 'x' }])].sort(), ['n:H/x', PID].sort())
  assert.equal(archivedKeysOf(undefined).size, 0)
})

test('兩種鍵都命中：夥伴 ID 或 n:節點/名字', () => {
  const f = { node: 'H', agent: 'asn', partnerId: PID }
  assert.equal(isKeyArchived(new Set([PID]), f), true)
  assert.equal(isKeyArchived(new Set(['n:H/asn']), f), true)
  assert.equal(isKeyArchived(new Set(['n:H/asn']), { node: 'H', agent: 'asn' }), true)
  assert.equal(isKeyArchived(new Set([PID]), { node: 'H', agent: 'asn' }), false, '沒有夥伴 ID 的舊好友只認 n: 鍵')
  assert.equal(isKeyArchived(new Set(['n:W/asn']), f), false)
  assert.equal(isKeyArchived(new Set(), f), false)
})

test('mergeFriends：不在名單的本機舊好友靠封存鍵判斷；沒帶鍵就不封存；記住的舊旗標不沿用', () => {
  const known = [{ id: 'H/asn', node: 'H', agent: 'asn', nick: 'asn', partnerId: PID, archived: true }]
  const hit = mergeFriends(known, [], new Set([PID]))
  assert.deepEqual(archivedFriends(hit).map(f => f.agent), ['asn'])
  assert.deepEqual(activeFriends(hit), [])
  const off = mergeFriends(known, [], new Set())
  assert.deepEqual(activeFriends(off).map(f => f.agent), ['asn'], '鍵消失（取消封存）就回來，不被記住的 true 卡住')
  assert.equal(mergeFriends(known, []).find(f => f.agent === 'asn').archived, false)
})

test('mergeFriends：名單上的成員後台標 archived 或任一鍵命中都封存', () => {
  const live = buildFriends([{ id: 'H', agents: [{ name: 'a', partner_id: PID, archived: false }, { name: 'b', archived: true }, { name: 'c' }] }])
  const out = Object.fromEntries(mergeFriends([], live, new Set([PID])).map(f => [f.agent, f.archived]))
  assert.deepEqual(out, { a: true, b: true, c: false })
})

for (const [label, extra, keys] of [['夥伴 ID 鍵', { partnerId: PID }, [PID]], ['n: 鍵（沒有夥伴 ID 的舊好友）', {}, ['n:H/asn']]]) {
  test(`AsnCore 重現小良哥的狀況（${label}）：名單已無它、本機存檔記得它 → 進「已封存」不在一般名單；取消封存後回來`, async () => {
    let archivedKeys = keys
    const c = mk(() => ({ members: [{ id: 'H', name: '家用機', agents: [{ name: '別位', status: 'idle' }], offline_agents: [], archived_keys: archivedKeys }] }), saved(extra))
    await c.start()
    const all = c.snapshot().friends
    assert.deepEqual(activeFriends(all).map(f => f.agent), ['別位'])
    assert.deepEqual(archivedFriends(all).map(f => f.agent), ['asn'])
    assert.ok(c.logs.has('H/asn'), '往來記錄不動')
    archivedKeys = []
    await c.refreshRoster()
    assert.deepEqual(activeFriends(c.snapshot().friends).map(f => f.agent).sort(), ['asn', '別位'])
    await c.stop()
  })
}

test('舊後台（沒有 archived_keys）：行為照舊，本機舊好友照列', async () => {
  const c = mk(() => ({ members: [{ id: 'H', name: '家用機', agents: [], offline_agents: [] }] }), saved({ partnerId: PID }))
  await c.start()
  assert.deepEqual(activeFriends(c.snapshot().friends).map(f => f.agent), ['asn'])
  await c.stop()
})
