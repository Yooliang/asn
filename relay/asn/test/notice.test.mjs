// 系統通知的共用判斷（notice.mjs）與 core.mjs 的「通知」對話：新舊寄件人、截止時間、舊對話併入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { NOTICE_ID, NOTICE_SENDER, foldName, isSystemNotice, withNoticeGroup, LEGACY_NOTICE_UNTIL } from '../ui/lib/notice.mjs'
import { withoutAsn } from '../ui/lib/roster.mjs'
import { deviceTabs } from '../ui/lib/tabs.mjs'
import { memStore } from './helpers.mjs'

test('截止時間預設沒設：舊寄件名規則對所有信有效', () => {
  assert.equal(LEGACY_NOTICE_UNTIL, null)
})

test('isSystemNotice：kind 是 notice:* 一定算；沒有 kind 才看舊寄件名與內文標記', () => {
  assert.equal(isSystemNotice({ kind: 'notice:quota', from_agent: '小乙' }), true)
  assert.equal(isSystemNotice({ from_agent: NOTICE_SENDER }), true)
  assert.equal(isSystemNotice({ from_agent: '額度通知收發室' }), true)
  assert.equal(isSystemNotice({ from_agent: 'W-收发室' }), true)   // 簡體
  assert.equal(isSystemNotice({ from_agent: 'ＡＳＮ　通知' }), true)   // 全形與空白
  assert.equal(isSystemNotice({ from_agent: 'asn​通知' }), true)   // 零寬字元
  assert.equal(isSystemNotice({ from_agent: '小乙', body: '你好' }), false)
  assert.equal(isSystemNotice({ kind: 'chat', from_agent: '小乙' }), false)
  assert.equal(isSystemNotice(null), false)
  assert.equal(foldName('ＡＳＮ 通知'), 'asn通知')
})

test('isSystemNotice：設了截止時間後，舊寄件名只對截止前的信有效', () => {
  const until = Date.parse('2026-12-01T00:00:00Z')
  const opt = { until }
  const before = '2026-11-20T00:00:00Z', after = '2026-12-02T00:00:00Z'
  assert.equal(isSystemNotice({ from_agent: NOTICE_SENDER, created_at: before }, opt), true)
  assert.equal(isSystemNotice({ from_agent: NOTICE_SENDER, created_at: after }, opt), false)
  assert.equal(isSystemNotice({ from_agent: 'X收發室', created_at: after }, opt), false)
  assert.equal(isSystemNotice({ from_agent: NOTICE_SENDER }, opt), false, '沒有 created_at 且已設截止＝不算')
  assert.equal(isSystemNotice({ kind: 'notice:login', from_agent: 'X', created_at: after }, opt), true, '有 kind 不受截止影響')
  assert.equal(isSystemNotice({ from_agent: NOTICE_SENDER, created_at: after }, { until: Date.parse('2027-01-01') }), true)
})

const NAME = 'T-ASN'
const roster = () => [{ id: 'T', agents: [{ name: NAME, status: 'idle' }] }, { id: 'W', agents: [{ name: 'W-政策', status: 'idle' }] }]
const mk = (core0 = {}) => new AsnCore({ transport: { list: async () => ({ members: roster() }), inbox: async () => ({ messages: [] }), ack: async () => ({}) }, store: core0.store ?? memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })

test('core：各種系統通知不建聯絡人，全部進同一個「通知」對話；一般信照舊', async () => {
  const base = { to_agent: NAME, trust: 'member', created_at: new Date().toISOString() }
  const msgs = [
    { id: '00000000-0000-4000-8000-000000000001', from_node: 'W', from_agent: '額度通知收發室', body: '額度', ...base },
    { id: '00000000-0000-4000-8000-000000000002', from_node: 'W', from_agent: NOTICE_SENDER, body: '新寄件人', ...base },
    { id: '00000000-0000-4000-8000-000000000003', from_node: 'W', from_agent: 'W-政策', kind: 'notice:bridge', body: '有 kind', ...base },
    { id: '00000000-0000-4000-8000-000000000004', from_node: 'W', from_agent: 'W-政策', body: '一般信', ...base },
  ]
  const c2 = new AsnCore({ transport: { list: async () => ({ members: roster() }), inbox: async () => ({ messages: msgs }), ack: async () => ({}) }, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await c2.start()
  const ids = c2.snapshot().friends.map(f => f.id).sort()
  assert.deepEqual(ids, [NOTICE_ID, 'W/W-政策'].sort())
  const n = c2.snapshot().friends.find(f => f.id === NOTICE_ID)
  assert.equal(n.nick, '通知'); assert.equal(n.isNotice, true); assert.equal(n.status, 'none')
  assert.equal(n.unread, 3)
  assert.equal(c2.logOf(NOTICE_ID).length, 3)
  assert.equal(c2.logOf('W/W-政策').length, 1)
  const r = await c2.send(NOTICE_ID, '嗨')
  assert.equal(r.ok, false)
  // 一般名單與設備頁籤都不列「通知」
  const fr = c2.snapshot().friends
  assert.ok(!withoutAsn(fr).some(f => f.id === NOTICE_ID))
  assert.ok(!deviceTabs(fr, { selfNode: 'T', selfName: NAME }).all.some(t => t.key === 'notice'))
  assert.equal(withNoticeGroup([], fr)[0].kind, 'notice')
  assert.deepEqual(withNoticeGroup([], fr, { query: '政' }), [])
  await c2.stop()
})

test('core：舊的「○○收發室」對話第一次載入就併進「通知」（依時間、未讀相加），舊列隱藏、原始記錄還在，第二次不重複併', async () => {
  const friend = (id, agent) => ({ id, node: 'W', agent, nick: agent, psm: '', engine: null, onRoster: false, known: true, lastAt: 0 })
  const data = {
    friends: [friend('H/額度通知收發室', '額度通知收發室'), friend('H/W-收發室', 'W-收發室')],
    logs: {
      'H/額度通知收發室': [{ k: 'them', text: 'A2', t: 200, id: 'a' }, { k: 'them', text: 'A4', t: 400 }],
      'H/W-收發室': [{ k: 'them', text: 'B1', t: 100 }, { k: 'them', text: 'A2', t: 200, id: 'a' }, { k: 'them', text: 'B3', t: 300 }],
    },
  }
  const store = memStore(JSON.parse(JSON.stringify(data)))
  const core = mk({ store })
  await core.start()
  assert.deepEqual(core.logOf(NOTICE_ID).map(m => m.text), ['B1', 'A2', 'B3', 'A4'])
  const fr = core.snapshot().friends
  assert.equal(fr.find(f => f.id === 'H/W-收發室').mergedInto, NOTICE_ID)
  assert.ok(!withoutAsn(fr).some(f => f.id.startsWith('H/')), '舊列不再顯示')
  assert.equal(core.logOf('H/W-收發室').length, 3, '原始記錄沒刪')
  await core.stop()
  assert.equal(store.data.logs['H/W-收發室'].length, 3, '存檔裡原始記錄還在')
  assert.ok(store.data.friends.some(f => f.id === NOTICE_ID && f.isNotice))
  // 第二次載入：不重複併
  const core2 = mk({ store })
  await core2.start()
  assert.equal(core2.logOf(NOTICE_ID).length, 4)
  assert.equal(core2.snapshot().friends.find(f => f.id === NOTICE_ID).status, 'none')
  await core2.stop()
})

test('core：沒有舊列、也沒收過通知，就不建立「通知」對話', async () => {
  const core = mk()
  await core.start()
  assert.ok(!core.snapshot().friends.some(f => f.id === NOTICE_ID))
  await core.stop()
})
