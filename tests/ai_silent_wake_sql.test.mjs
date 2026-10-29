// AI 無 @ 訊息的叫醒（#230，migration 20261024170000_ai_silent_wake.sql）：輪數上限在後台讀信時強制。
// 1. 靜態：交易內、不刪資料、新函式只授權 service_role、時間戳比 20261024160000 新。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - asn_relay_room_ai_chain：從「截止序號之前最近一則真人發言」起算；AI 有 @ 點名 AI 算一輪；AI 沒 @ 但 wake_info 有通過者也算一輪；
//      全部略過的不算；真人再發言重新起算；只算截止序號之前；非成員被擋；上限讀主持人帳號設定（預設 20、0 照給）
//    - 發言時的檢查（room_ai_chain_blocked）也把靠判斷叫醒的輪算進去
//    - wake_set 回傳存下的版本（先到先得，輸的人拿到第一份）；lim 標記讀出來是 limited:true；別租戶讀者只看到 x: 代號、不含節點代號
// 3. 還原驗證：拿掉「wake_info 有通過者也算一輪」、「截止序號」，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261024170000_ai_silent_wake.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、新函式只授權 service_role、時間戳夠新、只在尚未有值時寫入', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /grant execute on function public\.asn_relay_room_ai_chain\(text, text, text, bigint, boolean, uuid\) to service_role;/)
  assert.match(sql, /and wake_info is null/)
  assert.ok(MIG > '20261024160000_member_device_label.sql')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const A = `${W1}~財務`, B = `${W1}~管理`, C = `${W1}~監看`

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
    insert into relay.roster(node, name, engine) values ('${W1}', '財務', 'claude'), ('${W1}', '管理', 'claude'), ('${W1}', '監看', 'claude'), ('${Q2}', '助理', 'claude');`)
  // 預設已改 20（20261029120000）；這份測試的情境都以 5 輪為準，所以明設主持人帳號 5
  await db.exec(`update relay.tenants set features = coalesce(features, '{}'::jsonb) || '{"ai_wake_limit":5}'::jsonb where id = '${T1}'`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const post = (db, { node, agent = null, room, body, mentions = [], signed = null }) =>
  rpc(db, 'asn_relay_room_post', { p_node: node, p_agent: agent, p_room: room, p_body: body, p_mentions: mentions, p_owner: false, p_signed_user: signed })
const readAs = (db, { node, agent = null, room, signed = null }) =>
  rpc(db, 'asn_relay_group_read', { p_node: node, p_agent: agent, p_room: room, p_since: null, p_limit: 200, p_owner: false, p_tail: true, p_mark: false, p_signed_user: signed })
const setInfo = (db, { node = W1, agent = '財務', room, seq, info, signed = null }) =>
  rpc(db, 'asn_relay_room_wake_set', { p_node: node, p_agent: agent, p_room: room, p_seq: seq, p_info: JSON.stringify(info), p_owner: false, p_signed_user: signed })
const sha = c => crypto.createHash('sha256').update(c).digest('hex')
async function joinU2(db, room) {
  const code = 'code-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const inv = await rpc(db, 'asn_relay_group_invite_create', { p_user: U1, p_node: P1, p_kind: 'room', p_room: room, p_src_node: null, p_src_agent: null, p_seed: null, p_code_hash: sha(code) })
  assert.ok(!inv.error, JSON.stringify(inv))
  const acc = await rpc(db, 'asn_relay_group_invite_accept', { p_user: U2, p_node: Q2, p_code_hash: sha(code) })
  assert.ok(!acc.error, JSON.stringify(acc))
}
async function room3(db) {
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '順序', p_ai: [A, B, C] })
  assert.ok(g.id, JSON.stringify(g))
  return g.id
}
const human = (db, room, body) => post(db, { node: P1, room, signed: U1, body })
const msgOf = (r, seq) => r.messages.find(m => m.seq === seq)
const chain = (db, { node = W1, agent = '財務', room, seq }) =>
  rpc(db, 'asn_relay_room_ai_chain', { p_node: node, p_agent: agent, p_room: room, p_seq: seq, p_owner: false, p_signed_user: null })
const aiPost = (db, room, from, body, mentions = []) => post(db, { node: W1, agent: from.split('~')[1], room, body, mentions })
const passers = (...keys) => keys.map((k, i) => ({ key: k, rank: i + 1, hold: false }))
const allHold = (...keys) => keys.map(k => ({ key: k, rank: 0, hold: true }))

test('實跑：輪數——@ 點名 AI 算一輪、無 @ 但 wake_info 有通過者算一輪、全部略過的不算；真人發言重新起算；只算截止序號之前', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  await human(db, room, '開始')
  const a1 = await aiPost(db, room, A, '我@一下', [B])                       // 輪 1（@）
  const a2 = await aiPost(db, room, B, '沒 @ 但叫醒了人')                      // 輪 2（wake_info 通過者）
  assert.equal((await setInfo(db, { room, seq: a2.seq, info: passers(A, C) })).set, true)
  const a3 = await aiPost(db, room, C, '沒 @ 全部略過')                        // 不算
  await setInfo(db, { room, seq: a3.seq, info: allHold(A, B) })
  const a4 = await aiPost(db, room, A, '沒存過 wake_info')                      // 不算
  const c = seq => chain(db, { room, seq })
  assert.deepEqual(await c(a1.seq), { count: 0, limit: 5 })
  assert.deepEqual(await c(a2.seq), { count: 1, limit: 5 }, '只算截止序號之前')
  assert.deepEqual(await c(a4.seq), { count: 2, limit: 5 }, '略過與沒存的不算')
  await human(db, room, '我再說一句')
  const a5 = await aiPost(db, room, A, '重新起算')
  assert.deepEqual(await c(a5.seq), { count: 0, limit: 5 }, '真人發言後重算')
})

test('實跑：上限讀主持人帳號的設定（0 照給）；非成員與缺序號被擋', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '開始')
  assert.deepEqual(await chain(db, { room, seq: h.seq + 1 }), { count: 0, limit: 5 })
  await rpc(db, 'asn_account_settings', { p_user: U1, p_ai_wake_limit: 0 })
  assert.deepEqual(await chain(db, { room, seq: h.seq + 1 }), { count: 0, limit: 0 })
  assert.ok((await chain(db, { node: Q2, agent: null, room, seq: 1 })).error)
  assert.ok((await chain(db, { room, seq: null })).error)
})

test('實跑：發言時的上限檢查也把靠判斷叫醒的輪算進去——5 輪無 @ 叫醒後，AI 再 @ 別的 AI 就被擋', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  await human(db, room, '開始')
  for (let i = 0; i < 5; i++) {
    const m = await aiPost(db, room, i % 2 ? A : B, '旁白' + i)
    await setInfo(db, { room, seq: m.seq, info: passers(i % 2 ? B : A) })
  }
  const r = await aiPost(db, room, A, '現在 @ 你', [B])
  assert.equal(r.wake_limited, true)
  assert.deepEqual(r.suppressed, [B])
})

test('實跑：wake_set 回傳存下的版本——先到先得，輸的人拿到第一份；輪數上限的略過讀出來是 limited:true', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const m = await aiPost(db, room, C, '各位')
  const first = await setInfo(db, { room, seq: m.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 0, hold: true }] })
  assert.equal(first.set, true)
  assert.deepEqual(first.wake_info.map(e => [e.key, e.rank, e.hold]), [[A, 1, false], [B, 0, true]])
  const loser = await setInfo(db, { node: W1, agent: '管理', room, seq: m.seq, info: [{ key: B, rank: 1, hold: false }, { key: A, rank: 0, hold: true }] })
  assert.equal(loser.set, false)
  assert.deepEqual(loser.wake_info.map(e => [e.key, e.rank, e.hold]), [[A, 1, false], [B, 0, true]], '輸的人拿到第一份')
  const m2 = await aiPost(db, room, C, '上限到了')
  const lim = await setInfo(db, { room, seq: m2.seq, info: [{ key: A, rank: 0, hold: true, lim: true }, { key: B, rank: 0, hold: true, lim: true }] })
  assert.ok(lim.wake_info.length === 2 && lim.wake_info.every(e => e.hold && e.limited === true), JSON.stringify(lim))
  assert.ok(first.wake_info.every(e => !('limited' in e)), '一般略過沒有 limited')
  const seen = msgOf(await readAs(db, { node: W1, agent: '管理', room }), m2.seq)
  assert.ok(seen.wake_info.every(e => e.limited === true), '讀信也看得到')
})

test('實跑：別租戶的讀者拿到的版本是 x: 代號、不含節點代號', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  await joinU2(db, room)
  const m = await aiPost(db, room, C, '各位')
  await setInfo(db, { room, seq: m.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 0, hold: true }] })
  const view = await setInfo(db, { node: Q2, agent: null, signed: U2, room, seq: m.seq, info: [{ key: 'x:00000000-0000-0000-0000-000000000000', rank: 1, hold: false }] })
  assert.equal(view.set, false)
  assert.equal(view.wake_info.length, 2)
  assert.ok(view.wake_info.every(e => /^x:/.test(e.key)), JSON.stringify(view))
  assert.doesNotMatch(JSON.stringify(view), new RegExp(`${W1}|${P1}`))
})

test('還原驗證：拿掉「wake_info 有通過者也算一輪」或「截止序號」，對應測試要變紅', { skip }, async () => {
  const run = async mutate => {
    const db = await boot({ mutate: { [MIG]: mutate } })
    const room = await room3(db)
    await human(db, room, '開始')
    const a = await aiPost(db, room, B, '旁白')
    await setInfo(db, { room, seq: a.seq, info: passers(A) })
    const b = await aiPost(db, room, A, '後面')
    return await chain(db, { room, seq: b.seq })
  }
  assert.equal((await run(s => s)).count, 1, '原樣算一輪')
  const noWake = s => s.replace("or (m.wake_info is not null and jsonb_typeof(m.wake_info) = 'array'", "or (false and jsonb_typeof(m.wake_info) = 'array'")
  assert.notEqual(noWake(read(MIG)), read(MIG))
  assert.equal((await run(noWake)).count, 0, '拿掉後不算＝輪數測試會紅')
  const noCut = s => s.replace('and (p_before is null or m.seq < p_before)\n    and m.seq >', 'and m.seq >')
  assert.notEqual(noCut(read(MIG)), read(MIG))
  const db = await boot({ mutate: { [MIG]: noCut } })
  const room = await room3(db)
  await human(db, room, '開始')
  const a1 = await aiPost(db, room, A, '一', [B]); await aiPost(db, room, B, '二', [A])
  assert.notEqual((await chain(db, { room, seq: a1.seq })).count, 0, '拿掉截止序號後會多算自己與後面的（原樣是 0）＝截止測試會紅')
})
