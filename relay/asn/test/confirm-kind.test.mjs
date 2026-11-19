// 看別台終端時標出「這是哪一種確認」（#1637）：只做顯示，用 Rust 端同一批畫面檔驗證；認不出就不標；不新增任何送鍵的路
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as CK from '../ui/lib/confirm-kind.mjs'
import { CONFIRM_KEYWORDS, confirmKindOf, confirmNoteOf } from '../ui/lib/confirm-kind.mjs'
import { STUCK_NOTES } from '../ui/lib/term-entry.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const screen = f => read('src-tauri', 'tests', 'fixtures', ...f.split('/'))

test('信任資料夾：真實畫面（游標在 No 或在 Yes）都認得，說明沿用 #1632 的字', () => {
  assert.equal(confirmKindOf(screen('term-screens/claude-trust-folder.txt')), 'trust')
  assert.equal(confirmKindOf(screen('term-screens/claude-trust-folder-yes-selected.txt')), 'trust')
  assert.equal(confirmNoteOf('trust'), STUCK_NOTES.trust)
  assert.match(confirmNoteOf('trust'), /Yes, I trust this folder/)
})

test('略過權限：Rust 測試用的畫面（字取自執行檔、版面是仿的）認得；說明寫明不同意選「No, exit」', () => {
  assert.equal(confirmKindOf(screen('term-screens/claude-bypass-warning.synthetic.txt')), 'bypass_warning')
  assert.equal(confirmNoteOf('bypass_warning'), STUCK_NOTES.bypass_warning)
  assert.match(confirmNoteOf('bypass_warning'), /Yes, I accept/)
  assert.match(confirmNoteOf('bypass_warning'), /No, exit/)
})

test('認不出就不標：對話裡貼到同樣的字、選項多一個或少一個、別的畫面、空畫面', () => {
  for (const f of [
    'term-screens/claude-lookalike-model-text.txt', 'term-screens/claude-lookalike-tool-output.txt',
    'trust-negative/claude-safety-check-one-option.txt', 'trust-negative/claude-safety-check-three-options.txt',
    'term-screens/claude-firstrun-theme.txt', 'term-screens/claude-permission-bash.txt', 'term-screens/claude-idle-manual-mode.txt',
    'term-screens/claude-limit-menu.real.txt', 'term-screens/claude-login-method.txt', 'term-screens/claude-running.txt',
  ]) assert.equal(confirmKindOf(screen(f)), '', f)
  for (const t of ['', null, undefined, '一般的訊息']) assert.equal(confirmKindOf(t), '')
  assert.equal(confirmNoteOf(''), '')
  assert.equal(confirmNoteOf('login'), '', '別的種類不給說明')
})

test('手機窄畫面：折行、列首空白不影響；頁尾後面還有東西就不算', () => {
  const trust = screen('term-screens/claude-trust-folder.txt')
  assert.equal(confirmKindOf(trust.split('\n').map(r => '  ' + r).join('\n')), 'trust', '縮排不影響')
  assert.equal(confirmKindOf(trust + '\n❯ hello'), '', '後面又有輸入框＝已經不是確認畫面')
})

test('關鍵字和 Rust 端 claude_screen.rs 一致（兩邊各寫一份，改一邊要改另一邊）', () => {
  const rs = read('src-tauri', 'src', 'launch', 'claude_screen.rs')
  for (const s of [CONFIRM_KEYWORDS.trust.question, ...CONFIRM_KEYWORDS.trust.options, CONFIRM_KEYWORDS.bypass.question, ...CONFIRM_KEYWORDS.bypass.options, CONFIRM_KEYWORDS.footer]) assert.ok(rs.includes(s), s)
})

test('只做顯示、不代按：這個模組沒有任何送鍵／呼叫後台的字；聊天頁只把它算成說明字', () => {
  const mod = read('ui', 'lib', 'confirm-kind.mjs')
  assert.doesNotMatch(mod.replace(/\/\/.*$/gm, ''), /invoke|sendKey|sendLine|remoteInputApi|fetch\(/)
  const cp = read('ui', 'lib', 'chatpane.mjs')
  assert.match(cp, /const confirmNote = computed\(\(\) => \(remoteShown\.value \? confirmNoteOf\(confirmKindOf\(screenPlain\.value\)\) : ''\)\)/)
  assert.match(cp, /v-if="confirmNote" role="note">\{\{ confirmNote \}\}<\/p>/)
})

test('不再有「那台需要先設免問／有人按允許」的提醒（0.2.33 起遠端打字沒有確認框，這句只用在遠端打字等待，沒有別的用途）', () => {
  assert.equal(CK.AWAITING_CONSENT_HINT, undefined)
  const cp = read('ui', 'lib', 'chatpane.mjs')
  assert.ok(!cp.includes('consentHint') && !cp.includes('AWAITING_CONSENT_HINT'))
})
