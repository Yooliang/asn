// 群組已讀人數（#224，migration 20261024180000_group_read_receipts.sql）。
// 1. 靜態：交易內、不刪資料、新函式不授權給前台、整批訊息共用一份成員表（不為每則訊息各查一次）。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - 人數＝除發言者外、這則可見的有效成員中 read_seq ≥ 該則 seq；真人與 AI 都算；隨成員讀取增加
//    - 加入時間晚於這則（看不到這則）的人不算；已離開的不算；發言者本人不算
//    - 別租戶的讀者：只有人數（自己發的才有名單），名單標示加（主人名）、輸出掃不到節點代號與帳號 id
//    - 回應多帶 reads（讀者這邊最近發的訊息的已讀狀況），沒有新訊息時也更新；系統訊息與開頭紀錄不帶
// 3. 還原驗證：拿掉「≥」「可見起點」「離開」「排除發言者」任一個，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261024180000_group_read_receipts.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、不授權前台、整批共用成員表', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.ok(MIG > '20261024170000', '時間戳比 ai_silent_wake 新')
  assert.equal((code.match(/relay\.receipt_members\(/g) || []).length, 3, '定義一次、讀取時呼叫一次（整批共用）、收回授權一次')
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
const sha = c => crypto.createHash('sha256').update(c).digest('hex')
async function joinU2(db, room) {
  const code = 'code-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const inv = await rpc(db, 'asn_relay_group_invite_create', { p_user: U1, p_node: P1, p_kind: 'room', p_room: room, p_src_node: null, p_src_agent: null, p_seed: null, p_code_hash: sha(code) })
  assert.ok(!inv.error, JSON.stringify(inv))
  const acc = await rpc(db, 'asn_relay_group_invite_accept', { p_user: U2, p_node: Q2, p_code_hash: sha(code) })
  assert.ok(!acc.error, JSON.stringify(acc))
}
async function room3(db) {
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '已讀', p_ai: [A, B, C] })
  assert.ok(g.id, JSON.stringify(g))
  return g.id
}
const msgOf = (r, seq) => r.messages.find(m => m.seq === seq)
const markRead = (db, { node, agent = null, room, signed = null }) =>
  rpc(db, 'asn_relay_group_read', { p_node: node, p_agent: agent, p_room: room, p_since: 0, p_limit: 200, p_owner: false, p_tail: false, p_mark: true, p_signed_user: signed })
const human = (db, room, body) => post(db, { node: P1, room, signed: U1, body })
const host = async (db, room, seq) => msgOf(await readAs(db, { node: P1, room, signed: U1 }), seq)
const rcOf = m => [m.read_count, m.read_total]

test('實跑：人數隨成員讀取增加（真人與 AI 都算），發言者不算', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  await joinU2(db, room)
  const h = await human(db, room, '大家好')
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [0, 4], '五位成員除發言者＝4，還沒人讀')
  await markRead(db, { node: Q2, room, signed: U2 })
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [1, 4], '真人讀了')
  await markRead(db, { node: W1, agent: '財務', room })
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [2, 4], 'AI 讀了')
  await markRead(db, { node: W1, agent: '管理', room }); await markRead(db, { node: W1, agent: '監看', room })
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [4, 4], '全部讀完')
  await markRead(db, { node: P1, room, signed: U1 })
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [4, 4], '發言者自己讀不增加')
})

test('實跑：自己發的才有名單；名單是讀者看得到的標示', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '看名單')
  await markRead(db, { node: W1, agent: '財務', room })
  const m = await host(db, room, h.seq)
  assert.deepEqual(m.read_by, ['財務（工作機）']); assert.deepEqual([...m.unread_by].sort(), ['監看（工作機）', '管理（工作機）'].sort())
  const ai = await post(db, { node: W1, agent: '財務', room, body: 'AI 的話' })
  const other = await host(db, room, ai.seq)
  assert.equal(other.read_count, 0)
  assert.ok(other.read_by !== undefined, '同租戶 AI 發的也是讀者這邊發的')
})

test('實跑：看不到這則的人不算（晚加入）；已離開的不算', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '加入前的訊息')
  await joinU2(db, room)
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [0, 3], '後加入的 U2 看不到這則：不算讀者')
  const h2 = await human(db, room, '加入後的訊息')
  assert.deepEqual(rcOf(await host(db, room, h2.seq)), [0, 4])
  await markRead(db, { node: Q2, room, signed: U2 })
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [0, 3], 'U2 的 read_seq 超過這則也不算')
  await db.exec(`update relay.room_members set left_at = now() where room_id = '${room}' and member = '${B}'`)
  const m2 = await host(db, room, h2.seq)
  assert.deepEqual(rcOf(m2), [1, 3], '離開的不算人數也不算分母')
  assert.ok(!m2.unread_by.some(x => x.startsWith('管理')))
})

test('實跑：別租戶的讀者——只有人數；自己發的名單加（主人名）；掃不到節點代號與帳號 id', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  await joinU2(db, room)
  const h = await human(db, room, '主持人的話')
  const seenBy2 = msgOf(await readAs(db, { node: Q2, room, signed: U2 }), h.seq)
  assert.deepEqual(rcOf(seenBy2), [0, 4])
  assert.equal(seenBy2.read_by, undefined, '別人發的訊息不給名單'); assert.equal(seenBy2.unread_by, undefined)
  const mine = await post(db, { node: Q2, room, signed: U2, body: 'U2 發的' })
  await markRead(db, { node: W1, agent: '財務', room })
  const full = await readAs(db, { node: Q2, room, signed: U2 })
  const own = msgOf(full, mine.seq)
  assert.deepEqual(rcOf(own), [1, 4])
  assert.deepEqual(own.read_by, ['財務（小良）'])
  assert.ok(own.unread_by.includes('管理（小良）') && own.unread_by.includes('小良'), JSON.stringify(own.unread_by))
  const scan = JSON.stringify({ rb: own.read_by, ub: own.unread_by, reads: full.reads })
  assert.doesNotMatch(scan, new RegExp(`${W1}|${P1}|${U1}`))
})

test('實跑：reads 帶讀者這邊最近發的訊息，沒有新訊息時也更新；系統訊息與開頭紀錄不帶', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '一')
  const other = await human(db, room, '二')
  const peek = () => rpc(db, 'asn_relay_group_read', { p_node: P1, p_agent: null, p_room: room, p_since: other.seq, p_limit: 1, p_owner: false, p_tail: false, p_mark: false, p_signed_user: U1 })
  const r0 = await peek()
  assert.deepEqual(r0.messages, [], '沒有新訊息')
  assert.deepEqual(r0.reads.map(e => [e.seq, e.read_count]), [[h.seq, 0], [other.seq, 0]])
  await markRead(db, { node: W1, agent: '管理', room })
  const r1 = await peek()
  assert.deepEqual(r1.reads.map(e => [e.seq, e.read_count, e.read_by.length]), [[h.seq, 1, 1], [other.seq, 1, 1]], '管理讀了：即時反映')
  const all = await readAs(db, { node: P1, room, signed: U1 })
  for (const m of all.messages.filter(m => m.from_kind === 'system' || m.is_seed)) assert.equal(m.read_count, undefined, '系統訊息／開頭紀錄不帶')
})

test('實跑：舊欄位都還在（只多欄位）', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '舊欄位')
  const m = await host(db, room, h.seq)
  for (const k of ['seq', 'from', 'from_name', 'trust', 'from_kind', 'relation', 'from_label', 'from_display_label', 'body', 'mentions', 'at', 'is_seed', 'wake_ok', 'reply_to', 'wake_info']) assert.ok(k in m, k)
})

test('還原驗證：拿掉「≥」「可見起點」「離開」「排除發言者」，對應測試要變紅', { skip }, async () => {
  const mut = fn => boot({ mutate: { [MIG]: s => { const t = fn(s); assert.notEqual(t, s, '突變要真的改到'); return t } } })
  let db = await mut(s => s.replace('x.rs >= p_seq', 'x.rs > p_seq').replace('x.rs >= p_seq', 'x.rs > p_seq'))
  let room = await room3(db)
  let h = await human(db, room, '一'); await markRead(db, { node: W1, agent: '財務', room })
  assert.notDeepEqual(rcOf(await host(db, room, h.seq)), [1, 3], '≥ 改 >：剛好讀到這則的人不算＝測試有效')
  db = await mut(s => s.replace('and coalesce(x.vf, 0) < p_seq', ''))
  room = await room3(db); h = await human(db, room, '一'); await joinU2(db, room)
  assert.notDeepEqual(rcOf(await host(db, room, h.seq)), [0, 3], '拿掉可見起點：晚加入者被算進分母＝測試有效')
  db = await mut(s => s.replace('where m.room_id = p_room and m.left_at is null;', 'where m.room_id = p_room;'))
  room = await room3(db); h = await human(db, room, '一')
  await db.exec(`update relay.room_members set left_at = now() where room_id = '${room}' and member = '${B}'`)
  assert.deepEqual(rcOf(await host(db, room, h.seq)), [0, 3], '拿掉離開過濾：離開的人還在分母＝測試有效')
  db = await mut(s => s.replace('where x.m <> p_from and', 'where'))
  room = await room3(db); h = await human(db, room, '一')
  assert.notDeepEqual(rcOf(await host(db, room, h.seq)), [0, 3], '不排除發言者：發言者被算進去＝測試有效')
})
