// #2111 ⑦（#1879）帳號狀態的判斷：帳號頁卡片（電腦、手機）共用 device-account-lines.mjs 的 accountStatusOf。
// #1860 PR-C 拿掉設備詳情裡的帳號行（一行＋標籤、點進帳號頁、「⋯」刪除），這裡只留還在用的部分：
// 狀態判斷只有一處、帳號頁卡片的識別與狀態、帳號庫收到 confirmed 就直接刪（hub 的 acct-remove 仍接得住，給之後帳號頁卡片的刪除用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { createAccountsUi } from '../ui/lib/claude-accounts.mjs'
import { rosterView } from '../ui/lib/account-roster.mjs'
import { accountCardKey, accountStatusOf } from '../ui/lib/device-account-lines.mjs'
import { withIdentity } from './helpers/with-identity.mjs'

const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.now()
const iso = ms => new Date(ms).toISOString()

// 四個帳號：正常、登入已失效（工作機自己回報）、額度用完、訂閱已失效。後台名單是真實形狀（asn_relay_acct_roster 的回傳）
const OK = 'ok@example.test', LOST = 'lost@example.test', OUT = 'out@example.test', LAPSED = 'lapsed@example.test'
const win = (name, left) => ({ name, left_pct: left, resets_at: iso(NOW + 3 * 3600_000), read_at: iso(NOW - 5 * 60_000), read_node: 'W' })
const entry = (account, windows, sub = 'active') => ({ vendor: 'claude', account, plan: 'pro', windows, seen_at: iso(NOW - 5 * 60_000), seen_node: 'W', nodes: [{ node: 'W', current: false, reported_at: iso(NOW - 5 * 60_000), sub_state: sub }] })
const ROSTER = { now: iso(NOW), accounts: [entry(OK, [win('five_hour', 80)]), entry(LOST, [win('five_hour', 70)]), entry(OUT, [win('five_hour', 0)]), entry(LAPSED, [], 'lapsed')] }
const myAccounts = rosterView(ROSTER, { nodeLabel: () => '工作機' })
const acctOf = (email, extra = {}) => ({ email, plan: 'pro', current: false, incomplete: false, quota: { known: false, text: '', parts: [], bars: [] }, ...extra })
const deviceW = () => withIdentity({
  key: 'W', label: '工作機', self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '',
  vendors: [{ key: 'claude', label: 'Claude', account: '有帳號', reported: true, extra: '', switchable: true, switchHint: '', accounts: [acctOf(OK), acctOf(LOST, { loginFailed: true }), acctOf(OUT), acctOf(LAPSED)] }],
})
const st = (over = {}) => ({ devices: [deviceW()], myAccounts, accounts: { list: [] }, ...over })
const render = async (props, state = st()) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state, meAv: '', ...props }) }))
}

test('#2111 #1879 狀態只有一個判斷函式：登入失效 > 訂閱失效 > 額度用完 > 正常；電腦手機的帳號卡片都呼叫它', () => {
  assert.equal(accountStatusOf({}), 'normal')
  assert.equal(accountStatusOf({ exhausted: true }), 'out')
  assert.equal(accountStatusOf({ exhausted: true, subLapsed: true }), 'lapsed')
  assert.equal(accountStatusOf({ exhausted: true, subLapsed: true, loginLost: true }), 'lost')
  const panel = read('ui/lib/settings-panel.mjs'), mhtml = read('ui/m.html')
  for (const src of [panel, mhtml]) assert.ok(src.includes('accountStatusOf('), '帳號頁卡片用同一個函式')
})

test('#2111 帳號頁每張卡都有識別（data-acct-card）與狀態（data-status），識別不分大小寫', async () => {
  const acct = await render({ catKey: 'accounts' })
  for (const email of [OK, LOST, OUT, LAPSED]) assert.ok(acct.includes(`data-acct-card="${accountCardKey('claude', email)}"`), `${email} 的卡片要有識別`)
  assert.equal(accountCardKey('Claude', ' A@B.C '), 'claude|a@b.c')
  assert.ok(/data-acct-card="claude\|lapsed@example\.test" data-status="lapsed"/.test(acct), '訂閱已失效的卡片狀態')
})

test('#1860 設備詳情沒有帳號行：四個帳號一個都不出現在別台的詳情', async () => {
  const html = await render({ catKey: 'devices', dev: 'W' })
  for (const email of [OK, LOST, OUT, LAPSED]) assert.ok(!html.includes(email), `${email} 不該在設備詳情`)
  assert.ok(!html.includes('asn-aline') && !html.includes('open-accounts'))
})

test('#2111 #1879 刪除：帳號庫收到 confirmed 就直接刪（不再要按兩次），結果寫在原位的狀態行；舊的按兩次流程不變', async () => {
  globalThis.Vue = Vue
  const mkUi = () => {
    const f = { calls: [] }
    const invoke = async (name, args) => { f.calls.push([name, args]); if (name === 'claude_account_delete') return null; if (name === 'claude_accounts_list') return []; return null }
    return { f, ui: createAccountsUi({ invoke, reactive: Vue.reactive, sleep: async () => {} }) }
  }
  const { f, ui } = mkUi()
  await ui.remove('a@x.test', true)
  assert.deepEqual(f.calls[0], ['claude_account_delete', { email: 'a@x.test' }])
  assert.match(ui.state.msg, /已刪除 a@x\.test/)
  const m2 = mkUi()
  await m2.ui.remove('a@x.test')
  assert.equal(m2.f.calls.length, 0, '沒帶 confirmed 仍然先要確認')
  assert.ok(read('ui/list.js').includes("accounts.remove(String(value.email ?? ''), value.confirmed === true)"))
})
