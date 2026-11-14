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

test('有顏色的彼此不同、灰色的一定帶記號：綠色只給確認過；沒確認、沒記住是灰＋「!」，確認過有勾', () => {
  assert.deepEqual(FP_KINDS, ['confirmed', 'unconfirmed', 'remembered', 'unknown'])
  const css = read('ui/style.css')
  // .fpm.unconfirmed,.fpm.unknown 合寫一條：兩個選擇器都找得到同一個顏色
  const color = k => {
    for (const [, sel, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (sel.split(',').map(x => x.trim()).includes(`.fpm.${k}`)) { const m = body.match(/(?:^|;)color:([^;]+)/); if (m) return m[1] }
    }
    return undefined
  }
  const GRAY = ['unconfirmed', 'unknown'], COLORED = ['confirmed', 'remembered']
  assert.equal(color('confirmed'), 'var(--online)')
  assert.equal(new Set(COLORED.map(color)).size, COLORED.length, '有顏色的彼此不同')
  assert.ok(GRAY.every(k => color(k) === color('unknown')), '沒確認、沒記住都是同一個灰（小良哥：沒通過就是灰色）')
  for (const k of GRAY) assert.ok(!COLORED.map(color).includes(color(k)), `${k} 是灰色，不跟有顏色的混`)
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

test('沒回報（#1499 審查）：在線卻還沒收到回報，列上留「沒回報」小標記；條件跟狀態行的「還沒收到這台的回報」一樣', async () => {
  const { deviceNoReport, deviceStateLine, STATE } = await import('../ui/lib/device-state.mjs')
  const v = state => [{ label: 'Claude', state }]
  for (const c of [
    { vendors: v(STATE.NO_REPORT) },
    { vendors: v(STATE.NO_REPORT), self: true, online: false },
    { vendors: v(STATE.LOGGED_IN) },
    { vendors: v(STATE.NO_REPORT), online: false },
    { vendors: v(STATE.NO_REPORT), phone: true },
    { vendors: v(STATE.NO_REPORT), cloud: true },
  ]) assert.equal(deviceNoReport(c), deviceStateLine(c) === '還沒收到這台的回報', JSON.stringify(c))
  assert.equal(deviceNoReport({ vendors: v(STATE.NO_REPORT) }), true)
  for (const [f, cls] of [['ui/m.html', 'm-dv-tag warn noreport'], ['ui/lib/settings-panel.mjs', 'dv-tag warn noreport']]) {
    assert.ok(read(f).includes(`<span class="${cls}" v-if="d.noReport" :title="DEVICE_TEXT.noReportTip" :aria-label="DEVICE_TEXT.noReportTip">{{ DEVICE_TEXT.noReportTag }}</span>`), f)
  }
  assert.match(read('ui/style.css'), /\.dv-tag\.warn\{background:#fff3d6/)
})
