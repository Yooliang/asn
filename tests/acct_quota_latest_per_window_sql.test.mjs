// 額度後台只取每窗最新讀數（#1883，20261120120000_acct_quota_latest_per_window.sql）：
// 1. 靜態：回復檔把 judge／decide／windows_clean／roster_report 換回上一版（逐字）；新 migration 不動資料表、只授權 service_role、drop 掉不再用的 decide／judge。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：較新的蓋、較舊的不蓋；分窗各自判斷；舊欄位蓋不掉較新的讀數；
//    同帳號多台取最新；窗數上限；重置時間不再丟窗；讀取時間在未來的記成現在；回復後回到舊規則。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261120120000_acct_quota_latest_per_window.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(FILE)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const dropExp = read('20261113100000_acct_quota_drop_missing_expired.sql')
const simplify = read('20261113000000_acct_quota_rules_simplify.sql')
const wk = read('20261111200000_acct_quota_week_confirm.sql')
const share = read('20261110100000_acct_quota_share.sql')
const gem = read('20261029130000_acct_roster_gemini.sql')
const flags = read('20261031100000_acct_login_flags.sql')
const reset = read('20261030100000_acct_reset_times.sql')
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const body = (sql, name) => { const s = sql.indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', s) + 11) }
const SIG = 'asn_relay_acct_roster_report(text, jsonb)'

test('靜態：回復檔換回上一版四支函式；新 migration 只授權 service_role、不動資料表、drop 不再用的 decide／judge', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261113100000_acct_quota_drop_missing_expired.sql'), '編號接在上一版之後')
  assert.equal(body(down, 'asn_relay_acct_window_judge'), body(simplify, 'asn_relay_acct_window_judge'))
  assert.equal(body(down, 'asn_relay_acct_window_decide'), body(simplify, 'asn_relay_acct_window_decide'))
  assert.equal(body(down, 'asn_relay_acct_windows_clean'), body(simplify, 'asn_relay_acct_windows_clean'))
  assert.equal(body(down, 'asn_relay_acct_roster_report'), body(dropExp, 'asn_relay_acct_roster_report'))
  assert.ok(mig.includes('drop function if exists public.asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz);'))
  assert.ok(mig.includes('drop function if exists public.asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz);'))
  const r = body(mig, 'asn_relay_acct_roster_report')
  for (const gone of ['window_decide', 'window_judge', 'v_pending', 'resets_at', 'week_confirm']) assert.ok(!r.includes(gone), `${gone} 不該還在 roster_report`)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.ok(mig.includes('grant execute on function public.asn_relay_acct_windows_clean(text, jsonb, text, timestamptz) to service_role;'))
  assert.doesNotMatch(mig, /alter table|create table|drop table|drop column|truncate|create policy/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
  assert.match(down, /^begin;$/m); assert.match(down, /^commit;$/m)
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

async function setup({ apply = true } = {}) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', owner_user uuid, bell_topic text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}'), ('${T2}', '${U2}');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('H', '${T1}', 'owner', '${U1}', 'bell-H');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  for (const f of [roster, lock, gem, reset, flags, share, wk, simplify, dropExp]) await db.exec(f)
  if (apply) await db.exec(mig)
  return db
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0].r
const report = (db, node, rows) => one(db, 'select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])
const rosterOf = (db, actor, user) => one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const H = 3600_000, D = 24 * H, MIN = 60_000

const rep = (windows, vendor = 'claude', extra = {}) => [{ vendor, email: 'a@x.test', plan: 'max', current: true, windows, ...extra }]
const win = (name, left, ago, resets_at = iso(Date.now() + 2 * H)) => ({ name, left_pct: left, resets_at, read_at: iso(Date.now() - ago) })
const wins = async (db, vendor = 'claude') => Object.fromEntries((await rosterOf(db, 'H', U1)).accounts.find(a => a.vendor === vendor).windows.map(w => [w.name, w]))

test('實跑：較新的蓋、較舊的不蓋（回 older_read）、同一秒以進來的為準', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', rep([win('five_hour', 50, 10 * MIN)]))
  assert.equal((await wins(db)).five_hour.left_pct, 50)
  assert.equal((await report(db, 'W', rep([win('five_hour', 40, 5 * MIN)]))).ok, true)
  assert.equal((await wins(db)).five_hour.left_pct, 40, '較新的蓋')
  const r = await report(db, 'W', rep([win('five_hour', 90, 8 * MIN)]))
  assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'five_hour', reason: 'older_read' }])
  assert.equal((await wins(db)).five_hour.left_pct, 40, '較舊的不蓋')
  const same = win('five_hour', 33, 5 * MIN)
  await report(db, 'W', rep([same]))
  assert.equal((await wins(db)).five_hour.left_pct, 33, '同一秒以進來的為準（同期回升也照收）')
})

test('實跑：每個窗各自判斷——一窗較舊被擋、另一窗較新照收', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', rep([win('five_hour', 50, 10 * MIN), win('weekly', 70, 2 * MIN)]))
  const r = await report(db, 'W', rep([win('five_hour', 20, 1 * MIN), win('weekly', 10, 5 * MIN)]))
  assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'weekly', reason: 'older_read' }])
  const w = await wins(db)
  assert.equal(w.five_hour.left_pct, 20)
  assert.equal(w.weekly.left_pct, 70)
})

test('實跑：舊版用戶端的舊欄位照收，但蓋不掉時間較新的讀數；較新的舊欄位可以蓋', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', rep([win('five_hour', 30, 1 * MIN), win('weekly', 60, 1 * MIN)]))
  const legacy = at => [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 90, weekly_pct: 95, reset_at: iso(Date.now() + 2 * H), at: iso(Date.now() - at) }]
  await report(db, 'H', legacy(20 * MIN))
  let w = await wins(db)
  assert.deepEqual([w.five_hour.left_pct, w.weekly.left_pct], [30, 60], '舊欄位的讀取時間較舊，蓋不掉')
  await report(db, 'H', legacy(10_000))
  w = await wins(db)
  assert.deepEqual([w.five_hour.left_pct, w.weekly.left_pct], [90, 95], '舊欄位的讀取時間較新，照收')
})

test('實跑：同帳號多台回報，每窗取讀取時間最新的那筆（不看是哪一台、也不看送達順序）', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', rep([win('five_hour', 50, 2 * MIN), win('weekly', 80, 20 * MIN)]))
  await report(db, 'H', rep([win('five_hour', 60, 9 * MIN), win('weekly', 70, 1 * MIN)]))
  const w = await wins(db)
  assert.equal(w.five_hour.left_pct, 50, 'W 的 5 小時較新')
  assert.equal(w.weekly.left_pct, 70, 'H 的每週較新')
  assert.equal(w.weekly.read_node, 'H')
  assert.equal(w.five_hour.read_node, 'W')
})

test('實跑：窗數上限照舊——一次最多收 4 窗、同名只留第一個；每人最多 100 個帳號列', { skip }, async () => {
  const db = await setup()
  const five = ['five_hour', 'weekly', 'w1', 'w2', 'w3'].map((n, i) => win(n, 10 + i, MIN))
  await report(db, 'W', rep([...five, win('weekly', 99, MIN)]))
  assert.deepEqual(Object.keys(await wins(db)).sort(), ['five_hour', 'w1', 'w2', 'weekly'])
  assert.equal((await wins(db)).weekly.left_pct, 11)
  const db2 = await setup()
  for (let i = 0; i < 105; i++) await report(db2, 'W', [{ vendor: 'claude', email: `u${i}@x.test`, plan: 'max', current: false, windows: [win('weekly', 5, MIN)] }])
  assert.equal((await db2.query(`select count(*)::int c from relay.asn_user_accounts where user_id = $1`, [U1])).rows[0].c, 100)
})

test('實跑：後台不看重置時間——已過期、2099 年的都照存；舊版（有舊四欄）這次沒帶的窗不拿掉；讀取時間在未來的記成現在', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', rep([win('five_hour', 50, 3 * H, iso(Date.now() - 2 * H)), win('weekly', 70, 3 * H, '2099-01-01T00:00:00Z')]))
  let w = await wins(db)
  assert.ok(Date.parse(w.five_hour.resets_at) < Date.now(), '已過期的窗照存')
  assert.equal(w.weekly.resets_at, '2099-01-01T00:00:00Z')
  // 舊版用戶端（列裡有舊四欄）只更新有帶的窗；新版（只有 windows）才整份取代，見 claude_quota_e2e_sql
  await report(db, 'W', rep([win('weekly', 60, MIN)], 'claude', { at: iso(Date.now() - MIN) }))
  w = await wins(db)
  assert.deepEqual(Object.keys(w).sort(), ['five_hour', 'weekly'], '沒帶的 five_hour 即使重置時間已過也不拿掉（顯示端自己處理）')
  // 讀取時間在未來：記成現在，不會鎖死之後正常的讀數
  await report(db, 'W', rep([{ name: 'weekly', left_pct: 5, resets_at: null, read_at: iso(Date.now() + 3 * D) }]))
  w = await wins(db)
  assert.equal(w.weekly.left_pct, 5)
  assert.ok(Date.parse(w.weekly.read_at) <= Date.now() + 1000, w.weekly.read_at)
  await report(db, 'W', rep([win('weekly', 44, -1000)]))
  assert.equal((await wins(db)).weekly.left_pct, 44, '之後正常的讀數照收')
})

test('實跑：Gemini 走同一條規則；沒帶 windows 的回報不動已存的窗；權限不變、decide／judge 已 drop', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', rep([win('five_hour', 50, 10 * MIN), win('weekly', 70, 10 * MIN)], 'gemini'))
  await report(db, 'W', rep([win('five_hour', 10, 20 * MIN), win('weekly', 70, 10 * MIN)], 'gemini'))
  assert.equal((await wins(db, 'gemini')).five_hour.left_pct, 50)
  assert.equal((await report(db, 'W', [{ vendor: 'gemini', email: 'a@x.test', plan: 'pro', current: true }])).ok, true)
  assert.deepEqual(Object.keys(await wins(db, 'gemini')).sort(), ['five_hour', 'weekly'])
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${SIG}`])).rows[0].v, false, role)
  }
  assert.equal((await db.query(`select has_function_privilege('service_role', $1, 'execute') v`, [`public.${SIG}`])).rows[0].v, true)
  assert.equal((await db.query(`select count(*)::int c from pg_proc where proname in ('asn_relay_acct_window_decide','asn_relay_acct_window_judge')`)).rows[0].c, 0)
})

test('實跑：回復後回到舊規則（2099 年的重置時間會被丟），再套一次也行', { skip }, async () => {
  const db = await setup()
  await db.exec(down)
  await report(db, 'W', rep([win('weekly', 70, MIN, '2099-01-01T00:00:00Z')]))
  const a = (await rosterOf(db, 'H', U1)).accounts.find(x => x.vendor === 'claude')
  assert.deepEqual(a ? a.windows : [], [], '舊規則：重置時間不在範圍的窗丟掉')
  await db.exec(mig)
  await report(db, 'W', rep([win('weekly', 70, 0, '2099-01-01T00:00:00Z')]))
  assert.equal((await wins(db)).weekly.left_pct, 70)
})

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/quota-merge-cases.json', import.meta.url), 'utf8'))
test('實跑：共用案例檔（新規則）每一個都照預期', { skip }, async () => {
  assert.ok(cases.cases.length >= 5)
  for (const c of cases.cases) {
    const db = await setup()
    const at = o => iso(Date.now() + o * 1000)
    if (c.old) await report(db, 'W', rep([{ name: 'five_hour', left_pct: c.old.left_pct, resets_at: null, read_at: at(c.old.offset_s) }]))
    const r = await report(db, 'W', rep([{ name: 'five_hour', left_pct: c.new.left_pct, resets_at: null, read_at: at(c.new.offset_s) }]))
    const got = (await wins(db)).five_hour.left_pct
    assert.equal(got, c.accept ? c.new.left_pct : c.old.left_pct, `${c.id} ${c.note}`)
    assert.deepEqual(r.skipped.map(x => x.reason), c.reason ? [c.reason] : [], c.id)
  }
})

closeAtEnd()
