// 信上帶 from_owner 時，UI 直接用它判斷舊寄件名的信是不是系統通知；沒有欄位（舊後台）才看名單。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { NOTICE_ID, isSystemNotice } from '../ui/lib/notice.mjs'
import { memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const roster = () => [{ id: 'T', agents: [{ name: NAME, status: 'idle' }] }, { id: 'W', agents: [{ name: 'W-政策', status: 'idle' }] }]
const base = { to_agent: NAME, trust: 'member', created_at: new Date().toISOString() }
const mail = (n, from_node, from_agent, extra = {}) => ({ id: `00000000-0000-4000-8000-0000000000${n}`, from_node, from_agent, body: `信${n}`, ...base, ...extra })

async function run(msgs) {
  const core = new AsnCore({ transport: { list: async () => ({ members: roster() }), inbox: async () => ({ messages: msgs }), ack: async () => ({}) }, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.start()
  const out = { notice: core.logOf(NOTICE_ID).map(m => m.text), ids: core.snapshot().friends.map(f => f.id), core }
  await core.stop()
  return out
}

test('isSystemNotice：from_owner 優先於預設，sameAccount 明說的更優先', () => {
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知', from_owner: true }), true)
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知', from_owner: false }), false)
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知' }), true)
  assert.equal(isSystemNotice({ kind: 'notice:login', from_agent: 'x', from_owner: false }), true)
  assert.equal(isSystemNotice({ from_agent: 'ASN 通知', from_owner: true }, { sameAccount: false }), false)
})

test('core：from_owner＝true 的舊寄件名信進「通知」，就算節點不在名單上', async () => {
  const r = await run([mail(21, 'Z', 'Z-收發室', { from_owner: true })])
  assert.deepEqual(r.notice, ['信21'])
  assert.ok(!r.ids.includes('Z/Z-收發室'))
})

test('core：from_owner＝false 的舊寄件名信是一般信，就算節點在名單上', async () => {
  const r = await run([mail(22, 'W', 'W-收發室', { from_owner: false })])
  assert.deepEqual(r.notice, [])
  assert.ok(r.ids.includes('W/W-收發室'), '長出聯絡人')
})

test('core：沒有 from_owner（舊後台）照舊看名單', async () => {
  const r = await run([mail(23, 'W', 'W-收發室'), mail(24, 'Z', 'Z-收發室')])
  assert.deepEqual(r.notice, ['信23'])
  assert.ok(r.ids.includes('Z/Z-收發室'))
})
