// 帳號回報多收「上次確認可用」（#1512 C2）：20261115100000_acct_usable_at.sql 只換 asn_relay_acct_report 一支函式。
// 1. 靜態：只換一支函式本體、簽章不變、ACL 只給 service_role；把新加的三行拿掉要跟現行本體（20261031100000 版）逐字相同；回復檔＝現行本體。
// 2. 實跑（有安裝 @electric-sql/pglite 時；不要加 --test-force-exit）：
//    claude 帶了寫得進、讀得出；別家帶了不存；不帶跟以前一模一樣；格式不對整份退回且不寫；既有欄位都還在；權限與改前相同；回復後照樣能用。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261115100000_acct_usable_at.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(F)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const flags = read('20261031100000_acct_login_flags.sql')
const SIG = 'asn_relay_acct_report(text, jsonb)'
const body = (sql, name) => { const s = sql.toLowerCase().indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', sql.toLowerCase().indexOf('$function$', s) + 5) + 11) }

const NEW_CHECK = "\n       or (v_row ? 'usable_at' and (jsonb_typeof(v_row->'usable_at') <> 'string' or (v_row->>'usable_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'))"
const NEW_CASE = "\n      || case when v_row->>'vendor' = 'claude' and v_row ? 'usable_at' then jsonb_build_object('usable_at', v_row->>'usable_at') else '{}'::jsonb end"
const strip = t => t.replace(NEW_CHECK, '').replace(NEW_CASE, '')

test('靜態：只換 asn_relay_acct_report 一支本體、簽章不變、只授權 service_role；拿掉新加的兩段等於現行本體；回復檔＝現行本體', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.equal(files[files.length - 1] >= F, true, '編號在現有的之後')
  assert.ok(files.indexOf(F) > files.indexOf('20261114100000_perm_requests_full_options.sql'))
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  // 函式本體自己會寫 relay.asn_accounts（現行版就有）；這裡擋的是函式以外的結構變更與資料操作
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate|delete from/i, '只換函式本體，不動資料表與資料')
  assert.equal(mig.split(/\$function\$;/).slice(-1)[0].match(/insert into|update relay/gi), null, '函式以外沒有寫資料')
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down]) {
    assert.ok(f.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
    assert.ok(f.includes(`grant execute on function public.${SIG} to service_role;`))
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  const a = body(mig, 'asn_relay_acct_report'), cur = body(flags, 'asn_relay_acct_report')
  assert.equal(a.split('\n')[0], cur.split('\n')[0], '簽章行相同')
  assert.ok(a.includes(NEW_CHECK) && a.includes(NEW_CASE), '新加的兩段原樣在')
  assert.equal(strip(a), cur, '拿掉新加的兩段後，跟現行本體逐字相同（既有欄位與規則一個都沒動）')
  assert.equal(body(down, 'asn_relay_acct_report'), cur, '回復檔＝現行本體逐字')
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const prior = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql',
  '20261029100000_acct_roster.sql', '20261029110000_acct_roster_lock_lower.sql', '20261029130000_acct_roster_gemini.sql', '20261030100000_acct_reset_times.sql', '20261031100000_acct_login_flags.sql'].map(read)

async function setup() {
  const db = track(new PGlite())
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
  return db
}
const report = async (db, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', ['W', JSON.stringify(rows)])).rows[0].r
const list = async db => (await db.query('select public.asn_relay_acct_list($1, $2) r', ['H', 'W'])).rows[0].r.accounts
const privs = async db => {
  const p = (await db.query(`select prosecdef, proconfig from pg_proc where proname = 'asn_relay_acct_report'`)).rows[0]
  const out = { definer: p.prosecdef, config: p.proconfig }
  for (const role of ['anon', 'authenticated', 'service_role']) out[role] = (await db.query(`select has_function_privilege($1, $2, 'execute') v`, [role, `public.${SIG}`])).rows[0].v
  return out
}

test('實跑（pglite）：claude 帶了寫得進讀得出；別家不存；不帶跟以前一樣；格式不對整份退回不寫；權限不變；回復後照樣能用', { skip }, async () => {
  const db = await setup()
  const before = await privs(db)
  const plain = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, login_failed: true }
  // 改之前：帶了也會被丟掉（舊函式不認得）
  assert.deepEqual(await report(db, [{ ...plain, usable_at: '2026-11-15T08:05:00Z' }]), { ok: true, count: 1 })
  assert.equal('usable_at' in (await list(db))[0], false, '現行版不存')
  await db.exec(mig)
  assert.deepEqual(await privs(db), before, '權限與改前相同')
  assert.equal((await db.query(`select count(*)::int c from pg_proc where proname = 'asn_relay_acct_report'`)).rows[0].c, 1, '只有一個多載')
  // 不帶：跟以前一模一樣
  assert.deepEqual(await report(db, [plain]), { ok: true, count: 1 })
  assert.deepEqual((await list(db))[0], { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, login_failed: true })
  // claude 帶了：存、讀得出；別家帶了：不存
  assert.deepEqual(await report(db, [{ ...plain, usable_at: '2026-11-15T08:05:00Z' }, { vendor: 'codex', email: 'b@x.test', usable_at: '2026-11-15T08:05:00Z' }]), { ok: true, count: 2 })
  const got = await list(db)
  assert.equal(got[0].usable_at, '2026-11-15T08:05:00Z')
  assert.equal(got[0].login_failed, true, '既有欄位還在')
  assert.equal('usable_at' in got[1], false, '別家不存')
  // 格式不對：整份退回、不寫（上一次的還在）
  for (const bad of [1763194000000, true, null, {}, '', '2026-11-15', '2026-11-15T08:05:00', '2026-11-15T08:05:00.123Z', '2026-11-15 08:05:00Z', '2026-11-15T08:05:00+08:00', 'x'.repeat(30), "2026-11-15T08:05:00Z'; drop table relay.nodes; --"]) {
    assert.deepEqual(await report(db, [{ ...plain, usable_at: bad }]), { error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.equal((await list(db))[0].usable_at, '2026-11-15T08:05:00Z', '退回的回報沒有寫入')
  // 回復：換回現行本體，照樣能寫、不存這欄
  await db.exec(down)
  assert.deepEqual(await privs(db), before, '回復後權限照舊')
  assert.deepEqual(await report(db, [{ ...plain, usable_at: '2026-11-15T09:00:00Z' }]), { ok: true, count: 1 })
  assert.equal('usable_at' in (await list(db))[0], false, '回復後不存')
})

closeAtEnd()
