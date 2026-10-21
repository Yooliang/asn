// 登入（第一期）：登入畫面與設定頁區塊的純邏輯、畫面接線守門、沒有節點金鑰時的端到端（只截登入畫面）。
// 需要先 `npm run build`；找不到 exe 就略過端到端那一個。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { PROVIDERS, accountView, canStart, errorText, needsDeviceSetup, phaseText, providerKeys } from '../ui/lib/login.mjs'
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

test('設定頁區塊：未登入、已登入但這台沒連、已連、沒有節點金鑰', () => {
  const out = accountView({ signed_in: false }, null, true)
  assert.equal(out.signedIn, false)
  assert.equal(out.title, '尚未登入')
  assert.equal(out.canClaim, false)

  const notMine = accountView({ signed_in: true, email: 'a@b.c' }, { node_count: 3, this_node_mine: false }, true)
  assert.equal(notMine.title, '已登入：a@b.c')
  assert.equal(notMine.canClaim, true)
  assert.match(notMine.detail, /3 台電腦.*還沒連到/)

  const mine = accountView({ signed_in: true, email: 'a@b.c' }, { node_count: 16, this_node_mine: true }, true)
  assert.equal(mine.canClaim, false)
  assert.equal(mine.mine, true)
  assert.match(mine.detail, /已連到你的帳號/)

  // 沒有節點金鑰（新電腦）：沒有東西可認領
  assert.equal(accountView({ signed_in: true, email: 'a@b.c' }, { node_count: 0, this_node_mine: false }, false).canClaim, false)
  // 帳號資訊還沒取到：先不給認領按鈕
  assert.equal(accountView({ signed_in: true, email: 'a@b.c' }, null, true).canClaim, false)
  // 沒有 email 也不丟錯
  assert.match(accountView({ signed_in: true, email: null }, null, true).title, /沒有 email/)
})

test('新電腦判斷：沒有節點金鑰且已登入才建立節點', () => {
  assert.equal(needsDeviceSetup(false, { signed_in: true }), true)
  assert.equal(needsDeviceSetup(true, { signed_in: true }), false)
  assert.equal(needsDeviceSetup(false, { signed_in: false }), false)
  assert.equal(needsDeviceSetup(false, null), false)
})

test('設定頁登入區塊元件：未登入時有兩個登入鈕、沒有登出與認領', async () => {
  globalThis.Vue = Vue
  const html = await renderToString(Vue.createSSRApp({ render: () => Vue.h(LoginPanel) }))
  assert.ok(html.includes('用 Google 登入') && html.includes('用 GitHub 登入'))
  assert.ok(!html.includes('登出') && !html.includes('連到我的帳號'))
})

test('守門：前端用到的帳號指令，Rust 端都有註冊；前端檔案不碰權杖與金鑰', () => {
  const api = read('ui/lib/tauri.mjs')
  const used = [...api.slice(api.indexOf('export const authApi')).matchAll(/invoke\('(auth_[a-z_]+)'/g)].map(m => m[1])
  assert.ok(used.length >= 7)
  const lib = read('src-tauri/src/lib.rs')
  for (const c of used) assert.ok(lib.includes(`account::${c}`), `lib.rs 沒註冊 ${c}`)
  for (const f of ['ui/login.js', 'ui/login.html', 'ui/lib/login.mjs', 'ui/lib/login-panel.mjs']) {
    assert.ok(!/access_token|refresh_token|x-relay-key|localStorage|auth_token|device_id/.test(read(f)), `${f} 不該碰權杖或金鑰`)
  }
})

test('守門：沒有節點金鑰時名單視窗轉去登入畫面，而且在「無法啟動」之前', () => {
  const hub = read('ui/list.js')
  const a = hub.indexOf('if (info.needs_login)')
  const b = hub.indexOf('if (info.error)')
  assert.ok(a > 0 && b > a)
  assert.ok(hub.slice(a, b).includes("location.replace('login.html')"))
  assert.ok(read('src-tauri/src/lib.rs').includes('needs_login: app.relay.is_none()'))
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
