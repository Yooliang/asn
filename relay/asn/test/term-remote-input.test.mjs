// 在別台電腦上夥伴的畫面打字（0.2.10）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { INPUT_TEXT, inputXtermOptions, pasteLines, sendError } from '../ui/lib/term-remote-input.mjs'
import { normalizeView, TEXT as KNOWN } from '../ui/lib/known-peers.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]))
const uiFiles = () => walk(new URL('../ui', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).filter(f => /\.(m?js|html)$/.test(f) && !f.includes('vendor'))

test('守門：送字的命令只在打字的 API；看畫面那份照舊沒有', () => {
  const api = read('../ui/lib/tauri.mjs')
  const view = api.split('export const remoteViewApi = {')[1].split('\n}')[0]
  assert.doesNotMatch(view, /input|send/, '看畫面的 API 沒有送字')
  const input = api.split('export const remoteInputApi = {')[1].split('\n}')[0]
  assert.match(input, /scope: 'input'/, '打字要明講範圍')
  assert.match(input, /invoke\('term_view_remote_input'/)
  for (const f of uiFiles()) {
    if (f.endsWith('tauri.mjs')) continue
    assert.ok(!fs.readFileSync(f, 'utf8').includes('term_view_remote_input'), f + ' 不能直接送字')
  }
})

test('守門：「打字不用每次問」只有設定頁那條路能改', () => {
  const hits = uiFiles().filter(f => fs.readFileSync(f, 'utf8').includes('device_known_input_no_ask'))
  assert.deepEqual(hits.map(f => f.split(/[\\/]/).pop()), ['list.js'])
  assert.ok(SETTING_OPS.includes('known-input-no-ask'))
  const lib = read('../src-tauri/src/lib.rs')
  assert.equal(lib.split('device_id::live::set_input_no_ask(').length - 1, 1, 'Rust 只有一個命令能改')
})

test('打字的畫面：只有這支有按鍵的路；xterm 不關輸入；看畫面那支照舊只能看', () => {
  const src = read('../ui/lib/term-remote-input.mjs')
  assert.match(src, /term\.onData\(d => send\(d, false\)\)/)
  assert.match(src, /new Terminal\(inputXtermOptions\(/)
  assert.equal(inputXtermOptions({ cols: 80, rows: 24 }).disableStdin, false)
  assert.ok(!read('../ui/lib/term-remote.mjs').includes('onData'), '看畫面那支沒有打字')
  assert.match(INPUT_TEXT.typing('家用機', '小乙'), /包括回答權限框/, '要寫清楚能做什麼')
})

test('多行貼上要先問；一行不用', () => {
  assert.equal(pasteLines('ls'), 1)
  assert.equal(pasteLines('ls\n'), 1, '結尾的換行不算一行')
  assert.equal(pasteLines('a\r\nb\nc'), 3)
  assert.equal(pasteLines(''), 0)
  assert.match(INPUT_TEXT.pasteAsk(3), /3 行/)
})

test('送不出去要說，不默默丟掉', () => {
  assert.equal(sendError(new Error('打太快了，請稍等一下再打')), INPUT_TEXT.sendFailed + '打太快了，請稍等一下再打')
  assert.equal(sendError(''), INPUT_TEXT.sendFailed + '請稍後再打')
})

test('認得的電腦：打字不用問只認 true，舊資料沒有這欄當要問', () => {
  const v = normalizeView({ peers: [{ node: 'a', name: 'A', input_no_ask: true }, { node: 'b', name: 'B', input_no_ask: 'yes' }, { node: 'c', name: 'C' }] })
  assert.deepEqual(v.peers.map(p => p.inputNoAsk), [true, false, false])
  assert.match(KNOWN.inputNoAskWarn, /紅條/)
})

test('被打字的紅條比被看醒目，而且寫可以回答權限框', () => {
  const html = read('../ui/list.html')
  assert.match(html, /'viewed-bar-input': v\.input/)
  assert.match(html, /正在這台的夥伴「\{\{ v\.window \}\}」打字，可以回答權限框/)
  assert.match(read('../ui/style.css'), /\.viewed-bar-input\{/)
})
