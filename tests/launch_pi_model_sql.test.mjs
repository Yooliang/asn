// 0.2 D2（#422）migration（20261028160000_launch_pi_model.sql）：開窗表多存經 pi 的提供者與模型。
// 實跑：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261028160000_launch_pi_model.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：舊的 7 參數版本不動、新版本只給 service_role、只加欄位不刪東西', () => {
  assert.match(sql, /create or replace function public\.asn_relay_launch\(p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text\)/)
  assert.doesNotMatch(sql, /drop function|drop column|delete from|truncate/i)
  assert.match(sql, /revoke all on function public\.asn_relay_launch\(text, text, text, text, text, text, uuid, text, text\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_relay_launch\(text, text, text, text, text, text, uuid, text, text\) to service_role;/)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

test('實跑（pglite）：9 參數版本存提供者與模型、要一起給、格式不對回 bad_pi_model；表上的限制擋單邊值；取走時一起回', { skip }, async () => {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', role text default 'member', tenant_id uuid, launcher jsonb, bell_topic text);
    create table relay.roster(node text, name text, seen_at timestamptz);
    create table relay.launches(id uuid primary key default gen_random_uuid(), requested_by text, node text, profile text, name text, cwd text, first_message text,
      tenant_id uuid, status text default 'pending', detail text, created_at timestamptz default now(), taken_at timestamptz, done_at timestamptz);
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as 'select false';
    create function public.asn_relay_launch_name_ok(n text) returns boolean language sql as $$select n ~ '^[A-Za-z0-9-]+$'$$;
    insert into relay.nodes(id, role) values ('P', 'owner');
    insert into relay.nodes(id, launcher, bell_topic) values ('W', '{"profiles":[{"id":"pi"}],"cwd_allow":["C:/x"]}', 't-W');`)
  await db.exec(sql)
  const launch = async (name, pp, pm) => (await db.query('select public.asn_relay_launch($1, $2, $3, $4, $5, $6, $7, $8, $9) r', ['P', 'W', 'pi', name, 'C:/x', null, null, pp, pm])).rows[0].r
  const ok = await launch('a1', 'minimax', 'MiniMax-M3.1-Flash')
  assert.equal(ok.bell_topic, 't-W')
  assert.ok(ok.id)
  assert.ok((await launch('a2', null, null)).id, '兩個都不給：照常開')
  for (const [pp, pm] of [['minimax', null], [null, 'x'], ['-x', 'y'], ['a b', 'y'], ['a', 'y:z'], ['a', 'x'.repeat(51)]]) {
    assert.deepEqual(await launch('a3', pp, pm), { error: 'bad_pi_model' }, JSON.stringify([pp, pm]))
  }
  await assert.rejects(db.query("insert into relay.launches(node, pi_provider) values ('W', 'minimax')"), /launches_pi_model_check/)
  await assert.rejects(db.query("insert into relay.launches(node, pi_provider, pi_model) values ('W', 'a', 'y;z')"), /launches_pi_model_check/)
  const got = (await db.query("select public.asn_relay_launch_pending('W') r")).rows[0].r
  assert.equal(got.length, 2)
  assert.deepEqual(got.map(g => [g.name, g.pi_provider, g.pi_model]), [['a1', 'minimax', 'MiniMax-M3.1-Flash'], ['a2', null, null]])
  assert.deepEqual((await db.query("select public.asn_relay_launch_pending('W') r")).rows[0].r, [], '取走一次就沒了')
})
