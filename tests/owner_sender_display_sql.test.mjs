// 本人寄信的寄件人說明 migration（20261022090000_owner_sender_display.sql）：
// 1. 靜態檢查：函式簽章不變、只授權 service_role、新欄位選填。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（`npm i --no-save @electric-sql/pglite`），在記憶體內的 Postgres 套用 account_me 與本 migration，
//    驗：新位址 u:xxx 與舊寫法 XISU/u:xxx 的回信都送到本人（扇出給在線的 ASN）；別人的代號 unknown_to_node；
//    inbox 多出 sender_display／sender_device／sender_engine，舊欄位的值不變；沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261022020000_account_me.sql')
const mig = read('20261022090000_owner_sender_display.sql')

test('靜態：簽章不變、只授權 service_role、不改資料表', () => {
  assert.match(mig, /create or replace function public\.irori_relay_send\(\s*p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,\s*p_expects_reply boolean default null::boolean, p_signed_user uuid default null::uuid,\s*p_as_person boolean default false\)/)
  assert.match(mig, /grant execute on function public\.irori_relay_send\(text, text, text, text, text, uuid, boolean, uuid, boolean\) to service_role;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /alter table|drop function|create table/i)
  assert.match(mig, /^begin;$/m)
  assert.match(mig, /^commit;$/m)
})

test('靜態：人代號位址只認 u: 加十二位十六進位、且必須等於租戶擁有者的代號', () => {
  assert.match(mig, /if p_to_node ~ '\^u:\[0-9a-f\]\{12\}\$' then/)
  assert.match(mig, /if v_alias is null or p_to_node <> v_alias then\s+return jsonb_build_object\('error', 'unknown_to_node'\);/)
  assert.ok(base.includes("p_to_agent = v_alias"), 'account_me 的扇出條件仍是 to_agent＝人代號')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }

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
    -- 租戶主節點 XISU（Irori 時代的舊名，角色節點）；本人用手機 P（名稱「Oppo 手機」）；AI 的機器 M、雲端代理 G
    insert into relay.tenants values ('${T1}', '${U1}', 'XISU', '小良');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic, created_at, name, machine) values
      ('XISU', '${T1}', 'owner', null, 'bell-XISU', now() - interval '5 day', '希緒', null),
      ('P', '${T1}', 'member', '${U1}', 'bell-P', now() - interval '3 day', 'Oppo 手機', '手機'),
      ('H', '${T1}', 'member', '${U1}', 'bell-H', now() - interval '2 day', '小良的家用機', '家用機'),
      ('M', '${T1}', 'member', null, 'bell-M', now() - interval '1 day', 'M 機', null),
      ('G', '${T1}', 'member', null, 'bell-G', now(), 'grok', '雲端代理');
    insert into relay.roster values ('M', '小文', 'claude');`)
  await db.exec(base)
  await db.exec(mig)
  const q = async (text, args) => (await db.query(text, args)).rows
  const send = async (from, fromAgent, to, toAgent, body, extra = {}) => (await q(
    `select public.irori_relay_send($1,$2,$3,$4,$5,$6,$7,$8,$9) r`,
    [from, fromAgent, to, toAgent, body, extra.replyTo ?? null, extra.expects ?? true, extra.signed ?? null, extra.person ?? false]))[0].r
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  return { db, q, send, alias }
}
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

test('實跑（pglite）：AI 回信寄給新位址 u:xxx → 送到本人（扇出給在線的 ASN）', { skip }, async () => {
  const { q, send, alias } = await setup()
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN'), ('H','H-ASN')`)
  const r = await send('M', '小文', alias, null, '收到了', { expects: false })
  assert.equal(r.fanout, 2)
  assert.deepEqual([...r.bell_topics].sort(), ['bell-H', 'bell-P'])
  const rows = await q(`select to_node, to_agent, person_user from relay.messages where body = '收到了' order by to_node`)
  assert.deepEqual(rows.map(x => [x.to_node, x.to_agent, x.person_user]), [['H', 'H-ASN', U1], ['P', 'P-ASN', U1]])
})

test('實跑（pglite）：舊寫法 XISU/u:xxx 與 節點/u:xxx 照舊送到本人', { skip }, async () => {
  const { q, send, alias } = await setup()
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN')`)
  for (const node of ['XISU', 'P', 'H']) {
    const r = await send('M', '小文', node, alias, `舊寫法-${node}`, { expects: false })
    assert.equal(r.fanout, 1, node)
    const rows = await q(`select to_node, to_agent from relay.messages where body = $1`, [`舊寫法-${node}`])
    assert.deepEqual(rows.map(x => [x.to_node, x.to_agent]), [['P', 'P-ASN']], node)
  }
})

test('實跑（pglite）：沒有在線的 ASN → 留一列給本人（原收件節點／帳號名下的節點），不讓 AI 的回信失敗', { skip }, async () => {
  const { q, send, alias } = await setup()
  const r = await send('M', '小文', alias, null, '離線時的回信', { expects: false })
  assert.equal(r.fanout, 0)
  const rows = await q(`select to_node, to_agent from relay.messages where body = '離線時的回信'`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].to_agent, alias)
  assert.equal(rows[0].to_node, 'XISU', '租戶的角色節點在就留給它（舊行為相同）')
})

test('實跑（pglite）：別人的代號、格式不對的位址 → unknown_to_node；不影響一般寄信', { skip }, async () => {
  const { send, alias } = await setup()
  assert.deepEqual(await send('M', '小文', 'u:000000000000', null, 'x'), { error: 'unknown_to_node' })
  assert.deepEqual(await send('M', '小文', 'NOPE', null, 'x'), { error: 'unknown_to_node' })
  const ok = await send('M', '小文', 'H', '某視窗', '一般信')
  assert.ok(ok.id)
  assert.ok(alias.startsWith('u:'))
})

test('實跑（pglite）：inbox 多三個選填欄位，舊欄位的值不變；本人有顯示名稱與設備名、member 沒有 sender_display', { skip }, async () => {
  const { q, send, alias } = await setup()
  // 本人從手機 P 寄給 AI（簽章有效＋as_person）
  await send('P', 'P-ASN', 'M', '小文', '手機說的', { signed: U1, person: true })
  // 別的 AI（M，名單上是 claude）與雲端代理 G 寄給另一個 AI 視窗
  await send('M', '小文', 'H', '甲', '機器信')
  await send('G', 'Grok', 'H', '甲', '雲端信')
  const own = (await q(`select public.irori_relay_inbox_agent('M','小文') r`))[0].r[0]
  assert.equal(own.sender_display, '小良')
  assert.equal(own.sender_device, 'Oppo 手機')
  assert.equal(own.sender_engine, null)
  assert.equal(own.trust, 'owner')
  assert.equal(own.from_agent, alias)
  assert.equal(own.from_node, 'XISU', 'from_node 的值照舊（#108 的擁有者節點檢視），讓舊橋的回信位址不變')
  const [m1, m2] = (await q(`select public.irori_relay_inbox_agent('H','甲') r`))[0].r
  const byAgent = Object.fromEntries([m1, m2].map(m => [m.from_agent, m]))
  assert.equal(byAgent['小文'].sender_display, null)
  assert.equal(byAgent['小文'].sender_device, 'M 機')
  assert.equal(byAgent['小文'].sender_engine, 'claude')
  assert.equal(byAgent['小文'].trust, 'member')
  assert.equal(byAgent['Grok'].sender_engine, 'cloud')
  assert.equal(byAgent['Grok'].sender_display, null)
  // 沒走 agent 版的 irori_relay_inbox 也一樣有欄位
  await send('P', 'P-ASN', 'M', null, '總機信', { signed: U1, person: true })
  const all = (await q(`select public.irori_relay_inbox('M') r`))[0].r
  assert.ok(all.every(m => 'sender_display' in m && 'sender_device' in m && 'sender_engine' in m))
})

test('實跑（pglite）：沒簽章的 owner 角色節點信沒有 sender_display（說明行不會冒充本人）', { skip }, async () => {
  const { q, send } = await setup()
  await send('XISU', '希緒', 'M', '小文', '角色節點的信')
  const m = (await q(`select public.irori_relay_inbox_agent('M','小文') r`))[0].r[0]
  assert.equal(m.trust, 'owner')
  assert.equal(m.sender_display, null)
  assert.equal(m.from_node, 'XISU')
})

test('實跑（pglite）：帳號層的名字——讀、改、預設值、不合格、別人的帳號；改了之後信頭用新名字，設備名仍是節點名稱', { skip }, async () => {
  const { q, send } = await setup()
  const name = async (n, d) => (await q('select public.asn_account_name($1,$2,$3) r', [U1, n ?? null, d ?? null]))[0].r
  assert.deepEqual(await name(), { name: '小良' }, '讀：已有名字就原樣回')
  assert.deepEqual(await name('  啟良 '), { name: '啟良' }, '改：清掉前後空白')
  assert.deepEqual(await name(), { name: '啟良' })
  for (const bad of ['', '   ', 'a\nb', 'x'.repeat(41)]) assert.deepEqual(await name(bad), { error: 'bad_request' }, JSON.stringify(bad))
  assert.deepEqual(await name(), { name: '啟良' }, '不合格的名字不會寫入')
  assert.deepEqual((await q('select public.asn_account_name($1) r', ['22222222-2222-2222-2222-222222222222']))[0].r, { error: 'not_found' })
  // 還是建租戶時的預設「朋友」→ 讀的時候用呼叫端帶的預設值（登入資料的 name 或 email 前段）寫入
  await q(`update relay.tenants set owner_name = '朋友'`)
  assert.deepEqual(await name(null, 'qiliang'), { name: 'qiliang' })
  assert.deepEqual(await name(null, '別的預設'), { name: 'qiliang' }, '已經有名字就不再被預設值覆蓋')
  // 信頭用的 sender_display 跟著帳號層名字走；sender_device 是節點名稱（設備層）
  await name('啟良')
  await send('P', 'P-ASN', 'M', '小文', '手機說的', { signed: U1, person: true })
  const m = (await q(`select public.irori_relay_inbox_agent('M','小文') r`))[0].r[0]
  assert.equal(m.sender_display, '啟良')
  assert.equal(m.sender_device, 'Oppo 手機')
  await q(`update relay.nodes set name = '手機' where id = 'P'`)
  await send('P', 'P-ASN', 'M', '小文', '改名後', { signed: U1, person: true })
  const m2 = (await q(`select public.irori_relay_inbox_agent('M','小文') r`))[0].r.find(x => x.body === '改名後')
  assert.deepEqual([m2.sender_display, m2.sender_device], ['啟良', '手機'])
})
