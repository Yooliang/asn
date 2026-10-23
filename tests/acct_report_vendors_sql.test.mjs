// 帳號回報可帶多個廠商（20261023160000_acct_report_vendors.sql）：
// 1. 靜態：只重寫兩支 asn_relay_ 函式、只授權 service_role、不新增舊名函式、整份沒有權杖類字樣。
// 2. 實跑（有安裝 @electric-sql/pglite 時）：先套原本的帳號切換 migration（函式名換成 asn_relay_），
//    證明舊版只收 claude（重現）；套新版後 claude／codex 都收、其他廠商與多餘欄位被擋或丟掉；
//    切換不能拿 codex 帳號當目標；舊式只含 claude 的回報照舊能用。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('20261023160000_acct_report_vendors.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'

test('靜態：只重寫兩支 asn_relay_ 函式，只授權 service_role，沒有權杖類字樣', () => {
  assert.deepEqual([...mig.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]), ['asn_relay_acct_report', 'asn_relay_acct_switch'])
  assert.doesNotMatch(mig, /irori_relay_|grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  assert.equal((mig.match(/security definer\n set search_path to ''/g) ?? []).length, 2)
  assert.match(mig, /grant execute on function public\.asn_relay_acct_report\(text, jsonb\) to service_role;/)
  assert.match(mig, /grant execute on function public\.asn_relay_acct_switch\(text, text, text, text\) to service_role;/)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

test('靜態：編號排在改名 migration 之後，且舊定義是這支的基礎（只認 claude）', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf('20261023160000_acct_report_vendors.sql') > files.indexOf('20261023040000_asn_relay_rename.sql'), '要排在改名 migration 之後')
  assert.match(base, /v_row->>'vendor' is distinct from 'claude'/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T = 'aaaaaaaa-0000-0000-0000-000000000001'
async function setup(m) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', bell_topic text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    insert into relay.tenants values ('${T}');
    insert into relay.nodes(id, tenant_id, role, bell_topic) values ('H', '${T}', 'owner', 'bell-H'), ('W', '${T}', 'member', 'bell-W');
    insert into relay.asn_presence(node) values ('W');`)
  await db.exec(base)
  if (m) await db.exec(m)
  return db
}
const rep = async (db, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', ['W', JSON.stringify(rows)])).rows[0].r
const saved = async db => (await db.query(`select accounts from relay.asn_accounts where node = 'W'`)).rows[0]?.accounts
const C = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }
const X = { vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true }

test('實跑（pglite）：重現——舊版收到 codex 整份退回；新版收下且只留四欄', { skip }, async () => {
  const old = await setup()
  assert.deepEqual(await rep(old, [C, X]), { error: 'bad_request' })
  const db = await setup(mig)
  assert.deepEqual(await rep(db, [C, { ...X, id_token: 'SECRET', accessToken: 'SECRET' }]), { ok: true, count: 2 })
  const rows = await saved(db)
  assert.deepEqual(rows, [C, X])
  assert.ok(!JSON.stringify(rows).includes('SECRET'))
})

test('實跑（pglite）：其他廠商、壞 email、超過 20 筆仍被擋；舊式只含 claude 的回報照舊', { skip }, async () => {
  const db = await setup(mig)
  for (const bad of [[{ ...X, vendor: 'gemini' }], [{ ...X, vendor: null }], [{ ...X, email: 'bad' }], [{ ...X, current: 'yes' }], Array.from({ length: 21 }, () => C)]) {
    assert.deepEqual(await rep(db, bad), { error: 'bad_request' }, JSON.stringify(bad).slice(0, 60))
  }
  assert.equal(await saved(db), undefined)
  assert.deepEqual(await rep(db, [C]), { ok: true, count: 1 })
  assert.deepEqual(await saved(db), [C])
})

test('實跑（pglite）：切換只認 claude 帳號，不能拿 codex 帳號當目標', { skip }, async () => {
  const db = await setup(mig)
  await rep(db, [C, X])
  const sw = async email => (await db.query(`select public.asn_relay_acct_switch('H', 'W', 'claude', $1) r`, [email])).rows[0].r
  assert.deepEqual(await sw('c@x.test'), { error: 'unknown_account' })
  assert.ok((await sw('a@x.test')).id)
})
