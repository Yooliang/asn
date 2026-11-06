// #904：ASN 直接開的終端分頁直接在畫面打字（term-view），不再有舊輸入框；接手來的窗格保留舊輸入框；上方掛和夥伴對話同一排功能列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAR_KEYS, barSlots } from '../ui/lib/actionbar.mjs'
import { TERM_BAR_WHY, termFriends } from '../ui/lib/term-chat.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const html = read('ui/list.html')
const pane = html.slice(html.indexOf('<div class="pane term-pane"'), html.indexOf('<!-- 指引、設定的聊天窗'))
const compose = pane.slice(pane.indexOf('<div class="tp-compose"'))

test('終端分頁：自己開的分頁有 term-view，舊輸入框只在接手來的窗格出現', () => {
  assert.ok(pane.includes('<term-view v-if="!termPaneRow.adopted"'), '自己開的分頁直接打字')
  assert.ok(compose.startsWith('<div class="tp-compose" v-if="termPaneRow.adopted"'), '舊輸入框只給接手窗格')
  assert.ok(compose.includes('要送進這個終端的文字') && compose.includes('改用手機確認') && compose.includes('adoptUnlockAsk'), '接手窗格的輸入框、手機確認、解鎖都在')
  assert.equal((pane.match(/要送進這個終端的文字/g) ?? []).length, 1, '整個分頁只有一個舊輸入框')
  assert.ok(!pane.slice(0, pane.indexOf('<div class="tp-compose"')).includes('要送進這個終端的文字'), '輸入框之外沒有第二份')
})

test('終端分頁：自己開的分頁讓 term-view 占滿剩餘高度', () => {
  const css = read('ui/style.css')
  assert.ok(pane.includes(`'term-pane-live': !termPaneRow.adopted`))
  assert.match(css, /\.term-pane-live \.tp-body\{[^}]*overflow:hidden/)
  assert.match(css, /\.term-pane-live \.tp-body \.term-view\{[^}]*flex:1 1 0/)
})

test('終端分頁：上方掛和夥伴對話同一個功能列，格子一律反灰並有說明', () => {
  assert.ok(pane.includes('<action-bar') && pane.includes(':blocked="termBarBlocked"'))
  assert.match(read('ui/list.js'), /app\.component\('action-bar', ActionBar\)/)
  const f = termFriends([{ id: '4', profile: 'agy', title: 'agy #4', folder: 'proj', state: 'idle' }], { selfNode: 'H' })[0]
  const slots = barSlots(f, { selfNode: 'H', api: true }).map(s => (TERM_BAR_WHY[s.key] ? { ...s, ok: false, reason: TERM_BAR_WHY[s.key] } : s))
  assert.deepEqual(slots.map(s => s.key), BAR_KEYS, '固定 6 格')
  for (const s of slots) { assert.equal(s.ok, false, s.key); assert.match(s.reason, /[一-鿿]/, s.key) }
  assert.deepEqual(Object.keys(TERM_BAR_WHY).sort(), [...BAR_KEYS].sort())
  assert.match(TERM_BAR_WHY.call, /不支援通話/)
  const bar = read('ui/lib/actionbar.mjs')
  assert.ok(bar.includes('props.blocked?.[s.key]') && bar.includes('lite.value'), '簡版不向後端查詢')
})
