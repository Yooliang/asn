// 等你按確認的夥伴，從手機／別台電腦看終端與按鍵（#1638）：能看、能按本人的鍵，但不能寄信
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AWAITING_DETAIL, AWAITING_STATUS } from '../ui/lib/awaiting.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'
import { isDisplayOnly, remoteComposeOn, remoteInputAllowed } from '../ui/lib/display-only.mjs'
import { remoteEntry } from '../ui/lib/term-remote.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const awaitingFriend = { node: 'hom7a1', status: AWAITING_STATUS, awaiting: true, awaitName: '小乙', receivable: false, entryKind: 'process' }

test('等你按確認的夥伴：別台電腦的「終端」入口可用', () => {
  assert.equal(remoteEntry({ api: {}, friend: awaitingFriend, selfNode: 'wrk9b2', avail: true }), true)
  assert.equal(remoteEntry({ api: {}, friend: awaitingFriend, selfNode: 'hom7a1', avail: true }), false, '同一台走本機終端')
})

test('名單上的等確認條目：狀態是 awaiting、帶夥伴名，經 remoteEntry 放行', () => {
  const roster = [{ id: 'hom7a1', name: '家', agents: [{ name: 'claude · 小乙 #123', kind: 'process', receivable: false, detail: AWAITING_DETAIL, online: true }] }]
  const f = buildFriends(roster, 'wrk9b2').find(x => x.awaiting)
  assert.ok(f)
  assert.equal(f.status, AWAITING_STATUS)
  assert.equal(remoteEntry({ api: {}, friend: f, selfNode: 'wrk9b2', avail: true }), true)
})

test('遠端打字／按鍵列：只放行等確認的夥伴，其他僅顯示條目照舊擋', () => {
  assert.equal(isDisplayOnly(awaitingFriend), true, '寄信仍然擋著')
  assert.equal(remoteInputAllowed(awaitingFriend), true)
  assert.equal(remoteInputAllowed({ node: 'n', receivable: false, entryKind: 'process', status: 'running' }), false)
  assert.equal(remoteInputAllowed({ node: 'n', receivable: false }), false)
  assert.equal(remoteInputAllowed({ node: 'n', status: 'online' }), true)
  assert.equal(remoteInputAllowed(null), true)
})

test('不是等確認的僅顯示條目進不了終端打字模式；等確認的可以', () => {
  const on = friend => remoteComposeOn({ canInput: true, isRoom: false, friend, restartable: false })
  // 本機程序掃描出來的一般條目（自己開的 claude／codex 等）：就算能遠端打字也不進終端打字模式
  assert.equal(on({ node: 'n', receivable: false, entryKind: 'process', status: 'running', engine: 'claude' }), false)
  assert.equal(on({ node: 'n', receivable: false, entryKind: 'process', status: 'running', engine: 'codex' }), false)
  assert.equal(on({ node: 'n', entryKind: 'process', status: 'running' }), false, '只標 process 也算僅顯示')
  assert.equal(on({ node: 'n', receivable: false, entryKind: 'process', awaiting: false }), false, 'awaiting 要明確是 true')
  assert.equal(on({ node: 'n', receivable: false, entryKind: 'process', status: AWAITING_STATUS }), false, '只看 awaiting 旗標，不靠狀態字')
  // 等確認的夥伴與一般夥伴可以
  assert.equal(on(awaitingFriend), true)
  assert.equal(on({ node: 'n', status: 'online' }), true)
  // 其他前提不成立時一律不進
  assert.equal(remoteComposeOn({ canInput: false, isRoom: false, friend: awaitingFriend, restartable: false }), false)
  assert.equal(remoteComposeOn({ canInput: true, isRoom: false, friend: awaitingFriend, restartable: true }), false)
})

test('守門：chatpane 的遠端打字用 remoteInputAllowed、寄信路徑不經它，也沒有自動按鍵', () => {
  const src = read('../ui/lib/chatpane.mjs')
  assert.match(src, /const remoteCompose = computed\(\(\) => remoteComposeOn\(\{ canInput: canRemoteInput\.value, isRoom: isRoom\.value, friend: props\.friend, restartable: viewRestartable\.value \}\)\)/)
  assert.match(src, /const composeLocked = computed\(\(\) => displayOnly\.value && !termCompose\.value\)/)
  // 寄信：send() 先走終端、其餘仍被 displayOnly 擋
  assert.match(src, /let text = draft\.value\.trim\(\); if \(!text \|\| displayOnly\.value\) return/)
  // 本機終端打字照舊不放行
  assert.match(src, /const localCompose = computed\(\(\) => termShown\.value && Boolean\(props\.termViewApi\?\.input\) && !displayOnly\.value\)/)
})
