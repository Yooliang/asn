// 手機替電腦登入裝置碼型 CLI（#933 PR-5b 手機端）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEVICE_LOGIN_UI, LOGIN_TEXT, VENDORS, fetchView, requestView, secondsLeft, showLoginButton } from '../ui/lib/mobile-device-login.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('入口先關著；開了也只有支援的種類、對象是別台電腦才有按鈕', () => {
  assert.equal(DEVICE_LOGIN_UI, false)
  assert.equal(showLoginButton('codex', { kind: 'remote' }), false, '預設關')
  assert.equal(showLoginButton('codex', { kind: 'remote' }, true), true)
  assert.equal(showLoginButton('codex', { kind: 'local' }, true), false)
  assert.equal(showLoginButton('claude', { kind: 'remote' }, true), false, 'Claude 走原本的安裝並登入')
  assert.equal(showLoginButton('grok', { kind: 'remote' }, true), false, 'Grok 之後才支援')
  assert.deepEqual(Object.keys(VENDORS), ['codex'])
})

test('送出的回應：已經有進行中的請求＝這筆沒建立；有 rid 才開始等', () => {
  assert.deepEqual(requestView({ already: true, kind: 'claude' }), { stage: 'done', ok: false, text: LOGIN_TEXT.already })
  assert.deepEqual(requestView({ rid: 'R', exp: 1 }), { stage: 'waiting', rid: 'R', text: LOGIN_TEXT.waiting })
  assert.equal(requestView({}).stage, 'done')
})

test('取回的回應：各種狀態對應成畫面；ready 的網址、代碼、到期要合格才顯示', () => {
  assert.deepEqual(fetchView({ state: 'waiting', status: 'pending' }), { stage: 'waiting', text: LOGIN_TEXT.waiting })
  assert.deepEqual(fetchView({ state: 'waiting', status: 'taken' }), { stage: 'waiting', text: LOGIN_TEXT.taken })
  assert.deepEqual(fetchView({ state: 'waiting', status: 'failed', detail: '這台電腦還沒有安裝 Codex，請先安裝' }), { stage: 'done', ok: false, text: '這台電腦還沒有安裝 Codex，請先安裝' })
  assert.deepEqual(fetchView({ state: 'waiting', status: 'done' }), { stage: 'done', ok: true, text: LOGIN_TEXT.doneOk })
  for (const [s, t] of [['expired', LOGIN_TEXT.expired], ['delivered', LOGIN_TEXT.delivered], ['untrusted', LOGIN_TEXT.untrusted], ['gone', LOGIN_TEXT.gone], ['bad', LOGIN_TEXT.bad], ['???', LOGIN_TEXT.bad]]) {
    assert.deepEqual(fetchView({ state: s }), { stage: 'done', ok: false, text: t }, s)
  }
  const ok = { state: 'ready', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH1', code_exp: 1800000600, name: '工作機' }
  assert.deepEqual(fetchView(ok), { stage: 'show', url: ok.url, code: ok.code, exp: ok.code_exp, name: '工作機' })
  for (const bad of [{ url: 'http://x' }, { code: 'AB CD' }, { code: '<b>' }, { code_exp: null }]) {
    assert.equal(fetchView({ ...ok, ...bad }).stage, 'done', JSON.stringify(bad))
  }
})

test('倒數用電腦簽過的代碼到期時間；過期是 0', () => {
  assert.equal(secondsLeft(1000, 900_000), 100)
  assert.equal(secondsLeft(1000, 2_000_000), 0)
  assert.equal(LOGIN_TEXT.left(125), '剩下 2 分 05 秒')
})

test('給人看的文字純繁體中文，不帶英文代碼或網址', () => {
  for (const t of Object.values(LOGIN_TEXT).map(x => (typeof x === 'function' ? x('示範電腦', '某家') : x))) {
    assert.doesNotMatch(t, /setup|login|asn_|https?:\/\//i, t)
  }
})

test('守門（手機 Rust）：取回時驗章只用手機本機記住的電腦公鑰，不讀後台給的公鑰；兩個命令在手機的指令清單裡', () => {
  const acct = read('../src-tauri/src/account.rs')
  const f = acct.slice(acct.indexOf('pub async fn setup_device_fetch('), acct.indexOf('\n}\n', acct.indexOf('pub async fn setup_device_fetch(')))
  assert.ok(f.includes('crate::device_id::live::known(&app.data_dir)'), '用本機記住的')
  assert.ok(!f.includes('t_sign_pub'), '不讀後台給的電腦公鑰')
  assert.ok(f.includes('pending.open(&t_pub'), '驗章用本機的那把')
  assert.ok(!/elog!|println!|eprintln!/.test(f), '取回的內容不寫 log')
  const req = acct.slice(acct.indexOf('pub async fn setup_device_request('), acct.indexOf('\n}\n', acct.indexOf('pub async fn setup_device_request(')))
  assert.match(req, /"node_setup_request"/)
  assert.match(req, /"p_node": app\.node/)
  assert.match(req, /already[\s\S]*return Ok/, 'already 時不留私鑰')
  const lib = read('../src-tauri/src/lib.rs')
  const phone = lib.slice(lib.indexOf('#[cfg(not(desktop))]'), lib.indexOf('let builder = builder\n        .setup'))
  assert.ok(phone.includes('account::setup_device_request') && phone.includes('account::setup_device_fetch') && phone.includes('account::setup_device_cancel'), '手機的指令清單要有')
  const desk = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf('#[cfg(not(desktop))]\n    let builder = builder.invoke_handler('))
  assert.ok(desk.includes('generate_handler!'), '找得到電腦的指令清單')
  for (const c of ['setup_device_request', 'setup_device_fetch', 'setup_device_cancel']) assert.ok(!desk.includes(c), `電腦的指令清單不能有 ${c}`)
})

test('守門（手機畫面）：代碼不給複製、不能選取；離開頁面與進背景就清；送出只在確認階段；不寫 log', () => {
  const html = read('../ui/m.html')
  const blk = html.slice(html.indexOf('<div class="m-dv-login"'), html.indexOf('</div>', html.indexOf('<div class="m-dv-login"')))
  assert.ok(blk.includes('{{ loginSt.code }}') && blk.includes(':href="loginSt.url"'))
  assert.doesNotMatch(blk, /copy|複製|clipboard/i, '沒有複製')
  assert.match(read('../ui/mobile.css'), /\.m-dv-code\{[^}]*user-select:none/)
  const js = read('../ui/m.js')
  const sec = js.slice(js.indexOf('const loginSt = reactive('), js.indexOf('const loginClose = () => loginReset()'))
  assert.doesNotMatch(sec, /console\.|clipboard|localStorage|sessionStorage|store_save/, '網址代碼不進 log、不存')
  assert.ok(sec.includes("if (loginSt.stage !== 'confirm') return") && sec.includes("invoke('setup_device_request'"), '送出只在確認階段')
  assert.match(js, /if \(document\.hidden && loginSt\.stage === 'show'\) loginEnd\(/, '進背景就清')
  assert.match(js, /setupReset\(\); loginReset\(\)/, '離開設備頁就清')
  assert.match(sec, /const loginWipe = \(\) => \{ Object\.assign\(loginSt, \{ url: '', code: '', exp: 0, left: 0 \}\) \}/)
  assert.match(sec, /const loginStop = \(\) => \{[^\n]*invoke\('setup_device_cancel', \{ rid: loginSt\.rid \}\)/, '停止時連 Rust 記著的私鑰也丟掉')
  assert.match(sec, /const loginReset = \(\) => \{ loginStop\(\);/)
  assert.match(sec, /const loginEnd = \(text, good = false\) => \{ loginStop\(\);/)
})
