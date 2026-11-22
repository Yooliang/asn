// 設定頁 Claude 外掛一行狀態（#1548 第 2 張）：每個 state 對應的白話、沒有版本不出現 vundefined、設定頁不再有打勾框
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MOD_LINES, modStatusLine } from '../ui/lib/mod-line.mjs'

const STATES = ['installed', 'checking', 'no_claude', 'removed', 'failed', 'update_failed']

test('每個 Rust 會回報的 state 都有白話（對照表缺一個就紅）', () => {
  assert.deepEqual(Object.keys(MOD_LINES).sort(), [...STATES].sort())
  const rs = fs.readFileSync(new URL('../src-tauri/src/claude_mod.rs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')   // checking 是 lib.rs 啟動時寫的
  for (const st of STATES) assert.ok(rs.includes(`"state": "${st}"`), `Rust 沒有回報 ${st}`)
  for (const st of STATES) assert.notEqual(modStatusLine({ state: st, version: '1.2.3' }), '', st)
})

test('各 state 的畫面文字', () => {
  assert.equal(modStatusLine({ state: 'installed', version: '1.2.3' }), '已安裝 v1.2.3，ASN 更新時會一起更新')
  assert.equal(modStatusLine({ state: 'installed', version: 'v1.2.3' }), '已安裝 v1.2.3，ASN 更新時會一起更新', '版本已帶 v 不重複')
  assert.equal(modStatusLine({ state: 'checking' }), '正在檢查…')
  assert.equal(modStatusLine({ state: 'no_claude' }), '這台電腦沒有 Claude，裝好 Claude 後重新開啟 ASN 會自動安裝')
  assert.equal(modStatusLine({ state: 'removed' }), '外掛已被移除，ASN 不會自動重裝')
  assert.equal(modStatusLine({ state: 'failed', reason: 'spawn ENOENT' }), '安裝沒有成功，重新開啟 ASN 會再試一次')
  assert.equal(modStatusLine({ state: 'update_failed', reason: 'x' }), '更新沒有成功，重新開啟 ASN 會再試一次')
})

test('沒有版本不出現 vundefined／vnull；原因原文不外露；沒回報或認不得＝不顯示', () => {
  for (const version of [undefined, null, '', '  ']) {
    const t = modStatusLine({ state: 'installed', version })
    assert.equal(t, '已安裝，ASN 更新時會一起更新')
    assert.doesNotMatch(t, /undefined|null/)
  }
  assert.doesNotMatch(modStatusLine({ state: 'failed', reason: 'ENOENT boom' }), /ENOENT|boom/)
  for (const bad of [null, undefined, '', 5, {}, { state: 'weird' }]) assert.equal(modStatusLine(bad), '')
})

test('每一行都不是疑問句、不含工程字眼', () => {
  for (const st of STATES) {
    const t = modStatusLine({ state: st, version: '1.0.0' })
    assert.doesNotMatch(t, /[？?]/)
    assert.doesNotMatch(t, /marker|plugin|marketplace|claude-mod|spawn/i)
  }
})

test('設定頁：Claude 外掛區塊沒有打勾框、打勾框的指令與設定都拿掉了', () => {
  const sp = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  const a = sp.indexOf('aria-label="Claude 外掛"')
  assert.ok(a > 0)
  const block = sp.slice(a, sp.indexOf('</section>', a))
  assert.doesNotMatch(block, /checkbox|<label/)
  assert.match(block, /modLine\(st\.accounts && st\.accounts\.mod\)/)
  assert.doesNotMatch(sp, /claudeModAuto|自動安裝或更新 Claude 外掛/)
  const rs = fs.readFileSync(new URL('../src-tauri/src/claude_mod.rs', import.meta.url), 'utf8')
  assert.doesNotMatch(rs, /claude_mod_auto_|claude-mod-auto|fn auto_on|fn set_auto/)
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.doesNotMatch(list, /claudeModAuto|claude_mod_auto/)
})
