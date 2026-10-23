// #14 R7：信任只認本人簽章（20261023050000_trust_owner_signed_only.sql）。
// 1. 靜態：交易內、不改資料表與權限、拿掉的是 role 判斷而不是整個 trust。
// 2. 實跑（需要 @electric-sql/pglite；自己 `npm i --no-save @electric-sql/pglite`）：套全部 migrations 後驗證——
//    - 本人簽章的信是 trust=owner；舊租戶 role='owner' 的角色節點寄的信是 member；一般成員是 member
//    - 群組發言：角色節點是 member、p_owner 與本人簽章是 owner；角色節點仍能以 ~owner 身分發言（成員身分不動）
//    - 仍認 role='owner' 的特權動作（invite、acct_list）對角色節點照舊可用、對一般成員照舊拒絕
//    - ~owner 的顯示名取租戶的帳號名稱，沒有名稱用「帳號擁有者」，不再有「小良哥」
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261023050000_trust_owner_signed_only.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const sql = read(MIG)
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、只改函式、不動權限與資料表；inbox 與 room_post 的 trust 不再看 role', () => {
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /alter table|drop function|create table|grant |revoke /i)
  const body = sql.replace(/^--.*$/gm, '')
  assert.equal((body.match(/case when m\.owner_signed then 'owner' else 'member' end/g) || []).length, 2, 'inbox 與 inbox_agent 各一處')
  assert.doesNotMatch(body, /f\.role = 'owner'/)
  assert.match(body, /v_trust := case when p_owner or public\.asn_user_owns_node\(p_signed_user, p_node\)/)
  assert.doesNotMatch(body, /v_trust := [^;]*room_actor_is_owner/)
  assert.doesNotMatch(body, /小良/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const U1 = '11111111-1111-1111-1111-111111111111'

async function boot({ upTo } = {}) {
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
    if (upTo && f >= upTo) break
    await db.exec(read(f))
  }
  await db.exec(`insert into auth.users(id, email) values ('${U1}', 'a@b.c');
    insert into relay.tenants(id, owner_user, character_node, owner_name) values ('${T1}', '${U1}', 'ROLE1', '啟良');
    -- ROLE1＝舊租戶的角色節點（role=owner）；P＝本人的手機（member、屬於本人）；M＝AI 視窗所在的電腦（member）；C＝成員
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status) values
      ('ROLE1', '角色節點', 'k1', 'b1', 'owner', '${T1}', null, 'active'),
      ('P', '手機', 'k2', 'b2', 'member', '${T1}', '${U1}', 'active'),
      ('M', 'M 機', 'k3', 'b3', 'member', '${T1}', null, 'active'),
      ('C', 'C 機', 'k4', 'b4', 'member', '${T1}', null, 'active');
    insert into relay.rooms(id, name, created_by, tenant_id) values ('r1', '測試群', '~owner', '${T1}');
    insert into relay.room_members(room_id, member, role) values ('r1', '~owner', 'owner'), ('r1', 'P', 'member'), ('r1', 'M', 'member'), ('r1', 'C', 'member');`)
  const q = async (text, args) => (await db.query(text, args)).rows
  const send = async (from, to, body, signed = null) =>
    (await q('select public.asn_relay_send($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [from, null, to, null, body, null, false, signed, false]))[0].r
  const inbox = async node => (await q('select public.asn_relay_inbox($1) r', [node]))[0].r
  return { db, q, send, inbox }
}

test('實跑：信件 trust——本人簽章才是 owner；角色節點與一般成員都是 member', { skip }, async () => {
  const { send, inbox } = await boot()
  await send('P', 'M', '本人的手機說', U1)
  await send('ROLE1', 'M', '角色節點說')
  await send('C', 'M', '成員說')
  const byBody = Object.fromEntries((await inbox('M')).map(m => [m.body, m]))
  assert.equal(byBody['本人的手機說'].trust, 'owner')
  assert.equal(byBody['角色節點說'].trust, 'member')
  assert.equal(byBody['成員說'].trust, 'member')
})

test('實跑：agent 版 inbox 同樣只認簽章；簽章是別人的帳號不算', { skip }, async () => {
  const { q, db } = await boot()
  await q(`select public.asn_relay_send('P','小', 'M','窗','簽章對', null, false, $1, false)`, [U1])
  await q(`select public.asn_relay_send('P','小', 'M','窗','簽章是別人', null, false, '22222222-2222-2222-2222-222222222222', false)`)
  await q(`select public.asn_relay_send('ROLE1','希', 'M','窗','角色節點', null, false, null, false)`)
  const rows = (await q(`select public.asn_relay_inbox_agent('M','窗') r`))[0].r
  const t = Object.fromEntries(rows.map(m => [m.body, m.trust]))
  assert.deepEqual(t, { '簽章對': 'owner', '簽章是別人': 'member', '角色節點': 'member' })
  void db
})

test('實跑：群組發言 trust——角色節點是 member；p_owner 與本人簽章是 owner；角色節點仍能以 ~owner 成員身分發言', { skip }, async () => {
  const { q } = await boot()
  const post = async (node, agent, owner, signed) =>
    (await q('select public.asn_relay_room_post($1,$2,$3,$4,$5,$6,$7) r', [node, agent, 'r1', `from ${node} ${owner} ${signed ? 's' : ''}`, [], owner, signed]))[0].r
  assert.ok((await post('C', null, false, null)).seq)
  assert.ok((await post('P', null, false, U1)).seq)
  assert.ok((await post('ROLE1', null, true, null)).seq, '舊後台的人登入路徑（p_owner）照舊：以 ~owner 發言')
  const rows = await q(`select from_member, trust, body from relay.room_messages where room_id = 'r1' order by seq`)
  const trust = Object.fromEntries(rows.map(r => [r.body, r.trust]))
  assert.equal(trust['from C false '], 'member')
  assert.equal(trust['from P false s'], 'owner')
  assert.equal(trust['from ROLE1 true '], 'owner')
  assert.equal(rows[2].from_member, '~owner')
  // 角色節點不帶 p_owner（用節點金鑰直接發言）：不是群組成員時被擋，不是靠 trust 放行
  assert.deepEqual(await post('ROLE1', null, false, null), { error: 'not_member' })
})

test('實跑：仍認 role=owner 的特權動作對角色節點照舊可用、對一般成員拒絕（資料沒有降級）', { skip }, async () => {
  const { q } = await boot()
  const role = (await q(`select role from relay.nodes where id = 'ROLE1'`))[0].role
  assert.equal(role, 'owner')
  const ok = (await q(`select public.asn_relay_acct_list('ROLE1','M') r`))[0].r
  const no = (await q(`select public.asn_relay_acct_list('C','M') r`))[0].r
  assert.notEqual(ok.error, 'forbidden', JSON.stringify(ok))
  assert.equal(no.error, 'forbidden', JSON.stringify(no))
  // 遠端開視窗：角色節點與本人簽章兩條路都通（#158），一般成員不通
  const launch = async (actor, signed) => (await q(`select public.asn_relay_launchers($1, null, $2) r`, [actor, signed]))[0].r
  assert.notEqual((await launch('ROLE1', null)).error, 'forbidden')
  assert.notEqual((await launch('P', U1)).error, 'forbidden')
  assert.equal((await launch('C', null)).error, 'forbidden')
})

test('實跑：~owner 的顯示名取帳號名稱；沒有名稱用中性文字，不再有「小良哥」', { skip }, async () => {
  const { q } = await boot()
  assert.equal((await q(`select relay.room_member_name('~owner', $1::uuid) n`, [T1]))[0].n, '啟良')
  assert.equal((await q(`select relay.room_member_name('~owner', null::uuid) n`))[0].n, '帳號擁有者')
  assert.equal((await q(`select relay.room_member_name('~owner') n`))[0].n, '帳號擁有者')
  const members = (await q(`select relay.room_members_json('r1') r`))[0].r
  const own = JSON.stringify(members)
  assert.doesNotMatch(own, /小良哥/)
  assert.ok(members.some(m => m.key === '~owner' && m.name === '啟良'), own)
})

test('還原驗證：套用前（只到 R6 改名）角色節點的信是 owner——證明上面的測試真的測到這支 migration', { skip }, async () => {
  const { send, inbox } = await boot({ upTo: MIG })
  await send('ROLE1', 'M', '角色節點說')
  assert.equal((await inbox('M'))[0].trust, 'owner')
})
