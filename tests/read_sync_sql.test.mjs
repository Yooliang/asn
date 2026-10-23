// 已讀多端同步 migration（20261023080000_read_sync.sql）：
// 1. 靜態：只給 service_role、security definer＋search_path ''、RLS 開且沒有 policy、本人簽章與擁有關係、只往前（greatest）、函式用 asn_relay_ 新名。
// 2. 實跑：有安裝 @electric-sql/pglite 時（`npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres 套用這支：
//    簽章／擁有關係、壞格式整批不寫、只往前、帳號之間互不看見、多台設備合併、鍵數上限、未來時間夾住。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = read('20261023080000_read_sync.sql')

test('靜態：資料表開 RLS 且不建 policy；函式 security definer、search_path 空、只授權 service_role、用新名', () => {
  assert.match(sql, /alter table relay\.read_marks enable row level security;/)
  assert.match(sql, /revoke all on relay\.read_marks from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /create policy/)
  const sig = 'public\\.asn_relay_read_sync\\(text, uuid, jsonb\\)'
  assert.match(sql, new RegExp(`revoke all on function ${sig} from public, anon, authenticated;`))
  assert.match(sql, new RegExp(`grant execute on function ${sig} to service_role;`))
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.equal((sql.match(/security definer\n\s*set search_path to ''/g) ?? []).length, 1)
  assert.doesNotMatch(sql, /irori_relay_/, '新函式不再用舊名')
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
})

test('靜態：要本人簽章並擁有呼叫節點；寫入只往前（greatest）；時間夾在現在加五分鐘以內；只動簽章者自己的列', () => {
  assert.match(sql, /p_signed_user is null[\s\S]*?asn_user_owns_node\(p_signed_user, p_actor\)[\s\S]*?'forbidden'/)
  assert.match(sql, /read_at = greatest\(relay\.read_marks\.read_at, excluded\.read_at\)/)
  assert.match(sql, /least\(to_timestamp\(v_ms \/ 1000\.0\), now\(\) \+ interval '5 minutes'\)/)
  assert.doesNotMatch(sql, /where user_id = (?!p_signed_user)/, '所有查詢都以簽章者為條件')
  assert.doesNotMatch(sql, /role = 'owner'/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    insert into relay.nodes(id, owner_user) values ('PH', '${U1}'), ('PC', '${U1}'), ('OT', '${U2}');`)
  await db.exec(sql)
  const sync = async (actor, user, marks) => (await db.query('select public.asn_relay_read_sync($1,$2,$3::jsonb) r', [actor, user, JSON.stringify(marks)])).rows[0].r
  return { db, sync }
}

test('實跑（pglite）：簽章與擁有關係', { skip }, async () => {
  const { sync } = await boot()
  assert.equal((await sync('PH', null, [])).error, 'forbidden', '沒簽章')
  assert.equal((await sync('PH', U2, [])).error, 'forbidden', '簽章的人不擁有呼叫節點')
  assert.equal((await sync('OT', U1, [])).error, 'forbidden')
  assert.equal((await sync('沒有', U1, [])).error, 'forbidden')
  assert.deepEqual(await sync('PH', U1, []), { ok: true, marks: {} }, '空陣列＝只取回')
})

test('實跑（pglite）：只往前、多台設備合併、帳號互不看見', { skip }, async () => {
  const { sync, db } = await boot()
  const K = 'p_0123456789abcdef0123'
  assert.deepEqual((await sync('PH', U1, [{ key: K, at: 2000 }, { key: 'n:H/小文', at: 500 }])).marks, { [K]: 2000, 'n:H/小文': 500 })
  assert.deepEqual((await sync('PC', U1, [{ key: K, at: 1000 }])).marks, { [K]: 2000, 'n:H/小文': 500 }, '舊位置晚到不會倒退；另一台設備看得到前一台寫的')
  assert.equal((await sync('PC', U1, [{ key: K, at: 3000 }])).marks[K], 3000)
  assert.deepEqual((await sync('OT', U2, [])).marks, {}, '別的帳號看不到')
  assert.deepEqual((await sync('OT', U2, [{ key: K, at: 9 }])).marks, { [K]: 9 })
  assert.equal((await sync('PH', U1, [])).marks[K], 3000, '別的帳號寫同樣的鍵不影響')
  // 重送同樣的位置：updated_at 不被改動（沒有前進）
  const before = (await db.query(`select updated_at from relay.read_marks where user_id = '${U1}' and key = $1`, [K])).rows[0].updated_at
  await sync('PH', U1, [{ key: K, at: 3000 }])
  const after = (await db.query(`select updated_at from relay.read_marks where user_id = '${U1}' and key = $1`, [K])).rows[0].updated_at
  assert.equal(+after, +before)
})

test('實跑（pglite）：壞格式整批不寫；未來時間夾住；鍵數上限只擋新增；過期清掉', { skip }, async () => {
  const { sync, db } = await boot()
  const good = { key: 'n:H/a', at: 1000 }
  for (const bad of [{ key: 'ab', at: 5 }, { key: 'abc', at: 0 }, { key: 'abc', at: -5 }, { key: 'abc', at: '5' }, { key: 5, at: 5 }, { key: 'abc' }, 'x', { key: 'abc', at: 4102444800001 }]) {
    assert.equal((await sync('PH', U1, [good, bad])).error, 'bad_request', JSON.stringify(bad))
  }
  assert.equal((await sync('PH', U1, { not: 'array' })).error, 'bad_request')
  assert.equal((await sync('PH', U1, Array.from({ length: 101 }, (_, i) => ({ key: `n:H/${i}`, at: 5 })))).error, 'bad_request')
  assert.deepEqual((await sync('PH', U1, [])).marks, {}, '壞批次沒有任何寫入')
  const far = (await sync('PH', U1, [{ key: 'n:H/future', at: 4000000000000 }])).marks['n:H/future']
  assert.ok(far < Date.now() + 6 * 60_000, '未來時間被夾在現在加五分鐘內')
  await db.exec(`insert into relay.read_marks(user_id, key, read_at) select '${U1}', 'bulk' || g, now() from generate_series(1, 2000) g`)
  assert.equal((await sync('PH', U1, [{ key: 'n:H/new', at: 5 }])).error, 'rate_limited', '滿了不能再新增')
  assert.equal((await sync('PH', U1, [{ key: 'bulk1', at: 4 }])).ok, true, '已有的鍵照常更新')
  await db.exec(`update relay.read_marks set updated_at = now() - interval '91 days' where key = 'bulk2'`)
  const m = (await sync('PH', U1, [])).marks
  assert.ok(!('bulk2' in m) && 'bulk3' in m, '超過 90 天沒更新的清掉')
})
