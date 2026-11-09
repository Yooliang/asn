// 設定「設備」與「帳號」兩頁（todo-next-174 的 C，#650）：
// 設備頁＝每台一列（名字、種類、在線、一行 AI 狀態）＋雲端代理；帳號頁＝我的帳號（依廠牌、額度、用在哪幾台、切換到…）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { DEVICE_BLOCK_REASON, deviceBlockReason, deviceButtons, rosterView, usedOnText } from '../ui/lib/account-roster.mjs'
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

/** 帳號頁的設備按鈕：[{ text, on, pressed, disabled }]（依畫面順序） */
const devBtns = html => [...html.matchAll(/<button([^>]*class="aero-btn dv-devbtn( on)?"[^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
  text: m[3].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ''), on: Boolean(m[2]), pressed: /aria-pressed="true"/.test(m[1]), disabled: /\sdisabled/.test(m[1]),
}))

test('帳號頁：每個帳號一排設備按鈕（用過的每台一顆）；使用中的是黃色選中、有勾與「使用中」、不停用；沒在用的按了就是切換到那台', async () => {
  const devices = [
    dev('H', '家用機', true, [vend('claude', [acct('a@b.c', true), acct('z@b.c')])]),
    dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: true })]),
  ]
  const html = await render('accounts', state(devices, my()))
  assert.deepEqual(devBtns(html), [
    { text: '✓家用機（這台）使用中', on: true, pressed: true, disabled: false },
    { text: '家用機（這台）', on: false, pressed: false, disabled: false },
    { text: '工作機', on: false, pressed: false, disabled: false },
  ])
  assert.ok(!html.includes('用在：') && !html.includes('切換到'), '拿掉「用在：」一行與「切換到…」按鈕')
  assert.ok(!html.includes('class="dv-list"') && !html.includes('雲端代理'))
})

test('設備按鈕的資料：使用中的沒有切換目標（按了不做事）；切換目標裡有、後台還沒回報的也補上；這台加「（這台）」', () => {
  const usedOn = [{ node: 'H', label: '家用機', current: true }, { node: 'W', label: '工作機', current: false }]
  const targets = [{ node: 'W', name: '工作機', op: 'device-switch' }, { node: 'X', name: '新電腦', op: 'device-switch' }, { node: 'H', name: '家用機', op: 'acct-switch' }]
  const b = deviceButtons(usedOn, targets, 'H')
  assert.deepEqual(b.map(x => [x.node, x.label, x.current, x.target?.op ?? null]), [['H', '家用機（這台）', true, null], ['W', '工作機', false, 'device-switch'], ['X', '新電腦', false, 'device-switch']])
  assert.equal(deviceButtons([{ node: 'W', label: '', current: false }], [], 'H', () => '工作機')[0].label, '工作機', '後台沒給名字時用設備名')
  assert.deepEqual(deviceButtons(null, null, ''), [])
})

test('帳號頁的切換：對方 ASN 沒在線／不可切換、帳號登入不完整、設備已隱藏或移除、Grok 只有一個帳號，那台的按鈕都停用', async () => {
  const mk = over => [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: true })]), ...[]].map(d => ({ ...d, ...over }))
  const page = async devices => render('accounts', state(devices, my()))
  const work = async devices => devBtns(await page(devices)).find(b => b.text === '工作機')
  // 停用的按鈕下方寫原因（像手機），按鈕用 aria-describedby 指到那行字；能按的不寫
  const whys = html => [...html.matchAll(/<small class="dv-devwhy" id="([^"]+)">([^<]*)<\/small>/g)].map(m => ({ id: m[1], text: m[2] }))
  const why = async devices => whys(await page(devices)).filter(w => w.id.endsWith('-W')).map(w => w.text)   // 只看工作機那顆（家用機不在設備樹裡，本來就停用）
  assert.equal((await work(mk({}))).disabled, false)
  assert.deepEqual(await why(mk({})), [])
  assert.equal((await work(mk({ hidden: true }))).disabled, true)
  assert.equal((await work(mk({ removed: true }))).disabled, true)
  const hiddenHtml = await page(mk({ hidden: true }))
  const hw = whys(hiddenHtml).filter(w => w.id.endsWith('-W'))
  assert.deepEqual(hw.map(w => w.text), [DEVICE_BLOCK_REASON.hidden])
  assert.ok(hiddenHtml.includes(`aria-describedby="${hw[0].id}"`), '停用的按鈕指到原因那行字')
  assert.deepEqual(await why(mk({ removed: true })), [DEVICE_BLOCK_REASON.removed])
  const off = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: false, switchHint: '對方電腦的 ASN 沒有在線，無法切換' })])]
  assert.equal((await work(off)).disabled, true)
  assert.deepEqual(await why(off), [DEVICE_BLOCK_REASON.offline])
  const incomplete = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c', false, { incomplete: true })], { switchable: true })])]
  assert.equal((await work(incomplete)).disabled, true)
  assert.deepEqual(await why(incomplete), [DEVICE_BLOCK_REASON.incomplete])
  // Codex 沒有切換；Grok 本機只有一個帳號：按鈕在，但停用
  const grok = [dev('H', '家用機', true, [vend('grok', [acct('z@b.c')])])]
  const gmy = rosterView(roster([entry('grok', 'z@b.c', [{ node: 'H', current: false }])]), { nodeLabel: label, now: NOW })
  const grokHtml = await render('accounts', state(grok, gmy))
  assert.deepEqual(devBtns(grokHtml), [{ text: '家用機（這台）', on: false, pressed: false, disabled: true }])
  assert.deepEqual(whys(grokHtml).map(w => w.text), [DEVICE_BLOCK_REASON.single])
})

test('設備按鈕切不過去的原因：服務不能切換、隱藏／移除、沒存這個帳號、登入不完整、Grok 只有一個帳號、對方不在線', () => {
  const d = (key, self, vendors, over = {}) => ({ key, self, vendors, ...over })
  const cl = (accounts, over = {}) => ({ key: 'claude', accounts, ...over })
  const R = DEVICE_BLOCK_REASON
  assert.equal(deviceBlockReason([], 'codex', 'a@b.c', 'W'), R.vendor)
  assert.equal(deviceBlockReason([], 'claude', 'a@b.c', 'W'), R.unavailable, '找不到那台')
  assert.equal(deviceBlockReason([d('W', false, [], { removed: true })], 'claude', 'a@b.c', 'W'), R.removed)
  assert.equal(deviceBlockReason([d('W', false, [], { hidden: true })], 'claude', 'a@b.c', 'W'), R.hidden)
  assert.equal(deviceBlockReason([d('W', false, [cl([{ email: 'x@b.c' }])])], 'claude', 'a@b.c', 'W'), R.missing)
  assert.equal(deviceBlockReason([d('W', false, [cl([{ email: 'A@b.c', incomplete: true }], { switchable: true })])], 'claude', 'a@b.c', 'W'), R.incomplete, '比對帳號不分大小寫')
  assert.equal(deviceBlockReason([d('H', true, [{ key: 'grok', accounts: [{ email: 'a@b.c' }] }])], 'grok', 'a@b.c', 'H'), R.single)
  assert.equal(deviceBlockReason([d('W', false, [cl([{ email: 'a@b.c' }], { switchable: false, switchHint: '不在線' })])], 'claude', 'a@b.c', 'W'), R.offline)
  assert.equal(deviceBlockReason([d('W', false, [cl([{ email: 'a@b.c' }], { switchable: false })])], 'claude', 'a@b.c', 'W'), R.unavailable)
})

test('帳號頁：後台讀不到列表就寫提示，不是整頁空白；設備頁沒有「我的帳號」', async () => {
  const none = await render('accounts', state([], null))
  assert.ok(none.includes('現在讀不到帳號列表'))
  const d = await render('devices', state([dev('H', '家用機', true, [])], my()))
  assert.ok(!d.includes('class="dv-my"') && d.includes('class="dv-list"'))
})

test('設備頁：每一列寫一行 AI 狀態；細部頁的廠商標頭寫這一家的狀態；設備頁不放雲端代理', async () => {
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
  assert.ok(!html.includes('邀請雲端代理'), '設備列表頁不放雲端代理（自己一類）')
  globalThis.Vue = Vue
  const detail = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state(tree, null), catKey: 'devices', meAv: '', dev: W }) }))
  assert.ok(detail.includes('dv-dev-h') && !detail.includes('邀請雲端代理'), '細部頁沒有雲端代理')
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

test('守門：分類鍵在 list.js 兩個都認；畫面上沒有「設備與帳號」；雲端代理自己一類、不在設備或帳號頁', () => {
  const list = read('ui/list.js')
  assert.match(list, /\['devices', 'accounts'\]\.includes\(normalizeCatKey\(ui\.panel\.setting\)\)/)
  const panel = read('ui/lib/settings-panel.mjs')
  const dev = panel.slice(panel.indexOf("<template v-if=\"cat === 'devices'\">"), panel.indexOf("<template v-if=\"catKey === 'look'\">"))
  const acc = panel.slice(panel.indexOf("<template v-if=\"cat === 'accounts'\">"), panel.indexOf("<template v-if=\"cat === 'devices'\">"))
  assert.ok(!dev.includes('<cloud-invite-panel>') && !acc.includes('<cloud-invite-panel>'), '設備頁、帳號頁都不放雲端代理（搬到自己一類，跟手機一樣）')
  assert.match(panel, /<template v-if="cat === 'cloud'">\s*<cloud-invite-panel><\/cloud-invite-panel>\s*<\/template>/)
  assert.equal((panel.match(/<cloud-invite-panel>/g) || []).length, 1, '整個設定只有一處')
  assert.ok(!read('ui/lib/cloud-invite.mjs').includes('上面的「登入狀態」'), '拆頁後上面沒有登入狀態，改請先在「個人」登入')
  assert.ok(read('ui/lib/cloud-invite.mjs').includes('請先在「個人」登入'))
  assert.ok(acc.includes('dv-my') && !dev.includes('dv-my'))
  assert.ok(!/設備與帳號/.test(read('ui/lib/settings-cats.mjs').replace(/\/\/.*$/gm, '')))
})
