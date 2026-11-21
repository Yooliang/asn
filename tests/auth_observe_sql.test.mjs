// #500 拆項 1：特權動作通過方式的計數表（20261122100000_auth_observe.sql）。
// 1. 靜態：交易內、只新增（不改既有函式與資料表）、表欄位只有規定的六個（沒有使用者 id／email／內容／金鑰）、只授權 service_role、有 180 天清理排程、有回復檔。
// 2. 實跑（需要 @electric-sql/pglite）：累加、唯一鍵分列、格式檢查、權限、保留期清理、回復檔可套回再套上。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const MIG_DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261122100000_auth_observe.sql'
const DOWN = new URL('../supabase/sql/rollback/20261122100000_auth_observe_down.sql', import.meta.url)
const read = u => fs.readFileSync(u, 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const sql = read(new URL(MIG, MIG_DIR))
const down = read(DOWN)
const code = s => s.replace(/^--.*$/gm, '')
const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()

const COLUMNS = ['action', 'day', 'n', 'node_hash', 'sig', 'via']

test('靜態：交易內、只新增（沒有改既有函式、資料表、權限）', () => {
  const body = code(sql)
  assert.match(body, /^begin;$/m); assert.match(body, /^commit;$/m)
  const created = [...body.matchAll(/create or replace function ([\w.]+)\(/g)].map(m => m[1]).sort()
  assert.deepEqual(created, ['public.asn_relay_auth_observe', 'public.asn_relay_auth_observe_purge'])
  assert.deepEqual([...body.matchAll(/create table(?: if not exists)? ([\w.]+)/g)].map(m => m[1]), ['relay.auth_observe'])
  assert.doesNotMatch(body, /alter table (?!relay\.auth_observe)/i)
  assert.doesNotMatch(body, /drop /i)
  // 既有函式（asn_user_owns_node、acct_list、acct_switch）都沒被重寫
  for (const f of files) {
    if (f === MIG) continue
    assert.ok(!fs.readFileSync(new URL(f, MIG_DIR), 'utf8').includes('asn_relay_auth_observe'), f)
  }
})

test('靜態：函式 security definer、search_path 空、只授權 service_role；表開 RLS 且不開放給一般角色', () => {
  const body = code(sql)
  assert.equal((body.match(/security definer/g) || []).length, 2)
  assert.equal((body.match(/set search_path to ''/g) || []).length, 2)
  assert.match(body, /revoke all on function public\.asn_relay_auth_observe\(text, text, text, text\) from public, anon, authenticated;/)
  assert.match(body, /grant execute on function public\.asn_relay_auth_observe\(text, text, text, text\) to service_role;/)
  assert.match(body, /grant execute on function public\.asn_relay_auth_observe_purge\(integer\) to service_role;/)
  assert.doesNotMatch(body, /to (anon|authenticated|public)/)
  assert.match(body, /alter table relay\.auth_observe enable row level security;/)
  assert.match(body, /revoke all on relay\.auth_observe from public, anon, authenticated;/)
})

test('靜態：表欄位只有規定的六個；保留 180 天並排程', () => {
  const m = /create table if not exists relay\.auth_observe \(([\s\S]*?)\n\);/.exec(code(sql))
  assert.ok(m)
  const cols = m[1].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('primary key')).map(l => l.split(/\s+/)[0]).sort()
  assert.deepEqual(cols, COLUMNS)
  assert.match(m[1], /primary key \(day, action, via, sig, node_hash\)/)
  assert.match(code(sql), /cron\.schedule\('asn-auth-observe-purge-180d', '43 3 \* \* \*'/)
  assert.match(code(sql), /asn_relay_auth_observe_purge\(180\)/)
})

test('靜態：回復檔取消排程、drop 兩個函式與表，不碰別的', () => {
  const body = code(down)
  assert.match(body, /^begin;$/m); assert.match(body, /^commit;$/m)
  assert.match(body, /cron\.unschedule\('asn-auth-observe-purge-180d'\)/)
  assert.match(body, /drop function if exists public\.asn_relay_auth_observe_purge\(integer\);/)
  assert.match(body, /drop function if exists public\.asn_relay_auth_observe\(text, text, text, text\);/)
  assert.match(body, /drop table if exists relay\.auth_observe;/)
  assert.equal((body.match(/\bdrop\b/g) || []).length, 3)
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

async function boot({ upTo } = {}) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`)
  for (const f of files) {
    if (upTo && f >= upTo) break
    await db.exec(read(new URL(f, MIG_DIR)))
  }
  const q = async (text, args) => (await db.query(text, args)).rows
  return { db, q }
}
const H1 = '0123456789abcdef'
const H2 = 'fedcba9876543210'
const obs = (q, a, v, s, h) => q('select public.asn_relay_auth_observe($1,$2,$3,$4)', [a, v, s, h])

test('實跑：表結構只有規定的六欄，沒有任何個資欄', { skip }, async () => {
  const { q } = await boot()
  const cols = (await q(`select column_name c from information_schema.columns where table_schema='relay' and table_name='auth_observe'`)).map(r => r.c).sort()
  assert.deepEqual(cols, COLUMNS)
})

test('實跑：同一組累加、任一欄不同就另一列（四種簽章狀態與兩種通過方式都能記）', { skip }, async () => {
  const { q } = await boot()
  await obs(q, 'acct_list', 'role', 'absent', H1)
  await obs(q, 'acct_list', 'role', 'absent', H1)
  await obs(q, 'acct_list', 'role', 'absent', H1)
  await obs(q, 'acct_list', 'role', 'absent', H2)
  await obs(q, 'acct_switch', 'role', 'absent', H1)
  for (const s of ['invalid', 'valid_not_owner']) await obs(q, 'acct_list', 'role', s, H1)
  await obs(q, 'acct_list', 'signed', 'valid_owner', H1)
  const rows = await q(`select action, via, sig, node_hash, n::int n, day = (now() at time zone 'utc')::date today from relay.auth_observe order by action, via, sig, node_hash`)
  assert.equal(rows.length, 6)
  assert.ok(rows.every(r => r.today))
  assert.equal(rows.find(r => r.action === 'acct_list' && r.via === 'role' && r.sig === 'absent' && r.node_hash === H1).n, 3)
  assert.ok(rows.filter(r => !(r.sig === 'absent' && r.node_hash === H1 && r.action === 'acct_list')).every(r => r.n === 1))
  assert.deepEqual([...new Set(rows.map(r => r.sig))].sort(), ['absent', 'invalid', 'valid_not_owner', 'valid_owner'])
})

test('實跑：格式不對的值被資料表擋下（email、使用者 id、金鑰放不進去）', { skip }, async () => {
  const { q } = await boot()
  const bad = [
    ['acct_list', 'role', 'absent', 'someone@example.test'],
    ['acct_list', 'role', 'absent', '11111111-1111-1111-1111-111111111111'],
    ['acct_list', 'role', 'absent', H1 + '0'],
    ['acct_list', 'other', 'absent', H1],
    ['acct_list', 'role', 'maybe', H1],
    ['Acct List', 'role', 'absent', H1],
    [null, 'role', 'absent', H1],
  ]
  for (const args of bad) await assert.rejects(() => obs(q, ...args), JSON.stringify(args))
  assert.equal((await q('select count(*)::int c from relay.auth_observe'))[0].c, 0)
})

test('實跑：函式只有 service_role 能執行；表不開放給一般角色', { skip }, async () => {
  const { q } = await boot()
  for (const fn of ['public.asn_relay_auth_observe(text,text,text,text)', 'public.asn_relay_auth_observe_purge(integer)']) {
    const r = (await q(`select has_function_privilege('service_role', $1, 'execute') s, has_function_privilege('anon', $1, 'execute') a, has_function_privilege('authenticated', $1, 'execute') u`, [fn]))[0]
    assert.deepEqual(r, { s: true, a: false, u: false }, fn)
  }
  const t = (await q(`select has_table_privilege('anon','relay.auth_observe','select') a, has_table_privilege('authenticated','relay.auth_observe','select') u`))[0]
  assert.deepEqual(t, { a: false, u: false })
})

test('實跑：保留期清理只刪超過 180 天的列，並已排程', { skip }, async () => {
  const { q } = await boot()
  await q(`insert into relay.auth_observe(day, action, via, sig, node_hash, n) values
    ((now() at time zone 'utc')::date - 181, 'acct_list', 'role', 'absent', $1, 5),
    ((now() at time zone 'utc')::date - 180, 'acct_list', 'role', 'absent', $2, 5),
    ((now() at time zone 'utc')::date - 10, 'acct_list', 'role', 'absent', $1, 5)`, [H1, H2])
  assert.equal(Number((await q('select public.asn_relay_auth_observe_purge(180) n'))[0].n), 1)
  assert.equal((await q('select count(*)::int c from relay.auth_observe'))[0].c, 2)
  await assert.rejects(() => q('select public.asn_relay_auth_observe_purge(0)'))
  const job = await q(`select schedule, command from cron.job where jobname = 'asn-auth-observe-purge-180d'`)
  assert.equal(job.length, 1)
  assert.equal(job[0].schedule, '43 3 * * *')
  assert.match(job[0].command, /asn_relay_auth_observe_purge\(180\)/)
})

test('實跑：回復檔可套回（表、函式、排程都消失），再套一次 migration 也正常', { skip }, async () => {
  const { db, q } = await boot()
  await obs(q, 'invite', 'role', 'absent', H1)
  await db.exec(down)
  assert.equal((await q(`select count(*)::int c from pg_proc where proname like 'asn_relay_auth_observe%'`))[0].c, 0)
  assert.equal((await q(`select to_regclass('relay.auth_observe') t`))[0].t, null)
  assert.equal((await q(`select count(*)::int c from cron.job where jobname = 'asn-auth-observe-purge-180d'`))[0].c, 0)
  // 既有的函式沒被碰到
  assert.equal((await q(`select count(*)::int c from pg_proc where proname = 'asn_user_owns_node'`))[0].c, 1)
  await db.exec(sql)
  await obs(q, 'invite', 'role', 'absent', H1)
  assert.equal((await q('select n::int n from relay.auth_observe'))[0].n, 1)
})

closeAtEnd()
