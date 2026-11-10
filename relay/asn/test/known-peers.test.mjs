import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEXT, errorText, normalizeView } from '../ui/lib/known-peers.mjs'

test('認得的電腦：欄位壞的丟掉，名字清掉控制字元', () => {
  const v = normalizeView({ peers: [
    { node: 'hom7a1', name: '家用‮機', fingerprint: '0123456789abcdef', first_seen_ms: 1_800_000_000_000 },
    { node: '', name: 'x' }, { name: '沒節點' }, null,
    { node: 'wrk9b2', name: '', fingerprint: 'ff', first_seen_ms: 'x' },
  ] })
  assert.equal(v.peers.length, 2)
  assert.equal(v.peers[0].name, '家用 機')
  assert.ok(v.peers[0].firstSeen)
  assert.equal(v.peers[1].name, '', '本機記的名字是空的')
  assert.equal(v.peers[1].label, '未命名的電腦', '畫面上顯示未命名（指紋照樣顯示在旁邊）')
  assert.equal(v.peers[0].label, '家用 機')
  assert.equal(v.peers[1].firstSeen, '')
  assert.deepEqual(normalizeView(null), { peers: [] })
})

test('認得的電腦：只能看和忘記，錯誤不露出內部訊息', () => {
  assert.equal(TEXT.forget, '忘記這台')
  assert.equal(errorText(new Error('/home/x/device_known.json 讀不到')), '操作沒有成功，請稍後再試。')
  assert.equal(errorText('認得的電腦紀錄壞了'), '認得的電腦紀錄壞了，請告訴開發團隊。')
})

test('認得的電腦：改名的文字、名字最多 32 字；只有電腦版的 device_known_rename 與設定頁的 known-rename', async () => {
  assert.equal(TEXT.unnamed, '未命名的電腦')
  for (const k of ['rename', 'renameSave', 'renameCancel', 'renameLabel', 'renameHint']) assert.doesNotMatch(TEXT[k], /[A-Za-z]{3,}/, k)
  assert.equal(normalizeView({ peers: [{ node: 'a', name: '長'.repeat(60) }] }).peers[0].name.length, 32)
  const fs = await import('node:fs')
  const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const panel = read('../ui/lib/settings-panel.mjs')
  const card = panel.slice(panel.indexOf('aria-label="認得的電腦"'), panel.indexOf('KNOWN.forgetNote'))
  assert.doesNotMatch(card, /v-html/, '名字只當文字')
  assert.match(card, /<b>\{\{ p\.label \}\}<\/b>/)
  assert.match(card, /@click="renameStart\(p\)">\{\{ KNOWN\.rename \}\}/)
  assert.match(card, /v-model="renameText"/)
  const { SETTING_OPS } = await import('../ui/lib/settings-panel.mjs')
  assert.ok(SETTING_OPS.includes('known-rename'))
  const list = read('../ui/list.js')
  assert.match(list, /case 'known-rename': if \(value\?\.node\) await renameKnown\(value\.node, value\.name\)/)
  assert.match(list, /invoke\('device_known_rename', \{ node, name: String\(name \?\? ''\) \}\)/)
})
