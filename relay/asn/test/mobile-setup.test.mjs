// 手機版從手機替電腦安裝並登入 Claude Code（todo-next-174 的 F，#650）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GIVE_UP_MS, POLL_MS, SETUP_TEXT, setupErrorText, setupStateOf, setupView, showSetupButton } from '../ui/lib/mobile-setup.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('後台錯誤代碼對成人話：太舊要先更新、沒開著、太頻繁、手機不能裝；沒代碼的人話原樣；其他退回通用句', () => {
  assert.match(setupErrorText('setup:asn_outdated'), /版本太舊.*更新/)
  assert.match(setupErrorText(new Error('setup:asn_offline')), /沒有開著/)
  assert.match(setupErrorText('setup:rate_limited'), /太頻繁/)
  assert.match(setupErrorText('setup:unsupported_platform'), /手機不能安裝/)
  assert.match(setupErrorText('setup:not_found'), /找不到這台設備/)
  assert.equal(setupErrorText('連不上後台，請檢查網路'), '連不上後台，請檢查網路')
  for (const bad of ['', null, undefined, 'HTTP 500 internal error with a very long english text', { x: 1 }]) assert.equal(setupErrorText(bad), SETUP_TEXT.unknown, String(bad))
})

test('讀狀態：只認 pending／taken／done／failed；別台的、沒請求的、壞資料都是 null', () => {
  const nodes = [{ id: 'A', setup: null }, { id: 'B', setup: { state: 'taken', detail: null, replaced: null } }, { id: 'C', setup: { state: 'weird' } }, { id: 'D', setup: { state: 'done', detail: 'Claude Code 2.1.309 已安裝並登入', replaced: 'x' } }]
  assert.equal(setupStateOf(nodes, 'A'), null)
  assert.deepEqual(setupStateOf(nodes, 'B'), { state: 'taken', detail: '', replaced: '' })
  assert.equal(setupStateOf(nodes, 'C'), null)
  assert.equal(setupStateOf(nodes, 'Z'), null)
  assert.equal(setupStateOf(null, 'A'), null)
  assert.deepEqual(setupStateOf(nodes, 'D'), { state: 'done', detail: 'Claude Code 2.1.309 已安裝並登入', replaced: 'x' })
})

test('狀態對應畫面：等接手 → 已接手（提示登入網址會跳出頁面）→ 完成或失敗（用電腦回報的固定句子）', () => {
  const now = 1_000_000
  assert.deepEqual(setupView({ state: 'pending' }, { now }), { done: false, ok: false, text: SETUP_TEXT.pending, note: '' })
  const taken = setupView({ state: 'taken' }, { since: now - 1000, now })
  assert.equal(taken.done, false)
  assert.match(taken.text, /登入網址.*貼回授權碼/)
  const ok = setupView({ state: 'done', detail: 'Claude Code 2.1.309 已安裝並登入', replaced: '' }, { now })
  assert.deepEqual([ok.done, ok.ok, ok.text], [true, true, 'Claude Code 2.1.309 已安裝並登入'])
  const bad = setupView({ state: 'failed', detail: '你在手機上拒絕了這次登入', replaced: '原本的 Claude Code 看起來不是官方版本，重新安裝失敗，那支程式還在原位，請先不要使用' }, { now })
  assert.deepEqual([bad.done, bad.ok, bad.text], [true, false, '你在手機上拒絕了這次登入'])
  assert.match(bad.note, /還在原位/)
  assert.equal(setupView({ state: 'done', detail: '' }, { now }).text, SETUP_TEXT.doneOk)
  assert.equal(setupView({ state: 'failed', detail: '' }, { now }).text, SETUP_TEXT.failed)
})

test('等不到：剛送出還沒寫進去就繼續等；看過後來不見＝過期（電腦沒接手）；接手太久沒結果就不再等', () => {
  assert.equal(setupView(null, { sawRequest: false }).done, false)
  const gone = setupView(null, { sawRequest: true })
  assert.deepEqual([gone.done, gone.ok, gone.text], [true, false, SETUP_TEXT.expired])
  const now = 10 * GIVE_UP_MS
  const slow = setupView({ state: 'taken' }, { since: now - GIVE_UP_MS - 1, now })
  assert.deepEqual([slow.done, slow.text], [true, SETUP_TEXT.gaveUp])
  assert.equal(setupView({ state: 'taken' }, { since: now - GIVE_UP_MS + 1000, now }).done, false)
})

test('按鈕只在 Claude 區、而且「別台可以裝」時出現；每 5 秒查一次', () => {
  assert.equal(showSetupButton('claude', { kind: 'remote' }), true)
  for (const [k, a] of [['claude', { kind: 'local' }], ['claude', null], ['codex', { kind: 'remote' }], ['grok', { kind: 'remote' }]]) assert.equal(showSetupButton(k, a), false)
  assert.equal(POLL_MS, 5000)
})

test('接線守門：先確認才送出、送出只在「確認安裝」、離開頁面就停止輪詢、手機註冊了兩個指令、文字是人話', () => {
  const js = read('ui/m.js'), html = read('ui/m.html'), lib = read('src-tauri/src/lib.rs'), acct = read('src-tauri/src/account.rs')
  assert.match(js, /const setupAsk = node => \{ setupReset\(\); Object\.assign\(setupSt, \{ node, stage: 'confirm' \}\) \}/, '按鈕只進確認，不送出')
  const calls = js.match(/invoke\('setup_remote_request'/g) ?? []
  assert.equal(calls.length, 1, '只有一處送出')
  const yes = js.slice(js.indexOf('const setupYes'), js.indexOf('const setupClose'))
  assert.ok(yes.includes("if (setupSt.stage !== 'confirm') return") && yes.includes("invoke('setup_remote_request'"), '送出只在確認階段')
  assert.match(js, /setInterval\(\(\) => void setupPoll\(\), SETUP_POLL_MS\)/)
  assert.match(js, /acctToken\+\+; acctEpoch\+\+; setupReset\(\)/, '離開設備頁就停止輪詢')
  assert.match(html, /role="alertdialog"/)
  assert.match(html, /@click="setupAsk\(acctCur\.key\)"/)
  assert.match(html, /@click="setupYes"/)
  const phone = lib.slice(lib.indexOf('#[cfg(not(desktop))]'), lib.indexOf('let builder = builder\n        .setup'))
  assert.ok(phone.includes('account::setup_remote_request') && phone.includes('account::setup_remote_status'), '手機的指令清單要有')
  assert.match(acct, /pub async fn setup_remote_request[\s\S]*?"node_setup_request"/)
  assert.match(acct, /pub async fn setup_remote_status[\s\S]*?"node_setup_status"/)
  for (const t of Object.values(SETUP_TEXT).map(x => (typeof x === 'function' ? x('示範電腦') : x))) assert.doesNotMatch(t, /setup|install|asn_|https?:\/\//i, t)
})
