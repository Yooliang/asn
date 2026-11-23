// #2111 ⑦（#1879）設備頁的帳號：一個帳號一行＋狀態標籤，點進帳號頁那張卡；額度條、切換、「⋯」只在帳號頁。
// 狀態判斷只有一處（device-account-lines.mjs 的 accountStatusOf），帳號頁卡片與設備頁帳號行用同一份資料、同一個函式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { LOGIN_LOST_TEXT, SUB_LAPSED_TEXT, rosterView } from '../ui/lib/account-roster.mjs'
import { ACCOUNT_STATUS_CLASS, ACCOUNT_STATUS_TEXT, QUOTA_OUT_TEXT, accountCardKey, accountStatusOf, deviceAccountLines } from '../ui/lib/device-account-lines.mjs'
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
const lineOf = (html, email) => new RegExp(`<li class="asn-aline"[^>]*data-aline="claude\\|${email}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? ''

test('#2111 #1879 設備頁：四種狀態各一行，標籤是「正常／登入已失效／額度用完／訂閱已失效」', async () => {
  const html = await render({ catKey: 'devices', dev: 'W', devView: 'acct' })
  const want = { [OK]: ['normal', '正常', 'asn-tag-ok'], [LOST]: ['lost', '登入已失效', 'asn-tag-warn'], [OUT]: ['out', '額度用完', 'asn-tag-warn'], [LAPSED]: ['lapsed', '訂閱已失效', 'asn-tag-fail'] }
  assert.equal([...html.matchAll(/class="asn-aline"/g)].length, 4, '一個帳號一行')
  for (const [email, [status, tag, cls]] of Object.entries(want)) {
    const li = lineOf(html, email)
    assert.ok(li, `${email} 沒有那一行`)
    assert.ok(li.includes(`data-status="${status}"`), `${email} 狀態應為 ${status}`)
    assert.ok(li.includes(`<span class="${cls}">${tag}</span>`), `${email} 標籤應為「${tag}」（${cls}）`)
    assert.ok(li.includes('›'), '右側有「›」')
  }
  assert.deepEqual(ACCOUNT_STATUS_TEXT, { normal: '正常', lost: '登入已失效', out: '額度用完', lapsed: '訂閱已失效' })
})

test('#2111 #1879 有問題時那行下面多一句說明（文字同帳號頁的常數），正常的沒有', async () => {
  const html = await render({ catKey: 'devices', dev: 'W', devView: 'acct' })
  assert.ok(!/asn-aline-note/.test(lineOf(html, OK)), '正常的帳號沒有說明句')
  assert.ok(lineOf(html, LOST).includes(LOGIN_LOST_TEXT.notice('工作機', 'Claude', LOST)), '登入已失效：和帳號頁名單上方提示同一句')
  assert.ok(lineOf(html, LAPSED).includes(SUB_LAPSED_TEXT.note), '訂閱已失效：和帳號頁卡片同一句')
  assert.ok(lineOf(html, OUT).includes(QUOTA_OUT_TEXT.note), '額度用完：有下一步')
  for (const email of [LOST, OUT, LAPSED]) assert.ok(!/<button[^>]*>(切換|續訂|重新登入)</.test(lineOf(html, email)), '帳號行裡只有「點進帳號頁」那顆按鈕，沒有別的鈕')
})

test('#2111 #1879 設備頁沒有額度條、切換、「⋯」、刪除（只在帳號頁）', async () => {
  const html = await render({ catKey: 'devices', dev: 'W', devView: 'acct' })
  for (const bad of ['dv-bars', 'dv-track', 'progressbar', 'asn-more', '更多動作', 'dv-devbtn', '剩 ']) assert.ok(!html.includes(bad), `設備頁不該有 ${bad}`)
  assert.ok(!/<button[^>]*>(切換|刪除|確認刪除)<\/button>/.test(html))
  const self = await render({ catKey: 'devices', dev: 'H', devView: 'acct' }, st({
    devices: [withIdentity({ key: 'H', label: '家用機', self: true, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [{ key: 'claude', label: 'Claude', accounts: [acctOf(OK, { current: true })], switchable: true, switchHint: '' }] })],
    accounts: { list: [{ email: OK, plan: 'pro', current: true, saved: true, quota: { known: true, text: '剩 80%', bars: [{ key: 'five_hour', label: '5 小時', pct: 80, low: false, reset: '', expired: false }] } }], current: { email: OK, saved: true } },
  }))
  for (const bad of ['dv-bars', 'dv-track', 'asn-more', 'dv-devbtn']) assert.ok(!self.includes(bad), `這台的設備頁也不該有 ${bad}`)
  assert.ok(!/<button[^>]*>(切換|刪除|確認刪除)<\/button>/.test(self))
  assert.ok(self.includes('data-aline="claude|' + OK + '"'), '本機帳號庫的帳號也是一行')
})

test('#2111 #1879 與帳號頁判斷一致：同一份資料，帳號頁卡片的 data-status 與設備頁帳號行相同', async () => {
  const dev = await render({ catKey: 'devices', dev: 'W', devView: 'acct' })
  const acct = await render({ catKey: 'accounts' })
  for (const email of [OK, LOST, OUT, LAPSED]) {
    const key = accountCardKey('claude', email).replace('|', '\\|')
    const line = new RegExp(`data-aline="${key}" data-status="(\\w+)"`).exec(dev)?.[1]
    const card = new RegExp(`data-acct-card="${key}" data-status="(\\w+)"`).exec(acct)?.[1]
    assert.ok(line && card, `${email} 兩邊都要有`)
    assert.equal(line, card, `${email} 兩邊狀態要相同`)
  }
})

test('#2111 #1879 狀態只有一個判斷函式：登入失效 > 訂閱失效 > 額度用完 > 正常；電腦手機的卡片與帳號行都呼叫它', () => {
  assert.equal(accountStatusOf({}), 'normal')
  assert.equal(accountStatusOf({ exhausted: true }), 'out')
  assert.equal(accountStatusOf({ exhausted: true, subLapsed: true }), 'lapsed')
  assert.equal(accountStatusOf({ exhausted: true, subLapsed: true, loginLost: true }), 'lost')
  assert.deepEqual(Object.keys(ACCOUNT_STATUS_CLASS), ['normal', 'lost', 'out', 'lapsed'])
  const panel = read('ui/lib/settings-panel.mjs'), mhtml = read('ui/m.html'), mjs = read('ui/m.js')
  for (const src of [panel, mhtml]) assert.ok(src.includes('accountStatusOf('), '帳號頁卡片用同一個函式')
  assert.ok(panel.includes('deviceAccountLines(') && mjs.includes('deviceAccountLines('), '電腦與手機都呼叫同一個函式取得帳號行')
  const lines = read('ui/lib/device-account-lines.mjs')
  assert.ok(lines.includes('accountStatusOf({ loginLost: accountLoginLost(rows)'), '設備頁的登入失效判斷重用帳號頁的 accountDeviceRows／accountLoginLost')
})

test('#2111 #1879 後台名單讀不到：帳號行仍然列出（只剩這台回報的登入失效），不整塊消失', () => {
  const dev = deviceW()
  const lines = deviceAccountLines(dev, dev.vendors[0], null)
  assert.deepEqual(lines.map(l => [l.account, l.status]), [[OK, 'normal'], [LOST, 'lost'], [OUT, 'normal'], [LAPSED, 'normal']])
})

test('#2111 #1879 點一行＝送 open-accounts 到帳號頁，帶著要框起的那張卡（電腦）', () => {
  globalThis.Vue = Vue
  const calls = []
  const props = Vue.reactive({ title: '', st: st(), catKey: 'devices', meAv: '', dev: 'W', devView: 'acct', askRemove: false, removedOpen: false })
  const r = SettingsPanel.setup(props, { emit: (...a) => calls.push(a) })
  const line = r.linesOf(r.curVendors.value[0]).find(l => l.account === LOST)
  r.goAccount(line)
  assert.deepEqual(calls.at(-1), ['act', 'open-accounts', undefined])
  assert.equal(line.key, accountCardKey('claude', LOST), '帳號頁那張卡的識別就是這一行的 key')
  const acct = read('ui/lib/settings-panel.mjs')
  assert.ok(/:data-acct-card="accountCardKey\(v\.key, a\.account\)"/.test(acct), '帳號頁每張卡都有識別')
  assert.ok(/scrollIntoView/.test(acct) && /data-flash/.test(acct), '捲到並框起那張卡')
  assert.ok(read('ui/list.js').includes("case 'open-accounts': await openPanel('setting', 'accounts')"), '樞紐開帳號頁')
})

test('#2111 #1879 手機：點一行＝退回列表、切到「帳號」分頁、捲到並框起那張卡；樣板與電腦同一組類別', () => {
  const mhtml = read('ui/m.html'), mjs = read('ui/m.js')
  assert.ok(/@click="acctCardGo\(l\)"/.test(mhtml) && /v-for="l in acctLines\(v\)"/.test(mhtml))
  const go = mjs.slice(mjs.indexOf('const acctCardGo'))
  assert.ok(/acctSw\.tab = 'accounts'/.test(go) && /acctBackToList\(\)/.test(go), '切到帳號分頁並退回列表')
  assert.ok(/:data-acct-card="accountCardKey\(v\.key, a\.account\)"/.test(mhtml) && /scrollIntoView/.test(go))
  const panel = read('ui/lib/settings-panel.mjs')
  for (const cls of ['asn-aline-go', 'asn-aline-mail', 'asn-aline-side', 'asn-aline-chev', 'asn-aline-note', 'l.tagClass']) assert.ok(panel.includes(cls) && mhtml.includes(cls), `電腦與手機都用 ${cls}`)
  const kit = read('ui/kit.css')
  for (const sel of ['.asn-tag-ok', '.asn-tag-warn', '.asn-aline-go', '[data-flash="1"]']) assert.ok(kit.includes(sel), `kit.css 要有 ${sel}`)
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(kit.slice(kit.indexOf('.asn-tag-ok,')).replace(/\/\*[\s\S]*?\*\//g, '')), '顏色只用 kit 變數')
})
