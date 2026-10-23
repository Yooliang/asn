import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { BUDDY_CONSOLE_LABEL, CONSOLE_QUERY_TIMEOUT_MS, buddyConsoleItem, consoleToggleLabel, withTimeout,launchDeviceRows, launchDisableReason, remoteModelRows, showDisplayModeChoice } from '../ui/lib/partner-launch-ui.mjs'

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

test('右鍵選單的「背景／前台切換」：文字固定不隨狀態改字，檢查中或切不了就反灰，查到才可按', () => {
  assert.equal(BUDDY_CONSOLE_LABEL, '背景／前台切換')
  for (const state of ['checking', 'none']) assert.equal(buddyConsoleItem(state).label, '背景／前台切換', state)
  for (const state of ['checking', 'none']) assert.equal(buddyConsoleItem(state).disabled, true, state)
  assert.deepEqual(buddyConsoleItem('toggle'), { label: '背景／前台切換', disabled: false, tip: '' })
  assert.ok(!/無法切換|檢查中|切到背景|叫回前台/.test(JSON.stringify(['checking', 'none', 'toggle'].map(x => buddyConsoleItem(x).label))), '文字不隨狀態改字')
  // 反灰時滑鼠提示要說明原因：Rust 回的原因原樣顯示，沒有就用預設說明
  const why = '這個視窗開在 Windows Terminal 的分頁裡，不能切換'
  assert.equal(buddyConsoleItem('none', why).tip, why)
  assert.match(buddyConsoleItem('none').tip, /找不到/)
  assert.equal(buddyConsoleItem('toggle', why).tip, '', '能按的時候不放提示')
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(html, /:disabled="buddyConsoleItemView.disabled"[^>]*>{{ buddyConsoleItemView.label }}/, '選單項目沒有 v-if（不隱藏）')
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

test('別台設備的模型列：用它回報的 profile 與標籤，不看本機偵測；沒有回報就是空的', () => {
  const rows = remoteModelRows({ profiles: [{ id: 'claude', label: 'Claude（互動視窗）' }, { id: 'default', label: '一般（含 Chrome）' }, { id: '', label: 'x' }, null], cwd_allow: ['D:\a'], max_per_hour: 6 })
  assert.deepEqual(rows.map(r => [r.profileId, r.label, r.installed]), [['claude', 'Claude（互動視窗）', true], ['default', '一般（含 Chrome）', true]])
  assert.equal(rows[0].id, 'claude', '認得的 profile 沿用圖示代號')
  assert.equal(rows[1].modeLabel, '會開一個視窗')
  assert.deepEqual(remoteModelRows(null), [])
  assert.deepEqual(remoteModelRows({ profiles: 'x' }), [])
  assert.equal(remoteModelRows({ profiles: [{ id: 'gemini' }] })[0].label, 'Gemini', '沒給標籤用目錄上的名字')
})

test('開新夥伴對話框：模型列依設備切換（本機偵測／別台回報），並在開啟時重抓別台的設定', () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(html, /v-for="m in dlgModels"/)
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /remoteModelRows\(remoteLaunchers\.value\[partnerDlg\.node\]\)/)
  assert.match(js, /void refreshLaunchers\(\)\.then\(/)
})

test('右鍵選單反灰時把原因接到滑鼠提示（list.js 存 reason、list.html 綁 title）', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(js, /buddyConsole\.reason = String\(q\?\.reason/)
  assert.match(js, /buddyConsoleItem\(buddyConsole\.state, buddyConsole\.reason\)/)
  assert.match(html, /:title="buddyConsoleItemView\.tip"/)
})
