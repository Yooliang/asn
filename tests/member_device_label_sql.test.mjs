// 群組成員／發言者標示改用「夥伴名（設備名）」（migration 20261024160000_member_device_label.sql）。
// 1. 靜態：交易內、不刪資料、新函式不授權 anon／authenticated、時間戳最新。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - 自己帳號下的夥伴 display_label＝「夥伴名（設備名）」；label／from_label 維持舊值（舊用戶端照舊）
//    - 別的帳號的夥伴 display_label＝「夥伴名（帳號主人名）」；輸出裡掃不到別人的設備名與節點代號
//    - 設備名取不到（或與夥伴名相同）只有夥伴名；真人不變
//    - 訊息與回覆引用都帶 from_display_label，且與成員清單的 display_label 同一個字串
// 3. 還原驗證：把自己夥伴的規則改回主人名，或讓外部成員也拿設備名，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261024160000_member_device_label.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、不授權 anon／authenticated、時間戳最新', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /revoke all on function relay\.room_display_label/)
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
const A = `${W1}~財務`, B = `${W1}~管理`

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
      ('${W1}', '家用機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');
    insert into relay.roster(node, name, engine) values ('${W1}', '財務', 'claude'), ('${W1}', '管理', 'claude'), ('${Q2}', '助理', 'claude');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const post = (db, { node, agent = null, room, body, mentions = [], signed = null, reply }) =>
  rpc(db, reply === undefined ? 'asn_relay_room_post' : 'asn_relay_room_post_reply', { p_node: node, p_agent: agent, p_room: room, p_body: body, p_mentions: mentions, p_owner: false, p_signed_user: signed, ...(reply === undefined ? {} : { p_reply_to_seq: reply }) })
const readAs = (db, { node, agent = null, room, signed = null }) =>
  rpc(db, 'asn_relay_group_read', { p_node: node, p_agent: agent, p_room: room, p_since: null, p_limit: 200, p_owner: false, p_tail: true, p_mark: false, p_signed_user: signed })
const membersAs = (db, { node, agent = null, room, signed = null }) =>
  rpc(db, 'asn_relay_group_members', { p_node: node, p_agent: agent, p_room: room, p_owner: false, p_signed_user: signed })
const sha = c => crypto.createHash('sha256').update(c).digest('hex')
async function joinU2(db, room) {
  const code = 'code-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const inv = await rpc(db, 'asn_relay_group_invite_create', { p_user: U1, p_node: P1, p_kind: 'room', p_room: room, p_src_node: null, p_src_agent: null, p_seed: null, p_code_hash: sha(code) })
  assert.ok(!inv.error, JSON.stringify(inv))
  const acc = await rpc(db, 'asn_relay_group_invite_accept', { p_user: U2, p_node: Q2, p_code_hash: sha(code) })
  assert.ok(!acc.error, JSON.stringify(acc))
}
async function room2(db) {
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '標示', p_ai: [A, B] })
  assert.ok(g.id, JSON.stringify(g))
  return g.id
}
const byName = (members, name) => members.find(m => m.name === name)

test('實跑：自己帳號下的夥伴＝夥伴名（設備名）；label 維持舊值；真人不變', { skip }, async () => {
  const db = await boot()
  const room = await room2(db)
  const mem = (await membersAs(db, { node: P1, room, signed: U1 })).members
  const a = byName(mem, '財務')
  assert.equal(a.display_label, '財務（家用機）')
  assert.equal(a.label, '財務（小良）', '舊用戶端看的 label 不變')
  assert.equal(byName(mem, '管理').display_label, '管理（家用機）')
  const human = mem.find(m => m.member_kind === 'human')
  assert.equal(human.display_label, human.label, '真人不變')
  assert.doesNotMatch(JSON.stringify(mem.map(m => m.display_label)), new RegExp(`${W1}|${P1}`), '標示裡沒有節點代號')
})

test('實跑：設備名取不到或與夥伴名相同——只有夥伴名，不出現節點代號', { skip }, async () => {
  const db = await boot()
  const room = await room2(db)
  await db.exec(`update relay.nodes set name = '財務' where id = '${W1}'`)
  const mem1 = (await membersAs(db, { node: P1, room, signed: U1 })).members
  assert.equal(byName(mem1, '財務').display_label, '財務', '設備名＝夥伴名就不重複')
  assert.equal(byName(mem1, '管理').display_label, '管理（財務）')
  await db.exec(`update relay.nodes set name = '   ' where id = '${W1}'`)
  const mem2 = (await membersAs(db, { node: P1, room, signed: U1 })).members
  assert.equal(byName(mem2, '管理').display_label, '管理', '空白設備名＝取不到')
  assert.doesNotMatch(JSON.stringify(mem2.map(m => m.display_label)), new RegExp(W1))
})

test('實跑：別的帳號的夥伴＝夥伴名（主人名），不外洩別人的設備名；自己的夥伴對自己仍是設備名', { skip }, async () => {
  const db = await boot()
  const room = await room2(db)
  await joinU2(db, room)
  await db.exec(`update relay.room_members set display_name = null where room_id = '${room}'`)
  const seen = (await membersAs(db, { node: Q2, room, signed: U2 })).members
  assert.equal(byName(seen, '財務').display_label, '財務（小良）')
  assert.equal(byName(seen, '財務').label, '財務（小良）')
  assert.doesNotMatch(JSON.stringify(seen), /家用機|小良的手機/, '外部成員看不到對方帳號的設備名')
  const host = (await membersAs(db, { node: P1, room, signed: U1 })).members
  assert.equal(byName(host, '財務').display_label, '財務（家用機）')
})

test('實跑：訊息與回覆引用的作者標示跟成員清單同一個字串；外部讀者拿到主人名', { skip }, async () => {
  const db = await boot()
  const room = await room2(db)
  await joinU2(db, room)
  const first = await post(db, { node: W1, agent: '財務', room, body: '我是財務' })
  const rep = await post(db, { node: P1, room, signed: U1, body: '收到', reply: first.seq })
  const host = await readAs(db, { node: P1, room, signed: U1 })
  const m1 = host.messages.find(m => m.seq === first.seq)
  assert.equal(m1.from_display_label, '財務（家用機）')
  assert.equal(m1.from_label, '財務（小良）', '舊欄位不變')
  const m2 = host.messages.find(m => m.seq === rep.seq)
  assert.equal(m2.from_display_label, m2.from_label, '真人不變')
  assert.equal(m2.reply_to.from_display_label, '財務（家用機）')
  const hostMem = (await membersAs(db, { node: P1, room, signed: U1 })).members
  assert.equal(m1.from_display_label, byName(hostMem, '財務').display_label)
  const ext = await readAs(db, { node: Q2, room, signed: U2 })
  const e2 = ext.messages.find(m => m.seq === rep.seq)
  assert.equal(e2.reply_to.from_display_label, '財務（小良）')
  assert.equal(ext.messages.find(m => m.seq === first.seq).from_display_label, '財務（小良）')
  assert.doesNotMatch(JSON.stringify(ext), /家用機/)
})

test('還原驗證：自己夥伴改回主人名、或外部成員也拿設備名，對應測試要變紅', { skip }, async () => {
  const owner = await boot({ mutate: { [MIG]: s => s.replace("select '（' || nullif(btrim(n.name), '') || '）' from relay.nodes n", "select '（' || coalesce(relay.room_owner_name(p_member, p_rt), '?') || '）' from relay.nodes n") } })
  const r1 = await room2(owner)
  assert.notEqual(byName((await membersAs(owner, { node: P1, room: r1, signed: U1 })).members, '財務').display_label, '財務（家用機）', '改回主人名後自己夥伴不再是設備名＝測試有效')
  const leak = await boot({ mutate: { [MIG]: s => s.replace("else relay.room_display_name(p_room, p_member) || '（' || coalesce(relay.room_owner_name(p_member, p_rt), '?') || '）'", "else relay.room_display_name(p_room, p_member) || '（' || coalesce((select n.name from relay.nodes n where n.id = split_part(p_member, '~', 1)), '?') || '）'") } })
  const r2 = await room2(leak)
  await joinU2(leak, r2)
  const seen = (await membersAs(leak, { node: Q2, room: r2, signed: U2 })).members
  assert.match(JSON.stringify(seen), /家用機/, '外部成員拿到設備名＝外洩守門測試有效')
})
