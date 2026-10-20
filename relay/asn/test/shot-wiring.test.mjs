// 截圖功能的接線守門：前端呼叫的 Rust 指令都有註冊、工具列有中文 aria-label 的截圖鈕、兩種視窗都把 shotApi 傳給對話區、
// 標註畫面與覆蓋視窗不用 v-html、貼上圖片走標註畫面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

test('前端用到的截圖指令都在 Rust 的 invoke_handler 裡', () => {
  const used = new Set()
  for (const f of ['ui/shot.js', 'ui/lib/tauri.mjs']) for (const m of read(f).matchAll(/invoke\('(shot_[a-z_]+)'/g)) used.add(m[1])
  assert.deepEqual([...used].sort(), ['shot_begin', 'shot_cancel', 'shot_focus', 'shot_image', 'shot_pick', 'shot_ready', 'shot_supported'])
  const lib = read('src-tauri/src/lib.rs')
  for (const c of used) assert.ok(lib.includes(`shot::${c}`), `${c} 沒註冊`)
})

test('工具列有截圖鈕：中文 aria-label，只在支援時顯示', () => {
  const t = read('ui/lib/chatpane.mjs')
  assert.match(t, /v-if="shotApi && shotOk"[^>]*aria-label="截圖"/)
  assert.match(t, /supported\(\)\.then/)
})

test('分離對話視窗與整合模式都把 shotApi 傳給對話區', () => {
  assert.match(read('ui/chat.html'), /:shot-api="shotApi"/)
  assert.match(read('ui/list.html'), /:shot-api="shotApi"/)
  assert.match(read('ui/chat.js'), /shotApi/)
  assert.match(read('ui/list.js'), /shotApi/)
})

test('貼上圖片先進標註畫面，不再直接送出', () => {
  const t = read('ui/lib/chatpane.mjs')
  const paste = t.slice(t.indexOf('function onPaste'), t.indexOf('function onPaste') + 400)
  assert.match(paste, /openAnnot\(/)
  assert.ok(!/sendFile\(/.test(paste))
})

test('標註畫面與覆蓋視窗：不用 v-html／innerHTML，按鈕都有中文 aria-label', () => {
  for (const f of ['ui/lib/annotator.mjs', 'ui/shot.js', 'ui/shot.html']) assert.ok(!/v-html|innerHTML/.test(read(f)), f)
  const a = read('ui/lib/annotator.mjs')
  for (const w of ['復原', '重做', '清除全部標註', '顏色：', '粗細：']) assert.ok(a.includes(w), w)
})

test('覆蓋視窗用的頁面有被 Tauri 打包（ui 資料夾內）且 Esc／右鍵可取消', () => {
  assert.ok(fs.existsSync(path.join(root, 'ui', 'shot.html')))
  const s = read('ui/shot.js')
  assert.match(s, /Escape/)
  assert.match(s, /contextmenu/)
})
