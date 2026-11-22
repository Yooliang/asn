// 每個電腦視窗的 [ASN] 記錄都要寫進 ui.log（#2106 ⑥）：
// 出口失敗會 console.warn('[ASN]', 'invoke 失敗：…')，但只有裝了 installUiLog 的頁面，這行才會被送去 Rust 寫進 ui.log。
// 清單式守門：ui 底下每個 html 入口都要在下表，電腦頁面必須裝 installUiLog；新增頁面沒登記、或沒裝，就紅。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatUiLogLine, installUiLog } from '../ui/lib/ui-log.mjs'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const read = f => fs.readFileSync(UI + f, 'utf8')

// html → 視窗名（寫進 ui.log 的來源標籤）。null＝刻意不裝（手機：ui_log 指令只在電腦版，見 docs/日誌對照.md）
export const PAGES = {
  'list.html': null,   // 主視窗：自己有 installUiLog({ invoke })，不帶來源標籤
  'chat.html': 'chat', 'login.html': 'login', 'onboard.html': 'onboard', 'panel.html': 'panel',
  'shot.html': 'shot', 'askpass.html': 'askpass', 'setup-progress.html': 'setup-progress', 'toast.html': 'toast',
  'm.html': 'MOBILE',
}
const entryOf = html => /<script type="module" src="([^"]+)"/.exec(read(html))?.[1]

test('ui 底下每個 html 頁面都登記在清單裡（新增頁面要先決定它寫不寫 ui.log）', () => {
  const htmls = fs.readdirSync(UI).filter(f => f.endsWith('.html')).sort()
  assert.deepEqual(htmls, Object.keys(PAGES).sort())
})

test('每個電腦頁面入口都裝了 installUiLog（小窗帶視窗名）', () => {
  for (const [html, name] of Object.entries(PAGES)) {
    if (name === 'MOBILE') continue
    const js = read(entryOf(html))
    assert.match(js, /import \{ installUiLog \} from '\.\/lib\/ui-log\.mjs'/, `${html} 的入口沒匯入 installUiLog`)
    const expect = name === null ? /\ninstallUiLog\(\{ invoke \}\)/ : new RegExp(`\\ninstallUiLog\\(\\{ source: '${name}' \\}\\)`)
    assert.match(js, expect, `${html} 的入口沒裝 installUiLog`)
  }
})

test('手機 m.js 不裝（ui_log 指令只在電腦版）；Rust 端確實只在電腦版註冊', () => {
  assert.ok(!/installUiLog/.test(read('m.js')))
  const lib = fs.readFileSync(fileURLToPath(new URL('../src-tauri/src/lib.rs', import.meta.url)), 'utf8')
  assert.match(lib, /#\[cfg\(desktop\)\]\s*\r?\n#\[tauri::command\(async\)\][^\n]*\r?\nfn ui_log\(/)
})

test('askpass 不記錄輸入：askpass.js 沒有 console 輸出（裝 installUiLog 只轉送 [ASN] console 行）', () => {
  assert.ok(!/console\./.test(read('askpass.js')))
  assert.ok(!/console\./.test(read('lib/askpass-dialog.mjs')))
})

test('帶視窗名：[ASN] 後面插 [視窗名]，不是 [ASN] 開頭的不動', async () => {
  const T = new Date('2026-11-22T00:00:00Z')
  assert.equal(formatUiLogLine('warn', ['[ASN]', 'invoke 失敗：x y'], T, 'toast'), '2026-11-22T00:00:00.000Z warn [ASN] [toast] invoke 失敗：x y')
  assert.equal(formatUiLogLine('warn', ['[ASN]', 'a'], T), '2026-11-22T00:00:00.000Z warn [ASN] a')
  const sent = []; let fire
  const target = { info() {}, warn() {}, error() {} }
  installUiLog({ invoke: async (c, a) => sent.push(...a.lines), source: 'setup-progress', target, setTimer: fn => { fire = fn }, now: () => T })
  target.warn('[ASN]', 'invoke 失敗：setup_progress_cancel 壞了')
  await fire()
  assert.deepEqual(sent, ['2026-11-22T00:00:00.000Z warn [ASN] [setup-progress] invoke 失敗：setup_progress_cancel 壞了'])
})
