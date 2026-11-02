// 收信卡住監控（20261102130000_inbox_watch.sql；asn真 #2142）：
// 1. 靜態：security definer＋search_path 空、只授權 service_role、新表開 RLS 且沒有 policy、排程可重跑。
// 2. 實跑（pglite，沒裝就略過）：門檻、影子跑不寄信、開寄信後補寄、不重複、24 小時再提醒、恢復、手機／不在線／額度扣住的節點不看、
//    擁有者查不到或單一節點出錯不影響其他節點、每節點每小時最多 3 封。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261102130000_inbox_watch.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：只授權 service_role、security definer、search_path 空；新表開 RLS 沒有 policy；節點刪除跟著刪', () => {
  assert.match(sql, /revoke all on function public\.asn_relay_inbox_watch\(boolean\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_relay_inbox_watch\(boolean\) to service_role;/)
  assert.equal((sql.match(/security definer\n set search_path to ''/g) ?? []).length, 1)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(sql, /create policy/)
  for (const t of ['inbox_watch', 'inbox_watch_log']) {
    assert.match(sql, new RegExp(`alter table relay\\.${t} enable row level security;`), t)
    assert.match(sql, new RegExp(`revoke all on relay\\.${t} from public, anon, authenticated;`), t)
  }
  assert.match(sql, /delete from relay\.inbox_watch_log where at < now\(\) - interval '30 days'/, '紀錄保留 30 天')
  const down = fs.readFileSync(new URL('../supabase/sql/rollback/20261102130000_inbox_watch_down.sql', import.meta.url), 'utf8')
  assert.match(down, /drop table if exists relay\.inbox_watch_log;/)
  assert.match(sql, /手機不看」目前\*\*不生效\*\*/, '說明要照實寫：目前認不出手機')
  assert.match(sql, /references relay\.nodes\(id\) on delete cascade/)
  assert.match(sql, /add column if not exists inbox_hold_until timestamptz/)
})

test('靜態：排程可重跑（先取消同名排程再建）、先用 false 影子跑；只經既有函式寄信，不直接寫信件表', () => {
  const cron = sql.slice(sql.indexOf('-- ===cron==='))
  assert.match(cron, /cron\.unschedule\('asn-inbox-watch'\) where exists/)
  assert.match(cron, /cron\.schedule\('asn-inbox-watch', '\*\/5 \* \* \* \*', \$\$ select public\.asn_relay_inbox_watch\(false\); \$\$\)/)
  assert.doesNotMatch(sql, /insert into relay\.messages/)
  assert.match(sql, /v_res := public\.asn_relay_send\(r\.id, v_agent, v_alias, null, v_body, null, false, null, false\)/)
  assert.match(sql, /v_agent constant text := '收信監控收發室'/, '寄件人名稱以收發室結尾')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, machine text, kind text, status text default 'active', owner_user uuid, last_seen_at timestamptz, tenant_id uuid);
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, body text, created_at timestamptz default now(), acked_at timestamptz, fanout_id uuid);
    create function public.asn_person_alias(p_user uuid) returns text language sql as $$ select 'u:' || substr(md5(p_user::text), 1, 12) $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean, p_signed_user uuid, p_as_person boolean)
      returns jsonb language plpgsql as $$ begin
        if p_from_node = 'BOOM' then raise exception 'send failed'; end if;
        if p_from_node = 'REFUSED' then return jsonb_build_object('error', 'unknown_to_node'); end if;
        insert into relay.messages(from_node, from_agent, to_node, body) values (p_from_node, p_from_agent, p_to_node, p_body);
        return jsonb_build_object('ok', true); end $$;`)
  // pglite 沒有 pg_cron：只跑排程之前的部分
  await db.exec(sql.slice(0, sql.indexOf('-- ===cron===')) + '\ncommit;')
  const q = async (t, a) => (await db.query(t, a)).rows
  const node = (id, o = {}) => db.query(
    'insert into relay.nodes(id, name, machine, kind, owner_user, last_seen_at) values ($1,$2,$3,$4,$5, now() - $6::interval)',
    [id, o.name ?? id, o.machine ?? null, o.kind ?? null, 'owner' in o ? o.owner : U1, o.seen ?? '10 seconds'])
  const unacked = (to, ago, n = 1) => db.query(
    "insert into relay.messages(from_node, from_agent, to_node, body, created_at) select 'SENDER', 'x', $1, 'b', now() - $2::interval from generate_series(1, $3)", [to, ago, n])
  const run = async send => (await q('select public.asn_relay_inbox_watch($1) r', [send]))[0].r
  const sent = () => q("select from_node, body from relay.messages where from_agent = '收信監控收發室' order by created_at, body")
  // 讓「標成卡住」已經過了 N 分鐘（模擬持續卡著）
  const aged = (id, mins) => db.query("update relay.inbox_watch set stuck_since = now() - ($2 || ' minutes')::interval where node = $1", [id, String(mins)])
  const st = id => q('select * from relay.inbox_watch where node = $1', [id]).then(r => r[0])
  return { db, q, node, unacked, run, sent, st, aged }
}

test('實跑：卡 16 分鐘＝stuck；影子跑不寄；開寄信後補寄一次；之後不重複', { skip }, async () => {
  const { node, unacked, run, sent, st, aged } = await boot()
  await node('PC', { machine: '新電腦' })
  await unacked('PC', '16 minutes', 3)
  assert.deepEqual(await run(false), { nodes: 1, stuck: 1, sent: 0, send_enabled: false })
  assert.equal((await st('PC')).state, 'stuck')
  assert.equal((await st('PC')).level, '1-10')
  assert.equal((await sent()).length, 0, '影子跑不寄信')
  assert.equal((await run(true)).sent, 0, '剛標成卡住還不到 10 分鐘：只標記，不寄（電腦剛開機不誤報）')
  await aged('PC', 11)
  assert.equal((await run(false)).sent, 0, '已經卡夠久了，但影子跑（p_send = false）還是不寄')
  assert.equal((await sent()).length, 0)
  assert.equal((await st('PC')).notified_at, null)
  assert.equal((await run(true)).sent, 1, '持續卡著超過 10 分鐘，開寄信後補寄')
  const m = await sent()
  assert.equal(m.length, 1)
  assert.match(m[0].body, /新電腦.*3 封.*卡住/)
  assert.equal((await run(true)).sent, 0, '同一台卡著不重複寄')
  assert.equal((await sent()).length, 1)
})

test('實跑：筆數分級；5～15 分鐘不算卡；沒信不算卡', { skip }, async () => {
  const { node, unacked, run, st } = await boot()
  for (const [id, n] of [['A', 1], ['B', 10], ['C', 11], ['D', 50], ['E', 51]]) { await node(id); await unacked(id, '20 minutes', n) }
  await node('F'); await unacked('F', '10 minutes', 5)
  await node('G')
  await run(false)
  assert.deepEqual(await Promise.all(['A', 'B', 'C', 'D', 'E'].map(async i => (await st(i)).level)), ['1-10', '1-10', '10-50', '10-50', '50+'])
  assert.equal((await st('F')).state, 'ok', '10 分鐘還不到門檻')
  assert.equal((await st('G')).level, '0')
})

test('實跑：24 小時再提醒；恢復寄一封；介於兩個門檻之間不恢復；影子跑期間就恢復的不寄恢復', { skip }, async () => {
  const { db, node, unacked, run, sent, st, aged } = await boot()
  await node('PC', { machine: '新電腦' })
  await unacked('PC', '16 minutes')
  await run(true)
  await aged('PC', 11)
  await run(true)
  assert.equal((await sent()).length, 1)
  // 24 小時內不再提醒；超過 24 小時再提醒一次
  await db.query("update relay.inbox_watch set notified_at = now() - interval '23 hours' where node = 'PC'")
  assert.equal((await run(true)).sent, 0)
  await db.query("update relay.inbox_watch set notified_at = now() - interval '25 hours' where node = 'PC'")
  assert.equal((await run(true)).sent, 1)
  assert.match((await sent()).at(-1).body, /還是卡著/)
  // 最舊的變成 10 分鐘（介於 5～15）：保持 stuck，不寄恢復
  await db.query("update relay.messages set acked_at = now() where from_agent = 'x'")
  await unacked('PC', '10 minutes')
  await run(true)
  assert.equal((await st('PC')).state, 'stuck')
  // 全部確認：恢復，寄一封；notified_at 清掉
  await db.query("update relay.messages set acked_at = now() where from_agent = 'x'")
  const before = (await sent()).length
  await run(true)
  assert.equal((await st('PC')).state, 'ok')
  assert.equal((await sent()).length, before + 1)
  assert.match((await sent()).at(-1).body, /恢復了/)
  assert.equal((await st('PC')).notified_at, null)
  // 影子跑期間卡住又恢復：從沒寄過卡住，就不寄恢復
  await node('Q'); await unacked('Q', '20 minutes')
  await run(false)
  await db.query("update relay.messages set acked_at = now() where to_node = 'Q'")
  const n2 = (await sent()).length
  await run(true)
  assert.equal((await st('Q')).state, 'ok')
  assert.equal((await sent()).length, n2, '沒通知過卡住，就不通知恢復')
})

test('實跑：只在狀態真的改變時寫紀錄；超過 30 天的紀錄清掉', { skip }, async () => {
  const { db, node, unacked, run, st, q, aged } = await boot()
  await node('PC', { machine: '新電腦' })
  await unacked('PC', '20 minutes')
  await run(false)
  await run(false)
  await db.query("update relay.messages set acked_at = now()")
  await run(false)
  await run(false)
  const rows = await q('select from_state, to_state, note from relay.inbox_watch_log order by id')
  assert.deepEqual(rows, [{ from_state: 'ok', to_state: 'stuck', note: 'marked' }, { from_state: 'stuck', to_state: 'ok', note: 'recovered_silent' }], '兩次標記與恢復各一列，沒改變的輪不寫')
  assert.equal((await st('PC')).state, 'ok')
  await db.query("update relay.inbox_watch_log set at = now() - interval '31 days'")
  await run(false)
  assert.equal((await q('select count(*)::int n from relay.inbox_watch_log'))[0].n, 0, '31 天前的紀錄被清掉')
})

test('實跑：離線一晚回來，第一輪不寄（重新起算 10 分鐘）；之後持續卡著才寄', { skip }, async () => {
  const { db, node, unacked, run, sent, st, q, aged } = await boot()
  await node('PC', { machine: '新電腦' })
  await unacked('PC', '20 hours')
  await run(true)
  await aged('PC', 12)
  await db.query("update relay.inbox_watch set state = 'stuck', stuck_since = now() - interval '20 hours', updated_at = now() - interval '20 hours', notified_at = null where node = 'PC'")
  const r = await run(true)
  assert.equal(r.sent, 0, '離線回來的第一輪不寄')
  const s = await st('PC')
  assert.ok(Date.now() - new Date(s.stuck_since).getTime() < 60000, 'stuck_since 重設成現在')
  assert.ok((await q("select 1 from relay.inbox_watch_log where note = 'reset_after_offline'")).length === 1)
  await aged('PC', 11)
  assert.equal((await run(true)).sent, 1, '重新起算後持續卡著超過 10 分鐘才寄')
  assert.equal((await sent()).length, 1)
})

test('實跑：「已恢復」寄不出去（限流）就保持 stuck，下一輪再試；寄成功才標回 ok', { skip }, async () => {
  const { db, node, unacked, run, sent, st, aged } = await boot()
  await node('PC', { machine: '新電腦' })
  await unacked('PC', '20 minutes')
  await run(true)
  await aged('PC', 11)
  await run(true)
  assert.ok((await st('PC')).notified_at, '先寄過卡住')
  await db.query("update relay.messages set acked_at = now() where from_agent = 'x'")
  await db.query("update relay.messages set created_at = now() - interval '30 minutes' where from_agent = '收信監控收發室'")
  // 每小時 3 封的上限已滿 → 恢復通知寄不出去
  for (let i = 0; i < 3; i++) await db.query("insert into relay.messages(from_node, from_agent, to_node, body, fanout_id) values ('PC', '收信監控收發室', 'u:x', 'old', gen_random_uuid())")
  const r1 = await run(true)
  assert.equal(r1.sent, 0)
  assert.equal((await st('PC')).state, 'stuck', '恢復通知沒寄成，保持 stuck')
  assert.ok((await st('PC')).notified_at, 'notified_at 還在，下一輪才知道要補寄恢復')
  await db.query("delete from relay.messages where body = 'old'")
  await db.query("update relay.messages set created_at = now() - interval '2 hours' where from_agent = '收信監控收發室'")
  const r2 = await run(true)
  assert.equal(r2.sent, 1)
  assert.equal((await st('PC')).state, 'ok')
  assert.equal((await st('PC')).notified_at, null)
  assert.match((await sent()).at(-1).body, /恢復了/)
})

test('實跑：手機、不在線、停用、額度扣住中的節點不看；扣住時間過了照常看', { skip }, async () => {
  const { db, node, unacked, run, st } = await boot()
  await node('PHONE', { kind: 'phone' }); await node('GONE', { seen: '10 minutes' }); await node('OFF'); await node('HOLD'); await node('LATE')
  await db.query("update relay.nodes set status = 'revoked' where id = 'OFF'")
  await db.query("update relay.nodes set inbox_hold_until = now() + interval '2 hours' where id = 'HOLD'")
  await db.query("update relay.nodes set inbox_hold_until = now() - interval '1 minute' where id = 'LATE'")
  for (const id of ['PHONE', 'GONE', 'OFF', 'HOLD', 'LATE']) await unacked(id, '30 minutes')
  const r = await run(false)
  assert.equal(r.nodes, 1, '只有 LATE 被看')
  for (const id of ['PHONE', 'GONE', 'OFF', 'HOLD']) assert.equal(await st(id), undefined, id)
  assert.equal((await st('LATE')).state, 'stuck')
})

test('實跑：擁有者查不到、單一節點寄信出錯，不影響其他節點；每節點每小時最多 3 封', { skip }, async () => {
  const { db, node, unacked, run, sent, st, aged } = await boot()
  await node('NOOWNER', { owner: null }); await node('BOOM'); await node('REFUSED'); await node('GOOD', { machine: '好電腦' }); await node('BUSY', { machine: '忙電腦' })
  for (const id of ['NOOWNER', 'BOOM', 'REFUSED', 'GOOD', 'BUSY']) await unacked(id, '20 minutes')
  await run(true)
  for (const id of ['NOOWNER', 'BOOM', 'REFUSED', 'GOOD', 'BUSY']) await aged(id, 11)
  for (let i = 0; i < 3; i++) await db.query("insert into relay.messages(from_node, from_agent, to_node, body, fanout_id) values ('BUSY', '收信監控收發室', 'u:x', 'old', gen_random_uuid())")
  const r = await run(true)
  assert.equal(r.nodes, 5)
  assert.equal(r.sent, 1)
  assert.deepEqual((await sent()).filter(m => m.body !== 'old').map(m => m.from_node), ['GOOD'], '只有 GOOD 寄成功；沒有擁有者、丟例外、被拒絕（回傳 error）、超過每小時 3 封的都沒寄')
  for (const id of ['NOOWNER', 'BOOM', 'REFUSED', 'GOOD', 'BUSY']) assert.equal((await st(id)).state, 'stuck', id)
  assert.ok((await st('GOOD')).notified_at, '寄成功的才記 notified_at')
  for (const id of ['REFUSED', 'BOOM', 'BUSY']) assert.equal((await st(id)).notified_at, null, id + ' 沒寄成，下一輪再試')
})
