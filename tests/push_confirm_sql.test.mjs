// 推播新增「需要你確認」（migration 20261113200000_push_confirm.sql）。
// 靜態：push_targets 與上一版（20261112700000）逐字相同，只差允許的種類清單；回復檔還原上一版；新函式只給 service_role。
// 實跑（要 pglite）：confirm 種類可用、未知種類拒絕、前景規則與 owner_mail 一致、節點名查詢、權限、回復。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261113200000_push_confirm.sql'
const PREV = '20261112700000_presence_foreground.sql'
const DOWN = new URL('../supabase/sql/rollback/20261113200000_push_confirm_down.sql', import.meta.url)
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const down = fs.readFileSync(DOWN, 'utf8').replace(/\r\n/g, '\n')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const fn = (src, name) => src.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\$function\\$;`))[0]

test('靜態：push_targets 與上一版逐字相同，只差允許的種類清單', () => {
  const a = fn(read(PREV), 'asn_relay_push_targets'), b = fn(read(MIG), 'asn_relay_push_targets')
  assert.notEqual(a, b)
  // 只多了種類清單裡的 'confirm'，以及 confirm 專用的那一段（不佔 60 秒名額）
  const CONFIRM_BLOCK = `  -- 需要你確認（confirm）：有人在等，不受每台 60 秒一則的名額限制、也不佔名額（不更新 last_sent_at）。
  -- 同一個請求在 Edge 已去重，另有每台 10 秒一則的防洪；前景不推的規則照舊
  if p_kind = 'confirm' then
    select coalesce(jsonb_agg(jsonb_build_object('node', t.node, 'token', t.token) order by t.node), '[]'::jsonb) into v_out
      from relay.push_tokens t join relay.nodes n on n.id = t.node
     where n.owner_user = p_user and n.status = 'active' and n.platform = 'android'
       and t.updated_at > now() - interval '30 days'
       and not exists (select 1 from relay.asn_presence p where p.node = t.node and p.fg_at > now() - interval '3 minutes');
    return jsonb_build_object('targets', v_out);
  end if;
`
  assert.ok(b.includes(CONFIRM_BLOCK), 'confirm 專用段落')
  assert.equal(b.replace(CONFIRM_BLOCK, '').replace("('owner_mail', 'waiting', 'confirm')", "('owner_mail', 'waiting')"), a)
})

test('靜態：回復檔的 push_targets 逐字等於上一版；移除新函式', () => {
  assert.equal(fn(down, 'asn_relay_push_targets'), fn(read(PREV), 'asn_relay_push_targets'))
  assert.match(down, /drop function if exists public\.asn_relay_push_node_name\(text\);/)
  assert.match(down, /grant execute on function public\.asn_relay_push_targets\(uuid, text\) to service_role;/)
})

test('靜態：交易內、security definer、search_path 空、只給 service_role、新函式只讀', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  assert.match(code, /grant execute on function public\.asn_relay_push_node_name\(text\) to service_role;/)
  assert.match(code, /grant execute on function public\.asn_relay_push_targets\(uuid, text\) to service_role;/)
  for (const m of code.matchAll(/create or replace function[\s\S]*?\$function\$;/g)) assert.match(m[0], /security definer set search_path to ''/)
  assert.doesNotMatch(fn(code, 'asn_relay_push_node_name'), /insert |update |delete |token/i)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const PH = 'phn1a1', PC = 'wrk9b2', GONE = 'gon5e5'
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
      ('${PH}', '手機', 'k2', 'bell-ph', 'member', '${T1}', '${U1}', 'active', '手機', 'android'),
      ('${GONE}', '停用的', 'k4', 'bell-g', 'member', '${T1}', '${U1}', 'disabled', '電腦', 'windows');`
async function boot() {
  const db = new PGlite()
  await db.exec(SETUP)
  for (const f of files) await db.exec(read(f))
  await db.exec(SEED)
  return db
}
const targets = async (db, kind) => (await db.query(`select public.asn_relay_push_targets($1, $2) r`, [U1, kind])).rows[0].r
const reg = db => db.query(`select public.asn_relay_push_register($1, $2)`, [PH, TOK])
const clearSent = db => db.query(`update relay.push_tokens set last_sent_at = null`)
const fg = (db, ago) => db.query(`insert into relay.asn_presence(node, window_name, version, status, updated_at, fg_at) values ($1, 'ASN', '0.2.15', 'online', now(), now() - $2::interval) on conflict (node, window_name) do update set fg_at = excluded.fg_at`, [PH, ago])

test('confirm 種類可用；未知種類與空值仍拒絕', { skip }, async () => {
  const db = await boot(); await reg(db)
  assert.equal((await targets(db, 'confirm')).targets.length, 1)
  for (const k of ['nope', '', null]) assert.deepEqual(await targets(db, k), { error: 'bad_request' }, String(k))
})

test('confirm 前景規則與 owner_mail 相同：3 分鐘內前景不推、超過就推', { skip }, async () => {
  const db = await boot(); await reg(db)
  await fg(db, '10 seconds')
  assert.deepEqual((await targets(db, 'confirm')).targets, [], '前景不推')
  assert.deepEqual((await targets(db, 'owner_mail')).targets, [])
  await fg(db, '4 minutes')
  assert.equal((await targets(db, 'confirm')).targets.length, 1, '背景會推')
})

test('confirm 不受 60 秒名額限制、也不佔名額：60 秒內剛推過信件，確認框照樣推；推了確認框，信件的名額不受影響', { skip }, async () => {
  const db = await boot(); await reg(db)
  const sentAt = async () => (await db.query(`select last_sent_at from relay.push_tokens`)).rows[0].last_sent_at
  assert.equal((await targets(db, 'owner_mail')).targets.length, 1, '先推一則信件')
  const t1 = await sentAt()
  assert.ok(t1, '信件佔了名額')
  assert.deepEqual((await targets(db, 'owner_mail')).targets, [], '60 秒內第二則信件被擋')
  assert.equal((await targets(db, 'confirm')).targets.length, 1, '確認框照樣推')
  assert.equal((await targets(db, 'confirm')).targets.length, 1, '資料庫不擋確認框（防洪在 Edge）')
  assert.equal(String(await sentAt()), String(t1), '確認框不更新 last_sent_at')
  await clearSent(db)
  assert.equal((await targets(db, 'confirm')).targets.length, 1)
  assert.equal(await sentAt(), null, '名額空著時推確認框，也不佔名額')
  assert.equal((await targets(db, 'owner_mail')).targets.length, 1, '之後的信件照常推')
})

test('節點名查詢：啟用中的回名稱；停用或不存在回空；只給 service_role', { skip }, async () => {
  const db = await boot()
  const q = n => db.query(`select public.asn_relay_push_node_name($1) r`, [n]).then(x => x.rows[0].r)
  assert.deepEqual(await q(PC), { name: '工作機' })
  assert.deepEqual(await q(GONE), { name: null })
  assert.deepEqual(await q('nope'), { name: null })
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_push_node_name('${PC}')`), /permission denied/, role)
    await db.exec('reset role')
  }
})

test('回復檔實跑：confirm 被拒、node_name 消失、owner_mail 照常、可重跑 up', { skip }, async () => {
  const db = await boot(); await reg(db)
  await db.exec(down)
  assert.deepEqual(await targets(db, 'confirm'), { error: 'bad_request' })
  assert.equal((await db.query(`select count(*)::int n from pg_proc where proname = 'asn_relay_push_node_name'`)).rows[0].n, 0)
  assert.equal((await targets(db, 'owner_mail')).targets.length, 1)
  await db.exec('set role anon')
  await assert.rejects(db.query(`select public.asn_relay_push_targets('${U1}', 'owner_mail')`), /permission denied/)
  await db.exec('reset role')
  await db.exec(read(MIG))
  await clearSent(db)
  assert.equal((await targets(db, 'confirm')).targets.length, 1)
})
