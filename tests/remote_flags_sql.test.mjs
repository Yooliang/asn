// 電腦端回報「允許別台看畫面／在這台打字」兩個開關（20261119300000_remote_flags.sql，#1751）。
// 只是提示值：null＝不知道（舊版沒回報）；只改自己節點；沒帶的那個保留舊值；回復檔拿得掉。沒裝 @electric-sql/pglite 時只跑靜態部分。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const NAME = '20261119300000_remote_flags'
const mig = rd(fs.readFileSync(new URL(`${NAME}.sql`, DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${NAME}_down.sql`, import.meta.url), 'utf8'))
const SIG = 'public.asn_relay_set_remote_flags(text, boolean, boolean)'

test('靜態：只授權 service_role、search_path 空、只加新欄位與一支新函式；排在最新的 migration 之後；有回復檔', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.ok(body.includes(`revoke all on function ${SIG} from public, anon, authenticated;`))
  assert.ok(body.includes(`grant execute on function ${SIG} to service_role;`))
  assert.match(body, /security definer\s+set search_path to ''/)
  assert.doesNotMatch(body, /grant [^;]*to (anon|authenticated|public)/i)
  assert.doesNotMatch(body, /drop |asn_relay_list/i, '不動名單函式、不刪東西')
  assert.equal((body.match(/add column if not exists \w+ (boolean|timestamptz);/g) ?? []).length, 3, '三個欄位都可為 null、沒有預設值')
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
  assert.equal(files.indexOf(`${NAME}.sql`), files.length - 1)
  assert.ok(down.includes(`drop function if exists ${SIG};`))
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
closeAtEnd()

async function boot({ upgrade = true } = {}) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text not null default 'active');
    insert into relay.nodes(id) values ('PC'), ('PC2'); insert into relay.nodes(id, status) values ('GONE', 'revoked');`)
  if (upgrade) await db.exec(mig)
  const q = async (t, a) => (await db.query(t, a)).rows
  const set = async (n, v, i) => (await q('select public.asn_relay_set_remote_flags($1, $2, $3) r', [n, v, i]))[0].r
  const get = async n => (await q('select remote_view v, remote_input i, remote_flags_at at from relay.nodes where id = $1', [n]))[0]
  return { db, q, set, get }
}

test('實跑：既有的節點是 null（不知道）；回報之後存得進去，true、false 都分得出來', { skip }, async () => {
  const { set, get } = await boot()
  assert.deepEqual(await get('PC'), { v: null, i: null, at: null })
  assert.equal((await set('PC', true, true)).ok, true)
  const a = await get('PC')
  assert.deepEqual([a.v, a.i], [true, true]); assert.ok(a.at)
  await set('PC', true, false)
  assert.deepEqual([(await get('PC')).v, (await get('PC')).i], [true, false])
})

test('實跑：只帶一個，另一個保留舊值；兩個都沒帶什麼都不寫（舊版格式不會把已知的值洗成不知道）', { skip }, async () => {
  const { set, get } = await boot()
  await set('PC', true, false)
  const t0 = (await get('PC')).at
  await set('PC', false, null)
  assert.deepEqual([(await get('PC')).v, (await get('PC')).i], [false, false])
  await set('PC', null, true)
  assert.deepEqual([(await get('PC')).v, (await get('PC')).i], [false, true])
  const none = await set('PC', null, null)
  assert.deepEqual(none, { ok: true, changed: false })
  const a = await get('PC')
  assert.deepEqual([a.v, a.i], [false, true])
  assert.ok(a.at >= t0)
})

test('實跑：只改自己那一列；撤銷的節點與不存在的節點回 forbidden', { skip }, async () => {
  const { set, get } = await boot()
  await set('PC', true, true)
  assert.deepEqual(await get('PC2'), { v: null, i: null, at: null }, '別的節點不動')
  assert.equal((await set('GONE', true, true)).error, 'forbidden')
  assert.equal((await set('NOPE', true, true)).error, 'forbidden')
  assert.deepEqual(await get('GONE'), { v: null, i: null, at: null })
})

test('實跑：anon、authenticated 不能呼叫', { skip }, async () => {
  const { db } = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select ${SIG.replace(/\(.*/, '')}('PC', true, true)`), /permission denied/, role)
    await db.exec('reset role')
  }
})

test('實跑：舊程式沒有這支函式與欄位（驗證新測試在舊程式上會紅）', { skip }, async () => {
  const { db } = await boot({ upgrade: false })
  await assert.rejects(() => db.query(`select public.asn_relay_set_remote_flags('PC', true, true)`), /does not exist/)
  await assert.rejects(() => db.query(`select remote_input from relay.nodes`), /does not exist/)
})

test('實跑：回復檔拿掉函式與欄位；可以重新套；套兩次不壞', { skip }, async () => {
  const { db, q, set } = await boot()
  await db.exec(mig)
  await set('PC', true, true)
  await db.exec(down)
  assert.equal((await q(`select count(*)::int n from pg_proc where proname = 'asn_relay_set_remote_flags'`))[0].n, 0)
  assert.equal((await q(`select count(*)::int n from information_schema.columns where table_schema = 'relay' and table_name = 'nodes' and column_name like 'remote\_%'`))[0].n, 0)
  assert.equal((await q('select count(*)::int n from relay.nodes'))[0].n, 3, '節點本身不動')
  await db.exec(mig)
  assert.equal((await set('PC', false, false)).ok, true)
})
