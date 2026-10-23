// 封存後仍留在名單的修正（20261023130000_archive_fix.sql）：
// 1. 靜態檢查：只改 asn_relay_list、只授權 service_role、拿掉新增部分後與上一版（20261023090000）逐字相同。
// 2. 實跑（有安裝 @electric-sql/pglite 時）：重現「夥伴已不在名單、封存鍵是夥伴 ID」——名單成員帶 archived_keys；
//    成員的 archived 旗標夥伴 ID 與 n:節點/名字 兩種鍵都能命中；別的租戶／別的節點的封存不外洩。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('20261023130000_archive_fix.sql')
const prevSql = read('20261023090000_mod_status.sql')

test('靜態：只重寫 asn_relay_list，只授權 service_role，沒有新增舊名函式', () => {
  assert.equal((mig.match(/create or replace function/g) ?? []).length, 1)
  assert.match(mig, /create or replace function public\.asn_relay_list\(p_tenant uuid\)/)
  assert.match(mig, /revoke all on function public\.asn_relay_list\(uuid\) from public, anon, authenticated;/)
  assert.match(mig, /grant execute on function public\.asn_relay_list\(uuid\) to service_role;/)
  assert.doesNotMatch(mig, /irori_relay_|grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
})

test('靜態：與上一版定義相比只多 archived_keys 與兩種鍵的比對', () => {
  const body = t => { const s = t.indexOf('$function$', t.indexOf('function public.asn_relay_list(')); return t.slice(s, t.indexOf('$function$', s + 5) + 10).split('\n').map(l => l.trimEnd()).join('\n') }
  const mine = body(mig)
  const back = mine
    .replace(/    'archived_keys', coalesce\(\(select jsonb_agg\(a\.key order by a\.key\) from relay\.partner_archives a\n\s+where a\.tenant_id is not distinct from p_tenant and a\.node = n\.id\), '\[\]'::jsonb\),\n/, '')
    .replace(/\(a\.key = 'n:' \|\| n\.id \|\| '\/' \|\| r\.name\n\s+or a\.key = \(select p\.partner_id from relay\.partners p where p\.node = n\.id and p\.current_name = r\.name\)\)/g,
      "a.key = coalesce((select p.partner_id from relay.partners p where p.node = n.id and p.current_name = r.name), 'n:' || n.id || '/' || r.name)")
  assert.equal(back, body(prevSql))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const PID = 'p_fdddfe7beb8947ba8643'
const PID2 = 'p_0123456789abcdef0123'

async function setup(m) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', can_invite boolean default true, can_roster boolean default true,
      name text, kind text, machine text, avatar text, avatar_updated_at timestamptz, last_seen_at timestamptz default now());
    create table relay.roster(node text, name text, status text, cwd_label text, detail text, engine text, context_pct smallint, seen_at timestamptz default now(), primary key (node, name));
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    create table relay.partners(node text, current_name text, partner_id text);
    create table relay.partner_archives(tenant_id uuid, key text, node text, name text);
    insert into relay.nodes(id, tenant_id, name) values ('H', '${T1}', '家用機'), ('W', '${T1}', '工作機'), ('X', '${T2}', '別租戶');
    insert into relay.partners values ('H', 'asn', '${PID}'), ('H', '小文', '${PID2}');`)
  await db.exec(prevSql)
  if (m) await db.exec(m)
  return db
}
const list = async (db, t = T1) => (await db.query('select public.asn_relay_list($1) r', [t])).rows[0].r

test('實跑（pglite）：重現——夥伴不在名單，舊版沒有任何地方標它封存；新版成員帶 archived_keys', { skip }, async () => {
  const seed = `insert into relay.partner_archives values ('${T1}', '${PID}', 'H', 'asn');
    insert into relay.partner_archives values ('${T1}', 'n:W/舊人', 'W', '舊人');
    insert into relay.partner_archives values ('${T2}', 'n:X/別租戶的', 'X', '別租戶的');`
  const before = await setup(); await before.exec(seed)
  const old = (await list(before)).find(n => n.id === 'H')
  assert.equal(old.archived_keys, undefined, '舊版沒有這個鍵')
  assert.deepEqual([...old.agents, ...old.offline_agents], [], '舊版名單裡根本沒有它——用戶端無從得知它已封存')
  const db = await setup(mig); await db.exec(seed)
  const byId = Object.fromEntries((await list(db)).map(n => [n.id, n.archived_keys]))
  assert.deepEqual(byId, { H: [PID], W: ['n:W/舊人'] }, '只帶同租戶、該節點的鍵')
  assert.deepEqual(Object.keys(Object.fromEntries((await list(db, T2)).map(n => [n.id, 1]))), ['X'])
  assert.deepEqual((await list(db, T2))[0].archived_keys, ['n:X/別租戶的'])
  const none = await setup(mig)
  assert.deepEqual((await list(none)).map(n => n.archived_keys), [[], []], '沒有封存＝空陣列')
})

test('實跑（pglite）：成員的 archived 旗標——夥伴 ID 鍵與 n: 鍵都命中；沒封存的不誤標', { skip }, async () => {
  const db = await setup(mig)
  await db.exec(`insert into relay.roster(node, name, status) values ('H', 'asn', 'idle'), ('H', '小文', 'idle'), ('H', '路人', 'idle');
    insert into relay.partner_archives values ('${T1}', '${PID}', 'H', 'asn');
    insert into relay.partner_archives values ('${T1}', 'n:H/小文', 'H', '小文');`)
  await db.exec(`update relay.roster set seen_at = now() - interval '1 day' where name = '路人'`)
  const h = (await list(db)).find(n => n.id === 'H')
  const flags = Object.fromEntries([...h.agents, ...h.offline_agents].map(a => [a.name, a.archived]))
  assert.deepEqual(flags, { asn: true, 小文: true, 路人: false }, '小文有夥伴 ID，但封存記的是 n: 鍵，舊版會漏')
})
