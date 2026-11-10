// Gemini、MiniMax 同一期剩餘回升改走待確認（#1261，20261112500000_acct_quota_rise_confirm.sql）：
// 1. 靜態：decide 除了明列的片段與 20261111200000 版逐字相同；回復檔換回上一版；只授權 service_role；沒有權杖類字樣、沒動資料表。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    共用案例 confirm_sequences 全部（含 gemini、minimax、claude 的新序列）逐步跟預期一致；
//    端到端：Gemini 每週剩 0% 之後連續 3 次讀到 99%、隔滿 10 分鐘才收；交錯不收；Claude 維持一律拒收；回復後回到原狀。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261112500000_acct_quota_rise_confirm.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(FILE)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const prev = read('20261111200000_acct_quota_week_confirm.sql')
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
const DECIDE = 'asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz)'

test('靜態：decide 只改明列的片段；回復檔換回上一版；只授權 service_role；不動資料表', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261112100000_inbox_watch_per_agent.sql'), '編號要在 main 最新的之後')
  let d = body(mig, 'asn_relay_acct_window_decide')
  d = swap(d, '  v_count int := 1;\n  v_left int;\nbegin', '  v_count int := 1;\nbegin')
  d = d.replace(/  -- Gemini、MiniMax 同一期剩餘回升（#1261）[\s\S]*?  end if;\n(?=  -- 只有 Claude 每週倍數不過)/, '')
  assert.equal(d, body(prev, 'asn_relay_acct_window_decide'))
  assert.equal(body(down, 'asn_relay_acct_window_decide'), body(prev, 'asn_relay_acct_window_decide'))
  assert.ok(mig.includes(`revoke all on function public.${DECIDE} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${DECIDE} to service_role;`))
  assert.ok(!mig.includes('create or replace function public.asn_relay_acct_window_judge('), 'judge 不動')
  assert.ok(!mig.includes('create or replace function public.asn_relay_acct_roster_report('), 'roster_report 不動')
  assert.doesNotMatch(mig, /alter table|create table|drop table|truncate|create policy/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

test('共用案例檔：Gemini／MiniMax 回升確認的序列都在，原因代碼表不變', () => {
  const by = Object.fromEntries(cases.confirm_sequences.map(s => [s.id, s]))
  for (const id of ['c9', 'c10', 'c11', 'c12', 'c13', 'c14']) assert.ok(by[id], id)
  assert.equal(by.c9.vendor, 'gemini'); assert.deepEqual(by.c9.steps.map(s => s.accept), [false, false, true], '真回補要收')
  assert.ok(by.c10.steps.filter(s => s.new.left_pct === 99).every(s => !s.accept), '交錯的回升不收')
  assert.equal(by.c13.scope, 'backend_only'); assert.equal(by.c14.scope, 'backend_only')
  assert.equal(cases.constants.rise_tolerance_pct, 2)
  assert.deepEqual(Object.keys(cases.reasons).sort(), ['earlier', 'future_read', 'later_not_expired', 'not_week_multiple', 'older_read', 'reset_out_of_range', 'same_period_rise'])
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
  for (const f of [roster, lock, gem, reset, flags, share, prev]) await db.exec(f)
  if (apply) await db.exec(mig)
  return db
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0].r
const report = (db, node, rows) => one(db, 'select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])
const rosterOf = (db, actor, user) => one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const H = 3600_000, D = 24 * H

test('實跑：共用案例 confirm_sequences 全部每一步都跟預期一致（含 gemini、minimax、claude 的回升序列）', { skip }, async () => {
  const db = await setup()
  for (const s of cases.confirm_sequences) {
    let old = s.old, pending = null
    for (const [i, st] of s.steps.entries()) {
      const r = await one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::timestamptz) r',
        [s.vendor, s.window, JSON.stringify(old), JSON.stringify(st.new), pending == null ? null : JSON.stringify(pending), st.now])
      assert.equal(r.reason, st.reason, `${s.id} 第 ${i + 1} 步 ${s.note}`)
      if (st.accept) { old = st.new; pending = null } else pending = r.pending
    }
  }
})

test('實跑：缺讀取時間照舊直接拒收；新窗讀取時間不比已存的新也直接拒收（不走待確認）；Gemini 記著滿額照收的例外不變', { skip }, async () => {
  const db = await setup()
  const dec = (vendor, old, nw, now = '2026-11-09T12:40:00Z') => one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, $5::timestamptz) r', [vendor, 'weekly', JSON.stringify(old), JSON.stringify(nw), now])
  const R = '2026-11-13T23:42:55Z'
  const withRead = { left_pct: 0, resets_at: R, read_at: '2026-11-09T12:00:00Z' }
  let r = await dec('gemini', { left_pct: 0, resets_at: R }, { left_pct: 99, resets_at: R })
  assert.deepEqual([r.reason, r.pending], ['same_period_rise', null], '缺讀取時間')
  r = await dec('gemini', withRead, { left_pct: 99, resets_at: R, read_at: '2026-11-09T12:00:00Z' })
  assert.deepEqual([r.reason, r.pending], ['same_period_rise', null], '讀取時間一樣（不是比較新）')
  r = await dec('gemini', { left_pct: 100, resets_at: '2026-11-13T23:00:00Z', read_at: '2026-11-09T12:00:00Z' }, { left_pct: 90, resets_at: R, read_at: '2026-11-09T12:30:00Z' })
  assert.equal(r.reason, null, '滿額照收的例外不變')
  r = await dec('gemini', withRead, { left_pct: 99, resets_at: R, read_at: '2026-11-09T12:30:00Z' })
  assert.equal(r.reason, 'same_period_rise'); assert.equal(r.pending.count, 1); assert.equal(r.pending.left_pct, 99)
})

const pendingOf = async (db, vendor = 'gemini') => (await db.query(`select window_pending p from relay.asn_user_accounts where vendor = $1`, [vendor])).rows[0].p
const seed = async (db, vendor, left, rt) => {
  await report(db, 'W', [{ vendor, email: 'a@x.test', plan: 'pro', current: true, windows: [{ name: 'weekly', left_pct: left, resets_at: rt, read_at: iso(Date.now() - 60_000) }] }])
  const w = { name: 'weekly', left_pct: left, resets_at: rt, read_at: iso(Date.now() - 3 * H), read_node: 'W' }
  await db.query(`update relay.asn_user_accounts set windows = $1::jsonb where vendor = $2`, [JSON.stringify([w]), vendor])
}
// 讀取時間每次往後 1 秒（同一秒內讀取時間一樣不算比較新，測試要嚴格遞增）
let tick = 0
const rep1 = (vendor, left, rt) => [{ vendor, email: 'a@x.test', plan: 'pro', current: true, windows: [{ name: 'weekly', left_pct: left, resets_at: rt, read_at: iso(Date.now() - 200_000 + (++tick) * 1000) }] }]
const gotWeekly = async (db, vendor) => (await rosterOf(db, 'H', U1)).accounts.find(a => a.vendor === vendor).windows.find(w => w.name === 'weekly')

test('實跑：端到端——Gemini 每週剩 0% 之後連續讀到 99%，隔滿 10 分鐘才收；待確認期間照舊顯示舊值；待確認不外洩', { skip }, async () => {
  const db = await setup()
  const rt = iso(Date.now() + 4 * D)
  await seed(db, 'gemini', 0, rt)
  for (let i = 0; i < 3; i++) {
    const r = await report(db, 'W', rep1('gemini', 99, rt))
    assert.deepEqual(r.skipped, [{ vendor: 'gemini', window: 'weekly', reason: 'same_period_rise' }], `第 ${i + 1} 次`)
  }
  assert.equal((await pendingOf(db)).weekly.count, 3)
  assert.equal((await gotWeekly(db, 'gemini')).left_pct, 0, '待確認期間照舊顯示舊值')
  // 把第一次的時間往前推 11 分鐘（等於隔滿了），下一次就收
  const p = await pendingOf(db)
  p.weekly.first_at = iso(Date.now() - 11 * 60_000)
  await db.query(`update relay.asn_user_accounts set window_pending = $1::jsonb where vendor = 'gemini'`, [JSON.stringify(p)])
  const r = await report(db, 'W', rep1('gemini', 98, rt))
  assert.deepEqual(r.skipped, [], '差 1% 算同一個值，收下')
  assert.equal((await gotWeekly(db, 'gemini')).left_pct, 98)
  assert.deepEqual(await pendingOf(db), {}, '收下後待確認清空')
  assert.ok(!JSON.stringify(await rosterOf(db, 'H', U1)).includes('first_at'))
})

test('實跑：端到端——99 與 0 交錯永遠不收；差超過 2% 重新計數；Claude 維持一律拒收', { skip }, async () => {
  const db = await setup()
  const rt = iso(Date.now() + 4 * D)
  await seed(db, 'gemini', 0, rt)
  for (let i = 0; i < 6; i++) {
    const r1 = await report(db, 'W', rep1('gemini', 99, rt))
    assert.equal(r1.skipped.length, 1)
    const r0 = await report(db, 'W', rep1('gemini', 0, rt))
    assert.equal(r0.skipped.length, 0, '0% 不是回升，照常收下並清掉待確認')
  }
  assert.equal((await gotWeekly(db, 'gemini')).left_pct, 0)
  assert.deepEqual(await pendingOf(db), {})
  // 差超過 2%：重新計數
  await report(db, 'W', rep1('gemini', 99, rt))
  await report(db, 'W', rep1('gemini', 90, rt))
  assert.equal((await pendingOf(db)).weekly.count, 1)
  assert.equal((await pendingOf(db)).weekly.left_pct, 90)
  // Claude：同期回升一律拒收，不累計待確認
  const db2 = await setup()
  await seed(db2, 'claude', 10, rt)
  for (let i = 0; i < 4; i++) {
    const r = await report(db2, 'W', rep1('claude', 99, rt))
    assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'weekly', reason: 'same_period_rise' }])
  }
  assert.deepEqual(await pendingOf(db2, 'claude'), {})
})

test('實跑：權限與回復——新版 decide 只有 service_role；回復後同期回升回到一律拒收', { skip }, async () => {
  const db = await setup()
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${DECIDE}`])).rows[0].v, false, role)
  }
  assert.equal((await db.query(`select has_function_privilege('service_role', $1, 'execute') v`, [`public.${DECIDE}`])).rows[0].v, true)
  await db.exec(down)
  const R = '2026-11-13T23:42:55Z'
  const r = await one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, $5::timestamptz) r',
    ['gemini', 'weekly', JSON.stringify({ left_pct: 0, resets_at: R, read_at: '2026-11-09T12:00:00Z' }), JSON.stringify({ left_pct: 99, resets_at: R, read_at: '2026-11-09T12:30:00Z' }), '2026-11-09T12:40:00Z'])
  assert.deepEqual([r.reason, r.pending], ['same_period_rise', null])
})
