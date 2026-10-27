// 遠端管理夥伴：新增動作「移除」（remove，0.2 B3）的 migration（20261028100000_partner_ops_remove.sql）：
// 1. 靜態檢查：只擴大動作清單、不改舊值；函式本體與上一版（20261023100000 restart）只差在動作清單多了 remove。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）先套原本的 partner_ops，再套這一版：
//    remove 收得下、舊動作照常、不認得的動作照樣擋。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261022120000_partner_ops.sql')
const prev = read('20261023100000_partner_ops_restart.sql')
const sql = read('20261028100000_partner_ops_remove.sql')
const OLD = "'info', 'rename', 'model', 'close', 'handover', 'resume', 'restart'"
const body = s => s.slice(s.indexOf('begin;'))

test('靜態：只在動作清單加 remove，其餘與上一版一字不差；舊值都還在', () => {
  assert.equal(body(sql), body(prev).replaceAll(OLD, `${OLD}, 'remove'`))
  assert.equal((sql.match(/'restart', 'remove'/g) ?? []).length, 2, '資料表檢查條件與下令函式各一處')
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.doesNotMatch(sql, /grant |revoke /, 'create or replace 不動權限')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

test('實跑（pglite）：remove 收得下並寫進資料表；restart、close 照常；不認得的動作照樣擋', { skip }, async () => {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, launcher jsonb, bell_topic text, last_seen_at timestamptz default now());
    create table relay.partners(partner_id text primary key, tenant_id uuid, node text, current_name text, current_session text, engine text, updated_at timestamptz default now());
    create table relay.partner_names(partner_id text, name text, renamed_at timestamptz default now());
    create table relay.roster(node text, name text, engine text, seen_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.irori_relay_launch_name_ok(p_name text) returns boolean language sql immutable as
      $$ select p_name is not null and p_name ~ '^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$' $$;
    create function public.asn_relay_launch_name_ok(p_name text) returns boolean language sql immutable as
      $$ select public.irori_relay_launch_name_ok(p_name) $$;
    insert into relay.nodes(id, tenant_id, owner_user, name, launcher, bell_topic) values
      ('P','${T1}','${U1}','小良的手機', null, 'bell-P'), ('H','${T1}','${U1}','家用機', '{"profiles":[{"id":"grok"}]}', 'bell-H');
    insert into relay.roster(node, name, engine) values ('H','Grok','grok'), ('H','Gemini','gemini'), ('H','小文','claude');`)
  await db.exec(base)
  await db.exec(sql)
  const op = async (name, o) => (await db.query('select public.asn_relay_partner_op($1,$2,$3,$4,$5,$6,$7,$8) r', ['P', U1, 'H', name, o, null, null, null])).rows[0].r
  const r = await op('Grok', 'remove')
  assert.equal(r.bell_topic, 'bell-H'); assert.ok(r.id)
  const row = (await db.query('select op, status, model, note, new_name from relay.partner_ops where id = $1', [r.id])).rows[0]
  assert.deepEqual(row, { op: 'remove', status: 'pending', model: null, note: null, new_name: null })
  assert.ok((await op('Gemini', 'restart')).id, '舊動作 restart 照常')
  assert.ok((await op('小文', 'close')).id, '舊動作 close 照常')
  assert.equal((await op('小文', 'bogus')).error, 'bad_request')
  await assert.rejects(db.query("insert into relay.partner_ops(tenant_id, requested_by, node, name, op) values ($1,'P','H','x','bogus')", [T1]), /partner_ops_op_check/, '資料表的檢查條件也擋')
})
