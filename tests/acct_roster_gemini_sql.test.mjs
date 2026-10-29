// 帳號列表第二批：Gemini 額度（20261029130000_acct_roster_gemini.sql，#374，asn真 #1515／#1519）：
// 1. 靜態：編號在最新之後；只 create or replace 三支函式、只改該改的幾處（其餘跟原版逐字相同）；舊函式、舊表不動；只授權 service_role；回復檔換回原版。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：共用案例全部（含 gemini）照預期；權限不變；
//    gemini 寫入只收 five_hour／weekly；滿額遇滿額、滿額後開始用照收；記著非滿額、來滿額不收；claude／codex 行為不變；
//    舊的 asn_relay_acct_report 照樣不收 gemini；回復後函式跟原版逐字相同、gemini 列刪掉、約束不再收 gemini；可重跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261029130000_acct_roster_gemini.sql'
const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read(FILE)
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const down = fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/quota-merge-cases.json', import.meta.url), 'utf8'))

const FNS = {
  asn_relay_acct_window_judge: 'asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz)',
  asn_relay_acct_windows_clean: 'asn_relay_acct_windows_clean(text, jsonb, text, timestamptz)',
  asn_relay_acct_roster_report: 'asn_relay_acct_roster_report(text, jsonb)',
}
const body = (sql, name) => { const s = sql.indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', s) + 11) }
const without = (s, part) => { assert.ok(s.includes(part), part); return s.replace(part, '') }

const JUDGE_ADD = `  -- Gemini 現記的是 100%（沒用過的桶，agy 給的重置時間每次都是「現在＋整個窗長」、一直往後跑）：照收新的（#1519）
  if p_vendor = 'gemini' and p_old is not null and jsonb_typeof(p_old->'left_pct') = 'number' and (p_old->>'left_pct')::numeric = 100 then
    return null;
  end if;
`
const CLEAN_ADD = `    -- Gemini 只收 five_hour、weekly（電腦端只對應 gemini-5h、gemini-weekly 兩桶，#1515）
    continue when p_vendor = 'gemini' and v_name not in ('five_hour', 'weekly');
`

test('靜態：編號在最新之後；三支函式只改該改的地方；舊函式舊表不動；只授權 service_role；回復檔換回原版', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.includes(FILE) && FILE > '20261029120000_ai_wake_limit_200.sql')
  assert.equal((mig.match(/create or replace function/g) ?? []).length, 3)
  assert.doesNotMatch(mig, /function public\.asn_relay_acct_report\(|function public\.asn_relay_acct_quota\(|(alter table|insert into|update|delete from) relay\.asn_accounts\b|create table|drop table|create policy/i)
  assert.equal(mig.replace(body(mig, 'asn_relay_acct_roster_report'), '').match(/delete from/gi), null, '寫入函式本體以外不刪資料')
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  for (const f of [mig, down]) {
    for (const sig of Object.values(FNS)) {
      assert.ok(f.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig)
      assert.ok(f.includes(`grant execute on function public.${sig} to service_role;`), sig)
    }
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  assert.match(mig, /add constraint asn_user_accounts_vendor_check check \(vendor in \('claude', 'codex', 'grok', 'gemini'\)\);/)
  // 判斷：原版多一段 gemini 滿額規則，其他逐字相同
  assert.equal(without(body(mig, 'asn_relay_acct_window_judge'), JUDGE_ADD), body(roster, 'asn_relay_acct_window_judge'))
  // 清理：廠牌加 gemini、gemini 只收兩個窗名
  assert.equal(without(body(mig, 'asn_relay_acct_windows_clean'), CLEAN_ADD).replace("('claude', 'codex', 'gemini')", "('claude', 'codex')"), body(roster, 'asn_relay_acct_windows_clean'))
  // 寫入：跟 20261029110000 版只差廠牌清單
  assert.equal(body(mig, 'asn_relay_acct_roster_report').replace("not in ('claude', 'codex', 'grok', 'gemini')", "not in ('claude', 'codex', 'grok')"), body(lock, 'asn_relay_acct_roster_report'))
  // 回復檔：三支換回原版逐字；只刪 gemini 的列；約束換回不含 gemini
  assert.equal(body(down, 'asn_relay_acct_window_judge'), body(roster, 'asn_relay_acct_window_judge'))
  assert.equal(body(down, 'asn_relay_acct_windows_clean'), body(roster, 'asn_relay_acct_windows_clean'))
  assert.equal(body(down, 'asn_relay_acct_roster_report'), body(lock, 'asn_relay_acct_roster_report'))
  assert.equal((down.replace(body(down, 'asn_relay_acct_roster_report'), '').match(/delete from/g) ?? []).length, 1, '函式本體以外只刪 gemini 的列')
  assert.match(down, /delete from relay\.asn_user_accounts where vendor = 'gemini';/)
  assert.match(down, /add constraint asn_user_accounts_vendor_check check \(vendor in \('claude', 'codex', 'grok'\)\);/)
  assert.doesNotMatch(down, /drop table|drop function|truncate /i)
})

test('共用案例檔：有 gemini 的滿額案例與基本案例；claude、codex 有不套滿額規則的反向案例', () => {
  const g = cases.cases.filter(c => c.vendor === 'gemini')
  assert.ok(g.length >= 10)
  const fullOld = c => c.old?.left_pct === 100
  assert.ok(g.some(c => fullOld(c) && c.new.left_pct === 100 && c.accept), '滿額遇滿額照收')
  assert.ok(g.some(c => fullOld(c) && c.new.left_pct < 100 && c.accept), '滿額後開始用照收')
  assert.ok(g.some(c => c.old && c.old.left_pct < 100 && c.new.left_pct === 100 && c.reason === 'later_not_expired'), '記著非滿額、來滿額不收')
  for (const r of ['same_period_rise', 'earlier', 'reset_out_of_range']) assert.ok(g.some(c => c.reason === r), r)
  for (const v of ['claude', 'codex']) assert.ok(cases.cases.some(c => c.vendor === v && fullOld(c) && c.reason === 'later_not_expired'), v)
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
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('H', '${T1}', 'owner', '${U1}', 'bell-H');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  await db.exec(roster)
  await db.exec(lock)
  if (apply) await db.exec(mig)
  return db
}
const fnDef = async (db, name) => (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).rows.map(r => r.d).join('\n')
const report = async (db, node, rows) => (await db.query('select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const oldReport = async (db, node, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const roster_ = async (db, actor, user) => (await db.query('select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])).rows[0].r
const rows = async db => (await db.query('select vendor, account, plan, windows, seen_node from relay.asn_user_accounts order by vendor, account')).rows
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const NOW = Date.now()
const H = 3600_000, D = 24 * H
const G = { vendor: 'gemini', email: 'g@x.test', plan: 'Google AI Pro', current: true }
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

test('實跑（pglite）：共用案例全部（含 gemini）照預期', { skip }, async () => {
  const db = await setup()
  for (const c of cases.cases) {
    const r = (await db.query('select public.asn_relay_acct_window_judge($1, $2, $3::jsonb, $4::jsonb, $5::timestamptz) r',
      [c.vendor, c.window, c.old == null ? null : JSON.stringify(c.old), JSON.stringify(c.new), c.now])).rows[0].r
    assert.equal(r, c.reason, `${c.id} ${c.note}`)
  }
})

test('實跑（pglite）：權限、definer、search_path 跟套之前一樣；寫入函式仍是 definer', { skip }, async () => {
  const db = await setup({ apply: false })
  const before = await privs(db)
  await db.exec(mig)
  const after = await privs(db)
  assert.deepEqual(after, before)
  for (const [name, p] of Object.entries(after)) {
    assert.deepEqual([p.anon, p.authenticated, p.service_role], [false, false, true], name)
    assert.ok(p.config.some(x => /^search_path=(""|)$/.test(x)), `${name} ${p.config}`)
  }
  assert.equal(after.asn_relay_acct_roster_report.definer, true)
})

test('實跑（pglite）：gemini 寫入只收 five_hour、weekly；舊四欄不收；讀取照列、nodes 是空的', { skip }, async () => {
  const db = await setup()
  const AT = iso(NOW - 60_000)
  const r = await report(db, 'W', [{ ...G, five_hour_pct: 5, at: AT, windows: [win('five_hour', 97.7, iso(NOW + 2 * H), AT), win('w60', 50, null, AT), win('w10080', 40, null, AT), win('weekly', 30.1, iso(NOW + 3 * D), AT)] }])
  assert.deepEqual(r, { ok: true, count: 1, skipped: [] })
  const saved = await rows(db)
  assert.deepEqual(saved.map(x => [x.vendor, x.account, x.plan]), [['gemini', 'g@x.test', 'Google AI Pro']])
  assert.deepEqual(saved[0].windows.map(w => [w.name, w.left_pct]), [['five_hour', 98], ['weekly', 30]])
  await report(db, 'W', [{ ...G, email: 'g2@x.test', five_hour_pct: 5, at: AT }])
  assert.deepEqual((await rows(db)).find(x => x.account === 'g2@x.test').windows, [], 'gemini 沒帶 windows 不退回舊四欄')
  const mine = await roster_(db, 'H', U1)
  assert.deepEqual(mine.accounts.map(a => [a.vendor, a.account, a.nodes]), [['gemini', 'g2@x.test', []], ['gemini', 'g@x.test', []]])
})

test('實跑（pglite）：gemini 滿額遇滿額照收、滿額後開始用照收；之後來滿額更晚的不收', { skip }, async () => {
  const db = await setup()
  const R0 = NOW + 7 * D - 2 * H
  const step = async (pct, resetMs, readMs) => {
    const r = await report(db, 'W', [{ ...G, windows: [win('weekly', pct, iso(resetMs), iso(readMs))] }])
    return { skipped: r.skipped, w: (await rows(db))[0].windows[0] }
  }
  let s = await step(100, R0, NOW - 2 * H)
  assert.deepEqual([s.skipped, s.w.left_pct, s.w.resets_at], [[], 100, iso(R0)])
  s = await step(100, R0 + H, NOW - H)
  assert.deepEqual([s.skipped, s.w.left_pct, s.w.resets_at, s.w.read_at], [[], 100, iso(R0 + H), iso(NOW - H)], '滿額遇滿額：重置時間與讀取時間都更新')
  s = await step(95, R0 + 2 * H, NOW)
  assert.deepEqual([s.skipped, s.w.left_pct, s.w.resets_at], [[], 95, iso(R0 + 2 * H)], '滿額後開始用')
  s = await step(100, R0 + 3 * H, NOW)
  assert.deepEqual(s.skipped, [{ vendor: 'gemini', window: 'weekly', reason: 'later_not_expired' }], '記著非滿額、來滿額更晚的不收')
  assert.equal(s.w.left_pct, 95)
  s = await step(90, R0 + 2 * H, NOW)
  assert.deepEqual([s.skipped, s.w.left_pct], [[], 90], '同一期下降照收')
})

test('實跑（pglite）：claude、codex 不套滿額規則（行為跟套之前一樣）；舊回報函式照樣不收 gemini、原文不變', { skip }, async () => {
  const db0 = await setup({ apply: false })
  const oldDef = await fnDef(db0, 'asn_relay_acct_report')
  const db = await setup()
  assert.equal(await fnDef(db, 'asn_relay_acct_report'), oldDef)
  const R0 = NOW + 7 * D - 2 * H, AT = iso(NOW - H)
  for (const v of [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }, { vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true }]) {
    for (const d of [db0, db]) {
      await report(d, 'W', [{ ...v, windows: [win('weekly', 100, iso(R0), AT)] }])
      const r = await report(d, 'W', [{ ...v, windows: [win('weekly', 100, iso(R0 + H), iso(NOW))] }])
      assert.deepEqual(r.skipped, [{ vendor: v.vendor, window: 'weekly', reason: 'later_not_expired' }], v.vendor)
    }
  }
  assert.deepEqual(await rows(db), await rows(db0))
  assert.deepEqual(await oldReport(db, 'W', [G]), { error: 'bad_request' })
  assert.deepEqual(await report(db0, 'W', [G]), { error: 'bad_request' }, '套之前 gemini 整份不收')
})

test('實跑（pglite）：可重跑；回復後三支函式跟原版逐字相同、gemini 列刪掉、別的留著、約束不收 gemini', { skip }, async () => {
  const db0 = await setup({ apply: false })
  const defs0 = {}
  for (const n of Object.keys(FNS)) defs0[n] = await fnDef(db0, n)
  const db = await setup()
  const AT = iso(NOW - 60_000)
  await report(db, 'W', [G, { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: [win('weekly', 50, null, AT)] }])
  await db.exec(mig)
  assert.equal((await rows(db)).length, 2, '重跑不壞、資料還在')
  await db.exec(down)
  for (const n of Object.keys(FNS)) assert.equal(await fnDef(db, n), defs0[n], n)
  assert.deepEqual(await privs(db), await privs(db0))
  assert.deepEqual((await rows(db)).map(x => x.vendor), ['claude'])
  await assert.rejects(db.query(`insert into relay.asn_user_accounts (user_id, vendor, account) values ('${U1}', 'gemini', 'g@x.test')`))
})
