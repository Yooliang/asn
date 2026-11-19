// #1808 守門（第 13 組：離線的對象被當成可用）。測試名稱帶原 issue 號；刪掉原修正這些測試必須變紅。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OFFLINE_REASON, launchDisableReason, canLaunchOnNode } from '../ui/lib/partner-launch-ui.mjs'
import { isDeviceOnline } from '../ui/lib/device-order.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { wakeTags, roomLog } from '../ui/lib/mobile-rooms.mjs'

const LAUNCHER = { profiles: [{ id: 'claude', label: 'Claude' }], cwd_allow: ['D:/a'] }
const F = (node, status) => ({ id: `${node}/x`, node, agent: 'x', nick: 'x', status, device: `設備${node}` })
const ctx = friends => ({ selfNode: 'me', partnerModels: [{ installed: true }], remoteLaunchers: { A: LAUNCHER, B: LAUNCHER, C: LAUNCHER }, friends })

test('#1719 守門：離線設備即使留著上次回報的啟動設定，開新夥伴也要灰掉並說明原因', () => {
  const friends = [F('A', 'online'), F('B', 'offline')]
  assert.equal(launchDisableReason('B', ctx(friends)), OFFLINE_REASON)
  assert.equal(canLaunchOnNode('B', ctx(friends)), false)
  assert.equal(launchDisableReason('A', ctx(friends)), '')
  assert.equal(launchDisableReason('me', ctx([])), '', '本機永遠在線')
})

test('#1720 守門：開新夥伴的在線判斷跟設定「設備」頁籤同一份（isDeviceOnline），含 ASN 視窗在線', () => {
  const friends = [F('A', 'online'), F('B', 'offline'), F('C', 'busy')]
  const rows = buildDeviceTree({ friends, selfNode: 'me', launchers: {}, machines: {} })
  for (const r of rows) {
    assert.equal(r.online, isDeviceOnline(r.key, friends, { selfNode: 'me' }), r.key)
    assert.equal(launchDisableReason(r.key, ctx(friends)) === OFFLINE_REASON, !r.online, r.key)
  }
  // 好友狀態離線、但那台有在線的 ASN 視窗：算在線（設備頁籤也是）
  assert.equal(launchDisableReason('B', { ...ctx(friends), asn: { B: [{ version: '1' }] } }), '')
})

test('#1661 守門：叫醒順序標籤把「被略過且目前離線」的成員標 offline；在線的略過者與沒給名單時不標', () => {
  const info = [{ key: 'W~甲', label: '甲', rank: 1, hold: false }, { key: 'N~乙', label: '乙', rank: 0, hold: true }, { key: 'Q~丙', label: '丙', rank: 0, hold: true }]
  assert.deepEqual(wakeTags(info, new Set(['N~乙'])), [{ label: '甲', off: false }, { label: '乙', off: true, offline: true }, { label: '丙', off: true }])
  assert.deepEqual(wakeTags(info).map(t => t.offline), [undefined, undefined, undefined])
})

test('#1661 守門：roomLog 依成員當下的在線狀態，替訊息自帶的 wake_info 標離線（重開群組、往上載舊訊息同一條）', () => {
  const members = [{ key: 'W~甲', name: '甲', kind: 'window', online: true }, { key: 'N~乙', name: '乙', kind: 'window', online: false }]
  const wake_info = [{ key: 'W~甲', label: '甲', rank: 1, hold: false }, { key: 'N~乙', label: '乙', rank: 0, hold: true }]
  const log = roomLog([{ seq: 3, from: 'P', from_kind: 'human', body: 'hi', at: '2026-11-18T12:00:00Z', wake_info }], ['P'], members)
  assert.deepEqual(log[0].wake, [{ label: '甲', off: false }, { label: '乙', off: true, offline: true }])
})
