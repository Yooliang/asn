// #2353 第③階段 PR-1 migration（20261126110000_launch_model.sql）：遠端開窗指定型號 model、pi 欄位改統一規則、開窗結果帶回 model_used、
// 目標電腦的能力旗標 launch_model。
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
const modelsDown = rd('../supabase/sql/rollback/20261126100000_launcher_models_down.sql')
const prevLauncherMig = rd('../supabase/migrations/20261028140000_launcher_pi_models.sql')
const baseMig = rd('../supabase/migrations/20261020000200_relay_functions.sql')
const V = JSON.parse(rd('../relay/shared/test-vectors/model-id.json'))

const fnBody = (text, name, args) => {
  const m = new RegExp(`create or replace function ${name.replace('.', '\\.')}\\(${args}.*?\\$function\\$;`, 'is').exec(text)
  assert.ok(m, name)
  return m[0]
}
const bodyOf = s => s.slice(s.indexOf('AS $function$')) // 只比本體（首行的大小寫寫法不同）
const SEG = String.raw`(^|/)\.{0,2}(/|$)` // 分段檢查的正規式（與 relay.valid_model_id 內相同）

test('靜態：新函式只給 service_role、不刪資料、含向量的 pattern 不重寫（用 relay.valid_model_id）', () => {
  assert.match(sql, /revoke all on function public\.asn_relay_launch\(text, text, text, text, text, text, uuid, text, text, text\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_relay_launch\(text, text, text, text, text, text, uuid, text, text, text\) to service_role;/)
  assert.match(sql, /grant execute on function public\.asn_relay_launch_result\(text, uuid, text, text, text\) to service_role;/)
  assert.doesNotMatch(sql, /delete from|truncate|drop column|drop function/i)
  assert.ok(!sql.includes(V.pattern), '字元集規則只放在 relay.valid_model_id 一處')
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.match(down, /^begin;$/m); assert.match(down, /^commit;$/m)
})

test('靜態：model_unsupported 看能力旗標 launch_model，不再看 models 陣列；set_launcher 收這個鍵', () => {
  assert.match(sql, /v_l->'launch_model'\) is distinct from 'true'::jsonb/)
  assert.doesNotMatch(sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n'), /jsonb_typeof\(v_l->'models'\)/)
  assert.match(sql, /jsonb_typeof\(p_launcher->'launch_model'\) = 'boolean'/)
})

test('靜態：down 的 9 參數版與 launchers 與上一版本體逐字相同；launch_pending 與 20261028160000 相同；set_launcher 與 20261126100000 相同', () => {
  const a9 = 'p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text\\)'
  assert.equal(bodyOf(fnBody(down, 'public.asn_relay_launch', a9)), bodyOf(fnBody(owMig, 'public.asn_relay_launch', a9)))
  assert.equal(bodyOf(fnBody(down, 'public.asn_relay_launchers', 'p_actor')), bodyOf(fnBody(owMig, 'public.asn_relay_launchers', 'p_actor')))
  assert.equal(bodyOf(fnBody(down, 'public.asn_relay_launch_pending', 'p_node')), bodyOf(fnBody(piMig, 'public.asn_relay_launch_pending', 'p_node')))
  assert.equal(bodyOf(fnBody(down, 'public.asn_relay_set_launcher', 'p_node text')), bodyOf(fnBody(modelsMig, 'public.asn_relay_set_launcher', 'p_node text')))
})

test('靜態：down 保留的 pi 約束內嵌等價正規式，不依賴 relay.valid_model_id；兩條正規式與函式本體、共用向量逐字相同', () => {
  const codeOf = t => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  const dcode = codeOf(down)
  const piBlock = dcode.slice(dcode.indexOf('add constraint launches_pi_model_check'), dcode.indexOf(';', dcode.indexOf('add constraint launches_pi_model_check')))
  assert.ok(piBlock.length > 50)
  assert.doesNotMatch(piBlock, /valid_model_id/)
  assert.equal(piBlock.split(V.pattern).length - 1, 2, '字元集正規式：provider、model 各一次')
  assert.equal(piBlock.split(SEG).length - 1, 2, '分段檢查正規式：provider、model 各一次')
  const fn = fnBody(modelsMig, 'relay.valid_model_id', 'p_id text\\)')
  assert.ok(fn.includes(V.pattern) && fn.includes(SEG), 'valid_model_id 本體與內嵌用同樣兩條正規式')
  // 回退檔裡仍引用這支函式的只有「換回 20261126100000 版的 set_launcher」本體（函式本體不產生相依，下一步的回退會把它換掉）
  const outsideBodies = dcode.replace(/\$function\$[\s\S]*?\$function\$/g, 'BODY')
  assert.doesNotMatch(outsideBodies, /valid_model_id/, '回退檔的約束與其他敘述不引用這支函式（20261126100000 的回退會 drop 它）')
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false
  : '沒有安裝 @electric-sql/pglite'

// 共同的舊狀態（還沒有第②③階段）：舊約束、舊函式
async function oldState(db) {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', role text default 'member', tenant_id uuid, launcher jsonb, bell_topic text,
      name text, machine text, launcher_at timestamptz, platform text, launch_closed_reason text, last_seen_at timestamptz,
      can_invite boolean default false, can_roster boolean default true);
    create table relay.roster(node text, name text, seen_at timestamptz);
    create table relay.launches(id uuid primary key default gen_random_uuid(), requested_by text, node text, profile text, name text, cwd text, first_message text,
      tenant_id uuid, status text default 'pending', detail text, created_at timestamptz default now(), taken_at timestamptz, done_at timestamptz);
    create function relay.online_window() returns interval language sql as $$select interval '3 minutes'$$;
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as 'select false';
    create function public.asn_relay_launch_name_ok(n text) returns boolean language sql as $$select n ~ '^[A-Za-z0-9-]+$'$$;`)
  await db.exec(piMig) // 舊的 9 參數版、窄規則的約束、舊的取件
  await db.exec(baseMig.match(/CREATE OR REPLACE FUNCTION public\.irori_relay_launch_result.*?\$function\$;/is)[0].replace('irori_relay_launch_result', 'asn_relay_launch_result'))
  // 7 參數版（原樣取自 20261123120000）
  await db.exec(fnBody(owMig, 'public.asn_relay_launch', 'p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid DEFAULT NULL::uuid\\)'))
  // 9 參數版：正式庫現行的版本（20261123120000，在線門檻用 relay.online_window()）
  await db.exec(fnBody(owMig, 'public.asn_relay_launch', 'p_actor text, p_node text, p_profile text, p_name text, p_cwd text, p_first text, p_signed_user uuid, p_pi_provider text, p_pi_model text\\)'))
  await db.exec(fnBody(owMig, 'public.asn_relay_launchers', 'p_actor'))
}

const LAUNCHER = '{"profiles":[{"id":"claude"},{"id":"pi"}],"cwd_allow":["C:/x"]'

async function setup({ apply = true } = {}) {
  const db = track(new PGlite())
  await oldState(db)
  await db.exec(`insert into relay.nodes(id, role) values ('P', 'owner'), ('M', 'member');
    insert into relay.nodes(id, launcher, bell_topic) values
      ('W', '${LAUNCHER},"models":[],"launch_model":true,"max_per_hour":100}', 't-W'),
      ('R', '${LAUNCHER},"launch_model":true,"max_per_hour":2}', 't-R'),
      ('OLD', '${LAUNCHER},"models":[{"vendor":"claude","status":"ok","models":[]}]}', 't-OLD'),
      ('OFF', '${LAUNCHER},"launch_model":false}', 't-OFF'),
      ('STR', '${LAUNCHER},"launch_model":"true"}', 't-STR'),
      ('S', '${LAUNCHER}}', 't-S'),
      ('NL', null, 't-NL');`)
  await db.exec(fnBody(modelsMig, 'relay.valid_model_id', 'p_id text\\)'))
  await db.exec(fnBody(modelsMig, 'relay.sanitize_launcher_models', 'p_models jsonb\\)'))
  if (apply) await db.exec(sql)
  const q = async (s, a = []) => (await db.query(s, a)).rows
  const launch = async (name, { actor = 'P', node = 'W', profile = 'claude', cwd = 'C:/x', first = null, pp = null, pm = null, model = null } = {}) =>
    (await q('select public.asn_relay_launch($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) r', [actor, node, profile, name, cwd, first, null, pp, pm, model]))[0].r
  return { db, q, launch }
}

test('實跑：model 格式逐筆照共用向量；合格存進表、取件時回 model', { skip }, async () => {
  const { q, launch } = await setup()
  let i = 0
  for (const s of V.valid) {
    const r = await launch(`v${i++}`, { model: s })
    assert.ok(r.id, JSON.stringify(s))
  }
  for (const s of V.invalid) assert.deepEqual(await launch('bad', { model: s }), { error: 'bad_model' }, JSON.stringify(s))
  assert.deepEqual(await launch('empty', { model: '' }), { error: 'bad_model' })
  assert.equal((await q('select count(*)::int c from relay.launches where model is not null'))[0].c, V.valid.length)
  const r = await launch('last', { model: 'opus[1m]' })
  assert.ok(r.id)
  const got = (await q("select public.asn_relay_launch_pending('W') r"))[0].r
  assert.equal(got.find(g => g.name === 'last').model, 'opus[1m]')
})

test('實跑：10 參數版的每個錯誤碼各一條（forbidden、not_found、no_launcher、bad_name、bad_profile、bad_cwd、bad_first_message、bad_model、bad_pi_model、model_unsupported、name_taken、rate_limited）', { skip }, async () => {
  const { q, launch } = await setup()
  const rows = async () => (await q('select count(*)::int c from relay.launches'))[0].c
  const err = async (want, name, o) => {
    const before = await rows()
    assert.deepEqual(await launch(name, o), { error: want }, want)
    assert.equal(await rows(), before, `${want}：不寫入任何一列`)
  }
  await err('forbidden', 'e1', { actor: 'Z' })           // 沒有這個節點
  await err('forbidden', 'e1', { actor: 'M', model: 'opus' }) // 不是 owner、也不是擁有者的節點
  await err('not_found', 'e2', { node: 'NOPE', model: 'opus' })
  await err('no_launcher', 'e3', { node: 'NL', model: 'opus' })
  await err('bad_name', 'e 4', { model: 'opus' })
  await err('bad_profile', 'e5', { profile: 'zzz', model: 'opus' })
  await err('bad_cwd', 'e6', { cwd: 'D:/y', model: 'opus' })
  await err('bad_first_message', 'e7', { first: 'x'.repeat(4001), model: 'opus' })
  await err('bad_model', 'e8', { model: 'bad id' })
  await err('bad_model', 'e8', { profile: 'pi', model: 'opus', pp: 'a', pm: 'b' })   // 與 pi 並存
  await err('bad_pi_model', 'e9', { profile: 'pi', pp: 'a' })
  await err('bad_pi_model', 'e9', { profile: 'pi', pp: 'a', pm: 'a//b' })
  await err('model_unsupported', 'e10', { node: 'OLD', model: 'opus' })
  // name_taken：同名（不分大小寫）還在開窗中；名字被名冊上在線的佔住
  const first = await launch('dup', { model: 'opus' })
  assert.ok(first.id)
  await err('name_taken', 'DUP', { model: 'opus' })
  await q("insert into relay.roster(node, name, seen_at) values ('W', 'on-roster', now())")
  await err('name_taken', 'on-roster', { model: 'opus' })
  // rate_limited：R 每小時最多 2 次，照實開滿再開第 3 次（不改 created_at）
  assert.ok((await launch('r1', { node: 'R', model: 'opus' })).id)
  assert.ok((await launch('r2', { node: 'R', model: 'opus' })).id)
  await err('rate_limited', 'r3', { node: 'R', model: 'opus' })
  assert.ok((await launch('ok1', { first: 'x'.repeat(4000), model: 'opus' })).id, '4000 字剛好可以')
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

test('實跑：model_unsupported 只看目標電腦 launcher 的 launch_model 是不是 true；有 models 陣列也不算', { skip }, async () => {
  const { launch, q } = await setup()
  assert.deepEqual(await launch('b1', { node: 'OLD', model: 'opus' }), { error: 'model_unsupported' }, '有 models 陣列、沒有旗標')
  assert.deepEqual(await launch('b2', { node: 'OFF', model: 'opus' }), { error: 'model_unsupported' }, '旗標為 false')
  assert.deepEqual(await launch('b3', { node: 'STR', model: 'opus' }), { error: 'model_unsupported' }, '旗標不是布林值')
  assert.deepEqual(await launch('b4', { node: 'S', model: 'opus' }), { error: 'model_unsupported' }, '完全沒有 models 也沒有旗標')
  assert.ok((await launch('b5', { node: 'OLD' })).id, '不帶 model：舊電腦照常開')
  assert.ok((await launch('b6', { node: 'OFF' })).id, '不帶 model：旗標 false 也照常開')
  assert.ok((await launch('b7', { node: 'W', model: 'opus' })).id, 'W 的 models 是空陣列，但旗標為 true：可以')
  await q(`update relay.nodes set launcher = launcher - 'models' where id = 'W'`)
  assert.ok((await launch('b8', { node: 'W', model: 'opus' })).id, 'models 被丟掉（超量）的電腦只要有旗標就不會被誤判')
  assert.deepEqual(await launch('b9', { node: 'OLD', model: 'bad id' }), { error: 'bad_model' }, '格式錯誤先於 model_unsupported')
})

test('實跑：set_launcher 收 launch_model（只收布林值），其餘輸出與 20261126100000 的版本相同', { skip }, async () => {
  const { q, launch } = await setup()
  const base = { profiles: [{ id: 'claude', label: 'Claude' }], cwd_allow: ['C:/x'] }
  const set = async l => (await q('select public.asn_relay_set_launcher($1, $2::jsonb) r', ['S', l === null ? null : JSON.stringify(l)]))[0].r
  const get = async () => (await q("select launcher from relay.nodes where id = 'S'"))[0].launcher
  assert.deepEqual(await set({ ...base, launch_model: true }), { ok: true })
  assert.equal((await get()).launch_model, true)
  assert.ok((await launch('s1', { node: 'S', model: 'opus' })).id, '旗標進了摘要之後可以指定型號')
  await set({ ...base, launch_model: false })
  assert.equal((await get()).launch_model, false)
  assert.deepEqual(await launch('s2', { node: 'S', model: 'opus' }), { error: 'model_unsupported' })
  for (const v of ['true', 1, 0, null, {}, [], 'yes']) {
    await set({ ...base, launch_model: v })
    assert.equal('launch_model' in (await get()), false, JSON.stringify(v))
  }
  await set(base)
  assert.equal('launch_model' in (await get()), false, '沒給就沒有')

  // 其餘輸出與 20261126100000 的版本逐筆相同；有旗標時只多這一個鍵
  const corpus = [
    base, null, { profiles: 'x', cwd_allow: [] }, { ...base, max_per_hour: 99 },
    { ...base, pi_models: [{ provider: 'a', model: 'b/c' }, { provider: '-x', model: 'y' }] },
    { ...base, models: [{ vendor: 'claude', status: 'ok', models: [{ id: 'opus', name: 'Opus' }] }] },
    { ...base, models: 'x' },
  ]
  const run = async (withFlag) => {
    const out = []
    for (const c of corpus) {
      const l = withFlag && c ? { ...c, launch_model: true } : c
      const r = await set(l)
      out.push([r, (await get())])
    }
    return out
  }
  const withNew = await run(false)
  const flagged = await run(true)
  await q(fnBody(modelsMig, 'public.asn_relay_set_launcher', 'p_node text'))
  const withOld = await run(false)
  assert.deepEqual(withNew, withOld, '沒有旗標時與上一版相同')
  const oldFlagged = await run(true)
  assert.deepEqual(oldFlagged, withOld, '上一版會把旗標丟掉（對照）')
  flagged.forEach(([r, l], i) => {
    if (corpus[i] && r.ok) assert.deepEqual({ ...l, launch_model: undefined }, { ...withOld[i][1], launch_model: undefined }, `corpus ${i}`)
    if (corpus[i] && r.ok) assert.equal(l.launch_model, true)
  })
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
  await q("select public.asn_relay_set_launcher('S', $1::jsonb)", [JSON.stringify({ profiles: [{ id: 'claude' }], cwd_allow: ['C:/x'], launch_model: true })])
  assert.equal('launch_model' in (await q("select launcher from relay.nodes where id = 'S'"))[0].launcher, false, '退回後 set_launcher 不再收旗標')
})

// ---- 回退鏈：兩階段的回退依序跑完、單獨回退 110000 後可重新套用 ----

// 資料庫狀態快照：所有函式（含權限）、launches 的約束與欄位
async function snap(db) {
  const q = async s => (await db.query(s)).rows
  return {
    fns: await q(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def, p.proacl::text acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'relay') order by 1`),
    cons: await q(`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid = 'relay.launches'::regclass order by 1`),
    cols: await q(`select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'relay' and table_name = 'launches' order by ordinal_position`),
  }
}
const without = (rows, key, name) => rows.filter(r => r[key] !== name)
async function chain() {
  const db = track(new PGlite())
  await oldState(db)
  await db.exec(prevLauncherMig) // 舊的 asn_relay_set_launcher（20261028140000）
  return db
}

test('實跑：回退鏈——依序套 100000、110000，再依序跑 110000_down、100000_down，兩支都順利跑完，狀態與套用前一致', { skip }, async () => {
  const db = await chain()
  const s0 = await snap(db)
  await db.exec(modelsMig)
  const s1 = await snap(db)
  await db.exec(sql)
  const s2 = await snap(db)
  assert.notDeepEqual(s2.fns, s1.fns)
  await db.exec(down)
  const s3 = await snap(db)
  // 回到只套 100000 的狀態：函式、欄位與約束逐項相同；唯一的差別是 pi 約束依規則保留成內嵌的寬規則
  assert.deepEqual(s3.fns, s1.fns, '110000_down 之後函式與只套 100000 時相同')
  assert.deepEqual(s3.cols, s1.cols)
  assert.deepEqual(without(s3.cons, 'conname', 'launches_pi_model_check'), without(s1.cons, 'conname', 'launches_pi_model_check'))
  const pi3 = s3.cons.find(c => c.conname === 'launches_pi_model_check').def
  assert.doesNotMatch(pi3, /valid_model_id/, '內嵌，不依賴函式')
  await db.exec(modelsDown) // 這裡會 drop relay.valid_model_id：約束若還引用它就會中止
  const s4 = await snap(db)
  assert.deepEqual(s4.fns, s0.fns, '兩階段都退完：函式與套用前相同')
  assert.deepEqual(s4.cols, s0.cols)
  assert.deepEqual(without(s4.cons, 'conname', 'launches_pi_model_check'), without(s0.cons, 'conname', 'launches_pi_model_check'))
  const pi4 = s4.cons.find(c => c.conname === 'launches_pi_model_check').def
  assert.equal(pi4, pi3, 'pi 約束保留寬規則')
  assert.notEqual(pi4, s0.cons.find(c => c.conname === 'launches_pi_model_check').def, '與最初的窄規則不同（這是預期的保留）')
})

test('實跑：回退鏈——只跑 110000_down，再重新套用 110000 能成功，狀態與第一次套用後相同', { skip }, async () => {
  const db = await chain()
  await db.exec(modelsMig)
  await db.exec(sql)
  await db.query("insert into relay.launches(node, pi_provider, pi_model, model, model_used) values ('W', null, null, 'opus', 'opus')")
  await db.query("insert into relay.launches(node, pi_provider, pi_model) values ('W', 'openrouter/x', 'y:z')")
  const a = await snap(db)
  await db.exec(down)
  await db.exec(sql)
  const b = await snap(db)
  assert.deepEqual(b, a)
  const rows = (await db.query('select count(*)::int c from relay.launches where pi_provider is not null')).rows[0].c
  assert.equal(rows, 1, '在途的寬規則 pi 列在整段過程中不受影響')
})

test('實跑：內嵌正規式與 relay.valid_model_id 等價——共用向量與一批字元組合，約束收的與函式收的逐筆相同', { skip }, async () => {
  const db = await chain()
  await db.exec(modelsMig)
  await db.exec(sql)
  await db.exec(down) // pi 約束現在是內嵌版
  const fn = async s => (await db.query('select relay.valid_model_id($1) v', [s])).rows[0].v
  const accepts = async (p, m) => {
    try {
      await db.query('insert into relay.launches(node, pi_provider, pi_model) values ($1, $2, $3)', ['W', p, m])
      return true
    } catch (e) {
      assert.match(String(e.message), /launches_pi_model_check/)
      return false
    }
  }
  const all = new Set([...V.valid, ...V.invalid])
  for (let c = 0x20; c < 0x7f; c++) { const ch = String.fromCharCode(c); all.add(ch); all.add(`a${ch}b`); all.add(`a${ch}`) }
  for (const s of ['a/', '/a', 'a//b', 'a/./b', 'a/../b', '..', '.', 'a/.', 'a/..', '.a', 'a.', 'a/.b', 'a/b/', 'a:b/c', 'x'.repeat(100), 'x'.repeat(101), 'x'.repeat(99) + '/', '中', 'a\n', 'a\r']) all.add(s)
  let seed = 20261126
  const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
  const alpha = 'ab9/._:-@+[]\\'
  for (let i = 0; i < 400; i++) { let s = ''; for (let k = 1 + rnd(7); k > 0; k--) s += alpha[rnd(alpha.length)]; all.add(s) }
  let nValid = 0
  for (const s of all) {
    const want = await fn(s)
    if (want) nValid++
    assert.equal(await accepts(s, 'a'), want, `provider ${JSON.stringify(s)}`)
    assert.equal(await accepts('a', s), want, `model ${JSON.stringify(s)}`)
  }
  for (const s of V.valid) assert.equal(await fn(s), true, s)
  for (const s of V.invalid) assert.equal(await fn(s), false, s)
  assert.ok(nValid > 20 && all.size - nValid > 100, `兩邊都有足夠的樣本（合格 ${nValid}／共 ${all.size}）`)
})

closeAtEnd()
