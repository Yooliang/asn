// 封存夥伴 migration（20261023010000_partner_archive.sql）：
// 1. 靜態檢查：只給 service_role、security definer＋search_path ''、RLS 開且沒有 policy、本人簽章與兩端擁有關係、寄信函式沒被重寫。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（`npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres 先套用夥伴 ID migration 再套用這支：
//    封存／取消封存（簽章、擁有關係、同租戶、保護名單、夥伴 ID 與「節點＋名字」兩種鍵）、名單帶 archived、
//    自動解除（離線封存後重新回報、寄信來；在線封存時重新回報不解除）。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = read('20261023010000_partner_archive.sql')
const base = read('20261022000100_partner_id.sql')

test('靜態：資料表開 RLS 且不建 policy；函式 security definer、search_path 空、只授權 service_role', () => {
  assert.match(sql, /alter table relay\.partner_archives enable row level security;/)
  assert.match(sql, /revoke all on relay\.partner_archives from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /create policy/)
  for (const sig of ['public\\.irori_relay_partner_archive\\(text, uuid, text, text, text, boolean\\)', 'public\\.irori_relay_list\\(uuid\\)', 'public\\.irori_relay_partner_sync\\(text, jsonb\\)']) {
    assert.match(sql, new RegExp(`revoke all on function ${sig} from public, anon, authenticated;`), sig)
    assert.match(sql, new RegExp(`grant execute on function ${sig} to service_role;`), sig)
  }
  assert.match(sql, /revoke all on function public\.irori_relay_partner_sync_core\(text, jsonb\) from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.equal((sql.match(/security definer\n\s*set search_path to ''/g) ?? []).length, 4)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
})

test('靜態：下令要本人簽章（擁有呼叫節點與目標節點、同租戶）；寄信函式沒被重寫，觸發器在寫入後且吞掉錯誤', () => {
  const f = sql.slice(sql.indexOf('function public.irori_relay_partner_archive('), sql.indexOf('-- 名單：'))
  assert.match(f, /asn_user_owns_node\(p_signed_user, p_actor\)/)
  assert.match(f, /asn_user_owns_node\(p_signed_user, p_node\)/)
  assert.match(f, /tenant_id is not distinct from v_t/)
  assert.doesNotMatch(f, /role = 'owner'/)
  assert.doesNotMatch(sql, /function public\.irori_relay_send|function public\.irori_relay_inbox|function relay\.messages_resolve_partner/)
  assert.match(sql, /create trigger messages_unarchive_sender after insert on relay\.messages/)
  const t = sql.slice(sql.indexOf('function relay.messages_unarchive_sender'))
  assert.match(t, /exception when others then\s+null;/)
})

test('靜態：名單函式除了多帶 archived 之外，與上一版（線上定義）逐字相同；同步函式本體不動，只改名後包一層，改名可重跑', () => {
  const body = (t, name) => { const s = t.indexOf('$function$', t.indexOf(`function public.${name}(`)); return t.slice(s, t.indexOf('$function$', s + 5) + 10).split('\n').map(l => l.trimEnd()).join('\n') }
  const prev = body(read('20261022110000_list_offline_members.sql'), 'irori_relay_list')
  const mine = body(sql, 'irori_relay_list')
  const stripped = mine.replace(/,\n\s*'archived', exists \(select 1 from relay\.partner_archives a where a\.tenant_id is not distinct from p_tenant\n\s*and a\.key = coalesce\(\(select p\.partner_id from relay\.partners p where p\.node = n\.id and p\.current_name = r\.name\), 'n:' \|\| n\.id \|\| '\/' \|\| r\.name\)\)/g, '')
  assert.equal((mine.match(/'archived', exists/g) ?? []).length, 2, 'agents 與 offline_agents 各一個')
  assert.equal(stripped, prev, '拿掉 archived 後與上一版相同')
  assert.match(sql, /do \$\$[\s\S]*?if not exists \(select 1 from pg_proc[\s\S]*?irori_relay_partner_sync_core[\s\S]*?rename to irori_relay_partner_sync_core;[\s\S]*?\$\$;/, '改名先檢查 _core 是否已存在')
  assert.doesNotMatch(sql, /create or replace function public\.irori_relay_partner_sync_core/, '不重寫同步本體')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, kind text, machine text,
      avatar text, avatar_updated_at timestamptz, last_seen_at timestamptz default now());
    create table relay.roster(node text, name text, status text, cwd_label text, detail text, engine text, seen_at timestamptz default now(), primary key (node, name));
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, to_agent text, body text, forwarded_from text);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    insert into relay.nodes(id, tenant_id, owner_user, name) values
      ('P','${T1}','${U1}','手機'), ('H','${T1}','${U1}','家用機'), ('Y','${T1}','${U2}','同租戶別人的'), ('X','${T2}','${U2}','別租戶');`)
  await db.exec(base.replace(/create extension if not exists pg_cron;[\s\S]*?\$\$\);\n/, ''))
  await db.exec(sql)
  const q = async (t, a) => (await db.query(t, a)).rows
  const archive = async (o = {}) => (await q('select public.irori_relay_partner_archive($1,$2,$3,$4,$5,$6) r',
    [o.actor ?? 'P', o.user === undefined ? U1 : o.user, o.node ?? 'H', o.name ?? null, o.pid ?? null, o.archived ?? true]))[0].r
  const sync = async (node, ws) => (await q('select public.irori_relay_partner_sync($1,$2::jsonb) r', [node, JSON.stringify(ws)]))[0].r
  const list = async tenant => (await q('select public.irori_relay_list($1) r', [tenant]))[0].r
  const flags = async () => {
    const out = {}
    for (const m of await list(T1)) for (const a of [...m.agents, ...m.offline_agents]) out[`${m.id}/${a.name}`] = a.archived
    return out
  }
  return { db, q, archive, sync, list, flags }
}

test('實跑（pglite）：封存與取消——簽章、擁有關係、同租戶、保護名單、兩種鍵', { skip }, async () => {
  const { q, archive, sync, flags, db } = await boot()
  await sync('H', [{ name: '小文', session_id: 'sess-0001-aaaa' }, { name: '小武', session_id: 'sess-0002-bbbb' }])
  const pid = (await q(`select partner_id from relay.partners where current_name = '小文'`))[0].partner_id
  await db.exec(`insert into relay.roster(node, name, engine) values ('H','小文','claude'), ('H','小武','claude'), ('H','H-ASN','asn'), ('H','家用收發室',null), ('H','沒夥伴','claude'), ('Y','他的','claude'), ('X','別人','claude');
    insert into relay.roster(node, name, engine, seen_at) values ('H','小舊','claude', now() - interval '10 minutes')`)
  assert.equal((await archive({ pid, user: null })).error, 'forbidden', '沒簽章')
  assert.equal((await archive({ pid, user: U2 })).error, 'forbidden', '簽章的人不擁有呼叫節點')
  assert.equal((await archive({ pid, node: 'Y' })).error, 'not_found', '同租戶但目標節點不是簽章者的')
  assert.equal((await archive({ name: '他的', node: 'Y' })).error, 'not_found', '同租戶但目標節點不是簽章者的（以名字封存）')
  assert.equal((await archive({ name: '別人', node: 'X' })).error, 'not_found', '別租戶')
  assert.equal((await archive({ pid, node: 'X' })).error, 'not_found', '別租戶')
  assert.equal((await archive({ pid: 'p_00000000000000000000' })).error, 'not_found', '沒有這位夥伴')
  assert.equal((await archive({ pid: 'bad' })).error, 'bad_request')
  assert.equal((await archive({ name: null })).error, 'bad_request')
  assert.equal((await archive({ name: 'H-ASN' })).error, 'protected')
  assert.equal((await archive({ name: '家用收發室' })).error, 'protected')
  assert.equal((await archive({ name: '不存在' })).error, 'not_found', '沒有夥伴 ID 時名字要在名單上')
  assert.deepEqual(await archive({ pid }), { ok: true, archived: true })
  assert.equal((await q('select count(*)::int c from relay.partner_archives'))[0].c, 1)
  assert.deepEqual(await archive({ pid }), { ok: true, archived: true }, '重複封存冪等')
  assert.equal((await q('select count(*)::int c from relay.partner_archives'))[0].c, 1)
  assert.deepEqual(await archive({ name: '沒夥伴' }), { ok: true, archived: true }, '退而用節點＋名字')
  assert.deepEqual((await q('select key from relay.partner_archives')).map(r => r.key).sort(), ['n:H/沒夥伴', pid].sort())
  const f = await flags()
  assert.deepEqual([f['H/小文'], f['H/小武'], f['H/沒夥伴'], f['H/小舊']], [true, false, true, false], '名單帶旗標，不濾掉')
  assert.deepEqual(await archive({ pid, archived: false }), { ok: true, archived: false })
  assert.equal((await flags())['H/小文'], false)
  assert.equal((await q('select count(*)::int c from relay.partner_archives'))[0].c, 1)
})

test('實跑（pglite）：封存是帳號層，別租戶的名單不受影響', { skip }, async () => {
  const { archive, sync, db, list } = await boot()
  await sync('H', [{ name: '小文', session_id: 'sess-0001-aaaa' }])
  await db.exec(`insert into relay.roster(node, name, engine) values ('H','小文','claude'), ('X','小文','claude')`)
  await archive({ name: '小文' })
  assert.equal((await list(T1)).find(m => m.id === 'H').agents[0].archived, true)
  assert.equal((await list(T2)).find(m => m.id === 'X').agents[0].archived, false, '別租戶同名也不受影響')
})

test('實跑（pglite）：自動解除——離線封存後重新回報解除；在線封存時回報不解除；寄信來一律解除', { skip }, async () => {
  const { q, archive, sync, db, flags } = await boot()
  await sync('H', [{ name: '離線', session_id: 'sess-0001-aaaa' }, { name: '在線', session_id: 'sess-0002-bbbb' }, { name: '寄信', session_id: 'sess-0003-cccc' }])
  await db.exec(`insert into relay.roster(node, name, engine) values ('H','在線','claude'), ('H','寄信','claude'), ('H','無IDa','claude');
    insert into relay.roster(node, name, engine, seen_at) values ('H','離線','claude', now() - interval '10 minutes')`)
  const pid = async n => (await q(`select partner_id from relay.partners where current_name = $1`, [n]))[0].partner_id
  await archive({ pid: await pid('離線') }); await archive({ pid: await pid('在線') }); await archive({ pid: await pid('寄信') })
  assert.deepEqual((await q('select name, was_offline from relay.partner_archives')).map(r => `${r.name}:${r.was_offline}`).sort(), ['寄信:false', '在線:false', '離線:true'].sort())
  // 回報名單沒有「離線」：不解除；在線封存的回報了也不解除
  await sync('H', [{ name: '在線', session_id: 'sess-0002-bbbb' }])
  assert.equal((await q('select count(*)::int c from relay.partner_archives'))[0].c, 3)
  // 「離線」重新回報：解除；其他不動
  const r = await sync('H', [{ name: '離線', session_id: 'sess-0001-aaaa' }, { name: '在線', session_id: 'sess-0002-bbbb' }])
  assert.equal(r.partners.length, 2, '同步的回傳不變')
  assert.deepEqual((await q('select name from relay.partner_archives')).map(r => r.name).sort(), ['在線', '寄信'].sort())
  // 寄信來：不論封存時在不在線都解除；寄信本身的欄位照舊
  await db.exec(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body) values ('H','寄信','P','小良','hi')`)
  assert.deepEqual((await q('select name from relay.partner_archives')).map(r => r.name), ['在線'])
  assert.equal((await q(`select from_partner_id from relay.messages`))[0].from_partner_id, await pid('寄信'), '原本的寄信解析照舊')
  // 收的信（對方是收件人）不算「它寄信來」
  await db.exec(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body) values ('P','小良','H','在線','hi')`)
  assert.deepEqual((await q('select name from relay.partner_archives')).map(r => r.name), ['在線'])
  // 節點＋名字的鍵：寄信來也會解除
  await archive({ name: '無IDa' })
  await db.exec(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body) values ('H','無IDa','P','小良','hi')`)
  assert.deepEqual((await q('select name from relay.partner_archives')).map(r => r.name), ['在線'])
  assert.equal((await flags())['H/寄信'], false)
})

test('實跑（pglite）：migration 可以安全重跑——同步函式仍是外層、_core 仍是原本那支，封存照常', { skip }, async () => {
  const { db, q, archive, sync } = await boot()
  await db.exec(sql)
  await db.exec(sql)
  const names = (await q(`select proname from pg_proc where proname like 'irori_relay_partner_sync%' order by 1`)).map(r => r.proname)
  assert.deepEqual(names, ['irori_relay_partner_sync', 'irori_relay_partner_sync_core'])
  const r = await sync('H', [{ name: '小文', session_id: 'sess-0001-aaaa' }])
  assert.equal(r.partners.length, 1)
  assert.deepEqual(await archive({ pid: r.partners[0].partner_id }), { ok: true, archived: true })
  assert.equal((await q('select count(*)::int c from pg_trigger where tgname = $1', ['messages_unarchive_sender']))[0].c, 1)
})

test('實跑（pglite）：解除的觸發器壞掉也不影響寄信', { skip }, async () => {
  const { db, q } = await boot()
  await db.exec(`drop table relay.partner_archives`)
  await db.exec(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body) values ('H','小文','P','小良','hi')`)
  assert.equal((await q('select count(*)::int c from relay.messages'))[0].c, 1)
})
