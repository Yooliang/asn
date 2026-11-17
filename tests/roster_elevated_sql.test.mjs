// #1634 migration 20261117200000_roster_elevated.sql：名單多存「這個視窗是系統管理員身分開的」（elevated，只是顯示用的資訊），讀出時帶回。
// 1. 靜態：只加一個欄位；asn_relay_roster 與 asn_relay_list 對照「現行定義」（20261028200000／20261028220000 的原文）只多那幾行；
//    不刪不改資料、不動授權；檔頭註明 elevated 不能拿來當權限判斷；回復腳本是上一版原文加 drop column。
// 2. 實跑（pglite；沒裝略過）：只收 true；亂填的值存 null；線上與離線夥伴讀出都帶；舊呼叫不帶照舊；回復腳本能換回舊版。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('../supabase/migrations/20261117200000_roster_elevated.sql')
const down = read('../supabase/sql/rollback/20261117200000_roster_elevated_down.sql')
const prevRoster = read('../supabase/migrations/20261028200000_roster_active_at.sql')
const prevList = read('../supabase/migrations/20261028220000_partner_avatar.sql')

const fnOf = (sql, name, from = 0) => {
  const i = sql.toLowerCase().indexOf(`create or replace function public.${name}(`, from)
  assert.ok(i >= 0, name)
  const open = sql.indexOf('$function$', sql.toLowerCase().indexOf('as $function$', i))
  return sql.slice(i, sql.indexOf('$function$;', open + 10) + '$function$;'.length)
}
const code = sql => sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const norm = s => s.replace(/create or replace function/i, 'create or replace function').replace(/\s+/g, ' ').trim()

test('靜態：只加欄位、不刪不改資料、不動授權；檔頭註明只是顯示用的資訊、不是權限判斷', () => {
  const c = code(mig)
  assert.equal((c.match(/alter table relay\.roster add column if not exists elevated boolean;/g) ?? []).length, 1)
  assert.doesNotMatch(c, /drop table|drop column|alter column|truncate|drop function|grant |revoke |delete from relay\.(nodes|partners)/i)
  assert.match(c, /^begin;$/m)
  assert.match(c, /^commit;$/m)
  assert.match(mig.split('\nbegin;')[0], /elevated 只是「顯示用的資訊」，不能拿來當任何權限判斷/)
})

test('asn_relay_roster：與現行定義比，只多 insert 欄位清單的 elevated 與一行取值（只收 true），其餘逐字相同', () => {
  const now = fnOf(mig, 'asn_relay_roster').split('\n')
  const was = fnOf(prevRoster, 'asn_relay_roster').split('\n')
  const added = now.filter(l => !was.includes(l))
  assert.equal(added.length, 3, added.join('\n'))
  assert.match(added[0], /insert into relay\.roster \(.*model, hidden, elevated\)/)
  assert.match(added[1], /case when jsonb_typeof\(a\.v->'hidden'\) = 'boolean' then \(a\.v->>'hidden'\)::boolean end,$/)
  assert.match(added[2], /case when jsonb_typeof\(a\.v->'elevated'\) = 'boolean' and \(a\.v->>'elevated'\)::boolean then true end$/)
  const rest = now.filter(l => !added.includes(l)).join('\n')
  assert.equal(norm(rest), norm(was.filter(l => !/case when jsonb_typeof\(a\.v->'hidden'\) = 'boolean' then \(a\.v->>'hidden'\)::boolean end$/.test(l) && !/insert into relay\.roster \(/.test(l)).join('\n')))
})

test('asn_relay_list：與現行定義比，只有在線與離線兩處各多 \'elevated\', r.elevated，其餘逐字相同', () => {
  const now = fnOf(mig, 'asn_relay_list')
  const was = fnOf(prevList, 'asn_relay_list')
  assert.equal((now.match(/'elevated', r\.elevated,/g) ?? []).length, 2)
  assert.equal(norm(now.replace(/ 'elevated', r\.elevated,/g, '')), norm(was))
})

test('回復腳本：兩個函式換回上一版原文，再 drop 欄位', () => {
  assert.equal(norm(fnOf(down, 'asn_relay_roster')), norm(fnOf(prevRoster, 'asn_relay_roster')))
  assert.equal(norm(fnOf(down, 'asn_relay_list')), norm(fnOf(prevList, 'asn_relay_list')))
  assert.match(code(down), /alter table relay\.roster drop column if exists elevated;/)
  assert.match(code(down), /^begin;$/m)
  assert.match(code(down), /^commit;$/m)
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
closeAtEnd()
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

async function boot(apply = true) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', name text, kind text default 'claude', machine text,
      can_invite boolean default false, can_roster boolean default true, roster_bell_at timestamptz, bell_topic text,
      last_seen_at timestamptz default now(), claude_mod jsonb, claude_mod_at timestamptz, avatar text, avatar_updated_at timestamptz, last_active_at timestamptz);
    create table relay.partners(partner_id text primary key, node text references relay.nodes(id), current_name text, current_session text, engine text, model text,
      avatar text, avatar_updated_at timestamptz, last_active_at timestamptz);
    create table relay.roster(node text, name text, status text, cwd_label text, engine text, detail text, context_pct smallint, mod_loaded boolean, kind text, receivable boolean,
      model text, hidden boolean, seen_at timestamptz default now(), primary key (node, name));
    create table relay.partner_archives(tenant_id uuid, node text, key text);
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    insert into relay.nodes(id, tenant_id, name) values ('H', '${T1}', '家用機');`)
  // 現行（舊）定義：先套上一版的兩個函式，再套這支 migration
  await db.exec(fnOf(prevRoster, 'asn_relay_roster'))
  await db.exec(fnOf(prevList, 'asn_relay_list'))
  if (apply) await db.exec(mig)
  return db
}
const roster = async (db, agents) => (await db.query('select public.asn_relay_roster($1, $2::jsonb) r', ['H', JSON.stringify(agents)])).rows[0].r
const listOf = async db => (await db.query('select public.asn_relay_list($1::uuid) r', [T1])).rows[0].r[0]

test('實跑：只收布林 true；false、字串、數字、物件、陣列、沒帶都存 null；名單照常換掉', { skip }, async () => {
  const db = await boot()
  const r = await roster(db, [
    { name: 'A', elevated: true }, { name: 'B', elevated: false }, { name: 'C', elevated: 'true' }, { name: 'D', elevated: 1 },
    { name: 'E', elevated: { x: 1 } }, { name: 'F' }, { name: 'G', elevated: [true] },
  ])
  assert.equal(r.count, 7)
  const rows = (await db.query('select name, elevated from relay.roster order by name')).rows
  assert.deepEqual(rows.map(x => [x.name, x.elevated]), [['A', true], ['B', null], ['C', null], ['D', null], ['E', null], ['F', null], ['G', null]])
})

test('實跑：名單讀出時線上與離線的夥伴都帶 elevated（沒有就是 null）；其他舊欄位不變', { skip }, async () => {
  const db = await boot()
  await roster(db, [{ name: '在線的', status: 'idle', elevated: true }, { name: '另一個', status: 'busy' }, { name: '離線的', elevated: true }])
  await db.query(`update relay.roster set seen_at = now() - interval '10 minutes' where name = '離線的'`)
  const n = await listOf(db)
  const on = Object.fromEntries(n.agents.map(a => [a.name, a]))
  assert.equal(on['在線的'].elevated, true)
  assert.equal(on['另一個'].elevated, null)
  assert.equal(on['在線的'].status, 'idle')
  assert.equal(n.offline_agents.length, 1)
  assert.deepEqual([n.offline_agents[0].name, n.offline_agents[0].elevated, n.offline_agents[0].status], ['離線的', true, 'offline'])
})

test('實跑：舊電腦的名單完全不帶這個欄位，照常存、照常讀（elevated 是 null）', { skip }, async () => {
  const db = await boot()
  const r = await roster(db, [{ name: '舊的', status: 'idle', engine: 'claude', hidden: false }])
  assert.deepEqual([r.count, r.changed], [1, true])
  const n = await listOf(db)
  assert.deepEqual([n.agents[0].name, n.agents[0].elevated, n.agents[0].hidden, n.agents[0].engine], ['舊的', null, false, 'claude'])
})

test('實跑：回復腳本把兩個函式換回舊版、欄位被 drop；舊版名單照常', { skip }, async () => {
  const db = await boot()
  await roster(db, [{ name: 'A', elevated: true }])
  await db.exec(down)
  const cols = (await db.query(`select column_name from information_schema.columns where table_schema = 'relay' and table_name = 'roster'`)).rows.map(x => x.column_name)
  assert.ok(!cols.includes('elevated'))
  const r = await roster(db, [{ name: 'B', elevated: true }])
  assert.equal(r.count, 1)
  const n = await listOf(db)
  assert.equal('elevated' in n.agents[0], false, '舊版沒有這個鍵')
})
