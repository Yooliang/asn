// 帳號回報帶剩餘額度（#228，20261024200000_acct_report_quota.sql）：
// 1. 靜態：編號比 20261024190000 大、只動 asn_relay_acct_report 與新工具函式、只授權 service_role、沒有權杖類字樣。
// 2. 實跑（有安裝 @electric-sql/pglite 時；pglite 測試不要加 --test-force-exit）：
//    重現——舊版把額度欄位丟掉；新版保留合格欄位、壞欄位單獨丟掉、codex 不收額度、舊式回報照舊。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('20261024200000_acct_report_quota.sql')
const vendors = read('20261023160000_acct_report_vendors.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'

test('靜態：編號排在最新 migration 之後，只動報告函式與額度工具，只授權 service_role', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok('20261024200000_acct_report_quota.sql' > '20261024190000_group_read_receipts.sql')
  assert.equal(files.filter(f => f > '20261024200000_acct_report_quota.sql' && f.includes('acct_report')).length, 0)
  assert.deepEqual([...mig.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]), ['asn_relay_acct_quota', 'asn_relay_acct_report'])
  assert.doesNotMatch(mig, /irori_relay_|grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  assert.match(mig, /grant execute on function public\.asn_relay_acct_report\(text, jsonb\) to service_role;/)
  assert.match(mig, /grant execute on function public\.asn_relay_acct_quota\(jsonb\) to service_role;/)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

test('靜態：額度只對 claude 那幾列呼叫，且報告函式其餘驗證與上一版相同', () => {
  assert.match(mig, /case when v_row->>'vendor' = 'claude' then public\.asn_relay_acct_quota\(v_row\)/)
  for (const must of ["v_row->>'vendor' not in ('claude', 'codex')", 'asn_relay_acct_email_ok(v_row->>\'email\')', "char_length(v_row->>'plan') > 30", 'jsonb_array_length(p_accounts) > 20']) {
    assert.ok(vendors.includes(must) && mig.includes(must), `缺少原本的檢查：${must}`)
  }
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T = 'aaaaaaaa-0000-0000-0000-000000000001'
async function setup(withQuota) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', bell_topic text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    insert into relay.tenants values ('${T}');
    insert into relay.nodes(id, tenant_id, role, bell_topic) values ('H', '${T}', 'owner', 'bell-H'), ('W', '${T}', 'member', 'bell-W');
    insert into relay.asn_presence(node) values ('W');`)
  await db.exec(base)
  await db.exec(vendors)
  if (withQuota) await db.exec(mig)
  return db
}
const rep = async (db, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', ['W', JSON.stringify(rows)])).rows[0].r
const saved = async db => (await db.query(`select accounts from relay.asn_accounts where node = 'W'`)).rows[0]?.accounts
const AT = new Date(Date.now() - 5 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
const C = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }

test('實跑（pglite）：重現——舊版丟掉額度；新版保留合格欄位並轉成整數與 UTC 時間', { skip }, async () => {
  const q = { ...C, five_hour_pct: 61.6, weekly_pct: 80, reset_at: '2026-10-24T23:00:00+08:00', at: AT }
  const old = await setup(false)
  await rep(old, [q])
  assert.deepEqual(await saved(old), [C], '舊版不認得額度（重現）')
  const db = await setup(true)
  assert.deepEqual(await rep(db, [q]), { ok: true, count: 1 })
  assert.deepEqual(await saved(db), [{ ...C, five_hour_pct: 62, weekly_pct: 80, reset_at: '2026-10-24T15:00:00Z', at: AT }])
})

test('實跑（pglite）：壞欄位單獨丟掉、沒有 at 或沒有百分比就整組不收、codex 不收額度、權杖類欄位不入庫', { skip }, async () => {
  const db = await setup(true)
  for (const [bad, want] of [
    [{ five_hour_pct: 101, at: AT }, C], [{ five_hour_pct: -1, at: AT }, C], [{ five_hour_pct: '50', at: AT }, C],
    [{ five_hour_pct: 50 }, C], [{ five_hour_pct: 50, at: '壞掉' }, C], [{ weekly_pct: 50, at: '2099-01-01T00:00:00Z' }, C],
    [{ five_hour_pct: 30, weekly_pct: 500, reset_at: '壞掉', at: AT }, { ...C, five_hour_pct: 30, at: AT }],
  ]) {
    assert.deepEqual(await rep(db, [{ ...C, ...bad }]), { ok: true, count: 1 }, JSON.stringify(bad))
    assert.deepEqual(await saved(db), [want], JSON.stringify(bad))
  }
  const X = { vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true }
  await rep(db, [{ ...X, five_hour_pct: 5, at: AT }, { ...C, five_hour_pct: 9, at: AT, accessToken: 'SECRET', refresh_token: 'SECRET' }])
  const rows = await saved(db)
  assert.deepEqual(rows[0], X)
  assert.deepEqual(rows[1], { ...C, five_hour_pct: 9, at: AT })
  assert.ok(!JSON.stringify(rows).includes('SECRET'))
})

test('實跑（pglite）：舊式回報（不帶額度）、壞 email、超過 20 筆行為不變', { skip }, async () => {
  const db = await setup(true)
  assert.deepEqual(await rep(db, [C]), { ok: true, count: 1 })
  assert.deepEqual(await saved(db), [C])
  for (const bad of [[{ ...C, email: 'bad' }], [{ ...C, vendor: 'gemini' }], Array.from({ length: 21 }, () => C)]) {
    assert.deepEqual(await rep(db, bad), { error: 'bad_request' })
  }
})
