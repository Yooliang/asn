// 名單設備右鍵「切換這台的 Claude 帳號」專屬對話框：標題寫清對象、顯示狀態、能不能切換；並守住接線。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLOSE_NOTE, CONFIRM_NOTE, dialogTitle, dialogView } from '../ui/lib/device-acct-dialog.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const NOW = Date.parse('2026-10-23T10:00:00Z')
const remote = (o = {}) => ({ node: 'n1', asnOnline: true, loading: false, busy: false, msg: '', reportedAt: '2026-10-23T09:30:00Z', list: [{ email: 'a@x.test', plan: 'max', current: true }, { email: 'b@x.test', plan: 'pro', current: false }], ...o })

test('標題寫明對象設備', () => {
  assert.equal(dialogTitle('啟良的工作機'), '切換「啟良的工作機」的 Claude 帳號')
})

test('顯示目前帳號、最後回報時間、是否在線', () => {
  const v = dialogView(remote(), '', NOW)
  assert.equal(v.currentText, '目前使用：a@x.test')
  assert.equal(v.reportedText, '最後回報：30 分鐘前')
  assert.equal(v.onlineText, '那台電腦的 ASN 在線')
  assert.equal(v.canSwitch, false)   // 還沒選
})

test('選了非使用中的帳號且在線才能切換；選到使用中的不行', () => {
  assert.equal(dialogView(remote(), 'b@x.test', NOW).canSwitch, true)
  assert.equal(dialogView(remote(), 'b@x.test', NOW).switchEmail, 'b@x.test')
  assert.equal(dialogView(remote(), 'a@x.test', NOW).canSwitch, false)
  assert.equal(dialogView(remote({ asnOnline: false }), 'b@x.test', NOW).canSwitch, false)
  assert.equal(dialogView(remote({ busy: true }), 'b@x.test', NOW).canSwitch, false)
})

test('離線與沒回報時的文字；狀態文字沿用 remote.msg', () => {
  const v = dialogView(remote({ asnOnline: false, reportedAt: '', list: [], msg: '對方電腦的 ASN 目前沒有在線，無法切換。' }), '', NOW)
  assert.equal(v.onlineText, '那台電腦的 ASN 目前沒有在線')
  assert.equal(v.reportedText, '最後回報：（沒有紀錄）')
  assert.equal(v.currentText, '目前使用：（那台沒有回報）')
  assert.equal(v.status, '對方電腦的 ASN 目前沒有在線，無法切換。')
})

test('說明文字講清楚對方會跳出確認', () => {
  assert.match(CONFIRM_NOTE, /跳出確認/)
  assert.match(CONFIRM_NOTE, /信任/)
  assert.match(CLOSE_NOTE, /重開/)
})

test('接線：右鍵項目打開專屬對話框，不再打開設定頁；切換走原本的 remoteSwitch', () => {
  const js = read('ui/list.js'), html = read('ui/list.html')
  const fn = js.slice(js.indexOf('const deviceMenuSwitch'), js.indexOf('const installFromSettings'))
  assert.ok(fn.includes('deviceAcct.node = node'), '右鍵要設定對話框對象')
  assert.ok(fn.includes('accounts.remoteSelect(node)'), '要沿用 remoteSelect 載入清單')
  assert.ok(!fn.includes("openPanel('setting'"), '不可再打開整個設定頁')
  assert.ok(fn.includes('accounts.remoteSwitch(v.switchEmail)'), '送出要沿用 remoteSwitch')
  assert.ok(html.includes('<asn-dialog v-if="deviceAcct.node" :title="deviceAcctTitleText"'))
  assert.ok(html.includes('@click="deviceAcctSubmit"'))
})
