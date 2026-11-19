// 對話釘選帳號同步（migration 20261116100000_account_chat_pins.sql，#1479）。
// 1. 靜態：交易內、不刪資料、public 函式只授權 service_role、檔頭寫了回復方式。
// 2. 實跑（需要 @electric-sql/pglite）：讀／寫、共用寫入的白名單、features 64KB 上限、rev 舊的不能蓋、2 秒冷卻、
//    只動 chat_pins 不碰其他鍵、角色權限、中文加空白的 id、51 個 pins 拒絕、壞結構拒絕。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mergePins, normalizePins, pinChat } from '../relay/asn/ui/lib/chat-pins.mjs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261116100000_account_chat_pins.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：在交易內、不刪資料、只授權 service_role、有回復說明；是最新一份 migration', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.match(sql, /grant execute on function public\.asn_account_chat_pins\(uuid, jsonb\) to service_role;/)
  assert.doesNotMatch(code, /grant execute on function relay\./i, '共用寫入不授權任何角色')
  assert.match(sql, /^-- 回復：drop function public\.asn_account_chat_pins/m)
  assert.match(sql, /select \* into v_t from relay\.tenants where owner_user = p_user for update;/)
  assert.equal(files.at(-1) >= MIG, true)
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const T0 = 1_760_000_000_000

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
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '擁有者'), ('${T2}', '${U2}', '財務員');`)
  return db
}
const q = async (db, sql, params) => (await db.query(sql, params)).rows[0].r
const get = (db, user = U1) => q(db, 'select public.asn_account_chat_pins(p_user => $1::uuid) r', [user])
const put = (db, v, user = U1) => q(db, 'select public.asn_account_chat_pins(p_user => $1::uuid, p_pins => $2::jsonb) r', [user, JSON.stringify(v)])
const rawPut = (db, key, v, user = U1) => q(db, 'select relay.account_pref_put($1::uuid, $2::text, $3::jsonb) r', [user, key, v === null ? null : JSON.stringify(v)])
const features = async (db, tenant = T1) => (await db.query('select features f from relay.tenants where id = $1', [tenant])).rows[0].f
const E = (id, at = T0) => ({ id, at })
const S = (rev, pins = [E('w1/財務')], unpinned = []) => ({ pins, unpinned, rev })
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('實跑：沒設過是 null；寫入後讀得回來（rev 保留、at 由伺服器填、多餘欄位不存）', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await get(db), { pins: null })
  const w = await put(db, { ...S(1000, [{ id: 'a1/小 牧', at: T0, junk: 1 }]), evil: 'x' })
  assert.deepEqual(w.pins.pins, [{ id: 'a1/小 牧', at: T0 }]); assert.deepEqual(w.pins.unpinned, [])
  assert.equal(w.pins.rev, 1000); assert.ok(w.pins.at > 1_700_000_000_000)
  assert.deepEqual(Object.keys(w.pins).sort(), ['at', 'pins', 'rev', 'unpinned'])
  assert.deepEqual(await get(db), w)
  assert.deepEqual((await features(db)).chat_pins, w.pins)
})

test('實跑：內容相同不動；rev 一樣或較舊但內容不同不覆蓋並標 stale', { skip }, async () => {
  const db = await boot()
  const w = await put(db, S(1000))
  assert.deepEqual(await put(db, S(5000)), { pins: w.pins }, '內容相同：回現有的、不升 rev')
  const diff = [E('w1/w2', T0 + 1)]
  const older = await put(db, S(900, diff))
  assert.equal(older.stale, true); assert.deepEqual(older.pins, w.pins)
  const equal = await put(db, S(1000, diff))
  assert.equal(equal.stale, true); assert.deepEqual((await get(db)).pins.pins, [E('w1/財務')])
})

test('實跑：rev＋1 才覆蓋；2 秒內連續寫不同內容 rate_limited，過了 2 秒才行', { skip }, async () => {
  const db = await boot()
  await put(db, S(1000))
  assert.deepEqual(await put(db, S(1001, [E('w1/w2')])), { error: 'rate_limited' })
  assert.deepEqual((await get(db)).pins.pins, [E('w1/財務')], '被擋的沒寫進去')
  await sleep(2100)
  const ok = await put(db, S(1001, [E('w1/w2')]))
  assert.deepEqual(ok.pins.pins, [E('w1/w2')]); assert.equal(ok.pins.rev, 1001)
})


test('實跑：rev 比對再寫入：現有 5 時送 9（跳號）、5、4、0 都 stale 不寫入；送 6 成功', { skip }, async () => {
  const db = await boot()
  await put(db, S(5))
  const before = await features(db)
  for (const rev of [9, 5, 4, 0]) {
    const r = await put(db, S(rev, [E('w1/w2', T0 + 1)]))
    assert.equal(r.stale, true, `rev=${rev}`); assert.deepEqual(r.pins.pins, [E('w1/財務')]); assert.equal(r.pins.rev, 5)
  }
  assert.deepEqual(await features(db), before, 'stale 不寫入')
  await sleep(2100)
  const ok = await put(db, S(6, [E('w1/w2', T0 + 1)]))
  assert.equal(ok.stale, undefined); assert.equal(ok.pins.rev, 6); assert.deepEqual(ok.pins.pins, [E('w1/w2', T0 + 1)])
})

test('實跑：內容相同的捷徑在 rev 比對之前（跳號也只是回現有的，不標 stale）', { skip }, async () => {
  const db = await boot()
  const w = await put(db, S(5))
  assert.deepEqual(await put(db, S(99)), { pins: w.pins })
})

test('實跑：還沒有現有那份時：送 1 成功、送 7 也成功、送 0 被拒', { skip }, async () => {
  for (const [rev, okExpected] of [[1, true], [7, true], [0, false]]) {
    const db = await boot()
    const r = await put(db, S(rev))
    if (okExpected) assert.equal(r.pins.rev, rev)
    else { assert.deepEqual(r, { error: 'bad_request', reason: 'bad_rev' }); assert.deepEqual(await features(db), {}) }
  }
  const db = await boot()
  assert.deepEqual(await rawPut(db, 'chat_pins', { pins: [], unpinned: [], rev: 0 }), { error: 'bad_request', reason: 'bad_rev' })
  // 現有那份不是物件：當作還沒有，送 0 仍被拒、送 3 成功
  await db.exec(`update relay.tenants set features = '{"chat_pins": "壞掉"}' where id = '${T1}'`)
  assert.equal((await put(db, S(0))).reason, 'bad_rev')
  assert.equal((await put(db, S(3))).pins.rev, 3)
})

test('實跑：兩台輪流「讀 → 改 → 寫」：A 先寫成功，B 拿到 stale、合併後以伺服器 rev＋1 重送，兩邊的釘選都在', { skip }, async () => {
  const db = await boot()
  const base = await put(db, S(1, [E('w1/甲', T0)]))
  const start = normalizePins(base.pins)
  // A、B 都從同一份開始，各自釘不同的對話（用真正的 pinChat，本機 rev 都是 2）
  const a = pinChat(start, 'w1/乙', T0 + 10).state
  const b = pinChat(start, 'room:群 組', T0 + 20).state
  assert.equal(a.rev, 2); assert.equal(b.rev, 2)
  await sleep(2100)
  assert.equal((await put(db, a)).pins.rev, 2, 'A 先寫成功')
  await sleep(2100)
  const rb = await put(db, b)
  assert.equal(rb.stale, true, 'B 寫到 stale'); assert.equal(rb.pins.rev, 2)
  const merged = mergePins(rb.pins, b)   // 用真正的 mergePins 合併
  await sleep(2100)
  const rb2 = await put(db, { ...merged, rev: rb.pins.rev + 1 })
  assert.equal(rb2.stale, undefined); assert.equal(rb2.pins.rev, 3)
  assert.deepEqual(rb2.pins.pins.map(p => p.id), ['w1/甲', 'w1/乙', 'room:群 組'])
  assert.deepEqual((await get(db)).pins.pins.map(p => p.id), ['w1/甲', 'w1/乙', 'room:群 組'])
})

test('實跑：B 離線改很多次、rev 衝很大，直接送一定 stale，不會蓋掉 A 的', { skip }, async () => {
  const db = await boot()
  const a = await put(db, S(3, [E('w1/甲', T0), E('w1/乙', T0 + 1)]))
  await sleep(2100)
  for (const rev of [4 + 1, 50, 9_007_199_254_740_991]) {
    const r = await put(db, S(rev, [E('w1/丙', T0 + 5)]))
    assert.equal(r.stale, true, `rev=${rev}`); assert.deepEqual(r.pins, a.pins)
  }
  assert.deepEqual((await get(db)).pins, a.pins)
})

test('實跑：共用寫入的 key 白名單只放 chat_pins，其他一律拒絕且 features 不變', { skip }, async () => {
  const db = await boot()
  const before = await features(db)
  for (const key of ['device_prefs', 'settings', 'chat_pins2', 'CHAT_PINS', '', 'ai_wake_limit', 'rev']) {
    assert.deepEqual(await rawPut(db, key, { rev: 1 }), { error: 'bad_request', reason: 'key_not_allowed' }, `key=${key}`)
  }
  assert.deepEqual(await features(db), before)
  const ok = await rawPut(db, 'chat_pins', { pins: [], unpinned: [], rev: 1 })
  assert.equal(ok.value.rev, 1)
  assert.deepEqual(await rawPut(db, 'chat_pins', null), { error: 'bad_request', reason: 'missing_arg' })
  assert.deepEqual(await rawPut(db, 'chat_pins', { pins: [] }), { error: 'bad_request', reason: 'bad_value' }, '沒有 rev')
})

test('實跑：寫入後整份 features 超過 64KB 拒絕（原值不變）；沒超過的可以寫', { skip }, async () => {
  const db = await boot()
  const fill = n => db.query(`update relay.tenants set features = jsonb_build_object('device_prefs', jsonb_build_object('blob', repeat('x', $1::int))) where id = $2`, [n, T1])
  await fill(65450)
  const before = await features(db)
  assert.ok(Buffer.byteLength(JSON.stringify(before)) < 65536, '前提：現有的還沒超過')
  assert.deepEqual(await put(db, S(1000, [E('w1/財務')])), { error: 'too_large' })
  assert.deepEqual(await features(db), before, '原值不變、沒有寫入 chat_pins')
  assert.deepEqual(await get(db), { pins: null })
  await fill(60000)
  const ok = await put(db, S(1000, [E('w1/財務')]))
  assert.equal(ok.pins.rev, 1000)
  const total = Buffer.byteLength((await db.query('select features::text t from relay.tenants where id = $1', [T1])).rows[0].t)
  assert.ok(total <= 65536)
})

test('實跑：只動 chat_pins，不碰 device_prefs 等其他鍵', { skip }, async () => {
  const db = await boot()
  await db.exec(`update relay.tenants set features = '{"device_prefs":{"order":["a1"],"shown":[],"removed":[],"rev":5,"at":6},"other":{"k":[1,2]}}' where id = '${T1}'`)
  const before = await features(db)
  await put(db, S(1000))
  const after = await features(db)
  assert.deepEqual(after.device_prefs, before.device_prefs)
  assert.deepEqual(after.other, before.other)
  assert.deepEqual(Object.keys(after).sort(), ['chat_pins', 'device_prefs', 'other'])
  const d = await q(db, 'select public.asn_account_device_prefs(p_user => $1::uuid) r', [U1])
  assert.equal(d.prefs.rev, 5)
})

test('實跑：兩個帳號互不影響；沒有這個帳號 not_found；空帳號 bad_request', { skip }, async () => {
  const db = await boot()
  await put(db, S(1000), U1)
  assert.deepEqual(await get(db, U2), { pins: null })
  const w2 = await put(db, S(7, [], [E('x')]), U2)
  assert.deepEqual(w2.pins.pins, []); assert.deepEqual((await get(db, U1)).pins.pins, [E('w1/財務')])
  assert.equal((await get(db, '99999999-9999-9999-9999-999999999999')).error, 'not_found')
  assert.equal((await put(db, S(1), '99999999-9999-9999-9999-999999999999')).error, 'not_found')
  assert.equal((await q(db, 'select public.asn_account_chat_pins(p_user => null) r')).error, 'bad_request')
})

test('實跑：權限只有 service_role（anon／authenticated 打不到，relay 共用寫入誰都打不到）', { skip }, async () => {
  const db = await boot()
  const call = async (role, sql) => { await db.exec(`set role ${role}`); try { await db.exec(sql) } finally { await db.exec('reset role') } }
  const pub = `select public.asn_account_chat_pins('${U1}'::uuid, '${JSON.stringify(S(1))}'::jsonb)`
  for (const role of ['anon', 'authenticated']) await assert.rejects(call(role, pub), /permission denied/, role)
  await assert.rejects(call('anon', `select public.asn_account_chat_pins('${U1}'::uuid)`), /permission denied/)
  await db.exec('grant usage on schema relay to service_role, anon, authenticated')
  for (const role of ['service_role', 'anon', 'authenticated']) {
    await assert.rejects(call(role, `select relay.account_pref_put('${U1}'::uuid, 'chat_pins', '{"rev":1}'::jsonb)`), /permission denied/, `relay ${role}`)
  }
  await call('service_role', pub)
  assert.equal((await get(db)).pins.rev, 1)
})

test('實跑：中文加空白的 id 可以存；長度 200 可以、201 拒絕', { skip }, async () => {
  const db = await boot()
  const ids = ['工作機/財務 助理', 'room:群 組 1', 'a b', '全形　空白/名', 'x'.repeat(200), '😀'.repeat(100)]
  const w = await put(db, S(1000, ids.map((id, i) => E(id, T0 + i))))
  assert.deepEqual(w.pins.pins.map(p => p.id), ids)
  assert.deepEqual(await put(db, S(2000, [E('x'.repeat(201))])), { error: 'bad_request' })
})

test('實跑：50 個 pins 可以、51 個拒絕；unpinned 200 可以、201 拒絕', { skip }, async () => {
  const db = await boot()
  const mk = (n, p = 'n') => Array.from({ length: n }, (_, i) => E(`${p}/w${i}`, T0 + i))
  const w = await put(db, S(1000, mk(50), mk(200, 'u')))
  assert.equal(w.pins.pins.length, 50); assert.equal(w.pins.unpinned.length, 200)
  assert.deepEqual(await put(db, S(2000, mk(51))), { error: 'bad_request' })
  assert.deepEqual(await put(db, S(2000, [], mk(201, 'u'))), { error: 'bad_request' })
  assert.equal((await get(db)).pins.rev, 1000)
})

test('實跑：壞結構一律 bad_request 且不寫入', { skip }, async () => {
  const db = await boot()
  const ok = S(1)
  const bad = (pin) => ({ ...ok, pins: [pin] })
  const bads = [
    [], 'x', { ...ok, pins: 'a' }, { ...ok, pins: {} }, { ...ok, unpinned: 5 }, { pins: ok.pins, rev: 1 }, { unpinned: [], rev: 1 },
    { ...ok, pins: ['w1/a'] }, bad(null), bad([]),
    bad({ at: T0 }), bad({ id: 5, at: T0 }), bad({ id: '', at: T0 }),
    bad({ id: 'a\u0001b', at: T0 }), bad({ id: 'a\nb', at: T0 }), bad({ id: 'a\tb', at: T0 }), bad({ id: 'a\u007fb', at: T0 }),
    bad({ id: 'a' }), bad({ id: 'a', at: '1' }), bad({ id: 'a', at: 0 }), bad({ id: 'a', at: -5 }), bad({ id: 'a', at: 2 ** 53 }),
    { ...ok, unpinned: [{ id: 'a', at: null }] },
    { ...ok, rev: -1 }, { ...ok, rev: 1.5 }, { ...ok, rev: '1' }, { ...ok, rev: 2 ** 53 },
  ]
  for (const b of bads) assert.deepEqual(await put(db, b), { error: 'bad_request' }, JSON.stringify(b).slice(0, 70))
  assert.deepEqual(await get(db), { pins: null })
  assert.deepEqual(await features(db), {})
  assert.deepEqual(await q(db, `select public.asn_account_chat_pins(p_user => $1::uuid, p_pins => 'null'::jsonb) r`, [U1]), { pins: null }, 'null 是讀')
})

test('實跑：空陣列也能存（把全部取消釘選也是一種狀態）', { skip }, async () => {
  const db = await boot()
  const e = await put(db, { pins: [], unpinned: [], rev: 3000 })
  assert.deepEqual(e.pins.pins, []); assert.equal(e.pins.rev, 3000)
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
