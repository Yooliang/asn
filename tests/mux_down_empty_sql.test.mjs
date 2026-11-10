// 終端服務停了也要通知（20261112200000_mux_down_empty.sql）：p_count = 0 用新句型，1～100 一字不改。
// 靜態：security definer＋search_path 空、只授權 service_role；回復檔逐字等於通知集中那一版。實跑（pglite，沒裝就略過）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const mig = rd(fs.readFileSync(new URL('20261112200000_mux_down_empty.sql', DIR), 'utf8'))
const prev = rd(fs.readFileSync(new URL('20261111100000_notice_center.sql', DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261112200000_mux_down_empty_down.sql', import.meta.url), 'utf8'))
const fnBlock = s => {
  const i = s.indexOf('create or replace function public.asn_relay_mux_down_notice(')
  return s.slice(i, s.indexOf('$function$;', s.indexOf('as $function$', i)) + '$function$;'.length)
}

test('靜態：只改這一支、security definer、search_path 空、只授權 service_role；回復檔逐字換回', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.equal((body.match(/create or replace function/g) ?? []).length, 1)
  assert.match(fnBlock(body), /security definer\n set search_path to ''/)
  assert.match(body, /revoke all on function public\.asn_relay_mux_down_notice\(text, integer, boolean\) from public, anon, authenticated;/)
  assert.match(body, /grant execute on function public\.asn_relay_mux_down_notice\(text, integer, boolean\) to service_role;/)
  assert.equal(fnBlock(down), fnBlock(prev))
  // 1～100 的兩句一字不改
  for (const t of ["'：終端服務中斷了' || E'\\n' || p_count || ' 位夥伴受影響，ASN 正在自動接回。'", "'：終端服務短時間內又中斷了' || E'\\n' || p_count || ' 位夥伴受影響。"]) {
    assert.ok(fnBlock(mig).includes(t) && fnBlock(prev).includes(t), t)
  }
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const A = 'aaaaaaaa-0000-0000-0000-00000000000a'

async function boot(sql) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, status text default 'active', owner_user uuid);
    create table relay.sent(node text, topic text, body text);
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select u is not null $$;
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_max integer, p_win interval) returns jsonb language plpgsql as $$
      begin insert into relay.sent values (p_node, p_topic, p_body); return jsonb_build_object('notify', 'sent', 'bell_topics', '[]'::jsonb); end $$;
    insert into relay.nodes(id, name, owner_user) values ('H', '30家用', '${A}');`)
  await db.exec(sql)
  const q = async (t, a) => (await db.query(t, a)).rows
  const call = async (n, r) => (await q('select public.asn_relay_mux_down_notice($1, $2, $3) r', ['H', n, r]))[0].r
  const last = async () => (await q('select topic, body from relay.sent order by ctid desc limit 1'))[0]
  return { call, last }
}

test('實跑：0 位夥伴＝「這台的終端服務停了」；1～100 照舊；範圍外照舊擋', { skip }, async () => {
  const { call, last } = await boot(mig)
  assert.equal((await call(0, false)).notify, 'sent')
  assert.deepEqual(await last(), { topic: 'mux_down', body: '30家用：這台的終端服務停了\n目前沒有夥伴在裡面，不用接回；下次開夥伴時會自動重新啟動。' })
  assert.equal((await call(0, true)).notify, 'sent', '0 位時有沒有接回都一樣')
  assert.match((await last()).body, /^30家用：這台的終端服務停了\n/)
  await call(2, true)
  assert.equal((await last()).body, '30家用：終端服務中斷了\n2 位夥伴受影響，ASN 正在自動接回。')
  for (const [n, r] of [[-1, false], [101, true], [null, true], [1, null]]) assert.equal((await call(n, r)).error, 'bad_request', `${n} ${r}`)
})

test('實跑：回復檔跑回去後 0 位又被擋（舊版行為）', { skip }, async () => {
  const { call } = await boot(mig + '\n' + down)
  assert.equal((await call(0, false)).error, 'bad_request')
  assert.equal((await call(1, true)).notify, 'sent')
})
