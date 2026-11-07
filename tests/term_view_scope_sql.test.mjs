// 別台打字的控制面（migration 20261108100000_term_view_scope.sql）：觀看分 view／input 兩種。
// 靜態：只加 scope 欄、沒有放內容的欄位、函式只給 service_role、沒有任何「同意」欄位（同意只在 T 本機）。
// 實跑（要 pglite）：預設 view、topic 前綴、分 scope 上限、到期、壞 scope、舊簽名照舊、pending 帶 scope、通知文字分 scope、權限。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID as uuid } from 'node:crypto'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261108100000_term_view_scope.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：只加 scope 欄；沒有同意或內容欄位；函式只給 service_role；舊簽名還在', () => {
  const code = read(MIG).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
  assert.doesNotMatch(code, /drop table|drop column|truncate|drop function/i, '不刪既有東西，線上 Edge 呼叫的舊簽名要留著')
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  const added = [...code.matchAll(/alter table relay\.term_views add column if not exists ([a-z_]+)/g)].map(m => m[1])
  assert.deepEqual(added, ['scope'], '欄位有變要重審')
  assert.doesNotMatch(code, /consent|approv|allow_input|grant_input|payload|frame/i, '後台不存、不判斷 T 同不同意，也沒有內容')
  assert.match(code, /asn_relay_term_view_start\(text, uuid, uuid, text, text, text, text, timestamptz\) to service_role/)
  assert.match(code, /asn_relay_term_view_start\(text, uuid, uuid, text, text, text, text, timestamptz, text\) to service_role/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001', T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const D = 'wrk9b2', Z = 'hom7a1', Q = 'qqq3c4', X = 'lap5d6'
const PUB = 'a'.repeat(43), TSIG = 'b'.repeat(86), DSIG = 'c'.repeat(342)
const KEYS = { [D]: 'D'.repeat(43), [Z]: 'Z'.repeat(43), [X]: 'X'.repeat(43), [Q]: 'Q'.repeat(43) }

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
      ('${D}', '工作機', 'k1', 'bell-d', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Z}', '家用機', 'k2', 'bell-z', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${X}', '筆電', 'k4', 'bell-x', 'member', '${T1}', '${U1}', 'active', '電腦'),
      ('${Q}', '財務室', 'k3', 'bell-q', 'member', '${T2}', '${U2}', 'active', '電腦');`)
  for (const n of [D, Z, X, Q]) await db.query('select public.asn_relay_device_key_publish($1, $2)', [n, KEYS[n]])
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  return (await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, keys.map(k => args[k]))).rows[0].r
}
const soon = (min = 9) => new Date(Date.now() + min * 60_000).toISOString()
const base = o => ({ p_actor: D, p_signed_user: U1, p_id: uuid(), p_to_node: Z, p_window_name: '小乙', p_d_eph_pub: PUB, p_d_sig: DSIG, p_expires_at: soon(), ...o })
const startOld = (db, o = {}) => rpc(db, 'asn_relay_term_view_start', base(o))
const start = (db, scope, o = {}) => rpc(db, 'asn_relay_term_view_start', { ...base(o), p_scope: scope })
const accept = (db, id, o = {}) => rpc(db, 'asn_relay_term_view_accept', { p_node: Z, p_id: id, p_t_eph_pub: PUB, p_t_sig: TSIG, ...o })
const pending = (db, node = Z) => rpc(db, 'asn_relay_term_view_pending', { p_node: node })
const row = async (db, id) => (await db.query('select * from relay.term_views where id = $1', [id])).rows[0]

test('舊簽名（線上 Edge）照舊：一律是看畫面、tv_ 開頭；新簽名帶回 scope', { skip }, async () => {
  const db = await boot()
  const old = await startOld(db)
  assert.ok(old.id && old.topic.startsWith('tv_'), JSON.stringify(old))
  assert.equal(old.to_pub, KEYS[Z])
  assert.equal((await row(db, old.id)).scope, 'view')
  const v = await start(db, 'view', { p_window_name: '小丙' })
  assert.equal(v.scope, 'view'); assert.ok(v.topic.startsWith('tv_'))
  const i = await start(db, 'input')
  assert.equal(i.scope, 'input'); assert.ok(i.topic.startsWith('ti_'), '打字另一個 topic')
  assert.notEqual(i.topic, old.topic)
})

test('壞 scope 拒絕；到期最多 10 分鐘（打字也一樣）', { skip }, async () => {
  const db = await boot()
  for (const s of [null, '', 'INPUT', 'view ', 'admin']) assert.equal((await start(db, s)).error, 'bad_request', String(s))
  assert.equal((await start(db, 'input', { p_expires_at: soon(11) })).error, 'bad_request', '打字超過 10 分鐘')
  assert.ok((await start(db, 'input', { p_expires_at: soon(10) })).id)
  await assert.rejects(db.exec(`update relay.term_views set scope = 'other'`), '表上也擋')
  await assert.rejects(db.exec(`update relay.term_views set topic = 'tv_x' where scope = 'input'`), 'topic 前綴和 scope 綁在一起')
})

test('上限分開算：打字每台 T 同時 1 個、看畫面 3 個；開打字不會關掉正在看的', { skip }, async () => {
  const db = await boot()
  const v = await start(db, 'view')
  const i = await start(db, 'input')
  assert.notEqual((await row(db, v.id)).status, 'ended', '同一個視窗開打字，看畫面那筆還在')
  assert.equal((await start(db, 'input', { p_window_name: '小丙' })).error, 'busy', '打字同時只能 1 個')
  assert.equal((await start(db, 'input', { p_actor: X, p_window_name: '小丁' })).error, 'busy', '別台也一樣')
  assert.ok((await start(db, 'view', { p_window_name: '小丙' })).id)
  assert.ok((await start(db, 'view', { p_window_name: '小丁' })).id, '看畫面另外算，還能開到 3 個')
  assert.equal((await start(db, 'view', { p_window_name: '小戊' })).error, 'busy')
  const again = await start(db, 'input')
  assert.ok(again.id, '同一對同一視窗同一種：結束舊的再開')
  assert.equal((await row(db, i.id)).status, 'ended')
  assert.equal((await row(db, v.id)).status, 'requested', '看畫面那筆沒被動到')
})

test('pending 帶 scope 給 T（T 依本機設定決定同不同意）；後台不替 T 決定', { skip }, async () => {
  const db = await boot()
  const v = await start(db, 'view')
  const i = await start(db, 'input')
  const p = await pending(db)
  assert.deepEqual(p.requests.map(r => [r.id, r.scope]), [[v.id, 'view'], [i.id, 'input']])
  assert.equal(p.requests[1].from_pub, KEYS[D])
  assert.deepEqual(await accept(db, i.id), { ok: true }, '接受不看任何同意欄位，同意只在 T 本機')
  const a = await pending(db)
  assert.deepEqual(a.active.map(r => [r.id, r.scope]), [[i.id, 'input']])
  assert.equal((await pending(db, Q)).requests.length, 0, '別人的電腦領不到')
  assert.equal((await start(db, 'input', { p_to_node: Q, p_window_name: 'x' })).error, 'forbidden', '只能打給本人的電腦')
})

test('通知文字分 scope：打字要寫清楚可以回答權限框；不再提配對', { skip }, async () => {
  const db = await boot()
  const notice = id => rpc(db, 'asn_relay_term_view_notice', { p_node: Z, p_id: id })
  const last = async () => (await db.query(`select body from relay.messages where from_node = '${Z}' and from_agent = '看畫面收發室' order by created_at desc limit 1`)).rows[0].body
  const v = await start(db, 'view'); await accept(db, v.id)
  assert.equal((await notice(v.id)).notify, 'sent')
  const vb = await last()
  assert.ok(vb.includes('正在看') && vb.includes('如果不是你') && !vb.includes('打字'), vb)
  const i = await start(db, 'input', { p_window_name: '小丙' }); await accept(db, i.id)
  assert.equal((await notice(i.id)).notify, 'sent')
  const ib = await last()
  assert.ok(ib.includes('正在操作') && ib.includes('打任何字') && ib.includes('權限框') && ib.includes('小丙') && ib.includes('如果不是你'), ib)
  for (const b of [vb, ib]) assert.ok(!b.includes('配對'), '0.2.8 改版後沒有配對')
})

test('權限：anon、authenticated 碰不到新舊兩個 start', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query(`select public.asn_relay_term_view_start('a', null, null, 'b', 'c', 'd', 'e', now(), 'input')`), role)
    await assert.rejects(db.query(`select public.asn_relay_term_view_start('a', null, null, 'b', 'c', 'd', 'e', now())`), role)
    await db.exec('reset role')
  }
})

test('還原驗證：拿掉保護要變紅', { skip }, async () => {
  const a = await boot({ mutate: { [MIG]: s => s.replace(`v_max := case p_scope when 'input' then 1 else 3 end;`, `v_max := 3;`) } })
  await start(a, 'input')
  assert.ok((await start(a, 'input', { p_window_name: '小丙' })).id, '沒有分開算，打字能開第二個')
  const b = await boot({ mutate: { [MIG]: s => s.replace(`and scope = p_scope and status <> 'ended';`, `and status <> 'ended';`) } })
  const v = await start(b, 'view')
  await start(b, 'input')
  assert.equal((await row(b, v.id)).status, 'ended', '沒看 scope，開打字會把看畫面那筆關掉')
})

test('發起：同一台 T 的發起先上鎖，再查上限（同時發起不能繞過「打字只能 1 個」）', async () => {
  const { readFile } = await import('node:fs/promises')
  const sql = await readFile(new URL('../supabase/migrations/20261108100000_term_view_scope.sql', import.meta.url), 'utf8')
  const body = sql.slice(sql.indexOf('p_expires_at timestamptz, p_scope text)'), sql.indexOf('-- 舊版（八個參數'))
  const lock = body.indexOf("pg_advisory_xact_lock(hashtext('term_view_start:' || p_to_node))")
  assert.ok(lock > 0, '九參數 start 要上鎖')
  assert.ok(lock > body.indexOf('perform public.asn_relay_term_view_expire()'), '鎖在 expire 之後')
  assert.ok(lock < body.indexOf('update relay.term_views'), '鎖在結束舊那筆之前')
  assert.ok(lock < body.indexOf("'busy'"), '鎖在上限檢查之前')
})

