// 0.2 H2：開新夥伴精靈對沒開放的設備依它回報的內容說明——那台自己寫的原因 → Linux 的設定方法 → 原本的一般說法
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LINUX_CLOSED, closedReasonOf, launchDisableReason } from '../ui/lib/partner-launch-ui.mjs'
import { REASON, launchEligibility } from '../ui/lib/mobile-launch.mjs'

const ctx = machines => ({ machines, loaded: true, signedIn: true })

test('手機精靈：Linux 沒開放寫設定方法；那台寫了原因照它寫的；舊的機器橋（沒回報平台）照原本的說法', () => {
  assert.equal(launchEligibility('L', ctx({ L: { node: 'L', online: true, launcher: null, platform: 'linux' } })).reason, LINUX_CLOSED)
  assert.match(LINUX_CLOSED, /~\/\.asn\/launcher\.json/)
  assert.match(LINUX_CLOSED, /ASN_LAUNCH_AUTO=1/)
  assert.equal(launchEligibility('S', ctx({ S: { node: 'S', online: true, launcher: null, platform: 'linux', launch_closed_reason: '測試用伺服器，不開放' } })).reason, '這台設備不開放開新夥伴：測試用伺服器，不開放')
  assert.equal(launchEligibility('O', ctx({ O: { node: 'O', online: true, launcher: null } })).reason, REASON.closed, '舊的機器橋不帶平台：不能壞')
  assert.equal(launchEligibility('W', ctx({ W: { node: 'W', online: true, launcher: null, platform: 'windows' } })).reason, REASON.closed, 'Windows 有設定畫面，照原本的說法')
  assert.equal(launchEligibility('L', ctx({ L: { node: 'L', online: false, launcher: null, platform: 'linux' } })).reason, REASON.offline, '不在線先說不在線')
})

test('電腦精靈：同一套說明；有開放的照舊', () => {
  const base = { selfNode: 'me', partnerModels: [], remoteLaunchers: { A: { profiles: [{ id: 'claude' }] } } }
  assert.equal(launchDisableReason('A', base), '')
  assert.equal(launchDisableReason('L', { ...base, remoteMachines: { L: { platform: 'linux' } } }), LINUX_CLOSED)
  assert.equal(launchDisableReason('S', { ...base, remoteMachines: { S: { launch_closed_reason: '測試用伺服器' } } }), '這台設備不開放開新夥伴：測試用伺服器')
  assert.equal(launchDisableReason('X', base), '這台設備尚未回報啟動設定', '舊呼叫端沒給 remoteMachines 照舊')
})

test('那台寫的原因是外部資料：HTML 標籤照原樣當文字（不解析），控制字元換空白、最多 120 字；兩處畫面都用文字插值、不用 v-html', () => {
  assert.equal(closedReasonOf({ launch_closed_reason: '<img src=x onerror=alert(1)><b>粗</b>' }, 'x'), '這台設備不開放開新夥伴：<img src=x onerror=alert(1)><b>粗</b>')
  assert.equal(closedReasonOf({ launch_closed_reason: 'a\nb\u0007' }, 'x'), '這台設備不開放開新夥伴：a b')
  assert.equal([...closedReasonOf({ launch_closed_reason: '字'.repeat(300) }, 'x')].length, '這台設備不開放開新夥伴：'.length + 120)
  assert.equal(closedReasonOf({ launch_closed_reason: '   ' }, '一般'), '一般')
  const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
  assert.match(read('list.html'), /<small class="launch-why" v-if="launchDisableReason\(d\.key\)">\{\{ launchDisableReason\(d\.key\) \}\}<\/small>/)
  assert.match(read('m.html'), /<small class="m-opt-why" v-if="!d\.ok">\{\{ d\.reason \}\}<\/small>/)
  for (const f of ['list.html', 'm.html']) assert.doesNotMatch(read(f), /v-html="[^"]*(reason|Reason|why)/, f)
})
