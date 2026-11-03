// 右下角提示與進度小窗不能搶焦點（todo-next-195）：`.focused(false)` 只管建窗當下，之後的 w.show() 在 Windows 走 SW_SHOW，
// ASN 在前景時會把系統前景與輸入焦點搶走，打字被打斷。這兩種窗一律用 show_no_activate 顯示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src-tauri/src/wins.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const body = (start, end) => { const i = src.indexOf(start), j = src.indexOf(end, i); assert.ok(i >= 0 && j > i, `找不到 ${start}`); return src.slice(i, j) }

test('提示視窗顯示時不啟用', () => {
  const s = body('pub async fn show_toast', '/// 點提示')
  assert.ok(s.includes('show_no_activate(&w)'))
  assert.ok(!/\.show\(\)/.test(s), '不能直接呼叫 show()')
})

test('進度小窗顯示時不啟用（新開與沿用舊窗）', () => {
  const s = body('pub fn open_setup_progress', '/// 關小窗')
  assert.equal((s.match(/show_no_activate\(&w\)/g) || []).length, 2)
  assert.ok(!/\.show\(\)/.test(s), '不能直接呼叫 show()')
})

test('Windows 用 SW_SHOWNOACTIVATE', () => {
  const s = body('fn show_no_activate', '#[cfg(not(windows))]')
  assert.ok(s.includes('SW_SHOWNOACTIVATE'))
  assert.ok(!/\bSW_SHOW\b/.test(s))
})
