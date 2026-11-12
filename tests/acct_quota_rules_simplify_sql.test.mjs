// 額度規則簡化（#1266，20261113000000_acct_quota_rules_simplify.sql）：
// 1. 靜態：judge 只剩重置時間範圍、decide 只剩 future_read／older_read／範圍；windows_clean 除了明列的片段與 20261110100000 版逐字相同；
//    回復檔換回上一版；只授權 service_role；沒動資料表（window_pending 欄位保留）；沒有權杖類字樣。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    共用案例 tests/fixtures/quota-merge-cases.json 的 cases 每一個、window_pair_cases 每條窗各自判斷；
//    端到端：同期回升照收、舊視窗重送的舊數字被擋而另一條窗照收、舊版留下的待確認被清掉、回復後回到簡化之前。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261113000000_acct_quota_rules_simplify.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(FILE)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const wk = read('20261111200000_acct_quota_week_confirm.sql')
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
const swap = (t, a, b) => { assert.ok(t.includes(a), a); return t.replace(a, () => b) }
const SIGS = {
  asn_relay_acct_window_judge: 'text, text, jsonb, jsonb, timestamptz',
  asn_relay_acct_window_decide: 'text, text, jsonb, jsonb, jsonb, timestamptz',
  asn_relay_acct_windows_clean: 'text, jsonb, text, timestamptz',
}

test('靜態：judge 與 decide 只剩三條規則；windows_clean 只改明列的片段；回復檔換回上一版；只授權 service_role', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261112100000_inbox_watch_per_agent.sql'), '編號要在 main 當時最新的之後')
  const j = body(mig, 'asn_relay_acct_window_judge'), d = body(mig, 'asn_relay_acct_window_decide')
  for (const gone of ['same_period_rise', 'earlier', 'later_not_expired', 'not_week_multiple', "'gemini'", "'minimax'", 'left_pct']) {
    assert.ok(!j.includes(gone) && !d.includes(gone), `簡化後不該還有 ${gone}`)
  }
  for (const kept of ['reset_out_of_range']) assert.ok(j.includes(kept))
  for (const kept of ['future_read', 'older_read', 'asn_relay_acct_window_judge']) assert.ok(d.includes(kept))
  const c = swap(body(mig, 'asn_relay_acct_windows_clean'), "-- 讀取時間在未來太多的，由 decide 的 future_read 擋（有原因代碼、看得到），這裡只丟掉沒有讀取時間的\n    continue when v_read is null;", "continue when v_read is null or v_read::timestamptz > p_now + interval '10 minutes';")
  assert.equal(c, body(share, 'asn_relay_acct_windows_clean'))
  assert.equal(body(down, 'asn_relay_acct_window_judge'), body(share, 'asn_relay_acct_window_judge'))
  assert.equal(body(down, 'asn_relay_acct_window_decide'), body(wk, 'asn_relay_acct_window_decide'))
  assert.equal(body(down, 'asn_relay_acct_windows_clean'), body(share, 'asn_relay_acct_windows_clean'))
  for (const [name, args] of Object.entries(SIGS)) {
    assert.ok(mig.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`), name)
    assert.ok(mig.includes(`grant execute on function public.${name}(${args}) to service_role;`), name)
  }
  assert.ok(!mig.includes('create or replace function public.asn_relay_acct_roster_report('), 'roster_report 不動')
  assert.doesNotMatch(mig, /alter table|create table|drop table|drop column|truncate|create policy/i, '不動資料表，window_pending 欄位保留')
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

test('共用案例檔：只剩三個原因代碼；每個代碼、每個廠牌都有案例；p1～p4 都在', () => {
  assert.deepEqual(Object.keys(cases.reasons).sort(), ['future_read', 'older_read', 'reset_out_of_range'])
  for (const r of Object.keys(cases.reasons)) assert.ok(cases.cases.some(c => c.reason === r), r)
  assert.ok(cases.cases.some(c => c.accept === true))
  for (const v of ['claude', 'gemini', 'minimax', 'grok']) assert.ok(cases.cases.some(c => c.vendor === v), v)
  const ids = new Set()
  for (const c of cases.cases) {
    assert.ok(!ids.has(c.id), c.id); ids.add(c.id)
    assert.equal(c.accept, c.reason === null, c.id)
    if (c.reason) assert.ok(c.reason in cases.reasons, c.id)
  }
  assert.deepEqual(cases.window_pair_cases.map(p => p.id), ['p1', 'p2', 'p3', 'p4'])
  // p1 是 11-09 工作機真實情境：5 小時同期回升，簡化後兩條都收
  const p1 = cases.window_pair_cases[0]
  assert.ok(p1.new.five_hour.left_pct > p1.old.five_hour.left_pct && p1.expect.five_hour.accept && p1.expect.weekly.accept)
  // 至少一個案例是「一條被擋、另一條照收」
  assert.ok(cases.window_pair_cases.some(p => Object.values(p.expect).some(e => !e.accept) && Object.values(p.expect).some(e => e.accept)))
})

let PGlite = null
try { PGlite = await fastPGlite() } catch { /* 沒裝就略過實跑 */ }
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
  for (const f of [roster, lock, gem, reset, flags, share, wk]) await db.exec(f)
  if (apply) await db.exec(mig)
  return db
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0].r
const report = (db, node, rows) => one(db, 'select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])
const rosterOf = (db, actor, user) => one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const H = 3600_000, D = 24 * H
const decide = (db, c, w, old, nw, now) => one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, $5::timestamptz) r',
  [c.vendor, w, old == null ? null : JSON.stringify(old), JSON.stringify(nw), now])

test('實跑：共用案例 cases 每一個都跟預期一致（decide）', { skip }, async () => {
  const db = await setup()
  for (const c of cases.cases) {
    const r = await decide(db, c, c.window, c.old, c.new, c.now)
    assert.equal(r.reason, c.reason, `${c.id} ${c.note}`)
    assert.equal(r.pending, null, c.id)
  }
})

test('實跑：共用案例 window_pair_cases 每條窗各自判斷，一條被擋不影響另一條', { skip }, async () => {
  const db = await setup()
  for (const p of cases.window_pair_cases) {
    for (const w of ['five_hour', 'weekly']) {
      const r = await decide(db, p, w, p.old[w], p.new[w], p.now)
      assert.equal(r.reason, p.expect[w].reason, `${p.id} ${w} ${p.note}`)
    }
  }
})

// 端到端：把案例的時間搬到「現在」附近（重置時間要落在合理範圍內）
const shiftOf = c => { const d = Date.now() - Date.parse(c.now); return t => iso(Date.parse(t) + d) }
const sideWindows = (c, side, shift) => ['five_hour', 'weekly'].map(w => ({ name: w, left_pct: c[side][w].left_pct, resets_at: shift(c[side][w].resets_at), read_at: shift(c[side][w].read_at) }))
const acctOf = async (db, vendor) => (await rosterOf(db, 'H', U1)).accounts.find(a => a.vendor === vendor)
const seedPair = async (db, c) => {
  const shift = shiftOf(c)
  await report(db, 'W', [{ vendor: c.vendor, email: 'a@x.test', plan: 'pro', current: true, windows: sideWindows(c, 'old', shift).map(x => ({ ...x, read_at: iso(Date.now() - 60_000) })) }])
  await db.query(`update relay.asn_user_accounts set windows = $1::jsonb where vendor = $2`, [JSON.stringify(sideWindows(c, 'old', shift).map(x => ({ ...x, read_node: 'W' }))), c.vendor])
  return shift
}

test('實跑：端到端——p1 Gemini 真實情境，同期回升的 5 小時窗與週窗兩條都收', { skip }, async () => {
  const db = await setup()
  const c = cases.window_pair_cases.find(p => p.id === 'p1')
  const shift = await seedPair(db, c)
  const r = await report(db, 'W', [{ vendor: 'gemini', email: 'a@x.test', plan: 'pro', current: true, windows: sideWindows(c, 'new', shift) }])
  assert.deepEqual(r.skipped, [])
  const a = await acctOf(db, 'gemini')
  assert.equal(a.windows.find(x => x.name === 'five_hour').left_pct, 60)
  assert.equal(a.windows.find(x => x.name === 'weekly').read_at, shift(c.new.weekly.read_at))
})

test('實跑：端到端——p2 舊視窗重送的舊數字（5 小時）被擋，週窗照收', { skip }, async () => {
  const db = await setup()
  const c = cases.window_pair_cases.find(p => p.id === 'p2')
  const shift = await seedPair(db, c)
  const r = await report(db, 'W', [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: sideWindows(c, 'new', shift) }])
  assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'five_hour', reason: 'older_read' }])
  const a = await acctOf(db, 'claude')
  assert.equal(a.windows.find(x => x.name === 'five_hour').left_pct, 20, '被擋的 5 小時維持舊值')
  assert.equal(a.windows.find(x => x.name === 'weekly').left_pct, 60, '週窗收下')
})

test('實跑：舊版留下的待確認會被清掉；future_read 取代了 windows_clean 的靜默丟棄（有原因代碼）', { skip }, async () => {
  const db = await setup()
  const rt = iso(Date.now() + 4 * D)
  const win = (left, read) => [{ vendor: 'gemini', email: 'a@x.test', plan: 'pro', current: true, windows: [{ name: 'weekly', left_pct: left, resets_at: rt, read_at: read }] }]
  await report(db, 'W', win(50, iso(Date.now() - 3 * H)))
  await db.query(`update relay.asn_user_accounts set window_pending = '{"weekly":{"resets_at":"${rt}","count":2,"first_at":"${iso(Date.now() - 5 * 60_000)}","left_pct":99}}'::jsonb where vendor = 'gemini'`)
  let r = await report(db, 'W', win(40, iso(Date.now() - 60_000)))
  assert.deepEqual(r.skipped, [])
  assert.deepEqual((await db.query(`select window_pending p from relay.asn_user_accounts where vendor = 'gemini'`)).rows[0].p, {}, '舊的待確認清掉了')
  // 讀取時間在未來 1 小時：報原因 future_read（不是被 windows_clean 靜默丟掉）
  r = await report(db, 'W', win(10, iso(Date.now() + H)))
  assert.deepEqual(r.skipped, [{ vendor: 'gemini', window: 'weekly', reason: 'future_read' }])
  assert.equal((await acctOf(db, 'gemini')).windows[0].left_pct, 40, '已存的值不動')
})

test('實跑：權限與回復——三支函式只有 service_role；回復後回到簡化之前（同期回升又被擋）', { skip }, async () => {
  const db = await setup()
  for (const [name, args] of Object.entries(SIGS)) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${name}(${args})`])).rows[0].v, false, `${role} ${name}`)
    }
    assert.equal((await db.query(`select has_function_privilege('service_role', $1, 'execute') v`, [`public.${name}(${args})`])).rows[0].v, true, name)
  }
  assert.equal((await db.query(`select count(*)::int n from information_schema.columns where table_name = 'asn_user_accounts' and column_name = 'window_pending'`)).rows[0].n, 1, 'window_pending 欄位保留')
  await db.exec(down)
  const R = '2026-11-13T23:42:55Z'
  const r = await one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, $5::timestamptz) r',
    ['gemini', 'weekly', JSON.stringify({ left_pct: 0, resets_at: R, read_at: '2026-11-09T11:00:00Z' }), JSON.stringify({ left_pct: 99, resets_at: R, read_at: '2026-11-09T11:59:00Z' }), '2026-11-09T12:00:00Z'])
  assert.equal(r.reason, 'same_period_rise', '回復後又是舊規則')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
