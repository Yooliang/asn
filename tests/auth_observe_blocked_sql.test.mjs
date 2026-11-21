// #500 拆項 3b：計數表「通過方式」接受 blocked（20261122120000_auth_observe_blocked.sql）。
// 1. 靜態：交易內、只改 via 的檢查條件（不動函式、欄位、權限）；回復檔先刪 blocked 的列再逐字還原原本的條件。
// 2. 實跑（需要 @electric-sql/pglite）：blocked 可寫入、其他值仍被拒；回復檔可套回且與原定義一致。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const MIG_DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261122120000_auth_observe_blocked.sql'
const BASE = '20261122100000_auth_observe.sql'
const DOWN = new URL('../supabase/sql/rollback/20261122120000_auth_observe_blocked_down.sql', import.meta.url)
const read = u => fs.readFileSync(u, 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const sql = read(new URL(MIG, MIG_DIR))
const down = read(DOWN)
const code = s => s.replace(/^--.*$/gm, '')
const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
const ORIGINAL_CHECK = "check (via in ('signed', 'role'))"
const NEW_CHECK = "check (via in ('signed', 'role', 'blocked'))"

test('靜態：交易內、只改 via 的檢查條件，其他一概不動', () => {
  const body = code(sql)
  assert.match(body, /^begin;$/m); assert.match(body, /^commit;$/m)
  assert.deepEqual(body.split('\n').map(l => l.trim()).filter(l => l && l !== 'begin;' && l !== 'commit;'), [
    'alter table relay.auth_observe drop constraint auth_observe_via_check;',
    `alter table relay.auth_observe add constraint auth_observe_via_check ${NEW_CHECK};`,
  ])
  assert.doesNotMatch(body, /create |grant |revoke |drop (?!constraint auth_observe_via_check)/i)
})

test('靜態：基底 migration 的 via 條件正是回復檔要還原的那一句；本 migration 排在基底之後且不重複', () => {
  assert.ok(code(read(new URL(BASE, MIG_DIR))).includes(`via text not null ${ORIGINAL_CHECK},`))
  assert.ok(files.indexOf(MIG) > files.indexOf(BASE))
  for (const f of files) {
    if (f === MIG) continue
    assert.ok(!read(new URL(f, MIG_DIR)).includes('auth_observe_via_check'), f)
  }
})

test('靜態：回復檔先刪 blocked 的列，再逐字還原原本的條件，不碰別的', () => {
  const body = code(down)
  assert.match(body, /^begin;$/m); assert.match(body, /^commit;$/m)
  assert.deepEqual(body.split('\n').map(l => l.trim()).filter(l => l && l !== 'begin;' && l !== 'commit;'), [
    "delete from relay.auth_observe where via = 'blocked';",
    'alter table relay.auth_observe drop constraint auth_observe_via_check;',
    `alter table relay.auth_observe add constraint auth_observe_via_check ${ORIGINAL_CHECK};`,
  ])
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

async function boot({ withMig = true } = {}) {
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
    if (f === MIG && !withMig) break
    if (f > MIG) break
    await db.exec(read(new URL(f, MIG_DIR)))
  }
  const q = async (text, args) => (await db.query(text, args)).rows
  return { db, q }
}
const H1 = '0123456789abcdef'
const obs = (q, a, v, s, h = H1) => q('select public.asn_relay_auth_observe($1,$2,$3,$4)', [a, v, s, h])
const checkDef = async q => (await q(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'relay.auth_observe'::regclass and conname = 'auth_observe_via_check'`)).map(r => r.d)

test('實跑：blocked 可寫入（三種簽章狀態都行），同一組累加', { skip }, async () => {
  const { q } = await boot()
  for (const s of ['absent', 'invalid', 'valid_not_owner']) await obs(q, 'acct_switch', 'blocked', s)
  await obs(q, 'acct_switch', 'blocked', 'absent')
  const rows = await q(`select via, sig, n::int n from relay.auth_observe where via = 'blocked' order by sig`)
  assert.deepEqual(rows, [{ via: 'blocked', sig: 'absent', n: 2 }, { via: 'blocked', sig: 'invalid', n: 1 }, { via: 'blocked', sig: 'valid_not_owner', n: 1 }])
})

test('實跑：signed、role 照舊可寫；其他值仍被拒', { skip }, async () => {
  const { q } = await boot()
  await obs(q, 'acct_list', 'signed', 'valid_owner')
  await obs(q, 'acct_list', 'role', 'absent')
  for (const v of ['block', 'Blocked', 'blocked ', 'other', '', null]) await assert.rejects(() => obs(q, 'acct_list', v, 'absent'), JSON.stringify(v))
  assert.equal((await q('select count(*)::int c from relay.auth_observe'))[0].c, 2)
})

test('實跑：沒套本 migration 時 blocked 寫不進去（守住「限制條件真的有被放寬」）', { skip }, async () => {
  const { q } = await boot({ withMig: false })
  await assert.rejects(() => obs(q, 'acct_switch', 'blocked', 'absent'))
})

test('實跑：回復檔把 blocked 的列刪掉、還原原條件（與基底 migration 的定義相同），別的列保留；再套 migration 也正常', { skip }, async () => {
  const { db, q } = await boot()
  const baseline = await boot({ withMig: false })
  const before = await checkDef(baseline.q)
  assert.equal(before.length, 1)
  await obs(q, 'acct_switch', 'blocked', 'absent')
  await obs(q, 'acct_switch', 'role', 'absent')
  assert.deepEqual(await checkDef(q), [before[0].replace("'role'::text", "'role'::text, 'blocked'::text")])
  await db.exec(down)
  assert.deepEqual(await checkDef(q), before)
  assert.deepEqual((await q('select via from relay.auth_observe')).map(r => r.via), ['role'])
  await assert.rejects(() => obs(q, 'acct_switch', 'blocked', 'absent'))
  await db.exec(sql)
  await obs(q, 'acct_switch', 'blocked', 'absent')
  assert.equal((await q(`select count(*)::int c from relay.auth_observe where via = 'blocked'`))[0].c, 1)
})

closeAtEnd()
