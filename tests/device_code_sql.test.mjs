// 裝置授權登入（20261024120000_device_code.sql）：給沒有畫面的主機用短碼換節點金鑰。
// 靜態檢查＋pglite 實跑（`npm i --no-save @electric-sql/pglite`，沒裝就略過實跑）。
// 實跑驗：start 頻率限制；approve 建節點（代號規則、擁有者歸屬）；poll 核准前等待、核准後一次性交出（金鑰雜湊才寫入）、之後作廢；
//         錯碼限次（暴力猜短碼）；到期；未領取就到期的節點作廢；舊節點與其他動作不受影響。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const mig = fs.readFileSync(new URL('../supabase/migrations/20261024120000_device_code.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('靜態：只授權 service_role、security definer、開 RLS、不存明文金鑰與短碼', () => {
  for (const f of ['asn_device_code_start(text, text, text, integer)', 'asn_device_code_approve(uuid, text, text, text, text)', 'asn_device_code_poll(text, text)']) {
    const esc = f.replace(/[()]/g, m => '\\' + m)
    assert.match(mig, new RegExp(`revoke all on function public\\.${esc} from public, anon, authenticated;`), f)
    assert.match(mig, new RegExp(`grant execute on function public\\.${esc} to service_role;`), f)
  }
  assert.match(mig, /alter table relay\.device_codes enable row level security;/)
  assert.match(mig, /alter table relay\.device_code_attempts enable row level security;/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(mig, /\b(user_code|device_code|key) text/, '資料表不得有明文欄位')
  assert.match(mig, /'device-code'/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'aaaaaaaa-0000-0000-0000-000000000002'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid, id_prefix text, status text default 'active');
    create table relay.nodes(id text primary key, name text, key_hash text not null, bell_topic text not null, kind text, role text default 'member',
      can_invite boolean default false, machine text, status text default 'active', last_seen_at timestamptz, tenant_id uuid, owner_user uuid,
      device_id text, created_via text, created_at timestamptz default now(),
      constraint nodes_created_via_check check (created_via is null or created_via in ('login-device', 'claim-existing', 'cloud-invite')));
    create table relay.account_events(user_id uuid, event text, node text, detail jsonb, at timestamptz default now());
    insert into relay.tenants values ('${T1}', '${U1}', 't1-', 'active'), ('${T2}', '${U2}', null, 'active');
    insert into relay.nodes(id, name, key_hash, bell_topic, tenant_id, owner_user) values ('t1-old', '舊', 'h-old', 'b-old', '${T1}', '${U1}');
    create function relay.asn_ensure_tenant(p_user uuid, p_x text) returns relay.tenants language sql as
      $$ select * from relay.tenants where owner_user = p_user $$;`)
  await db.exec(mig)
  return db
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0].r
const start = (db, ip = 'ip1', dev = 'dev1', usr = 'usr1') => one(db, 'select public.asn_device_code_start($1,$2,$3,5) r', [ip, dev, usr])
const approve = (db, user = U1, usr = 'usr1', node = null, name = '無頭主機') => one(db, 'select public.asn_device_code_approve($1,$2,$3,$4,$5) r', [user, usr, node, name, 'bell-1'])
const poll = (db, dev = 'dev1', keyHash = 'KH1') => one(db, 'select public.asn_device_code_poll($1,$2) r', [dev, keyHash])
const node = async (db, id) => (await db.query('select * from relay.nodes where id = $1', [id])).rows[0]

test('實跑：start 回到期與間隔；同一網路位址每小時最多 10 次', { skip }, async () => {
  const db = await setup()
  const s = await start(db)
  assert.equal(s.interval, 5)
  assert.ok(Date.parse(s.expires_at) - Date.now() > 14 * 60_000 && Date.parse(s.expires_at) - Date.now() <= 15 * 60_000)
  for (let i = 2; i <= 10; i++) assert.ok(!(await start(db, 'ip1', 'd' + i, 'u' + i)).error)
  assert.deepEqual(await start(db, 'ip1', 'd11', 'u11'), { error: 'rate_limited' })
  assert.ok(!(await start(db, 'ip2', 'd12', 'u12')).error, '別的位址不受影響')
  assert.deepEqual(await start(db, 'ip3', 'd13', 'u2'), { error: 'collision' }, '短碼撞到＝讓呼叫端重抽')
})

test('實跑：完整流程——等待、核准、一次性交出、之後作廢；金鑰雜湊只在交出時寫入', { skip }, async () => {
  const db = await setup()
  await start(db)
  assert.deepEqual(await poll(db), { status: 'pending' })
  const a = await approve(db, U1, 'usr1', null, '無頭主機')
  assert.match(a.id, /^t1-[0-9a-f]{8}$/, '沒指定代號＝租戶前綴＋亂數')
  const n = await node(db, a.id)
  assert.equal(n.owner_user, U1); assert.equal(n.tenant_id, T1); assert.equal(n.created_via, 'device-code'); assert.equal(n.role, 'member'); assert.equal(n.can_invite, false)
  assert.match(n.key_hash, /^pending:/, '核准時還沒有可用金鑰')
  await db.exec(`update relay.device_codes set last_poll_at = now() - interval '1 minute'`)
  const p = await poll(db, 'dev1', 'KH1')
  assert.deepEqual(p, { status: 'approved', id: a.id, bell_topic: 'bell-1' })
  assert.equal((await node(db, a.id)).key_hash, 'KH1')
  await db.exec(`update relay.device_codes set last_poll_at = now() - interval '1 minute'`)
  assert.deepEqual(await poll(db, 'dev1', 'KH2'), { status: 'expired' }, '領過一次就作廢')
  assert.equal((await node(db, a.id)).key_hash, 'KH1', '第二次不會換掉金鑰')
  assert.deepEqual(await poll(db, 'nope'), { error: 'invalid_device_code' })
  // 同一個短碼不能再核准一次
  assert.deepEqual(await approve(db, U1, 'usr1'), { error: 'invalid_code' })
})

test('實跑：指定代號走 register 的規則（前綴、保留格式、撞名）；沒前綴的租戶避開 t<數字>-', { skip }, async () => {
  const db = await setup()
  await start(db, 'i', 'd1', 'u1')
  assert.deepEqual(await approve(db, U1, 'u1', 'myhost'), { error: 'bad_id_prefix', prefix: 't1-' })
  assert.deepEqual(await approve(db, U1, 'u1', 'bad id!'), { error: 'bad_request' })
  assert.deepEqual(await approve(db, U1, 'u1', 't1-old'), { error: 'id_taken' })
  assert.equal((await approve(db, U1, 'u1', 't1-aegis')).id, 't1-aegis', '失敗不會用掉短碼')
  await start(db, 'i', 'd2', 'u2')
  assert.deepEqual(await approve(db, U2, 'u2', 't9-x'), { error: 'bad_id_prefix', prefix: null }, '沒前綴的租戶不能用保留格式')
  assert.equal((await approve(db, U2, 'u2', 'aegis-rs')).id, 'aegis-rs')
  assert.equal((await node(db, 'aegis-rs')).owner_user, U2)
})

test('實跑：錯碼限次——同一帳號 15 分鐘內錯 5 次就連對的碼也先擋', { skip }, async () => {
  const db = await setup()
  await start(db)
  for (let i = 0; i < 5; i++) assert.deepEqual(await approve(db, U1, 'wrong' + i), { error: 'invalid_code' })
  assert.deepEqual(await approve(db, U1, 'usr1'), { error: 'rate_limited' })
  assert.equal((await node(db, 't1-old')).status, 'active')
  assert.equal((await db.query(`select count(*)::int c from relay.nodes where created_via = 'device-code'`)).rows[0].c, 0, '被擋時不建節點')
  // 別的帳號不受影響；舊的失敗紀錄過了 15 分鐘就不算
  assert.ok((await approve(db, U2, 'usr1')).id, '別的帳號可核准（不同帳號各自計次）')
})

test('實跑：到期——等待中的短碼不能核准；核准後沒領取就到期，節點作廢', { skip }, async () => {
  const db = await setup()
  await start(db, 'i', 'd1', 'u1')
  await db.exec(`update relay.device_codes set expires_at = now() - interval '1 second'`)
  assert.deepEqual(await approve(db, U1, 'u1'), { error: 'invalid_code' })
  assert.deepEqual(await poll(db, 'd1'), { status: 'expired' })
  await start(db, 'i', 'd2', 'u2')
  const a = await approve(db, U1, 'u2')
  await db.exec(`update relay.device_codes set expires_at = now() - interval '1 second', last_poll_at = null where device_hash = 'd2'`)
  assert.deepEqual(await poll(db, 'd2', 'K'), { status: 'expired' })
  const n = await node(db, a.id)
  assert.equal(n.status, 'left'); assert.match(n.key_hash, /^revoked:/)
})

test('實跑：輪詢太快回 slow_down；節點上限 20 個', { skip }, async () => {
  const db = await setup()
  await start(db)
  assert.deepEqual(await poll(db), { status: 'pending' })
  assert.deepEqual(await poll(db), { error: 'slow_down' })
  await db.exec(`insert into relay.nodes(id, name, key_hash, bell_topic, tenant_id, owner_user) select 't1-f' || g, 'x', 'h' || g, 'b' || g, '${T1}', '${U1}' from generate_series(1, 19) g`)
  assert.deepEqual(await approve(db, U1, 'usr1'), { error: 'too_many' })
})
