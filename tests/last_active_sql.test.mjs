// 0.2 E1（#397）migration 20261028180000_last_active.sql：後台記錄最後活動時間。
// 1. 靜態：只加可為 null 的欄位與函式；新函式 security definer、search_path 空、只授權 service_role；asn_relay_list「只多三行」（對照正式庫基準檔）。
// 2. 實跑（pglite；沒裝略過）：10 秒內第二次不寫、超過 10 秒會寫、解不到夥伴只寫節點、舊名字不會寫到別人、非 service_role 不能呼叫、
//    list 多出 last_active_at 而舊欄位不變。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mig = read('../supabase/migrations/20261028180000_last_active.sql')
const base = read('./fixtures/asn_relay_list.prod-20261028.sql')

// asn_relay_list 的函式區塊
const listFn = sql => sql.slice(sql.indexOf('create or replace function public.asn_relay_list'), sql.lastIndexOf('$function$') + '$function$'.length)
const norm = s => s.replace(/CREATE OR REPLACE FUNCTION/i, 'create or replace function').replace(/\s+/g, ' ').trim()

test('靜態：只加欄位與函式、不刪不改舊資料；新函式 security definer、search_path 空、只授權 service_role', () => {
  const code = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.equal((code.match(/add column if not exists last_active_at timestamptz;/g) ?? []).length, 2, 'nodes 與 partners')
  assert.doesNotMatch(code, /drop table|drop column|alter column|delete from|truncate|drop function/i)
  assert.doesNotMatch(code, /grant [^;]*to (anon|authenticated|public)/i)
  assert.match(code, /revoke all on function public\.asn_relay_touch_active\(text, text\) from public, anon, authenticated;/)
  assert.match(code, /grant execute on function public\.asn_relay_touch_active\(text, text\) to service_role;/)
  const touch = code.slice(code.indexOf('create or replace function public.asn_relay_touch_active'), code.indexOf('revoke all'))
  assert.match(touch, /security definer\s*\n\s*set search_path to ''/)
  assert.match(code, /^begin;$/m)
  assert.match(code, /^commit;$/m)
})

test('asn_relay_list：與正式庫現行定義比，只多三行 last_active_at（節點、在線夥伴、離線夥伴），其餘一個字不動', () => {
  const now = listFn(mig).split('\n')
  const was = base.trim().split('\n').map(l => l.toLowerCase())
  const added = now.filter(l => !was.includes(l.toLowerCase()))   // 開頭 create or replace 的大小寫不同不算
  assert.equal(added.length, 3, added.join('\n'))
  for (const l of added) assert.match(l, /'last_active_at', /)
  // 拿掉那三行後，與基準逐字相同（只差開頭的大小寫與結尾分號）
  const stripped = now.filter(l => !added.includes(l)).join('\n').replace(/;\s*$/, '')
  assert.equal(norm(stripped), norm(base.trim()))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const P1 = 'p_00000000000000000001'
const P2 = 'p_00000000000000000002'

async function boot() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', name text, kind text default 'claude', machine text,
      last_seen_at timestamptz default now(), claude_mod jsonb, claude_mod_at timestamptz, avatar text, avatar_updated_at timestamptz);
    create table relay.partners(partner_id text primary key, node text references relay.nodes(id), current_name text, current_session text, engine text, model text);
    create table relay.roster(node text, name text, status text, cwd_label text, engine text, detail text, context_pct int, mod_loaded boolean, kind text, receivable boolean,
      model text, hidden boolean, seen_at timestamptz default now(), primary key (node, name));
    create table relay.partner_archives(tenant_id uuid, node text, key text);
    create table relay.asn_presence(node text, window_name text, version text, status text, psm text, updated_at timestamptz default now());
    insert into relay.nodes(id, tenant_id, name) values ('H', '${T1}', '家用機'), ('W', '${T1}', '工作機');
    insert into relay.partners(partner_id, node, current_name) values ('${P1}', 'H', '小文'), ('${P2}', 'H', null);
    insert into relay.roster(node, name, status) values ('H', '小文', 'idle'), ('H', '沒夥伴ID的視窗', 'idle');`)
  await db.exec(mig)
  return db
}
const touch = async (db, node, agent) => (await db.query('select public.asn_relay_touch_active($1,$2) r', [node, agent])).rows[0].r
const at = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].t

test('實跑：10 秒內第二次不寫、超過 10 秒會寫；節點與夥伴各自節流', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await touch(db, 'H', '小文'), { node: 1, partner: 1 })
  const first = await at(db, 'select last_active_at t from relay.partners where partner_id = $1', [P1])
  assert.ok(first, '夥伴有寫')
  assert.ok(await at(db, "select last_active_at t from relay.nodes where id = 'H'"), '節點有寫')
  assert.deepEqual(await touch(db, 'H', '小文'), { node: 0, partner: 0 }, '10 秒內第二次不寫')
  assert.equal((await at(db, 'select last_active_at t from relay.partners where partner_id = $1', [P1])).getTime(), first.getTime())
  // 往回撥 11 秒：夥伴與節點都又能寫
  await db.exec("update relay.partners set last_active_at = now() - interval '11 seconds'; update relay.nodes set last_active_at = now() - interval '11 seconds'")
  assert.deepEqual(await touch(db, 'H', '小文'), { node: 1, partner: 1 }, '超過 10 秒會寫')
  // 只有節點過了 10 秒、夥伴還沒：只寫節點
  await db.exec("update relay.nodes set last_active_at = now() - interval '11 seconds'")
  assert.deepEqual(await touch(db, 'H', '小文'), { node: 1, partner: 0 }, '各自節流')
})

test('實跑：解不到夥伴只寫節點；名字被讓出的夥伴、別台同名、不存在的節點、壞參數都不會寫到別人', { skip }, async () => {
  const db = await boot()
  assert.deepEqual(await touch(db, 'H', '沒夥伴ID的視窗'), { node: 1, partner: 0 }, '解不到夥伴只寫節點')
  assert.equal(await at(db, 'select count(*)::int t from relay.partners where last_active_at is not null'), 0)
  await db.exec('update relay.nodes set last_active_at = null')
  assert.deepEqual(await touch(db, 'H', null), { node: 1, partner: 0 })
  await db.exec('update relay.nodes set last_active_at = null')
  assert.deepEqual(await touch(db, 'H', ''), { node: 1, partner: 0 })
  assert.deepEqual(await touch(db, 'W', '小文'), { node: 1, partner: 0 }, '別台設備上同名的不算：夥伴要跟節點對得上')
  assert.deepEqual(await touch(db, '不存在', '小文'), { node: 0, partner: 0 })
  assert.deepEqual(await touch(db, null, '小文'), { error: 'bad_request' })
  assert.deepEqual(await touch(db, '', '小文'), { error: 'bad_request' })
  assert.equal(await at(db, 'select last_active_at t from relay.partners where partner_id = $1', [P2]), null, '名字被讓出的夥伴不會被寫到')
  assert.equal(await at(db, 'select last_active_at t from relay.partners where partner_id = $1', [P1]), null)
  // 停用的節點不寫節點
  await db.exec("update relay.nodes set status = 'disabled', last_active_at = null where id = 'H'")
  assert.deepEqual(await touch(db, 'H', '沒夥伴ID的視窗'), { node: 0, partner: 0 })
})

test('實跑：非 service_role 不能呼叫（anon、authenticated 都被擋）', { skip }, async () => {
  const db = await boot()
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query("select public.asn_relay_touch_active('H', '小文')"), /permission denied/, role)
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  assert.deepEqual(await touch(db, 'H', '小文'), { node: 1, partner: 1 })
  await db.exec('reset role')
})

test('實跑：list 多出 last_active_at（節點、在線夥伴、離線夥伴），沒活動是 null；舊欄位不變', { skip }, async () => {
  const db = await boot()
  const list = async () => (await db.query('select public.asn_relay_list($1) r', [T1])).rows[0].r
  const before = await list()
  const h0 = before.find(n => n.id === 'H')
  assert.ok('last_active_at' in h0 && h0.last_active_at === null)
  assert.ok(h0.agents.every(a => 'last_active_at' in a && a.last_active_at === null))
  await touch(db, 'H', '小文')
  const after = (await list()).find(n => n.id === 'H')
  assert.ok(after.last_active_at)
  assert.ok(after.agents.find(a => a.name === '小文').last_active_at, '夥伴有時間')
  assert.equal(after.agents.find(a => a.name === '沒夥伴ID的視窗').last_active_at, null, '沒夥伴 ID 的視窗是 null（節點層另有）')
  // 離線夥伴也帶
  await db.exec("update relay.roster set seen_at = now() - interval '10 minutes' where name = '小文'")
  const off = (await list()).find(n => n.id === 'H').offline_agents.find(a => a.name === '小文')
  assert.ok(off.last_active_at && off.status === 'offline')
  // 舊欄位逐一不變（去掉新欄位後與寫入前完全相同）
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'last_active_at' ? undefined : v)))
  await db.exec("update relay.roster set seen_at = now() where name = '小文'")
  const again = await list()
  for (const n of again) {
    const b = before.find(x => x.id === n.id)
    assert.deepEqual(Object.keys(strip(n)).sort(), Object.keys(strip(b)).sort())
    assert.deepEqual(strip(n.agents), strip(b.agents))
  }
})
