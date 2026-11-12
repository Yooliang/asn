// 看別台夥伴的終端時，下方輸入框直接打進那個終端（#1288，小良哥 2026-11-11 定案的四點）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SEND_LABEL, SEND_LABEL_TERM, composeTermHint } from '../ui/lib/compose.mjs'
import { ENTER_DELAY_MS } from '../ui/lib/term-remote-input.mjs'
import { createLineSender, stripControls } from '../ui/lib/term-line.mjs'
import { createTermViewSession } from '../ui/lib/term-view.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const pane = read('../ui/lib/chatpane.mjs')
// 送一整句的邏輯（Enter 延遲、排隊、多行先問、交還）抽到 term-line.mjs，看別台和看本機共用（#1378）
const input = read('../ui/lib/term-remote-input.mjs') + read('../ui/lib/term-line.mjs')
const view = read('../ui/lib/term-view.mjs')

test('按鈕字跟著模式：對話寫「傳送」、終端寫「送出」；提示字寫會打進誰的終端', () => {
  assert.equal(SEND_LABEL, '傳送')
  assert.equal(SEND_LABEL_TERM, '送出')
  assert.equal(composeTermHint('小乙'), '輸入的字會直接打進 小乙 的終端')
  assert.equal(composeTermHint(''), '輸入的字會直接打進 這位夥伴 的終端')
  assert.match(pane, /type="submit"[^>]*>\{\{ sendLabel \}\}<\/button>/, '送出鈕的字看 sendLabel')
  assert.match(pane, /termCompose\.value \? composeTermHint\(termViewName\.value\)/, '終端畫面時換提示字')
})

test('終端上方的「打字」按鈕拿掉了', () => {
  assert.ok(!pane.includes('term-remote-switch'), 'chatpane 不再有打字切換鈕')
  assert.ok(!pane.includes('@click="remoteTyping = true"'))
})

test('接線：終端畫面按送出走 sendToTerm（不寄信）；沒送進去的字放回輸入框', () => {
  const send = pane.slice(pane.indexOf('    function send() {'), pane.indexOf('\n    }\n', pane.indexOf('    function send() {')))
  assert.match(send, /if \(termCompose\.value\) \{[^}]*sendToTerm\(t\)[^}]*return \}/, '終端模式先走 sendToTerm 並 return，不 emit send')
  assert.ok(send.indexOf('sendToTerm') < send.indexOf("emit('send'"))
  assert.match(pane, /<remote-input [^>]*@unsent="restoreDraft"/)
  assert.match(pane, /const remoteCompose = computed\(\(\) => canRemoteInput\.value && !displayOnly\.value && !viewRestartable\.value\)/, '電腦版看別台終端（有打字通道）時')
  assert.match(pane, /const termCompose = computed\(\(\) => remoteCompose\.value \|\| localCompose\.value\)/, '或看本機終端時（#1378）')
  // 已結束打字／離開超過寬限（狀態列有「重新看」）時退回「傳送」，不讓輸入框代替本人按「重新看」
  assert.match(pane, /const viewRestartable = computed\(\(\) => Boolean\(typingEndedNote\.value\) \|\| \(remoteBar\.value\?\.src === 'view' && remoteBar\.value\.restartable === true\)\)/)
})

test('打字元件：整句送出後隔一下再送 Enter；開始前先排著；多行先問；沒送出就交還', () => {
  assert.ok(ENTER_DELAY_MS > 0 && ENTER_DELAY_MS < 1000)
  assert.match(input, /const typeLine = \(text, multi\) => \{\s*void send\(text, multi\)\.then\(ok => \{\s*if \(!ok\) \{ emit\('unsent', text\); return \}\s*setTimeout\(\(\) => \{ void send\('\\r', false\) \}, ENTER_DELAY_MS\)/, '整句沒送出就交還；送出了才按 Enter')
  assert.match(input, /watch\(phase, p => \{ if \(p === 'typing'\) flush\(\) \}\)/, '開始打字了才送排著的那句')
  assert.match(input, /if \(pasteLines\(t\) > 1\) \{ yieldAsk\(\); lineAsk = true; askPaste\.value = t \}/, '多行先問（前一段還在問就先交還）')
  assert.match(input, /emits: \['back', 'status', 'unsent'\]/)
  const fin = input.slice(input.indexOf('    const finish = text => {'), input.indexOf('    const start = async'))
  assert.match(fin, /if \(left\) emit\('unsent', left\)/, '結束時還沒送的交還')
  assert.match(input, /if \(lineAsk\) \{ lineAsk = false; const t = askPaste\.value; askPaste\.value = null; if \(t\) emit\('unsent', t\) \}/, '等確認時又貼上：那句交還')
})

// ---- #1378：看本機夥伴的終端，下方輸入框按「送出」直接打進終端（不跳確認框），和看別台同一套 ----

const sleep = ms => new Promise(r => setTimeout(r, ms))
// 看本機的送字：走本機畫面的 session（termViewApi.input → term_view_input）
async function localRig({ fail = false } = {}) {
  const sent = [], errors = [], unsent = []
  const session = createTermViewSession({
    sendInput: async (id, data, paste) => { if (fail) throw new Error('視窗不在前景'); sent.push([id, data, paste]) },
    onInputError: e => errors.push(e),
    open: async () => 7,
    close: async () => {},
    listen: async () => () => {},
    createTerm: async () => ({ write() {}, resize() {}, dispose() {} }),
  })
  await session.start()
  const ask = { value: null }
  const lines = createLineSender({ send: (d, p) => session.sendText(d, p), askPaste: ask, emit: (ev, t) => { if (ev === 'unsent') unsent.push(t) } })
  return { session, sent, errors, unsent, ask, lines }
}

test('本機：按送出就打進這個終端（送給本機畫面的編號），隔一下再送 Enter，不用等誰同意', async () => {
  const r = await localRig()
  r.lines.sendLine('ls -la\n')
  await sleep(ENTER_DELAY_MS + 60)
  assert.deepEqual(r.sent, [[7, 'ls -la', false], [7, '\r', false]])
  assert.deepEqual(r.unsent, [])
})

test('本機：多行先問；按取消不送、字交還；按送出才整段送＋Enter', async () => {
  const r = await localRig()
  r.lines.sendLine('a\nb')
  await sleep(10)
  assert.equal(r.ask.value, 'a\nb', '先問')
  assert.deepEqual(r.sent, [])
  assert.equal(r.lines.answer(false), true)
  assert.deepEqual(r.unsent, ['a\nb'], '取消：交還給輸入框')
  r.lines.sendLine('a\nb')
  assert.equal(r.lines.answer(true), true)
  await sleep(ENTER_DELAY_MS + 60)
  assert.deepEqual(r.sent, [[7, 'a\nb', true], [7, '\r', false]])
})

test('本機：送不出去就放回輸入框（不按 Enter），畫面上也說', async () => {
  const r = await localRig({ fail: true })
  r.lines.sendLine('echo hi')
  await sleep(ENTER_DELAY_MS + 60)
  assert.deepEqual(r.unsent, ['echo hi'])
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].message, '視窗不在前景')
})

test('本機：畫面關了之後送字回「沒送出」', async () => {
  const r = await localRig()
  r.session.stop()
  assert.equal(await r.session.sendText('x'), false)
})

test('本機接線：按鈕字與提示字和看別台相同；送出走本機畫面，不呼叫別台開始、不出確認', () => {
  // 同一個 termCompose 決定按鈕字與提示字，本機也在裡面
  assert.match(pane, /const localCompose = computed\(\(\) => termShown\.value && Boolean\(props\.termViewApi\?\.input\) && !displayOnly\.value\)/)
  assert.match(pane, /const sendLabel = computed\(\(\) => \(termCompose\.value \? SEND_LABEL_TERM : SEND_LABEL\)\)/)
  const fn = pane.slice(pane.indexOf('    function sendToTerm(text) {'), pane.indexOf('\n    }\n', pane.indexOf('    function sendToTerm(text) {')))
  const local = fn.split('\n').find(l => l.includes('if (localCompose.value)'))
  assert.ok(local, 'sendToTerm 有本機分支')
  assert.match(local, /tvEl\.value\.sendLine\(text\)/, '交給本機畫面')
  assert.match(local, /return \}$/, '本機分支先 return，不走別台')
  assert.ok(!/remoteTyping|rinEl|start|confirm/.test(local), '本機不開別台打字通道、不跳確認')
  assert.ok(fn.indexOf('if (localCompose.value)') < fn.indexOf('remoteTyping.value = true'))
  assert.match(pane, /<term-view v-if="termShown" ref="tvEl" @unsent="restoreDraft"/, '沒送進去的字放回輸入框')
  // 本機畫面：同一套送字邏輯、送字走 session.sendText（termViewApi.input）；點進黑色區直接打字照舊
  assert.match(view, /import \{ createLineSender \} from '\.\/term-line\.mjs'/)
  assert.match(view, /send: \(data, paste\) => \{[^}]*session\.sendText\(data, paste\)/)
  assert.ok(view.includes('t.onData(d => typed(d, false, ime.recent()))'), '原本點進終端直接打字不動')
  assert.match(view, /emits: \['unsent'\]/)
  assert.ok(!/confirm\(|window\.confirm/.test(view), '沒有瀏覽器確認框')
})

test('多行確認：本機和看別台用同一句、同兩顆鈕（#1378，電腦手機一致）', () => {
  const view = read('../ui/lib/term-view.mjs'), remote = read('../ui/lib/term-remote-input.mjs')
  // 兩邊都只用 term-view.mjs 的 pasteSummary 和 PASTE_TEXT，不各寫一句
  assert.match(view, /pasteNote\.value = pasteSummary\(text, props\.name\)/)
  assert.match(remote, /\{\{ pasteSummary\(askPaste, name\) \}\}/)
  for (const src of [view, remote]) {
    assert.match(src, /\{\{ PASTE_TEXT\.yes \}\}/)
    assert.match(src, /\{\{ PASTE_TEXT\.no \}\}/)
    assert.doesNotMatch(src, /要貼上 /, '舊句子不能留著')
  }
})

test('每一次送多行都要先問：取消後再送一次照樣問，按送出才整段送＋Enter（#1372 鎖的行為，#1378 抽共用後不能壞）', async () => {
  const ask = { value: null }, sent = [], unsent = []
  const lines = createLineSender({ send: async (d, p) => { sent.push([d, p]); return true }, askPaste: ask, emit: (ev, t) => { if (ev === 'unsent') unsent.push(t) } })
  const two = 'echo a\necho b'
  for (let round = 1; round <= 3; round++) {
    lines.sendLine(two)
    assert.equal(ask.value, two, `第 ${round} 次送多行要先問`)
    assert.equal(sent.length, 0, `第 ${round} 次還沒確認就不能送`)
    assert.equal(lines.answer(false), true)
    assert.equal(ask.value, null)
    assert.deepEqual(unsent.at(-1), two, `第 ${round} 次取消要把字放回輸入框`)
  }
  lines.sendLine(two)
  assert.equal(ask.value, two, '取消三次後再送仍要問')
  assert.equal(lines.answer(true), true)
  await new Promise(r => setTimeout(r, ENTER_DELAY_MS + 50))
  assert.deepEqual(sent, [[two, true], ['\r', false]], '按送出才送整段（當成貼上）再按 Enter')
  lines.sendLine(two)
  assert.equal(ask.value, two, '送出過一次之後，下一次多行照樣要問')
})

test('smoke 的多行檢查用共用的按鈕字（改字時 smoke 不會再找舊字）', () => {
  const smoke = read('../scripts/smoke-desk-term.mjs')
  assert.match(smoke, /askBtn\(\$\{JSON\.stringify\(PASTE_TEXT\.yes\)\}\)/)
  assert.match(smoke, /askBtn\(\$\{JSON\.stringify\(PASTE_TEXT\.no\)\}\)/)
  assert.doesNotMatch(smoke, /askBtn\('貼上'\)/)
})
test('輸入框送來的字先去掉控制字元：ESC、Ctrl+C 之類不會被當成按鍵送出，Tab 和換行留著（看別台、看本機同一套）', async () => {
  const ESC = String.fromCharCode(27), ETX = String.fromCharCode(3), DEL = String.fromCharCode(127), CSI = String.fromCharCode(0x9b)
  assert.equal(stripControls(`a${ESC}[2Jb${ETX}c${DEL}d${CSI}e`), 'a[2Jbcde')
  assert.equal(stripControls('x\ty\nz'), 'x\ty\nz', 'Tab 與換行留著')
  assert.equal(stripControls('中文 ok'), '中文 ok')
  const ask = { value: null }, sent = []
  const lines = createLineSender({ send: async (d, p) => { sent.push([d, p]); return true }, askPaste: ask, emit: () => {} })
  lines.sendLine(`ls${ESC}${ETX}\t-l`)
  await new Promise(r => setTimeout(r, ENTER_DELAY_MS + 50))
  assert.deepEqual(sent, [['ls\t-l', false], ['\r', false]], '單行送出前去掉控制字元，Enter 照送')
  sent.length = 0
  lines.sendLine(ETX + ESC)
  await new Promise(r => setTimeout(r, ENTER_DELAY_MS + 50))
  assert.deepEqual(sent, [], '只有控制字元：什麼都不送，連 Enter 也不按')
  lines.sendLine(`a${ESC}\nb`)
  assert.equal(ask.value, 'a\nb', '多行先問的那段也已去掉控制字元')
  // 兩條路都走 createLineSender：看別台與看本機
  assert.match(read('../ui/lib/term-remote-input.mjs'), /createLineSender\(/)
  assert.match(read('../ui/lib/term-view.mjs'), /createLineSender\(/)
})

test('前一段多行還在等確認時又送一段：前一段交還給輸入框，不被蓋掉', () => {
  const ask = { value: null }, sent = [], unsent = []
  const lines = createLineSender({ send: async (d, p) => { sent.push([d, p]); return true }, askPaste: ask, emit: (ev, t) => { if (ev === 'unsent') unsent.push(t) } })
  lines.sendLine('a1\na2')
  assert.equal(ask.value, 'a1\na2')
  lines.sendLine('b1\nb2')
  assert.equal(ask.value, 'b1\nb2', '問的是新的這段')
  assert.deepEqual(unsent, ['a1\na2'], '前一段交還給輸入框')
  assert.equal(sent.length, 0, '都還沒確認，什麼都沒送')
})
