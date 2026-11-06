// 別台看畫面的控制面（migration 20261107110000_term_views.sql）。
// 靜態：沒有畫面欄位、函式只給 service_role、表開 RLS。實跑（要 pglite）：本人、兩台都是本人的、只有被看的能接受、
// 上限、到期、固定狀態、結束就清金鑰材料、D 不見了 T 看得到。還原驗證：拿掉保護要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID as uuid } from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261107110000_term_views.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：沒有放內容的欄位、函式只給 service_role、表開 RLS', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /drop table|drop column|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /alter table relay\.term_views enable row level security/)
  assert.match(code, /revoke all on relay\.term_views from public, anon, authenticated/)
  const table = code.slice(code.indexOf('create table if not exists relay.term_views'), code.indexOf('create index'))
  for (const banned of ['frame', 'screen', 'payload', 'jsonb']) assert.ok(!table.includes(banned), banned)
  const cols = [...table.matchAll(/^ {2}([a-z_]+) (text|uuid|timestamptz)/gm)].map(m => m[1])
  assert.deepEqual(cols, ['id', 'from_node', 'to_node', 'window_name', 'topic', 'd_eph_pub', 'd_sig', 't_eph_pub', 't_sig', 'status', 'end_reason', 'viewer_seen_at', 'created_at', 'expires_at', 'ended_at'], '欄位有變要重審：不能多放內容')
  assert.ok(!code.includes('asn_relay_term_view_expire() to service_role'))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001', T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const D = 'wrk9b2', Z = 'hom7a1', Q = 'qqq3c4', X = 'lap5d6'
const PUB = 'a'.repeat(43), TSIG = 'b'.repeat(86), DSIG = 'c'.repeat(342)

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
      ('${X}', '筆電', 'k4', 'bell-x', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Q}', '財務室', 'k3', 'bell-q', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  return (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => args[k]))).rows[0].r
}
const soon = () => new Date(Date.now() + 9 * 60_000).toISOString()
const start = (db, o = {}) => rpc(db, 'asn_relay_term_view_start', { p_actor: D, p_signed_user: U1, p_id: uuid(), p_to_node: Z, p_window_name: '小乙', p_d_eph_pub: PUB, p_d_sig: DSIG, p_expires_at: soon(), ...o })
const accept = (db, id, o = {}) => rpc(db, 'asn_relay_term_view_accept', { p_node: Z, p_id: id, p_t_eph_pub: PUB, p_t_sig: TSIG, ...o })
const report = (db, id, state = null, o = {}) => rpc(db, 'asn_relay_term_view_report', { p_actor: D, p_signed_user: U1, p_id: id, p_state: state, ...o })
const pending = (db, node = Z) => rpc(db, 'asn_relay_term_view_pending', { p_node: node })
const row = async (db, id) => (await db.query('select * from relay.term_views where id = $1', [id])).rows[0]

test('整條路：發起、T 領到、接受、D 拿到公鑰、回報、結束清金鑰材料', { skip }, async () => {
  const db = await boot()
  const s = await start(db)
  assert.match(s.topic, /^tv_[0-9a-f]{64}$/)
  assert.equal(s.bell_topic, 'bell-z')
  const p = await pending(db)
  assert.equal(p.requests[0].from_name, '工作機')
  assert.equal(p.requests[0].d_sig, DSIG)
  assert.equal(p.requests[0].topic, s.topic)
  const whole = new Date(Math.floor(Date.now() / 1000 + 300) * 1000)
  const w = await start(db, { p_window_name: '整數秒', p_expires_at: whole.toISOString() })
  assert.equal((await pending(db)).requests.find(q => q.id === w.id).expires_s, whole.getTime() / 1000, '簽進去的秒數要回得來，簽章才對得上')
  await report(db, w.id, 'ended')
  assert.deepEqual(await accept(db, s.id), { ok: true })
  const r = await report(db, s.id)
  assert.equal(r.status, 'accepted')
  assert.equal(r.t_sig, TSIG)
  assert.equal((await report(db, s.id, 'watching')).status, 'watching')
  assert.equal((await report(db, s.id, 'paused')).status, 'paused')
  assert.equal((await pending(db)).active[0].status, 'paused')
  const e = await report(db, s.id, 'ended')
  assert.equal(e.status, 'ended')
  assert.equal(e.end_reason, 'viewer_ended')
  assert.equal(e.t_sig, null)
  const x = await row(db, s.id)
  for (const k of ['topic', 'd_eph_pub', 'd_sig', 't_eph_pub', 't_sig']) assert.equal(x[k], null, k)
  assert.equal((await pending(db)).active.length, 0)
})

test('誰能動：要簽章、兩台都是本人的；只有被看的那台能接受和結束；D 不能替 T 接受', { skip }, async () => {
  const db = await boot()
  assert.equal((await start(db, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await start(db, { p_to_node: Q })).error, 'forbidden', '別人的電腦')
  assert.equal((await start(db, { p_signed_user: U2 })).error, 'forbidden')
  assert.equal((await start(db, { p_to_node: D })).error, 'bad_request', '不能看自己')
  const s = await start(db)
  assert.equal((await accept(db, s.id, { p_node: D })).error, 'not_found', 'D 不能替 T 接受')
  assert.equal((await accept(db, s.id, { p_node: Q })).error, 'not_found')
  assert.equal((await pending(db, Q)).requests.length, 0, '別人看不到')
  assert.equal((await rpc(db, 'asn_relay_term_view_stop', { p_node: Q, p_id: s.id, p_reason: 'rejected' })).error, 'not_found')
  assert.equal((await report(db, s.id, null, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await report(db, s.id, null, { p_actor: Z })).error, 'not_found', 'T 不能用這條路')
  assert.equal((await report(db, s.id, null, { p_actor: Q, p_signed_user: U2 })).error, 'not_found')
  assert.equal((await row(db, s.id)).status, 'requested')
})

test('參數：到期最多 10 分鐘、過去的不行；session id 不能重用；簽章和公鑰要對格式', { skip }, async () => {
  const db = await boot()
  const later = m => new Date(Date.now() + m * 60_000).toISOString()
  assert.equal((await start(db, { p_expires_at: later(11) })).error, 'bad_request')
  assert.equal((await start(db, { p_expires_at: later(-1) })).error, 'bad_request')
  for (const o of [{ p_d_eph_pub: 'x' }, { p_d_sig: 'x' }, { p_window_name: '' }, { p_window_name: 'a\nb' }]) {
    assert.equal((await start(db, o)).error, 'bad_request', JSON.stringify(o))
  }
  const id = uuid()
  assert.ok((await start(db, { p_id: id })).id)
  assert.equal((await start(db, { p_id: id, p_window_name: '別的' })).error, 'bad_request', '進行中重用')
  await report(db, id, 'ended')
  assert.equal((await start(db, { p_id: id })).error, 'bad_request', '結束後也不能重用')
  const s = await start(db)
  assert.equal((await accept(db, s.id, { p_t_sig: DSIG })).error, 'bad_request')
})

test('上限：同一對同一視窗只留最新；被看的那台同時 3 個；每小時 30 次', { skip }, async () => {
  const db = await boot()
  const old = await start(db)
  const s = await start(db)
  assert.notEqual(s.id, old.id, 'D 重開後再發起同一視窗：開新的')
  const was = await row(db, old.id)
  assert.equal(was.status, 'ended', '舊的結束')
  assert.equal(was.end_reason, 'viewer_ended')
  assert.equal(was.d_sig, null)
  assert.equal((await pending(db)).requests.length, 1, 'T 只看到新的')
  assert.ok((await start(db, { p_window_name: '小丙' })).id)
  assert.ok((await start(db, { p_actor: X, p_window_name: '小丁' })).id)
  assert.equal((await start(db, { p_window_name: '小戊' })).error, 'busy', '第 4 個')
  await report(db, s.id, 'ended')
  assert.ok((await start(db, { p_window_name: '小戊' })).id, '結束一個就能再開')
  await db.exec(`insert into relay.term_views (id, from_node, to_node, window_name, status, end_reason, expires_at, ended_at)
    select gen_random_uuid(), '${D}', '${X}', 'w' || g, 'ended', 'expired', now(), now() from generate_series(1, 30) g`)
  assert.equal((await start(db, { p_to_node: X, p_window_name: 'z' })).error, 'rate_limited')
})

test('到期：清金鑰材料、接受不了；一天後刪除', { skip }, async () => {
  const db = await boot()
  const s = await start(db)
  await db.query(`update relay.term_views set expires_at = now() - interval '1 second' where id = $1`, [s.id])
  assert.equal((await accept(db, s.id)).error, 'not_found')
  const x = await row(db, s.id)
  assert.equal(x.status, 'ended')
  assert.equal(x.end_reason, 'expired')
  assert.equal(x.d_sig, null)
  assert.equal((await pending(db)).requests.length, 0)
  await db.exec(`update relay.term_views set ended_at = now() - interval '2 days'`)
  await pending(db)
  assert.equal(await row(db, s.id), undefined)
})

test('D 不見了 T 看得到；T 可以自己結束，原因只能是固定值', { skip }, async () => {
  const db = await boot()
  const s = await start(db)
  await accept(db, s.id)
  assert.equal((await pending(db)).active[0].viewer_stale, false)
  await db.query(`update relay.term_views set viewer_seen_at = now() - interval '91 seconds' where id = $1`, [s.id])
  assert.equal((await pending(db)).active[0].viewer_stale, true)
  await report(db, s.id, 'watching')
  assert.equal((await pending(db)).active[0].viewer_stale, false, '回報就更新')
  assert.equal((await rpc(db, 'asn_relay_term_view_stop', { p_node: Z, p_id: s.id, p_reason: '隨便寫' })).error, 'bad_request')
  assert.deepEqual(await rpc(db, 'asn_relay_term_view_stop', { p_node: Z, p_id: s.id, p_reason: 'viewer_gone' }), { ok: true })
  const r = await report(db, s.id, 'watching')
  assert.equal(r.status, 'ended', '結束後不能再回報成看著')
  assert.equal(r.end_reason, 'viewer_gone')
})

test('D 回報：狀態只收固定值；還沒接受不能回報成看著', { skip }, async () => {
  const db = await boot()
  const s = await start(db)
  assert.equal((await report(db, s.id, 'requested')).error, 'bad_request')
  assert.equal((await report(db, s.id, 'watching')).status, 'requested', 'T 還沒接受')
})

test('權限與連帶刪除：anon、authenticated 碰不到；刪節點連帶清掉', { skip }, async () => {
  const db = await boot()
  await start(db)
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_term_view_pending('x')`), role)
    await assert.rejects(db.query(`select * from relay.term_views`), role)
    await db.exec('reset role')
  }
  await db.exec(`delete from relay.nodes where id = '${Z}'`)
  assert.equal((await db.query(`select count(*)::int n from relay.term_views`)).rows[0].n, 0)
})

test('還原驗證：拿掉保護要變紅', { skip }, async () => {
  const a = await boot({ mutate: { [MIG]: s => s.replace(`where id = p_id and to_node = p_node and status = 'requested'`, `where id = p_id and status = 'requested'`) } })
  const s = await start(a)
  assert.deepEqual(await accept(a, s.id, { p_node: D }), { ok: true }, '沒有 to_node 檢查，D 能替 T 接受')
  const b = await boot({ mutate: { [MIG]: s => s.replace(`p_state not in ('watching', 'paused', 'ended')`, `false`) } })
  const c = await start(b)
  assert.equal((await report(b, c.id, '隨便寫')).status, 'requested', '沒有檢查時，不認得的狀態會直接過')
})
