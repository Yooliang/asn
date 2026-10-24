// 群組訊息下方的順序標籤（#231，migration 20261024150000_wake_info.sql）：叫醒結果第一次算出就存在訊息上，讀取時轉成讀者看得到的版本。
// 1. 靜態：交易內、不刪資料、新函式只授權 service_role、只在尚未有值時寫入。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - 存後所有成員讀得到：依順序、被略過的排最後、不回分數與內文
//    - 先到先得：第二次寫入不覆蓋
//    - 沒存過就是 null（舊訊息）；對外代號 x: 還原成真實鍵；非成員的鍵被丟掉；非成員呼叫被擋
//    - 別租戶的讀者：成員鍵是 x: 對外代號、標示加（主人名）、輸出掃不到節點代號
//    - 已離開群組的成員不列
// 3. 還原驗證：拿掉「只在尚未有值時寫入」或「已離開不列」，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261024150000_wake_info.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、只授權 service_role、只在尚未有值時寫入', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /add column if not exists wake_info jsonb/)
  assert.match(sql, /and wake_info is null/)
  assert.ok(files.indexOf(MIG) === files.length - 1, '時間戳要是最新')
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
const hostView = async (db, room, seq) => msgOf(await readAs(db, { node: P1, room, signed: U1 }), seq)

test('實跑：存後所有成員讀得到——依順序、被略過的排最後，不回分數與內文', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '大家看一下')
  // 寫入順序故意亂排：後台讀取時依 rank、略過者在最後
  const r = await setInfo(db, { room, seq: h.seq, info: [
    { key: C, rank: 0, hold: true, score: 0.2 }, { key: B, rank: 2, hold: false, score: 0.7 }, { key: A, rank: 1, hold: false, score: 0.9 }] })
  assert.equal(r.set, true, JSON.stringify(r))
  const m = await hostView(db, room, h.seq)
  assert.deepEqual(m.wake_info.map(e => [e.label, e.rank, e.hold]), [['財務', 1, false], ['管理', 2, false], ['監看', 0, true]])
  assert.ok(m.wake_info.every(e => e.key && !('score' in e) && !('m' in e)), JSON.stringify(m.wake_info))
  assert.doesNotMatch(JSON.stringify(m.wake_info), /大家看一下/)
  // 節點端（AI 讀）也看得到
  const ai = msgOf(await readAs(db, { node: W1, agent: '財務', room }), h.seq)
  assert.deepEqual(ai.wake_info.map(e => e.label), ['財務', '管理', '監看'])
})

test('實跑：先到先得——第二次寫入不覆蓋；沒存過的訊息是 null；AI 發的訊息也能存', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '一')
  const none = await human(db, room, '二')
  assert.equal((await setInfo(db, { room, seq: h.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 2, hold: false }] })).set, true)
  const again = await setInfo(db, { node: W1, agent: '管理', room, seq: h.seq, info: [{ key: B, rank: 1, hold: false }, { key: A, rank: 2, hold: true }] })
  assert.equal(again.set, false, '已經有值，不覆蓋')
  assert.deepEqual((await hostView(db, room, h.seq)).wake_info.map(e => [e.label, e.hold]), [['財務', false], ['管理', false]])
  assert.equal((await hostView(db, room, none.seq)).wake_info, null, '沒存過＝null，舊訊息照舊')
  const fromAi = await post(db, { node: W1, agent: '財務', room, body: '@管理 @監看', mentions: [B, C] })
  assert.equal((await setInfo(db, { room, seq: fromAi.seq, info: [{ key: B, rank: 1, hold: false }, { key: C, rank: 2, hold: false }] })).set, true)
  assert.deepEqual((await hostView(db, room, fromAi.seq)).wake_info.map(e => e.label), ['管理', '監看'])
})

test('實跑：非成員呼叫被擋；不是成員的鍵被丟掉；格式不對回錯', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '一')
  const outsider = await setInfo(db, { node: Q2, agent: null, room, seq: h.seq, info: [{ key: A, rank: 1, hold: false }] })
  assert.ok(outsider.error, JSON.stringify(outsider))
  assert.equal((await hostView(db, room, h.seq)).wake_info, null)
  assert.ok((await rpc(db, 'asn_relay_room_wake_set', { p_node: W1, p_agent: '財務', p_room: room, p_seq: h.seq, p_info: JSON.stringify({ a: 1 }) })).error)
  await setInfo(db, { room, seq: h.seq, info: [{ key: A, rank: 1, hold: false }, { key: `${W1}~不存在`, rank: 2, hold: false }, { key: 'x:00000000-0000-0000-0000-000000000000', rank: 3, hold: false }, 'junk'] })
  assert.deepEqual((await hostView(db, room, h.seq)).wake_info.map(e => e.label), ['財務'])
})

test('實跑：別租戶的讀者——成員鍵是 x: 對外代號、標示加（主人名）、輸出掃不到節點代號；對外代號也能當寫入的鍵', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  await joinU2(db, room)
  const h = await human(db, room, '大家')
  await setInfo(db, { room, seq: h.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 0, hold: true }] })
  const seen = msgOf(await readAs(db, { node: Q2, room, signed: U2 }), h.seq)
  assert.deepEqual(seen.wake_info.map(e => [e.label, e.hold]), [['財務（小良）', false], ['管理（小良）', true]])
  assert.ok(seen.wake_info.every(e => /^x:/.test(e.key)), JSON.stringify(seen.wake_info))
  assert.doesNotMatch(JSON.stringify(seen), new RegExp(`${W1}|${P1}`))
  // U2 讀到的是 x: 代號；用代號回寫（另一則）也還原成真實鍵，主持人看得到自己人
  const h2 = await human(db, room, '再一則')
  const refA = seen.wake_info[0].key
  assert.equal((await setInfo(db, { node: Q2, agent: null, signed: U2, room, seq: h2.seq, info: [{ key: refA, rank: 1, hold: false }] })).set, true)
  assert.deepEqual((await hostView(db, room, h2.seq)).wake_info.map(e => [e.key, e.label]), [[A, '財務']])
})

test('實跑：已離開群組的成員不列', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '一')
  await setInfo(db, { room, seq: h.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 2, hold: false }] })
  await db.exec(`update relay.room_members set left_at = now() where room_id = '${room}' and member = '${B}'`)
  assert.deepEqual((await hostView(db, room, h.seq)).wake_info.map(e => e.label), ['財務'])
})

test('還原驗證：拿掉「只在尚未有值時寫入」或「已離開不列」，對應測試要變紅', { skip }, async () => {
  const over = await boot({ mutate: { [MIG]: s => s.replace('and wake_info is null', '') } })
  const room = await room3(over)
  const h = await human(over, room, '一')
  await setInfo(over, { room, seq: h.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 2, hold: false }] })
  const again = await setInfo(over, { node: W1, agent: '管理', room, seq: h.seq, info: [{ key: B, rank: 1, hold: false }] })
  assert.equal(again.set, true, '拿掉守門後第二次會覆蓋＝守門測試有效')
  assert.deepEqual((await hostView(over, room, h.seq)).wake_info.map(e => e.label), ['管理'])
  const left = await boot({ mutate: { [MIG]: s => s.replace('and rm.left_at is null and rm.member = e.v->>', 'and rm.member = e.v->>') } })
  const room2 = await room3(left)
  const h2 = await human(left, room2, '一')
  await setInfo(left, { room: room2, seq: h2.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 2, hold: false }] })
  await left.exec(`update relay.room_members set left_at = now() where room_id = '${room2}' and member = '${B}'`)
  assert.deepEqual((await hostView(left, room2, h2.seq)).wake_info.map(e => e.label), ['財務', '管理'], '拿掉過濾後離開的人還在＝守門測試有效')
})
