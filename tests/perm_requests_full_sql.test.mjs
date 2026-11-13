// #1445：手機確認框照原本的選項顯示＋危險提示（migration 20261114100000_perm_requests_full_options.sql）。
// 1. 靜態：交易內、新函式只給 service_role、不刪表。
// 2. 實跑（pglite）：完整選項與危險代碼存得進去、手機列得出來；不認得的代碼丟掉並標 uncertain（不整筆拒收）；
//    舊選項的編號要是完整選項的子集；手機按完整選項裡的編號算數；結案清掉完整選項與代碼；舊的六個參數照舊能用。
// 3. 還原驗證：拿掉「白名單」或「子集」檢查，對應測試要變紅。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261114100000_perm_requests_full_options.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、新函式只給 service_role、不刪表、不開放給一般角色', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.ok(code.includes('grant execute on function public.asn_relay_perm_req_create(text, text, text, boolean, jsonb, text, jsonb, jsonb, integer) to service_role;'))
  assert.ok(code.includes("c_known constant text[] := array['delete_recursive','git_destructive','disk_system','remote_exec','secret_path','privilege','db_destructive','outside_cwd'];"), '白名單和電腦端、relay 一致')
  assert.ok(files.includes(MIG))
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'phn7a1', W1 = 'wrk9b2', Q2 = 'qqq3c4'
const H = 'a'.repeat(64)

async function boot({ mutate, skip: skipFiles = [] } = {}) {
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
  for (const f of files) {
    if (skipFiles.includes(f)) continue
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
      ('${Q2}', '財務室電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const decide = (db, id, o = {}) => rpc(db, 'asn_relay_perm_req_decide', { p_actor: P1, p_signed_user: U1, p_id: id, p_choice_n: 1, p_hash: H, ...o })
const row = async (db, id) => (await db.query('select * from relay.perm_requests where id = $1', [id])).rows[0]

const FULL = JSON.stringify([{ n: 1, label: 'Yes', kind: 'allow_once' }, { n: 2, label: "Yes, and don't ask again", kind: 'allow_always' }, { n: 3, label: 'No', kind: 'deny' }])
const OPTS_DENY = JSON.stringify([{ n: 3, label: 'No' }])
const create9 = (db, o = {}) => rpc(db, 'asn_relay_perm_req_create', {
  p_node: W1, p_window_name: '小乙', p_prompt_text: ' Bash command\n rm -rf x', p_complete: true, p_options: OPTS_DENY, p_hash: H,
  p_options_full: FULL, p_risk: JSON.stringify({ codes: ['delete_recursive'], uncertain: false }), p_full_len: 20, ...o,
})

test('完整選項、危險代碼、字數：存得進去，手機列得出來；手機按完整選項裡的編號算數；結案清掉', { skip }, async () => {
  const db = await boot()
  const c = await create9(db)
  assert.ok(c.id, JSON.stringify(c))
  const l = (await rpc(db, 'asn_relay_perm_req_list', { p_actor: P1, p_signed_user: U1 })).requests[0]
  assert.deepEqual(l.options, [{ n: 3, label: 'No' }], '舊手機只看到拒絕')
  assert.deepEqual(l.options_full.map(o => [o.n, o.kind]), [[1, 'allow_once'], [2, 'allow_always'], [3, 'deny']])
  assert.deepEqual(l.risk, { codes: ['delete_recursive'], uncertain: false })
  assert.equal(l.full_len, 20)
  assert.equal((await decide(db, c.id, { p_choice_n: 2 })).status, 'decided', '新手機按「不再詢問」（完整選項裡的 2）')
  const r = await row(db, c.id)
  assert.equal(r.options_full, null); assert.equal(r.risk, null); assert.equal(r.prompt_text, null)
  const c2 = await create9(db, { p_window_name: '小丙' })
  assert.equal((await decide(db, c2.id, { p_choice_n: 5 })).error, 'bad_choice', '兩份選項都沒有 5')
})

test('危險代碼：不認得的丟掉並標 uncertain，照常收下；格式不對或沒給也當看不出全貌', { skip }, async () => {
  const db = await boot()
  const risk = async (w, v) => { const c = await create9(db, { p_window_name: w, p_risk: v }); assert.ok(c.id, JSON.stringify(c)); return (await row(db, c.id)).risk }
  assert.deepEqual(await risk('a', JSON.stringify({ codes: ['git_destructive', 'future_code'], uncertain: false })), { codes: ['git_destructive'], uncertain: true })
  assert.deepEqual(await risk('b', JSON.stringify({ codes: ['SAFE'], uncertain: false })), { codes: [], uncertain: true }, '假的「安全」只會讓手機更小心')
  assert.deepEqual(await risk('c', JSON.stringify({ codes: 'rm' })), { codes: [], uncertain: true })
  assert.deepEqual(await risk('d', null), { codes: [], uncertain: true })
  assert.deepEqual(await risk('e', JSON.stringify({ codes: ['privilege', 'privilege'], uncertain: false })), { codes: ['privilege'], uncertain: false })
  assert.deepEqual(await risk('f', JSON.stringify({ codes: [], uncertain: false })), { codes: [], uncertain: false })
})

test('完整選項：舊選項要是子集、編號不重複、種類不認得當 allow_always；壞的拒絕', { skip }, async () => {
  const db = await boot()
  assert.equal((await create9(db, { p_options: JSON.stringify([{ n: 4, label: 'x' }]) })).error, 'bad_request', '舊選項的 4 不在完整選項裡')
  assert.equal((await create9(db, { p_options_full: '[]' })).error, 'bad_request')
  assert.equal((await create9(db, { p_options_full: JSON.stringify([{ n: 3, label: 'No', kind: 'deny' }, { n: 3, label: 'No', kind: 'deny' }]) })).error, 'bad_request')
  assert.equal((await create9(db, { p_full_len: -1 })).error, 'bad_request')
  const c = await create9(db, { p_options_full: JSON.stringify([{ n: 1, label: 'Yes', kind: 'definitely_safe' }, { n: 3, label: 'No', kind: 'deny' }]) })
  assert.equal((await row(db, c.id)).options_full[0].kind, 'allow_always', '不認得的種類往安全那邊倒：要按住')
})

test('舊的六個參數照舊能用（舊 relay），新欄位是空的', { skip }, async () => {
  const db = await boot()
  const c = await rpc(db, 'asn_relay_perm_req_create', { p_node: W1, p_window_name: '小乙', p_prompt_text: 'Do you want to proceed?', p_complete: true, p_options: JSON.stringify([{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }]), p_hash: H })
  assert.ok(c.id, JSON.stringify(c))
  const r = await row(db, c.id)
  assert.equal(r.options_full, null); assert.equal(r.risk, null); assert.equal(r.full_len, null)
  assert.equal((await decide(db, c.id, { p_choice_n: 1 })).status, 'decided')
})

test('舊格式經 relay 進來時新欄位是 JSON 的 null：當成沒帶，照常建立（asn真 審查必修 3）', { skip }, async () => {
  const db = await boot()
  const c = await create9(db, { p_options: JSON.stringify([{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }]), p_options_full: 'null', p_risk: 'null', p_full_len: null })
  assert.ok(c.id, JSON.stringify(c))
  const r = await row(db, c.id)
  assert.equal(r.options_full, null); assert.equal(r.risk, null); assert.equal(r.full_len, null)
  // 有完整選項但危險代碼是 JSON null：照常收下、當看不出全貌
  const c2 = await create9(db, { p_window_name: '小丙', p_risk: 'null' })
  assert.deepEqual((await row(db, c2.id)).risk, { codes: [], uncertain: true })
})

test('權限：anon、authenticated 不能呼叫新版建立函式', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => create9(db), /permission denied/, role)
    await db.exec('reset role')
  }
})

test('還原驗證：拿掉白名單或子集檢查，對應測試要變紅', { skip }, async () => {
  const noList = await boot({ mutate: { [MIG]: s => s.replace("and (v_c #>> '{}') = any (c_known) then", 'then') } })
  const c1 = await create9(noList, { p_risk: JSON.stringify({ codes: ['SAFE'], uncertain: false }) })
  assert.deepEqual((await row(noList, c1.id)).risk, { codes: ['SAFE'], uncertain: false }, '白名單拿掉：假代碼會被收下')
  const noSub = await boot({ mutate: { [MIG]: s => s.replace("where not ((o->>'n')::int = any (v_seen))) then", 'where false) then') } })
  assert.ok((await create9(noSub, { p_options: JSON.stringify([{ n: 4, label: 'x' }]) })).id, '子集檢查拿掉：會收下')
})

// ---------- 回復檔（supabase/sql/rollback/…_down.sql） ----------
const DOWN = fs.readFileSync(new URL(`../supabase/sql/rollback/${MIG.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const FNS = ['asn_relay_perm_req_expire', 'asn_relay_perm_req_create', 'asn_relay_perm_req_list', 'asn_relay_perm_req_decide', 'asn_relay_perm_req_take', 'asn_relay_perm_req_result']
const defs = async db => Object.fromEntries((await db.query(`select p.proname n, pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = any($1) order by 1`, [FNS])).rows.map(r => [r.n, r.d]))
const cols = async db => (await db.query(`select column_name c from information_schema.columns where table_schema = 'relay' and table_name = 'perm_requests' order by ordinal_position`)).rows.map(r => r.c)
const cons = async db => (await db.query(`select conname n, pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'relay.perm_requests'::regclass order by 1`)).rows.map(r => `${r.n}: ${r.d}`)
const grants = async db => (await db.query(`select p.proname n, pg_get_function_identity_arguments(p.oid) a, p.proacl::text acl from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = any($1) order by 1, 2`, [FNS])).rows.map(r => `${r.n}(${r.a}) ${r.acl}`)

test('回復檔：靜態——交易內、只動 perm_requests 與這幾支函式、不刪表', () => {
  assert.match(DOWN, /^begin;$/m); assert.match(DOWN, /^commit;$/m)
  const code = DOWN.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|truncate/i)
  // 唯一的 delete 是原本清理函式裡「結案超過一天的刪掉」那一句（換回原文）
  assert.deepEqual(code.match(/delete from [^\n]*/g), ["delete from relay.perm_requests where created_at < now() - interval '1 day';"])
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(code, /drop function if exists public\.asn_relay_perm_req_create\(text, text, text, boolean, jsonb, text, jsonb, jsonb, integer\);/)
})

test('回復檔：套上之後，函式、欄位、約束、權限都和沒有 #1445 的資料庫一樣；pending 的先取消；舊的建立與決定照常', { skip }, async () => {
  const before = await boot({ skip: [MIG] })   // 從來沒套過 #1445 的資料庫
  const db = await boot()
  const pend = await create9(db)
  const done = await create9(db, { p_window_name: '小丙' })
  await decide(db, done.id, { p_choice_n: 3 })
  await db.exec(DOWN)
  assert.deepEqual(await cols(db), await cols(before), '三個新欄位拿掉了')
  assert.deepEqual(await cons(db), await cons(before), '約束換回原本的')
  assert.deepEqual(await defs(db), await defs(before), '六支函式換回原文')
  assert.deepEqual(await grants(db), await grants(before), '權限一樣（只給 service_role）')
  assert.equal((await db.query(`select count(*)::int n from pg_proc where proname = 'asn_relay_perm_req_create' and pronargs = 9`)).rows[0].n, 0, '九個參數版本拿掉了')
  const p = await row(db, pend.id)
  assert.equal(p.status, 'cancelled'); assert.equal(p.prompt_text, null); assert.equal(p.options, null)
  assert.equal((await row(db, done.id)).status, 'decided', '已決定的照舊讓電腦領')
  // 舊格式照常
  const c = await rpc(db, 'asn_relay_perm_req_create', { p_node: W1, p_window_name: '小丁', p_prompt_text: 'Do you want to proceed?', p_complete: true, p_options: JSON.stringify([{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }]), p_hash: H })
  assert.ok(c.id, JSON.stringify(c))
  assert.equal((await decide(db, c.id, { p_choice_n: 2 })).error, 'bad_choice')
  assert.equal((await decide(db, c.id, { p_choice_n: 1 })).status, 'decided')
  // 再套一次 up 也行（回復後要能重新上線）
  await db.exec(read(MIG))
  assert.ok((await create9(db, { p_window_name: '小戊' })).id)
})

closeAtEnd()
