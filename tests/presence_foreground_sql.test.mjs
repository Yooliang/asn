// #1281：在線列多一欄 fg_at（最後一次前景），推播判斷只看它（migration 20261112700000_presence_foreground.sql）。
// 靜態：交易內、只給 service_role、簽章只剩一個、push_targets 只看 fg_at、回復檔還原。
// 實跑（要 pglite）：true／false／不帶旗標的寫法、回填、push_targets 與名單顯示各看各的。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261112700000_presence_foreground.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

test('靜態：交易內、函式只給 service_role、search_path 空、舊簽章 drop 掉只留一個', () => {
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.match(code, /drop function if exists public\.asn_relay_asn_presence_set\(text, text, text, text, text\);/)
  assert.match(code, /function public\.asn_relay_asn_presence_set\(p_node text, p_window text, p_version text, p_status text, p_psm text, p_foreground boolean default null\)[\s\S]*security definer[\s\S]*set search_path to ''/)
  assert.match(code, /grant execute on function public\.asn_relay_asn_presence_set\(text, text, text, text, text, boolean\) to service_role;/)
  assert.match(code, /grant execute on function public\.asn_relay_push_targets\(uuid, text\) to service_role;/)
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  assert.match(code, /update relay\.asn_presence set fg_at = updated_at where fg_at is null;/)
})

test('靜態：push_targets 只看 fg_at，沒有退回 updated_at 的規則；只改這兩支函式', () => {
  const m = code.match(/function public\.asn_relay_push_targets[\s\S]*?\$function\$;/)[0]
  assert.match(m, /p\.fg_at > now\(\) - interval '3 minutes'/)
  assert.doesNotMatch(m, /updated_at > now\(\) - interval '3 minutes'/)
  assert.doesNotMatch(m, /coalesce\(p\.fg_at|fg_at is null/i)
  const created = [...code.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(x => x[1]).sort()
  assert.deepEqual(created, ['asn_relay_asn_presence_set', 'asn_relay_push_targets'])
})

test('靜態：回復檔還原 5 參數版、push_targets 看 updated_at、drop fg_at', () => {
  const down = fs.readFileSync(new URL('../supabase/sql/rollback/20261112700000_presence_foreground_down.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(down, /drop function if exists public\.asn_relay_asn_presence_set\(text, text, text, text, text, boolean\);/)
  assert.match(down, /function public\.asn_relay_asn_presence_set\(p_node text, p_window text, p_version text, p_status text, p_psm text\)/)
  assert.match(down, /grant execute on function public\.asn_relay_asn_presence_set\(text, text, text, text, text\) to service_role;/)
  assert.match(down, /p\.updated_at > now\(\) - interval '3 minutes'/)
  assert.match(down, /alter table relay\.asn_presence drop column if exists fg_at;/)
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const PH = 'phn1a1', PC = 'wrk9b2'
const TOK = 'f'.repeat(40) + ':APA91b_tok-1'

const SETUP = `create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`
const SEED = `
    insert into auth.users(id, email) values ('${U1}', 'a@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '小良');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine, platform) values
      ('${PC}', '工作機', 'k1', 'bell-pc', 'member', '${T1}', '${U1}', 'active', '電腦', 'windows'),
      ('${PH}', '手機', 'k2', 'bell-ph', 'member', '${T1}', '${U1}', 'active', '手機', 'android');`

// upTo：只套到這支 migration 之前（測升級回填用）
async function boot(upTo = null) {
  const db = track(new PGlite())
  await db.exec(SETUP)
  for (const f of files) { if (upTo && f >= upTo) break; await db.exec(read(f)) }
  await db.exec(SEED)
  return db
}
// 用具名參數呼叫，和 Edge 的 db.rpc 一樣
async function setPresence(db, node, extra = {}) {
  const a = { p_node: node, p_window: 'ASN', p_version: '0.2.15', p_status: 'online', p_psm: null, ...extra }
  const keys = Object.keys(a)
  return (await db.query(`select public.asn_relay_asn_presence_set(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => a[k]))).rows[0].r
}
const row = async (db, node) => (await db.query(`select fg_at, updated_at from relay.asn_presence where node = $1`, [node])).rows[0]
const age = (db, node, ago) => db.query(`update relay.asn_presence set updated_at = now() - $2::interval, fg_at = case when fg_at is null then null else now() - $2::interval end where node = $1`, [node, ago])
const targets = async db => (await db.query(`select public.asn_relay_push_targets($1, 'owner_mail') r`, [U1])).rows[0].r.targets
const reg = db => db.query(`select public.asn_relay_push_register($1, $2)`, [PH, TOK])
const clearSent = db => db.query(`update relay.push_tokens set last_sent_at = null`)

test('寫入：true 寫 fg_at、false 清成 null、不帶旗標（舊版 App／電腦版）視同前景寫 fg_at', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await setPresence(db, PH, { p_foreground: true }), { ok: true })
  assert.ok((await row(db, PH)).fg_at, 'true')
  assert.deepEqual(await setPresence(db, PH, { p_foreground: false }), { ok: true })
  const r = await row(db, PH)
  assert.equal(r.fg_at, null, 'false 必須清掉')
  assert.ok(r.updated_at, 'updated_at 照寫')
  await setPresence(db, PH)
  assert.ok((await row(db, PH)).fg_at, '不帶旗標＝前景')
  await setPresence(db, PH, { p_foreground: false })
  await setPresence(db, PH, { p_foreground: null })
  assert.ok((await row(db, PH)).fg_at, 'null＝前景')
  assert.equal((await db.query(`select count(*)::int n from pg_proc where proname = 'asn_relay_asn_presence_set'`)).rows[0].n, 1, '函式名只有一個簽章')
})

test('舊版呼叫（5 個參數、舊名 irori_ 包裝）照常能用', { skip }, async () => {
  const db = await boot()
  const r = await db.query(`select public.irori_relay_asn_presence_set($1, 'ASN', '0.2.14', 'online', null) r`, [PC])
  assert.deepEqual(r.rows[0].r, { ok: true })
  assert.ok((await row(db, PC)).fg_at, '舊呼叫視同前景')
})

test('offline 仍是刪列；不合法輸入照舊拒絕', { skip }, async () => {
  const db = await boot()
  await setPresence(db, PH, { p_foreground: true })
  assert.deepEqual(await setPresence(db, PH, { p_status: 'offline', p_foreground: false }), { ok: true })
  assert.equal((await db.query(`select count(*)::int n from relay.asn_presence`)).rows[0].n, 0)
  assert.equal((await setPresence(db, PH, { p_version: 'x' })).error, 'bad_request')
  assert.equal((await setPresence(db, 'nope00')).error, 'not_found')
})

test('要推誰：前景回報 3 分鐘內不推；超過 3 分鐘就推', { skip }, async () => {
  const db = await boot(); await reg(db)
  await setPresence(db, PH, { p_foreground: true })
  assert.deepEqual(await targets(db), [], '前景 3 分鐘內不推')
  await age(db, PH, '4 minutes'); await clearSent(db)
  assert.equal((await targets(db)).length, 1, '前景回報超過 3 分鐘＝不在前景')
})

test('要推誰：送 foreground=false 後，即使 updated_at 是剛剛，照樣推（不退回看 updated_at）', { skip }, async () => {
  const db = await boot(); await reg(db)
  await setPresence(db, PH, { p_foreground: true })
  assert.deepEqual(await targets(db), [])
  await setPresence(db, PH, { p_foreground: false })
  const r = await row(db, PH)
  assert.equal(r.fg_at, null)
  assert.ok(Date.now() - new Date(r.updated_at).getTime() < 60_000, 'updated_at 很新')
  assert.equal((await targets(db)).length, 1, '背景：照樣推')
})

test('要推誰：推播喚醒的那一筆是背景（false），不會擋後面 3 分鐘的推播', { skip }, async () => {
  const db = await boot(); await reg(db)
  await setPresence(db, PH, { p_foreground: false })
  assert.equal((await targets(db)).length, 1)
  await clearSent(db)
  assert.equal((await targets(db)).length, 1, '3 分鐘內第二封也推')
})

test('要推誰：不帶旗標（電腦版／舊版 App）仍擋 3 分鐘，與現行相同', { skip }, async () => {
  const db = await boot(); await reg(db)
  await setPresence(db, PH)
  assert.deepEqual(await targets(db), [])
})

test('名單的在線顯示照舊看 updated_at：背景回報的那台仍列在 asn 裡', { skip }, async () => {
  const db = await boot()
  await setPresence(db, PH, { p_foreground: false })
  const r = (await db.query(`select public.asn_relay_list($1) r`, [T1])).rows[0].r
  const n = r.find(x => x.id === PH)
  assert.equal(n.asn.length, 1, '背景也算在線（顯示）')
  assert.equal(n.asn[0].window_name, 'ASN')
})

test('升級回填：舊列 fg_at 用 updated_at 補上；升級瞬間在線的手機不會多推一次', { skip }, async () => {
  // 先只套到本 migration 之前，造兩列舊資料，再套本 migration
  const db = await boot(MIG)
  await db.exec(`insert into relay.asn_presence(node, window_name, version, status, updated_at) values
    ('${PH}', 'ASN', '0.2.14', 'online', now() - interval '1 minute'), ('${PC}', 'ASN', '0.2.14', 'online', now() - interval '10 minutes')`)
  await db.exec(read(MIG))
  const ph = await row(db, PH), pc = await row(db, PC)
  assert.equal(new Date(ph.fg_at).getTime(), new Date(ph.updated_at).getTime(), '回填＝updated_at')
  assert.equal(new Date(pc.fg_at).getTime(), new Date(pc.updated_at).getTime())
  await reg(db)
  assert.deepEqual(await targets(db), [], '升級瞬間在線的手機不會多推一次')
})

test('權限：anon／authenticated 不能執行新函式', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_asn_presence_set('${PH}', 'ASN', '0.2.15', 'online', null, true)`), /permission denied/, role)
    await db.exec('reset role')
  }
})

test('舊 relay（Edge）以 5 個具名參數呼叫新函式照樣成功，視同前景', { skip }, async () => {
  const db = await boot()
  const r = await db.query(`select public.asn_relay_asn_presence_set(p_node => $1, p_window => 'ASN', p_version => '0.2.14', p_status => 'online', p_psm => null) r`, [PH])
  assert.deepEqual(r.rows[0].r, { ok: true })
  assert.ok((await row(db, PH)).fg_at)
  assert.deepEqual((await db.query(`select public.asn_relay_asn_presence_set(p_node => $1, p_window => 'ASN', p_version => '0.2.14', p_status => 'away', p_psm => '忙') r`, [PH])).rows[0].r, { ok: true })
})

test('回復檔實跑：套 up 再套 down，回到舊狀態（5 參數版可呼叫、push_targets 看 updated_at、fg_at 沒了、舊權限還在）', { skip }, async () => {
  const db = await boot()
  await setPresence(db, PH, { p_foreground: false })   // up 的狀態：背景
  await db.exec(fs.readFileSync(new URL('../supabase/sql/rollback/20261112700000_presence_foreground_down.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n'))
  assert.equal((await db.query(`select count(*)::int n from information_schema.columns where table_schema = 'relay' and table_name = 'asn_presence' and column_name = 'fg_at'`)).rows[0].n, 0, 'fg_at 已刪')
  const sigs = (await db.query(`select pg_get_function_identity_arguments(oid) a from pg_proc where proname = 'asn_relay_asn_presence_set'`)).rows.map(x => x.a)
  assert.deepEqual(sigs, ['p_node text, p_window text, p_version text, p_status text, p_psm text'], '只剩 5 參數版')
  assert.deepEqual((await db.query(`select public.asn_relay_asn_presence_set($1, 'ASN', '0.2.14', 'online', null) r`, [PH])).rows[0].r, { ok: true })
  assert.deepEqual((await db.query(`select public.irori_relay_asn_presence_set($1, 'ASN', '0.2.14', 'online', null) r`, [PC])).rows[0].r, { ok: true }, '舊名包裝仍可用')
  // push_targets 回到看 updated_at：在線列剛寫入 → 不推；4 分鐘前 → 推
  await reg(db)
  assert.deepEqual(await targets(db), [], 'updated_at 很新就不推（舊規則）')
  await db.query(`update relay.asn_presence set updated_at = now() - interval '4 minutes' where node = $1`, [PH]); await clearSent(db)
  assert.equal((await targets(db)).length, 1)
  // 權限還原：anon 不能執行、service_role 可以
  await db.exec('set role anon')
  await assert.rejects(db.query(`select public.asn_relay_asn_presence_set('${PH}', 'ASN', '0.2.14', 'online', null)`), /permission denied/)
  await db.exec('reset role')
  await db.exec('set role service_role')
  assert.deepEqual((await db.query(`select public.asn_relay_asn_presence_set('${PH}', 'ASN', '0.2.14', 'online', null) r`)).rows[0].r, { ok: true })
  await db.exec('reset role')
  // 再套一次 up 也能回來（可重跑）
  await db.exec(read(MIG))
  assert.ok((await row(db, PH)).fg_at, 'up 再套一次：fg_at 回填')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
