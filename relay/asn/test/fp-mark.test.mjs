// 設備列的指紋小圖示（#1499）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FP_MARK_TEXT, deskFpMark, phoneFpMark } from '../ui/lib/fp-mark.mjs'
import { hasIcon, iconShapes } from '../ui/lib/line-icons.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('手機：核對過那台電腦是彩色「已確認指紋」，還沒核對是灰色「尚未確認指紋」；沒有紀錄不畫', () => {
  assert.deepEqual(phoneFpMark({ confirmed: true }), { on: true, label: '已確認指紋' })
  assert.deepEqual(phoneFpMark({ confirmed: false }), { on: false, label: '尚未確認指紋' })
  assert.equal(phoneFpMark(null), null)
})

test('電腦：記住了那支手機是彩色、說明帶 8 碼指紋；還沒記住是灰色', () => {
  assert.deepEqual(deskFpMark({ fingerprint: 'x' }, '3fa2 c91b'), { on: true, label: '已記住指紋 3fa2 c91b' })
  assert.deepEqual(deskFpMark({}, ''), { on: true, label: '已記住指紋' })
  assert.deepEqual(deskFpMark(null, ''), { on: false, label: FP_MARK_TEXT.deskOff })
  assert.equal(FP_MARK_TEXT.deskOff, '還沒記住指紋')
})

test('指紋圖形放在線條圖示裡（同一份給現代外觀與復古 Aero）；Aero 不隱藏、有底圈', () => {
  assert.ok(hasIcon('fingerprint'))
  assert.ok(iconShapes('fingerprint').every(([tag]) => tag === 'path'))
  const css = read('ui/style.css')
  assert.match(css, /\.fpm\{[^}]*border-radius:50%[^}]*background:/, 'Aero：圓形淺色底')
  assert.match(css, /\.fpm\.on\{color:var\(--online\)/)
  assert.match(css, /\.fpm\.off\{color:var\(--offline\)/)
  assert.doesNotMatch(css, /\.fpm\{[^}]*display:none/, 'Aero 也要看得到（不像 .lic 只給現代外觀）')
  assert.match(read('ui/modern.css'), /:root\[data-skin="modern"\] \.fpm\{background:none;border:0/, '現代：線條版、不加底圈')
  const src = read('ui/lib/fp-mark.mjs')
  for (const k of ["role: 'img'", "'aria-label': props.label", 'title: props.label', 'onPointerdown', "class: 'fpm-tip'"]) assert.ok(src.includes(k), `少了 ${k}`)
})

test('接線：電腦版只有手機那幾列畫圖示；兩邊都註冊元件', () => {
  const sp = read('ui/lib/settings-panel.mjs')
  assert.match(sp, /<fp-mark v-if="d\.phone && !d\.self"/)
  assert.match(sp, /components: \{[^}]*FpMark/)
  assert.doesNotMatch(sp, /class="dv-line"/, '列上不放狀態那一行')
  assert.match(read('ui/m.js'), /app\.component\('fp-mark', FpMark\)/)
})
