// #1788 無邊框：LINE 與現代外觀比照 LINE 軟體拿掉標題列（沒有標題列文字、三顆鈕在右上角、對話標題列右側留白）；Aero 仍有標題列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { skinCss } from './skin-css.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

for (const skin of ['line', 'modern']) {
  const css = skinCss(skin)
  const sel = rest => `:root[data-skin="${skin}"] ${rest}`
  test(`${skin}：標題列的圖示與文字不顯示（沒有標題列文字）`, () => {
    assert.ok(css.includes(`${sel('.titlebar .t-icon')},\n${sel('.titlebar .t-text')}{display:none}`), '標題列文字沒藏起來')
  })
  test(`${skin}：三顆鈕在右上角，46×36，在 60px 高的標題列裡垂直置中`, () => {
    assert.ok(css.includes(`${sel('.t-btns')}{position:absolute;top:0;right:0;gap:0;height:60px;align-items:center}`), '三顆鈕沒有釘在右上角')
    assert.ok(css.includes(`${sel('.tb')}{width:46px;height:36px;`), '鈕不是 46×36')
  })
  test(`${skin}：對話標題列與分頁列右側留白，不被三顆鈕蓋住`, () => {
    assert.match(css, new RegExp(`${sel('.mbar').replace(/[[\]().]/g, '\\$&')},\\n.*\\.shell\\.only-chat \\.tabbar\\{padding-right:146px\\}`), '對話標題列右側沒有留白')
  })
}

test('現代：分離模式的名單視窗，上方大分頁右側讓出三顆鈕的位置', () => {
  assert.match(skinCss('modern'), /\.shell:not\(\.merged\) \.top-tabs[^{]*\{padding-right:146px\}/)
})

test('Aero 仍有標題列：標題列規則只在現代與 LINE 底下，頁面保留標題列文字與三顆鈕', () => {
  for (const f of ['modern.css', 'line.css']) {
    const css = read(`ui/${f}`)
    for (const m of css.matchAll(/^([^{@/]*\.t-btns[^{]*)\{/gm)) assert.ok(/^:root\[data-skin="(modern|line)"\]/.test(m[1].trim()), `${f}：${m[1]} 沒限定外觀`)
  }
  const style = read('ui/style.css')
  assert.ok(!/\.titlebar \.t-text\{display:none/.test(style), 'Aero 的標題列文字不能被藏起來')
  for (const page of ['list', 'chat']) {
    const html = read(`ui/${page}.html`)
    assert.ok(html.includes('class="t-text"') && html.includes('class="t-btns"'), `${page}.html 要保留標題列文字與三顆鈕（Aero 用）`)
  }
})

test('正式版不留 ?frameless 開關與原型樣式檔', () => {
  assert.ok(!read('ui/skin-boot.js').includes('frameless'))
  assert.ok(!fs.existsSync(new URL('../ui/frameless-proto.css', import.meta.url)))
  assert.ok(!read('scripts/smoke-lib.mjs').includes('frameless=1'))
})

test('無邊框情境：LINE 與現代各有寬、窄、對話、分割對話，Aero 一張對照', async () => {
  const { SCENARIOS } = await import('../scripts/smoke-lib.mjs')
  const names = SCENARIOS.filter(s => s.name.startsWith('frameless-')).map(s => s.name)
  for (const sk of ['line', 'modern']) for (const k of ['list-wide', 'chat-wide', 'list-narrow', 'chat-narrow', 'split-chat']) assert.ok(names.includes(`frameless-${sk}-${k}`), `缺 ${sk} ${k}`)
  assert.ok(names.includes('frameless-aero-chat-wide'))
})
