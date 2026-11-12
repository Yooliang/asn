// 手機回答權限框（migration 20261105130000_perm_requests.sql）。
// 1. 靜態：交易內、函式只給 service_role、表開 RLS、舊表不動。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    只有電腦能建立、雜湊綁死、選項要在清單內、第一個決定為準、本人簽章且節點是這個人的、他人不行、
//    過期、同視窗一筆、頻率上限、結案就清全文、門鈴只敲本人其他設備。
// 3. 還原驗證：拿掉雜湊、選項或一次性條件，對應測試要變紅。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261105130000_perm_requests.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、函式只給 service_role、表開 RLS、不動別的表', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /alter table relay\.perm_requests enable row level security/)
  assert.match(code, /revoke all on relay\.perm_requests from public, anon, authenticated/)
  assert.doesNotMatch(code, /term_requests/, '舊表不動')
  assert.deepEqual(code.match(/delete from [a-z_.]+/g), ['delete from relay.perm_requests'], '只清自己的表')
  for (const f of ['create(text, text, text, boolean, jsonb, text)', 'list(text, uuid)', 'decide(text, uuid, uuid, integer, text)', 'take(text)', 'result(text, uuid, text, text)']) {
    assert.ok(code.includes(`grant execute on function public.asn_relay_perm_req_${f} to service_role;`), f)
  }
  assert.ok(!code.includes('grant execute on function public.asn_relay_perm_req_expire'), '清理函式不開放')
  assert.ok(files.includes(MIG))
})

let PGlite = null
try { PGlite = await fastPGlite() } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const H = 'a'.repeat(64), H2 = 'b'.repeat(64)
const OPTS = JSON.stringify([{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }])

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
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良'), ('${T2}', '${U2}', '財務員');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${P1}', '小良的手機', 'k1', 'bell-p1', 'member', '${T1}', '${U1}', 'active', '手機'),
      ('${W1}', '家用機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const create = (db, o = {}) => rpc(db, 'asn_relay_perm_req_create', { p_node: W1, p_window_name: '小乙', p_prompt_text: 'Do you want to proceed?\nrm x', p_complete: true, p_options: OPTS, p_hash: H, ...o })
const decide = (db, id, o = {}) => rpc(db, 'asn_relay_perm_req_decide', { p_actor: P1, p_signed_user: U1, p_id: id, p_choice_n: 1, p_hash: H, ...o })
const row = async (db, id) => (await db.query('select * from relay.perm_requests where id = $1', [id])).rows[0]

test('整條路：建立、手機看到全文、決定、電腦領到、回報，結案清全文', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.ok(c.id)
  assert.deepEqual(c.bell_topics, ['bell-p1'], '只敲本人其他設備，不敲自己，也不敲別人')
  const l = await rpc(db, 'asn_relay_perm_req_list', { p_actor: P1, p_signed_user: U1 })
  assert.equal(l.requests.length, 1)
  assert.equal(l.requests[0].prompt_text, 'Do you want to proceed?\nrm x', '換行要留著')
  assert.equal(l.requests[0].window_name, '小乙')
  assert.deepEqual((await decide(db, c.id, { p_choice_n: 3 })).status, 'decided')
  const after = await row(db, c.id)
  assert.equal(after.prompt_text, null, '決定就清全文')
  assert.equal(after.options, null)
  assert.equal((await rpc(db, 'asn_relay_perm_req_list', { p_actor: P1, p_signed_user: U1 })).requests.length, 0)
  const t = await rpc(db, 'asn_relay_perm_req_take', { p_node: W1 })
  assert.equal(t.requests[0].choice_n, 3)
  assert.equal(t.requests[0].body_hash, H)
  assert.equal((await rpc(db, 'asn_relay_perm_req_take', { p_node: W1 })).requests.length, 0, '只領一次')
  assert.deepEqual(await rpc(db, 'asn_relay_perm_req_result', { p_node: W1, p_id: c.id, p_status: 'done', p_detail: 'x' }), { ok: true })
  const l2 = await rpc(db, 'asn_relay_perm_req_list', { p_actor: P1, p_signed_user: U1 })
  assert.equal(l2.recent[0].status, 'done', '手機看得到結果')
  assert.equal(l2.recent[0].prompt_text, undefined)
})

test('誰能決定：要簽章、節點要是本人的；別人看不到也按不了', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.equal((await decide(db, c.id, { p_signed_user: null })).error, 'forbidden')
  assert.equal((await decide(db, c.id, { p_actor: Q2, p_signed_user: U2 })).error, 'forbidden', '別人的節點')
  assert.equal((await decide(db, c.id, { p_actor: P1, p_signed_user: U2 })).error, 'forbidden', '簽章和節點不是同一人')
  assert.equal((await rpc(db, 'asn_relay_perm_req_list', { p_actor: Q2, p_signed_user: U2 })).requests.length, 0)
  assert.equal((await rpc(db, 'asn_relay_perm_req_list', { p_actor: P1, p_signed_user: null })).error, 'forbidden')
  assert.equal((await row(db, c.id)).status, 'pending')
})

test('雜湊綁死、數字要在選項裡、第一個決定為準', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.equal((await decide(db, c.id, { p_hash: H2 })).error, 'hash_mismatch')
  assert.equal((await decide(db, c.id, { p_choice_n: 2 })).error, 'bad_choice', '清單裡沒有 2')
  assert.equal((await decide(db, c.id, { p_choice_n: 0 })).error, 'bad_request')
  assert.equal((await decide(db, c.id)).status, 'decided')
  assert.equal((await decide(db, c.id, { p_choice_n: 3 })).error, 'not_found', '第二個決定無效')
  assert.equal((await row(db, c.id)).choice_n, 1)
})

test('建立的參數：壞的拒絕；不能在同一扇視窗開第二筆；別扇可以', { skip }, async () => {
  const db = await boot()
  for (const o of [{ p_window_name: '' }, { p_window_name: 'a\nb' }, { p_prompt_text: '  ' }, { p_prompt_text: 'x'.repeat(16001) }, { p_hash: 'x' }, { p_options: JSON.stringify(Array.from({ length: 10 }, () => ({ n: 1, label: 'x' }))) },
    { p_options: JSON.stringify([{ n: 0, label: 'x' }]) }, { p_options: JSON.stringify([{ n: 10, label: 'x' }]) }, { p_options: JSON.stringify([{ n: 1, label: ' ' }]) }]) {
    assert.equal((await create(db, o)).error, 'bad_request', JSON.stringify(o).slice(0, 60))
  }
  assert.equal((await create(db, { p_node: 'nope' })).error, 'not_found')
  assert.ok((await create(db)).id)
  assert.equal((await create(db)).error, 'busy')
  assert.ok((await create(db, { p_window_name: '小丙' })).id)
})

test('沒有選項：看得到，但什麼數字都按不了', { skip }, async () => {
  const db = await boot()
  const c = await create(db, { p_options: '[]' })
  assert.ok(c.id)
  assert.deepEqual((await rpc(db, 'asn_relay_perm_req_list', { p_actor: P1, p_signed_user: U1 })).requests[0].options, [])
  assert.equal((await decide(db, c.id)).error, 'bad_choice')
})

test('過期：清全文、手機按不了、電腦看得到；到期前可以再開一筆', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  await db.query(`update relay.perm_requests set expires_at = now() - interval '1 second' where id = $1`, [c.id])
  assert.equal((await decide(db, c.id)).error, 'not_found')
  const r = await row(db, c.id)
  assert.equal(r.status, 'expired')
  assert.equal(r.prompt_text, null)
  assert.deepEqual((await rpc(db, 'asn_relay_perm_req_take', { p_node: W1 })).closed, [{ id: c.id, status: 'expired' }])
  assert.ok((await create(db)).id, '框還在就重發')
})

test('回報：只動自己節點、取消也清全文', { skip }, async () => {
  const db = await boot()
  const c = await create(db)
  assert.equal((await rpc(db, 'asn_relay_perm_req_result', { p_node: Q2, p_id: c.id, p_status: 'cancelled', p_detail: '' })).error, 'not_found')
  assert.equal((await rpc(db, 'asn_relay_perm_req_result', { p_node: W1, p_id: c.id, p_status: 'pending', p_detail: '' })).error, 'bad_request')
  assert.deepEqual(await rpc(db, 'asn_relay_perm_req_result', { p_node: W1, p_id: c.id, p_status: 'cancelled', p_detail: '框不見了' }), { ok: true })
  assert.equal((await row(db, c.id)).prompt_text, null)
  assert.equal((await decide(db, c.id)).error, 'not_found')
})

test('頻率上限、一天後清掉', { skip }, async () => {
  const db = await boot()
  await db.exec(`insert into relay.perm_requests (tenant_id, node, window_name, body_hash, status, prompt_text, options, created_at)
    select '${T1}', '${W1}', 'w' || g, '${H}', 'cancelled', null, null, now() - interval '30 minutes' from generate_series(1, 60) g`)
  assert.equal((await create(db)).error, 'rate_limited')
  await db.exec(`update relay.perm_requests set created_at = now() - interval '2 days'`)
  assert.ok((await create(db)).id)
  assert.equal((await db.query(`select count(*)::int n from relay.perm_requests`)).rows[0].n, 1, '舊列已清')
})

test('權限：anon、authenticated 不能呼叫函式或讀表', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_perm_req_list('x', null)`), role)
    await assert.rejects(db.query(`select * from relay.perm_requests`), role)
    await db.exec('reset role')
  }
})

test('還原驗證：拿掉保護，對應測試要變紅', { skip }, async () => {
  const noHash = await boot({ mutate: { [MIG]: s => s.replace('if p_hash is distinct from r.body_hash then', 'if false then') } })
  const c1 = await create(noHash)
  assert.equal((await decide(noHash, c1.id, { p_hash: H2 })).status, 'decided')
  const noChoice = await boot({ mutate: { [MIG]: s => s.replace(`if not exists (select 1 from jsonb_array_elements(r.options) o where (o->>'n')::int = p_choice_n) then`, 'if false then') } })
  const c2 = await create(noChoice)
  assert.equal((await decide(noChoice, c2.id, { p_choice_n: 2 })).status, 'decided')
  const noOnce = await boot({ mutate: { [MIG]: s => s.replace(`if not found or r.status <> 'pending' or r.expires_at <= now() then`, 'if not found then') } })
  const c3 = await create(noOnce)
  await decide(noOnce, c3.id)
  // 第一個決定已清掉選項：第二個決定會因為選項空掉而不成功，但已經不是 not_found
  assert.notEqual((await decide(noOnce, c3.id)).error, 'not_found')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
