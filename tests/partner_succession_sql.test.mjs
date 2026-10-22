// 夥伴 ID 第二期 migration（#153）：
// 1. 靜態檢查：只給 service_role、security definer＋search_path ''、舊的五參數 asn_chat_history 先拿掉（免得重載不唯一）、
//    寄信函式沒被重寫（轉寄只在 trigger 裡）、指定接班要本人簽章的核對。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres
//    依序套用第一期與第二期 migration：改名後寄舊名改投新名、名字有人用不改投、過了轉寄期／別台不改投、
//    指定接班（沿用夥伴 ID、併 session、信上欄位改指、前任視窗還開著拒絕、沒簽章／不是你的拒絕）、跨設備接班、
//    往來記錄以帳號＋夥伴 ID 查（改名前後都拿得到、別租戶的夥伴 ID 不認）、名單帶 partner_id。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = read('20261022060000_partner_succession.sql')
const base = read('20261022000100_partner_id.sql')

test('靜態：函式 security definer、search_path 空、只授權 service_role；沒有開放給 anon／authenticated', () => {
  for (const sig of ['irori_relay_partner_succeed\\(uuid, text, text, text, text\\)', 'irori_relay_partner_list\\(uuid, text\\)',
    'asn_chat_history\\(uuid, text, text, text, integer, text\\)', 'irori_relay_list\\(uuid\\)']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${sig} from public, anon, authenticated;`), sig)
    assert.match(sql, new RegExp(`grant execute on function public\\.${sig} to service_role;`), sig)
  }
  assert.match(sql, /function public\.irori_relay_partner_succeed[\s\S]*?security definer[\s\S]*?set search_path to ''/)
  assert.match(sql, /function relay\.messages_resolve_partner\(\)[\s\S]*?security definer[\s\S]*?set search_path to ''/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(sql, /alter table relay\.partner_handovers enable row level security;/)
  assert.doesNotMatch(sql, /create policy/)
})

test('靜態：換簽章的 asn_chat_history 先拿掉舊的五參數版本；寄信與收信函式沒被重寫', () => {
  assert.match(sql, /drop function if exists public\.asn_chat_history\(uuid, text, text, text, integer\);/)
  assert.ok(sql.indexOf('drop function if exists public.asn_chat_history') < sql.indexOf('create or replace function public.asn_chat_history'))
  assert.doesNotMatch(sql, /function public\.irori_relay_send/)
  assert.doesNotMatch(sql, /function public\.irori_relay_inbox/)
  assert.match(sql, /add column if not exists forwarded_from text;/)
  assert.match(sql, /^begin;$/m)
  assert.match(sql, /^commit;$/m)
})

test('靜態：指定接班要本人簽章——簽章的人要擁有呼叫的節點與新視窗的節點，前任要同租戶，前任視窗還開著就拒絕', () => {
  const f = sql.slice(sql.indexOf('function public.irori_relay_partner_succeed'), sql.indexOf('function public.irori_relay_partner_list'))
  assert.match(f, /public\.asn_user_owns_node\(p_user, p_caller\)/)
  assert.match(f, /public\.asn_user_owns_node\(p_user, p_node\)/)
  assert.match(f, /v_p\.tenant_id is distinct from v_tenant/)
  assert.match(f, /'predecessor_live'/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, kind text, machine text,
      last_seen_at timestamptz, avatar text, avatar_updated_at timestamptz);
    create table relay.roster(node text, name text, status text, cwd_label text, engine text, detail text, seen_at timestamptz default now());
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    create table relay.messages(id uuid primary key default gen_random_uuid(), tenant_id uuid, from_node text, from_agent text, to_node text, to_agent text,
      body text, reply_to uuid, person_user uuid, fanout_id uuid, created_at timestamptz default now(), delivered_at timestamptz, acked_at timestamptz);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_person_alias(p_user uuid) returns text language sql immutable as
      $$ select case when p_user is null then null else 'u:' || substr(md5('asn-person:' || p_user::text), 1, 12) end $$;
    insert into relay.nodes(id, tenant_id, owner_user, name) values ('N1','${T1}','${U1}','家用'), ('N2','${T1}','${U1}','公司'), ('N3','${T2}','${U2}','別人');`)
  await db.exec(base.replace(/create extension if not exists pg_cron;[\s\S]*?\$\$\);\n/, ''))
  await db.exec(sql)
  const q = async (text, args) => (await db.query(text, args)).rows
  const one = async (text, args) => (await q(text, args))[0]
  const sync = async (node, ws) => (await one('select public.irori_relay_partner_sync($1,$2::jsonb) r', [node, JSON.stringify(ws)])).r
  const ids = r => Object.fromEntries(r.partners.map(p => [p.name, p.partner_id]))
  const roster = async (node, names) => {
    await db.query('delete from relay.roster where node = $1', [node])
    for (const n of names) await db.query('insert into relay.roster(node, name) values ($1,$2)', [node, n])
  }
  const mail = async (fromNode, fromAgent, toNode, toAgent, extra = {}) => (await one(
    `insert into relay.messages(tenant_id, from_node, from_agent, to_node, to_agent, body, person_user, created_at)
       values ($1,$2,$3,$4,$5,'hi',$6, coalesce($7::timestamptz, now())) returning to_agent, forwarded_from, to_partner_id, from_partner_id, id`,
    [extra.tenant ?? T1, fromNode, fromAgent, toNode, toAgent, extra.person ?? null, extra.at ?? null]))
  const succeed = async (user, caller, pred, node, name) => (await one('select public.irori_relay_partner_succeed($1,$2,$3,$4,$5) r', [user, caller, pred, node, name])).r
  return { db, q, one, sync, ids, roster, mail, succeed }
}

const S1 = 'sess-0001-aaaa', S2 = 'sess-0002-bbbb', S3 = 'sess-0003-cccc'

test('實跑（pglite）：寄給舊名字的信改投新名字；名字有人用、過了轉寄期、別台都不改投', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, sync, ids, roster, mail } = await boot()
  const A = ids(await sync('N1', [{ name: '甲', session_id: S1 }]))['甲']
  await roster('N1', ['甲'])
  // 還沒改名：照舊
  assert.deepEqual((await mail('N2', '對方', 'N1', '甲')).to_agent, '甲')
  // 同 session 改名：甲 → 乙
  await sync('N1', [{ name: '乙', session_id: S1 }])
  await roster('N1', ['乙'])
  const m = await mail('N2', '對方', 'N1', '甲')
  assert.equal(m.to_agent, '乙', '舊名字的信改投現在的名字')
  assert.equal(m.forwarded_from, '甲')
  assert.equal(m.to_partner_id, A)
  // 寫給現在名字的信不動
  const cur = await mail('N2', '對方', 'N1', '乙')
  assert.equal(cur.to_agent, '乙')
  assert.equal(cur.forwarded_from, null)
  // 別台同名的收件人不受影響
  assert.equal((await mail('N1', '對方', 'N2', '甲')).to_agent, '甲')
  // 名單裡有同名的在線視窗（後台還沒同步到夥伴）：名字有人用，不改投
  await roster('N1', ['乙', '甲'])
  const busy = await mail('N2', '對方', 'N1', '甲')
  assert.equal(busy.to_agent, '甲')
  assert.equal(busy.forwarded_from, null)
  // 新視窗拿走「甲」這個名字（新夥伴 B）：信送給 B，不轉去乙
  await roster('N1', ['乙', '甲'])
  const B = ids(await sync('N1', [{ name: '乙', session_id: S1 }, { name: '甲', session_id: S3 }]))['甲']
  assert.notEqual(B, A)
  const taken = await mail('N2', '對方', 'N1', '甲')
  assert.equal(taken.to_agent, '甲')
  assert.equal(taken.to_partner_id, B)
  assert.equal(taken.forwarded_from, null)
  // 過了轉寄期：不改投，也解析不到
  await roster('N1', ['乙'])
  await sync('N1', [{ name: '乙', session_id: S1 }])   // 甲(B) 消失但仍佔著名字；改成讓 B 讓出
  await q(`update relay.partners set current_name = null where partner_id = $1`, [B])
  await q(`update relay.partner_names set renamed_at = now() - interval '8 days'`)
  const old = await mail('N2', '對方', 'N1', '甲')
  assert.equal(old.to_agent, '甲')
  assert.equal(old.forwarded_from, null)
})

test('實跑（pglite）：指定接班——沿用夥伴 ID、併 session、信上欄位改指前任、寄給舊名的信改投新名', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, one, sync, ids, roster, mail, succeed } = await boot()
  const A = ids(await sync('N1', [{ name: '小文', session_id: S1, engine: 'claude', model: 'opus' }]))['小文']
  // 小文的視窗關了（context 滿了），同台開了新視窗「小文二號」（新 session）→ 後台先當成新夥伴
  await roster('N1', ['小文二號'])
  const B = ids(await sync('N1', [{ name: '小文二號', session_id: S2, engine: 'claude' }]))['小文二號']
  assert.notEqual(A, B)
  const toB = await mail('N2', '誰', 'N1', '小文二號')
  assert.equal(toB.to_partner_id, B)
  const fromA = await mail('N1', '小文', 'N2', '誰')
  assert.equal(fromA.from_partner_id, A)

  // 沒簽章（沒有使用者）、不是你的節點、前任不存在、格式不對
  assert.deepEqual(await succeed(null, 'N1', A, 'N1', '小文二號'), { error: 'bad_request' })
  assert.deepEqual(await succeed(U2, 'N3', A, 'N1', '小文二號'), { error: 'forbidden' })
  assert.deepEqual(await succeed(U2, 'N1', A, 'N1', '小文二號'), { error: 'forbidden' }, '簽章的人不擁有呼叫的節點')
  assert.deepEqual(await succeed(U1, 'N1', A, 'N3', '別人的視窗'), { error: 'forbidden' }, '簽章的人不擁有新視窗的節點')
  assert.deepEqual(await succeed(U1, 'N1', 'p_' + '0'.repeat(20), 'N1', '小文二號'), { error: 'not_found' })
  assert.deepEqual(await succeed(U1, 'N1', 'junk', 'N1', '小文二號'), { error: 'bad_request' })
  assert.deepEqual(await succeed(U1, 'N1', A, 'N1', '還沒被認進來'), { error: 'not_found' })
  assert.equal((await q('select count(*)::int c from relay.partners'))[0].c, 2, '失敗的請求沒有改任何東西')
  // 前任視窗還開著：拒絕
  await roster('N1', ['小文', '小文二號'])
  assert.deepEqual(await succeed(U1, 'N1', A, 'N1', '小文二號'), { error: 'predecessor_live' })
  // 前任視窗關了：成功
  await roster('N1', ['小文二號'])
  assert.deepEqual(await succeed(U1, 'N1', A, 'N1', '小文二號'), { ok: true, partner_id: A })
  // 重複送出沒有副作用
  assert.deepEqual(await succeed(U1, 'N1', A, 'N1', '小文二號'), { ok: true, partner_id: A })
  const ps = await q('select partner_id, node, current_name, current_session, engine from relay.partners')
  assert.deepEqual(ps, [{ partner_id: A, node: 'N1', current_name: '小文二號', current_session: S2, engine: 'claude' }])
  assert.deepEqual(await q('select session_id, ended_at is null as cur from relay.partner_sessions where partner_id = $1 order by session_id', [A]),
    [{ session_id: S1, cur: false }, { session_id: S2, cur: true }])
  assert.deepEqual((await q('select name from relay.partner_names where partner_id = $1', [A])).map(r => r.name), ['小文'])
  assert.equal((await one('select to_partner_id t from relay.messages where id = $1', [toB.id])).t, A, '信上的夥伴欄位改指前任')
  assert.equal((await q('select count(*)::int c from relay.partner_handovers where partner_id = $1', [A]))[0].c, 1)
  // 之後橋照舊回報名單：新視窗仍是 A；寄給「小文」的信改投「小文二號」
  assert.equal(ids(await sync('N1', [{ name: '小文二號', session_id: S2 }]))['小文二號'], A)
  const old = await mail('N2', '誰', 'N1', '小文')
  assert.equal(old.to_agent, '小文二號')
  assert.equal(old.to_partner_id, A)
  assert.equal(old.forwarded_from, '小文')
})

test('實跑（pglite）：跨設備接班——夥伴的目前節點改到新設備；別租戶的夥伴不能接', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, sync, ids, roster, succeed } = await boot()
  const A = ids(await sync('N1', [{ name: '小文', session_id: S1 }]))['小文']
  const X = ids(await sync('N3', [{ name: '外人', session_id: S3 }]))['外人']
  await roster('N1', [])
  const B = ids(await sync('N2', [{ name: '公司小文', session_id: S2 }]))['公司小文']
  // 別租戶的夥伴不能被接
  assert.deepEqual(await succeed(U1, 'N2', X, 'N2', '公司小文'), { error: 'forbidden' })
  assert.deepEqual(await succeed(U1, 'N1', A, 'N2', '公司小文'), { ok: true, partner_id: A }, '呼叫的節點與新視窗節點不同也可以，只要都是這個人的')
  assert.deepEqual(await q('select partner_id, node, current_name from relay.partners where tenant_id = $1', [T1]), [{ partner_id: A, node: 'N2', current_name: '公司小文' }])
  assert.equal((await q('select count(*)::int c from relay.partners where partner_id = $1', [B]))[0].c, 0)
  // 跨設備：前任原本的名字不記成舊名（舊節點的名字不該轉寄到新節點）
  assert.equal((await q('select count(*)::int c from relay.partner_names where partner_id = $1', [A]))[0].c, 0)
})

test('實跑（pglite）：往來記錄以帳號＋夥伴 ID 查——改名前後都拿得到；沒帶夥伴 ID 或不是同租戶的就只用名字', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { q, one, sync, ids, roster, mail } = await boot()
  const alias = (await one(`select public.asn_person_alias($1) a`, [U1])).a
  const hist = async (agent, pid) => (await one('select public.asn_chat_history($1,$2,$3,$4,$5,$6) r', [U1, 'N2', 'N1', agent, 100, pid ?? null])).r
  const A = ids(await sync('N1', [{ name: '甲', session_id: S1 }]))['甲']
  await roster('N1', ['甲'])
  await mail('N2', alias, 'N1', '甲', { person: U1, at: '2026-10-20T00:00:00Z' })           // 我 → 甲（改名前）
  await mail('N1', '甲', 'N2', alias, { person: U1, at: '2026-10-20T00:01:00Z' })           // 甲 → 我（改名前）
  await sync('N1', [{ name: '乙', session_id: S1 }])
  await roster('N1', ['乙'])
  await mail('N2', alias, 'N1', '乙', { person: U1, at: '2026-10-21T00:00:00Z' })           // 我 → 乙（改名後）
  await mail('N1', '乙', 'N2', alias, { person: U1, at: '2026-10-21T00:01:00Z' })           // 乙 → 我（改名後）
  const body = r => r.messages.length
  assert.equal(body(await hist('乙')), 2, '只用現在的名字：改名前的往來查不到（第二期之前的行為）')
  assert.equal(body(await hist('乙', A)), 4, '帶夥伴 ID：改名前後都拿得到')
  assert.deepEqual((await hist('乙', A)).messages.map(m => m.dir), ['me', 'them', 'me', 'them'])
  // 沒簽章的舊呼叫（五個參數）仍然有效
  assert.equal(body((await one('select public.asn_chat_history($1,$2,$3,$4,$5) r', [U1, 'N2', 'N1', '乙', 100])).r), 2)
  // 別租戶的夥伴 ID 不認（當沒帶）
  const X = ids(await sync('N3', [{ name: '外人', session_id: S3 }]))['外人']
  assert.equal(body(await hist('乙', X)), 2)
  // 不是這個帳號的信不會因為夥伴 ID 被撈出來
  await mail('N2', 'u:other', 'N1', '乙', { person: U2, at: '2026-10-21T01:00:00Z' })
  assert.equal(body(await hist('乙', A)), 4)
  assert.deepEqual(await hist('乙', 'junk-id'), (await hist('乙')), '格式不對的夥伴 ID 當沒帶')
  assert.deepEqual((await one('select public.asn_chat_history($1,$2,$3,$4,$5,$6) r', [U2, 'N2', 'N1', '乙', 100, A])).r, { error: 'forbidden' })
  void q
})

test('實跑（pglite）：名單 irori_relay_list 的 agents 帶 partner_id；清單 irori_relay_partner_list 只列同租戶、要簽章', { skip: PGlite ? false : '沒有安裝 @electric-sql/pglite' }, async () => {
  const { one, sync, ids, roster } = await boot()
  const A = ids(await sync('N1', [{ name: '甲', session_id: S1 }]))['甲']
  ids(await sync('N3', [{ name: '外人', session_id: S3 }]))
  await roster('N1', ['甲', '沒同步的'])
  const list = (await one('select public.irori_relay_list($1) r', [T1])).r
  const agents = list.find(n => n.id === 'N1').agents
  assert.equal(agents.find(a => a.name === '甲').partner_id, A)
  assert.equal(agents.find(a => a.name === '沒同步的').partner_id, null)
  // 清單
  await sync('N1', [{ name: '乙', session_id: S1 }])   // 改名：現在叫乙
  const pl = (await one('select public.irori_relay_partner_list($1,$2) r', [U1, 'N1'])).r.partners
  assert.deepEqual(pl.map(p => [p.partner_id, p.name, p.node, p.device, p.live]), [[A, '乙', 'N1', '家用', false]], '同租戶才列；別租戶的外人不在')
  await roster('N1', ['乙'])
  assert.equal((await one('select public.irori_relay_partner_list($1,$2) r', [U1, 'N1'])).r.partners[0].live, true)
  assert.deepEqual((await one('select public.irori_relay_partner_list($1,$2) r', [U2, 'N1'])).r, { error: 'forbidden' })
  assert.deepEqual((await one('select public.irori_relay_partner_list($1,$2) r', [null, 'N1'])).r, { error: 'forbidden' })
})
