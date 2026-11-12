// 共用終端服務掛掉的本人通知（20261105110000_mux_down_notice.sql）：靜態檢查與 pglite 實跑。
// 實跑（有安裝 @electric-sql/pglite 時）：擁有者收到固定內文、reply=no、每節點每小時 6 封、別的節點收不到、停用節點動不到、參數不合格不寄。
import { track, closeAtEnd } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261105110000_mux_down_notice.sql'
const SIG = 'asn_relay_mux_down_notice(text, integer, boolean)'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))

test('靜態：只授權 service_role、寄件名以收發室結尾、reply=no、回復檔只 drop 函式', () => {
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(mig, /v_agent constant text := '[^']*收發室';/)
  assert.match(mig, /public\.asn_relay_send\(p_node, v_agent, public\.asn_person_alias\(v_owner\), null, v_body, null, false, null, false\)/, 'reply=no、收件人只能是節點的擁有者')
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /grant [^;]*to (anon|authenticated|public)|drop |create table|alter table|truncate/i)
  assert.ok(down.includes(`drop function if exists public.${SIG};`))
  assert.doesNotMatch(down, /drop column|drop table/i)
})

test('靜態：relay 動作先驗證內容，節點取自金鑰，參數只有夥伴數和接回', () => {
  const src = rd(fs.readFileSync(new URL('../supabase/functions/relay/index.ts', import.meta.url), 'utf8'))
  const i = src.indexOf('if (action === "mux_down_notice"')
  assert.ok(i >= 0)
  const block = src.slice(i, src.indexOf('\n  }\n', i))
  assert.ok(block.includes('parseMuxDownNotice('))
  assert.ok(block.indexOf('parseMuxDownNotice(') < block.indexOf('db.rpc('), '先驗證再呼叫')
  assert.ok(block.includes('p_node: me.id'))
  assert.ok(block.includes('p_count: p.count, p_resumed: p.resumed'))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const OWNER_A = 'bbbbbbbb-0000-0000-0000-00000000000a'
const OWNER_B = 'bbbbbbbb-0000-0000-0000-00000000000b'

async function setup() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid, name text);
    create table relay.messages(id uuid default gen_random_uuid() primary key, fanout_id uuid, from_node text, from_agent text, to_node text, body text, expects_reply boolean, created_at timestamptz default now());
    insert into relay.nodes(id, owner_user, name) values ('H', '${OWNER_A}', '家用機'), ('P', '${OWNER_B}', '手機'), ('W', '${OWNER_A}', '工作機'), ('X', null, '無主'), ('F', '${OWNER_A}', '會失敗'), ('N', '${OWNER_A}', null);
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select n <> 'W' $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:' || right(u::text, 4) $$;
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      begin if a = 'F' then return jsonb_build_object('error', 'boom'); end if; insert into relay.messages(from_node, from_agent, to_node, body, expects_reply) values (a, b, c, e, g); return jsonb_build_object('id', gen_random_uuid(), 'bell_topics', jsonb_build_array('bell-1')); end $$;`)
  await db.exec(mig)
  return db
}
const notice = async (db, node, count = 2, resumed = true) => (await db.query('select public.asn_relay_mux_down_notice($1, $2::integer, $3::boolean) r', [node, count, resumed])).rows[0].r
const msgs = async (db, node) => (await db.query(`select from_agent, to_node, body, expects_reply from relay.messages where from_node = $1 order by created_at`, [node])).rows

test('實跑（pglite）：擁有者收到固定內文，reply=no，接回與否文字不同，沒有設備名時也通', { skip }, async () => {
  const db = await setup()
  const r = await notice(db, 'H', 2, true)
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['bell-1']])
  const m = await msgs(db, 'H')
  assert.equal(m.length, 1)
  assert.equal(m[0].to_node, 'u:000a', '收件人是這個節點的擁有者')
  assert.equal(m[0].expects_reply, false)
  assert.ok(m[0].from_agent.endsWith('收發室'))
  assert.equal(m[0].body, '這台（家用機）的終端服務中斷了，2 位夥伴受影響，ASN 正在自動接回。')
  await notice(db, 'H', 1, false)
  assert.equal((await msgs(db, 'H'))[1].body, '這台（家用機）的終端服務短時間內又中斷了，1 位夥伴受影響。這次沒有自動接回，請到這台電腦看一下。')
  assert.equal((await notice(db, 'P')).notify, 'sent')
  assert.equal((await msgs(db, 'P'))[0].to_node, 'u:000b', '別的節點的擁有者是另一個人')
  assert.equal((await msgs(db, 'H')).length, 2, 'H 的擁有者沒有收到 P 的通知')
  await notice(db, 'N')
  assert.equal((await msgs(db, 'N'))[0].body, '這台的終端服務中斷了，2 位夥伴受影響，ASN 正在自動接回。')
})

test('實跑（pglite）：每節點每小時最多 6 封，別的節點不受影響，過了一小時重新計', { skip }, async () => {
  const db = await setup()
  for (let i = 0; i < 6; i++) assert.equal((await notice(db, 'H')).notify, 'sent')
  const r = await notice(db, 'H')
  assert.deepEqual([r.notify, r.bell_topics], ['rate_limited', []])
  assert.equal((await msgs(db, 'H')).length, 6)
  assert.equal((await notice(db, 'P')).notify, 'sent', '另一個節點有自己的額度')
  await db.exec(`update relay.messages set created_at = now() - interval '2 hours' where from_node = 'H'`)
  assert.equal((await notice(db, 'H')).notify, 'sent')
})

test('實跑（pglite）：節點不存在或停用回 forbidden；參數不合格不寄；擁有者不對不寄；寄送失敗回 failed', { skip }, async () => {
  const db = await setup()
  assert.deepEqual(await notice(db, 'NOPE'), { error: 'forbidden' })
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'P'`)
  assert.deepEqual(await notice(db, 'P'), { error: 'forbidden' })
  for (const c of [0, -1, 101, null]) assert.deepEqual(await notice(db, 'H', c), { error: 'bad_request' }, String(c))
  assert.deepEqual(await notice(db, 'H', 1, null), { error: 'bad_request' })
  assert.equal((await msgs(db, 'H')).length, 0)
  assert.equal((await notice(db, 'W')).notify, 'skipped', '擁有者核對不過')
  assert.equal((await notice(db, 'X')).notify, 'skipped', '沒有擁有者')
  assert.equal((await msgs(db, 'W')).length + (await msgs(db, 'X')).length, 0)
  const f = await notice(db, 'F')
  assert.deepEqual([f.ok, f.notify, f.bell_topics], [true, 'failed', []])
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
