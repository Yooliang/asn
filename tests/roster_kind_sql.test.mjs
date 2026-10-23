// 名單三個新欄位 kind／receivable／model（20261024110000_roster_kind.sql）：
// 靜態檢查＋pglite 實跑（`npm i --no-save @electric-sql/pglite`，沒裝就略過實跑）。
// 驗：舊報法不帶三欄＝kind window／receivable true／model 空；新欄位存取與壞值當預設；list 兩段都帶；
//     投遞到 receivable=false 的條目回 not_receivable，其他（視窗、沒登記的名字）照舊；send 包裝不改簽名、舊呼叫照常。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const mig = fs.readFileSync(new URL('../supabase/migrations/20261024110000_roster_kind.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：三欄有預設、roster 存、list 兩段都帶、send 包裝只授權 service_role', () => {
  assert.match(mig, /add column if not exists kind text not null default 'window'/)
  assert.match(mig, /add column if not exists receivable boolean not null default true/)
  assert.match(mig, /add column if not exists model text/)
  assert.equal(mig.split("'kind', r.kind, 'receivable', r.receivable, 'model', r.model").length - 1, 2, 'agents 與 offline_agents 都要帶')
  assert.match(mig, /rename to asn_relay_send_core/)
  assert.match(mig, /grant execute on function public\.asn_relay_send\(text, text, text, text, text, uuid, boolean, uuid, boolean\) to service_role;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', can_invite boolean default true, can_roster boolean default true,
      name text, kind text, machine text, avatar text, avatar_updated_at timestamptz, claude_mod jsonb, claude_mod_at timestamptz,
      bell_topic text, roster_bell_at timestamptz, last_seen_at timestamptz default now());
    create table relay.roster(node text, name text, status text, cwd_label text, detail text, engine text, context_pct smallint, mod_loaded boolean,
      seen_at timestamptz default now(), primary key (node, name));
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    create table relay.partners(node text, current_name text, partner_id text);
    create table relay.partner_archives(tenant_id uuid, node text, key text);
    insert into relay.nodes(id, tenant_id, name) values ('H', '${T1}', '家用機'), ('S', '${T1}', '無頭');
    -- 舊的寄信函式（簽名與正式相同），只回固定結果
    create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,
      p_expects_reply boolean default null, p_signed_user uuid default null, p_as_person boolean default false) returns jsonb language sql as
      $$ select jsonb_build_object('id', gen_random_uuid(), 'bell_topic', 'b') $$;`)
  await db.exec(mig)
  return db
}
const roster = (db, agents) => db.query('select public.asn_relay_roster($1, $2::jsonb) r', ['S', JSON.stringify(agents)]).then(x => x.rows[0].r)
const list = db => db.query('select public.asn_relay_list($1) r', [T1]).then(x => x.rows[0].r.find(n => n.id === 'S'))
const send = (db, to, agent) => db.query(`select public.asn_relay_send('H', null, $1, $2, 'hi', null) r`, [to, agent]).then(x => x.rows[0].r)

test('實跑：舊報法預設 window／true／null；新欄位存取；壞值當預設，不拒絕整份名單', { skip }, async () => {
  const db = await setup()
  const r = await roster(db, [
    { name: 'old', status: 'idle' },
    { name: 'srv', kind: 'service', receivable: false, model: 'claude-opus-4' },
    { name: 'bad1', kind: 'BAD KIND', receivable: 'no', model: 5 },
    { name: 'bad2', kind: 7, receivable: null, model: '  ' },
    { name: 'long', model: 'm'.repeat(200) },
  ])
  assert.equal(r.count, 5)
  const by = Object.fromEntries((await list(db)).agents.map(a => [a.name, a]))
  assert.deepEqual([by.old.kind, by.old.receivable, by.old.model], ['window', true, null])
  assert.deepEqual([by.srv.kind, by.srv.receivable, by.srv.model], ['service', false, 'claude-opus-4'])
  assert.deepEqual([by.bad1.kind, by.bad1.receivable, by.bad1.model], ['window', true, null])
  assert.deepEqual([by.bad2.kind, by.bad2.receivable, by.bad2.model], ['window', true, null])
  assert.equal(by.long.model.length, 60)
  assert.equal(by.old.status, 'idle', '舊欄位照舊')
  await db.exec(`update relay.roster set seen_at = now() - interval '10 minutes' where name = 'srv'`)
  const off = (await list(db)).offline_agents.find(a => a.name === 'srv')
  assert.deepEqual([off.kind, off.receivable, off.model], ['service', false, 'claude-opus-4'])
})

test('實跑：投遞拒收 receivable=false；視窗、沒登記的名字、不帶視窗名照舊', { skip }, async () => {
  const db = await setup()
  await roster(db, [{ name: 'win' }, { name: 'srv', kind: 'service', receivable: false }])
  assert.deepEqual(await send(db, 'S', 'srv'), { error: 'not_receivable' })
  assert.deepEqual(await send(db, 'S', 'SRV'), { error: 'not_receivable' }, '名字不分大小寫')
  assert.ok((await send(db, 'S', 'win')).id, '視窗照舊')
  assert.ok((await send(db, 'S', 'nobody')).id, '沒登記的名字照舊')
  assert.ok((await send(db, 'S', null)).id, '不指定視窗照舊')
  // 重新回報成可收 → 立刻能寄
  await roster(db, [{ name: 'srv', receivable: true }])
  assert.ok((await send(db, 'S', 'srv')).id)
})
