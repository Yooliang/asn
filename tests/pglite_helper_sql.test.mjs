// tests/_pglite_close.mjs 的加速版 PGlite（#1383）：從同一份空資料庫匯出檔載入的各個資料庫要彼此獨立、跟 initdb 剛建好的一樣乾淨；
// 每項測試結束就關掉這項測試開的資料庫，keepUntilEnd 標起來的留到整支跑完。
import test from 'node:test'
import assert from 'node:assert/strict'
import { track, keepUntilEnd, closeAtEnd, fastPGlite } from './_pglite_close.mjs'

let PGlite = null
try { PGlite = await fastPGlite() } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

test('實跑（pglite）：每個新資料庫都是乾淨的、彼此不共用狀態', { skip }, async () => {
  const a = track(new PGlite())
  const b = track(new PGlite())
  await a.exec("create table t(x int); insert into t values (1); create role r1; create schema s1;")
  assert.deepEqual((await a.query('select x from t')).rows, [{ x: 1 }])
  const c = track(new PGlite())
  for (const db of [b, c]) {
    assert.equal((await db.query("select to_regclass('public.t') r")).rows[0].r, null, '別的資料庫建的表不會出現')
    assert.equal((await db.query("select count(*)::int n from pg_namespace where nspname = 's1'")).rows[0].n, 0)
    assert.equal((await db.query("select count(*)::int n from pg_tables where schemaname = 'public'")).rows[0].n, 0, '公開結構是空的')
  }
  assert.equal((await b.query('select current_database() d')).rows[0].d, 'postgres')
})

test('實跑（pglite）：有帶參數的 new PGlite(...) 照原樣交給 PGlite', { skip }, async () => {
  const db = track(new PGlite({}))
  assert.deepEqual((await db.query('select 1 as one')).rows, [{ one: 1 }])
})

let sharedDb
let firstTestDb
test('實跑（pglite）：關閉時機——準備一個共用的、一個只在這項測試用的', { skip }, async () => {
  sharedDb = keepUntilEnd(track(new PGlite()))
  firstTestDb = track(new PGlite())
  await sharedDb.exec('create table kept(x int)')
  await firstTestDb.query('select 1')
})

test('實跑（pglite）：上一項測試的資料庫已關掉；keepUntilEnd 的還能用', { skip }, async () => {
  assert.equal(firstTestDb.closed, true, '上一項測試開的要在它結束時關掉')
  assert.equal(sharedDb.closed, false)
  await sharedDb.exec('insert into kept values (1)')
  assert.equal((await sharedDb.query('select count(*)::int n from kept')).rows[0].n, 1)
})

closeAtEnd()
