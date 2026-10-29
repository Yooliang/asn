// 帳號列表第一批（#374，畫面）：後台 acct_roster 的列表 → 畫面資料；設備卡與切換選單改看列表、讀不到退回舊顯示；
// 「我的帳號」區；手機切換選單用同一份；讀取時機的接線守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
  ROSTER_TEXT, ROSTER_POLL_MS, DEVICE_MAX, fetchRoster, nodeLabelOf, rosterLookup, rosterOk, rosterQuota, rosterQuotaFor, rosterView, shortDevice, windowLabel,
} from '../ui/lib/account-roster.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { dialogView } from '../ui/lib/device-acct-dialog.mjs'
import { acctDeviceTree, acctRosterView, acctSheetView } from '../ui/lib/mobile-acct.mjs'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { createAccountsUi } from '../ui/lib/claude-accounts.mjs'
import { ROSTER_SAMPLE, SCENARIOS, tableFor } from '../scripts/smoke-lib.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-29T12:00:00Z')
const H = 3600_000, D = 24 * H
const iso = ms => new Date(ms).toISOString()
const W = 'bbbbbbbb-0000-4000-8000-000000000002', S = 'aaaaaaaa-0000-4000-8000-000000000001'
const labels = { [W]: '工作機', [S]: '家用機' }
const nodeLabel = n => labels[n] ?? '未命名設備'
const win = (name, left, readAgo, o = {}) => ({ name, left_pct: left, resets_at: null, read_at: iso(NOW - readAgo), read_node: W, ...o })
const entry = (o = {}) => ({ vendor: 'claude', account: 'a@x.test', plan: 'max', windows: [win('five_hour', 40, 3 * H), win('weekly', 72, 3 * H)], seen_at: iso(NOW - H), seen_node: W, nodes: [{ node: W, current: true, reported_at: iso(NOW - H) }], ...o })
const roster = accounts => ({ now: iso(NOW), accounts })
const len = s => Array.from(String(s)).length
// 畫面上的字（不含使用者自己的 email、方案）每一句都在 20 字內
const assertShort = q => { for (const s of [q.text, q.meta, q.resetText, ...(q.parts ?? [])].filter(Boolean)) assert.ok(len(s) <= 20, `超過 20 字：${s}（${len(s)}）`) }

// ---------- 轉換 ----------
test('額度窗名稱：5 小時、每週；Codex 其他長度換成好懂的名字', () => {
  assert.equal(windowLabel('five_hour'), '5 小時')
  assert.equal(windowLabel('weekly'), '每週')
  assert.equal(windowLabel('w300'), '5 小時')
  assert.equal(windowLabel('w10080'), '每週')
  assert.equal(windowLabel('w1440'), '每天')
  assert.equal(windowLabel('w43200'), '30 天')
  assert.equal(windowLabel('w60'), '1 小時')
  assert.equal(windowLabel('w90'), '90 分鐘')
  assert.equal(windowLabel('zzz'), '額度')
  assert.equal(windowLabel(undefined), '額度')
})

test('設備名截到 8 字；空的寫「未命名設備」', () => {
  assert.equal(DEVICE_MAX, 8)
  assert.equal(shortDevice('工作機'), '工作機')
  assert.equal(shortDevice('一二三四五六七八九十'), '一二三四五六七八')
  assert.equal(shortDevice('abcdefghijk'), 'abcdefgh')
  assert.equal(shortDevice(''), '未命名設備')
})

test('有數字：每窗一句「5 小時剩 40%」，時間寫「3 小時前・工作機」', () => {
  const q = rosterQuota(entry(), { nodeLabel, now: NOW })
  assert.equal(q.known, true)
  assert.deepEqual(q.parts, ['5 小時剩 40%', '每週剩 72%'])
  assert.equal(q.text, '5 小時剩 40%、每週剩 72%')
  assert.equal(q.meta, '3 小時前・工作機')
  assert.equal(q.stale, false)
  assert.equal(q.exhausted, false)
  assert.equal(q.gone, false)
  assertShort(q)
})

test('時間取最晚讀到的那一窗，設備也是那一窗的；設備名長的截到 8 字', () => {
  const e = entry({ windows: [win('five_hour', 10, 2 * H, { read_node: S }), win('weekly', 50, 30 * 60_000, { read_node: 'long' })] })
  const q = rosterQuota(e, { nodeLabel: n => (n === 'long' ? '小良哥的超級無敵大電腦' : nodeLabel(n)), now: NOW })
  assert.equal(q.meta, '30 分鐘前・小良哥的超級無敵')
  assertShort(q)
})

test('不再回報的帳號（nodes 空）：標「N 天前讀的」', () => {
  const q = rosterQuota(entry({ nodes: [], windows: [win('five_hour', 40, 3 * D), win('weekly', 72, 3 * D)] }), { nodeLabel, now: NOW })
  assert.equal(q.meta, '3 天前讀的・工作機')
  assert.equal(q.gone, true)
  assert.equal(q.stale, true)
  assertShort(q)
  const longest = rosterQuota(entry({ nodes: [], windows: [win('five_hour', 1, 29 * D)] }), { nodeLabel: () => '一二三四五六七八九十', now: NOW })
  assert.equal(longest.meta, '29 天前讀的・一二三四五六七八')
  assertShort(longest)
})

test('沒數字：寫「額度讀不到」；Codex 寫「開 Codex 後才讀得到」；Grok 有數字也不收', () => {
  const c = rosterQuota(entry({ windows: [] }), { nodeLabel, now: NOW })
  assert.equal(c.known, false)
  assert.equal(c.text, ROSTER_TEXT.noQuota)
  assert.equal(c.meta, '1 小時前・工作機', '沒數字也寫最後是哪台、多久前回報的')
  const x = rosterQuota(entry({ vendor: 'codex', windows: [] }), { nodeLabel, now: NOW })
  assert.equal(x.text, '開 Codex 後才讀得到')
  const g = rosterQuota(entry({ vendor: 'grok' }), { nodeLabel, now: NOW })
  assert.equal(g.text, '額度讀不到')
  assert.equal(g.known, false)
  for (const q of [c, x, g]) { assertShort(q); assert.ok(q.text.trim(), '不留空白') }
})

test('壞掉的窗略過，不編數字；全壞就當沒數字', () => {
  const q = rosterQuota(entry({ windows: [{ name: 'five_hour', left_pct: 'x', read_at: iso(NOW) }, { name: 'weekly', left_pct: 120, read_at: iso(NOW) }, { name: 'weekly', left_pct: 5 }] }), { nodeLabel, now: NOW })
  assert.equal(q.known, false)
  assert.equal(q.text, '額度讀不到')
  assert.equal(rosterQuota(null, { now: NOW }).text, '額度讀不到')
})

test('用完而且還沒重置：標用完，寫哪一窗約幾小時後重置', () => {
  const q = rosterQuota(entry({ windows: [win('five_hour', 0, H, { resets_at: iso(NOW + 3 * H) }), win('weekly', 50, H)] }), { nodeLabel, now: NOW })
  assert.equal(q.exhausted, true)
  assert.equal(q.resetText, '5 小時額度約 3 小時後重置')
  assertShort(q)
  const past = rosterQuota(entry({ windows: [win('five_hour', 0, H, { resets_at: iso(NOW - H) })] }), { nodeLabel, now: NOW })
  assert.equal(past.exhausted, false)
  assert.equal(past.resetText, '')
})

test('Codex 的窗照 5 小時、每週、其他由短到長排', () => {
  const q = rosterQuota(entry({ vendor: 'codex', windows: [win('w43200', 9, H), win('weekly', 80, H), win('five_hour', 60, H)] }), { nodeLabel, now: NOW })
  assert.deepEqual(q.parts, ['5 小時剩 60%', '每週剩 80%', '30 天剩 9%'])
  for (const p of q.parts) assert.ok(len(p) <= 20)
})

test('接成一行的字（設備卡、切換對話框）：後台給 4 個窗也只放 5 小時、每週兩窗，≤20 字；逐窗的 parts 照列', () => {
  const e = entry({ vendor: 'codex', windows: [win('w43200', 100, H), win('w1440', 100, H), win('weekly', 100, H), win('five_hour', 100, H)] })
  const q = rosterQuota(e, { nodeLabel, now: NOW })
  assert.equal(q.text, '5 小時剩 100%、每週剩 100%')
  assert.ok(len(q.text) <= 20, `${q.text}（${len(q.text)}）`)
  assert.equal(q.parts.length, 4, '「我的帳號」區照樣逐窗列出')
  // 設備卡與切換對話框用的就是這一行
  const r = roster([e])
  const t = buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports: { [W]: { ...reports[W] } }, self, now: NOW, roster: r })
  assert.equal(t.find(d => d.key === W).vendors.find(v => v.key === 'codex').accounts[0].quota.text, q.text)
  const dv = dialogView({ ...remote, list: [{ vendor: 'codex', email: 'a@x.test', plan: '', current: true }] }, '', NOW, { quotaOf: x => rosterQuotaFor(r, 'codex', x, { nodeLabel, now: NOW }) })
  assert.equal(dv.rows[0].quotaText, q.text)
  // 只有其他長度的窗（目前不會發生）：放最短的一窗，不留空白
  assert.equal(rosterQuota(entry({ windows: [win('w43200', 9, H), win('w1440', 50, H)] }), { nodeLabel, now: NOW }).text, '每天剩 50%')
})

test('不改輸入：轉換前後的列表一模一樣', () => {
  const r = roster([entry(), entry({ vendor: 'codex', windows: [] })])
  const before = JSON.stringify(r)
  rosterView(r, { nodeLabel, now: NOW }); rosterQuota(r.accounts[0], { nodeLabel, now: NOW }); rosterLookup(r)('claude', 'a@x.test')
  assert.equal(JSON.stringify(r), before)
})

test('列表能不能用：沒有 accounts、帶 error、null 都不能用', () => {
  assert.equal(rosterOk(roster([])), true)
  for (const bad of [null, undefined, {}, { error: 'forbidden' }, { accounts: 'x' }, 'x']) assert.equal(rosterOk(bad), false)
  assert.equal(rosterView({ error: 'forbidden' }), null)
  assert.equal(rosterLookup(null)('claude', 'a@x.test'), null)
  assert.equal(rosterQuotaFor(null, 'claude', 'a@x.test'), undefined)
})

test('查帳號：廠牌＋帳號對，email 不分大小寫；廠牌不同查不到', () => {
  const look = rosterLookup(roster([entry()]))
  assert.equal(look('claude', 'A@X.test')?.account, 'a@x.test')
  assert.equal(look('codex', 'a@x.test'), null)
})

test('「我的帳號」：按廠牌分組（Claude、Codex、Grok），每個帳號有剩幾 %、多久前、哪台；使用中看 nodes', () => {
  const v = rosterView(roster([
    entry({ vendor: 'grok', account: 'g@x.test', windows: [] }),
    entry({ vendor: 'codex', account: 'c@x.test', windows: [], nodes: [] }),
    entry({ account: 'b@x.test', nodes: [{ node: S, current: false }] }),
    entry(),
  ]), { nodeLabel, now: NOW })
  assert.equal(v.title, '我的帳號')
  assert.equal(v.empty, '')
  assert.deepEqual(v.vendors.map(x => x.key), ['claude', 'codex', 'grok'])
  assert.deepEqual(v.vendors[0].accounts.map(a => [a.account, a.current]), [['a@x.test', true], ['b@x.test', false]])
  assert.equal(v.vendors[0].accounts[0].quota.text, '5 小時剩 40%、每週剩 72%')
  assert.equal(v.vendors[1].accounts[0].quota.text, '開 Codex 後才讀得到')
  assert.equal(v.vendors[2].accounts[0].quota.text, '額度讀不到')
  for (const g of v.vendors) for (const a of g.accounts) assertShort(a.quota)
  assert.equal(rosterView(roster([]), { now: NOW }).empty, '還沒有帳號回報')
  for (const s of Object.values(ROSTER_TEXT)) assert.ok(len(s) <= 20)
})

test('設備名稱對照：名單的 device 欄；本機用指定的稱呼；對不到寫「未命名設備」', () => {
  const f = nodeLabelOf([{ node: W, device: '工作機' }, { node: W, device: '別名' }], { selfNode: S, selfLabel: '這台電腦' })
  assert.equal(f(W), '工作機')
  assert.equal(f(S), '這台電腦')
  assert.equal(f('zzz'), '未命名設備')
})

test('讀列表：成功回列表；404／forbidden／格式不對都回 null，只記 console', async () => {
  const logs = []
  const log = (...a) => logs.push(a.join(' '))
  assert.deepEqual(await fetchRoster(async () => roster([]), log), roster([]))
  assert.equal(await fetchRoster(async () => { throw 'acct_roster HTTP 404 not_found' }, log), null)
  assert.equal(await fetchRoster(async () => { throw new Error('acct_roster HTTP 403 forbidden') }, log), null)
  assert.equal(await fetchRoster(async () => ({ error: 'forbidden' }), log), null)
  assert.equal(logs.length, 3)
  assert.equal(ROSTER_POLL_MS, 5 * 60_000, '跟現有 5 分鐘的節奏一致')
})

test('讀列表：讀成功過一次，之後讀失敗（錯誤、forbidden、格式不對）都沿用上一次的；從沒成功過才回 null', async () => {
  const log = () => {}
  const prev = roster([entry()])
  for (const fail of [async () => { throw 'acct_roster HTTP 500 internal' }, async () => ({ error: 'forbidden' }), async () => ({ accounts: 'x' })]) {
    assert.equal(await fetchRoster(fail, log, prev), prev)
    assert.equal(await fetchRoster(fail, log, null), null)
    assert.equal(await fetchRoster(fail, log, { error: 'forbidden' }), null, '上一次本來就不能用的不算')
  }
  const next = roster([])
  assert.equal(await fetchRoster(async () => next, log, prev), next, '讀成功就換新的')
})

// ---------- 設備卡：有列表用列表、沒有退回舊顯示 ----------
const friends = [{ node: S, device: '家用機', engine: 'claude', kind: 'pc', status: 'online', id: `${S}/c` }, { node: W, device: '工作機', engine: 'claude', kind: 'pc', status: 'online', id: `${W}/c` }]
const reports = { [W]: { error: '', asnOnline: true, reportedAt: iso(NOW - H), accounts: [
  { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 99, weekly_pct: 99, at: iso(NOW - 5 * H) },
  { vendor: 'claude', email: 'z@x.test', plan: 'pro', current: false, five_hour_pct: 10, at: iso(NOW - H) },
  { vendor: 'codex', email: 'a@x.test', plan: 'plus', current: true },
] } }
const self = { claude: [{ email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 11, weekly_pct: 22, at: iso(NOW - 60_000) }] }

test('設備卡：別台設備的帳號額度改看列表（廠牌＋帳號對），列表裡沒有的退回那台回報的', () => {
  const t = buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, asn: { [W]: [{}] }, reports, self, now: NOW,
    roster: roster([entry(), entry({ vendor: 'codex', windows: [] })]) })
  const w = t.find(d => d.key === W)
  const claude = w.vendors.find(v => v.key === 'claude').accounts
  assert.equal(claude.find(a => a.email === 'a@x.test').quota.text, '5 小時剩 40%、每週剩 72%', '用列表，不用那台回報的 99%')
  assert.equal(claude.find(a => a.email === 'a@x.test').quota.meta, '3 小時前・工作機')
  assert.equal(claude.find(a => a.email === 'z@x.test').quota.text, '5 小時剩 10%', '列表沒有的退回那台回報的')
  assert.equal(w.vendors.find(v => v.key === 'codex').accounts[0].quota.text, '開 Codex 後才讀得到')
})

test('設備卡：本機這台照 #1339 用本機紀錄，不看列表', () => {
  const t = buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports, self, now: NOW, roster: roster([entry()]) })
  assert.equal(t.find(d => d.self).vendors.find(v => v.key === 'claude').accounts[0].quota.text, '5 小時剩 11%、每週剩 22%')
})

test('設備卡：後台讀不到（null／壞的）時退回舊顯示，跟沒有列表這個功能時一模一樣', () => {
  const old = buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports, self, now: NOW })
  for (const r of [null, { error: 'forbidden' }, {}]) assert.deepEqual(buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports, self, now: NOW, roster: r }), old)
  assert.equal(old.find(d => d.key === W).vendors.find(v => v.key === 'claude').accounts[0].quota.text, '5 小時剩 99%、每週剩 99%')
})

// ---------- 切換選單 ----------
const remote = { loading: false, busy: false, asnOnline: true, reportedAt: iso(NOW - H), msg: '', list: [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }, { vendor: 'claude', email: 'z@x.test', plan: '', current: false }] }

test('電腦切換對話框：每個帳號帶列表的額度；列表沒有就不寫額度', () => {
  const r = roster([entry()])
  const v = dialogView(remote, 'z@x.test', NOW, { quotaOf: e => rosterQuotaFor(r, 'claude', e, { nodeLabel, now: NOW }) })
  assert.equal(v.rows[0].quotaText, '5 小時剩 40%、每週剩 72%')
  assert.equal(v.rows[0].quotaMeta, '3 小時前・工作機')
  assert.equal(v.rows[1].quotaText, '')
  assert.equal(dialogView(remote, '', NOW).rows[0].quotaText, '', '沒給列表＝舊顯示')
})

test('手機切換選單（acctSheetView）用同一份列表；沒有列表照舊', () => {
  const r = roster([entry()])
  const v = acctSheetView(remote, 'z@x.test', NOW, { roster: r, friends, selfNode: 'phone' })
  assert.equal(v.rows[0].quotaText, '5 小時剩 40%、每週剩 72%')
  assert.equal(v.rows[0].quotaMeta, '3 小時前・工作機')
  assert.equal(v.pickEmail, 'z@x.test')
  const plain = acctSheetView(remote, 'z@x.test', NOW)
  assert.equal(plain.rows[0].quotaText, '')
  assert.equal(plain.canPick, v.canPick)
})

test('手機設備卡與「我的帳號」：跟電腦版同一套轉換', () => {
  const r = roster([entry()])
  const rep = { [W]: { loading: false, asnOnline: true, reportedAt: iso(NOW - H), msg: '', list: reports[W].accounts } }
  const t = acctDeviceTree({ friends, nodeOrder: [S, W], selfNode: 'phone', reports: rep, roster: r, now: NOW })
  assert.equal(t.find(d => d.key === W).vendors.find(v => v.key === 'claude').accounts.find(a => a.email === 'a@x.test').quota.text, '5 小時剩 40%、每週剩 72%')
  assert.deepEqual(acctRosterView(r, { friends, selfNode: 'phone', now: NOW }), rosterView(r, { nodeLabel: nodeLabelOf(friends), now: NOW }))
  assert.equal(acctRosterView(null), null)
})

// ---------- 畫面 ----------
const ACCT = { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', allowSwitch: true, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }
const render = async st => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'devices', meAv: '' }) }))
}

test('電腦設定頁：設備列表最上面有「我的帳號」，按廠牌列出帳號與額度；沒有列表就不出現', async () => {
  const my = rosterView(roster([entry(), entry({ vendor: 'codex', windows: [] })]), { nodeLabel, now: NOW })
  const html = await render({ devices: [], accounts: ACCT, myAccounts: my })
  assert.match(html, /<section class="dv-my"[^>]*aria-label="我的帳號"/)
  assert.ok(html.includes('data-vendor="claude"') && html.includes('data-vendor="codex"'))
  assert.ok(html.includes('5 小時剩 40%') && html.includes('每週剩 72%') && html.includes('3 小時前・工作機'))
  assert.ok(html.includes('開 Codex 後才讀得到'))
  assert.ok(html.includes('使用中'))
  const none = await render({ devices: [], accounts: ACCT, myAccounts: null })
  assert.ok(!none.includes('dv-my'))
})

test('電腦設定頁：「我的帳號」在設備列表之前', async () => {
  const my = rosterView(roster([entry()]), { nodeLabel, now: NOW })
  const devices = [{ key: W, label: '工作機', self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [] }]
  const html = await render({ devices, accounts: ACCT, myAccounts: my })
  assert.ok(html.indexOf('class="dv-my"') >= 0 && html.indexOf('class="dv-my"') < html.indexOf('class="dv-list"'))
})

// ---------- 讀取時機與接線 ----------
test('電腦：accounts 讀列表用 acct_roster，讀不到是 null 不報錯', async () => {
  const calls = []
  const invoke = async cmd => { calls.push(cmd); if (cmd === 'acct_roster') throw 'acct_roster HTTP 404 not_found'; return null }
  const ui = createAccountsUi({ invoke, reactive: x => x })
  const orig = console.info; console.info = () => {}
  try { await ui.refreshRoster() } finally { console.info = orig }
  assert.deepEqual(calls, ['acct_roster'])
  assert.equal(ui.state.roster, null)
  const ok = createAccountsUi({ invoke: async () => roster([entry()]), reactive: x => x })
  await ok.refreshRoster()
  assert.equal(ok.state.roster.accounts.length, 1)
})

test('電腦：先讀成功一次、再讀失敗 → 設備卡與「我的帳號」仍是上一次的列表；從沒成功 → 退回那台回報的數字', async () => {
  let fail = false
  const invoke = async cmd => { if (cmd !== 'acct_roster') return null; if (fail) throw 'acct_roster HTTP 403 forbidden'; return roster([entry()]) }
  const ui = createAccountsUi({ invoke, reactive: x => x })
  const orig = console.info; console.info = () => {}
  try {
    await ui.refreshRoster()
    fail = true
    await ui.refreshRoster()
  } finally { console.info = orig }
  const tree = r => buildDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports, self, now: NOW, roster: r })
  const quotaOfA = t => t.find(d => d.key === W).vendors.find(v => v.key === 'claude').accounts.find(a => a.email === 'a@x.test').quota.text
  assert.equal(quotaOfA(tree(ui.state.roster)), '5 小時剩 40%、每週剩 72%', '仍是上一次列表的數字')
  assert.equal(rosterView(ui.state.roster, { nodeLabel, now: NOW }).vendors[0].accounts[0].quota.meta, '3 小時前・工作機')
  // 從沒成功過
  const never = createAccountsUi({ invoke: async () => { throw 'acct_roster HTTP 404 not_found' }, reactive: x => x })
  console.info = () => {}
  try { await never.refreshRoster(); await never.refreshRoster() } finally { console.info = orig }
  assert.equal(never.state.roster, null)
  assert.equal(quotaOfA(tree(never.state.roster)), '5 小時剩 99%、每週剩 99%', '退回那台自己回報的')
})

test('接線：電腦打開「設備與帳號」讀一次、開著時跟 5 分鐘排程一起讀；手機用 android_acct_roster、進頁讀一次', () => {
  const list = read('ui/list.js'), m = read('ui/m.js'), html = read('ui/m.html'), lhtml = read('ui/list.html')
  assert.match(list, /normalizeCatKey\(k\) === 'devices'\) void accounts\.refreshRoster\(\)/)
  assert.match(list, /5 \* 60_000\)/)
  assert.match(list, /if \(devicesOpen\(\)\) void accounts\.refreshRoster\(\)/)
  assert.match(list, /roster: accounts\.state\.roster/)
  assert.match(list, /myAccounts: myAccounts\.value/)
  assert.match(lhtml, /a\.quotaText/)
  assert.match(m, /acctRoster: \(\) => invoke\('android_acct_roster'\)/)
  assert.match(m, /void loadRoster\(\)/)
  assert.match(m, /fetchRoster\(acctTransport\.acctRoster, undefined, acctRoster\.value\)/, '手機讀不到也沿用上一次讀成功的')
  assert.match(read('ui/lib/claude-accounts.mjs'), /fetchRoster\(\(\) => invoke\('acct_roster'\), undefined, s\.roster\)/)
  assert.match(m, /ROSTER_POLL_MS\)/)
  assert.match(m, /roster: acctRoster\.value/)
  assert.match(html, /class="m-dv-my"/)
  const polls = list.split('\n').filter(l => l.includes('setInterval') && l.includes('refreshRoster'))
  assert.equal(polls.length, 1, '不另開輪詢')
  assert.ok(polls[0].includes('5 * 60_000'), '只跟現有 5 分鐘那支一起讀')
})

test('冒煙情境：有列表時「我的帳號」出現；後台沒部署（指令被拒）時頁面照常', () => {
  const ok = SCENARIOS.find(s => s.name === 'list-roster'), miss = SCENARIOS.find(s => s.name === 'list-roster-missing')
  assert.ok(ok && miss)
  assert.match(ok.ready, /\.dv-my/)
  assert.deepEqual(tableFor(ok).acct_roster, ROSTER_SAMPLE)
  assert.equal('acct_roster' in tableFor(miss), false)
  assert.equal(JSON.parse(tableFor(ok).store_load.values.me).session.panel.setting, 'devices')
})
