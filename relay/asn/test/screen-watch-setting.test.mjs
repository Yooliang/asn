// 夥伴卡住時跳提示：設定頁開關的接線（todo-next-162、#853）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('設定頁有開關，改了會送到後端；後端沒回報時當作開', () => {
  const panel = read('ui/lib/settings-panel.mjs'), list = read('ui/list.js')
  assert.ok(SETTING_OPS.includes('bridge-screen-watch'))
  assert.match(panel, /:checked="st\.bridge\.screenWatch"/)
  assert.match(panel, /act\('bridge-screen-watch', \$event\.target\.checked\)/)
  assert.match(list, /case 'bridge-screen-watch': await setBridgeScreenWatch\(value === true\)/)
  assert.match(list, /invoke\('bridge_set_screen_watch', \{ on \}\)/)
  assert.match(list, /screenWatch: s\.screen_watch !== false/, '預設開：舊後端沒有這個欄位也顯示開著')
})

test('說明照實寫：看畫面、不離開這台、支援範圍', () => {
  const panel = read('ui/lib/settings-panel.mjs')
  assert.match(panel, /定時看夥伴視窗的畫面/)
  assert.match(panel, /畫面內容不會離開這台電腦/)
  assert.match(panel, /只支援 Windows/)
})

test('Rust 接線：命令有註冊、改設定馬上生效、啟動時先讀設定再開背景工作', () => {
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /bridge_set_auto_resume, bridge_set_screen_watch,/)
  assert.match(lib, /m\.set_screen_watch\(on\)\?;\n\s+launch::term::screen_watch_set_user_off\(!on\);/)
  const init = lib.indexOf('screen_watch_set_user_off(bridge::read_settings(&data_dir).screen_watch_off)')
  assert.ok(init > 0 && init < lib.indexOf('start_screen_watch(terms.clone()'), '要先讀設定')
})
