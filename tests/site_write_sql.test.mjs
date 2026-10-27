// 官網內容第二期：節點寫入官網內容（migration 20261027200000_site_write.sql，#400）。
// 執行：node --test --test-timeout=240000 tests/site_write_sql.test.mjs
// 1. 靜態：交易內、不刪資料、名單表 migration 裡不放任何一列、寫入函式只給 service_role、新表開 RLS 且不給 anon／authenticated。
// 2. 實跑（需要 @electric-sql/pglite；沒裝略過，pglite 測試不加 --test-force-exit）：
//    anon／authenticated 不能執行、名單外的租戶被擋、停用的節點／租戶被擋、名單內的可寫；
//    發版／會議／項目的格式檢查、HTML 與個資擋下、只改有帶的欄位、欄位必須存在、頻率上限、寫入記錄。
// 3. 還原驗證：拿掉名單檢查，「名單外被擋」要變紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const MIG = '20261027200000_site_write.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const FNS = ['meeting_add', 'release_upsert', 'item_upsert']

test('靜態：交易內、不刪資料、名單是空的、函式只給 service_role、表開 RLS', () => {
  const sql = read(MIG)
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /drop table|drop column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  assert.doesNotMatch(code, /insert into relay\.site_writers/i, '名單由負責人審查後自己加')
  for (const t of ['site_writers', 'site_write_log']) {
    assert.match(code, new RegExp(`alter table relay\\.${t} enable row level security`))
    assert.match(code, new RegExp(`revoke all on relay\\.${t} from public, anon, authenticated`))
  }
  for (const f of FNS) {
    assert.ok(code.includes(`revoke all on function public.asn_relay_site_${f}(text, jsonb) from public, anon, authenticated;`), f)
    assert.ok(code.includes(`grant execute on function public.asn_relay_site_${f}(text, jsonb) to service_role;`), f)
  }
  // 每支 security definer 函式都固定 search_path
  const definers = [...code.matchAll(/create or replace function ([\w.]+)\([^]*?\$function\$/g)]
  assert.ok(definers.length >= 6)
  for (const m of definers) assert.match(m[0], /set search_path to ''/, m[1])
  assert.ok(files.includes(MIG))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const W1 = 'wrk9b2', Q2 = 'qqq3c4', OFF = 'off5d6', INV = 'inv7e8', ALIEN = 'aln8f9'
const OWNER_MIG = '20261027210000_site_writer_owner.sql'

async function boot({ mutate, writers = [T1] } = {}) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`)
  for (const f of files) {
    let sql = read(f)
    if (mutate && mutate[f]) sql = mutate[f](sql)
    await db.exec(sql)
  }
  await db.exec(`
    insert into auth.users(id, email) values ('${U1}', 'a@x.y'), ('${U2}', 'b@x.y');
    insert into relay.tenants(id, owner_user, owner_name) values ('${T1}', '${U1}', '負責人'), ('${T2}', '${U2}', '別人');
    insert into relay.nodes(id, name, key_hash, bell_topic, role, tenant_id, owner_user, status, machine) values
      ('${W1}', '工作機', 'k2', 'bell-w1', 'member', '${T1}', '${U1}', 'active', '工作機'),
      ('${OFF}', '舊電腦', 'k4', 'bell-off', 'member', '${T1}', '${U1}', 'disabled', '舊電腦'),
      ('${Q2}', '別人的電腦', 'k3', 'bell-q2', 'member', '${T2}', '${U2}', 'active', '電腦'),
      ('${INV}', '邀請碼加入、沒認領', 'k5', 'bell-inv', 'member', '${T1}', null, 'active', '測試'),
      ('${ALIEN}', '別人認領、但在負責人的租戶', 'k6', 'bell-aln', 'member', '${T1}', '${U2}', 'active', '電腦');`)
  for (const t of writers) await db.query(`insert into relay.site_writers(tenant_id, note) values ($1, '測試')`, [t])
  return db
}
async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`
  return (await db.query(sql, keys.map(k => args[k]))).rows[0].r
}
const release = (db, data, node = W1) => rpc(db, 'asn_relay_site_release_upsert', { p_node: node, p_release: JSON.stringify(data) })
const meeting = (db, data, node = W1) => rpc(db, 'asn_relay_site_meeting_add', { p_node: node, p_meeting: JSON.stringify(data) })
const item = (db, data, node = W1) => rpc(db, 'asn_relay_site_item_upsert', { p_node: node, p_item: JSON.stringify(data) })
const REL = { version: '9.0.1', released_on: '2026-10-28', items: ['新增：**官網**可用 `asn site` 寫入（#400）'], platforms: ['官網', '家用機'], commit_sha: 'abc1234' }
const MEET = { held_at: '2026-10-28T08:00:00+08:00', attendees: ['ASN-開發 主持'], progress: ['#400 第二期開 PR'], decisions: ['無'], assignments: ['無'], improvements: ['無'] }
const ITEM = { item_key: 'todo-next-99z', section: 'todo', lane: 'next', title: '寫官網', body: '用 asn site 寫', refs: [400, 400, 402], status: 'doing' }

test('實跑：anon／authenticated 不能執行三支寫入函式', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    for (const f of FNS) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.query(`select public.asn_relay_site_${f}('${W1}', '{}'::jsonb)`), /permission denied/, `${role} ${f}`)
      await db.exec('reset role')
    }
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query('select * from relay.site_writers'), /permission denied/)
    await db.exec('reset role')
  }
})

test('實跑：名單外的租戶、停用的節點、停用的租戶、不存在的節點一律 not_allowed，不寫入', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await release(db, REL, Q2), { error: 'not_allowed' })
  assert.deepEqual(await meeting(db, MEET, Q2), { error: 'not_allowed' })
  assert.deepEqual(await item(db, ITEM, Q2), { error: 'not_allowed' })
  assert.deepEqual(await release(db, REL, OFF), { error: 'not_allowed' })
  assert.deepEqual(await release(db, REL, 'nobody'), { error: 'not_allowed' })
  assert.deepEqual(await release(db, REL, null), { error: 'not_allowed' })
  await db.exec(`update relay.tenants set status = 'suspended' where id = '${T1}'`)
  assert.deepEqual(await release(db, REL), { error: 'not_allowed' })
  assert.equal((await db.query(`select count(*)::int n from public.asn_site_releases where version = '9.0.1'`)).rows[0].n, 0)
  assert.equal((await db.query('select count(*)::int n from relay.site_write_log')).rows[0].n, 0)
})

test('實跑：名單上的租戶裡，沒認領或別人認領的節點也不能寫（只有擁有者本人認領的節點可寫）', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await release(db, REL, INV), { error: 'not_allowed' })
  assert.deepEqual(await meeting(db, MEET, ALIEN), { error: 'not_allowed' })
  assert.deepEqual(await item(db, ITEM, INV), { error: 'not_allowed' })
  assert.equal((await release(db, REL, W1)).ok, true)
})

test('還原驗證：拿掉擁有者認領的檢查，邀請碼加入的節點就寫得進去（上面的測試會抓到）', { skip }, async () => {
  const db = await boot({ mutate: { [OWNER_MIG]: s => s.replace('\n    and n.owner_user is not null and n.owner_user = t.owner_user', '') } })
  assert.equal((await release(db, REL, INV)).ok, true)
})

test('實跑：名單空白（migration 剛套上）時誰都不能寫', { skip }, async () => {
  const db = await boot({ writers: [] })
  assert.deepEqual(await release(db, REL), { error: 'not_allowed' })
})

test('實跑：發版——新增、再送只改有帶的欄位、空字串清掉、寫入記錄', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await release(db, REL), { ok: true, version: '9.0.1', created: true })
  let r = (await db.query(`select * from public.asn_site_releases where version = '9.0.1'`)).rows[0]
  assert.deepEqual([r.items, r.platforms, r.commit_sha, r.notes], [REL.items, REL.platforms, 'abc1234', null])
  assert.deepEqual(await release(db, { version: '9.0.1', notes: '補充', commit_sha: '' }), { ok: true, version: '9.0.1', created: false })
  r = (await db.query(`select * from public.asn_site_releases where version = '9.0.1'`)).rows[0]
  assert.deepEqual([r.items, r.platforms, r.commit_sha, r.notes], [REL.items, REL.platforms, null, '補充'])
  const log = (await db.query(`select node, tenant_id, action, target from relay.site_write_log order by id`)).rows
  assert.deepEqual(log, [{ node: W1, tenant_id: T1, action: 'release', target: '9.0.1' }, { node: W1, tenant_id: T1, action: 'release', target: '9.0.1' }])
})

test('實跑：發版——新的版本缺日期或內容回 missing_fields；格式不對指出欄位', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await release(db, { version: '9.0.2', items: ['x'] }), { error: 'missing_fields', field: 'released_on' })
  assert.deepEqual(await release(db, { version: '9.0.2', released_on: '2026-10-28' }), { error: 'missing_fields', field: 'items' })
  const bad = async (patch, field) => assert.deepEqual(await release(db, { ...REL, ...patch }), { error: 'bad_request', field }, JSON.stringify(patch))
  await bad({ version: 'v1.0' }, 'version')
  await bad({ version: '1.0' }, 'version')
  await bad({ version: 1 }, 'version')
  await bad({ released_on: '2026/10/28' }, 'released_on')
  await bad({ released_on: '2026-02-30' }, 'released_on')
  await bad({ released_on: '2099-01-01' }, 'released_on')
  await bad({ items: [] }, 'items')
  await bad({ items: [''] }, 'items')
  await bad({ items: ['   '] }, 'items')
  await bad({ items: 'x' }, 'items')
  await bad({ items: [1] }, 'items')
  await bad({ items: Array(31).fill('x') }, 'items')
  await bad({ items: ['x'.repeat(1001)] }, 'items')
  await bad({ items: ['控制字元\u0007'] }, 'items')
  await bad({ platforms: Array(11).fill('官網') }, 'platforms')
  await bad({ platforms: ['x'.repeat(21)] }, 'platforms')
  await bad({ commit_sha: 'ABC1234' }, 'commit_sha')
  await bad({ commit_sha: 'abc12' }, 'commit_sha')
  await bad({ notes: 'x'.repeat(2001) }, 'notes')
  assert.deepEqual(await release(db, 'x'), { error: 'bad_request' })
  assert.equal((await db.query('select count(*)::int n from relay.site_write_log')).rows[0].n, 0)
})

test('實跑：HTML 標籤、電子郵件、本機路徑、金鑰樣式一律 unsafe_content；比較符號可以', { skip }, async () => {
  const db = await boot()
  for (const s of ['<script>alert(1)</script>', '看 <img src=x>', '</b>', '<!-- x -->', '寄到 a.b@example.com', 'C:\\Users\\x', '/home/u/x', '~/.asn/T.key', 'eyJ' + 'x'.repeat(24), 'service_role 金鑰']) {
    assert.deepEqual(await release(db, { ...REL, items: ['正常', s] }), { error: 'unsafe_content', field: 'items' }, s)
    assert.deepEqual(await item(db, { ...ITEM, body: s }), { error: 'unsafe_content', field: 'body' }, s)
    assert.deepEqual(await meeting(db, { ...MEET, decisions: [s] }), { error: 'unsafe_content', field: 'decisions' }, s)
  }
  assert.deepEqual(await item(db, { ...ITEM, title: '<b>x</b>' }), { error: 'unsafe_content', field: 'title' })
  assert.deepEqual(await release(db, { ...REL, notes: '<p>' }), { error: 'unsafe_content', field: 'notes' })
  assert.equal((await release(db, { ...REL, items: ['延遲 < 5 秒、a<5、1 > 0、@某人'] })).ok, true)
})

test('實跑：會議——新增、同一時間再送整筆覆寫、時間格式與欄位檢查', { skip }, async () => {
  const db = await boot()
  const a = await meeting(db, MEET)
  assert.equal(a.ok, true); assert.equal(a.created, true)
  const b = await meeting(db, { ...MEET, held_at: '2026-10-28 00:00Z', decisions: ['改了'] })
  assert.deepEqual(b, { ok: true, id: a.id, created: false }, '同一時間點（不同時區寫法）＝同一場')
  const rows = (await db.query('select * from public.asn_site_meetings where id = $1', [a.id])).rows
  assert.deepEqual(rows[0].decisions, ['改了'])
  const bad = async (patch, field) => assert.deepEqual(await meeting(db, { ...MEET, ...patch }), { error: 'bad_request', field }, JSON.stringify(patch))
  await bad({ held_at: '2026-10-28 08:00' }, 'held_at')  // 沒時區
  await bad({ held_at: 'yesterday' }, 'held_at')
  await bad({ held_at: '2026-13-01T00:00Z' }, 'held_at')
  await bad({ held_at: '2025-01-01T00:00Z' }, 'held_at')
  await bad({ attendees: [] }, 'attendees')
  await bad({ progress: 'x' }, 'progress')
  await bad({ improvements: ['x'.repeat(2001)] }, 'improvements')
  const lacking = { ...MEET }; delete lacking.assignments
  assert.deepEqual(await meeting(db, lacking), { error: 'bad_request', field: 'assignments' })
})

test('實跑：項目——新增排在該欄最後、refs 去重、更新只改有帶的欄位、空字串清掉標題與版本', { skip }, async () => {
  const db = await boot()
  const max = (await db.query(`select coalesce(max(sort_order),0)::int m from public.asn_site_roadmap_items where section='todo' and lane='next'`)).rows[0].m
  assert.deepEqual(await item(db, ITEM), { ok: true, item_key: ITEM.item_key, created: true })
  const get = async () => (await db.query(`select * from public.asn_site_roadmap_items where item_key = $1`, [ITEM.item_key])).rows[0]
  let r = await get()
  assert.deepEqual([r.title, r.body, r.refs, r.status, r.version, r.sort_order], ['寫官網', '用 asn site 寫', [400, 402], 'doing', null, max + 10])
  assert.deepEqual(await item(db, { item_key: ITEM.item_key, status: 'released', version: '9.0.1' }), { ok: true, item_key: ITEM.item_key, created: false })
  r = await get()
  assert.deepEqual([r.title, r.body, r.status, r.version, r.section, r.lane], ['寫官網', '用 asn site 寫', 'released', '9.0.1', 'todo', 'next'])
  await item(db, { item_key: ITEM.item_key, title: '', version: '' })
  r = await get()
  assert.deepEqual([r.title, r.version], [null, null])
  // 換欄位：沒給 sort_order 就排到新欄最後
  await item(db, { item_key: ITEM.item_key, section: 'roadmap', lane: 'done' })
  r = await get()
  const maxDone = (await db.query(`select max(sort_order)::int m from public.asn_site_roadmap_items where section='roadmap' and lane='done' and item_key <> $1`, [ITEM.item_key])).rows[0].m
  assert.deepEqual([r.section, r.lane, r.sort_order], ['roadmap', 'done', maxDone + 10])
  // 種子項目也能改狀態
  const seed = (await db.query(`select item_key from public.asn_site_roadmap_items where item_key <> $1 limit 1`, [ITEM.item_key])).rows[0].item_key
  assert.equal((await item(db, { item_key: seed, status: 'planned' })).ok, true)
})

test('實跑：項目——欄位不存在 bad_lane、新項目缺必填 missing_fields、格式不對指出欄位', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await item(db, { ...ITEM, lane: 'nope' }), { error: 'bad_lane', field: 'lane' })
  assert.deepEqual(await item(db, { ...ITEM, section: 'todo', lane: 'done' }), { error: 'bad_lane', field: 'lane' })
  assert.deepEqual(await item(db, { item_key: 'new-one', body: 'x', status: 'doing' }), { error: 'missing_fields', field: 'section' })
  assert.deepEqual(await item(db, { item_key: 'new-one', section: 'todo', lane: 'next', status: 'doing' }), { error: 'missing_fields', field: 'body' })
  assert.deepEqual(await item(db, { item_key: 'new-one', section: 'todo', lane: 'next', body: 'x' }), { error: 'missing_fields', field: 'status' })
  const bad = async (patch, field) => assert.deepEqual(await item(db, { ...ITEM, ...patch }), { error: 'bad_request', field }, JSON.stringify(patch))
  await bad({ item_key: 'Bad_Key' }, 'item_key')
  await bad({ item_key: '-x' }, 'item_key')
  await bad({ item_key: 'x'.repeat(62) }, 'item_key')
  await bad({ section: 'blog' }, 'section')
  await bad({ lane: 'X' }, 'lane')
  await bad({ title: 'x'.repeat(81) }, 'title')
  await bad({ title: '兩\n行' }, 'title')
  await bad({ body: '' }, 'body')
  await bad({ body: 'x'.repeat(4001) }, 'body')
  await bad({ refs: [0] }, 'refs')
  await bad({ refs: [-1] }, 'refs')
  await bad({ refs: [1.5] }, 'refs')
  await bad({ refs: ['1'] }, 'refs')
  await bad({ refs: Array.from({ length: 31 }, (_, i) => i + 1) }, 'refs')
  await bad({ status: 'done' }, 'status')
  await bad({ version: 'next' }, 'version')
  await bad({ sort_order: -1 }, 'sort_order')
  await bad({ sort_order: 2000000 }, 'sort_order')
  const noLane = { ...ITEM }; delete noLane.lane
  assert.deepEqual(await item(db, noLane), { error: 'bad_request', field: 'lane' }, 'section 與 lane 要一起帶')
})

test('實跑：同一租戶每小時最多 120 次寫入', { skip }, async () => {
  const db = await boot()
  await db.exec(`insert into relay.site_write_log (node, tenant_id, action, target) select '${W1}', '${T1}', 'item', 'x' from generate_series(1, 120)`)
  assert.deepEqual(await release(db, REL), { error: 'rate_limited' })
  await db.exec(`update relay.site_write_log set at = now() - interval '2 hours'`)
  assert.equal((await release(db, REL)).ok, true)
})

test('還原驗證：拿掉名單檢查，名單外的租戶就寫得進去（上面的測試會抓到）', { skip }, async () => {
  const drop = s => s.replace("join relay.site_writers w on w.tenant_id = n.tenant_id\n", '')
  const db = await boot({ mutate: { [MIG]: drop, [OWNER_MIG]: drop } })
  assert.equal((await release(db, REL, Q2)).ok, true)
})
