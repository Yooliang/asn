// 手機換節點金鑰的伺服器端（migration 20261113300000_node_key_rotate.sql）。
// 靜態：交易內、security definer、search_path 空、只給 service_role；回復檔還原上一版 asn_relay_auth。
// 實跑（要 pglite）：換鑰成功、冪等重送、24 小時 3 次上限、舊金鑰寬限（用過新金鑰後失效、過期失效）、壞雜湊、權限、回復。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261113300000_node_key_rotate.sql'
const DOWN = new URL('../supabase/sql/rollback/20261113300000_node_key_rotate_down.sql', import.meta.url)
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const down = fs.readFileSync(DOWN, 'utf8').replace(/\r\n/g, '\n')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、security definer、search_path 空、只給 service_role', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  assert.match(code, /grant execute on function public\.asn_relay_node_rotate_key\(text, text, uuid\) to service_role;/)
  for (const m of code.matchAll(/create or replace function[\s\S]*?\$function\$;/g)) assert.match(m[0], /security definer set search_path to ''/)
  assert.match(code, /enable row level security/)
})

test('靜態：回復檔還原只認現用雜湊的 asn_relay_auth、移除新東西', () => {
  assert.match(down, /where n\.key_hash = p_key_hash and n\.status = 'active'/)
  assert.doesNotMatch(down.split('drop function')[0], /prev_key/)
  assert.match(down, /drop function if exists public\.asn_relay_node_rotate_key\(text, text, uuid\);/)
  assert.match(down, /drop table if exists relay\.node_key_rotations;/)
  for (const c of ['prev_key_hash', 'prev_key_until', 'key_rotated_at', 'rotation_id']) assert.match(down, new RegExp(`drop column if exists ${c}`))
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const PH = 'phn1a1', GONE = 'gon5e5'
const H = c => c.repeat(64)
const OLD = H('a'), N1 = H('b'), N2 = H('c'), N3 = H('d'), N4 = H('e')
const R1 = '00000000-0000-4000-8000-000000000001'
const R2 = '00000000-0000-4000-8000-000000000002'
const R3 = '00000000-0000-4000-8000-000000000003'
const R4 = '00000000-0000-4000-8000-000000000004'
const SETUP = `create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`
const SEED = `
    insert into auth.users(id, email) values ('${U1}', 'a@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine, platform) values
      ('${PH}', '手機', '${OLD}', 'bell-ph', 'member', '${T1}', '${U1}', 'active', '手機', 'android'),
      ('${GONE}', '停用的', '${H('9')}', 'bell-g', 'member', '${T1}', '${U1}', 'disabled', '手機', 'android');`
async function boot() {
  const db = track(new PGlite())
  await db.exec(SETUP)
  for (const f of files) await db.exec(read(f))
  await db.exec(SEED)
  return db
}
const rot = async (db, hash, id, node = PH) => (await db.query(`select public.asn_relay_node_rotate_key($1, $2, $3) r`, [node, hash, id])).rows[0].r
const auth = async (db, hash) => (await db.query(`select * from public.asn_relay_auth($1)`, [hash])).rows
const row = async db => (await db.query(`select key_hash, prev_key_hash, prev_key_until, rotation_id, key_rotated_at from relay.nodes where id = $1`, [PH])).rows[0]
const count = async db => (await db.query(`select count(*)::int n from relay.node_key_rotations`)).rows[0].n

test('換鑰成功：現用換新、舊的留作寬限 10 分鐘、記一筆', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await rot(db, N1, R1), { ok: true })
  const r = await row(db)
  assert.equal(r.key_hash, N1); assert.equal(r.prev_key_hash, OLD); assert.equal(r.rotation_id, R1); assert.ok(r.key_rotated_at)
  const mins = (await db.query(`select extract(epoch from (prev_key_until - now()))/60 m from relay.nodes where id = $1`, [PH])).rows[0].m
  assert.ok(mins > 9 && mins <= 10, `寬限約 10 分鐘：${mins}`)
  assert.equal(await count(db), 1)
})

test('冪等：同一次換鑰重送回 ok、不重複記、不動寬限', { skip }, async () => {
  const db = await boot()
  await rot(db, N1, R1)
  const before = await row(db)
  assert.deepEqual(await rot(db, N1, R1), { ok: true })
  assert.deepEqual(await row(db), before)
  assert.equal(await count(db), 1)
})

test('限流：滾動 24 小時最多 3 次，第 4 次 rate_limited；超過 24 小時的不算', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await rot(db, N1, R1), { ok: true })
  assert.deepEqual(await rot(db, N2, R2), { ok: true })
  assert.deepEqual(await rot(db, N3, R3), { ok: true })
  assert.deepEqual(await rot(db, N4, R4), { error: 'rate_limited' })
  assert.equal((await row(db)).key_hash, N3, '被擋的那次沒有生效')
  await db.query(`update relay.node_key_rotations set at = now() - interval '25 hours' where at = (select min(at) from relay.node_key_rotations)`)
  assert.deepEqual(await rot(db, N4, R4), { ok: true })
})

test('限流：超過 7 天的紀錄順手清掉', { skip }, async () => {
  const db = await boot()
  await db.query(`insert into relay.node_key_rotations(node, at) values ($1, now() - interval '8 days')`, [PH])
  await rot(db, N1, R1)
  assert.equal(await count(db), 1)
})

test('舊金鑰：寬限內可用；新金鑰用過一次後舊的失效', { skip }, async () => {
  const db = await boot()
  assert.equal((await auth(db, OLD)).length, 1)
  await rot(db, N1, R1)
  const o = await auth(db, OLD)
  assert.equal(o.length, 1, '寬限內舊金鑰還能認證'); assert.equal(o[0].id, PH)
  const n = await auth(db, N1)
  assert.equal(n.length, 1); assert.deepEqual(Object.keys(n[0]).sort(), ['bell_topic', 'can_invite', 'id', 'role', 'tenant_id'])
  assert.equal((await auth(db, OLD)).length, 0, '用過新金鑰後舊的失效')
  const r = await row(db)
  assert.equal(r.prev_key_hash, null); assert.equal(r.prev_key_until, null)
  assert.equal((await auth(db, N1)).length, 1)
})

test('舊金鑰：過了寬限就失效；新金鑰照常', { skip }, async () => {
  const db = await boot()
  await rot(db, N1, R1)
  await db.query(`update relay.nodes set prev_key_until = now() - interval '1 second' where id = $1`, [PH])
  assert.equal((await auth(db, OLD)).length, 0)
  assert.equal((await auth(db, N1)).length, 1)
})

test('壞輸入：格式不對、等於現用、等於寬限中的舊雜湊、停用或不存在的節點', { skip }, async () => {
  const db = await boot()
  for (const bad of ['abc', H('A'), 'g'.repeat(64), 'a'.repeat(63), null, '']) assert.deepEqual(await rot(db, bad, R1), { error: 'bad_request' }, String(bad))
  assert.deepEqual(await rot(db, N1, null), { error: 'bad_request' })
  assert.deepEqual(await rot(db, OLD, R1), { error: 'bad_request' }, '等於現用')
  await rot(db, N1, R1)
  assert.deepEqual(await rot(db, OLD, R2), { error: 'bad_request' }, '等於寬限中的舊雜湊')
  assert.deepEqual(await rot(db, N1, R2), { error: 'bad_request' }, '新的 rotation_id 但等於現用')
  assert.deepEqual(await rot(db, N2, R2, GONE), { error: 'not_found' })
  assert.deepEqual(await rot(db, N2, R2, 'nobody'), { error: 'not_found' })
  assert.equal(await count(db), 1, '失敗的不記')
})

test('權限：只有 service_role 能執行換鑰；紀錄表不給 anon／authenticated', { skip }, async () => {
  const db = await boot()
  const can = async role => (await db.query(`select has_function_privilege('${role}', 'public.asn_relay_node_rotate_key(text, text, uuid)', 'execute') ok`)).rows[0].ok
  assert.equal(await can('service_role'), true)
  for (const r of ['anon', 'authenticated']) assert.equal(await can(r), false, r)
  for (const r of ['anon', 'authenticated']) assert.equal((await db.query(`select has_table_privilege('${r}', 'relay.node_key_rotations', 'select') ok`)).rows[0].ok, false)
})

test('回復：auth 只認現用雜湊、新東西都移除；已換過的新金鑰照常可用', { skip }, async () => {
  const db = await boot()
  await rot(db, N1, R1)
  await db.exec(down)
  assert.equal((await auth(db, OLD)).length, 0, '寬限的舊金鑰回復後失效')
  assert.equal((await auth(db, N1)).length, 1)
  assert.equal((await db.query(`select count(*)::int n from information_schema.columns where table_schema='relay' and table_name='nodes' and column_name in ('prev_key_hash','prev_key_until','key_rotated_at','rotation_id')`)).rows[0].n, 0)
  assert.equal((await db.query(`select to_regclass('relay.node_key_rotations') t`)).rows[0].t, null)
  assert.equal((await db.query(`select count(*)::int n from pg_proc where proname = 'asn_relay_node_rotate_key'`)).rows[0].n, 0)
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
