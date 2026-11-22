// #2111 ①：帳號頁文案、舊資料呈現、額度條固定長度。電腦與手機吃同一份帳號資料（rosterView）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { rosterView, nodeLabelOf } from '../ui/lib/account-roster.mjs'
import { acctRosterView } from '../ui/lib/mobile-acct.mjs'
import { QUOTA_TEXT } from '../ui/lib/quota-readers.mjs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-29T12:00:00Z')
const H = 3600_000
const iso = ms => new Date(ms).toISOString()
const W = 'bbbbbbbb-0000-4000-8000-000000000002'
const nodeLabel = () => '工作機'
const win = (name, left, readAgo) => ({ name, left_pct: left, resets_at: iso(NOW + 3 * H), read_at: iso(NOW - readAgo), read_node: W })
const entry = (account, readAgo, o = {}) => ({ vendor: 'claude', account, plan: 'max', windows: [win('five_hour', 40, readAgo), win('weekly', 72, readAgo)], seen_at: iso(NOW - H), seen_node: W, nodes: [{ node: W, current: false, reported_at: iso(NOW - H) }], ...o })
// 一筆新的、一筆 2 天前的、一筆 11 小時前的（過期門檻照舊：每週 6 小時、5 小時那條 30 分鐘）
const ROSTER = { now: iso(NOW), accounts: [entry('fresh@x.test', 10 * 60_000), entry('old@x.test', 48 * H), entry('half@x.test', 11 * H)] }
const ACCT = { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', allowSwitch: true, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }
const BANNED = ['都是關的', '較舊', '開新視窗就會更新', '目前沒有設備在用', '舊資料']

const desk = rosterView(ROSTER, { nodeLabel, now: NOW })
const phone = acctRosterView(ROSTER, { friends: [], now: NOW })
const accountsOf = v => v.vendors.find(x => x.key === "claude").accounts.slice().sort((a, b) => a.account.localeCompare(b.account))
const byName = v => Object.fromEntries(accountsOf(v).map(a => [a.account.split("@")[0], a]))
const view = v => accountsOf(v).map(({ quota: q }) => ({ stale: q.stale, ageLabel: q.ageLabel, text: q.text, bars: q.bars }))
const render = async st => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'accounts', meAv: '' }) }))
}

test('#2111 (a) 電腦與手機吃同一份帳號資料，兩邊都不出現被拿掉的說明', async () => {
  assert.deepEqual(view(phone), view(desk), '手機與電腦同一份資料')
  const html = await render({ devices: [], accounts: ACCT, myAccounts: desk, quotaReaders: { grok: false, extra: false, extraDirs: [], busy: false, minimax: [], minimaxSupported: true, confirm: '', extraRefresh: false } })
  for (const t of BANNED) assert.ok(!html.includes(t), `電腦畫面不能有「${t}」`)
  assert.ok(!('note' in QUOTA_TEXT))
  const m = read('ui/m.html'), panel = read('ui/lib/settings-panel.mjs')
  const src = [m, panel, read('ui/lib/quota-readers.mjs'), read('ui/lib/account-quota.mjs'), read('ui/lib/account-roster.mjs'), read('ui/lib/mobile-acct.mjs')].join('\n')
  for (const t of ['都是關的', '開新視窗就會更新', '目前沒有設備在用', '資料較舊']) assert.ok(!src.includes(t), `程式裡不能還有「${t}」`)
  assert.doesNotMatch(m + panel, /oldText|idleText|QUOTA_TEXT\.note/)
})

test('#2111 (b) 過期時額度區有淡色 class、沒有「舊資料」字樣；未過期沒有', async () => {
  const { fresh, old, half } = byName(desk)
  assert.equal(fresh.quota.stale, false)
  assert.equal(old.quota.stale, true)
  assert.equal(half.quota.stale, true, '過期門檻沿用：每週 11 小時前就算過期')
  const html = await render({ devices: [], accounts: ACCT, myAccounts: desk })
  const card = k => html.slice(html.indexOf(`${k}@x.test`), html.indexOf('</li>', html.indexOf(`${k}@x.test`)) + 1)
  assert.match(card('fresh'), /class="dv-quota"/)
  assert.doesNotMatch(card('fresh'), /stale dv-quota/, '未過期：沒有淡色 class')
  assert.match(card('old'), /class="stale dv-quota"/)
  assert.ok(!html.includes('舊資料'))
  // 手機同一條規則：同一個 stale 旗標掛成 .m-dv-quota.stale，樣式把整個額度條（含百分比與重置時間）淡掉
  assert.match(read('ui/m.html'), /class="m-dv-quota" :class="\{ stale: a\.quota\.stale/)
  assert.match(read('ui/mobile.css'), /\.m-dv-quota\.stale \.m-dv-bars\{opacity:/)
  assert.match(read('ui/style.css'), /\.dv-quota\.stale \.dv-bars\{opacity:/)
})

test('#2111 (c) 帳號後面的時間只有「N 天前」之類', async () => {
  const { fresh, old, half } = byName(desk)
  assert.equal(fresh.quota.ageLabel, '10 分鐘前')
  assert.equal(old.quota.ageLabel, '2 天前')
  assert.equal(half.quota.ageLabel, '11 小時前')
  for (const a of accountsOf(desk)) assert.match(a.quota.ageLabel, /^\d+ (分鐘|小時|天)前$/)
  const html = await render({ devices: [], accounts: ACCT, myAccounts: desk })
  assert.ok(html.includes('<span class="dv-age">（2 天前）</span>'))
})

test('#2111 額度條固定長度：電腦 200px、手機 130px，兩邊樣式都沒有可伸縮的軌道', () => {
  const css = read('ui/style.css'), mcss = read('ui/mobile.css')
  assert.match(css, /\.dv-track\{flex:0 1 200px;/)
  assert.match(mcss, /\.m-dv-bar\{display:grid;grid-template-columns:3\.4em minmax\(40px,130px\) 4\.2em/)
  assert.doesNotMatch(css, /\.dv-track\{[^}]*(flex:1|max-width:220px)/)
})
