// 在畫面裡看終端、打字（#597）：畫面內容怎麼寫給 xterm、開關的順序、打字的順序與守門；守門：打包不連外
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TERM_VIEW_LATEST, createFollow, createTermViewSession, followScrollTo, followTarget, frameToWrite, latestVisible, pasteNeedsConfirm, pasteSummary, termKeyHandler, xtermOptions } from '../ui/lib/term-view.mjs'

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
  assert.equal(o.allowProposedApi, true, '#903：只為了註冊自己的字寬表')
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

test('跟著游標（#904）：只有人在底部附近才跟；往上捲離開就停，捲回底部附近才恢復；自己捲的不算', () => {
  // onScroll(scrollTop, max)：max＝外層可捲的最大值。舊規則是和「游標列＋2」比，游標在中間時一捲過去就被拉回
  const f = createFollow()
  assert.equal(f.following(), true, '一開始跟隨')
  f.place(240)
  f.onScroll(240, 400)
  assert.equal(f.following(), true, '程式自己捲的（雖然不在底部）不算使用者捲的')
  f.onScroll(100, 400)
  assert.equal(f.following(), false, '使用者往上捲離開底部')
  f.onScroll(240, 400)
  assert.equal(f.following(), false, '捲到舊規則的游標位置（240）不能恢復：人還不在底部')
  f.onScroll(300, 400)
  assert.equal(f.following(), false, '中間位置照樣不跟')
  f.onScroll(398, 400)
  assert.equal(f.following(), true, '捲回底部附近（差 2px 內）恢復')
  f.onScroll(100, 400)
  f.onScroll(400, 400)
  assert.equal(f.following(), true, '捲到最底恢復')
  f.onScroll(100, 400)
  assert.equal(f.following(), false)
  f.onScroll(397, 400)
  assert.equal(f.following(), false, '差 3px 還不算底部')
  f.resume(400)
  assert.equal(f.following(), true, '點「回到最新」直接恢復')
  f.onScroll(400, 400)
  assert.equal(f.following(), true, '回到最新捲出來的事件不算使用者捲的')
})

test('跟著游標（#904）：停止跟隨時每幅都不得設 scrollTop；跟隨時只往下推進、不後退', () => {
  // [跟隨中, 目前 scrollTop, 目標, 預期]
  const rows = [
    [true, 0, 200, 200],      // 游標在下面：往下推
    [true, 200, 200, null],   // 已經在位置：不動
    [true, 380, 200, null],   // 人在更下面（底部）：不後退
    [false, 100, 200, null],  // 人往上看舊的：不拉走
    [false, 250, 200, null],  // 捲在中間，新幅進來：不被拉走
    [false, 0, 400, null],    // 不跟隨時目標再大也不動
  ]
  for (const [following, current, target, want] of rows) {
    assert.equal(followScrollTo({ following, current, target }), want, JSON.stringify({ following, current, target }))
  }
  // 連續十幅：人在中間（不跟隨）→ scrollTop 一次都沒被設
  const f = createFollow()
  f.onScroll(100, 400)
  let sets = 0
  for (let i = 0; i < 10; i++) if (followScrollTo({ following: f.following(), current: 100, target: 200 + i }) !== null) sets++
  assert.equal(sets, 0)
})

test('「回到最新」提示：只有停止跟隨才顯示', () => {
  const f = createFollow()
  assert.equal(latestVisible(f.following()), false, '跟隨中不顯示')
  f.onScroll(100, 400)
  assert.equal(latestVisible(f.following()), true, '停止跟隨才顯示')
  f.onScroll(400, 400)
  assert.equal(latestVisible(f.following()), false, '捲回底部就收起')
  assert.equal(TERM_VIEW_LATEST, '回到最新')
})

test('「回到最新」接線：按了把外層捲到最底並恢復跟隨；放在畫面區右下角內側、沿用 aero-btn（#904）', () => {
  const src = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.match(src, /<button class="aero-btn term-view-latest" type="button" v-if="behind" @click="jumpLatest">/)
  assert.match(src, /const toBottom = \(\) => \{[\s\S]{0,200}follow\.resume\(top\)[\s\S]{0,80}host\.value\.scrollTop = top/)
  assert.match(src, /const jumpLatest = \(\) => \{ resumeLive\(\)/, '按了回到最新：解除凍結＋捲到最底（#904 B3）')
  assert.match(src, /t\.attachCustomWheelEventHandler\(\(\) => false\)[\s\S]*t\.onData\(/, '滾輪仍交給外層，排在 onData 之前')
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.match(css, /\.term-view-latest\{position:absolute;right:12px;bottom:12px/)
})

test('終端上方不再有說明行（#901b）：template、樣式、原句字串全專案都不在', () => {
  const view = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(!view.includes('term-view-note') && !view.includes('TERM_VIEW_NOTE'), 'term-view 裡沒有說明行')
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.ok(!css.includes('term-view-note'))
  const sentence = '點一下畫面就能打字'
  const root = new URL('../ui/', import.meta.url)
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'vendor' ? [] : walk(new URL(`${e.name}/`, d))) : [new URL(e.name, d)]))
  for (const f of walk(root)) {
    if (!/\.(mjs|js|html|css)$/.test(f.pathname)) continue
    assert.ok(!fs.readFileSync(f, 'utf8').includes(sentence), `${f.pathname} 還有說明句`)
  }
  assert.match(view, /<p class="term-view-ask" v-if="askHint"/, '其他提示不動')
  assert.match(view, /term-view-lost/)
})

test('打開終端時收起訊息區、只用上排大按鈕切換；視窗高矮一樣（#901／#901b）', () => {
  const chat = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  const termLine = chat.split('\n').find(l => l.includes('<term-view '))
  assert.ok(termLine && !termLine.includes('can-back') && !termLine.includes('@back='), '終端畫面不再有回到訊息的接線')
  const remoteLine = chat.split('\n').find(l => l.includes('<remote-view '))
  assert.ok(remoteLine && !remoteLine.includes('@back='), '別台夥伴的看畫面也一樣：只靠第 2 格切回訊息，沒有返回鈕')
  assert.ok(!chat.includes('can-back'), '沒有任何地方再傳 can-back')
  assert.ok(chat.includes('@term="toggleTerm"'), '上排大按鈕負責切換')
  assert.ok(chat.includes('<div class="conv" v-show="!paneTermShown">'), '終端開著時訊息列表收起')
  assert.ok(chat.includes('const paneTermShown = computed(() => termShown.value || remoteShown.value)'), '#1029：看別台的終端也一樣收起訊息列表、占滿整塊，不是只佔上半部')
  const view = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(!view.includes('回到訊息') && !view.includes('canBack') && !view.includes("emit('back')"), '終端畫面裡沒有回到訊息按鈕')
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /max-height:620px/, '不再只有矮視窗才收起')
  assert.match(css, /\.chatpane-main > \.term-view\{flex:1 1 0\}/, '終端占滿訊息區')
})

test('守門 901b-scroll-kept：大按鈕切換終端／訊息時，訊息列表的捲動位置照舊保留', () => {
  const chat = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  // 打開（termShown 變 true）時記下，關掉時還原；只看 termShown 的變化，與哪顆按鈕無關
  assert.match(chat, /watch\(paneTermShown, on => \{\s*if \(on\) \{ termScroll = scrollMemo\(msgsEl\.value\); return \}/)
  assert.match(chat, /el\.scrollTop = restoreTop\(memo, el\)/)
  assert.ok(chat.includes('if (canTermView.value) termViewOn.value = !termViewOn.value'), '本機服務裡的夥伴：大按鈕切換終端（別台夥伴的看畫面分支在它前面，互斥）')
  assert.ok(chat.indexOf('if (canRemote.value) { remoteOn.value = !remoteOn.value; return }') < chat.indexOf('if (canTermView.value) termViewOn.value = !termViewOn.value'), '看畫面（別台）與終端（本機）互斥：先看別台，再看本機')
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

test('守門 901b-noscroll：終端畫面直捲軸隱藏、回到訊息按鈕已不存在', () => {
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  const view = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.match(css, /\.term-view-screen::-webkit-scrollbar\{width:0;/, '直捲軸寬度為 0')
  assert.match(css, /\.term-view-screen\{[^}]*overflow:auto/, '仍可捲動')
  assert.match(css, /\.term-view-screen \.xterm-viewport::-webkit-scrollbar\{width:0/, 'xterm 自己的空直捲軸也藏起來')
  assert.ok(!css.includes('term-view-back') && !css.includes('term-view-stage'), '樣式裡沒有按鈕與 stage 的規則')
  assert.ok(!view.includes('term-view-back') && !view.includes('term-view-stage'), '畫面裡沒有按鈕與 stage')
  assert.ok(!/<button[^>]*>\s*回到訊息\s*<\/button>/.test(view), '沒有「回到訊息」按鈕')
})

// ---- #903 游標對位：真實 WezTerm 取樣（test/fixtures/term-cursor，內容都是假文字） ----
const FIX = name => fs.readFileSync(new URL('./fixtures/term-cursor/' + name, import.meta.url), 'utf8')
const sample = name => {
  const j = JSON.parse(FIX(name + '.json'))
  return { text: FIX(name + '.escapes.txt'), meta: { cursor_x: j.cursor_x, cursor_y: j.cursor_y, cols: j.size.cols, rows: j.size.rows } }
}
/** 把 frameToWrite 的輸出拆回「內容各列」與「游標落點」 */
function parseWrite(out) {
  const head = '\x1b[0m\x1b[H\x1b[2J'
  assert.ok(out.startsWith(head))
  const k = out.lastIndexOf('\x1b[0m\x1b[')
  const m = /^\x1b\[0m\x1b\[(\d+);(\d+)H$/.exec(out.slice(k))
  assert.ok(m, '結尾是游標定位')
  return { lines: out.slice(head.length, k).split('\r\n'), row: Number(m[1]) - 1, col: Number(m[2]) - 1 }
}

test('903：B（150 行捲動紀錄後游標在最後一列）只留畫面這 40 列，標記字串在 cursor_y 那一列', () => {
  const f = sample('B'), { lines, row } = parseWrite(frameToWrite(f))
  assert.equal(f.text.split('\n').length - 1, 43, '樣本確實比畫面多（42 列＋最後的裸換行）')
  assert.equal(lines.length, f.meta.rows)
  assert.equal(row, f.meta.cursor_y)
  assert.ok(lines[f.meta.cursor_y].includes('MARK_B>'), lines[f.meta.cursor_y])
  assert.ok(lines[0].includes('LINE 112'), '最上面的捲動紀錄 2 行被裁掉：' + lines[0])
})

test('903：C（捲動紀錄後游標移到第 20 列）標記字串在 cursor_y 那一列', () => {
  const f = sample('C'), { lines, row } = parseWrite(frameToWrite(f))
  assert.equal(f.meta.cursor_y, 19)
  assert.equal(row, 19)
  assert.ok(lines.length <= f.meta.rows && lines.length >= f.meta.rows - 1, '尾端空列會被去掉：' + lines.length)
  assert.ok(lines[f.meta.cursor_y].includes('MARK_C'), lines[f.meta.cursor_y])
})

test('903：A（空畫面）與 E（全形字折行）沒有多出來的列，內容不變、索引仍等於 cursor_y', () => {
  const a = sample('A'), pa = parseWrite(frameToWrite(a))
  assert.ok(pa.lines[a.meta.cursor_y].includes('PS C:'), pa.lines[0])
  assert.equal(pa.lines.length, 1, '空畫面只有提示列（尾端空列去掉）')
  const e = sample('E'), pe = parseWrite(frameToWrite(e))
  assert.ok(pe.lines[e.meta.cursor_y].includes('MARK_E'), pe.lines[e.meta.cursor_y])
  assert.equal(pe.lines.length, 10)
  assert.ok(pe.lines[1].startsWith('\x1b(B\x1b[0m'), '折行處的列頭逃逸序列沒被弄壞')
  // 沒有比 rows 多的列時，內容和不裁（舊行為）一模一樣
  assert.equal(frameToWrite(e), frameToWrite({ text: e.text, meta: { ...e.meta, rows: undefined } }))
})

test('903：行數比 rows 少、剛好、多 1、多 2、多很多的表格（--escapes 形式：每列 CRLF，最後多一個裸換行）', () => {
  const run = (n, rows) => {
    const text = Array.from({ length: n }, (_, i) => 'L' + i + '\r\n').join('') + '\n'
    return parseWrite(frameToWrite({ text, meta: { rows, cursor_x: 0, cursor_y: rows - 1 } })).lines
  }
  for (const [n, rows, cut] of [[3, 5, 0], [5, 5, 0], [6, 5, 1], [7, 5, 2], [50, 5, 45]]) {
    const lines = run(n, rows)
    assert.equal(lines.length, Math.min(n, rows), `n=${n}`)
    assert.equal(lines[0], 'L' + cut, `n=${n} 頭一列`)
    assert.equal(lines.at(-1), 'L' + (n - 1), `n=${n} 最後一列`)
  }
})

test('903：尾端是空列時照算畫面列數（不因為去掉結尾空列而少裁）', () => {
  // 7 列，最後 2 列是空的；rows=5 要裁掉最前面 2 列：留 L2 L3 L4，後面兩列空列去掉
  const text = ['L0', 'L1', 'L2', 'L3', 'L4', '', ''].map(l => l + '\r\n').join('') + '\n'
  assert.deepEqual(parseWrite(frameToWrite({ text, meta: { rows: 5, cursor_x: 0, cursor_y: 0 } })).lines, ['L2', 'L3', 'L4'])
})

test('903：最上面幾列是空列時不被誤裁（只裁多出來的最前面幾列，不是空列）', () => {
  const text = ['', '', 'A', 'B'].map(l => l + '\r\n').join('') + '\n'
  assert.deepEqual(parseWrite(frameToWrite({ text, meta: { rows: 4, cursor_x: 0, cursor_y: 3 } })).lines, ['', '', 'A', 'B'])
  assert.deepEqual(parseWrite(frameToWrite({ text, meta: { rows: 3, cursor_x: 0, cursor_y: 2 } })).lines, ['', 'A', 'B'])
})

test('903：meta.rows 缺或不是正整數時維持舊行為', () => {
  const text = 'a\r\nb\r\nc\r\n\n'
  for (const rows of [undefined, 0, -3, 2.5, 'x']) {
    assert.deepEqual(parseWrite(frameToWrite({ text, meta: { rows, cursor_x: 0, cursor_y: 0 } })).lines, ['a', 'b', 'c'])
  }
  assert.deepEqual(parseWrite(frameToWrite({ text })).lines, ['a', 'b', 'c'])
})

// 903b：真的有顏色時，整份結尾是 `\r\n\x1b[39m\n`（最後一列之後多一個只有重置序列的假列，不是空字串）。
// 30家用 實機（0.2.7 候選，全螢幕 Claude 窗格，沒有捲動紀錄）：cursor_y=36、提示列在文字第 36 列，舊判斷沒把那個假列去掉，
// 行數 41 > rows 40，就把最前面一列裁掉，提示列變第 35 列、游標落在它下一列（和 #903 原本的症狀一樣）
function coloredScreen({ rows, scrollback, markerRow }) {
  const lines = []
  for (let i = 0; i < scrollback; i++) lines.push(`\x1b[38:2::1:2:3mSB${i}\x1b[39m`)
  for (let r = 0; r < rows; r++) lines.push(r === markerRow ? '\x1b[38:2::9:9:9m❯ MARK\x1b[39m' : `\x1b[38:2::1:2:3mrow ${r}\x1b[39m`)
  return lines.join('\r\n') + '\r\n\x1b[39m\n'   // 最後一列也以 CRLF 結尾，整份最後多一個裸換行，前面帶著殘留的重置序列
}
const markIndex = out => {
  const body = out.split('\x1b[2J')[1]
  const lines = body.slice(0, body.lastIndexOf('\x1b[0m\x1b[')).split('\r\n')
  return { lines, at: lines.findIndex(l => l.includes('MARK')) }
}

test('903b：結尾帶殘留顏色序列的真實格式——沒有捲動紀錄：剛好 rows 列，提示列索引＝cursor_y', () => {
  const out = frameToWrite({ text: coloredScreen({ rows: 40, scrollback: 0, markerRow: 36 }), meta: { cursor_x: 2, cursor_y: 36, cols: 120, rows: 40 } })
  const { lines, at } = markIndex(out)
  assert.equal(lines.length, 40, '假列要去掉，不能多一列')
  assert.equal(at, 36)
  assert.ok(out.endsWith('\x1b[37;3H'))
})

test('903b：結尾帶殘留顏色序列——有 2 列捲動紀錄：只留最後 40 列，提示列索引仍＝cursor_y', () => {
  const out = frameToWrite({ text: coloredScreen({ rows: 40, scrollback: 2, markerRow: 20 }), meta: { cursor_x: 4, cursor_y: 20, cols: 120, rows: 40 } })
  const { lines, at } = markIndex(out)
  assert.equal(lines.length, 40)
  assert.equal(at, 20)
  assert.ok(!lines.some(l => l.includes('SB')), '捲動紀錄那兩列要被裁掉')
})

test('903b：去掉假列之後不留殘留序列在結尾（否則寫進 xterm 會多一個換行、多捲一列）', () => {
  const out = frameToWrite({ text: coloredScreen({ rows: 40, scrollback: 0, markerRow: 36 }), meta: { cursor_x: 2, cursor_y: 36, cols: 120, rows: 40 } })
  const body = out.split('\x1b[2J')[1]
  assert.ok(!/\r\n\x1b\[39m\x1b\[0m\x1b\[/.test(body), '結尾不能是 CRLF＋殘留重置序列')
})

test('903b：剛好 rows 列且最後一列本來就是只有顏色的空列時不誤刪（沒有假列的格式）', () => {
  const rowsArr = []
  for (let r = 0; r < 5; r++) rowsArr.push(r === 4 ? '\x1b[39m' : `row ${r}`)
  const out = frameToWrite({ text: rowsArr.join('\r\n') + '\r\n', meta: { cursor_x: 0, cursor_y: 1, cols: 80, rows: 5 } })
  const body = out.split('\x1b[2J')[1]
  assert.equal(body.slice(0, body.lastIndexOf('\x1b[0m\x1b[')).split('\r\n').length, 5, '行數剛好 rows，不動')
})
