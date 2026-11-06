import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  BACKGROUND_LAUNCH_TIMEOUT_MS,
  backgroundRestoreNoticeText,
  collectLaunchFailures,
  existingPartnerNoticeText,
  findBackgroundTimeouts,
  hasTrustNotice,
  launchFailedNoticeText,
  shouldRestoreForeground,
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

test('#884 hasTrustNotice：後端說這位在信任框才算；別的代號、別的名字、空的都不算', () => {
  assert.equal(hasTrustNotice([{ name: '墊底夥伴', code: 'trust' }], '墊底夥伴'), true)
  assert.equal(hasTrustNotice([{ name: '墊底夥伴', code: 'permission' }], '墊底夥伴'), false)
  assert.equal(hasTrustNotice([{ name: '別人', code: 'trust' }], '墊底夥伴'), false)
  assert.equal(hasTrustNotice([], '墊底夥伴'), false)
  assert.equal(hasTrustNotice(null, '墊底夥伴'), false)
  assert.equal(hasTrustNotice([{ name: '', code: 'trust' }], ''), false)
})

test('#884 shouldRestoreForeground：讀畫面關著照舊切；開著只有信任框代號才切', () => {
  const trust = [{ name: '墊底夥伴', code: 'trust' }]
  assert.equal(shouldRestoreForeground({ watching: false, alerts: [], name: '墊底夥伴' }), true)
  assert.equal(shouldRestoreForeground({ watching: undefined, alerts: [], name: '墊底夥伴' }), true)
  assert.equal(shouldRestoreForeground({ watching: true, alerts: trust, name: '墊底夥伴' }), true)
  assert.equal(shouldRestoreForeground({ watching: true, alerts: [], name: '墊底夥伴' }), false)
  assert.equal(shouldRestoreForeground({ watching: true, alerts: [{ name: '墊底夥伴', code: 'permission' }], name: '墊底夥伴' }), false)
  assert.equal(shouldRestoreForeground({ watching: true, alerts: trust, name: '別人' }), false)
})

test('#884 表格：非 Windows 設定頁開著但讀畫面沒在跑（partnerNoticesActive 為 false 或查不到）→ 照舊切前台', () => {
  // list.js 把 partnerNoticesActive 的結果當 watching；不是 true 一律 false，也不會去查 notices
  const asWatching = r => r === true
  const cases = [
    { name: '非 Windows 沒設環境變數（設定頁顯示開）', active: false, alerts: [], want: true },
    { name: '查詢丟錯', active: undefined, alerts: [], want: true },
    { name: 'Windows 預設跑著、沒看到信任框', active: true, alerts: [], want: false },
    { name: 'Windows 預設跑著、看到信任框', active: true, alerts: [{ name: '墊底夥伴', code: 'trust' }], want: true },
    { name: '使用者在設定頁關掉', active: false, alerts: [], want: true },
  ]
  for (const c of cases) {
    assert.equal(shouldRestoreForeground({ watching: asWatching(c.active), alerts: c.alerts, name: '墊底夥伴' }), c.want, c.name)
  }
})

test('#884 守門：逾時切前台之前一定經過 partnerNoticesActive 與 shouldRestoreForeground，不看設定頁的值，不另寫文字比對', () => {
  const src = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const at = src.indexOf('findBackgroundTimeouts(launchPending.value')
  assert.ok(at > 0, '找不到逾時處理')
  const seg = src.slice(at, at + 1800)
  const iW = seg.indexOf('transport.partnerNoticesActive()'), iN = seg.indexOf('transport.partnerNotices()'), iCheck = seg.indexOf('shouldRestoreForeground({'), iSet = seg.indexOf('transport.partnerConsoleSet')
  assert.ok(iW > 0 && iN > iW && iCheck > iN && iSet > iCheck, '順序：partnerNoticesActive → partnerNotices → shouldRestoreForeground → 切前台')
  assert.ok(!seg.includes('bridge.screenWatch'), '不能再用設定頁的值當依據')
  assert.ok(!/do you trust|trust this folder/i.test(seg), '不要在前端寫信任框文字比對')
})
