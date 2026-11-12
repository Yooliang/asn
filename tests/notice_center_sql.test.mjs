// 通知集中（20261111100000_notice_center.sql，#848 PR-C 後台）：靜態檢查與 pglite 實跑。
// 涵蓋：kind 欄位與檢查式、asn_relay_send_notice 的驗證／權限／扇出標記／限流、九支通知函式的內文第一行與寄件名與 kind、
// 讀信函式多回 kind 與 from_owner、回復檔逐字等於上一版定義。沒裝 @electric-sql/pglite 時只跑靜態部分。
import { track, closeAtEnd } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261111100000_notice_center.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const mig = rd(fs.readFileSync(new URL(F, DIR), 'utf8'))
const rb = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261111100000_notice_center_revert.sql', import.meta.url), 'utf8'))
const NOTICE_SIG = 'asn_relay_send_notice(text, text, text, integer, interval)'

test('靜態：kind 欄位可空、無預設值；檢查式 NOT VALID 與 VALIDATE 分開成兩個敘述、驗證在另一個交易', () => {
  assert.match(mig, /alter table relay\.messages add column if not exists kind text;/)
  assert.doesNotMatch(mig, /add column[^;]*kind[^;]*(default|not null)/i)
  assert.match(mig, /add constraint messages_kind_check check \(kind is null or kind ~ '\^notice:\[a-z_\]\{1,30\}\$'\) not valid;/)
  assert.match(mig, /^alter table relay\.messages validate constraint messages_kind_check;$/m)
  const i = mig.indexOf('not valid;'), j = mig.indexOf('validate constraint messages_kind_check;')
  assert.ok(mig.slice(i, j).includes('\ncommit;\n'), 'VALIDATE 不和 ADD 同一個交易')
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /backfill/i)
})

test('靜態：asn_relay_send_notice 不授權給任何角色；sec definer、search_path 空；寄信函式沒有 kind 參數', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.ok(body.includes(`revoke all on function public.${NOTICE_SIG.replace('asn_relay_send_notice', 'asn_relay_send_notice')} from public, anon, authenticated, service_role;`))
  assert.doesNotMatch(body, /grant [^;]*asn_relay_send_notice/i)
  const start = body.indexOf('create or replace function public.asn_relay_send_notice(')
  assert.match(body.slice(start, start + 400), /security definer\s+set search_path to ''/)
  assert.doesNotMatch(body, /create or replace function public\.asn_relay_send(_core)?\(/, '寄信函式一個字都不動')
  assert.match(body, /char_length\(p_body\) < 1 or char_length\(p_body\) > 20000/, '內文長度規則同 asn_relay_send_core')
  const core = rd(fs.readFileSync(new URL('20261104190000_owner_mail_phone.sql', DIR), 'utf8'))
  assert.match(core, /char_length\(p_body\) < 1 or char_length\(p_body\) > 20000/)
})

test('靜態：九支函式都走 asn_relay_send_notice、不再用舊寄件名常數；每支的授權沿用 service_role', () => {
  const body = mig.replace(/^--.*$/gm, '')
  const map = { asn_relay_login_alert: 'login', asn_relay_inbox_watch: 'inbox_watch', asn_relay_set_inbox_hold: 'quota', asn_relay_misroute_notice: 'misroute',
    asn_relay_waiting_notice: 'waiting', asn_relay_mux_down_notice: 'mux_down', asn_relay_node_mismatch_notice: 'node_mismatch',
    asn_relay_term_view_notice: 'view', asn_relay_device_key_alert: 'device_key' }
  for (const [fn, topic] of Object.entries(map)) {
    const i = body.indexOf(`create or replace function public.${fn}(`)
    assert.ok(i >= 0, fn)
    const blk = body.slice(i, body.indexOf('$function$;', body.indexOf('as $function$', i)))
    assert.match(blk, new RegExp(`asn_relay_send_notice\\((p_node|r\\.id), '${topic}', v_body`), fn)
    assert.doesNotMatch(blk, /收發室';/, fn + ' 不再有舊寄件名常數')
    assert.doesNotMatch(blk, /asn_relay_send\(/, fn + ' 不直接寄信')
    assert.match(body, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`), fn)
  }
})

test('靜態：回復檔每個函式區塊都逐字等於某個舊 migration 裡的定義；不刪欄位不刪新函式', () => {
  const blocks = rb.match(/create or replace function [\s\S]*?\$function\$;/g) ?? []
  assert.equal(blocks.length, 13)
  const srcs = fs.readdirSync(DIR).filter(f => f < F).map(f => rd(fs.readFileSync(new URL(f, DIR), 'utf8')))
  for (const b of blocks) {
    const name = /function (public\.\w+)\(/.exec(b)[1]
    const raw = name === 'public.asn_relay_inbox_peek' ? b.replace('asn_relay_inbox_peek', 'irori_relay_inbox_peek') : b
    assert.ok(srcs.some(s => s.includes(raw)), `${name} 與舊定義不同`)
  }
  assert.doesNotMatch(rb.replace(/^--.*$/gm, ''), /drop (function|column|table|constraint)/i)
  assert.doesNotMatch(rb.replace(/^--.*$/gm, ''), /asn_relay_send_notice/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const A = 'aaaaaaaa-0000-0000-0000-00000000000a'
const B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const T1 = 'cccccccc-0000-0000-0000-000000000001'
const T2 = 'cccccccc-0000-0000-0000-000000000002'
const SEND_NOTICE = 'public.asn_relay_send_notice'

async function boot({ applyMig = true } = {}) {
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
    -- 寄信函式的替身：FAN 節點扇出三列（共用 fanout_id，第一列是頭），REFUSED 回錯誤物件，其餘一列
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      declare v_head uuid := gen_random_uuid(); v_i int; begin
        if a = 'REFUSED' then return jsonb_build_object('error', 'unknown_to_node'); end if;
        if a = 'FAN' then
          insert into relay.messages(id, fanout_id, from_node, from_agent, to_node, body, expects_reply) values (v_head, v_head, a, b, c, e, g);
          for v_i in 1..2 loop insert into relay.messages(fanout_id, from_node, from_agent, to_node, body, expects_reply) values (v_head, a, b, c, e, g); end loop;
          return jsonb_build_object('id', v_head, 'bell_topic', 'b1', 'bell_topics', jsonb_build_array('b1', 'b2'), 'fanout', 3);
        end if;
        insert into relay.messages(id, from_node, from_agent, to_node, body, expects_reply) values (v_head, a, b, c, e, g);
        return jsonb_build_object('id', v_head, 'bell_topic', 'b1'); end $$;
    insert into relay.tenants values ('${T1}', '${A}', '本人'), ('${T2}', null, null);
    insert into relay.nodes(id, name, machine, owner_user, tenant_id, last_seen_at) values
      ('H', '家用機', '家用機', '${A}', '${T1}', now()), ('N', null, null, '${A}', '${T1}', null), ('P', '筆電', '筆電', '${A}', '${T1}', null),
      ('FAN', '扇出機', null, '${A}', '${T1}', null), ('REFUSED', '被拒機', null, '${A}', '${T1}', null), ('W', '核對不過', null, '${A}', '${T1}', null),
      ('X', '無主', null, null, '${T1}', null), ('E', '別人的機', null, '${B}', '${T1}', null), ('Y', '無主租戶機', null, '${B}', '${T2}', null);`)
  if (applyMig) await db.exec(mig)
  const q = async (t, a) => (await db.query(t, a)).rows
  return { db, q }
}
const one = async (q, t, a) => (await q(t, a))[0]
const lastMail = (q, kind) => one(q, `select from_node, from_agent, to_node, body, expects_reply, kind from relay.messages where kind = $1 order by created_at desc, id limit 1`, [kind])
const firstLine = b => b.split('\n')[0]

test('實跑（pglite）：kind 檢查式只收 notice:<小寫與底線 1～30 字> 或 null；舊列為 null', { skip }, async () => {
  const { db, q } = await boot({ applyMig: false })
  await db.exec(`insert into relay.messages(from_node, body) values ('H', '舊信')`)
  await db.exec(mig)
  assert.equal((await one(q, `select count(*)::int c from relay.messages where kind is null`)).c, 1, '不回填')
  assert.equal((await one(q, `select convalidated from pg_constraint where conname = 'messages_kind_check'`)).convalidated, true)
  assert.equal((await one(q, `select column_default d from information_schema.columns where table_schema = 'relay' and table_name = 'messages' and column_name = 'kind'`)).d, null)
  for (const ok of ['notice:login', 'notice:a_b', 'notice:' + 'x'.repeat(30)]) await db.query(`insert into relay.messages(from_node, body, kind) values ('H', 'x', $1)`, [ok])
  for (const bad of ['login', 'notice:', 'notice:Login', 'notice:a-b', 'notice:1', 'notice:' + 'x'.repeat(31), 'notice:a\nb', ' notice:a']) {
    await assert.rejects(db.query(`insert into relay.messages(from_node, body, kind) values ('H', 'x', $1)`, [bad]), /messages_kind_check/, JSON.stringify(bad))
  }
  await db.exec(mig) // 可重跑
})

test('實跑（pglite）：asn_relay_send_notice 沒有授權給 service_role、anon、authenticated（也沒有 public）', { skip }, async () => {
  const { q } = await boot()
  for (const role of ['service_role', 'anon', 'authenticated']) {
    const r = await one(q, `select has_function_privilege($1, 'public.${NOTICE_SIG}', 'EXECUTE') p`, [role])
    assert.equal(r.p, false, role)
  }
  const acl = await one(q, `select proacl::text a from pg_proc where proname = 'asn_relay_send_notice'`)
  assert.ok(!/service_role|anon|authenticated|(^|[{,])=X/.test(acl.a ?? ''), String(acl.a))
  // 九支通知函式仍授權 service_role（沒有被我們收掉）
  for (const sig of ['asn_relay_login_alert(text,text,timestamptz,text,integer)', 'asn_relay_inbox_watch(boolean)', 'asn_relay_set_inbox_hold(text,timestamptz,integer,boolean)',
    'asn_relay_misroute_notice(text,uuid)', 'asn_relay_waiting_notice(text,text,text,text,text)', 'asn_relay_mux_down_notice(text,integer,boolean)',
    'asn_relay_node_mismatch_notice(text,text)', 'asn_relay_term_view_notice(text,uuid)', 'asn_relay_device_key_alert(text,text,text,text)']) {
    assert.equal((await one(q, `select has_function_privilege('service_role', 'public.${sig}', 'EXECUTE') p`)).p, true, sig)
    assert.equal((await one(q, `select has_function_privilege('anon', 'public.${sig}', 'EXECUTE') p`)).p, false, sig)
  }
})

test('實跑（pglite）：send_notice 驗證——壞主題、空內文、過長內文、非本人節點、停用節點', { skip }, async () => {
  const { q } = await boot()
  const n = (node, topic, body, ...rest) => one(q, `select ${SEND_NOTICE}($1, $2, $3${rest.length ? ', $4::integer' : ''}) r`, [node, topic, body, ...rest]).then(x => x.r)
  for (const t of ['Bad', '', 'a-b', 'a b', 'x'.repeat(31), '1', 'notice:x', null]) assert.deepEqual(await n('H', t, '內文'), { error: 'bad_request' }, JSON.stringify(t))
  assert.deepEqual(await n('H', 'test', ''), { error: 'bad_body' })
  assert.deepEqual(await n('H', 'test', null), { error: 'bad_body' })
  assert.deepEqual(await n('H', 'test', 'x'.repeat(20001)), { error: 'bad_body' })
  assert.deepEqual(await n('H', 'test', 'x', 0), { error: 'bad_request' })
  assert.equal((await n('H', 'test', 'x'.repeat(20000))).notify, 'sent', '剛好 20000 字可以')
  assert.deepEqual(await n('NOPE', 'test', 'x'), { error: 'forbidden' })
  await q(`update relay.nodes set status = 'revoked' where id = 'P'`)
  assert.deepEqual(await n('P', 'test', 'x'), { error: 'forbidden' })
  for (const node of ['W', 'X']) {
    const r = await n(node, 'test', 'x')
    assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'skipped', []], node)
  }
  assert.equal((await one(q, `select count(*)::int c from relay.messages where from_node in ('W', 'X', 'P', 'NOPE')`)).c, 0, '不該寄的都沒寄')
  const failed = await n('REFUSED', 'test', 'x')
  assert.deepEqual([failed.ok, failed.notify, failed.bell_topics], [true, 'failed', []])
})

test('實跑（pglite）：send_notice 寄件人固定「ASN 通知」、收件人是擁有者人代號、不等回信，kind 寫在每一列（含扇出）', { skip }, async () => {
  const { q } = await boot()
  await q(`insert into relay.messages(from_node, from_agent, body) values ('FAN', '別人', '無關的信')`)
  const r = (await one(q, `select ${SEND_NOTICE}('FAN', 'test', '扇出機：測試') r`)).r
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['b1', 'b2']])
  const rows = await q(`select from_agent, to_node, expects_reply, kind, body from relay.messages where body = '扇出機：測試'`)
  assert.equal(rows.length, 3)
  for (const m of rows) assert.deepEqual([m.from_agent, m.to_node, m.expects_reply, m.kind], ['ASN 通知', 'u:000a', false, 'notice:test'])
  assert.equal((await one(q, `select count(*)::int c from relay.messages where kind is null`)).c, 1, '無關的信沒被標')
  const single = (await one(q, `select ${SEND_NOTICE}('H', 'other_topic', '家用機：單列') r`)).r
  assert.equal(single.notify, 'sent')
  assert.deepEqual((await q(`select kind from relay.messages where body = '家用機：單列'`)).map(x => x.kind), ['notice:other_topic'])
})

test('實跑（pglite）：send_notice 限流看節點＋種類＋時間窗，與寄件名無關；扇出算一封', { skip }, async () => {
  const { q } = await boot()
  const s = (node, topic, lim = 2, win = '1 hour') => one(q, `select ${SEND_NOTICE}($1, $2, '內文', $3::integer, $4::interval) r`, [node, topic, lim, win]).then(x => x.r)
  assert.equal((await s('FAN', 'a')).notify, 'sent')
  assert.equal((await s('FAN', 'a')).notify, 'sent', '三列扇出只算一封')
  const r = await s('FAN', 'a')
  assert.deepEqual([r.notify, r.bell_topics], ['rate_limited', []])
  assert.equal((await s('FAN', 'b')).notify, 'sent', '另一個種類各算各的')
  assert.equal((await s('H', 'a')).notify, 'sent', '另一個節點各算各的')
  await q(`update relay.messages set from_agent = '改過的寄件名' where kind = 'notice:a'`)
  assert.equal((await s('FAN', 'a')).notify, 'rate_limited', '改寄件名限流不失效')
  assert.equal((await s('FAN', 'a', 5)).notify, 'sent', '次數上限由呼叫端決定')
  await q(`update relay.messages set created_at = now() - interval '2 hours' where from_node = 'FAN'`)
  assert.equal((await s('FAN', 'a')).notify, 'sent', '過了時間窗重新計')
  assert.equal((await one(q, `select count(*)::int c from relay.messages where from_node = 'FAN' and kind = 'notice:a' and created_at > now() - interval '1 minute'`)).c, 3)
})

// 九支通知函式
const call = async (q, sql, args) => (await one(q, `select ${sql} r`, args)).r
const shapeOk = r => assert.deepEqual(Object.keys(r).sort(), ['bell_topics', 'notify', 'ok'], JSON.stringify(r))

test('實跑（pglite）：九支通知函式——回傳形狀不變、信是「ASN 通知」、kind 正確、第一行是「設備名：事由」', { skip }, async () => {
  const { q } = await boot()
  const check = async (kind, line1, owner = 'u:000a') => {
    const m = await lastMail(q, kind)
    assert.ok(m, kind)
    assert.equal(m.from_agent, 'ASN 通知', kind)
    assert.equal(m.to_node, owner, kind)
    assert.equal(m.expects_reply, false, kind)
    assert.equal(firstLine(m.body), line1, kind)
    return m
  }
  // login：回傳維持舊形狀（asn_relay_send 的結果），不是 {ok, notify}
  const lg = await call(q, `public.asn_relay_login_alert('H', '工作機', now(), 'a@x.test', 2)`)
  assert.equal(lg.bell_topic, 'b1')
  assert.ok(lg.id)
  const m1 = await check('notice:login', '工作機：Claude 登入失效')
  assert.match(m1.body.split('\n')[1], /^最後一次錯誤 \d\d:\d\d，帳號 a@x\.test。這段時間轉交逾時 2 次。$/)
  // inbox_watch：卡住的節點補寄
  await q(`insert into relay.messages(from_node, to_node, body, created_at) values ('Q', 'H', '卡住的信', now() - interval '20 minutes')`)
  await q(`insert into relay.inbox_watch(node, state, stuck_since, updated_at) values ('H', 'stuck', now() - interval '20 minutes', now())`)
  const iw = await call(q, `public.asn_relay_inbox_watch(true)`)
  assert.deepEqual([iw.nodes, iw.stuck, iw.sent, iw.send_enabled], [1, 1, 1, true])
  await check('notice:inbox_watch', '家用機：收信可能卡住了')
  assert.equal((await one(q, `select notified_at is not null n from relay.inbox_watch where node = 'H'`)).n, true)
  // 設備名先用 name，空白才用 machine（machine 是設備種類，例如「電腦」）
  await q(`update relay.nodes set machine = '電腦' where id = 'H'`)
  await q(`update relay.inbox_watch set state = 'ok', notified_at = null, stuck_since = now() - interval '20 minutes', updated_at = now() where node = 'H'`)
  await q(`update relay.inbox_watch set state = 'stuck' where node = 'H'`)
  assert.equal((await call(q, `public.asn_relay_inbox_watch(true)`)).sent, 1)
  await check('notice:inbox_watch', '家用機：收信可能卡住了')
  await q(`update relay.nodes set name = '  ' where id = 'H'`)
  await q(`update relay.inbox_watch set notified_at = null where node = 'H'`)
  await q(`delete from relay.messages where kind = 'notice:inbox_watch'`)
  assert.equal((await call(q, `public.asn_relay_inbox_watch(true)`)).sent, 1)
  await check('notice:inbox_watch', '電腦：收信可能卡住了')
  await q(`update relay.nodes set name = '家用機', machine = '家用機' where id = 'H'`)
  // quota
  const qt = await call(q, `public.asn_relay_set_inbox_hold('H', now() + interval '1 hour', 3, false)`)
  shapeOk(qt); assert.equal(qt.notify, 'sent')
  const mq = await check('notice:quota', '家用機：Claude 額度用完')
  assert.match(mq.body.split('\n')[1], /扣住 3 封/)
  // misroute / waiting / mux_down
  const mr = await call(q, `public.asn_relay_misroute_notice('H', null)`); shapeOk(mr); assert.equal(mr.notify, 'sent')
  await check('notice:misroute', '家用機：信轉交錯了視窗')
  const wt = await call(q, `public.asn_relay_waiting_notice('H', '夥伴甲', 'permission', null, 'Bash')`); shapeOk(wt); assert.equal(wt.notify, 'sent')
  const mw = await check('notice:waiting', '家用機：夥伴「夥伴甲」在等你確認（權限：Bash）')
  assert.equal(mw.body.split('\n')[1], '已經等超過 2 分鐘。')
  const md = await call(q, `public.asn_relay_mux_down_notice('H', 2, true)`); shapeOk(md); assert.equal(md.notify, 'sent')
  await check('notice:mux_down', '家用機：終端服務中斷了')
  // node_mismatch（含重複與限流）
  const nm = await call(q, `public.asn_relay_node_mismatch_notice('H', 'N')`); shapeOk(nm); assert.equal(nm.notify, 'sent')
  await check('notice:node_mismatch', '家用機：雲端代理啟動時發現設定不對')
  assert.equal((await call(q, `public.asn_relay_node_mismatch_notice('H', 'N')`)).notify, 'rate_limited')
  // view
  const vid = (await one(q, `insert into relay.term_views(from_node, to_node, status, scope, window_name) values ('P', 'H', 'accepted', 'input', '視窗一') returning id`)).id
  const vw = await call(q, `public.asn_relay_term_view_notice('H', $1::uuid)`, [vid]); shapeOk(vw); assert.equal(vw.notify, 'sent')
  await check('notice:view', '家用機：「筆電」正在操作夥伴「視窗一」的終端')
  assert.equal((await one(q, `select notified_at is not null n from relay.term_views where id = $1`, [vid])).n, true)
  // device_key
  const dk = await call(q, `public.asn_relay_device_key_alert('H', 'P', 'first', '0123456789abcdef0123')`); shapeOk(dk); assert.equal(dk.notify, 'sent')
  await check('notice:device_key', '家用機：「筆電」第一次連到「家用機」')
  assert.equal((await one(q, `select count(*)::int c from relay.device_key_alerts`)).c, 1)
  // 所有九種信的寄件人都沒有舊的收發室名字
  assert.equal((await one(q, `select count(*)::int c from relay.messages where from_agent like '%收發室'`)).c, 0)
  // 第一行已經寫了設備名，正文不再用「這台」：改寫設備名（asn調查員、asn真 定）
  assert.equal((await one(q, `select count(*)::int c from relay.messages where kind like 'notice:%' and body like '%這台%'`)).c, 0, '通知正文不准出現「這台」')
  const bodyOf = async kind => (await one(q, `select body from relay.messages where kind = $1 order by created_at desc, id limit 1`, [kind])).body
  assert.match(await bodyOf('notice:node_mismatch'), /但金鑰對到的是「家用機」。/)
  assert.match(await bodyOf('notice:view'), /可以在「家用機」打任何字.*請馬上到「家用機」按結束/s)
  assert.match(await bodyOf('notice:device_key'), /請到「家用機」的設定頁「認得的電腦」按忘記/)
})

test('實跑（pglite）：沒有設備名時第一行寫「未命名設備」；扇出節點的通知每一列都有 kind', { skip }, async () => {
  const { q } = await boot()
  assert.equal((await call(q, `public.asn_relay_mux_down_notice('N', 1, false)`)).notify, 'sent')
  assert.equal(firstLine((await lastMail(q, 'notice:mux_down')).body), '未命名設備：終端服務短時間內又中斷了')
  assert.equal((await call(q, `public.asn_relay_misroute_notice('N', null)`)).notify, 'sent')
  assert.equal(firstLine((await lastMail(q, 'notice:misroute')).body), '未命名設備：信轉交錯了視窗')
  assert.equal((await call(q, `public.asn_relay_waiting_notice('FAN', 'w', 'input', '請回答', null)`)).notify, 'sent')
  assert.equal((await q(`select 1 from relay.messages where from_node = 'FAN' and kind = 'notice:waiting'`)).length, 3)
  assert.equal((await q(`select 1 from relay.messages where from_node = 'FAN' and kind is null`)).length, 0)
})

test('實跑（pglite）：各函式沿用原本的限流次數與錯誤形狀', { skip }, async () => {
  const { q } = await boot()
  for (let i = 0; i < 3; i++) await call(q, `public.asn_relay_login_alert('H', '工作機', now(), null, 0)`)
  assert.deepEqual(await call(q, `public.asn_relay_login_alert('H', '工作機', now(), null, 0)`), { error: 'rate_limited' }, 'login 3 封')
  assert.deepEqual(await call(q, `public.asn_relay_login_alert('NOPE', '工作機', now(), null, 0)`), { error: 'not_claimed' })
  assert.deepEqual(await call(q, `public.asn_relay_login_alert('H', '', now(), null, 0)`), { error: 'bad_request' })
  for (let i = 0; i < 6; i++) assert.equal((await call(q, `public.asn_relay_mux_down_notice('H', 1, true)`)).notify, 'sent', 'mux ' + i)
  assert.equal((await call(q, `public.asn_relay_mux_down_notice('H', 1, true)`)).notify, 'rate_limited', 'mux 6 封')
  assert.deepEqual(await call(q, `public.asn_relay_mux_down_notice('NOPE', 1, true)`), { error: 'forbidden' })
  assert.deepEqual(await call(q, `public.asn_relay_mux_down_notice('H', 0, true)`), { error: 'bad_request' })
  for (let i = 0; i < 3; i++) await call(q, `public.asn_relay_misroute_notice('P', null)`)
  assert.equal((await call(q, `public.asn_relay_misroute_notice('P', null)`)).notify, 'rate_limited', 'misroute 3 封')
  const rf = await call(q, `public.asn_relay_waiting_notice('REFUSED', 'w', 'other', null, null)`)
  assert.deepEqual([rf.ok, rf.notify, rf.bell_topics], [true, 'failed', []])
  const sk = await call(q, `public.asn_relay_waiting_notice('W', 'w', 'other', null, null)`)
  assert.deepEqual([sk.ok, sk.notify, sk.bell_topics], [true, 'skipped', []])
  // 設備金鑰：同一組一天內不重寄，回 sent 但不新增信
  await call(q, `public.asn_relay_device_key_alert('H', 'P', 'changed', 'abcdef0123456789abcd')`)
  const before = (await q(`select 1 from relay.messages where kind = 'notice:device_key'`)).length
  assert.equal((await call(q, `public.asn_relay_device_key_alert('H', 'P', 'changed', 'abcdef0123456789abcd')`)).notify, 'sent')
  assert.equal((await q(`select 1 from relay.messages where kind = 'notice:device_key'`)).length, before)
})

test('實跑（pglite）：讀信函式的信件物件多 kind 與 from_owner（只有寄件節點擁有者＝租戶擁有者才是 true）', { skip }, async () => {
  const { q } = await boot()
  const ins = (from, tenant, kind, to = 'R', agent = 'ag', extra = '') =>
    q(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body, tenant_id, kind, person_user ${extra ? ',' + extra.split('=')[0] : ''}) values ($1, 'ASN 通知', $2, $3, $4, $5, $6, $7 ${extra ? ',' + extra.split('=')[1] : ''})`,
      [from, to, agent, `from ${from}`, tenant, kind, A])
  await ins('H', T1, 'notice:login')     // 寄件節點擁有者 A、租戶擁有者 A → true
  await ins('E', T1, null)               // 寄件節點擁有者 B ≠ A → false
  await ins('X', T1, null)               // 寄件節點沒有擁有者 → false
  await ins('Y', T2, null)               // 租戶沒有擁有者 → false
  const want = { 'from H': [true, 'notice:login'], 'from E': [false, null], 'from X': [false, null], 'from Y': [false, null] }
  const verify = (arr, label) => {
    assert.equal(arr.length, 4, label)
    for (const m of arr) {
      assert.ok('kind' in m && 'from_owner' in m, label)
      assert.equal(typeof m.from_owner, 'boolean', label)
      assert.deepEqual([m.from_owner, m.kind], want[m.body ?? ''] ?? want[`from ${m.from_node}`], `${label} ${m.from_node}`)
    }
  }
  const inbox = await call(q, `public.asn_relay_inbox('R')`)
  verify(inbox, 'inbox')
  for (const k of ['voice', 'trust', 'sender_display', 'fanout_id', 'expects_reply']) assert.ok(k in inbox[0], 'inbox 原有欄位 ' + k)
  verify(await call(q, `public.asn_relay_inbox_agent('R', 'ag')`), 'inbox_agent')
  const peek = await call(q, `public.asn_relay_inbox_peek('R', 'ag')`)
  assert.equal(peek.count, 4)
  verify(peek.messages, 'peek')
  assert.deepEqual(Object.keys(peek.messages[0]).sort(), ['body', 'created_at', 'from_agent', 'from_node', 'from_owner', 'id', 'kind'])
  // 往來記錄：夥伴 H（寄件人「ASN 通知」）→ 本人在 H2 的視窗
  await q(`insert into relay.nodes(id, owner_user, tenant_id) values ('H2', '${A}', '${T1}')`)
  const hist = await call(q, `public.asn_chat_history($1::uuid, 'H2', 'H', 'ASN 通知', 50)`, [A])
  assert.equal(hist.messages.length, 1)
  assert.deepEqual([hist.messages[0].kind, hist.messages[0].from_owner], ['notice:login', true])
  const hist2 = await call(q, `public.asn_chat_history($1::uuid, 'H2', 'E', 'ASN 通知', 50)`, [A])
  assert.deepEqual([hist2.messages[0].kind, hist2.messages[0].from_owner], [null, false])
})

test('實跑（pglite）：套用回復檔後，通知換回各自的舊寄件名，讀信函式沒有新欄位，kind 欄位與新函式還在', { skip }, async () => {
  const { db, q } = await boot()
  await db.exec(rb)
  assert.equal((await call(q, `public.asn_relay_mux_down_notice('H', 2, true)`)).notify, 'sent')
  const m = await one(q, `select from_agent, kind, body from relay.messages order by created_at desc limit 1`)
  assert.equal(m.from_agent, '終端服務收發室')
  assert.equal(m.kind, null)
  assert.equal(m.body, '這台（家用機）的終端服務中斷了，2 位夥伴受影響，ASN 正在自動接回。')
  await q(`insert into relay.messages(from_node, from_agent, to_node, to_agent, body, tenant_id, kind) values ('H', 'ASN 通知', 'R', 'ag', 'x', '${T1}', 'notice:login')`)
  const inbox = await call(q, `public.asn_relay_inbox('R')`)
  assert.ok(!('kind' in inbox[0]) && !('from_owner' in inbox[0]))
  assert.equal((await one(q, `select count(*)::int c from pg_proc where proname = 'asn_relay_send_notice'`)).c, 1)
  assert.equal((await one(q, `select count(*)::int c from information_schema.columns where table_schema = 'relay' and table_name = 'messages' and column_name = 'kind'`)).c, 1)
})

test('實跑（pglite）：其他幾種通知正文也不用「這台」——終端服務沒接回、看畫面、設備金鑰變了', { skip }, async () => {
  const { q } = await boot()
  await call(q, `public.asn_relay_mux_down_notice('H', 2, false)`)
  const vid = (await one(q, `insert into relay.term_views(from_node, to_node, status, scope, window_name) values ('P', 'H', 'accepted', 'view', '視窗一') returning id`)).id
  await call(q, `public.asn_relay_term_view_notice('H', $1::uuid)`, [vid])
  await call(q, `public.asn_relay_device_key_alert('H', 'P', 'changed', 'abcdef0123456789abcd')`)
  const rows = await q(`select kind, body from relay.messages where kind like 'notice:%' order by created_at, id`)
  assert.ok(rows.length >= 3)
  for (const r of rows) assert.ok(!r.body.includes('這台'), r.kind + '：' + r.body)
  const body = k => rows.find(r => r.kind === k).body
  assert.match(body('notice:mux_down'), /這次沒有自動接回，請到「家用機」看一下。/)
  assert.match(body('notice:view'), /如果不是你，請到「家用機」按結束/)
  assert.match(body('notice:device_key'), /，已拒絕連線。如果是你重裝了那台，請到「家用機」的設定頁/)
  // 沒有設備名：寫「未命名設備」
  await call(q, `public.asn_relay_mux_down_notice('N', 1, false)`)
  assert.match((await one(q, `select body from relay.messages where from_node = 'N' and kind = 'notice:mux_down' order by created_at desc limit 1`)).body, /請到「未命名設備」看一下/)
})

test('靜態：這支 migration 產出的通知正文不准出現「這台」（註解除外）', () => {
  assert.doesNotMatch(mig.replace(/^\s*--.*$/gm, '').replace(/--[^\n']*$/gm, ''), /這台/)
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
