// 0.2 E3（#397）：名單改看後台的最後活動時間；後台沒有這個欄位時退回本機往來的算法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE_WINDOW_MS, activityRound } from '../ui/lib/activity.mjs'
import { activeAtOf, buildFriends } from '../ui/lib/roster.mjs'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const H = 3_600_000

test('後台時間 ISO → 毫秒；沒有或壞值＝null', () => {
  assert.equal(activeAtOf('2026-10-28T11:00:00Z'), NOW - H)
  assert.equal(activeAtOf('2026-10-28T19:00:00+08:00'), NOW - H, '帶時區')
  for (const v of [null, undefined, '', '不是時間', 123, {}]) assert.equal(activeAtOf(v), null, String(v))
})

test('名單列帶 activeAt：在線與離線夥伴都帶；舊後台沒有欄位＝null', () => {
  const members = [{ id: 'H', name: '家用機', agents: [{ name: '小文', status: 'idle', last_active_at: '2026-10-28T11:00:00Z' }, { name: '舊的', status: 'idle' }],
    offline_agents: [{ name: '走了', status: 'offline', last_active_at: '2026-10-28T10:00:00Z' }] }]
  const fr = buildFriends(members, { selfNode: 'W', selfName: 'W-ASN' })
  const of = n => fr.find(f => f.agent === n)
  assert.equal(of('小文').activeAt, NOW - H)
  assert.equal(of('舊的').activeAt, null)
  assert.equal(of('走了').activeAt, NOW - 2 * H)
})

test('活躍度：別台設備上的夥伴沒跟這台往來過，後台有近 8 小時的活動就算活躍；後台沒欄位照舊看本機往來', () => {
  const fr = [
    { id: 'H/小文', status: 'idle', activeAt: NOW - H },
    { id: 'H/很久', status: 'idle', activeAt: NOW - ACTIVE_WINDOW_MS - H },
    { id: 'H/舊後台', status: 'idle', activeAt: null },
    { id: 'H/本機聊過', status: 'idle', activeAt: NOW - ACTIVE_WINDOW_MS - H },
    { id: 'H/離線', status: 'offline', activeAt: NOW },
  ]
  const logs = { 'H/本機聊過': [{ k: 'me', t: NOW - 60_000 }], 'H/舊後台': [{ k: 'them', t: NOW - 2 * H }] }
  const m = activityRound(fr, { logOf: id => logs[id] ?? [], now: NOW })
  assert.equal(m.get('H/小文').level, 'active', '後台時間讓別台的夥伴也看得到活躍')
  assert.equal(m.get('H/很久').level, 'idle')
  assert.equal(m.get('H/舊後台').level, 'active', '沒有後台欄位：退回本機往來')
  assert.equal(m.get('H/本機聊過').level, 'active', '後台舊、本機新：取最新')
  assert.equal(m.get('H/離線').level, 'offline', '離線照舊是離線')
})
