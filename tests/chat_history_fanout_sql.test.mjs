// 往來記錄的多設備修正（#108）：20261022100000_chat_history_fanout_device.sql
// 1. 靜態：只給 service_role、security definer＋search_path ''、簽章沒變（不另開重載）、同 fanout_id 合成一列、帶寄出節點。
// 2. 實跑（需要 `npm i --no-save @electric-sql/pglite`，沒裝就略過）：扇出三列只回一列（優先呼叫端自己那份）、ids 含全部、
//    回傳帶 fanout_id／from_node／from_node_name；沒扇出的信 fanout_id 為 null；別帳號看不到。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261022100000_chat_history_fanout_device.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：授權、簽章不變、同 fanout_id 一列、帶寄出節點名稱', () => {
  assert.match(sql, /security definer\n set search_path to ''/)
  assert.match(sql, /revoke all on function public\.asn_chat_history\(uuid, text, text, text, integer, text\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_chat_history\(uuid, text, text, text, integer, text\) to service_role;/)
  assert.doesNotMatch(sql, /drop function/)
  assert.match(sql, /group by coalesce\(m\.fanout_id, m\.id\)/)
  assert.match(sql, /order by coalesce\(m\.to_node = p_node, false\) desc/)
  assert.match(sql, /'fanout_id', g\.fanout_id/)
  assert.match(sql, /'from_node', g\.from_node/)
  assert.match(sql, /'from_node_name'/)
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
  await db.exec(sql)
  const q = async (text, args) => (await db.query(text, args)).rows
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  const hist = async (node, limit) => (await q('select public.asn_chat_history($1,$2,$3,$4,$5) r', [U1, node, 'M', '小文', limit ?? 100]))[0].r
  const ins = async (o) => (await q(
    `insert into relay.messages(id, tenant_id, from_node, from_agent, to_node, to_agent, body, person_user, fanout_id, created_at)
       values (coalesce($1::uuid, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now())) returning id`,
    [o.id ?? null, T1, o.from, o.agent, o.to, o.toAgent, o.body, U1, o.fanout ?? null, o.at ?? null]))[0].id
  return { q, alias, hist, ins }
}

const F = 'f0000000-0000-0000-0000-000000000001'
const C2 = 'f0000000-0000-0000-0000-000000000002'
const C3 = 'f0000000-0000-0000-0000-000000000003'

test('實跑（pglite）：同一個 fanout_id 三列只回一列，優先呼叫端自己的那份；ids 含全部', { skip }, async () => {
  const { alias, hist, ins } = await boot()
  // 扇出：代表列 F 給 H、C2 給 P、C3 給 W，都記同一個 fanout_id
  await ins({ id: F, from: 'M', agent: '小文', to: 'H', toAgent: 'H-ASN', body: '震動回信', fanout: F, at: '2026-10-22T08:00:00Z' })
  await ins({ id: C2, from: 'M', agent: '小文', to: 'P', toAgent: 'P-ASN', body: '震動回信', fanout: F, at: '2026-10-22T08:00:01Z' })
  await ins({ id: C3, from: 'M', agent: '小文', to: 'W', toAgent: 'W-ASN', body: '震動回信', fanout: F, at: '2026-10-22T08:00:02Z' })
  // 這封回信的 to_agent 是人代號才會被認成「寄給人」；這裡 from 是夥伴，直接走「夥伴寄給我」的方向
  const fromPhone = (await hist('P')).messages
  assert.equal(fromPhone.length, 1, '三列只回一列')
  assert.equal(fromPhone[0].id, C2, '手機看：回呼叫端（手機）自己那份')
  assert.equal(fromPhone[0].fanout_id, F)
  assert.deepEqual([...fromPhone[0].ids].sort(), [F, C2, C3].sort())
  assert.equal(fromPhone[0].dir, 'them')
  assert.equal((await hist('W')).messages[0].id, C3)
  assert.equal((await hist('H')).messages[0].id, F)
  // 呼叫端沒有自己那份（例如那台當時離線沒被扇出）：回最早的一份，仍只有一列
  await ins({ from: 'M', agent: '小文', to: 'H', toAgent: 'H-ASN', body: '只給家用', fanout: C3, at: '2026-10-22T09:00:00Z' })
  await ins({ from: 'M', agent: '小文', to: 'W', toAgent: 'W-ASN', body: '只給家用', fanout: C3, at: '2026-10-22T09:00:01Z' })
  const rows = (await hist('P')).messages
  assert.equal(rows.length, 2)
  assert.equal(rows[1].body, '只給家用')
  assert.equal(rows[1].ids[0], rows[1].id, '沒有自己那份就取最早的')
  void alias
})

test('實跑（pglite）：自己寄的信帶寄出節點 id 與設備名；沒扇出的 fanout_id 是 null；筆數上限算「則」不算列', { skip }, async () => {
  const { alias, hist, ins } = await boot()
  await ins({ from: 'P', agent: alias, to: 'M', toAgent: '小文', body: '手機上說的', at: '2026-10-22T08:00:00Z' })
  await ins({ from: 'H', agent: alias, to: 'M', toAgent: '小文', body: '電腦上說的', at: '2026-10-22T08:01:00Z' })
  const m = (await hist('H')).messages
  assert.deepEqual(m.map(x => [x.dir, x.body, x.from_node, x.from_node_name, x.fanout_id]),
    [['me', '手機上說的', 'P', 'Oppo 手機', null], ['me', '電腦上說的', 'H', '小良的家用機', null]])
  // 扇出的三列算一則：上限 2 時兩則都還在
  await ins({ id: F, from: 'M', agent: '小文', to: 'H', toAgent: alias, body: 'a', fanout: F, at: '2026-10-22T08:02:00Z' })
  await ins({ from: 'M', agent: '小文', to: 'P', toAgent: alias, body: 'a', fanout: F, at: '2026-10-22T08:02:01Z' })
  await ins({ from: 'M', agent: '小文', to: 'W', toAgent: alias, body: 'a', fanout: F, at: '2026-10-22T08:02:02Z' })
  const lim = (await hist('H', 2)).messages
  assert.deepEqual(lim.map(x => x.body), ['電腦上說的', 'a'])
})

test('實跑（pglite）：別帳號、別人的節點仍然 forbidden', { skip }, async () => {
  const { q } = await boot()
  const r = (await q('select public.asn_chat_history($1,$2,$3,$4,$5) r', [U2, 'H', 'M', '小文', 10]))[0].r
  assert.deepEqual(r, { error: 'forbidden' })
})
