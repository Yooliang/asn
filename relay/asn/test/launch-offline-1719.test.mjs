// #1719：別台設備離線時，開新夥伴的設備列要灰掉（在線判斷＝設定「設備」頁籤的 isDeviceOnline）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { OFFLINE_REASON, launchDisableReason } from '../ui/lib/partner-launch-ui.mjs'
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

test('在線判斷跟設定「設備」頁籤是同一份：兩邊對每台設備的結論一致', () => {
  const friends = [F('A', 'online'), F('B', 'offline'), F('C', 'busy')]
  const rows = buildDeviceTree({ friends, selfNode: 'me', launchers: {}, machines: {} })
  for (const r of rows) assert.equal(r.online, isDeviceOnline(r.key, friends, { selfNode: 'me' }), r.key)
  assert.equal(rows.find(r => r.key === 'B').online, false)
  assert.equal(rows.find(r => r.key === 'C').online, true)
})

test('isDeviceOnline 與原本 device-tree 的寫法對多組資料結論完全一致', () => {
  const legacy = (node, friends, selfNode, asn) => {
    const mine = friends.filter(f => f.node === node)
    return node === selfNode || (Array.isArray(asn[node]) && asn[node].length > 0) || mine.some(f => f.status && f.status !== 'offline')
  }
  const nostatus = { id: 'N/x', node: 'N', agent: 'x' }
  const friends = [F('A', 'online'), F('B', 'offline'), F('B', 'offline'), F('C', 'offline'), F('C', 'busy'), nostatus, F('E', ''), { id: 'z', agent: 'x', status: 'online' }]
  const asns = [{}, { D: [{ v: 1 }] }, { B: [] }, { B: [{ v: 1 }] }, { A: null }]
  for (const asn of asns) for (const selfNode of ['me', 'B', '']) {
    for (const node of ['me', 'A', 'B', 'C', 'D', 'N', 'E', 'ghost', '', undefined]) {
      assert.equal(isDeviceOnline(node, friends, { selfNode, asn }), legacy(node, friends, selfNode, asn), `${node}/${selfNode}/${JSON.stringify(asn)}`)
    }
  }
})

test('畫面接線：電腦版把名單與 ASN 在線資料傳進 launchDisableReason', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /const launchCtx = computed\(\(\) => \(\{[^\n]*friends: friends\.value, asn: asnMap\.value/)
})
