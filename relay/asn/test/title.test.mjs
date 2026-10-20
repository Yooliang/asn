// 視窗標題：名單、整合主視窗與右下角提示的標題列、<title>、tauri.conf 的視窗標題都是同一個英文名（小良哥指定，是介面中文的唯一例外）；太長要縮略不撐破按鈕。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const TITLE = 'Agent Sync Network Messenger'
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('標題：list.html／toast.html 的 <title> 與標題列、tauri.conf.json 都是同一個名字，舊名不留', () => {
  const list = read('../ui/list.html'), toast = read('../ui/toast.html'), conf = JSON.parse(read('../src-tauri/tauri.conf.json'))
  assert.ok(list.includes(`<title>${TITLE}</title>`))
  assert.ok(list.includes(`<span class="t-text"><span class="brand">${TITLE} <span class="ver">({{ version }})</span></span></span>`))   // 名單標題列後面接版本號
  assert.ok(toast.includes(`<span class="t-text"><span class="brand">${TITLE}</span></span>`))
  assert.ok(conf.app.windows.some(w => w.title === TITLE))
  for (const [n, t] of [['list.html', list], ['toast.html', toast], ['tauri.conf.json', JSON.stringify(conf)]]) assert.ok(!t.includes('即時通'), `${n} 還有舊名`)
})

test('標題列文字太長時縮略（ellipsis、不換行、可收縮），按鈕區不縮', () => {
  const css = read('../ui/style.css')
  const rule = /\.titlebar \.t-text\{([^}]*)\}/.exec(css)[1]
  for (const p of ['min-width:0', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis', 'flex:1']) assert.ok(rule.includes(p), p)
  assert.ok(/\.t-btns\{[^}]*flex:none/.test(css), '按鈕區不被擠壓')
})
