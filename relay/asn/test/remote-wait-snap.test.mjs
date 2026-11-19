// 遠端打字：等待底圖照原本的列畫、不再有 0.2.33 之前的說法、stripAnsi 補漏（0.2.35）。
// 11-19 實況：送出後等待畫面的字疊在一起、有一列被擠到最右邊；原因是底圖用了「接回折行」的 joinWrapped。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { INPUT_TEXT, INPUT_TIP } from '../ui/lib/term-remote-input.mjs'
import { composeRemoteHint } from '../ui/lib/compose.mjs'
import * as CK from '../ui/lib/confirm-kind.mjs'
import { stripAnsi, plainRows, joinWrapped } from '../ui/lib/term-keys.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ---- 底圖：照原本的列畫，不接折行 ----
// 照 11-19 截圖：中文長段落在欄寬折成兩列、Claude 的 `⎿ Tip` 獨立一列（上一列被補空白到滿欄）
const COLS = 40
const SCREEN = [
  '  - 類別差異：手機只顯示十三類中的八類，兩邊內容各有出入',   // 寬度剛好滿欄（中文一字兩格）
  '    手機用另一頁自己畫一份，只有電腦有。',
  '✻ Beaming…'.padEnd(COLS, ' '),   // 狀態列被補空白到滿欄
  '  ⎿ Tip: Double-tap esc to rewind',
  '',
  '  bypass permissions on',
  '',
  '',
]

test('等待底圖：畫在畫面上的列數和原本一樣；接折行的舊做法會把列黏起來', () => {
  const text = SCREEN.join('\r\n')
  const rows = plainRows(text).split('\n')
  assert.equal(rows.length, 6, '只拿掉最後的空列，其餘列數不變')
  assert.equal(rows[1], '    手機用另一頁自己畫一份，只有電腦有。', '折行的續行還在自己那一列')
  assert.equal(rows[3], '  ⎿ Tip: Double-tap esc to rewind', 'Tip 還在自己那一列')
  assert.ok(joinWrapped(text, COLS).split('\n').length < rows.length, '對照：joinWrapped 會把滿欄的列和下一列黏成一長列（舊底圖疊字、續行擠到最右邊）')
})

test('等待底圖：帶顏色的畫面也只留看得見的字，列數不變', () => {
  const colored = '\x1b[38:2::153:153:153m第一列\x1b[39m\r\n\x1b[0;1m第二列\x1b[0m\x1b(B\r\n\r\n'
  assert.equal(plainRows(colored), '第一列\n第二列')
})

test('接線：底圖用 plainRows；複製畫面文字、找網址、判斷確認畫面照舊接回折行', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /const waitSnap = computed\(\(\) => plainRows\(remoteScreen\.value\.text\)\)/)
  assert.match(pane, /const screenPlain = computed\(\(\) => joinWrapped\(remoteScreen\.value\.text, remoteScreen\.value\.cols\)\)/)
  assert.ok(!/waitSnap = computed\(\(\) => screenPlain/.test(pane), '底圖不能再用接過折行的 screenPlain')
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
  assert.equal(composeRemoteHint('小乙'), '送出後會連到那台電腦，打進 小乙 的終端')
  assert.match(INPUT_TIP, /允許遠端在這台打字/)
  assert.equal(CK.AWAITING_CONSENT_HINT, undefined)
  const pane = read('ui/lib/chatpane.mjs')
  assert.ok(!pane.includes('consentHint') && !pane.includes('AWAITING_CONSENT_HINT'))
})
