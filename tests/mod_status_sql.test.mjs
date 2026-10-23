// Claude 外掛狀態回報（20261023090000_mod_status.sql）：
// 1. 靜態檢查：新增可空欄位、新函式只授權 service_role、函式名用 asn_relay_ 前綴、roster／list 保留原有檢查。
// 2. 實跑檢查（有安裝 @electric-sql/pglite 時）：set_claude_mod 驗格式與只動自己節點；roster 存 mod_loaded（只收布林）；list 帶出兩處；沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const mig = fs.readFileSync(new URL('../supabase/migrations/20261023090000_mod_status.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：加可空欄位、新函式 asn_relay_ 前綴且只授權 service_role、list 兩段都帶 mod_loaded、舊檢查保留', () => {
  assert.match(mig, /alter table relay\.nodes add column if not exists claude_mod jsonb;/)
  assert.match(mig, /alter table relay\.nodes add column if not exists claude_mod_at timestamptz;/)
  assert.match(mig, /alter table relay\.roster add column if not exists mod_loaded boolean;/)
  assert.match(mig, /grant execute on function public\.asn_relay_set_claude_mod\(text, jsonb\) to service_role;/)
  assert.doesNotMatch(mig, /create or replace function public\.irori_relay_/i, '不新增舊名函式')
  assert.equal(mig.split("'context_pct', r.context_pct, 'mod_loaded', r.mod_loaded,").length - 1, 2, 'agents 與 offline_agents 都要帶')
  assert.match(mig, /'claude_mod', case when n\.claude_mod is null/)
  assert.match(mig, /\(can_invite or can_roster\)/)
  assert.match(mig, /'archived', exists/)
  assert.match(mig, /relay\.asn_presence p/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', can_invite boolean default true, can_roster boolean default true,
      name text, kind text, machine text, avatar text, avatar_updated_at timestamptz, last_seen_at timestamptz default now());
    create table relay.roster(node text, name text, status text, cwd_label text, detail text, engine text, context_pct smallint, seen_at timestamptz default now(), primary key (node, name));
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    create table relay.partners(node text, current_name text, partner_id text);
    create table relay.partner_archives(tenant_id uuid, key text);
    insert into relay.nodes(id, tenant_id, name) values ('H', '${T1}', '家用機'), ('W', '${T1}', '工作機');`)
  await db.exec(mig)
  return db
}
const setMod = async (db, node, m) => (await db.query('select public.asn_relay_set_claude_mod($1, $2::jsonb) r', [node, JSON.stringify(m)])).rows[0].r
const list = async db => (await db.query('select public.asn_relay_list($1) r', [T1])).rows[0].r

test('實跑（pglite）：set_claude_mod 驗格式、只動自己節點，list 帶出', { skip }, async () => {
  const db = await setup()
  assert.deepEqual(await setMod(db, 'H', { state: 'installed', version: '0.4.2', extra: 1 }), { ok: true })
  assert.deepEqual(await setMod(db, 'W', { state: 'failed', reason: '  安裝外掛失敗：網路不通 ' }), { ok: true })
  const byId = Object.fromEntries((await list(db)).map(n => [n.id, n.claude_mod]))
  assert.equal(byId.H.state, 'installed'); assert.equal(byId.H.version, '0.4.2'); assert.ok(byId.H.updated_at)
  assert.equal(byId.H.extra, undefined)
  assert.deepEqual([byId.W.state, byId.W.reason, byId.W.version], ['failed', '安裝外掛失敗：網路不通', undefined])
  // 壞格式整筆不收，原值不變
  for (const bad of [{ state: 'weird' }, { state: 5 }, { state: 'installed', version: 'a b' }, { state: 'installed', version: 3 }, { state: 'failed', reason: 'x'.repeat(121) }, { state: 'failed', reason: 5 }, [], 'installed']) {
    assert.deepEqual(await setMod(db, 'H', bad), { error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.equal((await list(db)).find(n => n.id === 'H').claude_mod.state, 'installed')
  // 不存在或停用的節點動不到
  assert.deepEqual(await setMod(db, 'NOPE', { state: 'installed' }), { error: 'forbidden' })
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'W'`)
  assert.deepEqual(await setMod(db, 'W', { state: 'installed' }), { error: 'forbidden' })
  // 沒回報過的電腦是 null（舊用戶端）
  await db.exec(`update relay.nodes set claude_mod = null, claude_mod_at = null where id = 'H'`)
  assert.equal((await list(db)).find(n => n.id === 'H').claude_mod, null)
})

test('實跑（pglite）：roster 存 mod_loaded（只收布林）、舊報法不壞、list 在線與離線都帶', { skip }, async () => {
  const db = await setup()
  const roster = async agents => (await db.query('select public.asn_relay_roster($1, $2::jsonb) r', ['H', JSON.stringify(agents)])).rows[0].r
  assert.deepEqual(await roster([
    { name: 'a', status: 'busy', context_pct: 85, mod_loaded: true },
    { name: 'b', mod_loaded: false },
    { name: 'c', mod_loaded: 'true' },
    { name: 'd', mod_loaded: 1 },
    { name: 'e' },
  ]), { count: 5 }, '壞值不拒絕整份名單')
  const m = (await list(db)).find(n => n.id === 'H')
  assert.deepEqual(Object.fromEntries(m.agents.map(a => [a.name, a.mod_loaded])), { a: true, b: false, c: null, d: null, e: null })
  assert.equal(m.agents.find(a => a.name === 'a').context_pct, 85, '舊欄位照舊')
  await db.exec(`update relay.roster set seen_at = now() - interval '10 minutes' where name = 'a'`)
  const off = (await list(db)).find(n => n.id === 'H').offline_agents.find(a => a.name === 'a')
  assert.equal(off.mod_loaded, true); assert.equal(off.status, 'offline')
})
