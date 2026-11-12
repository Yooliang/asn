// 看別台夥伴的終端時，下方輸入框直接打進那個終端（#1288，小良哥 2026-11-11 定案的四點）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SEND_LABEL, SEND_LABEL_TERM, composeTermHint } from '../ui/lib/compose.mjs'
import { ENTER_DELAY_MS } from '../ui/lib/term-remote-input.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const pane = read('../ui/lib/chatpane.mjs')
const input = read('../ui/lib/term-remote-input.mjs')

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
  assert.match(pane, /const termCompose = computed\(\(\) => canRemoteInput\.value && !displayOnly\.value && !viewRestartable\.value\)/, '只有電腦版看別台終端（有打字通道）時')
  // 已結束打字／離開超過寬限（狀態列有「重新看」）時退回「傳送」，不讓輸入框代替本人按「重新看」
  assert.match(pane, /const viewRestartable = computed\(\(\) => Boolean\(typingEndedNote\.value\) \|\| \(remoteBar\.value\?\.src === 'view' && remoteBar\.value\.restartable === true\)\)/)
})

test('打字元件：整句送出後隔一下再送 Enter；開始前先排著；多行先問；沒送出就交還', () => {
  assert.ok(ENTER_DELAY_MS > 0 && ENTER_DELAY_MS < 1000)
  assert.match(input, /const typeLine = \(text, multi\) => \{\s*void send\(text, multi\)\.then\(ok => \{\s*if \(!ok\) \{ emit\('unsent', text\); return \}\s*setTimeout\(\(\) => \{ void send\('\\r', false\) \}, ENTER_DELAY_MS\)/, '整句沒送出就交還；送出了才按 Enter')
  assert.match(input, /watch\(phase, p => \{ if \(p === 'typing'\) flush\(\) \}\)/, '開始打字了才送排著的那句')
  assert.match(input, /if \(pasteLines\(t\) > 1\) \{ lineAsk = true; askPaste\.value = t \}/, '多行先問')
  assert.match(input, /emits: \['back', 'status', 'unsent'\]/)
  const fin = input.slice(input.indexOf('    const finish = text => {'), input.indexOf('    const start = async'))
  assert.match(fin, /if \(left\) emit\('unsent', left\)/, '結束時還沒送的交還')
  assert.match(input, /if \(lineAsk\) \{ lineAsk = false; const t = askPaste\.value; askPaste\.value = null; if \(t\) emit\('unsent', t\) \}/, '等確認時又貼上：那句交還')
})
