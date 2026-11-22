// #2111 ② 帳號卡設備一台一列（含 #2110 原因判斷、#1858 已移除設備不畫）。
// 電腦（settings-panel）與手機（m.js／m.html）共用 account-roster.mjs 的 accountDeviceRows，這裡守住每種原因與「不畫」的條件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
// 共用元件的插槽會在輸出裡留下片段標記（<!--[-->、<!--]-->），比對畫面文字前先拿掉
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { DEVICE_BLOCK_REASON, DEVICE_ROW_TEXT, accountDeviceRows, accountInUse, rosterView } from '../ui/lib/account-roster.mjs'
import { ACCT_SWITCH_REASON } from '../ui/lib/mobile-acct.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-11-22T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const MAIL = 'z@example.test'
const OTHER = 'w@example.test'

const dev = (key, label, vendors, over = {}) => ({ key, label, self: false, hidden: false, removed: false, kind: '電腦', vendors, ...over })
const claude = (accounts, over = {}) => ({ key: 'claude', switchable: false, switchHint: '', accounts, ...over })
const acc = (email = MAIL, current = false, extra = {}) => ({ email, current, ...extra })
const rows = (devices, usedOn = [], opts = {}) => accountDeviceRows(devices, 'claude', MAIL, usedOn, opts)
const brief = r => r.map(x => [x.node, x.state, x.reason])
const used = (node, label, current = false) => ({ node, label, current })

test('#2110 本機帳號庫說這台在用這個帳號：那列一定是「使用中」，後台說沒人在用也一樣', () => {
  const devices = [dev('H', '家用機', [claude([acc(MAIL, true), acc(OTHER)])], { self: true })]
  assert.deepEqual(brief(rows(devices, [])), [['H', 'current', '']], '後台列表沒有這台，本機說在用')
  assert.deepEqual(brief(rows(devices, [used('H', '家用機', false)])), [['H', 'current', '']], '後台說不在用，以本機為準')
  const notUsing = [dev('H', '家用機', [claude([acc(MAIL, false), acc(OTHER, true)])], { self: true })]
  assert.deepEqual(brief(rows(notUsing, [used('H', '家用機', true)])), [['H', 'switch', '']], '本機說沒在用、後台說在用：以本機為準，可以切換')
})

test('#2110 每種不能切換的原因都說清楚、說怎麼辦；沒有籠統的「目前不能切換」', () => {
  const R = DEVICE_BLOCK_REASON
  const one = d => brief(rows([d], [used(d.key, d.label)]))
  assert.deepEqual(one(dev('W', '工作機', [claude([acc(), acc(OTHER)], { switchHint: '對方電腦的 ASN 沒有在線，無法切換' })])), [['W', 'blocked', 'ASN 尚未開啟']])
  assert.equal(R.offline, 'ASN 尚未開啟')
  assert.deepEqual(one(dev('W', '工作機', [claude([acc(MAIL, false, { incomplete: true }), acc(OTHER)], { switchable: true })])), [['W', 'blocked', '這台的登入沒完成，到那台重新登入這個帳號']])
  assert.deepEqual(one(dev('W', '工作機', [claude([acc()])])), [['W', 'blocked', R.single]])
  const grok = dev('H', '家用機', [{ key: 'grok', accounts: [acc()] }], { self: true })
  assert.deepEqual(brief(accountDeviceRows([grok], 'grok', MAIL, [])), [['H', 'blocked', R.single]])
  const gem = dev('W', '工作機', [{ key: 'gemini', accounts: [acc()] }])
  assert.deepEqual(brief(accountDeviceRows([gem], 'gemini', MAIL, [])), [['W', 'blocked', R.vendor]])
  assert.deepEqual(one(dev('P', '手機', [claude([acc(), acc(OTHER)])], { kind: '手機' })), [['P', 'blocked', R.phone]])
  // 其他未知（兩個帳號、沒有不在線的線索、卻切不了）→ 保底句；還沒收到那台回報、但後台說它用過 → 同一句
  assert.deepEqual(one(dev('W', '工作機', [claude([acc(), acc(OTHER)])])), [['W', 'blocked', '暫時切不了，請稍後再試']])
  assert.deepEqual(brief(rows([dev('W', '工作機', [])], [used('W', '工作機')])), [['W', 'blocked', '暫時切不了，請稍後再試']])
  assert.deepEqual(one(dev('W', '工作機', [claude([acc(), acc(OTHER)], { switchable: true })])), [['W', 'switch', '']])
  for (const t of [...Object.values(R), ...Object.values(ACCT_SWITCH_REASON), ...Object.values(DEVICE_ROW_TEXT)]) assert.ok(!t.includes('目前不能切換') && !/node|uuid/.test(t), t)
  for (const f of ['ui/lib/account-roster.mjs', 'ui/lib/mobile-acct.mjs', 'ui/lib/settings-panel.mjs', 'ui/m.html', 'ui/m.js']) assert.ok(!read(f).includes('目前不能切換'), `${f} 不再有「目前不能切換」`)
})

test('#2111 切換中的那台：寫「切換中…」、不能按；別台不受影響；使用中的不會被蓋成切換中', () => {
  const devices = [
    dev('W', '工作機', [claude([acc(), acc(OTHER)], { switchable: true })]),
    dev('V', '備用機', [claude([acc(), acc(OTHER)], { switchable: true })]),
    dev('H', '家用機', [claude([acc(MAIL, true)])], { self: true }),
  ]
  assert.deepEqual(brief(rows(devices, [], { switchingNode: 'W' })), [['H', 'current', ''], ['W', 'busy', ''], ['V', 'switch', '']])
  assert.deepEqual(brief(rows(devices, [], { switchingNode: 'H' })).find(r => r[0] === 'H'), ['H', 'current', ''])
  assert.deepEqual({ ...DEVICE_ROW_TEXT }, { current: '使用中', switch: '切換', busy: '切換中…', blocked: '不能切換', self: '這台' })
})

test('#1858 #2110 不列：已永久移除、已隱藏、設備代號在設備列表找不到的舊紀錄、沒登入這個帳號的設備', () => {
  const two = [acc(), acc(OTHER)]
  const devices = [
    dev('W', '工作機', [claude(two, { switchable: true })]),
    dev('R', '已移除', [claude(two, { switchable: true })], { removed: true }),
    dev('HID', '已隱藏', [claude(two, { switchable: true })], { hidden: true }),
    dev('N', '沒登入', [claude([acc('other@example.test'), acc(OTHER)], { switchable: true })]),
  ]
  const usedOn = [used('W', '工作機'), used('OLD', '舊代號', true), used('R', '已移除'), used('HID', '已隱藏'), used('N', '沒登入')]
  assert.deepEqual(rows(devices, usedOn).map(r => r.node), ['W'])
  assert.deepEqual(rows([dev('H', '家用機', [claude([acc('other@example.test')])], { self: true })], [used('H', '家用機', true)]), [], '本機有 Claude 帳號庫、庫裡沒這個帳號：就算後台（舊資料）說它在用也不畫（#2110 本機以帳號庫為準）')
  assert.deepEqual(rows([dev('W', '工作機', [claude([])])], [used('W', '工作機')]), [], '有回報、但沒有這個帳號＝沒登入')
})

test('#2110 卡片頂端的「使用中」以設備列為準，兩邊不互相矛盾', async () => {
  // 後台列表說沒有設備在用、本機帳號庫說家用機在用 → 頂端有「使用中」、那列也是「使用中」
  const roster = { now: iso(NOW), accounts: [{ vendor: 'claude', account: MAIL, plan: 'pro', windows: [], seen_at: iso(NOW), seen_node: 'W', nodes: [{ node: 'W', current: false, reported_at: iso(NOW) }] }] }
  const my = rosterView(roster, { nodeLabel: n => ({ H: '家用機', W: '工作機' }[n] ?? ''), now: NOW })
  assert.equal(my.vendors[0].accounts[0].current, false, '後台說沒人在用')
  const devices = [
    dev('H', '家用機', [claude([acc(MAIL, true), acc(OTHER)])], { self: true }),
    dev('W', '工作機', [claude([acc(MAIL), acc(OTHER, true)], { switchable: true })]),
  ]
  globalThis.Vue = Vue
  const st = { devices, accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts: my }
  const html = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'accounts', meAv: '' }) }))
  assert.ok(html.includes('<span class="dv-cur">使用中</span>'), '頂端標籤跟著本機')
  assert.ok(/class="asn-btn lv-secondary st-current fixed dv-devbtn"[^>]*disabled/.test(html) && html.includes('>使用中<'), '本機那列是使用中')
  assert.equal(accountInUse(rows([devices[1]]), true), false, '設備列沒有任何一列在用，頂端就不寫使用中')
  assert.equal(accountInUse([], true), true, '設備列表是空的才退回後台的說法')
  assert.equal(accountInUse([], false), false)
})

test('#2111 電腦與手機用同一個判斷函式、同一份文字：同一份輸入電腦畫面與共用函式的結果一致', async () => {
  const devices = [
    dev('H', '家用機', [claude([acc(MAIL, true), acc(OTHER)])], { self: true }),
    dev('W', '工作機', [claude([acc(), acc(OTHER)], { switchHint: '對方電腦的 ASN 沒有在線，無法切換' })]),
    dev('V', '備用機', [claude([acc(), acc(OTHER)], { switchable: true })]),
  ]
  const label = n => ({ H: '家用機', W: '工作機', V: '備用機' }[n] ?? '')
  const roster = { now: iso(NOW), accounts: [{ vendor: 'claude', account: MAIL, plan: 'pro', windows: [], seen_at: iso(NOW), seen_node: 'H', nodes: ['H', 'W', 'V'].map(n => ({ node: n, current: n === 'H', reported_at: iso(NOW) })) }] }
  const my = rosterView(roster, { nodeLabel: label, now: NOW })
  const expected = accountDeviceRows(devices, 'claude', MAIL, my.vendors[0].accounts[0].usedOn, { vendors: ['claude'] })
  globalThis.Vue = Vue
  const st = { devices, accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts: my }
  const html = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'accounts', meAv: '' }) }))
  const shown = [...html.matchAll(/<button[^>]*class="asn-btn lv-secondary(?: st-(current|busy|blocked))? fixed dv-devbtn"[^>]*>([^<]*)</g)].map(m => [m[1] ?? 'switch', m[2]])
  assert.deepEqual(shown, expected.map(r => [r.state, DEVICE_ROW_TEXT[r.state]]))
  for (const r of expected.filter(x => x.reason)) assert.ok(html.includes(r.reason), `電腦畫面有原因：${r.reason}`)
  assert.deepEqual(expected.map(r => r.reason), ['', 'ASN 尚未開啟', ''])
  // 手機的設備列也走同一個函式與同一份文字常數，沒有自己再寫一份判斷
  const mjs = read('ui/m.js'), mhtml = read('ui/m.html'), panel = read('ui/lib/settings-panel.mjs')
  assert.match(mjs, /accountDeviceRows\(acctDevs\.value, vendor, a\?\.account, a\?\.usedOn, \{ vendors: \['claude'\]/)
  assert.match(panel, /accountDeviceRows\(allDevs\.value, vendor, a\?\.account, a\?\.usedOn/)
  assert.match(mhtml, /\{\{ DEVICE_ROW_TEXT\[b\.state\] \}\}/)
  assert.match(panel, /\{\{ DEVICE_ROW_TEXT\[b\.state\] \}\}/)
  assert.ok(!/deviceBlockReason|deviceButtons/.test(mjs + mhtml + panel), '舊的兩套判斷都拿掉了')
  assert.equal(ACCT_SWITCH_REASON.offline, DEVICE_BLOCK_REASON.offline)
  assert.equal(ACCT_SWITCH_REASON.incomplete, DEVICE_BLOCK_REASON.incomplete)
})

test('#2111 鈕的樣式：電腦 92×28、手機 100×40 固定尺寸靠右；使用中深灰、不能切換虛線；黃色不在這裡出現', () => {
  const css = read('ui/style.css'), m = read('ui/mobile.css')
  // 尺寸與狀態色由共用按鈕（kit.css）負責：設備列的鈕是 fixed（92 寬）＋ st-current／st-busy／st-blocked，頁面樣式不再自己覆寫
  const kit = read('ui/kit.css')
  assert.match(kit, /\.asn-btn\.fixed\{width:92px\}/)
  assert.match(kit, /--btn-h:28px/)
  assert.doesNotMatch(css, /\.dv-devbtn\{|\.dv-devbtn\./, '頁面樣式不再覆寫設備鈕的尺寸與狀態色')
  assert.match(m, /\.m-dv-dev\{[^}]*width:100px;min-width:100px;max-width:100px;height:40px/)
  assert.match(kit, /\.asn-btn\.st-current[^{]*\{[^}]*background:var\(--kit-current\)[^}]*color:#fff/)
  assert.match(kit, /\.asn-btn\.st-blocked[^{]*\{[^}]*dashed/)
  assert.match(m, /\.m-dv-dev\.current[^{]*\{[^}]*background:#4b5058[^}]*color:#fff/)
  assert.match(m, /\.m-dv-dev\.blocked[^{]*\{[^}]*dashed/)
  const dvBlock = css.slice(css.indexOf('.dv-devs{'), css.indexOf('.dv-code{'))
  const mBlock = m.slice(m.indexOf('.m-dv-devrow{'), m.indexOf('.m-dv-acct.cur{'))
  for (const b of [dvBlock, mBlock]) assert.ok(b.length > 200 && !/#ffd84d|#c79a00/.test(b), '黃色留給重新登入')
})

test('#2110 手機卡片頂端的「使用中」與設備列用同一個判斷（acctInUseOf），兩處樣板都換了', () => {
  const html = read('ui/m.html'), js = read('ui/m.js')
  assert.match(html, /<li class="m-dv-acct" :class="\{ cur: acctInUseOf\(v\.key, a\) \}"/)
  assert.match(html, /<span class="m-dv-cur" v-if="acctInUseOf\(v\.key, a\)">使用中<\/span>/)
  assert.match(js, /const acctInUseOf = \(vendor, a\) => accountInUse\(acctDevRows\(vendor, a\), a\?\.current\)/)
  assert.match(read('ui/lib/settings-panel.mjs'), /<span class="dv-cur" v-if="accountInUseOf\(v\.key, a\)">使用中<\/span>/)
})

test('#2111 手機 Claude 卡：後台說手機（P）在用、手機設備樹裡沒有 Claude 帳號庫，那列仍要列出且為使用中（CI 截圖 m-acct-cards 的同一份資料）', async () => {
  const { resetRoster, SMOKE_NOW } = await import('../scripts/smoke-lib.mjs')
  const my = rosterView(resetRoster(SMOKE_NOW), { nodeLabel: n => (n === 'P' ? '手機（P）' : ''), now: SMOKE_NOW })
  const a = my.vendors.find(v => v.key === 'claude').accounts[0]
  assert.deepEqual(a.usedOn.map(u => [u.node, u.current]), [['P', true]])
  // 這支手機：設備樹裡只有 Gemini（額度列表來的），沒有 Claude 這個廠商
  const phone = dev('P', '手機（P）', [{ key: 'gemini', accounts: [acc('me@example.com')] }], { self: true, kind: '手機' })
  const r = accountDeviceRows([phone], 'claude', 'me@example.com', a.usedOn, { vendors: ['claude'] })
  assert.deepEqual(brief(r), [['P', 'current', '']])
  assert.equal(r[0].self, true)
  assert.equal(accountInUse(r, false), true, '頂端「使用中」也在')
  // 手機不在用、也沒這個帳號：不畫；手機有這個帳號卻不在用：不能切換＋手機不能切換帳號
  assert.deepEqual(accountDeviceRows([phone], 'claude', 'me@example.com', [{ node: 'P', label: '手機（P）', current: false }], { vendors: ['claude'] }), [])
  const has = dev('P', '手機（P）', [claude([acc('me@example.com'), acc(OTHER)])], { self: true, kind: '手機' })
  assert.deepEqual(brief(accountDeviceRows([has], 'claude', 'me@example.com', [], { vendors: ['claude'] })), [['P', 'blocked', DEVICE_BLOCK_REASON.phone]])
})
