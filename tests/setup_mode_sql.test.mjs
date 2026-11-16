// 手機重新登入的模式（20261116100000_setup_mode.sql；#1592）：
// 1. 靜態：只動 asn_setup_request／asn_relay_setup_poll 與 mode 欄；新函式只授權 service_role；回復腳本放回上一版原文；原有的行逐字不變。
// 2. 實跑（pglite）：沒帶 mode＝install（舊版手機照舊）；relogin 存得下來並在電腦取請求時帶回；不合法的 mode 一律 bad_request；
//    relogin 只對 claude；已有進行中請求時回應帶那筆的 mode；回復後可還原。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SETUP = rd('migrations/20261102140000_setup_requests.sql')
const WATCH = rd('migrations/20261102130000_inbox_watch.sql')
const PLAT = rd('migrations/20261102170000_node_platform_phone.sql')
const PREV = rd('migrations/20261112400000_setup_device_login.sql')
const MIG = rd('migrations/20261116100000_setup_mode.sql')
const DOWN = rd('sql/rollback/20261116100000_setup_mode_down.sql')
const grab = (src, start) => { const i = src.indexOf(start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const REQ = 'create or replace function public.asn_setup_request('
const POLL = 'create or replace function public.asn_relay_setup_poll('
// 把新版函式本體裡本次加的行去掉，應該等於上一版原文
const strip = s => s
  .replace(", p_mode text default 'install')", ')')
  .replace(/  -- 模式只有[\s\S]*?  end if;\n(?=  -- 不是自己的節點)/, '')
  .replace(/, 'mode', v_r\.mode/g, '')
  .replace(', expires_at, mode)', ', expires_at)')
  .replace(' end, p_mode)\n', ' end)\n')
  .replace(',\n        mode = excluded.mode;', ';')

test('靜態：兩個函式除了本次加的行，與上一版逐字相同', () => {
  assert.equal(strip(grab(MIG, REQ)), grab(PREV, REQ))
  assert.equal(strip(grab(MIG, POLL)), grab(PREV, POLL))
  const code = MIG.replace(/^--.*$/gm, '')
  assert.equal(code.split('create or replace function').length - 1, 2, '只有兩支函式')
  assert.doesNotMatch(code, /create policy|grant execute[^;]*to (anon|authenticated|public)/)
})

test('靜態：mode 欄與約束、七參數函式只授權 service_role、舊的六參數先 drop', () => {
  assert.match(MIG, /add column if not exists mode text not null default 'install';/)
  assert.match(MIG, /check \(mode in \('install', 'relogin'\)\)/)
  assert.match(MIG, /drop function if exists public\.asn_setup_request\(uuid, text, text, text, text, text\);/)
  assert.match(MIG, /revoke all on function public\.asn_setup_request\(uuid, text, text, text, text, text, text\) from public, anon, authenticated;/)
  assert.match(MIG, /grant execute on function public\.asn_setup_request\(uuid, text, text, text, text, text, text\) to service_role;/)
  for (const name of ['asn_setup_request', 'asn_relay_setup_poll']) {
    const i = MIG.indexOf(`create or replace function public.${name}(`)
    assert.match(MIG.slice(i, MIG.indexOf('as $function$', i)), /security definer\s+set search_path to ''/, name)
  }
})

test('靜態：回復腳本放回上一版兩個函式原文並 drop 新函式與欄位', () => {
  assert.ok(DOWN.includes(grab(PREV, REQ)))
  assert.ok(DOWN.includes(grab(PREV, POLL)))
  for (const s of ["delete from relay.setup_requests where mode = 'relogin';", 'drop function if exists public.asn_setup_request(uuid, text, text, text, text, text, text);',
    'drop column if exists mode;', 'revoke all on function public.asn_setup_request(uuid, text, text, text, text, text) from public, anon, authenticated;']) assert.ok(DOWN.includes(s), s)
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'

async function boot(down = false) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, machine text, kind text, status text default 'active', owner_user uuid, last_seen_at timestamptz,
      platform text, launch_closed_reason text, inbox_hold_until timestamptz, tenant_id uuid);
    alter table relay.nodes add constraint nodes_platform_check check (platform is null or platform in ('linux', 'windows', 'macos'));
    create table relay.asn_presence(node text, window_name text default 'w', version text, updated_at timestamptz default now());
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(), user_id uuid, event text not null, node text, detail jsonb);
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, body text, created_at timestamptz default now(), acked_at timestamptz, fanout_id uuid);
    create table relay.device_keys(node text primary key, sign_pub text not null);
    create table relay.secret_requests(id uuid primary key default gen_random_uuid(), requester_node text, link text);
    create function public.asn_relay_secret_request(p_node text, p_pub text, p_program text, p_purpose text, p_ttl_seconds integer) returns jsonb language sql as $$ select jsonb_build_object('id', gen_random_uuid()) $$;
    create function public.asn_person_alias(p_user uuid) returns text language sql as $$ select 'u:' || substr(md5(p_user::text), 1, 12) $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean, p_signed_user uuid, p_as_person boolean)
      returns jsonb language plpgsql as $$ begin insert into relay.messages(from_node, from_agent, to_node, body) values (p_from_node, p_from_agent, p_to_node, p_body); return jsonb_build_object('ok', true); end $$;`)
  for (const sql of [SETUP.slice(0, SETUP.indexOf('-- 清理：')) + '\ncommit;', WATCH.slice(0, WATCH.indexOf('-- ===cron===')) + '\ncommit;', PLAT, PREV, MIG]) await db.exec(sql)
  if (down) await db.exec(DOWN)
  const q = async (t, a) => (await db.query(t, a)).rows
  const node = async id => {
    await db.query('insert into relay.nodes(id, owner_user, last_seen_at) values ($1,$2, now())', [id, U1])
    await db.query('insert into relay.asn_presence(node, version) values ($1, $2)', [id, '0.2.20'])
  }
  const req = async (n, extra = '') => (await q(`select public.asn_setup_request(p_user => $1, p_node => $2${extra}) r`, [U1, n]))[0].r
  const poll = async n => (await q('select public.asn_relay_setup_poll($1, $2) r', [n, '0.2.20']))[0].r
  await node('PC')
  return { db, q, node, req, poll }
}

test('實跑：沒帶 mode＝install（舊版手機照舊），電腦取到的 mode 是 install', { skip }, async () => {
  const { q, req, poll } = await boot()
  assert.deepEqual(await req('PC'), { ok: true, already: false, state: 'pending' })
  assert.equal((await q("select mode from relay.setup_requests where node = 'PC'"))[0].mode, 'install')
  assert.deepEqual(await poll('PC'), { requested: true, requested_by: U1, kind: 'claude', mode: 'install' })
})

test('實跑：relogin 存得下來並由電腦取請求時帶回；已有進行中的請求回應帶那筆的 mode', { skip }, async () => {
  const { q, req, poll } = await boot()
  assert.deepEqual(await req('PC', ", p_mode => 'relogin'"), { ok: true, already: false, state: 'pending' })
  assert.equal((await q("select mode from relay.setup_requests where node = 'PC'"))[0].mode, 'relogin')
  assert.deepEqual(await req('PC', ", p_mode => 'install'"), { ok: true, already: true, state: 'pending', kind: 'claude', mode: 'relogin' }, '進行中的要求不被蓋掉')
  assert.deepEqual(await poll('PC'), { requested: true, requested_by: U1, kind: 'claude', mode: 'relogin' })
})

test('實跑：不合法的 mode 與 relogin 搭配非 claude 一律 bad_request，不留下列', { skip }, async () => {
  const { q, req } = await boot()
  for (const extra of [", p_mode => 'update'", ", p_mode => ''", ", p_mode => 'RELOGIN'", ', p_mode => null', ", p_kind => 'codex', p_mode => 'relogin'"]) {
    assert.deepEqual(await req('PC', extra), { error: 'bad_request' }, extra)
  }
  assert.equal((await q('select count(*)::int n from relay.setup_requests'))[0].n, 0)
})

test('實跑：資料表約束擋得住直接寫入不合法的 mode', { skip }, async () => {
  const { db } = await boot()
  await assert.rejects(db.query("insert into relay.setup_requests(node, requested_by, mode) values ('PC', $1, 'xx')", [U1]))
})

test('實跑：回復後舊的六參數函式回來、mode 欄不見', { skip }, async () => {
  const { q } = await boot(true)
  assert.equal((await q("select count(*)::int n from information_schema.columns where table_schema = 'relay' and table_name = 'setup_requests' and column_name = 'mode'"))[0].n, 0)
  assert.equal((await q("select count(*)::int n from pg_proc where proname = 'asn_setup_request'"))[0].n, 1)
  assert.deepEqual((await q("select public.asn_setup_request(p_user => $1, p_node => 'PC') r", [U1]))[0].r, { ok: true, already: false, state: 'pending' })
})

closeAtEnd()
