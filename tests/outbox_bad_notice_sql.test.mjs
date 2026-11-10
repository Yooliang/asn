// 橋的回信寄件匣存檔壞了，通知本人（20261112900000_outbox_bad_notice.sql，Yooliang/asn#1249）。
// 靜態：security definer＋search_path 空、只授權 service_role、固定內文、限頻參數、down 檔。實跑（pglite，沒裝就略過）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL('../supabase/migrations/20261112900000_outbox_bad_notice.sql', import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261112900000_outbox_bad_notice_down.sql', import.meta.url), 'utf8'))
const BODY = '這台電腦的回信寄件匣檔案壞了，裡面還沒寄出的回信無法再寄，可能有夥伴的回信沒送到對方。'

test('靜態：一支函式、security definer、search_path 空、只授權 service_role、固定內文與限頻', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.equal((body.match(/create or replace function/g) ?? []).length, 1)
  assert.match(body, /create or replace function public\.asn_relay_outbox_bad_notice\(p_node text\)/)
  assert.match(body, /security definer\n set search_path to ''/)
  assert.match(body, /revoke all on function public\.asn_relay_outbox_bad_notice\(text\) from public, anon, authenticated;/)
  assert.match(body, /grant execute on function public\.asn_relay_outbox_bad_notice\(text\) to service_role;/)
  assert.doesNotMatch(body, /to (public|anon|authenticated)\b/)
  assert.match(body, /asn_relay_send_notice\(p_node, 'outbox_bad', v_body, 1, interval '1 hour'\)/, '同一台每小時一則')
  assert.ok(body.includes(`'${BODY}'`), '內文固定')
  assert.equal((body.match(/\(p_node text\)/g) ?? []).length, 1, '只有 p_node 一個參數，沒有可帶文字的參數')
  assert.match(down, /drop function if exists public\.asn_relay_outbox_bad_notice\(text\);/)
  assert.ok(!/create or replace/.test(down))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const A = 'aaaaaaaa-0000-0000-0000-00000000000a'

async function boot(sql) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, status text default 'active', owner_user uuid);
    create table relay.sent(node text, topic text, body text, max_n int, win text);
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select u is not null $$;
    -- 假的通知函式：記下參數；依 p_max 以同節點同種類的筆數限流（真實限流在 notice_center_sql 測）
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_max integer, p_win interval) returns jsonb language plpgsql as $$
      begin
        if (select count(*) from relay.sent where node = p_node and topic = p_topic) >= p_max then
          return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb);
        end if;
        insert into relay.sent values (p_node, p_topic, p_body, p_max, p_win::text);
        return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', '[]'::jsonb);
      end $$;
    insert into relay.nodes(id, name, owner_user) values ('H', '30家用', '${A}'), ('NOOWNER', '無主', null);
    insert into relay.nodes(id, name, status, owner_user) values ('OFF', '停用', 'disabled', '${A}');`)
  await db.exec(sql)
  const q = async (t, a) => (await db.query(t, a)).rows
  const call = async n => (await q('select public.asn_relay_outbox_bad_notice($1) r', [n]))[0].r
  const sent = async () => q('select node, topic, body, max_n, win from relay.sent order by ctid')
  return { db, q, call, sent }
}

test('實跑：有擁有者才寄；種類、內文、限頻參數正確；內文不含任何回信資料', { skip }, async () => {
  const { call, sent } = await boot(mig)
  assert.equal((await call('H')).notify, 'sent')
  assert.deepEqual(await sent(), [{ node: 'H', topic: 'outbox_bad', body: BODY, max_n: 1, win: '01:00:00' }])
})

test('實跑：同一台每小時最多一則（第二次被限流）', { skip }, async () => {
  const { call, sent } = await boot(mig)
  assert.equal((await call('H')).notify, 'sent')
  assert.equal((await call('H')).notify, 'rate_limited')
  assert.equal((await sent()).length, 1)
})

test('實跑：節點沒有擁有者不寄；找不到或停用的節點回 forbidden', { skip }, async () => {
  const { call, sent } = await boot(mig)
  const r = await call('NOOWNER')
  assert.equal(r.ok, true)
  assert.equal(r.notify, 'skipped')
  assert.equal((await call('沒有這台')).error, 'forbidden')
  assert.equal((await call('OFF')).error, 'forbidden')
  assert.equal((await sent()).length, 0)
})

test('實跑：只有 service_role 能呼叫', { skip }, async () => {
  const { db } = await boot(mig)
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select public.asn_relay_outbox_bad_notice('H')`), /permission denied/, role)
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  const r = (await db.query(`select public.asn_relay_outbox_bad_notice('H') r`)).rows[0].r
  await db.exec('reset role')
  assert.equal(r.notify, 'sent')
})

test('實跑：down 檔跑下去函式就不見', { skip }, async () => {
  const { db, call } = await boot(mig)
  assert.equal((await call('H')).notify, 'sent')
  await db.exec(down)
  const n = (await db.query(`select count(*)::int n from pg_proc where proname = 'asn_relay_outbox_bad_notice'`)).rows[0].n
  assert.equal(n, 0)
  await assert.rejects(() => call('H'), /does not exist/)
})
