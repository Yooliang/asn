// 群組成員清單多帶線上狀態與引擎（migration 20261025000000_room_member_presence.sql）。
// 1. 靜態：交易內、不刪資料、不授權 anon／authenticated、時間戳最新。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    - 視窗成員：名單回報 3 分鐘內＝online true，更久＝false；engine 取名單的 engine，沒有時取節點 kind
//    - 真人沒有 online／engine 欄位；既有欄位（label、display_label…）不變
//    - 外部帳號的讀者也拿得到 AI 的 online／engine，但輸出裡掃不到別人的節點代號與設備名
// 3. 還原驗證：把 3 分鐘改成 3 小時、或讓真人也帶欄位，對應測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261025000000_room_member_presence.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、不授權 anon／authenticated、時間戳最新', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /revoke all on function relay\.room_member_presence/)
  assert.ok(files.includes(MIG), 'migration 檔要在')   // 不再斷言「是最新一份」：之後每加一份新 migration 就會過期；先後順序由下一行檢查
  assert.ok(files.indexOf(MIG) > files.indexOf('20261024200000_acct_report_quota.sql'))
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

test('實跑：視窗成員的 online／engine——3 分鐘內在線、更久離線；真人沒有這兩個欄位；舊欄位不變', { skip }, async () => {
  const db = await boot()
  const room = await room2(db)
  await db.exec(`update relay.roster set seen_at = now() where node = '${W1}' and name = '財務';
                 update relay.roster set seen_at = now() - interval '10 minutes' where node = '${W1}' and name = '管理'`)
  const mem = (await membersAs(db, { node: P1, room, signed: U1 })).members
  const a = byName(mem, '財務'), b = byName(mem, '管理')
  assert.equal(a.online, true); assert.equal(a.engine, 'claude')
  assert.equal(b.online, false); assert.equal(b.engine, 'claude')
  assert.equal(a.display_label, '財務（家用機）', '既有欄位不變')
  const human = mem.find(m => m.member_kind === 'human')
  assert.ok(!('online' in human) && !('engine' in human), '真人不帶狀態')
})

test('實跑：名單沒有 engine 時取節點 kind；都沒有就不帶 engine；名單列不見＝離線', { skip }, async () => {
  const db = await boot()
  const room = await room2(db)
  await db.exec(`update relay.roster set seen_at = now(), engine = null where node = '${W1}'; update relay.nodes set kind = 'gemini' where id = '${W1}'`)
  const m1 = (await membersAs(db, { node: P1, room, signed: U1 })).members
  assert.equal(byName(m1, '財務').engine, 'gemini')
  await db.exec(`update relay.nodes set kind = 'weird' where id = '${W1}'`)
  const m2 = (await membersAs(db, { node: P1, room, signed: U1 })).members
  assert.ok(!('engine' in byName(m2, '財務')), '不認得的 kind 不當引擎')
  await db.exec(`delete from relay.roster where node = '${W1}' and name = '財務'`)
  assert.equal(byName((await membersAs(db, { node: P1, room, signed: U1 })).members, '財務').online, false)
})

test('實跑：外部帳號的讀者拿得到 AI 的 online／engine，但看不到節點代號與設備名', { skip }, async () => {
  const db = await boot()
  const room = await room2(db)
  await joinU2(db, room)
  await db.exec(`update relay.roster set seen_at = now() where node = '${W1}' and name = '財務'`)
  const seen = (await membersAs(db, { node: Q2, room, signed: U2 })).members
  const a = byName(seen, '財務')
  assert.equal(a.online, true); assert.equal(a.engine, 'claude')
  assert.doesNotMatch(JSON.stringify(seen), new RegExp(`${W1}|${P1}|家用機|小良的手機`))
})

test('還原驗證：3 分鐘改 3 小時、或讓真人也帶欄位，對應測試要變紅', { skip }, async () => {
  const slow = await boot({ mutate: { [MIG]: s => s.replace("r.seen_at > now() - interval '3 minutes'", "r.seen_at > now() - interval '3 hours'") } })
  const r1 = await room2(slow)
  await slow.exec(`update relay.roster set seen_at = now() - interval '10 minutes' where node = '${W1}' and name = '管理'`)
  assert.equal(byName((await membersAs(slow, { node: P1, room: r1, signed: U1 })).members, '管理').online, true, '門檻放寬後離線的變在線＝測試有效')
  const hum = await boot({ mutate: { [MIG]: s => s.replace("when p_member like '~%' then '{}'::jsonb", "when p_member like '~%' then jsonb_build_object('online', true)") } })
  const r2 = await room2(hum)
  const human = (await membersAs(hum, { node: P1, room: r2, signed: U1 })).members.find(m => m.member_kind === 'human')
  assert.ok('online' in human, '真人也帶欄位＝守門測試有效')
})
