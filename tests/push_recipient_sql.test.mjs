// 推播收件人查詢（migration 20261109110000_push_recipient.sql，#797 PR②）。
// 靜態：交易內、只新增兩個只讀函式、只給 service_role、不改既有函式、不回權杖或信件內容。
// 實跑（要 pglite）：寄給本人的信回信上的收件人；不是這台寄的信回空；夥伴等待通知的收件人是節點擁有者；停用節點回空；權限。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261109110000_push_recipient.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、只新增兩個只讀函式、只給 service_role、不碰既有函式與資料', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /drop |truncate|alter table|insert |update |delete /i, '只讀')
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  const created = [...code.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(m => m[1]).sort()
  assert.deepEqual(created, ['asn_relay_push_recipient_mail', 'asn_relay_push_recipient_node'])
  assert.match(code, /grant execute on function public\.asn_relay_push_recipient_mail\(text, uuid\) to service_role;/)
  assert.match(code, /grant execute on function public\.asn_relay_push_recipient_node\(text\) to service_role;/)
  assert.doesNotMatch(code, /token|body/i, '不回權杖或信件內容')
  for (const m of code.matchAll(/create or replace function[\s\S]*?\$function\$;/g)) assert.match(m[0], /security definer set search_path to ''/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001', T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const PC = 'wrk9b2', PH = 'phn1a1', OTHER = 'qqq3c4', GONE = 'gon5e5'

async function boot() {
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
  for (const f of files) await db.exec(read(f))
  await db.exec(`
    insert into auth.users(id, email) values ('${U1}', 'a@x.y'), ('${U2}', 'b@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良'), ('${T2}', '${U2}', '財務員');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine, platform) values
      ('${PC}', '工作機', 'k1', 'bell-pc', 'member', '${T1}', '${U1}', 'active', '電腦', 'windows'),
      ('${PH}', '手機', 'k2', 'bell-ph', 'member', '${T1}', '${U1}', 'active', '手機', 'android'),
      ('${OTHER}', '別人的電腦', 'k3', 'bell-q', 'member', '${T2}', '${U2}', 'active', '電腦', 'windows'),
      ('${GONE}', '停用的', 'k4', 'bell-g', 'member', '${T1}', '${U1}', 'disabled', '電腦', 'windows');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  return (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => args[k]))).rows[0].r
}
const mail = async (db, from, personUser) => (await db.query(
  `insert into relay.messages (from_node, to_node, body, tenant_id, person_user) values ($1, $2, '內文', $3, $4) returning id`,
  [from, PH, T1, personUser])).rows[0].id

test('寄給本人的信：回信上記的收件人；只認這台寄出的；其他回空', { skip }, async () => {
  const db = await boot()
  const id = await mail(db, PC, U1)
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_mail', { p_node: PC, p_message_id: id }), { user: U1 })
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_mail', { p_node: OTHER, p_message_id: id }), { user: null }, '別台的金鑰問不到別人寄的信')
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_mail', { p_node: PC, p_message_id: '99999999-9999-9999-9999-999999999999' }), { user: null }, '沒有這封信')
  const plain = await mail(db, PC, null)
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_mail', { p_node: PC, p_message_id: plain }), { user: null }, '一般信沒有收件人的人')
})

test('夥伴等待通知的收件人＝節點擁有者；停用或不存在回空', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_node', { p_node: PC }), { user: U1 })
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_node', { p_node: OTHER }), { user: U2 })
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_node', { p_node: GONE }), { user: null })
  assert.deepEqual(await rpc(db, 'asn_relay_push_recipient_node', { p_node: 'nope' }), { user: null })
})

test('權限：anon、authenticated 碰不到', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_push_recipient_node('${PC}')`), role)
    await assert.rejects(db.query(`select public.asn_relay_push_recipient_mail('${PC}', null)`), role)
    await db.exec('reset role')
  }
})
