// #443／#444 第 2 步 migration（20261028140000_launcher_pi_models.sql）：asn_relay_set_launcher 多收選填的 pi_models。
// 實跑：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261028140000_launcher_pi_models.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：只改 asn_relay_set_launcher，不動權限', () => {
  assert.match(sql, /create or replace function public\.asn_relay_set_launcher\(p_node text, p_launcher jsonb\)/)
  assert.doesNotMatch(sql, /grant |revoke |alter table|drop /)
  assert.match(sql, /limit 200/)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

test('實跑（pglite）：pi_models 只留合格的 { provider, model }、最多 200 筆、太大只丟 pi_models；舊格式照常；其餘檢查不變', { skip }, async () => {
  const db = new PGlite()
  await db.exec(`create schema relay; create table relay.nodes(id text primary key, status text default 'active', can_invite boolean default false, can_roster boolean default true, launcher jsonb, launcher_at timestamptz);
    insert into relay.nodes(id) values ('W');`)
  await db.exec(sql)
  const set = async l => (await db.query('select public.asn_relay_set_launcher($1, $2::jsonb) r', ['W', l === null ? null : JSON.stringify(l)])).rows[0].r
  const get = async () => (await db.query("select launcher from relay.nodes where id = 'W'")).rows[0].launcher
  const base = { profiles: [{ id: 'pi', label: 'Pi' }], cwd_allow: ['C:/x'] }
  assert.deepEqual(await set(base), { ok: true })
  assert.deepEqual(await get(), { profiles: base.profiles, cwd_allow: base.cwd_allow, max_per_hour: 6 }, '舊格式：跟以前一樣，沒有 pi_models')
  await set({ ...base, pi_models: [{ provider: 'minimax', model: 'MiniMax-M3.1-Flash', token: '不該留' }, { provider: '-x', model: 'y' }, { provider: 'a', model: 3 }, 'x', { provider: 'openai-codex', model: 'gpt-6' }] })
  assert.deepEqual((await get()).pi_models, [{ provider: 'minimax', model: 'MiniMax-M3.1-Flash' }, { provider: 'openai-codex', model: 'gpt-6' }])
  await set({ ...base, pi_models: Array.from({ length: 300 }, (_, i) => ({ provider: 'p', model: `m${i}` })) })
  assert.equal((await get()).pi_models.length, 200)
  await set({ ...base, pi_models: Array.from({ length: 200 }, (_, i) => ({ provider: 'p'.repeat(90), model: `m${i}`.padEnd(90, 'x') })) })
  const big = await get()
  assert.equal(big.pi_models, undefined, '超過 24000 bytes：只丟 pi_models')
  assert.deepEqual(big.profiles, base.profiles, 'launcher 照常存')
  assert.deepEqual(await set({ ...base, profiles: [{ id: '' }] }), { error: 'bad_request' }, '原本的檢查不變')
  assert.deepEqual(await set(null), { ok: true })
  assert.equal(await get(), null)
})
