// #2161 第 2b 段：public.asn_relay_report_readers（migration 20261125200000_report_readers_wrapper.sql）。
// 靜態：交易內、不刪資料、有回復說明與回復檔、授權、無裸 3 分鐘字面量。
// 實跑（pglite，載入全部真實 migration 鏈）：排除寫入者自己、self／owner／room 各一個有權與無權案例、節點不存在／kind 沒登記回空、授權。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

closeAtEnd()

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261125200000_report_readers_wrapper.sql'
const DOWN = new URL('../supabase/sql/rollback/20261125200000_report_readers_wrapper_down.sql', import.meta.url)
const norm = s => s.replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const read = f => norm(fs.readFileSync(new URL(f, DIR), 'utf8'))
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、不刪資料、有回復說明與回復檔、只授權 service_role、search_path 空、不改 2a 的函式、無裸 3 分鐘', () => {
  assert.ok(files.includes(MIG))
  assert.ok(files.indexOf(MIG) > files.indexOf('20261125100000_report_bus.sql'), '排在 2a 之後')
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.match(sql, /^-- 回復：supabase\/sql\/rollback\/20261125200000_report_readers_wrapper_down\.sql/m)
  assert.ok(fs.existsSync(DOWN))
  const down = fs.readFileSync(DOWN, 'utf8')
  assert.ok(down.includes('drop function if exists public.asn_relay_report_readers(text, text);'))
  assert.deepEqual(down.split(String.fromCharCode(10)).map(l => l.trim()).filter(l => l && !l.startsWith('--') && l !== 'begin;' && l !== 'commit;'), ['drop function if exists public.asn_relay_report_readers(text, text);'], '回復檔只 drop 這一支')
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  const outside = code.replace(/\$function\$[\s\S]*?\$function\$/g, 'BODY')
  assert.doesNotMatch(outside, /drop table|drop column|delete from|truncate|drop function|update relay|create table/i)
  assert.equal([...code.matchAll(/create or replace function ([\w.]+)\(/g)].map(m => m[1]).join(), 'public.asn_relay_report_readers', '只新增這一支函式')
  assert.match(code, /security definer\s+set search_path to ''/)
  assert.ok(code.includes('revoke all on function public.asn_relay_report_readers(text, text) from public, anon, authenticated;'))
  assert.ok(code.includes('grant execute on function public.asn_relay_report_readers(text, text) to service_role;'))
  assert.equal((code.match(/grant execute/g) ?? []).length, 1)
  assert.match(code, /where n\.id <> p_node/, '排除寫入者自己')
  assert.doesNotMatch(code, /'\s*3\s+min|'\s*180\s+sec|00:03:00|mins\s*=>\s*3\b|secs\s*=>\s*180\b/i)
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const SETUP = `create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-1111-1111-1111-111111111111'
const T2 = 'bbbbbbbb-2222-2222-2222-222222222222'

// 場景：T1 有 U1 的 a、b、c、無擁有者的 d、已撤銷的 off；T2 有 U2 的 x。群組 g1（T1）有 a、b~w1、d；群組 g2（T1，已封存）有 a、c。
async function boot() {
  const db = track(new PGlite())
  await db.exec(SETUP)
  for (const f of files) await db.exec(read(f))
  await db.exec(`insert into auth.users (id, email) values ('${U1}', 'u1@example.com'), ('${U2}', 'u2@example.com');
    insert into relay.tenants (id, owner_user) values ('${T1}', '${U1}'), ('${T2}', '${U2}');`)
  let seq = 0
  const node = (id, o = {}) => db.query(`insert into relay.nodes (id, name, key_hash, bell_topic, status, tenant_id, owner_user)
    values ($1, $1, $2, $3, $4, $5, $6)`, [id, `kh-${id}-${++seq}`, `bt-${id}`, o.status ?? 'active', o.tenant ?? T1, o.user === undefined ? U1 : o.user])
  for (const n of ['a', 'b', 'c']) await node(n)
  await node('d', { user: null }); await node('off', { status: 'left' }); await node('x', { tenant: T2, user: U2 })
  const room = async (id, tenant, members, archived = null) => {
    await db.query('insert into relay.rooms (id, name, created_by, tenant_id, archived_at) values ($1, $1, $2, $3, $4)', [id, members[0], tenant, archived])
    for (const m of members) await db.query('insert into relay.room_members (room_id, member) values ($1, $2)', [id, m])
  }
  await room('g1', T1, ['a', 'b~w1', 'd']); await room('g2', T1, ['a', 'c'], '2026-01-01T00:00:00Z')
  for (const [k, scope] of [['ks', 'self'], ['ko', 'owner'], ['kr', 'room']]) {
    await db.query(`insert into relay.report_kinds (kind, spec, read_scope) values ($1, '{"fields":{"v":{"type":"int"}}}'::jsonb, $2)`, [k, scope])
  }
  return {
    db,
    r: async (node, kind) => (await db.query('select public.asn_relay_report_readers($1, $2) r', [node, kind])).rows[0].r,
  }
}

test('排除寫入者自己：owner 範圍 a 的讀者是 b、c（沒有 a）；bell_topics 與 readers 一一對應', { skip }, async () => {
  const b = await boot()
  const r = await b.r('a', 'ko')
  assert.deepEqual(r.readers, ['b', 'c'])
  assert.deepEqual(r.bell_topics, ['bt-b', 'bt-c'])
  assert.ok(!r.readers.includes('a'))
  // 前提：2a 的原函式確實含自己（排除是這支包裝做的，不是原函式本來就沒有）
  assert.deepEqual((await b.db.query("select relay.report_readers('a', 'ko') r")).rows.map(x => x.r), ['a', 'b', 'c'])
})

test('self：沒有其他讀者（只有自己 → 空）', { skip }, async () => {
  const b = await boot()
  assert.deepEqual(await b.r('a', 'ks'), { readers: [], bell_topics: [] })
})

test('owner：同擁有者的 b、c 有權；無擁有者的 d、別人的 x 無權；無擁有者的 d 寫入時沒有讀者', { skip }, async () => {
  const b = await boot()
  const r = (await b.r('b', 'ko')).readers
  assert.deepEqual(r, ['a', 'c'])
  assert.ok(!r.includes('d') && !r.includes('x'))
  assert.deepEqual((await b.r('d', 'ko')).readers, [])
  assert.deepEqual((await b.r('x', 'ko')).readers, [])
})

test('room：同未封存群組現任成員有權（含「節點~視窗」成員鍵）；只在封存群組的 c、跨租戶的 x 無權', { skip }, async () => {
  const b = await boot()
  assert.deepEqual((await b.r('a', 'kr')).readers, ['b', 'd'])
  assert.deepEqual((await b.r('d', 'kr')).readers, ['a', 'b'])
  assert.ok(!(await b.r('a', 'kr')).readers.includes('c'))
  assert.deepEqual((await b.r('c', 'kr')).readers, [])
  await b.db.exec("update relay.room_members set left_at = now() where room_id = 'g1' and member = 'd'")
  assert.deepEqual((await b.r('a', 'kr')).readers, ['b'], '已退出的成員不再收到')
})

test('節點不存在／已撤銷、kind 沒登記或停用、null：回空陣列不報錯', { skip }, async () => {
  const b = await boot()
  const empty = { readers: [], bell_topics: [] }
  assert.deepEqual(await b.r('ghost', 'ko'), empty)
  assert.deepEqual(await b.r('off', 'ko'), empty)
  assert.deepEqual(await b.r('a', 'nokind'), empty)
  assert.deepEqual(await b.r(null, 'ko'), empty)
  assert.deepEqual(await b.r('a', null), empty)
  await b.db.exec("update relay.report_kinds set enabled = false where kind = 'ko'")
  assert.deepEqual(await b.r('a', 'ko'), empty)
})

test('已撤銷的讀者不收門鈴', { skip }, async () => {
  const b = await boot()
  await b.db.exec("update relay.nodes set status = 'left' where id = 'c'")
  assert.deepEqual((await b.r('a', 'ko')).readers, ['b'])
})

test('授權：anon／authenticated 不能執行，service_role 可以；security definer、search_path 空', { skip }, async () => {
  const b = await boot()
  const f = (await b.db.query(`select has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth,
    has_function_privilege('service_role', p.oid, 'execute') svc, p.prosecdef sd, p.proconfig::text cfg
    from pg_proc p where p.proname = 'asn_relay_report_readers'`)).rows
  assert.equal(f.length, 1)
  assert.equal(f[0].anon, false); assert.equal(f[0].auth, false); assert.equal(f[0].svc, true); assert.equal(f[0].sd, true)
  assert.match(f[0].cfg, /search_path/)
})
