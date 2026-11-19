// 別台的開新夥伴列表不再冒出「Gemini（asn終端）」「Grok（asn終端）」兩顆獨立的項目
// 輸入是資料庫裡 30家用（H）實際存的啟動設定摘要的 profiles（2026-11-19 select，原封不動，後台把 mode 丟掉所以沒有 mode 欄位）；
// 資料夾白名單與 pi 模型清單有本機路徑，換成短的。以前的測試自己造帶 mode: 'term' 的假資料，沒經過後台那道過濾，所以沒抓到
import test from 'node:test'
import assert from 'node:assert/strict'
import { remoteModelRows, remoteTermProfile } from '../ui/lib/partner-launch-ui.mjs'
import { vendorProfilesOf } from '../ui/lib/device-tree.mjs'
import { isTermProfile } from '../ui/lib/model-catalog.mjs'

const STORED_H = {
  profiles: [
    { id: 'claude', label: 'Claude' },
    { id: 'default', label: '一般（含 Chrome）' },
    { id: 'gemini', label: 'Gemini' },
    { id: 'grok', label: 'Grok' },
    { id: 'pi', label: 'pi' },
    { id: 'gemini-term', label: 'Gemini（asn終端）' },
    { id: 'grok-term', label: 'Grok（asn終端）' },
  ],
  cwd_allow: ['D:\Github'], max_per_hour: 6,
}

test('#1752 真資料（沒有 mode 欄位）：asn終端的兩個虛擬項目不列成模型，Gemini、Grok 各只一顆', () => {
  const rows = remoteModelRows(STORED_H)
  const labels = rows.map(r => r.label)
  assert.deepEqual(labels, ['Claude', '一般（含 Chrome）', 'Gemini', 'Grok', 'pi'])
  assert.equal(rows.filter(r => /asn終端/.test(r.label) || /-term$/.test(r.profileId)).length, 0)
  assert.equal(rows.filter(r => r.label === 'Gemini').length, 1)
  assert.equal(rows.filter(r => r.label === 'Grok').length, 1)
})

test('真資料：設備頁的登入狀態也不把它們當成另外兩家 CLI', () => {
  assert.deepEqual(vendorProfilesOf(STORED_H).map(p => p.id), ['claude', 'default', 'gemini', 'grok', 'pi'])
})

test('真資料：選「asn終端（原生 cli）」時仍找得到 gemini-term／grok-term（舊資料沒有 mode 也行）', () => {
  assert.equal(remoteTermProfile(STORED_H, { id: 'gemini' }), 'gemini-term')
  assert.equal(remoteTermProfile(STORED_H, { id: 'grok' }), 'grok-term')
  assert.equal(remoteTermProfile(STORED_H, { id: 'claude' }), '', 'Claude 沒有 asn終端')
})

test('後台保留 mode 之後（新資料）同樣只剩一般項目；自訂項目 mode 照舊判斷', () => {
  const withMode = { ...STORED_H, profiles: STORED_H.profiles.map(p => (p.id.endsWith('-term') ? { ...p, mode: 'term' } : p)) }
  assert.deepEqual(remoteModelRows(withMode).map(r => r.label), ['Claude', '一般（含 Chrome）', 'Gemini', 'Grok', 'pi'])
  assert.equal(isTermProfile({ id: 'mine', mode: 'term' }), true)
  assert.equal(isTermProfile({ id: 'my-term', label: '自訂' }), false, '不是目錄上的廠牌 id，不亂濾')
  const custom = remoteModelRows({ profiles: [{ id: 'bg1', label: '背景自訂', mode: 'background' }] })
  assert.equal(custom[0].mode, 'background')
})
