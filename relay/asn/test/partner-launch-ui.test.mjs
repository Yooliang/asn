import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CONSOLE_QUERY_TIMEOUT_MS, buddyConsoleItem, consoleToggleLabel, withTimeout,launchDeviceRows, launchDisableReason, showDisplayModeChoice } from '../ui/lib/partner-launch-ui.mjs'

test('設備選單：本機排第一', () => {
  const rows = launchDeviceRows(
    [{ node: 'W', device: '工作機' }, { node: 'H', device: '家用' }],
    { selfNode: 'H', nodeOrder: ['W', 'H'] },
  )
  assert.deepEqual(rows.map(r => r.key), ['H', 'W'])
})

test('無法開啟時有繁中原因', () => {
  assert.match(launchDisableReason('H', { selfNode: 'H', partnerModels: [{ installed: false }], remoteLaunchers: {} }), /尚未偵測/)
  assert.match(launchDisableReason('W', { selfNode: 'H', partnerModels: [], remoteLaunchers: {} }), /尚未回報/)
  assert.equal(launchDisableReason('H', { selfNode: 'H', partnerModels: [{ installed: true }], remoteLaunchers: {} }), '')
})

test('主控台選單文字顯示相反狀態', () => {
  assert.equal(consoleToggleLabel(true), '切到背景')
  assert.equal(consoleToggleLabel(false), '叫回前台')
})

test('右鍵選單的切換項目：檢查中與查不到都停用，查到才可按', () => {
  assert.deepEqual(buddyConsoleItem('checking', true), { label: '檢查中…', disabled: true })
  assert.deepEqual(buddyConsoleItem('none', true), { label: '這個視窗無法切換', disabled: true })
  assert.deepEqual(buddyConsoleItem('toggle', true), { label: '切到背景', disabled: false })
  assert.deepEqual(buddyConsoleItem('toggle', false), { label: '叫回前台', disabled: false })
})

test('名單右鍵選單的固定項目不依賴查詢結果，而且查詢有逾時', () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const menu = html.slice(html.indexOf('class="av-menu buddy-menu"'), html.indexOf('class="av-menu launch-picker"'))
  const openChat = menu.split('\n').find(l => l.includes('開啟對話'))
  assert.ok(openChat && !/v-if/.test(openChat), '「開啟對話」是固定項目，不能掛 v-if')
  assert.ok(!/<ul[^>]*v-if=[^>]*buddyConsole/.test(menu), '選單本身不能等主控台查詢')
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /withTimeout\(transport\.partnerConsoleQuery\(/, '查詢要包 withTimeout')
})

test('查詢逾時或失敗都回 null，不卡住', async () => {
  const t0 = Date.now()
  assert.equal(await withTimeout(new Promise(() => {}), 80), null)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(await withTimeout(Promise.reject(new Error('x')), 500), null)
  assert.deepEqual(await withTimeout(Promise.resolve({ ok: 1 }), 500), { ok: 1 })
  assert.ok(CONSOLE_QUERY_TIMEOUT_MS <= 2000)
})

test('背景選項只給互動視窗 profile', () => {
  assert.equal(showDisplayModeChoice('claude'), true)
  assert.equal(showDisplayModeChoice('gemini'), false)
})
