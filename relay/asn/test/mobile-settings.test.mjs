// 手機「設置」分類列表（#262，對應電腦版 #67）：分類、摘要文字、導覽狀態。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOBILE_SETTING_KEYS, SETTING_SHEET_KEYS, mobileCatSummary, mobileSettingRows, mobileSettingTitle } from '../ui/lib/mobile-settings.mjs'
import { settingPage } from '../ui/lib/mobile-fourth.mjs'
import { readFileSync } from 'node:fs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { normalizeNav, pageNav, tabNav } from '../ui/lib/mobile.mjs'

test('分類：只放手機有的設定，鍵、名稱、圖示都沿用電腦版的分類定義', () => {
  assert.deepEqual(MOBILE_SETTING_KEYS, ['me', 'devices', 'notify', 'update', 'about'])   // #268：補上設備與帳號，順序與電腦版一致
  assert.deepEqual(SETTING_SHEET_KEYS, ['me', 'notify', 'update', 'about'])
  const rows = mobileSettingRows({})
  assert.deepEqual(rows.map(r => r.key), MOBILE_SETTING_KEYS)
  for (const r of rows) {
    const c = SETTING_CATS.find(x => x.key === r.key)
    assert.ok(c, `${r.key} 不在電腦版分類裡`)
    assert.equal(r.title, c.title); assert.equal(r.icon, c.icon)
    assert.ok(r.icon.length > 0)
  }
  assert.equal(mobileSettingTitle('notify'), '通知')
  assert.equal(mobileSettingTitle('nope'), '')
})

test('摘要：每列一行目前值；欄位缺少不丟錯', () => {
  assert.equal(mobileCatSummary('me', { name: '小良哥', hasUpload: true }), '小良哥、已上傳大頭貼')
  assert.equal(mobileCatSummary('me', { name: '  ', hasUpload: false }), '自動產生的大頭貼')
  assert.equal(mobileCatSummary('notify', { vibrateNudge: true, vibrateMsg: false }), '對方傳震動時震動：開、新訊息輕震：關')
  assert.equal(mobileCatSummary('update', { updateEnabled: true, autoUpdate: true }), '自動檢查：開')
  assert.equal(mobileCatSummary('update', { updateEnabled: true, autoUpdate: false }), '自動檢查：關')
  assert.equal(mobileCatSummary('update', { updateEnabled: false, autoUpdate: true }), '這個版本不提供自動檢查')
  assert.equal(mobileCatSummary('about', { version: '0.1.72' }), '版本 0.1.72')
  assert.equal(mobileCatSummary('about', {}), '版本')
  assert.equal(mobileCatSummary('devices', { devices: [{ online: true }, { online: false }, { online: true }] }), '3 台設備，2 台在線')
  assert.equal(mobileCatSummary('devices', {}), '還沒有設備')
  assert.equal(mobileCatSummary('nope', {}), '')
  for (const r of mobileSettingRows()) assert.equal(typeof r.summary, 'string')
})

test('導覽：分類頁是第四頁籤上的一頁（#461）；沒有的分類、壞資料退回設置分頁', () => {
  assert.deepEqual(settingPage('update'), { kind: 'setting', cat: 'update' })
  assert.equal(settingPage('nope'), null)
  assert.deepEqual(normalizeNav({ sheet: 'setting', cat: 'about' }), pageNav(settingPage('about')), '舊的滿版層記錄轉成第四頁籤')
  for (const bad of [{ sheet: 'setting' }, { sheet: 'setting', cat: 'devices' }, { sheet: 'setting', cat: 5 }]) assert.deepEqual(normalizeNav(bad), tabNav('me'), JSON.stringify(bad))
})

test('設備與帳號（#268）：設置列表點了開名單設備卡「選項」的同一頁，不是設置的滿版頁；兩個入口並存', () => {
  assert.equal(settingPage('devices'), null, '沒有設置的一般分類頁')
  const js = readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(js, /const openSetting = key => \{ if \(key === 'devices'\) void openAcct\(\); else fourthNav\.openPage\(settingPage\(key\)\) \}/)
  assert.match(js, /devices: acctDevs\.value \}\)\)/, '摘要用同一份設備列表')
  assert.match(js, /tabLabelOf\(t, fourthTitle\.value\)/, '第四頁籤的標籤跟頁標題一致')
  const html = readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8')
  assert.match(html, /@click="openAcct\(g\)"/, '設備卡的入口還在')
})
