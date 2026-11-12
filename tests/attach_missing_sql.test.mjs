// 附件不齊提示（20261112000000_attach_missing.sql，#1205）：asn_relay_attach_missing 回「沒有綁在這封信上」的附件編號。
// 涵蓋：全綁上＝空；沒綁／過期未綁／不存在／別人的附件＝缺；只回傳 p_ids 裡的編號（去重、依傳入順序）；
// 與既有 asn_relay_attach_bind 搭配：補綁成功＝齊；綁到別封信的不算綁在這封；兩個請求同時各綁一半，核對看結果不誤判；純讀取。
// 沒裝 @electric-sql/pglite 時只跑靜態部分。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const FILE = '20261112000000_attach_missing.sql'
const mig = rd(fs.readFileSync(new URL(FILE, DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL('../supabase/sql/rollback/20261112000000_attach_missing_down.sql', import.meta.url), 'utf8'))
const SIG = 'asn_relay_attach_missing(text, uuid[], uuid)'

test('靜態：只授權 service_role、search_path 空、純讀取；排在依賴的前一支之後；有回復檔', () => {
  const body = mig.replace(/^--.*$/gm, '')
  assert.ok(body.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(body.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(body, /security definer\s+set search_path to ''/)
  assert.doesNotMatch(body, /\b(insert|update|delete)\b/i)
  assert.doesNotMatch(body, /attach_(claim|bind)/)
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
  // 只要求排在它依賴的前一支之後；不要求是最新的一支（之後加 migration 不該弄壞這張測試）
  assert.ok(files.indexOf(FILE) > files.indexOf('20261111200000_acct_quota_week_confirm.sql'))
  assert.match(down, /drop function if exists public\.asn_relay_attach_missing\(text, uuid\[\], uuid\)/)
})

let PGlite = null
try { PGlite = await fastPGlite() } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const M1 = '00000000-0000-0000-0000-0000000000a1'
const M2 = '00000000-0000-0000-0000-0000000000a2'
const A = n => `00000000-0000-0000-0000-00000000b${String(n).padStart(3, '0')}`

async function boot() {
  const db = track(new PGlite())
  // 表與既有 bind 函式的替身，條件與正式的 asn_relay_attach_bind 相同（未綁定、ready、未過期才綁）
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.attachments(id uuid primary key, owner_node text not null, status text not null default 'ready',
      message_id uuid, room_id text, room_seq bigint, expires_at timestamptz not null default now() + interval '1 day');
    create function public.asn_relay_attach_bind(p_node text, p_ids uuid[], p_message_id uuid, p_room text, p_seq bigint) returns jsonb language plpgsql as $$
      declare v_n int; begin
        update relay.attachments set message_id = p_message_id
          where id = any(coalesce(p_ids, array[]::uuid[])) and owner_node = p_node and status = 'ready'
            and message_id is null and room_id is null and expires_at > now();
        get diagnostics v_n = row_count; return jsonb_build_object('bound', v_n); end $$;`)
  await db.exec(mig)
  const q = async (t, a) => (await db.query(t, a)).rows
  const add = (id, node = 'H', extra = '') => db.exec(`insert into relay.attachments(id, owner_node) values ('${id}', '${node}')${extra}`)
  const missing = async (ids, msg = M1, node = 'H') => (await q(`select public.asn_relay_attach_missing($1, $2::uuid[], $3::uuid) r`, [node, ids, msg]))[0].r
  const bind = async (ids, msg = M1, node = 'H') => (await q(`select public.asn_relay_attach_bind($1, $2::uuid[], $3::uuid, null, null) r`, [node, ids, msg]))[0].r.bound
  return { db, q, add, missing, bind }
}

test('實跑：全綁在這封信上＝空；沒綁的、不存在的、別人的都算缺', { skip }, async () => {
  const { db, add, missing, bind } = await boot()
  await add(A(1)); await add(A(2)); await add(A(3), 'OTHER')
  await bind([A(1)])
  assert.deepEqual(await missing([A(1)]), [])
  assert.deepEqual(await missing([A(1), A(2)]), [A(2)])
  assert.deepEqual(await missing([A(9)]), [A(9)], '不存在的編號在 p_ids 裡就是缺')
  await db.close()
})

test('實跑：不存在與別人的附件算缺，且只回 p_ids 裡的、去重、依傳入順序', { skip }, async () => {
  const { db, add, missing } = await boot()
  await add(A(3), 'OTHER'); await add(A(4))
  assert.deepEqual(await missing([A(9), A(3), A(4), A(9)]), [A(9), A(3), A(4)])
  assert.deepEqual(await missing([]), [])
  assert.deepEqual(await missing(null), [])
  await db.close()
})

test('實跑：補綁成功＝齊；附件過期（綁不上）＝缺；綁到別封信的不算綁在這封', { skip }, async () => {
  const { db, add, missing, bind } = await boot()
  await add(A(1)); await add(A(2)); await add(A(3))
  await db.exec(`update relay.attachments set expires_at = now() - interval '1 minute' where id = '${A(2)}'`)
  assert.equal(await bind([A(1), A(2)]), 1, '過期的綁不上')
  assert.deepEqual(await missing([A(1), A(2)]), [A(2)])
  assert.equal(await bind([A(3)], M2), 1)
  assert.deepEqual(await missing([A(3)], M1), [A(3)], '綁在別封信上，對 M1 而言是缺')
  assert.deepEqual(await missing([A(3)], M2), [])
  assert.deepEqual(await missing([A(1)], null), [A(1)], '沒給信的編號一律缺')
  await db.close()
})

test('實跑：第一次與重複的請求各綁一半（bind 筆數 0 也不誤判），核對看結果', { skip }, async () => {
  const { db, add, missing, bind } = await boot()
  await add(A(1)); await add(A(2))
  const ids = [A(1), A(2)]
  assert.equal(await bind([A(1)]), 1) // 另一個請求先綁好一個
  assert.equal(await bind(ids), 1) // 這個請求只綁到剩下的一個
  assert.equal(await bind(ids), 0) // 第三個請求什麼都沒綁到
  assert.deepEqual(await missing(ids), [], '綁 0 筆但實際已齊，不算缺')
  await db.close()
})

test('實跑：權限收回，純讀取不改資料', { skip }, async () => {
  const { db, q, add, missing } = await boot()
  await add(A(1))
  const before = JSON.stringify(await q(`select * from relay.attachments order by id`))
  await missing([A(1)])
  assert.equal(JSON.stringify(await q(`select * from relay.attachments order by id`)), before)
  const acl = (await q(`select has_function_privilege('service_role', 'public.${SIG}', 'execute') s, has_function_privilege('anon', 'public.${SIG}', 'execute') a, has_function_privilege('authenticated', 'public.${SIG}', 'execute') u`))[0]
  assert.deepEqual(acl, { s: true, a: false, u: false })
  await db.close()
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
