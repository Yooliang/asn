// 收信暫停提示（20261102100000_inbox_hold_until.sql）：
// 1. 靜態：只加可空欄位與一支函式、只授權 service_role、security definer、search_path 空、回復檔拿掉兩者。
// 2. 實跑（有安裝 @electric-sql/pglite 時）：只動得到自己的節點、值被夾在 now() 到 now()+8 天、可以清成 null、停用或不存在的節點動不到；
//    暫停開始時寄一封給擁有者（內文、reply=no），延長或重複設值不再寄，設備名不合或擁有者核對不過只設時間不寄，每小時最多 3 封。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261102100000_inbox_hold_until.sql'
const SIG = 'asn_relay_set_inbox_hold(text, timestamptz, integer, boolean)'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))

test('靜態：可空欄位、單一函式、只授權 service_role、回復檔拿掉兩者', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf('20261101230000_secret_link.sql'), '編號在最新一支之後')
  assert.match(mig, /alter table relay\.nodes add column if not exists inbox_hold_until timestamptz;/)
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(mig, /least\(greatest\(p_until, now\(\)\), now\(\) \+ interval '8 days'\)/)
  assert.match(mig, /public\.asn_relay_send\(p_node, v_agent, public\.asn_person_alias\(v_owner\), null, v_body, null, false, null, false\)/, 'reply=no、收件人只能是節點擁有者')
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)|drop |create table|truncate/i)
  assert.ok(down.includes(`drop function if exists public.${SIG};`))
  assert.match(down, /drop column if exists inbox_hold_until/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const OWNER = 'bbbbbbbb-0000-0000-0000-000000000001'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid, name text);
    create table relay.messages(id uuid default gen_random_uuid() primary key, fanout_id uuid, from_node text, from_agent text, to_node text, body text, expects_reply boolean, created_at timestamptz default now());
    insert into relay.nodes(id, owner_user, name) values ('H', '${OWNER}', '家用機'), ('W', '${OWNER}', '工作機'), ('X', null, '無主');
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select n <> 'W' $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:owner' $$;
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      begin insert into relay.messages(from_node, from_agent, to_node, body, expects_reply) values (a, b, c, e, g); return jsonb_build_object('bell_topics', jsonb_build_array('bell-1')); end $$;`)
  await db.exec(mig)
  return db
}
const set = async (db, node, until, ...rest) => (await db.query('select public.asn_relay_set_inbox_hold($1, $2::timestamptz, $3, $4) r', [node, until, rest[0] ?? 0, rest[1] ?? false])).rows[0].r
const secs = async (db, node) => (await db.query(`select extract(epoch from (inbox_hold_until - now())) s from relay.nodes where id = $1`, [node])).rows[0].s
const msgs = async (db, node) => (await db.query(`select to_node, body, expects_reply from relay.messages where from_node = $1 order by created_at, body`, [node])).rows
const ahead = h => new Date(Date.now() + h * 3_600_000).toISOString()

test('實跑（pglite）：只動自己的節點、值夾在 now() 到 now()+8 天、可清成 null、停用或不存在的節點動不到', { skip }, async () => {
  const db = await setup()
  assert.equal((await set(db, 'H', ahead(3))).ok, true)
  const s = Number(await secs(db, 'H'))
  assert.ok(s > 3 * 3600 - 60 && s <= 3 * 3600 + 5, `設 3 小時：${s}`)
  assert.equal((await db.query(`select inbox_hold_until from relay.nodes where id = 'W'`)).rows[0].inbox_hold_until, null, '別的節點沒被動到')
  await set(db, 'H', ahead(24 * 30))
  const far = Number(await secs(db, 'H'))
  assert.ok(far > 8 * 86400 - 60 && far <= 8 * 86400 + 5, `夾到 8 天：${far}`)
  await set(db, 'H', ahead(-5))
  assert.ok(Number(await secs(db, 'H')) <= 1, '過去的夾到現在')
  await set(db, 'H', ahead(2))
  assert.equal((await set(db, 'H', null)).ok, true)
  assert.equal((await db.query(`select inbox_hold_until from relay.nodes where id = 'H'`)).rows[0].inbox_hold_until, null)
  assert.deepEqual(await set(db, 'NOPE', ahead(1)), { error: 'forbidden' })
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'X'`)
  assert.deepEqual(await set(db, 'X', ahead(1)), { error: 'forbidden' })
})

test('實跑（pglite）：暫停開始寄一封給擁有者；延長與重複設值不再寄；清掉後再開始才寄；超過上限另寄一封；每小時最多 3 封', { skip }, async () => {
  const db = await setup()
  const r = await set(db, 'H', ahead(3), 5)
  assert.deepEqual(r.bell_topics, ['bell-1'])
  let m = await msgs(db, 'H')
  assert.equal(m.length, 1)
  assert.equal(m[0].to_node, 'u:owner', '收件人只能是節點擁有者')
  assert.equal(m[0].expects_reply, false)
  assert.match(m[0].body, /^這台（家用機）的收發室 Claude 額度用完，約 \d\d:\d\d（台北）重置；扣住 5 封，重置後自動轉交。$/)
  // 暫停期間重複設值、延長：不再寄
  await set(db, 'H', ahead(3), 6)
  await set(db, 'H', ahead(5), 9)
  assert.equal((await msgs(db, 'H')).length, 1)
  // 超過上限：另寄一封說明（暫停進行中）
  await set(db, 'H', ahead(5), 200, true)
  m = await msgs(db, 'H')
  assert.equal(m.length, 2)
  assert.ok(m.some(x => x.body.includes('已達上限')))
  // 清掉後再次開始：再寄；第 4 封被每小時 3 封的限流擋下
  await set(db, 'H', null)
  assert.equal((await msgs(db, 'H')).length, 2, '清掉不寄')
  await set(db, 'H', ahead(2), 1)
  assert.equal((await msgs(db, 'H')).length, 3)
  await set(db, 'H', null)
  await set(db, 'H', ahead(2), 1)
  assert.equal((await msgs(db, 'H')).length, 3, '限流')
  assert.ok(Number(await secs(db, 'H')) > 0, '限流只擋信，時間仍設')
})

test('實跑（pglite）：設備名讀 relay.nodes.name；名字空白時省略括號；擁有者核對不過、沒有擁有者只設時間不寄信', { skip }, async () => {
  const db = await setup()
  await db.exec("update relay.nodes set name = E'  含\n控制字元' || repeat('長', 60) where id = 'H'")
  assert.equal((await set(db, 'H', ahead(1), 1)).ok, true)
  const long = (await msgs(db, 'H'))[0].body
  assert.match(long, /^這台（含控制字元長{35}）的收發室/, '去控制字元、最多 40 字')
  await db.exec("update relay.nodes set name = '  ', inbox_hold_until = null where id = 'H'; delete from relay.messages")
  await set(db, 'H', ahead(1), 1)
  assert.match((await msgs(db, 'H'))[0].body, /^這台的收發室 Claude 額度用完/)
  assert.equal((await set(db, 'W', ahead(1), 1)).ok, true, '擁有者核對不過（stub：W）')
  assert.equal((await set(db, 'X', ahead(1), 1)).ok, true, '沒有擁有者')
  assert.equal((await msgs(db, 'W')).length + (await msgs(db, 'X')).length, 0)
  assert.ok(Number(await secs(db, 'W')) > 0)
})
