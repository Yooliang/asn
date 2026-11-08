// 允許移動設備查看終端（migration 20261109120000_mobile_view_platform.sql）：設備公鑰登記平台。
// 靜態：交易內、只加 platform 欄、函式只給 service_role、兩個簽名都在（避免同名多載歧義）、有回復檔。
// 實跑（要 pglite）：平台只收兩個值、第一次登記後不能改、舊版不帶照常、換新公鑰才能換平台、pending 帶 from_platform（null 當 desktop）、mobile_off 原因。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID as uuid } from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261109120000_mobile_view_platform.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、只加 platform 欄、函式只給 service_role、新舊簽名都在、有回復檔、契約有 from_platform', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /drop table|drop column|truncate/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.deepEqual([...code.matchAll(/alter table relay\.device_keys add column if not exists ([a-z_]+)/g)].map(m => m[1]), ['platform'])
  assert.match(code, /asn_relay_device_key_publish\(text, text, text\) to service_role/)
  assert.match(code, /asn_relay_device_key_publish\(text, text\) to service_role/)
  assert.ok(files.indexOf(MIG) === files.length - 1 || files.indexOf(MIG) > files.indexOf('20261109110000_push_recipient.sql'), '時間戳比現有的大')
  assert.ok(fs.existsSync(new URL('../supabase/sql/rollback/20261109120000_mobile_view_platform_down.sql', import.meta.url)))
  const contract = JSON.parse(fs.readFileSync(new URL('../supabase/functions/_shared/term_view_contract.json', import.meta.url), 'utf8'))
  assert.ok(contract['term_view_pending.requests[]'].includes('from_platform'))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const D = 'wrk9b2', Z = 'hom7a1'
const PUB = 'a'.repeat(43), DSIG = 'c'.repeat(342)
const K1 = 'K'.repeat(43), K2 = 'L'.repeat(43)

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
  for (const f of files) {
    await db.exec(read(f))
  }
  await db.exec(`
    insert into auth.users(id, email) values ('${U1}', 'a@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${D}', '工作機', 'k1', 'bell-d', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Z}', '家用機', 'k2', 'bell-z', 'member', '${T1}', '${U1}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  return (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => args[k]))).rows[0].r
}
const publish = (db, node, pub, platform) => rpc(db, 'asn_relay_device_key_publish', platform === undefined ? { p_node: node, p_sign_pub: pub } : { p_node: node, p_sign_pub: pub, p_platform: platform })
const platformOf = async (db, node) => (await db.query('select platform from relay.device_keys where node = $1', [node])).rows[0]?.platform
const pending = (db, node = Z) => rpc(db, 'asn_relay_term_view_pending', { p_node: node })
const soon = () => new Date(Date.now() + 9 * 60_000).toISOString()
const startView = db => rpc(db, 'asn_relay_term_view_start', { p_actor: D, p_signed_user: U1, p_id: uuid(), p_to_node: Z, p_window_name: '小乙', p_d_eph_pub: PUB, p_d_sig: DSIG, p_expires_at: soon() })

test('平台只收 desktop／android；其他值 bad_request，不寫入', { skip }, async () => {
  const db = await boot()
  for (const bad of ['ios', '', 'Android', 'DESKTOP']) {
    assert.equal((await publish(db, D, K1, bad)).error, 'bad_request', bad)
  }
  assert.equal(await platformOf(db, D), undefined, '壞值沒有寫入任何一列')
  assert.equal((await publish(db, D, K1, 'android')).ok, true)
  assert.equal(await platformOf(db, D), 'android')
  await assert.rejects(db.query(`update relay.device_keys set platform = 'ios' where node = '${D}'`), 'check constraint 擋住')
})

test('同一把公鑰第一次登記後不能改；登記過 android 的節點換新金鑰仍是 android', { skip }, async () => {
  const db = await boot()
  assert.equal((await publish(db, D, K1, 'android')).ok, true)
  assert.equal((await publish(db, D, K1, 'desktop')).ok, true, '回 ok 但不改')
  assert.equal(await platformOf(db, D), 'android', '同一把公鑰不能從 android 改成 desktop')
  assert.equal((await publish(db, D, K1)).ok, true, '舊版不帶也不會洗掉')
  assert.equal(await platformOf(db, D), 'android')
  assert.equal((await publish(db, D, K2, 'desktop')).ok, true)
  assert.equal(await platformOf(db, D), 'android', '登記過 android，換新金鑰報 desktop 仍是 android')
  assert.equal((await publish(db, D, K1)).ok, true)
  assert.equal(await platformOf(db, D), 'android', '換新金鑰不帶 platform 仍是 android')
  assert.equal((await db.query(`select sign_pub from relay.device_keys where node = '${D}'`)).rows[0].sign_pub, K1, '公鑰照常更新')
})

test('沒登記過 android 的節點：換新金鑰可重新登記，可以變 android，變了就固定', { skip }, async () => {
  const db = await boot()
  await publish(db, D, K1, 'desktop')
  assert.equal(await platformOf(db, D), 'desktop')
  await publish(db, D, K2, 'android')
  assert.equal(await platformOf(db, D), 'android', 'desktop → android 可以')
  await publish(db, D, K1, 'desktop')
  assert.equal(await platformOf(db, D), 'android')
  const db2 = await boot()
  await publish(db2, D, K1)
  await publish(db2, D, K2, 'android')
  assert.equal(await platformOf(db2, D), 'android', 'null → android 可以')
})

test('舊版不帶 platform 照常上傳（null＝舊資料）；之後同一把公鑰可補登記一次，登記後不能改', { skip }, async () => {
  const db = await boot()
  assert.equal((await publish(db, D, K1)).ok, true)
  assert.equal(await platformOf(db, D), null)
  assert.equal((await publish(db, D, K1, 'android')).ok, true)
  assert.equal(await platformOf(db, D), 'android')
  assert.equal((await publish(db, D, K1, 'desktop')).ok, true)
  assert.equal(await platformOf(db, D), 'android')
  assert.equal((await publish(db, 'nope', K1, 'android')).error, 'not_found')
  assert.equal((await publish(db, D, 'x', 'android')).error, 'bad_request')
})

test('pending 帶 from_platform：公鑰登記 android 回 android，null 當 desktop', { skip }, async () => {
  const db = await boot()
  await publish(db, Z, 'Z'.repeat(43))
  await publish(db, D, K1)
  assert.equal((await startView(db)).error, undefined)
  let req = (await pending(db)).requests
  assert.equal(req.length, 1)
  assert.equal(req[0].from_platform, 'desktop', 'null 當 desktop')
  assert.equal(req[0].from_pub, K1)
  await publish(db, D, K1, 'android')
  assert.equal((await pending(db)).requests[0].from_platform, 'android')
  await publish(db, D, K2, 'desktop')
  assert.equal((await pending(db)).requests[0].from_platform, 'android', '登記過 android 不會變回 desktop')
})

test('pending 的平台也看節點回報：android／ios 都回 android；兩邊都 desktop 或 null 才回 desktop', { skip }, async () => {
  const db = await boot()
  await publish(db, Z, 'Z'.repeat(43))
  await publish(db, D, K1)
  await startView(db)
  const nodePlatform = p => db.query(`update relay.nodes set platform = $1 where id = '${D}'`, [p])
  const from = async () => (await pending(db)).requests[0].from_platform
  assert.equal(await from(), 'desktop', '兩邊都 null')
  await nodePlatform('android')
  assert.equal(await from(), 'android', '公鑰沒登記平台、節點是 android（舊版手機）')
  await nodePlatform('ios')
  assert.equal(await from(), 'android', 'ios 也算')
  await nodePlatform('windows')
  assert.equal(await from(), 'desktop')
  await publish(db, D, K1, 'desktop')
  assert.equal(await from(), 'desktop', '兩邊都 desktop')
  await nodePlatform('android')
  assert.equal(await from(), 'android', '節點是 android 優先')
})

test('term_view_stop 多了 mobile_off 原因；D 查得到', { skip }, async () => {
  const db = await boot()
  await publish(db, Z, 'Z'.repeat(43))
  await publish(db, D, K1, 'android')
  const s = await startView(db)
  assert.equal((await rpc(db, 'asn_relay_term_view_stop', { p_node: Z, p_id: s.id, p_reason: 'bogus' })).error, 'bad_request')
  assert.equal((await rpc(db, 'asn_relay_term_view_stop', { p_node: Z, p_id: s.id, p_reason: 'mobile_off' })).ok, true)
  const r = await rpc(db, 'asn_relay_term_view_report', { p_actor: D, p_signed_user: U1, p_id: s.id, p_state: null })
  assert.equal(r.status, 'ended')
  assert.equal(r.end_reason, 'mobile_off')
})

test('回復檔：回到上一版（沒有 platform 欄、沒有 mobile_off、兩個參數的上傳照常）', { skip }, async () => {
  const db = await boot()
  await publish(db, Z, 'Z'.repeat(43))
  await publish(db, D, K1, 'android')
  const s = await startView(db)
  await rpc(db, 'asn_relay_term_view_stop', { p_node: Z, p_id: s.id, p_reason: 'mobile_off' })
  await db.exec(fs.readFileSync(new URL('../supabase/sql/rollback/20261109120000_mobile_view_platform_down.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n'))
  assert.equal((await db.query(`select 1 from information_schema.columns where table_schema = 'relay' and table_name = 'device_keys' and column_name = 'platform'`)).rows.length, 0)
  assert.equal((await publish(db, D, K2)).ok, true)
  assert.equal((await rpc(db, 'asn_relay_term_view_stop', { p_node: Z, p_id: uuid(), p_reason: 'mobile_off' })).error, 'bad_request')
  assert.equal((await db.query(`select end_reason from relay.term_views where id = '${s.id}'`)).rows[0].end_reason, 'rejected')
})
