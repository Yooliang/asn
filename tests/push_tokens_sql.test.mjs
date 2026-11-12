// 推播權杖（migration 20261109100000_push_tokens.sql，#797 PR①）。
// 靜態：交易內、新表開 RLS、函式只給 service_role、不動既有函式。
// 實跑（要 pglite）：註冊條件、權杖唯一、取消、要推誰（不在線、權杖 30 天內更新、60 秒一則、停用、兩種情境）、權杖不外流、權限、清除。
import { track, closeAtEnd } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261109100000_push_tokens.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const FNS = ['asn_relay_push_register(text, text)', 'asn_relay_push_unregister(text)', 'asn_relay_push_targets(uuid, text)', 'asn_relay_push_prune()', 'asn_relay_push_invalid(text, text)']

test('靜態：交易內、新表開 RLS、只給 service_role、不改既有函式', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /drop table|drop column|truncate|drop function|alter table relay\.(nodes|messages|asn_presence)/i)
  assert.match(code, /alter table relay\.push_tokens enable row level security/)
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  const created = [...code.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(m => m[1]).sort()
  assert.deepEqual(created, ['asn_relay_push_invalid', 'asn_relay_push_prune', 'asn_relay_push_register', 'asn_relay_push_targets', 'asn_relay_push_unregister'], '只新增推播函式，不改既有的寄信函式')
  for (const f of FNS) assert.match(code, new RegExp(`grant execute on function public\\.${f.replace(/[()]/g, '\\$&')} to service_role;`), f)
  for (const m of code.matchAll(/create or replace function[\s\S]*?\$function\$;/g)) {
    assert.match(m[0], /security definer set search_path to ''/, m[0].slice(0, 80))
  }
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001', T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const PC = 'wrk9b2', PH = 'phn1a1', PH2 = 'phn2b2', OLD = 'phn0c0', OTHER = 'qqq3c4'
const TOK = 'f'.repeat(40) + ':APA91b_tok-1', TOK2 = 'e'.repeat(40) + ':APA91b_tok-2'

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
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine, platform) values
      ('${PC}', '工作機', 'k1', 'bell-pc', 'member', '${T1}', '${U1}', 'active', '電腦', 'windows'),
      ('${PH}', '手機', 'k2', 'bell-ph', 'member', '${T1}', '${U1}', 'active', '手機', 'android'),
      ('${PH2}', '舊手機', 'k5', 'bell-ph2', 'member', '${T1}', '${U1}', 'active', '手機', 'android'),
      ('${OLD}', '沒回報平台', 'k4', 'bell-old', 'member', '${T1}', '${U1}', 'active', '手機', null),
      ('${OTHER}', '別人的手機', 'k3', 'bell-q', 'member', '${T2}', '${U2}', 'active', '手機', 'android');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  return (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => args[k]))).rows[0].r
}
const reg = (db, node, token = TOK) => rpc(db, 'asn_relay_push_register', { p_node: node, p_token: token })
const targets = (db, kind = 'owner_mail', user = U1) => rpc(db, 'asn_relay_push_targets', { p_user: user, p_kind: kind })
// 在線列：fg_at 與 updated_at 同時間（等同 App 在前景回報；#1281 起推播判斷看 fg_at）
const seen = (db, node, ago) => db.query(`insert into relay.asn_presence(node, window_name, version, status, updated_at, fg_at) values ($1, 'ASN', '0.2.11', 'online', now() - $2::interval, now() - $2::interval)
  on conflict (node, window_name) do update set updated_at = excluded.updated_at, fg_at = excluded.fg_at`, [node, ago])
const tokens = async db => (await db.query('select node, token from relay.push_tokens order by node')).rows
const ageSent = (db, node, ago) => db.query(`update relay.push_tokens set last_sent_at = now() - $2::interval where node = $1`, [node, ago])

test('註冊：只收啟用中的 android 節點；格式不對、電腦、沒回報平台、停用都拒絕；回傳不帶權杖', { skip }, async () => {
  const db = await boot()
  const ok = await reg(db, PH)
  assert.deepEqual(ok, { ok: true })
  assert.doesNotMatch(JSON.stringify(ok), /APA91b/)
  assert.equal((await reg(db, PC, TOK2)).error, 'bad_request', '電腦')
  assert.equal((await reg(db, OLD, TOK2)).error, 'bad_request', 'platform 空')
  assert.equal((await reg(db, 'nope00', TOK2)).error, 'bad_request', '不存在')
  for (const t of ['短', 'x'.repeat(31), 'a'.repeat(40) + ' 空白', 'a'.repeat(40) + '<script>', 'a'.repeat(1025), null]) {
    assert.equal((await reg(db, PH2, t)).error, 'bad_request', String(t).slice(0, 20))
  }
  await db.exec(`update relay.nodes set status = 'disabled' where id = '${PH2}'`)
  assert.equal((await reg(db, PH2, TOK2)).error, 'bad_request', '停用')
  assert.deepEqual(await tokens(db), [{ node: PH, token: TOK }])
})

test('註冊：同一台換新權杖覆蓋；同一個權杖換到別的節點，舊的那筆被刪；取消不回傳權杖', { skip }, async () => {
  const db = await boot()
  await reg(db, PH)
  await reg(db, PH, TOK2)
  assert.deepEqual(await tokens(db), [{ node: PH, token: TOK2 }], '換新')
  await reg(db, PH2, TOK2)
  assert.deepEqual(await tokens(db), [{ node: PH2, token: TOK2 }], '同一個權杖只留新節點')
  const un = await rpc(db, 'asn_relay_push_unregister', { p_node: PH2 })
  assert.deepEqual(un, { ok: true })
  assert.deepEqual(await tokens(db), [])
})

test('要推誰：本人名下、android、有權杖、30 天內開過（權杖有更新）、現在不在線；兩種情境都可以', { skip }, async () => {
  const db = await boot()
  await reg(db, PH); await reg(db, OTHER, TOK2)
  await seen(db, PH, '10 minutes'); await seen(db, OTHER, '10 minutes')
  assert.deepEqual(await targets(db, 'owner_mail'), { targets: [{ node: PH, token: TOK }] }, '寄給本人：只推本人的手機，不推別人的')
  await ageSent(db, PH, '2 minutes')
  assert.deepEqual(await targets(db, 'waiting'), { targets: [{ node: PH, token: TOK }] }, '夥伴在等你')
  assert.equal((await targets(db, 'other')).error, 'bad_request')
  assert.equal((await targets(db, null)).error, 'bad_request')
  assert.deepEqual(await targets(db, 'owner_mail', null), { targets: [] }, '收件人不明')
  assert.equal((await targets(db, 'OWNER_MAIL')).error, 'bad_request', '大小寫不同也拒絕')
})

const ageToken = (db, node, ago) => db.query(`update relay.push_tokens set updated_at = now() - $2::interval where node = $1`, [node, ago])

test('要推誰：在線（3 分鐘內）不推；在線列久了就算不在線', { skip }, async () => {
  const db = await boot()
  await reg(db, PH)
  await seen(db, PH, '1 minute')
  assert.deepEqual(await targets(db), { targets: [] }, '在線（3 分鐘內）')
  await seen(db, PH, '4 minutes')
  assert.equal((await targets(db)).targets.length, 1, '超過 3 分鐘沒回報＝不在線')
})

test('要推誰：沒有任何在線列（顯示為離線）、權杖 10 天前更新過 → 推', { skip }, async () => {
  const db = await boot()
  await reg(db, PH); await ageToken(db, PH, '10 days')
  const { rows } = await db.query(`select count(*)::int n from relay.asn_presence where node = $1`, [PH])
  assert.equal(rows[0].n, 0, '前提：完全沒有在線列')
  assert.deepEqual(await targets(db), { targets: [{ node: PH, token: TOK }] })
})

test('要推誰：權杖 31 天沒更新（30 天沒開 App）→ 不推', { skip }, async () => {
  const db = await boot()
  await reg(db, PH); await ageToken(db, PH, '31 days')
  assert.deepEqual(await targets(db), { targets: [] }, '沒有在線列')
  await seen(db, PH, '40 days')
  assert.deepEqual(await targets(db), { targets: [] }, '有很久以前的在線列也一樣')
  await reg(db, PH)
  assert.equal((await targets(db)).targets.length, 1, '開 App 重報權杖之後又會推')
})

test('要推誰：同一台 60 秒最多一則，過了再推；送出時間會記下', { skip }, async () => {
  const db = await boot()
  await reg(db, PH); await seen(db, PH, '10 minutes')
  assert.equal((await targets(db)).targets.length, 1)
  assert.deepEqual(await targets(db), { targets: [] }, '60 秒內第二次')
  assert.deepEqual(await targets(db, 'waiting'), { targets: [] }, '換一種也一樣算')
  await ageSent(db, PH, '61 seconds')
  assert.equal((await targets(db)).targets.length, 1, '過了 60 秒')
  const { rows } = await db.query(`select last_sent_at > now() - interval '5 seconds' recent from relay.push_tokens where node = $1`, [PH])
  assert.equal(rows[0].recent, true)
})

test('要推誰：停用的手機不推；刪節點連動刪權杖', { skip }, async () => {
  const db = await boot()
  await reg(db, PH); await reg(db, PH2, TOK2)
  await seen(db, PH, '10 minutes'); await seen(db, PH2, '10 minutes')
  await db.exec(`update relay.nodes set status = 'disabled' where id = '${PH2}'`)
  assert.deepEqual((await targets(db)).targets.map(t => t.node), [PH])
  await db.exec(`delete from relay.asn_presence where node = '${PH2}'; delete from relay.nodes where id = '${PH2}'`)
  assert.deepEqual((await tokens(db)).map(t => t.node), [PH])
})

test('清除：60 天沒更新的刪掉；FCM 回失效時權杖對得上才刪', { skip }, async () => {
  const db = await boot()
  await reg(db, PH); await reg(db, PH2, TOK2)
  await db.exec(`update relay.push_tokens set updated_at = now() - interval '61 days' where node = '${PH2}'`)
  assert.deepEqual(await rpc(db, 'asn_relay_push_prune'), { ok: true, removed: 1 })
  assert.deepEqual((await tokens(db)).map(t => t.node), [PH])
  assert.deepEqual(await rpc(db, 'asn_relay_push_invalid', { p_node: PH, p_token: TOK2 }), { ok: true, removed: false }, '權杖不一樣（剛換新）不刪')
  assert.deepEqual(await rpc(db, 'asn_relay_push_invalid', { p_node: PH, p_token: TOK }), { ok: true, removed: true })
  assert.deepEqual(await tokens(db), [])
})

test('權限：anon／authenticated 不能執行任何推播函式，也不能讀權杖表', { skip }, async () => {
  const db = await boot()
  for (const f of FNS) {
    const { rows } = await db.query(`select has_function_privilege('anon', 'public.${f}', 'execute') a, has_function_privilege('authenticated', 'public.${f}', 'execute') u, has_function_privilege('service_role', 'public.${f}', 'execute') s`)
    assert.deepEqual(rows[0], { a: false, u: false, s: true }, f)
  }
  const { rows } = await db.query(`select has_table_privilege('anon', 'relay.push_tokens', 'select') a, has_table_privilege('authenticated', 'relay.push_tokens', 'select') u`)
  assert.deepEqual(rows[0], { a: false, u: false })
})

test('要推誰：別的帳號寄給本人時，推給收件的那個人（U1）的手機，不推寄件帳號（U2）的', { skip }, async () => {
  const db = await boot()
  await reg(db, PH); await reg(db, OTHER, TOK2)
  await seen(db, PH, '10 minutes'); await seen(db, OTHER, '10 minutes')
  // U2 的節點寄信給 U1：Edge 從寄信結果拿到收件人 U1，用它查
  assert.deepEqual(await targets(db, 'owner_mail', U1), { targets: [{ node: PH, token: TOK }] })
  assert.deepEqual(await targets(db, 'owner_mail', U1), { targets: [] }, '60 秒內不再推')
  assert.deepEqual((await tokens(db)).find(t => t.node === OTHER), { node: OTHER, token: TOK2 }, '寄件帳號的手機沒被動到')
  const { rows } = await db.query(`select last_sent_at from relay.push_tokens where node = $1`, [OTHER])
  assert.equal(rows[0].last_sent_at, null, '寄件帳號的手機沒有被推')
})

test('清理排程：每天跑一次 prune', { skip }, async () => {
  const db = await boot()
  const { rows } = await db.query(`select schedule, command from cron.job where jobname = 'asn-push-tokens-prune'`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].schedule, '51 3 * * *')
  assert.match(rows[0].command, /asn_relay_push_prune\(\)/)
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
