// 多設備對話連貫 migration（#108）：
// 1. 靜態檢查：只給 service_role、security definer＋search_path ''、新欄位全部可空、舊參數呼叫相容。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（不是專案相依，要測的人自己 `npm i --no-save @electric-sql/pglite`），
//    在記憶體內的 Postgres 套用 migration，逐條跑「以人寄出、扇出、各自 ack、AI 看到同一個人、往來記錄、附件跟著走」；沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = read('20261022020000_account_me.sql')

test('新欄位可空；函式 security definer、search_path 空、只授權 service_role', () => {
  assert.match(sql, /add column if not exists person_user uuid,/)
  assert.match(sql, /add column if not exists fanout_id uuid;/)
  assert.doesNotMatch(sql, /person_user uuid not null|fanout_id uuid not null/)
  for (const f of ['asn_person_alias(uuid)', 'asn_chat_history(uuid, text, text, text, integer)']) {
    const name = f.split('(')[0]
    assert.match(sql, new RegExp(`function public\\.${name}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path`), name)
    assert.match(sql, new RegExp(`revoke all on function public\\.${f.replace(/[()]/g, m => '\\' + m)} from public, anon, authenticated;`), name)
    assert.match(sql, new RegExp(`grant execute on function public\\.${f.replace(/[()]/g, m => '\\' + m)} to service_role;`), name)
  }
  assert.match(sql, /revoke all on function public\.irori_relay_send\(text, text, text, text, text, uuid, boolean, uuid, boolean\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.irori_relay_send\(text, text, text, text, text, uuid, boolean, uuid, boolean\) to service_role;/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('寄信：新參數有預設值（舊呼叫端不帶也能呼叫）；先拿掉舊的八參數版本', () => {
  assert.match(sql, /drop function if exists public\.irori_relay_send\(text, text, text, text, text, uuid, boolean, uuid\);/)
  assert.match(sql, /p_as_person boolean default false\)/)
  assert.match(sql, /coalesce\(p_as_person, false\) and v_signed/)
})

test('往來記錄只認帳號名下的節點、限 90 天、最多 200 則', () => {
  assert.match(sql, /if not public\.asn_user_owns_node\(p_user, p_node\) then\s+return jsonb_build_object\('error', 'forbidden'\)/)
  assert.match(sql, /interval '90 days'/)
  assert.match(sql, /least\(greatest\(coalesce\(p_limit, 100\), 1\), 200\)/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid, character_node text);
    create table relay.nodes(id text primary key, tenant_id uuid not null, status text default 'active', role text default 'member',
      owner_user uuid, bell_topic text not null, created_at timestamptz default now());
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, to_agent text,
      body text, reply_to uuid, created_at timestamptz default now(), delivered_at timestamptz, acked_at timestamptz, tenant_id uuid,
      expects_reply boolean, owner_signed boolean not null default false);
    create table relay.asn_presence(node text, window_name text, updated_at timestamptz default now(), primary key (node, window_name));
    create table relay.attachments(id uuid primary key default gen_random_uuid(), message_id uuid, room_id text, room_seq bigint, kind text, name text,
      mime text, bytes int, width int, height int, thumb text, status text default 'ready', expires_at timestamptz default now() + interval '30 days',
      removed_at timestamptz, created_at timestamptz default now(), owner_node text, tenant_id uuid, storage_path text);
    create table relay.room_members(room_id text, member text, left_at timestamptz);
    create function relay.node_tenant(p text) returns uuid language sql as $$ select tenant_id from relay.nodes where id = p $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('aaaaaaaa-0000-0000-0000-000000000001', '${U1}', null), ('aaaaaaaa-0000-0000-0000-000000000002', '${U2}', null);
    -- 帳號一：H（家，擁有者節點）、W（公司）、AI 機器 M（同租戶、非 ASN）；帳號二：X
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic, created_at) values
      ('H', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner', '${U1}', 'bell-H', now() - interval '3 day'),
      ('W', 'aaaaaaaa-0000-0000-0000-000000000001', 'member', '${U1}', 'bell-W', now() - interval '2 day'),
      ('M', 'aaaaaaaa-0000-0000-0000-000000000001', 'member', null, 'bell-M', now() - interval '1 day'),
      ('X', 'aaaaaaaa-0000-0000-0000-000000000002', 'owner', '${U2}', 'bell-X', now());`)
  await db.exec(sql)
  const q = async (text, args) => (await db.query(text, args)).rows
  const send = async (from, fromAgent, to, toAgent, body, extra = {}) => (await q(
    `select public.irori_relay_send($1,$2,$3,$4,$5,$6,$7,$8,$9) r`,
    [from, fromAgent, to, toAgent, body, extra.replyTo ?? null, extra.expects ?? true, extra.signed ?? null, extra.person ?? false]))[0].r
  return { db, q, send }
}

test('實跑（pglite）：以人寄出的條件', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, send } = await setup()
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  assert.match(alias, /^u:[0-9a-f]{12}$/)
  assert.notEqual(alias, (await q('select public.asn_person_alias($1) a', [U2]))[0].a)
  assert.ok(!alias.includes(U1.slice(0, 8)), '人代號不含使用者 id')
  assert.equal((await q('select public.asn_person_alias(null) a'))[0].a, null)

  // 簽章有效＋明說 as_person → 寄件視窗名換成人代號、記 person_user
  const a = await send('W', 'W-ASN', 'M', '小文', '你好', { signed: U1, person: true })
  let row = (await q('select from_node, from_agent, person_user, owner_signed from relay.messages where id = $1', [a.id]))[0]
  assert.deepEqual(row, { from_node: 'W', from_agent: alias, person_user: U1, owner_signed: true })
  // 沒說 as_person（舊版 ASN）→ 與以前完全一樣
  const b = await send('W', 'W-ASN', 'M', '小文', '舊版', { signed: U1 })
  row = (await q('select from_agent, person_user from relay.messages where id = $1', [b.id]))[0]
  assert.deepEqual(row, { from_agent: 'W-ASN', person_user: null })
  // 說了 as_person 但沒簽章（或簽章是別人）→ 不換、不記
  for (const signed of [null, U2]) {
    const c = await send('W', 'W-ASN', 'M', '小文', '假的', { signed, person: true })
    row = (await q('select from_agent, person_user from relay.messages where id = $1', [c.id]))[0]
    assert.deepEqual(row, { from_agent: 'W-ASN', person_user: null }, String(signed))
  }
  // 簽章的人是租戶擁有者，但寄件節點不是他名下的（例如 AI 的機器節點）→ 不能冒充人
  const spoof = await send('M', '小文', 'W', '某視窗', '冒充', { signed: U1, person: true })
  row = (await q('select from_agent, person_user from relay.messages where id = $1', [spoof.id]))[0]
  assert.deepEqual(row, { from_agent: '小文', person_user: null })
  // 收件人是自己帳號的另一個 ASN 視窗（設備互聊）→ 維持視窗名
  await q(`insert into relay.asn_presence(node, window_name) values ('H', 'H-ASN')`)
  const d = await send('W', 'W-ASN', 'H', 'H-ASN', '互聊', { signed: U1, person: true })
  row = (await q('select from_agent, person_user from relay.messages where id = $1', [d.id]))[0]
  assert.deepEqual(row, { from_agent: 'W-ASN', person_user: null })
  // 舊呼叫端（八個參數）仍可呼叫
  const e = (await q(`select public.irori_relay_send('W','W-ASN','M','小文','八參數',null,true,$1) r`, [U1]))[0].r
  assert.ok(e.id)
  // 寄給不存在的節點仍是原本的錯誤
  assert.deepEqual(await send('W', 'W-ASN', 'NOPE', null, 'x', { signed: U1, person: true }), { error: 'unknown_to_node' })
})

test('實跑（pglite）：回信扇出、各自 ack、AI 看到同一個人', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, send } = await setup()
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  await q(`insert into relay.asn_presence(node, window_name, updated_at) values ('H','H-ASN', now()), ('W','W-ASN', now()), ('W','舊視窗', now() - interval '1 hour')`)
  // 人從 H、W 各寄一封給 AI：AI 收信時 from_node 都顯示擁有者節點 H、from_agent 同一個人代號
  const m1 = await send('H', 'H-ASN', 'M', '小文', '在家說', { signed: U1, person: true })
  const m2 = await send('W', 'W-ASN', 'M', '小文', '在公司說', { signed: U1, person: true })
  const inbox = (await q(`select public.irori_relay_inbox_agent('M','小文') r`))[0].r
  assert.equal(inbox.length, 2)
  for (const m of inbox) {
    assert.equal(m.from_node, 'H')
    assert.equal(m.from_agent, alias)
    assert.equal(m.trust, 'owner')
  }
  assert.deepEqual((await q('select from_node from relay.messages where id in ($1,$2) order by from_node', [m1.id, m2.id])).map(r => r.from_node), ['H', 'W'], '資料列仍記真實的寄件節點')
  // AI 依來信回覆：to_node＝from_node（H）、to_agent＝人代號 → 扇出給兩個在線視窗，不含逾時的舊視窗
  const r = await send('M', '小文', 'H', alias, '收到', { replyTo: inbox[0].id, expects: false })
  assert.equal(r.fanout, 2)
  assert.deepEqual([...r.bell_topics].sort(), ['bell-H', 'bell-W'])
  const rows = await q(`select to_node, to_agent, fanout_id, id, person_user from relay.messages where body = '收到' order by to_node`)
  assert.deepEqual(rows.map(x => [x.to_node, x.to_agent]), [['H', 'H-ASN'], ['W', 'W-ASN']])
  assert.ok(rows.every(x => x.fanout_id === r.id && x.person_user === U1))
  assert.equal(r.id, rows.find(x => x.id === r.id).id, '回傳的 id 是群組代表（第一列）')
  // 各自收、各自 ack：H 收到並 ack，W 的那封不受影響
  const h = (await q(`select public.irori_relay_inbox_agent('H','H-ASN') r`))[0].r
  const w = (await q(`select public.irori_relay_inbox_agent('W','W-ASN') r`))[0].r
  assert.equal(h.length, 1)
  assert.equal(w.length, 1)
  assert.notEqual(h[0].id, w[0].id)
  assert.equal(h[0].fanout_id, w[0].fanout_id)
  assert.equal(h[0].from_node, 'M', '非本人寄來的信，from_node 不動')
  await q(`update relay.messages set acked_at = now() where id = $1`, [h[0].id])
  assert.equal((await q(`select public.irori_relay_inbox_agent('H','H-ASN') r`))[0].r.length, 0)
  assert.equal((await q(`select public.irori_relay_inbox_agent('W','W-ASN') r`))[0].r.length, 1, 'W 沒被 H 搶走')
  // 沒人在線：留一列給原收件節點（人打開 ASN 時從往來記錄補看）
  await q('delete from relay.asn_presence')
  const off = await send('M', '小文', 'H', alias, '離線時說', { expects: false })
  assert.equal(off.fanout, 0)
  assert.equal((await q(`select count(*)::int c from relay.messages where body = '離線時說'`))[0].c, 1)
  // 原收件節點不在了（或寫錯）→ 挑帳號名下最早的節點，不讓 AI 的回信失敗
  const gone = await send('M', '小文', 'GONE', alias, '節點沒了', { expects: false })
  assert.equal((await q(`select to_node from relay.messages where id = $1`, [gone.id]))[0].to_node, 'H')
  // 別人的人代號（別的帳號）不是扇出，照一般寄信：收件節點不在同租戶 → 原本的錯誤
  const other = (await q('select public.asn_person_alias($1) a', [U2]))[0].a
  assert.deepEqual(await send('M', '小文', 'X', other), { error: 'bad_body' })
  assert.deepEqual(await send('M', '小文', 'X', other, 'x'), { error: 'unknown_to_node' })
})

test('實跑（pglite）：頻率限制按「一則」算，不按複本算', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, send } = await setup()
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  await q(`insert into relay.asn_presence(node, window_name) values ('H','H-ASN'), ('W','W-ASN')`)
  for (let i = 0; i < 29; i++) assert.ok((await send('M', '小文', 'H', alias, `n${i}`, { expects: false })).id, String(i))
  assert.ok((await send('M', '小文', 'H', alias, 'n29', { expects: false })).id)
  assert.deepEqual(await send('M', '小文', 'H', alias, '太多', { expects: false }), { error: 'rate_limited' })
  assert.equal((await q(`select count(*)::int c from relay.messages`))[0].c, 60)
})

test('實跑（pglite）：往來記錄——兩個方向合併、扇出只算一則、只看自己帳號與該夥伴', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, send } = await setup()
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  const hist = async (user, node, pn, pa, limit) => (await q(`select public.asn_chat_history($1,$2,$3,$4,$5) r`, [user, node, pn, pa, limit ?? 100]))[0].r
  await q(`insert into relay.asn_presence(node, window_name) values ('H','H-ASN'), ('W','W-ASN')`)
  const s1 = await send('H', 'H-ASN', 'M', '小文', '在家問', { signed: U1, person: true })
  const rep = await send('M', '小文', 'H', alias, '小文回', { replyTo: s1.id, expects: false })
  const s2 = await send('W', 'W-ASN', 'M', '小文', '公司接著問', { signed: U1, person: true })
  // 另一位夥伴、舊式（沒簽章）往來都不應出現
  await send('H', 'H-ASN', 'M', '小武', '跟別人說', { signed: U1, person: true })
  await send('H', 'H-ASN', 'M', '小文', '舊版寄的', { signed: U1 })
  // 從公司（W）看：三則，由舊到新，扇出的回信只有一則
  const w = (await hist(U1, 'W', 'M', '小文')).messages
  assert.deepEqual(w.map(m => [m.dir, m.body]), [['me', '在家問'], ['them', '小文回'], ['me', '公司接著問']])
  assert.equal(w[1].id, rep.id)
  assert.equal(w[1].ids.length, 2, 'ids 含所有複本的 id（舊本機快取的收信 id 也對得上）')
  assert.equal(w[1].reply_to, s1.id)
  assert.equal(w[0].id, s1.id)
  assert.equal(w[2].id, s2.id)
  // 筆數上限與 90 天
  assert.equal((await hist(U1, 'W', 'M', '小文', 2)).messages.length, 2)
  assert.equal((await hist(U1, 'W', 'M', '小文', 2)).messages.at(-1).body, '公司接著問', '超過上限留最新的')
  await q(`update relay.messages set created_at = now() - interval '91 days' where body = '在家問'`)
  assert.equal((await hist(U1, 'W', 'M', '小文')).messages.length, 2)
  // 別人的節點／不是這個帳號的使用者：一律 forbidden；壞夥伴節點：bad_request
  assert.deepEqual(await hist(U2, 'W', 'M', '小文'), { error: 'forbidden' })
  assert.deepEqual(await hist(U1, 'X', 'M', '小文'), { error: 'forbidden' })
  assert.deepEqual(await hist(U1, 'M', 'M', '小文'), { error: 'forbidden' }, 'AI 的機器節點沒有擁有者')
  assert.deepEqual(await hist(U1, 'W', 'a/b', '小文'), { error: 'bad_request' })
  // 帳號二看不到帳號一的往來
  assert.deepEqual((await hist(U2, 'X', 'M', '小文')).messages, [])
  // 找總機（沒有視窗名）的往來
  await send('H', 'H-ASN', 'M', null, '找總機', { signed: U1, person: true })
  assert.deepEqual((await hist(U1, 'W', 'M', null)).messages.map(m => m.body), ['找總機'])
  assert.deepEqual((await hist(U1, 'W', 'M', '')).messages.map(m => m.body), ['找總機'])
})

test('實跑（pglite）：附件跟著扇出——複本查得到、帳號名下另一台下載得到、別人不行', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, send } = await setup()
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  await q(`insert into relay.asn_presence(node, window_name) values ('H','H-ASN'), ('W','W-ASN')`)
  const r = await send('M', '小文', 'H', alias, '附圖', { expects: false })
  const copies = await q(`select id, to_node from relay.messages where fanout_id = $1 order by to_node`, [r.id])
  const t = 'aaaaaaaa-0000-0000-0000-000000000001'
  const [att] = await q(`insert into relay.attachments(message_id, kind, name, mime, bytes, owner_node, tenant_id, storage_path)
    values ($1, 'image', 'a.webp', 'image/webp', 10, 'M', $2, 'p/a.webp') returning id`, [r.id, t])
  // 每個複本都查得到附件，且回傳的 message_id 是被問的那一列
  const wid = copies.find(c => c.to_node === 'W').id
  const f = (await q('select public.irori_relay_attach_for($1::uuid[], null, null) r', [[wid]]))[0].r
  assert.equal(f.length, 1)
  assert.equal(f[0].message_id, wid)
  assert.equal(f[0].id, att.id)
  // 下載權：收到複本的節點、帳號名下的節點可以；別的帳號不行
  const acc = async n => (await q('select public.irori_relay_attach_access($1,$2) r', [n, att.id]))[0].r
  assert.equal((await acc('W')).path, 'p/a.webp')
  assert.equal((await acc('H')).path, 'p/a.webp')
  assert.deepEqual(await acc('X'), { error: 'not_found' })
  // 本人寄給 AI 的附件：帳號名下另一台（沒收也沒寄）也能看
  const s = await send('H', 'H-ASN', 'M', '小文', '給你圖', { signed: U1, person: true })
  const [att2] = await q(`insert into relay.attachments(message_id, kind, name, mime, bytes, owner_node, tenant_id, storage_path)
    values ($1, 'image', 'b.webp', 'image/webp', 10, 'H', $2, 'p/b.webp') returning id`, [s.id, t])
  assert.equal((await q('select public.irori_relay_attach_access($1,$2) r', ['W', att2.id]))[0].r.path, 'p/b.webp')
  assert.deepEqual((await q('select public.irori_relay_attach_access($1,$2) r', ['X', att2.id]))[0].r, { error: 'not_found' })
})
