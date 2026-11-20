// #1875 migration 20261120200000_nodes_created_at.sql：後台名單的成員資料多帶 created_at（節點建立時間），設備詳情頁才能顯示「建立時間」。
// 1. 靜態：只重寫 relay.asn_account_nodes 與 public.asn_relay_list 兩支；對照「現行定義」（20261119200000_web_sessions.sql 原文）只多那兩行／兩處；
//    不動授權、不動資料表；回復檔是現行定義原文。排序只查相對順序（接在 web_sessions 之後），不斷言「最新一支」。
// 2. 實跑（pglite；沒裝略過）：名單成員的 created_at 等於節點的建立時間；帳號名單同；舊定義沒有這個鍵；回復後鍵消失、其餘照舊。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const FILE = '20261120200000_nodes_created_at.sql'
const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read(`../supabase/migrations/${FILE}`)
const down = read(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`)
const prev = read('../supabase/migrations/20261119200000_web_sessions.sql')

const fnOf = (sql, schema, name) => {
  const i = sql.toLowerCase().indexOf(`create or replace function ${schema}.${name}(`)
  assert.ok(i >= 0, `${schema}.${name}`)
  const open = sql.indexOf('$function$', sql.toLowerCase().indexOf('as $function$', i))
  return sql.slice(i, sql.indexOf('$function$;', open + 10) + '$function$;'.length)
}
const code = sql => sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const norm = s => s.replace(/\s+/g, ' ').trim()

test('靜態：只重寫兩支函式；不動授權、不動資料表；接在 web_sessions 之後（只比相對順序）', () => {
  const c = code(mig)
  assert.equal((c.match(/create or replace function/gi) ?? []).length, 2)
  assert.doesNotMatch(c, /drop |alter table|create table|truncate|grant |revoke |delete from|update relay/i)
  assert.match(c, /^begin;$/m)
  assert.match(c, /^commit;$/m)
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(FILE) > files.indexOf('20261119200000_web_sessions.sql'))
})

test('asn_relay_list：與現行定義比，只有節點層多一行 \'created_at\', n.created_at，其餘逐字相同', () => {
  const now = fnOf(mig, 'public', 'asn_relay_list')
  assert.equal((now.match(/'created_at', n\.created_at,/g) ?? []).length, 1)
  assert.equal(norm(now.replace(" 'created_at', n.created_at,", '')), norm(fnOf(prev, 'public', 'asn_relay_list')))
})

test('asn_account_nodes：與現行定義比，只多 \'created_at\', n.created_at，其餘逐字相同', () => {
  const now = fnOf(mig, 'relay', 'asn_account_nodes')
  assert.equal((now.match(/, 'created_at', n\.created_at\)/g) ?? []).length, 1)
  assert.equal(norm(now.replace(", 'created_at', n.created_at)", ')')), norm(fnOf(prev, 'relay', 'asn_account_nodes')))
})

test('回復檔：兩支函式逐字等於現行定義', () => {
  assert.ok(down.includes(fnOf(prev, 'public', 'asn_relay_list')))
  assert.ok(down.includes(fnOf(prev, 'relay', 'asn_account_nodes')))
  assert.doesNotMatch(down, /created_at', n\.created_at/)
  assert.match(code(down), /^begin;$/m)
  assert.match(code(down), /^commit;$/m)
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
closeAtEnd()
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const U1 = '11111111-1111-1111-1111-111111111111'
const MADE = '2026-03-04T05:06:07.000Z'

async function boot(apply = true) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', name text, kind text default 'claude', machine text,
      owner_user uuid, created_via text, created_at timestamptz not null default now(),
      last_seen_at timestamptz default now(), claude_mod jsonb, claude_mod_at timestamptz, avatar text, avatar_updated_at timestamptz, last_active_at timestamptz);
    create table relay.partners(partner_id text primary key, node text, current_name text, avatar text, avatar_updated_at timestamptz, last_active_at timestamptz);
    create table relay.roster(node text, name text, status text, cwd_label text, engine text, detail text, context_pct smallint, mod_loaded boolean, kind text, receivable boolean,
      model text, hidden boolean, elevated boolean, seen_at timestamptz default now(), primary key (node, name));
    create table relay.partner_archives(tenant_id uuid, node text, key text);
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    insert into relay.nodes(id, tenant_id, name, owner_user, created_via, created_at) values ('H', '${T1}', '家用機', '${U1}', 'device_code', '${MADE}');
    insert into relay.nodes(id, tenant_id, name, owner_user, created_at) values ('W', '${T1}', '網頁', '${U1}', now());
    update relay.nodes set kind = 'web' where id = 'W';`)
  await db.exec(fnOf(prev, 'public', 'asn_relay_list'))
  await db.exec(fnOf(prev, 'relay', 'asn_account_nodes'))
  if (apply) await db.exec(mig)
  return db
}
const listOf = async db => (await db.query('select public.asn_relay_list($1::uuid) r', [T1])).rows[0].r
const acctOf = async db => (await db.query('select relay.asn_account_nodes($1::uuid) r', [U1])).rows[0].r

test('實跑：名單成員帶 created_at，值等於節點的建立時間（網頁節點照舊不在名單）', { skip }, async () => {
  const db = await boot()
  const rows = await listOf(db)
  assert.deepEqual(rows.map(n => n.id), ['H'])
  assert.equal(Date.parse(rows[0].created_at), Date.parse(MADE))
  const real = (await db.query(`select created_at from relay.nodes where id = 'H'`)).rows[0].created_at
  assert.equal(Date.parse(rows[0].created_at), real.getTime())
  assert.equal(rows[0].name, '家用機')
})

test('實跑：帳號的設備名單同樣帶 created_at；其他欄位不變', { skip }, async () => {
  const db = await boot()
  const rows = await acctOf(db)
  assert.equal(rows.length, 1)
  assert.equal(Date.parse(rows[0].created_at), Date.parse(MADE))
  assert.deepEqual([rows[0].id, rows[0].name, rows[0].created_via], ['H', '家用機', 'device_code'])
})

test('實跑：套用前（現行定義）沒有這個鍵；回復檔把兩支換回現行定義、鍵消失、其餘照舊', { skip }, async () => {
  const before = await boot(false)
  assert.equal('created_at' in (await listOf(before))[0], false)
  assert.equal('created_at' in (await acctOf(before))[0], false)
  const db = await boot()
  await db.exec(down)
  const l = (await listOf(db))[0]
  assert.equal('created_at' in l, false)
  assert.equal('created_at' in (await acctOf(db))[0], false)
  assert.deepEqual([l.id, l.name, l.kind], ['H', '家用機', 'claude'])
})
