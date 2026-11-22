// 帳號回報多收訂閱狀態 sub_state（#1646 拆項 D）：20261122200000_acct_sub_state.sql，比照 acct_login_flags_sql.test.mjs。
// 1. 靜態：只換三支函式本體、簽章不變、ACL 只給 service_role；把新加的片段逐段拿掉要跟現行本體逐字相同；回復檔＝現行本體。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    帶 lapsed 存得下也讀得出；沒帶就沿用上次的值（舊版用戶端不會蓋掉、也不會誤判）；明說 active 才清掉；
//    值不合整份退回且不寫；舊回報格式不壞；既有欄位還在；權限與改前相同；回復後照樣能用。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261122200000_acct_sub_state.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(F)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const usable = read('20261115100000_acct_usable_at.sql')
const latest = read('20261120120000_acct_quota_latest_per_window.sql')
const share = read('20261110100000_acct_quota_share.sql')
const dropExp = read('20261113100000_acct_quota_drop_missing_expired.sql')
const simplify = read('20261113000000_acct_quota_rules_simplify.sql')
const wk = read('20261111200000_acct_quota_week_confirm.sql')
const gem = read('20261029130000_acct_roster_gemini.sql')
const flags = read('20261031100000_acct_login_flags.sql')
const reset = read('20261030100000_acct_reset_times.sql')
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const FNS = {
  asn_relay_acct_report: 'asn_relay_acct_report(text, jsonb)',
  asn_relay_acct_roster_report: 'asn_relay_acct_roster_report(text, jsonb)',
  asn_relay_acct_roster: 'asn_relay_acct_roster(text, uuid)',
}
const CUR = { asn_relay_acct_report: usable, asn_relay_acct_roster_report: latest, asn_relay_acct_roster: share }
const body = (sql, name) => { const s = sql.toLowerCase().indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', sql.toLowerCase().indexOf('$function$', s) + 5) + 11) }

const CHECK_TAIL = "\n       or (v_row ? 'sub_state' and (jsonb_typeof(v_row->'sub_state') <> 'string' or (v_row->>'sub_state') not in ('active', 'lapsed', 'unknown')))"
const DECL = "\n  v_old jsonb;\n  v_sub text;"
const OLD_READ = "\n  -- 這台上一次回報存的清單：訂閱狀態「沒帶」時沿用它（見上方說明）\n  select accounts into v_old from relay.asn_accounts where node = p_node for update;\n  v_old := coalesce(v_old, '[]'::jsonb);"
const SUB_BLOCK = "\n    -- 訂閱狀態（只有 claude）：只有確定的 active／lapsed 會覆寫；帶 unknown（電腦端這輪判不出來）或沒帶（舊版用戶端）\n    -- 都沿用這台上次存的確定值（二審：讀不到不代表恢復了，不然帳號卡和通知會來回跳），沒有就不存\n    v_sub := null;\n    if v_row->>'vendor' = 'claude' then\n      v_sub := case when v_row->>'sub_state' in ('active', 'lapsed') then v_row->>'sub_state' else (\n        select e->>'sub_state' from jsonb_array_elements(v_old) e\n          where e->>'vendor' = 'claude' and lower(e->>'email') = lower(v_row->>'email')\n            and e->>'sub_state' in ('active', 'lapsed') limit 1) end;\n    end if;"
const STORE = "\n      || case when v_sub is not null then jsonb_build_object('sub_state', v_sub) else '{}'::jsonb end"
const READ_ADD = /,\n *'sub_state', coalesce\(e->>'sub_state', 'unknown'\)\)/g
// 把新版的新增片段逐段拿掉
const stripRosterReport = t => t.replace("\n       or (v_row ? 'sub_state' and (jsonb_typeof(v_row->'sub_state') <> 'string' or (v_row->>'sub_state') not in ('active', 'lapsed', 'unknown'))) then", ' then')
const stripReport = t => stripRosterReport(t).replace(DECL, '').replace(OLD_READ, '').replace(SUB_BLOCK, '').replace(STORE, '')
const stripRoster = t => t.replace(READ_ADD, ')')

test('靜態：只換三支函式本體、簽章不變、只授權 service_role；拿掉新加片段等於現行本體；回復檔＝現行本體', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf('20261120200000_compact_notice.sql'), '編號比現有的大')
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 3)
  assert.doesNotMatch(mig, /create or replace function public\.asn_relay_acct_quota/i, '額度函式沒動')
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down]) {
    for (const sig of Object.values(FNS)) {
      assert.ok(f.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig)
      assert.ok(f.includes(`grant execute on function public.${sig} to service_role;`), sig)
    }
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  const strip = { asn_relay_acct_report: stripReport, asn_relay_acct_roster_report: stripRosterReport, asn_relay_acct_roster: stripRoster }
  for (const [name, src] of Object.entries(CUR)) {
    const a = body(mig, name), b = body(src, name)
    assert.equal(a.split('\n')[0].toLowerCase(), b.split('\n')[0].toLowerCase(), name)
    assert.equal(/security definer/i.test(a), /security definer/i.test(b), name)
    assert.equal(a.match(/set search_path to ''/i)?.length, b.match(/set search_path to ''/i)?.length, name)
    assert.notEqual(a, b, name + ' 有改')
    assert.equal(strip[name](a), b, name + ' 去掉新增片段後等於現行本體')
    assert.equal(body(down, name), b, `${name} 回復檔＝現行本體逐字`)
  }
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'

async function setup({ apply = true } = {}) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', owner_user uuid, bell_topic text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic) values ('W', '${T1}', 'member', '${U1}', 'bell-W'), ('Q', '${T1}', 'member', '${U1}', 'bell-Q'), ('H', '${T1}', 'owner', '${U1}', 'bell-H');`)
  await db.exec(base)
  for (const p of prior) await db.exec(p)
  for (const f of [roster, lock, gem, reset, flags, share, wk, simplify, dropExp, usable, latest]) await db.exec(f)
  if (apply) await db.exec(mig)
  return db
}
const oldReport = async (db, node, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const report = async (db, node, rows) => (await db.query('select public.asn_relay_acct_roster_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const list = async (db, node = 'W') => (await db.query('select public.asn_relay_acct_list($1, $2) r', ['H', node])).rows[0].r.accounts
const rosterOf = async db => (await db.query('select public.asn_relay_acct_roster($1, $2::uuid) r', ['H', U1])).rows[0].r.accounts
const subs = async db => Object.fromEntries((await rosterOf(db)).map(a => [`${a.vendor}/${a.account}`, a.nodes.map(n => [n.node, n.sub_state])]))
const privs = async db => {
  const out = {}
  for (const [name, sig] of Object.entries(FNS)) {
    const p = (await db.query(`select prosecdef, proconfig from pg_proc where proname = $1`, [name])).rows[0]
    out[name] = { definer: p.prosecdef, config: p.proconfig }
    for (const role of ['anon', 'authenticated', 'service_role']) out[name][role] = (await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${sig}`])).rows[0].v
  }
  return out
}

test('實跑（pglite）：帶 lapsed 存得下讀得出；沒帶沿用；明說 active 才清；值不合整份退回；其他廠牌不存', { skip }, async () => {
  const db = await setup()
  for (const n of Object.keys(FNS)) assert.equal((await db.query(`select count(*)::int c from pg_proc where proname = $1`, [n])).rows[0].c, 1, `${n} 只有一個多載`)
  const a = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, login_failed: true }
  // 舊版用戶端：完全沒帶，跟以前一樣（沒有 sub_state 鍵），讀出是 unknown
  assert.deepEqual(await oldReport(db, 'W', [a]), { ok: true, count: 1 })
  assert.deepEqual((await list(db))[0], { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, login_failed: true })
  assert.equal((await report(db, 'W', [a])).ok, true)
  assert.deepEqual(await subs(db), { 'claude/a@x.test': [['W', 'unknown']] })
  // 帶 lapsed：存下並讀得出，既有欄位還在
  assert.deepEqual(await oldReport(db, 'W', [{ ...a, sub_state: 'lapsed' }, { vendor: 'codex', email: 'c@x.test', sub_state: 'lapsed' }]), { ok: true, count: 2 })
  assert.equal((await report(db, 'W', [{ ...a, sub_state: 'lapsed' }])).ok, true)
  let got = await list(db)
  assert.equal(got[0].sub_state, 'lapsed'); assert.equal(got[0].login_failed, true); assert.equal(got[0].plan, 'max')
  assert.equal('sub_state' in got[1], false, '別家不存')
  assert.deepEqual((await subs(db))['claude/a@x.test'], [['W', 'lapsed']])
  // 舊版用戶端回報（沒帶）：不蓋掉已存的值；email 大小寫不同也認得
  await oldReport(db, 'W', [{ ...a, email: 'A@x.test' }])
  assert.equal((await list(db))[0].sub_state, 'lapsed', '沒帶＝沿用')
  assert.deepEqual((await subs(db))['claude/a@x.test'], [['W', 'lapsed']])
  // 其他台電腦的值互不影響
  await oldReport(db, 'Q', [a])
  assert.equal('sub_state' in (await list(db, 'Q'))[0], false)
  assert.equal((await list(db))[0].sub_state, 'lapsed')
  // 值不合：整份退回、不寫、已存的還在
  for (const bad of ['expired', 'Lapsed', '', true, 1, null, {}, ['lapsed']]) {
    assert.deepEqual(await oldReport(db, 'W', [{ ...a, sub_state: bad }]), { error: 'bad_request' }, JSON.stringify(bad))
    assert.deepEqual(await report(db, 'W', [{ ...a, sub_state: bad }]), { error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.equal((await list(db))[0].sub_state, 'lapsed', '退回的回報沒有寫入')
  // 二審：unknown（這輪判不出來）不蓋掉先前確定的 lapsed——讀不到不代表恢復了；明說 active 才清成 active
  await oldReport(db, 'W', [{ ...a, sub_state: 'unknown' }])
  assert.equal((await list(db))[0].sub_state, 'lapsed', 'unknown 保留上一次確定的 lapsed')
  assert.deepEqual((await subs(db))['claude/a@x.test'].find(([n]) => n === 'W'), ['W', 'lapsed'], '讀出也是 lapsed')
  await oldReport(db, 'W', [{ ...a, sub_state: 'active' }])
  assert.equal((await list(db))[0].sub_state, 'active')
  await oldReport(db, 'W', [a])
  assert.equal((await list(db))[0].sub_state, 'active', '之後沒帶仍沿用 active')
  await oldReport(db, 'W', [{ ...a, sub_state: 'unknown' }])
  assert.equal((await list(db))[0].sub_state, 'active', 'unknown 也不蓋掉先前確定的 active')
  // 從來沒有確定值時帶 unknown：不存，讀出仍是 unknown
  await oldReport(db, 'Q', [{ ...a, sub_state: 'unknown' }])
  assert.equal('sub_state' in (await list(db, 'Q'))[0], false)
  // 帳號不再回報就不留
  await oldReport(db, 'W', [{ vendor: 'claude', email: 'z@x.test' }])
  await oldReport(db, 'W', [a])
  assert.equal('sub_state' in (await list(db))[0], false, '中間斷過一次回報，舊值不再沿用')
})

test('實跑（pglite）：gemini 的名單格讀出 unknown、不受影響；權限與改前相同、可重跑；回復後照樣能用', { skip }, async () => {
  const before = await privs(await setup({ apply: false }))
  const db = await setup()
  assert.deepEqual(await privs(db), before)
  for (const [name, p] of Object.entries(before)) assert.equal(p.service_role, true, name)
  await db.exec(mig)
  assert.deepEqual(await privs(db), before, '可重跑')
  const g = { vendor: 'gemini', email: 'g@x.test', plan: 'Pro', current: true, sub_state: 'lapsed', windows: [{ name: 'five_hour', left_pct: 50, resets_at: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, 'Z'), read_at: new Date(Date.now() - 60e3).toISOString().replace(/\.\d+Z$/, 'Z') }] }
  assert.equal((await report(db, 'W', [g])).ok, true)
  assert.deepEqual((await subs(db))['gemini/g@x.test'], [['W', 'unknown']])
  await db.exec(down)
  assert.deepEqual(await privs(db), before, '回復後權限照舊')
  assert.deepEqual(await oldReport(db, 'W', [{ vendor: 'claude', email: 'a@x.test', sub_state: 'lapsed' }]), { ok: true, count: 1 })
  assert.equal('sub_state' in (await list(db))[0], false, '回復後不存')
  assert.equal((await rosterOf(db))[0].nodes[0].sub_state, undefined)
})

closeAtEnd()
