// 往上捲載入更舊的信：20261023070000_chat_history_before.sql
// 1. 靜態：先 drop 六參數舊版再建七參數版（不並存）、p_before 預設 null、授權只給 service_role、其餘條件沒被動到。
// 2. 實跑（需要 `npm i --no-save @electric-sql/pglite`，沒裝就略過）：舊呼叫（五參數、沒帶 before）結果不變；
//    帶 before 只回更早的最近 N 則；before 剛好等於某則的時間不含那則；before 之前沒信回空；扇出群組照樣一列；函式只剩一個。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sqlOld = read('20261022100000_chat_history_fanout_device.sql')
const sqlNew = read('20261023070000_chat_history_before.sql')

test('靜態：drop 舊簽章再建新簽章、p_before 預設 null、授權只給 service_role', () => {
  assert.match(sqlNew, /drop function if exists public\.asn_chat_history\(uuid, text, text, text, integer, text\);/)
  assert.ok(sqlNew.indexOf('drop function') < sqlNew.indexOf('create or replace function'), '先 drop 再建')
  assert.match(sqlNew, /p_partner_id text default null::text, p_before timestamptz default null\)/)
  assert.match(sqlNew, /and \(p_before is null or m\.created_at < p_before\)/)
  assert.match(sqlNew, /security definer\n set search_path to ''/)
  assert.match(sqlNew, /revoke all on function public\.asn_chat_history\(uuid, text, text, text, integer, text, timestamptz\) from public, anon, authenticated;/)
  assert.match(sqlNew, /grant execute on function public\.asn_chat_history\(uuid, text, text, text, integer, text, timestamptz\) to service_role;/)
  // 其餘定義沿用上一版：90 天、上限 200、同 fanout_id 一列
  for (const must of ["interval '90 days'", 'least(greatest(coalesce(p_limit, 100), 1), 200)', 'group by coalesce(m.fanout_id, m.id), m.fanout_id']) assert.ok(sqlNew.includes(must), must)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text);
    create table relay.partners(partner_id text, tenant_id uuid);
    create table relay.messages(id uuid primary key default gen_random_uuid(), tenant_id uuid, from_node text, from_agent text, to_node text, to_agent text,
      body text, reply_to uuid, person_user uuid, fanout_id uuid, to_partner_id text, from_partner_id text,
      created_at timestamptz default now(), delivered_at timestamptz, acked_at timestamptz);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_person_alias(p_user uuid) returns text language sql immutable as
      $$ select case when p_user is null then null else 'u:' || substr(md5('asn-person:' || p_user::text), 1, 12) end $$;
    insert into relay.nodes(id, tenant_id, owner_user, name) values
      ('H','${T1}','${U1}','小良的家用機'), ('P','${T1}','${U1}','Oppo 手機'), ('W','${T1}','${U1}','公司機'), ('M','${T1}',null,'AI 機器'), ('X','${T2}','${U2}','別人');`)
  await db.exec(sqlOld)
  await db.exec(sqlNew)
  const q = async (text, args) => (await db.query(text, args)).rows
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  const hist = async (node, limit, before) => (await q(before === undefined ? 'select public.asn_chat_history($1,$2,$3,$4,$5) r' : 'select public.asn_chat_history($1,$2,$3,$4,$5,null,$6) r',
    before === undefined ? [U1, node, 'M', '小文', limit ?? 100] : [U1, node, 'M', '小文', limit ?? 100, before]))[0].r
  const ins = async (o) => (await q(
    `insert into relay.messages(id, tenant_id, from_node, from_agent, to_node, to_agent, body, person_user, fanout_id, created_at)
       values (coalesce($1::uuid, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now())) returning id`,
    [o.id ?? null, T1, o.from, o.agent, o.to, o.toAgent, o.body, U1, o.fanout ?? null, o.at ?? null]))[0].id
  return { q, alias, hist, ins }
}

const F = 'f0000000-0000-0000-0000-000000000001'

const A = (n) => `2026-10-22T08:00:${String(n).padStart(2, '0')}Z`
async function seed(ins, alias, n) {
  for (let i = 0; i < n; i++) await ins({ from: 'M', agent: '小文', to: 'H', toAgent: alias, body: `第${i}則`, at: A(i) })
}

test('實跑（pglite）：函式只剩一個（舊簽章已 drop，不會「函式不唯一」）', { skip }, async () => {
  const { q } = await boot()
  const r = await q("select pg_get_function_identity_arguments(oid) a from pg_proc where proname = 'asn_chat_history'")
  assert.equal(r.length, 1)
  assert.match(r[0].a, /p_before timestamp with time zone/)
})

test('實跑（pglite）：沒帶 before（五參數舊呼叫、明確帶 null）與從前一樣回最近 N 則', { skip }, async () => {
  const { alias, hist, ins } = await boot()
  await seed(ins, alias, 6)
  assert.deepEqual((await hist('H')).messages.map(x => x.body), ['第0則', '第1則', '第2則', '第3則', '第4則', '第5則'])
  assert.deepEqual((await hist('H', 3)).messages.map(x => x.body), ['第3則', '第4則', '第5則'])
  assert.deepEqual((await hist('H', 3, null)).messages.map(x => x.body), ['第3則', '第4則', '第5則'], '明確帶 null＝不變')
})

test('實跑（pglite）：帶 before 只回更早的最近 N 則；剛好等於某則的時間不含那則；更早沒有就回空', { skip }, async () => {
  const { alias, hist, ins } = await boot()
  await seed(ins, alias, 6)
  assert.deepEqual((await hist('H', 2, A(4))).messages.map(x => x.body), ['第2則', '第3則'], '早於第4則的最近兩則')
  assert.deepEqual((await hist('H', 50, A(3))).messages.map(x => x.body), ['第0則', '第1則', '第2則'], '不含等於 before 的那則')
  assert.deepEqual((await hist('H', 50, A(0))).messages, [], '最早那則之前沒有信')
  assert.equal((await hist('H', 50, '2026-10-22T08:00:05.5Z')).messages.length, 6, 'before 晚於全部＝全回')
})

test('實跑（pglite）：帶 before 時扇出三列仍算一則，群組時間以 before 之前的列計', { skip }, async () => {
  const { alias, hist, ins } = await boot()
  await ins({ id: F, from: 'M', agent: '小文', to: 'H', toAgent: alias, body: '扇出', fanout: F, at: A(1) })
  await ins({ from: 'M', agent: '小文', to: 'P', toAgent: alias, body: '扇出', fanout: F, at: A(2) })
  await ins({ from: 'M', agent: '小文', to: 'W', toAgent: alias, body: '扇出', fanout: F, at: A(3) })
  await ins({ from: 'M', agent: '小文', to: 'H', toAgent: alias, body: '後來的', at: A(10) })
  const r = (await hist('H', 50, A(9))).messages
  assert.equal(r.length, 1)
  assert.equal(r[0].fanout_id, F)
  assert.equal(r[0].ids.length, 3)
})

test('實跑（pglite）：帶 before 仍受權限檢查（別人的節點 forbidden）', { skip }, async () => {
  const { q } = await boot()
  const r = (await q('select public.asn_chat_history($1,$2,$3,$4,$5,null,$6) r', [U2, 'H', 'M', '小文', 10, A(5)]))[0].r
  assert.deepEqual(r, { error: 'forbidden' })
})
