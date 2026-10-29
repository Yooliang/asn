// 設備順序同步（migration 20261025010000_account_device_prefs.sql）。
// 1. 靜態：交易內、不刪資料、新函式只授權 service_role。
// 2. 實跑（需要 @electric-sql/pglite）：讀（沒設過 null）、寫、驗證（壞值 bad_request）、
//    內容相同不動（rev／at 不變）、rev 較舊或一樣不覆蓋（stale）、2 秒內連寫不同內容 rate_limited、
//    別人的帳號互不影響、不影響 ai_wake_limit。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261025010000_account_device_prefs.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、只授權 service_role；是最新一份 migration', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /grant execute on function public\.asn_account_device_prefs\(uuid, jsonb\) to service_role;/)
  assert.equal(files.at(-1) >= MIG, true)
})

test('靜態：鎖定版 migration 讀帳號那一列時有 for update，且簽名與授權不變（#253）', () => {
  const sql = read('20261025040000_account_device_prefs_lock.sql')
  assert.match(sql, /select \* into v_t from relay\.tenants where owner_user = p_user for update;/)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /grant execute on function public\.asn_account_device_prefs\(uuid, jsonb\) to service_role;/)
  // 原本的 migration 已部署，不改
  assert.doesNotMatch(read(MIG), /for update/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111' // 主持人
const U2 = '22222222-2222-2222-2222-222222222222' // 受邀的人
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const A = `${W1}~財務`, B = `${W1}~w1`, C = `${W1}~w2`

async function boot({ mutate } = {}) {
  const db = new PGlite()
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
    let sql = read(f)
    if (mutate && mutate[f]) sql = mutate[f](sql)
    await db.exec(sql)
  }
  await db.exec(`
    insert into auth.users(id, email) values ('${U1}', 'a@x.y'), ('${U2}', 'b@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良'), ('${T2}', '${U2}', '財務員');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${P1}', '小良的手機', 'k1', 'bell-p1', 'member', '${T1}', '${U1}', 'active', '手機'),
      ('${W1}', '工作機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');
    insert into relay.roster(node, name, engine) values ('${W1}', '財務', 'claude'), ('${W1}', 'w1', 'claude'), ('${W1}', 'w2', 'claude'),
      ('${Q2}', '助理', 'claude');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${k === 'p_prefs' ? 'jsonb' : 'uuid'}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => (k === 'p_prefs' && args[k] !== null ? JSON.stringify(args[k]) : args[k])))).rows[0].r
}
const get = (db, user = U1) => rpc(db, 'asn_account_device_prefs', { p_user: user })
const put = (db, prefs, user = U1) => rpc(db, 'asn_account_device_prefs', { p_user: user, p_prefs: prefs })
const P = (rev, extra = {}) => ({ order: ['a1', 'b2'], shown: ['c3'], removed: [], rev, ...extra })
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('實跑：沒設過是 null；寫入後讀得回來（rev 保留、at 由伺服器填）', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await get(db), { prefs: null })
  const w = await put(db, P(1000))
  assert.deepEqual(w.prefs.order, ['a1', 'b2']); assert.equal(w.prefs.rev, 1000); assert.ok(w.prefs.at > 1_700_000_000_000)
  assert.deepEqual((await get(db)).prefs, w.prefs)
  assert.equal((await rpc(db, 'asn_account_settings', { p_user: U1 })).ai_wake_limit, 20, '不影響 ai_wake_limit')
})

test('實跑：內容相同不動（rev、at 都不變）；rev 一樣或較舊但內容不同不覆蓋並標 stale', { skip }, async () => {
  const db = await boot()
  const w = await put(db, P(1000))
  const same = await put(db, P(5000))
  assert.deepEqual(same, { prefs: w.prefs }, '內容相同：回現有的、不升 rev')
  const older = await put(db, P(900, { order: ['b2', 'a1'] }))
  assert.equal(older.stale, true); assert.deepEqual(older.prefs, w.prefs)
  const equal = await put(db, P(1000, { order: ['b2', 'a1'] }))
  assert.equal(equal.stale, true); assert.deepEqual((await get(db)).prefs.order, ['a1', 'b2'])
})

test('實跑：rev 較新才覆蓋；2 秒內連續寫不同內容 rate_limited，過了 2 秒才行', { skip }, async () => {
  const db = await boot()
  await put(db, P(1000))
  assert.deepEqual(await put(db, P(2000, { order: ['b2', 'a1'] })), { error: 'rate_limited' })
  assert.deepEqual((await get(db)).prefs.order, ['a1', 'b2'], '被擋的沒寫進去')
  await sleep(2100)
  const ok = await put(db, P(2000, { order: ['b2', 'a1'] }))
  assert.deepEqual(ok.prefs.order, ['b2', 'a1']); assert.equal(ok.prefs.rev, 2000)
})

test('實跑：壞值一律 bad_request 且不寫入；沒有這個帳號 not_found；空帳號 bad_request', { skip }, async () => {
  const db = await boot()
  const bads = [
    { ...P(1), order: 'a' }, { ...P(1), shown: [1] }, { ...P(1), removed: ['a b'] }, { ...P(1), order: ['a', 'a'] },
    { ...P(1), order: Array.from({ length: 201 }, (_, i) => 'n' + i) }, { ...P(1), rev: -1 }, { ...P(1), rev: 1.5 }, { ...P(1), rev: '1' },
    { order: [], shown: [], removed: [] }, { ...P(1), order: ['x'.repeat(33)] }, [],
  ]
  for (const b of bads) assert.deepEqual(await put(db, b), { error: 'bad_request' }, JSON.stringify(b).slice(0, 60))
  assert.deepEqual(await get(db), { prefs: null })
  assert.equal((await get(db, '99999999-9999-9999-9999-999999999999')).error, 'not_found')
  assert.equal((await rpc(db, 'asn_account_device_prefs', { p_user: null })).error, 'bad_request')
})

test('實跑：兩個帳號互不影響；空陣列也能存（把全部清掉也是一種狀態）', { skip }, async () => {
  const db = await boot()
  await put(db, P(1000), U1)
  assert.deepEqual(await get(db, U2), { prefs: null })
  const e = await put(db, { order: [], shown: [], removed: [], rev: 3000 }, U2)
  assert.deepEqual(e.prefs.order, []); assert.deepEqual((await get(db, U1)).prefs.order, ['a1', 'b2'])
})
