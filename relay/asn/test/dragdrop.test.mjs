import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Windows WebView2：Tauri 預設攔截系統檔案拖放，HTML5 dragstart／dragover／drop 就不會觸發（分頁拖曳排序會失效）
test('list 視窗關掉系統拖放攔截', () => {
  const conf = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const list = conf.app.windows.find(w => w.label === 'list')
  assert.ok(list)
  assert.equal(list.dragDropEnabled, false)
})

test('程式建立的視窗都關掉系統拖放攔截', () => {
  const s = fs.readFileSync(new URL('../src-tauri/src/wins.rs', import.meta.url), 'utf8')
  const builders = (s.match(/WebviewWindowBuilder::new\(/g) || []).length
  const disabled = (s.match(/\.disable_drag_drop_handler\(\)/g) || []).length
  assert.ok(builders >= 2)
  assert.equal(disabled, builders)
})
