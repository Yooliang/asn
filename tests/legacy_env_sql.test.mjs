// F4（#423）migration（20261028230000_legacy_env.sql）：存下名單回報的 used_legacy_env。
// 1. 靜態：只加可為 null 的欄位與函式（不改舊值）、新函式 security definer、search_path 空、只授權 service_role、沒有舊名包裝。
// 2. 實跑：有安裝 @electric-sql/pglite 時（不是專案相依，自己 `npm i --no-save @electric-sql/pglite`）套用 migration：
//    格式不對的丟掉、排序去重、最多 64 個、空陣列存 '{}'、null 當空、只改自己節點、寫入時間。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261028230000_legacy_env.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：只加可為 null 的欄位與檢查條件；新函式 security definer、search_path 空、只授權 service_role、沒有舊名包裝', () => {
  assert.match(sql, /add column if not exists used_legacy_env text\[\];/)
  assert.match(sql, /add column if not exists used_legacy_env_at timestamptz;/)
  assert.match(sql, /cardinality\(used_legacy_env\) <= 64/)
  assert.doesNotMatch(sql, /drop column|alter column|not null/)
  assert.doesNotMatch(sql, /update relay\.nodes set [^;]*where (?!id = p_node)/)
  assert.match(sql, /revoke all on function public\.asn_relay_set_legacy_env\(text, text\[\]\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_relay_set_legacy_env\(text, text\[\]\) to service_role;/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(sql, /function public\.irori_relay_/, '新函式不需要舊名包裝')
  assert.equal((sql.match(/security definer\s*\n\s*set search_path to ''/gi) ?? []).length, 1)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

test('實跑（pglite）：格式過濾、排序去重、最多 64 個、只改自己節點、寫入時間；沒回報過的節點維持 null', { skip }, async () => {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', name text);
    insert into relay.nodes(id, name) values ('A','桌機'), ('B','舊版設備'), ('X','停用'); update relay.nodes set status = 'revoked' where id = 'X';`)
  await db.exec(sql)
  await db.exec(sql) // 可重跑
  const set = async (node, names) => (await db.query('select public.asn_relay_set_legacy_env($1,$2) r', [node, names])).rows[0].r
  const row = async id => (await db.query('select used_legacy_env, used_legacy_env_at from relay.nodes where id = $1', [id])).rows[0]

  assert.deepEqual(await set('A', ['IRORI_RELAY_URL', 'IRORI_AEGIS_URL', 'IRORI_RELAY_URL', 'irori_home', 'ASN_HOME', 'IRORI_', 'IRORI_X=1', 'IRORI_' + 'A'.repeat(65)]), { ok: true, count: 2 })
  const a = await row('A')
  assert.deepEqual(a.used_legacy_env, ['IRORI_AEGIS_URL', 'IRORI_RELAY_URL'])
  assert.ok(a.used_legacy_env_at instanceof Date)

  assert.deepEqual(await set('A', []), { ok: true, count: 0 })
  assert.deepEqual((await row('A')).used_legacy_env, [], "空陣列存 '{}'（回報了、沒用舊名）")
  assert.deepEqual(await set('A', null), { ok: true, count: 0 }, 'null 當空陣列')

  const many = Array.from({ length: 80 }, (_, i) => `IRORI_N${String(i).padStart(2, '0')}`).reverse()
  assert.deepEqual(await set('A', many), { ok: true, count: 64 })
  const m = (await row('A')).used_legacy_env
  assert.equal(m.length, 64)
  assert.deepEqual(m, [...many].sort().slice(0, 64), '排序後留前 64 個')

  assert.deepEqual(await set('X', ['IRORI_HOME']), { error: 'forbidden' }, '停用的節點不能寫')
  assert.deepEqual(await set('不存在', ['IRORI_HOME']), { error: 'forbidden' })
  assert.deepEqual(await row('B'), { used_legacy_env: null, used_legacy_env_at: null }, '沒回報過＝null')
  await assert.rejects(db.query(`update relay.nodes set used_legacy_env = array(select 'IRORI_N' || g from generate_series(1, 65) g) where id = 'B'`), /nodes_used_legacy_env_check/, '資料表也擋超過 64 個')
})

// F4 後續（20261029000000_legacy_env_throttle.sql）：清單有變、或距上次寫入超過一小時才寫；回復檔換回每次都寫。
const throttleSql = fs.readFileSync(new URL('../supabase/migrations/20261029000000_legacy_env_throttle.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const throttleDown = fs.readFileSync(new URL('../supabase/sql/rollback/20261029000000_legacy_env_throttle_down.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態（限流版）：只換函式、security definer、search_path 空、只授權 service_role；回復檔＝原本的函式本體', () => {
  for (const s of [throttleSql, throttleDown]) {
    assert.doesNotMatch(s, /alter table|drop column|drop function/)
    assert.equal((s.match(/security definer\s*\n\s*set search_path to ''/gi) ?? []).length, 1)
    assert.match(s, /revoke all on function public\.asn_relay_set_legacy_env\(text, text\[\]\) from public, anon, authenticated;/)
    assert.match(s, /grant execute on function public\.asn_relay_set_legacy_env\(text, text\[\]\) to service_role;/)
    assert.doesNotMatch(s, /grant execute[^;]*to (anon|authenticated|public)/)
    assert.match(s, /^begin;$/m); assert.match(s, /^commit;$/m)
  }
  assert.match(throttleSql, /used_legacy_env is distinct from v_names/)
  assert.match(throttleSql, /used_legacy_env_at < now\(\) - interval '1 hour'/)
  const body = s => s.slice(s.indexOf('create or replace function'), s.indexOf('$function$;'))
  assert.equal(body(throttleDown), body(sql), '回復檔的函式本體要跟 20261028230000 版一模一樣')
})

test('實跑（pglite，限流版）：同清單一小時內不寫、清單變了就寫、超過一小時同清單會寫、不存在／停用回 forbidden；權限沒放寬；回復後每次都寫', { skip }, async () => {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', name text);
    insert into relay.nodes(id, name) values ('A','桌機'), ('B','另一台'), ('X','停用'); update relay.nodes set status = 'revoked' where id = 'X';`)
  await db.exec(sql)
  await db.exec(throttleSql)
  await db.exec(throttleSql) // 可重跑
  const set = async (node, names) => (await db.query('select public.asn_relay_set_legacy_env($1,$2) r', [node, names])).rows[0].r
  const row = async id => (await db.query('select used_legacy_env, used_legacy_env_at from relay.nodes where id = $1', [id])).rows[0]
  const ago = async (id, iv) => db.query('update relay.nodes set used_legacy_env_at = now() - $2::interval where id = $1', [id, iv])

  // 第一次（從沒寫過）一定寫
  assert.deepEqual(await set('A', ['IRORI_RELAY_URL', 'IRORI_AEGIS_URL']), { ok: true, count: 2 })
  await ago('A', '30 minutes')
  const t1 = (await row('A')).used_legacy_env_at

  // 同清單（順序不同、有重複、夾格式不對的）一小時內：不寫，時間不變
  assert.deepEqual(await set('A', ['IRORI_AEGIS_URL', 'IRORI_RELAY_URL', 'IRORI_AEGIS_URL', 'irori_home']), { ok: true, count: 2, skipped: true })
  assert.equal((await row('A')).used_legacy_env_at.getTime(), t1.getTime(), '一小時內同清單不改寫入時間')

  // 清單變了：寫
  assert.deepEqual(await set('A', ['IRORI_RELAY_URL']), { ok: true, count: 1 })
  const a2 = await row('A')
  assert.deepEqual(a2.used_legacy_env, ['IRORI_RELAY_URL'])
  assert.ok(a2.used_legacy_env_at > t1, '清單變了就更新時間')

  // 變成空陣列也算變了；之後 null（＝空）同清單不寫
  assert.deepEqual(await set('A', []), { ok: true, count: 0 })
  assert.deepEqual((await row('A')).used_legacy_env, [])
  assert.deepEqual(await set('A', null), { ok: true, count: 0, skipped: true })

  // 超過一小時：同清單也寫
  await ago('A', '2 hours')
  const old = (await row('A')).used_legacy_env_at
  assert.deepEqual(await set('A', []), { ok: true, count: 0 })
  assert.ok((await row('A')).used_legacy_env_at > old, '超過一小時同清單會重寫時間')

  // 有清單但時間是 null（不該發生，保險）：寫
  await db.query(`update relay.nodes set used_legacy_env = '{IRORI_HOME}', used_legacy_env_at = null where id = 'B'`)
  assert.deepEqual(await set('B', ['IRORI_HOME']), { ok: true, count: 1 })
  assert.ok((await row('B')).used_legacy_env_at instanceof Date)

  // 不存在／停用：forbidden（停用的就算清單跟現在一樣也不回 ok）
  assert.deepEqual(await set('不存在', ['IRORI_HOME']), { error: 'forbidden' })
  assert.deepEqual(await set('X', ['IRORI_HOME']), { error: 'forbidden' })
  await db.query(`update relay.nodes set status = 'revoked' where id = 'B'`)
  assert.deepEqual(await set('B', ['IRORI_HOME']), { error: 'forbidden' }, '剛寫過、清單一樣，但已停用 → forbidden 不是 skipped')
  assert.deepEqual(await row('X'), { used_legacy_env: null, used_legacy_env_at: null })

  // 權限：只有 service_role 能執行；security definer、search_path 空
  const can = async r => (await db.query(`select has_function_privilege($1, 'public.asn_relay_set_legacy_env(text, text[])', 'execute') ok`, [r])).rows[0].ok
  assert.equal(await can('service_role'), true)
  for (const r of ['anon', 'authenticated']) assert.equal(await can(r), false, `${r} 不能執行`)
  const def = (await db.query(`select prosecdef, proconfig from pg_proc where proname = 'asn_relay_set_legacy_env'`)).rows[0]
  assert.equal(def.prosecdef, true)
  assert.deepEqual(def.proconfig, ['search_path=""'])

  // 回復：每次都寫（同清單一小時內也會改時間、回傳沒有 skipped）
  await db.exec(throttleDown)
  await ago('A', '10 minutes')
  const t3 = (await row('A')).used_legacy_env_at
  assert.deepEqual(await set('A', []), { ok: true, count: 0 })
  assert.ok((await row('A')).used_legacy_env_at > t3, '回復後同清單也寫')
  assert.equal(await can('anon'), false, '回復後權限一樣')
})
