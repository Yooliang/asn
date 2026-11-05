// 在畫面裡看終端（#597）：畫面內容怎麼寫給 xterm、開關的順序；守門：只看不打字、打包不連外
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createFollow, createTermViewSession, followTarget, frameToWrite, xtermOptions } from '../ui/lib/term-view.mjs'

const meta = (o = {}) => ({ cursor_x: 3, cursor_y: 4, cols: 120, rows: 40, ...o })
const frame = (view_id, seq, text = 'x', m = {}) => ({ view_id, seq, text, meta: meta(m) })

function rig({ open } = {}) {
  const handlers = {}, calls = { closed: [], written: [], resized: [], disposed: 0, created: [], unlistened: 0, lost: [] }
  const session = createTermViewSession({
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
  assert.equal(r.calls.unlistened, 2)
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

test('守門：xterm 不收輸入，也沒有接輸入事件', () => {
  const o = xtermOptions({ cols: 1, rows: 1 })
  assert.equal(o.disableStdin, true)
  assert.equal(o.scrollback, 0)
  const src = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(!/\.onData|\.onBinary|\.onKey|term_send|term_view_input/.test(src), '這一版只看不打字')
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

test('矮視窗收起訊息區時有切回按鈕', () => {
  const chat = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.ok(chat.includes(':can-back="true"') && chat.includes('@back="termViewOn = false"'))
  const view = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(view.includes('回到訊息'))
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.match(css, /max-height:620px\)\{[^\n]*\.term-view \+ \.conv\{display:none\}[^\n]*\.term-view-back\{display:inline-block\}/, '收起訊息區和顯示按鈕要同一個條件')
})
