// #2302 無邊框之後視窗要拖得動：對話標題列、分頁列、名單頂端都是拖曳區（Tauri 的 data-tauri-drag-region="deep"＝底下整棵子樹都算，
// 途中的按鈕、輸入框、role=tab 會自動擋掉），名牌與按鈕區明確標 false；Aero 不帶任何拖曳區。真正「點得到」的量測在冒煙探測 dragRegion。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SCENARIOS } from '../scripts/smoke-lib.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const bar = read('ui/lib/actionbar.mjs'), html = read('ui/list.html'), style = read('ui/style.css')

test('對話標題列（.mbar）整條是拖曳區，名牌與按鈕區擋掉；只有 LINE／現代外觀帶（Aero 不動）', () => {
  assert.match(bar, /<div class="mbar"[^>]*:data-tauri-drag-region="skin === 'line' \|\| skin === 'modern' \? 'deep' : null"/, '.mbar 要是 deep 拖曳區')
  assert.match(bar, /<div class="mbar-plate"[^>]*data-tauri-drag-region="false"/, '名牌不是拖曳區')
  assert.match(bar, /<div class="mbar-acts" data-tauri-drag-region="false"/, '通話／⋯ 按鈕區不是拖曳區')
})

test('名單頂端與分頁列：LINE 的自己卡片、LINE／現代的大分頁與分頁列是拖曳區；大頭貼選單擋掉', () => {
  assert.match(html, /<div class="me" :data-tauri-drag-region="skin === 'line' \? 'deep' : null"/)
  assert.match(html, /<nav class="top-tabs"[^>]*:data-tauri-drag-region="skin === 'line' \|\| skin === 'modern' \? 'deep' : null"/)
  assert.match(html, /<div class="tabbar"[^>]*:data-tauri-drag-region="skin === 'line' \|\| skin === 'modern' \? 'deep' : null"/)
  assert.match(html, /<ul class="av-menu"[^>]*data-tauri-drag-region="false"/)
})

test('上緣縮放把手只占最上面 5px，不吃掉拖曳區', () => {
  assert.match(style, /\.rz-n,\.rz-s\{left:8px;right:8px;height:5px;/)
})

test('冒煙：LINE、現代各三種版面 × 1.25／1.5／2 三種縮放都有量，另有 Aero 對照', () => {
  const d = SCENARIOS.filter(s => s.probe?.dragRegion)
  for (const skin of ['line', 'modern']) for (const layout of ['wide', 'narrow', 'narrowList']) for (const dpr of [1.25, 1.5, 2]) {
    assert.ok(d.some(s => s.probe.dragRegion.skin === skin && s.probe.dragRegion.layout === layout && s.dpr === dpr), `${skin} ${layout} ${dpr}`)
  }
  assert.ok(d.some(s => s.probe.dragRegion.skin === 'aero'))
})

test('小視窗（登入、設定／指引、開機引導）：標題列後面直接接 .pane 的，標題列改回 40px 高的一條可拖；對話視窗走 .mbar', () => {
  for (const skin of ['line', 'modern']) {
    const css = read(`ui/${skin}.css`)
    assert.ok(css.includes(`:root[data-skin="${skin}"] .titlebar:has(+ .pane){position:relative;top:auto;left:auto;right:auto;height:40px;flex:none}`), `${skin} 小視窗標題列`)
    assert.ok(css.includes(`:root[data-skin="${skin}"] .titlebar:has(+ .pane) .t-btns{height:40px}`))
  }
  for (const f of ['login', 'panel', 'onboard']) assert.match(read(`ui/${f}.html`), /<header class="titlebar" data-tauri-drag-region>\s*[\s\S]*?<\/header>\s*<div class="pane /, `${f}.html：標題列後面直接接 .pane`)
  const d = SCENARIOS.filter(s => s.probe?.dragRegion)
  for (const skin of ['line', 'modern']) for (const win of ['login', 'panel', 'onboard', 'chat']) for (const dpr of [1.25, 1.5, 2]) {
    assert.ok(d.some(s => s.name === `drag-${skin}-win-${win}-${String(dpr).replace('.', '_')}`), `${skin} ${win} ${dpr}`)
  }
})
