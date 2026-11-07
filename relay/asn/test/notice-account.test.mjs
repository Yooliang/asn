// 系統通知的舊寄件名規則只對同一個帳號的節點有效；「通知」對話的每則通知標出是哪台設備寄的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { NOTICE_ID, NOTICE_SENDER, isSystemNotice } from '../ui/lib/notice.mjs'
import { UNNAMED_DEVICE } from '../ui/lib/text.mjs'
import { memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const roster = () => [{ id: 'T', agents: [{ name: NAME, status: 'idle' }] }, { id: 'W', agents: [{ name: 'W-政策', status: 'idle' }] }]

test('isSystemNotice：別的帳號的節點寄來的舊寄件名信是一般信；有 kind 的照樣算', () => {
  assert.equal(isSystemNotice({ from_agent: 'Z-收發室' }, { sameAccount: false }), false)
  assert.equal(isSystemNotice({ from_agent: NOTICE_SENDER }, { sameAccount: false }), false)
  assert.equal(isSystemNotice({ from_agent: 'Z-收發室' }, { sameAccount: true }), true)
  assert.equal(isSystemNotice({ kind: 'notice:bridge', from_agent: 'Z' }, { sameAccount: false }), true)
})

test('core：同帳號節點的舊寄件名信進「通知」並標出是哪台設備；別帳號節點的同名信是一般信', async () => {
  const base = { to_agent: NAME, trust: 'member', created_at: new Date().toISOString() }
  const msgs = [
    { id: '00000000-0000-4000-8000-000000000011', from_node: 'W', from_agent: 'W-收發室', sender_device: '30家用', body: '同帳號', ...base },
    { id: '00000000-0000-4000-8000-000000000012', from_node: 'W', from_agent: '額度通知收發室', body: '沒有設備名', ...base },
    { id: '00000000-0000-4000-8000-000000000013', from_node: 'Z', from_agent: 'Z-收發室', body: '外人', ...base },
  ]
  const core = new AsnCore({ transport: { list: async () => ({ members: roster() }), inbox: async () => ({ messages: msgs }), ack: async () => ({}) }, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.start()
  const log = core.logOf(NOTICE_ID)
  assert.deepEqual(log.map(m => m.text), ['同帳號', '沒有設備名'])
  assert.equal(log[0].dev, '30家用')
  assert.equal(log[1].dev, UNNAMED_DEVICE)
  assert.ok(core.snapshot().friends.some(f => f.id === 'Z/Z-收發室'), '外人的信照一般信長出聯絡人')
  assert.equal(core.logOf('Z/Z-收發室').length, 1)
  await core.stop()
})

test('core：舊的「○○收發室」對話列等名單載入後才併進「通知」，只併同帳號節點的；別帳號節點的同名列照舊是一般聯絡人', async () => {
  const saved = {
    friends: [
      { id: 'W/額度通知收發室', node: 'W', agent: '額度通知收發室', nick: '額度通知收發室', psm: '', engine: null, lastAt: 1, known: true },
      { id: 'Z/Z-收發室', node: 'Z', agent: 'Z-收發室', nick: 'Z-收發室', psm: '', engine: null, lastAt: 2, known: true },
    ],
    logs: { 'W/額度通知收發室': [{ k: 'them', text: '同帳號舊信', t: 1, id: 'a1' }], 'Z/Z-收發室': [{ k: 'them', text: '外人舊信', t: 2, id: 'a2' }] },
  }
  const core = new AsnCore({ transport: { list: async () => ({ members: roster() }), inbox: async () => ({ messages: [] }), ack: async () => ({}) }, store: memStore(saved), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.start()
  assert.deepEqual(core.logOf(NOTICE_ID).map(m => m.text), ['同帳號舊信'])
  const z = core.snapshot().friends.find(f => f.id === 'Z/Z-收發室')
  assert.ok(z && !z.mergedInto, '別帳號節點的列不併')
  await core.stop()
})
