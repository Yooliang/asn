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

// html → 視窗名（寫進 ui.log 的來源標籤）。null＝主視窗（不帶標籤）。手機 m.html 也要裝（#2129 ①：手機也寫 ui.log）
export const PAGES = {
  'list.html': null,   // 主視窗：自己有 installUiLog({ invoke })，不帶來源標籤
  'chat.html': 'chat', 'login.html': 'login', 'onboard.html': 'onboard', 'panel.html': 'panel',
  'shot.html': 'shot', 'askpass.html': 'askpass', 'setup-progress.html': 'setup-progress', 'toast.html': 'toast',
  'm.html': 'mobile',
}
const entryOf = html => /<script type="module" src="([^"]+)"/.exec(read(html))?.[1]

test('ui 底下每個 html 頁面都登記在清單裡（新增頁面要先決定它寫不寫 ui.log）', () => {
  const htmls = fs.readdirSync(UI).filter(f => f.endsWith('.html')).sort()
  assert.deepEqual(htmls, Object.keys(PAGES).sort())
})

test('每個頁面入口（電腦與手機）都裝了 installUiLog（小窗帶視窗名）', () => {
  for (const [html, name] of Object.entries(PAGES)) {
    const js = read(entryOf(html))
    assert.match(js, /import \{ installUiLog \} from '\.\/lib\/ui-log\.mjs'/, `${html} 的入口沒匯入 installUiLog`)
    const expect = name === null ? /\ninstallUiLog\(\{ invoke \}\)/ : new RegExp(`\\ninstallUiLog\\(\\{ source: '${name}' \\}\\)`)
    assert.match(js, expect, `${html} 的入口沒裝 installUiLog`)
  }
})

test('手機 m.js 也裝 installUiLog；Rust 端 ui_log 指令與 ui_log 模組不再限電腦版，且在手機的 handler 清單裡註冊（#2129 ①）', () => {
  assert.match(read('m.js'), /\ninstallUiLog\(\{ source: 'mobile' \}\)/)
  const lib = fs.readFileSync(fileURLToPath(new URL('../src-tauri/src/lib.rs', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
  const cmd = /((?:#\[[^\n]*\]\n)*)fn ui_log\(/.exec(lib)
  assert.ok(cmd, '找不到 ui_log 指令')
  assert.doesNotMatch(cmd[1], /cfg\(desktop\)/, 'ui_log 指令不可以只在電腦版')
  const mod = /((?:#\[[^\n]*\]\n)*)mod ui_log;/.exec(lib)
  assert.ok(mod, '找不到 mod ui_log')
  assert.doesNotMatch(mod[1], /cfg\(desktop\)/, 'mod ui_log 不可以只在電腦版')
  const mobile = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  assert.ok(mobile, '找不到手機的 invoke_handler 區塊')
  assert.ok(mobile[1].split(',').map(s => s.trim()).includes('ui_log'), '手機的 handler 清單沒有註冊 ui_log')
  const desktop = /#\[cfg\(desktop\)\]\n\s*let builder = builder\s*\.[\s\S]*?\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  assert.ok(desktop && desktop[1].split(',').map(s => s.trim()).includes('ui_log'), '電腦的 handler 清單沒有註冊 ui_log')
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
