// #2111 ⑤ #1960 登入失效：那台那一列放黃色「重新登入」，名單上方提示寫明哪台哪家，卡片頂端標籤與額度區。
// 電腦（settings-panel）與手機（m.js／m.html）共用 account-roster.mjs 的判斷與文字，這裡用設備樹實際的形狀（帳號回報裡的 loginFailed、設備樹算好的 relogin 入口）守住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { LOGIN_LOST_TEXT, accountDeviceRows, accountLoginLost, loginLostNotices, rosterView } from '../ui/lib/account-roster.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-11-22T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const MAIL = 'dave@example.test'
const OTHER = 'w@example.test'
const NAMES = { H: '30家用', W: '工作機' }

const dev = (key, label, vendors, over = {}) => ({ key, label, self: false, hidden: false, removed: false, kind: '電腦', vendors, ...over })
const claude = (accounts, over = {}) => ({ key: 'claude', switchable: true, switchHint: '', accounts, ...over })
const acc = (email = MAIL, current = false, extra = {}) => ({ email, current, ...extra })
const rows = devices => accountDeviceRows(devices, 'claude', MAIL, [])

// 本機 H 登入失效（設備樹給本機入口 local）；別台 W 正常
const failedHere = () => [
  dev('H', '30家用', [claude([acc(MAIL, true, { loginFailed: true }), acc(OTHER)], { relogin: { kind: 'local' } })], { self: true }),
  dev('W', '工作機', [claude([acc(MAIL), acc(OTHER, true)])]),
]
// 別台 W 登入失效（設備樹給 remote 入口）；本機正常
const failedThere = (relogin = { kind: 'remote' }) => [
  dev('H', '30家用', [claude([acc(MAIL), acc(OTHER, true)])], { self: true }),
  dev('W', '工作機', [claude([acc(MAIL, true, { loginFailed: true }), acc(OTHER)], relogin ? { relogin } : {})]),
]

const mine = () => rosterView({ now: iso(NOW), accounts: [{ vendor: 'claude', account: MAIL, plan: 'pro', windows: [{ name: 'five_hour', left_pct: 80, read_at: iso(NOW), read_node: 'H' }], seen_at: iso(NOW), seen_node: 'H', nodes: ['H', 'W'].map(n => ({ node: n, current: true, reported_at: iso(NOW) })) }] }, { nodeLabel: n => NAMES[n] ?? '', now: NOW })
const page = async devices => {
  globalThis.Vue = Vue
  const st = { devices, accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts: mine(), relogin: { target: '', kind: 'remote', stage: 'idle', lead: '', text: '', note: '', ok: false } }
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'accounts', meAv: '' }) }))
}
const rowsHtml = html => html.split(/(?=<span class="dv-devrow)/).slice(1)

test('#1960 失效那台那一列是「重新登入」（可以按），其他列不是', () => {
  const r = rows(failedHere())
  assert.deepEqual(r.map(x => [x.node, x.state, x.reason, x.relogin ?? '']), [['H', 'relogin', '登入已失效', 'local'], ['W', 'switch', '', '']])
  assert.equal(accountLoginLost(r), true)
  assert.equal(accountLoginLost(rows([dev('H', '30家用', [claude([acc(MAIL, true)])], { self: true })])), false)
})

test('#1960 別台失效：可以遠端重新登入就放鈕；現在做不到（離線、ASN 沒開）就不放鈕、寫「到那台重新登入」', () => {
  assert.deepEqual(rows(failedThere()).map(x => [x.node, x.state, x.relogin ?? '']), [['H', 'switch', ''], ['W', 'relogin', 'remote']])
  const none = rows(failedThere(null)).find(x => x.node === 'W')
  assert.equal(none.state, 'expired')
  assert.equal(none.reason, '登入已失效，到那台重新登入')
  assert.equal(none.relogin, '')
})

test('#1960 名單上方提示：寫出設備名與廠商名；本機寫「這台（名）」，別台寫那台的名字', () => {
  const sec = [{ key: 'claude', label: 'Claude', accounts: [{ account: MAIL }] }]
  const here = loginLostNotices(sec, () => rows(failedHere()))
  assert.deepEqual(here.map(n => n.text), ['這台（30家用）的 Claude 帳號 dave@example.test 需要重新登入，登入前不能切換到這個帳號。'])
  const there = loginLostNotices(sec, () => rows(failedThere()))
  assert.deepEqual(there.map(n => n.text), ['工作機的 Claude 帳號 dave@example.test 需要重新登入，登入前不能切換到這個帳號。'])
  assert.deepEqual(loginLostNotices(sec, () => rows([dev('H', '30家用', [claude([acc(MAIL, true)])], { self: true })])), [], '沒失效就沒有提示')
})

test('#1960 電腦畫面：黃色鈕只在失效那列且在列尾（同一欄）；提示不含鈕；頂端標籤與額度文字', async () => {
  const html = await page(failedHere())
  assert.equal((html.match(/st-relogin/g) ?? []).length, 1, '黃色鈕只有一顆')
  const lines = rowsHtml(html)
  const hRow = lines.find(l => l.includes('30家用')), wRow = lines.find(l => l.includes('工作機'))
  assert.match(hRow, /<button[^>]*class="asn-btn lv-secondary st-relogin fixed dv-devbtn dv-relogin-btn"[^>]*>重新登入<\/button><\/span>/, '失效那列列尾有黃色重新登入')
  assert.ok(hRow.includes('登入已失效'), '設備名下方寫登入已失效')
  assert.ok(!wRow.includes('st-relogin') && !wRow.includes('重新登入'), '其他列沒有')
  assert.match(wRow, /<button[^>]*dv-devbtn[^>]*>[^<]*<\/button><\/span>/, '其他列的鈕也在列尾，與失效那列同一欄')
  const notes = html.match(/<ul class="dv-lostnotes"[^>]*>.*?<\/ul>/s)?.[0] ?? ''
  assert.ok(notes.includes('30家用') && notes.includes('Claude'), '提示寫設備名與廠商名')
  assert.ok(!notes.includes('<button'), '提示本身不放鈕')
  assert.ok(html.includes('<span class="dv-lost">登入已失效</span>'), '頂端標籤')
  assert.ok(html.includes('額度暫時看不到') && !html.includes('剩 80%'), '額度區寫額度暫時看不到，不畫舊額度條')
})

test('#1960 別台失效：提示寫那台的名字、鈕在那台那一列', async () => {
  const html = await page(failedThere())
  const notes = html.match(/<ul class="dv-lostnotes"[^>]*>.*?<\/ul>/s)?.[0] ?? ''
  assert.ok(notes.includes('工作機的 Claude 帳號') && !notes.includes('這台（'))
  const lines = rowsHtml(html)
  assert.ok(lines.find(l => l.includes('工作機')).includes('st-relogin'))
  assert.ok(!lines.find(l => l.includes('30家用')).includes('st-relogin'))
})

test('#1960 重新登入成功後（帳號回報不再失效）：提示、標籤、黃鈕一起消失，額度回來', async () => {
  const html = await page([
    dev('H', '30家用', [claude([acc(MAIL, true), acc(OTHER)])], { self: true }),
    dev('W', '工作機', [claude([acc(MAIL), acc(OTHER, true)])]),
  ])
  for (const t of ['dv-lostnotes', 'dv-lost"', 'st-relogin', '額度暫時看不到', '登入已失效']) assert.ok(!html.includes(t), `不應再有：${t}`)
  assert.ok(html.includes('剩 80%'))
  // 完成後要重讀列表：電腦的流程有 onDone，手機的 setupFinish 重讀列表與那台的回報
  assert.match(read('ui/lib/relogin-flow.mjs'), /onDone\(ok, s\.node\)/)
  assert.match(read('ui/list.js'), /onDone: \(ok, node\) => \{ if \(!ok\) return; void accounts\.refreshRoster\(\)/)
  assert.match(read('ui/m.js'), /if \(ok && setupSt\.mode === 'relogin'\) \{ void loadRoster\(\); void loadAcct\(setupSt\.node, true\) \}/)
})

test('#1960 電腦與手機同一份判斷與文字：手機用同一組函式、同一份文字，鈕用黃色變數、不寫死色碼', () => {
  const m = read('ui/m.js'), mh = read('ui/m.html'), panel = read('ui/lib/settings-panel.mjs'), css = read('ui/mobile.css'), kit = read('ui/kit.css')
  for (const src of [m, panel]) { assert.match(src, /loginLostNotices\(/); assert.match(src, /accountLoginLost\(/) }
  for (const src of [mh, panel]) for (const k of ['tag', 'quota', 'button']) assert.ok(src.includes(`LOGIN_LOST_TEXT.${k}`), k)
  assert.match(css, /\.m-dv-dev\.relogin\{background:var\(--kit-relogin-bg\)/)
  assert.match(kit, /--kit-relogin-bg/)
  assert.ok(!css.split(String.fromCharCode(10)).filter(l => l.includes('.relogin') || l.includes('m-dv-lost')).some(l => /#[0-9a-f]{3,6}/i.test(l)), '黃色與警告色的色碼只在 kit.css 的變數裡')
  assert.deepEqual([LOGIN_LOST_TEXT.row, LOGIN_LOST_TEXT.tag, LOGIN_LOST_TEXT.quota, LOGIN_LOST_TEXT.button], ['登入已失效', '登入已失效', '額度暫時看不到', '重新登入'])
})
