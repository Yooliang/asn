// 回報匯流排後台（#2161 第 2a 段；migration 20261125100000_report_bus.sql）。
// 1. 靜態：交易內、不刪資料、授權、無裸 3 分鐘字面量、有回復說明與回復檔、寫入函式有 advisory lock。
// 2. 實跑（pglite，載入全部真實 migration 鏈含新檔）：宣告式規格驗證、report_validate（含 validator 名稱注入）、
//    asn_relay_report（去重／保活／rate／rate_node／互不影響／不動 last_seen_at／節點刪除 cascade）、
//    asn_relay_report_get（self／owner／room 範圍、無權節點不出現、超量、未知 kind）、report_readers 與 get 同源。
// 時間一律用「把 written_at／updated_at 往回推」，不 sleep。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

closeAtEnd()

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261125100000_report_bus.sql'
const DOWN = new URL('../supabase/sql/rollback/20261125100000_report_bus_down.sql', import.meta.url)
const norm = s => s.replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const read = f => norm(fs.readFileSync(new URL(f, DIR), 'utf8'))
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：交易內、不刪資料、授權只給 service_role、有回復說明、寫入函式有 advisory lock、沒有 policy', () => {
  assert.ok(files.includes(MIG))
  assert.equal(files[files.length - 1], MIG, '本檔是目前最新的 migration')
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.match(sql, /^-- 回復：supabase\/sql\/rollback\/20261125100000_report_bus_down\.sql/m)
  assert.ok(fs.existsSync(DOWN), 'down 檔存在')
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  const outside = code.replace(/\$function\$[\s\S]*?\$function\$/g, 'BODY')
  assert.doesNotMatch(outside, /drop table|drop column|delete from|truncate|drop function|update relay/i)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/i)
  assert.doesNotMatch(code, /create policy/i)
  assert.match(code, /alter table relay\.reports enable row level security;/)
  assert.match(code, /alter table relay\.report_kinds enable row level security;/)
  assert.match(code, /revoke all on relay\.reports from public, anon, authenticated;/)
  assert.match(code, /revoke all on relay\.report_kinds from public, anon, authenticated;/)
  // 每支新函式都是 security definer＋search_path 空，且都有 revoke
  const fns = [...code.matchAll(/create or replace function ([\w.]+)\(([^)]*)\)([\s\S]*?)\$function\$/g)]
  assert.equal(fns.length, 7)
  for (const [, name, , head] of fns) {
    assert.match(head, /security definer\s+set search_path to ''/, name)
  }
  for (const s of ['relay.report_check_value(jsonb, jsonb, text[], text, int)', 'relay.report_check_spec(jsonb, jsonb)', 'relay.report_validate(text, jsonb)',
    'relay.report_can_read(text, text, text)', 'relay.report_readers(text, text)', 'public.asn_relay_report(text, text, jsonb)', 'public.asn_relay_report_get(text, text, text[])']) {
    assert.ok(code.includes(`revoke all on function ${s} from public, anon, authenticated;`), s)
  }
  assert.ok(code.includes('grant execute on function public.asn_relay_report(text, text, jsonb) to service_role;'))
  assert.ok(code.includes('grant execute on function public.asn_relay_report_get(text, text, text[]) to service_role;'))
  assert.equal((code.match(/grant execute/g) ?? []).length, 2, 'relay.* 內部函式不 grant')
  assert.match(code, /pg_advisory_xact_lock\(hashtext\('report:' \|\| p_node \|\| ':' \|\| p_kind\)\)/)
  assert.doesNotMatch(code, /last_seen_at/, '不碰 nodes.last_seen_at')
  assert.match(code, /references relay\.nodes\(id\) on delete cascade/)
  // 沒有裸寫 3 分鐘
  assert.doesNotMatch(code, /'\s*3\s+min|'\s*180\s+sec|00:03:00|mins\s*=>\s*3\b|secs\s*=>\s*180\b/i)
  // down 檔
  const down = fs.readFileSync(DOWN, 'utf8')
  for (const s of ['public.asn_relay_report_get(text, text, text[])', 'public.asn_relay_report(text, text, jsonb)', 'relay.report_readers(text, text)',
    'relay.report_can_read(text, text, text)', 'relay.report_validate(text, jsonb)', 'relay.report_check_spec(jsonb, jsonb)',
    'relay.report_check_value(jsonb, jsonb, text[], text, int)']) assert.ok(down.includes(`drop function if exists ${s};`), s)
  assert.ok(down.includes('drop table if exists relay.reports;') && down.includes('drop table if exists relay.report_kinds;'))
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const SETUP = `create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-1111-1111-1111-111111111111'
const T2 = 'bbbbbbbb-2222-2222-2222-222222222222'
const T3 = 'cccccccc-3333-3333-3333-333333333333'

async function boot() {
  const db = track(new PGlite())
  await db.exec(SETUP)
  for (const f of files) await db.exec(read(f))
  const q = async (t, a) => (await db.query(t, a)).rows
  const one = async (t, a) => (await q(t, a))[0].r
  let seq = 0
  const api = {
    db, q,
    // 租戶 T1（U1）、T2（U2）、T3（無擁有者）
    async seed() {
      await db.exec(`insert into auth.users (id, email) values ('${U1}', 'u1@example.com'), ('${U2}', 'u2@example.com');
        insert into relay.tenants (id, owner_user) values ('${T1}', '${U1}'), ('${T2}', '${U2}'), ('${T3}', null);`)
    },
    node: (id, o = {}) => db.query(`insert into relay.nodes (id, name, key_hash, bell_topic, status, tenant_id, owner_user, last_seen_at)
      values ($1, $1, $2, $3, $4, $5, $6, $7)`, [id, `kh-${id}-${++seq}`, `bt-${id}-${++seq}`, o.status ?? 'active', o.tenant ?? T1, o.user === undefined ? U1 : o.user, o.seen ?? null]),
    room: async (id, tenant, members, o = {}) => {
      await db.query('insert into relay.rooms (id, name, created_by, tenant_id, archived_at) values ($1, $1, $2, $3, $4)', [id, members[0], tenant, o.archived ?? null])
      for (const m of members) await db.query('insert into relay.room_members (room_id, member) values ($1, $2)', [id, m])
    },
    report: (node, kind, payload) => one('select public.asn_relay_report($1, $2, $3::jsonb) r', [node, kind, JSON.stringify(payload)]),
    get: (caller, kind, nodes) => one('select public.asn_relay_report_get($1, $2, $3::text[]) r', [caller, kind, nodes]),
    validate: (kind, payload) => one('select relay.report_validate($1, $2::jsonb) r', [kind, JSON.stringify(payload)]),
    spec: (spec, payload) => one('select relay.report_check_spec($1::jsonb, $2::jsonb) r', [JSON.stringify(spec), JSON.stringify(payload)]),
    readers: async (node, kind) => (await q('select relay.report_readers($1, $2) r', [node, kind])).map(x => x.r),
    // 把這列的時間往回推 secs 秒
    age: (node, kind, secs) => db.query(`update relay.reports set written_at = written_at - make_interval(secs => $3), updated_at = updated_at - make_interval(secs => $3),
      changed_at = changed_at - make_interval(secs => $3) where node = $1 and kind = $2`, [node, kind, secs]),
    ageWritten: (node, kind, secs) => db.query('update relay.reports set written_at = written_at - make_interval(secs => $3) where node = $1 and kind = $2', [node, kind, secs]),
    row: async (node, kind) => (await q('select * from relay.reports where node = $1 and kind = $2', [node, kind]))[0],
    kind: (kind, o = {}) => db.query(`insert into relay.report_kinds (kind, spec, validator, max_bytes, keepalive_seconds, min_interval_seconds, read_scope, enabled)
      values ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)`, [kind, o.spec === undefined ? null : JSON.stringify(o.spec), o.validator ?? null, o.max ?? 1024, o.keep ?? 60, o.min ?? 5, o.scope ?? 'self', o.enabled ?? true]),
  }
  await api.seed()
  return api
}

// ───────── 規格驗證 ─────────
const BIG = {
  fields: {
    name: { type: 'string', max: 5 }, count: { type: 'int', min: 0, max: 100 }, ratio: { type: 'number', min: 0, max: 1 }, flag: { type: 'bool' },
    mode: { type: 'enum', values: ['a', 'b'] },
    items: { type: 'array', max: 2, of: { type: 'object', fields: { id: { type: 'int' }, tag: { type: 'string', max: 10 } }, required: ['id'] } },
    data: { type: 'object', fields: { x: { type: 'string', max: 8 } }, required: ['x'] },
    login: { type: 'string', max: 100 }, note: { type: 'string', max: 200 },
  },
  required: ['name'],
  allow_email: ['login'],
}

test('規格：合法 payload 通過；前提：驗證函式存在且 echo 已登記', { skip }, async () => {
  const b = await boot()
  assert.equal((await b.q("select count(*)::int c from relay.report_kinds where kind = 'echo'"))[0].c, 1)
  assert.equal(await b.spec(BIG, { name: 'ab', count: 3, ratio: 0.5, flag: true, mode: 'a', items: [{ id: 1, tag: 't' }], data: { x: 'y' } }), null)
  assert.equal(await b.spec(BIG, { name: 'ab' }), null)
})

test('規格：沒列在 fields 的欄位一律拒絕（頂層與巢狀、陣列元素內）', { skip }, async () => {
  const b = await boot()
  assert.equal(await b.spec(BIG, { name: 'a', extra: 1 }), 'unknown_field')
  assert.equal(await b.spec(BIG, { name: 'a', data: { x: 'y', z: 1 } }), 'unknown_field')
  assert.equal(await b.spec(BIG, { name: 'a', items: [{ id: 1, zzz: 1 }] }), 'unknown_field')
})

test('規格：型別錯、超長、陣列超量、數值範圍、enum、required、payload 非物件、整數不收小數', { skip }, async () => {
  const b = await boot()
  assert.equal(await b.spec(BIG, { name: 5 }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { name: null }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { name: 'a', count: '3' }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { name: 'a', count: 1.5 }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { name: 'a', flag: 'true' }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { name: 'a', data: [] }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { name: 'a', items: {} }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { name: 'abcdef' }), 'too_long')
  assert.equal(await b.spec(BIG, { name: 'abcde' }), null, '剛好上限可過')
  assert.equal(await b.spec(BIG, { name: 'a', items: [{ id: 1 }, { id: 2 }, { id: 3 }] }), 'too_many')
  assert.equal(await b.spec(BIG, { name: 'a', items: [{ id: 1 }, { id: 2 }] }), null)
  assert.equal(await b.spec(BIG, { name: 'a', items: [{ tag: 'x' }] }), 'missing_required')
  assert.equal(await b.spec(BIG, { name: 'a', count: -1 }), 'out_of_range')
  assert.equal(await b.spec(BIG, { name: 'a', count: 101 }), 'out_of_range')
  assert.equal(await b.spec(BIG, { name: 'a', count: 100 }), null)
  assert.equal(await b.spec(BIG, { name: 'a', ratio: 1.5 }), 'out_of_range')
  assert.equal(await b.spec(BIG, { name: 'a', mode: 'c' }), 'bad_enum')
  assert.equal(await b.spec(BIG, { name: 'a', mode: 1 }), 'type_mismatch')
  assert.equal(await b.spec(BIG, { count: 1 }), 'missing_required')
  assert.equal(await b.spec(BIG, { name: 'a', data: {} }), 'missing_required')
  assert.equal(await b.spec(BIG, []), 'not_object')
  assert.equal(await b.spec(BIG, 'x'), 'not_object')
  assert.equal(await b.spec(BIG, null), 'not_object')
  assert.equal(await b.spec(null, { a: 1 }), 'bad_spec')
  assert.equal(await b.spec({ fields: { a: { type: 'weird' } } }, { a: 1 }), 'bad_spec')
})

test('規格：疑似 email 被擋，只有 allow_email 明列的欄位放行；疑似金鑰片段、JWT、sk- 被擋', { skip }, async () => {
  const b = await boot()
  assert.equal(await b.spec(BIG, { name: 'a', note: 'mail me a@b.co' }), 'looks_like_email')
  assert.equal(await b.spec(BIG, { name: 'a', note: 'x.y+z@host.example.com' }), 'looks_like_email')
  assert.equal(await b.spec(BIG, { name: 'a', items: [{ id: 1, tag: 'a@b.co' }] }), 'looks_like_email', '陣列元素內也擋')
  assert.equal(await b.spec(BIG, { name: 'a', data: { x: 'a@b.co' } }), 'looks_like_email', '巢狀物件內也擋')
  assert.equal(await b.spec(BIG, { name: 'a', note: '@someone and 3@4' }), null, '沒有 x@y.z 形狀不算')
  assert.equal(await b.spec(BIG, { name: 'a', login: 'me@example.com' }), null, 'allow_email 明列的欄位放行')
  assert.equal(await b.spec(BIG, { name: 'a', login: 'me@example.com', note: 'you@example.com' }), 'looks_like_email', '放行只對明列的欄位')
  // 欄位層級 "allow_email": true 也放行
  assert.equal(await b.spec({ fields: { m: { type: 'string', max: 50, allow_email: true } } }, { m: 'me@example.com' }), null)
  assert.equal(await b.spec(BIG, { name: 'a', note: 'a'.repeat(32) }), 'looks_like_secret')
  assert.equal(await b.spec(BIG, { name: 'a', note: '0123456789abcdef0123456789abcdef' }), 'looks_like_secret')
  assert.equal(await b.spec(BIG, { name: 'a', note: 'ab-cd_ef+gh='.repeat(3) }), 'looks_like_secret')
  assert.equal(await b.spec(BIG, { name: 'a', note: 'a'.repeat(31) }), null, '31 個不算')
  assert.equal(await b.spec(BIG, { name: 'a', note: 'word '.repeat(10) }), null, '空白切開的長句不算')
  assert.equal(await b.spec(BIG, { name: 'a', note: 'eyJhbGciOi.eyJzdWIi.sig' }), 'looks_like_secret', 'JWT')
  assert.equal(await b.spec(BIG, { name: 'a', note: 'sk-ant12345' }), 'looks_like_secret', 'sk-')
  assert.equal(await b.spec(BIG, { name: 'a', note: 'sk-short' }), null)
  // 金鑰檢查對 allow_email 欄位照樣有效
  assert.equal(await b.spec(BIG, { name: 'a', login: 'a'.repeat(40) }), 'looks_like_secret')
})

// ───────── report_validate ─────────
test('report_validate：沒登記、停用、非物件、超過 max_bytes、沒有規則', { skip }, async () => {
  const b = await boot()
  assert.equal(await b.validate('echo', { text: 'hi' }), null)
  assert.equal(await b.validate('nope', { text: 'hi' }), 'unknown_kind')
  await b.kind('off', { spec: { fields: { a: { type: 'int' } } }, enabled: false })
  assert.equal(await b.validate('off', { a: 1 }), 'disabled')
  assert.equal(await b.validate('echo', ['x']), 'not_object')
  assert.equal(await b.validate('echo', 'x'), 'not_object')
  await b.kind('tiny', { spec: { fields: { t: { type: 'string', max: 500 } } }, max: 30 })
  assert.equal(await b.validate('tiny', { t: 'x'.repeat(5) }), null)
  assert.equal(await b.validate('tiny', { t: 'x'.repeat(40) }), 'too_large')
  await b.kind('bare', {})
  assert.equal(await b.validate('bare', { a: 1 }), 'no_rule')
  assert.equal(await b.validate('echo', { text: 'x', y: 1 }), 'unknown_field')
})

test('report_validate：validator 路徑（測試資料庫另建 report_check_probe）；名稱注入與不存在的函式被擋', { skip }, async () => {
  const b = await boot()
  await b.db.exec(`create function relay.report_check_probe(p jsonb) returns text language sql as $$ select case when (p->>'n')::int % 2 = 0 then null else 'odd' end $$;
    create function relay.report_check_boom(p jsonb) returns text language plpgsql as $$ begin raise exception 'x'; end $$;
    create table public.pwned(x int);`)
  await b.kind('probe', { validator: 'report_check_probe' })
  assert.equal(await b.validate('probe', { n: 2 }), null)
  assert.equal(await b.validate('probe', { n: 3 }), 'odd')
  // spec 與 validator 兩者都有：先 spec 再 validator
  await b.kind('both', { spec: { fields: { n: { type: 'int', max: 10 } } }, validator: 'report_check_probe' })
  assert.equal(await b.validate('both', { n: 4 }), null)
  assert.equal(await b.validate('both', { n: 3 }), 'odd')
  assert.equal(await b.validate('both', { n: 12 }), 'out_of_range')
  // validator 內部丟例外 → 固定代碼，不帶內容
  await b.kind('boom', { validator: 'report_check_boom' })
  assert.equal(await b.validate('boom', { n: 2 }), 'validator_error')
  // 注入與不合規的名稱
  const bad = ['report_check_probe(jsonb); insert into public.pwned values (1); select', 'report_check_probe(jsonb)', 'Report_Check_Probe', 'report_check_', 'public.report_check_probe',
    'pg_sleep', 'report_validate', 'report_check_spec', 'report_check_value', 'report_check_missing', 'report_check_probe;--', 'report_check_probe ']
  for (const [i, v] of bad.entries()) {
    await b.kind(`inj${i}`, { validator: v })
    const r = await b.validate(`inj${i}`, { n: 2 })
    // 尾端空白會被 btrim 去掉而等同合法名稱；其餘一律 bad_validator
    if (v === 'report_check_probe ') assert.equal(r, null, v)
    else assert.equal(r, 'bad_validator', v)
  }
  assert.equal((await b.q('select count(*)::int c from public.pwned'))[0].c, 0, '注入沒有執行')
})

// ───────── asn_relay_report ─────────
test('寫入：不存在或非 active 的節點 not_found；驗證失敗回原因；成功寫入帶雜湊與大小', { skip }, async () => {
  const b = await boot()
  await b.node('n1'); await b.node('gone', { status: 'left' })
  assert.deepEqual(await b.report('ghost', 'echo', { text: 'a' }), { ok: false, rejected_reason: 'not_found' })
  assert.deepEqual(await b.report('gone', 'echo', { text: 'a' }), { ok: false, rejected_reason: 'not_found' })
  assert.deepEqual(await b.report('n1', 'echo', { text: 1 }), { ok: false, rejected_reason: 'type_mismatch' })
  assert.deepEqual(await b.report('n1', 'nokind', { text: 'a' }), { ok: false, rejected_reason: 'unknown_kind' })
  assert.deepEqual(await b.report('n1', 'echo', { text: 'a@b.co' }), { ok: false, rejected_reason: 'looks_like_email' })
  assert.equal((await b.q('select count(*)::int c from relay.reports'))[0].c, 0, '被拒的都沒寫')
  assert.deepEqual(await b.report('n1', 'echo', { text: 'hello' }), { ok: true, changed: true })
  const r = await b.row('n1', 'echo')
  assert.equal(r.payload.text, 'hello'); assert.match(r.hash, /^[0-9a-f]{64}$/); assert.equal(r.size, JSON.stringify({ text: 'hello' }).length + 1)
})

test('寫入：相同雜湊不寫、保活只更新 updated_at；鍵順序不同的同內容視為相同', { skip }, async () => {
  const b = await boot()
  await b.node('n1')
  await b.kind('two', { spec: { fields: { a: { type: 'int' }, b: { type: 'int' } } }, keep: 60, min: 5 })
  assert.deepEqual(await b.report('n1', 'two', { a: 1, b: 2 }), { ok: true, changed: true })
  const r0 = await b.row('n1', 'two')
  await b.age('n1', 'two', 10)               // 過了最小間隔、未達保活
  const r1 = await b.row('n1', 'two')
  assert.deepEqual(await b.report('n1', 'two', { b: 2, a: 1 }), { ok: true, changed: false })
  const r2 = await b.row('n1', 'two')
  assert.equal(r2.updated_at.getTime(), r1.updated_at.getTime(), '未達保活：完全沒寫')
  assert.equal(r2.written_at.getTime(), r1.written_at.getTime())
  await b.age('n1', 'two', 100)              // 超過保活
  const r3 = await b.row('n1', 'two')
  assert.deepEqual(await b.report('n1', 'two', { a: 1, b: 2 }), { ok: true, changed: false })
  const r4 = await b.row('n1', 'two')
  assert.ok(r4.updated_at > r3.updated_at, '保活：updated_at 更新')
  assert.ok(r4.written_at > r3.written_at, '保活也算寫入：written_at 更新')
  assert.equal(r4.changed_at.getTime(), r3.changed_at.getTime(), 'changed_at 不動')
  assert.equal(r4.hash, r0.hash)
})

test('寫入：雜湊不同但在最小間隔內 → rate（帶 retry_after_seconds、不寫）；間隔後可寫並更新 changed_at', { skip }, async () => {
  const b = await boot()
  await b.node('n1')
  assert.deepEqual(await b.report('n1', 'echo', { text: 'v1' }), { ok: true, changed: true })
  const before = await b.row('n1', 'echo')
  const r = await b.report('n1', 'echo', { text: 'v2' })
  assert.equal(r.ok, false); assert.equal(r.rejected_reason, 'rate')
  assert.ok(r.retry_after_seconds >= 1 && r.retry_after_seconds <= 5, `retry_after=${r.retry_after_seconds}`)
  const still = await b.row('n1', 'echo')
  assert.equal(still.payload.text, 'v1', '不寫')
  assert.equal(still.hash, before.hash)
  await b.age('n1', 'echo', 6)
  assert.deepEqual(await b.report('n1', 'echo', { text: 'v2' }), { ok: true, changed: true })
  const after = await b.row('n1', 'echo')
  assert.equal(after.payload.text, 'v2')
  assert.ok(after.changed_at > before.changed_at)
  // 剛寫完又改：再次 rate
  assert.equal((await b.report('n1', 'echo', { text: 'v3' })).rejected_reason, 'rate')
  // 相同內容在最小間隔內不算 rate，是 ok/changed=false
  assert.deepEqual(await b.report('n1', 'echo', { text: 'v2' }), { ok: true, changed: false })
})

test('寫入：每節點滾動 60 秒總量上限 rate_node；窗外的不算；兩節點互不影響', { skip }, async () => {
  const b = await boot()
  await b.node('n1'); await b.node('n2')
  for (let i = 0; i < 61; i++) await b.kind(`k${i}`, { spec: { fields: { v: { type: 'int' } } }, min: 0 })
  for (let i = 0; i < 60; i++) assert.deepEqual(await b.report('n1', `k${i}`, { v: 1 }), { ok: true, changed: true }, `k${i}`)
  const cap = await b.report('n1', 'k60', { v: 1 })
  assert.equal(cap.ok, false); assert.equal(cap.rejected_reason, 'rate_node')
  assert.ok(cap.retry_after_seconds >= 1 && cap.retry_after_seconds <= 60)
  assert.equal(await b.row('n1', 'k60'), undefined, '被擋的沒寫')
  // 另一個節點不受影響
  assert.deepEqual(await b.report('n2', 'k60', { v: 1 }), { ok: true, changed: true })
  assert.deepEqual(await b.report('n2', 'echo', { text: 'x' }), { ok: true, changed: true })
  // 把其中一列推出窗外就又能寫
  await b.ageWritten('n1', 'k0', 61)
  assert.deepEqual(await b.report('n1', 'k60', { v: 1 }), { ok: true, changed: true })
  // 內容沒變的請求不算寫入、不被總量擋
  assert.deepEqual(await b.report('n1', 'k1', { v: 1 }), { ok: true, changed: false })
})

test('寫入：不影響 nodes.last_seen_at；節點刪除後 reports 被 cascade 清掉；欄位型別與外鍵', { skip }, async () => {
  const b = await boot()
  await b.node('n1', { seen: '2026-01-01T00:00:00Z' }); await b.node('n2')
  await b.report('n1', 'echo', { text: 'a' }); await b.report('n2', 'echo', { text: 'b' })
  assert.equal((await b.q("select last_seen_at from relay.nodes where id = 'n1'"))[0].last_seen_at.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal((await b.q("select count(*)::int c from relay.reports where node = 'n1'"))[0].c, 1, '前提：有資料')
  await assert.rejects(b.db.query("insert into relay.reports (node, kind, payload, hash, size) values ('ghost', 'echo', '{}', 'h', 2)"), /foreign key|violates/i)
  await b.db.exec("delete from relay.nodes where id = 'n1'")
  assert.equal((await b.q("select count(*)::int c from relay.reports where node = 'n1'"))[0].c, 0)
  assert.equal((await b.q("select count(*)::int c from relay.reports where node = 'n2'"))[0].c, 1, '別的節點的不動')
})

test('權限：兩張表 RLS 開、無 policy、anon／authenticated 無權；新函式只有 service_role 能執行', { skip }, async () => {
  const b = await boot()
  const rls = await b.q("select relname, relrowsecurity from pg_class where oid in ('relay.reports'::regclass, 'relay.report_kinds'::regclass)")
  assert.equal(rls.length, 2); assert.ok(rls.every(r => r.relrowsecurity))
  assert.equal((await b.q("select count(*)::int c from pg_policies where schemaname = 'relay' and tablename in ('reports', 'report_kinds')"))[0].c, 0)
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await b.q(`select has_table_privilege('${role}', 'relay.reports', 'select') a, has_table_privilege('${role}', 'relay.report_kinds', 'select') k`))[0].a, false)
    assert.equal((await b.q(`select has_table_privilege('${role}', 'relay.report_kinds', 'select') k`))[0].k, false)
  }
  const fns = await b.q(`select p.oid::regprocedure::text sig, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth,
      has_function_privilege('service_role', p.oid, 'execute') svc, p.prosecdef sd, p.proconfig::text cfg
    from pg_proc p where p.proname in ('asn_relay_report', 'asn_relay_report_get', 'report_validate', 'report_check_spec', 'report_check_value', 'report_can_read', 'report_readers')`)
  assert.equal(fns.length, 7)
  for (const f of fns) {
    assert.equal(f.anon, false, f.sig); assert.equal(f.auth, false, f.sig); assert.equal(f.sd, true, f.sig); assert.match(f.cfg, /search_path/, f.sig)
    assert.equal(f.svc, /^(public.)?asn_relay_report/.test(f.sig), `${f.sig} service_role`)
  }
})

// ───────── asn_relay_report_get ─────────
// 場景：T1 有 U1 的三台（a、b、c）＋一台無擁有者的 d＋一台別人（U2，租戶 T2）的 x；群組 g1（T1）有 a、b~w1、d；群組 g2（T1）已封存有 a、c；群組 g3（T2）有 x 與 a（跨租戶）
async function scene() {
  const b = await boot()
  await b.node('a'); await b.node('b'); await b.node('c'); await b.node('d', { user: null })
  await b.node('x', { tenant: T2, user: U2 })
  await b.node('off', { status: 'left' })
  await b.room('g1', T1, ['a', 'b~w1', 'd'])
  await b.room('g2', T1, ['a', 'c'], { archived: '2026-01-01T00:00:00Z' })
  await b.room('g3', T2, ['x', 'a'])
  await b.kind('rs', { spec: { fields: { v: { type: 'int' } } }, scope: 'room', min: 0 })
  await b.kind('os', { spec: { fields: { v: { type: 'int' } } }, scope: 'owner', min: 0 })
  await b.kind('ss', { spec: { fields: { v: { type: 'int' } } }, scope: 'self', min: 0 })
  for (const k of ['rs', 'os', 'ss']) for (const n of ['a', 'b', 'c', 'd', 'x']) await b.report(n, k, { v: n.charCodeAt(0) })
  return b
}
const nodesOf = r => r.reports.map(x => x.node)
const ALL = ['a', 'b', 'c', 'd', 'x', 'off', 'ghost']

test('讀取 self：只看得到自己；別人的節點不出現、也不回錯誤', { skip }, async () => {
  const b = await scene()
  const r = await b.get('a', 'ss', ALL)
  assert.equal(r.ok, true); assert.deepEqual(nodesOf(r), ['a'])
  assert.deepEqual(r.reports[0].payload, { v: 97 }); assert.equal(r.reports[0].kind, 'ss')
  assert.ok(r.reports[0].updated_at && r.reports[0].changed_at)
  assert.deepEqual(nodesOf(await b.get('a', 'ss', ['b', 'c'])), [], '無權：空結果')
  assert.deepEqual(await b.get('a', 'ss', ['b']), { ok: true, reports: [] })
})

test('讀取 owner：同一擁有者的 a、b、c 互看；無擁有者的 d、別人的 x、不存在的呼叫者都看不到', { skip }, async () => {
  const b = await scene()
  assert.deepEqual(nodesOf(await b.get('a', 'os', ALL)), ['a', 'b', 'c'])
  assert.deepEqual(nodesOf(await b.get('c', 'os', ALL)), ['a', 'b', 'c'])
  assert.deepEqual(nodesOf(await b.get('d', 'os', ALL)), ['d'], '無擁有者的只看得到自己')
  assert.deepEqual(nodesOf(await b.get('x', 'os', ALL)), ['x'])
  assert.deepEqual(nodesOf(await b.get('ghost', 'os', ALL)), [])
  assert.deepEqual(nodesOf(await b.get(null, 'os', ALL)), [])
  assert.deepEqual(nodesOf(await b.get('off', 'os', ALL)), [], '已撤銷的呼叫者什麼都看不到')
})

test('讀取 room：同租戶、同一個未封存群組的現任成員互看（成員鍵可為 節點~視窗）；封存群組、跨租戶群組、沒同群組的不算', { skip }, async () => {
  const b = await scene()
  assert.deepEqual(nodesOf(await b.get('a', 'rs', ALL)), ['a', 'b', 'd'], 'a 與 b~w1、d 同群組 g1；c 只在封存的 g2；x 只在跨租戶 g3')
  assert.deepEqual(nodesOf(await b.get('b', 'rs', ALL)), ['a', 'b', 'd'])
  assert.deepEqual(nodesOf(await b.get('c', 'rs', ALL)), ['c'], 'c 只在封存群組：只看得到自己')
  assert.deepEqual(nodesOf(await b.get('x', 'rs', ALL)), ['x'], '跨租戶群組 g3 不互看')
  // 離開群組後就看不到
  await b.db.exec("update relay.room_members set left_at = now() where room_id = 'g1' and member = 'd'")
  assert.deepEqual(nodesOf(await b.get('a', 'rs', ALL)), ['a', 'b'])
  assert.deepEqual(nodesOf(await b.get('d', 'rs', ALL)), ['d'])
  // 成員鍵前綴比對不誤判：節點 a 與節點 ab
  await b.node('ab'); await b.report('ab', 'rs', { v: 1 })
  assert.deepEqual(nodesOf(await b.get('a', 'rs', ['ab'])), [])
})

test('讀取：p_nodes 最多 50 筆、未知／停用的 kind、空陣列與 null', { skip }, async () => {
  const b = await scene()
  const many = Array.from({ length: 51 }, (_, i) => `z${i}`)
  assert.deepEqual(await b.get('a', 'ss', many), { ok: false, rejected_reason: 'too_many_nodes' })
  assert.deepEqual((await b.get('a', 'ss', many.slice(0, 50))).ok, true)
  assert.deepEqual(await b.get('a', 'nokind', ['a']), { ok: false, rejected_reason: 'unknown_kind' })
  await b.db.exec("update relay.report_kinds set enabled = false where kind = 'ss'")
  assert.deepEqual(await b.get('a', 'ss', ['a']), { ok: false, rejected_reason: 'unknown_kind' })
  assert.deepEqual(await b.get('a', 'os', []), { ok: true, reports: [] })
  assert.deepEqual(await b.get('a', 'os', null), { ok: true, reports: [] })
})

test('report_readers 與 get 同源：對每個 scope、每個目標節點，readers(target) ＝ 所有能用 get 讀到 target 的節點', { skip }, async () => {
  const b = await scene()
  const every = ['a', 'b', 'c', 'd', 'x']
  let nonTrivial = 0
  for (const kind of ['ss', 'os', 'rs']) {
    for (const target of every) {
      const viaGet = []
      for (const caller of every) if (nodesOf(await b.get(caller, kind, [target])).includes(target)) viaGet.push(caller)
      const readers = await b.readers(target, kind)
      assert.deepEqual(readers, viaGet.sort(), `${kind}/${target}`)
      if (readers.length > 1) nonTrivial++
    }
  }
  assert.ok(nonTrivial >= 6, '前提：owner／room 確實有多位讀者（不是空過）')
  assert.deepEqual(await b.readers('a', 'os'), ['a', 'b', 'c'])
  assert.deepEqual(await b.readers('a', 'rs'), ['a', 'b', 'd'])
  assert.deepEqual(await b.readers('a', 'ss'), ['a'])
  assert.deepEqual(await b.readers('a', 'nokind'), [])
  assert.deepEqual(await b.readers('off', 'os'), [])
})

test('兩條驗證路徑都能走完整寫入／讀取：spec 型（echo）與 validator 型（測試另建 probe）', { skip }, async () => {
  const b = await boot()
  await b.node('n1')
  await b.db.exec("create function relay.report_check_probe(p jsonb) returns text language sql as $$ select case when p ? 'ok' then null else 'no_ok' end $$;")
  await b.kind('probe', { validator: 'report_check_probe', min: 0 })
  assert.deepEqual(await b.report('n1', 'echo', { text: 'via spec' }), { ok: true, changed: true })
  assert.deepEqual(await b.report('n1', 'probe', { whatever: 1 }), { ok: false, rejected_reason: 'no_ok' })
  assert.deepEqual(await b.report('n1', 'probe', { ok: 1, free: ['form'] }), { ok: true, changed: true })
  const g = await b.get('n1', 'probe', ['n1'])
  assert.deepEqual(g.reports[0].payload, { ok: 1, free: ['form'] })
  assert.equal((await b.get('n1', 'echo', ['n1'])).reports[0].payload.text, 'via spec')
})

test('回復：套 down 後函式與兩張表都消失，其他函式數不變；可再套回去', { skip }, async () => {
  const b = await boot()
  const cnt = async () => (await b.q("select count(*)::int c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('relay', 'public')"))[0].c
  const withBus = await cnt()
  await b.db.exec(norm(fs.readFileSync(DOWN, 'utf8')))
  assert.equal(await cnt(), withBus - 7)
  assert.equal((await b.q("select to_regclass('relay.reports') r, to_regclass('relay.report_kinds') k"))[0].r, null)
  await b.db.exec(read(MIG))
  assert.equal(await cnt(), withBus)
})
