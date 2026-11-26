// #2353 第②階段 migration（20261126100000_launcher_models.sql）：asn_relay_set_launcher 多收 models，並建統一型號規則 relay.valid_model_id。
// 實跑：pglite（CI 的 sql-tests 以 --require-pglite 跑；本機沒裝就略過）。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { cfRanges } from '../tools/gen-cf-ranges.mjs'

const FILE = '20261126100000_launcher_models.sql'
const sql = fs.readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const down = fs.readFileSync(new URL(`../supabase/sql/rollback/${FILE.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const prev = fs.readFileSync(new URL('../supabase/migrations/20261028140000_launcher_pi_models.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const V = JSON.parse(fs.readFileSync(new URL('../relay/shared/test-vectors/model-id.json', import.meta.url), 'utf8'))

const NV = JSON.parse(fs.readFileSync(new URL('../relay/shared/test-vectors/model-name.json', import.meta.url), 'utf8'))

const fnBody =(text, name) => { const m = new RegExp(`create or replace function ${name.replace('.', '\\.')}\\(.*?\\$function\\$;`, 's').exec(text); assert.ok(m, name); return m[0] }

test('靜態：只換 asn_relay_set_launcher、建兩支 relay 函式、不 grant、含向量的 pattern', () => {
  assert.match(sql, /create or replace function relay\.valid_model_id\(/)
  assert.match(sql, /create or replace function relay\.sanitize_launcher_models\(/)
  assert.match(sql, /create or replace function public\.asn_relay_set_launcher\(p_node text, p_launcher jsonb\)/)
  assert.doesNotMatch(sql, /grant |alter table|drop /i)
  assert.match(sql, /revoke all on function relay\.valid_model_id\(text\) from public;/)
  assert.ok(sql.includes(V.pattern), '字元集要與共用向量檔的 pattern 逐字相同')
  assert.match(sql, /octet_length\(\(p_launcher - 'pi_models' - 'models'\)::text\) > 16000/)
  assert.match(sql, /<= 32000/)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.match(down, /^begin;$/m); assert.match(down, /^commit;$/m)
})

test('靜態：down 的 set_launcher 與 20261028140000 的函式本體逐字相同', () => {
  assert.equal(fnBody(down, 'public.asn_relay_set_launcher'), fnBody(prev, 'public.asn_relay_set_launcher'))
})

let PGlite = null
PGlite = await fastPGlite() // 沒裝回 null（略過實跑）；其他錯誤照丟
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

async function setup(extra = sql) {
  const db = track(new PGlite())
  await db.exec(`create schema relay; create table relay.nodes(id text primary key, status text default 'active', can_invite boolean default false, can_roster boolean default true, launcher jsonb, launcher_at timestamptz);
    insert into relay.nodes(id) values ('W');`)
  await db.exec(prev) // 先裝舊版（跟正式庫現況一樣），再套新的
  await db.exec(extra)
  const set = async l => (await db.query('select public.asn_relay_set_launcher($1, $2::jsonb) r', ['W', l === null ? null : JSON.stringify(l)])).rows[0].r
  const get = async () => (await db.query("select launcher from relay.nodes where id = 'W'")).rows[0].launcher
  return { db, set, get }
}
const base = { profiles: [{ id: 'claude', label: 'Claude' }], cwd_allow: ['C:/x'] }
const vend = (vendor, extra = {}) => ({ vendor, status: 'ok', models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }], ...extra })

test('實跑：relay.valid_model_id 對共用向量逐筆答對', { skip }, async () => {
  const { db } = await setup()
  for (const s of V.valid) assert.equal((await db.query('select relay.valid_model_id($1) r', [s])).rows[0].r, true, JSON.stringify(s))
  for (const s of V.invalid) assert.equal((await db.query('select relay.valid_model_id($1) r', [s])).rows[0].r, false, JSON.stringify(s))
  assert.equal((await db.query('select relay.valid_model_id(null) r')).rows[0].r, false)
})

test('實跑：舊格式（沒有 models）輸出與以前完全相同', { skip }, async () => {
  const { set, get } = await setup()
  assert.deepEqual(await set(base), { ok: true })
  assert.deepEqual(await get(), { profiles: base.profiles, cwd_allow: base.cwd_allow, max_per_hour: 6 })
  assert.deepEqual(await set({ ...base, profiles: [{ id: '' }] }), { error: 'bad_request' })
  assert.deepEqual(await set(null), { ok: true })
  assert.equal(await get(), null)
})

test('實跑：16000 上限不算 models（20000 bytes 的 models 照樣存得進）；profiles 太大仍然拒收', { skip }, async () => {
  const { set, get } = await setup()
  const big = [vend('codex', { models: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`.padEnd(60, 'x'), name: 'N'.repeat(60) })) })]
  assert.ok(JSON.stringify(big).length > 20000 && JSON.stringify(big).length < 32000)
  assert.deepEqual(await set({ ...base, models: big }), { ok: true })
  const got = await get()
  assert.equal(got.models[0].models.length, 200)
  const fat = { ...base, cwd_allow: Array.from({ length: 50 }, () => '中'.repeat(260)) } // 每個 780 bytes，合計超過 16000
  assert.deepEqual(await set({ ...fat, models: [vend('codex')] }), { error: 'bad_request' })
})

test('實跑：models 超過 32000 bytes → 只丟 models，launcher 其餘照存', { skip }, async () => {
  const { set, get } = await setup()
  const huge = [vend('codex', { models: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`.padEnd(99, 'x'), name: 'N'.repeat(80) })) })]
  assert.ok(JSON.stringify(huge).length > 32000)
  assert.deepEqual(await set({ ...base, pi_models: [{ provider: 'a', model: 'b' }], models: huge }), { ok: true })
  const got = await get()
  assert.equal(got.models, undefined)
  assert.deepEqual(got.profiles, base.profiles)
  assert.deepEqual(got.pi_models, [{ provider: 'a', model: 'b' }])
})

test('實跑：不合格的家或筆被丟掉、其他照存；vendor 去重留先出現的；最多 8 家；每家最多 200 筆', { skip }, async () => {
  const { set, get } = await setup()
  await set({
    ...base,
    models: [
      'x', 5, null, [],
      vend('Bad'), vend('1x'), vend('x'.repeat(21)), vend('a b'),
      vend('okv', { status: 'weird' }),
      vend('okv', { stale: 'yes' }),
      vend('okv', { code: 'rm -rf' }),
      vend('okv', { age_s: -1 }), vend('okv', { age_s: 1.5 }),
      vend('okv', { models: 'nope' }),
      vend('claude', { id: 1 }),
      { ...vend('codex'), models: [{ id: 'gpt-6', name: 'G6', path: 'C:/x', token: 't' }, { id: '-bad', name: 'x' }, { id: 'a/../b', name: 'x' }, { id: 'ok2', name: '' }, { id: 'ok3', name: 'N'.repeat(81) }, { id: 'ok4' }, 'z', { id: 'ok5', name: 'N'.repeat(80) }] },
      vend('codex', { status: 'error' }),
    ],
  })
  const got = (await get()).models
  assert.deepEqual(got.map(v => v.vendor), ['claude', 'codex'], '壞的整家丟掉；okv 全部不合格；codex 重複只留先出現的')
  assert.deepEqual(got[1].models, [{ id: 'gpt-6', name: 'G6' }, { id: 'ok5', name: 'N'.repeat(80) }], '壞筆丟掉、多餘欄位不收')
  assert.equal(got[1].status, 'ok')
  // 最多 8 家
  const ten = Array.from({ length: 10 }, (_, i) => vend(`v${i}`))
  await set({ ...base, models: ten })
  assert.deepEqual((await get()).models.map(v => v.vendor), ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'])
  // 每家最多 200 筆
  await set({ ...base, models: [vend('pi', { models: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) })] })
  assert.equal((await get()).models[0].models.length, 200)
})

test('實跑：status／code 列舉、stale 布林、age_s 非負整數；reason 被丟掉；缺的選填欄位不補', { skip }, async () => {
  const { set, get } = await setup()
  for (const status of ['ok', 'unavailable', 'error', 'pending']) {
    await set({ ...base, models: [{ vendor: 'v', status, models: [] }] })
    assert.deepEqual((await get()).models, [{ vendor: 'v', status, models: [] }])
  }
  for (const code of ['ok', 'not_installed', 'not_logged_in', 'timeout', 'too_large', 'parse_failed', 'spawn_failed', 'unsupported']) {
    await set({ ...base, models: [{ vendor: 'v', status: 'unavailable', code, models: [] }] })
    assert.equal((await get()).models[0].code, code)
  }
  await set({ ...base, models: [{ vendor: 'v', status: 'ok', stale: true, age_s: 1260, code: 'timeout', reason: '原文 C:\\Users\\x token=abc', models: [] }] })
  assert.deepEqual((await get()).models, [{ vendor: 'v', status: 'ok', stale: true, code: 'timeout', age_s: 1260, models: [] }])
  assert.ok(!JSON.stringify(await get()).includes('原文'), 'reason 不收')
  await set({ ...base, models: [{ vendor: 'v', status: 'pending' }] })
  assert.deepEqual((await get()).models, [{ vendor: 'v', status: 'pending', models: [] }])
  await set({ ...base, models: [] })
  assert.deepEqual((await get()).models, [], '有回報但沒有可用的：存空陣列')
  await set({ ...base, models: 'x' })
  assert.equal((await get()).models, undefined, '不是陣列：不存')
})

test('實跑：name 擋控制字元與常見格式字元', { skip }, async () => {
  const { set, get } = await setup()
  const names = ['a\u0001b', 'a\u007fb', 'a\u0085b', 'a\u200bb', 'a\u202eb', 'a\ufeffb', 'a\u00adb', 'a\u2066b', 'a\nb']
  await set({ ...base, models: [vend('v', { models: [...names.map((n, i) => ({ id: `m${i}`, name: n })), { id: 'good', name: '中文 Name (v1)' }] })] })
  assert.deepEqual((await get()).models[0].models, [{ id: 'good', name: '中文 Name (v1)' }])
})

// 已套用到正式庫的 migration 不能回頭改，所以不逐字比對；改成檢查「目前生效的 SQL 區間涵蓋 Node 的 \p{Cf}」。
// 「目前生效」＝migrations 資料夾裡、檔名時間戳最新、且定義了 relay.sanitize_launcher_models 的那一支（日後新增的 migration 自動接手）。
const MIG_DIR = new URL('../supabase/migrations/', import.meta.url)
export function latestSanitizeMigration() {
  const files = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort()
  const hit = files.filter(f => /create or replace function relay\.sanitize_launcher_models\(/i.test(fs.readFileSync(new URL(f, MIG_DIR), 'utf8')))
  assert.ok(hit.length > 0, '找不到定義 relay.sanitize_launcher_models 的 migration')
  return hit[hit.length - 1]
}

// 從 migration 文字解析出 name 檢查的字元類，回傳 [起, 迄] 碼點區間
export function parseSqlNameClass(text) {
  const m = /\(m\.x->>'name'\) ~ '\[(.*?)\]'/.exec(text)
  assert.ok(m, '找不到 name 檢查的字元類')
  const ranges = []
  const re = /\\[uU]([0-9a-fA-F]{4,8})(?:-\\[uU]([0-9a-fA-F]{4,8}))?/g
  for (const t of m[1].matchAll(re)) {
    const a = parseInt(t[1], 16)
    ranges.push([a, t[2] ? parseInt(t[2], 16) : a])
  }
  assert.ok(ranges.length > 10, '解析出的區間太少，格式可能變了')
  return ranges
}

const uplus = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')

// 斷言 Node 每個 \p{Cf} 碼點都落在 SQL 區間內；SQL 比 Node 多擋的不算錯
export function assertCoversCf(text, file) {
  const ranges = parseSqlNameClass(text)
  for (const [a, b] of cfRanges()) {
    for (let cp = a; cp <= b; cp++) {
      if (!ranges.some(([x, y]) => cp >= x && cp <= y)) {
        assert.fail(`${file} 的 Cf 區間沒涵蓋 ${uplus(cp)}。請用 tools/gen-cf-ranges.mjs 另寫一支新的 migration 更新 relay.sanitize_launcher_models，不要改已套用的舊檔`)
      }
    }
  }
}

test('靜態：目前生效的 SQL Cf 區間涵蓋 Node 的 \\p{Cf}（Node 的 Unicode 資料更新後若有新碼點就會紅）', () => {
  const file = latestSanitizeMigration()
  const text = fs.readFileSync(new URL(file, MIG_DIR), 'utf8').replace(/\r\n/g, '\n')
  assertCoversCf(text, file)
  assert.ok(cfRanges().length > 10)
})

test('靜態：涵蓋檢查本身會擋（假 migration 少一個區間）', () => {
  const fake = sql.replace('\\U000110bd', '')
  assert.notEqual(fake, sql)
  assert.throws(() => assertCoversCf(fake, 'fake.sql'), err => {
    assert.match(err.message, /另寫一支新的 migration/)
    assert.match(err.message, /U\+110BD/)
    return true
  })
  assertCoversCf(sql, FILE) // 原版不報錯
  // SQL 多擋（多一個區間）不算錯
  assertCoversCf(sql.replace('\\U000110bd', '\\U000110bd\\U00001234'), FILE)
})

// 向量的每一筆是字串，或碼點數字的陣列
const nameOf = x => (typeof x === 'string' ? x : String.fromCodePoint(...x))

test('實跑：name 對共用向量（model-name.json）逐筆答對（Edge 讀同一份）', { skip }, async () => {
  const { set, get } = await setup()
  const all = [...NV.valid, ...NV.invalid].map(nameOf)
  await set({ ...base, models: [vend('v', { models: all.map((n, i) => ({ id: `m${i}`, name: n })) })] })
  assert.deepEqual((await get()).models[0].models.map(m => m.name), NV.valid.map(nameOf))
  // 長度：剛好上限收、多一個丟
  await set({ ...base, models: [vend('v', { models: [{ id: 'a', name: 'N'.repeat(NV.max_chars) }, { id: 'b', name: 'N'.repeat(NV.max_chars + 1) }] })] })
  assert.deepEqual((await get()).models[0].models.map(m => m.id), ['a'])
})

test('實跑：name 的每個 Cf 區間頭尾與 \\p{Cf} 一致（涵蓋 Tag、U+110BD 等）', { skip }, async () => {
  const { db } = await setup()
  const bad = []
  for (const [a, b] of cfRanges()) for (const cp of [a, b]) {
    const input = JSON.stringify([vend('v', { models: [{ id: 'm', name: `a${String.fromCodePoint(cp)}b` }] })])
    const out = (await db.query('select relay.sanitize_launcher_models($1::jsonb) r', [input])).rows[0].r
    if (out[0].models.length !== 0) bad.push(cp.toString(16))
  }
  assert.deepEqual(bad, [], '這些 Cf 碼點沒被 SQL 擋住')
})

test('實跑：型號代號對共用向量（經 models 與 pi_models）', { skip }, async () => {
  const { set, get } = await setup()
  await set({ ...base, models: [vend('v', { models: [...V.valid, ...V.invalid].map((id, i) => ({ id, name: `n${i}` })) })], pi_models: [...V.valid, ...V.invalid].map(id => ({ provider: id, model: id })) })
  const got = await get()
  assert.deepEqual(got.models[0].models.map(m => m.id), V.valid)
  assert.deepEqual(got.pi_models.map(m => m.model), V.valid)
})

test('實跑：pi_models 的 a//b、a/.. 現在被丟掉', { skip }, async () => {
  const { set, get } = await setup()
  await set({ ...base, pi_models: [{ provider: 'a//b', model: 'x' }, { provider: 'p', model: 'a/..' }, { provider: 'openrouter', model: 'meta/llama-3' }] })
  assert.deepEqual((await get()).pi_models, [{ provider: 'openrouter', model: 'meta/llama-3' }])
})

const WIRE = JSON.parse(fs.readFileSync(new URL('../relay/shared/test-vectors/launcher-models-wire.json', import.meta.url), 'utf8'))

test('實跑：Rust 的 wire 樣本經 relay.sanitize_launcher_models 與 asn_relay_set_launcher 後深度相等（SQL 一筆都不丟）', { skip }, async () => {
  assert.equal(WIRE.models.length, 4)
  const { db, set, get } = await setup()
  const r = await db.query('select relay.sanitize_launcher_models($1::jsonb) r', [JSON.stringify(WIRE.models)])
  assert.deepEqual(r.rows[0].r, WIRE.models)
  assert.deepEqual(await set({ ...base, models: WIRE.models }), { ok: true })
  assert.deepEqual((await get()).models, WIRE.models)
})

test('實跑：套用 down 之後行為回到 20261028140000，新函式消失', { skip }, async () => {
  const { db, set, get } = await setup()
  await db.exec(down)
  await set({ ...base, models: [vend('codex')], pi_models: [{ provider: 'a', model: 'b' }] })
  assert.deepEqual(await get(), { ...{ profiles: base.profiles, cwd_allow: base.cwd_allow, max_per_hour: 6 }, pi_models: [{ provider: 'a', model: 'b' }] }, '舊版不存 models')
  const r = await db.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'relay' and p.proname in ('valid_model_id', 'sanitize_launcher_models')")
  assert.equal(r.rows[0].n, 0)
})

closeAtEnd()
