// 允許這支手機替這台登入（#933）：只有這台的設定頁能改；記住公鑰不等於允許
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeView, TEXT as KNOWN } from '../ui/lib/known-peers.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]))
const uiFiles = () => walk(new URL('../ui', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).filter(f => /\.(m?js|html)$/.test(f) && !f.includes('vendor'))

test('守門：「允許替這台登入」只有設定頁那條路能改', () => {
  const hits = uiFiles().filter(f => fs.readFileSync(f, 'utf8').includes('device_known_login_ok'))
  assert.deepEqual(hits.map(f => f.split(/[\/]/).pop()), ['list.js'])
  assert.ok(SETTING_OPS.includes('known-login-ok'))
  const lib = read('../src-tauri/src/lib.rs')
  assert.equal(lib.split('device_id::live::set_login_ok(').length - 1, 2, 'Rust 只有一個命令能改（打開、關掉各一處）')
})

test('列表：只有明確的 true 才算允許；沒帶（舊版）就是不允許', () => {
  const v = normalizeView({ peers: [{ node: 'a', name: 'A', login_ok: true }, { node: 'b', name: 'B', login_ok: 'yes' }, { node: 'c', name: 'C' }] })
  assert.deepEqual(v.peers.map(p => p.loginOk), [true, false, false])
  assert.match(KNOWN.loginOk, /允許/)
  assert.match(KNOWN.loginOkWarn, /只勾你自己的手機/)
})

test('設定頁：勾選框在手機的詳情頁，送 known-login-ok（手機才能勾；已經勾過的不論哪一台都看得到、取消得掉）', () => {
  const src = read('../ui/lib/settings-panel.mjs')
  assert.match(src, /act\('known-login-ok', \{ node: curKnown\.id, on: \$event\.target\.checked \}\)/)
  assert.match(src, /<template v-if="curDev\.phone \|\| curKnown\.loginOk">\s*<label class="chk"><input type="checkbox" :checked="curKnown\.loginOk"/)
})

test('設定頁：按了勾選框先放回目前存的狀態，確認框按「先不要」後不會留著打勾（要按允許、重讀後才打勾）', () => {
  const src = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(src, /act\('known-login-ok', \{ node: p\.node, on: \$event\.target\.checked \}\); \$event\.target\.checked = p\.loginOk"/)
})
