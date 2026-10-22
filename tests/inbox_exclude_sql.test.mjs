// 節點信箱排除清單 migration（20261023020000_inbox_exclude_agents.sql）：
// 1. 靜態檢查：舊單參數版拿掉、新版選填、只授權 service_role。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（`npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres 套用 account_me、owner_sender_display 與本 migration，
//    驗：只帶 p_node 的舊呼叫行為不變（仍回最舊 50 封）；帶排除清單時略過那些視窗的信、後面的新信進得來；
//    to_agent 為空的信永遠保留；排除的信不被設 delivered_at、不被 ack；沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261022020000_account_me.sql')
const owner = read('20261022090000_owner_sender_display.sql')
const mig = read('20261023020000_inbox_exclude_agents.sql')

test('靜態：舊單參數版拿掉、新版選填、只授權 service_role、單一交易', () => {
  assert.match(mig, /drop function if exists public\.irori_relay_inbox\(text\);/)
  assert.match(mig, /create or replace function public\.irori_relay_inbox\(p_node text, p_exclude_agents text\[\] default null::text\[\]\)/)
  assert.match(mig, /grant execute on function public\.irori_relay_inbox\(text, text\[\]\) to service_role;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid, character_node text, owner_name text not null default '朋友');
    create table relay.nodes(id text primary key, tenant_id uuid not null, status text default 'active', role text default 'member',
      owner_user uuid, bell_topic text not null, created_at timestamptz default now(), name text not null default '', machine text);
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, to_agent text,
      body text, reply_to uuid, created_at timestamptz default now(), delivered_at timestamptz, acked_at timestamptz, tenant_id uuid,
      expects_reply boolean, owner_signed boolean not null default false);
    create table relay.asn_presence(node text, window_name text, updated_at timestamptz default now(), primary key (node, window_name));
    create table relay.roster(node text, name text, engine text, primary key (node, name));
    create table relay.attachments(id uuid primary key default gen_random_uuid(), message_id uuid, room_id text, room_seq bigint, kind text, name text,
      mime text, bytes int, width int, height int, thumb text, status text default 'ready', expires_at timestamptz default now() + interval '30 days',
      removed_at timestamptz, created_at timestamptz default now(), owner_node text, tenant_id uuid, storage_path text);
    create table relay.room_members(room_id text, member text, left_at timestamptz);
    create function relay.node_tenant(p text) returns uuid language sql as $$ select tenant_id from relay.nodes where id = p $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}', 'XISU', '小良');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic, created_at, name, machine) values
      ('XISU', '${T1}', 'owner', null, 'bell-XISU', now() - interval '5 day', '希緒', null),
      ('H', '${T1}', 'member', '${U1}', 'bell-H', now() - interval '2 day', '小良的家用機', '家用機'),
      ('M', '${T1}', 'member', null, 'bell-M', now() - interval '1 day', 'M 機', null);`)
  await db.exec(base)
  await db.exec(owner)
  await db.exec(mig)
  const q = async (text, args) => (await db.query(text, args)).rows
  // 依序放信（created_at 遞增）：to_agent 為 null＝沒指定收件人
  let n = 0
  const put = async (toAgent, body) => q(
    `insert into relay.messages(from_node, from_agent, to_node, to_agent, body, tenant_id, created_at) values ('M','小文','H',$1,$2,$3, now() - interval '1 hour' + $4 * interval '1 second')`,
    [toAgent, body, T1, n++])
  return { db, q, put }
}

test('實跑（pglite）：只帶 p_node 的舊呼叫行為不變——最舊 50 封（行頭堵塞的原樣）', { skip }, async () => {
  const { q, put } = await setup()
  for (let i = 0; i < 60; i++) await put('H-ASN', `asn-${i}`)
  await put('H-乙', '新信')
  const r = (await q(`select public.irori_relay_inbox('H') r`))[0].r
  assert.equal(r.length, 50)
  assert.ok(r.every(m => m.to_agent === 'H-ASN'), '舊行為：新信被擋在第 51 封之後')
  const r2 = (await q(`select public.irori_relay_inbox('H', null) r`))[0].r
  assert.equal(r2.length, 50)
  assert.deepEqual(Object.keys(r[0]).sort(), ['body', 'created_at', 'expects_reply', 'fanout_id', 'from_agent', 'from_node', 'id', 'reply_to', 'sender_device', 'sender_display', 'sender_engine', 'to_agent', 'to_node', 'trust'])
})

test('實跑（pglite）：帶排除清單 → 略過那些視窗的信，後面的新信進得來；沒指定收件人的信保留', { skip }, async () => {
  const { q, put } = await setup()
  for (let i = 0; i < 60; i++) await put(i % 2 ? 'H-ASN' : 'H-ASN舊名', `asn-${i}`)
  await put(null, '沒指定收件人')
  await put('H-乙', '新信')
  const r = (await q(`select public.irori_relay_inbox('H', array['H-ASN','H-ASN舊名']) r`))[0].r
  assert.deepEqual(r.map(m => m.body), ['沒指定收件人', '新信'])
  const rows = await q(`select body, delivered_at from relay.messages where body like 'asn-%'`)
  assert.ok(rows.every(x => x.delivered_at === null), '被排除的信不被標成已送達')
  assert.equal((await q(`select count(*)::int c from relay.messages where acked_at is not null`))[0].c, 0)
})

test('實跑（pglite）：空陣列＝不排除；排除清單只影響這一次讀取，之後不帶就照舊看得到', { skip }, async () => {
  const { q, put } = await setup()
  await put('H-ASN', 'a'); await put('H-乙', 'b')
  assert.equal((await q(`select jsonb_array_length(public.irori_relay_inbox('H', array[]::text[])) n`))[0].n, 2)
  assert.equal((await q(`select jsonb_array_length(public.irori_relay_inbox('H', array['H-ASN'])) n`))[0].n, 1)
  assert.equal((await q(`select jsonb_array_length(public.irori_relay_inbox('H')) n`))[0].n, 2)
})
