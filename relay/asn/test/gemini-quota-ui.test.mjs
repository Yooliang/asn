// Gemini 額度畫面（#374 之三）：後台帳號列表裡的 gemini 帳號（five_hour、weekly 兩窗）在「我的帳號」、
// 設備卡（電腦與手機）照 Claude 的樣子顯示；沒有資料時寫「開 Gemini 視窗後才讀得到」；Claude 的顯示不變。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { ROSTER_TEXT, rosterAccountsOn, rosterQuota, rosterView } from '../ui/lib/account-roster.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree, acctRosterView } from '../ui/lib/mobile-acct.mjs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { QUOTA_PROBES, ROSTER_GEMINI, ROSTER_GEMINI_EMPTY, ROSTER_SAMPLE, SCENARIOS, probeKind, probeSource, quotaProbeSource, tableFor } from '../scripts/smoke-lib.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-29T12:00:00Z')
const H = 3600_000
const iso = ms => new Date(ms).toISOString()
const W = 'bbbbbbbb-0000-4000-8000-000000000002', S = 'aaaaaaaa-0000-4000-8000-000000000001'
const labels = { [W]: '工作機', [S]: '家用機' }
const nodeLabel = n => labels[n] ?? '未命名設備'
const win = (name, left, readAgo, o = {}) => ({ name, left_pct: left, resets_at: null, read_at: iso(NOW - readAgo), read_node: W, ...o })
const claude = (o = {}) => ({ vendor: 'claude', account: 'a@x.test', plan: 'max', windows: [win('five_hour', 40, 3 * H), win('weekly', 72, 3 * H)], seen_at: iso(NOW - H), seen_node: W, nodes: [{ node: W, current: true, reported_at: iso(NOW - H) }], ...o })
// 後台回的 gemini：nodes 一律是空陣列（acct_roster_gemini 的說明），只有額度窗與 seen_*
const gemini = (o = {}) => ({ vendor: 'gemini', account: 'g@x.test', plan: 'Google AI Pro', windows: [win('five_hour', 55, 2 * H), win('weekly', 81, 2 * H)], seen_at: iso(NOW - 2 * H), seen_node: W, nodes: [], ...o })
const roster = accounts => ({ now: iso(NOW), accounts })
const len = s => Array.from(String(s)).length

test('提示字：沒有 Gemini 額度時寫「開 Gemini 視窗後才讀得到」，20 字內', () => {
  assert.equal(ROSTER_TEXT.geminiOff, '開 Gemini 視窗後才讀得到')
  assert.ok(len(ROSTER_TEXT.geminiOff) <= 20)
})

test('Gemini 有兩窗：照 Claude 的樣子逐窗列「5 小時」「每週」，時間不加「讀的」', () => {
  const q = rosterQuota(gemini(), { nodeLabel, now: NOW })
  assert.equal(q.known, true)
  assert.deepEqual(q.parts, ['5 小時剩 55%・2 小時前', '每週剩 81%・2 小時前'])
  assert.equal(q.text, '5 小時剩 55%、每週剩 81%')
  assert.equal(q.meta, '2 小時前・工作機')
  assert.equal(q.listMeta, '工作機')
  assert.equal(q.gone, false, 'gemini 後台不記哪幾台在回報，不能當成「沒有設備在回報」')
})

test('Gemini 沒有額度資料：寫提示，不寫「額度讀不到」', () => {
  const q = rosterQuota(gemini({ windows: [] }), { nodeLabel, now: NOW })
  assert.equal(q.known, false)
  assert.equal(q.text, ROSTER_TEXT.geminiOff)
  assert.deepEqual(q.parts, [ROSTER_TEXT.geminiOff])
  assert.equal(q.meta, '2 小時前・工作機')
})

test('「我的帳號」：Gemini 一組，名字寫 Gemini，排在 Claude、Codex 之後、Grok 之前', () => {
  const v = rosterView(roster([
    { vendor: 'grok', account: 'k@x.test', plan: '', windows: [], seen_at: iso(NOW - H), seen_node: W, nodes: [] },
    gemini(), claude(), claude({ vendor: 'codex', windows: [] }),
  ]), { nodeLabel, now: NOW })
  assert.deepEqual(v.vendors.map(g => g.key), ['claude', 'codex', 'gemini', 'grok'])
  const g = v.vendors.find(x => x.key === 'gemini')
  assert.equal(g.label, 'Gemini')
  assert.equal(g.accounts[0].plan, 'Google AI Pro')
  assert.deepEqual(g.accounts[0].quota.parts, ['5 小時剩 55%・2 小時前', '每週剩 81%・2 小時前'])
})

test('Claude 不受影響：加了 Gemini 前後，Claude 那一組一模一樣', () => {
  const before = rosterView(roster([claude(), claude({ vendor: 'codex', windows: [] })]), { nodeLabel, now: NOW })
  const after = rosterView(roster([claude(), claude({ vendor: 'codex', windows: [] }), gemini()]), { nodeLabel, now: NOW })
  assert.deepEqual(after.vendors.filter(g => g.key !== 'gemini'), before.vendors)
  assert.deepEqual(rosterQuota(claude({ nodes: [] }), { nodeLabel, now: NOW }).parts, ['5 小時剩 40%・3 小時前讀的', '每週剩 72%・3 小時前讀的'], 'Claude 沒有設備在回報仍寫「讀的」')
})

test('某台設備的 Gemini 帳號：看列表裡哪台讀的（read_node／seen_node），不認得的台不算', () => {
  const r = roster([gemini(), gemini({ account: 'h@x.test', windows: [win('five_hour', 9, H, { read_node: S })], seen_node: S }), claude()])
  const onW = rosterAccountsOn(r, 'gemini', W, { nodeLabel, now: NOW })
  assert.deepEqual(onW.map(a => a.email), ['g@x.test'])
  assert.equal(onW[0].plan, 'Google AI Pro')
  assert.equal(onW[0].current, false)
  assert.equal(onW[0].quota.text, '5 小時剩 55%、每週剩 81%')
  assert.deepEqual(rosterAccountsOn(r, 'gemini', S, { nodeLabel, now: NOW }).map(a => a.email), ['h@x.test'])
  assert.deepEqual(rosterAccountsOn(r, 'gemini', 'zzz'), [])
  assert.deepEqual(rosterAccountsOn(null, 'gemini', W), [], '列表讀不到就沒有')
  // 沒有額度窗、只有 seen_node 的也算那台的（寫提示）
  const empty = rosterAccountsOn(roster([gemini({ windows: [] })]), 'gemini', W, { nodeLabel, now: NOW })
  assert.equal(empty[0].quota.text, ROSTER_TEXT.geminiOff)
})

const friends = [
  { node: S, device: '家用機', engine: 'claude', kind: 'pc', status: 'online', id: `${S}/c` },
  { node: W, device: '工作機', engine: 'claude', kind: 'pc', status: 'online', id: `${W}/c` },
  { node: W, device: '工作機', engine: 'gemini', kind: 'pc', status: 'online', id: `${W}/g` },
]
const reports = { [W]: { error: '', asnOnline: true, reportedAt: iso(NOW - H), accounts: [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 99, weekly_pct: 99, at: iso(NOW - 5 * H) }] } }
const self = { claude: [{ email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 11, weekly_pct: 22, at: iso(NOW - 60_000) }] }

test('設備卡：開過 Gemini 的那台列出 Gemini 帳號與兩窗額度；Claude 照舊', () => {
  const t = buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, asn: { [W]: [{}] }, reports, self, now: NOW, roster: roster([claude(), gemini()]) })
  const w = t.find(d => d.key === W)
  const g = w.vendors.find(v => v.key === 'gemini')
  assert.equal(g.label, 'Gemini')
  assert.deepEqual(g.accounts.map(a => a.email), ['g@x.test'])
  assert.equal(g.accounts[0].quota.text, '5 小時剩 55%、每週剩 81%')
  assert.equal(g.accounts[0].quota.meta, '2 小時前・工作機')
  assert.equal(w.vendors.find(v => v.key === 'claude').accounts[0].quota.text, '5 小時剩 40%、每週剩 72%')
  assert.equal(t.find(d => d.self).vendors.find(v => v.key === 'claude').accounts[0].quota.text, '5 小時剩 11%、每週剩 22%', '本機 Claude 照舊用本機紀錄')
  assert.equal(t.find(d => d.self).vendors.some(v => v.key === 'gemini'), false, '沒開過 Gemini 的那台不多出 Gemini')
})

test('設備卡：有 Gemini 但讀不到額度（列表沒有它、或後台讀不到）→ 寫提示', () => {
  for (const r of [roster([claude()]), null]) {
    const w = buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports, self, now: NOW, roster: r }).find(d => d.key === W)
    const g = w.vendors.find(v => v.key === 'gemini')
    assert.deepEqual(g.accounts, [])
    assert.equal(g.note, ROSTER_TEXT.geminiOff)
  }
})

test('設備卡：沒有 Gemini 的設備跟以前一模一樣（不多 note、不多欄位）', () => {
  const plain = friends.filter(f => f.engine !== 'gemini')
  const t = buildDeviceTree({ friends: plain, nodeOrder: [S, W], selfNode: S, reports, self, now: NOW, roster: roster([claude()]) })
  for (const d of t) for (const v of d.vendors) assert.equal('note' in v, false)
})

test('手機：設備卡與「我的帳號」用同一套，Gemini 照樣出現；沒資料時樣板會寫提示', () => {
  const r = roster([claude(), gemini()])
  const rep = { [W]: { loading: false, asnOnline: true, reportedAt: iso(NOW - H), msg: '', list: reports[W].accounts } }
  const t = acctDeviceTree({ friends, nodeOrder: [S, W], selfNode: 'phone', reports: rep, roster: r, now: NOW })
  assert.equal(t.find(d => d.key === W).vendors.find(v => v.key === 'gemini').accounts[0].quota.text, '5 小時剩 55%、每週剩 81%')
  const my = acctRosterView(r, { friends, selfNode: 'phone', now: NOW })
  assert.deepEqual(my.vendors.find(g => g.key === 'gemini').accounts[0].quota.parts, ['5 小時剩 55%・2 小時前', '每週剩 81%・2 小時前'])
  assert.ok(read('ui/m.html').includes("(v.note || '目前未回報任何帳號')"), '手機設備卡沒帳號時先寫 note')
})

// ---------- 電腦設定頁（實際渲染） ----------
const ACCT = { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', allowSwitch: true, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }
const render = async (st, curDev = '') => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'devices', meAv: '', ...(curDev ? { initialDev: curDev } : {}) }) }))
}

test('電腦設定頁「我的帳號」：Gemini 兩窗都顯示；沒資料寫提示；Claude 那一段不變', async () => {
  const withG = await render({ devices: [], accounts: ACCT, myAccounts: rosterView(roster([claude(), gemini()]), { nodeLabel, now: NOW }) })
  assert.ok(withG.includes('data-vendor="gemini"'))
  assert.ok(withG.includes('<b>Gemini</b>'))
  assert.ok(withG.includes('剩 55%') && withG.includes('剩 81%') && withG.includes('2 小時前'), '兩條額度條（#374）')
  const noG = await render({ devices: [], accounts: ACCT, myAccounts: rosterView(roster([claude(), gemini({ windows: [] })]), { nodeLabel, now: NOW }) })
  assert.ok(noG.includes('開 Gemini 視窗後才讀得到'))
  const only = await render({ devices: [], accounts: ACCT, myAccounts: rosterView(roster([claude()]), { nodeLabel, now: NOW }) })
  const claudePart = h => h.slice(h.indexOf('data-vendor="claude"'), h.indexOf('</div>', h.indexOf('data-vendor="claude"')))
  assert.equal(claudePart(withG), claudePart(only))
  assert.ok(claudePart(only).includes('剩 40%') && claudePart(only).includes('3 小時前'))
})

// ---------- 冒煙情境 ----------
test('冒煙情境：有 Gemini 額度兩條都顯示、沒資料顯示提示、Claude 不受影響；探測式語法正確', () => {
  const ok = SCENARIOS.find(s => s.name === 'list-roster-gemini'), none = SCENARIOS.find(s => s.name === 'list-roster-gemini-empty')
  const mob = SCENARIOS.find(s => s.name === 'm-roster-gemini')
  assert.ok(ok && none && mob)
  assert.deepEqual(tableFor(ok).acct_roster, ROSTER_GEMINI)
  assert.deepEqual(tableFor(none).acct_roster, ROSTER_GEMINI_EMPTY)
  assert.deepEqual(tableFor(mob).android_acct_roster, ROSTER_GEMINI)
  assert.equal(ROSTER_GEMINI.accounts.find(a => a.vendor === 'claude').windows.length, 2)
  assert.deepEqual(ROSTER_GEMINI.accounts.filter(a => a.vendor === 'claude'), ROSTER_SAMPLE.accounts.filter(a => a.vendor === 'claude'), 'Claude 那一筆跟原本的冒煙資料相同')
  assert.deepEqual(QUOTA_PROBES.gemini.want.gemini, ['Gemini', '5 小時', '剩', '每週', '剩'], '先認組名：舊畫面寫成小寫的 gemini；#374 起是兩條額度條')
  assert.deepEqual(QUOTA_PROBES.geminiEmpty.want.gemini, ['Gemini', '開 Gemini 視窗後才讀得到'])
  for (const p of [QUOTA_PROBES.gemini, QUOTA_PROBES.geminiEmpty, QUOTA_PROBES.mobile]) {
    assert.deepEqual(p.want.claude, ['Claude', '5 小時', '剩 40%', '每週', '剩 72%'], 'Claude 一定一起檢查')
    assert.doesNotThrow(() => new vm.Script(quotaProbeSource(p)))
    assert.equal(probeSource(p), quotaProbeSource(p))
    assert.equal(probeKind(p), '額度畫面檢查')
  }
  assert.equal(ok.probe, QUOTA_PROBES.gemini)
  assert.equal(none.probe, QUOTA_PROBES.geminiEmpty)
  assert.equal(mob.probe, QUOTA_PROBES.mobile)
})
