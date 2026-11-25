// 換班接手進行中，本人按「關閉視窗」要能過後台那一關（#1908 M1）：20261125410000_partner_op_close_during_handover.sql
// 靜態：回復檔本體逐字＝上一版（20261123120000_online_window.sql）；新本體只多忙碌規則那一行；簽章與權限與上一版相同。
// 實跑（pglite，沒裝就略過）：換班進行中下 close 成功；其他動作照舊 busy；close 之後再 close 照舊 busy；用回復檔（舊本體）跑 close 會被擋，證明守門有效。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261125410000_partner_op_close_during_handover.sql'
const PREV = '20261123120000_online_window.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = p => rd(fs.readFileSync(new URL(p, import.meta.url), 'utf8'))
const mig = read(`../supabase/migrations/${F}`)
const down = read(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`)
const prev = read(`../supabase/migrations/${PREV}`)
const SIG = 'text, uuid, text, text, text, text, text, text'
// 取出 asn_relay_partner_op 的函式本體（create or replace … $function$;），小寫化後比對
const fnBody = sql => {
  const low = sql.toLowerCase()
  const s = low.indexOf('create or replace function public.asn_relay_partner_op(')
  assert.ok(s >= 0)
  const e = low.indexOf('$function$;', low.indexOf('$function$', s) + 5)
  return sql.slice(s, e + 11)
}

test('靜態：回復檔本體＝上一版；新本體和上一版只差忙碌規則那一行（和它的註解）；權限只給 service_role', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf(PREV))
  assert.equal(files.filter(f => f.startsWith('20261125410000_')).length, 1, '版本號沒撞')
  assert.equal(fnBody(down).toLowerCase(), fnBody(prev).toLowerCase(), '回復檔本體逐字等於上一版')
  const prevLines = fnBody(prev).toLowerCase().split('\n').map(l => l.trim())
  const diff = fnBody(mig).toLowerCase().split('\n').map(l => l.trim()).filter(l => !prevLines.includes(l))
  assert.equal(diff.filter(l => !l.trim().startsWith('--')).length, 1, '除了註解，只多一行')
  assert.match(diff.join('\n'), /and not \(p_op = 'close' and op = 'handover'\)/)
  for (const f of [mig, down]) {
    assert.ok(f.includes(`revoke all on function public.asn_relay_partner_op(${SIG}) from public, anon, authenticated;`))
    assert.ok(f.includes(`grant execute on function public.asn_relay_partner_op(${SIG}) to service_role;`))
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
    assert.doesNotMatch(f, /create table|drop table|alter table|create policy|truncate/i)
  }
  assert.match(fnBody(mig), /security definer/i)
  assert.equal(fnBody(mig).match(/set search_path to ''/i)?.length, 1)
})

let PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

async function boot(fn) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, launcher jsonb, bell_topic text, last_seen_at timestamptz default now());
    create table relay.partners(partner_id text primary key, tenant_id uuid, node text, current_name text, current_session text, engine text, updated_at timestamptz default now());
    create table relay.partner_names(partner_id text, name text, renamed_at timestamptz default now());
    create table relay.roster(node text, name text, engine text, seen_at timestamptz default now());
    create function relay.online_window() returns interval language sql immutable as $$ select interval '3 minutes' $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_relay_launch_name_ok(p_name text) returns boolean language sql immutable as
      $$ select p_name is not null and p_name ~ '^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$' $$;
    insert into relay.nodes(id, tenant_id, owner_user, name, launcher, bell_topic) values
      ('P','${T1}','${U1}','手機', null, 'bell-P'),
      ('H','${T1}','${U1}','家用機', '{"profiles":[{"id":"claude"}]}', 'bell-H');
    insert into relay.roster(node, name, engine) values ('H','小文','claude'), ('H','小武','claude');`)
  await db.exec(read('../supabase/migrations/20261022120000_partner_ops.sql'))
  await db.exec(read('../supabase/migrations/20261028100000_partner_ops_remove.sql'))
  await db.exec(fn)
  const q = async (t, a) => (await db.query(t, a)).rows
  const op = async (o = {}) => (await q('select public.asn_relay_partner_op($1,$2,$3,$4,$5,$6,$7,$8) r',
    ['P', U1, 'H', o.name ?? '小文', o.op ?? 'close', o.new_name ?? null, o.model ?? null, o.note ?? null]))[0].r
  return { op, q }
}

async function handoverAge(q, interval, status = 'taken') {
  await q('delete from relay.partner_ops')
  await q(`insert into relay.partner_ops(requested_by, node, name, op, status, created_at) values ('P','H','小文','handover',$1, now() - $2::interval)`, [status, interval])
}

test('實跑：換班進行中（pending／taken，1～19 分鐘）下 close 成功，建出一筆待辦', { skip }, async () => {
  const { op, q } = await boot(fnBody(mig) + '\n')
  for (const [status, age] of [['pending', '0 minutes'], ['taken', '1 minutes'], ['taken', '11 minutes'], ['taken', '19 minutes']]) {
    await handoverAge(q, age, status)
    const r = await op({ op: 'close' })
    assert.ok(r.id, `${status} ${age} 應放行：${JSON.stringify(r)}`)
    assert.equal(r.bell_topic, 'bell-H')
    const rows = await q(`select op, status from relay.partner_ops where id = $1`, [r.id])
    assert.deepEqual(rows[0], { op: 'close', status: 'pending' })
  }
})

test('實跑：換班進行中，其他動作照舊 busy；別的視窗不受影響；close 之後再 close 照舊 busy', { skip }, async () => {
  const { op, q } = await boot(fnBody(mig) + '\n')
  await handoverAge(q, '5 minutes')
  assert.equal((await op({ op: 'info' })).error, 'busy')
  assert.equal((await op({ op: 'handover' })).error, 'busy')
  assert.equal((await op({ op: 'model', model: 'opus' })).error, 'busy')
  assert.equal((await op({ op: 'rename', new_name: '新名字' })).error, 'busy')
  assert.equal((await op({ op: 'restart' })).error, 'busy')
  assert.equal((await op({ op: 'remove' })).error, 'busy')
  assert.ok((await op({ name: '小武', op: 'info' })).id, '別的視窗不受影響')
  assert.ok((await op({ op: 'close' })).id, 'close 放行')
  assert.equal((await op({ op: 'close' })).error, 'busy', '已經有一筆 close 在進行，再按照舊擋')
  assert.equal((await op({ op: 'info' })).error, 'busy')
  // 上一筆是別的動作：close 照舊被擋
  await q('delete from relay.partner_ops')
  await q(`insert into relay.partner_ops(requested_by, node, name, op, status) values ('P','H','小文','info','pending')`)
  assert.equal((await op({ op: 'close' })).error, 'busy', '上一筆不是換班，close 照舊 busy')
  await q('delete from relay.partner_ops')
  await q(`insert into relay.partner_ops(requested_by, node, name, op, status) values ('P','H','小文','model','taken')`)
  assert.equal((await op({ op: 'close' })).error, 'busy')
})

test('守門有效：用回復檔（舊本體）跑，換班進行中下 close 回 busy', { skip }, async () => {
  const { op, q } = await boot(fnBody(down) + '\n')
  await handoverAge(q, '5 minutes')
  assert.equal((await op({ op: 'close' })).error, 'busy')
})

closeAtEnd()
