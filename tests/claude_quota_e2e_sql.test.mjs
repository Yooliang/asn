// 額度端到端的後台段（#1883）：Rust 測試用假憑證＋假查詢回應產生的回報（tests/fixtures/claude-quota-report.golden.json）
// → 照 Edge Function 的做法送後台（舊表 asn_relay_acct_report 不帶 windows，再寫 asn_relay_acct_roster_report）
// → 讀 asn_relay_acct_roster → 斷言帳號頁與設備頁用的那份資料：窗數字、讀取時間、這台使用中。
// 黃金檔缺了就讓測試紅（直接讀檔，不先判斷存在與否）。畫面那一段由前端測試讀同一份檔（relay/asn/test）。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/claude-quota-report.golden.json', import.meta.url), 'utf8'))
const MIGS = ['20261029100000_acct_roster.sql', '20261029110000_acct_roster_lock_lower.sql', '20261029130000_acct_roster_gemini.sql', '20261030100000_acct_reset_times.sql', '20261031100000_acct_login_flags.sql', '20261110100000_acct_quota_share.sql', '20261111200000_acct_quota_week_confirm.sql', '20261113000000_acct_quota_rules_simplify.sql', '20261113100000_acct_quota_drop_missing_expired.sql', '20261120120000_acct_quota_latest_per_window.sql'].map(read)
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'

async function setup() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', owner_user uuid, bell_topic text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('H', '${T1}', 'owner', '${U1}', 'bell-H');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  for (const m of MIGS) await db.exec(m)
  return db
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0].r
// Edge Function 的 acct_report：舊表不帶 windows，再寫帳號列表
async function sendLikeEdge(db, node, body) {
  const legacy = body.accounts.map(({ windows: _w, ...rest }) => rest)
  await one(db, 'select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(legacy)])
  return one(db, 'select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(body.accounts)])
}

test('端到端（後台段）：黃金回報 → 後台 → roster，窗數字與讀取時間一致、這台使用中', { skip }, async () => {
  const db = await setup()
  const r = await sendLikeEdge(db, 'W', golden)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.skipped, [])
  const roster = await one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', ['H', U1])
  for (const want of golden.accounts) {
    const got = roster.accounts.find(a => a.vendor === want.vendor && a.account === want.email)
    assert.ok(got, `roster 裡要有 ${want.email}`)
    assert.equal(got.windows.length, want.windows.length)
    for (const w of want.windows) {
      const g = got.windows.find(x => x.name === w.name)
      assert.deepEqual([g.left_pct, g.resets_at, g.read_at], [w.left_pct, w.resets_at, w.read_at], w.name)
    }
    assert.ok(got.nodes.some(n => n.node === 'W' && n.current === true), '這台（W）是使用中')
  }
})

test('端到端（後台段）：同一份回報再送一次、另一台較舊的回報，都不會蓋掉黃金讀數', { skip }, async () => {
  const db = await setup()
  await sendLikeEdge(db, 'W', golden)
  const older = structuredClone(golden)
  for (const a of older.accounts) for (const w of a.windows) { w.left_pct = 1; w.read_at = '2026-10-24T11:00:00Z' }
  const r = await sendLikeEdge(db, 'H', older)
  assert.deepEqual(r.skipped.map(x => x.reason).sort(), golden.accounts[0].windows.map(() => 'older_read'))
  const roster = await one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', ['H', U1])
  const got = roster.accounts.find(a => a.account === golden.accounts[0].email)
  assert.deepEqual(got.windows.map(w => w.left_pct).sort(), golden.accounts[0].windows.map(w => w.left_pct).sort())
})

// 畫面段：同一條路接著走到「帳號頁」用的 rosterView（設備頁用的 rosterQuota 是同一個函式）
import { rosterView, QUOTA_LINES_FOR_TEST } from './_claude_quota_ui.mjs'

test('端到端（整條）：黃金回報 → 後台 → roster → 帳號頁文字；沒有任何設備在用時加灰字', { skip }, async () => {
  const db = await setup()
  const NOW = Date.parse('2026-10-24T12:05:00Z')
  await sendLikeEdge(db, 'W', golden)
  const roster = await one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', ['H', U1])
  const view = rosterView(roster, { nodeLabel: n => (n === 'W' ? '工作機' : n), now: NOW })
  const row = view.vendors.find(v => v.key === 'claude').accounts.find(a => a.account === 'a@x.test')
  assert.equal(row.current, true)
  assert.equal(row.quota.known, true)
  assert.equal(row.quota.text, '5 小時剩 62%、每週剩 80%')
  assert.match(row.quota.meta, /工作機/)
  assert.equal(row.quota.idleText, '', '有設備在用，不加灰字')
  // 那台改回報別的帳號：這個帳號沒有任何設備在用，照樣顯示最後讀數與時間，加「目前沒有設備在用」
  const other = structuredClone(golden)
  other.accounts[0].current = false
  await sendLikeEdge(db, 'W', other)
  const roster2 = await one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', ['H', U1])
  const idle = rosterView(roster2, { nodeLabel: n => n, now: NOW }).vendors.find(v => v.key === 'claude').accounts[0]
  assert.equal(idle.quota.text, '5 小時剩 62%、每週剩 80%')
  assert.equal(idle.quota.idleText, QUOTA_LINES_FOR_TEST.idle)
})

// ---------- 舊版用戶端相容（四欄轉 windows，只保留一版）與新版整份取代 ----------
const NOW_UI = Date.parse('2026-10-24T12:05:00Z')
const legacyRow = extra => ({ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, ...extra })
const claudeRow = async db => (await one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', ['H', U1])).accounts.find(a => a.account === 'a@x.test')
const viewOf = async db => rosterView(await one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', ['H', U1]), { nodeLabel: n => n, now: NOW_UI }).vendors.find(v => v.key === 'claude').accounts[0]

test('相容：舊版只送四欄（沒有 windows）——後台當場轉成 windows，roster 與畫面文字都看得到', { skip }, async () => {
  const db = await setup()
  await sendLikeEdge(db, 'W', { accounts: [legacyRow({ five_hour_pct: 40, weekly_pct: 70, reset_at: '2026-10-24T14:00:00Z', at: '2026-10-24T12:00:00Z' })] })
  const a = await claudeRow(db)
  assert.deepEqual(a.windows.map(w => [w.name, w.left_pct, w.read_at]).sort(), [['five_hour', 40, '2026-10-24T12:00:00Z'], ['weekly', 70, '2026-10-24T12:00:00Z']])
  assert.equal(a.windows.find(w => w.name === 'five_hour').resets_at, '2026-10-24T14:00:00Z')
  const v = await viewOf(db)
  assert.equal(v.quota.known, true)
  assert.equal(v.quota.text, '5 小時剩 40%、每週剩 70%')
})

test('相容：舊版同時送 windows 與四欄——以 windows 為準', { skip }, async () => {
  const db = await setup()
  const w = [{ name: 'five_hour', left_pct: 62, resets_at: '2026-10-24T14:00:00Z', read_at: '2026-10-24T12:00:00Z' }, { name: 'weekly', left_pct: 80, resets_at: '2026-10-28T07:00:00Z', read_at: '2026-10-24T12:00:00Z' }]
  await sendLikeEdge(db, 'W', { accounts: [legacyRow({ windows: w, five_hour_pct: 11, weekly_pct: 22, reset_at: '2026-10-24T14:00:00Z', at: '2026-10-24T12:00:00Z' })] })
  assert.deepEqual((await claudeRow(db)).windows.map(x => x.left_pct).sort(), [62, 80])
  assert.equal((await viewOf(db)).quota.text, '5 小時剩 62%、每週剩 80%')
})

test('新版整份取代：方案拿掉 5 小時限制後（先送兩窗、再只送 weekly），roster 與畫面不再有 5 小時', { skip }, async () => {
  const db = await setup()
  await sendLikeEdge(db, 'W', golden)
  const next = structuredClone(golden)
  next.accounts[0].windows = next.accounts[0].windows.filter(w => w.name === 'weekly').map(w => ({ ...w, left_pct: 75, read_at: '2026-10-24T12:30:00Z' }))
  await sendLikeEdge(db, 'W', next)
  const a = await claudeRow(db)
  assert.deepEqual(a.windows.map(w => w.name), ['weekly'])
  const v = await viewOf(db)
  assert.doesNotMatch(v.quota.text, /5 小時/)
  assert.match(v.quota.text, /75%/)
})

test('新版整份取代：這次有帶、但讀取時間較舊的窗不被蓋；windows 是空的（讀不到）不算「都沒有了」', { skip }, async () => {
  const db = await setup()
  await sendLikeEdge(db, 'W', golden)
  const older = structuredClone(golden)
  older.accounts[0].windows = older.accounts[0].windows.filter(w => w.name === 'weekly').map(w => ({ ...w, left_pct: 1, read_at: '2026-10-24T11:00:00Z' }))
  await sendLikeEdge(db, 'W', older)
  const a = await claudeRow(db)
  assert.deepEqual(a.windows.map(w => [w.name, w.left_pct]).sort(), [['weekly', 80]], '帶的 weekly 較舊不蓋、沒帶的 five_hour 拿掉')
  const db2 = await setup()
  await sendLikeEdge(db2, 'W', golden)
  const none = structuredClone(golden)
  none.accounts[0].windows = []
  await sendLikeEdge(db2, 'W', none)
  assert.equal((await claudeRow(db2)).windows.length, 2)
})

test('舊版讀數只更新有帶的窗、不會把別的窗刪掉', { skip }, async () => {
  const db = await setup()
  await sendLikeEdge(db, 'W', golden)
  await sendLikeEdge(db, 'H', { accounts: [legacyRow({ weekly_pct: 55, reset_at: '2026-10-28T07:00:00Z', at: '2026-10-24T12:20:00Z' })] })
  const a = await claudeRow(db)
  assert.deepEqual(a.windows.map(w => [w.name, w.left_pct]).sort(), [['five_hour', 62], ['weekly', 55]])
  assert.equal((await viewOf(db)).quota.text, '5 小時剩 62%、每週剩 55%')
})

closeAtEnd()
