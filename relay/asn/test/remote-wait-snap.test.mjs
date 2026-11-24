// 遠端打字：等待時保留彩色畫面、不再有 0.2.33 之前的說法、stripAnsi 補漏（0.2.35）。
// 11-19 實況：送出後等待畫面變成純文字、顏色不見（#1762）；底圖改成把最後一幅畫面的原文直接寫進 xterm。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { INPUT_TEXT, INPUT_TIP } from '../ui/lib/term-remote-input.mjs'
import { composeRemoteHint } from '../ui/lib/compose.mjs'
import * as CK from '../ui/lib/confirm-kind.mjs'
import { stripAnsi, joinWrapped } from '../ui/lib/term-keys.mjs'
import * as TK from '../ui/lib/term-keys.mjs'
import { frameToWrite } from '../ui/lib/term-view.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ---- 底圖：等待時保留彩色畫面（#1762） ----
const COLORED = '\x1b[38:2::153:153:153m第一列\x1b[39m\r\n\x1b[0;1;31m第二列\x1b[0m\x1b(B\r\n'

test('等待底圖：寫進 xterm 的內容還帶著顏色碼（不是 stripAnsi 後的純文字）', () => {
  const w = frameToWrite({ text: COLORED })
  assert.ok(w.includes('\x1b[38:2::153:153:153m'), '全彩碼還在')
  assert.ok(w.includes('\x1b[0;1;31m'), '粗體紅還在')
  assert.ok(w.includes('第一列') && w.includes('第二列'))
  assert.notEqual(w, stripAnsi(w), '對照：純文字版會把顏色拿掉')
})

test('等待底圖：plainRows 已移除（沒有別的用途），複製畫面文字照舊接回折行', () => {
  assert.equal(TK.plainRows, undefined)
  assert.equal(joinWrapped('a\r\nb', 40), 'a\nb')
})

test('接線：底圖是畫面原文，不經 stripAnsi／plainRows；打字元件先建 xterm 寫進去，不再用 <pre> 純文字墊圖', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /const waitSnap = computed\(\(\) => remoteScreen\.value\.text\)/)
  assert.match(pane, /const screenPlain = computed\(\(\) => joinWrapped\(remoteScreen\.value\.text, remoteScreen\.value\.cols\)\)/)
  const line = pane.split('\n').find(l => l.includes('const waitSnap'))
  assert.ok(!/plainRows|stripAnsi/.test(line.split('//')[0]), '底圖那一行不能去顏色')
  const input = read('ui/lib/term-remote-input.mjs')
  assert.ok(!input.includes('term-wait-snap') && !/<pre/.test(input), '不再有純文字墊圖')
  assert.match(input, /term\.write\(frameToWrite\(\{ text: props\.snap \}\)\)/)
  assert.ok(input.indexOf('term.write(frameToWrite({ text: props.snap }))') < input.indexOf('props.api.start('), '先把畫面寫進 xterm，再去連那台')
  assert.match(input, /props\.snap !== null && phase\.value === 'starting'/, '等那台回覆前就要顯示 xterm 框')
  assert.match(input, /<p class="term-wait-note">\{\{ TEXT\.waitReply \}\}<\/p>/, '疊著的那條字還在')
  const css = read('ui/style.css')
  assert.ok(!css.includes('term-wait-snap'))
  assert.match(css, /\.term-wait-cover\{[^}]*pointer-events:none/)
  assert.ok(!/\.term-wait-cover\{[^}]*background/.test(css), '蓋層不能再塗黑底蓋掉彩色畫面')
})

// ---- stripAnsi 補漏 ----
test('stripAnsi：DCS／APC／SOS／PM 連內容整段吃掉', () => {
  assert.equal(stripAnsi('a\x1bP1$r0m\x1b\\b'), 'ab')
  assert.equal(stripAnsi('a\x1b_Gi=1;OK\x1b\\b'), 'ab')
  assert.equal(stripAnsi('a\x1b^privacy\x1b\\b'), 'ab')
  assert.equal(stripAnsi('a\x1bXsos\x07b'), 'ab')
})

test('stripAnsi：ESC 7／8／=／> 這類兩字元序列、落單的 SI／SO 不留殘字', () => {
  for (const k of ['7', '8', '=', '>']) assert.equal(stripAnsi('x\x1b' + k + 'y'), 'xy', 'ESC ' + k)
  assert.equal(stripAnsi('a\x0eb\x0fc'), 'abc')
})

test('stripAnsi：原本就要吃的照舊（冒號全彩、OSC 8、字元集）', () => {
  assert.equal(stripAnsi('\x1b[38:2::153:153:153mhi\x1b[0m\x1b(B'), 'hi')
  assert.equal(stripAnsi('\x1b]8;;https://claude.ai\x07link\x1b]8;;\x07'), 'link')
  assert.equal(stripAnsi('\x1b[?2026hok\x1b[?2026l'), 'ok')
})

// ---- 守門：畫面上不再有 0.2.33 之前的說法（遠端打字不再跳確認框，#1745） ----
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]))
test('守門：ui 裡不能再出現「要打字權限」「可能要按允許」這類說法', () => {
  const root = new URL('../ui', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const stale = ['要打字權限', '可能要按', '那邊的人要同意', '那邊的人可能', '請那邊的人同意', '那邊的人按過', '有人在電腦前按允許', '先設免問']
  const hits = []
  for (const f of walk(root)) {
    if (!/\.(m?js|html)$/.test(f) || f.includes('vendor')) continue
    const t = fs.readFileSync(f, 'utf8')
    for (const w of stale) if (t.includes(w)) hits.push(`${f}：${w}`)
  }
  assert.deepEqual(hits, [])
})

test('新說法：等待、輸入框提示、INPUT_TIP 都是白話；「那台需要先設免問」的提醒已移除', () => {
  assert.equal(INPUT_TEXT.waiting, '正在連到那台電腦……')
  assert.equal(INPUT_TEXT.waitReply, '正在連到那台電腦')
  assert.equal(composeRemoteHint('小乙', '辦公室'), '看辦公室「小乙」，送出即打字')
  assert.match(INPUT_TIP, /允許遠端在這台打字/)
  assert.equal(CK.AWAITING_CONSENT_HINT, undefined)
  const pane = read('ui/lib/chatpane.mjs')
  assert.ok(!pane.includes('consentHint') && !pane.includes('AWAITING_CONSENT_HINT'))
})
