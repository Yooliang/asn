// #2353 第③階段 PR-1 migration（20261126110000_launch_model.sql）：遠端開窗指定型號 model、pi 欄位改統一規則、開窗結果帶回 model_used。
// 實跑：pglite（CI 的 sql-tests 以 --require-pglite 跑；本機沒裝就略過）。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILE = '20261126110000_launch_model.sql'
const rd = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = rd(`../supabase/migrations/${FILE}`)
const down = rd(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`)
const piMig = rd('../supabase/migrations/20261028160000_launch_pi_model.sql')
const owMig = rd('../supabase/migrations/20261123120000_online_window.sql')
const modelsMig = rd('../supabase/migrations/20261126100000_launcher_models.sql')
const baseMig = rd('../supabase/migrations/20261020000200_relay_functions.sql')
const V = JSON.parse(rd('../relay/shared/test-vectors/model-id.json'))

const fnBody = (text, name, args) => {
  const m = new RegExp(`create or replace function ${name.replace('.', '\\.')}\\(${args}.*?\\$function\\$;`, 'is').exec(text)
  assert.ok(m, name)
  return m[0]
}
const bodyOf = s => s.slice(s.indexOf('AS $function$')) // 只比本體（首行的大小寫寫法不同）

test('靜態：新函式只給 service_role、不刪資料、含向量的 pattern 不重寫（用 relay.valid_model_id）', () => {
  assert.match(sql, /revoke all on function public\.asn_relay_launch\(text, text, text, text, text, text, uuid, text, text, text\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_relay_launch\(text, text, text, text, text, text, uuid, text, text, text\) to service_role;/)
  assert.match(sql, /grant execute on function public\.asn_relay_launch_result\(text, uuid, text, text, text\) to service_role;/)
  assert.doesNotMatch(sql, /delete from|truncate|drop column|drop function/i)
  assert.ok(!sql.includes(V.pattern), '字元集規則只放在 relay.valid_model_id 一處')
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.match(down, /^begin;$/m); assert.match(down, /^commit;$/m)
})

test('靜態：down 的 9 參數版與 launchers 與上一版本體逐字相同；launch_pending 與 20261028160000 相同', () => {
  const a9 = 'p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text\\)'
  assert.equal(bodyOf(fnBody(down, 'public.asn_relay_launch', a9)), bodyOf(fnBody(owMig, 'public.asn_relay_launch', a9)))
  assert.equal(bodyOf(fnBody(down, 'public.asn_relay_launchers', 'p_actor')), bodyOf(fnBody(owMig, 'public.asn_relay_launchers', 'p_actor')))
  assert.equal(bodyOf(fnBody(down, 'public.asn_relay_launch_pending', 'p_node')), bodyOf(fnBody(piMig, 'public.asn_relay_launch_pending', 'p_node')))
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false
  : '沒有安裝 @electric-sql/pglite'

async function setup({ apply = true } = {}) {
  const db = track(new PGlite())
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', role text default 'member', tenant_id uuid, launcher jsonb, bell_topic text,
      name text, machine text, launcher_at timestamptz, platform text, launch_closed_reason text, last_seen_at timestamptz);
    create table relay.roster(node text, name text, seen_at timestamptz);
    create table relay.launches(id uuid primary key default gen_random_uuid(), requested_by text, node text, profile text, name text, cwd text, first_message text,
      tenant_id uuid, status text default 'pending', detail text, created_at timestamptz default now(), taken_at timestamptz, done_at timestamptz);
    create function relay.online_window() returns interval language sql as $$select interval '3 minutes'$$;
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as 'select false';
    create function public.asn_relay_launch_name_ok(n text) returns boolean language sql as $$select n ~ '^[A-Za-z0-9-]+$'$$;
    insert into relay.nodes(id, role) values ('P', 'owner');
    insert into relay.nodes(id, launcher, bell_topic) values
      ('W', '{"profiles":[{"id":"claude"},{"id":"pi"}],"cwd_allow":["C:/x"],"models":[]}', 't-W'),
      ('OLD', '{"profiles":[{"id":"claude"},{"id":"pi"}],"cwd_allow":["C:/x"]}', 't-OLD');`)
  await db.exec(fnBody(modelsMig, 'relay.valid_model_id', 'p_id text\\)'))
  await db.exec(piMig) // 舊的 9 參數版、窄規則的約束、舊的取件
  await db.exec(baseMig.match(/CREATE OR REPLACE FUNCTION public\.irori_relay_launch_result.*?\$function\$;/is)[0].replace('irori_relay_launch_result', 'asn_relay_launch_result'))
  // 7 參數版（原樣取自 20261123120000）
  await db.exec(fnBody(owMig, 'public.asn_relay_launch', 'p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid DEFAULT NULL::uuid\\)'))
  await db.exec(fnBody(owMig, 'public.asn_relay_launchers', 'p_actor'))
  if (apply) await db.exec(sql)
  const q = async (s, a = []) => (await db.query(s, a)).rows
  const launch = async (name, { node = 'W', profile = 'claude', pp = null, pm = null, model = null } = {}) =>
    (await q('select public.asn_relay_launch($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) r', ['P', node, profile, name, 'C:/x', null, null, pp, pm, model]))[0].r
  return { db, q, launch }
}

test('實跑：model 格式逐筆照共用向量；合格存進表、取件時回 model', { skip }, async () => {
  const { q, launch } = await setup()
  let i = 0
  for (const s of V.valid) {
    const r = await launch(`v${i++}`, { model: s })
    assert.ok(r.id, JSON.stringify(s))
    await q("update relay.launches set status = 'ok', done_at = now() - interval '1 hour' where id = $1", [r.id]) // 不被重名、每小時上限擋住
    await q("update relay.launches set created_at = now() - interval '2 hours' where id = $1", [r.id])
  }
  for (const s of V.invalid) assert.deepEqual(await launch('bad', { model: s }), { error: 'bad_model' }, JSON.stringify(s))
  assert.deepEqual(await launch('empty', { model: '' }), { error: 'bad_model' })
  assert.equal((await q('select count(*)::int c from relay.launches where model is not null'))[0].c, V.valid.length)
  const r = await launch('last', { model: 'opus[1m]' })
  assert.ok(r.id)
  const got = (await q("select public.asn_relay_launch_pending('W') r"))[0].r
  assert.equal(got.find(g => g.name === 'last').model, 'opus[1m]')
})

test('實跑：model 與 pi 欄位並存回 bad_model；pi 不合格仍回 bad_pi_model', { skip }, async () => {
  const { launch } = await setup()
  assert.deepEqual(await launch('a1', { profile: 'pi', model: 'opus', pp: 'a', pm: 'b' }), { error: 'bad_model' })
  assert.deepEqual(await launch('a2', { profile: 'pi', model: 'opus', pp: 'a' }), { error: 'bad_model' })
  assert.deepEqual(await launch('a3', { profile: 'pi', model: 'opus', pm: 'b' }), { error: 'bad_model' })
  for (const [pp, pm] of [['minimax', null], [null, 'x'], ['-x', 'y'], ['a b', 'y'], ['a', 'a//b'], ['a', 'x'.repeat(101)]]) {
    assert.deepEqual(await launch('a4', { profile: 'pi', pp, pm }), { error: 'bad_pi_model' }, JSON.stringify([pp, pm]))
  }
})

test('實跑：目標電腦的 launcher 沒有 models 陣列 → model_unsupported；沒帶 model 照常開', { skip }, async () => {
  const { launch, q } = await setup()
  assert.deepEqual(await launch('b1', { node: 'OLD', model: 'opus' }), { error: 'model_unsupported' })
  assert.ok((await launch('b2', { node: 'OLD' })).id, '不帶 model：舊電腦照常開')
  await q(`update relay.nodes set launcher = jsonb_set(launcher, '{models}', '"x"') where id = 'OLD'`)
  assert.deepEqual(await launch('b3', { node: 'OLD', model: 'opus' }), { error: 'model_unsupported' }, 'models 不是陣列也算不支援')
  assert.deepEqual(await launch('b4', { node: 'OLD', model: 'bad id' }), { error: 'bad_model' }, '格式錯誤先於 model_unsupported')
})

test('實跑：pi 帶 / 與 : 現在會過（9 參數版與 10 參數版）；存進表、取件原樣回', { skip }, async () => {
  const { launch, q } = await setup()
  const a = await launch('c1', { profile: 'pi', pp: 'openrouter', pm: 'meta/llama-3' })
  assert.ok(a.id)
  const b = (await q('select public.asn_relay_launch($1, $2, $3, $4, $5, $6, $7, $8, $9) r', ['P', 'W', 'pi', 'c2', 'C:/x', null, null, 'a', 'y:z']))[0].r
  assert.ok(b.id, '9 參數版（薄包裝）同一份規則')
  const bad = (await q('select public.asn_relay_launch($1, $2, $3, $4, $5, $6, $7, $8, $9) r', ['P', 'W', 'pi', 'c3', 'C:/x', null, null, 'a', 'a//b']))[0].r
  assert.deepEqual(bad, { error: 'bad_pi_model' })
  const got = (await q("select public.asn_relay_launch_pending('W') r"))[0].r
  assert.deepEqual(got.map(g => [g.name, g.pi_provider, g.pi_model, g.model]), [['c1', 'openrouter', 'meta/llama-3', null], ['c2', 'a', 'y:z', null]])
})

test('實跑：7 參數版不動、不帶 model 的取件 model 為 null、其餘輸出鍵與以前相同', { skip }, async () => {
  const { q } = await setup()
  const r = (await q('select public.asn_relay_launch($1, $2, $3, $4, $5, $6, $7) r', ['P', 'W', 'claude', 'd1', 'C:/x', 'hi', null]))[0].r
  assert.deepEqual(Object.keys(r).sort(), ['bell_topic', 'id'])
  const got = (await q("select public.asn_relay_launch_pending('W') r"))[0].r
  assert.deepEqual(Object.keys(got[0]).sort(), ['created_at', 'cwd', 'first_message', 'id', 'model', 'name', 'pi_model', 'pi_provider', 'profile', 'requested_by'])
  assert.equal(got[0].model, null)
  assert.equal(got[0].first_message, 'hi')
})

test('實跑：約束本身會擋（直接 insert 不合格的值、model 與 pi 並存）', { skip }, async () => {
  const { db } = await setup()
  await assert.rejects(db.query("insert into relay.launches(node, model) values ('W', 'a b')"), /launches_model_check/)
  await assert.rejects(db.query("insert into relay.launches(node, model) values ('W', 'a//b')"), /launches_model_check/)
  await assert.rejects(db.query("insert into relay.launches(node, model, pi_provider, pi_model) values ('W', 'opus', 'a', 'b')"), /launches_model_pi_excl_check/)
  await assert.rejects(db.query("insert into relay.launches(node, model_used) values ('W', '-x')"), /launches_model_used_check/)
  await assert.rejects(db.query("insert into relay.launches(node, pi_provider) values ('W', 'a')"), /launches_pi_model_check/)
  await assert.rejects(db.query("insert into relay.launches(node, pi_provider, pi_model) values ('W', 'a', 'a//b')"), /launches_pi_model_check/)
  await db.query("insert into relay.launches(node, pi_provider, pi_model, model_used) values ('W', 'openrouter/x', 'y:z', 'opus[1m]')")
})

test('實跑：model_used（D8）：5 參數版收、存、由 launchers 讀出；不合格就不存但結果照收；4 參數版不動', { skip }, async () => {
  const { q, launch } = await setup()
  const ids = []
  for (const n of ['e1', 'e2', 'e3', 'e4']) ids.push((await launch(n, { model: n === 'e4' ? null : 'opus' })).id)
  await q("select public.asn_relay_launch_pending('W')")
  const res = async (id, status, mu) => (await q('select public.asn_relay_launch_result($1, $2::uuid, $3, $4, $5) r', ['W', id, status, 'd', mu]))[0].r
  assert.deepEqual(await res(ids[0], 'ok', 'claude-opus-5-5'), { ok: true })
  assert.deepEqual(await res(ids[1], 'ok', 'bad id'), { ok: true }, '不合格：結果照收')
  assert.deepEqual(await res(ids[2], 'failed', null), { ok: true })
  // 舊電腦：4 參數版
  assert.deepEqual((await q('select public.asn_relay_launch_result($1, $2::uuid, $3, $4) r', ['W', ids[3], 'ok', 'd']))[0].r, { ok: true })
  assert.deepEqual(await res(ids[0], 'ok', 'x'), { error: 'not_found' }, '已結案的不能再改')
  const rows = (await q('select name, status, model, model_used from relay.launches order by name'))
  assert.deepEqual(rows.map(r => [r.name, r.status, r.model, r.model_used]), [
    ['e1', 'ok', 'opus', 'claude-opus-5-5'], ['e2', 'ok', 'opus', null], ['e3', 'failed', 'opus', null], ['e4', 'ok', null, null]])
  const lst = (await q("select public.asn_relay_launchers('P', null) r"))[0].r.launches
  const e1 = lst.find(l => l.name === 'e1')
  assert.equal(e1.model, 'opus'); assert.equal(e1.model_used, 'claude-opus-5-5')
  assert.equal(lst.find(l => l.name === 'e4').model_used, null)
})

test('實跑：unconfirmed 後再回報 ok，沒帶 model_used 不會把先前存的值洗掉', { skip }, async () => {
  const { q, launch } = await setup()
  const id = (await launch('f1', { model: 'opus' })).id
  await q("select public.asn_relay_launch_pending('W')")
  await q("select public.asn_relay_launch_result('W', $1::uuid, 'unconfirmed', 'x', 'opus')", [id])
  await q("select public.asn_relay_launch_result('W', $1::uuid, 'ok', 'y', null)", [id])
  assert.equal((await q('select model_used from relay.launches where id = $1', [id]))[0].model_used, 'opus')
})

test('實跑：down 還原到舊行為（窄規則、沒有 model 欄位與新函式），已存的 pi 值不擋退回', { skip }, async () => {
  const { db, q, launch } = await setup()
  assert.ok((await launch('g1', { profile: 'pi', pp: 'openrouter', pm: 'meta/llama-3' })).id)
  await db.exec(down)
  const cols = (await q("select column_name from information_schema.columns where table_schema = 'relay' and table_name = 'launches' and column_name in ('model', 'model_used')"))
  assert.equal(cols.length, 0)
  const fns = (await q("select pronargs::int n, proname from pg_proc where proname in ('asn_relay_launch', 'asn_relay_launch_result') order by proname, pronargs")).map(r => `${r.proname}/${r.n}`)
  assert.deepEqual(fns, ['asn_relay_launch/7', 'asn_relay_launch/9', 'asn_relay_launch_result/4'])
  const r = (await q('select public.asn_relay_launch($1, $2, $3, $4, $5, $6, $7, $8, $9) r', ['P', 'W', 'pi', 'g2', 'C:/x', null, null, 'a', 'y:z']))[0].r
  assert.deepEqual(r, { error: 'bad_pi_model' }, '退回後 9 參數版又是窄規則')
  const got = (await q("select public.asn_relay_launch_pending('W') r"))[0].r // 在途的寬規則 pi 列仍能更新狀態
  assert.equal(got.length, 1)
  assert.equal(got[0].pi_model, 'meta/llama-3')
  assert.equal('model' in got[0], false)
  const l = (await q("select public.asn_relay_launchers('P', null) r"))[0].r.launches[0]
  assert.equal('model_used' in l, false)
})

closeAtEnd()
