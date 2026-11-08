// 看別台電腦上夥伴的畫面（#597 別台看畫面 PR 5）：只能看
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { REMOTE_LABEL, REMOTE_TEXT, askRemote, openTerm, remoteEntry, remoteXtermOptions, startError } from '../ui/lib/term-remote.mjs'
import { barSlots } from '../ui/lib/actionbar.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('守門：看別台畫面只能看，沒有打字、貼上、按鍵的路', () => {
  const src = read('../ui/lib/term-remote.mjs')
  for (const bad of ['onData', 'onKey', 'term_view_input', 'view_input', 'sendInput', 'paste', 'attachCustomKeyEventHandler', 'registerLinkProvider', 'WebLinksAddon']) {
    assert.ok(!src.includes(bad), `term-remote.mjs 不能有 ${bad}`)
  }
  assert.equal(remoteXtermOptions({ cols: 80, rows: 24 }).disableStdin, true, 'xterm 關掉輸入')
  assert.match(src, /openTerm\(Terminal, remoteXtermOptions\(/, '只用唯讀的設定建 xterm')
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

test('第 2 格和本機一樣寫「終端」（#1029）', () => {
  assert.equal(REMOTE_LABEL, '終端')
  const s = barSlots({ node: 'hom7a1', status: 'online', engine: 'claude' }, { term: true, termLabel: REMOTE_LABEL }).find(x => x.key === 'window')
  assert.equal(s.label, REMOTE_LABEL)
  assert.equal(s.term, true)
})

test('文字：按下去直接開始，不再說會確認本人（11-08 拿掉 Hello）；錯誤用 Rust 回的白話', () => {
  assert.equal(REMOTE_TEXT.pin, undefined, '沒有「會請你確認是本人」的說明')
  for (const f of ['../ui/lib/term-remote.mjs', '../ui/lib/term-remote-input.mjs', '../ui/lib/tauri.mjs']) {
    const src = read(f)
    for (const bad of ['確認是本人', 'Hello', 'PIN']) assert.ok(!src.includes(bad), `${f} 不能再寫「${bad}」`)
  }
  assert.match(read('../ui/lib/term-remote.mjs'), /v-if="phase === 'starting' \|\| phase === 'waiting'">\{\{ TEXT\.waiting \}\}/, '發起到收到第一幅之間只說「等那台電腦回應」')
  assert.match(REMOTE_TEXT.watching('家用機', '小乙'), /只能看/)
  assert.equal(startError(new Error('已取消，沒有完成')), '已取消，沒有完成')
  assert.equal(startError(''), REMOTE_TEXT.failed)
})

test('入口：只有本人帳號底下的設備才問電腦端', () => {
  const src = read('../ui/list.js')
  assert.match(src, /Object\.hasOwn\(remoteMine\.value, node\) \? remoteViewApi\.available\(node\) : false/)
  assert.match(src, /remoteViewApi: mineViewApi/)

})

test('看別台畫面：沒有返回鈕（只靠上排第 2 格切回訊息），關掉時照樣結束那次觀看', () => {
  const src = read('../ui/lib/term-remote.mjs')
  assert.ok(!src.includes('term-view-back') && !src.includes("emit('back')") && !src.includes("emits: ['back']"), '沒有返回鈕、沒有 back 事件')
  assert.ok(!src.includes("'回到訊息'"), '畫面裡沒有回到訊息按鈕')
  // 離開（第 2 格切回訊息 → v-if 卸載）時要結束觀看：不能因為拿掉按鈕就沒人叫 stop
  assert.match(src, /onBeforeUnmount\(\(\) => \{ alive = false; stop\(\); cleanup\(\) \}\)/)
})

test('#1029 等畫面元素掛上去才建 xterm；元素不在就回 null，不丟「Terminal requires a parent element」', async () => {
  const made = []
  class Terminal {
    constructor(o) { this.o = o; made.push(this) }
    attachCustomWheelEventHandler(f) { this.wheel = f }
    open(el) { if (!el) throw new Error('Terminal requires a parent element.'); this.el = el }
  }
  const opts = remoteXtermOptions({ cols: 120, rows: 40 })
  // 元素晚一拍才掛上：等一下再建
  const host = { value: null }
  let ticks = 0
  const tick = async () => { ticks++; host.value = { isConnected: true } }
  const t = await openTerm(Terminal, opts, host, tick, () => true)
  assert.ok(t && t.el === host.value && ticks === 1, '等到元素才 open')
  assert.equal(t.wheel(), false, '滾輪照舊不交給 xterm')
  // 一直沒有元素：回 null，不建 xterm
  made.length = 0
  assert.equal(await openTerm(Terminal, opts, { value: null }, async () => {}, () => true), null)
  assert.equal(made.length, 0)
  // 元素已經拆掉（isConnected=false）也不建
  assert.equal(await openTerm(Terminal, opts, { value: { isConnected: false } }, async () => {}, () => true), null)
  // 這一格已經收掉：不建
  assert.equal(await openTerm(Terminal, opts, { value: { isConnected: true } }, async () => {}, () => false), null)
  assert.equal(made.length, 0)
})

test('#1029 開始後這一格被收掉或建不了 xterm：一定結束這次觀看（那台不會一直送到到期）', () => {
  for (const f of ['../ui/lib/term-remote.mjs', '../ui/lib/term-remote-input.mjs']) {
    const src = read(f)
    assert.match(src, /id = r\.id[^{}]*?if \(!alive\) \{ stop\(\); return \}/, `${f}：開始後先看這一格還在不在`)
    assert.match(src, /if \(!term\) \{ stop\(\); if \(alive\) finish\(/, `${f}：建不了 xterm 就結束`)
    assert.match(src, /onBeforeUnmount\(\(\) => \{ alive = false; stop\(\); cleanup\(\) \}\)/, `${f}：收掉時記下來`)
    assert.ok(!src.includes('term.open(host.value)'), `${f}：不再直接 open（元素可能不在）`)
  }
  const chat = read('../ui/lib/chatpane.mjs')
  assert.match(chat, /!\(r === null && remoteOn\.value\)\) remoteAvail\.value = r/, '正在看時一時問不到，不把這一格收掉')
})

test('#1029 收到的畫面直接是內容（lib/tauri.mjs 的 listen 已經拆掉 payload）：收到第一幅就算開始看，結束也收得到', async () => {
  const tauri = read('../ui/lib/tauri.mjs')
  assert.match(tauri, /export const listen = \(evt, fn\) => T\.event\.listen\(evt, e => fn\(e\.payload\)\)/, 'listen 交給回呼的是 payload 本身')
  for (const f of ['../ui/lib/term-remote.mjs', '../ui/lib/term-remote-input.mjs']) {
    const code = read(f).replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!code.includes('.payload'), `${f} 不能再讀 .payload（每一幅都會被丟掉，畫面一直停在「等」）`)
    assert.match(code, /listen\(FRAME_EVENT, f => \{/)
    assert.match(code, /listen\(END_EVENT, e => \{ if \(e\?\.id === id\) finish\(e\.text \|\| ''\) \}\)/)
  }
})

test('#1029 被看的那台的紅條放在左右並排的區塊外面：只佔上方一條，不會被撐成整條高', () => {
  const html = read('../ui/list.html')
  const bar = html.indexOf('<div class="viewed-bar"'), shell = html.indexOf('<div class="shell"')
  assert.ok(bar > 0 && shell > 0 && bar < shell, '紅條在 .shell 前面（.win 是上下排的）')
  assert.match(read('../ui/style.css'), /\.viewed-bar\{flex:none;/, '紅條不伸縮')
})
