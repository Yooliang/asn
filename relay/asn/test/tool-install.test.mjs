// #1548 ⑤ 設定頁 Claude 那一列的「進行安裝／進行更新」（旗標預設關；只有 Claude；先確認再安裝）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LAUNCH_INSTALL_BTN, TOOL_INSTALL_TEXT, createToolInstall, installRowView } from '../ui/lib/tool-install.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const rd = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const IDS = ['claude', 'codex', 'agy', 'grok', 'pi']
const behind = { version_state: 'behind', latest: '2.1.0' }
const view = o => installRowView({ enabled: true, toolId: 'claude', installAvail: true, installed: true, status: {}, ...o })

test('#1548 ⑤ 旗標預設關：五家都沒有鈕（整個不渲染，不是灰掉）', () => {
  assert.equal(LAUNCH_INSTALL_BTN, false)
  for (const id of IDS) for (const installed of [true, false]) for (const status of [behind, { version_state: 'latest' }, undefined]) {
    assert.equal(installRowView({ toolId: id, installAvail: true, installed, status }), null, `${id} ${installed}`)   // 預設旗標
    assert.equal(installRowView({ enabled: false, toolId: id, installAvail: true, installed, status }), null)
  }
  // 畫面樣板：鈕全包在 v-if="t.install" 裡（null 就不產生 DOM），沒有 :disabled 偽裝
  const panel = rd('ui/lib/settings-panel.mjs')
  assert.match(panel, /<template v-if="t\.install">/)
  assert.doesNotMatch(panel, /launch-act"[^>]*:disabled/)
})

test('#1548 ⑤ 旗標開：只有 Claude、沒裝＝進行安裝、有新版＝進行更新；其他狀態與其他四家都沒有', () => {
  assert.equal(view({ installed: false }).label, '進行安裝')
  assert.equal(view({ installed: false }).showButton, true)
  assert.equal(view({ status: behind }).label, '進行更新')
  assert.equal(view({ status: behind }).showButton, true)
  for (const status of [{ version_state: 'latest' }, { version_state: 'unknown' }, undefined, { version_state: 'behind', latest: '' }]) {
    assert.equal(view({ status }), null, JSON.stringify(status))   // 已是最新、暫時查不到、裝了但查不到最新
  }
  for (const id of IDS.filter(i => i !== 'claude')) for (const installed of [true, false]) for (const status of [behind, undefined]) {
    assert.equal(installRowView({ enabled: true, toolId: id, installAvail: true, installed, status }), null, `${id} 不放鈕`)
  }
})

test('#1548 ⑤ 這台不能由 ASN 安裝（非 Windows、install_available 假或沒回）：不顯示', () => {
  for (const installAvail of [false, undefined, null, 'yes']) {
    assert.equal(view({ installAvail, installed: false }), null)
    assert.equal(view({ installAvail, status: behind }), null)
  }
})

const make = (install, refresh = async () => {}) => {
  const calls = { install: [], refresh: 0, log: [] }
  const t = createToolInstall({ reactive: o => o, install: async id => { calls.install.push(id); return install(id) }, refresh: async () => { calls.refresh++; await refresh() }, log: (...a) => calls.log.push(a) })
  return { t, calls }
}
const claudeView = (t, o) => installRowView({ enabled: true, toolId: 'claude', installAvail: true, ui: t.state, ...o })

test('#1548 ⑤ 按下先確認：取消不呼叫安裝；確認文字只講會發生什麼', () => {
  const { t, calls } = make(() => ({ ok: true, message: '', opened_login: false }))
  t.ask('install')
  const v = claudeView(t, { installed: false, status: undefined })
  assert.equal(v.showButton, false)
  assert.equal(v.confirm.yes, '同意並安裝')
  assert.match(v.confirm.text, /驗過數位簽章/)
  assert.doesNotMatch(v.confirm.text, /[？?]$|怎麼/)
  t.decline()
  assert.deepEqual([t.state.stage, calls.install.length, calls.refresh], ['idle', 0, 0])
  t.ask('update')
  assert.equal(claudeView(t, { installed: true, status: behind }).confirm.yes, '同意並更新')
  t.ask('codex')   // 不認得的種類不理
  assert.equal(t.state.kind, 'update')
})

test('#1548 ⑤ 同意後呼叫 ai_cli_install（只傳 claude）、原位顯示進度與成功、完成後重跑狀態', async () => {
  let release
  const { t, calls } = make(() => new Promise(r => { release = () => r({ ok: true, message: '內部原文', opened_login: true }) }))
  t.ask('install')
  const p = t.confirm()
  assert.equal(t.state.stage, 'running')
  const mid = claudeView(t, { installed: false, status: undefined })
  assert.equal(mid.running, TOOL_INSTALL_TEXT.runningInstall)
  assert.equal(mid.showButton, false, '進行中不能再按')
  t.ask('install'); assert.equal(t.state.stage, 'running', '進行中再按無效')
  release(); await p
  assert.deepEqual(calls.install, ['claude'])
  assert.equal(calls.refresh, 1)
  const done = claudeView(t, { installed: true, status: { version_state: 'latest' } })
  assert.equal(done.result.ok, true)
  assert.match(done.result.text, /已安裝完成/)
  assert.doesNotMatch(done.result.text, /內部原文/)
  assert.equal(done.showButton, false, '裝好、重查後鈕消失，結果那行字留著')
})

test('#1548 ⑤ 失敗（回 ok:false 或丟錯）：白話顯示、原文只進 log、完成後一樣重跑狀態、鈕還在可重試', async () => {
  for (const fail of [() => ({ ok: false, message: 'HTTP 503 C:\\secret\\path', opened_login: false }), () => { throw new Error('boom 0x80070005') }]) {
    const { t, calls } = make(fail)
    t.ask('install'); await t.confirm()
    const v = claudeView(t, { installed: false, status: undefined })
    assert.equal(v.result.ok, false)
    assert.equal(v.result.text, TOOL_INSTALL_TEXT.failInstall)
    assert.doesNotMatch(v.result.text, /503|secret|boom|0x8/)
    assert.match(JSON.stringify(calls.log), /503|boom/)
    assert.equal(calls.refresh, 1)
    assert.equal(v.showButton, true)
  }
  // 重查本身失敗不吞結果
  const { t, calls } = make(() => ({ ok: true, message: '', opened_login: false }), () => { throw new Error('recheck down') })
  t.ask('update'); await t.confirm()
  assert.equal(t.state.ok, true)
  assert.match(JSON.stringify(calls.log), /recheck down/)
})

test('#1548 ⑤ 接線：命令名、動作登記、不動 AGENT_INSTALL_UI、窄版按鈕靠右', () => {
  for (const op of ['launch-install-ask', 'launch-install-yes', 'launch-install-no']) assert.ok(SETTING_OPS.includes(op), op)
  assert.match(rd('ui/lib/tauri.mjs'), /cliInstall: toolId => invoke\('ai_cli_install', \{ toolId \}\)/)
  const js = rd('ui/list.js')
  assert.match(js, /LAUNCH_INSTALL_BTN === true \|\| globalThis\.__smokeLaunchInstallBtn === true/)
  assert.match(js, /case 'launch-install-yes': await toolInstall\.confirm\(\)/)
  assert.match(rd('ui/lib/device-state.mjs'), /export const AGENT_INSTALL_UI = false/)
  const css = rd('ui/style.css')
  assert.match(css, /\.launch-tools \.launch-act\{flex:none;margin-left:auto\}/)
  assert.match(css, /\.launch-install-btns\{display:flex;gap:8px;justify-content:flex-end\}/)
  assert.doesNotMatch(rd('ui/lib/tool-install.mjs'), /怎麼安裝|怎麼更新/)
})
