// 帳號列表第一批（#374，20261029100000_acct_roster.sql）：
// 1. 靜態：編號排在最新之後、舊的 asn_relay_acct_report／asn_relay_acct_quota／relay.asn_accounts 一字不動、只授權 service_role、沒有權杖類字樣。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：共用案例 tests/fixtures/quota-merge-cases.json 全跑、
//    權限、擁有者寫入／沒認領不寫／租戶不符不寫、舊四欄轉兩窗、兩台逐窗合併、A 讀不到 B、沒簽章 forbidden、30 天保留、上限、舊函式原文不變。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261029100000_acct_roster.sql'
const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read(FILE)
const down = fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/quota-merge-cases.json', import.meta.url), 'utf8'))

const FNS = [
  'asn_relay_acct_window_judge(text, text, jsonb, jsonb, timestamptz)', 'asn_relay_acct_iso(jsonb)',
  'asn_relay_acct_windows_clean(text, jsonb, text, timestamptz)', 'asn_relay_acct_legacy_windows(jsonb, text)',
  'asn_relay_acct_roster_report(text, jsonb)', 'asn_relay_acct_roster(text, uuid)',
]

test('靜態：編號在最新 migration 之後；舊函式與舊表一字不動；只授權 service_role；down 檔對應', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.includes(FILE) && FILE > '20261029000000_legacy_env_throttle.sql')
  assert.doesNotMatch(mig, /function public\.asn_relay_acct_report\(|function public\.asn_relay_acct_quota\(|alter table relay\.asn_accounts|insert into relay\.asn_accounts|update relay\.asn_accounts/)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /token|credential|secret|password/i)
  for (const f of FNS) {
    assert.ok(mig.includes(`revoke all on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(mig.includes(`grant execute on function public.${f} to service_role;`), f)
    assert.ok(down.includes(`drop function if exists public.${f};`), f)
  }
  assert.match(mig, /alter table relay\.asn_user_accounts enable row level security;/)
  assert.match(mig, /revoke all on relay\.asn_user_accounts from public, anon, authenticated;/)
  assert.doesNotMatch(mig, /create policy/i)
  assert.match(down, /drop table if exists relay\.asn_user_accounts;/)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

test('共用案例檔：格式完整（之後 Rust 用 include_str! 讀同一份）', () => {
  assert.ok(Array.isArray(cases.doc) && cases.doc.length > 0)
  assert.deepEqual(Object.keys(cases.reasons).sort(), ['earlier', 'later_not_expired', 'not_week_multiple', 'reset_out_of_range', 'same_period_rise'])
  assert.ok(cases.cases.length >= 15)
  const ids = new Set()
  for (const c of cases.cases) {
    assert.ok(!ids.has(c.id), c.id); ids.add(c.id)
    assert.ok(['claude', 'codex', 'gemini'].includes(c.vendor) && ['five_hour', 'weekly'].includes(c.window), c.id)
    assert.equal(c.accept, c.reason === null, c.id)
    if (c.reason) assert.ok(c.reason in cases.reasons, c.id)
  }
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', owner_user uuid, bell_topic text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}'), ('${T2}', '${U2}');
    -- U1：W、H 兩台；M＝同租戶沒認領；Z＝節點記 U1 但租戶是 U2 的（租戶不符）；U2：X
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values
      ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('H', '${T1}', 'owner', '${U1}', 'bell-H'), ('M', '${T1}', 'member', null, 'bell-M'),
      ('Z', '${T2}', 'member', '${U1}', 'bell-Z'), ('X', '${T2}', 'owner', '${U2}', 'bell-X');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  const oldDef = await fnDef(db, 'asn_relay_acct_report')
  const oldQuota = await fnDef(db, 'asn_relay_acct_quota')
  await db.exec(mig)
  return { db, oldDef, oldQuota }
}
const fnDef = async (db, name) => (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).rows.map(r => r.d).join('\n')
const report = async (db, node, rows) => (await db.query('select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const oldReport = async (db, node, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const roster = async (db, actor, user) => (await db.query('select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])).rows[0].r
const rows = async db => (await db.query('select user_id, vendor, account, plan, windows, seen_node from relay.asn_user_accounts order by user_id, vendor, account')).rows
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const NOW = Date.now()
const AT = iso(NOW - 5 * 60_000)
const H = 3600_000, D = 24 * H
const C = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }
const win = (name, left_pct, resets_at, read_at = AT) => ({ name, left_pct, resets_at, read_at })

// gemini 的案例要套 20261029130000_acct_roster_gemini.sql 才對（滿額規則在那支），在 tests/acct_roster_gemini_sql.test.mjs 跑全部案例
test('實跑（pglite）：共用案例全部照預期（同一份案例檔；gemini 的見 acct_roster_gemini_sql）', { skip }, async () => {
  const { db } = await setup()
  for (const c of cases.cases.filter(x => x.vendor !== 'gemini')) {
    const r = (await db.query('select public.asn_relay_acct_window_judge($1, $2, $3::jsonb, $4::jsonb, $5::timestamptz) r',
      [c.vendor, c.window, c.old == null ? null : JSON.stringify(c.old), JSON.stringify(c.new), c.now])).rows[0].r
    assert.equal(r, c.reason, `${c.id} ${c.note}`)
  }
})

test('實跑（pglite）：權限——RLS 開、沒有 policy、anon／authenticated 無權；寫讀兩支 definer、search_path 空', { skip }, async () => {
  const { db } = await setup()
  const t = (await db.query(`select relrowsecurity from pg_class where oid = 'relay.asn_user_accounts'::regclass`)).rows[0]
  assert.equal(t.relrowsecurity, true)
  assert.equal((await db.query(`select count(*)::int n from pg_policy where polrelid = 'relay.asn_user_accounts'::regclass`)).rows[0].n, 0)
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['select', 'insert', 'update', 'delete']) {
      assert.equal((await db.query(`select has_table_privilege($1, 'relay.asn_user_accounts', $2) v`, [role, priv])).rows[0].v, false, `${role} ${priv}`)
    }
    for (const f of FNS) assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${f}`])).rows[0].v, false, `${role} ${f}`)
  }
  for (const f of FNS) assert.equal((await db.query(`select has_function_privilege('service_role', $1, 'execute') v`, [`public.${f}`])).rows[0].v, true, f)
  for (const name of ['asn_relay_acct_roster_report', 'asn_relay_acct_roster']) {
    const p = (await db.query(`select prosecdef, proconfig from pg_proc where proname = $1`, [name])).rows[0]
    assert.equal(p.prosecdef, true, name)
    assert.ok(p.proconfig.some(x => /^search_path=(""|)$/.test(x)), `${name} ${p.proconfig}`)
  }
})

test('實跑（pglite）：擁有者寫入；沒認領、租戶不符、不存在的節點都不寫；格式壞整份不寫', { skip }, async () => {
  const { db } = await setup()
  const r = await report(db, 'W', [{ ...C, windows: [win('five_hour', 61.6, iso(NOW + 2 * H)), win('weekly', 80, iso(NOW + 3 * D))] }])
  assert.deepEqual(r, { ok: true, count: 1, skipped: [] })
  const saved = await rows(db)
  assert.equal(saved.length, 1)
  assert.deepEqual({ ...saved[0], windows: undefined }, { user_id: U1, vendor: 'claude', account: 'a@x.test', plan: 'max', windows: undefined, seen_node: 'W' })
  assert.deepEqual(saved[0].windows, [
    { name: 'five_hour', left_pct: 62, resets_at: iso(NOW + 2 * H), read_at: AT, read_node: 'W' },
    { name: 'weekly', left_pct: 80, resets_at: iso(NOW + 3 * D), read_at: AT, read_node: 'W' },
  ])
  for (const node of ['M', 'Z', 'NOPE']) assert.deepEqual(await report(db, node, [C]), { error: 'not_claimed' }, node)
  for (const bad of [[{ ...C, email: 'Bad@X' }], [{ ...C, vendor: 'gemini' }], Array.from({ length: 21 }, () => C), { a: 1 }]) {
    assert.deepEqual(await report(db, 'W', bad), { error: 'bad_request' })
  }
  assert.equal((await rows(db)).length, 1)
})

test('實跑（pglite）：壞的單窗丟掉、不退回整份；grok 一律不收額度；Codex w300／w10080 轉成兩窗名；未來時間不收', { skip }, async () => {
  const { db } = await setup()
  await report(db, 'W', [
    { ...C, windows: [win('five_hour', 101, null), win('weekly', '50', null), win('bad name', 5, null), win('weekly', 50, '壞掉'),
      win('weekly', 50, null, iso(NOW + 30 * 60_000)), { name: 'five_hour', left_pct: 5 }, win('five_hour', 20, null), win('five_hour', 10, null)] },
    { vendor: 'grok', email: 'g@x.test', plan: '', current: false, windows: [win('weekly', 50, null)], five_hour_pct: 5, at: AT },
    { vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true, windows: [win('w300', 70, null), win('w10080', 40, null), win('w60', 9, null)] },
  ])
  const byKey = Object.fromEntries((await rows(db)).map(r => [r.vendor, r.windows]))
  assert.deepEqual(byKey.claude, [{ name: 'five_hour', left_pct: 20, resets_at: null, read_at: AT, read_node: 'W' }], '壞的丟、同名留第一個')
  assert.deepEqual(byKey.grok, [])
  assert.deepEqual(byKey.codex.map(w => w.name), ['five_hour', 'weekly', 'w60'])
})

test('實跑（pglite）：舊版四欄照 stored_resets 反推成兩窗', { skip }, async () => {
  const { db } = await setup()
  const R = iso(NOW + 2 * H)
  const one = async (q, email) => { await report(db, 'W', [{ ...C, email, at: AT, ...q }]); return (await rows(db)).find(r => r.account === email).windows.map(w => [w.name, w.left_pct, w.resets_at]) }
  assert.deepEqual(await one({ five_hour_pct: 60, weekly_pct: 30, reset_at: R }, 'a1@x.test'), [['five_hour', 60, R], ['weekly', 30, null]])
  assert.deepEqual(await one({ five_hour_pct: 50, weekly_pct: 0, reset_at: R }, 'a2@x.test'), [['five_hour', 50, null], ['weekly', 0, R]])
  assert.deepEqual(await one({ five_hour_pct: 0, weekly_pct: 0, reset_at: R }, 'a3@x.test'), [['five_hour', 0, null], ['weekly', 0, null]])
  assert.deepEqual(await one({ weekly_pct: 70, reset_at: R }, 'a4@x.test'), [['weekly', 70, R]])
  assert.deepEqual(await one({ five_hour_pct: 70 }, 'a5@x.test'), [['five_hour', 70, null]])
  assert.deepEqual(await one({ five_hour_pct: 70, at: undefined }, 'a6@x.test'), [], '沒有 at 整組不收（跟舊的 asn_relay_acct_quota 一樣）')
  // 帶了 windows 就不看舊四欄；codex 的舊四欄不收
  await report(db, 'W', [{ ...C, email: 'a7@x.test', five_hour_pct: 1, at: AT, windows: [win('weekly', 9, null)] }, { vendor: 'codex', email: 'c@x.test', five_hour_pct: 5, at: AT }])
  const all = await rows(db)
  assert.deepEqual(all.find(r => r.account === 'a7@x.test').windows.map(w => w.name), ['weekly'])
  assert.deepEqual(all.find(r => r.account === 'c@x.test').windows, [])
})

test('實跑（pglite）：兩台逐窗合併；同期回升不收並回原因代碼（不含 email）；沒帶的窗留著', { skip }, async () => {
  const { db } = await setup()
  const R5 = iso(NOW + 2 * H), RW = iso(NOW + 3 * D)
  await report(db, 'W', [{ ...C, windows: [win('five_hour', 40, R5)] }])
  await report(db, 'H', [{ ...C, plan: '', windows: [win('weekly', 70, RW)] }])
  let w = (await rows(db))[0]
  assert.deepEqual(w.windows.map(x => [x.name, x.left_pct, x.read_node]), [['five_hour', 40, 'W'], ['weekly', 70, 'H']])
  assert.equal(w.plan, 'max', '空的方案不覆寫'); assert.equal(w.seen_node, 'H')
  const r = await report(db, 'H', [{ ...C, windows: [win('five_hour', 90, R5), win('weekly', 60, RW)] }])
  assert.deepEqual(r, { ok: true, count: 1, skipped: [{ vendor: 'claude', window: 'five_hour', reason: 'same_period_rise' }] })
  assert.ok(!JSON.stringify(r).includes('@'))
  w = (await rows(db))[0]
  assert.deepEqual(w.windows.map(x => [x.name, x.left_pct, x.read_node]), [['five_hour', 40, 'W'], ['weekly', 60, 'H']])
  // 較早的不收；現記的還沒過卻來更晚的不收
  const r2 = await report(db, 'W', [{ ...C, windows: [win('five_hour', 10, iso(NOW - 3 * H)), win('weekly', 99, iso(NOW + 5 * D))] }])
  assert.deepEqual(r2.skipped.map(s => s.reason), ['earlier', 'later_not_expired'])
})

test('實跑（pglite）：重置時間不在「現在 −1 天～+8 天」的窗丟掉；已存 2099 年的會被正常回報解開（#524 審查）', { skip }, async () => {
  const { db } = await setup()
  const FAR = '2099-01-01T00:00:00Z', RW = iso(NOW + 3 * D)
  // 新版 windows：2099 年那窗清理時就丟掉，不會存進去；同一份裡正常的那窗照收
  const r = await report(db, 'W', [{ ...C, windows: [win('weekly', 10, FAR), win('five_hour', 40, iso(NOW + 9 * D)), win('five_hour', 50, iso(NOW + 2 * H))] }])
  assert.deepEqual(r, { ok: true, count: 1, skipped: [] })
  assert.deepEqual((await rows(db))[0].windows.map(w => [w.name, w.left_pct]), [['five_hour', 50]])
  // 之後正常的每週回報照收
  await report(db, 'H', [{ ...C, windows: [win('weekly', 70, RW)] }])
  assert.deepEqual((await rows(db))[0].windows.map(w => [w.name, w.left_pct]), [['five_hour', 50], ['weekly', 70]])
  // 舊版四欄帶 2099 年：清理不經 windows_clean，由判斷擋下並回原因代碼
  const r2 = await report(db, 'W', [{ ...C, weekly_pct: 5, reset_at: FAR, at: AT }])
  assert.deepEqual(r2.skipped, [{ vendor: 'claude', window: 'weekly', reason: 'reset_out_of_range' }])
  assert.equal((await rows(db))[0].windows.find(w => w.name === 'weekly').left_pct, 70)
  // 已經存了 2099 年（例如舊版判斷時收進來的）：正常的回報照收，鎖住的解開
  await db.query(`update relay.asn_user_accounts set windows = jsonb_build_array(jsonb_build_object(
    'name', 'weekly', 'left_pct', 40, 'resets_at', '${FAR}', 'read_at', '${AT}', 'read_node', 'W'))`)
  const r3 = await report(db, 'H', [{ ...C, windows: [win('weekly', 90, RW)] }])
  assert.deepEqual(r3.skipped, [])
  assert.deepEqual((await rows(db))[0].windows.map(w => [w.name, w.left_pct, w.resets_at]), [['weekly', 90, RW]])
})

test('實跑（pglite）：windows 清完一窗都不剩時 Claude 退回舊四欄；回報順序不影響結果；migration 可以重跑（#524 審查）', { skip }, async () => {
  const { db } = await setup()
  await report(db, 'W', [{ ...C, five_hour_pct: 60, reset_at: iso(NOW + 2 * H), at: AT, windows: [win('weekly', 10, '2099-01-01T00:00:00Z')] }])
  assert.deepEqual((await rows(db))[0].windows.map(w => [w.name, w.left_pct]), [['five_hour', 60]])
  // 兩個帳號、兩種順序：都照 (廠牌, email) 的順序處理，結果一樣
  const B = { ...C, email: 'b@x.test', windows: [win('weekly', 30, iso(NOW + 3 * D))] }
  const A = { ...C, windows: [win('weekly', 20, iso(NOW + 3 * D))] }
  const r = await report(db, 'H', [B, A])
  assert.deepEqual(r, { ok: true, count: 2, skipped: [] })
  assert.deepEqual((await rows(db)).map(x => [x.account, x.windows.find(w => w.name === 'weekly').left_pct]), [['a@x.test', 20], ['b@x.test', 30]])
  await db.exec(mig)
  assert.equal((await rows(db)).length, 2, '重跑不壞、資料還在')
})

test('實跑（pglite）：讀取只回自己的；A 讀不到 B；沒簽章或簽章不是這台的主人 forbidden；附哪幾台在用', { skip }, async () => {
  const { db } = await setup()
  await oldReport(db, 'W', [C, { vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true }])
  await oldReport(db, 'H', [{ ...C, current: false }])
  await report(db, 'W', [{ ...C, windows: [win('weekly', 50, null)] }, { vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true }])
  await report(db, 'X', [{ ...C, email: 'b@x.test' }])
  const mine = await roster(db, 'H', U1)
  assert.match(mine.now, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  assert.deepEqual(mine.accounts.map(a => [a.vendor, a.account]), [['claude', 'a@x.test'], ['codex', 'c@x.test']])
  const a = mine.accounts[0]
  assert.deepEqual(a.nodes.map(n => [n.node, n.current]), [['H', false], ['W', true]])
  assert.equal(a.windows[0].left_pct, 50); assert.equal(a.seen_node, 'W')
  assert.deepEqual(mine.accounts[1].windows, [], '沒資料＝空陣列，前端分得出')
  const other = await roster(db, 'X', U2)
  assert.deepEqual(other.accounts.map(x => x.account), ['b@x.test'])
  assert.deepEqual(other.accounts[0].nodes, [])
  for (const [actor, user] of [['H', null], ['X', U1], ['W', U2], ['M', U1], ['Z', U1]]) assert.deepEqual(await roster(db, actor, user), { error: 'forbidden' }, `${actor} ${user}`)
})

test('實跑（pglite）：所有電腦都不再回報的帳號保留 30 天，超過不列；每人最多 100 筆刪最舊的', { skip }, async () => {
  const { db } = await setup()
  await report(db, 'W', [{ ...C, email: 'old29@x.test' }, { ...C, email: 'old31@x.test' }])
  await db.query(`update relay.asn_user_accounts set seen_at = now() - interval '29 days' where account = 'old29@x.test'`)
  await db.query(`update relay.asn_user_accounts set seen_at = now() - interval '31 days' where account = 'old31@x.test'`)
  assert.deepEqual((await roster(db, 'W', U1)).accounts.map(a => a.account), ['old29@x.test'])
  await db.query(`insert into relay.asn_user_accounts (user_id, vendor, account, seen_at)
    select '${U1}', 'codex', 'n' || g || '@x.test', now() - interval '1 day' - g * interval '1 minute' from generate_series(1, 98) g`)
  await db.query(`insert into relay.asn_user_accounts (user_id, vendor, account) values ('${U2}', 'claude', 'u2@x.test')`)
  assert.deepEqual(await report(db, 'W', [{ ...C, email: 'new@x.test' }]), { ok: true, count: 1, skipped: [] })
  const left = (await db.query(`select account from relay.asn_user_accounts where user_id = '${U1}'`)).rows.map(r => r.account)
  assert.equal(left.length, 100)
  assert.ok(left.includes('new@x.test') && left.includes('old29@x.test'))
  assert.ok(!left.includes('old31@x.test'), '最舊的刪掉')
  assert.equal((await db.query(`select count(*)::int n from relay.asn_user_accounts where user_id = '${U2}'`)).rows[0].n, 1, '別人的不受影響')
})

test('實跑（pglite）：舊的 asn_relay_acct_report／asn_relay_acct_quota 原文不變、行為照舊', { skip }, async () => {
  const { db, oldDef, oldQuota } = await setup()
  assert.ok(oldDef.length > 100)
  assert.equal(await fnDef(db, 'asn_relay_acct_report'), oldDef)
  assert.equal(await fnDef(db, 'asn_relay_acct_quota'), oldQuota)
  assert.deepEqual(await oldReport(db, 'W', [{ ...C, windows: [win('weekly', 5, null)] }]), { ok: true, count: 1 })
  assert.deepEqual((await db.query(`select accounts from relay.asn_accounts where node = 'W'`)).rows[0].accounts, [C])
})
