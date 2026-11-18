// #1719：別台設備離線時，開新夥伴的設備列要灰掉（電腦版、手機版同一份在線判斷＝設定「設備」頁籤的 isDeviceOnline）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { OFFLINE_REASON, launchDisableReason } from '../ui/lib/partner-launch-ui.mjs'
import { REASON, launchEligibility, machinesByNode } from '../ui/lib/mobile-launch.mjs'
import { isDeviceOnline } from '../ui/lib/device-order.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'

const LAUNCHER = { profiles: [{ id: 'claude', label: 'Claude' }], cwd_allow: ['D:\a'] }
const F = (node, status) => ({ id: `${node}/x`, node, agent: 'x', nick: 'x', status, device: `設備${node}` })
const base = { selfNode: 'me', partnerModels: [{ installed: true }], remoteLaunchers: { A: LAUNCHER, B: LAUNCHER } }

test('電腦版：設備離線時灰掉並說明原因（即使留著上次回報的啟動設定）', () => {
  const friends = [F('A', 'online'), F('B', 'offline')]
  assert.equal(launchDisableReason('B', { ...base, friends }), OFFLINE_REASON)
  assert.equal(OFFLINE_REASON, '這台設備目前離線，開機並打開 ASN 後才能在上面開夥伴')
  assert.equal(launchDisableReason('A', { ...base, friends }), '', '在線且有 profiles 可選')
})

test('電腦版：有在線的 ASN 視窗（asn）也算在線；本機永遠在線', () => {
  const friends = [F('B', 'offline')]
  assert.equal(launchDisableReason('B', { ...base, friends, asn: { B: [{ version: '1' }] } }), '')
  assert.equal(launchDisableReason('me', { ...base, friends: [] }), '')
})

test('手機版：離線時不能開並給同一句原因；在線且有設定可開', () => {
  const machines = machinesByNode({ machines: [{ node: 'A', launcher: LAUNCHER, online: true }, { node: 'B', launcher: LAUNCHER, online: true }] })
  const ctx = { machines, loaded: true, signedIn: true, friends: [F('A', 'online'), F('B', 'offline')] }
  assert.deepEqual(launchEligibility('B', ctx), { ok: false, reason: OFFLINE_REASON })
  assert.equal(REASON.offline, OFFLINE_REASON)
  assert.deepEqual(launchEligibility('A', ctx), { ok: true, reason: '' })
})

test('在線判斷跟設定「設備」頁籤是同一份：兩邊對每台設備的結論一致', () => {
  const friends = [F('A', 'online'), F('B', 'offline'), F('C', 'busy')]
  const rows = buildDeviceTree({ friends, selfNode: 'me', launchers: {}, machines: {} })
  for (const r of rows) assert.equal(r.online, isDeviceOnline(r.key, friends, { selfNode: 'me' }), r.key)
  assert.equal(rows.find(r => r.key === 'B').online, false)
  assert.equal(rows.find(r => r.key === 'C').online, true)
})

test('畫面接線：電腦版把名單與 ASN 在線資料傳進 launchDisableReason', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /const launchCtx = computed\(\(\) => \(\{[^\n]*friends: friends\.value, asn: asnMap\.value/)
})
