// 遠端管理夥伴視窗 migration（20261022120000_partner_ops.sql）：
// 1. 靜態檢查：只給 service_role、security definer＋search_path ''、RLS 開且沒有 policy、下令函式核對簽章與兩端擁有關係。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres 套用 migration：
//    下令（簽章、擁有關係、同租戶、名單、保護名單、開放、改名撞名、模型字元、忙碌、每小時上限）、取走（只拿自己節點、逾時標失敗、帶下令設備名）、
//    回報（只改自己節點、taken 才能改、4KB 上限）、查進度（只回自己租戶）。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261022120000_partner_ops.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：四個函式 security definer、search_path 空、只授權 service_role；資料表開 RLS 且不建 policy', () => {
  for (const sig of ['irori_relay_partner_op\\(text, uuid, text, text, text, text, text, text\\)', 'irori_relay_partner_ops\\(text, uuid, uuid\\[\\]\\)',
    'irori_relay_partner_op_pending\\(text\\)', 'irori_relay_partner_op_result\\(text, uuid, text, text, jsonb\\)', 'irori_relay_partner_op_progress\\(text, uuid, text\\)']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${sig} from public, anon, authenticated;`), sig)
    assert.match(sql, new RegExp(`grant execute on function public\\.${sig} to service_role;`), sig)
  }
  assert.equal((sql.match(/security definer\nset search_path to ''/g) ?? []).length, 5)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(sql, /alter table relay\.partner_ops enable row level security;/)
  assert.match(sql, /revoke all on relay\.partner_ops from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /create policy/)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
})

test('靜態：下令要本人簽章——簽章的人擁有呼叫節點與目標節點、同租戶；沒有 role=owner 的後門', () => {
  const f = sql.slice(sql.indexOf('function public.irori_relay_partner_op('), sql.indexOf('function public.irori_relay_partner_ops('))
  assert.match(f, /asn_user_owns_node\(p_signed_user, p_actor\)/)
  assert.match(f, /asn_user_owns_node\(p_signed_user, p_node\)/)
  assert.match(f, /tenant_id is not distinct from v_t/)
  assert.doesNotMatch(f, /role = 'owner'/)
  assert.match(f, /engine = 'asn'/)
  assert.match(f, /'protected'/); assert.match(f, /'no_launcher'/); assert.match(f, /'busy'/); assert.match(f, /'rate_limited'/); assert.match(f, />= 30/)
  assert.match(f, /p_op <> 'info' and v_l is null/)
  assert.match(f, /'already_online'/); assert.match(f, /'no_session'/); assert.match(f, /'device_offline'/)
  assert.match(f, /session_id[\s\S]*case when p_op = 'resume' then v_sid end/, 'session 只來自夥伴記錄，不收呼叫端傳的')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const LAUNCHER = '{"profiles":[{"id":"claude"}],"cwd_allow":["x"]}'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, launcher jsonb, bell_topic text, last_seen_at timestamptz default now());
    create table relay.partners(partner_id text primary key, tenant_id uuid, node text, current_name text, current_session text, engine text, updated_at timestamptz default now());
    create table relay.partner_names(partner_id text, name text, renamed_at timestamptz default now());
    create table relay.roster(node text, name text, engine text, seen_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.irori_relay_launch_name_ok(p_name text) returns boolean language sql immutable as
      $$ select p_name is not null and p_name ~ '^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$' $$;
    insert into relay.nodes(id, tenant_id, owner_user, name, launcher, bell_topic) values
      ('P','${T1}','${U1}','小良的手機', null, 'bell-P'),
      ('H','${T1}','${U1}','家用機', '${LAUNCHER}', 'bell-H'),
      ('C','${T1}','${U1}','沒開放的電腦', null, 'bell-C'),
      ('X','${T2}','${U2}','別人的電腦', '${LAUNCHER}', 'bell-X'),
      ('Y','${T1}','${U2}','同租戶但不是你的', '${LAUNCHER}', 'bell-Y');
    insert into relay.nodes(id, tenant_id, owner_user, name, launcher, bell_topic, last_seen_at) values
      ('D','${T1}','${U1}','關機的電腦', '${LAUNCHER}', 'bell-D', now() - interval '1 hour');
    insert into relay.partners(partner_id, tenant_id, node, current_name, current_session, engine) values
      ('p_00000000000000000001','${T1}','H','小離','sess-1111-aaaa','claude'),
      ('p_00000000000000000002','${T1}','H','小文','sess-0000-online','claude'),
      ('p_00000000000000000003','${T1}','H','小無',null,'claude'),
      ('p_00000000000000000004','${T1}','H','新名','sess-2222-bbbb',null),
      ('p_00000000000000000005','${T1}','H','小碼','sess-4444-dddd','codex'),
      ('p_00000000000000000006','${T1}','D','遠離','sess-3333-cccc','claude'),
      ('p_00000000000000000007','${T1}','C','沒開放','sess-5555-eeee','claude'),
      ('p_00000000000000000008','${T2}','X','別人離線','sess-6666-ffff','claude'),
      ('p_00000000000000000009','${T1}','H','家用收發室','sess-7777-gggg','claude');
    insert into relay.partner_names(partner_id, name, renamed_at) values
      ('p_00000000000000000004','舊名', now() - interval '2 days'), ('p_00000000000000000004','更舊', now() - interval '9 days');
    insert into relay.roster(node, name, engine) values ('H','小文','claude'), ('H','小武','claude'), ('H','H-ASN','asn'), ('H','家用收發室',null),
      ('C','小乙','claude'), ('X','別人','claude'), ('Y','他的','claude');
    insert into relay.roster(node, name, engine, seen_at) values ('H','舊的','claude', now() - interval '10 minutes');`)
  await db.exec(sql)
  const one = async (text, args) => (await db.query(text, args)).rows[0]
  const op = async (o = {}) => (await one('select public.irori_relay_partner_op($1,$2,$3,$4,$5,$6,$7,$8) r',
    [o.actor ?? 'P', o.user === undefined ? U1 : o.user, o.node ?? 'H', o.name ?? '小文', o.op ?? 'close', o.new_name ?? null, o.model ?? null, o.note ?? null])).r
  return { db, one, op, q: async (t, a) => (await db.query(t, a)).rows }
}

test('實跑（pglite）：下令的核對——簽章、擁有關係、同租戶、名單、保護名單、開放、改名、模型、補充的話', { skip }, async () => {
  const { op, q } = await boot()
  const ok = await op()
  assert.equal(ok.bell_topic, 'bell-H'); assert.ok(ok.id)
  const row = (await q('select * from relay.partner_ops where id = $1', [ok.id]))[0]
  assert.deepEqual([row.requested_by, row.node, row.name, row.op, row.status, row.tenant_id, row.new_name, row.model, row.note], ['P', 'H', '小文', 'close', 'pending', T1, null, null, null])
  assert.equal((await op({ user: null, name: '小武' })).error, 'forbidden', '沒簽章')
  assert.equal((await op({ user: U2, name: '小武' })).error, 'forbidden', '簽章的人不擁有呼叫節點')
  assert.equal((await op({ node: 'Y', name: '他的' })).error, 'not_found', '同租戶但目標不是簽章者的')
  assert.equal((await op({ node: 'X', name: '別人' })).error, 'not_found', '別租戶')
  assert.equal((await op({ node: 'Z', name: '小武' })).error, 'not_found')
  assert.equal((await op({ name: '不存在' })).error, 'not_found', '不在名單上')
  assert.equal((await op({ name: '舊的' })).error, 'not_found', '3 分鐘沒出現在名單上')
  assert.equal((await op({ name: 'H-ASN' })).error, 'protected', 'ASN 視窗')
  assert.equal((await op({ name: '家用收發室' })).error, 'protected', '收發室')
  assert.equal((await op({ node: 'C', name: '小乙' })).error, 'no_launcher', '沒開放')
  assert.equal((await op({ node: 'C', name: '小乙', op: 'info' })).bell_topic, 'bell-C', '詳情不需要開放')
  assert.equal((await op({ name: '小武', op: 'bogus' })).error, 'bad_request')
  assert.equal((await op({ name: '小武', op: 'rename', new_name: '-rf' })).error, 'bad_name')
  assert.equal((await op({ name: '小武', op: 'rename', new_name: '小文' })).error, 'name_taken', '撞到名單上別的名字')
  assert.equal((await op({ name: '小武', op: 'rename', new_name: '小文' })).error, 'name_taken')
  for (const bad of [null, '', 'a b', 'a;b', 'x'.repeat(61)]) assert.equal((await op({ name: '小武', op: 'model', model: bad })).error, 'bad_model', String(bad))
  assert.equal((await op({ name: '小武', op: 'handover', note: 'x'.repeat(1001) })).error, 'bad_note')
  const m = await op({ name: '小武', op: 'model', model: 'opus[1m]', note: '不該存', new_name: '不該存' })
  const mr = (await q('select model, note, new_name from relay.partner_ops where id = $1', [m.id]))[0]
  assert.deepEqual(mr, { model: 'opus[1m]', note: null, new_name: null }, '只存該動作用得到的欄位')
})

test('實跑（pglite）：喚醒——已離線的夥伴用夥伴記錄裡的 session；在線、無 session、電腦不在線、沒開放、別租戶都擋', { skip }, async () => {
  const { op, one, q } = await boot()
  const r = await op({ name: '小離', op: 'resume', new_name: '不該存', model: 'opus', note: '不該存' })
  assert.equal(r.bell_topic, 'bell-H'); assert.ok(r.id)
  const row = (await q('select op, name, session_id, new_name, model, note, status from relay.partner_ops where id = $1', [r.id]))[0]
  assert.deepEqual(row, { op: 'resume', name: '小離', session_id: 'sess-1111-aaaa', new_name: null, model: null, note: null, status: 'pending' }, 'session 由後台從夥伴記錄查，只存該動作用得到的欄位')
  const got = (await one(`select public.irori_relay_partner_op_pending('H') r`)).r
  assert.deepEqual([got[0].op, got[0].name, got[0].session_id], ['resume', '小離', 'sess-1111-aaaa'], '待辦帶 session_id')
  assert.equal((await op({ name: '小文', op: 'resume' })).error, 'already_online', '3 分鐘內在名單上')
  assert.equal((await op({ name: 'XIAOWEN', op: 'resume' })).error, 'not_found', '沒有這位夥伴')
  assert.equal((await op({ name: '小無', op: 'resume' })).error, 'no_session')
  assert.equal((await op({ name: '小碼', op: 'resume' })).error, 'not_claude')
  assert.equal((await op({ node: 'D', name: '遠離', op: 'resume' })).error, 'device_offline', '那台電腦心跳與名單都超過 3 分鐘')
  assert.equal((await op({ node: 'C', name: '沒開放', op: 'resume' })).error, 'no_launcher')
  assert.equal((await op({ node: 'X', name: '別人離線', op: 'resume' })).error, 'not_found', '別租戶')
  assert.equal((await op({ name: '家用收發室', op: 'resume' })).error, 'protected')
  assert.equal((await op({ user: null, name: '小離', op: 'resume' })).error, 'forbidden', '沒簽章')
  assert.equal((await op({ name: '小離', op: 'resume' })).error, 'busy', '同一位上一筆還沒完成')
  // 改名過的夥伴：舊名 7 天內認得，超過就不認
  assert.equal((await q('select current_session from relay.partners where current_name = $1', ['新名']))[0].current_session, 'sess-2222-bbbb')
  const viaOld = await op({ name: '舊名', op: 'resume' })
  assert.ok(viaOld.id, '7 天內的舊名')
  assert.equal((await q('select session_id from relay.partner_ops where id = $1', [viaOld.id]))[0].session_id, 'sess-2222-bbbb')
  assert.equal((await op({ name: '更舊', op: 'resume' })).error, 'not_found', '超過 7 天的舊名不認')
  // 節點心跳新鮮但名單空的電腦也算在線
  await q("update relay.nodes set last_seen_at = now() where id = 'D'")
  assert.ok((await op({ node: 'D', name: '遠離', op: 'resume' })).id, '心跳在 3 分鐘內就算在線')
})

test('實跑（pglite）：忙碌與每小時上限', { skip }, async () => {
  const { op, q } = await boot()
  const a = await op({ op: 'info' })
  assert.equal((await op({ op: 'close' })).error, 'busy', '同一個視窗有未完成的')
  assert.ok((await op({ name: '小武', op: 'info' })).id, '別的視窗不受影響')
  await q(`update relay.partner_ops set status = 'ok', done_at = now() where id = $1`, [a.id])
  assert.ok((await op({ op: 'info' })).id, '完成後可再下')
  await q(`update relay.partner_ops set status = 'pending', created_at = now() - interval '11 minutes'`)
  assert.ok((await op({ op: 'info' })).id, '10 分鐘前的未完成不算忙碌')
  await q(`delete from relay.partner_ops`)
  for (let i = 0; i < 30; i++) await q(`insert into relay.partner_ops(requested_by, node, name, op, status, done_at) values ('P','H','小文','info','ok', now())`)
  assert.equal((await op({ op: 'info' })).error, 'rate_limited')
  await q(`update relay.partner_ops set created_at = now() - interval '2 hours'`)
  assert.ok((await op({ op: 'info' })).id)
})

test('實跑（pglite）：取走與回報——只動自己節點、逾時標失敗、帶下令設備名、4KB 上限、只有 taken 能回報', { skip }, async () => {
  const { op, one, q } = await boot()
  const a = await op({ op: 'handover', note: '接著做' })
  const b = await op({ node: 'C', name: '小乙', op: 'info' })
  const old = await op({ name: '小武', op: 'info' })
  await q(`update relay.partner_ops set created_at = now() - interval '3 minutes' where id = $1`, [old.id])
  const got = (await one(`select public.irori_relay_partner_op_pending('H') r`)).r
  assert.deepEqual(got.map(x => x.id), [a.id], '只拿自己節點、沒逾時的')
  assert.deepEqual([got[0].op, got[0].note, got[0].name, got[0].requested_by, got[0].requested_by_label], ['handover', '接著做', '小文', 'P', '小良的手機'])
  assert.deepEqual((await q('select status, detail from relay.partner_ops where id = $1', [old.id]))[0], { status: 'failed', detail: 'expired' })
  assert.equal((await q('select status from relay.partner_ops where id = $1', [b.id]))[0].status, 'pending', '別台的沒被動')
  assert.deepEqual((await one(`select public.irori_relay_partner_op_pending('H') r`)).r, [], '不會重複拿')
  const res = (id, node, st, detail, result) => one('select public.irori_relay_partner_op_result($1,$2,$3,$4,$5::jsonb) r', [node, id, st, detail, result]).then(x => x.r)
  assert.equal((await res(a.id, 'C', 'ok', null, null)).error, 'not_found', '別台不能改')
  assert.equal((await res(b.id, 'C', 'ok', null, null)).error, 'not_found', '還沒 taken 不能回報')
  assert.equal((await res(a.id, 'H', 'taken', null, null)).error, 'bad_request')
  assert.equal((await res(a.id, 'H', 'ok', null, JSON.stringify({ x: '字'.repeat(1400) }))).error, 'bad_request', '超過 4KB')
  assert.equal((await res(a.id, 'H', 'ok', '完成', JSON.stringify({ pid: 7 }))).ok, true)
  assert.deepEqual((await q('select status, detail, result from relay.partner_ops where id = $1', [a.id]))[0], { status: 'ok', detail: '完成', result: { pid: 7 } })
  assert.equal((await res(a.id, 'H', 'failed', null, null)).error, 'not_found', '完成後不能再改')
})

test('實跑（pglite）：中途回報階段——只改自己節點、處理中那筆的 detail，只收固定格式，狀態不變', { skip }, async () => {
  const { op, one, q } = await boot()
  const a = await op({ op: 'handover' })
  const prog = (node, id, d) => one('select public.irori_relay_partner_op_progress($1,$2,$3) r', [node, id, d]).then(x => x.r)
  assert.equal((await prog('H', a.id, 'stage:handoff')).error, 'not_found', '還沒被取走（pending）不能回報階段')
  await one(`select public.irori_relay_partner_op_pending('H') r`)
  assert.equal((await prog('C', a.id, 'stage:handoff')).error, 'not_found', '別台不能改')
  for (const bad of ['請前任寫交接', 'stage:', 'stage:Handoff', "stage:x'; drop", null]) assert.equal((await prog('H', a.id, bad)).error, 'bad_request', String(bad))
  assert.equal((await prog('H', a.id, 'stage:closing')).ok, true)
  assert.deepEqual((await q('select status, detail from relay.partner_ops where id = $1', [a.id]))[0], { status: 'taken', detail: 'stage:closing' })
  await one('select public.irori_relay_partner_op_result($1,$2,$3,$4,$5::jsonb) r', ['H', a.id, 'ok', '完成', null])
  assert.equal((await prog('H', a.id, 'stage:opening')).error, 'not_found', '完成後不能再改')
})

test('實跑（pglite）：查進度——要簽章、只回自己租戶、逾時顯示失敗', { skip }, async () => {
  const { op, one, q, db } = await boot()
  const a = await op({ op: 'info' })
  await q(`insert into relay.partner_ops(tenant_id, requested_by, node, name, op) values ('${T2}','X','X','別人','info')`)
  const other = (await q(`select id from relay.partner_ops where tenant_id = '${T2}'`))[0].id
  const list = async (user, ids) => (await one('select public.irori_relay_partner_ops($1,$2,$3::uuid[]) r', ['P', user, ids])).r
  assert.equal((await list(null, [a.id])).error, 'forbidden')
  assert.equal((await list(U2, [a.id])).error, 'forbidden')
  const r = await list(U1, [a.id, other])
  assert.deepEqual(r.ops.map(o => [o.id, o.status]), [[a.id, 'pending']], '別租戶的不回')
  await q(`update relay.partner_ops set created_at = now() - interval '3 minutes' where id = $1`, [a.id])
  assert.deepEqual((await list(U1, [a.id])).ops.map(o => [o.status, o.detail]), [['failed', 'expired']])
  await db.close?.()
})
