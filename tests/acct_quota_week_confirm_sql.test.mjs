// 每週額度倍數檢查的待確認（#1184，20261111200000_acct_quota_week_confirm.sql）：
// 1. 靜態：roster_report 除了明列的片段與 20261110100000 版逐字相同；回復檔換回原本體；新函式只授權 service_role；沒有權杖類字樣。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    共用案例檔 confirm_sequences 每一步都跟電腦端一致（asn_relay_acct_window_decide）；
//    端到端：過期之後同一個新重置時間連續 3 次、隔滿 10 分鐘才收；交錯送兩組不誤收；待確認不外洩到 roster；回復後回到原狀。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261111200000_acct_quota_week_confirm.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(FILE)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const share = read('20261110100000_acct_quota_share.sql')
const gem = read('20261029130000_acct_roster_gemini.sql')
const flags = read('20261031100000_acct_login_flags.sql')
const reset = read('20261030100000_acct_reset_times.sql')
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/quota-merge-cases-legacy.json', import.meta.url), 'utf8'))

const body = (sql, name) => { const s = sql.indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', s) + 11) }
const swap = (t, a, b) => { assert.ok(t.includes(a), a); return t.replace(a, () => b) }
const DECIDE = 'asn_relay_acct_window_decide(text, text, jsonb, jsonb, jsonb, timestamptz)'

test('靜態：roster_report 只改明列的片段；回復檔換回原本體；新函式只授權 service_role', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261110100000_acct_quota_share.sql'))
  let r = body(mig, 'asn_relay_acct_roster_report')
  r = swap(r, "  v_gemini text[] := '{}';\n  v_pending jsonb;\n  v_dec jsonb;\n", "  v_gemini text[] := '{}';\n")
  r = swap(r, 'select windows, window_pending into v_merged, v_pending from', 'select windows into v_merged from')
  r = r.replace(/      -- 每週倍數不過時先記待確認[\s\S]*?else v_pending - \(v_w->>'name'\) end;\n/, "      v_reason := public.asn_relay_acct_window_judge(v_vendor, v_w->>'name', v_o, v_w, v_now);\n")
  r = swap(r, 'set windows = v_merged, window_pending = v_pending, plan =', 'set windows = v_merged, plan =')
  assert.equal(r, body(share, 'asn_relay_acct_roster_report'))
  assert.equal(body(down, 'asn_relay_acct_roster_report'), body(share, 'asn_relay_acct_roster_report'))
  assert.ok(down.includes(`drop function if exists public.${DECIDE};`))
  assert.match(down, /alter table relay\.asn_user_accounts drop column if exists window_pending;/)
  for (const f of [DECIDE, 'asn_relay_acct_roster_report(text, jsonb)']) {
    assert.ok(mig.includes(`revoke all on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(mig.includes(`grant execute on function public.${f} to service_role;`), f)
  }
  // judge 本體不動：這支不重新定義它
  assert.ok(!mig.includes('create or replace function public.asn_relay_acct_window_judge('))
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password|create policy|drop table|truncate/i)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
  assert.match(mig, /add column if not exists window_pending jsonb not null default '\{\}'::jsonb;/)
})

test('共用案例檔：待確認序列格式完整', () => {
  const seqs = cases.confirm_sequences
  assert.ok(Array.isArray(seqs) && seqs.length >= 6)
  assert.equal(cases.constants.confirm_count, 3)
  assert.equal(cases.constants.confirm_span_ms, 600000)
  const ids = new Set()
  for (const s of seqs) {
    assert.ok(!ids.has(s.id), s.id); ids.add(s.id)
    assert.equal(s.vendor, 'claude'); assert.equal(s.window, 'weekly')
    assert.ok(s.steps.length >= 1)
    for (const st of s.steps) { assert.equal(st.accept, st.reason === null, s.id); assert.ok(st.reason === null || st.reason in cases.reasons, s.id) }
  }
  // 兩個指定案例要在：交錯送 A／B 不誤收、同一組連續 3 次跨 10 分鐘會收
  assert.ok(seqs.some(s => s.steps.length >= 6 && s.steps.every(st => st.accept === false)), '交錯案例')
  assert.ok(seqs.some(s => s.steps.at(-1).accept === true && s.steps.length === 3), '連續 3 次案例')
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
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
  for (const f of [roster, lock, gem, reset, flags, share]) await db.exec(f)
  if (apply) await db.exec(mig)
  return db
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0].r
const report = (db, node, rows) => one(db, 'select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])
const rosterOf = (db, actor, user) => one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const H = 3600_000, D = 24 * H

test('實跑：共用案例 confirm_sequences 每一步都跟預期一致（decide 逐步帶著待確認狀態）', { skip }, async () => {
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

test('實跑：不是 not_week_multiple 的結果，decide 跟 judge 一致、待確認原樣帶回', { skip }, async () => {
  const db = await setup()
  for (const c of cases.cases.filter(x => x.vendor !== 'gemini' && x.reason !== 'not_week_multiple')) {
    const p = { resets_at: '2026-11-15T16:00:00Z', count: 2, first_at: '2026-11-09T07:00:00Z' }
    const r = await one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::timestamptz) r',
      [c.vendor, c.window, c.old == null ? null : JSON.stringify(c.old), JSON.stringify(c.new), JSON.stringify(p), c.now])
    assert.equal(r.reason, c.reason, c.id)
    assert.deepEqual(r.pending, c.accept ? null : p, c.id)
  }
  // 本來就會被 judge 擋的倍數案例：每一個，第一次看到都不收
  for (const c of cases.cases.filter(x => x.reason === 'not_week_multiple')) {
    const r = await one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, $5::timestamptz) r',
      [c.vendor, c.window, JSON.stringify(c.old), JSON.stringify(c.new), c.now])
    assert.equal(r.reason, 'not_week_multiple', c.id)
    assert.equal(r.pending.count, 1, c.id)
  }
})

const pendingOf = async db => (await db.query(`select window_pending p from relay.asn_user_accounts where account = 'a@x.test'`)).rows[0].p
const seed = async (db, oldReset) => {
  await report(db, 'W', [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: [{ name: 'weekly', left_pct: 70, resets_at: iso(Date.now() + D), read_at: iso(Date.now() - 60_000) }] }])
  const w = { name: 'weekly', left_pct: 70, resets_at: oldReset, read_at: iso(Date.now() - 3 * D), read_node: 'W' }
  await db.query(`update relay.asn_user_accounts set windows = $1::jsonb where account = 'a@x.test'`, [JSON.stringify([w])])
}
const weekly = (left, resets_at) => ({ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: [{ name: 'weekly', left_pct: left, resets_at, read_at: iso(Date.now() - 60_000) }] })
const gotWeekly = async db => (await rosterOf(db, 'H', U1)).accounts[0].windows.find(w => w.name === 'weekly')

test('實跑：端到端——過期後同一個新重置時間連續 3 次、隔滿 10 分鐘才收；待確認不外洩', { skip }, async () => {
  const db = await setup()
  const oldR = iso(Date.now() - 2 * D)
  await seed(db, oldR)
  const newR = iso(Date.now() + 3 * D + 5 * H)   // 與 old 差 5 天 5 小時：不是 7 天倍數
  let r = await report(db, 'W', [weekly(40, newR)])
  assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'weekly', reason: 'not_week_multiple' }])
  assert.equal((await pendingOf(db)).weekly.count, 1)
  r = await report(db, 'W', [weekly(40, newR)])
  assert.equal(r.skipped.length, 1)
  r = await report(db, 'W', [weekly(40, newR)])
  assert.equal(r.skipped.length, 1, '3 次但第一次到現在不到 10 分鐘：還不收')
  assert.equal((await pendingOf(db)).weekly.count, 3)
  assert.equal((await gotWeekly(db)).resets_at, oldR, '還是舊的基準')
  // 把第一次的時間往前推 11 分鐘（等於隔滿了），下一次就收
  const p = await pendingOf(db)
  p.weekly.first_at = iso(Date.now() - 11 * 60_000)
  await db.query(`update relay.asn_user_accounts set window_pending = $1::jsonb where account = 'a@x.test'`, [JSON.stringify(p)])
  r = await report(db, 'W', [weekly(40, newR)])
  assert.deepEqual(r.skipped, [])
  const w = await gotWeekly(db)
  assert.equal(w.resets_at, newR)
  assert.equal(w.left_pct, 40)
  assert.deepEqual(await pendingOf(db), {}, '收下後待確認清空')
  const out = JSON.stringify(await rosterOf(db, 'H', U1))
  assert.ok(!out.includes('window_pending') && !out.includes('first_at'), 'roster 不回待確認')
})

test('實跑：端到端——交錯送兩組重置時間不會誤收；記著的還沒過期時照擋、不累計', { skip }, async () => {
  const db = await setup()
  const oldR = iso(Date.now() - 2 * D)
  await seed(db, oldR)
  const a = iso(Date.now() + 3 * D + 5 * H), b = iso(Date.now() + 2 * D + 2 * H)
  for (let i = 0; i < 8; i++) {
    const r = await report(db, 'W', [weekly(40, i % 2 === 0 ? a : b)])
    assert.equal(r.skipped.length, 1, `第 ${i} 次`)
  }
  assert.equal((await pendingOf(db)).weekly.count, 1)
  assert.equal((await gotWeekly(db)).resets_at, oldR)
  // 記著的還沒過期（明天）：來了更晚的不是倍數＝later_not_expired，不累計待確認
  const db2 = await setup()
  await seed(db2, iso(Date.now() + D))
  for (let i = 0; i < 4; i++) {
    const r = await report(db2, 'W', [weekly(40, iso(Date.now() + 5 * D + 5 * H))])
    assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'weekly', reason: 'later_not_expired' }])
  }
  assert.deepEqual(await pendingOf(db2), {})
})

test('實跑：權限——新函式只有 service_role；回復後回到原狀（沒有 decide、沒有待確認欄位）', { skip }, async () => {
  const db = await setup()
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${DECIDE}`])).rows[0].v, false, role)
  }
  assert.equal((await db.query(`select has_function_privilege('service_role', $1, 'execute') v`, [`public.${DECIDE}`])).rows[0].v, true)
  await report(db, 'W', [weekly(40, iso(Date.now() + D))])
  await db.exec(down)
  assert.equal((await db.query(`select count(*)::int n from pg_proc where proname = 'asn_relay_acct_window_decide'`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int n from information_schema.columns where table_name = 'asn_user_accounts' and column_name = 'window_pending'`)).rows[0].n, 0)
  assert.equal((await report(db, 'W', [weekly(30, iso(Date.now() + D))])).ok, true, '回復後照常收')
  assert.equal((await gotWeekly(db)).left_pct, 30)
})

test('實跑：讀取時間較早的舊窗不蓋掉新的（older_read）；讀取時間較新照收', { skip }, async () => {
  const db = await setup()
  const dec = async (vendor, old, nw) => one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, $5::timestamptz) r',
    [vendor, 'weekly', JSON.stringify(old), JSON.stringify(nw), '2026-11-09T14:49:57Z'])
  const stored = { left_pct: 52, resets_at: '2026-11-15T16:00:00Z', read_at: '2026-11-09T14:38:53Z' }
  const stale = { left_pct: 51, resets_at: null, read_at: '2026-10-30T16:40:14Z' }
  assert.equal((await dec('claude', stored, stale)).reason, 'older_read')
  // Gemini 滿額照收的例外也要先過這關
  assert.equal((await dec('gemini', { ...stored, left_pct: 100 }, stale)).reason, 'older_read')
  // 讀取時間較新、其他正常：照收
  assert.equal((await dec('claude', stored, { left_pct: 40, resets_at: '2026-11-15T16:00:00Z', read_at: '2026-11-09T14:45:00Z' })).reason, null)
  // 缺 read_at 不比，照舊判斷
  assert.equal((await dec('claude', { left_pct: 52, resets_at: '2026-11-15T16:00:00Z' }, { left_pct: 40, resets_at: '2026-11-15T16:00:00Z' })).reason, null)
})

test('實跑：端到端——舊窗（讀取時間較早、沒有重置時間）被拒收，已存值不變', { skip }, async () => {
  const db = await setup()
  const rt = iso(Date.now() + 3 * D)
  await report(db, 'W', [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: [{ name: 'weekly', left_pct: 52, resets_at: rt, read_at: iso(Date.now() - 60_000) }] }])
  const r = await report(db, 'W', [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: [{ name: 'weekly', left_pct: 51, read_at: iso(Date.now() - 20 * D) }] }])
  assert.deepEqual(r.skipped, [{ vendor: 'claude', window: 'weekly', reason: 'older_read' }])
  const w = await gotWeekly(db)
  assert.equal(w.left_pct, 52)
  assert.equal(w.resets_at, rt)
})

test('實跑：讀取時間比後台現在晚超過 5 分鐘拒收（future_read）；時間正確的照常收', { skip }, async () => {
  const db = await setup()
  const rt = iso(Date.now() + 3 * D)
  const rep1 = left => report(db, 'W', [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: [{ name: 'weekly', left_pct: left, resets_at: rt, read_at: iso(Date.now() - 60_000) }] }])
  assert.deepEqual((await rep1(60)).skipped, [])
  // 一小時後的 read_at：windows_clean 本來就丟掉 10 分鐘以後的，直接打 decide 驗入口這關
  const dec = (old, nw) => one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, now()) r', ['claude', 'weekly', JSON.stringify(old), JSON.stringify(nw)])
  const old = { left_pct: 60, resets_at: rt, read_at: iso(Date.now() - 60_000) }
  assert.equal((await dec(old, { left_pct: 10, resets_at: rt, read_at: iso(Date.now() + H) })).reason, 'future_read')
  assert.equal((await dec(null, { left_pct: 10, resets_at: rt, read_at: iso(Date.now() + H) })).reason, 'future_read', '沒有已存窗也一樣')
  assert.equal((await dec(old, { left_pct: 10, resets_at: rt, read_at: iso(Date.now() + 2 * 60_000) })).reason, null, '5 分鐘內的誤差照收')
  assert.deepEqual((await rep1(40)).skipped, [])
  assert.equal((await gotWeekly(db)).left_pct, 40)
})

test('實跑：共用案例「只有後台」的案例（older_read／future_read）每一個都照預期（走 decide）', { skip }, async () => {
  const db = await setup()
  const bo = cases.cases.filter(c => c.scope === 'backend_only')
  assert.ok(bo.length >= 6 && bo.some(c => c.reason === 'older_read') && bo.some(c => c.reason === 'future_read'))
  for (const c of bo) {
    const r = await one(db, 'select public.asn_relay_acct_window_decide($1, $2, $3::jsonb, $4::jsonb, null, $5::timestamptz) r',
      [c.vendor, c.window, c.old == null ? null : JSON.stringify(c.old), JSON.stringify(c.new), c.now])
    assert.equal(r.reason, c.reason, `${c.id} ${c.note}`)
  }
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
