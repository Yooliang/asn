// 設定頁「檢視記錄」（#339）：設定的「關於」有入口；按下去呼叫 open_ui_log 開 ui.log；開不了就退回 open_machine_log_dir 開資料夾，
// 並在畫面說一句發生什麼。路徑一律由後端決定：前端呼叫不帶參數，Rust 指令簽名也沒有路徑參數，且只註冊在電腦版清單。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { VIEW_LOG_TEXT, openUiLog } from '../ui/lib/view-log.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const render = async (st, catKey = 'about') => {
  globalThis.Vue = Vue
  const app = Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey }) })
  return renderToString(app)
}

function fakeInvoke(fails = []) {
  const calls = [], logs = []
  const invoke = async (cmd, args) => { calls.push(args === undefined ? [cmd] : [cmd, args]); if (fails.includes(cmd)) throw `${cmd} 失敗` }
  return { invoke, calls, logs, log: (...a) => logs.push(a) }
}

test('設定的「關於」有「檢視記錄」按鈕與一行說明；別的分類沒有', async () => {
  const html = await render({ version: '9.9.9' })
  assert.match(html, /<button[^>]*>檢視記錄<\/button>/)
  assert.ok(html.includes('出問題時可以看這份記錄'))
  assert.ok('出問題時可以看這份記錄'.length <= 20, '說明 20 字內')
  assert.ok(!html.includes('role="status"'), '還沒按過不顯示說明')
  assert.ok(!(await render({ version: '9.9.9', launch: { tools: [], maxPerHour: 6, cwdText: '' } }, 'launch')).includes('檢視記錄'))
})

test('退回開資料夾時，說明顯示在按鈕下面', async () => {
  const html = await render({ version: '9.9.9', uiLogMsg: VIEW_LOG_TEXT.fallback })
  assert.ok(html.includes(VIEW_LOG_TEXT.fallback))
  assert.match(html, /role="status"[^>]*>記錄檔打不開，已改開記錄資料夾/)
})

test('按下去：送出 open-ui-log，樞紐接得住並交給 openUiLog', () => {
  assert.ok(SETTING_OPS.includes('open-ui-log'))
  const comp = read('ui', 'lib', 'settings-panel.mjs')
  assert.match(comp, /@click="act\('open-ui-log'\)">檢視記錄</)
  const hub = read('ui', 'list.js')
  const fn = hub.slice(hub.indexOf('const applySetting'), hub.indexOf('const pushSettings'))
  assert.match(fn, /case 'open-ui-log': uiLogMsg\.value = ''; uiLogMsg\.value = await openUiLog\(invoke\); break/)
  assert.match(hub, /uiLogMsg: uiLogMsg\.value/, '說明放進設定快照，分離模式的設定視窗也看得到')
})

test('開得了檔：只呼叫 open_ui_log（不帶參數），不顯示說明', async () => {
  const f = fakeInvoke()
  assert.equal(await openUiLog(f.invoke, f.log), '')
  assert.deepEqual(f.calls, [['open_ui_log']])
  assert.deepEqual(f.logs, [])
})

test('開不了檔：退回 open_machine_log_dir 開資料夾，畫面說一句；原因寫進記錄', async () => {
  const f = fakeInvoke(['open_ui_log'])
  assert.equal(await openUiLog(f.invoke, f.log), VIEW_LOG_TEXT.fallback)
  assert.deepEqual(f.calls, [['open_ui_log'], ['open_machine_log_dir']])
  assert.deepEqual(f.logs, [['[ASN] 開啟記錄檔失敗', 'open_ui_log 失敗']])
})

test('連資料夾也開不了：說資料夾也打不開，不丟錯', async () => {
  const f = fakeInvoke(['open_ui_log', 'open_machine_log_dir'])
  assert.equal(await openUiLog(f.invoke, f.log), VIEW_LOG_TEXT.failed)
  assert.equal(f.logs.length, 2)
  const e = fakeInvoke(); e.invoke = async () => { throw new Error('x') }
  assert.equal(await openUiLog(e.invoke, () => {}), VIEW_LOG_TEXT.failed)
})

test('路徑由後端決定：前端不帶參數；Rust 指令沒有路徑參數、只開機器資料夾的 ui.log', () => {
  const view = read('ui', 'lib', 'view-log.mjs')
  assert.match(view, /invoke\('open_ui_log'\)/)
  assert.doesNotMatch(view, /invoke\(\s*['"]open_ui_log['"]\s*,/)
  const lib = read('src-tauri', 'src', 'lib.rs')
  const m = /((?:(?:#\[[^\n]*\]|\/\/\/[^\n]*)\n)*)fn open_ui_log\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/.exec(lib)
  assert.ok(m, '找不到 open_ui_log')
  assert.match(m[1], /cfg\(desktop\)/)
  assert.equal(m[2], "app: State<'_, App>")
  assert.match(m[3], /machine_log_dir\(&app\.work_dir\)\?/)
  assert.match(m[3], /ui_log::existing\(&dir\)\?/)
  const ui = read('src-tauri', 'src', 'ui_log.rs')
  assert.match(ui, /pub fn existing\(dir: &Path\)[^{]*\{\s*let p = path\(dir\);\s*if p\.is_file\(\)/)
})

test('只註冊在電腦版的指令清單（手機沒有記錄檔可開）', () => {
  const lib = read('src-tauri', 'src', 'lib.rs')
  const at = [...lib.matchAll(/\.invoke_handler\(/g)].map(m => m.index)
  assert.equal(at.length, 2)
  const desktop = lib.slice(at[0], at[1])
  const mobile = lib.slice(at[1], lib.indexOf('.setup(', at[1]))
  assert.match(desktop, /\bopen_ui_log\b/)
  assert.doesNotMatch(mobile, /\bopen_ui_log\b/)
  assert.ok(!read('ui', 'm.js').includes('open_ui_log'), '手機版畫面不用這個入口')
})
