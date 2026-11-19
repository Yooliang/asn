// #1830：「通知」對話不是設備。設備頁（手機與電腦）不能多出一列「未命名設備・電腦・在線・沒回報」；
// 設備在線只認明確的在線狀態；設備順序裡不是節點的鍵（notice）讀與存都忽略。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { noticeFriend } from '../ui/lib/notice.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { launchDeviceRows } from '../ui/lib/partner-launch-ui.mjs'
import { launchDevices } from '../ui/lib/mobile-launch.mjs'
import { DEVICE_LIVE_STATUSES, buildFriends, isDeviceLiveStatus } from '../ui/lib/roster.mjs'
import { applyDeviceOrder, deviceFieldsFromSaved, deviceFieldsToSave, deviceFriends, isDeviceOnline, normalizeKeys, pruneRemoved } from '../ui/lib/device-order.mjs'

const F = (node, device, status = 'online', extra = {}) => ({ id: `${node}/a`, node, device, agent: 'a', nick: 'a', engine: 'claude', status, ...extra })
const real = [F('H', '家用機'), F('W', '工作機', 'offline')]
const withNotice = [...real, noticeFriend({ unread: 0 })]
const keys = rows => rows.map(r => r.key)

test('#1830 設備樹（電腦版）：有通知對話也不多一列', () => {
  const o = { selfNode: 'H', nodeOrder: ['H', 'W'] }
  assert.deepEqual(keys(buildDeviceTree({ ...o, friends: withNotice })), keys(buildDeviceTree({ ...o, friends: real })))
  assert.ok(!keys(buildDeviceTree({ ...o, friends: withNotice })).includes('notice'))
})

test('#1830 設備樹（手機版 acctDeviceTree）：有通知對話也不多一列', () => {
  const o = { selfNode: 'P', nodeOrder: ['P', 'H'] }
  const fr = [F('P', '手機'), F('H', '家用機'), noticeFriend()]
  assert.deepEqual(keys(acctDeviceTree({ ...o, friends: fr })), ['P', 'H'])
})

test('#1830 開新夥伴的設備清單（電腦 launchDeviceRows、手機 launchDevices）也不列通知', () => {
  assert.ok(!keys(launchDeviceRows(withNotice, { selfNode: 'H' })).includes('notice'))
  assert.ok(!launchDevices(withNotice, { selfNode: 'P', nodeOrder: ['H', 'notice'] }).map(r => r.key).includes('notice'))
})

test('#1830 已併進通知的舊列也不是設備', () => {
  assert.deepEqual(deviceFriends([F('X', 'x', 'online', { mergedInto: 'notice:me' }), F('H', 'h')]).map(f => f.node), ['H'])
})

test('#1830 在線只認明確的在線狀態：none、空值、不認得的值、offline 都不算', () => {
  for (const status of ['none', '', undefined, null, 'offline', 'weird', 'ONLINE ']) {
    assert.equal(isDeviceOnline('X', [{ ...F('X', 'x'), status }], { selfNode: 'H' }), false, String(status))
    assert.equal(isDeviceLiveStatus(status), false, String(status))
  }
  for (const status of DEVICE_LIVE_STATUSES) assert.equal(isDeviceOnline('X', [{ ...F('X', 'x'), status }], { selfNode: 'H' }), true, status)
})

test('#1830 名單產出的在線狀態全在白名單裡（buildFriends 不會產出白名單外的在線狀態）', () => {
  const members = [{ id: 'N', name: 'n', agents: ['online', 'busy', 'working', 'waiting', 'stopped', 'idle', 'zzz'].map((s, i) => ({ name: `a${i}`, status: s })) }, { id: 'M', name: 'm', agents: [{ name: 'p #1', kind: 'process' }] }]
  for (const f of buildFriends(members, {})) assert.equal(isDeviceLiveStatus(f.status), true, `${f.agent}:${f.status}`)
})

test('#1830 永久移除的自動解除：status none 不算活過來', () => {
  assert.deepEqual(pruneRemoved(['N1'], [{ id: 'N1/a', node: 'N1', status: 'none' }], { selfNode: 'H' }), ['N1'], 'none 不算活過來')
})

test('#1830 設備順序：notice 讀與存都忽略，其他照舊', () => {
  assert.deepEqual(normalizeKeys(['A', 'notice', 'B', 'A']), ['A', 'B'])
  const saved = { deviceOrder: ['notice', 'B'], deviceShown: ['notice'], deviceRemoved: ['A', 'notice'] }
  const read = deviceFieldsFromSaved(saved)
  assert.deepEqual([read.deviceOrder, read.deviceShown, read.deviceRemoved], [['B'], [], ['A']])
  const wrote = deviceFieldsToSave({ deviceOrder: ['notice', 'B'], deviceShown: [], deviceRemoved: [] })
  assert.deepEqual(wrote.deviceOrder, ['B'])
  const rows = [{ key: 'H' }, { key: 'A' }, { key: 'B' }]
  assert.deepEqual(applyDeviceOrder(rows, { selfNode: 'H', deviceOrder: ['notice', 'B', 'A'] }).map(r => r.key), ['H', 'B', 'A'])
})

test('#1830 守門：手機與電腦的設備列都經過同一個過濾函式 deviceFriends，沒有各寫一份', () => {
  const src = f => readFileSync(new URL(`../ui/lib/${f}`, import.meta.url), 'utf8')
  for (const f of ['device-tree.mjs', 'partner-launch-ui.mjs', 'mobile-launch.mjs']) assert.match(src(f), /deviceFriends\(/, f)
  assert.match(src('mobile-acct.mjs'), /buildDeviceTree\(/, '手機設備樹走 buildDeviceTree')
  assert.match(readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8'), /buildDeviceTree\(/, '電腦設備樹走 buildDeviceTree')
  // 設備在線／隱藏／自動解除只看 isLiveStatus，不再各自寫 status !== 'offline'
  assert.doesNotMatch(src('device-order.mjs'), /status !== 'offline'/)
  assert.doesNotMatch(src('partner-launch-ui.mjs'), /status !== 'offline'/)
})

test('#1830 守門：isDeviceLiveStatus（stopped 也算在線）只有設備層級的兩個檔案可以引用，不能拿來判斷夥伴能不能收信', () => {
  const dirs = ['../ui/', '../ui/lib/', '../scripts/']
  const allowed = new Set(['roster.mjs', 'device-order.mjs', 'partner-launch-ui.mjs'])
  const users = []
  for (const d of dirs) {
    for (const f of readdirSync(new URL(d, import.meta.url))) {
      if (!/\.(mjs|js)$/.test(f)) continue
      if (/isDeviceLiveStatus|DEVICE_LIVE_STATUSES/.test(readFileSync(new URL(d + f, import.meta.url), 'utf8'))) users.push(f)
    }
  }
  assert.deepEqual(users.filter(f => !allowed.has(f)), [], '設備在線狀態只能用在設備層級（device-order／partner-launch-ui）')
  assert.ok(users.includes('device-order.mjs') && users.includes('partner-launch-ui.mjs'))
})
