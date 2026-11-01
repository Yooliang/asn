// 兩條額度各自的重置時間、Gemini 的「使用中」（20261030100000_acct_reset_times.sql，#374，0.1.111）：
// 1. 靜態：編號在最新之後；只 create or replace 三支函式（簽章不變、不留第二個多載）；寫入函式只多 gemini 那兩段；只授權 service_role；回復檔換回原版。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    舊簽章、舊欄位照樣能用；兩個新欄位寫得進、讀得出（asn_relay_acct_list）；壞掉的單獨丟掉；
//    gemini 的 nodes 有值、current 照回報；兩台讀過同一個帳號只有在用的那台是 current；這台不再回報就拿掉；
//    claude 的 nodes 照舊從舊表；權限不變；可重跑；回復後函式跟原版逐字相同、欄位拿掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261030100000_acct_reset_times.sql'
const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read(FILE)
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const gem = read('20261029130000_acct_roster_gemini.sql')
const quota0 = read('20261024200000_acct_report_quota.sql')
const down = fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const FNS = {
  asn_relay_acct_quota: 'asn_relay_acct_quota(jsonb)',
  asn_relay_acct_roster_report: 'asn_relay_acct_roster_report(text, jsonb)',
  asn_relay_acct_roster: 'asn_relay_acct_roster(text, uuid)',
}
const body = (sql, name) => { const s = sql.indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', s) + 11) }

test('靜態：編號在最新之後；三支函式簽章不變；寫入只多 gemini 兩段；只授權 service_role；回復檔換回原版', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.at(-1) >= FILE, "編號在最新之後（之後可有更新的）")
  assert.equal((mig.match(/create or replace function/g) ?? []).length, 3)
  // 簽章跟原版一樣（不會變成新多載）
  for (const [name, src] of [['asn_relay_acct_quota', quota0], ['asn_relay_acct_roster_report', gem], ['asn_relay_acct_roster', roster]]) {
    assert.equal(body(mig, name).split('\n')[0], body(src, name).split('\n')[0], name)
  }
  assert.doesNotMatch(mig, /drop function|create table|drop table|create policy|(insert into|update|delete from) relay\.asn_accounts\b/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  for (const f of [mig, down]) {
    for (const sig of Object.values(FNS)) {
      assert.ok(f.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig)
      assert.ok(f.includes(`grant execute on function public.${sig} to service_role;`), sig)
    }
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  // 寫入：跟 20261029130000 版只差 gemini 的宣告、每筆一段、迴圈後一段
  const rr = body(mig, 'asn_relay_acct_roster_report')
  const s1 = rr.indexOf('    -- Gemini 哪台在用'), e1 = rr.indexOf('    v_count := v_count + 1;')
  const s2 = rr.indexOf('  -- 這次回報沒有的 gemini 帳號'), e2 = rr.indexOf('  delete from relay.asn_user_accounts d')
  assert.ok(s1 > 0 && e1 > s1 && s2 > e1 && e2 > s2)
  const stripped = (rr.slice(0, s1) + rr.slice(e1, s2) + rr.slice(e2)).replace("  v_gemini text[] := '{}';\n", '')
  assert.equal(stripped, body(gem, 'asn_relay_acct_roster_report'))
  // 回復檔：三支換回原版逐字；拿掉欄位；不刪資料列
  assert.equal(body(down, 'asn_relay_acct_quota'), body(quota0, 'asn_relay_acct_quota'))
  assert.equal(body(down, 'asn_relay_acct_roster_report'), body(gem, 'asn_relay_acct_roster_report'))
  assert.equal(body(down, 'asn_relay_acct_roster'), body(roster, 'asn_relay_acct_roster'))
  assert.match(down, /alter table relay\.asn_user_accounts drop column if exists nodes;/)
  assert.doesNotMatch(down.replace(body(down, 'asn_relay_acct_roster_report'), ''), /delete from relay|drop table|drop function|truncate /i, '函式本體以外不刪資料')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'

async function setup({ apply = true } = {}) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', owner_user uuid, bell_topic text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('H', '${T1}', 'owner', '${U1}', 'bell-H'), ('Q', '${T1}', 'member', '${U1}', 'bell-Q');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  await db.exec(roster)
  await db.exec(lock)
  await db.exec(gem)
  if (apply) await db.exec(mig)
  return db
}
const fnDef = async (db, name) => (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).rows.map(r => r.d).join('\n')
const overloads = async (db, name) => (await db.query(`select count(*)::int c from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).rows[0].c
const report = async (db, node, rows) => (await db.query('select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const oldReport = async (db, node, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const list = async (db, actor, node) => (await db.query('select public.asn_relay_acct_list($1, $2) r', [actor, node])).rows[0].r
const roster_ = async (db, actor, user) => (await db.query('select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])).rows[0].r
const quota = async (db, row) => (await db.query('select public.asn_relay_acct_quota($1::jsonb) r', [JSON.stringify(row)])).rows[0].r
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const NOW = Date.now()
const H = 3600_000, D = 24 * H
const win = (name, left_pct, resets_at, read_at) => ({ name, left_pct, resets_at, read_at })
const privs = async db => {
  const out = {}
  for (const [name, sig] of Object.entries(FNS)) {
    const p = (await db.query(`select prosecdef, proconfig from pg_proc where proname = $1`, [name])).rows[0]
    out[name] = { definer: p.prosecdef, config: p.proconfig }
    for (const role of ['anon', 'authenticated', 'service_role']) out[name][role] = (await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${sig}`])).rows[0].v
  }
  return out
}

test('實跑（pglite）：舊簽章舊欄位照樣能用；兩條重置時間寫得進、讀得出；壞掉的單獨丟掉', { skip }, async () => {
  const db = await setup()
  for (const n of Object.keys(FNS)) assert.equal(await overloads(db, n), 1, `${n} 只有一個多載`)
  const AT = iso(NOW - 60_000), R5 = iso(NOW + 2 * H), RW = iso(NOW + 3 * D)
  // 舊版電腦：只有四欄
  const old = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 40, weekly_pct: 70, reset_at: R5, at: AT }
  assert.deepEqual(await oldReport(db, 'W', [old]), { ok: true, count: 1 })
  let got = (await list(db, 'H', 'W')).accounts[0]
  assert.deepEqual(got, { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 40, weekly_pct: 70, reset_at: R5, at: AT }, '舊版回報跟以前一模一樣')
  // 新版電腦：多兩欄
  assert.deepEqual(await oldReport(db, 'W', [{ ...old, five_reset_at: R5, week_reset_at: RW }]), { ok: true, count: 1 })
  got = (await list(db, 'H', 'W')).accounts[0]
  assert.equal(got.five_reset_at, R5); assert.equal(got.week_reset_at, RW); assert.equal(got.reset_at, R5, '舊欄位照存')
  // 壞掉的單獨丟掉；沒有那條百分比就不存那條的重置時間
  assert.deepEqual(await quota(db, { five_hour_pct: 10, at: AT, five_reset_at: 'xx', week_reset_at: RW }), { five_hour_pct: 10, at: AT })
  assert.deepEqual(await quota(db, { weekly_pct: 10, at: AT, five_reset_at: R5, week_reset_at: 123 }), { weekly_pct: 10, at: AT })
  assert.deepEqual(await quota(db, { five_hour_pct: 1, at: AT, five_reset_at: '2026-10-30T01:02:03.456+08:00' }), { five_hour_pct: 1, five_reset_at: '2026-10-29T17:02:03Z', at: AT })
  // 新的帳號列表（windows）照舊帶各窗的 resets_at
  await report(db, 'W', [{ ...old, five_reset_at: R5, week_reset_at: RW, windows: [win('five_hour', 40, R5, AT), win('weekly', 70, RW, AT)] }])
  const mine = await roster_(db, 'H', U1)
  assert.deepEqual(mine.accounts[0].windows.map(w => [w.name, w.resets_at]), [['five_hour', R5], ['weekly', RW]])
  assert.deepEqual(mine.accounts[0].nodes.map(n => [n.node, n.current]), [['W', true]], 'claude 的 nodes 照舊從舊表')
})

test('實跑（pglite）：gemini 的 nodes 有值；兩台讀過同一個帳號只有在用的那台是 current；這台不再回報就拿掉', { skip }, async () => {
  const db = await setup()
  const AT = iso(NOW - 60_000)
  const g = (email, current) => ({ vendor: 'gemini', email, plan: 'Google AI Pro', current, windows: [win('five_hour', 50, iso(NOW + H), AT)] })
  await report(db, 'W', [g('g1@x.test', true), g('g2@x.test', false)])
  await report(db, 'Q', [g('g2@x.test', true), g('g1@x.test', false)])
  const view = async () => Object.fromEntries((await roster_(db, 'H', U1)).accounts.filter(a => a.vendor === 'gemini').map(a => [a.account, a.nodes.map(n => [n.node, n.current])]))
  assert.deepEqual(await view(), { 'g1@x.test': [['Q', false], ['W', true]], 'g2@x.test': [['Q', true], ['W', false]] })
  const n0 = (await roster_(db, 'H', U1)).accounts.find(a => a.account === 'g1@x.test').nodes[0]
  assert.match(n0.reported_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  // W 改用 g2、不再回報 g1
  await report(db, 'W', [g('g2@x.test', true)])
  assert.deepEqual(await view(), { 'g1@x.test': [['Q', false]], 'g2@x.test': [['Q', true], ['W', true]] })
  // W 完全沒有 gemini 了（只回報 claude）
  await report(db, 'W', [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }])
  assert.deepEqual(await view(), { 'g1@x.test': [['Q', false]], 'g2@x.test': [['Q', true]] })
  // 節點不是本人的（停用）就不列
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'Q'`)
  assert.deepEqual(await view(), { 'g1@x.test': [], 'g2@x.test': [] })
  // 舊表照樣不收 gemini
  assert.deepEqual(await oldReport(db, 'W', [g('g1@x.test', true)]), { error: 'bad_request' })
})

test('實跑（pglite）：權限、definer、search_path 跟套之前一樣；可重跑；回復後跟原版逐字相同、欄位拿掉', { skip }, async () => {
  const db0 = await setup({ apply: false })
  const before = await privs(db0)
  const defs0 = {}
  for (const n of Object.keys(FNS)) defs0[n] = await fnDef(db0, n)
  const db = await setup()
  assert.deepEqual(await privs(db), before)
  const AT = iso(NOW - 60_000)
  await report(db, 'W', [{ vendor: 'gemini', email: 'g@x.test', plan: '', current: true, windows: [win('weekly', 50, null, AT)] }])
  await db.exec(mig)
  assert.equal((await db.query('select count(*)::int c from relay.asn_user_accounts')).rows[0].c, 1, '重跑不壞、資料還在')
  await db.exec(down)
  for (const n of Object.keys(FNS)) assert.equal(await fnDef(db, n), defs0[n], n)
  assert.deepEqual(await privs(db), before)
  const cols = (await db.query(`select column_name from information_schema.columns where table_schema = 'relay' and table_name = 'asn_user_accounts'`)).rows.map(r => r.column_name)
  assert.ok(!cols.includes('nodes'))
  assert.equal((await db.query('select count(*)::int c from relay.asn_user_accounts')).rows[0].c, 1, '回復不刪資料列')
})
