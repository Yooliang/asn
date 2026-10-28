// 0.1.102 #446 migration 20261028220000_partner_avatar.sql：夥伴自己換頭像。
// 1. 靜態：只加欄位、表與函式；新函式 security definer、search_path 空、只授權 service_role；asn_relay_list「只多兩行」（對照正式庫基準檔）。
// 2. 實跑（pglite；沒裝略過）：只能改自己節點上的夥伴、改名後仍對得上、格式與大小在資料庫再擋一次、頻率限制、移除、
//    停用節點不能改、取圖限同租戶、list 多出 avatar_updated_at 而舊欄位不變。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('../supabase/migrations/20261028220000_partner_avatar.sql')
const base = read('./fixtures/asn_relay_list.prod-20261028b.sql')

const listFn = sql => sql.slice(sql.indexOf('create or replace function public.asn_relay_list'), sql.lastIndexOf('$function$') + '$function$'.length)
const norm = s => s.replace(/CREATE OR REPLACE FUNCTION/i, 'create or replace function').replace(/\s+/g, ' ').trim()

test('靜態：只加欄位、表與函式、不刪不改舊資料；新函式 security definer、search_path 空、只授權 service_role', () => {
  const code = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.equal((code.match(/add column if not exists avatar(_updated_at)? /g) ?? []).length, 2)
  assert.doesNotMatch(code, /drop table|drop column|alter column|delete from relay\.(nodes|partners|roster)|truncate|drop function/i)
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  assert.match(code, /avatar ~ '\^data:image\/\(png\|webp\);base64,\[A-Za-z0-9\+\/\]\+=\{0,2\}\$'/, '資料庫的 check 與節點頭像相同')
  assert.match(code, /char_length\(avatar\) <= 48000/)
  for (const fn of ['asn_relay_set_partner_avatar', 'asn_relay_get_partner_avatar']) {
    const i = code.indexOf(`create or replace function public.${fn}`)
    assert.ok(i >= 0, fn)
    const body = code.slice(i, code.indexOf('$function$;', code.indexOf('as $function$', i) + 14))
    assert.match(body, /security definer\s*\n\s*set search_path to ''/, fn)
  }
  assert.match(code, /'public\.asn_relay_set_partner_avatar\(text,text,text\)'/)
  assert.match(code, /'public\.asn_relay_get_partner_avatar\(uuid,text\)'/)
  assert.match(code, /revoke all on relay\.partner_avatar_sets from public, anon, authenticated;/)
  assert.match(code, /^begin;$/m)
  assert.match(code, /^commit;$/m)
})

test('asn_relay_list：與正式庫現行定義比，只多兩行 avatar_updated_at（在線夥伴、離線夥伴），其餘一個字不動', () => {
  const now = listFn(mig).split('\n')
  const was = base.trim().split('\n').map(l => l.toLowerCase())
  const added = now.filter(l => !was.includes(l.toLowerCase()))
  assert.equal(added.length, 2, added.join('\n'))
  for (const l of added) assert.match(l, /'avatar_updated_at', \(select case when p\.avatar is null/)
  const stripped = now.filter(l => !added.includes(l)).join('\n').replace(/;\s*$/, '')
  assert.equal(norm(stripped), norm(base.trim()))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const P1 = 'p_00000000000000000001'
const P2 = 'p_00000000000000000002'
const P3 = 'p_00000000000000000003'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const WEBP = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAw'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', name text, kind text default 'claude', machine text,
      last_seen_at timestamptz default now(), claude_mod jsonb, claude_mod_at timestamptz, avatar text, avatar_updated_at timestamptz, last_active_at timestamptz);
    create table relay.partners(partner_id text primary key, node text references relay.nodes(id), current_name text, current_session text, engine text, model text, last_active_at timestamptz);
    create unique index on relay.partners (node, current_name) where current_name is not null;
    create table relay.roster(node text, name text, status text, cwd_label text, engine text, detail text, context_pct int, mod_loaded boolean, kind text, receivable boolean,
      model text, hidden boolean, seen_at timestamptz default now(), primary key (node, name));
    create table relay.partner_archives(tenant_id uuid, node text, key text);
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    insert into relay.nodes(id, tenant_id, name) values ('H', '${T1}', '家用機'), ('W', '${T1}', '工作機'), ('X', '${T2}', '別人的');
    insert into relay.partners(partner_id, node, current_name) values ('${P1}', 'H', '小文'), ('${P2}', 'W', '小文'), ('${P3}', 'X', '外人');
    insert into relay.roster(node, name, status) values ('H', '小文', 'idle'), ('H', '沒夥伴ID的視窗', 'idle'), ('W', '小文', 'idle');`)
  await db.exec(mig)
  return db
}
const set = async (db, node, agent, avatar) => (await db.query('select public.asn_relay_set_partner_avatar($1,$2,$3) r', [node, agent, avatar])).rows[0].r
const get = async (db, tenant, pid) => (await db.query('select public.asn_relay_get_partner_avatar($1,$2) r', [tenant, pid])).rows[0].r
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0]

test('實跑：設定、取回、移除；只動自己節點上同名的那位夥伴（別台同名、別人的夥伴都不受影響）', { skip }, async () => {
  const db = await boot()
  const r = await set(db, 'H', '小文', PNG)
  assert.equal(r.ok, true); assert.equal(r.partner_id, P1); assert.ok(r.avatar_updated_at)
  assert.deepEqual({ ...(await get(db, T1, P1)), avatar_updated_at: 0 }, { partner_id: P1, avatar: PNG, avatar_updated_at: 0 })
  assert.equal((await one(db, 'select avatar a from relay.partners where partner_id = $1', [P2])).a, null, '別台同名的夥伴不變')
  assert.equal((await set(db, 'H', '小文', WEBP)).ok, true, 'webp 也收')
  const cleared = await set(db, 'H', '小文', null)
  assert.equal(cleared.ok, true); assert.equal(cleared.avatar_updated_at, null)
  assert.deepEqual(await get(db, T1, P1), { error: 'not_found' }, '移除後沒有圖')
})

test('實跑：解不到夥伴、參數壞、停用的節點、名字被讓出的夥伴都不能改', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await set(db, 'H', '沒夥伴ID的視窗', PNG), { error: 'not_found' })
  assert.deepEqual(await set(db, 'H', '不存在', PNG), { error: 'not_found' })
  assert.deepEqual(await set(db, '不存在', '小文', PNG), { error: 'not_found' })
  for (const [n, a] of [[null, '小文'], ['', '小文'], ['H', null], ['H', ''], ['H', 'x'.repeat(101)]]) assert.deepEqual(await set(db, n, a, PNG), { error: 'bad_request' }, `${n}/${a}`)
  await db.exec("update relay.nodes set status = 'disabled' where id = 'H'")
  assert.deepEqual(await set(db, 'H', '小文', PNG), { error: 'not_found' })
  await db.exec("update relay.nodes set status = 'active' where id = 'H'; update relay.partners set current_name = null where partner_id = 'p_00000000000000000001'")
  assert.deepEqual(await set(db, 'H', '小文', PNG), { error: 'not_found' }, '名字被讓出的夥伴不會被寫到')
  assert.equal((await one(db, 'select count(*)::int c from relay.partners where avatar is not null')).c, 0)
})

test('實跑：格式與大小在資料庫再擋一次（函式回 bad_avatar；資料表的 check 是最後防線）', { skip }, async () => {
  const db = await boot()
  for (const bad of ['', 'hello', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODlh', 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/png;base64,', 'data:image/png;base64,####',
    'data:image/png;base64,' + 'A'.repeat(48000)]) {
    assert.deepEqual(await set(db, 'H', '小文', bad), { error: 'bad_avatar' }, bad.slice(0, 40))
  }
  await assert.rejects(db.query("update relay.partners set avatar = 'data:image/svg+xml;base64,PHN2Zz4=' where partner_id = $1", [P1]), /partners_avatar_check/)
  assert.equal((await one(db, 'select count(*)::int c from relay.partner_avatar_sets')).c, 0, '被擋的不算次數')
})

test('實跑：每位夥伴每小時 5 次（移除也算）；超過一小時又能改；別的夥伴各算各的', { skip }, async () => {
  const db = await boot()
  for (let i = 0; i < 5; i++) assert.equal((await set(db, 'H', '小文', i % 2 ? PNG : WEBP)).ok, true, `第 ${i + 1} 次`)
  assert.deepEqual(await set(db, 'H', '小文', PNG), { error: 'rate_limited' })
  assert.equal((await set(db, 'W', '小文', PNG)).ok, true, '另一位夥伴不受影響')
  await db.exec("update relay.partner_avatar_sets set at = now() - interval '61 minutes' where partner_id = 'p_00000000000000000001'")
  assert.equal((await set(db, 'H', '小文', PNG)).ok, true, '一小時後又能改')
  await db.exec("update relay.partner_avatar_sets set at = now() - interval '2 days' where partner_id = 'p_00000000000000000001'")
  await set(db, 'H', '小文', PNG)
  assert.equal((await one(db, "select count(*)::int c from relay.partner_avatar_sets where partner_id = 'p_00000000000000000001'")).c, 1, '超過一天的記錄順手清掉')
})

test('實跑：改名後（同一位夥伴）圖還在；取圖限同一租戶的現役節點', { skip }, async () => {
  const db = await boot()
  await set(db, 'H', '小文', PNG)
  await db.exec("update relay.partners set current_name = '新名字' where partner_id = 'p_00000000000000000001'")
  assert.equal((await get(db, T1, P1)).avatar, PNG, '圖跟著夥伴，不跟名字')
  assert.deepEqual(await get(db, T2, P1), { error: 'not_found' }, '別的租戶拿不到')
  assert.deepEqual(await get(db, T1, '不存在'), { error: 'not_found' })
  await db.exec("update relay.nodes set status = 'disabled' where id = 'H'")
  assert.deepEqual(await get(db, T1, P1), { error: 'not_found' }, '停用的節點拿不到')
})

test('實跑：非 service_role 不能呼叫（anon、authenticated 都被擋）', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query("select public.asn_relay_set_partner_avatar('H', '小文', null)"), /permission denied/, role)
    await assert.rejects(db.query("select public.asn_relay_get_partner_avatar(null, 'x')"), /permission denied/, role)
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  assert.equal((await set(db, 'H', '小文', PNG)).ok, true)
  await db.exec('reset role')
})

test('實跑：list 的夥伴多出 avatar_updated_at（在線、離線），沒有圖＝null；舊欄位不變', { skip }, async () => {
  const db = await boot()
  const list = async () => (await db.query('select public.asn_relay_list($1) r', [T1])).rows[0].r
  const before = (await list()).find(n => n.id === 'H')
  assert.ok(before.agents.every(a => 'avatar_updated_at' in a && a.avatar_updated_at === null))
  await set(db, 'H', '小文', PNG)
  const after = (await list()).find(n => n.id === 'H')
  assert.ok(after.agents.find(a => a.name === '小文').avatar_updated_at, '有圖就帶時間')
  assert.equal(after.agents.find(a => a.name === '沒夥伴ID的視窗').avatar_updated_at, null)
  assert.ok(!JSON.stringify(after).includes('base64'), '名單不帶圖本身')
  await db.exec("update relay.roster set seen_at = now() - interval '10 minutes' where name = '小文' and node = 'H'")
  const off = (await list()).find(n => n.id === 'H').offline_agents.find(a => a.name === '小文')
  assert.ok(off.avatar_updated_at && off.status === 'offline')
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'avatar_updated_at' ? undefined : v)))
  await db.exec("update relay.roster set seen_at = now() where name = '小文' and node = 'H'")
  const again = (await list()).find(n => n.id === 'H')
  assert.deepEqual(Object.keys(strip(again.agents[0])).sort(), Object.keys(strip(before.agents[0])).sort())
})
