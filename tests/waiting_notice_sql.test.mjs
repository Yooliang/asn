// 夥伴等本人確認的通知（20261104090000_waiting_notice.sql）：
// 1. 靜態：只授權 service_role、security definer、search_path 空、只收節點、內文寫死、回復檔只 drop 函式。
// 2. 實跑（有安裝 @electric-sql/pglite 時）：擁有者收到固定內文、reply=no、每節點每小時 1 封、沒有擁有者不寄。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261104090000_waiting_notice.sql'
const SIG = 'asn_relay_waiting_notice(text)'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))

test('靜態：只收節點、只授權 service_role、內文寫死、回復檔只 drop 函式', () => {
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /asn_relay_waiting_notice\(p_node text\)\s+returns jsonb/, '沒有其他參數')
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(mig, /v_agent constant text := '[^']*收發室';/)
  assert.match(mig, /public\.asn_relay_send\(p_node, v_agent, public\.asn_person_alias\(v_owner\), null, v_body, null, false, null, false\)/, 'reply=no、收件人由後台決定')
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /grant [^;]*to (anon|authenticated|public)|drop |create table|alter table|truncate/i)
  assert.ok(down.includes(`drop function if exists public.${SIG};`))
  assert.doesNotMatch(down, /drop column|drop table/i)
})

test('靜態：relay 動作不讀請求內容，節點取自金鑰', () => {
  const src = rd(fs.readFileSync(new URL('../supabase/functions/relay/index.ts', import.meta.url), 'utf8'))
  const i = src.indexOf('if (action === "waiting_notice"')
  assert.ok(i >= 0)
  const blk = src.slice(i, src.indexOf('\n  }\n', i))
  assert.ok(blk.includes('db.rpc("asn_relay_waiting_notice", { p_node: me.id })'))
  assert.ok(!blk.includes('req.json'), '不接受任何用戶端內容')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const OWNER_A = 'bbbbbbbb-0000-0000-0000-00000000000a'
const OWNER_B = 'bbbbbbbb-0000-0000-0000-00000000000b'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid, name text);
    create table relay.messages(id uuid default gen_random_uuid() primary key, fanout_id uuid, from_node text, from_agent text, to_node text, body text, expects_reply boolean, created_at timestamptz default now());
    insert into relay.nodes(id, owner_user, name) values ('H', '${OWNER_A}', '家用機'), ('P', '${OWNER_B}', E'手\\n機'), ('W', '${OWNER_A}', '工作機'), ('X', null, '沒有主人'), ('F', '${OWNER_A}', '會失敗');
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select n <> 'W' $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:' || right(u::text, 4) $$;
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      begin if a = 'F' then return jsonb_build_object('error', 'boom'); end if; insert into relay.messages(from_node, from_agent, to_node, body, expects_reply) values (a, b, c, e, g); return jsonb_build_object('ok', true, 'bell_topics', jsonb_build_array('bell-1')); end $$;`)
  await db.exec(mig)
  return db
}
const notice = async (db, node) => (await db.query('select public.asn_relay_waiting_notice($1) r', [node])).rows[0].r
const msgs = async (db, node) => (await db.query('select from_agent, to_node, body, expects_reply from relay.messages where from_node = $1', [node])).rows

test('實跑（pglite）：擁有者收到固定內文，reply=no，寄件名以收發室結尾，設備名去控制字元', { skip }, async () => {
  const db = await setup()
  const r = await notice(db, 'H')
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['bell-1']])
  const m = await msgs(db, 'H')
  assert.equal(m.length, 1)
  assert.equal(m[0].to_node, 'u:000a')
  assert.equal(m[0].expects_reply, false)
  assert.ok(m[0].from_agent.endsWith('收發室'))
  assert.equal(m[0].body, '這台（家用機）有夥伴在等你到電腦前確認。')
  await notice(db, 'P')
  assert.equal((await msgs(db, 'P'))[0].body, '這台（手機）有夥伴在等你到電腦前確認。')
  assert.equal((await msgs(db, 'P'))[0].to_node, 'u:000b', '別的節點的擁有者是另一個人')
})

test('實跑（pglite）：限額到了不寄，每節點每小時 1 封，過一小時重新計', { skip }, async () => {
  const db = await setup()
  assert.equal((await notice(db, 'H')).notify, 'sent')
  assert.equal((await notice(db, 'H')).notify, 'rate_limited')
  assert.equal((await msgs(db, 'H')).length, 1)
  assert.equal((await notice(db, 'P')).notify, 'sent', '另一個節點有自己的額度')
  await db.exec(`update relay.messages set created_at = now() - interval '2 hours' where from_node = 'H'`)
  assert.equal((await notice(db, 'H')).notify, 'sent')
})

test('實跑（pglite）：沒有擁有者或核對不過不寄；節點不存在或停用 forbidden；寄送失敗回 failed', { skip }, async () => {
  const db = await setup()
  assert.equal((await notice(db, 'X')).notify, 'skipped', '沒有擁有者')
  assert.equal((await notice(db, 'W')).notify, 'skipped', '擁有者核對不過')
  assert.equal((await msgs(db, 'X')).length + (await msgs(db, 'W')).length, 0)
  assert.deepEqual(await notice(db, 'NOPE'), { error: 'forbidden' })
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'P'`)
  assert.deepEqual(await notice(db, 'P'), { error: 'forbidden' })
  const f = await notice(db, 'F')
  assert.deepEqual([f.ok, f.notify, f.bell_topics], [true, 'failed', []])
})
