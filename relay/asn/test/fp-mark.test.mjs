// 設備列的指紋小圖示（#1499）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FP_KINDS, FP_MARK_TEXT, deskFpMark, phoneFpMark } from '../ui/lib/fp-mark.mjs'
import { hasIcon, iconShapes } from '../ui/lib/line-icons.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const rule = (css, sel) => (css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')) ?? [])[1] ?? ''

test('手機：核對過＝confirmed「已確認指紋」，還沒核對＝unconfirmed「尚未確認指紋」；沒有紀錄不畫', () => {
  assert.deepEqual(phoneFpMark({ confirmed: true }), { kind: 'confirmed', label: '已確認指紋' })
  assert.deepEqual(phoneFpMark({ confirmed: false }), { kind: 'unconfirmed', label: '尚未確認指紋' })
  assert.equal(phoneFpMark(null), null)
})

test('電腦：記住了＝remembered（不是 confirmed）、說明帶 8 碼；還沒記住＝unknown', () => {
  assert.deepEqual(deskFpMark({ fingerprint: 'x' }, '3fa2 c91b'), { kind: 'remembered', label: '已記住指紋 3fa2 c91b' })
  assert.deepEqual(deskFpMark({}, ''), { kind: 'remembered', label: '已記住指紋' })
  assert.deepEqual(deskFpMark(null, ''), { kind: 'unknown', label: FP_MARK_TEXT.deskOff })
  assert.equal(FP_MARK_TEXT.deskOff, '還沒記住指紋')
})

test('四種狀態顏色與形狀都不同：綠色只給確認過；未確認不是離線的灰；沒確認、沒記住有「!」，確認過有勾', () => {
  assert.deepEqual(FP_KINDS, ['confirmed', 'unconfirmed', 'remembered', 'unknown'])
  const css = read('ui/style.css')
  const color = k => (rule(css, `.fpm.${k}`).match(/(?:^|;)color:([^;]+)/) ?? [])[1]
  assert.equal(color('confirmed'), 'var(--online)')
  for (const k of ['unconfirmed', 'remembered', 'unknown']) {
    assert.ok(color(k) && color(k) !== 'var(--online)', `${k} 不能用綠色`)
    assert.notEqual(color(k), 'var(--offline)', `${k} 不能跟「離線」同色`)
  }
  assert.equal(new Set(FP_KINDS.map(color)).size, 4, '四種顏色都不同')
  assert.doesNotMatch(rule(css, '.fpm.unknown') + rule(css, '.fpm.unconfirmed'), /opacity/, '不做成反灰（看起來像沒作用）')
  // 形狀：記號跟著狀態走（不只靠顏色）
  const src = read('ui/lib/fp-mark.mjs')
  const badge = src.slice(src.indexOf('const BADGE'), src.indexOf('const LONG_MS'))
  assert.match(badge, /confirmed: \[\['path', \{ d: 'M3\.2 6\.2l1\.9 1\.9 3\.7-4' \}\]\]/, '確認過：勾')
  for (const k of ['unconfirmed', 'unknown']) assert.match(badge, new RegExp(`${k}: \\[\\['path', \\{ d: 'M6 2\\.8v3\\.6' \\}\\]`), `${k}：「!」`)
  assert.doesNotMatch(badge, /remembered/, '記住了不加記號')
})

test('指紋圖形放在線條圖示裡（同一份給現代外觀與復古 Aero）；Aero 不隱藏、有底圈；說明不會被切掉', () => {
  assert.ok(hasIcon('fingerprint'))
  assert.ok(iconShapes('fingerprint').every(([tag]) => tag === 'path'))
  const css = read('ui/style.css')
  assert.match(rule(css, '.fpm'), /border-radius:50%.*background:/, 'Aero：圓形淺色底')
  assert.doesNotMatch(rule(css, '.fpm'), /display:none/, 'Aero 也要看得到（不像 .lic 只給現代外觀）')
  assert.match(rule(css, '.fpm-tip'), /right:calc\(100% \+ 6px\);top:50%/, '說明放在圖示左邊')
  assert.match(read('ui/modern.css'), /:root\[data-skin="modern"\] \.fpm\{background:none;border:0/, '現代：線條版、不加底圈')
  const src = read('ui/lib/fp-mark.mjs')
  for (const k of ["role: 'img'", "'aria-label': props.label", 'title: props.label', 'onPointerdown', "class: 'fpm-tip'"]) assert.ok(src.includes(k), `少了 ${k}`)
})

test('接線：電腦版只有手機那幾列畫圖示；兩邊都註冊元件；沒有舊膠囊與狀態行的死碼', () => {
  const sp = read('ui/lib/settings-panel.mjs')
  assert.match(sp, /<fp-mark v-if="d\.phone && !d\.self" :kind="deskFpMark\(/)
  assert.match(sp, /components: \{[^}]*FpMark/)
  assert.doesNotMatch(sp, /class="dv-line"|dv-tag fp/, '列上不放狀態那一行與指紋膠囊')
  assert.match(read('ui/m.js'), /app\.component\('fp-mark', FpMark\)/)
  assert.doesNotMatch(read('ui/m.html'), /:on="|tagConfirmed|tagUnconfirmed/)
  assert.doesNotMatch(read('ui/style.css') + read('ui/mobile.css'), /\.dv-line\{|\.m-dv-line\{|\.dv-tag\.fp\{/)
})
