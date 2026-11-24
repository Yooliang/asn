// 設定「設備」與「帳號」兩頁（todo-next-174 的 C，#650）：
// 設備頁＝每台一列（名字、種類、在線、一行 AI 狀態）＋雲端代理；帳號頁＝我的帳號（依廠牌、額度、用在哪幾台、切換到…）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
// 共用元件的插槽會在輸出裡留下片段標記（<!--[-->、<!--]-->），比對畫面文字前先拿掉
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { DEVICE_BLOCK_REASON, DEVICE_ROW_TEXT, accountDeviceRows, rosterView, usedOnText } from '../ui/lib/account-roster.mjs'
import { deviceStateLine, STATE } from '../ui/lib/device-state.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-11-02T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const label = n => ({ H: '家用機', W: '工作機', X: '舊電腦' }[n] ?? '')

const roster = accounts => ({ now: iso(NOW), accounts })
const entry = (vendor, account, nodes) => ({ vendor, account, plan: 'pro', windows: [], seen_at: iso(NOW), seen_node: 'H', nodes })

test('帳號列表每個帳號帶「用在哪幾台」：使用中的排前面，同一台只算一次，沒有設備名寫辨認線索', () => {
  const v = rosterView(roster([entry('claude', 'z@b.c', [{ node: 'W', current: false, reported_at: iso(NOW) }, { node: 'H', current: true, reported_at: iso(NOW) }, { node: 'W', current: false }, { node: 'Q', current: false }])]), { nodeLabel: label, now: NOW })
  const row = v.vendors[0].accounts[0]
  assert.deepEqual(row.usedOn.map(n => [n.node, n.label, n.current]), [['H', '家用機', true], ['W', '工作機', false], ['Q', '電腦（Q）', false]])
  assert.equal(usedOnText(row), '家用機（使用中）、工作機、電腦（Q）')
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

/** 帳號頁的設備列：[{ name, text, state, disabled, why }]（依畫面順序；#2111 ② 一台一列） */
const devBtns = html => [...html.matchAll(/<span class="dv-devrow[^"]*"><span class="dv-devname"><span class="dv-devn">([^<]*)(?:<span class="dv-plan dv-devread">[^<]*<\/span>|<!---->)?<\/span>(?:<small class="dv-devwhy"[^>]*>([^<]*)<\/small>|<!---->)?<\/span><button([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
  name: m[1], why: m[2] ?? '', text: m[4].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ''), state: /st-(current|busy|blocked)/.exec(m[3])?.[1] ?? (/dv-devbtn/.test(m[3]) ? 'switch' : ''), disabled: /\sdisabled/.test(m[3]),
}))

test('帳號頁：每個帳號一台一列；使用中＝深灰不能按；沒在用的寫「切換」可以按；按鈕上不再寫設備名', async () => {
  const devices = [
    dev('H', '家用機', true, [vend('claude', [acct('a@b.c', true), acct('z@b.c')])]),
    dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: true })]),
  ]
  const html = await render('accounts', state(devices, my()))
  assert.deepEqual(devBtns(html).map(({ name, text, state, disabled }) => ({ name, text, state, disabled })), [
    { name: '家用機', text: '使用中', state: 'current', disabled: true },
    { name: '家用機', text: '切換', state: 'switch', disabled: false },
    { name: '工作機', text: '切換', state: 'switch', disabled: false },
  ])
  assert.ok(html.includes('這台'), '本機的那列加小標「這台」')
  assert.ok(!html.includes('用在：') && !html.includes('切換到') && !html.includes('目前不能切換'))
  assert.ok(!html.includes('class="dv-list"') && !html.includes('雲端代理'))
})

test('#2111 切換進行中的那台：鈕寫「切換中…」、不能按、不寫原因（共用函式）', () => {
  const devices = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: true })])]
  const rows = accountDeviceRows(devices, 'claude', 'z@b.c', [], { switchingNode: 'W' })
  assert.deepEqual(rows.map(r => [r.node, r.state, r.reason]), [['W', 'busy', '']])
  assert.equal(DEVICE_ROW_TEXT.busy, '切換中…')
})

test('#2111 帳號頁的切換：對方 ASN 沒開、登入不完整、Grok 只有一個帳號是「不能切換」並寫原因；隱藏、已移除、沒登入這個帳號的設備整列不畫', async () => {
  const mk = over => [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: true })]), ...[]].map(d => ({ ...d, ...over }))
  const page = async devices => render('accounts', state(devices, my()))
  const work = async devices => devBtns(await page(devices)).find(b => b.name === '工作機')
  assert.equal((await work(mk({}))).disabled, false)
  assert.equal((await work(mk({}))).why, '')
  assert.equal(await work(mk({ hidden: true })), undefined, '已隱藏不畫')
  assert.equal(await work(mk({ removed: true })), undefined, '已永久移除不畫（#1858）')
  const off = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c')], { switchable: false, switchHint: '對方電腦的 ASN 沒有在線，無法切換' })])]
  assert.deepEqual(pick(await work(off)), { text: '離線中', state: 'blocked', disabled: true, why: '' })   // #2111 ⑥：離線中，不再寫原因
  assert.equal(DEVICE_BLOCK_REASON.offline, 'ASN 尚未開啟')
  const incomplete = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true), acct('z@b.c', false, { incomplete: true })], { switchable: true })])]
  assert.deepEqual(pick(await work(incomplete)), { text: '不能切換', state: 'blocked', disabled: true, why: DEVICE_BLOCK_REASON.incomplete })
  const notLogged = [dev('W', '工作機', false, [vend('claude', [acct('w@b.c', true)], { switchable: true })])]
  assert.equal(await work(notLogged), undefined, '沒登入這個帳號的設備不畫')
  const grok = [dev('H', '家用機', true, [vend('grok', [acct('z@b.c')])])]
  const gmy = rosterView(roster([entry('grok', 'z@b.c', [{ node: 'H', current: false }])]), { nodeLabel: label, now: NOW })
  const grokHtml = await render('accounts', state(grok, gmy))
  assert.deepEqual(devBtns(grokHtml).map(pick), [{ text: '不能切換', state: 'blocked', disabled: true, why: DEVICE_BLOCK_REASON.single }])
})
const pick = ({ text, state, disabled, why }) => ({ text, state, disabled, why })

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
  // #1499：列上只留名字和「電腦／手機・在線／離線」，狀態那一行搬到「詳情」
  assert.equal(tree.find(d => d.key === S).stateLine, 'Claude 已登入、OpenAI（Codex） 未安裝、Grok 未安裝')
  assert.ok(!html.includes('Claude 已登入') && !html.includes('dv-line'), '列上不放狀態那一行')
  const src = (await import('node:fs')).readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(src, /<device-identity :identity="curDev\.identity"/, '詳情裡有辨認區（最後在線只寫在線與否，帳號狀態不放這裡；#1829）')
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

test('帳號卡片：「開放查詢」是右上 tag 列（和方案、使用中同一排）的標示，不在下方按鈕列；沒開放就不出現', async () => {
  const devices = [dev('H', '家用機', true, [vend('claude', [acct('a@b.c', true)])])]
  const mine = shared => rosterView(roster([{ ...entry('claude', 'a@b.c', [{ node: 'H', current: true }]), shared }]), { nodeLabel: label, now: NOW })
  const qr = { grok: false, agy: false, busy: false, msg: '', confirm: '', code: null, extra: false, extraDirs: [], minimaxSupported: false }
  const on = await render('accounts', { ...state(devices, mine(true)), quotaReaders: qr })
  const between = (a, b) => { const i = on.indexOf(a); return i < 0 ? '' : on.slice(i, on.indexOf(b, i)) }
  const side = between('class="dv-side"', 'class="dv-quota"')
  assert.ok(on.includes('<span class="dv-plan dv-shared">開放查詢</span>'), 'tag 文字是「開放查詢」')
  assert.ok(side.includes('開放查詢') && side.includes('dv-cur'), 'tag 在右上 tag 列')
  assert.ok(!on.includes('class="dv-share"'), '#2111 ⑥ 卡片上沒有獨立的重新產生／撤銷鈕，收進「⋯」選單')
  assert.ok(on.includes('class="asn-more-btn"'), '右上角有「⋯」')
  assert.ok(!on.includes('已開放查詢'))
  const off = await render('accounts', { ...state(devices, mine(false)), quotaReaders: qr })
  assert.ok(!off.includes('開放查詢') && !off.includes('dv-shared'), '沒開放就沒有 tag')
})
