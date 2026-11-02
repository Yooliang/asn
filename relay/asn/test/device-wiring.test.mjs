// 設備頁的資料接線（todo-next-174 的 B2；asn真 在 #674 的兩點）：用「真實呼叫端的資料形狀」測，
// 不是測試自己捏的形狀——平台要真的接到 buildDeviceTree，本機偵測沒跑完不能說「未安裝」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildDeviceTree, profilesOf } from '../ui/lib/device-tree.mjs'
import { splitMachines } from '../ui/lib/remote-machines.mjs'
import { machinesByNode } from '../ui/lib/mobile-launch.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { STATE, installAction } from '../ui/lib/device-state.mjs'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const SELF = 'aaaaaaaa-0000-4000-8000-000000000001'
const PC = 'bbbbbbbb-0000-4000-8000-000000000002'
const PH = 'cccccccc-0000-4000-8000-000000000003'
const fr = (node, device, agent, engine, status = 'online', kind = null) => ({ node, device, agent, engine, status, kind, partnerId: 'eeeeeeee-0000-4000-8000-0000000000aa' })
const friends = [fr(SELF, '家用機', 'a1', 'asn'), fr(PC, '工作機', 'w1', 'asn'), fr(PH, 'Oppo 手機', 'p1', 'asn', 'online', 'other')]
// 後台 asn_relay_launchers 回的 machines（形狀照 20261028120000_node_platform.sql）
const body = {
  machines: [
    { node: PC, name: '工作機', machine: 'W', launcher: { profiles: [{ id: 'claude' }], cwd_allow: [] }, launcher_at: null, platform: 'windows', launch_closed_reason: null, online: true },
    { node: PH, name: 'Oppo', machine: null, launcher: null, launcher_at: null, platform: 'android', launch_closed_reason: null, online: true },
  ],
}
const rep = { error: '', asnOnline: true, reportedAt: new Date(NOW - 60000).toISOString(), accounts: [] }
const find = (t, l) => t.find(d => d.label === l)
const vend = (d, k) => d.vendors.find(v => v.key === k) ?? d.missing.find(v => v.key === k)

test('電腦版的資料形狀：splitMachines 的 machines 接進去，後台說是 android 的就是手機（名單種類寫 other 也一樣）', () => {
  const { launchers, machines } = splitMachines(body)
  assert.deepEqual(Object.keys(launchers), [PC], '沒開放（launcher 是 null）的不放進 launchers')
  assert.equal(machines[PH].platform, 'android')
  const t = buildDeviceTree({ friends, nodeOrder: [SELF, PC, PH], selfNode: SELF, now: NOW, launchers, machines, reports: { [PC]: rep } })
  const ph = find(t, 'Oppo 手機')
  assert.equal(ph.phone, true, '平台真的有接到')
  assert.equal(ph.kind, '手機')
  assert.deepEqual(ph.missing, [])
  // 沒傳 machines（舊的呼叫方式）就接不到——證明上面的判斷是靠 machines
  const without = find(buildDeviceTree({ friends, nodeOrder: [SELF, PC, PH], selfNode: SELF, now: NOW, launchers, reports: { [PC]: rep } }), 'Oppo 手機')
  assert.equal(without.phone, false)
})

test('手機版的資料形狀：machinesByNode 是整筆電腦設定，profiles 在 launcher 裡面；平台也要接得到', () => {
  const m = machinesByNode(body)
  assert.deepEqual(profilesOf(m[PC]), [{ id: 'claude' }], '手機版的形狀也認得出 profiles')
  assert.equal(profilesOf(m[PH]), null, '沒開放＝沒有')
  assert.equal(profilesOf({ profiles: [{ id: 'x' }] }) !== null, true, '電腦版的形狀')
  const t = acctDeviceTree({ friends, nodeOrder: [SELF, PC, PH], selfNode: SELF, now: NOW, launchers: m, machines: m, reports: { [PC]: { loading: false, asnOnline: true, reportedAt: rep.reportedAt, msg: '', list: [] } } })
  const ph = find(t, 'Oppo 手機')
  assert.equal(ph.phone, true)
  const pc = find(t, '工作機')
  assert.equal(vend(pc, 'claude').state, STATE.INSTALLED_LOGGED_OUT, '手機版也看得到那台裝了 Claude（launcher.profiles）')
  assert.equal(vend(pc, 'grok').state, STATE.NOT_INSTALLED, '啟動器有回報、沒有 Grok＝確定沒裝')
  // 沒有另外傳 machines 時沿用 launchers（整筆電腦設定本來就帶 platform）
  const t2 = acctDeviceTree({ friends, nodeOrder: [SELF, PC, PH], selfNode: SELF, now: NOW, launchers: m })
  assert.equal(find(t2, 'Oppo 手機').phone, true)
})

test('本機偵測：沒開視窗的 AI 只要偵測到就是已安裝；偵測還沒跑完不能說未安裝，也不給安裝按鈕', () => {
  const run = launchers => find(buildDeviceTree({ friends, nodeOrder: [SELF], selfNode: SELF, now: NOW, launchers, self: { claude: [], codex: { loggedIn: false, text: '' } } }), '家用機')
  // 偵測到 Claude 和 Codex（沒有任何視窗在用它們）
  const done = run({ [SELF]: { profiles: [{ id: 'claude' }, { id: 'codex' }], detected: true } })
  assert.equal(vend(done, 'claude').state, STATE.INSTALLED_LOGGED_OUT)
  assert.deepEqual(vend(done, 'claude').action, { kind: 'local' })
  assert.equal(vend(done, 'codex').state, STATE.INSTALLED_LOGGED_OUT)
  assert.equal(vend(done, 'grok').state, STATE.NOT_INSTALLED, '偵測完了、沒有 Grok＝未安裝')
  // 偵測跑完、真的沒有 Claude：未安裝＋可以安裝
  const none = run({ [SELF]: { profiles: [], detected: true } })
  assert.equal(vend(none, 'claude').state, STATE.NOT_INSTALLED)
  assert.deepEqual(vend(none, 'claude').action, { kind: 'local' })
  // 偵測還沒跑完：不確定，不亂說未安裝，也不給按鈕
  const loading = run({ [SELF]: { profiles: [], detected: false } })
  for (const k of ['claude', 'codex', 'grok']) {
    assert.equal(vend(loading, k).state, STATE.UNKNOWN_INSTALL, k)
    assert.equal(vend(loading, k).action, undefined, k)
  }
  assert.equal(installAction({ vendor: 'claude', isSelf: true, state: STATE.UNKNOWN_INSTALL }), null)
  // 連本機的啟動器資料都沒有：同樣不確定
  assert.equal(vend(run({}), 'claude').state, STATE.UNKNOWN_INSTALL)
})

test('守門：呼叫端真的把 machines 與偵測旗標傳進來（不是只有函式支援）', () => {
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(list, /machines: remoteMachines\.value/, '電腦版要傳 remoteMachines')
  assert.match(list, /detected: Object\.keys\(cliTools\.value\)\.length > 0/, '電腦版要傳本機偵測有沒有跑完')
  assert.match(list, /const \{ launchers: map, machines: mach \} = splitMachines\(body\)/, '遠端電腦設定走共用的 splitMachines')
  const m = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(m, /launchers: lchData\.machines, machines: lchData\.machines/, '手機版要傳 machinesByNode')
})
