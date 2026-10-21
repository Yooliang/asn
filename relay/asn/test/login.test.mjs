// 登入（第一期）：登入畫面與設定頁區塊的純邏輯、畫面接線守門、沒有節點金鑰時的端到端（只截登入畫面）。
// 需要先 `npm run build`；找不到 exe 就略過端到端那一個。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { PENDING_HINT, PROVIDERS, SKIP_LABEL, accountView, canStart, errorText, needsDeviceSetup, phaseText, providerKeys, showSkip } from '../ui/lib/login.mjs'
import { LoginPanel } from '../ui/lib/login-panel.mjs'
import { defaultExe, runShot, shotCaptureSupported } from '../scripts/shot.mjs'
import { assertShotNotBlank } from './shot-png.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('登入方式只有 Google 與 GitHub，Rust 端的白名單一致', () => {
  assert.deepEqual(providerKeys(), ['google', 'github'])
  assert.deepEqual(PROVIDERS.map(p => p.label), ['用 Google 登入', '用 GitHub 登入'])
  assert.ok(read('src-tauri/src/auth.rs').includes('pub const PROVIDERS: [&str; 2] = ["google", "github"];'))
})

test('階段：等待中不能再按登入；出錯可以重來', () => {
  assert.equal(canStart('idle'), true)
  assert.equal(canStart('error'), true)
  assert.equal(canStart('waiting'), false)
  assert.equal(canStart('setting'), false)
  assert.match(phaseText('waiting', 'github'), /GitHub/)
  assert.match(phaseText('setting'), /設定這台電腦/)
  assert.equal(phaseText('idle'), '')
})

test('錯誤文字：字串原樣、Error 取 message、空的給預設', () => {
  assert.equal(errorText('登入逾時，請再試一次'), '登入逾時，請再試一次')
  assert.equal(errorText(new Error('連不上後台')), '連不上後台')
  assert.match(errorText(''), /再試一次/)
  assert.match(errorText(null), /再試一次/)
})

test('設定頁區塊：未登入只有登入鈕；已登入只有 email 與登出；沒綁到只給小字提示', () => {
  const out = accountView({ signed_in: false }, null)
  assert.equal(out.signedIn, false)
  assert.equal(out.title, '尚未登入')

  const notMine = accountView({ signed_in: true, email: 'a@b.c' }, { node_count: 3, this_node_mine: false })
  assert.equal(notMine.title, '已登入：a@b.c')
  assert.equal(notMine.detail, PENDING_HINT)
  assert.match(PENDING_HINT, /尚未綁到你的帳號.*管理者認領後會自動完成/)
  assert.ok(!('canClaim' in notMine), '沒有「連到帳號」按鈕這回事')

  const mine = accountView({ signed_in: true, email: 'a@b.c' }, { node_count: 16, this_node_mine: true })
  assert.equal(mine.mine, true)
  assert.match(mine.detail, /已連到你的帳號.*16 台/)

  // 帳號資訊還沒取到：不亂說
  assert.equal(accountView({ signed_in: true, email: 'a@b.c' }, null).detail, '')
  // 沒有 email 也不丟錯
  assert.match(accountView({ signed_in: true, email: null }, null).title, /沒有 email/)
})

test('新電腦判斷：沒有節點金鑰且已登入才建立節點', () => {
  assert.equal(needsDeviceSetup(false, { signed_in: true }), true)
  assert.equal(needsDeviceSetup(true, { signed_in: true }), false)
  assert.equal(needsDeviceSetup(false, { signed_in: false }), false)
  assert.equal(needsDeviceSetup(false, null), false)
})

test('「暫時不登入」連結：只有已有節點金鑰、而且不在登入途中才顯示', () => {
  assert.equal(showSkip(true, 'idle'), true)
  assert.equal(showSkip(true, 'error'), true)
  assert.equal(showSkip(true, 'waiting'), false)
  assert.equal(showSkip(true, 'setting'), false)
  assert.equal(showSkip(false, 'idle'), false, '新電腦沒有金鑰可用，不給這個選項')
  assert.equal(showSkip(undefined, 'idle'), false)
  assert.equal(SKIP_LABEL, '暫時不登入（只用這台的收發室金鑰）')
})

test('設定頁登入區塊元件：未登入時有兩個登入鈕、沒有登出與認領', async () => {
  globalThis.Vue = Vue
  const html = await renderToString(Vue.createSSRApp({ render: () => Vue.h(LoginPanel) }))
  assert.ok(html.includes('用 Google 登入') && html.includes('用 GitHub 登入'))
  assert.ok(!html.includes('登出') && !html.includes('連到我的帳號'))
  assert.ok(!read('ui/lib/login-panel.mjs').includes('連到我的帳號'), '拿掉「把這台電腦連到我的帳號」按鈕')
})

test('守門：前端用到的帳號指令，Rust 端都有註冊；前端檔案不碰權杖與金鑰', () => {
  const api = read('ui/lib/tauri.mjs')
  const used = [...api.slice(api.indexOf('export const authApi')).matchAll(/invoke\('(auth_[a-z_]+)'/g)].map(m => m[1])
  assert.ok(used.length >= 6)
  assert.ok(used.includes('auth_bind') && used.includes('auth_skip_login'))
  assert.ok(!used.includes('auth_claim_this') && !used.includes('auth_setup_device'), '手動連到帳號的指令已拿掉')
  const lib = read('src-tauri/src/lib.rs')
  for (const c of used) assert.ok(lib.includes(`account::${c}`), `lib.rs 沒註冊 ${c}`)
  for (const f of ['ui/login.js', 'ui/login.html', 'ui/lib/login.mjs', 'ui/lib/login-panel.mjs']) {
    assert.ok(!/access_token|refresh_token|x-relay-key|localStorage|auth_token|device_id/.test(read(f)), `${f} 不該碰權杖或金鑰`)
  }
})

test('守門：沒登入（且沒選暫時不登入）或沒有節點金鑰時，名單視窗轉去登入畫面，而且在「無法啟動」之前', () => {
  const hub = read('ui/list.js')
  const a = hub.indexOf('if (info.needs_login)')
  const b = hub.indexOf('if (info.error)')
  assert.ok(a > 0 && b > a)
  assert.ok(hub.slice(a, b).includes("location.replace('login.html')"))
  const lib = read('src-tauri/src/lib.rs')
  assert.ok(lib.includes('needs_login: account::needs_login(app.relay.is_some(), auth.status().signed_in, account::login_skipped(&app.data_dir))'))
  assert.ok(lib.includes('can_skip_login: app.relay.is_some()'), '只有已有節點金鑰才給「暫時不登入」')
  assert.ok(lib.includes('is_some() && handle.state::<auth::AuthState>().status().signed_in'), '已登入的舊電腦每次啟動在背景再綁一次')
})

test('守門：只有 --shot 才有假登入，而且「暫時不登入」在沒有金鑰時會被 Rust 端擋下', () => {
  const lib = read('src-tauri/src/lib.rs')
  const at = lib.indexOf('IRORI_ASN_SHOT_LOGIN')
  assert.ok(at > 0 && lib.slice(Math.max(0, at - 200), at).includes('if shot.is_some()'))
  const acct = read('src-tauri/src/account.rs')
  const fn = acct.slice(acct.indexOf('pub fn auth_skip_login'), acct.indexOf('pub fn auth_skip_login') + 400)
  assert.ok(fn.includes('app.relay.is_none()'))
})

test('守門：登出只清登入權杖，不刪節點金鑰', () => {
  const acct = read('src-tauri/src/account.rs')
  const fn = acct.slice(acct.indexOf('pub async fn auth_logout'), acct.indexOf('/// 帳號資訊'))
  assert.ok(fn.includes('auth.sign_out()'))
  assert.ok(!/remove_file|\.key|relay_home/.test(fn))
})

test('沒有節點金鑰的新電腦：只截登入畫面，不連真實後台、不寄任何帶金鑰的請求', { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-e2e-login-'))
  const r = await runShot(out, defaultExe, { noKey: true })
  assert.equal(r.code, 0, r.log)
  assert.equal(r.relay.reqs.length, 0, '登入畫面階段不打節點 API')
  assert.ok(!fs.existsSync(path.join(r.home, '.irori-relay')), '沒登入就不建立任何金鑰檔')
  if (shotCaptureSupported) {
    assert.ok(r.files.includes('tabs-login.png'), `缺登入畫面截圖：${r.files}`)
    assertShotNotBlank(path.join(out, 'tabs-login.png'), { minBytes: 4000 })
  }
})

// ---- 端到端：已有節點金鑰的舊電腦 ----
const e2eOpts = { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }
const tmpOut = tag => fs.mkdtempSync(path.join(os.tmpdir(), `asn-e2e-${tag}-`))

test('已有金鑰、還沒登入：停在登入畫面（有「暫時不登入」），不進名單、不打帳號與節點 API', e2eOpts, async () => {
  const out = tmpOut('key-unsigned')
  const r = await runShot(out, defaultExe, { login: 'none' })
  assert.equal(r.code, 0, r.log)
  assert.equal(r.relay.reqs.filter(q => ['account_bootstrap', 'node_claim', 'node_create'].includes(q.action)).length, 0, '沒登入就不打帳號 API')
  if (shotCaptureSupported) {
    assert.ok(r.files.includes('tabs-login.png'), `缺登入畫面截圖：${r.files}`)
    assert.ok(!r.files.includes('tabs-local.png') && !r.files.some(f => f.startsWith('tabs-chat')), '不該進名單')
    assertShotNotBlank(path.join(out, 'tabs-login.png'), { minBytes: 4000 })
  }
})

test('已有金鑰、選了暫時不登入：照舊進名單，不打帳號 API', e2eOpts, async () => {
  const r = await runShot(tmpOut('key-skipped'), defaultExe, { login: 'skipped' })
  assert.equal(r.code, 0, r.log)
  assert.equal(r.relay.reqs.filter(q => ['account_bootstrap', 'node_claim', 'node_create'].includes(q.action)).length, 0)
  assert.ok(r.relay.reqs.some(q => q.action === 'list'), '有進名單')
})

test('已登入的舊電腦：啟動後自動 node_claim 綁到帳號（帶登入憑證與現有金鑰），金鑰檔不動', e2eOpts, async () => {
  const r = await runShot(tmpOut('auto-bind'), defaultExe, { login: 'user@example.com', timeoutMs: 120_000 })
  assert.equal(r.code, 0, r.log)
  const claim = r.relay.reqs.find(q => q.action === 'node_claim')
  assert.ok(claim, `沒有送 node_claim：${r.relay.reqs.map(q => q.action)}`)
  assert.match(claim.auth, /^Bearer \S+/)
  assert.equal(claim.key, 'fake-machine-key')
  assert.ok(r.relay.reqs.some(q => q.action === 'list'), '有進名單')
  assert.ok(!r.relay.reqs.some(q => q.action === 'node_create'), '已有金鑰就不建新節點')
  const home = path.join(r.home, '.irori-relay')
  assert.ok(!fs.existsSync(home) || !fs.readdirSync(home).some(f => f.endsWith('.key') || f === 'node'), '沒有寫任何金鑰檔')
})

test('綁定失敗（舊租戶還沒被認領）不擋使用：照常進名單', e2eOpts, async () => {
  const r = await runShot(tmpOut('bind-fail'), defaultExe, { login: 'user@example.com', claim: 'tenant_not_yours' })
  assert.equal(r.code, 0, r.log)
  assert.ok(r.relay.reqs.some(q => q.action === 'node_claim'), '有試著綁')
  assert.ok(r.relay.reqs.some(q => q.action === 'list'), '照常進名單')
  assert.ok(r.relay.sent.length >= 1, '照常能寄信')
})

test('沒有金鑰的新電腦登入後：自動 node_create，把新金鑰寫進本機檔案', e2eOpts, async () => {
  const r = await runShot(tmpOut('new-pc'), defaultExe, { noKey: true, login: 'user@example.com' })
  assert.equal(r.code, 0, r.log)
  const create = r.relay.reqs.find(q => q.action === 'node_create')
  assert.ok(create, `沒有送 node_create：${r.relay.reqs.map(q => q.action)}`)
  assert.match(create.auth, /^Bearer \S+/)
  assert.ok(!r.relay.reqs.some(q => q.action === 'node_claim'))
  const home = path.join(r.home, '.irori-relay')
  assert.equal(fs.readFileSync(path.join(home, 't1-newnode01.key'), 'utf8'), 'fake-new-node-key')
  assert.equal(fs.readFileSync(path.join(home, 'node'), 'utf8'), 't1-newnode01')
})
