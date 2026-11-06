// 在畫面裡看終端、打字（#597）：畫面內容怎麼寫給 xterm、開關的順序、打字的順序與守門；守門：打包不連外
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createFollow, createTermViewSession, followTarget, frameToWrite, pasteNeedsConfirm, pasteSummary, termKeyHandler, xtermOptions } from '../ui/lib/term-view.mjs'

const meta = (o = {}) => ({ cursor_x: 3, cursor_y: 4, cols: 120, rows: 40, ...o })
const frame = (view_id, seq, text = 'x', m = {}) => ({ view_id, seq, text, meta: meta(m) })

function rig({ open, sendInput } = {}) {
  const handlers = {}, calls = { closed: [], written: [], resized: [], disposed: 0, created: [], unlistened: 0, lost: [], sent: [], inputErrors: [] }
  const session = createTermViewSession({
    sendInput: sendInput ?? (async (id, data, paste) => { calls.sent.push([id, data, paste]) }),
    onInputError: e => calls.inputErrors.push(e),
    open: open ?? (async () => 7),
    close: async id => { calls.closed.push(id) },
    listen: async (evt, fn) => { handlers[evt] = fn; return () => { calls.unlistened++ } },
    createTerm: async size => {
      calls.created.push(size)
      return { write: s => calls.written.push(s), resize: (c, r) => calls.resized.push([c, r]), dispose: () => { calls.disposed++ } }
    },
    onLost: r => calls.lost.push(r),
  })
  return { session, handlers, calls }
}

test('一幅畫面：清掉重畫、換行補成 CRLF、結尾不多捲一行、游標放回去', () => {
  assert.equal(
    frameToWrite(frame(1, 1, '\x1b[31m紅\n第二行\r\n\n')),
    '\x1b[0m\x1b[H\x1b[2J\x1b[31m紅\r\n第二行\x1b[0m\x1b[5;4H',
  )
})

test('游標或內容缺欄位不會寫出壞序列', () => {
  assert.equal(frameToWrite({ text: '' }), '\x1b[0m\x1b[H\x1b[2J\x1b[0m\x1b[1;1H')
  assert.equal(frameToWrite({ text: 'a', meta: { cursor_x: -2, cursor_y: 'x' } }), '\x1b[0m\x1b[H\x1b[2Ja\x1b[0m\x1b[1;1H')
})

test('只畫自己這個觀看的畫面，舊序號不畫', async () => {
  const r = rig()
  await r.session.start()
  r.handlers['term-view-frame'](frame(99, 1, '別人的'))
  r.handlers['term-view-frame'](frame(7, 2, '甲'))
  r.handlers['term-view-frame'](frame(7, 1, '舊的'))
  await r.session.flushed()
  assert.equal(r.calls.written.length, 1)
  assert.ok(r.calls.written[0].includes('甲'))
  assert.deepEqual(r.calls.created, [{ cols: 120, rows: 40 }])
})

test('照窗格大小畫，大小變了才改', async () => {
  const r = rig()
  await r.session.start()
  r.handlers['term-view-frame'](frame(7, 1, '甲', { cols: 80, rows: 24 }))
  r.handlers['term-view-frame'](frame(7, 2, '乙', { cols: 80, rows: 24 }))
  r.handlers['term-view-frame'](frame(7, 3, '丙', { cols: 120, rows: 40 }))
  await r.session.flushed()
  assert.deepEqual(r.calls.created, [{ cols: 80, rows: 24 }])
  assert.deepEqual(r.calls.resized, [[120, 40]])
})

test('開好之前就到的第一幅不會掉', async () => {
  let release
  const r = rig({ open: () => new Promise(res => { release = res }) })
  const started = r.session.start()
  await new Promise(res => setTimeout(res, 0))
  r.handlers['term-view-frame'](frame(7, 1, '舊幅'))
  r.handlers['term-view-frame'](frame(7, 2, '新幅'))
  release(7)
  await started
  await r.session.flushed()
  assert.equal(r.calls.written.length, 1, '只留最新一幅')
  assert.ok(r.calls.written[0].includes('新幅'))
})

test('關掉：通知後台停讀、取消監聽、收掉 xterm，之後的畫面不畫', async () => {
  const r = rig()
  await r.session.start()
  r.handlers['term-view-frame'](frame(7, 1))
  await r.session.flushed()
  r.session.stop()
  r.session.stop()
  assert.deepEqual(r.calls.closed, [7], '只關一次')
  assert.equal(r.calls.unlistened, 3, "畫面、結束、輸入錯誤三個監聽都取消")
  assert.equal(r.calls.disposed, 1)
  r.handlers['term-view-frame'](frame(7, 2))
  await r.session.flushed()
  assert.equal(r.calls.written.length, 1)
  assert.deepEqual(r.calls.lost, [], '自己關的不算讀不到')
})

test('開到一半就關：開好馬上關掉，不留著背景讀畫面', async () => {
  let release
  const r = rig({ open: () => new Promise(res => { release = res }) })
  const started = r.session.start()
  await new Promise(res => setTimeout(res, 0))
  r.session.stop()
  release(7)
  await started
  assert.deepEqual(r.calls.closed, [7])
})

test('視窗不在了：回報讀不到，停止', async () => {
  const r = rig()
  await r.session.start()
  r.handlers['term-view-closed']({ view_id: 8, reason: '別的' })
  assert.deepEqual(r.calls.lost, [])
  r.handlers['term-view-closed']({ view_id: 7, reason: '窗格不在' })
  assert.deepEqual(r.calls.lost, ['窗格不在'])
  assert.deepEqual(r.calls.closed, [7])
})

test('開不了：回報讀不到', async () => {
  const r = rig({ open: async () => { throw new Error('不認得') } })
  await r.session.start()
  assert.deepEqual(r.calls.lost, ['不認得'])
  assert.deepEqual(r.calls.closed, [])
})

test('守門：xterm 收輸入、沒有捲動記錄；輸入只接 onData，不走舊的 term_send／term_answer', () => {
  const o = xtermOptions({ cols: 1, rows: 1 })
  assert.equal(o.disableStdin, false)
  assert.equal(o.scrollback, 0)
  assert.equal(o.allowProposedApi, false)
  const src = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('t.onData('), '按鍵從 onData 來')
  assert.ok(!/\.onBinary|\.onKey\b|term_send|term_answer/.test(src), '不接二進位輸入，也不走舊的送字命令')
  const tauri = fs.readFileSync(new URL('../ui/lib/tauri.mjs', import.meta.url), 'utf8')
  assert.ok(tauri.includes("invoke('term_view_input'"), '只有一個入口命令')
})

test('打字：開好之後一支一支照順序送，編號是這次觀看的', async () => {
  const r = rig()
  await r.session.start()
  assert.equal(r.session.input('a'), true)
  r.session.input('b')
  r.session.input('c', true)
  await r.session.inputFlushed()
  assert.deepEqual(r.calls.sent, [[7, 'a', false], [7, 'b', false], [7, 'c', true]])
})

test('打字：前一支還沒回來，後面的等著，順序不亂', async () => {
  const order = []
  let release
  const gate = new Promise(res => { release = res })
  const r = rig({ sendInput: async (id, data) => { order.push(`start:${data}`); if (data === 'a') await gate; order.push(`end:${data}`) } })
  await r.session.start()
  r.session.input('a'); r.session.input('b'); r.session.input('c')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(order, ['start:a'], 'a 還沒回來，b、c 不先送')
  release()
  await r.session.inputFlushed()
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
})

test('打字：還沒開好、已經關掉、空字、沒有送字的依賴，都不送', async () => {
  const r = rig({ open: () => new Promise(() => {}) })
  void r.session.start()
  await Promise.resolve()
  assert.equal(r.session.input('x'), false, '還沒開好')
  const r2 = rig()
  await r2.session.start()
  assert.equal(r2.session.input(''), false, '空字')
  r2.session.stop()
  assert.equal(r2.session.input('x'), false, '關掉之後')
  await r2.session.inputFlushed()
  assert.deepEqual(r2.calls.sent, [])
  const only = createTermViewSession({ open: async () => 1, close: async () => {}, listen: async () => () => {}, createTerm: async () => ({ write() {}, resize() {}, dispose() {} }), onLost() {} })
  await only.start()
  assert.equal(only.input('x'), false, '沒有送字的依賴＝只看')
})

test('打字：送不出去會回報，不假裝成功；後台說停了也回報（含沒送出的位元組數）', async () => {
  const r = rig({ sendInput: async () => { throw new Error('視窗不在前景，不送') } })
  await r.session.start()
  r.session.input('x')
  await r.session.inputFlushed()
  assert.equal(r.calls.inputErrors[0].message, '視窗不在前景，不送')
  const r2 = rig()
  await r2.session.start()
  r2.handlers['term-view-input-error']({ view_id: 7, message: '這個窗格已經不在了', lost_bytes: 12 })
  r2.handlers['term-view-input-error']({ view_id: 99, message: '別的畫面', lost_bytes: 1 })
  assert.deepEqual(r2.calls.inputErrors, [{ message: '這個窗格已經不在了', lost_bytes: 12 }], '只收自己這個觀看的')
})

test('貼上：單行直接送、多行要先問；摘要寫行數與字數', () => {
  assert.equal(pasteNeedsConfirm('ls -la'), false)
  assert.equal(pasteNeedsConfirm('ls -la\n'), false, '只有結尾換行還算單行')
  assert.equal(pasteNeedsConfirm('a\nb'), true)
  assert.equal(pasteNeedsConfirm('a\r\nb'), true)
  assert.equal(pasteSummary('一\n二\n三'), '要貼上 3 行、5 個字，送進這位夥伴的終端？')
})

test('守門：貼上由元件自己接手（多行確認），不讓 xterm 自己處理', () => {
  const src = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('@paste.capture="onPaste"') && src.includes('ev.preventDefault()') && src.includes('ev.stopPropagation()'))
  assert.ok(src.includes('pasteNeedsConfirm(text)') && src.includes('confirmPaste') && src.includes('cancelPaste'))
})

test('守門：xterm 釘版本、打包進 ui/vendor、不走 CDN', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.dependencies['@xterm/xterm'], /^\d+\.\d+\.\d+$/, '要釘死版本')
  const prep = fs.readFileSync(new URL('../scripts/prep.mjs', import.meta.url), 'utf8')
  assert.ok(prep.includes('xterm.js') && prep.includes('xterm.css'))
  const src = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes("'vendor/xterm.js'") && src.includes("'vendor/xterm.css'"))
  assert.ok(!/https?:\/\//.test(src), '不連外')
})

test('跟著游標：游標在下面就捲下去，多留一列；不超過範圍', () => {
  const g = { rowHeight: 10, clientHeight: 80, scrollHeight: 400 }
  assert.equal(followTarget({ ...g, cursorRow: 2 }), 0, '已經看得到就不捲')
  assert.equal(followTarget({ ...g, cursorRow: 30 }), 240)
  assert.equal(followTarget({ ...g, cursorRow: 39 }), 320, '最多到底')
  assert.equal(followTarget({ rowHeight: 10, clientHeight: 500, scrollHeight: 400, cursorRow: 39 }), 0, '整個放得下')
})

test('跟著游標：往上捲就不跟，捲回游標或底部再跟；自己捲的不算', () => {
  const f = createFollow()
  assert.equal(f.following(), true)
  f.place(240)
  f.onScroll(240, 240)
  assert.equal(f.following(), true, '程式自己捲的')
  f.onScroll(100, 240)
  assert.equal(f.following(), false, '使用者往上捲')
  f.onScroll(150, 240)
  assert.equal(f.following(), false, '還沒捲回去')
  f.onScroll(240, 240)
  assert.equal(f.following(), true, '捲回游標，再跟（就算和上次程式設定的位置相同）')
  f.onScroll(100, 240)
  f.onScroll(320, 240)
  assert.equal(f.following(), true, '捲到底，再跟')
})

test('打開終端時收起訊息區、有切回按鈕；視窗高矮一樣（#901）', () => {
  const chat = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.ok(chat.includes(':can-back="true"') && chat.includes('@back="termViewOn = false"'))
  assert.ok(chat.includes('<div class="conv" v-show="!termShown">'), '終端開著時訊息列表收起')
  const view = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(view.includes('回到訊息'))
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /max-height:620px/, '不再只有矮視窗才收起')
  assert.match(css, /\.chatpane-main > \.term-view\{flex:1 1 0\}/, '終端占滿訊息區')
  assert.doesNotMatch(css, /\.term-view-back\{display:none/, '切回按鈕不再藏起來')
})

test('守門：滾輪不交給 xterm（否則會變成方向鍵，外層也捲不動）；接上輸入之後更不能拿掉', () => {
  const src = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('attachCustomWheelEventHandler(() => false)'))
  // 滾輪要先交給外層，才輪到接輸入：順序反了，捲畫面就會變成對夥伴按上下鍵
  assert.ok(src.indexOf('attachCustomWheelEventHandler') < src.indexOf('t.onData('))
  // 沒有任何地方把滾輪事件轉成送字
  assert.ok(!/onWheel|'wheel'/.test(src.replace(/attachCustomWheelEventHandler/g, '')), '滾輪不會變成送字')
})

test('守門：後台、relay、CLI 碰不到 term_view_input（只有本機畫面這一個入口）', () => {
  const lib = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  const uses = lib.split('term_view_input').length - 1
  assert.equal(uses, 2, '只有定義與註冊，沒有別的地方呼叫：' + uses)
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name])
  for (const f of walk(new URL('../src-tauri/src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).filter(f => f.endsWith('.rs') && !f.endsWith('lib.rs'))) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('term_view_input'), f + ' 不能碰 term_view_input')
  }
  const cli = walk(new URL('../src-tauri/src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).filter(f => /[\\/](cli|bridge)[\\/]/.test(f) && f.endsWith('.rs'))
  for (const f of cli) assert.ok(!/view_input/.test(fs.readFileSync(f, 'utf8')), f + ' 不能呼叫 view_input')
})

test('守門：貼上鍵不被 xterm 吃掉（Ctrl+V、Ctrl+Shift+V、Shift+Insert 回 false）；其他鍵照舊', () => {
  const k = (key, o = {}) => termKeyHandler({ type: 'keydown', key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o })
  assert.equal(k('v', { ctrlKey: true }), false)
  assert.equal(k('V', { ctrlKey: true, shiftKey: true }), false)
  assert.equal(k('Insert', { shiftKey: true }), false)
  assert.equal(k('c', { ctrlKey: true }), true, 'Ctrl+C 仍要送出')
  assert.equal(k('a'), true)
  assert.equal(k('v'), true)
  assert.equal(k('Insert'), true)
  assert.equal(termKeyHandler({ type: 'keyup', key: 'v', ctrlKey: true }), true)
  const src = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('attachCustomKeyEventHandler(termKeyHandler)'), '要接上 xterm')
})
