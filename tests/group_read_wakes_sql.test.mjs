// 晚到的叫醒順序（migration 20261024210000_group_read_wakes.sql）：發言者的用戶端比 AI 先讀到訊息，wake_info 還是 null；
// 之後靠 asn_relay_group_read 回應多帶的 wakes（最近 40 則內已有 wake_info 的 [{seq, wake_info}]）補上。
// 1. 靜態：交易內、不刪資料、不授權前台、時間戳比 group_read_receipts 新、只讀不寫。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - 還沒存 wake_info 的訊息不出現在 wakes；存了之後出現（沒有新訊息的輪詢呼叫也拿得到）
//    - 補問不標已讀、不改 reads；系統訊息與開頭紀錄不帶；只帶最近 40 則；看不到的（可見起點之前）不帶
//    - 別租戶的讀者只看到對外代號（x:），輸出掃不到節點代號與帳號 id；已離開的成員不列
// 3. 還原驗證：拿掉「已有 wake_info」過濾、「wake_view」、「最近 40 則」，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261024210000_group_read_wakes.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、不授權前台、時間戳夠新、wakes 只讀不寫', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.ok(MIG > '20261024200000_acct_report_quota.sql', '時間戳比最新的 migration 新')
  assert.match(code, /'wakes', v_wakes/)
  assert.doesNotMatch(code.slice(code.indexOf('v_wakes jsonb;') + 14).replace(/update relay\.room_members set read_seq/, ''), /\binsert\b|wake_info\s*=/i, '只讀已存結果，不寫 wake_info')
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
const human = (db, room, body) => post(db, { node: P1, room, signed: U1, body })
const aiPost = (db, room, from, body, mentions = []) => post(db, { node: W1, agent: from.split('~')[1], room, body, mentions })
const setInfo = (db, { node = W1, agent = '財務', room, seq, info, signed = null }) =>
  rpc(db, 'asn_relay_room_wake_set', { p_node: node, p_agent: agent, p_room: room, p_seq: seq, p_info: JSON.stringify(info), p_owner: false, p_signed_user: signed })
// 沒有新訊息的輪詢呼叫（用戶端補問用）：從最後一則之後讀 1 則、不標已讀
const peek = (db, room, since, { node = P1, signed = U1, mark = false } = {}) =>
  rpc(db, 'asn_relay_group_read', { p_node: node, p_agent: null, p_room: room, p_since: since, p_limit: 1, p_owner: false, p_tail: false, p_mark: mark, p_signed_user: signed })
// 填充訊息：輪流用三個 AI 成員發（每位成員每小時 20 則的發言上限）
const fill = async (db, room, n) => { let r; for (let i = 0; i < n; i++) r = await aiPost(db, room, [A, B, C][i % 3], '填充' + i); return r }
const passers = (...keys) => keys.map((k, i) => ({ key: k, rank: i + 1, hold: false }))

test('實跑：存之前 wakes 是空的；AI 算出並存回後，發言者沒有新訊息的輪詢也拿得到（含標示與順位）', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '大家看一下')
  const r0 = await peek(db, room, h.seq)
  assert.deepEqual(r0.messages, []); assert.deepEqual(r0.wakes, [], '還沒存')
  assert.equal(msgOf(await rpc(db, 'asn_relay_group_read', { p_node: P1, p_agent: null, p_room: room, p_since: null, p_limit: 200, p_owner: false, p_tail: true, p_mark: false, p_signed_user: U1 }), h.seq).wake_info, null)
  assert.equal((await setInfo(db, { room, seq: h.seq, info: passers(A, B) })).set, true)
  const r1 = await peek(db, room, h.seq)
  assert.deepEqual(r1.messages, [])
  assert.equal(r1.wakes.length, 1)
  assert.equal(r1.wakes[0].seq, h.seq)
  assert.deepEqual(r1.wakes[0].wake_info.map(e => [e.label, e.rank, e.hold]), [['財務', 1, false], ['管理', 2, false]])
})

test('實跑：補問不標已讀、不改 reads；系統訊息與開頭紀錄不帶；沒有 wake_info 的不帶', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '一')
  const h2 = await human(db, room, '二（沒存）')
  await setInfo(db, { room, seq: h.seq, info: passers(A) })
  const before = (await db.query(`select read_seq from relay.room_members where room_id = $1 and member = '~u:${U1}'`, [room])).rows[0].read_seq
  const r = await peek(db, room, h2.seq)
  assert.deepEqual(r.wakes.map(e => e.seq), [h.seq], '沒存的不帶')
  assert.deepEqual(r.reads.map(e => e.seq), [h.seq, h2.seq], 'reads 照舊')
  const after = (await db.query(`select read_seq from relay.room_members where room_id = $1 and member = '~u:${U1}'`, [room])).rows[0].read_seq
  assert.equal(after, before, 'mark=false 不動已讀位置')
  // 系統訊息與開頭紀錄：就算硬塞了 wake_info 也不帶
  await db.exec(`update relay.room_messages set wake_info = '[{"m":"${A}","rank":1,"hold":false}]'::jsonb where room_id = '${room}' and (from_kind = 'system' or is_seed)`)
  const sysRows = (await db.query(`select count(*)::int n from relay.room_messages where room_id = $1 and (from_kind = 'system' or is_seed)`, [room])).rows[0].n
  const r2 = await peek(db, room, h2.seq)
  assert.deepEqual(r2.wakes.map(e => e.seq), [h.seq], `系統／開頭紀錄（${sysRows} 則）不帶`)
})

test('實跑：只帶最近 40 則；可見起點之前的不帶', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const first = await human(db, room, '很久以前')
  await setInfo(db, { room, seq: first.seq, info: passers(A) })
  let last
  last = await fill(db, room, 41)
  const recent = await human(db, room, '最近')
  await setInfo(db, { room, seq: recent.seq, info: passers(B) })
  const r = await peek(db, room, recent.seq)
  assert.deepEqual(r.wakes.map(e => e.seq), [recent.seq], '超過 40 則前的不帶')
  assert.ok(last.seq > first.seq)
})

test('實跑：別租戶的讀者只看到對外代號；掃不到節點代號與帳號 id；已離開的成員不列', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  await joinU2(db, room)
  const h = await human(db, room, '主持人的話')
  await setInfo(db, { room, seq: h.seq, info: [{ key: A, rank: 1, hold: false }, { key: B, rank: 2, hold: false }, { key: C, rank: 0, hold: true }] })
  const r = await peek(db, room, h.seq, { node: Q2, signed: U2 })
  assert.equal(r.wakes.length, 1)
  assert.equal(r.wakes[0].wake_info.length, 3)
  assert.ok(r.wakes[0].wake_info.every(e => /^x:/.test(e.key)), JSON.stringify(r.wakes))
  assert.doesNotMatch(JSON.stringify(r.wakes), new RegExp(`${W1}|${P1}|${U1}`))
  await db.exec(`update relay.room_members set left_at = now() where room_id = '${room}' and member = '${B}'`)
  const r2 = await peek(db, room, h.seq)
  assert.equal(r2.wakes[0].wake_info.length, 2, '離開的成員不列')
})

test('實跑：舊欄位都還在（只多 wakes）', { skip }, async () => {
  const db = await boot()
  const room = await room3(db)
  const h = await human(db, room, '舊欄位')
  const r = await peek(db, room, h.seq - 1)
  for (const k of ['messages', 'last_seq', 'key', 'reads', 'wakes']) assert.ok(k in r, k)
})

test('還原驗證：拿掉「已有 wake_info」過濾、wake_view、最近 40 則，對應測試要變紅', { skip }, async () => {
  const mut = fn => boot({ mutate: { [MIG]: s => { const t = fn(s); assert.notEqual(t, s, '突變要真的改到'); return t } } })
  let db = await mut(s => s.replace("and m.wake_info is not null and jsonb_typeof(m.wake_info) = 'array'", ''))
  let room = await room3(db); let h = await human(db, room, '一')
  assert.notDeepEqual((await peek(db, room, h.seq)).wakes, [], '拿掉過濾：沒存的也被帶出來＝「存之前是空的」測試會紅')
  db = await mut(s => s.replace('relay.wake_view(p_room, m.wake_info, v_reader, v_rt)', 'm.wake_info'))
  room = await room3(db); await joinU2(db, room); h = await human(db, room, '二')
  await setInfo(db, { room, seq: h.seq, info: passers(A) })
  assert.match(JSON.stringify((await peek(db, room, h.seq, { node: Q2, signed: U2 })).wakes), new RegExp(W1), '不走 wake_view：節點代號外洩＝可見性測試會紅')
  db = await mut(s => s.replace("coalesce(v_last, 0) - 40)\n    and not m.is_seed and m.from_kind is distinct from 'system'\n    and m.wake_info", "coalesce(v_last, 0) - 4000)\n    and not m.is_seed and m.from_kind is distinct from 'system'\n    and m.wake_info"))
  room = await room3(db); const first = await human(db, room, '很久以前'); await setInfo(db, { room, seq: first.seq, info: passers(A) })
  await fill(db, room, 41)
  const recent = await human(db, room, '最近')
  assert.ok((await peek(db, room, recent.seq)).wakes.some(e => e.seq === first.seq), '拿掉 40 則限制：舊的也被帶出來＝限制測試會紅')
})
