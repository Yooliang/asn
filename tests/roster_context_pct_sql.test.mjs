// 視窗名單的 context_pct（20261023030000_roster_context_pct.sql）：
// 1. 靜態檢查：加可空欄位、roster 存它、list 的在線與離線兩段都帶它，授權與權限檢查保留。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（`npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres 套用本 migration，
//    驗：合格數字存進去並四捨五入；壞值當沒帶、不拒絕整份名單；舊機器橋不送＝null；list 帶出；沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const mig = fs.readFileSync(new URL('../supabase/migrations/20261023030000_roster_context_pct.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：加可空欄位、roster 存 context_pct、list 兩段都帶、舊欄位與授權保留', () => {
  assert.match(mig, /alter table relay\.roster add column if not exists context_pct smallint;/)
  assert.match(mig, /insert into relay\.roster \(node, name, status, cwd_label, engine, detail, context_pct\)/)
  assert.equal(mig.split("'detail', r.detail, 'context_pct', r.context_pct,").length - 1, 2, 'agents 與 offline_agents 都要帶')
  assert.match(mig, /\(can_invite or can_roster\)/)
  assert.match(mig, /'archived', exists/)
  assert.match(mig, /relay\.asn_presence p/)
  assert.match(mig, /grant execute on function public\.irori_relay_list\(uuid\) to service_role;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'

test('實跑（pglite）：context_pct 存取、四捨五入、壞值當沒帶、舊報法不壞、list 帶出', { skip }, async () => {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', can_invite boolean default true, can_roster boolean default true,
      name text, kind text, machine text, avatar text, avatar_updated_at timestamptz, last_seen_at timestamptz default now());
    create table relay.roster(node text, name text, status text, cwd_label text, detail text, engine text, seen_at timestamptz default now(), primary key (node, name));
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    create table relay.partners(node text, current_name text, partner_id text);
    create table relay.partner_archives(tenant_id uuid, key text);
    insert into relay.nodes(id, tenant_id, name) values ('H', '${T1}', '家用機');`)
  await db.exec(mig)
  const roster = async agents => (await db.query('select public.irori_relay_roster($1, $2::jsonb) r', ['H', JSON.stringify(agents)])).rows[0].r
  const list = async () => (await db.query('select public.irori_relay_list($1) r', [T1])).rows[0].r[0]
  const r = await roster([
    { name: 'a', status: 'busy', context_pct: 85 },
    { name: 'b', status: 'busy', context_pct: 92.6 },
    { name: 'c', context_pct: -1 },
    { name: 'd', context_pct: 101 },
    { name: 'e', context_pct: '80' },
    { name: 'f' },
    { name: 'g', context_pct: 0 },
    { name: 'h', context_pct: null },
  ])
  assert.deepEqual(r, { count: 8 }, '壞值不拒絕整份名單')
  const m = await list()
  const by = Object.fromEntries(m.agents.map(a => [a.name, a.context_pct]))
  assert.deepEqual(by, { a: 85, b: 93, c: null, d: null, e: null, f: null, g: 0, h: null })
  assert.equal(m.agents.find(a => a.name === 'a').detail, null, '舊欄位照舊')
  // 離線的那段也帶（10 分鐘前回報過）
  await db.exec(`update relay.roster set seen_at = now() - interval '10 minutes' where name = 'a'`)
  const off = (await list()).offline_agents.find(a => a.name === 'a')
  assert.equal(off.context_pct, 85); assert.equal(off.status, 'offline')
})
