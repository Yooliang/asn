// #956 本機看畫面打字的紀錄：前端只多帶「是不是輸入法組字」的旗標，內容照舊只送不記
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { IME_RECENT_MS, createTermViewSession, imeTracker } from '../ui/lib/term-view.mjs'

function fakeTextarea() {
  const on = {}
  return { addEventListener: (ev, fn) => { on[ev] = fn }, fire: ev => on[ev]?.() }
}

test('輸入法組字：組字中、剛組完的那一筆算組字，過一下就不算', () => {
  let now = 1000
  const t = imeTracker(() => now)
  const ta = fakeTextarea()
  t.attach(ta)
  assert.equal(t.recent(), false)
  ta.fire('compositionstart')
  assert.equal(t.recent(), true, '組字中')
  ta.fire('compositionend')
  now += IME_RECENT_MS
  assert.equal(t.recent(), true, '剛組完')
  now += 1
  assert.equal(t.recent(), false, '過了就不算')
  t.attach(null)   // 沒有 textarea 不會壞
})

test('送字時帶上組字旗標，給 Rust 端記數量', async () => {
  const sent = []
  const s = createTermViewSession({
    open: async () => 7,
    close: async () => {},
    listen: async () => () => {},
    createTerm: async () => ({ write() {}, resize() {}, dispose() {} }),
    sendInput: async (id, data, paste, ime) => { sent.push([id, data, paste, ime]) },
  })
  await s.start()
  s.input('我', false, true)
  s.input('a')
  await s.inputFlushed()
  assert.deepEqual(sent, [[7, '我', false, true], [7, 'a', false, false]])
})

test('tauri 的 input 把組字旗標傳給 term_view_input；紀錄只在 Rust 端記數量', () => {
  const api = fs.readFileSync(new URL('../ui/lib/tauri.mjs', import.meta.url), 'utf8')
  assert.match(api, /invoke\('term_view_input', \{ viewId, data, paste: !!paste, ime: !!ime \}\)/)
  const view = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(view, /console\.(log|info)\([^)]*data/, '前端也不把打的字印出來')
})
