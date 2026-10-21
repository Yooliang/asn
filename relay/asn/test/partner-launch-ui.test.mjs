import assert from 'node:assert/strict'
import test from 'node:test'
import { consoleToggleLabel, launchDeviceRows, launchDisableReason, showDisplayModeChoice } from '../ui/lib/partner-launch-ui.mjs'

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
  assert.equal(consoleToggleLabel(true), '背景執行')
  assert.equal(consoleToggleLabel(false), '前台執行')
})

test('背景選項只給互動視窗 profile', () => {
  assert.equal(showDisplayModeChoice('claude'), true)
  assert.equal(showDisplayModeChoice('gemini'), false)
})
