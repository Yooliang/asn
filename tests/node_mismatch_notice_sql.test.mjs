// 雲端代理設定不對的本人通知（20261106130000_node_mismatch_notice.sql，#832）：靜態檢查與 pglite 實跑。
// 實跑驗：收件人是金鑰所屬節點的擁有者；設定的節點只有同擁有者、啟用中才寫出名字，否則寫「另一個節點」；
//         代理帶來的字不原樣進信；每節點每小時 1 封；同內容 24 小時不重寄；停用節點、格式不對不寄。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261106130000_node_mismatch_notice.sql'
const SIG = 'asn_relay_node_mismatch_notice(text, text)'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))

test('靜態：只授權 service_role、寄件名以收發室結尾、reply=no、回復檔只 drop 函式', () => {
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(mig, /v_agent constant text := '[^']*收發室';/)
  assert.match(mig, /public\.asn_relay_send\(p_node, v_agent, public\.asn_person_alias\(v_owner\), null, v_body, null, false, null, false\)/)
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /grant [^;]*to (anon|authenticated|public)|drop |create table|alter table|truncate/i)
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /\|\|\s*p_configured/, '代理帶來的字不能直接接進內文')
  assert.ok(down.includes(`drop function if exists public.${SIG};`))
})

test('靜態：relay 動作先驗證內容，節點取自金鑰，參數只有設定的節點', () => {
  const src = rd(fs.readFileSync(new URL('../supabase/functions/relay/index.ts', import.meta.url), 'utf8'))
  const i = src.indexOf('if (action === "node_mismatch_notice"')
  assert.ok(i >= 0)
  const block = src.slice(i, src.indexOf('\n  }\n', i))
  assert.ok(block.indexOf('parseNodeMismatchNotice(') >= 0 && block.indexOf('parseNodeMismatchNotice(') < block.indexOf('db.rpc('), '先驗證再呼叫')
  assert.ok(block.includes('p_node: me.id, p_configured: p.configured'))
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const A = 'bbbbbbbb-0000-0000-0000-00000000000a'
const B = 'bbbbbbbb-0000-0000-0000-00000000000b'

async function setup() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid, name text);
    create table relay.messages(id uuid default gen_random_uuid() primary key, from_node text, from_agent text, to_node text, body text, expects_reply boolean, created_at timestamptz default now());
    insert into relay.nodes(id, owner_user, name, status) values ('g1', '${A}', 'Grok', 'active'), ('g2', '${A}', 'Grok正見', 'active'),
      ('b1', '${B}', '別人的', 'active'), ('old', '${A}', '撤銷的', 'left'), ('F', '${A}', '會失敗', 'active');
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select true $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:' || right(u::text, 4) $$;
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      begin if a = 'F' then return jsonb_build_object('error', 'boom'); end if; insert into relay.messages(from_node, from_agent, to_node, body, expects_reply) values (a, b, c, e, g); return jsonb_build_object('id', gen_random_uuid(), 'bell_topics', jsonb_build_array('bell-1')); end $$;`)
  await db.exec(mig)
  return db
}
const notice = async (db, node, cfg) => (await db.query('select public.asn_relay_node_mismatch_notice($1, $2) r', [node, cfg])).rows[0].r
const msgs = async db => (await db.query('select from_node, from_agent, to_node, body, expects_reply from relay.messages order by created_at')).rows
const age = (db, h) => db.exec(`update relay.messages set created_at = now() - interval '${h} hours'`)

test('實跑：同擁有者的節點寫出名字，收件人是金鑰所屬節點的擁有者，reply=no', { skip }, async () => {
  const db = await setup()
  const r = await notice(db, 'g2', 'g1')
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['bell-1']])
  const [m] = await msgs(db)
  assert.deepEqual([m.from_node, m.to_node, m.expects_reply], ['g2', 'u:000a', false])
  assert.ok(m.from_agent.endsWith('收發室'))
  assert.equal(m.body, '有一台雲端代理啟動時發現設定不對：它設定的是「Grok」，但金鑰對到的是這台（Grok正見）。可能是貼上另一組設定時把金鑰蓋掉了。為了不用錯的身分收發信，它已經停下來；請把那邊的設定改回同一組再啟動。')
})

test('實跑：別人的、撤銷的、不存在的節點只寫「另一個節點」；代理帶的字不進信', { skip }, async () => {
  for (const cfg of ['b1', 'old', 'nope', 'g2']) {
    const db = await setup()
    assert.equal((await notice(db, 'g2', cfg)).notify, 'sent', cfg)
    const body = (await msgs(db))[0].body
    assert.match(body, /它設定的是另一個節點，/, cfg)
    assert.ok(!body.includes('別人的') && !body.includes('撤銷的') && !body.includes('nope'), cfg)
  }
  const db = await setup()
  for (const bad of [null, '', 'a b', '<b>x</b>', 'x'.repeat(33), '我的節點']) assert.equal((await notice(db, 'g2', bad)).error, 'bad_request', String(bad))
  assert.equal((await msgs(db)).length, 0)
})

test('實跑：每節點每小時 1 封；同內容 24 小時不重寄；別的節點不受影響', { skip }, async () => {
  const db = await setup()
  assert.equal((await notice(db, 'g2', 'g1')).notify, 'sent')
  assert.equal((await notice(db, 'g2', 'nope')).notify, 'rate_limited', '一小時內不管原因都不再寄')
  assert.equal((await notice(db, 'g1', 'g2')).notify, 'sent', '別的節點各自計')
  await age(db, 2)
  assert.equal((await notice(db, 'g2', 'g1')).notify, 'duplicate', '同內容 24 小時內不重寄')
  assert.equal((await notice(db, 'g2', 'nope')).notify, 'sent', '原因不同就寄')
  await age(db, 25)
  assert.equal((await notice(db, 'g2', 'g1')).notify, 'sent', '過了 24 小時可以再寄')
})

test('實跑：停用節點 forbidden；寄送失敗回 failed', { skip }, async () => {
  const db = await setup()
  assert.equal((await notice(db, 'old', 'g1')).error, 'forbidden')
  assert.equal((await notice(db, 'nope', 'g1')).error, 'forbidden')
  assert.equal((await notice(db, 'F', 'g1')).notify, 'failed')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
