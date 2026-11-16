// 手機版從手機替電腦安裝並登入 Claude Code（todo-next-174 的 F，#650）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GIVE_UP_MS, PENDING_WAIT_MS, POLL_FAIL_MAX, POLL_MS, SETUP_TEXT, setupErrorText, setupLeadOf, setupStateOf, setupStep, setupView, showSetupButton } from '../ui/lib/mobile-setup.mjs'
import { AGENT_INSTALL_UI } from '../ui/lib/device-state.mjs'

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

test('入口打開時，按鈕只在 Claude 區、而且「別台可以裝」時出現；每 5 秒查一次', () => {
  assert.equal(showSetupButton('claude', { kind: 'remote' }, true), true)
  for (const [k, a] of [['claude', { kind: 'local' }], ['claude', null], ['codex', { kind: 'remote' }], ['grok', { kind: 'remote' }]]) assert.equal(showSetupButton(k, a, true), false)
  assert.equal(POLL_MS, 5000)
})

test('入口預設關：手機版看不到「從手機安裝並登入」，畫面只靠這個判斷出現', () => {
  assert.equal(AGENT_INSTALL_UI, false)
  assert.equal(showSetupButton('claude', { kind: 'remote' }), false)
  const html = read('ui/m.html')
  assert.match(html, /v-if="v\.key === 'claude' && \(\(\(showSetupButton\(v\.key, v\.action\) \|\| showReloginButton\(v\.key, v\.relogin\)\) && setupSt\.stage === 'idle'\)/)
  // 入口兩顆（#1512 C 多了「重新登入 Claude」），都只進確認
  assert.equal((html.match(/setupAsk\(/g) ?? []).length, 2, '送出要求的入口只有安裝與重新登入兩顆按鈕')
  assert.match(html, /v-if="showReloginButton\(v\.key, v\.relogin\)" @click="setupAsk\(acctCur\.key, 'relogin'\)"/)
})

test('重新登入 Claude（#1512 C）：只看那台回報登入失效，不受安裝入口的總開關影響；這只是入口，放不放行由那台電腦決定', async () => {
  const { showReloginButton, RELOGIN_TEXT } = await import('../ui/lib/mobile-setup.mjs')
  const { reloginAction, STATE } = await import('../ui/lib/device-state.mjs')
  assert.equal(showReloginButton('claude', { kind: 'remote' }), true, '不看 AGENT_INSTALL_UI')
  assert.equal(showReloginButton('codex', { kind: 'remote' }), false)
  assert.equal(showReloginButton('claude', null), false)
  const base = { vendor: 'claude', online: true, asnOnline: true, state: STATE.LOGIN_FAILED }
  assert.deepEqual(reloginAction(base), { kind: 'remote' })
  for (const [k, v] of [['isSelf', true], ['phone', true], ['online', false], ['asnOnline', false], ['vendor', 'codex']]) assert.equal(reloginAction({ ...base, [k]: v }), null, k)
  for (const s of Object.values(STATE).filter(s => s !== STATE.LOGIN_FAILED)) assert.equal(reloginAction({ ...base, state: s }), null, s)
  // #1592：確認字和實際會發生的事一致——送登入網址到這支手機；那台登入正常就只回報不需要重新登入
  assert.match(RELOGIN_TEXT.confirmBody, /那台電腦會把登入網址送到這支手機/)
  assert.match(RELOGIN_TEXT.confirmBody, /如果那台目前登入正常，會告訴你不需要重新登入/)
  // 重新登入不受安裝開關限制：不再要求那台打開「允許從手機替這台安裝並登入」，改成同一個帳號、而且已經裝好
  assert.doesNotMatch(RELOGIN_TEXT.confirmNeed, /允許從手機/)
  assert.match(RELOGIN_TEXT.confirmNeed, /登入著同一個 ASN 帳號/)
  assert.match(RELOGIN_TEXT.confirmNeed, /已經裝好 Claude Code（重新登入不會替它安裝）/)
})

test('等電腦接手：送出 20 秒還沒進到 taken／done／failed 就說沒有回應；接手後不套這條', () => {
  const t0 = 5_000_000
  const view = (st, dt, o = {}) => setupView(st, { since: t0, now: t0 + dt, ...o })
  assert.equal(PENDING_WAIT_MS, 20000)
  for (const st of [null, { state: 'pending' }]) {
    assert.deepEqual([view(st, PENDING_WAIT_MS).done, view(st, PENDING_WAIT_MS).text !== SETUP_TEXT.noReply], [false, true], '剛好 20 秒還繼續等')
    const late = view(st, PENDING_WAIT_MS + 1)
    assert.deepEqual([late.done, late.ok, late.text], [true, false, SETUP_TEXT.noReply])
  }
  assert.equal(SETUP_TEXT.noReply, '這台電腦沒有回應，請確認它的 ASN 開著，稍後再試')
  // 曾經進到 taken（reached）就不算沒回應，用原本的 45 分鐘上限
  assert.equal(view({ state: 'taken' }, 60_000, { reached: true }).done, false)
  assert.equal(view({ state: 'taken' }, 60_000).done, false, 'taken 本身就是接手')
  assert.equal(view({ state: 'done', detail: 'ok' }, 60_000).done, true)
  // 看過後來不見、也沒接手，超過 20 秒一樣說沒有回應（比「過期」更早）
  assert.equal(view(null, 30_000, { sawRequest: true }).text, SETUP_TEXT.noReply)
  assert.equal(view(null, 1000, { sawRequest: true }).text, SETUP_TEXT.expired)
})

test('每輪查狀態：連續失敗 3 次就說暫時讀不到；中間成功一次就重算；接手後記起來', () => {
  const t0 = 7_000_000
  let s = { since: t0, saw: false, reached: false, fails: 0 }
  const step = (res, dt = 1000) => { const r = setupStep(s, res, t0 + dt); s = r.next; return r.view }
  assert.equal(POLL_FAIL_MAX, 3)
  assert.equal(step({ ok: false }), null)
  assert.equal(step({ ok: false }), null)
  const v = step({ ok: false })
  assert.deepEqual([v.done, v.ok, v.text], [true, false, SETUP_TEXT.pollFail])
  assert.equal(SETUP_TEXT.pollFail, '暫時讀不到狀態，請稍後再試')
  // 失敗兩次、成功一次：重算，不會因為累積而結束
  s = { since: t0, saw: false, reached: false, fails: 0 }
  step({ ok: false }); step({ ok: false })
  assert.equal(step({ ok: true, st: { state: 'pending', detail: '', replaced: '' } }).done, false)
  assert.equal(s.fails, 0)
  step({ ok: false }); step({ ok: false })
  assert.equal(step({ ok: true, st: { state: 'taken', detail: '', replaced: '' } }).done, false)
  assert.deepEqual([s.fails, s.saw, s.reached], [0, true, true])
  // 接手之後的 20 秒不再算沒回應；pending 超過 20 秒才算
  assert.equal(step({ ok: true, st: { state: 'taken', detail: '', replaced: '' } }, 120_000).done, false)
  s = { since: t0, saw: false, reached: false, fails: 0 }
  assert.equal(step({ ok: true, st: { state: 'pending', detail: '', replaced: '' } }, 21_000).text, SETUP_TEXT.noReply)
  // 查不到的錯誤不會被當成「沒有請求」而結束成過期
  s = { since: t0, saw: true, reached: false, fails: 0 }
  assert.equal(step({ ok: false }, 1000), null)
})

test('後台回已經有進行中的要求：明說，再顯示它的狀態', () => {
  assert.equal(setupLeadOf({ ok: true, already: true, state: 'taken' }), '這台電腦已經有一個進行中的要求')
  for (const r of [{ ok: true, already: false }, { ok: true }, null, undefined, { already: 'true' }]) assert.equal(setupLeadOf(r), '', JSON.stringify(r))
})

test('失敗要醒目：結果用 role="alert"，失敗時把設備卡捲到看得見；重新登入才帶 mode；進行中的說明在畫面上', () => {
  const js = read('ui/m.js'), html = read('ui/m.html')
  assert.match(html, /:role="setupSt\.stage === 'done' && !setupSt\.ok \? 'alert' : 'status'"/)
  assert.match(html, /<p class="m-fine" v-if="setupSt\.lead">\{\{ setupSt\.lead \}\}<\/p>/)
  const fin = js.slice(js.indexOf('const setupShowFailure'), js.indexOf('const setupNo'))
  assert.ok(fin.includes('scrollIntoView') && fin.includes('if (!ok) setupShowFailure()'), '失敗才捲動')
  const yes = js.slice(js.indexOf('const setupYes'), js.indexOf('const setupClose'))
  assert.ok(yes.includes("setupSt.mode === 'relogin' ? { node, mode: 'relogin' } : { node }"), '安裝的呼叫維持原樣，只有重新登入多帶 mode')
  assert.ok(yes.includes('return setupFinish(setupErrorText(e), false)'), '送不出去也是醒目的失敗')
  const poll = js.slice(js.indexOf('const setupPoll'), js.indexOf('const setupYes'))
  assert.ok(!poll.includes('catch { return }'), '輪詢出錯不再靜默吞掉')
  assert.ok(poll.includes('setupStep('))
})

test('接線守門：先確認才送出、送出只在「確認安裝」、離開頁面就停止輪詢、手機註冊了兩個指令、文字是人話', () => {
  const js = read('ui/m.js'), html = read('ui/m.html'), lib = read('src-tauri/src/lib.rs'), acct = read('src-tauri/src/account.rs')
  assert.match(js, /const setupAsk = \(node, mode = 'install'\) => \{ setupReset\(\); Object\.assign\(setupSt, \{ node, mode: mode === 'relogin' \? 'relogin' : 'install', stage: 'confirm' \}\) \}/, '按鈕只進確認，不送出')
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
