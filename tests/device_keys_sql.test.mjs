// 設備金鑰與 TOFU 通知（0.2.8 改版：migrations 20261107100000_device_keys.sql、20261107130000_device_key_alert.sql）。
// 靜態：交易內、函式只給 service_role、表開 RLS、沒有配對的殘留。實跑（要 pglite）：公鑰上傳、通知的文字與限流、只寄給同一個本人。
import { track, closeAtEnd } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const KEYS_MIG = '20261107100000_device_keys.sql'
const ALERT_MIG = '20261107130000_device_key_alert.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const code = f => read(f).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

test('靜態：交易內、函式只給 service_role、表開 RLS、沒有配對的殘留', () => {
  for (const f of [KEYS_MIG, ALERT_MIG]) {
    const c = code(f)
    assert.match(c, /^begin;$/m)
    assert.match(c, /^commit;$/m)
    assert.doesNotMatch(c, /drop table|truncate/i)
    assert.doesNotMatch(c, /grant execute[^;]*to (anon|authenticated|public)/i)
  }
  assert.doesNotMatch(code(KEYS_MIG), /device_pairs|pair_start|pair_decide/, '改版拿掉手動配對')
  assert.ok(!files.some(f => f.includes('device_pairing')), '舊的配對 migration 不在了')
  assert.match(code(KEYS_MIG), /alter table relay\.device_keys enable row level security/)
  assert.match(code(ALERT_MIG), /alter table relay\.device_key_alerts enable row level security/)
  assert.deepEqual([...new Set(code(ALERT_MIG).match(/delete from [a-z_.]+/g))], ['delete from relay.device_key_alerts'], '只清自己的表')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001', T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const D = 'wrk9b2', Z = 'hom7a1', Q = 'qqq3c4'
const FP = '0123456789abcdef'

async function boot() {
  const db = track(new PGlite())
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
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${D}', '工作機', 'k1', 'bell-d', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Z}', '家用機', 'k2', 'bell-z', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Q}', '財務室', 'k3', 'bell-q', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  return (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => args[k]))).rows[0].r
}
const alert = (db, o = {}) => rpc(db, 'asn_relay_device_key_alert', { p_node: Z, p_peer: D, p_kind: 'first', p_fp: FP, ...o })
const mails = async db => (await db.query(`select body from relay.messages where kind = 'notice:device_key' order by created_at`)).rows.map(r => r.body)

test('公鑰上傳：格式要對；重裝就蓋掉', { skip }, async () => {
  const db = await boot()
  assert.equal((await rpc(db, 'asn_relay_device_key_publish', { p_node: D, p_sign_pub: 'x' })).error, 'bad_request')
  assert.equal((await rpc(db, 'asn_relay_device_key_publish', { p_node: D, p_sign_pub: 'a'.repeat(43) })).ok, true)
  await rpc(db, 'asn_relay_device_key_publish', { p_node: D, p_sign_pub: 'b'.repeat(43) })
  assert.equal((await db.query(`select sign_pub from relay.device_keys where node = '${D}'`)).rows[0].sign_pub, 'b'.repeat(43))
  assert.equal((await rpc(db, 'asn_relay_device_key_publish', { p_node: 'nope', p_sign_pub: 'a'.repeat(43) })).error, 'not_found')
})

test('通知：第一次記住、金鑰換了，文字固定帶指紋；同一對同一種一天一次', { skip }, async () => {
  const db = await boot()
  assert.equal((await alert(db)).notify, 'sent')
  assert.equal((await alert(db)).notify, 'sent', '一天內再叫：當作已寄，不重寄')
  assert.equal((await alert(db, { p_kind: 'changed', p_fp: 'fedcba9876543210' })).notify, 'sent')
  const m = await mails(db)
  assert.equal(m.length, 2, '第一次一封、換鑰一封')
  assert.match(m[0], /^家用機：「工作機」第一次連到「家用機」\n[\s\S]*指紋 0123456789abcdef/)
  assert.match(m[1], /^家用機：「工作機」的設備金鑰變了\n新指紋 fedcba9876543210[\s\S]*已拒絕連線/)
})

test('通知：只寄給同一個本人的另一台；參數要對', { skip }, async () => {
  const db = await boot()
  assert.equal((await alert(db, { p_peer: Q })).notify, 'skipped', '別人的電腦：不寄')
  assert.equal((await alert(db, { p_peer: Z })).error, 'bad_request', '不能是自己')
  assert.equal((await alert(db, { p_kind: 'other' })).error, 'bad_request')
  assert.equal((await alert(db, { p_fp: 'XYZ' })).error, 'bad_request', '指紋只收小寫十六進位')
  assert.equal((await alert(db, { p_fp: 'a'.repeat(40) })).error, 'bad_request', '太長')
  assert.equal((await mails(db)).length, 0)
})

test('權限：anon、authenticated 碰不到通知函式和表', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_device_key_alert('${Z}', '${D}', 'first', '${FP}')`), role)
    await assert.rejects(db.query('select * from relay.device_key_alerts'), role)
    await db.exec('reset role')
  }
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
