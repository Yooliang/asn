// #468 migration 20261028210000_partner_op_resume_pi.sql：pi 夥伴也能喚醒。
// 1. 靜態：與正式庫現行定義（基準檔）比只差 engine 判斷那一行；不動權限、不動資料表。
// 2. 實跑（pglite；沒裝略過）：pi 有對話編號就收下並帶 session；沒有回 no_session；claude 照常；其他引擎照樣 not_claude；在線的照樣 already_online。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('../supabase/migrations/20261028210000_partner_op_resume_pi.sql')
const baseFn = read('./fixtures/asn_relay_partner_op.prod-20261028.sql')
const fnOf = s => s.slice(s.search(/create or replace function public\.asn_relay_partner_op/i), s.lastIndexOf('$function$') + '$function$'.length)

test('靜態：只差 resume 的引擎判斷一行（claude → claude 或 pi），其餘逐字相同；不動權限與資料表', () => {
  const now = fnOf(mig).split('\n')
  const was = baseFn.trim().split('\n')
  assert.equal(now.length, was.length)
  const diff = now.map((l, i) => [l, was[i]]).filter(([a, b]) => a !== b)
  assert.deepEqual(diff, [["    if v_engine is not null and v_engine not in ('claude', 'pi') then", "    if v_engine is not null and v_engine <> 'claude' then"]])
  const code = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /grant |revoke |alter table|drop /i)
  assert.match(code, /^begin;$/m); assert.match(code, /^commit;$/m)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SID = '0f9e8d7c-1111-4222-8333-444455556666'

test('實跑（pglite）：pi 帶對話編號收下；沒有編號 no_session；claude 照常；codex 照樣 not_claude；在線 already_online', { skip }, async () => {
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
    create function public.asn_relay_launch_name_ok(p_name text) returns boolean language sql immutable as
      $$ select public.irori_relay_launch_name_ok(p_name) $$;
    insert into relay.nodes(id, tenant_id, owner_user, name, launcher, bell_topic) values
      ('P','${T1}','${U1}','手機', null, 'bell-P'), ('H','${T1}','${U1}','家用機', '{"profiles":[{"id":"pi"}]}', 'bell-H');
    insert into relay.partners(partner_id, tenant_id, node, current_name, current_session, engine) values
      ('p_1','${T1}','H','Pi妹妹','${SID}','pi'), ('p_2','${T1}','H','沒編號','',null), ('p_3','${T1}','H','小文','aaaa-bbbb-cccc','claude'),
      ('p_4','${T1}','H','小乙','x','codex'), ('p_5','${T1}','H','在線pi','y','pi');
    update relay.partners set current_session = null, engine = 'pi' where partner_id = 'p_2';
    insert into relay.roster(node, name, engine) values ('H','在線pi','pi');`)
  for (const f of ['20261022120000_partner_ops.sql', '20261023100000_partner_ops_restart.sql', '20261028100000_partner_ops_remove.sql']) await db.exec(read(`../supabase/migrations/${f}`))
  await db.exec(mig)
  const op = async name => (await db.query('select public.asn_relay_partner_op($1,$2,$3,$4,$5,$6,$7,$8) r', ['P', U1, 'H', name, 'resume', null, null, null])).rows[0].r
  const r = await op('Pi妹妹')
  assert.ok(r.id, JSON.stringify(r))
  assert.equal((await db.query('select session_id from relay.partner_ops where id = $1', [r.id])).rows[0].session_id, SID)
  assert.equal((await op('沒編號')).error, 'no_session')
  assert.ok((await op('小文')).id, 'claude 照常')
  assert.equal((await op('小乙')).error, 'not_claude', '其他引擎照樣不開放')
  assert.equal((await op('在線pi')).error, 'already_online')
})
