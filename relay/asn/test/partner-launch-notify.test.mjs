import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKGROUND_LAUNCH_TIMEOUT_MS,
  backgroundRestoreNoticeText,
  collectLaunchFailures,
  existingPartnerNoticeText,
  findBackgroundTimeouts,
  launchFailedNoticeText,
  pickLaunchedTerm,
  screenShowsTrustPrompt,
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

test('同名夥伴已在跑的通知文案', () => {
  const ok = existingPartnerNoticeText('B4正式')
  assert.equal(ok.title, '夥伴已在跑')
  assert.equal(ok.body, '「B4正式」已經在跑，已切到前景。')
  const bad = existingPartnerNoticeText('B4正式', '找不到這個夥伴的主控台視窗')
  assert.match(bad.body, /沒有另外開新的/)
  assert.match(bad.body, /找不到這個夥伴的主控台視窗/)
})

test('同名夥伴已在跑：填了開場訊息要說沒送出', () => {
  const n = existingPartnerNoticeText('B4正式', '', true)
  assert.match(n.body, /已切到前景/)
  assert.match(n.body, /開場訊息沒有送出/)
  assert.doesNotMatch(existingPartnerNoticeText('B4正式').body, /開場訊息/)
})

test('#884 畫面真的有信任框文字：判卡住', () => {
  const trust = [
    ' Do you trust the files in this folder?',
    ' D:\\work\\proj',
    '',
    ' ❯ 1. Yes, proceed',
    '   2. No, exit',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')
  assert.equal(screenShowsTrustPrompt(trust), true)
})

test('#884 剛開畫面為空、只有輸入框、對話中提到信任字樣：都不判卡住', () => {
  assert.equal(screenShowsTrustPrompt(''), false)
  assert.equal(screenShowsTrustPrompt(undefined), false)
  assert.equal(screenShowsTrustPrompt('\n\n   \n'), false)
  const inputBox = ['╭──────────────────────╮', '│ >                    │', '╰──────────────────────╯', '  ? for shortcuts'].join('\n')
  assert.equal(screenShowsTrustPrompt(inputBox), false)
  assert.equal(screenShowsTrustPrompt('這是一段要求信任此資料夾的提示，我沒有回應它。'), false)
})

test('#884 pickLaunchedTerm：只挑同資料夾、開窗後才出現的終端，找不到回 null', () => {
  const pend = { cwd: 'D:\\work\\proj', launchProfile: 'claude', launchSince: 100_000 }
  const old = { id: 'a', profile: 'claude', cwd: 'D:\\work\\proj', started_ms: 50_000 }
  const other = { id: 'b', profile: 'claude', cwd: 'D:\\other', started_ms: 100_500 }
  const hit = { id: 'c', profile: 'claude', cwd: 'd:/work/proj/', started_ms: 100_500 }
  assert.equal(pickLaunchedTerm([old, other, hit], pend)?.id, 'c')
  assert.equal(pickLaunchedTerm([old, other], pend), null)
  assert.equal(pickLaunchedTerm([], pend), null)
  assert.equal(pickLaunchedTerm([hit], { ...pend, cwd: '' }), null)
})
