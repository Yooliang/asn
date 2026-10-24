import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { inScrollableX, SCROLLX_SELECTOR } from '../ui/lib/mobile.mjs'

// 假元素：closest 只在選擇器符合時回自己
const el = (wide, sel = SCROLLX_SELECTOR) => ({ closest: s => (s === sel ? { scrollWidth: wide ? 900 : 300, clientWidth: 300 } : null) })

test('寬到需要橫向捲的表格或程式碼：在上面滑不換頁', () => {
  assert.equal(inScrollableX(el(true)), true)
})

test('沒有溢出的表格、不在表格裡、空值：照常可換頁', () => {
  assert.equal(inScrollableX(el(false)), false)
  assert.equal(inScrollableX({ closest: () => null }), false)
  assert.equal(inScrollableX(null), false)
})

test('接線守門：手機滑動起手會先問 inScrollableX；樣式有 md-tablewrap 橫向捲動', () => {
  const m = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(m, /if \(inScrollableX\(e\.target\)\) return/)
  assert.match(fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8'), /\.md-tablewrap\{[^}]*overflow-x:auto/)
})
