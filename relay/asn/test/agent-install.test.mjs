// 設備細部頁「安裝並登入 Claude Code」（todo-next-174 的 E2，#650）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { INSTALL_TEXT, createAgentInstall, installButton, installView, resultKind } from '../ui/lib/agent-install.mjs'
import { applyEvent, initialView } from '../ui/lib/setup-progress.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const plain = o => JSON.parse(JSON.stringify(o))

function make({ signedIn = true, allow = false, startError = null } = {}) {
  const calls = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'agent_setup_plan') return '將在這台電腦安裝官方的 Claude Code。'
    if (cmd === 'agent_setup_remote_allow_get') return allow
    if (cmd === 'agent_setup_start' && startError) throw new Error(startError)
    return null
  }
  const ui = createAgentInstall({ invoke, reactive: o => o, signedIn: async () => signedIn })
  return { ui, calls, s: ui.state }
}

test('按鈕：沒登入 ASN 帳號不能按、旁邊寫原因；做的時候也不能再按', () => {
  assert.deepEqual(installButton({ signedIn: false, running: false }), { disabled: true, hint: '請先登入你的 ASN 帳號' })
  assert.deepEqual(installButton({ signedIn: null, running: false }), { disabled: true, hint: INSTALL_TEXT.needLogin })
  assert.deepEqual(installButton({ signedIn: true, running: false }), { disabled: false, hint: '' })
  assert.equal(installButton({ signedIn: true, running: true }).disabled, true)
})

test('流程：按鈕 → 確認窗（Rust 給的固定文字）→ 確認才開始；先不要就回到只有按鈕', async () => {
  const { ui, calls, s } = make()
  await ui.ask()
  assert.equal(s.stage, 'confirm')
  assert.equal(s.plan, '將在這台電腦安裝官方的 Claude Code。')
  assert.ok(!calls.some(c => c[0] === 'agent_setup_start'), '還沒確認不能開始')
  ui.decline()
  assert.equal(s.stage, 'idle')
  await ui.ask(); await ui.confirm()
  assert.deepEqual(calls.filter(c => c[0] === 'agent_setup_start'), [['agent_setup_start', { confirmed: true }]])
  assert.equal(s.stage, 'running')
})

test('沒登入 ASN 帳號：按了也不開確認窗、不開始，寫「請先登入你的 ASN 帳號」', async () => {
  const { ui, calls, s } = make({ signedIn: false })
  await ui.ask()
  assert.equal(s.stage, 'idle')
  assert.equal(s.msg, INSTALL_TEXT.needLogin)
  assert.ok(!calls.some(c => c[0] === 'agent_setup_plan' || c[0] === 'agent_setup_start'))
  await ui.confirm()   // 沒在確認階段，直接呼叫也不會開始
  assert.ok(!calls.some(c => c[0] === 'agent_setup_start'))
})

test('開始失敗：回到按鈕，說明原因（例如已經有一輪在跑）', async () => {
  const { ui, s } = make({ startError: '這台電腦正在安裝並登入，請等它做完' })
  await ui.ask(); await ui.confirm()
  assert.equal(s.stage, 'idle')
  assert.equal(s.msg, '沒有開始：這台電腦正在安裝並登入，請等它做完')
})

test('進度：事件一路更新同一行；取消只記下要求、畫面照實說，做完才停', async () => {
  const { ui, calls, s } = make()
  await ui.ask(); await ui.confirm()
  ui.onEvent({ phase: 'checking', text: '正在確認這台電腦的現況' })
  ui.onEvent({ phase: 'installing', text: '正在下載並驗證 Claude Code' })
  ui.onEvent({ phase: 'login', text: '登入網址已送到你的手機，請在手機上開啟並貼回授權碼' })
  assert.deepEqual(installView(s).lines, ['登入網址已送到你的手機，請在手機上開啟並貼回授權碼'])
  assert.equal(installView(s).canCancel, true)
  await ui.cancel()
  assert.deepEqual(calls.filter(c => c[0] === 'agent_setup_cancel').length, 1)
  const v = installView(s)
  assert.equal(v.canCancel, false, '只能按一次')
  assert.ok(v.lines.includes('已要求取消。目前這一步做完就會停下來。'))
  await ui.cancel()
  assert.equal(calls.filter(c => c[0] === 'agent_setup_cancel').length, 1)
  ui.onEvent({ phase: 'done', ok: false, cancelled: true, text: '已在這台電腦上取消' })
  assert.equal(s.stage, 'done')
  assert.equal(installView(s).kind, 'cancelled')
})

test('手機要求的那一輪：沒按按鈕也會跟著顯示進度；上一輪結果還在畫面上時，新一輪從頭顯示', () => {
  const { ui, s } = make()
  ui.onEvent({ phase: 'installing', text: '正在下載並驗證 Claude Code' })
  assert.equal(s.stage, 'running')
  ui.onEvent({ phase: 'done', ok: true, text: 'Claude Code 2.1.309 已安裝並登入' })
  assert.equal(s.stage, 'done')
  ui.onEvent({ phase: 'reset' })
  assert.equal(s.stage, 'running')
  assert.deepEqual(plain(s.view), plain(initialView()))
  ui.onEvent({ phase: 'done', ok: true, text: 'x' })
  ui.onEvent({ phase: 'checking', text: '新的一輪' })
  assert.equal(s.stage, 'running')
  assert.equal(installView(s).lines[0], '新的一輪')
  ui.onEvent(null); ui.onEvent('x')   // 壞輸入不會炸
})

test('結果種類：成功／本來就好／剛裝完沿用登入／失敗／請在終端機登入／已取消', () => {
  const r = e => resultKind(applyEvent(initialView(), e))
  assert.equal(resultKind(initialView()), '')
  assert.equal(r({ phase: 'done', ok: true, text: 'a' }), 'ok')
  assert.equal(r({ phase: 'done', ok: true, already: true, text: 'a' }), 'already')
  assert.equal(r({ phase: 'done', ok: true, kept_login: true, text: 'a' }), 'kept')
  assert.equal(r({ phase: 'done', ok: false, text: 'a' }), 'failed')
  assert.equal(r({ phase: 'done', ok: false, terminal: true, text: '這台電腦已經用別的方式裝了 Claude Code，請在終端機登入' }), 'terminal')
  assert.equal(r({ phase: 'done', ok: false, cancelled: true, text: 'a' }), 'cancelled')
})

test('請在終端機登入：結果有「開啟終端機」鈕，走既有的登入用終端機指令；重裝說明接在結果下面', async () => {
  const { ui, calls, s } = make()
  await ui.ask(); await ui.confirm()
  ui.onEvent({ phase: 'done', ok: false, terminal: true, text: '這台電腦已經用別的方式裝了 Claude Code，請在終端機登入', replaced: '原本的 Claude Code 看起來不是官方版本，重新安裝失敗，那支程式還在原位，請先不要使用' })
  const v = installView(s)
  assert.equal(v.terminal, true)
  assert.deepEqual(v.lines, ['這台電腦已經用別的方式裝了 Claude Code，請在終端機登入', '原本的 Claude Code 看起來不是官方版本，重新安裝失敗，那支程式還在原位，請先不要使用'])
  await ui.openTerminal()
  assert.deepEqual(calls.at(-1), ['ai_cli_login', { toolId: 'claude' }])
  ui.dismiss()
  assert.equal(s.stage, 'idle')
})

test('「允許從手機替這台安裝並登入」：預設關，讀不到也當關；只有明確 true 才算開', async () => {
  assert.equal(make().s.remoteAllow, false)
  const a = make({ allow: true }); await a.ui.load(); assert.equal(a.s.remoteAllow, true)
  const bad = createAgentInstall({ invoke: async () => { throw new Error('x') }, reactive: o => o })
  await bad.load(); assert.equal(bad.state.remoteAllow, false)
  const nul = make({ allow: null }); await nul.ui.load(); assert.equal(nul.s.remoteAllow, false, '回傳空值也當關')
  const b = make(); await b.ui.setRemoteAllow(true)
  assert.deepEqual(b.calls.at(-1), ['agent_setup_remote_allow_set', { on: true }])
  assert.equal(b.s.remoteAllow, true)
  await b.ui.setRemoteAllow('yes')
  assert.equal(b.s.remoteAllow, false, '不是明確的 true 就當關')
})

test('接線守門：七個操作都有接、按鈕與確認窗在同一個畫面、自己這台才有、文字是人話', () => {
  const ops = ['install-ask', 'install-yes', 'install-no', 'install-cancel', 'install-terminal', 'install-close', 'install-allow']
  const list = read('ui/list.js'), panel = read('ui/lib/settings-panel.mjs')
  for (const op of ops) {
    assert.ok(SETTING_OPS.includes(op), `${op} 要在元件的操作清單`)
    assert.match(list, new RegExp(`case '${op}':`), `${op} 樞紐要接`)
    assert.ok(panel.includes(`act('${op}'`), `${op} 畫面要有`)
  }
  assert.match(panel, /curDev\.self && v\.key === 'claude'/)
  assert.match(panel, /v\.action && v\.action\.kind === 'local'/, '只有這台的 Claude 還能裝時才出現按鈕')
  assert.match(panel, /role="alertdialog"/, '確認窗跟按鈕同時上')
  assert.match(list, /void listen\('agent-setup', e => agentInstall\.onEvent\(e\)\)/)
  assert.match(list, /install: installView\(agentInstall\.state\)/)
  for (const t of Object.values(INSTALL_TEXT)) assert.doesNotMatch(t, /agent|setup|install|asn_|https?:/i, t)
})

test('入口預設關：電腦版的按鈕、允許從手機安裝的勾選和說明，畫面上都要先看入口開了沒', () => {
  const panel = read('ui/lib/settings-panel.mjs')
  assert.match(panel, /\bAGENT_INSTALL_UI, switchTargets/, '常數要交給畫面，不然永遠看不到')
  // 每個讀 st.install 決定顯示的區塊都要先看入口；裡面的子元素跟著外層一起藏
  const gates = panel.match(/v-if="[^"]*st\.install(?:\s|")[^"]*"?/g) ?? []
  assert.equal(gates.length, 3)
  for (const g of gates) assert.match(g, /^v-if="AGENT_INSTALL_UI && st\.install/, g)
})

test('電腦上按的那一輪也用右下角小窗；已有一輪在跑就不去動它的小窗', () => {
  const lib = read('src-tauri/src/lib.rs')
  const start = lib.slice(lib.indexOf('async fn agent_setup_start'), lib.indexOf('async fn agent_setup_start') + 2500)
  assert.ok(start.indexOf('is_busy()') > 0 && start.indexOf('is_busy()') < start.indexOf('open_setup_progress'), '先看有沒有在跑再開小窗')
  assert.match(start, /wins::progress_emit\(&h1, e\.to_json\(\)\)/)
  assert.match(start, /wins::close_setup_progress\(&h, round\)/, '結果留幾秒再關、而且認輪次')
  assert.match(start, /if !confirmed/, '沒確認不開始')
})
