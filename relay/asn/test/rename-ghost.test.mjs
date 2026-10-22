// 改名後名單不該出現兩筆：同一個夥伴 ID 只留目前名字那筆，舊名的記錄／未讀／最後時間併過去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'
import { memStore } from './helpers.mjs'

const PID = 'p_0123456789abcdef0123'
const memberWith = agents => ({ members: [{ id: 'N1', name: '電腦', agents: agents.filter(a => a.online !== false), offline_agents: agents.filter(a => a.online === false) }] })
const mk = (list, store) => new AsnCore({ transport: { list: async () => list(), inbox: async () => ({ messages: [] }), ack: async () => {} }, store, selfNode: 'ME', windowName: 'ME-ASN', rosterMs: 1e9, pollMs: 1e9, statusPollMs: 1e9 })

test('buildFriends：後台離線成員還掛著舊名、同夥伴 ID 已用新名在線 → 只剩新名一筆', () => {
  const f = buildFriends(memberWith([{ name: 'VM管理', online: true, status: 'idle', partner_id: PID }, { name: 'error', online: false, status: 'offline', partner_id: PID }]).members)
  assert.deepEqual(f.map(x => x.nick), ['VM管理'])
})

test('buildFriends：沒有夥伴 ID 的同位舊資料照舊兩筆', () => {
  const f = buildFriends(memberWith([{ name: 'VM管理', online: true }, { name: 'error', online: false }]).members)
  assert.deepEqual(f.map(x => x.nick).sort(), ['VM管理', 'error'].sort())
})

test('refreshRoster：本機記住的舊名（有記錄、未讀）併進新名那筆並存檔', async () => {
  const store = memStore({
    friends: [{ id: 'N1/error', node: 'N1', agent: 'error', nick: 'error', partnerId: PID, lastAt: 500, known: true }, { id: 'N1/無關', node: 'N1', agent: '無關', nick: '無關', known: true }],
    logs: { 'N1/error': [{ k: 'me', text: '早', t: 100, id: 'a' }, { k: 'them', text: '你好', t: 500, id: 'b' }], 'N1/無關': [{ k: 'me', text: 'x', t: 1 }] },
  })
  const c = mk(() => memberWith([{ name: 'VM管理', online: true, status: 'idle', partner_id: PID }]), store)
  await c.start()
  assert.equal(c.snapshot().friends.filter(f => f.partnerId === PID).length, 1)
  assert.ok(!c.friends.has('N1/error'))
  assert.ok(!c.logs.has('N1/error'))
  assert.equal(c.friends.get('N1/VM管理').status, 'online')
  assert.deepEqual(c.logOf('N1/VM管理').map(m => m.id), ['a', 'b'])
  assert.equal(c.friends.get('N1/VM管理').lastAt, 500)
  assert.ok(c.friends.has('N1/無關'))   // 沒有夥伴 ID 的舊資料維持現狀
  await c.stop()
  assert.ok(!store.data.friends.some(f => f.id === 'N1/error'))
  assert.ok(!('N1/error' in store.data.logs))
  assert.equal(store.data.logs['N1/VM管理'].length, 2)
})
