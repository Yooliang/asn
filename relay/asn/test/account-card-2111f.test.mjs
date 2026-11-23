// #2111 ⑥ 擁有者 11-23 看實際版本的回饋一批：沒有「我的帳號」標題、代碼按鈕收進「⋯」選單、時間不加括號、
// 帳號卡下設備順序固定（這台第一、其餘照「設備」頁）、離線一律「離線中」（即使舊回報說使用中）。電腦與手機共用同一批函式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { DEVICE_ROW_TEXT, accountDeviceRows, accountInUse, rosterView } from '../ui/lib/account-roster.mjs'
import { accountMenuItems, QUOTA_TEXT } from '../ui/lib/quota-readers.mjs'
import { AsnMoreMenu } from '../ui/lib/ui-kit.mjs'
import { inDevicePageOrder, visibleRows } from '../ui/lib/device-order.mjs'

const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-11-23T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const H = 60 * 60_000
const label = n => ({ H: '家用機', A: '甲機', B: '乙機', C: '丙機' }[n] ?? '')
const MAILS = ['one@x.test', 'two@x.test', 'three@x.test']

const acct = (email, current = false) => ({ email, plan: 'pro', current })
const vend = (accounts, extra = {}) => ({ key: 'claude', label: 'Claude', account: '', reported: true, extra: '', accounts, switchable: true, switchHint: '', ...extra })
const dev = (key, self, accounts, over = {}) => ({ key, label: label(key), self, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', hidden: false, removed: false, vendors: [vend(accounts)], ...over })
// 設備頁的順序：這台、甲、乙、丙（設備樹已照手動順序排好）。三張帳號卡各有不同的「使用中」設備
const devices = (over = {}) => [
  dev('H', true, MAILS.map(m => acct(m, m === MAILS[0])), over.H),
  dev('A', false, MAILS.map(m => acct(m)), over.A),
  dev('B', false, MAILS.map(m => acct(m)), over.B),
  dev('C', false, MAILS.map(m => acct(m)), over.C),
]
// 後台回報：每個帳號被不同台使用中，且回報順序與設備頁相反
const entry = (account, currentNode) => ({ vendor: 'claude', account, plan: 'pro', windows: [], seen_at: iso(NOW - H), seen_node: 'H',
  nodes: ['C', 'B', 'A', 'H'].map(n => ({ node: n, current: n === currentNode, reported_at: iso(NOW - H) })) })
const roster = () => ({ now: iso(NOW), accounts: [entry(MAILS[0], 'H'), entry(MAILS[1], 'B'), entry(MAILS[2], 'C')] })
const my = () => rosterView(roster(), { nodeLabel: label, now: NOW })
const rowsOf = (devs, account) => accountDeviceRows(devs, 'claude', account.account, account.usedOn)
const cards = () => MAILS.map(m => my().vendors[0].accounts.find(a => a.account === m))   // 依 MAILS 順序（one、two、three）
const render = async (devs, extra = {}) => {
  globalThis.Vue = Vue
  const st = { devices: devs, accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts: my(), ...extra }
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'accounts', meAv: '' }) }))
}
const qr = (over = {}) => ({ grok: false, agy: false, busy: false, msg: '', confirm: '', code: null, extra: false, extraDirs: [], minimaxSupported: false, ...over })

test('#2111 帳號頁沒有「我的帳號」那行標題（電腦、手機都沒有）；區塊仍有給讀屏用的名字', async () => {
  const html = await render(devices())
  assert.doesNotMatch(html, /<h3[^>]*class="dv-my-h"/)
  assert.ok(!/>我的帳號</.test(html), '畫面上看不到「我的帳號」字樣')
  assert.match(html, /<section class="dv-my"[^>]*aria-label="我的帳號"/)
  const m = read('ui/m.html')
  assert.ok(!m.includes('m-dv-my-h'), '手機也拿掉標題')
})

test('#2111 帳號卡上沒有獨立的產生／重新產生／撤銷鈕；「⋯」選單有對應項目、呼叫原本的命令', async () => {
  const html = await render(devices(), { quotaReaders: qr() })
  assert.ok(!html.includes('class="dv-share"'), '卡片上沒有獨立按鈕列')
  assert.equal((html.match(/class="asn-more-btn"/g) ?? []).length, 3, '每張卡右上一個「⋯」')
  assert.deepEqual(accountMenuItems(false).map(i => i.label), ['產生查詢代碼'])
  assert.deepEqual(accountMenuItems(true).map(i => [i.label, i.danger === true]), [['重新產生查詢代碼', false], ['撤銷代碼', true]])
  // 動作說法：不是疑問句、沒有括號自白
  for (const i of [...accountMenuItems(false), ...accountMenuItems(true)]) assert.doesNotMatch(i.label, /[？?（(]/)
  const panel = read('ui/lib/settings-panel.mjs')
  assert.match(panel, /key === 'share'\) act\('quota-share', \{ vendor, account: a\.account, shared: a\.shared \}\)/)
  assert.match(panel, /key === 'unshare'\) act\('quota-unshare', \{ vendor, account: a\.account \}\)/)
  const list = read('ui/list.js')
  assert.match(list, /case 'quota-share': await quotaReaders\.share\(value\)/)
  assert.match(list, /case 'quota-unshare': await quotaReaders\.unshare\(value\)/)
  assert.ok(!panel.includes('刪除這個帳號') && !accountMenuItems(true).some(i => /刪除/.test(i.label)), '帳號頁沒有既有的刪除帳號流程，不放刪除')
})

test('#2111 「⋯」選單：開、選項目、Esc、點外面都會收起；選項目送出對應的 key；沒有項目就不畫', async () => {
  globalThis.Vue = Vue
  const emitted = []
  const s = AsnMoreMenu.setup({ items: accountMenuItems(true), disabled: false }, { emit: (...a) => emitted.push(a) })
  assert.equal(s.open.value, false)
  s.toggle(); assert.equal(s.open.value, true)
  s.close(); assert.equal(s.open.value, false)
  s.toggle(); s.pick(s.list.value[1])
  assert.equal(s.open.value, false)
  assert.deepEqual(emitted, [['pick', 'unshare']])
  const off = AsnMoreMenu.setup({ items: accountMenuItems(true), disabled: true }, { emit: () => {} })
  off.toggle(); assert.equal(off.open.value, false, '忙碌時不能開')
  const none = await renderToString(Vue.createSSRApp({ render: () => Vue.h(AsnMoreMenu, { items: [] }) }))
  assert.ok(!none.includes('asn-more-btn'))
  const css = read('ui/kit.css')
  assert.match(css, /\.m-body\{[^}]*--menu-h:44px/, '手機選單項目高 44')
  assert.match(css, /\.asn-more-item\.danger\{color:var\(--kit-fail\)\}/, '危險項用危險色')
})

test('#2111 時間不加括號：「6 天前」不是「（6 天前）」', async () => {
  const html = await render(devices())
  assert.match(html, /<span class="dv-age">\d+ (分鐘|小時|天)前<\/span>/)
  assert.doesNotMatch(html, /（\d+ (分鐘|小時|天)前）/)
  assert.ok(!read('ui/lib/settings-panel.mjs').includes('（{{ a.quota.ageLabel }}）'))
})

test('#2111 三張不同帳號卡的設備順序一致，「這台」第一，其餘照「設備」頁的順序，不看誰在用', () => {
  const devs = devices()
  const orders = cards().map(a => rowsOf(devs, a).map(r => r.node))
  assert.deepEqual(orders[0], ['H', 'A', 'B', 'C'])
  assert.deepEqual(orders[1], orders[0])
  assert.deepEqual(orders[2], orders[0])
  // 使用中的不在最前面（帳號二用在乙機、帳號三用在丙機，順序不動）
  assert.deepEqual(rowsOf(devs, cards()[1]).map(r => r.state), ['switch', 'switch', 'current', 'switch'])
  // 設備頁手動排成 丙、乙、甲：各卡照它；這台仍第一
  const manual = [devs[0], devs[3], devs[2], devs[1]]
  for (const a of cards()) assert.deepEqual(rowsOf(manual, a).map(r => r.node), ['H', 'C', 'B', 'A'])
  // 即使設備樹把這台放在中間，也先排這台
  const odd = [devs[1], devs[0], devs[2], devs[3]]
  assert.deepEqual(rowsOf(odd, cards()[2]).map(r => r.node), ['H', 'A', 'B', 'C'])
  // 排序函式與「設備」頁用的是同一個
  assert.deepEqual(visibleRows(odd).map(d => d.key), inDevicePageOrder(odd).map(d => d.key))
  assert.match(read('ui/lib/account-roster.mjs'), /for \(const d of inDevicePageOrder\(devices\)\)/)
  assert.match(read('ui/lib/device-order.mjs'), /visibleRows = rows => inDevicePageOrder\(rows\)/)
})

test('#2111 離線：鈕上「離線中」、不能按、設備名下方沒有原因；每張帳號卡一律「離線中」，即使舊回報說正在用', async () => {
  const devs = devices({ B: { online: false } })   // 乙機離線；帳號二的後台舊回報說乙機正在用
  for (const a of cards()) {
    const b = rowsOf(devs, a).find(r => r.node === 'B')
    assert.deepEqual({ state: b.state, reason: b.reason, current: b.current, look: b.look }, { state: 'offline', reason: '', current: false, look: 'blocked' }, a.account)
  }
  assert.equal(DEVICE_ROW_TEXT.offline, '離線中')
  // ASN 沒開（設備樹給的 switchHint）也一樣是離線中
  const noAsn = devices({ A: { vendors: [vend(MAILS.map(m => acct(m)), { switchable: false, switchHint: '對方電腦的 ASN 沒有在線，無法切換' })] } })
  assert.deepEqual(rowsOf(noAsn, cards()[0]).filter(r => r.node === 'A').map(r => [r.state, r.reason]), [['offline', '']])
  // 離線的那台不算這個帳號「使用中」；其他不能切換的原因照舊寫在設備名下方
  assert.equal(accountInUse(rowsOf(devs, cards()[1]), true), false)
  const phone = devices({ C: { kind: '手機' } })
  assert.deepEqual(rowsOf(phone, cards()[0]).filter(r => r.node === 'C').map(r => [r.state, r.reason]), [['blocked', '手機不能切換帳號']])
  // 畫面：電腦的鈕是虛線淡色「離線中」且不能按，設備名下方沒有原因
  const html = await render(devs)
  const btns = [...html.matchAll(/<button[^>]*class="asn-btn lv-secondary st-blocked fixed dv-devbtn"([^>]*)>離線中</g)]
  assert.equal(btns.length, 3, '三張卡都有「離線中」')
  for (const m of btns) assert.match(m[1], /disabled/)
  assert.ok(!html.includes('ASN 尚未開啟'))
  assert.ok(!html.includes('dv-devwhy'), '離線的設備名下方沒有原因行')
})

test('#2111 電腦與手機一致：手機也走同一個設備列函式、同一份文字、同一個鈕樣式欄位，沒有自己的「離線」判斷', () => {
  const mjs = read('ui/m.js'), mhtml = read('ui/m.html'), panel = read('ui/lib/settings-panel.mjs')
  assert.match(mjs, /accountDeviceRows\(acctDevs\.value, vendor, a\?\.account, a\?\.usedOn/)
  assert.match(mjs, /const acctDevs = computed\(\(\) => visibleRows\(acctAllDevs\.value\)\)/)
  assert.match(mhtml, /\['m-dv-dev', b\.look\]/)
  assert.match(mhtml, /\{\{ DEVICE_ROW_TEXT\[b\.state\] \}\}/)
  assert.match(panel, /b\.look === 'switch'/)
  assert.ok(!/ASN 尚未開啟|離線中/.test(mjs + mhtml + panel), '離線的文字只在共用的常數裡')
  // 同一份輸入：手機用的設備列與電腦一樣
  const devs = devices({ B: { online: false } })
  assert.deepEqual(rowsOf(devs, cards()[1]).map(r => [r.node, r.state]), accountDeviceRows(devs, 'claude', MAILS[1], cards()[1].usedOn, { vendors: ['claude'] }).map(r => [r.node, r.state]))
  assert.equal(QUOTA_TEXT.shareCancel, '取消')
})
