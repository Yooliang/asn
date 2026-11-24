// 手機請電腦顯示指紋（migration 20261125320000_fp_show_requests.sql，#1863）。
// 1. 靜態：交易內、函式只給 service_role、表開 RLS、不動別的表、回復檔在交易內、表裡沒有能放指紋或 QR 的欄位。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過）：本人建立成功、非擁有者被拒、10 秒內重複被擋、電腦領取只看得到自己的、
//    已顯示與取消的狀態轉換、結束、5 分鐘過期、舊請求被新請求取代。
// 3. 還原驗證：拿掉擁有權檢查、10 秒限制，對應測試要變紅。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261125320000_fp_show_requests.sql'
const DOWN_URL = new URL('../supabase/sql/rollback/20261125320000_fp_show_requests_down.sql', import.meta.url)
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const code = s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

test('靜態：交易內、函式只給 service_role、表開 RLS、不動別的表、不留指紋欄位', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const c = code(sql)
  assert.doesNotMatch(c, /drop table|drop column|truncate|drop function/i)
  assert.doesNotMatch(c, /grant [^;]*to (anon|authenticated|public)/i)
  assert.match(c, /alter table relay\.fp_show_requests enable row level security/)
  assert.match(c, /revoke all on relay\.fp_show_requests from public, anon, authenticated/)
  assert.doesNotMatch(c, /perm_requests|term_requests/, '別的請求表不動')
  assert.deepEqual(c.match(/delete from [a-z_.]+/g), ['delete from relay.fp_show_requests'], '只清自己的表')
  for (const f of ['request(text, uuid, text)', 'take(text)', 'ack(text, uuid, text, text)', 'status(text, uuid, uuid)', 'end(text, uuid, uuid)']) {
    assert.ok(c.includes(`grant execute on function public.asn_relay_fp_show_${f} to service_role;`), f)
  }
  assert.ok(!c.includes('grant execute on function public.asn_relay_fp_show_expire'), '清理函式不開放')
  const table = c.slice(c.indexOf('create table if not exists relay.fp_show_requests'), c.indexOf('alter table relay.fp_show_requests enable'))
  assert.doesNotMatch(table, /fingerprint|finger|\bqr\b|payload|secret|key_|_key|hash|prompt_text/i, '表裡不放指紋、QR、金鑰')
  assert.ok(files.includes(MIG))
  assert.ok(files.at(-1) === MIG || files.at(-1) > MIG, '時間戳要排在既有 migration 之後')
})

test('靜態：回復檔在交易內，拿掉六支函式與表', () => {
  const down = fs.readFileSync(DOWN_URL, 'utf8').replace(/\r\n/g, '\n')
  assert.match(down, /^begin;$/m); assert.match(down, /^commit;$/m)
  const c = code(down)
  assert.equal((c.match(/drop function if exists public\.asn_relay_fp_show_/g) ?? []).length, 6)
  assert.match(c, /drop table if exists relay\.fp_show_requests;/)
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', W1B = 'wrk8c3', Q2 = 'qqq3c4'

async function boot({ mutate } = {}) {
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
    let sql = read(f)
    if (mutate && mutate[f]) sql = mutate[f](sql)
    await db.exec(sql)
  }
  await db.exec(`
    insert into auth.users(id, email) values ('${U1}', 'a@x.y'), ('${U2}', 'b@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '擁有者'), ('${T2}', '${U2}', '財務員');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${P1}', '擁有者的手機', 'k1', 'bell-p1', 'member', '${T1}', '${U1}', 'active', '手機'),
      ('${W1}', '家用機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${W1B}', '辦公室機', 'k4', 'bell-w1b', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const request = (db, o = {}) => rpc(db, 'asn_relay_fp_show_request', { p_actor: P1, p_signed_user: U1, p_target: W1, ...o })
const take = (db, node = W1) => rpc(db, 'asn_relay_fp_show_take', { p_node: node })
const ack = (db, id, o = {}) => rpc(db, 'asn_relay_fp_show_ack', { p_node: W1, p_id: id, p_status: 'shown', p_detail: null, ...o })
const status = (db, id, o = {}) => rpc(db, 'asn_relay_fp_show_status', { p_actor: P1, p_signed_user: U1, p_id: id, ...o })
const end = (db, id, o = {}) => rpc(db, 'asn_relay_fp_show_end', { p_actor: P1, p_signed_user: U1, p_id: id, ...o })
const row = async (db, id) => (await db.query('select * from relay.fp_show_requests where id = $1', [id])).rows[0]
/** 把這台電腦已有的請求都挪到 11 秒前，模擬「已過 10 秒」 */
const age = (db, secs = 11) => db.exec(`update relay.fp_show_requests set created_at = created_at - interval '${secs} seconds'`)

test('整條路：建立、電腦領到、回報已顯示、手機看到、結束、電腦收到收起', { skip }, async () => {
  const db = await boot()
  const c = await request(db)
  assert.ok(c.id)
  assert.equal(c.bell_topic, 'bell-w1', '門鈴頻道是目標電腦的')
  assert.ok(c.expires_at)
  assert.deepEqual((await status(db, c.id)).status, 'pending')
  const t = await take(db)
  assert.deepEqual(t.requests.map(r => [r.id, r.status]), [[c.id, 'pending']])
  assert.deepEqual(await ack(db, c.id), { ok: true })
  assert.equal((await status(db, c.id)).status, 'shown', '手機看到已顯示')
  assert.equal((await take(db)).requests[0].status, 'shown', '領取可重複呼叫，狀態跟著變')
  const e = await end(db, c.id)
  assert.deepEqual([e.ok, e.status, e.bell_topic], [true, 'ended', 'bell-w1'], '結束時再敲目標電腦的門鈴')
  const t2 = await take(db)
  assert.equal(t2.requests.length, 0)
  assert.deepEqual(t2.closed, [{ id: c.id, status: 'ended' }], '電腦知道這筆已結束、要收視窗')
  assert.deepEqual(await end(db, c.id), { ok: true, status: 'ended' }, '重複結束不報錯、也不再敲門鈴')
})

test('誰能請求：要簽章、手機與目標電腦都要是本人的；別人看不到也動不了', { skip }, async () => {
  const db = await boot()
  assert.equal((await request(db, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await request(db, { p_target: Q2 })).error, 'forbidden', '目標是別人的電腦')
  assert.equal((await request(db, { p_actor: Q2, p_signed_user: U2, p_target: W1 })).error, 'forbidden', '別人想看我的電腦')
  assert.equal((await request(db, { p_actor: P1, p_signed_user: U2 })).error, 'forbidden', '簽章與手機不是同一人')
  assert.equal((await request(db, { p_target: P1 })).error, 'bad_request', '不能請自己顯示')
  assert.equal((await request(db, { p_target: '' })).error, 'bad_request')
  assert.equal((await request(db, { p_target: 'nope' })).error, 'forbidden', '不存在的節點同樣不是本人的')
  assert.equal((await db.query('select count(*)::int n from relay.fp_show_requests')).rows[0].n, 0, '被拒的都沒寫入')
  await db.exec(`update relay.nodes set status = 'revoked' where id = '${W1}'`)
  assert.equal((await request(db)).error, 'forbidden', '已停用的節點不行')
})

test('別人查狀態、結束都不行', { skip }, async () => {
  const db = await boot()
  const c = await request(db)
  assert.equal((await status(db, c.id, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await status(db, c.id, { p_actor: Q2, p_signed_user: U2 })).error, 'not_found', '別人看不到這筆')
  assert.equal((await end(db, c.id, { p_actor: Q2, p_signed_user: U2 })).error, 'not_found')
  assert.equal((await end(db, c.id, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await status(db, null)).error, 'bad_request')
  assert.equal((await row(db, c.id)).status, 'pending', '別人動不了')
})

test('10 秒內同一台不能重複請求；過了 10 秒可以', { skip }, async () => {
  const db = await boot()
  assert.ok((await request(db)).id)
  assert.equal((await request(db)).error, 'rate_limited')
  assert.ok((await request(db, { p_target: W1B })).id, '別台不受影響')
  await age(db, 11)
  assert.ok((await request(db)).id)
})

test('rate_limited 帶回同一人進行中那筆的編號；別人的不會回給你', { skip }, async () => {
  const db = await boot()
  const a = await request(db)
  const again = await request(db)
  assert.equal(again.error, 'rate_limited')
  assert.equal(again.id, a.id, '同一人那台還在進行中的那筆')
  await db.query(`update relay.fp_show_requests set status = 'ended', ended_at = now() where id = $1`, [a.id])
  assert.equal((await request(db)).id ?? null, null, '已結束的不回')
  const db2 = await boot()
  const b = await request(db2)
  await db2.query(`update relay.fp_show_requests set requested_by = '99999999-9999-4999-8999-999999999999' where id = $1`, [b.id])
  const other = await request(db2)
  assert.equal(other.error, 'rate_limited')
  assert.equal(other.id ?? null, null, '別人的請求編號不能回給你')
})

test('舊請求被新請求取代：每台同時只留一筆活的', { skip }, async () => {
  const db = await boot()
  const a = await request(db)
  await ack(db, a.id)
  await age(db)
  const b = await request(db)
  assert.notEqual(a.id, b.id)
  assert.equal((await row(db, a.id)).status, 'superseded')
  assert.equal((await row(db, b.id)).status, 'pending')
  assert.equal((await db.query(`select count(*)::int n from relay.fp_show_requests where node = $1 and status in ('pending','shown')`, [W1])).rows[0].n, 1)
  const t = await take(db)
  assert.deepEqual(t.requests.map(r => r.id), [b.id])
  assert.deepEqual(t.closed, [{ id: a.id, status: 'superseded' }])
  assert.equal((await end(db, a.id)).status, 'superseded', '舊的結束不改狀態、不敲門鈴')
  assert.equal((await end(db, a.id)).bell_topic, undefined)
})

test('電腦領取只看得到發給自己的', { skip }, async () => {
  const db = await boot()
  const a = await request(db)
  const b = await request(db, { p_target: W1B })
  assert.deepEqual((await take(db, W1)).requests.map(r => r.id), [a.id])
  assert.deepEqual((await take(db, W1B)).requests.map(r => r.id), [b.id])
  assert.deepEqual(await take(db, Q2), { requests: [], closed: [] })
  assert.equal((await ack(db, b.id)).error, 'not_found', 'W1 不能回報 W1B 的請求')
  assert.equal((await ack(db, a.id, { p_node: Q2 })).error, 'not_found', '別人的電腦也不行')
  assert.equal((await row(db, b.id)).status, 'pending')
  assert.equal((await row(db, a.id)).status, 'pending')
})

test('狀態轉換：已顯示、電腦端取消、壞參數、不能倒退', { skip }, async () => {
  const db = await boot()
  const a = await request(db)
  assert.equal((await ack(db, a.id, { p_status: 'ended' })).error, 'bad_request')
  assert.equal((await ack(db, a.id, { p_status: null })).error, 'bad_request')
  assert.equal((await ack(db, null)).error, 'bad_request')
  assert.equal((await ack(db, '99999999-9999-9999-9999-999999999999')).error, 'not_found')
  assert.deepEqual(await ack(db, a.id), { ok: true })
  assert.equal((await ack(db, a.id)).error, 'not_found', '已顯示不能再回報已顯示')
  const s = await row(db, a.id)
  assert.equal(s.status, 'shown'); assert.ok(s.shown_at)
  assert.deepEqual(await ack(db, a.id, { p_status: 'cancelled', p_detail: '使用者在電腦按了取消\n' + 'x'.repeat(300) }), { ok: true })
  const c = await row(db, a.id)
  assert.equal(c.status, 'pc_cancelled'); assert.ok(c.ended_at)
  assert.equal(c.detail.length, 200); assert.ok(!c.detail.includes('\n'), '控制字元已清掉')
  assert.equal((await status(db, a.id)).status, 'pc_cancelled', '手機看得到電腦端取消')
  assert.equal((await ack(db, a.id)).error, 'not_found', '取消後不能再變回已顯示')
  assert.equal((await end(db, a.id)).status, 'pc_cancelled', '手機結束不蓋掉電腦端取消')
  // 還沒顯示就在電腦上取消也行
  await age(db)
  const b = await request(db)
  assert.deepEqual(await ack(db, b.id, { p_status: 'cancelled', p_detail: '' }), { ok: true })
  assert.equal((await row(db, b.id)).status, 'pc_cancelled')
})

test('手機結束：pending 也能結束；結束後電腦不能再回報已顯示', { skip }, async () => {
  const db = await boot()
  const a = await request(db)
  assert.equal((await end(db, a.id)).status, 'ended')
  assert.equal((await ack(db, a.id)).error, 'not_found')
  assert.equal((await status(db, a.id)).status, 'ended')
  assert.equal((await db.query(`select count(*)::int n from relay.fp_show_requests where status in ('pending','shown')`)).rows[0].n, 0)
})

test('5 分鐘過期：標成 expired、電腦領得到結案通知、手機查得到、不能再回報或敲門鈴', { skip }, async () => {
  const db = await boot()
  const a = await request(db)
  const r0 = await row(db, a.id)
  assert.ok(Math.abs((new Date(r0.expires_at) - new Date(r0.created_at)) / 1000 - 300) < 2, '效期 5 分鐘')
  await ack(db, a.id)
  await db.query(`update relay.fp_show_requests set expires_at = now() - interval '1 second' where id = $1`, [a.id])
  assert.equal((await status(db, a.id)).status, 'expired')
  const t = await take(db)
  assert.equal(t.requests.length, 0)
  assert.deepEqual(t.closed, [{ id: a.id, status: 'expired' }])
  assert.equal((await ack(db, a.id)).error, 'not_found')
  const e = await end(db, a.id)
  assert.deepEqual(e, { ok: true, status: 'expired' }, '過期的結束不再敲門鈴')
})

test('過期後 10 秒限制仍算（防洗）；一天後的舊列會被清掉', { skip }, async () => {
  const db = await boot()
  const a = await request(db)
  await db.query(`update relay.fp_show_requests set expires_at = now() - interval '1 second' where id = $1`, [a.id])
  assert.equal((await request(db)).error, 'rate_limited')
  await db.exec(`update relay.fp_show_requests set created_at = now() - interval '2 days', expires_at = now() - interval '2 days'`)
  assert.ok((await request(db)).id)
  assert.equal((await db.query('select count(*)::int n from relay.fp_show_requests')).rows[0].n, 1, '舊列已清')
})

test('權限：anon、authenticated 不能呼叫函式或讀表', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_fp_show_take('x')`), role)
    await assert.rejects(db.query(`select public.asn_relay_fp_show_request('x', null, 'y')`), role)
    await assert.rejects(db.query(`select * from relay.fp_show_requests`), role)
    await db.exec('reset role')
  }
})

test('還原驗證：拿掉擁有權檢查、10 秒限制，對應測試要變紅', { skip }, async () => {
  const noOwn = await boot({ mutate: { [MIG]: s => s.replace(`if not public.asn_user_owns_node(p_signed_user, p_target) then`, 'if false then') } })
  assert.ok((await request(noOwn, { p_target: Q2 })).id, '拿掉目標擁有權檢查後，別人的電腦被請求成功＝上面「誰能請求」會變紅')
  const noOwnActor = await boot({ mutate: { [MIG]: s => s.split(`if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then`).join('if false then') } })
  assert.ok((await request(noOwnActor, { p_actor: P1, p_signed_user: U2, p_target: Q2 })).id, '拿掉呼叫者擁有權檢查後，簽章與手機不是同一人也成功')
  const noRate = await boot({ mutate: { [MIG]: s => s.replace(`created_at > now() - interval '10 seconds'`, `created_at > now() - interval '0 seconds'`) } })
  assert.ok((await request(noRate)).id)
  assert.ok((await request(noRate)).id, '拿掉 10 秒限制後，連續請求都成功＝上面「10 秒內」會變紅')
})

closeAtEnd()
