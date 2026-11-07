// 看別台電腦上夥伴的畫面（#597 別台看畫面 PR 5）：只能看
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { REMOTE_LABEL, REMOTE_TEXT, askRemote, remoteEntry, remoteXtermOptions, startError } from '../ui/lib/term-remote.mjs'
import { barSlots } from '../ui/lib/actionbar.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('守門：看別台畫面只能看，沒有打字、貼上、按鍵的路', () => {
  const src = read('../ui/lib/term-remote.mjs')
  for (const bad of ['onData', 'onKey', 'term_view_input', 'view_input', 'sendInput', 'paste', 'attachCustomKeyEventHandler', 'registerLinkProvider', 'WebLinksAddon']) {
    assert.ok(!src.includes(bad), `term-remote.mjs 不能有 ${bad}`)
  }
  assert.equal(remoteXtermOptions({ cols: 80, rows: 24 }).disableStdin, true, 'xterm 關掉輸入')
  assert.match(src, /new Terminal\(remoteXtermOptions\(/, '只用唯讀的設定建 xterm')
  const api = read('../ui/lib/tauri.mjs').split('export const remoteViewApi = {')[1].split('\n}')[0]
  assert.doesNotMatch(api, /input|send/, 'remoteViewApi 沒有送字的命令')
})

test('入口：別台電腦、不是離線、這台能發起才有', () => {
  const api = {}
  const f = { node: 'hom7a1', status: 'online' }
  assert.equal(remoteEntry({ api, friend: f, selfNode: 'wrk9b2', avail: true }), true)
  assert.equal(remoteEntry({ api, friend: f, selfNode: 'hom7a1', avail: true }), false, '本機的夥伴走本機看畫面')
  assert.equal(remoteEntry({ api, friend: { ...f, status: 'offline' }, selfNode: 'wrk9b2', avail: true }), false)
  assert.equal(remoteEntry({ api, friend: f, selfNode: 'wrk9b2', avail: false }), false)
  assert.equal(remoteEntry({ api, friend: f, selfNode: 'wrk9b2', avail: null }), false, '問不到當作不能')
  assert.equal(remoteEntry({ api: null, friend: f, selfNode: 'wrk9b2', avail: true }), false, '手機沒有')
})

test('問能不能看：只收 true／false，出錯回 null', async () => {
  assert.equal(await askRemote({ available: async () => true }, 'n'), true)
  assert.equal(await askRemote({ available: async () => 'yes' }, 'n'), null)
  assert.equal(await askRemote({ available: async () => { throw new Error('x') } }, 'n'), null)
  assert.equal(await askRemote(null, 'n'), null)
})

test('第 2 格可以換成「看畫面」', () => {
  const s = barSlots({ node: 'hom7a1', status: 'online', engine: 'claude' }, { term: true, termLabel: REMOTE_LABEL }).find(x => x.key === 'window')
  assert.equal(s.label, REMOTE_LABEL)
  assert.equal(s.term, true)
})

test('文字：開始前先說會確認本人；錯誤用 Rust 回的白話', () => {
  assert.match(REMOTE_TEXT.pin('「家用機」上「小乙」'), /確認是本人/)
  assert.match(REMOTE_TEXT.watching('家用機', '小乙'), /只能看/)
  assert.equal(startError(new Error('已取消，沒有完成')), '已取消，沒有完成')
  assert.equal(startError(''), REMOTE_TEXT.failed)
})

test('入口：只有本人帳號底下的設備才問電腦端', () => {
  const src = read('../ui/list.js')
  assert.match(src, /Object\.hasOwn\(remoteMine\.value, node\) \? remoteViewApi\.available\(node\) : false/)
  assert.match(src, /remoteViewApi: mineViewApi/)

})
