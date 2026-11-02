// 手機回報自己的平台（20261102170000_node_platform_phone.sql；#652、todo-next-174 的 A）：
// 1. 靜態：三個既有函式只多加行、原有的行逐字不變（逐行比對）；回復腳本把它們換回原文；新函式只授權 service_role。
// 2. 實跑（pglite，沒裝就略過）：只改自己節點的 platform 且不碰機器橋的 launch_closed_reason；手機不能被要求安裝並登入；
//    收信卡住監控不看手機；平台是空的（舊版）照舊當電腦。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SETUP = rd('migrations/20261102140000_setup_requests.sql')
const WATCH = rd('migrations/20261102130000_inbox_watch.sql')
const MIG = rd('migrations/20261102170000_node_platform_phone.sql')
const DOWN = rd('sql/rollback/20261102170000_node_platform_phone_down.sql')
const grab = (src, start) => { const i = src.indexOf(start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const FUNCS = [
  ['create or replace function public.asn_setup_request(', SETUP, 4],
  ['create or replace function public.asn_relay_setup_poll(', SETUP, 4],
  ['create or replace function public.asn_relay_inbox_watch(', WATCH, 1],
]

test('靜態：三個既有函式只多加行（原有的行逐字不變）；回復腳本換回原文', () => {
  for (const [start, orig, added] of FUNCS) {
    const a = grab(orig, start).split('\n'), b = grab(MIG, start).split('\n')
    assert.equal(b.length, a.length + added, start)
    // b 去掉新增的行後必須與 a 完全相同：用最長共同子序列的簡化版——逐行比對，新增行只出現在 b
    let i = 0, extra = 0
    for (const line of b) { if (i < a.length && line === a[i]) i++; else extra++ }
    assert.equal(i, a.length, `${start} 原有的行有被改動或刪掉`)
    assert.equal(extra, added, start)
    assert.ok(DOWN.includes(grab(orig, start)), `${start} 回復腳本要放回原文`)
  }
})

test('靜態：新函式只授權 service_role、security definer、search_path 空；約束多收 android／ios；不改授權', () => {
  assert.match(MIG, /revoke all on function public\.asn_relay_set_node_platform\(text, text\) from public, anon, authenticated;/)
  assert.match(MIG, /grant execute on function public\.asn_relay_set_node_platform\(text, text\) to service_role;/)
  assert.match(MIG, /security definer\n set search_path to ''/)
  assert.match(MIG, /platform in \('linux', 'windows', 'macos', 'android', 'ios'\)/)
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /launch_closed_reason/, '不碰機器橋回報的 launch_closed_reason')
  assert.match(DOWN, /update relay\.nodes set platform = null where platform in \('android', 'ios'\)/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const U1 = '11111111-1111-1111-1111-111111111111'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, machine text, kind text, status text default 'active', owner_user uuid, last_seen_at timestamptz,
      platform text, launch_closed_reason text, inbox_hold_until timestamptz);
    alter table relay.nodes add constraint nodes_platform_check check (platform is null or platform in ('linux', 'windows', 'macos'));
    create table relay.asn_presence(node text, window_name text default 'w', version text, updated_at timestamptz default now());
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(), user_id uuid, event text not null, node text, detail jsonb);
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, body text, created_at timestamptz default now(), acked_at timestamptz, fanout_id uuid);
    create function public.asn_person_alias(p_user uuid) returns text language sql as $$ select 'u:' || substr(md5(p_user::text), 1, 12) $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean, p_signed_user uuid, p_as_person boolean)
      returns jsonb language plpgsql as $$ begin insert into relay.messages(from_node, from_agent, to_node, body) values (p_from_node, p_from_agent, p_to_node, p_body); return jsonb_build_object('ok', true); end $$;`)
  for (const sql of [SETUP.slice(0, SETUP.indexOf('-- 清理：')) + '\ncommit;', WATCH.slice(0, WATCH.indexOf('-- ===cron===')) + '\ncommit;', MIG]) await db.exec(sql)
  const q = async (t, a) => (await db.query(t, a)).rows
  const node = (id, o = {}) => db.query('insert into relay.nodes(id, owner_user, kind, platform, last_seen_at) values ($1,$2,$3,$4, now())', [id, U1, o.kind ?? null, o.platform ?? null])
    .then(() => db.query("insert into relay.asn_presence(node, version) values ($1, '0.2.2')", [id]))
  return { db, q, node }
}

test('實跑：set_node_platform 只改自己節點的 platform；壞值不改；不碰 launch_closed_reason', { skip }, async () => {
  const { db, q, node } = await boot()
  await node('PH'); await node('PC')
  await db.query("update relay.nodes set launch_closed_reason = '機器橋寫的原因' where id = 'PC'")
  const set = async (n, p) => (await q('select public.asn_relay_set_node_platform($1,$2) r', [n, p]))[0].r
  assert.deepEqual(await set('PH', 'android'), { ok: true })
  assert.deepEqual(await set('PC', 'windows'), { ok: true })
  assert.deepEqual((await q("select id, platform from relay.nodes order by id")).map(r => r.platform), ['windows', 'android'])
  assert.equal((await q("select launch_closed_reason r from relay.nodes where id = 'PC'"))[0].r, '機器橋寫的原因')
  for (const bad of [null, '', 'tablet', 'Android', ' android']) assert.equal((await set('PH', bad)).error, 'bad_request', String(bad))
  assert.equal((await q("select platform from relay.nodes where id = 'PH'"))[0].platform, 'android', '壞值不改')
  await db.query("update relay.nodes set status = 'revoked' where id = 'PC'")
  await set('PC', 'linux')
  assert.equal((await q("select platform from relay.nodes where id = 'PC'"))[0].platform, 'windows', '停用的節點不動')
  await assert.rejects(db.exec("update relay.nodes set platform = 'tablet' where id = 'PH'"), /nodes_platform_check/)
})

test('實跑：手機不能被要求安裝並登入（建立回 unsupported_platform、取走不交）；平台是空的與電腦照舊', { skip }, async () => {
  const { db, q, node } = await boot()
  await node('PH', { platform: 'android' }); await node('IP', { platform: 'ios' }); await node('PC', { platform: 'windows' }); await node('OLD')
  const req = async n => (await q('select public.asn_setup_request($1,$2) r', [U1, n]))[0].r
  assert.equal((await req('PH')).error, 'unsupported_platform')
  assert.equal((await req('IP')).error, 'unsupported_platform')
  assert.equal((await req('PC')).ok, true)
  assert.equal((await req('OLD')).ok, true, '平台是空的（舊版）照舊當電腦')
  assert.equal((await q("select count(*)::int n from relay.setup_requests where node in ('PH','IP')"))[0].n, 0, '手機不留任何一列')
  // 舊資料：先有請求，之後這個節點才回報成手機 → 取走也不交（請求留著，10 分鐘過期）
  await db.query("insert into relay.setup_requests(node, requested_by) values ('PH', $1)", [U1])
  const poll = async n => (await q("select public.asn_relay_setup_poll($1, '0.2.2') r", [n]))[0].r
  assert.deepEqual(await poll('PH'), { requested: false })
  assert.equal((await q("select status from relay.setup_requests where node = 'PH'"))[0].status, 'pending')
  assert.equal((await poll('PC')).requested, true)
})

test('實跑：收信卡住監控不看手機（platform 是 android／ios；原本的 kind = phone 也照舊不看）', { skip }, async () => {
  const { db, q, node } = await boot()
  await node('PH', { platform: 'android' }); await node('IP', { platform: 'ios' }); await node('KP', { kind: 'phone' }); await node('PC', { platform: 'windows' }); await node('OLD')
  for (const id of ['PH', 'IP', 'KP', 'PC', 'OLD']) await db.query("insert into relay.messages(from_node, from_agent, to_node, body, created_at) values ('S', 'x', $1, 'b', now() - interval '30 minutes')", [id])
  const r = (await q('select public.asn_relay_inbox_watch(false) r'))[0].r
  assert.equal(r.nodes, 2, '只看 PC 與平台是空的 OLD')
  assert.deepEqual((await q('select node from relay.inbox_watch order by node')).map(x => x.node), ['OLD', 'PC'])
})
