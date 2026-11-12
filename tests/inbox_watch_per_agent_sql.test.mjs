// 收信卡住監控依收件代理判斷（20261112100000_inbox_watch_per_agent.sql；todo-next-176，asn真 審定）：
// 1. 靜態：security definer＋search_path 空、只授權 service_role；新欄位有預設值或可空；回復檔的函式逐字等於通知集中那一版。
// 2. 實跑（pglite，沒裝就略過）：單一代理慢不通知、60 分鐘才通知；兩個代理同時卡就通知；不存在的代理只記錄；
//    影子跑記「會不會通知」且每段卡住只記一次；開寄信後補寄；恢復信只寫卡了多久；舊的列不受影響；回復檔跑得回去。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const F = '20261112100000_inbox_watch_per_agent.sql'
const mig = rd(fs.readFileSync(new URL(F, DIR), 'utf8'))
const prev = rd(fs.readFileSync(new URL('20261111100000_notice_center.sql', DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261112100000_inbox_watch_per_agent_down.sql', import.meta.url), 'utf8'))
const fnBlock = s => {
  const i = s.indexOf('create or replace function public.asn_relay_inbox_watch(')
  return s.slice(i, s.indexOf('$function$;', s.indexOf('as $function$', i)) + '$function$;'.length)
}

test('靜態：security definer、search_path 空、只授權 service_role；排程不動（仍影子跑）', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.match(fnBlock(body), /security definer\n set search_path to ''/)
  assert.match(body, /revoke all on function public\.asn_relay_inbox_watch\(boolean\) from public, anon, authenticated;/)
  assert.match(body, /grant execute on function public\.asn_relay_inbox_watch\(boolean\) to service_role;/)
  assert.doesNotMatch(body, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(body, /cron\./, '排程不動：開寄信另開 migration')
  assert.doesNotMatch(body, /insert into relay\.messages/)
  assert.match(body, /asn_relay_send_notice\(r\.id, 'inbox_watch', v_body, 3, interval '1 hour'\)/, '寄信照舊經通知集中、限流不變')
})

test('靜態：新欄位都有預設值或可空（舊的列不受影響）；不刪欄位', () => {
  const adds = mig.match(/add column if not exists [^;]+;/g) ?? []
  assert.equal(adds.length, 7)
  for (const a of adds) assert.ok(/timestamptz;$/.test(a) || /integer;$/.test(a) || /not null default /.test(a), a)
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /drop column|drop table/i)
})

test('靜態：回復檔的函式逐字等於通知集中那一版；換回檢查式前先刪新種類紀錄；欄位保留', () => {
  assert.equal(fnBlock(down), fnBlock(prev))
  const del = down.indexOf("delete from relay.inbox_watch_log where note in ('alert', 'notify', 'orphan');")
  const add = down.indexOf("check (note in ('marked', 'recovered', 'recovered_silent', 'reset_after_offline'))")
  assert.ok(del > 0 && add > del)
  assert.match(down, /drop index if exists relay\.messages_acked_idx;/)
  assert.doesNotMatch(down.replace(/^--.*$/gm, ''), /drop column|drop table|drop function/i)
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟，整支失敗、不會無聲略過
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const U = 'aaaaaaaa-0000-0000-0000-00000000000a'

async function boot() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, machine text, kind text, platform text, status text default 'active', owner_user uuid,
      tenant_id uuid, last_seen_at timestamptz, inbox_hold_until timestamptz);
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, to_agent text, body text,
      kind text, created_at timestamptz default now(), acked_at timestamptz);
    create table relay.inbox_watch(node text primary key, state text not null default 'ok', level text not null default '0', last_count integer not null default 0,
      last_oldest_at timestamptz, stuck_since timestamptz, notified_at timestamptz, recovered_at timestamptz, updated_at timestamptz not null default now());
    create table relay.inbox_watch_log(id bigint generated always as identity primary key, node text not null, at timestamptz not null default now(),
      from_state text not null, to_state text not null, note text not null, cnt integer not null, oldest_at timestamptz, stuck_since timestamptz,
      constraint inbox_watch_log_note_check check (note in ('marked', 'recovered', 'recovered_silent', 'reset_after_offline')));
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select u is not null $$;
    -- 通知集中寄信的替身：寫一列 kind = notice:<種類>，回 notify = sent
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_max integer, p_win interval) returns jsonb language plpgsql as $$
      begin insert into relay.messages(from_node, from_agent, to_node, body, kind, acked_at) values (p_node, 'ASN 通知', p_node, p_body, 'notice:' || p_topic, now());
        return jsonb_build_object('notify', 'sent'); end $$;
    insert into relay.nodes(id, name, owner_user, last_seen_at) values ('PC', '工作機', '${U}', now());
    -- 舊的列：遷移前就有的狀態與紀錄
    insert into relay.inbox_watch(node, state) values ('PC', 'ok');
    insert into relay.inbox_watch_log(node, from_state, to_state, note, cnt) values ('PC', 'ok', 'stuck', 'marked', 1);`)
  await db.exec(mig)
  const q = async (t, a) => (await db.query(t, a)).rows
  // 代理 ag 曾在 ackedAgo 之前確認過一封信（＝存在的代理）
  const known = (ag, ackedAgo = '1 minute') => db.query(
    "insert into relay.messages(from_node, to_node, to_agent, body, created_at, acked_at) values ('S', 'PC', $1, 'b', now() - $2::interval - interval '1 minute', now() - $2::interval)", [ag, ackedAgo])
  const unacked = (ag, ago, n = 1) => db.query(
    "insert into relay.messages(from_node, to_node, to_agent, body, created_at) select 'S', 'PC', $1, 'b', now() - $2::interval from generate_series(1, $3)", [ag, ago, n])
  const ackAll = () => db.query("update relay.messages set acked_at = now() where to_node = 'PC' and acked_at is null")
  const run = async send => (await q('select public.asn_relay_inbox_watch($1) r', [send]))[0].r
  const st = () => q("select * from relay.inbox_watch where node = 'PC'").then(r => r[0])
  const log = () => q("select note, would_notify, cnt, agents from relay.inbox_watch_log where node = 'PC' order by id")
  const mails = () => q("select body from relay.messages where kind = 'notice:inbox_watch' order by created_at, body").then(r => r.map(x => x.body))
  // 讓某個時間欄「已經過了 N 分鐘」（模擬持續卡著）
  const age = (col, mins) => db.query(`update relay.inbox_watch set ${col} = now() - ($1 || ' minutes')::interval where node = 'PC'`, [String(mins)])
  return { db, q, known, unacked, ackAll, run, st, log, mails, age }
}

test('實跑：舊的列不受影響（新欄位取預設值）；舊紀錄 would_notify＝false', { skip }, async () => {
  const { st, log } = await boot()
  const s = await st()
  assert.equal(s.state, 'ok'); assert.equal(s.orphan_count, 0); assert.equal(s.stuck_agents, 0); assert.equal(s.alert_since, null)
  assert.deepEqual(await log(), [{ note: 'marked', would_notify: false, cnt: 1, agents: null }])
})

test('實跑：單一代理慢 20 分鐘＝標成卡住但不會通知；卡過 60 分鐘、60 分鐘沒確認任何信才達到通知條件', { skip }, async () => {
  const { known, unacked, run, st, log, age, db } = await boot()
  await known('審查', '30 minutes')
  await unacked('審查', '20 minutes')
  assert.deepEqual(await run(false), { nodes: 1, stuck: 1, alert: 0, sent: 0, send_enabled: false })
  assert.equal((await st()).state, 'stuck')
  assert.equal((await st()).alert_since, null)
  assert.deepEqual((await log()).at(-1), { note: 'marked', would_notify: false, cnt: 1, agents: 1 })
  await age('stuck_since', 30)
  assert.equal((await run(true)).sent, 0, '單一代理還在 60 分鐘內：開寄信也不寄')
  // 同一封信等到 61 分鐘、代理最後一次確認也在 61 分鐘前 → 達到通知條件，從現在起算 10 分鐘
  await db.query("update relay.messages set created_at = now() - interval '61 minutes' where to_node = 'PC' and acked_at is null")
  await db.query("update relay.messages set acked_at = now() - interval '61 minutes' where to_node = 'PC' and acked_at is not null")
  assert.equal((await run(false)).alert, 1)
  assert.deepEqual((await log()).at(-1), { note: 'alert', would_notify: true, cnt: 1, agents: 1 })
  assert.notEqual((await st()).alert_since, null)
})

test('實跑：單一代理雖然卡 60 分鐘，但 60 分鐘內還在確認別的信＝不通知', { skip }, async () => {
  const { known, unacked, run } = await boot()
  await known('審查', '5 minutes')
  await unacked('審查', '61 minutes')
  assert.equal((await run(false)).alert, 0)
})

test('實跑：兩個代理同時卡 15 分鐘以上＝標成卡住當下就達到通知條件；影子跑 10 分鐘後記一筆 notify、只記一次；開寄信補寄', { skip }, async () => {
  const { known, unacked, run, st, log, mails, age } = await boot()
  for (const ag of ['asn真', '恆源事務', '調查員']) await known(ag, '2 hours')
  await unacked('asn真', '52 minutes', 3); await unacked('恆源事務', '47 minutes', 2); await unacked('調查員', '20 minutes', 2)
  await unacked('asn真', '2 minutes')   // 卡住代理後來又收到的信也沒送到：算進「寄給這些夥伴的信」
  assert.deepEqual(await run(false), { nodes: 1, stuck: 1, alert: 1, sent: 0, send_enabled: false })
  assert.deepEqual((await log()).at(-1), { note: 'marked', would_notify: true, cnt: 8, agents: 3 })
  assert.equal((await run(false)).sent, 0, '還不到 10 分鐘')
  assert.equal((await log()).filter(l => l.note === 'notify').length, 0)
  await age('alert_since', 11)
  await run(false)
  await run(false)
  assert.deepEqual((await log()).filter(l => l.note === 'notify'), [{ note: 'notify', would_notify: true, cnt: 8, agents: 3 }], '影子跑每段卡住只記一次')
  assert.deepEqual(await mails(), [], '影子跑不寄信')
  assert.equal((await run(true)).sent, 1, '開寄信後補寄')
  const [m] = await mails()
  assert.equal(m.split('\n')[0], '工作機：收信可能卡住了')
  assert.match(m.split('\n')[1], /^還在線，但寄給 asn真、恆源事務 等 3 個夥伴的 8 封信都沒有送到，最舊的已經等了 52 分鐘。可能要重開 ASN。$/)
  assert.equal((await run(true)).sent, 0, '不重複寄')
  // 24 小時後再提醒
  await age('notified_at', 25 * 60)
  assert.equal((await run(true)).sent, 1)
  assert.match((await mails()).at(-1), /^工作機：收信還是卡著\n寄給 asn真、恆源事務 等 3 個夥伴的 8 封信沒有送到/)
  assert.notEqual((await st()).episode_oldest_at, null)
})

test('實跑：寄過卡住後恢復＝寄「恢復」，只寫卡了多久、不寫封數；紀錄 recovered 的 would_notify＝true', { skip }, async () => {
  const { known, unacked, ackAll, run, log, mails, age } = await boot()
  await known('A', '2 hours'); await known('B', '2 hours')
  await unacked('A', '65 minutes', 4); await unacked('B', '50 minutes', 3)
  await run(true)
  await age('alert_since', 11)
  assert.equal((await run(true)).sent, 1)
  await ackAll()
  assert.equal((await run(true)).sent, 1)
  assert.match((await mails()).at(-1), /^工作機：收信恢復了\n卡了約 65 分鐘，現在都送到了。$/)
  assert.deepEqual((await log()).at(-1), { note: 'recovered', would_notify: true, cnt: 0, agents: 0 })
})

test('實跑：影子跑期間會寄過卡住的，恢復紀錄 would_notify＝true；沒到通知條件就恢復的＝false', { skip }, async () => {
  const a = await boot()
  await a.known('A', '2 hours'); await a.known('B', '2 hours')
  await a.unacked('A', '30 minutes'); await a.unacked('B', '30 minutes')
  await a.run(false); await a.age('alert_since', 11); await a.run(false)
  await a.ackAll(); await a.run(false)
  assert.deepEqual((await a.log()).at(-1), { note: 'recovered_silent', would_notify: true, cnt: 0, agents: 0 })
  const st = await a.st()
  assert.equal(st.state, 'ok'); assert.equal(st.shadow_noticed_at, null); assert.equal(st.alert_since, null)

  const b = await boot()
  await b.known('審查', '30 minutes'); await b.unacked('審查', '20 minutes')
  await b.run(false); await b.ackAll(); await b.run(false)
  assert.deepEqual((await b.log()).at(-1), { note: 'recovered_silent', would_notify: false, cnt: 0, agents: 0 })
})

test('實跑：寄到不存在的代理（7 天內沒確認過任何信）＝不算卡住，只記一筆 orphan', { skip }, async () => {
  const { known, unacked, run, st, log } = await boot()
  await known('asn40', '1 minute')
  await unacked('夥伴-1', '39 hours')
  assert.deepEqual(await run(false), { nodes: 1, stuck: 0, alert: 0, sent: 0, send_enabled: false })
  assert.equal((await st()).state, 'ok')
  assert.equal((await st()).orphan_count, 1)
  await run(false)
  assert.deepEqual((await log()).filter(l => l.note === 'orphan'), [{ note: 'orphan', would_notify: false, cnt: 1, agents: 1 }], '由 0 變成大於 0 才記，不每輪記')
  assert.equal((await run(true)).sent, 0, '這一版不通知')
})

test('實跑：達到通知條件後退回只有單一代理慢（還沒寄過）＝取消起算', { skip }, async () => {
  const { known, unacked, run, st, db } = await boot()
  await known('A', '2 hours'); await known('B', '2 hours')
  await unacked('A', '20 minutes'); await unacked('B', '20 minutes')
  await run(false)
  assert.notEqual((await st()).alert_since, null)
  await db.query("update relay.messages set acked_at = now() where to_node = 'PC' and to_agent = 'B' and acked_at is null")
  await run(false)
  assert.equal((await st()).state, 'stuck')
  assert.equal((await st()).alert_since, null)
})

test('實跑：回復檔跑得回去（新種類紀錄刪掉、舊紀錄留著），函式回到整台判法', { skip }, async () => {
  const { db, known, unacked, run, log } = await boot()
  await known('asn40'); await unacked('夥伴-1', '39 hours')
  await run(false)
  await db.exec(down)
  assert.deepEqual((await log()).map(l => l.note), ['marked'])
  const r = await run(false)
  assert.equal(r.alert, undefined, '上一版沒有 alert 欄')
  assert.equal(r.stuck, 1, '上一版整台只看最舊一封：寄到不存在代理的信也算卡住')
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
