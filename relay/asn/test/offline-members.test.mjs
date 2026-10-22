// #167：離線成員（offline_agents）也列在名單上，標離線、排在後面；不重複、舊後台照舊。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFriends, mergeFriends, groupByDevice } from '../ui/lib/roster.mjs'

const members = [{ id: 'C', name: '雲端', kind: 'cloud', agents: [{ name: '小甲', status: 'idle', online: true }],
  offline_agents: [{ name: '小真', status: 'offline', online: false, cwd_label: 'proj', engine: 'grok' }, { name: '小甲', status: 'offline', online: false }] }]

test('buildFriends：離線成員標 offline，同名以在線為準，沒有 offline_agents 的舊名單不變', () => {
  const f = buildFriends(members, { selfNode: 'X', selfName: 'X-ASN' })
  assert.deepEqual(f.map(x => [x.nick, x.status]), [['小甲', 'online'], ['小真', 'offline']])
  assert.equal(f[1].psm, 'proj')
  assert.deepEqual(buildFriends([{ id: 'C', agents: [{ name: 'a', status: 'idle' }] }]).map(x => x.status), ['online'])
})

test('mergeFriends／groupByDevice：本機記憶的同一位不重複，離線排在後面', () => {
  const live = buildFriends(members, {})
  const known = [{ id: 'C/小真', node: 'C', agent: '小真', nick: '小真', status: 'online' }]
  const merged = mergeFriends(known, live)
  assert.equal(merged.filter(f => f.id === 'C/小真').length, 1)
  const g = groupByDevice(merged, {})
  assert.deepEqual(g[0].items.map(f => f.nick), ['小甲', '小真'])
})
