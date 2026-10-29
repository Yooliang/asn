// 帳號列表寫入加鎖改依小寫 email 排序（20261029110000_acct_roster_lock_lower.sql，#524 審查小建議，asn真 #1440）：
// 1. 靜態：編號在 20261029100000 之後；只 create or replace asn_relay_acct_roster_report；權限只給 service_role；回復檔對應。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    函式本體跟 20261029100000 版只差排序那一處（pg_get_functiondef 比對）；回復後跟 20261029100000 版逐字相同；權限不變；
//    大小寫混合的 email 兩種順序送進來結果相同（目前整份 bad_request、什麼都不寫）；全小寫兩種順序結果相同。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261029110000_acct_roster_lock_lower.sql'
const BASE_FILE = '20261029100000_acct_roster.sql'
const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read(FILE)
const roster = read(BASE_FILE)
const down = fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const FN = 'asn_relay_acct_roster_report(text, jsonb)'
const OLD_ORDER = "order by e->>'vendor', e->>'email', i loop"
const NEW_ORDER = "order by e->>'vendor', lower(e->>'email'), i loop"
const body = sql => { const s = sql.indexOf('create or replace function public.asn_relay_acct_roster_report('); return sql.slice(s, sql.indexOf('$function$;', s) + 11) }

test('靜態：編號在 20261029100000 之後；只換寫入函式、只改排序一處；只授權 service_role；回復檔換回原版本體', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.includes(FILE) && FILE > BASE_FILE)
  assert.equal((mig.match(/create or replace function/g) ?? []).length, 1)
  assert.doesNotMatch(mig, /create table|alter table|drop |insert into relay\.asn_accounts|create policy/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  for (const f of [mig, down]) {
    assert.ok(f.includes(`revoke all on function public.${FN} from public, anon, authenticated;`))
    assert.ok(f.includes(`grant execute on function public.${FN} to service_role;`))
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  assert.equal(body(mig), body(roster).replace(OLD_ORDER, NEW_ORDER), '新版＝原版只換排序那一處')
  assert.ok(body(mig).includes(NEW_ORDER) && !body(mig).includes(OLD_ORDER))
  assert.equal(body(down), body(roster), '回復檔＝20261029100000 版逐字')
  assert.equal((down.match(/create or replace function/g) ?? []).length, 1)
  assert.doesNotMatch(down.replace(body(down), ''), /drop |delete |truncate /i, '函式本體以外不刪東西')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'

async function setup() {
  const db = new PGlite()
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
  await db.exec(roster)
  return db
}
const fnDef = async db => (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'asn_relay_acct_roster_report'`)).rows.map(r => r.d).join('\n')
const report = async (db, node, rows) => (await db.query('select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const rows = async db => (await db.query('select vendor, account, plan, windows, seen_node from relay.asn_user_accounts order by vendor, account')).rows
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const NOW = Date.now()
const AT = iso(NOW - 5 * 60_000)
const D = 24 * 3600_000
const C = { vendor: 'claude', plan: 'max', current: true }
const win = (name, left_pct, resets_at) => ({ name, left_pct, resets_at, read_at: AT })
const privs = async db => {
  const out = {}
  for (const role of ['anon', 'authenticated', 'service_role']) out[role] = (await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${FN}`])).rows[0].v
  const p = (await db.query(`select prosecdef, proconfig from pg_proc where proname = 'asn_relay_acct_roster_report'`)).rows[0]
  return { ...out, definer: p.prosecdef, config: p.proconfig }
}

test('實跑（pglite）：函式本體只差排序那一處；權限與 definer 不變；回復後跟原版逐字相同；可重跑', { skip }, async () => {
  const db = await setup()
  const before = await fnDef(db)
  const privBefore = await privs(db)
  assert.deepEqual(privBefore, { anon: false, authenticated: false, service_role: true, definer: true, config: privBefore.config })
  assert.ok(before.includes(OLD_ORDER))
  await db.exec(mig)
  const after = await fnDef(db)
  assert.notEqual(after, before)
  assert.equal(after, before.replace(OLD_ORDER, NEW_ORDER), '只差排序那一處')
  assert.deepEqual(await privs(db), privBefore)
  await db.exec(mig)
  assert.equal(await fnDef(db), after, '重跑一樣')
  await db.exec(down)
  assert.equal(await fnDef(db), before, '回復＝原版')
  assert.deepEqual(await privs(db), privBefore)
})

test('實跑（pglite）：大小寫混合的 email 兩種順序結果相同（整份不收、什麼都不寫）；全小寫兩種順序結果相同', { skip }, async () => {
  const runBoth = async accounts => {
    const out = []
    for (const order of [accounts, [...accounts].reverse()]) {
      const db = await setup()
      await db.exec(mig)
      out.push({ r: await report(db, 'W', order), saved: await rows(db) })
    }
    return out
  }
  const A = { ...C, windows: [win('weekly', 20, iso(NOW + 3 * D))] }
  const B = { ...C, windows: [win('weekly', 30, iso(NOW + 3 * D))] }
  // 大寫在原始排序跟小寫排序下先後不同（'B' < 'a'，但 'a' < 'b'）
  const mixed = await runBoth([{ ...A, email: 'a@x.test' }, { ...B, email: 'B@x.test' }])
  assert.deepEqual(mixed[0], mixed[1])
  assert.deepEqual(mixed[0], { r: { error: 'bad_request' }, saved: [] }, 'email 有大寫整份不收')
  const mixedBoth = await runBoth([{ ...A, email: 'A@X.test' }, { ...B, email: 'b@x.TEST' }])
  assert.deepEqual(mixedBoth[0], mixedBoth[1])
  assert.deepEqual(mixedBoth[0].saved, [])
  const lower = await runBoth([{ ...A, email: 'a@x.test' }, { ...B, email: 'b@x.test' }, { vendor: 'codex', email: 'c@x.test', windows: [win('weekly', 40, null)] }])
  assert.deepEqual(lower[0].r, { ok: true, count: 3, skipped: [] })
  assert.deepEqual(lower[0].r, lower[1].r)
  const strip = s => s.map(x => [x.vendor, x.account, x.plan, x.seen_node, x.windows.map(w => [w.name, w.left_pct, w.resets_at])])
  assert.deepEqual(strip(lower[0].saved), strip(lower[1].saved))
  assert.deepEqual(strip(lower[0].saved).map(x => [x[0], x[1], x[4][0][1]]), [['claude', 'a@x.test', 20], ['claude', 'b@x.test', 30], ['codex', 'c@x.test', 40]])
})
