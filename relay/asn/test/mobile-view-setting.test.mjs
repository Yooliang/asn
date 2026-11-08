// 設定頁「允許移動設備查看終端」（預設開；關掉後手機不能看這台）的畫面接線與守門
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const panel = read('../ui/lib/settings-panel.mjs'), list = read('../ui/list.js'), mod = read('../src-tauri/src/bridge/mod.rs'), lib = read('../src-tauri/src/lib.rs')

test('設定頁：有開關和一句寫給使用者的說明，沒有內部名詞', () => {
  assert.match(panel, /act\('bridge-mobile-view', \$event\.target\.checked\)/)
  assert.match(panel, /<span>允許移動設備查看終端<\/span>/)
  assert.match(panel, /關掉後，手機就不能看這台電腦上夥伴的終端/)
  assert.match(panel, /'bridge-mobile-view'/, '動作清單有登記')
})

test('接線：預設開（舊後端沒有欄位也顯示開著）、開關呼叫 Rust 指令', () => {
  assert.match(list, /mobileView: true/)
  assert.match(list, /mobileView: s\.mobile_view !== false/)
  assert.match(list, /case 'bridge-mobile-view': await setBridgeMobileView\(value === true\)/)
  assert.match(list, /invoke\('bridge_set_mobile_view', \{ on \}\)/)
  assert.match(list, /mobileView: bridge\.mobileView/, '傳給設定面板')
})

test('Rust：存在 bridge.json 的 mobile_view_off（預設開）；指令有登記', () => {
  assert.match(mod, /mobile_view: !s\.mobile_view_off/)
  assert.match(mod, /mobile_view_off: flag\("mobile_view_off"\)/)
  assert.match(lib, /fn bridge_set_mobile_view\(/)
  assert.match(lib, /bridge_set_perm_phone, bridge_set_mobile_view,/)
})

test('守門：進行中的觀看每次都用 view_allowed 重讀本機設定（含移動設備）', () => {
  assert.match(lib, /read_settings\(&self\.data_dir\)\.view_allowed\(self\.mobile\)/)
  assert.match(lib, /accept_request\(&row, &me_node, &known, &key, now_s, allow_mobile\)/)
  assert.match(lib, /Refused::MobileOff\) => Err\(view_stream::MOBILE_OFF/)
})
