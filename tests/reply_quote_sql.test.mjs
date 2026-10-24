// 針對某則訊息回覆（#225，migration 20261024140000_reply_quote.sql）：群組訊息帶引用（reply_to_seq），讀取時由後台算出原作者與摘要。
// 1. 靜態：交易內、不動 asn_relay_room_post（新增 asn_relay_room_post_reply 包一層）、新函式只授權 service_role。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - 回覆帶出 reply_to＝{ seq, from_kind, from_label, excerpt }，摘要壓成一行、最多 80 字、不含原訊息的引用行
//    - 自動 @ 原作者：沒寫 @ 也會把原作者記進 mentions；回覆自己的訊息不點自己
//    - 舊用戶端相容：不帶 reply_to 的發言照舊（reply_to 為 null）；指向不存在的序號只當沒引用、訊息照樣寫入
//    - 看不到加入前訊息的人：被引用的訊息在他加入之前就讀不到引用（不外洩）
//    - 別租戶的原作者對讀者是 x: 對外代號，不含節點代號
// 3. 還原驗證：拿掉「自動 @」或「加入前不外洩」的判斷，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261024140000_reply_quote.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、只換掉 room_post 的舊簽章、不刪資料、只授權 service_role', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate/i)
  assert.doesNotMatch(code, /drop function/i, '舊的 room_post 簽章不能動：改名守門與回復腳本都依賴它')
  assert.doesNotMatch(code, /create or replace function public\.asn_relay_room_post\(/, 'room_post 本體不重寫')
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /add column if not exists reply_to_seq bigint/)
  assert.match(sql, /asn_relay_room_post_reply\(p_node text, p_agent text, p_room text, p_body text, p_mentions text\[\], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid, p_reply_to_seq bigint DEFAULT NULL::bigint\)/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111' // 主持人
const U2 = '22222222-2222-2222-2222-222222222222' // 受邀的人
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const A = `${W1}~財務`

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
    insert into relay.roster(node, name, engine) values ('${W1}', '財務', 'claude'), ('${Q2}', '助理', 'claude');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const post = (db, { node, agent = null, room, body, mentions = [], signed = null, reply = undefined }) =>
  rpc(db, reply === undefined ? 'asn_relay_room_post' : 'asn_relay_room_post_reply', { p_node: node, p_agent: agent, p_room: room, p_body: body, p_mentions: mentions, p_owner: false, p_signed_user: signed, ...(reply === undefined ? {} : { p_reply_to_seq: reply }) })
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
const human = (db, room, body, extra = {}) => post(db, { node: P1, room, signed: U1, body, ...extra })
const ai = (db, room, body, extra = {}) => post(db, { node: W1, agent: '財務', room, body, ...extra })

async function room1(db) {
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '回覆', p_ai: [A] })
  assert.ok(g.id, JSON.stringify(g))
  return g.id
}
const msgOf = (r, seq) => r.messages.find(m => m.seq === seq)

test('實跑：回覆帶出引用（原作者、種類、一行摘要），且自動 @ 原作者（沒寫 @ 也會記進 mentions）', { skip }, async () => {
  const db = await boot()
  const room = await room1(db)
  const long = '第一行\n第二行　' + '字'.repeat(120)
  const a = await ai(db, room, long)
  const r = await human(db, room, '好，請繼續', { reply: a.seq })
  assert.ok(r.seq, JSON.stringify(r))
  const out = await readAs(db, { node: P1, room, signed: U1 })
  const m = msgOf(out, r.seq)
  assert.equal(m.reply_to.seq, a.seq); assert.equal(m.reply_to.from_kind, 'ai'); assert.equal(m.reply_to.from_label, '財務（小良）')
  assert.ok(!m.reply_to.excerpt.includes('\n') && [...m.reply_to.excerpt].length <= 80 && m.reply_to.excerpt.startsWith('第一行 第二行'), m.reply_to.excerpt)
  assert.deepEqual(m.mentions, [A], '自動 @ 原作者：沒寫 @名字 也記進 mentions')
  assert.equal(msgOf(out, a.seq).reply_to, null, '沒回覆別人的訊息 reply_to 為 null')
  // 回覆自己的訊息：不點自己
  const self = await human(db, room, '補充', { reply: r.seq })
  assert.deepEqual(msgOf(await readAs(db, { node: P1, room, signed: U1 }), self.seq).mentions, [])
})

test('實跑：引用行不進摘要（回覆的回覆摘要取下面的內容）', { skip }, async () => {
  const db = await boot()
  const room = await room1(db)
  const a = await ai(db, room, '原話')
  const b = await human(db, room, '↩ 回覆 財務（小良）：原話\n@財務（小良） 這是我的意見', { reply: a.seq, mentions: [A] })
  const c = await ai(db, room, '收到', { reply: b.seq })
  const out = await readAs(db, { node: P1, room, signed: U1 })
  assert.equal(msgOf(out, c.seq).reply_to.excerpt, '@財務（小良） 這是我的意見')
})

test('實跑：舊用戶端相容——不帶 reply_to 照舊、指向不存在的序號只當沒引用；七個參數的舊呼叫仍可用', { skip }, async () => {
  const db = await boot()
  const room = await room1(db)
  const p = await human(db, room, '一般訊息')
  assert.equal(msgOf(await readAs(db, { node: P1, room, signed: U1 }), p.seq).reply_to, null)
  const bad = await human(db, room, '引用不存在的', { reply: 9999 })
  assert.ok(bad.seq, '訊息照樣寫入')
  assert.equal(msgOf(await readAs(db, { node: P1, room, signed: U1 }), bad.seq).reply_to, null)
  const old = await rpc(db, 'irori_relay_room_post', { p_node: W1, p_agent: '財務', p_room: room, p_body: '舊呼叫', p_mentions: [], p_owner: false, p_signed_user: null })
  assert.ok(old.seq, JSON.stringify(old))
})

test('實跑：加入之前的訊息看不到——被引用的訊息在讀者加入前，引用不外洩；別租戶的原作者是 x: 對外代號', { skip }, async () => {
  const db = await boot()
  const room = await room1(db)
  const early = await ai(db, room, '加入前的機密內容')
  await joinU2(db, room)
  // 主持人在 U2 加入之後回覆加入前的訊息
  const r = await human(db, room, '回覆舊訊息', { reply: early.seq })
  const seenByHost = msgOf(await readAs(db, { node: P1, room, signed: U1 }), r.seq)
  assert.ok(seenByHost.reply_to, '主持人看得到')
  const seenByU2 = msgOf(await readAs(db, { node: Q2, room, signed: U2 }), r.seq)
  assert.equal(seenByU2.reply_to, null, '加入前的訊息看不到，引用也不外洩')
  // 別租戶的人回覆主持人的訊息：對主持人而言原作者是外部成員，對外代號 x:，不含節點代號
  const h = await human(db, room, '大家好')
  const back = await post(db, { node: Q2, room, signed: U2, body: '收到', reply: h.seq })
  const seenByHost2 = msgOf(await readAs(db, { node: P1, room, signed: U1 }), back.seq)
  assert.match(seenByHost2.reply_to.from, /^~u:|^~owner$/)
  const seenByU2b = msgOf(await readAs(db, { node: Q2, room, signed: U2 }), back.seq)
  assert.match(seenByU2b.reply_to.from, /^x:/)
  assert.doesNotMatch(JSON.stringify(seenByU2b.reply_to), new RegExp(`${P1}|${W1}`))
})

test('還原驗證：拿掉自動 @ 或加入前不外洩的判斷，對應測試要變紅', { skip }, async () => {
  const noAuto = await boot({ mutate: { [MIG]: s => s.replace(/-- AUTO_MENTION_START[\s\S]*?-- AUTO_MENTION_END/, '') } })
  const room = await room1(noAuto)
  const a = await ai(noAuto, room, '原話')
  const r = await human(noAuto, room, '好', { reply: a.seq })
  assert.notDeepEqual(msgOf(await readAs(noAuto, { node: P1, room, signed: U1 }), r.seq).mentions, [A], '沒有自動 @ 的版本不該通過原本的斷言')
  const leak = await boot({ mutate: { [MIG]: s => s.replace('and q.seq > coalesce(p_vis, 0)', 'and true') } })
  const room2 = await room1(leak)
  const early = await ai(leak, room2, '機密')
  await joinU2(leak, room2)
  const r2 = await human(leak, room2, '回覆舊訊息', { reply: early.seq })
  assert.ok(msgOf(await readAs(leak, { node: Q2, room: room2, signed: U2 }), r2.seq).reply_to, '拿掉判斷後引用就外洩了＝守門測試有效')
})
