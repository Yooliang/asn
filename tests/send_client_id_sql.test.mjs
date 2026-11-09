// 冪等寄信（20261111120000_send_client_id.sql，#1135）：同一個寄件節點內，同一個 client_id 只寄一封。
// 涵蓋：重複送回第一次的 id 並標 duplicate、不多寄一列；跨節點同 id 不算重複；舊客戶端（不帶 client_id）行為不變；
// 寄信失敗不記 client_id（重試照常寄）；扇出時 client_id 只記在回傳的那一列；語音旗標照舊；權限；lookup。
// 沒裝 @electric-sql/pglite 時只跑靜態部分。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const mig = rd(fs.readFileSync(new URL('20261111120000_send_client_id.sql', DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261111120000_send_client_id_down.sql', import.meta.url), 'utf8'))
const IDEM = 'asn_relay_send_idem(uuid, text, text, text, text, text, uuid, boolean, uuid, boolean, boolean)'
const LOOKUP = 'asn_relay_send_lookup(text, uuid)'

test('靜態：兩支新函式只授權 service_role、search_path 空；排在 bridge_notice 之後；有回復檔；不改既有寄信函式', () => {
  const body = mig.replace(/^--.*$/gm, '')
  for (const sig of [IDEM, LOOKUP]) {
    assert.ok(body.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig)
    assert.ok(body.includes(`grant execute on function public.${sig} to service_role;`), sig)
  }
  assert.equal((body.match(/security definer\s+set search_path to ''/g) || []).length, 2)
  assert.doesNotMatch(body, /create or replace function public\.asn_relay_send(_core|_voice)?\(/)
  assert.doesNotMatch(body, /alter function/)
  const files = fs.readdirSync(DIR).sort()
  assert.ok(files.indexOf('20261111120000_send_client_id.sql') > files.indexOf('20261111110000_bridge_notice.sql'))
  assert.match(down, /drop function if exists public\.asn_relay_send_idem\(/)
  assert.match(down, /drop index if exists relay\.relay_messages_from_client_uidx/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const C1 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const C2 = '1a8fad5b-d9cb-469f-a165-70867728950e'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.messages(id uuid primary key default gen_random_uuid(), fanout_id uuid, from_node text, from_agent text, to_node text, to_agent text,
      body text, voice boolean not null default false);
    -- 寄信函式的替身：寄到 FAN 扇出三列（共用 fanout_id、回第一列）；寄到 BAD 回錯誤；其餘一列
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      declare v_head uuid := gen_random_uuid(); v_k int; begin
        if c = 'BAD' then return jsonb_build_object('error', 'unknown_to_node'); end if;
        insert into relay.messages(id, fanout_id, from_node, from_agent, to_node, to_agent, body) values (v_head, case when c = 'FAN' then v_head end, a, b, c, d, e);
        if c = 'FAN' then for v_k in 1..2 loop insert into relay.messages(fanout_id, from_node, from_agent, to_node, to_agent, body) values (v_head, a, b, c, d, e); end loop; end if;
        return jsonb_build_object('id', v_head, 'bell_topic', 'b1'); end $$;
    create function public.asn_relay_send_voice(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean, j boolean) returns jsonb language plpgsql as $$
      declare v_r jsonb; begin v_r := public.asn_relay_send(a, b, c, d, e, f, g, h, i);
        if v_r ? 'id' then update relay.messages set voice = true where id = (v_r->>'id')::uuid; end if; return v_r; end $$;`)
  await db.exec(mig)
  const q = async (t, a) => (await db.query(t, a)).rows
  return { db, q }
}
const send = async (q, cid, node = 'A', to = 'T', body = '哈囉', voice = false) =>
  (await q(`select public.asn_relay_send_idem($1::uuid, $2, '小乙', $3, '收件窗', $4, null, null, null, false, $5) r`, [cid, node, to, body, voice]))[0].r
const count = async q => Number((await q(`select count(*) n from relay.messages`))[0].n)

test('實跑：重複送回第一次的 id、標 duplicate、不多寄一列', { skip }, async () => {
  const { q } = await boot()
  const r1 = await send(q, C1)
  assert.ok(r1.id && !r1.duplicate)
  const r2 = await send(q, C1, 'A', 'T', '重試時內文一樣')
  assert.equal(r2.id, r1.id)
  assert.equal(r2.duplicate, true)
  assert.equal(await count(q), 1)
  assert.equal((await q(`select client_id from relay.messages`))[0].client_id, C1)
})

test('實跑：跨節點同一個 client_id 不算重複；同節點不同 client_id 也不算', { skip }, async () => {
  const { q } = await boot()
  const a = await send(q, C1, 'A')
  const b = await send(q, C1, 'B')
  const c = await send(q, C2, 'A')
  assert.equal(new Set([a.id, b.id, c.id]).size, 3)
  assert.ok(!b.duplicate && !c.duplicate)
  assert.equal(await count(q), 3)
})

test('實跑：舊客戶端不帶 client_id，每封都寄、不記、結果與原函式相同', { skip }, async () => {
  const { q } = await boot()
  const r1 = await send(q, null)
  const r2 = await send(q, null)
  assert.notEqual(r1.id, r2.id)
  assert.equal(r1.duplicate, undefined)
  assert.deepEqual(Object.keys(r1).sort(), ['bell_topic', 'id'])
  assert.equal(await count(q), 2)
  assert.equal(Number((await q(`select count(*) n from relay.messages where client_id is not null`))[0].n), 0)
})

test('實跑：寄信失敗不記 client_id，之後用同一個 client_id 重試照常寄', { skip }, async () => {
  const { q } = await boot()
  const bad = await send(q, C1, 'A', 'BAD')
  assert.equal(bad.error, 'unknown_to_node')
  assert.equal(await count(q), 0)
  const ok = await send(q, C1, 'A', 'T')
  assert.ok(ok.id && !ok.duplicate)
})

test('實跑：扇出時 client_id 只記在回傳的第一列；重複回同一個 id；語音旗標照舊', { skip }, async () => {
  const { q } = await boot()
  const r1 = await send(q, C1, 'A', 'FAN', '扇出', true)
  assert.equal(await count(q), 3)
  assert.equal(Number((await q(`select count(*) n from relay.messages where client_id = $1`, [C1]))[0].n), 1)
  assert.equal((await q(`select id from relay.messages where client_id = $1`, [C1]))[0].id, r1.id)
  assert.equal((await q(`select voice from relay.messages where id = $1`, [r1.id]))[0].voice, true)
  assert.equal((await send(q, C1, 'A', 'FAN', '扇出', true)).id, r1.id)
  assert.equal(await count(q), 3)
})

test('實跑：lookup 查得到已寄出的、查不到回 null；只認同一個寄件節點', { skip }, async () => {
  const { q } = await boot()
  const r1 = await send(q, C1, 'A')
  const look = async (n, c) => (await q(`select public.asn_relay_send_lookup($1, $2::uuid) r`, [n, c]))[0].r
  assert.deepEqual(await look('A', C1), { id: r1.id })
  assert.equal(await look('B', C1), null)
  assert.equal(await look('A', C2), null)
  assert.equal(await look('A', null), null)
})

test('實跑：只授權 service_role（anon、authenticated 不能執行）；部分唯一索引存在', { skip }, async () => {
  const { q } = await boot()
  for (const sig of [IDEM, LOOKUP]) {
    const r = (await q(`select has_function_privilege('anon', 'public.${sig}', 'execute') a, has_function_privilege('authenticated', 'public.${sig}', 'execute') b,
      has_function_privilege('service_role', 'public.${sig}', 'execute') s`))[0]
    assert.deepEqual(r, { a: false, b: false, s: true }, sig)
  }
  const idx = (await q(`select indexdef from pg_indexes where indexname = 'relay_messages_from_client_uidx'`))[0]
  assert.match(idx.indexdef, /UNIQUE.*\(from_node, client_id\) WHERE \(client_id IS NOT NULL\)/)
  assert.equal((await q(`select proconfig from pg_proc where proname = 'asn_relay_send_idem'`))[0].proconfig[0], 'search_path=""')
})

test('實跑：回復檔乾淨移除兩支函式、索引與欄位', { skip }, async () => {
  const { db, q } = await boot()
  await db.exec(down)
  assert.equal(Number((await q(`select count(*) n from pg_proc where proname in ('asn_relay_send_idem', 'asn_relay_send_lookup')`))[0].n), 0)
  assert.equal(Number((await q(`select count(*) n from information_schema.columns where table_name = 'messages' and column_name = 'client_id'`))[0].n), 0)
})
