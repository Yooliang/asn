// #2111 ⑥b 帳號卡「訂閱已失效」（#1646 F）＋ #2148 一審的四點建議。電腦（settings-panel）與手機（m.html）共用 account-roster.mjs 的判斷與文字。
// 資料形狀＝後台 asn_relay_acct_roster 實際回的（20261122200000_acct_sub_state.sql）：accounts[].nodes[] 每格一個 sub_state（'active'／'lapsed'／'unknown'，沒有資料回 'unknown'）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { SUB_LAPSED_TEXT, accountDeviceRows, rosterView, subLapsedOf } from '../ui/lib/account-roster.mjs'
import { QUOTA_TEXT, shareConfirmOf, shareKey } from '../ui/lib/quota-readers.mjs'

const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-11-23T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const MAIL = 'gina@example.com'

const win = { name: 'five_hour', left_pct: 62, resets_at: iso(NOW + 3_600_000), read_at: iso(NOW - 600_000), read_node: 'H' }
const entry = (nodeStates, over = {}) => ({ vendor: 'claude', account: MAIL, plan: 'pro', windows: [win], seen_at: iso(NOW - 600_000), seen_node: 'H',
  nodes: nodeStates.map(([node, sub_state, current = false]) => ({ node, current, reported_at: iso(NOW - 600_000), ...(sub_state === undefined ? {} : { sub_state }) })), ...over })
const my = e => rosterView({ now: iso(NOW), accounts: [e] }, { nodeLabel: () => '30家用', now: NOW })
const card = e => my(e).vendors[0].accounts[0]
const dev = accounts => ({ key: 'H', label: '30家用', self: true, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', hidden: false, removed: false,
  vendors: [{ key: 'claude', label: 'Claude', account: '', reported: true, extra: '', accounts, switchable: true, switchHint: '' }] })
const devs = () => [dev([{ email: MAIL, plan: 'pro', current: false }, { email: 'other@example.com', plan: 'pro', current: true }])]
const qr = (over = {}) => ({ grok: false, agy: false, busy: false, msg: '', confirm: '', code: null, extra: false, extraDirs: [], minimaxSupported: false, ...over })
const render = async (e, extra = {}) => {
  globalThis.Vue = Vue
  const st = { devices: devs(), accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts: my(e), ...extra }
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'accounts', meAv: '' }) }))
}

test('#2111 #1646 訂閱已失效的判斷：至少一台明說 lapsed 且沒有任何一台說 active；缺欄位、未知值、非 Claude 都不算', () => {
  assert.equal(subLapsedOf(entry([['H', 'lapsed', true]])), true)
  assert.equal(subLapsedOf(entry([['H', 'lapsed'], ['A', 'unknown']])), true, 'unknown 不推翻 lapsed')
  assert.equal(subLapsedOf(entry([['H', 'active'], ['A', 'lapsed']])), false, '兩台說法不同＝不確定，不猜')
  assert.equal(subLapsedOf(entry([['H', 'active']])), false)
  assert.equal(subLapsedOf(entry([['H', 'unknown']])), false)
  assert.equal(subLapsedOf(entry([['H', undefined]])), false, '舊後台沒有這個欄位')
  for (const bad of ['expired', 'LAPSED', '', null, true, 1, {}]) assert.equal(subLapsedOf(entry([['H', bad]])), false, JSON.stringify(bad))
  assert.equal(subLapsedOf(entry([['H', 'lapsed']], { vendor: 'codex' })), false, '只判 Claude')
  assert.equal(subLapsedOf({ vendor: 'claude', account: MAIL }), false, '沒有 nodes')
  assert.equal(subLapsedOf(undefined), false)
  assert.equal(card(entry([['H', 'lapsed', true]])).subLapsed, true)
  assert.equal(card(entry([['H', 'weird', true]])).subLapsed, false)
})

test('#2111 #1646 訂閱已失效（電腦）：紅色標籤取代方案標籤、一句紅色說明、不畫額度條、切換鈕照常', async () => {
  const e = entry([['H', 'lapsed', false]])
  const html = await render(e)
  assert.match(html, /<span class="asn-tag-fail">訂閱已失效<\/span>/)
  assert.ok(!/class="dv-plan"[^>]*>[^<]*Pro/i.test(html), '方案標籤被取代')
  assert.match(html, /<span class="asn-note-fail" role="status">訂閱已停止，額度只剩免費方案。請續訂，或改用其他帳號。<\/span>/)
  assert.ok(!html.includes('dv-bars') && !html.includes('dv-track') && !html.includes('剩 62%'), '免費方案的數字會誤導，不畫額度條')
  // 不放續訂鈕；能不能切換照常（這台還能切到這個帳號）
  assert.ok(!/續訂<\/(button|a)>/.test(html))
  const rows = accountDeviceRows(devs(), 'claude', MAIL, card(e).usedOn)
  assert.deepEqual(rows.map(r => [r.node, r.state]), [['H', 'switch']])
  assert.match(html, /<button[^>]*class="asn-btn lv-secondary fixed dv-devbtn"(?![^>]*disabled)[^>]*>切換</)
})

test('#2111 #1646 未知值、缺欄位、active 一律照現況顯示（方案標籤與額度條都在，不顯示失效）', async () => {
  for (const state of ['unknown', 'active', 'expired', undefined]) {
    const html = await render(entry([['H', state, false]]))
    assert.ok(!html.includes('訂閱已失效'), String(state))
    assert.ok(!html.includes('asn-note-fail') && !html.includes('asn-tag-fail'), String(state))
    assert.ok(html.includes('dv-bars') && html.includes('剩 62%'), `${state}：額度條照畫`)
    assert.match(html, /<span class="dv-plan">/)
  }
})

test('#2111 #1646 電腦與手機一致：同一份判斷（rosterView 的 subLapsed）、同一份文字、同一組樣式；畫面層不自己判斷', () => {
  const m = read('ui/m.html'), mjs = read('ui/m.js'), panel = read('ui/lib/settings-panel.mjs'), css = read('ui/kit.css')
  for (const src of [m, panel]) {
    assert.ok(src.includes('SUB_LAPSED_TEXT.tag') && src.includes('SUB_LAPSED_TEXT.note'), '標籤與說明都走常數')
    assert.match(src, /class="asn-tag-fail" v-if="a\.subLapsed"/)
    assert.match(src, /class="asn-note-fail" role="status" v-else-if="a\.subLapsed"/)
    assert.match(src, /exhausted && !a\.subLapsed/, '用完的紅字不和失效說明疊在一起')
  }
  assert.match(m, /<span class="m-dv-plan" v-else>/, '手機方案標籤改成失效標籤（不是並排）')
  assert.match(m, /!acctLoginLostOf\(v\.key, a\) && !a\.subLapsed && \(a\.quota\.fiveNote/, '手機失效時不畫額度的時間／舊窗備註')
  assert.match(mjs, /SUB_LAPSED_TEXT/)
  assert.ok(!/訂閱已失效|訂閱已停止/.test(m + mjs + panel), '文字只在共用常數裡')
  assert.ok(!/sub_state|subState/.test(m + mjs + panel), '畫面層都不直接讀 sub_state，只讀 rosterView 算好的 subLapsed')
  assert.match(css, /\.asn-tag-fail\{[^}]*color:var\(--kit-fail\)[^}]*border:1px solid var\(--kit-fail\)/, '紅色用危險色變數')
  assert.match(css, /\.asn-note-fail\{[^}]*color:var\(--kit-fail\)/)
  assert.equal(SUB_LAPSED_TEXT.tag, '訂閱已失效')
  assert.equal(SUB_LAPSED_TEXT.note, '訂閱已停止，額度只剩免費方案。請續訂，或改用其他帳號。')
})

test('#2111 #1646 冒煙：訂閱失效情境一整條——後台名單 → 帳號卡 → 設備列；續訂後回報 active 就恢復', async () => {
  const lapsed = entry([['H', 'lapsed', true], ['A', 'unknown']])
  const html = await render(lapsed)
  assert.ok(html.includes('訂閱已失效') && html.includes('請續訂，或改用其他帳號'))
  const rows = accountDeviceRows(devs(), 'claude', MAIL, card(lapsed).usedOn)
  assert.equal(rows[0].state, 'switch', '帳號仍能登入，切換照常')
  const back = await render(entry([['H', 'active', false]]))
  assert.ok(!back.includes('訂閱已失效') && back.includes('剩 62%'), '標籤與說明消失、額度條回來')
})

// ---- #2148 一審的四點建議 ----
test('#2111 ⑥b 建議 1：產生／撤銷代碼進行中（busy），「⋯」不能按；不忙時可按', async () => {
  const e = entry([['H', undefined, false]])
  const idle = await render(e, { quotaReaders: qr() })
  const busy = await render(e, { quotaReaders: qr({ busy: true }) })
  const more = h => [...h.matchAll(/<button[^>]*class="asn-more-btn"[^>]*>/g)].map(m => m[0])
  assert.equal(more(idle).length, 1)
  assert.ok(more(idle).every(b => !/disabled/.test(b)), '不忙時可按')
  assert.equal(more(busy).length, 1)
  assert.ok(more(busy).every(b => /disabled/.test(b)), '忙碌時不能按')
  assert.match(read('ui/lib/settings-panel.mjs'), /<asn-more-menu v-if="st\.quotaReaders" :items="accountMenuItems\(a\.shared\)" :disabled="st\.quotaReaders\.busy"/)
})

test('#2111 ⑥b 建議 2：原位確認的同意鈕文字是動作說法——重新產生查詢代碼、撤銷代碼；取消在左；busy 時兩顆都不能按', async () => {
  const key = shareKey('claude', MAIL)
  const again = shareConfirmOf(`again\n${key}`, key), revoke = shareConfirmOf(`revoke\n${key}`, key)
  assert.deepEqual([again.yes, again.danger === true], ['重新產生查詢代碼', false])
  assert.deepEqual([revoke.yes, revoke.danger === true], ['撤銷代碼', true])
  for (const t of [again.yes, revoke.yes, QUOTA_TEXT.shareCancel]) assert.doesNotMatch(t, /[？?（(]/, '不是疑問句、沒有括號自白')
  assert.equal(shareConfirmOf(`again\n${key}`, shareKey('claude', 'other@example.com')), null, '別張卡不顯示')
  const e = entry([['H', undefined, false]])
  const html = await render(e, { quotaReaders: qr({ confirm: `revoke\n${key}` }) })
  const box = html.slice(html.indexOf('dv-shareconfirm'))
  assert.ok(box.indexOf('>取消<') > -1 && box.indexOf('>取消<') < box.indexOf('>撤銷代碼<'), '取消在左、同意鈕在右')
  const busy = await render(e, { quotaReaders: qr({ confirm: `again\n${key}`, busy: true }) })
  const btns = [...busy.slice(busy.indexOf('dv-shareconfirm')).matchAll(/<button[^>]*>([^<]*)</g)].slice(0, 2)
  assert.deepEqual(btns.map(b => b[1]), ['取消', '重新產生查詢代碼'])
  assert.ok(btns.every(b => /disabled/.test(b[0])), 'busy 時兩顆都不能按')
})

test('#2111 ⑥b 建議 4：選單 CSS 的圓角與陰影走 kit.css 變數，不寫死', () => {
  const css = read('ui/kit.css')
  assert.match(css, /--radius-1:4px/)
  assert.match(css, /--shadow-pop:0 4px 14px rgba\(0,0,0,\.18\)/)
  const menu = css.split('\n').filter(l => /^\.asn-more/.test(l)).join('\n')
  assert.match(menu, /\.asn-more-list\{[^}]*border-radius:var\(--radius-1\)[^}]*box-shadow:var\(--shadow-pop\)/)
  assert.match(menu, /\.asn-more-btn\{[^}]*border-radius:var\(--radius-1\)/)
  assert.doesNotMatch(menu, /\d+px (?:\d+px )?rgba|border-radius:\s*\d+px/, '選單區塊沒有寫死的圓角或陰影')
})
