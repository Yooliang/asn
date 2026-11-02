// 收信暫停提示（20261101100000_inbox_hold_until.sql）：
// 1. 靜態：只加可空欄位與一支函式、只授權 service_role、security definer、search_path 空、回復檔拿掉兩者。
// 2. 實跑（有安裝 @electric-sql/pglite 時）：只動得到自己的節點、值被夾在 now() 到 now()+8 天、可以清成 null、停用或不存在的節點動不到。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261101100000_inbox_hold_until.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))

test('靜態：可空欄位、單一函式、只授權 service_role、回復檔拿掉兩者', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf('20261031110000_acct_login_alert_notify.sql'), '編號在最新一支之後')
  assert.match(mig, /alter table relay\.nodes add column if not exists inbox_hold_until timestamptz;/)
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.match(mig, /revoke all on function public\.asn_relay_set_inbox_hold\(text, timestamptz\) from public, anon, authenticated;/)
  assert.match(mig, /grant execute on function public\.asn_relay_set_inbox_hold\(text, timestamptz\) to service_role;/)
  assert.match(mig, /least\(greatest\(p_until, now\(\)\), now\(\) \+ interval '8 days'\)/)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)|drop |create table|truncate/i)
  assert.match(down, /drop function if exists public\.asn_relay_set_inbox_hold\(text, timestamptz\);/)
  assert.match(down, /drop column if exists inbox_hold_until/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active');
    insert into relay.nodes(id) values ('H'), ('W');`)
  await db.exec(mig)
  return db
}
const set = async (db, node, until) => (await db.query('select public.asn_relay_set_inbox_hold($1, $2::timestamptz) r', [node, until])).rows[0].r
const secs = async (db, node) => (await db.query(`select extract(epoch from (inbox_hold_until - now())) s from relay.nodes where id = $1`, [node])).rows[0].s

test('實跑（pglite）：只動自己的節點、值夾在 now() 到 now()+8 天、可清成 null', { skip }, async () => {
  const db = await setup()
  const ahead = h => new Date(Date.now() + h * 3_600_000).toISOString()
  assert.deepEqual(await set(db, 'H', ahead(3)), { ok: true })
  const s = Number(await secs(db, 'H'))
  assert.ok(s > 3 * 3600 - 60 && s <= 3 * 3600 + 5, `設 3 小時：${s}`)
  assert.equal((await db.query(`select inbox_hold_until from relay.nodes where id = 'W'`)).rows[0].inbox_hold_until, null, '別的節點沒被動到')
  // 超過 8 天被夾到 8 天；過去的被夾到現在
  await set(db, 'H', ahead(24 * 30))
  const far = Number(await secs(db, 'H'))
  assert.ok(far > 8 * 86400 - 60 && far <= 8 * 86400 + 5, `夾到 8 天：${far}`)
  await set(db, 'H', ahead(-5))
  assert.ok(Number(await secs(db, 'H')) <= 1, '過去的夾到現在')
  // 清成 null
  await set(db, 'H', ahead(2))
  assert.deepEqual(await set(db, 'H', null), { ok: true })
  assert.equal((await db.query(`select inbox_hold_until from relay.nodes where id = 'H'`)).rows[0].inbox_hold_until, null)
  // 不存在或停用的節點動不到
  assert.deepEqual(await set(db, 'NOPE', ahead(1)), { error: 'forbidden' })
  await db.exec(`update relay.nodes set status = 'revoked' where id = 'W'`)
  assert.deepEqual(await set(db, 'W', ahead(1)), { error: 'forbidden' })
  assert.equal((await db.query(`select inbox_hold_until from relay.nodes where id = 'W'`)).rows[0].inbox_hold_until, null)
})
