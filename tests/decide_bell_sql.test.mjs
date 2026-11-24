// #2161 第 3d-1 段：手機決定權限框／終端確認成功後多回 bell_topic（migration 20261125310000_perm_req_decide_bell.sql）。
// 1. 靜態：交易內、不刪表、不開放給一般角色、沒有線上時間窗字面值、兩個函式簽名與舊版相同、回復檔在交易內。
// 2. 實跑（pglite）：成功回 bell_topic（等於該請求節點的門鈴頻道，節點沒有時是 JSON null）；失敗路徑不含此鍵；
//    anon／authenticated 不能呼叫；套上回復檔後回到舊形狀。
// 3. 還原驗證：migration 拿掉 'bell_topic', v_topic，對應測試要變紅。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261125310000_perm_req_decide_bell.sql'
const DOWN_URL = new URL('../supabase/sql/rollback/20261125310000_perm_req_decide_bell_down.sql', import.meta.url)
const norm = s => s.replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const read = f => norm(fs.readFileSync(new URL(f, DIR), 'utf8'))
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const code = s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const sigOf = (sql, fn) => { const m = sql.match(new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`)); return m && m[1].replace(/\s+/g, ' ').trim() }
const BELL = ", 'bell_topic', v_topic"

test('靜態：migration 在交易內、不刪表、不開放給一般角色、沒有線上時間窗字面值', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const c = code(sql)
  assert.doesNotMatch(c, /drop table|drop column|truncate|drop function/i)
  assert.doesNotMatch(c, /grant [^;]*to (anon|authenticated|public)/i)
  assert.ok(!sql.includes("interval '3 minutes'"), '線上時間窗不寫死在這裡')
  assert.ok(c.includes(BELL))
})

test('靜態：兩個函式的簽名與舊版相同（以 origin/main 的舊檔對照）', () => {
  const now = read(MIG)
  const old = f => { try { return norm(execFileSync('git', ['show', `origin/main:supabase/migrations/${f}`], { encoding: 'utf8', timeout: 20000 })) } catch { return null } }
  const oldPerm = old('20261114100000_perm_requests_full_options.sql') ?? read('20261114100000_perm_requests_full_options.sql')
  const oldTerm = old('20261026400000_term_requests.sql') ?? read('20261026400000_term_requests.sql')
  for (const [fn, o] of [['asn_relay_perm_req_decide', oldPerm], ['asn_relay_term_req_decide', oldTerm]]) {
    const a = sigOf(now, fn), b = sigOf(o, fn)
    assert.ok(a && b, `${fn} 找不到標頭`)
    assert.equal(a, b, `${fn} 參數列要與舊版相同`)
  }
})

test('靜態：回復檔在交易內、不刪表、不回 bell_topic、簽名一致', () => {
  const down = norm(fs.readFileSync(DOWN_URL, 'utf8'))
  assert.match(down, /^begin;$/m); assert.match(down, /^commit;$/m)
  const c = code(down)
  assert.doesNotMatch(c, /drop table|drop column|truncate|drop function/i)
  assert.doesNotMatch(c, /bell_topic/)
  assert.equal(sigOf(down, 'asn_relay_perm_req_decide'), sigOf(read(MIG), 'asn_relay_perm_req_decide'))
  assert.equal(sigOf(down, 'asn_relay_term_req_decide'), sigOf(read(MIG), 'asn_relay_term_req_decide'))
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const H = 'a'.repeat(64), H2 = 'b'.repeat(64)
const NOPE = '99999999-9999-9999-9999-999999999999'

async function boot({ mutate, down = false } = {}) {
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
  if (down) await db.exec(norm(fs.readFileSync(DOWN_URL, 'utf8')))
  await db.exec(`
    insert into auth.users(id, email) values ('${U1}', 'a@x.y'), ('${U2}', 'b@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '擁有者'), ('${T2}', '${U2}', '財務員');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${P1}', '擁有者的手機', 'k1', 'bell-p1', 'member', '${T1}', '${U1}', 'active', '手機'),
      ('${W1}', '家用機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

const OPTS = JSON.stringify([{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }])
const pcreate = (db, o = {}) => rpc(db, 'asn_relay_perm_req_create', { p_node: W1, p_window_name: '小乙', p_prompt_text: 'Do you want to proceed?', p_complete: true, p_options: OPTS, p_hash: H, ...o })
const pdecide = (db, id, o = {}) => rpc(db, 'asn_relay_perm_req_decide', { p_actor: P1, p_signed_user: U1, p_id: id, p_choice_n: 1, p_hash: H, ...o })
const tcreate = (db, o = {}) => rpc(db, 'asn_relay_term_req_create', { p_node: W1, p_kind: 'send', p_term_id: '3', p_folder_label: 'order-plus', p_preview: '回答 1', p_enter: true, p_options: null, p_hash: H, ...o })
const tdecide = (db, id, o = {}) => rpc(db, 'asn_relay_term_req_decide', { p_actor: P1, p_signed_user: U1, p_id: id, p_decision: 'approve', p_choice_n: null, p_hash: H, ...o })

test('perm 實跑：成功回 bell_topic 且等於該請求節點的門鈴頻道', { skip }, async () => {
  const db = await boot()
  const c = await pcreate(db); assert.ok(c.id, JSON.stringify(c))
  const r = await pdecide(db, c.id)
  assert.deepEqual(r, { ok: true, status: 'decided', bell_topic: 'bell-w1' })
  const want = (await db.query(`select bell_topic from relay.nodes where id = $1`, [W1])).rows[0].bell_topic
  assert.equal(r.bell_topic, want)
})

test('perm 實跑：節點沒有門鈴頻道時（欄位本為 not null，測試中放寬）成功回傳 bell_topic 是 JSON null（鍵仍在）', { skip }, async () => {
  const db = await boot()
  const c = await pcreate(db)
  await db.exec(`alter table relay.nodes alter column bell_topic drop not null; update relay.nodes set bell_topic = null where id = '${W1}'`)
  const r = await pdecide(db, c.id)
  assert.equal(r.status, 'decided'); assert.ok(has(r, 'bell_topic')); assert.equal(r.bell_topic, null)
})

test('perm 實跑：錯誤路徑都不含 bell_topic', { skip }, async () => {
  const db = await boot()
  const c = await pcreate(db)
  const cases = [
    ['forbidden', await pdecide(db, c.id, { p_signed_user: null })],
    ['forbidden', await pdecide(db, c.id, { p_actor: Q2, p_signed_user: U2 })],
    ['bad_request', await pdecide(db, c.id, { p_choice_n: 0 })],
    ['not_found', await pdecide(db, NOPE)],
    ['hash_mismatch', await pdecide(db, c.id, { p_hash: H2 })],
    ['bad_choice', await pdecide(db, c.id, { p_choice_n: 5 })],
  ]
  for (const [err, r] of cases) { assert.equal(r.error, err, JSON.stringify(r)); assert.ok(!has(r, 'bell_topic'), `${err} 不能帶 bell_topic`) }
  assert.equal((await pdecide(db, c.id)).status, 'decided')
  const again = await pdecide(db, c.id)
  assert.equal(again.error, 'not_found'); assert.ok(!has(again, 'bell_topic'), '重複決定也不含')
})

test('term 實跑：approve 與 deny 都回 bell_topic（等於該請求節點的門鈴頻道）', { skip }, async () => {
  const db = await boot()
  const a = await tcreate(db)
  assert.deepEqual(await tdecide(db, a.id), { ok: true, status: 'approved', bell_topic: 'bell-w1' })
  const d = await tcreate(db, { p_term_id: '4' })
  assert.deepEqual(await tdecide(db, d.id, { p_decision: 'deny' }), { ok: true, status: 'denied', bell_topic: 'bell-w1' })
  const q = await tcreate(db, { p_term_id: '5', p_kind: 'answer', p_options: JSON.stringify([{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }]) })
  assert.ok(q.id, JSON.stringify(q))
  assert.deepEqual(await tdecide(db, q.id, { p_choice_n: 2 }), { ok: true, status: 'approved', bell_topic: 'bell-w1' })
})

test('term 實跑：錯誤路徑都不含 bell_topic；節點沒有門鈴頻道時成功回 JSON null', { skip }, async () => {
  const db = await boot()
  const a = await tcreate(db)
  const q = await tcreate(db, { p_term_id: '5', p_kind: 'answer', p_options: JSON.stringify([{ n: 1, label: 'Yes' }]) })
  const cases = [
    ['forbidden', await tdecide(db, a.id, { p_signed_user: null })],
    ['forbidden', await tdecide(db, a.id, { p_actor: Q2, p_signed_user: U2 })],
    ['bad_request', await tdecide(db, a.id, { p_decision: 'maybe' })],
    ['not_found', await tdecide(db, NOPE)],
    ['hash_mismatch', await tdecide(db, a.id, { p_hash: H2 })],
    ['bad_choice', await tdecide(db, q.id, { p_choice_n: 9 })],
    ['bad_choice', await tdecide(db, a.id, { p_choice_n: 1 })],
  ]
  for (const [err, r] of cases) { assert.equal(r.error, err, JSON.stringify(r)); assert.ok(!has(r, 'bell_topic'), `${err} 不能帶 bell_topic`) }
  await db.exec(`alter table relay.nodes alter column bell_topic drop not null; update relay.nodes set bell_topic = null where id = '${W1}'`)
  const r = await tdecide(db, a.id)
  assert.equal(r.status, 'approved'); assert.ok(has(r, 'bell_topic')); assert.equal(r.bell_topic, null)
})

test('權限：anon、authenticated 不能呼叫兩個 decide 函式；service_role 可以', { skip }, async () => {
  const db = await boot()
  const c = await pcreate(db), t = await tcreate(db)
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => pdecide(db, c.id), /permission denied/, `perm ${role}`)
    await assert.rejects(() => tdecide(db, t.id), /permission denied/, `term ${role}`)
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  assert.equal((await pdecide(db, c.id)).status, 'decided')
  assert.equal((await tdecide(db, t.id)).status, 'approved')
  await db.exec('reset role')
})

test('回復檔：套上後兩個函式成功回傳不含 bell_topic（回到舊形狀）', { skip }, async () => {
  const db = await boot({ down: true })
  const c = await pcreate(db), t = await tcreate(db), d = await tcreate(db, { p_term_id: '4' })
  assert.deepEqual(await pdecide(db, c.id), { ok: true, status: 'decided' })
  assert.deepEqual(await tdecide(db, t.id), { ok: true, status: 'approved' })
  assert.deepEqual(await tdecide(db, d.id, { p_decision: 'deny' }), { ok: true, status: 'denied' })
})

test('還原驗證：migration 拿掉 bell_topic 回傳，成功路徑不再帶 bell_topic（正式測試會紅）', { skip }, async () => {
  const strip = s => s.split(BELL).join('')
  assert.notEqual(strip(read(MIG)), read(MIG), '突變真的改到東西')
  const db = await boot({ mutate: { [MIG]: strip } })
  const c = await pcreate(db), t = await tcreate(db)
  assert.ok(!has(await pdecide(db, c.id), 'bell_topic'), 'perm 拿掉後不再回 bell_topic')
  assert.ok(!has(await tdecide(db, t.id), 'bell_topic'), 'term 拿掉後不再回 bell_topic')
})

closeAtEnd()
