// 夥伴卡在框上的通知（20261104140000_waiting_notice.sql）：靜態檢查與 pglite 實跑。
// 2. 實跑（有安裝 @electric-sql/pglite 時）：擁有者收到固定內文、reply=no、每節點每小時 1 封、沒有擁有者不寄。
import { track, closeAtEnd } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261104140000_waiting_notice.sql'
const SIG = 'asn_relay_waiting_notice(text, text, text, text, text)'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))

test('靜態：只授權 service_role、回復檔只 drop 函式、權限框不寫內容', () => {
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(mig, /v_agent constant text := '[^']*收發室';/)
  assert.match(mig, /if p_kind = 'input' and/, '只有選擇框才寫內容')
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /grant [^;]*to (anon|authenticated|public)|drop |create table|alter table|truncate/i)
  assert.ok(down.includes(`drop function if exists public.${SIG};`))
  assert.doesNotMatch(down, /drop column|drop table/i)
})

test('靜態：relay 動作先驗證內容，節點取自金鑰', () => {
  const src = rd(fs.readFileSync(new URL('../supabase/functions/relay/index.ts', import.meta.url), 'utf8'))
  const i = src.indexOf('if (action === "waiting_notice"')
  assert.ok(i >= 0)
  const blk = src.slice(i, src.indexOf('\n  }\n', i))
  assert.ok(blk.includes('parseWaitingNotice('))
  assert.ok(blk.includes('p_node: me.id'))
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
    insert into relay.nodes(id, owner_user, name) values ('H', '${OWNER_A}', '家用機'), ('P', '${OWNER_B}', E'手\\n機'), ('W', '${OWNER_A}', '工作機'), ('X', null, '沒有主人'), ('F', '${OWNER_A}', '會失敗');
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select n <> 'W' $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:' || right(u::text, 4) $$;
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      begin if a = 'F' then return jsonb_build_object('error', 'boom'); end if; insert into relay.messages(from_node, from_agent, to_node, body, expects_reply) values (a, b, c, e, g); return jsonb_build_object('ok', true, 'bell_topics', jsonb_build_array('bell-1')); end $$;`)
  await db.exec(mig)
  return db
}
const notice = async (db, node, kind = 'permission', detail = null, win = '小乙', tool = null) => (await db.query('select public.asn_relay_waiting_notice($1, $2, $3, $4, $5) r', [node, win, kind, detail, tool])).rows[0].r
const msgs = async (db, node) => (await db.query('select from_agent, to_node, body, expects_reply from relay.messages where from_node = $1', [node])).rows

test('實跑（pglite）：內文有設備、視窗、種類；權限框不寫內容；選擇框寫問題；reply=no', { skip }, async () => {
  const db = await setup()
  const r = await notice(db, 'H', 'permission', 'rm -rf /')
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['bell-1']])
  const m = await msgs(db, 'H')
  assert.equal(m[0].to_node, 'u:000a')
  assert.equal(m[0].expects_reply, false)
  assert.ok(m[0].from_agent.endsWith('收發室'))
  assert.equal(m[0].body, '這台（家用機）的夥伴「小乙」在等你確認（權限），已經等超過 2 分鐘。')
  await db.exec(`delete from relay.messages`)
  await notice(db, 'H', 'permission', null, '小乙', 'Bash')
  assert.equal((await msgs(db, 'H'))[0].body, '這台（家用機）的夥伴「小乙」在等你確認（權限：Bash），已經等超過 2 分鐘。')
  await db.exec(`delete from relay.messages`)
  await notice(db, 'H', 'permission', null, '小乙', 'rm -rf /')
  assert.equal((await msgs(db, 'H'))[0].body, '這台（家用機）的夥伴「小乙」在等你確認（權限），已經等超過 2 分鐘。', '不合格的工具名不寫')
  await notice(db, 'P', 'input', '問題：要選哪一個？；選項：甲、乙')
  assert.equal((await msgs(db, 'P'))[0].body, '這台（手機）的夥伴「小乙」在等你回答，已經等超過 2 分鐘。\n問題：要選哪一個？；選項：甲、乙')
  assert.equal((await msgs(db, 'P'))[0].to_node, 'u:000b', '別的節點的擁有者是另一個人')
})

test('實跑（pglite）：每節點每小時 6 封，過一小時重新計', { skip }, async () => {
  const db = await setup()
  for (let i = 0; i < 6; i++) assert.equal((await notice(db, 'H')).notify, 'sent')
  assert.equal((await notice(db, 'H')).notify, 'rate_limited')
  assert.equal((await msgs(db, 'H')).length, 6)
  assert.equal((await notice(db, 'P')).notify, 'sent', '另一個節點有自己的額度')
  await db.exec(`update relay.messages set created_at = now() - interval '2 hours' where from_node = 'H'`)
  assert.equal((await notice(db, 'H')).notify, 'sent')
})

test('實跑（pglite）：沒有擁有者或核對不過不寄；節點不存在或停用 forbidden；種類或視窗不對 bad_request；寄送失敗回 failed', { skip }, async () => {
  const db = await setup()
  assert.equal((await notice(db, 'X')).notify, 'skipped', '沒有擁有者')
  assert.equal((await notice(db, 'W')).notify, 'skipped', '擁有者核對不過')
  assert.equal((await msgs(db, 'X')).length + (await msgs(db, 'W')).length, 0)
  assert.deepEqual(await notice(db, 'NOPE'), { error: 'forbidden' })
  assert.deepEqual(await notice(db, 'H', 'nope'), { error: 'bad_request' })
  assert.deepEqual(await notice(db, 'H', 'input', null, ' '), { error: 'bad_request' })
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'P'`)
  assert.deepEqual(await notice(db, 'P'), { error: 'forbidden' })
  const f = await notice(db, 'F')
  assert.deepEqual([f.ok, f.notify, f.bell_topics], [true, 'failed', []])
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
