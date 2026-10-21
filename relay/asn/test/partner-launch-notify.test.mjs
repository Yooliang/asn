import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKGROUND_LAUNCH_TIMEOUT_MS,
  backgroundRestoreNoticeText,
  collectLaunchFailures,
  findBackgroundTimeouts,
  launchFailedNoticeText,
} from '../ui/lib/partner-launch-notify.mjs'

test('背景逾時通知文案', () => {
  const n = backgroundRestoreNoticeText('夥伴-3')
  assert.equal(n.title, '已改為前台顯示')
  assert.match(n.body, /夥伴-3/)
  assert.match(n.body, /信任此資料夾/)
  assert.match(n.body, /記錄檔/)
})

test('遠端啟動失敗通知文案', () => {
  const n = launchFailedNoticeText('小幫手', '工作資料夾不在允許清單')
  assert.equal(n.title, '開新夥伴失敗')
  assert.match(n.body, /小幫手/)
  assert.match(n.body, /不在允許清單/)
})

test('findBackgroundTimeouts：只挑本機背景且逾時', () => {
  const now = 100_000
  const pOk = { launchDisplay: 'background', node: 'H', launchSince: now - 10_000, trustRestored: false }
  const pLate = { launchDisplay: 'background', node: 'H', launchSince: now - BACKGROUND_LAUNCH_TIMEOUT_MS - 1, trustRestored: false }
  const pFg = { launchDisplay: 'foreground', node: 'H', launchSince: now - 60_000, trustRestored: false }
  const pRemote = { launchDisplay: 'background', node: 'W', launchSince: now - 60_000, trustRestored: false }
  const pending = [pOk, pLate, pFg, pRemote]
  const still = [pOk, pLate, pFg, pRemote]
  const hit = findBackgroundTimeouts(pending, still, now, 'H')
  assert.deepEqual(hit, [pLate])
})

test('collectLaunchFailures：對照追蹤列的名字', () => {
  const track = [{ id: 'a', name: '夥伴-1', node: 'W' }]
  const fails = collectLaunchFailures([
    { id: 'a', status: 'failed', detail: '逾時' },
    { id: 'b', status: 'ok' },
  ], track)
  assert.deepEqual(fails, [{ id: 'a', name: '夥伴-1', detail: '逾時' }])
})
