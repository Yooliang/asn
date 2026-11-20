// 終端服務接回結果通知（20261120100000_mux_resume_notice.sql，#1818）：靜態＋實跑（pglite，沒裝就略過）。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL('../supabase/migrations/20261120100000_mux_resume_notice.sql', import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261120100000_mux_resume_notice_down.sql', import.meta.url), 'utf8'))
const old = rd(fs.readFileSync(new URL('../supabase/migrations/20261112200000_mux_down_empty.sql', import.meta.url), 'utf8'))

test('靜態：security definer、search_path 空、只授權 service_role、放在 mux_down 種類；原本的函式沒動；回復檔 drop 它', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.equal((body.match(/create or replace function/g) ?? []).length, 1)
  assert.match(body, /security definer\n set search_path to ''/)
  assert.match(body, /revoke all on function public\.asn_relay_mux_resume_notice\(text, integer, integer, text\[\]\) from public, anon, authenticated;/)
  assert.match(body, /grant execute on function public\.asn_relay_mux_resume_notice\(text, integer, integer, text\[\]\) to service_role;/)
  assert.match(body, /asn_relay_send_notice\(p_node, 'mux_down', v_body, 6, interval '1 hour'\)/, '不另開新種類')
  assert.doesNotMatch(body, /asn_relay_mux_down_notice/, '原本的通知函式不動')
  assert.match(down, /drop function if exists public\.asn_relay_mux_resume_notice\(text, integer, integer, text\[\]\);/)
  assert.ok(old.includes('asn_relay_mux_down_notice'))
})

const PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const A = 'aaaaaaaa-0000-0000-0000-00000000000a'

async function boot(sql) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, status text default 'active', owner_user uuid);
    create table relay.sent(node text, topic text, body text);
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select u is not null $$;
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_max integer, p_win interval) returns jsonb language plpgsql as $$
      begin insert into relay.sent values (p_node, p_topic, p_body); return jsonb_build_object('notify', 'sent', 'bell_topics', '[]'::jsonb); end $$;
    insert into relay.nodes(id, name, owner_user) values ('H', '30家用', '${A}');`)
  await db.exec(sql)
  const q = async (t, a) => (await db.query(t, a)).rows
  const call = async (n, r, f, node = 'H') => (await q('select public.asn_relay_mux_resume_notice($1, $2, $3, $4::text[]) r', [node, n, r, f]))[0].r
  const last = async () => (await q('select topic, body from relay.sent order by ctid desc limit 1'))[0]
  return { call, last }
}

test('實跑：全部接回／部分接回／都沒接回，三種句型，名字列出來', { skip }, async () => {
  const { call, last } = await boot(mig)
  assert.equal((await call(3, 3, [])).notify, 'sent')
  assert.deepEqual(await last(), { topic: 'mux_down', body: '30家用：終端服務中斷，夥伴已全部接回\n斷了 3 位，已接回 3 位。' })
  await call(3, 2, ['丙'])
  assert.equal((await last()).body, '30家用：終端服務中斷，部分夥伴還沒接回\n斷了 3 位，已接回 2 位。還沒接回：丙。請到「30家用」手動叫醒它們。')
  await call(2, 0, ['甲', '乙'])
  assert.equal((await last()).body, '30家用：終端服務中斷，夥伴沒有接回\n斷了 2 位，沒有接回：甲、乙。請到「30家用」手動叫醒它們。')
})

test('實跑：名字重新清過（控制字元、空白、過長、重複）；超過 8 位寫「等共 N 位」；不帶原因', { skip }, async () => {
  const { call, last } = await boot(mig)
  await call(3, 0, ['  甲\n乙 ', '甲\n乙', 'x'.repeat(60)])
  const b = (await last()).body
  assert.match(b, /沒有接回：甲乙、x{40}。/, b)
  assert.doesNotMatch(b, /\n.*\n/, '只有標題一行加內文一行')
  const ten = Array.from({ length: 10 }, (_, i) => `夥伴${i}`)
  await call(10, 0, ten)
  assert.match((await last()).body, /夥伴0、夥伴1、夥伴2、夥伴3、夥伴4、夥伴5、夥伴6、夥伴7等共 10 位。/)
})

test('實跑：人數對不上、範圍外回 bad_request；查不到節點 forbidden', { skip }, async () => {
  const { call } = await boot(mig)
  for (const [n, r, f] of [[0, 0, []], [101, 0, []], [2, 3, []], [3, 2, []], [2, 1, null], [2, null, ['a']]]) assert.equal((await call(n, r, f)).error, 'bad_request', `${n} ${r} ${f}`)
  assert.equal((await call(1, 1, [], '沒有這台')).error, 'forbidden')
})

test('實跑：回復檔跑回去後函式不見', { skip }, async () => {
  const { call } = await boot(mig + '\n' + down)
  await assert.rejects(() => call(1, 1, []))
})

closeAtEnd()
