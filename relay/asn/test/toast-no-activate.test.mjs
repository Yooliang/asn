// 右下角提示與進度小窗不能搶焦點（todo-next-195）：`.focused(false)` 只管建窗當下，建完窗再 show() 在 Windows 走 SW_SHOW，
// ASN 在前景時會把系統前景與輸入焦點搶走，打字被打斷。Windows 上這兩種窗一律在建窗時就顯示，其他平台維持先設位置再顯示。
// 也不能改成自己呼叫 Win32 顯示：會少刷新外框，多出原生標題列（第一版修法實機看到的回歸）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src-tauri/src/wins.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const body = (start, end) => { const i = src.indexOf(start), j = src.indexOf(end, i); assert.ok(i >= 0 && j > i, `找不到 ${start}`); return src.slice(i, j) }
const NON_WINDOWS_SHOW = /if !cfg!\(windows\) \{\s*let _ = w\.show\(\);\s*\}/

function assertShownAtBuild(s) {
  const b = s.slice(s.indexOf('WebviewWindowBuilder::new'))
  assert.ok(b.includes('.focused(false)') && b.includes('.visible(cfg!(windows))'))
  assert.ok(b.includes('builder.position('), '建窗時就要給位置，否則會先在預設位置閃一下')
  assert.ok(NON_WINDOWS_SHOW.test(b), '其他平台要自己 show')
  assert.ok(!/\.show\(\)/.test(b.replace(NON_WINDOWS_SHOW, '')), 'Windows 建完窗不能再 show()')
}

test('提示視窗在建窗時顯示，建完不再 show', () => {
  assertShownAtBuild(body('pub async fn show_toast', '/// 點提示'))
})

test('進度小窗新開時在建窗時顯示；只有沿用舊窗才 show', () => {
  assertShownAtBuild(body('pub fn open_setup_progress', '/// 關小窗'))
})

test('不自己呼叫 Win32 顯示視窗', () => {
  assert.ok(!/ShowWindow/.test(src))
})
