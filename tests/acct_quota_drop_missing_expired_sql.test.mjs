// 讀數沒有某一窗、而存著的那一窗已過重置時間：後台拿掉那一窗（#1321，20261113100000_acct_quota_drop_missing_expired.sql）：
// 1. 靜態：roster_report 除了明列的片段與 20261111200000 版逐字相同；回復檔換回上一版；只授權 service_role；不動資料表與其他函式。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    共用案例 missing_window_cases 端到端；只缺一窗但還沒過重置時間＝保留；只缺一窗而且已過＝拿掉；兩窗都在＝照舊；
//    另一窗被 older_read 擋掉時過期的那窗照樣拿掉；沒帶 windows 的舊用戶端不動；回復後不再拿掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261113100000_acct_quota_drop_missing_expired.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(FILE)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const wk = read('20261111200000_acct_quota_week_confirm.sql')
const simplify = read('20261113000000_acct_quota_rules_simplify.sql')
const share = read('20261110100000_acct_quota_share.sql')
const gem = read('20261029130000_acct_roster_gemini.sql')
const flags = read('20261031100000_acct_login_flags.sql')
const reset = read('20261030100000_acct_reset_times.sql')
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/quota-merge-cases.json', import.meta.url), 'utf8'))

const body = (sql, name) => { const s = sql.indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', s) + 11) }
const SIG = 'asn_relay_acct_roster_report(text, jsonb)'

test('靜態：roster_report 只多一段；回復檔換回上一版；只授權 service_role；不動資料表與其他函式', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261113000000_acct_quota_rules_simplify.sql'), '編號接在簡化那支之後')
  const r = body(mig, 'asn_relay_acct_roster_report').replace(/    -- 這次回報帶了 windows、但某個 name 完全沒有[\s\S]*?    end if;\n(?=    if jsonb_array_length\(v_merged\) > 4 then)/, '')
  assert.equal(r, body(wk, 'asn_relay_acct_roster_report'))
  assert.equal(body(down, 'asn_relay_acct_roster_report'), body(wk, 'asn_relay_acct_roster_report'))
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  for (const other of ['window_decide', 'window_judge', 'windows_clean', 'acct_roster(']) assert.ok(!mig.includes(`create or replace function public.asn_relay_acct_${other}`), other)
  assert.doesNotMatch(mig, /alter table|create table|drop table|drop column|truncate|create policy/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

test('共用案例檔：missing_window_cases 五種情況都在（還沒過保留、已過拿掉、兩窗都在、反過來、沒有重置時間）', () => {
  const m = cases.missing_window_cases
  assert.deepEqual(m.map(c => c.id), ['m1', 'm2', 'm3', 'm4', 'm5'])
  const kept = m.find(c => c.id === 'm1'), dropped = m.find(c => c.id === 'm2')
  assert.deepEqual(kept.expect_present, ['five_hour', 'weekly'], '只缺一窗但還沒過重置時間：保留')
  assert.deepEqual(dropped.expect_present, ['weekly'], '只缺一窗而且已過：拿掉')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

async function setup({ apply = true } = {}) {
  const db = new PGlite()
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
  for (const f of [roster, lock, gem, reset, flags, share, wk, simplify]) await db.exec(f)
  if (apply) await db.exec(mig)
  return db
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0].r
const report = (db, node, rows) => one(db, 'select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])
const rosterOf = (db, actor, user) => one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const H = 3600_000, D = 24 * H

const names = async (db, vendor = 'claude') => (await rosterOf(db, 'H', U1)).accounts.find(a => a.vendor === vendor).windows.map(w => w.name).sort()
const rep = (vendor, windows) => [{ vendor, email: 'a@x.test', plan: 'max', current: true, windows }]
const win = (name, left, resets_at, ago = 10_000) => ({ name, left_pct: left, resets_at, read_at: iso(Date.now() - ago) })

test('實跑：共用案例 missing_window_cases 端到端', { skip }, async () => {
  for (const c of cases.missing_window_cases) {
    const db = await setup()
    const shift = t => (t == null ? null : iso(Date.parse(t) + (Date.now() - Date.parse(c.now))))
    // 先把存著的窗報進去（資料時間是 1 小時前）
    const old = Object.entries(c.old).map(([name, w]) => ({ name, left_pct: w.left_pct, resets_at: shift(w.resets_at), read_at: shift(w.read_at) }))
    await report(db, 'W', rep('claude', old))
    assert.deepEqual(await names(db), Object.keys(c.old).sort(), `${c.id} 先存好兩窗`)
    // 這次只帶 new_has 那幾窗（重置時間在未來）
    const next = c.new_has.map(name => win(name, 40, iso(Date.now() + (name === 'weekly' ? 4 * D : 2 * H))))
    await report(db, 'W', rep('claude', next))
    assert.deepEqual(await names(db), [...c.expect_present].sort(), `${c.id} ${c.note}`)
  }
})

test('實跑：另一窗這次被 older_read 擋掉，缺的那窗已過期照樣拿掉；沒帶 windows 的舊用戶端不動', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', rep('claude', [win('five_hour', 50, iso(Date.now() - 2 * H), 3 * H), win('weekly', 70, iso(Date.now() + 4 * D), 60_000)]))
  // 每週這次的讀取時間比記著的早（舊視窗重送）→ 被擋；5 小時缺而且已過期 → 拿掉
  const r = await report(db, 'W', rep('claude', [win('weekly', 10, iso(Date.now() + 4 * D), 30 * 60_000)]))
  assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'weekly', reason: 'older_read' }])
  assert.deepEqual(await names(db), ['weekly'])
  assert.equal((await rosterOf(db, 'H', U1)).accounts[0].windows[0].left_pct, 70, '被擋的每週維持舊值')
  // 沒帶 windows 的舊用戶端：不動
  const db2 = await setup()
  await report(db2, 'W', rep('gemini', [win('five_hour', 50, iso(Date.now() - 2 * H), 3 * H), win('weekly', 70, iso(Date.now() + 4 * D), 3 * H)]))
  assert.equal((await report(db2, 'W', [{ vendor: 'gemini', email: 'a@x.test', plan: 'pro', current: true }])).ok, true)
  assert.deepEqual(await names(db2, 'gemini'), ['five_hour', 'weekly'], '沒帶 windows＝不知道有沒有這一窗，不動')
})

test('實跑：權限與回復——回復後沒帶的過期窗不再被拿掉', { skip }, async () => {
  const db = await setup()
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${SIG}`])).rows[0].v, false, role)
  }
  assert.equal((await db.query(`select has_function_privilege('service_role', $1, 'execute') v`, [`public.${SIG}`])).rows[0].v, true)
  await db.exec(down)
  await report(db, 'W', rep('claude', [win('five_hour', 50, iso(Date.now() - 2 * H), 3 * H), win('weekly', 70, iso(Date.now() + 4 * D), 3 * H)]))
  await report(db, 'W', rep('claude', [win('weekly', 60, iso(Date.now() + 4 * D))]))
  assert.deepEqual(await names(db), ['five_hour', 'weekly'], '回復後又是舊行為')
})
