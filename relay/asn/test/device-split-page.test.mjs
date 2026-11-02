// 設定「設備」與「帳號」兩頁（todo-next-174 的 C，#650）：
// 設備頁＝每台一列（名字、種類、在線、一行 AI 狀態）＋雲端代理；帳號頁＝我的帳號（依廠牌、額度、用在哪幾台、切換到…）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { rosterView, usedOnText } from '../ui/lib/account-roster.mjs'
import { deviceStateLine, STATE } from '../ui/lib/device-state.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-11-02T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const label = n => ({ H: '家用機', W: '工作機', X: '舊電腦' }[n] ?? '')

const roster = accounts => ({ now: iso(NOW), accounts })
const entry = (vendor, account, nodes) => ({ vendor, account, plan: 'pro', windows: [], seen_at: iso(NOW), seen_node: 'H', nodes })

test('帳號列表每個帳號帶「用在哪幾台」：使用中的排前面，同一台只算一次，沒有設備名寫未命名', () => {
  const v = rosterView(roster([entry('claude', 'z@b.c', [{ node: 'W', current: false, reported_at: iso(NOW) }, { node: 'H', current: true, reported_at: iso(NOW) }, { node: 'W', current: false }, { node: 'Q', current: false }])]), { nodeLabel: label, now: NOW })
  const row = v.vendors[0].accounts[0]
  assert.deepEqual(row.usedOn.map(n => [n.node, n.label, n.current]), [['H', '家用機', true], ['W', '工作機', false], ['Q', '未命名設備', false]])
  assert.equal(usedOnText(row), '家用機（使用中）、工作機、未命名設備')
  assert.equal(usedOnText({ usedOn: [] }), '')
  assert.equal(usedOnText(null), '')
  // 沒有任何一台還在回報它：空的，不出現「用在」
  const none = rosterView(roster([entry('claude', 'old@b.c', [])]), { nodeLabel: label, now: NOW }).vendors[0].accounts[0]
  assert.deepEqual(none.usedOn, [])
})

const dev = (key, name, self, vendors, over = {}) => ({ key, label: name, self, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', hidden: false, removed: false, vendors, ...over })
const acct = (email, current = false, extra = {}) => ({ email, plan: 'pro', current, ...extra })
const vend = (key, accounts, extra = {}) => ({ key, label: key === 'claude' ? 'Claude' : 'Grok', account: '', reported: true, extra: '', accounts, switchable: false, switchHint: '', ...extra })

function state(devices, my) {
  return {
    devices, accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts: my,
  }
}
const render = async (catKey, st) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey, meAv: '' }) }))
}
const my = () => rosterView(roster([
  entry('claude', 'a@b.c', [{ node: 'H', current: true }]),
  entry('claude', 'z@b.c', [{ node: 'H', current: false }, { node: 'W', current: false }]),
]), { nodeLabel: label, now: NOW })

test('帳號頁：每個帳號寫用在哪幾台；沒在用的帳號可以「切換到這台／切換到工作機」，正在用的沒有按鈕', async () => {
  const devices = [
    dev('H', '家用機', true, [vend('claude', [acct('a@b.c', true), acct('z@b.c')])]),
    dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: true })]),
  ]
  const html = await render('accounts', state(devices, my()))
  assert.ok(html.includes('用在：家用機（使用中）'), '使用中的排前面')
  assert.ok(html.includes('用在：家用機、工作機'))
  assert.ok(html.includes('切換到這台') && html.includes('切換到工作機'))
  assert.equal(html.split('切換到這台').length - 1, 1, '只有 z 的那一列有（a 在這台已是使用中）')
  assert.ok(!html.includes('class="dv-list"') && !html.includes('雲端代理'))
})

test('帳號頁的切換：對方 ASN 沒在線／不可切換、帳號登入不完整、設備已隱藏或移除、Grok 只有一個帳號，都不給按鈕', async () => {
  const mk = over => [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: true })]), ...[]].map(d => ({ ...d, ...over }))
  const page = async devices => render('accounts', state(devices, my()))
  assert.ok((await page(mk({}))).includes('切換到工作機'))
  assert.ok(!(await page(mk({ hidden: true }))).includes('切換到工作機'))
  assert.ok(!(await page(mk({ removed: true }))).includes('切換到工作機'))
  const off = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: false, switchHint: '對方電腦的 ASN 沒有在線，無法切換' })])]
  assert.ok(!(await page(off)).includes('切換到工作機'))
  const incomplete = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c', false, { incomplete: true })], { switchable: true })])]
  assert.ok(!(await page(incomplete)).includes('切換到工作機'))
  // Codex 沒有切換；Grok 本機只有一個帳號不給
  const grok = [dev('H', '家用機', true, [vend('grok', [acct('z@b.c')])])]
  const gmy = rosterView(roster([entry('grok', 'z@b.c', [{ node: 'H', current: false }])]), { nodeLabel: label, now: NOW })
  assert.ok(!(await render('accounts', state(grok, gmy))).includes('切換到這台'))
})

test('帳號頁：後台讀不到列表就寫提示，不是整頁空白；設備頁沒有「我的帳號」', async () => {
  const none = await render('accounts', state([], null))
  assert.ok(none.includes('現在讀不到帳號列表'))
  const d = await render('devices', state([dev('H', '家用機', true, [])], my()))
  assert.ok(!d.includes('class="dv-my"') && d.includes('class="dv-list"'))
})

test('設備頁：每一列寫一行 AI 狀態；細部頁的廠商標頭寫這一家的狀態；雲端代理只在設備頁', async () => {
  const S = 'aaaaaaaa-0000-4000-8000-000000000001', W = 'bbbbbbbb-0000-4000-8000-000000000002'
  const fr = (node, device, agent, engine) => ({ node, device, agent, engine, status: 'online', kind: null, partnerId: 'eeeeeeee-0000-4000-8000-0000000000aa' })
  const tree = buildDeviceTree({
    friends: [fr(S, '家用機', 'a1', 'claude'), fr(W, '工作機', 'w1', 'claude')], nodeOrder: [S, W], selfNode: S, now: NOW, asn: { [W]: [{}] },
    launchers: { [S]: { profiles: [{ id: 'claude' }], detected: true }, [W]: { profiles: [{ id: 'claude' }] } },
    reports: { [W]: { error: '', asnOnline: true, reportedAt: iso(NOW - 60000), accounts: [{ vendor: 'claude', email: 'w@b.c', plan: 'pro', current: true }] } },
    self: { claude: [{ email: 's@b.c', plan: 'max', current: true }], codex: { loggedIn: false, text: '' } },
  })
  const html = await render('devices', state(tree, null))
  assert.ok(html.includes('Claude 已登入、OpenAI（Codex） 未安裝、Grok 未安裝'), html.match(/dv-line[^<]*<?[^>]*>[^<]*/)?.[0])
  assert.ok(html.includes('雲端代理'), '雲端代理在設備列表頁')
  globalThis.Vue = Vue
  const detail = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state(tree, null), catKey: 'devices', meAv: '', dev: W }) }))
  assert.ok(detail.includes('dv-dev-h') && !detail.includes('雲端代理'), '細部頁沒有雲端代理')
})

test('設備摘要一行：手機沒有、離線看不到、沒收到回報只說一句、其餘逐家說', () => {
  const v = (label, state) => ({ label, state })
  assert.equal(deviceStateLine({ phone: true, vendors: [v('Claude', STATE.LOGGED_IN)] }), '')
  assert.equal(deviceStateLine({ online: false, vendors: [v('Claude', STATE.LOGGED_IN)] }), '離線，看不到狀態')
  assert.equal(deviceStateLine({ online: false, self: true, vendors: [v('Claude', STATE.LOGGED_IN)] }), 'Claude 已登入', '本機不看在線')
  assert.equal(deviceStateLine({ vendors: [v('Claude', STATE.NO_REPORT)], missing: [v('Grok', STATE.NO_REPORT)] }), '還沒收到這台的回報')
  assert.equal(deviceStateLine({ vendors: [v('Claude', STATE.LOGGED_IN)], missing: [v('Grok', STATE.NOT_INSTALLED), v('Codex', STATE.UNKNOWN_INSTALL)] }), 'Claude 已登入、Grok 未安裝、Codex 不確定是否安裝')
  // 全部不確定：合成一句，不重複三次（asn真 在 #680 的意見）
  const all3 = ['Claude', 'OpenAI（Codex）', 'Grok'].map(n => v(n, STATE.UNKNOWN_INSTALL))
  assert.equal(deviceStateLine({ missing: all3 }), '不確定這台裝了哪些 AI')
  assert.equal(deviceStateLine({ vendors: [all3[0]], missing: all3.slice(1) }), '不確定這台裝了哪些 AI')
  // 部分不確定：不確定的併成一組
  assert.equal(deviceStateLine({ vendors: [v('Claude', STATE.LOGGED_IN)], missing: all3.slice(1) }), 'Claude 已登入、OpenAI（Codex）／Grok 不確定是否安裝')
  assert.equal(deviceStateLine({}), '')
})

test('守門：分類鍵在 list.js 兩個都認；畫面上沒有「設備與帳號」；cloud-invite 在設備頁裡', () => {
  const list = read('ui/list.js')
  assert.match(list, /\['devices', 'accounts'\]\.includes\(normalizeCatKey\(ui\.panel\.setting\)\)/)
  const panel = read('ui/lib/settings-panel.mjs')
  const dev = panel.slice(panel.indexOf("<template v-if=\"cat === 'devices'\">"), panel.indexOf("<template v-if=\"catKey === 'look'\">"))
  const acc = panel.slice(panel.indexOf("<template v-if=\"cat === 'accounts'\">"), panel.indexOf("<template v-if=\"cat === 'devices'\">"))
  assert.ok(dev.includes('<cloud-invite-panel>') && !acc.includes('<cloud-invite-panel>'))
  // 雲端代理只在設備列表頁（!curDev 那一段），細部頁（v-else 那一段）沒有
  const listPart = dev.slice(0, dev.indexOf('<section class="dv-dev" v-else'))
  const detailPart = dev.slice(dev.indexOf('<section class="dv-dev" v-else'))
  assert.ok(listPart.includes('<cloud-invite-panel>') && !detailPart.includes('<cloud-invite-panel>'), '雲端代理只放設備列表頁')
  assert.ok(!read('ui/lib/cloud-invite.mjs').includes('上面的「登入狀態」'), '拆頁後上面沒有登入狀態，改請先在「個人」登入')
  assert.ok(read('ui/lib/cloud-invite.mjs').includes('請先在「個人」登入'))
  assert.ok(acc.includes('dv-my') && !dev.includes('dv-my'))
  assert.ok(!/設備與帳號/.test(read('ui/lib/settings-cats.mjs').replace(/\/\/.*$/gm, '')))
})
