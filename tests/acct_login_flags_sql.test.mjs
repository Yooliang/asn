// 登入失效通知的後台（0.1.113）：
//   20261031100000_acct_login_flags.sql  帳號回報多收 login_failed／login_incomplete（舊回報、名單寫入、名單讀出三支函式）
//   20261031110000_acct_login_alert_notify.sql  獨立區塊：橋接程式寄通知信給「節點自己的擁有者」的 asn_relay_login_alert
// 1. 靜態：只換函式本體、簽章不變、ACL 只給 service_role、回復檔換回現行本體。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    兩欄寫入後讀得出；舊格式（不帶）照樣能寫且預設 false；型別不對整份退回且不寫；恢復後旗標消失；
//    既有欄位（email、plan、current、額度、重置時間、gemini）都還在；權限與改前相同。
//    寄信函式：收件人一定是節點擁有者的人代號、只收固定欄位、超過限流被拒、不是自己的節點被拒、欄位不合不寄。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F1 = '20261031100000_acct_login_flags.sql'
const F2 = '20261031110000_acct_login_alert_notify.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const readDown = f => rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${f.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const mig = read(F1), alert = read(F2), down1 = readDown(F1), down2 = readDown(F2)
const grok = read('20261026200000_acct_vendor_grok.sql')
const reset = read('20261030100000_acct_reset_times.sql')
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const gem = read('20261029130000_acct_roster_gemini.sql')
const replyToPerson = read('20261023140000_reply_to_person.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const FNS = {
  asn_relay_acct_report: 'asn_relay_acct_report(text, jsonb)',
  asn_relay_acct_roster_report: 'asn_relay_acct_roster_report(text, jsonb)',
  asn_relay_acct_roster: 'asn_relay_acct_roster(text, uuid)',
}
const ALERT_SIG = 'asn_relay_login_alert(text, text, timestamptz, text, integer)'
const body = (sql, name) => { const s = sql.toLowerCase().indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', sql.toLowerCase().indexOf('$function$', s) + 5) + 11) }

const FLAG_BOOL = /\n       or \(v_row \? 'login_failed' and jsonb_typeof\(v_row->'login_failed'\) <> 'boolean'\)\n       or \(v_row \? 'login_incomplete' and jsonb_typeof\(v_row->'login_incomplete'\) <> 'boolean'\)/
const FLAG_CASE = /\n *\|\| case when v_row->'login_failed' = 'true'::jsonb then jsonb_build_object\('login_failed', true\) else '\{\}'::jsonb end\n *\|\| case when v_row->'login_incomplete' = 'true'::jsonb then jsonb_build_object\('login_incomplete', true\) else '\{\}'::jsonb end/
const FLAG_READ = /,\n *'login_failed', coalesce\(e->'login_failed' = 'true'::jsonb, false\), 'login_incomplete', coalesce\(e->'login_incomplete' = 'true'::jsonb, false\)\)/g
const unflag = t => t.replace(FLAG_BOOL, '').replace(FLAG_CASE, '').replace("select (jsonb_build_object('node', p_node", "select jsonb_build_object('node', p_node").replace("Z\"'))) e, 0::bigint k", "Z\"')) e, 0::bigint k").replace(FLAG_READ, ')')

test('靜態：旗標 migration 只換三支函式本體、簽章不變、只授權 service_role；回復檔換回現行本體', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F1) > files.indexOf('20261030100000_acct_reset_times.sql'), '編號在重置時間之後')
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 3)
  assert.doesNotMatch(mig, /create or replace function public\.asn_relay_acct_quota/i, '額度函式沒動')
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down1]) {
    for (const sig of Object.values(FNS)) {
      assert.ok(f.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig)
      assert.ok(f.includes(`grant execute on function public.${sig} to service_role;`), sig)
    }
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  // 簽章行、security definer 設定與現行版相同
  const cur = { asn_relay_acct_report: grok, asn_relay_acct_roster_report: reset, asn_relay_acct_roster: reset }
  for (const [name, src] of Object.entries(cur)) {
    const a = body(mig, name), b = body(src, name)
    assert.equal(a.split('\n')[0].toLowerCase(), b.split('\n')[0].toLowerCase(), name)
    assert.equal(/security definer/i.test(a), /security definer/i.test(b), name)
    assert.equal(a.match(/set search_path to ''/i)?.length, b.match(/set search_path to ''/i)?.length, name)
    assert.equal(body(down1, name), b, `${name} 回復檔＝現行本體逐字`)
    // 把新版的旗標片段逐段拿掉，必須與現行版逐字相同（既有欄位一個都沒少、其餘邏輯沒動）
    assert.equal(unflag(a), b, name + ' 去掉旗標片段後等於現行本體')
  }
})

test('靜態：寄信函式獨立成一支、只一個函式、無收件人參數、固定欄位、限流、只授權 service_role；回復檔只 drop 它', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F2) > files.indexOf(F1))
  assert.equal((alert.match(/^create or replace function/gim) ?? []).length, 1)
  assert.doesNotMatch(alert, /drop function|create table|drop table|alter table|create policy|truncate|insert into|update relay|delete from/i, '不直接寫表，寄信一律走 asn_relay_send')
  assert.doesNotMatch(alert, /grant [^;]*to (anon|authenticated|public)/)
  const sig = alert.match(/function public\.asn_relay_login_alert\(([^)]*)\)/)[1]
  assert.equal(sig, 'p_node text, p_computer text, p_last_at timestamptz, p_email text default null, p_timeouts integer default 0', '沒有收件人／內文／錯誤原文參數')
  assert.match(alert, /security definer/); assert.match(alert, /set search_path to ''/)
  assert.ok(alert.includes(`revoke all on function public.${ALERT_SIG} from public, anon, authenticated;`))
  assert.ok(alert.includes(`grant execute on function public.${ALERT_SIG} to service_role;`))
  assert.match(alert, /v_recent >= 3/)
  assert.match(alert, /pg_advisory_xact_lock/)
  // 既有寄信函式只認寄件節點所屬租戶擁有者的人代號（不一致回 unknown_to_node）
  assert.match(replyToPerson, /p_to_node ~ '\^u:\[0-9a-f\]\{12\}\$'[\s\S]{0,200}p_to_node <> v_alias[\s\S]{0,80}unknown_to_node/)
  assert.match(down2, /drop function if exists public\.asn_relay_login_alert\(text, text, timestamptz, text, integer\);/)
  assert.doesNotMatch(down2, /truncate|delete from|drop table/i)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
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
    insert into relay.tenants values ('${T1}', '${U1}');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('H', '${T1}', 'owner', '${U1}', 'bell-H'), ('Q', '${T1}', 'member', '${U1}', 'bell-Q'),
      ('M', '${T1}', 'member', '${U2}', 'bell-M');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  await db.exec(roster); await db.exec(lock); await db.exec(gem); await db.exec(reset)
  if (apply) await db.exec(mig)
  return db
}
const fnDef = async (db, name) => (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).rows.map(r => r.d).join('\n')
const overloads = async (db, name) => (await db.query(`select count(*)::int c from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).rows[0].c
const report = async (db, node, rows) => (await db.query('select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const oldReport = async (db, node, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const list = async (db, actor, node) => (await db.query('select public.asn_relay_acct_list($1, $2) r', [actor, node])).rows[0].r
const rosterOf = async (db, actor, user) => (await db.query('select public.asn_relay_acct_roster($1, $2::uuid) r', [actor, user])).rows[0].r
const iso = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
const NOW = Date.now()
const H = 3600_000, D = 24 * H
const win = (name, left_pct, resets_at, read_at) => ({ name, left_pct, resets_at, read_at })
const privs = async db => {
  const out = {}
  for (const [name, sig] of Object.entries({ ...FNS, asn_relay_acct_quota: 'asn_relay_acct_quota(jsonb)' })) {
    const p = (await db.query(`select prosecdef, proconfig from pg_proc where proname = $1`, [name])).rows[0]
    out[name] = { definer: p.prosecdef, config: p.proconfig }
    for (const role of ['anon', 'authenticated', 'service_role']) out[name][role] = (await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${sig}`])).rows[0].v
  }
  return out
}

test('實跑（pglite）：舊格式不帶兩欄＝預設 false；新格式寫得進、讀得出；型別不對整份退回不寫；恢復後旗標消失', { skip }, async () => {
  const db = await setup()
  for (const n of Object.keys(FNS)) assert.equal(await overloads(db, n), 1, `${n} 只有一個多載`)
  const AT = iso(NOW - 60_000), R5 = iso(NOW + 2 * H), RW = iso(NOW + 3 * D)
  const rowOld = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 40, weekly_pct: 70, reset_at: R5, five_reset_at: R5, week_reset_at: RW, at: AT }
  const wins = [win('five_hour', 40, R5, AT), win('weekly', 70, RW, AT)]
  // 舊版電腦：不帶兩欄
  assert.deepEqual(await oldReport(db, 'W', [rowOld]), { ok: true, count: 1 })
  assert.equal((await report(db, 'W', [{ ...rowOld, windows: wins }])).ok, true)
  let got = (await list(db, 'H', 'W')).accounts[0]
  assert.deepEqual(got, { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 40, weekly_pct: 70, reset_at: R5, five_reset_at: R5, week_reset_at: RW, at: AT }, '舊格式回報跟以前一模一樣（沒有旗標鍵）')
  let n = (await rosterOf(db, 'H', U1)).accounts[0]
  assert.deepEqual(n.nodes.map(x => [x.node, x.current, x.login_failed, x.login_incomplete]), [['W', true, false, false]], '讀出預設 false')
  assert.deepEqual(n.windows.map(w => [w.name, w.resets_at]), [['five_hour', R5], ['weekly', RW]], '名單的額度窗還在')
  assert.equal(n.plan, 'max')
  // 新版電腦：兩欄都帶
  const rowNew = { ...rowOld, login_failed: true, login_incomplete: true }
  assert.deepEqual(await oldReport(db, 'W', [rowNew]), { ok: true, count: 1 })
  assert.equal((await report(db, 'W', [{ ...rowNew, windows: wins }])).ok, true)
  got = (await list(db, 'H', 'W')).accounts[0]
  assert.equal(got.login_failed, true); assert.equal(got.login_incomplete, true)
  for (const k of ['email', 'plan', 'current', 'five_hour_pct', 'weekly_pct', 'reset_at', 'five_reset_at', 'week_reset_at', 'at']) assert.equal(got[k], rowOld[k], `既有欄位 ${k} 還在`)
  n = (await rosterOf(db, 'H', U1)).accounts[0]
  assert.deepEqual(n.nodes.map(x => [x.node, x.current, x.login_failed, x.login_incomplete]), [['W', true, true, true]])
  assert.equal(n.nodes[0].reported_at.length, 20)
  // 只標一個
  await oldReport(db, 'W', [{ ...rowOld, login_failed: true, login_incomplete: false }])
  got = (await list(db, 'H', 'W')).accounts[0]
  assert.equal(got.login_failed, true); assert.equal('login_incomplete' in got, false, 'false 不存')
  // 型別不對：整份退回、不寫（舊的旗標還在）
  for (const bad of ['yes', 1, 'true', {}, null]) {
    assert.deepEqual(await oldReport(db, 'W', [{ ...rowOld, login_failed: bad }]), { error: 'bad_request' })
    assert.deepEqual(await oldReport(db, 'W', [{ ...rowOld, login_incomplete: bad }]), { error: 'bad_request' })
    assert.deepEqual(await report(db, 'W', [{ ...rowOld, login_failed: bad }]), { error: 'bad_request' })
    assert.deepEqual(await report(db, 'W', [{ ...rowOld, login_incomplete: bad }]), { error: 'bad_request' })
  }
  assert.equal((await list(db, 'H', 'W')).accounts[0].login_failed, true, '退回的回報沒有寫入')
  // 恢復：下一次回報不帶，旗標消失
  await oldReport(db, 'W', [rowOld])
  assert.equal('login_failed' in (await list(db, 'H', 'W')).accounts[0], false)
  assert.equal((await rosterOf(db, 'H', U1)).accounts[0].nodes[0].login_failed, false)
})

test('實跑（pglite）：gemini 的旗標跟著那一格；既有的 current／兩台合併／這台不再回報就拿掉都不變', { skip }, async () => {
  const db = await setup()
  const AT = iso(NOW - 60_000)
  const g = (email, current, extra = {}) => ({ vendor: 'gemini', email, plan: 'Google AI Pro', current, windows: [win('five_hour', 50, iso(NOW + H), AT)], ...extra })
  assert.equal((await report(db, 'W', [g('g1@x.test', true, { login_failed: true }), g('g2@x.test', false)])).ok, true)
  assert.equal((await report(db, 'Q', [g('g2@x.test', true), g('g1@x.test', false)])).ok, true)
  const view = async () => Object.fromEntries((await rosterOf(db, 'H', U1)).accounts.filter(a => a.vendor === 'gemini').map(a => [a.account, a.nodes.map(n => [n.node, n.current, n.login_failed, n.login_incomplete])]))
  assert.deepEqual(await view(), { 'g1@x.test': [['Q', false, false, false], ['W', true, true, false]], 'g2@x.test': [['Q', true, false, false], ['W', false, false, false]] })
  // W 不再回報 g2 → 拿掉 W 那格；W 之後回報 g1 不帶旗標 → 旗標消失
  await report(db, 'W', [g('g1@x.test', true)])
  assert.deepEqual(await view(), { 'g1@x.test': [['Q', false, false, false], ['W', true, false, false]], 'g2@x.test': [['Q', true, false, false]] })
  assert.equal(((await rosterOf(db, 'H', U1)).accounts.find(a => a.account === 'g1@x.test')).plan, 'Google AI Pro')
})

test('實跑（pglite）：權限與改前相同（三支＋額度函式：definer、設定、只有 service_role 能執行）；可重跑；不是本人的節點照舊被擋', { skip }, async () => {
  const before = await privs(await setup({ apply: false }))
  const db = await setup()
  assert.deepEqual(await privs(db), before)
  for (const [name, p] of Object.entries(before)) assert.equal(p.service_role, true, name)
  await db.exec(mig)
  assert.deepEqual(await privs(db), before, '可重跑')
  for (const n of Object.keys(FNS)) assert.equal(await overloads(db, n), 1)
  // 節點擁有者不是租戶擁有者（M）：名單寫入照舊 not_claimed
  assert.deepEqual(await report(db, 'M', [{ vendor: 'claude', email: 'a@x.test', login_failed: true }]), { error: 'not_claimed' })
  // 回復後函式與現行本體逐字相同，旗標不再被讀
  await db.exec(down1)
  assert.equal(await fnDef(db, 'asn_relay_acct_roster'), await fnDef(await setup({ apply: false }), 'asn_relay_acct_roster'))
  assert.equal(await fnDef(db, 'asn_relay_acct_report'), await fnDef(await setup({ apply: false }), 'asn_relay_acct_report'))
  assert.deepEqual(await privs(db), before, '回復後權限同樣不變')
})

// ---- 寄信函式 ----
async function setupAlert({ apply = true } = {}) {
  const db = await setup({ apply: false })
  await db.exec(`
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, to_agent text, body text, fanout_id uuid, created_at timestamptz default now());
    create function public.asn_person_alias(p_user uuid) returns text language sql immutable security definer set search_path = '' as $$
      select case when p_user is null then null else 'u:' || substr(md5('asn-person:' || p_user::text), 1, 12) end $$;
    -- 既有寄信函式的替身：只記下收到什麼（真的那支的「收件人必須是租戶擁有者人代號」另在靜態測試檢查）
    create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean, p_signed_user uuid, p_as_person boolean)
      returns jsonb language plpgsql security definer set search_path = '' as $$
      declare v_id uuid;
      begin
        insert into relay.messages(from_node, from_agent, to_node, to_agent, body) values (p_from_node, p_from_agent, p_to_node, p_to_agent, p_body) returning id into v_id;
        return jsonb_build_object('id', v_id, 'bell_topic', 'bell-owner');
      end $$;`)
  if (apply) await db.exec(alert)
  return db
}
const call = async (db, node, computer, lastAt, email = null, timeouts = 0) =>
  (await db.query('select public.asn_relay_login_alert($1, $2, $3::timestamptz, $4, $5) r', [node, computer, lastAt, email, timeouts])).rows[0].r
const msgs = async db => (await db.query('select from_node, from_agent, to_node, to_agent, body from relay.messages order by created_at, id')).rows
const hhmm = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))

test('實跑（pglite）：寄信函式——收件人一定是節點擁有者的人代號；內文由固定句型組出；只收固定欄位', { skip }, async () => {
  const db = await setupAlert()
  assert.equal(await overloads(db, 'asn_relay_login_alert'), 1)
  const t = NOW - 5 * 60_000
  const r = await call(db, 'W', '工作機', iso(t), 'A@x.test'.toLowerCase(), 3)
  assert.equal(r.bell_topic, 'bell-owner')
  const alias = 'u:' + (await db.query(`select substr(md5('asn-person:${U1}'), 1, 12) a`)).rows[0].a
  const m = await msgs(db)
  assert.equal(m.length, 1)
  assert.deepEqual({ ...m[0], body: undefined }, { from_node: 'W', from_agent: '登入通知收發室', to_node: alias, to_agent: null, body: undefined })
  assert.equal(m[0].body, `工作機的 Claude 登入失效（最後一次錯誤 ${hhmm(Math.floor(t / 1000) * 1000)}，帳號 a@x.test）。這段時間轉交逾時 3 次。`)
  // 沒帶 email、沒逾時
  await call(db, 'Q', '家用機', iso(NOW), null, 0)
  assert.equal((await msgs(db))[1].body, `家用機的 Claude 登入失效（最後一次錯誤 ${hhmm(Math.floor(NOW / 1000) * 1000)}）。`)
  assert.equal((await msgs(db))[1].to_node, alias)
  // 簽章沒有任何收件人／內文參數
  const args = (await db.query(`select pg_get_function_arguments(p.oid) a from pg_proc p where proname = 'asn_relay_login_alert'`)).rows[0].a
  assert.doesNotMatch(args, /to_|body|recipient|error/i)
})

test('實跑（pglite）：寄信函式——不是自己的節點、不存在的節點被拒；欄位不合不寄', { skip }, async () => {
  const db = await setupAlert()
  const ok = iso(NOW - 60_000)
  // M 的 owner_user 不是租戶擁有者、X 不存在
  assert.deepEqual(await call(db, 'M', '別人的機', ok), { error: 'not_claimed' })
  assert.deepEqual(await call(db, 'X', '無此機', ok), { error: 'not_claimed' })
  await db.query(`update relay.nodes set status = 'revoked' where id = 'Q'`)
  assert.deepEqual(await call(db, 'Q', '停用的', ok), { error: 'not_claimed' })
  const bad = [
    ['', ok], ['   ', ok], ['x'.repeat(41), ok], ['a\nb', ok], ['a\u0007b', ok],
    ['工作機', iso(NOW + 11 * 60_000)], ['工作機', iso(NOW - 25 * H)], ['工作機', null],
  ]
  for (const [c, at] of bad) assert.deepEqual(await call(db, 'W', c, at), { error: 'bad_request' }, JSON.stringify([c, at]))
  assert.deepEqual(await call(db, 'W', '工作機', ok, 'not-an-email'), { error: 'bad_request' })
  assert.deepEqual(await call(db, 'W', '工作機', ok, null, -1), { error: 'bad_request' })
  assert.deepEqual(await call(db, 'W', '工作機', ok, null, 1000), { error: 'bad_request' })
  assert.equal((await msgs(db)).length, 0, '全部沒寄')
  assert.equal((await call(db, 'W', 'x'.repeat(40), ok)).bell_topic, 'bell-owner', '剛好 40 字可以')
})

test('實跑（pglite）：寄信函式——同一節點每小時最多 3 封，第 4 封被拒；別的節點不受影響；過一小時又能寄', { skip }, async () => {
  const db = await setupAlert()
  const ok = iso(NOW - 60_000)
  for (let i = 0; i < 3; i++) assert.equal((await call(db, 'W', '工作機', ok)).bell_topic, 'bell-owner')
  assert.deepEqual(await call(db, 'W', '工作機', ok), { error: 'rate_limited' })
  assert.equal((await msgs(db)).length, 3)
  assert.equal((await call(db, 'H', '另一台', ok)).bell_topic, 'bell-owner', '別的節點另計')
  // 非本函式寄的信（別的寄件名）不佔額度
  await db.query(`insert into relay.messages(from_node, from_agent, to_node, body) values ('Q', 'Q-收發室', 'u:x', 'hi'), ('Q', 'Q-收發室', 'u:x', 'hi'), ('Q', 'Q-收發室', 'u:x', 'hi')`)
  assert.equal((await call(db, 'Q', '第三台', ok)).bell_topic, 'bell-owner')
  // 一小時前的不算
  await db.query(`update relay.messages set created_at = now() - interval '61 minutes' where from_node = 'W'`)
  assert.equal((await call(db, 'W', '工作機', ok)).bell_topic, 'bell-owner')
})

test('實跑（pglite）：寄信函式——權限：definer、search_path 空、只有 service_role 能執行；可重跑；回復後函式不在', { skip }, async () => {
  const db = await setupAlert()
  const p = (await db.query(`select prosecdef, proconfig from pg_proc where proname = 'asn_relay_login_alert'`)).rows[0]
  assert.equal(p.prosecdef, true); assert.deepEqual(p.proconfig, ['search_path=""'])
  for (const [role, want] of [['anon', false], ['authenticated', false], ['service_role', true]]) {
    assert.equal((await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${ALERT_SIG}`])).rows[0].v, want, role)
  }
  assert.equal((await db.query(`select has_function_privilege('public', 'public.${ALERT_SIG}', 'execute') v`).catch(() => ({ rows: [{ v: false }] }))).rows[0].v, false)
  await db.exec(alert)
  assert.equal(await overloads(db, 'asn_relay_login_alert'), 1, '可重跑')
  await db.exec(down2)
  assert.equal(await overloads(db, 'asn_relay_login_alert'), 0)
})
