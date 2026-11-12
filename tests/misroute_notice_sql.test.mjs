// 核對轉交對象的本人通知（20261102200000_misroute_notice.sql）：
// 1. 靜態：只授權 service_role、security definer、search_path 空、寄件名以「收發室」結尾、回復檔只 drop 函式。
// 2. 實跑（有安裝 @electric-sql/pglite 時）：擁有者收得到固定內文（只有設備名與信件編號，沒有視窗名）、reply=no、
//    每節點每小時上限 3 封、別的節點的擁有者收不到、停用或不存在的節點動不到、asn_relay_send 回錯誤時回 failed。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261102200000_misroute_notice.sql'
const SIG = 'asn_relay_misroute_notice(text, uuid)'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))

test('靜態：只授權 service_role、寄件名以收發室結尾、reply=no、回復檔只 drop 函式', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf('20261102170000_node_platform_phone.sql'), '編號在最新一支之後')
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(mig, /v_agent constant text := '[^']*收發室';/)
  assert.match(mig, /public\.asn_relay_send\(p_node, v_agent, public\.asn_person_alias\(v_owner\), null, v_body, null, false, null, false\)/, 'reply=no、收件人只能是節點擁有者')
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /grant [^;]*to (anon|authenticated|public)|drop |create table|alter table|truncate/i)
  assert.ok(down.includes(`drop function if exists public.${SIG};`))
  assert.doesNotMatch(down, /drop column|drop table/i)
})

let PGlite = null
try { PGlite = await fastPGlite() } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const OWNER_A = 'bbbbbbbb-0000-0000-0000-00000000000a'
const OWNER_B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const MAIL = 'cccccccc-0000-0000-0000-000000000001'

async function setup() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid, name text);
    create table relay.messages(id uuid default gen_random_uuid() primary key, fanout_id uuid, from_node text, from_agent text, to_node text, body text, expects_reply boolean, created_at timestamptz default now());
    insert into relay.nodes(id, owner_user, name) values ('H', '${OWNER_A}', '家用機'), ('P', '${OWNER_B}', '手機'), ('W', '${OWNER_A}', '工作機'), ('X', null, '無主'), ('F', '${OWNER_A}', '壞掉的');
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select n <> 'W' $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:' || right(u::text, 4) $$;
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      begin if a = 'F' then return jsonb_build_object('error', 'boom'); end if; insert into relay.messages(from_node, from_agent, to_node, body, expects_reply) values (a, b, c, e, g); return jsonb_build_object('bell_topics', jsonb_build_array('bell-1')); end $$;`)
  await db.exec(mig)
  return db
}
const notice = async (db, node, mail = MAIL) => (await db.query('select public.asn_relay_misroute_notice($1, $2::uuid) r', [node, mail])).rows[0].r
const msgs = async (db, node) => (await db.query(`select from_agent, to_node, body, expects_reply from relay.messages where from_node = $1 order by created_at`, [node])).rows

test('實跑（pglite）：擁有者收到固定內文，只有設備名與信件編號，reply=no，寄件名以收發室結尾', { skip }, async () => {
  const db = await setup()
  const r = await notice(db, 'H')
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['bell-1']])
  const m = await msgs(db, 'H')
  assert.equal(m.length, 1)
  assert.equal(m[0].to_node, 'u:000a', '收件人是這個節點的擁有者')
  assert.equal(m[0].expects_reply, false)
  assert.ok(m[0].from_agent.endsWith('收發室'))
  assert.equal(m[0].body, `這台（家用機）的收發室把一封信（編號 ${MAIL}）轉交錯了視窗，可能已被讀取；收發室正在重新轉交給原收件人。`)
  // 沒有編號（群組訊息）：不帶編號
  const g = await notice(db, 'P', null)
  assert.equal(g.notify, 'sent')
  const mp = await msgs(db, 'P')
  assert.equal(mp[0].to_node, 'u:000b', '別的節點的擁有者是另一個人')
  assert.equal(mp[0].body, '這台（手機）的收發室把一則訊息轉交錯了視窗，可能已被讀取；收發室正在重新轉交給原收件人。')
  assert.equal((await msgs(db, 'H')).length, 1, 'H 的擁有者沒有收到 P 的通知')
})

test('實跑（pglite）：每節點每小時最多 3 封，別的節點不受影響', { skip }, async () => {
  const db = await setup()
  for (let i = 0; i < 3; i++) assert.equal((await notice(db, 'H')).notify, 'sent')
  const r = await notice(db, 'H')
  assert.equal(r.notify, 'rate_limited')
  assert.equal((await msgs(db, 'H')).length, 3)
  assert.equal((await notice(db, 'P')).notify, 'sent', '另一個節點有自己的額度')
  await db.exec(`update relay.messages set created_at = now() - interval '2 hours' where from_node = 'H'`)
  assert.equal((await notice(db, 'H')).notify, 'sent', '過了一小時重新計')
})

test('實跑（pglite）：節點不存在或停用回 forbidden；擁有者核對不過、沒有擁有者不寄；asn_relay_send 回錯誤回 failed', { skip }, async () => {
  const db = await setup()
  assert.deepEqual(await notice(db, 'NOPE'), { error: 'forbidden' })
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'P'`)
  assert.deepEqual(await notice(db, 'P'), { error: 'forbidden' })
  assert.equal((await notice(db, 'W')).notify, 'skipped', '擁有者核對不過（stub：W）')
  assert.equal((await notice(db, 'X')).notify, 'skipped', '沒有擁有者')
  assert.equal((await msgs(db, 'W')).length + (await msgs(db, 'X')).length, 0)
  const f = await notice(db, 'F')
  assert.deepEqual([f.ok, f.notify, f.bell_topics], [true, 'failed', []])
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
