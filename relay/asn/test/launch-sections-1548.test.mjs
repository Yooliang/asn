// #1548 ①：啟動設定頁分成四區，說明文字只留使用者能動手的話（純畫面）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LAUNCH_MAX_NOTE } from '../ui/lib/launch-prefs.mjs'

const rd = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const panel = rd('ui/lib/settings-panel.mjs')
const launch = panel.slice(panel.indexOf(`<template v-if="catKey === 'launch'">`), panel.indexOf(`<template v-if="catKey === 'usage'">`))
const pos = s => { const i = launch.indexOf(s); assert.ok(i > 0, `啟動設定頁找不到：${s}`); return i }

test('#1548 啟動設定頁分成四區，順序是已安裝的工具、外掛與互通、安全限制、進階', () => {
  const order = ['<h3 class="sec-h">已安裝的工具</h3>', '<h3 class="sec-h">外掛與互通</h3>', '<h3 class="sec-h">安全限制</h3>', '<summary>進階</summary>'].map(pos)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '四個標題要照順序')
})

test('#1548 各欄位歸對區：CLI 清單在工具、Claude 外掛與 pi 互通在外掛與互通、白名單與上限在安全限制、密碼小幫手在進階裡', () => {
  const [tools, plug, safe, adv] = ['已安裝的工具</h3>', '外掛與互通</h3>', '安全限制</h3>', '<summary>進階'].map(pos)
  const within = (needle, lo, hi) => { const i = pos(needle); assert.ok(i > lo && i < hi, `${needle} 不在該區`) }
  within('class="launch-tools"', tools, plug)
  within('aria-label="Claude 外掛"', plug, safe)
  within('aria-label="pi 與 ASN 互通"', plug, safe)
  within('工作資料夾白名單', safe, adv)
  within('id="set-note-launch-max"', safe, adv)
  within('aria-label="密碼小幫手"', adv, launch.length)
  assert.match(launch, /<details class="set-adv"/, '進階是可折疊的')
})

test('#1548 清單樣式：名稱與版本分欄（launch-tools 有 css、名稱欄有固定寬度），窄版按鈕靠右', () => {
  const css = rd('ui/style.css')
  assert.match(css, /\.launch-tools li\{display:flex/)
  assert.match(css, /\.launch-tools \.launch-name\{[^}]*width:\d+px/)
  assert.match(css, /\.launch-set \.upd-row\{[^}]*justify-content:flex-end/)
  assert.match(css, /\.launch-set \.set-card>\.aero-btn\{[^}]*align-self:flex-end/)
})

test('#1548 說明文字只寫使用者能動手的話：不出現解釋系統的字眼、每小時上限說明是一句', () => {
  const texts = [launch.replace(/<[^>]+>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' '), LAUNCH_MAX_NOTE].join('\n')
  for (const w of ['偵測', 'launcher.json', '自動產生', '不上傳雲端', '新裝時預設']) assert.ok(!texts.includes(w), `不該出現「${w}」`)
  assert.equal(LAUNCH_MAX_NOTE, '超過時對方會看到提示，下一個小時就能再開。')
  assert.ok(LAUNCH_MAX_NOTE.length <= 30, '說明很短')
  assert.doesNotMatch(launch, /class="launch-note"/)
})
