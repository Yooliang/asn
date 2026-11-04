// 寄給本人的信，手機沒開 App 時也留一列（20261104190000_owner_mail_phone.sql）。
// 回復檔是正式庫上一版的函式：其他節點的行為用它跑同一組情境對照。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261104190000_owner_mail_phone'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}.sql`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F}_down.sql`, import.meta.url), 'utf8'))

test('靜態：只換一支函式，不動資料表與權限', () => {
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /public\.asn_relay_send_core\(/)
  for (const s of [mig, down]) assert.doesNotMatch(s.replace(/^--.*$/gm, ''), /\b(grant|revoke|drop|truncate|alter table|create table)\b/i)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T = 'aaaaaaaa-0000-0000-0000-000000000001'
const O = 'bbbbbbbb-0000-0000-0000-000000000001'
const ALIAS = 'u:bbbbbbbb0000'

async function setup(sql) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid, character_node text, owner_name text);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, role text, platform text, bell_topic text, created_at timestamptz default now());
    create table relay.asn_presence(node text, window_name text, updated_at timestamptz default now());
    create table relay.messages(id uuid default gen_random_uuid() primary key, from_node text, from_agent text, to_node text, to_agent text, body text, reply_to uuid, tenant_id uuid,
      expects_reply boolean, owner_signed boolean, person_user uuid, fanout_id uuid, acked_at timestamptz, created_at timestamptz default now());
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select u is not null $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:bbbbbbbb0000' $$;
    insert into relay.tenants(id, owner_user) values ('${T}', '${O}');
    insert into relay.nodes(id, tenant_id, owner_user, platform, bell_topic, created_at) values
      ('PC', '${T}', '${O}', 'windows', 'bell-pc', now() - interval '3 days'),
      ('PC2', '${T}', '${O}', null, 'bell-pc2', now() - interval '2 days'),
      ('AI', '${T}', '${O}', 'linux', 'bell-ai', now() - interval '1 day'),
      ('PHONE', '${T}', '${O}', 'android', 'bell-phone', now());`)
  await db.exec(sql)
  return db
}
const seen = (db, node, win, ago) => db.exec(`insert into relay.asn_presence(node, window_name, updated_at) values ('${node}', '${win}', now() - interval '${ago}')`)
const send = async (db, to = ALIAS) => (await db.query(`select public.asn_relay_send_core('AI', '收發室', $1, null, '內文', null) r`, [to])).rows[0].r
const rows = async db => (await db.query(`select to_node, to_agent from relay.messages order by to_node, to_agent`)).rows.map(r => `${r.to_node}/${r.to_agent}`)

test('手機離線：留一列給它最新的視窗；在線的設備照常', { skip }, async () => {
  const db = await setup(mig)
  await seen(db, 'PC', '電腦', '1 minute')
  await seen(db, 'PHONE', '舊名', '2 days')
  await seen(db, 'PHONE', '手機', '1 hour')
  const r = await send(db)
  assert.deepEqual(await rows(db), ['PC/電腦', 'PHONE/手機'])
  assert.equal(r.fanout, 2)
  assert.deepEqual(r.bell_topics, ['bell-pc', 'bell-phone'])
  const f = (await db.query('select count(distinct fanout_id) n from relay.messages')).rows[0].n
  assert.equal(Number(f), 1, '同一組 fanout，往來記錄才算一封')
})

test('手機在線：不重複；舊窗名不會多一列', { skip }, async () => {
  const db = await setup(mig)
  await seen(db, 'PHONE', '舊名', '2 days')
  await seen(db, 'PHONE', '手機', '1 minute')
  await send(db)
  assert.deepEqual(await rows(db), ['PHONE/手機'])
})

test('全部不在線：原本那一列照舊，手機多一列', { skip }, async () => {
  const db = await setup(mig)
  await seen(db, 'PHONE', '手機', '1 hour')
  const r = await send(db)
  assert.deepEqual(await rows(db), [`PC/${ALIAS}`, 'PHONE/手機'])
  assert.deepEqual(r.bell_topics, ['bell-pc', 'bell-phone'])
  assert.equal(r.fanout, 0)
  assert.equal(Number((await db.query('select count(distinct fanout_id) n from relay.messages')).rows[0].n), 1)
})

test('超過 30 天沒開、已停用、別人的手機：不留', { skip }, async () => {
  const db = await setup(mig)
  await seen(db, 'PC', '電腦', '1 minute')
  await seen(db, 'PHONE', '手機', '31 days')
  await send(db)
  assert.deepEqual(await rows(db), ['PC/電腦'])
  await db.exec(`delete from relay.messages; update relay.asn_presence set updated_at = now() - interval '1 hour' where node = 'PHONE'; update relay.nodes set status = 'revoked' where id = 'PHONE'`)
  await send(db)
  assert.deepEqual(await rows(db), ['PC/電腦'])
  await db.exec(`delete from relay.messages; update relay.nodes set status = 'active', owner_user = '${T}' where id = 'PHONE'`)
  await send(db)
  assert.deepEqual(await rows(db), ['PC/電腦'])
})

test('積信滿 100 封就不再多留，收下之後恢復；信仍到其他設備', { skip }, async () => {
  const db = await setup(mig)
  await seen(db, 'PC', '電腦', '1 minute')
  await seen(db, 'PHONE', '手機', '1 hour')
  await db.exec(`insert into relay.messages(to_node, to_agent, body) select 'PHONE', '手機', 'x' from generate_series(1, 100)`)
  await send(db)
  const n = async () => Number((await db.query(`select count(*) n from relay.messages where to_node = 'PHONE'`)).rows[0].n)
  assert.equal(await n(), 100)
  assert.equal(Number((await db.query(`select count(*) n from relay.messages where to_node = 'PC'`)).rows[0].n), 1)
  await db.exec(`update relay.messages set acked_at = now() where to_node = 'PHONE'`)
  await send(db)
  assert.equal(await n(), 101)
})

test('其他節點行為不變：沒有手機時，新舊函式結果逐項相同', { skip }, async () => {
  const scenario = async sql => {
    const db = await setup(sql)
    await db.exec(`update relay.nodes set platform = null where id = 'PHONE'`)   // 舊版手機還沒回報平台
    await seen(db, 'PHONE', '手機', '1 hour')
    const out = []
    const norm = r => { const { id, ...rest } = r; return rest }
    out.push(norm(await send(db)), await rows(db))   // 全部不在線
    await db.exec('delete from relay.messages')
    await seen(db, 'PC', '電腦', '1 minute'); await seen(db, 'PC2', '第二台', '2 minutes')
    out.push(norm(await send(db)), await rows(db))   // 兩台在線
    await db.exec('delete from relay.messages')
    out.push(norm(await send(db, 'PC')), await rows(db))   // 寄給節點（一般信）
    return out
  }
  assert.deepEqual(await scenario(mig), await scenario(down))
})
