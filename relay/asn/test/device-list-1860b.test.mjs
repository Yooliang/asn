// #1860 PR-B 設備清單：手機（沒有夥伴視窗）也有一列、「已移除的設備」一塊、報告重讀不打離線與背景
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { launchDeviceRows } from '../ui/lib/partner-launch-ui.mjs'
import { dateText, removedDevices } from '../ui/lib/device-known.mjs'
import { createReportScheduler, reportsDue } from '../ui/lib/report-reload.mjs'

const S = 'aaaaaaaa-0000-4000-8000-000000000001'   // 本機
const W = 'bbbbbbbb-0000-4000-8000-000000000002'   // 有夥伴視窗的電腦
const P = 'cccccccc-0000-4000-8000-000000000003'   // Oppo 手機：名單成員，沒有任何夥伴視窗
const fr = (node, device) => ({ node, device, agent: `a-${node.slice(0, 2)}`, engine: 'claude', status: 'online', kind: null, partnerId: 'eeeeeeee-0000-4000-8000-0000000000aa' })

test('Oppo 手機消失的原因：設備列只替有夥伴視窗的節點產生；名單成員沒有視窗也要有一列（withMembers）', () => {
  const friends = [fr(S, '家用機'), fr(W, '工作機')]
  const base = { selfNode: S, nodeOrder: [S, W, P], nodeNames: { [P]: 'Oppo' } }
  assert.deepEqual(launchDeviceRows(friends, base).map(r => r.key), [S, W], '舊行為：手機沒有那一列（開新夥伴的選單維持這樣）')
  const rows = launchDeviceRows(friends, { ...base, withMembers: true })
  assert.deepEqual(rows.map(r => r.key), [S, W, P])
  assert.equal(rows.find(r => r.key === P).label, 'Oppo')
  assert.deepEqual(launchDeviceRows(friends, { ...base, withMembers: true, removed: [P] }).map(r => r.key), [S, W], '永久移除的不出列')
})

test('設備樹：手機沒有夥伴視窗也有一列；沒有任何視窗不算「已隱藏」；離線寫「離線中」', () => {
  const tree = buildDeviceTree({ friends: [fr(S, '家用機'), fr(W, '工作機')], nodeOrder: [S, W, P], selfNode: S, nodeNames: { [P]: 'Oppo' } })
  const phone = tree.find(d => d.key === P)
  assert.ok(phone, '手機有一列')
  assert.equal(phone.label, 'Oppo')
  assert.equal(phone.removed, false)
  assert.equal(phone.hidden, false, '手機沒有視窗，不能因此被自動隱藏而又從清單消失')
  assert.equal(phone.online, false)
  assert.equal(phone.onlineText, '離線中')
})

test('已移除的設備：能恢復的給「恢復」、只剩紀錄的給「忘記」（只帶名稱與第一次連線日期）', () => {
  const rows = [{ key: S, label: '家用機', self: true }, { key: W, label: '工作機', removed: true }]
  const peers = [{ node: P, label: '舊手機', firstSeenMs: new Date(2026, 9, 5, 12).getTime(), fingerprint: 'SECRET' }]
  const r = removedDevices(rows, peers)
  assert.equal(r.count, 2)
  assert.deepEqual(r.items.map(i => [i.key, i.kind, i.firstSeen]), [[W, 'restore', ''], [P, 'forget', '2026/10/05']])
  assert.ok(!JSON.stringify(r.items.map(i => ({ ...i, peer: undefined }))).includes('SECRET'), '畫面用的欄位沒有指紋')
})

test('正在用的設備絕不進「已移除的設備」：節點在列上的紀錄、同名（重裝換了節點）的舊紀錄都不列；名單沒讀到時不列', () => {
  const rows = [{ key: S, label: '家用機', self: true }, { key: P, label: 'Oppo' }]
  const peers = [{ node: P, label: 'Oppo' }, { node: 'old-node', label: 'Oppo', firstSeenMs: 1 }, { node: 'x', label: '別台', firstSeenMs: 0 }]
  assert.deepEqual(removedDevices(rows, peers).items.map(i => i.key), ['x'])
  assert.equal(removedDevices([], peers).count, 0, '名單還沒讀到')
  assert.equal(removedDevices(rows, undefined).count, 0)
  assert.equal(dateText(0), '')
})

test('報告重讀：離線的設備讀過就不再排；沒讀過的離線設備讀一次；剛登入（force）也一樣', () => {
  const reports = { A: { readAt: 0 }, B: { error: 'x', failedAt: 0 }, C: { readAt: 0 } }
  const now = 3_600_000
  const online = n => n === 'C'
  assert.deepEqual(reportsDue({ nodes: ['A', 'B', 'C', 'D'], reports, now, isOnline: online }), ['C', 'D'])
  assert.deepEqual(reportsDue({ nodes: ['B'], reports, now, force: true, isOnline: online }), [])
  assert.deepEqual(reportsDue({ nodes: ['A', 'B'], reports, now }).sort(), ['A', 'B'], '沒傳 isOnline＝都當在線')
})

test('報告重讀排程：App 在背景不跑；回到前景立刻補一次；停掉就不再監看', async () => {
  let visible = false, handler = null, ticks = 0, unwatched = 0
  const s = createReportScheduler({ run: async () => { ticks++; return 1 }, setTimer: () => 1, clearTimer: () => {}, isVisible: () => visible, onVisibleChange: cb => { handler = cb; return () => { unwatched++ } } })
  s.start()
  await s.tick()
  assert.equal(ticks, 0, '背景不讀')
  visible = true
  handler()
  await new Promise(r => setImmediate(r))
  assert.equal(ticks, 1, '回到前景補一次')
  s.stop()
  assert.equal(unwatched, 1)
})
