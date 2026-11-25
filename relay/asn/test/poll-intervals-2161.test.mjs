// #2161 3a：launchers 與 acct_switch_pending 兩項前端輪詢降頻的守門測試
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import * as lp from '../ui/lib/launcher-poll.mjs'

const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
const denied = new Error('launchers HTTP 403 forbidden')

test('常數：列表 60 秒、追進度 15 秒、帳號切換請求 60 秒、門鈴節流 5 秒', () => {
  assert.equal(lp.LAUNCHERS_LIST_POLL_MS, 60_000)
  assert.equal(lp.LAUNCH_TRACK_POLL_MS, 15_000)
  assert.equal(lp.ACCT_INCOMING_POLL_MS, 60_000)
  assert.equal(lp.BELL_REFRESH_MIN_GAP_MS, 30_000)
  assert.equal(lp.LAUNCHERS_POLL_MAX_MS, 300_000)
  assert.equal(lp.LAUNCHERS_POLL_MS, undefined, '舊的單一常數已拆掉，避免兩種用途又共用一個數字')
})

test('nextLaunchersDelay 以 60 秒為基準：成功回 60 秒，被擋加倍到 300 秒封頂', () => {
  assert.equal(lp.nextLaunchersDelay(60_000, null), 60_000)
  assert.equal(lp.nextLaunchersDelay(300_000, new Error('連線失敗')), 60_000)
  let d = 60_000
  const seen = []
  for (let i = 0; i < 5; i++) { d = lp.nextLaunchersDelay(d, denied); seen.push(d) }
  assert.deepEqual(seen, [120_000, 240_000, 300_000, 300_000, 300_000])
  assert.equal(lp.nextLaunchersDelay(undefined, denied), 120_000)
})

test('shouldRefreshOnBell：30 秒內只觸發一次', () => {
  assert.equal(lp.shouldRefreshOnBell(0, 1_000), true, '從沒刷過')
  assert.equal(lp.shouldRefreshOnBell(10_000, 12_000), false)
  assert.equal(lp.shouldRefreshOnBell(10_000, 39_999), false)
  assert.equal(lp.shouldRefreshOnBell(10_000, 40_000), true)
  assert.equal(lp.shouldRefreshOnBell(10_000, 10_000), false, '同一瞬間連敲')
})

test('接線：launchersLoop 用列表常數、pollLaunchResults 用追進度常數、帳號請求用 ACCT_INCOMING_POLL_MS', () => {
  assert.match(js, /let launchersDelay = LAUNCHERS_LIST_POLL_MS\b/)
  assert.ok(js.includes('setTimeout(() => void launchersLoop(), launchersDelay)'))
  assert.ok(js.includes('setInterval(() => void pollLaunchResults(), LAUNCH_TRACK_POLL_MS)'))
  assert.ok(js.includes('setInterval(() => void accounts.pollIncoming(), ACCT_INCOMING_POLL_MS)'))
  assert.ok(!js.includes('LAUNCHERS_POLL_MS'), '不再引用舊的單一常數')
})

test('接線：relay-bell 觸發 refreshLaunchers 必須經節流（shouldRefreshOnBell），且 pollIncoming 的門鈴保留', () => {
  const m = js.match(/function refreshLaunchersOnBell\(\) \{[\s\S]*?\n\}/)
  assert.ok(m, '有 refreshLaunchersOnBell')
  assert.ok(m[0].includes('shouldRefreshOnBell(launchersBellAt, now)') && m[0].includes('launchersBellAt = now') && m[0].includes('refreshLaunchers()'))
  assert.match(js, /core\.on\('relay-bell', p => \{[^\n]*refreshLaunchersOnBell\(\)/)
  // 反向斷言：先確認這行存在（上一條），否則「找不到就算通過」會假綠
  assert.ok(/core\.on\('relay-bell'/.test(js), '門鈴接收處必須存在，否則下面的反向斷言恆真')
  assert.ok(!/core\.on\('relay-bell'[^\n]*[^n]refreshLaunchers\(\)/.test(js), 'relay-bell 不能直接呼叫 refreshLaunchers')
  assert.ok(!/listen\('relay-bell'/.test(js), 'list.js 不再直接 listen relay-bell')
  assert.ok(js.includes("core.hub.on('relay-bell', () => void accounts.pollIncoming())"))
  assert.ok(js.includes('if (!info.shot) {\n      setInterval(() => void accounts.pollIncoming()') || /if \(!info\.shot\) \{\s*setInterval\(\(\) => void accounts\.pollIncoming/.test(js), '--shot 不輪詢')
  assert.ok(/void refreshLaunchers\(\)\.then\(\(\) => \{\s*if \(!partnerDlg\.open/.test(js), '開別台設備對話框的立即刷新保留')
})

test('list.js 沒有裸寫 15_000／15000 當輪詢間隔', () => {
  const bad = js.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\b15_?000\b/.test(l) && /setInterval|setTimeout/.test(l))
  assert.deepEqual(bad, [])
  // 以兩行視窗再掃一次（間隔寫在下一行的情況）
  const lines = js.split('\n')
  const bad2 = []
  lines.forEach((l, i) => { if (/\b15_?000\b/.test(l) && /setInterval\(|setTimeout\(/.test((lines[i - 1] ?? '') + l)) bad2.push(i + 1) })
  assert.deepEqual(bad2, [])
})
