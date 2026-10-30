// 外部成員的群組也能傳附件（0.1.111，小良哥 2026-10-30 指示）：asn_relay_attach_access 改依「群組現有成員的設備」授權。
// 1. 靜態：migration 在交易內、不刪資料、不授權給 anon／authenticated／public。
// 2. 實跑（需要 @electric-sql/pglite）：
//    - 跨租戶群組：房內各租戶成員的設備都下載得到；群組外的人（別的租戶）下載不到
//    - 一對一附件：別的帳號下載不到（照舊）
//    - 退出群組後下載不到
// 3. 還原驗證：把附件查詢改回「同租戶才行」，跨租戶那個測試要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const M_ATT = '20261030010000_room_attach_external.sql'

test('靜態：migration 在交易內、不刪資料、不開放給 anon／authenticated；只改下載授權函式', () => {
  const sql = read(M_ATT)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function|grant /i)
  assert.equal([...code.matchAll(/create or replace function ([\w.]+)/g)].map(m => m[1]).join(), 'public.asn_relay_attach_access')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111' // 小良（主持人）
const U2 = '22222222-2222-2222-2222-222222222222' // 財務人員
const U3 = '33333333-3333-3333-3333-333333333333' // 局外人
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const T3 = 'cccccccc-0000-0000-0000-000000000003'
// 節點代號刻意取有辨識度的字串，掃輸出時才抓得到洩露
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4', R3 = 'rrr5e6'
const sha = s => createHash('sha256').update(s).digest('hex')

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
    insert into auth.users(id, email) values ('${U1}', 'a@x.y'), ('${U2}', 'b@x.y'), ('${U3}', 'c@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良'), ('${T2}', '${U2}', '財務員'), ('${T3}', '${U3}', '路人');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${P1}', '小良的手機', 'k1', 'bell-p1', 'member', '${T1}', '${U1}', 'active', '手機'),
      ('${W1}', '工作機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦'),
      ('${R3}', '路人電腦', 'k4', 'bell-r3', 'member', '${T3}', '${U3}', 'active', '電腦');
    insert into relay.roster(node, name, engine) values ('${W1}', '財務', 'claude'), ('${W1}', '同名', 'claude'), ('${Q2}', '同名', 'claude'),
      ('${Q2}', '助理', 'claude'), ('${R3}', '路人AI', 'claude');
    insert into relay.roster(node, name, engine) select '${W1}', 'w' || g, 'claude' from generate_series(1, 10) g;`)
  return db
}

// 具名參數呼叫 public 函式
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const q = async (db, text, a = []) => (await db.query(text, a)).rows

async function invite(db, { by = U1, node = P1, seed, kind = 'conversation', room = null, code }) {
  const c = code ?? 'code-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const r = await rpc(db, 'asn_relay_group_invite_create', {
    p_user: by, p_node: node, p_kind: kind, p_room: room, p_src_node: kind === 'conversation' ? W1 : null,
    p_src_agent: kind === 'conversation' ? '財務' : null, p_seed: seed ?? null, p_code_hash: sha(c) })
  return { c, h: sha(c), r }
}
const accept = (db, h, by = U2, node = Q2) => rpc(db, 'asn_relay_group_invite_accept', { p_user: by, p_node: node, p_code_hash: h })
async function twoTenantRoom(db) {
  const g = await rpc(db, 'asn_relay_group_create', { p_user: U1, p_node: P1, p_name: '跨租戶', p_ai: [`${W1}~財務`, `${W1}~同名`] })
  const inv = await invite(db, { kind: 'room', room: g.id })
  await accept(db, inv.h)
  const ai = await rpc(db, 'asn_relay_group_ai_add', { p_user: U2, p_node: Q2, p_room: g.id, p_keys: [`${Q2}~助理`, `${Q2}~同名`] })
  assert.equal(ai.added, 2)
  return g.id
}


const GID = '99999999-9999-9999-9999-999999999999', MID = '88888888-8888-8888-8888-888888888888'
const addRoomAtt = (db, room) => db.exec(`insert into relay.attachments(id, tenant_id, owner_node, kind, mime, name, bytes, storage_path, status, room_id, room_seq)
  values ('${GID}', '${T1}', '${W1}', 'file', 'application/pdf', 'a.pdf', 10, 'p/a.pdf', 'ready', '${room}', 1)`)
const access = (db, node, id = GID) => rpc(db, 'asn_relay_attach_access', { p_node: node, p_id: id })

test('實跑：有外部成員的群組——各租戶成員的設備都下載得到；群組外的人（別的租戶）下載不到', { skip }, async () => {
  const db = await boot()
  const room = await twoTenantRoom(db)
  assert.equal(await rpc(db, 'asn_relay_group_has_external', { p_node: P1, p_room: room }), true, '這是有外部成員的群組')
  await addRoomAtt(db, room)
  assert.equal((await access(db, W1)).path, 'p/a.pdf', '上傳的人')
  assert.equal((await access(db, P1)).path, 'p/a.pdf', '主持人的手機')
  assert.equal((await access(db, Q2)).path, 'p/a.pdf', '外部成員（別的帳號）的設備')
  assert.equal((await access(db, R3)).error, 'not_found', '群組外的人下載不到')
})

test('實跑：一對一附件別的帳號仍然下載不到；退出群組後也下載不到', { skip }, async () => {
  const db = await boot()
  const room = await twoTenantRoom(db)
  await addRoomAtt(db, room)
  await db.exec(`insert into relay.messages(id, from_node, from_agent, to_node, to_agent, body, tenant_id) values ('${MID}', '${P1}', 'x', '${W1}', '財務', '附件', '${T1}')`)
  const one = '77777777-7777-7777-7777-777777777777'
  await db.exec(`insert into relay.attachments(id, tenant_id, owner_node, kind, mime, name, bytes, storage_path, status, message_id)
    values ('${one}', '${T1}', '${P1}', 'file', 'application/pdf', 'b.pdf', 10, 'p/b.pdf', 'ready', '${MID}')`)
  assert.equal((await access(db, W1, one)).path, 'p/b.pdf', '收件人')
  assert.equal((await access(db, Q2, one)).error, 'not_found', '同群組的外部成員也不能下載一對一附件')
  assert.equal((await access(db, R3, one)).error, 'not_found')
  assert.equal((await access(db, Q2)).path, 'p/a.pdf', '群組附件在退出前下載得到')
  assert.deepEqual(await rpc(db, 'asn_relay_group_leave', { p_user: U2, p_node: Q2, p_room: room }), { ok: true })
  assert.equal((await access(db, Q2)).error, 'not_found', '外部成員退出後下載不到')
  assert.equal((await access(db, P1)).path, 'p/a.pdf', '還在群組的人照常')
})

test('還原驗證：附件查詢改回「同租戶才行」→ 外部成員下載不到，跨租戶測試要變紅', { skip }, async () => {
  const db = await boot({ mutate: { [M_ATT]: s => s.replace("where id = p_id and status <> 'pending';", "where id = p_id and tenant_id is not distinct from v_t and status <> 'pending';") } })
  const room = await twoTenantRoom(db)
  await addRoomAtt(db, room)
  assert.equal((await access(db, P1)).path, 'p/a.pdf')
  assert.equal((await access(db, Q2)).error, 'not_found', '被改回去：外部成員下載不到（正式版本不是這樣）')
})
