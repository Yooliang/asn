// #903：終端字寬表（emoji、全形、中文佔 2 格，組合字 0 格）與 frameToWrite 的游標位置矩陣
import test from 'node:test'
import assert from 'node:assert/strict'
import { cellWidth, installWideChars, stringWidth, wezTermWidthProvider } from '../ui/lib/term-width.mjs'
import { frameToWrite, xtermOptions } from '../ui/lib/term-view.mjs'

test('字寬：ASCII 1 格；中文、全形字、全形逗號、emoji 2 格；組合字與零寬 0 格', () => {
  assert.equal(stringWidth('abc'), 3)
  assert.equal(stringWidth('幫我看'), 6)
  assert.equal(stringWidth('ＡＢＣ'), 6)
  assert.equal(stringWidth('，'), 2)
  assert.equal(stringWidth('✅'), 2)
  assert.equal(stringWidth('🙂'), 2)
  assert.equal(stringWidth('> ok ✅ 🙂 完成'), 2 + 3 + 2 + 1 + 2 + 1 + 4)
  assert.equal(cellWidth(0x301), 0)
  assert.equal(cellWidth(0x200d), 0)
  assert.equal(cellWidth(0xfe0f), 0)
  assert.equal(cellWidth(0x1b), 0)
  assert.equal(cellWidth(0x276f), 1, '❯ 是 1 格')
})

test('字寬提供者：寬度打包在第 1～2 位元，零寬字元接在前一個字上', () => {
  const p = wezTermWidthProvider
  assert.equal((p.charProperties(0x4e2d, 0) >> 1) & 3, 2)
  assert.equal((p.charProperties(0x41, 0) >> 1) & 3, 1)
  const wideProps = p.charProperties(0x1f642, 0)
  const joined = p.charProperties(0xfe0f, wideProps)
  assert.equal(joined & 1, 1, '接在前一個字上')
  assert.equal((joined >> 1) & 3, 2, '寬度沿用前一個字')
  assert.equal(p.charProperties(0xfe0f, 0) & 1, 0, '前面沒有字就不接')
})

test('installWideChars：註冊並啟用；沒有 unicode 介面的終端不動', () => {
  const seen = []
  const term = { unicode: { register: p => seen.push(['reg', p.version]), set activeVersion(v) { seen.push(['use', v]) } } }
  assert.equal(installWideChars(term), true)
  assert.deepEqual(seen, [['reg', 'asn-wide'], ['use', 'asn-wide']])
  assert.equal(installWideChars({}), false)
  assert.equal(installWideChars(null), false)
  assert.equal(installWideChars({ unicode: { register() { throw new Error('x') }, activeVersion: '' } }), false)
  assert.equal(xtermOptions({ cols: 80, rows: 24 }).allowProposedApi, true, '要有這個才能註冊字寬表')
})

// ---- frameToWrite 游標矩陣：每種組合，寫出去的第 cursor_y 列就是輸入列、最後的游標定位就是 cursor_y/cursor_x ----
const CRLF = '\r\n'
const rowsText = (n, tag = 'R') => Array.from({ length: n }, (_, i) => `${tag}${i}`)
/** --escapes 形式：每列一個 CRLF，整份最後多一個裸換行 */
const screen = lines => lines.join(CRLF) + CRLF + '\n'
function painted(text, meta) {
  const out = frameToWrite({ text, meta })
  const head = '\x1b[0m\x1b[H\x1b[2J'
  assert.ok(out.startsWith(head))
  const k = out.lastIndexOf('\x1b[0m\x1b[')
  const m = /^\x1b\[0m\x1b\[(\d+);(\d+)H$/.exec(out.slice(k))
  assert.ok(m)
  return { lines: out.slice(head.length, k).split(CRLF), row: Number(m[1]) - 1, col: Number(m[2]) - 1 }
}
const PROMPTS = ['> 幫我看一下ＡＢＣ，測試', '> ok ✅ 🙂 完成', '> abc']

for (const rows of [10, 40]) {
  for (const cy of [0, Math.floor(rows / 2), rows - 1]) {
    for (const scroll of [0, 2]) {
      for (const prompt of PROMPTS) {
        test(`903 矩陣：rows=${rows} 游標列=${cy} 捲動紀錄=${scroll} 輸入列=${prompt.slice(0, 6)}`, () => {
          const body = rowsText(rows)
          body[cy] = prompt
          const text = screen([...rowsText(scroll, 'SB'), ...body])
          const meta = { cursor_x: stringWidth(prompt), cursor_y: cy, cols: 120, rows }
          const p = painted(text, meta)
          assert.equal(p.row, cy)
          assert.equal(p.col, meta.cursor_x)
          assert.equal(p.lines[cy], prompt, '游標那一列的內容是輸入列')
          assert.ok(p.lines.length <= rows)
          assert.ok(!p.lines.some(l => l.startsWith('SB')), '捲動紀錄不寫進畫面')
        })
      }
    }
  }
}

test('903 矩陣：行數比 rows 少（只有 3 行，游標在最後一行／在下方空列）', () => {
  const a = painted(screen(['a', 'b', '> 中文']), { cursor_x: 6, cursor_y: 2, cols: 80, rows: 10 })
  assert.equal(a.lines.length, 3)
  assert.equal(a.lines[a.row], '> 中文')
  const b = painted(screen(['a', 'b', '> 中文']), { cursor_x: 0, cursor_y: 7, cols: 80, rows: 10 })
  assert.equal(b.row, 7, '游標在文字下方的空列，位置照窗格回報')
})

test('903 矩陣：最上面幾列是空列，不被吃掉、游標列對得上', () => {
  const p = painted(screen(['', '', '', '> 中文ＡＢ']), { cursor_x: 8, cursor_y: 3, cols: 80, rows: 10 })
  assert.deepEqual(p.lines.slice(0, 4), ['', '', '', '> 中文ＡＢ'])
  assert.equal(p.row, 3)
  assert.equal(p.col, 8)
})

test('903 矩陣：最後一列寫滿整列時，沒有多的換行（不會多捲一列），游標照回報位置', () => {
  const full = 'x'.repeat(120)
  const body = rowsText(40)
  body[39] = full
  const p = painted(screen(body), { cursor_x: 119, cursor_y: 39, cols: 120, rows: 40 })
  assert.equal(p.lines.length, 40)
  assert.equal(p.lines[39], full)
  assert.equal(p.row, 39)
  assert.equal(p.col, 119)
})

test('預設是文字樣式的符號（🖥 🌡 🗨）照 1 格，預設彩色的 emoji（✅ 🙂 🚀 🤖）2 格', async () => {
  const { cellWidth } = await import('../ui/lib/term-width.mjs')
  for (const ch of ['\u{1F5A5}', '\u{1F321}', '\u{1F5E8}']) assert.equal(cellWidth(ch.codePointAt(0)), 1, ch)
  for (const ch of ['\u2705', '\u{1F642}', '\u{1F680}', '\u{1F916}']) assert.equal(cellWidth(ch.codePointAt(0)), 2, ch)
})
