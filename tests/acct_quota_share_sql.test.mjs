// 額度查詢的後台（20261105100000_acct_quota_share.sql，todo-next-193）：
// 1. 靜態：三支既有函式除了明列的片段，與現行本體逐字相同；只授權 service_role；回復檔換回現行本體。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    舊用戶端回報與 roster 不變；grok 只收每週、minimax 只收 5 小時與每週；舊的 asn_relay_acct_report 不收 minimax；
//    沒開代碼查不到；開了查得到且不含 email；撤銷、重開後舊代碼失效；只有本人能開；超過 30 天不回；次數限制；回復後回到原狀。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261105100000_acct_quota_share.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(FILE)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const gem = read('20261029130000_acct_roster_gemini.sql')
const flags = read('20261031100000_acct_login_flags.sql')
const reset = read('20261030100000_acct_reset_times.sql')
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const body = (sql, name) => { const s = sql.indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', s) + 11) }
const swap = (t, a, b) => { assert.ok(t.includes(a), a); return t.replace(a, () => b) }
const SIGS = {
  asn_relay_acct_window_judge: 'text, text, jsonb, jsonb, timestamptz', asn_relay_acct_windows_clean: 'text, jsonb, text, timestamptz', asn_relay_acct_roster_report: 'text, jsonb', asn_relay_acct_roster: 'text, uuid',
  asn_relay_quota_read: 'text, text', asn_relay_acct_share_set: 'text, uuid, text, text, text',
}

test('靜態：既有函式只改明列的片段；只授權 service_role；回復檔換回現行本體', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261104190000_owner_mail_phone.sql'))
  assert.equal(swap(body(mig, 'asn_relay_acct_window_judge'), "p_vendor in ('gemini', 'minimax') and p_old", "p_vendor = 'gemini' and p_old"), body(gem, 'asn_relay_acct_window_judge'))
  assert.equal(body(down, 'asn_relay_acct_window_judge'), body(gem, 'asn_relay_acct_window_judge'))
  let c = swap(body(mig, 'asn_relay_acct_windows_clean'), "'gemini', 'grok', 'minimax') or", "'gemini') or")
  c = swap(c, "    -- MiniMax 只有 5 小時與每週、Grok 只有每週\n    continue when p_vendor = 'minimax' and v_name not in ('five_hour', 'weekly');\n    continue when p_vendor = 'grok' and v_name <> 'weekly';\n", '')
  assert.equal(c, body(gem, 'asn_relay_acct_windows_clean'))
  let r = swap(body(mig, 'asn_relay_acct_roster_report'), "'gemini', 'minimax')\n       or not public", "'gemini')\n       or not public")
  r = swap(r, "    v_new := case\n      when v_row ? 'windows'", "    v_new := case\n      when v_vendor = 'grok' then '[]'::jsonb\n      when v_row ? 'windows'")
  r = swap(r, "if v_vendor in ('gemini', 'minimax') then\n      v_gemini := v_gemini || (v_vendor || chr(10) || v_email);", "if v_vendor = 'gemini' then\n      v_gemini := v_gemini || v_email;")
  r = swap(r, "u.vendor in ('gemini', 'minimax') and not ((u.vendor || chr(10) || u.account) = any(v_gemini))", "u.vendor = 'gemini' and not (u.account = any(v_gemini))")
  assert.equal(r, body(flags, 'asn_relay_acct_roster_report'))
  let l = swap(body(mig, 'asn_relay_acct_roster'), " 'shared', u.share_hash is not null,", '')
  l = l.replace("'seen_node', u.seen_node,\n", "'seen_node', u.seen_node,\n")
  l = swap(l, "case when u.vendor in ('gemini', 'minimax') then", "case when u.vendor = 'gemini' then")
  assert.equal(l, body(flags, 'asn_relay_acct_roster'))
  assert.equal(body(down, 'asn_relay_acct_windows_clean'), body(gem, 'asn_relay_acct_windows_clean'))
  assert.equal(body(down, 'asn_relay_acct_roster_report'), body(flags, 'asn_relay_acct_roster_report'))
  assert.equal(body(down, 'asn_relay_acct_roster'), body(flags, 'asn_relay_acct_roster'))
  for (const [name, args] of Object.entries(SIGS)) {
    assert.ok(mig.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`), name)
    assert.ok(mig.includes(`grant execute on function public.${name}(${args}) to service_role;`), name)
  }
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /drop table|truncate|delete from relay\.asn_user_accounts d?\s*where vendor/i)
  assert.doesNotMatch(body(mig, 'asn_relay_quota_read'), /email|\baccount\b/i, '查詢不回 email 與帳號，內部條件也不用')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const IP = 'c'.repeat(64)
const CODE = 'a'.repeat(64)
const CODE2 = 'b'.repeat(64)

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
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('H', '${T1}', 'owner', '${U1}', 'bell-H'), ('M', '${T2}', 'member', '${U2}', 'bell-M');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  for (const f of [roster, lock, gem, reset, flags]) await db.exec(f)
  if (apply) await db.exec(mig)
  return db
}
const one = async (db, sql, args) => (await db.query(sql, args)).rows[0].r
const report = (db, node, rows) => one(db, 'select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])
const oldReport = (db, node, rows) => one(db, 'select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])
const rosterOf = (db, actor, user) => one(db, 'select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])
const read_ = (db, code, ip = IP) => one(db, 'select public.asn_relay_quota_read($1, $2) r', [ip, code])
const share = (db, actor, user, vendor, account, code) => one(db, 'select public.asn_relay_acct_share_set($1, $2::uuid, $3, $4, $5) r', [actor, user, vendor, account, code])
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const NOW = Date.now()
const H = 3600_000, D = 24 * H
const AT = iso(NOW - 60_000), R5 = iso(NOW + 2 * H), RW = iso(NOW + 3 * D)
const win = (name, left_pct, resets_at = RW, read_at = AT) => ({ name, left_pct, resets_at, read_at })
const CLAUDE = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, windows: [win('five_hour', 40, R5), win('weekly', 70)] }

test('實跑：舊用戶端照舊；grok、minimax 的窗只收該收的；舊函式不收 minimax', { skip }, async () => {
  const db = await setup()
  assert.equal((await report(db, 'W', [CLAUDE, { vendor: 'grok', email: 'g@x.test', plan: '', current: true }])).ok, true)
  let got = (await rosterOf(db, 'H', U1)).accounts
  assert.deepEqual(got.map(a => [a.vendor, a.account, a.windows.length, a.shared]), [['claude', 'a@x.test', 2, false], ['grok', 'g@x.test', 0, false]])
  assert.equal(got[0].plan, 'max')
  assert.deepEqual(await oldReport(db, 'W', [{ vendor: 'minimax', email: 'm@x.test', plan: '', current: false }]), { error: 'bad_request' })
  await report(db, 'W', [
    { vendor: 'grok', email: 'g@x.test', current: true, windows: [win('five_hour', 1), win('weekly', 50)] },
    { vendor: 'minimax', email: 'm@x.test', current: true, windows: [win('w60', 1), win('five_hour', 20, R5), win('weekly', 60)] },
  ])
  got = (await rosterOf(db, 'H', U1)).accounts
  assert.deepEqual(got.find(a => a.vendor === 'grok').windows.map(w => w.name), ['weekly'])
  const mm = got.find(a => a.vendor === 'minimax')
  assert.deepEqual(mm.windows.map(w => w.name), ['five_hour', 'weekly'])
  assert.deepEqual(mm.nodes.map(n => [n.node, n.current]), [['W', true]], 'minimax 記哪台在用')
  // 這台不再回報那個帳號：拿掉這台那一格；同 email 的 gemini 不受影響
  await report(db, 'W', [{ vendor: 'gemini', email: 'm@x.test', current: true, windows: [win('weekly', 60)] }])
  got = (await rosterOf(db, 'H', U1)).accounts
  assert.deepEqual(got.find(a => a.vendor === 'minimax').nodes, [])
  assert.equal(got.find(a => a.vendor === 'gemini').nodes.length, 1)
})

test('實跑：沒開代碼查不到；開了查得到且不含 email；重開、撤銷後舊代碼失效；只有本人能開', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', [CLAUDE])
  assert.deepEqual(await read_(db, CODE), { record: null })
  assert.deepEqual(await share(db, 'M', U2, 'claude', 'a@x.test', CODE), { error: 'not_found' }, '別人的帳號動不到')
  assert.deepEqual(await share(db, 'W', U2, 'claude', 'a@x.test', CODE), { error: 'forbidden' }, '節點不是他的')
  assert.deepEqual(await read_(db, CODE), { record: null })
  assert.deepEqual(await share(db, 'W', U1, 'claude', 'a@x.test', 'NOT-A-HASH'), { error: 'bad_request' })
  assert.deepEqual(await share(db, 'W', U1, 'claude', 'nobody@x.test', CODE), { error: 'not_found' })
  assert.deepEqual(await share(db, 'W', U1, 'claude', 'a@x.test', CODE), { ok: true })
  const r = await read_(db, CODE)
  assert.deepEqual(Object.keys(r.record).sort(), ['plan', 'vendor', 'windows'])
  assert.equal(r.record.vendor, 'claude')
  assert.ok(!JSON.stringify(r).includes('a@x.test'))
  assert.equal((await rosterOf(db, 'H', U1)).accounts[0].shared, true)
  assert.ok(!JSON.stringify(await rosterOf(db, 'H', U1)).includes(CODE), 'roster 不回代碼')
  assert.deepEqual(await share(db, 'W', U1, 'claude', 'a@x.test', CODE2), { ok: true })
  assert.deepEqual(await read_(db, CODE), { record: null }, '重開後舊代碼失效')
  assert.equal((await read_(db, CODE2)).record.vendor, 'claude')
  assert.deepEqual(await share(db, 'W', U1, 'claude', 'a@x.test', null), { ok: true })
  assert.deepEqual(await read_(db, CODE2), { record: null }, '撤銷後失效')
  assert.equal((await rosterOf(db, 'H', U1)).accounts[0].shared, false)
  assert.deepEqual(await read_(db, 'short'), { error: 'bad_request' })
  // 超過 30 天沒回報：畫面看不到，查詢也不回
  await share(db, 'W', U1, 'claude', 'a@x.test', CODE)
  await db.exec(`update relay.asn_user_accounts set seen_at = now() - interval '31 days'`)
  assert.deepEqual(await read_(db, CODE), { record: null })
})

test('實跑：MiniMax 沒用過的窗重置時間一直往後跑，開始用之後新數字要收；用過的窗照一般規則', { skip }, async () => {
  const db = await setup()
  const left = async () => (await rosterOf(db, 'H', U1)).accounts[0].windows[0]
  const R1 = iso(NOW + 5 * H), R2 = iso(NOW + 5 * H + 30 * 60_000), R3 = iso(NOW + 5 * H + 60 * 60_000)
  const send = (pct, reset) => report(db, 'W', [{ vendor: 'minimax', email: 'm@x.test', windows: [win('five_hour', pct, reset)] }])
  await send(100, R1)
  assert.deepEqual((await send(100, R2)).skipped, [], '滿額遇滿額照收')
  assert.equal((await left()).resets_at, R2)
  assert.deepEqual((await send(91, R3)).skipped, [], '開始用了，重置時間較晚也要收')
  assert.equal((await left()).left_pct, 91)
  const later = await send(80, iso(NOW + 6 * H + 60 * 60_000))
  assert.deepEqual(later.skipped.map(s => s.reason), ['later_not_expired'], '用過之後照一般規則')
  assert.equal((await left()).left_pct, 91)
  assert.deepEqual((await send(95, R3)).skipped.map(s => s.reason), ['same_period_rise'])
})

test('實跑：次數限制分來源計算；舊的計數列會清掉；權限只給 service_role', { skip }, async () => {
  const db = await setup()
  await report(db, 'W', [CLAUDE])
  await share(db, 'W', U1, 'claude', 'a@x.test', CODE)
  const A = 'd'.repeat(64), B = 'e'.repeat(64)
  for (let i = 0; i < 30; i++) assert.deepEqual(await read_(db, CODE2, A), { record: null })
  assert.deepEqual(await read_(db, CODE, A), { error: 'rate_limited' }, '查不到太多次，這個來源先停')
  assert.equal((await read_(db, CODE, B)).record.vendor, 'claude', '別的來源不受影響')
  await db.exec(`update relay.asn_quota_read_hits set hits = 600 where ip_hash = '${B}'`)
  assert.deepEqual(await read_(db, CODE, B), { error: 'rate_limited' })
  await db.exec(`insert into relay.asn_quota_read_hits(ip_hash, bucket, hits) values ('old', now() - interval '3 hours', 1), ('recent', date_trunc('hour', now()), 1)`)
  await read_(db, CODE, IP)
  const keys = (await db.query('select ip_hash from relay.asn_quota_read_hits')).rows.map(r => r.ip_hash)
  assert.ok(!keys.includes('old') && keys.includes('recent'))
  for (const [name, args] of Object.entries(SIGS)) {
    for (const [role, want] of [['anon', false], ['authenticated', false], ['service_role', true]]) {
      assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${name}(${args})`])).rows[0].v, want, `${name} ${role}`)
    }
  }
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_table_privilege($1, 'relay.asn_quota_read_hits', 'select') v`, [role])).rows[0].v, false)
  }
})

test('實跑：可重跑；回復後代碼與 minimax 消失、grok 的窗清空、函式回到原本體、舊回報正常', { skip }, async () => {
  const db = await setup()
  await db.exec(mig)
  await report(db, 'W', [CLAUDE, { vendor: 'grok', email: 'g@x.test', windows: [win('weekly', 50)] }, { vendor: 'minimax', email: 'm@x.test', windows: [win('weekly', 60)] }])
  await share(db, 'W', U1, 'claude', 'a@x.test', CODE)
  await db.exec(down)
  const cols = (await db.query(`select column_name c from information_schema.columns where table_schema = 'relay' and table_name = 'asn_user_accounts'`)).rows.map(r => r.c)
  assert.ok(!cols.includes('share_hash') && !cols.includes('share_created_at'))
  const fns = (await db.query(`select proname r from pg_proc where proname in ('asn_relay_quota_read', 'asn_relay_acct_share_set')`)).rows
  assert.equal(fns.length, 0)
  const got = (await rosterOf(db, 'H', U1)).accounts
  assert.deepEqual(got.map(a => a.vendor), ['claude', 'grok'])
  assert.deepEqual(got[1].windows, [])
  assert.equal(got[0].windows.length, 2, 'claude 的窗留著')
  assert.ok(!('shared' in got[0]))
  assert.deepEqual(await report(db, 'W', [{ vendor: 'minimax', email: 'm@x.test' }]), { error: 'bad_request' })
  assert.equal((await report(db, 'W', [CLAUDE])).ok, true)
  await assert.rejects(db.exec(`insert into relay.asn_user_accounts(user_id, vendor, account) values ('${U1}', 'minimax', 'z@x.test')`))
})
