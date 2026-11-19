// 各 Claude 帳號剩餘額度（#228、#1883）：額度只有一條讀取路徑——ASN 直接查這台目前登入的帳號、送後台、畫面讀後台列表；
// 這台自己目前登入的帳號另外讀本機的查詢狀態（claude_quota_state）。這裡守文字、狀態判定、設備樹與頁面接線。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QUOTA_LINES, QUOTA_NOTE, STALE_MS } from '../ui/lib/account-quota.mjs'
import { ROSTER_TEXT, normalizeQuotaState, rosterView, selfClaudeQuota } from '../ui/lib/account-roster.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree, ACCT_TEXT } from '../ui/lib/mobile-acct.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-24T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const MIN = 60_000, H = 3600_000
// 後台列表一筆（真形狀：asn_relay_acct_roster 回的 accounts[]）
const entry = (o = {}) => ({ vendor: 'claude', account: 'a@x.test', plan: 'claude_max', windows: [
  { name: 'five_hour', left_pct: 40, resets_at: iso(NOW + 2 * H), read_at: iso(NOW - 5 * MIN), read_node: 'W' },
  { name: 'weekly', left_pct: 72, resets_at: iso(NOW + 3 * 24 * H), read_at: iso(NOW - 5 * MIN), read_node: 'W' },
], seen_at: iso(NOW - 5 * MIN), seen_node: 'W', nodes: [{ node: 'W', current: true, reported_at: iso(NOW - 5 * MIN) }], ...o })
const roster = accounts => ({ now: iso(NOW), accounts })
const okState = { email: 'a@x.test', status: 'ok', read_at: iso(NOW - MIN), windows: [
  { name: 'five_hour', left_pct: 62, resets_at: iso(NOW + 2 * H), read_at: iso(NOW - MIN) },
  { name: 'weekly', left_pct: 80, resets_at: iso(NOW + 3 * 24 * H), read_at: iso(NOW - MIN) },
] }

test('#1883 狀態判定：登入過期、查詢太頻繁、暫時查不到各有固定的使用者話，不沿用舊數字、不寫「未知」', () => {
  const want = { login_expired: QUOTA_LINES.loginExpired, rate_limited: QUOTA_LINES.rateLimited, unavailable: QUOTA_LINES.unavailable }
  // 就算後台列表有這個帳號的舊讀數，查詢失敗時也只寫原因
  for (const [status, text] of Object.entries(want)) {
    const q = selfClaudeQuota({ email: 'a@x.test', status, read_at: null, windows: [] }, 'a@x.test', { current: true, roster: roster([entry()]), now: NOW })
    assert.equal(q.text, text, status)
    assert.equal(q.known, false)
    assert.deepEqual(q.bars, [])
    assert.doesNotMatch(q.text, /\d|未知|HTTP|401|429|50\d/, '畫面不放數字、狀態碼')
  }
  assert.ok(QUOTA_LINES.loginExpired.startsWith('登入過期'))
  assert.equal(QUOTA_LINES.rateLimited, '查詢太頻繁，稍後再試')
  assert.equal(QUOTA_LINES.unavailable, '暫時查不到')
  assert.equal(QUOTA_LINES.idle, '目前沒有設備在用')
})

test('#1883 這台目前登入的帳號：查詢成功用本機剛讀到的窗；還沒讀到：有列表就用列表、沒有寫「讀取中」', () => {
  const ok = selfClaudeQuota(okState, 'a@x.test', { current: true, roster: roster([entry()]), now: NOW })
  assert.equal(ok.text, '5 小時剩 62%、每週剩 80%', '本機剛讀到的，不是列表裡的 40%')
  assert.equal(ok.idleText, '', '這台正在用它，不寫沒有設備在用')
  const none = normalizeQuotaState(null)
  assert.equal(none.status, 'none')
  assert.equal(selfClaudeQuota(none, 'a@x.test', { current: true, roster: roster([entry()]), now: NOW }).text, '5 小時剩 40%、每週剩 72%')
  assert.equal(selfClaudeQuota(none, 'a@x.test', { current: true, roster: null, now: NOW }).text, QUOTA_LINES.reading)
  // 帳號庫裡沒在用的帳號：只看列表；沒有就寫「額度讀不到」
  assert.equal(selfClaudeQuota(okState, 'b@x.test', { current: false, roster: roster([entry({ account: 'b@x.test' })]), now: NOW }).text, '5 小時剩 40%、每週剩 72%')
  assert.equal(selfClaudeQuota(okState, 'z@x.test', { current: false, roster: roster([entry()]), now: NOW }).text, QUOTA_LINES.unread)
  // 本機狀態的帳號對不上這個帳號（切換剛完成、還沒重查）：不把別人的數字記給它，當作還沒讀到
  assert.equal(selfClaudeQuota(okState, 'other@x.test', { current: true, roster: null, now: NOW }).text, QUOTA_LINES.unread)
})

test('#1883 normalizeQuotaState：形狀不對、沒有窗的 ok、壞掉的窗一律當 none／丟掉', () => {
  for (const raw of [null, undefined, {}, { status: '亂寫' }, { status: 'ok', windows: [] }, { status: 'ok', windows: 'x' }]) assert.equal(normalizeQuotaState(raw).status, 'none', JSON.stringify(raw))
  const s = normalizeQuotaState({ email: ' A@X.test ', status: 'ok', windows: [{ name: 'weekly', left_pct: 150, read_at: iso(NOW) }, { name: 'weekly', left_pct: 30, read_at: iso(NOW) }] })
  assert.equal(s.email, 'a@x.test')
  assert.equal(s.windows.length, 1, '超出 0～100 的丟掉')
  assert.equal(normalizeQuotaState({ status: 'login_expired', windows: [{ name: 'weekly', left_pct: 30, read_at: iso(NOW) }] }).windows.length, 0, '只有 ok 才帶窗')
})

test('#1883 帳號沒有任何一台在用：照樣顯示最後一次讀數與時間，旁邊寫「目前沒有設備在用」；有設備在用就不寫', () => {
  const idle = entry({ nodes: [{ node: 'W', current: false, reported_at: iso(NOW - H) }] })
  const v = rosterView(roster([idle, entry({ account: 'b@x.test' })]), { now: NOW })
  const [a, b] = v.vendors[0].accounts
  assert.equal(a.quota.text, '5 小時剩 40%、每週剩 72%', '最後一次讀數照樣在')
  assert.match(a.quota.meta, /前/, '時間照樣在')
  assert.equal(a.quota.idleText, '目前沒有設備在用')
  assert.equal(b.quota.idleText, '')
  // 完全沒有節點（後台已很久沒收到）也算沒有設備在用；舊後台沒回 nodes 欄位就不下結論
  assert.equal(rosterView(roster([entry({ nodes: [] })]), { now: NOW }).vendors[0].accounts[0].quota.idleText, '目前沒有設備在用')
  const noNodes = entry(); delete noNodes.nodes
  assert.equal(rosterView(roster([noNodes]), { now: NOW }).vendors[0].accounts[0].quota.idleText, '')
  // 其他廠牌不寫這句
  assert.equal(rosterView(roster([entry({ vendor: 'codex', nodes: [] })]), { now: NOW }).vendors[0].accounts[0].quota.idleText, '')
})

test('#1883 「額度讀不到」只有一個說法：列表沒有數字、別台沒有紀錄、本機沒有指令都是同一個常數', () => {
  assert.equal(ROSTER_TEXT.noQuota, QUOTA_LINES.unread)
  assert.equal(QUOTA_LINES.unread, '額度讀不到')
  for (const f of ['ui/lib/account-quota.mjs', 'ui/lib/account-roster.mjs', 'ui/lib/device-tree.mjs', 'ui/lib/mobile-acct.mjs', 'ui/lib/settings-panel.mjs', 'ui/m.html']) assert.doesNotMatch(read(f), /額度未知/, `${f} 不再有第二種說法`)
})

test('設備樹：別台電腦回報的舊四欄不再用，只看列表', () => {
  const friends = [{ node: 'S', device: '本機', engine: 'claude', kind: 'pc' }, { node: 'W', device: '工作機', engine: 'claude', kind: 'pc', status: 'online' }]
  const reports = { W: { error: '', asnOnline: true, reportedAt: iso(NOW), accounts: [
    { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 62, weekly_pct: 80, at: iso(NOW - 2 * MIN) },
    { vendor: 'claude', email: 'b@x.test', plan: 'pro', current: false },
  ] } }
  const rows = buildDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, roster: roster([entry()]), now: NOW }).find(d => d.key === 'W').vendors.find(v => v.key === 'claude').accounts
  assert.equal(rows[0].quota.text, '5 小時剩 40%、每週剩 72%', '用列表，不用回報的 62%')
  assert.equal(rows[1].quota.known, false)
  assert.equal(rows[1].quota.text, '額度讀不到')
})

test('Codex 帳號不顯示額度（我們沒有它的額度來源，不編）', () => {
  const friends = [{ node: 'S', device: '本機', engine: 'claude', kind: 'pc' }, { node: 'W', device: '工作機', engine: 'gpt', kind: 'pc', status: 'online' }]
  const reports = { W: { error: '', asnOnline: true, reportedAt: iso(NOW), accounts: [{ vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true, five_hour_pct: 99, at: iso(NOW) }] } }
  const w = buildDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, now: NOW }).find(d => d.key === 'W')
  assert.equal(w.vendors.find(v => v.key === 'codex').accounts[0].quota, undefined)
})

test('手機：設備樹照樣讀列表，提示是老實的說明（不再說「看不到額度」）', () => {
  const friends = [{ node: 'S', device: '手機', engine: 'asn', kind: 'phone' }, { node: 'W', device: '工作機', engine: 'claude', kind: 'pc', status: 'online' }]
  const reports = { W: { loading: false, asnOnline: true, reportedAt: iso(NOW), msg: '', list: [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }] } }
  const w = acctDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, roster: roster([entry()]), now: NOW }).find(d => d.key === 'W')
  assert.equal(w.vendors.find(v => v.key === 'claude').accounts[0].quota.text, '5 小時剩 40%、每週剩 72%')
  assert.doesNotMatch(ACCT_TEXT.quotaNote, /看不到/)
  assert.match(ACCT_TEXT.quotaNote, /額度/)
  assert.equal(ACCT_TEXT.quotaNote, QUOTA_NOTE)
  assert.equal(STALE_MS, 6 * 3600_000)
})

test('#1883 手機與電腦同一份文字：額度的說法都從 QUOTA_LINES 引用，頁面不各寫一次', () => {
  const m = read('ui/m.html'), panel = read('ui/lib/settings-panel.mjs')
  for (const t of Object.values(QUOTA_LINES).filter(x => x.length > 4)) {   // 「讀取中」這類通用短詞別處也會用，不算
    assert.ok(!m.includes(t) && !panel.includes(t), `頁面不能自己寫「${t}」`)
  }
  assert.match(m, /a\.quota\.idleText/, '手機畫出「沒有設備在用」')
  assert.match(panel, /a\.quota\.idleText/, '電腦畫出「沒有設備在用」')
  assert.match(read('ui/lib/account-roster.mjs'), /QUOTA_LINES/)
})

test('頁面接線：手機與電腦的帳號列都畫出額度，且有深色模式可讀的樣式', () => {
  const m = read('ui/m.html'), panel = read('ui/lib/settings-panel.mjs')
  assert.match(m, /a\.quota/, '手機頁面要畫 a.quota')
  assert.match(panel, /a\.quota/, '電腦頁面要畫 a.quota')
  const css = read('ui/style.css') + read('ui/mobile.css')
  assert.match(css, /\.dv-quota/); assert.match(css, /\.m-dv-quota/)
  assert.match(css, /\.dv-quota\.stale|\.m-dv-quota\.stale/)
  assert.doesNotMatch(read('ui/lib/account-quota.mjs'), /[A-Za-z]{4,} 剩|remaining/, '給人看的字純中文')
})

test('#1883 不再有狀態列掛鉤與本機額度檔：前端沒有任何地方呼叫 claude_quota_all、quotaHook、claude_quota_hook_*', () => {
  const files = ['ui/list.js', 'ui/onboard.js', 'ui/lib/claude-accounts.mjs', 'ui/lib/tauri.mjs', 'ui/lib/settings-panel.mjs', 'ui/lib/connect-tools.mjs', 'ui/lib/quota-readers.mjs', 'ui/lib/account-quota.mjs', 'ui/lib/account-roster.mjs', 'ui/lib/device-tree.mjs']
  for (const f of files) assert.doesNotMatch(read(f), /claude_quota_all|quotaHook|quota-hook|claude_quota_hook|quotaConnect|hookOn|NOT_CONNECTED|LEGACY_TEXT/, f)
  assert.ok(!fs.existsSync(new URL('../ui/lib/quota-hook.mjs', import.meta.url)), 'quota-hook.mjs 已刪')
  assert.match(read('ui/lib/claude-accounts.mjs'), /claude_quota_state/)
  assert.match(read('ui/lib/tauri.mjs'), /claude_quota_state/)
})
