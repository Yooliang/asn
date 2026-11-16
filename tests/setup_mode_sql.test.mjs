// 手機重新登入的模式（20261116200000_setup_mode.sql；#1592）：
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
const MIG = rd('migrations/20261116200000_setup_mode.sql')
const DOWN = rd('sql/rollback/20261116200000_setup_mode_down.sql')
const grab = (src, start) => { const i = src.indexOf(start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const REQ = 'create or replace function public.asn_setup_request('
const POLL = 'create or replace function public.asn_relay_setup_poll('
// 把新版函式本體裡本次加的行去掉，應該等於上一版原文
const strip = s => s
  .replace(", p_mode text default 'install')", ')')
  .replace(/  -- 模式只有[\s\S]*?  end if;\n(?=  -- 不是自己的節點)/, '')
  .replace(/  -- 重新登入要夠新的 ASN[\s\S]*?  end if;\n/, '')
  .replace(/  -- 重新登入不交給[\s\S]*?  end if;\n/, '')
  .replace(/, 'mode', v_r\.mode/g, '')
  .replace(', expires_at, mode)', ', expires_at)')
  .replace(' end, p_mode)\n', ' end)\n')
  .replace(',\n        mode = excluded.mode;', ';')

test('靜態：兩個函式除了本次加的行，與上一版逐字相同', () => {
  assert.equal(strip(grab(MIG, REQ)), grab(PREV, REQ))
  assert.equal(strip(grab(MIG, POLL)), grab(PREV, POLL))
  const code = MIG.replace(/^--.*$/gm, '')
  assert.equal(code.split('create or replace function').length - 1, 3, '兩支既有函式加一支版本比較的新函式')
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
  const node = async (id, version = '0.2.27') => {
    await db.query('insert into relay.nodes(id, owner_user, last_seen_at) values ($1,$2, now())', [id, U1])
    await db.query('insert into relay.asn_presence(node, version) values ($1, $2)', [id, version])
  }
  const req = async (n, extra = '') => (await q(`select public.asn_setup_request(p_user => $1, p_node => $2${extra}) r`, [U1, n]))[0].r
  const poll = async (n, v = '0.2.27') => (await q('select public.asn_relay_setup_poll($1, $2) r', [n, v]))[0].r
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

test('靜態：重新登入的最低版本 0.2.27 的函式不開放給外面；回復腳本會 drop 它', () => {
  assert.match(MIG, /array\[0, 2, 27\]/)
  assert.match(MIG, /revoke all on function relay\.setup_relogin_version_ok\(text\) from public, anon, authenticated;/)
  assert.ok(DOWN.includes('drop function if exists relay.setup_relogin_version_ok(text);'))
})

test('實跑：版本用數字比，0.2.27 起才支援重新登入', { skip }, async () => {
  const { q } = await boot()
  for (const [v, want] of [['0.2.9', false], ['0.2.26', false], ['0.2.27', true], ['0.2.27-test-abc', true], ['0.2.100', true], ['0.3.0', true], ['1.0.0', true], ['0.1.99', false],
    ['', false], ['x', false], ['0.2', false], ['v0.2.27', false], [null, false]]) {
    assert.equal((await q('select relay.setup_relogin_version_ok($1) ok', [v]))[0].ok, want, String(v))
  }
})

test('實跑：relogin 給 0.2.26 的電腦被拒（asn_outdated）且不寫進表；0.2.27 可以；install 給 0.2.26 照舊可以', { skip }, async () => {
  const { q, node, req } = await boot()
  await node('OLD', '0.2.26')
  assert.deepEqual(await req('OLD', ", p_mode => 'relogin'"), { error: 'asn_outdated' })
  assert.equal((await q("select count(*)::int n from relay.setup_requests where node = 'OLD'"))[0].n, 0)
  assert.equal((await q("select count(*)::int n from relay.account_events where event = 'setup_requested'"))[0].n, 0, '被拒的不算一次請求')
  assert.deepEqual(await req('OLD', ", p_mode => 'install'"), { ok: true, already: false, state: 'pending' })
  assert.deepEqual(await req('PC', ", p_mode => 'relogin'"), { ok: true, already: false, state: 'pending' })
})

test('實跑：沒有回報版本的設備當成舊版擋下：沒有 presence、版本空的、格式不對（relogin 不建立請求）', { skip }, async () => {
  const { db, q, node, req } = await boot()
  await db.query("insert into relay.nodes(id, owner_user, last_seen_at) values ('NOP', $1, now())", [U1])
  assert.deepEqual(await req('NOP', ", p_mode => 'relogin'"), { error: 'asn_offline' }, '沒有 presence 那一列')
  for (const [id, v] of [['EMP', ''], ['BAD', 'abc'], ['PART', '0.2'], ['NUL', null]]) {
    await db.query("insert into relay.nodes(id, owner_user, last_seen_at) values ($1, $2, now())", [id, U1])
    await db.query('insert into relay.asn_presence(node, version) values ($1, $2)', [id, v])
    assert.deepEqual(await req(id, ", p_mode => 'relogin'"), { error: 'asn_outdated' }, String(v))
  }
  assert.equal((await q('select count(*)::int n from relay.setup_requests'))[0].n, 0)
})

test('實跑：poll 的保險：取請求的那台版本空的或格式不對，不交 relogin（不會被取走）', { skip }, async () => {
  for (const v of ['', 'abc', null]) {
    const { q, req, poll } = await boot()
    await req('PC', ", p_mode => 'relogin'")
    assert.deepEqual(await poll('PC', v), { requested: false }, String(v))
    // 版本空的或格式不對：連一般的版本門檻都過不了，本來就不交（請求留著等夠新的視窗來取，或過期），絕不會變成 taken
    assert.equal((await q("select status from relay.setup_requests where node = 'PC'"))[0].status, 'pending', String(v))
  }
})

test('實跑：poll 的保險——relogin 的請求不交給 0.2.27 以前的 ASN，標成 failed 並寫明原因；install 照舊交', { skip }, async () => {
  const { q, node, req, poll } = await boot()
  await req('PC', ", p_mode => 'relogin'")
  assert.deepEqual(await poll('PC', '0.2.26'), { requested: false })
  const row = (await q("select status, detail from relay.setup_requests where node = 'PC'"))[0]
  assert.deepEqual(row, { status: 'failed', detail: '這台電腦的 ASN 版本太舊，不支援從手機重新登入，請先更新 ASN' })
  assert.deepEqual(await poll('PC', '0.2.27'), { requested: false }, '已經標成失敗，之後夠新的也不會再交')
  await node('PC2', '0.2.26')
  await req('PC2')
  assert.deepEqual(await poll('PC2', '0.2.26'), { requested: true, requested_by: U1, kind: 'claude', mode: 'install' })
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
