// 夥伴視窗卡在確認框超過 5 分鐘的保底通知（#2256）：20261125300000_waiting_notice_stuck_prompt.sql
//   asn_relay_waiting_notice 多收 p_kind = 'stuck_prompt'，內文帶畫面片段（p_detail）：換行保留、其他控制字元換空白、最多 600 字。
// 靜態：簽章、security definer、search_path 空、權限與上一版相同；回復檔本體逐字等於上一版；migration 不動表、不給匿名權限。
// 實跑（pglite，沒裝就略過）：套用 migration 裡真正的函式本體，放真的控制字元進去驗正規式；
//   舊種類（permission／input／other／login／forward_stuck）的內文在新舊本體下逐字相同；用回復檔（舊本體）跑 stuck_prompt 回 bad_request，證明守門有效。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261125300000_waiting_notice_stuck_prompt.sql'
const PREV = '20261124100000_unnamed_device_label.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = p => rd(fs.readFileSync(new URL(p, import.meta.url), 'utf8'))
const mig = read(`../supabase/migrations/${F}`)
const down = read(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`)
const prev = read(`../supabase/migrations/${PREV}`)
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
  assert.equal(files.filter(f => f.startsWith('20261125300000_')).length, 1, '版本號沒撞')
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate|drop /i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down]) {
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
    assert.ok(f.includes(`revoke all on function ${FN}(${SIG}) from public, anon, authenticated;`))
    assert.ok(f.includes(`grant execute on function ${FN}(${SIG}) to service_role;`))
  }
  const b = body(mig, FN)
  assert.ok(b.includes('create or replace function public.asn_relay_waiting_notice(p_node text, p_window text, p_kind text, p_detail text default null, p_tool text default null)'))
  assert.match(b, /security definer/i)
  assert.equal(b.match(/set search_path to ''/i)?.length, 1)
  assert.match(b, /returns jsonb/i)
  assert.match(b, /'stuck_prompt'/)
  // 回復檔本體逐字等於上一版
  assert.equal(body(down, FN), body(prev, FN), '回復檔本體＝上一版')
  assert.notEqual(body(mig, FN), body(prev, FN), '新本體確實改過')
  assert.doesNotMatch(body(down, FN), /stuck_prompt/)
})

let PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'
const NODE = 'xisu7k2m'
const HEAD = '30家用：夥伴「win」卡在確認框超過 5 分鐘'

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
  await db.exec(body(prev, 'relay.device_label'))
  await db.exec(body(source, FN))
  return db
}

// 呼叫一次，回 { res: 函式回傳, sent: 寄出的 { topic, body }（沒寄出是 undefined） }
async function call(db, kind, detail = null, tool = null, window = 'win') {
  await db.query('delete from relay.sent')
  const res = (await db.query('select public.asn_relay_waiting_notice($1, $2, $3, $4, $5) r', [NODE, window, kind, detail, tool])).rows[0].r
  const sent = (await db.query('select topic, body from relay.sent')).rows[0]
  return { res, sent }
}

test('stuck_prompt：第一行寫設備名、視窗、卡了多久；主題與等待確認同一桶；p_tool 不進內文', { skip }, async () => {
  const db = await setup(mig)
  const { res, sent } = await call(db, 'stuck_prompt', 'Do you want to proceed?\n1. Yes', 'Bash')
  assert.equal(res.ok, true); assert.equal(res.notify, 'sent')
  assert.equal(sent.topic, 'waiting')
  assert.equal(sent.body, `${HEAD}\nDo you want to proceed?\n1. Yes`)
  assert.ok(!sent.body.includes('Bash'), 'p_tool 不寫進內文')
  assert.ok(!sent.body.includes('權限'), '不是「在等你確認（權限）」那句')
})

test('stuck_prompt 畫面片段：換行保留；\\t、\\x01、\\r、\\x1b、\\x7f 變空白（正規式在 PG 真的有效）', { skip }, async () => {
  const db = await setup(mig)
  const { sent } = await call(db, 'stuck_prompt', 'a\tb\x01c\x1bd\x7fe\nline2\r\nline3\x0bz\x1fq')
  const frag = sent.body.slice(HEAD.length + 1)
  assert.equal(frag, 'a b c d e\nline2 \nline3 z q')
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(sent.body), '內文裡沒有換行以外的控制字元')
  assert.equal((sent.body.match(/\n/g) ?? []).length, 3, '換行：第一行後 1 個＋片段內 2 個')
})

test('stuck_prompt：片段最多 600 字、頭尾空白切掉；p_detail 空白或 null 時只有第一行', { skip }, async () => {
  const db = await setup(mig)
  const long = await call(db, 'stuck_prompt', '  ' + 'あ'.repeat(700) + '  ')
  assert.equal(long.sent.body, `${HEAD}\n${'あ'.repeat(600)}`)
  for (const d of [null, '', '   ', '\t \n ', '\x1b\x01']) {
    const r = await call(db, 'stuck_prompt', d)
    assert.equal(r.sent.body, HEAD, `p_detail=${JSON.stringify(d)}`)
  }
})

test('stuck_prompt：視窗名空白回 bad_request、不寄信', { skip }, async () => {
  const db = await setup(mig)
  const r = await call(db, 'stuck_prompt', 'x', null, '  ')
  assert.deepEqual(r.res, { error: 'bad_request' })
  assert.equal(r.sent, undefined)
})

// 舊種類：同一組呼叫，新本體與回復檔（舊本體）寄出的主題與內文逐字相同
const OLD_CALLS = [
  ['permission', null, 'Bash'], ['permission', null, null], ['permission', null, 'bad tool!'], ['permission', 'ignored', 'mcp__x.y:z'],
  ['input', 'Pick one\tof these\n1. a', null], ['input', null, null], ['input', '   ', null],
  ['other', null, null], ['other', 'detail 不該出現', 'Bash'],
  ['login', null, null],
  ['forward_stuck', 'frame', '3'], ['forward_stuck', 'wrong_to', null], ['forward_stuck', 'zzz', '12'],
  ['forward_stuck_manual', 'head_mismatch', '4'], ['forward_stuck_manual', null, null],
]

test('舊種類不變：permission／input／other／login／forward_stuck 的內文在新舊本體下逐字相同；未知 kind 仍回 bad_request', { skip }, async () => {
  const a = await setup(mig)
  const b = await setup(down)
  for (const [kind, detail, tool] of OLD_CALLS) {
    const x = await call(a, kind, detail, tool)
    const y = await call(b, kind, detail, tool)
    assert.ok(y.sent?.body, `${kind} 舊本體有寄出`)
    assert.deepEqual(x, y, `${kind} ${JSON.stringify([detail, tool])}`)
  }
  assert.equal((await call(a, 'permission', null, 'Bash')).sent.body, '30家用：夥伴「win」在等你確認（權限：Bash）\n已經等超過 2 分鐘。')
  for (const kind of ['bogus', 'stuck', 'stuck_prompt_x', '', null]) {
    for (const db of [a, b]) {
      const r = await call(db, kind, 'x')
      assert.deepEqual(r.res, { error: 'bad_request' }, `kind=${kind}`)
      assert.equal(r.sent, undefined)
    }
  }
  const gone = (await a.query(`select public.asn_relay_waiting_notice('nonode00', 'win', 'stuck_prompt', 'x', null) r`)).rows[0].r
  assert.deepEqual(gone, { error: 'forbidden' })
})

test('守門有效：回復檔（舊本體）不認得 stuck_prompt，回 bad_request、不寄信', { skip }, async () => {
  const db = await setup(down)
  const r = await call(db, 'stuck_prompt', 'Do you want to proceed?', null)
  assert.deepEqual(r.res, { error: 'bad_request' })
  assert.equal(r.sent, undefined)
})

closeAtEnd()
