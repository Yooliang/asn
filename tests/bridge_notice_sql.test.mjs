// 通知集中 PR-D（20261111110000_bridge_notice.sql，#848）：橋通知由後台以「ASN 通知」寄出。
// 涵蓋：授權、只能回覆寄給本節點 24 小時內的信、收件人取自原信、原信是通知不回、跨帳號回 cross_account、
// 內文清控制字元與長度、第一行加設備名、kind 寫在每一列、每封原信最多 3 封、每小時 120 封。沒裝 @electric-sql/pglite 時只跑靜態部分。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const notice = rd(fs.readFileSync(new URL('20261111100000_notice_center.sql', DIR), 'utf8'))
const mig = rd(fs.readFileSync(new URL('20261111110000_bridge_notice.sql', DIR), 'utf8'))
const SIG = 'asn_relay_send_bridge_notice(text, uuid, text)'

test('靜態：只授權 service_role；security definer、search_path 空；排在 notice_center 之後', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.ok(body.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(body.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(body, /security definer\s+set search_path to ''/)
  assert.ok(fs.readdirSync(DIR).sort().indexOf('20261111110000_bridge_notice.sql') > fs.readdirSync(DIR).sort().indexOf('20261111100000_notice_center.sql'))
  assert.doesNotMatch(body, /create or replace function public\.asn_relay_send(_core|_notice)?\(/, '不改寄信函式與 PR-C 的共用函式')
})

let PGlite = null
try { PGlite = await fastPGlite() } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const A = 'aaaaaaaa-0000-0000-0000-00000000000a'
const B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const T1 = 'cccccccc-0000-0000-0000-000000000001'
const FN = 'public.asn_relay_send_bridge_notice'

async function boot() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid, owner_name text);
    create table relay.nodes(id text primary key, name text, machine text, kind text, platform text, status text default 'active', owner_user uuid,
      tenant_id uuid, last_seen_at timestamptz, inbox_hold_until timestamptz);
    create table relay.messages(id uuid primary key default gen_random_uuid(), fanout_id uuid, from_node text, from_agent text, to_node text, to_agent text,
      body text, expects_reply boolean, created_at timestamptz default now(), acked_at timestamptz, delivered_at timestamptz, tenant_id uuid, person_user uuid,
      reply_to uuid, voice boolean not null default false, owner_signed boolean not null default false, to_partner_id text, from_partner_id text);
    create table relay.roster(node text, name text, engine text);
    create table relay.partners(partner_id text, tenant_id uuid);
    create table relay.inbox_watch(node text primary key, state text not null default 'ok', level text not null default '0', last_count integer not null default 0,
      last_oldest_at timestamptz, stuck_since timestamptz, notified_at timestamptz, recovered_at timestamptz, updated_at timestamptz not null default now());
    create table relay.inbox_watch_log(id bigint generated always as identity primary key, node text, at timestamptz default now(), from_state text, to_state text,
      note text, cnt integer, oldest_at timestamptz, stuck_since timestamptz);
    create table relay.term_views(id uuid primary key default gen_random_uuid(), from_node text, to_node text, status text, scope text, window_name text, notified_at timestamptz);
    create table relay.device_key_alerts(node text, peer text, kind text, sent_at timestamptz default now(), primary key (node, peer, kind));
    create function relay.person_view_node(t uuid, n text, a text, p uuid) returns text language sql as $$ select n $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:' || right(u::text, 4) $$;
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select u is not null and n <> 'W' $$;
    create function public.asn_relay_acct_email_ok(e text) returns boolean language sql as $$ select true $$;
    -- 寄信函式的替身：寄到 FAN 時扇出三列（共用 fanout_id），從 REFUSED 寄回錯誤，其餘一列；reply_to 照存
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      declare v_head uuid := gen_random_uuid(); v_i int; begin
        if a = 'REFUSED' then return jsonb_build_object('error', 'unknown_to_node'); end if;
        if c = 'FAN' then
          insert into relay.messages(id, fanout_id, from_node, from_agent, to_node, to_agent, body, expects_reply, reply_to) values (v_head, v_head, a, b, c, d, e, g, f);
          for v_i in 1..2 loop insert into relay.messages(fanout_id, from_node, from_agent, to_node, to_agent, body, expects_reply, reply_to) values (v_head, a, b, c, d, e, g, f); end loop;
          return jsonb_build_object('id', v_head, 'bell_topic', 'b1', 'bell_topics', jsonb_build_array('b1', 'b2'), 'fanout', 3);
        end if;
        insert into relay.messages(id, from_node, from_agent, to_node, to_agent, body, expects_reply, reply_to) values (v_head, a, b, c, d, e, g, f);
        return jsonb_build_object('id', v_head, 'bell_topic', 'b1'); end $$;
    insert into relay.tenants values ('${T1}', '${A}', '本人');
    insert into relay.nodes(id, name, machine, owner_user, tenant_id) values
      ('H', '家用機', '家用機', '${A}', '${T1}'), ('P', '筆電', null, '${A}', '${T1}'), ('FAN', '扇出', null, '${A}', '${T1}'),
      ('N', null, null, '${A}', '${T1}'), ('REFUSED', '被拒機', null, '${A}', '${T1}'), ('W', '核對不過', null, '${A}', '${T1}'),
      ('E', '別人的機', null, '${B}', '${T1}'), ('X', '無主', null, null, '${T1}');`)
  await db.exec(notice)
  await db.exec(mig)
  const q = async (t, a) => (await db.query(t, a)).rows
  return { db, q }
}
const one = async (q, t, a) => (await q(t, a))[0]
/** 寄一封 from → to 的原信，回 id */
const orig = async (q, from, to, { agent = '小乙', kind = null, ago = '0 minutes' } = {}) =>
  (await one(q, `insert into relay.messages(from_node, from_agent, to_node, to_agent, body, kind, created_at) values ($1, $2, $3, '收件窗', '原信', $4, now() - $5::interval) returning id`, [from, agent, to, kind, ago])).id
const call = (q, node, reply, body) => one(q, `select ${FN}($1, $2::uuid, $3) r`, [node, reply, body]).then(x => x.r)

test('實跑（pglite）：只授權 service_role', { skip }, async () => {
  const { q } = await boot()
  assert.equal((await one(q, `select has_function_privilege('service_role', 'public.${SIG}', 'EXECUTE') p`)).p, true)
  for (const role of ['anon', 'authenticated']) assert.equal((await one(q, `select has_function_privilege($1, 'public.${SIG}', 'EXECUTE') p`, [role])).p, false, role)
})

test('實跑（pglite）：寄件人「ASN 通知」、收件人取自原信（寄件節點與視窗）、不等回信、回覆原信、第一行加設備名、kind 寫上', { skip }, async () => {
  const { q } = await boot()
  const id = await orig(q, 'P', 'H')
  const r = await call(q, 'H', id, '還沒接回來，信先留著')
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['b1']])
  const m = await one(q, `select from_node, from_agent, to_node, to_agent, body, expects_reply, reply_to, kind from relay.messages where id = $1`, [r.id])
  assert.deepEqual(m, { from_node: 'H', from_agent: 'ASN 通知', to_node: 'P', to_agent: '小乙', body: '家用機：還沒接回來，信先留著', expects_reply: false, reply_to: id, kind: 'notice:bridge' })
  // 沒有設備名：未命名設備；原信沒有寄件視窗：收件視窗是空
  const id2 = await orig(q, 'H', 'N', { agent: '' })
  const r2 = await call(q, 'N', id2, '內文')
  const m2 = await one(q, `select to_agent, body from relay.messages where id = $1`, [r2.id])
  assert.deepEqual(m2, { to_agent: null, body: '未命名設備：內文' })
})

test('實跑（pglite）：第一行的設備名先用 name（使用者取的名字），沒有才用 machine（設備種類）', { skip }, async () => {
  const { q } = await boot()
  await q(`update relay.nodes set name = '書房', machine = '電腦' where id = 'H'`)
  await q(`update relay.nodes set name = '  ', machine = '電腦' where id = 'N'`)
  const a = await call(q, 'H', await orig(q, 'P', 'H'), '甲')
  const b = await call(q, 'N', await orig(q, 'P', 'N'), '乙')
  assert.equal((await one(q, `select body from relay.messages where id = $1`, [a.id])).body, '書房：甲', '不是「電腦：」')
  assert.equal((await one(q, `select body from relay.messages where id = $1`, [b.id])).body, '電腦：乙', '沒有名字才用設備種類')
})

test('實跑（pglite）：扇出的每一列都標 kind；扇出的回傳交給 Edge 決定推播', { skip }, async () => {
  const { q } = await boot()
  const id = await orig(q, 'FAN', 'H')
  const r = await call(q, 'H', id, '扇出')
  assert.deepEqual([r.notify, r.bell_topics, r.fanout], ['sent', ['b1', 'b2'], 3])
  const kinds = await q(`select kind from relay.messages where body = '家用機：扇出'`)
  assert.equal(kinds.length, 3)
  for (const k of kinds) assert.equal(k.kind, 'notice:bridge')
})

test('實跑（pglite）：只能回覆寄給本節點、24 小時內的信；原信是通知或「ASN 通知」寄的不回', { skip }, async () => {
  const { q } = await boot()
  assert.deepEqual(await call(q, 'H', await orig(q, 'P', 'N'), 'x'), { error: 'no_origin' }, '不是寄給這台的')
  assert.deepEqual(await call(q, 'H', await orig(q, 'P', 'H', { ago: '25 hours' }), 'x'), { error: 'no_origin' }, '超過 24 小時')
  assert.deepEqual(await call(q, 'H', 'dddddddd-0000-0000-0000-000000000000', 'x'), { error: 'no_origin' }, '沒有這封')
  assert.deepEqual(await call(q, 'H', await orig(q, 'P', 'H', { kind: 'notice:login' }), 'x'), { error: 'is_notice' })
  assert.deepEqual(await call(q, 'H', await orig(q, 'P', 'H', { kind: 'notice:bridge' }), 'x'), { error: 'is_notice' }, '兩台橋不會互相回成迴圈')
  assert.deepEqual(await call(q, 'H', await orig(q, 'P', 'H', { agent: 'ASN 通知' }), 'x'), { error: 'is_notice' })
  assert.equal((await one(q, `select count(*)::int c from relay.messages where from_agent = 'ASN 通知' and from_node = 'H'`)).c, 0)
})

test('實跑（pglite）：跨帳號（原寄件節點的擁有者不同、沒有擁有者、核對不過）一律 cross_account，不寄', { skip }, async () => {
  const { q } = await boot()
  assert.deepEqual(await call(q, 'H', await orig(q, 'E', 'H'), 'x'), { error: 'cross_account' }, '別的帳號寄來的')
  assert.deepEqual(await call(q, 'H', await orig(q, 'X', 'H'), 'x'), { error: 'cross_account' }, '寄件節點沒有擁有者')
  assert.deepEqual(await call(q, 'H', await orig(q, 'W', 'H'), 'x'), { error: 'cross_account' }, '寄件節點核對不過')
  assert.deepEqual(await call(q, 'X', await orig(q, 'H', 'X'), 'x'), { error: 'cross_account' }, '這台自己沒有擁有者')
  assert.deepEqual(await call(q, 'E', await orig(q, 'H', 'E'), 'x'), { error: 'cross_account' }, '反過來也一樣')
  assert.equal((await one(q, `select count(*)::int c from relay.messages where kind = 'notice:bridge'`)).c, 0)
})

test('實跑（pglite）：驗證——停用或不存在的節點、空內文、控制字元清掉、長度上限', { skip }, async () => {
  const { q } = await boot()
  const id = await orig(q, 'P', 'H')
  assert.deepEqual(await call(q, 'NOPE', id, 'x'), { error: 'forbidden' })
  await q(`update relay.nodes set status = 'revoked' where id = 'N'`)
  assert.deepEqual(await call(q, 'N', await orig(q, 'P', 'N'), 'x'), { error: 'forbidden' })
  for (const b of ['', '   ', '\u0001\u0007', null]) assert.deepEqual(await call(q, 'H', id, b), { error: 'bad_body' }, JSON.stringify(b))
  assert.deepEqual(await call(q, 'H', id, 'x'.repeat(19937)), { error: 'bad_body' })
  const r = await call(q, 'H', id, '甲\u0000乙\u001b[31m丙\r\n丁\t戊\u007f'.replace('\u0000', ''))
  assert.equal((await one(q, `select body from relay.messages where id = $1`, [r.id])).body, '家用機：甲乙[31m丙\n丁\t戊', '控制字元清掉、換行與 tab 留著')
  const long = await call(q, 'H', await orig(q, 'P', 'H'), 'x'.repeat(19936))
  assert.equal(long.notify, 'sent', '剛好上限可以')
  assert.ok((await one(q, `select char_length(body) n from relay.messages where id = $1`, [long.id])).n <= 20000)
  assert.deepEqual([(await call(q, 'REFUSED', await orig(q, 'P', 'REFUSED'), 'x')).notify], ['failed'])
})

test('實跑（pglite）：同一封原信最多回 3 封；每小時 120 封；改寄件名不會讓限流失效', { skip }, async () => {
  const { q } = await boot()
  const id = await orig(q, 'P', 'H')
  for (let i = 0; i < 3; i++) assert.equal((await call(q, 'H', id, `第 ${i} 封`)).notify, 'sent')
  const r = await call(q, 'H', id, '第 4 封')
  assert.deepEqual([r.notify, r.bell_topics], ['per_mail_limit', []])
  await q(`update relay.messages set from_agent = '改過' where kind = 'notice:bridge'`)
  assert.equal((await call(q, 'H', id, '再一封')).notify, 'per_mail_limit')
  // 每小時：灌到 120 封
  await q(`insert into relay.messages(from_node, from_agent, to_node, body, kind) select 'H', 'ASN 通知', 'P', 'x', 'notice:bridge' from generate_series(1, 117)`)
  assert.equal((await call(q, 'H', await orig(q, 'P', 'H'), 'x')).notify, 'rate_limited')
  assert.equal((await call(q, 'P', await orig(q, 'H', 'P'), 'x')).notify, 'sent', '另一個節點各算各的')
  await q(`update relay.messages set created_at = now() - interval '2 hours' where from_node = 'H' and kind = 'notice:bridge'`)
  assert.equal((await call(q, 'H', await orig(q, 'P', 'H'), 'x')).notify, 'sent', '過了一小時重新計')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
