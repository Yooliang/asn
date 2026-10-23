// 回信寄回本人 migration（20261023140000_reply_to_person.sql）：
// 1. 靜態檢查：person_view_node 不再回角色節點；asn_relay_send 保底條件齊全、本體除保底外逐字不變、只授權 service_role、不動資料。
// 2. 實跑檢查（有安裝 @electric-sql/pglite 才跑）：重現「夥伴回信寄到角色節點 XISU、沒人收」→ 套用後「扇出到本人各 ASN 視窗」；
//    不誤傷：指定了別的視窗名、角色節點上有在線 ASN、寄件人是角色節點自己、別的租戶。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261022020000_account_me.sql')
const display = read('20261022090000_owner_sender_display.sql')
const mig = read('20261023140000_reply_to_person.sql')

const fn = (src, name) => {
  const m = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`, 'i').exec(src)
  assert.ok(m, `${name} 找不到`)
  return m[0]
}

test('靜態：person_view_node 只回真實寄件節點；整檔在交易內；不刪不改資料；只授權 service_role', () => {
  assert.match(mig, /create or replace function relay\.person_view_node\([^)]*\)\s+returns text[\s\S]*?select p_from_node;/)
  const pvn = /create or replace function relay\.person_view_node[\s\S]*?\$\$;/.exec(mig)[0]
  assert.doesNotMatch(pvn, /relay\.nodes|owner/, 'person_view_node 不能再去找角色節點')
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
  const code = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop (function|table|column)|delete from|truncate|alter table/i)
  assert.match(mig, /grant execute on function public\.asn_relay_send\(text, text, text, text, text, uuid, boolean, uuid, boolean\) to service_role;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('靜態：asn_relay_send 除了保底區塊與改名，與 20261022090000 的本體逐字相同', () => {
  const now = fn(mig, 'asn_relay_send')
  const before = fn(display, 'irori_relay_send').replace('public.irori_relay_send', 'public.asn_relay_send')
  const tail = '    p_to_agent := v_alias;\n  end if;\n'
  const guardStart = now.indexOf('\n  -- 保底（角色節點不再當本人的信箱）')
  const guardEnd = now.indexOf(tail, guardStart) + tail.length
  assert.ok(guardStart > 0 && guardEnd > guardStart, '找不到保底區塊')
  assert.equal(now.slice(0, guardStart) + now.slice(guardEnd), before, '保底以外有差異')
  const g = now.slice(guardStart, guardEnd)
  for (const must of ["p_to_agent is null or p_to_agent = ''", 'p_to_agent = v_alias', 'v_to is distinct from p_from_node',
    "rn.role = 'owner'", 'character_node', 'rn.tenant_id = v_tenant', 'relay.asn_presence', "interval '3 minutes'"]) assert.ok(g.includes(must), must)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'

// patched=false：套到 20261022090000 為止（再把函式改名成現在的 asn_relay_send），重現修前的行為
async function setup({ patched }) {
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
    -- 租戶主節點 XISU（Irori 時代的舊名，角色節點）；本人用手機 P（名稱「Oppo 手機」）與家用機 H；AI 的機器 M、雲端代理 G
    insert into relay.tenants values ('${T1}', '${U1}', 'XISU', '小良');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic, created_at, name, machine) values
      ('XISU', '${T1}', 'owner', null, 'bell-XISU', now() - interval '5 day', '希緒', null),
      ('P', '${T1}', 'member', '${U1}', 'bell-P', now() - interval '3 day', 'Oppo 手機', '手機'),
      ('H', '${T1}', 'member', '${U1}', 'bell-H', now() - interval '2 day', '小良的家用機', '家用機'),
      ('M', '${T1}', 'member', null, 'bell-M', now() - interval '1 day', 'M 機', null),
      ('G', '${T1}', 'member', null, 'bell-G', now(), 'grok', '雲端代理');
    insert into relay.roster values ('M', 'PCS', 'claude');`)
  await db.exec(base)
  await db.exec(display)
  await db.exec('alter function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) rename to asn_relay_send')
  if (patched) await db.exec(mig)
  const q = async (text, args) => (await db.query(text, args)).rows
  const send = async (from, fromAgent, to, toAgent, body, extra = {}) => (await q(
    `select public.asn_relay_send($1,$2,$3,$4,$5,$6,$7,$8,$9) r`,
    [from, fromAgent, to, toAgent, body, extra.replyTo ?? null, extra.expects ?? true, extra.signed ?? null, extra.person ?? false]))[0].r
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  return { db, q, send, alias }
}

test('實跑（修前）：夥伴回信寄到角色節點 XISU、沒指定視窗 → 停在 XISU，沒有扇出（重現）', { skip }, async () => {
  const { q, send } = await setup({ patched: false })
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN'), ('H','H-ASN')`)
  const r = await send('M', 'PCS', 'XISU', null, '回信', { expects: false })
  assert.equal(r.fanout, undefined)
  const rows = await q(`select to_node, to_agent, fanout_id from relay.messages where body = '回信'`)
  assert.deepEqual(rows.map(x => [x.to_node, x.to_agent, x.fanout_id]), [['XISU', null, null]])
})

test('實跑（修後）：同樣的回信 → 扇出給本人各在線 ASN 視窗', { skip }, async () => {
  const { q, send } = await setup({ patched: true })
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN'), ('H','H-ASN')`)
  for (const [i, agent] of [null, ''].entries()) {
    const r = await send('M', 'PCS', 'XISU', agent, `回信${i}`, { expects: false })
    assert.equal(r.fanout, 2, `agent=${JSON.stringify(agent)}`)
    const rows = await q(`select to_node, to_agent, person_user from relay.messages where body = $1 order by to_node`, [`回信${i}`])
    assert.deepEqual(rows.map(x => [x.to_node, x.to_agent, x.person_user]), [['H', 'H-ASN', U1], ['P', 'P-ASN', U1]])
  }
})

test('實跑（修後）：收信端看到的 from_node 是真實設備、不是 XISU；照它回信（to_node=from_node、to_agent=from_agent）也扇出到本人', { skip }, async () => {
  const { q, send, alias } = await setup({ patched: true })
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN'), ('H','H-ASN')`)
  const sent = await send('H', 'H-ASN', 'M', 'PCS', '請幫我看', { signed: U1, person: true })
  const inbox = (await q(`select public.irori_relay_inbox('M') r`))[0].r
  const mail = inbox.find(m => m.id === sent.id)
  assert.equal(mail.from_node, 'H')
  assert.equal(mail.from_agent, alias)
  assert.ok(!JSON.stringify(inbox).includes('XISU'))
  const r = await send('M', 'PCS', mail.from_node, mail.from_agent, '好了', { replyTo: mail.id, expects: false })
  assert.equal(r.fanout, 2)
  // 只寫設備節點代號、不寫視窗：H 有在線 ASN，是真的設備，不被保底改寫
  const r2 = await send('M', 'PCS', 'H', null, '只寫節點', { expects: false })
  assert.equal(r2.fanout, undefined)
  const row = (await q(`select to_node, to_agent from relay.messages where body = '只寫節點'`))[0]
  assert.deepEqual([row.to_node, row.to_agent], ['H', null])
})

test('實跑（修後）：不誤傷——指定別的視窗名、角色節點上有在線 ASN、寄件人是角色節點自己、別的租戶', { skip }, async () => {
  const { q, send } = await setup({ patched: true })
  await send('M', 'PCS', 'XISU', '希緒視窗', '指定視窗', { expects: false })
  assert.deepEqual((await q(`select to_node, to_agent from relay.messages where body = '指定視窗'`))[0], { to_node: 'XISU', to_agent: '希緒視窗' })
  await q(`insert into relay.asn_presence(node, window_name) values ('XISU','X-ASN')`)
  await send('M', 'PCS', 'XISU', null, '有人在線', { expects: false })
  assert.deepEqual((await q(`select to_node, to_agent from relay.messages where body = '有人在線'`))[0], { to_node: 'XISU', to_agent: null })
  await q(`delete from relay.asn_presence`)
  await send('XISU', '希緒', 'XISU', '自己的視窗', '自己', { expects: false })
  assert.equal((await q(`select to_agent from relay.messages where body = '自己'`))[0].to_agent, '自己的視窗')
  await q(`insert into relay.tenants values ('${T2}', '22222222-2222-2222-2222-222222222222', null, '別人')`)
  await q(`insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic, name) values ('OTHER', '${T2}', 'owner', null, 'bell-OTHER', '他人')`)
  assert.deepEqual(await send('M', 'PCS', 'OTHER', null, '跨租戶'), { error: 'unknown_to_node' })
})

test('實跑（修後）：可重跑；人代號寄信與一般寄信不受影響', { skip }, async () => {
  const { db, q, send, alias } = await setup({ patched: true })
  await db.exec(mig)
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN')`)
  assert.equal((await send('M', 'PCS', alias, null, '位址', { expects: false })).fanout, 1)
  const ok = await send('M', 'PCS', 'H', '某視窗', '一般信')
  assert.ok(ok.id)
})

test('實跑（pglite）：一次性補送 SQL——只動卡在角色節點的未讀信，補扇出給本人並標已 ack；其他信不動；再跑一次不重送', { skip }, async () => {
  const { db, q, send } = await setup({ patched: false })
  const oneoff = fs.readFileSync(new URL('../supabase/oneoff/20261023_backfill_reply_to_person.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  // 修前寄出：卡在 XISU（沒指定視窗）；另有指定視窗的、已 ack 的、八天前的、寄給一般設備的
  await send('M', 'PCS', 'XISU', null, '卡住-1', { expects: false })
  await send('M', 'PCS', 'XISU', '希緒視窗', '指定視窗', { expects: false })
  await send('M', 'PCS', 'H', null, '一般設備', { expects: false })
  await q(`insert into relay.messages(from_node, to_node, body, tenant_id, created_at) values ('M','XISU','太舊','${T1}', now() - interval '8 days')`)
  await q(`insert into relay.messages(from_node, to_node, body, tenant_id, acked_at) values ('M','XISU','已讀','${T1}', now())`)
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN'), ('H','H-ASN')`)
  await db.exec(oneoff)
  const rows = await q(`select body, to_node, to_agent, acked_at is not null as acked from relay.messages order by body, to_node`)
  const by = b => rows.filter(r => r.body === b).map(r => [r.to_node, r.to_agent, r.acked])
  assert.deepEqual(by('卡住-1'), [['H', 'H-ASN', false], ['P', 'P-ASN', false], ['XISU', null, true]])
  assert.deepEqual(by('指定視窗'), [['XISU', '希緒視窗', false]])
  assert.deepEqual(by('一般設備'), [['H', null, false]])
  assert.deepEqual(by('太舊'), [['XISU', null, false]])
  assert.deepEqual(by('已讀'), [['XISU', null, true]])
  const n = (await q('select count(*) n from relay.messages'))[0].n
  await db.exec(oneoff)
  assert.equal((await q('select count(*) n from relay.messages'))[0].n, n, '第二次不重送')
})
