// #1548 ④ 設定頁「已安裝的工具」：版本是不是最新、登入狀態（只看不裝）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { toolStatusView, TOOL_STATUS_TEXT } from '../ui/lib/tool-status.mjs'
import { STATE, STATE_TEXT, SHORT_TEXT } from '../ui/lib/device-state.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const rd = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const row = o => ({ id: 'x', installed: true, version: '1.0.0', version_state: 'unknown', latest: '', login: 'unknown', login_count: 0, ...o })

test('#1548 最新版三種：已是最新版、有新版 X、暫時查不到；查不到絕不說過期', () => {
  assert.deepEqual(toolStatusView(row({ version_state: 'latest' })).latest, { kind: 'ok', text: '已是最新版' })
  assert.deepEqual(toolStatusView(row({ version_state: 'behind', latest: '0.48.0' })).latest, { kind: 'behind', text: '有新版 0.48.0' })
  assert.deepEqual(toolStatusView(row({ version_state: 'unknown' })).latest, { kind: 'unknown', text: '暫時查不到' })
  // 後端說有新版卻沒給版本號、或給了看不懂的狀態：都是查不到，不亂說
  assert.equal(toolStatusView(row({ version_state: 'behind', latest: '' })).latest.text, '暫時查不到')
  assert.equal(toolStatusView(row({ version_state: 'stale' })).latest.text, '暫時查不到')
  for (const s of ['latest', 'behind', 'unknown', 'weird']) assert.doesNotMatch(JSON.stringify(toolStatusView(row({ version_state: s, latest: '1.2.3' }))), /過期/)
})

test('#1548 登入三種：已登入（pi 帶家數）、沒有登入、登入狀態查不到；字沿用設備頁的統一狀態', () => {
  assert.deepEqual(toolStatusView(row({ login: 'in' })).login, { kind: 'in', text: SHORT_TEXT[STATE.LOGGED_IN] })
  assert.equal(SHORT_TEXT[STATE.LOGGED_IN], '已登入')
  assert.equal(toolStatusView(row({ login: 'in', login_count: 2 })).login.text, '已登入 2 家')
  assert.equal(toolStatusView(row({ login: 'in', login_count: 1 })).login.text, '已登入')
  assert.deepEqual(toolStatusView(row({ login: 'out' })).login, { kind: 'out', text: STATE_TEXT[STATE.LOGGED_OUT] })
  assert.equal(STATE_TEXT[STATE.LOGGED_OUT], '沒有登入')
  assert.deepEqual(toolStatusView(row({ login: 'unknown' })).login, { kind: 'unknown', text: '登入狀態查不到' })
  assert.equal(toolStatusView(row({ login: 'garbage' })).login.text, '登入狀態查不到')
})

test('#1548 每家一種：Claude 最新版＋已登入、Codex 有新版＋查不到、Grok 都查不到、pi 已登入 2 家', () => {
  const v = (o) => toolStatusView(row(o))
  assert.deepEqual([v({ version_state: 'latest', login: 'in' }).latest.text, v({ version_state: 'latest', login: 'in' }).login.text], ['已是最新版', '已登入'])
  assert.deepEqual([v({ version_state: 'behind', latest: '0.48.0' }).latest.text, v({}).login.text], ['有新版 0.48.0', '登入狀態查不到'])
  assert.deepEqual([v({}).latest.text, v({ login: 'in', login_count: 2 }).login.text], ['暫時查不到', '已登入 2 家'])
})

test('#1548 還沒回來：檢查中；查失敗（沒有資料）：兩格都寫查不到、原位說明不消失', () => {
  assert.equal(toolStatusView(undefined, true).latest.text, TOOL_STATUS_TEXT.checking)
  assert.equal(toolStatusView(undefined, true).login.text, TOOL_STATUS_TEXT.checking)
  const failed = toolStatusView(undefined, false)
  assert.deepEqual([failed.latest.text, failed.login.text], ['暫時查不到', '登入狀態查不到'])
})

test('#1548 畫面與接線：重新檢查鈕（動作說法、靠右）、打開啟動設定才查、重新檢查略過快取', () => {
  const panel = rd('ui/lib/settings-panel.mjs')
  assert.match(panel, /act\('launch-recheck'\)">\{\{ st\.launch\.checking \? '正在檢查…' : '重新檢查' \}\}/)
  assert.doesNotMatch(panel, /怎麼安裝|怎麼更新|進行安裝|進行更新/, '文字只放在 lib/tool-install.mjs 一份，畫面樣板不寫死')
  assert.ok(SETTING_OPS.includes('launch-recheck'))
  assert.match(rd('ui/style.css'), /\.launch-set \.sec-head \.aero-btn\{flex:none;margin-left:auto\}/, '窄版按鈕靠右')
  assert.match(rd('ui/style.css'), /\.launch-tools \.launch-login\{flex:none;margin-left:auto/, '登入狀態靠右、窄版換行後也靠右')
  const js = rd('ui/list.js')
  assert.match(js, /case 'launch-recheck': toolInstall\.clear\(\); await Promise\.all\(\[refreshCliTools\(\), refreshCliStatus\(true\)\]\)/)
  assert.match(js, /if \(normalizeCatKey\(k\) === 'launch'\) void refreshCliStatus\(false\)/)
  assert.match(rd('ui/lib/tauri.mjs'), /cliStatus: force => invoke\('ai_cli_status', \{ force: force === true \}\)/)
})

test('#1548 後端：命令已登記、只在電腦端；最新版只連三個官方網址、有逾時；登入不讀憑證檔', () => {
  const lib = rd('src-tauri/src/lib.rs')
  assert.match(lib, /agent_tools::ai_cli_status/)
  assert.match(rd('test/android.test.mjs'), /'ai_cli_status'/, '手機的指令清單與畫面不能用它')
  const net = rd('src-tauri/src/agent_setup/net.rs')
  assert.match(net, /LATEST_TIMEOUT: Duration = Duration::from_secs\(10\)/)
  const st = rd('src-tauri/src/agent_tools/status.rs')
  assert.match(st, /LATEST_TTL: Duration = Duration::from_secs\(6 \* 3600\)/)
  assert.match(st, /status_snapshot\(force, &TimedFetch, &CACHE\)/, '真的環境走短逾時的連線')
  assert.doesNotMatch(st.split('#[cfg(test)]')[0], /credentials|auth\.json|\.credentials|read_to_string/, '登入狀態只問 CLI 自己，不讀憑證檔')
  // 三個網址：Claude／Codex 在安裝流程原本的常數、Gemini 用 manifest；本檔不另寫網址
  assert.doesNotMatch(st.split('#[cfg(test)]')[0], /https?:\/\//)
})
