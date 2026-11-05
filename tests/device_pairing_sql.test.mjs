// 設備配對（migration 20261105140000_device_pairing.sql）。
// 靜態：交易內、函式只給 service_role、表開 RLS。實跑（要 pglite）：簽章、兩台都是本人的、只有對方能確認、
// 7 天過期、同一對一筆、頻率上限、撤回、別人碰不到。還原驗證：拿掉保護要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261105140000_device_pairing.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、函式只給 service_role、表開 RLS', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /drop table|drop column|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  for (const t of ['device_keys', 'device_pairs']) {
    assert.match(code, new RegExp(`alter table relay\\.${t} enable row level security`))
    assert.match(code, new RegExp(`revoke all on relay\\.${t} from public, anon, authenticated`))
  }
  assert.deepEqual([...new Set(code.match(/delete from [a-z_.]+/g))], ['delete from relay.device_pairs'], '只清自己的表')
  assert.ok(!code.includes('asn_relay_device_pair_expire() to service_role'))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001', T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const D = 'wrk9b2', Z = 'hom7a1', Q = 'qqq3c4'
const PD = 'd'.repeat(43), PZ = 'z'.repeat(43), SIG = 's'.repeat(86)

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
      ('${D}', '工作機', 'k1', 'bell-d', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Z}', '家用機', 'k2', 'bell-z', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Q}', '財務室', 'k3', 'bell-q', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  return (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => args[k]))).rows[0].r
}
const publish = (db, node, pub) => rpc(db, 'asn_relay_device_key_publish', { p_node: node, p_sign_pub: pub })
const start = (db, o = {}) => rpc(db, 'asn_relay_device_pair_start', { p_actor: D, p_signed_user: U1, p_to_node: Z, p_from_pub: PD, ...o })
const decide = (db, id, o = {}) => rpc(db, 'asn_relay_device_pair_decide', { p_actor: Z, p_signed_user: U1, p_id: id, p_decision: 'confirm', p_sig: SIG, ...o })
const list = (db, actor = Z, user = U1) => rpc(db, 'asn_relay_device_pair_list', { p_actor: actor, p_signed_user: user })

async function ready(opts) {
  const db = await boot(opts)
  await publish(db, D, PD); await publish(db, Z, PZ); await publish(db, Q, 'q'.repeat(43))
  return db
}

test('整條路：發起、對方看到、確認帶簽章、發起方拿到簽章', { skip }, async () => {
  const db = await ready()
  const s = await start(db)
  assert.equal(s.to_pub, PZ)
  assert.equal(s.to_name, '家用機')
  assert.equal(s.bell_topic, 'bell-z')
  const l = await list(db)
  assert.equal(l.incoming[0].from_pub, PD)
  assert.equal(l.incoming[0].to_pub, PZ)
  assert.equal(l.incoming[0].from_name, '工作機')
  assert.equal((await decide(db, s.id)).status, 'confirmed')
  const o = await list(db, D)
  assert.equal(o.outgoing[0].status, 'confirmed')
  assert.equal(o.outgoing[0].confirm_sig, SIG)
  assert.equal((await list(db)).incoming.length, 0)
})

test('誰能動：要簽章、兩台都是本人的；發起方不能替對方確認', { skip }, async () => {
  const db = await ready()
  assert.equal((await start(db, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await start(db, { p_to_node: Q })).error, 'forbidden', '別人的電腦')
  assert.equal((await start(db, { p_signed_user: U2 })).error, 'forbidden')
  assert.equal((await start(db, { p_to_node: D })).error, 'bad_request', '不能配自己')
  const s = await start(db)
  assert.equal((await decide(db, s.id, { p_actor: D })).error, 'not_found', '發起方不能替對方確認')
  assert.equal((await decide(db, s.id, { p_actor: Q, p_signed_user: U2 })).error, 'not_found')
  assert.equal((await decide(db, s.id, { p_signed_user: U2 })).error, 'forbidden')
  assert.equal((await decide(db, s.id, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await decide(db, s.id, { p_sig: null })).error, 'bad_request', '確認一定要簽章')
  assert.equal((await list(db, Q, U2)).incoming.length, 0)
  assert.equal((await list(db, D, null)).error, 'forbidden')
  assert.equal((await list(db)).incoming.length, 1, '都沒有生效')
})

test('舊版沒有公鑰：說得清楚；同一對一筆；決定只能一次', { skip }, async () => {
  const db = await boot()
  assert.equal((await start(db)).error, 'no_key')
  await publish(db, Z, PZ)
  const s = await start(db)
  assert.equal((await start(db)).error, 'busy')
  assert.equal((await decide(db, s.id, { p_decision: 'reject', p_sig: null })).status, 'rejected')
  assert.equal((await decide(db, s.id)).error, 'not_found')
  assert.ok((await start(db)).id, '結案後可以再發')
})

test('7 天過期；發起方撤回；一天後清掉', { skip }, async () => {
  const db = await ready()
  const s = await start(db)
  const left = (await db.query(`select extract(epoch from expires_at - created_at)::int e from relay.device_pairs where id = $1`, [s.id])).rows[0].e
  assert.equal(left, 7 * 86400)
  await db.query(`update relay.device_pairs set expires_at = now() - interval '1 second' where id = $1`, [s.id])
  assert.equal((await decide(db, s.id)).error, 'not_found')
  assert.equal((await list(db, D)).outgoing[0].status, 'expired')
  const c = await start(db)
  assert.equal((await rpc(db, 'asn_relay_device_pair_close', { p_actor: Q, p_signed_user: U2, p_id: c.id })).error, 'not_found')
  assert.deepEqual(await rpc(db, 'asn_relay_device_pair_close', { p_actor: D, p_signed_user: U1, p_id: c.id }), { ok: true })
  assert.equal((await decide(db, c.id)).error, 'not_found')
  await db.exec(`update relay.device_pairs set decided_at = now() - interval '2 days'`)
  await list(db)
  assert.equal((await db.query(`select count(*)::int n from relay.device_pairs`)).rows[0].n, 0)
})

test('已確認的列等 D 來領，最多 7 天；其他結案的一天後清掉', { skip }, async () => {
  const db = await ready()
  const s = await start(db)
  await decide(db, s.id)
  await db.query(`update relay.device_pairs set decided_at = now() - interval '6 days' where id = $1`, [s.id])
  const o = await list(db, D)
  assert.equal(o.outgoing[0].status, 'confirmed', 'D 隔幾天才開機也領得到')
  assert.equal(o.outgoing[0].confirm_sig, SIG)
  await db.query(`update relay.device_pairs set decided_at = now() - interval '8 days' where id = $1`, [s.id])
  assert.equal((await list(db, D)).outgoing.length, 0, '最多 7 天')
  const r = await start(db)
  await decide(db, r.id, { p_decision: 'reject', p_sig: null })
  await db.query(`update relay.device_pairs set decided_at = now() - interval '2 days' where id = $1`, [r.id])
  assert.equal((await list(db, D)).outgoing.length, 0, '拒絕的一天後清掉')
})

test('刪節點會連帶清掉，不會被擋住', { skip }, async () => {
  const db = await ready()
  await start(db)
  await db.exec(`delete from relay.nodes where id = '${Z}'`)
  assert.equal((await db.query(`select count(*)::int n from relay.device_pairs`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int n from relay.device_keys where node = '${Z}'`)).rows[0].n, 0)
})

test('頻率上限；公鑰格式；重裝可以換公鑰', { skip }, async () => {
  const db = await ready()
  await db.exec(`insert into relay.device_pairs (from_node, to_node, from_pub, to_pub, status, decided_at)
    select '${D}', '${Z}', '${PD}', '${PZ}', 'cancelled', now() from generate_series(1, 20)`)
  assert.equal((await start(db)).error, 'rate_limited')
  assert.equal((await publish(db, D, 'x')).error, 'bad_request')
  assert.equal((await publish(db, 'nope', PD)).error, 'not_found')
  await publish(db, Z, 'n'.repeat(43))
  assert.equal((await db.query(`select sign_pub from relay.device_keys where node = '${Z}'`)).rows[0].sign_pub, 'n'.repeat(43))
})

test('權限：anon、authenticated 不能呼叫函式或讀表', { skip }, async () => {
  const db = await ready()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_device_pair_list('x', null)`), role)
    await assert.rejects(db.query(`select * from relay.device_pairs`), role)
    await assert.rejects(db.query(`select * from relay.device_keys`), role)
    await db.exec('reset role')
  }
})

test('還原驗證：拿掉「只有對方能確認」要變紅', { skip }, async () => {
  const db = await ready({ mutate: { [MIG]: s => s.replace(`or r.to_node <> p_actor then`, `then`) } })
  const s = await start(db)
  assert.equal((await decide(db, s.id, { p_actor: D })).status, 'confirmed')
})
