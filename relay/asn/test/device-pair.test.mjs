// 設定頁「配對的電腦」（#597）的畫面邏輯與守門
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TEXT, errorText, newIncoming, normalizeView, pairTargets } from '../ui/lib/device-pair.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const view = () => normalizeView({
  peers: [{ node: 'p1', name: '家用‮機', fingerprint: 'ab12-cd34', peer_can_view_me: true, i_can_view_peer: false }, { name: '沒編號' }],
  incoming: [{ id: 'i1', from_node: 'd1', from_name: '工作機', fingerprint: 'ee', key_changed: true, stale: false }, {}],
  outgoing: [{ id: 'o1', to_node: 'p2', to_name: '公司', fingerprint: 'ff', status: 'pending' }, { id: 'o2', to_node: 'p3', to_name: '別台', status: 'expired' }],
})

test('整理：拿掉控制字元、方向分開、壞的丟掉', () => {
  const v = view()
  assert.deepEqual(v.peers, [{ node: 'p1', name: '家用 機', fingerprint: 'ab12-cd34', peerCanViewMe: true, iCanViewPeer: false }])
  assert.equal(v.incoming.length, 1)
  assert.equal(v.incoming[0].keyChanged, true)
  assert.equal(v.outgoing.length, 2)
  assert.deepEqual(normalizeView(null), { peers: [], incoming: [], outgoing: [] })
})

test('可以配對的：別台電腦、還沒配對、沒有在等；手機不列；同一台只列一次', () => {
  const friends = [
    { node: 'me', device: '這台' }, { node: 'p1', device: '已配對' }, { node: 'p2', device: '在等' }, { node: 'p3', device: '過期的可以再發' },
    { node: 'p4', device: '新的' }, { node: 'p4', device: '新的' }, { node: 'ph', device: '手機', platform: 'android' }, { node: 'x' }, null,
  ]
  assert.deepEqual(pairTargets(friends, 'me', view()), [{ node: 'p3', name: '過期的可以再發' }, { node: 'p4', name: '新的' }])
})

test('新請求只提醒一次', () => {
  const v = view()
  assert.equal(newIncoming(v, new Set()).length, 1)
  assert.equal(newIncoming(v, new Set(['i1'])).length, 0)
})

test('錯誤訊息：說發生什麼，不說哪一層；金鑰變了照原文', () => {
  assert.match(errorText(new Error('device_pair_start HTTP 409 no_key')), /版本太舊/)
  assert.match(errorText('尚未登入'), /先登入/)
  assert.equal(errorText('這台電腦的金鑰變了，可能是重裝過'), '這台電腦的金鑰變了，可能是重裝過')
  assert.ok(!errorText(new Error('HTTP 500 at relay')).includes('HTTP'))
})

test('說明要講的事：比對號碼、PIN 提示不要亂按、確認後對方能看', () => {
  assert.match(TEXT.pendingIn('甲'), /確認後，它可以看這台/)
  assert.match(TEXT.pendingOut('甲'), /可以先用手機拍下/)
  assert.ok(TEXT.pinWarn.includes('你沒按「看畫面」卻跳出 PIN 提示，不要按'))
  assert.ok(TEXT.keyChanged.includes('如果你沒有重裝它，不要確認'))
  for (const s of ['paired', 'rejected', 'expired', 'cancelled', 'bad_signature', 'key_changed']) assert.ok(TEXT.status[s], s)
})

test('守門：操作都接得住；命令只在電腦；手機和 CLI 接不到', () => {
  const panel = read('../ui/lib/settings-panel.mjs'), list = read('../ui/list.js'), lib = read('../src-tauri/src/lib.rs'), m = read('../ui/m.js')
  for (const op of ['pair-start', 'pair-decide', 'pair-close', 'pair-revoke']) {
    assert.ok(SETTING_OPS.includes(op), op)
    assert.ok(list.includes(`case '${op}'`), op)
  }
  assert.ok(!m.includes('device_pair'), '手機這一版不做')

  for (const c of ['device_pair_view', 'device_pair_start', 'device_pair_decide', 'device_pair_close', 'device_peer_revoke']) assert.match(lib, new RegExp(`fn ${c}\\(`), c)
  assert.ok(panel.includes('fingerprint'), '要顯示號碼')
  assert.ok(!/v-html/.test(panel.slice(panel.indexOf('配對的電腦'), panel.indexOf('配對的電腦') + 2500)), '名字不走 v-html')
})
