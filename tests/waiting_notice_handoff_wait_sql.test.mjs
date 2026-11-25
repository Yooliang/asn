// 換班接手等前任子代理太久的通知（#1908 M2）：20261125420000_waiting_notice_handoff_wait.sql
//   asn_relay_waiting_notice 多收 p_kind = 'handoff_wait'；p_tool＝子代理件數、p_detail＝已等分鐘，都只收純數字。
// 靜態：簽章、security definer、search_path 空、權限與上一版相同；回復檔本體逐字等於上一版（20261125300000）。
// 實跑（pglite，沒裝就略過）：內文逐字；N 不知道／M 格式不合的寫法；主題與等待確認同一桶；舊種類在新舊本體下逐字相同；回復檔（舊本體）不認得 handoff_wait。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261125420000_waiting_notice_handoff_wait.sql'
const PREV = '20261125300000_waiting_notice_stuck_prompt.sql'
const BASE = '20261124100000_unnamed_device_label.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = p => rd(fs.readFileSync(new URL(p, import.meta.url), 'utf8'))
const mig = read(`../supabase/migrations/${F}`)
const down = read(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`)
const prev = read(`../supabase/migrations/${PREV}`)
const base = read(`../supabase/migrations/${BASE}`)
const body = (sql, name) => {
  const s = sql.toLowerCase().indexOf(`create or replace function ${name}(`)
  assert.ok(s >= 0, name)
  return sql.slice(s, sql.indexOf('$function$;', sql.toLowerCase().indexOf('$function$', s) + 5) + 11)
}
const FN = 'public.asn_relay_waiting_notice'
const SIG = 'text, text, text, text, text'

test('靜態：簽章、security definer、search_path、權限與上一版相同；回復檔本體逐字＝上一版；不動表、不給匿名權限', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf(PREV), '編號在上一版之後')
  assert.equal(files.filter(f => f.startsWith('20261125420000_')).length, 1, '版本號沒撞')
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate|drop /i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down]) {
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
    assert.ok(f.includes(`revoke all on function ${FN}(${SIG}) from public, anon, authenticated;`))
    assert.ok(f.includes(`grant execute on function ${FN}(${SIG}) to service_role;`))
  }
  const b = body(mig, FN)
  assert.match(b, /security definer/i)
  assert.equal(b.match(/set search_path to ''/i)?.length, 1)
  assert.match(b, /'handoff_wait'/)
  assert.equal(body(down, FN), body(prev, FN), '回復檔本體＝上一版')
  assert.notEqual(body(mig, FN), body(prev, FN))
  assert.doesNotMatch(body(down, FN), /handoff_wait/)
})

let PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'
const NODE = 'xisu7k2m'
const HEAD = '30家用：夥伴「win」換班接手在等'
const TAIL = '子代理可能卡在確認框；要放行，可以到那台的工作管理員按『關閉視窗』，或回它的視窗處理確認框。'

async function setup(source) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, machine text, kind text, platform text);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    create table relay.sent(node text, topic text, body text);
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_limit integer default 3, p_window interval default interval '1 hour') returns jsonb language plpgsql as $$
      begin insert into relay.sent values (p_node, p_topic, p_body); return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', '[]'::jsonb); end $$;
    insert into relay.tenants values ('${T1}', '${U1}');
    insert into relay.nodes(id, tenant_id, owner_user, name, machine) values ('${NODE}', '${T1}', '${U1}', '30家用', 'HOST-1');`)
  await db.exec(body(base, 'relay.device_label'))
  await db.exec(body(source, FN))
  return db
}

async function call(db, kind, detail = null, tool = null, window = 'win') {
  await db.query('delete from relay.sent')
  const res = (await db.query('select public.asn_relay_waiting_notice($1, $2, $3, $4, $5) r', [NODE, window, kind, detail, tool])).rows[0].r
  const sent = (await db.query('select topic, body from relay.sent')).rows[0]
  return { res, sent }
}

test('handoff_wait：內文逐字；主題與等待確認同一桶', { skip }, async () => {
  const db = await setup(mig)
  const { res, sent } = await call(db, 'handoff_wait', '25', '3')
  assert.equal(res.ok, true); assert.equal(res.notify, 'sent')
  assert.equal(sent.topic, 'waiting')
  assert.equal(sent.body, `${HEAD} 3 個子代理做完，已經等了 25 分鐘。${TAIL}`)
  assert.equal(sent.body, '30家用：夥伴「win」換班接手在等 3 個子代理做完，已經等了 25 分鐘。子代理可能卡在確認框；要放行，可以到那台的工作管理員按『關閉視窗』，或回它的視窗處理確認框。')
})

test('handoff_wait：N 不知道（空、0、非數字、太長）寫「在等它把手上的工作做完」；M 不合格式寫「好一陣子」；自由文字不進內文', { skip }, async () => {
  const db = await setup(mig)
  for (const tool of [null, '', '0', '000', 'Bash', '1234', '3 x', '-1']) {
    const { sent } = await call(db, 'handoff_wait', '25', tool)
    assert.equal(sent.body, `${HEAD}它把手上的工作做完，已經等了 25 分鐘。${TAIL}`, `tool=${tool}`)
  }
  for (const detail of [null, '', '很久', '12345', '1 2', '-3', '25\nrm']) {
    const { sent } = await call(db, 'handoff_wait', detail, '2')
    assert.equal(sent.body, `${HEAD} 2 個子代理做完，已經等了好一陣子。${TAIL}`, `detail=${JSON.stringify(detail)}`)
  }
  assert.equal((await call(db, 'handoff_wait', '007', '02')).sent.body, `${HEAD} 2 個子代理做完，已經等了 7 分鐘。${TAIL}`, '前導 0 去掉')
})

test('handoff_wait：視窗名空白回 bad_request、不寄信', { skip }, async () => {
  const db = await setup(mig)
  const r = await call(db, 'handoff_wait', '25', '3', '  ')
  assert.deepEqual(r.res, { error: 'bad_request' })
  assert.equal(r.sent, undefined)
})

const OLD_CALLS = [
  ['permission', null, 'Bash'], ['permission', null, null], ['permission', 'ignored', 'mcp__x.y:z'],
  ['input', 'Pick one\tof these\n1. a', null], ['input', null, null],
  ['other', null, null], ['other', '25', '3'],
  ['login', null, null],
  ['forward_stuck', 'frame', '3'], ['forward_stuck', 'zzz', '12'], ['forward_stuck_manual', 'head_mismatch', '4'],
  ['stuck_prompt', 'Do you want to proceed?\n1. Yes', 'Bash'], ['stuck_prompt', null, null],
]

test('舊種類不變：內文在新舊本體下逐字相同；未知 kind 仍回 bad_request', { skip }, async () => {
  const a = await setup(mig)
  const b = await setup(down)
  for (const [kind, detail, tool] of OLD_CALLS) {
    const x = await call(a, kind, detail, tool)
    const y = await call(b, kind, detail, tool)
    assert.ok(y.sent?.body, `${kind} 舊本體有寄出`)
    assert.deepEqual(x, y, `${kind} ${JSON.stringify([detail, tool])}`)
  }
  for (const kind of ['bogus', 'handoff', 'handoff_wait_x', '', null]) {
    for (const db of [a, b]) {
      const r = await call(db, kind, '25', '3')
      assert.deepEqual(r.res, { error: 'bad_request' }, `kind=${kind}`)
      assert.equal(r.sent, undefined)
    }
  }
})

test('守門有效：回復檔（舊本體）不認得 handoff_wait，回 bad_request、不寄信', { skip }, async () => {
  const db = await setup(down)
  const r = await call(db, 'handoff_wait', '25', '3')
  assert.deepEqual(r.res, { error: 'bad_request' })
  assert.equal(r.sent, undefined)
})

closeAtEnd()
